// Page X-ray: "what is this on my screen and what controls it?"
//
// Annotates ServiceNow pages in place while it is switched on (palette command or Alt+Shift+X):
//   - classic forms: a chip on every field label with its name, type and how much logic touches it
//   - lists: the column names on the headers
//   - catalog item forms: variable names, types and catalog logic
//   - Service Portal: hover outline on widgets with their name, id and record links
// The details live in the sidebar 'xray' panel (src/sidebar/XrayPanel.jsx), fed by `xrayServices`.
//
// Rules this file keeps: nothing is fetched until the user turns X-ray on or opens the panel; every
// query is capped and conditions only use columns verified against sys_dictionary; page DOM is
// touched only through elements marked data-msb-xray plus one <style>, all removed on toggle off;
// mutation handling is throttled and ignores our own nodes. Read-only throughout.
// The pure half (indexing, condition evaluation, cause ranking) is src/lib/xray.js.

import { queryTable, queryInChunks, queryAll } from './tableApi.js';
import { callPage } from './pageBridge.js';
import { detectListInfo, detectPageContext } from './context.js';
import { tableHierarchy } from './fieldInspector.js';
import { copyText } from './quickActions.js';
import { explainQuery } from '../lib/query.js';
import { sendFrameHotkey } from '../lib/hotkeyRelay.js';
import {
  isSysId,
  isName,
  isFieldPath,
  parsePrefixedId,
  ioIdsIn,
  rowSysId,
  widgetIdFromClasses,
  instanceIdFromId,
  portalFromUrl,
  parseWorkspaceUrl,
  catalogItemFromUrl,
  buildFieldIndex,
  countEntry,
  summarizeEntry,
  catalogVariableIndex,
  variableTypeName,
  rankCauses,
  shortType,
  recordPath,
  fillUnknownState,
  tagPlacement,
} from '../lib/xray.js';

const ATTR = 'data-msb-xray';
const STYLE_ID = 'msb-xray-style';
const FLASH_CLASS = 'msb-xray-flash';
const HOTKEY_LABEL = 'Alt+Shift+X';
const TICK_MS = 1500;
const OBSERVE_MS = 600;
const CACHE_MS = 5 * 60 * 1000;
const SHELL_RETRY_MS = 5000;
const SHELL_MAX_NODES = 6000;

// Row caps for every query this feature makes.
const LIMITS = {
  dictionary: 1000,
  clientScripts: 200,
  uiPolicies: 200,
  policyActions: 1000, // per chunk of 40 policies, paged
  dataPolicies: 100,
  dataRules: 1000, // per chunk of 40 data policies, paged
  businessRules: 200,
  acls: 400,
  overrides: 300,
  variables: 300,
  catalogScripts: 150,
  catalogPolicies: 150,
  widgets: 100,
  rows: 2000,
};

const flat = (v) => (v && typeof v === 'object' ? String(v.value ?? v.display_value ?? '') : v == null ? '' : String(v));
const flatDisplay = (v) => (v && typeof v === 'object' ? String(v.display_value || v.value || '') : v == null ? '' : String(v));
const bool = (v) => {
  const s = flat(v).toLowerCase();
  return s === 'true' ? true : s === 'false' ? false : null;
};
const errorText = (err) => (err && err.message) || String(err);

// --- State ------------------------------------------------------------------------------------

const state = {
  installed: false,
  on: false,
  sidebar: null,
  toast: null,
  timer: null,
  href: '',
  docs: new Map(), // doc -> { observer, timer }
  portal: null, // { doc, detach() }
  shellFrame: null,
  shellSearchedAt: 0,
  requested: new Set(), // cache keys whose chips refresh is wired
};
const listeners = new Set();

function status() {
  return { on: state.on, hotkey: HOTKEY_LABEL };
}

function notify() {
  listeners.forEach((fn) => {
    try {
      fn(status());
    } catch {
      // A closed panel; ignore.
    }
  });
}

// --- Cache ------------------------------------------------------------------------------------

const cache = new Map(); // key -> { at, promise }
const settled = new Map(); // key -> resolved value, for synchronous reads by the chips

const MAX_CACHE_KEYS = 60; // about 15 tables (hierarchy, dictionary, logic, index each); script bodies add up

function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  cache.delete(key); // re-inserted below, so Map order stays oldest-first
  while (cache.size >= MAX_CACHE_KEYS) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
    settled.delete(oldest);
  }
  const promise = Promise.resolve()
    .then(load)
    .then((value) => {
      settled.set(key, value);
      return value;
    });
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

function clearCache() {
  cache.clear();
  settled.clear();
  state.requested.clear();
}

// --- Column verification ----------------------------------------------------------------------
// ServiceNow silently ignores a condition on a column that does not exist and returns every row, so
// every column used in a query condition here is checked against sys_dictionary first (one query per
// session). Parents are listed where the column is inherited.

// ui_type / global / view are only read, but they decide whether a script or policy runs on this form,
// so they are honoured only when the column is confirmed (otherwise the row counts as "every view, desktop").
const COLUMN_SPEC = {
  sys_script_client: { parents: [], cols: ['table', 'active', 'ui_type', 'global', 'view'] },
  sys_ui_policy: { parents: [], cols: ['table', 'active', 'ui_type', 'global', 'view'] },
  sys_ui_policy_action: { parents: [], cols: ['ui_policy'] },
  sys_data_policy2: { parents: [], cols: ['model_table', 'active'] },
  sys_data_policy_rule: { parents: [], cols: ['sys_data_policy'] },
  sys_script: { parents: [], cols: ['collection', 'active'] },
  sys_security_acl: { parents: [], cols: ['name', 'active'] },
  sys_dictionary_override: { parents: [], cols: ['name'] },
  item_option_new: { parents: ['question'], cols: ['cat_item', 'variable_set', 'name'] },
  catalog_script_client: { parents: ['sys_script_client'], cols: ['cat_item', 'variable_set', 'active'] },
  catalog_ui_policy: { parents: ['sys_ui_policy'], cols: ['catalog_item', 'variable_set', 'active'] },
  catalog_ui_policy_action: { parents: ['sys_ui_policy_action'], cols: ['ui_policy'] },
  sp_page: { parents: [], cols: ['id'] },
  sp_portal: { parents: [], cols: ['url_suffix'] },
};

function columnIndex() {
  return cached('columns', async () => {
    const tables = new Set();
    const cols = new Set();
    Object.entries(COLUMN_SPEC).forEach(([table, spec]) => {
      tables.add(table);
      spec.parents.forEach((p) => tables.add(p));
      spec.cols.forEach((c) => cols.add(c));
    });
    try {
      const rows = await queryTable('sys_dictionary', `nameIN${[...tables].join(',')}^elementIN${[...cols].join(',')}`, ['name', 'element'], { limit: 1000 });
      if (!rows.length) return null;
      const found = new Map();
      rows.forEach((r) => {
        const t = flat(r.name);
        if (!found.has(t)) found.set(t, new Set());
        found.get(t).add(flat(r.element));
      });
      return found;
    } catch {
      return null; // no dictionary access: fall back to probing the table itself
    }
  });
}

/** True when every column exists on the table (or a listed parent). */
async function verified(table, cols) {
  const index = await columnIndex();
  if (index) {
    const own = [table, ...(COLUMN_SPEC[table]?.parents || [])];
    return cols.every((c) => own.some((t) => index.get(t)?.has(c)));
  }
  // The Table API leaves unknown columns out of a row, so one row tells which columns exist.
  try {
    const rows = await cached(`probe:${table}:${cols.join(',')}`, () => queryTable(table, '', cols, { limit: 1 }));
    return rows.length > 0 && cols.every((c) => c in rows[0]);
  } catch {
    return false;
  }
}

async function activeClause(table) {
  return (await verified(table, ['active'])) ? '^active=true' : '';
}

/** Query with verified condition columns; failures and skips become notes instead of errors. */
async function guardedQuery(label, table, required, query, fields, options, notes) {
  if (!(await verified(table, required))) {
    notes.push(`Skipped ${label}: ${table}.${required.join('/')} was not found on this instance.`);
    return [];
  }
  try {
    return await queryTable(table, query, fields, options);
  } catch (err) {
    notes.push(`Could not read ${label}: ${errorText(err)}`);
    return [];
  }
}

function capNote(rows, limit, label, capped) {
  if (rows.length >= limit) capped.push(`${label} (first ${limit})`);
}

/** Rows whose `column` is one of `ids`, a chunk of ids at a time, paged in a stable order; reports any cap. */
async function rowsForIds(table, column, ids, fields, { label, onCap, chunkSize = 40, perChunk = 1000 }) {
  const out = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    // eslint-disable-next-line no-await-in-loop -- sequential chunks keep the load on the instance low.
    const rows = await queryAll(table, `${column}IN${chunk.join(',')}^ORDERBY${column}^ORDERBYsys_id`, fields, { max: perChunk, pageSize: 500 });
    out.push(...rows);
    if (rows.length >= perChunk) onCap(`${label} (first ${perChunk} for ${chunk.length} parent records)`);
  }
  return out;
}

/** View name of a policy/script row: the dot-walked name when "view" is a reference, else the stored text. */
const viewName = (r) => flat(r['view.name']) || (isSysId(flat(r.view)) ? '' : flat(r.view));

/** Which "where does it run" columns can be trusted on a table (unconfirmed = desktop, every view). */
async function scopeColumns(table) {
  const [uiType, global, view] = await Promise.all([verified(table, ['ui_type']), verified(table, ['global']), verified(table, ['view'])]);
  return { uiType, global, view };
}

function runsWhere(r, cols) {
  return {
    uiType: cols.uiType ? flat(r.ui_type) : '',
    global: cols.global ? bool(r.global) !== false : true,
    view: cols.view ? viewName(r) : '',
  };
}

