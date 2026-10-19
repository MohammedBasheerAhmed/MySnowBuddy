const test = require('node:test');
const assert = require('node:assert/strict');
const {
  tableTierNames,
  fieldTierNames,
  aclCandidateNames,
  resolveRoles,
  pathLabel,
  checkRoles,
  checkScript,
  evaluateAccess,
  formatTraceText,
  compactTrace,
  buildRuntimeCheckScript,
  parseRuntimeCheckOutput,
  runtimeAnswer,
  parseAccessArgs,
  RUNTIME_MARKER,
  and3,
  or3,
} = require('../src/lib/accessTrace.js');
const { analyzeScriptRisk } = require('../src/lib/scriptSafety.js');
const { extractScriptOutput } = require('../src/lib/logTail.js');

// ---- Fixtures -----------------------------------------------------------------------------------

const HIERARCHY = ['incident', 'task'];
let counter = 0;

function acl(name, operation, extra = {}) {
  counter += 1;
  return {
    sysId: `acl${counter}`,
    name,
    operation,
    type: 'record',
    active: true,
    decision: 'allow',
    adminOverrides: false,
    roles: [],
    condition: '',
    script: '',
    ...extra,
  };
}

const rolesOf = (...names) => resolveRoles({ direct: names.map((role) => ({ role })) });

function run({ roles = rolesOf(), acls = [], operation = 'read', field = '', user = {}, ...rest }) {
  return evaluateAccess({
    operation,
    table: 'incident',
    hierarchy: HIERARCHY,
    field,
    user: { sysId: 'u1', name: 'Abel Tuter', userName: 'abel.tuter', active: true, ...user },
    roles,
    acls,
    defaultMode: 'deny',
    ...rest,
  });
}

const level = (trace, name) => trace.levels.find((l) => l.level === name);
const tier = (lvl, name) => lvl.tiers.find((t) => t.name === name);

// ---- Names and logic ----------------------------------------------------------------------------

test('candidate ACL names follow ServiceNow evaluation order', () => {
  assert.deepEqual(tableTierNames(HIERARCHY), ['incident', 'task', '*']);
  assert.deepEqual(fieldTierNames(HIERARCHY, 'short_description'), [
    'incident.short_description',
    'task.short_description',
    '*.short_description',
    'incident.*',
    'task.*',
    '*.*',
  ]);
  assert.deepEqual(fieldTierNames(HIERARCHY, ''), []);
  assert.equal(aclCandidateNames(HIERARCHY, 'state').length, 9);
});

test('three-valued and / or', () => {
  assert.equal(and3(['pass', 'unknown']), 'unknown');
  assert.equal(and3(['pass', 'unknown', 'fail']), 'fail');
  assert.equal(and3([]), 'pass');
  assert.equal(or3(['fail', 'unknown']), 'unknown');
  assert.equal(or3(['fail', 'pass']), 'pass');
  assert.equal(or3(['fail']), 'fail');
});

// ---- Table level --------------------------------------------------------------------------------

test('a table ACL on the table itself decides; parent and * ACLs are not used', () => {
  const trace = run({
    roles: rolesOf('snc_internal'),
    acls: [acl('incident', 'read', { roles: ['itil'] }), acl('task', 'read'), acl('*', 'read', { roles: ['admin'] })],
  });
  const t = level(trace, 'table');
  assert.equal(t.decidingTier, 'incident');
  assert.equal(t.status, 'fail');
  assert.equal(tier(t, 'task').skipped, true);
  assert.equal(tier(t, '*').skipped, true);
  assert.equal(trace.verdict.status, 'denied');
  assert.match(trace.verdict.reason, /incident/);
  assert.equal(trace.verdict.decidedBy[0].name, 'incident');
});

test('parent-table ACLs apply when the table has none of its own', () => {
  const trace = run({ roles: rolesOf('itil'), acls: [acl('task', 'read', { roles: ['itil'] }), acl('*', 'read', { roles: ['admin'] })] });
  const t = level(trace, 'table');
  assert.equal(t.decidingTier, 'task');
  assert.equal(trace.verdict.status, 'allowed');
  assert.equal(trace.verdict.title, 'Allowed');
});

