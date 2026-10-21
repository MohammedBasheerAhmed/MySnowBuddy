const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildModel,
  headings,
  pickRows,
  toTsv,
  toMarkdown,
  toJson,
  formatRows,
  describeCopy,
  describeIds,
  sysIdsOf,
  toIdList,
  toJsArray,
  distinctValues,
  planOpen,
  normalizeCell,
} = require('../src/lib/listCopy.js');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);

// Checkbox column, icon column, then three named columns.
const headers = [
  { name: '', text: '' },
  { name: '', text: '' },
  { name: 'number', text: 'Number' },
  { name: 'short_description', text: 'Short description' },
  { name: 'priority', text: 'Priority' },
];
const rows = [
  { sysId: A, selected: false, cells: ['', 'i', 'INC1', 'Laptop\twill\nnot boot', '1 - Critical'] },
  { sysId: B, selected: false, cells: ['', 'i', 'INC2', 'a | b', ''] },
  { sysId: C.toUpperCase(), selected: false, cells: ['', 'i', 'INC3', '"quoted" start', '1 - Critical'] },
];

test('the checkbox and icon columns are skipped, with the cells under them', () => {
  const model = buildModel({ headers, rows });
  assert.deepEqual(model.columns.map((c) => c.name), ['number', 'short_description', 'priority']);
  assert.deepEqual(model.rows[0].cells, ['INC1', 'Laptop will not boot', '1 - Critical']);
  assert.equal(model.rows[2].sysId, C, 'sys_ids are lower-cased');
});

test('cell text is one tidy line: tabs, newlines and no-break spaces collapse', () => {
  assert.equal(normalizeCell('  a\t\tb\n c d  '), 'a b c d');
  assert.equal(normalizeCell(null), '');
});

test('tab-separated output pastes into a sheet: one line per row, quotes protected', () => {
  const model = buildModel({ headers, rows });
  const tsv = toTsv(model.columns, model.rows);
  const lines = tsv.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'Number\tShort description\tPriority');
  assert.equal(lines[1], 'INC1\tLaptop will not boot\t1 - Critical');
  assert.equal(lines[2], 'INC2\ta | b\t', 'an empty last cell stays an empty field');
  assert.equal(lines[3].split('\t')[1], '"""quoted"" start"');
});

test('a Markdown table escapes pipes so a cell cannot break the row', () => {
  const model = buildModel({ headers, rows });
  const md = toMarkdown(model.columns, model.rows).split('\n');
  assert.equal(md[0], '| Number | Short description | Priority |');
  assert.equal(md[1], '| --- | --- | --- |');
  assert.equal(md[3], '| INC2 | a \\| b |  |');
  assert.equal(md.length, 5);
});

test('JSON is keyed by column name and carries the sys_id', () => {
  const model = buildModel({ headers, rows });
  const parsed = JSON.parse(toJson(model.columns, model.rows));
  assert.deepEqual(parsed[0], { sys_id: A, number: 'INC1', short_description: 'Laptop will not boot', priority: '1 - Critical' });
  assert.equal(parsed[1].priority, '');
});

test('two columns with the same label stay distinguishable', () => {
  const columns = [
    { name: 'assigned_to', label: 'Name' },
    { name: 'caller_id', label: 'Name' },
    { name: 'number', label: 'Number' },
    { name: 'x', label: '' },
  ];
  assert.deepEqual(headings(columns), ['Name (assigned_to)', 'Name (caller_id)', 'Number', 'x (x)']);
  const model = buildModel({ headers: [{ name: 'a', text: 'Name' }, { name: 'a', text: 'Name' }], rows: [{ cells: ['1', '2'] }] });
  assert.equal(model.columns.length, 1, 'the same database column twice is one column');
});

test('the ticked rows win; with none ticked every visible row is copied', () => {
  const model = buildModel({ headers, rows });
  assert.equal(pickRows(model).scope, 'visible');
  assert.equal(pickRows(model).rows.length, 3);
  model.rows[1].selected = true;
  const picked = pickRows(model);
  assert.equal(picked.scope, 'selected');
  assert.deepEqual(picked.rows.map((r) => r.cells[0]), ['INC2']);
  const copy = formatRows('json', model);
  assert.equal(copy.rowCount, 1);
  assert.equal(describeCopy(copy), 'Copied 1 selected row x 3 columns');
});

