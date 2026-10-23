// What the "datamodel" feature needs from the instance, for the Self-check panel (src/lib/requirements/index.js).
// One entry per table: { feature, table, columns: [...], optional?: true, note?: "why" }.

const FEATURE = 'Data model map';

export const REQUIREMENTS = [
  {
    feature: FEATURE,
    table: 'sys_db_object',
    columns: ['name', 'label', 'super_class', 'sys_scope', 'is_extendable'],
    note: 'Table names, labels, the extends chain (super_class, read as super_class.name) and the scope. Also searched when you type a table name.',
  },
  {
    feature: FEATURE,
    table: 'sys_dictionary',
    columns: ['name', 'element', 'column_label', 'internal_type', 'reference', 'active'],
    note: 'Reference fields (internal_type reference, glide_list, document_id) and the table each one points at (reference holds the table name). Without read access to sys_dictionary the map and the path finder have nothing to draw.',
  },
  {
    feature: FEATURE,
    table: 'sys_dictionary',
    columns: ['dependent', 'display', 'max_length'],
    optional: true,
    note: 'The display column picks the default field at the end of a dot-walk path; dependent names the table column beside a document id field. Both are left out when missing.',
  },
  {
    feature: FEATURE,
    table: 'sys_m2m',
    columns: ['sys_id'],
    optional: true,
    note: 'Only confirms a link table: any column value equal to a table name counts, so no column names are assumed. Not readable is fine, the two-reference-fields rule still finds link tables.',
  },
];