test('the * wildcard is the last resort and only admins pass the base one', () => {
  const acls = [acl('*', 'read', { roles: ['admin'] })];
  assert.equal(run({ roles: rolesOf('itil'), acls }).verdict.status, 'denied');
  assert.equal(run({ roles: rolesOf('admin'), acls }).verdict.status, 'allowed');
});

test('ACLs for other operations do not match', () => {
  const trace = run({ roles: rolesOf('itil'), acls: [acl('incident', 'write', { roles: ['admin'] }), acl('incident', 'read', { roles: ['itil'] })] });
  assert.equal(trace.verdict.status, 'allowed');
  assert.equal(tier(level(trace, 'table'), 'incident').allow.length, 1);
});

test('within one level a single passing ACL is enough (OR)', () => {
  const trace = run({
    roles: rolesOf('sn_incident_read'),
    acls: [acl('incident', 'read', { roles: ['itil'] }), acl('incident', 'read', { roles: ['sn_incident_read'] })],
  });
  assert.equal(trace.verdict.status, 'allowed');
  const rows = tier(level(trace, 'table'), 'incident').allow;
  assert.deepEqual(rows.map((r) => r.status).sort(), ['fail', 'pass']);
  assert.match(level(trace, 'table').note, /one passing is enough/);
});

test('a missing role fails with the roles it needs', () => {
  const trace = run({ roles: rolesOf('snc_internal'), acls: [acl('incident', 'read', { roles: ['itil', 'sn_incident_read'] })] });
  const row = tier(level(trace, 'table'), 'incident').allow[0];
  assert.equal(row.checks.roles.status, 'fail');
  assert.match(row.checks.roles.detail, /itil, sn_incident_read/);
  assert.equal(trace.verdict.status, 'denied');
});

// ---- Field level --------------------------------------------------------------------------------

test('both levels must pass: a field ACL can deny when the table allows', () => {
  const trace = run({
    roles: rolesOf('itil'),
    field: 'u_salary',
    acls: [acl('incident', 'read', { roles: ['itil'] }), acl('incident.u_salary', 'read', { roles: ['hr_admin'] })],
  });
  assert.equal(level(trace, 'table').status, 'pass');
  assert.equal(level(trace, 'field').status, 'fail');
  assert.equal(trace.verdict.status, 'denied');
  assert.match(trace.verdict.reason, /incident\.u_salary/);
});

test('field ACL order: table.field, parent.field, *.field, then table.*', () => {
  const acls = [
    acl('incident', 'write', { roles: ['itil'] }),
    acl('task.state', 'write', { roles: ['itil'] }),
    acl('*.state', 'write', { roles: ['admin'] }),
    acl('incident.*', 'write', { roles: ['admin'] }),
  ];
  const trace = run({ roles: rolesOf('itil'), operation: 'write', field: 'state', acls });
  const f = level(trace, 'field');
  assert.equal(f.decidingTier, 'task.state');
  assert.equal(tier(f, '*.state').skipped, true);
  assert.equal(tier(f, 'incident.*').skipped, true);
  assert.equal(trace.verdict.status, 'allowed');

  // Without the parent.field ACL, *.field beats table.*.
  const wild = run({ roles: rolesOf('itil'), operation: 'write', field: 'state', acls: acls.filter((a) => a.name !== 'task.state') });
  assert.equal(level(wild, 'field').decidingTier, '*.state');
  assert.equal(wild.verdict.status, 'denied');
});

test('table.* applies to every field when nothing more specific matches', () => {
  const trace = run({ roles: rolesOf('itil'), field: 'priority', acls: [acl('incident', 'read', { roles: ['itil'] }), acl('incident.*', 'read', { roles: ['itil'] })] });
  assert.equal(level(trace, 'field').decidingTier, 'incident.*');
  assert.equal(trace.verdict.status, 'allowed');
});

test('no field ACL: the field follows the record result', () => {
  const trace = run({ roles: rolesOf('itil'), field: 'priority', acls: [acl('incident', 'read', { roles: ['itil'] })] });
  const f = level(trace, 'field');
  assert.equal(f.noMatch, true);
  assert.equal(f.status, 'pass');
  assert.equal(trace.verdict.status, 'allowed');
});

