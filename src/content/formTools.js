// Form tools: developer helpers for the classic form on screen, reached from the page toolbar ("Form") and the palette.
//
//   - Show hidden fields: rows a UI policy or client script hid are shown again, marked "hidden", and put back exactly as
//     they were when switched off. Values are never touched.
//   - Highlight: required, read-only and changed-but-unsaved fields get an outline AND a small text tag (never colour alone).
//   - Copy values as JSON, a Markdown table or a "set values" script (secrets redacted).
//   - Duplicate as new record: a NEW record form in a new tab, prefilled; the user still presses Submit.
//   - Open the record as JSON (REST), XML or its versions.
//
// Rules this file keeps: read-only toward the instance (it reads the form through the page bridge and changes only how the
// page is drawn, reversibly); page-DOM nodes carry data-msb-inline so the on-page tools' observer ignores them and switch-off
// removes them; every entry point is reached from a trusted click or a palette command; nothing is built from HTML strings.

import { callPage } from './pageBridge.js';
import { xrayDocuments } from './xray.js';
import { copyText, navigate, listUrl } from './quickActions.js';
import {
  isSecretField,
  filledFields,
  valuesJson,
  valuesMarkdown,
  setValuesScript,
  duplicateUrl,
  skippedNote,
  highlightStates,
  highlightSummary,
  openAsUrl,
  hiddenLabel,
} from '../lib/formTools.js';

const ATTR = 'data-msb-inline';
const MARK = 'data-msb-form';
const STYLE_ID = 'msb-form-style';
const ROW_RE = /^element\.([a-z][a-z0-9_]*)\.([A-Za-z0-9_.]+)$/;
const STATE_TOKENS = ['hidden', 'changed', 'required', 'read-only'];
const HIGHLIGHT_TOKENS = ['changed', 'required', 'read-only'];
const REFRESH_MS = 1500;

const state = {
  hidden: new Map(), // row element -> its original style attribute (string or null)
  highlightOn: false,
  highlightTimer: null,
  seq: 0,
};

const errorText = (err) => (err && err.message) || String(err);

// --- Page styles ------------------------------------------------------------------------------------------------

// Outline styles differ as well as colours (dashed, solid, dotted, double) and every marked row also carries a text tag,
// so no state is told apart by colour alone. The tag is black on white (21:1) whatever the page theme is.
const PAGE_CSS = `
[${MARK}]{outline-offset:2px!important}
[${MARK}~="read-only"]{outline:2px dotted #4b5a66!important}
[${MARK}~="required"]{outline:2px solid #b3261e!important}
[${MARK}~="hidden"]{outline:2px dashed #8a5300!important}
[${MARK}~="changed"]{outline:3px double #1b4fb3!important}
.msb-ft-tag{all:initial;visibility:inherit!important;box-sizing:border-box!important;display:inline-block!important;margin:0 0 0 6px!important;padding:0 5px!important;border:1px solid #1a1a1a!important;border-radius:3px!important;background:#fff!important;color:#1a1a1a!important;font:700 10px/15px -apple-system,"Segoe UI",Roboto,Arial,sans-serif!important;letter-spacing:0!important;text-transform:none!important;white-space:nowrap;vertical-align:middle;pointer-events:none}
`;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute(ATTR, 'style');
  style.textContent = PAGE_CSS;
  (doc.head || doc.documentElement).appendChild(style);
}

// --- Rows ----------------------------------------------------------------------------------------------------------

/** { el, field } for every field container of `table` in a classic document. */
function formRows(doc, table) {
  const out = [];
  doc.querySelectorAll('[id^="element."]').forEach((el) => {
    const m = ROW_RE.exec(el.id);
    if (m && m[1] === table) out.push({ el, field: m[2] });
  });
  return out;
}

/** Hidden by the row's own rule (UI policy, client script), not because a tab or section above it is closed. */
function isHiddenRow(el) {
  const win = el.ownerDocument.defaultView;
  if (!win || win.getComputedStyle(el).display !== 'none') return false;
  const parent = el.parentElement;
  return Boolean(parent && parent.getClientRects().length > 0);
}

const tokensOf = (el) => (el.getAttribute(MARK) || '').split(/\s+/).filter(Boolean);

function setTokens(el, tokens) {
  const ordered = STATE_TOKENS.filter((t) => tokens.includes(t));
  if (ordered.length) el.setAttribute(MARK, ordered.join(' '));
  else el.removeAttribute(MARK);
  syncTag(el, ordered);
}

function syncTag(el, tokens) {
  const host = el.querySelector('label') || el;
  let tag = el.querySelector('[data-msb-ft="tag"]');
  if (!tokens.length) {
    tag?.remove();
    return;
  }
  if (!tag) {
    tag = el.ownerDocument.createElement('span');
    tag.className = 'msb-ft-tag';
    tag.setAttribute(ATTR, 'form-tag');
    tag.setAttribute('data-msb-ft', 'tag');
    host.appendChild(tag);
  }
  tag.textContent = tokens.join(' · ');
}

