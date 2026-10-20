// Test data, the instance half: read the table's dictionary, choices and a few existing records to point at, say
// whether this instance may be written to, and keep the journal of what was created (chrome.storage.local) so cleanup
// still works after a reload. The writes themselves are NOT here: the panel sends them through the agent's own
// create_record / update_record / delete_record (services.agentExecute), so the write policy, the dictionary check
// and the audit log with undo apply exactly as they do for the agent.
// The pure half is src/lib/testData.js; the panel is src/sidebar/TestDataPanel.jsx.

import { queryTable } from './tableApi.js';
import { fetchTableFields, fetchChoices } from './fieldInspector.js';
import { getInstanceInfo } from './quickActions.js';
import { isGuardedEnv } from '../lib/agent/policy.js';
import { isGeneratable, templateFor, JOURNAL_KEY } from '../lib/testData.js';

const TABLE_RE = /^[a-z][a-z0-9_]*$/;
const CHOICE_FIELDS_MAX = 14;
const REF_FIELDS_MAX = 8;
const REF_LIMIT = 25;
const DISPLAY_COLUMNS = ['number', 'name', 'user_name', 'short_description'];

/** Whether writes are allowed here: only an instance positively identified as dev, test or stage. */
export function testDataGuard() {
  const info = getInstanceInfo();
  return { host: info.host, env: info.env, label: info.label, allowed: !isGuardedEnv(info.env) };
}

/** A few existing records of a table to point references at (active users only for sys_user). */
export async function loadRefSamples(refTable) {
  if (!TABLE_RE.test(refTable || '')) return [];
  const query = refTable === 'sys_user' ? 'active=true^user_nameISNOTEMPTY' : '';
  const rows = await queryTable(refTable, query, ['sys_id', ...DISPLAY_COLUMNS], { limit: REF_LIMIT }).catch(() => []);
  return rows
    .filter((r) => /^[0-9a-f]{32}$/i.test(r.sys_id))
    .map((r) => ({ sysId: r.sys_id, display: DISPLAY_COLUMNS.map((c) => r[c]).find(Boolean) || r.sys_id }));
}

/**
 * Everything the panel needs to plan a table: dictionary fields, choice lists for the choice fields and sample
 * records for the references the template or the dictionary says matter. Partial failures become empty lists.
 */
export async function loadSchema(table) {
  if (!TABLE_RE.test(table || '')) throw new Error('Name a table first, for example incident.');
  const { fields } = await fetchTableFields(table);
  const usable = fields.filter(isGeneratable);
  const template = templateFor(table);
  const wanted = (f) => f.mandatory || template?.include?.includes(f.name);

  const choiceFields = usable.filter((f) => f.choiceType).slice(0, CHOICE_FIELDS_MAX);
  const refFields = usable.filter((f) => f.type === 'reference' && f.reference && wanted(f)).slice(0, REF_FIELDS_MAX);
  const [choiceResults, refResults] = await Promise.all([
    Promise.allSettled(choiceFields.map((f) => fetchChoices(table, f.name))),
    Promise.allSettled(refFields.map((f) => loadRefSamples(f.reference))),
  ]);
  const choices = {};
  choiceFields.forEach((f, i) => {
    if (choiceResults[i].status === 'fulfilled') choices[f.name] = choiceResults[i].value;
  });
  const refs = {};
  refFields.forEach((f, i) => {
    if (refResults[i].status === 'fulfilled') refs[f.name] = refResults[i].value;
  });
  return { table, fields, choices, refs };
}

// --- Journal -----------------------------------------------------------------------------------------------

export async function readJournal() {
  const res = await chrome.storage.local.get(JOURNAL_KEY);
  return Array.isArray(res[JOURNAL_KEY]) ? res[JOURNAL_KEY] : [];
}

export async function saveJournal(journal) {
  await chrome.storage.local.set({ [JOURNAL_KEY]: Array.isArray(journal) ? journal : [] });
}

/** Which of these sys_ids are still in the table (a record the user already deleted is skipped by cleanup). */
export async function existingIds(table, sysIds) {
  if (!TABLE_RE.test(table || '')) return new Set();
  const found = new Set();
  for (let i = 0; i < sysIds.length; i += 50) {
    const chunk = sysIds.slice(i, i + 50).filter((id) => /^[0-9a-f]{32}$/i.test(id));
    if (!chunk.length) continue;
    // eslint-disable-next-line no-await-in-loop -- at most a couple of short chunks
    const rows = await queryTable(table, `sys_idIN${chunk.join(',')}`, ['sys_id'], { limit: chunk.length + 5 });
    rows.forEach((r) => found.add(r.sys_id));
  }
  return found;
}

/** Merged into the services every sidebar panel receives (src/content/featureServices.js). */
export const testDataServices = {
  testDataGuard: async () => testDataGuard(),
  testDataSchema: (table) => loadSchema(table),
  testDataRefs: (refTable) => loadRefSamples(refTable),
  testDataJournal: () => readJournal(),
  testDataSaveJournal: (journal) => saveJournal(journal),
  testDataExisting: (table, sysIds) => existingIds(table, sysIds),
};
