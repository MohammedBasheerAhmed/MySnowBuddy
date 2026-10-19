// Pure half of the on-page tools (src/content/inline.js, popover.js): where a popover goes, which
// buttons the page toolbar shows, which form labels hold scripts, and how audit / record data is
// turned into popover rows. No DOM and no network, so it is all unit-tested (tests/inline.test.js).

import { isName, isSysId, parsePrefixedId } from './xray.js';

export const SYS_ID_PATTERN = /^[0-9a-f]{32}$/i;

export function truncate(text, max = 120) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// --- Popover placement ------------------------------------------------------------------------

/** A { left, top, right, bottom, width, height } rect from a DOMRect-like, a rect-ish object or an { x, y } point. */
export function normalizeRect(anchor) {
  const a = anchor || {};
  if ('left' in a && 'top' in a) {
    const left = Number(a.left);
    const top = Number(a.top);
    const width = Number(a.width ?? (a.right ?? left) - left);
    const height = Number(a.height ?? (a.bottom ?? top) - top);
    return { left, top, right: left + width, bottom: top + height, width, height };
  }
  const x = Number(a.x) || 0;
  const y = Number(a.y) || 0;
  return { left: x, top: y, right: x, bottom: y, width: 0, height: 0 };
}

/** Shift a rect measured inside an iframe by that iframe's own position in its parent. */
export function translateRect(rect, frameRect) {
  const r = normalizeRect(rect);
  const dx = Number(frameRect?.left) || 0;
  const dy = Number(frameRect?.top) || 0;
  return normalizeRect({ left: r.left + dx, top: r.top + dy, width: r.width, height: r.height });
}

/**
 * Where to put a popover of `size` next to `anchor`: below it when it fits, else above, else on
 * the side with more room, always kept inside the viewport.
 * @returns {{ left: number, top: number, placement: 'below' | 'above' }}
 */
export function placePopover(anchor, size, viewport, { gap = 8, margin = 8 } = {}) {
  const rect = normalizeRect(anchor);
  const width = Math.min(size.width, Math.max(0, viewport.width - margin * 2));
  const roomBelow = viewport.height - rect.bottom - gap - margin;
  const roomAbove = rect.top - gap - margin;
  let placement = 'below';
  if (size.height > roomBelow) placement = size.height <= roomAbove || roomAbove > roomBelow ? 'above' : 'below';

  const rawTop = placement === 'below' ? rect.bottom + gap : rect.top - gap - size.height;
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  const maxLeft = Math.max(margin, viewport.width - width - margin);
  return {
    left: Math.round(Math.min(Math.max(rect.left, margin), maxLeft)),
    top: Math.round(Math.min(Math.max(rawTop, margin), maxTop)),
    placement,
  };
}

// --- Selections -------------------------------------------------------------------------------

