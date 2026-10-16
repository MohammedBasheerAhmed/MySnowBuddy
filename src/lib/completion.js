// Code intelligence for the script editor: context-aware completion, hover docs, signature help
// and go-to-definition targets for ServiceNow scripts. Pure (no DOM, no network): data the
// editor has not loaded yet (dictionary fields, table / Script Include / property / role names,
// Script Include methods) is reported in `needs`; the caller fetches it and asks again.
//
// Like lint.js and apiCheck.js this is a heuristic reader, not a parser: it understands
// `receiver.member` chains, `var x = new Class('arg')` assignments (the nearest one before the
// caret wins) and the string argument the caret is in. Anything it cannot resolve yields nothing.
import { analyze, masked, rangeAt, lineStartAt, STRING, COMMENT, KEYWORDS } from './editorText.js';
import { getApi, findMethod, apiNames, GLOBAL_TYPE_ALIASES, INHERITS } from './apiCatalog/index.js';
import { SNIPPETS } from './snippets.js';

// Catalog entries that document conventions rather than objects you can call.
const PSEUDO = new Set(['ClientScriptTypes', 'globals', 'ServerRuntime', 'ScriptIncludePatterns', 'answer', 'parm1', 'parm2', 'email']);
const RECORD_CLASSES = new Set(['GlideRecord', 'GlideRecordSecure', 'GlideAggregate']);
const TABLE_ARG_CLASSES = new Set(['GlideRecord', 'GlideRecordSecure', 'GlideAggregate', 'GlideQuery', 'TableUtils']);
const JS_BUILTINS = new Set(['Date', 'Array', 'Object', 'RegExp', 'Error', 'String', 'Number', 'Boolean', 'Map', 'Set', 'Promise', 'JSON', 'Math', 'Function', 'Class', 'TypeError', 'RangeError', 'Packages']);

const G_FORM_FIELD_METHODS = new Set(
  ('getValue setValue clearValue getBooleanValue getIntValue getDecimalValue setMandatory setReadOnly setReadonly setDisabled ' +
    'setDisplay setVisible isMandatory showFieldMsg hideFieldMsg flash getLabelOf setLabelOf addOption removeOption clearOptions ' +
    'getReference setFieldPlaceholder getDisplayBox getControl getElement hasField addDecoration removeDecoration showErrorBox hideErrorBox').split(' ')
);
// Record methods whose Nth argument is a field name.
const RECORD_FIELD_ARGS = {
  addQuery: [0],
  addNullQuery: [0],
  addNotNullQuery: [0],
  orderBy: [0],
  orderByDesc: [0],
  getValue: [0],
  setValue: [0],
  getDisplayValue: [0],
  setDisplayValue: [0],
  getElement: [0],
  isValidField: [0],
  getAttribute: [0],
  groupBy: [0],
  addAggregate: [1],
  getAggregate: [1],
  orderByAggregate: [1],
  addCondition: [0],
  addOrCondition: [0],
};
const ROLE_METHODS = new Set(['hasRole', 'hasRoleExactly', 'hasRoleFromList', 'hasRoleInGroup']);
const PROPERTY_METHODS = new Set(['getProperty', 'setProperty']);

const COMMON_TABLES = [
  'incident', 'problem', 'change_request', 'change_task', 'sc_request', 'sc_req_item', 'sc_task', 'task', 'sys_user',
  'sys_user_group', 'sys_user_grmember', 'sys_user_has_role', 'cmdb_ci', 'cmn_location', 'core_company', 'kb_knowledge',
  'sys_attachment', 'sys_journal_field', 'sys_audit', 'sys_choice', 'sys_dictionary', 'sys_db_object', 'sys_properties',
  'sys_script', 'sys_script_include', 'sys_script_client', 'sys_ui_policy', 'sys_ui_action', 'sysevent', 'sys_email', 'syslog',
];

const KIND_RANK = { field: 0, method: 1, property: 1, variable: 2, function: 2, global: 3, class: 3, scriptInclude: 4, table: 0, propertyName: 0, role: 0, snippet: 5, keyword: 6 };

// ---- fuzzy matching ----------------------------------------------------------------------------

const isBoundary = (label, i) => {
  if (i === 0) return true;
  const prev = label[i - 1];
  const cur = label[i];
  return prev === '_' || prev === '.' || prev === '$' || (cur >= 'A' && cur <= 'Z' && prev >= 'a' && prev <= 'z');
};

/**
 * Scores `label` against what was typed. Prefix beats word-boundary match beats substring beats
 * subsequence; the first typed character must start the label or one of its words.
 * @returns {{score: number, positions: number[]} | null}
 */
export function fuzzyMatch(query, label) {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  const range = (from, len) => Array.from({ length: len }, (_, i) => from + i);
  if (label.startsWith(query)) return { score: 1000 - (label.length - query.length), positions: range(0, query.length) };
  if (l.startsWith(q)) return { score: 900 - (label.length - query.length), positions: range(0, query.length) };
  const idx = l.indexOf(q);
  if (idx > 0 && isBoundary(label, idx)) return { score: 700 - idx, positions: range(idx, q.length) };
  const contains = () => (idx > 0 && q.length >= 3 ? { score: 300 - idx, positions: range(idx, q.length) } : null);
  // Subsequence that prefers word starts (addEncodedQuery <- "aeq", short_description <- "sdesc").
  const positions = [];
  let from = 0;
  let boundaryHits = 0;
  for (let k = 0; k < q.length; k += 1) {
    let found = -1;
    for (let i = from; i < l.length; i += 1) {
      if (l[i] === q[k] && isBoundary(label, i)) {
        found = i;
        break;
      }
    }
    if (found === -1) found = l.indexOf(q[k], from);
    if (found === -1 || (k === 0 && !isBoundary(label, found))) return contains();
    if (isBoundary(label, found)) boundaryHits += 1;
    positions.push(found);
    from = found + 1;
  }
  const spread = positions[positions.length - 1] - positions[0];
  return { score: 400 + boundaryHits * 10 - spread, positions };
}

// ---- signatures -------------------------------------------------------------------------------------

function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * "addQuery(fieldName, value) | addQuery(fieldName, operator, value)" ->
 * [{name, label, params: [{text, start, end}]}]. A receiver prefix ("this.", "JSON.") is dropped.
 */
export function parseSignature(sig) {
  return splitTopLevel(String(sig || ''), '|')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const open = part.indexOf('(');
      const close = part.lastIndexOf(')');
      let name = open === -1 ? part : part.slice(0, open).trim();
      name = name.slice(name.lastIndexOf('.') + 1);
      const inner = open === -1 || close < open ? '' : part.slice(open + 1, close);
      const texts = inner.trim() ? splitTopLevel(inner, ',').map((p) => p.trim()) : [];
      let label = `${name}(`;
      const params = texts.map((t, i) => {
        if (i) label += ', ';
        const start = label.length;
        label += t;
        return { text: t, start, end: label.length };
      });
      label += ')';
      return { name, label, params };
    });
}

