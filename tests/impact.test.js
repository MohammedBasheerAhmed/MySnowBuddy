const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../src/lib/impact.js');

const tableOf = (analysis, table, isCurrent = false) => analysis.tables.find((t) => t.table === table && t.isCurrent === isCurrent);

test('comments are blanked without moving lines, strings are kept', () => {
  const src = "var a = 'http://x'; // gr.deleteMultiple()\n/* gr.update()\n */ var b = 1;";
  const out = I.stripComments(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, 3);
  assert.ok(out.includes("'http://x'"));
  assert.ok(!out.includes('deleteMultiple'));
  assert.ok(!out.includes('gr.update'));
});

test('GlideRecord writes, fields and lines are found per table', () => {
  const src = [
    "var gr = new GlideRecord('incident');",
    "gr.addQuery('active', true);",
    'gr.query();',
    'while (gr.next()) {',
    "  gr.state = 7;",
    "  gr.setValue('close_code', 'Solved');",
    "  gr.work_notes.setJournalEntry('closed');",
    '  if (gr.priority == 1) {}',
    '  gr.update();',
    '}',
    "var t = new GlideRecord('task');",
    't.setWorkflow(false);',
    't.deleteMultiple();',
  ].join('\n');
  const a = I.analyzeScript(src);
  const inc = tableOf(a, 'incident');
  assert.deepEqual(inc.ops, ['read', 'update']);
  assert.deepEqual(inc.fields, ['close_code', 'state', 'work_notes']);
  assert.ok(inc.where.some((w) => w.line === 9));
  assert.ok(!inc.fields.includes('priority'), '== is a comparison, not a write');
  const task = tableOf(a, 'task');
  assert.deepEqual(task.ops, ['delete']);
  assert.equal(task.workflowOff, true);
  assert.ok(I.isWrite(inc) && I.isWrite(task));
});

test('a reassigned variable follows the table it holds at that point', () => {
  const src = "var gr = new GlideRecord('incident');\ngr.query();\ngr = new GlideRecord('problem');\ngr.insert();";
  const a = I.analyzeScript(src);
  assert.deepEqual(tableOf(a, 'incident').ops, ['read']);
  assert.deepEqual(tableOf(a, 'problem').ops, ['insert']);
});

test('current is traced only with an own table; current.update() is flagged', () => {
  const src = "current.state = 3;\ncurrent.setValue('priority', 1);\ncurrent.update();";
  const without = I.analyzeScript(src);
  assert.equal(without.tables.length, 0);
  const a = I.analyzeScript(src, { ownTable: 'incident' });
  const cur = tableOf(a, 'incident', true);
  assert.deepEqual(cur.fields, ['priority', 'state']);
  assert.deepEqual(cur.ops, ['update']);
  assert.equal(a.currentUpdate.length, 1);
  assert.equal(a.currentUpdate[0].line, 3);

  const before = I.analyzeScript('current.state = 3;', { ownTable: 'incident' });
  const entry = tableOf(before, 'incident', true);
  assert.deepEqual(entry.ops, []);
  assert.ok(I.isWrite(entry), 'fields set on current are saved by the operation itself');
  assert.match(I.describeChange(entry), /sets fields on the record being saved/);
});

test('dynamic tables and events are reported, literal events are named', () => {
  const src = "var gr = new GlideRecord(tableName);\ngr.update();\ngs.eventQueue('incident.closed', current);\ngs.eventQueue(evt, current);";
  const a = I.analyzeScript(src);
  assert.equal(a.tables.length, 0);
  assert.equal(a.dynamicTables.length, 1);
  assert.deepEqual(a.events.map((e) => e.name), ['incident.closed']);
  assert.equal(a.dynamicEvents.length, 1);
});

test('GlideQuery chains report their operation, fields and disableWorkflow', () => {
  const src = "new GlideQuery('incident')\n  .where('active', true)\n  .disableWorkflow()\n  .updateMultiple({ state: 7, close_code: 'x' });";
  const a = I.analyzeScript(src);
  const inc = tableOf(a, 'incident');
  assert.deepEqual(inc.ops, ['update']);
  assert.deepEqual(inc.fields, ['close_code', 'state']);
  assert.equal(inc.workflowOff, true);
});

