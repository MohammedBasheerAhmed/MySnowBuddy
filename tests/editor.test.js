const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSyntax } = require('../src/lib/syntax.js');
const { expandSnippet } = require('../src/lib/snippets.js');
const T = require('../src/lib/editorText.js');
const D = require('../src/lib/editorDiagnostics.js');

/** Applies an edit {from, to, insert, selStart, selEnd} and returns the new text with the selection marked as [ and ]. */
function run(edit, text) {
  if (!edit) return null;
  const out = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  if (edit.selStart === undefined) return out;
  return `${out.slice(0, edit.selStart)}[${out.slice(edit.selStart, edit.selEnd)}]${out.slice(edit.selEnd)}`;
}

/** "a[b]c" -> {text: 'abc', s: 1, e: 2}; "a|b" -> caret at 1. */
function sel(marked) {
  const caret = marked.indexOf('|');
  if (caret !== -1) return { text: marked.replace('|', ''), s: caret, e: caret };
  const s = marked.indexOf('[');
  const e = marked.indexOf(']') - 1;
  return { text: marked.replace('[', '').replace(']', ''), s, e };
}

const cmd = (fn, marked, ...args) => {
  const { text, s, e } = sel(marked);
  return run(fn(text, s, e, ...args), text);
};

// ---- lexer ------------------------------------------------------------------------------------------

test('lex finds comments, strings, templates and regexes, and tells a regex from a division', () => {
  const src = "var a = 'x//y'; // c\nvar b = a / 2 / c; var re = /[/]+'/g; `t\n${a}` /* b\n */ \"q";
  const types = T.lex(src).map((r) => [r.type, src.slice(r.start, r.end), r.closed]);
  assert.deepEqual(types, [
    [T.STRING, "'x//y'", true],
    [T.COMMENT, '// c', false],
    [T.REGEX, "/[/]+'/g", true],
    [T.TEMPLATE, '`t\n${a}`', true],
    [T.COMMENT, '/* b\n */', true],
    [T.STRING, '"q', false],
  ]);
});

test('rangeAt: inside after an opening quote, outside after a closing one, inside at the end of a line comment', () => {
  const src = "f('ab') // c";
  const info = T.analyze(src);
  assert.equal(T.rangeAt(info, 2), null, 'before the quote');
  assert.equal(T.rangeAt(info, 3).type, T.STRING);
  assert.equal(T.rangeAt(info, 5).type, T.STRING);
  assert.equal(T.rangeAt(info, 6), null, 'after the closing quote');
  assert.equal(T.rangeAt(info, src.length).type, T.COMMENT);
  const open = T.analyze("f('ab");
  assert.equal(T.rangeAt(open, 5).type, T.STRING, 'end of an unterminated string');
});

test('masked keeps length and newlines and blanks only non-code', () => {
  const src = "a('(x', /* ) */ b) // ]\n`\n`";
  const m = T.masked(T.analyze(src));
  assert.equal(m.length, src.length);
  assert.equal(m.split('\n').length, src.split('\n').length);
  assert.equal(m.replace(/\s/g, ''), 'a(,b)');
});

test('lineTokens highlights by class and continues block comments and templates across lines', () => {
  const info = T.analyze("var a = 'x'; // hi\ngs.info(a, 12);\n/* one\ntwo */ x\n`a\nb`;");
  assert.deepEqual(T.lineTokens(info, 0), [['k', 'var'], ['', ' a = '], ['s', "'x'"], ['', '; '], ['c', '// hi']]);
  assert.deepEqual(T.lineTokens(info, 1), [['g', 'gs'], ['', '.'], ['f', 'info'], ['', '(a, '], ['n', '12'], ['', ');']]);
  assert.deepEqual(T.lineTokens(info, 3), [['c', 'two */'], ['', ' x']]);
  assert.deepEqual(T.lineTokens(info, 5), [['s', 'b`'], ['', ';']]);
  const long = T.analyze(`var x = '${'y'.repeat(5000)}';`);
  assert.equal(T.lineTokens(long, 0).length, 1, 'very long lines are not tokenized');
});

