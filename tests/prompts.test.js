const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BUILTIN_PROMPTS,
  KINDS,
  extractVariables,
  userVariables,
  renderTemplate,
  normalizePrompt,
  sortPrompts,
  recordUse,
  parseImport,
  isBuiltin,
  contextValues,
} = require('../src/lib/promptLibrary.js');
const { BUILTIN_SNIPPETS } = require('../src/lib/builtinSnippets.js');

test('ships at least 200 uniquely identified built-in prompts', () => {
  assert.ok(BUILTIN_PROMPTS.length >= 200);
  assert.equal(new Set(BUILTIN_PROMPTS.map((p) => p.id)).size, BUILTIN_PROMPTS.length);
  BUILTIN_PROMPTS.forEach((p) => {
    assert.ok(KINDS.prompts.categories.includes(p.category), `${p.id} category ${p.category}`);
    assert.ok(isBuiltin(p.id));
  });
});

test('snippets are unique and use known categories', () => {
  assert.equal(new Set(BUILTIN_SNIPPETS.map((s) => s.id)).size, BUILTIN_SNIPPETS.length);
  BUILTIN_SNIPPETS.forEach((s) => assert.ok(KINDS.snippets.categories.includes(s.category), s.id));
});

test('variables split into page context and user inputs', () => {
  const t = 'Use {{table}} and {{selection}} with {{volume}} and {{ volume }}';
  assert.deepEqual(extractVariables(t), ['table', 'selection', 'volume']);
  assert.deepEqual(userVariables(t), ['volume']);
});

test('rendering is single pass and reports missing values', () => {
  const { text, missing } = renderTemplate('{{a}} {{b}} {{c}}', { a: '{{b}}', b: 'x' });
  assert.equal(text, '{{b}} x {{c}}');
  assert.deepEqual(missing, ['c']);
});

test('context values redact secrets in script and selection', () => {
  const v = contextValues({ table: 'incident', scriptBody: 'password = "hunter2hunter2"', selection: 'ok' }, 'dev1');
  assert.equal(v.table, 'incident');
  assert.equal(v.selection, 'ok');
  assert.equal(v.instance, 'dev1');
});

test('normalizePrompt validates and never reuses built-in ids', () => {
  assert.throws(() => normalizePrompt({ title: '', template: 'x' }));
  const p = normalizePrompt({ id: BUILTIN_PROMPTS[0].id, title: 'T', template: 'body' });
  assert.ok(p.id.startsWith('user.'));
  assert.equal(p.category, 'Custom');
});

test('sorting: favourites, then most used, then title', () => {
  const list = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }];
  assert.deepEqual(sortPrompts(list, ['c'], { b: 3 }).map((p) => p.id), ['c', 'b', 'a']);
  const lib = recordUse(recordUse({ usage: {} }, 'a'), 'a');
  assert.equal(lib.usage.a, 2);
});

test('imports get fresh ids and bad entries are skipped', () => {
  const { prompts, skipped } = parseImport(JSON.stringify({ prompts: [{ id: 'user.x', title: 'T', template: 'b' }, { title: '' }] }));
  assert.equal(prompts.length, 1);
  assert.notEqual(prompts[0].id, 'user.x');
  assert.equal(skipped, 1);
  assert.throws(() => parseImport('nope'));
});
