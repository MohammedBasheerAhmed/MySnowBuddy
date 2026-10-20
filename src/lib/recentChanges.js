// "What changed lately?": configuration changes by anyone, from sys_update_xml, as a feed a developer can scan after
// "it worked yesterday". Pure and deterministic: the query, the plain-English headlines, grouping by application / person /
// type, the "since I last looked" marker and what touches the record on screen. The instance half is
// src/content/recentChanges.js, the panel src/sidebar/RecentChangesPanel.jsx.

import { parseUpdateName } from './updateSetReview.js';

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const USER_RE = /^[A-Za-z0-9_.@+-]{1,80}$/;
const TYPE_RE = /^[A-Za-z0-9 _/().&-]{1,60}$/;

export const WINDOWS = [
  { id: '1h', label: 'Last hour' },
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: 'custom', label: 'Last N days' },
];

export const SCOPES = [
  { id: 'all', label: 'Everyone' },
  { id: 'others', label: 'Only others' },
  { id: 'me', label: 'Only me' },
];

export const GROUPINGS = [
  { id: 'application', label: 'Application' },
  { id: 'person', label: 'Person' },
  { id: 'type', label: 'Type' },
  { id: 'none', label: 'None (newest first)' },
];

/** Users that write updates without being a person. */
export const SYSTEM_USERS = new Set(['system', 'guest', 'maint']);

// --- The query -------------------------------------------------------------------------------------------

/** { clause, label, days } for a window. The instance evaluates the gs.* helpers, so no clock or time zone is assumed here. */
export function windowClause(kind, days = 7) {
  if (kind === '1h') return { clause: 'sys_updated_on>=javascript:gs.hoursAgo(1)', label: 'the last hour', days: 0 };
  if (kind === 'today') return { clause: 'sys_updated_on>=javascript:gs.beginningOfToday()', label: 'today', days: 0 };
  const n = Math.min(Math.max(Math.round(Number(kind === '7d' ? 7 : days)) || 7, 1), 90);
  return { clause: `sys_updated_on>=javascript:gs.daysAgoStart(${n})`, label: n === 1 ? 'the last day' : `the last ${n} days`, days: n };
}

/**
 * Encoded query for sys_update_xml. Anything that is not a plain user name, sys_id or type label is dropped, so a value
 * can never smuggle a condition in.
 */
export function buildChangesQuery({ window: win = 'today', days = 7, scope = 'all', userName = '', application = '', type = '' } = {}) {
  const parts = [windowClause(win, days).clause];
  if (scope === 'others' && USER_RE.test(userName)) parts.push(`sys_updated_by!=${userName}`);
  if (scope === 'me' && USER_RE.test(userName)) parts.push(`sys_updated_by=${userName}`);
  if (SYS_ID_RE.test(application) || application === 'global') parts.push(`application=${application}`);
  if (TYPE_RE.test(type)) parts.push(`type=${type}`);
  parts.push('ORDERBYDESCsys_updated_on');
  return parts.join('^');
}

// --- Rows ------------------------------------------------------------------------------------------------

const refValue = (v) => (v && typeof v === 'object' ? v.value || '' : String(v ?? ''));

/** One sys_update_xml row in the shape the panel uses. `sets` maps update set sys_id to its name. */
export function shapeChange(raw, sets = {}) {
  const { table, sysId } = parseUpdateName(raw.name);
  const setId = refValue(raw.update_set);
  const appName = raw['application.name'] || (raw.application && typeof raw.application === 'object' ? raw.application.display_value : '') || '';
  return {
    id: raw.sys_id,
    name: raw.name || '',
    table,
    sysId,
    type: String(raw.type || '').trim(),
    target: raw.target_name || '',
    action: String(raw.action || '').toUpperCase(),
    who: raw.sys_updated_by || raw.sys_created_by || '',
    when: raw.sys_updated_on || '',
    setId,
    setName: sets[setId] || (raw['update_set.name'] ?? ''),
    appId: refValue(raw.application),
    appName: appName || (refValue(raw.application) === 'global' ? 'Global' : ''),
  };
}

export const isSystemUser = (who) => SYSTEM_USERS.has(String(who || '').toLowerCase());