test('matchBracket pairs brackets and ignores the ones in strings and comments', () => {
  const src = "if (a('(')) { /* } */ }";
  const at = T.matchBracket(src, 3);
  assert.deepEqual(at, { at: 3, match: 10 });
  assert.deepEqual(T.matchBracket(src, src.length), { at: src.length - 1, match: 12 });
  assert.equal(T.matchBracket('(a]', 1).match, -1);
  assert.equal(T.matchBracket('abc', 1), null);
});

// ---- line commands ------------------------------------------------------------------------------------

test('toggleLineComment comments at the shallowest indent, skips blank lines and uncomments', () => {
  assert.equal(cmd(T.toggleLineComment, '  [a\n\n    b]\nc'), '  [// a\n\n  //   b]\nc');
  assert.equal(cmd(T.toggleLineComment, '  // a|\n  //b'), '  a[]\n  //b');
  assert.equal(cmd(T.toggleLineComment, '[  // a\n  //b]'), '[  a\n  b]');
  assert.equal(cmd(T.toggleLineComment, '\n|\n'), null);
});

test('indent, outdent and Tab at the caret', () => {
  assert.equal(cmd(T.indentLines, '[a\n\nb]', '  '), '[  a\n\n  b]');
  assert.equal(cmd(T.outdentLines, '[    a\n\tb\n c]', '  '), '[  a\nb\nc]');
  assert.equal(cmd(T.indentLines, 'x[a]', '\t'), '\tx[a]');
  assert.equal(run(T.insertIndent('abc', 1, '    '), 'abc'), 'a   [|]bc'.replace('|', ''));
  assert.equal(run(T.insertIndent('ab', 1, '\t'), 'ab'), 'a\t[]b');
});

test('moveLines swaps with the neighbour line and keeps the selection on the moved text', () => {
  assert.equal(cmd(T.moveLines, 'a\nb|\nc', -1), 'b[]\na\nc');
  assert.equal(cmd(T.moveLines, 'a\nb|\nc', 1), 'a\nc\nb[]');
  assert.equal(cmd(T.moveLines, '[a\nb]\nc', 1), 'c\n[a\nb]');
  assert.equal(cmd(T.moveLines, 'a|\nb', -1), null);
  assert.equal(cmd(T.moveLines, 'a\nb|', 1), null);
  assert.equal(cmd(T.moveLines, '[a\n]b', 1), 'b\n[a]', 'a selection ending at column 0 moves only the lines above it');
  assert.equal(cmd(T.moveLines, 'x\n[a\n]b', -1), '[a\n]x\nb');
});

test('duplicateLines and deleteLines', () => {
  assert.equal(cmd(T.duplicateLines, 'a\nb|\nc', 1), 'a\nb\nb[]\nc');
  assert.equal(cmd(T.duplicateLines, 'a\nb|\nc', -1), 'a\nb[]\nb\nc');
  assert.equal(cmd(T.deleteLines, 'a\nb|\nc'), 'a\n[]c');
  assert.equal(cmd(T.deleteLines, 'a\nb\nc|'), 'a\n[]b', 'the last line takes the newline before it');
  assert.equal(run(T.deleteLines('only', 2, 2), 'only'), '[]');
  assert.equal(T.deleteLines('', 0, 0), null);
});

test('newlineAndIndent keeps indentation, indents after an opener and splits a bracket pair', () => {
  assert.equal(cmd(T.newlineAndIndent, '  foo();|', '  '), '  foo();\n  []');
  assert.equal(cmd(T.newlineAndIndent, '  if (a) {|', '  '), '  if (a) {\n    []');
  assert.equal(cmd(T.newlineAndIndent, 'f(function () {|  });', '  '), 'f(function () {\n  []\n});');
  assert.equal(cmd(T.newlineAndIndent, "var s = '{|", '  '), "var s = '{\n[]");
  assert.equal(cmd(T.newlineAndIndent, '\tx = [|]', '\t'), '\tx = [\n\t\t[]\n\t]');
});

