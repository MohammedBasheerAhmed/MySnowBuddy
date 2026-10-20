// Release notes for an update set, the instance half. It reuses the Ship check's loader (src/content/myWork.js
// loadShipCheck: the entries, the collision / dependency checks and the script findings), so nothing is fetched twice and
// the notes can never disagree with the checklist. The only extra reads are each record's own description and whether it
// was created after the set was started. Read-only. The pure half is src/lib/releaseNotes.js.

import { loadShipCheck, fetchShipCheckSets } from './myWork.js';
import { queryInChunks, fetchRecord } from './tableApi.js';
import { parseUpdateName } from '../lib/updateSetReview.js';
import { buildReleaseModel } from '../lib/releaseNotes.js';

const MAX_TABLES = 10;
const MAX_PER_TABLE = 60;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const TABLE_RE = /^[a-z][a-z0-9_]*$/;

/**
 * { descriptions, created } keyed by the update entry's sys_id: the record's short description (or description), and whether
 * the record was created after the update set. A table that cannot be read just has no descriptions.
 */
async function recordFacts(entries, setCreatedOn) {
  const descriptions = {};
  const created = {};
  const byTable = new Map();
  entries.forEach((entry) => {
    if (String(entry.action || '').toUpperCase() === 'DELETE') return; // the record is gone
    const { table, sysId } = parseUpdateName(entry.name);
    if (!table || !sysId || !TABLE_RE.test(table)) return;
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push({ entry, sysId });
  });
  const tables = [...byTable.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, MAX_TABLES);
  for (const [table, list] of tables) {
    const wanted = list.slice(0, MAX_PER_TABLE);
    // eslint-disable-next-line no-await-in-loop -- one table at a time keeps the load on the instance low.
    const rows = await queryInChunks(table, 'sys_id', wanted.map((w) => w.sysId), ['sys_id', 'short_description', 'description', 'sys_created_on'], { chunkSize: 30, limit: 30 }).catch(() => []);
    const bySysId = new Map(rows.map((r) => [String(r.sys_id).toLowerCase(), r]));
    wanted.forEach(({ entry, sysId }) => {
      const rec = bySysId.get(sysId);
      if (!rec) return;
      const text = rec.short_description || rec.description || '';
      if (text) descriptions[entry.sys_id] = text;
      if (setCreatedOn && rec.sys_created_on && rec.sys_created_on >= setCreatedOn) created[entry.sys_id] = true;
    });
  }
  return { descriptions, created };
}

/** Everything the panel shows for one update set. */
export async function buildReleaseNotes(setId) {
  if (!SYS_ID_RE.test(setId || '')) throw new Error('Pick an update set.');
  const check = await loadShipCheck(setId);
  const setRecord = await fetchRecord('sys_update_set', setId, ['sys_id', 'sys_created_on']).catch(() => null);
  const facts = await recordFacts(check.entries, setRecord?.sys_created_on || '').catch(() => ({ descriptions: {}, created: {} }));
  const model = buildReleaseModel({
    set: check.set,
    entries: check.entries,
    total: check.total,
    scripts: check.scripts,
    descriptions: facts.descriptions,
    created: facts.created,
    verdict: check.checklist?.verdict || '',
    host: check.host,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
  });
  return { model, verdict: check.checklist?.verdict || '', set: check.set };
}

export const releaseNotesServices = {
  releaseNotesSets: () => fetchShipCheckSets(),
  releaseNotesBuild: (setId) => buildReleaseNotes(setId),
};
