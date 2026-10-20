const test = require('node:test');
const assert = require('node:assert/strict');
const {
  columnKind,
  suggestColumns,
  parseStats,
  bucketize,
  escapeValue,
  valueCondition,
  andCondition,
  filterForBar,
  countingQuery,
  periodBuckets,
  rangeQuery,
  timeSeries,
  compareValues,
  breakdownMarkdown,
  breakdownCsv,
  seriesMarkdown,
  seriesCsv,
} = require('../src/lib/insight.js');

const F = (name, type, extra = {}) => ({ name, label: name.replace(/_/g, ' '), type, ...extra });

test('only columns worth counting are offered, the usual ones first, dates on their own', () => {
  const fields = [
    F('number', 'string', { maxLength: 40 }),
    F('short_description', 'string', { maxLength: 160 }),
    F('work_notes', 'journal_input'),
    F('script', 'script'),
    F('state', 'integer', { choiceType: '1' }),
    F('priority', 'integer', { choiceType: '1' }),
    F('active', 'boolean'),
    F('assignment_group', 'reference', { reference: 'sys_user_group' }),
    F('caller_id', 'reference', { reference: 'sys_user' }),
    F('contact_type', 'string', { choiceType: '1', maxLength: 40 }),
    F('opened_at', 'glide_date_time'),
    F('closed_at', 'glide_date_time'),
    F('sys_mod_count', 'integer'),
    F('sys_id', 'GUID'),
    F('u_notes', 'string', { maxLength: 4000 }),
    F('location', 'reference', { reference: 'cmn_location' }),
  ];
  const { columns, dates } = suggestColumns(fields);
  const names = columns.map((c) => c.name);
  assert.deepEqual(names.slice(0, 3), ['state', 'priority', 'assignment_group'], 'state, priority and group lead');
  ['number', 'short_description', 'work_notes', 'script', 'sys_mod_count', 'sys_id', 'u_notes'].forEach((n) => assert.ok(!names.includes(n), `${n} is not worth counting`));
  assert.ok(names.includes('active') && names.includes('caller_id') && names.includes('contact_type') && names.includes('location'));
  assert.equal(columns.find((c) => c.name === 'active').kind, 'boolean');
  assert.equal(columns.find((c) => c.name === 'caller_id').reference, 'sys_user');
  assert.deepEqual(dates.map((d) => d.name), ['opened_at', 'closed_at'], 'dates are separate, the usual "opened" one first');
});

test('column kinds', () => {
  assert.equal(columnKind(F('state', 'integer', { choiceType: '1' })), 'choice');
  assert.equal(columnKind(F('x', 'glide_date')), 'date');
  assert.equal(columnKind(F('x', 'password')), '');
  assert.equal(columnKind(F('Bad Name', 'string')), '');
  assert.equal(columnKind(F('sys_class_name', 'sys_class_name')), 'choice');
});

test('Aggregate API answers become rows, with the empty value named', () => {
  const rows = parseStats([
    { stats: { count: '12' }, groupby_fields: [{ field: 'state', value: '1', display_value: 'New' }] },
    { stats: { count: '3' }, groupby_fields: [{ field: 'state', value: '', display_value: '' }] },
    { stats: { count: 'x' }, groupby_fields: [{ field: 'state', value: '9' }] },
    { stats: { count: '5' } },
  ]);
  assert.deepEqual(rows, [{ value: '1', label: 'New', count: 12 }, { value: '', label: '(empty)', count: 3 }]);
  assert.deepEqual(parseStats({ stats: { count: '2' }, groupby_fields: [{ field: 'a', value: 'b', display_value: 'B' }] }), [{ value: 'b', label: 'B', count: 2 }], 'a single object works too');
  assert.deepEqual(parseStats(undefined), []);
});

test('bars: top N plus Other, shares add up, widths are relative to the longest', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ value: `v${i}`, label: `Value ${i}`, count: 20 - i }));
  const { bars, total, distinct } = bucketize(rows, 5);
  assert.equal(bars.length, 6);
  assert.equal(total, 210);
  assert.equal(distinct, 20);
  assert.equal(bars[0].label, 'Value 0');
  assert.equal(bars[5].bar, 100, 'the Other bar is the longest here, so it sets the scale: widths stay honest');
  assert.equal(bars[0].bar, 17);
  assert.equal(bars[5].other, true);
  assert.match(bars[5].label, /Other \(15 more values\)/);
  assert.equal(bars[5].count, 210 - (20 + 19 + 18 + 17 + 16));
  assert.equal(Math.round(bars.reduce((s, b) => s + b.share, 0)), 100);
  assert.deepEqual(bucketize([{ value: 'a', label: 'A', count: 0 }]).bars, [], 'zero counts are dropped');
  assert.deepEqual(bucketize([]).bars, []);
});

