// Hot spots, the instance half: what is slow and what is noisy, one section at a time. Read-only. Nothing is fetched
// until the panel asks for a section, and each answer is cached for a short while so a window change or a re-open does
// not hit the instance twice. A section whose table or column does not exist on this release answers with a note
// instead of failing the others. The pure half is src/lib/hotspots.js; the panel is src/sidebar/HotspotsPanel.jsx.
//
// Rows come from the Table API (newest or slowest first, capped) and counts from the Aggregate API, so a busy
// instance is asked for aggregates wherever an aggregate is the answer.

import { queryTable, countRecords } from './tableApi.js';
import { sessionHeaders } from './sessionToken.js';
import { listUrl, recordUrl } from './quickActions.js';
import {
  windowCondition,
  TRANSACTION_FIELDS,
  availableColumns,
  summarizeTransactions,
  summarizeUsers,
  heaviest,
  summarizeJobs,
  stuckJobs,
  groupMessages,
  messageFilter,
  parseGroupCounts,
  topGroups,
  topRecords,
  summarizeOutbound,
  patternPrefix,
  transactionKind,
  formatMs,
  formatCount,
  formatPercent,
  headlineFor,
  readText,
  plain,
} from '../lib/hotspots.js';
import { escapeQueryValue } from '../lib/slashCommands.js';

const CACHE_MS = 45000;
const TX_SAMPLE = 500;
const LOG_SAMPLE = 1000;
const TOP = 15;
const cache = new Map();

const errorText = (err) => err?.message || String(err);

/** One cached read: the same question inside CACHE_MS is answered from memory. */
async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Aggregate API: counts per group of `fields` for rows matching `query`. */
async function groupCounts(table, query, fields) {
  const params = new URLSearchParams({ sysparm_count: 'true', sysparm_group_by: fields.join(','), sysparm_query: query });
  const response = await fetch(`/api/now/stats/${encodeURIComponent(table)}?${params.toString()}`, { credentials: 'same-origin', headers: await sessionHeaders() });
  if (response.status === 403) throw new Error(`Your user cannot read ${table} (403).`);
  if (!response.ok) throw new Error(`The instance could not group ${table} (${response.status}).`);
  return parseGroupCounts(await response.json());
}

const rowsOf = (table, query, fields, limit) => cached(`rows|${table}|${query}|${fields.join(',')}|${limit}`, () => queryTable(table, query, fields, { limit }));
const groupsOf = (table, query, fields) => cached(`group|${table}|${query}|${fields.join(',')}`, () => groupCounts(table, query, fields));
const countOf = (table, query) => cached(`count|${table}|${query}`, () => countRecords(table, query));

const barWeights = (values) => {
  const max = Math.max(0, ...values.filter((v) => Number.isFinite(v)));
  return values.map((v) => (max > 0 && Number.isFinite(v) ? v / max : 0));
};

/** { columns, rows: [{ cells, href, weight }], headline, note } - the shape every section answers with. */
function result({ columns, rows, headline = '', note = '' }) {
  return { columns, rows, headline, note };
}

const emptyNote = (what) => `Nothing found: ${what}`;

// --- Slow -----------------------------------------------------------------------------------------------

async function transactionSample(windowId) {
  const cond = windowCondition(windowId);
  const rows = await rowsOf('syslog_transaction', `${cond}^ORDERBYDESCresponse_time`, TRANSACTION_FIELDS, TX_SAMPLE);
  const total = await countOf('syslog_transaction', cond).catch(() => null);
  return { rows, total, cond };
}

const sampleNote = (shown, total, what) => (total && total > shown ? `Based on the ${formatCount(shown)} ${what} of ${formatCount(total)} requests in the window.` : '');

async function slowPages(windowId) {
  const { rows, total, cond } = await transactionSample(windowId);
  const usable = rows.filter((r) => transactionKind(r.url) !== 'job');
  const cols = availableColumns(usable);
  if (!cols.response) return result({ columns: [], rows: [], note: usable.length ? 'This release does not record response times on syslog_transaction.' : emptyNote('no requests were logged in this window.') });
  const groups = summarizeTransactions(usable).slice(0, TOP);
  const weights = barWeights(groups.map((g) => g.totalMs));
  const notes = [sampleNote(rows.length, total, 'slowest')];
  if (!cols.sql) notes.push('This release does not record SQL time per request.');
  if (!cols.rules) notes.push('This release does not record business rule time per request.');
  return result({
    columns: ['Request', 'Slow requests', 'Average', '95th pct', 'Slowest', 'In SQL', 'In rules'],
    rows: groups.map((g, i) => ({
      cells: [g.pattern, String(g.count), formatMs(g.avgMs), formatMs(g.p95Ms), formatMs(g.maxMs), g.sqlShare === null ? '-' : formatPercent(g.sqlShare, 1), g.ruleShare === null ? '-' : formatPercent(g.ruleShare, 1)],
      href: listUrl('syslog_transaction', `${cond}^urlSTARTSWITH${escapeQueryValue(patternPrefix(g.pattern))}^ORDERBYDESCresponse_time`),
      weight: weights[i],
    })),
    headline: headlineFor('slowPages', { rows: groups }),
    note: notes.filter(Boolean).join(' '),
  });
}

