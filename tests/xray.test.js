const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../src/lib/xray.js');

test('parses classic form ids, catalog ids and list row ids', () => {
  assert.deepEqual(X.parsePrefixedId('label.incident.caller_id', 'label.'), { table: 'incident', field: 'caller_id' });
  assert.deepEqual(X.parsePrefixedId('element.incident.caller_id.email', 'element.'), { table: 'incident', field: 'caller_id.email' });
  assert.deepEqual(X.parsePrefixedId('element.IO:0123456789abcdef0123456789ABCDEF', 'element.'), { io: '0123456789abcdef0123456789abcdef' });
  assert.equal(X.parsePrefixedId('label.incident', 'label.'), null);
  assert.equal(X.parsePrefixedId('label.inc"ident.x', 'label.'), null);
  assert.equal(X.parsePrefixedId('status.incident.x', 'label.'), null);
  assert.deepEqual(X.ioIdsIn('sys_display.IO:0123456789abcdef0123456789abcdef and IO:fedcba9876543210fedcba9876543210'), [
    '0123456789abcdef0123456789abcdef',
    'fedcba9876543210fedcba9876543210',
  ]);
  assert.equal(X.rowSysId('', 'row_incident_0123456789abcdef0123456789abcdef'), '0123456789abcdef0123456789abcdef');
  assert.equal(X.rowSysId('0123456789ABCDEF0123456789abcdef', 'x'), '0123456789abcdef0123456789abcdef');
  assert.equal(X.rowSysId('', 'row_incident'), null);
});

test('portal widget and instance ids come from class and id tokens', () => {
  assert.equal(X.widgetIdFromClasses(['ng-scope', 'v0123456789abcdef0123456789abcdef']), '0123456789abcdef0123456789abcdef');
  assert.equal(X.widgetIdFromClasses(['visible', 'v123']), null);
  assert.equal(X.instanceIdFromId('x0123456789abcdef0123456789abcdef'), '0123456789abcdef0123456789abcdef');
  assert.equal(X.instanceIdFromId('xyz'), null);
});

test('recognises portal, workspace and catalog URLs', () => {
  assert.deepEqual(X.portalFromUrl('https://dev1.service-now.com/esc?id=sc_cat_item&sys_id=0123456789abcdef0123456789abcdef'), {
    suffix: 'esc',
    pageId: 'sc_cat_item',
    sysId: '0123456789abcdef0123456789abcdef',
    table: '',
  });
  assert.equal(X.portalFromUrl('https://dev1.service-now.com/sp').pageId, '');
  assert.equal(X.portalFromUrl('https://dev1.service-now.com/incident.do?sys_id=1'), null);
  assert.equal(X.portalFromUrl('https://dev1.service-now.com/now/nav/ui/home'), null);
  assert.equal(X.portalFromUrl('not a url'), null);

  assert.deepEqual(X.parseWorkspaceUrl('https://x.service-now.com/now/sow/record/incident/0123456789abcdef0123456789abcdef'), {
    kind: 'record',
    table: 'incident',
    sysId: '0123456789abcdef0123456789abcdef',
  });
  assert.equal(X.parseWorkspaceUrl('https://x.service-now.com/now/sow/list/params/list-id/abc/table/incident').table, 'incident');
  assert.equal(X.parseWorkspaceUrl('https://x.service-now.com/now/nav/ui/classic/params/target/incident.do'), null);
  assert.equal(X.parseWorkspaceUrl('https://x.service-now.com/incident.do'), null);

  assert.equal(X.catalogItemFromUrl('https://x.service-now.com/com.glideapp.servicecatalog_cat_item_view.do?v=1&sysparm_id=0123456789abcdef0123456789abcdef'), '0123456789abcdef0123456789abcdef');
  assert.equal(X.catalogItemFromUrl('https://x.service-now.com/sp?id=sc_cat_item&sys_id=0123456789abcdef0123456789abcdef'), '0123456789abcdef0123456789abcdef');
  assert.equal(X.catalogItemFromUrl('https://x.service-now.com/sp?id=form&sys_id=0123456789abcdef0123456789abcdef'), '');
});

