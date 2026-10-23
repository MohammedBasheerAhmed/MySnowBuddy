// Client trace, the analysis half (no DOM, no chrome.*, unit tested in tests/clienttrace.test.js).
// The recorder (src/lib/clientTraceRecorder.js) writes plain events; this turns them into what a developer reads:
// rows to list, who did it, a story per field, the things that stand out, and Markdown for a ticket.
//
// Event shape (from the recorder):
//   { seq, id, rid, t, at, kind, name, field?, args?, result?, durationMs?, frame, stack: [{fn, line, col, url?}],
//     parent?, depth?, phase?, ref?, flags? }
//   t  = ms since that frame's navigation start, at = epoch ms, seq = order stored, id = identity (phase 'end' events
//   point back at their start with `ref`), kind = field | message | form | ajax | glide | modal | network | error |
//   console | longtask | page | log.
//
// What a real classic form looks like (confirmed live on a PDI, 2026-10-23): client scripts are INLINED in the page as
// functions named onLoad_<32 hex> / onChange_<name> (the hex is not the sys_id of any record); UI policies are embedded
// as ui_policy_add([{ actions, short_description, sys_id, ... }]) and applied by /scripts/ui_policy.jsx (frames such as
// klass._runAction); jslog() lines from the platform are numerous. Attribution uses all three, see attribute().

import { isSecretName, looksSecret, scrub } from './clientTraceRecorder.js';

export const SLOW_AJAX_MS = 500;
export const SLOW_NETWORK_MS = 1000;
export const LONG_TASK_MS = 200;
export const REPEAT_AT = 3;
export const GAP_MS = 300;
export const GAP_WINDOW_MS = 15000;
export const MAX_TABLE_ROWS = 200;

export const KINDS = {
  field: { label: 'Field' },
  message: { label: 'Message' },
  form: { label: 'Form' },
  ajax: { label: 'GlideAjax' },
  glide: { label: 'GlideRecord' },
  modal: { label: 'Dialog' },
  network: { label: 'Request' },
  error: { label: 'Error' },
  console: { label: 'Console' },
  longtask: { label: 'Busy' },
  page: { label: 'Page' },
  log: { label: 'Log' },
};

export const KIND_FILTERS = [
  { id: 'all', label: 'All kinds' },
  { id: 'field', label: 'Field changes', kinds: ['field'] },
  { id: 'message', label: 'Messages and form actions', kinds: ['message', 'form'] },
  { id: 'ajax', label: 'GlideAjax', kinds: ['ajax'] },
  { id: 'glide', label: 'GlideRecord', kinds: ['glide'] },
  { id: 'network', label: 'Requests', kinds: ['network'] },
  { id: 'problems', label: 'Errors and console', kinds: ['error', 'console', 'log'] },
  { id: 'other', label: 'Dialogs, busy time, page', kinds: ['modal', 'longtask', 'page'] },
];

/** The tables a stack frame can point at, and what to read from each (used by src/content/clientTrace.js). */
export const RESOLVE_TABLES = [
  { table: 'sys_script_client', kind: 'Client script', fields: ['name', 'table', 'type', 'field'] },
  { table: 'catalog_script_client', kind: 'Catalog client script', fields: ['name', 'type', 'cat_item'] },
  { table: 'sys_ui_policy', kind: 'UI policy', fields: ['short_description', 'table'], nameField: 'short_description' },
  { table: 'catalog_ui_policy', kind: 'Catalog UI policy', fields: ['short_description'], nameField: 'short_description' },
  { table: 'sys_ui_action', kind: 'UI action', fields: ['name', 'table', 'action_name'] },
  { table: 'sys_ui_script', kind: 'UI script', fields: ['name'] },
];

const SYS_ID_ANY = /[0-9a-f]{32}/gi;
const HANDLER = /(onLoad|onChange|onSubmit|onCellEdit)/;