const hasParams = (sig) => parseSignature(sig).some((o) => o.params.length);

// ---- Script Include parsing -----------------------------------------------------------------------

function docBefore(text, pos) {
  let i = pos - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (text[i] === '/' && text[i - 1] === '*') {
    const open = text.lastIndexOf('/*', i - 1);
    if (open === -1) return '';
    const body = text
      .slice(open + 2, i - 1)
      .split('\n')
      .map((l) => l.replace(/^\s*\*+\s?/, '').trim())
      .filter((l) => l && !l.startsWith('@'));
    return (body[0] || '').slice(0, 200);
  }
  const lineStart = text.lastIndexOf('\n', i) + 1;
  const line = text.slice(lineStart, i + 1).trim();
  return line.startsWith('//') ? line.replace(/^\/\/+\s?/, '').slice(0, 200) : '';
}

const cleanParams = (list) =>
  list
    .split(',')
    .map((p) => p.replace(/\/\*[\s\S]*?\*\//g, '').trim())
    .filter(Boolean);

/**
 * Methods of a Script Include from its source: prototype object members (`name: function(a, b)`
 * and ES6 shorthand), `X.prototype.name = function`, the parent class and whether it is a
 * client-callable (AbstractAjaxProcessor) class.
 * @returns {{className: string|null, parent: string|null, ajax: boolean, methods: {name: string, params: string[], doc: string}[], initParams: string[]|null}}
 */
export function parseScriptIncludeMethods(script) {
  const text = String(script || '');
  const info = analyze(text);
  const m = masked(info);
  const className = (/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*Class\s*\.\s*create\s*\(/.exec(m) || [])[1] || null;
  const parentMatch = /Object\s*\.\s*extendsObject\s*\(\s*([A-Za-z_$][\w$.]*)\s*,/.exec(m);
  const parent = parentMatch ? parentMatch[1].split('.').pop() : null;
  const methods = new Map();
  let initParams = null;
  const add = (name, params, at) => {
    if (name === 'initialize') {
      initParams = params;
      return;
    }
    if (!methods.has(name)) methods.set(name, { name, params, doc: docBefore(text, at) });
  };

  // The object literal given to `X.prototype = {` or `Object.extendsObject(Base, {`.
  const objStarts = [];
  for (const hit of m.matchAll(/\.\s*prototype\s*=\s*(?:Object\s*\.\s*extendsObject\s*\([^,]*,\s*)?\{/g)) objStarts.push(hit.index + hit[0].length - 1);
  for (const open of objStarts) {
    let depth = 0;
    let expectKey = true;
    for (let i = open; i < m.length; i += 1) {
      const c = m[i];
      if (c === '{' || c === '(' || c === '[') {
        depth += 1;
        if (depth === 1) expectKey = true;
        continue;
      }
      if (c === '}' || c === ')' || c === ']') {
        depth -= 1;
        if (depth === 0) break;
        continue;
      }
      if (depth !== 1) continue;
      if (c === ',') {
        expectKey = true;
        continue;
      }
      if (expectKey && /[A-Za-z_$]/.test(c)) {
        const re = /([A-Za-z_$][\w$]*)\s*:\s*function\b[^(]*\(([^)]*)\)|([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/y;
        re.lastIndex = i;
        const hit = re.exec(m);
        if (hit) add(hit[1] || hit[3], cleanParams(hit[2] ?? hit[4] ?? ''), i);
        expectKey = false;
      } else if (!/\s/.test(c)) expectKey = false;
    }
  }
  for (const hit of m.matchAll(/\.\s*prototype\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*function\b[^(]*\(([^)]*)\)/g)) {
    add(hit[1], cleanParams(hit[2]), hit.index);
  }
  return { className, parent, ajax: parent === 'AbstractAjaxProcessor', methods: [...methods.values()], initParams };
}

// ---- environment ---------------------------------------------------------------------------------------

let assignCache = null;

/** Every `name = expr` in code: Map name -> sorted [{index, exprStart}]. */
function assignments(text, m) {
  if (assignCache && assignCache.text === text) return assignCache.map;
  const map = new Map();
  for (const hit of m.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*/g)) {
    const list = map.get(hit[1]) || [];
    list.push({ index: hit.index, exprStart: hit.index + hit[0].length });
    map.set(hit[1], list);
  }
  assignCache = { text, map };
  return map;
}

// The masked text and the assignment index are built on first use: typing a plain word needs neither.
function makeEnv(text, ctx = {}) {
  const info = analyze(text);
  const side = ctx.side === 'client' ? 'client' : 'server';
  let m = null;
  let assigns = null;
  return {
    text: info.text,
    info,
    ctx,
    side,
    needs: new Map(),
    get m() {
      if (m === null) m = masked(info);
      return m;
    },
    get assigns() {
      if (assigns === null) assigns = assignments(info.text, this.m);
      return assigns;
    },
  };
}

function need(env, item) {
  const key = JSON.stringify(item);
  if (!env.needs.has(key)) env.needs.set(key, item);
}

function fieldsOf(env, table) {
  if (!table) return null;
  const list = env.ctx.fields?.[table];
  if (list === undefined) {
    need(env, { type: 'fields', table });
    return null;
  }
  return list; // null when the dictionary could not be read: unknown, not empty
}

function siInfo(env, name) {
  if (!name) return null;
  const hit = env.ctx.siMethods?.[name];
  if (hit === undefined) {
    need(env, { type: 'siMethods', name });
    return null;
  }
  return hit;
}

// ---- chains ------------------------------------------------------------------------------------------------

const ID_CHAR = /[\w$]/;

function matchForward(m, open, max = 20000) {
  let depth = 0;
  for (let i = open, end = Math.min(m.length, open + max); i < end; i += 1) {
    const c = m[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchBackward(m, close, max = 20000) {
  let depth = 0;
  for (let i = close, end = Math.max(0, close - max); i >= end; i -= 1) {
    const c = m[i];
    if (c === ')' || c === ']' || c === '}') depth += 1;
    else if (c === '(' || c === '[' || c === '{') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Reads the member chain that ends just before `end` (exclusive), e.g. `gs.getUser()` or
 * `new GlideRecord('incident')`. @returns {{segments: {name, call, args, argsStart}[], isNew: boolean, start: number} | null}
 */
function chainBefore(env, end) {
  const { m, text } = env;
  const segments = [];
  let i = end;
  for (let guard = 0; guard < 12; guard += 1) {
    while (i > 0 && /\s/.test(m[i - 1])) i -= 1;
    let seg = { name: '', call: false, args: '', argsStart: -1 };
    if (m[i - 1] === ')') {
      const open = matchBackward(m, i - 1);
      if (open === -1) return null;
      seg = { name: '', call: true, args: text.slice(open + 1, i - 1), argsStart: open + 1 };
      i = open;
      while (i > 0 && /\s/.test(m[i - 1])) i -= 1;
    } else if (m[i - 1] === ']') return null;
    let s = i;
    while (s > 0 && ID_CHAR.test(m[s - 1])) s -= 1;
    if (s === i || /\d/.test(m[s])) return null;
    seg.name = m.slice(s, i);
    segments.unshift(seg);
    i = s;
    let j = i;
    while (j > 0 && /\s/.test(m[j - 1])) j -= 1;
    // A dot at the end of the previous line ("gs.") is almost always an unfinished line, not
    // a chain; a dot that starts a line ("gr\n  .query()") is a chain.
    if (m[j - 1] === '.' && m[j - 2] !== '.' && !m.slice(j, i).includes('\n')) {
      i = j - 1;
      continue;
    }
    const isNew = /(?:^|[^\w$.])new\s+$/.test(m.slice(Math.max(0, i - 8), i));
    return { segments, isNew, start: isNew ? m.lastIndexOf('new', i) : i };
  }
  return null;
}

/** Reads the chain that starts at `pos`: `new X(...)` or `a.b(...).c`. */
function chainAfter(env, pos) {
  const { m, text } = env;
  let i = pos;
  const skip = () => {
    while (i < m.length && /\s/.test(m[i])) i += 1;
  };
  skip();
  let isNew = false;
  if (m.startsWith('new', i) && /\s/.test(m[i + 3] || '')) {
    isNew = true;
    i += 3;
    skip();
  }
  const segments = [];
  for (let guard = 0; guard < 12; guard += 1) {
    const s = i;
    while (i < m.length && ID_CHAR.test(m[i])) i += 1;
    if (s === i || /\d/.test(m[s])) return segments.length ? { segments, isNew } : null;
    const seg = { name: m.slice(s, i), call: false, args: '', argsStart: -1 };
    skip();
    if (m[i] === '(') {
      const close = matchForward(m, i);
      if (close === -1) return null;
      seg.call = true;
      seg.args = text.slice(i + 1, close);
      seg.argsStart = i + 1;
      i = close + 1;
      skip();
    }
    segments.push(seg);
    if (m[i] === '.' && m[i + 1] !== '.') {
      i += 1;
      skip();
      continue;
    }
    break;
  }
  return segments.length ? { segments, isNew } : null;
}

const firstStringArg = (args) => (/^\s*(['"])([^'"\n\\]*)\1/.exec(args || '') || [])[2] ?? null;

function typeForNew(env, cls, args) {
  const api = getApi(cls, env.side);
  if (api && api.kind === 'class') {
    if (TABLE_ARG_CLASSES.has(cls)) return { api: cls, table: firstStringArg(args) || null };
    if (cls === 'GlideAjax') return { api: cls, target: firstStringArg(args) || null };
    return { api: cls };
  }
  if (api || JS_BUILTINS.has(cls) || getApi(cls, env.side === 'client' ? 'server' : 'client')) return null;
  if (env.side === 'server' && /^[A-Za-z_$][\w$]*$/.test(cls)) return { si: cls };
  return null;
}

function resolveIdentifier(env, name, pos, depth) {
  if (name === 'this') return env.side === 'server' && /\.\s*prototype\s*=/.test(env.m) ? { self: true } : null;
  const list = env.assigns.get(name);
  if (list) {
    let hit = null;
    for (const a of list) {
      if (a.index < pos) hit = a;
      else break;
    }
    if (hit) {
      if (depth > 4) return null;
      const chain = chainAfter(env, hit.exprStart);
      return chain ? resolveChain(env, chain, hit.index, depth + 1) : null;
    }
  }
  if (env.side === 'server' && GLOBAL_TYPE_ALIASES[name]) return { api: GLOBAL_TYPE_ALIASES[name], table: env.ctx.table || null, alias: name };
  if (name === 'g_scratchpad') return { api: 'g_scratchpad', scratch: true };
  if (PSEUDO.has(name)) return null;
  const api = getApi(name, env.side);
  if (api && api.kind === 'global') return { api: name };
  return null;
}

function referenceOf(env, table, field) {
  const fields = fieldsOf(env, table);
  const hit = fields && fields.find((f) => f.name === field);
  return hit && hit.reference ? hit.reference : null;
}

function memberType(env, type, seg) {
  if (type.api) {
    const api = getApi(type.api, env.side);
    if (!api) return null;
    if (seg.call) {
      if (RECORD_CLASSES.has(type.api) && seg.name === 'getElement') {
        const field = firstStringArg(seg.args);
        return field && env.side === 'server' ? { element: true, table: type.table, field } : null;
      }
      const hit = findMethod(api, seg.name, env.side);
      const returns = hit?.method.returns;
      if (!returns || !getApi(returns, env.side)) return null;
      if (returns === 'GlideQueryCondition' && type.table) return { api: returns, table: type.table };
      if (returns === 'GlideRecord' && type.api === 'g_form' && seg.name === 'getReference') return null;
      return { api: returns };
    }
    if (RECORD_CLASSES.has(type.api) && env.side === 'server' && !findMethod(api, seg.name, env.side)) {
      return { element: true, table: type.table, field: seg.name };
    }
    return null;
  }
  if (type.element) {
    const glideElement = getApi('GlideElement', 'server');
    const ref = type.table ? referenceOf(env, type.table, type.field) : null;
    if (seg.call) {
      if (seg.name === 'getRefRecord') return { api: 'GlideRecord', table: ref };
      const hit = glideElement && findMethod(glideElement, seg.name, 'server');
      const returns = hit?.method.returns;
      return returns && getApi(returns, 'server') ? { api: returns } : null;
    }
    if (glideElement && findMethod(glideElement, seg.name, 'server')) return null;
    return { element: true, table: ref, field: seg.name };
  }
  return null;
}

function resolveChain(env, chain, pos, depth = 0) {
  const { segments, isNew } = chain;
  if (!segments.length) return null;
  let type;
  let i;
  if (isNew) {
    let k = segments.findIndex((s) => s.call);
    if (k === -1) k = segments.length - 1;
    type = typeForNew(env, segments[k].name, segments[k].args);
    i = k + 1;
  } else {
    if (segments[0].call) return null;
    type = resolveIdentifier(env, segments[0].name, pos, depth);
    i = 1;
  }
  for (; i < segments.length && type; i += 1) type = memberType(env, type, segments[i]);
  return type || null;
}

/** Human label for a resolved type ("GlideRecord (incident)"). */
function typeLabel(type) {
  if (!type) return '';
  if (type.api) return `${type.api}${type.table ? ` (${type.table})` : ''}${type.target ? ` -> ${type.target}` : ''}`;
  if (type.element) return `GlideElement${type.table && type.field ? ` (${type.table}.${type.field})` : ''}`;
  if (type.si) return `${type.si} (Script Include)`;
  if (type.self) return 'this Script Include';
  return '';
}

// ---- call context ------------------------------------------------------------------------------------------

/**
 * The call whose argument list contains `pos`: {open, argIndex, argStart} or null. Uses the masked
 * text, so brackets and commas inside strings and comments do not count.
 */
function enclosingCall(m, pos, max = 4000) {
  let depth = 0;
  let commas = 0;
  let argStart = -1;
  for (let i = pos - 1, end = Math.max(0, pos - max); i >= end; i -= 1) {
    const c = m[i];
    if (c === ')' || c === ']' || c === '}') depth += 1;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) {
        if (c !== '(') return null;
        return { open: i, argIndex: commas, argStart: argStart === -1 ? i + 1 : argStart };
      }
      depth -= 1;
    } else if (depth === 0) {
      if (c === ',') {
        if (argStart === -1) argStart = i + 1;
        commas += 1;
      } else if (c === ';') return null;
    }
  }
  return null;
}

/** The callee of the call opened at `open`: {type (receiver type), method} or {ctor: className, type}. */
function calleeAt(env, open) {
  const chain = chainBefore(env, open);
  if (!chain) return null;
  const { segments, isNew } = chain;
  const last = segments[segments.length - 1];
  if (isNew) {
    if (segments.some((s) => s.call)) return null;
    return { ctor: last.name, path: segments.map((s) => s.name).join('.') };
  }
  if (segments.length === 1) return { fn: last.name };
  const receiver = resolveChain(env, { segments: segments.slice(0, -1), isNew: false }, chain.start);
  return { type: receiver, method: last.name, receiverName: segments.length === 2 ? segments[0].name : null };
}

/**
 * What a string literal at `range` is: {kind, table?, si?, list?} where kind is fields | tables |
 * scriptIncludes | ajaxMethods | properties | roles; `encoded` marks an encoded query, `dotWalk`
 * a field path that may be dot-walked.
 */
function stringContext(env, range) {
  const call = enclosingCall(env.m, range.start);
  if (!call) return null;
  if (env.m.slice(call.argStart, range.start).trim()) return null; // the string is not the whole argument
  const callee = calleeAt(env, call.open);
  if (!callee) return null;
  const { argIndex } = call;
  if (callee.ctor) {
    if (argIndex === 0 && TABLE_ARG_CLASSES.has(callee.ctor) && getApi(callee.ctor, env.side)) return { kind: 'tables' };
    if (argIndex === 0 && callee.ctor === 'GlideAjax') return { kind: 'scriptIncludes', clientCallable: true };
    return null;
  }
  if (callee.fn || !callee.type) return null;
  const { type, method } = callee;
  if (type.api === 'g_form' && argIndex === 0 && G_FORM_FIELD_METHODS.has(method)) return { kind: 'fields', form: true, table: env.ctx.table || null };
  if ((RECORD_CLASSES.has(type.api) || type.api === 'GlideQueryCondition') && RECORD_FIELD_ARGS[method]?.includes(argIndex)) {
    return { kind: 'fields', table: type.table || null, dotWalk: true };
  }
  if (RECORD_CLASSES.has(type.api) && argIndex === 0 && (method === 'addEncodedQuery' || method === 'applyEncodedQuery')) {
    return { kind: 'fields', table: type.table || null, dotWalk: true, encoded: true };
  }
  if (type.api === 'gs' && argIndex === 0 && PROPERTY_METHODS.has(method)) return { kind: 'properties' };
  if ((type.api === 'gs' || type.api === 'g_user' || type.api === 'GlideUser') && argIndex === 0 && ROLE_METHODS.has(method)) {
    return { kind: 'roles', list: method === 'hasRoleFromList' };
  }
  if (type.api === 'GlideAjax' && method === 'addParam' && argIndex === 1 && type.target) {
    const firstArg = env.text.slice(call.open + 1, call.argStart - 1);
    if (firstStringArg(firstArg) === 'sysparm_name') return { kind: 'ajaxMethods', si: type.target };
  }
  return null;
}

// ---- items -------------------------------------------------------------------------------------------------

function methodItems(env, apiName) {
  const api = getApi(apiName, env.side);
  if (!api) return [];
  const { scoped } = env.ctx;
  const out = [];
  const seen = new Set();
  const owners = [api, ...(INHERITS[api.name] || []).map((p) => getApi(p, env.side)).filter(Boolean)];
  owners.forEach((owner) => {
    owner.methods.forEach((m) => {
      if (seen.has(m.name)) return;
      if (scoped === true && m.globalOnly) return;
      if (scoped === false && m.scopedOnly) return;
      seen.add(m.name);
      const flags = [];
      if (m.scopedOnly) flags.push('scoped apps only');
      if (m.globalOnly) flags.push('global scope only');
      if (m.unsupportedIn?.length) flags.push(`not in ${m.unsupportedIn.join(', ')}`);
      out.push({
        label: m.name,
        kind: 'method',
        detail: m.returns || '',
        doc: m.summary || '',
        sig: m.sig || `${m.name}()`,
        owner: owner.name,
        params: hasParams(m.sig),
        deprecated: Boolean(m.deprecated),
        flags,
      });
    });
    owner.properties.forEach((p) => {
      if (seen.has(p.name) || /\s/.test(p.name)) return;
      seen.add(p.name);
      out.push({ label: p.name, kind: 'property', detail: p.type || '', doc: p.summary || '', owner: owner.name });
    });
  });
  return out;
}

function fieldItems(env, table) {
  const fields = fieldsOf(env, table);
  if (!fields) return [];
  return fields.map((f) => ({
    label: f.name,
    kind: 'field',
    detail: [f.type, f.reference ? `-> ${f.reference}` : ''].filter(Boolean).join(' '),
    doc: f.label || '',
    table,
  }));
}

function siMethodItems(env, name) {
  const si = siInfo(env, name);
  if (!si) return [];
  return (si.methods || []).map((m) => ({
    label: m.name,
    kind: 'method',
    detail: `(${(m.params || []).join(', ')})`,
    doc: [m.doc, m.inherited ? `From ${m.inherited}` : ''].filter(Boolean).join(' '),
    sig: `${m.name}(${(m.params || []).join(', ')})`,
    params: Boolean(m.params?.length),
    owner: name,
    private: m.name.startsWith('_'),
  }));
}

function membersOf(env, type) {
  if (type.self) {
    const own = parseScriptIncludeMethods(env.text);
    const items = own.methods.map((m) => ({ label: m.name, kind: 'method', detail: `(${m.params.join(', ')})`, doc: m.doc, sig: `${m.name}(${m.params.join(', ')})`, params: m.params.length > 0, owner: own.className || 'this' }));
    if (own.ajax) items.push(...methodItems(env, 'AbstractAjaxProcessor'));
    else if (own.parent && own.parent !== own.className) items.push(...siMethodItems(env, own.parent));
    return items;
  }
  if (type.si) return siMethodItems(env, type.si);
  if (type.element) {
    const items = env.side === 'server' ? methodItems(env, 'GlideElement') : [];
    const ref = type.table ? referenceOf(env, type.table, type.field) : null;
    if (ref) items.push(...fieldItems(env, ref));
    return items;
  }
  if (type.scratch) {
    const names = new Set();
    for (const hit of env.m.matchAll(/\bg_scratchpad\s*\.\s*([A-Za-z_$][\w$]*)/g)) names.add(hit[1]);
    return [...names].map((n) => ({ label: n, kind: 'property', detail: 'g_scratchpad', doc: '' }));
  }
  if (type.api) {
    const items = methodItems(env, type.api);
    if (RECORD_CLASSES.has(type.api) && env.side === 'server' && type.table) items.push(...fieldItems(env, type.table));
    return items;
  }
  return [];
}

function listItems(list, kind, map) {
  return (list || []).map(map).map((item) => ({ kind, ...item }));
}

function localNames(env) {
  const out = new Map();
  for (const hit of env.m.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) out.set(hit[1], 'variable');
  for (const hit of env.m.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    out.set(hit[1], 'function');
    hit[2].split(',').map((p) => p.trim()).filter((p) => /^[A-Za-z_$][\w$]*$/.test(p)).forEach((p) => out.has(p) || out.set(p, 'variable'));
  }
  return out;
}

function snippetItems(env, from) {
  const lineStart = lineStartAt(env.text, from);
  const indent = /^[ \t]*/.exec(env.text.slice(lineStart, from))[0];
  return Object.entries(SNIPPETS).map(([key, body]) => {
    const indented = body.split('\n').join(`\n${indent}`);
    const marker = indented.indexOf('$0');
    const insert = indented.replace('$0', '');
    return { label: key, kind: 'snippet', detail: body.split('\n')[0].replace('$0', '').slice(0, 48), doc: insert, insert, caret: marker === -1 ? insert.length : marker };
  });
}

function rank(items, prefix, limit) {
  const scored = [];
  for (const item of items) {
    const hit = fuzzyMatch(prefix, item.label);
    if (!hit) continue;
    let score = hit.score;
    if (item.deprecated) score -= 300;
    if (item.private) score -= 50;
    scored.push({ ...item, score, positions: hit.positions });
  }
  scored.sort((a, b) => b.score - a.score || (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || a.label.localeCompare(b.label));
  const seen = new Set();
  const out = [];
  for (const item of scored) {
    const key = `${item.kind}|${item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

// ---- string completions ------------------------------------------------------------------------------------

function stringCompletion(env, range, cursor, sc) {
  const { text } = env;
  const contentStart = range.start + 1;
  const content = text.slice(contentStart, cursor);
  let tail = cursor;
  while (tail < text.length && /[\w.]/.test(text[tail]) && tail < range.end - (range.closed ? 1 : 0)) tail += 1;

  if (sc.kind === 'fields') {
    let part = content;
    let partStart = contentStart;
    if (sc.encoded) {
      const caret = content.lastIndexOf('^');
      part = content.slice(caret + 1);
      partStart = contentStart + caret + 1;
      const sep = /^(?:ORDERBYDESC|ORDERBY|GROUPBY|NQ|OR)/.exec(part);
      if (sep) {
        part = part.slice(sep[0].length);
        partStart += sep[0].length;
      }
      if (!/^[a-z0-9_.]*$/.test(part)) return null; // past the field name: operator or value
    } else if (!/^[\w.]*$/.test(part)) return null;
    let table = sc.table;
    const path = part.split('.');
    const prefix = path.pop();
    if (path.length && !sc.dotWalk) return null;
    for (const step of path) {
      table = table ? referenceOf(env, table, step) : null;
      if (!table) return { from: cursor - prefix.length, to: tail, prefix, items: [] };
    }
    let items;
    if (sc.form && env.ctx.formFields) items = env.ctx.formFields.map((f) => ({ label: f.name, kind: 'field', detail: f.type || '', doc: f.label || '' }));
    else items = fieldItems(env, table);
    return { from: cursor - prefix.length, to: tail, prefix, items, table };
  }

  let prefix = content;
  if (sc.kind === 'roles' && sc.list) prefix = content.slice(content.lastIndexOf(',') + 1).trimStart();
  if (!/^[\w.]*$/.test(prefix)) return null;
  const from = cursor - prefix.length;
  const ctx = env.ctx;
  let items = [];
  if (sc.kind === 'tables') {
    if (prefix) need(env, { type: 'tables', prefix });
    const known = new Map();
    COMMON_TABLES.forEach((name) => known.set(name, { label: name, kind: 'table', detail: '', doc: '' }));
    if (ctx.table) known.set(ctx.table, { label: ctx.table, kind: 'table', detail: 'this table', doc: '' });
    (ctx.tables || []).forEach((t) => known.set(t.name, { label: t.name, kind: 'table', detail: t.label || '', doc: t.label || '' }));
    items = [...known.values()];
  } else if (sc.kind === 'scriptIncludes') {
    if (prefix) need(env, { type: 'scriptIncludes', prefix });
    items = listItems(
      (ctx.scriptIncludes || []).filter((s) => !sc.clientCallable || s.clientCallable !== false),
      'scriptInclude',
      (s) => ({ label: s.name, detail: s.clientCallable ? 'client callable' : 'Script Include', doc: s.description || '' })
    );
  } else if (sc.kind === 'ajaxMethods') {
    items = siMethodItems(env, sc.si).map((i) => ({ ...i, sig: undefined, params: false }));
  } else if (sc.kind === 'properties') {
    if (prefix) need(env, { type: 'properties', prefix });
    items = listItems(ctx.properties, 'propertyName', (p) => ({ label: p.name, detail: p.type || 'property', doc: p.description || '' }));
  } else if (sc.kind === 'roles') {
    if (prefix) need(env, { type: 'roles', prefix });
    items = listItems(ctx.roles, 'role', (r) => ({ label: r.name, detail: 'role', doc: r.description || '' }));
  }
  return { from, to: tail, prefix, items };
}

// ---- public API ---------------------------------------------------------------------------------------------

/**
 * Completions at `cursor`.
 * @param {string} text
 * @param {number} cursor
 * @param {{side?: 'client'|'server', table?: string, scoped?: boolean|null, fields?: Object<string, object[]|null>,
 *   formFields?: object[], tables?: object[], scriptIncludes?: object[], siMethods?: object, properties?: object[], roles?: object[]}} ctx
 * @param {{explicit?: boolean, limit?: number}} [options] explicit = Ctrl+Space (plain identifiers only complete then)
 * @returns {{from: number, to: number, prefix: string, context: string, items: object[], needs: object[]} | null}
 */
export function getCompletions(text, cursor, ctx = {}, { explicit = false, limit = 120 } = {}) {
  const env = makeEnv(String(text ?? ''), ctx);
  const src = env.text;
  if (cursor < 0 || cursor > src.length) return null;
  const range = rangeAt(env.info, cursor);
  const finish = (res, context) => {
    if (!res) return null;
    const items = rank(res.items, res.prefix, limit);
    return { from: res.from, to: res.to, prefix: res.prefix, context, items, needs: [...env.needs.values()] };
  };

  if (range) {
    if (range.type !== STRING) return null;
    const sc = stringContext(env, range);
    if (!sc) return null;
    return finish(stringCompletion(env, range, cursor, sc), sc.kind);
  }

  let from = cursor;
  while (from > 0 && ID_CHAR.test(src[from - 1])) from -= 1;
  const prefix = src.slice(from, cursor);
  if (/^\d/.test(prefix)) return null;
  let to = cursor;
  while (to < src.length && ID_CHAR.test(src[to])) to += 1;

  let dot = from;
  while (dot > 0 && (src[dot - 1] === ' ' || src[dot - 1] === '\t')) dot -= 1;
  if (src[dot - 1] === '.' && src[dot - 2] !== '.') {
    const chain = chainBefore(env, dot - 1);
    if (!chain) return null;
    const type = resolveChain(env, chain, chain.start);
    if (!type) return null;
    return finish({ from, to, prefix, items: membersOf(env, type) }, 'member');
  }

  const before = src.slice(Math.max(0, from - 12), from);
  if (/(?:^|[^\w$.])new\s+$/.test(before)) {
    const items = apiNames(env.side)
      .map((name) => getApi(name, env.side))
      .filter((api) => api.kind === 'class' && api.instantiate && /^new\s/.test(api.instantiate) && !PSEUDO.has(api.name))
      .map((api) => ({ label: api.name, kind: 'class', detail: 'class', doc: api.summary || '', sig: api.instantiate, params: /\(\s*[^)\s]/.test(api.instantiate), tableArg: TABLE_ARG_CLASSES.has(api.name) || api.name === 'GlideAjax' }));
    if (env.side === 'server') {
      if (prefix) need(env, { type: 'scriptIncludes', prefix });
      items.push(...listItems(ctx.scriptIncludes, 'scriptInclude', (s) => ({ label: s.name, detail: 'Script Include', doc: s.description || '', params: true })));
    }
    return finish({ from, to, prefix, items }, 'new');
  }

  if (!explicit) return null;
  const items = [];
  localNames(env).forEach((kind, name) => {
    if (name !== prefix) items.push({ label: name, kind, detail: 'local', doc: '' });
  });
  apiNames(env.side).forEach((name) => {
    if (PSEUDO.has(name)) return;
    const api = getApi(name, env.side);
    items.push({ label: name, kind: api.kind === 'class' ? 'class' : 'global', detail: api.kind, doc: api.summary || '' });
  });
  if (env.side === 'client') {
    const globals = getApi('globals', 'client');
    (globals?.methods || []).forEach((m) => items.push({ label: m.name, kind: 'function', detail: m.returns || '', doc: m.summary || '', sig: m.sig, params: hasParams(m.sig) }));
  }
  KEYWORDS.forEach((k) => items.push({ label: k, kind: 'keyword', detail: '', doc: '' }));
  items.push(...snippetItems(env, from));
  return finish({ from, to, prefix, items }, 'identifier');
}

/**
 * The edit for accepting `item` from `result`: {from, to, insert, caret, retrigger}.
 * Methods get "()" (caret inside when they take parameters) unless a "(" already follows.
 */
export function applyCompletion(text, result, item) {
  const src = String(text ?? '');
  const next = src[result.to];
  let insert = item.insert ?? item.label;
  let caret = insert.length;
  let retrigger = false;
  if (item.kind === 'snippet') {
    caret = item.caret ?? insert.length;
  } else if (item.kind === 'method' || item.kind === 'function') {
    if (next !== '(' && result.context !== 'ajaxMethods') {
      insert = `${item.label}()`;
      caret = item.params ? item.label.length + 1 : insert.length;
      retrigger = Boolean(item.params);
    }
  } else if (result.context === 'new' && next !== '(') {
    if (item.tableArg) {
      insert = `${item.label}('')`;
      caret = item.label.length + 2;
      retrigger = true;
    } else {
      insert = `${item.label}()`;
      caret = item.params ? item.label.length + 1 : insert.length;
    }
  }
  return { from: result.from, to: result.to, insert, caret: result.from + caret, retrigger };
}

function methodDoc(owner, m, from, to) {
  const flags = [];
  if (m.deprecated) flags.push(`Deprecated: ${m.deprecated}`);
  if (m.scopedOnly) flags.push('Scoped applications only');
  if (m.globalOnly) flags.push('Global scope only');
  if (m.static) flags.push('Static');
  if (m.unsupportedIn?.length) flags.push(`Not supported in: ${m.unsupportedIn.join(', ')}`);
  return {
    from,
    to,
    kind: 'method',
    title: `${owner.name}.${m.name}`,
    signature: m.sig || `${m.name}()`,
    returns: m.returns || '',
    summary: m.summary || '',
    notes: m.notes || '',
    side: owner.side,
    flags,
  };
}

function fieldDoc(env, table, name, from, to) {
  const fields = fieldsOf(env, table);
  const f = fields && fields.find((x) => x.name === name);
  if (!f) return table && fields ? { from, to, kind: 'field', title: `${table}.${name}`, summary: `No field "${name}" in the ${table} dictionary.`, flags: [] } : null;
  return {
    from,
    to,
    kind: 'field',
    title: `${table}.${name}`,
    summary: f.label || '',
    signature: [f.type, f.reference ? `reference to ${f.reference}` : ''].filter(Boolean).join(', '),
    flags: [],
  };
}

function wordAt(text, index) {
  let s = index;
  let e = index;
  while (s > 0 && ID_CHAR.test(text[s - 1])) s -= 1;
  while (e < text.length && ID_CHAR.test(text[e])) e += 1;
  return s === e ? null : { s, e, word: text.slice(s, e) };
}

/** Resolves what the code at `index` refers to (shared by hover and go to definition). */
function symbolAt(env, index) {
  const { text } = env;
  const range = rangeAt(env.info, index);
  if (range) {
    if (range.type !== STRING || index <= range.start) return null;
    const sc = stringContext(env, range);
    if (!sc) return null;
    const contentEnd = range.closed ? range.end - 1 : range.end;
    let value = text.slice(range.start + 1, contentEnd);
    let from = range.start + 1;
    let to = contentEnd;
    if (sc.kind === 'fields' || (sc.kind === 'roles' && sc.list)) {
      const w = wordAt(text, index);
      if (!w || w.s < from || w.e > to) return null;
      value = w.word;
      from = w.s;
      to = w.e;
      if (sc.kind === 'fields') {
        let table = sc.table;
        if (sc.dotWalk) {
          const before = text.slice(range.start + 1, w.s);
          const segment = sc.encoded ? before.slice(before.lastIndexOf('^') + 1).replace(/^(?:ORDERBYDESC|ORDERBY|GROUPBY|NQ|OR)/, '') : before;
          const path = segment.split('.').slice(0, -1);
          for (const step of path) table = table ? referenceOf(env, table, step) : null;
        }
        return { kind: 'field', table, name: value, from, to, form: sc.form };
      }
    }
    if (!/^[\w.]+$/.test(value)) return null;
    if (sc.kind === 'ajaxMethods') return { kind: 'siMethod', si: sc.si, name: value, from, to };
    return { kind: sc.kind, name: value, from, to };
  }
  const w = wordAt(text, index);
  if (!w || /^\d/.test(w.word)) return null;
  let dot = w.s;
  while (dot > 0 && /[ \t]/.test(text[dot - 1])) dot -= 1;
  if (text[dot - 1] === '.' && text[dot - 2] !== '.') {
    const chain = chainBefore(env, dot - 1);
    const type = chain && resolveChain(env, chain, chain.start);
    if (!type) return null;
    return { kind: 'member', type, name: w.word, from: w.s, to: w.e };
  }
  if (/(?:^|[^\w$.])new\s+$/.test(env.m.slice(Math.max(0, w.s - 12), w.s))) return { kind: 'ctor', name: w.word, from: w.s, to: w.e };
  return { kind: 'identifier', name: w.word, from: w.s, to: w.e };
}

/**
 * Hover documentation for the symbol at `index`.
 * @returns {{from, to, kind, title, signature?, returns?, summary?, notes?, flags: string[]} | null}
 */
export function getHoverInfo(text, index, ctx = {}) {
  return hoverFor(makeEnv(String(text ?? ''), ctx), index);
}

function hoverFor(env, index) {
  const { ctx } = env;
  const sym = symbolAt(env, index);
  if (!sym) return null;
  const { from, to } = sym;
  const base = { from, to, flags: [] };
  switch (sym.kind) {
    case 'field':
      if (sym.form && ctx.formFields) {
        const v = ctx.formFields.find((f) => f.name === sym.name);
        return v ? { ...base, kind: 'field', title: `Variable ${v.name}`, summary: v.label || '' } : null;
      }
      return sym.table ? fieldDoc(env, sym.table, sym.name, from, to) : null;
    case 'tables': {
      const t = (ctx.tables || []).find((x) => x.name === sym.name);
      return { ...base, kind: 'table', title: `Table ${sym.name}`, summary: t?.label || '', notes: 'F12 opens the table definition.' };
    }
    case 'scriptIncludes': {
      const s = (ctx.scriptIncludes || []).find((x) => x.name === sym.name);
      return { ...base, kind: 'scriptInclude', title: `Script Include ${sym.name}`, summary: s?.description || '', notes: 'F12 opens the Script Include.' };
    }
    case 'properties': {
      const p = (ctx.properties || []).find((x) => x.name === sym.name);
      return { ...base, kind: 'propertyName', title: `System property ${sym.name}`, summary: p?.description || '', signature: p?.type || '' };
    }
    case 'roles': {
      const r = (ctx.roles || []).find((x) => x.name === sym.name);
      return { ...base, kind: 'role', title: `Role ${sym.name}`, summary: r?.description || '' };
    }
    case 'siMethod': {
      const m = siInfo(env, sym.si)?.methods?.find((x) => x.name === sym.name);
      return m ? { ...base, kind: 'method', title: `${sym.si}.${m.name}`, signature: `${m.name}(${m.params.join(', ')})`, summary: m.doc || '' } : null;
    }
    case 'member': {
      const { type, name } = sym;
      if (type.si || type.self) {
        const list = type.si ? siInfo(env, type.si)?.methods : parseScriptIncludeMethods(env.text).methods;
        const m = (list || []).find((x) => x.name === name);
        if (m) return { ...base, kind: 'method', title: `${type.si || 'this'}.${m.name}`, signature: `${m.name}(${m.params.join(', ')})`, summary: m.doc || '' };
        if (type.self) {
          const hit = findMethod(getApi('AbstractAjaxProcessor', 'server'), name, 'server');
          if (hit) return methodDoc(hit.owner, hit.method, from, to);
        }
        return null;
      }
      const apiName = type.api || (type.element ? 'GlideElement' : null);
      const api = apiName && getApi(apiName, type.element ? 'server' : env.side);
      if (api) {
        const hit = findMethod(api, name, api.side);
        if (hit) return methodDoc(hit.owner, hit.method, from, to);
        const prop = api.properties.find((p) => p.name === name);
        if (prop) return { ...base, kind: 'property', title: `${api.name}.${prop.name}`, signature: prop.type || '', summary: prop.summary || '' };
      }
      if (type.api && RECORD_CLASSES.has(type.api) && type.table) return fieldDoc(env, type.table, name, from, to);
      if (type.element) {
        const ref = type.table ? referenceOf(env, type.table, type.field) : null;
        if (ref) return fieldDoc(env, ref, name, from, to);
      }
      return null;
    }
    case 'ctor': {
      const api = getApi(sym.name, env.side);
      if (api) return { ...base, kind: 'class', title: api.name, signature: api.instantiate || '', summary: api.summary || '' };
      if (env.side === 'server' && !JS_BUILTINS.has(sym.name)) {
        const s = (ctx.scriptIncludes || []).find((x) => x.name === sym.name);
        return { ...base, kind: 'scriptInclude', title: `Script Include ${sym.name}`, summary: s?.description || '', notes: 'F12 opens the Script Include.' };
      }
      return null;
    }
    default: {
      const type = resolveIdentifier(env, sym.name, to, 0);
      if (type && env.assigns.has(sym.name)) return { ...base, kind: 'variable', title: `${sym.name}: ${typeLabel(type)}`, summary: '' };
      if (type && type.alias) return { ...base, kind: 'global', title: `${sym.name}: ${typeLabel(type)}`, summary: 'The record the script runs against.' };
      const api = !PSEUDO.has(sym.name) && getApi(sym.name, env.side);
      if (api) return { ...base, kind: api.kind, title: api.name, signature: api.instantiate || '', summary: api.summary || '' };
      if (env.side === 'client') {
        const g = getApi('globals', 'client');
        const m = g && g.methodMap.get(sym.name);
        if (m) return methodDoc({ name: 'window', side: 'client' }, m, from, to);
      }
      return null;
    }
  }
}

/**
 * Parameter hints for the call around `cursor`.
 * @returns {{title: string, label: string, params: {text, start, end}[], active: number, summary: string, overload: number, overloads: number} | null}
 */
export function getSignatureHelp(text, cursor, ctx = {}) {
  const env = makeEnv(String(text ?? ''), ctx);
  const range = rangeAt(env.info, cursor);
  if (range && range.type === COMMENT) return null;
  const at = range ? range.start : cursor;
  const call = enclosingCall(env.m, at);
  if (!call) return null;
  const callee = calleeAt(env, call.open);
  if (!callee) return null;
  let sig = '';
  let title = '';
  let summary = '';
  if (callee.ctor) {
    const api = getApi(callee.ctor, env.side);
    if (api?.instantiate && /^new\s/.test(api.instantiate)) {
      sig = api.instantiate.replace(/^new\s+/, '');
      title = api.name;
      summary = api.summary || '';
    } else if (env.side === 'server' && !api && !JS_BUILTINS.has(callee.ctor)) {
      const si = siInfo(env, callee.ctor);
      if (!si || !si.initParams) return null;
      sig = `${callee.ctor}(${si.initParams.join(', ')})`;
      title = `new ${callee.ctor}`;
    } else return null;
  } else if (callee.fn) {
    if (env.side !== 'client') return null;
    const m = getApi('globals', 'client')?.methodMap.get(callee.fn);
    if (!m) return null;
    sig = m.sig;
    title = m.name;
    summary = m.summary || '';
  } else if (callee.type) {
    const { type, method } = callee;
    if (type.si || type.self) {
      const list = type.si ? siInfo(env, type.si)?.methods : parseScriptIncludeMethods(env.text).methods;
      const m = (list || []).find((x) => x.name === method);
      if (m) {
        sig = `${m.name}(${m.params.join(', ')})`;
        title = `${type.si || 'this'}.${m.name}`;
        summary = m.doc || '';
      } else if (type.self) {
        const hit = findMethod(getApi('AbstractAjaxProcessor', 'server'), method, 'server');
        if (!hit) return null;
        sig = hit.method.sig;
        title = `${hit.owner.name}.${method}`;
        summary = hit.method.summary || '';
      } else return null;
    } else {
      const api = getApi(type.api || (type.element ? 'GlideElement' : ''), type.element ? 'server' : env.side);
      const hit = api && findMethod(api, method, api.side);
      if (!hit) return null;
      sig = hit.method.sig || `${method}()`;
      title = `${hit.owner.name}.${method}`;
      summary = hit.method.summary || '';
      if (hit.method.returns) summary = summary ? `${summary} Returns ${hit.method.returns}.` : `Returns ${hit.method.returns}.`;
    }
  } else return null;
  const overloads = parseSignature(sig);
  if (!overloads.length) return null;
  let index = overloads.findIndex((o) => o.params.length > call.argIndex);
  if (index === -1) index = overloads.length - 1;
  const chosen = overloads[index];
  return {
    title,
    label: chosen.label,
    params: chosen.params,
    active: call.argIndex,
    summary,
    overload: index,
    overloads: overloads.length,
  };
}

/**
 * What "go to definition" should open for the symbol at `index`:
 * {type: 'local', index} | {type: 'scriptInclude', name} | {type: 'table', name} |
 * {type: 'field', table, name} | {type: 'property', name} | {type: 'api', hover} | null
 */
export function getDefinitionTarget(text, index, ctx = {}) {
  return definitionFor(makeEnv(String(text ?? ''), ctx), index);
}

function definitionFor(env, index) {
  const { ctx } = env;
  const sym = symbolAt(env, index);
  if (!sym) return null;
  const apiHover = () => {
    const hover = hoverFor(env, index);
    return hover ? { type: 'api', hover } : null;
  };
  switch (sym.kind) {
    case 'field':
      // Catalog variables are not dictionary columns.
      return sym.table && !(sym.form && ctx.formFields) ? { type: 'field', table: sym.table, name: sym.name } : null;
    case 'tables':
      return { type: 'table', name: sym.name };
    case 'scriptIncludes':
      return { type: 'scriptInclude', name: sym.name };
    case 'siMethod':
      return { type: 'scriptInclude', name: sym.si };
    case 'properties':
      return { type: 'property', name: sym.name };
    case 'roles':
      return { type: 'role', name: sym.name };
    case 'member': {
      const { type, name } = sym;
      if (type.si) return { type: 'scriptInclude', name: type.si };
      if (type.self) {
        const re = new RegExp(`(?:^|[,{\\s])${name.replace(/\$/g, '\\$')}\\s*:\\s*function\\b`);
        const hit = re.exec(env.m);
        return hit ? { type: 'local', index: hit.index + hit[0].search(/[A-Za-z_$]/) } : apiHover();
      }
      const api = getApi(type.api || (type.element ? 'GlideElement' : ''), type.element ? 'server' : env.side);
      if (api && (findMethod(api, name, api.side) || api.propertySet.has(name))) return apiHover();
      if (type.api && RECORD_CLASSES.has(type.api) && type.table) return { type: 'field', table: type.table, name };
      if (type.element) {
        const ref = type.table ? referenceOf(env, type.table, type.field) : null;
        if (ref) return { type: 'field', table: ref, name };
      }
      return null;
    }
    case 'ctor':
      if (getApi(sym.name, env.side)) return apiHover();
      return JS_BUILTINS.has(sym.name) ? null : { type: 'scriptInclude', name: sym.name };
    default: {
      const name = sym.name.replace(/\$/g, '\\$');
      const local = new RegExp(`(?:\\bfunction\\s+${name}\\b|\\b(?:var|let|const)\\s+${name}\\b|(?:^|[,{\\s])${name}\\s*:\\s*function\\b)`).exec(env.m);
      if (local) {
        const at = local.index + local[0].search(new RegExp(`(?<![\\w$])${name}(?![\\w$])`));
        if (at < sym.from || at >= sym.to) return { type: 'local', index: at };
      }
      if (KEYWORDS.has(sym.name)) return null;
      if (getApi(sym.name, env.side) && !PSEUDO.has(sym.name)) return apiHover();
      if ((sym.name === 'current' || sym.name === 'previous') && env.side === 'server') return ctx.table ? { type: 'table', name: ctx.table } : null;
      return /^[A-Za-z_$][\w$]*$/.test(sym.name) && !JS_BUILTINS.has(sym.name) ? { type: 'name', name: sym.name } : null;
    }
  }
}

/** Data a hover or go to definition at `index` is waiting for (same shape as getCompletions().needs). */
export function collectNeeds(text, index, ctx = {}) {
  const env = makeEnv(String(text ?? ''), ctx);
  hoverFor(env, index);
  definitionFor(env, index);
  return [...env.needs.values()];
}

/** Client when the script uses browser-side APIs, else server. */
export function guessSide(text) {
  return /\b(?:g_form|g_user|g_list|GlideAjax|g_modal|g_navigation)\b/.test(String(text || '')) ? 'client' : 'server';
}

export { typeLabel as describeType };
