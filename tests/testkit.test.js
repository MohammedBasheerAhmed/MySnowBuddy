const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSyntax } = require('../src/lib/syntax.js');
const { wrapAsDryRun } = require('../src/lib/scriptSafety.js');
const {
  RUN_KINDS,
  runKindForTable,
  parseCallArgs,
  parseSetValues,
  buildRecordScript,
  analyzeForRun,
  parseRunOutput,
  summarizeRun,
} = require('../src/lib/testRun.js');
const {
  extractMethods,
  sampleFor,
  generateUnitTest,
  parseTestOutput,
  makeSavedTest,
  upsertSavedTest,
  removeSavedTest,
  recordSavedRun,
  matrixCell,
  matrixToMarkdown,
  buildChecklist,
  checklistKindForTable,
  checklistToMarkdown,
} = require('../src/lib/testKit.js');
const snap = require('../src/lib/testSnapshot.js');
const atf = require('../src/lib/testAtf.js');

const ID = '0123456789abcdef0123456789abcdef';
const ID2 = 'fedcba9876543210fedcba9876543210';

/** A tiny stand-in for the server: GlideRecord, gs and Class, enough to execute the scripts the builders generate. */
function serverRun(script, records = {}) {
  const logs = [];
  const gs = { info: (m) => logs.push(String(m)), error: (m) => logs.push(`ERROR ${m}`) };
  class GlideRecord {
    constructor(table) {
      this.table = table;
      this.vals = {};
      this.aborted = false;
    }
    get(id) {
      const row = records[`${this.table}:${id}`];
      if (!row) return false;
      this.vals = { ...row };
      return true;
    }
    getValue(name) {
      return name in this.vals ? this.vals[name] : null;
    }
    setValue(name, value) {
      this.vals[name] = value;
    }
    getDisplayValue() {
      return this.vals.number || '';
    }
    getFields() {
      const names = Object.keys(this.vals);
      return { size: () => names.length, get: (i) => ({ getName: () => names[i] }) };
    }
    getTableName() {
      return this.table;
    }
    getUniqueValue() {
      return ID;
    }
    isActionAborted() {
      return this.aborted;
    }
    setAbortAction(v) {
      this.aborted = Boolean(v);
    }
    update() {
      logs.push('UPDATE REACHED THE SERVER');
    }
  }
  const Class = {
    create() {
      return function Ctor(...args) {
        if (this.initialize) this.initialize(...args);
      };
    },
  };
  const hadExtends = 'extendsObject' in Object;
  if (!hadExtends) Object.extendsObject = (parent, body) => body;
  try {
    new Function('gs', 'GlideRecord', 'Class', script)(gs, GlideRecord, Class);
  } finally {
    if (!hadExtends) delete Object.extendsObject;
  }
  return logs;
}

const INCIDENT = { [`incident:${ID}`]: { number: 'INC0010001', state: '2', priority: '3', short_description: 'VPN down' } };

test('a script is offered the run kind its table implies', () => {
  assert.equal(runKindForTable('sys_script'), 'businessRule');
  assert.equal(runKindForTable('sys_ui_action'), 'uiAction');
  assert.equal(runKindForTable('sys_script_include'), 'scriptInclude');
  assert.equal(runKindForTable('sys_script_fix'), 'fixScript');
  assert.equal(runKindForTable('incident'), null);
  assert.ok(RUN_KINDS.businessRule.needsRecord && !RUN_KINDS.scriptInclude.needsRecord);
});

test('arguments and pretend-changed fields are validated before anything is built', () => {
  assert.deepEqual(parseCallArgs('').args, []);
  assert.deepEqual(parseCallArgs('["@current", "x", 5, null]').args, ['@current', 'x', 5, null]);
  assert.equal(parseCallArgs('current, 5').ok, false, 'code is not accepted as an argument list');
  assert.equal(parseCallArgs('{"a":1}').ok, false);
  assert.equal(parseCallArgs(JSON.stringify(new Array(13).fill(1))).ok, false);
  assert.deepEqual(parseSetValues('{"state": 6, "assigned_to": null, "ok": true}').values, { state: '6', assigned_to: '', ok: 'true' });
  assert.equal(parseSetValues('{"bad field": 1}').ok, false);
  assert.equal(parseSetValues('{"a^b": 1}').ok, false, 'no query injection through a field name');
  assert.equal(parseSetValues('[1]').ok, false);
  assert.equal(parseSetValues('').ok, true);
});

