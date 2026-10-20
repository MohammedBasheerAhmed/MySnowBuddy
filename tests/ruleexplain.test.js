const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateCondition,
  evaluateQuery,
  looseEquals,
  compareValues,
  shownValue,
  normalizeRule,
  parseAclName,
  explainRule,
  explainAll,
  outcomeWord,
  dottedFields,
  defaultOperation,
  explanationToMarkdown,
  summarize,
} = require('../src/lib/ruleExplain.js');

const incident = {
  table: 'incident',
  chain: ['incident', 'task'],
  isNew: false,
  current: { priority: '3', state: '2', short_description: 'VPN drops every 10 minutes', assignment_group: 'a'.repeat(32), caller_id: 'b'.repeat(32), active: 'true', impact: '2', opened_at: '2026-10-20 10:15:00', watch_list: 'u1,u2', description: '' },
  previous: { priority: '3', state: '2', short_description: 'VPN drops every 10 minutes', assignment_group: 'a'.repeat(32), caller_id: 'b'.repeat(32), active: 'true', impact: '2', opened_at: '2026-10-20 10:15:00', watch_list: 'u1,u2', description: '' },
  display: { assignment_group: 'Service Desk', caller_id: 'Abel Tuter' },
  roles: ['itil', 'snc_internal'],
};
const withCurrent = (changes) => ({ ...incident, current: { ...incident.current, ...changes } });
const result = (query, ctx = incident) => evaluateQuery(query, ctx);

test('equality is numeric, boolean-aware and ignores case', () => {
  assert.equal(looseEquals('1', '1.0'), true);
  assert.equal(looseEquals('true', '1'), true);
  assert.equal(looseEquals('false', '0'), true);
  assert.equal(looseEquals('true', '0'), false);
  assert.equal(looseEquals('Service Desk', 'service desk'), true);
  assert.equal(looseEquals('', ''), true);
  assert.equal(looseEquals('1', 'one'), false);
  assert.ok(compareValues('10', '9') > 0, 'numbers compare as numbers, not text');
  assert.ok(compareValues('2026-10-20 10:00:00', '2026-10-20') > 0, 'dates compare as text');
  assert.equal(shownValue('', ''), '(empty)');
  assert.equal(shownValue('x'.repeat(32), 'Abel Tuter'), 'Abel Tuter', 'a reference shows its display value');
});

test('a plain query is true or false with the failing condition in words', () => {
  assert.equal(result('priority=3').result, 'true');
  const wrong = result('priority=1');
  assert.equal(wrong.result, 'false');
  assert.equal(wrong.failure, 'priority is 3, wanted 1');
  assert.equal(result('').result, 'true', 'an empty filter matches everything');
  assert.equal(result('').empty, true);
  assert.equal(result('priority=3^EQ').result, 'true', 'the EQ terminator is not a condition');
});

test('every operator, passing and failing', () => {
  const cases = [
    ['priority!=1', true], ['priority!=3', false],
    ['priority>2', true], ['priority>3', false], ['priority>=3', true], ['priority<4', true], ['priority<3', false], ['priority<=3', true],
    ['short_descriptionLIKEvpn', true], ['short_descriptionLIKEprinter', false],
    ['short_descriptionNOT LIKEprinter', true], ['short_descriptionNOT LIKEVPN', false],
    ['short_descriptionSTARTSWITHvpn', true], ['short_descriptionSTARTSWITHdrops', false],
    ['short_descriptionENDSWITHminutes', true], ['short_descriptionENDSWITHvpn', false],
    ['stateIN1,2,3', true], ['stateIN4,5', false], ['stateNOT IN4,5', true], ['stateNOT IN2', false],
    ['descriptionISEMPTY', true], ['short_descriptionISEMPTY', false], ['short_descriptionISNOTEMPTY', true], ['descriptionISNOTEMPTY', false],
    ['priorityBETWEEN2@4', true], ['priorityBETWEEN4@9', false],
    ['impactSAMEAS' + 'priority', false], ['impactNSAMEASpriority', true], ['priorityGT_FIELDimpact', true], ['priorityLT_FIELDimpact', false],
    ['priorityANYTHING', true], ['activeEMPTYSTRING', false],
  ];
  cases.forEach(([query, expected]) => assert.equal(result(query).result, expected ? 'true' : 'false', query));
  assert.equal(result('priorityGT_OR_EQUALS_FIELDpriority').result, 'true');
  assert.equal(result('priorityLT_OR_EQUALS_FIELDimpact').result, 'false');
});