/** The sys_id a selection consists of (lower-cased), or null. Surrounding whitespace and quotes are ignored. */
export function sysIdFromSelection(text) {
  const value = String(text ?? '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '');
  return SYS_ID_PATTERN.test(value) ? value.toLowerCase() : null;
}

// --- Form labels and list columns -------------------------------------------------------------

// Same column rules as src/content/context.js (pickScriptField), minus the value checks: a label
// has no value, and an empty script field still deserves its editor button.
const NOT_SCRIPT_COLUMNS = new Set(['isolate_script', 'description', 'messages', 'comments', 'short_description']);

export function isScriptColumn(field) {
  const column = String(field || '').toLowerCase();
  if (!column || column.includes('.') || NOT_SCRIPT_COLUMNS.has(column)) return false;
  return column === 'script' || column === 'operation_script' || column === 'client_script' || column.endsWith('_script') || column.startsWith('script_');
}

/**
 * True when a script field's label names a real script column. The page context falls back to the longest text field
 * on any form (right for the chat, wrong for an Edit/Lint toolbar), and it may carry a human label ("Client script")
 * or a "<table>.<column>" name.
 */
export function isScriptLabel(label) {
  const text = String(label || '').trim().toLowerCase().replace(/\s+/g, '_');
  return isScriptColumn(text.includes('.') ? text.slice(text.lastIndexOf('.') + 1) : text);
}

/** { table, field } for a classic form label id such as "label.incident.caller_id", else null. */
export function parseLabelId(id) {
  const parsed = parsePrefixedId(id, 'label.');
  if (!parsed || parsed.io) return null;
  // Reference helpers carry an inner prefix: "label.sys_display.incident.caller_id".
  if (['ni', 'sys_display', 'sys_original', 'sys_readonly'].includes(parsed.table)) return parsePrefixedId(`label.${parsed.field}`, 'label.');
  return parsed;
}

/** The table most of a form's labels belong to (related lists and embedded forms are the minority). */
export function dominantTable(tables) {
  const counts = new Map();
  tables.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

// --- Models: what to show ----------------------------------------------------------------------

/**
 * Buttons of the page toolbar for the page on screen. `kind` is what each button does in
 * src/content/inline.js; the model is kept free of handlers so it can be compared and tested.
 */
export function toolbarModel({ table = '', sysId = '', isList = false, hasScript = false } = {}) {
  if (!table || !isName(table)) return [];
  if (isList) {
    return [
      { id: 'explain', label: 'Explain filter', short: 'Explain' },
      { id: 'count', label: 'Count matching records', short: 'Count' },
      { id: 'copyQuery', label: 'Copy encoded query', short: 'Query' },
      { id: 'copyGlide', label: 'Copy GlideRecord code', short: 'GlideRecord' },
      { id: 'more', label: 'More list tools', short: 'More' },
    ];
  }
  const items = [];
  if (isSysId(sysId)) {
    items.push(
      { id: 'copySysId', label: 'Copy sys_id', short: 'sys_id' },
      { id: 'copyLink', label: 'Copy link to this record', short: 'Link' },
      { id: 'xml', label: 'Open the record XML in a new tab', short: 'XML' },
      { id: 'info', label: 'Who created and changed this record', short: 'Info' },
      { id: 'versions', label: 'Recent versions of this record', short: 'Versions' }
    );
  }
  if (hasScript) {
    items.push(
      { id: 'edit', label: 'Edit the script in the full-screen editor', short: 'Edit' },
      { id: 'lint', label: 'Lint the script (no AI tokens)', short: 'Lint' },
      { id: 'ask', label: 'Ask the AI about this script', short: 'Ask AI' }
    );
  }
  return items;
}

/** Stable text for comparing two toolbar models (to skip re-rendering). */
export const toolbarKey = (model) => model.map((i) => i.id).join(',');

/** Actions in the menu opened from a form field label. */
export function fieldMenuModel({ table, field, script = false }) {
  if (!isName(table) || !isName(String(field || '').split('.')[0])) return [];
  const items = [{ id: 'copyName', label: 'Copy name' }, { id: 'copyValue', label: 'Copy value' }];
  // Dot-walked paths ("caller_id.email") have no dictionary entry or ACL of their own on this table.
  if (!String(field).includes('.')) items.push({ id: 'dictionary', label: 'Dictionary entry' }, { id: 'acls', label: 'Field ACLs' });
  // The two calls developers type most: read this field on the form (client) and on a record (server).
  if (!String(field).includes('.')) items.push({ id: 'copyClient', label: 'Copy g_form call' });
  items.push({ id: 'copyServer', label: 'Copy GlideRecord call' });
  items.push({ id: 'xray', label: 'X-ray this field' });
  if (script) items.push({ id: 'edit', label: 'Full-screen editor' }, { id: 'lint', label: 'Lint' }, { id: 'ask', label: 'Ask AI' });
  return items;
}

/** Code that reads this field: `client` on a form (g_form), `server` on a GlideRecord. Dot-walks have no g_form form. */
export function fieldCode(kind, field) {
  const name = String(field || '');
  if (!isName(name.split('.')[0])) return '';
  if (kind === 'client') return name.includes('.') ? '' : `g_form.getValue('${name}')`;
  if (kind === 'server') return name.includes('.') ? `gr.getElement('${name}').toString()` : `gr.getValue('${name}')`;
  return '';
}

/** Actions in the menu opened from a list column header. */
export function columnMenuModel({ table, column }) {
  if (!isName(table) || !column) return [];
  const items = [{ id: 'copyName', label: 'Copy column name' }];
  if (!column.includes('.')) items.push({ id: 'dictionary', label: 'Dictionary entry' }, { id: 'acls', label: 'Field ACLs' });
  return items;
}

// --- Encoded queries for the lookups ----------------------------------------------------------

export function dictionaryQuery(table, field) {
  return isName(table) && isName(field) ? `name=${table}^element=${field}` : null;
}

export function fieldAclQuery(table, field) {
  // ACLs are named "table.field", "table.*" (every field) or "*.field" (that field on any table).
  return isName(table) && isName(field) ? `name=${table}.${field}^ORname=${table}.*^ORname=*.${field}` : null;
}

export function auditQuery(table, sysId, field) {
  if (!isName(table) || !isSysId(sysId) || !isName(field)) return null;
  return `tablename=${table}^documentkey=${sysId}^fieldname=${field}^ORDERBYDESCsys_created_on`;
}

// --- Popover rows ------------------------------------------------------------------------------

/** Rows for "Record info". */
export function recordInfoRows(info) {
  if (!info) return [];
  const rows = [];
  if (info.className) rows.push({ label: 'Class', value: info.className, mono: true });
  rows.push({ label: 'Created', value: [info.createdOn, info.createdBy && `by ${info.createdBy}`].filter(Boolean).join(' ') || 'unknown' });
  rows.push({ label: 'Updated', value: [info.updatedOn, info.updatedBy && `by ${info.updatedBy}`].filter(Boolean).join(' ') || 'unknown' });
  rows.push({ label: 'Updates', value: String(info.updates ?? 'unknown') });
  if (info.sysId) rows.push({ label: 'sys_id', value: info.sysId, mono: true, copy: true });
  return rows;
}

/** Rows for the newest sys_audit entry of one field, or a single explanatory row when there is none. */
export function lastChangeRows(row, field) {
  if (!row) return [{ label: 'Last changed', value: `No audit entry for ${field}. Auditing may be off for this table or field.` }];
  const who = row.sys_created_by || row.user || 'unknown';
  const rows = [{ label: 'Last changed', value: `${row.sys_created_on || 'unknown time'} by ${who}` }];
  if (row.oldvalue !== undefined && row.oldvalue !== '') rows.push({ label: 'From', value: truncate(row.oldvalue, 160), mono: true });
  if (row.newvalue !== undefined && row.newvalue !== '') rows.push({ label: 'To', value: truncate(row.newvalue, 160), mono: true });
  return rows;
}

/** A short message for a failed audit lookup (no access, expired session, auditing off). */
export function auditErrorText(err) {
  const text = (err && err.message) || String(err || '');
  if (err?.code === 'SESSION_EXPIRED') return text;
  if (/403|not allowed/i.test(text)) return 'Your user cannot read the audit history (sys_audit).';
  return `Could not read the audit history: ${truncate(text, 140)}`;
}

/** Rows for a short version list (newest first). */
export function versionRows(versions, limit = 6) {
  return (versions || []).slice(0, limit).map((v) => ({
    label: v.sys_recorded_at || 'unknown time',
    value: [v.sys_created_by, v.source && `from ${v.source}`, v.state && `(${v.state})`].filter(Boolean).join(' ') || 'unknown',
  }));
}

/** Popover title, tone and body for a lint run. */
export function lintSummary(findings) {
  const list = findings || [];
  if (!list.length) return { tone: 'ok', subtitle: 'No issues found by the deterministic rules.' };
  const high = list.filter((f) => f.severity === 'high').length;
  return { tone: high ? 'danger' : 'warn', subtitle: `${list.length} issue${list.length === 1 ? '' : 's'}${high ? `, ${high} high` : ''}` };
}