test('the confirmation says what was copied', () => {
  assert.equal(describeCopy({ rowCount: 20, columnCount: 6, scope: 'visible' }), 'Copied 20 rows x 6 columns');
  assert.equal(describeIds(3, 'selected'), 'Copied 3 selected sys_ids');
  assert.equal(describeIds(1, 'visible'), 'Copied 1 sys_id');
});

test('there is nothing to copy from an empty list or a list without named columns', () => {
  assert.equal(formatRows('tsv', buildModel({ headers, rows: [] })), null);
  assert.equal(formatRows('tsv', buildModel({ headers: [{ name: '', text: '' }], rows: [{ cells: ['x'] }] })), null);
});

test('sys_ids come out as a comma list and as a script array, rows without one are left out', () => {
  const model = buildModel({ headers, rows: [...rows, { sysId: 'not-an-id', cells: [] }] });
  const { ids, scope } = sysIdsOf(model);
  assert.equal(scope, 'visible');
  assert.deepEqual(ids, [A, B, C]);
  assert.equal(toIdList(ids), `${A},${B},${C}`);
  assert.equal(toJsArray(ids), `['${A}', '${B}', '${C}']`);
  assert.equal(toJsArray([]), '[]');
});

test('distinct values count by value, most common first, empty cells counted', () => {
  const model = buildModel({ headers, rows });
  const d = distinctValues(model.rows, 2);
  assert.equal(d.total, 3);
  assert.equal(d.distinct, 2);
  assert.deepEqual(d.top.map((t) => [t.value, t.count]), [['1 - Critical', 2], ['(empty)', 1]]);
  const many = Array.from({ length: 14 }, (_, i) => ({ cells: [`v${i}`] }));
  const wide = distinctValues(many, 0, 10);
  assert.equal(wide.top.length, 10);
  assert.equal(wide.more, 4);
});

test('opening rows is capped, de-duplicated, and asks before opening many', () => {
  const ids = Array.from({ length: 12 }, (_, i) => String(i).padStart(32, '0'));
  const plan = planOpen([...ids, ids[0]]);
  assert.equal(plan.open.length, 8);
  assert.equal(plan.skipped, 4);
  assert.equal(plan.needsConfirm, true);
  assert.equal(planOpen(ids.slice(0, 3)).needsConfirm, false);
  assert.equal(planOpen(ids.slice(0, 4)).needsConfirm, true);
  assert.deepEqual(planOpen([]).open, []);
});

test('the Table API URL of a list carries its filter and the columns on screen', () => {
  const { listRestUrl } = require('../src/lib/listCopy.js');
  const url = listRestUrl('https://dev1.service-now.com/', 'incident', 'active=true^priority=1^ORDERBYnumber', { columns: ['number', 'short_description'] });
  assert.equal(url, 'https://dev1.service-now.com/api/now/table/incident?sysparm_query=active%3Dtrue%5Epriority%3D1%5EORDERBYnumber&sysparm_fields=number,short_description,sys_id&sysparm_limit=100');
  assert.equal(listRestUrl('https://x.service-now.com', 'incident', '', {}), 'https://x.service-now.com/api/now/table/incident?sysparm_limit=100', 'no filter, no columns');
  assert.match(listRestUrl('https://x', 'incident', '', { columns: ['caller_id.name', 'bad col!'], displayValue: true, limit: 99999 }), /sysparm_fields=caller_id\.name,sys_id&sysparm_limit=10000&sysparm_display_value=true$/);
  assert.throws(() => listRestUrl('https://x', 'bad table', ''), /no table name/);
});

test('comparing needs exactly two ticked rows', () => {
  const { pickTwo } = require('../src/lib/listCopy.js');
  const row = (sysId, selected) => ({ sysId, selected, cells: [] });
  assert.deepEqual(pickTwo({ rows: [row('a', true), row('b', false), row('c', true)] }), { ids: ['a', 'c'] });
  assert.match(pickTwo({ rows: [row('a', false)] }).error, /Tick the two rows/);
  assert.match(pickTwo({ rows: [row('a', true), row('b', true), row('c', true)] }).error, /3 rows are ticked/);
  assert.match(pickTwo({ rows: [row('', true), row('b', true)] }).error, /Only 1 row is ticked/, 'a row without a sys_id does not count');
});