test('a failed table level means field ACLs are not reached', () => {
  const trace = run({ roles: rolesOf('itil'), field: 'priority', acls: [acl('incident', 'read', { roles: ['admin'] }), acl('incident.priority', 'read')] });
  assert.equal(level(trace, 'field').notReached, true);
  assert.equal(trace.verdict.status, 'denied');
  assert.match(trace.verdict.reason, /^Cannot read incident records/);
});

// ---- admin, inactive, default mode --------------------------------------------------------------

test('admin override passes an ACL whose script would otherwise decide at runtime', () => {
  const scripted = { roles: ['itil'], script: 'answer = gs.getUser().isMemberOf("CAB");', advanced: true };
  const withOverride = run({ roles: rolesOf('admin'), acls: [acl('incident', 'read', { ...scripted, adminOverrides: true })] });
  const row = tier(level(withOverride, 'table'), 'incident').allow[0];
  assert.equal(row.admin, true);
  assert.equal(withOverride.verdict.status, 'allowed');

  const without = run({ roles: rolesOf('admin'), acls: [acl('incident', 'read', scripted)] });
  const row2 = tier(level(without, 'table'), 'incident').allow[0];
  assert.equal(row2.checks.roles.status, 'pass', 'admin inherits itil');
  assert.match(row2.checks.roles.detail, /admin/);
  assert.equal(row2.checks.script.status, 'unknown');
  assert.equal(without.verdict.status, 'depends');
  assert.match(without.verdict.reason, /incident/);

  // admin_overrides does nothing for a user without admin.
  const nonAdmin = run({ roles: rolesOf('snc_internal'), acls: [acl('incident', 'read', { roles: ['itil'], adminOverrides: true })] });
  assert.equal(nonAdmin.verdict.status, 'denied');
});

test('admin does not inherit elevated roles', () => {
  const roles = resolveRoles({ direct: [{ role: 'admin' }], elevated: ['security_admin'] });
  const trace = run({ roles, acls: [acl('incident', 'read', { roles: ['security_admin'] })], elevatedRoles: ['security_admin'] });
  assert.equal(trace.verdict.status, 'denied');

  const holder = resolveRoles({ direct: [{ role: 'security_admin' }], elevated: ['security_admin'] });
  const held = run({ roles: holder, acls: [acl('incident', 'read', { roles: ['security_admin'] })] });
  assert.equal(held.verdict.status, 'depends');
  assert.match(tier(level(held, 'table'), 'incident').allow[0].checks.roles.detail, /elevated/);
});

test('inactive ACLs are ignored and listed separately', () => {
  const trace = run({
    roles: rolesOf('itil'),
    acls: [acl('incident', 'read', { roles: ['admin'], active: false }), acl('task', 'read', { roles: ['itil'] })],
  });
  assert.equal(level(trace, 'table').decidingTier, 'task');
  assert.equal(trace.verdict.status, 'allowed');
  assert.deepEqual(trace.inactive.map((a) => a.name), ['incident']);
});

test('no matching ACL: glide.sm.default_mode decides', () => {
  const denyMode = run({ roles: rolesOf('itil'), acls: [] });
  assert.equal(level(denyMode, 'table').noMatch, true);
  assert.equal(denyMode.verdict.status, 'denied');
  assert.match(denyMode.verdict.reason, /default_mode/);
  assert.equal(run({ roles: rolesOf('admin'), acls: [] }).verdict.status, 'allowed');
  assert.equal(run({ roles: rolesOf('itil'), acls: [], defaultMode: 'allow' }).verdict.status, 'allowed');
  const unknownMode = run({ roles: rolesOf('itil'), acls: [], defaultMode: '' });
  assert.equal(unknownMode.verdict.status, 'depends');
  assert.match(unknownMode.verdict.reason, /default_mode/);
});

test('an inactive or locked-out user is denied whatever the ACLs say', () => {
  const acls = [acl('incident', 'read')];
  const inactive = run({ acls, user: { active: false } });
  assert.equal(inactive.verdict.status, 'denied');
  assert.match(inactive.verdict.reason, /inactive/);
  const locked = run({ acls, user: { lockedOut: true } });
  assert.match(locked.verdict.reason, /locked out/);
});

