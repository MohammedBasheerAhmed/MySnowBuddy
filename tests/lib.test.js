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

// ---- regressions from the full-repo bug hunt (libraries) -------------------------------

test('verify: catalog variables, aggregate counts and varied secret names', () => {
  const { verifyScript } = require('../src/lib/verify.js');
  const bad = (r) => r.findings.filter((f) => f.severity === 'high' || f.severity === 'error');
  const br = verifyScript({ kind: 'business_rule', when: 'before', table: 'sc_req_item', fields: ['number', 'short_description'], code: 'var v = current.variables.u_foo;' });
  assert.ok(!br.findings.some((f) => /variables/.test(f.message)), 'current.variables is not a dictionary field');
  const agg = verifyScript({ kind: 'background_script', code: "var ga = new GlideAggregate('incident'); ga.addAggregate('COUNT'); ga.query(); if (ga.next()) gs.info(ga.getAggregate('COUNT'));" });
  assert.ok(!agg.findings.some((f) => f.ruleId === 'no-unbounded-query'), 'whole-table COUNT is the cheap pattern');
  for (const code of ["var client_secret = 'abcd1234';", "var accessToken = 'abcd1234';", '{"password": "hunter22"}']) {
    assert.ok(verifyScript({ kind: 'background_script', code }).findings.some((f) => f.ruleId === 'no-embedded-credentials'), code);
  }
  assert.ok(bad(verifyScript({ kind: 'background_script', code: "var gr = new GlideRecord('incident'); gr.query();" })).some((f) => f.ruleId === 'no-unbounded-query'), 'the real unbounded case is still caught');
});

test('conditionsOnly keeps the ^^ escape', () => {
  const { conditionsOnly } = require('../src/lib/query.js');
  assert.equal(conditionsOnly('short_description=a^^b^ORcaller_id=1^ORDERBYnumber'), 'short_description=a^^b^ORcaller_id=1');
});

test('simulator stops when a callback keeps scheduling itself', async () => {
  const { runClientScript } = require('../src/lib/mockForm.js');
  const run = await Promise.race([
    runClientScript({ script: "function onChange(){ g_form.getReference('caller_id', function cb(){ g_form.getReference('caller_id', cb); }); }", type: 'onChange', scenario: { fields: { caller_id: { value: 'x' } } } }),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 3000)),
  ]);
  assert.notEqual(run, 'HUNG');
});

// ---- simulator fidelity (regressions from the bug hunt) ---------------------------------

const sim = (code, clientType, scenario) => require('../src/lib/mockForm.js').runClientScript({ code, clientType, scenario });

test('simulator: GlideAjax responseText is XML, getAnswer follows getXMLWait', async () => {
  const jsonParse = await sim(
    `function onChange(){ var ga = new GlideAjax('U'); ga.addParam('sysparm_name','m'); ga.getXML(function(r){ var o = JSON.parse(r.responseText); g_form.setValue('f', o.x); }); }`,
    'onChange',
    { fields: { f: { value: '' } }, ajax: { 'U.m': { x: '1' } } }
  );
  assert.equal(jsonParse.ok, false, 'JSON.parse on the XML string fails on a real form, so it must fail here');
  const viaAttr = await sim(
    `function onChange(){ var ga = new GlideAjax('U'); ga.addParam('sysparm_name','m'); ga.getXML(function(r){ g_form.setValue('f', r.responseXML.documentElement.getAttribute('answer')); }); }`,
    'onChange',
    { fields: { f: { value: '' } }, ajax: { 'U.m': 'hello' } }
  );
  assert.equal(viaAttr.finalFields.f.value, 'hello');
  const wait = await sim(
    `function onLoad(){ var ga = new GlideAjax('U'); ga.addParam('sysparm_name','m'); ga.getXMLWait(); g_form.setValue('f', ga.getAnswer()); }`,
    'onLoad',
    { fields: { f: { value: '' } }, ajax: { 'U.m': 'sync' } }
  );
  assert.equal(wait.finalFields.f.value, 'sync');
});

test('simulator: client GlideRecord honours operators, re-queries, exposes columns', async () => {
  const records = { sys_user: [{ name: 'A', active: 'true' }, { name: 'B', active: 'false' }] };
  const op = await sim(`function onLoad(){ var gr = new GlideRecord('sys_user'); gr.addQuery('active','!=','true'); gr.query(); while (gr.next()) g_form.addInfoMessage(gr.name); }`, 'onLoad', { records });
  assert.deepEqual(op.messages.map((m) => m.text), ['B'], 'operator respected and gr.name works');
  const twice = await sim(`function onLoad(){ var gr = new GlideRecord('sys_user'); gr.query(); var n=0; while(gr.next()) n++; gr.query(); while(gr.next()) n++; g_form.addInfoMessage(String(n)); }`, 'onLoad', { records });
  assert.equal(twice.messages[0].text, '4', 'a second query() starts over');
  const get = await sim(`function onLoad(){ var gr = new GlideRecord('sys_user'); if (gr.get('name','B')) g_form.addInfoMessage(gr.getValue('active') + gr.getRowCount()); }`, 'onLoad', { records });
  assert.equal(get.messages[0].text, 'false1');
});

