const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getCompletions,
  applyCompletion,
  getHoverInfo,
  getSignatureHelp,
  getDefinitionTarget,
  collectNeeds,
  parseScriptIncludeMethods,
  parseSignature,
  fuzzyMatch,
  guessSide,
} = require('../src/lib/completion.js');

const FIELDS = {
  incident: [
    { name: 'short_description', label: 'Short description', type: 'string' },
    { name: 'caller_id', label: 'Caller', type: 'reference', reference: 'sys_user' },
    { name: 'state', label: 'State', type: 'integer' },
    { name: 'active', label: 'Active', type: 'boolean' },
  ],
  problem: [{ name: 'known_error', label: 'Known error', type: 'boolean' }],
  sys_user: [
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'department', label: 'Department', type: 'reference', reference: 'cmn_department' },
  ],
};
const SERVER = { side: 'server', table: 'incident', scoped: false, fields: FIELDS };
const CLIENT = { side: 'client', table: 'incident', fields: FIELDS };

/** Completions with the caret at the end of `text` (or at `|`). */
function complete(text, ctx = SERVER, options) {
  const at = text.indexOf('|');
  const src = at === -1 ? text : text.slice(0, at) + text.slice(at + 1);
  return getCompletions(src, at === -1 ? src.length : at, ctx, options);
}
const labels = (r) => (r ? r.items.map((i) => i.label) : null);

// ---- fuzzy matching and signatures ---------------------------------------------------------

test('fuzzyMatch ranks prefix over word-start over subsequence and rejects mid-word starts', () => {
  const prefix = fuzzyMatch('add', 'addQuery');
  const insensitive = fuzzyMatch('ADD', 'addQuery');
  const boundary = fuzzyMatch('query', 'addQuery');
  const subseq = fuzzyMatch('aeq', 'addEncodedQuery');
  assert.ok(prefix.score > insensitive.score);
  assert.ok(insensitive.score > boundary.score);
  assert.ok(boundary.score > subseq.score);
  assert.deepEqual(subseq.positions, [0, 3, 10]);
  assert.equal(fuzzyMatch('xyz', 'addQuery'), null);
  assert.equal(fuzzyMatch('dq', 'addQuery'), null, 'the first typed character must start a word');
  assert.ok(fuzzyMatch('sdesc', 'short_description'));
  assert.deepEqual(fuzzyMatch('', 'anything'), { score: 0, positions: [] });
});

test('parseSignature splits overloads and parameters, drops a receiver prefix and keeps optional brackets', () => {
  const [two, three] = parseSignature('addQuery(fieldName, value) | addQuery(fieldName, operator, value)');
  assert.equal(two.label, 'addQuery(fieldName, value)');
  assert.deepEqual(three.params.map((p) => p.text), ['fieldName', 'operator', 'value']);
  assert.equal(three.label.slice(three.params[1].start, three.params[1].end), 'operator');
  const [ctor] = parseSignature('new GlideDateTime([dateTimeString | glideDateTime])');
  assert.equal(ctor.params.length, 1, 'a | inside brackets is not an overload separator');
  assert.equal(parseSignature('this.getParameter(name)')[0].name, 'getParameter');
  assert.deepEqual(parseSignature('query()')[0].params, []);
});

// ---- members ------------------------------------------------------------------------------------

test('members of a GlideRecord variable: catalog methods filtered by prefix, plus the table fields', () => {
  const r = complete("var gr = new GlideRecord('incident');\ngr.add");
  assert.equal(r.context, 'member');
  assert.equal(r.items[0].label, 'addQuery');
  assert.ok(labels(r).includes('addEncodedQuery'));
  assert.ok(labels(r).every((l) => /a/i.test(l)));
  const all = complete("var gr = new GlideRecord('incident');\ngr.");
  assert.ok(labels(all).includes('short_description'));
  assert.ok(labels(all).includes('query'));
  assert.equal(all.from, all.to);
  assert.deepEqual(all.needs, []);
});

test('the replace range covers the typed prefix and the rest of the word', () => {
  const src = "var gr = new GlideRecord('incident');\ngr.addQ";
  const r = getCompletions(`${src}uery('a');`, src.length, SERVER);
  assert.equal(r.prefix, 'addQ');
  assert.equal(r.from, src.length - 4);
  assert.equal(r.to, src.length + 4);
});

