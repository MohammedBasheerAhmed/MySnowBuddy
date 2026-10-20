// Record and list snapshots for the Test panel: take one, do something (run a script, change the state, trigger a flow),
// then compare. Pure: shaping rows, hashing, diffing and capping the saved list. Reading the record and storing the
// snapshot is src/content/testKit.js.

const SYS_ID_RE = /^[0-9a-f]{32}$/i;

export const SNAPSHOT_LIMITS = {
  perInstance: 20,
  fieldChars: 2000, // one field value in a record snapshot
  listRows: 500,
  listFields: 25,
  listFieldChars: 80,
  listValuesBelow: 200, // above this many rows only the hashes are kept
  name: 60,
};

// Maintained by the platform on every save: shown, but after the fields a person changed.
export const SYSTEM_FIELDS = new Set(['sys_updated_on', 'sys_updated_by', 'sys_mod_count']);

const text = (cell) => {
  if (cell == null) return '';
  if (typeof cell === 'object') return String('display_value' in cell && cell.display_value !== '' ? cell.display_value : cell.value ?? '');
  return String(cell);
};
const rawOf = (cell) => (cell && typeof cell === 'object' ? String(cell.value ?? '') : String(cell ?? ''));
const clip = (value, max) => (String(value).length > max ? `${String(value).slice(0, max - 1)}…` : String(value));

/** { field: { v: stored value, d: display value } } from a Table API row read with sysparm_display_value=all. */
export function recordFields(row) {
  const out = {};
  Object.entries(row || {}).forEach(([field, cell]) => {
    const v = clip(rawOf(cell), SNAPSHOT_LIMITS.fieldChars);
    const d = clip(text(cell), SNAPSHOT_LIMITS.fieldChars);
    out[field] = d === v ? { v } : { v, d };
  });
  return out;
}

export function makeRecordSnapshot({ host, table, sysId, name, row, label = '', now = Date.now() }) {
  if (!SYS_ID_RE.test(sysId || '')) throw new Error('A record snapshot needs the record sys_id.');
  const fields = recordFields(row);
  return {
    id: `s-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: 'record',
    host: String(host || ''),
    table,
    sysId,
    name: clip(String(name || '').trim() || `Snapshot ${new Date(now).toISOString().slice(11, 19)}`, SNAPSHOT_LIMITS.name),
    label: clip(label, 80),
    at: now,
    fields,
  };
}

/**
 * What differs between two record snapshots (or a snapshot and the record now).
 * @returns {{ changes: Array<{ field, before, after, system: boolean }>, same: number, added: string[], removed: string[] }}
 *   before/after are display strings; `added` and `removed` are fields present on only one side.
 */
export function diffRecordSnapshots(before, after) {
  const a = before?.fields || {};
  const b = after?.fields || {};
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const changes = [];
  const added = [];
  const removed = [];
  let same = 0;
  names.forEach((field) => {
    if (!(field in a)) return added.push(field);
    if (!(field in b)) return removed.push(field);
    if (a[field].v === b[field].v) {
      same += 1;
      return;
    }
    changes.push({ field, before: a[field].d ?? a[field].v, after: b[field].d ?? b[field].v, system: SYSTEM_FIELDS.has(field) });
  });
  changes.sort((x, y) => Number(x.system) - Number(y.system) || x.field.localeCompare(y.field));
  return { changes, same, added, removed };
}

export function diffToMarkdown(diff, { table = '', beforeName = 'before', afterName = 'now' } = {}) {
  if (!diff.changes.length) return `No field differs between "${beforeName}" and ${afterName}${table ? ` on ${table}` : ''}.`;
  const lines = [`Fields that changed on ${table || 'the record'} (${beforeName} -> ${afterName})`, '', '| Field | Before | After |', '| --- | --- | --- |'];
  const cell = (v) => String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>') || '(empty)';
  diff.changes.forEach((c) => lines.push(`| ${c.field}${c.system ? ' (system)' : ''} | ${cell(c.before)} | ${cell(c.after)} |`));
  return lines.join('\n');
}

// --- Lists ------------------------------------------------------------------------------------------------------

/** FNV-1a over the sorted field=value pairs: the same row content always gives the same short string. */
export function rowHash(values) {
  const keys = Object.keys(values || {}).sort();
  let h = 0x811c9dc5;
  keys.forEach((k) => {
    const s = `${k}=${values[k]}\u0001`;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  });
  return h.toString(16).padStart(8, '0');
}

/**
 * The snapshot of a list: each row by sys_id with a hash of its values (and, for lists under listValuesBelow rows, the
 * values themselves, so the comparison can say WHICH fields changed).
 * @param {Array<object>} rows Table API rows read with display values and a `sys_id`
 */
export function makeListSnapshot({ host, table, query = '', name, rows, labelField = '', now = Date.now() }) {
  const kept = (rows || []).slice(0, SNAPSHOT_LIMITS.listRows);
  const withValues = kept.length <= SNAPSHOT_LIMITS.listValuesBelow;
  const entries = kept
    .map((row) => {
      const sysId = rawOf(row.sys_id);
      if (!SYS_ID_RE.test(sysId)) return null;
      const values = {};
      Object.keys(row)
        .filter((f) => f !== 'sys_id')
        .slice(0, SNAPSHOT_LIMITS.listFields)
        .forEach((f) => {
          values[f] = clip(rawOf(row[f]), SNAPSHOT_LIMITS.listFieldChars);
        });
      return { id: sysId, label: clip(text(row[labelField]) || text(row.number) || text(row.name) || sysId.slice(0, 8), 60), hash: rowHash(values), ...(withValues ? { values } : {}) };
    })
    .filter(Boolean);
  return {
    id: `s-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: 'list',
    host: String(host || ''),
    table,
    query,
    name: clip(String(name || '').trim() || `List ${new Date(now).toISOString().slice(11, 19)}`, SNAPSHOT_LIMITS.name),
    at: now,
    capped: (rows || []).length > kept.length,
    rows: entries,
  };
}

