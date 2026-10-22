const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRect,
  translateRect,
  placePopover,
  sysIdFromSelection,
  isScriptColumn,
  isScriptLabel,
  parseLabelId,
  dominantTable,
  toolbarModel,
  toolbarKey,
  breadcrumbQuery,
  fieldMenuModel,
  fieldCode,
  editorBox,
  columnMenuModel,
  dictionaryQuery,
  fieldAclQuery,
  auditQuery,
  recordInfoRows,
  lastChangeRows,
  auditErrorText,
  versionRows,
  lintSummary,
  truncate,
} = require('../src/lib/inline.js');

const SYS_ID = '0123456789abcdef0123456789abcdef';
const viewport = { width: 1000, height: 700 };

test('normalizeRect accepts DOMRect-likes, partial rects and points', () => {
  assert.deepEqual(normalizeRect({ left: 10, top: 20, width: 30, height: 40 }), { left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 });
  assert.deepEqual(normalizeRect({ left: 10, top: 20, right: 50, bottom: 80 }), { left: 10, top: 20, right: 50, bottom: 80, width: 40, height: 60 });
  assert.deepEqual(normalizeRect({ x: 7, y: 9 }), { left: 7, top: 9, right: 7, bottom: 9, width: 0, height: 0 });
  assert.deepEqual(normalizeRect(null), { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
});

test('translateRect moves a rect measured in an iframe by the frame position', () => {
  const moved = translateRect({ left: 5, top: 6, width: 10, height: 10 }, { left: 100, top: 50 });
  assert.deepEqual(moved, { left: 105, top: 56, right: 115, bottom: 66, width: 10, height: 10 });
  assert.equal(translateRect({ x: 1, y: 2 }, undefined).left, 1);
});

test('placePopover prefers below, flips above when it does not fit, and clamps into the viewport', () => {
  const size = { width: 300, height: 200 };
  assert.deepEqual(placePopover({ left: 100, top: 100, width: 40, height: 20 }, size, viewport), { left: 100, top: 128, placement: 'below' });
  // Anchor near the bottom edge: 200px do not fit below, so it goes above the anchor.
  assert.deepEqual(placePopover({ left: 100, top: 640, width: 40, height: 20 }, size, viewport), { left: 100, top: 432, placement: 'above' });
  // Anchor at the right edge: shifted left so it stays inside the margin.
  assert.equal(placePopover({ left: 980, top: 100, width: 10, height: 10 }, size, viewport).left, 692);
  // Negative coordinates (scrolled-away anchor) never place it off-screen.
  const off = placePopover({ left: -50, top: -50, width: 10, height: 10 }, size, viewport);
  assert.ok(off.left >= 8 && off.top >= 8);
  // Taller than either side: stays on the roomier side and is clamped inside the viewport.
  const tall = placePopover({ left: 10, top: 300, width: 10, height: 10 }, { width: 300, height: 650 }, viewport);
  assert.ok(tall.top >= 8 && tall.top + 650 <= viewport.height - 8 + 1);
});

test('sysIdFromSelection accepts exactly one sys_id and ignores everything else', () => {
  assert.equal(sysIdFromSelection(`  ${SYS_ID.toUpperCase()}\n`), SYS_ID);
  assert.equal(sysIdFromSelection(`"${SYS_ID}"`), SYS_ID);
  assert.equal(sysIdFromSelection(`${SYS_ID}0`), null);
  assert.equal(sysIdFromSelection(`id: ${SYS_ID}`), null);
  assert.equal(sysIdFromSelection('hello'), null);
  assert.equal(sysIdFromSelection(undefined), null);
});

test('script columns follow the same column rules as the form script detector', () => {
  ['script', 'operation_script', 'client_script', 'condition_script', 'script_true', 'advanced_script'].forEach((c) => assert.equal(isScriptColumn(c), true, c));
  ['description', 'short_description', 'isolate_script', 'messages', 'comments', 'name', 'condition', '', 'caller_id.script'].forEach((c) => assert.equal(isScriptColumn(c), false, c));
});

test('the toolbar offers Edit and Lint only for a real script column, from a column name or a human label', () => {
  ['script', 'Script', 'Client script', 'Operation script', 'sys_script.script', 'sys_ui_action.script', 'Script true'].forEach((l) => assert.equal(isScriptLabel(l), true, l));
  ['Description', 'incident.description', 'Short description', 'Work notes', 'Condition', '', null, undefined].forEach((l) => assert.equal(isScriptLabel(l), false, String(l)));
});

test('label ids parse to table and field, including reference helper prefixes', () => {
  assert.deepEqual(parseLabelId('label.incident.caller_id'), { table: 'incident', field: 'caller_id' });
  assert.deepEqual(parseLabelId('label.sys_display.incident.caller_id'), { table: 'incident', field: 'caller_id' });
  assert.deepEqual(parseLabelId('label.incident.caller_id.email'), { table: 'incident', field: 'caller_id.email' });
  assert.equal(parseLabelId(`label.IO:${SYS_ID}`), null, 'catalog variables are not form fields');
  assert.equal(parseLabelId('label_incident'), null);
  assert.equal(parseLabelId(''), null);
});

test('the form table is the one most labels belong to', () => {
  assert.equal(dominantTable(['incident', 'incident', 'task', 'incident']), 'incident');
  assert.equal(dominantTable([]), '');
});

test('the toolbar shows record actions on a form, filter actions on a list, and nothing without a table', () => {
  const ids = (m) => m.map((i) => i.id);
  assert.deepEqual(ids(toolbarModel({ table: 'incident', sysId: SYS_ID })), ['copySysId', 'copyLink', 'xml', 'info', 'versions', 'refs', 'formtools', 'names']);
  assert.deepEqual(ids(toolbarModel({ table: 'sys_script', sysId: SYS_ID, hasScript: true })), ['copySysId', 'copyLink', 'xml', 'info', 'versions', 'refs', 'edit', 'lint', 'ask', 'formtools', 'names']);
  // A new, unsaved record has no sys_id to copy yet, but its script still gets editing and lint.
  assert.deepEqual(ids(toolbarModel({ table: 'sys_script', sysId: '-1', hasScript: true })), ['edit', 'lint', 'ask', 'formtools', 'names']);
  assert.deepEqual(ids(toolbarModel({ table: 'incident', isList: true, hasScript: true })), ['explain', 'count', 'copyQuery', 'copyGlide', 'copyRows', 'insight', 'names', 'more']);
  assert.deepEqual(toolbarModel({ table: '', sysId: SYS_ID }), []);
  assert.deepEqual(toolbarModel({ table: 'bad table!' }), []);
  assert.deepEqual(toolbarModel(), []);
  assert.equal(toolbarKey(toolbarModel({ table: 'incident', isList: true })), 'explain,count,copyQuery,copyGlide,copyRows,insight,names,more');
});

test('field and column menus only offer what applies', () => {
  const ids = (m) => m.map((i) => i.id);
  assert.deepEqual(ids(fieldMenuModel({ table: 'incident', field: 'caller_id' })), ['copyName', 'copyValue', 'dictionary', 'acls', 'copyClient', 'copyServer', 'xray']);
  assert.deepEqual(ids(fieldMenuModel({ table: 'sys_script', field: 'script', script: true })), ['copyName', 'copyValue', 'dictionary', 'acls', 'copyClient', 'copyServer', 'xray', 'editHere', 'edit', 'lint', 'ask']);
  assert.deepEqual(ids(fieldMenuModel({ table: 'incident', field: 'caller_id.email' })), ['copyName', 'copyValue', 'copyServer', 'xray'], 'a dot-walked path has no dictionary entry or g_form call of its own');
  assert.deepEqual(fieldMenuModel({ table: 'not a table', field: 'x' }), []);
  assert.deepEqual(ids(columnMenuModel({ table: 'incident', column: 'number' })), ['copyName', 'dictionary', 'acls', 'distinct', 'countBy']);
  assert.deepEqual(ids(columnMenuModel({ table: 'incident', column: 'caller_id.name' })), ['copyName', 'distinct']);
  assert.deepEqual(columnMenuModel({ table: '', column: 'number' }), []);
});

test('lookup queries are built only from validated names and sys_ids', () => {
  assert.equal(dictionaryQuery('incident', 'state'), 'name=incident^element=state');
  assert.equal(dictionaryQuery('incident', 'a^b'), null);
  assert.equal(fieldAclQuery('incident', 'state'), 'name=incident.state^ORname=incident.*^ORname=*.state');
  assert.equal(fieldAclQuery('incident', 'x=y'), null);
  assert.equal(auditQuery('incident', SYS_ID, 'state'), `tablename=incident^documentkey=${SYS_ID}^fieldname=state^ORDERBYDESCsys_created_on`);
  assert.equal(auditQuery('incident', '-1', 'state'), null, 'an unsaved record has no history');
  assert.equal(auditQuery('incident', SYS_ID, 'state^ORactive=true'), null, 'no query injection through a field name');
});

test('record info and audit rows read well and degrade clearly', () => {
  const rows = recordInfoRows({ className: 'incident', createdBy: 'admin', createdOn: '2026-01-02 03:04:05', updatedBy: 'bob', updatedOn: '2026-02-03 04:05:06', updates: '7', sysId: SYS_ID });
  assert.deepEqual(rows.map((r) => r.label), ['Class', 'Created', 'Updated', 'Updates', 'sys_id']);
  assert.equal(rows[1].value, '2026-01-02 03:04:05 by admin');
  assert.equal(rows.at(-1).copy, true);
  assert.deepEqual(recordInfoRows(null), []);
  assert.equal(recordInfoRows({}).find((r) => r.label === 'Created').value, 'unknown');

  const change = lastChangeRows({ sys_created_on: '2026-03-04 05:06:07', sys_created_by: 'carol', oldvalue: '1', newvalue: '2' }, 'state');
  assert.deepEqual(change.map((r) => r.label), ['Last changed', 'From', 'To']);
  assert.match(change[0].value, /carol/);
  assert.match(lastChangeRows(null, 'state')[0].value, /No audit entry for state/);
  assert.equal(lastChangeRows({ sys_created_on: 'x', sys_created_by: 'y', oldvalue: '', newvalue: 'z' }, 'f').length, 2, 'an empty old value is not shown');
  assert.ok(lastChangeRows({ sys_created_on: 'x', oldvalue: 'a'.repeat(400) }, 'f')[1].value.length <= 160);

  assert.match(auditErrorText(new Error('Your user is not allowed to do this (403).')), /cannot read the audit history/);
  assert.match(auditErrorText({ code: 'SESSION_EXPIRED', message: 'Your ServiceNow session has expired.' }), /session has expired/);
  assert.match(auditErrorText(new Error('boom')), /Could not read the audit history: boom/);
});

test('version rows and lint summaries', () => {
  const versions = Array.from({ length: 9 }, (_, i) => ({ sys_recorded_at: `t${i}`, sys_created_by: 'u', source: 'sys_script', state: 'current' }));
  assert.equal(versionRows(versions).length, 6);
  assert.equal(versionRows(versions)[0].value, 'u from sys_script (current)');
  assert.deepEqual(versionRows(undefined), []);
  assert.deepEqual(lintSummary([]).tone, 'ok');
  assert.deepEqual(lintSummary([{ severity: 'low' }]), { tone: 'warn', subtitle: '1 issue' });
  assert.deepEqual(lintSummary([{ severity: 'high' }, { severity: 'low' }]), { tone: 'danger', subtitle: '2 issues, 1 high' });
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate(null), '');
});

test('on-page tools never use innerHTML and gate page-DOM handlers on trusted events', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'content', f), 'utf8');
  ['inline.js', 'popover.js'].forEach((file) => assert.doesNotMatch(read(file), /innerHTML|insertAdjacentHTML|outerHTML/, file));
  const inline = read('inline.js');
  assert.match(inline, /event\.isTrusted !== true/, 'the page-DOM buttons ignore synthetic clicks');
  assert.match(inline, /peekSysId[\s\S]{0,200}isTrusted/, 'the sys_id peek ignores synthetic mouseup');
});