test('a bar becomes "list filter AND column = value", carets escaped, ordering kept last', () => {
  assert.equal(valueCondition('state', '2'), 'state=2');
  assert.equal(valueCondition('state', ''), 'stateISEMPTY');
  assert.equal(valueCondition('short_description', 'a^b'), 'short_description=a^^b');
  assert.equal(escapeValue('x^y^^z'), 'x^^y^^^^z');
  assert.throws(() => valueCondition('a b', '1'), /not a column name/);
  assert.equal(filterForBar('active=true', 'priority', '1'), 'active=true^priority=1');
  assert.equal(filterForBar('', 'priority', '1'), 'priority=1');
  assert.equal(filterForBar('active=true^ORDERBYDESCopened_at', 'priority', '1'), 'active=true^priority=1^ORDERBYDESCopened_at');
  assert.equal(filterForBar('a=1^ORb=2', 'c', 'x'), 'a=1^ORb=2^c=x', 'AND applies to the whole OR group');
  assert.equal(filterForBar('a=1^NQb=2', 'c', 'x'), 'a=1^c=x^NQb=2^c=x', 'every NQ group gets the condition');
  assert.equal(filterForBar('short_descriptionLIKEa^^b', 'c', 'x'), 'short_descriptionLIKEa^^b^c=x', 'an escaped caret in the filter survives');
});

test('counting drops sort and group clauses', () => {
  assert.equal(countingQuery('active=true^ORDERBYname^GROUPBYstate'), 'active=true');
  assert.equal(countingQuery(''), '');
  assert.equal(countingQuery('a=b^^c^ORDERBYx'), 'a=b^^c');
});

test('periods: days, Monday weeks and months end with the current one and carry filter-builder dates', () => {
  const now = new Date(2026, 9, 20, 15, 0, 0); // Tue 20 Oct 2026
  const days = periodBuckets('day', 3, now);
  assert.deepEqual(days.map((d) => d.label), ['Oct 18', 'Oct 19', 'Oct 20']);
  assert.equal(days[2].from, '2026-10-20 00:00:00');
  assert.equal(days[2].to, '2026-10-20 23:59:59');
  const weeks = periodBuckets('week', 2, now);
  assert.equal(weeks[1].from, '2026-10-19 00:00:00', 'the week of Tuesday Oct 20 starts Monday Oct 19');
  assert.equal(weeks[1].to, '2026-10-25 23:59:59');
  assert.equal(weeks[0].from, '2026-10-12 00:00:00');
  const months = periodBuckets('month', 3, now);
  assert.deepEqual(months.map((m) => m.label), ['Aug 26', 'Sep 26', 'Oct 26']);
  assert.equal(months[1].to, '2026-09-30 23:59:59');
  assert.equal(periodBuckets('month', 2, new Date(2026, 0, 15))[0].from, '2025-12-01 00:00:00', 'across a year boundary');
  assert.equal(periodBuckets('day', 999, now).length, 31, 'capped');
  assert.throws(() => periodBuckets('hour'), /Unknown period/);
});

test('a period becomes a pair of date conditions on the list filter', () => {
  const [bucket] = periodBuckets('day', 1, new Date(2026, 9, 20));
  assert.equal(rangeQuery('active=true', 'opened_at', bucket), 'active=true^opened_at>=2026-10-20 00:00:00^opened_at<=2026-10-20 23:59:59');
  assert.throws(() => rangeQuery('', 'bad col', bucket));
});

test('time series: heights, average and the busiest period', () => {
  const s = timeSeries([{ label: 'a', count: 2 }, { label: 'b', count: 8 }, { label: 'c', count: 0 }, { label: 'd', count: 1 }]);
  assert.equal(s.total, 11);
  assert.equal(s.average, 2.8);
  assert.deepEqual(s.peak, { label: 'b', count: 8 });
  assert.deepEqual(s.points.map((p) => p.height), [25, 100, 0, 13]);
  assert.ok(timeSeries([{ label: 'x', count: 1 }, { label: 'y', count: 1000 }]).points[0].height >= 4, 'a non-zero period always has a visible bar');
  assert.equal(timeSeries([{ label: 'a', count: 0 }]).peak, null);
  assert.deepEqual(timeSeries([]).points, []);
});

test('comparing two values says it in words', () => {
  const a = { label: 'P1', count: 30 };
  const b = { label: 'P2', count: 10 };
  const r = compareValues(a, b, 100);
  assert.equal(r.difference, 20);
  assert.equal(r.ratio, 3);
  assert.match(r.text, /P1: 30 \(30%\); P2: 10 \(10%\)\. P1 has 20 more, 3x as many as P2\./);
  assert.match(compareValues(b, a).text, /P1 has 20 more, 3x as many as P2\./.source ? /P1 has 20 more/ : /x/);
  assert.match(compareValues({ label: 'A', count: 4 }, { label: 'B', count: 4 }).text, /equal/);
  assert.match(compareValues({ label: 'A', count: 4 }, { label: 'B', count: 0 }).text, /A has 4 more/);
  assert.equal(compareValues(null, b), null);
});

test('Markdown and CSV', () => {
  const bars = [{ label: 'New | open', count: 5, share: 62.5 }, { label: 'He said "hi", ok', count: 3, share: 37.5 }];
  const md = breakdownMarkdown({ table: 'incident', column: 'state', query: 'active=true', bars, total: 8 });
  assert.match(md, /### incident by state \(8 records\)/);
  assert.match(md, /Filter: `active=true`/);
  assert.match(md, /\| New \\\| open \| 5 \| 62.5% \|/);
  const csv = breakdownCsv({ bars });
  assert.equal(csv.split('\r\n')[2], '"He said ""hi"", ok",3,37.5');
  const points = [{ label: 'Oct 19', count: 4 }, { label: 'Oct 20', count: 7 }];
  assert.match(seriesMarkdown({ table: 'incident', column: 'opened_at', unit: 'day', points }), /\| Oct 20 \| 7 \|/);
  assert.equal(seriesCsv({ points }), 'Period,Count\r\nOct 19,4\r\nOct 20,7');
});