test('a run needs what it runs against', () => {
  assert.throws(() => buildRecordScript({ kind: 'businessRule', script: 'x', table: 'incident', sysId: '' }), /Choose the record/);
  assert.throws(() => buildRecordScript({ kind: 'businessRule', script: 'x', table: 'bad table', sysId: ID }), /Name the table/);
  assert.throws(() => buildRecordScript({ kind: 'businessRule', script: '  ', table: 'incident', sysId: ID }), /no script/);
  assert.throws(() => buildRecordScript({ kind: 'scriptInclude', table: '', className: 'Foo', method: '9x' }), /method/);
  assert.throws(() => buildRecordScript({ kind: 'scriptInclude', className: 'Foo bar', method: 'go' }), /class/);
  assert.throws(() => buildRecordScript({ kind: 'nope', script: 'x' }), /Choose what to run/);
  assert.throws(() => buildRecordScript({ kind: 'businessRule', script: 'x', table: 'incident', sysId: ID, set: { 'a^b': '1' } }), /not a field name/);
});

test('a business rule runs with current and previous bound to the chosen record', () => {
  const built = buildRecordScript({
    kind: 'businessRule',
    script: "(function executeRule(current, previous /*null when async*/) {\n  if (current.getValue('priority') === '3') current.setValue('priority', '1');\n  current.update();\n})(current, previous);",
    table: 'incident',
    sysId: ID,
  });
  assert.equal(checkSyntax(built.script), null);
  assert.equal(checkSyntax(wrapAsDryRun(built.script)), null, 'and inside the dry run wrapper');
  const out = parseRunOutput(serverRun(built.script, INCIDENT).join('\n'));
  assert.deepEqual(out.changes, [{ field: 'priority', before: '3', after: '1' }]);
  assert.ok(out.logs.some((l) => /UPDATE REACHED THE SERVER/.test(l)), 'the mock server saw the update (the real dry run wrapper intercepts it)');
  assert.equal(out.aborted, false);
  assert.ok(out.notes.some((n) => /record: incident \/ INC0010001/.test(n)));
});

test('executeRule is called exactly once whether the script calls it or not', () => {
  const body = (call) => `var calls = 0;\nfunction executeRule(current, previous) { calls++; gs.info('called ' + calls); }\n${call}`;
  const defined = buildRecordScript({ kind: 'businessRule', script: body(''), table: 'incident', sysId: ID });
  assert.equal(serverRun(defined.script, INCIDENT).filter((l) => /^called/.test(l)).length, 1);
  const called = buildRecordScript({ kind: 'businessRule', script: body('executeRule(current, previous);'), table: 'incident', sysId: ID });
  assert.equal(serverRun(called.script, INCIDENT).filter((l) => /^called/.test(l)).length, 1, 'no second call when the script already makes one');
});

test('pretending a field changed happens in memory and is reported, and a missing record stops the run', () => {
  const built = buildRecordScript({ kind: 'businessRule', script: "gs.info('state is ' + current.getValue('state'));", table: 'incident', sysId: ID, set: { state: '6' } });
  const logs = serverRun(built.script, INCIDENT);
  assert.ok(logs.includes('state is 6'), 'the script sees the pretended value');
  const out = parseRunOutput(logs.join('\n'));
  assert.deepEqual(out.changes, [{ field: 'state', before: '2', after: '6' }]);
  assert.throws(() => serverRun(built.script, {}), /record not found/);
});

test('a rule that aborts the action says so', () => {
  const built = buildRecordScript({ kind: 'businessRule', script: 'current.setAbortAction(true);', table: 'incident', sysId: ID });
  const out = parseRunOutput(serverRun(built.script, INCIDENT).join('\n'));
  assert.equal(out.aborted, true);
  assert.match(summarizeRun(out), /aborted/);
});

test('a UI action gets an action object that records where it would send you', () => {
  const built = buildRecordScript({ kind: 'uiAction', script: 'action.setRedirectURL(current);', table: 'incident', sysId: ID });
  const logs = serverRun(built.script, INCIDENT);
  assert.ok(logs.some((l) => /action\.setRedirectURL -> incident /.test(l)));
});

