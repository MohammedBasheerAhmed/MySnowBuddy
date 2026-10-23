// Reading a Service Portal widget's Angular scope without ever breaking the page. Pure: no DOM globals, no
// `window`, no `chrome.*`, so it runs in the PAGE world (src/page/bridge.js bundles it) and is unit-tested in Node
// (tests/portalinspector.test.js) with fake scopes and a fake document.
//
//   serialize(value)                    JSON-safe copy of a scope value: cycles, depth, size and secrets handled
//   isSecretKey(name)                   key names whose value is never shown (password, token, secret...)
//   validateTarget(raw)                 the only thing the extension may ask the page about: a widget address
//   findTargetElement(doc, target)      the widget root element for an address
//   pickWidgetScope(ng, root, target)   the Angular scope that holds the widget's data / options / c
//   debugInfoState(ng, doc)             whether Angular debug info is on (scope() only works when it is)
//
// Nothing here executes text from the page or from the caller: it reads properties and calls the documented
// AngularJS accessors angular.element(el).scope() / .isolateScope() and nothing else.

export const LIMITS = { bytes: 20000, depth: 4, string: 400, items: 60, keys: 80 };

export const MARK = {
  masked: '[hidden]',
  fn: 'fn()',
  circular: '[circular]',
  truncated: '[truncated]',
  unreadable: '[unreadable]',
};

const HEX32 = /^[0-9a-f]{32}$/i;

// A key name that holds a secret. Matched anywhere for the long words, at the end for "token" so tokenCount stays visible,
// and "_ck" at the end: sysparm_ck and g_ck are the session's CSRF token.
const SECRET_KEY =
  /(?:pass(?:word|wd|phrase|code)|pwd|secret|credential|authorization|api[_-]?key|apikey|private[_-]?key|access[_-]?key|session[_-]?id|jsessionid|g_ck|csrf|xsrf|bearer|cookie)|tokens?$|(?:^|_)ck$/i;
// A value that is a secret whatever the key is called: it starts as a bearer / basic header or a JWT, or it holds a
// private key or user:pass@host. Every repeat is bounded and only the first SECRET_SCAN characters are looked at (only
// the start of a long string is ever shown), so a huge string in c.data cannot make this check slow: an unbounded
// pattern here took seconds on a 40 KB string, in the customer's page.
const SECRET_SCAN = 4096;
const SECRET_START = /^(?:Bearer\s+[A-Za-z0-9._~+/=-]{12}|Basic\s+[A-Za-z0-9+/=]{12}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8})/i;
const SECRET_INSIDE = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----|[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,256}:[^\s@/]{1,256}@/i;

export const isSecretKey = (name) => typeof name === 'string' && SECRET_KEY.test(name);
export const isSecretValue = (text) => {
  if (typeof text !== 'string') return false;
  const head = (text.length > SECRET_SCAN ? text.slice(0, SECRET_SCAN) : text).trim();
  return SECRET_START.test(head) || SECRET_INSIDE.test(head);
};

function safe(fn) {
  try {
    return fn();
  } catch (err) {
    return undefined;
  }
}

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const text = (v) => (typeof v === 'string' ? v.toLowerCase() : '');

// ---- Serialising a value ----------------------------------------------------------------------------------------

/**
 * A JSON-safe copy of `root`. Cycles become "[circular]", functions "fn()", DOM nodes / windows / Angular scopes a short
 * label, values under a secret-looking key "[hidden]". Containers deeper than `depth` become a one-line summary and
 * output past `bytes` is replaced by "[truncated]", so one huge `data` object can never flood the panel or the page.
 * @returns {{ value: any, bytes: number, truncated: boolean, masked: number }}
 */
