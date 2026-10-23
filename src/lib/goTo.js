// "Go to anything" for the command palette: type a piece of a name and land on the business rule, script include,
// ACL, notification, flow, widget, table, property, role or user. Like Ctrl+P in VS Code, for a ServiceNow instance.
//
// This file is pure (no DOM, no chrome.*, no fetch) so it can be unit tested:
//   KINDS            what can be found: table, columns to search, columns to show, tier, actions
//   parseGoTo        what the user typed: a bare fragment, or a "br: name" / "business rule: name" prefix
//   rankKinds        which kinds are the most likely for this text and this page
//   buildSearchQuery encoded queries, with every typed value escaped
//   matchText, scoreCandidate, rankCandidates   exact > starts with > word start > contains > tokens > fuzzy
//   createGoToEngine the search itself: bounded parallelism, stale requests aborted, results cached per
//                    (kind, term), tables that cannot be read skipped for the session. The caller injects `query`.
//
// The instance half is src/content/storedCommands.js (queries through queryTable) and the palette is
// src/content/commandPalette.js. Assumptions about tables and columns: docs/features/goto.md.

import { findCommand, escapeQueryValue } from './slashCommands.js';
import { hasInlineScript } from './queryGuard.js';
import { parseRecordNumber } from './recordNumber.js';
import { TIERS } from './roleTier.js';

// ---- Tuning ----------------------------------------------------------------------------------------------------

export const MIN_TERM_BARE = 3; // a bare fragment searches the instance from this many characters
export const MIN_TERM_KIND = 2; // "br: in" is a deliberate search, so two characters are enough
export const MAX_TERM = 80;
export const BARE_KINDS = 8; // kinds searched for a bare fragment
export const MORE_KINDS = 8; // further kinds tried when the likely ones found fewer than MIN_ROWS rows
export const MIN_ROWS = 3;
export const MAX_PARALLEL = 5; // requests in flight at once
export const LIMITS = {
  bare: { first: 10, starts: 6, perKind: 4, perName: 2, total: 14 },
  kind: { first: 30, starts: 12, perKind: 25, perName: 25, total: 25 },
};

// Score weights. A name that matches well beats everything; the rest only break ties between similar matches.
export const BOOST = { custom: 80, recentMax: 120, recentMin: 25, page: 60, pageParent: 30, sameKind: 15, inactive: -150 };

// ---- Kind catalogue --------------------------------------------------------------------------------------------

const present = (...parts) => parts.filter((p) => p !== undefined && p !== null && String(p).trim() !== '').map((p) => String(p).trim());
const operations = (r) => ['insert', 'update', 'delete', 'query'].filter((op) => r[`action_${op}`] === 'true').join('/');

/**
 * Every kind of thing the palette can go to.
 *   id        short key (the finder verb of src/lib/slashCommands.js where one exists)
 *   verbs     what can be typed before the colon: "br:", "business rule:"
 *   table     where it lives; search = columns matched with LIKE; display = the name shown
 *   alias     columns whose value is another name for the record (api_name, widget id, user name, e-mail)
 *   fields    extra columns read for the hint line (sys_id, display, search, alias, active, sys_scope... are always read)
 *   bound     column holding the table the record is about (a rule's collection); page relevance uses it
 *   active    the table has an `active` column: inactive records are shown, ranked lower and badged
 *   meta      an application file (has sys_scope, can be versioned); script = has a script field the editor can open
 *   usage     "Where is this used": impact (Script Include), impact-page (only when open), code (code search), field
 *   tier      least role tier that is shown the kind (same as src/lib/roleTier.js)
 *   weight    how likely a bare fragment means this kind, 0-100
 *   icon      palette icon name (also picks the category colour)
 *   describe  (display values, raw values) => { bound, extra[] } for the hint line
 */