export const fmtMs = (ms) => {
  if (!Number.isFinite(ms)) return '';
  if (ms < 10) return `${Math.round(ms * 10) / 10} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
};

const quote = (v) => (typeof v === 'string' ? `"${v.length > 70 ? `${v.slice(0, 69)}…` : v}"` : v === null || v === undefined ? 'null' : String(v));
const plain = (s) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();

// ---- trusting what arrives -------------------------------------------------------------------------------------------
// Events reach the panel from the recorder in the page and from other frames by postMessage. Both are things a page
// script could also send, so they are rebuilt from known fields with caps before anything reads them. They are data to
// display, never instructions.

const KIND_SET = new Set(Object.keys(KINDS));
const finite = (n) => (Number.isFinite(n) ? n : 0);

function safeValue(v, depth = 0) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 299)}…` : v;
  if (depth >= 3) return null;
  if (Array.isArray(v)) return v.slice(0, 12).map((x) => safeValue(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    Object.keys(v).slice(0, 16).forEach((k) => {
      out[k.slice(0, 60)] = safeValue(v[k], depth + 1);
    });
    return out;
  }
  return null;
}

/** The event rebuilt from known fields, or null when it is not one. */
export function sanitizeEvent(e) {
  if (!e || typeof e !== 'object' || !KIND_SET.has(e.kind) || typeof e.name !== 'string' || !Number.isFinite(e.seq)) return null;
  const out = { seq: e.seq, kind: e.kind, name: e.name.slice(0, 100), t: finite(e.t), at: finite(e.at), frame: String(e.frame || '').slice(0, 60) };
  if (Number.isFinite(e.id)) out.id = e.id;
  if (typeof e.field === 'string') out.field = e.field.slice(0, 80);
  if (Array.isArray(e.args)) out.args = e.args.slice(0, 8).map((a) => safeValue(a));
  if (e.result && typeof e.result === 'object') out.result = safeValue(e.result);
  if (Number.isFinite(e.durationMs)) out.durationMs = e.durationMs;
  if (Number.isFinite(e.depth)) out.depth = e.depth;
  if (Number.isFinite(e.parent)) out.parent = e.parent;
  if (e.phase === 'start' || e.phase === 'end') out.phase = e.phase;
  if (Number.isFinite(e.ref)) out.ref = e.ref;
  if (e.flags && typeof e.flags === 'object') {
    out.flags = {};
    Object.keys(e.flags).slice(0, 10).forEach((k) => {
      if (e.flags[k] === true) out.flags[k.slice(0, 30)] = true;
    });
  }
  out.stack = (Array.isArray(e.stack) ? e.stack : []).slice(0, 8).map((f) => {
    const frame = { fn: String((f && f.fn) || '').slice(0, 120), line: finite(f && f.line), col: finite(f && f.col) };
    if (f && typeof f.url === 'string') frame.url = f.url.slice(0, 160);
    return frame;
  });
  return out;
}

// ---- rows -----------------------------------------------------------------------------------------------------------

const byTime = (a, b) => (a.at || 0) - (b.at || 0) || String(a.rid).localeCompare(String(b.rid)) || (a.id || 0) - (b.id || 0) || (a.seq || 0) - (b.seq || 0);

/**
 * Events (any order, several frames) into one row per thing that happened. A call that finished later (phase 'end')
 * is folded into its start row, which then has a duration and a result; a start with no end yet is `pending`.
 */
export function buildRows(events) {
  const list = Array.isArray(events) ? events : [];
  const rows = [];
  const byKey = new Map();
  const ends = [];
  const seen = new Set();
  list.forEach((e) => {
    if (!e || typeof e !== 'object' || !KINDS[e.kind]) return;
    const rid = e.rid || '';
    const uniq = `${rid}#${e.seq}`;
    if (e.seq !== undefined) {
      if (seen.has(uniq)) return;
      seen.add(uniq);
    }
    if (e.phase === 'end' && e.ref !== undefined) {
      ends.push({ ...e, rid });
      return;
    }
    const row = { ...e, rid, key: `${rid}:${e.id ?? e.seq}`, stack: Array.isArray(e.stack) ? e.stack : [], pending: e.phase === 'start' };
    byKey.set(row.key, row);
    rows.push(row);
  });
  ends.forEach((end) => {
    const start = byKey.get(`${end.rid}:${end.ref}`);
    if (!start) {
      rows.push({ ...end, key: `${end.rid}:${end.id ?? end.seq}`, stack: [], orphan: true, pending: false });
      return;
    }
    start.pending = false;
    if (end.durationMs !== undefined) start.durationMs = end.durationMs;
    start.result = { ...(start.result || {}), ...(end.result || {}) };
    start.flags = { ...(start.flags || {}), ...(end.flags || {}) };
    start.endT = end.t;
  });
  return dropEchoedBusyTime(rows.sort(byTime));
}

/**
 * A frozen page freezes every same-origin frame, and each frame's observer reports it. Keep one row for it (the form
 * frame's, not the shell's) so the same stall is not listed, and counted, twice.
 */
function dropEchoedBusyTime(rows) {
  const kept = [];
  rows.forEach((row) => {
    if (row.kind !== 'longtask') {
      kept.push(row);
      return;
    }
    const twin = kept.find((k) => k.kind === 'longtask' && k.rid !== row.rid && Math.abs(k.at - row.at) < 40 && Math.abs((k.durationMs || 0) - (row.durationMs || 0)) <= Math.max(40, (k.durationMs || 0) * 0.25));
    if (!twin) kept.push(row);
    else if (twin.frame === 'top' && row.frame !== 'top') kept[kept.indexOf(twin)] = row;
  });
  return kept;
}

export const isError = (row) => row.kind === 'error' || Boolean(row.flags?.threw) || (row.kind === 'console' && row.name === 'console.error');
export const isFailed = (row) => Boolean(row.flags?.failed) || Boolean(row.flags?.threw) || (row.kind === 'network' && row.result && !row.result.status && !row.result.aborted && !row.pending);
export const isSlow = (row) => (row.durationMs ?? 0) >= SLOW_AJAX_MS;
export const isProblem = (row) => isError(row) || isFailed(row) || Boolean(row.flags?.unknownField);

/** The pages (one per frame load) present in the rows, oldest first. */
export function documentsOf(rows) {
  const docs = new Map();
  rows.forEach((row) => {
    let doc = docs.get(row.rid);
    if (!doc) {
      doc = { rid: row.rid, frame: row.frame || 'frame', startAt: row.at || 0, href: '', count: 0 };
      docs.set(row.rid, doc);
    }
    doc.count += 1;
    doc.startAt = Math.min(doc.startAt, row.at || doc.startAt);
    if (row.kind === 'page' && !doc.href && typeof row.args?.[0] === 'string') doc.href = row.args[0];
  });
  return [...docs.values()].sort((a, b) => a.startAt - b.startAt);
}

/** scope 'current': only the newest page load of each frame. 'all': every load since recording started. */
export function selectDocuments(rows, scope = 'current') {
  if (scope === 'all') return rows;
  const latest = new Map();
  documentsOf(rows).forEach((doc) => latest.set(doc.frame, doc.rid));
  const keep = new Set(latest.values());
  return rows.filter((row) => keep.has(row.rid));
}

export function fieldsOf(rows) {
  return [...new Set(rows.filter((r) => typeof r.field === 'string' && r.field).map((r) => r.field))].sort();
}

export function framesOf(rows) {
  return [...new Set(rows.map((r) => r.frame).filter(Boolean))].sort();
}

/** A jslog() line. The platform writes hundreds of them ("added render event for ..."), so the panel hides them by default. */
export const isJslog = (row) => row.kind === 'log';

export function filterRows(rows, { field = '', kind = 'all', errorsOnly = false, slowOnly = false, frame = '', hideJslog = false } = {}) {
  const group = KIND_FILTERS.find((k) => k.id === kind);
  return rows.filter((row) => {
    if (hideJslog && isJslog(row)) return false;
    if (field && row.field !== field) return false;
    if (frame && row.frame !== frame) return false;
    if (group?.kinds && !group.kinds.includes(row.kind)) return false;
    if (errorsOnly && !isProblem(row)) return false;
    if (slowOnly && !isSlow(row)) return false;
    return true;
  });
}

// ---- describing a row -----------------------------------------------------------------------------------------------

function callText(name, args) {
  return `${name}(${args.map(quote).join(', ')})`;
}

/** { title, detail } for the timeline: what happened, in the developer's own words. */
export function describeRow(row) {
  const a = Array.isArray(row.args) ? row.args : [];
  switch (row.kind) {
    case 'field':
      return { title: callText(row.name, [row.field, ...a]), detail: row.flags?.unknownField ? 'The field is not on this form, so ServiceNow ignores the call.' : '' };
    case 'message':
    case 'form':
    case 'modal':
    case 'log':
      return { title: callText(row.name, a), detail: '' };
    case 'ajax': {
      const params = a[2] && typeof a[2] === 'object' ? Object.entries(a[2]).map(([k, v]) => `${k}=${plain(v)}`).join(', ') : '';
      const api = row.name.replace('GlideAjax.', '');
      return {
        title: `${a[0] || 'GlideAjax'}${a[1] ? `.${a[1]}` : ''}`,
        detail: [api, row.flags?.blocking ? 'synchronous: freezes the browser until the server answers' : '', params ? `params: ${params}` : '', row.result?.answer !== undefined ? `answer: ${quote(row.result.answer)}` : ''].filter(Boolean).join(' · '),
      };
    }
    case 'glide':
      return {
        title: `GlideRecord ${a[0] || ''} ${row.name.replace('GlideRecord.', '')}`.replace(/\s+/g, ' ').trim(),
        detail: [a[1] ? plain(a[1]) : '', row.flags?.blocking ? 'synchronous: freezes the browser until the server answers' : ''].filter(Boolean).join(' · '),
      };
    case 'network':
      return { title: row.name, detail: [a[0] ? `?${plain(a[0])}` : '', row.result ? (row.result.status ? `status ${row.result.status}` : row.result.aborted ? 'cancelled by the page' : 'no response') : '', row.result?.error ? plain(row.result.error) : ''].filter(Boolean).join(' · ') };
    case 'error':
      return { title: `${row.name}: ${plain(a[0])}`, detail: '' };
    case 'console':
      return { title: `${row.name}: ${a.map(plain).join(' ')}`, detail: '' };
    case 'longtask':
      return { title: 'The page was busy and could not respond', detail: 'A long task blocked the main thread.' };
    case 'page':
      return { title: row.name, detail: a[0] ? plain(a[0]) : '' };
    default:
      return { title: row.name, detail: '' };
  }
}

// ---- who did it ------------------------------------------------------------------------------------------------------

/** 32-hex sys_ids in a function name or in a script url PATH (never the query, which holds the record's own id). */
export function idsIn(text) {
  const found = String(text || '').match(SYS_ID_ANY);
  return found ? [...new Set(found.map((s) => s.toLowerCase()))] : [];
}

function frameIds(frame) {
  return [...new Set([...idsIn(frame.fn), ...idsIn(frame.url)])];
}

/** UI scripts are served as <name>.jsdbx; the file's base name is the only name worth looking up. */
function frameNames(frame) {
  const m = /([^/]+)\.jsdbx$/i.exec(frame.url || '');
  return m ? [m[1]] : [];
}

export function frameText(frame) {
  if (!frame) return '';
  return `${frame.fn || '(anonymous)'} at ${frame.url || 'inline script'}:${frame.line}:${frame.col}`;
}

// ---- the page's own source: inline client scripts and embedded UI policies -----------------------------------------
// The content script reads the page's inline <script> text (document.scripts, never a refetch) and hands it to these.
// Everything is bounded, nothing is evaluated: JSON.parse on an exact bracket-balanced slice, a plain text scan otherwise.

export const MAX_FUNCTION_REFS = 25;
export const MAX_PAGE_REFS = 20;
export const UI_POLICY_ENGINE = /\/scripts\/[\w.]*ui_policy[\w.]*\.jsx?$/i;
const PAGE_FN = /^[A-Za-z_$][\w$]{2,99}$/;
const CONDITION_FN = /^onCondition_([0-9a-f]{32})_(true|false)$/;
const SYS_ID_ONLY = /^[0-9a-f]{32}$/;

/**
 * Index of the bracket that closes the one at `start` (`open`/`close` a pair such as [ ]), skipping string literals and
 * comments; -1 when it is not closed within `max` characters. A regular expression literal that holds a quote can
 * confuse it; the callers then fail safe (JSON.parse throws, or the source check finds no match).
 */
export function matchClose(text, start, open, close, max = 2_000_000) {
  let depth = 0;
  const end = Math.min(text.length, start + max);
  for (let i = start; i < end; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i += 1;
      while (i < end && text[i] !== c) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
    } else if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl < 0 || nl >= end) return -1;
      i = nl;
    } else if (c === '/' && text[i + 1] === '*') {
      const stop = text.indexOf('*/', i + 2);
      if (stop < 0 || stop >= end) return -1;
      i = stop + 1;
    } else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * The UI policies the page embeds with ui_policy_add([...]) (classic forms), reduced to what attribution needs:
 * -> { policies: [{ sysId, name, table, actions: [{ field, mandatory, visible, disabled, cleared }] }], failed }
 * `failed` counts calls whose data could not be parsed (then the panel says it could not read them all).
 */