test('failing reasons say what was wanted', () => {
  const reason = (query) => result(query).failure;
  assert.equal(reason('priority!=3'), 'priority is 3, must not be 3');
  assert.equal(reason('priority>3'), 'priority is 3, must be greater than 3');
  assert.equal(reason('priority<=2'), 'priority is 3, must be 2 or less');
  assert.equal(reason('short_descriptionLIKEprinter'), 'short_description is VPN drops every 10 minutes, must contain "printer"');
  assert.equal(reason('stateIN4,5'), 'state is 2, must be one of 4, 5');
  assert.equal(reason('descriptionISNOTEMPTY'), 'description is (empty), must not be empty');
  assert.equal(reason('priorityBETWEEN4@9'), 'priority is 3, must be between 4 and 9');
});

test('AND, OR and NQ groups: an OR joins the condition before it', () => {
  assert.equal(result('priority=3^state=2').result, 'true');
  assert.equal(result('priority=3^state=9').result, 'false');
  assert.equal(result('priority=1^ORstate=2').result, 'true', 'one of an OR pair is enough');
  assert.equal(result('priority=1^ORstate=9').result, 'false');
  assert.equal(result('active=true^priority=1^ORstate=2').result, 'true', 'a AND (b OR c)');
  assert.equal(result('active=false^priority=3^ORstate=2').result, 'false', 'the OR does not rescue a failing AND');
  assert.equal(result('priority=1^NQstate=2').result, 'true', 'NQ starts a second group; either group may match');
  assert.equal(result('priority=1^NQstate=9').result, 'false');
  assert.match(result('priority=1^ORstate=9').failure, /priority is 3, wanted 1 and state is 2, wanted 9 \(either would have been enough\)/);
  assert.match(result('priority=1^NQstate=9').failure, /^group 1: priority is 3, wanted 1 \| group 2: state is 2, wanted 9$/);
});

test('strings ignore case and a reference matches by value or by display', () => {
  assert.equal(result('short_description=vpn DROPS every 10 minutes').result, 'true');
  assert.equal(result(`assignment_group=${'a'.repeat(32)}`).result, 'true', 'the stored sys_id');
  assert.equal(result('assignment_groupLIKEservice').result, 'true', 'LIKE reads the display value');
  assert.equal(result('assignment_groupSTARTSWITHService').result, 'true');
  assert.equal(result('assignment_group=Service Desk').result, 'true');
  assert.equal(result(`assignment_group!=${'a'.repeat(32)}`).result, 'false');
  assert.equal(result('caller_idLIKEabel').result, 'true');
  assert.match(result('assignment_group=zzz').failure, /^assignment_group is Service Desk, wanted zzz$/, 'the sentence uses the display value');
});

test('a list value matches when any of its items does', () => {
  assert.equal(result('watch_listINu2').result, 'true');
  assert.equal(result('watch_listINu9').result, 'false');
});

test('empty values: comparing an empty field fails, != and NOT LIKE pass', () => {
  assert.equal(result('description>1').result, 'false');
  assert.equal(result('description!=x').result, 'true');
  assert.equal(result('descriptionNOT LIKEx').result, 'true');
  assert.equal(result('description=').result, 'true', 'field= matches an empty field');
  assert.equal(result('descriptionLIKE').result, 'true', 'an empty needle matches');
});

test('the form value wins over the saved one, and the sentence follows the form', () => {
  const edited = withCurrent({ priority: '1' });
  assert.equal(evaluateQuery('priority=1', edited).result, 'true');
  assert.equal(evaluateQuery('priority=3', edited).result, 'false');
  const display = evaluateQuery('assignment_group=zzz', withCurrent({ assignment_group: 'c'.repeat(32) }));
  assert.match(display.failure, /^assignment_group is c{32}, wanted zzz$/, 'the saved display value is not used for a changed field');
});

