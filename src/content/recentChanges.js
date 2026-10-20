// "What changed lately?", the instance half. Reads configuration changes by anyone from sys_update_xml (the update set the
// change sits in comes with it through the update_set.name dot-walk), adds who saved each record last and the version to
// compare with from sys_update_version, and remembers when the user last looked, per instance. Read-only.
// The pure half is src/lib/recentChanges.js; the panel is src/sidebar/RecentChangesPanel.jsx.

import { queryTable, countRecords, queryInChunks } from './tableApi.js';
import { currentUser } from './myWork.js';
import { fetchVersionList, diffVersions } from './versions.js';
import { getUiState, saveUiState } from './storage.js';
import { buildChangesQuery, windowClause, shapeChange, isSystemUser } from '../lib/recentChanges.js';

const FEED_LIMIT = 200;
const VERSION_NAMES = 60; // versions are looked up for the newest rows only
const SEEN_KEY = 'recentChangesSeen';

const FIELDS = [
  'sys_id',
  'name',
  'type',
  'target_name',
  'action',
  'update_set',
  'update_set.name',
  'application',
  'application.name',
  'sys_updated_on',
  'sys_updated_by',
  'sys_created_by',
];

async function readMarker() {
  const state = await getUiState();
  return state[SEEN_KEY]?.[window.location.hostname] || '';
}

/** Versions of the listed update names, newest first per name: { [name]: [{ id, by, at, source }] }. */
async function versionsByName(names) {
  if (!names.length) return {};
  const rows = await queryInChunks('sys_update_version', 'name', names, ['sys_id', 'name', 'sys_recorded_at', 'sys_created_by', 'source', 'state'], { chunkSize: 15, limit: 120 });
  const out = {};
  rows
    .sort((a, b) => String(b.sys_recorded_at).localeCompare(String(a.sys_recorded_at)))
    .forEach((r) => {
      (out[r.name] ||= []).push({ id: r.sys_id, by: r.sys_created_by || '', at: r.sys_recorded_at || '', source: r.source || '' });
    });
  return out;
}

/**
 * @param {{ window?: string, days?: number, scope?: 'all'|'others'|'me', application?: string, type?: string, hideSystem?: boolean }} options
 * @returns {Promise<{ rows: object[], total: number|null, truncated: boolean, userName: string, windowLabel: string, marker: string, host: string, errors: string[] }>}
 */
export async function loadRecentChanges(options = {}) {
  const { hideSystem = true } = options;
  const errors = [];
  const user = await currentUser().catch(() => null);
  const userName = user?.userName || '';
  if ((options.scope === 'others' || options.scope === 'me') && !userName) {
    throw new Error('Could not tell who you are, so "only me" and "only others" are not available. Choose Everyone.');
  }
  const query = buildChangesQuery({ ...options, userName });
  const [raw, total, marker] = await Promise.all([
    queryTable('sys_update_xml', query, FIELDS, { limit: FEED_LIMIT }),
    countRecords('sys_update_xml', query.replace(/\^ORDERBYDESCsys_updated_on$/, '')).catch(() => null),
    readMarker().catch(() => ''),
  ]);

  let rows = raw.map((r) => shapeChange(r));
  if (hideSystem) rows = rows.filter((r) => !isSystemUser(r.who));

  // Who saved each record last, and the version to compare with: only for the newest rows, they are the ones people open.
  try {
    const versions = await versionsByName([...new Set(rows.slice(0, VERSION_NAMES).map((r) => r.name))].filter((n) => /^[a-z0-9_]+$/i.test(n)));
    // Rows beyond the lookup keep versionCount undefined: the panel then lets the user try the comparison.
    rows = rows.map((r, i) => {
      if (i >= VERSION_NAMES) return r;
      const list = versions[r.name] || [];
      return { ...r, versionCount: list.length, latestVersion: list[0] || null, previousVersion: list[1] || null };
    });
  } catch (err) {
    errors.push(`Versions could not be read, so "compare" is unavailable: ${err.message || err}`);
  }

  return {
    rows,
    total: total ?? null,
    truncated: raw.length >= FEED_LIMIT || (total != null && total > raw.length),
    userName,
    windowLabel: windowClause(options.window || 'today', options.days).label,
    marker,
    host: window.location.hostname,
    errors,
  };
}

/** Field-by-field changes between a record's two newest versions, ready for the panel's diff view. */
export async function diffLatestVersions({ table, sysId }) {
  const versions = await fetchVersionList(table, sysId, { limit: 2 });
  if (versions.length < 2) return { changes: [], note: 'Only one version of this record is recorded, so there is nothing to compare it with.' };
  const [newer, older] = versions;
  const changes = await diffVersions(older.sys_id, newer.sys_id);
  return { changes, from: { at: older.sys_recorded_at, by: older.sys_created_by }, to: { at: newer.sys_recorded_at, by: newer.sys_created_by }, note: '' };
}

/** Remember that the user has seen everything up to `marker` on this instance. */
export async function markRecentChangesSeen(marker) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(marker || '')) return false;
  const state = await getUiState();
  const seen = { ...(state[SEEN_KEY] || {}), [window.location.hostname]: marker };
  await saveUiState({ [SEEN_KEY]: seen });
  return true;
}

export const recentChangesServices = {
  recentChangesLoad: (options) => loadRecentChanges(options),
  recentChangesDiff: (args) => diffLatestVersions(args),
  recentChangesMarkSeen: (marker) => markRecentChangesSeen(marker),
};
