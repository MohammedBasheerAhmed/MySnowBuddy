// "Why did / didn't my rule run?", the instance half. Reads the rules that could apply to the record on screen
// (business rules, client scripts, UI policies, data policies, ACLs, including those on parent tables), the form's
// values and the saved record, and the current user's roles, then hands them to the evaluator in
// src/lib/ruleExplain.js. Read-only. A section that fails becomes a note; the report still loads.
//
// ServiceNow drops query conditions on columns it does not know and returns every row, so every query below uses
// columns that exist on all releases, and each row is checked again by the evaluator.

import { callPage } from './pageBridge.js';
import { queryTable, queryInChunks } from './tableApi.js';
import { tableHierarchy } from './fieldInspector.js';
import { readCurrentUser, readUserRoles } from './controlSession.js';
import { recordUrl } from './codeSearch.js';
import { RULE_TYPES, RULE_TYPE_ORDER, OPERATIONS, ACL_OPERATIONS, normalizeRule, explainAll, dottedFields, defaultOperation } from '../lib/ruleExplain.js';

const TABLE_RE = /^[a-z][a-z0-9_]{0,79}$/;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const LIMIT = 300;
const BY_NAME_LIMIT = 25;

const errorText = (err) => err?.message || String(err);
// A caret ends a condition in an encoded query; a value may not contain one.
const safeValue = (value) => String(value || '').replace(/\^/g, ' ').trim().slice(0, 80);

/** Per type: the columns to read, the query for "everything that could apply to these tables", the name column. */
const SOURCES = {
  br: {
    table: 'sys_script',
    nameField: 'name',
    fields: ['sys_id', 'name', 'collection', 'when', 'order', 'active', 'action_insert', 'action_update', 'action_delete', 'action_query', 'filter_condition', 'advanced', 'condition', 'role_conditions'],
    forTables: (chain) => `collectionIN${chain.join(',')}^ORDERBYorder`,
  },
  cs: {
    table: 'sys_script_client',
    nameField: 'name',
    fields: ['sys_id', 'name', 'table', 'type', 'field', 'active', 'ui_type', 'applies_extended'],
    forTables: (chain) => `tableIN${chain.join(',')}^ORDERBYname`,
  },
  uip: {
    table: 'sys_ui_policy',
    nameField: 'short_description',
    fields: ['sys_id', 'short_description', 'table', 'conditions', 'active', 'on_load', 'reverse_if_false', 'inherit', 'run_scripts', 'view', 'order'],
    forTables: (chain) => `tableIN${chain.join(',')}^ORDERBYorder`,
  },
  dp: {
    table: 'sys_data_policy2',
    nameField: 'short_description',
    fields: ['sys_id', 'short_description', 'model_table', 'conditions', 'active', 'enforce_ui', 'reverse_if_false', 'inherit'],
    forTables: (chain) => `model_tableIN${chain.join(',')}^ORDERBYshort_description`,
  },
  acl: {
    table: 'sys_security_acl',
    nameField: 'name',
    fields: ['sys_id', 'name', 'operation.name', 'active', 'condition', 'advanced', 'script', 'admin_overrides'],
    // "incident", "incident.*" and "incident.priority" on the table and every parent, narrowed to the chosen operation.
    forTables: (chain, { aclOperation }) => `${chain.flatMap((t) => [`name=${t}`, `nameSTARTSWITH${t}.`]).map((p, i) => (i ? `OR${p}` : p)).join('^')}^operation.name=${aclOperation}^ORDERBYname`,
  },
};

/** The form's values, the table and record it is bound to, and whether it is a new record. */
async function readForm(context = {}) {
  const [meta, values] = await Promise.all([callPage('getFormMeta').catch(() => null), callPage('getFormValues').catch(() => null)]);
  const table = meta?.table || context.table || '';
  const sysId = meta?.sysId || context.sysId || '';
  if (!TABLE_RE.test(table) || !values?.values) throw new Error('Open a record form first. This answers for the record on screen.');
  const isNew = meta?.isNewRecord === true || !SYS_ID_RE.test(sysId || '');
  return { table, sysId: SYS_ID_RE.test(sysId || '') ? sysId : '', isNew, current: values.values };
}

