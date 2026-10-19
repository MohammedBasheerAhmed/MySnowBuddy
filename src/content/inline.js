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
import { UI_HOST_ID } from './uiRoot.js';
import { isFieldPath, isSysId } from '../lib/xray.js';
import {
  dominantTable,
  isScriptColumn,
  isScriptLabel,
  fieldMenuModel,
  columnMenuModel,
  toolbarModel,
  toolbarKey,
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

const ATTR = 'data-msb-inline';
const STYLE_ID = 'msb-inline-style';
const OBSERVE_MS = 600;
const SCAN_MS = 1500;
const CONTEXT_MS = 2500;
const COLLAPSED_KEY = 'inlineBarCollapsed';
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
  seq: 0, // popover request counter: a slow answer must not overwrite a newer popover
};

const errorText = (err) => (err && err.message) || String(err);

// --- Page styles -------------------------------------------------------------------------------

// Fixed colours that read on light and dark ServiceNow themes: indigo text (#3040b8) on a pale
// lavender fill (#eceeff) is 6.8:1 and keeps its contrast whatever the page behind it is.
const PAGE_CSS = `
.msb-inl-wrap{all:initial;visibility:inherit!important;box-sizing:border-box!important;display:inline-flex!important;align-items:center;gap:3px;margin:0 0 0 6px!important;vertical-align:middle;white-space:nowrap}
.msb-inl-btn{all:initial;visibility:inherit!important;box-sizing:border-box!important;display:inline-flex!important;align-items:center;justify-content:center;min-width:19px;height:17px;padding:0 6px!important;border-radius:9px!important;border:1px solid #c9d2fb!important;background:#eceeff!important;color:#3040b8!important;font:600 10.5px/15px -apple-system,"Segoe UI",Roboto,Arial,sans-serif!important;letter-spacing:0!important;text-transform:none!important;cursor:pointer;user-select:none;white-space:nowrap}
.msb-inl-btn:hover{background:#dfe3ff!important;border-color:#7c3aed!important}
.msb-inl-btn--menu{font-weight:800!important;padding:0 5px!important}
.msb-inl-btn--col{margin:0 0 0 4px!important}
`;

function ensureStyle(doc) {
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

function openFieldMenu(anchor, { doc, table, field }) {
  const { popover, sidebar, openEditor } = state.deps;
  const script = isScriptColumn(field);
  const sysId = currentSysId();
  const label = `${table}.${field}`;

  const run = {
    copyName: () => copyWithToast(field, `field name ${field}`),
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
    edit: () => openEditor(),
    lint: () => lintPopover({ anchor, doc, table, label: field, read: () => readField(field) }),
    ask: async () => askAboutScript({ table, label: field, body: await readField(field).catch(() => '') }),
  };

  const actions = fieldMenuModel({ table, field, script }).map((item) => ({
    label: item.label,
    primary: item.id === 'copyName',
    onClick: () => {
      // Lint reuses the popover for its own answer; every other action closes it first.
      if (item.id !== 'lint') popover.hide();
      run[item.id]();
    },
  }));

  const base = { anchor, doc, title: field, subtitle: table, actions, tone: 'info' };
  const query = auditQuery(table, sysId, field);
  if (!query) {
    showMessage({ ...base, rows: [{ label: 'Last changed', value: sysId ? 'Not available for this field.' : 'Save the record to see its change history.' }] });
    return;
  }
  withPopover(base, async () => {
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
  };
  showMessage({
    anchor,
    doc,
    title: column,
    subtitle: `${table} column`,
    tone: 'info',
    actions: columnMenuModel({ table, column }).map((item) => ({
      label: item.label,
      primary: item.id === 'copyName',
      onClick: () => {
        popover.hide();
        run[item.id]();
      },
    })),
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
    wrap.appendChild(makeButton(doc, { text: '⋯', title: `${field}: copy name or value, dictionary entry, ACLs, last change`, className: 'msb-inl-btn--menu' }, (btn) => openFieldMenu(btn, { doc, table, field })));
    if (isScriptColumn(field)) {
      const strip = (text, title, fn) => wrap.appendChild(makeButton(doc, { text, title }, fn));
      strip('Edit', `Edit ${field} in the full-screen editor`, () => state.deps.openEditor());
      strip('Lint', `Lint ${field} (no AI tokens)`, (btn) => lintPopover({ anchor: btn, doc, table, label: field, read: () => readField(field) }));
      strip('AI', `Ask the AI to review ${field}`, async () => askAboutScript({ table, label: field, body: await readField(field).catch(() => '') }));
    }
    label.appendChild(wrap);
  });
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
    const title = th.querySelector('.list_header_cell_container a.column_head');
    if (title) title.after(btn);
    else th.appendChild(btn);
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
  if (!sysId) return;
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
    } catch {
      // The frame navigated away mid-scan.
    }
  });
}

function removeFromDocs() {
  const docs = new Set([...xrayDocuments(), ...state.observers.keys(), ...state.peekDocs.keys()]);
  docs.forEach((doc) => {
    try {
      doc.querySelectorAll(`[${ATTR}]`).forEach((node) => node.remove());
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
    case 'more':
      sidebar.openForTool?.();
      return sidebar.openQueryPanel();
    default:
      return toast.info('That action is not available here.');
  }
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
  bar.setAttribute('aria-label', 'MySnowBuddy page tools');
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
  model.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msb-bar__btn';
    btn.textContent = item.short;
    btn.title = item.label;
    btn.setAttribute('aria-label', item.label);
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
  const model = toolbarModel({ table: ctx.table || '', sysId: ctx.sysId || '', isList: Boolean(ctx.isList), hasScript: Boolean(ctx.scriptBody) && isScriptLabel(ctx.scriptFieldLabel) });
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

export function inlineStatus() {
  return { on: state.on, installed: state.installed };
}

/**
 * Top frame only. `enabled` is the user's setting; the toolbar and listeners stay dormant when off,
 * and toggleInline() can switch them on later.
 */
export function installInline({ shadow, toast, sidebar, popover, openEditor, tools = {}, enabled = true }) {
  if (state.installed) return;
  state.installed = true;
  state.deps = { toast, sidebar, popover, openEditor, tools: { lintScript, ...tools } };
  state.bar = buildToolbar(shadow);
  getUiState()
    .then((ui) => {
      state.collapsed = ui[COLLAPSED_KEY] === true;
      applyCollapsed();
    })
    .catch(() => {});
  applyCollapsed();
  if (enabled) enable();
  return { toggle: toggleInline, status: inlineStatus };
}

