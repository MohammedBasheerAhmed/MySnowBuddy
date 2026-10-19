// "My work" and the update set ship check: everything they read from (and the
// few things they write to) the current instance. Pure rules live in
// src/lib/updateSetReview.js and src/lib/pushArtifact.js.
//
// Writes here: switching the session's update set / application (same calls as
// the palette), moving sys_update_xml entries between update sets (after an
// explicit confirmation in the panel; typed instance name on guarded
// instances). Every write is re-read afterwards and the result shown as the
// instance reports it.

import { queryTable, fetchRecord, countRecords, queryInChunks, updateRecord, createRecord } from './tableApi.js';
import { sessionHeaders, getSessionToken } from './sessionToken.js';
import { callPage } from './pageBridge.js';
import { setCurrentUpdateSet, setCurrentApplication, getInstanceInfo } from './quickActions.js';
import { fetchUpdateSetEntries, findCollisionsForEntries, findUncapturedChanges } from './updateSets.js';
import { normalizeHost, listInstances } from './stores.js';
import { createAudit, chromeStorageAdapter } from '../lib/agent/audit.js';
import { isGuardedEnv } from '../lib/agent/policy.js';
import {
  parsePickerCurrent,
  parsePickerApplications,
  parseGroupedStats,
  analyseEntryScripts,
  tableForEntry,
  SCRIPT_TABLES,
  buildShipChecklist,
  buildReleaseNotes,
  isDefaultSet,
  dictionaryUpdateNames,
  planMove,
  confirmMatches,
  validateNewUpdateSetName,
} from '../lib/updateSetReview.js';

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const safeValue = (v) => Boolean(v) && !/[\^\n\r,]/.test(String(v));
const refValue = (v) => (v && typeof v === 'object' ? v.value || '' : String(v ?? ''));

const SET_FIELDS = ['sys_id', 'name', 'state', 'application', 'application.name', 'is_default', 'description', 'sys_created_by', 'sys_updated_on'];
const CHANGE_FIELDS = [
  'sys_id',
  'name',
  'type',
  'target_name',
  'action',
  'application',
  'application.name',
  'update_set',
  'update_set.name',
  'update_set.state',
  'update_set.application',
  'update_set.is_default',
  'sys_updated_on',
  'sys_updated_by',
  'sys_created_by',
];

const ENTRY_LIMIT = 500;
const PAYLOAD_LIMIT = 60;
const MOVE_LIMIT = 25;

// ---- who and where ----------------------------------------------------------------------

let me = null;

/** The signed-in user ({ userName, userId }). */
export async function currentUser() {
  if (me) return me;
  let info = null;
  try {
    info = await callPage('getUserInfo');
  } catch {
    // Bridge unavailable (e.g. Next Experience without g_user); ask the instance.
  }
  if (info?.userName && safeValue(info.userName)) {
    me = { userName: info.userName, userId: SYS_ID_RE.test(info.userId || '') ? info.userId : null };
    return me;
  }
  // limit 2: if the condition were ignored we would get several users, never a wrong one.
  const rows = await queryTable('sys_user', 'sys_id=javascript:gs.getUserID()', ['sys_id', 'user_name'], { limit: 2 });
  if (rows.length !== 1 || !safeValue(rows[0].user_name)) throw new Error('Could not tell which user you are signed in as.');
  me = { userName: rows[0].user_name, userId: rows[0].sys_id };
  return me;
}

async function readPicker(kind) {
  try {
    const response = await fetch(`/api/now/ui/concoursepicker/${kind}`, { credentials: 'same-origin', headers: await sessionHeaders() });
    if (!response.ok) return null;
    return parsePickerCurrent(await response.json());
  } catch {
    return null;
  }
}

/** One of the user's own preferences, or null. Rows are re-checked by name. */
async function readPreference(name) {
  const user = await currentUser();
  const userCond = user.userId ? `user=${user.userId}` : 'user=javascript:gs.getUserID()';
  const rows = await queryTable('sys_user_preference', `${userCond}^name=${name}`, ['name', 'value'], { limit: 2 });
  const hits = rows.filter((r) => r.name === name);
  return hits.length === 1 ? hits[0].value : null;
}

