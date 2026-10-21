// Pure half of the list power tools (src/content/listTools.js): turn the rows of a classic list into text that
// pastes well (Excel / Sheets, Markdown, JSON), id lists for scripts, distinct column values, and the plan for
// opening rows in tabs. The DOM is read elsewhere and arrives here as a plain model, so everything is unit-tested
// (tests/listcopy.test.js).
//
// Model: { columns: [{ name, label }], rows: [{ sysId, selected, cells: string[] }] }, one cell per column.

export const FORMATS = [
  { id: 'tsv', label: 'Excel / Sheets (tab-separated)', short: 'Excel' },
  { id: 'markdown', label: 'Markdown table', short: 'Markdown' },
  { id: 'json', label: 'JSON', short: 'JSON' },
];

export const OPEN_CAP = 8;
export const OPEN_CONFIRM_ABOVE = 3;
export const DISTINCT_LIMIT = 10;
export const EMPTY_LABEL = '(empty)';

const SYS_ID = /^[0-9a-f]{32}$/i;

/** One cell as a single line: tabs, newlines and runs of spaces collapse to one space. */
export function normalizeCell(text) {
  return String(text ?? '')
    .replace(/[ \s]+/g, ' ')
    .trim();
}

/**
 * Columns and rows of a list from what the page showed.
 * `headers` is every header cell in order: { name, text }. A header without a name (the checkbox column, the icon
 * column, the "preview" column) is skipped together with the cell under it, so cells stay aligned.
 * `rows` is { sysId, selected, cells } with one cell per header cell, in the same order.
 */
export function buildModel({ headers = [], rows = [] } = {}) {
  const keep = headers.map((h, index) => ({ h, index })).filter(({ h }) => h && String(h.name || '').trim());
  const seenNames = new Set();
  const columns = [];
  const indexes = [];
  keep.forEach(({ h, index }) => {
    const name = String(h.name).trim();
    if (seenNames.has(name)) return; // the same column twice (a repeated header) adds nothing
    seenNames.add(name);
    columns.push({ name, label: normalizeCell(h.text) || name });
    indexes.push(index);
  });
  return {
    columns,
    rows: rows.map((row) => ({
      sysId: SYS_ID.test(String(row.sysId || '')) ? String(row.sysId).toLowerCase() : '',
      selected: row.selected === true,
      cells: indexes.map((i) => normalizeCell(row.cells?.[i])),
    })),
  };
}

/** Column headings for text formats: the label, with the name added when two columns share a label. */
export function headings(columns) {
  const counts = new Map();
  columns.forEach((c) => counts.set(c.label, (counts.get(c.label) || 0) + 1));
  return columns.map((c) => (counts.get(c.label) > 1 || !c.label ? `${c.label || c.name} (${c.name})` : c.label));
}

/** The ticked rows when any are ticked, else every row on screen. */
export function pickRows(model) {
  const selected = model.rows.filter((r) => r.selected);
  return selected.length ? { rows: selected, scope: 'selected' } : { rows: model.rows, scope: 'visible' };
}

// A cell that starts with a quote would be taken as a quoted field by Excel: quote it ourselves.
const tsvCell = (text) => (text.startsWith('"') ? `"${text.replace(/"/g, '""')}"` : text);

export function toTsv(columns, rows) {
  const lines = [headings(columns).map(tsvCell).join('\t')];
  rows.forEach((r) => lines.push(r.cells.map(tsvCell).join('\t')));
  return lines.join('\n');
}

const mdCell = (text) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

export function toMarkdown(columns, rows) {
  const head = headings(columns).map(mdCell);
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  rows.forEach((r) => lines.push(`| ${r.cells.map(mdCell).join(' | ')} |`));
  return lines.join('\n');
}

/** JSON keyed by database column name (stable, what a script uses), plus the sys_id when the row has one. */
export function toJson(columns, rows) {
  const out = rows.map((r) => {
    const item = {};
    if (r.sysId && !columns.some((c) => c.name === 'sys_id')) item.sys_id = r.sysId;
    columns.forEach((c, i) => {
      item[c.name] = r.cells[i];
    });
    return item;
  });
  return JSON.stringify(out, null, 2);
}