// ---- Deny-Unless --------------------------------------------------------------------------------

test('a failing Deny-Unless ACL denies even when an Allow-If ACL passes', () => {
  const acls = [acl('incident', 'read', { roles: ['snc_internal'] }), acl('incident', 'read', { decision: 'deny', roles: ['itil'] })];
  const denied = run({ roles: rolesOf('snc_internal'), acls });
  assert.equal(level(denied, 'table').denyStatus, 'fail');
  assert.equal(level(denied, 'table').allowStatus, 'pass');
  assert.equal(denied.verdict.status, 'denied');
  assert.match(denied.verdict.reason, /Deny-Unless/);

  assert.equal(run({ roles: rolesOf('snc_internal', 'itil'), acls }).verdict.status, 'allowed');
});

test('Deny-Unless ACLs on less specific names still apply, and do not count as Allow-If matches', () => {
  const acls = [acl('*', 'read', { decision: 'deny', roles: ['itil'] }), acl('incident', 'read')];
  const trace = run({ roles: rolesOf('snc_internal'), acls });
  assert.equal(trace.verdict.status, 'denied');
  assert.equal(level(trace, 'table').decidingTier, 'incident');

  // A passing Deny-Unless with no Allow-If match falls back to the default mode.
  const onlyDeny = run({ roles: rolesOf('itil'), acls: [acl('incident', 'read', { decision: 'deny', roles: ['itil'] })], defaultMode: 'allow' });
  assert.equal(level(onlyDeny, 'table').noMatch, true);
  assert.match(level(onlyDeny, 'table').note, /A Deny-Unless ACL must also pass/);
  assert.equal(onlyDeny.verdict.status, 'allowed');
});

// ---- Conditions, scripts, applies to ------------------------------------------------------------

test('conditions use the record checks when available, otherwise runtime', () => {
  const a = acl('incident', 'write', { roles: ['itil'], condition: 'active=true' });
  const pass = run({ roles: rolesOf('itil'), operation: 'write', acls: [a], conditionChecks: { [a.sysId]: true } });
  assert.equal(pass.verdict.status, 'allowed');
  const fail = run({ roles: rolesOf('itil'), operation: 'write', acls: [a], conditionChecks: { [a.sysId]: false } });
  assert.equal(fail.verdict.status, 'denied');
  const unknown = run({ roles: rolesOf('itil'), operation: 'write', acls: [a] });
  assert.equal(unknown.verdict.status, 'depends');
  const row = tier(level(unknown, 'table'), 'incident').allow[0];
  assert.match(row.checks.condition.text, /active is true/);
  // A role failure decides even when the condition is unknown.
  assert.equal(run({ roles: rolesOf('snc_internal'), operation: 'write', acls: [a] }).verdict.status, 'denied');
});

test('trivial scripts are decided; others are runtime; Advanced off means unused', () => {
  assert.equal(checkScript({ script: '' }).status, 'pass');
  assert.equal(checkScript({ script: '// always\nanswer = true;' }).status, 'pass');
  assert.equal(checkScript({ script: '/* no */ answer=false' }).status, 'fail');
  assert.equal(checkScript({ script: 'answer = gs.hasRole("itil");' }).status, 'unknown');
  assert.equal(checkScript({ script: 'answer = false;', advanced: false }).status, 'pass');
  const long = Array.from({ length: 40 }, (_, i) => `var x${i} = ${i};`).join('\n');
  assert.match(checkScript({ script: long }).excerpt, /more lines/);
});

test('an ACL that does not apply to the record is ignored', () => {
  const scoped = acl('incident', 'read', { roles: ['admin'], appliesTo: 'priority=1' });
  const general = acl('task', 'read', { roles: ['itil'] });
  const ignored = run({ roles: rolesOf('itil'), acls: [scoped, general], appliesChecks: { [scoped.sysId]: false } });
  assert.equal(level(ignored, 'table').decidingTier, 'task');
  assert.equal(tier(level(ignored, 'table'), 'incident').ignored.length, 1);
  assert.equal(ignored.verdict.status, 'allowed');

  const applies = run({ roles: rolesOf('itil'), acls: [scoped, general], appliesChecks: { [scoped.sysId]: true } });
  assert.equal(applies.verdict.status, 'denied');
});

