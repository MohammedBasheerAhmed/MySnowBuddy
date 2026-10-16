// Pure helpers for the control-plane tools (navigate, read_page, click_ui_action,
// record CRUD). No DOM and no network here, so every rule is unit-tested in Node.
// The DOM side lives in src/content/controlPage.js, the network side in
// src/content/controlSession.js and the tools themselves in src/content/controlTools.js.

import { findRedactionPlaceholders, REDACTED } from '../../providers/redact.js';

export const TABLE_RE = /^[a-z][a-z0-9_]*$/i;
export const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const MAX_PATH = 2000;

// Query parameters a classic list or form URL may carry when the agent opens it. Anything else
// (sys_action, sysparm_ck, processor parameters...) can make a GET do something, so it is refused.
const VIEW_PARAMS = new Set([
  'sys_id',
  'sysparm_query',
  'sysparm_view',
  'sysparm_first_row',
  'sysparm_fixed_query',
  'sysparm_order',
  'sysparm_order_direction',
  'sysparm_stack',
  'sysparm_nostack',
  'sysparm_clear_stack',
  'sysparm_record_target',
  'sysparm_record_row',
  'sysparm_record_rows',
  'sysparm_record_list',
  'sysparm_list_mode',
  'sysparm_userpref_module',
  'sysparm_domain_restore',
]);

// A script in a query runs on the server: never put one in a URL either.
const hasScript = (value) => /javascript\s*:/i.test(String(value || '')) || /(^|[^a-z0-9_])gs\./i.test(String(value || ''));

function assertQuery(query) {
  const q = String(query || '');
  if (hasScript(q)) throw new Error('Queries may not contain script. Use plain encoded query conditions.');
  if (q.length > 1500) throw new Error('Query is too long.');
  return q;
}

// Single-segment pages that are processors, not portals: never opened as a "portal page".
const NOT_PORTALS = new Set(['logout', 'login', 'xmlhttp', 'cache', 'impersonate', 'logout_impersonate', 'stats', 'threads', 'xmlstats', 'navpage', 'nav_to', 'home', 'api', 'sys', 'auth_redirect', 'oauth_token', 'oauth_auth', 'saml', 'saml_redirector', 'sys_attachment', 'angular', 'sn_ws', 'channel', 'amb', 'xmlhttprequest', 'sys_script', 'exportnow']);
// Portal suffixes that exist out of the box; any other suffix must be found in sp_portal first.
export const KNOWN_PORTALS = new Set(['sp', 'esc', 'csm', 'hrportal', 'hrm']);

/**
 * Split a root-relative path into { pathname, params } without needing a browser. The pathname is decoded once,
 * repeated slashes are collapsed and `match` is its lower-case form, so encoded or oddly-cased variants of a path
 * are judged exactly like the plain one. A path that is still encoded after one decode is refused.
 */
export function splitPath(raw) {
  const path = String(raw || '').trim();
  if (!path.startsWith('/')) throw new Error('A path must start with "/" (root-relative, on this instance).');
  if (path.startsWith('//') || path.includes('\\')) throw new Error('Protocol-relative and backslash paths are not allowed.');
  if (path.includes('..')) throw new Error('Path traversal is not allowed.');
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error('The path contains control characters.');
  if (path.length > MAX_PATH) throw new Error('The path is too long.');
  const url = new URL(path, 'https://instance.invalid');
  if (url.host !== 'instance.invalid') throw new Error('Navigation must stay on the current instance.');
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw new Error('The path is not valid URL encoding.');
  }
  const pathPart = decoded.split('?')[0];
  if (/%[0-9a-f]{2}/i.test(pathPart)) throw new Error('The path is encoded twice; give the plain path.');
  if (decoded.includes('\\') || decoded.includes('..') || /[\u0000-\u001f\u007f]/.test(decoded)) throw new Error('The decoded path is not allowed.');
  const pathname = decoded.replace(/\/{2,}/g, '/');
  return { pathname, match: pathname.toLowerCase(), params: url.searchParams, hash: url.hash, rest: url.search + url.hash, normalized: encodeURI(pathname) + url.search + url.hash };
}

/**
 * Classify a root-relative path the agent wants to open and decide whether it may be opened.
 * @returns {{ kind: 'list'|'form'|'workspace'|'portal', path: string, table?: string, needsTableCheck?: boolean, classic: boolean }}
 * Throws with a readable reason when the path is not a plain view of something.
 */