test('closeBracketOutdent aligns a typed closer with the line that opened the block', () => {
  assert.equal(run(T.closeBracketOutdent('  if (a) {\n    x();\n      ', 26, 26, '}'), '  if (a) {\n    x();\n      '), '  if (a) {\n    x();\n  }[]');
  assert.equal(T.closeBracketOutdent('  if (a) {\n  x |', 15, 15, '}'), null, 'not on a line with code');
  assert.equal(T.closeBracketOutdent('x\n  ', 4, 4, '}'), null, 'nothing to close');
});

test('smartHome, offsetOf, parseLineInput and visual columns with tabs', () => {
  assert.equal(T.smartHome('a\n   bc', 7), 5);
  assert.equal(T.smartHome('a\n   bc', 5), 2);
  assert.equal(T.offsetOf('ab\ncd\nef', 2, 2), 4);
  assert.equal(T.offsetOf('ab\ncd', 99, 99), 5, 'clamped');
  assert.deepEqual(T.parseLineInput(' 12:5 '), { line: 12, col: 5 });
  assert.deepEqual(T.parseLineInput(':7'), { line: 7, col: 1 });
  assert.equal(T.parseLineInput('abc'), null);
  assert.equal(T.visualColumn('\tab', 2, 2), 3);
  assert.equal(T.visualColumn('x\tb', 2, 4), 4);
  assert.equal(T.offsetAtVisualColumn('\tab', 0, 2, 2), 1);
  assert.equal(T.offsetAtVisualColumn('ab', 0, 9, 2), 2);
});

test('detectIndentUnit finds tabs, 2 or 4 spaces, or nothing', () => {
  assert.equal(T.detectIndentUnit('a {\n\tb\n\t\tc\n}'), '\t');
  assert.equal(T.detectIndentUnit('a {\n    b {\n        c\n    }\n}'), '    ');
  assert.equal(T.detectIndentUnit('a {\n  b {\n    c\n  }\n}'), '  ');
  assert.equal(T.detectIndentUnit('a\nb'), null);
});

// ---- find and replace ------------------------------------------------------------------------------------

test('buildSearchRegex escapes literals, supports regex, case and whole word, and reports bad patterns', () => {
  assert.equal(T.findAll('a.b axb A.B', T.buildSearchRegex('a.b').re).length, 2);
  assert.equal(T.findAll('a.b axb A.B', T.buildSearchRegex('a.b', { matchCase: true }).re).length, 1);
  assert.equal(T.findAll('a.b axb', T.buildSearchRegex('a.b', { regex: true }).re).length, 2);
  assert.equal(T.findAll('gr grx xgr gr', T.buildSearchRegex('gr', { wholeWord: true }).re).length, 2);
  assert.equal(T.buildSearchRegex('(', { regex: true }).error, 'Invalid regular expression');
  assert.equal(T.buildSearchRegex('').re, null);
  assert.equal(T.findAll('abc', T.buildSearchRegex('x*', { regex: true }).re).length, 0, 'empty matches are skipped');
  assert.equal(T.findAll('aaaa', T.buildSearchRegex('a').re, 3).length, 3, 'capped');
});

test('replace keeps literal $ in plain mode and expands groups in regex mode', () => {
  const plain = T.replaceAllMatches('a.b a.b', T.buildSearchRegex('a.b').re, '$1&', false);
  assert.deepEqual(plain, { text: '$1& $1&', count: 2 });
  const rx = T.replaceAllMatches("getValue('a') getValue('b')", T.buildSearchRegex("getValue\\('(\\w)'\\)", { regex: true }).re, "getDisplayValue('$1')", true);
  assert.deepEqual(rx, { text: "getDisplayValue('a') getDisplayValue('b')", count: 2 });
  const named = T.replaceAllMatches('x=1', T.buildSearchRegex('(?<k>\\w)=(?<v>\\d)', { regex: true }).re, '$<v>=$<k> $$ $&', true);
  assert.equal(named.text, '1=x $ x=1');
  const re = T.buildSearchRegex('(\\d)', { regex: true }).re;
  assert.equal(T.replacementAt('a1b2', re, 3, 4, '<$1>', true), '<2>');
  assert.equal(T.replacementAt('a1b2', re, 0, 1, '<$1>', true), null, 'the selection is not a match');
});

