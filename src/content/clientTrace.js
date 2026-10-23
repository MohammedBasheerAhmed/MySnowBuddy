// Client trace, the content-script half (panel: src/sidebar/ClientTracePanel.jsx; analysis: src/lib/clientTrace.js; the
// recorder itself runs in the page's own JavaScript world: src/page/recorder.js).
//
// How the pieces talk:
//  - Arming is sessionStorage['msb_trace_armed'] = <expiry epoch ms>, written here. sessionStorage is shared by every
//    same-origin frame of the tab, so the classic form frame (gsft_main) sees it too, and gets a `storage` event when it
//    changes, which is how Arm and Disarm reach frames without polling.
//  - This script and the recorder share the DOM, not JavaScript globals. Requests go as CustomEvents with an unguessable
//    id; the recorder answers with a CustomEvent carrying that id (the same pattern as src/content/pageBridge.js).
//    The answer is a plain object, so it crosses worlds as data.
//  - Every frame has its own recorder; the panel lives only in the top frame. The top frame asks each child frame for
//    new events with window.postMessage (exact origin, source checked), children answer the same way, and a frame
//    that has children of its own passes their answers up. A frame about to unload sends what it still holds.
//    postMessage is not a security boundary (a page script can post the same message), so everything that arrives is
//    rebuilt by sanitizeEvent() and is only ever displayed.
//  - Read-only on the instance: resolving "which script was that" only queries sys_script_client, sys_ui_policy,
//    sys_ui_action, sys_ui_script, catalog_script_client, catalog_ui_policy and sys_script_include.

import { newRequestId } from './pageBridge.js';
import { queryTable } from './tableApi.js';
import { ARM_KEY, ARM_DURATION_MS, REQUEST_EVENT, RESPONSE_EVENT, isServiceNowHost, clip } from '../lib/clientTraceRecorder.js';
import { RESOLVE_TABLES, sanitizeEvent, buildRows, collectRefs, extractUiPolicies, extractFunctionSource, sourceFragments, sourceMatches, MAX_FUNCTION_REFS, MAX_PAGE_REFS } from '../lib/clientTrace.js';

const MARK = 'msb-trace';
const SYS_ID_RE = /^[0-9a-f]{32}$/;
const NAME_RE = /^[A-Za-z0-9_.\-]{1,80}$/;
const MAX_STORED = 6000;
const MAX_FRAMES = 40; // frame loads remembered for the state line (a page could post endless made-up ones)
const MAX_SEQS = 400;
const MAX_LOOKUP = { ids: 200, names: 50, classes: 50 };
const MAX_SOURCE_QUERIES = 25; // scriptLIKE lookups per resolve call
const TABLE_RE = /^[a-z0-9_]{1,80}$/;
const RID_RE = /^[\w-]{1,40}$/;
const FN_RE = /^[A-Za-z_$][\w$]{2,99}$/;
const CHILD_WAIT_MS = 160;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sameOrigin = () => window.location.origin;

// ---- arming ---------------------------------------------------------------------------------------------------------

function readArm() {
  try {
    const raw = sessionStorage.getItem(ARM_KEY);
    const until = Number(raw);
    // The page shares this storage and can write any number; the recorder never runs longer than this, so neither does the display.
    return raw !== null && Number.isFinite(until) && until > Date.now() ? Math.min(until, Date.now() + ARM_DURATION_MS + 60000) : 0;
  } catch {
    return 0;
  }
}

function writeArm(until) {
  try {
    if (until) sessionStorage.setItem(ARM_KEY, String(until));
    else sessionStorage.removeItem(ARM_KEY);
    return true;
  } catch {
    return false;
  }
}

// ---- talking to this frame's recorder --------------------------------------------------------------------------------

/** Synchronous: the recorder answers inside the dispatch. null when no recorder is loaded in this frame. */
function callRecorder(action, args = {}) {
  const id = newRequestId();
  let answer = null;
  const onAnswer = (event) => {
    const d = event?.detail;
    if (!answer && d && typeof d === 'object' && d.id === id) answer = d;
  };
  document.addEventListener(RESPONSE_EVENT, onAnswer);
  try {
    document.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: { id, action, args } }));
  } catch {
    answer = null;
  } finally {
    document.removeEventListener(RESPONSE_EVENT, onAnswer);
  }
  return answer && answer.ok ? answer.result : null;
}

