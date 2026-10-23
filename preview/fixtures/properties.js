// Dev-only (not shipped): fake answers for the System properties panel in the preview harness (see preview/fixtures/index.js).
// Answers: sys_properties (list, count, one record, PATCH that changes the value), and the script tables the "Who reads it"
// search looks in, but only for queries that name one of the properties below. Everything else returns null.
//
// Flags in the page address: ?fixture=nodescription leaves the optional columns (description, choices...) out of every answer,
// the way an instance without them would; ?fixture=nopatch makes writes fail with a 403.

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const failure = (status, message) => json({ error: { message, detail: null }, status: 'failure' }, status);

function fnv(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
const sid = (key) => [0x811c9dc5, 0x2f1a3b4c, 0x9e3779b9, 0x7f4a7c15].map((s) => fnv(key, s)).join('');

const NOW = Date.now();
const stamp = (hoursAgo) => new Date(NOW - hoursAgo * 36e5).toISOString().replace('T', ' ').slice(0, 19);

const GLOBAL = { sys_scope: { value: 'global', display_value: 'Global' }, 'sys_scope.scope': { value: 'global', display_value: 'global' } };
const HR = { sys_scope: { value: sid('scope:x_acme_hr'), display_value: 'Acme HR' }, 'sys_scope.scope': { value: 'x_acme_hr', display_value: 'x_acme_hr' } };
const ITSM = { sys_scope: { value: sid('scope:x_acme_itsm'), display_value: 'Acme ITSM' }, 'sys_scope.scope': { value: 'x_acme_itsm', display_value: 'x_acme_itsm' } };

// name, type, value, description, extra
const SOURCE = [
  ['glide.ui.session_timeout', 'integer', '1800', 'Number of seconds of inactivity before a user is logged out. Applies to every interactive session.', { ...GLOBAL, hours: 70, by: 'admin' }],
  ['glide.invalid_query.returns_no_rows', 'boolean', 'false', 'If true, a query on a field that does not exist returns no rows. If false, the condition is ignored and every row is returned.', { ...GLOBAL, hours: 900, by: 'system' }],
  ['glide.email.smtp.active', 'boolean', 'true', 'Enable sending of outbound email.', { ...GLOBAL, hours: 3, by: 'maria.dev' }],
  ['glide.email.read.active', 'boolean', 'true', 'Enable reading of inbound email.', { ...GLOBAL, hours: 1500, by: 'system' }],
  ['glide.email.test.user', 'string', '', 'When set, all outbound email is sent to this address instead of the real recipients.', { ...GLOBAL, hours: 2200, by: 'system' }],
  ['glide.servlet.uri', 'string', 'https://dev12345.service-now.com/', 'The base URL used when links to this instance are built, for example in emails.', { ...GLOBAL, hours: 5000, by: 'system' }],
  ['glide.sys.default.tz', 'string', 'Europe/London', 'The system time zone. Users without their own time zone see times in this one.', { ...GLOBAL, hours: 5000, by: 'system' }],
  ['com.glide.attachment.max_size', 'integer', '1024', 'Maximum attachment size in megabytes.', { ...GLOBAL, hours: 4000, by: 'system' }],
  ['glide.ui.escape_text', '', 'true', 'Escape text on forms and lists to guard against script injection.', { ...GLOBAL, hours: 8000, by: 'system' }],
  ['glide.security.use_csrf_token', 'boolean', 'true', 'Require a CSRF token on requests that change data.', { ...GLOBAL, hours: 8000, by: 'system' }],
  ['glide.sm.default_mode', 'choicelist', 'deny', 'The default security mode for tables with no matching access rule.', { ...GLOBAL, choices: 'allow,deny', hours: 8000, by: 'system' }],
  ['glide.appcreator.company.code', 'string', 'acme', 'The prefix used for custom applications created on this instance.', { ...GLOBAL, hours: 6000, by: 'admin' }],
  ['glide.ldap.bind.password', 'password2', 'not-a-real-secret-3f9a1c', 'The password the LDAP integration binds with.', { ...GLOBAL, hours: 2000, by: 'admin' }],
  ['x_acme_hr.integration.api_key', 'string', 'AKIAFAKEKEY0000EXAMPLE', 'API key for the HR system.', { ...HR, hours: 300, by: 'admin' }],
  // A password-type property whose name says nothing: hidden by its type alone.
  ['x_acme_hr.directory.bind', 'password2', 'not-a-real-secret-b7d2', 'The account the HR directory lookup binds with.', { ...HR, hours: 6500, by: 'admin' }],
  ['x_acme_hr.sync.enabled', 'boolean', 'true', 'Turn the nightly HR sync on or off.', { ...HR, hours: 120, by: 'maria.dev' }],
  ['x_acme_hr.sync.timeout_seconds', 'integer', '30', 'How long the HR sync waits for the HR system to answer, in seconds.', { ...HR, hours: 26, by: 'maria.dev' }],
  ['x_acme_hr.sync.batch_size', 'integer', '200', 'Number of people the HR sync processes per run.', { ...HR, hours: 480, by: 'abel.tuter' }],
  ['x_acme_hr.sync.endpoint', 'string', 'https://hr.acme.example/api/v2', 'Base URL of the HR system API.', { ...HR, hours: 480, by: 'abel.tuter' }],
  ['x_acme_hr.log.level', 'choicelist', 'info', 'How much the HR application writes to the system log.', { ...HR, choices: 'debug,info,warn,error', hours: 200, by: 'maria.dev' }],
  ['x_acme_hr.notify.recipients', 'string', 'hr-ops@acme.example\nhr-alerts@acme.example\npayroll@acme.example', 'Who is emailed when the HR sync fails. One address per line.', { ...HR, hours: 90, by: 'beth.anglin' }],
  ['x_acme_hr.welcome_message', 'string', 'Welcome to Acme. Your manager will contact you before your first day with details about where to go, who to meet and which equipment to collect from the service desk.', 'Text shown on the new-hire page.', { ...HR, hours: 700, by: 'beth.anglin' }],
  ['x_acme_itsm.autoclose.enabled', 'boolean', 'false', 'Close resolved incidents automatically after the number of days below.', { ...ITSM, hours: 48, by: 'fred.luddy' }],
  ['x_acme_itsm.autoclose.days', 'integer', '7', 'Days a resolved incident waits before it is closed automatically.', { ...ITSM, hours: 48, by: 'fred.luddy' }],
  ['x_acme_itsm.legacy.token_endpoint', 'string', 'https://auth.acme.example/oauth/token', 'The address of the token service.', { ...ITSM, hours: 3000, by: 'admin' }],
  ['glide.ui.keyboard_shortcuts', 'boolean', 'true', 'Enable the keyboard shortcuts of the platform UI.', { ...GLOBAL, hours: 7000, by: 'system' }],
];

const ROWS = SOURCE.map(([name, type, value, description, extra]) => {
  const { hours, by, choices, ...scope } = extra;
  return {
    sys_id: sid(`prop:${name}`),
    name,
    type,
    value,
    description,
    choices: choices || '',
    suffix: '',
    is_private: name.includes('password') || name.includes('api_key') ? 'true' : 'false',
    read_roles: '',
    write_roles: name.startsWith('glide.') ? 'admin' : '',
    sys_updated_on: stamp(hours),
    sys_updated_by: by,
    ...scope,
  };
});

const OPTIONAL = ['description', 'choices', 'suffix', 'is_private', 'read_roles', 'write_roles'];
const flag = () => new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('fixture') || '';

// --- A small encoded-query reader -----------------------------------------------------------------------------------

function parseCondition(text) {
  const m = /^([\w.]+?)(LIKE|IN|=)([\s\S]*)$/.exec(text);
  return m ? { field: m[1], op: m[2], value: m[3] } : null;
}

function parseQuery(query) {
  const groups = [];
  let order = null;
  String(query || '')
    .split('^')
    .filter(Boolean)
    .forEach((part) => {
      let m = /^ORDERBYDESC(\w+)$/.exec(part);
      if (m) return void (order = { field: m[1], desc: true });
      m = /^ORDERBY(\w+)$/.exec(part);
      if (m) return void (order = { field: m[1], desc: false });
      const isOr = part.startsWith('OR') && !part.startsWith('ORDER');
      const cond = parseCondition(isOr ? part.slice(2) : part);
      if (!cond) return undefined;
      if (isOr && groups.length) groups[groups.length - 1].push(cond);
      else groups.push([cond]);
      return undefined;
    });
  return { groups, order };
}

const text = (row, field) => {
  const v = row[field];
  return v && typeof v === 'object' ? String(v.value ?? '') : String(v ?? '');
};

function test(row, cond) {
  const have = text(row, cond.field);
  if (cond.op === 'LIKE') return have.toLowerCase().includes(cond.value.toLowerCase());
  if (cond.op === 'IN') return cond.value.split(',').includes(have);
  return have === cond.value;
}

function select(rows, query) {
  const { groups, order } = parseQuery(query);
  let out = rows.filter((row) => groups.every((g) => g.some((c) => test(row, c))));
  if (order) {
    out = [...out].sort((a, b) => {
      const x = text(a, order.field);
      const y = text(b, order.field);
      return (x < y ? -1 : x > y ? 1 : 0) * (order.desc ? -1 : 1);
    });
  }
  return out;
}

function project(row, fields, displayAll) {
  const hide = flag() === 'nodescription' ? new Set(OPTIONAL) : new Set();
  const wanted = (fields.length ? fields : Object.keys(row)).filter((f) => f in row && !hide.has(f));
  const out = {};
  wanted.forEach((f) => {
    const v = row[f];
    if (v && typeof v === 'object') out[f] = displayAll ? v : v.value;
    else out[f] = displayAll ? { value: v, display_value: f === 'type' ? typeLabel(v) : v } : v;
  });
  return out;
}

const typeLabel = (type) => ({ password2: 'Password (2 way encrypted)', choicelist: 'Choice list', integer: 'Integer', boolean: 'True/False' })[type] || type;

// --- The scripts the "Who reads it" search finds --------------------------------------------------------------------

const SCRIPTS = [
  {
    table: 'sys_script_include',
    name: 'HRSyncClient',
    api_name: 'x_acme_hr.HRSyncClient',
    active: 'true',
    script: `var HRSyncClient = Class.create();
HRSyncClient.prototype = {
  initialize: function () {
    // x_acme_hr.sync.timeout_seconds is the wait for one call, in seconds
    this.timeoutMs = parseInt(gs.getProperty('x_acme_hr.sync.timeout_seconds', '30'), 10) * 1000;
    this.endpoint = gs.getProperty('x_acme_hr.sync.endpoint');
    this.batch = parseInt(gs.getProperty("x_acme_hr.sync.batch_size", "200"), 10);
  },

  fetchPeople: function () {
    var request = new sn_ws.RESTMessageV2();
    request.setEndpoint(this.endpoint + '/people');
    request.setHttpTimeout(this.timeoutMs);
    return request.execute();
  },

  type: 'HRSyncClient'
};`,
  },
  {
    table: 'sys_script',
    name: 'HR sync - warn on slow answers',
    collection: 'x_acme_hr_sync_log',
    when: 'after',
    active: 'true',
    script: `(function executeRule(current, previous /*null when async*/) {
  // Compare with x_acme_hr.sync.timeout_seconds: anything over the limit is slow.
  var limit = Number(gs.getProperty('x_acme_hr.sync.timeout_seconds'));
  if (current.duration > limit) {
    gs.warn('HR sync answered slowly: ' + current.duration + 's (limit x_acme_hr.sync.timeout_seconds=' + limit + ')');
  }
})(current, previous);`,
  },
  {
    table: 'sys_script',
    name: 'HR sync - old limit notes',
    collection: 'x_acme_hr_sync_log',
    when: 'before',
    active: 'true',
    script: `(function executeRule(current, previous) {
  /*
   * Retired: the timeout used to be read here with
   * gs.getProperty('x_acme_hr.sync.timeout_seconds', '60')
   * It is now read in HRSyncClient.
   */
})(current, previous);`,
  },
  {
    table: 'sysauto_script',
    name: 'Reset HR sync timeout on Monday',
    active: 'true',
    script: `// Monday morning: back to the normal limit
gs.setProperty('x_acme_hr.sync.timeout_seconds', '30');
gs.info('HR sync timeout reset');`,
  },
  {
    table: 'sp_widget',
    name: 'HR sync status',
    id: 'hr-sync-status',
    script: `(function () {
  var KEY = 'x_acme_hr.sync.timeout_seconds';
  data.timeout = gs.getProperty(KEY, '30');
  data.enabled = gs.getProperty('x_acme_hr.sync.enabled') === 'true';
})();`,
    client_script: `function ($scope) {
  var c = this;
  c.label = 'x_acme_hr.sync.timeout_seconds';
}`,
  },
  {
    table: 'sys_script_include',
    name: 'HRSyncLegacy',
    api_name: 'x_acme_hr.HRSyncLegacy',
    active: 'true',
    script: `var HRSyncLegacy = Class.create();
HRSyncLegacy.prototype = {
  initialize: function () {
    // a different property that only starts the same way
    this.t = gs.getProperty('x_acme_hr.sync.timeout_seconds_legacy', '120');
  },
  type: 'HRSyncLegacy'
};`,
  },
  {
    table: 'sys_security_acl',
    name: 'x_acme_hr_sync_log',
    operation: 'read',
    active: 'true',
    condition: "gs.getProperty('x_acme_hr.sync.enabled') == 'true'",
    script: `answer = gs.hasRole('x_acme_hr.admin') && gs.getProperty('x_acme_hr.sync.enabled') === 'true';`,
  },
  {
    table: 'sys_script_include',
    name: 'QueryUtil',
    api_name: 'global.QueryUtil',
    active: 'true',
    script: `var QueryUtil = Class.create();
QueryUtil.prototype = {
  initialize: function () {
    this.strict = gs.getProperty('glide.invalid_query.returns_no_rows') === 'true';
  },
  isStrict: function () {
    return this.strict;
  },
  type: 'QueryUtil'
};`,
  },
  {
    table: 'sys_script_fix',
    name: 'Turn mail off after clone',
    active: 'true',
    script: `// Run after every clone of production
gs.setProperty('glide.email.smtp.active', 'false');
gs.setProperty('glide.email.test.user', 'dev-team@acme.example');`,
  },
  {
    table: 'sysauto_script',
    name: 'Email health check',
    active: 'true',
    script: `if (gs.getProperty('glide.email.smtp.active') !== 'true') {
  gs.error('Outbound email is switched off on ' + gs.getProperty('instance_name'));
}`,
  },
  {
    table: 'sys_ui_page',
    name: 'hr_sync_settings',
    html: `<j:jelly trim="false" xmlns:j="jelly:core" xmlns:g="glide">
  <!-- shows \${gs.getProperty('x_acme_hr.sync.timeout_seconds')} in a comment -->
  <p>Timeout: \${gs.getProperty('x_acme_hr.sync.timeout_seconds')} seconds</p>
</j:jelly>`,
    client_script: '',
    processing_script: '',
  },
  {
    table: 'sys_dictionary',
    name: 'x_acme_hr_sync_log',
    element: 'u_limit',
    active: 'true',
    default_value: "javascript:gs.getProperty('x_acme_hr.sync.timeout_seconds', '30')",
    calculation: '',
  },
  {
    table: 'sys_script',
    name: 'Incident auto close',
    collection: 'incident',
    when: 'before',
    active: 'true',
    script: `(function executeRule(current, previous) {
  if (gs.getProperty('x_acme_itsm.autoclose.enabled') !== 'true') return;
  var days = parseInt(gs.getProperty('x_acme_itsm.autoclose.days', '7'), 10);
  if (current.resolved_at.getGlideObject().getNumericValue() < gs.daysAgoStart(days)) current.state = 7;
})(current, previous);`,
  },
  {
    // Reads two secret properties, each with a default that is itself a secret: the lines must be masked.
    table: 'sys_script_include',
    name: 'HRDirectoryClient',
    api_name: 'x_acme_hr.HRDirectoryClient',
    active: 'true',
    script: `var HRDirectoryClient = Class.create();
HRDirectoryClient.prototype = {
  bind: function () {
    var account = 'svc_hr_lookup';
    var secret = gs.getProperty('x_acme_hr.directory.bind', 'Fallback-Pa55-b7d2');
    var key = gs.getProperty('x_acme_hr.integration.api_key', 'AKIAFAKEKEY0000EXAMPLE');
    return this._connect(account, secret, key);
  },
  type: 'HRDirectoryClient'
};`,
  },
].map((row, i) => ({ sys_id: sid(`script:${i}`), ...row }));

const SCRIPT_FIELDS = {
  sys_script: ['script', 'condition'],
  sys_script_include: ['script'],
  sys_script_client: ['script'],
  sys_ui_action: ['script', 'condition'],
  sys_ui_policy: ['script_true', 'script_false'],
  sysevent_script_action: ['script'],
  sysauto_script: ['script'],
  sys_transform_script: ['script'],
  sys_processor: ['script'],
  sys_ws_operation: ['operation_script'],
  sys_security_acl: ['script', 'condition'],
  sp_widget: ['script', 'client_script'],
  sys_ui_script: ['script'],
  catalog_script_client: ['script'],
  sys_script_fix: ['script'],
  sys_script_email: ['script'],
  sys_ui_page: ['html', 'client_script', 'processing_script'],
  sys_ui_macro: ['xml'],
  sys_dictionary: ['default_value', 'calculation'],
};
// Tables the fake instance does not know at all: answer an empty list for a property search, so the search can finish.
const OWN_TABLES = new Set(['sys_script_fix', 'sys_script_email', 'sys_ui_page', 'sys_ui_macro']);

function scriptTable(table, u) {
  const query = u.searchParams.get('sysparm_query') || '';
  const like = /(?:^|\^)(?:active=true\^)?[a-z_]+LIKE([^^]+)/.exec(query);
  if (!like) return null;
  const term = like[1];
  const known = ROWS.some((r) => r.name.toLowerCase() === term.toLowerCase());
  if (!known) return OWN_TABLES.has(table) ? json({ result: [] }) : null;
  const fields = (u.searchParams.get('sysparm_fields') || '').split(',').filter(Boolean);
  const rows = SCRIPTS.filter((s) => s.table === table && (SCRIPT_FIELDS[table] || []).some((f) => String(s[f] || '').toLowerCase().includes(term.toLowerCase())));
  return json({
    result: rows.map((row) => {
      const out = {};
      (fields.length ? fields : Object.keys(row)).forEach((f) => {
        if (f in row) out[f] = row[f];
      });
      return out;
    }),
  });
}

// --- Routing ----------------------------------------------------------------------------------------------------------

export function route(method, url, body) {
  // Only on the System properties preview page: its rows must not answer other panels' sys_properties and script-table reads.
  if (typeof location !== 'undefined' && /preview.html$/.test(location.pathname || '') && new URLSearchParams(location.search).get('open') !== 'properties') return null;
  const m =/^\/api\/now\/(table|stats)\/([a-z0-9_]+)(?:\/([0-9a-f]{32}))?$/.exec(url.pathname);
  if (!m) return null;
  const [, api, table, recordId] = m;
  if (table !== 'sys_properties') return method === 'GET' && api === 'table' && SCRIPT_FIELDS[table] ? scriptTable(table, url) : null;

  const query = url.searchParams.get('sysparm_query') || '';
  if (api === 'stats') return json({ result: { stats: { count: String(select(ROWS, query).length) } } });

  if (method === 'PATCH' || method === 'PUT') {
    if (flag() === 'nopatch') return failure(403, 'Operation against file \'sys_properties\' was aborted by Business Rule or ACL');
    const row = ROWS.find((r) => r.sys_id === recordId);
    if (!row) return failure(404, 'No Record found');
    const patch = body ? JSON.parse(body) : {};
    if ('value' in patch) row.value = String(patch.value);
    row.sys_updated_on = stamp(0);
    row.sys_updated_by = 'maria.dev';
    return json({ result: project(row, [], false) });
  }
  if (method !== 'GET') return null;

  const fields = (url.searchParams.get('sysparm_fields') || '').split(',').filter(Boolean);
  const all = url.searchParams.get('sysparm_display_value') === 'all';
  const limit = Number(url.searchParams.get('sysparm_limit') || 1000);
  const rows = recordId ? ROWS.filter((r) => r.sys_id === recordId) : select(ROWS, query);
  return json({ result: rows.slice(0, limit).map((r) => project(r, fields, all)) });
}