// --- Table data ---------------------------------------------------------------------------------

function hierarchy(table) {
  return cached(`h:${table}`, () => tableHierarchy(table).catch(() => [table]));
}

const DICT_FIELDS = [
  'sys_id', 'name', 'element', 'column_label', 'internal_type', 'reference', 'max_length', 'mandatory', 'read_only',
  'default_value', 'choice', 'calculation', 'virtual', 'attributes', 'active', 'dependent', 'dependent_on_field',
  'use_dependent_field', 'reference_qual', 'reference_qual_condition', 'use_reference_qualifier', 'dynamic_ref_qual', 'display',
];

function normalizeDictionary(r) {
  const choice = flat(r.choice);
  const virtual = bool(r.virtual) === true;
  return {
    sysId: flat(r.sys_id),
    name: flat(r.element),
    label: flat(r.column_label),
    type: flat(r.internal_type),
    reference: flat(r.reference),
    maxLength: flat(r.max_length),
    mandatory: bool(r.mandatory) === true,
    readOnly: bool(r.read_only) === true,
    defaultValue: flat(r.default_value),
    choiceType: choice && choice !== '0' ? choice : '',
    calculated: virtual,
    calculation: virtual ? flat(r.calculation) : '',
    attributes: flat(r.attributes),
    active: bool(r.active) !== false,
    dependent: flat(r.dependent),
    dependentOnField: flat(r.dependent_on_field),
    useDependent: bool(r.use_dependent_field) === true,
    referenceQual: flat(r.reference_qual),
    referenceQualCondition: flat(r.reference_qual_condition),
    useReferenceQualifier: flat(r.use_reference_qualifier),
    dynamicRefQual: flat(r.dynamic_ref_qual),
    display: bool(r.display) === true,
    definedOn: flat(r.name),
  };
}

/** Dictionary of a table including inherited columns: { table, tables, fields: Map<name, column> }. */
function loadDictionary(table) {
  return cached(`dict:${table}`, async () => {
    const tables = await hierarchy(table);
    const rows = await queryTable('sys_dictionary', `nameIN${tables.join(',')}^elementISNOTEMPTY`, DICT_FIELDS, { limit: LIMITS.dictionary });
    const fields = new Map();
    rows.forEach((r) => {
      const column = normalizeDictionary(r);
      const existing = fields.get(column.name);
      // A column redefined on a child table wins over the parent's definition.
      if (!existing || tables.indexOf(column.definedOn) < tables.indexOf(existing.definedOn)) fields.set(column.name, column);
    });
    return { table, tables, fields };
  });
}

async function fetchClientScripts(list, notes, capped) {
  const active = await activeClause('sys_script_client');
  const rows = await guardedQuery(
    'client scripts',
    'sys_script_client',
    ['table'],
    `tableIN${list}${active}^ORDERBYname`,
    ['sys_id', 'name', 'type', 'field', 'table', 'script', 'ui_type', 'active', 'inherited', 'global', 'view', 'view.name', 'sys_class_name'],
    { limit: LIMITS.clientScripts },
    notes
  );
  capNote(rows, LIMITS.clientScripts, 'client scripts', capped);
  const cols = await scopeColumns('sys_script_client');
  return rows
    .filter((r) => bool(r.active) !== false)
    .map((r) => ({
      sysId: flat(r.sys_id),
      name: flat(r.name),
      type: flat(r.type),
      field: flat(r.field),
      table: flat(r.table),
      script: flat(r.script),
      inherited: bool(r.inherited),
      ...runsWhere(r, cols),
      recordTable: flat(r.sys_class_name) || 'sys_script_client',
    }));
}

async function fetchUiPolicies(list, notes, capped) {
  const active = await activeClause('sys_ui_policy');
  const rows = await guardedQuery(
    'UI policies',
    'sys_ui_policy',
    ['table'],
    `tableIN${list}${active}^ORDERBYorder`,
    ['sys_id', 'short_description', 'table', 'conditions', 'on_load', 'reverse_if_false', 'order', 'run_scripts', 'script_true', 'script_false', 'inherit', 'global', 'view', 'view.name', 'ui_type', 'active', 'sys_class_name'],
    { limit: LIMITS.uiPolicies },
    notes
  );
  capNote(rows, LIMITS.uiPolicies, 'UI policies', capped);
  const cols = await scopeColumns('sys_ui_policy');
  const policies = rows.filter((r) => bool(r.active) !== false).map((r) => ({
    sysId: flat(r.sys_id),
    name: flat(r.short_description),
    table: flat(r.table),
    conditions: flat(r.conditions),
    onLoad: bool(r.on_load) !== false,
    reverseIfFalse: bool(r.reverse_if_false) !== false,
    order: flat(r.order),
    runScripts: bool(r.run_scripts) === true,
    scriptTrue: flat(r.script_true),
    scriptFalse: flat(r.script_false),
    inherit: bool(r.inherit),
    ...runsWhere(r, cols),
    recordTable: flat(r.sys_class_name) || 'sys_ui_policy',
    actions: [],
  }));
  const ids = policies.map((p) => p.sysId).filter(isSysId);
  if (ids.length && (await verified('sys_ui_policy_action', ['ui_policy']))) {
    try {
      const actions = await rowsForIds('sys_ui_policy_action', 'ui_policy', ids, ['sys_id', 'ui_policy', 'field', 'mandatory', 'visible', 'disabled', 'cleared'], { label: 'UI policy actions', onCap: (m) => capped.push(m), perChunk: LIMITS.policyActions });
      const byPolicy = new Map(policies.map((p) => [p.sysId, p]));
      actions.forEach((a) => {
        byPolicy.get(flat(a.ui_policy))?.actions.push({ sysId: flat(a.sys_id), field: flat(a.field), mandatory: flat(a.mandatory), visible: flat(a.visible), disabled: flat(a.disabled), cleared: flat(a.cleared) });
      });
    } catch (err) {
      notes.push(`Could not read UI policy actions: ${errorText(err)}`);
    }
  } else if (ids.length) {
    notes.push('Skipped UI policy actions: sys_ui_policy_action.ui_policy was not found on this instance.');
  }
  return policies;
}

async function fetchDataPolicies(list, notes, capped) {
  const active = await activeClause('sys_data_policy2');
  const rows = await guardedQuery(
    'data policies',
    'sys_data_policy2',
    ['model_table'],
    `model_tableIN${list}${active}`,
    ['sys_id', 'short_description', 'model_table', 'conditions', 'enforce_ui', 'inherit', 'active'],
    { limit: LIMITS.dataPolicies },
    notes
  );
  capNote(rows, LIMITS.dataPolicies, 'data policies', capped);
  const policies = rows.filter((r) => bool(r.active) !== false).map((r) => ({
    sysId: flat(r.sys_id),
    name: flat(r.short_description),
    table: flat(r.model_table),
    conditions: flat(r.conditions),
    enforceUi: bool(r.enforce_ui),
    inherit: bool(r.inherit),
    recordTable: 'sys_data_policy2',
    rules: [],
  }));
  const ids = policies.map((p) => p.sysId).filter(isSysId);
  if (ids.length && (await verified('sys_data_policy_rule', ['sys_data_policy']))) {
    try {
      const rules = await rowsForIds('sys_data_policy_rule', 'sys_data_policy', ids, ['sys_id', 'sys_data_policy', 'field', 'mandatory', 'disabled'], { label: 'data policy rules', onCap: (m) => capped.push(m), perChunk: LIMITS.dataRules });
      const byPolicy = new Map(policies.map((p) => [p.sysId, p]));
      rules.forEach((r) => byPolicy.get(flat(r.sys_data_policy))?.rules.push({ sysId: flat(r.sys_id), field: flat(r.field), mandatory: flat(r.mandatory), disabled: flat(r.disabled) }));
    } catch (err) {
      notes.push(`Could not read data policy rules: ${errorText(err)}`);
    }
  }
  return policies;
}

async function fetchBusinessRules(list, notes, capped) {
  const active = await activeClause('sys_script');
  const rows = await guardedQuery(
    'business rules',
    'sys_script',
    ['collection'],
    `collectionIN${list}${active}^ORDERBYorder`,
    ['sys_id', 'name', 'collection', 'when', 'order', 'script', 'condition', 'filter_condition', 'action_insert', 'action_update', 'action_delete', 'action_query', 'active'],
    { limit: LIMITS.businessRules },
    notes
  );
  capNote(rows, LIMITS.businessRules, 'business rules', capped);
  return rows
    .filter((r) => bool(r.active) !== false)
    .map((r) => ({
      sysId: flat(r.sys_id),
      name: flat(r.name),
      table: flat(r.collection),
      when: flat(r.when),
      order: flat(r.order),
      script: flat(r.script),
      condition: flat(r.condition),
      filterCondition: flat(r.filter_condition),
      operations: ['insert', 'update', 'delete', 'query'].filter((op) => bool(r[`action_${op}`]) === true),
      recordTable: 'sys_script',
    }));
}

async function fetchAcls(tables, notes, capped) {
  if (!tables.every(isName)) return [];
  const active = await activeClause('sys_security_acl');
  // Wildcard "*.<field>" ACLs are left out: they sort first and would use up the cap (the access debugger covers them).
  const query = `nameIN${tables.join(',')}${tables.map((t) => `^ORnameSTARTSWITH${t}.`).join('')}${active}^ORDERBYname`;
  const rows = await guardedQuery(
    'ACLs',
    'sys_security_acl',
    ['name'],
    query,
    ['sys_id', 'name', 'operation', 'type', 'active', 'admin_overrides', 'advanced', 'description'],
    { limit: LIMITS.acls, displayValue: true },
    notes
  );
  capNote(rows, LIMITS.acls, 'ACLs', capped);
  const named = (v) => (isSysId(flat(v)) ? flatDisplay(v) : flat(v));
  return rows
    .filter((r) => bool(r.active) !== false)
    .map((r) => ({
      sysId: flat(r.sys_id),
      name: flat(r.name),
      operation: named(r.operation),
      type: named(r.type),
      adminOverrides: bool(r.admin_overrides) !== false,
      advanced: bool(r.advanced) === true,
      description: flat(r.description),
      recordTable: 'sys_security_acl',
    }))
    .filter((acl) => !acl.type || /record/i.test(acl.type));
}

