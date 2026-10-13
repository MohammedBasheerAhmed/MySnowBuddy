const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSyntax } = require('../src/lib/syntax.js');
const { expandSnippet } = require('../src/lib/snippets.js');

test('checkSyntax accepts balanced code with strings, comments and regexes', () => {
  const src = [
    "var a = { b: [1, 2, '}'] }; // ) ignored",
    '/* ( */',
    'var re = /[)]+\\/x/g;',
    'var half = total / 2 + (n / 3);',
    'function f(x) { return x / 2; }',
  ].join('\n');
  assert.equal(checkSyntax(src), null);
});

test('checkSyntax reports unclosed and unexpected brackets with a line', () => {
  assert.deepEqual(checkSyntax('function f() {\n  if (x) {\n}\n'), { line: 1, message: "Unclosed '{'" });
  assert.deepEqual(checkSyntax('var a = 1;\nfoo());'), { line: 2, message: "Unexpected ')'" });
  const mismatch = checkSyntax('var a = (1;\n}');
  assert.equal(mismatch.line, 2);
  assert.match(mismatch.message, /still open/);
});

test('checkSyntax reports unterminated strings and comments', () => {
  assert.deepEqual(checkSyntax("var a = 'oops;\nvar b;"), { line: 1, message: "Unterminated string (')" });
  assert.equal(checkSyntax('/* never closed').message, 'Unclosed comment (/*)');
});

test('expandSnippet expands a trigger word and places the caret', () => {
  const src = '  gr';
  const out = expandSnippet(src, src.length);
  assert.equal(out.start, 2);
  assert.ok(out.text.startsWith("var gr = new GlideRecord('');"));
  assert.ok(out.text.includes('\n  gr.query();'), 'continuation lines keep the indent');
  assert.equal(out.text.slice(out.caret - out.start - 1, out.caret - out.start + 1), "''");
});

test('expandSnippet ignores unknown words and member access', () => {
  assert.equal(expandSnippet('foo', 3), null);
  assert.equal(expandSnippet('obj.gr', 6), null);
});
