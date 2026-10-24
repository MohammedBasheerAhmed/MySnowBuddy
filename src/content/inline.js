// On-page tools: answers where the thing lives, instead of in the sidebar.
//
//   1. A slim page toolbar (bottom centre) with the actions for the page on screen: record actions
//      on a form, filter actions on a list. It lives in the extension's shadow root, so it works on
//      every UI, including Next Experience workspaces whose forms cannot be reached.
//   2. Small buttons placed IN the classic page, the way X-ray places its chips: a menu on every
//      form field label (copy name or value, dictionary entry, ACLs, last change, X-ray), an extra
//      strip on script field labels (full-screen editor, lint, ask AI) and a menu on list column
//      headers. These need the classic DOM (labels `label.<table>.<field>`, `th[name]`), reached in
//      the page, the gsft_main frame and the Next Experience shell's classic frame via
//      xrayDocuments(). Native Next Experience forms are not reachable this way, exactly as with
//      X-ray; the toolbar covers them.
//   3. Selecting a sys_id on the page shows what it points to.
// Every answer is a popover (popover.js) next to what was clicked.
//
// Rules this file keeps: read-only (copy, navigate, queries) - nothing here writes to the instance;
// nothing is fetched until the user opens a menu or presses a button, apart from reading the page
// context; page-DOM elements carry data-msb-inline, are added once and removed on switch-off; every
// handler on a page-DOM element ignores events that did not come from a person (isTrusted), since a
// page script could otherwise click our buttons; nothing is built from HTML strings.

import { xrayDocuments, classicFormLabels } from './xray.js';
import { detectPageContext, detectListInfo, readFormScript } from './context.js';
import { callPage } from './pageBridge.js';
import { queryTable, countRecords } from './tableApi.js';
import { FORMATS, readList, getCopyFormat, copyRows, copyIds, openSelected, copyListLink, columnStats } from './listTools.js';
import {
  copyText,
  navigate,
  listUrl,
  recordUrl,
  xmlUrl,
  absoluteUrl,
  getRecordInfo,
  findRecordBySysId,
} from './quickActions.js';
import { fetchVersionList } from './versions.js';
import { getUiState, saveUiState } from './storage.js';
import { createIcon } from './icons.js';
import { lintScript, formatLintFindings } from '../lib/lint.js';
import { explainQuery, toGlideRecord } from '../lib/query.js';
import { redactSecrets } from '../providers/redact.js';
import { trustedDom } from '../sidebar/trusted.js';
import { anchorRect } from './popover.js';
import { openFormToolsMenu, clearFormTools } from './formTools.js';
import { handleSelection as handleSmartSelection, cancelSmartSelect } from './smartSelect.js';
import { UI_HOST_ID } from './uiRoot.js';
import { isFieldPath, isSysId } from '../lib/xray.js';
import { fetchTableFields } from './fieldInspector.js';
import {
  typeTagText,
  typeTagTitle,
  dominantTable,
  isScriptColumn,
  isScriptLabel,
  fieldMenuModel,
  fieldCode,
  columnMenuModel,
  toolbarModel,
  toolbarKey,
  breadcrumbQuery,
  dictionaryQuery,
  fieldAclQuery,
  auditQuery,
  recordInfoRows,
  lastChangeRows,
  auditErrorText,
  versionRows,
  lintSummary,
  sysIdFromSelection,
  truncate,
} from '../lib/inline.js';
import { visibleTo } from '../lib/roleTier.js';
import { whyMenuModel } from '../lib/panelLinks.js';

const ATTR = 'data-msb-inline';
const STYLE_ID = 'msb-inline-style';
const OBSERVE_MS = 600;
const SCAN_MS = 1500;
const CONTEXT_MS = 2500;
const COLLAPSED_KEY = 'inlineBarCollapsed';
const NAMES_KEY = 'inlineFieldNames';
const NAMES_ATTR = 'data-msb-names';
const MAX_SCRIPT_CHARS = 12000;

const state = {
  installed: false,
  on: false,
  deps: null,
  scanTimer: null,
  contextTimer: null,
  pending: null,
  observers: new Map(), // document -> MutationObserver
  peekDocs: new Map(), // document -> mouseup handler
  bar: null,
  barKey: '',
  ctx: null,
  collapsed: false,
  names: false, // show the database name next to every label and column title
  seq: 0, // popover request counter: a slow answer must not overwrite a newer popover
};

const errorText = (err) => (err && err.message) || String(err);

// --- Page styles -------------------------------------------------------------------------------