test('external users and ACLs without roles', () => {
  const roles = rolesOf('snc_external');
  const ctx = { roleIndex: new Map(roles.roles.map((r) => [r.name, r])), isAdmin: false, external: true, elevated: new Set() };
  assert.equal(checkRoles([], ctx).status, 'unknown');
  assert.equal(checkRoles(['snc_internal'], ctx).status, 'fail');
  const internal = { ...ctx, external: false, roleIndex: new Map() };
  assert.equal(checkRoles(['snc_internal'], internal).status, 'pass');
});

// ---- Roles --------------------------------------------------------------------------------------

test('roles are resolved through groups and containment with their paths', () => {
  const result = resolveRoles({
    direct: [{ role: 'itil', roleId: 'r-itil' }],
    groupRoles: [
      { group: 'Service Desk', groupId: 'g1', role: 'sn_incident_write', roleId: 'r-w' },
      { group: 'Old team', groupId: 'g2', role: 'catalog_admin', groupActive: false },
      { group: 'No inherit', groupId: 'g3', role: 'approver_user', inherits: false },
    ],
    contains: [
      { parent: 'itil', child: 'sn_incident_read' },
      { parent: 'sn_incident_write', child: 'sn_incident_read' },
      { parent: 'sn_incident_read', child: 'itil' }, // a cycle must not loop forever
    ],
    elevated: ['security_admin'],
  });
  const names = result.roles.map((r) => r.name);
  assert.deepEqual(names, ['itil', 'sn_incident_read', 'sn_incident_write']);
  const read = result.roles.find((r) => r.name === 'sn_incident_read');
  assert.deepEqual(read.paths.map(pathLabel).sort(), ['direct > itil', 'group Service Desk > sn_incident_write']);
  assert.equal(pathLabel(result.roles.find((r) => r.name === 'itil').paths[0]), 'direct');
});

test('sys_user_has_role is authoritative when it can be read', () => {
  const result = resolveRoles({
    direct: [{ role: 'itil' }],
    groupRoles: [{ group: 'CAB', role: 'change_manager' }],
    assigned: [
      { role: 'itil', active: true },
      { role: 'report_user', active: true, grantedBy: 'Reporting' },
      { role: 'change_manager', active: false },
    ],
  });
  assert.deepEqual(result.roles.map((r) => r.name), ['itil', 'report_user']);
  assert.deepEqual(result.unconfirmed, ['change_manager']);
  assert.equal(pathLabel(result.roles.find((r) => r.name === 'report_user').paths[0]), 'group Reporting');
});

// ---- Output -------------------------------------------------------------------------------------

test('text and compact output name the verdict and the deciding ACL', () => {
  const trace = run({
    roles: rolesOf('snc_internal'),
    field: 'u_salary',
    acls: [acl('incident', 'read', { roles: ['snc_internal'] }), acl('incident.u_salary', 'read', { roles: ['hr_admin'], script: 'var password = "hunter22"; answer = true;' })],
    others: [{ kind: 'query_rules', caveat: true, title: '1 before-query business rule can filter records out: incident query', detail: 'x', items: [{ name: 'incident query' }] }],
  });
  const text = formatTraceText(trace);
  assert.match(text, /Verdict: Denied/);
  assert.match(text, /incident\.u_salary \[allow-if\] FAIL/);
  assert.match(text, /incident query/);
  const compact = compactTrace(trace);
  assert.equal(compact.verdict.status, 'denied');
  assert.deepEqual(compact.verdict.decidedBy, ['incident.u_salary']);
  assert.equal(compact.levels[1].tiers[0].acls[0].result, 'FAIL');
  assert.equal(compact.otherFactors[0].items[0].name, 'incident query');
  assert.ok(JSON.stringify(compact).length < 6000);
});

test('caveats turn "Allowed" into "Allowed by ACLs"', () => {
  const trace = run({ roles: rolesOf('itil'), acls: [acl('incident', 'read', { roles: ['itil'] })], others: [{ kind: 'domain', caveat: true, title: 'Different domain' }] });
  assert.equal(trace.verdict.status, 'allowed');
  assert.equal(trace.verdict.title, 'Allowed by ACLs');
  assert.deepEqual(trace.verdict.caveats, ['Different domain']);
});

