// Instance health and upgrade-readiness scan: rules, classification, scoring and
// report formatting. Pure functions only (no fetch, no DOM), so the whole rule set
// is unit-tested in tests/health.test.js. src/content/healthScan.js fetches the
// rows and feeds them in here.
//
// Precision over recall: every rule below is regex/heuristic based, so each one
// says what it can miss (`misses`) and rules that are too noisy on real code are
// dropped or downgraded rather than shown.

import { lintScript, maskNonCode } from './lint.js';
import { verifyScript, kindForTable, KIND_INFO } from './verify.js';
import { checkApiUsage } from './apiCheck.js';
import { toCsv } from './export.js';
import { redactSecrets } from '../providers/redact.js';

export const SEVERITY_WEIGHT = { high: 10, medium: 3, low: 1 };
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

export const CATEGORIES = [
  { id: 'security', label: 'Security' },
  { id: 'antipattern', label: 'Anti-patterns' },
  { id: 'upgrade', label: 'Upgrade readiness' },
  { id: 'code', label: 'Code quality' },
  { id: 'config', label: 'Configuration' },
];
const CATEGORY_RANK = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i]));
export const categoryLabel = (id) => CATEGORIES.find((c) => c.id === id)?.label || id;

/** Scan steps, in run order. `categories` are the report categories a step feeds. */
export const STEP_DEFS = [
  { id: 'collect', label: 'Find custom code', categories: [] },
  { id: 'code', label: 'Code quality', categories: ['code'] },
  { id: 'antipattern', label: 'Anti-patterns', categories: ['antipattern'] },
  { id: 'config', label: 'Configuration hygiene', categories: ['config'] },
  { id: 'upgrade', label: 'Upgrade readiness', categories: ['upgrade'] },
  { id: 'security', label: 'Security audit', categories: ['security'] },
];

export const MAX_PER_TABLE = 2000;
export const MAX_SCRIPT_CHARS = 150000;

/**
 * Script-bearing tables the scan reads. `scripts` are the code fields; `extra`
 * are columns the config checks need. Every column is checked against the
 * dictionary at run time and dropped (with a note) when the instance lacks it.
 * `gate` names a boolean column that must be true for the scripts to run at all.
 * `excludePrefixes` keep other tables' customer updates out of the
 * "<table>_<sys_id>" prefix search (sys_script_ also matches sys_script_include_).
 * `childClasses` are extending classes read through this table; a record's customer
 * update is named after its own class (sys_class_name), e.g. catalog_ui_policy_<sys_id>.
 */
export const SCAN_TABLES = [
  {
    table: 'sys_script',
    label: 'Business Rule',
    nameField: 'name',
    scripts: [{ field: 'script', side: 'server' }],
    extra: ['collection', 'when', 'order', 'condition', 'filter_condition', 'action_insert', 'action_update', 'action_delete', 'action_query'],
    excludePrefixes: ['sys_script_include_', 'sys_script_client_', 'sys_script_fix_', 'sys_script_email_', 'sys_script_validator_', 'sys_script_ajax_'],
  },
  {
    table: 'sys_script_include',
    label: 'Script Include',
    nameField: 'name',
    scripts: [{ field: 'script', side: 'server' }],
    extra: ['api_name', 'client_callable'],
  },
  {
    table: 'sys_script_client',
    label: 'Client Script',
    nameField: 'name',
    // Catalog client scripts extend this table; they are scanned on their own.
    exactClass: true,
    scripts: [{ field: 'script', side: 'client' }],
    extra: ['table', 'type'],
  },
  {
    table: 'catalog_script_client',
    label: 'Catalog Client Script',
    nameField: 'name',
    scripts: [{ field: 'script', side: 'client' }],
    extra: ['type'],
  },
  {
    table: 'sys_ui_action',
    label: 'UI Action',
    nameField: 'name',
    // Client or server depends on the record's "client" flag.
    scripts: [{ field: 'script', side: 'auto' }],
    extra: ['table', 'client'],
    excludePrefixes: ['sys_ui_action_view_', 'sys_ui_action_role_'],
  },
  {
    table: 'sys_ui_policy',
    label: 'UI Policy',
    nameField: 'short_description',
    scripts: [
      { field: 'script_true', side: 'client' },
      { field: 'script_false', side: 'client' },
    ],
    extra: ['table', 'run_scripts'],
    gate: 'run_scripts',
    // Catalog UI policies extend sys_ui_policy; their customer updates are named after their own class.
    childClasses: ['catalog_ui_policy'],
    excludePrefixes: ['sys_ui_policy_action_', 'sys_ui_policy_rl_action_', 'catalog_ui_policy_action_'],
  },
  {
    table: 'sysevent_script_action',
    label: 'Script Action',
    nameField: 'name',
    scripts: [{ field: 'script', side: 'server' }],
    extra: ['event_name'],
  },
  {
    table: 'sysauto_script',
    label: 'Scheduled Job',
    nameField: 'name',
    scripts: [{ field: 'script', side: 'server' }],
    extra: ['run_type', 'run_period'],
  },
  {
    table: 'sys_transform_script',
    label: 'Transform Script',
    nameField: 'map.name',
    scripts: [{ field: 'script', side: 'server' }],
    extra: ['when'],
  },
  {
    table: 'sys_processor',
    label: 'Processor',
    nameField: 'name',
    scripts: [{ field: 'script', side: 'server' }],
  },
  {
    table: 'sys_ws_operation',
    label: 'Scripted REST resource',
    nameField: 'name',
    scripts: [{ field: 'operation_script', side: 'server' }],
    extra: ['http_method'],
  },
  {
    table: 'sys_security_acl',
    label: 'ACL',
    nameField: 'name',
    scripts: [{ field: 'script', side: 'server' }],
    extra: ['operation', 'advanced'],
    excludePrefixes: ['sys_security_acl_role_'],
    // The script of an ACL only runs when "Advanced" is ticked.
    gate: 'advanced',
  },
  {
    table: 'sp_widget',
    label: 'Portal Widget',
    nameField: 'name',
    scripts: [
      { field: 'script', side: 'server' },
      { field: 'client_script', side: 'client', widget: true },
    ],
  },
  {
    table: 'sys_ui_script',
    label: 'UI Script',
    nameField: 'name',
    scripts: [{ field: 'script', side: 'client' }],
    extra: ['global'],
  },
];

export const scanTableDef = (table) => SCAN_TABLES.find((d) => d.table === table) || null;

/** Classes whose customer updates count for a scanned table: the table itself plus its childClasses. */
export const evidenceClasses = (def) => [def.table, ...(def.childClasses || [])];

/** Class name -> scanned table, for parsing update names (catalog_ui_policy -> sys_ui_policy). */
export function classToTable(defs = SCAN_TABLES) {
  const map = new Map();
  defs.forEach((d) => evidenceClasses(d).forEach((c) => map.set(c, d.table)));
  return map;
}

/**
 * Encoded query listing the customer updates for a scanned table: any of its classes'
 * "<class>_" prefixes, minus sibling tables that share the prefix. Names are re-parsed
 * exactly afterwards (parseUpdateName), so this only keeps the volume down.
 */
export function customerUpdateQuery(def) {
  const starts = evidenceClasses(def).map((c) => `nameSTARTSWITH${c}_`).join('^OR');
  const exclude = (def.excludePrefixes || []).map((p) => `^nameNOT LIKE${p}`).join('');
  return `${starts}${exclude}^ORDERBYDESCsys_updated_on`;
}