const KIND_SPECS = [
  {
    id: 'br', label: 'Business Rule', plural: 'Business Rules', verbs: ['br', 'business rule', 'rule'], table: 'sys_script',
    search: ['name'], display: 'name', fields: ['collection', 'when', 'action_insert', 'action_update', 'action_delete', 'action_query'],
    bound: 'collection', active: true, meta: true, script: true, versions: true, usage: 'impact-page', tier: 'developer', weight: 96, icon: 'tools',
    describe: (v, r) => ({ bound: v.collection, extra: present([v.when, operations(r)].filter(Boolean).join(' ')) }),
  },
  {
    id: 'si', label: 'Script Include', plural: 'Script Includes', verbs: ['si', 'script include'], table: 'sys_script_include',
    search: ['name', 'api_name'], display: 'name', alias: ['api_name'], fields: ['api_name', 'client_callable', 'access'],
    active: true, meta: true, script: true, versions: true, usage: 'impact', tier: 'developer', weight: 100, icon: 'tools',
    describe: (v, r) => ({ bound: '', extra: present(v.api_name && v.api_name !== v.name && !v.api_name.endsWith(`.${v.name}`) ? v.api_name : '', r.client_callable === 'true' ? 'client callable' : '') }),
  },
  {
    id: 'cl', label: 'Client Script', plural: 'Client Scripts', verbs: ['cl', 'client script'], table: 'sys_script_client',
    search: ['name'], display: 'name', fields: ['table', 'type', 'field'],
    bound: 'table', active: true, meta: true, script: true, versions: true, usage: '', tier: 'developer', weight: 88, icon: 'tools',
    describe: (v) => ({ bound: v.table, extra: present([v.type, v.field].filter(Boolean).join(' ')) }),
  },
  {
    id: 'uia', label: 'UI Action', plural: 'UI Actions', verbs: ['uia', 'ui action'], table: 'sys_ui_action',
    search: ['name'], display: 'name', fields: ['table', 'action_name'],
    bound: 'table', active: true, meta: true, script: true, versions: true, usage: '', tier: 'developer', weight: 84, icon: 'tools',
    describe: (v) => ({ bound: v.table, extra: present(v.action_name) }),
  },
  {
    id: 'uip', label: 'UI Policy', plural: 'UI Policies', verbs: ['uip', 'ui policy'], table: 'sys_ui_policy',
    search: ['short_description'], display: 'short_description', fields: ['table'],
    bound: 'table', active: true, meta: true, script: false, versions: true, usage: '', tier: 'developer', weight: 62, icon: 'tools',
    describe: (v) => ({ bound: v.table, extra: [] }),
  },
  {
    id: 'uis', label: 'UI Script', plural: 'UI Scripts', verbs: ['uis', 'ui script'], table: 'sys_ui_script',
    search: ['name'], display: 'name', fields: ['global'],
    active: true, meta: true, script: true, versions: true, usage: 'code', tier: 'developer', weight: 56, icon: 'tools',
    describe: (v, r) => ({ bound: '', extra: present(r.global === 'true' ? 'global' : '') }),
  },
  {
    id: 'uipg', label: 'UI Page', plural: 'UI Pages', verbs: ['uipg', 'ui page'], table: 'sys_ui_page',
    search: ['name'], display: 'name', fields: ['description'],
    meta: true, script: false, versions: true, usage: 'code', tier: 'developer', weight: 34, icon: 'tools',
    describe: (v) => ({ bound: '', extra: present(v.description) }),
  },
  {
    id: 'macro', label: 'UI Macro', plural: 'UI Macros', verbs: ['macro', 'ui macro'], table: 'sys_ui_macro',
    search: ['name'], display: 'name', fields: ['description'],
    active: true, meta: true, script: false, versions: true, usage: 'code', tier: 'developer', weight: 36, icon: 'tools',
    describe: (v) => ({ bound: '', extra: present(v.description) }),
  },
  {
    id: 'job', label: 'Scheduled Job', plural: 'Scheduled Jobs', verbs: ['job', 'sj', 'scheduled job'], table: 'sysauto_script',
    search: ['name'], display: 'name', fields: ['run_type'],
    active: true, meta: true, script: true, versions: true, usage: '', tier: 'developer', weight: 56, icon: 'tools',
    describe: (v) => ({ bound: '', extra: present(v.run_type) }),
  },
  {
    id: 'fix', label: 'Fix Script', plural: 'Fix Scripts', verbs: ['fix', 'fix script'], table: 'sys_script_fix',
    search: ['name'], display: 'name', fields: ['description'],
    meta: true, script: true, versions: true, usage: '', tier: 'developer', weight: 38, icon: 'tools', // no active column: a fix script is run once by hand
    describe: (v) => ({ bound: '', extra: present(v.description) }),
  },
  {
    id: 'acl', label: 'ACL', plural: 'ACLs', verbs: ['acl', 'access control'], table: 'sys_security_acl',
    search: ['name'], display: 'name', fields: ['operation', 'type'],
    bound: 'name', active: true, meta: true, script: true, versions: true, usage: '', tier: 'developer', weight: 78, icon: 'analyze',
    describe: (v) => ({ bound: v.name ? String(v.name).split('.')[0] : '', lead: present(v.operation, v.type), extra: [] }),
  },
  {
    id: 'notif', label: 'Notification', plural: 'Notifications', verbs: ['notif', 'notification'], table: 'sysevent_email_action',
    search: ['name'], display: 'name', fields: ['collection', 'event_name'],
    bound: 'collection', active: true, meta: true, script: false, versions: true, usage: '', tier: 'developer', weight: 72, icon: 'navigate',
    describe: (v) => ({ bound: v.collection, extra: present(v.event_name) }),
  },
  {
    id: 'es', label: 'Email Script', plural: 'Email Scripts', verbs: ['es', 'email script'], table: 'sys_script_email',
    search: ['name'], display: 'name', fields: [],
    meta: true, script: true, versions: true, usage: 'code', tier: 'developer', weight: 28, icon: 'navigate', // name and script only
    describe: () => ({ bound: '', extra: [] }),
  },
  {
    id: 'evt', label: 'Event', plural: 'Events', verbs: ['evt', 'event'], table: 'sysevent_register',
    search: ['event_name'], display: 'event_name', fields: ['table', 'description'],
    bound: 'table', meta: true, script: false, versions: true, usage: 'code', tier: 'developer', weight: 34, icon: 'navigate',
    describe: (v) => ({ bound: v.table, extra: present(v.description) }),
  },
  {
    id: 'ea', label: 'Script Action', plural: 'Script Actions', verbs: ['ea', 'script action'], table: 'sysevent_script_action',
    search: ['name'], display: 'name', fields: ['event_name'],
    active: true, meta: true, script: true, versions: true, usage: '', tier: 'developer', weight: 40, icon: 'navigate',
    describe: (v) => ({ bound: '', extra: present(v.event_name) }),
  },
  {
    id: 'flow', label: 'Flow', plural: 'Flows', verbs: ['flow', 'subflow', 'flows'], table: 'sys_hub_flow',
    search: ['name'], display: 'name', fields: ['type', 'status'],
    active: true, meta: true, script: false, versions: false, usage: '', tier: 'developer', weight: 70, icon: 'navigate',
    describe: (v) => ({ bound: '', extra: present(v.type, v.status) }),
  },
  {
    id: 'action', label: 'Flow Action', plural: 'Flow Actions', verbs: ['action', 'fa', 'flow action'], table: 'sys_hub_action_type_definition',
    search: ['name'], display: 'name', fields: ['description'],
    active: true, meta: true, script: false, versions: false, usage: '', tier: 'developer', weight: 26, icon: 'navigate',
    describe: (v) => ({ bound: '', extra: present(v.description) }),
  },
  {
    id: 'wf', label: 'Workflow', plural: 'Workflows', verbs: ['wf', 'workflow'], table: 'wf_workflow',
    search: ['name'], display: 'name', fields: ['table', 'description'],
    bound: 'table', active: false, meta: true, script: false, versions: false, usage: '', tier: 'developer', weight: 26, icon: 'navigate',
    describe: (v) => ({ bound: v.table, extra: present(v.description) }),
  },
  {
    id: 'tm', label: 'Transform Map', plural: 'Transform Maps', verbs: ['tm', 'transform map'], table: 'sys_transform_map',
    search: ['name'], display: 'name', fields: ['source_table', 'target_table'],
    bound: 'target_table', active: true, meta: true, script: true, versions: true, usage: '', tier: 'developer', weight: 32, icon: 'navigate',
    describe: (v) => ({ bound: v.target_table, extra: present(v.source_table ? `from ${v.source_table}` : '') }),
  },
  {
    id: 'sra', label: 'Scripted REST API', plural: 'Scripted REST APIs', verbs: ['sra', 'rest api', 'scripted rest api', 'scripted rest'], table: 'sys_ws_definition',
    search: ['name', 'service_id'], display: 'name', alias: ['service_id'], fields: ['service_id', 'base_uri'],
    active: true, meta: true, script: false, versions: true, usage: '', tier: 'developer', weight: 32, icon: 'navigate',
    describe: (v) => ({ bound: '', extra: present(v.base_uri || v.service_id) }),
  },
  {
    id: 'widget', label: 'Portal Widget', plural: 'Portal Widgets', verbs: ['widget', 'portal widget', 'sp widget'], table: 'sp_widget',
    search: ['name', 'id'], display: 'name', alias: ['id'], fields: ['id'],
    meta: true, script: true, versions: true, usage: 'code', tier: 'developer', weight: 66, icon: 'record',
    describe: (v) => ({ bound: '', extra: present(v.id) }),
  },
  {
    id: 'page', label: 'Portal Page', plural: 'Portal Pages', verbs: ['page', 'portal page', 'sp page'], table: 'sp_page',
    search: ['title', 'id'], display: 'title', alias: ['id'], fields: ['id'],
    meta: true, script: false, versions: true, usage: '', tier: 'developer', weight: 30, icon: 'record',
    describe: (v) => ({ bound: '', extra: present(v.id) }),
  },
  {
    id: 'prov', label: 'Angular Provider', plural: 'Angular Providers', verbs: ['prov', 'provider', 'angular provider'], table: 'sp_angular_provider',
    search: ['name'], display: 'name', fields: ['type'],
    meta: true, script: true, versions: true, usage: 'code', tier: 'developer', weight: 28, icon: 'record',
    describe: (v) => ({ bound: '', extra: present(v.type) }),
  },
  {
    id: 'table', label: 'Table', plural: 'Tables', verbs: ['table', 't', 'tbl'], table: 'sys_db_object',
    search: ['name', 'label'], display: 'name', alias: ['label'], fields: ['label', 'super_class'],
    bound: 'name', meta: true, script: false, versions: false, usage: 'code', tier: 'developer', weight: 50, icon: 'table',
    describe: (v) => ({ bound: '', extra: present(v.label, v.super_class ? `extends ${v.super_class}` : '') }),
  },
  {
    id: 'dict', label: 'Dictionary field', plural: 'Dictionary fields', verbs: ['dict', 'field', 'column', 'col'], table: 'sys_dictionary',
    search: ['element', 'column_label'], display: 'element', alias: ['element', 'column_label'], fields: ['name', 'element', 'column_label', 'internal_type'],
    where: 'elementISNOTEMPTY', bound: 'name', active: true, meta: true, script: false, versions: false, usage: 'field', tier: 'developer', weight: 18, icon: 'table',
    title: (v) => (v.name && v.element ? `${v.name}.${v.element}` : v.element || v.name || ''),
    describe: (v) => ({ bound: v.name, extra: present(v.column_label, v.internal_type) }),
  },
  {
    id: 'prop', label: 'System Property', plural: 'System Properties', verbs: ['prop', 'props', 'property', 'system property', 'properties'], table: 'sys_properties',
    // The value is never read: it can hold a secret, and the Properties panel shows values with the redaction rules.
    search: ['name'], display: 'name', fields: ['description'],
    meta: true, script: false, versions: true, usage: 'code', tier: 'admin', weight: 52, icon: 'table',
    describe: (v) => ({ bound: '', extra: present(v.description) }),
  },
  {
    id: 'role', label: 'Role', plural: 'Roles', verbs: ['role'], table: 'sys_user_role',
    search: ['name'], display: 'name', fields: ['description'],
    meta: true, script: false, versions: false, usage: 'code', tier: 'admin', weight: 40, icon: 'analyze',
    describe: (v) => ({ bound: '', extra: present(v.description) }),
  },
  {
    id: 'g', label: 'Group', plural: 'Groups', verbs: ['g', 'grp', 'group'], table: 'sys_user_group',
    search: ['name'], display: 'name', fields: ['description'],
    active: true, meta: false, script: false, versions: false, usage: '', tier: 'user', weight: 22, icon: 'user',
    describe: (v) => ({ bound: '', extra: present(v.description) }),
  },
  {
    id: 'u', label: 'User', plural: 'Users', verbs: ['u', 'user'], table: 'sys_user',
    search: ['user_name', 'name', 'email'], display: 'name', alias: ['user_name', 'email'], fields: ['user_name', 'email', 'title'],
    active: true, meta: false, script: false, versions: false, usage: '', tier: 'user', weight: 20, icon: 'user',
    describe: (v) => ({ bound: '', extra: present(v.user_name, v.email) }),
  },
  {
    id: 'item', label: 'Catalog Item', plural: 'Catalog Items', verbs: ['item', 'cat', 'catalog item', 'catalog'], table: 'sc_cat_item',
    search: ['name'], display: 'name', fields: ['short_description'],
    active: true, meta: true, script: false, versions: true, usage: '', tier: 'user', weight: 22, icon: 'record',
    describe: (v) => ({ bound: '', extra: present(v.short_description) }),
  },
  {
    id: 'app', label: 'Application', plural: 'Applications', verbs: ['app', 'application'], table: 'sys_app',
    search: ['name', 'scope'], display: 'name', alias: ['scope'], fields: ['scope', 'version'],
    active: true, meta: false, script: false, versions: false, usage: '', tier: 'developer', weight: 24, icon: 'record',
    describe: (v) => ({ bound: '', extra: present(v.scope, v.version) }),
  },
  {
    id: 'us', label: 'Update Set', plural: 'Update Sets', verbs: ['us', 'updateset', 'update set'], table: 'sys_update_set',
    search: ['name'], display: 'name', fields: ['state', 'application'],
    active: false, meta: false, script: false, versions: false, usage: '', tier: 'developer', weight: 24, icon: 'record',
    describe: (v) => ({ bound: '', extra: present(v.state, v.application) }),
  },
];

