// Self-check, the instance half: asks this ServiceNow instance what NowBuddy can actually do here and hands the raw
// answers to src/lib/doctor.js, which turns them into plain-words checks, a status per tool and a copyable report.
//
// READ-ONLY. Table API and Stats API reads under the user's own session, the two update set / application picker reads,
// and one harmless background script (a single gs.print) that is skipped on instances that look like production.
// No record data is kept: a probe reads at most one row, and only the names of its columns are looked at.
//
// doctorRun() returns plain data (no functions, no Maps), so an AI agent or the MCP bridge can call it later.
// The pure half is src/lib/doctor.js; the panel is src/sidebar/DoctorPanel.jsx.

import manifest from '../../manifest.json';
import { queryTable, queryInChunks, runBackgroundScript } from './tableApi.js';
import { sessionHeaders, getSessionToken } from './sessionToken.js';
import { callPage } from './pageBridge.js';
import { findClassicFrame } from './controlPage.js';
import { getSettings } from './storage.js';
import { getInstanceInfo, getNodeInfo } from './quickActions.js';
import { listInstances } from './stores.js';
import { tierFromSession, DEFAULT_DEVELOPER_ROLES } from '../lib/roleTier.js';
import { extractScriptOutput } from '../lib/logTail.js';
import { ALL_REQUIREMENTS } from '../lib/requirements/index.js';
import * as doc from '../lib/doctor.js';

const REQUEST_TIMEOUT_MS = 12000;
const SCRIPT_TIMEOUT_MS = 20000;
const TOTAL_BUDGET_MS = 120000;
const PROBE_CONCURRENCY = 5;
const DICTIONARY_TABLE_CHUNK = 25;
const DICTIONARY_COLUMN_CHUNK = 100;
const MAX_HIERARCHY_LEVELS = 8;
const MAX_SAMPLED_COLUMNS = 40;
const SCRIPT_MARKER = doc.SCRIPT_PROBE_MARKER;
const IMPERSONATION_KEY = 'mysnowbuddy_impersonation_origin';

// Columns that are never requested in the one-row sample: they can be large (scripts, payloads, XML) or hold secrets
// (property values). They are still checked against the dictionary.
const HEAVY_COLUMN = /^(script|payload|payload_hash|xml|html|css|message|description|comments|work_notes|template|value|oldvalue|newvalue|old_value|new_value|body|text|inputs|output|response_body|request_body|operation_script|client_script|server_script|script_true|script_false|link|css_text|demo_data|option_schema|condition|filter_condition|conditions|catalog_conditions)$|_script$|_xml$|_html$|password|secret|token|credential/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// ---- the real dependencies (tests and the preview can swap any of them) -------------------------------------------

/** One GET against the instance with the session headers: timed, never throws, classified by doc.classifyHttp. */
async function realRequest(path, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const started = nowMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: await sessionHeaders(), signal: controller.signal });
    const body = await response.text().catch(() => '');
    const verdict = doc.classifyHttp({ status: response.status, redirected: response.redirected, url: response.url, loggedIn: response.headers?.get?.('x-is-logged-in') ?? null, contentType: response.headers?.get?.('content-type') || '', // The whole body: the application picker answers ~30 KB of JSON, and a cut-off body does not parse (found live: it was reported as "did not answer").
      body: body.slice(0, 1000000) });
    return { ...verdict, ms: Math.round(nowMs() - started), body: verdict.kind === 'ok' ? body : '' };
  } catch (err) {
    return { ...doc.classifyHttp({ failed: err }), ms: Math.round(nowMs() - started), body: '' };
  } finally {
    clearTimeout(timer);
  }
}

function frameFacts() {
  const facts = { pathname: globalThis.location?.pathname || '/', directFrame: false, foundFrame: false, frameReadable: null, isTop: true };
  try {
    facts.isTop = window === window.top;
    facts.directFrame = Boolean(document.getElementById('gsft_main'));
    const frame = findClassicFrame();
    facts.foundFrame = Boolean(frame);
    if (frame) {
      try {
        facts.frameReadable = Boolean(frame.contentDocument);
      } catch {
        facts.frameReadable = false;
      }
    }
  } catch {
    // Keep what was learned.
  }
  return facts;
}

async function realSession() {
  let session = await callPage('getSessionInfo', [], { timeoutMs: 3500 });
  // Some pages answer getSessionInfo without the role list; getUserInfo carries it.
  if (session && !Array.isArray(session.roles)) {
    const user = await callPage('getUserInfo', [], { timeoutMs: 3500 }).catch(() => null);
    if (user && Array.isArray(user.roles)) session = { ...session, roles: user.roles };
  }
  return session;
}