// Fixed colours that read on light and dark ServiceNow themes: green text (#14573f) on a pale
// green fill (#e4f3ec) is 7.6:1 and keeps its contrast whatever the page behind it is.
const PAGE_CSS = `
.msb-inl-wrap{all:initial;visibility:inherit!important;box-sizing:border-box!important;display:inline-flex!important;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:3px;max-width:100%;margin:0 0 0 6px!important;vertical-align:middle;white-space:nowrap}
.msb-inl-tail{all:initial;visibility:inherit!important;box-sizing:border-box!important;display:inline-flex!important;align-items:center;gap:3px;max-width:100%;min-width:0;white-space:nowrap}
.msb-inl-btn{all:initial;visibility:inherit!important;box-sizing:border-box!important;display:inline-flex!important;align-items:center;justify-content:center;min-width:19px;height:17px;padding:0 6px!important;border-radius:4px!important;border:1px solid #b5dccb!important;background:#e4f3ec!important;color:#14573f!important;font:600 10.5px/15px -apple-system,"Segoe UI",Roboto,Arial,sans-serif!important;letter-spacing:0!important;text-transform:none!important;cursor:pointer;user-select:none;white-space:nowrap;position:relative}
/* WCAG 2.2 target size: the pill stays 17px tall, the clickable area is 25px. */
.msb-inl-btn::after{content:"";position:absolute;inset:-4px -2px}
.msb-inl-btn:hover{background:#d3eadf!important;border-color:#1b6b4f!important}
.msb-inl-btn--menu{font-weight:800!important;padding:0 5px!important}
.msb-inl-btn--col{margin:0 0 0 4px!important}
/* Database names and column types: hidden until the user turns "Names" on (html[data-msb-names]). */
.msb-inl-btn--name{display:none!important;font:600 10.5px/15px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;background:#fff!important;border-style:dashed!important}
html[data-msb-names] .msb-inl-btn--name{display:inline-flex!important}
/* The type is read-only text, so it is a plain tag, not a button: dark grey on pale grey is 9.6:1 on any page theme. */
.msb-inl-type{all:initial;visibility:inherit!important;box-sizing:border-box!important;display:none!important;max-width:100%;height:17px;padding:0 6px!important;margin:0 0 0 3px!important;border-radius:4px!important;border:1px solid #d3d9df!important;background:#eef1f4!important;color:#2b343c!important;font:500 10.5px/15px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;letter-spacing:0!important;text-transform:none!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;user-select:text}
html[data-msb-names] .msb-inl-type:not(:empty){display:inline-block!important}
.msb-inl-tail .msb-inl-type{flex:0 1 auto;min-width:0}
`;

function applyNames(doc) {
  const root = doc.documentElement;
  if (!root) return;
  if (state.names) root.setAttribute(NAMES_ATTR, '');
  else root.removeAttribute(NAMES_ATTR);
}

function ensureStyle(doc) {
  applyNames(doc);
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute(ATTR, 'style');
  style.textContent = PAGE_CSS;
  (doc.head || doc.documentElement).appendChild(style);
}

function makeButton(doc, { text, title, className = '' }, onActivate) {
  const btn = doc.createElement('span');
  btn.setAttribute(ATTR, 'btn');
  btn.className = `msb-inl-btn ${className}`.trim();
  btn.setAttribute('role', 'button');
  btn.tabIndex = -1; // the toolbar is the keyboard path; these stay out of the form's tab order
  btn.setAttribute('title', title);
  btn.setAttribute('aria-label', title);
  btn.textContent = text;
  btn.addEventListener('mousedown', (event) => event.stopPropagation());
  btn.addEventListener('click', (event) => {
    if (event.isTrusted !== true) return; // a page script's btn.click()
    // The button sits inside a label or a sortable column header: no focus jump, no sort.
    event.preventDefault();
    event.stopPropagation();
    onActivate(btn);
  });
  return btn;
}

// --- Column types ----------------------------------------------------------------------------------
//
// With "Names" on, each database name carries a tag with the column's type ("string (160)", "reference → sys_user").
// The dictionary of a table is read once (one lookup per table, including the tables a dot-walk passes through) and only
// while Names is on; a list header's own glide_type is the fallback when the dictionary cannot be read.

const TYPE_RETRY_MS = 30000;
const dictionaries = new Map(); // table -> Promise<Map<column, field> | null>
const dictionaryFailedAt = new Map();

function dictionaryOf(table) {
  if (Date.now() - (dictionaryFailedAt.get(table) || 0) < TYPE_RETRY_MS) return Promise.resolve(null);
  if (!dictionaries.has(table)) {
    dictionaries.set(
      table,
      fetchTableFields(table)
        .then(({ fields }) => new Map(fields.map((field) => [field.name, field])))
        .catch(() => {
          // No access to the dictionary, or a slow instance: try again later, not on every scan.
          dictionaries.delete(table);
          dictionaryFailedAt.set(table, Date.now());
          return null;
        })
    );
  }
  return dictionaries.get(table);
}

/** The dictionary entry of a column, following a dot-walk through its reference fields; null when it cannot be found. */
async function columnDefinition(table, path) {
  const parts = String(path).split('.');
  let current = table;
  for (let i = 0; i < parts.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- each step needs the table the previous one pointed at.
    const field = (await dictionaryOf(current))?.get(parts[i]);
    if (!field) return null;
    if (i === parts.length - 1) return { ...field, table: current };
    if (!field.reference) return null;
    current = field.reference;
  }
  return null;
}

function makeTypeTag(doc, { table, path, glideType = '' }) {
  const tag = doc.createElement('span');
  tag.setAttribute(ATTR, 'type');
  tag.className = 'msb-inl-type';
  tag.dataset.msbTable = table;
  tag.dataset.msbPath = path;
  tag.dataset.msbGlide = glideType;
  return tag;
}

