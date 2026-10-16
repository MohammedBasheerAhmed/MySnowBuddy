// SN-Utils-style quick actions: navigation, clipboard, instance/session info,
// form helpers and update set switching.
//
// SECURITY: every navigation target is a root-relative path on the instance
// the user is already signed into. `safePath()` rejects absolute URLs,
// protocol-relative URLs and traversal, so a malicious page cannot use the
// palette to bounce an authenticated user somewhere else.

import { queryTable, fetchRecord } from './tableApi.js';
import { sessionHeaders } from './sessionToken.js';
import { instanceGuard } from '../lib/agent/policy.js';

const SYS_ID_RE = /^[0-9a-f]{32}$/i;

export function isSysId(value) {
  return SYS_ID_RE.test((value || '').trim());
}

/** Validate a root-relative instance path. Throws on anything off-origin. */
export function safePath(rawPath) {
  const path = (rawPath || '').trim();
  if (!path.startsWith('/')) throw new Error('Navigation target must start with "/".');
  if (path.startsWith('//')) throw new Error('Protocol-relative targets are not allowed.');
  if (path.includes('..')) throw new Error('Path traversal is not allowed.');

  const resolved = new URL(path, window.location.origin);
  if (resolved.origin !== window.location.origin) {
    throw new Error('Navigation must stay on the current instance.');
  }
  return resolved.pathname + resolved.search + resolved.hash;
}

/**
 * True when the page is the Next Experience (Polaris) shell, where classic
 * `.do` targets have to be wrapped so they open inside the shell rather than
 * replacing it.
 */
export function isNextExperience() {
  return window.location.pathname.startsWith('/now/');
}

/** Wrap a classic `.do` target for whichever UI shell is currently loaded. */
export function shellUrl(target) {
  const path = safePath(target);
  if (!isNextExperience()) return path;
  // Polaris opens classic targets through its own router; the target is a
  // single encoded path segment.
  return `/now/nav/ui/classic/params/target/${encodeURIComponent(path.replace(/^\//, ''))}`;
}

export function listUrl(table, query = '') {
  const q = query ? `?sysparm_query=${encodeURIComponent(query)}` : '';
  return `/${table}_list.do${q}`;
}

export function recordUrl(table, sysId) {
  return `/${table}.do?sys_id=${encodeURIComponent(sysId)}`;
}

export function newRecordUrl(table) {
  return `/${table}.do?sys_id=-1`;
}

export function xmlUrl(table, sysId) {
  return `/${table}.do?sys_id=${encodeURIComponent(sysId)}&XML`;
}

/** Absolute URL for sharing — always built from the current origin. */
export function absoluteUrl(target) {
  return `${window.location.origin}${safePath(target)}`;
}

export function navigate(target, { newTab = false, raw = false } = {}) {
  const url = raw ? safePath(target) : shellUrl(target);
  if (newTab) {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else {
    window.location.assign(url);
  }
}

// --- Clipboard -------------------------------------------------------------

export async function copyText(text) {
  const value = String(text ?? '');
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (err) {
    // Clipboard API needs a focused document and can be blocked by policy.
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Clipboard write was blocked by the browser.');
    return true;
  }
}

// --- Instance identity -----------------------------------------------------

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

// Known-instance labels (palette "add instance"), cached so getInstanceInfo stays synchronous. A label can only
// RAISE the write guard: a host the user labelled PROD is production for every writer (agent, MCP, My Work), even
// when its hostname reads like dev or test. One rule for all of them: policy.instanceGuard.
const KNOWN_INSTANCES_KEY = 'mysnowbuddy_known_instances';
let knownLabels = new Map();
export function rememberKnownInstances(list) {
  knownLabels = new Map((Array.isArray(list) ? list : []).map((i) => [String(i?.host || '').toLowerCase(), String(i?.label || '')]));
}
try {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    Promise.resolve(chrome.storage.local.get(KNOWN_INSTANCES_KEY))
      .then((r) => rememberKnownInstances(r?.[KNOWN_INSTANCES_KEY]))
      .catch(() => {});
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && changes[KNOWN_INSTANCES_KEY]) rememberKnownInstances(changes[KNOWN_INSTANCES_KEY].newValue);
    });
  }
} catch {
  // No extension storage here (tests, other contexts): hostname rules only.
}

