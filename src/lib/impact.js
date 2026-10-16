// Change impact, the pure half: what a script reads and writes, which Script Include methods it
// calls, and the risk summary, markdown and AI prompt built from a finished report. The instance
// queries are in src/content/impact.js; the panel is src/sidebar/ImpactPanel.jsx.
//
// Everything here reads script text, so references built at runtime (a table name held in a
// variable, gr[fieldName], an event name passed in) are reported as untraced rather than guessed.

export const TABLE_RE = /^[a-z0-9_]{1,80}$/i;
export const SYS_ID_RE = /^[0-9a-f]{32}$/i;
export const EVENT_RE = /^[\w.-]{1,100}$/;
export const CLASS_RE = /^[A-Za-z_$][\w$]{0,79}$/;

export const SEVERITY_ORDER = ['high', 'medium', 'low'];

// ---- Script text helpers -------------------------------------------------------------------

/** Comments blanked to spaces (newlines kept), so offsets and line numbers still match the source. */
export function stripComments(source) {
  const text = String(source || '');
  let out = '';
  let quote = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (ch === '\\' && i + 1 < text.length) {
        out += ch + next;
        i += 2;
        continue;
      }
      // An unterminated ' or " string ends at the line break instead of swallowing the script.
      if (ch === quote || (ch === '\n' && quote !== '`')) quote = null;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i += 1) out += text[i] === '\n' ? '\n' : ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** 1-based line of an offset. */
