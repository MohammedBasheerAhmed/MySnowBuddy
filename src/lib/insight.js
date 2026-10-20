// Quick data insight (the "Break this list down" panel), the pure half. No DOM, no network:
//
//   - which columns are worth breaking a list down by (choice, boolean, reference, date),
//   - turning Aggregate API answers into rows, a top-N + "Other" bucket and percentages,
//   - composing "the list's filter AND column = value" as an encoded query (carets escaped, NQ groups handled),
//   - day / week / month buckets for the "Over time" view and the date-range query for each,
//   - comparing two values, and Markdown / CSV text.
//
// The instance half is src/content/insight.js; the panel is src/sidebar/InsightPanel.jsx.

export const TABLE_RE = /^[a-z][a-z0-9_]*$/;
export const COLUMN_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
export const TOP_N = 15;

const CARET = '\u0001';

// --- Choosing a column -------------------------------------------------------------------------------------

const DATE_TYPES = new Set(['glide_date_time', 'glide_date', 'due_date', 'calendar_date_time', 'date', 'datetime']);
const CHOICE_TYPES = new Set(['choice', 'boolean', 'integer_choice']);
// Columns that hold prose, code or blobs: a count per value would be one row per record.
const NOISE_TYPES = new Set(['journal', 'journal_input', 'journal_list', 'script', 'script_plain', 'html', 'translated_html', 'password', 'password2', 'user_image', 'image', 'glide_var', 'conditions', 'condition_string', 'documentation_field', 'wiki_text', 'composite_name', 'sys_class_name', 'collection', 'sys_class_path', 'user_input', 'json', 'xml']);
const NOISE_COLUMNS = new Set(['sys_id', 'sys_mod_count', 'sys_tags', 'sys_domain_path', 'sys_overrides', 'number', 'short_description', 'description', 'name', 'sys_updated_on', 'sys_created_on']);
// What people usually want counted first.
const FAVOURITES = ['state', 'priority', 'assignment_group', 'category', 'subcategory', 'urgency', 'impact', 'active', 'type', 'severity', 'assigned_to', 'caller_id', 'opened_by', 'sys_class_name', 'sys_created_by', 'sys_updated_by', 'sys_scope', 'sys_package', 'company', 'location', 'department', 'cmdb_ci', 'contact_type', 'close_code', 'approval', 'risk', 'when', 'collection', 'table', 'status'];

/** 'choice' | 'boolean' | 'reference' | 'date' | 'text' | '' (not worth counting) for one dictionary entry. */
export function columnKind(field = {}) {
  const type = String(field.type || field.internal_type || '').toLowerCase();
  if (!field.name || !COLUMN_RE.test(field.name)) return '';
  if (DATE_TYPES.has(type)) return 'date';
  if (type === 'boolean') return 'boolean';
  if (NOISE_TYPES.has(type)) return field.name === 'sys_class_name' ? 'choice' : '';
  if (field.choiceType || field.choice || CHOICE_TYPES.has(type)) return 'choice';
  if (type === 'reference') return 'reference';
  if (['string', 'integer', 'decimal', 'float', 'longint', 'percent_complete', 'duration', 'glide_duration', 'currency', 'price', 'ip_addr', 'url', 'email', 'phone_number_e164', 'domain_id', 'glide_list', 'document_id', ''].includes(type)) {
    const length = Number(field.maxLength || 0);
    return length && length > 100 ? '' : 'text';
  }
  return '';
}

/**
 * Columns to offer, best first: the usual suspects (state, priority, group...), then choices and booleans, then references,
 * then plain short columns. Dates are returned separately for the "Over time" view.
 * @param {Array<{name, label, type, reference, choiceType, maxLength}>} fields
 */
export function suggestColumns(fields = []) {
  const rank = (field, kind) => {
    const favourite = FAVOURITES.indexOf(field.name);
    const kindScore = { choice: 3, boolean: 3, reference: 2, text: 0 }[kind] ?? 0;
    // The usual suspects keep their own order; everything else is ranked by how well it counts.
    return favourite >= 0 ? 200 - favourite : kindScore * 10 - (field.name.startsWith('sys_') ? 15 : 0);
  };
  const columns = [];
  const dates = [];
  fields.forEach((field) => {
    const kind = columnKind(field);
    if (!kind) return;
    const entry = { name: field.name, label: field.label || field.name, kind, reference: field.reference || '' };
    if (kind === 'date') dates.push({ ...entry, rank: /^(opened_at|sys_created_on|created)$/.test(field.name) ? 3 : /^(closed_at|resolved_at|sys_updated_on|due_date)$/.test(field.name) ? 2 : 1 });
    else if (!NOISE_COLUMNS.has(field.name) || FAVOURITES.includes(field.name)) columns.push({ ...entry, rank: rank(field, kind) });
  });
  columns.sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label));
  dates.sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label));
  return { columns: columns.map(({ rank: _r, ...c }) => c), dates: dates.map(({ rank: _r, ...c }) => c) };
}