function shapeSet(rec, fallback = {}) {
  const name = rec?.name || fallback.name || '';
  const flag = rec?.is_default;
  // 'true' | 'false' | null when the column is not readable on this release.
  const defaultFlag = flag === undefined || flag === null || flag === '' ? null : String(flag);
  return {
    sys_id: rec?.sys_id || fallback.sysId || '',
    sysId: rec?.sys_id || fallback.sysId || '',
    name: name || '(unknown)',
    state: rec?.state || '',
    application: refValue(rec?.application),
    applicationName: rec?.['application.name'] || '',
    // For display and warnings: the flag when readable, the name only when it is not.
    isDefault: isDefaultSet(defaultFlag, name),
    defaultFlag,
    description: rec?.description || '',
    createdBy: rec?.sys_created_by || '',
    updatedOn: rec?.sys_updated_on || '',
    source: fallback.source || '',
  };
}

/**
 * The session's current update set as the instance reports it: the picker API first,
 * then the user's "sys_update_set" preference.
 */
export async function readCurrentUpdateSet() {
  let current = await readPicker('updateset');
  let source = 'picker';
  if (!current) {
    const id = await readPreference('sys_update_set').catch(() => null);
    if (!SYS_ID_RE.test(id || '')) return null;
    current = { sysId: id, name: '' };
    source = 'preference';
  }
  if (current.sysId === 'global' || !SYS_ID_RE.test(current.sysId)) return { ...shapeSet(null, { ...current, source }) };
  const rec = await fetchRecord('sys_update_set', current.sysId, SET_FIELDS).catch(() => null);
  return shapeSet(rec, { ...current, source });
}

/** The session's current application: picker API first, then the "apps.current_app" preference. */
export async function readCurrentApplication() {
  const picked = await readPicker('application');
  if (picked) return { ...picked, source: 'picker' };
  // undefined = the preference could not be read; null = the user has none, which ServiceNow treats as Global.
  const id = await readPreference('apps.current_app').catch(() => undefined);
  if (id === 'global') return { sysId: 'global', name: 'Global', source: 'preference' };
  if (id === null) return { sysId: 'global', name: 'Global', scope: 'global', source: 'default' };
  if (!SYS_ID_RE.test(id || '')) return null;
  const scope = await fetchRecord('sys_scope', id, ['sys_id', 'name', 'scope']).catch(() => null);
  return { sysId: id, name: scope?.name || id, scope: scope?.scope || '', source: 'preference' };
}

/** First paint of My work: who, which update set, which application. Each part may fail alone. */
export async function myWorkContext() {
  const [user, updateSet, application] = await Promise.allSettled([currentUser(), readCurrentUpdateSet(), readCurrentApplication()]);
  const value = (r) => (r.status === 'fulfilled' ? r.value : null);
  const errors = [user, updateSet, application].filter((r) => r.status === 'rejected').map((r) => r.reason?.message || String(r.reason));
  return { user: value(user), updateSet: value(updateSet), application: value(application), instance: getInstanceInfo(), errors };
}

// ---- my update sets and changes -----------------------------------------------------------

/** Entry count and newest change per update set, in one Aggregate API call. */
async function entryStats(ids) {
  if (!ids.length) return new Map();
  const params = new URLSearchParams({
    sysparm_count: 'true',
    sysparm_group_by: 'update_set',
    sysparm_max_fields: 'sys_updated_on',
    sysparm_query: `update_setIN${ids.join(',')}`,
  });
  try {
    const response = await fetch(`/api/now/stats/sys_update_xml?${params.toString()}`, { credentials: 'same-origin', headers: await sessionHeaders() });
    if (response.ok) return parseGroupedStats(await response.json(), 'update_set');
  } catch {
    // Fall through to one count per set.
  }
  const map = new Map();
  for (const id of ids.slice(0, 15)) {
    try {
      // eslint-disable-next-line no-await-in-loop -- a short, capped fallback; sequential keeps load low.
      map.set(id, { count: await countRecords('sys_update_xml', `update_set=${id}`), max: {} });
    } catch {
      // Leave this set without a count.
    }
  }
  return map;
}

