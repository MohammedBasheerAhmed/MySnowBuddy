const test = require('node:test');
const assert = require('node:assert/strict');
const { declaredMembers, diffApi, selfCalls, callersOf, wordAt, referenceTarget, classifyReference, referenceLines } = require('../src/lib/scriptApi.js');

const SI = `var UserUtils = Class.create();
UserUtils.prototype = {
    initialize: function () {
        this.cache = {};
    },

    getManager: function (userId, includeInactive) {
        // getOldThing: function (x) {} is only a comment
        return this._lookup(userId);
    },

    'getEmail': function (userId) {
        return this._lookup(userId).email;
    },

    _lookup: function (id) {
        function helper(a) { return a; }
        return helper(id);
    },

    type: 'UserUtils'
};`;

test('declared members: methods with parameters, no helpers, no comments, no framework noise', () => {
  const names = declaredMembers(SI).map((m) => m.name);
  assert.deepEqual(names, ['initialize', 'getManager', 'getEmail', '_lookup']);
  assert.deepEqual(declaredMembers(SI).find((m) => m.name === 'getManager').params, ['userId', 'includeInactive']);
  assert.equal(declaredMembers(SI).find((m) => m.name === 'getManager').line, 7);
});

test('declared members: prototype assignments and shorthand methods', () => {
  const src = `Foo.prototype.run = function (a, b = 2) { return a; };\nvar o = { stop(x) { if (x) { return 1; } } };`;
  const members = declaredMembers(src);
  assert.deepEqual(members.map((m) => [m.name, m.params]), [['run', ['a', 'b']], ['stop', ['x']]]);
});

test('diff: a removed method is breaking, a new one is not', () => {
  const after = SI.replace("'getEmail': function (userId) {\n        return this._lookup(userId).email;\n    },\n", '').replace('type:', 'getName: function (userId, extra) { return 1; },\n    type:');
  const d = diffApi(SI, after);
  assert.deepEqual(d.breaking.map((b) => [b.kind, b.name]), [['removed', 'getEmail']]);
  assert.deepEqual(d.added, ['getName']);
});

test('diff: a removed method with the same parameters and one new method is reported as a rename', () => {
  const after = SI.replace('getEmail', 'getMail');
  const d = diffApi(SI, after);
  assert.equal(d.breaking.length, 1);
  assert.equal(d.breaking[0].renamedTo, 'getMail');
  assert.deepEqual(d.added, []);
});

test('diff: fewer parameters and reordered parameters are breaking, appended ones are not', () => {
  assert.deepEqual(diffApi(SI, SI.replace('userId, includeInactive', 'userId')).breaking.map((b) => b.kind), ['fewer']);
  assert.deepEqual(diffApi(SI, SI.replace('userId, includeInactive', 'includeInactive, userId')).breaking.map((b) => b.kind), ['reordered']);
  assert.deepEqual(diffApi(SI, SI.replace('userId, includeInactive', 'userId, includeInactive, limit')).breaking, []);
  assert.deepEqual(diffApi(SI, SI.replace('userId, includeInactive', 'id, inactive')).breaking, [], 'renaming a parameter changes nothing for callers');
});

test('diff: initialize and type are never reported', () => {
  const after = SI.replace(/initialize: function \(\) \{[^}]*\},\n/, '');
  assert.deepEqual(diffApi(SI, after).breaking, []);
});

test('diff: an identical script and an empty script', () => {
  assert.deepEqual(diffApi(SI, SI), { breaking: [], added: [] });
  assert.deepEqual(diffApi('', ''), { breaking: [], added: [] });
  assert.deepEqual(diffApi(null, undefined), { breaking: [], added: [] });
});

test('self calls: this.x() for a removed method, with its line', () => {
  assert.deepEqual(selfCalls(SI, ['_lookup']), [{ name: '_lookup', line: 9 }, { name: '_lookup', line: 13 }]);
  assert.deepEqual(selfCalls(SI, []), []);
  assert.deepEqual(selfCalls('// this.gone()\nvar x = 1;', ['gone']), [], 'comments do not count');
});

