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
