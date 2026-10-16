// Cross-instance Table API client, used only from the background service
// worker (content scripts are same-origin bound).
//
// Auth strategy:
//  1. Try the browser's existing session cookies for that instance
//     (credentials: 'include' — allowed because the instance origin is
//     declared in host_permissions).
//  2. If that fails with 401/302-to-login, fall back to per-instance Basic
//     Auth credentials the user stored in the options page.
//
// See docs/decisions.md for the SameSite/session findings.
const CREDS_KEY = 'mysnowbuddy_instance_credentials';

export function normalizeInstanceUrl(raw) {
  if (!raw) return null;
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  try {
    const url = new URL(value);
    if (!/\.service-now\.com$/i.test(url.hostname)) {
      throw new Error(`Only *.service-now.com instances are supported (got "${url.hostname}").`);
    }
    return `${url.protocol}//${url.hostname}`;
  } catch (err) {
    throw new Error(`Invalid instance URL: ${raw}`);
  }
}

async function getStoredCredential(instanceUrl) {
  const res = await chrome.storage.local.get(CREDS_KEY);
  const all = res[CREDS_KEY] || {};
  const host = new URL(instanceUrl).hostname;
  return all[host] || null;
}

function looksLikeLoginRedirect(response, bodyText) {
  if (response.status === 401) return true;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return true;
  return /login\.do|<html/i.test(bodyText.slice(0, 200));
}