// ---- what has been collected (top frame) ----------------------------------------------------------------------------------

const store = { events: [], keys: new Set(), version: 0 };
const frames = new Map(); // rid -> { frame, href, count, armed, lastSeen }
const lastSeq = new Map(); // rid -> highest seq already collected
let ownRid = '';

function ingest(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.rid !== 'string' || !payload.rid || payload.rid.length > 40) return;
  const rid = payload.rid;
  let added = 0;
  (Array.isArray(payload.events) ? payload.events.slice(0, 2000) : []).forEach((raw) => {
    const e = sanitizeEvent(raw);
    if (!e) return;
    const key = `${rid}#${e.seq}`;
    if (store.keys.has(key)) return;
    store.keys.add(key);
    store.events.push({ ...e, rid });
    added += 1;
  });
  if (Number.isFinite(payload.lastSeq)) lastSeq.set(rid, Math.max(lastSeq.get(rid) || 0, payload.lastSeq));
  frames.delete(rid); // re-inserted last: the Map's order is then oldest-seen first
  frames.set(rid, { frame: String(payload.frame || 'frame').slice(0, 60), href: String(payload.href || '').slice(0, 160), count: Number(payload.count) || 0, armed: payload.armed === true, missing: payload.missing === true, lastSeen: Date.now() });
  while (frames.size > MAX_FRAMES) frames.delete(frames.keys().next().value);
  while (lastSeq.size > MAX_SEQS) lastSeq.delete(lastSeq.keys().next().value);
  if (store.events.length > MAX_STORED) {
    store.events.splice(0, store.events.length - MAX_STORED).forEach((e) => store.keys.delete(`${e.rid}#${e.seq}`));
  }
  if (added) {
    store.events = store.events.slice();
    store.version += 1;
  }
}

function pullOwn() {
  if (!ownRid) ownRid = callRecorder('status')?.rid || '';
  const result = callRecorder('pull', { since: lastSeq.get(ownRid) || 0 });
  if (!result) return false;
  ownRid = result.rid;
  const status = callRecorder('status') || {};
  ingest({ ...result, armed: status.armed, count: status.count, href: status.href });
  return true;
}

function clearStore() {
  store.events = [];
  store.keys = new Set();
  store.version += 1;
}

// ---- other frames -------------------------------------------------------------------------------------------------------

function childWindows() {
  const out = [];
  try {
    for (let i = 0; i < window.frames.length && i < 30; i += 1) out.push(window.frames[i]);
  } catch {
    /* no frames */
  }
  return out;
}

function post(target, message) {
  try {
    target.postMessage({ source: MARK, ...message }, sameOrigin());
  } catch {
    /* gone, or cross-origin */
  }
}

function toChildren(message) {
  childWindows().forEach((w) => post(w, message));
}

const isDirectChild = (source) => {
  try {
    return Boolean(source) && source !== window && source.parent === window;
  } catch {
    return false;
  }
};

const isParent = (source) => window.parent !== window && source === window.parent;

let sentSeq = 0; // sub-frames: highest seq already sent up

function reportUp(since, final = false) {
  const status = callRecorder('status');
  if (!status) {
    // Say so: a form frame without a recorder is the first thing to suspect when nothing shows up.
    const name = String(window.name || 'frame').slice(0, 30);
    post(window.parent, { type: 'events', final, payload: { rid: `none-${name}`, frame: name, events: [], armed: false, count: 0, missing: true } });
    return;
  }
  const after = Math.max(Number(since) || 0, sentSeq);
  const result = callRecorder('pull', { since: after });
  if (!result) return;
  sentSeq = Math.max(sentSeq, result.lastSeq || 0);
  post(window.parent, { type: 'events', final, payload: { ...result, armed: status.armed, count: status.count, href: status.href } });
}

