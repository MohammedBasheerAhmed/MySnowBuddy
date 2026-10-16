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

// Values substituted into a code snippet must stay inside their string literal.
const NASTY = "O'Brien \"quoted\" C:\\temp\\new\nsecond line `tick` ${x} */";
const parses = (code) => {
  // eslint-disable-next-line no-new-func -- compile only, never run
  new Function(code);
  return true;
};

test('snippet values are escaped for the string literal they land in', () => {
  const single = renderTemplate("gr.addQuery('{{field}}', '{{value}}');", { field: 'name', value: NASTY }, { code: true }).text;
  assert.ok(parses(single));
  // eslint-disable-next-line no-new-func -- evaluate the literal back to its value
  assert.equal(new Function(`return '${single.match(/, '(.*)'\);$/s)[1]}';`)(), NASTY);
  const double = renderTemplate('var s = "{{value}}";', { value: NASTY }, { code: true }).text;
  assert.ok(parses(double));
  // eslint-disable-next-line no-new-func
  assert.equal(new Function(`${double} return s;`)(), NASTY);
  const tpl = renderTemplate('var s = `pre {{value}} post`;', { value: NASTY }, { code: true }).text;
  // eslint-disable-next-line no-new-func
  assert.equal(new Function(`var x = 'X'; ${tpl} return s;`)(), `pre ${NASTY} post`);
  // An escaped quote before the placeholder does not end the literal.
  const esc = renderTemplate("var s = 'it\\'s {{value}}';", { value: "a'b" }, { code: true }).text;
  assert.equal(esc, "var s = 'it\\'s a\\'b';");
});

test('snippet values outside strings: code is inserted as typed, comments cannot be escaped', () => {
  assert.equal(renderTemplate('gdt.addDaysUTC({{days}});', { days: '5' }, { code: true }).text, 'gdt.addDaysUTC(5);');
  assert.equal(renderTemplate('var {{name}} = 1;', { name: 'MyClass' }, { code: true }).text, 'var MyClass = 1;');
  const line = renderTemplate('// {{what}}\nreturn;', { what: 'step one\nstep two' }, { code: true }).text;
  assert.equal(line, '// step one step two\nreturn;');
  const block = renderTemplate('/* {{what}} */ x();', { what: 'a */ evil(); /*' }, { code: true }).text;
  assert.ok(parses(block) && block.endsWith('*/ x();') && !/\*\/ evil/.test(block));
});

test('built-in snippets stay valid JavaScript whatever the values', () => {
  const { BUILTIN_SNIPPETS: snippets } = require('../src/lib/builtinSnippets.js');
  for (const s of snippets) {
    const values = Object.fromEntries(extractVariables(s.template).map((n) => [n, /^(days|variable|class_name|method|reference_field)$/.test(n) ? (n === 'days' ? '3' : 'abc') : NASTY]));
    const { text, missing } = renderTemplate(s.template, values, { kind: 'snippets' });
    assert.deepEqual(missing, []);
    assert.ok(parses(text), `${s.id} no longer parses:\n${text}`);
  }
});

test('prompts are plain text: values are inserted unchanged', () => {
  const t = "Explain '{{script}}' on {{table}}";
  assert.equal(renderTemplate(t, { script: NASTY, table: 'incident' }).text, `Explain '${NASTY}' on incident`);
  assert.equal(renderTemplate(t, { script: NASTY, table: 'incident' }, { kind: 'prompts' }).text, `Explain '${NASTY}' on incident`);
});

test('a regex literal holding a quote does not throw off snippet escaping', () => {
  const r = (t) => renderTemplate(t, { v: "a'b" }, { code: true }).text;
  assert.equal(r("var re = /'/g; gr.addQuery('{{v}}');"), "var re = /'/g; gr.addQuery('a\\'b');");
  assert.equal(r("var re = /[/']+/; if (x) { return /\\'/.test(s) ? '{{v}}' : ''; }"), "var re = /[/']+/; if (x) { return /\\'/.test(s) ? 'a\\'b' : ''; }");
  // Division is not a regex.
  assert.equal(r("var half = total / 2; var s = '{{v}}';"), "var half = total / 2; var s = 'a\\'b';");
  assert.equal(r("var q = (a + b) / c / d; s = '{{v}}';"), "var q = (a + b) / c / d; s = 'a\\'b';");
  assert.ok(parses(r("var re = /'/; gs.info('{{v}}');")));
});
