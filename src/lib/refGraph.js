// "What points at this record?" - the pure half. No DOM, no network:
//
//   - the dictionary query that finds every reference (and list) field aimed at a table or one of its parents,
//   - which of those fields to count first (system log/audit tables go behind "show all"), and the count query for each,
//   - what deleting the record would do, per field, from the dictionary's cascade rule (delete / restrict / clear),
//   - the record's own outgoing references and its CMDB relationships.
//
// The instance half is src/content/refGraph.js; the panel is src/sidebar/RefGraphPanel.jsx.

export const SYS_ID_RE = /^[0-9a-f]{32}$/i;
export const TABLE_RE = /^[a-z][a-z0-9_]*$/;
export const FIELD_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

/** How many fields are counted before the rest are offered behind "Show all". */
export const DEFAULT_CAP = 120;
export const HARD_CAP = 600;

/** Tables that fill up with rows about other rows (audit, history, logs, mail, attachments ...). Counting them is slow and rarely useful. */
const NOISY_TABLE = /^(sys_audit|sys_history|syslog|sys_email|sys_attachment|sys_journal_field|sys_update_xml|sys_update_version|sys_rollback|sys_progress|sys_execution|ecc_|sysevent|sys_amb|sys_cluster|sys_stats|sys_session|sys_user_preference|sys_import_set_row|ts_|v_|metric_|sys_flow_|sys_hub_flow_|sys_generate|sys_ui_(?:user|list)_|sys_cache|sys_transaction|sys_node)/;
export const isNoisyTable = (table) => NOISY_TABLE.test(String(table || ''));

// --- Finding the fields -----------------------------------------------------------------------------------

/**
 * Dictionary query for every reference / list field that points at one of `tables` (the record's table and its parents,
 * because a reference to `task` can hold an incident).
 */
export function referencingFieldsQuery(tables) {
  const list = (tables || []).filter((t) => TABLE_RE.test(t));
  if (!list.length) throw new Error('No table to look for.');
  return `referenceIN${list.join(',')}^internal_type=reference^ORinternal_type=glide_list^elementISNOTEMPTY^active=true`;
}

/** 'delete' | 'restrict' | 'clear' for a dictionary reference_cascade_rule value (blank and unknown mean the default: clear). */
export function cascadeKind(rule) {
  const value = String(rule || '').toLowerCase();
  if (value.startsWith('delete')) return 'delete';
  if (value === 'restrict') return 'restrict';
  return 'clear';
}

/** The condition that matches records whose field holds `sysId`. */
export function countQuery(field, sysId, type = 'reference') {
  if (!FIELD_RE.test(field || '')) throw new Error(`"${field}" is not a column name.`);
  if (!SYS_ID_RE.test(sysId || '')) throw new Error('That is not a sys_id.');
  return String(type).toLowerCase() === 'glide_list' ? `${field}LIKE${sysId}` : `${field}=${sysId}`;
}

/** Path of the list showing the records behind one count. */
export function listPath(table, query) {
  return `/${table}_list.do?sysparm_query=${encodeURIComponent(query)}`;
}

export function recordPath(table, sysId) {
  return `/${table}.do?sys_id=${encodeURIComponent(sysId)}`;
}

/**
 * Dictionary rows -> the fields to count, ordinary tables first.
 * @param {Array<{name: string, element: string, column_label?: string, internal_type?: string, reference?: string, reference_cascade_rule?: string}>} rows
 * @returns {{ fields: Array, hiddenNoisy: number, hiddenCap: number, total: number }}
 */
export function planCounts(rows = [], { sysId, showAll = false, cap = DEFAULT_CAP } = {}) {
  const seen = new Set();
  const all = [];
  rows.forEach((row) => {
    const table = row.name;
    const field = row.element;
    if (!TABLE_RE.test(table || '') || !FIELD_RE.test(field || '')) return;
    const key = `${table}.${field}`;
    if (seen.has(key)) return;
    seen.add(key);
    const type = String(row.internal_type || 'reference').toLowerCase();
    all.push({
      table,
      field,
      label: row.column_label || field,
      type,
      refTable: row.reference || '',
      cascade: cascadeKind(row.reference_cascade_rule),
      noisy: isNoisyTable(table),
      query: countQuery(field, sysId, type),
    });
  });
  all.sort((a, b) => Number(a.noisy) - Number(b.noisy) || a.table.localeCompare(b.table) || a.field.localeCompare(b.field));
  const limit = Math.min(HARD_CAP, showAll ? HARD_CAP : cap);
  const wanted = showAll ? all : all.filter((f) => !f.noisy);
  const fields = wanted.slice(0, limit);
  return { fields, hiddenNoisy: showAll ? 0 : all.length - wanted.length, hiddenCap: Math.max(0, wanted.length - fields.length), total: all.length };
}

// --- Reading the counts -----------------------------------------------------------------------------------

/**
 * @param {Array<{table, field, label, type, cascade, count?: number, error?: string}>} results counts per field
 * @returns {{ total: number, fieldsHit: number, level: 'blocked' | 'cascade' | 'clear' | 'none' | 'unknown', headline: string, restrict: Array, cascade: Array, clear: Array, failed: number }}
 */
