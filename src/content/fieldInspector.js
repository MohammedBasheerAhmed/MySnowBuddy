// Field inspector: dictionary details for every field of a table (including
// inherited ones), plus the live state of a field on the open form.

import { queryTable } from './tableApi.js';
import { callPage } from './pageBridge.js';

const TABLE_RE = /^[a-z0-9_]+$/i;
const MAX_DEPTH = 8;

/** The table and its parents, nearest first. */
export async function tableHierarchy(table) {
  const chain = [table];
  let current = table;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    // eslint-disable-next-line no-await-in-loop -- each level depends on the previous one.
    const rows = await queryTable('sys_db_object', `name=${current}`, ['super_class.name'], { limit: 1 });
    const parent = rows[0]?.['super_class.name'];
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

const FIELD_COLUMNS = ['name', 'element', 'column_label', 'internal_type', 'reference', 'max_length', 'mandatory', 'read_only', 'default_value', 'active', 'unique', 'display', 'choice', 'calculation', 'attributes', 'array', 'audit', 'primary'];

/** Dictionary entries for a table, sorted by field name. */
export async function fetchTableFields(table) {
  if (!TABLE_RE.test(table || '')) throw new Error('Open a record or list first.');
  const tables = await tableHierarchy(table);
  const rows = await queryTable('sys_dictionary', `nameIN${tables.join(',')}^elementISNOTEMPTY^ORDERBYelement`, FIELD_COLUMNS, { limit: 1000 });

  // A field redefined on a child table wins over the parent's definition.
  const byElement = new Map();
  rows.forEach((row) => {
    const existing = byElement.get(row.element);
    if (!existing || tables.indexOf(row.name) < tables.indexOf(existing.name)) byElement.set(row.element, row);
  });

  return {
    tables,
    fields: [...byElement.values()].map((r) => ({
      name: r.element,
      label: r.column_label,
      type: r.internal_type,
      reference: r.reference,
      maxLength: r.max_length,
      mandatory: r.mandatory === 'true',
      readOnly: r.read_only === 'true',
      defaultValue: r.default_value,
      definedOn: r.name,
      unique: r.unique === 'true',
      display: r.display === 'true',
      // 0 = no choice list, 1 = dropdown with --None--, 3 = dropdown without it, 2 = suggestion (dictionary 'choice' column)
      choiceType: r.choice && r.choice !== '0' ? String(r.choice) : '',
      calculated: Boolean(r.calculation),
      array: r.array === 'true',
      audit: r.audit === 'true',
      primary: r.primary === 'true',
      active: r.active !== 'false',
    })),
  };
}

/** Live state of one field on the open form, or null when no form is open. */
export async function fetchFieldLive(name) {
  try {
    return await callPage('getFieldState', [name]);
  } catch {
    return null;
  }
}

// ---- Table explorer: table facts, one column in depth, choices, list layouts ---------------------

const ELEMENT_RE = /^[a-z0-9_]+$/i;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;

const flat = (v) => (v && typeof v === 'object' ? v.display_value || v.value || '' : v == null ? '' : String(v));

/** Facts about a table itself: label, scope, parent and child tables, number prefix, access. */
export async function fetchTableInfo(table) {
  if (!TABLE_RE.test(table || '')) throw new Error('Open a record or list first.');
  const [rows, hierarchy] = await Promise.all([
    queryTable('sys_db_object', `name=${table}`, ['sys_id', 'name', 'label', 'super_class.name', 'sys_scope.name', 'sys_scope.scope', 'is_extendable', 'extension_model', 'number_ref.prefix', 'access'], { limit: 1 }),
    tableHierarchy(table),
  ]);
  const row = rows[0];
  if (!row) throw new Error(`No table called "${table}" was found (or your role cannot read it).`);
  const [children, docs] = await Promise.all([
    queryTable('sys_db_object', `super_class.name=${table}^ORDERBYname`, ['name', 'label'], { limit: 60 }).catch(() => []),
    queryTable('sys_documentation', `name=${table}^elementISEMPTY^language=en`, ['label', 'plural', 'help', 'hint'], { limit: 1 }).catch(() => []),
  ]);
  return {
    name: row.name,
    label: flat(row.label),
    plural: flat(docs[0]?.plural),
    help: flat(docs[0]?.help),
    parent: flat(row['super_class.name']),
    hierarchy,
    scope: flat(row['sys_scope.scope']),
    scopeName: flat(row['sys_scope.name']),
    extendable: flat(row.is_extendable) === 'true',
    extensionModel: flat(row.extension_model),
    numberPrefix: flat(row['number_ref.prefix']),
    access: flat(row.access),
    children: children.map((c) => ({ name: flat(c.name), label: flat(c.label) })),
    sysId: row.sys_id,
  };
}

/** Choice list of a column (value, label, order, inactive, dependent value), including choices from parent tables. */
export async function fetchChoices(table, element) {
  if (!TABLE_RE.test(table || '') || !ELEMENT_RE.test(element || '')) throw new Error('Choose a table and a column.');
  const tables = await tableHierarchy(table);
  const rows = await queryTable(
    'sys_choice',
    `nameIN${tables.join(',')}^element=${element}^language=en^ORlanguageISEMPTY^ORDERBYsequence`,
    ['name', 'value', 'label', 'sequence', 'inactive', 'dependent_value', 'hint'],
    { limit: 500 }
  );
  return rows.map((r) => ({
    value: flat(r.value),
    label: flat(r.label),
    sequence: flat(r.sequence),
    inactive: flat(r.inactive) === 'true',
    dependentValue: flat(r.dependent_value),
    hint: flat(r.hint),
    definedOn: flat(r.name),
  }));
}

/** Everything about one column: full dictionary entry, help text, attributes, overrides, choices. */
export async function fetchColumnDetail(table, element) {
  if (!TABLE_RE.test(table || '') || !ELEMENT_RE.test(element || '')) throw new Error('Choose a table and a column.');
  const tables = await tableHierarchy(table);
  const list = tables.join(',');
  const [dict, docs, overrides] = await Promise.all([
    queryTable('sys_dictionary', `nameIN${list}^element=${element}`, ['sys_id', 'name', 'column_label', 'internal_type', 'reference', 'max_length', 'mandatory', 'read_only', 'default_value', 'unique', 'display', 'choice', 'calculation', 'attributes', 'array', 'audit', 'primary', 'virtual', 'active', 'dependent', 'use_dependent_field', 'function_field', 'comments', 'sys_scope.scope'], { limit: 10 }),
    queryTable('sys_documentation', `nameIN${list}^element=${element}^language=en`, ['name', 'label', 'plural', 'help', 'hint'], { limit: 10 }).catch(() => []),
    queryTable('sys_dictionary_override', `element=${element}^nameIN${list}^ORbase_tableIN${list}`, ['name', 'base_table', 'mandatory_override', 'read_only_override', 'default_value_override', 'reference_qual_override', 'attributes_override', 'display_override'], { limit: 50 }).catch(() => []),
  ]);
  // The definition on the nearest table in the hierarchy wins.
  const near = (rows) => [...rows].sort((a, b) => tables.indexOf(flat(a.name)) - tables.indexOf(flat(b.name)))[0];
  const d = near(dict);
  if (!d) throw new Error(`${table} has no column "${element}".`);
  const doc = near(docs);
  const attributes = flat(d.attributes)
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => {
      const at = a.indexOf('=');
      return at < 0 ? { name: a, value: '' } : { name: a.slice(0, at), value: a.slice(at + 1) };
    });
  const choiceType = flat(d.choice) && flat(d.choice) !== '0' ? flat(d.choice) : '';
  return {
    table,
    element,
    definedOn: flat(d.name),
    sysId: d.sys_id,
    label: flat(d.column_label),
    type: flat(d.internal_type),
    reference: flat(d.reference),
    maxLength: flat(d.max_length),
    mandatory: flat(d.mandatory) === 'true',
    readOnly: flat(d.read_only) === 'true',
    unique: flat(d.unique) === 'true',
    display: flat(d.display) === 'true',
    audit: flat(d.audit) === 'true',
    array: flat(d.array) === 'true',
    primary: flat(d.primary) === 'true',
    virtual: flat(d.virtual) === 'true',
    active: flat(d.active) !== 'false',
    defaultValue: flat(d.default_value),
    calculation: flat(d.calculation),
    dependent: flat(d.dependent),
    functionField: flat(d.function_field),
    scope: flat(d['sys_scope.scope']),
    comments: flat(d.comments),
    choiceType,
    help: flat(doc?.help),
    hint: flat(doc?.hint),
    plural: flat(doc?.plural),
    attributes,
    overrides: overrides.map((o) => ({
      table: flat(o.name),
      baseTable: flat(o.base_table),
      changes: Object.entries({
        mandatory: o.mandatory_override,
        readOnly: o.read_only_override,
        default: o.default_value_override,
        referenceQualifier: o.reference_qual_override,
        attributes: o.attributes_override,
        display: o.display_override,
      })
        .filter(([, v]) => flat(v) && flat(v) !== 'false')
        .map(([k, v]) => `${k}${flat(v) === 'true' ? '' : `: ${flat(v)}`}`),
    })),
    choices: choiceType ? await fetchChoices(table, element).catch(() => []) : [],
  };
}