test('analyzeScripts merges fields of one record and keeps the field name in each location', () => {
  const a = I.analyzeScripts(
    [
      { field: 'script', text: "var gr = new GlideRecord('incident'); gr.update();" },
      { field: 'condition', text: "var g = new GlideRecord('incident'); g.query();" },
    ],
    {}
  );
  assert.equal(a.tables.length, 1);
  assert.deepEqual(a.tables[0].ops, ['read', 'update']);
  assert.match(I.describeWhere(a.tables[0].where), /script line 1; condition line 1/);
});

test('Script Include calls: chained, variable, static, scoped and GlideAjax', () => {
  const src = [
    'new IncidentUtils().closeChildren(current);',
    'var u = new TaskHelper();',
    'u.reassign(current);',
    'u.notify();',
    'ApprovalUtil.check(current);',
    'new x_acme_app.Billing().charge();',
    "var gdt = new GlideDateTime(); JSON.stringify({}); Math.max(1, 2);",
    "var ga = new GlideAjax('x_acme_app.ClientUtil');",
    "ga.addParam('sysparm_name', 'getStatus');",
  ].join('\n');
  const calls = I.scriptIncludeCalls(src);
  const byName = Object.fromEntries(calls.map((c) => [c.name, c]));
  assert.deepEqual(byName.IncidentUtils.methods, ['closeChildren']);
  assert.deepEqual(byName.TaskHelper.methods, ['notify', 'reassign']);
  assert.deepEqual(byName.ApprovalUtil.methods, ['check']);
  assert.deepEqual(byName.Billing.methods, ['charge']);
  assert.deepEqual(byName.ClientUtil.methods, ['getStatus']);
  assert.equal(byName.ClientUtil.via, 'GlideAjax');
  assert.equal(byName.GlideDateTime, undefined);
  assert.equal(byName.JSON, undefined);
  assert.equal(byName.Math, undefined);
});

test('method bodies are found in the usual Script Include shapes, with their line offset', () => {
  const si = [
    'var IncidentUtils = Class.create();',
    'IncidentUtils.prototype = {',
    '  initialize: function () {},',
    '  // closeChildren: function () { fake }',
    '  closeChildren: function (parent) {',
    "    var gr = new GlideRecord('incident');",
    "    gr.addQuery('parent_incident', parent.sys_id);",
    "    gr.setValue('state', 7);",
    '    gr.updateMultiple();',
    "    if (x) { var s = '}'; }",
    '  },',
    "  other: function () { new GlideRecord('problem').deleteMultiple(); },",
    "  type: 'IncidentUtils'",
    '};',
  ].join('\n');
  const body = I.extractMethodBody(si, 'closeChildren');
  assert.ok(body, 'found past the commented-out decoy');
  assert.equal(body.lineOffset, 4);
  assert.ok(!body.text.includes('problem'));
  const a = I.analyzeScript(body.text, { lineOffset: body.lineOffset });
  const inc = tableOf(a, 'incident');
  assert.deepEqual(inc.ops, ['update']);
  assert.deepEqual(inc.fields, ['state']);
  assert.ok(inc.where.every((w) => w.line >= 6 && w.line <= 9));

  assert.ok(I.extractMethodBody('Foo.prototype.run = function () { return 1; };', 'run'));
  assert.ok(I.extractMethodBody('class A { run(x) { return x; } }', 'run'));
  assert.equal(I.extractMethodBody(si, 'missing'), null);
  assert.equal(I.extractMethodBody(si, 'bad name'), null);
});

test('trigger text describes when each kind of script runs', () => {
  assert.equal(
    I.describeTrigger('sys_script', { when: 'after', action_insert: 'true', action_update: 'true', collection: 'incident', order: '100' }),
    'Business rule: runs after insert/update on incident, order 100'
  );
  assert.match(I.describeTrigger('sys_script_include', { client_callable: 'true' }), /client callable/);
  assert.match(I.describeTrigger('sys_script_client', { type: 'onChange', field: 'state', table: 'incident' }), /onChange of state on incident/);
  assert.match(I.describeTrigger('sysevent_script_action', { event_name: 'incident.closed' }), /incident\.closed/);
  assert.equal(I.describeTrigger('unknown_table', {}), '');
});