test('callers: new X().m(), var x = new X(); x.m(), X.m() and GlideAjax are all found', () => {
  assert.deepEqual(callersOf('var m = new UserUtils().getManager(id);', 'UserUtils', ['getManager']).methods, ['getManager']);
  assert.deepEqual(callersOf('var u = new global.UserUtils();\nvar e = u.getEmail(id);', 'UserUtils', ['getEmail']).lines, [2]);
  assert.deepEqual(callersOf('Helper.parse(x);', 'Helper', ['parse']).methods, ['parse']);
  const ajax = callersOf("var ga = new GlideAjax('UserUtils');\nga.addParam('sysparm_name', 'getEmail');", 'UserUtils', ['getEmail']);
  assert.equal(ajax.via, 'GlideAjax');
});

test('callers: other classes, other methods and comments are not callers', () => {
  assert.equal(callersOf('new Other().getEmail(id);', 'UserUtils', ['getEmail']), null);
  assert.equal(callersOf('new UserUtils().getManager(id);', 'UserUtils', ['getEmail']), null);
  assert.equal(callersOf('// new UserUtils().getEmail(id);', 'UserUtils', ['getEmail']), null);
  assert.equal(callersOf('', 'UserUtils', ['x']), null);
});

test('callers: with no method list, any use of the class counts', () => {
  assert.equal(callersOf('var u = new UserUtils();', 'UserUtils').uses, true);
  assert.equal(callersOf('var u = new Nope();', 'UserUtils'), null);
});

test('word at: caret in, at the end of, and outside a word', () => {
  assert.equal(wordAt('foo.barBaz(1)', 6).word, 'barBaz');
  assert.equal(wordAt('foo.barBaz(1)', 10).word, 'barBaz', 'caret just after the word');
  assert.equal(wordAt('a + 12', 5), null, 'numbers are not names');
  assert.equal(wordAt('   ', 1), null);
  assert.equal(wordAt('', 0), null);
});

test('target: Class.method, new Class().method and an assigned variable', () => {
  const t = (src, marker, ctx) => referenceTarget(src.replace('|', ''), src.indexOf('|'), ctx);
  assert.deepEqual(t('UserUtils.get|Manager(1)'), { kind: 'method', name: 'getManager', className: 'UserUtils' });
  assert.deepEqual(t('new UserUtils().get|Email(1)'), { kind: 'method', name: 'getEmail', className: 'UserUtils' });
  assert.deepEqual(t('var u = new global.UserUtils();\nu.get|Email(1)'), { kind: 'method', name: 'getEmail', className: 'UserUtils' });
});

test('target: inside a Script Include, this.x and its own declarations belong to its class', () => {
  const ctx = { table: 'sys_script_include', ownName: 'UserUtils' };
  assert.deepEqual(referenceTarget('this._lookup(1)', 8, ctx), { kind: 'method', name: '_lookup', className: 'UserUtils' });
  const at = SI.indexOf('getManager');
  assert.deepEqual(referenceTarget(SI, at + 2, ctx), { kind: 'method', name: 'getManager', className: 'UserUtils' });
  assert.deepEqual(referenceTarget(SI, SI.indexOf('UserUtils') + 2, ctx), { kind: 'class', name: 'UserUtils' });
});

test('target: a capitalised name is a class, other words are text, short words and keywords are nothing', () => {
  assert.deepEqual(referenceTarget('new Foo()', 6), { kind: 'class', name: 'Foo' });
  assert.deepEqual(referenceTarget('var incident_state = 1;', 6), { kind: 'text', name: 'incident_state' });
  assert.equal(referenceTarget('var i = 1;', 4), null);
  assert.equal(referenceTarget('if (x) {}', 1), null);
  assert.equal(referenceTarget('MAX_ROWS', 2).kind, 'text', 'CONSTANTS are not classes');
});