test('the nearest assignment before the caret decides a variable type', () => {
  const src = "var gr = new GlideRecord('incident');\ngr.query();\ngr = new GlideRecord('problem');\ngr.";
  assert.ok(labels(complete(src)).includes('known_error'));
  const earlier = "var gr = new GlideRecord('incident');\ngr.|\ngr = new GlideRecord('problem');";
  assert.ok(labels(complete(earlier)).includes('short_description'));
});

test('fields that are not loaded yet are requested in needs, and methods still show', () => {
  const r = complete("var gr = new GlideRecord('change_request');\ngr.", SERVER);
  assert.deepEqual(r.needs, [{ type: 'fields', table: 'change_request' }]);
  assert.ok(labels(r).includes('addQuery'));
});

test('current and previous are GlideRecords of the form table on the server only', () => {
  assert.ok(labels(complete('current.')).includes('short_description'));
  assert.ok(labels(complete('previous.sh')).includes('short_description'));
  assert.equal(complete('current.', CLIENT), null);
});

test('client and server APIs are only offered on their own side', () => {
  assert.ok(labels(complete('g_form.setV', CLIENT)).includes('setValue'));
  assert.equal(complete('g_form.', SERVER), null);
  assert.equal(complete('gs.', CLIENT), null);
  assert.ok(labels(complete('gs.get')).includes('getProperty'));
  assert.ok(labels(complete('g_user.', CLIENT)).includes('userName'), 'properties are listed too');
});

test('scope filtering hides methods that do not exist in the script scope', () => {
  const global = labels(complete('gs.', { ...SERVER, scoped: false }));
  const scoped = labels(complete('gs.', { ...SERVER, scoped: true }));
  const unknown = labels(complete('gs.', { ...SERVER, scoped: null }));
  assert.ok(!global.includes('base64Encode') && global.includes('print'));
  assert.ok(scoped.includes('base64Encode') && !scoped.includes('print'));
  assert.ok(unknown.includes('base64Encode') && unknown.includes('print'));
});

test('deprecated methods are flagged and ranked after current ones', () => {
  const r = complete('g_form.getD', CLIENT);
  const box = r.items.find((i) => i.label === 'getDisplayBox');
  assert.ok(box && box.deprecated);
  const decimal = r.items.findIndex((i) => i.label === 'getDecimalValue');
  assert.ok(decimal !== -1 && decimal < r.items.indexOf(box));
});

test('method return types are followed: gs.getUser(), addQuery() conditions, getElement()', () => {
  assert.ok(labels(complete('gs.getUser().')).includes('hasRole'));
  assert.ok(labels(complete('var u = gs.getUser();\nu.has')).includes('hasRole'));
  const qc = complete("var gr = new GlideRecord('incident');\nvar qc = gr.addQuery('active', true);\nqc.");
  assert.ok(labels(qc).includes('addOrCondition'));
  assert.ok(labels(complete("var gr = new GlideRecord('incident');\ngr.getElement('caller_id').")).includes('getRefRecord'));
  assert.ok(labels(complete("new GlideRecord('incident').")).includes('query'));
});

test('dot-walking a reference lists the referenced table fields and GlideElement methods', () => {
  const r = complete('current.caller_id.');
  assert.ok(labels(r).includes('email'));
  assert.ok(labels(r).includes('getDisplayValue'));
  const deeper = complete('current.caller_id.department.');
  assert.deepEqual(deeper.needs, [{ type: 'fields', table: 'cmn_department' }]);
  assert.ok(labels(complete('current.caller_id.getRefRecord().')).includes('email'));
});

test('Script Include instances list their methods once loaded, and ask for them first', () => {
  const first = complete('var u = new MyUtil();\nu.');
  assert.deepEqual(first.needs, [{ type: 'siMethods', name: 'MyUtil' }]);
  assert.deepEqual(first.items, []);
  const ctx = { ...SERVER, siMethods: { MyUtil: { methods: [{ name: 'doThing', params: ['a'], doc: 'Does it.' }, { name: '_private', params: [] }] } } };
  const r = complete('var u = new MyUtil();\nu.', ctx);
  assert.deepEqual(labels(r), ['doThing', '_private']);
  assert.equal(r.items[0].detail, '(a)');
  assert.deepEqual(labels(complete('new global.MyUtil().do', ctx)), ['doThing']);
  assert.equal(complete('var d = new Date();\nd.'), null, 'JavaScript built-ins are not Script Includes');
});