test('query_range ACLs are listed as related for read', () => {
  const trace = run({ roles: rolesOf('itil'), acls: [acl('incident', 'read', { roles: ['itil'] }), acl('incident', 'query_range', { roles: ['itil'] })] });
  assert.deepEqual(trace.related.map((r) => r.operation), ['query_range']);
});

test('slash arguments: user, operation, field and sys_id in any order', () => {
  assert.deepEqual(parseAccessArgs('abel.tuter write short_description'), { user: 'abel.tuter', operation: 'write', field: 'short_description', sysId: '' });
  assert.deepEqual(parseAccessArgs('"Abel Tuter" edit'), { user: 'Abel Tuter', operation: 'write', field: '', sysId: '' });
  assert.deepEqual(parseAccessArgs(`delete me ${'A'.repeat(32).replace(/A/g, 'b')}`), { user: 'me', operation: 'delete', field: '', sysId: 'b'.repeat(32) });
  assert.deepEqual(parseAccessArgs(''), { user: '', operation: '', field: '', sysId: '' });
  assert.equal(parseAccessArgs('bob see bad-field!').field, '');
});

// ---- Review follow-ups --------------------------------------------------------------------------

test('reporting: report_on is offered and a missing report ACL is uncertain, not denied', () => {
  const { OPERATIONS, OPERATION_LABELS } = require('../src/lib/accessTrace.js');
  assert.ok(OPERATIONS.includes('report_on'));
  assert.equal(OPERATION_LABELS.report_view, 'view report data on');
  assert.equal(parseAccessArgs('bob report').operation, 'report_on');
  const acls = [acl('incident', 'read', { roles: ['itil'] })];
  for (const operation of ['report_view', 'report_on']) {
    const trace = run({ roles: rolesOf('itil'), operation, field: operation === 'report_view' ? 'priority' : '', acls });
    assert.equal(trace.verdict.status, 'depends', operation);
    assert.doesNotMatch(trace.verdict.reason, /only admins/);
  }
  // A matching report ACL still decides normally.
  const decided = run({ roles: rolesOf('itil'), operation: 'report_on', acls: [acl('incident', 'report_on', { roles: ['report_admin'] })] });
  assert.equal(decided.verdict.status, 'denied');
});

test('create on a field with no field create ACL also looks at the field write ACLs', () => {
  const acls = [acl('incident', 'create', { roles: ['itil'] }), acl('incident.priority', 'write', { roles: ['admin'] })];
  const trace = run({ roles: rolesOf('itil'), operation: 'create', field: 'priority', acls });
  assert.equal(level(trace, 'field').status, 'unknown');
  const fallback = trace.levels.find((l) => l.level === 'field_write');
  assert.ok(fallback, 'the write ACLs are shown');
  assert.equal(fallback.status, 'fail');
  assert.equal(trace.verdict.status, 'depends');
  assert.match(trace.verdict.reason, /fall back to the field write ACLs \(incident\.priority\)/);
  assert.match(formatTraceText(trace), /Field write ACLs \(possible fallback for create\)/);

  // When the write ACLs pass, nothing changes.
  const ok = run({ roles: rolesOf('itil', 'admin'), operation: 'create', field: 'priority', acls });
  assert.equal(ok.verdict.status, 'allowed');
  // A field create ACL decides on its own; no fallback.
  const own = run({ roles: rolesOf('itil'), operation: 'create', field: 'priority', acls: [...acls, acl('incident.priority', 'create', { roles: ['itil'] })] });
  assert.equal(own.levels.some((l) => l.level === 'field_write'), false);
  assert.equal(own.verdict.status, 'allowed');
});

test('a field denial under a runtime record level is not described as "can write the record"', () => {
  const trace = run({
    roles: rolesOf('itil'),
    operation: 'write',
    field: 'priority',
    acls: [acl('incident', 'write', { roles: ['itil'], script: 'answer = current.active;' }), acl('incident.priority', 'write', { roles: ['admin'] })],
  });
  assert.equal(level(trace, 'table').status, 'unknown');
  assert.equal(trace.verdict.status, 'denied');
  assert.doesNotMatch(trace.verdict.reason, /Can write the record/);
  assert.match(trace.verdict.reason, /Whatever the record-level result/);
});

