// Direct, same-origin calls to the current ServiceNow instance. These run
// under the user's own browser session/permissions — never attempt to
// escalate or bypass ACLs here.

import { sessionHeaders } from './sessionToken.js';

// Hard ceiling on rows per request. Guards against a mistyped query pulling
// tens of thousands of rows into the page and freezing the tab.
const MAX_LIMIT = 1000;

// ---- Session and error handling shared by every request ------------------------------------

export const SESSION_EXPIRED_MESSAGE = 'Your ServiceNow session has expired. Log in again, then retry.';

// Busy instance (rate limit, node overloaded): GETs are retried after these delays.
const RETRY_STATUSES = new Set([429, 503]);
const RETRY_DELAYS_MS = [400, 1200];
const MAX_RETRY_AFTER_MS = 5000;

// A login form served with HTTP 200 instead of the JSON that was asked for.
const LOGIN_PAGE = /<form[^>]*login\.do|name=["']user_password["']|id=["']user_password["']|sysverb_login|<title>[^<]*log ?in\b/i;
const LOGIN_URL = /\/(?:login|logout|login_redirect|external_logout_complete)\.do\b|\/login\b|saml|\/sso\b/i;

function sessionExpiredError() {
  const err = new Error(SESSION_EXPIRED_MESSAGE);
  err.code = 'SESSION_EXPIRED';
  return err;
}

function isSessionExpired(response, text) {
  if (response.status === 401) return true;
  if (response.headers?.get?.('x-is-logged-in') === 'false') return true;
  if (response.redirected && LOGIN_URL.test(response.url || '')) return true;
  return /^\s*</.test(text || '') && LOGIN_PAGE.test(text);
}

/** ServiceNow's own explanation from a JSON error body: "message - detail", or ''. */
export function serviceNowErrorText(text) {
  try {
    const err = JSON.parse(text)?.error;
    if (!err) return '';
    if (typeof err === 'string') return err;
    const message = typeof err.message === 'string' ? err.message : '';
    const detail = typeof err.detail === 'string' && err.detail !== message ? err.detail : '';
    return [message, detail].filter(Boolean).join(' - ');
  } catch {
    return '';
  }
}

function retryDelay(response, attempt) {
  const raw = response.headers?.get?.('retry-after');
  const seconds = raw === null || raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return RETRY_DELAYS_MS[attempt];
}

/** fetch() on the instance; a GET answered 429/503 is retried briefly with backoff. Writes are never retried. */
async function instanceFetch(path, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  for (let attempt = 0; ; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- retries are sequential by design.
    const response = await fetch(path, { credentials: 'same-origin', ...init });
    if (method !== 'GET' || !RETRY_STATUSES.has(response.status) || attempt >= RETRY_DELAYS_MS.length) return response;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
  }
}

/**
 * Read a JSON answer. Throws one clear error for an expired session (401, a
 * login redirect or a login page served as 200), and includes ServiceNow's
 * error.message / error.detail in any other failure. Returns null for an empty body.
 */
async function readJson(response, what) {
  const text = await response.text().catch(() => '');
  if (isSessionExpired(response, text)) throw sessionExpiredError();
  if (!response.ok) {
    const detail = serviceNowErrorText(text);
    if (response.status === 403) throw new Error(`Your user is not allowed to do this (403)${detail ? `: ${detail}` : ''}.`);
    if (RETRY_STATUSES.has(response.status)) {
      throw new Error(`${what} failed (${response.status}): the instance is busy${detail ? ` (${detail})` : ''}. Wait a moment and retry.`);
    }
    throw new Error(`${what} failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const kind = /^\s*</.test(text) ? 'an HTML page' : 'something else';
    throw new Error(`${what} returned ${kind} instead of JSON (${response.status}). Reload the page and try again.`);
  }
}

export async function queryTable(table, query, fields = [], options = {}) {
  const { limit = 50, displayValue = false, offset = 0 } = options;

  const params = new URLSearchParams();
  if (query) params.set('sysparm_query', query);
  if (fields.length) params.set('sysparm_fields', fields.join(','));
  params.set('sysparm_limit', String(Math.min(limit, MAX_LIMIT)));
  if (offset) params.set('sysparm_offset', String(offset));
  params.set('sysparm_display_value', displayValue ? 'all' : 'false');
  params.set('sysparm_exclude_reference_link', 'true');

  const response = await instanceFetch(`/api/now/table/${encodeURIComponent(table)}?${params.toString()}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: await sessionHeaders(),
  });
  const data = await readJson(response, `Table API query on "${table}"`);
  return data?.result || [];
}

/** Fetch a single record by sys_id. Returns null when it does not exist. */
export async function fetchRecord(table, sysId, fields = []) {
  if (!sysId) return null;
  const rows = await queryTable(table, `sys_id=${sysId}`, fields, { limit: 1 });
  return rows[0] || null;
}

/** Number of rows matching `query`, via the Aggregate API (no rows transferred). */
export async function countRecords(table, query = '') {
  const params = new URLSearchParams({ sysparm_count: 'true' });
  if (query) params.set('sysparm_query', query);
  const response = await instanceFetch(`/api/now/stats/${encodeURIComponent(table)}?${params.toString()}`, {
    credentials: 'same-origin',
    headers: await sessionHeaders(),
  });
  const data = await readJson(response, `Count on "${table}"`);
  const count = Number(data?.result?.stats?.count);
  if (!Number.isFinite(count)) throw new Error('The instance returned no count.');
  return count;
}

/**
 * Counts per value of one column over `query`, via the Aggregate API (nothing but the counts is transferred).
 * Returns the raw `result` array: [{ stats: { count }, groupby_fields: [{ field, value, display_value }] }].
 */
export async function countByColumn(table, query, column) {
  const params = new URLSearchParams({ sysparm_count: 'true', sysparm_group_by: column, sysparm_display_value: 'all' });
  if (query) params.set('sysparm_query', query);
  const response = await instanceFetch(`/api/now/stats/${encodeURIComponent(table)}?${params.toString()}`, {
    credentials: 'same-origin',
    headers: await sessionHeaders(),
  });
  const data = await readJson(response, `Breakdown of "${table}" by ${column}`);
  return data?.result || [];
}

/** Page through a query until `max` rows (or the end). Pages run one at a time. */
export async function queryAll(table, query, fields = [], { max = 2000, pageSize = 500, displayValue = false } = {}) {
  const rows = [];
  while (rows.length < max) {
    const want = Math.min(pageSize, max - rows.length);
    // eslint-disable-next-line no-await-in-loop -- sequential paging keeps load on the instance low.
    const page = await queryTable(table, query, fields, { limit: want, offset: rows.length, displayValue });
    rows.push(...page);
    if (page.length < want) break;
  }
  return rows;
}

/**
 * Run the same query across chunks of an IN-list so we never build a URL that
 * exceeds what the instance will accept. `values` is deduplicated first.
 */
export async function queryInChunks(table, field, values, fields = [], options = {}) {
  const { chunkSize = 50, extraQuery = '', limit = 200 } = options;
  const unique = [...new Set(values.filter(Boolean))];
  const results = [];

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const inClause = `${field}IN${chunk.join(',')}`;
    const query = extraQuery ? `${inClause}^${extraQuery}` : inClause;
    // eslint-disable-next-line no-await-in-loop -- chunks must stay sequential
    // so we do not burst dozens of parallel requests at the instance.
    const rows = await queryTable(table, query, fields, { limit });
    results.push(...rows);
  }

  return results;
}

