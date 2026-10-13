const test = require('node:test');
const assert = require('node:assert/strict');
const { isConfigTable, isDefaultUpdateSet } = require('../src/lib/guards.js');
const { takeNewRows, appendCapped, extractScriptOutput } = require('../src/lib/logTail.js');
const { diffLines, collapseDiff } = require('../src/lib/diff.js');

test('isConfigTable recognises configuration tables but not data tables', () => {
  assert.equal(isConfigTable('sys_script'), true);
  assert.equal(isConfigTable('sys_ui_policy'), true);
  assert.equal(isConfigTable('incident'), false);
  assert.equal(isConfigTable('sys_user'), false);
  assert.equal(isConfigTable(''), false);
});

test('isDefaultUpdateSet matches Default sets only', () => {
  assert.equal(isDefaultUpdateSet('Default'), true);
  assert.equal(isDefaultUpdateSet('Default [Global]'), true);
  assert.equal(isDefaultUpdateSet('Default of my app'), true);
  assert.equal(isDefaultUpdateSet('Defaults and more'), false);
  assert.equal(isDefaultUpdateSet('Sprint 4'), false);
});

test('takeNewRows returns unseen rows oldest first and remembers them', () => {
  const seen = new Set();
  const first = takeNewRows(seen, [
    { sys_id: 'b', sys_created_on: '2024-01-02 10:00:00' },
    { sys_id: 'a', sys_created_on: '2024-01-01 10:00:00' },
  ]);
  assert.deepEqual(first.map((r) => r.sys_id), ['a', 'b']);
  const second = takeNewRows(seen, [{ sys_id: 'a' }, { sys_id: 'c', sys_created_on: '2024-01-03' }]);
  assert.deepEqual(second.map((r) => r.sys_id), ['c']);
});

test('appendCapped keeps the newest entries', () => {
  assert.deepEqual(appendCapped([1, 2, 3], [4, 5], 4), [2, 3, 4, 5]);
});

test('extractScriptOutput reads pre blocks and decodes entities', () => {
  const html = '<html><pre>*** Script: hello &lt;b&gt;\n*** Script: a &amp; b</pre></html>';
  assert.equal(extractScriptOutput(html), 'hello <b>\na & b');
  assert.equal(extractScriptOutput('<p>nothing</p>'), '');
});

test('collapseDiff folds long unchanged runs into a gap', () => {
  const oldText = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
  const newText = oldText.replace('line10', 'changed');
  const rows = collapseDiff(diffLines(oldText, newText), 2);
  const gaps = rows.filter((r) => r.type === 'gap');
  assert.equal(gaps.length, 2);
  assert.ok(rows.some((r) => r.type !== 'equal' && r.type !== 'gap'));
  assert.ok(rows.length < 20);
});
