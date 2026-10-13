const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FIND_COMMANDS,
  findCommand,
  buildFindQuery,
  escapeQueryValue,
  normalizeCustomCommand,
  expandTemplate,
  slashHelpRows,
} = require('../src/lib/slashCommands.js');

test('finder verbs and aliases resolve to the same definition', () => {
  assert.equal(findCommand('u').table, 'sys_user');
  assert.equal(findCommand('USER'), findCommand('u'));
  assert.equal(findCommand('sj').table, 'sysauto_script');
  assert.equal(findCommand('nope'), null);
});

test('finder verbs and aliases are unique', () => {
  const all = FIND_COMMANDS.flatMap((d) => [d.verb, ...d.aliases]);
  assert.equal(new Set(all).size, all.length);
});

test('buildFindQuery ORs every search field and escapes carets', () => {
  assert.equal(buildFindQuery(findCommand('inc'), 'vpn'), 'numberLIKEvpn^ORshort_descriptionLIKEvpn^ORDERBYnumber');
  assert.equal(escapeQueryValue('a^b'), 'a^^b');
  assert.equal(buildFindQuery(findCommand('br'), 'x^ORactive=false'), 'nameLIKEx^^ORactive=false^ORDERBYname');
});

test('buildFindQuery with no term sorts by last update', () => {
  assert.equal(buildFindQuery(findCommand('br'), '  '), 'ORDERBYDESCsys_updated_on');
});

test('normalizeCustomCommand rejects reserved names and unsafe targets', () => {
  assert.deepEqual(normalizeCustomCommand({ verb: '/Mine', template: '/incident_list.do?q={q}' }), {
    verb: 'mine',
    template: '/incident_list.do?q={q}',
  });
  assert.throws(() => normalizeCustomCommand({ verb: 'br', template: '/x' }), /built-in/);
  assert.throws(() => normalizeCustomCommand({ verb: 'tn', template: '/x' }), /built-in/);
  assert.throws(() => normalizeCustomCommand({ verb: '1bad', template: '/x' }), /name/);
  assert.throws(() => normalizeCustomCommand({ verb: 'ok', template: 'https://evil.example' }), /root-relative/);
  assert.throws(() => normalizeCustomCommand({ verb: 'ok', template: '//evil.example' }), /root-relative/);
  assert.throws(() => normalizeCustomCommand({ verb: 'ok', template: '/a/../b' }), /root-relative/);
});

test('expandTemplate encodes the typed text', () => {
  assert.equal(expandTemplate('/l.do?sysparm_query=nameLIKE{q}', 'a b^c'), '/l.do?sysparm_query=nameLIKEa%20b%5E%5Ec');
  assert.equal(expandTemplate('/s?x={raw}', 'a&b'), '/s?x=a%26b');
});

test('help rows include custom commands', () => {
  const rows = slashHelpRows([{ verb: 'mine', template: '/x?q={q}', label: 'Mine' }]);
  assert.ok(rows.some(([verb, args]) => verb === 'mine' && args === '<text>'));
  assert.ok(rows.some(([verb]) => verb === 'sa'));
});
