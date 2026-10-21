const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/lib/fieldUsage.js');

const chain = ['incident', 'task'];

test('a table and a field are read from "incident.state", "incident state" and nothing else', () => {
  assert.deepEqual(U.parseUsageTarget('incident.state'), { table: 'incident', field: 'state' });
  assert.deepEqual(U.parseUsageTarget('  Incident State '), { table: 'incident', field: 'state' });
  assert.deepEqual(U.parseUsageTarget('x_acme_app_thing / u_status'), { table: 'x_acme_app_thing', field: 'u_status' });
  assert.equal(U.parseUsageTarget('incident'), null);
  assert.equal(U.parseUsageTarget('incident.caller_id.name'), null, 'a dot-walk is not a field');
  assert.equal(U.parseUsageTarget("incident.state'^"), null);
  assert.equal(U.parseUsageTarget(''), null);
});

test('the field matches as a whole word only', () => {
  const re = U.fieldWord('state');
  assert.ok(re.test('current.state = 6'));
  assert.ok(re.test("gr.getValue('state')"));
  assert.ok(!re.test('current.state_reason'));
  assert.ok(!re.test('var estate = 1'));
  assert.ok(!re.test('$state'));
});

test('a line is a write, a form change, a query, a read or just a mention', () => {
  const k = (line) => U.useKind(line, 'state');
  assert.equal(k('current.state = 6;'), 'write');
  assert.equal(k('current.state += 1'), 'write');
  assert.equal(k("gr.setValue('state', 7);"), 'write');
  assert.equal(k("current.state.setValue(7)"), 'write');
  assert.equal(k("g_form.setValue('state', '6');"), 'write');
  assert.equal(k("g_form.setMandatory('state', true);"), 'ui');
  assert.equal(k("g_form.getValue('state')"), 'read');
  assert.equal(k("gr.addQuery('state', '!=', 7);"), 'query');
  assert.equal(k("gr.orderByDesc('state');"), 'query');
  assert.equal(k("gr.addEncodedQuery('active=true^state=6');"), 'query');
  assert.equal(k('if (current.state == 6) {'), 'read', '== is a comparison, not an assignment');
  assert.equal(k("var s = gr.getValue('state');"), 'read');
  assert.equal(k("gs.info('state is wrong');"), 'mention');
});

test('only lines that use the field are listed, comments are skipped and the strongest use is found', () => {
  const source = [
    '// current.state = 99; not real',
    'var gr = new GlideRecord("incident");',
    'gr.addQuery("state", 1);',
    'if (current.state == 6) {',
    '  current.state = 7;',
    '}',
    '/* state in a block comment */',
  ].join('\n');
  const uses = U.scriptUses(source, 'state');
  assert.deepEqual(uses.map((u) => [u.line, u.kind]), [[3, 'query'], [4, 'read'], [5, 'write']]);
  assert.equal(uses[2].text, 'current.state = 7;');
  assert.equal(U.strongestKind(uses), 'write');
  assert.equal(U.strongestKind([]), '');
  assert.equal(U.scriptUses(source, 'state', 2).length, 2, 'capped');
});

test('a script is on this table, names this table, or might be anything', () => {
  const c = (artifact, hit) => U.certaintyFor(artifact, hit, chain);
  assert.equal(c('sys_script', { scopeHint: 'incident', source: '' }), 'direct');
  assert.equal(c('sys_script', { scopeHint: 'task', source: '' }), 'direct', 'a rule on the parent table applies');
  assert.equal(c('sys_script', { scopeHint: 'problem', source: 'current.state = 1' }), null, 'another table, never named');
  assert.equal(c('sys_script', { scopeHint: 'problem', source: "new GlideRecord('incident')" }), 'likely', 'another table but it queries this one');
  assert.equal(c('sys_script_include', { source: "var gr = new GlideRecord('incident'); gr.state" }), 'likely');
  assert.equal(c('sys_script_include', { source: "var gr = new GlideRecord(table); gr.state" }), 'possible');
  assert.equal(c('sys_security_acl', { name: 'incident.state', source: '' }), 'direct');
  assert.equal(c('sys_security_acl', { name: 'incident', source: '' }), 'direct');
  assert.equal(c('sys_security_acl', { name: 'problem.state', source: '' }), null);
  assert.equal(c('sys_script', { scopeHint: '', source: '' }), 'possible', 'no table on the record: treated like a script that runs everywhere');
});

test('the same table named in a comment does not count', () => {
  assert.equal(U.namesTable("// new GlideRecord('incident')\nvar x = 1;", ['incident']), false);
  assert.equal(U.namesTable("var gr = new GlideRecord(\"incident\");", ['incident']), true);
  assert.equal(U.namesTable("var t = 'incident_task';", ['incident']), false, 'a longer name is a different table');
});