export function classifyPath(raw, depth = 0) {
  const { pathname, match, params, rest, normalized } = splitPath(raw);

  // Next Experience routes are client-side views. The classic wrapper is unwrapped and checked like any classic page.
  if (match.startsWith('/now/') || match === '/now') {
    const prefix = '/now/nav/ui/classic/params/target/';
    if (match.startsWith(prefix)) {
      if (depth > 2) throw new Error('The wrapped classic target is nested too deeply.');
      // Already decoded once by splitPath; the remainder is the classic page (it may carry its own ?query).
      const inner = pathname.slice(prefix.length).replace(/^\/+/, '');
      if (!inner) throw new Error('The wrapped classic target is empty.');
      return classifyPath(`/${inner}${params.toString() ? `${inner.includes('?') ? '&' : '?'}${params.toString()}` : ''}`, depth + 1);
    }
    // Anything else that names a classic target is a malformed wrapper: refuse rather than guess.
    if (/\/params\/target(\/|$)|\/classic(\/|$)|\.do(\/|$)/.test(match)) throw new Error('That Next Experience path wraps a classic page in an unexpected way. Give the classic page itself (e.g. /incident_list.do).');
    for (const [key, value] of params) if (hasScript(value) || hasScript(key)) throw new Error('The path may not contain script.');
    return { kind: 'workspace', path: normalized, classic: false };
  }

  const classic = match.match(/^\/([a-z][a-z0-9_]*)\.do$/);
  if (classic) {
    const name = classic[1];
    const isList = /_list$/i.test(name);
    const table = isList ? name.replace(/_list$/i, '') : name;
    for (const [key, value] of params) {
      if (!VIEW_PARAMS.has(key)) {
        throw new Error(`"${key}" is not allowed in a navigation URL (only view parameters such as sys_id, sysparm_query and sysparm_view are). Use the matching tool for actions.`);
      }
      if (key === 'sysparm_query' || key === 'sysparm_fixed_query') assertQuery(value);
      if (key === 'sys_id' && value !== '-1' && !SYS_ID_RE.test(value)) throw new Error('sys_id must be a 32-character sys_id or -1.');
    }
    if (!isList && !params.has('sys_id')) throw new Error(`A form URL needs sys_id (use /${table}.do?sys_id=<sys_id> or sys_id=-1 for a new record).`);
    // Processors (logout.do, cache.do, impersonate.do...) look like table pages; the caller checks the table really exists.
    return { kind: isList ? 'list' : 'form', path: encodeURI(match) + rest, table, needsTableCheck: true, classic: true, query: params.get('sysparm_query') || '' };
  }

  // Service Portal pages: /sp?id=page. Known portals pass; any other suffix must exist in sp_portal (the caller
  // checks needsPortalCheck), and processors that look like a single segment (logout, xmlhttp...) never pass.
  const portal = match.match(/^\/([a-z][a-z0-9_]*)$/);
  if (portal) {
    const suffix = portal[1];
    if (NOT_PORTALS.has(suffix)) throw new Error(`/${suffix} is not a page view.`);
    for (const [key, value] of params) if (hasScript(value) || hasScript(key)) throw new Error('The path may not contain script.');
    return { kind: 'portal', path: normalized, classic: false, suffix, needsPortalCheck: !KNOWN_PORTALS.has(suffix) };
  }

  throw new Error(
    'That path is not a plain page view. Allowed: /<table>_list.do?sysparm_query=..., /<table>.do?sys_id=..., /now/... (Next Experience) and portal pages (/sp?id=...). Use the structured arguments (table, sysId, query) when you can.'
  );
}

/**
 * The root-relative path for a navigate call. Exactly one of: path, table+sysId, table+newRecord, table (+query).
 * @returns {{ kind, path, table?, needsTableCheck?, classic, query? }}
 */
export function buildNavTarget(args = {}) {
  const { path, table, sysId, query, newRecord, view } = args;
  if (path) {
    if (table || sysId) throw new Error('Give either path or table/sysId, not both.');
    return classifyPath(path);
  }
  if (!table) throw new Error('navigate needs a table (with sysId, newRecord or query) or a path.');
  if (!TABLE_RE.test(table)) throw new Error(`"${table}" is not a valid table name.`);
  const viewPart = view ? `&sysparm_view=${encodeURIComponent(assertName(view, 'view'))}` : '';
  if (sysId) {
    if (!SYS_ID_RE.test(sysId)) throw new Error('sysId must be a 32-character sys_id.');
    return { kind: 'form', path: `/${table}.do?sys_id=${sysId}${viewPart}`, table, needsTableCheck: true, classic: true };
  }
  const q = assertQuery(query);
  if (newRecord) {
    // sysparm_query on a new record pre-fills fields; nothing is saved until the user (or save_form) submits.
    return { kind: 'form', path: `/${table}.do?sys_id=-1${q ? `&sysparm_query=${encodeURIComponent(q)}` : ''}${viewPart}`, table, needsTableCheck: true, classic: true, query: q };
  }
  return { kind: 'list', path: `/${table}_list.do${q ? `?sysparm_query=${encodeURIComponent(q)}` : ''}${q ? viewPart : viewPart.replace('&', '?')}`, table, needsTableCheck: true, classic: true, query: q };
}