test('simulator: timers and callbacks are tracked', async () => {
  const late = await sim(`function onChange(){ setTimeout(function(){ g_form.setValue('x','late'); }, 300); }`, 'onChange', { fields: { x: { value: '' } } });
  assert.equal(late.finalFields.x.value, 'late');
  assert.ok(late.warnings.some((w) => w.code === 'timer'));
  const cell = await sim(`function onCellEdit(a,b,c,d,callback){ g_form.addInfoMessage('hi'); }`, 'onCellEdit', {});
  assert.ok(cell.warnings.some((w) => w.code === 'cell-callback-missing'));
  const cellOk = await sim(`function onCellEdit(a,b,c,d,callback){ callback(true); }`, 'onCellEdit', {});
  assert.ok(!cellOk.warnings.some((w) => w.code === 'cell-callback-missing'));
  const modal = await sim(`function onLoad(){ g_modal.confirm('T','Sure?', function(ok){ g_form.addInfoMessage('ok=' + ok); }); }`, 'onLoad', {});
  assert.equal(modal.messages[0].text, 'ok=true');
});

test('simulator: unknown fields are not created, odd arguments do not throw', async () => {
  const run = await sim(`function onLoad(){ g_form.getValue('typo'); g_form.addInfoMessage(String(g_form.hasField('typo'))); }`, 'onLoad', { fields: { real: { value: '1' } } });
  assert.equal(run.messages[0].text, 'false');
  assert.ok(!('typo' in run.finalFields));
  const odd = await sim(`function onLoad(){ var o = {}; o.self = o; g_form.setValue('real', undefined); g_form.addInfoMessage(o); }`, 'onLoad', { fields: { real: { value: '1' } } });
  assert.equal(odd.ok, true);
  assert.ok(odd.calls.some((c) => c.includes('undefined')));
});

test('page bridge finds form fields even when g_form.getFieldNames is missing (current releases)', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const src = fs.readFileSync(require('node:path').join(__dirname, '../src/page/bridge.js'), 'utf8');
  const listeners = {};
  const document = { addEventListener: (type, fn) => (listeners[type] = fn), dispatchEvent: () => true };
  const form = {
    elements: [{ fieldName: 'name', tableName: 'sys_script' }, { fieldName: 'script', tableName: 'sys_script' }, { fieldName: 'name', tableName: 'sys_script' }],
    getValue: (n) => (n === 'script' ? '(function(){\n  gs.info("x");\n})();' : 'My rule'),
    getLabelOf: (n) => n.toUpperCase(),
    getTableName: () => 'sys_script',
    getUniqueValue: () => 'a'.repeat(32),
    isNewRecord: () => false,
  };
  const responses = [];
  const win = { g_form: form, frames: {}, CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; } };
  win.document = document;
  win.window = win;
  vm.runInNewContext(src, { window: win, document, CustomEvent: win.CustomEvent, setTimeout });
  document.dispatchEvent = (e) => responses.push(e.detail);
  const call = (action, args = []) => {
    responses.length = 0;
    listeners['msb-page-request']({ detail: { id: 'x', action, args } });
    return responses.find((r) => r.id === 'x');
  };
  const scripts = call('getScriptFields');
  assert.equal(scripts.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(scripts.result.map((f) => f.name))), ['script'], 'the script field is found, once');
  assert.equal(call('getFormModel').result.fieldCount, 2);
  assert.equal(call('getFormValues').result.values.name, 'My rule');

  // Current releases answer isReadOnly(name) with true for every field; getEditableFields() is the honest source.
  form.isReadOnly = () => true;
  form.isMandatory = () => false;
  form.getEditableFields = () => ['name'];
  form.setValue = () => {};
  const states = Object.fromEntries(call('getFormModel').result.fields.map((row) => [row.name, row.readOnly]));
  assert.deepEqual(JSON.parse(JSON.stringify(states)), { name: false, script: true });
  assert.equal(call('setFieldValue', ['name', 'Renamed']).ok, true, 'an editable field can be set');
  assert.equal(call('setFieldValue', ['script', 'x']).ok, false, 'a field outside the editable list is refused');
  // Nothing editable (a protected record) falls back to isReadOnly.
  form.getEditableFields = () => [];
  assert.equal(call('getFormModel').result.fields.every((row) => row.readOnly === true), true);
});

