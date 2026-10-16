// Update Set analysis: collision detection and capture coverage.
//
// These are the two failure modes that cause most bad ServiceNow deployments:
//   1. Two open update sets both contain the same artifact, so whichever is
//      committed second silently overwrites the first.
//   2. A developer changed a record while the wrong update set (or none) was
//      active, so the change never leaves the current instance.

import { queryTable } from './tableApi.js';

/**
 * The sys_update_xml.name a change to `row` is captured under, which lets us check capture
 * coverage without a join. Conventionally "<class>_<sys_id>", where the class is the record's
 * own table: querying sys_script_client also returns catalog_script_client rows, which are
 * captured as "catalog_script_client_<sys_id>". Dictionary entries are captured as
 * "sys_dictionary_<table>_<element>" (UNVERIFIED on a live instance; the collection row
 * of a table, with no element, is assumed to be "..._null").
 */
export function expectedUpdateName(table, row) {
  if (table === 'sys_dictionary') return `sys_dictionary_${row.name}_${row.element || 'null'}`;
  const cls = /^[a-z0-9_]+$/i.test(row.sys_class_name || '') ? row.sys_class_name : table;
  return `${cls}_${row.sys_id}`;
}

// Update sets that could still be deployed. "complete" sets are included
// because they are queued for deployment and can still collide.
const LIVE_STATES = ['in progress', 'complete'];

/**
 * Run `<field>IN<chunk>` queries one chunk at a time and say which values may be missing from
 * the answer because a chunk came back with as many rows as its limit.
 * @returns {Promise<{rows: object[], uncertain: Set<string>}>}
 */
export async function queryChunksWithCap(table, field, values, fields, { chunkSize = 40, limit = 1000, extraQuery = '' } = {}) {
  const unique = [...new Set(values.filter(Boolean))];
  const rows = [];
  const uncertain = new Set();
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    // eslint-disable-next-line no-await-in-loop -- sequential chunks keep the load on the instance low.
    const page = await queryTable(table, `${field}IN${chunk.join(',')}${extraQuery ? `^${extraQuery}` : ''}`, fields, { limit });
    if (page.length >= limit) chunk.forEach((v) => uncertain.add(v));
    rows.push(...page);
  }
  return { rows, uncertain };
}

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
    [
      'sys_id',
      'name',
      'type',
      'target_name',
      'action',
      'update_set',
      'application',
      'application.name',
      'sys_updated_on',
      'sys_updated_by',
      'sys_created_by',
    ],
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
  return findCollisionsForEntries(updateSetSysId, entries, liveSets);
}

/**
 * findCollisions() for entries the caller already fetched with fetchUpdateSetEntries().
 *
 * The other sets are filtered by the instance (state in progress or complete, any age), not
 * taken from a list of recent sets. `truncated` is set when only part of the set was checked,
 * with the reason in `truncatedReason`. Each conflict carries its set's state so callers can
 * tell open sets (in progress) from finished ones (complete).
 */