test('strips comments but keeps strings and line numbers', () => {
  const code = "var a = 'http://x'; // g_form.setReadOnly('x', true)\n/* g_form.setMandatory('y', true) */\ng_form.setDisplay('z', false);";
  const stripped = X.stripComments(code);
  assert.match(stripped, /'http:\/\/x'/);
  assert.doesNotMatch(stripped, /setReadOnly|setMandatory/);
  assert.equal(stripped.split('\n').length, 3);
  assert.deepEqual(
    X.gformCalls(code).map((c) => [c.method, c.field, c.arg, c.line]),
    [['setDisplay', 'z', 'false', 3]]
  );
});

test('finds g_form state calls, including literal values and indirect field names', () => {
  const script = [
    'function onLoad() {',
    "  g_form.setReadOnly('short_description', true);",
    "  g_form.setMandatory(\"category\", isVip);",
    "  g_form.setDisplay('variables.u_due', false);",
    '}',
  ].join('\n');
  assert.deepEqual(X.stateCalls(script, 'short_description'), [{ kind: 'readOnly', value: true, method: 'setReadOnly', line: 2, indirect: false }]);
  assert.equal(X.stateCalls(script, 'category')[0].value, null);
  assert.deepEqual(X.stateCalls(script, 'u_due')[0], { kind: 'hidden', value: true, method: 'setDisplay', line: 4, indirect: false });
  assert.deepEqual(X.stateCalls(script, 'impact'), []);

  const loop = "var f = ['impact', 'urgency'];\nf.forEach(function (n) { g_form.setReadOnly(n, true); });";
  const calls = X.stateCalls(loop, 'urgency');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].indirect, true);
  assert.equal(calls[0].value, true);
  assert.deepEqual(X.stateCalls(loop, 'priority'), []);
});

test('finds the fields a server script uses through current and previous', () => {
  const refs = X.serverFieldRefs(
    "if (current.state.changesTo(6) && previous.priority != 1) { current.setValue('close_code', 'x'); current.update(); }\n// current.commented\ncurrent.setAbortAction(true); current.variables.foo;"
  );
  assert.deepEqual([...refs].sort(), ['close_code', 'priority', 'state']);
  assert.deepEqual([...X.fieldsInQuery('active=true^caller_id.vip=true^ORpriority=1')].sort(), ['active', 'caller_id', 'caller_id.vip', 'priority']);
});

test('evaluates UI policy conditions with platform precedence and unknowns', () => {
  const values = { state: '2', priority: '1', category: 'network', assigned_to: '', active: 'true' };
  assert.equal(X.evaluateCondition('', values), true);
  assert.equal(X.evaluateCondition('state=2^EQ', values), true);
  assert.equal(X.evaluateCondition('state=3', values), false);
  assert.equal(X.evaluateCondition('state=3^ORpriority=1', values), true);
  // (state=3 OR priority=1) AND category=software -> false
  assert.equal(X.evaluateCondition('state=3^ORpriority=1^category=software', values), false);
  assert.equal(X.evaluateCondition('state=3^NQcategory=network', values), true);
  assert.equal(X.evaluateCondition('assigned_toISEMPTY^categoryLIKENET', values), true);
  assert.equal(X.evaluateCondition('stateIN1,2,3^priority<2', values), true);
  assert.equal(X.evaluateCondition('stateNOT IN1,2', values), false);
  // Not decidable from the form: field not on the form, dot-walks, javascript values.
  assert.equal(X.evaluateCondition('impact=1', values), null);
  assert.equal(X.evaluateCondition('caller_id.vip=true', values), null);
  assert.equal(X.evaluateCondition('assigned_to=javascript:gs.getUserID()', values), null);
  // Unknown AND false is still false; unknown OR true is still true.
  assert.equal(X.evaluateCondition('impact=1^state=3', values), false);
  assert.equal(X.evaluateCondition('impact=1^ORstate=2', values), true);
});

test('policy actions explain a state directly, reversed, or maybe', () => {
  const ro = { disabled: 'true', mandatory: 'ignore', visible: 'ignore' };
  assert.equal(X.policyCause(ro, 'readOnly', true), 'applied');
  assert.equal(X.policyCause(ro, 'readOnly', false), null);
  assert.equal(X.policyCause(ro, 'readOnly', null), 'maybe');
  assert.equal(X.policyCause(ro, 'mandatory', true), null);
  const editable = { disabled: 'false' };
  assert.equal(X.policyCause(editable, 'readOnly', false, true), 'reversed');
  assert.equal(X.policyCause(editable, 'readOnly', false, false), null);
  assert.equal(X.policyCause({ visible: 'false' }, 'hidden', true), 'applied');
  assert.equal(X.describeAction({ mandatory: 'true', disabled: 'ignore', visible: 'false' }), 'mandatory, hidden');
  assert.equal(X.describeAction({}), 'no state change');
});