test('diffRange finds the smallest replacement', () => {
  assert.deepEqual(T.diffRange('abcdef', 'abXYef'), { from: 2, to: 4, insert: 'XY' });
  assert.deepEqual(T.diffRange('aaa', 'aaaa'), { from: 3, to: 3, insert: 'a' });
  assert.deepEqual(T.diffRange('abc', ''), { from: 0, to: 3, insert: '' });
  assert.equal(T.diffRange('same', 'same'), null);
});

// ---- re-indent ---------------------------------------------------------------------------------------------

test('reindent fixes indentation from the bracket structure, including switch and chained calls', () => {
  const src = [
    'function f() {',
    'if (a) {',
    '        foo(function () {',
    'bar();',
    '});',
    '}',
    'switch (x) {',
    'case 1:',
    'y();',
    'break;',
    'default:',
    'z();',
    '}',
    'gr',
    '.query();',
    '',
    '   ',
    '}',
  ].join('\n');
  const want = [
    'function f() {',
    '  if (a) {',
    '    foo(function () {',
    '      bar();',
    '    });',
    '  }',
    '  switch (x) {',
    '    case 1:',
    '      y();',
    '      break;',
    '    default:',
    '      z();',
    '  }',
    '  gr',
    '    .query();',
    '',
    '',
    '}',
  ].join('\n');
  const out = T.reindent(src, '  ');
  assert.equal(out.text, want);
  assert.ok(out.changed);
  assert.equal(T.reindent(want, '  ').changed, false);
});

test('reindent changes only leading whitespace and never touches template literals or comment bodies', () => {
  const src = "function f() {\nvar t = `line\n      keep\n  this`;\n/**\n     * doc\n     */\n/*\n      commented();\n*/\nvar s = 'a{';\n}";
  const out = T.reindent(src, '    ');
  const lines = out.text.split('\n');
  assert.equal(lines[2], '      keep');
  assert.equal(lines[3], '  this`;');
  assert.equal(lines[5], '     * doc');
  assert.equal(lines[8], '      commented();');
  assert.equal(lines[10], "    var s = 'a{';");
  assert.equal(out.text.replace(/\s/g, ''), src.replace(/\s/g, ''), 'only whitespace changed');
  assert.equal(out.text.split('\n').length, src.split('\n').length);
});

test('reindent refuses unbalanced brackets', () => {
  assert.match(T.reindent('if (a) {\n}\n}', '  ').error, /line 3/);
  assert.match(T.reindent('if (a) {', '  ').error, /never closed/);
});

// ---- diagnostics ----------------------------------------------------------------------------------------------

test('locateFinding finds the column of an unknown method and offers the closest name as a fix', () => {
  const loc = D.locateFinding('  gr.addQuerry(1);', {
    ruleId: 'api-unknown-method',
    message: 'gr.addQuerry() is not a known GlideRecord method; the closest is addQuery().',
    suggestion: '',
  });
  assert.deepEqual(loc, { startCol: 5, endCol: 14, fix: { title: 'Change to addQuery()', startCol: 5, endCol: 14, text: 'addQuery', original: 'addQuerry' } });
  const field = D.locateFinding("g_form.getValue('shrt');", { ruleId: 'unknown-field', message: 'Field "shrt" does not exist on incident (g_form.getValue).', suggestion: 'Did you mean "short"? Check' });
  assert.equal(field.startCol, 17);
  assert.equal(field.fix.text, 'short');
  const side = D.locateFinding('  g_form.setValue(a);', { ruleId: 'api-wrong-side', message: 'g_form is a client-side (browser) API and does not exist in server-side scripts.' });
  assert.deepEqual([side.startCol, side.endCol, side.fix], [2, 8, null]);
  assert.deepEqual(D.locateFinding('x', { ruleId: 'no-eval', message: 'eval' }), { startCol: null, endCol: null, fix: null });
});