async function fetchOverrides(list, notes) {
  const rows = await guardedQuery(
    'dictionary overrides',
    'sys_dictionary_override',
    ['name'],
    `nameIN${list}`,
    [
      'sys_id', 'name', 'base_table', 'element', 'mandatory_override', 'mandatory', 'read_only_override', 'read_only',
      'default_value_override', 'default_value', 'reference_qual_override', 'reference_qual', 'attributes_override', 'attributes',
      'calculation_override', 'calculation', 'dependent_override', 'dependent', 'display_override', 'display',
    ],
    { limit: LIMITS.overrides },
    notes
  );
  // "<x>_override" says the override is in force; the value sits in "<x>". Without the flag column only a
  // value that is set (true / non-empty) counts, so a default "false" never silences the dictionary.
  const pick = (r, key, read = flat) => {
    const flag = bool(r[`${key}_override`]);
    if (flag === false) return null;
    const value = read(r[key]);
    if (flag === null && (value === null || value === '' || value === false)) return null;
    return value;
  };
  return rows.map((r) => ({
    sysId: flat(r.sys_id),
    table: flat(r.name),
    baseTable: flat(r.base_table),
    element: flat(r.element),
    mandatory: pick(r, 'mandatory', bool),
    readOnly: pick(r, 'read_only', bool),
    defaultValue: pick(r, 'default_value'),
    referenceQual: pick(r, 'reference_qual'),
    attributes: pick(r, 'attributes'),
    calculation: pick(r, 'calculation'),
    dependent: pick(r, 'dependent'),
    display: pick(r, 'display', bool),
  }));
}

/** Every artifact on a table and its parents that can touch a field. */
function loadLogic(table) {
  return cached(`logic:${table}`, async () => {
    const tables = await hierarchy(table);
    const notes = [];
    const capped = [];
    const list = tables.join(',');
    const [clientScripts, uiPolicies, dataPolicies, businessRules, acls, overrides] = await Promise.all([
      fetchClientScripts(list, notes, capped),
      fetchUiPolicies(list, notes, capped),
      fetchDataPolicies(list, notes, capped),
      fetchBusinessRules(list, notes, capped),
      fetchAcls(tables, notes, capped),
      fetchOverrides(list, notes),
    ]);
    return { table, tables, clientScripts, uiPolicies, dataPolicies, businessRules, acls, overrides, notes, capped };
  });
}

/** Dictionary + logic + the field index built from them. */
function loadIndex(table) {
  return cached(`index:${table}`, async () => {
    const [dict, logic] = await Promise.all([loadDictionary(table), loadLogic(table)]);
    const index = buildFieldIndex(logic, [...dict.fields.keys()]);
    return { dict, logic, index };
  });
}

// --- Documents --------------------------------------------------------------------------------

/** The classic frame inside the Next Experience shell, which lives in shadow DOM. Bounded search, cached. */
function shellDocument() {
  if (!window.location.pathname.startsWith('/now/')) return null;
  let frame = state.shellFrame;
  if (!frame || !frame.isConnected) {
    frame = null;
    if (Date.now() - state.shellSearchedAt > SHELL_RETRY_MS) {
      state.shellSearchedAt = Date.now();
      frame = findShellFrame();
    }
    state.shellFrame = frame;
  }
  try {
    return frame?.contentDocument || null;
  } catch {
    return null;
  }
}

function findShellFrame() {
  const roots = [document];
  const frames = [];
  let visited = 0;
  while (roots.length && visited < SHELL_MAX_NODES) {
    const root = roots.shift();
    const direct = root.querySelector('iframe#gsft_main, iframe[name="gsft_main"]');
    if (direct) return direct;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node && visited < SHELL_MAX_NODES; node = walker.nextNode()) {
      visited += 1;
      if (node.shadowRoot) roots.push(node.shadowRoot);
      if (node.tagName === 'IFRAME') frames.push(node);
    }
  }
  // No named frame: take a same-origin frame showing a classic .do page.
  return (
    frames.find((f) => {
      try {
        return /\.do$/i.test(f.contentWindow?.location?.pathname || '');
      } catch {
        return false;
      }
    }) || null
  );
}

/** Documents that may hold ServiceNow UI: the page, the classic gsft_main frame, the shell's classic frame. */
export function xrayDocuments() {
  const docs = [document];
  try {
    const frame = document.getElementById('gsft_main');
    if (frame?.contentDocument) docs.push(frame.contentDocument);
  } catch {
    // Cross-origin frame; nothing to read.
  }
  const shell = shellDocument();
  if (shell && !docs.includes(shell)) docs.push(shell);
  return docs.filter((d) => d && d.documentElement);
}

function docHref(doc) {
  try {
    return doc.defaultView?.location?.href || window.location.href;
  } catch {
    return window.location.href;
  }
}

/** First parseable classic form element in a document, or null. */
function firstFormElement(doc) {
  const nodes = doc.querySelectorAll('[id^="element."]');
  for (let i = 0; i < nodes.length && i < 80; i += 1) {
    const parsed = parsePrefixedId(nodes[i].id, 'element.');
    if (parsed && !parsed.io) return parsed;
  }
  const label = doc.querySelector('label[id^="label."]');
  const parsed = label && parsePrefixedId(label.id, 'label.');
  return parsed && !parsed.io ? parsed : null;
}

function docKind(doc) {
  if (!doc?.body) return null;
  if (firstFormElement(doc)) return 'form';
  if (doc.querySelector('tr[sys_id], table.list_table, th.list_header_cell[name]')) return 'list';
  return null;
}