async function realImpersonation(userId) {
  try {
    const stored = await chrome.storage.local.get(IMPERSONATION_KEY);
    const entry = stored?.[IMPERSONATION_KEY]?.[globalThis.location?.hostname];
    if (entry && userId && entry.impersonated === userId) return { state: 'active', note: 'NowBuddy remembers who you were and can end it from the palette (End impersonation).' };
    return { state: 'none' };
  } catch {
    return { state: 'unknown' };
  }
}

async function realBuild() {
  const started = nowMs();
  try {
    const node = await getNodeInfo();
    if (node.build || node.version) return { info: { buildname: node.build, buildtag: node.version, builddate: node.buildDate }, source: 'stats.do', ms: Math.round(nowMs() - started) };
  } catch {
    // Not an admin, or the page differs on this release; try the properties.
  }
  try {
    const rows = await queryTable('sys_properties', 'nameINglide.buildname,glide.buildtag,glide.war,glide.builddate', ['name', 'value'], { limit: 10 });
    const p = Object.fromEntries(rows.map((r) => [r.name, r.value]));
    if (rows.length) return { info: { buildname: p['glide.buildname'], buildtag: p['glide.buildtag'] || p['glide.war'], builddate: p['glide.builddate'] }, source: 'sys_properties', ms: Math.round(nowMs() - started) };
    return { info: null, error: 'sys_properties had no build properties for your user.', ms: Math.round(nowMs() - started) };
  } catch (err) {
    return { info: null, error: doc.classifyThrown(err).message, ms: Math.round(nowMs() - started) };
  }
}

async function realScript() {
  const started = nowMs();
  try {
    const html = await Promise.race([
      runBackgroundScript(doc.SCRIPT_PROBE, await getSessionToken()),
      sleep(SCRIPT_TIMEOUT_MS).then(() => {
        throw new Error('The background script endpoint timed out.');
      }),
    ]);
    const ms = Math.round(nowMs() - started);
    return { kind: 'ok', status: 200, message: '', ms, printed: extractScriptOutput(html).includes(SCRIPT_MARKER) };
  } catch (err) {
    return { ...doc.classifyThrown(err), ms: Math.round(nowMs() - started) };
  }
}

function manifestVersion() {
  try {
    return chrome.runtime.getManifest().version || manifest.version || '';
  } catch {
    return manifest.version || '';
  }
}

export const realDeps = () => ({
  request: realRequest,
  query: queryTable,
  queryChunks: queryInChunks,
  session: realSession,
  token: async () => Boolean(await getSessionToken().catch(() => null)),
  settings: getSettings,
  pageFacts: frameFacts,
  impersonation: realImpersonation,
  instance: async () => {
    const info = getInstanceInfo();
    // The tag is the label from Options > Instances, else the environment guessed from the host name; a host name the
    // guess cannot place (localhost, a custom domain) has no tag, and a hostname fragment is not one.
    const known = await listInstances()
      .then((list) => list.find((i) => i.host.toLowerCase() === String(info.host).toLowerCase()))
      .catch(() => null);
    const label = known?.label || (info.env && info.env !== 'unknown' ? info.label : '');
    return { host: info.host, instance: info.instance, env: info.env, guarded: info.guarded, label: label ? String(label).toUpperCase().slice(0, 10) : '', tone: info.tone };
  },
  build: realBuild,
  script: realScript,
  version: manifestVersion,
  requirements: () => ALL_REQUIREMENTS,
  now: () => Date.now(),
});

// ---- helpers -----------------------------------------------------------------------------------------------------

/** Run `worker` over `items`, at most `limit` at a time. */
async function pool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      // eslint-disable-next-line no-await-in-loop -- each runner takes the next item only when it is free.
      await worker(item);
    }
  });
  await Promise.all(runners);
}

const chunked = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

const safeCall = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

// ---- the run -----------------------------------------------------------------------------------------------------

/**
 * @param {object} deps   see realDeps(); everything the run needs from the page and the instance
 */
