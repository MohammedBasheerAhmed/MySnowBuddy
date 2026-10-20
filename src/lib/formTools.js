// Pure half of the form tools (src/content/formTools.js): turn the fields of the open form into JSON, a Markdown
// table, a "set values" script and a prefilled "new record" URL, and decide which fields may leave the page.
// No DOM and no network, so every rule is unit-tested (tests/formtools.test.js).
//
// A field here is { name, label, type, value, display, mandatory, readOnly, visible } as read from the page bridge
// (getFormModel for the state, getFormValues for the full, uncapped values).

import { REDACTED, redactSecrets } from '../providers/redact.js';

const TABLE_RE = /^[a-z][a-z0-9_]*$/;
const SECRET_FIELD_NAME_RE = /(password|passwd|secret|token|credential|private_?key|api_?key)/i;
// Date and time values come back in the user's display format; a new-record URL would not parse them reliably.
const DATE_TYPE_RE = /^(glide_date|glide_date_time|glide_time|due_date|date|datetime|glide_duration|timer|calendar_date_time)$/i;
const JOURNAL_TYPE_RE = /^(journal|journal_input|journal_list|activity_stream)/i;
// An auto-number such as INC0010042 or CHG0030001: a new record gets its own.
const AUTO_NUMBER_RE = /^[A-Za-z]{2,6}\d{5,}$/;

/** URLs longer than this are refused by some proxies; fields that do not fit are reported, not cut off. */
export const MAX_URL_CHARS = 5500;
export const MAX_VALUE_CHARS = 1000;
const MAX_MARKDOWN_VALUE = 200;

/** A field whose value must not leave the page: by name, or by dictionary type (password, password2). */
export function isSecretField(field) {
  return SECRET_FIELD_NAME_RE.test(String(field?.name || '')) || /^password/i.test(String(field?.type || ''));
}

/** The value as it may be shown or copied: secrets replaced, everything else passed through redactSecrets. */
export function safeValue(field) {
  const value = field?.value == null ? '' : String(field.value);
  if (value === '') return '';
  if (isSecretField(field)) return REDACTED;
  return redactSecrets(value);
}

const hasValue = (field) => field?.value != null && String(field.value) !== '';

/** Fields with a value, in form order. */
export function filledFields(fields) {
  return (fields || []).filter((f) => f && f.name && hasValue(f));
}

/** { name: value } of every field that has a value (secrets redacted). */
export function valuesObject(fields) {
  const out = {};
  filledFields(fields).forEach((f) => {
    out[f.name] = safeValue(f);
  });
  return out;
}

/** Pretty JSON of the form's values; '' when the form is empty. */
export function valuesJson(fields) {
  const obj = valuesObject(fields);
  return Object.keys(obj).length ? JSON.stringify(obj, null, 2) : '';
}

function cell(text, max) {
  let value = String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
  if (value.length > max) value = `${value.slice(0, max - 1)}…`;
  return value;
}

/** A Markdown table (label, name, value, display value) for a ticket or a chat message. */
export function valuesMarkdown(fields, { table = '' } = {}) {
  const rows = filledFields(fields);
  if (!rows.length) return '';
  const lines = [];
  if (table) lines.push(`**${table}**`, '');
  lines.push('| Label | Name | Value | Display value |', '| --- | --- | --- | --- |');
  rows.forEach((f) => {
    const value = safeValue(f);
    const display = value === REDACTED || !f.display || f.display === f.value ? '' : f.display;
    lines.push(`| ${cell(f.label || f.name, 60)} | \`${f.name}\` | ${cell(value, MAX_MARKDOWN_VALUE)} | ${cell(display, MAX_MARKDOWN_VALUE)} |`);
  });
  return lines.join('\n');
}

/** A string as a single-quoted JavaScript literal. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
export function jsString(value) {
  return `'${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029')}'`;
}

/**
 * A server script that creates a record with these values. System fields, read-only fields and secrets are left out
 * (a comment says so); the insert itself is left commented so nothing runs by accident.
 */
export function setValuesScript(table, fields) {
  if (!TABLE_RE.test(String(table || ''))) throw new Error('This page has no table name to build a script from.');
  const { included, skipped } = duplicateFields(fields);
  const lines = [`var gr = new GlideRecord('${table}');`, 'gr.initialize();'];
  included.forEach((f) => lines.push(`gr.setValue(${jsString(f.name)}, ${jsString(f.value)});`));
  if (!included.length) lines.push('// (no fields with a value could be copied)');
  lines.push('// var sysId = gr.insert();');
  const secrets = skipped.filter((s) => s.reason === 'secret').map((s) => s.name);
  if (secrets.length) lines.push(`// Left out because they hold secrets: ${secrets.join(', ')}`);
  return lines.join('\n');
}

/**
 * Which fields a copy of this record should start with, and why the others are left out. A new record gets its own
 * sys_id, system columns, auto-number and dates; read-only fields are calculated; journals and secrets never travel.
 * @returns {{ included: object[], skipped: { name: string, reason: string }[] }}
 */