/** Fill the type tags of a document that have no text yet. Does nothing while Names is off: nothing is read until it is on. */
async function fillTypes(doc) {
  if (!state.names) return;
  const tags = [...doc.querySelectorAll(`[${ATTR}="type"]:not([data-msb-done])`)];
  tags.forEach((tag) => tag.setAttribute('data-msb-done', '1'));
  for (const tag of tags) {
    const { msbTable: table, msbPath: path, msbGlide: glide } = tag.dataset;
    // eslint-disable-next-line no-await-in-loop -- the first column of a table loads its dictionary, the rest read the cache.
    const field = await columnDefinition(table, path).catch(() => null);
    const known = field || (glide ? { type: glide } : null);
    const text = typeTagText(known);
    if (!text) {
      // Not resolved (yet): let the next scan try again after the retry delay, unless the page has nothing to say.
      if (!glide) tag.removeAttribute('data-msb-done');
      continue;
    }
    tag.textContent = text;
    tag.setAttribute('title', field ? typeTagTitle(path, field, field.table) : `${path}: ${text}`);
  }
}

// --- Popover helpers -----------------------------------------------------------------------------

/** Open a popover busy, fill it when `load` resolves; an answer that arrives after a newer popover is dropped. */
async function withPopover(base, load) {
  const { popover } = state.deps;
  const mine = (state.seq += 1);
  popover.show({ ...base, busy: true });
  try {
    const patch = await load();
    if (mine === state.seq && popover.isOpen()) popover.update({ busy: false, ...patch });
  } catch (err) {
    if (mine === state.seq && popover.isOpen()) popover.update({ busy: false, tone: 'danger', body: errorText(err) });
  }
}

function showMessage(base) {
  state.seq += 1;
  state.deps.popover.show(base);
}

async function copyWithToast(text, what) {
  try {
    await copyText(text);
    state.deps.toast.success(`Copied ${what}`);
  } catch (err) {
    state.deps.toast.error(errorText(err));
  }
}

function openInNewTab(url) {
  navigate(url, { newTab: true });
}

// --- Script actions (shared by the toolbar and the script field strip) -------------------------------

function scriptPrompt(table, label, body) {
  return (
    `Review this ServiceNow ${table || 'record'} script (${label}). Point out bugs, security and performance problems, ` +
    `and anything that will break on upgrade, then suggest concrete fixes.\n\n\`\`\`javascript\n${redactSecrets(body).slice(0, MAX_SCRIPT_CHARS)}\n\`\`\``
  );
}

async function readField(field) {
  const found = await callPage('getFieldState', [field]);
  return found?.value == null ? '' : String(found.value);
}

function lintBody(body, table) {
  const findings = state.deps.tools.lintScript(body, { table });
  return { findings, ...lintSummary(findings), body: formatLintFindings(findings) };
}

function lintPopover({ anchor, doc, table, label, read }) {
  withPopover({ anchor, doc, title: 'Lint', subtitle: label, tone: 'info' }, async () => {
    const body = await read();
    if (!body || !body.trim()) return { subtitle: `${label} is empty.`, tone: 'info' };
    const result = lintBody(body, table);
    return {
      tone: result.tone,
      subtitle: `${label}: ${result.subtitle}`,
      body: result.body,
      actions: [
        {
          label: 'Ask AI to review',
          primary: true,
          onClick: () => {
            state.deps.popover.hide();
            state.deps.sidebar.sendPrompt(`Review ${label}`, scriptPrompt(table, label, body));
          },
        },
      ],
    };
  });
}

function askAboutScript({ table, label, body }) {
  if (!body || !body.trim()) {
    state.deps.toast.info('That script is empty.');
    return;
  }
  state.deps.sidebar.sendPrompt(`Review ${label}`, scriptPrompt(table, label, body));
}

// --- Field and column menus ------------------------------------------------------------------------

function currentSysId() {
  const id = detectPageContext()?.sysId;
  return isSysId(id) ? id : '';
}

/** The open record's sys_id from the form itself: a record opened by number or query has none in its URL. */
async function formSysId() {
  const known = currentSysId();
  if (known) return known;
  const meta = await callPage('getFormMeta').catch(() => null);
  return isSysId(meta?.sysId) ? meta.sysId : '';
}

/**
 * Where a form field sits, in top-window coordinates, for the in-place editor. The control is found again on
 * every call (the form re-renders it); null while it is gone or has no size.
 */
function fieldPlace(doc, table, field) {
  // Releases draw the script field with Monaco, CodeMirror or a plain textarea; Monaco also keeps a 1px
  // textarea for input, so take the first candidate that is a real, visible box.
  const CANDIDATES = '.monaco-editor, .CodeMirror, .ace_editor, textarea';
  const find = () => {
    const wrap = doc.getElementById(`element.${table}.${field}`);
    const sized = (el) => {
      const box = el.getBoundingClientRect();
      return box.width >= 80 && box.height >= 24;
    };
    return (
      (wrap && [...wrap.querySelectorAll(CANDIDATES)].find(sized)) ||
      (() => {
        const input = doc.getElementById(`${table}.${field}`);
        return input && sized(input) ? input : null;
      })() ||
      wrap
    );
  };
  return {
    rect: () => {
      try {
        const el = find();
        if (!el || !el.isConnected) return null;
        const rect = anchorRect(el, doc);
        return rect.width > 0 && rect.height > 0 ? rect : null;
      } catch {
        return null; // the frame navigated away
      }
    },
  };
}

function editInPlace(doc, table, field) {
  const place = fieldPlace(doc, table, field);
  if (!place.rect()) {
    state.deps.toast.info('That field is not visible on the form. Opening the full-screen editor.');
    return state.deps.openEditor({ field });
  }
  return state.deps.openEditor({ field, place });
}

