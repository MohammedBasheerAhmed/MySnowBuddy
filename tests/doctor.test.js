const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../src/lib/doctor.js');
const { createDoctor, readSchema, probeTable } = require('../src/content/doctor.js');
const { ALL_REQUIREMENTS } = require('../src/lib/requirements/index.js');
const { REQUIREMENTS: EXISTING } = require('../src/lib/requirements/existing.js');
const failures = require('../src/lib/failures.js');
const saveTrace = require('../src/lib/saveTrace.js');
const healthScan = require('../src/lib/healthScan.js');
const { SEARCHABLE_ARTIFACTS } = require('../src/content/codeSearch.js');

const ID = '0123456789abcdef0123456789abcdef';

// ---- Reading an HTTP answer ---------------------------------------------------------------------------------------

test('a JSON answer is ok, whatever the content type says', () => {
  assert.deepEqual(D.classifyHttp({ status: 200, body: '{"result":[]}' }), { kind: 'ok', status: 200, message: '' });
  assert.equal(D.classifyHttp({ status: 200, body: '' }).kind, 'ok', 'an empty body is fine');
});

test('an expired session is told apart from a refusal: 401, a login page served as 200, a login redirect, the logged-in header', () => {
  assert.equal(D.classifyHttp({ status: 401, body: '{"error":{"message":"User Not Authenticated"}}' }).kind, 'session');
  assert.equal(D.classifyHttp({ status: 200, body: '<html><form action="/login.do"><input name="user_password"></form>' }).kind, 'session');
  assert.equal(D.classifyHttp({ status: 200, redirected: true, url: 'https://x.service-now.com/login.do?sysparm_goto=1', body: '<html></html>' }).kind, 'session');
  assert.equal(D.classifyHttp({ status: 200, loggedIn: 'false', body: '{"result":[]}' }).kind, 'session');
  assert.equal(D.classifyHttp({ status: 403, body: '{"error":{"message":"User Not Authorized","detail":"Insufficient rights to query records"}}' }).kind, 'denied', 'a 403 is not a session problem');
});

test('403 is an ACL refusal and keeps the instance\'s own words', () => {
  const r = D.classifyHttp({ status: 403, body: '{"error":{"message":"User Not Authorized","detail":"Insufficient rights to query records"},"status":"failure"}' });
  assert.equal(r.kind, 'denied');
  assert.match(r.message, /User Not Authorized - Insufficient rights to query records/);
});

test('a table that does not exist is "missing"; a missing endpoint is "notfound"; other 400s are a bad request', () => {
  assert.equal(D.classifyHttp({ status: 400, body: '{"error":{"message":"Invalid table sn_hr_core_case","detail":null},"status":"failure"}' }).kind, 'missing');
  assert.equal(D.classifyHttp({ status: 404, body: '{"error":{"message":"Invalid table foo"}}' }).kind, 'missing');
  assert.equal(D.classifyHttp({ status: 404, body: '' }).kind, 'notfound');
  assert.equal(D.classifyHttp({ status: 400, body: '{"error":{"message":"Invalid query"}}' }).kind, 'badrequest');
});

test('busy, server, html, timeout, network and a missing token each get their own kind', () => {
  assert.equal(D.classifyHttp({ status: 429, body: '' }).kind, 'busy');
  assert.equal(D.classifyHttp({ status: 503, body: '' }).kind, 'busy');
  assert.equal(D.classifyHttp({ status: 500, body: '{"error":{"message":"boom"}}' }).kind, 'server');
  assert.equal(D.classifyHttp({ status: 200, body: '<html><body>Maintenance</body></html>' }).kind, 'html');
  assert.equal(D.classifyHttp({ status: 200, body: 'not json' }).kind, 'html');
  assert.equal(D.classifyHttp({ failed: Object.assign(new Error('x'), { name: 'AbortError' }) }).kind, 'timeout');
  assert.equal(D.classifyHttp({ failed: new TypeError('Failed to fetch') }).kind, 'network');
  assert.equal(D.classifyHttp({ failed: new Error('Could not read the ServiceNow session token. Reload the page and try again.') }).kind, 'notoken');
});

test('errors thrown by the Table API helper are classified from their fixed wording', () => {
  assert.equal(D.classifyThrown(Object.assign(new Error('Your ServiceNow session has expired. Log in again, then retry.'), { code: 'SESSION_EXPIRED' })).kind, 'session');
  assert.equal(D.classifyThrown(new Error('Your user is not allowed to do this (403): User Not Authorized.')).kind, 'denied');
  assert.equal(D.classifyThrown(new Error('Table API query on "x" failed (400): Invalid table x')).kind, 'missing');
  assert.equal(D.classifyThrown(new Error('Table API query on "x" failed (400): Invalid query')).kind, 'badrequest');
  assert.equal(D.classifyThrown(new Error('Table API query on "x" failed (503): the instance is busy. Wait a moment and retry.')).kind, 'busy');
  assert.equal(D.classifyThrown(new Error('The instance refused to run the script ("not authorized").')).kind, 'denied');
  assert.equal(D.classifyThrown(new TypeError('Failed to fetch')).kind, 'network');
  assert.equal(D.classifyThrown(new Error('something odd')).kind, 'error');
});

test('every outcome has a plain-words summary, and every failing one says what to do', () => {
  ['session', 'denied', 'missing', 'notfound', 'badrequest', 'busy', 'server', 'html', 'notoken', 'timeout', 'network', 'error'].forEach((kind) => {
    const d = D.describeOutcome(kind, { what: 'the Table API', table: 'sys_x', status: 403, message: 'User Not Authorized' });
    assert.ok(d.summary.length > 15, kind);
    assert.ok(d.action.length > 15, `${kind} needs a "what to do"`);
    assert.doesNotMatch(`${d.summary} ${d.action}`, /payload|leverage|seamless|utili[sz]e/i);
  });
  assert.equal(D.describeOutcome('ok', { ms: 1500 }).summary, 'Answered in 1.5 s.');
  assert.match(D.describeOutcome('denied', { what: 'the table sys_audit', message: 'User Not Authorized' }).summary, /not allowed to read the table sys_audit \(403\).*User Not Authorized/);
});

test('formatMs reads as milliseconds below a second and seconds above', () => {
  assert.equal(D.formatMs(312.4), '312 ms');
  assert.equal(D.formatMs(2450), '2.5 s');
  assert.equal(D.formatMs(NaN), '');
});

// ---- The page, the release, the settings -------------------------------------------------------------------------------

test('the page layout: classic, classic with the content frame, Next Experience shell with the frame in a shadow root, workspace, portal', () => {
  assert.equal(D.classifyPage({ pathname: '/incident.do', isTop: true }).kind, 'classic');
  assert.equal(D.classifyPage({ pathname: '/nav_to.do', directFrame: true, foundFrame: true }).kind, 'classic-frame');
  assert.equal(D.classifyPage({ pathname: '/incident.do', isTop: false }).kind, 'classic-inner');
  const shell = D.classifyPage({ pathname: '/now/nav/ui/classic/params/target/incident_list.do', foundFrame: true, frameReadable: true });
  assert.equal(shell.kind, 'shell');
  assert.equal(shell.status, 'ok');
  assert.equal(D.classifyPage({ pathname: '/now/nav/ui/classic/params/target/x.do', foundFrame: false }).status, 'warn', 'a shell with no reachable classic frame limits the page tools');
  assert.equal(D.classifyPage({ pathname: '/now/nav/ui/classic/params/target/x.do', foundFrame: true, frameReadable: false }).kind, 'shell-blocked');
  assert.equal(D.classifyPage({ pathname: '/now/workspace/agent/home' }).kind, 'workspace');
  assert.equal(D.classifyPage({ pathname: '/sp' }).kind, 'portal');
  assert.equal(D.classifyPage({ pathname: '/esc?id=index' }).kind, 'portal');
  assert.equal(D.classifyPage({ pathname: '/' }).kind, 'other');
});