const POLICY = (over = {}) => ({ sysId: 'p1', name: 'Lock when resolved', table: 'incident', conditions: 'state=6^EQ', onLoad: true, reverseIfFalse: true, actions: [], ...over });

function sampleLogic() {
  return {
    tables: ['incident', 'task'],
    clientScripts: [
      { sysId: 'c1', name: 'Lock desc', type: 'onLoad', table: 'incident', field: '', script: "g_form.setReadOnly('short_description', true);" },
      { sysId: 'c2', name: 'Category change', type: 'onChange', table: 'incident', field: 'category', script: "g_form.setMandatory('subcategory', g_form.getValue('category') == 'network');" },
      { sysId: 'c3', name: 'Loop', type: 'onLoad', table: 'incident', field: '', script: "['impact'].forEach(function (f) { g_form.setReadOnly(f, true); });" },
    ],
    uiPolicies: [
      POLICY({ actions: [{ sysId: 'a1', field: 'short_description', disabled: 'true', mandatory: 'ignore', visible: 'ignore' }] }),
      POLICY({ sysId: 'p2', name: 'Hide close notes', conditions: 'state!=6', actions: [{ sysId: 'a2', field: 'close_notes', visible: 'false', disabled: 'ignore', mandatory: 'ignore' }] }),
      POLICY({ sysId: 'p3', name: 'Parent only', table: 'task', inherit: false, conditions: '', actions: [{ sysId: 'a3', field: 'short_description', disabled: 'true' }] }),
    ],
    dataPolicies: [{ sysId: 'd1', name: 'Need a caller', table: 'incident', conditions: '', rules: [{ sysId: 'r1', field: 'caller_id', mandatory: 'true', disabled: 'ignore' }] }],
    businessRules: [{ sysId: 'b1', name: 'Set desc', table: 'incident', when: 'before', script: 'current.short_description = current.category + "";', condition: 'current.state.changes()', filterCondition: 'priority=1' }],
    acls: [
      { sysId: 'acl1', name: 'incident.short_description', operation: 'write' },
      { sysId: 'acl2', name: 'task', operation: 'write' },
      { sysId: 'acl3', name: 'problem.short_description', operation: 'write' },
    ],
    overrides: [{ sysId: 'o1', table: 'incident', element: 'impact', readOnly: true, mandatory: null }],
  };
}

test('indexes every artifact by the fields it touches', () => {
  const { fields, tableAcls } = X.buildFieldIndex(sampleLogic(), ['short_description', 'impact', 'category', 'subcategory']);
  const desc = fields.get('short_description');
  assert.deepEqual(desc.clientScripts.map((r) => r.script.sysId), ['c1']);
  assert.deepEqual(desc.uiPolicies.map((r) => [r.policy.sysId, r.role]), [['p1', 'action'], ['p3', 'action']]);
  assert.deepEqual(desc.businessRules[0].where, ['script']);
  assert.deepEqual(desc.acls.map((a) => a.name), ['incident.short_description']);
  assert.deepEqual(tableAcls.map((a) => a.name), ['task']);
  assert.deepEqual(fields.get('category').clientScripts[0].reasons.sort(), ['getValue', 'onChange']);
  assert.deepEqual(fields.get('impact').clientScripts[0].reasons, ['indirect']);
  assert.equal(fields.get('state').uiPolicies.length, 2); // used in two policy conditions
  assert.deepEqual(fields.get('priority').businessRules[0].where, ['filter']);
  assert.equal(fields.get('caller_id').dataPolicies[0].role, 'rule');
  const counts = X.countEntry(desc);
  assert.equal(counts.uiPolicies, 2);
  assert.equal(counts.total, 1 + 2 + 0 + 1 + 1);
  assert.match(X.summarizeEntry(desc), /1 client script, 2 UI policies, 1 business rule, 1 ACL/);
  assert.match(X.summarizeEntry(undefined), /No client scripts/);
});