export function serialize(root, options = {}) {
  const o = { ...LIMITS, ...options };
  const state = { used: 0, truncated: false, masked: 0 };
  const ancestors = [];

  function str(s) {
    if (isSecretValue(s)) {
      state.masked += 1;
      return MARK.masked;
    }
    if (s.length > o.string) {
      state.truncated = true;
      state.used += o.string;
      return `${s.slice(0, o.string)}... (+${s.length - o.string} more characters)`;
    }
    state.used += s.length + 2;
    return s;
  }

  function label(v) {
    if (typeof v.nodeType === 'number' && typeof v.nodeName === 'string') return `[element <${v.nodeName.toLowerCase()}>]`;
    if (safe(() => v.window === v)) return '[window]';
    if (typeof v.$watch === 'function' && typeof v.$digest === 'function') return '[angular scope]';
    if (typeof v.then === 'function' && typeof v.catch === 'function') return '[promise]';
    // A typed array or buffer: Object.keys() of a large one would build one string per byte.
    if (ArrayBuffer.isView(v)) return `[typed array, ${safe(() => v.length) ?? safe(() => v.byteLength) ?? 0} items]`;
    if (Object.prototype.toString.call(v) === '[object ArrayBuffer]') return `[typed array, ${safe(() => v.byteLength) || 0} bytes]`;
    return null;
  }

  function container(v, depth) {
    const special = safe(() => label(v));
    if (special) return special;
    const tag = safe(() => Object.prototype.toString.call(v));
    if (tag === '[object Date]') return safe(() => v.toISOString()) || 'Invalid Date';
    if (tag === '[object Map]' || tag === '[object Set]') return `[${tag.slice(8, -1)}, ${safe(() => v.size) || 0} entries]`;
    if (tag === '[object RegExp]') return safe(() => String(v)) || '[regexp]';
    if (ancestors.indexOf(v) !== -1) return MARK.circular;
    // Array.isArray throws on a revoked Proxy; such a value is unreadable, not a reason to lose the whole copy.
    const isArray = safe(() => Array.isArray(v));
    if (isArray === undefined) return MARK.unreadable;
    if (depth >= o.depth) {
      const n = isArray ? v.length : (safe(() => Object.keys(v).length) || 0);
      state.used += 24;
      return isArray ? `[array, ${n} items]` : `[object, ${n} keys]`;
    }
    ancestors.push(v);
    try {
      if (isArray) {
        const out = [];
        const len = v.length || 0;
        for (let i = 0; i < len; i += 1) {
          if (i >= o.items || state.used > o.bytes) {
            state.truncated = true;
            out.push(`[+${len - i} more items]`);
            break;
          }
          const item = safe(() => v[i]);
          const copy = item === undefined ? null : walk(item, depth + 1);
          out.push(copy === undefined ? null : copy);
          state.used += 2;
        }
        return out;
      }
      const out = {};
      const keys = safe(() => Object.keys(v)) || [];
      let shown = 0;
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        // Angular bookkeeping ($$hashKey) and prototype pollution keys are never data.
        if (key === '__proto__' || key.slice(0, 2) === '$$') continue;
        if (shown >= o.keys || state.used > o.bytes) {
          state.truncated = true;
          out['[more]'] = `${keys.length - i} more keys`;
          break;
        }
        shown += 1;
        state.used += key.length + 4;
        if (isSecretKey(key)) {
          state.masked += 1;
          out[key] = MARK.masked;
          continue;
        }
        let item;
        try {
          item = v[key];
        } catch (err) {
          out[key] = MARK.unreadable;
          continue;
        }
        const copy = walk(item, depth + 1);
        if (copy !== undefined) out[key] = copy;
      }
      return out;
    } finally {
      ancestors.pop();
    }
  }

  function walk(v, depth) {
    if (v === null) {
      state.used += 4;
      return null;
    }
    const type = typeof v;
    if (type === 'undefined') return undefined;
    if (type === 'boolean') {
      state.used += 5;
      return v;
    }
    if (type === 'number') {
      state.used += 8;
      return Number.isFinite(v) ? v : String(v);
    }
    if (type === 'bigint') return `${String(v)}n`;
    if (type === 'string') return str(v);
    if (type === 'function') {
      state.used += 4;
      return MARK.fn;
    }
    if (type === 'symbol') return safe(() => String(v)) || '[symbol]';
    return container(v, depth);
  }

  const value = walk(root, 0);
  return { value, bytes: state.used, truncated: state.truncated, masked: state.masked };
}

// ---- Addressing a widget on the page ----------------------------------------------------------------------------

/**
 * A widget address as the extension sends it to the page: { widgetId, instanceId, nth, spIndex }. Anything that is not a
 * 32-hex id or a small non-negative integer is dropped, so the address can only ever pick an element, never run code.
 * @returns {{ widgetId: string, instanceId: string, nth: number, spIndex: number } | null}
 */