test('the release family comes out of the build tag, with patch and hotfix', () => {
  const b = D.parseBuild({ buildname: 'Xanadu', buildtag: 'glide-xanadu-07-02-2024__patch7-hotfix2-10-05-2024', builddate: '07-02-2024_1637' });
  assert.equal(b.family, 'Xanadu');
  assert.equal(b.patch, '7');
  assert.equal(b.hotfix, '2');
  assert.equal(b.label, 'Xanadu patch 7 hotfix 2');
  assert.equal(b.date, '07-02-2024_1637');
  assert.equal(D.parseBuild({ buildtag: 'glide-australia-12-18-2025__patch7' }).label, 'Australia patch 7');
  assert.equal(D.parseBuild({ buildname: 'Zurich' }).family, 'Zurich', 'the build name is enough when there is no tag');
  assert.equal(D.parseBuild({}).label, '');
  assert.equal(D.parseBuild(null || undefined).family, '');
});

test('the settings summary is an allow-list: tokens, keys and ports never appear', () => {
  const rows = D.summariseSettings({
    mcpToken: 'tok_SECRET123',
    mcpPort: 17345,
    mcpBridgeEnabled: true,
    mysnowbuddy_key_anthropic: 'sk-ant-SECRET',
    apiKey: 'sk-SECRET',
    roleTiersEnabled: true,
    developerRoles: 'delegated_developer, personalize_dictionary',
    guardsEnabled: false,
    inlineEnabled: true,
    toolSurface: 'sidebar',
    agentEnabled: true,
    agentAutonomy: 'ask',
  });
  const text = JSON.stringify(rows);
  assert.doesNotMatch(text, /SECRET|tok_|17345|sk-/);
  assert.ok(rows.find((r) => /Safety guards/.test(r.label) && r.value === 'off'));
  assert.ok(rows.find((r) => /Roles that count as developer/.test(r.label) && /delegated_developer/.test(r.value)));
  assert.ok(rows.find((r) => r.label === 'Local MCP bridge' && r.value === 'on'));
  assert.ok(rows.find((r) => r.label === 'Tools open in' && r.value === 'the sidebar'));
});

// ---- Checks ---------------------------------------------------------------------------------------------------------------

test('page checks: a silent bridge or a missing token is a failure with a way out; a healthy page is all ok', () => {
  const healthy = D.pageChecks({ version: '0.8.0', host: 'dev1.service-now.com', page: { pathname: '/incident.do' }, bridge: { ok: true, hasUser: true, ms: 12 }, token: { present: true, ms: 3 }, settings: {} });
  assert.deepEqual(healthy.map((c) => c.id), ['page.extension', 'page.frame', 'page.bridge', 'page.token', 'page.settings']);
  assert.ok(healthy.every((c) => c.status === 'ok'));
  assert.match(healthy[0].summary, /0\.8\.0/);

  const bad = D.pageChecks({ version: '0.8.0', page: { pathname: '/incident.do' }, bridge: { ok: false, error: 'Page bridge timed out calling "getSessionInfo".', ms: 2500 }, token: { present: false }, settings: {} });
  assert.equal(bad.find((c) => c.id === 'page.bridge').status, 'fail');
  assert.match(bad.find((c) => c.id === 'page.bridge').action, /Reload/);
  assert.equal(bad.find((c) => c.id === 'page.token').status, 'fail');
  assert.equal(D.pageChecks({ page: {}, bridge: { ok: true, hasUser: false }, token: { present: true } }).find((c) => c.id === 'page.bridge').status, 'warn');
});

test('identity checks name the tier, the role count and an impersonation, and never the user', () => {
  const checks = D.youChecks({
    session: { userName: 'abel.tuter', userId: ID, roles: ['admin', 'itil', 'snc_internal'], admin: true, securityAdmin: false },
    tier: 'admin',
    tiersOn: true,
    impersonation: { state: 'active', note: 'NowBuddy remembers who you were.' },
    instance: { host: 'dev1.service-now.com', instance: 'dev1', label: 'DEV', tone: 'ok', env: 'dev' },
    build: { info: { buildtag: 'glide-australia-12-18-2025__patch7' }, source: 'stats.do', ms: 80 },
  });
  const who = checks.find((c) => c.id === 'you.identity');
  assert.match(who.summary, /3 roles, tier "admin"/);
  assert.doesNotMatch(JSON.stringify(checks), /abel\.tuter/);
  assert.equal(checks.find((c) => c.id === 'you.impersonation').status, 'warn');
  assert.equal(checks.find((c) => c.id === 'you.build').status, 'ok', 'the release NowBuddy was checked against is fine');
  const other = D.youChecks({ session: null, instance: {}, build: { info: { buildtag: 'glide-xanadu-07-02-2024__patch7' } } });
  assert.equal(other.find((c) => c.id === 'you.build').status, 'warn');
  assert.match(other.find((c) => c.id === 'you.build').action, /Australia patch 7/);
  assert.equal(other.find((c) => c.id === 'you.identity').status, 'warn');
  const prod = D.youChecks({ session: { roles: [] }, instance: { host: 'acmeprod.service-now.com', env: 'prod', label: 'PROD' }, build: {} });
  assert.match(prod.find((c) => c.id === 'you.instance').summary, /looks like production/);
  assert.equal(prod.find((c) => c.id === 'you.build').status, 'warn');
  // A plain company host name (most production instances) is not "not production".
  const plain = D.youChecks({ session: { roles: [] }, instance: { host: 'acme.service-now.com', env: 'unknown', guarded: true }, build: {} }).find((c) => c.id === 'you.instance');
  assert.match(plain.summary, /could be production/);
  assert.ok(plain.details.some((d) => /cannot tell from the name, so it is treated as production/.test(d)));
  assert.ok(!plain.details.includes('Looks like production: no'));
});

