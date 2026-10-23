// Data model map - the instance half. Reads sys_db_object (tables and their parents) and sys_dictionary (columns) with the
// user's own session, in batches, and keeps what it read in a small cache for the life of the page so the map, the path
// finder and the dot-walk explorer share it. Read-only. The pure half is src/lib/dataModel.js.
//
// Services (all names start with dataModel):
//   dataModelLoad({ table })                  the map of one table
//   dataModelLinkTables({ table, chain, incoming })   link ("many to many") tables, when the map left them out
//   dataModelFindPaths({ from, to, maxDepth, extra })  dot-walk paths between two tables
//   dataModelFields({ table })                every field of a table, inherited ones marked (for the explorer)
//   dataModelFieldTree(table, depth)          the field tree to `depth` levels - for other features, e.g. script autocomplete
//   dataModelResolvePath(table, 'caller_id.manager')  the table a dot-walked name leads to, or why it cannot be walked
//   dataModelFindTables(term)                 type-ahead on table names and labels
//   dataModelReset()                          forget what was read

import { queryTable, queryAll, queryInChunks, countRecords } from './tableApi.js';
import { searchTables } from './tableCatalog.js';
import {
  createSchema,
  addTableRows,
  markTableMissing,
  addFieldRows,
  chainOf,
  fieldsOf,
  fieldsLoaded,
  cleanName,
  incomingEntries,
  detectLinkTables,
  startPathSearch,
  pathNeeds,
  advancePathSearch,
  finishPathSearch,
  fieldTree,
  walkTo,
  PATH_LIMITS,
  REF_TYPES_QUERY,
  isSystemTable,
} from '../lib/dataModel.js';

const flat = (v) => (v && typeof v === 'object' ? v.value ?? v.display_value ?? '' : v == null ? '' : String(v));
const errorText = (err) => err?.message || String(err);

const TABLE_FIELDS = ['name', 'label', 'super_class.name', 'sys_scope.scope', 'sys_scope.name', 'is_extendable'];
const DICT_FIELDS = ['name', 'element', 'column_label', 'internal_type', 'reference', 'dependent', 'display', 'max_length'];
const FIELD_CHUNK = 30;
const DICT_ROW_CAP = 5000;
const INCOMING_CAP = 4000;
const AUTO_LINK_TABLES = 60;

let schema = createSchema();
const labelCache = new Map();
const stats = { canary: null };

// --- Plumbing -----------------------------------------------------------------------------------------------------

const cancelled = () => Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
const check = (isCancelled) => {
  if (isCancelled?.()) throw cancelled();
};

/** Run a service; a cancelled search answers { cancelled: true } instead of throwing. */
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.code === 'CANCELLED') return { cancelled: true };
    throw err;
  }
}

// Loads run one at a time, so two panels (or a map and a path search) never read the same tables twice.
let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/** Forget everything read so far (the Refresh button). */
export function dataModelReset() {
  schema = createSchema();
  labelCache.clear();
  stats.canary = null;
  return { ok: true };
}

function requireName(value, what) {
  const name = cleanName(value);
  if (!name) throw new Error(`Enter ${what} as a table name, for example incident.`);
  return name;
}

// --- Reading the schema -------------------------------------------------------------------------------------------

/** The tables and every parent above them (one query per level for the whole batch, never one per table). */
async function loadHierarchy(names, { isCancelled } = {}) {
  let pending = [...new Set(names.map(cleanName).filter(Boolean))].filter((n) => !schema.tables.has(n));
  for (let round = 0; round < 12 && pending.length; round += 1) {
    check(isCancelled);
    // eslint-disable-next-line no-await-in-loop -- each level of parents depends on the previous one.
    const rows = await queryInChunks('sys_db_object', 'name', pending, TABLE_FIELDS, { chunkSize: 40, limit: 200 });
    addTableRows(schema, rows);
    pending.forEach((n) => markTableMissing(schema, n));
    pending = [...new Set([...schema.tables.values()].map((t) => t.parent).filter((p) => p && !schema.tables.has(p)))];
  }
}

/**
 * The dictionary rows of the tables and their parents: reference columns only, or every column when `full`.
 * Returns how many tables were newly read.
 */