export function validateTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hex = (v) => (typeof v === 'string' && HEX32.test(v) ? v.toLowerCase() : '');
  const num = (v) => (Number.isInteger(v) && v >= 0 && v < 5000 ? v : -1);
  const target = { widgetId: hex(raw.widgetId), instanceId: hex(raw.instanceId), nth: Math.max(0, num(raw.nth)), spIndex: num(raw.spIndex) };
  return target.widgetId || target.instanceId || target.spIndex >= 0 ? target : null;
}

/** The widget's root element: the nth element carrying class v<widget id>, else #x<instance id>, else the nth <sp-widget>. */
export function findTargetElement(doc, target) {
  if (!doc || !target) return null;
  if (target.widgetId) {
    const list = safe(() => doc.getElementsByClassName(`v${target.widgetId}`));
    const el = list && list[target.nth];
    if (el) return el;
  }
  if (target.instanceId) {
    const el = safe(() => doc.getElementById(`x${target.instanceId}`));
    if (el) return el;
  }
  if (target.spIndex >= 0) {
    const list = safe(() => doc.getElementsByTagName('sp-widget'));
    const el = list && list[target.spIndex];
    if (el) return el;
  }
  return null;
}

// ---- Angular scopes ---------------------------------------------------------------------------------------------

function hasAngular(ng) {
  return Boolean(ng) && typeof ng.element === 'function';
}

/** The scopes AngularJS keeps on one element: its isolate scope (a directive's own) and its ordinary scope. */
function scopesOn(ng, el) {
  const out = [];
  const wrapped = safe(() => ng.element(el));
  if (!wrapped) return out;
  const isolate = safe(() => (typeof wrapped.isolateScope === 'function' ? wrapped.isolateScope() : undefined));
  const normal = safe(() => (typeof wrapped.scope === 'function' ? wrapped.scope() : undefined));
  if (isolate && typeof isolate === 'object') out.push({ scope: isolate, kind: 'isolate scope' });
  if (normal && typeof normal === 'object' && normal !== isolate) out.push({ scope: normal, kind: 'scope' });
  return out;
}

/**
 * How well a scope looks like THIS widget's: a matching `widget.sys_id` / `widget.rectangle_id` is the strongest sign,
 * then a controller `c` with `data`, then `data` and `options` side by side. A scope that carries a different widget is
 * rejected (-1), so a page-level or neighbouring widget scope is never shown by mistake.
 */
export function scoreScope(scope, target) {
  const widget = safe(() => scope.widget);
  let score = 0;
  if (widget && typeof widget === 'object') {
    const sys = text(safe(() => widget.sys_id));
    const instance = text(safe(() => widget.rectangle_id));
    const sameWidget = target.widgetId && sys && sys === target.widgetId;
    const sameInstance = target.instanceId && instance && instance === target.instanceId;
    if (sameWidget || sameInstance) score += 4;
    else if ((target.widgetId && sys) || (target.instanceId && instance)) return -1;
  }
  const c = safe(() => scope.c);
  if (c && typeof c === 'object' && safe(() => 'data' in c)) score += 2;
  if (safe(() => 'data' in scope && 'options' in scope)) score += 1;
  if (safe(() => own(scope, 'data') || own(scope, 'c'))) score += 1; // the scope that owns the data beats one that inherits it
  return score;
}

function descendants(root, limit) {
  const list = [];
  const marked = safe(() => root.querySelectorAll('.ng-isolate-scope, .ng-scope')) || [];
  for (let i = 0; i < marked.length && list.length < limit; i += 1) list.push(marked[i]);
  return list;
}

/**
 * The Angular scope behind a widget root element, or null. Looks at the nearest <sp-widget>, the root itself and the
 * elements Angular marked inside it, follows each scope up a few $parent steps, and takes the best-scoring match.
 * @returns {{ scope: object, how: string } | null}
 */
