// Portal inspector: "which widget is this, what is in c.data, and where is its code?" for the Service Portal page on
// screen. This is the instance half: it finds the widgets in the page DOM, asks the page-world bridge for each widget's
// Angular scope (read-only, see src/page/bridge.js), reads the widget records through the Table API with the user's own
// session, and draws the temporary outline. The pure half is src/lib/portalInspector.js (and portalScope.js);
// the panel is src/sidebar/PortalPanel.jsx.
//
// Rules this file keeps: nothing runs until the panel is opened; the page DOM is never changed (the outline lives in
// the extension's own shadow root); every Table API query names its columns, filters by sys_id, and is capped;
// a missing column or a refused read is reported to the panel, never turned into "nothing found".

import { callPage } from './pageBridge.js';
import { queryTable, queryInChunks } from './tableApi.js';
import { getUiRoot, UI_HOST_ID } from './uiRoot.js';
import { isSysId } from '../lib/xray.js';
import {
  WIDGET_FIELDS,
  INSTANCE_FIELDS,
  classifyPage,
  urlParams,
  discoverWidgets,
  widgetAt,
  widgetLabel,
  placementLabel,
  widgetLinks,
  analyzeWidget,
  scopeExplanation,
  serialize,
} from '../lib/portalInspector.js';

const flat = (v) => (v && typeof v === 'object' ? String(v.value ?? v.display_value ?? '') : v == null ? '' : String(v));
const errorText = (err) => (err && err.message) || String(err);
const SCAN_TIMEOUT_MS = 6000;
const STATE_TIMEOUT_MS = 5000;
const RECORD_CACHE_MS = 60 * 1000;
const MAX_SNAPSHOTS = 12;
const PICK_TIMEOUT_MS = 2 * 60 * 1000;

const state = {
  doc: null, // the document the last load found the portal in
  widgets: new Map(), // key -> { widget (from discoverWidgets), doc, frame }
  names: new Map(), // widget sys_id -> { name, id }
  instances: new Map(), // instance sys_id -> { widgetId, title, table }
  asked: new Set(), // ids already looked up, found or not, so a refresh never repeats a query
  records: new Map(), // widget sys_id -> { at, value }
  pages: new Map(), // "suffix|pageId" -> { page, portal, error }
  snapshots: new Map(), // key -> { at, data, options }
};

// --- Which documents hold the portal ---------------------------------------------------------------------------

/** The page itself and, for a portal opened inside the classic frame, that frame's document. */
function portalDocuments() {
  const docs = [{ doc: document, frame: '' }];
  try {
    const frame = document.getElementById('gsft_main');
    if (frame?.contentDocument?.documentElement) docs.push({ doc: frame.contentDocument, frame: 'gsft_main' });
  } catch {
    // Cross-origin frame: nothing to read.
  }
  return docs;
}

const hrefOf = (doc) => {
  try {
    return doc.defaultView?.location?.href || window.location.href;
  } catch {
    return window.location.href;
  }
};

function hasPortalMarkup(doc) {
  try {
    return Boolean(doc.querySelector('sp-page-row, sp-widget, [ng-app*="$sp"], [data-ng-app*="$sp"]'));
  } catch {
    return false;
  }
}

/** Widgets of the best document: the one with the most widgets, the page itself on a tie. */
function scanDocuments() {
  let best = null;
  portalDocuments().forEach(({ doc, frame }) => {
    const widgets = discoverWidgets(doc);
    const markup = hasPortalMarkup(doc);
    if (!best || widgets.length > best.widgets.length) best = { doc, frame, widgets, markup };
  });
  return best;
}

// --- Table API lookups ------------------------------------------------------------------------------------------

