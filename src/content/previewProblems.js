// Update set preview problems (/preview), the instance half. Everything here READS, through the user's own session:
//   sys_remote_update_set          the retrieved update sets and their state
//   sys_update_preview_problem     the problems; its column names are discovered from sys_dictionary, never assumed
//   sys_update_xml                 the remote updates behind the problems, the search of the other retrieved sets for the one
//                                  that creates a missing record, and the local updates of a colliding record
//   sys_update_version             the latest local version of a colliding record
// Nothing is written and the platform's own Accept / Skip buttons are never pressed: the panel only links to them.
// The pure half (classifying, explaining, verdict, order, report) is src/lib/previewProblems.js; the panel is
// src/sidebar/PreviewProblemsPanel.jsx; the assumptions to check live are in docs/features/previewfix.md.

import { queryTable, queryAll, queryInChunks, countByColumn } from './tableApi.js';
import { fetchTableFields } from './fieldInspector.js';
import {
  PROBLEM_TABLE,
  SET_TABLE,
  SYS_ID_RE,
  MISSING_ROLE_TEXT,
  mapProblemColumns,
  normalizeProblem,
  normalizeSet,
  isPending,
  isOpen,
  isSysId,
  prepareProblems,
  providerSearches,
  providerQuery,
  matchProviders,
  edgesFromProblems,
  commitOrder,
  payloadStamp,
  referencedIds,
  cellValue,
  buildAnalysis,
} from '../lib/previewProblems.js';

const CONCURRENCY = 3;
const MAX_REF_PAYLOADS = 30;
const MAX_PROBLEMS = 1500;
const MAX_PENDING_SETS = 60;
const MAX_COLLISIONS = 12;
const MAX_WALK_SETS = 6;
const MAX_ORDER_SETS = 12;
const TABLE_RE = /^[a-z][a-z0-9_]*$/;

// Columns confirmed live (2026-10-23); there is no "loaded" column.
const SET_FIELDS = ['sys_id', 'name', 'state', 'application', 'commit_date', 'parent', 'description', 'sys_created_on', 'sys_updated_on'];
const UPDATE_FIELDS = ['sys_id', 'name', 'target_name', 'type', 'action', 'sys_updated_on', 'sys_updated_by'];

const errorText = (err) => err?.message || String(err);