function formTable(doc) {
  const target = doc.querySelector('input[name="sys_target"], #sys_target')?.value;
  if (isName(target)) return target;
  const counts = new Map();
  const nodes = doc.querySelectorAll('[id^="element."]');
  for (let i = 0; i < nodes.length && i < 200; i += 1) {
    const parsed = parsePrefixedId(nodes[i].id, 'element.');
    if (parsed?.table) counts.set(parsed.table, (counts.get(parsed.table) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  const ctx = detectPageContext();
  return isName(ctx?.table) ? ctx.table : '';
}

function listTable(doc) {
  const attr = doc.querySelector('table[glide_table]')?.getAttribute('glide_table');
  if (isName(attr)) return attr;
  const row = doc.querySelector('tr[id^="row_"]');
  const match = row && /^row_([a-z0-9_]+)_[0-9a-f]{32}$/i.exec(row.id);
  if (match) return match[1];
  const ctx = detectPageContext();
  return isName(ctx?.table) ? ctx.table : '';
}

/** Text of an element without our chips. */
function ownText(el) {
  let text = '';
  el.childNodes.forEach((node) => {
    if (node.nodeType === 3) text += node.nodeValue;
    // Our own chips and the field-name badges of the Names toggle live inside labels; they are not the label's text.
    else if (node.nodeType === 1 && !node.hasAttribute(ATTR) && !node.hasAttribute('data-msb-inline')) text += ownText(node);
  });
  return text.replace(/\s+/g, ' ').trim();
}

// --- Page styles and chips ----------------------------------------------------------------------

// Fixed colours that read on both the light and dark ServiceNow themes: white on graphite (14:1),
// amber count badge with near-black text (12:1), magenta outline with a white halo (3:1+ on either).
const PAGE_CSS = `
.msb-xray-chip{all:initial;visibility:inherit!important;box-sizing:border-box!important;display:inline-flex!important;align-items:center;gap:4px;max-width:100%;margin:0 0 0 6px!important;padding:0 6px!important;border-radius:4px!important;background:#1f2933!important;color:#fff!important;font:500 10.5px/17px ui-monospace,"Cascadia Code",Consolas,Menlo,monospace!important;letter-spacing:0!important;text-transform:none!important;vertical-align:middle;white-space:nowrap;cursor:pointer;box-shadow:0 0 0 1px rgba(255,255,255,.45);user-select:none;overflow:hidden}
.msb-xray-chip:hover{background:#34444f!important}
.msb-xray-chip>span{all:initial;visibility:inherit!important;font:inherit!important;color:inherit!important;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
.msb-xray-chip>.msb-xray-chip__type{color:#b9c7d3!important;flex-shrink:20}
.msb-xray-chip>.msb-xray-chip__count{flex-shrink:0;padding:0 5px!important;border-radius:8px;background:#ffd166!important;color:#1a1a1a!important;font-weight:700!important}
.msb-xray-chip>.msb-xray-chip__count:empty,.msb-xray-chip>.msb-xray-chip__type:empty{display:none}
.msb-xray-chip--col{margin:3px 0 0!important}
.msb-xray-outline{position:fixed;display:none;box-sizing:border-box;pointer-events:none;z-index:2147482000;border:2px solid #d6006f;border-radius:4px;box-shadow:0 0 0 1px #fff,inset 0 0 0 1px #fff}
.msb-xray-tag,.msb-xray-badge{position:fixed;box-sizing:border-box;z-index:2147482001;padding:3px 8px;background:#1f2933;color:#fff;font:500 12px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;letter-spacing:0;text-transform:none}
.msb-xray-tag{display:none;max-width:min(620px,calc(100vw - 16px));border-radius:0 0 6px 0}
.msb-xray-badge{left:12px;bottom:12px;max-width:calc(100vw - 24px);border-radius:6px}
.msb-xray-tag b,.msb-xray-badge b{font-weight:700;color:#fff}
.msb-xray-tag code,.msb-xray-badge code{font:500 11px ui-monospace,Consolas,Menlo,monospace;color:#b9c7d3;margin-left:6px}
.msb-xray-tag,.msb-xray-badge{pointer-events:none}
.msb-xray-tag a,.msb-xray-badge a,.msb-xray-tag button,.msb-xray-badge button{pointer-events:auto;margin-left:9px;padding:0;border:0;background:none;color:#ffd166;font:inherit;text-decoration:underline;cursor:pointer}
.msb-xray-tag a:focus-visible,.msb-xray-badge a:focus-visible,.msb-xray-tag button:focus-visible,.msb-xray-badge button:focus-visible{outline:2px solid #ffd166;outline-offset:1px}
.${FLASH_CLASS}{outline:3px solid #d6006f!important;outline-offset:2px!important}
`;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute(ATTR, 'style');
  style.textContent = PAGE_CSS;
  (doc.head || doc.documentElement).appendChild(style);
}

function makeChip(doc, data, onActivate) {
  const chip = doc.createElement('span');
  chip.setAttribute(ATTR, 'chip');
  chip.className = `msb-xray-chip${data.kind === 'col' ? ' msb-xray-chip--col' : ''}`;
  chip.setAttribute('role', 'button');
  chip.tabIndex = -1; // the sidebar panel is the keyboard path; chips stay out of the form's tab order
  Object.entries(data).forEach(([key, value]) => {
    if (value) chip.dataset[key] = value;
  });
  const name = doc.createElement('span');
  name.className = 'msb-xray-chip__name';
  name.textContent = data.label || data.field || data.column || 'variable';
  const type = doc.createElement('span');
  type.className = 'msb-xray-chip__type';
  const count = doc.createElement('span');
  count.className = 'msb-xray-chip__count';
  chip.append(name, type, count);
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  chip.addEventListener('mousedown', (event) => event.stopPropagation());
  chip.addEventListener('click', (event) => {
    swallow(event); // a chip sits inside a label or list header: no focus jump, no sort
    onActivate(chip);
  });
  return chip;
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function setTitle(el, text) {
  if (el.getAttribute('title') !== text) el.setAttribute('title', text);
  if (el.getAttribute('aria-label') !== text) el.setAttribute('aria-label', text);
}

function refreshChips(doc) {
  doc.querySelectorAll(`[${ATTR}="chip"]`).forEach((chip) => {
    const d = chip.dataset;
    const [, typeEl, countEl] = chip.children;
    if (d.kind === 'field') {
      const dict = settled.get(`dict:${d.table}`);
      const loaded = settled.get(`index:${d.table}`);
      const failed = failures.get(d.table);
      const column = dict?.fields.get(d.field);
      const entry = loaded?.index.fields.get(d.field);
      const total = loaded ? countEntry(entry).total : 0;
      setText(typeEl, d.field.includes('.') ? 'dot-walk' : shortType(column));
      setText(countEl, total ? String(total) : '');
      const summary = failed ? `Could not load logic: ${failed}` : loaded ? summarizeEntry(entry) : 'Loading logic...';
      setTitle(chip, `${d.table}.${d.field}${column ? ` (${column.type}${column.reference ? ` to ${column.reference}` : ''})` : ''}. ${summary}. Click for details.`);
    } else if (d.kind === 'var') {
      const info = variableInfo.get(d.io);
      if (info) {
        setText(chip.children[0], info.name);
        setText(typeEl, info.typeName);
        setText(countEl, info.total ? String(info.total) : '');
      }
      setTitle(chip, info ? `Variable ${info.name} (${info.typeName || 'type unknown'}). ${info.summary}. Click for details.` : 'Catalog variable. Loading...');
    } else if (d.kind === 'col') {
      const column = settled.get(`dict:${d.table}`)?.fields.get(d.column);
      setText(typeEl, d.column.includes('.') ? 'dot-walk' : shortType(column) || d.glideType || '');
      setTitle(chip, `${d.column}${column ? ` (${column.type})` : ''}. Click to copy the column name.`);
    }
  });
}

function refreshAll() {
  if (!state.on) return;
  xrayDocuments().forEach((doc) => {
    try {
      refreshChips(doc);
    } catch {
      // The frame navigated away mid-refresh.
    }
  });
}

const failures = new Map(); // table -> error text, for the chip tooltips

/** Start loading what the chips of a table need; refreshes chips when each part arrives. */
function want(key, load, table) {
  if (state.requested.has(key)) return;
  state.requested.add(key);
  load()
    .then(refreshAll)
    .catch((err) => {
      if (table) failures.set(table, errorText(err));
      refreshAll();
    });
}

// --- Annotation -------------------------------------------------------------------------------

/** { table, field } from a classic label/element id, tolerating "ni." / "sys_display." style inner prefixes. */
function formFieldFromId(id, prefix) {
  const parsed = parsePrefixedId(id, prefix);
  if (parsed && ['ni', 'sys_display', 'sys_original', 'sys_readonly'].includes(parsed.table)) return parsePrefixedId(`${prefix}${parsed.field}`, prefix);
  return parsed;
}

/**
 * Every classic form label with the field it names. Older releases id labels "label.<table>.<field>";
 * newer ones only set `for="<table>.<field>"` (references use "sys_display.<table>.<field>").
 */
export function classicFormLabels(doc) {
  const hasText = (label) => {
    // Our own buttons and chips live inside labels; they are not the label's text.
    const walker = doc.createTreeWalker(label, 4, {
      acceptNode: (node) => (node.parentElement?.closest('[data-msb-inline],[data-msb-xray]') ? 2 : 1),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue.trim()) return true;
    return false;
  };
  // Checkboxes get two labels for one field (the text one and an empty "label.ni.<table>.<field>"): keep one.
  const byField = new Map();
  doc.querySelectorAll('label[id^="label."], label[for]').forEach((label) => {
    // Newer releases: the field is named by the wrapping "element.<table>.<field>" container. A bare for= is not
    // enough: related-list row checkboxes use for="check_<table>.<...>.<sys_id>" and look like fields.
    const group = !label.id.startsWith('label.') && label.closest('[id^="element."]');
    const parsed = (label.id.startsWith('label.') && formFieldFromId(label.id, 'label.')) || (group && formFieldFromId(group.id, 'element.'));
    if (!parsed || parsed.io) return;
    const key = `${parsed.table}.${parsed.field}`;
    const kept = byField.get(key);
    if (!kept || (!kept.text && hasText(label))) byField.set(key, { label, parsed, text: hasText(label) });
  });
  return [...byField.values()].map(({ label, parsed }) => ({ label, parsed }));
}

function annotateForm(doc) {
  const table = formTable(doc);
  if (!table) return false;
  classicFormLabels(doc).forEach(({ label, parsed }) => {
    if (label.querySelector(`[${ATTR}]`)) return;
    if (parsed.table !== table) return;
    label.appendChild(makeChip(doc, { kind: 'field', table, field: parsed.field }, (chip) => openPanel(chip.dataset.field)));
  });
  want(`dict:${table}`, () => loadDictionary(table), table);
  want(`index:${table}`, () => loadIndex(table), table);
  return true;
}

function annotateList(doc) {
  const table = listTable(doc);
  let found = false;
  doc.querySelectorAll('th[name]').forEach((th) => {
    const column = th.getAttribute('name');
    if (!isFieldPath(column)) return;
    found = true;
    if (th.querySelector(`[${ATTR}]`)) return;
    th.appendChild(
      makeChip(doc, { kind: 'col', table, column, glideType: th.getAttribute('glide_type') || '' }, (chip) => {
        copyText(chip.dataset.column)
          .then(() => state.toast?.success(`Copied column name ${chip.dataset.column}`))
          .catch((err) => state.toast?.error(errorText(err)));
      })
    );
  });
  if (table && found) want(`dict:${table}`, () => loadDictionary(table), table);
  return found;
}

// Catalog variables: "IO:<sys_id>" ids on classic order forms and RITM variable editors, and
// (assumed) on portal form fields.
const variableInfo = new Map(); // io sys_id -> { name, typeName, total, summary }

function catalogAnchors(doc) {
  const anchors = new Map();
  doc.querySelectorAll('[id*="IO:"], label[for*="IO:"]').forEach((el) => {
    ioIdsIn(`${el.id} ${el.getAttribute('for') || ''}`).forEach((id) => {
      if (!anchors.has(id)) anchors.set(id, null);
    });
  });
  anchors.forEach((_, id) => {
    const label =
      doc.querySelector(`label[for="IO:${id}"], label[for="sp_formfield_IO:${id}"], [id="label_IO:${id}"]`) ||
      doc.querySelector(`[id="element.IO:${id}"] label, [id="element.IO:${id}"] .control-label`);
    anchors.set(id, label);
  });
  return anchors;
}

function annotateCatalog(doc) {
  const anchors = catalogAnchors(doc);
  if (!anchors.size) return false;
  anchors.forEach((label, io) => {
    if (!label || label.querySelector(`[${ATTR}]`)) return;
    label.appendChild(makeChip(doc, { kind: 'var', io }, (chip) => openPanel(`var:${variableInfo.get(chip.dataset.io)?.name || chip.dataset.io}`)));
  });
  const ids = [...anchors.keys()].sort();
  const item = catalogItemId(doc);
  want(`catalog:${item}:${ids.join(',')}`, () => loadCatalog(ids, item).then(fillVariableInfo));
  return true;
}

function fillVariableInfo(catalog) {
  catalog.variables.forEach((v) => {
    const entry = catalog.index.get(v.sysId);
    const cs = entry?.clientScripts.length || 0;
    const up = new Set((entry?.uiPolicies || []).map((r) => r.policy.sysId)).size;
    const parts = [cs && `${cs} catalog client script${cs === 1 ? '' : 's'}`, up && `${up} catalog UI polic${up === 1 ? 'y' : 'ies'}`].filter(Boolean);
    variableInfo.set(v.sysId, { name: v.name, typeName: v.typeName, total: cs + up, summary: parts.join(', ') || 'No catalog client scripts or UI policies found' });
  });
  return catalog;
}

function annotate(doc) {
  const kind = docKind(doc);
  let found = false;
  try {
    if (kind === 'form') found = annotateForm(doc);
    else if (kind === 'list') found = annotateList(doc);
    found = annotateCatalog(doc) || found;
  } catch (err) {
    console.warn('[NowBuddy] X-ray could not annotate the page', err);
  }
  if (found) {
    ensureStyle(doc);
    observe(doc);
    refreshChips(doc);
  }
  return found;
}

function isOwnRecord(record) {
  const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
  if (target?.closest?.(`[${ATTR}]`)) return true;
  const nodes = [...record.addedNodes, ...record.removedNodes];
  return nodes.length > 0 && nodes.every((n) => n.nodeType === 1 && n.hasAttribute(ATTR));
}

function observe(doc) {
  if (state.docs.has(doc) || !doc.body) return;
  const entry = { observer: null, timer: null };
  // This window's MutationObserver can watch a same-origin frame's nodes too.
  entry.observer = new MutationObserver((records) => {
    if (!state.on || entry.timer || records.every(isOwnRecord)) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (state.on && doc.defaultView) annotate(doc);
    }, OBSERVE_MS);
  });
  entry.observer.observe(doc.body, { childList: true, subtree: true });
  state.docs.set(doc, entry);
}

function forgetDoc(doc) {
  const entry = state.docs.get(doc);
  if (!entry) return;
  entry.observer?.disconnect();
  clearTimeout(entry.timer);
  state.docs.delete(doc);
}

// --- Service Portal ---------------------------------------------------------------------------

const widgetNames = new Map(); // widget sys_id -> { name, id }
const instanceInfo = new Map(); // instance sys_id -> { widget, title, table }

function isPortalDocument(doc) {
  if (doc.querySelector('sp-page-row, sp-widget, [ng-app*="$sp"], [data-ng-app*="$sp"]')) return true;
  const nodes = doc.querySelectorAll('div[class]');
  for (let i = 0; i < nodes.length && i < 3000; i += 1) if (widgetIdFromClasses(nodes[i].classList)) return true;
  return false;
}

function widgetRootOf(node) {
  let el = node?.nodeType === 1 ? node : node?.parentElement;
  for (let depth = 0; el && depth < 60; depth += 1, el = el.parentElement) {
    const widgetId = widgetIdFromClasses(el.classList);
    if (widgetId || el.tagName === 'SP-WIDGET') return { el, widgetId, instanceId: instanceNear(el) };
  }
  return null;
}

function instanceNear(el) {
  for (let node = el, depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
    const id = instanceIdFromId(node.id);
    if (id) return id;
  }
  return null;
}

/** Every widget on the portal page: Map<widget sys_id, { count, instances: Set }>. */
function collectWidgets(doc) {
  const widgets = new Map();
  const nodes = doc.querySelectorAll('[class]');
  for (let i = 0; i < nodes.length && i < 20000; i += 1) {
    const el = nodes[i];
    if (el.hasAttribute(ATTR)) continue;
    const widgetId = widgetIdFromClasses(el.classList);
    if (!widgetId) continue;
    if (!widgets.has(widgetId)) widgets.set(widgetId, { count: 0, instances: new Set() });
    const entry = widgets.get(widgetId);
    entry.count += 1;
    const instance = instanceNear(el);
    if (instance) entry.instances.add(instance);
  }
  return widgets;
}

const askedWidgets = new Set(); // sys_ids already looked up (found or not), so hovering never repeats a query

async function resolveWidgets(widgetIds, instanceIds) {
  const wanted = widgetIds.filter((id) => isSysId(id) && !widgetNames.has(id) && !askedWidgets.has(id)).slice(0, LIMITS.widgets);
  const inst = instanceIds.filter((id) => isSysId(id) && !instanceInfo.has(id) && !askedWidgets.has(id)).slice(0, LIMITS.widgets);
  [...wanted, ...inst].forEach((id) => askedWidgets.add(id));
  const [widgets, instances] = await Promise.all([
    wanted.length ? queryTable('sp_widget', `sys_idIN${wanted.join(',')}`, ['sys_id', 'name', 'id'], { limit: LIMITS.widgets }).catch(() => []) : [],
    inst.length ? queryTable('sp_instance', `sys_idIN${inst.join(',')}`, ['sys_id', 'sp_widget', 'title', 'sys_class_name'], { limit: LIMITS.widgets }).catch(() => []) : [],
  ]);
  widgets.forEach((w) => widgetNames.set(flat(w.sys_id), { name: flat(w.name), id: flat(w.id) }));
  instances.forEach((i) => instanceInfo.set(flat(i.sys_id), { widget: flat(i.sp_widget), title: flat(i.title), table: flat(i.sys_class_name) || 'sp_instance' }));
  // Instances whose widget class was not on the page still name their widget.
  const missing = [...new Set(instances.map((i) => flat(i.sp_widget)))].filter((id) => isSysId(id) && !widgetNames.has(id) && !askedWidgets.has(id));
  missing.forEach((id) => askedWidgets.add(id));
  if (missing.length) {
    const more = await queryTable('sp_widget', `sys_idIN${missing.join(',')}`, ['sys_id', 'name', 'id'], { limit: LIMITS.widgets }).catch(() => []);
    more.forEach((w) => widgetNames.set(flat(w.sys_id), { name: flat(w.name), id: flat(w.id) }));
  }
}

/** Portal record and page record for the URL: { portal: {sysId, title}, page: {sysId, id, title} }. */
function resolvePortalPage(portal) {
  return cached(`portal:${portal.suffix}:${portal.pageId}`, async () => {
    const out = { portal: null, page: null };
    if (await verified('sp_portal', ['url_suffix'])) {
      const rows = await queryTable('sp_portal', `url_suffix=${portal.suffix}`, ['sys_id', 'title', 'homepage'], { limit: 1 }).catch(() => []);
      if (rows[0]) out.portal = { sysId: flat(rows[0].sys_id), title: flat(rows[0].title), homepage: flat(rows[0].homepage) };
    }
    let pageQuery = '';
    if (isFieldPath(portal.pageId) && (await verified('sp_page', ['id']))) pageQuery = `id=${portal.pageId}`;
    else if (!portal.pageId && isSysId(out.portal?.homepage)) pageQuery = `sys_id=${out.portal.homepage}`;
    if (pageQuery) {
      const rows = await queryTable('sp_page', pageQuery, ['sys_id', 'id', 'title'], { limit: 1 }).catch(() => []);
      if (rows[0]) out.page = { sysId: flat(rows[0].sys_id), id: flat(rows[0].id), title: flat(rows[0].title) };
    }
    return out;
  });
}

function link(doc, text, href, title) {
  const a = doc.createElement('a');
  a.textContent = text;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (title) a.title = title;
  return a;
}

function widgetLinks(widgetId, instanceId) {
  const links = [];
  if (isSysId(widgetId)) {
    links.push(['Widget', recordPath('sp_widget', widgetId), 'Open the sp_widget record']);
    links.push(['Editor', `/sp_config?id=widget_editor&sys_id=${widgetId}`, 'Open in the Widget Editor']);
  }
  if (isSysId(instanceId)) {
    const table = instanceInfo.get(instanceId)?.table;
    links.push(['Instance', recordPath(isName(table) ? table : 'sp_instance', instanceId), 'Open the widget instance record']);
  }
  return links;
}

function attachPortal(doc, portal) {
  ensureStyle(doc);
  const outline = doc.createElement('div');
  outline.setAttribute(ATTR, 'outline');
  outline.className = 'msb-xray-outline';
  const tag = doc.createElement('div');
  tag.setAttribute(ATTR, 'tag');
  tag.className = 'msb-xray-tag';
  const badge = doc.createElement('div');
  badge.setAttribute(ATTR, 'badge');
  badge.className = 'msb-xray-badge';
  doc.body.append(outline, tag, badge);

  let current = null;
  let pending = null;
  let point = null;
  let frame = 0;
  const view = doc.defaultView || window;

  function renderBadge(info) {
    badge.replaceChildren();
    const b = doc.createElement('b');
    b.textContent = 'X-ray';
    const portalCode = doc.createElement('code');
    portalCode.textContent = `portal ${info?.portal?.title || portal.suffix}`;
    const pageCode = doc.createElement('code');
    pageCode.textContent = `page ${portal.pageId || info?.page?.id || 'home'}`;
    badge.append(b, portalCode, pageCode);
    if (info?.page?.sysId) {
      badge.append(link(doc, 'Page', recordPath('sp_page', info.page.sysId), 'Open the sp_page record'));
      badge.append(link(doc, 'Page editor', `/sp_config?id=page_edit&p=${encodeURIComponent(info.page.id)}`, 'Open the page in the Page Editor'));
    }
    if (info?.portal?.sysId) badge.append(link(doc, 'Portal', recordPath('sp_portal', info.portal.sysId), 'Open the sp_portal record'));
    const details = doc.createElement('button');
    details.type = 'button';
    details.textContent = 'All widgets';
    details.addEventListener('click', () => openPanel(''));
    badge.append(details);
  }

  function renderTag() {
    tag.replaceChildren();
    if (!current) return;
    const widgetId = current.widgetId || instanceInfo.get(current.instanceId)?.widget || '';
    const names = widgetNames.get(widgetId);
    // Widgets that appeared after the page loaded (portal navigation, lazy widgets) are looked up on first hover.
    const shown = current;
    const unknownWidget = widgetId && !names && !askedWidgets.has(widgetId);
    const unknownInstance = current.instanceId && !instanceInfo.has(current.instanceId) && !askedWidgets.has(current.instanceId);
    if (unknownWidget || unknownInstance) {
      resolveWidgets(widgetId ? [widgetId] : [], current.instanceId ? [current.instanceId] : [])
        .then(() => state.on && current === shown && renderTag())
        .catch(() => {});
    }
    const b = doc.createElement('b');
    b.textContent = names?.name || (widgetId ? `Widget ${widgetId.slice(0, 8)}...` : 'Widget');
    tag.append(b);
    if (names?.id) {
      const code = doc.createElement('code');
      code.textContent = names.id;
      tag.append(code);
    }
    widgetLinks(widgetId, current.instanceId).forEach(([text, href, title]) => tag.append(link(doc, text, href, title)));
    const more = doc.createElement('button');
    more.type = 'button';
    more.textContent = 'Details';
    more.addEventListener('click', () => openPanel(widgetId ? `widget:${widgetId}` : ''));
    tag.append(more);
  }

  function rectOf(el) {
    let r = el.getBoundingClientRect();
    if ((r.width < 2 || r.height < 2) && el.firstElementChild) r = el.firstElementChild.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 ? r : null;
  }

  function place() {
    const r = current && current.el.isConnected ? rectOf(current.el) : null;
    if (!r) {
      outline.style.display = 'none';
      tag.style.display = 'none';
      return;
    }
    outline.style.display = 'block';
    outline.style.top = `${r.top}px`;
    outline.style.left = `${r.left}px`;
    outline.style.width = `${r.width}px`;
    outline.style.height = `${r.height}px`;
    // The tag sits just outside the widget box (above it, or below when there is no room) so it never
    // covers the widget's own controls; only its links and buttons take clicks (see PAGE_CSS).
    tag.style.display = 'block';
    const spot = tagPlacement(r, tag.offsetHeight || 22, tag.offsetWidth || 0, { width: view.innerWidth, height: view.innerHeight });
    tag.style.top = `${spot.top}px`;
    tag.style.left = `${spot.left}px`;
    tag.style.borderRadius = { above: '6px 6px 0 0', below: '0 0 6px 6px' }[spot.side] || '0 0 6px 0';
  }

  // The pointer over the tag's text (which lets events through) still counts as "on the tag".
  function overTag() {
    if (!point || tag.style.display !== 'block') return false;
    const t = tag.getBoundingClientRect();
    return point.x >= t.left && point.x <= t.right && point.y >= t.top && point.y <= t.bottom;
  }

  function run() {
    frame = 0;
    if (pending) {
      const target = pending;
      pending = null;
      const own = target.nodeType === 1 && target.closest?.(`[${ATTR}]`);
      if (!own && !overTag()) {
        const found = widgetRootOf(target);
        if (!found) current = null;
        else if (!current || current.el !== found.el) {
          current = found;
          renderTag();
        }
      }
    }
    place();
  }

  const schedule = () => {
    if (!frame) frame = view.requestAnimationFrame(run);
  };
  const onOver = (event) => {
    pending = event.target;
    point = { x: event.clientX, y: event.clientY };
    schedule();
  };
  doc.addEventListener('mouseover', onOver, { capture: true, passive: true });
  view.addEventListener('scroll', schedule, { capture: true, passive: true });
  view.addEventListener('resize', schedule, { passive: true });

  renderBadge(null);
  resolvePortalPage(portal)
    .then((info) => state.on && renderBadge(info))
    .catch(() => {});
  const widgets = collectWidgets(doc);
  const instances = [...widgets.values()].flatMap((w) => [...w.instances]);
  resolveWidgets([...widgets.keys()], instances)
    .then(() => state.on && renderTag())
    .catch(() => {});

  return {
    doc,
    href: window.location.href,
    detach() {
      doc.removeEventListener('mouseover', onOver, { capture: true });
      view.removeEventListener('scroll', schedule, { capture: true });
      view.removeEventListener('resize', schedule);
      if (frame) view.cancelAnimationFrame(frame);
      outline.remove();
      tag.remove();
      badge.remove();
    },
  };
}

// --- On / off -----------------------------------------------------------------------------------

function scan() {
  const docs = xrayDocuments();
  let found = 0;
  docs.forEach((doc) => {
    if (annotate(doc)) found += 1;
  });
  [...state.docs.keys()].forEach((doc) => {
    if (!docs.includes(doc) || !doc.defaultView) forgetDoc(doc);
  });

  const portal = portalFromUrl(window.location.href);
  const isPortal = Boolean(portal && document.body && isPortalDocument(document));
  if (state.portal && (!isPortal || state.portal.href !== window.location.href)) {
    state.portal.detach();
    state.portal = null;
  }
  if (isPortal && !state.portal) state.portal = attachPortal(document, portal);
  return found + (state.portal ? 1 : 0);
}

function tick() {
  if (!state.on || document.hidden) return;
  // A frame that navigated away leaves a detached document behind: let it go.
  [...state.docs.keys()].forEach((doc) => {
    if (!doc.defaultView) forgetDoc(doc);
  });
  const docs = xrayDocuments();
  if (window.location.href !== state.href || docs.some((d) => !state.docs.has(d) && docKind(d))) {
    state.href = window.location.href;
    scan();
  }
}

function start() {
  state.on = true;
  state.href = window.location.href;
  const found = scan();
  state.timer = setInterval(tick, TICK_MS);
  if (found) {
    state.toast?.info(`X-ray on. Click a chip for details; ${HOTKEY_LABEL} turns it off.`);
  } else if (parseWorkspaceUrl(window.location.href)) {
    state.toast?.info('Workspace pages cannot be annotated. The X-ray panel lists the field logic instead.');
    openPanel('');
  } else {
    state.toast?.info(`X-ray on. It annotates forms, lists, catalog items and portal widgets as they appear; ${HOTKEY_LABEL} turns it off.`);
  }
}

function removeFrom(doc) {
  try {
    doc.querySelectorAll(`[${ATTR}]`).forEach((node) => node.remove());
    doc.querySelectorAll(`.${FLASH_CLASS}`).forEach((node) => node.classList.remove(FLASH_CLASS));
  } catch {
    // Document already gone.
  }
}

function stop() {
  state.on = false;
  clearInterval(state.timer);
  state.timer = null;
  if (state.portal) {
    state.portal.detach();
    state.portal = null;
  }
  const docs = new Set([...state.docs.keys(), ...xrayDocuments()]);
  [...state.docs.keys()].forEach(forgetDoc);
  docs.forEach(removeFrom);
  state.requested.clear();
  state.toast?.info('X-ray off.');
}

/** Turn the page X-ray on or off (no argument toggles). */
export function toggleXray(force) {
  const next = typeof force === 'boolean' ? force : !state.on;
  if (next !== state.on) {
    if (next) start();
    else stop();
    notify();
  }
  return status();
}

function openPanel(args) {
  if (!state.sidebar?.openPanel) {
    state.toast?.info('Turn on the sidebar in Options to see X-ray details.');
    return;
  }
  state.sidebar.openPanel('xray', { args });
}

function isXrayHotkey(event) {
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyX';
}

/** Top frame: remember the sidebar/toast, listen for Alt+Shift+X here and from sub-frames. */
export function installXray({ sidebar, toast } = {}) {
  state.sidebar = sidebar || state.sidebar;
  state.toast = toast || state.toast;
  if (state.installed) return;
  state.installed = true;
  document.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted || !isXrayHotkey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      toggleXray();
    },
    true
  );
  // Sub-frames relay through the service worker (never window.postMessage, which page scripts can forge).
  chrome.runtime?.onMessage?.addListener((message) => {
    if (message?.type === 'FRAME_HOTKEY' && message.action === 'xray') toggleXray();
  });
}