function sampleReport(overrides = {}) {
  return {
    origin: 'https://dev.example.com',
    subject: { table: 'sys_script_include', kind: 'Script Include', name: 'IncidentUtils', trigger: 'Script Include', active: true, link: '/sys_script_include.do?sys_id=1' },
    usedBy: {
      applicable: true,
      label: 'Who calls it',
      verb: 'Called by',
      capped: false,
      items: Array.from({ length: 4 }, (_, i) => ({ label: 'Business Rule', name: `BR ${i}`, lines: [{ field: 'script', lineNumber: 3, text: 'x' }], link: `/sys_script.do?sys_id=${i}` })),
    },
    changes: I.analyzeScripts([{ field: 'script', text: "var gr = new GlideRecord('incident'); gr.setWorkflow(false); gr.update();" }]),
    indirect: [{ name: 'TaskHelper', method: 'purge', found: true, tables: I.analyzeScript("var t = new GlideRecord('task'); t.deleteMultiple();").tables, events: [] }],
    downstream: { tables: ['incident', 'task'], capped: false, items: [{ kind: 'Business rule', name: 'Set priority', detail: 'before update on incident', link: '/sys_script.do?sys_id=9', maySkip: true }] },
    updateSets: { items: [{ setName: 'Alice fixes', state: 'in progress', updatedBy: 'alice', updatedOn: '2026-10-15', mine: false }, { setName: 'Mine', state: 'in progress', updatedBy: 'me', mine: true }] },
    errors: { count: 2, capped: false, samples: [{ createdOn: '2026-10-15 10:00:00', level: 'error', message: 'TypeError in IncidentUtils' }] },
    history: { count: 5, latest: [{ by: 'admin', recordedAt: '2026-10-14' }] },
    volume: null,
    notes: ['Flows were not checked.'],
    ...overrides,
  };
}

test('signals rank deletes, collisions and setWorkflow(false) above the rest', () => {
  const report = sampleReport();
  const signals = I.buildSignals(report);
  assert.equal(I.overallLevel(signals), 'high');
  assert.equal(signals[0].severity, 'high');
  const texts = signals.map((s) => s.text).join('\n');
  assert.match(texts, /Called by 4 scripts/);
  assert.match(texts, /Deletes records on task \(through TaskHelper\.purge\)/);
  assert.match(texts, /setWorkflow\(false\)/);
  assert.match(texts, /Alice fixes/);
  assert.doesNotMatch(texts, /"Mine"/, 'your own update set is not a collision');
  assert.match(texts, /2 warnings and errors/);
  for (let i = 1; i < signals.length; i += 1) {
    assert.ok(I.SEVERITY_ORDER.indexOf(signals[i - 1].severity) <= I.SEVERITY_ORDER.indexOf(signals[i].severity));
  }
});

test('a quiet script gets a low level and a plain headline', () => {
  const report = {
    subject: { table: 'sys_script', kind: 'Business rule', name: 'x', active: true, ownTable: 'incident' },
    usedBy: null,
    changes: I.analyzeScripts([{ field: 'script', text: "gs.info('hi');" }], { ownTable: 'incident' }),
    indirect: [],
    downstream: { tables: [], items: [], capped: false },
    updateSets: { items: [] },
    errors: { count: 0, capped: false, samples: [] },
    history: null,
    volume: { count: 12, label: 'records on incident changed in the last 24 hours' },
  };
  assert.deepEqual(I.buildSignals(report), []);
  assert.equal(I.overallLevel([]), 'low');
  assert.equal(I.headline(report), 'Changes no tables · 0 things run as a result · 0 log errors this week');
});

test('current.update() in a business rule is a high signal', () => {
  const report = {
    subject: { table: 'sys_script', kind: 'Business rule', name: 'x', active: true, ownTable: 'incident' },
    changes: I.analyzeScripts([{ field: 'script', text: 'current.state = 2;\ncurrent.update();' }], { ownTable: 'incident' }),
  };
  const signals = I.buildSignals(report);
  assert.ok(signals.some((s) => s.severity === 'high' && /current\.update\(\)/.test(s.text)));
});