test('this. inside a client-callable Script Include lists its own and AbstractAjaxProcessor methods', () => {
  const src = "var A = Class.create();\nA.prototype = Object.extendsObject(AbstractAjaxProcessor, {\n  run: function(x) {\n    this.|\n  },\n  helper: function() {},\n  type: 'A'\n});";
  const r = complete(src);
  assert.ok(labels(r).includes('run'));
  assert.ok(labels(r).includes('helper'));
  assert.ok(labels(r).includes('getParameter'));
});

test('g_scratchpad lists the properties the script assigns', () => {
  assert.deepEqual(labels(complete('g_scratchpad.isVip = true;\ng_scratchpad.')), ['isVip']);
});

test('chains may continue on a line that starts with a dot, but not after a dangling dot', () => {
  assert.ok(labels(complete("var gr = new GlideRecord('incident');\ngr\n  .addQuery('active', true)\n  .")).includes('addOrCondition'));
  assert.ok(labels(complete('gs.\ng_form.setVa', CLIENT)).includes('setValue'));
});

test('no completion inside comments, regexes, numbers, or after unknown receivers', () => {
  assert.equal(complete('// gr.'), null);
  assert.equal(complete('/* current. */', SERVER), null);
  assert.equal(complete('var x = 1.'), null);
  assert.equal(complete('foo.'), null);
  assert.equal(complete('var re = /current./|g;'), null);
});

// ---- string arguments ------------------------------------------------------------------------

test('field names inside g_form methods and GlideRecord field arguments', () => {
  const r = complete("g_form.setValue('st", CLIENT);
  assert.equal(r.context, 'fields');
  assert.deepEqual(labels(r), ['state', 'short_description']);
  assert.equal(complete("g_form.setValue('state', '", CLIENT), null, 'the value argument is not a field');
  assert.equal(complete("g_form.addInfoMessage('", CLIENT), null);
  assert.deepEqual(labels(complete("var gr = new GlideRecord('incident');\ngr.addQuery('ca")), ['caller_id']);
  assert.deepEqual(labels(complete("var gr = new GlideRecord('incident');\ngr.orderByDesc('sta")), ['state']);
  assert.deepEqual(labels(complete("var ga = new GlideAggregate('incident');\nga.addAggregate('COUNT', 'st")), ['state', 'short_description']);
  assert.equal(complete("var s = 'sta"), null, 'a plain string is not completed');
});

test('field arguments can be dot-walked through references', () => {
  const r = complete("var gr = new GlideRecord('incident');\ngr.addQuery('caller_id.em");
  assert.deepEqual(labels(r), ['email']);
  assert.equal(r.prefix, 'em');
  assert.deepEqual(labels(complete("var gr = new GlideRecord('incident');\ngr.addQuery('caller_id.department.na")), []);
});

test('catalog variables replace dictionary fields for g_form when the form has them', () => {
  const ctx = { ...CLIENT, table: null, formFields: [{ name: 'requested_for', label: 'Requested for' }] };
  assert.deepEqual(labels(complete("g_form.getValue('", ctx)), ['requested_for']);
});

test('encoded queries complete the field of each condition and stop at the operator', () => {
  const head = "var gr = new GlideRecord('incident');\n";
  assert.deepEqual(labels(complete(`${head}gr.addEncodedQuery('act`)), ['active']);
  assert.deepEqual(labels(complete(`${head}gr.addEncodedQuery('active=true^st`)), ['state', 'short_description']);
  assert.deepEqual(labels(complete(`${head}gr.addEncodedQuery('active=true^ORsta`)), ['state']);
  assert.deepEqual(labels(complete(`${head}gr.addEncodedQuery('active=true^ORDERBYDESCsta`)), ['state']);
  assert.deepEqual(labels(complete(`${head}gr.addEncodedQuery('caller_id.em`)), ['email']);
  assert.equal(complete(`${head}gr.addEncodedQuery('active=tr`), null);
  assert.equal(complete(`${head}gr.addEncodedQuery('stateIN1,`), null);
});