test('a Script Include method is called with the arguments, including the bound record', () => {
  const source = `var Greeter = Class.create();\nGreeter.prototype = {\n  initialize: function () { this.greeting = 'Hello'; },\n  greet: function (name, gr) { return { text: this.greeting + ' ' + name, number: gr ? gr.getValue('number') : '' }; },\n  type: 'Greeter'\n};`;
  const built = buildRecordScript({ kind: 'scriptInclude', script: source, className: 'Greeter', method: 'greet', args: ['Ada', '@current'], table: 'incident', sysId: ID });
  assert.equal(checkSyntax(built.script), null);
  const out = parseRunOutput(serverRun(built.script, INCIDENT).join('\n'));
  assert.deepEqual(JSON.parse(out.result), { text: 'Hello Ada', number: 'INC0010001' });
  assert.throws(() => buildRecordScript({ kind: 'scriptInclude', script: source, className: 'Greeter', method: 'greet', args: ['@current'] }), /needs a record/);
  const scoped = buildRecordScript({ kind: 'scriptInclude', script: '', className: 'x_app.Greeter', method: 'greet', args: [], includeSource: true });
  assert.match(scoped.script, /new x_app\.Greeter\(\)\.greet\(\)/, 'without source the full API name is called');
});

test('strings in arguments cannot break out of the generated script', () => {
  const nasty = '"); gs.info("pwned"); ("';
  const built = buildRecordScript({ kind: 'scriptInclude', script: 'var F = Class.create(); F.prototype = { go: function (x) { return x; } };', className: 'F', method: 'go', args: [nasty] });
  const logs = serverRun(built.script);
  assert.ok(!logs.includes('pwned'));
  assert.equal(parseRunOutput(logs.join('\n')).result, nasty);
});

test('warnings explain what a test run cannot do', () => {
  const texts = (kind, script) => analyzeForRun(kind, script).map((w) => w.text).join(' | ');
  assert.match(texts('businessRule', "g_form.setValue('a', 1);"), /client-side/);
  assert.match(texts('businessRule', 'current.update();'), /before rule/);
  assert.match(texts('businessRule', 'function executeRule(current, previous) {}'), /defines executeRule/);
  assert.match(texts('businessRule', "gs.eventQueue('x', current);"), /does NOT block/);
  assert.doesNotMatch(texts('fixScript', 'var a = 1;'), /previous/);
});

test('dry run output is sorted into writes, changes, errors and logs', () => {
  const output = [
    '[NowBuddy test] record: incident / INC0010001',
    '[NowBuddy test] changed priority: 3 -> 1',
    'my own log line',
    '[NowBuddy dry run] Completed. 2 write operation(s) were SUPPRESSED.',
    '[NowBuddy dry run] 1. update -> incident / abc',
    '[NowBuddy dry run] 2. insert -> task / new',
  ].join('\n');
  const parsed = parseRunOutput(output);
  assert.deepEqual(parsed.writes, ['update -> incident / abc', 'insert -> task / new']);
  assert.equal(parsed.writeCount, 2);
  assert.deepEqual(parsed.logs, ['my own log line']);
  assert.match(summarizeRun(parsed), /2 writes suppressed/);
  assert.match(summarizeRun(parseRunOutput('[NowBuddy dry run] Script threw: TypeError: x is null')), /stopped with an error: TypeError: x is null/);
  assert.match(summarizeRun(parseRunOutput('[NowBuddy] Dry run is NOT available in this scope - x')), /not available/);
  assert.equal(parseRunOutput('[NowBuddy dry run] TAMPERED: the script replaced update').tampered, true);
  assert.match(summarizeRun(parseRunOutput('[NowBuddy dry run] TAMPERED: x')), /may have been real/);
});

// --- Unit tests ----------------------------------------------------------------------------------------------------

const SI_PROTOTYPE = `var IncidentUtils = Class.create();
IncidentUtils.prototype = {
  initialize: function (limit) { this.limit = limit || 10; },
  // not a method: strings and comments are ignored: foo: function (x) {}
  isOpen: function (state) { return state !== '7' && state !== '8'; },
  describe: function (number, includeNotes) {
    var text = 'Incident ' + number;
    if (includeNotes) { text += ' (notes)'; }
    return text;
  },
  explode: function () { throw 'boom'; },
  fromAjax: function () { return this.getParameter('sysparm_number') + '!'; },
  _hidden: function (x) { return x; },
  type: 'IncidentUtils'
};`;