/** { text, rowCount, columnCount, scope } for the chosen format, or null when there is nothing to copy. */
export function formatRows(format, model) {
  const { rows, scope } = pickRows(model);
  if (!rows.length || !model.columns.length) return null;
  const build = { tsv: toTsv, markdown: toMarkdown, json: toJson }[format] || toTsv;
  return { text: build(model.columns, rows), rowCount: rows.length, columnCount: model.columns.length, scope };
}

/** "Copied 20 rows x 6 columns" (and "selected" when the choice was the ticked rows). */
export function describeCopy({ rowCount, columnCount, scope }) {
  const rows = `${rowCount} ${scope === 'selected' ? 'selected ' : ''}${rowCount === 1 ? 'row' : 'rows'}`;
  const cols = `${columnCount} ${columnCount === 1 ? 'column' : 'columns'}`;
  return `Copied ${rows} x ${cols}`;
}

/** The sys_ids of the ticked rows, else of every row on screen. */
export function sysIdsOf(model) {
  const { rows, scope } = pickRows(model);
  return { ids: rows.map((r) => r.sysId).filter(Boolean), scope };
}

export const toIdList = (ids) => ids.join(',');

/** A JavaScript array literal, ready to paste into a script. */
export function toJsArray(ids) {
  return `[${ids.map((id) => `'${id}'`).join(', ')}]`;
}

/**
 * The Table API URL that returns what the list shows: same table, same filter, the columns on screen.
 * @param {string} origin e.g. https://dev1.service-now.com
 * @param {{ columns?: string[], limit?: number, displayValue?: boolean }} options
 */
export function listRestUrl(origin, table, query, { columns = [], limit = 100, displayValue = false } = {}) {
  if (!/^[a-z][a-z0-9_]*$/.test(String(table || ''))) throw new Error('This page has no table name to build a URL from.');
  const params = [];
  if (query) params.push(`sysparm_query=${encodeURIComponent(query)}`);
  const fields = [...new Set(columns.filter((c) => /^[a-z][a-z0-9_.]*$/.test(c || '')).concat('sys_id'))];
  if (columns.length) params.push(`sysparm_fields=${fields.join(',')}`);
  params.push(`sysparm_limit=${Math.max(1, Math.min(10000, Number(limit) || 100))}`);
  if (displayValue) params.push('sysparm_display_value=true');
  return `${String(origin).replace(/\/+$/, '')}/api/now/table/${table}?${params.join('&')}`;
}

/** The two ticked rows to compare: exactly two with a sys_id, else a message saying what to do. */
export function pickTwo(model) {
  const ticked = (model.rows || []).filter((r) => r.selected && r.sysId);
  if (ticked.length === 2) return { ids: [ticked[0].sysId, ticked[1].sysId] };
  if (!ticked.length) return { error: 'Tick the two rows you want to compare, then run this again.' };
  return { error: ticked.length === 1 ? 'Only 1 row is ticked. Tick one more to compare.' : `${ticked.length} rows are ticked. Tick exactly two to compare them.` };
}

/** The text of "Copied N sys_ids" style toasts. */
export function describeIds(count, scope, what = 'sys_ids') {
  const noun = count === 1 ? what.replace(/s$/, '') : what;
  return `Copied ${count} ${scope === 'selected' ? 'selected ' : ''}${noun}`;
}

/**
 * Count by value for one column over the given rows, most common first.
 * @returns {{ total: number, distinct: number, top: Array<{ value: string, count: number }>, more: number }}
 */
export function distinctValues(rows, columnIndex, limit = DISTINCT_LIMIT) {
  const counts = new Map();
  rows.forEach((r) => {
    const value = r.cells[columnIndex] || '';
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  const all = [...counts.entries()]
    .map(([value, count]) => ({ value: value === '' ? EMPTY_LABEL : value, count, empty: value === '' }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  const top = all.slice(0, limit);
  return { total: rows.length, distinct: all.length, top, more: Math.max(0, all.length - top.length) };
}

/** Which rows to open in new tabs, and whether to ask first. */
export function planOpen(ids, { cap = OPEN_CAP, confirmAbove = OPEN_CONFIRM_ABOVE } = {}) {
  const unique = [...new Set(ids.filter(Boolean))];
  const open = unique.slice(0, cap);
  return { open, skipped: unique.length - open.length, needsConfirm: open.length > confirmAbove };
}
