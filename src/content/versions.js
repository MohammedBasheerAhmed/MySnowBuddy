// Version history: list the versions of a record and diff two of them.

import { queryTable } from './tableApi.js';
import { diffLines, collapseDiff, hasChanges } from '../lib/diff.js';
import { parseVersionPayload, changedFields } from '../lib/versionPayload.js';

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const NOISE_FIELDS = new Set(['sys_mod_count', 'sys_updated_on', 'sys_updated_by', 'sys_created_on', 'sys_created_by']);

/** Versions of one record, newest first (payloads are not fetched here - they are large). */
export async function fetchVersionList(table, sysId, { limit = 30 } = {}) {
  if (!/^[a-z0-9_]+$/i.test(table || '') || !SYS_ID_RE.test(sysId || '')) {
    throw new Error('Open a saved record first.');
  }
  return queryTable(
    'sys_update_version',
    `name=${table}_${sysId}^ORDERBYDESCsys_recorded_at`,
    ['sys_id', 'sys_recorded_at', 'sys_created_by', 'source', 'state', 'action'],
    { limit }
  );
}

async function loadPayload(versionSysId) {
  if (!SYS_ID_RE.test(versionSysId || '')) throw new Error('Invalid version.');
  const rows = await queryTable('sys_update_version', `sys_id=${versionSysId}`, ['payload'], { limit: 1 });
  if (!rows.length) throw new Error('That version could not be read.');
  return parseVersionPayload(rows[0].payload);
}

/**
 * Field-by-field changes going from `fromId` (older) to `toId` (newer).
 * @returns {Promise<Array<{name, before, after, rows: object[]}>>}
 */
export async function diffVersions(fromId, toId) {
  const [from, to] = await Promise.all([loadPayload(fromId), loadPayload(toId)]);
  return changedFields(from.fields, to.fields)
    .filter((c) => !NOISE_FIELDS.has(c.name))
    .map((c) => {
      const diff = diffLines(c.before, c.after);
      return { ...c, rows: hasChanges(diff) ? collapseDiff(diff, 3) : [] };
    });
}
