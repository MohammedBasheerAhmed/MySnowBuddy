// Verified ServiceNow API catalog: lookup, search and formatting. The data lives
// in clientApis.js, serverDataApis.js and serverSystemApis.js (schema in
// SCHEMA.md). The verifier (../apiCheck.js) and the lookup_api agent tool both
// read through this module.
import { CLIENT_APIS } from './clientApis.js';
import { SERVER_DATA_APIS } from './serverDataApis.js';
import { SERVER_SYSTEM_APIS } from './serverSystemApis.js';

// GlideAggregate and GlideRecordSecure expose everything GlideRecord does.
export const INHERITS = {
  GlideAggregate: ['GlideRecord'],
  GlideRecordSecure: ['GlideRecord'],
};

// Predefined server variables that behave as another catalog type.
export const GLOBAL_TYPE_ALIASES = {
  current: 'GlideRecord',
  previous: 'GlideRecord',
};

function normalize(entry) {
  const methods = entry.methods || [];
  return {
    ...entry,
    methods,
    properties: entry.properties || [],
    methodMap: new Map(methods.map((m) => [m.name, m])),
    propertySet: new Set((entry.properties || []).map((p) => p.name)),
  };
}

export const ALL_APIS = [...CLIENT_APIS, ...SERVER_DATA_APIS, ...SERVER_SYSTEM_APIS].map(normalize);

const bySide = {
  client: new Map(ALL_APIS.filter((a) => a.side === 'client').map((a) => [a.name, a])),
  server: new Map(ALL_APIS.filter((a) => a.side === 'server').map((a) => [a.name, a])),
};

export const getApi = (name, side) => bySide[side]?.get(name) || null;

/** Which sides define this name: [] | ['client'] | ['server'] | both. */
export const sidesOf = (name) => ['client', 'server'].filter((side) => bySide[side].has(name));

export const apiNames = (side) => [...bySide[side].keys()];

/** Method lookup that follows inheritance (GlideAggregate -> GlideRecord). */
export function findMethod(api, methodName, side = api.side) {
  if (!api) return null;
  const own = api.methodMap.get(methodName);
  if (own) return { method: own, owner: api };
  for (const parentName of INHERITS[api.name] || []) {
    const parent = getApi(parentName, side);
    const hit = parent && parent.methodMap.get(methodName);
    if (hit) return { method: hit, owner: parent };
  }
  return null;
}

/** True when a missing method can be called "unknown" with confidence. */
export function isComplete(api, side = api.side) {
  if (!api.complete) return false;
  return (INHERITS[api.name] || []).every((p) => {
    const parent = getApi(p, side);
    return parent && parent.complete;
  });
}

export function allMethodNames(api, side = api.side) {
  const names = new Set([...api.methodMap.keys(), ...api.propertySet]);
  (INHERITS[api.name] || []).forEach((p) => {
    const parent = getApi(p, side);
    if (parent) parent.methodMap.forEach((_, k) => names.add(k));
  });
  return [...names];
}

// ---- fuzzy matching -----------------------------------------------------------