function docs() {
  return xrayDocuments().filter((doc) => {
    try {
      return Boolean(doc.defaultView);
    } catch {
      return false;
    }
  });
}

async function formTable() {
  const meta = await callPage('getFormMeta').catch(() => null);
  if (!meta?.table) throw new Error('No form is open on this page.');
  return meta.table;
}

// --- Show hidden fields ---------------------------------------------------------------------------------------------

function restoreHidden() {
  state.hidden.forEach((style, el) => {
    if (!el.isConnected) return;
    if (style === null) el.removeAttribute('style');
    else el.setAttribute('style', style);
    setTokens(el, tokensOf(el).filter((t) => t !== 'hidden'));
  });
  state.hidden.clear();
}

/** Show the rows a script hid, or put them back. Returns { on, count }. */
export async function toggleHiddenFields({ toast } = {}) {
  if (state.hidden.size) {
    restoreHidden();
    toast?.info('Hidden fields hidden again.');
    return { on: false, count: 0 };
  }
  const table = await formTable();
  docs().forEach((doc) => {
    try {
      ensureStyle(doc);
      formRows(doc, table).forEach(({ el }) => {
        if (state.hidden.has(el) || !isHiddenRow(el)) return;
        state.hidden.set(el, el.getAttribute('style'));
        el.style.setProperty('display', 'block', 'important');
        setTokens(el, [...tokensOf(el), 'hidden']);
      });
    } catch {
      // The frame navigated away.
    }
  });
  const count = state.hidden.size;
  if (count) toast?.success(`${hiddenLabel(count)}. Run it again to hide them.`);
  else toast?.info('No fields are hidden on this form right now.');
  return { on: count > 0, count };
}

// --- Highlight ---------------------------------------------------------------------------------------------------------

async function applyHighlights() {
  const [model, status] = await Promise.all([callPage('getFormModel'), callPage('getFormStatus').catch(() => null)]);
  if (!model) return null;
  const states = highlightStates(model.fields, status?.changedFields || []);
  docs().forEach((doc) => {
    try {
      ensureStyle(doc);
      formRows(doc, model.table).forEach(({ el, field }) => {
        const keep = tokensOf(el).filter((t) => !HIGHLIGHT_TOKENS.includes(t));
        setTokens(el, [...keep, ...(states.get(field) || [])]);
      });
    } catch {
      // The frame navigated away.
    }
  });
  return states;
}

function clearHighlights() {
  docs().forEach((doc) => {
    try {
      doc.querySelectorAll(`[${MARK}]`).forEach((el) => setTokens(el, tokensOf(el).filter((t) => !HIGHLIGHT_TOKENS.includes(t))));
    } catch {
      // The frame navigated away.
    }
  });
}

function stopHighlight() {
  clearInterval(state.highlightTimer);
  state.highlightTimer = null;
  state.highlightOn = false;
  clearHighlights();
}

/** Outline required, read-only and changed fields (kept up to date while on). Returns { on }. */
export async function toggleHighlights({ toast } = {}) {
  if (state.highlightOn) {
    stopHighlight();
    toast?.info('Highlights cleared.');
    return { on: false };
  }
  const states = await applyHighlights();
  if (!states) throw new Error('No form is open on this page.');
  state.highlightOn = true;
  state.highlightTimer = setInterval(() => {
    applyHighlights()
      .then((next) => {
        if (!next) stopHighlight(); // the form is gone
      })
      .catch(() => {});
  }, REFRESH_MS);
  toast?.success(`Highlighting: ${highlightSummary(states)} Run it again to clear.`);
  return { on: true };
}

export function formToolsStatus() {
  return { hidden: state.hidden.size > 0, hiddenCount: state.hidden.size, highlight: state.highlightOn };
}

// --- Copy values ---------------------------------------------------------------------------------------------------------

/** Every field of the form with its full value, state and type (the bridge's model caps values, so values come from getFormValues). */
export async function readFormSnapshot() {
  const [model, valuesResult] = await Promise.all([callPage('getFormModel'), callPage('getFormValues').catch(() => null)]);
  if (!model) throw new Error('No form is open on this page.');
  const full = valuesResult?.values || {};
  const fields = (model.fields || []).map((f) => ({
    name: f.name,
    label: f.label || f.name,
    type: f.type || '',
    value: full[f.name] ?? f.value ?? '',
    display: f.display || '',
    mandatory: f.mandatory,
    readOnly: f.readOnly,
    visible: f.visible,
  }));
  return { table: model.table, sysId: model.sysId, isNewRecord: model.isNewRecord, fields };
}