async function resolveNames(widgetIds, instanceIds) {
  const problems = [];
  const wantInstances = [...new Set(instanceIds)].filter((id) => isSysId(id) && !state.instances.has(id) && !state.asked.has(`i:${id}`)).slice(0, 100);
  wantInstances.forEach((id) => state.asked.add(`i:${id}`));
  if (wantInstances.length) {
    try {
      const rows = await queryInChunks('sp_instance', 'sys_id', wantInstances, ['sys_id', 'sp_widget', 'title', 'sys_class_name'], { limit: 100 });
      rows.forEach((row) => {
        state.instances.set(flat(row.sys_id), { widgetId: flat(row.sp_widget).toLowerCase(), title: flat(row.title), table: flat(row.sys_class_name) || 'sp_instance' });
      });
    } catch (err) {
      wantInstances.forEach((id) => state.asked.delete(`i:${id}`));
      problems.push(`widget instances (${errorText(err)})`);
    }
  }
  const fromInstances = [...state.instances.values()].map((i) => i.widgetId);
  const wantWidgets = [...new Set([...widgetIds, ...fromInstances])].filter((id) => isSysId(id) && !state.names.has(id) && !state.asked.has(`w:${id}`)).slice(0, 100);
  wantWidgets.forEach((id) => state.asked.add(`w:${id}`));
  if (wantWidgets.length) {
    try {
      const rows = await queryInChunks('sp_widget', 'sys_id', wantWidgets, ['sys_id', 'name', 'id'], { limit: 100 });
      rows.forEach((row) => state.names.set(flat(row.sys_id), { name: flat(row.name), id: flat(row.id) }));
    } catch (err) {
      wantWidgets.forEach((id) => state.asked.delete(`w:${id}`));
      problems.push(`widget names (${errorText(err)})`);
    }
  }
  return problems;
}

/** The sp_page and sp_portal records for the URL. Each answer is checked against what was asked, because an unknown column would match every row. */
async function resolvePage(suffix, pageId, fromScope) {
  const cacheKey = `${suffix}|${pageId}`;
  const cached = state.pages.get(cacheKey);
  if (cached) return cached;
  const out = { page: fromScope?.page?.sysId ? { ...fromScope.page } : null, portal: fromScope?.portal?.sysId ? { ...fromScope.portal } : null, problems: [] };
  if (!out.page && /^[\w.-]{1,100}$/.test(pageId)) {
    try {
      const rows = await queryTable('sp_page', `id=${pageId}`, ['sys_id', 'id', 'title'], { limit: 5 });
      const row = rows.find((r) => flat(r.id) === pageId);
      if (row) out.page = { sysId: flat(row.sys_id).toLowerCase(), id: flat(row.id), title: flat(row.title), urlSuffix: '' };
      else if (rows.length) out.problems.push('the page record (the id column did not filter, so the answer was not trusted)');
    } catch (err) {
      out.problems.push(`the page record (${errorText(err)})`);
    }
  }
  if (!out.portal && /^[a-z0-9_]{1,40}$/i.test(suffix)) {
    try {
      const rows = await queryTable('sp_portal', `url_suffix=${suffix}`, ['sys_id', 'title', 'url_suffix'], { limit: 5 });
      const row = rows.find((r) => flat(r.url_suffix) === suffix);
      if (row) out.portal = { sysId: flat(row.sys_id).toLowerCase(), id: '', title: flat(row.title), urlSuffix: flat(row.url_suffix) };
      else if (rows.length) out.problems.push('the portal record (the url_suffix column did not filter, so the answer was not trusted)');
    } catch (err) {
      out.problems.push(`the portal record (${errorText(err)})`);
    }
  }
  if (!out.problems.length) state.pages.set(cacheKey, out);
  return out;
}

// --- The list ---------------------------------------------------------------------------------------------------

/**
 * Everything the panel's list needs: what kind of page this is, the widgets with their names, whether Angular debug info
 * is on, and the page and portal records. Never throws; a part that could not be read is named in `notes`.
 */
