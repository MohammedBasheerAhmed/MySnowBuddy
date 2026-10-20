// Dev-only (not shipped): a fake ServiceNow instance for the preview harness, so the
// sidebar panels can be looked at with real-looking data in a plain browser tab.
//
// installFakeInstance() replaces window.fetch for the endpoints the panels use (Table API,
// Aggregate API, the update set / application pickers, sys.scripts.do, stats.do), answers
// the page bridge (g_ck, g_user, g_form) and renders a classic form or list into the page
// so Page X-ray has DOM to read. Everything is answered from the compact fixtures below.
// Requests nothing here can answer are logged as "[fake] unmatched ..." in the console.
//
// Test hooks (window.__fake), for driving loading and error states from puppeteer:
//   pause() / resume()        hold every request until resume()
//   fail(pattern, status)     answer requests whose URL matches `pattern` (RegExp source) with an error
//   clearFail()
//   latency(ms)               delay every answer
//   log                       [{ method, url, status }]
//   unknownColumns            Set of "table.column" used in conditions that do not exist

import { hotspotsFixture } from './hotspotsFixture.js';

/* ---------------------------------------------------------------- ids and dates */

function fnv(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Deterministic 32-hex sys_id for a fixture key. */
export const sid = (key) => [0x811c9dc5, 0x2f1a3b4c, 0x9e3779b9, 0x7f4a7c15].map((s) => fnv(key, s)).join('');

const NOW = Date.now();
const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const ago = (days, hours = 0) => fmt(NOW - days * 864e5 - hours * 36e5);

/* ---------------------------------------------------------------- schema */

// Column spec: a type name, or "ref:<table>" for a reference.
const ROOT_COLS = {
  sys_id: 'GUID',
  sys_class_name: 'sys_class_name',
  sys_created_on: 'glide_date_time',
  sys_created_by: 'string',
  sys_updated_on: 'glide_date_time',
  sys_updated_by: 'string',
  sys_mod_count: 'integer',
};

const SCHEMA = {
  sys_metadata: { label: 'Application File', cols: { sys_scope: 'ref:sys_scope', sys_name: 'string', sys_update_name: 'string', sys_package: 'string', sys_policy: 'string' } },
  sys_scope: { label: 'Application', parent: 'sys_metadata', cols: { name: 'string', scope: 'string', version: 'string', active: 'boolean', vendor: 'string' } },
  sys_app: { label: 'Custom Application', parent: 'sys_scope', cols: { short_description: 'string' } },
  sys_number: { label: 'Number', cols: { prefix: 'string', category: 'string' } },
  // Tables behind the What went wrong? panel (src/lib/failures.js).
  sys_email: { label: 'Email', cols: { type: 'string', state: 'string', recipients: 'string', subject: 'string', error_string: 'string', target_table: 'string' } },
  sys_flow_context: { label: 'Flow Context', cols: { name: 'string', flow: 'string', state: 'string', error_message: 'string', source_table: 'string', source_record: 'string' } },
  sys_trigger: { label: 'Schedule Item', cols: { name: 'string', state: 'string', next_action: 'glide_date_time', trigger_type: 'string' } },
  ecc_queue: { label: 'ECC Queue', cols: { topic: 'string', name: 'string', queue: 'string', agent: 'string', state: 'string', error_string: 'string' } },
  sys_outbound_http_log: { label: 'Outbound HTTP Log', cols: { url: 'string', http_method: 'string', response_code: 'integer', error_message: 'string' } },
  syslog_transaction: { label: 'Transaction Log', cols: { url: 'string', http_method: 'string', response_status: 'integer', response_time: 'integer' } },
  sys_import_set_row: { label: 'Import Set Row', cols: { sys_import_set: 'string', sys_import_state: 'string', sys_row_error: 'string', sys_target_table: 'string' } },
  sys_import_set_run: { label: 'Import Set Run', cols: { sys_import_set: 'string', state: 'string', error_message: 'string', transform_map: 'string' } },
  sysevent: { label: 'Event', cols: { name: 'string', state: 'string', table: 'string', queue: 'string' } },
  sys_db_object: {
    label: 'Table',
    parent: 'sys_metadata',
    cols: { name: 'string', label: 'string', super_class: 'ref:sys_db_object', is_extendable: 'boolean', extension_model: 'string', number_ref: 'ref:sys_number', access: 'string', read_access: 'boolean', create_access: 'boolean', update_access: 'boolean', delete_access: 'boolean' },
  },
  sys_dictionary: {
    label: 'Dictionary Entry',
    parent: 'sys_metadata',
    cols: {
      name: 'table_name', element: 'string', column_label: 'string', internal_type: 'string', reference: 'string', max_length: 'integer', mandatory: 'boolean', read_only: 'boolean',
      default_value: 'string', active: 'boolean', unique: 'boolean', display: 'boolean', choice: 'integer', calculation: 'script', virtual: 'boolean', attributes: 'string', array: 'boolean',
      audit: 'boolean', primary: 'boolean', dependent: 'string', dependent_on_field: 'string', use_dependent_field: 'boolean', reference_qual: 'string', reference_qual_condition: 'conditions',
      use_reference_qualifier: 'string', dynamic_ref_qual: 'string', comments: 'string', function_field: 'boolean',
    },
  },
  sys_dictionary_override: {
    label: 'Dictionary Override',
    parent: 'sys_metadata',
    cols: {
      name: 'table_name', base_table: 'table_name', element: 'string', mandatory_override: 'boolean', mandatory: 'boolean', read_only_override: 'boolean', read_only: 'boolean',
      default_value_override: 'boolean', default_value: 'string', reference_qual_override: 'boolean', reference_qual: 'string', attributes_override: 'boolean', attributes: 'string',
      calculation_override: 'boolean', calculation: 'script', dependent_override: 'boolean', dependent: 'string', display_override: 'boolean', display: 'boolean',
    },
  },
  sys_choice: { label: 'Choice', cols: { name: 'table_name', element: 'string', value: 'string', label: 'string', language: 'string', sequence: 'integer', inactive: 'boolean' } },
  sys_properties: { label: 'System Property', parent: 'sys_metadata', cols: { name: 'string', value: 'string', type: 'string', description: 'string' } },
  sys_user: {
    label: 'User',
    cols: { user_name: 'string', first_name: 'string', last_name: 'string', name: 'string', email: 'email', title: 'string', active: 'boolean', locked_out: 'boolean', sys_domain: 'domain_id', department: 'string', vip: 'boolean' },
  },
  sys_user_role: { label: 'Role', parent: 'sys_metadata', cols: { name: 'string', description: 'string', elevated_privilege: 'boolean', assignable_by: 'string' } },
  sys_user_group: { label: 'Group', cols: { name: 'string', description: 'string', active: 'boolean', manager: 'ref:sys_user', email: 'email' } },
  sys_user_has_role: { label: 'User Role', cols: { user: 'ref:sys_user', role: 'ref:sys_user_role', inherited: 'boolean', granted_by: 'ref:sys_user_group', included_in_role: 'ref:sys_user_role', state: 'string' } },
  sys_user_grmember: { label: 'Group Member', cols: { user: 'ref:sys_user', group: 'ref:sys_user_group' } },
  sys_group_has_role: { label: 'Group Role', cols: { group: 'ref:sys_user_group', role: 'ref:sys_user_role', inherits: 'boolean' } },
  sys_user_role_contains: { label: 'Contained Role', cols: { role: 'ref:sys_user_role', contains: 'ref:sys_user_role' } },
  sys_user_preference: { label: 'User Preference', cols: { user: 'ref:sys_user', name: 'string', value: 'string' } },
  sys_security_acl: {
    label: 'Access Control',
    parent: 'sys_metadata',
    cols: {
      name: 'string', operation: 'ref:sys_security_operation', type: 'ref:sys_security_type', active: 'boolean', admin_overrides: 'boolean', advanced: 'boolean', condition: 'conditions', script: 'script',
      description: 'string', decision_type: 'string', applies_to: 'conditions', security_attribute: 'string',
    },
  },
  sys_security_operation: { label: 'Security Operation', parent: 'sys_metadata', cols: { name: 'string' } },
  sys_security_type: { label: 'Security Type', parent: 'sys_metadata', cols: { name: 'string' } },
  sys_security_acl_role: { label: 'Access Role', parent: 'sys_metadata', cols: { sys_security_acl: 'ref:sys_security_acl', sys_user_role: 'ref:sys_user_role' } },
  sys_app_module: { label: 'Module', parent: 'sys_metadata', cols: { title: 'string', name: 'string', link_type: 'string', query: 'string', active: 'boolean' } },
  sys_script: {
    label: 'Business Rule',
    parent: 'sys_metadata',
    cols: {
      name: 'string', collection: 'table_name', when: 'string', order: 'integer', active: 'boolean', advanced: 'boolean', condition: 'string', filter_condition: 'conditions', script: 'script',
      action_insert: 'boolean', action_update: 'boolean', action_delete: 'boolean', action_query: 'boolean', description: 'string', role_conditions: 'string',
    },
  },
  sys_script_include: { label: 'Script Include', parent: 'sys_metadata', cols: { name: 'string', api_name: 'string', client_callable: 'boolean', active: 'boolean', access: 'string', script: 'script', description: 'string' } },
  sys_script_client: {
    label: 'Client Script',
    parent: 'sys_metadata',
    cols: { name: 'string', table: 'table_name', type: 'string', field: 'string', script: 'script', active: 'boolean', ui_type: 'integer', global: 'boolean', view: 'string', description: 'string', inherited: 'boolean' },
  },
  catalog_script_client: { label: 'Catalog Client Script', parent: 'sys_script_client', cols: { cat_item: 'ref:sc_cat_item', variable_set: 'string' } },
  sc_cat_item: { label: 'Catalog Item', parent: 'sys_metadata', cols: { name: 'string', active: 'boolean' } },
  sys_ui_action: {
    label: 'UI Action',
    parent: 'sys_metadata',
    cols: { name: 'string', table: 'table_name', action_name: 'string', active: 'boolean', client: 'boolean', script: 'script', condition: 'string', order: 'integer', form_button: 'boolean' },
  },
  sys_ui_policy: {
    label: 'UI Policy',
    parent: 'sys_metadata',
    cols: {
      short_description: 'string', table: 'table_name', conditions: 'conditions', on_load: 'boolean', reverse_if_false: 'boolean', order: 'integer', run_scripts: 'boolean',
      script_true: 'script', script_false: 'script', inherit: 'boolean', global: 'boolean', view: 'string', active: 'boolean',
    },
  },
  sys_ui_policy_action: { label: 'UI Policy Action', parent: 'sys_metadata', cols: { ui_policy: 'ref:sys_ui_policy', table: 'table_name', field: 'string', mandatory: 'string', visible: 'string', disabled: 'string', cleared: 'boolean' } },
  sys_data_policy2: { label: 'Data Policy', parent: 'sys_metadata', cols: { short_description: 'string', model_table: 'table_name', conditions: 'conditions', enforce_ui: 'boolean', inherit: 'boolean', active: 'boolean' } },
  sys_data_policy_rule: { label: 'Data Policy Rule', parent: 'sys_metadata', cols: { sys_data_policy: 'ref:sys_data_policy2', table: 'table_name', field: 'string', mandatory: 'string', disabled: 'string' } },
  sysevent_script_action: { label: 'Script Action', parent: 'sys_metadata', cols: { name: 'string', event_name: 'string', script: 'script', active: 'boolean' } },
  sysauto_script: { label: 'Scheduled Script Execution', parent: 'sys_metadata', cols: { name: 'string', script: 'script', run_type: 'string', run_period: 'glide_duration', active: 'boolean' } },
  sys_ws_operation: {
    label: 'Scripted REST Resource',
    parent: 'sys_metadata',
    cols: { name: 'string', http_method: 'string', relative_path: 'string', operation_script: 'script', requires_authentication: 'boolean', requires_acl_authorization: 'boolean', active: 'boolean' },
  },
  sp_widget: { label: 'Widget', parent: 'sys_metadata', cols: { name: 'string', id: 'string', script: 'script', client_script: 'script', public: 'boolean' } },
  sys_ui_script: { label: 'UI Script', parent: 'sys_metadata', cols: { name: 'string', script: 'script', global: 'boolean', active: 'boolean' } },
  sys_public: { label: 'Public Page', parent: 'sys_metadata', cols: { page: 'string', active: 'boolean' } },
  sys_update_set: {
    label: 'Update Set',
    cols: { name: 'string', state: 'string', application: 'ref:sys_scope', is_default: 'boolean', description: 'string', release_date: 'glide_date_time' },
  },
  sys_update_xml: {
    label: 'Customer Update',
    cols: { name: 'string', type: 'string', target_name: 'string', action: 'string', application: 'ref:sys_scope', update_set: 'ref:sys_update_set', payload: 'xml', category: 'string' },
  },
  sys_update_version: {
    label: 'Update Version',
    cols: { name: 'string', sys_recorded_at: 'glide_date_time', source: 'string', state: 'string', action: 'string', payload: 'xml' },
  },
  sys_upgrade_history: { label: 'Upgrade History', cols: { from_version: 'string', to_version: 'string' } },
  sys_upgrade_history_log: {
    label: 'Upgrade Log',
    cols: { upgrade_history: 'ref:sys_upgrade_history', disposition: 'string', resolution_status: 'string', file_name: 'string', target_name: 'string', type: 'string', priority: 'integer' },
  },
  task: {
    label: 'Task',
    cols: {
      number: 'string', short_description: 'string', description: 'string', state: 'integer', priority: 'integer', impact: 'integer', urgency: 'integer', active: 'boolean',
      assignment_group: 'ref:sys_user_group', assigned_to: 'ref:sys_user', opened_by: 'ref:sys_user', sys_domain: 'domain_id',
    },
  },
  incident: { label: 'Incident', parent: 'task', cols: { caller_id: 'ref:sys_user', category: 'string', subcategory: 'string', u_phone: 'phone_number_e164', close_code: 'string', close_notes: 'string' } },
};

const LABELS = {
  'task.number': 'Number', 'task.short_description': 'Short description', 'task.assignment_group': 'Assignment group', 'task.assigned_to': 'Assigned to',
  'task.opened_by': 'Opened by', 'task.sys_domain': 'Domain', 'incident.caller_id': 'Caller', 'incident.u_phone': 'Contact phone', 'incident.close_code': 'Resolution code',
  'incident.close_notes': 'Resolution notes', 'sys_user.user_name': 'User ID', 'sys_update_xml.target_name': 'Target name',
};

const DICT_FLAGS = {
  'task.number': { read_only: 'true', max_length: '40', default_value: 'javascript:getNextObjNumberPadded();' },
  'task.short_description': { mandatory: 'true', max_length: '160' },
  'task.priority': { choice: '1', default_value: '5' },
  'task.state': { choice: '1', default_value: '1' },
  'incident.caller_id': { mandatory: 'true', reference_qual: 'active=true', use_reference_qualifier: 'simple', reference_qual_condition: 'active=true^EQ' },
  'incident.category': { choice: '1', default_value: 'inquiry' },
  'incident.close_code': { choice: '1' },
  'task.assignment_group': { attributes: 'tree_picker=true', reference_qual_condition: 'type=assignment^EQ', use_reference_qualifier: 'simple' },
};

const DISPLAY_COLUMN = { sys_user: 'name', task: 'number', sys_user_has_role: 'role', sys_update_xml: 'target_name', sys_ui_policy: 'short_description', sys_data_policy2: 'short_description' };

const parentOf = (t) => SCHEMA[t]?.parent || '';
function chain(table) {
  const out = [];
  for (let t = table; t && SCHEMA[t] && !out.includes(t); t = parentOf(t)) out.push(t);
  return out;
}
function descendants(table) {
  return Object.keys(SCHEMA).filter((t) => chain(t).includes(table));
}
function columnSpec(table, column) {
  for (const t of chain(table)) {
    const own = SCHEMA[t].cols[column] || (!parentOf(t) ? ROOT_COLS[column] : undefined);
    if (own) return { spec: own, definedOn: t };
  }
  return null;
}
function columnsOf(table) {
  const cols = [];
  chain(table)
    .reverse()
    .forEach((t) => {
      if (!parentOf(t)) cols.push(...Object.keys(ROOT_COLS));
      cols.push(...Object.keys(SCHEMA[t].cols));
    });
  return [...new Set(cols)];
}
const refTarget = (spec) => (typeof spec === 'string' && spec.startsWith('ref:') ? spec.slice(4) : '');

/* ---------------------------------------------------------------- data */

// Save trace (/savetrace): the tables a save leaves rows in. sys_audit_delete and wf_context are left out on purpose, so
// the panel shows "not available on this instance" for them. Rows come from window.__fake.addSaveTraceRows().
// A table another fixture already declares keeps its columns; these are only added to it.
const TRACE_TABLES = {
  sys_audit: { label: 'Audit', cols: { tablename: 'string', documentkey: 'string', fieldname: 'string', oldvalue: 'string', newvalue: 'string', user: 'string', reason: 'string' } },
  syslog: { label: 'System Log', cols: { level: 'string', source: 'string', message: 'string' } },
  syslog_transaction: { label: 'Transaction Log', cols: { url: 'string', http_method: 'string', response_time: 'integer', sql_time: 'integer', sql_count: 'integer', business_rule_time: 'integer', business_rule_count: 'integer', status: 'string' } },
  sysevent: { label: 'Event', cols: { name: 'string', parm1: 'string', parm2: 'string', state: 'string', table: 'string', instance: 'string' } },
  sys_email: { label: 'Email', cols: { type: 'string', state: 'string', subject: 'string', recipients: 'string', error_string: 'string', instance: 'string' } },
  sys_flow_context: { label: 'Flow Context', cols: { name: 'string', state: 'string', source_table: 'string', source_record: 'string', started: 'glide_date_time', ended: 'glide_date_time', error_message: 'string' } },
  sys_journal_field: { label: 'Journal Entry', cols: { element: 'string', value: 'string', element_id: 'string', name: 'string' } },
  task_sla: { label: 'Task SLA', cols: { sla: 'string', stage: 'string', has_breached: 'boolean', task: 'string' } },
  sysapproval_approver: { label: 'Approval', cols: { approver: 'string', state: 'string', comments: 'string', sysapproval: 'string' } },
  sys_attachment: { label: 'Attachment', cols: { file_name: 'string', size_bytes: 'integer', content_type: 'string', table_sys_id: 'string' } },
};
Object.entries(TRACE_TABLES).forEach(([table, def]) => {
  if (SCHEMA[table]) Object.assign(SCHEMA[table].cols, def.cols);
  else SCHEMA[table] = def;
});

const DB = Object.fromEntries(Object.keys(SCHEMA).map((t) => [t, []]));

/** Rows as a save of the fake incident would leave them, timestamped just now (so they fall inside an armed window). */
function seedSaveTrace() {
  const ms = (ago) => fmt(Date.now() - ago);
  const row = (table, ago, fields) => add(table, `trace:${table}:${Math.random()}`, { sys_created_on: ms(ago), sys_created_by: ME.userName, ...fields });
  row('sys_audit', 1500, { tablename: 'incident', documentkey: INCIDENT_ID, fieldname: 'state', oldvalue: '1', newvalue: '2', user: ME.userName });
  row('sys_audit', 1500, { tablename: 'incident', documentkey: INCIDENT_ID, fieldname: 'priority', oldvalue: '4', newvalue: '3', user: ME.userName });
  row('syslog', 1200, { level: '0', source: 'Business Rule: Set priority from impact', message: 'priority recalculated: impact 2, urgency 2' });
  row('syslog', 1100, { level: '2', source: 'Script Include: IncidentUtils', message: "TypeError: Cannot read properties of undefined (reading 'sys_id')" });
  row('syslog', 1000, { level: '1', source: 'Business Rule: Notify group', message: 'assignment group has no email address' });
  row('syslog', 900, { level: '2', source: 'Flow Designer', message: `Flow action failed for incident ${INCIDENT_ID}: group not active`, sys_created_by: 'system' });
  row('syslog', 900, { level: '2', source: 'Flow Designer', message: 'Unrelated failure elsewhere', sys_created_by: 'system' });
  row('syslog_transaction', 600, { url: '/incident.do?sys_id=x', http_method: 'POST', response_time: '4180', sql_time: '1620', sql_count: '88', business_rule_time: '2410', business_rule_count: '14', status: '200' });
  row('sys_update_xml', 700, { name: 'sys_script_ab12', type: 'Business Rule', target_name: 'Set priority from impact', action: 'INSERT_OR_UPDATE', update_set: id('sys_update_set', 'STRY0012') });
  row('sysevent', 800, { name: 'incident.assigned', state: 'processed', table: 'incident', instance: INCIDENT_ID });
  row('sysevent', 750, { name: 'incident.commented', state: 'error', table: 'incident', instance: INCIDENT_ID, parm1: 'maria.dev' });
  row('sys_email', 500, { type: 'send-ready', state: 'send-ready', subject: 'Incident assigned to your group', recipients: 'service.desk@example.com', instance: INCIDENT_ID });
  row('sys_email', 450, { type: 'send-ready', state: 'send-failed', subject: 'Caller update', recipients: 'abel.tuter@example.com', error_string: 'SMTP 550: mailbox unavailable', instance: INCIDENT_ID });
  row('sys_flow_context', 400, { name: 'Notify assignment group', state: 'COMPLETE', source_table: 'incident', source_record: INCIDENT_ID, started: ms(400), ended: ms(150) });
  row('sys_journal_field', 300, { element: 'work_notes', value: 'Reassigned to Network team after impact change', element_id: INCIDENT_ID, name: 'incident' });
  row('task_sla', 280, { sla: 'P1 resolution', stage: 'In progress', has_breached: 'false', task: INCIDENT_ID });
  row('sysapproval_approver', 260, { approver: 'Abel Tuter', state: 'requested', comments: 'Change of priority needs approval', sysapproval: INCIDENT_ID });
  row('sys_attachment', 240, { file_name: 'screenshot.png', size_bytes: '20480', content_type: 'image/png', table_sys_id: INCIDENT_ID });
}

const ME = { key: 'maria.dev', id: sid('sys_user:maria.dev'), userName: 'maria.dev', name: 'Maria Gomez', first: 'Maria', last: 'Gomez' };
const IS_METADATA = (t) => chain(t).includes('sys_metadata');

function add(table, key, fields = {}) {
  const row = {
    sys_id: fields.sys_id || sid(`${table}:${key}`),
    sys_class_name: table,
    sys_created_on: ago(420),
    sys_created_by: 'admin',
    sys_updated_on: ago(400),
    sys_updated_by: 'admin',
    sys_mod_count: '2',
    ...(IS_METADATA(table) ? { sys_scope: 'global', sys_package: 'global' } : {}),
    ...fields,
  };
  if (IS_METADATA(table) && !row.sys_update_name) row.sys_update_name = `${table}_${row.sys_id}`;
  if (IS_METADATA(table) && !row.sys_name) row.sys_name = row.name || row.short_description || row.element || '';
  DB[table].push(row);
  return row;
}
const id = (table, key) => sid(`${table}:${key}`);
const custom = (by = ME.userName, days = 2, hours = 3) => ({ sys_created_by: by, sys_created_on: ago(days + 20), sys_updated_by: by, sys_updated_on: ago(days, hours) });

// --- applications
add('sys_scope', 'global', { sys_id: 'global', name: 'Global', scope: 'global', version: '', active: 'true' });
add('sys_app', 'x_acme_hr', { name: 'HR Tweaks', scope: 'x_acme_hr', version: '1.4.0', active: 'true', vendor: 'Acme' });
add('sys_app', 'x_acme_cmdb', { name: 'CMDB Health Tools', scope: 'x_acme_cmdb', version: '0.9.2', active: 'true', vendor: 'Acme' });
add('sys_number', 'INC', { prefix: 'INC', category: 'incident' });

// --- tables and dictionary, generated from SCHEMA
Object.entries(SCHEMA).forEach(([table, def]) => {
  add('sys_db_object', table, {
    name: table,
    label: def.label,
    super_class: def.parent ? id('sys_db_object', def.parent) : '',
    is_extendable: String(descendants(table).length > 1 || ['task', 'sys_metadata'].includes(table)),
    extension_model: '',
    number_ref: table === 'incident' ? id('sys_number', 'INC') : '',
    access: 'public',
    read_access: 'true',
    create_access: 'false',
    update_access: 'false',
    delete_access: 'false',
  });
  add('sys_dictionary', `${table}.`, { name: table, element: '', column_label: def.label, internal_type: 'collection' });
  const own = { ...(def.parent ? {} : ROOT_COLS), ...def.cols };
  Object.entries(own).forEach(([element, spec]) => {
    const ref = refTarget(spec);
    const label = LABELS[`${table}.${element}`] || element.replace(/^u_/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    add('sys_dictionary', `${table}.${element}`, {
      name: table,
      element,
      column_label: element === 'sys_id' ? 'Sys ID' : label,
      internal_type: ref ? 'reference' : spec,
      reference: ref,
      max_length: ref || spec === 'GUID' ? '32' : spec === 'script' || spec === 'xml' ? '65000' : '40',
      mandatory: 'false',
      read_only: element.startsWith('sys_') && element !== 'sys_scope' && element !== 'sys_domain' ? 'true' : 'false',
      active: 'true',
      display: DISPLAY_COLUMN[table] === element || (!DISPLAY_COLUMN[table] && element === 'name') ? 'true' : 'false',
      choice: '0',
      ...(element === 'u_phone' ? custom(ME.userName, 5) : {}),
      ...(DICT_FLAGS[`${table}.${element}`] || {}),
    });
  });
});
add('sys_dictionary_override', 'incident.state', { name: 'incident', base_table: 'task', element: 'state', default_value_override: 'true', default_value: '1', mandatory_override: 'false', read_only_override: 'false' });
add('sys_dictionary_override', 'incident.priority', { name: 'incident', base_table: 'task', element: 'priority', read_only_override: 'true', read_only: 'true', mandatory_override: 'false' });

// --- choices
[
  ['task', 'state', [['1', 'New'], ['2', 'In Progress'], ['3', 'On Hold'], ['6', 'Resolved'], ['7', 'Closed'], ['8', 'Canceled']]],
  ['task', 'priority', [['1', '1 - Critical'], ['2', '2 - High'], ['3', '3 - Moderate'], ['4', '4 - Low'], ['5', '5 - Planning']]],
  ['incident', 'category', [['inquiry', 'Inquiry / Help'], ['software', 'Software'], ['hardware', 'Hardware'], ['network', 'Network']]],
  ['incident', 'close_code', [['solved_permanently', 'Solved (Permanently)'], ['workaround', 'Solved (Work Around)'], ['not_solved', 'Not Solved']]],
  ['sys_security_acl', 'type', [['record', 'record'], ['client_callable_script_include', 'client_callable_script_include'], ['ui_page', 'ui_page'], ['rest_endpoint', 'REST_Endpoint']]],
  ['sys_security_acl', 'operation', [['read', 'read'], ['write', 'write'], ['create', 'create'], ['delete', 'delete'], ['execute', 'execute'], ['query_range', 'query_range'], ['query_match', 'query_match']]],
  ['sys_upgrade_history_log', 'disposition', [['1', 'Inserted'], ['2', 'Updated'], ['4', 'Skipped'], ['9', 'Skipped Manual Merge']]],
  ['sys_upgrade_history_log', 'resolution_status', [['not_reviewed', 'Not Reviewed'], ['reviewed_retained', 'Reviewed and Retained'], ['reverted', 'Reverted to Base System']]],
].forEach(([name, element, list]) =>
  list.forEach(([value, label], i) => add('sys_choice', `${name}.${element}.${value}`, { name, element, value, label, language: 'en', sequence: String(i * 10), inactive: 'false' }))
);

// --- properties
[
  ['glide.sm.default_mode', 'deny'],
  ['glide.appcreator.company.code', 'acme'],
  ['glide.security.use_csrf_token', 'true'],
  ['glide.ui.escape_text', 'true'],
  ['glide.script.use.sandbox', 'true'],
].forEach(([name, value]) => add('sys_properties', name, { name, value, type: 'string' }));

// --- users, groups, roles
[
  [ME.key, ME.first, ME.last, 'Senior ServiceNow Developer'],
  ['beth.anglin', 'Beth', 'Anglin', 'Service Desk Analyst'],
  ['david.loo', 'David', 'Loo', 'Sales Associate'],
  ['fred.luddy', 'Fred', 'Luddy', 'Former Admin', { active: 'false', locked_out: 'true' }],
  ['abel.tuter', 'Abel', 'Tuter', 'Field Engineer', { vip: 'true' }],
  ['bow.ruggeri', 'Bow', 'Ruggeri', 'Incident Manager'],
].forEach(([userName, first, last, title, extra]) =>
  add('sys_user', userName, { user_name: userName, first_name: first, last_name: last, name: `${first} ${last}`, email: `${userName}@acme.example`, title, active: 'true', locked_out: 'false', sys_domain: 'global', department: '', vip: 'false', ...(extra || {}) })
);
const user = (k) => id('sys_user', k);

[
  ['admin', 'Full access to the instance'],
  ['security_admin', 'Elevated role for security settings', 'true'],
  ['itil', 'Fulfiller: works on tasks'],
  ['itil_admin', 'Administers ITIL applications'],
  ['incident_manager', 'Manages incidents'],
  ['snc_internal', 'Internal user'],
  ['personalize_form', 'Personalize forms'],
  ['catalog_admin', 'Service catalog administration'],
  ['sn_incident_read', 'Read incidents'],
].forEach(([name, description, elevated]) => add('sys_user_role', name, { name, description, elevated_privilege: elevated || 'false' }));
const role = (k) => id('sys_user_role', k);

[
  ['Service Desk', 'First line support'],
  ['Hardware', 'Hardware support'],
  ['Incident Managers', 'Major incident management'],
  ['Platform Developers', 'ServiceNow platform team'],
  ['Legacy Ops', 'Retired group', 'false'],
].forEach(([name, description, active]) => add('sys_user_group', name, { name, description, active: active || 'true', manager: user('bow.ruggeri') }));
const group = (k) => id('sys_user_group', k);

[
  ['Service Desk', 'itil'],
  ['Hardware', 'itil'],
  ['Incident Managers', 'incident_manager'],
  ['Platform Developers', 'personalize_form'],
  ['Legacy Ops', 'itil_admin'],
].forEach(([g, r]) => add('sys_group_has_role', `${g}:${r}`, { group: group(g), role: role(r), inherits: 'true' }));

[
  ['incident_manager', 'itil'],
  ['itil_admin', 'itil'],
  ['itil', 'sn_incident_read'],
  ['admin', 'itil_admin'],
  ['admin', 'catalog_admin'],
].forEach(([r, c]) => add('sys_user_role_contains', `${r}>${c}`, { role: role(r), contains: role(c) }));

[
  [ME.key, 'Platform Developers'],
  [ME.key, 'Service Desk'],
  ['beth.anglin', 'Service Desk'],
  ['beth.anglin', 'Legacy Ops'],
  ['bow.ruggeri', 'Incident Managers'],
  ['bow.ruggeri', 'Hardware'],
].forEach(([u, g]) => add('sys_user_grmember', `${u}:${g}`, { user: user(u), group: group(g) }));

[
  [ME.key, 'admin'],
  [ME.key, 'snc_internal'],
  [ME.key, 'itil', 'Service Desk'],
  [ME.key, 'personalize_form', 'Platform Developers'],
  ['beth.anglin', 'snc_internal'],
  ['beth.anglin', 'itil', 'Service Desk'],
  ['david.loo', 'snc_internal'],
  ['bow.ruggeri', 'snc_internal'],
  ['bow.ruggeri', 'incident_manager', 'Incident Managers'],
  ['bow.ruggeri', 'itil', 'Hardware'],
  ['fred.luddy', 'admin'],
].forEach(([u, r, g]) =>
  add('sys_user_has_role', `${u}:${r}:${g || ''}`, { user: user(u), role: role(r), inherited: g ? 'true' : 'false', granted_by: g ? group(g) : '', included_in_role: '', state: 'active' })
);
// Contained roles are stored too, as inherited rows pointing at the role that contains them.
[
  [ME.key, 'itil_admin', 'admin'],
  [ME.key, 'catalog_admin', 'admin'],
  [ME.key, 'sn_incident_read', 'itil'],
  ['beth.anglin', 'sn_incident_read', 'itil'],
  ['bow.ruggeri', 'sn_incident_read', 'itil'],
].forEach(([u, r, parent]) =>
  add('sys_user_has_role', `${u}:${r}:<${parent}`, { user: user(u), role: role(r), inherited: 'true', granted_by: '', included_in_role: role(parent), state: 'active' })
);

add('sys_user_preference', `${ME.key}:sys_update_set`, { user: ME.id, name: 'sys_update_set', value: id('sys_update_set', 'STRY0012') });
add('sys_user_preference', `${ME.key}:apps.current_app`, { user: ME.id, name: 'apps.current_app', value: 'global' });
add('sys_app_module', 'access_analyzer', { title: 'Access Analyzer', name: 'sn_access_analyzer', link_type: 'DIRECT', query: '$access_analyzer.do', active: 'true' });

// --- task data
const INCIDENT_ID = '9de5069c0b0f0300b8b9e5cd35673a5b';
add('incident', 'INC0010042', {
  sys_id: INCIDENT_ID, number: 'INC0010042', short_description: 'Laptop will not boot', description: 'Black screen after the BIOS logo since this morning.', state: '2', priority: '1',
  impact: '1', urgency: '1', active: 'true', assignment_group: '', assigned_to: '', opened_by: user('abel.tuter'), sys_domain: 'global', caller_id: user('abel.tuter'),
  category: 'hardware', subcategory: '', u_phone: '+61 2 5550 1234', close_code: '', close_notes: '', sys_created_on: ago(0, 5), sys_updated_on: ago(0, 1), sys_updated_by: 'abel.tuter',
});
[
  ['INC0010041', 'VPN drops every 10 minutes', '2', '2', 'Service Desk', 'beth.anglin', 'network'],
  ['INC0010039', 'Outlook keeps asking for the password', '1', '3', 'Service Desk', '', 'software'],
  ['INC0010036', 'Printer on level 4 jams', '6', '4', 'Hardware', 'bow.ruggeri', 'hardware'],
  ['INC0010031', 'Request a second monitor', '7', '5', 'Hardware', 'bow.ruggeri', 'hardware'],
].forEach(([number, short, state, priority, g, a, category], i) =>
  add('incident', number, {
    number, short_description: short, state, priority, impact: '2', urgency: '2', active: String(!['6', '7'].includes(state)), assignment_group: group(g), assigned_to: a ? user(a) : '',
    opened_by: user('david.loo'), sys_domain: 'global', caller_id: user('david.loo'), category, subcategory: '', u_phone: '', close_code: state === '7' ? 'solved_permanently' : '',
    sys_created_on: ago(i + 1), sys_updated_on: ago(i, 2), sys_updated_by: 'beth.anglin',
  })
);

// --- configuration: business rules
const BR_SYNC = `(function executeRule(current, previous /*null when async*/) {
	var tasks = new GlideRecord('incident_task');
	tasks.addQuery('incident', current.getUniqueValue());
	tasks.query();
	while (tasks.next()) {
		var grp = new GlideRecord('sys_user_group');
		grp.get('8a5055c9c61122780043563ef53438e3');
		tasks.assignment_group = grp.getUniqueValue();
		tasks.update();
	}
	current.work_notes = 'Synced ' + tasks.getRowCount() + ' tasks';
	current.update();
})(current, previous);`;
const BR_NOTIFY = `(function executeRule(current, previous /*null when async*/) {
	gs.sleep(2000);
	var r = new sn_ws.RESTMessageV2();
	r.setEndpoint('https://acmeprod.service-now.com/api/x_acme/notify');
	r.setBasicAuth('integration', 'Winter2026!');
	r.setRequestBody(JSON.stringify({ number: current.getValue('number') }));
	r.execute();
})(current, previous);`;
const BR_QUERY = `(function executeRule(current, previous) {
	if (!gs.hasRole('itil') && gs.isInteractive()) {
		var u = gs.getUserID();
		current.addQuery('caller_id', u).addOrCondition('opened_by', u).addOrCondition('watch_list', 'CONTAINS', u);
	}
})(current, previous);`;
const brBase = { action_insert: 'false', action_update: 'false', action_delete: 'false', action_query: 'false', active: 'true', advanced: 'true', condition: '', filter_condition: '', description: '' };
add('sys_script', 'incident query', { ...brBase, name: 'incident query', collection: 'incident', when: 'before', order: '100', action_query: 'true', script: BR_QUERY, condition: 'gs.getSession().isInteractive() && !gs.hasRole("itil")' });
add('sys_script', 'sync group', { ...brBase, name: 'Incident - sync assignment group', collection: 'incident', when: 'after', order: '100', action_update: 'true', script: BR_SYNC, ...custom(ME.userName, 0, 2) });
add('sys_script', 'notify P1', { ...brBase, name: 'Notify caller on P1', collection: 'incident', when: 'async', order: '200', action_insert: 'true', filter_condition: 'priority=1^EQ', script: BR_NOTIFY, ...custom(ME.userName, 3) });
add('sys_script', 'debug logging', { ...brBase, name: 'Incident - debug logging', collection: 'incident', when: 'before', order: '100', action_update: 'true', script: "gs.log('incident updated: ' + current.number);", ...custom(ME.userName, 1) });
add('sys_script', 'default category', { ...brBase, name: 'Incident - default category', collection: 'incident', when: 'before', order: '100', action_insert: 'true', script: "if (!current.category) current.category = 'inquiry';", ...custom('beth.anglin', 12) });
// Rules for "Why didn't my rule run?": one switched off, one needing a role, one that only runs on insert.
add('sys_script', 'legacy escalation', { ...brBase, name: 'Incident - legacy escalation', collection: 'incident', when: 'before', order: '150', action_update: 'true', active: 'false', filter_condition: 'priority=1^EQ', script: "current.escalation = 2;" });
add('sys_script', 'security review', { ...brBase, name: 'Incident - security review', collection: 'incident', when: 'after', order: '300', action_update: 'true', role_conditions: role('security_admin'), filter_condition: 'category=security^EQ', script: "gs.info('review');" });
add('sys_script', 'insert only', { ...brBase, name: 'Incident - first response SLA', collection: 'incident', when: 'before', order: '120', action_insert: 'true', filter_condition: 'priority<=2^EQ', script: "current.u_first_response = true;" });
add('sys_script', 'priority calc', { ...brBase, name: 'Set priority from impact/urgency', collection: 'task', when: 'before', order: '50', action_insert: 'true', action_update: 'true', script: 'current.priority = new PriorityLookup().lookup(current.impact, current.urgency);' });

// --- script includes
const SI_UTILS = `var IncidentUtils = Class.create();
IncidentUtils.prototype = Object.extendsObject(AbstractAjaxProcessor, {
	getOpenCount: function() {
		var gr = new GlideRecord('incident');
		gr.query();
		return gr.getRowCount();
	},
	type: 'IncidentUtils'
});`;
const SI_LEGACY = `var LegacyHelper = Class.create();
LegacyHelper.prototype = {
	initialize: function() {},
	run: function(code) {
		return eval(code);
	},
	type: 'LegacyHelper'
};`;
add('sys_script_include', 'IncidentUtils', { name: 'IncidentUtils', api_name: 'global.IncidentUtils', client_callable: 'true', active: 'true', access: 'package_private', script: SI_UTILS, description: 'Incident helpers for client scripts', ...custom(ME.userName, 0, 4) });
const BR_COUNT = `(function executeRule(current, previous /*null when async*/) {
  var open = new IncidentUtils().getOpenCount();
  gs.info('open incidents: ' + open);
})(current, previous);`;
const CS_COUNT = `function onLoad() {
  var ga = new GlideAjax('IncidentUtils');
  ga.addParam('sysparm_name', 'getOpenCount');
  ga.getXMLAnswer(function (answer) { g_form.addInfoMessage(answer); });
}`;
add('sys_script', 'count open', { ...brBase, name: 'Log open incident count', collection: 'task', when: 'after', order: '300', action_insert: 'true', script: BR_COUNT });
add('sys_script_client', 'count open', { ...csBase, name: 'Show open incident count', table: 'incident', type: 'onLoad', active: 'true', script: CS_COUNT });
add('sys_script_include', 'LegacyHelper', { name: 'LegacyHelper', api_name: 'global.LegacyHelper', client_callable: 'false', active: 'true', access: 'public', script: SI_LEGACY, ...custom(ME.userName, 4) });
add('sys_script_include', 'PriorityLookup', { name: 'PriorityLookup', api_name: 'global.PriorityLookup', client_callable: 'false', active: 'true', access: 'public', script: 'var PriorityLookup = Class.create();' });

// --- client scripts
const CS_P1 = `function onChange(control, oldValue, newValue, isLoading, isTemplate) {
	if (newValue === '1') {
		g_form.setMandatory('assignment_group', true);
		g_form.showFieldMsg('assignment_group', 'P1 incidents need an assignment group', 'info');
	}
}`;
const CS_PHONE = `function onLoad() {
	if (!g_user.hasRole('itil')) {
		g_form.setDisplay('u_phone', false);
		document.getElementById('incident.u_phone').style.color = 'red';
	}
}`;
const CS_CATEGORY = `function onChange(control, oldValue, newValue, isLoading, isTemplate) {
	if (isLoading || newValue === '') {
		return;
	}
	var ga = new GlideAjax('IncidentUtils');
	ga.addParam('sysparm_name', 'getOpenCount');
	ga.getXMLWait();
	g_form.setValue('subcategory', ga.getAnswer());
}`;
const csBase = { active: 'true', ui_type: '0', global: 'true', view: '', description: '', inherited: 'false', field: '' };
add('sys_script_client', 'P1 group', { ...csBase, name: 'Incident - require group on P1', table: 'incident', type: 'onChange', field: 'priority', script: CS_P1, ...custom(ME.userName, 0, 3) });
add('sys_script_client', 'hide phone', { ...csBase, name: 'Hide phone for ESS', table: 'incident', type: 'onLoad', script: CS_PHONE, ...custom(ME.userName, 1, 6) });
add('sys_script_client', 'category', { ...csBase, name: 'Category defaults', table: 'incident', type: 'onChange', field: 'category', script: CS_CATEGORY, ...custom(ME.userName, 2) });
add('sys_script_client', 'vip', { ...csBase, name: 'Highlight VIP Caller', table: 'incident', type: 'onChange', field: 'caller_id', script: "function onChange(control, oldValue, newValue, isLoading) {\n\tif (isLoading) return;\n}" });

// --- UI policies, data policies, UI actions, ACLs
const upBase = { on_load: 'true', reverse_if_false: 'true', order: '100', run_scripts: 'false', script_true: '', script_false: '', inherit: 'false', global: 'true', view: '', active: 'true' };
add('sys_ui_policy', 'P1 group', { ...upBase, short_description: 'Make assignment group mandatory for P1', table: 'incident', conditions: 'priority=1^EQ', ...custom(ME.userName, 0, 3) });
add('sys_ui_policy', 'lock closed', { ...upBase, short_description: 'Lock closed incidents', table: 'incident', conditions: 'state=7^EQ', order: '200' });
add('sys_ui_policy', 'close fields', { ...upBase, short_description: 'Show resolution fields when resolved', table: 'incident', conditions: 'state=6^ORstate=7^EQ', run_scripts: 'true', script_true: "function onCondition() {\n\tg_form.showFieldMsg('close_code', 'Pick a resolution code');\n}" });
const upa = (policy, field, flags) => add('sys_ui_policy_action', `${policy}:${field}`, { ui_policy: id('sys_ui_policy', policy), table: 'incident', field, mandatory: 'ignore', visible: 'ignore', disabled: 'ignore', cleared: 'false', ...flags });
upa('P1 group', 'assignment_group', { mandatory: 'true', ...custom(ME.userName, 0, 3) });
upa('lock closed', 'short_description', { disabled: 'true' });
upa('lock closed', 'priority', { disabled: 'true' });
upa('close fields', 'close_code', { visible: 'true', mandatory: 'true' });
upa('close fields', 'close_notes', { visible: 'true' });
add('sys_data_policy2', 'close code', { short_description: 'Resolution code required when resolved', model_table: 'incident', conditions: 'state=6^EQ', enforce_ui: 'true', inherit: 'false', active: 'true' });
add('sys_data_policy_rule', 'close code', { sys_data_policy: id('sys_data_policy2', 'close code'), table: 'incident', field: 'close_code', mandatory: 'true', disabled: 'ignore' });
add('sys_data_policy_rule', 'priority ro', { sys_data_policy: id('sys_data_policy2', 'close code'), table: 'incident', field: 'priority', mandatory: 'ignore', disabled: 'true' });

add('sys_ui_action', 'resolve', { name: 'Resolve Incident', table: 'incident', action_name: 'resolve_incident', active: 'true', client: 'false', script: "current.state = 6;\ncurrent.update();\naction.setRedirectURL(current);", condition: 'current.state < 6', order: '100', form_button: 'true' });
add('sys_ui_action', 'escalate', { name: 'Escalate to major incident', table: 'incident', action_name: 'escalate_major', active: 'true', client: 'true', script: "function escalate() {\n\tdocument.querySelector('#incident\\\\.priority').value = '1';\n\tgsftSubmit(null, g_form.getFormElement(), 'escalate_major');\n}", condition: '', order: '300', form_button: 'true', ...custom(ME.userName, 1, 2) });
add('sys_ui_action', 'copy', { name: 'Copy incident', table: 'incident', action_name: 'copy_incident', active: 'true', client: 'false', script: 'var copy = new GlideRecord("incident");\ncopy.initialize();', condition: '', order: '400', form_button: 'false', ...custom(ME.userName, 0, 7) });

['read', 'write', 'create', 'delete', 'execute', 'query_range', 'query_match', 'report_view'].forEach((n) => add('sys_security_operation', n, { name: n }));
['record', 'client_callable_script_include', 'ui_page', 'REST_Endpoint'].forEach((n) => add('sys_security_type', n, { name: n }));
function acl(key, name, operation, roles, extra = {}) {
  const { type = 'record', ...rest } = extra;
  add('sys_security_acl', key, { name, operation: id('sys_security_operation', operation), type: id('sys_security_type', type), active: 'true', admin_overrides: 'true', advanced: 'false', condition: '', script: '', description: '', decision_type: 'allow', applies_to: '', security_attribute: '', ...rest });
  roles.forEach((r) => add('sys_security_acl_role', `${key}:${r}`, { sys_security_acl: id('sys_security_acl', key), sys_user_role: role(r) }));
}
acl('incident read', 'incident', 'read', ['itil', 'sn_incident_read'], { description: 'Fulfillers can read incidents' });
acl('incident read caller', 'incident', 'read', [], { condition: 'caller_id=javascript:gs.getUserID()^EQ', description: 'Callers can read their own incidents' });
acl('incident write', 'incident', 'write', ['itil'], { condition: 'active=true^EQ', description: 'Fulfillers can update open incidents' });
acl('incident create', 'incident', 'create', ['itil']);
acl('incident create ess', 'incident', 'create', ['snc_internal']);
acl('incident delete', 'incident', 'delete', ['admin'], { admin_overrides: 'false' });
acl('incident priority write', 'incident.priority', 'write', ['itil'], { advanced: 'true', script: 'answer = gs.hasRole("itil") && current.state != 7;', ...custom(ME.userName, 0, 5) });
acl('incident close_code write', 'incident.close_code', 'write', ['incident_manager']);
acl('incident star read', 'incident.*', 'read', []);
acl('task read', 'task', 'read', ['itil']);
acl('task read deny', 'task', 'read', ['snc_internal'], { decision_type: 'deny', description: 'Deny-Unless: only internal users read tasks' });
acl('task write', 'task', 'write', ['itil']);
acl('star read', '*', 'read', ['admin']);
acl('incident qr', 'incident', 'query_range', ['itil']);
acl('incident qm', 'incident', 'query_match', []);
acl('incident read old', 'incident', 'read', ['itil_admin'], { active: 'false', description: 'Old rule kept for reference' });
acl('si IncidentUtils', 'IncidentUtilsOld', 'execute', ['itil'], { type: 'client_callable_script_include' });

// --- jobs, widgets, REST, UI scripts
add('sysauto_script', 'close stale', { name: 'Close stale incidents', run_type: 'periodically', run_period: '1970-01-01 00:01:00', active: 'true', script: "var gr = new GlideRecord('incident');\ngr.addQuery('state', 6);\ngr.query();\nwhile (gr.next()) {\n\tgr.state = 7;\n\tgr.update();\n}", ...custom(ME.userName, 3, 1) });
add('sys_ws_operation', 'get orders', { name: 'Get orders', http_method: 'GET', relative_path: '/orders', operation_script: "(function process(request, response) {\n\tvar gr = new GlideRecord('x_acme_order');\n\tgr.query();\n\tresponse.setBody({ count: gr.getRowCount() });\n})(request, response);", requires_authentication: 'false', requires_acl_authorization: 'false', active: 'true', sys_scope: id('sys_app', 'x_acme_hr'), ...custom(ME.userName, 9) });
add('sp_widget', 'hr card', { name: 'HR Request Card', id: 'x_acme_hr_card', script: "(function() {\n\tdata.count = new GlideAggregate('x_acme_hr_case').getRowCount();\n})();", client_script: 'api.controller = function() {\n\tvar c = this;\n};', public: 'true', sys_scope: id('sys_app', 'x_acme_hr'), ...custom(ME.userName, 6) });
add('sys_ui_script', 'acme helpers', { name: 'acme_global_helpers', script: 'var AcmeHelpers = { tag: function () { return "acme"; } };', global: 'true', active: 'true', ...custom('beth.anglin', 40) });
add('sys_public', 'kb', { page: 'kb_view', active: 'true' });

// --- upgrade history
add('sys_upgrade_history', 'xanadu', { from_version: 'glide-washingtondc-12-20-2023__patch6', to_version: 'glide-xanadu-07-02-2024__patch7', sys_created_on: ago(41) });
[
  ['sys_script_client_' + id('sys_script_client', 'vip'), 'Highlight VIP Caller', 'Client Script', '2'],
  ['sys_ui_policy_' + id('sys_ui_policy', 'lock closed'), 'Lock closed incidents', 'UI Policy', '3'],
  ['sys_script_' + id('sys_script', 'priority calc'), 'Set priority from impact/urgency', 'Business Rule', '1'],
].forEach(([file, target, type, priority]) =>
  add('sys_upgrade_history_log', file, { upgrade_history: id('sys_upgrade_history', 'xanadu'), disposition: '4', resolution_status: 'not_reviewed', file_name: file, target_name: target, type, priority })
);

// --- update sets and their entries
const SETS = {
  STRY0012: { name: 'STRY0012 Incident P1 handling', state: 'in progress', application: 'global', is_default: 'false', description: 'P1 incidents need an assignment group; sync tasks.', ...custom(ME.userName, 0, 1), sys_created_on: ago(6) },
  STRY0015: { name: 'STRY0015 Close stale incidents', state: 'in progress', application: 'global', is_default: 'false', description: 'Nightly clean-up job.', ...custom(ME.userName, 3), sys_created_on: ago(9) },
  Default: { name: 'Default', state: 'in progress', application: 'global', is_default: 'true', description: 'Default update set', sys_created_by: 'system', sys_updated_by: ME.userName, sys_updated_on: ago(1, 6) },
  HR: { name: 'HR portal tweaks', state: 'in progress', application: id('sys_app', 'x_acme_hr'), is_default: 'false', description: '', ...custom(ME.userName, 6), sys_created_on: ago(70) },
  R2609: { name: 'Release 2026.09', state: 'complete', application: 'global', is_default: 'false', description: 'September release', ...custom(ME.userName, 25) },
  OLD: { name: 'Old fixes', state: 'ignore', application: 'global', is_default: 'false', description: '', ...custom('fred.luddy', 300) },
};
Object.entries(SETS).forEach(([key, fields]) => add('sys_update_set', key, fields));

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function payloadFor(table, row) {
  const cols = columnsOf(table).filter((c) => !['sys_class_name'].includes(c) && row[c] !== undefined);
  const body = cols.map((c) => `<${c}>${xmlEscape(row[c])}</${c}>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><record_update table="${table}"><${table} action="INSERT_OR_UPDATE">${body}</${table}></record_update>`;
}
function capture(setKey, table, key, { by = ME.userName, days = 1, hours = 0, action = 'INSERT_OR_UPDATE', application = '' } = {}) {
  const row = DB[table].find((r) => r.sys_id === id(table, key));
  const name = table === 'sys_dictionary' ? `sys_dictionary_${row.name}_${row.element}` : `${table}_${row.sys_id}`;
  const policy = row.ui_policy ? findRow('sys_ui_policy', row.ui_policy) : null;
  add('sys_update_xml', `${setKey}:${name}`, {
    name,
    type: SCHEMA[table].label,
    target_name: table === 'sys_dictionary' ? `${row.name}.${row.element}` : policy ? `${policy.short_description}: ${row.field}` : row.name || row.short_description || row.sys_id,
    action,
    application: application || row.sys_scope || 'global',
    update_set: id('sys_update_set', setKey),
    payload: payloadFor(table, row),
    category: 'customer',
    sys_created_by: by,
    sys_updated_by: by,
    sys_created_on: ago(days + 1, hours),
    sys_updated_on: ago(days, hours),
  });
}
capture('STRY0012', 'sys_script', 'sync group', { days: 0, hours: 2 });
capture('STRY0012', 'sys_script_client', 'P1 group', { days: 0, hours: 3 });
capture('STRY0012', 'sys_script_client', 'category', { days: 2 });
capture('STRY0012', 'sys_ui_policy', 'P1 group', { days: 0, hours: 3 });
capture('STRY0012', 'sys_ui_policy_action', 'P1 group:assignment_group', { days: 0, hours: 3 });
capture('STRY0012', 'sys_script_include', 'IncidentUtils', { days: 0, hours: 4 });
capture('STRY0012', 'sys_security_acl', 'incident priority write', { days: 0, hours: 5 });
capture('STRY0012', 'sys_dictionary', 'incident.u_phone', { days: 5 });
capture('STRY0015', 'sysauto_script', 'close stale', { days: 3, hours: 1 });
capture('STRY0015', 'sys_script', 'notify P1', { days: 3 });
capture('STRY0015', 'sys_script_include', 'IncidentUtils', { days: 3, hours: 2 });
capture('STRY0015', 'sys_script_include', 'LegacyHelper', { days: 4 });
capture('Default', 'sys_script_client', 'hide phone', { days: 1, hours: 6 });
capture('Default', 'sys_ui_action', 'escalate', { days: 1, hours: 2 });
capture('HR', 'sp_widget', 'hr card', { days: 6 });
capture('HR', 'sys_ws_operation', 'get orders', { days: 9 });
capture('HR', 'sys_script', 'default category', { by: 'beth.anglin', days: 12, application: 'global' });
capture('R2609', 'sys_ui_script', 'acme helpers', { by: 'beth.anglin', days: 40 });
capture('R2609', 'sys_script', 'notify P1', { days: 25, action: 'INSERT_OR_UPDATE' });

// --- recent changes by other people, and the versions behind them (What changed lately? / Release notes)
capture('HR', 'sys_ui_script', 'acme helpers', { by: 'beth.anglin', days: 0, hours: 1, application: id('sys_app', 'x_acme_hr') });
capture('STRY0015', 'sys_script', 'sync group', { by: 'fred.luddy', days: 0, hours: 0.4 });
capture('STRY0015', 'sys_security_acl', 'incident priority write', { by: 'fred.luddy', days: 0, hours: 0.2 });
capture('STRY0015', 'sys_script', 'default category', { by: 'beth.anglin', days: 2, hours: 3, action: 'DELETE', application: 'global' });
function version(setKey, table, key, stamps) {
  const row = DB[table].find((r) => r.sys_id === id(table, key));
  const name = `${table}_${row.sys_id}`;
  stamps.forEach(({ by, days, hours = 0, patch }, i) =>
    add('sys_update_version', `${name}:${i}`, {
      name,
      sys_recorded_at: ago(days, hours),
      sys_created_by: by,
      source: `sys_update_set:${id('sys_update_set', setKey)}`,
      state: 'current',
      action: 'INSERT_OR_UPDATE',
      payload: payloadFor(table, { ...row, ...patch }),
    })
  );
}
version('STRY0015', 'sys_script', 'sync group', [
  { by: ME.userName, days: 0, hours: 2, patch: { script: "(function executeRule(current, previous) {\n\tgs.info('sync group');\n})(current, previous);" } },
  { by: 'fred.luddy', days: 0, hours: 0.4 },
]);
version('HR', 'sys_ui_script', 'acme helpers', [
  { by: 'beth.anglin', days: 40, patch: { script: 'var AcmeHelpers = { tag: function () { return "old"; } };' } },
  { by: 'beth.anglin', days: 0, hours: 1 },
]);

/* ---------------------------------------------------------------- encoded queries */

const OPS = [
  'ISNOTEMPTY', 'ISEMPTY', 'ANYTHING', 'EMPTYSTRING', 'STARTSWITH', 'ENDSWITH', 'NOT LIKE', 'NOTLIKE', 'LIKE', 'NOT IN', 'NOTIN', 'INSTANCEOF', 'IN',
  'DYNAMIC', 'SAMEAS', 'NSAMEAS', 'VALCHANGES', 'CHANGESFROM', 'CHANGESTO', 'BETWEEN', 'DATEPART', 'RELATIVEGT', 'RELATIVELT', 'RELATIVEGE', 'RELATIVELE',
  'NOTON', 'ON', 'MORETHAN', 'LESSTHAN', '!=', '>=', '<=', '=', '>', '<',
];
const COND_RE = new RegExp(`^([A-Za-z0-9_.]+?)(${OPS.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})([\\s\\S]*)$`);

const state = {
  paused: false,
  waiting: [],
  failures: [],
  latencyMs: 60,
  log: [],
  unknownColumns: new Set(),
  currentSet: id('sys_update_set', 'STRY0012'),
  currentApp: 'global',
};

function warn(...args) {
  // eslint-disable-next-line no-console
  console.warn('[fake]', ...args);
}

function jsValue(text) {
  const js = text.replace(/^javascript:\s*/i, '').trim();
  let m;
  if (/^gs\.getUserID\(\)$/.test(js)) return ME.id;
  if (/^gs\.getUserName\(\)$/.test(js)) return ME.userName;
  if ((m = /^gs\.(?:daysAgoStart|daysAgo|daysAgoEnd)\((-?\d+)\)$/.exec(js))) return fmt(NOW - Number(m[1]) * 864e5).slice(0, 10) + (/End/.test(js) ? ' 23:59:59' : ' 00:00:00');
  if ((m = /^gs\.(minutes|hours)AgoStart\((\d+)\)$/.exec(js))) return fmt(NOW - Number(m[2]) * (m[1] === 'hours' ? 36e5 : 6e4));
  if ((m = /^gs\.(minutes|hours)Ago\((\d+)\)$/.exec(js))) return fmt(NOW - Number(m[2]) * (m[1] === 'hours' ? 36e5 : 6e4));
  if (/^gs\.beginningOfToday\(\)$/.test(js)) return `${fmt(NOW).slice(0, 10)} 00:00:00`;
  if ((m = /^gs\.secondsAgo\((\d+)\)$/.exec(js))) return fmt(Date.now() - Number(m[1]) * 1000);
  if (/^gs\.nowDateTime\(\)$/.test(js)) return fmt(NOW);
  warn('javascript value not understood, condition treated as true:', text);
  return null;
}

/** Value of a (possibly dot-walked) column: { known, value, display }. */
function resolvePath(table, row, path) {
  const parts = path.split('.');
  let t = table;
  let r = row;
  for (let i = 0; i < parts.length; i += 1) {
    const col = parts[i];
    const spec = columnSpec(t, col);
    if (!spec) return { known: false, value: '', display: '' };
    const raw = r ? String(r[col] ?? '') : '';
    const target = refTarget(spec.spec);
    if (i === parts.length - 1) {
      return { known: true, value: raw, display: target ? displayOf(target, raw) : raw };
    }
    if (!target) return { known: false, value: '', display: '' };
    t = target;
    r = raw ? findRow(target, raw) : null;
  }
  return { known: false, value: '', display: '' };
}

function displayOf(table, sysId) {
  if (!sysId) return '';
  const row = findRow(table, sysId);
  if (!row) return sysId;
  const col = DISPLAY_COLUMN[table] || ['name', 'number', 'short_description', 'title', 'label', 'user_name'].find((c) => columnSpec(table, c));
  if (!col) return sysId;
  const v = resolvePath(table, row, col);
  return v.display || v.value || sysId;
}

function rowsOf(table) {
  return descendants(table).flatMap((t) => DB[t]);
}
function findRow(table, sysId) {
  return rowsOf(table).find((r) => r.sys_id === sysId) || null;
}

function compare(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

function testCondition(table, row, cond) {
  const m = COND_RE.exec(cond);
  if (!m) {
    warn(`condition not understood on ${table}, treated as true:`, cond);
    return true;
  }
  const [, field, op, rawValue] = m;
  const { known, value } = resolvePath(table, row, field);
  if (!known) {
    const key = `${table}.${field}`;
    if (!state.unknownColumns.has(key)) {
      state.unknownColumns.add(key);
      warn(`unknown column "${field}" on ${table}: ServiceNow ignores this condition (matches every row)`);
    }
    return true;
  }
  let target = rawValue;
  if (/^javascript:/i.test(target)) {
    target = jsValue(target);
    if (target === null) return true;
  }
  const v = String(value);
  const lower = v.toLowerCase();
  const t = String(target);
  switch (op) {
    case '=': return v === t;
    case '!=': return v !== t;
    case 'IN': return t.split(',').includes(v);
    case 'NOT IN':
    case 'NOTIN': return !t.split(',').includes(v);
    case 'LIKE': return lower.includes(t.toLowerCase());
    case 'NOT LIKE':
    case 'NOTLIKE': return !lower.includes(t.toLowerCase());
    case 'STARTSWITH': return lower.startsWith(t.toLowerCase());
    case 'ENDSWITH': return lower.endsWith(t.toLowerCase());
    case 'ISEMPTY': return v === '';
    case 'ISNOTEMPTY': return v !== '';
    case 'ANYTHING': return true;
    case 'EMPTYSTRING': return v === '';
    case '>': return compare(v, t) > 0;
    case '>=': return compare(v, t) >= 0;
    case '<': return compare(v, t) < 0;
    case '<=': return compare(v, t) <= 0;
    default:
      warn(`operator ${op} not emulated, treated as true:`, cond);
      return true;
  }
}

/** Parse one encoded query (no ^NQ): { groups: [[cond, ...or], ...and], order: [{field, desc}] }. */
function parseQuery(query) {
  const groups = [];
  const order = [];
  String(query || '')
    .split('^')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((token) => {
      if (token === 'EQ') return;
      if (token.startsWith('ORDERBYDESC')) order.push({ field: token.slice(11), desc: true });
      else if (token.startsWith('ORDERBY')) order.push({ field: token.slice(7), desc: false });
      else if (token.startsWith('GROUPBY')) return;
      else if (token.startsWith('OR') && groups.length && COND_RE.test(token.slice(2))) groups[groups.length - 1].push(token.slice(2));
      else groups.push([token.replace(/^GOTO/, '')]);
    });
  return { groups, order };
}

function select(table, query) {
  const parts = String(query || '').split('^NQ');
  const parsed = parts.map(parseQuery);
  const order = parsed.flatMap((p) => p.order);
  let rows = rowsOf(table).filter((row) => parsed.some((p) => p.groups.every((g) => g.some((c) => testCondition(table, row, c)))));
  if (order.length) {
    rows = [...rows].sort((a, b) => {
      for (const o of order) {
        const c = compare(resolvePath(table, a, o.field).value, resolvePath(table, b, o.field).value);
        if (c) return o.desc ? -c : c;
      }
      return 0;
    });
  }
  return rows;
}

function project(table, row, fields, displayMode) {
  const wanted = fields.length ? fields : columnsOf(table);
  const out = {};
  wanted.forEach((f) => {
    const r = resolvePath(table, row, f);
    if (!r.known) return; // the Table API leaves unknown columns out
    if (displayMode === 'all') out[f] = { display_value: r.display, value: r.value };
    else if (displayMode === 'true') out[f] = r.display;
    else out[f] = r.value;
  });
  return out;
}

/* ---------------------------------------------------------------- endpoints */

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const errorJson = (status, message, detail = null) => json(status, { error: { message, detail }, status: 'failure' });

function tableEndpoint(method, table, recordId, params, body) {
  if (!SCHEMA[table]) {
    warn(`no table "${table}" in the fixtures (answered 400 Invalid table)`);
    return errorJson(400, `Invalid table ${table}`);
  }
  const fields = (params.get('sysparm_fields') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const displayMode = params.get('sysparm_display_value') || 'false';
  if (method === 'GET') {
    if (recordId) {
      const row = findRow(table, recordId);
      return row ? json(200, { result: project(table, row, fields, displayMode) }) : errorJson(404, 'No Record found', 'Record doesn\'t exist or ACL restricts the record retrieval');
    }
    const rows = select(table, params.get('sysparm_query') || '');
    const offset = Number(params.get('sysparm_offset') || 0);
    const limit = Number(params.get('sysparm_limit') || 10000);
    return json(200, { result: rows.slice(offset, offset + limit).map((r) => project(table, r, fields, displayMode)) });
  }
  if (method === 'PATCH' || method === 'PUT') {
    const row = findRow(table, recordId);
    if (!row) return errorJson(404, 'No Record found');
    Object.entries(body || {}).forEach(([k, val]) => {
      if (columnSpec(table, k)) row[k] = String(val);
    });
    row.sys_updated_on = fmt(Date.now());
    row.sys_updated_by = ME.userName;
    row.sys_mod_count = String(Number(row.sys_mod_count || 0) + 1);
    return json(200, { result: project(table, row, [], 'false') });
  }
  if (method === 'POST') {
    const row = add(table, `new:${Math.random()}`, { ...(body || {}), ...custom(ME.userName, 0, 0) });
    return json(201, { result: project(table, row, [], 'false') });
  }
  if (method === 'DELETE') {
    const list = DB[table];
    const at = list.findIndex((r) => r.sys_id === recordId);
    if (at < 0) return errorJson(404, 'No Record found');
    list.splice(at, 1);
    return new Response(null, { status: 204 });
  }
  return errorJson(405, 'Method not allowed');
}

function statsEndpoint(table, params) {
  if (!SCHEMA[table]) return errorJson(400, `Invalid table ${table}`);
  const rows = select(table, params.get('sysparm_query') || '');
  const groupBy = params.get('sysparm_group_by');
  const maxFields = (params.get('sysparm_max_fields') || '').split(',').filter(Boolean);
  const stats = (list) => {
    const s = { count: String(list.length) };
    if (maxFields.length) {
      s.max = Object.fromEntries(maxFields.map((f) => [f, list.map((r) => resolvePath(table, r, f).value).sort(compare).pop() || '']));
    }
    return s;
  };
  if (!groupBy) return json(200, { result: { stats: stats(rows) } });
  const groups = new Map();
  const shown = new Map();
  rows.forEach((r) => {
    const resolved = resolvePath(table, r, groupBy);
    const key = resolved.value;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
    if (!shown.has(key)) shown.set(key, resolved.display);
  });
  // sysparm_display_value=all adds the display value next to each group's value (Break this list down uses it).
  return json(200, { result: [...groups.entries()].map(([value, list]) => ({ stats: stats(list), groupby_fields: [{ field: groupBy, value, ...(params.get('sysparm_display_value') === 'all' ? { display_value: shown.get(value) ?? value } : {}) }] })) });
}

function pickerEndpoint(method, kind, body) {
  if (method === 'PUT') {
    if (kind === 'updateset' && body?.sysparm_sys_id) state.currentSet = body.sysparm_sys_id;
    if (kind === 'application' && body?.app_id) state.currentApp = body.app_id;
    return json(200, { result: { status: 'ok' } });
  }
  if (kind === 'updateset') {
    const set = findRow('sys_update_set', state.currentSet);
    return json(200, { result: { current: { sysId: state.currentSet, name: set?.name || '' }, list: [] } });
  }
  const app = state.currentApp === 'global' ? { name: 'Global' } : findRow('sys_scope', state.currentApp);
  return json(200, { result: { current: { sysId: state.currentApp, name: app?.name || '' }, list: [] } });
}

function scriptsEndpoint(body) {
  const script = new URLSearchParams(body || '').get('script') || '';
  const lines = [];
  if (script.includes('NowBuddy access check')) {
    const m = /var table = ("[^"]*"), id = ("[^"]*"), field = ("[^"]*")/.exec(script);
    const [table, recordId, field] = m ? [JSON.parse(m[1]), JSON.parse(m[2]), JSON.parse(m[3])] : ['', '', ''];
    const out = { user: ME.userName, userId: ME.id, table, id: recordId, field, canCreate: true, found: Boolean(recordId) || undefined, canRead: true, canWrite: true, canDelete: false };
    if (field) Object.assign(out, { fieldCanRead: true, fieldCanWrite: field !== 'number', fieldCanCreate: true });
    lines.push(`MSB_ACCESS_RESULT ${JSON.stringify(out)}`);
  } else {
    lines.push('[dry run] done');
  }
  const html = `<HTML><BODY>[0:00:00.014] Script completed in scope global: script<HR/><PRE>${lines.map((l) => `*** Script: ${xmlEscape(l)}`).join('<BR/>')}<BR/></PRE><HR/></BODY></HTML>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
}

function route(method, url, body) {
  const u = new URL(url, location.href);
  const p = u.pathname;
  let m;
  // Save trace windows (gs.secondsAgo) are answered by the rows addSaveTraceRows() adds, not by the Hot spots fixture.
  const hot = /gs\.secondsAgo\(/.test(decodeURIComponent(u.search)) ? null : hotspotsFixture(method, u); // Hot spots tables (preview/hotspotsFixture.js); null for anything else
  if (hot) return hot;
  if ((m = /^\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/.exec(p))) return tableEndpoint(method, decodeURIComponent(m[1]), m[2] ? decodeURIComponent(m[2]) : '', u.searchParams, body ? JSON.parse(body) : null);
  if ((m = /^\/api\/now\/stats\/([^/]+)$/.exec(p))) return statsEndpoint(decodeURIComponent(m[1]), u.searchParams);
  if ((m = /^\/api\/now\/ui\/concoursepicker\/(updateset|application)$/.exec(p))) return pickerEndpoint(method, m[1], body ? JSON.parse(body) : null);
  if (p === '/sys.scripts.do' && method === 'POST') return scriptsEndpoint(body);
  if (p === '/stats.do') return new Response('<html><body>Build name: Xanadu<br/>Build date: 07-02-2024<br/>Build tag: glide-xanadu-07-02-2024__patch7<br/>Instance name: dev12345<br/></body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  return null;
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

// Failures for the What went wrong? panel: a few of each kind, some repeating, some that must be filtered out again.
{
  const mins = (n) => fmt(NOW - n * 60000);
  [
    ['a1', 12, 'abel.tuter@example.com', 'Incident INC0010001 resolved', '535 Authentication credentials invalid'],
    ['a2', 34, 'beth.anglin@example.com', 'Incident INC0010002 resolved', '535 Authentication credentials invalid'],
    ['a3', 55, 'carol.coughlin@example.com', 'Incident INC0010003 resolved', '535 Authentication credentials invalid'],
  ].forEach(([key, m, to, subject, error]) => add('sys_email', key, { type: 'send-failed', state: 'send-failed', recipients: to, subject, error_string: error, target_table: 'incident', sys_created_on: mins(m) }));
  add('sys_email', 'ignored', { type: 'send-ignored', state: 'ignored', recipients: 'dave@example.com', subject: 'Welcome to the team', sys_created_on: mins(70) });
  add('sys_email', 'nobody', { type: 'send-failed', recipients: '', subject: 'Approval request', error_string: '', sys_created_on: mins(90) });
  add('sys_email', 'fine', { type: 'sent', state: 'sent', recipients: 'ok@example.com', subject: 'Sent fine', sys_created_on: mins(20) });
  add('sys_flow_context', 'f1', { name: 'Onboard new hire', flow: 'Onboard new hire', state: 'ERROR', error_message: 'Value for data pill Trigger.Record.manager is null', source_table: 'sn_hr_core_case', sys_created_on: mins(25) });
  add('sys_flow_context', 'f2', { name: 'Onboard new hire', flow: 'Onboard new hire', state: 'ERROR', error_message: 'Value for data pill Trigger.Record.manager is null', source_table: 'sn_hr_core_case', sys_created_on: mins(300) });
  add('sys_flow_context', 'f3', { name: 'Close stale incidents', flow: 'Close stale incidents', state: 'CANCELLED', error_message: '', sys_created_on: mins(180) });
  add('sys_flow_context', 'f4', { name: 'Fine flow', flow: 'Fine flow', state: 'COMPLETE', sys_created_on: mins(10) });
  add('sys_trigger', 't1', { name: 'Nightly CMDB reconcile', state: '0', next_action: mins(95), trigger_type: '0' });
  add('sys_trigger', 't2', { name: 'Hourly cleanup (on time)', state: '0', next_action: fmt(NOW + 20 * 60000), trigger_type: '0' });
  add('ecc_queue', 'e1', { topic: 'Discovery', name: 'Windows - Classify', queue: 'output', agent: 'mid-eu-01', state: 'error', error_string: 'Unknown host cmdb-scan01.corp.example', sys_created_on: mins(40) });
  add('ecc_queue', 'e2', { topic: 'Discovery', name: 'Windows - Classify', queue: 'output', agent: 'mid-eu-01', state: 'error', error_string: 'Unknown host cmdb-scan02.corp.example', sys_created_on: mins(42) });
  add('ecc_queue', 'e3', { topic: 'Discovery', state: 'processed', sys_created_on: mins(30) });
  [
    ['o1', 15, '401'],
    ['o2', 45, '401'],
    ['o3', 100, '401'],
    ['o4', 50, '500'],
    ['o5', 5, '200'],
  ].forEach(([key, m, code]) => add('sys_outbound_http_log', key, { url: 'https://api.partner.example/v2/orders?apikey=TOPSECRET', http_method: 'POST', response_code: code, sys_created_on: mins(m) }));
  add('syslog_transaction', 'i1', { url: '/api/x_acme/orders/create', http_method: 'POST', response_status: '500', response_time: '812', sys_created_by: 'svc.integration', sys_created_on: mins(33) });
  add('syslog_transaction', 'i2', { url: '/api/x_acme/orders/create', http_method: 'POST', response_status: '500', response_time: '790', sys_created_by: 'svc.integration', sys_created_on: mins(61) });
  add('syslog_transaction', 'i3', { url: '/api/now/table/incident', http_method: 'GET', response_status: '200', response_time: '90', sys_created_on: mins(8) });
  [10, 20, 30, 40].forEach((m, i) => add('sys_import_set_row', `r${i}`, { sys_import_set: 'ISET0010022', sys_import_state: 'error', sys_row_error: `Mandatory field caller_id is empty (row ${i + 1})`, sys_target_table: 'incident', sys_created_on: mins(m) }));
  add('sys_import_set_row', 'r9', { sys_import_set: 'ISET0010022', sys_import_state: 'inserted', sys_created_on: mins(11) });
  add('sys_import_set_run', 'run1', { sys_import_set: 'ISET0010022', state: 'error', error_message: 'Script exception in onBefore', transform_map: 'Users to sys_user', sys_created_on: mins(50) });
  [8, 18, 28, 38, 48].forEach((m, i) => add('sysevent', `ev${i}`, { name: 'incident.assigned', state: 'error', table: 'incident', queue: 'default', sys_created_on: mins(m) }));
}

export function installFakeInstance() {
  // ?hold=1 starts with every request held (loading states on first paint); __fake.resume() releases them.
  if (new URLSearchParams(location.search).get('hold') === '1') state.paused = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const absolute = new URL(url, location.href);
    if (absolute.origin !== location.origin || /\.(js|css|map|html)$/.test(absolute.pathname)) return realFetch(input, init);
    const signal = init.signal;
    if (signal?.aborted) throw abortError();

    await new Promise((resolve, reject) => {
      const go = () => setTimeout(resolve, state.latencyMs);
      if (state.paused) state.waiting.push(go);
      else go();
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });

    const failure = state.failures.find((f) => new RegExp(f.pattern).test(absolute.pathname + absolute.search));
    let response;
    if (failure) {
      response = failure.status === 401 ? new Response('', { status: 401 }) : errorJson(failure.status, failure.message || 'Simulated failure', failure.detail || null);
    } else {
      try {
        response = route(method, url, typeof init.body === 'string' ? init.body : init.body ? String(init.body) : '');
      } catch (err) {
        warn('fixture error', method, url, err);
        response = errorJson(500, `Fixture error: ${err.message}`);
      }
      if (!response) {
        warn('unmatched', method, url);
        response = errorJson(404, 'Not found (preview fake instance)');
      }
    }
    state.log.push({ method, url: absolute.pathname + absolute.search, status: response.status });
    return response;
  };

  installBridge();

  window.__fake = {
    pause() {
      state.paused = true;
    },
    resume() {
      state.paused = false;
      state.waiting.splice(0).forEach((go) => go());
    },
    fail(pattern, status = 500, message = '', detail = '') {
      state.failures.push({ pattern, status, message, detail });
    },
    addSaveTraceRows() {
      seedSaveTrace();
    },
    clearFail() {
      state.failures = [];
    },
    latency(ms) {
      state.latencyMs = ms;
    },
    get log() {
      return state.log;
    },
    get unknownColumns() {
      return [...state.unknownColumns];
    },
    me: ME,
    sid,
    db: DB,
  };
}

/* ---------------------------------------------------------------- page bridge and markup */

export const SESSION_TOKEN = 'a3f9c2e17b4d4c0e9f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708';

// What g_form reports for the open incident (live state differs from the dictionary on purpose).
const FORM_FIELDS = [
  ['number', 'Number', 'string', { readOnly: true }],
  ['caller_id', 'Caller', 'reference', { mandatory: true }],
  ['category', 'Category', 'choice'],
  ['subcategory', 'Subcategory', 'choice'],
  ['priority', 'Priority', 'integer', { readOnly: true }],
  ['state', 'State', 'integer'],
  ['assignment_group', 'Assignment group', 'reference', { mandatory: true }],
  ['assigned_to', 'Assigned to', 'reference'],
  ['short_description', 'Short description', 'string', { mandatory: true }],
  ['description', 'Description', 'string'],
  ['u_phone', 'Contact phone', 'phone_number_e164'],
  ['close_code', 'Resolution code', 'choice', { visible: false }],
];

function formModel() {
  const row = findRow('incident', INCIDENT_ID);
  return {
    table: 'incident',
    sysId: INCIDENT_ID,
    isNewRecord: false,
    fieldCount: FORM_FIELDS.length,
    fields: FORM_FIELDS.map(([name, label, type, flags = {}]) => ({
      name,
      label,
      type,
      value: String(row[name] ?? ''),
      display: columnSpec('incident', name) && refTarget(columnSpec('incident', name).spec) ? displayOf(refTarget(columnSpec('incident', name).spec), row[name]) : undefined,
      mandatory: Boolean(flags.mandatory),
      readOnly: Boolean(flags.readOnly),
      visible: flags.visible !== false,
    })),
    user: { userName: ME.userName, roles: 'admin,itil,snc_internal' },
  };
}

function installBridge() {
  document.documentElement.setAttribute('data-msb-bridge', '1');
  const page = new URLSearchParams(location.search).get('page') || 'form';
  const actions = {
    getCsrfToken: () => SESSION_TOKEN,
    getUserInfo: () => ({ userName: ME.userName, firstName: ME.first, lastName: ME.last, userId: ME.id, roles: ['admin', 'itil', 'snc_internal'] }),
    getFormMeta: () => (page === 'si' ? { table: 'sys_script_include', sysId: sid('sys_script_include:IncidentUtils'), isNewRecord: false } : page === 'script' ? { table: 'sys_script', sysId: INCIDENT_ID, isNewRecord: false } : page === 'form' ? { table: 'incident', sysId: INCIDENT_ID, isNewRecord: false } : null),
    getFormModel: () => (page === 'form' ? formModel() : null),
    getFormValues: () => (page === 'si' ? { values: { name: document.getElementById('sys_script_include.name').value, script: document.getElementById('sys_script_include.script').value }, labels: {} } : page === 'form' ? { values: Object.fromEntries(formModel().fields.map((f) => [f.name, f.value])), labels: {} } : null),
    getFieldState: (name) => {
      if (page === 'script' || page === 'si') {
        const el = document.getElementById(`${page === 'si' ? 'sys_script_include' : 'sys_script'}.${name}`);
        return el ? { name, value: el.value, label: name, mandatory: false, readOnly: false, visible: true } : null;
      }
      const f = page === 'form' ? formModel().fields.find((x) => x.name === name) : null;
      return f ? { name, value: f.value, label: f.label, mandatory: f.mandatory, readOnly: f.readOnly, visible: f.visible } : null;
    },
    getScriptFields: () => (page === 'script' || page === 'si' ? [{ name: 'script', label: 'Script', length: document.getElementById(`${page === 'si' ? 'sys_script_include' : 'sys_script'}.script`)?.value.length || 0 }] : []),
    saveForm: () => {
      document.body.dataset.saved = String(Number(document.body.dataset.saved || 0) + 1);
      return true;
    },
    // ?page=script: the in-place editor writes into the fake textarea, exactly like g_form.setValue would.
    setFieldValue: (name, value) => {
      const el = document.getElementById(`${page === 'si' ? 'sys_script_include' : 'sys_script'}.${name}`);
      if (!el) throw new Error(`Field "${name}" is not on this form.`);
      const previous = el.value;
      el.value = value;
      return { previous };
    },
    getListInfo: () => (page === 'list' ? { table: 'incident', query: 'active=true^priority<=2^ORDERBYDESCsys_updated_on' } : null),
    getSessionInfo: () => ({ userName: ME.userName, userId: ME.id }),
    getFormStatus: () => (page === 'form' ? { dirty: false, changed: [], sections: ['Details', 'Resolution'] } : null),
  };
  document.addEventListener('msb-page-request', (event) => {
    const { id: requestId, action, args = [] } = event.detail || {};
    setTimeout(() => {
      let detail;
      if (!actions[action]) {
        warn('unmatched page bridge action', action);
        detail = { id: requestId, ok: false, error: `Unknown bridge action: ${action}` };
      } else {
        try {
          detail = { id: requestId, ok: true, result: actions[action](...args) };
        } catch (err) {
          detail = { id: requestId, ok: false, error: err.message };
        }
      }
      document.dispatchEvent(new CustomEvent('msb-page-response', { detail }));
    }, 5);
  });
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A classic ServiceNow form (or list) in the page, so Page X-ray has DOM to read. */
export function renderFakePage(root) {
  const page = new URLSearchParams(location.search).get('page') || 'form';
  const tokenInput = `<input type="hidden" name="sysparm_ck" value="${SESSION_TOKEN}">`;
  if (page === 'script') {
    root.innerHTML = `${tokenInput}<div class="bar">ServiceNow &nbsp;·&nbsp; Business Rule</div><h1>Set priority from impact</h1>
<div class="row" id="element.sys_script.name"><label id="label.sys_script.name" for="sys_script.name"><span class="label-text">Name</span></label><input id="sys_script.name" value="Set priority from impact"></div>
<div class="row" id="element.sys_script.script"><label id="label.sys_script.script" for="sys_script.script"><span class="label-text">Script</span></label><textarea id="sys_script.script" rows="7" style="font:12px monospace;padding:6px;border:1px solid #cfd3d8;border-radius:4px"></textarea></div>
<div class="row" id="element.sys_script.description"><label id="label.sys_script.description" for="sys_script.description"><span class="label-text">Description</span></label><input id="sys_script.description" value="Below the script field"></div>`;
    document.getElementById('sys_script.script').value = `(function executeRule(current, previous /*null when async*/) {
  var gr = new GlideRecord('incident');
  gr.addQuery('active', true);
  gr.query();
  while (gr.next()) {
    gs.info(gr.number);
  }
})(current, previous);
`;
    return;
  }
  if (page === 'si') {
    root.innerHTML = `${tokenInput}<div class="bar">ServiceNow &nbsp;·&nbsp; Script Include</div><h1>IncidentUtils</h1>
<div class="row" id="element.sys_script_include.name"><label id="label.sys_script_include.name" for="sys_script_include.name"><span class="label-text">Name</span></label><input id="sys_script_include.name" value="IncidentUtils"></div>
<div class="row" id="element.sys_script_include.script"><label id="label.sys_script_include.script" for="sys_script_include.script"><span class="label-text">Script</span></label><textarea id="sys_script_include.script" rows="10" style="font:12px monospace;padding:6px"></textarea></div>
<button type="button" id="sysverb_update" onclick="document.body.dataset.saved=String(Number(document.body.dataset.saved||0)+1)">Update</button>`;
    document.getElementById('sys_script_include.script').value = SI_UTILS;
    return;
  }
  if (page === 'blank') {
    root.innerHTML = `${tokenInput}<div class="bar">ServiceNow &nbsp;·&nbsp; Home</div><h1>Welcome</h1><p>A page with no form or list.</p>`;
    return;
  }
  if (page === 'list') {
    const rows = select('incident', 'active=true^ORDERBYDESCsys_updated_on');
    const cols = [['number', 'Number'], ['short_description', 'Short description'], ['caller_id', 'Caller'], ['priority', 'Priority'], ['state', 'State'], ['assignment_group', 'Assignment group'], ['assigned_to.name', 'Assigned to']];
    root.innerHTML = `${tokenInput}<div class="bar">ServiceNow &nbsp;·&nbsp; Incidents</div><h1>Incidents</h1>
<input type="hidden" name="sysparm_query" value="active=true^priority&lt;=2^ORDERBYDESCsys_updated_on">
<table class="list_table" glide_table="incident"><thead><tr class="list_header"><th class="list_decoration_cell"></th>${cols.map(([n, l]) => `<th class="list_header_cell" name="${n}" glide_type="string">${l}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr class="list_row" id="row_incident_${r.sys_id}" sys_id="${r.sys_id}"><td class="list_decoration_cell"><input type="checkbox" class="list_checkbox" id="check_${r.sys_id}" aria-label="Select ${esc(r.number || 'row')}"></td>${cols.map(([n]) => `<td>${esc(resolvePath('incident', r, n).display)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    return;
  }
  const model = formModel();
  root.innerHTML = `${tokenInput}<input type="hidden" name="sys_uniqueValue" value="${INCIDENT_ID}"><input type="hidden" name="sys_target" value="incident">
<div class="bar">ServiceNow &nbsp;·&nbsp; Incident INC0010042</div><h1>Laptop will not boot</h1>
${model.fields
  .map((f) => {
    const key = `incident.${f.name}`;
    const hidden = f.visible ? '' : ' style="display:none"';
    const value = f.display ?? f.value;
    return `<div class="row" id="element.${key}"${hidden}><label id="label.${key}" for="${key}"><span class="label-text">${esc(f.label)}</span>${f.mandatory ? '<span class="req" aria-label="Mandatory"></span>' : ''}</label>
<span id="status.${key}" mandatory="${f.mandatory}"></span><input id="${key}" name="${key}" value="${esc(value)}"${f.readOnly ? ' readonly' : ''}></div>`;
  })
  .join('')}`;
}