/** Run `task(item)` over `items`, `limit` at a time, keeping the order of the results. */
async function pool(items, limit, task, isCancelled = () => false) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !isCancelled()) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop -- each worker takes the next item only when it is free.
      out[i] = await task(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- schema ----------------------------------------------------------------------------------------------------------

const columnCache = new Map();
const COLUMN_CACHE_MS = 10 * 60 * 1000;

/** Dictionary columns of a table, remembered for a few minutes. Never throws: { fields, error }. */
async function tableColumns(table) {
  const hit = columnCache.get(table);
  if (hit && Date.now() - hit.at < COLUMN_CACHE_MS) return hit.value;
  let value;
  try {
    const info = await fetchTableFields(table);
    value = { fields: info.fields.map((f) => ({ name: f.name, label: f.label, type: f.type, reference: f.reference })), error: '' };
  } catch (err) {
    value = { fields: [], error: errorText(err) };
  }
  if (value.fields.length) columnCache.set(table, { at: Date.now(), value });
  return value;
}

/**
 * Which column of sys_update_preview_problem is which. When the dictionary cannot be read, one row is read with all of
 * its columns and the roles are guessed from their names.
 * @returns {Promise<{ map: ReturnType<typeof mapProblemColumns>, error: string }>}
 */
async function problemColumns() {
  const { fields, error } = await tableColumns(PROBLEM_TABLE);
  if (fields.length) return { map: mapProblemColumns(fields), error: '' };
  try {
    const rows = await queryTable(PROBLEM_TABLE, '', [], { limit: 1 });
    if (rows[0]) return { map: mapProblemColumns(Object.keys(rows[0]).map((name) => ({ name }))), error: '' };
    return { map: mapProblemColumns([]), error: error ? `The dictionary could not be read (${error}) and the problem table has no rows to learn its columns from.` : `No dictionary entries were found for ${PROBLEM_TABLE}, and the table has no rows to learn its columns from.` };
  } catch (err) {
    return { map: mapProblemColumns([]), error: `${PROBLEM_TABLE} could not be read: ${errorText(err)}` };
  }
}

// ---- the list of retrieved update sets ------------------------------------------------------------------------------

async function problemCounts(sets) {
  const { map, error } = await problemColumns();
  if (!map.ok) return { counts: null, note: error || MISSING_ROLE_TEXT.set };
  const ids = sets.map((s) => s.sysId).filter((id) => SYS_ID_RE.test(id));
  if (!ids.length) return { counts: {}, note: '' };
  try {
    const groups = await countByColumn(PROBLEM_TABLE, `${map.set}IN${ids.join(',')}`, map.set);
    const counts = Object.fromEntries(ids.map((id) => [id, 0]));
    groups.forEach((g) => {
      const id = g.groupby_fields?.[0]?.value;
      if (id in counts) counts[id] = Number(g.stats?.count) || 0;
    });
    return { counts, note: '' };
  } catch (err) {
    return { counts: null, note: `Problem counts could not be read: ${errorText(err)}` };
  }
}

/**
 * The retrieved update sets, newest first, with their state and how many preview problems each has.
 * `search` is a name fragment or a sys_id.
 * @returns {Promise<{ sets: object[], note: string }>}
 */
export async function previewProblemSets({ search = '', limit = 60 } = {}) {
  const text = String(search || '').trim();
  let query = 'ORDERBYDESCsys_updated_on';
  if (isSysId(text)) query = `sys_id=${text}`;
  else if (text) {
    if (/[\^]/.test(text)) throw new Error('Leave out the ^ character.');
    query = `nameLIKE${text}^ORDERBYDESCsys_updated_on`;
  }
  const rows = await queryTable(SET_TABLE, query, SET_FIELDS, { limit: Math.min(Math.max(limit, 1), 200), displayValue: true });
  const base = rows.map((row) => normalizeSet(row));
  const { counts, note } = await problemCounts(base);
  const sets = counts ? base.map((s) => ({ ...s, problemCount: counts[s.sysId] ?? 0 })) : base;
  return { sets, note };
}

/** The retrieved update set a problem record belongs to, or '' when it cannot be found. */
export async function previewProblemSetOfProblem(problemId) {
  if (!SYS_ID_RE.test(problemId || '')) return '';
  const { map } = await problemColumns();
  if (!map.ok) return '';
  const rows = await queryTable(PROBLEM_TABLE, `sys_id=${problemId}`, [map.set], { limit: 1 });
  return rows[0] ? cellValue(rows[0][map.set]) : '';
}

// ---- reading one set's problems -------------------------------------------------------------------------------------

/** The retrieved sets that could still provide something: not committed, newest first, plus the set itself. */
async function pendingSets(ownSet) {
  const rows = await queryTable(SET_TABLE, 'ORDERBYDESCsys_updated_on', SET_FIELDS, { limit: 200, displayValue: true });
  const others = rows.map((r) => normalizeSet(r)).filter((s) => s.sysId !== ownSet.sysId && isPending(s));
  return { sets: [ownSet, ...others.slice(0, MAX_PENDING_SETS)], more: others.length > MAX_PENDING_SETS };
}

/** Problems of one set as plain objects, with the remote updates they point at. */
async function readProblems(setId, map, notes) {
  const rows = await queryAll(PROBLEM_TABLE, `${map.set}=${setId}^ORDERBYsys_created_on`, map.columns, { max: MAX_PROBLEMS, pageSize: 500, displayValue: true });
  const normalized = rows.map((row) => normalizeProblem(row, map));
  const updates = {};
  const ids = [...new Set(normalized.map((p) => p.updateId).filter(Boolean))];
  if (ids.length) {
    try {
      const found = await queryInChunks('sys_update_xml', 'sys_id', ids, UPDATE_FIELDS, { chunkSize: 40, limit: 200 });
      found.forEach((u) => {
        updates[u.sys_id] = u;
      });
    } catch (err) {
      notes.push(`The remote updates behind the problems could not be read (${errorText(err)}), so the records they change are not shown.`);
    }
  }
  return { rows: normalized, updates, truncated: rows.length >= MAX_PROBLEMS };
}

// ---- finding which other set creates what is missing ----------------------------------------------------------------

/**
 * The platform's usual missing-reference text names the table and the column but not the sys_id ("Could not find a
 * record in sys_user_group for column assignment_group referenced in this update"). For those, the remote update is read
 * and the sys_id(s) in that column are taken from it, so the provider search can run. Only those values are kept; the
 * payload itself (which can hold script text) is dropped here. At most MAX_REF_PAYLOADS updates are read.
 * @returns {Promise<Record<string, string[]>>} problem sys_id -> sys_ids
 */
async function referencedValues(prepared, notes) {
  const wanted = prepared.filter((p) => isOpen(p.status) && p.kind === 'missing_reference' && !p.clues.sysIds.length && p.clues.refs?.length && SYS_ID_RE.test(p.update?.sysId || ''));
  if (!wanted.length) return {};
  const ids = [...new Set(wanted.map((p) => p.update.sysId))];
  const read = ids.slice(0, MAX_REF_PAYLOADS);
  const payloads = {};
  try {
    const rows = await queryInChunks('sys_update_xml', 'sys_id', read, ['sys_id', 'payload'], { chunkSize: 10, limit: 10 });
    rows.forEach((r) => {
      payloads[cellValue(r.sys_id)] = String(cellValue(r.payload));
    });
  } catch (err) {
    notes.push(`The remote updates could not be read to see which record each missing reference points at (${errorText(err)}), so those were not searched for.`);
    return {};
  }
  if (ids.length > read.length) notes.push(`Only the first ${read.length} of ${ids.length} remote updates were read to see which record a missing reference points at.`);
  const out = {};
  wanted.forEach((p) => {
    const payload = payloads[p.update.sysId];
    if (!payload) return;
    const found = [...new Set(p.clues.refs.flatMap((r) => referencedIds(payload, r.column)))];
    if (found.length) out[p.id] = found;
  });
  return out;
}

/**
 * Run the provider searches over the given retrieved sets. Each search is one small query; a search that fails is
 * reported against its key and the others carry on.
 */
async function searchProviders(searches, setIds, isCancelled) {
  const providerRows = {};
  const providerErrors = {};
  await pool(
    searches,
    CONCURRENCY,
    async (search) => {
      try {
        const rows = await queryTable('sys_update_xml', providerQuery(search, setIds, 'remote_update_set'), ['sys_id', 'name', 'target_name', 'type', 'remote_update_set'], { limit: search.mode === 'tbl' ? 25 : 10 });
        providerRows[search.key] = rows.map((r) => ({ sysId: cellValue(r.sys_id), name: r.name, target: r.target_name, type: r.type, setId: cellValue(r.remote_update_set) }));
      } catch (err) {
        providerErrors[search.key] = errorText(err);
      }
    },
    isCancelled
  );
  return { providerRows, providerErrors };
}

/** Is sys_update_xml.remote_update_set there? A condition on a missing column would silently match everything. */
async function remoteUpdateSetColumnExists() {
  const { fields } = await tableColumns('sys_update_xml');
  return fields.some((f) => f.name === 'remote_update_set');
}

/**
 * The retrieved sets that must be committed before `setId`, found from that set's open problems (no collision detail).
 * @returns {Promise<{ edges: Array<{from: string, to: string}>, providerIds: string[] }>}
 */
async function providersOfSet(setId, ctx) {
  const notes = [];
  const { rows, updates } = await readProblems(setId, ctx.map, notes);
  const refValues = await referencedValues(prepareProblems(rows, updates), notes);
  const prepared = prepareProblems(rows, updates, refValues).filter((p) => isOpen(p.status));
  const { searches } = providerSearches(prepared);
  if (!searches.length) return { edges: [], providerIds: [] };
  const { providerRows } = await searchProviders(searches, ctx.setIds, ctx.isCancelled);
  const setsById = ctx.setsById;
  prepared.forEach((p) => {
    p.providers = matchProviders(p, providerRows, setsById, setId);
  });
  const edges = edgesFromProblems(setId, prepared);
  return { edges, providerIds: [...new Set(edges.map((e) => e.from))] };
}

// ---- collisions ------------------------------------------------------------------------------------------------------

const localLabel = (cell) => (cell && typeof cell === 'object' ? cell.display_value || cell.value || '' : cell || '');
// Times are compared with the remote update's stored (UTC) stamp, so they must be the stored value too: a display value
// is in the viewer's time zone and date format.
const storedValue = (cell) => (cell && typeof cell === 'object' ? cell.value || '' : cell || '');

async function readCollision(problem, updateSetColumnOk) {
  const rec = problem.record;
  const out = { record: null, localUpdates: [], versions: [], remote: null };
  if (rec && TABLE_RE.test(rec.table) && SYS_ID_RE.test(rec.sysId)) {
    try {
      const rows = await queryTable(rec.table, `sys_id=${rec.sysId}`, ['sys_updated_on', 'sys_updated_by'], { limit: 1 });
      out.record = rows[0] ? { found: true, updatedOn: storedValue(rows[0].sys_updated_on), updatedBy: storedValue(rows[0].sys_updated_by) } : { found: false };
    } catch (err) {
      out.record = { error: errorText(err) };
    }
  }
  if (rec?.updateName && /^[a-z0-9_]+$/i.test(rec.updateName)) {
    if (updateSetColumnOk) {
      try {
        const rows = await queryTable('sys_update_xml', `name=${rec.updateName}^remote_update_setISEMPTY^ORDERBYDESCsys_updated_on`, ['sys_updated_on', 'sys_updated_by', 'update_set'], { limit: 3, displayValue: true });
        out.localUpdates = rows.map((r) => ({ updatedOn: storedValue(r.sys_updated_on), updatedBy: storedValue(r.sys_updated_by), setName: localLabel(r.update_set) }));
      } catch {
        // The local update entries are extra detail; the record and its versions still answer the question.
      }
    }
    try {
      const rows = await queryTable('sys_update_version', `name=${rec.updateName}^ORDERBYDESCsys_recorded_at`, ['sys_recorded_at', 'sys_created_by', 'source'], { limit: 3, displayValue: true });
      out.versions = rows.map((r) => ({ at: storedValue(r.sys_recorded_at), by: storedValue(r.sys_created_by), source: localLabel(r.source) }));
    } catch {
      // Versions are optional detail.
    }
  }
  if (SYS_ID_RE.test(problem.update?.sysId || '')) {
    try {
      const rows = await queryTable('sys_update_xml', `sys_id=${problem.update.sysId}`, ['payload'], { limit: 1 });
      // Only the author and time are kept; the payload itself (which can hold script text and secrets) is dropped here.
      out.remote = payloadStamp(rows[0]?.payload || '');
    } catch {
      out.remote = null;
    }
  }
  return out;
}

// ---- one set, in full ------------------------------------------------------------------------------------------------

/**
 * Read a retrieved update set's preview problems and explain them. Returns the finished analysis (see buildAnalysis).
 * @param {{ setId: string, isCancelled?: () => boolean, onProgress?: (p: {phase: string}) => void }} options
 */
export async function previewProblemLoad({ setId, isCancelled = () => false, onProgress } = {}) {
  if (!SYS_ID_RE.test(setId || '')) throw new Error('Pick a retrieved update set first.');
  const progress = (phase) => onProgress?.({ phase });
  const notes = [];

  progress('Reading the update set');
  const setRows = await queryTable(SET_TABLE, `sys_id=${setId}`, SET_FIELDS, { limit: 1, displayValue: true });
  if (!setRows[0]) throw new Error('That retrieved update set was not found. It may have been deleted, or your user cannot read it.');
  const set = normalizeSet(setRows[0]);

  progress('Finding the preview problem columns');
  const { map, error: mapError } = await problemColumns();
  if (!map.ok) {
    return buildAnalysis({ set, readError: mapError || MISSING_ROLE_TEXT.set, notes });
  }
  map.missing.forEach((role) => {
    if (MISSING_ROLE_TEXT[role]) notes.push(MISSING_ROLE_TEXT[role]);
  });

  progress('Reading the preview problems');
  let read;
  try {
    read = await readProblems(setId, map, notes);
  } catch (err) {
    return buildAnalysis({ set, map, readError: `The preview problems could not be read: ${errorText(err)}`, notes });
  }
  if (isCancelled()) return null;
  if (read.truncated) notes.push(`Only the first ${MAX_PROBLEMS} problems were read.`);

  progress('Reading what the missing references point at');
  const refValues = await referencedValues(prepareProblems(read.rows, read.updates), notes);
  if (isCancelled()) return null;
  const prepared = prepareProblems(read.rows, read.updates, refValues);
  const open = prepared.filter((p) => isOpen(p.status));

  // Which other retrieved sets could be the provider?
  progress('Looking for the update sets that create what is missing');
  let candidate = { sets: [set], more: false, listError: '' };
  try {
    candidate = { ...(await pendingSets(set)), listError: '' };
  } catch (err) {
    candidate.listError = errorText(err);
    notes.push(`The other retrieved update sets could not be listed (${candidate.listError}), so providers were not searched.`);
  }
  const setsById = Object.fromEntries(candidate.sets.map((s) => [s.sysId, { name: s.name, state: s.stateLabel }]));
  const setIds = candidate.sets.map((s) => s.sysId);
  const columnOk = await remoteUpdateSetColumnExists();
  let providerRows = {};
  let providerErrors = {};
  const { searches, skipped, capped, total } = providerSearches(open);
  const refuse = (list, why) => list.forEach((s) => (providerErrors[s.key] = why));
  if (searches.length && candidate.listError) {
    refuse([...searches, ...skipped], `the other retrieved update sets could not be listed (${candidate.listError}).`);
  } else if (searches.length && !columnOk) {
    notes.push('The providers of missing records were not searched: sys_update_xml has no readable remote_update_set column on this instance.');
    refuse([...searches, ...skipped], 'sys_update_xml.remote_update_set is not readable here.');
  } else if (searches.length) {
    ({ providerRows, providerErrors } = await searchProviders(searches, setIds, isCancelled));
    if (capped) {
      notes.push(`Only ${searches.length} of ${total} distinct references were searched for in the other update sets.`);
      refuse(skipped, `not searched: only the first ${searches.length} distinct references are searched.`);
    }
  }
  if (candidate.more) notes.push(`Only the ${MAX_PENDING_SETS} most recently updated other retrieved sets were searched.`);

  // Collisions: the local copy, its latest version, the remote update's own author and time.
  const collisionData = {};
  const collisions = open.filter((p) => p.kind === 'collision').slice(0, MAX_COLLISIONS);
  if (collisions.length) {
    progress('Comparing colliding records');
    await pool(
      collisions,
      CONCURRENCY,
      async (p) => {
        collisionData[p.update?.sysId || p.id] = await readCollision(p, columnOk);
      },
      isCancelled
    );
    if (open.filter((p) => p.kind === 'collision').length > MAX_COLLISIONS) notes.push(`The local copy was compared for the first ${MAX_COLLISIONS} collisions only.`);
  }
  if (isCancelled()) return null;

  // First pass: this set's own providers, then walk to the providers' providers for a commit order.
  const first = buildAnalysis({ set, map, rows: read.rows, updates: read.updates, refValues, candidateSets: candidate.sets, providerRows, providerErrors, collisionData, notes: [...notes], truncated: read.truncated });
  const extraEdges = [];
  const chainSets = {};
  const walked = new Set([setId]);
  let frontier = [...new Set(first.order.chain.filter((c) => c.setId !== setId).map((c) => c.setId))];
  if (frontier.length && columnOk) {
    progress('Working out the commit order');
    const ctx = { map, setIds, setsById, isCancelled };
    for (let depth = 0; depth < 2 && frontier.length && walked.size < MAX_WALK_SETS; depth += 1) {
      const next = [];
      // eslint-disable-next-line no-await-in-loop -- one level at a time keeps the number of queries predictable.
      const results = await pool(
        frontier.filter((id) => !walked.has(id)).slice(0, MAX_WALK_SETS - walked.size),
        CONCURRENCY,
        async (id) => {
          walked.add(id);
          try {
            return await providersOfSet(id, ctx);
          } catch {
            return { edges: [], providerIds: [] };
          }
        },
        isCancelled
      );
      results.filter(Boolean).forEach((r) => {
        extraEdges.push(...r.edges);
        next.push(...r.providerIds);
      });
      frontier = [...new Set(next)];
    }
    candidate.sets.forEach((s) => {
      chainSets[s.sysId] = { name: s.name, state: s.stateLabel };
    });
  }
  if (!extraEdges.length) return first;
  return buildAnalysis({ set, map, rows: read.rows, updates: read.updates, refValues, candidateSets: candidate.sets, providerRows, providerErrors, collisionData, extraEdges, chainSets, notes, truncated: read.truncated });
}

// ---- the order for every pending set --------------------------------------------------------------------------------

/**
 * A commit order for all retrieved sets that still have problems, from which set creates what another set is missing.
 * @returns {Promise<{ chain: object[], cycles: string[][], checked: number, skipped: number, note: string }>}
 */
export async function previewProblemOrder({ isCancelled = () => false, onProgress } = {}) {
  const { map, error } = await problemColumns();
  if (!map.ok) throw new Error(error || MISSING_ROLE_TEXT.set);
  if (!(await remoteUpdateSetColumnExists())) throw new Error('sys_update_xml has no readable remote_update_set column on this instance, so the update sets cannot be searched for providers.');
  const rows = await queryTable(SET_TABLE, 'ORDERBYDESCsys_updated_on', SET_FIELDS, { limit: 200, displayValue: true });
  const pending = rows.map((r) => normalizeSet(r)).filter(isPending).slice(0, MAX_PENDING_SETS);
  const { counts } = await problemCounts(pending);
  const withProblems = pending.filter((s) => (counts ? counts[s.sysId] > 0 : true)).slice(0, MAX_ORDER_SETS);
  const setIds = pending.map((s) => s.sysId);
  const setsById = Object.fromEntries(pending.map((s) => [s.sysId, { name: s.name, state: s.stateLabel }]));
  const ctx = { map, setIds, setsById, isCancelled };
  const edges = [];
  let done = 0;
  await pool(
    withProblems,
    CONCURRENCY,
    async (s) => {
      try {
        edges.push(...(await providersOfSet(s.sysId, ctx)).edges);
      } catch {
        // A set that cannot be read is simply left out of the order.
      }
      done += 1;
      onProgress?.({ done, total: withProblems.length });
    },
    isCancelled
  );
  const order = commitOrder(edges, setsById);
  const skipped = Math.max(0, (counts ? pending.filter((s) => counts[s.sysId] > 0).length : pending.length) - withProblems.length);
  return {
    chain: order.chain,
    cycles: order.cycles,
    checked: withProblems.length,
    skipped,
    note: skipped ? `Only ${withProblems.length} sets with problems were checked (${skipped} more were left out).` : '',
  };
}

export const previewProblemServices = {
  previewProblemSets: (options) => previewProblemSets(options),
  previewProblemSetOfProblem: (problemId) => previewProblemSetOfProblem(problemId),
  previewProblemLoad: (options) => previewProblemLoad(options),
  previewProblemOrder: (options) => previewProblemOrder(options),
};

// Called once from src/content/featureStartup.js when the page loads (optional). Receives { shadow, toast, sidebar }.
export function install() {}
