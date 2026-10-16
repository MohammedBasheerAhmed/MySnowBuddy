// DOM side of the control-plane tools: what is on screen (read_page), which UI
// action buttons exist and clicking one (click_ui_action), and opening a page in
// the classic content frame (navigate). Runs in the content script of the top
// frame. Same-origin iframes (classic `gsft_main`, also inside the Next
// Experience shell's shadow DOM) are reached through contentDocument.
//
// SECURITY: nothing here evaluates page-supplied code. Clicks are dispatched
// from the content script (never through the page bridge, which any page script
// can call), and only after the agent's approval gate.
//
// UNVERIFIED against a live instance (see the control-plane notes in the report):
// classic markup `[id^="element.<table>.<field>"]`, `[tab_caption]` sections and
// related lists, `button.form_action_button` (+ `gsft_id`, `data-action-name`),
// `.outputmsg`/`.notification` messages, list `th[name]` / `tr.list_row[sys_id]`,
// and workspace `now-button` labels.

const HOST_ID = 'mysnowbuddy-root';
const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const MAX_ROOTS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const textOf = (el) => squash(el?.innerText || el?.textContent || '');

function shadowOf(el) {
  if (el.shadowRoot) return el.shadowRoot;
  // Closed shadow roots are reachable from a content script only (Chrome 88+), and only custom elements have them.
  if (el.tagName.includes('-') && typeof chrome !== 'undefined' && chrome.dom?.openOrClosedShadowRoot) {
    try {
      return chrome.dom.openOrClosedShadowRoot(el) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The document, open (and closed) shadow roots and same-origin iframe documents, breadth first. */
export function deepRoots(start = document, limit = MAX_ROOTS) {
  const roots = [start];
  for (let i = 0; i < roots.length && roots.length < limit; i++) {
    for (const el of roots[i].querySelectorAll('*')) {
      if (el.id === HOST_ID) continue;
      const shadow = shadowOf(el);
      if (shadow) roots.push(shadow);
      if (el.tagName === 'IFRAME') {
        try {
          if (el.contentDocument) roots.push(el.contentDocument);
        } catch {
          // Cross-origin frame.
        }
      }
      if (roots.length >= limit) break;
    }
  }
  return roots;
}

/** The classic content frame (`gsft_main`), top-level or inside the Next Experience shell, or null. */
export function findClassicFrame() {
  const direct = document.getElementById('gsft_main');
  if (direct?.tagName === 'IFRAME') return direct;
  // Only the shell hides it in shadow DOM; skip the deep walk on plain classic pages.
  if (!window.location.pathname.startsWith('/now/')) return null;
  for (const root of deepRoots(document, 120)) {
    const frame = root.querySelector?.('iframe#gsft_main, iframe[name="gsft_main"]');
    if (frame) return frame;
  }
  return null;
}

/** { doc, frame } for the classic page on screen: the content frame when there is one, else the top document. */
export function contentTarget() {
  const frame = findClassicFrame();
  try {
    const doc = frame?.contentDocument;
    if (doc && doc.location.href !== 'about:blank') return { doc, frame };
  } catch {
    // Cross-origin: fall back to the top document.
  }
  return { doc: document, frame: null };
}

function isVisible(el) {
  try {
    const view = el.ownerDocument.defaultView;
    return el.getClientRects().length > 0 && view.getComputedStyle(el).visibility !== 'hidden';
  } catch {
    return false;
  }
}

// ---- reading ------------------------------------------------------------------------------------

/** Info, warning and error messages, including field messages (with their field). */
export function readMessages(doc, limit = 12) {
  const out = [];
  const seen = new Set();
  for (const node of doc.querySelectorAll('.outputmsg, .notification, .fieldmsg')) {
    if (out.length >= limit) break;
    // A container that holds other messages is read through its children.
    if (node.querySelector('.outputmsg, .notification, .fieldmsg') || !isVisible(node)) continue;
    const text = textOf(node.querySelector('.outputmsg_text') || node).replace(/^(close|×)\s*/i, '');
    if (!text) continue;
    const cls = String(node.className || '');
    const type = /error|danger/i.test(cls) ? 'error' : /warn/i.test(cls) ? 'warning' : 'info';
    const holder = node.closest('[id^="element."]');
    const field = holder ? holder.id.split('.').slice(2).join('.') : undefined;
    const key = `${type}|${field || ''}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, text: text.slice(0, 300), ...(field ? { field } : {}) });
  }
  return out;
}

const ACTION_SELECTOR = 'button.form_action_button, input.form_action_button, button[data-action-name], .form_action_button_container button';

/** UI action buttons on a classic form, with their element (not serialisable; strip `el` before returning). */
export function findUiActionElements(doc) {
  const out = [];
  for (const el of doc.querySelectorAll(ACTION_SELECTOR)) {
    if (el.disabled || !isVisible(el)) continue;
    const isInput = el.tagName === 'INPUT';
    const label = squash(isInput ? el.value : textOf(el)) || squash(el.getAttribute('aria-label') || el.title);
    if (!label) continue;
    const id = el.id || '';
    const value = isInput ? '' : el.getAttribute('value') || '';
    const actionName = el.getAttribute('data-action-name') || (id && !SYS_ID_RE.test(id) ? id : '') || (value && !SYS_ID_RE.test(value) && !/\s/.test(value) ? value : '');
    const sysId = el.getAttribute('gsft_id') || (SYS_ID_RE.test(id) ? id : SYS_ID_RE.test(value) ? value : '');
    out.push({ el, label: label.slice(0, 80), actionName: actionName || null, id: id || null, sysId: sysId || null });
  }
  return out;
}

/** Buttons anywhere on a Next Experience / portal page (shadow DOM included), by visible label. Best effort. */
export function findPageButtons(limit = 60) {
  const out = [];
  const controls = new Set();
  for (const root of deepRoots(document)) {
    for (const el of root.querySelectorAll('now-button, button, [role="button"]')) {
      if (out.length >= limit) return out;
      if (el.disabled || el.closest?.(`#${HOST_ID}`) || !isVisible(el)) continue;
      // A now-button host and the <button> inside its shadow root are one control.
      const control = el.tagName === 'NOW-BUTTON' ? el : root.host?.tagName === 'NOW-BUTTON' ? root.host : el;
      if (controls.has(control)) continue;
      const label = squash(control.getAttribute('label') || control.getAttribute('aria-label') || textOf(el) || control.title).slice(0, 80);
      if (!label || label.length < 2) continue;
      controls.add(control);
      // Each control is its own entry (key), so two buttons with one label are reported as ambiguous, never merged.
      out.push({ el: control, key: `w${out.length}`, label, actionName: null, id: control.id || null, sysId: null, workspace: true });
    }
  }
  return out;
}

/** Form sections with the fields in each, from the classic form markup. */
export function readSections(doc) {
  const sections = new Map();
  for (const el of doc.querySelectorAll('[id^="element."]')) {
    const parts = el.id.split('.');
    if (parts.length < 3 || el.closest('table.list_table')) continue;
    const field = parts.slice(2).join('.');
    const holder = el.closest('[tab_caption], .tabs2_section, [id^="section-"]');
    const name = squash(holder?.getAttribute('tab_caption') || holder?.getAttribute('aria-label') || '') || 'Main';
    if (!sections.has(name)) sections.set(name, []);
    const list = sections.get(name);
    if (!list.includes(field)) list.push(field);
  }
  return [...sections.entries()].map(([name, fields]) => ({ name, fields }));
}

/** Related lists under a classic form: caption, rows shown, and the list's table when the markup says. */
export function readRelatedLists(doc, limit = 30) {
  const out = [];
  for (const section of doc.querySelectorAll('[tab_caption]')) {
    const list = section.querySelector('table.list_table');
    if (!list) continue;
    out.push({
      label: squash(section.getAttribute('tab_caption')).slice(0, 80),
      table: list.getAttribute('glide_table') || list.getAttribute('table') || null,
      rowsShown: section.querySelectorAll('tr.list_row').length,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Form fields read from the markup: the fallback when the page bridge cannot reach g_form. */
export function readFieldsFromDom(doc, table, limit = 200) {
  const out = [];
  for (const holder of doc.querySelectorAll('[id^="element."]')) {
    if (out.length >= limit) break;
    if (holder.closest('table.list_table')) continue;
    const parts = holder.id.split('.');
    if (parts.length < 3) continue;
    const name = parts.slice(2).join('.');
    const tbl = parts[1] || table;
    const input = doc.getElementById(`${tbl}.${name}`) || holder.querySelector('input:not([type="hidden"]), select, textarea');
    const display = doc.getElementById(`sys_display.${tbl}.${name}`);
    out.push({
      name,
      label: squash(holder.querySelector('label')?.textContent || '').replace(/^\*\s*/, '').slice(0, 80),
      value: input && input.type !== 'password' ? String(input.value ?? '').slice(0, 300) : undefined,
      display: display?.value ? String(display.value).slice(0, 120) : undefined,
      mandatory: Boolean(holder.querySelector('.mandatory, .required-marker, [aria-required="true"]')),
      readOnly: Boolean(input && (input.readOnly || input.disabled)),
      visible: isVisible(holder),
    });
  }
  return out;
}

/** A classic list: column names, rows shown with sys_ids and cell text. */
export function readListDom(doc, maxRows = 10) {
  const table = doc.querySelector('table.list_table[glide_table]') || doc.querySelector('table.list_table');
  if (!table) return null;
  const columns = [...table.querySelectorAll('thead th')]
    .map((th) => th.getAttribute('name') || th.getAttribute('glide_field') || th.getAttribute('data-column-name'))
    .filter((n) => n && /^[a-z0-9_.]+$/i.test(n));
  const rows = [...table.querySelectorAll('tr.list_row')];
  return {
    table: table.getAttribute('glide_table') || null,
    columns: [...new Set(columns)],
    rowsOnScreen: rows.length,
    rows: rows.slice(0, maxRows).map((tr) => ({
      sys_id: tr.getAttribute('sys_id') || null,
      cells: [...tr.querySelectorAll('td')]
        .filter((td) => !/decoration|list_checkbox/.test(String(td.className || '')))
        .map((td) => textOf(td).slice(0, 120)),
    })),
  };
}

/** An open modal dialog (GlideModal, workspace modal), so the caller knows the page is waiting for an answer. */
export function readDialog(doc) {
  for (const d of [doc, document]) {
    for (const el of d.querySelectorAll('.modal-dialog, .glide_modal, [role="dialog"], [role="alertdialog"]')) {
      if (el.closest(`#${HOST_ID}`) || !isVisible(el)) continue;
      const title = squash(el.querySelector('.modal-title, h1, h2, h4')?.textContent || el.getAttribute('aria-label') || '').slice(0, 120);
      return { open: true, title: title || 'dialog', text: textOf(el).slice(0, 300) };
    }
  }
  return null;
}

const headings = (doc, limit = 6) =>
  [...doc.querySelectorAll('h1, h2')]
    .filter(isVisible)
    .map((h) => textOf(h).slice(0, 100))
    .filter(Boolean)
    .slice(0, limit);

/** Everything read_page can learn from the markup alone. The tool adds g_form and Table API data on top. */
export function snapshotDom({ maxRows = 10 } = {}) {
  const { doc, frame } = contentTarget();
  const topPath = window.location.pathname + window.location.search;
  let contentPath = null;
  try {
    contentPath = frame ? doc.location.pathname + doc.location.search : null;
  } catch {
    contentPath = null;
  }
  const uniqueValue = doc.querySelector('input[name="sys_uniqueValue"]')?.value || null;
  const formEl = doc.querySelector('form[id$=".do"]');
  const pagePath = contentPath || topPath;
  const listUrl = /_list\.do(\?|$)/i.test(pagePath);
  // sys_uniqueValue is the form's own record; a bare <form id="x.do"> only counts when this is not a list URL.
  const isForm = Boolean(uniqueValue || (formEl && !listUrl));
  const listPage = listUrl || Boolean(doc.querySelector('table.list_table') && !isForm);
  const classic = Boolean(frame) || /\.do(\?|$)/i.test(topPath);
  const out = {
    ui: topPath.startsWith('/now/') ? 'next-experience' : 'classic',
    topPath,
    contentPath,
    title: squash(doc.title || document.title).replace(/\s*\|\s*ServiceNow.*$/i, '').slice(0, 160),
    hasForm: isForm,
    hasList: !isForm && listPage,
    formTable: formEl ? formEl.id.replace(/\.do$/, '') : null,
    sysId: uniqueValue,
    messages: classic ? readMessages(doc) : [],
    dialog: readDialog(doc),
  };
  if (isForm) {
    out.sections = readSections(doc);
    out.uiActions = findUiActionElements(doc).map(({ el, ...a }) => a);
    out.relatedLists = readRelatedLists(doc);
  } else if (out.hasList) {
    out.list = readListDom(doc, maxRows);
  } else {
    out.headings = headings(doc);
    out.buttons = findPageButtons(40).map((b) => b.label);
  }
  return out;
}

/** read_page's DOM field fallback for the open classic form. */
export function domFormFields(limit) {
  const { doc } = contentTarget();
  const formEl = doc.querySelector('form[id$=".do"]');
  return readFieldsFromDom(doc, formEl ? formEl.id.replace(/\.do$/, '') : '', limit);
}

// ---- acting ---------------------------------------------------------------------------------------

/** UI actions that click_ui_action can match against: classic form buttons, else workspace buttons. */
export function listUiActions() {
  const { doc } = contentTarget();
  const classic = findUiActionElements(doc);
  if (classic.length || doc.querySelector('input[name="sys_uniqueValue"]')) return { mode: 'classic', actions: classic };
  if (window.location.pathname.startsWith('/now/')) return { mode: 'workspace', actions: findPageButtons(80) };
  return { mode: 'none', actions: [] };
}

/** Click a control the way a person would. A workspace button is clicked on the real <button> inside it. */
export function clickControl(el) {
  const inner = el.tagName === 'NOW-BUTTON' ? shadowOf(el)?.querySelector('button') : null;
  const target = inner || el;
  target.scrollIntoView({ block: 'center' });
  target.click();
}

export const currentPath = () => window.location.pathname;
export const currentUrl = () => window.location.pathname + window.location.search;

/** Marker for "the content changed": the content document object and its URL. */
export function pageMarker() {
  const { doc, frame } = contentTarget();
  let href = '';
  try {
    href = doc.location.href;
  } catch {
    href = '';
  }
  return { doc, frame, href, topHref: window.location.href };
}

/** Open a classic page inside the content frame, keeping the shell, the sidebar and this script alive. */
export function navigateFrame(frame, path) {
  frame.contentWindow.location.assign(path);
}

/** Open a page in the whole tab. This reloads the top document, so callers return their result first. */
export function navigateTop(url, delayMs = 150) {
  setTimeout(() => window.location.assign(url), delayMs);
}

/** Reload the tab shortly, after the current tool call has answered. */
export function reloadSoon(delayMs = 300) {
  setTimeout(() => window.location.reload(), delayMs);
}

/**
 * Wait until the content page changes (another document loaded, or the top URL changed) and settles, a dialog
 * opens, or new messages appear. Returns what happened.
 * @returns {Promise<'page-changed'|'dialog'|'message'|'no-visible-change'>}
 */
export async function waitForChange(before, { timeoutMs = 12000, settleMs = 400, messagesBefore = [] } = {}) {
  const deadline = Date.now() + timeoutMs;
  const known = new Set(messagesBefore.map((m) => `${m.type}|${m.text}`));
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- polling the page at a fixed, bounded interval
    await sleep(200);
    const now = pageMarker();
    const changedDoc = now.doc !== before.doc || now.href !== before.href || now.topHref !== before.topHref;
    if (changedDoc && now.doc.readyState === 'complete') {
      await sleep(settleMs);
      return 'page-changed';
    }
    if (!changedDoc) {
      if (readDialog(now.doc)) return 'dialog';
      if (readMessages(now.doc).some((m) => !known.has(`${m.type}|${m.text}`))) return 'message';
    }
  }
  return 'no-visible-change';
}