test('changes: VALCHANGES, CHANGESFROM and CHANGESTO compare the form with the saved record', () => {
  const edited = withCurrent({ priority: '1' });
  assert.equal(evaluateQuery('priorityVALCHANGES', edited).result, 'true');
  assert.equal(evaluateQuery('priorityVALCHANGES', incident).result, 'false');
  assert.equal(evaluateQuery('priorityVALCHANGES', incident).failure, 'priority has not changed (it is 3), must have changed');
  assert.equal(evaluateQuery('priorityCHANGESFROM3', edited).result, 'true');
  assert.equal(evaluateQuery('priorityCHANGESFROM2', edited).result, 'false');
  assert.equal(evaluateQuery('priorityCHANGESTO1', edited).result, 'true');
  assert.equal(evaluateQuery('priorityCHANGESTO1', incident).result, 'false', 'it must also have changed');
  assert.match(evaluateQuery('priorityVALCHANGES', edited).passed[0], /priority changed from 3 to 1/);
  // A new record has no saved values: everything counts as changed from empty.
  const fresh = { ...edited, isNew: true, previous: null };
  assert.equal(evaluateQuery('priorityVALCHANGES', fresh).result, 'true');
  assert.equal(evaluateQuery('priorityCHANGESFROM3', fresh).result, 'false');
  // An existing record whose saved values could not be read cannot answer.
  const unreadable = { ...edited, previous: null };
  assert.equal(evaluateQuery('priorityVALCHANGES', unreadable).result, 'unknown');
});

test('what cannot be worked out here is "unknown", never a guess', () => {
  assert.equal(result('opened_at>=javascript:gs.daysAgoStart(7)').result, 'unknown');
  assert.match(result('opened_at>=javascript:gs.daysAgoStart(7)').unknownReasons[0], /compared with a script/);
  assert.equal(result('assigned_toDYNAMIC90d1921e5f510100a9ad2572f2b477fe').result, 'unknown');
  assert.equal(result('opened_atRELATIVEGE@dayofweek@ago@1').result, 'unknown');
  assert.equal(result('opened_atONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()').result, 'unknown');
  assert.equal(result('caller_id.department=IT').result, 'unknown', 'a dot-walked value that is not supplied');
  assert.equal(result('not_on_form=1').result, 'unknown');
  assert.match(result('not_on_form=1').unknownReasons[0], /not_on_form is not on the form/);
  // A false condition elsewhere still decides it.
  assert.equal(result('priority=1^opened_at>=javascript:gs.daysAgoStart(7)').result, 'false');
  assert.equal(result('priority=3^opened_at>=javascript:gs.daysAgoStart(7)').result, 'unknown');
  assert.equal(result('priority=3^ORopened_at>=javascript:gs.daysAgoStart(7)').result, 'true', 'a true OR branch decides it');
  assert.equal(result('RLQUERYtask.parent,>0').result, 'unknown', 'syntax that is not understood is not ignored silently');
  assert.ok(result('RLQUERYtask.parent,>0').notes.length >= 1);
});

test('dot-walked values are used when they are supplied', () => {
  const ctx = { ...incident, current: { ...incident.current, 'caller_id.department': 'IT' } };
  assert.equal(evaluateQuery('caller_id.department=IT', ctx).result, 'true');
  assert.equal(evaluateQuery('caller_id.department=HR', ctx).result, 'false');
});

test('instanceof uses the table hierarchy', () => {
  assert.equal(evaluateQuery('sys_class_nameINSTANCEOFtask', incident).result, 'true');
  assert.equal(evaluateQuery('sys_class_nameINSTANCEOFchange_request', incident).result, 'false');
});

// ---------------------------------------------------------------------------------------------------------

const br = (over = {}) =>
  normalizeRule('br', {
    sys_id: 'r1', name: 'Escalate P1', collection: 'incident', when: 'before', order: '100', active: 'true',
    action_insert: 'true', action_update: 'true', action_delete: 'false', action_query: 'false', filter_condition: '', advanced: 'true', condition: '', ...over,
  });

test('business rule: runs when active, on the table, on this operation and the filter matches', () => {
  const r = explainRule(br({ filter_condition: 'priority=3^EQ' }), incident);
  assert.equal(r.outcome, 'run');
  assert.match(r.headline, /^Would run: .*priority is 3/);
  assert.equal(r.link.table, 'sys_script');
});

