// Pure logic for "push one artifact to another instance": how the target copy is
// matched, which fields are written, what the user is warned about, and the
// typed-name gate for guarded instances. The network side lives in
// src/background/push.js; the UI in src/sidebar/PushArtifact.jsx.
//
// Decisions (see the final report):
//  - Never write sys_* columns. Exception: sys_id on CREATE, so the new record has the
//    same sys_id as the source. Update sets match records by sys_id, so later update sets
//    for this artifact then update this record instead of creating a duplicate.
//  - Same table only. Match the target by sys_id first, then by a natural key per table.
//  - Artifacts that span several records (flows, workflows, tables, apps) are refused.

import { classifyEnvironment } from '../content/quickActions.js';
import { instanceGuard } from './agent/policy.js';
import { isConfigTable } from './guards.js';
import { diffLines, collapseDiff, hasChanges } from './diff.js';

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const COLUMN_RE = /^[a-z0-9_]+$/i;

export const flatValue = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return String(value.value ?? '');
  return String(value);
};

// Natural keys used when the sys_id does not exist on the target. Every key must have
// a value; the rows that come back are re-checked here because ServiceNow ignores a
// condition on a column that does not exist and would return unrelated rows.
export const MATCH_KEYS = {
  sys_script: ['name', 'collection'],
  sys_script_client: ['name', 'table'],
  catalog_script_client: ['name', 'cat_item'],
  sys_ui_action: ['name', 'table'],
  sys_security_acl: ['name', 'operation'],
  sys_ui_policy: ['short_description', 'table'],
  sys_ui_policy_action: ['ui_policy', 'field'],
  sys_dictionary_override: ['name', 'element', 'base_table'],
  sys_choice: ['name', 'element', 'value', 'language'],
  sys_ui_page: ['name'],
  sp_widget: ['id'],
  sys_ws_operation: ['name', 'web_service_definition'],
};

export function matchKeys(table) {
  return MATCH_KEYS[table] || ['name'];
}

/**
 * Encoded query for matching by natural key, or null when the source lacks a usable key.
 * @returns {{query: string, keys: string[]}|null}
 */
export function matchQuery(table, source) {
  const keys = matchKeys(table);
  const parts = [];
  for (const key of keys) {
    if (!source || !(key in source)) return null;
    const value = flatValue(source[key]);
    if (!value || /[\^\n\r]/.test(value) || value.length > 200) return null;
    parts.push(`${key}=${value}`);
  }
  return { query: parts.join('^'), keys };
}

/** True when every key value of `row` equals the source's exactly (letter case included). */
export function exactKeyMatch(row, source, keys) {
  return Boolean(row) && keys.every((k) => flatValue(row[k]) === flatValue(source[k]));
}

/** Same fields with the same values (order ignored). */
export function samePayload(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && String(a[k]) === String(b[k]));
}

/**
 * Rows whose key values equal the source's exactly, or, only when none do, equal it ignoring
 * letter case. A case-only match must be confirmed by the user (see exactKeyMatch).
 */
export function pickKeyMatches(rows, source, keys) {
  const exact = (rows || []).filter((row) => keys.every((k) => flatValue(row[k]) === flatValue(source[k])));
  if (exact.length) return exact;
  return (rows || []).filter((row) => keys.every((k) => flatValue(row[k]).toLowerCase() === flatValue(source[k]).toLowerCase()));
}

// Records that only make sense with their children, or that change the schema or the
// platform itself. These go through update sets.
const REFUSED_PREFIXES = ['sys_hub_', 'wf_', 'sys_update_'];
const REFUSED_TABLES = new Set(['sys_app', 'sys_scope', 'sys_store_app', 'sys_db_object', 'sys_dictionary', 'sys_plugins', 'sys_package', 'sys_user', 'sys_user_group']);
// Configuration tables the safety guard's list (lib/guards.js isConfigTable) does not name.
const EXTRA_CONFIG = new Set(['sys_app_module', 'sys_app_application', 'sys_user_role', 'sys_dictionary_override', 'sys_relationship', 'sys_processor', 'sys_rest_message', 'sys_rest_message_fn', 'sys_filter_option_dynamic', 'sys_transform_entry', 'sys_transform_script', 'catalog_ui_policy_action', 'item_option_new', 'sys_embedded_help_content']);

/** Why a table cannot be pushed, or null when it can. */
export function refusalReason(table) {
  const name = String(table || '').toLowerCase();
  if (!COLUMN_RE.test(name)) return 'Unknown table.';
  if (REFUSED_TABLES.has(name) || REFUSED_PREFIXES.some((p) => name.startsWith(p))) {
    return `${name} records are part of something bigger (a flow, a table definition, an application) or are user data. Move them with an update set.`;
  }
  if (!isConfigTable(name) && !EXTRA_CONFIG.has(name)) {
    return `${name} is not a configuration table this tool knows. Push is for configuration records only.`;
  }
  return null;
}

/** Columns that are never written. */
export const isSystemColumn = (name) => /^sys_/i.test(name);

/**
 * The fields a push may write.
 * @param {object} record
 * @param {{mode: 'create'|'update', keepSysId?: boolean}} options
 */
export function pushableFields(record, { mode, keepSysId = true } = {}) {
  const out = {};
  Object.entries(record || {}).forEach(([name, value]) => {
    if (!COLUMN_RE.test(name) || name.includes('.')) return;
    if (isSystemColumn(name)) {
      if (name === 'sys_id' && mode === 'create' && keepSysId && SYS_ID_RE.test(flatValue(value))) out.sys_id = flatValue(value);
      return;
    }
    out[name] = flatValue(value);
  });
  return out;
}

