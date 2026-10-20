// Write guardrails for the agent. Pure rules, shared by the policy (before anyone is asked), the approval cards
// (what they say) and the executors (the check that actually protects the instance). Nothing here reads settings or
// the page: callers pass the resolved settings and what they know about the session.
//
// Design follows the review of the GMG AI Agent guardrails: ACL and role tables are refused unless an admin allowed
// them AND the user elevated to security_admin; extra tables can be denied by pattern; edits to active code say they go
// live; a proposal is refused if the record changed after it was made; and the agent can be read-only for non-admins.

import { isDefaultUpdateSet } from '../guards.js';
import { toolTier } from './toolSchemas.js';

export const SECURITY_ELEVATION_MESSAGE = 'Elevate to security_admin to edit ACL or role records.';
export const SECURITY_PROTECTED_MESSAGE = 'ACL and role tables are protected: the agent may not change them. An admin can allow it in Options > Agent > Agent safety, and you must elevate to security_admin.';
export const NON_ADMIN_READONLY_MESSAGE = 'Updating records is turned off for your role.';
export const STALE_MESSAGE = 'The record changed after this proposal was made. Ask again.';
export const LIVE_ACTIVE_NOTE = 'Live change: this script is active. It takes effect as soon as you approve.';
export const LIVE_INACTIVE_NOTE = 'This record is inactive, so it will not run until someone activates it.';

/** The tables that decide who may do what. Children of sys_security_acl are covered by the prefix. */
const SECURITY_TABLES = new Set(['sys_security_acl', 'sys_security_acl_role', 'sys_user_role', 'sys_user_has_role', 'sys_user_role_contains', 'sys_group_has_role']);

export const isSecurityTable = (table) => {
  const t = String(table || '').toLowerCase();
  return SECURITY_TABLES.has(t) || t.startsWith('sys_security_acl');
};

// ---- Settings ----------------------------------------------------------------------------------------

const PATTERN_RE = /^[a-z0-9_*]+$/;

