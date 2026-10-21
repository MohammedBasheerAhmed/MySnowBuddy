const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/lib/fieldHistory.js');

const ID = '6816f79cc0a8016401c5a33be04be441';
const row = (at, user, from, to) => ({ sys_created_on: at, user, oldvalue: from, newvalue: to });

test('date-times are UTC and durations show the two biggest units', () => {
  assert.equal(H.parseStamp('2026-10-20 12:30:01'), Date.UTC(2026, 9, 20, 12, 30, 1));
  assert.ok(Number.isNaN(H.parseStamp('yesterday')));
  assert.equal(H.formatDuration(45 * 1000), '45 s');
  assert.equal(H.formatDuration(12 * 60 * 1000), '12 min');
  assert.equal(H.formatDuration((3 * 86400 + 4 * 3600 + 5 * 60) * 1000), '3 d 4 h');
  assert.equal(H.formatDuration(2 * 3600 * 1000 + 30 * 1000), '2 h');
  assert.equal(H.formatDuration(NaN), '');
});

test('the audit query is for one field of one record and rejects anything else', () => {
  assert.equal(H.auditQuery('incident', ID.toUpperCase(), 'state'), `tablename=incident^documentkey=${ID}^fieldname=state^ORDERBYsys_created_on`);
  assert.throws(() => H.auditQuery('incident', 'abc', 'state'), /Save the record/);
  assert.throws(() => H.auditQuery('incident', ID, 'state^OR'), /field name/);
  assert.throws(() => H.auditQuery('', ID, 'state'), /Open a record/);
});

test('choice values read as labels, unknown values stay as they are', () => {
  const label = H.labelLookup([{ value: '1', label: 'New' }, { value: '6', label: 'Resolved' }]);
  assert.equal(label('6'), 'Resolved');
  assert.equal(label('9'), '9');
  assert.equal(label(undefined), '');
});

test('a timeline says who, from what to what and how long each value was held', () => {
  const now = Date.UTC(2026, 9, 20, 15, 0, 0);
  const t = H.buildTimeline(
    [
      row('2026-10-20 12:00:00', 'abel.tuter', '1', '2'),
      row('2026-10-20 13:30:00', 'system', '2', '6'),
    ],
    { label: H.labelLookup([{ value: '1', label: 'New' }, { value: '2', label: 'In Progress' }, { value: '6', label: 'Resolved' }]), now },
  );
  assert.deepEqual(t.map((x) => [x.from, x.to, x.user, x.held]), [['New', 'In Progress', 'abel.tuter', '1 h 30 min'], ['In Progress', 'Resolved', 'system', '1 h 30 min']]);
  assert.equal(t[1].held, '1 h 30 min', 'the last value is held until now');
  assert.equal(t[0].automated, false);
  assert.equal(t[1].automated, true);
});

test('rows are put in time order whatever order they arrive in', () => {
  const t = H.buildTimeline([row('2026-10-20 13:00:00', 'b', '2', '3'), row('2026-10-20 12:00:00', 'a', '1', '2')], { now: Date.UTC(2026, 9, 20, 14, 0, 0) });
  assert.deepEqual(t.map((x) => x.to), ['2', '3']);
});

test('a change that goes straight back is flagged, a slow one is not', () => {
  const quick = H.buildTimeline([row('2026-10-20 12:00:00', 'a', '1', '2'), row('2026-10-20 12:02:00', 'rule', '2', '1')]);
  assert.deepEqual(quick.map((x) => x.bounced), [false, true]);
  const slow = H.buildTimeline([row('2026-10-20 12:00:00', 'a', '1', '2'), row('2026-10-20 14:00:00', 'rule', '2', '1')]);
  assert.deepEqual(slow.map((x) => x.bounced), [false, false]);
});

test('the summary counts changes, finds the busiest user and the longest stretch', () => {
  assert.match(H.summarize([], { field: 'state' }), /No audited changes to state.*auditing is off/);
  const t = H.buildTimeline(
    [row('2026-10-20 12:00:00', 'a', '1', '2'), row('2026-10-20 12:01:00', 'rule', '2', '1'), row('2026-10-20 18:00:00', 'a', '1', '2')],
    { now: Date.UTC(2026, 9, 20, 18, 30, 0) },
  );
  const text = H.summarize(t, { field: 'state' });
  assert.match(text, /^state changed 3 times; most by a \(2\)/);
  assert.match(text, /longest stretch: 1 for 5 h 59 min/);
  assert.match(text, /1 change went straight back/);
  assert.match(H.summarize(H.buildTimeline([row('2026-10-20 12:00:00', 'a', '1', '2')]), { field: 'x' }), /^x changed 1 time; all by a/);
});

test('the markdown table and the prompt', () => {
  const t = H.buildTimeline([row('2026-10-20 12:00:00', '', 'a|b', '')], { now: Date.UTC(2026, 9, 20, 12, 1, 0) });
  const md = H.timelineToMarkdown({ table: 'incident', record: 'INC1', field: 'state' }, t);
  assert.match(md, /## incident INC1: history of state/);
  assert.match(md, /\| 2026-10-20 12:00:00 \| \(system\) \| a\\|b \| \(empty\) \| 1 min \|/);
  assert.match(H.historyPrompt({ table: 'incident', record: 'INC1', field: 'state' }, t), /by \(system\): a\|b -> \(empty\)/);
});