/** "Business Rule "Abort addition of parent" updated by beth.anglin in update set Fix duplicates". */
export function headline(row) {
  const verb = row.action === 'DELETE' ? 'deleted' : 'updated';
  const what = `${row.type || 'Record'} "${row.target || row.name}"`;
  return `${what} ${verb} by ${row.who || 'someone'}${row.setName ? ` in update set ${row.setName}` : ''}`;
}

// --- Grouping --------------------------------------------------------------------------------------------

const groupKey = {
  application: (r) => r.appName || 'No application',
  person: (r) => r.who || 'Unknown',
  type: (r) => r.type || 'Other',
};

/** [{ key, count, rows }] largest group first (ties alphabetical); rows keep their order (newest first). */
export function groupChanges(rows, by = 'application') {
  if (by === 'none' || !groupKey[by]) return [{ key: '', count: rows.length, rows }];
  const map = new Map();
  rows.forEach((row) => {
    const key = groupKey[by](row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return [...map.entries()].map(([key, list]) => ({ key, count: list.length, rows: list })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** The distinct values of a column, for the filter lists: [{ value, label, count }]. */
export function facet(rows, by) {
  const counts = new Map();
  rows.forEach((row) => {
    const value = by === 'application' ? row.appId || '' : by === 'type' ? row.type : row.who;
    if (!value) return;
    const label = by === 'application' ? row.appName || value : value;
    const entry = counts.get(value) || { value, label, count: 0 };
    entry.count += 1;
    counts.set(value, entry);
  });
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// --- Since I last looked -------------------------------------------------------------------------------------

/** True when the row changed after the marker (both "YYYY-MM-DD HH:MM:SS", so text order is time order). No marker: nothing is new. */
export function isNewSince(row, marker) {
  return Boolean(marker) && Boolean(row.when) && row.when > marker;
}

/** The marker to store after the user has seen `rows`: the newest change time, never going backwards. */
export function nextMarker(rows, current = '') {
  const newest = rows.reduce((max, r) => (r.when > max ? r.when : max), '');
  return newest > current ? newest : current;
}

// --- What touches the record on screen ----------------------------------------------------------------------

/**
 * 'record' when this change is to the record on screen, 'table' when it plainly concerns its table (a dictionary entry or an
 * artifact named after it), else ''. `ctx` is { table, sysId }.
 */
export function relevance(row, ctx = {}) {
  const table = String(ctx.table || '');
  if (!table) return '';
  if (row.table === table && row.sysId && ctx.sysId && row.sysId === String(ctx.sysId).toLowerCase()) return 'record';
  if (row.name.startsWith(`sys_dictionary_${table}_`) || row.name === `sys_db_object_${table}`) return 'table';
  const mention = new RegExp(`(^|[^a-z0-9_])${table}([^a-z0-9_]|$)`);
  return mention.test(row.target) ? 'table' : '';
}

// --- Plain-text age and export -------------------------------------------------------------------------------

/** "5 min ago" for a sys_updated_on value (the instance stores UTC). */
export function ageText(when, nowMs = Date.now()) {
  const t = Date.parse(`${String(when).replace(' ', 'T')}Z`);
  if (!Number.isFinite(t)) return when || '';
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const md = (s) => String(s ?? '').replace(/([\\`*_[\]<>|])/g, '\\$1').replace(/\s+/g, ' ').trim();

/** The feed as Markdown, for a ticket or a chat message. */
export function changesToMarkdown(rows, { windowLabel = '', host = '', by = 'application' } = {}) {
  const lines = [`# What changed${windowLabel ? ` in ${windowLabel}` : ''}`, ''];
  if (host) lines.push(`Instance: ${md(host)}  `);
  lines.push(`${rows.length} change${rows.length === 1 ? '' : 's'}`, '');
  groupChanges(rows, by).forEach((g) => {
    if (g.key) lines.push(`## ${md(g.key)} (${g.count})`);
    g.rows.forEach((r) => lines.push(`- ${md(headline(r))} (${md(r.when)} UTC)`));
    lines.push('');
  });
  return lines.join('\n');
}