/** "u_secret_*, x_acme_*" (or an array) -> ['u_secret_*', 'x_acme_*']: lower case, valid characters only, no duplicates. */
export function normalizeDeniedTables(input) {
  const parts = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const out = [];
  for (const part of parts) {
    const p = String(part || '').trim().toLowerCase();
    if (p && PATTERN_RE.test(p) && p.replace(/\*/g, '') !== '' && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The pattern of `patterns` that matches `table` (with * wildcards), or ''. */
export function matchDeniedTable(table, patterns = []) {
  const t = String(table || '').toLowerCase();
  if (!t) return '';
  return (
    patterns.find((pattern) => {
      if (!pattern.includes('*')) return pattern === t;
      const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      return re.test(t);
    }) || ''
  );
}

/** Everything the guardrails need from the saved settings, with the safe default for each. */
export function resolveGuardrails(settings = {}) {
  const s = settings || {};
  return {
    allowSecurityTableWrites: s.allowSecurityTableWrites === true,
    deniedTables: normalizeDeniedTables(s.deniedTables),
    refuseActiveScriptEdits: s.refuseActiveScriptEdits === true,
    readOnlyForNonAdmin: s.agentReadOnlyForNonAdmin === true,
  };
}

// ---- Table rules --------------------------------------------------------------------------------------

/** Why a table is on the user's denied list, or null. Applies to reading and writing. */
export function deniedTableBlock(table, guard = {}) {
  const hit = matchDeniedTable(table, guard.deniedTables || []);
  return hit ? `${table} is on your denied-tables list (${hit}) in Options > Agent > Agent safety; the agent never reads or changes it.` : null;
}

/**
 * Why a write to an ACL or role table is refused, or null when it may go ahead.
 * `session.securityAdmin` is true/false when the session was read, undefined when it is not known yet (the sync check
 * before an approval card): then only the setting decides, and the executor checks the elevation for real.
 */
export function securityTableBlock(table, guard = {}, session = {}) {
  if (!isSecurityTable(table)) return null;
  if (session.securityAdmin === false) return SECURITY_ELEVATION_MESSAGE;
  if (!guard.allowSecurityTableWrites) return SECURITY_PROTECTED_MESSAGE;
  return null;
}

// ---- Who may change anything -----------------------------------------------------------------------------------

/** Tools that change records, code or the form (session switching and impersonation are not "updating records"). */
export const RECORD_CHANGING_TOOLS = new Set([
  'set_form_field',
  'save_form',
  'save_artifact',
  'undo_last_write',
  'click_ui_action',
  'run_ui_steps',
  'create_record',
  'update_record',
  'delete_record',
  'run_background_script',
]);

/**
 * "Updating records is turned off for your role" when the switch is on and the user is not an admin.
 * `session.admin` undefined means unknown: the sync check lets it through and the executor, which reads the roles,
 * refuses (fail closed).
 */
export function nonAdminBlock(tool, guard = {}, session = {}) {
  if (!guard.readOnlyForNonAdmin || !RECORD_CHANGING_TOOLS.has(tool) || toolTier(tool) !== 'write') return null;
  return session.admin === true || session.admin === undefined ? null : NON_ADMIN_READONLY_MESSAGE;
}

// ---- Live changes -----------------------------------------------------------------------------------------------

const isTrue = (v) => v === true || String(v).toLowerCase() === 'true';
const isFalse = (v) => v === false || String(v).toLowerCase() === 'false';

/** The card sentence for an edit of config whose `active` flag is `active`, or null when the record has no such flag. */
export function liveChangeNote(active) {
  if (isTrue(active)) return LIVE_ACTIVE_NOTE;
  if (isFalse(active)) return LIVE_INACTIVE_NOTE;
  return null;
}

/** Why an edit of active code is refused when the user turned that switch on, or null. */
export function activeEditBlock({ guard = {}, active, isConfig = true } = {}) {
  if (!guard.refuseActiveScriptEdits || !isConfig || !isTrue(active)) return null;
  return 'This record is active, so an edit goes live immediately. Editing active code is turned off in Options > Agent > Agent safety: deactivate it first, or make the change yourself.';
}

// ---- Update set on the card --------------------------------------------------------------------------------------

/**
 * What the card says about where a configuration change is recorded.
 * @param {{name?: string} | null} updateSet the current update set, or null when it could not be read
 */
export function updateSetCard(updateSet) {
  if (!updateSet || !updateSet.name) return { notes: ['The current update set could not be read, so it is not known where this change is captured.'], warnings: [] };
  if (isDefaultUpdateSet(updateSet.name)) {
    return { notes: [`Captured in the update set "${updateSet.name}".`], warnings: [`"${updateSet.name}" is the Default update set: changes there are easy to lose or ship by accident. Switch to a named update set first.`] };
  }
  return { notes: [`Captured in the update set "${updateSet.name}".`], warnings: [] };
}

// ---- Stale proposals -----------------------------------------------------------------------------------------------

const norm = (v) => (v == null ? '' : String(v));

/** True when the record's version markers differ from the ones the proposal was built on. */
export function isStale(pinned, current) {
  if (!pinned) return false;
  if (norm(pinned.updatedOn) === '' && norm(pinned.modCount) === '') return false; // nothing was captured to compare with
  if (!current) return true; // gone, or not readable any more
  return norm(pinned.updatedOn) !== norm(current.updatedOn) || norm(pinned.modCount) !== norm(current.modCount);
}

/**
 * Remembers what the approval card showed for a record (its sys_updated_on and sys_mod_count), so the write that
 * follows can refuse if the record moved on meanwhile. A pin is used once.
 */
export function createStalePins(max = 50) {
  const pins = new Map();
  return {
    set(key, state) {
      if (!key) return;
      pins.delete(key);
      pins.set(key, { updatedOn: norm(state?.updatedOn), modCount: norm(state?.modCount) });
      while (pins.size > max) pins.delete(pins.keys().next().value);
    },
    /** The refusal text when `current` no longer matches the pin for `key`, else null. Consumes the pin. */
    check(key, current) {
      const pinned = pins.get(key);
      pins.delete(key);
      return isStale(pinned, current) ? STALE_MESSAGE : null;
    },
    has: (key) => pins.has(key),
    size: () => pins.size,
  };
}