export async function fetchRecords(instanceUrl, table, fields, { query = '', limit = 500 } = {}) {
  const base = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams();
  if (query) params.set('sysparm_query', query);
  if (fields?.length) params.set('sysparm_fields', fields.join(','));
  params.set('sysparm_limit', String(limit));
  params.set('sysparm_display_value', 'false');
  // Reference fields come back as plain sys_ids (not {link, value}), the same shape the
  // content scripts read from the current instance, so the two can be compared directly.
  params.set('sysparm_exclude_reference_link', 'true');

  const url = `${base}/api/now/table/${table}?${params.toString()}`;

  // Attempt 1: existing browser session.
  let response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  let bodyText = await response.text();

  if (response.ok && !looksLikeLoginRedirect(response, bodyText)) {
    return JSON.parse(bodyText).result || [];
  }

  // Attempt 2: stored per-instance Basic Auth credentials.
  const cred = await getStoredCredential(base);
  if (!cred?.username || !cred?.password) {
    if (!looksLikeLoginRedirect(response, bodyText)) {
      // Signed in, but the request itself failed (403, 400, 500...): say so rather than "not authenticated".
      const detail = errorDetail(bodyText);
      throw new Error(`${new URL(base).hostname} answered ${response.status} for ${table}${detail ? `: ${detail}` : ''}.`);
    }
    throw new Error(
      `Not authenticated to ${new URL(base).hostname}. Either log into it in this browser, ` +
        'or add credentials for it in the MySnowBuddy options page.'
    );
  }

  response = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${btoa(`${cred.username}:${cred.password}`)}`,
    },
  });
  bodyText = await response.text();

  if (!response.ok || looksLikeLoginRedirect(response, bodyText)) {
    throw new Error(
      `Authentication to ${new URL(base).hostname} failed (${response.status}). ` +
        'Check the stored credentials in the options page.'
    );
  }

  return JSON.parse(bodyText).result || [];
}

function errorDetail(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    return data?.error?.message || data?.error?.detail || '';
  } catch {
    return '';
  }
}

/**
 * True only when a write was clearly turned away for lack of authentication: a 401, or a
 * successful answer that is the login page (a redirect to login.do still answers 200). Any other
 * odd answer (a 502/504 HTML page from a proxy, say) may come after the instance already saved
 * the record, so it must never be treated as "not written".
 */
export function isAuthRejection(response, bodyText) {
  if (response.status === 401) return true;
  if (!response.ok) return false;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return false;
  const head = String(bodyText || '').slice(0, 4000);
  return /\/login\.do\b/i.test(response.url || '') || /login\.do|name=["']user_name["']|id=["']user_password["']/i.test(head);
}

/**
 * Create (POST) or update (PATCH) one record on another instance, with the same two-tier
 * auth as reads. The browser session is tried first; ServiceNow usually refuses a
 * cookie-only write without the instance's X-UserToken (401), and only then are the stored
 * Basic Auth credentials used. Only a 401 or a login page (isAuthRejection) counts as "nothing
 * was written" and allows the retry; after any other failure the write is never repeated, and
 * the error says the record may or may not have been saved.
 *
 * @param {string} instanceUrl
 * @param {string} table
 * @param {{method: 'POST'|'PATCH', sysId?: string, fields: object}} request
 * @returns {Promise<{record: object, auth: 'session'|'basic'}>}
 */
export async function writeRecord(instanceUrl, table, { method, sysId, fields }) {
  const base = normalizeInstanceUrl(instanceUrl);
  const host = new URL(base).hostname;
  if (!/^[a-z0-9_]+$/i.test(table || '')) throw new Error('Invalid table.');
  if (method !== 'POST' && method !== 'PATCH') throw new Error('Invalid write method.');
  if (method === 'PATCH' && !/^[0-9a-f]{32}$/i.test(sysId || '')) throw new Error('Invalid sys_id.');

  const params = 'sysparm_exclude_reference_link=true&sysparm_input_display_value=false';
  const url =
    method === 'POST'
      ? `${base}/api/now/table/${encodeURIComponent(table)}?${params}`
      : `${base}/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}?${params}`;
  const body = JSON.stringify(fields || {});
  const jsonHeaders = { Accept: 'application/json', 'Content-Type': 'application/json' };

  const unsure = `It may or may not have been saved: open the record on ${host} before trying again.`;
  const parse = (response, bodyText, auth) => {
    if (!response.ok) {
      const detail = errorDetail(bodyText);
      if (response.status === 403) throw new Error(`${host} refused the write (403)${detail ? `: ${detail}` : ''}. Your user there may lack the role or the record is protected.`);
      if (response.status >= 400 && response.status < 500) throw new Error(`Write to ${host} failed (${response.status})${detail ? `: ${detail}` : ''}.`);
      throw new Error(`Write to ${host} failed (${response.status})${detail ? `: ${detail}` : ''}. ${unsure}`);
    }
    let record = null;
    try {
      record = JSON.parse(bodyText).result;
    } catch {
      throw new Error(`${host} answered ${response.status} with something other than the saved record. ${unsure}`);
    }
    if (!record || typeof record !== 'object') throw new Error(`${host} answered without the saved record. ${unsure}`);
    return { record, auth };
  };

  // Attempt 1: existing browser session.
  let response = await fetch(url, { method, credentials: 'include', headers: jsonHeaders, body });
  let bodyText = await response.text();
  if (!isAuthRejection(response, bodyText)) return parse(response, bodyText, 'session');

  // Attempt 2: stored Basic Auth credentials. Only reached when attempt 1 was not authenticated.
  const cred = await getStoredCredential(base);
  if (!cred?.username || !cred?.password) {
    throw new Error(
      `Not authenticated to ${host} for writing. A browser session alone is usually not enough for a cross-instance write; ` +
        'add credentials for it in the MySnowBuddy options page.'
    );
  }
  response = await fetch(url, {
    method,
    credentials: 'omit',
    headers: { ...jsonHeaders, Authorization: `Basic ${btoa(`${cred.username}:${cred.password}`)}` },
    body,
  });
  bodyText = await response.text();
  if (isAuthRejection(response, bodyText)) {
    throw new Error(`Authentication to ${host} failed (${response.status}). Check the stored credentials in the options page.`);
  }
  return parse(response, bodyText, 'basic');
}

/** Label saved for a host under Options > Known instances, or ''. */
export async function knownInstanceLabel(host) {
  try {
    const res = await chrome.storage.local.get('mysnowbuddy_known_instances');
    const list = Array.isArray(res.mysnowbuddy_known_instances) ? res.mysnowbuddy_known_instances : [];
    return list.find((i) => i.host === String(host).toLowerCase())?.label || '';
  } catch {
    return '';
  }
}