/**
 * What a push would do.
 * @param {{table: string, source: object, target: object|null, matchedBy: 'sys_id'|'name'|null, sourceHost?: string, targetHost?: string}} input
 * @returns {{mode: 'create'|'update'|'none', targetSysId: string|null, changes: Array<{name, before, after, rows}>, payload: object, warnings: string[], blockers: string[], skipped: string[]}}
 */
export function planPush({ table, source, target, matchedBy }) {
  const warnings = [];
  const blockers = [];
  const skipped = [];
  const refusal = refusalReason(table);
  if (refusal) blockers.push(refusal);
  if (!source) blockers.push('The source record could not be read.');

  const mode = target ? 'update' : 'create';
  const fields = pushableFields(source || {}, { mode });
  const changes = [];
  const payload = {};

  Object.keys(fields)
    .sort()
    .forEach((name) => {
      const after = fields[name];
      if (name === 'sys_id') {
        payload.sys_id = after;
        return;
      }
      if (mode === 'update') {
        if (!(name in target)) {
          skipped.push(name);
          return;
        }
        const before = flatValue(target[name]);
        if (before === after) return;
        payload[name] = after;
        const diff = diffLines(before, after);
        changes.push({ name, before, after, rows: hasChanges(diff) ? collapseDiff(diff, 3) : [] });
      } else {
        if (after === '') return; // let the target's defaults apply
        payload[name] = after;
        const diff = diffLines('', after);
        changes.push({ name, before: '', after, rows: collapseDiff(diff, 3) });
      }
    });

  if (skipped.length) warnings.push(`Not on the target (skipped): ${skipped.join(', ')}. The target may be on an older release or missing a plugin.`);

  const refs = changes.filter((c) => SYS_ID_RE.test(c.after)).map((c) => c.name);
  if (refs.length) warnings.push(`${refs.join(', ')} point${refs.length === 1 ? 's' : ''} to another record by sys_id. Make sure that record exists on the target.`);

  if (mode === 'update' && matchedBy === 'name' && source && target && flatValue(source.sys_id) !== flatValue(target.sys_id)) {
    warnings.push('Matched by name: the sys_ids differ between the instances. A later update set for this record will create a second copy on the target instead of updating this one.');
  }

  if (table === 'sys_properties' && /password/i.test(flatValue(source?.type))) {
    blockers.push('Password properties are encrypted per instance and cannot be copied. Set the value on the target by hand.');
  }

  const sourceScope = flatValue(source?.sys_scope);
  if (mode === 'create' && sourceScope && sourceScope !== 'global') {
    blockers.push('This record belongs to a scoped application. A new record would land in whatever scope is current on the target. Use the application’s update set or source control.');
  }
  if (mode === 'update' && sourceScope && target && flatValue(target.sys_scope) && sourceScope !== flatValue(target.sys_scope)) {
    warnings.push('The record is in a different application scope on the target.');
  }

  if (mode === 'create' && !payload.sys_id) warnings.push('The new record gets a new sys_id on the target.');

  const effective = Object.keys(payload).filter((k) => k !== 'sys_id');
  return {
    mode: blockers.length ? mode : effective.length ? mode : 'none',
    targetSysId: target ? flatValue(target.sys_id) : null,
    changes,
    payload,
    warnings,
    blockers,
    skipped,
  };
}

/**
 * Whether a write to `host` needs the typed-name confirmation. Uses the same rule as the agent:
 * only an instance positively identified as dev, test or stage skips it. A known-instance label
 * that says "prod" makes it production even when the hostname does not (policy.instanceGuard, shared with the
 * agent, MCP and My work, so every write path agrees).
 */
export function writeGuard({ host, label = '' }) {
  const instance = String(host || '').split('.')[0].toLowerCase();
  const fromHost = classifyEnvironment(instance);
  const { env, guarded } = instanceGuard({ env: fromHost ? fromHost.env : 'unknown', label });
  return { instance, env, guarded, prod: env === 'prod' };
}

/** Typed-name confirmation: the instance's short name, case-insensitive. */
export function confirmMatches(typed, instanceName) {
  const want = String(instanceName || '').trim().toLowerCase();
  return Boolean(want) && String(typed || '').trim().toLowerCase() === want;
}

/** Sanitise fields received by the service worker before a write. Throws on anything odd. */
export function sanitizePushPayload(fields, { mode }) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Nothing to push.');
  const out = {};
  Object.entries(fields).forEach(([name, value]) => {
    if (!COLUMN_RE.test(name)) throw new Error(`Invalid field name "${name}".`);
    if (isSystemColumn(name) && !(name === 'sys_id' && mode === 'create')) return;
    if (name === 'sys_id' && !SYS_ID_RE.test(String(value))) throw new Error('Invalid sys_id.');
    if (value !== null && typeof value === 'object') throw new Error(`Field "${name}" must be a plain value.`);
    out[name] = value === null || value === undefined ? '' : String(value);
  });
  if (!Object.keys(out).filter((k) => k !== 'sys_id').length) throw new Error('Nothing to push.');
  return out;
}

/** Fields whose stored value on the target differs from what was written (business rules, data policies). */
export function verifyWrite(written, after) {
  const norm = (v) => flatValue(v).replace(/\r\n/g, '\n');
  return Object.keys(written)
    .filter((k) => k !== 'sys_id')
    .filter((k) => after && k in after && norm(after[k]) !== norm(written[k]));
}