test('table names inside new GlideRecord(), from the common list and fetched tables', () => {
  const r = complete("var gr = new GlideRecord('inc", { ...SERVER, tables: [{ name: 'incident_task', label: 'Incident Task' }] });
  assert.equal(r.context, 'tables');
  assert.ok(labels(r).slice(0, 2).includes('incident'));
  assert.ok(labels(r).includes('incident_task'));
  assert.deepEqual(r.needs, [{ type: 'tables', prefix: 'inc' }]);
  const empty = complete("var gr = new GlideRecord('");
  assert.ok(labels(empty).includes('incident') && labels(empty).includes('sys_user'));
  assert.deepEqual(empty.needs, [], 'no fetch for an empty prefix');
  assert.equal(complete("var gr = new GlideRecord('incident', '"), null);
});

test('Script Include names inside new GlideAjax(), client-callable ones only', () => {
  const ctx = {
    ...CLIENT,
    scriptIncludes: [
      { name: 'UserAjax', clientCallable: true },
      { name: 'UserUtils', clientCallable: false },
      { name: 'UserMisc' },
    ],
  };
  const r = complete("var ga = new GlideAjax('User", ctx);
  assert.deepEqual(labels(r).sort(), ['UserAjax', 'UserMisc']);
  assert.deepEqual(r.needs, [{ type: 'scriptIncludes', prefix: 'User' }]);
});

test('GlideAjax sysparm_name completes the methods of the target Script Include', () => {
  const ctx = { ...CLIENT, siMethods: { UserAjax: { methods: [{ name: 'getManager', params: [] }] } } };
  const r = complete("var ga = new GlideAjax('UserAjax');\nga.addParam('sysparm_name', 'get", ctx);
  assert.equal(r.context, 'ajaxMethods');
  assert.deepEqual(labels(r), ['getManager']);
  assert.equal(complete("var ga = new GlideAjax('UserAjax');\nga.addParam('sysparm_value', '", ctx), null);
  const edit = applyCompletion("ga.addParam('sysparm_name', 'get')", { ...r, from: 29, to: 32 }, r.items[0]);
  assert.equal(edit.insert, 'getManager', 'no parentheses inside the string');
});

test('system properties and roles complete inside their string arguments', () => {
  const ctx = { ...SERVER, properties: [{ name: 'glide.servlet.uri', description: 'Instance URL' }], roles: [{ name: 'itil' }, { name: 'admin' }] };
  const props = complete("gs.getProperty('glide.ser", ctx);
  assert.deepEqual(labels(props), ['glide.servlet.uri']);
  assert.deepEqual(props.needs, [{ type: 'properties', prefix: 'glide.ser' }]);
  assert.deepEqual(labels(complete("gs.hasRole('it", ctx)), ['itil']);
  const list = complete("g_user.hasRoleFromList('itil,ad", { ...CLIENT, roles: ctx.roles });
  assert.deepEqual(labels(list), ['admin']);
  assert.equal(list.prefix, 'ad');
});

// ---- new, identifiers, snippets -----------------------------------------------------------------

test('after new: catalog classes for the side, plus Script Includes on the server', () => {
  const server = complete('var x = new Glide', { ...SERVER, scriptIncludes: [{ name: 'GlideHelper' }] });
  assert.equal(server.context, 'new');
  assert.ok(labels(server).includes('GlideRecord'));
  assert.ok(labels(server).includes('GlideHelper'));
  assert.ok(!labels(server).includes('GlideAjax'));
  assert.deepEqual(server.needs, [{ type: 'scriptIncludes', prefix: 'Glide' }]);
  const client = complete('var x = new Glide', CLIENT);
  assert.ok(labels(client).includes('GlideAjax'));
  assert.ok(!labels(client).includes('GlideDateTime'));
});

