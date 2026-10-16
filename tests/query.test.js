const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEncodedQuery, explainQuery, toGlideRecord, toGlideAggregate, conditionsOnly } = require('../src/lib/query.js');

test('parses AND, OR, NQ, sort and group clauses', () => {
  const q = parseEncodedQuery('active=true^priority<=2^ORstate=1^NQnumberSTARTSWITHINC^ORDERBYDESCsys_created_on^GROUPBYcategory');
  assert.equal(q.groups.length, 2);
  assert.deepEqual(q.groups[0].map((c) => [c.field, c.op, c.value, c.or]), [
    ['active', '=', 'true', false],
    ['priority', '<=', '2', false],
    ['state', '=', '1', true],
  ]);
  assert.deepEqual(q.groups[1].map((c) => [c.field, c.op, c.value]), [['number', 'STARTSWITH', 'INC']]);
  assert.deepEqual(q.orderBy, [{ field: 'sys_created_on', desc: true }]);
  assert.deepEqual(q.groupBy, ['category']);
});

test('handles escaped carets, empty operators and NOT IN', () => {
  const q = parseEncodedQuery('short_descriptionLIKEa^^b^assigned_toISEMPTY^stateNOT IN1,2');
  assert.equal(q.groups[0][0].value, 'a^b');
  assert.equal(q.groups[0][1].op, 'ISEMPTY');
  assert.equal(q.groups[0][2].op, 'NOT IN');
});

test('empty query and unparseable tokens', () => {
  assert.deepEqual(parseEncodedQuery('').groups, [[]]);
  assert.equal(parseEncodedQuery('???').raw.length, 1);
});

test('explains a query in plain English', () => {
  const text = explainQuery('active=true^ORstate=1^ORDERBYnumber', { table: 'incident' });
  assert.match(text, /incident records where:/);
  assert.match(text, /active is true/);
  assert.match(text, /OR state is 1/);
  assert.match(text, /Sorted by number ascending/);
  assert.match(explainQuery(''), /no conditions/);
});

test('GlideRecord uses addQuery for simple filters', () => {
  const code = toGlideRecord('incident', 'active=true^priority<=2^short_descriptionLIKEvpn^ORDERBYDESCnumber', { limit: 50 });
  assert.match(code, /new GlideRecord\('incident'\)/);
  assert.match(code, /addQuery\('active', 'true'\)/);
  assert.match(code, /addQuery\('priority', '<=', '2'\)/);
  assert.match(code, /addQuery\('short_description', 'LIKE', 'vpn'\)/);
  assert.match(code, /orderByDesc\('number'\)/);
  assert.match(code, /setLimit\(50\)/);
});

test('GlideRecord falls back to addEncodedQuery for OR and dynamic filters', () => {
  const code = toGlideRecord('incident', 'active=true^ORstate=1^ORDERBYnumber');
  assert.match(code, /addEncodedQuery\('active=true\^ORstate=1'\)/);
  assert.doesNotMatch(code, /addEncodedQuery\([^)]*ORDERBY/);
  assert.match(toGlideRecord('incident', 'assigned_to=javascript:gs.getUserID()'), /addEncodedQuery/);
});

test('quotes are escaped in generated code', () => {
  const code = toGlideRecord('incident', "short_description=it's");
  assert.match(code, /'it\\'s'/);
});

test('rejects invalid table names', () => {
  assert.throws(() => toGlideRecord("x'); evil(", ''));
});

test('GlideAggregate with and without grouping', () => {
  assert.match(toGlideAggregate('incident', 'active=true'), /Count: /);
  const grouped = toGlideAggregate('incident', 'active=true', { groupBy: ['priority'] });
  assert.match(grouped, /groupBy\('priority'\)/);
  assert.match(grouped, /getAggregate\('COUNT'\)/);
});

test('conditionsOnly strips sort and group', () => {
  assert.equal(conditionsOnly('a=1^ORDERBYb^GROUPBYc^d=2'), 'a=1^d=2');
});

test('operators whose names contain IN or ON are not split inside the operator', () => {
  const p = parseEncodedQuery('nameEMPTYSTRING^short_descriptionNOT LIKEemail^sys_updated_onRELATIVEGT@hour@ago@3^priorityGT_FIELDurgency');
  assert.deepEqual(
    p.groups[0].map((c) => [c.field, c.op, c.value]),
    [
      ['name', 'EMPTYSTRING', ''],
      ['short_description', 'NOT LIKE', 'email'],
      ['sys_updated_on', 'RELATIVEGT', '@hour@ago@3'],
      ['priority', 'GT_FIELD', 'urgency'],
    ]
  );
  // Never turned into addQuery('nameEMPTYSTR', 'IN', 'G'); exotic operators round-trip as an encoded query.
  const code = toGlideRecord('incident', 'nameEMPTYSTRING');
  assert.ok(code.includes("addEncodedQuery('nameEMPTYSTRING')") && !code.includes("'IN'"), code);
  assert.ok(explainQuery('nameEMPTYSTRING').includes('name is an empty string'));
  assert.ok(explainQuery('short_descriptionNOT LIKEemail').includes('short_description does not contain email'));
});