async function slowUsers(windowId) {
  const { rows, total, cond } = await transactionSample(windowId);
  const users = summarizeUsers(rows.filter((r) => transactionKind(r.url) !== 'job')).slice(0, TOP);
  if (!users.length) return result({ columns: [], rows: [], note: emptyNote('no timed requests in this window.') });
  const weights = barWeights(users.map((u) => u.totalMs));
  return result({
    columns: ['User', 'Slow requests', 'Total time', 'Average', 'Slowest', 'Mostly'],
    rows: users.map((u, i) => ({
      cells: [u.user, String(u.count), formatMs(u.totalMs), formatMs(u.avgMs), formatMs(u.maxMs), u.topPattern],
      href: listUrl('syslog_transaction', `${cond}^${u.field}=${escapeQueryValue(u.user)}^ORDERBYDESCresponse_time`),
      weight: weights[i],
    })),
    headline: headlineFor('slowUsers', { rows: users }),
    note: sampleNote(rows.length, total, 'slowest'),
  });
}

async function heavyBy(windowId, column, id, label) {
  const cond = windowCondition(windowId);
  const rows = await rowsOf('syslog_transaction', `${cond}^${column}ISNOTEMPTY^ORDERBYDESC${column}`, TRANSACTION_FIELDS, 40);
  if (rows.length && !availableColumns(rows)[column === 'sql_time' ? 'sql' : 'rules']) return result({ columns: [], rows: [], note: `This release does not record ${label} per request.` });
  const top = heaviest(rows, column, TOP);
  if (!top.length) return result({ columns: [], rows: [], note: emptyNote(`no request spent measurable time in ${label} in this window.`) });
  const weights = barWeights(top.map((t) => t.ms));
  const countName = column === 'sql_time' ? 'Queries' : 'Rule runs';
  return result({
    columns: ['Request', label === 'SQL' ? 'In SQL' : 'In rules', 'Total', countName, 'User'],
    rows: top.map((t, i) => ({
      cells: [t.pattern, formatMs(t.ms), formatMs(t.totalMs), String(column === 'sql_time' ? t.sqlCount ?? '-' : t.ruleCount ?? '-'), t.user],
      href: t.sysId ? recordUrl('syslog_transaction', t.sysId) : '',
      weight: weights[i],
    })),
    headline: headlineFor(id, { rows: top.map((t) => ({ pattern: t.pattern, ms: t.ms, sqlCount: t.sqlCount, ruleCount: t.ruleCount })) }),
  });
}

const sqlHeavy = (w) => heavyBy(w, 'sql_time', 'sqlHeavy', 'SQL');
const ruleHeavy = (w) => heavyBy(w, 'business_rule_time', 'ruleHeavy', 'business rules');

async function slowJobs(windowId) {
  const cond = windowCondition(windowId);
  const rows = await rowsOf('syslog_transaction', `${cond}^urlSTARTSWITHJOB:^ORDERBYDESCresponse_time`, TRANSACTION_FIELDS, TX_SAMPLE);
  const jobs = summarizeJobs(rows).slice(0, TOP);
  if (!jobs.length) return result({ columns: [], rows: [], note: emptyNote('no scheduled job finished in this window, or this release does not log jobs as transactions.') });
  const weights = barWeights(jobs.map((j) => j.totalMs));
  return result({
    columns: ['Job', 'Runs', 'Total time', 'Average', 'Longest run'],
    rows: jobs.map((j, i) => ({
      cells: [j.name, String(j.count), formatMs(j.totalMs), formatMs(j.avgMs), formatMs(j.maxMs)],
      href: listUrl('syslog_transaction', `${cond}^url=${escapeQueryValue(j.pattern)}^ORDERBYDESCresponse_time`),
      weight: weights[i],
    })),
    headline: headlineFor('slowJobs', { rows: jobs }),
    note: rows.length >= TX_SAMPLE ? `Based on the ${TX_SAMPLE} longest job runs in the window.` : '',
  });
}

