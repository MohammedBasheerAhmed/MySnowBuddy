// Field inspector: dictionary details for every field of a table (including
// inherited ones), plus the live state of a field on the open form.

import { queryTable } from './tableApi.js';
import { callPage } from './pageBridge.js';

const TABLE_RE = /^[a-z0-9_]+$/i;
const MAX_DEPTH = 8;

/** The table and its parents, nearest first. */
async function tableHierarchy(table) {
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

const FIELD_COLUMNS = ['name', 'element', 'column_label', 'internal_type', 'reference', 'max_length', 'mandatory', 'read_only', 'default_value', 'active'];

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