// --- Aggregate API answers ---------------------------------------------------------------------------------

/**
 * The Aggregate API (/api/now/stats/<table>?sysparm_group_by=<col>&sysparm_count=true&sysparm_display_value=all)
 * answers `{ result: [ { stats: { count: "12" }, groupby_fields: [ { field, value, display_value } ] } ] }`.
 * @returns {Array<{ value: string, label: string, count: number }>} (empty value kept as '' with the label "(empty)")
 */
export function parseStats(result) {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  return list
    .map((entry) => {
      const group = Array.isArray(entry?.groupby_fields) ? entry.groupby_fields[0] : null;
      const count = Number(entry?.stats?.count);
      if (!group || !Number.isFinite(count)) return null;
      const value = group.value == null ? '' : String(group.value);
      const label = value === '' ? '(empty)' : String(group.display_value || group.value);
      return { value, label, count };
    })
    .filter(Boolean);
}

/**
 * Rows -> at most `top` bars plus one "Other" bar, each with its share of the total.
 * `share` is a percentage with one decimal; `bar` is 0-100 relative to the longest bar (what the bar's width shows).
 */
export function bucketize(rows = [], top = TOP_N) {
  const sorted = [...rows].filter((r) => r.count > 0).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const total = sorted.reduce((sum, r) => sum + r.count, 0);
  const shown = sorted.slice(0, top);
  const rest = sorted.slice(top);
  const bars = shown.map((r) => ({ ...r, other: false }));
  if (rest.length) {
    bars.push({ value: '', label: `Other (${rest.length} more values)`, count: rest.reduce((sum, r) => sum + r.count, 0), other: true });
  }
  const max = Math.max(1, ...bars.map((b) => b.count));
  return {
    total,
    distinct: sorted.length,
    bars: bars.map((b) => ({ ...b, share: total ? Math.round((b.count / total) * 1000) / 10 : 0, bar: Math.max(1, Math.round((b.count / max) * 100)) })),
  };
}

// --- Encoded queries ---------------------------------------------------------------------------------------

const splitTokens = (query) =>
  String(query || '')
    .trim()
    .replace(/\^\^/g, CARET)
    .split('^')
    .filter(Boolean);

/** A value as it must be written after "=" in an encoded query: a literal caret is doubled. */
export const escapeValue = (value) => String(value ?? '').replace(/\^/g, '^^');

/** The condition for one bar: "column=value", or "columnISEMPTY" for the (empty) bar. */
export function valueCondition(column, value) {
  if (!COLUMN_RE.test(column || '')) throw new Error(`"${column}" is not a column name.`);
  return value === '' || value == null ? `${column}ISEMPTY` : `${column}=${escapeValue(value)}`;
}

/**
 * `query` AND `condition`. Sort / group clauses stay at the end. Each NQ group gets the condition (appending it once
 * would only filter the last group). `condition` is trusted code from valueCondition / rangeConditions.
 */
export function andCondition(query, condition) {
  const tokens = splitTokens(query);
  const ordering = tokens.filter((t) => /^(ORDERBY|GROUPBY)/.test(t));
  const rest = tokens.filter((t) => !/^(ORDERBY|GROUPBY)/.test(t));
  const out = [];
  rest.forEach((token, i) => {
    if (token.startsWith('NQ') && i > 0) out.push(condition);
    out.push(token);
  });
  out.push(condition);
  return [...out, ...ordering].join('^').split(CARET).join('^^');
}

/** "list filter AND column=value" for a clicked bar. */
export function filterForBar(query, column, value) {
  return andCondition(query, valueCondition(column, value));
}

/** Conditions only (no sort / group), as the Aggregate API wants them. */
export function countingQuery(query) {
  return splitTokens(query)
    .filter((t) => !/^(ORDERBY|GROUPBY)/.test(t))
    .join('^')
    .split(CARET)
    .join('^^');
}

// --- Over time ---------------------------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d, time) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const PERIODS = { day: { max: 31, default: 14 }, week: { max: 26, default: 12 }, month: { max: 24, default: 12 } };