test('runtime parser takes the last result line, not an echo of the script source', () => {
  const script = buildRuntimeCheckScript({ table: 'incident' });
  const result = `${RUNTIME_MARKER} {"user":"admin","userId":"u","table":"incident","id":"","field":"","canCreate":true,"canRead":true,"canWrite":false,"canDelete":false}`;
  const parsed = parseRuntimeCheckOutput(`${script}\n*** Script: ${result}`);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.record.write, false);
  // A stale or partial earlier line does not win over the final one.
  const twice = parseRuntimeCheckOutput(`${RUNTIME_MARKER} {"error":"x"}\n${result}`);
  assert.equal(twice.ok, true);
  assert.equal(runtimeAnswer(parsed, 'report_view', ''), null);
});

test('runtime errors that can come from the global scope say so', () => {
  const { RUNTIME_SCOPE_HINT } = require('../src/lib/accessTrace.js');
  assert.ok(parseRuntimeCheckOutput(`${RUNTIME_MARKER} {"error":"no_table","table":"x_app_private"}`).error.includes(RUNTIME_SCOPE_HINT));
  assert.ok(parseRuntimeCheckOutput(`${RUNTIME_MARKER} {"error":"Access to x_app_private from scope rhino.global has been refused"}`).error.includes(RUNTIME_SCOPE_HINT));
  assert.ok(!parseRuntimeCheckOutput(`${RUNTIME_MARKER} {"error":"boom"}`).error.includes(RUNTIME_SCOPE_HINT));
});

test('a truncated sys_user_has_role list does not drop group or contained roles', () => {
  const input = {
    direct: [{ role: 'itil' }],
    groupRoles: [{ group: 'CAB', role: 'change_manager' }],
    assigned: [{ role: 'itil', active: true }],
  };
  assert.deepEqual(resolveRoles(input).unconfirmed, ['change_manager']);
  const truncated = resolveRoles({ ...input, assignedComplete: false });
  assert.deepEqual(truncated.unconfirmed, []);
  assert.deepEqual(truncated.roles.map((r) => r.name), ['change_manager', 'itil']);
});

// ---- Query safety -------------------------------------------------------------------------------

test('free-text terms allow names, user names and emails, and refuse script or query syntax', () => {
  const { safeQueryTerm } = require('../src/lib/accessTrace.js');
  ['abel.tuter', 'Abel Tuter', "O'Brien", 'abel@example.com', 'abel+test@example.com', 'José Müller', 'Ünal-Øster', '', 'me', 'a'.repeat(32)].forEach((ok) => {
    assert.equal(safeQueryTerm(ok), ok.trim(), ok);
  });
  assert.equal(safeQueryTerm('  Abel   Tuter  '), 'Abel Tuter');
  [
    "javascript:gs.getProperty('glide.x')",
    ' JavaScript : gs.log(1)',
    'my javascript user',
    'name=x',
    'a^ORactive=true',
    'x:y',
    'abel,tuter',
    'a<b>',
  ].forEach((bad) => assert.throws(() => safeQueryTerm(bad, 'User'), /User/, bad));
});