export const KINDS = KIND_SPECS.map((spec) => ({ alias: [], fields: [], bound: '', where: '', active: false, meta: false, script: false, versions: false, usage: '', ...spec }));
const KIND_BY_ID = new Map(KINDS.map((kind) => [kind.id, kind]));
export const kindById = (id) => KIND_BY_ID.get(id) || null;

// Columns every request reads, whatever the kind.
const COMMON_FIELDS = ['sys_id', 'sys_class_name', 'sys_updated_on', 'sys_updated_by', 'sys_created_by'];

/** Columns to ask for: the common ones, what the kind searches and shows, and (application files) the scope. */
export function fieldsFor(kind) {
  const fields = [...COMMON_FIELDS, kind.display, ...kind.search, ...kind.alias, ...kind.fields];
  if (kind.active) fields.push('active');
  if (kind.meta) fields.push('sys_scope', 'sys_scope.scope');
  return [...new Set(fields)];
}

/** What the Self-check panel can test (src/lib/requirements): one entry per table, columns we search or show. */
export const GOTO_REQUIREMENTS = KINDS.map((kind) => ({
  feature: 'Go to anything',
  table: kind.table,
  columns: [...new Set([kind.display, ...kind.search, ...kind.alias, ...kind.fields, ...(kind.active ? ['active'] : [])])].filter((c) => c !== 'sys_id'),
  optional: true,
  note: `${kind.plural}: the palette searches ${kind.search.join(', ')}. A table or column that is missing only removes this kind from the results.`,
}));

// ---- Kind words (what can be typed before the colon) -----------------------------------------------------------------

const WORD_INDEX = new Map();
KINDS.forEach((kind) => {
  // The verbs, the names ("business rule", "business rules") and the table ("sys_script").
  [...kind.verbs, kind.label.toLowerCase(), kind.plural.toLowerCase(), kind.table].forEach((word) => {
    const key = word.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!WORD_INDEX.has(key)) WORD_INDEX.set(key, kind.id);
  });
});

/** The kind a word names ("br", "Business Rules", "acls"), or null. */
export function kindForWord(word) {
  const key = String(word || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!key) return null;
  const exact = WORD_INDEX.get(key);
  if (exact) return kindById(exact);
  if (key.length >= 4 && key.endsWith('s')) {
    const single = WORD_INDEX.get(key.slice(0, -1));
    if (single) return kindById(single);
  }
  return null;
}

// ---- Parsing what was typed ------------------------------------------------------------------------------------------

const PREFIX_RE = /^([a-z][a-z _,]{0,48}?)\s*:\s*(.*)$/i;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;
// "active=true", "priority<=2", "nameLIKEx": the encoded-query tools of the palette handle those.
const QUERY_LIKE_RE = /(?:^|\s)[A-Za-z_][\w.]*\s*(?:!=|>=|<=|=|>|<|LIKE|STARTSWITH|ENDSWITH)\S/;

const rankOfTier = (tier) => Math.max(0, TIERS.indexOf(tier));
const allowedFor = (kind, tier) => !tier || rankOfTier(tier) >= rankOfTier(kind.tier);

