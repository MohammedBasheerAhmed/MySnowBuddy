// Pure half of the instance switcher: which hosts are valid, which colour an instance gets, how the
// current page maps onto another instance and how the picker ranks and reorders the list. No DOM,
// no storage: the palette (src/content/instanceSwitch.js), the instance tag (instanceTag.js) and the
// options page (src/options/InstanceManager.jsx) share it, and tests/instances.test.js covers it.

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.service-now\.com$/;

/**
 * Validate what a person typed as an instance. A scheme and one trailing slash are tolerated (people paste the
 * address bar); a path, query, port, user info or any other domain is refused, so a pasted record URL can never
 * be stored as a destination.
 * @returns {{ host: string } | { error: string }}
 */
export function parseInstanceHost(raw) {
  const text = String(raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!text) return { error: 'Enter a hostname like dev12345.service-now.com.' };
  if (/[\s@]/.test(text)) return { error: 'Enter only the hostname, without spaces or a user name.' };
  if (/[/?#]/.test(text)) return { error: 'Enter only the hostname, not a page address (no path after .com).' };
  if (text.includes(':')) return { error: 'Enter the hostname without a port.' };
  if (!HOST_RE.test(text)) return { error: 'Only *.service-now.com hosts are accepted, for example dev12345.service-now.com.' };
  return { host: text };
}

// --- Environments ----------------------------------------------------------------------------------------

const ENVIRONMENTS = [
  { test: /(^|[-_.])(prod|prd|live)([-_.]|$)/i, env: 'prod', label: 'PROD', tone: 'danger' },
  { test: /(^|[-_.])(uat|preprod|stage|staging|stg)([-_.]|$)/i, env: 'stage', label: 'STAGE', tone: 'warn' },
  { test: /(^|[-_.])(test|tst|qa|sit)([-_.]|$)/i, env: 'test', label: 'TEST', tone: 'warn' },
  { test: /(^|[-_.])(dev|develop|sandbox|sbx|poc)([-_.]|$)/i, env: 'dev', label: 'DEV', tone: 'ok' },
  // Looser fallbacks, tried last: "acmeprod", "acmeprd2" and the default developer-instance name "dev12345".
  { test: /(prod|prd)\d*$/i, env: 'prod', label: 'PROD', tone: 'danger' },
  { test: /^dev\d+$/i, env: 'dev', label: 'DEV', tone: 'ok' },
];

/**
 * Best-effort environment classification from the instance hostname, used for
 * the toolbar badge. Naming conventions vary, so an unmatched host is left
 * neutral rather than guessed at — an instance wrongly labelled "DEV" is
 * worse than one labelled nothing.
 */
/** Environment guess ({ env, label, tone }) from an instance name or label, or null. */
export function classifyEnvironment(name) {
  return ENVIRONMENTS.find((e) => e.test.test(name)) || null;
}

/** True when a label or host name reads as production. */
export const looksProd = (...names) => names.some((n) => classifyEnvironment(String(n || ''))?.env === 'prod');

// --- Colours -------------------------------------------------------------------------------------------

// Every swatch keeps 4.5:1 against white text (tests/instances.test.js), because the favicon tile and the
// switcher tile put a white letter on it.
export const SWATCHES = [
  { id: 'red', hex: '#b42318', name: 'Red' },
  { id: 'orange', hex: '#b54708', name: 'Orange' },
  { id: 'green', hex: '#067647', name: 'Green' },
  { id: 'teal', hex: '#0e7090', name: 'Teal' },
  { id: 'blue', hex: '#175cd3', name: 'Blue' },
  { id: 'indigo', hex: '#444ce7', name: 'Indigo' },
  { id: 'purple', hex: '#6941c6', name: 'Purple' },
  { id: 'pink', hex: '#c11574', name: 'Pink' },
  { id: 'slate', hex: '#475467', name: 'Slate' },
];

const BY_HEX = new Map(SWATCHES.map((s) => [s.hex, s]));
const RED = SWATCHES[0].hex;
const TONE_COLOR = { danger: RED, warn: SWATCHES[1].hex, ok: SWATCHES[2].hex };
// Instances that read as no environment spread over the colours that do not imply one (not red, orange or green).
const NEUTRAL_POOL = ['teal', 'blue', 'indigo', 'purple', 'pink', 'slate'].map((id) => SWATCHES.find((s) => s.id === id).hex);

/** The swatch hex for a stored colour, or '' when it is empty or not one of ours. */
export function validColor(value) {
  const hex = String(value || '').trim().toLowerCase();
  return BY_HEX.has(hex) ? hex : '';
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * The colour an instance is drawn in. `tone` is the environment guess ('danger' = production, 'warn' = test or
 * stage, 'ok' = dev, anything else unknown). Production is always red: a chosen colour must not be able to make a
 * production instance look safe. Otherwise the saved colour wins, then the environment colour, then a stable
 * colour picked from the host name so two unknown instances differ.
 */
export function resolveColor({ saved = '', tone = 'neutral', host = '' } = {}) {
  if (tone === 'danger') return RED;
  const chosen = validColor(saved);
  if (chosen) return chosen;
  if (TONE_COLOR[tone]) return TONE_COLOR[tone];
  return NEUTRAL_POOL[hash(String(host).toLowerCase().split('.')[0]) % NEUTRAL_POOL.length];
}

// --- Entries ----------------------------------------------------------------------------------------------

export const MAX_LABEL = 40;

const clip = (value, max) => String(value ?? '').trim().slice(0, max);

/** A stored entry from loose input; throws the message to show a person when the host is not valid. */
export function makeInstance({ id, label, host, color }) {
  const parsed = parseInstanceHost(host);
  if (parsed.error) throw new Error(parsed.error);
  return { id, label: clip(label, MAX_LABEL) || parsed.host.split('.')[0], host: parsed.host, ...(validColor(color) ? { color: validColor(color) } : {}) };
}

/** `list` with one entry's label and/or colour changed (a colour of '' clears it back to automatic). */
export function patchInstance(list, id, patch) {
  return list.map((entry) => {
    if (entry.id !== id) return entry;
    const next = { ...entry };
    if ('label' in patch) next.label = clip(patch.label, MAX_LABEL) || entry.host.split('.')[0];
    if ('color' in patch) {
      const color = validColor(patch.color);
      if (color) next.color = color;
      else delete next.color;
    }
    return next;
  });
}

/** `list` with one entry moved up (delta -1) or down (+1); an entry at the end stays where it is. */
export function moveInstance(list, id, delta) {
  const from = list.findIndex((entry) => entry.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return list;
  const next = list.slice();
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

// --- Mapping the current page onto another instance --------------------------------------------------------

// Pages that only make sense for the session on this instance.
const SESSION_PATHS = /^\/(?:login|logout|login_with_sso|auth_redirect|external_logout_complete|saml2_[a-z_]+|consent|welcome)\.do$|^\/(?:oauth_[a-z_]+|sys_attachment)\.do$/i;
// Parameters that carry state of this instance's session or a record list position, not the page itself.
const DROP_PARAMS = /^(?:sysparm_ck|sysparm_transaction_scope|sysparm_domain_restore|sysparm_referring_url|sysparm_goto_url|sysparm_record_(?:list|row|rows|target)|sysparm_userpref_.+)$/i;

/**
 * Where "the same page" is on another instance, as a root-relative path. The page address is kept, minus the
 * parameters that belong to this session; the home page (`/`) is the answer for pages that cannot be matched.
 * @returns {{ path: string, mapped: boolean, note: string }}
 */
export function mapPageToInstance({ pathname = '/', search = '', hash = '' } = {}) {
  const home = (note) => ({ path: '/', mapped: false, note });
  const p = String(pathname || '/');
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('..') || p.includes('\\') || /[\r\n]/.test(p)) return home('This address cannot be carried over.');
  if (p === '/') return home('You are on the home page.');
  if (SESSION_PATHS.test(p)) return home('This page belongs to your session on this instance.');

  let query = '';
  if (search && search !== '?') {
    const params = new URLSearchParams(search);
    const drop = [...params.keys()].filter((key) => DROP_PARAMS.test(key));
    // Untouched when nothing is dropped, so the page's own encoding survives.
    if (!drop.length) query = search;
    else {
      drop.forEach((key) => params.delete(key));
      const text = params.toString();
      query = text ? `?${text}` : '';
    }
  }
  const fragment = hash && hash !== '#' ? hash : '';
  return { path: `${p}${query}${fragment}`, mapped: true, note: '' };
}

/** The full address of a mapped page on `host`; throws when `host` is not an instance host. */
export function switchUrl(host, mapping) {
  const parsed = parseInstanceHost(host);
  if (parsed.error) throw new Error(parsed.error);
  const path = mapping?.path && String(mapping.path).startsWith('/') && !String(mapping.path).startsWith('//') ? mapping.path : '/';
  return `https://${parsed.host}${path}`;
}

// --- Ranking ----------------------------------------------------------------------------------------------

function tokenScore(token, label, host) {
  const sub = host.split('.')[0];
  if (label.startsWith(token)) return 300;
  if (sub.startsWith(token)) return 260;
  if (label.split(/[^a-z0-9]+/).some((word) => word.startsWith(token))) return 200;
  if (label.includes(token)) return 120;
  if (sub.includes(token)) return 100;
  if (host.includes(token)) return 40;
  return 0;
}

/**
 * The picker's rows for `query`. Every word of the query must match the label or the host. Without a query the
 * list keeps the order set in Options, with the instance you are on last; with one, the best match comes first
 * and ties keep the configured order. Each row says whether it is the current instance.
 */
export function rankInstances(list, query = '', currentHost = '') {
  const here = String(currentHost || '').toLowerCase();
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const rows = [];
  (Array.isArray(list) ? list : []).forEach((entry, order) => {
    if (!entry || !entry.host) return;
    const host = String(entry.host).toLowerCase();
    const label = String(entry.label || '').toLowerCase();
    let score = 0;
    for (const token of tokens) {
      const s = tokenScore(token, label, host);
      if (!s) return;
      score += s;
    }
    rows.push({ entry, current: host === here, score, order });
  });
  return rows.sort((a, b) => {
    if (a.current !== b.current) return a.current ? 1 : -1;
    return tokens.length ? b.score - a.score || a.order - b.order : a.order - b.order;
  });
}

// --- Tab title -------------------------------------------------------------------------------------------

/** The tab title with `prefix` in front, replacing a previous prefix when there is one. */
export function titleWithPrefix(title, prefix, previous = '') {
  const base = previous && String(title).startsWith(previous) ? String(title).slice(previous.length) : String(title);
  return base.startsWith(prefix) ? base : prefix + base;
}

/** The tab title without our prefix. */
export function titleWithoutPrefix(title, prefix) {
  return prefix && String(title).startsWith(prefix) ? String(title).slice(prefix.length) : String(title);
}