test('markdown and the AI prompt carry every section with absolute links', () => {
  const md = I.impactToMarkdown(sampleReport());
  assert.match(md, /^# Change impact: Script Include "IncidentUtils"/);
  assert.match(md, /\*\*Risk: HIGH\*\*/);
  assert.match(md, /## Who calls it \(4\)/);
  assert.match(md, /BR 0 \(script line 3\) https:\/\/dev\.example\.com\/sys_script\.do\?sys_id=0/);
  assert.match(md, /incident: update · setWorkflow\(false\)/);
  assert.match(md, /TaskHelper\.purge\(\): task: delete/);
  assert.match(md, /may be skipped: setWorkflow\(false\)/);
  assert.match(md, /Alice fixes \(in progress\)/);
  assert.match(md, /## Not checked\n- Flows were not checked\./);
  const prompt = I.buildImpactPrompt(sampleReport());
  assert.match(prompt, /What to retest/);
  assert.ok(prompt.includes(md));
});

// ---- Instance side (Table API stubbed) ---------------------------------------------------------

const { buildImpactReport } = require('../src/content/impact.js');

const BR = '0123456789abcdef0123456789abcdef';
const SI = 'fedcba9876543210fedcba9876543210';
const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function stubPage() {
  global.window = { location: { origin: 'https://dev1.service-now.com' } };
  global.document = {
    documentElement: {
      hasAttribute() {
        throw new Error('no bridge in tests');
      },
    },
    getElementById: () => null,
    querySelector: (sel) => (sel === 'input[name="sysparm_ck"]' ? { value: 'test-token' } : null),
    scripts: [],
  };
}

const okJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Routes Table API and Aggregate API calls by table; unknown tables answer with no rows. */
function routeInstance(routes, counts = {}) {
  const calls = [];
  global.fetch = async (url) => {
    const u = new URL(url, 'https://dev1.service-now.com');
    const parts = u.pathname.split('/');
    const table = parts.pop();
    const call = { api: parts.pop(), table, query: u.searchParams.get('sysparm_query') || '', fields: u.searchParams.get('sysparm_fields') || '' };
    calls.push(call);
    if (call.api === 'stats') return okJson({ result: { stats: { count: String(counts[table] ?? 0) } } });
    const route = routes[table];
    if (typeof route === 'number') return okJson({ error: { message: 'Invalid table' } }, route);
    return okJson({ result: route ? route(call) : [] });
  };
  return calls;
}

const BR_SCRIPT = [
  "var gr = new GlideRecord('problem');",
  "gr.addQuery('sys_id', current.problem_id);",
  'gr.query();',
  'if (gr.next()) { gr.state = 3; gr.update(); }',
  "gs.eventQueue('incident.reopened', current);",
  'new IncidentUtils().closeChildren(current);',
].join('\n');

const SI_SCRIPT = [
  'var IncidentUtils = Class.create();',
  'IncidentUtils.prototype = {',
  '  closeChildren: function (parent) {',
  "    var t = new GlideRecord('incident_task');",
  '    t.setWorkflow(false);',
  '    t.deleteMultiple();',
  '  },',
  "  type: 'IncidentUtils'",
  '};',
].join('\n');

const brRow = (sysId, name, collection, when, order, ops) => ({
  sys_id: sysId,
  name,
  collection,
  when,
  order: String(order),
  active: 'true',
  action_insert: String(ops.includes('insert')),
  action_update: String(ops.includes('update')),
  action_delete: String(ops.includes('delete')),
  action_query: 'false',
});

function instanceRoutes() {
  return {
    sys_script: ({ query }) => {
      if (query === `sys_id=${BR}`) return [{ ...brRow(BR, 'Reopen problem', 'incident', 'after', 100, ['update']), script: BR_SCRIPT, condition: '' }];
      if (query.includes('^when=after')) {
        return [
          brRow('1'.repeat(32), 'Task audit', 'task', 'after', 50, ['update']),
          brRow(BR, 'Reopen problem', 'incident', 'after', 100, ['update']),
          brRow('2'.repeat(32), 'Insert only', 'incident', 'after', 200, ['insert']),
          brRow('3'.repeat(32), 'Before rule', 'incident', 'before', 10, ['update']),
          brRow('4'.repeat(32), 'Other table', 'change_request', 'after', 10, ['update']),
        ];
      }
      return [
        brRow('5'.repeat(32), 'Problem update rule', 'problem', 'before', 100, ['update']),
        brRow('6'.repeat(32), 'Problem insert rule', 'problem', 'before', 100, ['insert']),
        brRow('7'.repeat(32), 'Task delete cleanup', 'incident_task', 'after', 100, ['delete']),
        brRow('8'.repeat(32), 'Dropped condition row', 'change_request', 'before', 100, ['update', 'delete']),
      ];
    },
    sys_db_object: ({ query }) => (['name=incident', 'name=problem', 'name=incident_task'].includes(query) ? [{ 'super_class.name': 'task' }] : []),
    sys_script_include: ({ query }) =>
      query.startsWith('name') ? [{ sys_id: SI, name: 'IncidentUtils', api_name: 'global.IncidentUtils', active: 'true', client_callable: 'false', script: SI_SCRIPT }] : [],
    sysevent_email_action: ({ query }) =>
      query.startsWith('collectionIN')
        ? [
            { sys_id: '9'.repeat(32), name: 'Problem updated', collection: 'problem', action_insert: 'false', action_update: 'true', generation_type: 'engine', active: 'true' },
            { sys_id: 'b'.repeat(32), name: 'Problem by flow', collection: 'problem', action_insert: 'false', action_update: 'true', generation_type: 'triggered', active: 'true' },
          ]
        : [{ sys_id: 'c'.repeat(32), name: 'Reopened mail', event_name: 'incident.reopened', generation_type: 'event', active: 'true' }],
    sys_flow_record_trigger: 400,
    sysevent_script_action: () => [
      { sys_id: 'd'.repeat(32), name: 'On reopen', event_name: 'incident.reopened', active: 'true' },
      { sys_id: 'e'.repeat(32), name: 'Unrelated', event_name: 'other.event', active: 'true' },
    ],
    sys_update_xml: () => [
      { sys_id: '1', name: `sys_script_${BR}`, update_set: OTHER, 'update_set.name': 'Alice fixes', 'update_set.state': 'in progress', sys_updated_by: 'alice', sys_updated_on: '2026-10-15 09:00:00' },
      { sys_id: '2', name: `sys_script_${BR}`, update_set: SI, 'update_set.name': 'My sprint', 'update_set.state': 'in progress', sys_updated_by: 'me', sys_updated_on: '2026-10-16 09:00:00' },
      { sys_id: '3', name: 'sys_script_other', update_set: 'f'.repeat(32), 'update_set.name': 'Unrelated', 'update_set.state': 'in progress', sys_updated_by: 'bob' },
    ],
    sys_user: () => [{ sys_id: SI, user_name: 'me', name: 'Me' }],
    sys_update_version: () => [{ sys_id: '1', name: `sys_script_${BR}`, sys_recorded_at: '2026-10-16 09:00:00', sys_created_by: 'me' }],
    syslog: () => [
      { sys_id: '1'.repeat(32), sys_created_on: '2026-10-15 10:00:00', level: '2', message: `Evaluator: TypeError in sys_script.${BR}.script line 4` },
      { sys_id: '2'.repeat(32), sys_created_on: '2026-10-15 10:00:00', level: '2', message: 'Unrelated row returned for a dropped condition' },
    ],
  };
}

test('impact report for a business rule: changes, indirect writes, downstream, alongside, update sets, log, volume', async () => {
  stubPage();
  const calls = routeInstance(instanceRoutes(), { incident: 1500, sys_update_version: 4 });
  const r = await buildImpactReport({ table: 'sys_script', sysId: BR });

  assert.equal(r.subject.kind, 'Business rule');
  assert.match(r.subject.trigger, /after update on incident, order 100/);
  assert.equal(r.subject.ownTable, 'incident');
  assert.equal(r.usedBy, null);

  const problem = r.changes.tables.find((t) => t.table === 'problem');
  assert.deepEqual(problem.ops, ['read', 'update']);
  assert.deepEqual(problem.fields, ['state']);
  assert.deepEqual(r.changes.events.map((e) => e.name), ['incident.reopened']);

  const via = r.indirect.find((c) => c.name === 'IncidentUtils');
  assert.equal(via.method, 'closeChildren');
  assert.equal(via.found, true);
  assert.deepEqual(via.tables.map((t) => [t.table, t.ops.join(), t.workflowOff]), [['incident_task', 'delete', true]]);

  const names = r.downstream.items.map((d) => d.name);
  assert.ok(names.includes('Problem update rule'));
  assert.ok(names.includes('Task delete cleanup'));
  assert.ok(!names.includes('Problem insert rule'), 'an insert-only rule does not run on an update');
  assert.ok(!names.includes('Dropped condition row'), 'rows from other tables are filtered out');
  assert.ok(names.includes('Problem updated'));
  assert.ok(!names.includes('Problem by flow'), 'only engine notifications fire on a record change');
  assert.ok(names.includes('Reopened mail'));
  assert.ok(names.includes('On reopen'));
  assert.ok(!names.includes('Unrelated'));
  assert.equal(r.downstream.items.find((d) => d.name === 'Task delete cleanup').maySkip, true);
  assert.equal(r.downstream.items.find((d) => d.name === 'Problem update rule').maySkip, false);
  assert.ok(r.notes.some((n) => /Flows were not checked/.test(n)));

  assert.deepEqual(r.alongside.items.map((x) => [x.name, x.isSelf]), [['Task audit', false], ['Reopen problem', true]]);

  assert.deepEqual(r.updateSets.items.map((u) => [u.setName, u.mine]), [['Alice fixes', false], ['My sprint', true]]);
  assert.equal(r.history.count, 4);
  assert.equal(r.errors.count, 1);
  assert.equal(r.volume.count, 1500);

  const signals = I.buildSignals(r);
  assert.equal(I.overallLevel(signals), 'high');
  assert.ok(signals.some((s) => /Deletes records on incident_task \(through IncidentUtils\.closeChildren\)/.test(s.text)));
  assert.ok(signals.some((s) => /Alice fixes/.test(s.text)));
  assert.ok(signals.some((s) => /Runs often: 1,500/.test(s.text)));

  // Queries stay narrow: the log search uses the sys_id only, and the volume count is for the last day.
  const log = calls.find((c) => c.table === 'syslog');
  assert.match(log.query, new RegExp(`levelIN1,2\\^messageLIKE${BR}\\^ORDERBY`));
  const volume = calls.find((c) => c.api === 'stats' && c.table === 'incident');
  assert.match(volume.query, /sys_updated_on>=javascript:gs\.hoursAgoStart\(24\)/);
  assert.ok(!calls.some((c) => c.table === 'sys_ws_operation'), 'no code search for a business rule');
});

test('impact report for a Script Include by name finds its callers, GlideAjax ones included', async () => {
  stubPage();
  const routes = instanceRoutes();
  routes.sys_script = () => [{ sys_id: BR, name: 'Reopen problem', collection: 'incident', when: 'after', active: 'true', script: BR_SCRIPT, condition: '' }];
  routes.sys_script_client = () => [{ sys_id: OTHER, name: 'Close button', table: 'incident', active: 'true', script: "var ga = new GlideAjax('IncidentUtils');\nga.getXMLAnswer(cb);" }];
  routes.sys_script_include = () => [{ sys_id: SI, name: 'IncidentUtils', api_name: 'global.IncidentUtils', active: 'true', client_callable: 'true', script: SI_SCRIPT }];
  routeInstance(routes);

  const r = await buildImpactReport({ name: 'IncidentUtils' });
  assert.equal(r.subject.table, 'sys_script_include');
  assert.match(r.subject.trigger, /client callable/);
  assert.equal(r.usedBy.verb, 'Called by');
  const callers = Object.fromEntries(r.usedBy.items.map((u) => [u.name, u.viaAjax]));
  assert.deepEqual(callers, { 'Reopen problem': false, 'Close button': true });
  assert.ok(!r.usedBy.items.some((u) => u.sysId === SI), 'the Script Include itself is not its own caller');
  assert.equal(r.indirect.length, 0, 'it does not follow calls to itself');
});

test('impact report: unsaved form text is analysed, and bad input is refused before any query', async () => {
  stubPage();
  routeInstance(instanceRoutes());
  const r = await buildImpactReport({
    table: 'sys_script',
    sysId: BR,
    context: { table: 'sys_script', sysId: BR, scriptBody: "var x = new GlideRecord('change_request'); x.insert();", scriptFieldLabel: 'sys_script.script' },
  });
  assert.equal(r.subject.usesUnsaved, true);
  assert.deepEqual(r.changes.tables.map((t) => t.table), ['change_request']);

  const calls = routeInstance(instanceRoutes());
  await assert.rejects(buildImpactReport({ name: 'Bad^name' }), /not a Script Include name/);
  await assert.rejects(buildImpactReport({ table: 'incident', sysId: BR }), /Open a script record/);
  await assert.rejects(buildImpactReport({ table: 'sys_script', sysId: 'javascript:1' }), /Save the record first/);
  assert.equal(calls.length, 0);
});