/** Sub-frames (classic gsft_main, the shell's frame): pass a real Alt+Shift+X up to the top frame. */
export function forwardXrayHotkey() {
  document.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted || !isXrayHotkey(event)) return;
      event.preventDefault();
      sendFrameHotkey({ action: 'xray' });
    },
    true
  );
}

// --- Reports for the sidebar panel -------------------------------------------------------------

/** A classic form field's state read from its markup, or null when the field has no container. */
function domFieldState(doc, table, field) {
  const key = `${table}.${field}`;
  const container = doc.getElementById(`element.${key}`);
  if (!container) return null;
  const input = doc.getElementById(key);
  const display = doc.getElementById(`sys_display.${key}`);
  const status = doc.getElementById(`status.${key}`);
  const style = container.style || {};
  return {
    value: input && 'value' in input ? String(input.value ?? '') : '',
    label: ownText(doc.getElementById(`label.${key}`) || container).slice(0, 80),
    mandatory: status?.getAttribute('mandatory') === 'true' || container.classList.contains('is-required'),
    readOnly: Boolean(doc.getElementById(`sys_readonly.${key}`)) || Boolean(input?.readOnly || input?.disabled || display?.readOnly || display?.disabled),
    visible: !(style.display === 'none' || style.visibility === 'hidden'),
  };
}

