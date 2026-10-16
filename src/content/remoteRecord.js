// Compare the record on screen with the same record on another instance.
// The fetch itself happens in the service worker (content scripts are bound to
// the page's own origin).

import { queryTable } from './tableApi.js';
import { diffLines, collapseDiff, hasChanges } from '../lib/diff.js';
import { changedFields } from '../lib/versionPayload.js';
import { normalizeHost } from './stores.js';

// Per-instance bookkeeping that always differs and says nothing about the artifact.
const IGNORED = new Set([
  'sys_id',
  'sys_created_on',
  'sys_created_by',
  'sys_updated_on',
  'sys_updated_by',
  'sys_mod_count',
  'sys_package',
  'sys_policy',
  'sys_update_name',
]);

const text = (value) => (value === undefined || value === null ? '' : String(value));

export function remoteRecordUrl(host, table, sysId) {
  return `https://${normalizeHost(host)}/${encodeURIComponent(table)}.do?sys_id=${encodeURIComponent(sysId)}`;
}

/**
 * @returns {Promise<{host: string, found: boolean, matchedBy?: string, remoteSysId?: string, changes?: object[]}>}
 */
export async function compareWithInstance({ host, table, sysId }) {
  const normalized = normalizeHost(host);
  const [local] = await queryTable(table, `sys_id=${sysId}`, [], { limit: 1 });
  if (!local) throw new Error('The local record could not be read.');

  // Only tables with a name column can be matched by name (a condition on a missing column is ignored).
  const name = typeof local.name === 'string' && local.name ? local.name : undefined;
  const response = await chrome.runtime.sendMessage({
    type: 'FETCH_REMOTE_RECORD',
    payload: { instanceUrl: normalized, table, sysId, name },
  });
  if (!response?.ok) throw new Error(response?.error || 'Could not reach the other instance.');
  if (!response.record) return { host: normalized, found: false };
  if (response.matchedBy === 'name' && text(response.record.name) !== name) return { host: normalized, found: false };

  const flatten = (record) => {
    const out = {};
    Object.entries(record).forEach(([k, v]) => {
      if (!IGNORED.has(k)) out[k] = text(v);
    });
    return out;
  };

  const changes = changedFields(flatten(local), flatten(response.record)).map((c) => {
    const diff = diffLines(c.before, c.after);
    return { ...c, rows: hasChanges(diff) ? collapseDiff(diff, 3) : [] };
  });

  return {
    host: normalized,
    found: true,
    matchedBy: response.matchedBy,
    remoteSysId: text(response.record.sys_id),
    changes,
  };
}
