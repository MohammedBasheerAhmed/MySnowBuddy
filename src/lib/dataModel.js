// Data model map - the pure half. No DOM, no network. The instance half is src/content/dataModel.js, the panel is
// src/sidebar/DataModelPanel.jsx.
//
//   - a small in-memory "schema" (tables, their parents, the dictionary rows of each table) and what can be asked of it:
//     the extends chain, a table's fields with the inherited ones, its outgoing and incoming references,
//   - the map of one table (grouped incoming / outgoing, system tables hidden on request) and the SVG layout for it,
//   - the dot-walk path finder, written as a stepper (the caller loads what the next step needs, then advances), so a
//     search can read the dictionary lazily in batches and still be tested without any network,
//   - the copy snippets (dot-walk string, GlideRecord line, Table API fragment, encoded query), the field tree and
//     the link ("many to many") table finder.
//
// Schema shape (plain Maps so a table called "constructor" cannot collide with Object.prototype):
//   { tables: Map(name -> { name, label, parent, scope, scopeName, extendable, missing? }),
//     fields: Map(definingTable -> field[]), full: Set(definingTable whose every column was read, not only references) }
//   field = { table (defined on), name, label, type, kind, target, dependent, display }
//   kind  = 'reference' (walkable) | 'list' (glide_list: not walkable) | 'generic' (document_id: not walkable) | ''

export const NAME_RE = /^[a-z0-9_]+$/;

const flat = (v) => (v && typeof v === 'object' ? v.value ?? v.display_value ?? '' : v == null ? '' : String(v));

