// Update Set analysis: collision detection and capture coverage.
//
// These are the two failure modes that cause most bad ServiceNow deployments:
//   1. Two open update sets both contain the same artifact, so whichever is
//      committed second silently overwrites the first.
//   2. A developer changed a record while the wrong update set (or none) was
//      active, so the change never leaves the current instance.

import { queryTable, queryInChunks } from './tableApi.js';

// `sys_update_xml.name` is conventionally "<table>_<sys_id>", which lets us
// check capture coverage without a join.
function expectedUpdateName(table, sysId) {
  return `${table}_${sysId}`;
}

// Update sets that could still be deployed. "complete" sets are included
// because they are queued for deployment and can still collide.
const LIVE_STATES = ['in progress', 'complete'];

/** Update sets that are open or awaiting deployment. */
export async function fetchLiveUpdateSets({ limit = 100 } = {}) {
  const query = `stateIN${LIVE_STATES.join(',')}^ORDERBYDESCsys_updated_on`;
  return queryTable(
    'sys_update_set',
    query,
    ['sys_id', 'name', 'state', 'application', 'sys_updated_on', 'sys_updated_by', 'description'],
    { limit }
  );
}

/** The entries (customer updates) captured inside one update set. */
export async function fetchUpdateSetEntries(updateSetSysId, { limit = 500 } = {}) {
  if (!updateSetSysId) throw new Error('Select an update set first.');
  return queryTable(
    'sys_update_xml',
    `update_set=${updateSetSysId}^ORDERBYtype`,
    ['sys_id', 'name', 'type', 'target_name', 'action', 'sys_updated_on', 'sys_updated_by'],
    { limit }
  );
}

/**
 * Find artifacts in the selected update set that are ALSO present in another
 * live update set. Those are the records that will be silently overwritten
 * depending on commit order.
 */
export async function findCollisions(updateSetSysId, { limit = 500 } = {}) {
  const [entries, liveSets] = await Promise.all([
    fetchUpdateSetEntries(updateSetSysId, { limit }),
    fetchLiveUpdateSets({ limit: 200 }),
  ]);

  if (!entries.length) {
    return { entries: [], collisions: [], truncated: false, selectedSet: null, liveSets };
  }

  const liveSetIds = new Set(liveSets.map((s) => s.sys_id));
  const setNameById = new Map(liveSets.map((s) => [s.sys_id, s.name]));
  const setStateById = new Map(liveSets.map((s) => [s.sys_id, s.state]));

  // Bound the IN-list so a huge update set does not generate hundreds of
  // requests. 300 names is already an unusually large set.
  const MAX_NAMES = 300;
  const truncated = entries.length > MAX_NAMES;
  const names = entries.slice(0, MAX_NAMES).map((e) => e.name);

  const others = await queryInChunks(
    'sys_update_xml',
    'name',
    names,
    ['sys_id', 'name', 'type', 'target_name', 'update_set', 'sys_updated_on', 'sys_updated_by'],
    { chunkSize: 40, limit: 500 }
  );

  const byName = new Map();
  others.forEach((row) => {
    const otherSetId = row.update_set?.value || row.update_set;
    if (!otherSetId || otherSetId === updateSetSysId) return;
    if (!liveSetIds.has(otherSetId)) return; // ignore already-committed history

    if (!byName.has(row.name)) byName.set(row.name, []);
    byName.get(row.name).push({
      updateSetId: otherSetId,
      updateSetName: setNameById.get(otherSetId) || otherSetId,
      updateSetState: setStateById.get(otherSetId) || 'unknown',
      updatedOn: row.sys_updated_on,
      updatedBy: row.sys_updated_by,
    });
  });

  const collisions = entries
    .filter((entry) => byName.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      type: entry.type,
      targetName: entry.target_name,
      updatedOn: entry.sys_updated_on,
      updatedBy: entry.sys_updated_by,
      conflictsWith: byName.get(entry.name),
      severity: byName.get(entry.name).length > 1 ? 'high' : 'medium',
    }));

  return {
    entries,
    collisions,
    truncated,
    liveSets,
    selectedSet: liveSets.find((s) => s.sys_id === updateSetSysId) || null,
  };
}

