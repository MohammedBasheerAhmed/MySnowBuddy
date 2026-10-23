// Outline of a ServiceNow script for "Go to symbol": functions, Script Include classes and their
// prototype methods, ES6 classes and methods, arrow functions, and the standard handlers
// (onLoad, onChange, onSubmit, onCellEdit, executeRule, process). It is a heuristic reader like
// completion.js: it reads the code with comments, strings and regexes blanked, never runs it, and
// skips anything it cannot place. Pure functions, no DOM; tested in tests/editorplus.test.js.
import { analyze, masked, lineOfOffset, lineEndAt } from './editorText.js';
import { fuzzyMatch } from './completion.js';

const HANDLERS = new Set(['onLoad', 'onChange', 'onSubmit', 'onCellEdit', 'onClick', 'executeRule', 'process']);
const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'else', 'do', 'try', 'typeof', 'new', 'delete', 'void', 'await', 'yield']);
const MAX_SYMBOLS = 2000;

/** Index of the bracket that closes the one at `open` (in masked text), or -1. */
function closeOf(m, open) {
  let depth = 0;
  for (let i = open; i < m.length; i += 1) {
    const c = m[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** End of the statement that starts at `from`: the next `;` outside brackets, or the end of the text. */
function statementEnd(m, from) {
  let depth = 0;
  for (let i = from; i < m.length; i += 1) {
    const c = m[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth < 0) return i;
    } else if (c === ';' && depth === 0) return i + 1;
  }
  return m.length;
}

/** Offset of the name in a match that may start with var, let or const. */
const nameAt = (hit) => hit.index + (/^(?:var|let|const)\s+/.exec(hit[0]) || [''])[0].length;

const collapse = (s) => String(s || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();

/**
 * @typedef {{name: string, kind: 'class'|'function'|'method'|'handler'|'marker', line: number, offset: number,
 *   start: number, end: number, depth: number, parent: number, params: string, path: string}} Symbol
 */

/**
 * Symbols of the script in document order. `offset` is where the name starts (where the caret goes), `start` and
 * `end` bound the whole definition (used for nesting and for "which function am I in").
 * @returns {Symbol[]}
 */
export function outline(text) {
  const info = analyze(text);
  const src = info.text;
  const m = masked(info);
  const found = [];
  const seen = new Map(); // where a parameter list opens -> the symbol made for it

  const push = (sym) => {
    if (found.length < MAX_SYMBOLS) found.push(sym);
  };

  /** A function whose parameter list opens at `open`; its body is the next `{...}`. */
  const addFunction = ({ name, kind, offset, start, open, params }) => {
    if (seen.has(open)) return;
    seen.set(open, null);
    const close = closeOf(m, open);
    let end = lineEndAt(m, offset);
    if (close !== -1) {
      let k = close + 1;
      while (k < m.length && /\s/.test(m[k])) k += 1;
      if (m[k] === '{') {
        const bodyEnd = closeOf(m, k);
        end = bodyEnd === -1 ? m.length : bodyEnd + 1;
      }
    }
    const final = HANDLERS.has(name) && kind !== 'method' ? 'handler' : kind;
    const sym = { name, kind: final, offset, start, end, params: collapse(params ?? (close === -1 ? '' : src.slice(open + 1, close))) };
    seen.set(open, sym);
    push(sym);
  };

  // function name(...) { } -- declarations and named function expressions.
  for (const hit of m.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const open = hit.index + hit[0].length - 1;
    const offset = hit.index + hit[0].lastIndexOf(hit[1]);
    addFunction({ name: hit[1], kind: 'function', offset, start: hit.index, open });
  }

  // name: function (...), a.b = function (...), var x = function (...) -- the name on the left wins over a function's own name.
  for (const hit of m.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*([:=])\s*function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*\(/g)) {
    const open = hit.index + hit[0].length - 1;
    // A function that already got its own name (var x = function named() {}) is replaced by the left-hand name.
    const named = seen.get(open);
    if (named && named.start > hit.index && named.start < open && m.startsWith('function', named.start)) {
      const at = found.indexOf(named);
      if (at !== -1) found.splice(at, 1);
      seen.delete(open);
    }
    const dotted = hit[1].replace(/\s+/g, '');
    const isMethod = hit[2] === ':' || /\.prototype\./.test(dotted);
    const name = dotted.replace(/\.prototype\./, '.');
    addFunction({ name, kind: isMethod ? 'method' : 'function', offset: hit.index, start: hit.index, open });
  }

  // var f = (a, b) => { ... } / name: x => ...
  for (const hit of m.matchAll(/(?<![\w$.])(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*([:=])\s*(?:async\s+)?(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>/g)) {
    const arrowAt = hit.index + hit[0].length;
    const key = arrowAt; // arrows have no "(" of their own to dedupe on when the parameter is bare
    if (seen.has(key)) continue;
    seen.set(key, null);
    let k = arrowAt;
    while (k < m.length && /\s/.test(m[k])) k += 1;
    let end = lineEndAt(m, hit.index);
    if (m[k] === '{') {
      const bodyEnd = closeOf(m, k);
      end = bodyEnd === -1 ? m.length : bodyEnd + 1;
    }
    push({ name: hit[1], kind: hit[2] === ':' ? 'method' : 'function', offset: nameAt(hit), start: hit.index, end, params: collapse(hit[3] ?? hit[4]) });
  }

  // Script Include classes: var X = Class.create(); ... X.prototype = ...;
  for (const hit of m.matchAll(/(?<![\w$.])(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*Class\s*\.\s*create\s*\(/g)) {
    const name = hit[1];
    const proto = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\.\\s*prototype\\s*=`, 'g');
    proto.lastIndex = hit.index;
    const p = proto.exec(m);
    const end = p ? statementEnd(m, p.index + p[0].length) : statementEnd(m, hit.index);
    push({ name, kind: 'class', offset: nameAt(hit), start: hit.index, end, params: '' });
  }

  // class X { method() {} }
  for (const hit of m.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) {
    const brace = m.indexOf('{', hit.index + hit[0].length);
    if (brace === -1) continue;
    const bodyEnd = closeOf(m, brace);
    push({ name: hit[1], kind: 'class', offset: hit.index + hit[0].lastIndexOf(hit[1]), start: hit.index, end: bodyEnd === -1 ? m.length : bodyEnd + 1, params: '' });
    scanMembers(brace, bodyEnd === -1 ? m.length : bodyEnd, false);
  }

  // Prototype objects: shorthand methods (`name(a) {`) and the `type: 'X'` marker.
  for (const hit of m.matchAll(/\.\s*prototype\s*=\s*(?:Object\s*\.\s*extendsObject\s*\([^,{}]*,\s*)?\{/g)) {
    const brace = hit.index + hit[0].length - 1;
    const bodyEnd = closeOf(m, brace);
    scanMembers(brace, bodyEnd === -1 ? m.length : bodyEnd, true);
  }

  function scanMembers(open, close, withMarker) {
    let depth = 0;
    let expectKey = true;
    for (let i = open; i < close; i += 1) {
      const c = m[i];
      if (c === '{' || c === '(' || c === '[') {
        depth += 1;
        if (depth === 1) expectKey = true;
        continue;
      }
      if (c === '}' || c === ')' || c === ']') {
        depth -= 1;
        if (depth === 1) expectKey = true;
        continue;
      }
      if (depth !== 1) continue;
      if (c === ',' || c === ';') {
        expectKey = true;
        continue;
      }
      if (!expectKey || !/[A-Za-z_$]/.test(c)) {
        if (!/\s/.test(c)) expectKey = false;
        continue;
      }
      const short = /(?:(?:static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\(/y;
      short.lastIndex = i;
      const hit = short.exec(m);
      if (hit && !NOT_METHOD.has(hit[1])) {
        const parenAt = i + hit[0].length - 1;
        const closeParen = closeOf(m, parenAt);
        let k = closeParen === -1 ? -1 : closeParen + 1;
        while (k !== -1 && k < m.length && /\s/.test(m[k])) k += 1;
        if (k !== -1 && m[k] === '{') addFunction({ name: hit[1], kind: 'method', offset: i + hit[0].lastIndexOf(hit[1]), start: i, open: parenAt });
      } else if (withMarker) {
        const marker = /type\s*:\s*(['"])([^'"\n]*)\1/y;
        marker.lastIndex = i;
        const t = marker.exec(src);
        if (t && m.startsWith('type', i)) push({ name: `type: '${t[2]}'`, kind: 'marker', offset: i, start: i, end: i + t[0].length, params: '' });
      }
      expectKey = false;
    }
  }

  // Order by position; the parent of a symbol is the closest earlier one whose body still contains it.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const stack = [];
  const result = [];
  found.forEach((sym, index) => {
    while (stack.length && found[stack[stack.length - 1]].end <= sym.start) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : -1;
    stack.push(index);
    const line = lineOfOffset(info.starts, sym.offset) + 1;
    result.push({ ...sym, line, depth: stack.length - 1, parent, path: parent === -1 ? sym.name : `${result[parent].path} › ${sym.name}` });
  });
  return result;
}

/**
 * The innermost symbol that contains `offset`, or null. A caret on a handler's own line counts as inside it.
 * @param {Symbol[]} symbols
 */
export function symbolAt(symbols, offset) {
  let best = null;
  for (const sym of symbols) {
    if (sym.kind === 'marker') continue;
    if (sym.start <= offset && offset < sym.end && (!best || sym.start >= best.start)) best = sym;
  }
  return best;
}

/** Symbols that match what was typed, best first; everything in document order when nothing was typed. */
export function filterSymbols(symbols, query) {
  const q = String(query || '').trim();
  if (!q) return symbols.map((sym) => ({ sym, positions: [] }));
  const scored = [];
  for (const sym of symbols) {
    const hit = fuzzyMatch(q, sym.name);
    if (hit) scored.push({ sym, positions: hit.positions, score: hit.score });
  }
  scored.sort((a, b) => b.score - a.score || a.sym.start - b.sym.start);
  return scored.map(({ sym, positions }) => ({ sym, positions }));
}

/** One-line description for a list row: `getOpen(userId, limit)`. */
export function symbolLabel(sym) {
  if (sym.kind === 'class') return `class ${sym.name}`;
  if (sym.kind === 'marker') return sym.name;
  return `${sym.name}(${sym.params})`;
}
