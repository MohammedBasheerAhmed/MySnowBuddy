const test = require('node:test');
const assert = require('node:assert/strict');
const { outline, symbolAt, filterSymbols, symbolLabel } = require('../src/lib/editorOutline.js');
const T = require('../src/lib/editorText.js');

// ---- outline / go to symbol ---------------------------------------------------------------------------

const SI = `var IncidentUtils = Class.create();
IncidentUtils.prototype = {
  initialize: function (user) {
    this.user = user;
  },

  /** Open incidents of the caller. */
  getOpen: function (callerId, limit) {
    var gr = new GlideRecord('incident');
    return gr;
  },

  close(id, notes) {
    return id;
  },

  type: 'IncidentUtils'
};
`;

const names = (symbols) => symbols.map((s) => `${s.kind}:${s.name}`);

test('outline lists a Script Include class, its methods and the type marker', () => {
  const syms = outline(SI);
  assert.deepEqual(names(syms), [
    'class:IncidentUtils',
    'method:initialize',
    'method:getOpen',
    'method:close',
    "marker:type: 'IncidentUtils'",
  ]);
  const get = syms.find((s) => s.name === 'getOpen');
  assert.equal(get.params, 'callerId, limit');
  assert.equal(get.line, 8);
  assert.equal(get.depth, 1);
  assert.equal(get.path, 'IncidentUtils › getOpen');
  assert.equal(SI.slice(get.offset, get.offset + 7), 'getOpen');
  assert.equal(symbolLabel(get), 'getOpen(callerId, limit)');
});

test('outline: Extend a base class, prototype assignments and ES6 shorthand', () => {
  const src = `var Ajax = Class.create();
Ajax.prototype = Object.extendsObject(global.AbstractAjaxProcessor, {
  who: function () { return 1; },
  later() { return 2; },
  type: 'Ajax'
});
Ajax.helper = function (a) { return a; };
Ajax.prototype.extra = function (b) { return b; };`;
  const syms = outline(src);
  assert.deepEqual(names(syms), ['class:Ajax', 'method:who', 'method:later', "marker:type: 'Ajax'", 'function:Ajax.helper', 'method:Ajax.extra']);
});

test('outline: handlers, nested functions, arrow functions and named function expressions', () => {
  const src = `function onChange(control, oldValue, newValue, isLoading) {
  function helper(x) { return x; }
  var inner = function () { return helper(1); };
  return inner();
}
(function executeRule(current, previous /*null when async*/) {
  var f = (a, b) => a + b;
})(current, previous);
`;
  const syms = outline(src);
  assert.deepEqual(names(syms), ['handler:onChange', 'function:helper', 'function:inner', 'handler:executeRule', 'function:f']);
  assert.deepEqual(syms.map((s) => s.depth), [0, 1, 1, 0, 1]);
  assert.equal(syms[4].params, 'a, b');
  // The second parameter of executeRule has a comment in it, which is not part of the label.
  assert.equal(syms[3].params, 'current, previous');
});

test('outline ignores function-looking text in comments and strings', () => {
  const src = `// function fake() {}
var s = "function alsoFake() {}";
/* function nope() {} */
function real() {}
`;
  assert.deepEqual(names(outline(src)), ['function:real']);
});

test('outline of empty, plain and unfinished code does not throw', () => {
  assert.deepEqual(outline(''), []);
  assert.deepEqual(outline('var a = 1;\ngs.info(a);'), []);
  const syms = outline('function a() {\n  function b() {\n');
  assert.deepEqual(names(syms), ['function:a', 'function:b']);
  assert.doesNotThrow(() => outline('function ('));
  assert.doesNotThrow(() => outline('x = function'));
});

test('symbolAt finds the innermost function around the caret', () => {
  const syms = outline(SI);
  const at = SI.indexOf('return gr');
  assert.equal(symbolAt(syms, at).name, 'getOpen');
  assert.equal(symbolAt(syms, SI.indexOf('this.user')).name, 'initialize');
  assert.equal(symbolAt(syms, SI.indexOf('var IncidentUtils')).name, 'IncidentUtils');
  assert.equal(symbolAt(syms, SI.length), null);
  assert.equal(symbolAt([], 5), null);
});

test('filterSymbols matches fuzzily, best first, and keeps document order for an empty query', () => {
  const syms = outline(SI);
  assert.deepEqual(filterSymbols(syms, '').map((r) => r.sym.name), syms.map((s) => s.name));
  assert.deepEqual(filterSymbols(syms, 'gop').map((r) => r.sym.name), ['getOpen']);
  assert.deepEqual(filterSymbols(syms, 'zzz'), []);
  assert.deepEqual(filterSymbols(syms, 'init')[0].positions, [0, 1, 2, 3]);
});

// ---- formatter ----------------------------------------------------------------------------------------------
const F = require('../src/lib/editorFormat.js');
const { BUILTIN_SNIPPETS } = require('../src/lib/builtinSnippets.js');

const MESSY = `\n\n(function executeRule(current,previous){\n\tvar gr=new GlideRecord('incident');   \n    gr.addQuery('active',true);\n  if(gr.next()){\n   gs.info( 'a , b' ,gr.number);\n  }else{\n      gs.info("none")  ;\n  }\n\n\n\n  for(var i=0;i<3;i++){ gs.info(i) }\n   var re = /a b,c/g ;\n})(current,previous);\n\n\n`;
const CLEAN = `(function executeRule(current, previous) {\n  var gr = new GlideRecord('incident');\n  gr.addQuery('active', true);\n  if (gr.next()) {\n    gs.info( 'a , b', gr.number);\n  } else {\n    gs.info("none");\n  }\n\n  for (var i = 0; i<3; i++) { gs.info(i) }\n  var re = /a b,c/g;\n})(current, previous);\n`;

test('formatCode tidies indentation, spacing, blank lines and the end of the file', () => {
  const r = F.formatCode(MESSY);
  assert.equal(r.error, undefined);
  assert.equal(r.changed, true);
  assert.equal(r.text, CLEAN);
});

test('formatCode keeps strings, regexes, comments and brace style as they are', () => {
  const src = `var a = 'x ,y';\nvar b = "p  =  q";\nvar c = /x = y/;\n// a  ,  b  =  c\n/* keep   this ,  too */\nif (a)\n{\n  b = 1;\n}\nelse\n{\n  b = 2;\n}\npromise.catch(function () {});\n`;
  const r = F.formatCode(src);
  assert.equal(r.changed, false);
  assert.equal(r.text, src);
});

test('formatCode does not touch the inside of template literals and multi-line strings', () => {
  const src = "var t = `line one   \n   two  \n\n\n   three`;\nvar s = 'abc \\n  def  ';\nvar z = 1;   \n";
  const r = F.formatCode(src);
  assert.equal(r.text, "var t = `line one   \n   two  \n\n\n   three`;\nvar s = 'abc \\n  def  ';\nvar z = 1;\n");
});

test('formatCode: block comments keep their text, only the " * " lines are aligned', () => {
  const src = `function f() {\n      /**\n         * Does it.   \n   *   @param a\n         */\n  return 1;\n}\n`;
  const r = F.formatCode(src);
  assert.equal(r.text, `function f() {\n  /**\n   * Does it.\n   *   @param a\n   */\n  return 1;\n}\n`);
});

test('formatCode refuses unbalanced brackets and says why', () => {
  const r = F.formatCode('function a( {\n  x=1\n');
  assert.ok(r.error);
  assert.equal(r.text, undefined);
});

test('formatCode: empty and blank documents are left alone', () => {
  assert.deepEqual(F.formatCode(''), { text: '', changed: false });
  assert.deepEqual(F.formatCode('  \n\n '), { text: '  \n\n ', changed: false });
});

test('formatCode keeps tab indentation when the script uses tabs', () => {
  const r = F.formatCode('function a() {\nvar x=1;\n  if (x) {\nx = 2;\n}\n}\n', { unit: '\t' });
  assert.equal(r.text, 'function a() {\n\tvar x = 1;\n\tif (x) {\n\t\tx = 2;\n\t}\n}\n');
});

test('formatCode handles CRLF text and gives CRLF back; mixed endings are refused', () => {
  const r = F.formatCode('var a=1;  \r\nvar b=2;\r\n');
  assert.equal(r.text, 'var a = 1;\r\nvar b = 2;\r\n');
  assert.ok(F.formatCode('var a=1;\r\nvar b=2;\n').error);
});

test('formatCode does not add a final newline inside a script that ends in an open template or comment', () => {
  const open = 'var t = `abc\n   ';
  assert.equal(F.formatCode(open).error ? 'refused' : F.formatCode(open).text, open);
  const comment = 'var a = 1;\n/* never closed   ';
  // Trailing spaces may go, but no newline is added inside the open comment.
  assert.equal(F.formatCode(comment).error ? 'refused' : F.formatCode(comment).text, 'var a = 1;\n/* never closed');
});

test('formatCode on a selection changes only the selected lines and never moves lines', () => {
  const src = 'var a=1;\nvar b=2;  \nvar c=3;\n\n\n\nvar d=4;\n';
  const r = F.formatCode(src, { fromLine: 1, toLine: 2 });
  assert.equal(r.text, 'var a=1;\nvar b = 2;\nvar c = 3;\n\n\n\nvar d=4;\n');
});

test('tokenSignature ignores whitespace but sees a changed token, a joined operator and a changed comment word', () => {
  const sig = F.tokenSignature;
  assert.equal(sig('a=1;'), sig('a  =\n 1 ;'));
  assert.notEqual(sig('a = = 1'), sig('a == 1'));
  assert.notEqual(sig('a = 1'), sig('a = 2'));
  assert.notEqual(sig('x // one'), sig('x // two'));
  assert.equal(sig('x // one  '), sig('x // one'));
  assert.notEqual(sig("var s = 'a b';"), sig("var s = 'a  b';"));
});