/** The saved record: values and display values (a reference shows its name, not its sys_id). */
async function readSaved(table, sysId) {
  const rows = await queryTable(table, `sys_id=${sysId}`, [], { limit: 1, displayValue: true });
  const row = rows[0];
  if (!row) return null;
  const previous = {};
  const display = {};
  Object.entries(row).forEach(([key, cell]) => {
    const value = cell && typeof cell === 'object' ? cell.value : cell;
    previous[key] = value === undefined || value === null ? '' : String(value);
    if (cell && typeof cell === 'object' && cell.display_value && cell.display_value !== cell.value) display[key] = String(cell.display_value);
  });
  return { previous, display };
}

/** Role names behind the sys_ids held by business rules' role conditions. */
async function resolveRoles(rules) {
  const ids = [...new Set(rules.flatMap((r) => r.roleIds || []))].filter((id) => SYS_ID_RE.test(id));
  if (!ids.length) return;
  const rows = await queryInChunks('sys_user_role', 'sys_id', ids, ['sys_id', 'name'], { limit: 200 });
  const names = new Map(rows.map((r) => [r.sys_id, r.name]));
  rules.forEach((rule) => {
    if (rule.roleIds?.length) rule.roleNames = rule.roleIds.map((id) => names.get(id)).filter(Boolean);
  });
}

/** Roles each ACL requires (sys_security_acl_role), by ACL sys_id. */
async function aclRoles(rules) {
  const ids = rules.map((r) => r.sysId).filter((id) => SYS_ID_RE.test(id));
  if (!ids.length) return;
  const rows = await queryInChunks('sys_security_acl_role', 'sys_security_acl', ids, ['sys_security_acl', 'sys_user_role.name'], { limit: 500 });
  const byAcl = new Map();
  rows.forEach((row) => {
    const acl = typeof row.sys_security_acl === 'object' ? row.sys_security_acl?.value : row.sys_security_acl;
    const role = row['sys_user_role.name'];
    if (acl && role) byAcl.set(acl, [...(byAcl.get(acl) || []), role]);
  });
  rules.forEach((rule) => {
    rule.roleNames = byAcl.get(rule.sysId) || [];
  });
}

/** Dot-walked values a condition reads, taken from the saved record; skipped when the reference was edited. */
async function addWalked(rules, ctx, table, sysId) {
  const walked = dottedFields(rules);
  if (!walked.length || !sysId) return;
  const rows = await queryTable(table, `sys_id=${sysId}`, walked, { limit: 1 });
  const row = rows[0] || {};
  walked.forEach((field) => {
    if (!(field in row)) return;
    const base = field.split('.')[0];
    ctx.previous[field] = String(row[field] ?? '');
    if (text(ctx.current[base]) === text(ctx.previous[base])) ctx.current[field] = String(row[field] ?? '');
  });
}

const text = (v) => (v === undefined || v === null ? '' : String(v));

/**
 * @param {{ context?: object, operation?: string, aclOperation?: string, types?: string[], ruleName?: string }} args
 *   ruleName: explain the rules with that name (any table) instead of listing everything that could apply.
 */