/**
 * Open the script editor over the script field on this form (the field called `script` first). Returns false when no
 * script field is visible in a classic document, so the caller can fall back to the full-screen editor.
 */
export function editScriptInPlace() {
  if (!state.installed || !state.deps) return false;
  for (const doc of xrayDocuments()) {
    try {
      const labels = classicFormLabels(doc);
      const table = dominantTable(labels.map((entry) => entry.parsed.table));
      const fields = labels
        .filter(({ parsed }) => parsed.table === table && isScriptColumn(parsed.field))
        .map(({ parsed }) => parsed.field)
        .sort((a, b) => (a === 'script' ? -1 : b === 'script' ? 1 : 0));
      for (const field of fields) {
        const place = fieldPlace(doc, table, field);
        if (place.rect()) {
          state.deps.openEditor({ field, place });
          return true;
        }
      }
    } catch {
      // The frame navigated away.
    }
  }
  return false;
}

function openFieldMenu(anchor, { doc, table, field }) {
  const { popover, sidebar, openEditor } = state.deps;
  const script = isScriptColumn(field);
  const label = `${table}.${field}`;

  const run = {
    copyName: () => copyWithToast(field, `field name ${field}`),
    copyClient: () => copyWithToast(fieldCode('client', field), `g_form call for ${field}`),
    copyServer: () => copyWithToast(fieldCode('server', field), `GlideRecord call for ${field}`),
    copyValue: async () => {
      try {
        await copyText(await readField(field));
        state.deps.toast.success(`Copied value of ${field}`);
      } catch (err) {
        state.deps.toast.error(errorText(err));
      }
    },
    dictionary: () => openInNewTab(listUrl('sys_dictionary', dictionaryQuery(table, field))),
    acls: () => openInNewTab(listUrl('sys_security_acl', fieldAclQuery(table, field))),
    xray: () => {
      // X-ray's details live in the sidebar panel; openPanel is absent or false when the sidebar is off.
      if (!sidebar.openPanel?.('xray', { args: field })) state.deps.toast.info('Turn on the sidebar in Options to see X-ray details.');
    },
    editHere: () => editInPlace(doc, table, field),
    edit: () => openEditor({ field, fullScreen: true }),
    lint: () => lintPopover({ anchor, doc, table, label: field, read: () => readField(field) }),
    ask: async () => askAboutScript({ table, label: field, body: await readField(field).catch(() => '') }),
  };

  const actions = visibleTo(state.deps.roleAccess?.tier() ?? null, fieldMenuModel({ table, field, script })).map((item) => ({
    label: item.label,
    primary: item.id === 'copyName',
    onClick: () => {
      // Lint reuses the popover for its own answer; every other action closes it first.
      if (item.id !== 'lint') popover.hide();
      run[item.id]();
    },
  }));

  const base = { anchor, doc, title: field, subtitle: table, actions, tone: 'info' };
  withPopover(base, async () => {
    const sysId = await formSysId();
    const query = auditQuery(table, sysId, field);
    if (!query) return { rows: [{ label: 'Last changed', value: sysId ? 'Not available for this field.' : 'Save the record to see its change history.' }] };
    try {
      const rows = await queryTable('sys_audit', query, ['sys_created_on', 'sys_created_by', 'oldvalue', 'newvalue'], { limit: 1 });
      return { rows: lastChangeRows(rows[0], field) };
    } catch (err) {
      return { rows: [{ label: 'Last changed', value: auditErrorText(err) }] };
    }
  });
}

function openColumnMenu(anchor, { doc, table, column }) {
  const { popover } = state.deps;
  const run = {
    copyName: () => copyWithToast(column, `column name ${column}`),
    dictionary: () => openInNewTab(listUrl('sys_dictionary', dictionaryQuery(table, column))),
    acls: () => openInNewTab(listUrl('sys_security_acl', fieldAclQuery(table, column))),
    distinct: () => showDistinct(anchor, doc, column),
    countBy: () => {
      state.deps.sidebar.openForTool?.();
      if (!state.deps.sidebar.openPanel?.('insight', { args: column })) state.deps.toast.info('Turn on the sidebar in Options to see this panel.');
    },
  };
  showMessage({
    anchor,
    doc,
    title: column,
    subtitle: `${table} column`,
    tone: 'info',
    actions: visibleTo(state.deps.roleAccess?.tier() ?? null, columnMenuModel({ table, column })).map((item) => ({
      label: item.label,
      primary: item.id === 'copyName',
      onClick: () => {
        // Distinct values replaces this popover with its own answer; every other action closes it first.
        if (item.id !== 'distinct') popover.hide();
        run[item.id]();
      },
    })),
  });
}

/** Count of each value in one column of the rows on screen, most common first; Copy puts a value on the clipboard. */
function showDistinct(anchor, doc, column) {
  const stats = columnStats(column);
  if (!stats) {
    showMessage({ anchor, doc, title: column, tone: 'warn', body: 'This column is not in the list rows on screen.' });
    return;
  }
  const { result } = stats;
  showMessage({
    anchor,
    doc,
    title: `${stats.label}: values`,
    subtitle: `${result.distinct} distinct in ${result.total} visible ${result.total === 1 ? 'row' : 'rows'}`,
    tone: 'info',
    rows: result.top.map((t) => ({ label: `${t.count}×`, value: t.value, copy: !t.empty })),
    body: result.more ? `+ ${result.more} more values not shown` : '',
  });
}

