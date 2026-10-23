const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { INTENTS, queryWords, wordsScore, intentText } = require('../src/lib/paletteIntents.js');
const { pageKind, pageSuggestions, suggestFor, SUGGESTED, SUGGESTED_TITLES } = require('../src/lib/paletteContext.js');

const src = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// Every command id the palette can have: literal ids in commands.js plus one per registered panel.
function knownCommandIds() {
  const ids = new Set([...src('src/content/commands.js').matchAll(/id: '([a-z][A-Za-z0-9_.]*)'/g)].map((m) => m[1]));
  ['src/sidebar/panelRegistry.js', 'src/sidebar/MyWorkPanel.jsx'].forEach((file) => {
    [...src(file).matchAll(/^\s+name: '([a-z]+)',/gm)].forEach((m) => ids.add(`panel.${m[1]}`));
  });
  return ids;
}

test('every intent and suggestion points at a command that exists', () => {
  const ids = knownCommandIds();
  assert.ok(ids.has('panel.access') && ids.has('record.versionDiff'), 'the scan found the real ids');
  Object.keys(INTENTS).forEach((id) => assert.ok(ids.has(id), `intent for unknown command ${id}`));
  Object.entries(SUGGESTED).forEach(([kind, list]) => list.forEach((id) => assert.ok(ids.has(id), `${kind} suggests unknown command ${id}`)));
});

test('query words drop filler and keep the meaning', () => {
  assert.deepEqual(queryWords("Why can't they see this record?"), ['see', 'record']);
  assert.deepEqual(queryWords('who changed this'), ['who', 'changed']);
  assert.deepEqual(queryWords(''), []);
});

test('a problem phrase finds the command that solves it, in any word order', () => {
  const text = (id) => intentText(id);
  assert.ok(wordsScore('who changed this', 'Compare versions of this record', text('record.versionDiff')) > 0);
  assert.ok(wordsScore('changed who', 'Compare versions of this record', text('record.versionDiff')) > 0);
  assert.ok(wordsScore("why can't user see record", 'Access debugger', text('panel.access')) > 0);
  assert.ok(wordsScore('where is this script include used', 'Change impact', text('panel.impact')) > 0);
  assert.ok(wordsScore('field read only', 'Page X-ray', text('panel.xray')) > 0);
  // The wrong tool does not match.
  assert.equal(wordsScore('who changed this', 'Flush instance cache', text('instance.cache')), 0);
  assert.equal(wordsScore("why can't user see record", 'Flush instance cache', text('instance.cache')), 0);
});

test('one word is left to the ordinary matcher, and title words count extra', () => {
  assert.equal(wordsScore('incident', 'Open incident list', ''), 0);
  const inTitle = wordsScore('record versions', 'Record versions', '');
  const inKeywords = wordsScore('record versions', 'Something else', 'record versions');
  assert.ok(inTitle > inKeywords);
});

test('the page kind decides what the palette suggests', () => {
  assert.equal(pageKind({}), 'other');
  assert.equal(pageKind({ table: 'incident', isList: true }), 'list');
  assert.equal(pageKind({ table: 'cmdb_ci_server', sysId: 'a'.repeat(32) }), 'record');
  assert.equal(pageKind({ table: 'incident', sysId: 'a'.repeat(32) }), 'ticket', 'a task-type record is a ticket (tests/glue.test.js has the rest)');
  assert.equal(pageKind({ table: 'sys_script', sysId: 'a'.repeat(32), scriptBody: 'x = 1;', scriptFieldLabel: 'Script' }), 'script');
  // The longest-text fallback on an incident is not a script.
  assert.equal(pageKind({ table: 'incident', sysId: 'a'.repeat(32), scriptBody: 'long description text', scriptFieldLabel: 'Description' }), 'ticket');
  assert.equal(pageKind({ table: 'sys_update_set', sysId: 'a'.repeat(32) }), 'updateset');
  assert.equal(pageKind({ table: 'sys_update_set', isList: true }), 'updateset');
  Object.keys(SUGGESTED).forEach((kind) => assert.ok(SUGGESTED_TITLES[kind], `${kind} has a title`));
});

test('suggestions follow the list order and skip commands that are not on the page', () => {
  const commands = ['analyze.lint', 'tools.editor', 'record.versionDiff', 'unrelated'].map((id) => ({ id }));
  const script = { table: 'sys_script', sysId: 'a'.repeat(32), scriptBody: 'x', scriptFieldLabel: 'Script' };
  assert.deepEqual(suggestFor(script, commands, 3).map((c) => c.id), ['tools.editor', 'analyze.lint', 'record.versionDiff']);
  assert.deepEqual(suggestFor(script, commands, 1).map((c) => c.id), ['tools.editor']);
  assert.deepEqual(suggestFor({}, [{ id: 'unrelated' }]), []);
  assert.ok(pageSuggestions(script).includes('panel.impact'), 'the whole list, not only the first four');
  assert.deepEqual(pageSuggestions({}), SUGGESTED.other);
});

test('the welcome tour is short, plain and names the real shortcut', () => {
  const { tourSteps, paletteShortcut } = require('../src/content/welcome.js');
  const steps = tourSteps();
  assert.equal(steps.length, 4);
  steps.forEach((step) => {
    assert.ok(step.key && step.title && step.text, 'each step has a key, a title and text');
    assert.ok(step.text.length < 190, `"${step.title}" is short enough to read at a glance`);
  });
  assert.equal(steps[0].key, paletteShortcut());
  assert.match(paletteShortcut(), /Space/);
  // The manifest binds the palette to this chord; the card must not drift from it.
  const manifest = JSON.parse(src('manifest.json'));
  assert.equal(manifest.commands['open-palette'].suggested_key.default, 'Ctrl+Shift+Space');
});