function onMessage(event) {
  // isTrusted: a real postMessage. A page script can construct a MessageEvent with any origin and a null source and
  // dispatch it on window; that one is not trusted and is ignored.
  if (!event || !event.isTrusted) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.source !== MARK || event.origin !== sameOrigin()) return;
  if (data.type === 'pull' && isParent(event.source)) {
    const status = callRecorder('status');
    reportUp(status && data.since && typeof data.since === 'object' ? Number(data.since[status.rid]) || 0 : 0);
    toChildren({ type: 'pull', since: data.since });
  } else if (data.type === 'clear' && isParent(event.source)) {
    callRecorder('clear');
    toChildren({ type: 'clear' });
  } else if (data.type === 'events' && (isDirectChild(event.source) || (event.source === null && data.final === true))) {
    // A frame that is unloading has no window to check any more (source is null); its last words are marked final.
    if (window.top === window) ingest(data.payload);
    else post(window.parent, { type: 'events', payload: data.payload });
  }
}

// Registered in every frame (this module is loaded wherever the content script runs). Each is a no-op until a
// matching message arrives.
try {
  window.addEventListener('message', onMessage);
  if (window.top !== window) {
    // A frame about to go away (the form frame reloading after a save, say) hands over what the top frame has not seen.
    window.addEventListener('pagehide', () => {
      try {
        if (readArm()) reportUp(0, true);
      } catch {
        /* nothing to hand over */
      }
    });
  }
} catch {
  /* no window */
}

// ---- state and services -----------------------------------------------------------------------------------------------------

function previewFixture() {
  try {
    const fixture = globalThis.__msbClientTraceFixture;
    return fixture && !isServiceNowHost(window.location.hostname) ? fixture : null;
  } catch {
    return null;
  }
}

function describeState() {
  const own = callRecorder('status');
  // The flag is what arms the tab, but the page shares sessionStorage and can clear it: a recorder in this frame that is
  // still running then still counts as recording, so the panel keeps offering Stop.
  const ownUntil = own?.armed && Number.isFinite(Number(own.until)) ? Math.min(Number(own.until), Date.now() + ARM_DURATION_MS + 60000) : 0;
  const until = readArm() || ownUntil;
  return {
    armed: Boolean(until),
    until,
    minutesLeft: until ? Math.max(1, Math.ceil((until - Date.now()) / 60000)) : 0,
    // 'missing': the recorder script is not in this page (it loads when the page starts; reload once after installing or updating).
    recorder: own ? 'running' : 'missing',
    recorderArmed: Boolean(own?.armed),
    frames: [...frames.entries()].map(([rid, f]) => ({ rid, ...f })).filter((f) => Date.now() - f.lastSeen < 60 * 60 * 1000),
    host: window.location.host,
    page: window.location.pathname,
  };
}

async function clientTraceStatus() {
  const fixture = previewFixture();
  if (fixture) return { ...fixture.state };
  return describeState();
}

/** Newest events from this frame and every frame below it, plus the current state. `events` is the same array until something new arrives. */
async function clientTraceLoad() {
  const fixture = previewFixture();
  if (fixture) return { state: { ...fixture.state }, events: fixture.events || [], version: fixture.version || 1 };
  pullOwn();
  const since = Object.fromEntries(lastSeq);
  if (childWindows().length) {
    toChildren({ type: 'pull', since });
    await sleep(CHILD_WAIT_MS);
  }
  return { state: describeState(), events: store.events, version: store.version };
}

async function clientTraceArm({ reload = false } = {}) {
  const fixture = previewFixture();
  if (fixture) {
    fixture.state = { ...fixture.state, armed: true, minutesLeft: 30 };
    return { ...fixture.state };
  }
  const until = Date.now() + ARM_DURATION_MS;
  if (!writeArm(until)) throw new Error('This browser tab blocks session storage, so the recorder cannot be armed here.');
  clientTraceClearNow();
  if (reload) {
    setTimeout(() => window.location.reload(), 150);
    return { ...describeState(), reloading: true };
  }
  callRecorder('arm', { until });
  return describeState();
}

async function clientTraceDisarm() {
  const fixture = previewFixture();
  if (fixture) {
    fixture.state = { ...fixture.state, armed: false, minutesLeft: 0 };
    return { ...fixture.state };
  }
  writeArm(0);
  callRecorder('disarm');
  // Other frames hear about it through the storage event. Pick up what they still hold.
  pullOwn();
  if (childWindows().length) {
    toChildren({ type: 'pull', since: Object.fromEntries(lastSeq) });
    await sleep(CHILD_WAIT_MS);
  }
  return describeState();
}

