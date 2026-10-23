// "Why is this ticket stuck?" (/flows), the instance half. Reads everything running or run against one record: Flow Designer
// executions, legacy workflow contexts and their current activity, approvals, SLAs, child and catalog tasks and queued
// events. Read-only. Every source fails soft: a table that is missing or that your user cannot read becomes a note on
// its own section and the other sources still load.
// The pure half (what is read, how rows are checked and explained, the wording) is src/lib/processView.js; the panel is
// src/sidebar/ProcessPanel.jsx.

import { queryTable } from './tableApi.js';
import { isAdminSession } from './adminSession.js';
import { withFlowNames } from './flowNames.js';
import {
  PROBES,
  SYS_ID_RE,
  TABLE_RE,
  raw,
  disp,
  dictionaryNeeds,
  buildSchema,
  unverifiedSchema,
  tableTraits,
  planProbes,
  runProbe,
  classifyReadError,
  plansToConfirm,
  unseenResult,
  buildReport,
} from '../lib/processView.js';

const CONCURRENCY = 4;
const MAX_SUPER_LEVELS = 8;
const MAX_LOG_CONTEXTS = 3;
const MAX_ACTIVE_WORKFLOWS = 10;
const MAX_HISTORY_WORKFLOWS = 5;

/** Run `task(item)` over `items`, `max` at a time, keeping the order of the results. */
async function pool(items, max, task) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop -- each worker takes the next item only when it is free.
      out[i] = await task(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(max, items.length) }, worker));
  return out;
}

const sessionExpired = (err) => err?.code === 'SESSION_EXPIRED';

/**
 * Which tables and columns exist, from the dictionary. If it cannot be read (or hides the table on screen) the schema is
 * "unverified": everything is tried and each answer is checked against the record instead.
 */
async function readSchema(table) {
  const { tables, columns } = dictionaryNeeds();
  try {
    const objectRows = [];
    const asked = new Set();
    let pending = [...new Set([table, 'task', ...tables])];
    for (let level = 0; level < MAX_SUPER_LEVELS && pending.length; level += 1) {
      pending.forEach((t) => asked.add(t));
      // eslint-disable-next-line no-await-in-loop -- each level of the hierarchy depends on the previous one.
      const rows = await queryTable('sys_db_object', `nameIN${pending.join(',')}`, ['name', 'super_class.name'], { limit: 200 });
      objectRows.push(...rows);
      pending = [...new Set(rows.map((r) => raw(r['super_class.name'])).filter((name) => name && !asked.has(name)))];
    }
    const names = [...new Set(objectRows.map((r) => raw(r.name)).filter(Boolean))];
    if (!names.includes(table)) return { schema: unverifiedSchema(), note: dictionaryNote() };
    const dictRows = await queryTable('sys_dictionary', `nameIN${names.join(',')}^elementIN${columns.join(',')}`, ['name', 'element'], { limit: 1000 });
    const schema = buildSchema({ objectRows, dictRows, primary: table });
    return schema.trusted ? { schema, note: '' } : { schema, note: dictionaryNote() };
  } catch (err) {
    if (sessionExpired(err)) throw err;
    return { schema: unverifiedSchema(), note: dictionaryNote() };
  }
}

const dictionaryNote = () => 'The data dictionary could not be read, so the tables and columns were not checked first. Every answer was still checked against this record before it was used.';

async function readRecord(table, sysId) {
  try {
    const rows = await queryTable(table, `sys_id=${sysId}`, ['number', 'name', 'short_description', 'user_name', 'active'], { limit: 1, displayValue: true });
    const row = rows[0];
    if (!row) return {};
    const active = raw(row.active).toLowerCase();
    return {
      label: disp(row.number) || disp(row.name) || disp(row.user_name) || disp(row.short_description) || '',
      summary: row.number ? disp(row.short_description) : '',
      active: active === 'true' ? true : active === 'false' ? false : null,
    };
  } catch (err) {
    if (sessionExpired(err)) throw err;
    return {};
  }
}