test('ranks why a field is read-only: matching UI policy first, then scripts, dictionary, ACLs', () => {
  const { fields, tableAcls } = X.buildFieldIndex(sampleLogic(), ['short_description', 'impact']);
  const why = X.rankCauses({
    field: 'short_description',
    table: 'incident',
    state: { readOnly: true, mandatory: false, visible: true, onForm: true },
    values: { state: '6' },
    entry: fields.get('short_description'),
    dictionary: { readOnly: true, mandatory: false, definedOn: 'task' },
    overrides: [],
    tableAcls,
    readOnlyRatio: 0.2,
  });
  assert.deepEqual(why.mandatory, []);
  assert.deepEqual(why.hidden, []);
  const kinds = why.readOnly.map((c) => c.kind);
  assert.deepEqual(kinds, ['ui_policy', 'client_script', 'dictionary', 'acl']);
  assert.equal(why.readOnly[0].confidence, 'likely');
  assert.equal(why.readOnly[0].sysId, 'p1');
  assert.equal(why.readOnly[0].table, 'sys_ui_policy');
  assert.ok(!why.readOnly.some((c) => c.sysId === 'p3'), 'a non-inherited parent policy is not a cause');

  // When the condition does not match, the policy is no longer the top cause.
  const other = X.rankCauses({ field: 'short_description', table: 'incident', state: { readOnly: true }, values: { state: '2' }, entry: fields.get('short_description'), dictionary: {}, tableAcls });
  assert.equal(other.readOnly[0].kind, 'client_script');

  // A mobile / portal-only client script never runs on the desktop form.
  const mobileEntry = { ...fields.get('short_description'), clientScripts: fields.get('short_description').clientScripts.map((r) => ({ ...r, script: { ...r.script, uiType: '1' } })) };
  const mobile = X.rankCauses({ field: 'short_description', table: 'incident', state: { readOnly: true }, values: { state: '2' }, entry: mobileEntry, dictionary: {}, tableAcls });
  assert.ok(!mobile.readOnly.some((c) => c.kind === 'client_script'));
});

test('overrides beat the dictionary, and a read-only form is reported', () => {
  const { fields } = X.buildFieldIndex(sampleLogic(), ['impact']);
  const why = X.rankCauses({
    field: 'impact',
    table: 'incident',
    state: { readOnly: true },
    entry: fields.get('impact'),
    dictionary: { readOnly: false },
    overrides: [{ sysId: 'o1', table: 'incident', readOnly: true }],
    readOnlyRatio: 0.95,
  });
  const kinds = why.readOnly.map((c) => c.kind);
  assert.equal(kinds[0], 'override');
  assert.ok(kinds.includes('form'));
  assert.ok(kinds.includes('client_script'), 'indirect script call is listed');
  assert.equal(why.readOnly.find((c) => c.kind === 'client_script').confidence, 'unlikely');

  // An override that turns read-only off silences the dictionary flag.
  const off = X.rankCauses({ field: 'x', state: { readOnly: true }, dictionary: { readOnly: true }, overrides: [{ table: 'incident', readOnly: false }] });
  assert.deepEqual(off.readOnly.map((c) => c.kind), ['none']);
});

test('ranks mandatory and hidden causes', () => {
  const { fields } = X.buildFieldIndex(sampleLogic(), []);
  const mandatory = X.rankCauses({ field: 'subcategory', table: 'incident', state: { mandatory: true }, entry: fields.get('subcategory') });
  assert.equal(mandatory.mandatory[0].kind, 'client_script');
  assert.equal(mandatory.mandatory[0].confidence, 'possible');

  const caller = X.rankCauses({ field: 'caller_id', table: 'incident', state: { mandatory: true }, values: {}, entry: fields.get('caller_id') });
  assert.equal(caller.mandatory[0].kind, 'data_policy');

  const hidden = X.rankCauses({ field: 'close_notes', table: 'incident', state: { visible: false }, values: { state: '2' }, entry: fields.get('close_notes') });
  assert.equal(hidden.hidden[0].kind, 'ui_policy');
  assert.equal(hidden.hidden[0].confidence, 'likely');

  const missing = X.rankCauses({ field: 'u_x', state: { onForm: false } });
  assert.equal(missing.hidden[0].kind, 'layout');
});