export function createDoctor(deps) {
  /**
   * @param {{ onProgress?: (p: { label: string, done: number, total: number }) => void, isCancelled?: () => boolean, scriptProbe?: 'auto'|'always'|'never', requirements?: Array }} [options]
   * @returns {Promise<object>} the structured result (see assembleResult in src/lib/doctor.js)
   */
  async function run(options = {}) {
    const startedAt = deps.now();
    const deadline = startedAt + TOTAL_BUDGET_MS;
    const list = options.requirements || deps.requirements();
    const plan = doc.planTables(list);
    const total = 5 + plan.tables.length;
    let done = 0;
    const step = (label, add = 1) => {
      done += add;
      try {
        options.onProgress?.({ label, done: Math.min(done, total), total });
      } catch {
        // A broken progress listener never stops the run.
      }
    };
    let requests = 0;
    const cancelled = () => {
      try {
        return Boolean(options.isCancelled?.());
      } catch {
        return false;
      }
    };
    const get = async (path, opts) => {
      requests += 1;
      return deps.request(path, opts);
    };
    const notes = [];
    const checks = [];

    // --- This page -------------------------------------------------------------------------------------------
    step('Checking this page', 0);
    const pageFacts = deps.pageFacts();
    const settings = (await safeCall(() => deps.settings(), {})) || {};
    const bridgeStart = nowMs();
    let session = null;
    const bridge = { ok: false, ms: 0, error: '', hasUser: false };
    try {
      session = await deps.session();
      bridge.ok = true;
      bridge.hasUser = Boolean(session && (session.userName || session.userId));
    } catch (err) {
      bridge.error = err?.message || String(err);
    }
    bridge.ms = Math.round(nowMs() - bridgeStart);
    const tokenStart = nowMs();
    const tokenPresent = await safeCall(() => deps.token(), false);
    const token = { present: Boolean(tokenPresent), ms: Math.round(nowMs() - tokenStart) };
    const page = doc.classifyPage(pageFacts);
    const version = deps.version();
    const instanceFacts = (await safeCall(() => deps.instance(), {})) || {};
    checks.push(...doc.pageChecks({ version, host: instanceFacts.host || globalThis.location?.hostname || '', page: pageFacts, bridge, token, settings }));
    step('Checked this page');

    // --- You and the instance ----------------------------------------------------------------------------------
    const developerRoles = settings.developerRoles ? settings.developerRoles : DEFAULT_DEVELOPER_ROLES;
    const tiersOn = settings.roleTiersEnabled !== false;
    const tier = tiersOn ? tierFromSession(session, developerRoles) : null;
    const impersonation = (await safeCall(() => deps.impersonation(session?.userId), { state: 'unknown' })) || { state: 'unknown' };
    const build = (await safeCall(() => deps.build(), { info: null, error: 'Could not be read.' })) || { info: null };
    const looksProduction = instanceFacts.env === 'prod' || instanceFacts.tone === 'danger';
    checks.push(...doc.youChecks({ session, tier, tiersOn, impersonation, instance: instanceFacts, build }));
    step('Checked who you are');

    // --- API access --------------------------------------------------------------------------------------------
    const me = /^[0-9a-f]{32}$/i.test(session?.userId || '') ? session.userId : '';
    const meQuery = me ? `&sysparm_query=sys_id=${me}` : '';
    const api = {};
    const [table, stats, group, pickerUpdate, pickerApp] = await Promise.all([
      get(`/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id&sysparm_exclude_reference_link=true${meQuery}`),
      get(`/api/now/stats/sys_user?sysparm_count=true${meQuery}`),
      get('/api/now/stats/sys_user?sysparm_count=true&sysparm_group_by=active&sysparm_display_value=all'),
      get('/api/now/ui/concoursepicker/updateset'),
      get('/api/now/ui/concoursepicker/application'),
    ]);
    api.table = table;
    // A sys_user ACL is not the Table API: if only that table is refused, try one that everybody can read.
    if (table.kind === 'denied') {
      const other = await get('/api/now/table/sys_db_object?sysparm_limit=1&sysparm_fields=sys_id&sysparm_query=name=task');
      if (other.kind === 'ok') api.table = { ...other, note: 'sys_user is refused for your user, other tables are readable.' };
    }
    api.stats = { ...stats, countOk: stats.kind === 'ok' ? Number.isFinite(Number(safeJson(stats.body)?.result?.stats?.count)) : undefined };
    api.group = { ...group, groupsOk: group.kind === 'ok' ? Array.isArray(safeJson(group.body)?.result) && safeJson(group.body).result.every((g) => Array.isArray(g.groupby_fields)) : undefined };
    api.pickers = {
      update: { ...pickerUpdate, hasCurrent: pickerUpdate.kind === 'ok' ? Boolean(safeJson(pickerUpdate.body)?.result?.current) : undefined },
      app: { ...pickerApp, hasCurrent: pickerApp.kind === 'ok' ? Boolean(safeJson(pickerApp.body)?.result?.current) : undefined },
    };
    // The script probe adds a line to the instance's script history, so on its own it runs only on an instance that is
    // positively dev, test or stage. Production, and a host name NowBuddy cannot place (most production instances are
    // plain "acme.service-now.com"), skip it unless the person asks. The same fail-safe rule as every writer.
    const probeMode = options.scriptProbe || 'auto';
    const scriptSafe = instanceFacts.guarded === false && !looksProduction;
    if (api.table.kind !== 'ok') api.script = { kind: 'skipped', message: 'Not run because the Table API could not be read.' };
    else if (probeMode === 'never') api.script = { kind: 'skipped', message: 'Left out on request.' };
    else if (probeMode === 'auto' && !scriptSafe) {
      api.script = {
        kind: 'skipped',
        message: looksProduction
          ? 'Not run on purpose: this instance looks like production, and running a script adds an entry to its script history.'
          : 'Not run on purpose: NowBuddy cannot tell whether this instance is production, and running a script adds an entry to its script history.',
        action: 'Use "Run it anyway" to run the one-line check (it only prints a marker).',
        productionSkip: true,
      };
    } else {
      requests += 1;
      api.script = await deps.script();
    }
    const sessionExpired = api.table.kind === 'session';
    step('Tested the API');

    // --- Requirements: dictionary, then one read per table ----------------------------------------------------
    let schema = doc.makeSchema({ dbObject: 'unread', dictionary: 'unread' });
    let schemaMs = 0;
    const probes = {};
    if (!sessionExpired && api.table.kind === 'ok' && plan.tables.length) {
      const started = nowMs();
      schema = await readSchema(plan, deps, (n) => {
        requests += n;
      });
      schema.tablesLooked = plan.tables.length;
      schemaMs = Math.round(nowMs() - started);
      step('Read the dictionary');

      const queue = plan.tables.filter((t) => doc.tableExists(schema, t) !== 'no');
      plan.tables.filter((t) => doc.tableExists(schema, t) === 'no').forEach((t) => {
        probes[t] = { kind: 'missing', status: 400, message: 'Not in sys_db_object.', skipped: true };
      });
      // The dictionary already answered for the missing ones; count their steps so the bar still ends at 100%.
      if (plan.tables.length > queue.length) step('Skipped tables that do not exist', plan.tables.length - queue.length);
      let sessionLost = false;
      await pool(queue, PROBE_CONCURRENCY, async (name) => {
        // The panel was closed or another run started: stop sending requests nobody will look at.
        if (cancelled()) return;
        if (sessionLost || deps.now() > deadline) {
          probes[name] = { kind: sessionLost ? 'session' : 'timeout', status: 0, message: sessionLost ? 'Session ended.' : 'Out of time.' };
          step(`Read ${name}`);
          return;
        }
        probes[name] = await probeTable(name, plan.columns[name] || [], get);
        if (probes[name].kind === 'session') sessionLost = true;
        step(`Read ${name}`);
      });
      if (sessionLost) notes.push('The session ended during the run, so some tables were not read.');
    } else {
      step('Skipped the dictionary', 1 + plan.tables.length);
    }
    api.dictionary = schema.dbObject === 'unread' ? null : { dbObject: schema.dbObject, dictionary: schema.dictionary, truncated: schema.truncated, tables: plan.tables.length, ms: schemaMs };
    checks.push(...doc.apiChecks(api));

    if (!sessionExpired && api.table.kind !== 'ok') notes.push('The Table API could not be read, so no tool was checked against the instance.');
    if (sessionExpired) notes.push('Your session has ended, so no tool was checked against the instance.');
    const tools = doc.evaluateTools(list, { schema, probes, sessionExpired });
    if (doc.validateRequirements(list).length) notes.push(`${doc.validateRequirements(list).length} malformed requirement entries were ignored.`);
    if (!plan.tables.length) notes.push('No tool listed any requirements.');

    const parsedBuild = doc.parseBuild(build.info || {});
    const finishedAt = deps.now();
    step('Done', total - done);
    return doc.assembleResult({
      startedAt,
      finishedAt,
      extension: { version },
      instance: { host: instanceFacts.host, instance: instanceFacts.instance, label: instanceFacts.label, env: instanceFacts.env, looksProduction, release: parsedBuild.label, family: parsedBuild.family, buildTag: parsedBuild.tag },
      page: { kind: page.kind, label: page.label },
      user: { tier, roleCount: Array.isArray(session?.roles) ? session.roles.length : null, admin: session?.admin ?? null },
      checks,
      tools,
      schema,
      requests,
      notes,
      slowest: Object.entries(probes)
        .filter(([, p]) => Number.isFinite(p.ms))
        .map(([table, p]) => ({ table, ms: p.ms }))
        .sort((a, b) => b.ms - a.ms),
    });
  }

  return { run };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * sys_db_object for the wanted tables, then their parents level by level, then the wanted columns from sys_dictionary
 * for every table seen. A failure in either read is recorded in the schema (the evaluation then falls back to samples).
 */
export async function readSchema(plan, deps, countRequests = () => {}) {
  const parents = new Map();
  const columns = new Map();
  const state = { dbObject: 'ok', dictionary: 'ok', truncated: false };

  const asked = new Set();
  let pending = plan.tables;
  for (let level = 0; level < MAX_HIERARCHY_LEVELS && pending.length; level += 1) {
    pending.forEach((t) => asked.add(t));
    try {
      countRequests(Math.ceil(pending.length / 40));
      // eslint-disable-next-line no-await-in-loop -- each level depends on the previous one.
      const rows = await deps.queryChunks('sys_db_object', 'name', pending, ['name', 'super_class.name'], { chunkSize: 40, limit: 400 });
      doc.parseDbObjectRows(rows, parents);
    } catch (err) {
      state.dbObject = doc.classifyThrown(err).kind;
      state.dictionary = 'unread';
      return doc.makeSchema({ parents, columns, ...state });
    }
    pending = doc.unaskedParents(parents, asked);
  }

  const wanted = doc.wantedColumns(plan);
  if (!wanted.length || !parents.size) return doc.makeSchema({ parents, columns, ...state });
  const tableChunks = chunked([...parents.keys()].sort(), DICTIONARY_TABLE_CHUNK);
  const columnChunks = chunked(wanted, DICTIONARY_COLUMN_CHUNK);
  try {
    for (const tables of tableChunks) {
      for (const names of columnChunks) {
        countRequests(1);
        // eslint-disable-next-line no-await-in-loop -- a handful of sequential reads keeps the load on the instance low.
        const rows = await deps.query('sys_dictionary', `nameIN${tables.join(',')}^elementIN${names.join(',')}`, ['name', 'element'], { limit: 1000 });
        if (rows.length >= 1000) state.truncated = true;
        doc.parseDictionaryRows(rows, columns);
      }
    }
  } catch (err) {
    state.dictionary = doc.classifyThrown(err).kind;
  }
  return doc.makeSchema({ parents, columns, ...state });
}

/**
 * One row of a table (sys_id and the wanted light columns) to learn whether it can be read and which columns come back.
 * Only the names of the columns are kept; the row itself is dropped.
 */
export async function probeTable(table, columns, get) {
  const requested = ['sys_id', ...columns.filter((c) => !HEAVY_COLUMN.test(c)).slice(0, MAX_SAMPLED_COLUMNS - 1)];
  const path = `/api/now/table/${encodeURIComponent(table)}?sysparm_limit=1&sysparm_fields=${requested.join(',')}&sysparm_exclude_reference_link=true&sysparm_no_count=true&sysparm_suppress_pagination_header=true`;
  const res = await get(path);
  const probe = { kind: res.kind, status: res.status, message: res.message, ms: res.ms };
  if (res.kind === 'ok') {
    const row = safeJson(res.body)?.result?.[0];
    probe.sampleKeys = row && typeof row === 'object' ? Object.keys(row) : [];
    probe.requestedKeys = requested;
  }
  return probe;
}

// ---- service ------------------------------------------------------------------------------------------------------

/**
 * Run every check and return the structured result (plain data).
 * @param {{ onProgress?: Function, isCancelled?: () => boolean, scriptProbe?: 'auto'|'always'|'never' }} [options]
 */
export const doctorRun = (options = {}) => createDoctor(realDeps()).run(options);

export const doctorServices = {
  doctorRun: (options) => doctorRun(options || {}),
};

// Called once from src/content/featureStartup.js when the page loads (optional). Receives { shadow, toast, sidebar }.
export function install() {}