async function runningJobs() {
  const rows = await cached('running', () => queryTable('sys_trigger', 'state=1^ORDERBYnext_action', ['name', 'state', 'next_action', 'claimed_by', 'sys_id'], { limit: 100 }));
  const stuck = stuckJobs(rows).slice(0, TOP);
  if (!stuck.length) return result({ columns: [], rows: [], note: emptyNote(`no running job is more than 15 minutes overdue (${rows.length} running now).`) });
  const weights = barWeights(stuck.map((j) => j.overdueMin));
  return result({
    columns: ['Job', 'Overdue by', 'Claimed by'],
    rows: stuck.map((j, i) => ({ cells: [j.name, formatMs(j.overdueMin * 60000), j.node || '-'], href: j.sysId ? recordUrl('sys_trigger', j.sysId) : '', weight: weights[i] })),
    headline: headlineFor('runningJobs', { rows: stuck }),
    note: 'Shows the current state; the time window does not apply.',
  });
}

// --- Noisy ----------------------------------------------------------------------------------------------

const MESSAGE_FIELDS = ['message', 'source', 'level', 'sys_created_on'];

function messageRows(groups, table, cond) {
  const top = groups.slice(0, TOP);
  const weights = barWeights(top.map((g) => g.count));
  return {
    top,
    rows: top.map((g, i) => {
      const filter = messageFilter(g.message);
      return {
        cells: [g.message, String(g.count), g.source ? `${g.source}${g.sourceCount > 1 ? ` +${g.sourceCount - 1}` : ''}` : '-', g.level || '-', g.last || '-'],
        href: filter ? listUrl(table, `${cond}^${filter}^ORDERBYDESCsys_created_on`) : listUrl(table, cond),
        weight: weights[i],
      };
    }),
  };
}

async function logMessages(windowId) {
  const cond = windowCondition(windowId);
  const rows = await rowsOf('syslog', `${cond}^ORDERBYDESCsys_created_on`, MESSAGE_FIELDS, LOG_SAMPLE);
  const total = await countOf('syslog', cond).catch(() => null);
  if (!rows.length) return result({ columns: [], rows: [], note: emptyNote('nothing was logged in this window.') });
  const { top, rows: out } = messageRows(groupMessages(rows), 'syslog', cond);
  return result({
    columns: ['Message (ids and numbers collapsed)', 'Times', 'Source', 'Level', 'Last seen'],
    rows: out,
    headline: headlineFor('logMessages', { rows: top }),
    note: total && total > rows.length ? `Based on the newest ${formatCount(rows.length)} of ${formatCount(total)} entries in the window.` : '',
  });
}

async function errors(windowId) {
  const cond = `${windowCondition(windowId)}^level=2`;
  const rows = await rowsOf('syslog', `${cond}^ORDERBYDESCsys_created_on`, MESSAGE_FIELDS, LOG_SAMPLE);
  const total = await countOf('syslog', cond).catch(() => null);
  if (!rows.length) return result({ columns: [], rows: [], note: emptyNote('no error-level entries in this window.') });
  const { top, rows: out } = messageRows(groupMessages(rows), 'syslog', cond);
  return result({
    columns: ['Error (ids and numbers collapsed)', 'Times', 'Source', 'Level', 'Last seen'],
    rows: out,
    headline: headlineFor('errors', { rows: top }),
    note: total && total > rows.length ? `Based on the newest ${formatCount(rows.length)} of ${formatCount(total)} errors in the window.` : `${formatCount(total ?? rows.length)} error entries in the window.`,
  });
}

/** Sections that are one aggregate over one column, shown as value / count / share. */
function aggregateSection({ id, table, field, extra = '', label, listTable = table, note = '' }) {
  return async (windowId) => {
    const cond = `${windowCondition(windowId)}${extra}`;
    const groups = await groupsOf(table, cond, [field]);
    const { total, rows } = topGroups(groups, field, TOP);
    if (!rows.length) return result({ columns: [], rows: [], note: emptyNote(`no ${label.toLowerCase()} in this window.`) });
    const weights = barWeights(rows.map((r) => r.count));
    return result({
      columns: [label, 'Count', 'Share'],
      rows: rows.map((r, i) => ({
        cells: [r.value, formatCount(r.count), formatPercent(r.count, total)],
        href: listUrl(listTable, `${cond}^${field}=${escapeQueryValue(r.raw)}^ORDERBYDESCsys_created_on`),
        weight: weights[i],
      })),
      headline: headlineFor(id, { total, rows }),
      note,
    });
  };
}

