// The Test panel (/test), the instance half: run a script against a record, run unit tests, find ATF tests, snapshots, and
// the per-user access check behind the matrix. The pure half is src/lib/testRun.js, testKit.js, testSnapshot.js and
// testAtf.js; the panel is src/sidebar/TestKitPanel.jsx.
//
// What writes where: a DRY RUN intercepts GlideRecord writes (scriptSafety.wrapAsDryRun) and lists them. A REAL run, or a
// unit test run with dry run off, only happens when the caller passes `confirmed: true`, which the panel sets after the
// in-app confirmation (production gets the strong wording). Snapshots and saved tests are stored in chrome.storage.local;
// nothing else is written to the instance by anything in this file.

import { queryTable, queryAll, runBackgroundScript } from './tableApi.js';
import { getCsrfToken } from './context.js';
import { wrapAsDryRun, wrapWithGuards } from '../lib/scriptSafety.js';
import { extractScriptOutput } from '../lib/logTail.js';
import { fetchListLayout, fetchTableFields } from './fieldInspector.js';
import { explainAccess } from './accessDebugger.js';
import { buildRecordScript, parseRunOutput, summarizeRun, runKindForTable } from '../lib/testRun.js';
import { extractMethods, parseTestOutput, makeSavedTest, upsertSavedTest, removeSavedTest, recordSavedRun, matrixCell, matrixErrorCell } from '../lib/testKit.js';
import * as snap from '../lib/testSnapshot.js';
import * as atf from '../lib/testAtf.js';

const SAVED_KEY = 'mysnowbuddy_saved_tests';
const SNAPSHOT_KEY = 'mysnowbuddy_test_snapshots';
const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const TABLE_RE = /^[a-z][a-z0-9_]*$/;

const flat = (cell) => (cell && typeof cell === 'object' ? String(cell.value ?? '') : String(cell ?? ''));
const shown = (cell) => (cell && typeof cell === 'object' ? String(cell.display_value || cell.value || '') : String(cell ?? ''));
const host = () => window.location.hostname;

// --- What is on screen ----------------------------------------------------------------------------------------------

const TARGET_FIELDS = {
  sys_script: ['name', 'collection', 'when', 'active', 'advanced', 'script'],
  sys_ui_action: ['name', 'table', 'client', 'active', 'script'],
  sys_script_include: ['name', 'api_name', 'client_callable', 'active', 'script'],
  sys_script_fix: ['name', 'script'],
  sysauto_script: ['name', 'script'],
};

/**
 * What the record on screen is, as far as testing goes: a runnable script (with its kind, the table it runs on and, for a
 * Script Include, its methods), or just a record.
 */
export async function testTarget({ table = '', sysId = '' } = {}) {
  if (!TABLE_RE.test(table)) return { kind: null, table: '', sysId: '' };
  const base = { kind: runKindForTable(table), table, sysId: SYS_ID_RE.test(sysId) ? sysId : '' };
  if (!base.kind || !base.sysId) return base;
  const rows = await queryTable(table, `sys_id=${sysId}`, TARGET_FIELDS[table] || ['name', 'script'], { limit: 1 });
  const row = rows[0];
  if (!row) return { ...base, notFound: true };
  const script = String(row.script ?? '');
  const out = { ...base, name: String(row.name ?? ''), script, active: String(row.active) !== 'false', runsOn: String(row.collection || row.table || '') };
  if (base.kind === 'scriptInclude') {
    const { className, methods } = extractMethods(script);
    out.apiName = String(row.api_name || '');
    out.className = className || out.name;
    out.methods = methods;
    out.clientCallable = String(row.client_callable) === 'true';
  }
  if (table === 'sys_ui_action') out.clientSide = String(row.client) === 'true';
  return out;
}

/** The best column to show a record by. */
async function labelField(table) {
  const { fields } = await fetchTableFields(table).catch(() => ({ fields: [] }));
  const names = new Set(fields.map((f) => f.name));
  return ['number', 'name', 'short_description', 'user_name', 'title', 'sys_id'].find((n) => names.has(n)) || 'sys_id';
}

/** Records of `table` to run against: the newest, or the ones matching what the user typed (a number, a name, a sys_id). */
export async function testFindRecords({ table, term = '' } = {}) {
  if (!TABLE_RE.test(table || '')) throw new Error('Name the table first.');
  const text = String(term).trim();
  if (text.includes('^')) throw new Error('Search text cannot contain "^".');
  const label = await labelField(table);
  let query = 'ORDERBYDESCsys_updated_on';
  if (SYS_ID_RE.test(text)) query = `sys_id=${text}`;
  else if (text) query = `${label}LIKE${text}^ORDERBYDESCsys_updated_on`;
  const rows = await queryTable(table, query, ['sys_id', label, 'sys_updated_on'], { limit: 10, displayValue: true });
  return rows.map((row) => ({ sysId: flat(row.sys_id), label: shown(row[label]) || flat(row.sys_id).slice(0, 8), updatedOn: shown(row.sys_updated_on) }));
}