async function portalLoad() {
  const scan = scanDocuments();
  state.doc = scan.doc;
  const href = hrefOf(scan.doc);
  const widgets = scan.widgets;
  state.widgets = new Map(widgets.map((w) => [w.key, { widget: w, doc: scan.doc, frame: scan.frame }]));
  const kind = classifyPage({ href, widgetCount: widgets.length, hasMarkup: scan.markup });
  const result = {
    kind: kind.kind,
    message: kind.message,
    hint: kind.hint,
    url: { href: href.replace(/#.*$/, ''), suffix: kind.suffix, pageId: kind.pageId, params: urlParams(href) },
    frame: scan.frame,
    debug: { angular: null, version: null, debugInfo: null, canReload: false },
    widgets: [],
    page: null,
    portal: null,
    pageLinks: [],
    notes: [],
    at: Date.now(),
  };
  if (kind.kind === 'workspace' || kind.kind === 'classic' || kind.kind === 'other') return result;

  // What the page's own Angular says: widget names and ids, debug-info state, the page and portal records.
  let bridge = null;
  if (widgets.length || kind.kind === 'portal-empty') {
    try {
      bridge = await callPage('portalScan', [scan.frame, widgets.map((w) => w.target)], { timeoutMs: SCAN_TIMEOUT_MS });
    } catch (err) {
      result.notes.push(`Could not ask the page about its Angular scopes (${errorText(err)}). The list below comes from the page markup only.`);
    }
  }
  if (bridge && bridge.frame === false) bridge = null;
  if (bridge) result.debug = { angular: bridge.angular, version: bridge.version, debugInfo: bridge.debugInfo, canReload: bridge.canReload };

  const scoped = widgets.map((w, i) => ({ w, info: bridge?.widgets?.[i] || null }));
  scoped.forEach(({ info }) => {
    const who = info?.identity;
    if (who?.sysId && who.name && !state.names.has(who.sysId)) state.names.set(who.sysId, { name: who.name, id: who.id });
  });
  const widgetIds = scoped.map(({ w, info }) => w.widgetId || info?.identity?.sysId || '').filter(Boolean);
  const instanceIds = scoped.map(({ w, info }) => w.instanceId || info?.identity?.instanceId || '').filter(Boolean);
  const lookups = [resolveNames(widgetIds, instanceIds)];
  lookups.push(resolvePage(kind.suffix, kind.pageId, bridge));
  const [problems, pages] = await Promise.all(lookups);
  if (problems.length) result.notes.push(`Could not look up ${problems.join(' or ')}. Names fall back to what the page itself says.`);
  if (pages) {
    result.page = pages.page;
    result.portal = pages.portal;
    if (pages.problems.length) result.notes.push(`Could not look up ${pages.problems.join(' or ')}.`);
  }

  result.widgets = scoped.map(({ w, info }) => {
    const instance = state.instances.get(w.instanceId || info?.identity?.instanceId || '');
    const widgetId = w.widgetId || info?.identity?.sysId || instance?.widgetId || '';
    const known = state.names.get(widgetId);
    const name = known?.name || info?.identity?.name || '';
    const id = known?.id || info?.identity?.id || '';
    return {
      key: w.key,
      name,
      id,
      widgetId,
      instanceId: w.instanceId || info?.identity?.instanceId || '',
      instanceTable: instance?.table || 'sp_instance',
      title: instance?.title || '',
      tag: w.tag,
      instances: w.instances,
      placement: w.placement,
      placementText: placementLabel(w.placement),
      hasScope: info ? info.scope : null,
      serverTimeMs: info?.serverTimeMs ?? null,
      label: widgetLabel({ name, id, widgetId, instanceId: w.instanceId }),
    };
  });
  result.pageLinks = widgetLinks({ pageSysId: result.page?.sysId, pageId: result.page?.id || kind.pageId, portalSysId: result.portal?.sysId });
  return result;
}

/** The address of the page now, so the panel can notice a portal navigation without scanning anything. */
function portalHref() {
  return hrefOf(state.doc || document).replace(/#.*$/, '');
}

// --- One widget -------------------------------------------------------------------------------------------------

function entryFor(key) {
  let entry = state.widgets.get(key);
  if (entry && entry.widget.el?.isConnected) return entry;
  // The page changed under us (portal navigation, a widget re-rendered): find it again by the same key.
  const scan = scanDocuments();
  state.widgets = new Map(scan.widgets.map((w) => [w.key, { widget: w, doc: scan.doc, frame: scan.frame }]));
  entry = state.widgets.get(key);
  return entry || null;
}

async function fetchWidgetRecord(widgetId) {
  const cached = state.records.get(widgetId);
  if (cached && Date.now() - cached.at < RECORD_CACHE_MS) return cached.value;
  let value;
  try {
    const rows = await queryTable('sp_widget', `sys_id=${widgetId}`, WIDGET_FIELDS, { limit: 1 });
    const row = rows[0];
    if (!row) value = { record: null, missing: [], error: 'The widget record was not found, or your user cannot read it.' };
    else {
      const record = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, flat(v)]));
      value = { record, missing: WIDGET_FIELDS.filter((f) => !(f in record)), error: '' };
    }
  } catch (err) {
    value = { record: null, missing: [], error: errorText(err) };
  }
  if (!value.error) state.records.set(widgetId, { at: Date.now(), value });
  return value;
}