/** @returns {{ added: Array<{id,label}>, removed: Array<{id,label}>, changed: Array<{id,label,fields: string[]}>, same: number }} */
export function diffListSnapshots(before, after) {
  const was = new Map((before?.rows || []).map((r) => [r.id, r]));
  const now = new Map((after?.rows || []).map((r) => [r.id, r]));
  const added = [];
  const removed = [];
  const changed = [];
  let same = 0;
  now.forEach((row, id) => {
    const old = was.get(id);
    if (!old) return added.push({ id, label: row.label });
    if (old.hash === row.hash) {
      same += 1;
      return;
    }
    const fields = old.values && row.values ? [...new Set([...Object.keys(old.values), ...Object.keys(row.values)])].filter((f) => old.values[f] !== row.values[f]).sort() : [];
    changed.push({ id, label: row.label, fields });
  });
  was.forEach((row, id) => {
    if (!now.has(id)) removed.push({ id, label: row.label });
  });
  return { added, removed, changed, same };
}

// --- Keeping them -------------------------------------------------------------------------------------------------

/** Newest first; at most `perInstance` for this host (other hosts' snapshots are left alone). */
export function addSnapshot(list, snapshot, max = SNAPSHOT_LIMITS.perInstance) {
  const others = (list || []).filter((s) => s.host !== snapshot.host);
  const mine = (list || []).filter((s) => s.host === snapshot.host);
  return [snapshot, ...mine].slice(0, max).concat(others);
}

export const removeSnapshot = (list, id) => (list || []).filter((s) => s.id !== id);

/** The snapshots that fit what is on screen: a record's own, or a list of the same table. */
export function snapshotsFor(list, { host, table, sysId = '' }) {
  return (list || []).filter((s) => s.host === host && s.table === table && (sysId ? s.kind === 'record' && s.sysId === sysId : s.kind === 'list')).sort((x, y) => y.at - x.at);
}