test('maps catalog variables to their client scripts and UI policies', () => {
  const v1 = '0123456789abcdef0123456789abcdef';
  const v2 = 'fedcba9876543210fedcba9876543210';
  const variables = [
    { sysId: v1, name: 'needs_laptop' },
    { sysId: v2, name: 'laptop_model' },
  ];
  const index = X.catalogVariableIndex({
    variables,
    clientScripts: [
      { sysId: 's1', name: 'Show model', type: 'onChange', catVariable: `IO:${v1}`, script: "g_form.setDisplay('laptop_model', newValue == 'true');" },
      { sysId: 's2', name: 'RITM lock', type: 'onLoad', catVariable: '', script: "g_form.setReadOnly('variables.needs_laptop', true);" },
    ],
    uiPolicies: [
      { sysId: 'u1', name: 'Model mandatory', conditions: `IO:${v1}=true^EQ`, actions: [{ sysId: 'x1', catalogVariable: `IO:${v2}`, mandatory: 'true' }] },
    ],
  });
  assert.deepEqual(index.get(v1).clientScripts.map((r) => [r.script.sysId, r.reasons.join()]), [
    ['s1', 'onChange'],
    ['s2', 'setReadOnly'],
  ]);
  assert.deepEqual(index.get(v2).clientScripts.map((r) => r.script.sysId), ['s1']);
  assert.equal(index.get(v2).clientScripts[0].calls[0].value, null);
  assert.deepEqual(index.get(v2).uiPolicies.map((r) => r.role), ['action']);
  assert.deepEqual(index.get(v1).uiPolicies.map((r) => r.role), ['condition']);
  assert.equal(X.readableCatalogCondition(`IO:${v1}=true^EQ`, variables), 'needs_laptop=true');
  assert.equal(X.variableTypeName('8'), 'Reference');
  assert.equal(X.variableTypeName('6', 'Single Line Text'), 'Single Line Text');
  assert.equal(X.variableTypeName('99'), 'type 99');
});

test('display helpers', () => {
  assert.equal(X.shortType({ type: 'glide_date_time' }), 'date/time');
  assert.equal(X.shortType({ type: 'string', choiceType: '1' }), 'choice');
  assert.equal(X.shortType({ type: 'reference', choiceType: '1' }), 'reference');
  assert.equal(X.shortType({ type: 'string', choiceType: '2' }), 'string');
  assert.equal(X.shortType({ type: 'string', choiceType: '3' }), 'choice');
  assert.equal(X.recordPath('sys_ui_policy', '0123456789abcdef0123456789abcdef'), '/sys_ui_policy.do?sys_id=0123456789abcdef0123456789abcdef');
  assert.equal(X.recordPath('bad table', '0123456789abcdef0123456789abcdef'), '');
  assert.equal(X.recordPath('sys_ui_policy', 'nope'), '');
  assert.equal(X.literalBool(' true '), true);
  assert.equal(X.literalBool('!1'), false);
  assert.equal(X.literalBool('x == 1'), null);
});

// --- Review follow-ups ---------------------------------------------------------------------------

test('"does not contain" conditions evaluate in both spellings', () => {
  const values = { short_description: 'VPN is down', category: '' };
  assert.equal(X.evaluateCondition('short_descriptionNOT LIKEvpn', values), false);
  assert.equal(X.evaluateCondition('short_descriptionNOT LIKEemail', values), true);
  assert.equal(X.evaluateCondition('short_descriptionNOTLIKEemail', values), true);
  assert.equal(X.evaluateCondition('categoryEMPTYSTRING', values), true);
});

