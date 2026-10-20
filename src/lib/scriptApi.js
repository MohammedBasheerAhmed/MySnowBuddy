// The public surface of a Script Include, and who uses it. Pure: no DOM, no network.
//
//   declaredMembers(source)           methods a Script Include declares, with their parameters
//   diffApi(before, after)            what a save removes, renames or reshapes
//   selfCalls(source, names)          `this.name(` calls inside the same script
//   callersOf(source, class, methods) which of those methods another script calls on the class
//   referenceTarget(source, index)    what the caret is on: a class, a method of a class, or plain text
//   classifyReference(...)            is a script that mentions the term really using it?
//
// Two features sit on this: the save-time breaking-change check (src/content/breakingCheck.js) and
// "find all references" in the script editor (src/content/references.js). Both only suggest and ask; nothing here writes.

import { stripComments, scriptIncludeCalls, CLASS_RE } from './impact.js';

const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'else', 'do', 'try', 'typeof', 'new']);
/** Present on every class; callers never depend on them. */
const FRAMEWORK = new Set(['initialize', 'type']);

const lineAt = (text, index) => {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
};

const parseParams = (raw) =>
  String(raw || '')
    .split(',')
    .map((p) => p.replace(/=.*/s, '').replace(/\/\*.*?\*\//gs, '').trim())
    .filter(Boolean);

/**
 * Methods a script declares: `name: function (a, b) {`, `X.prototype.name = function (a) {` and `name(a) {`.
 * Local helper functions (`function helper() {}`) are not members. First declaration of a name wins.
 * @returns {Array<{name: string, params: string[], line: number}>}
 */
export function declaredMembers(source) {
  const text = stripComments(String(source || ''));
  const found = new Map();
  const add = (name, rawParams, index) => {
    if (!CLASS_RE.test(name) || NOT_METHODS.has(name) || found.has(name)) return;
    found.set(name, { name, params: parseParams(rawParams), line: lineAt(text, index) });
  };

  for (const m of text.matchAll(/(?:^|[\s,{])(['"]?)([A-Za-z_$][\w$]*)\1\s*:\s*function\b\s*[\w$]*\s*\(([^)]*)\)/g)) {
    add(m[2], m[3], m.index);
  }
  for (const m of text.matchAll(/\b[A-Za-z_$][\w$]*\.prototype\.([A-Za-z_$][\w$]*)\s*=\s*function\b\s*[\w$]*\s*\(([^)]*)\)/g)) {
    add(m[1], m[2], m.index);
  }
  for (const m of text.matchAll(/(?:^|[\s,{}])([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)) {
    if (/\bfunction\s*$/.test(text.slice(Math.max(0, m.index - 12), m.index + m[0].indexOf(m[1])))) continue;
    add(m[1], m[2], m.index);
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * What changed in the public surface between two versions of a Script Include.
 *  removed:  gone (and not just renamed). `renamedTo` is set when one added method looks like the same method.
 *  fewer:    the method takes fewer parameters, so callers pass values that are now ignored.
 *  reordered: same parameters in a different order.
 * Added methods and parameters appended at the end are not breaking and are not reported.
 * @returns {{ breaking: Array<{kind: 'removed'|'fewer'|'reordered', name: string, before: string[], after?: string[], renamedTo?: string}>, added: string[] }}
 */
export function diffApi(before, after) {
  const b = new Map(declaredMembers(before).filter((m) => !FRAMEWORK.has(m.name)).map((m) => [m.name, m]));
  const a = new Map(declaredMembers(after).filter((m) => !FRAMEWORK.has(m.name)).map((m) => [m.name, m]));
  const added = [...a.keys()].filter((name) => !b.has(name));
  const taken = new Set();
  const breaking = [];

  for (const [name, old] of b) {
    const now = a.get(name);
    if (!now) {
      // A rename keeps the parameters: an unused added method with the same list is the likely new name.
      const same = added.filter((n) => !taken.has(n) && sameList(a.get(n).params, old.params));
      const sameCount = added.filter((n) => !taken.has(n) && a.get(n).params.length === old.params.length);
      const pick = same.length === 1 ? same[0] : same.length === 0 && sameCount.length === 1 ? sameCount[0] : null;
      if (pick) taken.add(pick);
      breaking.push({ kind: 'removed', name, before: old.params, ...(pick ? { renamedTo: pick } : {}) });
    } else if (now.params.length < old.params.length) {
      breaking.push({ kind: 'fewer', name, before: old.params, after: now.params });
    } else if (!sameList(now.params.slice(0, old.params.length), old.params) && sameList([...now.params].sort(), [...old.params].sort())) {
      breaking.push({ kind: 'reordered', name, before: old.params, after: now.params });
    }
  }
  return { breaking, added: added.filter((n) => !taken.has(n)) };
}

/** `this.name(` calls in a script: methods the script still calls on itself. */
export function selfCalls(source, names) {
  const wanted = new Set(names || []);
  if (!wanted.size) return [];
  const text = stripComments(String(source || ''));
  const out = [];
  for (const m of text.matchAll(/\bthis\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (wanted.has(m[1])) out.push({ name: m[1], line: lineAt(text, m.index) });
  }
  return out;
}

/**
 * Which of `methods` another script calls on the Script Include `className` (`new X().m()`, `x.m()`, `X.m()`,
 * `new GlideAjax('X')` with `sysparm_name`). `methods` null means "any use of the class".
 * @returns {{ uses: boolean, methods: string[], via: string, lines: number[] } | null}
 */
export function callersOf(source, className, methods = null) {
  const entry = scriptIncludeCalls(source).find((c) => c.name === className);
  if (!entry) return null;
  const hit = methods ? entry.methods.filter((m) => methods.includes(m)) : entry.methods;
  if (methods && !hit.length) return null;
  const text = stripComments(String(source || ''));
  const lines = [];
  const probe = hit.length ? hit : [className];
  for (const name of probe) {
    const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
    for (const m of text.matchAll(re)) lines.push(lineAt(text, m.index));
  }
  return { uses: true, methods: hit, via: entry.via, lines: [...new Set(lines)].sort((x, y) => x - y).slice(0, 6) };
}

// ---- Find all references ------------------------------------------------------------------

const WORD = /[\w$]/;

/** The identifier under (or just before) `index`, with its offsets. */
export function wordAt(source, index) {
  const text = String(source || '');
  let i = Math.min(Math.max(index, 0), text.length);
  if (!WORD.test(text[i] || '') && WORD.test(text[i - 1] || '')) i -= 1;
  if (!WORD.test(text[i] || '')) return null;
  let start = i;
  let end = i;
  while (start > 0 && WORD.test(text[start - 1])) start -= 1;
  while (end < text.length && WORD.test(text[end])) end += 1;
  const word = text.slice(start, end);
  return /^\d/.test(word) ? null : { word, start, end };
}

/**
 * What the caret is on.
 *   { kind: 'method', name, className }  `Foo.bar`, `new Foo().bar`, `foo.bar` after `var foo = new Foo()`, or a method this
 *                                        Script Include declares (`this.bar`, or the declaration itself)
 *   { kind: 'class', name }              `Foo` (a capitalised name), or the Script Include being edited
 *   { kind: 'text', name }               anything else of three or more characters
 * @param {{ table?: string, ownName?: string }} ctx the form's table and (on a Script Include) its class name
 */
export function referenceTarget(source, index, { table = '', ownName = '' } = {}) {
  const text = String(source || '');
  const hit = wordAt(text, index);
  if (!hit || NOT_METHODS.has(hit.word)) return null;
  const { word, start } = hit;
  const own = table === 'sys_script_include' && CLASS_RE.test(ownName) ? ownName : '';

  const before = stripComments(text).slice(0, start);
  const dot = /([\w$]+)\s*(\(\s*\))?\s*\.\s*$/.exec(before);
  if (dot) {
    const receiver = dot[1];
    if (receiver === 'this' && own) return { kind: 'method', name: word, className: own };
    const chained = /\bnew\s+(?:(?:global|x_[a-z0-9_]+|sn_[a-z0-9_]+)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\.\s*$/.exec(before);
    if (chained) return { kind: 'method', name: word, className: chained[1] };
    if (/^[A-Z]/.test(receiver)) return { kind: 'method', name: word, className: receiver };
    const assign = [...before.matchAll(new RegExp(`\\b${receiver.replace(/\$/g, '\\$')}\\s*=\\s*new\\s+(?:(?:global|x_[a-z0-9_]+|sn_[a-z0-9_]+)\\s*\\.\\s*)?([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))].pop();
    if (assign) return { kind: 'method', name: word, className: assign[1] };
  }

  if (own && declaredMembers(text).some((m) => m.name === word)) return { kind: 'method', name: word, className: own };
  if (own && word === own) return { kind: 'class', name: word };
  if (/^[A-Z][\w$]*$/.test(word) && !/^[A-Z0-9_]+$/.test(word)) return { kind: 'class', name: word };
  if (word.length >= 3) return { kind: 'text', name: word };
  return null;
}

/** The search term to send to the instance for a target. */
export const searchTermFor = (target) => (target ? target.name : '');

/**
 * Is a script that contains the term really using the target?
 *   'call'   confirmed: the class is created or its static method called (and the method, for a method target)
 *   'maybe'  the name appears as `.name(` but the receiver is unknown, or the class is only mentioned
 *   null     not a use (a comment, a different class, an unrelated word)
 */
export function classifyReference(source, target) {
  if (!target) return null;
  const text = stripComments(String(source || ''));
  const word = (name) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
  if (target.kind === 'text') return word(target.name).test(text) ? 'maybe' : null;
  if (target.kind === 'class') {
    if (callersOf(source, target.name)) return 'call';
    return word(target.name).test(text) ? 'maybe' : null;
  }
  const exact = callersOf(source, target.className, [target.name]);
  if (exact) return 'call';
  return new RegExp(`\\.\\s*${target.name.replace(/\$/g, '\\$')}\\s*\\(`).test(text) ? 'maybe' : null;
}

/** Lines of a script that mention the target, for display ("12: new Foo().bar(x)"). */
export function referenceLines(source, target, max = 4) {
  if (!target) return [];
  const re = new RegExp(`(?<![\\w$])${target.name.replace(/\$/g, '\\$')}(?![\\w$])`);
  const out = [];
  const lines = String(source || '').split('\n');
  for (let i = 0; i < lines.length && out.length < max; i += 1) {
    if (!re.test(lines[i])) continue;
    const t = lines[i].trim();
    if (/^(\/\/|\*|\/\*)/.test(t)) continue;
    out.push({ line: i + 1, text: t.length > 160 ? `${t.slice(0, 159)}…` : t });
  }
  return out;
}