/** Update sets the user created that are still in progress, with entry counts. */
export async function fetchMyUpdateSets({ limit = 15 } = {}) {
  const user = await currentUser();
  const rows = (
    await queryTable('sys_update_set', `state=in progress^sys_created_by=${user.userName}^ORDERBYDESCsys_updated_on`, SET_FIELDS, {
      limit: Math.min(limit, 50),
    })
  ).filter((r) => r.state === 'in progress' && r.sys_created_by === user.userName);
  let stats = null;
  try {
    stats = await entryStats(rows.map((r) => r.sys_id));
  } catch {
    stats = null;
  }
  return rows.map((r) => {
    const s = stats ? stats.get(r.sys_id) : null;
    return { ...shapeSet(r), entries: stats ? s?.count ?? 0 : null, lastChange: s?.max?.sys_updated_on || '' };
  });
}

/** The user's customer updates, newest first. */
export async function fetchMyRecentChanges({ limit = 40 } = {}) {
  const user = await currentUser();
  const u = user.userName;
  const rows = await queryTable('sys_update_xml', `sys_updated_by=${u}^ORsys_created_by=${u}^ORDERBYDESCsys_updated_on`, CHANGE_FIELDS, {
    limit: Math.min(limit, 100),
  });
  return rows.filter((r) => r.sys_updated_by === u || r.sys_created_by === u);
}

let uncapturedCache = null;

/** The user's own changes of the last N days with no update set entry (cached for 2 minutes). */
export async function fetchMyUncaptured({ days = 7, refresh = false } = {}) {
  const user = await currentUser();
  if (!refresh && uncapturedCache && uncapturedCache.days === days && uncapturedCache.user === user.userName && Date.now() - uncapturedCache.at < 120000) {
    return uncapturedCache.value;
  }
  const value = await findUncapturedChanges({ days, limitPerTable: 50, updatedBy: user.userName });
  value.uncaptured = value.uncaptured.filter((u) => u.updatedBy === user.userName);
  uncapturedCache = { at: Date.now(), days, user: user.userName, value };
  return value;
}

// ---- switching -----------------------------------------------------------------------------

/** In-progress update sets and applications to switch to. */
export async function fetchSwitchTargets() {
  const [sets, picked] = await Promise.all([
    queryTable('sys_update_set', 'state=in progress^ORDERBYDESCsys_updated_on', SET_FIELDS, { limit: 60 }),
    readPickerApplications(),
  ]);
  // The platform's own picker is the source of truth (it includes plugin and store scopes); sys_app is the fallback.
  const apps = picked.length
    ? picked
    : [{ sys_id: 'global', name: 'Global', scope: 'global' }, ...(await queryTable('sys_app', 'active=true^ORDERBYname', ['sys_id', 'name', 'scope'], { limit: 60 }).catch(() => []))];
  return { sets: sets.filter((s) => s.state === 'in progress').map((s) => shapeSet(s)), apps };
}

async function readPickerApplications() {
  try {
    const response = await fetch('/api/now/ui/concoursepicker/application', { credentials: 'same-origin', headers: await sessionHeaders() });
    return response.ok ? parsePickerApplications(await response.json()) : [];
  } catch {
    return [];
  }
}

/** Switch the update set, then re-read what the instance now reports. */
export async function switchUpdateSet(sysId) {
  if (!SYS_ID_RE.test(sysId || '')) throw new Error('Pick an update set.');
  await setCurrentUpdateSet(sysId, await getSessionToken());
  const [updateSet, application] = await Promise.all([readCurrentUpdateSet().catch(() => null), readCurrentApplication().catch(() => null)]);
  return { requested: sysId, applied: updateSet?.sysId === sysId, updateSet, application };
}

/**
 * Create an in-progress update set in the current application and make it the current one. This is the fix for the
 * "your changes are going to Default" warning. Refuses a taken or Default name, asks for the typed instance name on
 * guarded instances, re-reads what the instance reports, and audits the creation with an undo (delete the set).
 */
