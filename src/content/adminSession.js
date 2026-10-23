// Is this browser session an administrator right now? The Table API answers a table the user may not read with an
// empty list instead of an error, so panels confirm an empty answer with an unfiltered one-row read. An admin session
// reads every table the panels look at, so for admins that confirmation is skipped and a table that is simply empty
// (a PDI with no legacy workflows, no events yet) is reported as empty, not as "could not read".
//
// `getSessionInfo.admin` is g_user.hasRoleExactly('admin'): true only while the admin role is active in the session
// (impersonating someone else, or an unelevated session, makes it false). The answer is cached for 30 seconds.

import { callPage } from './pageBridge.js';

const TTL_MS = 30000;
let cached = null;

export async function isAdminSession() {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const info = await callPage('getSessionInfo').catch(() => null);
  const value = info?.admin === true;
  cached = { at: Date.now(), value };
  return value;
}

/** For tests and after impersonation starts or ends. */
export function forgetAdminSession() {
  cached = null;
}