// Background script execution.
// TODO (see docs/decisions.md): confirm the exact endpoint/payload shape for
// the current ServiceNow release before relying on this in production. This
// targets the historical `sys.scripts.do` processor, which requires the
// security_admin/admin role and a valid CSRF token (X-UserToken).
export async function runBackgroundScript(script, csrfToken) {
  const body = new URLSearchParams();
  body.set('script', script);
  body.set('sys_scope', 'global');
  body.set('quota_managed', 'true');
  body.set('runscript', 'Run script');

  const response = await fetch('/sys.scripts.do', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-UserToken': csrfToken || '',
    },
    body: body.toString(),
  });
  const html = await response.text().catch(() => '');
  if (!/Script completed/i.test(html) && isSessionExpired(response, html)) throw sessionExpiredError();
  if (!response.ok) {
    throw new Error(`Background script execution failed (${response.status})`);
  }
  // A refused run (wrong role, a scope you cannot edit) still answers 200 with a one-line page and no script output.
  if (/not authorized/i.test(html) && !/Script completed/i.test(html)) {
    throw new Error('The instance refused to run the script ("not authorized"). Background scripts need the admin role (and security_admin on some releases), and the chosen scope must be editable by you.');
  }
  return html;
}

// Impersonation.
// ---- Configuration writes (agent save_artifact / undo) --------------------------------------
// Same session, same ACLs as the user. Only src/content/agentTools.js calls these,
// after an allow-list check and an explicit approval.

async function writeRequest(method, path, body) {
  // Never retried: a write that timed out may still have been applied.
  const response = await instanceFetch(path, {
    method,
    credentials: 'same-origin',
    headers: await sessionHeaders({ 'Content-Type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
  });
  // DELETE answers 204 with no body (readJson returns null for an empty body).
  const data = await readJson(response, `${method} ${path}`);
  return data?.result || null;
}

export function createRecord(table, fields) {
  return writeRequest('POST', `/api/now/table/${encodeURIComponent(table)}?sysparm_exclude_reference_link=true`, fields);
}

export function updateRecord(table, sysId, fields) {
  return writeRequest('PATCH', `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}?sysparm_exclude_reference_link=true`, fields);
}

export function deleteRecord(table, sysId) {
  return writeRequest('DELETE', `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`);
}