test('methods, their parameters and the inputs they read are found', () => {
  const { className, methods } = extractMethods(SI_PROTOTYPE);
  assert.equal(className, 'IncidentUtils');
  assert.deepEqual(methods.map((m) => m.name), ['initialize', 'isOpen', 'describe', 'explode', 'fromAjax', '_hidden']);
  assert.deepEqual(methods.find((m) => m.name === 'describe').params, ['number', 'includeNotes']);
  assert.deepEqual(methods.find((m) => m.name === 'fromAjax').reads, ['sysparm_number']);
  assert.equal(methods.find((m) => m.name === 'type'), undefined, 'a string property is not a method');
});

test('the other ways to write a Script Include are understood too', () => {
  const extended = `var Calc = Class.create();\nCalc.prototype = Object.extendsObject(AbstractAjaxProcessor, {\n  add: function (a, b) { return a + b; },\n  type: 'Calc'\n});`;
  assert.deepEqual(extractMethods(extended).methods.map((m) => m.name), ['add']);
  const assigned = `var Util = Class.create();\nUtil.prototype.double = function (n) { return n * 2; };\nUtil.prototype.half = function (n) { return n / 2; };`;
  assert.deepEqual(extractMethods(assigned).methods.map((m) => m.name), ['double', 'half']);
  const es6 = `class Money {\n  constructor(v) { this.v = v; }\n  plus(other) { return this.v + other; }\n  static zero() { return 0; }\n}`;
  const { className, methods } = extractMethods(es6);
  assert.equal(className, 'Money');
  assert.ok(methods.some((m) => m.name === 'plus') && methods.some((m) => m.name === 'zero'));
  assert.deepEqual(extractMethods('var x = 1;').methods, []);
});

test('sample arguments follow the parameter name', () => {
  assert.equal(sampleFor('sysId'), "'00000000000000000000000000000000'");
  assert.equal(sampleFor('incident_id'), "'00000000000000000000000000000000'");
  assert.equal(sampleFor('limit'), '1');
  assert.equal(sampleFor('isActive'), 'true');
  assert.equal(sampleFor('userIds'), '[]');
  assert.equal(sampleFor('options'), '{}');
  assert.match(sampleFor('gr'), /^null/);
  assert.equal(sampleFor('somethingElse'), "'test'");
});

test('the generated unit test runs, reports each test and a summary', () => {
  const { className, methods } = extractMethods(SI_PROTOTYPE);
  const { script, methodCount } = generateUnitTest({ className, methods, source: SI_PROTOTYPE });
  assert.equal(methodCount, 4, 'initialize and the private method are left out');
  assert.equal(checkSyntax(script), null);
  assert.equal(checkSyntax(wrapAsDryRun(script)), null);
  const parsed = parseTestOutput(serverRun(script).join('\n'));
  assert.equal(parsed.complete, true);
  assert.deepEqual([parsed.summary.passed, parsed.summary.failed, parsed.summary.total], [4, 1, 5], 'the constructor test plus one per method');
  const failing = parsed.tests.find((t) => t.status === 'fail');
  assert.match(failing.name, /explode/);
  assert.match(failing.message, /threw/);
  assert.ok(parsed.tests.find((t) => /fromAjax/.test(t.name)).status === 'pass', 'getParameter is stubbed for AJAX methods');
});

test('the assertion library says what was expected and what happened', () => {
  const body = `T.test('equal', function () { T.assertEquals(2 + 2, 5, 'math'); });
T.test('deep', function () { T.assertDeepEquals({ a: [1, 2] }, { a: [1, 3] }); });
T.test('contains', function () { T.assertContains('hello', 'xyz'); });
T.test('throws', function () { T.assertThrows(function () {}, 'bad input'); });
T.test('true', function () { T.assertTrue('yes'); });
T.test('fine', function () { T.assertEquals('a', 'a'); T.assertFalse(false); T.assertNotEquals(1, 2); T.assertContains([1, 2], 2); T.assertThrows(function () { throw 1; }); T.assertDeepEquals([1], [1]); });
T.finish();`;
  const { ASSERT_LIB } = require('../src/lib/testKit.js');
  const parsed = parseTestOutput(serverRun(`${ASSERT_LIB}\n${body}`).join('\n'));
  const message = (name) => parsed.tests.find((t) => t.name === name).message;
  assert.equal(message('equal'), 'math: expected 5 but got 4');
  assert.equal(message('deep'), 'expected {"a":[1,3]} but got {"a":[1,2]}');
  assert.equal(message('contains'), '"hello" does not contain "xyz"');
  assert.equal(message('throws'), 'bad input: expected it to throw, but it did not');
  assert.equal(message('true'), 'expected true but got "yes"');
  assert.equal(parsed.tests.find((t) => t.name === 'fine').status, 'pass');
  assert.deepEqual([parsed.summary.passed, parsed.summary.failed], [1, 5]);
});

