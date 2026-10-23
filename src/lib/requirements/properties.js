// What the "properties" feature needs from the instance, for the Self-check panel (src/lib/requirements/index.js).
// One entry per table: { feature, table, columns: [...], optional?: true, note?: "why" }.

const FEATURE = 'System properties';

export const REQUIREMENTS = [
  {
    feature: FEATURE,
    table: 'sys_properties',
    columns: ['name', 'value', 'type'],
    note: 'Find, read and change a property. name is searched with LIKE and ordered; value is read, written (through update_record) and searched; type decides the editor (boolean, integer, choicelist, password...).',
  },
  {
    feature: FEATURE,
    table: 'sys_properties',
    columns: ['description', 'choices', 'suffix', 'is_private', 'read_roles', 'write_roles', 'sys_scope', 'sys_updated_on', 'sys_updated_by'],
    optional: true,
    note: 'Shown on the property when the instance returns them. description is also searched, but only when it came back in a probe read (a condition on a missing column would match every row). choices fills the select for choicelist properties. sys_scope is read as a reference with its display value, and sys_scope.scope for the scope id. sys_updated_on orders the "Changed lately" list.',
  },
  {
    feature: FEATURE,
    table: 'sys_script_fix',
    columns: ['name', 'script'],
    optional: true,
    note: 'Who reads it: fix scripts are searched for the property name (script LIKE name). No active filter is used: whether the table has an active column is not certain.',
  },
  {
    feature: FEATURE,
    table: 'sys_script_email',
    columns: ['name', 'script'],
    optional: true,
    note: 'Who reads it: notification email scripts are searched. No active filter is used.',
  },
  {
    feature: FEATURE,
    table: 'sys_ui_page',
    columns: ['name', 'html', 'client_script', 'processing_script'],
    optional: true,
    note: 'Who reads it: UI pages (Jelly in html, client and processing scripts) are searched. No active filter is used.',
  },
  {
    feature: FEATURE,
    table: 'sys_ui_macro',
    columns: ['name', 'xml', 'active'],
    optional: true,
    note: 'Who reads it: UI macros are searched (xml LIKE name, active=true).',
  },
  {
    feature: FEATURE,
    table: 'sys_dictionary',
    columns: ['name', 'element', 'default_value', 'calculation', 'active'],
    optional: true,
    note: 'Who reads it: a field default of the form javascript:gs.getProperty(...) or a calculation script is a read of the property.',
  },
];