// --- Running a script ---------------------------------------------------------------------------------------------------

async function execute(script, { dryRun, confirmed }) {
  if (!dryRun && confirmed !== true) throw new Error('A real run needs your confirmation first.');
  const token = await getCsrfToken();
  const html = await runBackgroundScript(dryRun ? wrapAsDryRun(script) : wrapWithGuards(script), token);
  return extractScriptOutput(html);
}

/**
 * Run a script against a record (see buildRecordScript for the arguments). Dry run unless `dryRun === false` AND the
 * caller confirmed.
 */
export async function testRunOnRecord(options = {}) {
  const { dryRun = true, confirmed = false, ...build } = options;
  const built = buildRecordScript(build);
  const output = await execute(built.script, { dryRun, confirmed });
  const parsed = parseRunOutput(output);
  return { dryRun, kind: built.label, warnings: built.warnings, parsed, summary: summarizeRun(parsed, { dryRun }), script: built.script };
}

/** Run a generated unit test script. Dry run by default. */
export async function testRunUnit({ script, dryRun = true, confirmed = false } = {}) {
  if (!String(script || '').trim()) throw new Error('There is no test to run.');
  const output = await execute(script, { dryRun, confirmed });
  const run = parseRunOutput(output);
  return { dryRun, results: parseTestOutput(output), run };
}

// --- Saved tests ------------------------------------------------------------------------------------------------------

async function readStore(key) {
  const res = await chrome.storage.local.get(key);
  return Array.isArray(res[key]) ? res[key] : [];
}

export const testSavedList = () => readStore(SAVED_KEY);

export async function testSavedSave(entry) {
  const made = makeSavedTest(entry);
  if (!made) throw new Error('Give the test a name and a script.');
  const list = upsertSavedTest(await readStore(SAVED_KEY), made);
  await chrome.storage.local.set({ [SAVED_KEY]: list });
  return list;
}

export async function testSavedRemove(id) {
  const list = removeSavedTest(await readStore(SAVED_KEY), id);
  await chrome.storage.local.set({ [SAVED_KEY]: list });
  return list;
}

export async function testSavedRecordRun(id, summary) {
  const list = recordSavedRun(await readStore(SAVED_KEY), id, summary);
  await chrome.storage.local.set({ [SAVED_KEY]: list });
  return list;
}

// --- ATF finder ----------------------------------------------------------------------------------------------------------

/**
 * ATF tests and suites that mention a table or a Script Include, with their last results. Read-only.
 * Starting a suite is the existing runAtfSuite / readAtfProgress service, behind its own confirmation.
 */
export async function testAtfFind({ table = '', name = '', apiName = '' } = {}) {
  const terms = atf.searchTerms({ table, name, apiName });
  if (!terms.length) throw new Error('Open a table, a record or a Script Include first.');
  const [stepRows, namedTests] = await Promise.all([
    queryTable('sys_atf_step', atf.stepQuery(terms), ['sys_id', 'test', 'description', 'inputs'], { limit: 300, displayValue: true }),
    queryTable('sys_atf_test', atf.testNameQuery(terms), ['sys_id', 'name', 'active', 'description'], { limit: 100 }),
  ]);
  // A server that does not know a column returns every row, so the steps are filtered again on what they mention.
  const steps = stepRows.filter((s) => terms.some((t) => `${shown(s.description)} ${shown(s.inputs)}`.toLowerCase().includes(t.toLowerCase())));
  const testIds = [...new Set([...steps.map((s) => flat(s.test)), ...namedTests.map((t) => flat(t.sys_id))].filter(atf.isSysId))].slice(0, 100);
  if (!testIds.length) return { terms, ...atf.buildAtfReport({}) };

  const loadIn = async (tableName, field, ids, fields, extra, options) => {
    const parts = await Promise.all(atf.chunk(ids, 40).map((c) => queryTable(tableName, atf.inQuery(field, c, extra), fields, options)));
    return parts.flat();
  };
  const tests = await loadIn('sys_atf_test', 'sys_id', testIds, ['sys_id', 'name', 'active', 'description'], '', { limit: 100, displayValue: true });
  const [results, suiteLinks] = await Promise.all([
    loadIn('sys_atf_test_result', 'test', testIds, ['test', 'status', 'start_time', 'run_time', 'output', 'sys_created_on'], '^ORDERBYDESCsys_created_on', { limit: 200, displayValue: true }),
    loadIn('sys_atf_test_suite_test', 'test', testIds, ['test_suite', 'test'], '', { limit: 200 }),
  ]);
  const suiteIds = [...new Set(suiteLinks.map((l) => flat(l.test_suite)).filter(atf.isSysId))];
  const suites = suiteIds.length ? await loadIn('sys_atf_test_suite', 'sys_id', suiteIds, ['sys_id', 'name', 'active'], '', { limit: 100, displayValue: true }) : [];
  const suiteResults = suiteIds.length
    ? await loadIn('sys_atf_test_suite_result', 'test_suite', suiteIds, ['test_suite', 'status', 'success_count', 'failure_count', 'sys_created_on'], '^ORDERBYDESCsys_created_on', { limit: 100, displayValue: true })
    : [];
  return { terms, ...atf.buildAtfReport({ steps, tests, results, suiteLinks, suites, suiteResults }) };
}

