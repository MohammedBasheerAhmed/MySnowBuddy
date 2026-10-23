// Client trace, the recorder. This is the one part of NowBuddy that runs INSIDE the ServiceNow page's own JavaScript
// world (src/page/recorder.js loads it at document_start). A bug here can break a user's form, so the rules are strict:
//
//  - It does nothing unless the tab is armed (sessionStorage 'msb_trace_armed' holds an expiry time, set by the content
//    script when the user presses Arm). Not armed means: one DOM listener, one storage listener and one pageshow
//    listener (back/forward cache), nothing else.
//  - Every wrapper calls the ORIGINAL with the same `this` and arguments, returns its value and rethrows its exception.
//    All recording happens in try/catch; if recording itself throws, the original has still run (or runs anyway).
//  - It only watches. It never changes a value, never skips a call and never calls a mutating API. The only reads it
//    makes are g_form.hasField / getValue / getControl, to say what a call did.
//  - Everything is capped: ring buffer of events, text length, stack depth, argument count.
//  - Values of password-type fields and of anything named like password/secret/token/key are never stored, and neither
//    is any text that contains what a password input on the page currently holds (checked before an event is stored).
//
// Pure of the DOM and chrome.*: `createRecorder(win)` takes any window-like object, so tests/clienttrace.test.js drives
// it against fakes. The page entry (src/page/recorder.js) only calls boot().

export const ARM_KEY = 'msb_trace_armed';
export const REQUEST_EVENT = 'msb-trace-request';
export const RESPONSE_EVENT = 'msb-trace-response';
export const ARM_DURATION_MS = 30 * 60 * 1000;
export const LIMITS = Object.freeze({ events: 1500, text: 200, stack: 8, args: 8, params: 12, longTasks: 60 });

// Names whose VALUE is never recorded. "key" is deliberately broad: a wrongly hidden value costs a click, a leaked one costs more.
// pass / pin / otp only as a whole part of the name (u_pin, sysparm_pass), so "spinner" or "compass" stay visible.
const SECRET_NAME = /password|passwd|passphrase|pwd|secret|token|key|credential|authorization|bearer|sysparm_ck|g_ck|usertoken|cookie|session_?id|(?:^|[^a-z])(?:pass|passcode|pin|otp)(?:[^a-z]|$)/i;
// "password=...", "client_secret_value: ...", "Authorization: Bearer ...": the word may run on (password_hint=...).
const SECRET_INLINE = /((?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|authorization|sysparm_ck|g_ck|cookie|session_?id)[\w.-]*["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^"'\s&,;]+/gi;
// A credential in the middle of free text, whatever it is called: a JWT, or a "Bearer <token>" header value.
const SECRET_TOKEN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/;
const AUTH_HEADER = /^(?:bearer|basic)\s+\S{8,}$/i;
const SYS_ID = /^[0-9a-f]{32}$/i;
export const HIDDEN = '[hidden]';

export function isSecretName(name) {
  return typeof name === 'string' && SECRET_NAME.test(name);
}

/** A value that looks like a credential whatever it is called: a JWT, an auth header, a PEM block, a long opaque token. */
export function looksSecret(value) {
  if (typeof value !== 'string' || value.length < 20) return false;
  if (JWT.test(value) || AUTH_HEADER.test(value) || /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/.test(value)) return true;
  if (value.length >= 40 && value.length <= 400 && /^[A-Za-z0-9+/=_-]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value) && !SYS_ID.test(value)) return true;
  return false;
}

export function clip(text, max = LIMITS.text) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

/** Free text (a message, a URL query) with "password=...", "token: ..." style values and inline tokens blanked, and capped. */
export function scrub(text, max = LIMITS.text) {
  const s = String(text);
  if (looksSecret(s.trim())) return HIDDEN;
  // Only the start can be shown, so only the start is searched (a huge string costs no more than a short one). A value cut
  // in half by this is still matched and hidden; one that starts past the cut is not shown at all.
  const head = s.length > max * 4 + 400 ? s.slice(0, max * 4 + 400) : s;
  return clip(head.replace(SECRET_INLINE, `$1${HIDDEN}`).replace(SECRET_TOKEN, HIDDEN), max);
}

// Encoded query operators, longest first. Anything after a secret field that is not one of these is hidden with the value.
const QUERY_OP = /^(?:!=|<=|>=|=|<|>|NOT LIKE|NOTLIKE|LIKE|STARTSWITH|ENDSWITH|NOT IN|NOTIN|ISNOTEMPTY|ISEMPTY|IN|ANYTHING|EMPTYSTRING|BETWEEN|NSAMEAS|SAMEAS|VALCHANGES|CHANGESFROM|CHANGESTO)/;

/**
 * An encoded query ("active=true^u_api_key!=abc") with the value of every condition on a secret-named field hidden,
 * whatever the operator (=, !=, LIKE, STARTSWITH...). Column names are lower case and operators upper case or symbols,
 * which is how a condition is split. Text that is not a query comes back unchanged.
 */
export function scrubQuery(query) {
  const s = String(query);
  return s
    .split('^')
    .map((part) => {
      const m = /^(OR|NQ|ORDERBYDESC|ORDERBY|GROUPBY)?([a-z0-9_.]+)([\s\S]*)$/.exec(part);
      if (m && isSecretName(m[2])) {
        const op = QUERY_OP.exec(m[3]);
        const opText = op ? op[0] : '';
        return `${m[1] || ''}${m[2]}${opText}${m[3].length > opText.length ? HIDDEN : ''}`;
      }
      if (!m && isSecretName(part)) return HIDDEN;
      return part;
    })
    .join('^');
}

// ---- summaries: turn any page value into something small, plain and safe to copy across worlds -----------------------

function tagOf(value) {
  return Object.prototype.toString.call(value);
}

function ownData(obj, key) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d && 'value' in d ? d.value : undefined;
}

// Binary data and typed arrays: Object.keys on a 10-million-entry Uint8Array would freeze the page, so they get a label.
const BINARY_TAG = /^\[object (?:(?:Big)?(?:Int|Uint|Float)(?:8|16|32|64)(?:Clamped)?Array|ArrayBuffer|SharedArrayBuffer|DataView|Blob|File)\]$/;

function shallow(value, depth) {
  if (value === null || value === undefined) return 'null';
  const type = typeof value;
  if (type === 'string') return looksSecret(value) ? JSON.stringify(HIDDEN) : JSON.stringify(clip(value, 60));
  if (type === 'number' || type === 'boolean') return String(value);
  if (type === 'function') return '[function]';
  if (type !== 'object') return `[${type}]`;
  const tag = tagOf(value);
  if (value.nodeType === 1) return elementLabel(value);
  if (typeof value.nodeType === 'number') return '[node]';
  if (tag === '[object Date]') return '[date]';
  if (BINARY_TAG.test(tag)) return '[binary]';
  if (depth <= 0) return tag === '[object Array]' ? '[array]' : '[object]';
  if (tag === '[object Array]') {
    const items = [];
    for (let i = 0; i < value.length && i < 6; i += 1) items.push(shallow(ownData(value, String(i)), depth - 1));
    return `[${items.join(', ')}${value.length > 6 ? `, ...${value.length - 6} more` : ''}]`;
  }
  const all = Object.keys(value);
  const parts = [];
  for (let i = 0; i < all.length && i < 8; i += 1) {
    const k = all[i];
    parts.push(`${clip(k, 40)}: ${isSecretName(k) ? HIDDEN : shallow(ownData(value, k), depth - 1)}`);
  }
  return `{${parts.join(', ')}${all.length > 8 ? ', ...' : ''}}`;
}