test('script field detection ignores the table prefix and empty fields (client scripts showed "none detected")', () => {
  // Mirrors the real sys_script_client form: the empty description textarea is named sys_script_client.description,
  // which contains "script" through the TABLE name, and a help panel adds unprefixed textareas.
  const { pickScriptField } = require('../src/content/context.js');
  const el = (name, value) => ({ name, id: name, value });
  const script = el('sys_script_client.script', 'function onChange() {}');
  const form = [
    el('sys_script_client.description', ''),
    el('sys_script_client.messages', ''),
    el('doc', 'a help text that is longer than forty characters in total'),
    el('method', 'x'.repeat(217)),
    el('sys_script_client.isolate_script', 'true'),
    script,
  ];
  assert.equal(pickScriptField(form), script, 'the real script column, not the empty description whose table prefix contains "script"');
  assert.equal(pickScriptField(form.slice(0, 5)), null, 'help-panel textareas and empty fields are never the script');
  const br = el('sys_script.script', 'current.x = 1;');
  assert.equal(pickScriptField([el('sys_script.description', ''), el('sys_script.condition', 'current.a == 1'), br]), br, 'script beats condition');
  const onlyCondition = el('sys_script.condition', 'current.a == 1');
  assert.equal(pickScriptField([el('sys_script.script', ''), onlyCondition]), onlyCondition, 'an empty script field falls back to a non-empty condition');
  const widget = el('sp_widget.client_script', 'function(){}');
  assert.equal(pickScriptField([widget]), widget);
});

test('palette tells code from a sentence, so lookups can come before Ask AI', () => {
  const { looksLikeCode } = require('../src/lib/paletteRank.js');
  ['current.setValue', 'g_form.getValue(', 'getUserByID', 'g_user', 'gr.addQuery("a", 1)', 'a == b'].forEach((q) => assert.equal(looksLikeCode(q), true, q));
  ['why is my business rule slow', 'incident', 'how do I query', 'what is it.', '', '   '].forEach((q) => assert.equal(looksLikeCode(q), false, q));
});

test('palette ranking: recent use outweighs old use, and legacy recents still rank', () => {
  const { frecency, rankRecent, pruneStats, matchPositions, highlightRuns } = require('../src/lib/paletteRank.js');
  const now = Date.UTC(2026, 9, 18);
  const day = 86400000;
  assert.equal(frecency(undefined, now), 0);
  assert.ok(frecency({ n: 5, t: now }, now) > frecency({ n: 5, t: now - 30 * day }, now));
  assert.equal(frecency({ n: 500, t: now }, now), frecency({ n: 20, t: now }, now), 'use count is capped');
  const stats = { often: { n: 10, t: now }, stale: { n: 3, t: now - 60 * day }, once: { n: 1, t: now } };
  assert.deepEqual(rankRecent(stats, ['legacy'], 3, now), ['often', 'once', 'stale']);
  assert.deepEqual(rankRecent({}, ['b', 'a'], 5, now), ['b', 'a'], 'ids from before use counts keep their recency order');
  assert.deepEqual(Object.keys(pruneStats(stats, 2, now)).sort(), ['often', 'once']);
  assert.equal(pruneStats(stats, 5, now), stats);

  assert.deepEqual(matchPositions('rule', 'Business Rules'), [9, 10, 11, 12]);
  assert.deepEqual(matchPositions('bru', 'Business Rules'), [0, 9, 10]);
  assert.deepEqual(matchPositions('zz', 'Business Rules'), []);
  assert.deepEqual(highlightRuns('abc', [1]), [{ text: 'a', hit: false }, { text: 'b', hit: true }, { text: 'c', hit: false }]);
});