const STATE_KEYS = ['readOnly', 'visible', 'mandatory'];

async function liveForm(doc, table) {
  let live = null;
  try {
    const model = await callPage('getFormModel');
    if (model?.fields?.length && (!model.table || !table || model.table === table)) {
      const fields = new Map();
      model.fields.forEach((f) => fields.set(f.name, { value: f.value ?? '', label: f.label || '', mandatory: f.mandatory ?? null, readOnly: f.readOnly ?? null, visible: f.visible ?? null }));
      live = { source: 'g_form', sysId: model.sysId || '', isNewRecord: Boolean(model.isNewRecord), fields };
    }
  } catch {
    // Bridge unavailable (or no g_form reachable): read the DOM instead.
  }
  if (live) {
    // g_form.isReadOnly / isVisible are missing on some releases (null here): fill those gaps from the markup.
    if (doc && table) {
      let merged = false;
      live.fields.forEach((f, name) => {
        if (STATE_KEYS.every((k) => f[k] !== null)) return;
        const filled = fillUnknownState(f, domFieldState(doc, table, name));
        if (!filled.merged) return;
        live.fields.set(name, filled.state);
        merged = true;
      });
      if (merged) live.source = 'g_form+page';
    }
    return live;
  }
  if (!doc || !table) return null;
  const fields = new Map();
  doc.querySelectorAll(`[id^="element.${table}."]`).forEach((container) => {
    const parsed = parsePrefixedId(container.id, 'element.');
    if (!parsed || parsed.io) return;
    const state = domFieldState(doc, table, parsed.field);
    if (state) fields.set(parsed.field, state);
  });
  const sysId = doc.querySelector('input[name="sys_uniqueValue"]')?.value || '';
  return fields.size ? { source: 'page', sysId, isNewRecord: false, fields } : null;
}