test('field code is the call a developer would type, and nothing for a name that is not a field', () => {
  assert.equal(fieldCode('client', 'caller_id'), "g_form.getValue('caller_id')");
  assert.equal(fieldCode('server', 'caller_id'), "gr.getValue('caller_id')");
  assert.equal(fieldCode('server', 'caller_id.email'), "gr.getElement('caller_id.email').toString()");
  assert.equal(fieldCode('client', 'caller_id.email'), '', 'g_form cannot read a dot-walk');
  assert.equal(fieldCode('server', "x');gs.print('"), '');
  assert.equal(fieldCode('other', 'caller_id'), '');
});

test('the in-place editor covers its field, at least a usable size, and stays on screen', () => {
  const viewport = { width: 1400, height: 800 };
  const field = { left: 300, top: 200, width: 700, height: 120 };
  assert.deepEqual(editorBox(field, viewport), { left: 300, top: 200, width: 700, height: 340, visible: true }, 'a short field grows to the minimum height');
  assert.deepEqual(editorBox({ left: 300, top: 200, width: 700, height: 500 }, viewport), { left: 300, top: 200, width: 700, height: 500, visible: true }, 'a tall field is covered exactly');
  const low = editorBox({ left: 300, top: 700, width: 700, height: 80 }, viewport);
  assert.equal(low.top + low.height <= 792, true, 'it is moved up rather than cut off by the bottom edge');
  assert.equal(editorBox({ left: 1300, top: 100, width: 600, height: 300 }, viewport).left + 600 <= 1392, true, 'and in from the right edge');
  const narrow = editorBox({ left: 0, top: 0, width: 200, height: 50 }, { width: 400, height: 300 });
  assert.equal(narrow.width <= 384 && narrow.height <= 284, true, 'never larger than the window');
  assert.equal(editorBox({ left: 300, top: -900, width: 700, height: 120 }, viewport).visible, false, 'scrolled out of sight above');
  assert.equal(editorBox({ left: 300, top: 900, width: 700, height: 120 }, viewport).visible, false, 'scrolled out of sight below');
  assert.equal(editorBox({ left: 0, top: 0, width: 0, height: 0 }, viewport).visible, false, 'a field with no size is not on screen');
});

test('the breadcrumb query is the last crumb, with a related list\'s fixed query in front', () => {
  const crumbs = ['', 'active=true', 'active=true^priority<=2'];
  assert.equal(breadcrumbQuery({ filters: crumbs }), 'active=true^priority<=2');
  assert.equal(breadcrumbQuery({ filters: [''] }), '');
  assert.equal(breadcrumbQuery(), '');
  assert.equal(breadcrumbQuery({ fixedQuery: 'parent=abc', filters: ['', 'active=true'] }), 'parent=abc^active=true');
  assert.equal(breadcrumbQuery({ fixedQuery: 'parent=abc', filters: ['', 'parent=abc^active=true'] }), 'parent=abc^active=true');
  assert.equal(breadcrumbQuery({ fixedQuery: 'parent=abc', filters: [''] }), 'parent=abc');
});
