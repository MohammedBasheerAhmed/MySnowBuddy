// The role tier of the signed-in user, read once from the page (g_user) and kept for a short while.
// Unknown (the roles could not be read, or the setting is off) means "show everything" - see lib/roleTier.js.

import { callPage } from './pageBridge.js';
import { tierFromSession, parseRoleList, DEFAULT_DEVELOPER_ROLES } from '../lib/roleTier.js';

const FRESH_MS = 5 * 60 * 1000;

export function createRoleAccess({ getSettings }) {
  let cached = { at: 0, tier: null, roles: [], userName: '' };
  let pending = null;
  const listeners = new Set();

  async function read() {
    const settings = (await getSettings().catch(() => null)) || {};
    if (settings.roleTiersEnabled === false) return { at: Date.now(), tier: null, roles: [], userName: '' };
    const info = await callPage('getSessionInfo').catch(() => null);
    const developerRoles = settings.developerRoles ? parseRoleList(settings.developerRoles) : DEFAULT_DEVELOPER_ROLES;
    return { at: Date.now(), tier: tierFromSession(info, developerRoles), roles: Array.isArray(info?.roles) ? info.roles : [], userName: info?.userName || '' };
  }

  /** Re-read the roles (once at a time) and tell the listeners when the tier changed. */
  function refresh() {
    if (!pending) {
      pending = read()
        .then((next) => {
          const changed = next.tier !== cached.tier;
          cached = next;
          if (changed) listeners.forEach((fn) => fn(next.tier));
        })
        .catch(() => {})
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  }

  return {
    /** The tier right now: 'user' | 'developer' | 'admin', or null when unknown (everything is shown). */
    tier: () => cached.tier,
    info: () => cached,
    /** Resolves once the roles are fresh enough to filter by. */
    async ready() {
      if (Date.now() - cached.at > FRESH_MS) await refresh();
      return cached.tier;
    },
    refresh,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