export function pickWidgetScope(ng, root, target) {
  if (!hasAngular(ng) || !root) return null;
  const starts = [];
  const spInside = safe(() => (root.tagName === 'SP-WIDGET' ? root : root.querySelector('sp-widget')));
  if (spInside) starts.push({ el: spInside, name: '<sp-widget>' });
  const spAbove = safe(() => (typeof root.closest === 'function' ? root.closest('sp-widget') : null));
  if (spAbove && spAbove !== spInside) starts.push({ el: spAbove, name: '<sp-widget>' });
  starts.push({ el: root, name: `<${String(root.tagName || 'div').toLowerCase()}> (the widget root)` });
  descendants(root, 40).forEach((el) => starts.push({ el, name: `<${String(el.tagName || 'div').toLowerCase()}> inside the widget` }));

  let best = null;
  for (let s = 0; s < starts.length; s += 1) {
    const found = scopesOn(ng, starts[s].el);
    for (let f = 0; f < found.length; f += 1) {
      let scope = found[f].scope;
      for (let up = 0; up < 6 && scope; up += 1) {
        const score = scoreScope(scope, target);
        if (score >= 3 && (!best || score > best.score)) {
          best = { scope, score, how: `${found[f].kind} of ${starts[s].name}${up ? `, ${up} level${up === 1 ? '' : 's'} up` : ''}` };
        }
        scope = safe(() => scope.$parent);
      }
    }
  }
  return best ? { scope: best.scope, how: best.how } : null;
}

const asString = (v) => (typeof v === 'string' ? v.slice(0, 200) : typeof v === 'number' ? String(v) : '');

/** Name, id and sys_id the widget carries about itself (`scope.widget`), as plain strings. */
export function widgetIdentity(scope) {
  const widget = safe(() => scope.widget);
  if (!widget || typeof widget !== 'object') return null;
  return {
    sysId: text(safe(() => widget.sys_id)),
    instanceId: text(safe(() => widget.rectangle_id)),
    name: asString(safe(() => widget.name)),
    id: asString(safe(() => widget.id)),
  };
}

/** The small facts a widget scope states about itself (no data): who it is and how long its last server call took. */
export function summarizeScope(scope) {
  const time = safe(() => scope.widget && scope.widget._server_time);
  return { identity: widgetIdentity(scope), serverTimeMs: typeof time === 'number' && Number.isFinite(time) ? Math.round(time) : null };
}

/**
 * What a widget scope exposes: `data` (c.data), `options` and how long the last server call took. Each value is
 * serialised with the shared limits; `null` means the scope has no such thing.
 */
export function readWidgetScope(scope, options = {}) {
  const c = safe(() => scope.c);
  const pick = (...candidates) => {
    for (let i = 0; i < candidates.length; i += 1) {
      const v = safe(candidates[i]);
      if (v && typeof v === 'object') return v;
    }
    return undefined;
  };
  const data = pick(() => scope.data, () => c && c.data);
  const opts = pick(() => scope.options, () => scope.widget && scope.widget.options, () => c && c.options);
  const dataOut = data === undefined ? null : serialize(data, options);
  const optionsOut = opts === undefined ? null : serialize(opts, options);
  return { ...summarizeScope(scope), data: dataOut, options: optionsOut };
}

/**
 * Whether Angular debug info is on. AngularJS only attaches scopes to elements (and adds the ng-scope / ng-binding
 * classes) when debug info is enabled, which production builds often switch off; then scope() answers undefined.
 * @returns {{ angular: boolean, version: string|null, debugInfo: boolean|null, canReload: boolean }}
 */
export function debugInfoState(ng, doc) {
  if (!hasAngular(ng)) return { angular: false, version: null, debugInfo: null, canReload: false };
  const version = safe(() => (ng.version && ng.version.full ? String(ng.version.full) : null)) || null;
  const canReload = typeof ng.reloadWithDebugInfo === 'function';
  if (!doc) return { angular: true, version, debugInfo: null, canReload };
  if (safe(() => doc.querySelector('.ng-scope, .ng-binding, .ng-isolate-scope'))) return { angular: true, version, debugInfo: true, canReload };
  const probes = [safe(() => doc.body), safe(() => doc.documentElement)];
  for (let i = 0; i < probes.length; i += 1) {
    if (probes[i] && scopesOn(ng, probes[i]).length) return { angular: true, version, debugInfo: true, canReload };
  }
  return { angular: true, version, debugInfo: false, canReload };
}

const pickRecord = (v) => {
  if (!v || typeof v !== 'object') return null;
  const sysId = text(safe(() => v.sys_id));
  const out = {
    sysId: HEX32.test(sysId) ? sysId : '',
    id: asString(safe(() => v.id)),
    title: asString(safe(() => v.title)),
    urlSuffix: asString(safe(() => v.url_suffix)),
  };
  return out.sysId || out.id || out.title || out.urlSuffix ? out : null;
};

