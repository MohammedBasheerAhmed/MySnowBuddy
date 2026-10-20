// Access debugger: a pure model of how ServiceNow decides whether a user may read, write,
// create or delete a record or a field. src/content/accessDebugger.js fetches the data;
// everything here is deterministic so it can be unit-tested without an instance.
//
// Model (record ACLs, the classic "Allow-If" rules, plus "Deny-Unless" on releases that have them):
// - Two levels: the table (row) level and, when a field is asked about, the field level.
//   Both must pass. Table level is checked first; a field ACL never rescues a failed table.
// - Table level names, most specific first: table, each parent table, then "*".
// - Field level names: table.field, parent.field, *.field, table.*, parent.*, *.*.
// - Allow-If: only the most specific name that has at least one matching ACL is used.
//   Within it, ONE passing ACL is enough (OR). Less specific names are not looked at.
// - Deny-Unless (assumption, see docs/decisions.md): every matching Deny-Unless ACL at the
//   level must pass; a failing one denies access whatever the Allow-If ACLs say.
// - One ACL passes when its role check, condition and script all pass (AND). Roles: the user
//   needs ANY one of the listed roles. admin_overrides lets admin users pass the ACL outright,
//   and admin inherits every role that is not an elevated privilege (e.g. security_admin).
// - No matching table ACL: glide.sm.default_mode decides (deny: only admins). No matching
//   field ACL: the field follows the table result.

import { explainQuery } from './query.js';
import { assertNoInlineScript } from './queryGuard.js';

export const OPERATIONS = ['read', 'write', 'create', 'delete', 'report_view', 'report_on'];
export const OPERATION_LABELS = {
  read: 'read',
  write: 'write',
  create: 'create',
  delete: 'delete',
  report_view: 'view report data on',
  report_on: 'report on',
};
// Reporting operations: what the platform does when no ACL for them matches (fall back to read?
// to the default mode?) is not modelled, so "no match" is reported as uncertain, never as denied.
const REPORT_OPS = new Set(['report_view', 'report_on']);

const NAME_RE = /^[a-z0-9_]+$/i;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const MAX_PATHS = 3;
const MAX_DEPTH = 10;
const EXCERPT_LINES = 14;
const EXCERPT_CHARS = 700;

export const isSysId = (value) => SYS_ID_RE.test(String(value || '').trim());
export const isName = (value) => NAME_RE.test(String(value || '').trim());

