// Data behind the script editor's completion, hover and go to definition: dictionary fields,
// table / Script Include / system property / role names, Script Include methods and catalog
// variables. Everything is read on demand through the Table API with the user's own session,
// capped per request, and cached for the life of the page so typing never waits on the network.

import { queryTable } from './tableApi.js';
import { fetchTableFields, findDictionaryEntry } from './fieldInspector.js';
import { callPage } from './pageBridge.js';
import { recordUrl } from './quickActions.js';
import { parseScriptIncludeMethods } from '../lib/completion.js';

const NAME_RE = /^[A-Za-z0-9_.]{1,80}$/;
const TABLE_RE = /^[a-z0-9_]{1,80}$/i;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const LIST_LIMIT = 100;
const MAX_LIST_ROWS = 4000;
const TTL = 10 * 60 * 1000;
const FAILED_TTL = 30 * 1000;
const MAX_SI_DEPTH = 2;

const flat = (v) => (v && typeof v === 'object' ? v.value ?? v.display_value ?? '' : v == null ? '' : String(v));
const bool = (v) => {
  const s = flat(v);
  return s === '' ? undefined : s === 'true';
};

// Prefix-searched name lists. Condition columns are ones verified on a live instance
// (an unknown column in a query is silently ignored and would return every row).
const LISTS = {
  tables: {
    table: 'sys_db_object',
    fields: ['name', 'label'],
    map: (r) => ({ name: flat(r.name), label: flat(r.label) }),
  },
  scriptIncludes: {
    table: 'sys_script_include',
    filter: 'active=true',
    fields: ['name', 'api_name', 'client_callable', 'description'],
    map: (r) => ({ name: flat(r.name), apiName: flat(r.api_name), clientCallable: bool(r.client_callable), description: flat(r.description).slice(0, 200) }),
  },
  properties: {
    table: 'sys_properties',
    fields: ['name', 'description', 'type'],
    map: (r) => ({ name: flat(r.name), description: flat(r.description).slice(0, 200), type: flat(r.type) }),
  },
  roles: {
    table: 'sys_user_role',
    fields: ['name', 'description'],
    map: (r) => ({ name: flat(r.name), description: flat(r.description).slice(0, 200) }),
  },
};

// One store per page: every editor opened on this page shares it.
const store = {
  version: 0,
  fields: {}, // table -> field[] | null (failed)
  fieldsAt: {},
  siMethods: {}, // Script Include name -> info | null (not found)
  siAt: {},
  lists: Object.fromEntries(Object.keys(LISTS).map((k) => [k, new Map()])),
  fetched: Object.fromEntries(Object.keys(LISTS).map((k) => [k, []])), // [{key, mode, capped, at}]
  failedAt: {},
  arrays: {},
  arraysVersion: -1,
  inflight: new Map(),
};

function bump() {
  store.version += 1;
}

function once(key, run) {
  if (store.inflight.has(key)) return store.inflight.get(key);
  const p = run().finally(() => store.inflight.delete(key));
  store.inflight.set(key, p);
  return p;
}

function fresh(at, failed) {
  return at && Date.now() - at < (failed ? FAILED_TTL : TTL);
}

function covered(type, prefix) {
  const p = prefix.toLowerCase();
  return store.fetched[type].some((f) => fresh(f.at) && !f.capped && (f.mode === 'like' ? p.includes(f.key) : p.startsWith(f.key)));
}

const recentlyFailed = (type) => fresh(store.failedAt[type], true);