export async function createAndSwitchUpdateSet({ name, confirmName } = {}) {
  const info = getInstanceInfo();
  if (isGuardedEnv(info.env) && !confirmMatches(confirmName, info.instance)) {
    throw new Error(`Type "${info.instance}" to confirm a change on this instance.`);
  }
  const existing = await queryTable('sys_update_set', 'state=in progress', ['name'], { limit: 200 });
  const checked = validateNewUpdateSetName(name, existing.map((r) => r.name));
  if (!checked.ok) throw new Error(checked.error);

  const application = await readCurrentApplication().catch(() => null);
  const fields = { name: checked.name, state: 'in progress', description: 'Created from MySnowBuddy.' };
  if (application?.sysId) fields.application = application.sysId;
  const created = await createRecord('sys_update_set', fields);
  const sysId = refValue(created?.sys_id);
  if (!SYS_ID_RE.test(sysId)) throw new Error('The instance did not return the new update set. Check the Update Sets list before trying again.');

  await createAudit(chromeStorageAdapter)
    .record({
      instance: info.host,
      tool: 'create_update_set',
      args: { name: checked.name, application: application?.sysId || '' },
      ok: true,
      summary: `Created update set "${checked.name}"`,
      source: 'mywork',
      undo: { kind: 'record', table: 'sys_update_set', sysId, created: true },
    })
    .catch(() => {});

  let switched;
  try {
    switched = await switchUpdateSet(sysId);
  } catch (err) {
    // The set exists now. Say so: a retry would otherwise look like it never worked and create a duplicate.
    const wrapped = new Error(`Created "${checked.name}", but switching to it failed (${err.message.replace(/\.$/, '')}). It is in your in-progress list: use Switch to pick it.`);
    wrapped.created = { sysId, name: checked.name };
    throw wrapped;
  }
  return { ...switched, created: { sysId, name: checked.name } };
}

/** Switch the application scope, then re-read what the instance now reports. */
export async function switchApplication(appId) {
  if (!(appId === 'global' || SYS_ID_RE.test(appId || ''))) throw new Error('Pick an application.');
  await setCurrentApplication(appId, await getSessionToken());
  const [updateSet, application] = await Promise.all([readCurrentUpdateSet().catch(() => null), readCurrentApplication().catch(() => null)]);
  return { requested: appId, applied: application?.sysId === appId, updateSet, application };
}

// ---- ship check ------------------------------------------------------------------------------

/** Update sets to pick from in the ship check: current first, then mine, then the rest. */
export async function fetchShipCheckSets() {
  const [rows, current, user] = await Promise.all([
    queryTable('sys_update_set', 'stateINin progress,complete^ORDERBYDESCsys_updated_on', SET_FIELDS, { limit: 80 }),
    readCurrentUpdateSet().catch(() => null),
    currentUser().catch(() => null),
  ]);
  const sets = rows.filter((r) => r.state === 'in progress' || r.state === 'complete').map((r) => shapeSet(r));
  if (current?.sysId && !sets.some((s) => s.sysId === current.sysId)) sets.unshift(current);
  const rank = (s) => (s.sysId === current?.sysId ? 0 : s.createdBy === user?.userName ? 1 : 2);
  sets.sort((a, b) => rank(a) - rank(b));
  return { sets, currentId: current?.sysId || '', userName: user?.userName || '' };
}

const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

async function analyseScripts(entries) {
  const candidates = entries.filter((e) => String(e.action).toUpperCase() !== 'DELETE' && SCRIPT_TABLES.has(tableForEntry(e)));
  const picked = candidates.slice(0, PAYLOAD_LIMIT);
  const rows = await queryInChunks('sys_update_xml', 'sys_id', picked.map((e) => e.sys_id), ['sys_id', 'payload'], { chunkSize: 10, limit: 10 });
  const payloadById = new Map(rows.map((r) => [r.sys_id, r.payload]));
  const scripts = [];
  for (let i = 0; i < picked.length; i += 1) {
    const xml = payloadById.get(picked[i].sys_id);
    if (xml) scripts.push(...analyseEntryScripts(picked[i], xml));
    // eslint-disable-next-line no-await-in-loop -- keep the sidebar responsive while analysing.
    if (i % 5 === 4) await yieldToUi();
  }
  return { scripts, skipped: candidates.length - picked.length, checked: picked.length };
}