// Configuration tables worth checking for uncaptured changes. Deliberately
// scoped to scriptable/config artifacts rather than every table on the
// instance, so this stays fast.
export const COVERAGE_TABLES = [
  { table: 'sys_script', label: 'Business Rule' },
  { table: 'sys_script_include', label: 'Script Include' },
  { table: 'sys_script_client', label: 'Client Script' },
  { table: 'sys_ui_action', label: 'UI Action' },
  { table: 'sys_ui_policy', label: 'UI Policy', nameField: 'short_description' },
  { table: 'sys_security_acl', label: 'ACL' },
  { table: 'sysauto_script', label: 'Scheduled Job' },
  { table: 'sysevent_script_action', label: 'Script Action' },
  { table: 'sys_ws_operation', label: 'Scripted REST Operation' },
  { table: 'sp_widget', label: 'Portal Widget' },
  { table: 'sys_dictionary', label: 'Dictionary Entry', nameField: 'element' },
];

/**
 * Find configuration records changed in the last N days that have NO
 * sys_update_xml entry - i.e. changes that will not ship anywhere.
 *
 * Caveat: records inside a scoped application that is source-controlled, and
 * records excluded from update set capture by design, will legitimately show
 * up here. Treat the output as a review list, not a defect list.
 */
export async function findUncapturedChanges({ days = 7, limitPerTable = 100 } = {}) {
  const dayCount = Math.max(1, Math.min(days, 90));
  const changedQuery = `sys_updated_on>=javascript:gs.daysAgoStart(${dayCount})^ORDERBYDESCsys_updated_on`;

  const errors = [];
  const candidates = [];

  const settled = await Promise.allSettled(
    COVERAGE_TABLES.map(async (def) => {
      const nameField = def.nameField || 'name';
      const rows = await queryTable(
        def.table,
        changedQuery,
        ['sys_id', nameField, 'sys_updated_on', 'sys_updated_by'],
        { limit: limitPerTable }
      );
      rows.forEach((row) => {
        candidates.push({
          table: def.table,
          label: def.label,
          sysId: row.sys_id,
          name: row[nameField] || '(unnamed)',
          updatedOn: row.sys_updated_on,
          updatedBy: row.sys_updated_by,
          expectedName: expectedUpdateName(def.table, row.sys_id),
        });
      });
    })
  );

  settled.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      errors.push({
        table: COVERAGE_TABLES[index].table,
        error: outcome.reason?.message || String(outcome.reason),
      });
    }
  });

  if (!candidates.length) {
    return { days: dayCount, checked: 0, uncaptured: [], errors };
  }

  const captured = await queryInChunks(
    'sys_update_xml',
    'name',
    candidates.map((c) => c.expectedName),
    ['name', 'update_set'],
    { chunkSize: 40, limit: 500 }
  );

  const capturedNames = new Set(captured.map((row) => row.name));
  const uncaptured = candidates.filter((c) => !capturedNames.has(c.expectedName));

  return { days: dayCount, checked: candidates.length, uncaptured, errors };
}

/** Compact, token-efficient text for the AI deployment-risk prompt. */
export function buildUpdateSetPrompt({ selectedSet, collisions, uncaptured, days }) {
  const parts = [
    'You are reviewing a ServiceNow deployment for risk. Be concrete and prioritise by blast radius.',
    '',
  ];

  if (selectedSet) {
    parts.push(`## Update set under review\nName: ${selectedSet.name}\nState: ${selectedSet.state}`);
  }

  if (collisions?.length) {
    const lines = collisions
      .slice(0, 40)
      .map(
        (c) =>
          `- ${c.type}: ${c.targetName || c.name} also appears in ${c.conflictsWith
            .map((o) => `"${o.updateSetName}" (${o.updateSetState}, changed by ${o.updatedBy})`)
            .join(', ')}`
      )
      .join('\n');
    parts.push(`\n## Artifacts present in more than one live update set\n${lines}`);
  } else {
    parts.push('\n## Collisions\nNone detected.');
  }

  if (uncaptured?.length) {
    const lines = uncaptured
      .slice(0, 40)
      .map((u) => `- ${u.label}: ${u.name} (changed ${u.updatedOn} by ${u.updatedBy})`)
      .join('\n');
    parts.push(`\n## Changed in the last ${days} days but not captured in any update set\n${lines}`);
  }

  parts.push(
    '',
    'Explain: which collisions will actually cause a lost change and why, what commit order is safest, ' +
      'which uncaptured changes look like real work that will be lost on the next clone/deployment ' +
      '(versus expected noise), and the concrete steps to remediate before deploying.'
  );

  return parts.join('\n');
}