export function extractUiPolicies(texts) {
  const policies = [];
  let failed = 0;
  let calls = 0;
  (Array.isArray(texts) ? texts : []).forEach((text) => {
    if (typeof text !== 'string') return;
    let from = 0;
    while (calls < 40 && policies.length < 400) {
      const at = text.indexOf('ui_policy_add(', from);
      if (at < 0) break;
      from = at + 14;
      if (at > 0 && /[\w$.]/.test(text[at - 1])) continue; // catalog_ui_policy_add, x.ui_policy_add: another format
      let i = from;
      while (i < text.length && /\s/.test(text[i])) i += 1;
      if (text[i] !== '[' && text[i] !== '{') continue; // the function's own definition, or not data
      calls += 1;
      const end = matchClose(text, i, text[i], text[i] === '[' ? ']' : '}', 3_000_000);
      if (end < 0) {
        failed += 1;
        continue;
      }
      let data;
      try {
        data = JSON.parse(text.slice(i, end + 1));
      } catch {
        failed += 1;
        from = end + 1;
        continue;
      }
      from = end + 1;
      (Array.isArray(data) ? data : [data]).slice(0, 400).forEach((p) => {
        if (!p || typeof p !== 'object' || policies.length >= 400) return;
        const actions = (Array.isArray(p.actions) ? p.actions : [])
          .slice(0, 100)
          .filter((a) => a && typeof a === 'object' && typeof a.name === 'string' && a.name)
          .map((a) => ({ field: str(a.name, 100), mandatory: str(a.mandatory, 10), visible: str(a.visible, 10), disabled: str(a.disabled, 10), cleared: str(a.cleared, 10) }));
        const sysId = typeof p.sys_id === 'string' && SYS_ID_ONLY.test(p.sys_id) ? p.sys_id : '';
        policies.push({ sysId, name: str(p.short_description, 120), table: str(p.table, 80), actions });
      });
    }
  });
  return { policies, failed };
}

