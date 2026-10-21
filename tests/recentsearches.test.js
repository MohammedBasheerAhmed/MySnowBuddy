const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/lib/recentSearches.js');

test('the newest search goes first, and the same search moves up instead of repeating', () => {
  let list = [];
  list = R.rememberSearch(list, { term: 'getUserID' });
  list = R.rememberSearch(list, { term: 'GlideAjax', wholeWord: true });
  list = R.rememberSearch(list, { term: 'getUserID' });
  assert.deepEqual(list.map((e) => e.term), ['getUserID', 'GlideAjax']);
  assert.equal(list[1].wholeWord, true);
});

test('the same term with other options is a different search', () => {
  const list = R.rememberSearch(R.rememberSearch([], { term: 'abc', wholeWord: true }), { term: 'abc', wholeWord: false });
  assert.equal(list.length, 2);
  const tables = R.rememberSearch(R.rememberSearch([], { term: 'abc', tables: ['sys_script', 'sys_ui_action'] }), { term: 'abc', tables: ['sys_ui_action', 'sys_script'] });
  assert.equal(tables.length, 1, 'the order of the tables does not matter');
});

test('the list is capped and a too-short term is not kept', () => {
  let list = [];
  for (let i = 0; i < 12; i += 1) list = R.rememberSearch(list, { term: `search${i}` });
  assert.equal(list.length, R.MAX_SEARCHES);
  assert.equal(list[0].term, 'search11');
  assert.equal(R.rememberSearch(list, { term: 'ab' }), list);
});

test('a damaged stored list is cleaned, not trusted', () => {
  assert.deepEqual(R.cleanSearches('nope'), []);
  const clean = R.cleanSearches([null, { term: 5 }, { term: 'ab' }, { term: 'good', tables: ['a', 3] }, { term: 'x'.repeat(300) }]);
  assert.deepEqual(clean, [{ term: 'good', wholeWord: false, activeOnly: true, tables: ['a'] }]);
});

test('a chip describes its options', () => {
  assert.equal(R.describeSearch({ term: 'x', wholeWord: false, activeOnly: true, tables: [] }), '');
  assert.equal(R.describeSearch({ term: 'x', wholeWord: true, activeOnly: false, tables: ['a', 'b'] }), 'whole word, inactive too, 2 tables');
});