async function loadFields(names, { full = false, isCancelled, limit = Infinity } = {}) {
  await loadHierarchy(names, { isCancelled });
  const need = new Set();
  names.map(cleanName).filter(Boolean).forEach((n) => chainOf(schema, n).forEach((t) => {
    if (!schema.fields.has(t) || (full && !schema.full.has(t))) need.add(t);
  }));
  const list = [...need].filter((t) => !schema.tables.get(t)?.missing).sort().slice(0, limit);
  [...need].filter((t) => schema.tables.get(t)?.missing).forEach((t) => schema.fields.set(t, []));
  // A chunk that fills the row cap was cut off part way (rows come ordered by table), so the tables at the end would be
  // stored as having no columns. Such a chunk is read again in halves instead of being stored.
  async function readChunk(chunk) {
    check(isCancelled);
    const query = `nameIN${chunk.join(',')}^elementISNOTEMPTY^active=true${full ? '' : `^${REF_TYPES_QUERY}`}^ORDERBYname^ORDERBYelement`;
    const rows = await queryAll('sys_dictionary', query, DICT_FIELDS, { max: DICT_ROW_CAP, pageSize: 500 });
    if (rows.length >= DICT_ROW_CAP && chunk.length > 1) {
      const half = Math.ceil(chunk.length / 2);
      await readChunk(chunk.slice(0, half));
      await readChunk(chunk.slice(half));
      return;
    }
    addFieldRows(schema, chunk, rows, { full });
  }
  for (let i = 0; i < list.length; i += FIELD_CHUNK) {
    // eslint-disable-next-line no-await-in-loop -- chunks stay sequential so the instance is never hit with a burst.
    await readChunk(list.slice(i, i + FIELD_CHUNK));
  }
  return list.length;
}

const load = (names, options) => exclusive(() => loadFields(names, options));

/** Can this user read sys_dictionary at all? One cheap read of a column every instance has. */
async function dictionaryReadable() {
  if (stats.canary !== null) return stats.canary;
  try {
    const rows = await queryTable('sys_dictionary', 'name=sys_user^elementISNOTEMPTY', ['sys_id'], { limit: 1 });
    stats.canary = rows.length > 0;
  } catch {
    stats.canary = false;
  }
  return stats.canary;
}

/** Labels for tables the schema has not read (incoming referrers, targets). Fail-soft. */
async function loadLabels(names, isCancelled) {
  const wanted = [...new Set(names.map(cleanName).filter(Boolean))].filter((n) => !labelCache.has(n) && !schema.tables.get(n)?.label);
  if (!wanted.length) return;
  try {
    check(isCancelled);
    const rows = await queryInChunks('sys_db_object', 'name', wanted.slice(0, 250), ['name', 'label'], { chunkSize: 50, limit: 100 });
    rows.forEach((r) => labelCache.set(cleanName(flat(r.name)), flat(r.label)));
  } catch (err) {
    if (err?.code === 'CANCELLED') throw err;
    // Labels are decoration; the table names still show.
  }
}

const labelFor = (name) => schema.tables.get(name)?.label || labelCache.get(name) || '';
const labelsFor = (names) => Object.fromEntries([...new Set(names)].map((n) => [n, labelFor(n) || n]));

/** Direct children (first 60), how many tables extend this one all the way down (up to six levels, 800 tables). */
async function readDescendants(table, isCancelled) {
  let frontier = [table];
  let total = 0;
  let children = [];
  let direct = 0;
  let more = false;
  for (let depth = 1; depth <= 6 && frontier.length; depth += 1) {
    check(isCancelled);
    // eslint-disable-next-line no-await-in-loop -- one query per level of the tree.
    const rows = await queryInChunks('sys_db_object', 'super_class.name', frontier, ['name', 'label'], { chunkSize: 40, limit: 1000 });
    const named = rows.map((r) => ({ name: cleanName(flat(r.name)), label: flat(r.label) })).filter((r) => r.name);
    if (depth === 1) {
      direct = named.length;
      children = [...named].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, 60);
    }
    total += named.length;
    if (total > 800) {
      more = true;
      break;
    }
    frontier = named.map((r) => r.name);
    if (depth === 6 && frontier.length) more = true;
  }
  return { children, direct, total, more };
}

// --- The map of one table -----------------------------------------------------------------------------------------

/**
 * Everything the map needs for one table: facts, the extends chain, children, outgoing and incoming references.
 * Anything that could not be read is named in `notes`; the panel shows those lines.
 */