/** What a g_form method does, as the UI policy action property that does the same. */
const POLICY_EFFECT = { setMandatory: 'mandatory', setVisible: 'visible', setDisplay: 'visible', setReadOnly: 'disabled', setReadonly: 'disabled', setDisabled: 'disabled', clearValue: 'cleared' };
const EFFECT_WORDS = { mandatory: 'mandatory', visible: 'visible / hidden', disabled: 'read-only', cleared: 'clear value' };

function policyEffect(row) {
  const method = String(row.name || '').replace('g_form.', '');
  if (method === 'setValue' && Array.isArray(row.args) && row.args[0] === '') return 'cleared';
  return POLICY_EFFECT[method] || '';
}

/**
 * The page's UI policies that could have made this g_form call: an action on the same field with the same effect
 * (mandatory, visible, read-only, clear value). A policy that applies "true" can also apply the reverse when its
 * condition is false, so the direction is not used to rule one out.
 */
export function policyCandidates(policies, row) {
  if (!Array.isArray(policies) || typeof row.field !== 'string' || !row.field) return [];
  const effect = policyEffect(row);
  return policies.filter((p) =>
    (p.actions || []).some((a) => {
      if (a.field !== row.field) return false;
      if (!effect) return true;
      const v = a[effect];
      return effect === 'cleared' ? v === 'true' : Boolean(v) && v !== 'ignore';
    })
  );
}

function functionPattern(name) {
  const n = name.replace(/\$/g, '\\$');
  // function NAME(...), NAME = function (...), window.NAME = function (...), NAME: function (...)
  return new RegExp(`(?:function\\s+${n}\\s*\\(|(?:^|[^\\w$])${n}\\s*[:=]\\s*function\\b[^(]{0,40}\\()`, 'g');
}

/**
 * The body (between the braces) of the page function `name`, from the page's inline script text. null when it is not
 * there, is defined more than once (which one ran is then unknown), or cannot be delimited within `maxLen` characters.
 */
export function extractFunctionSource(texts, name, maxLen = 60000) {
  if (typeof name !== 'string' || !PAGE_FN.test(name)) return null;
  const re = functionPattern(name);
  let found = null;
  let count = 0;
  for (const text of Array.isArray(texts) ? texts : []) {
    if (typeof text !== 'string') continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && count < 3) {
      count += 1;
      if (count > 1) return null;
      const paren = m.index + m[0].length - 1;
      const closeParen = matchClose(text, paren, '(', ')', 4000);
      if (closeParen < 0) return null;
      const open = text.indexOf('{', closeParen);
      if (open < 0 || open - closeParen > 200) return null;
      const close = matchClose(text, open, '{', '}', maxLen);
      if (close < 0) return null;
      found = text.slice(open + 1, close);
    }
  }
  return found;
}

const BOILERPLATE = /isLoading|isTemplate|newValue\s*$|^(?:return|break|continue|else|try|finally|var|let|const|function)\b[\s;]*$|^function\b|^[{}()\s;]*$|^\/\/|^\/\*|^\*|^javascript:/i;

/**
 * Up to `max` short pieces of a function body to find its client script by (scriptLIKE...): single lines, cut at
 * characters an encoded query could read as an operator or separator (^ = < > !), 25 to 120 characters, not boilerplate
 * that thousands of scripts share (if (isLoading ...)), never anything that looks like a secret. Longer pieces and ones
 * with a string literal (a field name, a message) come first.
 */