function elementLabel(el) {
  const id = typeof el.id === 'string' && el.id ? `#${clip(el.id, 40)}` : '';
  return `<${String(el.tagName || 'node').toLowerCase()}${id}>`;
}

/** A primitive or a short string. Never throws, never calls a page function, never reads an accessor. */
export function summarize(value, max = LIMITS.text) {
  try {
    if (value === null || value === undefined) return null;
    switch (typeof value) {
      case 'boolean':
        return value;
      case 'number':
        return Number.isFinite(value) ? value : String(value);
      case 'string':
        return scrub(value, max);
      case 'function':
        return clip(`[function${value.name ? ` ${value.name}` : ''}]`, 80);
      case 'symbol':
      case 'bigint':
        return clip(String(value), max);
      default:
        break;
    }
    if (tagOf(value) === '[object Error]') return scrub(`${ownData(value, 'name') || value.name || 'Error'}: ${ownData(value, 'message') || value.message || ''}`, max);
    return scrub(shallow(value, 2), max);
  } catch {
    return '[unreadable]';
  }
}

function summarizeList(list, from = 0) {
  const out = [];
  for (let i = from; i < list.length && out.length < LIMITS.args; i += 1) out.push(summarize(list[i]));
  return out;
}

// ---- stack traces -----------------------------------------------------------------------------------------------

const V8_LINE = /^\s*at (?:async )?(?:new )?(?:(.*?) \((.*)\)|(.*))$/;
const FF_LINE = /^(.*?)@(.*)$/;
const LOC = /^(.*):(\d+):(\d+)$/;

function parseLocation(loc) {
  const text = String(loc || '').trim();
  const evalMatch = /^eval at .*?, (<anonymous>:\d+:\d+)$/.exec(text);
  const m = LOC.exec(evalMatch ? evalMatch[1] : text);
  if (!m) return { url: text && text !== '<anonymous>' ? text : '', line: 0, col: 0 };
  return { url: m[1] === '<anonymous>' ? '' : m[1], line: Number(m[2]), col: Number(m[3]) };
}

/** Raw frames, top of the stack first: { fn, url, line, col } with the url exactly as the engine printed it. */
function rawFrames(text) {
  const frames = [];
  const source = String(text || '');
  // A V8 stack has "    at ..." lines (its first line is the message); Firefox and Safari print "fn@url:line:col".
  const v8Format = /^\s*at /m.test(source);
  source
    .split('\n')
    .forEach((line) => {
      if (!line.trim()) return;
      let fn = '';
      let loc = '';
      if (v8Format) {
        const v8 = V8_LINE.exec(line);
        if (!v8 || !/^\s*at /.test(line)) return;
        if (v8[3] !== undefined && v8[1] === undefined) loc = v8[3];
        else {
          fn = v8[1] || '';
          loc = v8[2] || '';
        }
      } else {
        const ff = FF_LINE.exec(line.trim());
        if (!ff) return;
        fn = ff[1];
        loc = ff[2];
      }
      const where = parseLocation(loc);
      frames.push({ fn: fn === '<anonymous>' ? '' : fn, ...where });
    });
  return frames;
}

