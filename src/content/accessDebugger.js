// Access debugger, data side: "Why can't this user see / edit this?"
// Reads the user, their roles (direct, via groups, via role containment), the ACLs that can
// apply to the table / field, and the other things that hide or lock records (before-query
// business rules, domains, UI and data policies), then hands everything to the pure evaluator
// in src/lib/accessTrace.js.
//
// READ-ONLY: only Table API GETs, plus an optional background script that only calls
// GlideRecord.get / can* for the logged-in user. Never impersonates, never changes the session.
//
// explainAccess() is self-contained so it can also back an agent / MCP tool.

import { queryTable, queryInChunks, runBackgroundScript } from './tableApi.js';
import { fetchTableFields } from './fieldInspector.js';
import { searchTables } from './tableCatalog.js';
import { callPage } from './pageBridge.js';
import { getSessionToken } from './sessionToken.js';
import { extractScriptOutput } from '../lib/logTail.js';
import { parseEncodedQuery, explainQuery } from '../lib/query.js';
import {
  OPERATIONS,
  aclCandidateNames,
  resolveRoles,
  evaluateAccess,
  formatTraceText,
  compactTrace,
  scriptExcerpt,
  buildRuntimeCheckScript,
  parseRuntimeCheckOutput,
  RUNTIME_SCOPE_HINT,
  safeQueryTerm,
  isName,
  isSysId,
} from '../lib/accessTrace.js';

// Every query is capped.
const LIMITS = {
  users: 10,
  acls: 500,
  aclRoles: 1000,
  userRoles: 1000,
  groups: 300,
  groupRoles: 1000,
  containsDepth: 8,
  containsEdges: 3000,
  roles: 1000,
  queryRules: 50,
  policies: 25,
  conditionChecks: 20,
};

// security_admin is always an elevated privilege, even if sys_user_role cannot be read.
const KNOWN_ELEVATED = ['security_admin'];

const v = (x) => (x && typeof x === 'object' ? String(x.value ?? '') : x == null ? '' : String(x));
const d = (x) => (x && typeof x === 'object' ? String(x.display_value ?? x.value ?? '') : x == null ? '' : String(x));
// A choice value, or the display value when the column is a reference (sys_id value).
const word = (x) => {
  const value = v(x);
  return (value && !isSysId(value) ? value : d(x)).trim().toLowerCase();
};
const uniq = (list) => [...new Set(list.filter(Boolean))];

/** Columns of `table` (its own dictionary entries) among `names`; null when the dictionary cannot be read. */
async function columnsOf(table, names) {
  try {
    const rows = await queryTable('sys_dictionary', `name=${table}^elementIN${names.join(',')}`, ['element'], { limit: 50 });
    return new Set(rows.map((r) => r.element));
  } catch {
    return null;
  }
}

// ---- Who --------------------------------------------------------------------------------------

let me = { id: '', at: 0 };

/** sys_id of the logged-in (session) user. */
async function currentUserId() {
  if (me.id && Date.now() - me.at < 60000) return me.id;
  let id = '';
  try {
    const info = await callPage('getUserInfo');
    if (isSysId(info?.userId)) id = info.userId;
  } catch {
    // No page bridge (or no g_user on this page): ask the instance.
  }
  if (!id) {
    const rows = await queryTable('sys_user', 'sys_id=javascript:gs.getUserID()', ['sys_id'], { limit: 2 }).catch(() => []);
    if (rows.length === 1 && isSysId(rows[0].sys_id)) id = rows[0].sys_id;
  }
  if (!id) throw new Error('Could not tell which user you are logged in as. Reload the page and try again.');
  me = { id, at: Date.now() };
  return id;
}

const USER_FIELDS = ['sys_id', 'name', 'user_name', 'email', 'active', 'locked_out', 'sys_domain', 'title'];

function userFromRow(row, meId) {
  return {
    sysId: v(row.sys_id),
    name: d(row.name),
    userName: v(row.user_name),
    email: v(row.email),
    title: d(row.title),
    active: v(row.active) !== 'false',
    lockedOut: v(row.locked_out) === 'true',
    domain: row.sys_domain ? d(row.sys_domain) : '',
    domainId: row.sys_domain ? v(row.sys_domain) : '',
    isMe: Boolean(meId) && v(row.sys_id) === meId,
  };
}