export function dataModelLoad({ table, isCancelled, onProgress } = {}) {
  return guarded(async () => {
    const name = requireName(table, 'a table');
    const notes = [];
    const say = (text) => onProgress?.({ text });

    say('Reading the table and its parents');
    await load([name], { isCancelled });
    const self = schema.tables.get(name);
    if (!self || self.missing) throw new Error(`No table called "${name}" was found, or your role cannot read sys_db_object.`);
    const chain = chainOf(schema, name);

    say('Reading references, child tables and the row count');
    const [kids, rows, incomingRows] = await Promise.all([
      readDescendants(name, isCancelled).catch((err) => {
        if (err?.code === 'CANCELLED') throw err;
        notes.push(`Could not read the child tables: ${errorText(err)}`);
        return { children: [], direct: 0, total: 0, more: false };
      }),
      countRecords(name).catch(() => null),
      queryAll('sys_dictionary', `referenceIN${chain.join(',')}^internal_type=reference^ORinternal_type=glide_list^elementISNOTEMPTY^active=true^ORDERBYname^ORDERBYelement`, DICT_FIELDS, { max: INCOMING_CAP, pageSize: 500 }).catch((err) => {
        if (err?.code === 'CANCELLED') throw err;
        notes.push(`Could not read which fields point at this table: ${errorText(err)}`);
        return null;
      }),
    ]);
    check(isCancelled);
    if (rows === null) notes.push('The row count could not be read.');

    const outgoing = fieldsOf(schema, name).filter((f) => f.kind);
    const incoming = incomingRows ? incomingEntries(incomingRows, chain) : [];
    const incomingTruncated = Boolean(incomingRows && incomingRows.length >= INCOMING_CAP);
    if (incomingTruncated) notes.push(`Only the first ${INCOMING_CAP} fields that point at this table were read.`);

    if ((!outgoing.length || !incoming.length) && !(await dictionaryReadable())) {
      notes.push('Your user cannot read sys_dictionary, so references cannot be listed. The map needs the admin role (or read access to sys_dictionary).');
    }

    say('Reading table labels');
    const incomingTables = [...new Set(incoming.map((e) => e.table))];
    await loadLabels([...chain, ...kids.children.map((c) => c.name), ...outgoing.map((f) => f.target), ...incomingTables.filter((t) => !isSystemTable(t)).slice(0, 150), ...incomingTables.filter(isSystemTable).slice(0, 100)], isCancelled);
    kids.children.forEach((c) => c.label && labelCache.set(c.name, c.label));

    // Link tables are cheap when few tables refer here; for a heavily used table (sys_user) the panel offers a button.
    let linkTables = null;
    if (incomingTables.length <= AUTO_LINK_TABLES) {
      say('Looking for link tables');
      linkTables = await readLinkTables({ chain, incoming, isCancelled }).catch((err) => {
        if (err?.code === 'CANCELLED') throw err;
        notes.push(`Could not look for link tables: ${errorText(err)}`);
        return [];
      });
    }

    const labels = labelsFor([...chain, ...kids.children.map((c) => c.name), ...outgoing.map((f) => f.target).filter(Boolean), ...incomingTables, ...(linkTables || []).flatMap((l) => [l.table, ...l.others.map((o) => o.target)])]);
    return {
      table: name,
      label: self.label,
      scope: self.scope,
      scopeName: self.scopeName,
      extendable: self.extendable,
      rowCount: rows,
      chain,
      labels,
      children: kids.children,
      childCount: kids.direct,
      descendantCount: kids.total,
      descendantsMore: kids.more,
      outgoing,
      incoming,
      incomingTruncated,
      linkTables,
      notes,
    };
  });
}

