import { callPage } from './pageBridge.js';
import { getSessionToken } from './sessionToken.js';
import { formDocuments } from './quickActions.js';
import { extractListFromUrl, parseTablePage } from '../lib/urlTarget.js';

// Content scripts run in an isolated world and cannot see window.g_ck, so the
// token comes through the page bridge (an extension-hosted script that survives
// the page's CSP), with a markup fallback.
export function getCsrfToken() {
  return getSessionToken();
}

// Heuristic field-name hints used to find the "script-like" field on a
// ServiceNow form (Business Rule / Script Include / Client Script / ACL).
// NOTE: these selectors are best-effort and should be validated/refined
// against a real ServiceNow dev instance — see docs/decisions.md.
const KNOWN_SCRIPT_FIELD_HINTS = ['script', 'condition', 'advanced', 'client_script'];

// Classic form inputs are named "<table>.<column>", so "sys_script_client.description" contains "script"
// through the TABLE name. Only the column part may be matched, and empty fields never win.
const NOT_SCRIPT_COLUMNS = new Set(['isolate_script', 'description', 'messages', 'comments', 'short_description']);
const columnOf = (el) => {
  const name = (el.name || el.id || '').toLowerCase();
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
};

/** Rank of a textarea as "the" script field of the form; 0 = not a script field. */
function scriptFieldRank(el) {
  const column = columnOf(el);
  if (NOT_SCRIPT_COLUMNS.has(column) || !el.value || !el.value.trim()) return 0;
  if (column === 'script' || column === 'operation_script') return 4;
  if (column.endsWith('_script') || column.startsWith('script_')) return 3;
  if (KNOWN_SCRIPT_FIELD_HINTS.some((hint) => column.includes(hint))) return 2;
  // A long value in a real form field (table-prefixed name) is still likely code; help-panel textareas are not.
  return (el.name || '').includes('.') && el.value.length > 40 ? 1 : 0;
}

/** The textarea most likely to hold the form's script, or null. Pure, so it can be tested without a page. */
export function pickScriptField(candidates) {
  let best = null;
  let bestRank = 0;
  for (const el of candidates) {
    const rank = scriptFieldRank(el);
    if (rank > bestRank) {
      best = el;
      bestRank = rank;
    }
  }
  return best;
}

function findScriptField() {
  return pickScriptField(formDocuments().flatMap((doc) => Array.from(doc.querySelectorAll('textarea'))));
}

/** URL of the page actually on screen: the classic content frame when present, else the top page. */
export function currentPageHref() {
  try {
    const frame = document.getElementById('gsft_main');
    const href = frame?.contentWindow?.location?.href;
    if (href && href !== 'about:blank') return href;
  } catch {
    // Cross-origin frame; fall back to the top URL.
  }
  return window.location.href;
}

// --- Selected text ----------------------------------------------------------
// Clicking a sidebar button can clear the page selection, so the last
// selection made on the page is remembered for a few minutes.

const SELECTION_TTL_MS = 5 * 60 * 1000;
let lastSelection = { text: '', at: 0 };
const trackedDocs = new WeakSet();

function readSelection(doc) {
  const active = doc.activeElement;
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
    try {
      if (active.selectionStart !== active.selectionEnd) {
        return active.value.slice(active.selectionStart, active.selectionEnd);
      }
    } catch {
      // Some input types do not support selection ranges.
    }
  }
  return doc.getSelection ? doc.getSelection().toString() : '';
}

function trackDocument(doc) {
  if (trackedDocs.has(doc)) return;
  trackedDocs.add(doc);
  const handler = (event) => {
    if (event.composedPath?.().some((node) => node.id === 'mysnowbuddy-root')) return;
    lastSelection = { text: readSelection(doc).slice(0, 50000), at: Date.now() };
  };
  doc.addEventListener('mouseup', handler, true);
  doc.addEventListener('keyup', handler, true);
}

/** Start remembering selections, including those inside the classic content frame. */
export function installSelectionTracking() {
  const attach = () => formDocuments().forEach(trackDocument);
  attach();
  setInterval(attach, 3000);
}

// Script editors (CodeMirror/Monaco) and shadow DOM hide the textarea from the DOM scan,
// so the form's own value is read through the page bridge and cached for the sync lookup.
const BRIDGED_SCRIPT_TTL_MS = 15000;
let bridgedScript = { body: null, label: null, at: 0 };

/** { body, label } of the most likely script field on the open form, or null. */
export async function readFormScript() {
  try {
    const fields = await callPage('getScriptFields');
    if (!Array.isArray(fields) || !fields.length) return null;
    const best =
      // An empty `script` (e.g. a client UI action's server script) must not hide a filled script field.
      fields.find((f) => f.name === 'script' && f.length > 0) ||
      fields.find((f) => /script/i.test(f.name) && f.length > 0) ||
      [...fields].sort((a, b) => b.length - a.length)[0];
    if (!best || !best.length) return null;
    const state = await callPage('getFieldState', [best.name]);
    if (!state?.value) return null;
    return { body: String(state.value), label: best.label || best.name };
  } catch {
    return null;
  }
}

export function startScriptWatcher() {
  const refresh = async () => {
    if (document.hidden) return;
    const found = await readFormScript();
    bridgedScript = found ? { ...found, at: Date.now() } : { body: null, label: null, at: 0 };
  };
  refresh();
  setInterval(refresh, 2500);
}

export function getSelectedText() {
  const live = formDocuments().map(readSelection).find(Boolean);
  if (live) return live;
  return Date.now() - lastSelection.at < SELECTION_TTL_MS ? lastSelection.text : '';
}

export function detectPageContext() {
  const href = currentPageHref();
  const url = new URL(href);
  const params = url.searchParams;
  const page = parseTablePage(href);

  const table = params.get('table') || page.table || null;

  const sysId =
    page.sysId ||
    formDocuments()
      .map((doc) => doc.querySelector('input[name="sys_uniqueValue"]')?.value)
      .find(Boolean) ||
    null;

  const scriptField = findScriptField();
  const bridged = !scriptField && Date.now() - bridgedScript.at < BRIDGED_SCRIPT_TTL_MS ? bridgedScript : null;

  return {
    table,
    sysId,
    isList: page.isList,
    selection: getSelectedText(),
    scriptBody: scriptField ? scriptField.value : bridged?.body || null,
    scriptFieldLabel: scriptField
      ? scriptField.getAttribute('aria-label') || scriptField.name || scriptField.id || null
      : bridged?.label || null,
  };
}

/** Table and encoded query of the list on screen, or null when the page is not a list. */
export async function detectListInfo() {
  const href = currentPageHref();
  const fromUrl = extractListFromUrl(href);

  let fromPage = null;
  try {
    fromPage = await callPage('getListInfo');
  } catch {
    // Bridge unavailable; the URL is enough for most lists.
  }

  const domQuery = formDocuments()
    .map((doc) => doc.querySelector('input[name="sysparm_query"]')?.value)
    .find((v) => typeof v === 'string');

  const table = fromPage?.table || fromUrl?.table || null;
  if (!table) return null;
  const query = fromPage?.query ?? domQuery ?? fromUrl?.query ?? '';
  return { table, query };
}