function lineOf(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Index of the bracket closing the one at `open` ( "(" or "{" ), skipping strings; -1 when unbalanced. */
function matchBracket(text, open) {
  const pair = { '(': ')', '{': '}', '[': ']' };
  const stack = [pair[text[open]]];
  let quote = null;
  for (let i = open + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote || (ch === '\n' && quote !== '`')) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (pair[ch]) stack.push(pair[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

const literal = (arg) => {
  const m = /^\s*(['"])([\w.$-]+)\1\s*$/.exec(arg || '');
  return m ? m[2] : null;
};

// ---- What a script reads and writes --------------------------------------------------------

const OP_METHODS = {
  insert: 'insert',
  insertWithReferences: 'insert',
  update: 'update',
  updateMultiple: 'update',
  updateWithReferences: 'update',
  deleteRecord: 'delete',
  deleteMultiple: 'delete',
  query: 'read',
  _query: 'read',
  get: 'read',
};
const FIELD_WRITERS = new Set(['setValue', 'setDisplayValue']);
const ELEMENT_WRITERS = new Set(['setValue', 'setDisplayValue', 'setJournalEntry', 'setDateNumericValue']);
const GLIDE_QUERY_OPS = {
  insert: 'insert',
  insertOrUpdate: 'update',
  update: 'update',
  updateMultiple: 'update',
  deleteMultiple: 'delete',
  select: 'read',
  selectOne: 'read',
  get: 'read',
  getBy: 'read',
  count: 'read',
};
const OP_ORDER = ['read', 'insert', 'update', 'delete'];
const WRITE_OPS = new Set(['insert', 'update', 'delete']);

const GLIDE_ASSIGN = /\b([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:global\s*\.\s*)?(GlideRecordSecure|GlideRecord|GlideAggregate)\s*\(/g;
const GLIDE_QUERY = /\bnew\s+(?:global\s*\.\s*)?GlideQuery\s*\(/g;
const MEMBER = /\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g;
const EVENT_CALL = /\bgs\s*\.\s*(eventQueue|eventQueueScheduled)\s*\(/g;

function emptyAnalysis() {
  return { tables: [], events: [], dynamicTables: [], dynamicEvents: [], currentUpdate: [] };
}

/**
 * What one script reads and writes. `ownTable` is the table `current` belongs to (a business
 * rule's table, a UI action's table); without it `current` is not traced.
 */
export function analyzeScript(source, { ownTable = null, field = 'script', lineOffset = 0 } = {}) {
  const text = stripComments(source);
  const starts = lineStarts(text);
  const where = (pos) => ({ field, line: lineOf(starts, pos) + lineOffset });

  const tables = new Map();
  const touch = (table, isCurrent = false) => {
    const key = `${table}|${isCurrent}`;
    if (!tables.has(key)) tables.set(key, { table, isCurrent, ops: new Set(), fields: new Set(), where: [], workflowOff: false });
    return tables.get(key);
  };
  const result = emptyAnalysis();

  // Variables holding a GlideRecord, in source order, so a reassigned variable maps to the right table.
  const assigns = [];
  for (const m of text.matchAll(GLIDE_ASSIGN)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open);
    const table = literal(close > 0 ? text.slice(open + 1, close) : '');
    if (table && TABLE_RE.test(table)) {
      assigns.push({ name: m[1], table, pos: m.index, aggregate: m[2] === 'GlideAggregate' });
    } else {
      assigns.push({ name: m[1], table: null, pos: m.index });
      result.dynamicTables.push(where(m.index));
    }
  }
  const tableFor = (name, pos) => {
    if (name === 'current' && ownTable) return { table: ownTable, isCurrent: true };
    let found = null;
    for (const a of assigns) if (a.name === name && a.pos < pos) found = a;
    return found && found.table ? { table: found.table, isCurrent: false } : null;
  };

  for (const m of text.matchAll(MEMBER)) {
    const target = tableFor(m[1], m.index);
    if (!target) continue;
    const member = m[2];
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 160);
    const entry = () => touch(target.table, target.isCurrent);

    if (/^\s*\(/.test(after)) {
      // A method call on the record.
      if (member === 'setWorkflow' && /^\s*\(\s*false\s*\)/.test(after)) {
        const e = entry();
        e.workflowOff = true;
        e.where.push(where(m.index));
      } else if (OP_METHODS[member]) {
        const op = OP_METHODS[member];
        if (target.isCurrent && op === 'update') result.currentUpdate.push(where(m.index));
        if (target.isCurrent && op === 'read') continue;
        const e = entry();
        e.ops.add(op);
        e.where.push(where(m.index));
      } else if (FIELD_WRITERS.has(member)) {
        const name = literal((/^\s*\(\s*([^,)]*)/.exec(after) || [])[1]);
        if (name) {
          const e = entry();
          e.fields.add(name);
          e.where.push(where(m.index));
        }
      }
      continue;
    }

    // gr.field.setValue(...) / gr.work_notes.setJournalEntry(...)
    const elementCall = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(after);
    if (elementCall) {
      if (ELEMENT_WRITERS.has(elementCall[1])) {
        const e = entry();
        e.fields.add(member);
        e.where.push(where(m.index));
      }
      continue;
    }

    // gr.field = value (not ==, ===, =>)
    if (/^\s*=(?![=>])/.test(after) && !OP_METHODS[member]) {
      const e = entry();
      e.fields.add(member);
      e.where.push(where(m.index));
    }
  }

  // GlideQuery chains: new GlideQuery('table').where(...).update({...})
  for (const m of text.matchAll(GLIDE_QUERY)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close < 0) continue;
    const table = literal(text.slice(open + 1, close));
    if (!table || !TABLE_RE.test(table)) {
      result.dynamicTables.push(where(m.index));
      continue;
    }
    const e = touch(table);
    // Walk the chain: .name( ... ) repeated until something else follows.
    let pos = close + 1;
    for (let guard = 0; guard < 40; guard += 1) {
      const step = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(text.slice(pos, pos + 200));
      if (!step) break;
      const argOpen = pos + step[0].length - 1;
      const argClose = matchBracket(text, argOpen);
      if (argClose < 0) break;
      const op = GLIDE_QUERY_OPS[step[1]];
      if (step[1] === 'disableWorkflow') e.workflowOff = true;
      if (op) {
        e.ops.add(op);
        e.where.push(where(pos));
        if (op === 'insert' || op === 'update') {
          const args = text.slice(argOpen + 1, argClose);
          for (const key of args.matchAll(/(?:^|[{,])\s*['"]?([a-z_][\w]*)['"]?\s*:/gi)) e.fields.add(key[1]);
        }
      }
      pos = argClose + 1;
    }
  }

  for (const m of text.matchAll(EVENT_CALL)) {
    const open = m.index + m[0].length - 1;
    const first = (/^\(\s*([^,)]*)/.exec(text.slice(open, open + 200)) || [])[1];
    const name = literal(first);
    if (name && EVENT_RE.test(name)) result.events.push({ name, where: [where(m.index)] });
    else result.dynamicEvents.push(where(m.index));
  }

  result.tables = [...tables.values()]
    .filter((t) => t.ops.size || t.fields.size || t.workflowOff)
    .map((t) => ({
      table: t.table,
      isCurrent: t.isCurrent,
      ops: OP_ORDER.filter((op) => t.ops.has(op)),
      fields: [...t.fields].sort(),
      where: t.where,
      workflowOff: t.workflowOff,
    }));
  return result;
}

/** analyzeScript() over several script fields of one record, merged per table and event. */
export function analyzeScripts(parts, { ownTable = null } = {}) {
  const merged = emptyAnalysis();
  const tables = new Map();
  const events = new Map();
  for (const part of parts) {
    if (!part?.text) continue;
    const one = analyzeScript(part.text, { ownTable, field: part.field, lineOffset: part.lineOffset || 0 });
    one.tables.forEach((t) => {
      const key = `${t.table}|${t.isCurrent}`;
      const prev = tables.get(key);
      if (!prev) {
        tables.set(key, { ...t, ops: [...t.ops], fields: [...t.fields], where: [...t.where] });
        return;
      }
      prev.ops = OP_ORDER.filter((op) => prev.ops.includes(op) || t.ops.includes(op));
      prev.fields = [...new Set([...prev.fields, ...t.fields])].sort();
      prev.where.push(...t.where);
      prev.workflowOff = prev.workflowOff || t.workflowOff;
    });
    one.events.forEach((ev) => {
      if (!events.has(ev.name)) events.set(ev.name, { name: ev.name, where: [] });
      events.get(ev.name).where.push(...ev.where);
    });
    merged.dynamicTables.push(...one.dynamicTables);
    merged.dynamicEvents.push(...one.dynamicEvents);
    merged.currentUpdate.push(...one.currentUpdate);
  }
  merged.tables = [...tables.values()].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.table.localeCompare(b.table));
  merged.events = [...events.values()].sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}

/** Operations that change data (insert/update/delete) in one analysed table entry. */
export const writeOps = (entry) => entry.ops.filter((op) => WRITE_OPS.has(op));

/** True when the entry changes data: a write operation, or fields set on `current` that the save itself stores. */
export const isWrite = (entry) => writeOps(entry).length > 0 || (entry.isCurrent && entry.fields.length > 0);

// ---- Script Include calls ------------------------------------------------------------------

const NOT_SCRIPT_INCLUDES = new Set([
  'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Math', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'Promise', 'Map', 'Set', 'WeakMap', 'Function', 'Class', 'Packages', 'Symbol', 'Intl',
  'RESTMessageV2', 'SOAPMessageV2', 'XMLDocument', 'XMLDocument2', 'GlideappCalculationHelper', 'SNC',
]);
const isScriptIncludeName = (name) => CLASS_RE.test(name) && !/^Glide/.test(name) && !NOT_SCRIPT_INCLUDES.has(name);

const SCOPE = '(?:(?:global|x_[a-z0-9_]+|sn_[a-z0-9_]+)\\s*\\.\\s*)?';
const NEW_CLASS = new RegExp(`\\bnew\\s+${SCOPE}([A-Z][\\w$]*)\\s*\\(`, 'g');
const CLASS_ASSIGN = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+${SCOPE}([A-Z][\\w$]*)\\s*\\(`, 'g');
const STATIC_CALL = new RegExp(`(?<![\\w$.])${SCOPE}([A-Z][\\w$]*)\\s*\\.\\s*([a-z_$][\\w$]*)\\s*\\(`, 'g');
const AJAX = /\bnew\s+GlideAjax\s*\(\s*(['"])([\w.$]+)\1/g;
const AJAX_METHOD = /\baddParam\s*\(\s*(['"])sysparm_name\1\s*,\s*(['"])([\w$]+)\2/g;

/**
 * Script Includes a script uses and the methods it calls on each: `new X().m()`, `var x = new X(); x.m()`,
 * `X.m()`, and client-side `new GlideAjax('X')` with `addParam('sysparm_name', 'm')`.
 * Names are candidates; the caller confirms them against sys_script_include.
 */
export function scriptIncludeCalls(source) {
  const text = stripComments(source);
  const found = new Map();
  const add = (name, method, via = 'server') => {
    if (!isScriptIncludeName(name)) return;
    if (!found.has(name)) found.set(name, { name, methods: new Set(), via });
    if (method && method !== 'initialize' && method !== 'type') found.get(name).methods.add(method);
  };

  for (const m of text.matchAll(NEW_CLASS)) {
    if (m[1] === 'GlideAjax') continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open);
    const chained = close > 0 ? /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(text.slice(close + 1, close + 120)) : null;
    add(m[1], chained ? chained[1] : null);
  }

  const assigns = [...text.matchAll(CLASS_ASSIGN)].map((m) => ({ name: m[1], cls: m[2], pos: m.index }));
  if (assigns.length) {
    for (const m of text.matchAll(MEMBER)) {
      let cls = null;
      for (const a of assigns) if (a.name === m[1] && a.pos < m.index) cls = a.cls;
      if (!cls || cls === 'GlideAjax') continue;
      if (/^\s*\(/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 20))) add(cls, m[2]);
    }
  }

  for (const m of text.matchAll(STATIC_CALL)) add(m[1], m[2]);

  const ajax = [...text.matchAll(AJAX)].map((m) => ({ name: m[2].split('.').pop(), pos: m.index }));
  ajax.forEach((a) => add(a.name, null, 'GlideAjax'));
  for (const m of text.matchAll(AJAX_METHOD)) {
    let owner = null;
    for (const a of ajax) if (a.pos < m.index) owner = a;
    if (owner) add(owner.name, m[3], 'GlideAjax');
  }

  return [...found.values()]
    .map((c) => ({ name: c.name, methods: [...c.methods].sort(), via: c.via }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Body of one method in a Script Include: `name: function () {...}`, `name() {...}` or
 * `X.prototype.name = function () {...}`. Returns { text, lineOffset } or null.
 */
export function extractMethodBody(source, method) {
  if (!CLASS_RE.test(method || '')) return null;
  const original = String(source || '');
  const text = stripComments(original);
  const name = method.replace(/\$/g, '\\$');
  const patterns = [
    new RegExp(`(?:^|[\\s,{])['"]?${name}['"]?\\s*:\\s*function\\b[^{]*\\{`),
    new RegExp(`\\.\\s*${name}\\s*=\\s*function\\b[^{]*\\{`),
    new RegExp(`(?:^|[\\s,{])${name}\\s*\\([^)]*\\)\\s*\\{`),
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (!m) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close < 0) return null;
    const starts = lineStarts(text);
    return { text: original.slice(open, close + 1), lineOffset: lineOf(starts, open) - 1 };
  }
  return null;
}

// ---- Describing the subject ----------------------------------------------------------------

const truthy = (v) => v === true || v === 'true';

/** One line on when the script runs, from its record. */
export function describeTrigger(table, row = {}) {
  const ops = ['insert', 'update', 'delete', 'query'].filter((op) => truthy(row[`action_${op}`]));
  switch (table) {
    case 'sys_script':
      return `Business rule: runs ${row.when || '?'} ${ops.length ? ops.join('/') : '(no operation ticked)'} on ${row.collection || '?'}${row.order ? `, order ${row.order}` : ''}${row.condition || row.filter_condition ? ', with a condition' : ''}`;
    case 'sys_script_include':
      return truthy(row.client_callable)
        ? 'Script Include, client callable: other scripts and the browser (GlideAjax) can call it'
        : 'Script Include: runs when another script calls it';
    case 'sys_script_client':
      return `Client script: runs ${row.type || '?'}${row.type === 'onChange' && row.field_name ? ` of ${row.field_name}` : ''} on ${row.table || '?'} forms`;
    case 'catalog_script_client':
      return `Catalog client script: runs ${row.type || '?'} on the catalog item form`;
    case 'sys_ui_action':
      return `UI action: runs when a user clicks it on ${row.table || '?'}${truthy(row.client) ? ' (browser side first)' : ''}`;
    case 'sys_ui_policy':
      return `UI policy script: runs in the browser on ${row.table || '?'} forms`;
    case 'sysevent_script_action':
      return `Script action: runs when the event ${row.event_name || '?'} is processed`;
    case 'sysauto_script':
      return `Scheduled job: runs on its schedule${row.run_type ? ` (${row.run_type})` : ''}`;
    case 'sys_ws_operation':
      return `Scripted REST resource: runs on ${row.http_method || '?'} ${row.operation_uri || ''}`.trim();
    case 'sys_security_acl':
      return `ACL script: runs on every ${row.operation || '?'} check of ${row.name || '?'}`;
    case 'sp_widget':
      return 'Portal widget: runs on every page that shows it';
    case 'sys_ui_script':
      return 'UI script: runs in the browser on pages that load it';
    case 'sys_transform_script':
      return `Transform script: runs ${row.when || ''} during imports through ${row['map.name'] || 'its transform map'}`.replace(/\s+/g, ' ');
    case 'sys_processor':
      return 'Processor: runs when its URL is requested';
    default:
      return '';
  }
}

// ---- Risk summary ---------------------------------------------------------------------------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Every table the subject changes, directly or through the Script Include methods it calls. */
export function allWrites(report) {
  const direct = (report.changes?.tables || []).filter(isWrite).map((t) => ({ ...t, via: null }));
  const indirect = (report.indirect || []).flatMap((c) =>
    (c.tables || []).filter(isWrite).map((t) => ({ ...t, via: `${c.name}${c.method ? `.${c.method}` : ''}` }))
  );
  return [...direct, ...indirect];
}

/** Ranked risk signals for a report: [{ severity, text }]. */
export function buildSignals(report) {
  const signals = [];
  const add = (severity, text) => signals.push({ severity, text });
  const subject = report.subject || {};

  const callers = report.usedBy?.items?.length || 0;
  if (callers) {
    const severity = callers >= 10 ? 'high' : callers >= 3 ? 'medium' : 'low';
    add(severity, `${report.usedBy.verb || 'Used by'} ${plural(callers, 'script')}${report.usedBy.capped ? ' (or more)' : ''}: each one may need retesting.`);
  }

  const writes = allWrites(report);
  writes
    .filter((w) => w.ops.includes('delete'))
    .forEach((w) => add('high', `Deletes records on ${w.table}${w.via ? ` (through ${w.via})` : ''}.`));
  writes
    .filter((w) => w.workflowOff)
    .forEach((w) => add('medium', `Turns off business rules and flows on ${w.table} with setWorkflow(false)${w.via ? ` (through ${w.via})` : ''}: logic that normally runs on those changes will not.`));

  if (subject.table === 'sys_script' && report.changes?.currentUpdate?.length) {
    add('high', `Calls current.update() in a business rule: the rules on ${subject.ownTable || 'this table'} run again for the same record (double updates, possible recursion).`);
  }

  const others = (report.updateSets?.items || []).filter((s) => !s.mine);
  others
    .filter((s) => s.state === 'in progress')
    .forEach((s) => add('high', `Also in update set "${s.setName}" (in progress), last changed by ${s.updatedBy || 'someone'}: changes can overwrite each other.`));
  others
    .filter((s) => s.state === 'complete')
    .forEach((s) => add('medium', `Also in completed update set "${s.setName}" by ${s.updatedBy || 'someone'}: whichever is committed last wins.`));

  const downstream = report.downstream?.items?.length || 0;
  if (downstream) {
    add(downstream >= 10 ? 'medium' : 'low', `Its changes set off ${plural(downstream, 'other rule, flow or notification', 'other rules, flows and notifications')}${report.downstream.capped ? ' (or more)' : ''}.`);
  }

  if (report.errors?.count) {
    add('medium', `${plural(report.errors.count, 'warning or error', 'warnings and errors')}${report.errors.capped ? ' (or more)' : ''} in the system log in the last 7 days mention this script.`);
  }

  if (report.volume?.count >= 1000) {
    add('medium', `Runs often: ${report.volume.count.toLocaleString('en-US')} ${report.volume.label}.`);
  }

  const dynamic = (report.changes?.dynamicTables?.length || 0) + (report.changes?.dynamicEvents?.length || 0);
  if (dynamic) add('low', `${plural(dynamic, 'table or event name is', 'table or event names are')} chosen at run time and not traced.`);

  if (subject.active === false) add('low', 'This script is inactive: a change has no effect until it is turned on.');

  return signals.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

/** Overall level: the worst signal, or 'low' when nothing stands out. */
export const overallLevel = (signals) => SEVERITY_ORDER.find((s) => signals.some((x) => x.severity === s)) || 'low';

/** Short one-line summary of the report, for the top of the panel. */
export function headline(report) {
  const parts = [];
  if (report.usedBy?.applicable) parts.push(`used in ${plural(report.usedBy.items.length, 'place')}`);
  const writeTables = [...new Set(allWrites(report).map((w) => w.table))];
  parts.push(writeTables.length ? `changes ${plural(writeTables.length, 'table')}` : 'changes no tables');
  if (report.downstream) {
    const n = report.downstream.items.length;
    parts.push(`${n} ${n === 1 ? 'thing runs' : 'things run'} as a result`);
  }
  if (report.errors) parts.push(`${plural(report.errors.count, 'log error')} this week`);
  const others = (report.updateSets?.items || []).filter((s) => !s.mine).length;
  if (others) parts.push(`in ${plural(others, 'other update set')}`);
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---- Markdown and AI prompt ----------------------------------------------------------------

/** "script lines 3, 7; condition line 1" for a list of { field, line }. */
export function describeWhere(where) {
  const byField = new Map();
  (where || []).forEach((w) => {
    if (!byField.has(w.field)) byField.set(w.field, new Set());
    byField.get(w.field).add(w.line);
  });
  return [...byField.entries()]
    .map(([field, set]) => `${field} line${set.size > 1 ? 's' : ''} ${[...set].sort((a, b) => a - b).slice(0, 8).join(', ')}${set.size > 8 ? '…' : ''}`)
    .join('; ');
}

/** "update (fields: state, close_code)" style text for one table entry. */
export function describeChange(entry) {
  const ops = entry.ops.length ? entry.ops.join(', ') : entry.isCurrent && entry.fields.length ? 'sets fields on the record being saved' : '';
  const fields = entry.fields.length ? `fields: ${entry.fields.slice(0, 12).join(', ')}${entry.fields.length > 12 ? '…' : ''}` : '';
  const flags = entry.workflowOff ? 'setWorkflow(false)' : '';
  return [ops, fields, flags].filter(Boolean).join(' · ');
}

/** The report as markdown, for export and for the AI prompt. */
export function impactToMarkdown(report) {
  const origin = report.origin || '';
  const link = (path) => (path ? `${origin}${path}` : '');
  const s = report.subject || {};
  const signals = buildSignals(report);
  const out = [];

  out.push(`# Change impact: ${s.kind || 'Script'} "${s.name || ''}"`);
  if (s.trigger) out.push('', s.trigger);
  if (s.link) out.push('', `Record: ${link(s.link)}`);
  if (s.usesUnsaved) out.push('', '_Analysed the script as it is on the form, including unsaved changes._');
  out.push('', `**Risk: ${overallLevel(signals).toUpperCase()}** · ${headline(report)}`);

  if (signals.length) {
    out.push('', '## Signals');
    signals.forEach((x) => out.push(`- [${x.severity}] ${x.text}`));
  }

  if (report.usedBy?.applicable) {
    out.push('', `## ${report.usedBy.label} (${report.usedBy.items.length}${report.usedBy.capped ? '+' : ''})`);
    if (!report.usedBy.items.length) out.push('- None found.');
    report.usedBy.items.forEach((u) => {
      const where = u.lines?.length ? ` (${describeWhere(u.lines.map((l) => ({ field: l.field, line: l.lineNumber })))})` : '';
      out.push(`- ${u.label}: ${u.name}${u.viaAjax ? ' (GlideAjax)' : ''}${where} ${link(u.link)}`.trimEnd());
    });
  }

  if (report.alongside) {
    out.push('', `## Runs alongside: other ${report.alongside.when || ''} rules on ${report.alongside.tables.join(', ')} (${report.alongside.items.filter((r) => !r.isSelf).length})`);
    report.alongside.items.forEach((r) => out.push(`- ${r.isSelf ? '**this rule** → ' : ''}${r.order ?? ''} ${r.name} (${r.table}; ${r.ops.join('/') || 'no operation'})`.replace(/\s+/g, ' ')));
  }

  const ch = report.changes || emptyAnalysis();
  out.push('', '## What it changes');
  if (!ch.tables.length && !ch.events.length) out.push('- No table reads or writes found in the script text.');
  ch.tables.forEach((t) => out.push(`- ${t.isCurrent ? `${t.table} (current record)` : t.table}: ${describeChange(t) || 'read'} — ${describeWhere(t.where)}`));
  ch.events.forEach((e) => out.push(`- Fires event ${e.name} — ${describeWhere(e.where)}`));
  if (ch.dynamicTables.length) out.push(`- Table chosen at run time (not traced) — ${describeWhere(ch.dynamicTables)}`);
  if (ch.dynamicEvents.length) out.push(`- Event name chosen at run time (not traced) — ${describeWhere(ch.dynamicEvents)}`);

  if (report.indirect?.length) {
    out.push('', '## Through the Script Includes it calls');
    report.indirect.forEach((c) => {
      const head = `${c.name}${c.method ? `.${c.method}()` : ''}`;
      if (c.method && !c.found) {
        out.push(`- ${head}: method not found in the Script Include (inherited or built at run time)`);
        return;
      }
      const parts = [
        ...(c.tables || []).map((t) => `${t.table}: ${describeChange(t) || 'read'}`),
        ...(c.events || []).map((e) => `fires ${e.name}`),
      ];
      out.push(`- ${head}: ${parts.length ? parts.join('; ') : 'no table reads or writes found'}`);
    });
  }

  if (report.downstream) {
    out.push('', `## What runs as a result (${report.downstream.items.length}${report.downstream.capped ? '+' : ''})`);
    if (!report.downstream.items.length) out.push('- Nothing found.');
    report.downstream.items.forEach((d) => out.push(`- ${d.kind}: ${d.name} (${d.detail})${d.maySkip ? ' — may be skipped: setWorkflow(false)' : ''} ${link(d.link)}`.trimEnd()));
  }

  if (report.updateSets) {
    out.push('', '## Update sets containing this record');
    if (!report.updateSets.items.length) out.push('- None open.');
    report.updateSets.items.forEach((u) => out.push(`- ${u.setName} (${u.state}) — last changed by ${u.updatedBy || '?'} on ${u.updatedOn || '?'}${u.mine ? ' (you)' : ''}`));
  }

  if (report.errors) {
    out.push('', `## System log, last 7 days (${report.errors.count}${report.errors.capped ? '+' : ''})`);
    report.errors.samples.forEach((e) => out.push(`- ${e.createdOn} [${e.level}] ${String(e.message || '').slice(0, 240).replace(/\s+/g, ' ')}`));
  }

  if (report.history) {
    out.push('', '## History');
    out.push(`- ${plural(report.history.count, 'saved version')}${report.history.latest[0] ? `; last by ${report.history.latest[0].by} on ${report.history.latest[0].recordedAt}` : ''}`);
  }

  if (report.volume) out.push('', `Volume: ${report.volume.count.toLocaleString('en-US')} ${report.volume.label}.`);

  if (report.notes?.length) {
    out.push('', '## Not checked');
    report.notes.forEach((n) => out.push(`- ${n}`));
  }
  out.push('', '_Found by reading script text: references built at run time are not traced._');
  return out.join('\n');
}

/** Prompt for "Ask AI": what could break and what to retest. */
export function buildImpactPrompt(report) {
  return [
    'I am about to change the ServiceNow script described in the impact report below.',
    'Using only this report (do not invent records that are not listed):',
    '1. What could break, most serious first, and why.',
    '2. What to retest: specific records, forms, flows or integrations, and the ATF tests worth adding.',
    '3. How to make the change safely (order of deployment, guards, what to tell the other update set owners).',
    'Say clearly where the report could be incomplete (run-time references, untraced tables).',
    '',
    impactToMarkdown(report),
  ].join('\n');
}