function assertName(value, label) {
  const s = String(value || '');
  if (!/^[a-z0-9_]+$/i.test(s)) throw new Error(`${label} must be a plain name.`);
  return s;
}

// ---- UI actions ---------------------------------------------------------------------------------

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * One entry per distinct action: classic forms render the same buttons at the top and the bottom (same UI action
 * sys_id, or an id with a "_bottom" suffix). Entries with their own `key` (workspace buttons) are never merged.
 */
export function dedupeActions(actions = []) {
  const seen = new Map();
  for (const a of actions) {
    const key = a.key ?? (a.sysId ? `sys:${norm(a.sysId)}` : `${norm(String(a.actionName || a.id || '').replace(/_bottom$/i, ''))}|${norm(a.label)}`);
    if (!seen.has(key)) seen.set(key, a);
  }
  return [...seen.values()];
}

/**
 * Find the UI action the caller means: exact action name / element id / UI action sys_id first, then the exact
 * visible label (case and spacing ignored). Never a fuzzy match: clicking the wrong button is worse than asking.
 * @returns {{ action: object }} or throws with the list of choices
 */
export function matchUiAction(actions, wanted) {
  const w = norm(wanted);
  if (!w) throw new Error('Say which UI action to run (its label, e.g. "Resolve", or action name, e.g. "sysverb_update").');
  const list = dedupeActions(actions);
  const byName = list.filter((a) => [a.actionName, a.id, a.sysId].some((v) => v && norm(v) === w));
  const byLabel = byName.length ? [] : list.filter((a) => norm(a.label) === w);
  const hits = byName.length ? byName : byLabel;
  const choices = list.slice(0, 30).map((a) => `"${a.label}"${a.actionName ? ` (${a.actionName})` : ''}`).join(', ');
  if (!hits.length) throw new Error(`No UI action "${wanted}" on this page.${choices ? ` Available: ${choices}.` : ' No UI action buttons were found.'}`);
  if (hits.length > 1) throw new Error(`"${wanted}" matches ${hits.length} buttons (${hits.map((a) => `"${a.label}"${a.actionName ? ` (${a.actionName})` : ''}`).join(', ')}). Use the action name.`);
  return { action: hits[0] };
}

// ---- Record writes -------------------------------------------------------------------------------

const CODE_COLUMN_RE = /^(script|operation_script|processing_script|client_script|script_true|script_false|condition|advanced_condition|html|template|script_plain)$/;
export const isCodeColumn = (name) => CODE_COLUMN_RE.test(String(name || ''));

/**
 * Why a value must not be written because it still carries the redaction placeholder, or null. The model only ever
 * saw "[REDACTED]" where a secret was; writing that back would destroy the real value. In code, only a placeholder
 * standing where a secret goes is refused (a sanitiser may legitimately contain the word); elsewhere any is.
 */
export function placeholderProblem(name, value, { code = isCodeColumn(name) } = {}) {
  const s = String(value ?? '');
  if (!s.includes(REDACTED)) return null;
  const { secret } = findRedactionPlaceholders(s);
  if (secret.length) {
    return `"${name}" still holds the ${REDACTED} placeholder where a secret was (line ${secret.join(', ')}). Writing it would replace the real secret: keep the original value or ask the user for it. Nothing was written.`;
  }
  if (!code) return `"${name}" contains the ${REDACTED} placeholder that hid a value from you; writing it would overwrite the real value. Leave the field out or ask the user. Nothing was written.`;
  return null;
}

/** The first placeholder problem among the fields of a write, or null. */
export function placeholderProblemIn(fields = {}) {
  for (const [k, v] of Object.entries(fields || {})) {
    const problem = placeholderProblem(k, v);
    if (problem) return problem;
  }
  return null;
}

export const PROTECTED_COLUMNS = new Set(['sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by', 'sys_mod_count', 'sys_class_name']);
// System columns that are bookkeeping, not data: dropped from a snapshot that is re-inserted on undo.
const BOOKKEEPING = new Set(['sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by', 'sys_mod_count', 'sys_tags']);