test('API checks: the session, an ACL refusal and a missing endpoint are reported differently', () => {
  const ok = { kind: 'ok', status: 200, ms: 90 };
  const all = D.apiChecks({
    table: ok,
    stats: { ...ok, countOk: true },
    group: { ...ok, groupsOk: true },
    dictionary: { dbObject: 'ok', dictionary: 'ok', tables: 80, ms: 400 },
    pickers: { update: { ...ok, hasCurrent: true }, app: { ...ok, hasCurrent: true } },
    script: { kind: 'ok', ms: 700, printed: true },
  });
  assert.deepEqual(all.map((c) => c.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);

  const gone = D.apiChecks({ table: { kind: 'session', status: 401, ms: 40 }, stats: { kind: 'session' }, group: { kind: 'session' }, pickers: { update: { kind: 'session' }, app: { kind: 'session' } }, script: { kind: 'skipped', message: 'x' } });
  assert.equal(gone.find((c) => c.id === 'api.table').status, 'fail');
  assert.match(gone.find((c) => c.id === 'api.table').summary, /session has ended/i);
  assert.equal(gone.find((c) => c.id === 'api.stats').status, 'skip', 'nothing else is tried after the session ended');
  assert.equal(gone.find((c) => c.id === 'api.pickers').status, 'skip');

  const mixed = D.apiChecks({
    table: ok,
    stats: { kind: 'denied', status: 403, message: 'User Not Authorized', ms: 50 },
    group: { kind: 'notfound', status: 404, ms: 50 },
    dictionary: { dbObject: 'denied', dictionary: 'unread', tables: 80 },
    pickers: { update: { ...ok, hasCurrent: false }, app: { kind: 'notfound', status: 404 } },
    script: { kind: 'denied', status: 403, message: 'not authorized', ms: 300 },
  });
  assert.equal(mixed.find((c) => c.id === 'api.stats').status, 'warn');
  assert.match(mixed.find((c) => c.id === 'api.stats').summary, /not allowed to read the Stats API \(403\)/);
  assert.equal(mixed.find((c) => c.id === 'api.dictionary').status, 'warn');
  assert.match(mixed.find((c) => c.id === 'api.dictionary').summary, /sys_db_object and sys_dictionary could not be read/);
  assert.equal(mixed.find((c) => c.id === 'api.pickers').status, 'warn');
  assert.match(mixed.find((c) => c.id === 'api.script').action, /admin role/);
  assert.equal(mixed.find((c) => c.id === 'api.table').status, 'ok');

  const prod = D.apiChecks({ table: ok, script: { kind: 'skipped', message: 'Not run on purpose.', action: 'Use "Include the script check" to run it anyway.' } });
  assert.equal(prod.find((c) => c.id === 'api.script').status, 'skip');
  assert.match(prod.find((c) => c.id === 'api.script').action, /Include the script check/);
  assert.equal(D.apiChecks({ table: ok, script: { kind: 'ok', ms: 5, printed: false } }).find((c) => c.id === 'api.script').status, 'warn', 'a script that ran but printed nothing is suspicious');
});

// ---- Requirements ----------------------------------------------------------------------------------------------------------

test('requirement lists are checked for shape: feature, table, columns', () => {
  assert.deepEqual(D.validateRequirements([{ feature: 'X', table: 'sys_email', columns: ['subject', 'update_set.name'], optional: true, note: 'n' }]), []);
  assert.equal(D.validateRequirements([{ feature: '', table: 'sys_email', columns: [] }]).length, 1);
  assert.equal(D.validateRequirements([{ feature: 'X', table: 'Sys Email', columns: [] }]).length, 1);
  assert.equal(D.validateRequirements([{ feature: 'X', table: 'sys_email', columns: 'subject' }]).length, 1);
  assert.equal(D.validateRequirements([{ feature: 'X', table: 'sys_email', columns: ['ok', 'not ok'] }]).length, 1);
  assert.equal(D.validateRequirements([{ feature: 'X', table: 'sys_email', columns: [], optional: 'yes' }]).length, 1);
  assert.equal(D.validateRequirements([null]).length, 1);
  assert.equal(D.validateRequirements('nope').length, 1);
});

const REQUIREMENT_DIR = path.join(__dirname, '..', 'src', 'lib', 'requirements');
const LISTS = {
  clientTrace: require('../src/lib/requirements/clientTrace.js').REQUIREMENTS,
  notify: require('../src/lib/requirements/notify.js').REQUIREMENTS,
  process: require('../src/lib/requirements/process.js').REQUIREMENTS,
  properties: require('../src/lib/requirements/properties.js').REQUIREMENTS,
  datamodel: require('../src/lib/requirements/datamodel.js').REQUIREMENTS,
  portal: require('../src/lib/requirements/portal.js').REQUIREMENTS,
  previewProblems: require('../src/lib/requirements/previewProblems.js').REQUIREMENTS,
  goto: require('../src/lib/requirements/goto.js').REQUIREMENTS,
  existing: EXISTING,
};

test('every requirements file is wired into ALL_REQUIREMENTS and every entry is well formed', () => {
  const index = fs.readFileSync(path.join(REQUIREMENT_DIR, 'index.js'), 'utf8');
  fs.readdirSync(REQUIREMENT_DIR)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .forEach((f) => assert.ok(index.includes(`'./${f}'`), `${f} is not imported by requirements/index.js`));
  Object.entries(LISTS).forEach(([name, list]) => {
    assert.ok(Array.isArray(list), `${name}: REQUIREMENTS must be an array`);
    assert.deepEqual(D.validateRequirements(list, name), []);
  });
  assert.equal(ALL_REQUIREMENTS.length, Object.values(LISTS).reduce((n, l) => n + l.length, 0), 'ALL_REQUIREMENTS holds every entry');
  assert.deepEqual(D.validateRequirements(ALL_REQUIREMENTS, 'ALL_REQUIREMENTS'), []);
});

test('the existing-tools list names the corrected columns from the live calibration, not the old wrong ones', () => {
  const columns = (table, feature) => EXISTING.filter((e) => e.table === table && (!feature || e.feature === feature)).flatMap((e) => [...e.columns, ...(e.optionalColumns || [])]);
  assert.ok(columns('sys_script_client').includes('field'));
  assert.ok(!columns('sys_script_client').includes('field_name'));
  assert.ok(columns('sys_transform_script').includes('map'));
  assert.ok(!columns('sys_transform_script').includes('sys_transform_map'));
  assert.ok(!EXISTING.some((e) => e.table === 'sys_metadata' && e.columns.includes('name')), 'sys_metadata has sys_name, not name');
  assert.ok(!EXISTING.some((e) => e.table === 'task' && e.feature !== 'Save trace' && e.columns.includes('name')), 'task has no name column');
});

test('required and optional follow what the code does when a read fails (checked against the code on 2026-10-23)', () => {
  const tableOf = (feature, table) => groupedFeature(feature).tables.find((t) => t.table === table);
  const groupedFeature = (feature) => D.groupByFeature(EXISTING).find((f) => f.feature === feature);
  // accessDebugger.js: "a failure here is fatal" for the ACL roles.
  assert.equal(tableOf('Access debugger', 'sys_security_acl_role').optional, false);
  // fieldUsage.js: the search starts with tableHierarchy (sys_db_object); the dictionary only feeds the field picker.
  assert.equal(tableOf('Where is this field used?', 'sys_db_object').optional, false);
  assert.equal(tableOf('Where is this field used?', 'sys_dictionary').optional, true);
  // xray.js hierarchy falls back to the table itself; myWork.js asks the page for the user first.
  assert.equal(tableOf('Page X-ray', 'sys_db_object').optional, true);
  assert.equal(tableOf('My work', 'sys_user').optional, true);
  // impact.js and hotspots.js load each section on its own.
  assert.equal(tableOf('Change impact', 'sys_script').optional, true);
  assert.equal(tableOf('Hot spots', 'syslog_transaction').optional, true);
  // Table explorer: only the parent chain is required; the facts card may fail.
  assert.deepEqual(tableOf('Table explorer', 'sys_db_object').required.sort(), ['name', 'super_class']);
  // Alternative column names (one of them is always missing) are not listed, or Hot spots would never be OK.
  assert.ok(!tableOf('Hot spots', 'sys_outbound_http_log').optionalColumns.includes('elapsed'));
});

test('the lists that live in code and the existing-tools list stay in step', () => {
  const entriesFor = (feature) => EXISTING.filter((e) => e.feature === feature);
  const columnsOn = (feature, table) => new Set(entriesFor(feature).filter((e) => e.table === table).flatMap((e) => [...e.columns, ...(e.optionalColumns || []), ...(e.alternates || [])].map((c) => c.split('.')[0])));
  const covers = (feature, table, fields) => {
    assert.ok(entriesFor(feature).some((e) => e.table === table), `${feature}: ${table} is not listed`);
    const have = columnsOn(feature, table);
    fields.map((f) => f.split('.')[0]).filter((f) => !D.UNIVERSAL_COLUMNS.includes(f)).forEach((f) => assert.ok(have.has(f), `${feature}: ${table}.${f} is not listed`));
  };

  failures.SOURCES.forEach((s) => s.probes.forEach((p) => covers('What went wrong?', p.table, p.fields)));
  const sources = saveTrace.traceSources({ table: 'incident', sysId: ID, userName: 'abel.tuter', window: { seconds: 300 }, isTask: true });
  assert.ok(sources.length >= 10);
  sources.forEach((s) => covers('Save trace', s.table, s.fields));
  SEARCHABLE_ARTIFACTS.forEach((a) => covers('Code search', a.table, [...a.fields, ...a.scriptFields]));
  healthScan.SCAN_TABLES.forEach((d) => covers('Health scan', d.table, [d.nameField, ...d.scripts.map((s) => s.field)]));
});

test('features merge by table: a column required anywhere stays required, a table is optional only when every entry is', () => {
  const grouped = D.groupByFeature([
    { feature: 'A', table: 'sys_email', columns: ['subject', 'type'], note: 'one' },
    { feature: 'A', table: 'sys_email', columns: ['subject', 'error_string'], optional: true, note: 'two' },
    { feature: 'A', table: 'sys_trigger', columns: ['name'], optional: true },
    { feature: 'A', table: 'sys_trigger', columns: ['state'], optionalColumns: ['claimed_by'], optional: true },
    { feature: 'B', table: 'sys_email', columns: ['subject'], panel: 'notify' },
    { feature: 'B', table: 'bad table', columns: [] },
  ]);
  assert.equal(grouped.length, 2);
  const a = grouped[0];
  const email = a.tables.find((t) => t.table === 'sys_email');
  assert.equal(email.optional, false);
  assert.deepEqual(email.required.sort(), ['subject', 'type']);
  assert.deepEqual(email.optionalColumns, ['error_string']);
  assert.deepEqual(email.notes, ['one', 'two']);
  const trigger = a.tables.find((t) => t.table === 'sys_trigger');
  assert.equal(trigger.optional, true);
  assert.deepEqual(trigger.optionalColumns.sort(), ['claimed_by', 'name', 'state']);
  assert.equal(grouped[1].panel, 'notify');
  assert.equal(grouped[1].tables.length, 1, 'the malformed entry is dropped');
});

test('the plan lists each table once with the base columns wanted, leaving the system columns out', () => {
  const plan = D.planTables([
    { feature: 'A', table: 'sys_update_xml', columns: ['name', 'update_set.name', 'sys_created_on', 'sys_id'] },
    { feature: 'B', table: 'sys_update_xml', columns: ['update_set'], optional: true },
    { feature: 'B', table: 'incident', columns: ['caller_id'] },
  ]);
  assert.deepEqual(plan.tables, ['incident', 'sys_update_xml']);
  assert.deepEqual(plan.columns.sys_update_xml, ['name', 'update_set']);
  assert.deepEqual(D.wantedColumns(plan), ['caller_id', 'name', 'update_set']);
});

// A small instance: task <- incident <- (a custom child), sys_metadata <- sys_script.
const PARENTS = new Map([
  ['sys_metadata', ''],
  ['sys_script', 'sys_metadata'],
  ['task', ''],
  ['incident', 'task'],
  ['u_incident_child', 'incident'],
  ['sys_email', ''],
]);
const COLUMNS = new Map([
  ['sys_metadata', new Set(['sys_name', 'sys_scope'])],
  ['sys_script', new Set(['name', 'collection', 'when', 'active'])],
  ['task', new Set(['number', 'short_description', 'state', 'sys_class_name'])],
  ['incident', new Set(['caller_id', 'category'])],
  ['sys_email', new Set(['type', 'subject', 'recipients'])],
]);
const SCHEMA = D.makeSchema({ parents: PARENTS, columns: COLUMNS, dbObject: 'ok', dictionary: 'ok' });

test('dictionary entries are inherited: a column defined on task exists on incident and on a child of incident', () => {
  assert.deepEqual(D.chainOf(PARENTS, 'u_incident_child'), ['u_incident_child', 'incident', 'task']);
  assert.deepEqual(D.columnDefined(SCHEMA, 'incident', 'short_description'), { state: 'yes', definedOn: 'task' });
  assert.deepEqual(D.columnDefined(SCHEMA, 'u_incident_child', 'number'), { state: 'yes', definedOn: 'task' });
  assert.equal(D.columnDefined(SCHEMA, 'incident', 'caller_id').definedOn, 'incident');
  assert.equal(D.columnDefined(SCHEMA, 'sys_script', 'sys_name').definedOn, 'sys_metadata', 'a column of the root table');
  assert.equal(D.columnDefined(SCHEMA, 'sys_script', 'number').state, 'no');
  assert.equal(D.columnDefined(SCHEMA, 'incident', 'sys_created_on').state, 'yes', 'system columns are assumed');
  assert.equal(D.columnDefined(SCHEMA, 'incident', 'caller_id.name').state, 'yes', 'a dotted column is checked on its first part');
  assert.equal(D.columnDefined(SCHEMA, 'nope', 'x').state, 'unknown', 'a table that is not known cannot answer');
});

test('a cycle or a very deep chain does not loop', () => {
  const loop = new Map([['a', 'b'], ['b', 'a']]);
  assert.deepEqual(D.chainOf(loop, 'a'), ['a', 'b']);
  const deep = new Map(Array.from({ length: 40 }, (_, i) => [`t${i}`, `t${i + 1}`]));
  assert.ok(D.chainOf(deep, 't0').length <= 10);
});

test('table existence follows sys_db_object, and says "unknown" when it could not be read', () => {
  assert.equal(D.tableExists(SCHEMA, 'incident'), 'yes');
  assert.equal(D.tableExists(SCHEMA, 'sn_hr_core_case'), 'no');
  assert.equal(D.tableExists(D.makeSchema({ dbObject: 'denied' }), 'incident'), 'unknown');
});

test('a column is ok, missing, hidden from this user, or unverified', () => {
  const probe = { kind: 'ok', sampleKeys: ['sys_id', 'caller_id', 'number'], requestedKeys: ['sys_id', 'caller_id', 'number', 'category', 'subject_line'] };
  assert.equal(D.columnState(SCHEMA, probe, 'incident', 'caller_id').state, 'ok');
  assert.equal(D.columnState(SCHEMA, probe, 'incident', 'nope').state, 'missing');
  // Defined in the dictionary but the sampled row did not return it: a field ACL, usually.
  assert.equal(D.columnState(SCHEMA, probe, 'incident', 'category').state, 'hidden');
  // A column that was never requested says nothing either way.
  assert.equal(D.columnState(SCHEMA, probe, 'task', 'state').state, 'ok');
  // No dictionary: the sample decides, and with no row there is no evidence.
  const blind = D.makeSchema({ dbObject: 'denied', dictionary: 'unread' });
  assert.equal(D.columnState(blind, probe, 'incident', 'caller_id').state, 'ok');
  assert.equal(D.columnState(blind, probe, 'incident', 'nope_at_all').state, 'unverified', 'not requested, so no evidence');
  assert.equal(D.columnState(blind, { kind: 'ok', sampleKeys: ['sys_id'], requestedKeys: ['sys_id', 'x'] }, 'incident', 'x').state, 'missing');
  assert.equal(D.columnState(blind, { kind: 'ok', sampleKeys: [], requestedKeys: ['sys_id', 'x'] }, 'incident', 'x').state, 'unverified', 'an empty table gives nothing to go on');
  // A cut-off dictionary cannot prove a column is absent.
  const cut = D.makeSchema({ parents: PARENTS, columns: COLUMNS, dbObject: 'ok', dictionary: 'ok', truncated: true });
  assert.equal(D.columnState(cut, null, 'incident', 'nope').state, 'unverified');
});

const REQ = [
  { feature: 'Tool Alpha', table: 'incident', columns: ['caller_id', 'number', 'short_description'] },
  { feature: 'Tool Beta', table: 'sys_script', columns: ['name', 'collection'], optionalColumns: ['filter_condition'] },
  { feature: 'Tool Beta', table: 'sys_email', columns: ['subject', 'error_string'], optional: true },
  { feature: 'Tool Gamma', table: 'sn_hr_core_case', columns: ['number'] },
  { feature: 'Tool Delta', table: 'sys_security_acl', columns: ['name'] },
  { feature: 'Tool Epsilon', table: 'sys_email', columns: ['subject', 'type', 'nope_required'] },
  { feature: 'Tool Zeta', table: 'sys_trigger', columns: ['name'], optional: true },
];
const PROBES = {
  incident: { kind: 'ok', status: 200, sampleKeys: ['sys_id', 'caller_id', 'number', 'short_description'], requestedKeys: ['sys_id', 'caller_id', 'number', 'short_description'] },
  sys_script: { kind: 'ok', status: 200, sampleKeys: ['sys_id', 'name', 'collection'], requestedKeys: ['sys_id', 'name', 'collection', 'filter_condition'] },
  sys_email: { kind: 'ok', status: 200, sampleKeys: [], requestedKeys: ['sys_id', 'subject', 'error_string', 'type', 'nope_required'] },
  sys_security_acl: { kind: 'denied', status: 403 },
  sys_trigger: { kind: 'busy', status: 503 },
};

test('each tool is ok, works with gaps, will not work, or could not be fully checked, with the exact table.column behind it', () => {
  const tools = Object.fromEntries(D.evaluateTools(REQ, { schema: D.makeSchema({ parents: new Map([...PARENTS, ['sys_security_acl', ''], ['sys_trigger', '']]), columns: COLUMNS, dbObject: 'ok', dictionary: 'ok' }), probes: PROBES }).map((t) => [t.feature, t]));

  assert.equal(tools['Tool Alpha'].status, 'ok', 'inherited columns count');
  assert.match(tools['Tool Alpha'].summary, /everything it reads/i);

  // filter_condition is optional and absent from sys_script: the tool works, with a gap. The email table is optional too.
  assert.equal(tools['Tool Beta'].status, 'gaps');
  assert.deepEqual(tools['Tool Beta'].problems.map((p) => `${p.table}.${p.column}:${p.level}`).sort(), ['sys_email.error_string:gap', 'sys_script.filter_condition:gap']);

  assert.equal(tools['Tool Gamma'].status, 'broken');
  assert.deepEqual(tools['Tool Gamma'].problems[0], { level: 'blocking', kind: 'table-missing', table: 'sn_hr_core_case', column: '', text: 'sn_hr_core_case does not exist on this instance.' });
  assert.match(tools['Tool Gamma'].summary, /^Will not work: sn_hr_core_case does not exist/);

  assert.equal(tools['Tool Delta'].status, 'broken');
  assert.equal(tools['Tool Delta'].problems[0].kind, 'table-denied');
  assert.match(tools['Tool Delta'].summary, /Your user cannot read sys_security_acl \(403\)/);

  assert.equal(tools['Tool Epsilon'].status, 'broken');
  assert.equal(tools['Tool Epsilon'].problems[0].text, 'sys_email.nope_required is not a column on this instance.');

  // An optional table the instance was too busy to answer for is "could not check", not "missing".
  assert.equal(tools['Tool Zeta'].status, 'unverified');
  assert.equal(tools['Tool Zeta'].problems[0].level, 'unverified');
});

test('a fallback table that is missing is no gap while the table it stands in for can be read', () => {
  const req = [
    { feature: 'T', table: 'incident', columns: ['caller_id'], optional: true },
    { feature: 'T', table: 'sn_hr_core_case', columns: ['number'], optional: true, fallbackFor: 'incident' },
  ];
  const [tool] = D.evaluateTools(req, { schema: SCHEMA, probes: PROBES });
  assert.equal(tool.status, 'ok', 'incident is readable, so the stand-in is not needed');
  const row = tool.tables.find((t) => t.table === 'sn_hr_core_case');
  assert.equal(row.state, 'unused');
  assert.match(row.detail, /incident can be read/);
  assert.equal(tool.problems.length, 0);

  // When the table it stands in for cannot be read, the stand-in matters again.
  const [blocked] = D.evaluateTools(req, { schema: SCHEMA, probes: { ...PROBES, incident: { kind: 'denied', status: 403 } } });
  assert.deepEqual(blocked.problems.map((p) => `${p.table}:${p.kind}`).sort(), ['incident:table-denied', 'sn_hr_core_case:table-missing']);

  assert.equal(D.validateRequirements([{ feature: 'T', table: 'x', columns: [], fallbackFor: 'Not A Table' }]).length, 1, 'fallbackFor must name a table');
});

test('a hidden column is a gap even in a required table: it exists, so the tool runs, but it will show blanks', () => {
  const probe = { kind: 'ok', sampleKeys: ['sys_id', 'caller_id'], requestedKeys: ['sys_id', 'caller_id', 'category'] };
  const [tool] = D.evaluateTools([{ feature: 'T', table: 'incident', columns: ['caller_id', 'category'] }], { schema: SCHEMA, probes: { incident: probe } });
  assert.equal(tool.status, 'gaps');
  assert.equal(tool.problems[0].kind, 'column-hidden');
  assert.match(tool.problems[0].text, /incident\.category is defined, but the instance did not return it for your user/);
});

test('when the dictionary cannot be read, the sampled row decides and the text says so', () => {
  const blind = D.makeSchema({ dbObject: 'denied', dictionary: 'unread' });
  const [tool] = D.evaluateTools([{ feature: 'T', table: 'incident', columns: ['caller_id', 'ghost'] }], {
    schema: blind,
    probes: { incident: { kind: 'ok', sampleKeys: ['sys_id', 'caller_id'], requestedKeys: ['sys_id', 'caller_id', 'ghost'] } },
  });
  assert.equal(tool.status, 'broken');
  assert.match(tool.problems[0].text, /incident\.ghost is not a column on this instance.*dictionary was not readable/);
});

test('an expired session leaves every tool unchecked rather than broken', () => {
  const tools = D.evaluateTools(REQ, { schema: D.makeSchema({}), probes: {}, sessionExpired: true });
  assert.ok(tools.every((t) => t.status === 'unverified'));
  assert.match(tools[0].summary, /session has ended/);
});

test('tools sort broken first and the counts and the missing list add up', () => {
  const tools = D.evaluateTools(REQ, { schema: D.makeSchema({ parents: new Map([...PARENTS, ['sys_security_acl', ''], ['sys_trigger', '']]), columns: COLUMNS, dbObject: 'ok', dictionary: 'ok' }), probes: PROBES });
  const sorted = D.sortTools(tools);
  assert.deepEqual(sorted.map((t) => t.status), ['broken', 'broken', 'broken', 'gaps', 'unverified', 'ok']);
  assert.deepEqual(D.countTools(sorted), { total: 6, ok: 1, gaps: 1, broken: 3, unverified: 1 });
  const missing = D.missingList(sorted);
  assert.deepEqual(missing.required.map((m) => m.name).sort(), ['sn_hr_core_case', 'sys_email.nope_required', 'sys_security_acl']);
  assert.deepEqual(missing.optional.map((m) => m.name).sort(), ['sys_email.error_string', 'sys_script.filter_condition']);
});

// ---- The verdict and the report ----------------------------------------------------------------------------------------------

const check = (id, status, summary = 'x', title = id) => D.makeCheck(id, 'page', title, status, summary);

test('the traffic light: red only when NowBuddy cannot read the instance at all', () => {
  const fine = [check('page.bridge', 'ok'), check('page.token', 'ok'), check('api.table', 'ok')];
  const tools = (statuses) => statuses.map((status, i) => ({ feature: `T${i}`, status, problems: [], tables: [] }));
  assert.equal(D.overallStatus(fine, tools(['ok', 'ok'])).status, 'ok');
  assert.match(D.overallStatus(fine, tools(['ok', 'ok'])).headline, /2 tools have what they need/);

  const amber = D.overallStatus(fine, tools(['ok', 'broken', 'gaps', 'gaps', 'unverified']));
  assert.equal(amber.status, 'warn');
  assert.match(amber.headline, /^1 tool will not work here; 2 tools work with gaps; 1 tool could not be fully checked\.$/);
  assert.equal(D.overallStatus([...fine, check('api.stats', 'warn')], tools(['ok'])).status, 'warn', 'a warning alone is amber');

  const red = D.overallStatus([check('page.bridge', 'ok'), check('page.token', 'ok'), check('api.table', 'fail', 'Your ServiceNow session has ended (the instance asked for a login).')], tools(['unverified']));
  assert.equal(red.status, 'fail');
  assert.match(red.headline, /session has ended/);
  assert.equal(D.overallStatus([check('page.token', 'fail', 'No session token')], tools(['ok'])).status, 'fail');
  assert.equal(D.overallStatus([check('api.stats', 'fail')], tools(['ok'])).status, 'warn', 'only the core checks make it red; others are amber at worst');
});

function sampleResult() {
  const tools = D.evaluateTools(REQ, { schema: D.makeSchema({ parents: new Map([...PARENTS, ['sys_security_acl', ''], ['sys_trigger', '']]), columns: COLUMNS, dbObject: 'ok', dictionary: 'ok' }), probes: PROBES });
  const checks = [
    D.makeCheck('page.extension', 'page', 'NowBuddy on this page', 'ok', 'Version 0.8.0 is running on dev1.service-now.com.'),
    D.makeCheck('api.table', 'api', 'Table API (read)', 'ok', 'A read answered in 90 ms.', { ms: 90 }),
    D.makeCheck('api.stats', 'api', 'Stats API (counts)', 'warn', 'Your user is not allowed to read the Stats API (403).', { action: 'Ask an admin.', ms: 50 }),
  ];
  return D.assembleResult({
    startedAt: Date.UTC(2026, 9, 23, 9, 30, 0),
    finishedAt: Date.UTC(2026, 9, 23, 9, 30, 7, 400),
    extension: { version: '0.8.0' },
    instance: { host: 'dev1.service-now.com', instance: 'dev1', label: 'DEV', env: 'dev', release: 'Australia patch 7', buildTag: 'glide-australia-12-18-2025__patch7' },
    page: { kind: 'shell', label: 'Next Experience shell with the classic frame' },
    user: { tier: 'developer', roleCount: 12, admin: false },
    checks,
    tools,
    schema: { dbObject: 'ok', dictionary: 'ok', tablesLooked: 7, truncated: false },
    requests: 31,
    slowest: [{ table: 'sys_audit', ms: 2300 }, { table: 'syslog', ms: 900 }],
  });
}

test('the result is plain data: it survives a JSON round trip unchanged', () => {
  const result = sampleResult();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(result.resultVersion, 1);
  assert.equal(result.durationMs, 7400);
  assert.equal(result.tools[0].status, 'broken');
  assert.equal(result.overall.status, 'warn');
});

test('the Markdown report names versions, tiers, timings and every missing table.column, and carries no secret or record data', () => {
  const md = D.buildReport(sampleResult());
  assert.match(md, /^# NowBuddy self-check/);
  assert.match(md, /Verdict: \*\*Amber\*\*/);
  assert.match(md, /Extension: NowBuddy 0\.8\.0/);
  assert.match(md, /Instance: dev1\.service-now\.com \(DEV\)/);
  assert.match(md, /ServiceNow release: Australia patch 7 \(glide-australia-12-18-2025__patch7\)/);
  assert.match(md, /You: tier developer, 12 roles, admin no/);
  assert.match(md, /7\.4 s, 31 requests/);
  assert.match(md, /Slowest table reads: sys_audit 2\.3 s, syslog 900 ms/);
  assert.match(md, /\| Stats API \(counts\) \| Look \| 50 ms \|/);
  assert.match(md, /## Tools that will not work here \(3\)/);
  assert.match(md, /`sys_email\.nope_required`/);
  assert.match(md, /`sn_hr_core_case`/);
  assert.match(md, /`sys_security_acl`/);
  assert.match(md, /## Tools that work with gaps \(1\)/);
  assert.match(md, /\*\*Tool Beta\*\* - optional or hidden: .*`sys_script\.filter_condition`/);
  assert.match(md, /## All tools/);
  assert.match(md, /\| Tool Alpha \| OK \| incident \|/);
  assert.doesNotMatch(md, /sk-|abel\.tuter|X-UserToken|g_ck|password/i);
  assert.doesNotMatch(md, /undefined|NaN|\[object/);
});

test('an empty run still produces a readable report', () => {
  const md = D.buildReport(D.assembleResult({ startedAt: 0, finishedAt: 5, checks: [], tools: [] }));
  assert.match(md, /Verdict: \*\*Green\*\*/);
  assert.match(md, /release: not readable/);
  assert.doesNotMatch(md, /undefined|NaN|\[object/);
});

// ---- The run, end to end, against a fake instance ------------------------------------------------------------------------------

/** A small ServiceNow: tables with parents and columns, a few forbidden, a few not installed. */
function fakeInstance(overrides = {}) {
  const tables = {
    task: { parent: '', cols: ['number', 'short_description', 'state', 'active', 'sys_class_name'] },
    incident: { parent: 'task', cols: ['caller_id', 'category'] },
    sys_metadata: { parent: '', cols: ['sys_name'] },
    sys_script: { parent: 'sys_metadata', cols: ['name', 'collection', 'when', 'active', 'script'] },
    sys_email: { parent: '', cols: ['type', 'subject', 'recipients'] },
    sys_user: { parent: '', cols: ['user_name', 'name', 'active'] },
    sys_security_acl: { parent: '', cols: ['name', 'operation'], denied: true },
    sys_trigger: { parent: '', cols: ['name', 'state'], rows: 0 },
    ...overrides.tables,
  };
  const chain = (t) => (t && tables[t] ? [t, ...chain(tables[t].parent)] : []);
  const columnsOf = (t) => chain(t).flatMap((x) => tables[x].cols);
  const log = [];
  const url = (path) => new URL(path, 'https://dev1.service-now.com');
  const body = (obj) => JSON.stringify(obj);
  const api = {
    request: async (path) => {
      log.push(path);
      const u = url(path);
      const m = /^\/api\/now\/table\/([^/]+)$/.exec(u.pathname);
      if (overrides.sessionGone) return { kind: 'session', status: 401, message: 'The session has ended.', ms: 5, body: '' };
      if (m) {
        const t = m[1];
        if (!tables[t]) return { kind: 'missing', status: 400, message: `Invalid table ${t}`, ms: 4, body: '' };
        if (tables[t].denied) return { kind: 'denied', status: 403, message: 'User Not Authorized', ms: 4, body: '' };
        const wanted = (u.searchParams.get('sysparm_fields') || '').split(',').filter(Boolean);
        const have = new Set([...columnsOf(t), 'sys_id']);
        const row = Object.fromEntries(wanted.filter((f) => have.has(f) && !(overrides.hidden?.[t] || []).includes(f)).map((f) => [f, '']));
        return { kind: 'ok', status: 200, message: '', ms: 6, body: body({ result: tables[t].rows === 0 ? [] : [row] }) };
      }
      if (u.pathname.startsWith('/api/now/stats/')) return { kind: 'ok', status: 200, message: '', ms: 7, body: body(u.searchParams.get('sysparm_group_by') ? { result: [{ stats: { count: '3' }, groupby_fields: [{ field: 'active', value: 'true' }] }] } : { result: { stats: { count: '1' } } }) };
      if (u.pathname.startsWith('/api/now/ui/concoursepicker/')) return { kind: 'ok', status: 200, message: '', ms: 8, body: body({ result: { current: { sysId: 'global', name: 'Global' } } }) };
      return { kind: 'notfound', status: 404, message: '', ms: 1, body: '' };
    },
    queryChunks: async (table, field, values, fields) => {
      if (table !== 'sys_db_object' || field !== 'name') throw new Error(`unexpected ${table}`);
      if (overrides.dbObjectDenied) throw new Error('Your user is not allowed to do this (403): User Not Authorized.');
      log.push(`sys_db_object IN ${values.join(',')}`);
      return values.filter((v) => tables[v]).map((v) => ({ name: v, 'super_class.name': tables[v].parent }));
    },
    query: async (table, query, fields) => {
      if (table !== 'sys_dictionary') throw new Error(`unexpected ${table}`);
      log.push(`sys_dictionary ${query}`);
      const names = /nameIN([^^]+)/.exec(query)[1].split(',');
      const elements = new Set(/elementIN([^^]+)/.exec(query)[1].split(','));
      return names.filter((n) => tables[n]).flatMap((n) => tables[n].cols.filter((c) => elements.has(c)).map((c) => ({ name: n, element: c })));
    },
  };
  return { api, log, tables };
}

function depsFor(instance, extra = {}) {
  let t = 1_700_000_000_000;
  return {
    request: instance.api.request,
    query: instance.api.query,
    queryChunks: instance.api.queryChunks,
    session: async () => ({ userName: 'abel.tuter', userId: ID, roles: ['itil', 'delegated_developer'], admin: false, securityAdmin: false }),
    token: async () => true,
    settings: async () => ({ roleTiersEnabled: true, developerRoles: 'delegated_developer', mcpToken: 'tok_SECRET' }),
    pageFacts: () => ({ pathname: '/now/nav/ui/classic/params/target/incident.do', foundFrame: true, frameReadable: true, isTop: true }),
    impersonation: async () => ({ state: 'none' }),
    instance: async () => ({ host: 'dev1.service-now.com', instance: 'dev1', env: 'dev', guarded: false, label: 'DEV', tone: 'ok' }),
    build: async () => ({ info: { buildtag: 'glide-australia-12-18-2025__patch7' }, source: 'stats.do', ms: 50 }),
    script: async () => ({ kind: 'ok', status: 200, message: '', ms: 300, printed: true }),
    version: () => '0.8.0',
    requirements: () => REQ,
    now: () => (t += 250),
    ...extra,
  };
}

test('a full run: the right status for each tool, the dictionary read in few queries, no secret anywhere', async () => {
  const instance = fakeInstance();
  const progress = [];
  const result = await createDoctor(depsFor(instance)).run({ onProgress: (p) => progress.push(p) });

  const byFeature = Object.fromEntries(result.tools.map((t) => [t.feature, t]));
  assert.equal(byFeature['Tool Alpha'].status, 'ok');
  assert.equal(byFeature['Tool Beta'].status, 'gaps');
  assert.equal(byFeature['Tool Gamma'].status, 'broken');
  assert.equal(byFeature['Tool Delta'].status, 'broken');
  assert.equal(byFeature['Tool Epsilon'].status, 'broken');
  assert.equal(byFeature['Tool Zeta'].status, 'ok', 'an optional table with no rows is fine');
  assert.equal(result.overall.status, 'warn');
  assert.equal(result.counts.broken, 3);

  // The page, the identity and the API checks all ran.
  const ids = result.checks.map((c) => c.id);
  ['page.extension', 'page.frame', 'page.bridge', 'page.token', 'page.settings', 'you.identity', 'you.impersonation', 'you.instance', 'you.build', 'api.table', 'api.stats', 'api.group', 'api.dictionary', 'api.pickers', 'api.script'].forEach((id) => assert.ok(ids.includes(id), id));
  assert.ok(result.checks.every((c) => c.status === 'ok'), JSON.stringify(result.checks.filter((c) => c.status !== 'ok')));
  assert.equal(result.user.tier, 'developer');
  assert.equal(result.instance.release, 'Australia patch 7');
  assert.equal(result.page.kind, 'shell');

  // The dictionary came from batched reads, not one query per table or per column.
  const dictionaryReads = instance.log.filter((l) => l.startsWith('sys_dictionary'));
  const hierarchyReads = instance.log.filter((l) => l.startsWith('sys_db_object'));
  assert.equal(dictionaryReads.length, 1);
  assert.ok(hierarchyReads.length <= 3, `the parents were read level by level: ${hierarchyReads.length}`);
  const tableReads = instance.log.filter((l) => l.startsWith('/api/now/table/'));
  const probed = tableReads.map((l) => /table\/([^?]+)/.exec(l)[1]);
  assert.ok(!probed.includes('sn_hr_core_case'), 'a table the dictionary says is missing is not probed');
  assert.ok(probed.includes('incident') && probed.includes('sys_security_acl'));

  // Progress ends at the total.
  assert.ok(progress.length > 5);
  assert.equal(progress.at(-1).done, progress.at(-1).total);
  assert.ok(progress.every((p, i) => i === 0 || p.done >= progress[i - 1].done), 'progress never goes backwards');

  const text = JSON.stringify(result) + D.buildReport(result);
  assert.doesNotMatch(text, /tok_SECRET|abel\.tuter/);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('a hidden column and a missing column are found from the dictionary and the sampled row together', async () => {
  const instance = fakeInstance({ hidden: { incident: ['category'] } });
  const result = await createDoctor(depsFor(instance, { requirements: () => [{ feature: 'T', table: 'incident', columns: ['caller_id', 'category', 'ghost'] }] })).run();
  const tool = result.tools[0];
  assert.equal(tool.status, 'broken');
  assert.deepEqual(tool.problems.map((p) => `${p.column}:${p.kind}`).sort(), ['category:column-hidden', 'ghost:column-missing']);
});

test('an expired session stops the run quickly, reds the verdict and does not call the tools broken', async () => {
  const instance = fakeInstance({ sessionGone: true });
  const result = await createDoctor(depsFor(instance)).run();
  assert.equal(result.overall.status, 'fail');
  assert.match(result.overall.headline, /session has ended/i);
  assert.ok(result.tools.every((t) => t.status === 'unverified'));
  assert.equal(result.checks.find((c) => c.id === 'api.stats').status, 'skip');
  assert.ok(instance.log.every((l) => !l.startsWith('sys_dictionary') && !l.startsWith('sys_db_object')), 'no dictionary reads after the session ended');
  assert.ok(result.notes.some((n) => /session has ended/i.test(n)));
});

test('when sys_db_object cannot be read the tools are judged from sampled rows and the check says so', async () => {
  const instance = fakeInstance({ dbObjectDenied: true });
  const result = await createDoctor(depsFor(instance)).run();
  const dict = result.checks.find((c) => c.id === 'api.dictionary');
  assert.equal(dict.status, 'warn');
  assert.equal(result.schema.dbObject, 'denied');
  const byFeature = Object.fromEntries(result.tools.map((t) => [t.feature, t]));
  assert.equal(byFeature['Tool Gamma'].status, 'broken', 'a table the Table API calls invalid is missing even without the dictionary');
  assert.equal(byFeature['Tool Delta'].status, 'broken');
  assert.equal(byFeature['Tool Epsilon'].status, 'broken', 'a required column absent from a sampled row');
});

test('the background script probe is skipped on a production-looking instance unless asked for, and never when the Table API is down', async () => {
  const prod = depsFor(fakeInstance(), { instance: async () => ({ host: 'acmeprod.service-now.com', instance: 'acmeprod', env: 'prod', guarded: true, label: 'PROD', tone: 'danger' }) });
  let ran = 0;
  prod.script = async () => {
    ran += 1;
    return { kind: 'ok', status: 200, ms: 1, printed: true };
  };
  let result = await createDoctor(prod).run();
  assert.equal(ran, 0);
  assert.equal(result.checks.find((c) => c.id === 'api.script').status, 'skip');
  assert.equal(result.instance.looksProduction, true);
  result = await createDoctor(prod).run({ scriptProbe: 'always' });
  assert.equal(ran, 1);
  assert.equal(result.checks.find((c) => c.id === 'api.script').status, 'ok');
  result = await createDoctor(prod).run({ scriptProbe: 'never' });
  assert.equal(ran, 1);
});

test('the script probe does not run on its own on an instance NowBuddy cannot place, nor when the instance facts are unreadable', async () => {
  let ran = 0;
  const script = async () => {
    ran += 1;
    return { kind: 'ok', status: 200, ms: 1, printed: true };
  };
  // acme.service-now.com: the usual name of a production instance, which the host-name guess cannot place.
  const plain = depsFor(fakeInstance(), { script, instance: async () => ({ host: 'acme.service-now.com', instance: 'acme', env: 'unknown', guarded: true, label: '', tone: 'neutral' }) });
  let result = await createDoctor(plain).run();
  assert.equal(ran, 0, 'not run on a host that may be production');
  const check = result.checks.find((c) => c.id === 'api.script');
  assert.equal(check.status, 'skip');
  assert.match(check.summary, /cannot tell whether this instance is production/);
  assert.equal(check.rerun, 'scriptProbe', 'the panel offers to run it anyway');
  // The instance facts could not be read at all: also not run.
  const blind = depsFor(fakeInstance(), {
    script,
    instance: async () => {
      throw new Error('storage gone');
    },
  });
  result = await createDoctor(blind).run();
  assert.equal(ran, 0);
  // A positively identified dev instance runs it.
  result = await createDoctor(depsFor(fakeInstance(), { script })).run();
  assert.equal(ran, 1);
  assert.equal(result.checks.find((c) => c.id === 'api.script').status, 'ok');
});

test('running the script check anyway is confirmed first, and the confirmation names the one line it runs', () => {
  const prod = D.scriptProbeAsk({ host: 'acmeprod.service-now.com', looksProduction: true });
  assert.equal(prod.danger, true);
  assert.match(prod.message, /acmeprod\.service-now\.com looks like production/);
  assert.match(prod.message, /changes no data, but the run is recorded in the instance's script history/);
  assert.equal(prod.details, "gs.print('NOWBUDDY_SELFCHECK_OK');");
  assert.equal(D.SCRIPT_PROBE, `gs.print('${D.SCRIPT_PROBE_MARKER}');`);
  assert.match(D.scriptProbeAsk({ host: 'acme.service-now.com', looksProduction: false }).message, /cannot tell whether acme\.service-now\.com is production/);
});

test('the AI tool never runs the script probe', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'controlTools.js'), 'utf8');
  const tool = /async run_selfcheck\(\)[\s\S]*?\n {4}\},/.exec(src);
  assert.ok(tool, 'run_selfcheck is defined in controlTools.js');
  assert.match(tool[0], /scriptProbe: 'never'/);
});

test('every check is independent: one that throws does not stop the others', async () => {
  const deps = depsFor(fakeInstance(), {
    session: async () => {
      throw new Error('Page bridge timed out calling "getSessionInfo".');
    },
    settings: async () => {
      throw new Error('storage gone');
    },
    build: async () => {
      throw new Error('nope');
    },
    impersonation: async () => {
      throw new Error('nope');
    },
  });
  const result = await createDoctor(deps).run();
  assert.equal(result.checks.find((c) => c.id === 'page.bridge').status, 'fail');
  assert.equal(result.overall.status, 'fail', 'a silent page bridge is red');
  assert.equal(result.checks.find((c) => c.id === 'api.table').status, 'ok');
  assert.ok(result.tools.length > 0 && result.tools.some((t) => t.status === 'ok'));
});

test('reading the hierarchy goes level by level and finds a three-level chain with few queries', async () => {
  const instance = fakeInstance({ tables: { u_a: { parent: 'u_b', cols: [] }, u_b: { parent: 'u_c', cols: [] }, u_c: { parent: 'task', cols: [] } } });
  const plan = D.planTables([{ feature: 'T', table: 'u_a', columns: ['number'] }]);
  const schema = await readSchema(plan, { queryChunks: instance.api.queryChunks, query: instance.api.query });
  assert.deepEqual(D.chainOf(schema.parents, 'u_a'), ['u_a', 'u_b', 'u_c', 'task']);
  assert.equal(D.columnDefined(schema, 'u_a', 'number').definedOn, 'task');
  assert.equal(instance.log.filter((l) => l.startsWith('sys_db_object')).length, 4);
  assert.equal(instance.log.filter((l) => l.startsWith('sys_dictionary')).length, 1);
});

test('a probe keeps the names of the columns that came back and nothing else', async () => {
  const get = async (p) => ({ kind: 'ok', status: 200, ms: 3, message: '', body: JSON.stringify({ result: [{ sys_id: ID, name: 'PRIVATE VALUE', value: 'hunter2' }] }), path: p });
  const probe = await probeTable('sys_properties', ['name', 'value', 'description', 'type'], get);
  assert.deepEqual(probe.sampleKeys, ['sys_id', 'name', 'value']);
  assert.deepEqual(probe.requestedKeys, ['sys_id', 'name', 'type'], 'value and description are never requested');
  assert.doesNotMatch(JSON.stringify(probe), /PRIVATE|hunter2/);
  // Audit values are record data (and can be large): not requested either.
  const audit = await probeTable('sys_audit', ['tablename', 'fieldname', 'oldvalue', 'newvalue', 'user'], async (p) => ({ kind: 'ok', status: 200, ms: 1, message: '', body: JSON.stringify({ result: [{ sys_id: ID }] }), path: p }));
  assert.deepEqual(audit.requestedKeys, ['sys_id', 'tablename', 'fieldname', 'user']);
});

test('the same problem seen by several tools is one cause, blocking ones first, with every tool it touches', () => {
  const tools = D.evaluateTools(
    [
      { feature: 'A', table: 'sys_security_acl', columns: ['name'], optional: true },
      { feature: 'B', table: 'sys_security_acl', columns: ['name', 'operation'], optional: true },
      { feature: 'C', table: 'sys_security_acl', columns: ['name'] },
      { feature: 'D', table: 'incident', columns: ['ghost'] },
    ],
    { schema: D.makeSchema({ parents: new Map([...PARENTS, ['sys_security_acl', '']]), columns: COLUMNS, dbObject: 'ok', dictionary: 'ok' }), probes: { sys_security_acl: { kind: 'denied', status: 403 }, incident: { kind: 'ok', sampleKeys: [], requestedKeys: [] } } }
  );
  const causes = D.rootCauses(tools);
  assert.equal(causes.length, 2);
  assert.deepEqual(causes[0], {
    kind: 'table-denied',
    table: 'sys_security_acl',
    column: '',
    text: 'Your user cannot read sys_security_acl (403).',
    advice: D.problemAdvice('table-denied'),
    blocking: true,
    features: ['A', 'B', 'C'],
  });
  assert.equal(causes[1].table, 'incident');
  assert.equal(causes[1].column, 'ghost');
  assert.match(D.problemAdvice('column-missing'), /NowBuddy developer/);
  assert.equal(D.problemAdvice('anything else').startsWith('Run the self-check again'), true);
});

test('the report lists the causes once each with the tools they affect', () => {
  const md = D.buildReport(sampleResult());
  assert.match(md, /## Causes \(\d+\)/);
  assert.match(md, /- \[blocks\] `sys_security_acl` - Your user cannot read sys_security_acl \(403\)\. Affects 1 tool: Tool Delta\./);
  assert.match(md, /- \[blocks\] `sys_email\.nope_required` - sys_email\.nope_required is not a column on this instance\. Affects 1 tool: Tool Epsilon\./);
});

test('a table that could not be read says why in a few words', () => {
  const ctx = (probe) => ({ schema: SCHEMA, probes: { incident: probe } });
  assert.deepEqual(D.tableState(ctx({ kind: 'busy', status: 503 }), 'incident'), { state: 'unknown', detail: 'incident could not be read: the instance was busy (503).' });
  assert.equal(D.tableState(ctx({ kind: 'timeout' }), 'incident').detail, 'incident could not be read: no answer in time.');
  assert.equal(D.tableState(ctx({ kind: 'network' }), 'incident').detail, 'incident could not be read: the request did not reach the instance.');
  assert.equal(D.tableState(ctx({ kind: 'server', status: 502 }), 'incident').detail, 'incident could not be read: the instance had an internal error (502).');
  assert.equal(D.tableState(ctx({ kind: 'session' }), 'incident').state, 'unknown');
  assert.equal(D.tableState(ctx({ kind: 'denied', status: 403 }), 'incident').state, 'denied');
  assert.equal(D.tableState({ schema: SCHEMA, probes: {} }, 'incident').state, 'unknown', 'a table that was never read is not "ok"');
});