async function fetchInstance(instanceId) {
  try {
    const rows = await queryTable('sp_instance', `sys_id=${instanceId}`, INSTANCE_FIELDS, { limit: 1 });
    const row = rows[0];
    if (!row) return { row: null, error: 'The instance record was not found, or your user cannot read it.' };
    return { row: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, flat(v)])), error: '' };
  } catch (err) {
    return { row: null, error: errorText(err) };
  }
}

/** Script Includes named in the widget's scripts that exist on this instance: [{ name, found, sysId }]. */
async function confirmScriptIncludes(names) {
  const wanted = [...new Set(names)].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n)).slice(0, 40);
  if (!wanted.length) return { items: [], error: '' };
  try {
    const rows = await queryInChunks('sys_script_include', 'name', wanted, ['sys_id', 'name'], { limit: 100 });
    const byName = new Map(rows.filter((r) => isSysId(flat(r.sys_id))).map((r) => [flat(r.name), flat(r.sys_id).toLowerCase()]));
    return { items: wanted.map((name) => ({ name, found: byName.has(name), sysId: byName.get(name) || '' })), error: '' };
  } catch (err) {
    return { items: wanted.map((name) => ({ name, found: null, sysId: '' })), error: errorText(err) };
  }
}

/** The live scope of one widget (c.data, options), or the reason there is none. */
async function portalWidgetLive(key) {
  const entry = entryFor(key);
  if (!entry) return { found: false, scope: false, reason: 'no-element', explanation: scopeExplanation('no-element') };
  try {
    const live = await callPage('portalWidgetState', [entry.frame, entry.widget.target], { timeoutMs: STATE_TIMEOUT_MS });
    return { ...live, explanation: live?.scope ? '' : scopeExplanation(live?.reason, live) };
  } catch (err) {
    return { found: true, scope: false, reason: 'bridge-error', error: errorText(err), explanation: scopeExplanation('bridge-error', { error: errorText(err) }) };
  }
}

/**
 * Everything about one widget: its live scope, its record and what its code touches, the instance record and the
 * links. Parts that fail are returned as errors beside the parts that worked.
 */
async function portalWidgetDetail(key, listed = {}) {
  const entry = entryFor(key);
  if (!entry) return { gone: true };
  const widgetId = listed.widgetId || entry.widget.widgetId || '';
  const instanceId = listed.instanceId || entry.widget.instanceId || '';
  const [live, widgetRec, instanceRec] = await Promise.all([
    portalWidgetLive(key),
    isSysId(widgetId) ? fetchWidgetRecord(widgetId) : Promise.resolve({ record: null, missing: [], error: 'This widget has no sys_id on the page, so its record cannot be looked up.' }),
    isSysId(instanceId) ? fetchInstance(instanceId) : Promise.resolve({ row: null, error: '' }),
  ]);
  const analysis = widgetRec.record ? analyzeWidget(widgetRec.record) : null;
  let scriptIncludes = { items: [], error: '' };
  if (analysis) {
    const names = [...analysis.server.scriptIncludes, ...analysis.client.scriptIncludes].map((s) => s.name);
    scriptIncludes = await confirmScriptIncludes(names);
  }
  // Options saved on the instance record, as the widget will read them (secrets hidden like every other value).
  let savedOptions = null;
  if (instanceRec.row?.widget_parameters) {
    try {
      savedOptions = serialize(JSON.parse(instanceRec.row.widget_parameters)).value;
    } catch {
      savedOptions = null;
    }
  }
  const instanceTable = instanceRec.row?.sys_class_name || listed.instanceTable || 'sp_instance';
  return {
    gone: false,
    live,
    record: widgetRec.record
      ? { name: widgetRec.record.name || '', id: widgetRec.record.id || '', updatedOn: widgetRec.record.sys_updated_on || '', updatedBy: widgetRec.record.sys_updated_by || '', roles: widgetRec.record.roles || '', isPublic: widgetRec.record.public === 'true', dataTable: widgetRec.record.data_table || '' }
      : null,
    recordError: widgetRec.error,
    missingColumns: widgetRec.missing,
    analysis,
    scriptIncludes,
    instance: instanceRec.row ? { title: instanceRec.row.title || '', table: instanceTable, updatedOn: instanceRec.row.sys_updated_on || '' } : null,
    instanceError: instanceRec.error,
    savedOptions,
    links: widgetLinks({ widgetId, instanceId, instanceTable, pageSysId: listed.pageSysId, pageId: listed.pageId, portalSysId: listed.portalSysId }),
  };
}