/** The columns of each list layout of a table, in order (default layouts, not personal ones). */
export async function fetchListLayout(table) {
  if (!TABLE_RE.test(table || '')) throw new Error('Open a record or list first.');
  const layouts = await queryTable('sys_ui_list', `name=${table}^relationshipISEMPTY^parentISEMPTY^sys_userISEMPTY`, ['sys_id', 'view.name'], { limit: 30 });
  const ids = layouts.map((l) => l.sys_id).filter((id) => SYS_ID_RE.test(String(id)));
  if (!ids.length) return [];
  const elements = await queryTable('sys_ui_list_element', `list_idIN${ids.join(',')}^ORDERBYposition`, ['list_id', 'element', 'position'], { limit: 600 });
  return layouts
    .map((l) => ({
      view: flat(l['view.name']) || 'Default view',
      columns: elements.filter((e) => flat(e.list_id?.value ?? e.list_id) === l.sys_id).map((e) => flat(e.element)).filter((name) => name && !name.startsWith('.')), // '.begin_split' etc. are layout markers, not columns
    }))
    .filter((l) => l.columns.length)
    .sort((a, b) => (a.view === 'Default view' ? -1 : b.view === 'Default view' ? 1 : a.view.localeCompare(b.view)));
}

/** The sys_dictionary entry that defines a column for a table (nearest table in the hierarchy wins), or null. Used by the script editor's go to definition. */
export async function findDictionaryEntry(table, element) {
  if (!TABLE_RE.test(table || '') || !ELEMENT_RE.test(element || '')) return null;
  const tables = await tableHierarchy(table);
  const rows = await queryTable('sys_dictionary', `nameIN${tables.join(',')}^element=${element}`, ['sys_id', 'name'], { limit: 10 });
  const best = [...rows].sort((a, b) => tables.indexOf(flat(a.name)) - tables.indexOf(flat(b.name)))[0];
  return best ? { sysId: flat(best.sys_id), table: flat(best.name) } : null;
}