async function loadList(type, prefix) {
  const spec = LISTS[type];
  const key = String(prefix || '').toLowerCase().slice(0, 40);
  if (!spec || !key || !NAME_RE.test(key) || covered(type, key) || recentlyFailed(type)) return false;
  const mode = key.length >= 2 ? 'like' : 'sw';
  return once(`list|${type}|${key}`, async () => {
    const cond = `name${mode === 'like' ? 'LIKE' : 'STARTSWITH'}${key}`;
    const query = `${spec.filter ? `${spec.filter}^` : ''}${cond}^ORDERBYname`;
    let rows = [];
    try {
      rows = await queryTable(spec.table, query, spec.fields, { limit: LIST_LIMIT });
    } catch {
      // No access (403) or a network error: do not ask again for a while.
      store.failedAt[type] = Date.now();
      return false;
    }
    const map = store.lists[type];
    rows.map(spec.map).forEach((row) => {
      if (row.name && map.size < MAX_LIST_ROWS) map.set(row.name, row);
    });
    store.fetched[type].push({ key, mode, capped: rows.length >= LIST_LIMIT, at: Date.now() });
    bump();
    return rows.length > 0;
  });
}

async function loadFields(table) {
  if (!TABLE_RE.test(table || '')) {
    store.fields[table] = [];
    return false;
  }
  if (store.fields[table] !== undefined && fresh(store.fieldsAt[table], store.fields[table] === null)) return false;
  return once(`fields|${table}`, async () => {
    try {
      const { fields } = await fetchTableFields(table);
      store.fields[table] = fields.map((f) => ({ name: f.name, label: f.label, type: f.type, reference: flat(f.reference) }));
    } catch {
      store.fields[table] = null;
    }
    store.fieldsAt[table] = Date.now();
    bump();
    return true;
  });
}

async function fetchScriptInclude(name, depth) {
  const query = name.includes('.') ? `api_name=${name}` : `name=${name}`;
  const rows = await queryTable('sys_script_include', query, ['sys_id', 'name', 'api_name', 'script', 'client_callable'], { limit: 1 });
  const row = rows[0];
  if (!row) return null;
  const parsed = parseScriptIncludeMethods(flat(row.script));
  const info = {
    name: flat(row.name),
    sysId: flat(row.sys_id),
    clientCallable: bool(row.client_callable),
    parent: parsed.parent,
    ajax: parsed.ajax,
    initParams: parsed.initParams,
    methods: parsed.methods,
  };
  // Methods inherited from another Script Include (one or two levels, best effort).
  if (parsed.parent && !parsed.ajax && depth < MAX_SI_DEPTH && NAME_RE.test(parsed.parent) && parsed.parent !== info.name) {
    const parent = await fetchScriptInclude(parsed.parent, depth + 1).catch(() => null);
    if (parent) {
      const own = new Set(info.methods.map((m) => m.name));
      parent.methods.forEach((m) => own.has(m.name) || info.methods.push({ ...m, inherited: m.inherited || parent.name }));
      info.ajax = info.ajax || parent.ajax;
      if (!info.initParams) info.initParams = parent.initParams;
    }
  }
  return info;
}

async function loadScriptInclude(name) {
  if (!NAME_RE.test(name || '')) {
    store.siMethods[name] = null;
    return false;
  }
  if (store.siMethods[name] !== undefined && fresh(store.siAt[name])) return false;
  return once(`si|${name}`, async () => {
    try {
      store.siMethods[name] = await fetchScriptInclude(name, 0);
    } catch {
      store.siMethods[name] = null;
    }
    store.siAt[name] = Date.now();
    bump();
    return true;
  });
}

/**
 * Fetches what a completion/hover result reported in `needs`. Resolves to true when new data
 * arrived (the caller then asks again). Never throws.
 */
export async function ensureEditorData(needs) {
  const tasks = (needs || []).slice(0, 6).map((n) => {
    if (n.type === 'fields') return loadFields(n.table);
    if (n.type === 'siMethods') return loadScriptInclude(n.name);
    if (LISTS[n.type]) return loadList(n.type, n.prefix);
    return Promise.resolve(false);
  });
  const results = await Promise.all(tasks.map((t) => t.catch(() => false)));
  return results.some(Boolean);
}