/** A user from a sys_id, user name, email, exact name, or "" / "me" for the logged-in user. */
async function resolveUser(input, meId) {
  // Every branch below puts the text in a query: only plain name characters get through.
  const text = safeQueryTerm(input, 'User');
  const opts = { limit: 3, displayValue: true };
  let rows;
  if (!text || /^me$/i.test(text)) {
    if (!meId) throw new Error('Could not tell which user you are logged in as. Pick a user.');
    rows = await queryTable('sys_user', `sys_id=${meId}`, USER_FIELDS, opts);
  } else if (isSysId(text)) {
    rows = await queryTable('sys_user', `sys_id=${text}`, USER_FIELDS, opts);
  } else {
    rows = await queryTable('sys_user', `user_name=${text}^ORemail=${text}`, USER_FIELDS, opts);
    if (!rows.length) rows = await queryTable('sys_user', `name=${text}`, USER_FIELDS, opts);
  }
  if (!rows.length) throw new Error(`No user matches "${text || 'you'}" (or you cannot read sys_user).`);
  if (rows.length > 1) throw new Error(`More than one user matches "${text}". Pick one from the list.`);
  return userFromRow(rows[0], meId);
}

/** Roles and groups of a user, with the raw rows resolveRoles() needs. */
async function fetchRoleData(userId) {
  const notes = [];
  const [assignedRows, memberRows] = await Promise.all([
    queryTable(
      'sys_user_has_role',
      `user=${userId}`,
      ['role', 'role.name', 'inherited', 'granted_by', 'granted_by.name', 'included_in_role', 'included_in_role.name', 'state'],
      { limit: LIMITS.userRoles }
    ).catch(() => null),
    queryTable('sys_user_grmember', `user=${userId}`, ['group', 'group.name', 'group.active'], { limit: LIMITS.groups }).catch(() => null),
  ]);
  if (!assignedRows) notes.push('Could not read sys_user_has_role, so roles assigned directly to the user are missing.');
  const assignedComplete = !assignedRows || assignedRows.length < LIMITS.userRoles;
  if (!assignedComplete) {
    notes.push(`The user has more than ${LIMITS.userRoles} role rows; only the first ${LIMITS.userRoles} were read, so roles from groups and containment are kept even when they are not in that list.`);
  }
  if (!memberRows) notes.push('Could not read sys_user_grmember, so group memberships are missing.');

  const assigned = (assignedRows || [])
    .filter((r) => r['role.name'])
    .map((r) => ({
      role: r['role.name'],
      roleId: r.role,
      inherited: 'inherited' in r ? r.inherited === 'true' : Boolean(r.granted_by || r.included_in_role),
      grantedBy: r['granted_by.name'] || '',
      grantedById: r.granted_by || '',
      includedIn: r['included_in_role.name'] || '',
      // Only an explicit pending/requested state counts as not (yet) granted.
      active: !/pend|request|inactive|revok/i.test(r.state || ''),
    }));
  const direct = assigned.filter((a) => !a.inherited).map((a) => ({ role: a.role, roleId: a.roleId }));

  const groups = (memberRows || [])
    .filter((m) => m.group)
    .map((m) => ({ sysId: m.group, name: m['group.name'] || m.group, active: m['group.active'] !== 'false' }));

  const groupRoleRows = groups.length
    ? await queryInChunks('sys_group_has_role', 'group', groups.map((g) => g.sysId), ['group', 'group.name', 'role', 'role.name', 'inherits'], { limit: LIMITS.groupRoles }).catch(() => {
        notes.push('Could not read sys_group_has_role, so roles from groups are missing.');
        return [];
      })
    : [];
  const activeGroup = new Map(groups.map((g) => [g.sysId, g.active]));
  const groupRoles = groupRoleRows
    .filter((r) => r['role.name'])
    .map((r) => ({
      group: r['group.name'] || r.group,
      groupId: r.group,
      role: r['role.name'],
      roleId: r.role,
      inherits: r.inherits !== 'false',
      groupActive: activeGroup.get(r.group) !== false,
    }));

  // Role containment, breadth first from every role the user starts with.
  const contains = [];
  let frontier = uniq([...direct.map((r) => r.roleId), ...groupRoles.map((r) => r.roleId)]);
  const seen = new Set(frontier);
  for (let depth = 0; depth < LIMITS.containsDepth && frontier.length && contains.length < LIMITS.containsEdges; depth += 1) {
    // eslint-disable-next-line no-await-in-loop -- each level depends on the previous one.
    const rows = await queryInChunks('sys_user_role_contains', 'role', frontier, ['role', 'role.name', 'contains', 'contains.name'], { limit: 1000 }).catch(() => []);
    const next = [];
    rows.forEach((r) => {
      if (!r.contains || !r['contains.name']) return;
      contains.push({ parent: r['role.name'], child: r['contains.name'], childId: r.contains });
      if (!seen.has(r.contains)) {
        seen.add(r.contains);
        next.push(r.contains);
      }
    });
    frontier = next;
  }

  return { assigned: assignedRows ? assigned : null, assignedComplete, direct, groups, groupRoles, contains, notes };
}