test('business rule: each reason it will not run', () => {
  const why = (row, ctx = incident) => explainRule(br(row), ctx);
  assert.equal(why({ active: 'false' }).headline, "Won't run: it is inactive");
  assert.equal(why({ collection: 'problem' }).headline, "Won't run: it is on problem, but this record is on incident");
  assert.match(why({ collection: 'task' }).checks.find((c) => c.id === 'table').detail, /parent of incident, so it applies here too/);
  assert.equal(why({ collection: 'task' }).outcome, 'run', 'a rule on the parent table applies');
  assert.equal(why({ action_update: 'false' }).headline, "Won't run: it runs on insert, not on update; this record already exists");
  assert.equal(why({ action_insert: 'false', action_update: 'false', action_delete: 'true' }).headline, "Won't run: it runs on delete, not on update");
  assert.equal(why({ filter_condition: 'priority=1^EQ' }).headline, "Won't run: the filter condition is not met: priority is 3, wanted 1");
  assert.equal(why({ filter_condition: 'state=9' }, { ...incident, operation: 'update' }).outcome, 'skip');
  // The same rule on a new record: insert is allowed.
  const fresh = { ...incident, isNew: true, previous: null, current: { ...incident.current, priority: '1' } };
  assert.equal(explainRule(br({ action_update: 'false', filter_condition: 'priority=1' }), fresh).outcome, 'run');
  // The operation can be chosen: a delete rule on a saved record.
  assert.equal(explainRule(br({ action_insert: 'false', action_update: 'false', action_delete: 'true' }), { ...incident, operation: 'delete' }).outcome, 'run');
});

test('business rule: a display rule runs on form load and sees the saved values', () => {
  const display = br({ when: 'display', action_insert: 'false', action_update: 'false', filter_condition: 'priority=3' });
  const edited = withCurrent({ priority: '1' });
  assert.equal(explainRule(display, edited).outcome, 'run', 'the saved priority 3 is what it sees');
  assert.match(explainRule(display, edited).checks.find((c) => c.id === 'operation').detail, /runs when the form loads/);
  const save = br({ filter_condition: 'priority=3' });
  assert.equal(explainRule(save, edited).outcome, 'skip', 'a before rule sees the values being saved');
});

test('business rule: roles, admin and unreadable roles', () => {
  const guarded = br({ role_conditions: 'x' });
  guarded.roleNames = ['admin_tools', 'security_admin'];
  assert.equal(explainRule(guarded, incident).headline, "Won't run: it needs admin_tools or security_admin; you have itil, snc_internal");
  assert.equal(explainRule(guarded, { ...incident, roles: ['itil', 'security_admin'] }).outcome, 'run');
  assert.match(explainRule(guarded, { ...incident, roles: ['admin'] }).checks.find((c) => c.id === 'roles').detail, /admin, which passes every role check/);
  assert.equal(explainRule(guarded, { ...incident, roles: null }).outcome, 'unknown');
  assert.equal(explainRule(guarded, { ...incident, roles: [] }).headline, "Won't run: it needs admin_tools or security_admin; you have no roles");
});

test('business rule: a condition script cannot be told, but a failing check still decides', () => {
  const scripted = br({ condition: 'current.priority == 1' });
  const r = explainRule(scripted, incident);
  assert.equal(r.outcome, 'unknown');
  assert.match(r.headline, /^Cannot tell: it has a condition script \(current\.priority == 1\)/);
  assert.equal(explainRule(br({ condition: 'current.priority == 1', active: 'false' }), incident).outcome, 'skip');
  // The condition column is only used by advanced rules.
  assert.equal(explainRule(br({ advanced: 'false', condition: 'current.priority == 1' }), incident).outcome, 'run');
});

test('business rule: a filter that needs the instance is "cannot tell"', () => {
  const r = explainRule(br({ filter_condition: 'opened_at>=javascript:gs.daysAgoStart(7)' }), incident);
  assert.equal(r.outcome, 'unknown');
  assert.match(r.headline, /compared with a script/);
});

test('business rule: async rules carry a note and stages sort display, before, after, async', () => {
  const rules = [br({ sys_id: 'a', name: 'C async', when: 'async', order: '1' }), br({ sys_id: 'b', name: 'B after', when: 'after', order: '1' }), br({ sys_id: 'c', name: 'A before', when: 'before', order: '200' }), br({ sys_id: 'd', name: 'Z before first', when: 'before', order: '5' }), br({ sys_id: 'e', name: 'D display', when: 'display', order: '900' })];
  const all = explainAll(rules, incident);
  assert.deepEqual(all.results.map((r) => r.name), ['D display', 'Z before first', 'A before', 'B after', 'C async']);
  assert.ok(all.results[4].checks.some((c) => c.id === 'async'));
  assert.deepEqual(all.counts, { run: 5, skip: 0, unknown: 0, total: 5 });
});