test('tool windows: clamping keeps a window reachable, resizing stays in the viewport', () => {
  const { clampRect, resizeRect, defaultWindowRect, upsertWindow, MIN_WINDOW } = require('../src/lib/toolWindow.js');
  const view = { w: 1200, h: 800 };
  // Dragged far off the right and bottom: a grab strip stays on screen.
  const off = clampRect({ x: 5000, y: 5000, w: 480, h: 580 }, view);
  assert.ok(off.x < view.w && off.y < view.h);
  assert.ok(off.x + off.w > 0);
  // Off the top is not allowed (the drag bar would be unreachable).
  assert.equal(clampRect({ x: 100, y: -50, w: 480, h: 580 }, view).y, 0);
  // Too small is raised to the minimum; too large is cut to the viewport.
  const tiny = clampRect({ x: 0, y: 0, w: 10, h: 10 }, view);
  assert.deepEqual([tiny.w, tiny.h], [MIN_WINDOW.w, MIN_WINDOW.h]);
  assert.ok(clampRect({ x: 0, y: 0, w: 9000, h: 9000 }, view).w <= view.w);

  const r = { x: 100, y: 100, w: 480, h: 580 };
  assert.deepEqual(resizeRect(r, 'e', 50, 999, view), { ...r, w: 530 }, 'the east edge changes only the width');
  assert.equal(resizeRect(r, 'se', -9999, -9999, view).w, MIN_WINDOW.w);
  assert.ok(resizeRect(r, 'se', 9999, 9999, view).w + r.x <= view.w);

  // New windows open beside the sidebar and cascade, never on top of each other.
  const a = defaultWindowRect({ view, sidebarWidth: 400, index: 0 });
  const b = defaultWindowRect({ view, sidebarWidth: 400, index: 1 });
  assert.ok(a.x + a.w <= view.w - 400);
  assert.ok(b.x < a.x && b.y > a.y);

  // Opening a tool that already has a window reuses it with the new parameters.
  const list = [{ wid: 1, name: 'search', z: 10, query: 'a' }, { wid: 2, name: 'rest', z: 11 }];
  const next = upsertWindow(list, { wid: 3, name: 'search', query: 'b' }, 12);
  assert.equal(next.length, 2);
  assert.deepEqual(next[0], { wid: 1, name: 'search', query: 'b', z: 12 });
  assert.equal(upsertWindow(list, { wid: 4, name: 'api' }, 13).length, 3);
});

test('tool windows: keyboard moves and resizes stay inside the viewport', () => {
  const { keyDelta, moveByKey, resizeByKey, windowKeyAction, KEY_STEP, KEY_STEP_BIG, MIN_WINDOW } = require('../src/lib/toolWindow.js');
  const view = { w: 1200, h: 800 };
  const r = { x: 100, y: 100, w: 480, h: 580 };
  assert.deepEqual(keyDelta('ArrowRight'), { dx: KEY_STEP, dy: 0 });
  assert.deepEqual(keyDelta('ArrowUp', true), { dx: 0, dy: -KEY_STEP_BIG });
  assert.equal(keyDelta('a'), null);

  assert.deepEqual(moveByKey(r, 'ArrowLeft', false, view), { ...r, x: 100 - KEY_STEP });
  assert.deepEqual(moveByKey(r, 'ArrowDown', true, view), { ...r, y: 100 + KEY_STEP_BIG });
  assert.deepEqual(moveByKey(r, 'x', false, view), r, 'a non-arrow key changes nothing');
  // Held against an edge: the window stays reachable, and never leaves through the top.
  let held = { ...r, y: 0 };
  for (let i = 0; i < 5; i += 1) held = moveByKey(held, 'ArrowUp', true, view);
  assert.equal(held.y, 0);
  held = r;
  for (let i = 0; i < 100; i += 1) held = moveByKey(held, 'ArrowRight', true, view);
  assert.ok(held.x < view.w, 'a grab strip stays on screen');

  assert.deepEqual(resizeByKey(r, 'ArrowRight', false, view), { ...r, w: 480 + KEY_STEP });
  assert.deepEqual(resizeByKey(r, 'ArrowDown', true, view), { ...r, h: 580 + KEY_STEP_BIG });
  let small = r;
  for (let i = 0; i < 100; i += 1) small = resizeByKey(small, 'ArrowLeft', true, view);
  assert.equal(small.w, MIN_WINDOW.w, 'shrinking stops at the minimum');
  let big = r;
  for (let i = 0; i < 100; i += 1) big = resizeByKey(big, 'ArrowDown', true, view);
  assert.ok(big.y + big.h <= view.h, 'growing stops at the viewport');

  assert.deepEqual(windowKeyAction({ key: 'ArrowLeft' }), { type: 'move', key: 'ArrowLeft', shift: false });
  assert.deepEqual(windowKeyAction({ key: 'ArrowDown', altKey: true, shiftKey: true }), { type: 'resize', key: 'ArrowDown', shift: true });
  assert.deepEqual(windowKeyAction({ key: 'Enter' }), { type: 'maximize' });
  assert.deepEqual(windowKeyAction({ key: 'Escape' }), { type: 'close' });
  assert.equal(windowKeyAction({ key: 'ArrowLeft', ctrlKey: true }), null, 'browser chords are left alone');
  assert.equal(windowKeyAction({ key: 'Tab' }), null);
});