test('plain identifiers complete only on request: locals, globals, keywords and snippets', () => {
  const src = 'var total = 1;\nfunction helper(count) {}\nto';
  assert.equal(complete(src), null);
  const r = complete(src, SERVER, { explicit: true });
  assert.equal(r.items[0].label, 'total');
  const all = complete('var total = 1;\n|', SERVER, { explicit: true });
  const names = labels(all);
  ['total', 'gs', 'GlideRecord', 'function', 'gr', 'grget'].forEach((n) => assert.ok(names.includes(n), n));
  assert.ok(!names.includes('g_form'));
  const client = labels(complete('get', CLIENT, { explicit: true }));
  assert.ok(client.includes('getMessage'), 'client global functions');
});

test('applyCompletion adds parentheses, keeps an existing one, and fills new GlideRecord with quotes', () => {
  const src = "var gr = new GlideRecord('incident');\ngr.addQ";
  const r = getCompletions(src, src.length, SERVER);
  const edit = applyCompletion(src, r, r.items[0]);
  assert.equal(edit.insert, 'addQuery()');
  assert.equal(edit.caret, r.from + 'addQuery('.length);
  assert.ok(edit.retrigger);
  const noArgs = applyCompletion(src, r, { label: 'query', kind: 'method', params: false });
  assert.equal(noArgs.caret, r.from + 'query()'.length);
  const withParen = `${src}(`;
  const r2 = getCompletions(withParen, src.length, SERVER);
  assert.equal(applyCompletion(withParen, r2, r2.items[0]).insert, 'addQuery');
  const ctor = complete('var gr = new GlideRec');
  const ctorEdit = applyCompletion('var gr = new GlideRec', ctor, ctor.items.find((i) => i.label === 'GlideRecord'));
  assert.equal(ctorEdit.insert, "GlideRecord('')");
  assert.equal(ctorEdit.caret, ctor.from + "GlideRecord('".length);
  assert.ok(ctorEdit.retrigger);
  const field = complete('current.sh');
  assert.equal(applyCompletion('current.sh', field, field.items[0]).insert, 'short_description');
});

test('snippet items keep the line indentation and place the caret at the first blank', () => {
  const src = '  if (x) {\n    gr';
  const r = getCompletions(src, src.length, SERVER, { explicit: true });
  const snippet = r.items.find((i) => i.kind === 'snippet' && i.label === 'gr');
  const edit = applyCompletion(src, r, snippet);
  assert.ok(edit.insert.includes('\n    gr.query();'));
  assert.equal(src.slice(0, r.from) + edit.insert.slice(0, edit.caret - r.from), `${src.slice(0, r.from)}var gr = new GlideRecord('`);
  assert.equal(edit.insert.slice(edit.caret - r.from, edit.caret - r.from + 5), 'table');
});

// ---- Script Include parsing ---------------------------------------------------------------------

test('parseScriptIncludeMethods reads prototype members, docs, parent class and initialize', () => {
  const si = [
    'var MyUtil = Class.create();',
    'MyUtil.prototype = Object.extendsObject(global.AbstractAjaxProcessor, {',
    '  /**',
    '   * Returns the info.',
    '   * @param {string} id',
    '   */',
    '  getInfo: function(/*String*/ id, name) {',
    "    var inner = { nested: function() {} , text: '}, fake: function() {' };",
    '    return inner;',
    '  },',
    '  // Private helper',
    '  _helper: function() {},',
    '  shorthand(a) { return a; },',
    '  initialize: function(a, b) {},',
    "  type: 'MyUtil'",
    '});',
    'MyUtil.prototype.extra = function (z) {};',
  ].join('\n');
  const out = parseScriptIncludeMethods(si);
  assert.equal(out.className, 'MyUtil');
  assert.equal(out.parent, 'AbstractAjaxProcessor');
  assert.ok(out.ajax);
  assert.deepEqual(out.methods.map((m) => m.name), ['getInfo', '_helper', 'shorthand', 'extra']);
  assert.deepEqual(out.methods[0].params, ['id', 'name']);
  assert.equal(out.methods[0].doc, 'Returns the info.');
  assert.equal(out.methods[1].doc, 'Private helper');
  assert.deepEqual(out.initParams, ['a', 'b']);
});

