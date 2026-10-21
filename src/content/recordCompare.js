// Compare the record on screen with another record of the same table on this instance (/vs INC0010002). Read-only:
// both records are read through the Table API with display values and compared field by field.
// The pure half is src/lib/recordCompare.js; the panel is src/sidebar/RecordComparePanel.jsx.

import { queryTable } from './tableApi.js';
import { parseOther, lookups, flattenRecord, recordLabel, compareRecords, compareHeadline } from '../lib/recordCompare.js';

const TABLE_RE = /^[a-z][a-z0-9_]*$/;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;

const readOne = async (table, query) => (await queryTable(table, query, [], { limit: 5, displayValue: true }))[0] || null;

/** Plain values of a display-value row, for matching what the user typed. */
function plainValues(row) {
  const out = {};
  Object.entries(row || {}).forEach(([k, v]) => {
    out[k] = v && typeof v === 'object' ? v.value ?? v.display_value ?? '' : v;
  });
  return out;
}

/** The other record, from a sys_id, a number or a name on the same table; null when none matches. */
async function findOther(table, other) {
  for (const attempt of lookups(other)) {
    // eslint-disable-next-line no-await-in-loop -- try the next column only when this one found nothing.
    const rows = await queryTable(table, attempt.query, [], { limit: 5, displayValue: true });
    const hit = rows.find((row) => attempt.matches(plainValues(row)));
    if (hit) return hit;
  }
  return null;
}

/**
 * @param {{ table: string, sysId: string, other: string, includeSystem?: boolean }} args
 */
export async function compareWithRecord({ table, sysId, other, includeSystem = false } = {}) {
  if (!TABLE_RE.test(table || '') || !SYS_ID_RE.test(sysId || '')) throw new Error('Open a saved record first.');
  const parsed = parseOther(other);
  if (!parsed) throw new Error('Type the other record: a number (INC0010002), a sys_id, or a name.');

  const [mine, theirs] = await Promise.all([readOne(table, `sys_id=${sysId}`), findOther(table, parsed)]);
  if (!mine) throw new Error('The record on screen could not be read. Your user may not be allowed to see it.');
  if (!theirs) throw new Error(`No ${table} record matches "${parsed.value}". The other record has to be on the same table.`);

  const left = flattenRecord(mine);
  const right = flattenRecord(theirs);
  if (left.sys_id?.value === right.sys_id?.value) throw new Error('That is the record on screen. Type a different one.');

  const result = compareRecords(left, right, { includeSystem });
  return {
    table,
    left: { label: recordLabel(left, 'this record'), sysId: left.sys_id?.value || sysId },
    right: { label: recordLabel(right, parsed.value), sysId: right.sys_id?.value || '' },
    ...result,
    headline: compareHeadline(result),
  };
}

/** Services for the panel (merged by featureServices.js). */
export const recordCompareServices = {
  compareWithRecord: (args) => compareWithRecord(args),
};