export async function buildRuleReport({ context = {}, operation, aclOperation, types, ruleName } = {}) {
  const form = await readForm(context);
  const notes = [];
  const wanted = (types && types.length ? types : RULE_TYPE_ORDER).filter((t) => RULE_TYPES[t]);
  const byName = safeValue(ruleName);

  const [chain, saved, user] = await Promise.all([
    tableHierarchy(form.table).catch((err) => {
      notes.push(`Could not read the table hierarchy; only rules on ${form.table} itself are checked: ${errorText(err)}`);
      return [form.table];
    }),
    form.isNew || !form.sysId ? Promise.resolve(null) : readSaved(form.table, form.sysId).catch((err) => {
      notes.push(`Could not read the saved record, so "changes" conditions cannot be checked: ${errorText(err)}`);
      return null;
    }),
    readCurrentUser().catch(() => null),
  ]);

  let roles = null;
  if (user?.sysId) roles = await readUserRoles(user.sysId).catch(() => null);
  if (!roles) {
    const info = await callPage('getUserInfo').catch(() => null);
    if (Array.isArray(info?.roles) && info.roles.length) roles = info.roles;
  }
  if (!roles) notes.push('Your roles could not be read, so role requirements are shown as "cannot tell".');

  const op = OPERATIONS.includes(operation) ? operation : defaultOperation(form.isNew);
  const aclOp = ACL_OPERATIONS.includes(aclOperation) ? aclOperation : form.isNew ? 'create' : 'write';
  const ctx = {
    table: form.table,
    chain,
    isNew: form.isNew,
    operation: op,
    aclOperation: aclOp,
    current: { ...form.current },
    previous: saved ? { ...saved.previous } : null,
    display: saved?.display || {},
    roles,
    uiType: 'desktop',
  };

  // Load every type at once; one that fails becomes a note.
  const loaded = await Promise.all(
    wanted.map(async (type) => {
      const source = SOURCES[type];
      try {
        const query = byName ? `${source.nameField}LIKE${byName}^ORDERBY${source.nameField}` : source.forTables(chain, { aclOperation: aclOp });
        const rows = await queryTable(source.table, query, source.fields, { limit: byName ? BY_NAME_LIMIT : LIMIT });
        const rules = rows.map((row) => normalizeRule(type, row));
        if (type === 'br') await resolveRoles(rules).catch((err) => notes.push(`Could not read the roles business rules require: ${errorText(err)}`));
        if (type === 'acl') await aclRoles(rules).catch((err) => notes.push(`Could not read the roles ACLs require: ${errorText(err)}`));
        return { type, rules, capped: rows.length >= (byName ? BY_NAME_LIMIT : LIMIT) };
      } catch (err) {
        notes.push(`${RULE_TYPES[type].plural} could not be read: ${errorText(err)}`);
        return { type, rules: [], capped: false };
      }
    })
  );

  const rules = loaded.flatMap((entry) => entry.rules);
  loaded.filter((entry) => entry.capped).forEach((entry) => notes.push(`More ${RULE_TYPES[entry.type].plural.toLowerCase()} exist than the ${byName ? BY_NAME_LIMIT : LIMIT} read; the list is cut.`));

  if (form.sysId && !form.isNew && ctx.previous) {
    await addWalked(rules, ctx, form.table, form.sysId).catch((err) => notes.push(`Related-record values could not be read: ${errorText(err)}`));
  }

  const explained = explainAll(rules, ctx);
  const withLinks = explained.results.map((r) => ({ ...r, href: r.sysId ? recordUrl(r.link.table, r.sysId) : '' }));
  const regroup = { run: [], skip: [], unknown: [] };
  withLinks.forEach((r) => regroup[r.outcome].push(r));

  const unsaved = saved ? Object.keys(ctx.current).some((k) => k in saved.previous && text(ctx.current[k]) !== text(saved.previous[k])) : false;

  return {
    subject: { table: form.table, sysId: form.sysId, isNew: form.isNew, chain, operation: op, aclOperation: aclOp, unsaved, fieldCount: Object.keys(form.current).length },
    user: { name: user?.name || user?.userName || '', roles, isAdmin: Boolean(roles?.includes('admin')) },
    byName,
    results: withLinks,
    groups: regroup,
    counts: explained.counts,
    capped: loaded.filter((e) => e.capped).map((e) => e.type),
    notes,
  };
}

export const ruleExplainServices = {
  ruleExplainReport: (args) => buildRuleReport(args),
};