// Names, user names, emails and table labels never need "=", ":", "^" or a "javascript" word.
// "+" is kept for emails such as abel+test@example.com (harmless: the query string is URL-encoded).
const SAFE_TERM_RE = /^[\p{L}\p{M}\p{N} ._@'+-]*$/u;

/**
 * Free text that is about to go into an encoded query (user name, email, name, table label).
 * ServiceNow runs a value that starts with "javascript:" as script, so anything beyond plain
 * name characters is refused. Returns the trimmed term (max 80 characters).
 */
export function safeQueryTerm(text, label = 'Search text') {
  const term = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  assertNoInlineScript(term, label);
  if (/javascript/i.test(term) || !SAFE_TERM_RE.test(term)) {
    throw new Error(`${label} can only contain letters, digits, spaces and . _ @ ' + -`);
  }
  return term;
}

const VERB_ALIASES = { see: 'read', view: 'read', edit: 'write', update: 'write', change: 'write', insert: 'create', remove: 'delete', report: 'report_on' };

/**
 * Slash-command arguments: "/why abel.tuter write short_description", "/why "Abel Tuter" delete",
 * "/access me read <sys_id>". Words: user first, then a field; quotes keep a name together.
 */
export function parseAccessArgs(text) {
  const out = { user: '', operation: '', field: '', sysId: '' };
  const tokens = [...String(text || '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? m[3]).trim()).filter(Boolean);
  const words = [];
  tokens.forEach((tok) => {
    const lower = tok.toLowerCase();
    if (!out.operation && (OPERATIONS.includes(lower) || VERB_ALIASES[lower])) out.operation = OPERATIONS.includes(lower) ? lower : VERB_ALIASES[lower];
    else if (!out.sysId && isSysId(tok)) out.sysId = lower;
    else words.push(tok);
  });
  if (words[0]) out.user = words[0];
  if (words[1] && isName(words[1])) out.field = words[1];
  return out;
}

// ---- Candidate ACL names --------------------------------------------------------------------

/** Table-level ACL names in evaluation order: the table, its parents, then "*". */
export function tableTierNames(hierarchy) {
  return [...unique(hierarchy.filter(Boolean)), '*'];
}

/** Field-level ACL names in evaluation order. */
export function fieldTierNames(hierarchy, field) {
  if (!field) return [];
  const tables = unique(hierarchy.filter(Boolean));
  return [...tables.map((t) => `${t}.${field}`), `*.${field}`, ...tables.map((t) => `${t}.*`), '*.*'];
}

/** Every ACL name that can apply to the table (and field). */
export function aclCandidateNames(hierarchy, field = '') {
  return unique([...tableTierNames(hierarchy), ...fieldTierNames(hierarchy, field)]);
}

function unique(list) {
  return [...new Set(list)];
}

// ---- Three-valued logic ------------------------------------------------------------------------
// 'pass' | 'fail' | 'unknown' (decided at runtime: a script, a dynamic condition...).

export function and3(statuses) {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('unknown')) return 'unknown';
  return 'pass';
}

export function or3(statuses) {
  if (statuses.includes('pass')) return 'pass';
  if (statuses.includes('unknown')) return 'unknown';
  return 'fail';
}

// ---- Roles -----------------------------------------------------------------------------------

/**
 * Effective roles of a user and how each one was obtained.
 *
 * @param {object} input
 * @param {Array<{role:string, roleId?:string}>} input.direct  roles assigned to the user directly
 * @param {Array<{group:string, groupId?:string, role:string, roleId?:string, inherits?:boolean, groupActive?:boolean}>} input.groupRoles
 * @param {Array<{parent:string, child:string, childId?:string}>} input.contains  role containment edges (sys_user_role_contains)
 * @param {Array<{role:string, roleId?:string, active?:boolean, grantedBy?:string, includedIn?:string}>|null} input.assigned
 *   rows of sys_user_has_role (the platform's own flattened list). When given it is authoritative:
 *   computed roles missing from it are reported as unconfirmed, and extra rows are added.
 * @param {boolean} [input.assignedComplete] false when `assigned` was cut off at a query limit: computed roles are then kept.
 * @param {Iterable<string>} input.elevated  names of elevated-privilege roles
 * @returns {{roles: Array<{name, id, elevated, paths: Array<Array<{kind, name, id}>>}>, unconfirmed: string[]}}
 */
export function resolveRoles({ direct = [], groupRoles = [], contains = [], assigned = null, assignedComplete = true, elevated = [] } = {}) {
  const elevatedSet = new Set(elevated);
  const children = new Map();
  contains.forEach((e) => {
    if (!e.parent || !e.child) return;
    if (!children.has(e.parent)) children.set(e.parent, []);
    children.get(e.parent).push({ name: e.child, id: e.childId || '' });
  });

  const found = new Map(); // name -> { name, id, paths }
  const queue = [];
  direct.forEach((r) => r.role && queue.push({ name: r.role, id: r.roleId || '', path: [{ kind: 'direct', name: 'direct' }] }));
  groupRoles.forEach((g) => {
    if (!g.role || g.inherits === false || g.groupActive === false) return;
    queue.push({ name: g.role, id: g.roleId || '', path: [{ kind: 'group', name: g.group || 'a group', id: g.groupId || '' }] });
  });

  let steps = 0;
  while (queue.length && steps < 20000) {
    steps += 1;
    const item = queue.shift();
    const entry = found.get(item.name) || { name: item.name, id: item.id, paths: [] };
    if (!entry.id && item.id) entry.id = item.id;
    found.set(item.name, entry);
    if (entry.paths.length >= MAX_PATHS) continue;
    entry.paths.push(item.path);
    const roleNodes = item.path.filter((n) => n.kind === 'role').length;
    if (roleNodes >= MAX_DEPTH) continue;
    (children.get(item.name) || []).forEach((child) => {
      // No cycles: a role never appears twice in one path.
      if (child.name === item.name || item.path.some((n) => n.kind === 'role' && n.name === child.name)) return;
      queue.push({ name: child.name, id: child.id, path: [...item.path, { kind: 'role', name: item.name, id: item.id }] });
    });
  }

  const unconfirmed = [];
  if (Array.isArray(assigned)) {
    const active = assigned.filter((a) => a.role && a.active !== false);
    const names = new Set(active.map((a) => a.role));
    // A truncated sys_user_has_role list cannot prove a role is missing, so nothing is dropped then.
    [...found.keys()].forEach((name) => {
      if (assignedComplete && !names.has(name)) {
        unconfirmed.push(name);
        found.delete(name);
      }
    });
    active.forEach((a) => {
      if (found.has(a.role)) return;
      const via = a.grantedBy ? { kind: 'group', name: a.grantedBy, id: a.grantedById || '' } : a.includedIn ? { kind: 'role', name: a.includedIn, id: '' } : { kind: 'assigned', name: 'assigned' };
      found.set(a.role, { name: a.role, id: a.roleId || '', paths: [[via]] });
    });
  }

  const roles = [...found.values()]
    .map((r) => ({ ...r, elevated: elevatedSet.has(r.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { roles, unconfirmed: unconfirmed.sort() };
}

/** "direct", "group Service Desk", "group Service Desk > itil" (the group grants itil, which contains the role). */
export function pathLabel(path) {
  return (path || [])
    .map((n) => {
      if (n.kind === 'direct') return 'direct';
      if (n.kind === 'group') return `group ${n.name}`;
      if (n.kind === 'assigned') return 'assigned';
      return n.name;
    })
    .join(' > ');
}

// ---- One ACL ---------------------------------------------------------------------------------

const check = (status, detail, extra = {}) => ({ status, detail, ...extra });

/** Role check for one ACL. `ctx` = { roleIndex: Map(name -> role), isAdmin, external, elevated: Set }. */
export function checkRoles(required, ctx) {
  const needed = unique((required || []).filter(Boolean));
  if (!needed.length) {
    if (ctx.external) {
      return check('unknown', 'No role required. External users (snc_external) usually fail ACLs without a role when Explicit Roles is active.');
    }
    return check('pass', 'No role required.');
  }
  const held = needed.filter((r) => ctx.roleIndex.has(r));
  const plain = held.find((r) => !ctx.elevated.has(r));
  if (plain) {
    const role = ctx.roleIndex.get(plain);
    return check('pass', `Has ${plain} (${pathLabel(role.paths[0])}).`, { role: plain });
  }
  if (ctx.isAdmin) {
    // admin inherits every role except elevated privileges and the ServiceNow-only maint role.
    const inheritable = needed.find((r) => !ctx.elevated.has(r) && r !== 'maint');
    if (inheritable) return check('pass', `Has admin, which inherits ${inheritable}.`, { role: inheritable });
  }
  if (needed.includes('snc_internal') && !ctx.external) {
    return check('pass', 'Needs snc_internal, which every internal user has.', { role: 'snc_internal' });
  }
  if (held.length) {
    return check('unknown', `Has ${held[0]}, an elevated role: it counts only while elevated in the session.`, { role: held[0] });
  }
  return check('fail', `Needs one of: ${needed.join(', ')}. The user has none of them.`);
}

/** Strip comments and whitespace so trivial scripts ("answer = true;") can be recognised. */
function normaliseScript(script) {
  return String(script || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function scriptExcerpt(script) {
  const text = String(script || '').replace(/\r\n/g, '\n').trim();
  const lines = text.split('\n');
  let out = lines.slice(0, EXCERPT_LINES).join('\n');
  if (out.length > EXCERPT_CHARS) out = `${out.slice(0, EXCERPT_CHARS)}...`;
  else if (lines.length > EXCERPT_LINES) out += `\n... (${lines.length - EXCERPT_LINES} more lines)`;
  return out;
}

export function checkScript(acl) {
  const script = String(acl.script || '');
  if (!script.trim()) return check('pass', 'No script.');
  if (acl.advanced === false) return check('pass', 'Has a script, but Advanced is off, so it is not used.', { excerpt: scriptExcerpt(script) });
  const plain = normaliseScript(script);
  if (/^answer\s*=\s*true\s*;?$/.test(plain)) return check('pass', 'Script always sets answer = true.', { excerpt: scriptExcerpt(script) });
  if (/^answer\s*=\s*false\s*;?$/.test(plain)) return check('fail', 'Script always sets answer = false.', { excerpt: scriptExcerpt(script) });
  return check('unknown', 'Script runs at runtime.', { excerpt: scriptExcerpt(script) });
}

export function checkCondition(acl, table, checks = {}) {
  const condition = String(acl.condition || '').trim();
  if (!condition) return check('pass', 'No condition.');
  const text = explainQuery(condition, { table });
  const known = checks[acl.sysId];
  if (known === true) return check('pass', 'The record matches the condition.', { text, query: condition });
  if (known === false) return check('fail', 'The record does not match the condition.', { text, query: condition });
  const why = typeof known === 'string' ? known : 'Checked at runtime against the record.';
  return check('unknown', why, { text, query: condition });
}

/**
 * Evaluate one ACL for the user.
 * @returns {{status, applies: boolean, admin: boolean, checks: {roles, condition, script, appliesTo?, attribute?}}}
 */
export function evaluateAcl(acl, ctx, table) {
  const roles = checkRoles(acl.roles, ctx);
  const condition = checkCondition(acl, table, ctx.conditionChecks);
  const script = checkScript(acl);
  const checks = { roles, condition, script };

  let applies = true;
  const appliesTo = String(acl.appliesTo || '').trim();
  if (appliesTo) {
    const known = ctx.appliesChecks?.[acl.sysId];
    const text = explainQuery(appliesTo, { table });
    if (known === false) applies = false;
    checks.appliesTo =
      known === true
        ? check('pass', 'The record is one this ACL applies to.', { text, query: appliesTo })
        : known === false
          ? check('pass', 'Does not apply to this record, so it is ignored.', { text, query: appliesTo })
          : check('unknown', typeof known === 'string' ? known : 'Applies only to some records (checked at runtime).', { text, query: appliesTo });
  }
  if (acl.securityAttribute) {
    checks.attribute = check('unknown', `Security attribute "${acl.securityAttribute}" is checked at runtime.`);
  }

  const admin = Boolean(acl.adminOverrides && ctx.isAdmin);
  const status = admin ? 'pass' : and3(Object.values(checks).map((c) => c.status));
  return { status, applies, admin, checks };
}

// ---- A level (table or field) -----------------------------------------------------------------

function aclMatches(acl, operation) {
  const type = String(acl.type || 'record').toLowerCase();
  return type === 'record' && String(acl.operation || '').toLowerCase() === operation;
}

function summariseAcl(acl, result) {
  return {
    sysId: acl.sysId,
    name: acl.name,
    operation: acl.operation,
    decision: acl.decision === 'deny' ? 'deny' : 'allow',
    adminOverrides: Boolean(acl.adminOverrides),
    roles: acl.roles || [],
    description: acl.description || '',
    scope: acl.scope || '',
    ...result,
  };
}

/**
 * Evaluate one level.
 * @param {'table'|'field'} level
 * @param {string[]} tierNames  ACL names in evaluation order
 */
export function evaluateLevel(level, tierNames, acls, ctx) {
  const { operation, table, defaultMode } = ctx;
  const tiers = tierNames.map((name) => ({ name, allow: [], deny: [], ignored: [], decides: false, skipped: false }));
  const byName = new Map(tiers.map((t) => [t.name, t]));

  acls.forEach((acl) => {
    const tier = byName.get(acl.name);
    if (!tier || acl.active === false || !aclMatches(acl, operation)) return;
    const row = summariseAcl(acl, evaluateAcl(acl, ctx, table));
    if (!row.applies) tier.ignored.push(row);
    else if (row.decision === 'deny') tier.deny.push(row);
    else tier.allow.push(row);
  });

  const denyRows = tiers.flatMap((t) => t.deny);
  const denyStatus = denyRows.length ? and3(denyRows.map((r) => r.status)) : 'pass';

  const decidingIndex = tiers.findIndex((t) => t.allow.length);
  const none = denyRows.length ? 'No Allow-If ACL matches' : 'No ACL matches';
  let allowStatus;
  let note = '';
  if (decidingIndex >= 0) {
    const tier = tiers[decidingIndex];
    tier.decides = true;
    tiers.slice(decidingIndex + 1).forEach((t) => {
      t.skipped = true;
    });
    allowStatus = or3(tier.allow.map((r) => r.status));
    note =
      tier.allow.length > 1
        ? `${tier.allow.length} ACLs on ${tier.name}: one passing is enough.`
        : `Decided by the ACL on ${tier.name}.`;
  } else if (REPORT_OPS.has(operation)) {
    allowStatus = 'unknown';
    note = `${none} for ${operation}. What the platform does then (fall back to other ACLs or the default mode) is not modelled here, so check it at runtime.`;
  } else if (level === 'field') {
    allowStatus = 'pass';
    note = `${none} on the field, so the field follows the record-level result.`;
  } else if (defaultMode === 'deny') {
    allowStatus = ctx.isAdmin ? 'pass' : 'fail';
    note = `${none}. glide.sm.default_mode is "deny", so only admins get access.`;
  } else if (defaultMode === 'allow') {
    allowStatus = 'pass';
    note = `${none}. glide.sm.default_mode is "allow", so access is granted.`;
  } else {
    allowStatus = 'unknown';
    note = `${none}. The result depends on glide.sm.default_mode (deny on most instances), which could not be read.`;
  }

  if (denyRows.length) {
    note += ` ${denyRows.length === 1 ? 'A Deny-Unless ACL' : `${denyRows.length} Deny-Unless ACLs`} must also pass.`;
  }

  const status = and3([denyStatus, allowStatus]);
  return {
    level,
    status,
    allowStatus,
    denyStatus,
    noMatch: decidingIndex < 0,
    decidingTier: decidingIndex >= 0 ? tiers[decidingIndex].name : '',
    note,
    tiers,
  };
}

// ---- Whole trace -----------------------------------------------------------------------------

function inactiveFor(acls, names, operation) {
  const set = new Set(names);
  return acls
    .filter((a) => set.has(a.name) && a.active === false && aclMatches(a, operation))
    .map((a) => ({ sysId: a.sysId, name: a.name, operation: a.operation, decision: a.decision === 'deny' ? 'deny' : 'allow' }));
}

/** ACLs for other operations on the same names that commonly explain "I can read it but the list is empty" etc. */
function relatedFor(acls, names, operation) {
  const set = new Set(names);
  const interesting = operation === 'read' ? ['query_range', 'query_match'] : [];
  return acls
    .filter((a) => set.has(a.name) && a.active !== false && interesting.includes(String(a.operation).toLowerCase()))
    .map((a) => ({ sysId: a.sysId, name: a.name, operation: a.operation, roles: a.roles || [] }));
}

/** The ACLs behind a level's result: failing ones for a denial, runtime ones for "depends", passing ones for "allowed". */
function deciders(level, status) {
  if (!level) return [];
  const rows = [];
  // A Deny-Unless ACL only decides by failing (or by being undecided); passing it grants nothing.
  if (status !== 'pass' && level.denyStatus === status) {
    level.tiers.forEach((t) => t.deny.forEach((r) => r.status === status && rows.push(r)));
  }
  const tier = level.tiers.find((t) => t.decides);
  if (tier && level.allowStatus === status) tier.allow.forEach((r) => r.status === status && rows.push(r));
  return rows.map((r) => ({ sysId: r.sysId, name: r.name, decision: r.decision, level: level.level, detail: runtimeDetail(r) }));
}

/** First check of an ACL that is not a plain pass, e.g. "Script runs at runtime." */
function runtimeDetail(row) {
  const pending = Object.values(row.checks || {}).find((c) => c.status !== 'pass');
  return pending ? pending.detail : '';
}

function failReason(level, what) {
  if (level.denyStatus === 'fail') {
    const failing = level.tiers.flatMap((t) => t.deny).filter((r) => r.status === 'fail');
    return `Deny-Unless ACL ${failing.map((r) => r.name).join(', ')} fails for ${what}.`;
  }
  if (level.noMatch) return level.note;
  const tier = level.tiers.find((t) => t.decides);
  const count = tier.allow.length;
  return count === 1
    ? `The only ${what} ACL that applies (${tier.name}) does not pass.`
    : `None of the ${count} ${what} ACLs on ${tier.name} passes.`;
}

/**
 * Build the full trace.
 *
 * @param {object} input
 * @param {string} input.operation   read | write | create | delete | report_view | report_on
 * @param {string} input.table
 * @param {string[]} input.hierarchy table first, then its parents
 * @param {string} [input.field]
 * @param {boolean} [input.hasRecord]
 * @param {object} input.user        { sysId, name, userName, email, active, lockedOut, domain }
 * @param {object} input.roles       result of resolveRoles()
 * @param {Array} [input.groups]     [{ name, sysId, active }]
 * @param {Array} input.acls         [{ sysId, name, operation, type, active, decision, adminOverrides, roles, condition, script, advanced, appliesTo, securityAttribute }]
 * @param {object} [input.conditionChecks] sysId -> true | false | 'reason it is unknown'
 * @param {object} [input.appliesChecks]   sysId -> true | false | 'reason'
 * @param {string} [input.defaultMode]     'deny' | 'allow' | ''
 * @param {Array} [input.others]           other reasons, from the data layer: [{ kind, severity, title, detail, caveat, links }]
 */
export function evaluateAccess(input) {
  const { operation, table, hierarchy = [table], field = '', user = {}, acls = [], defaultMode = '', others = [] } = input;
  if (!OPERATIONS.includes(operation)) throw new Error(`Unknown operation "${operation}".`);
  const roleResult = input.roles || { roles: [], unconfirmed: [] };
  const roleIndex = new Map(roleResult.roles.map((r) => [r.name, r]));
  const elevated = new Set([...roleResult.roles.filter((r) => r.elevated).map((r) => r.name), ...(input.elevatedRoles || [])]);
  const isAdmin = roleIndex.has('admin');
  const external = roleIndex.has('snc_external') && !roleIndex.has('snc_internal');

  const ctx = {
    operation,
    table,
    defaultMode: defaultMode === 'deny' || defaultMode === 'allow' ? defaultMode : '',
    roleIndex,
    elevated,
    isAdmin,
    external,
    conditionChecks: input.conditionChecks || {},
    appliesChecks: input.appliesChecks || {},
  };

  const tableNames = tableTierNames(hierarchy);
  const fieldNames = fieldTierNames(hierarchy, field);
  const tableLevel = evaluateLevel('table', tableNames, acls, ctx);
  const fieldLevel = field ? evaluateLevel('field', fieldNames, acls, ctx) : null;
  const fallbackLevel = fieldLevel && operation === 'create' ? createFallback(fieldLevel, fieldNames, acls, ctx) : null;
  [fieldLevel, fallbackLevel].forEach((l) => {
    if (l && tableLevel.status === 'fail') l.notReached = true;
  });

  const trace = {
    request: { operation, table, field, sysId: input.sysId || '', hasRecord: Boolean(input.hasRecord) },
    hierarchy,
    user: {
      sysId: user.sysId || '',
      name: user.name || '',
      userName: user.userName || '',
      email: user.email || '',
      active: user.active !== false,
      lockedOut: Boolean(user.lockedOut),
      domain: user.domain || '',
      isAdmin,
      external,
      isMe: Boolean(user.isMe),
      roles: roleResult.roles,
      unconfirmedRoles: roleResult.unconfirmed || [],
      groups: input.groups || [],
    },
    defaultMode: ctx.defaultMode,
    levels: [tableLevel, fieldLevel, fallbackLevel].filter(Boolean),
    inactive: inactiveFor(acls, [...tableNames, ...fieldNames], operation),
    related: relatedFor(acls, [...tableNames, ...fieldNames], operation),
    others,
  };
  trace.verdict = decideVerdict(trace, tableLevel, fieldLevel, fallbackLevel);
  return trace;
}

/**
 * Field-level create with no field create ACL: the platform may fall back to the field's write
 * ACLs on insert (not confirmed). Evaluate them too; when they would not pass, the field result
 * becomes uncertain. Returns the write level to show, or null when there is nothing to show.
 */
function createFallback(fieldLevel, fieldNames, acls, ctx) {
  if (!fieldLevel.noMatch || fieldLevel.allowStatus !== 'pass') return null;
  const writeLevel = evaluateLevel('field', fieldNames, acls, { ...ctx, operation: 'write' });
  if (writeLevel.noMatch && writeLevel.denyStatus === 'pass') return null;
  const fallback = { ...writeLevel, level: 'field_write', title: 'Field write ACLs (possible fallback for create)', fallback: true };
  const deny = fieldLevel.tiers.flatMap((t) => t.deny).length;
  const denyNote = deny ? ` ${deny === 1 ? 'A Deny-Unless ACL' : `${deny} Deny-Unless ACLs`} must also pass.` : '';
  if (writeLevel.status === 'pass') {
    fieldLevel.note = `No field create ACL matches. The field write ACLs pass too, so a fallback to them would not change this.${denyNote}`;
    return fallback;
  }
  const which = writeLevel.decidingTier || 'Deny-Unless';
  fieldLevel.allowStatus = 'unknown';
  fieldLevel.status = and3([fieldLevel.denyStatus, 'unknown']);
  fieldLevel.viaFallback = true;
  fieldLevel.note = `No field create ACL matches. The platform may fall back to the field write ACLs (${which}), which ${writeLevel.status === 'fail' ? 'fail' : 'are decided at runtime'} for this user, so this is uncertain.${denyNote}`;
  return fallback;
}

function decideVerdict(trace, tableLevel, fieldLevel, fallbackLevel = null) {
  const { operation, table, field } = trace.request;
  const verb = OPERATION_LABELS[operation] || operation;
  const object = field ? `${table}.${field}` : table;
  const caveats = (trace.others || []).filter((o) => o.caveat).map((o) => o.title);

  if (!trace.user.active) {
    return { status: 'denied', title: 'Denied', reason: 'The user is inactive, so they cannot log in at all.', decidedBy: [], caveats };
  }
  if (trace.user.lockedOut) {
    return { status: 'denied', title: 'Denied', reason: 'The user is locked out, so they cannot log in at all.', decidedBy: [], caveats };
  }
  if (tableLevel.status === 'fail') {
    return { status: 'denied', title: 'Denied', reason: `Cannot ${verb} ${table} records: ${failReason(tableLevel, 'record')}`, decidedBy: deciders(tableLevel, 'fail'), caveats };
  }
  if (fieldLevel && fieldLevel.status === 'fail') {
    const lead = tableLevel.status === 'unknown' ? `Whatever the record-level result, the user cannot ${verb} ${object}` : `Can ${verb} the record but not ${object}`;
    return { status: 'denied', title: 'Denied', reason: `${lead}: ${failReason(fieldLevel, 'field')}`, decidedBy: deciders(fieldLevel, 'fail'), caveats };
  }
  if (tableLevel.status === 'unknown' || fieldLevel?.status === 'unknown') {
    const fallbackDeciders = fieldLevel?.viaFallback && fallbackLevel ? deciders(fallbackLevel, fallbackLevel.status) : [];
    const decidedBy = [...deciders(tableLevel, 'unknown'), ...deciders(fieldLevel, 'unknown'), ...fallbackDeciders];
    const names = unique(decidedBy.filter((d) => d.level !== 'field_write').map((d) => d.name));
    let reason;
    if (names.length) reason = `Decided at runtime by ${names.join(', ')}. ${decidedBy[0].detail}`.trim();
    else reason = [tableLevel, fieldLevel].find((l) => l && l.status === 'unknown').note;
    if (names.length && fieldLevel?.viaFallback) reason += ` ${fieldLevel.note}`;
    return { status: 'depends', title: 'Depends on runtime', reason, decidedBy, caveats };
  }
  const decidedBy = [...deciders(tableLevel, 'pass'), ...deciders(fieldLevel, 'pass')];
  return {
    status: 'allowed',
    title: caveats.length ? 'Allowed by ACLs' : 'Allowed',
    reason: caveats.length ? `ACLs let the user ${verb} ${object}, but something else may still block it.` : `ACLs let the user ${verb} ${object}.`,
    decidedBy,
    caveats,
  };
}

// ---- Output: plain text and a compact JSON for the AI / agent tools ----------------------------

const MARK = { pass: 'PASS', fail: 'FAIL', unknown: 'RUNTIME' };

function aclLine(row) {
  const parts = [`${row.name} [${row.decision === 'deny' ? 'deny-unless' : 'allow-if'}] ${MARK[row.status]}`];
  if (row.admin) parts.push('admin override');
  parts.push(`roles: ${row.checks.roles.detail}`);
  if (row.checks.condition.status !== 'pass' || row.checks.condition.query) parts.push(`condition: ${row.checks.condition.query || ''} (${MARK[row.checks.condition.status]})`);
  if (row.checks.script.excerpt) parts.push(`script: ${MARK[row.checks.script.status]}`);
  if (row.checks.appliesTo) parts.push(`applies to: ${row.checks.appliesTo.query} (${row.checks.appliesTo.detail})`);
  if (row.checks.attribute) parts.push(row.checks.attribute.detail);
  return parts.join('; ');
}

/** Plain-text summary, suitable for a chat message, a ticket or the agent. */
export function formatTraceText(trace) {
  const { request: req, user, verdict } = trace;
  const lines = [];
  const who = user.name ? `${user.name} (${user.userName || user.sysId})` : user.userName || user.sysId;
  lines.push(`Access check: ${who} -> ${req.operation} ${req.table}${req.field ? `.${req.field}` : ''}${req.sysId ? ` ${req.sysId}` : ''}`);
  lines.push(`Verdict: ${verdict.title}. ${verdict.reason}`);
  verdict.caveats.forEach((c) => lines.push(`  ! ${c}`));
  lines.push('');
  lines.push(`User: ${user.active ? 'active' : 'INACTIVE'}${user.lockedOut ? ', LOCKED OUT' : ''}${user.isAdmin ? ', admin' : ''}${user.external ? ', external (snc_external)' : ''}.`);
  const roleText = user.roles.slice(0, 40).map((r) => `${r.name}${r.elevated ? ' (elevated)' : ''} [${pathLabel(r.paths[0])}]`);
  lines.push(`Roles (${user.roles.length}): ${roleText.join(', ') || 'none'}${user.roles.length > 40 ? ', ...' : ''}`);
  trace.levels.forEach((level) => {
    lines.push('');
    lines.push(`${level.title || (level.level === 'table' ? 'Record level' : 'Field level')}: ${MARK[level.status]}${level.notReached ? ' (not reached: the record level already denies)' : ''}`);
    lines.push(`  ${level.note}`);
    level.tiers.forEach((tier) => {
      const rows = [...tier.deny, ...tier.allow];
      if (!rows.length && !tier.ignored.length) return;
      lines.push(`  ${tier.name}${tier.decides ? ' (decides)' : tier.skipped && tier.allow.length ? ' (not used: a more specific ACL matched)' : ''}`);
      rows.forEach((row) => lines.push(`    - ${aclLine(row)}`));
      tier.ignored.forEach((row) => lines.push(`    - ${row.name}: does not apply to this record`));
    });
  });
  if (trace.inactive.length) lines.push('', `Inactive ACLs (ignored): ${trace.inactive.map((a) => a.name).join(', ')}`);
  if (trace.others.length) {
    lines.push('', 'Other things that affect access:');
    trace.others.forEach((o) => {
      lines.push(`  - ${o.title}${o.detail ? `. ${o.detail}` : ''}`);
      (o.items || []).slice(0, 10).forEach((item) => lines.push(`      ${item.name}${item.meta ? ` (${item.meta})` : ''}`));
    });
  }
  (trace.notes || []).forEach((n) => lines.push(`Note: ${n}`));
  return lines.join('\n');
}

/** Small JSON for the AI prompt and the agent tool: no sys_ids except the record, short scripts. */
export function compactTrace(trace) {
  const acl = (row) => ({
    name: row.name,
    type: row.decision === 'deny' ? 'deny-unless' : 'allow-if',
    result: MARK[row.status],
    adminOverride: row.admin || undefined,
    roles: row.roles.length ? row.roles : undefined,
    roleCheck: row.checks.roles.detail,
    condition: row.checks.condition.query || undefined,
    conditionResult: row.checks.condition.query ? `${MARK[row.checks.condition.status]}: ${row.checks.condition.detail}` : undefined,
    script: row.checks.script.excerpt || undefined,
    scriptResult: row.checks.script.excerpt ? row.checks.script.detail : undefined,
    appliesTo: row.checks.appliesTo ? `${row.checks.appliesTo.query} (${row.checks.appliesTo.detail})` : undefined,
    securityAttribute: row.checks.attribute ? row.checks.attribute.detail : undefined,
  });
  return {
    request: trace.request,
    verdict: { status: trace.verdict.status, reason: trace.verdict.reason, decidedBy: trace.verdict.decidedBy.map((d) => d.name), caveats: trace.verdict.caveats },
    user: {
      name: trace.user.name,
      userName: trace.user.userName,
      active: trace.user.active,
      lockedOut: trace.user.lockedOut,
      admin: trace.user.isAdmin,
      external: trace.user.external,
      roles: trace.user.roles.slice(0, 60).map((r) => `${r.name}${r.elevated ? ' (elevated)' : ''} via ${pathLabel(r.paths[0])}`),
      groups: (trace.user.groups || []).slice(0, 30).map((g) => g.name),
    },
    tableHierarchy: trace.hierarchy,
    defaultMode: trace.defaultMode || 'unknown',
    levels: trace.levels.map((level) => ({
      level: level.level,
      title: level.title || undefined,
      result: MARK[level.status],
      note: level.note,
      notReached: level.notReached || undefined,
      tiers: level.tiers
        .filter((t) => t.allow.length || t.deny.length)
        .map((t) => ({ name: t.name, decides: t.decides || undefined, skipped: t.skipped || undefined, acls: [...t.deny, ...t.allow].map(acl) })),
    })),
    inactiveAcls: trace.inactive.map((a) => a.name),
    otherFactors: trace.others.map((o) => ({
      kind: o.kind,
      title: o.title,
      detail: o.detail || undefined,
      items: o.items?.length ? o.items.slice(0, 10).map((i) => ({ name: i.name, condition: i.condition || undefined, script: i.script || undefined })) : undefined,
    })),
    notes: trace.notes?.length ? trace.notes : undefined,
  };
}

// ---- Runtime check (logged-in user only) --------------------------------------------------------

export const RUNTIME_MARKER = 'MSB_ACCESS_RESULT';

/** Shown with errors that can come from the check running in the global scope. */
export const RUNTIME_SCOPE_HINT =
  'The check runs as a background script in the global scope, so a table that is private to its application scope (or that refuses cross-scope access) cannot be checked this way. Impersonate the user instead.';
const SCOPE_ERROR_RE = /scope|cross[- ]?scope|refused|not authorized/i;

/**
 * A background script that asks the platform itself whether the session user can read / write /
 * create / delete the record (and the field). It only reads: GlideRecord.get, isValid,
 * getElement and the can* checks. No insert, update, delete, setValue, initialize, property
 * or session calls (tests/access.test.js enforces this).
 */
export function buildRuntimeCheckScript({ table, sysId = '', field = '' }) {
  if (!isName(table)) throw new Error('Enter a valid table name.');
  if (sysId && !isSysId(sysId)) throw new Error('The record id must be a 32-character sys_id.');
  if (field && !isName(field)) throw new Error('Enter a valid field name.');
  const q = (s) => JSON.stringify(String(s));
  return [
    '// NowBuddy access check: read-only. Reports what the platform says the current user may do.',
    '(function () {',
    `  var table = ${q(table)}, id = ${q(sysId)}, field = ${q(field)};`,
    "  var yes = function (v) { return String(v) === 'true'; };",
    '  var out = { user: String(gs.getUserName()), userId: String(gs.getUserID()), table: table, id: id, field: field };',
    '  try {',
    '    var fresh = new GlideRecord(table);',
    '    if (!fresh.isValid()) {',
    "      out.error = 'no_table';",
    '    } else {',
    '      out.canCreate = yes(fresh.canCreate());',
    '      var rec = fresh;',
    '      if (id) {',
    '        rec = new GlideRecord(table);',
    '        out.found = yes(rec.get(id));',
    '      }',
    '      if (!id || out.found) {',
    '        out.canRead = yes(rec.canRead());',
    '        out.canWrite = yes(rec.canWrite());',
    '        out.canDelete = yes(rec.canDelete());',
    '        if (field) {',
    '          var el = rec.getElement(field);',
    '          if (el == null) {',
    '            out.fieldMissing = true;',
    '          } else {',
    '            out.fieldCanRead = yes(el.canRead());',
    '            out.fieldCanWrite = yes(el.canWrite());',
    '            if (typeof el.canCreate === "function") out.fieldCanCreate = yes(el.canCreate());',
    '          }',
    '        }',
    '      }',
    '    }',
    '  } catch (e) {',
    "    out.error = String(e && e.message ? e.message : e);",
    '  }',
    `  gs.print(${q(`${RUNTIME_MARKER} `)} + JSON.stringify(out));`,
    '})();',
  ].join('\n');
}

/** Parse the text output of the runtime check (after extractScriptOutput). */
export function parseRuntimeCheckOutput(text) {
  const output = String(text || '');
  const scopeHint = (msg) => (SCOPE_ERROR_RE.test(msg) ? `${msg} ${RUNTIME_SCOPE_HINT}` : msg);
  // The LAST real result line wins: the result page can also echo the script source, which
  // mentions the marker too (followed by a quote, not by JSON).
  const prefix = `${RUNTIME_MARKER} {`;
  const line = output
    .split('\n')
    .map((l) => l.trim().replace(/^\*\*\* Script: /, ''))
    .filter((l) => l.startsWith(prefix))
    .pop();
  if (!line) {
    const snippet = output.trim().slice(0, 300);
    return { ok: false, error: snippet ? scopeHint(`The check did not report a result. Output: ${snippet}`) : 'The check produced no output.' };
  }
  const json = line.slice(RUNTIME_MARKER.length).trim();
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, error: 'The check result could not be read.' };
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'The check result could not be read.' };
  if (data.error === 'no_table') {
    return { ok: false, error: `The table "${data.table}" could not be opened: it does not exist, or it is private to its application. ${RUNTIME_SCOPE_HINT}`, data };
  }
  if (data.error) return { ok: false, error: scopeHint(`The check failed: ${String(data.error).slice(0, 300)}`), data };
  if (data.id && data.found === false) return { ok: false, error: 'No record with that sys_id exists on the table.', data };
  if (data.fieldMissing) return { ok: false, error: `The field "${data.field}" does not exist on the table.`, data };
  const flag = (v) => (v === true || v === false ? v : null);
  return {
    ok: true,
    user: String(data.user || ''),
    userId: String(data.userId || ''),
    record: { read: flag(data.canRead), write: flag(data.canWrite), create: flag(data.canCreate), delete: flag(data.canDelete) },
    field: data.field ? { read: flag(data.fieldCanRead), write: flag(data.fieldCanWrite), create: flag(data.fieldCanCreate) } : null,
  };
}

/** The runtime answer for the operation asked about: true, false or null (not reported). */
export function runtimeAnswer(result, operation, field) {
  // The check reports read / write / create / delete only; reporting operations are not answered.
  if (!result?.ok || REPORT_OPS.has(operation)) return null;
  const key = operation;
  const rec = result.record?.[key];
  if (rec === false) return false;
  if (field && result.field) {
    const f = result.field[key === 'delete' ? 'write' : key];
    if (f === false) return false;
    if (rec === true && f === true) return true;
    return null;
  }
  return rec === true ? true : null;
}
