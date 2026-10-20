// Start and end impersonation the way this release does it (checked live on Australia patch 7):
//   start: POST /api/now/ui/impersonate/<user sys_id>   -> 201 { result: { impersonatedUser } }
//   end:   the same call with the ORIGINAL user's sys_id (there is no end route: /logout_impersonate.do is a 404 and
//          DELETE is not supported). The reply names the real user, e.g. { user: "admin" }.
// The old /impersonate.do?sysparm_start_impersonating=... GET did nothing on this release.
//
// Ending needs to know who you were, so starting remembers it (chrome.storage.local, per host). A session that was
// started elsewhere (the platform's own menu) has no remembered user; ending then explains how to end it by hand.

import { queryTable } from './tableApi.js';
import { sessionHeaders } from './sessionToken.js';

const KEY = 'mysnowbuddy_impersonation_origin';
const SYS_ID_RE = /^[0-9a-f]{32}$/i;

async function readAll() {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return stored?.[KEY] && typeof stored[KEY] === 'object' ? stored[KEY] : {};
  } catch {
    return {};
  }
}

async function writeAll(map) {
  try {
    await chrome.storage.local.set({ [KEY]: map });
  } catch {
    // Storage unavailable: ending will fall back to the manual instructions.
  }
}

/** The sys_id of whoever the session is right now (the impersonated user while impersonating). */
export async function currentUserSysId() {
  const rows = await queryTable('sys_user', 'sys_id=javascript:gs.getUserID()', ['sys_id', 'user_name'], { limit: 1 });
  const id = rows[0]?.sys_id;
  if (!SYS_ID_RE.test(id || '')) throw new Error('Could not tell who you are signed in as.');
  return id;
}

async function post(sysId) {
  const response = await fetch(`/api/now/ui/impersonate/${encodeURIComponent(sysId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: await sessionHeaders({ 'Content-Type': 'application/json' }),
    body: '{}',
  });
  if (response.ok) return;
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.detail || body?.error?.message || '';
  } catch {
    // Not JSON.
  }
  throw new Error(`Impersonation failed (${response.status})${detail ? `: ${detail}` : ''}. It needs the impersonator or admin role.`);
}

/** Start impersonating a user. Does not reload the page: the caller decides. */
export async function startImpersonating(userSysId) {
  if (!SYS_ID_RE.test(userSysId || '')) throw new Error('Invalid user.');
  const host = window.location.hostname;
  const me = await currentUserSysId();
  if (me === userSysId) throw new Error('That is already the session user.');
  await post(userSysId);
  const all = await readAll();
  // Impersonating again while impersonating keeps the real user; a stale entry (ended elsewhere) is replaced.
  const origin = all[host] && all[host].impersonated === me ? all[host].origin : me;
  await writeAll({ ...all, [host]: { origin, impersonated: userSysId } });
}

/** Go back to the user who started the impersonation. Throws with instructions when that user is not known. */
export async function stopImpersonating() {
  const host = window.location.hostname;
  const all = await readAll();
  const origin = all[host]?.origin;
  if (!SYS_ID_RE.test(origin || '')) {
    throw new Error('NowBuddy did not start this impersonation, so it does not know who you were. Use your avatar menu and choose "End impersonation".');
  }
  await post(origin);
  const { [host]: _done, ...rest } = all;
  await writeAll(rest);
}
