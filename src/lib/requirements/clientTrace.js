// What the "clientTrace" feature needs from the instance, for the Self-check panel (src/lib/requirements/index.js).
// One entry per table: { feature, table, columns: [...], optional?: true, note?: "why" }.
//
// The recorder itself reads nothing from the instance (it watches the page in the browser). These tables are only used to
// put a NAME on the script behind a recorded call: the stack frame's function name or file name carries a sys_id or a
// UI script name, and each is looked up here. A table that is missing or unreadable leaves "Unknown script" in the panel
// with a visible "Could not check <table>" line; nothing is guessed.
//
// Names are as src/lib/clientTrace.js RESOLVE_TABLES reads them. sys_script_client.field, sys_ui_policy.short_description
// and the sys_ui_action columns were confirmed on a PDI in earlier work (PROGRESS.md "Live calibration"); the rest are
// the standard dictionary names and still need the Self-check run on a real instance.

const FEATURE = 'Client trace';

export const REQUIREMENTS = [
  { feature: FEATURE, table: 'sys_script_client', columns: ['name', 'table', 'type', 'field', 'script', 'active'], note: 'Names the client script (and its onLoad / onChange / onSubmit type and field) behind a recorded call. Inline page functions (onLoad_<hex>, not a sys_id) are found with active=true^tableIN...^scriptLIKE<a line of the function> and taken only when exactly one record holds the function body.' },
  { feature: FEATURE, table: 'sys_ui_policy', columns: ['short_description', 'table'], note: 'Names the UI policy behind a recorded call.' },
  { feature: FEATURE, table: 'sys_ui_action', columns: ['name', 'table', 'action_name'], note: 'Names the UI action behind a recorded call.' },
  { feature: FEATURE, table: 'sys_ui_script', columns: ['name'], note: 'Names the UI script, from the .jsdbx file name in a stack frame (the exact URL form is unverified).' },
  { feature: FEATURE, table: 'catalog_script_client', columns: ['name', 'type', 'cat_item', 'script', 'active'], optional: true, note: 'Names catalog client scripts. Needs the Service Catalog; skipped when the table does not exist.' },
  { feature: FEATURE, table: 'catalog_ui_policy', columns: ['short_description'], optional: true, note: 'Names catalog UI policies. Needs the Service Catalog; skipped when the table does not exist.' },
  { feature: FEATURE, table: 'sys_script_include', columns: ['name', 'client_callable'], optional: true, optionalColumns: ['api_name'], note: 'Says whether the class named in a GlideAjax call exists and is client callable. api_name only confirms a scoped class.' },
  { feature: FEATURE, table: 'sys_db_object', columns: ['name', 'super_class'], optional: true, note: 'Tells which of the tables above exist, so a missing catalog table is skipped instead of reported; super_class gives the form table\'s parents for the source-text search.' },
];