/** Reload the page with Angular debug info on (angular.reloadWithDebugInfo). The page reloads; nothing else changes. */
async function portalReloadWithDebugInfo() {
  const scan = scanDocuments();
  await callPage('portalReloadWithDebugInfo', [scan.frame], { timeoutMs: STATE_TIMEOUT_MS });
  return true;
}

// --- Snapshots (kept for the life of the page, so closing the panel does not lose them) -----------------------------

function portalSnapshotSave(key, data, options) {
  state.snapshots.set(key, { at: Date.now(), data, options });
  while (state.snapshots.size > MAX_SNAPSHOTS) state.snapshots.delete(state.snapshots.keys().next().value);
  return state.snapshots.get(key).at;
}
const portalSnapshotGet = (key) => state.snapshots.get(key) || null;
const portalSnapshotClear = (key) => state.snapshots.delete(key);

// --- The outline ------------------------------------------------------------------------------------------------

const outline = { box: null, tag: null, entry: null, frame: 0, cleanup: null, timer: 0 };

function ensureOutline() {
  const root = getUiRoot();
  if (!root) return false;
  if (!outline.box || !outline.box.isConnected) {
    outline.box = document.createElement('div');
    outline.box.className = 'msb-portal-outline';
    outline.box.setAttribute('aria-hidden', 'true');
    outline.box.hidden = true;
    outline.tag = document.createElement('span');
    outline.tag.className = 'msb-portal-outline__tag';
    outline.box.append(outline.tag);
    root.appendChild(outline.box);
  }
  return true;
}

function widgetRect(entry) {
  const el = entry.widget.el;
  if (!el?.isConnected) return null;
  let r = el.getBoundingClientRect();
  if ((r.width < 2 || r.height < 2) && el.firstElementChild) r = el.firstElementChild.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  let top = r.top;
  let left = r.left;
  // A portal inside the classic frame: add the frame's own place on the page.
  if (entry.doc !== document) {
    const frame = entry.doc.defaultView?.frameElement?.getBoundingClientRect();
    if (frame) {
      top += frame.top;
      left += frame.left;
    }
  }
  return { top, left, width: r.width, height: r.height };
}

function placeOutline() {
  outline.frame = 0;
  if (!outline.entry || !outline.box) return;
  const r = widgetRect(outline.entry);
  if (!r) {
    outline.box.hidden = true;
    return;
  }
  outline.box.hidden = false;
  outline.box.style.top = `${r.top}px`;
  outline.box.style.left = `${r.left}px`;
  outline.box.style.width = `${r.width}px`;
  outline.box.style.height = `${r.height}px`;
  // The name sits just inside the top edge when the widget starts at the very top of the screen.
  outline.box.classList.toggle('msb-portal-outline--top', r.top < 22);
}

const scheduleOutline = () => {
  if (!outline.frame) outline.frame = window.requestAnimationFrame(placeOutline);
};

function hideOutline() {
  clearTimeout(outline.timer);
  outline.entry = null;
  if (outline.cleanup) outline.cleanup();
  outline.cleanup = null;
  if (outline.frame) window.cancelAnimationFrame(outline.frame);
  outline.frame = 0;
  if (outline.box) {
    outline.box.hidden = true;
    outline.box.classList.remove('msb-portal-outline--flash');
  }
}

/** What to call a widget on the outline when the panel did not say: its name from the page's own scope or the widget record. */
function labelFor(widget) {
  const widgetId = widget.widgetId || state.instances.get(widget.instanceId)?.widgetId || '';
  const known = state.names.get(widgetId);
  return known?.name || known?.id || widgetLabel({ widgetId, instanceId: widget.instanceId });
}