export function summarize(results = []) {
  const hit = results.filter((r) => r.count > 0);
  const failed = results.filter((r) => r.error).length;
  const restrict = hit.filter((r) => r.cascade === 'restrict');
  const cascade = hit.filter((r) => r.cascade === 'delete');
  const clear = hit.filter((r) => r.cascade === 'clear');
  const sum = (list) => list.reduce((n, r) => n + r.count, 0);
  const where = (list) => list.slice(0, 3).map((r) => `${r.table}.${r.field}`).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : '');
  const total = sum(hit);

  let level = 'none';
  let headline = 'Nothing else points at this record, as far as the dictionary shows.';
  if (restrict.length) {
    level = 'blocked';
    headline = `Deleting it is blocked: ${sum(restrict)} record${sum(restrict) === 1 ? '' : 's'} in ${where(restrict)} use it and the field's cascade rule is Restrict.`;
  } else if (cascade.length) {
    level = 'cascade';
    headline = `Deleting it also deletes ${sum(cascade)} record${sum(cascade) === 1 ? '' : 's'} (${where(cascade)})${clear.length ? `, and empties ${sum(clear)} reference${sum(clear) === 1 ? '' : 's'} elsewhere` : ''}.`;
  } else if (clear.length) {
    level = 'clear';
    headline = `${sum(clear)} record${sum(clear) === 1 ? '' : 's'} in ${clear.length} field${clear.length === 1 ? '' : 's'} would lose this reference if you delete it (${where(clear)}).`;
  } else if (failed && !results.some((r) => !r.error)) {
    level = 'unknown';
    headline = 'The counts could not be read (your role may not see these tables).';
  }
  return { total, fieldsHit: hit.length, level, headline, restrict, cascade, clear, failed };
}

/** Counting caveat that belongs under every answer. */
export const LIMITS_NOTE =
  'Counts cover reference and list fields in the dictionary, for the tables your user can read. References kept in plain string fields (a sys_id typed into a text column, a script that looks something up) are not seen.';

// --- Outgoing references ----------------------------------------------------------------------------------

/**
 * The reference fields this record fills in, with what they point at.
 * @param {Array<{name: string, label?: string, type?: string, reference?: string}>} fields dictionary entries (tableHierarchy-merged)
 * @param {Record<string, any>} record row read with display values (`{ value, display_value }` per field, or plain strings)
 */
export function outgoingReferences(fields = [], record = {}) {
  const rows = [];
  fields.forEach((field) => {
    const type = String(field.type || '').toLowerCase();
    if (!['reference', 'glide_list'].includes(type) || !field.reference || !TABLE_RE.test(field.reference)) return;
    const cell = record?.[field.name];
    const value = cell && typeof cell === 'object' ? cell.value : cell;
    const display = cell && typeof cell === 'object' ? cell.display_value : '';
    if (!value) return;
    const ids = String(value).split(',').map((v) => v.trim()).filter((v) => SYS_ID_RE.test(v));
    const names = String(display || '').split(',').map((v) => v.trim());
    ids.forEach((id, i) => {
      rows.push({ field: field.name, label: field.label || field.name, table: field.reference, sysId: id, display: (ids.length === names.length ? names[i] : display) || id, path: recordPath(field.reference, id) });
    });
  });
  return rows.sort((a, b) => a.label.localeCompare(b.label) || a.display.localeCompare(b.display));
}

// --- CMDB relationships -----------------------------------------------------------------------------------

/** Query for the relationships a CI takes part in. */
export function relationshipQuery(sysId) {
  if (!SYS_ID_RE.test(sysId || '')) throw new Error('That is not a sys_id.');
  return `parent=${sysId}^ORchild=${sysId}`;
}

/**
 * cmdb_rel_ci rows (read with display values) -> what this CI relates to.
 * `children` are the CIs below it (this CI is the parent), `parents` the ones above.
 */
export function relationships(rows = [], sysId) {
  const out = { parents: [], children: [] };
  rows.forEach((row) => {
    const get = (cell) => (cell && typeof cell === 'object' ? { id: cell.value, name: cell.display_value || cell.value } : { id: String(cell || ''), name: String(cell || '') });
    const parent = get(row.parent);
    const child = get(row.child);
    const type = (row.type && typeof row.type === 'object' ? row.type.display_value : row.type) || '';
    if (parent.id === sysId && SYS_ID_RE.test(child.id)) out.children.push({ ...child, type, path: recordPath('cmdb_ci', child.id) });
    else if (child.id === sysId && SYS_ID_RE.test(parent.id)) out.parents.push({ ...parent, type, path: recordPath('cmdb_ci', parent.id) });
  });
  const byName = (a, b) => a.name.localeCompare(b.name);
  out.parents.sort(byName);
  out.children.sort(byName);
  return out;
}

// --- Text ---------------------------------------------------------------------------------------------------

export function refGraphMarkdown({ table, name, sysId, summary, incoming = [], outgoing = [] }) {
  const lines = [`### What points at ${name || sysId} (${table})`, '', summary.headline, ''];
  const hit = incoming.filter((r) => r.count > 0);
  if (hit.length) {
    lines.push('| Table.field | Records | If deleted |', '| --- | ---: | --- |');
    hit.forEach((r) => lines.push(`| ${r.table}.${r.field} | ${r.count} | ${r.cascade === 'delete' ? 'deleted too' : r.cascade === 'restrict' ? 'blocks the delete' : 'reference cleared'} |`));
    lines.push('');
  }
  if (outgoing.length) {
    lines.push('Points at:', '');
    outgoing.forEach((o) => lines.push(`- ${o.label}: ${o.display} (${o.table})`));
  }
  return lines.join('\n').trim();
}