test('client script: type, field and UI type', () => {
  const cs = (over = {}) => normalizeRule('cs', { sys_id: 'c1', name: 'P1 group', table: 'incident', type: 'onChange', field: 'priority', active: 'true', ui_type: '10', ...over });
  assert.equal(explainRule(cs(), incident).outcome, 'run');
  assert.match(explainRule(cs(), incident).headline, /it runs when priority changes \(now 3\)/);
  assert.equal(explainRule(cs({ field: 'nope' }), incident).headline, "Won't run: it watches nope, which is not on this form");
  assert.equal(explainRule(cs({ type: 'onCellEdit' }), incident).headline, "Won't run: it runs when a cell is edited in a list, not on a form");
  assert.equal(explainRule(cs({ ui_type: '1' }), incident).headline, "Won't run: it is set for mobile / service portal only, not the desktop form");
  assert.equal(explainRule(cs({ type: 'onLoad', field: '' }), incident).outcome, 'run');
  assert.equal(explainRule(cs({ type: 'onSubmit', field: '' }), incident).outcome, 'run');
  assert.equal(explainRule(cs({ active: 'false' }), incident).headline, "Won't run: it is inactive");
  // On a parent table it needs "applies to extended tables".
  assert.equal(explainRule(cs({ table: 'task', applies_extended: 'false' }), incident).outcome, 'skip');
  assert.equal(explainRule(cs({ table: 'task', applies_extended: 'true' }), incident).outcome, 'run');
  assert.equal(explainRule(cs({ table: 'task' }), incident).outcome, 'unknown', 'the column was not read: cannot tell');
});

test('UI policy: conditions, inheritance and reverse if false', () => {
  const up = (over = {}) => normalizeRule('uip', { sys_id: 'u1', short_description: 'Make group mandatory for P1', table: 'incident', conditions: 'priority=1^EQ', active: 'true', on_load: 'true', reverse_if_false: 'false', inherit: 'false', ...over });
  const p1 = withCurrent({ priority: '1' });
  assert.equal(explainRule(up(), p1).outcome, 'run');
  assert.match(explainRule(up(), p1).headline, /the condition is met: priority is 1, so its actions apply/);
  assert.equal(explainRule(up(), incident).headline, "Won't run: the condition is not met: priority is 3, wanted 1");
  assert.match(explainRule(up({ reverse_if_false: 'true' }), incident).headline, /"reverse if false" is on, so the opposite actions apply instead/);
  assert.equal(explainRule(up({ conditions: '' }), incident).outcome, 'run');
  assert.equal(explainRule(up({ table: 'task', inherit: 'false' }), p1).outcome, 'skip');
  assert.equal(explainRule(up({ table: 'task', inherit: 'true' }), p1).outcome, 'run');
  assert.equal(explainRule(up({ view: 'ess' }), p1).outcome, 'unknown');
  assert.ok(explainRule(up({ on_load: 'false' }), p1).checks.some((c) => c.id === 'on_load' && /only when a field changes/.test(c.detail)));
});

test('data policy: conditions and what it is enforced on', () => {
  const dp = (over = {}) => normalizeRule('dp', { sys_id: 'd1', short_description: 'Resolution code required', model_table: 'incident', conditions: 'state=6^EQ', enforce_ui: 'true', active: 'true', ...over });
  assert.equal(explainRule(dp(), incident).headline, "Won't run: the condition is not met: state is 2, wanted 6");
  const resolved = withCurrent({ state: '6' });
  assert.equal(explainRule(dp(), resolved).outcome, 'run');
  assert.ok(explainRule(dp({ enforce_ui: 'false' }), resolved).checks.some((c) => c.id === 'ui' && /does not show it until then/.test(c.detail)));
  assert.equal(explainRule(dp({ model_table: 'problem' }), resolved).outcome, 'skip');
});

