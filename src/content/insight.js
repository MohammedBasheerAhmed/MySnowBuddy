// "Break this list down" and "What points at this record?", the instance half. Everything here reads: counts through the
// Aggregate API (nothing but numbers comes back) and the dictionary. Clicking a bar or a row only navigates to a list.
// The pure half is src/lib/insight.js and src/lib/refGraph.js; the panels are src/sidebar/InsightPanel.jsx and RefGraphPanel.jsx.

import { countByColumn, countRecords, queryTable } from './tableApi.js';
import { fetchTableFields, tableHierarchy } from './fieldInspector.js';
import { navigate, listUrl } from './quickActions.js';
import {
  TABLE_RE,
  COLUMN_RE,
  suggestColumns,
  parseStats,
  bucketize,
  countingQuery,
  filterForBar,
  periodBuckets,
  rangeQuery,
  timeSeries,
} from '../lib/insight.js';
import {
  SYS_ID_RE,
  referencingFieldsQuery,
  planCounts,
  summarize,
  outgoingReferences,
  relationshipQuery,
  relationships,
  LIMITS_NOTE,
} from '../lib/refGraph.js';

const CONCURRENCY = 6;
const MAX_GROUPS = 20000;
const DICTIONARY_PAGE = 1000;
const DICTIONARY_PAGES = 3;

/** Run `task(item)` over `items`, `limit` at a time, keeping the order of the results. */
async function pool(items, limit, task, { isCancelled = () => false, onProgress } = {}) {
  const out = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length && !isCancelled()) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop -- each worker takes the next item only when it is free.
      out[i] = await task(items[i], i);
      done += 1;
      onProgress?.({ done, total: items.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const errorText = (err) => err?.message || String(err);

// --- Break this list down ---------------------------------------------------------------------------------

/** Columns worth counting for a table, best first, and its date columns. */
export async function insightColumns(table) {
  if (!TABLE_RE.test(table || '')) throw new Error('Open a list first, or type a table name.');
  const { fields } = await fetchTableFields(table);
  return suggestColumns(fields);
}

/** Counts per value of `column` over the list's filter: { total, distinct, bars }. */
export async function insightBreakdown(table, query, column) {
  if (!TABLE_RE.test(table || '') || !COLUMN_RE.test(column || '')) throw new Error('Pick a table and a column first.');
  const raw = await countByColumn(table, countingQuery(query), column);
  return { ...bucketize(parseStats(raw.slice(0, MAX_GROUPS))), column, table };
}

/** Counts per day / week / month of a date column: { total, average, peak, points } (oldest first). */
export async function insightSeries({ table, query, column, unit = 'day', count, isCancelled, onProgress }) {
  if (!TABLE_RE.test(table || '') || !COLUMN_RE.test(column || '')) throw new Error('Pick a table and a date column first.');
  const buckets = periodBuckets(unit, count);
  const base = countingQuery(query);
  const points = await pool(
    buckets,
    CONCURRENCY,
    async (bucket) => {
      try {
        return { label: bucket.label, count: await countRecords(table, rangeQuery(base, column, bucket)), query: rangeQuery(query, column, bucket) };
      } catch (err) {
        return { label: bucket.label, count: 0, error: errorText(err) };
      }
    },
    { isCancelled, onProgress }
  );
  const done = points.filter(Boolean);
  const failed = done.filter((p) => p.error);
  if (done.length && failed.length === done.length) throw new Error(failed[0].error);
  return { ...timeSeries(done), unit, column, table };
}

/** Open the list with the bar's value added to the filter (navigation only). */
export function insightApplyFilter(table, query, column, value) {
  navigate(listUrl(table, filterForBar(query, column, value)));
  return true;
}

/** Open the list for an arbitrary encoded query (a time-series bar). */
export function insightOpenQuery(table, query) {
  if (!TABLE_RE.test(table || '')) throw new Error('Not a table.');
  navigate(listUrl(table, query));
  return true;
}

// --- What points at this record? --------------------------------------------------------------------------

async function dictionaryRows(query) {
  const rows = [];
  for (let page = 0; page < DICTIONARY_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop -- pages are read one after the other.
    const chunk = await queryTable('sys_dictionary', `${query}^ORDERBYname`, ['name', 'element', 'column_label', 'internal_type', 'reference', 'reference_cascade_rule'], { limit: DICTIONARY_PAGE, offset: page * DICTIONARY_PAGE });
    rows.push(...chunk);
    if (chunk.length < DICTIONARY_PAGE) break;
  }
  return rows;
}

const valueOf = (cell) => (cell && typeof cell === 'object' ? cell.display_value || cell.value : cell) || '';

/**
 * Everything that references this record (counted per table.field), the references it holds itself, and for a CI its
 * relationships. Read-only; a field that cannot be counted becomes an error on its own row.
 */
export async function refGraphLoad({ table, sysId, showAll = false, isCancelled, onProgress } = {}) {
  if (!TABLE_RE.test(table || '') || !SYS_ID_RE.test(sysId || '')) throw new Error('Open a saved record first.');
  const chain = await tableHierarchy(table);
  const [rows, fieldInfo, recordRows] = await Promise.all([
    dictionaryRows(referencingFieldsQuery(chain)),
    fetchTableFields(table).catch(() => ({ fields: [] })),
    queryTable(table, `sys_id=${sysId}`, [], { limit: 1, displayValue: true }).catch(() => []),
  ]);
  const plan = planCounts(rows, { sysId, showAll });
  const counted = await pool(
    plan.fields,
    CONCURRENCY,
    async (field) => {
      try {
        return { ...field, count: await countRecords(field.table, field.query) };
      } catch (err) {
        return { ...field, count: 0, error: errorText(err) };
      }
    },
    { isCancelled, onProgress }
  );
  const incoming = counted.filter(Boolean).sort((a, b) => b.count - a.count || a.table.localeCompare(b.table) || a.field.localeCompare(b.field));
  const record = recordRows[0] || {};
  const outgoing = outgoingReferences(
    fieldInfo.fields.map((f) => ({ name: f.name, label: f.label, type: f.type, reference: f.reference })),
    record
  );
  let rel = null;
  if (chain.includes('cmdb_ci')) {
    const relRows = await queryTable('cmdb_rel_ci', relationshipQuery(sysId), ['parent', 'child', 'type'], { limit: 100, displayValue: true }).catch(() => []);
    rel = relationships(relRows, sysId);
  }
  return {
    table,
    sysId,
    name: valueOf(record.number) || valueOf(record.name) || valueOf(record.short_description) || valueOf(record.user_name) || sysId,
    chain,
    summary: summarize(incoming),
    incoming,
    outgoing,
    rel,
    plan: { hiddenNoisy: plan.hiddenNoisy, hiddenCap: plan.hiddenCap, total: plan.total },
    note: LIMITS_NOTE,
  };
}

/** Open a list (navigation only). */
export function refGraphOpenList(table, query) {
  if (!TABLE_RE.test(table || '')) throw new Error('Not a table.');
  navigate(listUrl(table, query));
  return true;
}

export const insightServices = {
  insightColumns: (table) => insightColumns(table),
  insightBreakdown: (table, query, column) => insightBreakdown(table, query, column),
  insightSeries: (options) => insightSeries(options),
  insightApplyFilter: (table, query, column, value) => insightApplyFilter(table, query, column, value),
  insightOpenQuery: (table, query) => insightOpenQuery(table, query),
  refGraphLoad: (options) => refGraphLoad(options),
  refGraphOpenList: (table, query) => refGraphOpenList(table, query),
};