/** The needs that are not answered by the cache yet (so the caller knows whether to wait). */
export function missingEditorData(needs) {
  return (needs || []).filter((n) => {
    if (n.type === 'fields') return store.fields[n.table] === undefined && TABLE_RE.test(n.table || '');
    if (n.type === 'siMethods') return store.siMethods[n.name] === undefined && NAME_RE.test(n.name || '');
    if (LISTS[n.type]) {
      const key = String(n.prefix || '').toLowerCase().slice(0, 40);
      return Boolean(key) && NAME_RE.test(key) && !covered(n.type, key) && !recentlyFailed(n.type);
    }
    return false;
  });
}

/** True while any fetch is running. */
export const editorDataBusy = () => store.inflight.size > 0;

/** Field names of a table once loaded (null until then). */
export function loadedFieldNames(table) {
  const list = store.fields[table];
  return Array.isArray(list) ? list.map((f) => f.name) : null;
}

/** Loads a table's dictionary in the background (for field checks and completion). */
export function prefetchFields(table) {
  return table ? loadFields(table).catch(() => false) : Promise.resolve(false);
}

/** The data part of a completion context, rebuilt only when something new arrived. */
export function editorDataContext() {
  if (store.arraysVersion !== store.version) {
    store.arrays = {
      fields: { ...store.fields },
      tables: [...store.lists.tables.values()],
      scriptIncludes: [...store.lists.scriptIncludes.values()],
      properties: [...store.lists.properties.values()],
      roles: [...store.lists.roles.values()],
      siMethods: { ...store.siMethods },
    };
    store.arraysVersion = store.version;
  }
  return store.arrays;
}

export const editorDataVersion = () => store.version;

async function fieldValue(name) {
  try {
    const state = await callPage('getFieldState', [name]);
    const v = state && state.value;
    return v === undefined || v === null ? '' : String(v);
  } catch {
    return '';
  }
}

// Where the script's `current` / g_form table is stored on each script form.
const TARGET_FIELD = {
  sys_script: 'collection',
  sys_script_client: 'table',
  sys_ui_policy: 'table',
  sys_ui_action: 'table',
  sys_security_acl: 'name',
};

/**
 * What the editor needs to know about the record being edited: the table the script runs
 * against, client/server UI Action, Business Rule timing, client script type, application scope
 * and (catalog client scripts) the item / variable set.
 */
export async function readScriptRecord(formTable) {
  const out = { target: '', uiActionClient: null, when: '', clientType: '', scoped: null, catItem: '', variableSet: '' };
  if (!formTable) return out;
  const targetField = TARGET_FIELD[formTable];
  const reads = {
    target: targetField ? fieldValue(targetField) : Promise.resolve(''),
    scope: fieldValue('sys_scope'),
    when: formTable === 'sys_script' ? fieldValue('when') : Promise.resolve(''),
    type: formTable === 'sys_script_client' || formTable === 'catalog_script_client' ? fieldValue('type') : Promise.resolve(''),
    client: formTable === 'sys_ui_action' ? fieldValue('client') : Promise.resolve(''),
    catItem: formTable === 'catalog_script_client' ? fieldValue('cat_item') : Promise.resolve(''),
    variableSet: formTable === 'catalog_script_client' ? fieldValue('variable_set') : Promise.resolve(''),
  };
  const values = Object.fromEntries(await Promise.all(Object.entries(reads).map(async ([k, p]) => [k, await p])));
  let target = values.target;
  if (formTable === 'sys_security_acl') target = target.split('.')[0];
  out.target = TABLE_RE.test(target) ? target : '';
  out.uiActionClient = formTable === 'sys_ui_action' ? values.client === 'true' : null;
  out.when = values.when;
  out.clientType = /^on(Load|Change|Submit|CellEdit)$/.test(values.type) ? values.type : '';
  out.scoped = values.scope === 'global' ? false : SYS_ID_RE.test(values.scope) ? true : null;
  out.catItem = SYS_ID_RE.test(values.catItem) ? values.catItem : '';
  out.variableSet = SYS_ID_RE.test(values.variableSet) ? values.variableSet : '';
  return out;
}