/**
 * Best effort: Script Includes and custom tables the set's scripts use whose changes sit in
 * another in-progress update set. Dictionary update names ("sys_dictionary_<table>_...") are
 * an unverified convention.
 */
async function findDependencies(setId, entries, scripts) {
  const shippedIncludes = new Set(entries.filter((e) => tableForEntry(e) === 'sys_script_include').map((e) => String(e.target_name || '').trim()));
  const calls = new Map();
  const tables = new Map();
  const note = (map, key, from) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(from);
  };
  scripts.forEach((s) => {
    s.scriptIncludes.forEach((n) => !shippedIncludes.has(n) && note(calls, n, s.targetName));
    s.tables.forEach((t) => note(tables, t, s.targetName));
  });

  const out = [];
  const setsOf = (rows) => {
    const seen = new Map();
    rows.forEach((r) => seen.set(refValue(r.update_set), { name: r['update_set.name'] || refValue(r.update_set), state: r['update_set.state'] || '' }));
    return [...seen.values()];
  };
  const elsewhere = (r) => refValue(r.update_set) !== setId && r['update_set.state'] === 'in progress';

  const names = [...calls.keys()].filter((n) => /^[\w$]+$/.test(n)).slice(0, 25);
  if (names.length) {
    const includes = (await queryTable('sys_script_include', `nameIN${names.join(',')}`, ['sys_id', 'name'], { limit: 100 })).filter((r) => calls.has(r.name));
    if (includes.length) {
      const updateNames = includes.map((r) => `sys_script_include_${r.sys_id}`);
      const pending = (
        await queryTable(
          'sys_update_xml',
          `nameIN${updateNames.join(',')}^update_set!=${setId}^update_set.state=in progress^ORDERBYDESCsys_updated_on`,
          ['name', 'update_set', 'update_set.name', 'update_set.state'],
          { limit: 200 }
        )
      ).filter(elsewhere);
      includes.forEach((si) => {
        const rows = pending.filter((p) => p.name === `sys_script_include_${si.sys_id}`);
        if (rows.length) out.push({ kind: 'script_include', name: si.name, calledFrom: [...calls.get(si.name)], otherSets: setsOf(rows) });
      });
    }
  }

  const tableNames = [...tables.keys()].filter((t) => /^[a-z0-9_]+$/.test(t)).slice(0, 10);
  if (tableNames.length) {
    const cond = tableNames.map((t) => `nameSTARTSWITHsys_dictionary_${t}_`).join('^OR');
    const [pendingRows, columns] = await Promise.all([
      queryTable('sys_update_xml', `${cond}^update_set!=${setId}^update_set.state=in progress`, ['name', 'update_set', 'update_set.name', 'update_set.state'], {
        limit: 200,
      }),
      queryTable('sys_dictionary', `nameIN${tableNames.join(',')}`, ['name', 'element'], { limit: 1000 }),
    ]);
    const pending = pendingRows.filter(elsewhere);
    tableNames.forEach((t) => {
      // A prefix also matches longer table names (u_x matches u_x_y), so each row is checked against
      // the exact names of this table's own columns.
      const exact = dictionaryUpdateNames(t, columns.filter((c) => c.name === t).map((c) => c.element));
      const rows = pending.filter((p) => exact.has(String(p.name)));
      if (rows.length) out.push({ kind: 'table', name: t, calledFrom: [...tables.get(t)], otherSets: setsOf(rows) });
    });
  }
  return out;
}