test('a test script that stops early is reported as incomplete, and noise is ignored', () => {
  const parsed = parseTestOutput('MSB_TEST {"name":"a","status":"pass","ms":3,"message":""}\nsome log\nMSB_TEST {broken\n[NowBuddy dry run] Script threw: x');
  assert.equal(parsed.complete, false);
  assert.equal(parsed.tests.length, 1);
  assert.deepEqual(parsed.summary, { passed: 1, failed: 0, total: 1, ms: 3 });
  assert.throws(() => generateUnitTest({ className: 'not a class' }), /Name the Script Include/);
});

test('saved tests are kept newest first, replaced by name, and capped', () => {
  const a = makeSavedTest({ name: 'Smoke', script: 'T.finish();', className: 'Foo', now: 1000 });
  assert.equal(makeSavedTest({ name: '', script: 'x' }), null);
  assert.equal(makeSavedTest({ name: 'x', script: '  ' }), null);
  let list = upsertSavedTest([], a);
  const b = makeSavedTest({ name: 'Smoke', script: 'T.finish(); // v2', className: 'Foo', now: 2000 });
  list = upsertSavedTest(list, b);
  assert.equal(list.length, 1, 'same name and class replaces');
  assert.match(list[0].script, /v2/);
  const many = Array.from({ length: 60 }, (_, i) => makeSavedTest({ name: `t${i}`, script: 's', now: i + 1 })).reduce((l, e) => upsertSavedTest(l, e), []);
  assert.equal(many.length, 50);
  assert.equal(many[0].name, 't59');
  const ran = recordSavedRun(list, list[0].id, { passed: 2, failed: 1, total: 3 }, 5000);
  assert.deepEqual(ran[0].lastRun, { at: 5000, passed: 2, failed: 1, total: 3 });
  assert.deepEqual(removeSavedTest(ran, list[0].id), []);
});

test('the access matrix shows allowed, denied with the blocking ACL, and unknown', () => {
  const allowed = matrixCell({ verdict: { status: 'allowed', reason: 'ok', decidedBy: [{ name: 'incident' }] } });
  const denied = matrixCell({ verdict: { status: 'denied', reason: 'no role', decidedBy: [{ name: 'incident.assigned_to' }, 'incident'] } });
  const unknown = matrixCell({ verdict: { status: 'unknown', reason: 'script ACL' } });
  assert.deepEqual([allowed.status, denied.status, unknown.status], ['allowed', 'denied', 'unknown']);
  assert.deepEqual(denied.blockedBy, ['incident.assigned_to', 'incident']);
  assert.deepEqual(allowed.blockedBy, []);
  const md = matrixToMarkdown({ table: 'incident', field: 'state', operations: ['read', 'write'], rows: [{ label: 'Abel | Tuter', cells: { read: allowed, write: denied } }] });
  assert.match(md, /Access to incident\.state/);
  assert.match(md, /\| Abel \\\| Tuter \| allowed \| DENIED \(incident\.assigned_to, incident\) \|/);
});

test('the checklist matches the record type and copies as Markdown', () => {
  assert.equal(checklistKindForTable('sys_script'), 'businessRule');
  assert.equal(checklistKindForTable('sys_security_acl'), 'acl');
  assert.equal(checklistKindForTable('incident'), 'record');
  const list = buildChecklist('businessRule');
  assert.ok(list.sections.length >= 3 && list.sections.every((s) => s.items.length));
  assert.equal(buildChecklist('nonsense').kind, 'record');
  const md = checklistToMarkdown(list, { name: 'Set priority' });
  assert.match(md, /^## Test checklist: Business rule - Set priority/);
  assert.match(md, /^- \[ \] /m);
  ['businessRule', 'clientScript', 'scriptInclude', 'uiAction', 'acl', 'flow', 'uiPolicy', 'scheduledJob', 'restApi', 'record'].forEach((k) => assert.equal(buildChecklist(k).kind, k));
});

// --- Snapshots -----------------------------------------------------------------------------------------------------

const rowAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v[0], display_value: v[1] ?? v[0] }]));

