// Table catalog used by the command palette.
//
// A curated local list covers the tables developers reach for constantly (so
// results appear with zero latency and work even if the user cannot read
// sys_db_object), and `searchTables` falls back to a live sys_db_object query
// for everything else.

import { queryTable } from './tableApi.js';

export const COMMON_TABLES = [
  // ITSM / core records
  { name: 'incident', label: 'Incident' },
  { name: 'problem', label: 'Problem' },
  { name: 'change_request', label: 'Change Request' },
  { name: 'change_task', label: 'Change Task' },
  { name: 'sc_request', label: 'Request' },
  { name: 'sc_req_item', label: 'Requested Item' },
  { name: 'sc_task', label: 'Catalog Task' },
  { name: 'sc_cat_item', label: 'Catalog Item' },
  { name: 'task', label: 'Task' },
  { name: 'kb_knowledge', label: 'Knowledge' },
  { name: 'cmdb_ci', label: 'Configuration Item' },
  { name: 'cmdb_ci_server', label: 'Server' },
  { name: 'cmdb_rel_ci', label: 'CI Relationship' },
  { name: 'sys_user', label: 'User' },
  { name: 'sys_user_group', label: 'Group' },
  { name: 'sys_user_role', label: 'Role' },
  { name: 'sys_user_has_role', label: 'User Role' },
  { name: 'sys_user_grmember', label: 'Group Member' },

  // Scripting / configuration
  { name: 'sys_script', label: 'Business Rule' },
  { name: 'sys_script_include', label: 'Script Include' },
  { name: 'sys_script_client', label: 'Client Script' },
  { name: 'sys_ui_action', label: 'UI Action' },
  { name: 'sys_ui_policy', label: 'UI Policy' },
  { name: 'sys_ui_policy_action', label: 'UI Policy Action' },
  { name: 'sys_script_fix', label: 'Fix Script' },
  { name: 'sys_script_email', label: 'Email Script' },
  { name: 'sysevent_script_action', label: 'Script Action' },
  { name: 'sysauto_script', label: 'Scheduled Job' },
  { name: 'sys_processor', label: 'Processor' },
  { name: 'sys_transform_map', label: 'Transform Map' },
  { name: 'sys_transform_script', label: 'Transform Script' },
  { name: 'sys_ws_definition', label: 'Scripted REST API' },
  { name: 'sys_ws_operation', label: 'Scripted REST Resource' },
  { name: 'sys_ui_script', label: 'UI Script' },
  { name: 'sys_ui_page', label: 'UI Page' },
  { name: 'sys_ui_macro', label: 'UI Macro' },
  { name: 'catalog_script_client', label: 'Catalog Client Script' },
  { name: 'sp_widget', label: 'Portal Widget' },
  { name: 'sp_page', label: 'Portal Page' },
  { name: 'sys_hub_flow', label: 'Flow' },
  { name: 'sys_hub_action_type_definition', label: 'Flow Action' },

  // Security / platform
  { name: 'sys_security_acl', label: 'ACL' },
  { name: 'sys_security_acl_role', label: 'ACL Role' },
  { name: 'sys_properties', label: 'System Property' },
  { name: 'sys_dictionary', label: 'Dictionary Entry' },
  { name: 'sys_db_object', label: 'Table' },
  { name: 'sys_documentation', label: 'Label / Documentation' },
  { name: 'sys_choice', label: 'Choice' },
  { name: 'sys_app', label: 'Custom Application' },
  { name: 'sys_scope', label: 'Application Scope' },
  { name: 'sys_app_module', label: 'Module' },
  { name: 'sys_app_application', label: 'Application Menu' },
  { name: 'sys_dictionary_override', label: 'Dictionary Override' },

  // Deployment / operations
  { name: 'sys_update_set', label: 'Update Set' },
  { name: 'sys_update_xml', label: 'Customer Update' },
  { name: 'sys_remote_update_set', label: 'Retrieved Update Set' },
  { name: 'sys_metadata', label: 'Application File' },
  { name: 'syslog', label: 'System Log' },
  { name: 'syslog_transaction', label: 'Transaction Log' },
  { name: 'sys_email', label: 'Email' },
  { name: 'sysevent', label: 'Event' },
  { name: 'sysevent_register', label: 'Event Registry' },
  { name: 'sys_trigger', label: 'Schedule Item' },
  { name: 'sys_rest_message', label: 'REST Message' },
  { name: 'sys_attachment', label: 'Attachment' },
  { name: 'sys_audit', label: 'Audit' },
  { name: 'sys_upgrade_history', label: 'Upgrade History' },
  { name: 'sys_import_set', label: 'Import Set' },
  { name: 'sys_data_source', label: 'Data Source' },
];

const SEARCH_CACHE = new Map();

/**
 * Match the curated list synchronously. Used to paint palette results before
 * any network call resolves.
 */
export function matchLocalTables(term, limit = 8) {
  const q = term.trim().toLowerCase();
  if (!q) return [];

  return COMMON_TABLES.map((t) => ({ table: t, score: scoreTable(t, q) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.table);
}

function scoreTable(table, q) {
  const name = table.name.toLowerCase();
  const label = table.label.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (label.toLowerCase().startsWith(q)) return 70;
  if (name.includes(q)) return 50;
  if (label.includes(q)) return 40;
  return 0;
}

/**
 * Live lookup against sys_db_object, merged with the curated list.
 * Failures degrade to the local matches rather than breaking the palette.
 */
export async function searchTables(term, limit = 10) {
  const q = term.trim();
  const local = matchLocalTables(q, limit);
  if (q.length < 2) return local;

  if (SEARCH_CACHE.has(q)) return mergeTables(local, SEARCH_CACHE.get(q), limit);

  let remote = [];
  try {
    const rows = await queryTable(
      'sys_db_object',
      `nameLIKE${q}^ORlabelLIKE${q}^ORDERBYname`,
      ['name', 'label'],
      { limit: 20 }
    );
    remote = rows.filter((r) => r.name).map((r) => ({ name: r.name, label: r.label || r.name }));
    SEARCH_CACHE.set(q, remote);
  } catch (err) {
    remote = [];
  }

  return mergeTables(local, remote, limit);
}

function mergeTables(primary, secondary, limit) {
  const seen = new Set(primary.map((t) => t.name));
  const merged = [...primary];
  for (const t of secondary) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    merged.push(t);
    if (merged.length >= limit) break;
  }
  return merged.slice(0, limit);
}

export function labelForTable(name) {
  const hit = COMMON_TABLES.find((t) => t.name === name);
  return hit ? hit.label : name;
}
