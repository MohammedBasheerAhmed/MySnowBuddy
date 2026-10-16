// Function scopes over masked source (strings and comments blanked by
// lint.maskNonCode, so braces and keywords inside them are gone).
//
// Not a parser: it finds function bodies by their braces so that a variable
// declared in one function is not confused with a same-named variable in
// another (`gr` a GlideRecord in one method and a GlideAggregate in the next).
// let/const are treated as function-scoped; that is close enough for the
// lint/verify/apiCheck heuristics that use it.

const IDENT = '[A-Za-z_$][\\w$]*';
const RESERVED = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'typeof', 'new', 'else', 'do', 'try', 'finally', 'in', 'of', 'instanceof', 'void', 'delete', 'throw', 'case']);

// function name(params) {   function (params) {   function* gen(params) {
// Parameter lists may hold one level of parentheses (default values such as b = f(1)).
const PARAMS = '([^()]*(?:\\([^()]*\\)[^()]*)*)';
const FUNCTION_HEAD = new RegExp(`\\bfunction\\b\\s*\\*?\\s*(${IDENT})?\\s*\\(${PARAMS}\\)\\s*\\{`, 'g');
// (a, b) => {   a => {
const ARROW_HEAD = new RegExp(`(?:\\(${PARAMS}\\)|(${IDENT}))\\s*=>\\s*\\{`, 'g');
// Method shorthand in object literals and classes: name(params) {
const METHOD_HEAD = new RegExp(`(?<![\\w$.])(${IDENT})\\s*\\(${PARAMS}\\)\\s*\\{`, 'g');
const DECLARATION = new RegExp(`\\b(?:var|let|const)\\s+`, 'g');
// Built once: these run inside per-match loops.
const WHOLE_IDENT = new RegExp(`^${IDENT}$`);
const LEADING_IDENT = new RegExp(`^\\s*(${IDENT})`);
const CONTINUES_STATEMENT = /[,=+\-*/&|?:(]/;
const METHOD_PREFIX_KEYWORD = /\b(?:static|async|get|set)$/;
const WHITESPACE = /\s/;

function paramNames(text) {
  return String(text || '')
    .split(',')
    .map((p) => p.replace(/=.*$/s, '').replace(/^[\s.]+|\s+$/g, ''))
    .filter((p) => WHOLE_IDENT.test(p));
}

/** Index of the last non-whitespace character before `index` (not before `floor`), or floor - 1. */
function lastNonSpace(text, index, floor = 0) {
  let j = index - 1;
  while (j >= floor && WHITESPACE.test(text[j])) j -= 1;
  return j;
}

/** Index of the matching close brace for every open brace. */
function matchBraces(masked) {
  const pairs = new Map();
  const stack = [];
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === '{') stack.push(i);
    else if (masked[i] === '}' && stack.length) pairs.set(stack.pop(), i);
  }
  return pairs;
}

let lastScopes = { text: null, result: null };

/** Names declared by the var/let/const statement that starts at `from`. */
function declaredBy(masked, from) {
  const names = [];
  let depth = 0;
  let expectName = true;
  for (let i = from; i < masked.length; i += 1) {
    const ch = masked[i];
    if (expectName) {
      const m = LEADING_IDENT.exec(masked.slice(i, i + 200));
      if (!m) break;
      names.push(m[1]);
      i += m[0].length - 1;
      expectName = false;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break; // end of a for (...) header or a block
      depth -= 1;
    } else if (depth === 0 && (ch === ';' || ch === '\n')) {
      // A newline ends the statement unless the line clearly continues (trailing comma or operator).
      if (ch === ';') break;
      // Last non-blank character of the statement so far (a backwards scan, not a slice per newline).
      const j = lastNonSpace(masked, i, from);
      if (j < from || !CONTINUES_STATEMENT.test(masked[j])) break;
    } else if (depth === 0 && ch === ',') {
      expectName = true;
    }
  }
  return names;
}