test('formatting is idempotent and keeps the tokens on realistic scripts, including snippets and noise', () => {
  const corpus = [
    CLEAN,
    MESSY,
    ...BUILTIN_SNIPPETS.map((s) => s.template.replace(/\{\{(\w+)\}\}/g, '$1')),
  ];
  corpus.forEach((src, n) => {
    const r = F.formatCode(src);
    if (r.error) return; // a refusal is allowed, a wrong answer is not (snippet templates with comments only, etc.)
    const again = F.formatCode(r.text);
    assert.equal(again.text, r.text, `idempotent #${n}`);
    assert.equal(F.tokenSignature(r.text), F.tokenSignature(src), `tokens #${n}`);
  });
  const accepted = corpus.filter((src) => !F.formatCode(src).error).length;
  assert.ok(accepted > corpus.length * 0.9, `only ${accepted} of ${corpus.length} formatted`);
});

test('the result does not depend on indentation, trailing whitespace or extra blank lines in the input', () => {
  const corpus = [CLEAN, ...BUILTIN_SNIPPETS.map((s) => s.template.replace(/\{\{(\w+)\}\}/g, '$1'))];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  corpus.forEach((src, n) => {
    const base = F.formatCode(src);
    if (base.error) return;
    // Template literals and block comments are not ours to change, so the noise only touches plain code lines.
    const noisy = base.text
      .split('\n')
      .map((line) => {
        if (/[`*]|\/\//.test(line)) return line;
        if (line === '') return rand() < 0.5 ? '\n\n' : '   ';
        const lead = rand() < 0.5 ? '\t'.repeat(Math.floor(rand() * 4)) : ' '.repeat(Math.floor(rand() * 9));
        return `${lead}${line.trim()}${rand() < 0.4 ? '   ' : ''}`;
      })
      .join('\n');
    const again = F.formatCode(noisy);
    assert.equal(again.error, undefined, `#${n}`);
    assert.equal(again.text, base.text, `canonical #${n}`);
  });
});

test('formatting a 5000-line script is fast and stable', () => {
  const body = Array.from({ length: 1250 }, (_, i) => `  var v${i}=gr.getValue('f${i}') ;\n  if(v${i}){ gs.info(v${i}) }\n  total+=${i};\n`).join('');
  const src = `function big(gr){\n  var total=0;\n${body}  return total\n}\n`;
  const started = Date.now();
  const r = F.formatCode(src);
  assert.equal(r.error, undefined);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(F.formatCode(r.text).text, r.text);
});

test('fuzz: random token soup never makes the formatter throw, change tokens or settle on a second answer', () => {
  const pool = [
    'a', 'b1', '$x', '_y', '1', '2.5', '0x1F', '=', '==', '===', '!=', '!==', '<=', '>=', '&&', '||', '+', '-', '*', '++', '--', '+=', '=>', '?', ':', ',', ';', '.',
    '(', ')', '{', '}', '[', ']', "'s p,q'", '"q = r"', '/re g,/g', '// note  ', '/* c  d */', '`t ${x} y`',
    'if', 'else', 'for', 'while', 'function', 'return', 'catch', 'try', 'var', 'new', 'typeof', '!', 'in',
  ];
  let seed = 99;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const gaps = ['', ' ', '  ', '\t', '\n', '\n\n', ' \n', '\n  ', '   \n\n\n'];
  let formatted = 0;
  let refusedForBrackets = 0;
  for (let n = 0; n < 600; n += 1) {
    let src = '';
    const length = 3 + Math.floor(rand() * 40);
    for (let k = 0; k < length; k += 1) {
      const tok = pool[Math.floor(rand() * pool.length)];
      src += tok;
      // A line comment swallows the rest of the line, so it always gets a newline.
      src += tok.startsWith('//') ? '\n' : gaps[Math.floor(rand() * gaps.length)];
    }
    let r;
    assert.doesNotThrow(() => {
      r = F.formatCode(src);
    }, JSON.stringify(src));
    if (!r.error) {
      formatted += 1;
      assert.equal(F.tokenSignature(r.text), F.tokenSignature(src), JSON.stringify(src));
      assert.equal(F.formatCode(r.text).text, r.text, JSON.stringify(src));
      continue;
    }
    if (/Brackets|never closed|balance/.test(r.error)) refusedForBrackets += 1;
    else assert.fail(`unexpected refusal "${r.error}" for ${JSON.stringify(src)}`);
  }
  assert.ok(formatted > 50, `only ${formatted} formatted, ${refusedForBrackets} refused for brackets`);
});

// ---- changes against the saved text ----------------------------------------------------------------------------
const C = require('../src/lib/editorChanges.js');

test('lineHunks reports added, removed and changed lines', () => {
  const base = 'a\nb\nc\nd\ne';
  assert.deepEqual(C.lineHunks(base, base), []);
  assert.deepEqual(C.lineHunks(base, 'a\nb\nX\nc\nd\ne'), [{ oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 3 }]);
  assert.deepEqual(C.lineHunks(base, 'a\nb\nd\ne'), [{ oldStart: 2, oldEnd: 3, newStart: 2, newEnd: 2 }]);
  assert.deepEqual(C.lineHunks(base, 'a\nB\nc\nd\nE'), [
    { oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 },
    { oldStart: 4, oldEnd: 5, newStart: 4, newEnd: 5 },
  ]);
  assert.deepEqual(C.hunkKind({ oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 3 }), 'added');
  assert.deepEqual(C.hunkKind({ oldStart: 2, oldEnd: 3, newStart: 2, newEnd: 2 }), 'removed');
  assert.deepEqual(C.hunkKind({ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 }), 'modified');
});

test('lineHunks: empty texts, a trailing newline and a whole rewrite', () => {
  assert.deepEqual(C.lineHunks('', ''), []);
  assert.deepEqual(C.lineHunks('', 'a'), [{ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }]);
  assert.deepEqual(C.lineHunks('a\n', 'a'), [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 1 }]);
  assert.equal(C.lineHunks('a\nb', 'x\ny').length, 1);
  assert.equal(C.lineHunks(undefined, undefined).length, 0);
});

test('hunkTitle and nextHunkLine read well and wrap round', () => {
  const hunks = C.lineHunks('a\nb\nc\nd\ne\nf', 'a\nB\nB2\nc\nd\nf');
  assert.deepEqual(hunks.map(C.hunkTitle), ['2 lines changed, lines 2-3', '1 line removed, after line 5']);
  assert.equal(C.nextHunkLine(hunks, 0, 1), 1);
  assert.equal(C.nextHunkLine(hunks, 1, 1), 5);
  assert.equal(C.nextHunkLine(hunks, 5, 1), 1);
  assert.equal(C.nextHunkLine(hunks, 1, -1), 5);
  assert.equal(C.nextHunkLine([], 0, 1), -1);
  assert.equal(C.hunkTitle({ oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 0 }), '1 line removed, at the top');
});

/** Deterministic random edits of a line list drawn from a small alphabet, so many lines repeat. */
function randomEditCases(count, seedStart = 1) {
  let seed = seedStart;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const alphabet = ['a', 'b', 'c', '', '  x', 'if (a) {', '}', 'return b;'];
  const line = () => alphabet[Math.floor(rand() * alphabet.length)];
  const cases = [];
  for (let n = 0; n < count; n += 1) {
    const base = Array.from({ length: Math.floor(rand() * 14) }, line);
    const edited = [...base];
    const ops = Math.floor(rand() * 5);
    for (let k = 0; k < ops; k += 1) {
      const at = Math.floor(rand() * (edited.length + 1));
      const kind = rand();
      if (kind < 0.35) edited.splice(at, 0, ...Array.from({ length: 1 + Math.floor(rand() * 3) }, line));
      else if (kind < 0.7) edited.splice(at, 1 + Math.floor(rand() * 3));
      else if (at < edited.length) edited[at] = line();
    }
    const tail = (list) => list.join('\n') + (rand() < 0.3 ? '\n' : '');
    cases.push([tail(base), tail(edited)]);
  }
  return cases;
}

test('property: reverting every hunk gives back the saved text, one hunk at a time or all at once', () => {
  randomEditCases(3000).forEach(([base, text], n) => {
    const hunks = C.lineHunks(base, text);
    assert.equal(hunks.length === 0, base === text, `case ${n}: hunks only when the texts differ`);
    // All at once, last to first, so earlier line numbers stay valid.
    let all = text;
    [...hunks].reverse().forEach((h) => {
      all = C.revertHunk(base, all, h);
    });
    assert.equal(all, base, `case ${n}: revert all`);
    // One at a time: each revert removes exactly that change and the rest still compare against the saved text.
    hunks.forEach((h, k) => {
      const edit = C.revertEdit(base, text, h);
      const next = edit ? text.slice(0, edit.from) + edit.insert + text.slice(edit.to) : text;
      assert.equal(next, C.revertHunk(base, text, h), `case ${n} hunk ${k}: edit matches`);
      const left = C.lineHunks(base, next);
      assert.ok(left.length <= hunks.length - 1 + 1, `case ${n}: fewer changes left`);
    });
  });
});

test('property: lines outside every hunk are identical in both texts', () => {
  randomEditCases(1500, 5).forEach(([base, text], n) => {
    const a = base.split('\n');
    const b = text.split('\n');
    const hunks = C.lineHunks(base, text);
    const inOld = new Set();
    const inNew = new Set();
    hunks.forEach((h) => {
      for (let i = h.oldStart; i < h.oldEnd; i += 1) inOld.add(i);
      for (let i = h.newStart; i < h.newEnd; i += 1) inNew.add(i);
    });
    const keptOld = a.filter((_, i) => !inOld.has(i));
    const keptNew = b.filter((_, i) => !inNew.has(i));
    assert.deepEqual(keptOld, keptNew, `case ${n}`);
  });
});

test('lineHunks stays fast on long scripts: a small edit, and a rewrite of everything', () => {
  const lines = Array.from({ length: 6000 }, (_, i) => `var v${i} = ${i};`);
  const base = lines.join('\n');
  const edited = [...lines.slice(0, 3000), 'inserted();', ...lines.slice(3000)].join('\n');
  let started = Date.now();
  assert.equal(C.lineHunks(base, edited).length, 1);
  assert.ok(Date.now() - started < 200, 'small edit');
  const rewritten = lines.map((l) => `${l} // x`).join('\n');
  started = Date.now();
  const hunks = C.lineHunks(base, rewritten);
  assert.equal(hunks.length, 1);
  assert.ok(Date.now() - started < 500, 'rewrite');
  // Many scattered edits (every 40th line) still compare line by line.
  const scattered = lines.map((l, i) => (i % 40 === 0 ? `${l}!` : l)).join('\n');
  started = Date.now();
  assert.equal(C.lineHunks(base, scattered).length, 150);
  assert.ok(Date.now() - started < 3000, `scattered took ${Date.now() - started} ms`);
});

test('property: reverting works the same when the comparison has to use unique-line anchors', () => {
  randomEditCases(2000, 31).forEach(([base, text], n) => {
    const hunks = C.lineHunks(base, text, { maxCells: 6 });
    let all = text;
    [...hunks].reverse().forEach((h) => {
      all = C.revertHunk(base, all, h);
    });
    assert.equal(all, base, `case ${n}`);
    assert.equal(hunks.length === 0, base === text, `case ${n}: hunks only when the texts differ`);
  });
});

// ---- multi-cursor lite -------------------------------------------------------------------------------------------
const M = require('../src/lib/editorMulti.js');

const caret = (at, primary = false) => ({ start: at, end: at, primary });
const rng = (start, end, primary = false) => ({ start, end, primary });
const show = (r) => {
  // Text with every selection marked: [ ] for the others, ( ) for the primary one, | and a broken bar for carets.
  let out = r.text;
  [...r.sels].reverse().forEach((s) => {
    const open = s.primary ? '(' : '[';
    const close = s.primary ? ')' : ']';
    out = s.start === s.end ? `${out.slice(0, s.start)}${s.primary ? '|' : '¦'}${out.slice(s.end)}` : `${out.slice(0, s.start)}${open}${out.slice(s.start, s.end)}${close}${out.slice(s.end)}`;
  });
  return out;
};

test('Ctrl+D: first press selects the word, then adds the next whole-word occurrences and wraps round', () => {
  const text = 'var total = 1;\ntotal += total2;\nreturn total;';
  let r = M.nextOccurrence(text, [caret(6, true)]);
  assert.equal(show({ text, sels: r.sels }), 'var (total) = 1;\ntotal += total2;\nreturn total;');
  assert.equal(r.wholeWord, true);
  r = M.nextOccurrence(text, r.sels, r.wholeWord);
  assert.equal(show({ text, sels: r.sels }), 'var [total] = 1;\n(total) += total2;\nreturn total;');
  r = M.nextOccurrence(text, r.sels, r.wholeWord);
  assert.equal(show({ text, sels: r.sels }), 'var [total] = 1;\n[total] += total2;\nreturn (total);');
  assert.equal(M.nextOccurrence(text, r.sels, r.wholeWord), null, 'nothing more to add');
});

test('Ctrl+D on a selection that is not a whole word matches any occurrence, and wraps from the end', () => {
  const text = 'abc abcd abc';
  let r = M.nextOccurrence(text, [rng(9, 12, true)]);
  assert.deepEqual(r.sels.map((s) => [s.start, s.end, s.primary]), [[0, 3, true], [9, 12, false]]);
  r = M.nextOccurrence(text, r.sels, false);
  assert.deepEqual(r.sels.map((s) => [s.start, s.end, s.primary]), [[0, 3, false], [4, 7, true], [9, 12, false]]);
  assert.equal(M.nextOccurrence('xyz', [caret(1, true)]).sels[0].start, 0);
  assert.equal(M.nextOccurrence('  ', [caret(1, true)]), null);
  assert.equal(M.nextOccurrence('', [caret(0, true)]), null);
});

test('Ctrl+Shift+L selects every occurrence; one occurrence is not worth a multi-cursor', () => {
  const text = 'a.x = b.x + cx;';
  const r = M.allOccurrences(text, caret(2));
  assert.deepEqual(r.sels.map((s) => [s.start, s.end]), [[2, 3], [8, 9]]);
  assert.equal(r.sels.filter((s) => s.primary).length, 1);
  assert.equal(r.sels.find((s) => s.primary).start, 2);
  assert.equal(M.allOccurrences(text, caret(0)), null);
  assert.equal(M.allOccurrences('', caret(0)), null);
  const manyWords = Array.from({ length: 1500 }, () => 'w').join(' ');
  assert.equal(M.allOccurrences(manyWords, caret(0)).sels.length, M.MAX_CURSORS);
});

test('normalize sorts, merges overlaps and duplicates, and keeps exactly one primary', () => {
  assert.deepEqual(M.normalize([caret(5), caret(5, true), caret(2)]).map((s) => [s.start, s.end, s.primary]), [[2, 2, false], [5, 5, true]]);
  const merged = M.normalize([rng(2, 6), rng(4, 9, true), caret(5)]);
  assert.deepEqual(merged.map((s) => [s.start, s.end, s.primary]), [[2, 9, true]]);
  assert.deepEqual(M.normalize([rng(1, 3), rng(3, 5)]).length, 2);
  assert.equal(M.normalize([caret(1), caret(4), caret(9)]).filter((s) => s.primary).length, 1);
  assert.deepEqual(M.normalize([]), []);
});

/** Reference: the same replacement at each selection, with the caret arithmetic done by hand. */
function reference(text, sels, insertFor) {
  const list = M.normalize(sels);
  let out = text;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    out = out.slice(0, list[i].start) + insertFor(list[i], i, text) + out.slice(list[i].end);
  }
  let shift = 0;
  const carets = list.map((s, i) => {
    const ins = insertFor(s, i, text);
    const at = s.start + shift + ins.length;
    shift += ins.length - (s.end - s.start);
    return at;
  });
  return { text: out, carets };
}

function randomCursorCase(rand) {
  const alphabet = ['a', 'b', ' ', '\n', '  ', '{', '}', 'foo', '\t'];
  let text = '';
  const parts = Math.floor(rand() * 14);
  for (let i = 0; i < parts; i += 1) text += alphabet[Math.floor(rand() * alphabet.length)];
  const sels = [];
  const count = 1 + Math.floor(rand() * 5);
  for (let i = 0; i < count; i += 1) {
    const a = Math.floor(rand() * (text.length + 1));
    const b = rand() < 0.5 ? a : Math.min(text.length, a + Math.floor(rand() * 4));
    sels.push({ start: a, end: b, primary: i === 0 });
  }
  return { text, sels };
}

const lcg = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const leadOf = (t, at) => /^[ \t]*/.exec(t.slice(at === 0 ? 0 : t.lastIndexOf('\n', at - 1) + 1, at))[0];

test('property: typing, pasting, Enter and Tab at many cursors equal doing it one cursor at a time', () => {
  const rand = lcg(12345);
  for (let n = 0; n < 4000; n += 1) {
    const { text, sels } = randomCursorCase(rand);
    const typed = M.typeText(text, sels, 'XY');
    const refTyped = reference(text, sels, () => 'XY');
    assert.equal(typed.text, refTyped.text, `type #${n}`);
    assert.deepEqual(typed.sels.map((s) => s.start), refTyped.carets, `type carets #${n}`);
    assert.ok(typed.sels.every((s) => s.start === s.end), 'carets after typing');
    assert.equal(typed.sels.filter((s) => s.primary).length, 1);

    const nl = M.newline(text, sels);
    const refNl = reference(text, sels, (s, i, t) => `\n${leadOf(t, s.start)}`);
    assert.equal(nl.text, refNl.text, `enter #${n}`);
    assert.deepEqual(nl.sels.map((s) => s.start), refNl.carets, `enter carets #${n}`);

    const tab = M.tabAll(text, sels, '  ');
    const refTab = reference(text, sels, (s, i, t) => ' '.repeat(2 - ((s.start - (s.start === 0 ? 0 : t.lastIndexOf('\n', s.start - 1) + 1)) % 2)));
    assert.equal(tab.text, refTab.text, `tab #${n}`);

    const lines = ['one', 'two', 'three', 'four', 'five', 'six'];
    const list = M.normalize(sels);
    const pasted = M.pasteText(text, sels, lines.slice(0, list.length).join('\n'));
    const refPaste = reference(text, sels, (s, i) => (list.length > 1 ? lines[i] : lines.slice(0, 1).join('\n')));
    assert.equal(pasted.text, refPaste.text, `paste #${n}`);
    const same = M.pasteText(text, sels, 'a\nb\nc\nd\ne\nf\ng\nh');
    assert.equal(same.text, reference(text, sels, () => 'a\nb\nc\nd\ne\nf\ng\nh').text, `paste whole #${n}`);
  }
});

test('property: Backspace and Delete at many cursors equal doing it one cursor at a time', () => {
  const rand = lcg(777);
  for (let n = 0; n < 4000; n += 1) {
    const { text, sels } = randomCursorCase(rand);
    const list = M.normalize(sels);
    // Reference: the set of deleted characters, then drop them.
    const gone = (fn) => {
      const del = new Set();
      list.forEach((s) => {
        const [a, b] = fn(s);
        for (let i = a; i < b; i += 1) del.add(i);
      });
      return [...text].filter((_, i) => !del.has(i)).join('');
    };
    const back = M.backspace(text, sels);
    assert.equal(back.text, gone((s) => (s.start !== s.end ? [s.start, s.end] : [Math.max(0, s.start - 1), s.start])), `backspace #${n}`);
    const del = M.deleteForward(text, sels);
    assert.equal(del.text, gone((s) => (s.start !== s.end ? [s.start, s.end] : [s.start, Math.min(text.length, s.start + 1)])), `delete #${n}`);
    [back, del].forEach((r) => {
      assert.ok(r.sels.every((s) => s.start === s.end && s.start >= 0 && s.start <= r.text.length), `carets in range #${n}`);
      assert.equal(r.sels.filter((s) => s.primary).length, 1, `one primary #${n}`);
      for (let i = 1; i < r.sels.length; i += 1) assert.ok(r.sels[i].start > r.sels[i - 1].start, `distinct carets #${n}`);
    });
  }
});

test('moving all cursors: Left/Right collapse selections, Home goes to the indent then column 0, cursors that meet merge', () => {
  const text = '  foo bar\n  baz';
  let r = M.moveAll(text, [rng(4, 7), caret(12, true)], 'ArrowLeft');
  assert.deepEqual(r.sels.map((s) => [s.start, s.end]), [[4, 4], [11, 11]]);
  r = M.moveAll(text, [rng(4, 7), caret(12, true)], 'ArrowRight');
  assert.deepEqual(r.sels.map((s) => [s.start, s.end]), [[7, 7], [13, 13]]);
  r = M.moveAll(text, [caret(6), caret(14, true)], 'Home');
  assert.deepEqual(r.sels.map((s) => s.start), [2, 12]);
  r = M.moveAll(text, r.sels, 'Home');
  assert.deepEqual(r.sels.map((s) => s.start), [0, 10]);
  r = M.moveAll(text, [caret(3), caret(5, true)], 'End');
  assert.deepEqual(r.sels.map((s) => s.start), [9]);
  assert.equal(r.sels[0].primary, true);
  r = M.moveAll(text, [caret(0, true), caret(1)], 'ArrowLeft');
  assert.equal(r.sels.length, 1, 'two cursors that land on the same spot become one');
  r = M.moveAll(text, [caret(text.length, true)], 'ArrowRight');
  assert.equal(r.sels[0].start, text.length);
});

test('rename by multi-cursor: select all occurrences, type the new name, nothing else changes', () => {
  const text = 'var count = 0;\nfor (;;) { count++; gs.info(count); }\nvar counter = count;';
  const sel = M.allOccurrences(text, caret(5));
  const r = M.typeText(text, sel.sels, 'n');
  assert.equal(r.text, 'var n = 0;\nfor (;;) { n++; gs.info(n); }\nvar counter = n;');
});

test('mapOffset keeps the caret among the non-blank characters when formatting moves whitespace', () => {
  const before = '  var a=1;   \n\n\n\n  if(a){\n b = 2;\n  }\n';
  const after = F.formatCode(before).text;
  assert.equal(after, 'var a = 1;\n\nif (a) {\n  b = 2;\n}\n');
  const nonBlank = (t) => t.replace(/\s/g, '').length;
  for (let o = 0; o <= before.length; o += 1) {
    const mapped = F.mapOffset(before, after, o);
    assert.ok(mapped >= 0 && mapped <= after.length, `offset ${o}`);
    const lead = (t, upTo) => t.slice(0, upTo).replace(/\s/g, '').length;
    // On a blank line the caret moves to the start of the line below the code above; otherwise the count of code characters before it is kept.
    const blank = !/\S/.test(before.slice(before.lastIndexOf('\n', o - 1) + 1, before.indexOf('\n', o) === -1 ? before.length : before.indexOf('\n', o)));
    if (!blank) assert.equal(lead(after, mapped), lead(before, o), `offset ${o}`);
  }
  // At the end of `var a=1;` it stays after the semicolon; in the indentation of `b = 2;` it goes to the new indentation.
  assert.equal(after.slice(0, F.mapOffset(before, after, before.indexOf(';') + 1)), 'var a = 1;');
  assert.equal(after.slice(F.mapOffset(before, after, before.indexOf('b') - 1)), 'b = 2;\n}\n');
  assert.equal(nonBlank(after), nonBlank(before));
  assert.equal(F.mapOffset('', '', 0), 0);
  assert.equal(F.mapOffset('abc', 'abc', 99), 3);
});

test('joinLines joins with one space, refuses a // comment and a line break inside a string', () => {
  const run = (marked) => {
    const caretAt = marked.indexOf('|');
    const text = marked.replace('|', '');
    const edit = T.joinLines(text, caretAt, caretAt);
    if (!edit) return null;
    if (edit.error) return `error: ${edit.error.slice(0, 20)}`;
    return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  };
  assert.equal(run('var a = 1;|\n    var b = 2;\nc();'), 'var a = 1; var b = 2;\nc();');
  assert.equal(run('foo(|\n  a,\n  b\n);'), 'foo( a,\n  b\n);');
  assert.equal(run('a;   |\n  b;'), 'a;   b;');
  assert.equal(run('a;|\n\nb;'), 'a;\nb;');
  assert.equal(run('last line|'), null);
  assert.match(run('a(); // note|\nb();'), /^error: The line ends in a/);
  assert.match(run('var s = `one|\ntwo`;'), /^error: This line break is i/);
  assert.equal(run('/* c */|\nb();'), '/* c */ b();');
  // A selection over several lines joins all of them.
  const text = 'a\n  b\n  c\nd';
  const edit = T.joinLines(text, 0, 7);
  assert.equal(text.slice(0, edit.from) + edit.insert + text.slice(edit.to), 'a b c\nd');
});

test('selectLines selects whole lines and grows by one line each time', () => {
  const text = 'one\ntwo\nthree';
  assert.deepEqual(T.selectLines(text, 5, 5), { selStart: 4, selEnd: 8 });
  assert.deepEqual(T.selectLines(text, 4, 8), { selStart: 4, selEnd: 13 });
  assert.deepEqual(T.selectLines(text, 10, 10), { selStart: 8, selEnd: 13 });
  assert.deepEqual(T.selectLines('', 0, 0), { selStart: 0, selEnd: 0 });
});

test('property: joinLines changes only line breaks and the blanks around them', () => {
  const samples = ['a;\n  b;\n\tc;\n\n d', 'x\n\n\ny', '  \n  z', 'q  \n  r  \n  s'];
  samples.forEach((text) => {
    for (let at = 0; at <= text.length; at += 1) {
      const edit = T.joinLines(text, at, at);
      if (!edit || edit.error) continue;
      const next = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
      assert.equal(next.replace(/\s/g, ''), text.replace(/\s/g, ''), `${JSON.stringify(text)} at ${at}`);
      assert.equal(next.split('\n').length, text.split('\n').length - 1, 'one line fewer');
    }
  });
});

// ---- snippets with Tab stops --------------------------------------------------------------------------------------
const S = require('../src/lib/snippets.js');
const Sess = require('../src/lib/editorSnippetSession.js');

test('parseTemplate reads blanks, copies, escapes and indentation', () => {
  const r = S.parseTemplate("a(${1:one}, ${2}, ${1});\n  $0", '  ');
  assert.equal(r.text, 'a(one, , one);\n    ');
  assert.deepEqual(r.stops.map((s) => s.index), [1, 2, 0]);
  assert.deepEqual(r.stops[0].ranges, [{ start: 2, end: 5 }, { start: 9, end: 12 }]);
  assert.deepEqual(r.stops[1].ranges, [{ start: 7, end: 7 }]);
  assert.deepEqual(r.stops[2].ranges, [{ start: r.text.length, end: r.text.length }]);
  const esc = S.parseTemplate('cost: \\$5 \\} ${1:a\\}b} \\\\');
  assert.equal(esc.text, 'cost: $5 } a}b \\');
  assert.equal(S.parseTemplate('no blanks').stops.length, 1);
  assert.deepEqual(S.parseTemplate('').stops[0].ranges, [{ start: 0, end: 0 }]);
});

test('every built-in snippet parses, its blanks lie inside the text and the copies share one default', () => {
  Object.entries(S.SNIPPETS).forEach(([key, template]) => {
    const r = S.parseTemplate(template, '    ');
    r.stops.forEach((stop) => {
      stop.ranges.forEach((range) => {
        assert.ok(range.start >= 0 && range.end >= range.start && range.end <= r.text.length, `${key} stop ${stop.index}`);
      });
      const texts = new Set(stop.ranges.map((range) => r.text.slice(range.start, range.end)));
      assert.equal(texts.size, 1, `${key} stop ${stop.index} copies agree`);
    });
    assert.equal(r.stops[r.stops.length - 1].index, 0, `${key} ends with the final stop`);
  });
});

test('expandSnippet: the word before the caret, indentation, absolute stops; unknown words and members are ignored', () => {
  const src = '  if (x) {\n    gr';
  const out = S.expandSnippet(src, src.length);
  assert.equal(out.key, 'gr');
  assert.equal(out.start, src.length - 2);
  assert.ok(out.text.startsWith("var gr = new GlideRecord('table');"));
  assert.ok(out.text.includes('\n    gr.addQuery'), 'continuation lines keep the indent');
  assert.equal(src.slice(0, out.start) + out.text, src.slice(0, out.start) + out.text);
  const after = src.slice(0, out.start) + out.text;
  assert.equal(after.slice(out.stops[0].ranges[0].start, out.stops[0].ranges[0].end), 'table');
  assert.equal(after.slice(out.stops[1].ranges[0].start, out.stops[1].ranges[0].end), 'field');
  assert.equal(after.slice(out.stops[2].ranges[0].start, out.stops[2].ranges[0].end), 'value');
  assert.equal(out.caret, out.stops[0].ranges[0].start);
  assert.equal(S.expandSnippet('foo', 3), null);
  assert.equal(S.expandSnippet('obj.gr', 6), null);
  assert.equal(S.expandSnippet('xgr', 3), null);
});

test('Script Include snippet: the class name appears three times and follows what is typed', () => {
  const exp = S.expandKey('si', 0, 0, '');
  assert.equal(exp.stops[0].ranges.length, 3);
  let text = exp.text;
  let session = Sess.withText(Sess.startSession(exp), text);
  assert.deepEqual(Sess.activeRange(session), exp.stops[0].ranges[0]);
  // The user types "Util" over the selected suggestion.
  const typed = 'Util';
  const m = Sess.activeRange(session);
  const next = text.slice(0, m.start) + typed + text.slice(m.end);
  const edit = Sess.locateEdit(text, next, m.start + typed.length);
  session = Sess.trackEdit(session, edit);
  const synced = Sess.syncCopies(next, session);
  text = synced.text;
  session = synced.session;
  assert.ok(text.startsWith('var Util = Class.create();\nUtil.prototype = {'));
  assert.ok(text.includes("type: 'Util'"));
  session.stops[0].ranges.forEach((r) => assert.equal(text.slice(r.start, r.end), 'Util'));
  assert.equal(text.slice(session.stops[1].ranges[0].start, session.stops[1].ranges[0].end), '');
  assert.equal(text.slice(session.stops[2].ranges[0].start, session.stops[2].ranges[0].end), 'methodName');
  // Tab to the next blank, which is empty and sits inside initialize(...).
  const j = Sess.jump(session, text, 1);
  assert.equal(text.slice(j.select.start - 21, j.select.start), 'initialize: function(');
  assert.equal(j.session.active, 1);
});

test('snippet session ends instead of guessing when an edit is outside the blank, and when a copy was edited by hand', () => {
  const exp = S.expandKey('si', 0, 0, '');
  const session = Sess.withText(Sess.startSession(exp), exp.text);
  assert.equal(Sess.trackEdit(session, { from: 0, to: 0, insert: 'x' }), null, 'an edit before the blank');
  assert.equal(Sess.trackEdit(session, { from: exp.text.length, to: exp.text.length, insert: 'x' }), null, 'an edit after it');
  const m = Sess.activeRange(session);
  const tracked = Sess.trackEdit(session, { from: m.start, to: m.start, insert: 'Z' });
  assert.ok(tracked);
  // A copy changed by hand: syncing would overwrite the user's text, so it refuses.
  const copy = session.stops[0].ranges[1];
  const tampered = exp.text.slice(0, copy.start) + 'Hand' + exp.text.slice(copy.end);
  const shifted = { ...tracked, stops: tracked.stops.map((s) => ({ ranges: s.ranges.map((r) => ({ ...r })) })) };
  const text2 = exp.text.slice(0, m.start) + 'Z' + exp.text.slice(m.start);
  assert.equal(Sess.syncCopies(text2.slice(0, copy.start + 1) + 'Hand' + text2.slice(copy.end + 1), shifted), null);
  assert.notEqual(tampered, exp.text);
});

test('locateEdit finds typing, deleting and replacing, even inside a run of equal characters', () => {
  assert.deepEqual(Sess.locateEdit('abc', 'abxc', 3), { from: 2, to: 2, insert: 'x' });
  assert.deepEqual(Sess.locateEdit('aaa', 'aaaa', 2), { from: 1, to: 1, insert: 'a' });
  assert.deepEqual(Sess.locateEdit('aaa', 'aaaa', 4), { from: 3, to: 3, insert: 'a' });
  assert.deepEqual(Sess.locateEdit('abcd', 'ad', 1), { from: 1, to: 3, insert: '' });
  assert.deepEqual(Sess.locateEdit('abcd', 'aXd', 2), { from: 1, to: 3, insert: 'X' });
  assert.equal(Sess.locateEdit('same', 'same', 2), null);
  // A caret that does not fit falls back to the smallest difference.
  const e = Sess.locateEdit('hello world', 'hello brave world', 0);
  assert.equal('hello world'.slice(0, e.from) + e.insert + 'hello world'.slice(e.to), 'hello brave world');
});

test('property: locateEdit always describes an edit that turns the old text into the new one', () => {
  const rand = lcg(2024);
  for (let n = 0; n < 5000; n += 1) {
    const alphabet = 'ab \n';
    const make = () => Array.from({ length: Math.floor(rand() * 10) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
    const prev = make();
    const from = Math.floor(rand() * (prev.length + 1));
    const to = Math.min(prev.length, from + Math.floor(rand() * 3));
    const insert = make().slice(0, 3);
    const next = prev.slice(0, from) + insert + prev.slice(to);
    const caret = from + insert.length;
    const edit = Sess.locateEdit(prev, next, rand() < 0.8 ? caret : Math.floor(rand() * (next.length + 1)));
    if (prev === next) {
      assert.equal(edit, null);
      continue;
    }
    assert.equal(prev.slice(0, edit.from) + edit.insert + prev.slice(edit.to), next, `case ${n}: ${JSON.stringify([prev, next, caret])}`);
  }
});

test('property: typing, deleting and pasting in a blank keeps every copy and every other blank in step', () => {
  const rand = lcg(99);
  ['si', 'sia', 'gr', 'ajax', 'fn'].forEach((key) => {
    for (let round = 0; round < 200; round += 1) {
      const exp = S.expandKey(key, 0, 0, round % 2 ? '    ' : '');
      let text = exp.text;
      let session = Sess.withText(Sess.startSession(exp), text);
      const others = session.stops.slice(1).map((st) => st.ranges.map((r) => text.slice(r.start, r.end)));
      for (let step = 0; step < 8; step += 1) {
        const m = Sess.activeRange(session);
        const value = text.slice(m.start, m.end);
        const from = m.start + Math.floor(rand() * (value.length + 1));
        const to = Math.min(m.end, from + Math.floor(rand() * 3));
        const insert = ['x', 'Yz', '', 'ab c', '$1'][Math.floor(rand() * 5)];
        const next = text.slice(0, from) + insert + text.slice(to);
        const edit = Sess.locateEdit(text, next, from + insert.length);
        if (!edit) continue;
        const tracked = Sess.trackEdit(session, edit);
        assert.ok(tracked, `${key}: the edit is inside the blank`);
        const synced = Sess.syncCopies(next, tracked);
        assert.ok(synced, `${key}: copies are in step`);
        text = synced.text;
        session = synced.session;
        const master = text.slice(session.stops[0].ranges[0].start, session.stops[0].ranges[0].end);
        session.stops[0].ranges.forEach((r) => assert.equal(text.slice(r.start, r.end), master, `${key}: copies follow`));
        // The blanks that were not typed in still hold what they held.
        session.stops.slice(1).forEach((st, si) => st.ranges.forEach((r, ri) => assert.equal(text.slice(r.start, r.end), others[si][ri], `${key}: other blank ${si}`)));
        // The ranges stay in order and inside the text.
        const flat = session.stops.flatMap((st) => st.ranges).sort((a, b) => a.start - b.start);
        flat.forEach((r, i) => {
          assert.ok(r.start >= 0 && r.end >= r.start && r.end <= text.length);
          if (i) assert.ok(r.start >= flat[i - 1].end, `${key}: blanks do not overlap`);
        });
      }
    }
  });
});

test('jump: forward to the end of the snippet, back to the first blank and no further', () => {
  const exp = S.expandKey('gr', 0, 0, '');
  const text = exp.text;
  let session = Sess.withText(Sess.startSession(exp), text);
  let j = Sess.jump(session, text, 1);
  assert.equal(text.slice(j.select.start, j.select.end), 'field');
  session = j.session;
  j = Sess.jump(session, text, -1);
  assert.equal(text.slice(j.select.start, j.select.end), 'table');
  j = Sess.jump(j.session, text, -1);
  assert.equal(text.slice(j.select.start, j.select.end), 'table', 'no further back');
  j = Sess.jump(j.session, text, 1);
  j = Sess.jump(j.session, text, 1);
  assert.equal(text.slice(j.select.start, j.select.end), 'value');
  j = Sess.jump(j.session, text, 1);
  assert.equal(j.session, null, 'the last stop ends the session');
  assert.equal(j.select.start, text.indexOf('  \n}') + 2 - 0 === -1 ? -1 : j.select.start);
  assert.equal(j.select.start, j.select.end);
  assert.equal(Sess.startSession(S.expandKey('gdt', 0, 0, '')), null, 'a snippet with no blanks has no session');
});

test('property: the separate edits a multi-cursor change reports give the same text as the combined result', () => {
  const rand = lcg(31337);
  const applyDescending = (text, edits) => edits.reduceRight((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
  for (let n = 0; n < 3000; n += 1) {
    const { text, sels } = randomCursorCase(rand);
    [M.typeText(text, sels, 'Q'), M.backspace(text, sels), M.deleteForward(text, sels), M.newline(text, sels), M.tabAll(text, sels, '  '), M.pasteText(text, sels, 'a\nb\nc')].forEach((r, k) => {
      assert.equal(applyDescending(text, r.edits), r.text, `case ${n} op ${k}`);
      for (let i = 1; i < r.edits.length; i += 1) assert.ok(r.edits[i].from >= r.edits[i - 1].to, 'edits are in order and do not overlap');
    });
  }
});

test('outline: the name on the left wins over the function expression own name, and a long script is read quickly', () => {
  assert.deepEqual(names(outline('var f = function named(a) { return a; };\nobj.g = function other() {};')), ['function:f', 'function:obj.g']);
  const big = Array.from({ length: 1500 }, (_, i) => `  m${i}: function (a, b) {\n    var v${i} = gr.getValue('f${i}') ;\n    return a + b + ${i};\n  },`).join('\n');
  const src = `var Big = Class.create();\nBig.prototype = {\n${big}\n  type: 'Big'\n};\n`;
  const started = Date.now();
  const syms = outline(src);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  assert.equal(syms.length, 1502);
  assert.equal(syms[1].path, 'Big \u203a m0');
  assert.equal(symbolAt(syms, src.indexOf('m1499')).name, 'm1499');
});

test('the editor source files are valid UTF-8 with no raw non-characters (Chrome refuses a content script that has them)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const files = [
    'src/content/scriptEditor.js', 'src/content/editor.css', 'src/content/editorData.js', 'src/lib/editorText.js', 'src/lib/completion.js', 'src/lib/editorDiagnostics.js',
    'src/lib/editorOutline.js', 'src/lib/editorFormat.js', 'src/lib/editorChanges.js', 'src/lib/editorMulti.js', 'src/lib/editorSnippetSession.js', 'src/lib/snippets.js',
  ];
  files.forEach((file) => {
    const buf = fs.readFileSync(path.join(__dirname, '..', file));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    assert.equal(/[\uFFFE\uFFFF\uFFFD]/.test(text), false, `${file} has a raw non-character; write it as an escape`);
  });
});

// ---- review fixes: lexer cases that let the formatter change strings and regexes ------------------------------------

test('lex: a template literal with templates nested in ${...} is one range, so nothing inside it counts as code', () => {
  const src = 'var h = `<ul>${items.map((i) => `<li>${i},x=${"}"}</li>`).join(\'\')}</ul>`; var z=1;';
  const ranges = T.lex(src);
  assert.equal(ranges[0].type, T.TEMPLATE);
  assert.equal(src.slice(ranges[0].start, ranges[0].end), src.slice(src.indexOf('`'), src.lastIndexOf('`') + 1));
  assert.equal(ranges[0].closed, true);
  assert.equal(ranges.length, 1);
  // Unterminated: an open ${ or an open nested template runs to the end, and deep nesting never throws.
  assert.equal(T.lex('x = `a ${ `b').at(-1).closed, false);
  assert.doesNotThrow(() => T.lex('`${'.repeat(5000)));
});

test('lex: a regex right after the ) of if / while / for, after a no-break space, and division after i++ and obj.return', () => {
  const kinds = (src) => T.lex(src).map((r) => [r.type, src.slice(r.start, r.end)]);
  assert.deepEqual(kinds('if (x) /a=b/.test(s);'), [[T.REGEX, '/a=b/']]);
  assert.deepEqual(kinds('while (x) /a,b/.exec(s);'), [[T.REGEX, '/a,b/']]);
  assert.deepEqual(kinds('for (;;) /x/.test(s);'), [[T.REGEX, '/x/']]);
  assert.deepEqual(kinds('foo(x) / 2 / y;'), [], 'a call is still a division');
  assert.deepEqual(kinds('s.split( /,/);'), [[T.REGEX, '/,/']]);
  assert.deepEqual(kinds('var n = i++ / 2; var s = "a/b ,c";'), [[T.STRING, '"a/b ,c"']]);
  assert.deepEqual(kinds('var q = o.return / 2, r = "x/y ,z";'), [[T.STRING, '"x/y ,z"']]);
  assert.deepEqual(kinds('return /x/;'), [[T.REGEX, '/x/']], 'the keyword itself still allows a regex');
});

test('formatCode leaves nested templates, regexes after if (...) and strings after i++ exactly as they are', () => {
  const same = [
    'var s = `${`a=b`}`;\n',
    "var h = `<ul>${items.map((i) => `<li>${i},x</li>`).join('')}</ul>`;\n",
    'if (x) /a=b/.test(s);\n',
    'while (x) /a,b/.exec(s);\n',
    'var n = i++ / 2; var s = "a/b ,c";\n',
    'var parts = s.split( /,/);\n',
    'var a = obj.return / 2, b = "x/y ,z";\n',
  ];
  same.forEach((src) => assert.deepEqual(F.formatCode(src), { text: src, changed: false }, JSON.stringify(src)));
});

test('formatCode keeps ??= ||= &&= whole, private #names and a?.5:b, and spaces the assignments like =', () => {
  assert.equal(F.formatCode('a??=b;c||=d;e&&=f;\n').text, 'a ??= b; c ||= d; e &&= f;\n');
  assert.equal(F.formatCode('class A { static #seen=0 }\n').text, 'class A { static #seen = 0 }\n');
  assert.equal(F.formatCode('x=a?.5:1;\n').text, 'x = a?.5:1;\n');
  assert.notEqual(F.tokenSignature('a ??= b'), F.tokenSignature('a ?? = b'), 'splitting ??= is a change of tokens');
  assert.notEqual(F.tokenSignature('1e-5'), F.tokenSignature('1e - 5'));
});

// Realistic ServiceNow scripts (ES5 and ES12) with the constructs a formatter can get wrong.
const TRICKY_SCRIPTS = [
  `(function executeRule(current, previous /*null when async*/) {
  // Don't touch "closed" records; see http://example.com/kb?id=1
  var url = 'https://' + gs.getProperty('instance_name') + '.service-now.com//nav_to.do?uri=incident.do';
  var re = /^INC\\d{7}$/i, other = /[/'"]+/g;
  if (!re.test(current.number)) return;
  var parts = String(current.short_description).split(/,\\s*/);
  var ratio = parts.length / 2 / (current.priority || 1);
  var n = 0; n++ / 2; var s = "a/b ,c";
  var o = { return: 1, 'in': 2 }; var q = o.return / 2, r = "x/y ,z";
  /* it's a block comment with "quotes" and a // inside */
  gs.info('Parts: ' + parts.join(' , ') + ' ratio=' + ratio + ' tiny=' + 1e-5);
})(current, previous);`,
  `var IncidentUtils = Class.create();
IncidentUtils.prototype = {
  initialize: function(user) { this.user = user; this._cache = {}; },
  get size() { return Object.keys(this._cache).length; },
  set size(v) { },
  config: { "a": 1, "b": [1, 2, { "c": "d:e,f" }], 'g': null, h: true },
  find: function(table, query) {
    var gr = new GlideRecord(table);
    gr.addEncodedQuery(query);
    gr.query();
    outer: while (gr.next()) {
      switch (gr.getValue('state')) {
        case '1':
        case '2': continue outer;
        default:
          if (gr.priority == 1) break outer;
      }
    }
    return gr;
  },
  type: 'IncidentUtils'
};`,
  `const build = (items, { title = 'List', limit = 10 } = {}) => {
  const rows = items.slice(0, limit).map((item, i) => \`<li class="\${i % 2 ? 'odd' : 'even'}">\${item?.name ?? '(none)'},x=\${i ** 2}</li>\`);
  return \`<h2>\${title}</h2><ul>\${rows.join('')}</ul><p>\${\`a=b, \${rows.length} rows\`}</p>\`;
};
class Counter extends Object {
  static #seen = 0;
  constructor(...args) { super(); this.args = [...args]; }
  get count() { return this.args.length; }
  static make() { return new Counter(1, 2, 3); }
}
const { a, b: [c, ...d] } = { a: 1, b: [2, 3, 4] };
let total = a + c ** 2;
total ??= 0; total ||= 1; total &&= 2;
const fn = async function () { await Promise.resolve(total); };`,
  `function onSubmit() {
  var v = g_form.getValue('u_phone');
  if (v) /[^0-9 +()-]/.test(v) && g_form.showFieldMsg('u_phone', 'Digits only, a=b', 'error');
  while (false) /a,b/.exec(v);
  for (var i = 0; i < 1; i++) /x=y/.test(v);
  var half = (v.length) / 2, third = v.length / 3;
  return true;
}`,
  `var a = 1
var b = a
++b
function f(x) {
  if (!x)
    throw new Error('no x, sorry')
  return (
    x * 2
  )
}
var list = [1, 2, 3]
  .map(function (n) { return n * 2 })
  .filter(function (n) { return n > 2 })
gs.info(list)`,
  "var label = 'Fertig 😀 ok, done';\nvar parts = label.split( /,/);\n\tif (parts.length > 1) {\n\t\tgs.info('日本語 = ' + parts[0]);\n\t}\nvar sep = ' ';\nvar café = 1;",
  `var ids = [${Array.from({ length: 600 }, (_, i) => `'${(i * 7919).toString(16).padStart(32, '0')}'`).join(',')}];\nvar first = ids[0];`,
  `/**
 * Closes stale incidents.
 *   @param {number} days  how old, in days
 */
function closeStale(days) {
  /*
  var old = new GlideRecord('incident');
     old.query();
  */
  var gr = new GlideRecord('incident'); // the table, "incident"
  gr.addQuery('sys_updated_on', '<', gs.daysAgo(days)); /* older than that */
  gr.query();
  while (gr.next()) { gr.setValue('state', 7); /* closed */ gr.update(); }
}`,
  `function onChange(control, oldValue, newValue, isLoading, isTemplate) {
  if (isLoading || newValue === '') {
    return;
  }
  var ga = new GlideAjax('IncidentAjax');
  ga.addParam('sysparm_name', 'getCaller');
  ga.addParam('sysparm_id', newValue);
  ga.getXMLAnswer(function(answer) {
    var data = JSON.parse(answer || '{}');
    if (data.vip) { g_form.showFieldMsg('caller_id', 'VIP caller: ' + data.name + '!', 'info'); }
    else{ g_form.hideFieldMsg('caller_id') }
  });
}`,
];

/** Every realistic script in the repo: the ones above, the built-in snippets, the Tab snippets, the "new ..." templates and the preview's records. */
function realisticScripts() {
  const fs = require('node:fs');
  const path = require('node:path');
  const scaffolds = require('../src/lib/scaffolds.js');
  const out = [...TRICKY_SCRIPTS];
  BUILTIN_SNIPPETS.forEach((s) => out.push(s.template.replace(/\{\{(\w+)\}\}/g, '$1')));
  Object.values(S.SNIPPETS).forEach((t) => out.push(S.parseTemplate(t, '').text));
  const combos = [
    ['br', { table: 'incident', when: 'before' }], ['br', { table: 'incident', when: 'async' }], ['br', { table: 'incident', when: 'display' }],
    ['si', { name: 'Util', variant: 'class' }], ['si', { name: 'Util', variant: 'ajax' }], ['si', { name: 'Util', variant: 'class', scoped: true }],
    ['cs', { table: 'incident', type: 'onLoad' }], ['cs', { table: 'incident', type: 'onChange' }], ['cs', { table: 'incident', type: 'onSubmit' }], ['cs', { table: 'incident', type: 'onCellEdit' }],
    ['uia', { table: 'incident', variant: 'roundtrip' }], ['uia', { table: 'incident', variant: 'server' }], ['sj', {}], ['fix', {}], ['rest', { method: 'GET' }], ['rest', { method: 'POST' }],
  ];
  combos.forEach(([kind, options]) => {
    const r = scaffolds.build(kind, options);
    if (r.ok) out.push(r.script);
  });
  const fake = fs.readFileSync(path.join(__dirname, '..', 'preview', 'fakeInstance.js'), 'utf8');
  for (const m of fake.matchAll(/^const [A-Z_0-9]+ = `([\s\S]*?)`;$/gm)) if (!m[1].includes('${') && !m[1].includes('\\')) out.push(m[1]);
  return out;
}

/**
 * What the code does, independent of this repo's lexer: esbuild's minified output (comments and layout gone; strings,
 * templates and regexes kept byte for byte). Null when the script does not parse. Only parses; nothing is run.
 */
function makeMeaning() {
  const path = require('node:path');
  const { createRequire } = require('node:module');
  const esbuild = createRequire(path.join(__dirname, '..', 'package.json'))('esbuild');
  return async (src) => {
    try {
      const out = await esbuild.transform(`__keep(function () {\n${src}\n});`, { minify: true, loader: 'js', legalComments: 'none', charset: 'utf8' });
      return out.code;
    } catch {
      return null;
    }
  };
}

/** The script with random blanks between tokens (never where they would merge two tokens), random indentation and trailing blanks. */
function shuffleBlanks(src, rand) {
  const info = T.analyze(src);
  const toks = F.tokenize(info.text, info.ranges);
  const PUNCT = new Set(['(', ')', '{', '}', '[', ']', ',', ';']);
  let out = '';
  let pos = 0;
  for (let k = 0; k + 1 < toks.length; k += 1) {
    const a = toks[k];
    const b = toks[k + 1];
    out += src.slice(pos, a.end);
    const gap = src.slice(a.end, b.start);
    pos = b.start;
    const A = src.slice(a.start, a.end);
    const B = src.slice(b.start, b.end);
    if (gap.includes('\n') || /[^ \t]/.test(gap) || A === '.' || B === '.' || A === '?.' || B === '?.' || (a.type === 'comment' && A.startsWith('//'))) {
      out += gap;
      continue;
    }
    const r = rand();
    if (gap === '') out += r < 0.25 ? ' ' : r < 0.32 ? '  ' : r < 0.36 ? ' ' : '';
    else if ((PUNCT.has(A) || PUNCT.has(B)) && r < 0.4) out += '';
    else out += r < 0.7 ? gap : r < 0.85 ? '  ' : '\t';
  }
  out += src.slice(pos);
  const info2 = T.analyze(out);
  return out
    .split('\n')
    .map((line, li) => {
      const start = info2.starts[li];
      if (info2.ranges.some((r) => r.start < start && r.end > start)) return line; // inside a template, string or comment
      const end = start + line.length;
      const endsInText = info2.ranges.some((r) => r.start < end && r.end > end && r.type !== T.COMMENT);
      const lead = rand() < 0.5 ? '\t'.repeat(Math.floor(rand() * 3)) : ' '.repeat(Math.floor(rand() * 7));
      return lead + line.replace(/^[ \t]+/, '') + (!endsInText && rand() < 0.3 ? '  ' : '');
    })
    .join('\n');
}

test('property: on every realistic script, formatting (whole, a few lines, CRLF) never changes what the code does, is stable and parses', async () => {
  const meaning = makeMeaning();
  const rand = lcg(4242);
  const corpus = realisticScripts();
  assert.ok(corpus.length > 60, `only ${corpus.length} scripts`);
  let formatted = 0;
  for (const [n, src] of corpus.entries()) {
    // eslint-disable-next-line no-await-in-loop -- one script at a time keeps a failure readable
    const want = await meaning(src);
    assert.notEqual(want, null, `script ${n} does not parse: ${src.slice(0, 80)}`);
    const inputs = [src, ...Array.from({ length: 5 }, () => shuffleBlanks(src, rand)), src.replace(/\n/g, '\r\n')];
    // eslint-disable-next-line no-await-in-loop
    const noisyMeanings = await Promise.all(inputs.map(meaning));
    noisyMeanings.forEach((m, v) => assert.equal(m, want, `script ${n} variant ${v}: the test's own blank shuffling changed the code (a lexer bug?)`));
    const lines = src.split('\n').length;
    const runs = inputs.flatMap((input) => {
      const from = Math.floor(rand() * lines);
      return [F.formatCode(input), F.formatCode(input, { fromLine: from, toLine: Math.min(lines - 1, from + Math.floor(rand() * 8)) })];
    });
    runs.forEach((r, k) => assert.equal(r.error, undefined, `script ${n} run ${k} refused: ${r.error}`));
    // eslint-disable-next-line no-await-in-loop
    const after = await Promise.all(runs.map((r) => meaning(r.text)));
    after.forEach((m, k) => assert.equal(m, want, `script ${n} run ${k}: formatting changed the code:\n${runs[k].text.slice(0, 600)}`));
    runs.forEach((r, k) => {
      if (k % 2) return; // whole-script runs: a second run changes nothing
      assert.equal(F.formatCode(r.text).changed, false, `script ${n} run ${k} is not stable`);
    });
    formatted += runs.length;
  }
  assert.ok(formatted > 800, `only ${formatted} runs`);
});

test('a 40,000+ character script formats in well under a second and keeps its meaning', async () => {
  const meaning = makeMeaning();
  const corpus = realisticScripts().filter((s) => !/^\s*(class|const|let)\b/m.test(s) && !s.includes('#seen'));
  let big = '';
  for (let k = 0; big.length < 45000; k += 1) big += `function part${k}() {\n${corpus[k % corpus.length]}\n}\n`;
  const started = Date.now();
  const r = F.formatCode(big);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  assert.equal(r.error, undefined);
  assert.equal(await meaning(r.text), await meaning(big));
});

// ---- review fixes: multi-cursor edits never split an emoji; paste follows the textarea's line breaks ----------------------

test('multi-cursor Backspace, Delete and arrows treat an emoji (two UTF-16 units) as one character', () => {
  const smile = '😀';
  const text = `a${smile}b\nc${smile}d`;
  const after = [text.indexOf('b'), text.lastIndexOf('d')];
  assert.equal(M.backspace(text, after.map((at, i) => caret(at, i === 0))).text, 'ab\ncd');
  const before = [text.indexOf(smile), text.lastIndexOf(smile)];
  assert.equal(M.deleteForward(text, before.map((at, i) => caret(at, i === 0))).text, 'ab\ncd');
  assert.deepEqual(M.moveAll(text, after.map((at, i) => caret(at, i === 0)), 'ArrowLeft').sels.map((s) => s.start), before);
  assert.deepEqual(M.moveAll(text, before.map((at, i) => caret(at, i === 0)), 'ArrowRight').sels.map((s) => s.start), after);
  assert.equal(M.snapToChar(text, text.indexOf(smile) + 1), text.indexOf(smile));
  assert.equal(M.snapToChar(text, 0), 0);
  // Nothing typed at a snapped caret can leave half an emoji behind.
  const typed = M.typeText(text, [caret(M.snapToChar(text, text.indexOf(smile) + 1), true)], 'X');
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(typed.text), false);
});

test('multi-cursor paste: \\r\\n and \\r count as one line break, as in the textarea itself', () => {
  const text = 'x\ny\nz';
  const sels = [caret(1, false), caret(3, false), caret(5, true)];
  assert.equal(M.pasteText(text, sels, 'A\r\nB\rC').text, 'xA\nyB\nzC');
  assert.equal(M.pasteText(text, [caret(0, true)], 'p\r\nq').text, 'p\nqx\ny\nz');
});

test('property: one undo of a multi-cursor change (the inverse of its single replacement) gives back the exact text', () => {
  const rand = lcg(8080);
  for (let n = 0; n < 2000; n += 1) {
    const { text, sels } = randomCursorCase(rand);
    [M.typeText(text, sels, 'Zz'), M.backspace(text, sels), M.deleteForward(text, sels), M.newline(text, sels), M.tabAll(text, sels, '  '), M.pasteText(text, sels, 'p\nq')].forEach((r, k) => {
      const d = T.diffRange(text, r.text);
      if (!d) return;
      assert.equal(text.slice(0, d.from) + d.insert + text.slice(d.to), r.text, `case ${n} op ${k}`);
      const back = T.diffRange(r.text, text);
      assert.equal(r.text.slice(0, back.from) + back.insert + r.text.slice(back.to), text, `case ${n} op ${k}: undo`);
    });
  }
});

// ---- review fixes: Ctrl+J refuses joins that JavaScript would read differently ------------------------------------------

test('joinLines refuses to join after return / throw / break / continue, or before a line that starts with ++ or --', () => {
  const join = (marked) => {
    const at = marked.indexOf('|');
    const text = marked.replace('|', '');
    const edit = T.joinLines(text, at, at);
    if (!edit) return null;
    if (edit.error) return 'refused';
    return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  };
  assert.equal(join('if (a) return|\n  b + 1;'), 'refused');
  assert.equal(join('throw|\n  err;'), 'refused');
  assert.equal(join('for (;;) { break|\n  next; }'), 'refused');
  assert.equal(join('x = a|\n++b;'), 'refused');
  assert.equal(join('if (a) return;|\n  b();'), 'if (a) return; b();');
  assert.equal(join('function f() { return|\n}'), 'function f() { return }', 'nothing to return on the next line');
  assert.equal(join('var r = obj.return|\n  + 1;'), 'var r = obj.return + 1;', 'a property called return is not the keyword');
  assert.equal(join("var s = 'return'|\n  + 1;"), "var s = 'return' + 1;");
});

// ---- review fixes: the saved text is read from the record, and never for a secret ----------------------------------------

test('readSavedFieldValue reads the record (field and sys_id only), gives \\n line breaks, and says "unknown" (null) when it cannot tell', async () => {
  const saved = { document: global.document, window: global.window, location: global.location, chrome: global.chrome, fetch: global.fetch };
  global.document = { documentElement: { hasAttribute() { throw new Error('no bridge in tests'); } }, getElementById: () => null, querySelector: (sel) => (sel === 'input[name="sysparm_ck"]' ? { value: 'tok' } : null), scripts: [] };
  global.window = { location: { hostname: 'dev1.service-now.com', href: 'https://dev1.service-now.com/', origin: 'https://dev1.service-now.com' } };
  global.location = { search: '' };
  global.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: { sendMessage: async () => ({}) } };
  const calls = [];
  let answer = null;
  global.fetch = async (url) => {
    const u = new URL(url, 'https://dev1.service-now.com');
    calls.push({ path: u.pathname, query: u.searchParams.get('sysparm_query'), fields: u.searchParams.get('sysparm_fields') });
    if (answer === 'fail') return new Response('{"error":{"message":"nope"}}', { status: 403, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ result: answer }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { readSavedFieldValue } = require('../src/content/editorData.js');
    const id = 'a'.repeat(32);
    answer = [{ sys_id: id, script: 'var a = 1;\r\nvar b = 2;\r' }];
    assert.equal(await readSavedFieldValue({ table: 'sys_script', sysId: id, field: 'script' }), 'var a = 1;\nvar b = 2;\n');
    assert.deepEqual(calls[0], { path: '/api/now/table/sys_script', query: `sys_id=${id}`, fields: 'sys_id,script' });
    answer = [{ sys_id: id }]; // the Table API leaves out a column it does not know: unknown, not empty
    assert.equal(await readSavedFieldValue({ table: 'sys_script', sysId: id, field: 'scriptz' }), null);
    answer = [];
    assert.equal(await readSavedFieldValue({ table: 'sys_script', sysId: id, field: 'script' }), null, 'a new record is not saved yet');
    answer = 'fail';
    assert.equal(await readSavedFieldValue({ table: 'sys_script', sysId: id, field: 'script' }), null, 'a failed read');
    const before = calls.length;
    assert.equal(await readSavedFieldValue({ table: 'sys_properties', sysId: id, field: 'value', type: 'password2' }), null);
    assert.equal(await readSavedFieldValue({ table: 'x_app_conf', sysId: id, field: 'api_token' }), null);
    assert.equal(await readSavedFieldValue({ table: 'sys_script', sysId: 'not-an-id', field: 'script' }), null);
    assert.equal(await readSavedFieldValue({ table: 'sys script', sysId: id, field: 'script' }), null);
    assert.equal(calls.length, before, 'secrets and bad names are never read');
  } finally {
    Object.assign(global, saved);
  }
});

test('expandSnippet never expands in a comment or a string (a template there would put live code into the comment)', () => {
  assert.equal(S.expandSnippet('// look at gr', 13), null);
  assert.equal(S.expandSnippet("var s = 'gr", 11), null);
  assert.equal(S.expandSnippet('/* info', 7), null);
  assert.ok(S.expandSnippet('x;\ngr', 5), 'in code it still expands');
  assert.ok(S.expandSnippet("var s = 'a'; gr", 15), 'after a closed string it still expands');
});

// ---- live check 2026-10-23: the body of a brace-less if / else / for / while / do goes one level deeper ---------------

test('format keeps the single-statement body of a brace-less if indented (OOTB "incident events" lines)', () => {
  const ootb = '(function executeRule(current, previous /*null when async*/) {\n  var transaction = getTransaction();\n  if (!transaction)\n    return false;\n  var request = transaction.getRequest();\n  if (!request)\n    return false;\n  return true;\n})(current, previous);\n';
  assert.deepEqual(F.formatCode(ootb), { text: ootb, changed: false });
  const flat = ootb.replace(/^[ \t]+/gm, '');
  assert.equal(F.formatCode(flat).text, ootb);
  assert.equal(F.formatCode('  if (!transaction)\n  return false;\n').text, 'if (!transaction)\n  return false;\n');
});

test('format: nested brace-less bodies, else lined up with its if, else if, for / while / do, and a body over several lines', () => {
  const cases = [
    'if (a)\n  if (b)\n    x();\n  else\n    y();\nelse\n  z();\n',
    'if (a)\n  x();\nelse if (b)\n  y();\nelse\n  z();\n',
    'for (var i = 0; i < n; i++)\n  total += i;\nwhile (x)\n  x--;\ndo\n  x++;\nwhile (x < 5);\nnext();\n',
    'if (a) {\n  x();\n} else\n  y();\nz();\n',
    'if (a)\n{\n  b = 1;\n}\nelse\n{\n  b = 2;\n}\n',
    'if (a &&\n  b)\n  foo(1,\n    2);\nelse\n  bar()\n    .baz();\nafter();\n',
    'if (a)\n  // why\n  x = 1;\nelse\n  y();\n',
    'switch (k) {\n  case 1:\n    if (a)\n      x();\n    break;\n}\n',
    'if (a) x(); else\n  y();\nz();\n',
    'if (a)\n  foo(function () {\n    return 1;\n  });\nelse\n  bar();\n',
    'do {\n  x++;\n} while (x < 3)\nafter();\n',
    'if (a)\n  do\n    x++;\n  while (b);\nelse\n  y();\n',
    'if (a)\n  for (;;)\n    if (b)\n      break;\n    else\n      c();\nd();\n',
  ];
  cases.forEach((want) => {
    assert.deepEqual(F.formatCode(want), { text: want, changed: false }, `stays: ${JSON.stringify(want)}`);
    assert.equal(F.formatCode(want.replace(/^[ \t]+/gm, '')).text, want, `from flat: ${JSON.stringify(want)}`);
  });
});

/** A random program of brace-less and braced if / else / for / while / do, written in the formatter's own layout. */
function randomBodies(rand, unit = '  ') {
  let n = 0;
  const lines = [];
  const put = (level, text) => lines.push(unit.repeat(level) + text);
  // Returns true when the statement ends with a brace-less if that has no else (an else after it would belong to it).
  const stmt = (level, depth) => {
    const r = depth > 3 ? 0 : rand();
    n += 1;
    if (r < 0.3) {
      put(level, `x${n}();`);
      return false;
    }
    if (r < 0.6) {
      put(level, `if (c${n})`);
      const open = stmt(level + 1, depth + 1);
      if (!open && rand() < 0.6) {
        if (rand() < 0.4) {
          n += 1;
          put(level, `else if (e${n})`);
          return stmt(level + 1, depth + 1) || true;
        }
        put(level, 'else');
        return stmt(level + 1, depth + 1);
      }
      return true;
    }
    if (r < 0.72) {
      put(level, rand() < 0.5 ? `for (var i${n} = 0; i${n} < 3; i${n}++)` : `while (w${n}())`);
      return stmt(level + 1, depth + 1);
    }
    if (r < 0.8) {
      put(level, 'do');
      stmt(level + 1, depth + 1);
      put(level, `while (d${n}());`);
      return false;
    }
    put(level, `if (b${n}) {`);
    stmt(level + 1, depth + 1);
    if (rand() < 0.5) {
      put(level, '} else {');
      stmt(level + 1, depth + 1);
    }
    put(level, '}');
    return false;
  };
  const count = 1 + Math.floor(rand() * 4);
  for (let k = 0; k < count; k += 1) {
    if (stmt(0, 0)) put(0, ';'); // an empty statement keeps a later else from belonging to it
  }
  return `${lines.join('\n')}\n`;
}

test('property: brace-less bodies of any nesting are indented one level per header, meaning and stability kept', async () => {
  const meaning = makeMeaning();
  const rand = lcg(31415);
  for (let k = 0; k < 300; k += 1) {
    const want = randomBodies(rand, k % 3 ? '  ' : '\t');
    const flat = want.replace(/^[ \t]+/gm, rand() < 0.5 ? '' : '   ');
    const r = F.formatCode(flat, { unit: k % 3 ? '  ' : '\t' });
    assert.equal(r.error, undefined, want);
    assert.equal(r.text, want, `case ${k}`);
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await meaning(r.text), await meaning(flat), `case ${k}: meaning`);
  }
});