/** Own reference columns of each referring table, and the sys_m2m names when readable, -> the tables that join this one to others. */
async function readLinkTables({ chain, incoming, isCancelled }) {
  const tables = [...new Set(incoming.map((e) => cleanName(e.table)).filter(Boolean))];
  const refsByTable = new Map();
  tables.forEach((t) => refsByTable.set(t, []));
  // A chunk that fills the row cap was cut part way: its last tables would look like they hold fewer references than they
  // do (and pass the "two to four" rule wrongly), so it is read again in halves.
  async function readChunk(chunk) {
    check(isCancelled);
    const rows = await queryAll('sys_dictionary', `nameIN${chunk.join(',')}^internal_type=reference^elementISNOTEMPTY^active=true^ORDERBYname^ORDERBYelement`, DICT_FIELDS, { max: DICT_ROW_CAP, pageSize: 500 });
    if (rows.length >= DICT_ROW_CAP && chunk.length > 1) {
      const half = Math.ceil(chunk.length / 2);
      await readChunk(chunk.slice(0, half));
      await readChunk(chunk.slice(half));
      return;
    }
    rows.forEach((row) => {
      const t = cleanName(flat(row.name));
      if (!refsByTable.has(t)) return;
      refsByTable.get(t).push({ table: t, name: cleanName(flat(row.element)), kind: 'reference', target: cleanName(flat(row.reference)) });
    });
  }
  for (let i = 0; i < tables.length; i += FIELD_CHUNK) {
    // eslint-disable-next-line no-await-in-loop -- chunks stay sequential.
    await readChunk(tables.slice(i, i + FIELD_CHUNK));
  }
  // sys_m2m confirms a link table when it is readable. Column names differ between releases, so any value that equals a table name counts.
  const defined = new Set();
  try {
    const m2m = await queryTable('sys_m2m', '', [], { limit: 1000 });
    const wanted = new Set(tables);
    m2m.forEach((row) => Object.values(row).forEach((v) => wanted.has(flat(v)) && defined.add(flat(v))));
  } catch {
    // Not readable on this instance: the two-reference-fields rule alone decides.
  }
  const found = detectLinkTables({ chain, incoming, refsByTable, defined });
  await loadLabels(found.flatMap((l) => [l.table, ...l.others.map((o) => o.target)]), isCancelled);
  return found;
}

/** The link tables of a table whose map left them out (it has many referring tables). */
export function dataModelLinkTables({ chain, incoming, isCancelled, onProgress } = {}) {
  return guarded(async () => {
    const safeChain = (chain || []).map(cleanName).filter(Boolean);
    if (!safeChain.length) throw new Error('Open the map of a table first.');
    onProgress?.({ text: 'Reading the reference fields of the tables that point here' });
    const found = await readLinkTables({ chain: safeChain, incoming: (incoming || []).filter((e) => cleanName(e.table)), isCancelled });
    return { linkTables: found, labels: labelsFor(found.flatMap((l) => [l.table, ...l.others.map((o) => o.target)])) };
  });
}

// --- The path finder ----------------------------------------------------------------------------------------------

async function search({ from, to, maxDepth, extra, isCancelled, onProgress, budget }) {
  const state = startPathSearch(from, to, { maxDepth, extra });
  let used = 0;
  let limited = false;
  while (!state.done) {
    check(isCancelled);
    const need = pathNeeds(state);
    onProgress?.({ step: state.depth + 1, steps: state.maxDepth, tables: schema.fields.size, text: `Step ${state.depth + 1} of up to ${state.maxDepth}: ${need.hierarchy.length} table${need.hierarchy.length === 1 ? '' : 's'} to check, ${schema.fields.size} read so far` });
    // eslint-disable-next-line no-await-in-loop -- each step needs the previous one's tables.
    await exclusive(() => loadHierarchy(need.hierarchy, { isCancelled }));
    const fresh = need.fields.filter((t) => !fieldsLoaded(schema, t));
    if (fresh.length) {
      const room = Math.max(0, budget - used);
      if (fresh.length > room) limited = true;
      // eslint-disable-next-line no-await-in-loop
      used += await load(fresh.slice(0, room), { isCancelled });
    }
    advancePathSearch(state, schema);
  }
  const result = finishPathSearch(state, schema);
  result.limited = limited;
  return result;
}

/**
 * Dot-walk paths from table `from` to table `to`: the shortest ones, plus `extra` steps longer. Tables are read a
 * level at a time, in batches, and at most PATH_LIMITS.maxTables of them. When nothing is found, the other direction
 * is tried too (the references usually point one way only).
 */
export function dataModelFindPaths({ from, to, maxDepth = PATH_LIMITS.maxDepth, extra = 0, isCancelled, onProgress } = {}) {
  return guarded(async () => {
    const a = requireName(from, 'the first table');
    const b = requireName(to, 'the second table');
    onProgress?.({ text: 'Reading the two tables' });
    await load([a, b], { isCancelled });
    [a, b].forEach((t) => {
      if (schema.tables.get(t)?.missing) throw new Error(`No table called "${t}" was found, or your role cannot read sys_db_object.`);
    });
    const budget = PATH_LIMITS.maxTables;
    const forward = await search({ from: a, to: b, maxDepth, extra, isCancelled, onProgress, budget });
    const notes = [];
    if (!forward.paths.length && !(await dictionaryReadable())) notes.push('Your user cannot read sys_dictionary, so no references could be followed. The path finder needs the admin role (or read access to sys_dictionary).');
    let reverse = null;
    // How far the other direction was searched (0 = not tried), and whether that search was complete, so the panel
    // never says "in either direction" about a search that did not run or was cut short.
    let reverseDepth = 0;
    let reverseIncomplete = false;
    if (!forward.paths.length && !forward.same && !forward.inherits && !notes.length) {
      onProgress?.({ text: `Nothing from ${a} to ${b}; trying ${b} to ${a}` });
      reverseDepth = Math.min(maxDepth, 3);
      reverse = await search({ from: b, to: a, maxDepth: reverseDepth, extra: 0, isCancelled, onProgress, budget });
      reverseIncomplete = Boolean(reverse.limited || reverse.truncated || reverse.unexpanded.length);
      if (!reverse.paths.length) reverse = null;
    }
    const names = [a, b, ...forward.paths.flatMap((p) => p.tables), ...(reverse?.paths || []).flatMap((p) => p.tables)];
    await loadLabels(names, isCancelled);
    return { ...forward, reverse, reverseDepth, reverseIncomplete, notes, labels: labelsFor(names) };
  });
}