test('a record snapshot keeps value and display, and the comparison lists only what differs', () => {
  const before = snap.makeRecordSnapshot({ host: 'dev1.service-now.com', table: 'incident', sysId: ID, name: 'before', row: rowAll({ state: ['2', 'In Progress'], priority: ['3', '3 - Moderate'], short_description: ['VPN down'], sys_mod_count: ['4'], old_only: ['x'] }), now: 1 });
  const after = snap.makeRecordSnapshot({ host: 'dev1.service-now.com', table: 'incident', sysId: ID, name: 'after', row: rowAll({ state: ['6', 'Resolved'], priority: ['3', '3 - Moderate'], short_description: ['VPN down'], sys_mod_count: ['5'], new_only: ['y'] }), now: 2 });
  assert.deepEqual(before.fields.state, { v: '2', d: 'In Progress' });
  assert.deepEqual(before.fields.short_description, { v: 'VPN down' }, 'display equal to value is stored once');
  const diff = snap.diffRecordSnapshots(before, after);
  assert.deepEqual(diff.changes.map((c) => [c.field, c.before, c.after, c.system]), [['state', 'In Progress', 'Resolved', false], ['sys_mod_count', '4', '5', true]]);
  assert.deepEqual([diff.same, diff.added, diff.removed], [2, ['new_only'], ['old_only']]);
  assert.match(snap.diffToMarkdown(diff, { table: 'incident', beforeName: 'before', afterName: 'after' }), /\| state \| In Progress \| Resolved \|/);
  assert.match(snap.diffToMarkdown({ changes: [] }, { beforeName: 'a', afterName: 'now' }), /No field differs/);
  assert.throws(() => snap.makeRecordSnapshot({ host: 'h', table: 't', sysId: 'x', row: {} }), /sys_id/);
});

test('long values are clipped, so a snapshot cannot grow without bound', () => {
  const s = snap.makeRecordSnapshot({ host: 'h', table: 'incident', sysId: ID, row: { description: 'x'.repeat(5000) }, now: 1 });
  assert.ok(s.fields.description.v.length <= snap.SNAPSHOT_LIMITS.fieldChars);
});

test('a list snapshot shows which rows were added, removed or changed and in which fields', () => {
  const rows = (...specs) => specs.map(([id, number, state, extra]) => rowAll({ sys_id: [id], number: [number], state: [state], ...(extra || {}) }));
  const before = snap.makeListSnapshot({ host: 'h', table: 'incident', rows: rows([ID, 'INC1', '1'], [ID2, 'INC2', '1'], ['a'.repeat(32), 'INC3', '1']), now: 1 });
  const after = snap.makeListSnapshot({ host: 'h', table: 'incident', rows: rows([ID, 'INC1', '1'], [ID2, 'INC2', '6'], ['b'.repeat(32), 'INC4', '1']), now: 2 });
  const diff = snap.diffListSnapshots(before, after);
  assert.deepEqual(diff.added.map((r) => r.label), ['INC4']);
  assert.deepEqual(diff.removed.map((r) => r.label), ['INC3']);
  assert.deepEqual(diff.changed.map((r) => [r.label, r.fields]), [['INC2', ['state']]]);
  assert.equal(diff.same, 1);
  assert.equal(snap.rowHash({ a: '1', b: '2' }), snap.rowHash({ b: '2', a: '1' }), 'field order does not matter');
  assert.notEqual(snap.rowHash({ a: '1' }), snap.rowHash({ a: '2' }));
  const big = snap.makeListSnapshot({ host: 'h', table: 'incident', rows: Array.from({ length: 300 }, (_, i) => rowAll({ sys_id: [i.toString(16).padStart(32, '0')], number: ['N' + i] })), now: 3 });
  assert.equal(big.rows[0].values, undefined, 'above the limit only hashes are kept');
});