test('classify: confirmed call, maybe, and not a use', () => {
  const method = { kind: 'method', name: 'getEmail', className: 'UserUtils' };
  assert.equal(classifyReference('var u = new UserUtils(); u.getEmail(1);', method), 'call');
  assert.equal(classifyReference('obj.getEmail(1);', method), 'maybe');
  assert.equal(classifyReference('// u.getEmail(1)\nvar x = 1;', method), null);
  assert.equal(classifyReference('var s = "getEmail";', method), null);
  const cls = { kind: 'class', name: 'UserUtils' };
  assert.equal(classifyReference('new UserUtils().a();', cls), 'call');
  assert.equal(classifyReference("gs.info('UserUtils');", cls), 'maybe');
  assert.equal(classifyReference('var x = 1;', cls), null);
  assert.equal(classifyReference('anything', null), null);
});

test('reference lines skip comments and clip long lines', () => {
  const src = `// getEmail is called below\nvar a = u.getEmail(1);\n/* getEmail */\n${'x'.repeat(200)} getEmail()`;
  const lines = referenceLines(src, { kind: 'method', name: 'getEmail', className: 'U' });
  assert.deepEqual(lines.map((l) => l.line), [2, 4]);
  assert.ok(lines[1].text.length <= 160);
});

test('the save dialog names every broken method, caller and self call', () => {
  const { breakingChangeAsk } = require('../src/lib/confirmCopy.js');
  const ask = breakingChangeAsk({
    className: 'UserUtils',
    issues: [{ kind: 'removed', name: 'getEmail', before: ['id'], renamedTo: 'getMail' }, { kind: 'fewer', name: 'getManager', before: ['a', 'b'], after: ['a'] }],
    callers: [{ label: 'Business Rule', name: 'Set manager', methods: ['getEmail'], lines: [4] }],
    moreCallers: 2,
    selfLines: [{ name: 'getEmail', line: 12 }],
  });
  assert.equal(ask.title, 'Saving this breaks 3 callers');
  assert.match(ask.message, /UserUtils\.getEmail is removed \(renamed to getMail\?\)/);
  assert.match(ask.message, /UserUtils\.getManager takes fewer parameters/);
  assert.match(ask.message, /Business Rule: Set manager calls getEmail \(line 4\)/);
  assert.match(ask.message, /and 2 more/);
  assert.match(ask.message, /this\.getEmail\(\) itself \(line 12\)/);
  assert.equal(ask.confirmLabel, 'Save anyway');
  assert.equal(ask.danger, true);
});

test('the save dialog for a renamed class, and for a script that only calls itself', () => {
  const { breakingChangeAsk } = require('../src/lib/confirmCopy.js');
  const renamed = breakingChangeAsk({ className: 'UserUtils', renamedTo: 'UserHelper', callers: [{ label: 'Client Script', name: 'x', methods: [] }] });
  assert.match(renamed.message, /the class UserUtils is renamed to UserHelper/);
  assert.match(renamed.message, /uses the class/);
  assert.equal(renamed.title, 'Saving this breaks 1 caller');
  const own = breakingChangeAsk({ className: 'A', issues: [{ kind: 'removed', name: 'go', before: [] }], selfLines: [{ name: 'go', line: 3 }] });
  assert.equal(own.title, 'Saving this removes methods the script still calls');
});

test('a table is used when a script names it in quotes, not when the word only appears in a comment', () => {
  const { classifyReference } = require('../src/lib/scriptApi.js');
  const target = { kind: 'table', name: 'incident' };
  assert.equal(classifyReference("var gr = new GlideRecord('incident');", target), 'call');
  assert.equal(classifyReference('if (current.getTableName() == "incident") {}', target), 'call');
  assert.equal(classifyReference("// new GlideRecord('incident')\nvar x = 1;", target), null);
  assert.equal(classifyReference("var gr = new GlideRecord('incident_task');", target), null, 'a longer name is another table');
  assert.equal(classifyReference('var incident = 1;', target), null);
});
