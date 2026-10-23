// Portal inspector: the pure half. Which widgets are on a Service Portal page and where they sit, what a widget's
// scripts touch, which keys of `c.data` changed between two snapshots, and the links a developer wants next to a widget.
// No DOM globals, no network and no chrome.*, so all of it is unit-tested (tests/portalinspector.test.js). It works on
// a document-like object handed in by the caller. The instance half is src/content/portalInspector.js; reading the
// Angular scope is src/lib/portalScope.js (shared with the page-world bridge).

import { widgetIdFromClasses, instanceIdFromId, portalFromUrl, parseWorkspaceUrl, isSysId, isName, recordPath } from './xray.js';
import { analyzeScripts, scriptIncludeCalls, stripComments } from './impact.js';
import { isSecretKey } from './portalScope.js';

export { serialize, validateTarget, findTargetElement, isSecretKey, LIMITS, MARK } from './portalScope.js';

const toList = (v) => Array.from(v || []);
const upper = (v) => String(v || '').toUpperCase();

// ---- What kind of page is this ----------------------------------------------------------------------------------

/** The page's URL parameters, in order, with secret-looking ones hidden. */
export function urlParams(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return [];
  }
  const out = [];
  url.searchParams.forEach((value, name) => {
    if (out.length >= 40) return;
    const secret = isSecretKey(name);
    out.push({ name: name.slice(0, 80), value: secret ? '[hidden]' : value.slice(0, 200), secret });
  });
  return out;
}

const NOT_PORTAL = 'This is not a Service Portal page.';
const COMMON_SUFFIXES = new Set(['sp', 'esc', 'csm', 'hrsd', 'ec']);

/**
 * Which kind of page the URL and the page content describe.
 *   portal        widgets found
 *   portal-empty  looks like a portal page (URL or markup) but no widget was found: still loading, or hidden by Angular
 *   workspace     Next Experience / UI Builder / workspace page
 *   classic       classic form, list or other .do page
 *   other         anything else
 * @returns {{ kind: string, suffix: string, pageId: string, message: string, hint: string }}
 */
export function classifyPage({ href = '', widgetCount = 0, hasMarkup = false } = {}) {
  const portal = portalFromUrl(href);
  const base = { suffix: portal?.suffix || '', pageId: portal?.pageId || '' };
  if (widgetCount > 0) return { kind: 'portal', ...base, message: '', hint: '' };
  if (portal && (portal.pageId || hasMarkup || COMMON_SUFFIXES.has(portal.suffix.toLowerCase()))) {
    return {
      kind: 'portal-empty',
      ...base,
      message: 'This looks like a Service Portal page, but no widgets were found on it yet.',
      hint: 'The page may still be loading. Refresh the list in a moment. A page made of Next Experience components, or a portal that lazy-loads its widgets, can also show none.',
    };
  }
  if (hasMarkup) {
    return { kind: 'portal-empty', ...base, message: 'This looks like a Service Portal page, but no widgets were found on it yet.', hint: 'Refresh the list once the page has finished loading.' };
  }
  let path = '';
  try {
    path = new URL(href).pathname;
  } catch {
    path = '';
  }
  if (parseWorkspaceUrl(href)) {
    return {
      kind: 'workspace',
      ...base,
      message: NOT_PORTAL,
      hint: 'Next Experience and workspace pages are built from UI Builder components, not portal widgets. Open a portal page such as /sp?id=index or /esc to use this tool.',
    };
  }
  if (/\.do\b|\/classic\b/i.test(path)) {
    return {
      kind: 'classic',
      ...base,
      message: NOT_PORTAL,
      hint: 'This is a classic ServiceNow page (a form, a list or another .do page). Open a portal page such as /sp?id=index or /esc to use this tool.',
    };
  }
  return {
    kind: 'other',
    ...base,
    message: NOT_PORTAL,
    hint: 'No portal widgets were found here. Open a portal page such as /sp?id=index or /esc to use this tool.',
  };
}

// ---- Finding the widgets on the page ----------------------------------------------------------------------------

const COLUMN_CLASS = /^col-(?:xs|sm|md|lg|xl)-\d{1,2}$/;

function instanceNear(el) {
  for (let node = el, depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
    const id = instanceIdFromId(node.id);
    if (id) return id;
  }
  return '';
}