export function sourceFragments(body, max = 2) {
  const seen = new Set();
  const pieces = [];
  String(body || '')
    .split(/\r?\n/)
    .slice(0, 120)
    .forEach((line, i) => {
      line.split(/[\^=<>!]/).forEach((part) => {
        let p = part.trim();
        if (p.length > 120) p = p.slice(0, 120).trim();
        if (p.length < 25 || seen.has(p) || BOILERPLATE.test(p) || /[\\\u0000-\u0008\u000b-\u001f]/.test(p)) return;
        if (isSecretName(p) || looksSecret(p) || scrub(p, 1000) !== p) return;
        seen.add(p);
        pieces.push({ p, score: p.length + (/['"]/.test(p) ? 40 : 0) - i });
      });
    });
  return pieces
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.p);
}

const normalizeSource = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Does this record's script hold this function body? At least 80% of the body's non-trivial lines (up to 12, compared
 * with whitespace collapsed) must appear in it, so a script that merely shares one line is not taken for it.
 */
export function sourceMatches(body, script) {
  const hay = normalizeSource(script);
  if (!hay) return false;
  const lines = [
    ...new Set(
      String(body || '')
        .split(/\r?\n/)
        .map(normalizeSource)
        .filter((l) => l.length >= 12 && !/^(?:[{}();]|\/\/)/.test(l))
    ),
  ].slice(0, 12);
  if (!lines.length) return false;
  const hit = lines.filter((l) => hay.includes(l)).length;
  return hit >= Math.max(1, Math.ceil(lines.length * 0.8));
}

/**
 * The name of the page function a stack frame is in, as the page's source defines it, or '' when the frame is not in
 * the page's own inline script (a .js / .jsx / .jsdbx file, eval, an anonymous function). V8 prints methods as
 * "Object.onChange_x [as category]": the last name is the one in the source.
 */
export function pageFunctionName(frame) {
  if (!frame || !frame.fn || !frame.url || /\.(?:jsx?|jsdbx)$/i.test(frame.url)) return '';
  const fn = String(frame.fn)
    .replace(/\s*\[as [^\]]*\]$/, '')
    .replace(/^(?:new|async)\s+/, '')
    .split('.')
    .pop();
  return PAGE_FN.test(fn) && !/^(?:anonymous|eval|Object|Function|msb)/.test(fn) ? fn : '';
}

/** The page path of each recorded page load (rid), from its page marker. */
function hrefsOf(rows) {
  const out = new Map();
  rows.forEach((row) => {
    if (row.kind === 'page' && typeof row.args?.[0] === 'string' && !out.has(row.rid)) out.set(row.rid, row.args[0]);
  });
  return out;
}

/**
 * What to look up on the instance for these rows (each deduplicated and capped):
 * { ids, names, classes, functions: [{ rid, frame, href, fn }], pages: [{ rid, frame, href }] }.
 * `functions` are page functions to find by their source text; `pages` are page loads whose embedded UI policies to read.
 */
export function collectRefs(rows) {
  const ids = new Set();
  const names = new Set();
  const classes = new Set();
  const functions = new Map();
  const pages = new Map();
  const hrefs = hrefsOf(rows);
  rows.forEach((row) => {
    const rid = row.rid || '';
    (row.stack || []).forEach((f) => {
      frameIds(f).forEach((id) => ids.add(id));
      frameNames(f).forEach((n) => names.add(n));
      const fn = pageFunctionName(f);
      if (fn && CONDITION_FN.test(fn)) pages.set(rid, { rid, frame: row.frame || '', href: hrefs.get(rid) || '' });
      else if (fn && !functions.has(`${rid}|${fn}`)) functions.set(`${rid}|${fn}`, { rid, frame: row.frame || '', href: hrefs.get(rid) || '', fn });
      if (UI_POLICY_ENGINE.test(f.url || '')) pages.set(rid, { rid, frame: row.frame || '', href: hrefs.get(rid) || '' });
    });
    if (row.kind === 'ajax' && typeof row.args?.[0] === 'string' && row.args[0]) classes.add(row.args[0]);
  });
  // Client script handlers first: they are what a developer asks about.
  const fnList = [...functions.values()].sort((a, b) => Number(/^on[A-Z]/.test(b.fn)) - Number(/^on[A-Z]/.test(a.fn)));
  return {
    ids: [...ids].slice(0, 200),
    names: [...names].slice(0, 50),
    classes: [...classes].slice(0, 50),
    functions: fnList.slice(0, MAX_FUNCTION_REFS),
    pages: [...pages.values()].slice(0, MAX_PAGE_REFS),
  };
}

function recordLabel(rec) {
  const kind = rec.kind || (RESOLVE_TABLES.find((t) => t.table === rec.table) || {}).kind || 'Script';
  let how = '';
  if (rec.table === 'sys_script_client') how = rec.type ? `${rec.type}${rec.type === 'onChange' && rec.field ? ` on ${rec.field}` : ''}` : '';
  else if (rec.table === 'catalog_script_client') how = rec.type || '';
  return `${kind}: ${rec.name || rec.sysId || 'unnamed'}${how ? ` (${how})` : ''}`;
}

const policyName = (p) => `"${p.name || p.sysId || 'unnamed'}"`;
const policyRecord = (p) => (p.sysId ? { table: 'sys_ui_policy', kind: 'UI policy', name: p.name, sysId: p.sysId } : null);

/** A call made by /scripts/ui_policy.jsx: certainly the UI policy engine; which policy, only as far as the page shows. */
function policyAttribution(row, frame, policies) {
  const where = frameText(frame);
  if (!Array.isArray(policies)) return { known: true, engine: true, label: 'UI policy engine', detail: 'Which policy could not be told: the UI policies of that page could not be read.', where, record: null };
  const effect = policyEffect(row);
  const what = `${effect ? `a ${EFFECT_WORDS[effect]} action` : 'an action'} on ${row.field || 'this field'}`;
  const found = policyCandidates(policies, row);
  if (found.length === 1) {
    return { known: true, engine: true, label: `UI policy ${policyName(found[0])}`, detail: `Applied by the UI policy engine; the only UI policy on this page with ${what}.`, where, record: policyRecord(found[0]) };
  }
  if (found.length > 1) {
    const listed = found.slice(0, 4).map(policyName).join(', ');
    return {
      known: true,
      engine: true,
      guess: true,
      label: `UI policy engine: one of ${listed}${found.length > 4 ? ` and ${found.length - 4} more` : ''}`,
      detail: `${found.length} UI policies on this page have ${what}; the stack does not say which one ran.`,
      where,
      record: null,
      candidates: found.slice(0, 10).map(policyRecord).filter(Boolean),
    };
  }
  return { known: true, engine: true, label: 'UI policy engine', detail: `No UI policy embedded in this page has ${what}.`, where, record: null };
}

/**
 * Which script made this call. Looks down the stack, nearest frame first, for:
 *  - a sys_id or UI script name the instance confirmed (`resolved.ids` / `resolved.names`);
 *  - a page function whose source text matched exactly one active client script (`resolved.sources[rid][fn]`);
 *  - a UI policy's own script (onCondition_<sys_id>_true/false, the sys_id confirmed by the page's embedded policies);
 *  - the UI policy engine (/scripts/ui_policy.jsx), with the page's policies that have a matching action
 *    (`resolved.policies[rid]`): one is named, several are listed as "one of", none says so.
 * If none applies, the answer is "Unknown script" and the nearest frame, never a guess.
 * -> { known, label, where, record?, detail?, guess?, engine? }
 */
export function attribute(row, resolved = {}) {
  const frames = row.stack || [];
  const sources = resolved.sources?.[row.rid] || {};
  const policies = resolved.policies?.[row.rid];
  for (const f of frames) {
    for (const id of frameIds(f)) {
      const rec = resolved.ids?.[id];
      if (rec) return { known: true, label: recordLabel({ ...rec, sysId: id }), where: frameText(f), record: { ...rec, sysId: id } };
    }
    for (const n of frameNames(f)) {
      const rec = resolved.names?.[n];
      if (rec) return { known: true, label: recordLabel(rec), where: frameText(f), record: rec };
    }
    const fn = pageFunctionName(f);
    const src = fn && Object.prototype.hasOwnProperty.call(sources, fn) ? sources[fn] : null;
    if (src) {
      return { known: true, label: `${src.kind || 'Client script'} "${src.name || src.sysId}" (matched by its source text)`, detail: 'Its source text in the page matched exactly one active script on the instance.', where: frameText(f), record: { ...src } };
    }
    const cond = fn ? CONDITION_FN.exec(fn) : null;
    const policy = cond && Array.isArray(policies) ? policies.find((p) => p.sysId === cond[1]) : null;
    if (policy) return { known: true, label: `UI policy ${policyName(policy)} (its script if ${cond[2]})`, where: frameText(f), record: policyRecord(policy) };
    if (UI_POLICY_ENGINE.test(f.url || '')) return policyAttribution(row, f, policies);
  }
  return { known: false, label: 'Unknown script', where: frames.length ? frameText(frames[0]) : 'no stack was captured', record: null };
}

/** onLoad / onChange / ... when the nearest frames name the handler, else ''. Only a hint for unresolved calls. */
export function handlerHint(row) {
  for (const f of row.stack || []) {
    const m = HANDLER.exec(f.fn || '');
    if (m) return m[1];
  }
  return '';
}

// ---- stories ----------------------------------------------------------------------------------------------------------

function requested(row) {
  return Array.isArray(row.args) ? row.args[0] : undefined;
}

/** What a g_form call did to its field, as a short phrase ("set to ...", "made mandatory"). */
export function verbFor(row) {
  const a = Array.isArray(row.args) ? row.args : [];
  const name = String(row.name || '').replace('g_form.', '');
  const on = a[0] === true || a[0] === 'true';
  const off = a[0] === false || a[0] === 'false';
  const hidden = row.flags?.hidden;
  let text;
  switch (name) {
    case 'setValue': {
      const r = row.result;
      const want = requested(row);
      if (hidden) text = 'set (value not recorded)';
      else if (r && r.changed === false && r.before !== undefined && String(want) !== String(r.before)) text = `tried to set ${quote(want)} but the value stayed ${quote(r.before)}`;
      else if (r && r.changed === false) text = `set to ${quote(want)} (it already had that value)`;
      else if (r && r.before !== undefined && r.before !== null && r.before !== '') text = `changed from ${quote(r.before)} to ${quote(want)}`;
      else text = `set to ${quote(want)}`;
      break;
    }
    case 'clearValue':
      text = row.result && row.result.before ? `cleared (it was ${quote(row.result.before)})` : 'cleared';
      break;
    case 'setMandatory':
      text = on ? 'made mandatory' : off ? 'made not mandatory' : `setMandatory(${quote(a[0])})`;
      break;
    case 'setReadOnly':
    case 'setReadonly':
      text = on ? 'made read-only' : off ? 'made editable' : `${name}(${quote(a[0])})`;
      break;
    case 'setDisabled':
      text = on ? 'disabled' : off ? 'enabled' : `setDisabled(${quote(a[0])})`;
      break;
    case 'setVisible':
    case 'setDisplay':
      text = `${on ? 'shown' : off ? 'hidden' : `${name}(${quote(a[0])})`}${on || off ? ` (${name})` : ''}`;
      break;
    case 'showFieldMsg':
      text = `showed the message ${quote(a[0])}${a[1] ? ` (${a[1]})` : ''}`;
      break;
    case 'hideFieldMsg':
      text = 'had its message removed';
      break;
    case 'showErrorBox':
      text = `showed an error: ${quote(a[0])}`;
      break;
    case 'hideErrorBox':
      text = 'had its error box removed';
      break;
    case 'addOption':
      text = `got the option ${quote(a[1] !== undefined && a[1] !== null ? a[1] : a[0])}`;
      break;
    case 'removeOption':
      text = `lost the option ${quote(a[0])}`;
      break;
    case 'clearOptions':
      text = 'had all its options removed';
      break;
    case 'setLabelOf':
      text = `relabelled ${quote(a[0])}`;
      break;
    default:
      text = callText(name, a);
  }
  return row.flags?.unknownField ? `${text} - but the field is not on the form, so ServiceNow ignored it` : text;
}

/**
 * One story per field per page load: every g_form call that touched it, in order, with who did it.
 * -> [{ key, field, frame, rid, steps: [{ rowKey, t, text, by, known, where }], summary, scripts }]
 */
export function buildStories(rows, resolved = {}) {
  const groups = new Map();
  rows.forEach((row) => {
    if (row.kind !== 'field' || typeof row.field !== 'string' || !row.field) return;
    const key = `${row.rid}|${row.field}`;
    if (!groups.has(key)) groups.set(key, { key, field: row.field, frame: row.frame, rid: row.rid, rows: [] });
    groups.get(key).rows.push(row);
  });
  return [...groups.values()]
    .map((g) => {
      const steps = g.rows.map((row) => {
        const who = attribute(row, resolved);
        return { rowKey: row.key, t: row.t, text: verbFor(row), by: who.label, known: who.known, where: who.where, scriptKey: who.known ? who.label : `unknown:${who.where}`, valueChange: ['setValue', 'clearValue'].includes(String(row.name).replace('g_form.', '')) && row.result?.changed !== false, unknownField: Boolean(row.flags?.unknownField) };
      });
      const scripts = new Set(steps.filter((s) => s.valueChange).map((s) => s.scriptKey));
      const parts = steps.map((s, i) => `${i === 0 ? '' : 'then '}${s.text} at ${fmtMs(s.t)} by ${s.known ? s.by : 'an unknown script'}`);
      return { key: g.key, field: g.field, frame: g.frame, rid: g.rid, steps, scripts: scripts.size, summary: `${g.field}: ${parts.join(', ')}` };
    })
    .sort((a, b) => (a.steps[0]?.t ?? 0) - (b.steps[0]?.t ?? 0) || a.field.localeCompare(b.field));
}

// ---- what stands out ---------------------------------------------------------------------------------------------------

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function ajaxKey(row) {
  return JSON.stringify([row.args?.[0], row.args?.[1], row.args?.[2]]);
}

/**
 * Things worth a second look: errors, slow or blocking calls, repeated GlideAjax, calls on fields that are not on the
 * form, fields several scripts fight over, long busy periods, the biggest silent gap, script includes that cannot be
 * called from the client. -> [{ id, severity, title, detail, rowKeys }], most serious first.
 */
export function findFindings(rows, resolved = {}) {
  const out = [];
  const add = (id, severity, title, detail, rowKeys) => out.push({ id, severity, title, detail, rowKeys });

  rows.forEach((row) => {
    const d = describeRow(row);
    if (row.kind === 'error') add(`error-${row.key}`, 'high', `JavaScript error: ${plain(row.args?.[0]).slice(0, 140)}`, `${row.name} at ${fmtMs(row.t)} in ${row.frame}`, [row.key]);
    else if (row.kind === 'console' && row.name === 'console.error') add(`console-${row.key}`, 'medium', `console.error: ${plain((row.args || []).join(' ')).slice(0, 140)}`, `At ${fmtMs(row.t)} in ${row.frame}`, [row.key]);
    if (row.flags?.threw && row.kind !== 'error') add(`threw-${row.key}`, 'high', `${row.name} threw an exception`, plain(row.result?.error), [row.key]);
    if (row.kind === 'ajax' && !row.pending && (row.durationMs ?? 0) >= SLOW_AJAX_MS) {
      add(`slow-${row.key}`, row.durationMs >= 2000 ? 'high' : 'medium', `Slow GlideAjax: ${d.title} took ${fmtMs(row.durationMs)}`, `Started at ${fmtMs(row.t)}. ${row.flags?.blocking ? 'It is synchronous, so the browser was frozen the whole time.' : 'It is asynchronous, so it delays whatever waits for its answer.'}`, [row.key]);
    } else if (row.flags?.blocking && (row.kind === 'ajax' || row.kind === 'glide' || row.kind === 'network')) {
      add(`blocking-${row.key}`, (row.durationMs ?? 0) >= 100 ? 'medium' : 'low', `Synchronous call blocks the browser: ${d.title}${row.durationMs !== undefined ? ` (${fmtMs(row.durationMs)})` : ''}`, 'Use the callback form (getXML / getXMLAnswer, or GlideRecord.query with a callback) so the page stays responsive.', [row.key]);
    }
    if (row.kind === 'network' && !row.pending) {
      if (isFailed(row) && !row.flags?.threw) add(`failed-${row.key}`, 'medium', `Request failed: ${row.name}`, row.result?.status ? `Status ${row.result.status}` : 'No response', [row.key]);
      else if ((row.durationMs ?? 0) >= SLOW_NETWORK_MS) add(`slownet-${row.key}`, 'medium', `Slow request: ${row.name} took ${fmtMs(row.durationMs)}`, `Started at ${fmtMs(row.t)}`, [row.key]);
    }
    if (row.flags?.unknownField && row.kind === 'field') add(`unknown-${row.key}`, 'medium', `${row.name}("${row.field}") is on a field that is not on the form`, 'g_form.hasField says the field is missing, so ServiceNow ignores the call. Check the field name and the form view.', [row.key]);
    if (row.kind === 'longtask' && (row.durationMs ?? 0) >= LONG_TASK_MS) add(`busy-${row.key}`, row.durationMs >= 1000 ? 'high' : 'medium', `The page was busy for ${fmtMs(row.durationMs)}`, `Starting at ${fmtMs(row.t)} in ${row.frame}. Look at what ran just before it in the timeline.`, [row.key]);
  });

  // The same GlideAjax asked again and again.
  const repeats = new Map();
  rows.filter((r) => r.kind === 'ajax' && (r.args?.[0] || r.args?.[1])).forEach((r) => {
    const k = `${r.rid}|${ajaxKey(r)}`;
    if (!repeats.has(k)) repeats.set(k, []);
    repeats.get(k).push(r);
  });
  repeats.forEach((list, k) => {
    if (list.length < REPEAT_AT) return;
    const first = list[0];
    const total = list.reduce((s, r) => s + (r.durationMs ?? 0), 0);
    add(`repeat-${k}`, 'medium', `Same GlideAjax called ${list.length} times: ${first.args[0] || '?'}.${first.args[1] || '?'}`, `${total ? `${fmtMs(total)} in total. ` : ''}Same parameters each time. Ask once and keep the answer.`, list.map((r) => r.key));
  });

  // A field that more than one script changed.
  buildStories(rows, resolved).forEach((story) => {
    if (story.scripts >= 2) add(`contested-${story.key}`, 'medium', `${story.field} was changed by ${story.scripts} different scripts`, story.summary, story.steps.map((s) => s.rowKey));
  });

  // A script include the instance says cannot be called (or does not exist).
  Object.entries(resolved.classes || {}).forEach(([cls, info]) => {
    const keys = rows.filter((r) => r.kind === 'ajax' && r.args?.[0] === cls).map((r) => r.key);
    if (!keys.length) return;
    if (info.found === false) add(`class-missing-${cls}`, 'medium', `GlideAjax class "${cls}" was not found as a script include`, 'Checked the name and API name on sys_script_include (only rows you can read). A scoped class needs its scope prefix. A few processors are built into the platform and are not script includes; for those this is expected.', keys);
    else if (info.clientCallable === false) add(`class-callable-${cls}`, 'high', `Script include "${cls}" is not client callable`, 'GlideAjax cannot call it until "Client callable" is ticked on the script include.', keys);
  });

  // The biggest stretch with nothing recorded while the page loads. Only a recording that began with the page load (it has
  // the "page load started" marker) and only its first 15 seconds: later, a gap is just the person thinking.
  let gap = null;
  const perDoc = new Map();
  const fromTheStart = new Set(rows.filter((r) => r.kind === 'page' && r.name === 'page load started').map((r) => r.rid));
  rows.filter((r) => r.kind !== 'page' && fromTheStart.has(r.rid) && r.t < GAP_WINDOW_MS).forEach((r) => {
    if (!perDoc.has(r.rid)) perDoc.set(r.rid, []);
    perDoc.get(r.rid).push(r);
  });
  perDoc.forEach((list) => {
    const sorted = list.slice().sort((a, b) => a.t - b.t);
    let reach = sorted.length ? sorted[0].t + (sorted[0].durationMs ?? 0) : 0;
    for (let i = 1; i < sorted.length; i += 1) {
      const here = sorted[i];
      const size = here.t - reach;
      if (size >= GAP_MS && (!gap || size > gap.size)) gap = { size, before: sorted[i - 1], after: here };
      reach = Math.max(reach, here.t + (here.durationMs ?? 0));
    }
  });
  if (gap) {
    add('gap', 'low', `Biggest gap: ${fmtMs(gap.size)} with nothing recorded`, `Between ${describeRow(gap.before).title} (${fmtMs(gap.before.t)}) and ${describeRow(gap.after).title} (${fmtMs(gap.after.t)}). Page scripts, rendering or the network ran there; it is not necessarily idle.`, [gap.before.key, gap.after.key]);
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

// ---- Markdown for a ticket -----------------------------------------------------------------------------------------------

// Kinds whose calls come from a script, so the report names the script behind them.
const SCRIPT_KINDS = new Set(['field', 'message', 'form', 'ajax', 'glide', 'modal', 'error', 'console', 'log', 'network']);

// Page text (console messages, error text, values) goes into a report that is pasted into tickets: a "[x](url)",
// "![x](url)" or "<img ...>" in it must stay text there, not become a link, an image that loads, or HTML.
// The recorder's own "[hidden]" marker stays readable (a bare [hidden] is no link unless "(" or ":" follows it).
const md = (text) =>
  plain(text)
    .replace(/[\\[\]<>`]/g, '\\$&')
    .replace(/\\\[hidden\\\](?![(:])/g, '[hidden]');

const cell = (text, max = 110) => {
  const s = md(text).replace(/\|/g, '\\|');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * A ticket-ready report. `rows` are the rows to show (the panel passes the ones its filters keep), `meta` is
 * { host, page, recordedAt (epoch ms), scope }.
 */
export function toMarkdown({ rows, findings = [], stories = [], resolved = {}, meta = {}, maxRows = MAX_TABLE_ROWS } = {}) {
  const lines = ['## Client trace', ''];
  const facts = [];
  if (meta.host) facts.push(`Instance: ${md(meta.host)}`);
  if (meta.page) facts.push(`Page: ${md(meta.page)}`);
  if (meta.recordedAt) facts.push(`Recorded: ${new Date(meta.recordedAt).toISOString()}`);
  facts.push(`${rows.length} event${rows.length === 1 ? '' : 's'}${meta.scope === 'all' ? ' (all page loads)' : ' (latest page load of each frame)'}`);
  facts.forEach((f) => lines.push(`- ${f}`));
  lines.push('');
  if (!rows.length) {
    lines.push(meta.hiddenLogs > 0 ? `Nothing to show: ${meta.hiddenLogs} platform debug log (jslog) lines are hidden.` : 'Nothing was recorded.');
    return lines.join('\n');
  }
  if (findings.length) {
    lines.push('### What stands out', '');
    findings.forEach((f) => lines.push(`- **${f.severity}**: ${md(f.title)}${f.detail ? ` - ${md(f.detail)}` : ''}`));
    lines.push('');
  }
  if (stories.length) {
    lines.push('### Field stories', '');
    stories.forEach((s) => lines.push(`- ${md(s.summary)}`));
    lines.push('');
  }
  const frames = new Set(rows.map((r) => r.frame));
  const showFrame = frames.size > 1;
  lines.push('### Timeline', '', `| Time | ${showFrame ? 'Frame | ' : ''}Kind | What | Script | Duration |`, `| --- | ${showFrame ? '--- | ' : ''}--- | --- | --- | --- |`);
  rows.slice(0, maxRows).forEach((row) => {
    const d = describeRow(row);
    const who = SCRIPT_KINDS.has(row.kind) ? attribute(row, resolved) : null;
    const what = `${cell(d.title)}${d.detail ? ` (${cell(d.detail, 80)})` : ''}`;
    const script = who ? cell(who.known ? who.label : `Unknown script (${who.where})`, 90) : '';
    const took = row.durationMs !== undefined ? fmtMs(row.durationMs) : row.pending ? 'no answer yet' : '';
    lines.push(`| ${fmtMs(row.t)} | ${showFrame ? `${cell(row.frame, 30)} | ` : ''}${KINDS[row.kind]?.label || row.kind} | ${what} | ${script} | ${took} |`);
  });
  if (rows.length > maxRows) lines.push('', `Only the first ${maxRows} of ${rows.length} events are shown.`);
  if (meta.hiddenLogs > 0) lines.push('', `${meta.hiddenLogs} platform debug log (jslog) line${meta.hiddenLogs === 1 ? ' is' : 's are'} not included (hidden in the panel; Export JSON has them).`);
  lines.push('', '_Recorded by NowBuddy Client trace. Times are ms since each frame started loading. Values of password-type and secret-named fields are not recorded._');
  return lines.join('\n');
}
