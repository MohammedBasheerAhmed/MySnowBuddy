// Ready-to-paste forms of the record on screen: the Table API URL, a GlideRecord that loads it, and its values as JSON.
// Pure, so the formats can be tested; src/content/commands.js wires them to the palette.

const TABLE_RE = /^[a-z][a-z0-9_]*$/;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;

function check(table, sysId) {
  if (!TABLE_RE.test(String(table || ''))) throw new Error('This page has no table name to build a snippet from.');
  if (!SYS_ID_RE.test(String(sysId || ''))) throw new Error('Save the record first: it has no sys_id yet.');
}

/** The Table API URL of one record, for Postman, curl or a REST message. */
export function restRecordUrl(origin, table, sysId) {
  check(table, sysId);
  return `${String(origin).replace(/\/+$/, '')}/api/now/table/${table}/${sysId.toLowerCase()}`;
}

/** Server script that loads this record, with the next step left as a comment. */
export function glideRecordSnippet(table, sysId) {
  check(table, sysId);
  return [
    `var gr = new GlideRecord('${table}');`,
    `if (gr.get('${sysId.toLowerCase()}')) {`,
    '  // gr.getValue("field"), gr.getDisplayValue("field"), gr.setValue("field", value); gr.update();',
    '}',
  ].join('\n');
}

/** Pretty JSON of the record's non-empty fields, or '' when there is nothing to show. */
export function recordJson(record) {
  const out = {};
  Object.keys(record || {}).forEach((key) => {
    const value = record[key];
    if (value === '' || value === null || value === undefined) return;
    out[key] = value;
  });
  return Object.keys(out).length ? JSON.stringify(out, null, 2) : '';
}
