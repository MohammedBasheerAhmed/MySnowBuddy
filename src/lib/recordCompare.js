// "Why does this record work and that one not?" - compare two records of the same table field by field (/vs INC0010002).
// The pure half: what the other record is, how to look it up, and the field-by-field comparison. No DOM, no network.
// The instance half is src/content/recordCompare.js; the panel is src/sidebar/RecordComparePanel.jsx.
//
// A record is compared as it is stored (so a changed reference shows even when two people share a display name), and
// shown as people read it (the display value). Bookkeeping that always differs between two records (sys_id, created,
// updated, counters) is left out unless asked for.

import { parseRecordNumber } from './recordNumber.js';
import { diffLines, collapseDiff, hasChanges } from './diff.js';

const SYS_ID_RE = /^[0-9a-f]{32}$/i;

/** Columns that differ between any two records and say nothing about why they behave differently. */
const BOOKKEEPING = new Set([
  'sys_id',
  'sys_created_on',
  'sys_created_by',
  'sys_updated_on',
  'sys_updated_by',
  'sys_mod_count',
  'sys_tags',
  'sys_domain_path',
  'sys_update_name',
  'number',
  'opened_at',
  'closed_at',
  'resolved_at',
  'activity_due',
  'business_duration',
  'calendar_duration',
  'business_stc',
  'calendar_stc',
  'reassignment_count',
  'reopen_count',
  'upon_approval',
]);

export const isBookkeeping = (name) => BOOKKEEPING.has(name);

/** Name-like columns tried, in order, when the other record is typed as a name rather than a number or sys_id. */
export const NAME_COLUMNS = ['name', 'user_name', 'number', 'short_description', 'label', 'title'];

/**
 * What the user typed for the other record.
 * @returns {{ kind: 'sys_id'|'number'|'name', value: string } | null}
 */
export function parseOther(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (SYS_ID_RE.test(text)) return { kind: 'sys_id', value: text.toLowerCase() };
  const number = parseRecordNumber(text);
  if (number) return { kind: 'number', value: number };
  if (text.length > 200 || /[\^\r\n]/.test(text)) return null;
  return { kind: 'name', value: text };
}

/**
 * Lookups to try, in order, on the table. ServiceNow ignores a condition on a column the table does not have and
 * returns every row, so `matches(row)` must be checked on whatever comes back.
 */
export function lookups(other) {
  if (!other) return [];
  const same = (column) => (row) => String(row?.[column] ?? '').toLowerCase() === other.value.toLowerCase();
  if (other.kind === 'sys_id') return [{ query: `sys_id=${other.value}`, matches: same('sys_id') }];
  if (other.kind === 'number') return [{ query: `number=${other.value}`, matches: same('number') }];
  const value = other.value.replace(/\^/g, '^^');
  return NAME_COLUMNS.map((column) => ({ query: `${column}=${value}`, matches: same(column) }));
}

/** A Table API row fetched with display values ({ value, display_value } per column) as { name: { value, display } }. */
export function flattenRecord(row) {
  const out = {};
  Object.entries(row || {}).forEach(([name, cell]) => {
    if (cell && typeof cell === 'object') {
      const value = cell.value === undefined || cell.value === null ? '' : String(cell.value);
      const display = cell.display_value === undefined || cell.display_value === null ? value : String(cell.display_value);
      out[name] = { value, display };
    } else {
      const value = cell === undefined || cell === null ? '' : String(cell);
      out[name] = { value, display: value };
    }
  });
  return out;
}

/** The record's own name for a heading: its number, name or short description, else the start of its sys_id. */
export function recordLabel(flat, fallback = '') {
  for (const key of ['number', 'name', 'user_name', 'short_description', 'label', 'title']) {
    const text = flat?.[key]?.display;
    if (text) return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  }
  return fallback || String(flat?.sys_id?.value || '').slice(0, 8);
}

const isLong = (text) => text.length > 80 || text.includes('\n');

/**
 * Field-by-field comparison.
 * @param {object} a flattened record (flattenRecord)
 * @param {object} b flattened record
 * @param {{ includeSystem?: boolean }} options
 * @returns {{ changes: Array, same: number, hidden: number }}
 *   changes: { name, before, after, long, rows } - `before`/`after` are display values; `rows` is a line diff for long values
 *   same:    fields that are equal on both
 *   hidden:  differing bookkeeping fields left out
 */
export function compareRecords(a, b, { includeSystem = false } = {}) {
  const names = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
  const changes = [];
  let same = 0;
  let hidden = 0;
  names.forEach((name) => {
    const left = a?.[name] || { value: '', display: '' };
    const right = b?.[name] || { value: '', display: '' };
    if (left.value === right.value) {
      same += 1;
      return;
    }
    if (isBookkeeping(name) && !includeSystem) {
      hidden += 1;
      return;
    }
    const long = isLong(left.display) || isLong(right.display);
    let rows = [];
    if (long) {
      const diff = diffLines(left.display, right.display);
      rows = hasChanges(diff) ? collapseDiff(diff, 3) : [];
    }
    changes.push({ name, before: left.display, after: right.display, beforeValue: left.value, afterValue: right.value, long, rows });
  });
  // Short values first (they are the quick answers), long scripts and journals after, each group by name.
  changes.sort((x, y) => Number(x.long) - Number(y.long) || x.name.localeCompare(y.name));
  return { changes, same, hidden };
}

/** One line: "12 fields differ, 38 are the same (7 bookkeeping fields hidden)". */
export function compareHeadline({ changes, same, hidden }) {
  const n = changes.length;
  if (!n) return `No differences: all ${same} fields are the same${hidden ? ` (${hidden} bookkeeping field${hidden === 1 ? '' : 's'} hidden)` : ''}.`;
  return `${n} field${n === 1 ? ' differs' : 's differ'}, ${same} ${same === 1 ? 'is' : 'are'} the same${hidden ? ` (${hidden} bookkeeping field${hidden === 1 ? '' : 's'} hidden)` : ''}.`;
}

const cell = (text, max = 120) => {
  const t = String(text ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ⏎ ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t || '(empty)';
};

export function compareToMarkdown({ table, left, right }, result) {
  const lines = [`## ${table}: ${left} vs ${right}`, '', compareHeadline(result), ''];
  if (result.changes.length) {
    lines.push(`| Field | ${cell(left, 40)} | ${cell(right, 40)} |`, '| --- | --- | --- |');
    result.changes.forEach((c) => lines.push(`| ${c.name} | ${cell(c.before)} | ${cell(c.after)} |`));
  }
  return `${lines.join('\n')}\n`;
}

/** A prompt for the AI chat: the differing short fields, and what to do with them. */
export function comparePrompt({ table, left, right }, result) {
  const rows = result.changes
    .slice(0, 40)
    .map((c) => `- ${c.name}: "${cell(c.before, 100)}" vs "${cell(c.after, 100)}"`)
    .join('\n');
  return `Two ${table} records on a ServiceNow instance: ${left} behaves as expected and ${right} does not (or the other way round). These fields differ:\n\n${rows}\n\nWhich differences are most likely to explain the different behaviour (conditions that business rules, UI policies, ACLs or flows would test)? Say what to check first and why. Keep it short.`;
}