export function getInstanceInfo() {
  const host = window.location.hostname;
  const instance = host.split('.')[0] || host;
  const match = classifyEnvironment(instance);
  const guard = instanceGuard({ env: match ? match.env : 'unknown', label: knownLabels.get(host.toLowerCase()) || '' });
  return {
    host,
    instance,
    env: guard.env,
    guarded: guard.guarded,
    label: match ? match.label : instance.slice(0, 8).toUpperCase(),
    tone: guard.raisedByLabel ? 'danger' : match ? match.tone : 'neutral',
  };
}

/** Node / session details, read from the instance's own stats endpoints. */
export async function getNodeInfo() {
  const response = await fetch('/stats.do', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`stats.do returned ${response.status}`);
  const text = await response.text();
  const grab = (label) => {
    const m = text.match(new RegExp(`${label}[^:]*:\\s*([^<\\n]+)`, 'i'));
    return m ? m[1].trim() : null;
  };
  return {
    node: grab('Instance name') || grab('Node'),
    build: grab('Build name'),
    buildDate: grab('Build date'),
    version: grab('Build tag'),
  };
}

// --- Record helpers --------------------------------------------------------

/**
 * Resolve a bare sys_id to a record. sys_metadata covers every configuration
 * artifact; task and sys_user cover the records people paste most often.
 */
export async function findRecordBySysId(sysId, contextTable = '') {
  const probes = [
    ...(contextTable ? [contextTable] : []),
    'sys_metadata',
    'task',
    'sys_user',
    'cmdb_ci',
  ];

  for (const table of probes) {
    try {
      // eslint-disable-next-line no-await-in-loop -- probes are ordered by
      // likelihood; we want to stop at the first hit, not query all of them.
      const rows = await queryTable(table, `sys_id=${sysId}`, ['sys_id', 'sys_class_name', 'name', 'sys_name', 'short_description'], {
        limit: 1,
      });
      if (rows.length) {
        return { table: rows[0].sys_class_name || table, sysId, name: rows[0].name || rows[0].sys_name || rows[0].short_description || '' };
      }
    } catch (err) {
      // Table not readable on this instance/role; try the next probe. An expired session fails every probe, so say so.
      if (err?.code === 'SESSION_EXPIRED') throw err;
    }
  }
  return null;
}

const AUDIT_FIELDS = [
  'sys_id',
  'sys_created_by',
  'sys_created_on',
  'sys_updated_by',
  'sys_updated_on',
  'sys_mod_count',
  'sys_scope',
  'sys_package',
  'sys_class_name',
];

/** "Who touched this record" — the details people usually open the XML for. */
export async function getRecordInfo(table, sysId) {
  const record = await fetchRecord(table, sysId, AUDIT_FIELDS);
  if (!record) return null;
  return {
    table,
    sysId,
    createdBy: record.sys_created_by,
    createdOn: record.sys_created_on,
    updatedBy: record.sys_updated_by,
    updatedOn: record.sys_updated_on,
    updates: record.sys_mod_count,
    className: record.sys_class_name || table,
  };
}

// --- Form helpers ----------------------------------------------------------

/**
 * Documents that can contain a ServiceNow form. Classic UI renders the form
 * inside the same-origin `gsft_main` iframe, which the content script can
 * reach through `contentDocument` even though it only mounts in the top frame.
 */
export function formDocuments() {
  const docs = [document];
  const frame = document.getElementById('gsft_main');
  try {
    if (frame && frame.contentDocument) docs.push(frame.contentDocument);
  } catch (err) {
    // Cross-origin frame; nothing we can read.
  }
  return docs;
}

const TECH_NAME_ATTR = 'data-msb-tech-name';

/**
 * Toggle the technical (database) field name next to every form label.
 * Purely presentational and fully reversible — no form values are touched.
 *
 * @returns {{enabled: boolean, count: number}}
 */
export function toggleTechnicalNames() {
  const existing = formDocuments().flatMap((doc) =>
    Array.from(doc.querySelectorAll(`[${TECH_NAME_ATTR}]`))
  );

  if (existing.length) {
    existing.forEach((el) => el.remove());
    return { enabled: false, count: existing.length };
  }

  let count = 0;
  formDocuments().forEach((doc) => {
    doc.querySelectorAll('label[id^="label."], label[for]').forEach((label) => {
      const field = fieldNameFromLabel(label);
      if (!field) return;
      const tag = doc.createElement('span');
      tag.setAttribute(TECH_NAME_ATTR, '1');
      tag.textContent = ` ${field}`;
      tag.style.cssText =
        'font-family:ui-monospace,Consolas,monospace;font-size:10px;font-weight:500;' +
        'color:#5c6bc0;background:#eef1ff;border-radius:3px;padding:0 4px;margin-left:4px;';
      label.appendChild(tag);
      count += 1;
    });
  });

  return { enabled: count > 0, count };
}

