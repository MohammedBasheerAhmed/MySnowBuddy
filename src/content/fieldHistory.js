// "Who changed this value, and when?" (/history state), the instance half. Reads the audit trail (sys_audit) for one field of
// the record on screen and the field's choice labels, so a state of "6" reads "Resolved". Read-only.
// The pure half is src/lib/fieldHistory.js; the panel is src/sidebar/FieldHistoryPanel.jsx.

import { queryTable } from './tableApi.js';
import { fetchChoices } from './fieldInspector.js';
import { auditQuery, buildTimeline, labelLookup, summarize } from '../lib/fieldHistory.js';

const LIMIT = 500;

/**
 * @param {{ table: string, sysId: string, field: string }} args
 */
export async function buildFieldHistory({ table, sysId, field } = {}) {
  const query = auditQuery(table, sysId, field);
  const [rows, choices] = await Promise.all([
    queryTable('sys_audit', query, ['sys_created_on', 'user', 'oldvalue', 'newvalue', 'reason', 'fieldname', 'tablename', 'documentkey'], { limit: LIMIT }),
    fetchChoices(table, field).catch(() => []),
  ]);
  // ServiceNow drops a condition on a column it does not know, so check what came back.
  const mine = rows.filter((r) => r.fieldname === field && r.documentkey === sysId.toLowerCase());
  const timeline = buildTimeline(mine, { label: labelLookup(choices) });
  return {
    table,
    field,
    timeline,
    capped: rows.length >= LIMIT,
    hasChoices: choices.length > 0,
    summary: summarize(timeline, { field }),
  };
}

/** Services for the panel (merged by featureServices.js). */
export const fieldHistoryServices = {
  fieldHistory: (args) => buildFieldHistory(args),
};