async function runPlan(plan, ctx) {
  const { probe } = plan;
  try {
    const found = await queryTable(probe.table, plan.query, probe.fields, { limit: probe.limit, displayValue: true });
    const rows = probe.table === 'sys_flow_context' ? await withFlowNames(found) : found;
    return runProbe(probe, rows, ctx);
  } catch (err) {
    if (sessionExpired(err)) throw err;
    const { status, note } = classifyReadError(err, probe.table);
    return { status, note, items: [] };
  }
}

const okItems = (results, id) => (results[id]?.status === 'ok' ? results[id].items : []);

/**
 * Everything running or run against one record.
 * @param {{ table: string, sysId: string, isCancelled?: () => boolean }} options
 */
export async function processLoad({ table, sysId, isCancelled = () => false } = {}) {
  if (!TABLE_RE.test(table || '') || !SYS_ID_RE.test(sysId || '')) throw new Error('Open a saved record first (a form with a sys_id).');
  const now = Date.now();

  const [{ schema, note: schemaNote }, record] = await Promise.all([readSchema(table), readRecord(table, sysId)]);
  if (isCancelled()) return null;
  const chain = schema.chain(table);
  const traits = tableTraits(table, chain);

  // Stage 1: everything that is found from the record itself.
  const ctx = { sysId, ids: [] };
  const stage1 = planProbes({ probes: PROBES.filter((p) => !p.stage), sysId, schema, traits });
  const results = {};
  await pool(
    stage1.filter((p) => p.status === 'run'),
    CONCURRENCY,
    async (plan) => {
      results[plan.probe.id] = await runPlan(plan, ctx);
    }
  );
  if (isCancelled()) return null;

  // An empty primary source is confirmed with one unfiltered one-row read: an ACL hides rows without an error, and
  // "nothing is running" must not rest on a table the user cannot see. At most one extra read per source.
  // An admin session reads every one of these tables, so an empty answer is true and needs no confirming read.
  const confirm = (await isAdminSession()) ? [] : plansToConfirm(stage1, results);
  await pool(confirm, CONCURRENCY, async (plan) => {
    try {
      const rows = await queryTable(plan.probe.table, '', ['sys_id'], { limit: 1 });
      if (!rows.length) results[plan.probe.id] = unseenResult(plan.probe);
    } catch (err) {
      if (sessionExpired(err)) throw err;
      const { status, note } = classifyReadError(err, plan.probe.table);
      results[plan.probe.id] = { status, note, items: [] };
    }
  });
  if (isCancelled()) return null;

  // Stage 2: what is found from the contexts of stage 1 (the current activity, the history, the flow log).
  const flows = okItems(results, 'flowContext');
  const workflows = okItems(results, 'wfContext');
  const byId = (id) => PROBES.find((p) => p.id === id);
  const logIds = flows
    .filter((f) => f.state === 'error' || f.active)
    .slice(0, MAX_LOG_CONTEXTS)
    .map((f) => f.sysId);
  const activeIds = workflows.filter((w) => w.active).slice(0, MAX_ACTIVE_WORKFLOWS).map((w) => w.sysId);
  const historyIds = [...workflows.filter((w) => w.active), ...workflows.filter((w) => !w.active)].slice(0, MAX_HISTORY_WORKFLOWS).map((w) => w.sysId);
  const stage2 = [
    ...planProbes({ probes: [byId('flowLog')], sysId, schema, traits, ids: logIds }),
    ...planProbes({ probes: [byId('wfExecuting')], sysId, schema, traits, ids: activeIds }),
    ...planProbes({ probes: [byId('wfHistory')], sysId, schema, traits, ids: historyIds }),
  ];
  await pool(
    stage2.filter((p) => p.status === 'run'),
    CONCURRENCY,
    async (plan) => {
      const ids = plan.probe.id === 'flowLog' ? logIds : plan.probe.id === 'wfExecuting' ? activeIds : historyIds;
      results[plan.probe.id] = await runPlan(plan, { sysId, ids });
    }
  );
  if (isCancelled()) return null;

  const report = buildReport({ table, sysId, record, chain, plans: [...stage1, ...stage2], results, traits, schemaTrusted: schema.trusted, now });
  return { ...report, schemaNote, host: typeof location === 'object' ? location.host : '' };
}

export const processServices = {
  processLoad: (options) => processLoad(options),
};

// Called once from src/content/featureStartup.js when the page loads (optional). Nothing here needs to run early.
export function install() {}
