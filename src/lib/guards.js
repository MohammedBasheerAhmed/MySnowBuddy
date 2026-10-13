// Rules for the safety guards: which tables hold configuration, and which
// update sets are the catch-all "Default" ones.

const CONFIG_TABLES = new Set([
  'sys_script',
  'sys_script_include',
  'sys_script_client',
  'sys_script_email',
  'sys_script_fix',
  'sys_ui_action',
  'sys_ui_policy',
  'sys_ui_script',
  'sys_ui_page',
  'sys_ui_macro',
  'sys_ui_section',
  'sys_ui_list',
  'sys_ui_related_list',
  'sys_security_acl',
  'sys_data_policy2',
  'sys_db_object',
  'sys_dictionary',
  'sys_documentation',
  'sys_choice',
  'sys_properties',
  'sysauto_script',
  'sys_transform_map',
  'sys_report',
  'sys_app',
  'wf_workflow',
  'sp_widget',
  'sp_page',
  'sp_portal',
  'sc_cat_item',
  'sc_cat_item_producer',
  'catalog_ui_policy',
  'catalog_script_client',
]);

const CONFIG_PREFIXES = ['sys_ui_', 'sys_hub_', 'sp_', 'sys_ws_', 'sys_ux_', 'sys_atf_', 'sysevent_', 'sysauto', 'sys_data_policy', 'sys_security_'];

/** True for tables that hold platform configuration (code, ACLs, forms) rather than business data. */
export function isConfigTable(table) {
  const name = String(table || '').toLowerCase();
  if (!name) return false;
  return CONFIG_TABLES.has(name) || CONFIG_PREFIXES.some((p) => name.startsWith(p));
}

/** "Default", "Default [Global]" and "Default [scope]" are the shared catch-all sets. */
export function isDefaultUpdateSet(name) {
  return /^default(\s|\[|$)/i.test(String(name || '').trim());
}