test('diagnose runs the verifier with the table dictionary and maps severities', () => {
  const code = "(function executeRule(current, previous) {\n  var gr = new GlideRecord('incident');\n  gr.addQuerry('active', true);\n  current.short_descripton = 'x';\n})(current, previous);";
  const problems = D.diagnose(code, { kind: 'business_rule', when: 'before', table: 'incident', fields: ['short_description', 'active'] });
  const typo = problems.find((p) => p.ruleId === 'api-unknown-method');
  assert.equal(typo.severity, 'error');
  assert.equal(typo.line, 3);
  const edit = D.quickFixEdit(code, typo);
  assert.equal(code.slice(edit.from, edit.to), 'addQuerry');
  assert.equal(edit.insert, 'addQuery');
  const field = problems.find((p) => p.ruleId === 'unknown-field');
  assert.equal(field.fix.text, 'short_description');
  assert.equal(D.quickFixEdit(code.replace('addQuerry', 'addQuery('), typo), null, 'stale fixes are refused');
  assert.deepEqual(D.diagnose('', { kind: 'business_rule' }), []);
  assert.deepEqual(D.diagnose('x', { kind: 'nope' }), []);
  const counts = D.countProblems(problems);
  assert.equal(counts.error, problems.filter((p) => p.severity === 'error').length);
});

test('diagnose in quick mode runs only the syntax and API catalog checks', () => {
  const code = "var gr = new GlideRecord('incident');\ngr.addQuerry('a', 1);\ngr.query();\nfoo(;";
  const full = D.diagnose(code, { kind: 'background_script' });
  const quick = D.diagnose(code, { kind: 'background_script', quick: true });
  assert.ok(full.some((p) => !/^api-|^syntax-/.test(p.ruleId)), 'the full check includes lint and structure rules');
  assert.deepEqual([...new Set(quick.map((p) => p.ruleId))].sort(), ['api-unknown-method', 'syntax-error']);
  assert.equal(quick.find((p) => p.ruleId === 'api-unknown-method').fix.text, 'addQuery');
});

test('editorKind maps forms to verifier kinds', () => {
  assert.equal(D.editorKind('sys_script'), 'business_rule');
  assert.equal(D.editorKind('sys_script_client'), 'client_script');
  assert.equal(D.editorKind('sys_ui_action', { uiActionClient: true }), 'ui_action_client');
  assert.equal(D.editorKind('sys_ui_action', { uiActionClient: false }), 'background_script');
  assert.equal(D.editorKind('x_custom_table', { side: 'client' }), 'ui_script');
  assert.equal(D.editorKind('sys_script_fix', {}), 'background_script');
  assert.equal(D.sideOfKind('client_script'), 'client');
});

test('lexing and highlighting a 3000-line script is fast enough for every keystroke', () => {
  const block = "var gr = new GlideRecord('incident'); // q\ngr.addQuery('active', true);\n/* c */ gr.query();\nwhile (gr.next()) { gs.info(gr.getValue('number')); }\n";
  const big = block.repeat(750);
  const started = Date.now();
  for (let i = 0; i < 10; i += 1) {
    const info = T.analyze(`${big}${i}`);
    T.masked(info);
    for (let li = 1400; li < 1500; li += 1) T.lineTokens(info, li);
    T.matchBracket(info.text, 10);
  }
  const each = (Date.now() - started) / 10;
  assert.ok(each < 40, `lex + mask + 100 visible lines took ${each} ms`);
});

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