/** Plain values only: a nested object is never a valid Table API field value. */
export function normalizeFieldValues(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('fields must be an object of column: value.');
  const keys = Object.keys(fields);
  if (!keys.length) throw new Error('fields is empty.');
  if (keys.length > 100) throw new Error('Too many fields in one write (limit 100).');
  const out = {};
  for (const key of keys) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(key)) throw new Error(`"${key}" is not a column name.`);
    if (PROTECTED_COLUMNS.has(key)) throw new Error(`Field "${key}" is managed by the platform and may not be written.`);
    const v = fields[key];
    if (v === null || v === undefined) out[key] = '';
    else if (typeof v === 'string') out[key] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = String(v);
    else throw new Error(`Field "${key}" must be a string, number or boolean.`);
    if (out[key].length > 500000) throw new Error(`Field "${key}" is too large.`);
  }
  return out;
}

const flat = (v) => (v && typeof v === 'object' ? (v.value ?? v.display_value ?? '') : v == null ? '' : String(v));

/** Field-level before/after rows for an update, skipping fields that would not change. */
export function diffRecord(before = {}, after = {}, labels = {}) {
  return Object.keys(after)
    .filter((k) => flat(before[k]) !== flat(after[k]))
    .map((k) => ({ field: k, label: labels[k] || k, before: flat(before[k]), after: flat(after[k]) }));
}

/**
 * The record as it will be re-inserted by undo after a delete: every data column, the same sys_id, and none of the
 * bookkeeping columns the platform sets itself.
 */
export function snapshotForReinsert(record = {}) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (BOOKKEEPING.has(k)) continue;
    const value = flat(v);
    if (value === '' && k !== 'sys_id') continue;
    out[k] = value;
  }
  return out;
}

// ---- Page snapshots ------------------------------------------------------------------------------

/** { table, sysId } of a Next Experience workspace record route (/now/<workspace>/record/<table>/<sys_id>...). */
export function parseWorkspaceRecord(path) {
  const m = String(path || '').match(/\/record\/([a-z][a-z0-9_]*)\/([0-9a-f]{32})(?:[/?#]|$)/i);
  return m ? { table: m[1], sysId: m[2] } : null;
}

/** What kind of page is on screen. Classic content (top-level or in the shell's frame) wins over the shell around it. */
export function classifyPageKind({ topPath = '', hasForm = false, hasList = false } = {}) {
  if (hasForm) return 'form';
  if (hasList) return 'list';
  let pathname = '';
  let params = new URLSearchParams();
  try {
    const url = new URL(String(topPath || '/'), 'https://instance.invalid');
    pathname = url.pathname;
    params = url.searchParams;
  } catch {
    return 'other';
  }
  if (pathname.startsWith('/now/')) return 'workspace';
  const portal = pathname.match(/^\/([a-z][a-z0-9_]*)$/i);
  if (portal && (params.has('id') || ['sp', 'esc', 'csm', 'hrm'].includes(portal[1].toLowerCase()))) return 'portal';
  return 'other';
}

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}...` : t;
};

/** A few lines describing a read_page result: what tools such as navigate and click_ui_action return. */
export function summarizePage(page) {
  if (!page || typeof page !== 'object') return null;
  const out = { kind: page.kind, title: page.title || null, path: page.contentPath || page.path || null };
  if (page.table) out.table = page.table;
  if (page.sysId) out.sysId = page.sysId;
  if (page.isNewRecord) out.isNewRecord = true;
  if (page.messages?.length) out.messages = page.messages.slice(0, 6).map((m) => `${m.type}: ${clip(m.text, 200)}`);
  if (page.uiActions?.length) out.uiActions = page.uiActions.slice(0, 20).map((a) => a.label);
  if (page.form) out.fieldCount = page.form.fieldCount;
  if (page.form?.dirty) out.unsavedChanges = true;
  if (page.list) out.list = { table: page.list.table, query: page.list.query, rowsShown: page.list.rows?.length ?? 0 };
  if (page.dialog) out.dialog = page.dialog;
  return out;
}

/** Messages that appeared after an action (by text), so the result says what the platform answered. */
export function newMessages(before = [], after = []) {
  const seen = new Set(before.map((m) => `${m.type}|${m.text}`));
  return after.filter((m) => !seen.has(`${m.type}|${m.text}`));
}

// ---- Misc ------------------------------------------------------------------------------------------

/** Stable short hash (FNV-1a) used to remember which scripts were dry-run in this session. */
export function hashText(text) {
  let h = 0x811c9dc5;
  const s = String(text || '').replace(/\r\n/g, '\n').trim();
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** CI/CD progress status codes (sn_cicd): 0 pending, 1 running, 2 successful, 3 failed, 4 canceled. */
export function atfState(status) {
  const s = String(status ?? '').toLowerCase();
  if (s === '2' || s === 'successful' || s === 'success') return 'successful';
  if (s === '3' || s === 'failed' || s === 'failure') return 'failed';
  if (s === '4' || s === 'canceled' || s === 'cancelled') return 'canceled';
  if (s === '1' || s === 'running') return 'running';
  return 'pending';
}