test('parseScriptIncludeMethods handles plain classes, other parents and empty input', () => {
  const plain = parseScriptIncludeMethods("var A = Class.create();\nA.prototype = {\n  initialize: function() {},\n  run: function(x, y) {},\n  type: 'A'\n};");
  assert.deepEqual(plain.methods.map((m) => m.name), ['run']);
  assert.equal(plain.parent, null);
  assert.equal(plain.ajax, false);
  const child = parseScriptIncludeMethods('var B = Class.create();\nB.prototype = Object.extendsObject(A, { more: function() {} });');
  assert.equal(child.parent, 'A');
  assert.deepEqual(parseScriptIncludeMethods('').methods, []);
});

// ---- hover, signature help, definition ---------------------------------------------------------

test('hover shows the catalog signature, return type and notes of a method', () => {
  const src = "var gr = new GlideRecord('incident');\ngr.addQuery('state', 1);";
  const info = getHoverInfo(src, src.indexOf('addQuery') + 3, SERVER);
  assert.equal(info.title, 'GlideRecord.addQuery');
  assert.equal(info.returns, 'GlideQueryCondition');
  assert.match(info.signature, /addQuery\(fieldName, operator, value\)/);
  assert.equal(src.slice(info.from, info.to), 'addQuery');
  const dep = getHoverInfo('g_form.getDisplayBox("x");', 9, CLIENT);
  assert.ok(dep.flags.some((f) => /^Deprecated/.test(f)));
  const scoped = getHoverInfo("gs.base64Encode('x');", 5, SERVER);
  assert.ok(scoped.flags.includes('Scoped applications only'));
});

test('hover on fields, variables, tables and globals; nothing in comments', () => {
  const src = "var gr = new GlideRecord('incident');\ngr.addQuery('caller_id', x);\ngr.caller_id.email;";
  assert.deepEqual(
    { title: getHoverInfo(src, src.indexOf("'caller_id'") + 3, SERVER).title, sig: getHoverInfo(src, src.indexOf("'caller_id'") + 3, SERVER).signature },
    { title: 'incident.caller_id', sig: 'reference, reference to sys_user' }
  );
  assert.equal(getHoverInfo(src, src.lastIndexOf('email') + 1, SERVER).title, 'sys_user.email');
  assert.equal(getHoverInfo(src, src.indexOf('gr.') + 1, SERVER).title, 'gr: GlideRecord (incident)');
  assert.equal(getHoverInfo(src, src.indexOf("'incident'") + 2, SERVER).title, 'Table incident');
  assert.equal(getHoverInfo('gs.info(1);', 0, SERVER).title, 'gs');
  assert.equal(getHoverInfo('// gs.info(1);', 4, SERVER), null);
  assert.equal(getHoverInfo('current.update();', 2, SERVER).title, 'current: GlideRecord (incident)');
  assert.match(getHoverInfo('current.nope;', 9, SERVER).summary, /No field "nope"/);
  assert.equal(getHoverInfo('current.nope;', 9, { ...SERVER, fields: { incident: null } }), null, 'an unreadable dictionary is not an empty one');
});

test('signature help highlights the active parameter and picks the overload that fits', () => {
  const one = getSignatureHelp("g_form.setValue('state', ", 25, CLIENT);
  assert.equal(one.label, 'setValue(fieldName, value, [displayValue])');
  assert.equal(one.active, 1);
  assert.equal(one.label.slice(one.params[1].start, one.params[1].end), 'value');
  const src = "var gr = new GlideRecord('incident');\ngr.addQuery('a', '=', ";
  const over = getSignatureHelp(src, src.length, SERVER);
  assert.equal(over.label, 'addQuery(fieldName, operator, value)');
  assert.equal(over.overloads, 2);
  assert.equal(over.active, 2);
  const inString = "g_form.getValue('sta')";
  assert.equal(getSignatureHelp(inString, 19, CLIENT).active, 0);
  assert.equal(getSignatureHelp('new GlideDateTime(', 18, SERVER).title, 'GlideDateTime');
  const nested = "gr.addQuery('x', gs.getProperty(";
  assert.equal(getSignatureHelp(`var gr = new GlideRecord('incident');\n${nested}`, 38 + nested.length, SERVER).title, 'gs.getProperty');
  assert.equal(getSignatureHelp('foo(1, ', 7, SERVER), null);
  assert.equal(getSignatureHelp('gs.info(1); ', 12, SERVER), null);
  assert.equal(getSignatureHelp('// gs.info(', 11, SERVER), null);
});