/** Everything the ship check shows for one update set. */
export async function loadShipCheck(setId) {
  if (!SYS_ID_RE.test(setId || '')) throw new Error('Pick an update set.');
  const errors = [];
  const rec = await fetchRecord('sys_update_set', setId, SET_FIELDS);
  if (!rec || rec.sys_id !== setId) throw new Error('That update set was not found.');
  const set = shapeSet(rec);

  const [entries, total] = await Promise.all([
    fetchUpdateSetEntries(setId, { limit: ENTRY_LIMIT }),
    countRecords('sys_update_xml', `update_set=${setId}`).catch((err) => {
      errors.push({ step: 'Count entries', message: err.message });
      return null;
    }),
  ]);

  const [collisionResult, scriptResult] = await Promise.all([
    entries.length
      ? findCollisionsForEntries(setId, entries).catch((err) => {
          errors.push({ step: 'Collision check', message: err.message });
          return null;
        })
      : null,
    analyseScripts(entries).catch((err) => {
      errors.push({ step: 'Script analysis', message: err.message });
      return { scripts: [], skipped: 0, checked: 0 };
    }),
  ]);

  const dependencies = await findDependencies(setId, entries, scriptResult.scripts).catch((err) => {
    errors.push({ step: 'Dependency check', message: err.message });
    return [];
  });

  const checklist = buildShipChecklist({
    set,
    entries,
    totalEntries: total,
    entryLimit: ENTRY_LIMIT,
    collisions: collisionResult?.collisions || [],
    // The reason text when there is one, so the check can say what was left out.
    collisionsTruncated: collisionResult?.truncated ? collisionResult.truncatedReason || true : false,
    scripts: scriptResult.scripts,
    scriptsSkipped: scriptResult.skipped,
    scriptRecordsChecked: scriptResult.checked ?? null,
    dependencies,
    errors,
  });

  return {
    set,
    entries,
    total: total ?? entries.length,
    checklist,
    scripts: scriptResult.scripts,
    releaseNotes: buildReleaseNotes({ set, entries, total }),
    host: window.location.hostname,
  };
}

// ---- moving entries between update sets ----------------------------------------------------------

async function readMove({ entryIds, targetSetId }) {
  const ids = [...new Set((entryIds || []).filter((id) => SYS_ID_RE.test(id)))];
  if (!ids.length) throw new Error('Pick at least one entry.');
  if (ids.length > MOVE_LIMIT) throw new Error(`Move at most ${MOVE_LIMIT} entries at a time.`);
  if (!SYS_ID_RE.test(targetSetId || '')) throw new Error('Pick an update set to move to.');
  const [target, entries] = await Promise.all([
    fetchRecord('sys_update_set', targetSetId, SET_FIELDS),
    queryInChunks('sys_update_xml', 'sys_id', ids, CHANGE_FIELDS, { chunkSize: 25, limit: 25 }),
  ]);
  if (!target || target.sys_id !== targetSetId) throw new Error('That update set was not found.');
  const found = entries.filter((e) => ids.includes(e.sys_id));
  if (found.length !== ids.length) throw new Error('Some entries no longer exist. Refresh and try again.');
  // Versions of the same records the target set already holds (moving one in would leave two).
  const names = [...new Set(found.map((e) => e.name).filter((n) => n && !/[,^\n]/.test(n)))];
  const existing = names.length
    ? (await queryTable('sys_update_xml', `update_set=${targetSetId}^nameIN${names.join(',')}`, ['name', 'update_set'], { limit: 100 })).filter(
        (r) => refValue(r.update_set) === targetSetId
      )
    : [];
  const targetNames = existing.map((r) => r.name);
  return { target, entries: found, plan: planMove({ entries: found, target, targetNames }) };
}

/** What a move would do, read fresh from the instance. Nothing is written. */
export async function previewMove(args) {
  const { target, entries, plan } = await readMove(args);
  const info = getInstanceInfo();
  return { target: shapeSet(target), entries, plan, guarded: isGuardedEnv(info.env), instance: info.instance, env: info.env };
}

/**
 * Move entries into another update set by changing sys_update_xml.update_set. Re-plans from
 * fresh reads, refuses if anything is blocked, then writes one entry at a time and re-reads it.
 * Stops at the first failure. Each move is audited with an undo (it restores update_set).
 */
