const test = require('node:test');
const assert = require('node:assert/strict');
const { toCsv, toMarkdownTable, toJson, sysIdList, flattenValue } = require('../src/lib/export.js');
const { parseVersionPayload, changedFields } = require('../src/lib/versionPayload.js');
const { crc32, createZip } = require('../src/lib/zip.js');
const { buildScopeFiles, safeFileName, SCOPE_ARTIFACTS } = require('../src/lib/scopeExport.js');
const { resolveTarget, parseTablePage, extractListFromUrl } = require('../src/lib/urlTarget.js');
const { pushHistory } = require('../src/lib/scriptHistory.js');

test('flattenValue prefers display values', () => {
  assert.equal(flattenValue({ value: 'abc', display_value: 'Alice' }), 'Alice');
  assert.equal(flattenValue({ value: 'abc', display_value: '' }), 'abc');
  assert.equal(flattenValue(null), '');
});

test('CSV quotes cells and neutralises formulas', () => {
  const rows = [{ a: 'x,y', b: '=HYPERLINK("evil")', c: '-5', d: 'say "hi"\nnow' }];
  const csv = toCsv(rows, ['a', 'b', 'c', 'd']);
  const [, line] = csv.split('\r\n');
  assert.ok(line.startsWith('"x,y",'));
  assert.ok(line.includes(`'=HYPERLINK`));
  assert.ok(line.includes(',-5,'));
  assert.ok(line.includes('"say ""hi""\nnow"'));
});

test('markdown table escapes pipes and newlines', () => {
  const md = toMarkdownTable([{ a: 'x|y', b: 'l1\nl2' }], ['a', 'b']);
  assert.equal(md.split('\n')[2], '| x\\|y | l1<br>l2 |');
});

test('JSON export and sys_id list', () => {
  const rows = [{ sys_id: { value: 'id1', display_value: 'id1' }, n: 'a' }, { sys_id: 'id2', n: 'b' }];
  assert.deepEqual(JSON.parse(toJson(rows, ['n'])), [{ n: 'a' }, { n: 'b' }]);
  assert.deepEqual(sysIdList(rows), ['id1', 'id2']);
});

test('version payload parsing handles CDATA and entities', () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE">' +
    '<name>MyUtil</name><script><![CDATA[var a = 1 < 2;]]></script><description>a &amp; b &lt; c</description><empty/></sys_script_include></record_update>';
  const p = parseVersionPayload(xml);
  assert.equal(p.table, 'sys_script_include');
  assert.equal(p.action, 'INSERT_OR_UPDATE');
  assert.equal(p.fields.name, 'MyUtil');
  assert.equal(p.fields.script, 'var a = 1 < 2;');
  assert.equal(p.fields.description, 'a & b < c');
  assert.equal(p.fields.empty, '');
  assert.equal(parseVersionPayload('garbage').table, '');
});

test('changedFields reports only differences', () => {
  const diff = changedFields({ a: '1', b: '2' }, { a: '1', b: '3', c: 'x' });
  assert.deepEqual(diff.map((d) => d.name), ['b', 'c']);
});

test('crc32 known vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip has valid structure', () => {
  const zip = createZip([
    { path: 'a/one.txt', content: 'hello' },
    { path: 'b.txt', content: 'world' },
  ]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const eocd = zip.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  assert.equal(view.getUint16(eocd + 10, true), 2);
  const centralOffset = view.getUint32(eocd + 16, true);
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50);
});

test('safeFileName cleans names', () => {
  assert.equal(safeFileName('a/b:c'), 'a_b_c');
  assert.equal(safeFileName('..'), 'unnamed');
  assert.equal(safeFileName('CON'), '_CON');
});

test('scope export lays out scripts and metadata', () => {
  const si = SCOPE_ARTIFACTS.find((d) => d.table === 'sys_script_include');
  const widget = SCOPE_ARTIFACTS.find((d) => d.table === 'sp_widget');
  const files = buildScopeFiles('x_my_app', [
    {
      def: si,
      records: [
        { sys_id: 'aaaaaaaa11', name: 'Util', script: 'a\r\nb', active: 'true' },
        { sys_id: 'bbbbbbbb22', name: 'util', script: 'c', active: 'true' },
      ],
    },
    { def: widget, records: [{ sys_id: 'cccccccc33', name: 'Card', template: '<p/>', script: '', css: '.a{}' }] },
  ]);
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes('x_my_app/script_includes/Util.js'));
  assert.ok(paths.includes('x_my_app/script_includes/util__bbbbbbbb.js'));
  assert.ok(paths.includes('x_my_app/widgets/Card.template.html'));
  assert.ok(paths.includes('x_my_app/widgets/Card.css.css'));
  assert.ok(!paths.some((p) => p.includes('Card.script')));
  assert.equal(files.find((f) => f.path.endsWith('Util.js')).content, 'a\nb\n');
});

test('urlTarget unwraps classic and Next Experience URLs', () => {
  const classic = 'https://dev1.service-now.com/nav_to.do?uri=incident.do%3Fsys_id%3Dabc123';
  assert.deepEqual(parseTablePage(classic), { table: 'incident', sysId: 'abc123', isList: false });
  const next = 'https://dev1.service-now.com/now/nav/ui/classic/params/target/incident_list.do%3Fsysparm_query%3Dactive%253Dtrue';
  assert.deepEqual(extractListFromUrl(next), { table: 'incident', query: 'active=true' });
  assert.equal(parseTablePage('https://x.service-now.com/incident.do?sys_id=-1').sysId, null);
  assert.equal(extractListFromUrl('https://x.service-now.com/incident.do?sys_id=abc'), null);
  assert.equal(resolveTarget('not a url'), null);
});

test('script history dedupes and caps', () => {
  let list = [];
  list = pushHistory(list, { script: 'a', ts: 1 });
  list = pushHistory(list, { script: 'b', ts: 2 });
  list = pushHistory(list, { script: 'a', ts: 3 });
  assert.deepEqual(list.map((e) => e.script), ['a', 'b']);
  assert.equal(pushHistory(list, { script: '   ' }).length, 2);
  for (let i = 0; i < 50; i += 1) list = pushHistory(list, { script: `s${i}` }, 5);
  assert.equal(list.length, 5);
});