export function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Closest candidate within a sensible distance, or null. */
export function closest(name, candidates) {
  const lower = String(name).toLowerCase();
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = editDistance(lower, candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  const limit = Math.max(2, Math.floor(lower.length / 3));
  return best && bestDistance <= limit ? best : null;
}

// ---- lookup and search ----------------------------------------------------------

export function formatMethod(api, m) {
  const flags = [];
  if (m.static) flags.push('static');
  if (m.deprecated) flags.push(`DEPRECATED: ${m.deprecated}`);
  if (m.scopedOnly) flags.push('scoped apps only');
  if (m.globalOnly) flags.push('global scope only');
  if (m.unsupportedIn?.length) flags.push(`not supported in: ${m.unsupportedIn.join(', ')}`);
  const lines = [`${api.name}.${m.sig || `${m.name}()`}${m.returns ? ` -> ${m.returns}` : ''}  [${api.side}]`];
  if (m.summary) lines.push(`  ${m.summary}`);
  if (flags.length) lines.push(`  ${flags.join(' | ')}`);
  if (m.notes) lines.push(`  Note: ${m.notes}`);
  if (m.example) lines.push(`  Example: ${m.example}`);
  return lines.join('\n');
}

export function formatApi(api, { maxMethods = 80 } = {}) {
  const head = [`${api.name} (${api.kind}, ${api.side}-side)${api.complete ? '' : ' - method list is not exhaustive'}`];
  if (api.summary) head.push(api.summary);
  if (api.instantiate) head.push(`Create: ${api.instantiate}`);
  if (api.unsupportedIn?.length) head.push(`Not supported in: ${api.unsupportedIn.join(', ')}`);
  const props = api.properties.map((p) => `  .${p.name}${p.type ? `: ${p.type}` : ''}${p.summary ? ` - ${p.summary}` : ''}`);
  const methods = api.methods.slice(0, maxMethods).map((m) => `  ${m.sig || `${m.name}()`}${m.deprecated ? '  [deprecated]' : ''}`);
  return [...head, ...(props.length ? ['Properties:', ...props] : []), ...(methods.length ? ['Methods:', ...methods] : [])].join('\n');
}

/**
 * "GlideRecord", "g_form.setValue", "setvalue" -> formatted text, or a "not found" note
 * with suggestions. `side` narrows results.
 */
export function lookupApi(query, side) {
  const text = String(query || '').trim();
  if (!text) return { found: false, text: 'Give a class, method or Class.method.' };

  const sides = side ? [side] : ['client', 'server'];
  const [receiver, second] = text.split('.');
  const first = GLOBAL_TYPE_ALIASES[receiver] || receiver;

  // Class or Class.method
  const apis = sides.map((s) => getApi(first, s)).filter(Boolean);
  if (apis.length) {
    if (second) {
      const parts = apis.map((api) => {
        const hit = findMethod(api, second);
        if (hit) return formatMethod(hit.owner, hit.method);
        const prop = api.properties.find((p) => p.name === second);
        if (prop) return `${api.name}.${prop.name}${prop.type ? `: ${prop.type}` : ''} [${api.side}] - ${prop.summary || ''}`;
        const near = closest(second, allMethodNames(api));
        return `${api.name} has no documented "${second}" [${api.side}]${near ? `. Did you mean ${api.name}.${near}?` : ''}${
          isComplete(api) ? ' This list is exhaustive, so the method does not exist.' : ' The list is not exhaustive: check the official docs.'
        }`;
      });
      return { found: parts.some((p) => !p.includes(' has no documented ')), text: parts.join('\n\n') };
    }
    return { found: true, text: apis.map((a) => formatApi(a)).join('\n\n') };
  }

  // Bare method name across every API.
  const hits = [];
  for (const api of ALL_APIS) {
    if (side && api.side !== side) continue;
    const m = api.methodMap.get(first) || [...api.methodMap.values()].find((x) => x.name.toLowerCase() === first.toLowerCase());
    if (m) hits.push(formatMethod(api, m));
  }
  if (hits.length) return { found: true, text: hits.slice(0, 8).join('\n\n') };

  const near = closest(first, [...new Set(ALL_APIS.filter((a) => !side || a.side === side).map((a) => a.name))]);
  return { found: false, text: `Nothing in the catalog matches "${text}".${near ? ` Did you mean ${near}?` : ''}` };
}

// Names developers type before a method that are not catalog classes: `current.setValue`, `gr.addQuery`.
const SEARCH_RECEIVERS = { ...GLOBAL_TYPE_ALIASES, gr: 'GlideRecord', ga: 'GlideAggregate' };

/** "current.setval" -> methods of the class that variable stands for (or of the class named) matching "setval". */
function searchReceiverMember(needle, side) {
  const dot = needle.indexOf('.');
  if (dot <= 0) return [];
  const className = String(SEARCH_RECEIVERS[needle.slice(0, dot)] || needle.slice(0, dot)).toLowerCase();
  const member = needle.slice(dot + 1);
  const results = [];
  for (const api of ALL_APIS) {
    if (api.name.toLowerCase() !== className || (side && api.side !== side)) continue;
    const owners = [api, ...(INHERITS[api.name] || []).map((p) => getApi(p, api.side)).filter(Boolean)];
    owners.forEach((owner) =>
      owner.methods.forEach((m) => {
        const name = m.name.toLowerCase();
        if (name.includes(member)) results.push({ type: 'method', api, method: m, score: name === member ? 1 : name.startsWith(member) ? 2 : 3 });
      })
    );
  }
  return results;
}

/** Free-text search over class and method names and summaries. */
export function searchApis(text, { side, limit = 40 } = {}) {
  const needle = String(text || '').trim().toLowerCase();
  const typed = searchReceiverMember(needle, side);
  if (typed.length) return typed.sort((a, b) => a.score - b.score || a.method.name.localeCompare(b.method.name)).slice(0, limit);
  const results = [];
  for (const api of ALL_APIS) {
    if (side && api.side !== side) continue;
    const apiHit = !needle || api.name.toLowerCase().includes(needle) || (api.summary || '').toLowerCase().includes(needle);
    if (apiHit) results.push({ type: 'class', api, score: api.name.toLowerCase() === needle ? 0 : 2 });
    for (const m of api.methods) {
      if (!needle) continue;
      const name = m.name.toLowerCase();
      const hit = name.includes(needle) || (m.summary || '').toLowerCase().includes(needle);
      if (hit) results.push({ type: 'method', api, method: m, score: name === needle ? 1 : name.includes(needle) ? 3 : 4 });
    }
  }
  return results.sort((a, b) => a.score - b.score || a.api.name.localeCompare(b.api.name)).slice(0, limit);
}

export const catalogStats = () => ({
  apis: ALL_APIS.length,
  methods: ALL_APIS.reduce((n, a) => n + a.methods.length, 0),
  client: ALL_APIS.filter((a) => a.side === 'client').length,
  server: ALL_APIS.filter((a) => a.side === 'server').length,
});