test('explainAccess validates the user term before any request, and accepts report_on', async () => {
  const { explainAccess, accessSearchUsers, accessSearchTables } = require('../src/content/accessDebugger.js');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('no network in tests');
  };
  try {
    await assert.rejects(explainAccess({ user: 'javascript:gs.log(1)', table: 'incident', operation: 'report_on' }), /javascript/);
    await assert.rejects(explainAccess({ user: 'name=admin', table: 'incident', operation: 'report_on' }), /only contain letters/);
    await assert.rejects(explainAccess({ user: 'abel', table: 'incident', operation: 'bogus' }), /Operation must be one of/);
    assert.deepEqual(await accessSearchUsers("javascript:gs.getProperty('x')"), []);
    assert.deepEqual(await accessSearchUsers('a^ORactive=true'), []);
    assert.deepEqual(await accessSearchTables('incident^ORnameLIKEx'), []);
    assert.equal(calls, 0, 'nothing was sent to the instance');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- Runtime check script -----------------------------------------------------------------------

const SYS_ID = '0123456789abcdef0123456789abcdef';

test('the runtime check script is read-only', () => {
  const script = buildRuntimeCheckScript({ table: 'incident', sysId: SYS_ID, field: 'short_description' });
  const risk = analyzeScriptRisk(script);
  assert.equal(risk.hasWrites, false, JSON.stringify(risk.writes));
  const forbidden = /\.\s*(insert|update|deleteRecord|deleteMultiple|updateMultiple|setValue|setDisplayValue|initialize|newRecord|setWorkflow|autoSysFields|setProperty|eventQueue|getSession|impersonate|setForceUpdate|applyTemplate)\s*\(|GlideMultipleUpdate|GlideDBUtil|executeSQL|RESTMessage|SOAPMessage/;
  assert.equal(forbidden.test(script), false);
  assert.match(script, /canRead\(\)/);
  assert.match(script, /canCreate\(\)/);
  assert.match(script, /getElement\(field\)/);
  assert.ok(script.includes(`"${SYS_ID}"`));
});

test('the runtime check script rejects anything that is not a plain name or sys_id', () => {
  assert.throws(() => buildRuntimeCheckScript({ table: "incident'); gs.setProperty('x','y" }), /table/);
  assert.throws(() => buildRuntimeCheckScript({ table: 'incident', sysId: 'abc' }), /sys_id/);
  assert.throws(() => buildRuntimeCheckScript({ table: 'incident', field: 'a.b' }), /field/);
  assert.doesNotThrow(() => buildRuntimeCheckScript({ table: 'incident' }));
});

test('runtime output is parsed from the sys.scripts.do page', () => {
  const payload = { user: 'admin', userId: 'abc', table: 'incident', id: SYS_ID, field: 'state', canCreate: true, found: true, canRead: true, canWrite: false, canDelete: false, fieldCanRead: true, fieldCanWrite: false };
  const html = `<html><body>[0:00:00.010] Script completed in scope global: script<br/><hr/><pre>*** Script: ${RUNTIME_MARKER} ${JSON.stringify(payload).replace(/"/g, '&quot;')}<br/></pre></body></html>`;
  const parsed = parseRuntimeCheckOutput(extractScriptOutput(html));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.user, 'admin');
  assert.deepEqual(parsed.record, { read: true, write: false, create: true, delete: false });
  assert.deepEqual(parsed.field, { read: true, write: false, create: null });
  assert.equal(runtimeAnswer(parsed, 'read', 'state'), true);
  assert.equal(runtimeAnswer(parsed, 'write', 'state'), false);
  assert.equal(runtimeAnswer(parsed, 'write', ''), false);
  assert.equal(runtimeAnswer(parsed, 'create', ''), true);
});

test('runtime output errors are reported, not thrown', () => {
  assert.equal(parseRuntimeCheckOutput('').ok, false);
  assert.match(parseRuntimeCheckOutput('Security restricted: not authorized').error, /not authorized/);
  assert.equal(parseRuntimeCheckOutput(`${RUNTIME_MARKER} {broken`).ok, false);
  assert.match(parseRuntimeCheckOutput(`${RUNTIME_MARKER} {"error":"no_table","table":"x"}`).error, /does not exist/);
  assert.match(parseRuntimeCheckOutput(`${RUNTIME_MARKER} {"id":"${SYS_ID}","found":false}`).error, /No record/);
});

test('script output stops at the platform\'s own SQL debug lines', () => {
  const html = '<html><pre>*** Script: users 642 as admin<br/>[MySnowBuddy] Finished in 26ms.<br/>Time: 0:00:00.119 id: dev364920_1[glide.2] primary_hash=1551417892 (connpid=402177) for: SELECT<br/>sys_script_execution_history0.`executed_by`,<br/>FROM sys_script_execution_history</pre></html>';
  assert.equal(extractScriptOutput(html), 'users 642 as admin\n[MySnowBuddy] Finished in 26ms.');
  assert.equal(extractScriptOutput('<pre>Time stamp: not a debug line</pre>'), 'Time stamp: not a debug line');
});