/** Names of the elevated-privilege roles among `roleIds`. */
async function fetchElevated(roleIds) {
  const rows = await queryInChunks('sys_user_role', 'sys_id', uniq(roleIds), ['sys_id', 'name', 'elevated_privilege'], { limit: LIMITS.roles }).catch(() => []);
  return uniq([...KNOWN_ELEVATED, ...rows.filter((r) => r.elevated_privilege === 'true').map((r) => r.name)]);
}

// ---- ACLs ---------------------------------------------------------------------------------------

const OPTIONAL_ACL_COLUMNS = ['decision_type', 'applies_to', 'security_attribute', 'advanced', 'admin_overrides'];

function aclFromRow(row, has) {
  return {
    sysId: v(row.sys_id),
    name: v(row.name),
    operation: word(row.operation),
    type: word(row.type) || 'record',
    active: v(row.active) !== 'false',
    decision: has('decision_type') && /deny/i.test(`${v(row.decision_type)} ${d(row.decision_type)}`) ? 'deny' : 'allow',
    adminOverrides: v(row.admin_overrides) === 'true',
    condition: v(row.condition),
    script: v(row.script),
    advanced: has('advanced') ? v(row.advanced) === 'true' : undefined,
    appliesTo: has('applies_to') ? v(row.applies_to) : '',
    securityAttribute: has('security_attribute') ? d(row.security_attribute) : '',
    description: v(row.description),
    scope: d(row.sys_scope),
    roles: [],
  };
}

async function fetchAcls(names, operation) {
  const cols = await columnsOf('sys_security_acl', OPTIONAL_ACL_COLUMNS);
  let rows;
  try {
    rows = await queryTable(
      'sys_security_acl',
      `nameIN${names.join(',')}`,
      ['sys_id', 'name', 'operation', 'type', 'active', 'condition', 'script', 'description', 'sys_scope', ...OPTIONAL_ACL_COLUMNS],
      { limit: LIMITS.acls, displayValue: true }
    );
  } catch (err) {
    throw new Error(`Could not read ACLs (sys_security_acl): ${err.message}. The access debugger needs a role that can read ACLs, such as admin.`);
  }
  const has = (col) => (cols ? cols.has(col) : rows.some((r) => col in r));
  // create also reads write ACLs: field-level create may fall back to them (see createFallback in accessTrace.js).
  const relevantOps = new Set([operation, 'query_range', 'query_match', ...(operation === 'create' ? ['write'] : [])]);
  const acls = rows.map((r) => aclFromRow(r, has)).filter((a) => a.type === 'record' && relevantOps.has(a.operation));

  if (acls.length) {
    // Without the role rows every role check would look like "no role required", so a failure here is fatal.
    const roleRows = await queryInChunks('sys_security_acl_role', 'sys_security_acl', acls.map((a) => a.sysId), ['sys_security_acl', 'sys_user_role', 'sys_user_role.name'], { limit: LIMITS.aclRoles }).catch((err) => {
      throw new Error(`Could not read the roles of the ACLs (sys_security_acl_role): ${err.message}`);
    });
    const byAcl = new Map();
    roleRows.forEach((r) => {
      if (!r['sys_user_role.name']) return;
      if (!byAcl.has(r.sys_security_acl)) byAcl.set(r.sys_security_acl, []);
      byAcl.get(r.sys_security_acl).push({ name: r['sys_user_role.name'], id: r.sys_user_role });
    });
    acls.forEach((a) => {
      const roles = byAcl.get(a.sysId) || [];
      a.roles = uniq(roles.map((r) => r.name));
      a.roleIds = uniq(roles.map((r) => r.id));
    });
  }

  const notes = [];
  if (!has('decision_type')) notes.push('Deny-Unless ACLs are not available on this release, so every ACL is Allow-If.');
  if (rows.length >= LIMITS.acls) notes.push(`Only the first ${LIMITS.acls} ACLs were read; the trace may be incomplete.`);
  return { acls, notes };
}