/** The portal and page records the page scope knows ($rootScope.portal, scope.page), or nulls. */
export function readPageScope(ng, doc) {
  const out = { page: null, portal: null };
  if (!hasAngular(ng) || !doc) return out;
  const starts = [safe(() => doc.body), safe(() => doc.documentElement), safe(() => doc.querySelector('[ng-app], [data-ng-app]'))];
  for (let i = 0; i < starts.length; i += 1) {
    if (!starts[i]) continue;
    const found = scopesOn(ng, starts[i]);
    for (let f = 0; f < found.length; f += 1) {
      const scopes = [found[f].scope, safe(() => found[f].scope.$root)];
      for (let s = 0; s < scopes.length; s += 1) {
        if (!scopes[s]) continue;
        if (!out.page) out.page = pickRecord(safe(() => scopes[s].page));
        if (!out.portal) out.portal = pickRecord(safe(() => scopes[s].portal));
      }
    }
    if (out.page && out.portal) break;
  }
  return out;
}

// ---- The three page-world actions -------------------------------------------------------------------------------

/**
 * The portal* actions of the page bridge (src/page/bridge.js), built on a function that returns the window that holds
 * the portal: `getWorld(frame)` -> { doc, ng } or null. They live here so the exact code the page runs is also run by
 * the unit tests and by the preview harness. All of them read; the last one reloads the page.
 */
export function portalActions(getWorld) {
  return {
    // What the page's Angular knows about the widgets at `targets`: debug-info state, the portal and page records, and each
    // widget's own name, id and sys_id.
    portalScan(frame, targets) {
      const world = getWorld(frame);
      if (!world) return { frame: false };
      const state = debugInfoState(world.ng, world.doc);
      const records = readPageScope(world.ng, world.doc);
      const list = Array.isArray(targets) ? targets.slice(0, 80) : [];
      const widgets = list.map((raw) => {
        const info = { found: false, scope: false };
        const target = validateTarget(raw);
        const el = target ? findTargetElement(world.doc, target) : null;
        if (!el) return info;
        info.found = true;
        const picked = pickWidgetScope(world.ng, el, target);
        if (picked) {
          const summary = summarizeScope(picked.scope);
          info.scope = true;
          info.identity = summary.identity;
          info.serverTimeMs = summary.serverTimeMs;
        }
        return info;
      });
      return { frame: true, angular: state.angular, version: state.version, debugInfo: state.debugInfo, canReload: state.canReload, page: records.page, portal: records.portal, widgets };
    },

    // The scope of one widget: c.data and the options as JSON-safe copies, or the reason there is none.
    portalWidgetState(frame, rawTarget) {
      const world = getWorld(frame);
      if (!world) return { found: false, reason: 'no-frame' };
      const target = validateTarget(rawTarget);
      if (!target) throw new Error('That is not a widget address.');
      const state = debugInfoState(world.ng, world.doc);
      const out = { angular: state.angular, version: state.version, debugInfo: state.debugInfo, canReload: state.canReload };
      const el = findTargetElement(world.doc, target);
      if (!el) return { ...out, found: false, reason: 'no-element' };
      if (!state.angular) return { ...out, found: true, scope: false, reason: 'no-angular' };
      const picked = pickWidgetScope(world.ng, el, target);
      if (!picked) return { ...out, found: true, scope: false, reason: state.debugInfo === false ? 'no-debug-info' : 'no-scope' };
      const read = readWidgetScope(picked.scope);
      return { ...out, found: true, scope: true, reason: '', how: picked.how, identity: read.identity, data: read.data, options: read.options, serverTimeMs: read.serverTimeMs };
    },

    // angular.reloadWithDebugInfo() is the documented AngularJS way to turn debug info on: it reloads the page and nothing else.
    portalReloadWithDebugInfo(frame) {
      const world = getWorld(frame);
      if (!world || !world.ng || typeof world.ng.reloadWithDebugInfo !== 'function') throw new Error('This page cannot be reloaded with Angular debug info.');
      world.ng.reloadWithDebugInfo();
      return true;
    },
  };
}