/**
 * The field as it is SAVED on the instance (not as the form holds it now, which may already carry unsaved edits), so
 * the editor's "changes since the record was loaded" compare with the record. Null when that cannot be told, and the
 * caller then keeps the form's text: a new record (not saved yet), a field that is not a column of the table (the Table
 * API silently leaves unknown columns out of its answer, so a missing key means "unknown", never "empty"), a
 * password-type or secret-looking field (never read), or a failed read. Line breaks come back as \n, like a textarea's.
 */
export async function readSavedFieldValue({ table, sysId, field, type = '' } = {}) {
  if (!TABLE_RE.test(table || '') || !SYS_ID_RE.test(sysId || '') || !/^[a-z0-9_]{1,80}$/i.test(field || '')) return null;
  if (/password|encrypt/i.test(String(type || '')) || /password|passwd|secret|token|credential|key/i.test(field)) return null;
  try {
    const rows = await queryTable(table, `sys_id=${sysId}`, ['sys_id', field], { limit: 1 });
    const row = rows && rows[0];
    if (!row || flat(row.sys_id) !== sysId || !Object.prototype.hasOwnProperty.call(row, field)) return null;
    const v = row[field];
    const raw = v && typeof v === 'object' ? v.value : v;
    return raw == null ? null : String(raw).replace(/\r\n?/g, '\n');
  } catch {
    return null;
  }
}

/** Variables of a catalog item and/or variable set (for g_form completion in catalog client scripts). */
export async function fetchCatalogVariables({ catItem, variableSet }) {
  const queries = [];
  if (SYS_ID_RE.test(catItem || '')) queries.push(`cat_item=${catItem}^ORDERBYorder`);
  if (SYS_ID_RE.test(variableSet || '')) queries.push(`variable_set=${variableSet}^ORDERBYorder`);
  const out = new Map();
  for (const q of queries) {
    // eslint-disable-next-line no-await-in-loop -- at most two small queries.
    const rows = await queryTable('item_option_new', q, ['name', 'question_text'], { limit: 300 }).catch(() => []);
    rows.forEach((r) => {
      const name = flat(r.name);
      if (name && !out.has(name)) out.set(name, { name, label: flat(r.question_text), type: 'variable' });
    });
  }
  return [...out.values()];
}

async function firstSysId(table, query) {
  const rows = await queryTable(table, query, ['sys_id'], { limit: 1 });
  return rows[0] ? flat(rows[0].sys_id) : '';
}

/**
 * URL of the record that defines a go-to-definition target from completion.js
 * (scriptInclude, table, field, property, role, name), or null.
 */
export async function definitionUrl(target) {
  if (!target) return null;
  const name = String(target.name || '');
  switch (target.type) {
    case 'scriptInclude': {
      if (!NAME_RE.test(name)) return null;
      const id = await firstSysId('sys_script_include', name.includes('.') ? `api_name=${name}` : `name=${name}`);
      return id ? recordUrl('sys_script_include', id) : null;
    }
    case 'table': {
      if (!TABLE_RE.test(name)) return null;
      const id = await firstSysId('sys_db_object', `name=${name}`);
      return id ? recordUrl('sys_db_object', id) : null;
    }
    case 'field': {
      const entry = await findDictionaryEntry(target.table, name);
      return entry ? recordUrl('sys_dictionary', entry.sysId) : null;
    }
    case 'property': {
      if (!NAME_RE.test(name)) return null;
      const id = await firstSysId('sys_properties', `name=${name}`);
      return id ? recordUrl('sys_properties', id) : null;
    }
    case 'role': {
      if (!NAME_RE.test(name)) return null;
      const id = await firstSysId('sys_user_role', `name=${name}`);
      return id ? recordUrl('sys_user_role', id) : null;
    }
    default:
      return null;
  }
}