/** Why a condition cannot be checked by querying the record, or '' when it can. */
function uncheckable(query, knownFields) {
  if (/javascript\s*:|DYNAMIC/i.test(query)) return 'Uses a dynamic value (like "me"), so it is checked as the user at runtime.';
  if (/\^NQ|RLQUERY|SUBQUERY/.test(query)) return 'Too complex to check here; checked at runtime.';
  const parsed = parseEncodedQuery(query);
  if (parsed.raw.length) return 'Part of the condition could not be read; checked at runtime.';
  const unknown = parsed.groups.flat().find((c) => !knownFields.has(c.field.split('.')[0]));
  if (unknown) return `Uses "${unknown.field}", which is not a column of this table; checked at runtime.`;
  return '';
}

/**
 * Check ACL conditions and "applies to" filters against the record with a query
 * (sys_id=<record>^<condition>), as the logged-in user. Only for plain conditions.
 */
async function runConditionChecks({ table, sysId, acls, knownFields }) {
  const conditionChecks = {};
  const appliesChecks = {};
  const jobs = [];
  acls.forEach((acl) => {
    [
      ['condition', conditionChecks],
      ['appliesTo', appliesChecks],
    ].forEach(([key, target]) => {
      const query = String(acl[key] || '').trim();
      if (!query) return;
      const reason = uncheckable(query, knownFields);
      if (reason) target[acl.sysId] = reason;
      else jobs.push({ target, id: acl.sysId, query });
    });
  });

  const run = jobs.slice(0, LIMITS.conditionChecks);
  jobs.slice(LIMITS.conditionChecks).forEach((j) => {
    j.target[j.id] = 'Not checked here (too many conditions); checked at runtime.';
  });
  for (let i = 0; i < run.length; i += 5) {
    // eslint-disable-next-line no-await-in-loop -- small batches keep the load on the instance low.
    await Promise.all(
      run.slice(i, i + 5).map(async (job) => {
        try {
          const rows = await queryTable(table, `sys_id=${sysId}^${job.query}`, ['sys_id'], { limit: 1 });
          job.target[job.id] = rows.length === 1;
        } catch {
          job.target[job.id] = 'Could not check the condition; checked at runtime.';
        }
      })
    );
  }
  return { conditionChecks, appliesChecks };
}

// ---- Other reasons --------------------------------------------------------------------------