// --- Fields, the field tree, resolving a dot-walked name ------------------------------------------------------------

/** Every field of a table (own and inherited) with its label, type and the table that defines it. */
export function dataModelFields({ table, isCancelled } = {}) {
  return guarded(async () => {
    const name = requireName(table, 'a table');
    await load([name], { full: true, isCancelled });
    if (schema.tables.get(name)?.missing) throw new Error(`No table called "${name}" was found, or your role cannot read sys_db_object.`);
    return { table: name, label: labelFor(name) || name, chain: chainOf(schema, name), fields: fieldsOf(schema, name) };
  });
}

/**
 * The fields of `table` as a tree, reference fields carrying the target table's fields down to `depth` levels
 * (1 = just this table). Meant for other features (script editor autocomplete: current.caller_id. -> sys_user's fields).
 * Reads at most PATH_LIMITS.maxTables tables; `truncated` says when that cut the tree short.
 */
export async function dataModelFieldTree(table, depth = 1) {
  const name = requireName(table, 'a table');
  const levels = Math.max(1, Math.min(4, Math.floor(depth) || 1));
  let budget = PATH_LIMITS.maxTables;
  let frontier = [name];
  let limited = false;
  for (let level = 1; level <= levels && frontier.length; level += 1) {
    const fresh = frontier.filter((t) => !fieldsLoaded(schema, t, { full: true }));
    if (fresh.length > budget) limited = true;
    // eslint-disable-next-line no-await-in-loop -- one level at a time.
    budget -= await load(fresh.slice(0, Math.max(0, budget)), { full: true });
    if (level === levels) break;
    frontier = [...new Set(frontier.flatMap((t) => fieldsOf(schema, t).filter((f) => f.kind === 'reference' && f.target).map((f) => f.target)))].sort();
  }
  const tree = fieldTree(schema, name, levels);
  return { ...tree, truncated: tree.truncated || limited };
}

/** Where a dot-walked name leads: { ok, table, trail } or { ok: false, error }. 'caller_id.manager' from incident -> sys_user. */
export async function dataModelResolvePath(table, path) {
  const name = requireName(table, 'a table');
  const parts = String(path || '').split('.').filter(Boolean);
  let here = name;
  for (let i = 0; i <= parts.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- each hop's table is only known after the previous one.
    await load([here]);
    if (i === parts.length) break;
    const f = fieldsOf(schema, here).find((x) => x.name === parts[i]);
    if (!f || f.kind !== 'reference' || !f.target) break;
    here = f.target;
  }
  return walkTo(schema, name, parts.join('.'));
}

/** Type-ahead on table names and labels: the curated list at once, sys_db_object for the rest. */
export async function dataModelFindTables(term) {
  try {
    return (await searchTables(String(term || ''), 12)).map((t) => ({ name: t.name, label: t.label || t.name }));
  } catch {
    return [];
  }
}

export const dataModelServices = {
  dataModelLoad: (options) => dataModelLoad(options),
  dataModelLinkTables: (options) => dataModelLinkTables(options),
  dataModelFindPaths: (options) => dataModelFindPaths(options),
  dataModelFields: (options) => dataModelFields(options),
  dataModelFieldTree: (table, depth) => dataModelFieldTree(table, depth),
  dataModelResolvePath: (table, path) => dataModelResolvePath(table, path),
  dataModelFindTables: (term) => dataModelFindTables(term),
  dataModelReset: () => dataModelReset(),
};

// Called once from src/content/featureStartup.js when the page loads (optional). Receives { shadow, toast, sidebar }.
export function install() {}