test('ACL: name, operation, roles, condition, script and admin override', () => {
  assert.deepEqual(parseAclName('incident.priority'), { table: 'incident', field: 'priority' });
  assert.deepEqual(parseAclName('incident.*'), { table: 'incident', field: '' });
  assert.deepEqual(parseAclName('incident'), { table: 'incident', field: '' });
  assert.deepEqual(parseAclName('*.priority'), { table: '*', field: 'priority' });
  const acl = (over = {}, names = ['itil']) => {
    const rule = normalizeRule('acl', { sys_id: 'a1', name: 'incident.priority', 'operation.name': 'write', active: 'true', admin_overrides: 'true', condition: '', advanced: 'false', script: '', ...over }, { roleNames: names });
    return rule;
  };
  assert.equal(explainRule(acl(), incident).outcome, 'run');
  assert.equal(outcomeWord('acl', 'run'), 'Would pass');
  assert.equal(explainRule(acl(), incident).headline.startsWith('Would pass'), true);
  assert.equal(explainRule(acl(), { ...incident, aclOperation: 'read' }).headline, "Would not pass: it protects write, not read");
  assert.equal(explainRule(acl({}, ['itil_admin']), incident).outcome, 'skip');
  assert.equal(explainRule(acl({}, ['itil_admin']), { ...incident, roles: ['admin'] }).outcome, 'run', 'admin has every role');
  assert.match(explainRule(acl({ admin_overrides: 'true' }, ['x']), { ...incident, roles: ['admin'] }).checks.at(-1).detail, /admin overrides/);
  assert.equal(explainRule(acl({ condition: 'state=9' }), incident).headline.startsWith('Would not pass: the condition is not met'), true);
  assert.equal(explainRule(acl({ advanced: 'true', script: 'answer = gs.hasRole("x");' }), incident).outcome, 'unknown');
  assert.equal(explainRule(acl({ name: '*.priority' }), incident).outcome, 'run', 'a field ACL on any table');
  assert.equal(explainRule(acl({ name: 'task.*' }), incident).outcome, 'run', 'a parent table ACL');
  assert.equal(explainRule(acl({ name: 'problem.*' }), incident).outcome, 'skip');
  assert.equal(explainRule(acl({ active: 'false' }), incident).headline, "Would not pass: it is inactive");
});

test('explainAll groups by outcome and keeps types in order', () => {
  const rules = [
    normalizeRule('acl', { sys_id: 'a', name: 'incident', 'operation.name': 'write' }, { roleNames: [] }),
    normalizeRule('uip', { sys_id: 'u', short_description: 'UI', table: 'incident', conditions: 'priority=1' }),
    br({ sys_id: 'b', name: 'BR ok' }),
    br({ sys_id: 'b2', name: 'BR inactive', active: 'false' }),
    br({ sys_id: 'b3', name: 'BR script', filter_condition: 'opened_at>=javascript:gs.daysAgoStart(1)' }),
  ];
  const all = explainAll(rules, incident);
  assert.deepEqual(all.results.map((r) => r.type), ['br', 'br', 'br', 'uip', 'acl']);
  assert.deepEqual(all.counts, { run: 2, skip: 2, unknown: 1, total: 5 });
  assert.deepEqual(all.groups.unknown.map((r) => r.name), ['BR script']);
});

test('helpers: dotted fields to fetch, default operation, summaries and markdown', () => {
  const rules = [br({ filter_condition: 'caller_id.department=IT^priority=1^ORassigned_to.manager.name=Bob' }), br({ filter_condition: 'state=1' })];
  assert.deepEqual(dottedFields(rules).sort(), ['assigned_to.manager.name', 'caller_id.department']);
  assert.equal(defaultOperation(true), 'insert');
  assert.equal(defaultOperation(false), 'update');
  assert.equal(summarize(['a', 'b', 'c', 'd', 'e']), 'a, b, c and 2 more');
  assert.equal(summarize(['a', '', 'b']), 'a, b');
  const all = explainAll([br({ name: 'Rule A' }), br({ name: 'Rule B', active: 'false' })], incident);
  const md = explanationToMarkdown({ subject: { table: 'incident', isNew: false }, groups: all.groups });
  assert.match(md, /^# Why rules ran or not: incident/);
  assert.match(md, /## Would run \(1\)\n\n- \*\*Rule A\*\* \(Business rule, before\)/);
  assert.match(md, /## Won't run \(1\)\n\n- \*\*Rule B\*\*.*it is inactive/);
});

test('a rule type that does not exist is refused', () => {
  assert.throws(() => normalizeRule('nope', {}), /Unknown rule type/);
});