const COPY_KINDS = {
  json: { label: 'JSON', build: (snap) => valuesJson(snap.fields) },
  markdown: { label: 'a Markdown table', build: (snap) => valuesMarkdown(snap.fields, { table: snap.table }) },
  script: { label: 'a "set values" script', build: (snap) => setValuesScript(snap.table, snap.fields) },
};

/** Copy the form's values as `json`, `markdown` or `script`. */
export async function copyFormValues(kind, { toast } = {}) {
  const spec = COPY_KINDS[kind];
  if (!spec) throw new Error(`Unknown format: ${kind}`);
  const snap = await readFormSnapshot();
  const text = spec.build(snap);
  if (!text) {
    toast?.info('The form has no values to copy.');
    return false;
  }
  await copyText(text);
  const filled = filledFields(snap.fields);
  const redacted = filled.filter(isSecretField).length;
  toast?.success(`Copied ${filled.length} field${filled.length === 1 ? '' : 's'} as ${spec.label}${redacted ? ` (${redacted} secret value${redacted === 1 ? '' : 's'} redacted)` : ''}.`);
  return true;
}

// --- Duplicate ------------------------------------------------------------------------------------------------------------

/** Open a new record of this table in a new tab, prefilled from the form. The user still presses Submit. */
export async function duplicateAsNew({ toast } = {}) {
  const snap = await readFormSnapshot();
  if (!snap.table) throw new Error('This page has no table to duplicate into.');
  const { url, included, skipped } = duplicateUrl(snap.table, snap.fields);
  if (!included.length) {
    toast?.info(`There is nothing to copy into a new ${snap.table} record.${skippedNote(skipped) ? ` ${skippedNote(skipped)}` : ''}`);
    return false;
  }
  navigate(url, { newTab: true });
  const note = skippedNote(skipped);
  toast?.success(`Opened a new ${snap.table} record with ${included.length} field${included.length === 1 ? '' : 's'} filled in (new tab). Nothing is saved until you submit.${note ? ` ${note}` : ''}`, { timeout: note ? 10000 : undefined });
  return true;
}

// --- Open as ------------------------------------------------------------------------------------------------------------

/** Open this record as `json` (REST), `xml`, or its `versions`, in a new tab. */
export async function openRecordAs(kind) {
  const meta = await callPage('getFormMeta').catch(() => null);
  if (!meta?.table) throw new Error('No form is open on this page.');
  if (kind === 'versions') {
    if (!/^[0-9a-f]{32}$/i.test(String(meta.sysId || ''))) throw new Error('Save the record first: it has no sys_id yet.');
    navigate(listUrl('sys_update_version', `name=${meta.table}_${meta.sysId}^ORDERBYDESCsys_recorded_at`), { newTab: true });
    return;
  }
  const { url, raw } = openAsUrl(kind, meta.table, meta.sysId);
  navigate(url, { newTab: true, raw });
}

// --- Menu ---------------------------------------------------------------------------------------------------------------

/**
 * Open the "Form tools" popover next to `anchor`. `popover` is the on-page popover (popover.js), `toast` the toast host.
 */
export function openFormToolsMenu(anchor, { popover, toast }) {
  const status = formToolsStatus();
  const act = (fn) => () => {
    popover.hide();
    Promise.resolve()
      .then(fn)
      .catch((err) => toast.error(errorText(err)));
  };
  const actions = [
    { label: status.hidden ? 'Hide the revealed fields' : 'Show hidden fields', primary: true, onClick: act(() => toggleHiddenFields({ toast })) },
    { label: status.highlight ? 'Clear highlights' : 'Highlight required / read-only / changed', onClick: act(() => toggleHighlights({ toast })) },
    { label: 'Copy as JSON', onClick: act(() => copyFormValues('json', { toast })) },
    { label: 'Copy as Markdown', onClick: act(() => copyFormValues('markdown', { toast })) },
    { label: 'Copy as script', onClick: act(() => copyFormValues('script', { toast })) },
    { label: 'Duplicate as new record', onClick: act(() => duplicateAsNew({ toast })) },
    { label: 'Open as JSON', onClick: act(() => openRecordAs('json')) },
    { label: 'Open as XML', onClick: act(() => openRecordAs('xml')) },
    { label: 'Versions', onClick: act(() => openRecordAs('versions')) },
  ];
  popover.show({
    anchor,
    title: 'Form tools',
    subtitle: 'Read-only: nothing here changes a value or saves the record',
    tone: 'info',
    body: 'Copies redact passwords and secrets. Duplicate opens a new tab; you press Submit there.',
    actions,
  });
}

/** Palette commands call these. */
export const formToolActions = { toggleHiddenFields, toggleHighlights, copyFormValues, duplicateAsNew, openRecordAs };

/** Remove everything this module drew (used when the on-page tools are switched off). */
export function clearFormTools() {
  restoreHidden();
  stopHighlight();
}