test('signature help for Script Include methods and constructors from loaded data', () => {
  const ctx = { ...SERVER, siMethods: { MyUtil: { initParams: ['user'], methods: [{ name: 'run', params: ['a', 'b'], doc: 'Runs.' }] } } };
  const src = 'var u = new MyUtil(x);\nu.run(1, ';
  const help = getSignatureHelp(src, src.length, ctx);
  assert.equal(help.label, 'run(a, b)');
  assert.equal(help.active, 1);
  assert.equal(getSignatureHelp('new MyUtil(', 11, ctx).label, 'MyUtil(user)');
});

test('go to definition targets: local function, field, table, Script Include, property, API', () => {
  const src = [
    'function helper() {}',
    "var gr = new GlideRecord('incident');",
    'gr.short_description = helper();',
    "var u = new MyUtil();",
    "gs.getProperty('my.prop');",
    'gr.query();',
    'SomeName;',
  ].join('\n');
  assert.deepEqual(getDefinitionTarget(src, src.lastIndexOf('helper') + 1, SERVER), { type: 'local', index: 9 });
  assert.deepEqual(getDefinitionTarget(src, src.indexOf('short_') + 2, SERVER), { type: 'field', table: 'incident', name: 'short_description' });
  assert.deepEqual(getDefinitionTarget(src, src.indexOf("'incident'") + 3, SERVER), { type: 'table', name: 'incident' });
  assert.deepEqual(getDefinitionTarget(src, src.indexOf('MyUtil') + 2, SERVER), { type: 'scriptInclude', name: 'MyUtil' });
  assert.deepEqual(getDefinitionTarget(src, src.indexOf('my.prop') + 2, SERVER), { type: 'property', name: 'my.prop' });
  assert.equal(getDefinitionTarget(src, src.indexOf('query()') + 1, SERVER).type, 'api');
  assert.deepEqual(getDefinitionTarget(src, src.indexOf('SomeName') + 1, SERVER), { type: 'name', name: 'SomeName' });
  assert.deepEqual(getDefinitionTarget('current.caller_id.email', 20, SERVER), { type: 'field', table: 'sys_user', name: 'email' });
  assert.deepEqual(getDefinitionTarget("var ga = new GlideAjax('UserAjax');", 26, CLIENT), { type: 'scriptInclude', name: 'UserAjax' });
  assert.deepEqual(getDefinitionTarget("g_form.getValue('state');", 18, CLIENT), { type: 'field', table: 'incident', name: 'state' });
  assert.equal(getDefinitionTarget("g_form.getValue('v1');", 18, { ...CLIENT, formFields: [{ name: 'v1' }] }), null, 'catalog variables have no dictionary entry');
});

test('collectNeeds reports the data a hover or definition is waiting for', () => {
  assert.deepEqual(collectNeeds('current.assignment_group.name', 10, { side: 'server', table: 'task', fields: {} }), [{ type: 'fields', table: 'task' }]);
  assert.deepEqual(collectNeeds('var u = new X();\nu.run();', 20, SERVER), [{ type: 'siMethods', name: 'X' }]);
});

test('guessSide spots client scripts', () => {
  assert.equal(guessSide("g_form.setValue('a', 1);"), 'client');
  assert.equal(guessSide('current.update();'), 'server');
});

test('completion stays fast on a 3000-line script', () => {
  const block = "var gr = new GlideRecord('incident');\ngr.addQuery('active', true); // note (\ngr.query();\nwhile (gr.next()) { gs.info(gr.getValue('number') + '}'); }\n";
  const big = block.repeat(750);
  assert.ok(big.split('\n').length >= 3000);
  const src = `${big}gr.add`;
  const started = Date.now();
  for (let i = 0; i < 20; i += 1) {
    // A new text every time, as when typing.
    const text = `${src}${'d'.repeat(i % 2)}`;
    getCompletions(text, text.length, SERVER);
    getSignatureHelp(text, text.length - 3, SERVER);
  }
  const perKeystroke = (Date.now() - started) / 20;
  assert.ok(perKeystroke < 60, `completion + signature took ${perKeystroke} ms per keystroke`);
});
