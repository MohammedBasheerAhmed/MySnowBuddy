const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/lib/recordCompare.js');

const ID = '6816f79cc0a8016401c5a33be04be441';

const row = (fields) => R.flattenRecord(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'string' ? { value: v, display_value: v } : v])));

test('the other record is a sys_id, a number or a name', () => {
  assert.deepEqual(R.parseOther(ID.toUpperCase()), { kind: 'sys_id', value: ID });
  assert.deepEqual(R.parseOther(' inc0010002 '), { kind: 'number', value: 'INC0010002' });
  assert.deepEqual(R.parseOther('Abel Tuter'), { kind: 'name', value: 'Abel Tuter' });
  assert.equal(R.parseOther(''), null);
  assert.equal(R.parseOther('a^ORb=c'), null, 'a caret would start a new condition');
  assert.equal(R.parseOther('x'.repeat(201)), null);
});

test('lookups try one column for a number and several for a name, and recheck what comes back', () => {
  const [byNumber] = R.lookups(R.parseOther('INC0010002'));
  assert.equal(byNumber.query, 'number=INC0010002');
  // ServiceNow returns every row for a column the table does not have, so the match is checked again.
  assert.ok(byNumber.matches({ number: 'inc0010002' }));
  assert.ok(!byNumber.matches({ number: 'INC0010003' }));
  assert.ok(!byNumber.matches({}));

  const byName = R.lookups(R.parseOther('Abel Tuter'));
  assert.deepEqual(byName.map((l) => l.query.split('=')[0]), R.NAME_COLUMNS);
  assert.ok(byName[0].matches({ name: 'abel tuter' }));
  assert.equal(R.lookups(null).length, 0);
});

test('display-value rows become { value, display } and the label prefers number, then name', () => {
  const flat = R.flattenRecord({ caller_id: { value: ID, display_value: 'Abel Tuter' }, short_description: 'Printer', blank: null });
  assert.deepEqual(flat.caller_id, { value: ID, display: 'Abel Tuter' });
  assert.deepEqual(flat.short_description, { value: 'Printer', display: 'Printer' });
  assert.deepEqual(flat.blank, { value: '', display: '' });
  assert.equal(R.recordLabel(row({ number: 'INC1', short_description: 'x' })), 'INC1');
  assert.equal(R.recordLabel(row({ name: 'My Rule' })), 'My Rule');
  assert.equal(R.recordLabel(row({ sys_id: ID }), ''), ID.slice(0, 8));
  assert.equal(R.recordLabel(row({ name: 'n'.repeat(80) })).length, 60);
});

test('fields that differ are listed, equal ones are counted, bookkeeping is hidden', () => {
  const a = row({ sys_id: 'a'.repeat(32), number: 'INC1', state: { value: '2', display_value: 'In Progress' }, priority: '1', short_description: 'Printer', sys_updated_on: '2026-01-01', sys_mod_count: '3' });
  const b = row({ sys_id: 'b'.repeat(32), number: 'INC2', state: { value: '6', display_value: 'Resolved' }, priority: '1', short_description: 'Printer', sys_updated_on: '2026-02-02', sys_mod_count: '9' });
  const r = R.compareRecords(a, b);
  assert.deepEqual(r.changes.map((c) => [c.name, c.before, c.after]), [['state', 'In Progress', 'Resolved']]);
  assert.equal(r.same, 2);
  assert.equal(r.hidden, 4, 'sys_id, number, updated, mod count are bookkeeping');
  const all = R.compareRecords(a, b, { includeSystem: true });
  assert.equal(all.changes.length, 5);
  assert.equal(all.hidden, 0);
});

test('two people with the same display name still differ, because the stored value is compared', () => {
  const a = row({ caller_id: { value: 'u1', display_value: 'Pat Lee' } });
  const b = row({ caller_id: { value: 'u2', display_value: 'Pat Lee' } });
  const r = R.compareRecords(a, b);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].beforeValue, 'u1');
});

test('a field on one side only is a difference from empty, and long values get a line diff', () => {
  const script = 'line one\nline two\nline three';
  const a = row({ script, only_left: 'yes' });
  const b = row({ script: 'line one\nline 2\nline three' });
  const r = R.compareRecords(a, b);
  const names = r.changes.map((c) => c.name);
  assert.deepEqual(names, ['only_left', 'script'], 'short values first, long ones after');
  const onlyLeft = r.changes[0];
  assert.equal(onlyLeft.after, '');
  assert.equal(onlyLeft.long, false);
  const long = r.changes[1];
  assert.equal(long.long, true);
  assert.ok(long.rows.some((x) => x.type === 'removed' && x.value === 'line two'));
  assert.ok(long.rows.some((x) => x.type === 'added' && x.value === 'line 2'));
});

test('the headline, the markdown table and the AI prompt', () => {
  assert.equal(R.compareHeadline({ changes: [], same: 12, hidden: 0 }), 'No differences: all 12 fields are the same.');
  assert.equal(R.compareHeadline({ changes: [{}], same: 1, hidden: 1 }), '1 field differs, 1 is the same (1 bookkeeping field hidden).');
  assert.equal(R.compareHeadline({ changes: [{}, {}], same: 5, hidden: 4 }), '2 fields differ, 5 are the same (4 bookkeeping fields hidden).');

  const result = { changes: [{ name: 'state', before: 'New | open', after: '' }], same: 3, hidden: 0 };
  const md = R.compareToMarkdown({ table: 'incident', left: 'INC1', right: 'INC2' }, result);
  assert.match(md, /## incident: INC1 vs INC2/);
  assert.match(md, /\| state \| New \\\| open \| \(empty\) \|/);
  const prompt = R.comparePrompt({ table: 'incident', left: 'INC1', right: 'INC2' }, result);
  assert.match(prompt, /INC1 behaves as expected/);
  assert.match(prompt, /- state: "New \\\| open" vs "\(empty\)"/);
});
