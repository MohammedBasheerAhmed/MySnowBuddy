// Direct, same-origin calls to the current ServiceNow instance. These run
// under the user's own browser session/permissions — never attempt to
// escalate or bypass ACLs here.

import { sessionHeaders } from './sessionToken.js';

// Hard ceiling on rows per request. Guards against a mistyped query pulling
// tens of thousands of rows into the page and freezing the tab.
const MAX_LIMIT = 1000;

export async function queryTable(table, query, fields = [], options = {}) {
  const { limit = 50, displayValue = false, offset = 0 } = options;

  const params = new URLSearchParams();
  if (query) params.set('sysparm_query', query);
  if (fields.length) params.set('sysparm_fields', fields.join(','));
  params.set('sysparm_limit', String(Math.min(limit, MAX_LIMIT)));
  if (offset) params.set('sysparm_offset', String(offset));
  params.set('sysparm_display_value', displayValue ? 'all' : 'false');
  params.set('sysparm_exclude_reference_link', 'true');

  const response = await fetch(`/api/now/table/${encodeURIComponent(table)}?${params.toString()}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: await sessionHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Table API query on "${table}" failed (${response.status})`);
  }
  const data = await response.json();
  return data.result || [];
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
  const response = await fetch(`/api/now/stats/${encodeURIComponent(table)}?${params.toString()}`, {
    credentials: 'same-origin',
    headers: await sessionHeaders(),
  });
  if (!response.ok) throw new Error(`Count on "${table}" failed (${response.status})`);
  const data = await response.json();
  const count = Number(data?.result?.stats?.count);
  if (!Number.isFinite(count)) throw new Error('The instance returned no count.');
  return count;
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
  if (!response.ok) {
    throw new Error(`Background script execution failed (${response.status})`);
  }
  return response.text();
}

// Impersonation.
// TODO (see docs/decisions.md): confirm the exact current impersonation
// endpoint/flow (requires the impersonate_user role) before relying on this.
export async function impersonateUser(userSysId, csrfToken) {
  const response = await fetch(`/impersonate.do?sysparm_start_impersonating=${encodeURIComponent(userSysId)}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { 'X-UserToken': csrfToken || '' },
  });
  if (!response.ok) {
    throw new Error(`Impersonation request failed (${response.status})`);
  }
  window.location.reload();
}