/** The form view on screen ('' = default view), or null when it cannot be read. */
function formView(doc) {
  const valid = (v) => (typeof v === 'string' && /^[\w.-]*$/.test(v.trim()) ? v.trim() : null);
  const input = doc?.querySelector('input[name="sysparm_view"], #sysparm_view');
  if (input) return valid(input.value);
  try {
    const params = new URL(docHref(doc)).searchParams;
    if (params.has('sysparm_view')) return valid(params.get('sysparm_view') || '');
  } catch {
    // Not a URL we can read.
  }
  return null;
}

function readOnlyRatio(live) {
  if (!live?.fields.size) return null;
  const states = [...live.fields.values()].filter((f) => f.readOnly !== null);
  return states.length >= 5 ? states.filter((f) => f.readOnly).length / states.length : null;
}

function formDoc() {
  return xrayDocuments().find((doc) => docKind(doc) === 'form') || null;
}

function collectFormFields(doc, table) {
  const seen = new Set();
  const out = [];
  const add = (field, labelEl) => {
    if (!field || seen.has(field)) return;
    seen.add(field);
    out.push({ name: field, label: labelEl ? ownText(labelEl).slice(0, 80) : '' });
  };
  doc.querySelectorAll(`[id^="element.${table}."], label[id^="label.${table}."]`).forEach((el) => {
    const parsed = parsePrefixedId(el.id, el.id.startsWith('label.') ? 'label.' : 'element.');
    if (!parsed || parsed.io || parsed.table !== table) return;
    const target = `${table}.${parsed.field}`;
    add(parsed.field, doc.getElementById(`label.${target}`) || doc.querySelector(`label[for="${target}"], label[for="sys_display.${target}"]`));
  });
  return out;
}

function fieldRow(name, dict, index, label = '') {
  const column = dict?.fields.get(name);
  return {
    name,
    label: label || column?.label || '',
    type: name.includes('.') ? 'dot-walk' : shortType(column),
    rawType: column?.type || '',
    reference: column?.reference || '',
    counts: countEntry(index?.fields.get(name)),
  };
}

async function formReport(doc) {
  const table = formTable(doc);
  if (!table) return null;
  const onForm = collectFormFields(doc, table);
  const [loaded, live] = await Promise.all([loadIndex(table).catch((err) => ({ error: errorText(err) })), liveForm(doc, table)]);
  const { dict, index, logic } = loaded.error ? {} : loaded;
  const onFormNames = new Set(onForm.map((f) => f.name));
  const fields = onForm.map((f) => ({ ...fieldRow(f.name, dict, index, f.label), onForm: true, live: live?.fields.get(f.name) || null }));
  const otherColumns = dict
    ? [...dict.fields.keys()]
        .filter((name) => !onFormNames.has(name))
        .sort()
        .map((name) => ({ ...fieldRow(name, dict, index), onForm: false, live: null }))
    : [];
  return {
    table,
    sysId: live?.sysId || doc.querySelector('input[name="sys_uniqueValue"]')?.value || '',
    tables: dict?.tables || [table],
    liveSource: live?.source || null,
    fields,
    otherColumns,
    tableAcls: index?.tableAcls || [],
    notes: [...(loaded.error ? [`Could not load the table's logic: ${loaded.error}`] : []), ...(logic?.notes || [])],
    capped: logic?.capped || [],
  };
}

async function listReport(doc) {
  let info = null;
  try {
    info = await detectListInfo();
  } catch {
    // URL and DOM below.
  }
  const table = (isName(info?.table) && info.table) || listTable(doc);
  const query = info?.query ?? doc.querySelector('input[name="sysparm_query"]')?.value ?? '';
  const dict = table ? await loadDictionary(table).catch(() => null) : null;
  const seen = new Set();
  const columns = [];
  doc.querySelectorAll('th[name]').forEach((th) => {
    const name = th.getAttribute('name');
    if (!isFieldPath(name) || seen.has(name)) return;
    seen.add(name);
    const column = dict?.fields.get(name);
    columns.push({ name, label: ownText(th).slice(0, 80) || column?.label || '', type: name.includes('.') ? 'dot-walk' : shortType(column) || th.getAttribute('glide_type') || '' });
  });
  const ids = [];
  const idSet = new Set();
  let hidden = 0;
  doc.querySelectorAll('tr[sys_id], tr[id^="row_"]').forEach((row) => {
    if (ids.length >= LIMITS.rows) return;
    const id = rowSysId(row.getAttribute('sys_id'), row.id);
    if (!id || idSet.has(id)) return;
    idSet.add(id);
    if (!row.getClientRects().length) {
      hidden += 1;
      return;
    }
    ids.push(id);
  });
  return { table, query, explanation: explainQuery(query, { table }), columns, rowIds: ids, hiddenRows: hidden };
}

function catalogItemId(doc) {
  const fromUrl = catalogItemFromUrl(docHref(doc)) || catalogItemFromUrl(window.location.href);
  if (fromUrl) return fromUrl;
  const hidden = doc.querySelector('input[name="sysparm_id"], #sysparm_id')?.value;
  return isSysId(hidden) ? hidden.toLowerCase() : '';
}

/** Variables by sys_id plus the catalog client scripts and UI policies of their items and variable sets. */
function loadCatalog(ioIds, itemId) {
  return cached(`catalog:${itemId}:${ioIds.join(',')}`, async () => {
    const notes = [];
    const ids = ioIds.filter(isSysId).slice(0, LIMITS.variables);
    const rows = ids.length
      ? await queryInChunks('item_option_new', 'sys_id', ids, ['sys_id', 'name', 'question_text', 'type', 'cat_item', 'variable_set', 'mandatory', 'read_only', 'active', 'default_value', 'reference', 'order'], { chunkSize: 100, limit: LIMITS.variables }).catch((err) => {
          notes.push(`Could not read the variables: ${errorText(err)}`);
          return [];
        })
      : [];
    const order = new Map(ids.map((id, i) => [id, i]));
    const variables = rows
      .map((r) => ({
        sysId: flat(r.sys_id).toLowerCase(),
        name: flat(r.name),
        label: flat(r.question_text),
        type: flat(r.type),
        typeName: variableTypeName(flat(r.type)),
        catItem: flat(r.cat_item),
        variableSet: flat(r.variable_set),
        mandatory: bool(r.mandatory) === true,
        readOnly: bool(r.read_only) === true,
        defaultValue: flat(r.default_value),
        reference: flat(r.reference),
      }))
      .filter((v) => v.name)
      .sort((a, b) => (order.get(a.sysId) ?? 0) - (order.get(b.sysId) ?? 0));

    const items = [...new Set([itemId, ...variables.map((v) => v.catItem)].filter(isSysId))];
    const sets = [...new Set(variables.map((v) => v.variableSet).filter(isSysId))];
    const scope = (itemCol) => [items.length && `${itemCol}IN${items.join(',')}`, sets.length && `variable_setIN${sets.join(',')}`].filter(Boolean).join('^OR');

    let clientScripts = [];
    let uiPolicies = [];
    if (items.length || sets.length) {
      const [csActive, upActive] = await Promise.all([activeClause('catalog_script_client'), activeClause('catalog_ui_policy')]);
      const [csRows, upRows] = await Promise.all([
        guardedQuery('catalog client scripts', 'catalog_script_client', ['cat_item', 'variable_set'], `${scope('cat_item')}${csActive}^ORDERBYname`, ['sys_id', 'name', 'type', 'cat_variable', 'script', 'applies_to', 'cat_item', 'variable_set', 'ui_type', 'active', 'applies_catalog', 'applies_req_item', 'applies_sc_task'], { limit: LIMITS.catalogScripts }, notes),
        guardedQuery('catalog UI policies', 'catalog_ui_policy', ['catalog_item', 'variable_set'], `${scope('catalog_item')}${upActive}^ORDERBYorder`, ['sys_id', 'short_description', 'catalog_conditions', 'conditions', 'applies_to', 'on_load', 'reverse_if_false', 'run_scripts', 'script_true', 'script_false', 'catalog_item', 'variable_set', 'order', 'active'], { limit: LIMITS.catalogPolicies }, notes),
      ]);
      clientScripts = csRows.filter((r) => bool(r.active) !== false).map((r) => ({
        sysId: flat(r.sys_id),
        name: flat(r.name),
        type: flat(r.type),
        catVariable: flat(r.cat_variable),
        script: flat(r.script),
        appliesTo: flat(r.applies_to),
        catItem: flat(r.cat_item),
        variableSet: flat(r.variable_set),
        uiType: flat(r.ui_type),
        where: ['catalog', 'req_item', 'sc_task'].filter((k) => bool(r[`applies_${k}`]) === true),
        recordTable: 'catalog_script_client',
      }));
      uiPolicies = upRows.filter((r) => bool(r.active) !== false).map((r) => ({
        sysId: flat(r.sys_id),
        name: flat(r.short_description),
        conditions: flat(r.catalog_conditions) || flat(r.conditions),
        appliesTo: flat(r.applies_to),
        onLoad: bool(r.on_load) !== false,
        reverseIfFalse: bool(r.reverse_if_false) !== false,
        runScripts: bool(r.run_scripts) === true,
        scriptTrue: flat(r.script_true),
        scriptFalse: flat(r.script_false),
        catItem: flat(r.catalog_item),
        variableSet: flat(r.variable_set),
        recordTable: 'catalog_ui_policy',
        actions: [],
      }));
      const policyIds = uiPolicies.map((p) => p.sysId).filter(isSysId);
      if (policyIds.length && (await verified('catalog_ui_policy_action', ['ui_policy']))) {
        const actions = await rowsForIds('catalog_ui_policy_action', 'ui_policy', policyIds, ['sys_id', 'ui_policy', 'catalog_variable', 'variable', 'mandatory', 'visible', 'disabled', 'cleared'], {
          label: 'catalog UI policy actions',
          onCap: (m) => notes.push(`Capped: ${m}.`),
          perChunk: LIMITS.policyActions,
        }).catch((err) => {
          notes.push(`Could not read catalog UI policy actions: ${errorText(err)}`);
          return [];
        });
        const byPolicy = new Map(uiPolicies.map((p) => [p.sysId, p]));
        actions.forEach((a) =>
          byPolicy.get(flat(a.ui_policy))?.actions.push({ sysId: flat(a.sys_id), catalogVariable: flat(a.catalog_variable), variable: flat(a.variable), mandatory: flat(a.mandatory), visible: flat(a.visible), disabled: flat(a.disabled), cleared: flat(a.cleared) })
        );
      }
    }
    const item = isSysId(itemId) ? await queryTable('sc_cat_item', `sys_id=${itemId}`, ['sys_id', 'name'], { limit: 1 }).catch(() => []) : [];
    return {
      itemId,
      itemName: flat(item[0]?.name),
      items,
      sets,
      variables,
      clientScripts,
      uiPolicies,
      index: catalogVariableIndex({ variables, clientScripts, uiPolicies }),
      notes,
    };
  });
}