/**
 * @param {string} masked source with strings and comments blanked
 * @returns {{
 *   scopes: Array<{id:number,start:number,end:number,parent:number|null,declared:Set<string>}>,
 *   scopeAt: (index:number) => number,
 *   resolve: (name:string, index:number) => number|null,
 *   bindingAt: (name:string, index:number) => number,
 * }}
 *   `resolve` gives the id of the scope that declares `name` as seen from
 *   `index`, or null when it is not declared anywhere on the chain (an implicit
 *   global). `bindingAt` is the same but maps implicit globals to the top level (0).
 *   The result is shared (lint, verify and apiCheck each ask for the scopes of the
 *   same script, so the last one is remembered): treat it as read-only.
 */
export function buildScopes(masked) {
  const text = String(masked || '');
  if (lastScopes.text === text) return lastScopes.result;
  const result = computeScopes(text);
  lastScopes = { text, result };
  return result;
}

/** 1-based line number of any index in `text`, by binary search over line starts (built once). */
export function lineLocator(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function computeScopes(text) {
  const braces = matchBraces(text);
  const scopes = [{ id: 0, start: -1, end: text.length + 1, parent: null, declared: new Set() }];
  const heads = [];
  const headOpens = new Set();

  const addHead = (openIndex, params, name, nameIndex) => {
    if (headOpens.has(openIndex)) return;
    headOpens.add(openIndex);
    heads.push({ open: openIndex, params, name, nameIndex });
  };
  for (const m of text.matchAll(FUNCTION_HEAD)) addHead(m.index + m[0].length - 1, paramNames(m[2]), m[1] || null, m.index);
  for (const m of text.matchAll(ARROW_HEAD)) addHead(m.index + m[0].length - 1, paramNames(m[1] ?? m[2]), null, m.index);
  for (const m of text.matchAll(METHOD_HEAD)) {
    if (RESERVED.has(m[1])) continue;
    // `foo(a) {` is a method only where a member can start: after {, }, ',' ';' or a line start.
    const j = lastNonSpace(text, m.index);
    const prev = j >= 0 ? text[j] : undefined;
    // The longest keyword is 6 characters; one more keeps the \b of the original whole-prefix test.
    if (prev !== undefined && !'{},;'.includes(prev) && !METHOD_PREFIX_KEYWORD.test(text.slice(Math.max(0, j - 6), j + 1))) continue;
    addHead(m.index + m[0].length - 1, paramNames(m[2]), null, m.index);
  }

  heads.sort((a, b) => a.open - b.open);
  for (const h of heads) {
    scopes.push({ id: scopes.length, start: h.open, end: braces.has(h.open) ? braces.get(h.open) : text.length, parent: null, declared: new Set(h.params), head: h });
  }

  // Scopes come from matched braces, so they are properly nested; sorted by start, each one's
  // parent is found with a stack, and the innermost scope holding an index is the last scope
  // starting before it or one of that scope's ancestors (binary search, then a short walk up).
  const contains = (s, index) => index > s.start && index <= s.end;
  const stack = [scopes[0]];
  for (let i = 1; i < scopes.length; i += 1) {
    const s = scopes[i];
    while (!contains(stack[stack.length - 1], s.start)) stack.pop();
    s.parent = stack[stack.length - 1].id;
    stack.push(s);
  }
  const scopeAt = (index) => {
    let lo = 0;
    let hi = scopes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (scopes[mid].start < index) lo = mid;
      else hi = mid - 1;
    }
    let id = lo;
    while (id > 0 && !contains(scopes[id], index)) id = scopes[id].parent;
    return id;
  };

  for (let i = 1; i < scopes.length; i += 1) {
    const s = scopes[i];
    // A named function declaration binds its name in the enclosing scope.
    if (s.head.name) scopes[scopeAt(s.head.nameIndex)].declared.add(s.head.name);
  }
  for (const m of text.matchAll(DECLARATION)) {
    const owner = scopes[scopeAt(m.index)];
    declaredBy(text, m.index + m[0].length).forEach((n) => owner.declared.add(n));
  }

  const resolve = (name, index) => {
    for (let id = scopeAt(index); id !== null; id = scopes[id].parent) {
      if (scopes[id].declared.has(name)) return id;
    }
    return null;
  };

  return { scopes, scopeAt, resolve, bindingAt: (name, index) => resolve(name, index) ?? 0 };
}