async function queryRulesSection(hierarchy, operation) {
  const rows = await queryTable(
    'sys_script',
    `collectionIN${[...hierarchy, 'global'].join(',')}^action_query=true^active=true^ORDERBYorder`,
    ['sys_id', 'name', 'collection', 'when', 'order', 'condition', 'filter_condition', 'script', 'sys_scope.scope'],
    { limit: LIMITS.queryRules }
  ).catch(() => null);
  if (!rows) return { kind: 'query_rules', severity: 'info', caveat: false, title: 'Could not read business rules (sys_script)', detail: '', items: [] };
  if (!rows.length) return null;
  const items = rows.map((r) => ({
    name: r.name || '(no name)',
    link: { table: 'sys_script', sysId: r.sys_id },
    meta: [`on ${r.collection}`, r.order && `order ${r.order}`, r['sys_scope.scope'] && r['sys_scope.scope'] !== 'global' && r['sys_scope.scope']].filter(Boolean).join(' · '),
    condition: [r.filter_condition && explainQuery(r.filter_condition, { table: r.collection }), r.condition && `Condition: ${r.condition}`].filter(Boolean).join('\n'),
    script: r.script ? scriptExcerpt(r.script) : '',
  }));
  const names = items.map((i) => i.name);
  const read = operation === 'read' || operation === 'report_view';
  return {
    kind: 'query_rules',
    severity: read ? 'warn' : 'info',
    caveat: read,
    title: `${items.length} before-query business rule${items.length === 1 ? '' : 's'} can filter records out: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ', ...' : ''}`,
    detail: 'They add conditions to every query on the table, so a record can be invisible even when ACLs allow it. Check their conditions for this user.',
    items,
  };
}

function domainSection(user, record) {
  if (!record || !record.sys_domain) return null;
  const recordDomain = v(record.sys_domain);
  if (!recordDomain || recordDomain === 'global' || recordDomain === user.domainId) return null;
  return {
    kind: 'domain',
    severity: 'warn',
    caveat: true,
    title: `The record is in domain ${d(record.sys_domain)}, the user is in ${user.domain || 'global'}`,
    detail: 'With domain separation, a user sees records in their own domain, the domains below it, and global. Check the domain hierarchy.',
    items: [],
  };
}

async function policySections(hierarchy, field, fieldInfo) {
  const sections = [];
  if (fieldInfo?.readOnly) {
    sections.push({
      kind: 'dictionary',
      severity: 'warn',
      caveat: true,
      title: `${field} is read-only in the dictionary`,
      detail: 'Nobody can edit it on the form, whatever the ACLs say. A dictionary override on a child table can change this.',
      items: [],
    });
  }
  const tables = hierarchy.join(',');

  const uiCols = await columnsOf('sys_ui_policy_action', ['table', 'field', 'disabled', 'ui_policy']);
  if (uiCols && uiCols.has('field') && uiCols.has('disabled') && uiCols.has('ui_policy')) {
    const tableCond = uiCols.has('table') ? `tableIN${tables}` : `ui_policy.tableIN${tables}`;
    const rows = await queryTable('sys_ui_policy_action', `${tableCond}^field=${field}^disabled=true`, ['sys_id', 'ui_policy', 'ui_policy.short_description', 'ui_policy.active', 'ui_policy.conditions', 'ui_policy.table'], { limit: LIMITS.policies }).catch(() => []);
    const items = rows
      .filter((r) => r.ui_policy && r['ui_policy.active'] !== 'false')
      .map((r) => ({
        name: r['ui_policy.short_description'] || 'UI policy',
        link: { table: 'sys_ui_policy', sysId: r.ui_policy },
        meta: r['ui_policy.table'] ? `on ${r['ui_policy.table']}` : '',
        condition: r['ui_policy.conditions'] ? explainQuery(r['ui_policy.conditions'], { table: r['ui_policy.table'] }) : 'Always (no condition).',
      }));
    if (items.length) {
      sections.push({
        kind: 'ui_policies',
        severity: 'warn',
        caveat: true,
        title: `${items.length} UI polic${items.length === 1 ? 'y makes' : 'ies make'} ${field} read-only on the form`,
        detail: 'Only on the form and only while the policy condition is true. Page X-ray shows the live form state.',
        items,
      });
    }
  }

  const dpCols = await columnsOf('sys_data_policy_rule', ['table', 'field', 'disabled', 'sys_data_policy']);
  if (dpCols && dpCols.has('table') && dpCols.has('field') && dpCols.has('disabled') && dpCols.has('sys_data_policy')) {
    const rows = await queryTable('sys_data_policy_rule', `tableIN${tables}^field=${field}^disabled=true`, ['sys_id', 'table', 'sys_data_policy', 'sys_data_policy.short_description', 'sys_data_policy.active', 'sys_data_policy.conditions'], { limit: LIMITS.policies }).catch(() => []);
    const items = rows
      .filter((r) => r.sys_data_policy && r['sys_data_policy.active'] !== 'false')
      .map((r) => ({
        name: r['sys_data_policy.short_description'] || 'Data policy',
        link: { table: 'sys_data_policy2', sysId: r.sys_data_policy },
        meta: r.table ? `on ${r.table}` : '',
        condition: r['sys_data_policy.conditions'] ? explainQuery(r['sys_data_policy.conditions'], { table: r.table }) : 'Always (no condition).',
      }));
    if (items.length) {
      sections.push({
        kind: 'data_policies',
        severity: 'warn',
        caveat: true,
        title: `${items.length} data polic${items.length === 1 ? 'y makes' : 'ies make'} ${field} read-only`,
        detail: 'Data policies apply on the server too (forms, imports, web services) while their condition is true.',
        items,
      });
    }
  }
  if (!uiCols || !dpCols) {
    sections.push({ kind: 'policies_unknown', severity: 'info', caveat: false, title: 'UI and data policies could not be checked (the dictionary is not readable)', detail: '', items: [] });
  }
  return sections;
}