/** Whitespace collapsed, control characters gone. */
export function cleanTerm(text) {
  // eslint-disable-next-line no-control-regex -- control characters have no place in a name.
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Why a term must never reach a query, or '' when it is fine. `^` and "javascript:" are the dangerous ones: every typed
 * word becomes its own LIKE value, and ServiceNow runs a value that starts with "javascript:", so each word is checked.
 */
export function unsafeTermReason(term) {
  const text = String(term ?? '');
  if (text.includes('^')) return 'caret';
  if (hasInlineScript(text) || queryTokens(text).some(hasInlineScript)) return 'script';
  return '';
}

/**
 * What the palette should do with the text. mode: 'none' (not a name search), 'bare' (a fragment: the most likely
 * kinds) or 'kind' (a prefix named the kinds). `kinds` are ids, filtered to what the user's tier may read.
 * @param {string} input
 * @param {{ ctx?: object, tier?: string|null }} [options]
 */
export function parseGoTo(input, { ctx = {}, tier = null } = {}) {
  const text = cleanTerm(input);
  const none = (reason) => ({ mode: 'none', reason, term: '', kinds: [] });
  if (!text) return none('empty');
  if (/^[@/]/.test(text)) return none('command');
  if (SYS_ID_RE.test(text)) return none('sys_id');
  if (parseRecordNumber(text)) return none('record number');

  const match = PREFIX_RE.exec(text);
  let named = null;
  let term = text;
  if (match && !/^[a-z]+:\/\//i.test(text)) {
    const kinds = match[1].split(',').map((word) => kindForWord(word));
    if (kinds.length && kinds.every(Boolean)) {
      named = [...new Set(kinds.map((k) => k.id))];
      term = cleanTerm(match[2]);
    }
  }

  if (term.length > MAX_TERM) return none('too long');
  const unsafe = unsafeTermReason(term);
  if (unsafe) return none(unsafe);

  if (named) {
    const kinds = named.filter((id) => allowedFor(kindById(id), tier));
    return { mode: 'kind', term, kinds, denied: named.filter((id) => !kinds.includes(id)), tooShort: term.length < MIN_TERM_KIND, raw: text };
  }

  if (/^[a-z]+:\/\//i.test(term) || QUERY_LIKE_RE.test(term)) return none('looks like a query or a link');
  if (term.length < MIN_TERM_BARE) return none('too short');
  const ranked = rankKinds(term, ctx, { tier }).map((k) => k.id);
  // `more`: tried only when the likely kinds found almost nothing (see createGoToEngine).
  return { mode: 'bare', term, kinds: ranked.slice(0, BARE_KINDS), more: ranked.slice(BARE_KINDS, BARE_KINDS + MORE_KINDS), tooShort: false, raw: text };
}

// ---- Which kinds are likely --------------------------------------------------------------------------------------------

const TASK_TABLES = new Set([
  'incident', 'problem', 'change_request', 'change_task', 'sc_request', 'sc_req_item', 'sc_task', 'incident_task', 'problem_task', 'hr_case', 'sn_customerservice_case',
]);
const CODE_KINDS = new Set(['br', 'si', 'cl', 'uia', 'uis', 'job', 'fix', 'ea', 'es', 'uipg', 'macro', 'widget', 'prov']);

/** Table names the record on screen belongs to, nearest first, as far as can be known without a request. */
export function pageTables(ctx = {}) {
  const table = String(ctx.table || '');
  if (!table) return [];
  return TASK_TABLES.has(table) ? [table, 'task'] : [table];
}

/** How much a kind suits the page on screen (0 when nothing is known). */
export function pageAffinity(kind, ctx = {}) {
  const table = String(ctx.table || '');
  if (!table) return 0;
  if (table === 'sys_user') return { u: 90, g: 70, role: 40 }[kind.id] || 0;
  if (table === 'sys_user_group') return { g: 90, u: 70, role: 40 }[kind.id] || 0;
  if (kind.table === table) return 45;
  if (/^sp_/.test(table)) return ['widget', 'page', 'prov'].includes(kind.id) ? 55 : 0;
  const sibling = KINDS.find((k) => k.table === table);
  if (sibling) return CODE_KINDS.has(sibling.id) && CODE_KINDS.has(kind.id) ? 8 : 0;
  if (table === 'sys_update_set' || table === 'sys_update_xml') return kind.id === 'us' ? 30 : 0;
  if (/^sys_/.test(table)) return 0;
  // A data table (incident, cmdb_ci...): whatever is configured for it.
  return kind.bound && kind.id !== 'table' ? 25 : 0;
}

/** Boosts from the shape of the text: PascalCase is a class, a dotted lower-case name a property, an @ an e-mail. */
export function shapeAffinity(kind, term) {
  const text = String(term || '').trim();
  if (!text) return 0;
  const single = !/\s/.test(text);
  let boost = 0;
  if (text.includes('@') && single) return kind.id === 'u' ? 90 : 0;
  if (single && /[a-z]/.test(text) && /[A-Z]/.test(text) && !/[_.]/.test(text)) {
    if (kind.id === 'si') boost += 35;
    else if (kind.id === 'prov') boost += 20;
    else if (kind.id === 'uis') boost += 15;
    else if (kind.id === 'widget') boost += 10;
  }
  if (!single) {
    if (kind.id === 'notif' || kind.id === 'flow') boost += 25;
    else if (kind.id === 'br') boost += 15;
    else if (kind.id === 'uia' || kind.id === 'cl') boost += 10;
    else if (kind.id === 'si') boost -= 30; // a class name is one word
  }
  if (single && /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(text)) {
    // incident.state is an ACL and a dictionary entry; glide.ui.concourse.onmenu is a property.
    const parts = text.split('.').length;
    if (parts === 2) boost += { acl: 45, dict: 60, prop: 20 }[kind.id] || 0;
    else boost += { prop: 60, acl: 10 }[kind.id] || 0;
  }
  if (single && /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(text)) {
    if (kind.id === 'table') boost += 60;
    else if (kind.id === 'dict') boost += 30;
    else if (kind.id === 'evt') boost += 20;
    else if (kind.id === 'prop') boost += 15;
    if (/^(x|sn)_/.test(text)) {
      if (kind.id === 'app') boost += 65;
      else if (kind.id === 'widget') boost += 15;
    }
  }
  return boost;
}

/** Kinds the user's tier may read, most likely first for this text and page. */
export function rankKinds(term, ctx = {}, { tier = null } = {}) {
  return KINDS.filter((kind) => allowedFor(kind, tier))
    .map((kind) => ({ kind, score: kind.weight + pageAffinity(kind, ctx) + shapeAffinity(kind, term) }))
    .sort((a, b) => b.score - a.score || b.kind.weight - a.kind.weight)
    .map((entry) => entry.kind);
}

// ---- Query building --------------------------------------------------------------------------------------------------

/** "AJAXUtil" -> ["AJAX", "Util"]; a single lower-case or upper-case word has no humps. */
export function splitHumps(word) {
  const text = String(word || '');
  if (!/[a-z]/.test(text) || !/[A-Z]/.test(text)) return [text].filter(Boolean);
  return text.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) || [text];
}

/** The words a name must contain: the typed words, or the humps of one PascalCase word. Never more than four. */
export function queryTokens(term) {
  const words = cleanTerm(term).split(' ').filter(Boolean);
  if (words.length === 1 && !/[_.]/.test(words[0])) {
    const humps = splitHumps(words[0]).filter((h) => h.length >= 2);
    if (humps.length >= 2) return humps.slice(0, 4);
  }
  return words.slice(0, 4);
}

/** A value placed after an operator: caret doubled, newlines gone, a leading "javascript:" refused. */
function queryValue(value) {
  const text = cleanTerm(value);
  if (hasInlineScript(text)) throw new Error('A search may not start with "javascript:".');
  return escapeQueryValue(text);
}

const orLike = (fields, value, operator = 'LIKE') => fields.map((field) => `${field}${operator}${value}`).join('^OR');

/**
 * The first query for a kind: every typed word must be in one of the search columns, most recently changed first (so
 * what a developer works on, and custom records, come before the platform's thousands). Returns null for nothing to ask.
 */
export function buildSearchQuery(kind, term) {
  const clean = cleanTerm(term);
  if (!clean) return null;
  const parts = [];
  if (kind.where) parts.push(kind.where);

  // incident.state, task.: a table, then part of a column name.
  const dotted = kind.id === 'dict' ? /^([a-z0-9_]+)\.([a-z0-9_]*)$/i.exec(clean) : null;
  if (dotted) {
    parts.push(`name=${queryValue(dotted[1].toLowerCase())}`);
    if (dotted[2]) parts.push(`elementLIKE${queryValue(dotted[2])}`);
    return `${parts.join('^')}^ORDERBYelement`;
  }

  const tokens = queryTokens(clean).map(queryValue).filter(Boolean);
  if (!tokens.length) return null;
  tokens.forEach((token) => parts.push(orLike(kind.search, token)));
  return `${parts.join('^')}^ORDERBYDESCsys_updated_on`;
}

/** The follow-up when the first answer was full: names that START with the text, so an exact name is never missed. */
export function buildStartsQuery(kind, term) {
  const clean = cleanTerm(term);
  if (!clean || (kind.id === 'dict' && clean.includes('.'))) return null;
  const parts = [];
  if (kind.where) parts.push(kind.where);
  parts.push(orLike(kind.search, queryValue(clean), 'STARTSWITH'));
  return `${parts.join('^')}^ORDERBY${kind.display}`;
}

// ---- Text matching and ranking ---------------------------------------------------------------------------------------

const NONE = Object.freeze({ tier: 'none', score: 0, hits: [] });
const BOUNDARY = /[\s_\-./:()[\]]/;
const isLower = (ch) => ch !== undefined && ch !== ch.toUpperCase();
const isUpper = (ch) => ch !== undefined && ch !== ch.toLowerCase();
const isDigit = (ch) => ch !== undefined && ch >= '0' && ch <= '9';
const squash = (text) => String(text || '').toLowerCase().replace(/[\s_\-./:]+/g, '');
const range = (from, length) => Array.from({ length }, (_, i) => from + i);

/** Indexes where a word starts in the original-case text: after a separator, at a camel hump, at a letter/digit change. */
function wordStarts(text) {
  const starts = new Set([0]);
  for (let i = 1; i < text.length; i += 1) {
    const prev = text[i - 1];
    const ch = text[i];
    if (BOUNDARY.test(prev) && !BOUNDARY.test(ch)) starts.add(i);
    else if (isLower(prev) && isUpper(ch)) starts.add(i);
    else if (isUpper(prev) && isUpper(ch) && isLower(text[i + 1])) starts.add(i);
    else if (isDigit(prev) !== isDigit(ch) && !BOUNDARY.test(prev) && !BOUNDARY.test(ch)) starts.add(i);
  }
  return starts;
}

function occurrences(haystack, needle) {
  const out = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/** The typed words in order, each preferably at a word start. null when one is missing. */
function placeTokens(lower, starts, tokens) {
  let from = 0;
  const hits = [];
  let allWord = true;
  for (const token of tokens) {
    // One or two letters ("incident u") only count at the start of a word; inside a word they match nearly anything.
    const found = occurrences(lower, token).filter((i) => i >= from && (token.length >= 3 || starts.has(i)));
    if (!found.length) return null;
    const atWord = found.find((i) => starts.has(i));
    const at = atWord === undefined ? found[0] : atWord;
    if (atWord === undefined) allWord = false;
    hits.push(...range(at, token.length));
    from = at + token.length;
  }
  return { hits, allWord };
}

function fuzzy(lowerTerm, lower, starts) {
  const hits = [];
  let from = 0;
  let wordHits = 0;
  for (const ch of lowerTerm) {
    if (ch === ' ') continue;
    const at = lower.indexOf(ch, from);
    if (at === -1) return null;
    hits.push(at);
    if (starts.has(at)) wordHits += 1;
    from = at + 1;
  }
  return { hits, wordHits };
}

/**
 * How well `text` answers the typed `term`. tier: exact (1000) > prefix (800) > word start (640) > contains (480)
 * > the typed words in order (600 at word starts, 440 otherwise) or in any order (380) > fuzzy (250 and up).
 * Separators do not matter for exact and prefix ("incident closed" equals "Incident_Closed").
 * @returns {{ tier: string, score: number, hits: number[] }} `hits` are the matched indexes of `text`, for highlighting.
 */
export function matchText(term, text) {
  const original = String(text ?? '');
  const t = cleanTerm(term).toLowerCase();
  const s = original.toLowerCase();
  if (!t || !s) return NONE;
  if (s === t) return { tier: 'exact', score: 1000, hits: range(0, s.length) };
  const squashedTerm = squash(t);
  const squashedText = squash(s);
  if (squashedTerm && squashedText === squashedTerm) return { tier: 'exact', score: 990, hits: range(0, s.length) };
  if (s.startsWith(t)) return { tier: 'prefix', score: 800, hits: range(0, t.length) };

  const starts = wordStarts(original);
  const tokens = queryTokens(term).map((token) => token.toLowerCase());
  if (squashedTerm.length >= 2 && squashedText.startsWith(squashedTerm)) {
    const placed = tokens.length > 1 ? placeTokens(s, starts, tokens) : null;
    return { tier: 'prefix', score: 780, hits: placed ? placed.hits : [] };
  }

  const contiguous = occurrences(s, t);
  if (contiguous.length) {
    const atWord = contiguous.find((i) => starts.has(i));
    const at = atWord === undefined ? contiguous[0] : atWord;
    return atWord === undefined ? { tier: 'contains', score: 480, hits: range(at, t.length) } : { tier: 'word', score: 640, hits: range(at, t.length) };
  }

  if (tokens.length >= 2) {
    const ordered = placeTokens(s, starts, tokens);
    if (ordered) return { tier: 'tokens', score: ordered.allWord ? 600 : 440, hits: ordered.hits };
    const hits = [];
    const anywhere = (token) => occurrences(s, token).filter((i) => token.length >= 3 || starts.has(i));
    if (tokens.every((token) => anywhere(token).length)) {
      tokens.forEach((token) => hits.push(...range(anywhere(token)[0], token.length)));
      return { tier: 'tokens', score: 380, hits: [...new Set(hits)].sort((a, b) => a - b) };
    }
  }

  if (squashedTerm.length >= 3 && s.length <= 120) {
    const loose = fuzzy(t, s, starts);
    if (loose) return { tier: 'fuzzy', score: 250 + Math.min(60, loose.wordHits * 15), hits: loose.hits };
  }
  return NONE;
}

/** Highlight indexes of `text` for the typed term (what matchText found; empty when only another name matched). */
export const highlightHits = (term, text) => matchText(term, text).hits;

const PLATFORM_CREATORS = new Set(['system', 'maint', 'glide.maint', 'servicenow']);

/**
 * How likely a record is custom work rather than platform content, 0 to 1. There is no cheap flag on the row, so:
 *   scope  x_* is an application someone built (1); sn_*, com.*, sys_* are platform or store applications (0)
 *   global created by `system`/`maint` is shipped content (0); `admin` could be either (0.4); any other user wrote it (1)
 *   and a platform record that a real user edited since is a customised one (+0.2).
 * The ServiceNow-side signal (a sys_customer_update row) would need a request per record, so it is not used.
 */
export function customness(c) {
  const scope = String(c.scope || '').toLowerCase();
  const creator = String(c.createdBy || '').toLowerCase();
  const editor = String(c.updatedBy || '').toLowerCase();
  let base;
  if (scope && scope !== 'global' && scope !== 'rhino.global') base = /^x_/.test(scope) ? 1 : /^(sn_|com\.|sys_|glide|rhino)/.test(scope) ? 0 : 0.5;
  else if (!creator || PLATFORM_CREATORS.has(creator)) base = 0;
  else base = creator === 'admin' ? 0.4 : 1;
  const humanEdit = editor && !PLATFORM_CREATORS.has(editor) && editor !== creator;
  return Math.min(1, base + (humanEdit && base < 1 ? 0.2 : 0));
}

/**
 * Rank score of one record for the typed term.
 * @param {object} c candidate from normalizeRow
 * @param {string} term
 * @param {{ recents?: Map<string, number>|object, ctx?: object }} [env] `recents`: sys_id -> position (0 = newest)
 */
export function scoreCandidate(c, term, env = {}) {
  const title = matchText(term, c.name);
  let best = title;
  c.aliases.forEach((alias) => {
    const m = matchText(term, alias);
    if (m.score * 0.96 > best.score) best = { ...m, score: m.score * 0.96, hits: [] };
  });
  // The row came back from a LIKE on a search column, so some column matched even when none of the names do.
  let score = best.score || 200;
  const hits = best === title ? title.hits : [];

  score -= Math.min(60, Math.max(0, c.name.length - cleanTerm(term).length) * 0.4);
  score += BOOST.custom * customness(c);

  const recents = env.recents;
  const position = recents instanceof Map ? recents.get(c.sysId) : recents?.[c.sysId];
  if (position !== undefined) score += Math.max(BOOST.recentMin, BOOST.recentMax - position * 4);

  const ctx = env.ctx || {};
  const tables = pageTables(ctx);
  if (tables.length && c.bound) {
    const at = tables.indexOf(c.bound);
    if (at === 0) score += BOOST.page;
    else if (at > 0) score += BOOST.pageParent;
  }
  if (ctx.table && c.table === ctx.table) score += BOOST.sameKind;

  if (c.active === false) score += BOOST.inactive;
  return { score: Math.round(score * 10) / 10, tier: best.tier, hits };
}

/** Candidates best first (ties by name), each as { c, score, tier, hits }. */
export function rankCandidates(candidates, term, env = {}) {
  return candidates
    .map((c) => ({ c, ...scoreCandidate(c, term, env) }))
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
}

/**
 * The rows to show, best first: at most `perKind` of one kind (so one chatty kind cannot crowd the rest out),
 * `perName` with one name, and `total` overall. The best match of every kind that has a real one is taken first, so a
 * script include is not lost behind a dozen rules that all start with the same word.
 */
export function selectRows(ranked, { perKind, total, perName = perKind }) {
  const counts = new Map();
  const names = new Map();
  const chosen = new Set();
  const take = (row) => {
    const n = counts.get(row.c.kind) || 0;
    const nameKey = `${row.c.kind}|${row.c.name.toLowerCase()}`;
    const sameName = names.get(nameKey) || 0;
    if (chosen.has(row) || n >= perKind || sameName >= perName || chosen.size >= total) return;
    counts.set(row.c.kind, n + 1);
    names.set(nameKey, sameName + 1);
    chosen.add(row);
  };
  const seen = new Set();
  ranked.forEach((row) => {
    if (!seen.has(row.c.kind) && row.score >= 300) take(row);
    seen.add(row.c.kind);
  });
  ranked.forEach(take);
  return ranked.filter((row) => chosen.has(row));
}

// ---- Rows from the instance --------------------------------------------------------------------------------------------

const TABLE_NAME_RE = /^[a-z][a-z0-9_]{0,79}$/;
// Bidi embedding, override and isolate controls are dropped from what is shown: with them a name such as
// "Hostile <RLO>gpj.exe" reads "Hostile exe.jpg". Right-to-left text itself (Arabic, Hebrew) needs none of them.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
const displayOf = (value) => (value && typeof value === 'object' ? String(value.display_value ?? value.value ?? '') : String(value ?? '')).replace(BIDI_CONTROLS, '');
const rawOf = (value) => (value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? ''));

/** "2026-10-22 14:03:11" (UTC, as the instance stores it) to epoch ms, or 0. */
function stamp(value) {
  const ms = Date.parse(`${String(value || '').replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * One Table API row (read with display values: each column is a string or { value, display_value }) as a candidate.
 * Returns null for a row without a real sys_id.
 */
export function normalizeRow(kind, row) {
  const sysId = rawOf(row?.sys_id);
  if (!SYS_ID_RE.test(sysId)) return null;
  const v = {};
  const r = {};
  Object.keys(row).forEach((key) => {
    v[key] = displayOf(row[key]);
    r[key] = rawOf(row[key]);
  });
  const name = (kind.title ? kind.title(v, r) : v[kind.display]) || kind.alias.map((a) => v[a]).find(Boolean) || sysId;
  const described = kind.describe(v, r) || {};
  const className = r.sys_class_name;
  const scopeId = r.sys_scope;
  const scope = (v['sys_scope.scope'] || '').trim() || (scopeId === 'global' ? 'global' : '');
  return {
    id: `${kind.table}:${sysId}`,
    kind: kind.id,
    table: TABLE_NAME_RE.test(className || '') ? className : kind.table,
    sysId,
    name: String(name),
    aliases: kind.alias.map((a) => v[a]).filter((a) => a && a !== name),
    bound: String((kind.bound && (described.bound || r[kind.bound])) || '').trim(),
    active: kind.active && r.active !== '' && r.active !== undefined ? r.active === 'true' : null,
    scope,
    scopeName: v.sys_scope || '',
    createdBy: v.sys_created_by || '',
    updatedBy: v.sys_updated_by || '',
    updatedOn: stamp(r.sys_updated_on),
    lead: described.lead || [],
    extra: described.extra || [],
  };
}

/** The grey line under a result: "incident · global · after update". */
export function describeCandidate(c) {
  const scope = c.scope || c.scopeName;
  return [c.bound !== c.name ? c.bound : '', ...c.lead, scope, ...c.extra].filter(Boolean).join(' · ');
}

/**
 * The highest palette score of a name found from bare text. The palette's own answers for the same text come first:
 * a record number, sys_id or @user (1000), the table navigation "Incident list" / "New Incident" (830 to 900, see
 * buildProviders in src/content/commands.js). Typing "incident" must still put the incident list on top, not an ACL
 * named "incident". Names still beat a loose match on a command title (740 at most). Rows keep their order under the cap.
 * After a kind prefix ("acl: incident") the user asked for that kind, so there is no cap.
 */
export const BARE_SCORE_CAP = 820;

/** The palette's fields for a ranked candidate (the content side adds the url and the group). */
export function toRow(entry, { cap = 1090 } = {}) {
  const { c } = entry;
  const kind = kindById(c.kind);
  return {
    id: `goto.${c.table}.${c.sysId}`,
    title: c.name,
    hint: describeCandidate(c),
    kindLabel: kind.label,
    inactive: c.active === false,
    icon: kind.icon,
    score: Math.min(cap, 1090, Math.max(1, Math.round(entry.score))),
    hits: entry.hits,
    goTo: { kind: c.kind, table: c.table, sysId: c.sysId, name: c.name },
  };
}

// Case and accents folded, as the instance's LIKE compares them ("cafe" finds "Café").
const fold = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036F]/g, '').toLowerCase();

/**
 * True when a row really holds the typed words the way the query asked for them: every word inside the name or one of
 * its other names (API name, widget id, user name...). Every search column of a kind is one of those (a test checks it),
 * so a correct answer always passes. It is the guard against ServiceNow silently dropping a condition on a column it
 * does not have and answering with every row of the table: such rows are never shown as matches.
 */
export function answersTerm(c, term) {
  const texts = [c.name, ...c.aliases].map(fold);
  return queryTokens(term).every((token) => {
    const word = fold(token);
    return texts.some((text) => text.includes(word));
  });
}

/** Candidates still answering `term` after the user typed more of it (an instant refinement while the new request runs). */
export function refineCandidates(candidates, term) {
  return candidates.filter((c) => [c.name, ...c.aliases].some((text) => matchText(term, text).score >= 380));
}

// ---- Rows that are not records: the list link, and notes ---------------------------------------------------------

export const STATUS_SCORE = 345; // below every real match

/** A note in the palette: it says something and does nothing (Enter on it leaves the palette open). */
export const statusRow = (id, title, hint) => ({ id: `goto.status.${id}`, title, hint, group: '', icon: 'search', score: STATUS_SCORE, status: true, hits: [], run: () => {} });

/**
 * "See all of them": the list of each named kind, with the same filter, like /br does. A kind that cannot be read gets none.
 * @param {(table: string, query: string) => string} urlFor builds the list address (quickActions.listUrl)
 */
export function listRowsFor(parsed, meta, urlFor) {
  if (parsed.mode !== 'kind') return [];
  const skip = new Set(meta?.unavailable || []);
  return parsed.kinds
    .filter((id) => !skip.has(id))
    .map((id, index) => {
      const kind = kindById(id);
      let query = 'ORDERBYDESCsys_updated_on';
      try {
        if (parsed.term) query = buildSearchQuery(kind, parsed.term) || query;
      } catch {
        // The text was refused (a leading "javascript:"); the plain list is still fine.
      }
      return {
        id: `goto.list.${id}`,
        title: parsed.term ? `${kind.plural} matching “${parsed.term}”` : `${kind.plural} list`,
        hint: parsed.term ? `${kind.table}_list.do` : 'Type part of a name to find one',
        group: 'List',
        icon: kind.icon,
        hits: [],
        score: STATUS_SCORE - index,
        url: urlFor(kind.table, query),
      };
    });
}

/** A kind's plural inside a sentence: "business rules", but "UI pages", "ACLs", "scripted REST APIs". */
export const inSentence = (kind) =>
  kind.plural
    .split(' ')
    .map((word) => (/^[A-Z]{2,}/.test(word) ? word : word.toLowerCase()))
    .join(' ');

/**
 * What could not be read, in words. "Nothing found" is only said when every named kind was searched and answered;
 * a bare search stays quiet about tables it could not read, and says so only when every request failed.
 * @param {object} parsed from parseGoTo
 * @param {{ unavailable: string[], failed: Array<{kind: string, reason: string}>, expired: boolean }} meta from the engine
 * @param {boolean} pending the search is still running
 * @param {number} shown how many record rows are on screen
 */
export function noticeRowsFor(parsed, meta, pending, shown) {
  const rows = [];
  if (meta.expired) rows.push(statusRow('expired', 'Your ServiceNow session has expired', 'Log in again, then retry.'));
  if (parsed.mode === 'kind') {
    (parsed.denied || []).forEach((id) => rows.push(statusRow(`denied.${id}`, `${kindById(id).plural} are hidden for your roles`, 'Turn off "Show tools by role" in Options to try anyway')));
    meta.unavailable.forEach((id) => rows.push(statusRow(`unavailable.${id}`, `${kindById(id).plural} cannot be read here`, `No access to ${kindById(id).table}, or this instance does not have it`)));
    meta.failed.forEach((f) =>
      rows.push(statusRow(`failed.${f.kind}`, `Could not search ${inSentence(kindById(f.kind))}`, f.reason === 'busy' ? 'The instance is busy. Try again in a moment.' : 'The instance did not answer. Try again.'))
    );
    if (!shown) {
      const answered = parsed.kinds.filter((id) => !meta.unavailable.includes(id) && !meta.failed.some((f) => f.kind === id));
      const names = answered.map((id) => inSentence(kindById(id))).join(', ');
      if (pending && !rows.length) rows.push(statusRow('searching', `Searching ${parsed.kinds.map((id) => inSentence(kindById(id))).join(', ')}…`, ''));
      // The Table API leaves out the rows your roles cannot read without saying so, hence "you can read".
      else if (!pending && answered.length && !meta.expired) rows.push(statusRow('none', `No match for “${parsed.term}”`, `Searched ${names} you can read. Try fewer letters.`));
    }
  } else if (!shown && !pending && meta.failed.length && !meta.expired) {
    rows.push(statusRow('failed', 'Could not search the instance for names', 'The instance did not answer. Try again.'));
  }
  return rows;
}

// ---- Secondary actions -----------------------------------------------------------------------------------------------

/**
 * The actions offered on a highlighted row (Tab or Right Arrow). `onPage` is true when the row is the record on screen.
 * The content side maps each id to an existing command or service.
 */
export function actionsFor(goTo, { onPage = false } = {}) {
  const kind = kindById(goTo?.kind);
  if (!kind) return [];
  const actions = [
    { id: 'open', label: 'Open', hint: 'Enter' },
    { id: 'tab', label: 'Open in a new tab', hint: 'Shift+Enter' },
  ];
  // The definition of a table is what the row opens; most of the time the list is what is wanted next.
  if (kind.id === 'table' && TABLE_NAME_RE.test(goTo.name || '')) actions.push({ id: 'list', label: 'Open its list', hint: `${goTo.name}_list.do` });
  if (kind.script) actions.push({ id: 'edit', label: onPage ? 'Edit the script here' : 'Open it, then edit the script', hint: 'in-place editor' });
  if (kind.usage === 'impact') actions.push({ id: 'usage', label: 'Where is this used', hint: 'change impact' });
  else if (kind.usage === 'impact-page' && onPage) actions.push({ id: 'usage', label: 'What does this affect', hint: 'change impact' });
  else if (kind.usage === 'code') actions.push({ id: 'usage', label: 'Where is this used', hint: 'code search' });
  else if (kind.usage === 'field') actions.push({ id: 'usage', label: 'Where is this field used', hint: 'field usage' });
  if (kind.versions) actions.push({ id: 'versions', label: 'Versions', hint: onPage ? 'compare' : 'version list' });
  actions.push({ id: 'link', label: 'Copy link', hint: 'Alt+Enter' }, { id: 'sysid', label: 'Copy sys_id', hint: goTo.sysId.slice(0, 8) });
  return actions;
}

/** What "Where is this used" searches for: the name to type into the code search / impact panel / field usage. */
export function usageTarget(goTo) {
  const kind = kindById(goTo?.kind);
  if (!kind || !kind.usage) return null;
  const name = String(goTo.name || '');
  if (kind.id === 'dict') {
    const [table, ...rest] = name.split('.');
    return rest.length ? { type: 'field', value: `${table}.${rest.join('.')}` } : null;
  }
  if (kind.usage === 'code') return { type: 'code', value: name };
  return { type: kind.usage, value: name };
}

/** The version list of a record (the same query as the "Record versions" command). */
export const versionQuery = (table, sysId) => `name=${table}_${sysId}^ORDERBYDESCsys_recorded_at`;

// ---- "Open it, then edit the script" -----------------------------------------------------------------------------

export const PENDING_EDIT_KEY = 'msb_goto_edit';
const PENDING_EDIT_TTL_MS = 60000;

/** The marker left in sessionStorage before navigating, so the next page can open the editor. */
export const pendingEditMarker = (table, sysId, now = Date.now()) => JSON.stringify({ table, sysId, at: now });

/**
 * The marker if it is well formed and fresh, else null.
 * sessionStorage is shared with the page's own scripts, so a page can write this marker too. What it can cause is
 * bounded: the marker only ever OPENS the editor (never saves), only on the record it names, only when that record is
 * the page on screen, within a minute, once. Anything not exactly { table, sysId, at } of the right shapes is ignored.
 */
export function parsePendingEdit(text, now = Date.now()) {
  if (typeof text !== 'string' || text.length > 200) return null;
  try {
    const marker = JSON.parse(text);
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
    if (typeof marker.table !== 'string' || typeof marker.sysId !== 'string') return null;
    if (!TABLE_NAME_RE.test(marker.table) || !SYS_ID_RE.test(marker.sysId)) return null;
    if (!Number.isFinite(marker.at) || now - marker.at > PENDING_EDIT_TTL_MS || now < marker.at - 1000) return null;
    return { table: marker.table, sysId: marker.sysId.toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * True when the page on screen is the record the marker names: the same sys_id AND the same table (the row opened
 * `<table>.do`, with the table of the record's class, so the form on screen has exactly that table).
 */
export const pendingEditMatches = (marker, ctx = {}) =>
  Boolean(marker && ctx.sysId && ctx.table && String(ctx.sysId).toLowerCase() === marker.sysId.toLowerCase() && String(ctx.table) === marker.table);

// ---- Errors ----------------------------------------------------------------------------------------------------------

/**
 * What a failed request means for the table: 'denied' and 'missing' are final (skip the table for the session),
 * 'expired' means log in again, 'busy' and 'other' are worth another try later, 'aborted' is our own cancel, and
 * 'empty' is a 404 "No Record found": older releases answer an empty result that way, so it is zero rows, not an error.
 * (An unknown table is a 400 "Invalid table".)
 */
export function classifyError(err) {
  if (!err) return 'other';
  if (err.name === 'AbortError') return 'aborted';
  if (err.code === 'SESSION_EXPIRED') return 'expired';
  const message = String(err.message || err);
  if (/\(403\)|not allowed|not authorized/i.test(message)) return 'denied';
  if (/\(404\)/.test(message) && !/invalid table/i.test(message)) return 'empty';
  if (/\(400\)|invalid table|no such table|does not exist/i.test(message)) return 'missing';
  if (/\((?:429|503)\)|busy/i.test(message)) return 'busy';
  return 'other';
}

// ---- The search -----------------------------------------------------------------------------------------------------

const termKey = (term) => cleanTerm(term).toLowerCase();

/**
 * @param {object} deps
 * @param {(table: string, query: string, fields: string[], options: {limit: number, displayValue: boolean, signal?: AbortSignal}) => Promise<object[]>} deps.query
 *        read-only Table API call (queryTable); `signal` is passed so a newer search can abort an older one
 * @param {number} [deps.concurrency] requests in flight at once
 */
export function createGoToEngine({ query, concurrency = MAX_PARALLEL } = {}) {
  const unavailable = new Map(); // table -> 'denied' | 'missing' (for the page session)
  const cache = new Map(); // `${kind}|${term}|${mode}` -> candidates (for the open palette)
  const waiting = [];
  let active = 0;
  let generation = 0;
  let controller = null;

  function grant() {
    while (active < concurrency && waiting.length) {
      const next = waiting.shift();
      if (next.generation !== generation) next.resolve(false);
      else {
        active += 1;
        next.resolve(true);
      }
    }
  }

  function acquire(forGeneration) {
    return new Promise((resolve) => {
      waiting.push({ generation: forGeneration, resolve });
      grant();
    });
  }

  function release() {
    active -= 1;
    grant();
  }

  /** One request, counted against the parallel limit until it settles (aborted or not). */
  async function limited(gen, run) {
    if (!(await acquire(gen))) return null;
    try {
      return gen === generation ? await run() : null;
    } finally {
      release();
    }
  }

  function cancel() {
    generation += 1;
    if (controller) controller.abort();
    controller = null;
    grant(); // lets queued stale requests resolve now
  }

  async function search({ term, kinds, more = [], mode = 'bare', refine = true, onProgress } = {}) {
    cancel();
    const gen = generation;
    controller = new AbortController();
    const { signal } = controller;
    const limits = LIMITS[mode] || LIMITS.bare;
    const clean = cleanTerm(term);
    const minimum = mode === 'kind' ? MIN_TERM_KIND : MIN_TERM_BARE;
    const meta = { unavailable: [], failed: [], expired: false, searched: [], cached: [] };
    if (clean.length < minimum || unsafeTermReason(clean)) return { candidates: [], meta, complete: true };

    const byKind = new Map();
    const collect = () => [...byKind.values()].flat();
    const emit = () => {
      if (gen === generation && onProgress) onProgress({ candidates: collect(), meta });
    };

    // One request: null when superseded before it ran, else the candidates that really contain the text (see
    // answersTerm) and whether the instance sent a full page (so there may be more).
    async function round(kind, soql, limit) {
      if (!soql) return { candidates: [], full: false };
      const rows = await limited(gen, async () => {
        // After one request found the session expired, the rest are not sent. The flag is set before the slot is
        // released, so the next queued request already sees it.
        if (meta.expired) return [];
        try {
          return await query(kind.table, soql, fieldsFor(kind), { limit, displayValue: true, signal });
        } catch (err) {
          const reason = classifyError(err);
          if (reason === 'expired') meta.expired = true;
          if (reason === 'empty') return [];
          throw err;
        }
      });
      if (rows === null) return null;
      const list = Array.isArray(rows) ? rows : [];
      const candidates = list.map((row) => normalizeRow(kind, row)).filter((c) => c && answersTerm(c, clean));
      return { candidates, full: list.length >= limit };
    }

    async function forKind(id, position) {
      const kind = kindById(id);
      if (!kind || gen !== generation || meta.expired) return;
      if (unavailable.has(kind.table)) {
        meta.unavailable.push(id);
        return;
      }
      const key = `${id}|${termKey(clean)}|${mode}`;
      if (cache.has(key)) {
        byKind.set(id, cache.get(key));
        meta.cached.push(id);
        emit();
        return;
      }
      try {
        const first = await round(kind, buildSearchQuery(kind, clean), limits.first);
        if (first === null) return; // superseded before it ran
        let rows = first.candidates;
        if (gen === generation) {
          byKind.set(id, rows);
          emit();
        }
        // A full page means there may be more: ask for the names that START with the text, so an exact name is not lost.
        if (refine && first.full && position < BARE_KINDS - 3 && gen === generation) {
          const starts = await round(kind, buildStartsQuery(kind, clean), limits.starts);
          if (starts && starts.candidates.length) {
            const seen = new Set(rows.map((c) => c.id));
            rows = [...rows, ...starts.candidates.filter((c) => !seen.has(c.id))];
            if (gen === generation) {
              byKind.set(id, rows);
              emit();
            }
          }
        }
        // Only an answer to the search still on screen is kept: a request cut off by a newer keystroke can come back
        // empty or half read, and must not be served later as "nothing matched".
        if (gen !== generation || signal.aborted) return;
        cache.set(key, rows);
        meta.searched.push(id);
      } catch (err) {
        const reason = classifyError(err);
        if (reason === 'aborted' || gen !== generation) return;
        if (reason === 'denied' || reason === 'missing') {
          unavailable.set(kind.table, reason);
          meta.unavailable.push(id);
        } else if (reason === 'expired') meta.expired = true;
        else meta.failed.push({ kind: id, reason });
        emit();
      }
    }

    await Promise.all(kinds.map((id, position) => forKind(id, position)));
    // A rare name: the likely kinds found almost nothing, so try the rest of the catalogue before giving up.
    if (gen === generation && mode === 'bare' && more.length && collect().length < MIN_ROWS && !meta.expired) {
      await Promise.all(more.map((id) => forKind(id, BARE_KINDS)));
    }
    if (gen !== generation) return null;
    return { candidates: collect(), meta, complete: true };
  }

  return {
    search,
    cancel,
    /** Forget the results (the palette closed); tables that cannot be read stay skipped for the page session. */
    reset() {
      cache.clear();
    },
    /** Forget which tables cannot be read (for example after logging in again). */
    forgetUnavailable() {
      unavailable.clear();
    },
    isUnavailable: (table) => unavailable.has(table),
    unavailableTables: () => [...unavailable.keys()],
  };
}