/** The toolbar's Copy rows menu: format choice (the last one is highlighted), sys_ids, open ticked rows, link. */
async function openRowsMenu(anchor) {
  const { popover, toast } = state.deps;
  const list = readList();
  if (!list) {
    showMessage({ anchor, title: 'No list found', tone: 'warn', body: 'Open a classic list first. Next Experience lists cannot be read from the page.' });
    return;
  }
  const ticked = list.model.rows.filter((r) => r.selected).length;
  const total = list.model.rows.length;
  const remembered = await getCopyFormat();
  const run = (fn) => () => {
    popover.hide();
    Promise.resolve(fn()).catch((err) => toast.error(errorText(err)));
  };
  showMessage({
    anchor,
    title: 'Copy rows',
    subtitle: ticked ? `${ticked} ticked of ${total} rows` : `${total} rows on screen. Tick rows to copy only those`,
    tone: 'info',
    actions: [
      ...FORMATS.map((f) => ({ label: `Copy as ${f.short}`, primary: f.id === remembered, onClick: run(() => copyRows({ toast, format: f.id })) })),
      { label: 'Copy sys_ids', onClick: run(() => copyIds({ toast })) },
      { label: 'sys_ids as JS array', onClick: run(() => copyIds({ toast, kind: 'array' })) },
      { label: ticked ? `Open ${Math.min(ticked, 8)} in tabs` : 'Open ticked rows', onClick: run(() => openSelected({ toast })) },
      { label: 'Copy link to this list', onClick: run(() => copyListLink({ toast })) },
    ],
  });
}

// --- Annotation of classic documents ---------------------------------------------------------------

function annotateForm(doc) {
  const labels = classicFormLabels(doc);
  if (!labels.length) return;
  // Related lists and embedded forms add labels of other tables; the form's own table is the majority.
  const table = dominantTable(labels.map((entry) => entry.parsed.table));
  labels.forEach(({ label, parsed }) => {
    if (parsed.table !== table || label.querySelector(`[${ATTR}]`)) return;
    const { field } = parsed;
    const wrap = doc.createElement('span');
    wrap.setAttribute(ATTR, 'wrap');
    wrap.className = 'msb-inl-wrap';
    wrap.appendChild(makeButton(doc, { text: field, title: `${field}: click to copy the database name`, className: 'msb-inl-btn--name' }, () => copyWithToast(field, `field name ${field}`)));
    // The label column is narrow: when the pills do not fit on one line the type and the menu wrap together, not one by one.
    const tail = doc.createElement('span');
    tail.setAttribute(ATTR, 'tail');
    tail.className = 'msb-inl-tail';
    tail.appendChild(makeTypeTag(doc, { table, path: field }));
    tail.appendChild(makeButton(doc, { text: '⋯', title: `${field}: copy name or value, dictionary entry, ACLs, last change`, className: 'msb-inl-btn--menu' }, (btn) => openFieldMenu(btn, { doc, table, field })));
    wrap.appendChild(tail);
    if (isScriptColumn(field)) {
      const strip = (text, title, fn) => wrap.appendChild(makeButton(doc, { text, title }, fn));
      strip('Edit', `Edit ${field} right here, over the field (changes flow to the form as you type)`, () => editInPlace(doc, table, field));
      strip('Lint', `Lint ${field} (no AI tokens)`, (btn) => lintPopover({ anchor: btn, doc, table, label: field, read: () => readField(field) }));
      strip('AI', `Ask the AI to review ${field}`, async () => askAboutScript({ table, label: field, body: await readField(field).catch(() => '') }));
    }
    label.appendChild(wrap);
  });
  fillTypes(doc).catch(() => {});
}

function annotateList(doc) {
  const fallbackTable = detectPageContext()?.table || '';
  doc.querySelectorAll('th[name]').forEach((th) => {
    const column = th.getAttribute('name');
    if (!isFieldPath(column) || th.querySelector(`[${ATTR}]`)) return;
    const table = th.closest('table')?.getAttribute('glide_table') || fallbackTable;
    if (!table) return;
    const btn = makeButton(doc, { text: '⋯', title: `${column}: copy name, dictionary entry, ACLs`, className: 'msb-inl-btn--menu msb-inl-btn--col' }, (b) => openColumnMenu(b, { doc, table, column }));
    // Current releases wrap the title, sort icon and their own ⋮ menu in a flex container; a button placed after it
    // lands under the next column's resize handle. Beside the title it stays clickable.
    const nameBtn = makeButton(doc, { text: column, title: `${column}: click to copy the database name`, className: 'msb-inl-btn--name msb-inl-btn--col' }, () => copyWithToast(column, `column name ${column}`));
    const typeTag = makeTypeTag(doc, { table, path: column, glideType: th.getAttribute('glide_type') || '' });
    const title = th.querySelector('.list_header_cell_container a.column_head');
    if (title) title.after(nameBtn, typeTag, btn);
    else th.append(nameBtn, typeTag, btn);
  });
  fillTypes(doc).catch(() => {});
}