test('snapshots are kept per instance, newest first, capped, and found again by what is on screen', () => {
  const make = (host, n) => snap.makeRecordSnapshot({ host, table: 'incident', sysId: ID, name: `s${n}`, row: rowAll({ state: ['1'] }), now: n });
  let list = [];
  for (let i = 1; i <= 25; i += 1) list = snap.addSnapshot(list, make('dev1', i));
  list = snap.addSnapshot(list, make('dev2', 99));
  assert.equal(list.filter((s) => s.host === 'dev1').length, 20);
  assert.equal(list.filter((s) => s.host === 'dev2').length, 1, 'another instance is not trimmed');
  const mine = snap.snapshotsFor(list, { host: 'dev1', table: 'incident', sysId: ID });
  assert.equal(mine[0].at, 25);
  assert.equal(snap.snapshotsFor(list, { host: 'dev1', table: 'incident' }).length, 0, 'a list view does not offer record snapshots');
  assert.equal(snap.removeSnapshot(list, mine[0].id).length, list.length - 1);
});

// --- ATF -------------------------------------------------------------------------------------------------------------

test('ATF search terms are validated and the queries are built from them', () => {
  assert.deepEqual(atf.searchTerms({ table: 'incident', name: 'IncidentUtils', apiName: 'global.IncidentUtils' }), ['incident', 'IncidentUtils']);
  assert.deepEqual(atf.searchTerms({ table: 'a^b', name: 'x' }), [], 'a caret would add a condition; one-letter terms match everything');
  assert.equal(atf.stepQuery(['incident', 'Foo']), 'inputsLIKEincident^ORinputsLIKEFoo^ORDERBYtest');
  assert.equal(atf.testNameQuery(['incident']), 'nameLIKEincident^ORdescriptionLIKEincident');
  assert.equal(atf.inQuery('test', [ID, 'nope', ID2, ID], '^ORDERBYDESCsys_created_on'), `testIN${ID},${ID2}^ORDERBYDESCsys_created_on`);
  assert.equal(atf.inQuery('test', ['nope']), '');
  assert.deepEqual(atf.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('ATF results are put together: last run per test, suites that hold it, honest counts', () => {
  const report = atf.buildAtfReport({
    steps: [{ test: { value: ID }, description: 'Record Update on incident' }, { test: { value: ID }, description: 'Assert' }],
    tests: [{ sys_id: ID, name: 'Incident priority', active: 'true' }, { sys_id: ID2, name: 'Incident name test', active: 'true' }],
    results: [
      { test: { value: ID, display_value: 'Incident priority' }, status: { display_value: 'Failure', value: 'failure' }, start_time: '2026-10-20 09:00:00', run_time: '0:00:03', output: 'Assertion failed' },
      { test: { value: ID }, status: { display_value: 'Success', value: 'success' } },
    ],
    suiteLinks: [{ test_suite: { value: 'c'.repeat(32) }, test: { value: ID } }],
    suites: [{ sys_id: 'c'.repeat(32), name: 'Incident suite', active: 'true' }],
    suiteResults: [{ test_suite: { value: 'c'.repeat(32) }, status: { display_value: 'Success' }, success_count: '5', failure_count: '0' }],
  });
  assert.equal(report.summary.tests, 2);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.neverRun, 1);
  const first = report.tests.find((t) => t.sysId === ID);
  assert.equal(first.last.kind, 'fail', 'the NEWEST result wins (results come newest first)');
  assert.equal(first.matchedBy[0], '2 steps');
  assert.equal(first.suites[0].name, 'Incident suite');
  assert.deepEqual(first.suites[0].last, { status: 'Success', kind: 'pass', passed: 5, failed: 0 });
  assert.deepEqual(report.suites.map((s) => s.name), ['Incident suite']);
  assert.equal(report.tests.find((t) => t.sysId === ID2).last, null);
  assert.equal(atf.statusClass('Success'), 'pass');
  assert.equal(atf.statusClass('Failure'), 'fail');
  assert.equal(atf.statusClass('Skipped'), 'skip');
  assert.equal(atf.statusClass('Running'), 'running');
  assert.equal(atf.statusClass(''), 'unknown');
  assert.deepEqual(atf.buildAtfReport({}).summary, { tests: 0, passed: 0, failed: 0, neverRun: 0 });
  assert.match(atf.NO_ATF_NOTE, /Automated Test Framework/);
});