export async function findCollisionsForEntries(updateSetSysId, entries, liveSets = null) {
  if (!entries.length) {
    return { entries: [], collisions: [], truncated: false, truncatedReason: '', selectedSet: null, liveSets: liveSets || [] };
  }

  // Bound the IN-list so a huge update set does not generate hundreds of
  // requests. 300 names is already an unusually large set.
  const MAX_NAMES = 300;
  const names = entries.slice(0, MAX_NAMES).map((e) => e.name);

  const { rows: others, uncertain } = await queryChunksWithCap(
    'sys_update_xml',
    'name',
    names,
    ['sys_id', 'name', 'update_set', 'update_set.name', 'update_set.state', 'sys_updated_on', 'sys_updated_by'],
    {
      chunkSize: 40,
      limit: 1000,
      extraQuery: `update_set!=${updateSetSysId}^update_set.stateIN${LIVE_STATES.join(',')}^ORDERBYDESCsys_updated_on`,
    }
  );

  const wanted = new Set(names);
  const byName = new Map();
  others.forEach((row) => {
    const otherSetId = row.update_set?.value || row.update_set;
    const state = row['update_set.state'] || '';
    // Re-checked here as well: committed history and this set itself never count.
    if (!otherSetId || otherSetId === updateSetSysId || !LIVE_STATES.includes(state) || !wanted.has(row.name)) return;

    if (!byName.has(row.name)) byName.set(row.name, []);
    byName.get(row.name).push({
      updateSetId: otherSetId,
      updateSetName: row['update_set.name'] || otherSetId,
      updateSetState: state,
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

  const reasons = [];
  if (entries.length > MAX_NAMES) reasons.push(`only the first ${MAX_NAMES} entries were checked`);
  if (uncertain.size) reasons.push(`${uncertain.size} entries had too many matches to read completely`);

  return {
    entries,
    collisions,
    truncated: reasons.length > 0,
    truncatedReason: reasons.join('; '),
    liveSets: liveSets || [],
    selectedSet: (liveSets || []).find((s) => s.sys_id === updateSetSysId) || null,
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

// Labels for child classes the coverage queries also return.
const CLASS_LABELS = {
  catalog_script_client: 'Catalog Client Script',
  catalog_ui_policy: 'Catalog UI Policy',
  sys_ui_policy: 'UI Policy',
  sys_script_client: 'Client Script',
};

/**
 * Find configuration records changed in the last N days that have NO
 * sys_update_xml entry - i.e. changes that will not ship anywhere.
 *
 * Caveat: records inside a scoped application that is source-controlled, and
 * records excluded from update set capture by design, will legitimately show
 * up here. Treat the output as a review list, not a defect list.
 */
export async function findUncapturedChanges({ days = 7, limitPerTable = 100, updatedBy = '' } = {}) {
  const dayCount = Math.max(1, Math.min(days, 90));
  // updatedBy narrows the check to one user's changes (My work). sys_updated_by exists on every table.
  const byUser = updatedBy && !/[\^\n]/.test(updatedBy) ? `^sys_updated_by=${updatedBy}` : '';
  const changedQuery = `sys_updated_on>=javascript:gs.daysAgoStart(${dayCount})${byUser}^ORDERBYDESCsys_updated_on`;

  const errors = [];
  const candidates = [];

  const settled = await Promise.allSettled(
    COVERAGE_TABLES.map(async (def) => {
      const nameField = def.nameField || 'name';
      // sys_class_name: a child class (catalog_script_client under sys_script_client) is captured
      // under its own table name. name + element: how dictionary entries are captured.
      const fields = [...new Set(['sys_id', nameField, 'sys_class_name', 'sys_updated_on', 'sys_updated_by', ...(def.table === 'sys_dictionary' ? ['name', 'element'] : [])])];
      const rows = await queryTable(def.table, changedQuery, fields, { limit: limitPerTable });
      rows.forEach((row) => {
        if (def.table === 'sys_dictionary' && !row.name) return;
        const cls = row.sys_class_name && row.sys_class_name !== def.table ? row.sys_class_name : '';
        candidates.push({
          table: cls || def.table,
          label: CLASS_LABELS[cls] || def.label,
          sysId: row.sys_id,
          name: def.table === 'sys_dictionary' ? `${row.name}.${row.element || '(table)'}` : row[nameField] || '(unnamed)',
          updatedOn: row.sys_updated_on,
          updatedBy: row.sys_updated_by,
          expectedName: expectedUpdateName(def.table, row),
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

  const { rows: captured, uncertain } = await queryChunksWithCap(
    'sys_update_xml',
    'name',
    candidates.map((c) => c.expectedName),
    ['name'],
    { chunkSize: 40, limit: 1000 }
  );

  const capturedNames = new Set(captured.map((row) => row.name));
  // A name in a chunk whose answer may be cut off is not reported: "unknown" is not "uncaptured".
  const uncaptured = candidates.filter((c) => !capturedNames.has(c.expectedName) && !uncertain.has(c.expectedName));
  const unsure = candidates.filter((c) => !capturedNames.has(c.expectedName) && uncertain.has(c.expectedName)).length;
  if (unsure) errors.push({ table: 'sys_update_xml', error: `${unsure} record(s) could not be checked completely and are not listed` });

  return { days: dayCount, checked: candidates.length, uncaptured, errors };
}

/** Compact, token-efficient text for the AI deployment-risk prompt. */
export function buildUpdateSetPrompt({ selectedSet, collisions, uncaptured, days, prompt }) {
  // The ship check builds its own (already redacted) prompt and passes it through here,
  // because the sidebar wires this panel's onAskAi to this function.
  if (typeof prompt === 'string' && prompt) return prompt;
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