export async function moveUpdateEntries({ entryIds, targetSetId, confirmName }) {
  const { target, plan } = await readMove({ entryIds, targetSetId });
  if (plan.blocked.length) throw new Error(`Nothing was moved: ${plan.blocked[0].reason}`);
  if (!plan.moves.length) throw new Error('Nothing to move: every entry is already in that update set.');
  const info = getInstanceInfo();
  if (isGuardedEnv(info.env) && !confirmMatches(confirmName, info.instance)) {
    throw new Error(`Type "${info.instance}" to confirm a change on this instance.`);
  }

  const audit = createAudit(chromeStorageAdapter);
  const results = [];
  for (const entry of plan.moves) {
    const label = entry.target_name || entry.name;
    const from = { id: refValue(entry.update_set), name: entry['update_set.name'] || refValue(entry.update_set) };
    try {
      // eslint-disable-next-line no-await-in-loop -- one at a time, each verified before the next.
      await updateRecord('sys_update_xml', entry.sys_id, { update_set: target.sys_id });
      // eslint-disable-next-line no-await-in-loop
      const after = await fetchRecord('sys_update_xml', entry.sys_id, ['sys_id', 'update_set', 'update_set.name']);
      const ok = refValue(after?.update_set) === target.sys_id;
      results.push({ sysId: entry.sys_id, label, ok, from: from.name, nowIn: after?.['update_set.name'] || refValue(after?.update_set) || '?' });
      // eslint-disable-next-line no-await-in-loop
      await audit
        .record({
          instance: info.host,
          tool: 'move_update_entry',
          args: { entry: entry.sys_id, name: entry.name, from: from.id, to: target.sys_id },
          ok,
          summary: `Moved "${label}" from update set "${from.name}" to "${target.name}"`,
          source: 'mywork',
          undo: ok ? { kind: 'record', table: 'sys_update_xml', sysId: entry.sys_id, previous: { update_set: from.id } } : null,
        })
        .catch(() => {});
      if (!ok) break;
    } catch (err) {
      results.push({ sysId: entry.sys_id, label, ok: false, from: from.name, error: err.message });
      break;
    }
  }
  return { target: shapeSet(target), results, skipped: plan.skipped.length, notAttempted: plan.moves.length - results.length };
}

// ---- push to another instance ---------------------------------------------------------------------

/** Preview a push of the open record: read it here, the target in the service worker. */
export async function pushPreviewFromPage({ host, table, sysId }) {
  const targetHost = normalizeHost(host);
  if (targetHost === window.location.hostname.toLowerCase()) throw new Error('That is this instance. Pick another one.');
  if (!/^[a-z0-9_]+$/i.test(table || '') || !SYS_ID_RE.test(sysId || '')) throw new Error('Open a saved record first.');
  const [local] = await queryTable(table, `sys_id=${sysId}`, [], { limit: 1 });
  if (!local || local.sys_id !== sysId) throw new Error('The record on this instance could not be read.');
  const response = await chrome.runtime.sendMessage({ type: 'PUSH_PREVIEW', payload: { targetUrl: targetHost, table, sourceRecord: local } });
  if (!response?.ok) throw new Error(response?.error || 'Could not reach the other instance.');
  return response;
}

export const myWorkServices = {
  myWorkContext: () => myWorkContext(),
  myWorkSets: (options) => fetchMyUpdateSets(options),
  myWorkChanges: (options) => fetchMyRecentChanges(options),
  myWorkUncaptured: (options) => fetchMyUncaptured(options),
  myWorkSwitchTargets: () => fetchSwitchTargets(),
  myWorkSwitchUpdateSet: (sysId) => switchUpdateSet(sysId),
  myWorkCreateUpdateSet: (args) => createAndSwitchUpdateSet(args),
  myWorkSwitchApplication: (appId) => switchApplication(appId),
  myWorkInstance: () => getInstanceInfo(),
  myWorkKnownInstances: () => listInstances(),
  shipCheckSets: () => fetchShipCheckSets(),
  shipCheckLoad: (setId) => loadShipCheck(setId),
  moveEntriesPreview: (args) => previewMove(args),
  moveEntries: (args) => moveUpdateEntries(args),
  pushPreviewFromPage: (args) => pushPreviewFromPage(args),
};