/** Outline one widget on the page (hover or focus in the list). Removed by portalUnhighlight. */
function portalHighlight(key, label = '') {
  const entry = entryFor(key);
  if (!entry || !ensureOutline()) return false;
  hideOutline();
  outline.entry = entry;
  outline.tag.textContent = label || labelFor(entry.widget);
  outline.box.classList.remove('msb-portal-outline--flash');
  const views = new Set([window, entry.doc.defaultView].filter(Boolean));
  views.forEach((view) => {
    view.addEventListener('scroll', scheduleOutline, { capture: true, passive: true });
    view.addEventListener('resize', scheduleOutline, { passive: true });
  });
  outline.cleanup = () => {
    views.forEach((view) => {
      view.removeEventListener('scroll', scheduleOutline, { capture: true });
      view.removeEventListener('resize', scheduleOutline);
    });
  };
  placeOutline();
  return !outline.box.hidden;
}

function portalUnhighlight() {
  hideOutline();
}

/** Scroll the widget into view and outline it for a moment ("Show on page"). */
function portalReveal(key, label = '') {
  const entry = entryFor(key);
  if (!entry) return false;
  try {
    entry.widget.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  } catch {
    // Detached element: the outline below reports it.
  }
  const shown = portalHighlight(key, label);
  if (!outline.box) return false;
  outline.box.classList.add('msb-portal-outline--flash');
  // Smooth scrolling moves the widget for a moment: keep following it, then let the outline go.
  const follow = window.setInterval(placeOutline, 60);
  outline.timer = window.setTimeout(() => {
    window.clearInterval(follow);
    hideOutline();
  }, 2200);
  const previous = outline.cleanup;
  outline.cleanup = () => {
    window.clearInterval(follow);
    if (previous) previous();
  };
  return shown;
}

// --- Pick a widget by clicking it on the page --------------------------------------------------------------------

let picking = null;

/**
 * "Which widget is this?": while on, the widget under the pointer is outlined and the next click on the page chooses it
 * instead of doing what the click normally does. Escape, or the returned function, cancels. Clicks in the sidebar are left alone.
 * @returns {() => void} cancel
 */
function portalPick({ onPick, onCancel } = {}) {
  portalPickCancel();
  const host = document.getElementById(UI_HOST_ID);
  const own = (event) => Boolean(host && event.target && (event.target === host || host.contains(event.target)));
  const fresh = () => {
    const scan = scanDocuments();
    state.widgets = new Map(scan.widgets.map((w) => [w.key, { widget: w, doc: scan.doc, frame: scan.frame }]));
    return scan;
  };
  let scan = fresh();
  const docs = [...new Set([document, ...portalDocuments().map((d) => d.doc)])];

  const onMove = (event) => {
    if (own(event)) return;
    const hit = widgetAt(scan.widgets, event.target);
    if (!hit) {
      hideOutline();
      return;
    }
    if (outline.entry?.widget.key !== hit.key) portalHighlight(hit.key);
  };
  const stopEvent = (event) => {
    if (own(event)) return false;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    return true;
  };
  const onClick = (event) => {
    if (!stopEvent(event)) return;
    scan = fresh();
    const hit = widgetAt(scan.widgets, event.target);
    if (!hit) return; // a click outside any widget keeps picking
    finish();
    onPick?.(hit.key);
  };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    cancel();
  };
  const swallow = (event) => void stopEvent(event);

  function detach() {
    docs.forEach((doc) => {
      doc.removeEventListener('mousemove', onMove, true);
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('keydown', onKey, true);
      ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick'].forEach((type) => doc.removeEventListener(type, swallow, true));
    });
    clearTimeout(picking?.timer);
  }
  function finish() {
    detach();
    picking = null;
    hideOutline();
  }
  function cancel() {
    if (!picking) return;
    finish();
    onCancel?.();
  }

  docs.forEach((doc) => {
    doc.addEventListener('mousemove', onMove, { capture: true, passive: true });
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('keydown', onKey, true);
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick'].forEach((type) => doc.addEventListener(type, swallow, true));
  });
  picking = { cancel, timer: setTimeout(cancel, PICK_TIMEOUT_MS) };
  return cancel;
}

function portalPickCancel() {
  if (picking) picking.cancel();
}

export const portalServices = {
  portalLoad,
  portalHref,
  portalWidgetLive,
  portalWidgetDetail,
  portalReloadWithDebugInfo,
  portalSnapshotSave,
  portalSnapshotGet,
  portalSnapshotClear,
  portalHighlight,
  portalUnhighlight,
  portalReveal,
  portalPick,
  portalPickCancel,
};

// Called once from src/content/featureStartup.js when the page loads. Nothing runs until the panel is opened.
export function install() {}