test('an encoded query mentions a field by name, not by prefix', () => {
  assert.ok(U.queryMentions('state=6^active=true', 'state'));
  assert.ok(U.queryMentions('active=true^ORstateIN6,7', 'state'));
  assert.ok(U.queryMentions('active=true^NQstateISEMPTY', 'state'));
  assert.ok(U.queryMentions('priority!=1^stateCHANGES', 'state'));
  assert.ok(!U.queryMentions('state_reason=x', 'state'));
  assert.ok(!U.queryMentions('estate=1', 'state'));
  assert.ok(!U.queryMentions('', 'state'));
});

test('the configuration sources ask about the table and its parents, and drop rows the server did not filter', () => {
  const sources = U.configSources(chain, 'state');
  const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
  assert.equal(byId.acl.query, 'active=true^nameINincident.state,task.state');
  assert.equal(byId.ui_policy_action.query, 'field=state^ui_policy.tableINincident,task');

  // ServiceNow returns every row for a column it does not know, so each source filters again.
  assert.ok(byId.acl.keep({ name: 'incident.state', active: 'true' }));
  assert.ok(!byId.acl.keep({ name: 'incident.priority', active: 'true' }));
  assert.ok(byId.data_policy.keep({ field: 'state', table: 'task' }));
  assert.ok(!byId.data_policy.keep({ field: 'state', table: 'problem' }));
  assert.ok(byId.dictionary_override.keep({ name: 'incident', element: 'state' }));
  assert.ok(!byId.dictionary_override.keep({ name: 'incident', element: 'impact' }));
  assert.ok(byId.client_onchange.keep({ field: 'state', type: 'onChange', table: 'incident', active: 'true' }));
  assert.ok(!byId.client_onchange.keep({ field: 'state', type: 'onLoad', table: 'incident', active: 'true' }));
  assert.ok(byId.business_rule_filter.keep({ collection: 'incident', filter_condition: 'active=true^ORstateIN6,7', active: 'true' }));
  assert.ok(!byId.business_rule_filter.keep({ collection: 'incident', filter_condition: 'state_reason=x', active: 'true' }));
  assert.ok(!byId.ui_policy_action.keep({ field: 'state', 'ui_policy.table': 'incident', 'ui_policy.active': 'false' }));
  assert.equal(byId.ui_policy_action.detail({ visible: 'false', mandatory: 'true', disabled: '' }), 'visible off, mandatory on');
});

test('results sort by certainty, then by how the field is used', () => {
  const items = [
    { certainty: 'possible', kind: 'write', label: 'Script Include', name: 'A' },
    { certainty: 'direct', kind: 'read', label: 'Business Rule', name: 'B' },
    { certainty: 'direct', kind: 'write', label: 'Business Rule', name: 'C' },
    { certainty: 'likely', kind: 'query', label: 'Script Include', name: 'D' },
  ];
  assert.deepEqual(U.sortItems(items).map((i) => i.name), ['C', 'B', 'D', 'A']);
  assert.equal(items[0].name, 'A', 'the input is not reordered');
});

test('the headline counts uses and says what was left out', () => {
  const t = { table: 'incident', field: 'state' };
  assert.equal(U.headline(t, []), 'Nothing found that uses incident.state.');
  assert.equal(U.headline(t, [], { otherTables: 3 }), 'Nothing found that uses incident.state (3 on other tables were left out).');
  const items = [{ kind: 'write' }, { kind: 'write' }, { kind: 'read' }, { kind: 'ui' }];
  assert.equal(U.headline(t, items), 'incident.state: 2 set it, 1 read it, 1 control it on the form.');
  assert.equal(U.headline(t, items, { otherTables: 2, capped: ['Business Rule'] }), 'incident.state: 2 set it, 1 read it, 1 control it on the form. 2 more on other tables were left out. Only the first 100 matches were read in Business Rule.');
});

test('the markdown table escapes pipes and the prompt names the records', () => {
  const t = { table: 'incident', field: 'state' };
  const items = [{ kind: 'write', label: 'Business Rule', name: 'Close | resolve', field: 'script', certainty: 'direct', uses: [{ line: 4, text: 'current.state = 7;', kind: 'write' }] }];
  const md = U.usageToMarkdown(t, items, 'incident.state: 1 set it.');
  assert.match(md, /Close \\\| resolve/);
  assert.match(md, /script line 4: current\.state = 7;/);
  assert.match(U.usageToMarkdown(t, []), /Nothing found/);
  const prompt = U.usagePrompt(t, items);
  assert.match(prompt, /Business Rule "Close \| resolve"/);
  assert.match(prompt, /incident\.state/);
});