/** A url for display and matching: the path only (no query, which can hold ids and tokens), same-origin shortened. */
export function cleanUrl(url, origin = '') {
  let u = String(url || '');
  if (!u) return '';
  u = u.split(/[?#]/)[0];
  if (origin && u.startsWith(origin)) u = u.slice(origin.length) || '/';
  return clip(u, 160);
}

/**
 * Parse an Error.stack (V8 "at fn (url:line:col)" or Firefox/Safari "fn@url:line:col") into at most `maxFrames` frames,
 * nearest the call first: [{ fn, line, col, url? }]. Frames that belong to the recorder itself are dropped: those whose
 * url is `skipUrl` (the recorder's own file) and those whose function is named "msb...".
 */
export function parseStack(text, { skipUrl = '', origin = '', maxFrames = LIMITS.stack } = {}) {
  const out = [];
  rawFrames(text).forEach((f) => {
    if ((skipUrl && f.url === skipUrl) || /^(?:new |Object\.|Function\.|Array\.|Proxy\.)?msb[A-Z_]/.test(f.fn) || /^msb[A-Z_]/.test(f.fn.split('.').pop())) return;
    if (out.length >= maxFrames) return;
    const frame = { fn: clip(f.fn, 120), line: f.line, col: f.col };
    const url = cleanUrl(f.url, origin);
    if (url) frame.url = url;
    out.push(frame);
  });
  return out;
}

/** The url of the file this module was bundled into, as the engine prints it. '' when stacks are not available. */
export function ownScriptUrl(ErrorCtor = Error) {
  try {
    const frame = rawFrames(new ErrorCtor('x').stack)[0];
    return frame ? frame.url : '';
  } catch {
    return '';
  }
}

// ---- the ring buffer ----------------------------------------------------------------------------------------------

function createRing(cap) {
  let items = [];
  let dropped = 0;
  return {
    push(item) {
      items.push(item);
      if (items.length > cap) {
        items.shift();
        dropped += 1;
      }
    },
    since(seq) {
      return items.filter((e) => e.seq > seq);
    },
    all: () => items.slice(),
    clear() {
      items = [];
    },
    get size() {
      return items.length;
    },
    get dropped() {
      return dropped;
    },
    resetDropped() {
      dropped = 0;
    },
  };
}

// ---- what g_form can do ---------------------------------------------------------------------------------------------

// Methods whose first argument is a field name (ServiceNow silently ignores them for a field that is not on the form).
const GFORM_FIELD = ['setValue', 'clearValue', 'setMandatory', 'setReadOnly', 'setReadonly', 'setDisabled', 'setVisible', 'setDisplay', 'showFieldMsg', 'hideFieldMsg', 'addOption', 'removeOption', 'clearOptions', 'setLabelOf', 'showErrorBox', 'hideErrorBox'];
const GFORM_MESSAGE = ['addInfoMessage', 'addErrorMessage', 'addWarningMessage', 'clearMessages', 'hideAllFieldMsgs'];
const GFORM_FORM = ['save', 'submit', 'setSectionDisplay', 'hideRelatedList', 'showRelatedList', 'hideRelatedLists', 'showRelatedLists', 'disableAttachments', 'enableAttachments'];
// A form action may unload the page before the call returns, so it is written down before the call, not after.
const RECORD_BEFORE = new Set(['save', 'submit']);

const GLIDE_RECORD_METHODS = ['query', 'get', 'insert', 'update', 'deleteRecord'];
const AJAX_METHODS = ['getXML', 'getXMLWait', 'getXMLAnswer'];
const MODAL_FUNCTIONS = ['showFrame', 'confirm', 'alert', 'showFields'];

const ENDPOINT = /^\/(?:xmlhttp\.do|api\/|angular\.do)/;

export function isServiceNowHost(hostname) {
  return /(^|\.)service-now\.com$/i.test(String(hostname || ''));
}

const round1 = (n) => Math.round(n * 10) / 10;

function randomId(win) {
  try {
    const bytes = new Uint8Array(6);
    (win.crypto || globalThis.crypto).getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  }
}

/**
 * The recorder for one window (one per frame). Returns the control surface used by the transport and the tests:
 * start/stop, pull(since), status(), clear(), handle(action, args), attachTransport(), plus `events()` for tests.
 *
 * options (all optional, for tests): now(), epoch(), maxEvents, captureStack(), selfUrl, rid, frame, CustomEvent, pageMarkers,
 * setTimeout/clearTimeout/setInterval/clearInterval.
 */
export function createRecorder(win, options = {}) {
  const opts = options || {};
  const doc = win.document;
  const maxEvents = opts.maxEvents || LIMITS.events;
  const perfNow = opts.now || (() => (win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now()));
  const epochNow = opts.epoch || (() => Date.now());
  const timeOrigin = epochNow() - perfNow();
  const rid = opts.rid || randomId(win);
  const setTimer = opts.setTimeout || ((fn, ms) => win.setTimeout(fn, ms));
  const clearTimer = opts.clearTimeout || ((id) => win.clearTimeout(id));
  const setTicker = opts.setInterval || ((fn, ms) => win.setInterval(fn, ms));
  const clearTicker = opts.clearInterval || ((id) => win.clearInterval(id));
  const selfUrl = opts.selfUrl || '';
  const origin = (() => {
    try {
      return String(win.location.origin || '');
    } catch {
      return '';
    }
  })();
  const frame = opts.frame || (() => {
    try {
      // window.name can be megabytes (some pages use it as storage); it is copied into every event.
      return win.top === win ? 'top' : clip(String(win.name || 'frame'), 60);
    } catch {
      return 'frame';
    }
  })();

  const ring = createRing(maxEvents);
  const wrappers = new WeakSet();
  const ajaxInfo = new WeakMap();
  const busy = new WeakSet(); // objects (GlideAjax / GlideRecord instances) in the middle of a call we already record
  const seenObjects = new WeakSet();
  const xhrInfo = new WeakMap();
  const inflight = []; // calls that have started and not finished: gives nested calls their parent
  const restorers = [];
  const listeners = [];
  const timers = { expiry: 0, poll: 0 };
  let armed = false;
  let until = 0;
  let seq = 0;
  let idCounter = 0;
  let netDepth = 0; // > 0 while inside a GlideAjax / GlideRecord call, whose XHR is already described by that call
  let inConsole = false;
  let budgetStart = 0;
  let budgetCount = 0;
  let longTasks = 0;
  let observer = null;
  let transportOn = false;
  let capturing = false;
  const installed = {};
  // Our console / XHR / fetch wrappers still sit in the chain (Disarm could not take them out because a page script wrapped
  // on top of them). Re-arming then reuses them instead of wrapping a second time, which would record every call twice.
  const chained = { error: false, warn: false, xhr: false, fetch: false };

  // ---- stack capture ----------------------------------------------------------------------------------------------

  function msbCaptureStack() {
    // A page's own Error.prepareStackTrace runs inside `.stack`; if it calls a wrapped method, do not capture again.
    if (capturing) return [];
    capturing = true;
    const E = win.Error || Error;
    let text = '';
    let prev;
    try {
      prev = E.stackTraceLimit;
      if (typeof prev === 'number') E.stackTraceLimit = 30;
      text = new E('x').stack || '';
    } catch {
      text = '';
    } finally {
      try {
        if (typeof prev === 'number') E.stackTraceLimit = prev;
      } catch {
        /* frozen Error */
      }
      capturing = false;
    }
    return parseStack(typeof text === 'string' ? text : '', { skipUrl: selfUrl, origin });
  }

  // ---- values typed into password inputs --------------------------------------------------------------------------
  // A script can copy a password into a GlideAjax parameter, another field or a log line under an innocent name. Every
  // string about to be stored is checked against what the password inputs of this document hold at that moment (read in
  // this page, compared, never stored). Finding the inputs costs a document query (~40 us on a heavy form), so the list
  // of inputs is kept for up to a second (found again when a password input fires input/change, or after a g_form field
  // call); their VALUES are read fresh for every event, so a value a script has just set is still caught.

  let secretInputs = null;
  let secretAt = 0;

  function msbSecretValues() {
    const n = perfNow();
    if (!secretInputs || n - secretAt >= 1000) {
      secretInputs = [];
      try {
        const list = doc && typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll('input[type="password"]') : null;
        for (let i = 0; list && i < list.length && i < 20; i += 1) secretInputs.push(list[i]);
      } catch {
        /* none readable */
      }
      secretAt = n;
    }
    const found = [];
    for (let i = 0; i < secretInputs.length; i += 1) {
      try {
        const v = secretInputs[i].value;
        if (typeof v === 'string' && v.length >= 4) found.push(v);
      } catch {
        /* gone */
      }
    }
    return found;
  }

  function forgetSecrets() {
    secretInputs = null;
  }

  function onSecretInput(ev) {
    try {
      const t = ev && ev.target;
      if (t && String(t.type || '').toLowerCase() === 'password') forgetSecrets();
    } catch {
      /* not an input */
    }
  }

  /** `value` (our own summary: strings, numbers, small arrays and objects) with any string holding a secret replaced. */
  function msbRedactKnown(value, secrets, hit, depth) {
    if (typeof value === 'string') {
      for (let i = 0; i < secrets.length; i += 1) {
        if (value.includes(secrets[i])) {
          hit.found = true;
          return HIDDEN;
        }
      }
      return value;
    }
    if (!value || typeof value !== 'object' || depth > 3) return value;
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i += 1) out.push(msbRedactKnown(value[i], secrets, hit, depth + 1));
      return out;
    }
    const out = {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i += 1) out[keys[i]] = msbRedactKnown(value[keys[i]], secrets, hit, depth + 1);
    return out;
  }

  // A script that records thousands of events in a loop must not be slowed by stack capture for each one.
  function msbTakeStack() {
    const n = perfNow();
    if (n - budgetStart > 1000) {
      budgetStart = n;
      budgetCount = 0;
    }
    budgetCount += 1;
    if (budgetCount > 300) return [];
    try {
      return (opts.captureStack || msbCaptureStack)();
    } catch {
      return [];
    }
  }

  // ---- events ----------------------------------------------------------------------------------------------------

  /** Begin an event. Nothing is stored until msbPush(). `id` is its identity; `seq` is assigned when it is stored. */
  function msbBegin(kind, name, data = {}) {
    const parent = inflight.length ? inflight[inflight.length - 1] : null;
    const t = typeof data.t === 'number' ? data.t : perfNow();
    return {
      id: (idCounter += 1),
      t0: t,
      kind,
      name: clip(name, 100),
      field: data.field,
      args: data.args,
      flags: data.flags ? { ...data.flags } : {},
      parent: parent ? parent.id : undefined,
      depth: inflight.length,
      stack: data.noStack ? [] : msbTakeStack(),
      before: data.before,
    };
  }

  function msbPush(call, extra = {}) {
    if (!armed) return null;
    seq += 1;
    const event = { seq, id: call.id, t: round1(call.t0), at: Math.round(timeOrigin + call.t0), kind: call.kind, name: call.name, frame };
    if (call.field !== undefined) event.field = call.field;
    if (call.args !== undefined) event.args = call.args;
    if (extra.result !== undefined) event.result = extra.result;
    if (extra.durationMs !== undefined) event.durationMs = round1(extra.durationMs);
    if (call.parent !== undefined) event.parent = call.parent;
    if (call.depth) event.depth = call.depth;
    if (extra.phase) event.phase = extra.phase;
    if (extra.ref !== undefined) event.ref = extra.ref;
    const flags = { ...call.flags, ...(extra.flags || {}) };
    let secrets = [];
    try {
      secrets = msbSecretValues();
    } catch {
      secrets = [];
    }
    if (secrets.length) {
      const hit = { found: false };
      if (event.args !== undefined) event.args = msbRedactKnown(event.args, secrets, hit, 0);
      if (event.result !== undefined) event.result = msbRedactKnown(event.result, secrets, hit, 0);
      if (hit.found) flags.hidden = true;
    }
    if (Object.keys(flags).length) event.flags = flags;
    event.stack = extra.stack !== undefined ? extra.stack : call.stack;
    ring.push(event);
    return event;
  }

  /** The second event of a call that finished later (an async callback fired): its own time, linked back by `ref`. */
  function msbPushEnd(call, extra = {}) {
    const t = perfNow();
    return msbPush({ ...call, id: (idCounter += 1), t0: t, args: undefined, field: undefined, parent: undefined, depth: 0, flags: {} }, { ...extra, phase: 'end', ref: call.id, durationMs: t - call.t0, stack: [] });
  }

  /** A one-line event with no duration or children (a log line, a page marker). */
  function msbNote(kind, name, data = {}, extra = {}) {
    try {
      if (!armed) return null;
      return msbPush(msbBegin(kind, name, data), extra);
    } catch {
      return null;
    }
  }

  function enter(call) {
    inflight.push(call);
  }

  function leave(call) {
    const i = inflight.lastIndexOf(call);
    if (i >= 0) inflight.splice(i, 1);
  }

  // ---- wrapping helper --------------------------------------------------------------------------------------------

  /** Replace obj[name] (own or inherited) with build(original). True when something was wrapped. Never throws. */
  function wrapMethod(target, name, build) {
    try {
      if (!target || (typeof target !== 'object' && typeof target !== 'function')) return false;
      let owner = target;
      while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
      if (!owner || owner === Object.prototype || owner === Function.prototype) return false;
      const desc = Object.getOwnPropertyDescriptor(owner, name);
      if (!desc || typeof desc.value !== 'function') return false;
      if (desc.writable === false && desc.configurable === false) return false;
      const orig = desc.value;
      if (wrappers.has(orig)) return false;
      const wrapper = build(orig);
      wrappers.add(wrapper);
      try {
        Object.defineProperty(wrapper, 'toString', { value: () => Function.prototype.toString.call(orig), configurable: true, writable: true });
        // Same arity as the original, for code that looks at fn.length. (The name stays msb...: stack frames are told apart by it.)
        Object.defineProperty(wrapper, 'length', { value: typeof orig.length === 'number' ? orig.length : 0, configurable: true });
      } catch {
        /* cosmetic */
      }
      Object.defineProperty(owner, name, { value: wrapper, writable: desc.writable !== false, enumerable: desc.enumerable, configurable: desc.configurable });
      return true;
    } catch {
      return false;
    }
  }

  function wrapAll(target, names, builder) {
    let count = 0;
    names.forEach((n) => {
      if (wrapMethod(target, n, (orig) => builder(n, orig))) count += 1;
    });
    return count;
  }

  // ---- g_form -----------------------------------------------------------------------------------------------------

  function fieldIsSecret(g, field) {
    if (isSecretName(field)) return true;
    try {
      if (typeof g.getControl === 'function') {
        const control = g.getControl(field);
        if (control && String(control.type || '').toLowerCase() === 'password') return true;
      }
    } catch {
      /* no control */
    }
    try {
      if (typeof g.getGlideUIElement === 'function') {
        const element = g.getGlideUIElement(field);
        if (element && /password/i.test(String(element.type || ''))) return true;
      }
    } catch {
      /* no element */
    }
    return false;
  }

  /** The field's value as g_form gives it (undefined when it cannot be read). Compared raw, stored only summarized. */
  function readValue(g, field) {
    try {
      if (typeof g.getValue === 'function') return g.getValue(field);
    } catch {
      /* not readable */
    }
    return undefined;
  }

  function sameCall(a, b) {
    return a && b && a.kind === b.kind && a.name === b.name && a.field === b.field && JSON.stringify(a.args) === JSON.stringify(b.args);
  }

  function gformBuilder(kind) {
    return (name, orig) =>
      function msbGForm() {
        if (!armed) return orig.apply(this, arguments);
        const self = this;
        let call = null;
        try {
          call = msbStartGForm(self, kind, name, arguments);
        } catch {
          call = null;
        }
        if (!call) return orig.apply(self, arguments);
        let result;
        let error;
        let threw = false;
        try {
          result = orig.apply(self, arguments);
        } catch (e) {
          threw = true;
          error = e;
        }
        try {
          finishGForm(call, self, name, threw, error);
        } catch {
          leave(call);
        }
        if (threw) throw error;
        return result;
      };
  }

  function msbStartGForm(g, kind, name, args) {
    const data = { flags: {} };
    let secret = false;
    if (kind === 'field') {
      const field = typeof args[0] === 'string' ? clip(args[0], 80) : args[0] === undefined ? undefined : summarize(args[0], 80);
      data.field = field;
      if (typeof args[0] === 'string' && args[0]) {
        let has;
        try {
          has = typeof g.hasField === 'function' ? g.hasField(args[0]) : undefined;
        } catch {
          has = undefined;
        }
        if (has === false) data.flags.unknownField = true;
        secret = fieldIsSecret(g, args[0]);
        if (!secret && !data.flags.unknownField && (name === 'setValue' || name === 'clearValue')) {
          data.before = readValue(g, args[0]);
          data.fieldName = args[0];
        }
      }
      data.args = secret ? [HIDDEN] : summarizeList(args, 1);
      if (secret) data.flags.hidden = true;
    } else {
      data.args = summarizeList(args, 0);
    }
    const call = msbBegin(kind, `g_form.${name}`, data);
    call.secret = secret;
    call.fieldName = data.fieldName;
    // The platform calling itself (setValue → its own helper with the same arguments) is not a second change.
    const parent = inflight.length ? inflight[inflight.length - 1] : null;
    if (parent && sameCall(parent, call)) return null;
    if (RECORD_BEFORE.has(name)) msbPush(call);
    enter(call);
    return call;
  }

  function finishGForm(call, g, name, threw, error) {
    leave(call);
    forgetSecrets(); // the call may have changed a password field
    const extra = { durationMs: perfNow() - call.t0 };
    if (threw) extra.flags = { threw: true };
    if (threw) extra.result = { error: summarize(error, 160) };
    if (!call.secret && typeof call.fieldName === 'string' && (name === 'setValue' || name === 'clearValue') && !call.flags.unknownField) {
      const after = readValue(g, call.fieldName);
      // Compared raw: two values that summarize alike ("token: [hidden]") can still differ. Unreadable means unknown.
      const known = call.before !== undefined && after !== undefined;
      const said = {};
      if (call.before !== undefined) said.before = summarize(call.before);
      if (after !== undefined) said.after = summarize(after);
      if (known) said.changed = call.before !== after;
      extra.result = { ...(extra.result || {}), ...said };
    }
    if (RECORD_BEFORE.has(name)) {
      // Already stored before the call; only a failure is worth a second line.
      if (threw) msbPush({ ...call, id: ++idCounter, stack: [] }, { ...extra, phase: 'end', ref: call.id });
      return;
    }
    msbPush(call, extra);
  }

  function installGForm(g) {
    if (!g || typeof g !== 'object') return;
    const count = wrapAll(g, GFORM_FIELD, gformBuilder('field')) + wrapAll(g, GFORM_MESSAGE, gformBuilder('message')) + wrapAll(g, GFORM_FORM, gformBuilder('form'));
    if (count || installed.g_form === undefined) installed.g_form = count > 0;
  }

  // ---- GlideAjax ----------------------------------------------------------------------------------------------------

  function paramValue(name, value) {
    if (isSecretName(name)) return HIDDEN;
    return summarize(value, 120);
  }

  function ajaxDescribe(self) {
    const info = ajaxInfo.get(self) || { cls: '', method: '', params: {} };
    let cls = info.cls;
    let method = info.method;
    const params = { ...info.params };
    try {
      if (!cls && typeof self.processor === 'string') cls = self.processor;
      const live = self.params;
      if (live && typeof live === 'object' && !Array.isArray(live)) {
        Object.keys(live).slice(0, LIMITS.params).forEach((k) => {
          if (!(k in params)) params[k] = paramValue(k, ownData(live, k));
        });
        if (!method && typeof ownData(live, 'sysparm_name') === 'string') method = ownData(live, 'sysparm_name');
      }
    } catch {
      /* use what we captured */
    }
    delete params.sysparm_processor;
    delete params.sysparm_name;
    delete params.sysparm_ck;
    return { cls: clip(cls || '', 80), method: clip(method || '', 80), params };
  }

  function answerOf(response) {
    try {
      // An answer can be JSON with a "token" or "password" in it: scrubbed like any other text.
      if (typeof response === 'string') return { answer: summarize(response, 120) };
      if (!response || typeof response !== 'object') return {};
      const out = {};
      if (typeof response.status === 'number') out.status = response.status;
      const xml = response.responseXML;
      const root = xml && xml.documentElement;
      const answer = root && typeof root.getAttribute === 'function' ? root.getAttribute('answer') : null;
      if (answer !== null && answer !== undefined) out.answer = summarize(String(answer), 120);
      return out;
    } catch {
      return {};
    }
  }

  function asyncBuilder(kind, label, describe) {
    // For calls that take a callback (GlideAjax.getXML / getXMLAnswer, GlideRecord.query(cb)...): one event when the call
    // is made, one more when the callback fires. A call with no callback (GlideRecord.query()) is synchronous and blocks.
    return (name, orig) =>
      function msbAsync() {
        if (!armed || busy.has(this)) return orig.apply(this, arguments);
        const self = this;
        let args = arguments;
        let call = null;
        try {
          const d = describe(self, name, arguments);
          call = msbBegin(kind, `${label}.${name}`, { field: d.field, args: d.args, flags: d.sync ? { blocking: true } : {} });
          call.sync = d.sync;
          if (!d.sync) {
            const index = d.callbackIndex;
            if (index >= 0) {
              const cb = arguments[index];
              const copy = Array.prototype.slice.call(arguments);
              copy[index] = function msbCallback() {
                try {
                  if (armed) {
                    const first = arguments[0];
                    msbPushEnd(call, { result: answerOf(first), flags: first && typeof first === 'object' && typeof first.status === 'number' && first.status >= 400 ? { failed: true } : undefined });
                  }
                } catch {
                  /* recording must not stop the callback */
                }
                return cb.apply(this, arguments);
              };
              wrappers.add(copy[index]);
              args = copy;
            }
          }
          busy.add(self); // throws for a primitive `this`: then nothing below has run yet
          enter(call);
          netDepth += 1;
        } catch {
          call = null;
        }
        if (!call) return orig.apply(self, arguments);
        let result;
        let error;
        let threw = false;
        try {
          result = orig.apply(self, args);
        } catch (e) {
          threw = true;
          error = e;
        }
        try {
          busy.delete(self);
          netDepth -= 1;
          leave(call);
          const extra = {};
          if (call.sync || threw) extra.durationMs = perfNow() - call.t0;
          if (threw) {
            extra.flags = { threw: true };
            extra.result = { error: summarize(error, 160) };
          }
          msbPush(call, call.sync ? extra : { ...extra, phase: 'start' });
        } catch {
          /* not recorded */
        }
        if (threw) throw error;
        return result;
      };
  }

  function describeAjax(self, name, args) {
    const info = ajaxDescribe(self);
    const index = typeof args[0] === 'function' ? 0 : typeof args[1] === 'function' ? 1 : -1;
    return { field: undefined, args: [info.cls, info.method, info.params], sync: name === 'getXMLWait', callbackIndex: index };
  }

  function installGlideAjax(GA) {
    const proto = GA && GA.prototype;
    if (!proto) return;
    let count = 0;
    count += wrapMethod(proto, 'initialize', (orig) =>
      function msbAjaxInit() {
        try {
          if (armed) ajaxInfo.set(this, { cls: typeof arguments[0] === 'string' ? arguments[0] : '', method: '', params: {} });
        } catch {
          /* no info */
        }
        return orig.apply(this, arguments);
      }
    )
      ? 1
      : 0;
    count += wrapMethod(proto, 'addParam', (orig) =>
      function msbAjaxParam(pname, pvalue) {
        try {
          if (armed && typeof pname === 'string') {
            const info = ajaxInfo.get(this) || { cls: '', method: '', params: {} };
            if (pname === 'sysparm_name') info.method = typeof pvalue === 'string' ? pvalue : '';
            else if (pname === 'sysparm_processor') info.cls = info.cls || (typeof pvalue === 'string' ? pvalue : '');
            else if (Object.keys(info.params).length < LIMITS.params && pname !== 'sysparm_ck') info.params[clip(pname, 60)] = paramValue(pname, pvalue);
            ajaxInfo.set(this, info);
          }
        } catch {
          /* no info */
        }
        return orig.apply(this, arguments);
      }
    )
      ? 1
      : 0;
    count += wrapAll(proto, AJAX_METHODS, asyncBuilder('ajax', 'GlideAjax', describeAjax));
    installed.GlideAjax = count > 0;
  }

  // ---- client-side GlideRecord ------------------------------------------------------------------------------------

  function describeGlideRecord(self, name, args) {
    let table = '';
    let query = '';
    try {
      table = typeof self.tableName === 'string' ? self.tableName : typeof self.getTableName === 'function' ? String(self.getTableName() || '') : '';
      if (name === 'query' && typeof self.getEncodedQuery === 'function') query = String(self.getEncodedQuery() || '');
    } catch {
      /* unknown table */
    }
    const index = Array.prototype.findIndex.call(args, (a) => typeof a === 'function');
    const list = [clip(table, 80)];
    if (query) list.push(scrub(scrubQuery(clip(query, 1000)), 160));
    if (name === 'get') {
      const first = args[0];
      if (typeof first === 'string' && args.length > 1 && typeof args[1] !== 'function') list.push(isSecretName(first) ? `${clip(first, 40)}=${HIDDEN}` : `${clip(first, 40)}=${summarize(args[1], 60)}`);
      else if (typeof first === 'string') list.push(summarize(first, 80));
    }
    return { field: undefined, args: list, sync: index < 0, callbackIndex: index };
  }

  function installGlideRecord(GR) {
    const proto = GR && GR.prototype;
    if (!proto) return;
    installed.GlideRecord = wrapAll(proto, GLIDE_RECORD_METHODS, asyncBuilder('glide', 'GlideRecord', describeGlideRecord)) > 0;
  }

  // ---- modals ---------------------------------------------------------------------------------------------------------

  function modalBuilder(label) {
    return (name, orig) =>
      function msbModal() {
        if (!armed) return orig.apply(this, arguments);
        try {
          let title = '';
          const first = arguments[0];
          if (first && typeof first === 'object') {
            title = [ownData(first, 'title'), ownData(first, 'url'), ownData(first, 'message'), ownData(first, 'body')].filter((v) => typeof v === 'string' && v)[0] || '';
          } else if (typeof first === 'string') title = first;
          if (!title) {
            const me = this;
            title = [me && me.title, me && me.id, me && me.windowName, me && me.name].filter((v) => typeof v === 'string' && v)[0] || '';
          }
          msbNote('modal', `${label}.${name}`, { args: title ? [scrub(title, 120)] : [] });
        } catch {
          /* not recorded */
        }
        return orig.apply(this, arguments);
      };
  }

  function installModal(label, target, names) {
    const holder = typeof target === 'function' ? target.prototype : target;
    if (!holder) return;
    installed[label] = wrapAll(holder, names, modalBuilder(label)) > 0;
  }

  // ---- jslog ----------------------------------------------------------------------------------------------------------

  function installJslog() {
    wrapMethod(win, 'jslog', (orig) =>
      function msbJslog(message) {
        try {
          if (armed) msbNote('log', 'jslog', { args: [scrub(message === undefined ? '' : summarize(message, 300), 200)] });
        } catch {
          /* not recorded */
        }
        return orig.apply(this, arguments);
      }
    );
  }

  // ---- console, errors, network --------------------------------------------------------------------------------------

  function installConsole() {
    const c = win.console;
    if (!c) return;
    ['error', 'warn'].forEach((level) => {
      if (chained[level]) return; // still wrapped from an earlier arm
      const orig = c[level];
      if (typeof orig !== 'function' || wrappers.has(orig)) return;
      const wrapper = function msbConsole() {
        if (armed && !inConsole) {
          inConsole = true;
          try {
            msbNote('console', `console.${level}`, { args: summarizeList(arguments, 0).slice(0, 4).map((a) => (typeof a === 'string' ? scrub(a, 200) : a)) });
          } catch {
            /* not recorded */
          } finally {
            inConsole = false;
          }
        }
        return orig.apply(this, arguments);
      };
      wrappers.add(wrapper);
      try {
        c[level] = wrapper;
        if (c[level] !== wrapper) return; // a frozen console ignores the assignment
        chained[level] = true;
        restorers.push(() => {
          if (c[level] === wrapper) {
            c[level] = orig;
            chained[level] = false;
          }
        });
      } catch {
        /* console is read-only here */
      }
    });
    installed.console = chained.error || chained.warn;
  }

  function frameFromError(error, filename, line, col) {
    let frames = [];
    try {
      const stack = error && typeof error === 'object' ? ownData(error, 'stack') || error.stack : '';
      if (typeof stack === 'string') frames = parseStack(stack, { skipUrl: selfUrl, origin });
    } catch {
      frames = [];
    }
    if (!frames.length && (filename || line)) {
      const f = { fn: '', line: Number(line) || 0, col: Number(col) || 0 };
      const url = cleanUrl(filename, origin);
      if (url) f.url = url;
      frames = [f];
    }
    return frames;
  }

  function onWindowError(ev) {
    try {
      if (!armed || !ev || ev.target !== win) return;
      if (typeof ev.message !== 'string' && !ev.error) return;
      const error = ev.error;
      const name = error && typeof error === 'object' && typeof error.name === 'string' ? error.name : 'Error';
      const call = msbBegin('error', name, { args: [scrub(ev.message || (error && error.message) || '', 300)], noStack: true });
      call.stack = frameFromError(error, ev.filename, ev.lineno, ev.colno);
      msbPush(call, { flags: { exception: true } });
    } catch {
      /* not recorded */
    }
  }

  function onRejection(ev) {
    try {
      if (!armed || !ev) return;
      const reason = ev.reason;
      const isError = reason && typeof reason === 'object';
      const message = isError ? `${reason.name || 'Error'}: ${reason.message || ''}` : String(reason);
      const call = msbBegin('error', 'Unhandled promise rejection', { args: [scrub(message, 300)], noStack: true });
      call.stack = frameFromError(reason, '', 0, 0);
      msbPush(call, { flags: { exception: true } });
    } catch {
      /* not recorded */
    }
  }

  function describeUrl(raw) {
    try {
      const u = new win.URL(String(raw), win.location.href);
      if (u.origin !== origin) return null;
      const path = u.pathname;
      if (!ENDPOINT.test(path)) return null;
      const decode = (text) => {
        try {
          return decodeURIComponent(text.replace(/\+/g, ' '));
        } catch {
          return text;
        }
      };
      const query = u.search ? u.search.slice(1, 4000).split('&').slice(0, 40).map((pair) => {
        const eq = pair.indexOf('=');
        const key = eq < 0 ? pair : pair.slice(0, eq);
        const value = eq < 0 ? '' : decode(pair.slice(eq + 1));
        if (isSecretName(decode(key)) || looksSecret(value)) return `${key}=${HIDDEN}`;
        // Checked decoded, so "sysparm_query=u_password%3Dabc" is caught too; shown decoded only when something was hidden.
        const clean = scrub(scrubQuery(value), 400);
        return clean !== value && clean.includes(HIDDEN) ? `${key}=${clean}` : pair;
      }).join('&') : '';
      return { path: clip(path, 120), query: query ? scrub(query, 200) : '' };
    } catch {
      return null;
    }
  }

  function xhrLabel(method, info, body) {
    if (info.path.startsWith('/xmlhttp.do') && typeof body === 'string') {
      const m = /(?:^|&)sysparm_processor=([^&]*)/.exec(body);
      const n = /(?:^|&)sysparm_name=([^&]*)/.exec(body);
      try {
        if (m) return `${method} ${info.path} ${clip(decodeURIComponent(m[1]), 60)}${n ? `.${clip(decodeURIComponent(n[1]), 60)}` : ''}`;
      } catch {
        /* keep the path */
      }
    }
    return `${method} ${info.path}`;
  }

  function finishNetwork(rec, status, errorText) {
    try {
      // A request the page cancelled itself (type-ahead, navigation) is not a failure.
      const failed = !rec.aborted && (!status || status >= 400);
      msbPush(rec.call, { durationMs: perfNow() - rec.call.t0, result: { status: status || 0, ...(rec.aborted ? { aborted: true } : {}), ...(errorText ? { error: errorText } : {}) }, flags: failed ? { failed: true } : undefined });
    } catch {
      /* not recorded */
    }
  }

  function installXhr() {
    if (chained.xhr) return; // still wrapped from an earlier arm
    const XP = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    if (!XP || typeof XP.open !== 'function' || typeof XP.send !== 'function' || wrappers.has(XP.open)) return;
    const origOpen = XP.open;
    const origSend = XP.send;
    const open = function msbXhrOpen(method, url) {
      try {
        if (armed) xhrInfo.set(this, { method: String(method || 'GET').toUpperCase(), url: String(url), sync: arguments.length >= 3 && arguments[2] === false });
      } catch {
        /* not recorded */
      }
      return origOpen.apply(this, arguments);
    };
    const send = function msbXhrSend(body) {
      if (!armed || netDepth > 0) return origSend.apply(this, arguments);
      const xhr = this;
      let rec = null;
      try {
        const meta = xhrInfo.get(xhr);
        const info = meta && describeUrl(meta.url);
        if (info) {
          const call = msbBegin('network', xhrLabel(meta.method, info, body), { args: info.query ? [info.query] : [], flags: meta.sync ? { blocking: true } : {} });
          rec = { call, sync: meta.sync };
          if (!meta.sync) {
            xhr.addEventListener('abort', () => {
              rec.aborted = true;
            });
            xhr.addEventListener('loadend', () => finishNetwork(rec, xhr.status));
          }
        }
      } catch {
        rec = null;
      }
      if (!rec) return origSend.apply(this, arguments);
      let result;
      let error;
      let threw = false;
      try {
        result = origSend.apply(this, arguments);
      } catch (e) {
        threw = true;
        error = e;
      }
      try {
        if (rec.sync || threw) finishNetwork(rec, threw ? 0 : xhr.status, threw ? summarize(error, 100) : '');
      } catch {
        /* not recorded */
      }
      if (threw) throw error;
      return result;
    };
    wrappers.add(open);
    wrappers.add(send);
    XP.open = open;
    XP.send = send;
    if (XP.open !== open || XP.send !== send) {
      // Could not take both places (a read-only prototype): put back whatever was taken and record no requests.
      if (XP.open === open) XP.open = origOpen;
      if (XP.send === send) XP.send = origSend;
      return;
    }
    chained.xhr = true;
    restorers.push(() => {
      // Both back, or neither: with a page wrapper on top of one of them, ours stay and only pass through while disarmed.
      if (XP.open === open && XP.send === send) {
        XP.open = origOpen;
        XP.send = origSend;
        chained.xhr = false;
      }
    });
    installed.xhr = true;
  }

  function installFetch() {
    if (chained.fetch) return; // still wrapped from an earlier arm
    const orig = win.fetch;
    if (typeof orig !== 'function' || wrappers.has(orig)) return;
    const wrapper = function msbFetch(input, init) {
      if (!armed || netDepth > 0) return orig.apply(this, arguments);
      let rec = null;
      try {
        const raw = input && typeof input === 'object' && typeof input.url === 'string' ? input.url : input;
        const info = describeUrl(raw);
        const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
        if (info) rec = { call: msbBegin('network', `fetch ${method} ${info.path}`, { args: info.query ? [info.query] : [] }) };
      } catch {
        rec = null;
      }
      const promise = orig.apply(this, arguments);
      if (!rec || !promise || typeof promise.then !== 'function') return promise;
      return promise.then(
        (response) => {
          finishNetwork(rec, response && response.status);
          return response;
        },
        (error) => {
          try {
            if (error && typeof error === 'object' && error.name === 'AbortError') rec.aborted = true;
          } catch {
            /* unreadable error */
          }
          finishNetwork(rec, 0, summarize(error, 100));
          throw error;
        }
      );
    };
    wrappers.add(wrapper);
    win.fetch = wrapper;
    if (win.fetch !== wrapper) return;
    chained.fetch = true;
    restorers.push(() => {
      if (win.fetch === wrapper) {
        win.fetch = orig;
        chained.fetch = false;
      }
    });
    installed.fetch = true;
  }

  function installPerformance() {
    try {
      const PO = win.PerformanceObserver;
      if (typeof PO !== 'function') return;
      observer = new PO((list) => {
        try {
          list.getEntries().forEach((entry) => {
            if (!armed || entry.duration < 100 || longTasks >= LIMITS.longTasks) return;
            longTasks += 1;
            msbNote('longtask', 'Long task', { t: entry.startTime, noStack: true }, { durationMs: entry.duration });
          });
        } catch {
          /* not recorded */
        }
      });
      // Only while the page is still loading are earlier tasks part of what is being recorded; armed later, they are not.
      observer.observe({ type: 'longtask', buffered: Boolean(doc) && doc.readyState === 'loading' });
      installed.longtask = true;
    } catch {
      observer = null;
    }
  }

  function pageMarkers() {
    try {
      const path = cleanUrl(win.location.href, origin) || '/';
      const state = doc && doc.readyState;
      msbNote('page', state === 'loading' ? 'page load started' : 'recording started', { args: [path, state || ''], noStack: true });
      const mark = (label) => () => msbNote('page', label, { noStack: true });
      if (state === 'loading') {
        on(doc, 'DOMContentLoaded', mark('DOMContentLoaded'));
        on(win, 'load', mark('load'));
      } else if (state === 'interactive') on(win, 'load', mark('load'));
    } catch {
      /* no markers */
    }
  }

  // ---- late globals ---------------------------------------------------------------------------------------------------
  // g_form, GlideAjax and friends are defined while the page loads. Each one is hooked the moment it appears: a property
  // trap on the window catches the assignment itself, a bounded poll catches anything the trap cannot (a function
  // declaration replaces the trap, a non-configurable property cannot have one). The trap turns itself back into a plain
  // data property on the first assignment.

  const GLOBALS = {
    g_form: (v) => installGForm(v),
    GlideAjax: (v) => installGlideAjax(v),
    GlideRecord: (v) => installGlideRecord(v),
    GlideModal: (v) => installModal('GlideModal', v, ['render']),
    GlideDialogWindow: (v) => installModal('GlideDialogWindow', v, ['render']),
    g_modal: (v) => installModal('g_modal', v, MODAL_FUNCTIONS),
  };

  function present(name) {
    try {
      const v = win[name];
      return v !== undefined && v !== null ? v : undefined;
    } catch {
      return undefined;
    }
  }

  function hook(name, value) {
    try {
      if (!armed || value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
      // Once per object: a new g_form assigned later is a new object and is hooked too.
      if (seenObjects.has(value)) return;
      seenObjects.add(value);
      GLOBALS[name](value);
    } catch {
      /* a failed hook leaves the page untouched */
    }
  }

  function trap(name) {
    try {
      const desc = Object.getOwnPropertyDescriptor(win, name);
      if (desc && (!desc.configurable || desc.get || desc.set)) return;
      let stored = desc ? desc.value : undefined;
      const enumerable = desc ? desc.enumerable : true;
      Object.defineProperty(win, name, {
        configurable: true,
        enumerable,
        get() {
          return stored;
        },
        set(v) {
          stored = v;
          try {
            // Back to a plain property: the page sees the same thing it would have without us.
            Object.defineProperty(win, name, { value: v, writable: true, enumerable, configurable: true });
          } catch {
            /* keep the accessor */
          }
          hook(name, v);
        },
      });
      restorers.push(() => {
        const now = Object.getOwnPropertyDescriptor(win, name);
        if (!now || !now.set || !now.configurable) return;
        // A global that did not exist and was never assigned goes away again, so `name in window` is false as before.
        if (!desc && stored === undefined) delete win[name];
        else Object.defineProperty(win, name, { value: stored, writable: true, enumerable, configurable: true });
      });
    } catch {
      /* the poll covers it */
    }
  }

  function scanGlobals() {
    Object.keys(GLOBALS).forEach((name) => {
      const v = present(name);
      if (v !== undefined) hook(name, v);
    });
    const jslog = present('jslog');
    if (typeof jslog === 'function' && !wrappers.has(jslog)) installJslog();
  }

  function startWatching() {
    scanGlobals();
    Object.keys(GLOBALS).forEach((name) => {
      if (present(name) === undefined) trap(name);
    });
    // Bounded: 40 looks 25 ms apart (the first second of the load), then one every 250 ms until a minute is up.
    let ticks = 0;
    const tick = () => {
      ticks += 1;
      scanGlobals();
      if (ticks === 40) {
        clearTicker(timers.poll);
        timers.poll = setTicker(tick, 250);
      } else if (ticks >= 40 + 4 * 59) {
        clearTicker(timers.poll);
        timers.poll = 0;
      }
    };
    timers.poll = setTicker(tick, 25);
  }

  // ---- listeners ------------------------------------------------------------------------------------------------------

  function on(target, type, fn, capture) {
    try {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, fn, capture);
      listeners.push(() => target.removeEventListener(type, fn, capture));
    } catch {
      /* not listening */
    }
  }

  // ---- arming ---------------------------------------------------------------------------------------------------------

  function readArmFlag() {
    try {
      const raw = win.sessionStorage.getItem(ARM_KEY);
      if (raw === null || raw === undefined) return 0;
      const n = Number(raw);
      if (Number.isFinite(n) && n > epochNow()) return Math.min(n, epochNow() + ARM_DURATION_MS + 60000);
      win.sessionStorage.removeItem(ARM_KEY);
    } catch {
      /* storage unavailable: not armed */
    }
    return 0;
  }

  function start(untilMs) {
    try {
      const target = Math.min(Number(untilMs) || epochNow() + ARM_DURATION_MS, epochNow() + ARM_DURATION_MS + 60000);
      until = target;
      clearTimer(timers.expiry);
      timers.expiry = setTimer(() => {
        stop();
        try {
          win.sessionStorage.removeItem(ARM_KEY);
        } catch {
          /* nothing to clear */
        }
      }, Math.max(1000, target - epochNow()));
      if (armed) return;
      armed = true;
      on(win, 'error', onWindowError, true);
      on(win, 'unhandledrejection', onRejection);
      on(doc, 'input', onSecretInput, true);
      on(doc, 'change', onSecretInput, true);
      forgetSecrets();
      // Each part on its own: one that fails (a read-only prototype in strict code, say) does not stop the others.
      [installConsole, installXhr, installFetch, installPerformance, () => opts.pageMarkers !== false && pageMarkers(), startWatching].forEach((step) => {
        try {
          step();
        } catch {
          /* that part is not recorded */
        }
      });
    } catch {
      /* a failed start leaves the page as it was */
    }
  }

  function stop() {
    try {
      if (!armed) return;
      armed = false;
      clearTimer(timers.expiry);
      timers.expiry = 0;
      if (timers.poll) clearTicker(timers.poll);
      timers.poll = 0;
      while (listeners.length) {
        try {
          listeners.pop()();
        } catch {
          /* already gone */
        }
      }
      while (restorers.length) {
        try {
          restorers.pop()();
        } catch {
          /* already gone */
        }
      }
      try {
        if (observer) observer.disconnect();
      } catch {
        /* already gone */
      }
      observer = null;
      until = 0;
      forgetSecrets(); // no references to the page's inputs kept while stopped
      // Wrappers on g_form / GlideAjax / GlideRecord stay in place as pass-throughs until the page reloads.
    } catch {
      /* stopped as far as it could */
    }
  }

  // ---- what the content script can ask --------------------------------------------------------------------------------

  function status() {
    const events = ring.all();
    return {
      rid,
      frame,
      armed,
      until,
      count: ring.size,
      firstSeq: events.length ? events[0].seq : 0,
      lastSeq: seq,
      dropped: ring.dropped,
      installed: { ...installed },
      href: cleanUrl(win.location && win.location.href, origin) || '/',
    };
  }

  function pull(since) {
    const after = Number.isFinite(Number(since)) ? Number(since) : 0;
    const events = ring.since(after).sort((a, b) => a.seq - b.seq);
    return { rid, frame, lastSeq: events.length ? events[events.length - 1].seq : after, dropped: ring.dropped, events };
  }

  function handle(action, args) {
    const a = args && typeof args === 'object' ? args : {};
    switch (action) {
      case 'status':
        return status();
      case 'pull':
        return pull(a.since);
      case 'arm':
        start(a.until);
        return status();
      case 'disarm':
        stop();
        return status();
      case 'clear':
        ring.clear();
        ring.resetDropped();
        return status();
      default:
        throw new Error('Unknown action.');
    }
  }

  function attachTransport() {
    if (transportOn || !doc) return;
    transportOn = true;
    // Taken now (document_start, before any page script): a page that later replaces window.CustomEvent or
    // dispatchEvent cannot silence the answers.
    const Ctor = opts.CustomEvent || win.CustomEvent;
    const dispatch = doc.dispatchEvent;
    const respond = (detail) => {
      dispatch.call(doc, new Ctor(RESPONSE_EVENT, { detail }));
    };
    const onRequest = (event) => {
      const d = event && event.detail;
      if (!d || typeof d !== 'object' || typeof d.id !== 'string') return;
      try {
        respond({ id: d.id, ok: true, result: handle(d.action, d.args) });
      } catch (err) {
        try {
          respond({ id: d.id, ok: false, error: String((err && err.message) || err) });
        } catch {
          /* no way to answer */
        }
      }
    };
    doc.addEventListener(REQUEST_EVENT, onRequest);
    // Another frame of this tab armed or disarmed it (sessionStorage is shared by same-origin frames of a tab).
    const follow = () => {
      const flag = readArmFlag();
      if (flag) start(flag);
      else stop();
    };
    win.addEventListener('storage', (ev) => {
      try {
        if (ev.key !== ARM_KEY && ev.key !== null) return;
        follow();
      } catch {
        /* ignore */
      }
    });
    // Back from the back/forward cache: timers were frozen and storage events missed, so the flag decides again
    // (a recording past its 30 minutes stops here instead of when the frozen timer finally fires).
    win.addEventListener('pageshow', (ev) => {
      try {
        if (ev && ev.persisted) follow();
      } catch {
        /* ignore */
      }
    });
  }

  return {
    rid,
    frame,
    start,
    stop,
    status,
    pull,
    handle,
    clear: () => handle('clear'),
    readArmFlag,
    attachTransport,
    isArmed: () => armed,
    events: () => ring.all(),
    // Exposed for tests only.
    _hook: hook,
    _scan: scanGlobals,
  };
}

/** Entry for the page world: nothing happens off ServiceNow, and nothing past the listeners unless the tab is armed. */
export function boot(win, { allowAnyHost = false } = {}) {
  try {
    const marker = Symbol.for('msb.clientTrace.recorder');
    if (win[marker]) return null;
    if (!allowAnyHost && !isServiceNowHost(win.location && win.location.hostname)) return null;
    Object.defineProperty(win, marker, { value: true, enumerable: false });
    const recorder = createRecorder(win, { selfUrl: ownScriptUrl(win.Error) });
    recorder.attachTransport();
    const until = recorder.readArmFlag();
    if (until) recorder.start(until);
    return recorder;
  } catch {
    return null;
  }
}