async function catalogReport(doc) {
  const anchors = catalogAnchors(doc);
  if (!anchors.size) return null;
  const catalog = fillVariableInfo(await loadCatalog([...anchors.keys()].sort(), catalogItemId(doc)));
  return {
    itemId: catalog.itemId,
    itemName: catalog.itemName,
    items: catalog.items,
    sets: catalog.sets,
    variables: catalog.variables.map((v) => ({ ...v, entry: catalog.index.get(v.sysId) || null })),
    notes: catalog.notes,
  };
}

async function portalReport(portal) {
  const widgets = collectWidgets(document);
  const instanceIds = [...widgets.values()].flatMap((w) => [...w.instances]);
  const [info] = await Promise.all([resolvePortalPage(portal).catch(() => ({})), resolveWidgets([...widgets.keys()], instanceIds).catch(() => {})]);
  return {
    suffix: portal.suffix,
    pageId: portal.pageId || info.page?.id || '',
    page: info.page || null,
    portal: info.portal || null,
    widgets: [...widgets.entries()].map(([widgetId, w]) => ({
      widgetId,
      name: widgetNames.get(widgetId)?.name || '',
      id: widgetNames.get(widgetId)?.id || '',
      count: w.count,
      instances: [...w.instances].map((sysId) => ({ sysId, title: instanceInfo.get(sysId)?.title || '', table: instanceInfo.get(sysId)?.table || 'sp_instance' })),
    })),
  };
}

async function workspaceReport(ws) {
  if (!isName(ws.table)) return { kind: ws.kind, table: '', sysId: '', fields: [], notes: [] };
  const loaded = await loadIndex(ws.table).catch((err) => ({ error: errorText(err) }));
  const fields = loaded.dict ? [...loaded.dict.fields.keys()].sort().map((name) => ({ ...fieldRow(name, loaded.dict, loaded.index), onForm: null, live: null })) : [];
  return {
    kind: ws.kind,
    table: ws.table,
    sysId: ws.sysId,
    fields,
    tableAcls: loaded.index?.tableAcls || [],
    notes: loaded.error ? [`Could not load the table's logic: ${loaded.error}`] : loaded.logic?.notes || [],
    capped: loaded.logic?.capped || [],
  };
}

/** What is on the page right now: { href, on, form?, list?, catalog?, portal?, workspace? }. */
async function pageReport({ refresh = false } = {}) {
  if (refresh) {
    clearCache();
    failures.clear();
    variableInfo.clear();
    widgetNames.clear();
    instanceInfo.clear();
    askedWidgets.clear();
    if (state.on) {
      scan();
      refreshAll();
    }
  }
  const href = window.location.href;
  const report = { href, on: state.on, hotkey: HOTKEY_LABEL };
  const docs = xrayDocuments();
  for (const doc of docs) {
    const kind = docKind(doc);
    // eslint-disable-next-line no-await-in-loop -- at most two documents, and each report caches its queries.
    if (kind === 'form' && !report.form) report.form = await formReport(doc);
    // eslint-disable-next-line no-await-in-loop
    else if (kind === 'list' && !report.list) report.list = await listReport(doc);
    // eslint-disable-next-line no-await-in-loop
    if (!report.catalog) report.catalog = await catalogReport(doc);
  }
  const portal = portalFromUrl(href);
  if (portal && isPortalDocument(document)) report.portal = await portalReport(portal);
  const ws = parseWorkspaceUrl(href);
  if (ws && !report.form && !report.list) report.workspace = await workspaceReport(ws);
  if (!report.catalog) delete report.catalog;
  return report;
}

/** Everything about one field: dictionary, overrides, the logic touching it, live state and likely causes. */
async function fieldReport({ table, field } = {}) {
  if (!isName(table) || !isFieldPath(field)) throw new Error('Pick a field first.');
  const { dict, logic, index } = await loadIndex(table);
  const doc = formDoc();
  const live = doc && formTable(doc) === table ? await liveForm(doc, table) : null;
  const entry = index.fields.get(field) || null;
  const column = dict.fields.get(field) || null;
  const overrides = logic.overrides.filter((o) => o.element === field).sort((a, b) => logic.tables.indexOf(a.table) - logic.tables.indexOf(b.table));
  const values = live ? Object.fromEntries([...live.fields].map(([name, f]) => [name, f.value ?? ''])) : {};
  const st = live?.fields.get(field) || null;
  const onForm = live ? Boolean(st) : null;
  const view = live ? formView(doc) : null;
  const causes = live
    ? rankCauses({
        field,
        table,
        state: { readOnly: st?.readOnly, mandatory: st?.mandatory, visible: st?.visible, onForm },
        values,
        entry,
        dictionary: column || {},
        overrides,
        tableAcls: index.tableAcls,
        readOnlyRatio: readOnlyRatio(live),
        view,
      })
    : null;
  return {
    table,
    field,
    view,
    tables: logic.tables,
    column,
    overrides,
    entry,
    tableAcls: index.tableAcls,
    live: st,
    liveSource: live?.source || null,
    onForm,
    values,
    causes,
    notes: logic.notes,
    capped: logic.capped,
  };
}

/** Scroll the page to a field, variable, column or widget and flash it. */
function highlight({ field, table, io, column, widget } = {}) {
  for (const doc of xrayDocuments()) {
    let el = null;
    if (field && table) el = doc.getElementById(`element.${table}.${field}`) || doc.getElementById(`label.${table}.${field}`);
    else if (io) el = doc.getElementById(`element.IO:${io}`) || doc.querySelector(`label[for="IO:${io}"], [id="label_IO:${io}"]`);
    else if (column) el = [...doc.querySelectorAll('th[name]')].find((th) => th.getAttribute('name') === column) || null;
    else if (widget && isSysId(widget)) el = doc.querySelector(`.v${widget}`);
    if (!el) continue;
    ensureStyle(doc);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add(FLASH_CLASS);
    setTimeout(() => {
      el.classList.remove(FLASH_CLASS);
      if (!state.on) doc.getElementById(STYLE_ID)?.remove();
    }, 1600);
    return true;
  }
  return false;
}

/**
 * Hand a field over to the access debugger panel ('access', another feature), which takes
 * "/why <user> <operation> <field>" style args and the table from the page context.
 * False when that panel is not installed.
 */
function openAccess({ field = '', operation = 'write' } = {}) {
  if (!state.sidebar?.openPanel) return false;
  const args = ['me', /^[a-z_]+$/.test(operation) ? operation : 'write', isName(field) ? field : ''].filter(Boolean).join(' ');
  return Boolean(state.sidebar.openPanel('access', { args }));
}

export const xrayServices = {
  xrayStatus: () => status(),
  xrayToggle: (force) => toggleXray(force),
  xraySubscribe: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  xrayPageReport: (options) => pageReport(options),
  xrayFieldReport: (args) => fieldReport(args),
  xrayHighlight: (target) => highlight(target),
  xrayOpenAccess: (args) => openAccess(args),
};
