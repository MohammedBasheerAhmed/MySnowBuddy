// Same-origin REST calls made with only the session cookie get a 401 plus a Basic-auth challenge,
// which the browser shows as a login popup. Sending the session's X-UserToken avoids that, so a
// request is never sent without one.

import { callPage } from './pageBridge.js';

const TOKEN_TTL_MS = 5 * 60 * 1000;
const TOKEN_RE = /\bg_ck\s*[=:]\s*['"]([0-9A-Za-z]{20,})['"]/;
let cached = { token: null, at: 0 };

function pageDocuments() {
  const docs = [document];
  try {
    const frameDoc = document.getElementById('gsft_main')?.contentDocument;
    if (frameDoc) docs.push(frameDoc);
  } catch {
    // Cross-origin frame; ignore.
  }
  return docs;
}

// Fallback when the page bridge is unavailable: the token is also in the page markup.
function tokenFromMarkup() {
  for (const doc of pageDocuments()) {
    const input = doc.querySelector('input[name="sysparm_ck"]');
    if (input?.value) return input.value;
    for (const script of doc.scripts) {
      const match = TOKEN_RE.exec(script.textContent || '');
      if (match) return match[1];
    }
  }
  return null;
}

/** The session token, or null when it cannot be read. */
export async function getSessionToken() {
  if (cached.token && Date.now() - cached.at < TOKEN_TTL_MS) return cached.token;
  let token = null;
  try {
    token = await callPage('getCsrfToken');
  } catch {
    // Bridge unavailable; try the markup.
  }
  token = token || tokenFromMarkup();
  if (token) cached = { token, at: Date.now() };
  return token;
}

/** Headers for a JSON request to the current instance. Throws rather than risk a login popup. */
export async function sessionHeaders(extra = {}) {
  const token = await getSessionToken();
  if (!token) {
    throw new Error('Could not read the ServiceNow session token. Reload the page and try again.');
  }
  return { Accept: 'application/json', 'X-UserToken': token, ...extra };
}