/** A "Copy query" button beside each list's filter breadcrumb, so the encoded query is one click away. */
function annotateBreadcrumbs(doc) {
  doc.querySelectorAll('span.breadcrumb_container[table]').forEach((crumbs) => {
    if (crumbs.nextElementSibling?.hasAttribute(ATTR)) return;
    const query = breadcrumbQuery({
      fixedQuery: crumbs.getAttribute('fixed_query') || '',
      filters: [...crumbs.querySelectorAll('a.breadcrumb_link')].map((a) => a.getAttribute('filter') || ''),
    });
    const wrap = doc.createElement('span');
    wrap.setAttribute(ATTR, 'wrap');
    wrap.className = 'msb-inl-wrap';
    wrap.appendChild(
      makeButton(doc, { text: 'Copy query', title: 'Copy the encoded query of this filter' }, () =>
        copyWithToast(query, query ? 'encoded query' : 'an empty query (the list has no filter)')
      )
    );
    crumbs.after(wrap);
  });
}

// --- sys_id peek -------------------------------------------------------------------------------------

function selectedText(doc) {
  const active = doc.activeElement;
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
    try {
      if (active.selectionStart !== active.selectionEnd) return active.value.slice(active.selectionStart, active.selectionEnd);
    } catch {
      // Some input types do not support selection ranges.
    }
  }
  return doc.getSelection ? doc.getSelection().toString() : '';
}

function peekSysId(event, doc) {
  if (event.isTrusted !== true) return;
  if ((event.composedPath?.() || []).some((n) => n?.id === UI_HOST_ID || n?.dataset?.msbInline)) return;
  const sysId = sysIdFromSelection(selectedText(doc));
  if (!sysId) {
    // Anything else worth a look (JSON, Base64, a timestamp, a table name ...): smartSelect.js decides and stays quiet when unsure.
    handleSmartSelection({ event, doc, popover: state.deps.popover, toast: state.deps.toast });
    return;
  }
  const anchor = { x: event.clientX, y: event.clientY };
  withPopover({ anchor, doc, title: 'sys_id', subtitle: sysId, tone: 'info' }, async () => {
    const found = await findRecordBySysId(sysId, detectPageContext()?.table || '');
    if (!found) {
      return { tone: 'warn', rows: [{ label: 'sys_id', value: sysId, mono: true, copy: true }], body: 'Not found in sys_metadata, task, sys_user or cmdb_ci, or your user cannot read it.' };
    }
    return {
      title: found.name || found.table,
      rows: [
        { label: 'Table', value: found.table, mono: true },
        { label: 'sys_id', value: sysId, mono: true, copy: true },
      ],
      actions: [
        { label: 'Open', primary: true, onClick: () => navigate(recordUrl(found.table, sysId)) },
        { label: 'Open in new tab', onClick: () => openInNewTab(recordUrl(found.table, sysId)) },
      ],
    };
  });
}

function attachPeek(doc) {
  if (state.peekDocs.has(doc)) return;
  const handler = (event) => peekSysId(event, doc);
  state.peekDocs.set(doc, handler);
  doc.addEventListener('mouseup', handler, true);
}

// --- Scan loop ------------------------------------------------------------------------------------------

function ownMutation(mutation) {
  if (mutation.target?.closest?.(`[${ATTR}]`)) return true;
  const added = [...mutation.addedNodes];
  return added.length > 0 && added.every((n) => n.nodeType === 1 && n.hasAttribute?.(ATTR));
}