export function duplicateFields(fields) {
  const included = [];
  const skipped = [];
  (fields || []).forEach((f) => {
    if (!f || !f.name || !hasValue(f)) return;
    const name = f.name;
    const skip = (reason) => skipped.push({ name, reason });
    if (name === 'sys_id' || /^sys_/.test(name)) return; // system columns are expected to differ: not worth a note
    if (isSecretField(f)) return skip('secret');
    if (name === 'number' && AUTO_NUMBER_RE.test(String(f.value))) return; // numbered automatically
    if (f.readOnly === true) return skip('read-only');
    if (JOURNAL_TYPE_RE.test(String(f.type || ''))) return skip('journal');
    if (DATE_TYPE_RE.test(String(f.type || ''))) return skip('date');
    if (String(f.value).length > MAX_VALUE_CHARS) return skip('too long');
    included.push(f);
  });
  return { included, skipped };
}

/** A value inside an encoded query: "^" is the condition separator, so a literal one is doubled. */
export const queryValue = (value) => String(value).replace(/\^/g, '^^');

/**
 * Root-relative URL of a NEW record form on `table`, prefilled with the given values (sysparm_query default values).
 * Whatever does not fit in MAX_URL_CHARS is reported in `skipped`, never cut mid-value.
 * @returns {{ url: string, included: string[], skipped: { name: string, reason: string }[] }}
 */
export function duplicateUrl(table, fields) {
  if (!TABLE_RE.test(String(table || ''))) throw new Error('This page has no table name to duplicate from.');
  const { included, skipped } = duplicateFields(fields);
  const base = `/${table}.do?sys_id=-1&sysparm_query=`;
  const parts = [];
  const used = [];
  let length = base.length;
  included.forEach((f) => {
    // Encode "." too: a ".." in a value would look like path traversal to the navigation guard.
    const part = encodeURIComponent(`${f.name}=${queryValue(f.value)}`).replace(/\./g, '%2E');
    const cost = part.length + (parts.length ? 3 : 0); // "^" is %5E
    if (length + cost > MAX_URL_CHARS) {
      skipped.push({ name: f.name, reason: 'too long' });
      return;
    }
    parts.push(part);
    used.push(f.name);
    length += cost;
  });
  return { url: `${base}${parts.join('%5E')}`, included: used, skipped };
}

const REASON_TEXT = {
  secret: 'holds a secret',
  'read-only': 'is read-only',
  journal: 'is a journal field',
  date: 'is a date (its format differs)',
  'too long': 'is too long for a link',
};

/** One readable sentence about what a duplicate left out, or ''. */
export function skippedNote(skipped) {
  const list = skipped || [];
  if (!list.length) return '';
  const byReason = new Map();
  list.forEach(({ name, reason }) => byReason.set(reason, [...(byReason.get(reason) || []), name]));
  const parts = [...byReason.entries()].map(([reason, names]) => `${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''} ${REASON_TEXT[reason] || reason}`);
  return `Left out: ${parts.join('; ')}.`;
}

// --- Highlight states ----------------------------------------------------------------------------------

/**
 * The states each field is in, for the highlight overlay. `changed` is the list of field names the form reports as
 * modified; mandatory and read-only come from the model. Highest priority first within a field.
 * @returns {Map<string, string[]>} field name -> subset of ['changed', 'required', 'read-only']
 */
export function highlightStates(fields, changed = []) {
  const changedSet = new Set(changed || []);
  const out = new Map();
  (fields || []).forEach((f) => {
    if (!f || !f.name) return;
    const states = [];
    if (changedSet.has(f.name)) states.push('changed');
    if (f.mandatory === true) states.push('required');
    if (f.readOnly === true) states.push('read-only');
    if (states.length) out.set(f.name, states);
  });
  return out;
}

/** Plain sentence for the toast after switching highlights on. */
export function highlightSummary(states) {
  const counts = { changed: 0, required: 0, 'read-only': 0 };
  states.forEach((list) => list.forEach((s) => (counts[s] += 1)));
  return `${counts.required} required, ${counts['read-only']} read-only, ${counts.changed} changed.`;
}

// --- Open as -----------------------------------------------------------------------------------------

/** Root-relative URLs of the same record in other shapes. `sysId` must be a saved record's. */
export function openAsUrl(kind, table, sysId) {
  if (!TABLE_RE.test(String(table || ''))) throw new Error('This page has no table name.');
  if (!/^[0-9a-f]{32}$/i.test(String(sysId || ''))) throw new Error('Save the record first: it has no sys_id yet.');
  const id = sysId.toLowerCase();
  if (kind === 'json') return { url: `/api/now/table/${table}/${id}?sysparm_display_value=all`, raw: true };
  if (kind === 'xml') return { url: `/${table}.do?sys_id=${id}&XML`, raw: true };
  throw new Error(`Unknown format: ${kind}`);
}

/** Rows of the form that a hidden-field scan should treat as "hidden by a script": see src/content/formTools.js. */
export function hiddenLabel(count) {
  return count === 1 ? '1 hidden field shown' : `${count} hidden fields shown`;
}