// ---- small helpers -----------------------------------------------------------------------------

const str = (v) => (v == null ? '' : typeof v === 'object' ? String(v.value ?? v.display_value ?? '') : String(v));
const isTrue = (v) => str(v) === 'true' || str(v) === '1';
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SYS_ID_RE = /^[0-9a-f]{32}$/;

export function recordLink(table, sysId) {
  return `/${table}.do?sys_id=${encodeURIComponent(sysId)}`;
}

function listLink(table, query) {
  return `/${table}_list.do?sysparm_query=${encodeURIComponent(query)}`;
}

function clip(text, max = 200) {
  const t = String(text || '').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

/** Replace the contents of every string literal on a line (used where the line may hold a secret). */
export function maskStringLiterals(line) {
  return String(line || '').replace(/(['"`])(?:(?!\1)[^\\]|\\.)*\1/g, "'***'");
}

/** Parse a ServiceNow UTC date-time ("2026-10-01 08:30:00") into epoch ms, or null. */
export function parseSnDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/.exec(str(value).trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

/**
 * Seconds in a glide_duration value. The Table API returns durations as a
 * date-time counted from the epoch ("1970-01-01 00:05:00" is five minutes).
 */
export function parseDuration(value) {
  const ms = parseSnDate(value);
  if (ms == null) return null;
  return Math.round(ms / 1000);
}

export function humanDuration(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * "<table>_<sys_id>" (the sys_update_xml naming convention) -> { table, sysId },
 * or null when the name is not for one of `tables`. Exact: sys_script_include_<id>
 * never parses as a sys_script name because "include_<id>" is not a sys_id.
 */
export function parseUpdateName(name, tables) {
  const m = /^([a-z0-9_]+)_([0-9a-f]{32})$/.exec(String(name || ''));
  if (!m || !tables.includes(m[1])) return null;
  return { table: m[1], sysId: m[2] };
}

// ---- options ----------------------------------------------------------------------------------

export const SCAN_MODES = ['instance', 'scope', 'updateset', 'recent'];

/**
 * Validate scan options. Everything that ends up in a query is checked here, so
 * the scan is safe to expose to the agent / MCP clients as-is.
 */
export function normalizeScanOptions(input = {}) {
  const mode = SCAN_MODES.includes(input.mode) ? input.mode : 'instance';
  const out = {
    mode,
    includeBaseline: Boolean(input.includeBaseline),
    includeSecurity: input.includeSecurity !== false,
    maxPerTable: Math.max(50, Math.min(MAX_PER_TABLE, Number(input.maxPerTable) || MAX_PER_TABLE)),
    tables: null,
  };
  if (Array.isArray(input.tables) && input.tables.length) {
    const known = input.tables.filter((t) => scanTableDef(t));
    if (!known.length) throw new Error(`Unknown table(s): ${input.tables.join(', ')}. Use: ${SCAN_TABLES.map((d) => d.table).join(', ')}.`);
    out.tables = known;
  }
  if (mode === 'scope') {
    const id = String(input.scopeId || '').trim();
    if (id !== 'global' && !SYS_ID_RE.test(id)) throw new Error('Choose an application scope to scan.');
    out.scopeId = id;
    out.scopeName = String(input.scopeName || '').slice(0, 120);
  }
  if (mode === 'updateset') {
    const id = String(input.updateSetId || '').trim();
    if (!SYS_ID_RE.test(id)) throw new Error('Choose an update set to scan.');
    out.updateSetId = id;
    out.updateSetName = String(input.updateSetName || '').slice(0, 120);
  }
  if (mode === 'recent') {
    const days = Math.round(Number(input.days));
    if (!Number.isFinite(days) || days < 1 || days > 365) throw new Error('Days must be a number from 1 to 365.');
    out.days = days;
    out.onlyMine = Boolean(input.onlyMine);
  }
  return out;
}

export function describeScope(options) {
  const o = options || {};
  const baseline = o.includeBaseline ? 'baseline records included' : 'custom records only';
  switch (o.mode) {
    case 'scope':
      return `Application ${o.scopeName || o.scopeId} (${o.scopeId === 'global' ? baseline : 'all records in the application'})`;
    case 'updateset':
      return `Update set ${o.updateSetName || o.updateSetId}`;
    case 'recent':
      return `Changed in the last ${o.days} day${o.days === 1 ? '' : 's'}${o.onlyMine ? ' by me' : ''} (${baseline})`;
    default:
      return `Whole instance (${baseline})`;
  }
}

// ---- rule catalog ------------------------------------------------------------------------------

/**
 * Anti-patterns. `sources` are lint/verify rule ids that detect the same thing;
 * those findings are re-labelled with this entry's explanation. `appliesTo`
 * restricts the rule to script contexts where it is reliably wrong.
 */
export const ANTI_PATTERNS = {
  'client-gliderecord': {
    title: 'GlideRecord in client-side code',
    severity: 'high',
    sources: ['no-gliderecord-in-client-script'],
    appliesTo: (ctx) => ctx.side === 'client',
    why: 'Client-side GlideRecord makes a synchronous server round trip, freezes the form while it waits, and does not work in Service Portal, mobile or workspaces.',
    fix: 'Move the lookup into a client-callable Script Include and call it with GlideAjax (getXMLAnswer with a callback), or use g_form.getReference(field, callback).',
    misses: 'Only `new GlideRecord(` is seen; a GlideRecord created elsewhere and passed in is not.',
  },
  'client-getxmlwait': {
    title: 'Synchronous GlideAjax (getXMLWait)',
    severity: 'high',
    sources: ['no-sync-glideajax'],
    appliesTo: (ctx) => ctx.side !== 'server',
    why: 'getXMLWait blocks the browser until the server answers, and it is not supported in Service Portal.',
    fix: 'Use getXMLAnswer(callback) or getXML(callback) and continue the logic in the callback.',
    misses: 'Calls made through a variable holding the method are not seen.',
  },
  'client-dom': {
    title: 'DOM manipulation in a client script',
    severity: 'medium',
    sources: ['no-dom-in-client-script'],
    appliesTo: (ctx) => ['client_script', 'catalog_client_script', 'ui_policy_script'].includes(ctx.kind),
    why: 'document, window, $(), jQuery and gel() depend on classic UI markup. They break in Service Portal, workspaces and mobile, and often after an upgrade changes the page.',
    fix: 'Use the g_form, g_user and g_scratchpad APIs. For changes g_form cannot make, use a UI Policy, or a portal widget for portal pages.',
    misses: 'Only client scripts, catalog client scripts and UI policy scripts are checked; UI scripts and widgets are expected to touch the DOM. Access through other globals (top, parent) is not seen.',
  },
  'br-current-update': {
    title: 'current.update() in a business rule',
    severity: 'high',
    sources: ['no-current-update-in-before-br'],
    appliesTo: (ctx) => ctx.kind === 'business_rule',
    why: 'Saving `current` again from a business rule re-runs every business rule, flow and audit for that record and can loop.',
    fix: 'In a before rule just set the fields (the platform saves them). In an after or async rule update a different record, or move the change into a before rule.',
    misses: 'Updates through another variable that points at the same record are not seen.',
  },
  'gs-sleep': {
    title: 'gs.sleep() in server code',
    severity: 'medium',
    sources: [],
    appliesTo: (ctx) => ctx.side === 'server',
    why: 'gs.sleep() holds a worker thread (or the user\'s transaction) while doing nothing; under load it starves the node of threads.',
    fix: 'Use a scheduled job, an event, or a flow wait condition instead of sleeping.',
    misses: 'Busy-wait loops that do not call gs.sleep() are not seen.',
  },
  eval: {
    title: 'eval() or new Function()',
    severity: 'high',
    sources: ['no-eval'],
    appliesTo: () => true,
    why: 'Running text as code is an injection risk, slow, and impossible to review or test.',
    fix: 'Parse data with JSON.parse and dispatch with a lookup object. If dynamic evaluation is unavoidable on the server, use GlideScopedEvaluator with a stored script.',
    misses: 'Indirect calls (window["eval"], setTimeout with a string) are not seen.',
  },
  'hardcoded-sys-id': {
    title: 'Hard-coded sys_id',
    severity: 'medium',
    sources: ['no-hardcoded-sys-id'],
    appliesTo: () => true,
    why: 'Records created separately on each instance have different sys_ids, so the script silently targets nothing (or the wrong record) after promotion.',
    fix: 'Look the record up by a stable key (name, number, code), or read the sys_id from a system property.',
    misses: 'Only quoted 32-character hex strings. Some baseline sys_ids are the same everywhere, so check before changing.',
  },
  'hardcoded-instance-url': {
    title: 'Hard-coded instance URL',
    severity: 'medium',
    sources: ['no-hardcoded-instance-url'],
    appliesTo: () => true,
    why: 'The URL points at one instance, so after a clone or promotion the script talks to the wrong environment.',
    fix: "Build URLs from gs.getProperty('glide.servlet.uri') on the server.",
    misses: 'Only *.service-now.com addresses; custom domains are not detected.',
  },
  'unbounded-query': {
    title: 'Query with no filter or limit',
    severity: 'medium',
    sources: ['no-unbounded-query'],
    appliesTo: (ctx) => ctx.side === 'server' || ctx.side === 'mixed',
    why: 'A GlideRecord query with no condition and no limit reads the whole table; it gets slower as data grows and can time out.',
    fix: 'Add addQuery/addEncodedQuery conditions, setLimit() when a sample is enough, or GlideAggregate for counts.',
    misses: 'Conditions added inside helper functions are not seen, so a query filtered elsewhere can be flagged by mistake.',
  },
  'nested-query': {
    title: 'Query inside a loop (N+1)',
    severity: 'medium',
    sources: ['no-query-in-loop'],
    appliesTo: () => true,
    why: 'One database query per loop iteration multiplies load: 1,000 rows means 1,000 extra queries.',
    fix: 'Collect the keys first and run one query with an IN condition, or use GlideAggregate or addJoinQuery.',
    misses: 'A query made by a helper function that the loop calls is not seen.',
  },
  'getrowcount-count': {
    title: 'getRowCount() used to count rows',
    severity: 'medium',
    sources: [],
    appliesTo: (ctx) => ctx.side === 'server',
    why: 'query() followed by getRowCount() fetches every matching row just to count them.',
    fix: "Use GlideAggregate: addAggregate('COUNT'), query(), then getAggregate('COUNT').",
    misses: 'Only flags a GlideRecord that is never iterated with next(); counting a result you also loop over is not flagged.',
  },
  'onchange-no-isloading': {
    title: 'onChange script without an isLoading check',
    severity: 'medium',
    sources: ['client-onchange-guard'],
    appliesTo: () => true,
    why: 'onChange scripts also run while the form loads. Without an isLoading check they do work (and server calls) on every form load and can overwrite loaded values.',
    fix: "Start the function with: if (isLoading || newValue === '') { return; }",
    misses: 'Only scripts whose type is onChange (or that declare function onChange).',
  },
  'global-ui-script': {
    title: 'Global UI script',
    severity: 'low',
    sources: [],
    appliesTo: () => true,
    why: 'A global UI script is downloaded and run on every classic UI page for every user, whether the page needs it or not.',
    fix: 'Untick Global and load the script only where it is needed, or move the logic into the client scripts that use it.',
    misses: 'Only the Global flag is checked.',
  },
  'hardcoded-credential': {
    title: 'Credential or secret in a script',
    severity: 'high',
    category: 'security',
    sources: ['no-embedded-credentials'],
    appliesTo: () => true,
    why: 'Anyone who can read the record, or an update set that contains it, can read the secret, and it is copied to every instance the script is promoted to.',
    fix: 'Move it to a Connection & Credential alias, a credential record or an encrypted (password2) system property.',
    misses: 'Only values assigned to names containing password, secret, token or api key.',
  },
};

const SOURCE_TO_PATTERN = Object.fromEntries(
  Object.entries(ANTI_PATTERNS).flatMap(([id, p]) => p.sources.map((s) => [s, id]))
);

// Lint / verify rules left out of the scan: duplicates of another rule, too noisy on
// real code, or advice rather than a defect.
const EXCLUDED_RULES = new Set([
  'api-unverified-method', // "may still exist": the catalog is not complete
  'es6-syntax', // depends on the application's JavaScript mode, which is not read
  'acl-no-answer', // an ACL script may return its result instead of setting answer
  'no-gs-log-scoped', // same line is reported by api-deprecated
  'no-g-form-server-side', // same line is reported by api-wrong-side
  'set-workflow-false', // intentional in most scripts that use it
  'unknown-field',
  'unknown-kind',
  'empty',
]);

const SEVERITY_OVERRIDES = { 'no-delete-multiple': 'low' };

const CODE_CATEGORY = { 'api-deprecated': 'upgrade', 'api-unsupported-ui': 'upgrade' };

/** Generic titles for code rules (their messages name variables, so they cannot be grouped on). */
export const CODE_RULE_TITLES = {
  'syntax-error': 'Syntax error',
  'no-abort-in-after-br': 'setAbortAction() in an after or async business rule',
  'no-sync-getreference': 'Synchronous g_form.getReference()',
  'no-delete-multiple': 'deleteMultiple() bulk delete',
  'no-alert-in-client-script': 'alert() in a client script',
  'no-console-log-server': 'console.log() in server code',
  'client-missing-handler': 'Client script handler function missing',
  'client-onchange-signature': 'Incomplete onChange signature',
  'client-onsubmit-return': 'onSubmit never returns a value',
  'client-oncelledit-callback': 'onCellEdit never calls callback()',
  'ajax-missing-sysparm-name': 'GlideAjax without sysparm_name',
  'ajax-no-callback': 'GlideAjax call without a callback',
  'server-browser-global': 'Browser-only API in server code',
  'scoped-packages': 'Packages.* in a scoped application',
  'gr-next-without-query': 'next() called without query()',
  'gr-modifier-after-query': 'Condition added after query()',
  'br-previous-in-async': '`previous` in an async business rule',
  'job-current': '`current` in a scheduled job',
  'si-ajax-not-extended': 'getParameter() without AbstractAjaxProcessor',
  'si-missing-type': 'Script Include without a type property',
  'api-wrong-side': 'Client API on the server, or server API in the browser',
  'api-unknown-method': 'Call to a method that does not exist',
  'api-deprecated': 'Deprecated or discouraged API',
  'api-scope-mismatch': 'API not available in this scope',
  'api-unsupported-ui': 'API not supported in Service Portal or workspaces',
};

/** Configuration, upgrade and security rules (record-level, not line-level). */
export const RECORD_RULES = {
  'br-no-condition-hot-table': {
    category: 'config',
    title: 'Business rule with no condition on a busy table',
    why: 'It runs for every matching operation on a high-volume table, so its script executes on every record change.',
    fix: 'Add a filter condition or condition script so it runs only when the fields it cares about change (for example current.state.changes()).',
    misses: 'Only these tables: task and its common children, approvals, users and groups, and cmdb_ci classes. Query and display rules are not checked.',
  },
  'br-same-order': {
    category: 'config',
    title: 'Business rules share one order',
    why: 'Rules with the same order, table and timing run in no guaranteed sequence, so if they touch the same fields the result can differ.',
    fix: 'Give each rule its own order value in the sequence you intend.',
    misses: 'Only groups of two or more scanned (custom) rules; a custom rule sharing an order with a baseline rule is not flagged.',
  },
  'si-client-callable-no-acl': {
    category: 'config',
    title: 'Client-callable Script Include without an ACL',
    why: 'Any user who can make a GlideAjax request can call its methods. A client_callable_script_include ACL restricts who may call it.',
    fix: 'Create an ACL of type client_callable_script_include for it with the roles that need it, and check permissions inside each method too.',
    misses: 'ACLs are matched by name only; permission checks inside the methods are not considered.',
  },
  'job-too-frequent': {
    category: 'config',
    title: 'Scheduled job runs very often',
    why: 'Each run takes a scheduler worker; frequent jobs crowd out other background work and multiply any slow query.',
    fix: 'Run it less often, or trigger the work from an event or flow when the data actually changes.',
    misses: 'Only "Periodically" jobs; jobs started from other jobs or triggers are not seen.',
  },
  'updateset-stale': {
    category: 'config',
    title: 'Update set in progress for a long time',
    why: 'Long-running update sets drift from the target instance, pick up unrelated changes and collide with other work.',
    fix: 'Complete it, move finished work out, or move unrelated changes to their own update set.',
    misses: 'Age is counted from when the update set was created. The Default update set is not checked.',
  },
  'updateset-large': {
    category: 'config',
    title: 'Very large update set',
    why: 'Very large update sets are hard to review, slow to preview and commit, and more likely to contain collisions.',
    fix: 'Split the work by feature or story; use a batch (parent) update set if the parts must ship together.',
    misses: 'Only update sets that are in progress. The Default update set is not checked.',
  },
  'upgrade-skipped': {
    category: 'upgrade',
    title: 'Skipped upgrade change not reviewed',
    why: 'The upgrade did not apply the new ServiceNow version of this record, usually because it was customized.',
    fix: 'Open the record, compare it with the base system version, then merge, revert to base, or mark it reviewed.',
    misses: 'Only the most recent upgrade, and only records your user can read.',
  },
};

// ---- per-script analysis -----------------------------------------------------------------------

const MIXED_UI_ACTION_RE = /\btypeof\s+window\s*[!=]==?\s*['"]undefined['"]|\bgsftSubmit\s*\(/;

/** How a script field of a record runs: side, verifier kind, timing, client type, scope. */
export function scriptContext(def, script, row) {
  const scoped = Boolean(str(row?.sys_scope)) && str(row?.sys_scope) !== 'global';
  const ctx = { side: script.side, kind: null, when: '', clientType: '', scoped, widget: Boolean(script.widget) };
  if (def.table === 'sys_ui_action') {
    if (isTrue(row?.client)) {
      // A client UI action that also runs server code (gsftSubmit + typeof window check).
      const code = str(row?.[script.field]);
      if (MIXED_UI_ACTION_RE.test(code)) ctx.side = 'mixed';
      else {
        ctx.side = 'client';
        ctx.kind = 'ui_action_client';
      }
    } else {
      ctx.side = 'server';
    }
    return ctx;
  }
  if (!script.widget) ctx.kind = kindForTable(def.table);
  if (ctx.kind && KIND_INFO[ctx.kind]?.side !== ctx.side) ctx.kind = null;
  if (def.table === 'sys_script') ctx.when = str(row?.when).toLowerCase();
  if (ctx.kind === 'client_script' || ctx.kind === 'catalog_client_script') ctx.clientType = str(row?.type);
  return ctx;
}

/** Raw lint + verify + API-catalog findings for one script. */
export function codeChecks(code, def, ctx) {
  if (!code || !code.trim()) return [];
  if (ctx.kind && KIND_INFO[ctx.kind]) {
    // esLevel es12: the application's JavaScript mode is not read, so ES2015+ syntax is not judged.
    return verifyScript({ code, kind: ctx.kind, when: ctx.when, clientType: ctx.clientType, scoped: ctx.scoped, esLevel: 'es12' }).findings;
  }
  // A mixed client/server UI action passes no side, so lint applies only its side-neutral rules.
  const side = ctx.side === 'client' || ctx.side === 'server' ? ctx.side : undefined;
  let raw = lintScript(code, { table: def.table, when: ctx.when, side });
  if (ctx.side === 'client' || ctx.side === 'server') raw = raw.concat(checkApiUsage(code, { side: ctx.side, scoped: ctx.scoped }));
  return raw;
}

const DOM_RE = /(?<![\w$.])(?:document|window)\s*\.|(?<![\w$.])\$\$?\s*\(|(?<![\w$.])(?:jQuery|\$j)\s*[.(]|(?<![\w$.])gel\s*\(/;
const CLIENT_GR_RE = /(?<![\w$.])new\s+GlideRecord\s*\(/;
const CURRENT_UPDATE_RE = /(?<![\w$.])current\s*\.\s*update\s*\(/;
const GS_SLEEP_RE = /(?<![\w$.])gs\s*\.\s*sleep\s*\(/;
const NEW_FUNCTION_RE = /(?<![\w$.])new\s+Function\s*\(/;

/** Anti-pattern detectors that lint/verify do not already cover. Returns [{ patternId, line, severity? }]. */
export function antiPatternChecks(code, def, ctx, maskedCode = null) {
  if (!code || !code.trim()) return [];
  const masked = maskedCode ?? maskNonCode(code);
  const lines = masked.split('\n');
  const hits = [];
  const add = (patternId, line, severity) => hits.push({ patternId, line, severity });

  lines.forEach((text, i) => {
    if (!text.trim()) return;
    const line = i + 1;
    if (ANTI_PATTERNS['client-dom'].appliesTo(ctx) && DOM_RE.test(text)) add('client-dom', line);
    if (ctx.side === 'client' && CLIENT_GR_RE.test(text)) add('client-gliderecord', line);
    if (ctx.kind === 'business_rule' && CURRENT_UPDATE_RE.test(text)) add('br-current-update', line, ctx.when === 'async' ? 'medium' : 'high');
    if (ctx.side === 'server' && GS_SLEEP_RE.test(text)) add('gs-sleep', line);
    if (NEW_FUNCTION_RE.test(text)) add('eval', line);
  });

  if (ctx.side === 'server') {
    const names = new Set();
    for (const m of masked.matchAll(/(?<![.\w$])(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:GlideRecord|GlideRecordSecure)\s*\(/g)) names.add(m[1]);
    names.forEach((name) => {
      const esc = escapeRe(name);
      const count = new RegExp(`(?<![\\w$.])${esc}\\s*\\.\\s*getRowCount\\s*\\(`).exec(masked);
      if (!count) return;
      const iterates = new RegExp(`(?<![\\w$.])${esc}\\s*\\.\\s*(?:next|_next|hasNext)\\s*\\(`).test(masked);
      if (!iterates) add('getrowcount-count', lineOf(masked, count.index));
    });
  }
  return hits;
}

// Deprecated-API notes (from apiCheck messages, which start with the API name) that an
// anti-pattern in the same script already covers.
const API_COVERED_BY = {
  'client-gliderecord': /^GlideRecord\b/,
  'client-getxmlwait': /^GlideAjax\.(?:getXMLWait|getAnswer)\(/,
  'client-dom': /^(?:g_form\.(?:getControl|getElement|getDisplayBox)\(|globals\b)/,
};

// Raw-line rules (they look inside string literals) must not fire on a comment line.
const RAW_LINE_RULES = new Set(['no-hardcoded-sys-id', 'no-hardcoded-instance-url', 'no-embedded-credentials']);

function excerptFor(rawLine, ruleId) {
  const masked = ruleId === 'hardcoded-credential' ? maskStringLiterals(rawLine) : rawLine;
  return clip(redactSecrets(masked));
}

/**
 * Analyse one script field of one record. Returns final, collapsed findings
 * (one per rule per field, with every line it occurs on).
 *
 * @param {{code: string, def: object, script: {field, side, widget?}, record: {sysId, name, scope?, row}}} input
 */
export function scanScript({ code, def, script, record }) {
  if (!code || !code.trim()) return [];
  const ctx = scriptContext(def, script, record.row);
  const rawLines = code.split('\n');
  const masked = maskNonCode(code);
  const maskedLines = masked.split('\n');

  const patternHits = [];
  const codeHits = [];

  codeChecks(code, def, ctx).forEach((f) => {
    if (EXCLUDED_RULES.has(f.ruleId)) return;
    if (f.ruleId === 'api-unknown-method' && f.severity !== 'high') return;
    if (RAW_LINE_RULES.has(f.ruleId) && !(maskedLines[f.line - 1] || '').trim()) return;
    const patternId = SOURCE_TO_PATTERN[f.ruleId];
    if (patternId) {
      if (ANTI_PATTERNS[patternId].appliesTo(ctx)) patternHits.push({ patternId, line: f.line });
      return;
    }
    codeHits.push(f);
  });
  antiPatternChecks(code, def, ctx, masked).forEach((h) => patternHits.push(h));

  const patternLines = new Set(patternHits.map((h) => h.line));
  const firedPatterns = new Set(patternHits.map((h) => h.patternId));
  const coveredByPattern = (f) =>
    (f.ruleId === 'api-deprecated' || f.ruleId === 'api-unsupported-ui') &&
    (patternLines.has(f.line) || Object.entries(API_COVERED_BY).some(([id, re]) => firedPatterns.has(id) && re.test(f.message || '')));
  const groups = new Map();
  const push = (key, entry) => {
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...entry, lines: [entry.line] });
      return;
    }
    if (!existing.lines.includes(entry.line)) existing.lines.push(entry.line);
    if (SEVERITY_ORDER[entry.severity] < SEVERITY_ORDER[existing.severity]) existing.severity = entry.severity;
  };

  patternHits.forEach((h) => {
    const p = ANTI_PATTERNS[h.patternId];
    push(`p|${h.patternId}`, {
      category: p.category || 'antipattern',
      ruleId: h.patternId,
      severity: h.severity || p.severity,
      title: p.title,
      why: p.why,
      fix: p.fix,
      line: h.line,
    });
  });
  codeHits.forEach((f) => {
    // The anti-pattern already explains it better (client GlideRecord, getXMLWait, $()).
    if (coveredByPattern(f)) return;
    push(`c|${f.ruleId}`, {
      category: CODE_CATEGORY[f.ruleId] || 'code',
      ruleId: f.ruleId,
      severity: SEVERITY_OVERRIDES[f.ruleId] || f.severity,
      title: CODE_RULE_TITLES[f.ruleId] || f.message,
      why: f.message,
      fix: f.suggestion,
      line: f.line,
    });
  });

  return [...groups.values()].map((g) => {
    const lines = g.lines.sort((a, b) => a - b);
    return makeFinding({
      ...g,
      def,
      record,
      field: script.field,
      line: lines[0],
      lines: lines.slice(0, 25),
      occurrences: lines.length,
      excerpt: excerptFor(rawLines[lines[0] - 1] || '', g.ruleId),
    });
  });
}

/** Record-level anti-patterns (no line): global UI scripts. */
export function recordChecks(def, record) {
  if (def.table === 'sys_ui_script' && isTrue(record.row?.global)) {
    const p = ANTI_PATTERNS['global-ui-script'];
    return [makeFinding({ category: 'antipattern', ruleId: 'global-ui-script', severity: p.severity, title: p.title, why: p.why, fix: p.fix, def, record, field: 'global' })];
  }
  return [];
}

function makeFinding({ category, ruleId, severity, title, why, fix, def, record, field = '', line = 0, lines = [], occurrences = 1, excerpt = '', link, recordName, table, tableLabel }) {
  const t = table || def?.table || '';
  const sysId = record?.sysId || '';
  return {
    id: `${t}:${sysId}:${field}:${ruleId}`,
    category,
    ruleId,
    severity,
    title,
    why,
    fix,
    table: t,
    tableLabel: tableLabel || def?.label || t,
    sysId,
    recordName: recordName || record?.name || '(unnamed)',
    scope: record?.scope || '',
    field,
    line,
    lines,
    occurrences,
    excerpt,
    link: link || (t && sysId ? recordLink(t, sysId) : ''),
  };
}

// ---- configuration checks ----------------------------------------------------------------------

const HOT_TABLES = new Set([
  'task',
  'incident',
  'problem',
  'change_request',
  'change_task',
  'sc_request',
  'sc_req_item',
  'sc_task',
  'sysapproval_approver',
  'sys_user',
  'sys_user_group',
  'sys_user_grmember',
  'cmdb_ci',
]);

export const isHotTable = (table) => HOT_TABLES.has(table) || /^(?:u_)?cmdb_ci_/.test(table);

const isEmptyFilter = (v) => !str(v).trim() || /^\^?EQ$/.test(str(v).trim());
const BR_ACTIONS = ['insert', 'update', 'delete', 'query'];
const brActions = (row) => BR_ACTIONS.filter((a) => isTrue(row[`action_${a}`]));

function recordRule(ruleId, extra) {
  const r = RECORD_RULES[ruleId];
  return makeFinding({ category: r.category, ruleId, title: r.title, why: r.why, fix: r.fix, ...extra });
}

/** Business rules with no condition and no filter on high-volume tables. `records` are scanned sys_script rows. */
export function checkBusinessRules(records) {
  const def = scanTableDef('sys_script');
  const findings = [];
  records.forEach((record) => {
    const row = record.row || {};
    const table = str(row.collection);
    const when = str(row.when).toLowerCase();
    if (!isHotTable(table) || !when || when === 'display') return;
    const actions = brActions(row).filter((a) => a !== 'query');
    if (!actions.length) return; // query-only rules are condition-less by design
    if (str(row.condition).trim() || !isEmptyFilter(row.filter_condition)) return;
    findings.push(
      recordRule('br-no-condition-hot-table', {
        def,
        record,
        field: 'filter_condition',
        severity: when.startsWith('async') ? 'medium' : 'low',
        why: `Runs ${when} every ${actions.join('/')} on ${table}, a high-volume table, with no condition, so its script executes on every one of those changes.${when.startsWith('async') ? ' Each async run is also a scheduled job.' : ''}`,
      })
    );
  });
  return findings;
}

/** Two or more scanned business rules on one table, timing and order whose actions overlap. */
export function checkBusinessRuleOrder(records) {
  const def = scanTableDef('sys_script');
  const groups = new Map();
  records.forEach((record) => {
    const row = record.row || {};
    const table = str(row.collection);
    const when = str(row.when).toLowerCase();
    const order = str(row.order).trim();
    if (!table || !when || order === '') return;
    const key = `${table}|${when}|${order}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });
  const findings = [];
  groups.forEach((group, key) => {
    if (group.length < 2) return;
    const counts = {};
    group.forEach((r) => brActions(r.row || {}).forEach((a) => (counts[a] = (counts[a] || 0) + 1)));
    const shared = Object.keys(counts).filter((a) => counts[a] > 1);
    if (!shared.length) return;
    const [table, when, order] = key.split('|');
    const names = group.map((r) => `"${r.name}"`).sort();
    findings.push(
      recordRule('br-same-order', {
        def,
        record: group[0],
        severity: 'low',
        recordName: `${group.length} rules on ${table}`,
        field: 'order',
        why: `${names.join(', ')} all run ${when} ${shared.join('/')} on ${table} at order ${order}. Rules with the same order run in no guaranteed sequence, so if they touch the same fields the result can differ.`,
        link: listLink('sys_script', `collection=${table}^when=${when}^order=${order}^active=true`),
        excerpt: names.join(', '),
      })
    );
  });
  return findings;
}

/**
 * Client-callable Script Includes with no client_callable_script_include ACL.
 * `aclNames` is a Set of the names of active ACLs of that type.
 */
export function checkClientCallable(records, aclNames) {
  if (aclNames.has('*')) return [];
  const def = scanTableDef('sys_script_include');
  return records
    .filter((record) => isTrue(record.row?.client_callable))
    .filter((record) => {
      const name = str(record.row?.name);
      const api = str(record.row?.api_name);
      const candidates = [name, api, api.split('.').pop()].filter(Boolean);
      return !candidates.some((c) => aclNames.has(c));
    })
    .map((record) => recordRule('si-client-callable-no-acl', { def, record, severity: 'medium', field: 'client_callable' }));
}

/** Periodic scheduled jobs that run every five minutes or more often. */
export function checkScheduledJobs(records) {
  const def = scanTableDef('sysauto_script');
  const findings = [];
  records.forEach((record) => {
    const row = record.row || {};
    if (str(row.run_type) !== 'periodically') return;
    const seconds = parseDuration(row.run_period);
    if (!seconds || seconds <= 0 || seconds > 300) return;
    findings.push(
      recordRule('job-too-frequent', {
        def,
        record,
        field: 'run_period',
        severity: seconds <= 60 ? 'medium' : 'low',
        why: `Runs every ${humanDuration(seconds)}. Each run takes a scheduler worker; frequent jobs crowd out other background work and multiply any slow query.`,
      })
    );
  });
  return findings;
}

/**
 * In-progress update sets that are old or very large.
 * @param {Array} sets      sys_update_set rows (sys_id, name, sys_created_on, is_default)
 * @param {Map} entryCounts sys_id -> number of customer updates (missing = unknown)
 * @param {number} now      epoch ms
 */
export function checkUpdateSets(sets, entryCounts, now = Date.now()) {
  const findings = [];
  sets.forEach((set) => {
    if (isTrue(set.is_default) || str(set.name) === 'Default') return;
    const record = { sysId: str(set.sys_id), name: str(set.name) || '(unnamed)', row: set };
    const base = { table: 'sys_update_set', tableLabel: 'Update Set', record };
    const created = parseSnDate(set.sys_created_on);
    const inProgress = !str(set.state) || str(set.state) === 'in progress';
    if (created != null && inProgress) {
      const days = Math.floor((now - created) / 86400000);
      if (days > 30) {
        findings.push(
          recordRule('updateset-stale', {
            ...base,
            field: 'state',
            severity: days > 90 ? 'medium' : 'low',
            why: `In progress for ${days} days. Long-running update sets drift from the target instance, pick up unrelated changes and collide with other work.`,
          })
        );
      }
    }
    const count = entryCounts.get(record.sysId);
    if (Number.isFinite(count) && count >= 500) {
      findings.push(
        recordRule('updateset-large', {
          ...base,
          field: 'entries',
          severity: count >= 2000 ? 'medium' : 'low',
          why: `${count} customer updates. Very large update sets are hard to review, slow to preview and commit, and more likely to contain collisions.`,
        })
      );
    }
  });
  return findings;
}

/**
 * Skipped-and-not-reviewed records from the upgrade log. Rows: sys_upgrade_history_log.
 * `dispositionLabels` maps a disposition value to its label ("Skipped", "Skipped Manual Merge"...).
 */
export function skippedUpgradeFindings(rows, { upgradeLabel = 'last', dispositionLabels = new Map() } = {}) {
  return rows.map((row) => {
    const priority = Number(str(row.priority)) || 5;
    const type = str(row.type) || 'record';
    const name = str(row.target_name) || str(row.file_name) || '(unnamed)';
    const disposition = dispositionLabels.get(str(row.disposition)) || 'Skipped';
    return recordRule('upgrade-skipped', {
      table: 'sys_upgrade_history_log',
      tableLabel: 'Upgrade log',
      record: { sysId: str(row.sys_id), name, row },
      field: 'disposition',
      severity: priority <= 2 ? 'medium' : 'low',
      why: `The ${upgradeLabel} upgrade did not apply the new ServiceNow version of this ${type} (${disposition}, priority ${priority}), usually because it was customized.`,
      excerpt: clip(str(row.file_name)),
    });
  });
}

const SECURITY_FIX = {
  ACL: 'Add a role, condition or script to the ACL, or deactivate it if nothing needs it.',
  'Public access': 'Remove public access unless the page must work without login, and check what data it returns.',
  'System property': 'Set the property back to its secure value after checking what depends on the current setting.',
  Roles: 'Review who holds admin and remove it where a narrower role will do.',
  'Scripted REST': 'Require authentication and ACL authorization on the resource unless it must be public.',
};

/** Map runSecurityAudit() output (src/content/securityAudit.js) into health findings. */
export function securityFindings(audit) {
  return (audit?.findings || []).map((f, index) => {
    const m = /^\/([a-z0-9_]+?)(?:_list)?\.do\?(?:sys_id=([0-9a-f]{32}))?/.exec(f.link || '');
    const slug = String(f.category || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const finding = makeFinding({
      category: 'security',
      ruleId: `security-${slug}`,
      severity: f.severity || 'low',
      title: f.message,
      why: f.detail || '',
      fix: SECURITY_FIX[f.category] || 'Review the record and fix it if the setting is not intentional.',
      table: m?.[1] || '',
      tableLabel: f.category || 'Security',
      // The audit message names the record in quotes ('ACL "x" (write) grants...'); otherwise use the category.
      record: { sysId: m?.[2] || '', name: /"([^"]+)"/.exec(f.message || '')?.[1] || f.category || 'Instance' },
      link: f.link || '',
    });
    finding.id = `security:${index}:${finding.id}`;
    return finding;
  });
}

// ---- scoring and report ------------------------------------------------------------------------

export function countBySeverity(findings) {
  const counts = { high: 0, medium: 0, low: 0 };
  findings.forEach((f) => {
    if (f.severity in counts) counts[f.severity] += 1;
  });
  return counts;
}

export const weightedPoints = (counts) => counts.high * SEVERITY_WEIGHT.high + counts.medium * SEVERITY_WEIGHT.medium + counts.low * SEVERITY_WEIGHT.low;

const RATINGS = {
  good: 'Nothing found',
  minor: 'Minor issues',
  review: 'Worth a review',
  attention: 'Needs attention',
  partial: 'Partly checked',
  'not-run': 'Not checked',
};

/**
 * Coarse, explainable rating: driven by the worst severity present, not a made-up percentage.
 * `ran` is true, false (the check did not run) or 'partial' (some of it could not run), so a
 * check that failed is never shown as "Nothing found".
 */
export function rateCounts(counts, ran = true) {
  let rating = 'good';
  if (counts.high) rating = 'attention';
  else if (counts.medium) rating = 'review';
  else if (counts.low) rating = 'minor';
  else if (ran === 'partial') rating = 'partial';
  else if (!ran) rating = 'not-run';
  return { rating, ratingLabel: RATINGS[rating] };
}

export function summarizeCategories(findings, steps = []) {
  return CATEGORIES.map((c) => {
    const own = findings.filter((f) => f.category === c.id);
    const counts = countBySeverity(own);
    const step = steps.find((s) => STEP_DEFS.find((d) => d.id === s.id)?.categories.includes(c.id));
    const ran = !step || step.status === 'done' ? true : step.status === 'partial' ? 'partial' : false;
    return {
      id: c.id,
      label: c.label,
      counts,
      total: own.length,
      records: new Set(own.map((f) => `${f.table}:${f.sysId}`)).size,
      points: weightedPoints(counts),
      status: step?.status || 'done',
      partial: ran !== true,
      ...rateCounts(counts, ran),
    };
  });
}

export function compareFindings(a, b) {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    (CATEGORY_RANK[a.category] ?? 9) - (CATEGORY_RANK[b.category] ?? 9) ||
    (b.occurrences || 1) - (a.occurrences || 1) ||
    a.ruleId.localeCompare(b.ruleId) ||
    a.recordName.localeCompare(b.recordName) ||
    (a.line || 0) - (b.line || 0)
  );
}

/** The `n` most important findings, at most `perRule` from any one rule so one noisy rule cannot fill the list. */
export function pickTop(findings, n = 10, perRule = 2) {
  const sorted = [...findings].sort(compareFindings);
  const top = [];
  const perRuleCount = {};
  sorted.forEach((f) => {
    if (top.length >= n) return;
    if ((perRuleCount[f.ruleId] || 0) >= perRule) return;
    perRuleCount[f.ruleId] = (perRuleCount[f.ruleId] || 0) + 1;
    top.push(f);
  });
  if (top.length < n) {
    const chosen = new Set(top);
    sorted.forEach((f) => {
      if (top.length < n && !chosen.has(f)) top.push(f);
    });
    top.sort(compareFindings);
  }
  return top;
}

const ruleMeta = (ruleId) => ANTI_PATTERNS[ruleId] || RECORD_RULES[ruleId] || null;

/** One row per rule: how often it fired, in how many records, worst severity. */
export function aggregateByRule(findings) {
  const byRule = new Map();
  findings.forEach((f) => {
    let entry = byRule.get(f.ruleId);
    if (!entry) {
      const meta = ruleMeta(f.ruleId);
      const generic = Boolean(meta) || Boolean(CODE_RULE_TITLES[f.ruleId]);
      entry = {
        ruleId: f.ruleId,
        category: f.category,
        title: meta?.title || CODE_RULE_TITLES[f.ruleId] || f.title,
        severity: f.severity,
        count: 0,
        occurrences: 0,
        records: new Set(),
        why: meta?.why || (generic ? '' : f.why),
        fix: meta?.fix || f.fix,
        misses: meta?.misses || '',
        counts: { high: 0, medium: 0, low: 0 },
      };
      byRule.set(f.ruleId, entry);
    }
    entry.count += 1;
    entry.occurrences += f.occurrences || 1;
    entry.records.add(`${f.table}:${f.sysId}`);
    entry.counts[f.severity] += 1;
    if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[entry.severity]) entry.severity = f.severity;
  });
  return [...byRule.values()]
    .map((e) => ({ ...e, records: e.records.size, points: weightedPoints(e.counts) }))
    .sort((a, b) => b.points - a.points || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title));
}

/**
 * Assemble the report. Everything derived (rules, categories, top 10, totals)
 * is computed here so the panel, exports and the AI digest agree.
 */
export function buildReport({ findings = [], steps = [], tables = [], options = {}, baseline = {}, notes = [], origin = '', startedAt = 0, finishedAt = 0, cancelled = false }) {
  const sorted = [...findings].sort(compareFindings);
  const scannedTables = tables.filter((t) => t.status === 'scanned');
  return {
    version: 1,
    origin,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    cancelled,
    options,
    scopeLabel: describeScope(options),
    baseline,
    steps,
    tables,
    notes,
    scanned: {
      tables: scannedTables.length,
      records: scannedTables.reduce((n, t) => n + (t.records || 0), 0),
      scripts: scannedTables.reduce((n, t) => n + (t.scripts || 0), 0),
      lines: scannedTables.reduce((n, t) => n + (t.lines || 0), 0),
    },
    totals: countBySeverity(sorted),
    findings: sorted,
    rules: aggregateByRule(sorted),
    categories: summarizeCategories(sorted, steps),
    top: pickTop(sorted, 10),
  };
}

/** Panel filters. `severity`, `category` and `table` are exact ids or 'all'; `text` is a case-insensitive substring. */
export function filterFindings(findings, { severity = 'all', category = 'all', table = 'all', text = '' } = {}) {
  const needle = String(text || '').trim().toLowerCase();
  return findings.filter(
    (f) =>
      (severity === 'all' || f.severity === severity) &&
      (category === 'all' || f.category === category) &&
      (table === 'all' || f.table === table) &&
      (!needle || `${f.title} ${f.recordName} ${f.excerpt} ${f.ruleId}`.toLowerCase().includes(needle))
  );
}

/** Not-checked items for the report: unavailable tables, failed or skipped steps. */
export function notCheckedList(report) {
  const items = [];
  (report.tables || []).forEach((t) => {
    if (t.status !== 'scanned') items.push(`${t.label} (${t.table}): ${t.note || t.status}`);
    else if (t.missing?.length) items.push(`${t.label}: columns not on this instance: ${t.missing.join(', ')}`);
  });
  (report.steps || []).forEach((s) => {
    if (s.status !== 'done' && s.status !== 'pending') items.push(`${s.label}: ${s.status}${s.detail ? ` - ${s.detail}` : ''}`);
    (s.notes || []).forEach((n) => items.push(`${s.label}: ${n}`));
  });
  return items;
}

// ---- exports -----------------------------------------------------------------------------------

const absolute = (origin, link) => (link && link.startsWith('/') && origin ? `${origin}${link}` : link || '');
const md = (text) => String(text ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const where = (f) => `${f.tableLabel} "${f.recordName}"${f.field ? ` ${f.field}` : ''}${f.line ? ` line ${f.line}${f.occurrences > 1 ? ` (+${f.occurrences - 1} more)` : ''}` : ''}`;

export function reportToMarkdown(report, { maxFindings = 2000 } = {}) {
  const lines = [
    '# Instance health scan',
    '',
    `Instance: ${report.origin || 'unknown'}  `,
    `Generated: ${new Date(report.finishedAt || Date.now()).toISOString()}  `,
    `Scope: ${report.scopeLabel}  `,
    `Scanned: ${report.scanned.records} records (${report.scanned.scripts} scripts, ${report.scanned.lines} lines) in ${report.scanned.tables} tables  `,
    `Custom code detection: ${report.baseline?.label || 'n/a'}`,
    '',
  ];
  if (report.cancelled) lines.push('> The scan was cancelled; results are partial.', '');
  lines.push(
    'Rules-based scan (regex and heuristics, not a parser): read each flagged line before changing it. Ratings follow the worst severity found; the score weighs high x10, medium x3, low x1.',
    '',
    '## Summary',
    '',
    '| Category | Rating | High | Medium | Low | Score |',
    '| --- | --- | --- | --- | --- | --- |'
  );
  report.categories.forEach((c) => lines.push(`| ${c.label} | ${c.ratingLabel} | ${c.counts.high} | ${c.counts.medium} | ${c.counts.low} | ${c.points} |`));

  lines.push('', '## Top issues', '');
  if (!report.top.length) lines.push('No findings.');
  report.top.forEach((f, i) => {
    lines.push(`${i + 1}. **[${f.severity.toUpperCase()}] ${md(f.title)}**: ${md(where(f))}${f.link ? ` ([open](${absolute(report.origin, f.link)}))` : ''}`);
    if (f.excerpt) lines.push(`   \`${f.excerpt.replace(/`/g, "'")}\``);
    lines.push(`   Why: ${md(f.why)}`, `   Fix: ${md(f.fix)}`);
  });

  if (report.rules.length) {
    lines.push('', '## By rule', '', '| Rule | Category | Worst | Findings | Records |', '| --- | --- | --- | --- | --- |');
    report.rules.forEach((r) => lines.push(`| ${md(r.title)} (\`${r.ruleId}\`) | ${categoryLabel(r.category)} | ${r.severity} | ${r.count} | ${r.records} |`));
  }

  lines.push('', '## All findings', '');
  CATEGORIES.forEach((c) => {
    const own = report.findings.filter((f) => f.category === c.id);
    if (!own.length) return;
    lines.push(`### ${c.label} (${own.length})`, '', '| Severity | Issue | Where | Excerpt |', '| --- | --- | --- | --- |');
    own.slice(0, maxFindings).forEach((f) => {
      const whereText = f.link ? `[${md(where(f))}](${absolute(report.origin, f.link)})` : md(where(f));
      lines.push(`| ${f.severity} | ${md(f.title)} | ${whereText} | ${f.excerpt ? `\`${md(f.excerpt).replace(/`/g, "'")}\`` : ''} |`);
    });
    if (own.length > maxFindings) lines.push('', `${own.length - maxFindings} more not shown.`);
    lines.push('');
  });

  const notChecked = notCheckedList(report);
  if (notChecked.length) {
    lines.push('## Not checked', '');
    notChecked.forEach((n) => lines.push(`- ${md(n)}`));
    lines.push('');
  }
  return lines.join('\n');
}

export const CSV_COLUMNS = ['severity', 'category', 'rule', 'title', 'table', 'record', 'sys_id', 'field', 'line', 'occurrences', 'excerpt', 'why', 'fix', 'link'];

export function reportToCsv(report) {
  const rows = report.findings.map((f) => ({
    severity: f.severity,
    category: categoryLabel(f.category),
    rule: f.ruleId,
    title: f.title,
    table: f.table,
    record: f.recordName,
    sys_id: f.sysId,
    field: f.field,
    line: f.line ? String(f.line) : '',
    occurrences: String(f.occurrences || 1),
    excerpt: f.excerpt,
    why: f.why,
    fix: f.fix,
    link: absolute(report.origin, f.link),
  }));
  return toCsv(rows, CSV_COLUMNS);
}

/** Compact, redacted digest for "Ask AI for a remediation plan". */
export function buildRemediationPrompt(report, { maxChars = 9000 } = {}) {
  const parts = [
    'You are a senior ServiceNow architect. Below is a deterministic, rules-based health scan of the custom code and configuration on one instance (regex and heuristics, so some findings can be false positives).',
    'Write a prioritised remediation plan: group related findings into work items, order them by risk and effort (quick wins first when the risk is similar), say how to verify each fix, and point out any finding that looks like a false positive or an accepted design choice. Do not invent findings that are not listed.',
    '',
    `Scope: ${report.scopeLabel}`,
    `Scanned: ${report.scanned.records} records (${report.scanned.scripts} scripts) in ${report.scanned.tables} tables.${report.cancelled ? ' The scan was cancelled, so this is partial.' : ''}`,
    `Totals: ${report.totals.high} high, ${report.totals.medium} medium, ${report.totals.low} low.`,
    '',
    'Categories:',
    ...report.categories.map((c) => `- ${c.label}: ${c.ratingLabel} (${c.counts.high} high, ${c.counts.medium} medium, ${c.counts.low} low)`),
    '',
    'Rules (most weighted first):',
    ...report.rules.slice(0, 25).map((r) => `- [${r.severity}] ${r.title} (${r.ruleId}): ${r.count} finding(s) in ${r.records} record(s).${r.fix ? ` Usual fix: ${clip(r.fix, 160)}` : ''}`),
    '',
    'Top findings:',
    ...report.top.map((f, i) => `${i + 1}. [${f.severity}] ${f.title} - ${where(f)}${f.excerpt ? `: ${clip(f.excerpt, 160)}` : ''}`),
  ];
  const notChecked = notCheckedList(report);
  if (notChecked.length) parts.push('', 'Not checked:', ...notChecked.slice(0, 12).map((n) => `- ${n}`));
  const text = redactSecrets(parts.join('\n'));
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...(truncated)` : text;
}

/**
 * The report as an agent / MCP tool result: totals, categories, rule summary and the worst findings,
 * never the full finding list (thousands of rows on a large instance). Excerpts are redacted.
 */
export function compactReportForAgent(report, { maxFindings = 30, maxRules = 20 } = {}) {
  const findings = report.findings || [];
  return {
    scope: report.scopeLabel,
    partial: Boolean(report.cancelled),
    scanned: report.scanned,
    totals: report.totals,
    categories: (report.categories || []).map((c) => ({ category: c.label, rating: c.ratingLabel, ...c.counts })),
    rules: (report.rules || []).slice(0, maxRules).map((r) => ({ rule: r.ruleId, title: r.title, severity: r.severity, findings: r.count, records: r.records })),
    findings: findings.slice(0, maxFindings).map((f) => ({
      severity: f.severity,
      rule: f.ruleId,
      title: f.title,
      where: where(f),
      ...(f.excerpt ? { excerpt: redactSecrets(clip(f.excerpt, 200)) } : {}),
      fix: f.fix ? clip(f.fix, 200) : undefined,
      link: f.link || undefined,
    })),
    moreFindings: Math.max(0, findings.length - maxFindings),
    notChecked: notCheckedList(report).slice(0, 15),
  };
}