function clientTraceClearNow() {
  callRecorder('clear');
  toChildren({ type: 'clear' });
  clearStore();
}

async function clientTraceClear() {
  const fixture = previewFixture();
  if (fixture) {
    fixture.events = [];
    fixture.version = (fixture.version || 1) + 1;
    return { cleared: true };
  }
  clientTraceClearNow();
  return { cleared: true };
}

// ---- which script was that? --------------------------------------------------------------------------------------------------

const resolvedCache = { ids: new Map(), names: new Map(), classes: new Map(), notes: new Map(), sources: new Map(), policies: new Map(), sourceQueries: new Map(), tables: new Map() };
const errorText = (err) => String(err?.message || err).slice(0, 140);

// ---- the page's own source (inline <script> text of the frame the events came from) ---------------------------------

/** The window of a recorded frame, by the label the recorder gave it ('top' or the frame's name). null when ambiguous. */
function findFrameWindow(label) {
  if (label === 'top') return window.top === window ? window : null;
  const hits = [];
  const queue = childWindows().map((w) => ({ w, depth: 1 }));
  for (let seen = 0; queue.length && seen < 60; seen += 1) {
    const { w, depth } = queue.shift();
    try {
      if (clip(String(w.name || 'frame'), 60) === label) hits.push(w);
    } catch {
      /* another origin */
    }
    try {
      for (let i = 0; depth < 4 && i < w.frames.length && i < 30; i += 1) queue.push({ w: w.frames[i], depth: depth + 1 });
    } catch {
      /* no frames */
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

/** The inline script text of a document (no src), bounded: at most 400 scripts and 4 million characters. */
function inlineScripts(doc) {
  const out = [];
  let total = 0;
  const list = doc?.scripts || [];
  for (let i = 0; i < list.length && i < 400; i += 1) {
    const s = list[i];
    if (!s || s.src) continue;
    const type = String(s.type || '').toLowerCase();
    if (type && !/javascript|ecmascript|^module$/.test(type)) continue;
    const text = String(s.text || '').slice(0, 1_500_000);
    total += text.length;
    if (total > 4_000_000) break;
    out.push(text);
  }
  return out;
}

/** { texts, path, table } of the page a recorded frame shows now, or null (frame gone, another origin, another page). */
function readPage(label, href, memo) {
  const key = `${label}|${href}`;
  if (memo.has(key)) return memo.get(key);
  let page = null;
  try {
    const w = findFrameWindow(label);
    const doc = w && w.document;
    const loc = (doc && doc.location) || (w && w.location);
    const path = String((loc && loc.pathname) || '');
    // The frame must still show the page those events came from; another page has other scripts and policies.
    if (doc && (!href || path === href)) {
      const m = /^\/([a-z0-9_]{1,80})\.do$/.exec(path);
      page = { texts: inlineScripts(doc), path, table: m ? m[1] : '' };
    }
  } catch {
    page = null;
  }
  memo.set(key, page);
  return page;
}

/** The table and its parents (client scripts on a parent table with "inherited" run on the child's form too). */
function tablesFor(table) {
  if (!TABLE_RE.test(table || '')) return Promise.resolve([]);
  if (!resolvedCache.tables.has(table)) {
    resolvedCache.tables.set(
      table,
      (async () => {
        const chain = [table];
        try {
          let current = table;
          for (let depth = 0; depth < 6; depth += 1) {
            // eslint-disable-next-line no-await-in-loop -- each level depends on the previous one
            const rows = await queryTable('sys_db_object', `name=${current}`, ['super_class.name'], { limit: 1 });
            const parent = rows?.[0]?.['super_class.name'];
            if (typeof parent !== 'string' || !TABLE_RE.test(parent) || chain.includes(parent)) break;
            chain.push(parent);
            current = parent;
          }
        } catch {
          /* the form's own table only */
        }
        return chain;
      })()
    );
  }
  return resolvedCache.tables.get(table);
}

/**
 * The client script whose source holds this page function, or null. Asks with scriptLIKE<fragment> (active scripts, on
 * the form's table and its parents) and takes a record only when EXACTLY ONE comes back and its script really holds the
 * function body (sourceMatches). `budget.left` counts the queries; a failed query leaves a note and `budget.failed`.
 */
async function findBySource(body, page, budget, note) {
  const fragments = sourceFragments(body, 2);
  if (!fragments.length) return null;
  const tables = await tablesFor(page.table);
  const existing = await existingTables();
  const specs = [{ table: 'sys_script_client', kind: 'Client script', scope: tables.length ? `^tableIN${tables.join(',')}` : '' }];
  if (!existing || existing.has('catalog_script_client')) specs.push({ table: 'catalog_script_client', kind: 'Catalog client script', scope: '' });
  for (const spec of specs) {
    for (const fragment of fragments) {
      if (budget.left <= 0) {
        budget.exhausted = true; // not looked at: unknown, asked again next time
        return null;
      }
      // The fragment goes last, so nothing in it can be read as a later condition. It holds no ^ = < > ! or newline.
      const query = `active=true${spec.scope}^scriptLIKE${fragment}`;
      let rows = resolvedCache.sourceQueries.get(`${spec.table}|${query}`);
      if (!rows) {
        budget.left -= 1;
        try {
          // eslint-disable-next-line no-await-in-loop -- one at a time keeps the load on the instance low
          rows = await queryTable(spec.table, query, ['sys_id', 'name', 'table', 'type', 'field', 'script'], { limit: 3 });
          resolvedCache.sourceQueries.set(`${spec.table}|${query}`, rows);
        } catch (err) {
          budget.failed = true;
          note(`Could not search ${spec.table} by source text: ${errorText(err)}`);
          continue;
        }
      }
      const holding = (rows || []).filter((r) => typeof r.script === 'string' && r.script.includes(fragment));
      if (holding.length === 1 && rows.length === 1 && sourceMatches(body, holding[0].script)) {
        const r = holding[0];
        const sysId = String(r.sys_id || '').toLowerCase();
        if (!SYS_ID_RE.test(sysId)) return null;
        return { table: spec.table, kind: spec.kind, name: String(r.name || ''), sysId, type: r.type ? String(r.type) : '', field: r.field ? String(r.field) : '', tableName: r.table ? String(r.table) : '', how: 'source' };
      }
      // Several scripts share this line (or none has it): the next fragment may be unique; if none is, no name.
    }
  }
  return null;
}

/**
 * Page functions from the stacks (onLoad_<hex>, onChange_...): named only when their source matches one script.
 * Returns the keys left undecided (frame not readable now, query budget used up, a failed query): ask again later.
 */
async function resolveSources(functions, note) {
  const memo = new Map();
  const budget = { left: MAX_SOURCE_QUERIES, failed: false };
  const pending = [];
  for (const ref of functions) {
    const key = `${ref.rid}|${ref.fn}`;
    if (resolvedCache.sources.has(key)) continue;
    if (budget.exhausted) {
      pending.push(key);
      continue;
    }
    const page = readPage(ref.frame, ref.href, memo);
    if (!page) {
      pending.push(key);
      continue;
    }
    const body = extractFunctionSource(page.texts, ref.fn);
    if (body === null) {
      resolvedCache.sources.set(key, null);
      continue;
    }
    budget.failed = false;
    budget.exhausted = false;
    // eslint-disable-next-line no-await-in-loop -- bounded by the query budget
    const rec = await findBySource(body, page, budget, note);
    if (rec || (!budget.failed && !budget.exhausted)) resolvedCache.sources.set(key, rec);
    else pending.push(key);
  }
  return pending;
}

/** The UI policies each page load embeds (ui_policy_add data), read from the frame that still shows that page. */
function resolvePolicies(pages, note) {
  const memo = new Map();
  const pending = [];
  pages.forEach((ref) => {
    if (resolvedCache.policies.has(ref.rid)) return;
    const page = readPage(ref.frame, ref.href, memo);
    if (!page) {
      pending.push(ref.rid); // the frame shows another page now: the engine is named, no policy
      return;
    }
    const { policies, failed } = extractUiPolicies(page.texts);
    if (failed) note(`Some UI policy data in ${page.path} could not be read, so a UI policy may be missing from the candidates.`);
    resolvedCache.policies.set(ref.rid, policies.filter((p) => p.actions.length));
  });
  return pending;
}

function validRefs(list, max, withFn) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && typeof r === 'object' && typeof r.rid === 'string' && RID_RE.test(r.rid) && typeof r.frame === 'string' && r.frame.length <= 60 && (!withFn || (typeof r.fn === 'string' && FN_RE.test(r.fn))))
    .map((r) => ({ rid: r.rid, frame: r.frame, href: typeof r.href === 'string' && /^\/[^\s?#]{0,159}$/.test(r.href) ? r.href : '', ...(withFn ? { fn: r.fn } : {}) }))
    .slice(0, max);
}

async function lookup(table, query, fields, limit, onFail) {
  try {
    return await queryTable(table, query, fields, { limit });
  } catch (err) {
    onFail(`Could not check ${table}: ${errorText(err)}`);
    return null;
  }
}

let tableCheck = null;

/** For tests: forget every answer (a module keeps them for the life of the page). */
export function resetLookupCache() {
  resolvedCache.ids.clear();
  resolvedCache.names.clear();
  resolvedCache.classes.clear();
  resolvedCache.notes.clear();
  resolvedCache.sources.clear();
  resolvedCache.policies.clear();
  resolvedCache.sourceQueries.clear();
  resolvedCache.tables.clear();
  tableCheck = null;
}

/** Which of the lookup tables exist on this instance (the catalog ones need the Service Catalog). null when that cannot be read. */
async function existingTables() {
  if (!tableCheck) {
    tableCheck = queryTable('sys_db_object', `nameIN${RESOLVE_TABLES.map((t) => t.table).join(',')}`, ['name'], { limit: 20 })
      .then((rows) => {
        const set = new Set((rows || []).map((r) => r.name));
        // sys_script_client exists on every instance. Without it in the answer, the rows were hidden from this user (ACL),
        // not missing: then nothing is known, every table is asked, and one that cannot be read says so.
        return set.has('sys_script_client') ? set : null;
      })
      .catch(() => null);
  }
  return tableCheck;
}

/**
 * Names for the script ids, UI script file names and GlideAjax classes seen in the stacks. Only a row whose sys_id (or
 * name) is exactly one that was asked for is used, so a query the instance partly ignores can never attach a wrong name.
 * Also: page functions found by their source text (`functions`) and the UI policies a page embeds (`pages`); when a
 * caller passes neither (the AI tool asks with ids/names/classes only), they are worked out from what was collected.
 * -> { ids: {sysId: {table, kind, name, ...}}, names: {...}, classes: {...}, sources: {rid: {fn: record}},
 *      policies: {rid: [policy]}, notes: [...] }
 */
async function clientTraceResolve({ ids = [], names = [], classes = [], functions, pages } = {}) {
  const fixture = previewFixture();
  if (fixture) return fixture.resolved || { ids: {}, names: {}, classes: {}, sources: {}, policies: {}, notes: [] };
  if (functions === undefined && pages === undefined) {
    const own = collectRefs(buildRows(store.events));
    functions = own.functions;
    pages = own.pages;
  }
  // Validated and capped here as well as by the callers: ids come from page-provided stack text.
  const valid = (list, re, max, cache) => [...new Set((Array.isArray(list) ? list : []).filter((v) => typeof v === 'string' && re.test(v)))].filter((v) => !cache.has(v)).slice(0, max);
  const wantIds = valid(ids, SYS_ID_RE, MAX_LOOKUP.ids, resolvedCache.ids);
  const wantNames = valid(names, NAME_RE, MAX_LOOKUP.names, resolvedCache.names);
  const wantClasses = valid(classes, NAME_RE, MAX_LOOKUP.classes, resolvedCache.classes);
  let failed = false;
  const note = (text) => {
    failed = true;
    resolvedCache.notes.set(text, true);
  };

  // Base tables first, subclasses (catalog_*) after, so a catalog row replaces the same row read through its parent.
  const existing = wantIds.length ? await existingTables() : null;
  for (const spec of RESOLVE_TABLES) {
    if (!wantIds.length) break;
    if (existing && !existing.has(spec.table)) continue; // not on this instance: nothing to look up, nothing to report
    const fields = ['sys_id', ...spec.fields];
    const nameField = spec.nameField || 'name';
    for (let i = 0; i < wantIds.length; i += 50) {
      const chunk = wantIds.slice(i, i + 50);
      // eslint-disable-next-line no-await-in-loop -- sequential keeps the load on the instance low
      const rows = await lookup(spec.table, `sys_idIN${chunk.join(',')}`, fields, chunk.length, note);
      (rows || []).forEach((row) => {
        const id = String(row.sys_id || '').toLowerCase();
        if (!chunk.includes(id)) return;
        resolvedCache.ids.set(id, { table: spec.table, kind: spec.kind, name: String(row[nameField] || ''), type: row.type ? String(row.type) : '', field: row.field ? String(row.field) : '', tableName: row.table ? String(row.table) : '' });
      });
    }
  }

  // Looked up and not found: remember that, unless a lookup failed (then the id might still be there).
  if (!failed) wantIds.forEach((id) => resolvedCache.ids.has(id) || resolvedCache.ids.set(id, null));

  if (wantNames.length) {
    const rows = await lookup('sys_ui_script', `nameIN${wantNames.join(',')}`, ['sys_id', 'name'], 100, note);
    if (rows) {
      wantNames.forEach((n) => {
        const hit = rows.find((r) => r.name === n);
        if (hit) resolvedCache.names.set(n, { table: 'sys_ui_script', kind: 'UI script', name: n, sysId: String(hit.sys_id || '') });
        else resolvedCache.names.set(n, null);
      });
    }
  }

  if (wantClasses.length) {
    const bases = [...new Set(wantClasses.map((c) => c.split('.').pop()))];
    const rows = await lookup('sys_script_include', `nameIN${bases.join(',')}`, ['sys_id', 'name', 'api_name', 'client_callable'], 100, note);
    if (rows) {
      wantClasses.forEach((cls) => {
        const base = cls.split('.').pop();
        const hits = rows.filter((r) => r.name === base && (!cls.includes('.') || !r.api_name || r.api_name === cls));
        if (!hits.length) {
          resolvedCache.classes.set(cls, { found: false });
          return;
        }
        const callable = hits.map((h) => h.client_callable === 'true' || h.client_callable === true);
        resolvedCache.classes.set(cls, { found: true, sysId: String(hits[0].sys_id || ''), clientCallable: callable.every(Boolean) ? true : callable.some(Boolean) ? null : false });
      });
    }
  }

  const pendingPages = resolvePolicies(validRefs(pages, MAX_PAGE_REFS, false), note);
  const pendingFunctions = await resolveSources(validRefs(functions, MAX_FUNCTION_REFS, true), note);

  const out = { ids: {}, names: {}, classes: {}, sources: {}, policies: {}, pending: { functions: pendingFunctions, pages: pendingPages }, notes: [...resolvedCache.notes.keys()] };
  resolvedCache.sources.forEach((v, k) => {
    if (!v) return;
    const [rid, fn] = k.split('|');
    out.sources[rid] = out.sources[rid] || {};
    out.sources[rid][fn] = v;
  });
  resolvedCache.policies.forEach((v, rid) => {
    out.policies[rid] = v;
  });
  resolvedCache.ids.forEach((v, k) => {
    if (v) out.ids[k] = v;
  });
  resolvedCache.names.forEach((v, k) => {
    if (v) out.names[k] = v;
  });
  resolvedCache.classes.forEach((v, k) => {
    out.classes[k] = v;
  });
  return out;
}

export const clientTraceServices = {
  clientTraceStatus,
  clientTraceLoad,
  clientTraceArm,
  clientTraceDisarm,
  clientTraceClear,
  clientTraceResolve,
};

/** Called once from src/content/featureStartup.js when the top frame loads: say so if this page is being recorded. */
export function install({ toast, sidebar } = {}) {
  const until = readArm();
  if (!until) return;
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  toast?.info(`NowBuddy is recording this page (Client trace). It stops by itself in ${minutes} min.`, {
    timeout: 7000,
    action: { label: 'Open', onClick: () => sidebar?.openPanel?.('clienttrace') },
  });
}