// --- Snapshots ------------------------------------------------------------------------------------------------------------

async function readNow(table, sysId) {
  const rows = await queryTable(table, `sys_id=${sysId}`, [], { limit: 1, displayValue: true });
  if (!rows[0]) throw new Error('The record was not found, or you cannot read it.');
  return rows[0];
}

async function storeSnapshots(update) {
  const list = update(await readStore(SNAPSHOT_KEY));
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: list });
  return list;
}

export async function testSnapshotList({ table = '', sysId = '' } = {}) {
  return snap.snapshotsFor(await readStore(SNAPSHOT_KEY), { host: host(), table, sysId }).map(summarize);
}

const summarize = (s) => ({ id: s.id, kind: s.kind, name: s.name, at: s.at, label: s.label || '', count: s.kind === 'list' ? s.rows.length : Object.keys(s.fields).length, capped: Boolean(s.capped) });

export async function testSnapshotTake({ table, sysId, name = '' } = {}) {
  if (!TABLE_RE.test(table || '') || !SYS_ID_RE.test(sysId || '')) throw new Error('Open a saved record first.');
  const row = await readNow(table, sysId);
  const label = shown(row.number) || shown(row.name) || shown(row.short_description);
  const made = snap.makeRecordSnapshot({ host: host(), table, sysId, name, row, label });
  await storeSnapshots((list) => snap.addSnapshot(list, made));
  return summarize(made);
}

/** The record now against a snapshot of it. */
export async function testSnapshotCompare({ id } = {}) {
  const saved = (await readStore(SNAPSHOT_KEY)).find((s) => s.id === id && s.kind === 'record');
  if (!saved) throw new Error('That snapshot is gone.');
  const row = await readNow(saved.table, saved.sysId);
  const now = snap.makeRecordSnapshot({ host: saved.host, table: saved.table, sysId: saved.sysId, name: 'now', row });
  return { name: saved.name, table: saved.table, at: saved.at, diff: snap.diffRecordSnapshots(saved, now) };
}

async function listRows(table, query) {
  const layout = await fetchListLayout(table).catch(() => []);
  const columns = (layout[0]?.columns || ['number', 'name', 'short_description', 'state', 'priority', 'sys_updated_on']).slice(0, snap.SNAPSHOT_LIMITS.listFields);
  const fields = [...new Set(['sys_id', ...columns])];
  const rows = await queryAll(table, query, fields, { max: snap.SNAPSHOT_LIMITS.listRows, displayValue: true });
  return rows;
}

export async function testSnapshotTakeList({ table, query = '', name = '' } = {}) {
  if (!TABLE_RE.test(table || '')) throw new Error('Open a list first.');
  const made = snap.makeListSnapshot({ host: host(), table, query, name, rows: await listRows(table, query) });
  await storeSnapshots((list) => snap.addSnapshot(list, made));
  return summarize(made);
}

export async function testSnapshotCompareList({ id } = {}) {
  const saved = (await readStore(SNAPSHOT_KEY)).find((s) => s.id === id && s.kind === 'list');
  if (!saved) throw new Error('That snapshot is gone.');
  const now = snap.makeListSnapshot({ host: saved.host, table: saved.table, query: saved.query, name: 'now', rows: await listRows(saved.table, saved.query) });
  return { name: saved.name, table: saved.table, at: saved.at, query: saved.query, capped: Boolean(saved.capped || now.capped), diff: snap.diffListSnapshots(saved, now) };
}

export async function testSnapshotRemove(id) {
  await storeSnapshots((list) => snap.removeSnapshot(list, id));
  return true;
}

// --- Access matrix -------------------------------------------------------------------------------------------------------

/** One row of the matrix: one user, the chosen operations. Never throws: a failed cell says why. */
export async function testAccessRow({ user = '', table, sysId = '', field = '', operations = ['read', 'write'] } = {}) {
  const cells = {};
  for (const operation of operations) {
    try {
      // eslint-disable-next-line no-await-in-loop -- a few requests per operation; one user at a time keeps the load low.
      cells[operation] = matrixCell(await explainAccess({ user, table, sysId, field, operation }));
    } catch (err) {
      cells[operation] = matrixErrorCell(err.message || String(err));
    }
  }
  return { user, cells };
}

export const testKitServices = {
  testTarget,
  testFindRecords,
  testRunOnRecord,
  testRunUnit,
  testSavedList,
  testSavedSave,
  testSavedRemove,
  testSavedRecordRun,
  testAtfFind,
  testSnapshotList,
  testSnapshotTake,
  testSnapshotCompare,
  testSnapshotTakeList,
  testSnapshotCompareList,
  testSnapshotRemove,
  testAccessRow,
};