/** A table or column name as the instance spells it (lower case), or '' when it is not a plain name. */
export function cleanName(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return NAME_RE.test(s) ? s : '';
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// --- Which tables are "system" ----------------------------------------------------------------------------------

const SYSTEM_TABLE = /^(sys_|syslog|sysevent|sysauto)/;

/** Platform tables (sys_*, syslog, sysevent, sysauto*). The map can hide these from the incoming list. */
export function isSystemTable(name) {
  return SYSTEM_TABLE.test(String(name || ''));
}

// --- Field kinds ------------------------------------------------------------------------------------------------

/** 'reference' | 'list' | 'generic' | '' for a dictionary internal_type. */
export function refKind(internalType) {
  const t = String(internalType || '').toLowerCase();
  if (t === 'reference') return 'reference';
  if (t === 'glide_list') return 'list';
  if (t === 'document_id') return 'generic';
  return '';
}

export const KIND_TEXT = {
  reference: 'reference',
  list: 'list of references',
  generic: 'any table (document id)',
};

/** The dictionary query part that selects reference-like columns. */
export const REF_TYPES_QUERY = 'internal_type=reference^ORinternal_type=glide_list^ORinternal_type=document_id';

// --- The schema -------------------------------------------------------------------------------------------------

export function createSchema() {
  return { tables: new Map(), fields: new Map(), full: new Set() };
}

/** sys_db_object rows -> schema tables. */
export function addTableRows(schema, rows = []) {
  rows.forEach((row) => {
    const name = cleanName(flat(row.name));
    if (!name) return;
    schema.tables.set(name, {
      name,
      label: flat(row.label) || name,
      parent: cleanName(flat(row['super_class.name'] ?? row.parent)),
      scope: flat(row['sys_scope.scope'] ?? row.scope),
      scopeName: flat(row['sys_scope.name'] ?? row.scopeName),
      extendable: flat(row.is_extendable ?? row.extendable) === 'true' || row.extendable === true,
    });
  });
}

/** A table the instance did not return (unknown, or this user cannot read sys_db_object for it). */
export function markTableMissing(schema, name) {
  const n = cleanName(name);
  if (n && !schema.tables.has(n)) schema.tables.set(n, { name: n, label: n, parent: '', scope: '', scopeName: '', extendable: false, missing: true });
}

/** One sys_dictionary row -> a field, or null for a collection row / unusable name. */
export function dictionaryField(row) {
  const table = cleanName(flat(row.name));
  const name = cleanName(flat(row.element));
  if (!table || !name) return null;
  const type = flat(row.internal_type).toLowerCase();
  const kind = refKind(type);
  return {
    table,
    name,
    label: flat(row.column_label) || name,
    type,
    kind,
    target: kind === 'generic' ? '' : cleanName(flat(row.reference)),
    dependent: cleanName(flat(row.dependent)),
    display: flat(row.display) === 'true',
    maxLength: flat(row.max_length),
  };
}

/**
 * Store dictionary rows. Every table in `queried` gets an entry (an empty one when it has no matching rows), so the
 * caller can tell "read, none" from "not read yet". `full` = the rows are every column, not only the references.
 */
export function addFieldRows(schema, queried, rows = [], { full = false } = {}) {
  const byTable = new Map(queried.map((t) => [cleanName(t), []]));
  rows.forEach((row) => {
    const field = dictionaryField(row);
    if (field && byTable.has(field.table)) byTable.get(field.table).push(field);
  });
  byTable.forEach((list, table) => {
    if (!table) return;
    schema.fields.set(table, list.sort((a, b) => byText(a.name, b.name)));
    if (full) schema.full.add(table);
    else schema.full.delete(table);
  });
}

/** [name, parent, grandparent ...], stopping at a cycle or after 12 levels. */
export function chainOf(schema, name) {
  const out = [];
  let t = cleanName(name);
  while (t && !out.includes(t) && out.length < 12) {
    out.push(t);
    t = schema.tables.get(t)?.parent || '';
  }
  return out;
}

/** Is the whole extends chain of the table read (every parent up to a root, or a cycle)? */
function hierarchyKnown(schema, name) {
  const chain = chainOf(schema, name);
  if (!chain.length || !schema.tables.has(chain[chain.length - 1])) return false;
  const top = schema.tables.get(chain[chain.length - 1]);
  return !top.parent || chain.includes(top.parent);
}

/** True when `table` is `ancestor` or extends it. */
export function isA(schema, table, ancestor) {
  const a = cleanName(ancestor);
  return Boolean(a) && chainOf(schema, table).includes(a);
}

export function labelOf(schema, name) {
  return schema.tables.get(cleanName(name))?.label || name;
}

/** Have the dictionary rows of the table and all its parents been read (every column when `full`)? */
export function fieldsLoaded(schema, table, { full = false } = {}) {
  return chainOf(schema, table).every((t) => schema.fields.has(t) && (!full || schema.full.has(t)));
}

/**
 * Every field of a table, own and inherited, sorted by name. A field redefined on a child wins over the parent's.
 * Each field gets definedOn (the table that holds the dictionary entry) and inherited (definedOn is not this table).
 */
export function fieldsOf(schema, table) {
  const t = cleanName(table);
  const merged = new Map();
  [...chainOf(schema, t)].reverse().forEach((owner) => {
    (schema.fields.get(owner) || []).forEach((f) => merged.set(f.name, { ...f, definedOn: owner, inherited: owner !== t }));
  });
  return [...merged.values()].sort((a, b) => byText(a.name, b.name));
}

/** Reference, list and generic fields of a table, inherited ones included. */
export function refFieldsOf(schema, table) {
  return fieldsOf(schema, table).filter((f) => f.kind);
}

// --- The map of one table ---------------------------------------------------------------------------------------

/**
 * Dictionary rows whose reference points at the table or one of its parents -> incoming entries, sorted by table then field.
 * `chain` is [table, parent, ...]; viaParent says the field points at a parent table (it can hold this table's records too).
 */
export function incomingEntries(rows = [], chain = []) {
  const wanted = new Set(chain.map(cleanName));
  const seen = new Set();
  const out = [];
  rows.forEach((row) => {
    const f = dictionaryField(row);
    if (!f || (f.kind !== 'reference' && f.kind !== 'list') || !wanted.has(f.target)) return;
    const key = `${f.table}.${f.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ table: f.table, name: f.name, label: f.label, kind: f.kind, target: f.target, viaParent: f.target !== cleanName(chain[0]) });
  });
  return out.sort((a, b) => byText(a.table, b.table) || byText(a.name, b.name));
}

/**
 * Incoming entries grouped by the table that holds the field. System tables (sys_*) can be hidden; `query` filters by
 * table, label or field text. Returns the groups plus how much was hidden, so the panel can say so.
 */
export function groupIncoming(entries = [], { hideSystem = false, query = '', labels = {} } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const groups = new Map();
  let hiddenGroups = 0;
  let hiddenFields = 0;
  const hiddenTables = new Set();
  entries.forEach((e) => {
    if (hideSystem && isSystemTable(e.table)) {
      hiddenFields += 1;
      hiddenTables.add(e.table);
      return;
    }
    if (q && !`${e.table} ${labels[e.table] || ''} ${e.name} ${e.label}`.toLowerCase().includes(q)) return;
    if (!groups.has(e.table)) groups.set(e.table, { table: e.table, label: labels[e.table] || '', fields: [], system: isSystemTable(e.table), viaParent: false });
    const g = groups.get(e.table);
    g.fields.push({ name: e.name, label: e.label, kind: e.kind, target: e.target, viaParent: e.viaParent });
    if (e.viaParent) g.viaParent = true;
  });
  hiddenGroups = hiddenTables.size;
  const list = [...groups.values()].map((g) => ({ ...g, count: g.fields.length }));
  list.sort((a, b) => byText(a.table, b.table));
  return { groups: list, hiddenGroups, hiddenFields, totalFields: entries.length };
}

/**
 * Outgoing fields grouped by the table they point at (several fields can point at sys_user). Generic fields (document id)
 * form one group with target ''. Each group: { target, fields: [{ name, label, kind, definedOn, inherited }] }.
 */
export function groupOutgoing(fields = [], { query = '', labels = {} } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const groups = new Map();
  fields.forEach((f) => {
    if (!f.kind) return;
    const target = f.kind === 'generic' ? '' : f.target;
    if (q && !`${target} ${labels[target] || ''} ${f.name} ${f.label}`.toLowerCase().includes(q)) return;
    if (!groups.has(target)) groups.set(target, { target, label: labels[target] || '', fields: [], generic: f.kind === 'generic' || !target });
    groups.get(target).fields.push({ name: f.name, label: f.label, kind: f.kind, definedOn: f.definedOn, inherited: Boolean(f.inherited), dependent: f.dependent || '' });
  });
  const list = [...groups.values()].map((g) => ({ ...g, count: g.fields.length }));
  list.sort((a, b) => (a.generic !== b.generic ? (a.generic ? 1 : -1) : byText(a.target, b.target)));
  return list;
}

/**
 * The model the diagram and the list both draw, from what the instance half loaded.
 * model: { table, label, chain: [names], labels: { name: label }, children: [{name,label}], descendantCount, outgoing: fields[], incoming: entries[] }
 */
export function buildMapGraph(model, { hideSystem = false, query = '' } = {}) {
  const labels = model.labels || {};
  const chain = model.chain && model.chain.length ? model.chain : [model.table];
  const inc = groupIncoming(model.incoming || [], { hideSystem, query, labels });
  return {
    table: model.table,
    label: model.label || labels[model.table] || model.table,
    scope: model.scope || '',
    parents: chain.slice(1).map((name) => ({ table: name, label: labels[name] || name })),
    children: (model.children || []).map((c) => ({ table: c.name, label: c.label || c.name })),
    descendantCount: Math.max(Number(model.descendantCount) || 0, (model.children || []).length),
    incoming: inc.groups,
    hiddenIncomingGroups: inc.hiddenGroups,
    hiddenIncomingFields: inc.hiddenFields,
    outgoing: groupOutgoing(model.outgoing || [], { query, labels }),
  };
}

/** One sentence of what the diagram shows, for screen readers and the diagram's tooltip. */
export function describeGraph(graph) {
  const parts = [`${graph.table} ${graph.parents.length ? `extends ${graph.parents.map((p) => p.table).join(' > ')}` : 'is a root table'}.`];
  if (graph.descendantCount) parts.push(`${graph.descendantCount} table${graph.descendantCount === 1 ? '' : 's'} extend it.`);
  const inFields = graph.incoming.reduce((n, g) => n + g.count, 0);
  const outFields = graph.outgoing.reduce((n, g) => n + g.count, 0);
  parts.push(`${inFields} field${inFields === 1 ? '' : 's'} on ${graph.incoming.length} table${graph.incoming.length === 1 ? '' : 's'} point here.`);
  parts.push(`It has ${outFields} reference field${outFields === 1 ? '' : 's'} pointing at ${graph.outgoing.length} table${graph.outgoing.length === 1 ? '' : 's'}.`);
  return parts.join(' ');
}

/** The map as Markdown, for pasting into a ticket, a wiki page or a chat. */
export function mapToMarkdown(model, graph) {
  const lines = [`# ${graph.label} (${graph.table})`, ''];
  const facts = [model.scopeName || model.scope ? `scope ${model.scopeName || model.scope}` : '', model.rowCount === null || model.rowCount === undefined ? '' : `${model.rowCount} rows`].filter(Boolean);
  if (facts.length) lines.push(facts.join(', '), '');
  lines.push(graph.parents.length ? `Extends: ${graph.parents.map((p) => p.table).join(' > ')}` : 'Root table (extends nothing)');
  if (graph.children.length) lines.push(`Extended by (${graph.descendantCount || graph.children.length}): ${graph.children.map((c) => c.table).join(', ')}${graph.descendantCount > graph.children.length ? ', ...' : ''}`);
  lines.push('', '## Points at', '');
  if (!graph.outgoing.length) lines.push('Nothing.');
  const withNotes = (name, notes) => { const n = notes.filter(Boolean); return n.length ? `${name} (${n.join(', ')})` : name; };
  graph.outgoing.forEach((g) => {
    lines.push(`- ${g.generic ? '(any table, document id)' : g.target}: ${g.fields.map((f) => withNotes(f.name, [f.kind === 'list' && 'list', f.inherited && `from ${f.definedOn}`])).join(', ')}`);
  });
  lines.push('', `## Pointed at by${graph.hiddenIncomingFields ? ` (${graph.hiddenIncomingFields} system-table fields left out)` : ''}`, '');
  if (!graph.incoming.length) lines.push('Nothing.');
  graph.incoming.forEach((g) => {
    lines.push(`- ${g.table}: ${g.fields.map((f) => withNotes(f.name, [f.kind === 'list' && 'list', f.viaParent && `points at ${f.target}`])).join(', ')}`);
  });
  return `${lines.join('\n')}\n`;
}

// --- Link ("many to many") tables --------------------------------------------------------------------------------

const LINK_SKIP_FIELD = /^(sys_scope|sys_domain|sys_package|sys_domain_path)$/;
const LINK_SKIP_TARGET = /^(sys_scope|sys_package|domain)$/;

/**
 * Tables that join this one to others: they hold two to four reference fields, at least one pointing at this table (or
 * a parent). `refsByTable` maps a table to its own reference fields (as dictionaryField returns them).
 * `defined` is a set of table names an instance lists in sys_m2m (a confirmation, not a requirement).
 */
export function detectLinkTables({ chain = [], incoming = [], refsByTable = new Map(), defined = new Set() } = {}) {
  const mine = new Set(chain.map(cleanName));
  const out = [];
  const seen = new Set();
  incoming.forEach((e) => {
    if (seen.has(e.table)) return;
    seen.add(e.table);
    const refs = (refsByTable.get(e.table) || []).filter((f) => f.kind === 'reference' && f.target && !LINK_SKIP_FIELD.test(f.name) && !LINK_SKIP_TARGET.test(f.target));
    if (refs.length < 2 || refs.length > 4) return;
    const toHere = refs.filter((f) => mine.has(f.target));
    if (!toHere.length) return;
    const others = refs.filter((f) => !mine.has(f.target));
    out.push({
      table: e.table,
      toHere: toHere.map((f) => f.name).sort(byText),
      others: others.map((f) => ({ field: f.name, target: f.target })),
      defined: defined.has(e.table),
    });
  });
  return out.sort((a, b) => Number(b.defined) - Number(a.defined) || Number(a.others.length === 0) - Number(b.others.length === 0) || byText(a.table, b.table));
}

// --- Diagram layout ---------------------------------------------------------------------------------------------

export const LAYOUT = { nodeH: 40, pad: 16, sideGap: 14, vGap: 24, kidGap: 10, minW: 96, maxW: 176, minGap: 80, maxGap: 200, titleChar: 6.5, labelChar: 5.7 };

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const fit = (text, chars) => (text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`);

function edgeLabelFor(fields) {
  const first = fields[0]?.name || '';
  const list = fields.every((f) => f.kind === 'list');
  return `${first}${fields.length > 1 ? ` +${fields.length - 1}` : ''}${list && fields.length === 1 ? ' (list)' : ''}`;
}

const MAX_LABEL_CHARS = 26;

/**
 * Where everything goes in the diagram: incoming tables on the left, the table in the middle with its parents above and
 * children below, outgoing tables on the right. Pure and deterministic; a node never overlaps another. Sizes are in
 * SVG user units (the panel scales the whole picture).
 *
 * Returns { width, height, nodes, edges, hidden: { incoming, outgoing, children } }.
 *   node = { id, kind, table, title, sub, x, y, w, h, clickable }
 *   edge = { id, kind, from, to, d, label, lx, ly, anchor, arrow ('ref' | 'extends' | ''), fields }
 */
export function layoutMap(graph, { maxPerSide = 12, maxChildren = 8, maxParents = 5 } = {}) {
  const L = LAYOUT;
  const inc = graph.incoming.slice(0, maxPerSide);
  const out = graph.outgoing.slice(0, maxPerSide);
  const parents = graph.parents.slice(0, maxParents);
  const kids = graph.children.slice(0, maxChildren);
  const moreIn = graph.incoming.length - inc.length;
  const moreOut = graph.outgoing.length - out.length;
  const moreKids = Math.max(0, graph.descendantCount - kids.length);

  const sideWidth = (items, titleOf) => clamp(Math.max(0, ...items.map((i) => titleOf(i).length)) * L.titleChar + 24, L.minW, L.maxW);
  const gapFor = (items) => (items.length ? clamp(Math.max(0, ...items.map((g) => Math.min(MAX_LABEL_CHARS, edgeLabelFor(g.fields).length))) * L.labelChar + 70, L.minGap, L.maxGap) : 0);

  const leftW = inc.length || moreIn ? sideWidth(inc, (g) => g.table) : 0;
  const rightW = out.length || moreOut ? sideWidth(out, (g) => g.target || '(any table)') : 0;
  const gapL = leftW ? gapFor(inc) || L.minGap : 0;
  const gapR = rightW ? gapFor(out) || L.minGap : 0;
  const centreTitles = [graph.table, ...parents.map((p) => p.table), ...kids.map((k) => k.table)];
  const centreW = clamp(Math.max(...centreTitles.map((t) => t.length)) * L.titleChar + 40, 150, 230);

  const xL = L.pad;
  const xC = xL + leftW + gapL;
  const xR = xC + centreW + gapR;
  const width = xR + rightW + L.pad;

  const sideCount = (items, more) => items.length + (more > 0 ? 1 : 0);
  const sideHeight = (n) => (n ? n * L.nodeH + (n - 1) * L.sideGap : 0);
  const leftH = sideHeight(sideCount(inc, moreIn));
  const rightH = sideHeight(sideCount(out, moreOut));
  const above = parents.length * (L.nodeH + L.vGap);
  const below = kids.length || moreKids ? L.vGap - 6 + (kids.length + (moreKids ? 1 : 0)) * (L.nodeH + L.kidGap) - L.kidGap : 0;

  const cy = L.pad + Math.max(above + L.nodeH / 2, leftH / 2, rightH / 2);
  const height = cy + Math.max(L.nodeH / 2 + below, leftH / 2, rightH / 2) + L.pad;

  const nodes = [];
  const edges = [];
  const centre = { id: `c:${graph.table}`, kind: 'centre', table: graph.table, title: fit(graph.table, Math.floor((centreW - 16) / L.titleChar)), sub: graph.label && graph.label !== graph.table ? fit(graph.label, 28) : 'this table', x: xC, y: cy - L.nodeH / 2, w: centreW, h: L.nodeH, clickable: false };
  nodes.push(centre);

  // Parents: a straight chain above the table, nearest parent closest.
  let prev = centre;
  parents.forEach((p, i) => {
    const y = centre.y - (i + 1) * (L.nodeH + L.vGap);
    const n = { id: `p:${p.table}`, kind: 'parent', table: p.table, title: fit(p.table, Math.floor((centreW - 16) / L.titleChar)), sub: p.label && p.label !== p.table ? fit(p.label, 28) : 'parent table', x: xC, y, w: centreW, h: L.nodeH, clickable: true };
    nodes.push(n);
    const x = xC + centreW / 2;
    edges.push({ id: `e:${prev.id}>${n.id}`, kind: 'extends', from: prev.id, to: n.id, d: `M ${x} ${prev.y} L ${x} ${n.y + n.h}`, label: 'extends', lx: x + 8, ly: n.y + n.h + L.vGap / 2 + 3, anchor: 'start', arrow: 'extends', fields: [] });
    prev = n;
  });

  // Children: indented under the table, joined by a rail.
  if (kids.length || moreKids) {
    const railX = xC + 10;
    const first = centre.y + centre.h + L.vGap - 6;
    const items = kids.map((k) => ({ kid: k }));
    if (moreKids) items.push({ more: moreKids });
    let lastMid = first;
    items.forEach((item, i) => {
      const y = first + i * (L.nodeH + L.kidGap);
      const mid = y + L.nodeH / 2;
      lastMid = mid;
      if (item.kid) {
        const n = { id: `k:${item.kid.table}`, kind: 'child', table: item.kid.table, title: fit(item.kid.table, Math.floor((centreW - 36) / L.titleChar)), sub: item.kid.label && item.kid.label !== item.kid.table ? fit(item.kid.label, 24) : 'child table', x: xC + 24, y, w: centreW - 24, h: L.nodeH, clickable: true };
        nodes.push(n);
        edges.push({ id: `e:${n.id}`, kind: 'extends', from: n.id, to: centre.id, d: `M ${railX} ${mid} L ${n.x} ${mid}`, label: '', lx: 0, ly: 0, anchor: 'start', arrow: '', fields: [] });
      } else {
        nodes.push({ id: 'more:children', kind: 'more', table: '', title: `+${item.more} more`, sub: 'more tables below', x: xC + 24, y, w: centreW - 24, h: L.nodeH, clickable: false });
        edges.push({ id: 'e:more:children', kind: 'extends', from: 'more:children', to: centre.id, d: `M ${railX} ${mid} L ${xC + 24} ${mid}`, label: '', lx: 0, ly: 0, anchor: 'start', arrow: '', fields: [] });
      }
    });
    edges.push({ id: 'e:rail', kind: 'extends', from: centre.id, to: centre.id, d: `M ${railX} ${centre.y + centre.h} L ${railX} ${lastMid}`, label: '', lx: 0, ly: 0, anchor: 'start', arrow: '', fields: [] });
  }

  // Incoming (left) and outgoing (right).
  const placeSide = (items, more, x, w, kind) => {
    const n = sideCount(items, more);
    const top = cy - sideHeight(n) / 2;
    items.forEach((g, i) => {
      const y = top + i * (L.nodeH + L.sideGap);
      const table = kind === 'incoming' ? g.table : g.target;
      const count = g.count;
      const id = `${kind === 'incoming' ? 'i' : 'o'}:${table || 'generic'}`;
      const node = {
        id,
        kind: kind === 'incoming' ? 'incoming' : g.generic ? 'generic' : 'outgoing',
        table,
        title: fit(table || '(any table)', Math.floor((w - 16) / L.titleChar)),
        sub: kind === 'incoming' ? `${count} field${count === 1 ? ' points' : 's point'} here` : g.generic ? 'document id field' : `${count} field${count === 1 ? '' : 's'}`,
        x,
        y,
        w,
        h: L.nodeH,
        clickable: Boolean(table),
      };
      nodes.push(node);
      const label = fit(edgeLabelFor(g.fields), MAX_LABEL_CHARS);
      const midY = y + L.nodeH / 2;
      // The label sits on a short straight run next to the side node; the curve to the table starts after it, so a
      // neighbouring row's label is never crossed by this row's line.
      const run = Math.min(label.length * L.labelChar + 14, (kind === 'incoming' ? gapL : gapR) - 40);
      if (kind === 'incoming') {
        const x1 = x + w;
        const xs = x1 + run;
        const x2 = centre.x;
        const dx = (x2 - xs) / 2;
        edges.push({ id: `e:${id}`, kind: 'ref-in', from: id, to: centre.id, d: `M ${x1} ${midY} L ${xs} ${midY} C ${xs + dx} ${midY}, ${x2 - dx} ${cy}, ${x2} ${cy}`, label, lx: x1 + 6, ly: midY - 5, anchor: 'start', arrow: 'ref', fields: g.fields.map((f) => f.name) });
      } else {
        const x1 = centre.x + centre.w;
        const x2 = x;
        const xs = x2 - run;
        const dx = (xs - x1) / 2;
        edges.push({ id: `e:${id}`, kind: 'ref-out', from: centre.id, to: id, d: `M ${x1} ${cy} C ${x1 + dx} ${cy}, ${xs - dx} ${midY}, ${xs} ${midY} L ${x2} ${midY}`, label, lx: x2 - 6, ly: midY - 5, anchor: 'end', arrow: 'ref', fields: g.fields.map((f) => f.name) });
      }
    });
    if (more > 0) {
      const y = top + items.length * (L.nodeH + L.sideGap);
      nodes.push({ id: `more:${kind}`, kind: 'more', table: '', title: `+${more} more`, sub: 'see the list', x, y, w, h: L.nodeH, clickable: false });
    }
  };
  if (leftW) placeSide(inc, moreIn, xL, leftW, 'incoming');
  if (rightW) placeSide(out, moreOut, xR, rightW, 'outgoing');

  return { width: Math.ceil(width), height: Math.ceil(height), nodes, edges, hidden: { incoming: moreIn, outgoing: moreOut, children: moreKids } };
}

/** Do any two nodes overlap? (Used by the tests; the layout never produces it.) */
export function overlappingNodes(nodes) {
  const hits = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hits.push([a.id, b.id]);
    }
  }
  return hits;
}

// --- Path finder --------------------------------------------------------------------------------------------------

export const PATH_LIMITS = { maxDepth: 4, maxResults: 400, perEnd: 40, maxFrontier: 5000, maxTables: 300 };

// Fields and tables that connect to almost everything and would drown the real routes.
const SKIP_FIELD = /^(sys_scope|sys_domain|sys_package|sys_domain_path)$/;
const SKIP_TARGET = /^(sys_scope|sys_package|domain|sys_db_object|sys_glide_object|sys_user_preference)$/;

const edgeKey = (f) => `${f.definedOn || f.table}.${f.name}`;
const endOf = (p) => p.tables[p.tables.length - 1];
const walkString = (p) => p.hops.map((h) => h.field).join('.');

/** Start a search from table `from` to table `to`. `extra` = how many steps longer than the shortest path to keep looking. */
export function startPathSearch(from, to, { maxDepth = PATH_LIMITS.maxDepth, extra = 0 } = {}) {
  const a = cleanName(from);
  const b = cleanName(to);
  return {
    from: a,
    to: b,
    maxDepth: clamp(Math.floor(maxDepth) || 1, 1, PATH_LIMITS.maxDepth),
    extra: clamp(Math.floor(extra) || 0, 0, PATH_LIMITS.maxDepth),
    depth: 0,
    frontier: [{ tables: [a], hops: [] }],
    results: [],
    list: [],
    generic: [],
    firstHit: -1,
    done: !a || !b || a === b,
    same: Boolean(a) && a === b,
    truncated: false,
    unexpanded: new Set(),
  };
}

/** What the next step needs loaded: the hierarchy of the frontier's tables, and their reference fields unless this is the last step. */
export function pathNeeds(state) {
  if (state.done) return { hierarchy: [], fields: [] };
  const ends = [...new Set(state.frontier.map(endOf))].sort(byText);
  return { hierarchy: ends, fields: state.depth < state.maxDepth ? ends : [] };
}

/** Take one step: collect paths that arrived, stop or widen the frontier by one reference. Mutates and returns `state`. */
export function advancePathSearch(state, schema) {
  if (state.done) return state;

  // 1. Which paths have arrived? (the end table is the target or extends it)
  const walking = [];
  state.frontier.forEach((p) => {
    if (p.hops.length && isA(schema, endOf(p), state.to)) {
      if (state.results.length < PATH_LIMITS.maxResults) state.results.push(p);
      else state.truncated = true;
    } else walking.push(p);
  });
  if (state.results.length && state.firstHit < 0) state.firstHit = state.depth;
  if ((state.firstHit >= 0 && state.depth >= state.firstHit + state.extra) || state.depth >= state.maxDepth || !walking.length) {
    state.done = true;
    state.frontier = [];
    return state;
  }

  // 2. Widen by one reference. On the last step the new paths are only checked for arrival, so a path whose end is known
  // not to be the target is dropped at once (a wide schema would otherwise build a few hundred thousand of them).
  const lastStep = state.depth + 1 >= state.maxDepth || (state.firstHit >= 0 && state.depth + 1 >= state.firstHit + state.extra);
  const cannotArrive = (t) => lastStep && hierarchyKnown(schema, t) && !isA(schema, t, state.to);
  const next = [];
  const refsCache = new Map();
  walking
    .map((p) => ({ p, w: p.walk ?? walkString(p) }))
    .sort((a, b) => byText(a.w, b.w))
    .forEach(({ p, w }) => {
      const end = endOf(p);
      if (!fieldsLoaded(schema, end)) {
        state.unexpanded.add(end);
        return;
      }
      const used = new Set(p.hops.map((h) => h.key));
      if (!refsCache.has(end)) refsCache.set(end, refFieldsOf(schema, end));
      refsCache.get(end).forEach((f) => {
        if ((SKIP_FIELD.test(f.name) && f.target !== state.to) || used.has(edgeKey(f))) return;
        const hop = { table: end, field: f.name, label: f.label, kind: f.kind, target: f.target, definedOn: f.definedOn, key: edgeKey(f) };
        if (f.kind === 'reference' && f.target) {
          if (SKIP_TARGET.test(f.target) && f.target !== state.to) return;
          if (cannotArrive(f.target)) return;
          next.push({ tables: [...p.tables, f.target], hops: [...p.hops, hop], walk: w ? `${w}.${f.name}` : f.name });
        } else if (f.kind === 'list' && f.target && isA(schema, f.target, state.to)) {
          if (state.list.length < 8) state.list.push({ tables: [...p.tables, f.target], hops: [...p.hops, hop] });
        } else if (f.kind === 'generic') {
          if (state.generic.length < 12) state.generic.push({ tables: [...p.tables], hops: [...p.hops, hop] });
        }
      });
    });

  // 3. Keep the frontier bounded: a few dozen variants per end table, a few thousand overall.
  const perEnd = new Map();
  const kept = [];
  next
    .sort((a, b) => byText(a.walk, b.walk))
    .forEach((p) => {
      const end = endOf(p);
      const n = perEnd.get(end) || 0;
      if (n >= PATH_LIMITS.perEnd) {
        state.truncated = true;
        return;
      }
      perEnd.set(end, n + 1);
      kept.push(p);
    });
  if (kept.length > PATH_LIMITS.maxFrontier) {
    state.truncated = true;
    kept.length = PATH_LIMITS.maxFrontier;
  }
  state.frontier = kept;
  state.depth += 1;
  if (!kept.length) state.done = true;
  return state;
}

/** One finished path with the strings the panel shows. */
function finishPath(p) {
  return { tables: p.tables, hops: p.hops.map(({ key, ...hop }) => hop), dotWalk: walkString(p), length: p.hops.length, viaChild: false };
}

/** Same route = same tables in order; its variants differ only in the field names (caller_id, opened_by ...). */
export function groupRoutes(paths = []) {
  const routes = new Map();
  paths.forEach((p) => {
    const key = p.tables.join('>');
    if (!routes.has(key)) routes.set(key, { key, tables: p.tables, length: p.length, variants: [] });
    routes.get(key).variants.push(p);
  });
  const list = [...routes.values()];
  list.forEach((r) => r.variants.sort((a, b) => byText(a.dotWalk, b.dotWalk)));
  // Shortest first; among equals the route most field names lead along (caller_id, opened_by ... to a user) comes first.
  return list.sort((a, b) => a.length - b.length || b.variants.length - a.variants.length || byText(a.key, b.key));
}

/** The result of a finished (or stopped) search. */
export function finishPathSearch(state, schema) {
  const paths = state.results.map(finishPath);
  paths.forEach((p) => {
    p.viaChild = p.tables[p.tables.length - 1] !== state.to; // the last field points at a table that extends the target
  });
  return {
    from: state.from,
    to: state.to,
    same: state.same,
    inherits: !state.same && Boolean(state.from) && isA(schema, state.from, state.to),
    maxDepth: state.maxDepth,
    extra: state.extra,
    reachedDepth: state.depth,
    shortest: state.firstHit,
    paths,
    routes: groupRoutes(paths),
    list: state.list.map(finishPath),
    // Generic routes only matter when nothing walkable was found.
    generic: paths.length ? [] : state.generic.map(finishPath),
    truncated: state.truncated,
    unexpanded: [...state.unexpanded].sort(byText),
  };
}

/** Run a whole search over a schema that is already loaded (tests, and the panel when everything is cached). */
export function findPaths(schema, from, to, options = {}) {
  const state = startPathSearch(from, to, options);
  while (!state.done) advancePathSearch(state, schema);
  return finishPathSearch(state, schema);
}

// --- Snippets -----------------------------------------------------------------------------------------------------

/** The reference fields of a path, joined with dots; `leaf` adds the column read at the end. */
export function dotWalkString(path, leaf = '') {
  const parts = path.hops.map((h) => h.field);
  const l = cleanName(leaf);
  if (l) parts.push(l);
  return parts.join('.');
}

/** gr.caller_id.manager.name.toString() - the property chain, which is what server scripts use to dot-walk. */
export function glideRecordLine(path, leaf, variable = 'gr') {
  const v = /^[A-Za-z_$][\w$]*$/.test(variable) ? variable : 'gr';
  return `${v}.${dotWalkString(path, leaf || 'sys_id')}.toString()`;
}

/** gr.getElement('caller_id.manager.name').toString() - getElement accepts the dotted name in one string. */
export function getElementLine(path, leaf, variable = 'gr') {
  const v = /^[A-Za-z_$][\w$]*$/.test(variable) ? variable : 'gr';
  return `${v}.getElement('${dotWalkString(path, leaf || 'sys_id')}').toString()`;
}

/** sysparm_fields=caller_id.manager.name */
export function tableApiFragment(path, leaf) {
  return `sysparm_fields=${dotWalkString(path, leaf || 'sys_id')}`;
}

/** caller_id.manager.name= (ready for a value or an operator) */
export function encodedQueryCondition(path, leaf, operator = '=') {
  return `${dotWalkString(path, leaf || 'sys_id')}${operator}`;
}

/** The column to read at the end of a path by default: the display column, else name, number, short_description, sys_id. */
export function pickLeaf(fields = []) {
  const names = new Set(fields.map((f) => f.name));
  const display = fields.find((f) => f.display && f.kind !== 'generic');
  if (display) return display.name;
  return ['name', 'number', 'title', 'short_description', 'label', 'user_name'].find((n) => names.has(n)) || 'sys_id';
}

// --- Walking a dot-walked name, and the field tree ------------------------------------------------------------------

/**
 * Follow `caller_id.manager` from `table`: the table the last reference leads to, so the fields to offer next are that
 * table's. Fails with a plain sentence when a part is not a reference field.
 */
export function walkTo(schema, table, path) {
  let here = cleanName(table);
  const parts = String(path || '').split('.').filter(Boolean);
  const trail = [];
  for (const part of parts) {
    const f = fieldsOf(schema, here).find((x) => x.name === part);
    // When only the reference columns were read, a missing name may still be a plain column: say what is known.
    if (!f && !fieldsLoaded(schema, here, { full: true })) return { ok: false, error: `${here} has no reference field "${part}".`, trail };
    if (!f) return { ok: false, error: `${here} has no field "${part}".`, trail };
    if (f.kind === 'generic') return { ok: false, error: `${here}.${part} holds a record of any table, so it cannot be dot-walked.`, trail };
    if (f.kind === 'list') return { ok: false, error: `${here}.${part} is a list of references, so it cannot be dot-walked.`, trail };
    if (f.kind !== 'reference' || !f.target) return { ok: false, error: `${here}.${part} is not a reference field.`, trail };
    trail.push({ table: here, field: part, target: f.target });
    here = f.target;
  }
  return { ok: true, table: here, trail };
}

/**
 * The fields of a table as a tree: reference fields carry `children` (the target table's fields) down to `depth` levels.
 * depth 1 = just this table's fields. Stops at `maxNodes` so a wide schema cannot run away.
 */
export function fieldTree(schema, table, depth = 1, { maxNodes = 4000 } = {}) {
  let count = 0;
  const grow = (t, d) =>
    fieldsOf(schema, t).flatMap((f) => {
      if (count >= maxNodes) return [];
      count += 1;
      const node = { name: f.name, label: f.label, type: f.type, kind: f.kind, target: f.target, definedOn: f.definedOn, inherited: f.inherited };
      if (d > 1 && f.kind === 'reference' && f.target && fieldsLoaded(schema, f.target, { full: true })) node.children = grow(f.target, d - 1);
      return [node];
    });
  return { table: cleanName(table), depth, fields: grow(cleanName(table), Math.max(1, depth)), truncated: count >= maxNodes };
}

// --- Arguments ----------------------------------------------------------------------------------------------------

/**
 * What the user typed after /map, /path, /dotwalk, /schema: "incident" (the map), "incident sys_user" or
 * "incident to sys_user" (the path finder). Words like map, path, to, from are ignored.
 */
export function parseArgs(text, contextTable = '') {
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/->|→|,/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !['to', 'from', 'path', 'map', 'between', 'and'].includes(t));
  const names = tokens.map(cleanName).filter(Boolean);
  if (names.length >= 2) return { mode: 'path', table: names[0], from: names[0], to: names[1] };
  if (names.length === 1) return { mode: 'map', table: names[0], from: names[0], to: '' };
  const ctx = cleanName(contextTable);
  return { mode: 'map', table: ctx, from: ctx, to: '' };
}
