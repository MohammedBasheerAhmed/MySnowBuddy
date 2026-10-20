// Smart selection: select text on the page (a JSON blob, Base64, a timestamp, a table name, a record number ...) and a
// small popover says what it is and offers what you would do with it. The decisions live in src/lib/smartSelect.js;
// this file reads the selection, asks the instance only when a kind needs it, and shows the popover.
//
// Rules this file keeps: it stays quiet unless it is confident (the lib decides, and a lookup that finds nothing shows
// nothing); it never fires for text being typed into an editable field or for selections inside our own UI; every
// handler ignores events a page script could have made (isTrusted); read-only: it only copies and navigates; nothing
// is built from HTML strings. The inline tools (inline.js) call handleSelection from their mouseup listener, so it is
// switched on and off with them.

import { queryTable } from './tableApi.js';
import { copyText, navigate, listUrl, recordUrl, newRecordUrl } from './quickActions.js';
import { UI_HOST_ID } from './uiRoot.js';
import { parseRecordNumber, tablesForNumber } from '../lib/recordNumber.js';
import { dictionaryQuery, fieldAclQuery } from '../lib/inline.js';
import { classify, describeSelection, selectionCandidate, tableCandidate, fieldCandidate, LOOKUP_KINDS } from '../lib/smartSelect.js';

const SETTLE_MS = 280;
const KIND_LABEL = { json: 'JSON', xml: 'XML', jwt: 'a token', base64: 'Base64', urlencoded: 'URL-encoded text', epoch: 'a timestamp', datetime: 'a date and time', recordNumber: 'a record number', table: 'a table', field: 'a field' };

const state = { timer: null, seq: 0, extra: [] };

const errorText = (err) => (err && err.message) || String(err);

/** Other modules can teach the popover a kind: { kind, detect(text), describe(text) => spec | null } (see addSmartKind). */
export function addSmartKind(entry) {
  if (!entry?.kind || typeof entry.detect !== 'function' || typeof entry.describe !== 'function') return;
  state.extra = [...state.extra.filter((e) => e.kind !== entry.kind), entry];
}

/** True when the selection sits in something the user is typing into (or an editor), which we must not interrupt. */
function inEditableField(doc, event) {
  const active = doc.activeElement;
  const editable = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    if (el.closest?.('.monaco-editor, .CodeMirror, .ace_editor')) return true;
    const tag = el.tagName;
    return (tag === 'TEXTAREA' || tag === 'INPUT') && !el.readOnly && !el.disabled;
  };
  return editable(active) || editable(event?.target);
}

async function copyWithToast(toast, text, what) {
  try {
    await copyText(text);
    toast?.success(`Copied ${what}`);
  } catch (err) {
    toast?.error(errorText(err));
  }
}

// --- Lookups (only the kinds that need the instance) ---------------------------------------------

async function lookupRecordNumber(text) {
  const number = parseRecordNumber(text);
  if (!number) return null;
  for (const table of tablesForNumber(number)) {
    // eslint-disable-next-line no-await-in-loop -- the second table is only asked when the first finds nothing.
    const rows = await queryTable(table, `number=${number}`, ['sys_id', 'number', 'short_description', 'sys_class_name'], { limit: 1 }).catch(() => []);
    if (rows.length) {
      const row = rows[0];
      return { number: row.number || number, sysId: row.sys_id, table: table === 'task' ? row.sys_class_name || 'task' : table, summary: row.short_description || '' };
    }
  }
  return null;
}

async function lookupTable(name) {
  const rows = await queryTable('sys_db_object', `name=${name}`, ['sys_id', 'name', 'label', 'super_class.name'], { limit: 1 }).catch(() => []);
  return rows[0] ? { name: rows[0].name || name, label: rows[0].label || '', parent: rows[0]['super_class.name'] || '', sysId: rows[0].sys_id } : null;
}

async function lookupField(table, field) {
  const rows = await queryTable('sys_dictionary', `name=${table}^element=${field}`, ['sys_id', 'column_label', 'internal_type', 'max_length', 'reference'], { limit: 1 }).catch(() => []);
  return rows[0] ? { table, field, label: rows[0].column_label || '', type: rows[0].internal_type || '', reference: rows[0].reference || '', length: rows[0].max_length || '' } : null;
}

// --- What the popover says -------------------------------------------------------------------------

function copyAction(toast, label, text, what, primary = false) {
  return { label, primary, onClick: () => copyWithToast(toast, text, what) };
}

function localSpec(text, kind, toast) {
  const d = describeSelection(text, kind);
  if (!d) return null;
  const t = d.texts || {};
  const actions = {
    json: [copyAction(toast, 'Copy pretty', t.pretty, 'pretty JSON', true), copyAction(toast, 'Copy minified', t.minified, 'minified JSON')],
    xml: [copyAction(toast, 'Copy pretty', t.pretty, 'pretty XML', true), copyAction(toast, 'Copy minified', t.minified, 'minified XML')],
    jwt: [copyAction(toast, 'Copy decoded', t.decoded, 'the decoded token', true)],
    base64: [copyAction(toast, 'Copy decoded', t.decoded, 'the decoded text', true), ...(t.pretty !== t.decoded ? [copyAction(toast, 'Copy pretty', t.pretty, 'the pretty-printed text')] : [])],
    urlencoded: [copyAction(toast, 'Copy decoded', t.decoded, 'the decoded text', true)],
    epoch: [copyAction(toast, 'Copy as ISO', t.iso, 'the ISO time', true), copyAction(toast, 'Copy your time', t.local, 'your local time')],
    datetime: [copyAction(toast, 'Copy as ISO (UTC)', t.iso, 'the ISO time', true)],
  }[kind];
  return { title: d.title, subtitle: d.subtitle, rows: d.rows, body: d.body, tone: 'info', actions: actions || [] };
}