function observe(doc) {
  if (state.observers.has(doc) || !doc.defaultView) return;
  const observer = new doc.defaultView.MutationObserver((mutations) => {
    if (mutations.every(ownMutation)) return;
    schedule();
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  state.observers.set(doc, observer);
}

function schedule() {
  if (!state.on || state.pending) return;
  state.pending = setTimeout(() => {
    state.pending = null;
    scan();
  }, OBSERVE_MS);
}

function scan() {
  if (!state.on) return;
  for (const [doc, observer] of state.observers) {
    if (doc.defaultView) continue; // its frame navigated away
    observer.disconnect();
    state.observers.delete(doc);
    state.peekDocs.delete(doc);
  }
  xrayDocuments().forEach((doc) => {
    try {
      ensureStyle(doc);
      observe(doc);
      attachPeek(doc);
      annotateForm(doc);
      annotateList(doc);
      annotateBreadcrumbs(doc);
    } catch {
      // The frame navigated away mid-scan.
    }
  });
}

function removeFromDocs() {
  cancelSmartSelect();
  const docs = new Set([...xrayDocuments(), ...state.observers.keys(), ...state.peekDocs.keys()]);
  docs.forEach((doc) => {
    try {
      doc.querySelectorAll(`[${ATTR}]`).forEach((node) => node.remove());
      doc.documentElement?.removeAttribute(NAMES_ATTR);
    } catch {
      // The frame is gone.
    }
  });
  state.peekDocs.forEach((handler, doc) => {
    try {
      doc.removeEventListener('mouseup', handler, true);
    } catch {
      // The frame is gone.
    }
  });
  state.peekDocs.clear();
  state.observers.forEach((observer) => observer.disconnect());
  state.observers.clear();
}

// --- Page toolbar ------------------------------------------------------------------------------------------

function toolbarAction(id, anchor) {
  const { sidebar, openEditor, toast } = state.deps;
  const ctx = detectPageContext();
  const { table, sysId } = ctx;
  const base = { anchor, tone: 'info' };

  switch (id) {
    case 'copySysId':
      return copyWithToast(sysId, 'sys_id');
    case 'copyLink':
      return copyWithToast(absoluteUrl(recordUrl(table, sysId)), 'record link');
    case 'xml':
      return navigate(xmlUrl(table, sysId), { newTab: true, raw: true });
    case 'info':
      return withPopover({ ...base, title: 'Record info', subtitle: table }, async () => {
        const info = await getRecordInfo(table, sysId);
        return info ? { rows: recordInfoRows(info) } : { tone: 'warn', body: 'Could not read this record.' };
      });
    case 'versions':
      return withPopover({ ...base, title: 'Recent versions', subtitle: `${table} ${sysId.slice(0, 8)}…` }, async () => {
        const versions = await fetchVersionList(table, sysId, { limit: 6 });
        return {
          rows: versions.length ? versionRows(versions) : [{ label: 'Versions', value: 'None recorded for this record.' }],
          actions: [
            {
              label: 'Compare versions',
              primary: true,
              onClick: () => {
                state.deps.popover.hide();
                sidebar.openForTool?.();
                sidebar.openVersionPanel();
              },
            },
            { label: 'Open the list', onClick: () => openInNewTab(listUrl('sys_update_version', `name=${table}_${sysId}^ORDERBYDESCsys_recorded_at`)) },
          ],
        };
      });
    case 'copyRows':
      return openRowsMenu(anchor);
    case 'names':
      return toggleFieldNames();
    case 'formtools':
      return openFormToolsMenu(anchor, { popover: state.deps.popover, toast });
    case 'edit':
      return openEditor();
    case 'lint':
      return lintPopover({
        anchor,
        table,
        label: ctx.scriptFieldLabel || 'script',
        read: async () => (await readFormScript())?.body || ctx.scriptBody || '',
      });
    case 'ask':
      return readFormScript().then((found) => askAboutScript({ table, label: found?.label || 'script', body: found?.body || ctx.scriptBody || '' }));
    case 'explain':
    case 'count':
    case 'copyQuery':
    case 'copyGlide':
      return listAction(id, anchor);
    case 'why':
      return openWhyMenu(anchor, table);
    case 'insight':
    case 'refs':
      sidebar.openForTool?.();
      if (!sidebar.openPanel?.(id)) toast.info('Turn on the sidebar in Options to see this panel.');
      return undefined;
    case 'more':
      sidebar.openForTool?.();
      return sidebar.openQueryPanel();
    default:
      return toast.info('That action is not available here.');
  }
}

/** The ticket toolbar's Why? menu: each entry opens a panel on the record on screen. The role filter applies to the entries. */
function openWhyMenu(anchor, table) {
  const { popover, sidebar, toast, roleAccess } = state.deps;
  const entries = visibleTo(roleAccess?.tier() ?? null, whyMenuModel());
  const open = (panel) => () => {
    popover.hide();
    sidebar.openForTool?.();
    if (!sidebar.openPanel?.(panel)) toast.info('Turn on the sidebar in Options to see this panel.');
  };
  showMessage({
    anchor,
    title: 'Why?',
    subtitle: `Ask about this ${table || 'record'}`,
    tone: 'info',
    actions: entries.map((entry, i) => ({ label: entry.label, primary: i === 0, onClick: open(entry.panel) })),
  });
}

async function listAction(id, anchor) {
  const base = { anchor, tone: 'info' };
  const list = await detectListInfo().catch(() => null);
  if (!list) {
    showMessage({ ...base, title: 'No list found', tone: 'warn', body: 'Could not read the table and filter of this list.' });
    return;
  }
  const { table, query } = list;
  if (id === 'copyQuery') return copyWithToast(query || '', query ? 'encoded query' : 'an empty query (the list has no filter)');
  if (id === 'explain') {
    return showMessage({
      ...base,
      title: 'This filter, in words',
      subtitle: table,
      body: explainQuery(query, { table }),
      actions: [{ label: 'Copy encoded query', onClick: () => copyWithToast(query || '', 'encoded query') }],
    });
  }
  if (id === 'copyGlide') {
    const code = toGlideRecord(table, query);
    return showMessage({ ...base, title: 'GlideRecord code', subtitle: table, body: code, actions: [{ label: 'Copy', primary: true, onClick: () => copyWithToast(code, 'GlideRecord code') }] });
  }
  return withPopover({ ...base, title: 'Matching records', subtitle: table }, async () => {
    const total = await countRecords(table, query);
    return {
      rows: [
        { label: 'Count', value: total.toLocaleString() },
        { label: 'Filter', value: truncate(query || '(none)', 160), mono: true },
      ],
    };
  });
}

function buildToolbar(shadow) {
  const bar = document.createElement('div');
  bar.className = 'msb-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'NowBuddy page tools');
  bar.hidden = true;

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'msb-bar__handle';
  handle.appendChild(createIcon('tools', 15));
  handle.addEventListener(
    'click',
    trustedDom(() => {
      state.collapsed = !state.collapsed;
      applyCollapsed();
      saveUiState({ [COLLAPSED_KEY]: state.collapsed }).catch(() => {});
    })
  );

  const items = document.createElement('div');
  items.className = 'msb-bar__items';
  bar.append(handle, items);
  shadow.appendChild(bar);
  return bar;
}

function applyCollapsed() {
  const bar = state.bar;
  bar.classList.toggle('msb-bar--collapsed', state.collapsed);
  const handle = bar.querySelector('.msb-bar__handle');
  handle.setAttribute('aria-expanded', String(!state.collapsed));
  handle.title = state.collapsed ? 'Show page tools' : 'Hide page tools';
  handle.setAttribute('aria-label', handle.title);
}

function renderToolbar(model) {
  const bar = state.bar;
  bar.hidden = !state.on || !model.length;
  const items = bar.querySelector('.msb-bar__items');
  items.replaceChildren();
  let lastGroup = null;
  model.forEach((item) => {
    if (lastGroup !== null && item.group !== lastGroup) {
      const sep = document.createElement('span');
      sep.className = 'msb-bar__sep';
      sep.setAttribute('role', 'separator');
      sep.setAttribute('aria-orientation', 'vertical');
      items.appendChild(sep);
    }
    lastGroup = item.group;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msb-bar__btn';
    btn.textContent = item.short;
    btn.title = item.label;
    // The accessible name must contain the visible text (WCAG 2.5.3), so lead with it when the label does not.
    btn.setAttribute('aria-label', item.label.toLowerCase().startsWith(item.short.toLowerCase()) ? item.label : `${item.short}: ${item.label}`);
    if (item.toggle) {
      btn.dataset.msbToggle = item.id;
      btn.setAttribute('aria-pressed', String(state.names));
    }
    btn.addEventListener(
      'click',
      trustedDom(() => {
        Promise.resolve(toolbarAction(item.id, btn)).catch((err) => {
          showMessage({ anchor: btn, title: 'Something went wrong', tone: 'danger', body: errorText(err) });
        });
      })
    );
    items.appendChild(btn);
  });
  applyCollapsed();
}

function refreshContext() {
  if (!state.on) return;
  let ctx;
  try {
    ctx = detectPageContext();
  } catch {
    return; // mid-navigation
  }
  state.ctx = ctx;
  const model = visibleTo(state.deps.roleAccess?.tier() ?? null, toolbarModel({ table: ctx.table || '', sysId: ctx.sysId || '', isList: Boolean(ctx.isList), hasScript: Boolean(ctx.scriptBody) && isScriptLabel(ctx.scriptFieldLabel) }));
  const key = toolbarKey(model);
  if (key === state.barKey) return;
  state.barKey = key;
  renderToolbar(model);
}

// --- Switch on and off -----------------------------------------------------------------------------------------

function enable() {
  if (state.on) return;
  state.on = true;
  state.barKey = '';
  scan();
  state.scanTimer = setInterval(scan, SCAN_MS);
  state.contextTimer = setInterval(refreshContext, CONTEXT_MS);
  refreshContext();
}

function disable() {
  if (!state.on) return;
  state.on = false;
  clearInterval(state.scanTimer);
  clearInterval(state.contextTimer);
  clearTimeout(state.pending);
  state.pending = null;
  clearFormTools();
  removeFromDocs();
  state.bar.hidden = true;
  state.deps.popover.hide();
}

/** Switch the on-page tools on or off (no argument toggles). Returns the new status. */
export function toggleInline(force) {
  if (!state.installed) return { on: false };
  const next = typeof force === 'boolean' ? force : !state.on;
  if (next) enable();
  else disable();
  return inlineStatus();
}

/** Show or hide the database name beside every label and column title (no argument toggles). */
export function toggleFieldNames(force) {
  if (!state.installed) return { names: false };
  state.names = typeof force === 'boolean' ? force : !state.names;
  xrayDocuments().forEach((doc) => {
    try {
      applyNames(doc);
      // The types are read now, not before: nothing is fetched for a page whose names were never asked for.
      if (state.names && state.on) fillTypes(doc).catch(() => {});
    } catch {
      // The frame navigated away.
    }
  });
  state.bar?.querySelectorAll('[data-msb-toggle="names"]').forEach((btn) => btn.setAttribute('aria-pressed', String(state.names)));
  saveUiState({ [NAMES_KEY]: state.names }).catch(() => {});
  if (state.on) state.deps.toast.info(state.names ? 'Showing database names and column types. Click a name to copy it.' : 'Database names and types hidden.');
  else state.deps.toast.info('Turn on the on-page tools to see database names and types.');
  return inlineStatus();
}

export function inlineStatus() {
  return { on: state.on, installed: state.installed, names: state.names };
}

/**
 * Top frame only. `enabled` is the user's setting; the toolbar and listeners stay dormant when off,
 * and toggleInline() can switch them on later.
 */
export function installInline({ shadow, toast, sidebar, popover, openEditor, tools = {}, roleAccess = null, enabled = true }) {
  if (state.installed) return;
  state.installed = true;
  state.deps = { toast, sidebar, popover, openEditor, roleAccess, tools: { lintScript, ...tools } };
  // The roles arrive after the first paint: rebuild the toolbar when the tier is known or changes.
  roleAccess?.onChange(() => {
    state.barKey = '';
    refreshContext();
  });
  state.bar = buildToolbar(shadow);
  getUiState()
    .then((ui) => {
      state.collapsed = ui[COLLAPSED_KEY] === true;
      state.names = ui[NAMES_KEY] === true;
      applyCollapsed();
      xrayDocuments().forEach((doc) => {
        try {
          if (state.on) applyNames(doc);
        } catch {
          // The frame navigated away.
        }
      });
      state.bar?.querySelectorAll('[data-msb-toggle="names"]').forEach((btn) => btn.setAttribute('aria-pressed', String(state.names)));
    })
    .catch(() => {});
  applyCollapsed();
  if (enabled) enable();
  return { toggle: toggleInline, status: inlineStatus };
}