function placementOf(el, rows) {
  let column = null;
  for (let node = el, depth = 0; node && depth < 25; depth += 1, node = node.parentElement) {
    if (!column) column = toList(node.classList).find((token) => COLUMN_CLASS.test(token)) || null;
    if (upper(node.tagName) === 'SP-PAGE-ROW') {
      const index = rows.indexOf(node);
      return { row: index >= 0 ? index + 1 : null, column };
    }
  }
  return { row: null, column };
}

/** "Row 2, col-md-6", or '' when nothing is known. */
export function placementLabel(placement) {
  const parts = [];
  if (placement?.row) parts.push(`row ${placement.row}`);
  if (placement?.column) parts.push(placement.column);
  const text = parts.join(', ');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

const contains = (outer, inner) => {
  if (outer === inner) return true;
  if (typeof outer.contains === 'function') return outer.contains(inner);
  for (let node = inner.parentElement; node; node = node.parentElement) if (node === outer) return true;
  return false;
};

/**
 * Every widget on the page, in page order. A widget root is the element carrying the class v<widget sys_id> (the same
 * marker Page X-ray uses); the instance id comes from the nearest ancestor id x<instance sys_id>. Instance wrappers and
 * <sp-widget> elements with no such class are found too, so a widget is not missed when its CSS class is absent.
 * Each result carries the element (`el`), a unique `key`, and the `target` address the page-world bridge understands.
 */
export function discoverWidgets(doc, { limit = 30000 } = {}) {
  const nodes = toList(doc?.querySelectorAll?.('[class], [id^="x"], sp-widget')).slice(0, limit);
  const rows = toList(doc?.querySelectorAll?.('sp-page-row'));
  const seenClass = new Map();
  const roots = [];
  const rootOf = new Map();
  const instanceOnly = [];
  const spElements = [];

  nodes.forEach((el, order) => {
    if (upper(el.tagName) === 'SP-WIDGET') spElements.push({ el, order, spIndex: spElements.length });
    const widgetId = widgetIdFromClasses(el.classList);
    if (widgetId) {
      const nth = seenClass.get(widgetId) || 0;
      seenClass.set(widgetId, nth + 1);
      // The same marker on a descendant of a root of the same widget is the same widget, not another one.
      for (let node = el.parentElement, depth = 0; node && depth < 30; depth += 1, node = node.parentElement) {
        if (rootOf.get(node)?.widgetId === widgetId) return;
      }
      const root = { el, order, widgetId, instanceId: instanceNear(el), nth, spIndex: -1 };
      roots.push(root);
      rootOf.set(el, root);
      return;
    }
    if (instanceIdFromId(el.id)) instanceOnly.push({ el, order });
  });

  // An instance id belongs to the first root under it; a nested widget does not inherit its parent's.
  const used = new Set();
  roots.forEach((root) => {
    if (root.instanceId && used.has(root.instanceId)) root.instanceId = '';
    if (root.instanceId) used.add(root.instanceId);
  });

  instanceOnly.forEach(({ el, order }) => {
    const instanceId = instanceIdFromId(el.id);
    if (used.has(instanceId)) return;
    if (roots.some((root) => contains(el, root.el) || contains(root.el, el))) return;
    used.add(instanceId);
    roots.push({ el, order, widgetId: '', instanceId, nth: 0, spIndex: -1 });
  });

  spElements.forEach(({ el, order, spIndex }) => {
    if (roots.some((root) => contains(el, root.el) || contains(root.el, el))) return;
    roots.push({ el, order, widgetId: '', instanceId: '', nth: 0, spIndex });
  });

  roots.sort((a, b) => a.order - b.order);
  const perWidget = new Map();
  roots.forEach((root) => {
    if (root.widgetId) perWidget.set(root.widgetId, (perWidget.get(root.widgetId) || 0) + 1);
  });
  const keys = new Set();
  return roots.map((root) => {
    let key = root.instanceId || (root.widgetId ? `${root.widgetId}#${root.nth}` : `sp-widget#${root.spIndex}`);
    while (keys.has(key)) key += '+';
    keys.add(key);
    return {
      key,
      el: root.el,
      widgetId: root.widgetId,
      instanceId: root.instanceId,
      tag: String(root.el.tagName || '').toLowerCase(),
      instances: root.widgetId ? perWidget.get(root.widgetId) : 1,
      placement: placementOf(root.el, rows),
      target: { widgetId: root.widgetId, instanceId: root.instanceId, nth: root.nth, spIndex: root.spIndex },
    };
  });
}

/** The deepest widget root that holds `node` (for "pick a widget on the page"), or null. */
export function widgetAt(widgets, node) {
  let best = null;
  widgets.forEach((widget) => {
    if (contains(widget.el, node) && (!best || contains(best.el, widget.el))) best = widget;
  });
  return best;
}

/** What to call a widget in the list: its name, else its id, else the start of its sys_id. */
export function widgetLabel(widget) {
  return widget?.name || widget?.id || (widget?.widgetId ? `Widget ${widget.widgetId.slice(0, 8)}` : widget?.instanceId ? `Instance ${widget.instanceId.slice(0, 8)}` : 'Widget');
}

/** Widgets whose name, id, sys_id or place contain every word of `query`. */
export function matchWidgets(widgets, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return widgets;
  return widgets.filter((w) => {
    const hay = [w.name, w.id, w.widgetId, w.instanceId, w.title, placementLabel(w.placement)].join(' ').toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

// ---- Links ------------------------------------------------------------------------------------------------------

const listPath = (table, query) => `/${table}_list.do?sysparm_query=${encodeURIComponent(query)}`;

/**
 * The links worth having next to a widget. Only values that look like a sys_id / table name / page id are used, so
 * nothing from the page can turn a link into something else.
 * @returns {Array<{ id: string, label: string, href: string, title: string }>}
 */
export function widgetLinks({ widgetId = '', instanceId = '', instanceTable = 'sp_instance', pageSysId = '', pageId = '', portalSysId = '' } = {}) {
  const links = [];
  const add = (id, label, href, title) => href && links.push({ id, label, href, title });
  if (isSysId(widgetId)) {
    add('widget', 'Widget record', recordPath('sp_widget', widgetId), 'Open the sp_widget record');
    add('editor', 'Widget Editor', `/sp_config?id=widget_editor&sys_id=${widgetId.toLowerCase()}`, 'Open the widget in the Widget Editor (server script, client controller, HTML and CSS)');
  }
  if (isSysId(instanceId)) add('instance', 'Instance record', recordPath(isName(instanceTable) ? instanceTable : 'sp_instance', instanceId), 'Open the widget instance (its options and position on the page)');
  if (isSysId(widgetId)) add('instances', 'Where it is used', listPath('sp_instance', `sp_widget=${widgetId.toLowerCase()}`), 'List every instance of this widget on every page');
  if (isSysId(pageSysId)) add('page', 'Page record', recordPath('sp_page', pageSysId), 'Open the sp_page record');
  if (/^[\w.-]{1,100}$/.test(pageId)) add('pageEditor', 'Page Editor', `/sp_config?id=page_edit&p=${encodeURIComponent(pageId)}`, 'Open this page in the Page Editor');
  if (isSysId(portalSysId)) add('portal', 'Portal record', recordPath('sp_portal', portalSysId), 'Open the sp_portal record');
  return links;
}

// ---- What a widget's code touches -------------------------------------------------------------------------------

/** sp_widget columns read for the code summary. Missing ones are reported, never guessed. */
export const WIDGET_FIELDS = ['sys_id', 'name', 'id', 'script', 'client_script', 'template', 'css', 'option_schema', 'data_table', 'link', 'roles', 'public', 'sys_updated_on', 'sys_updated_by'];
/** sp_instance columns read for the selected widget. */
export const INSTANCE_FIELDS = ['sys_id', 'sp_widget', 'title', 'sys_class_name', 'widget_parameters', 'sys_updated_on'];

const lineAt = (text, index) => {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
};

const MAX_LINES = 6;

/** Matches of `re` (global) in `text` grouped by the captured name: Map<name, { name, count, lines }>. */
function collect(text, re, group, into = new Map()) {
  for (const m of text.matchAll(re)) {
    const name = m[group];
    if (!name) continue;
    if (!into.has(name)) into.set(name, { name, count: 0, lines: [] });
    const entry = into.get(name);
    entry.count += 1;
    const line = lineAt(text, m.index);
    if (entry.lines.length < MAX_LINES && !entry.lines.includes(line)) entry.lines.push(line);
  }
  return into;
}

const byName = (a, b) => a.name.localeCompare(b.name);
const list = (map, cap = 60) => [...map.values()].sort(byName).slice(0, cap);

const GLIDE_TABLE = /\bnew\s+(?:(?:global|x_[a-z0-9_]+|sn_[a-z0-9_]+)\s*\.\s*)?(GlideRecordSecure|GlideRecord|GlideAggregate|GlideQuery)\s*\(\s*(['"])([A-Za-z0-9_]+)\2/g;
const GLIDE_ANY = /\bnew\s+(?:(?:global|x_[a-z0-9_]+|sn_[a-z0-9_]+)\s*\.\s*)?(?:GlideRecordSecure|GlideRecord|GlideAggregate|GlideQuery)\s*\(/g;
const PROPERTY = /\bgs\s*\.\s*getProperty\s*\(\s*(['"])([^'"\n]{1,200})\1/g;
const HAS_ROLE = /\bgs\s*\.\s*hasRole\s*\(\s*(['"])([^'"\n]{1,100})\1/g;
const SP_CALL = /\$sp\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const SP_PARAM = /\$sp\s*\.\s*getParameter\s*\(\s*(['"])([^'"\n]{1,100})\1/g;
const SP_EMBED = /\$sp\s*\.\s*getWidget\s*\(\s*(['"])([^'"\n]{1,100})\1/g;
const INPUT_ACTION = /\binput\s*\.\s*action\s*(?:===?|!==?)\s*(['"])([^'"\n]{1,80})\1/g;
const SWITCH_ACTION = /\bswitch\s*\(\s*input\s*\.\s*action\s*\)/;
const CASE_LABEL = /\bcase\s+(['"])([^'"\n]{1,80})\1\s*:/g;
const INPUT_FIELD = /\binput\s*\.\s*([A-Za-z_$][\w$]*)/g;
const OPTION_READ = /(?<![\w$.])options\s*\.\s*([A-Za-z_$][\w$]*)/g;
const DATA_ACCESS = /(?<![\w$.])data\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(['"])([\w$.-]{1,80})\2\s*\])/g;
const DATA_ASSIGNED = /^\s*(?:=(?![=>])|\+=|-=|\+\+|--|\.\s*push\s*\(|\.\s*unshift\s*\(|\.\s*[A-Za-z_$][\w$]*\s*=(?![=>])|\[[^\]\n]{0,80}\]\s*=(?![=>]))/;
const CLIENT_SERVER = /(?<![\w$])(?:c\s*\.\s*)?server\s*\.\s*(get|update|refresh)\s*\(/g;
const CLIENT_ACTION = /(?<![\w$.])action\s*:\s*(['"])([^'"\n]{1,80})\1/g;
const SP_UTIL = /(?<![\w$.])spUtil\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const NG_EVENT = /\$(?:rootScope|scope)\s*\.\s*\$(broadcast|emit|on)\s*\(\s*(['"])([^'"\n]{1,100})\2/g;
const CLIENT_DATA = /(?<![\w$.])(?:(?:c|this|\$scope)\s*\.\s*)?data\s*\.\s*([A-Za-z_$][\w$]*)/g;
const TEMPLATE_DATA = /(?<![\w$.])(?:c\s*\.\s*)?data\s*\.\s*([A-Za-z_$][\w$]*)/g;
const EMBEDDED = /<widget\b[^>]*?\bid\s*=\s*(['"])([^'"{}\n]{1,100})\1/gi;
/** Properties that are not widget data: never reported as missing. */
const INTRINSIC_DATA = new Set(['$$hashKey', 'length', 'hasOwnProperty']);
const NG_INCLUDE = /\bng-include\s*=\s*["']\s*['"]?([\w./-]{1,200})/gi;

function tablesFrom(source) {
  const text = stripComments(source);
  const found = new Map();
  for (const m of text.matchAll(GLIDE_TABLE)) {
    const table = m[3];
    if (!found.has(table)) found.set(table, { table, classes: new Set(), ops: new Set(), fields: new Set(), lines: [], writes: false });
    const entry = found.get(table);
    entry.classes.add(m[1]);
    const line = lineAt(text, m.index);
    if (entry.lines.length < MAX_LINES && !entry.lines.includes(line)) entry.lines.push(line);
  }
  // Operations and fields set, from the shared script analysis (it only reports tables it saw an operation on).
  const analysis = analyzeScripts([{ text: source, field: 'script' }]);
  analysis.tables.forEach((t) => {
    const entry = found.get(t.table);
    if (!entry) return;
    t.ops.forEach((op) => entry.ops.add(op));
    t.fields.forEach((f) => entry.fields.add(f));
  });
  const dynamic = [...text.matchAll(GLIDE_ANY)].length - [...text.matchAll(GLIDE_TABLE)].length;
  const tables = [...found.values()]
    .map((t) => ({
      table: t.table,
      classes: [...t.classes].sort(),
      ops: ['read', 'insert', 'update', 'delete'].filter((op) => t.ops.has(op)),
      fields: [...t.fields].sort().slice(0, 30),
      lines: t.lines,
      writes: ['insert', 'update', 'delete'].some((op) => t.ops.has(op)),
    }))
    .sort((a, b) => a.table.localeCompare(b.table));
  return { tables, dynamicTables: Math.max(0, dynamic), events: analysis.events.map((e) => ({ name: e.name, lines: e.where.map((w) => w.line).slice(0, MAX_LINES) })) };
}

/** Keys the server script assigns on `data` (data.x = ..., data.x.push(...), data['x'] = ...), first line each. */
function assignedDataKeys(source) {
  const text = stripComments(source);
  const keys = new Map();
  for (const m of text.matchAll(DATA_ACCESS)) {
    const name = m[1] || m[3];
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 100);
    if (!DATA_ASSIGNED.test(after)) continue;
    if (!keys.has(name)) keys.set(name, { name, line: lineAt(text, m.index) });
  }
  return [...keys.values()].slice(0, 80);
}

/** Names a script reads from `data` (c.data.x, data.x), whether or not it is assigned. */
function dataNames(text, re) {
  const names = new Set();
  for (const m of text.matchAll(re)) names.add(m[1]);
  return names;
}

/** The widget's option schema as a list, or { error } when it is not the JSON array ServiceNow writes. */
export function parseOptionSchema(raw) {
  const text = String(raw || '').trim();
  if (!text) return { options: [], error: '' };
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return { options: [], error: 'The option schema is not a list.' };
    const options = parsed
      .filter((o) => o && typeof o === 'object' && typeof o.name === 'string')
      .slice(0, 100)
      .map((o) => ({
        name: o.name,
        label: typeof o.label === 'string' ? o.label : '',
        type: typeof o.type === 'string' ? o.type : 'string',
        section: typeof o.section === 'string' ? o.section : '',
        hint: typeof o.hint === 'string' ? o.hint.slice(0, 200) : '',
        defaultValue: o.default_value ?? o.value ?? '',
      }));
    return { options, error: '' };
  } catch {
    return { options: [], error: 'The option schema is not valid JSON.' };
  }
}

/** The option schema next to the live options: which options differ from their default, and options with no schema entry. */
export function annotateOptions(schema, live) {
  const current = live && typeof live === 'object' && !Array.isArray(live) ? live : {};
  const text = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const rows = (schema?.options || []).map((o) => {
    const has = Object.prototype.hasOwnProperty.call(current, o.name);
    const value = has ? current[o.name] : undefined;
    return { ...o, current: value, present: has, differs: has && text(value) !== text(o.defaultValue) };
  });
  const known = new Set(rows.map((r) => r.name));
  const extra = Object.keys(current)
    .filter((name) => !known.has(name))
    .slice(0, 50)
    .map((name) => ({ name, current: current[name] }));
  return { rows, extra };
}

/**
 * What a widget's code touches, from its sp_widget record: tables, Script Includes, properties, $sp calls, the actions
 * the client sends and the server handles, the keys of c.data it builds and the keys the page uses. Everything comes
 * from reading the source text (comments ignored), so dynamic names are counted but not resolved.
 */
export function analyzeWidget(record) {
  const r = record || {};
  const script = String(r.script || '');
  const client = String(r.client_script || '');
  const template = String(r.template || '');
  const css = String(r.css || '');
  const serverText = stripComments(script);
  const clientText = stripComments(client);

  const tables = script ? tablesFrom(script) : { tables: [], dynamicTables: 0, events: [] };
  const actions = collect(serverText, INPUT_ACTION, 2);
  if (SWITCH_ACTION.test(serverText)) collect(serverText, CASE_LABEL, 2, actions);
  const inputFields = collect(serverText, INPUT_FIELD, 1);
  inputFields.delete('action');
  const setKeys = assignedDataKeys(script);

  const server = {
    present: Boolean(script.trim()),
    lines: script ? script.split('\n').length : 0,
    tables: tables.tables,
    dynamicTables: tables.dynamicTables,
    events: tables.events,
    scriptIncludes: script ? scriptIncludeCalls(script) : [],
    properties: list(collect(serverText, PROPERTY, 2)),
    roles: list(collect(serverText, HAS_ROLE, 2)),
    spCalls: list(collect(serverText, SP_CALL, 1)),
    urlParamsRead: list(collect(serverText, SP_PARAM, 2)),
    embeddedWidgets: list(collect(serverText, SP_EMBED, 2)),
    inputActions: list(actions),
    inputFields: list(inputFields, 30),
    dataKeys: setKeys,
    optionsRead: list(collect(serverText, OPTION_READ, 1), 40),
  };

  const sends = collect(clientText, CLIENT_ACTION, 2);
  collect(template, CLIENT_ACTION, 2, sends); // ng-click="c.server.get({action: 'x'})" in the HTML
  const serverCalls = collect(clientText, CLIENT_SERVER, 1);
  const events = [];
  for (const m of clientText.matchAll(NG_EVENT)) {
    const role = m[1] === 'on' ? 'listens' : 'sends';
    if (!events.some((e) => e.name === m[3] && e.role === role)) events.push({ name: m[3], role, line: lineAt(clientText, m.index) });
  }
  const clientSetKeys = new Set();
  for (const m of clientText.matchAll(CLIENT_DATA)) {
    const after = clientText.slice(m.index + m[0].length, m.index + m[0].length + 100);
    if (DATA_ASSIGNED.test(after)) clientSetKeys.add(m[1]);
  }
  const clientInfo = {
    present: Boolean(client.trim()),
    lines: client ? client.split('\n').length : 0,
    serverCalls: list(serverCalls),
    actionsSent: list(sends),
    events: events.slice(0, 30),
    scriptIncludes: client ? scriptIncludeCalls(client).filter((s) => s.via === 'GlideAjax') : [],
    spUtil: list(collect(clientText, SP_UTIL, 1)),
    usesHttp: /(?<![\w$.])\$http\b/.test(clientText),
  };

  const templateInfo = {
    present: Boolean(template.trim()),
    lines: template ? template.split('\n').length : 0,
    embeddedWidgets: list(collect(template, EMBEDDED, 2)),
    includes: list(collect(template, NG_INCLUDE, 1), 20),
  };

  // Keys the HTML or client script read from c.data that nothing in the widget sets. A hint: another widget or a
  // dynamic data[key] assignment could still set them.
  const dynamicKeys = /(?<![\w$.])data\s*\[\s*[^'"\s\]]/.test(serverText) || /\bObject\s*\.\s*assign\s*\(\s*data\b|\bdata\s*=\s*[^=]/.test(serverText);
  const setAll = new Set([...setKeys.map((k) => k.name), ...clientSetKeys]);
  const used = new Set([...dataNames(template, TEMPLATE_DATA), ...dataNames(clientText, CLIENT_DATA)]);
  const notSet = server.present && !dynamicKeys ? [...used].filter((name) => !setAll.has(name) && !INTRINSIC_DATA.has(name)).sort().slice(0, 40) : [];

  const handled = new Set(actions.keys());
  const sentNames = new Set(sends.keys());
  const hints = {
    dataNotSet: notSet,
    dynamicDataKeys: dynamicKeys,
    actionsNotHandled: server.present && (clientInfo.present || templateInfo.present) ? [...sentNames].filter((a) => !handled.has(a)).sort() : [],
    actionsNeverSent: server.present && (clientInfo.present || templateInfo.present) ? [...handled].filter((a) => !sentNames.has(a)).sort() : [],
  };

  return {
    server,
    client: clientInfo,
    template: templateInfo,
    css: { present: Boolean(css.trim()), chars: css.length },
    link: { present: Boolean(String(r.link || '').trim()) },
    hints,
    optionSchema: parseOptionSchema(r.option_schema),
    dataTable: typeof r.data_table === 'string' ? r.data_table : '',
  };
}

// ---- Comparing two snapshots ------------------------------------------------------------------------------------

/** A short display string for one value: strings quoted and cut, containers summarised. */
export function shortValue(v, max = 80) {
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).length} key${Object.keys(v).length === 1 ? '' : 's'}}`;
  const text = typeof v === 'string' ? JSON.stringify(v) : String(v);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

const isContainer = (v) => v !== null && typeof v === 'object';

const same = (a, b) => (isContainer(a) || isContainer(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b);
const hasKey = (container, key) => (Array.isArray(container) ? key < container.length : Object.prototype.hasOwnProperty.call(container, key));

/**
 * Which values changed between two serialised snapshots, as a list of paths:
 *   { path: 'results[2].state', kind: 'changed' | 'added' | 'removed', before, after }
 * A whole object or list that appeared or went away is one entry (the top of it), not one per leaf. `before` / `after`
 * are display strings. At most `max` entries; `more` counts the rest.
 */
export function diffValues(before, after, { max = 200 } = {}) {
  const entries = [];
  function walk(a, b, path, depth) {
    if (isContainer(a) && isContainer(b) && Array.isArray(a) === Array.isArray(b) && depth < 12) {
      const isArray = Array.isArray(a);
      const keys = isArray ? Array.from({ length: Math.max(a.length, b.length) }, (_, i) => i) : [...new Set([...Object.keys(a), ...Object.keys(b)])];
      keys.forEach((key) => {
        const child = isArray ? `${path}[${key}]` : path ? `${path}.${key}` : String(key);
        const inA = hasKey(a, key);
        const inB = hasKey(b, key);
        if (inA && !inB) entries.push({ path: child, kind: 'removed', before: shortValue(a[key]), after: '' });
        else if (!inA && inB) entries.push({ path: child, kind: 'added', before: '', after: shortValue(b[key]) });
        else walk(a[key], b[key], child, depth + 1);
      });
      return;
    }
    if (!same(a, b)) entries.push({ path: path || '(whole value)', kind: 'changed', before: shortValue(a), after: shortValue(b) });
  }
  walk(before, after, '', 0);
  entries.sort((x, y) => x.path.localeCompare(y.path, undefined, { numeric: true }));
  return { entries: entries.slice(0, max), more: Math.max(0, entries.length - max), total: entries.length };
}

/** "3 changed, 1 added" or "No changes". */
export function diffSummary(diff) {
  if (!diff || !diff.total) return 'No changes';
  const counts = { changed: 0, added: 0, removed: 0 };
  diff.entries.forEach((e) => (counts[e.kind] += 1));
  const parts = ['changed', 'added', 'removed'].filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`);
  return diff.more ? `${parts.join(', ')} (and ${diff.more} more)` : parts.join(', ');
}

/** The text Copy JSON puts on the clipboard. */
export function jsonText(value) {
  try {
    return JSON.stringify(value === undefined ? null : value, null, 2);
  } catch {
    return '';
  }
}

/** A tree node is "special" when serialize() replaced a value with a marker the tree shows in a quieter style. */
export function isMarker(value) {
  return typeof value === 'string' && /^(?:\[hidden\]|fn\(\)|\[circular\]|\[truncated\]|\[unreadable\]|\[(?:element|window|angular scope|promise|typed array|object|array|Map|Set)[^\]]*\]|\[\+\d+ more items\])$/.test(value);
}

// ---- Why a widget's data cannot be shown ------------------------------------------------------------------------

/** One plain sentence for each reason the page-world bridge gives for not returning a widget scope. */
export function scopeExplanation(reason, info = {}) {
  switch (reason) {
    case 'no-debug-info':
      return 'Angular debug info is switched off on this page, so the widget data cannot be read. Production portals usually turn it off. Reload the page with debug info to read it.';
    case 'no-angular':
      return 'This page does not load AngularJS, so there is no widget scope to read.';
    case 'no-scope':
      return 'Angular debug info is on, but no scope was found for this widget. It may still be loading, or it has no client controller. Try Refresh in a moment.';
    case 'no-element':
      return 'This widget is no longer on the page. Refresh the list.';
    case 'no-frame':
      return 'The frame that holds the portal could not be reached.';
    case 'bridge-error':
      return `The page did not answer (${info.error || 'no reason given'}).`;
    default:
      return '';
  }
}