function scopeSection(tableRow) {
  const scope = tableRow['sys_scope.scope'];
  if (!scope || scope === 'global') return null;
  const can = [
    ['read_access', 'read'],
    ['create_access', 'create'],
    ['update_access', 'update'],
    ['delete_access', 'delete'],
  ].filter(([col]) => col in tableRow);
  const allowed = can.filter(([col]) => tableRow[col] === 'true').map(([, label]) => label);
  const parts = [];
  if ('access' in tableRow) parts.push(`Accessible from: ${tableRow.access === 'public' ? 'all application scopes' : 'this application scope only'}.`);
  if (can.length) parts.push(`Other scopes can: ${allowed.length ? allowed.join(', ') : 'nothing'}.`);
  parts.push('These settings limit scripts in other scopes, not people.');
  return {
    kind: 'scope',
    severity: 'info',
    caveat: false,
    title: `The table belongs to the ${tableRow['sys_scope.name'] || scope} application (${scope})`,
    detail: parts.join(' '),
    items: [],
  };
}

/** The Access Analyzer module, when the instance has one. */
async function findAccessAnalyzer() {
  const rows = await queryTable('sys_app_module', 'title=Access Analyzer^active=true', ['sys_id', 'title', 'link_type', 'query', 'name'], { limit: 3 }).catch(() => []);
  const row = rows[0];
  if (!row) return null;
  const type = String(row.link_type || '').toUpperCase();
  const path = String(row.query || '').trim().replace(/^\/+/, '');
  let url = '';
  if ((type === 'DIRECT' || type === 'URL') && /^[a-z0-9_\-./]+(\?[^\s"'<>]*)?$/i.test(path) && !path.includes('..')) url = `/${path}`;
  else if (type === 'LIST' && isName(row.name)) url = `/${row.name}_list.do`;
  return { title: row.title || 'Access Analyzer', url };
}

// ---- Public API ------------------------------------------------------------------------------

/**
 * Explain whether a user can perform an operation on a table / record / field.
 *
 * @param {object} args
 * @param {string} [args.user]       sys_id, user name, email or exact name; empty or "me" = the logged-in user
 * @param {string} args.table
 * @param {string} [args.sysId]      the record (optional)
 * @param {string} [args.field]      a column (optional)
 * @param {string} [args.operation]  read | write | create | delete | report_view | report_on (default read)
 * @param {boolean} [args.full]      also return the full trace (the panel uses it)
 * @returns {Promise<{verdict, trace, text, full?}>} trace is a compact JSON summary; text is plain text.
 */
export async function explainAccess({ user = '', table = '', sysId = '', field = '', operation = 'read', full = false } = {}) {
  table = String(table || '').trim();
  field = String(field || '').trim();
  sysId = String(sysId || '').trim();
  operation = String(operation || 'read').trim().toLowerCase();
  if (!isName(table)) throw new Error('Enter a valid table name.');
  if (field && !isName(field)) throw new Error('Enter a valid field name.');
  if (sysId && !isSysId(sysId)) throw new Error('The record id must be a 32-character sys_id.');
  if (!OPERATIONS.includes(operation)) throw new Error(`Operation must be one of: ${OPERATIONS.join(', ')}.`);
  // Validated before any request, so a bad term never reaches the instance.
  const userTerm = safeQueryTerm(user, 'User');

  const meId = await currentUserId().catch(() => '');
  const [subject, tableRows, tableFields, defaultModeRows, analyzer] = await Promise.all([
    resolveUser(userTerm, meId),
    queryTable('sys_db_object', `name=${table}`, ['sys_id', 'name', 'label', 'sys_scope.scope', 'sys_scope.name', 'access', 'read_access', 'create_access', 'update_access', 'delete_access'], { limit: 1 }),
    fetchTableFields(table),
    queryTable('sys_properties', 'name=glide.sm.default_mode', ['value'], { limit: 1 }).catch(() => []),
    findAccessAnalyzer(),
  ]);
  const tableRow = tableRows[0];
  if (!tableRow) throw new Error(`No table called "${table}" was found (or you cannot read sys_db_object).`);
  const hierarchy = tableFields.tables;
  const knownFields = new Set(tableFields.fields.map((f) => f.name));
  const fieldInfo = field ? tableFields.fields.find((f) => f.name === field) : null;
  if (field && !fieldInfo) throw new Error(`The table ${table} has no field called "${field}".`);

  const recordWanted = sysId && operation !== 'create';
  const [aclData, roleData, recordRows, queryRules, policies] = await Promise.all([
    fetchAcls(aclCandidateNames(hierarchy, field), operation),
    fetchRoleData(subject.sysId),
    recordWanted ? queryTable(table, `sys_id=${sysId}`, ['sys_id', 'sys_domain', 'number', 'name', 'short_description'], { limit: 1, displayValue: true }).catch(() => []) : [],
    queryRulesSection(hierarchy, operation),
    field && (operation === 'write' || operation === 'create') ? policySections(hierarchy, field, fieldInfo) : [],
  ]);
  const record = recordRows[0] || null;

  const elevated = await fetchElevated([
    ...(roleData.assigned || []).map((a) => a.roleId),
    ...roleData.groupRoles.map((r) => r.roleId),
    ...roleData.contains.map((c) => c.childId),
    ...aclData.acls.flatMap((a) => a.roleIds || []),
  ]);
  const roles = resolveRoles({ ...roleData, elevated });

  const relevant = aclData.acls.filter((a) => a.active && (a.operation === operation || (operation === 'create' && a.operation === 'write')));
  let checks = { conditionChecks: {}, appliesChecks: {} };
  if (record) checks = await runConditionChecks({ table, sysId, acls: relevant, knownFields });
  else {
    const reason = operation === 'create' ? 'Checked against the new record at runtime.' : sysId ? 'The record could not be read, so this is checked at runtime.' : 'No record chosen, so this is checked at runtime.';
    relevant.forEach((a) => {
      if (a.condition) checks.conditionChecks[a.sysId] = reason;
      if (a.appliesTo) checks.appliesChecks[a.sysId] = reason;
    });
  }

  const others = [];
  if (recordWanted && !record) {
    others.push({ kind: 'record', severity: 'warn', caveat: false, title: 'The record was not found, or you cannot read it', detail: 'Conditions were not checked against it.', items: [] });
  }
  if (queryRules) others.push(queryRules);
  const domain = domainSection(subject, record);
  if (domain) others.push(domain);
  others.push(...policies);
  const scope = scopeSection(tableRow);
  if (scope) others.push(scope);
  if (operation === 'write' && !field) {
    others.push({ kind: 'hint', severity: 'info', caveat: false, title: 'Field ACLs can still make single fields read-only', detail: 'Pick a field to check it.', items: [] });
  }

  const defaultMode = String(defaultModeRows[0]?.value || '').trim().toLowerCase();
  const trace = evaluateAccess({
    operation,
    table,
    hierarchy,
    field,
    sysId: recordWanted ? sysId : '',
    hasRecord: Boolean(record),
    user: subject,
    roles,
    groups: roleData.groups,
    acls: aclData.acls,
    conditionChecks: checks.conditionChecks,
    appliesChecks: checks.appliesChecks,
    defaultMode,
    elevatedRoles: elevated,
    others,
  });
  trace.notes = [...aclData.notes, ...roleData.notes];
  if (!defaultMode) trace.notes.push('glide.sm.default_mode could not be read.');
  trace.record = record ? { label: d(record.number) || d(record.name) || d(record.short_description) || sysId } : null;
  trace.verify = { canRunAsMe: subject.isMe, analyzer };

  const result = { verdict: trace.verdict, trace: compactTrace(trace), text: formatTraceText(trace) };
  if (full) result.full = trace;
  return result;
}

/**
 * Ask the platform directly (GlideRecord can* checks in a read-only background script).
 * Runs as the logged-in user, so it refuses any other user. Needs the admin role.
 */
export async function accessRuntimeCheck({ userId = '', table = '', sysId = '', field = '' } = {}) {
  const meId = await currentUserId();
  if (userId && userId !== meId) {
    throw new Error('The runtime check runs as you, so it only works for your own user. For someone else, impersonate them or use the Access Analyzer.');
  }
  const script = buildRuntimeCheckScript({ table, sysId, field });
  let html;
  try {
    html = await runBackgroundScript(script, await getSessionToken());
  } catch (err) {
    // A refusal can also mean the table is private to its scope: the check always runs in global.
    throw new Error(/not authorized|scope/i.test(err.message) ? `${err.message} ${RUNTIME_SCOPE_HINT}` : err.message);
  }
  const result = parseRuntimeCheckOutput(extractScriptOutput(html));
  if (result.ok && result.userId && result.userId !== meId) {
    return { ok: false, error: `The check ran as ${result.user}, not as the user being checked.` };
  }
  return result;
}

/** Typeahead: users by name, user name or email. */
export async function accessSearchUsers(term) {
  let t;
  try {
    t = safeQueryTerm(term, 'User');
  } catch {
    return []; // Not a name: nothing to suggest, and nothing is sent to the instance.
  }
  if (t.length < 2) return [];
  const rows = await queryTable('sys_user', `nameLIKE${t}^ORuser_nameSTARTSWITH${t}^ORemailSTARTSWITH${t}^ORDERBYname`, ['sys_id', 'name', 'user_name', 'email', 'active'], { limit: LIMITS.users });
  return rows.map((r) => ({ sysId: r.sys_id, name: r.name, userName: r.user_name, email: r.email, active: r.active !== 'false' }));
}

/** Typeahead: tables by name or label. */
export async function accessSearchTables(term) {
  let t;
  try {
    t = safeQueryTerm(term, 'Table');
  } catch {
    return [];
  }
  if (!t) return [];
  return (await searchTables(t, 10)).map((x) => ({ name: x.name, label: x.label }));
}

/** Field choices for a table, including inherited fields. */
export async function accessTableFields(table) {
  const { fields } = await fetchTableFields(String(table || '').trim());
  return fields.map((f) => ({ name: f.name, label: f.label || f.name, type: f.type })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The logged-in user, for the panel's default. */
export async function accessCurrentUser() {
  const id = await currentUserId();
  const rows = await queryTable('sys_user', `sys_id=${id}`, ['sys_id', 'name', 'user_name', 'email'], { limit: 1 });
  const row = rows[0] || { sys_id: id };
  return { sysId: row.sys_id, name: row.name || '', userName: row.user_name || '', email: row.email || '' };
}

export const accessServices = {
  explainAccess,
  accessRuntimeCheck,
  accessSearchUsers,
  accessSearchTables,
  accessTableFields,
  accessCurrentUser,
};