const logSources = aggregateSection({ id: 'logSources', table: 'syslog', field: 'source', label: 'Source' });
const events = aggregateSection({ id: 'events', table: 'sysevent', field: 'name', label: 'Event' });
const users = aggregateSection({ id: 'users', table: 'syslog_transaction', field: 'sys_created_by', label: 'User', note: 'Counts every request, including integrations and scheduled jobs.' });
const tablesWritten = aggregateSection({ id: 'tablesWritten', table: 'sys_audit', field: 'tablename', label: 'Table', note: 'Only audited tables appear.' });

async function outbound(windowId) {
  const cond = windowCondition(windowId);
  const rows = await rowsOf('sys_outbound_http_log', `${cond}^ORDERBYDESCsys_created_on`, ['url', 'endpoint', 'http_method', 'response_code', 'http_status', 'status', 'response_time', 'elapsed', 'sys_created_on'], 500);
  const groups = summarizeOutbound(rows).slice(0, TOP);
  if (!groups.length) return result({ columns: [], rows: [], note: emptyNote('no outbound call was logged in this window (outbound logging may be off).') });
  const weights = barWeights(groups.map((g) => g.count));
  return result({
    columns: ['Endpoint', 'Calls', 'Failed', 'Average', 'Slowest'],
    rows: groups.map((g, i) => ({ cells: [g.endpoint, String(g.count), String(g.errors), g.avgMs === null ? '-' : formatMs(g.avgMs), g.maxMs === null ? '-' : formatMs(g.maxMs)], href: listUrl('sys_outbound_http_log', `${cond}^ORDERBYDESCsys_created_on`), weight: weights[i] })),
    headline: headlineFor('outbound', { rows: groups }),
    note: rows.length >= 500 ? 'Based on the newest 500 calls in the window.' : '',
  });
}

/** "INC0010042 - Laptop will not boot" for a record, or '' when it cannot be read. */
async function describeRecords(records) {
  const byTable = new Map();
  records.forEach((r) => {
    if (r.table) byTable.set(r.table, [...(byTable.get(r.table) || []), r.sysId]);
  });
  const names = new Map();
  await Promise.all(
    [...byTable.entries()].slice(0, 6).map(async ([table, ids]) => {
      try {
        const rows = await queryTable(table, `sys_idIN${ids.join(',')}`, ['sys_id', 'number', 'name', 'short_description', 'sys_name'], { limit: ids.length });
        rows.forEach((row) => names.set(`${table}:${plain(row.sys_id)}`, [readText(row, ['number', 'name', 'sys_name']), plain(row.short_description)].filter(Boolean).join(' - ')));
      } catch {
        // A table the user cannot read keeps its bare id.
      }
    })
  );
  return names;
}

async function churn(windowId) {
  const cond = windowCondition(windowId);
  const groups = await groupsOf('sys_audit', cond, ['tablename', 'documentkey']);
  const top = topRecords(groups, TOP);
  if (!top.length) return result({ columns: [], rows: [], note: emptyNote('no audited change in this window.') });
  const names = await describeRecords(top);
  const weights = barWeights(top.map((t) => t.count));
  return result({
    columns: ['Record', 'Table', 'Changes'],
    rows: top.map((t, i) => ({
      cells: [names.get(`${t.table}:${t.sysId}`) || `${t.sysId.slice(0, 8)}…`, t.table || '-', String(t.count)],
      href: t.table ? recordUrl(t.table, t.sysId) : '',
      weight: weights[i],
    })),
    headline: headlineFor('churn', { rows: top }),
    note: 'Counts audited field changes, so a record with many audited fields shows more.',
  });
}

const LOADERS = { slowPages, slowUsers, sqlHeavy, ruleHeavy, slowJobs, runningJobs, logMessages, errors, logSources, events, users, outbound, churn, tablesWritten };

/**
 * Load one section for a window. Never throws: a failure becomes `error` so the other sections keep working.
 * @returns {Promise<{ columns: string[], rows: object[], headline: string, note: string, error?: string }>}
 */
export async function hotspotSection(id, windowId) {
  const loader = LOADERS[id];
  if (!loader) return { columns: [], rows: [], headline: '', note: '', error: `Unknown section "${id}".` };
  try {
    return await loader(windowId);
  } catch (err) {
    const text = errorText(err);
    const missing = /\b(400|404)\b|not found|invalid table/i.test(text);
    return { columns: [], rows: [], headline: '', note: '', error: missing ? 'This table is not available on this instance or release.' : text };
  }
}

/** Services for the panel (merged by featureServices.js). */
export const hotspotServices = {
  hotspotSection: (id, windowId) => hotspotSection(id, windowId),
  hotspotsClearCache: async () => {
    cache.clear();
  },
};