/**
 * The last `count` periods ending with the one that contains `now`, oldest first.
 * Weeks start on Monday. Each bucket has the literal date-times the filter builder writes.
 * @returns {Array<{ label: string, from: string, to: string, start: Date, end: Date }>}
 */
export function periodBuckets(unit = 'day', count = PERIODS[unit]?.default || 14, now = new Date()) {
  const spec = PERIODS[unit];
  if (!spec) throw new Error(`Unknown period "${unit}".`);
  const n = Math.max(1, Math.min(spec.max, Math.floor(count)));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const buckets = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    let start;
    let end;
    if (unit === 'day') {
      start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      end = start;
    } else if (unit === 'week') {
      const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
      start = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7 * i);
      end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    } else {
      start = new Date(today.getFullYear(), today.getMonth() - i, 1);
      end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    }
    const label = unit === 'month' ? `${MONTHS[start.getMonth()]} ${String(start.getFullYear()).slice(2)}` : `${MONTHS[start.getMonth()]} ${start.getDate()}`;
    buckets.push({ label, from: stamp(start, '00:00:00'), to: stamp(end, '23:59:59'), start, end });
  }
  return buckets;
}

/** "list filter AND column within this period". */
export function rangeQuery(query, column, bucket) {
  if (!COLUMN_RE.test(column || '')) throw new Error(`"${column}" is not a column name.`);
  return andCondition(andCondition(query, `${column}>=${bucket.from}`), `${column}<=${bucket.to}`);
}

/** Time-series counts -> bars (relative height 0-100) plus the busiest period and the average. */
export function timeSeries(points = []) {
  const max = Math.max(0, ...points.map((p) => p.count));
  const total = points.reduce((sum, p) => sum + p.count, 0);
  const peak = points.reduce((best, p) => (p.count > (best?.count ?? -1) ? p : best), null);
  return {
    total,
    average: points.length ? Math.round((total / points.length) * 10) / 10 : 0,
    peak: peak && peak.count > 0 ? { label: peak.label, count: peak.count } : null,
    points: points.map((p) => ({ ...p, height: max ? Math.max(p.count ? 4 : 0, Math.round((p.count / max) * 100)) : 0 })),
  };
}

// --- Compare two values ------------------------------------------------------------------------------------

/** { a, b, difference, ratio, text } for two bars of the same breakdown. */
export function compareValues(a, b, total = 0) {
  if (!a || !b) return null;
  const diff = a.count - b.count;
  const ratio = b.count ? Math.round((a.count / b.count) * 100) / 100 : null;
  const share = (x) => (total ? ` (${Math.round((x.count / total) * 1000) / 10}%)` : '');
  let text = `${a.label}: ${a.count}${share(a)}; ${b.label}: ${b.count}${share(b)}. `;
  if (diff === 0) text += 'They are equal.';
  else if (ratio && ratio !== 1) text += `${diff > 0 ? a.label : b.label} has ${Math.abs(diff)} more${ratio >= 1 ? `, ${ratio}x as many as ${b.label}` : `, ${Math.round((b.count / a.count) * 100) / 100}x as many as ${a.label}`}.`;
  else text += `${diff > 0 ? a.label : b.label} has ${Math.abs(diff)} more.`;
  return { a, b, difference: diff, ratio, text };
}

// --- Text output -------------------------------------------------------------------------------------------

const mdCell = (text) => String(text ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function breakdownMarkdown({ table, column, query = '', bars = [], total = 0 }) {
  const lines = [`### ${table} by ${column} (${total} records)`, ''];
  if (query) lines.push(`Filter: \`${query}\``, '');
  lines.push('| Value | Count | Share |', '| --- | ---: | ---: |');
  bars.forEach((b) => lines.push(`| ${mdCell(b.label)} | ${b.count} | ${b.share}% |`));
  return lines.join('\n');
}

export function breakdownCsv({ bars = [] }) {
  return ['Value,Count,Share (%)', ...bars.map((b) => [csvCell(b.label), b.count, b.share].join(','))].join('\r\n');
}

export function seriesMarkdown({ table, column, unit, points = [] }) {
  const lines = [`### ${table} by ${column}, per ${unit}`, '', '| Period | Count |', '| --- | ---: |'];
  points.forEach((p) => lines.push(`| ${mdCell(p.label)} | ${p.count} |`));
  return lines.join('\n');
}

export function seriesCsv({ points = [] }) {
  return ['Period,Count', ...points.map((p) => [csvCell(p.label), p.count].join(','))].join('\r\n');
}