async function lookupSpec(text, kind, toast) {
  if (kind === 'recordNumber') {
    const found = await lookupRecordNumber(text);
    if (!found) return null;
    return {
      title: found.number,
      subtitle: 'record number',
      tone: 'info',
      rows: [
        ...(found.summary ? [{ label: 'Summary', value: found.summary }] : []),
        { label: 'Table', value: found.table, mono: true },
      ],
      actions: [
        { label: 'Open', primary: true, onClick: () => navigate(recordUrl(found.table, found.sysId)) },
        { label: 'New tab', onClick: () => navigate(recordUrl(found.table, found.sysId), { newTab: true }) },
        copyAction(toast, 'Copy sys_id', found.sysId, 'sys_id'),
      ],
    };
  }
  if (kind === 'table') {
    const name = tableCandidate(text);
    const found = name && (await lookupTable(name));
    if (!found) return null;
    return {
      title: found.label || found.name,
      subtitle: 'table',
      tone: 'info',
      rows: [
        { label: 'Name', value: found.name, mono: true, copy: true },
        ...(found.parent ? [{ label: 'Extends', value: found.parent, mono: true }] : []),
      ],
      actions: [
        { label: 'List', primary: true, onClick: () => navigate(listUrl(found.name)) },
        { label: 'New record', onClick: () => navigate(newRecordUrl(found.name)) },
        { label: 'Fields', onClick: () => navigate(listUrl('sys_dictionary', `name=${found.name}^elementISNOTEMPTY`)) },
        { label: 'Config', onClick: () => navigate(recordUrl('sys_db_object', found.sysId)) },
      ],
    };
  }
  if (kind === 'field') {
    const parts = fieldCandidate(text);
    const found = parts && (await lookupField(parts.table, parts.field));
    if (!found) return null;
    return {
      title: found.label || found.field,
      subtitle: `${found.table}.${found.field}`,
      tone: 'info',
      rows: [
        { label: 'Type', value: found.type || 'unknown', mono: true },
        ...(found.reference ? [{ label: 'References', value: found.reference, mono: true }] : []),
        ...(found.length ? [{ label: 'Max length', value: String(found.length) }] : []),
      ],
      actions: [
        { label: 'Dictionary entry', primary: true, onClick: () => navigate(listUrl('sys_dictionary', dictionaryQuery(found.table, found.field))) },
        { label: 'Field ACLs', onClick: () => navigate(listUrl('sys_security_acl', fieldAclQuery(found.table, found.field))) },
        copyAction(toast, 'Copy name', found.field, `field name ${found.field}`),
      ],
    };
  }
  return null;
}

/**
 * Work out what `text` is and show the popover for it. Resolves true when something was shown.
 * `anchor` is { x, y } or an element; `doc` the document the anchor lives in.
 */
export async function explainText(text, { popover, toast, anchor, doc } = {}) {
  const value = selectionCandidate(text);
  if (!value || !popover) return false;
  const kinds = classify(value, { extra: state.extra });
  const mine = (state.seq += 1);
  for (const kind of kinds) {
    if (kind === 'sysid') return false; // the sys_id peek owns these
    let spec = null;
    try {
      const extra = state.extra.find((e) => e.kind === kind);
      // eslint-disable-next-line no-await-in-loop -- kinds are tried in order of how specific they are.
      spec = extra ? await extra.describe(value, { toast }) : LOOKUP_KINDS.has(kind) ? await lookupSpec(value, kind, toast) : localSpec(value, kind, toast);
    } catch {
      spec = null; // a failed lookup is silence, not an error toast on a plain text selection
    }
    if (mine !== state.seq) return false; // the selection moved on while we were asking
    if (spec) {
      popover.show({ anchor, doc, ...spec });
      return true;
    }
  }
  return false;
}

/** The text the user selected in `doc`, ignoring editable fields. */
function readSelection(doc) {
  const sel = doc.getSelection?.();
  return sel && !sel.isCollapsed ? sel.toString() : '';
}

/**
 * Called by the inline tools' mouseup listener for a selection that is not a sys_id. Waits for the selection to settle
 * (a double-click then a drag fires several mouseups), re-reads it, and shows the popover when it is confident.
 */
export function handleSelection({ event, doc, popover, toast }) {
  if (event.isTrusted !== true) return;
  if ((event.composedPath?.() || []).some((n) => n?.id === UI_HOST_ID || n?.dataset?.msbInline)) return;
  clearTimeout(state.timer);
  if (inEditableField(doc, event)) return;
  const point = { x: event.clientX, y: event.clientY };
  const first = readSelection(doc);
  if (!selectionCandidate(first)) return;
  state.timer = setTimeout(() => {
    const text = readSelection(doc);
    if (text !== first || inEditableField(doc, event)) return; // it changed, or the user clicked into a field
    explainText(text, { popover, toast, anchor: point, doc }).catch(() => {});
  }, SETTLE_MS);
}

/** What the palette shows for "Decode the selection": a label for the first kind, or '' for ordinary text. */
export function describeKinds(text, { extra = state.extra } = {}) {
  const kinds = classify(selectionCandidate(text), { extra });
  const first = kinds.find((k) => k !== 'sysid');
  return first ? KIND_LABEL[first] || first : '';
}

/** Stop any pending popover (the inline tools were switched off). */
export function cancelSmartSelect() {
  clearTimeout(state.timer);
  state.seq += 1;
}