test('view-specific and mobile-only policies and scripts do not explain the desktop default view', () => {
  assert.equal(X.appliesToView({ global: true, view: 'ess' }, ''), true);
  assert.equal(X.appliesToView({ view: 'ess' }, ''), true); // global unknown = every view
  assert.equal(X.appliesToView({ global: false, view: 'ess' }, ''), false);
  assert.equal(X.appliesToView({ global: false, view: 'ESS' }, 'ess'), true);
  assert.equal(X.appliesToView({ global: false, view: 'Default view' }, ''), true);
  assert.equal(X.appliesToView({ global: false, view: 'ess' }, null), null);
  assert.equal(X.appliesToView({ global: false, view: '' }, 'ess'), null);

  const action = { sysId: 'a', field: 'short_description', disabled: 'true' };
  const policy = (over) => ({ sysId: over.sysId, name: over.sysId, table: 'incident', conditions: '', actions: [action], ...over });
  const logic = {
    tables: ['incident'],
    uiPolicies: [policy({ sysId: 'ess_only', global: false, view: 'ess' }), policy({ sysId: 'mobile', uiType: '1' }), policy({ sysId: 'all' })],
    clientScripts: [{ sysId: 'cs_ess', name: 'ess', type: 'onLoad', table: 'incident', global: false, view: 'ess', script: "g_form.setReadOnly('short_description', true);" }],
  };
  const { fields } = X.buildFieldIndex(logic, ['short_description']);
  const input = { field: 'short_description', table: 'incident', state: { readOnly: true }, entry: fields.get('short_description') };

  const onDefault = X.rankCauses({ ...input, view: '' }).readOnly.map((c) => c.sysId);
  assert.deepEqual(onDefault, ['all']);

  const onEss = X.rankCauses({ ...input, view: 'ess' }).readOnly.map((c) => c.sysId);
  assert.deepEqual(onEss.sort(), ['all', 'cs_ess', 'ess_only']);

  // View unknown: the view-specific policy stays, ranked below the global one and explained.
  const unknown = X.rankCauses({ ...input, view: null }).readOnly;
  const essCause = unknown.find((c) => c.sysId === 'ess_only');
  assert.equal(unknown[0].sysId, 'all');
  assert.ok(essCause.score < unknown[0].score);
  assert.match(essCause.detail, /Only on view "ess"/);
  assert.ok(!unknown.some((c) => c.sysId === 'mobile'));
});

test('unknown g_form states are filled from the form markup, known ones win', () => {
  const { state, merged } = X.fillUnknownState({ value: 'x', mandatory: true, readOnly: null, visible: null }, { mandatory: false, readOnly: true, visible: false });
  assert.equal(merged, true);
  assert.deepEqual([state.mandatory, state.readOnly, state.visible], [true, true, false]);
  assert.equal(X.fillUnknownState({ readOnly: false, visible: true, mandatory: false }, { readOnly: true }).merged, false);
  assert.equal(X.fillUnknownState({ readOnly: null }, null).merged, false);
  // A filled read-only state now produces causes (it used to stay null and explain nothing).
  const why = X.rankCauses({ field: 'f', state: { readOnly: state.readOnly }, dictionary: { readOnly: true } });
  assert.equal(why.readOnly[0].kind, 'dictionary');
  assert.deepEqual(X.rankCauses({ field: 'f', state: { readOnly: null }, dictionary: { readOnly: true } }).readOnly, []);
});

test('the portal tag sits outside the widget box', () => {
  const viewport = { width: 1200, height: 800 };
  assert.deepEqual(X.tagPlacement({ top: 100, bottom: 300, left: 50 }, 22, 300, viewport), { top: 78, left: 50, side: 'above' });
  assert.deepEqual(X.tagPlacement({ top: 10, bottom: 300, left: 50 }, 22, 300, viewport), { top: 300, left: 50, side: 'below' });
  assert.equal(X.tagPlacement({ top: 0, bottom: 800, left: 0 }, 22, 300, viewport).side, 'inside');
  assert.equal(X.tagPlacement({ top: 100, bottom: 300, left: 1100 }, 22, 300, viewport).left, 900); // kept on screen
});

test('catalog variables with the same name in two variable sets keep separate logic', () => {
  const a = '11111111111111111111111111111111';
  const b = '22222222222222222222222222222222';
  const setA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const setB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const variables = [
    { sysId: a, name: 'location', variableSet: setA },
    { sysId: b, name: 'location', variableSet: setB },
  ];
  const index = X.catalogVariableIndex({
    variables,
    clientScripts: [
      { sysId: 'csA', type: 'onLoad', variableSet: setA, script: "g_form.setMandatory('location', true);" },
      { sysId: 'csB', type: 'onChange', variableSet: setB, catVariable: `IO:${b}`, script: '' },
    ],
    uiPolicies: [{ sysId: 'upA', variableSet: setA, conditions: `IO:${a}ISNOTEMPTY^EQ`, actions: [{ variable: 'location', mandatory: 'true' }] }],
  });
  assert.deepEqual(index.get(a).clientScripts.map((r) => r.script.sysId), ['csA']);
  assert.deepEqual(index.get(b).clientScripts.map((r) => r.script.sysId), ['csB']);
  assert.deepEqual(index.get(a).uiPolicies.map((r) => [r.policy.sysId, r.role]), [['upA', 'action']]);
  assert.deepEqual(index.get(b).uiPolicies, []);
});