export function fieldNameFromLabel(label) {
  // Classic labels are `label.<table>.<field>`; the `for` attribute is
  // `<table>.<field>` or `sys_display.<table>.<field>` for references.
  const id = label.id || '';
  if (id.startsWith('label.')) {
    const parts = id.split('.');
    return parts[parts.length - 1] || null;
  }
  const target = label.getAttribute('for') || '';
  const parts = target.split('.');
  if (parts.length < 2) return null;
  return parts[parts.length - 1] || null;
}

// --- Update sets -----------------------------------------------------------

/** Update sets the user could switch to, newest first. */
export async function fetchSelectableUpdateSets(limit = 25) {
  return queryTable(
    'sys_update_set',
    'state=in progress^ORDERBYDESCsys_updated_on',
    ['sys_id', 'name', 'application', 'state', 'sys_updated_on'],
    { limit }
  );
}

/**
 * Switch the session's current update set.
 *
 * NOTE: this is the one write this module performs, and it is the same call
 * the platform's own update set picker makes. Endpoint shape is unverified
 * against a live instance — see docs/decisions.md.
 */
export async function setCurrentUpdateSet(sysId, csrfToken) {
  const response = await fetch('/api/now/ui/concoursepicker/updateset', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: await sessionHeaders({
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-UserToken': csrfToken } : {}),
    }),
    body: JSON.stringify({ sysparm_sys_id: sysId }),
  });
  if (!response.ok) {
    throw new Error(`Update set switch failed (${response.status}).`);
  }
  return true;
}

/**
 * Switch the session's current application ("global" for the global scope). Same call as the
 * platform's application picker; endpoint shape is unverified against a live instance.
 */
export async function setCurrentApplication(appId, csrfToken) {
  const response = await fetch('/api/now/ui/concoursepicker/application', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: await sessionHeaders({
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-UserToken': csrfToken } : {}),
    }),
    body: JSON.stringify({ app_id: appId }),
  });
  if (!response.ok) throw new Error(`Application switch failed (${response.status}).`);
  return true;
}

/** The update set currently selected for this session, if readable. */
export async function getCurrentUpdateSet() {
  try {
    const response = await fetch('/api/now/ui/concoursepicker/updateset', {
      credentials: 'same-origin',
      headers: await sessionHeaders(),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const current = data?.result?.current;
    return current ? { sysId: current.sysId || current.sys_id, name: current.name } : null;
  } catch (err) {
    return null;
  }
}

// --- Table configuration shortcuts ----------------------------------------

/**
 * The "show me everything configured on this table" set — the single most
 * used SN Utils capability. Each entry is a filtered list URL.
 */
export function tableConfigTargets(table) {
  return [
    { label: 'Dictionary', url: listUrl('sys_dictionary', `name=${table}^ORDERBYelement`) },
    { label: 'Business Rules', url: listUrl('sys_script', `collection=${table}`) },
    { label: 'Client Scripts', url: listUrl('sys_script_client', `table=${table}`) },
    { label: 'UI Actions', url: listUrl('sys_ui_action', `table=${table}`) },
    { label: 'UI Policies', url: listUrl('sys_ui_policy', `table=${table}`) },
    // "incident" and "incident.field", not incident_task.* (nameSTARTSWITHincident matched those too).
    { label: 'ACLs', url: listUrl('sys_security_acl', `name=${table}^ORnameSTARTSWITH${table}.`) },
    { label: 'Data Policies', url: listUrl('sys_data_policy2', `model_table=${table}`) },
    { label: 'Notifications', url: listUrl('sysevent_email_action', `collection=${table}`) },
    { label: 'Form Layouts', url: listUrl('sys_ui_section', `name=${table}`) },
    { label: 'List Layouts', url: listUrl('sys_ui_list', `name=${table}`) },
    { label: 'Related Lists', url: listUrl('sys_ui_related_list', `name=${table}`) },
    { label: 'Table definition', url: listUrl('sys_db_object', `name=${table}`) },
    { label: 'Field labels', url: listUrl('sys_documentation', `name=${table}`) },
    { label: 'Choices', url: listUrl('sys_choice', `name=${table}^ORDERBYelement`) },
    { label: 'Audit history', url: listUrl('sys_audit', `tablename=${table}^ORDERBYDESCsys_created_on`) },
  ];
}
