// What the tools that were already in NowBuddy before the 2026-10-23 batch need from the instance, for the Self-check
// panel (src/lib/requirements/index.js has the shape).
//
// How this list was made: by reading each tool's queryTable / countRecords / queryInChunks calls on 2026-10-23, not
// by asking an instance. Names that PROGRESS.md "Live calibration" corrected on the PDI are used in their corrected
// form (sys_metadata.sys_name, sys_script_client.field, sys_transform_script.map, sys_ui_policy.short_description,
// syslog_transaction.sys_created_by). Everything else is as the code reads it; the Self-check run on a real instance
// is how the rest gets confirmed. docs/features/doctor.md lists what is still unverified.
//
// Reading the entries:
//   optional: true      the tool still works without this table: a section, a source or a hint is left out
//   optionalColumns     columns of a required table that the code tolerates missing
//   dotted columns      ('update_set.name', 'operation.name') only the first part is checked, on the table itself
//   conditions          a column that appears in a query condition is listed even when it is not displayed: ServiceNow
//                       ignores a condition on a column that does not exist and then matches every row
//
// tests/doctor.test.js keeps the lists that live in code (failures SOURCES, code search tables, health scan tables,
// save trace sources) and this file in step.

const entry = (feature, table, columns, extra = {}) => ({ feature, table, columns, ...extra });

// ---- What went wrong? (src/lib/failures.js SOURCES; every source is left out with a note when unreadable) -----------

const FAILURES = 'What went wrong?';
const failures = [
  entry(FAILURES, 'sys_email', ['type', 'state', 'recipients', 'subject', 'error_string', 'target_table'], { optional: true, note: 'Email source: failed or ignored outbound mail.' }),
  entry(FAILURES, 'sys_flow_context', ['name', 'flow', 'state', 'error_message', 'source_table', 'source_record'], { optional: true, note: 'Flow source: executions that errored or were cancelled.' }),
  entry(FAILURES, 'sys_hub_flow', ['name'], { optional: true, note: 'Names flows whose execution row has none (the flow column is only a sys_id).' }),
  entry(FAILURES, 'sys_hub_flow_run', ['name', 'flow', 'state', 'error_message'], { optional: true, fallbackFor: 'sys_flow_context', note: 'Only read when sys_flow_context cannot be.' }),
  entry(FAILURES, 'sys_trigger', ['name', 'state', 'next_action', 'trigger_type'], { optional: true, note: 'Jobs source: scheduled jobs that are overdue.' }),
  entry(FAILURES, 'sysauto_script', ['name', 'run_type', 'run_start', 'active'], { optional: true, fallbackFor: 'sys_trigger', alternates: ['next_action'], note: 'Only read when sys_trigger cannot be. (No next_action column on current releases: the next run is on sys_trigger.)' }),
  entry(FAILURES, 'ecc_queue', ['topic', 'name', 'queue', 'agent', 'state', 'error_string'], { optional: true, note: 'Integrations source: MID Server messages in error.' }),
  entry(FAILURES, 'sys_outbound_http_log', ['url', 'method', 'response_status'], { optional: true, alternates: ['endpoint', 'name', 'http_method', 'response_code', 'http_status', 'status', 'status_code', 'error_message', 'error', 'message'], note: 'Column names differ by release; the code reads whichever alternates exist (on Australia only url, method and response_status exist, and the log has no error text).' }),
  entry(FAILURES, 'syslog_transaction', ['url', 'http_response_code'], { optional: true, note: 'Inbound API calls that returned 5xx.' }),
  entry(FAILURES, 'sys_import_set_row', ['sys_import_set', 'sys_import_state', 'sys_row_error', 'sys_class_name', 'sys_target_table'], { optional: true, note: 'Imports source: rows in error.' }),
  entry(FAILURES, 'sys_import_set_run', ['set', 'state', 'errors', 'sys_transform_map'], { optional: true, note: 'Imports source: runs in error.' }),
  entry(FAILURES, 'sysevent', ['name', 'state', 'table', 'instance', 'queue'], { optional: true, note: 'Events source: events that stopped in error. instance (the record the event was queued for) only feeds the Check the email button.' }),
];

// ---- Hot spots ---------------------------------------------------------------------------------------------------

const HOT = 'Hot spots';
const hotSpots = [
  entry(HOT, 'syslog_transaction', ['url', 'response_time'], { optional: true, optionalColumns: ['sql_time', 'sql_count', 'business_rule_time', 'business_rule_count', 'total_wait_time', 'session', 'type'], alternates: ['user_name', 'user'], note: 'Slowest requests, users, jobs, SQL and rule time. The timing columns differ by release; a missing one is reported in the panel. The user is read from user_name, user or sys_created_by, whichever the release has. Optional: each section loads on its own, and the log, event and audit sections work without this table.' }),
  entry(HOT, 'syslog', ['message', 'source', 'level'], { optional: true, note: 'Log messages, errors and log sources sections.' }),
  entry(HOT, 'sys_trigger', ['name', 'state', 'next_action', 'claimed_by'], { optional: true, note: 'Running jobs section.' }),
  entry(HOT, 'sysevent', ['name'], { optional: true, note: 'Events section.' }),
  entry(HOT, 'sys_outbound_http_log', ['url', 'method', 'response_time'], { optional: true, note: 'Outbound calls section; outbound logging may be off. The code also reads endpoint, response_code, http_status, status and elapsed when they exist: they are other releases\' names for the same facts, so they are not listed (one of them is always missing).' }),
  entry(HOT, 'sys_audit', ['tablename', 'documentkey'], { optional: true, note: 'Most-changed records and tables written (audited tables only).' }),
];

// ---- What changed lately? / Release notes / Ship check / My work ----------------------------------------------------

const updateSetEntry = (feature) => entry(feature, 'sys_update_set', ['name', 'state', 'application', 'is_default', 'description'], { note: 'The update set being reviewed or listed.' });
const updateXml = (feature, extra = {}) =>
  entry(feature, 'sys_update_xml', ['name', 'type', 'target_name', 'action', 'update_set', 'update_set.name', 'update_set.state', 'application', 'application.name', 'sys_updated_on', 'sys_updated_by', 'sys_created_by'], extra);

const RECENT = 'What changed lately?';
const recent = [
  entry(RECENT, 'sys_update_xml', ['name', 'type', 'target_name', 'action', 'update_set', 'update_set.name', 'application', 'application.name', 'sys_updated_on', 'sys_updated_by', 'sys_created_by'], { note: 'The change feed: one row per customer update.' }),
  entry(RECENT, 'sys_update_version', ['name', 'sys_recorded_at', 'source', 'state', 'payload', 'action'], { optional: true, note: 'Who saved a record last and the version to compare with (payload and action are read by the compare).' }),
];

const SHIP = 'Ship check';
const shipCheck = [
  updateSetEntry(SHIP),
  updateXml(SHIP, { note: 'The entries of the update set and the same entries in other open sets (collisions).' }),
  entry(SHIP, 'sys_script_include', ['name'], { optional: true, note: 'Script Include calls found in the set (dependency check).' }),
  entry(SHIP, 'sys_dictionary', ['name', 'element'], { optional: true, note: 'Columns of tables changed in the set.' }),
  entry(SHIP, 'sys_update_xml', ['payload'], { optional: true, note: 'Script findings in the set are read from the update payloads.' }),
];

const NOTES = 'Release notes';
const releaseNotes = [
  updateSetEntry(NOTES),
  updateXml(NOTES, { note: 'Same loader as the Ship check.' }),
  entry(NOTES, 'sys_update_xml', ['payload'], { optional: true, note: 'Script findings in the set are read from the update payloads.' }),
  entry(NOTES, 'sys_script_include', ['name'], { optional: true, note: 'Script Include calls found in the set (the Ship check loader it shares).' }),
  entry(NOTES, 'sys_dictionary', ['name', 'element'], { optional: true, note: 'Columns of tables changed in the set (the Ship check loader it shares).' }),
];

const MYWORK = 'My work';
const myWork = [
  entry(MYWORK, 'sys_update_set', ['name', 'state', 'application', 'is_default', 'description'], { note: 'Your update set and the open sets.' }),
  entry(MYWORK, 'sys_update_xml', ['name', 'type', 'target_name', 'action', 'update_set', 'application', 'sys_updated_on', 'sys_updated_by', 'sys_created_by'], { note: 'Your recent changes and the uncaptured-change check.' }),
  entry(MYWORK, 'sys_user', ['user_name'], { optional: true, note: 'Who you are: read only when the page cannot say (myWork.js currentUser asks the page first).' }),
  entry(MYWORK, 'sys_user_preference', ['name', 'value', 'user'], { optional: true, note: 'Fallback for the current update set and application when the pickers do not answer.' }),
  entry(MYWORK, 'sys_scope', ['name', 'scope'], { optional: true, note: 'Names the current application.' }),
  entry(MYWORK, 'sys_app', ['name', 'scope', 'active'], { optional: true, note: 'Fallback list of applications.' }),
];

// ---- Save trace (src/lib/saveTrace.js traceSources; each source is left out with a note) -----------------------------

const TRACE = 'Save trace';
const saveTrace = [
  entry(TRACE, 'sys_audit', ['fieldname', 'oldvalue', 'newvalue', 'user', 'tablename', 'documentkey'], { optional: true, note: 'Field changes (audited tables only).' }),
  entry(TRACE, 'sys_audit_delete', ['tablename', 'documentkey', 'display_value'], { optional: true, alternates: ['user'], note: 'Deletions.' }),
  entry(TRACE, 'syslog', ['level', 'source', 'message', 'sys_created_by'], { optional: true, note: 'Your log lines in the window, and errors others logged about the record.' }),
  entry(TRACE, 'syslog_transaction', ['url', 'response_time', 'sql_time', 'sql_count', 'business_rule_time', 'business_rule_count'], { alternates: ['http_method', 'status'], optional: true, note: 'Transactions in the window.' }),
  entry(TRACE, 'sys_update_xml', ['name', 'type', 'target_name', 'action', 'update_set', 'application'], { optional: true, note: 'Update set entries written in the window.' }),
  entry(TRACE, 'sysevent', ['name', 'parm1', 'parm2', 'state', 'table', 'instance'], { optional: true, note: 'Events queued.' }),
  entry(TRACE, 'sys_email', ['type', 'state', 'subject', 'recipients', 'error_string', 'instance'], { optional: true, note: 'Emails.' }),
  entry(TRACE, 'sys_flow_context', ['name', 'state', 'source_table', 'source_record', 'error_message'], { optional: true, alternates: ['started', 'ended'], note: 'Flows. (No started/ended columns on Australia: created and updated times are used.)' }),
  entry(TRACE, 'wf_context', ['name', 'state', 'table', 'id', 'started', 'ended'], { optional: true, note: 'Legacy workflows.' }),
  entry(TRACE, 'sys_journal_field', ['element', 'value', 'sys_created_by', 'element_id'], { optional: true, note: 'Work notes and comments.' }),
  entry(TRACE, 'task_sla', ['sla', 'stage', 'has_breached', 'task'], { optional: true, note: 'SLAs (task records only).' }),
  entry(TRACE, 'sysapproval_approver', ['approver', 'state', 'comments', 'sysapproval'], { optional: true, note: 'Approvals (task records only).' }),
  entry(TRACE, 'sys_attachment', ['file_name', 'size_bytes', 'content_type', 'table_sys_id'], { optional: true, note: 'Attachments.' }),
  entry(TRACE, 'task', ['number', 'short_description', 'sys_class_name', 'parent'], { optional: true, note: 'Child tasks created (task records only).' }),
];

// ---- Why didn't my rule run? (src/content/ruleExplain.js SOURCES; a type that cannot be read becomes a note) ----------

const RULE = "Why didn't my rule run?";
const whyRule = [
  entry(RULE, 'sys_script', ['name', 'collection', 'when', 'order', 'active', 'action_insert', 'action_update', 'action_delete', 'action_query', 'filter_condition', 'condition'], { optionalColumns: ['advanced', 'role_conditions'], optional: true, note: 'Business rules. collection is in the query condition.' }),
  entry(RULE, 'sys_script_client', ['name', 'table', 'type', 'field', 'active', 'ui_type'], { optionalColumns: ['applies_extended'], optional: true, note: 'Client scripts. table is in the query condition.' }),
  entry(RULE, 'sys_ui_policy', ['short_description', 'table', 'conditions', 'active', 'on_load', 'reverse_if_false', 'inherit', 'run_scripts', 'order'], { optionalColumns: ['view'], optional: true, note: 'UI policies. table is in the query condition.' }),
  entry(RULE, 'sys_data_policy2', ['short_description', 'model_table', 'conditions', 'active', 'enforce_ui', 'reverse_if_false', 'inherit'], { optional: true, note: 'Data policies. model_table is in the query condition.' }),
  entry(RULE, 'sys_security_acl', ['name', 'operation', 'active', 'condition', 'advanced', 'script', 'admin_overrides'], { optional: true, note: 'ACLs. name and operation are in the query condition.' }),
  entry(RULE, 'sys_user_role', ['name'], { optional: true, note: 'Role names behind business rule role conditions.' }),
  entry(RULE, 'sys_security_acl_role', ['sys_security_acl', 'sys_user_role'], { optional: true, note: 'Roles each ACL requires.' }),
  entry(RULE, 'sys_user_has_role', ['user', 'role'], { optional: true, note: 'Your roles (the page is asked first).' }),
  entry(RULE, 'sys_db_object', ['name', 'super_class'], { optional: true, note: 'Parent tables, so rules on a parent table are found (a failure is caught).' }),
];

// ---- Break this list down / What points at this record? -----------------------------------------------------------------

const INSIGHT = 'Break this list down';
const insight = [
  entry(INSIGHT, 'sys_dictionary', ['name', 'element', 'column_label', 'internal_type', 'reference', 'choice'], { optionalColumns: ['max_length'], note: 'Which columns can be broken down, and their labels.' }),
  entry(INSIGHT, 'sys_db_object', ['name', 'super_class'], { note: 'Parent tables, so inherited columns are found.' }),
];

const REFS = 'What points at this record?';
const refs = [
  entry(REFS, 'sys_dictionary', ['name', 'element', 'column_label', 'internal_type', 'reference', 'reference_cascade_rule', 'active'], { note: 'Every reference column that points at the record\'s table. reference, internal_type and active are in the query condition.' }),
  entry(REFS, 'sys_db_object', ['name', 'super_class'], { note: 'Parent tables.' }),
  entry(REFS, 'cmdb_rel_ci', ['parent', 'child', 'type'], { optional: true, note: 'CI relationships (configuration items only).' }),
];

// ---- Page X-ray (src/content/xray.js; every section checks its columns first and says what it skipped) ---------------

const XRAY = 'Page X-ray';
const xray = [
  entry(XRAY, 'sys_dictionary', ['name', 'element', 'column_label', 'internal_type', 'reference', 'mandatory', 'read_only', 'default_value', 'choice', 'attributes', 'active', 'display'], { optionalColumns: ['max_length', 'calculation', 'virtual', 'dependent', 'dependent_on_field', 'use_dependent_field', 'reference_qual', 'reference_qual_condition', 'use_reference_qualifier', 'dynamic_ref_qual'], note: 'Field details.' }),
  entry(XRAY, 'sys_db_object', ['name', 'super_class'], { optional: true, note: 'Parent tables. Without them X-ray reads the table itself only (xray.js hierarchy falls back).' }),
  entry(XRAY, 'sys_script_client', ['table', 'name', 'type', 'field', 'script', 'active'], { optionalColumns: ['ui_type', 'global', 'view', 'applies_extended'], optional: true, note: 'Client scripts section.' }),
  entry(XRAY, 'sys_ui_policy', ['table', 'short_description', 'conditions', 'on_load', 'reverse_if_false', 'order', 'run_scripts', 'script_true', 'script_false', 'inherit', 'active'], { optionalColumns: ['global', 'view', 'ui_type'], optional: true, note: 'UI policies section.' }),
  entry(XRAY, 'sys_ui_policy_action', ['ui_policy', 'field', 'mandatory', 'visible', 'disabled', 'cleared'], { optional: true, note: 'UI policy actions.' }),
  entry(XRAY, 'sys_data_policy2', ['model_table', 'short_description', 'conditions', 'enforce_ui', 'inherit', 'active'], { optional: true, note: 'Data policies section.' }),
  entry(XRAY, 'sys_data_policy_rule', ['sys_data_policy', 'field', 'mandatory', 'disabled'], { optional: true, note: 'Data policy rules.' }),
  entry(XRAY, 'sys_script', ['collection', 'name', 'when', 'order', 'script', 'action_insert', 'action_update', 'action_delete', 'action_query', 'active'], { optionalColumns: ['condition', 'filter_condition'], optional: true, note: 'Business rules section.' }),
  entry(XRAY, 'sys_security_acl', ['name', 'operation', 'type', 'active'], { optionalColumns: ['admin_overrides', 'advanced', 'description'], optional: true, note: 'ACLs section.' }),
  entry(XRAY, 'sys_dictionary_override', ['name', 'base_table', 'element', 'mandatory_override', 'read_only_override', 'default_value_override'], { optionalColumns: ['reference_qual_override', 'attributes_override', 'calculation_override', 'dependent_override', 'display_override'], optional: true, note: 'Dictionary overrides section.' }),
  entry(XRAY, 'sp_widget', ['name', 'id'], { optional: true, note: 'Service Portal widget names.' }),
  entry(XRAY, 'sp_instance', ['sp_widget', 'title', 'sys_class_name'], { optional: true, note: 'Service Portal widget instances.' }),
  entry(XRAY, 'sp_portal', ['url_suffix', 'title', 'homepage'], { optional: true, note: 'Service Portal page header.' }),
  entry(XRAY, 'sp_page', ['id', 'title'], { optional: true, note: 'Service Portal page header.' }),
  entry(XRAY, 'item_option_new', ['name', 'question_text', 'type', 'cat_item', 'variable_set', 'mandatory', 'read_only', 'active', 'default_value', 'reference', 'order'], { optional: true, note: 'Catalog item variables.' }),
  entry(XRAY, 'catalog_script_client', ['name', 'type', 'cat_variable', 'script', 'applies_to', 'cat_item', 'variable_set', 'ui_type', 'active'], { optional: true, note: 'Catalog client scripts.' }),
  entry(XRAY, 'catalog_ui_policy', ['short_description', 'catalog_conditions', 'conditions', 'applies_to', 'on_load', 'reverse_if_false', 'run_scripts', 'script_true', 'script_false', 'catalog_item', 'variable_set', 'order', 'active'], { optional: true, note: 'Catalog UI policies.' }),
  entry(XRAY, 'catalog_ui_policy_action', ['ui_policy', 'catalog_variable', 'variable', 'mandatory', 'visible', 'disabled', 'cleared'], { optional: true, note: 'Catalog UI policy actions.' }),
  entry(XRAY, 'sc_cat_item', ['name'], { optional: true, note: 'Catalog item name.' }),
];

// ---- Access debugger (src/content/accessDebugger.js) ----------------------------------------------------------------

const ACCESS = 'Access debugger';
const accessDebugger = [
  entry(ACCESS, 'sys_user', ['name', 'user_name', 'email', 'active'], { optionalColumns: ['locked_out', 'sys_domain', 'title'], note: 'The user being checked.' }),
  entry(ACCESS, 'sys_security_acl', ['name', 'operation', 'type', 'active', 'condition', 'script', 'description'], { optionalColumns: ['sys_scope', 'decision_type', 'applies_to', 'security_attribute', 'advanced', 'admin_overrides'], note: 'ACLs: the whole point of the tool. A user who cannot read this table cannot use it.' }),
  entry(ACCESS, 'sys_db_object', ['name', 'label', 'sys_scope', 'access'], { optionalColumns: ['super_class', 'read_access', 'create_access', 'update_access', 'delete_access'], note: 'Table facts.' }),
  entry(ACCESS, 'sys_dictionary', ['name', 'element', 'column_label', 'internal_type', 'reference', 'active'], { optionalColumns: ['read_only'], note: 'Field facts. read_only feeds the "read-only in the dictionary" section.' }),
  entry(ACCESS, 'sys_user_has_role', ['user', 'role', 'inherited', 'granted_by', 'included_in_role', 'state'], { optional: true, note: 'Roles assigned to the user.' }),
  entry(ACCESS, 'sys_user_grmember', ['user', 'group'], { optional: true, note: 'Groups of the user.' }),
  entry(ACCESS, 'sys_group_has_role', ['group', 'role', 'inherits'], { optional: true, note: 'Roles from groups.' }),
  entry(ACCESS, 'sys_user_role_contains', ['role', 'contains'], { optional: true, note: 'Roles that contain other roles.' }),
  entry(ACCESS, 'sys_user_role', ['name', 'elevated_privilege'], { optional: true, note: 'Elevated roles.' }),
  entry(ACCESS, 'sys_security_acl_role', ['sys_security_acl', 'sys_user_role'], { note: 'Roles each ACL requires. Required: without them every role check would look like "no role needed", so the debugger stops (accessDebugger.js).' }),
  entry(ACCESS, 'sys_script', ['name', 'collection', 'when', 'order', 'condition', 'filter_condition', 'script', 'action_query', 'active'], { optional: true, note: 'Query business rules that can hide rows.' }),
  entry(ACCESS, 'sys_ui_policy_action', ['ui_policy', 'field', 'disabled'], { optional: true, note: 'UI policies that make a field read-only.' }),
  entry(ACCESS, 'sys_data_policy_rule', ['sys_data_policy', 'table', 'field', 'disabled'], { optional: true, note: 'Data policies that make a field read-only.' }),
  entry(ACCESS, 'sys_app_module', ['title', 'link_type', 'query', 'name', 'active'], { optional: true, note: 'Finds the platform\'s Access Analyzer module for a link.' }),
  entry(ACCESS, 'sys_properties', ['name', 'value'], { optional: true, note: 'glide.sm.default_mode (the default deny/allow mode).' }),
];

// ---- Health scan (src/lib/healthScan.js SCAN_TABLES + the configuration and upgrade steps) ----------------------------

const HEALTH = 'Health scan';
const scanTable = (table, columns, extra = {}) => entry(HEALTH, table, columns, { optional: true, ...extra });
const healthScan = [
  entry(HEALTH, 'sys_db_object', ['name', 'super_class'], { note: 'Which tables exist; the scan checks every column against the dictionary first.' }),
  entry(HEALTH, 'sys_dictionary', ['name', 'element', 'internal_type', 'reference'], { note: 'Which columns exist.' }),
  entry(HEALTH, 'sys_script', ['name', 'script'], { optionalColumns: ['collection', 'when', 'order', 'condition', 'filter_condition', 'action_insert', 'action_update', 'action_delete', 'action_query', 'sys_scope', 'active'], note: 'Business rules.' }),
  entry(HEALTH, 'sys_script_include', ['name', 'script'], { optionalColumns: ['api_name', 'client_callable', 'sys_scope', 'active'], note: 'Script Includes.' }),
  scanTable('sys_script_client', ['name', 'script'], { note: 'Client scripts.' }),
  scanTable('catalog_script_client', ['name', 'script'], { note: 'Catalog client scripts.' }),
  scanTable('sys_ui_action', ['name', 'script'], { note: 'UI actions.' }),
  scanTable('sys_ui_policy', ['short_description', 'script_true', 'script_false'], { note: 'UI policies.' }),
  scanTable('sysevent_script_action', ['name', 'script'], { note: 'Script actions.' }),
  scanTable('sysauto_script', ['name', 'script', 'run_type', 'run_period'], { note: 'Scheduled jobs (frequency check).' }),
  scanTable('sys_transform_script', ['script', 'map'], { note: 'Transform scripts.' }),
  scanTable('sys_processor', ['name', 'script'], { note: 'Processors.' }),
  scanTable('sys_ws_operation', ['name', 'operation_script'], { note: 'Scripted REST resources.' }),
  scanTable('sys_security_acl', ['name', 'script', 'operation', 'type', 'condition'], { note: 'ACL scripts and the open-ACL security checks.' }),
  scanTable('sp_widget', ['name', 'script', 'client_script'], { note: 'Portal widgets.' }),
  scanTable('sys_ui_script', ['name', 'script'], { note: 'UI scripts.' }),
  scanTable('sys_update_xml', ['name', 'update_set', 'sys_updated_on'], { note: 'Customer updates: tells custom records from baseline ones.' }),
  scanTable('sys_update_set', ['name', 'state', 'sys_created_on', 'application', 'is_default'], { note: 'Update set checks.' }),
  scanTable('sys_properties', ['name', 'value'], { note: 'Vendor prefix and risky property checks.' }),
  scanTable('sys_public', ['page'], { note: 'Security: public pages.' }),
  scanTable('sys_user_has_role', ['user', 'role', 'granted_by'], { note: 'Security: admin role holders.' }),
  scanTable('sys_upgrade_history', ['to_version'], { note: 'Upgrade readiness.' }),
  scanTable('sys_upgrade_history_log', ['disposition', 'upgrade_history', 'resolution_status', 'file_name', 'target_name', 'type'], { alternates: ['priority'], note: 'Upgrade readiness: skipped records awaiting review.' }),
  scanTable('sys_scope', ['name', 'scope', 'version'], { note: 'Application list.' }),
];

// ---- Change impact (src/content/impact.js) -----------------------------------------------------------------------------

const IMPACT = 'Change impact';
const impact = [
  entry(IMPACT, 'sys_script', ['name', 'collection', 'when', 'order', 'active', 'action_insert', 'action_update', 'action_delete', 'action_query', 'condition', 'filter_condition', 'script'], { optional: true, note: 'Business rules: the record being analysed (when it is one) and the rules on the tables it writes; each section reports its own failure.' }),
  entry(IMPACT, 'sys_script_include', ['name', 'api_name', 'client_callable', 'active', 'script'], { optional: true, note: 'Script Includes: the record being analysed (when it is one) and the includes it calls; each section reports its own failure.' }),
  entry(IMPACT, 'sys_script_client', ['name', 'table', 'type', 'field', 'active', 'script'], { optional: true, note: 'Analysing a client script.' }),
  entry(IMPACT, 'catalog_script_client', ['name', 'type', 'active', 'script'], { optional: true, note: 'Analysing a catalog client script.' }),
  entry(IMPACT, 'sys_ui_action', ['name', 'table', 'action_name', 'client', 'active', 'condition', 'script'], { optional: true, note: 'Analysing a UI action.' }),
  entry(IMPACT, 'sys_ui_policy', ['short_description', 'table', 'active', 'script_true', 'script_false'], { optional: true, note: 'Analysing a UI policy.' }),
  entry(IMPACT, 'sysevent_script_action', ['name', 'event_name', 'active', 'script'], { optional: true, note: 'Script actions on events.' }),
  entry(IMPACT, 'sysevent_email_action', ['name', 'collection', 'event_name', 'action_insert', 'action_update', 'generation_type', 'active'], { optional: true, note: 'Notifications sent when a record is written.' }),
  entry(IMPACT, 'sysauto_script', ['name', 'active', 'run_type', 'script'], { optional: true, note: 'Scheduled jobs.' }),
  entry(IMPACT, 'sys_transform_script', ['map', 'when', 'script'], { optional: true, note: 'Transform scripts.' }),
  entry(IMPACT, 'sys_processor', ['name', 'active', 'script'], { optional: true, note: 'Processors.' }),
  entry(IMPACT, 'sys_ws_operation', ['name', 'http_method', 'operation_uri', 'active', 'operation_script'], { optional: true, note: 'Scripted REST resources.' }),
  entry(IMPACT, 'sys_security_acl', ['name', 'operation', 'active', 'condition', 'script'], { optional: true, note: 'ACL scripts.' }),
  entry(IMPACT, 'sp_widget', ['name', 'id', 'script', 'client_script'], { optional: true, note: 'Portal widgets.' }),
  entry(IMPACT, 'sp_instance', ['sp_widget'], { optional: true, note: 'Where a widget is placed on portal pages.' }),
  entry(IMPACT, 'sys_ui_script', ['name', 'active', 'script'], { optional: true, note: 'UI scripts.' }),
  entry(IMPACT, 'sys_flow_record_trigger', ['table', 'condition'], { optional: true, alternates: ['sys_name'], note: 'Flows triggered by the table.' }),
  entry(IMPACT, 'sys_update_xml', ['name', 'update_set', 'update_set.name', 'update_set.state', 'sys_updated_on', 'sys_updated_by'], { optional: true, note: 'Open update sets that hold the record.' }),
  entry(IMPACT, 'sys_update_version', ['name', 'sys_recorded_at'], { optional: true, note: 'Version count.' }),
  entry(IMPACT, 'syslog', ['sys_created_on', 'level', 'message', 'source'], { optional: true, note: 'Recent errors that mention the record.' }),
];

// ---- Where is this field used? / History of a field / Compare -----------------------------------------------------------

const USAGE = 'Where is this field used?';
const fieldUsage = [
  entry(USAGE, 'sys_dictionary', ['name', 'element', 'column_label', 'internal_type'], { optional: true, note: 'The columns of the table, for the field picker only; a typed table.field still works.' }),
  entry(USAGE, 'sys_db_object', ['name', 'super_class'], { note: 'Parent tables (tableHierarchy). Required: the search does not start without the table chain.' }),
  entry(USAGE, 'sys_ui_policy_action', ['field', 'visible', 'mandatory', 'disabled', 'ui_policy'], { optional: true, note: 'UI policy actions. The dot-walked ui_policy.* fields (short_description, table, active) are not live-checked yet.' }),
  entry(USAGE, 'sys_script_client', ['name', 'table', 'type', 'field', 'active'], { optional: true, note: 'onChange client scripts (the field column is called field, not field_name).' }),
  entry(USAGE, 'sys_security_acl', ['name', 'operation', 'active'], { optional: true, note: 'Field ACLs.' }),
  entry(USAGE, 'sys_data_policy_rule', ['field', 'table', 'mandatory', 'disabled'], { optional: true, note: 'Data policy rules. Not live-checked yet.' }),
  entry(USAGE, 'sys_dictionary_override', ['name', 'element'], { optional: true, note: 'Dictionary overrides. Not live-checked yet.' }),
  entry(USAGE, 'sys_script', ['name', 'collection', 'when', 'filter_condition', 'active'], { optional: true, note: 'Business rule filter conditions.' }),
  entry(USAGE, 'sys_ui_policy', ['short_description', 'table', 'conditions', 'active'], { optional: true, note: 'UI policy conditions. Not live-checked yet.' }),
];

const HISTORY = 'History of a field';
const fieldHistory = [
  entry(HISTORY, 'sys_audit', ['user', 'oldvalue', 'newvalue', 'fieldname', 'tablename', 'documentkey'], { optionalColumns: ['reason'], note: 'Audited changes. A table that is not audited has no history.' }),
  entry(HISTORY, 'sys_choice', ['name', 'element', 'value', 'label', 'language'], { optional: true, note: 'Labels for choice values.' }),
];

// ---- Test (Test kit, Test data, ATF finder) ------------------------------------------------------------------------------

const TEST = 'Test';
const testKit = [
  entry(TEST, 'sys_atf_step', ['test', 'description', 'inputs'], { optional: true, note: 'ATF finder: steps that mention a term.' }),
  entry(TEST, 'sys_atf_test', ['name', 'active', 'description'], { optional: true, note: 'ATF finder: tests.' }),
  entry(TEST, 'sys_atf_test_result', ['test', 'status', 'start_time', 'run_time', 'output'], { optional: true, note: 'ATF finder: latest results.' }),
  entry(TEST, 'sys_atf_test_suite_test', ['test_suite', 'test'], { optional: true, note: 'ATF finder: suites that contain a test.' }),
  entry(TEST, 'sys_atf_test_suite', ['name', 'active'], { optional: true, note: 'ATF finder: suites.' }),
  entry(TEST, 'sys_atf_test_suite_result', ['test_suite', 'status', 'success_count', 'failure_count'], { optional: true, note: 'ATF finder: suite results.' }),
  entry(TEST, 'sys_script', ['name', 'collection', 'when', 'active', 'advanced', 'script'], { optional: true, note: 'Test target: the business rule on screen. Running a test needs the background script endpoint (admin role).' }),
  entry(TEST, 'sys_script_include', ['name', 'api_name', 'client_callable', 'active', 'script'], { optional: true, note: 'Test target: the Script Include on screen.' }),
  entry(TEST, 'sys_ui_action', ['name', 'table', 'client', 'active', 'script'], { optional: true, note: 'Test target: the UI action on screen.' }),
  entry(TEST, 'sys_script_fix', ['name', 'script'], { optional: true, note: 'Test target: the fix script on screen.' }),
  entry(TEST, 'sysauto_script', ['name', 'script'], { optional: true, note: 'Test target: the scheduled job on screen.' }),
];

const TESTDATA = 'Test data';
const testData = [
  entry(TESTDATA, 'sys_dictionary', ['name', 'element', 'column_label', 'internal_type', 'reference', 'max_length', 'mandatory', 'read_only', 'default_value', 'choice', 'active'], { note: 'The columns to fill in. Creating rows also needs create access to the table, which this check cannot test without writing.' }),
  entry(TESTDATA, 'sys_db_object', ['name', 'super_class'], { note: 'Parent tables.' }),
  entry(TESTDATA, 'sys_choice', ['name', 'element', 'value', 'label'], { optional: true, note: 'Choice values for generated data.' }),
  entry(TESTDATA, 'sys_user', ['name', 'user_name', 'active'], { optional: true, note: 'Real users to point references at.' }),
];

// ---- Code search, Version history, Table explorer, Triage errors, Live log, Update sets ------------------------------------

const SEARCH = 'Code search';
const searchTable = (table, columns, extra = {}) => entry(SEARCH, table, columns, { optional: true, ...extra });
const codeSearch = [
  entry(SEARCH, 'sys_script', ['name', 'collection', 'when', 'active', 'script', 'condition'], { note: 'Business rules.' }),
  entry(SEARCH, 'sys_script_include', ['name', 'api_name', 'active', 'script'], { note: 'Script Includes.' }),
  searchTable('sys_script_client', ['name', 'table', 'type', 'active', 'script'], { note: 'Client scripts.' }),
  searchTable('sys_ui_action', ['name', 'table', 'active', 'script', 'condition'], { note: 'UI actions.' }),
  searchTable('sys_ui_policy', ['short_description', 'table', 'active', 'script_true', 'script_false'], { note: 'UI policies.' }),
  searchTable('sysevent_script_action', ['name', 'event_name', 'active', 'script'], { note: 'Script actions.' }),
  searchTable('sysauto_script', ['name', 'active', 'script'], { note: 'Scheduled jobs.' }),
  searchTable('sys_transform_script', ['map', 'when', 'script'], { note: 'Transform scripts.' }),
  searchTable('sys_processor', ['name', 'active', 'script'], { note: 'Processors.' }),
  searchTable('sys_ws_operation', ['name', 'http_method', 'active', 'operation_script'], { note: 'Scripted REST operations.' }),
  searchTable('sys_security_acl', ['name', 'operation', 'active', 'script', 'condition'], { note: 'ACLs.' }),
  searchTable('sp_widget', ['name', 'id', 'script', 'client_script'], { note: 'Portal widgets.' }),
  searchTable('sys_ui_script', ['name', 'active', 'script'], { note: 'UI scripts.' }),
  searchTable('catalog_script_client', ['name', 'type', 'active', 'script'], { note: 'Catalog client scripts.' }),
];

const VERSIONS = 'Version history';
const versions = [
  entry(VERSIONS, 'sys_update_version', ['name', 'sys_recorded_at', 'sys_created_by', 'payload'], { optionalColumns: ['source', 'state', 'action'], note: 'The saved versions of a record. The date shown comes from sys_created_on, because sys_recorded_at is an opaque token.' }),
];

const EXPLORER = 'Table explorer';
const tableExplorer = [
  entry(EXPLORER, 'sys_db_object', ['name', 'super_class'], { optionalColumns: ['label', 'sys_scope', 'is_extendable', 'extension_model', 'number_ref', 'access'], note: 'The parent chain (required) and the table facts card (fetchTableInfo, which the panel lets fail).' }),
  entry(EXPLORER, 'sys_dictionary', ['name', 'element', 'column_label', 'internal_type', 'reference', 'max_length', 'mandatory', 'read_only', 'default_value', 'active', 'unique', 'display', 'choice', 'calculation', 'attributes', 'array', 'audit', 'primary'], { optionalColumns: ['virtual', 'dependent', 'use_dependent_field', 'function_field', 'comments'], note: 'Every column with its dictionary details.' }),
  entry(EXPLORER, 'sys_documentation', ['name', 'element', 'language', 'label', 'plural', 'help', 'hint'], { optional: true, note: 'Labels and help text.' }),
  entry(EXPLORER, 'sys_choice', ['name', 'element', 'language', 'value', 'label', 'sequence', 'inactive', 'dependent_value', 'hint'], { optional: true, note: 'Choice lists.' }),
  entry(EXPLORER, 'sys_dictionary_override', ['name', 'base_table', 'element', 'mandatory_override', 'read_only_override', 'default_value_override', 'reference_qual_override', 'attributes_override', 'display_override'], { optional: true, note: 'Overrides on child tables.' }),
  entry(EXPLORER, 'sys_ui_list', ['name', 'relationship', 'parent', 'sys_user', 'view'], { optional: true, note: 'List layouts.' }),
  entry(EXPLORER, 'sys_ui_list_element', ['list_id', 'element', 'position'], { optional: true, note: 'List layout columns.' }),
];

const TRIAGE = 'Triage errors';
const triage = [
  entry(TRIAGE, 'syslog', ['level', 'source', 'message', 'sys_created_by'], { note: 'Recent errors and warnings from the system log.' }),
  entry(TRIAGE, 'syslog_transaction', ['url', 'type', 'response_time', 'sql_count', 'sql_time'], { optional: true, note: 'Slow transactions.' }),
];

const TAIL = 'Live log';
const liveLog = [entry(TAIL, 'syslog', ['level', 'source', 'message', 'sys_created_by'], { note: 'Polled every few seconds. Reading the system log needs the admin role on most instances.' })];

const UPDATESETS = 'Update sets';
const updateSets = [
  entry(UPDATESETS, 'sys_update_set', ['name', 'state', 'application', 'description'], { note: 'Open and completed update sets.' }),
  entry(UPDATESETS, 'sys_update_xml', ['name', 'type', 'target_name', 'action', 'update_set', 'application', 'sys_updated_on', 'sys_updated_by', 'sys_created_by'], { note: 'Entries, collisions with other sets, capture coverage.' }),
];

export const REQUIREMENTS = [
  ...failures,
  ...hotSpots,
  ...recent,
  ...releaseNotes,
  ...saveTrace,
  ...whyRule,
  ...insight,
  ...refs,
  ...xray,
  ...accessDebugger,
  ...healthScan,
  ...impact,
  ...myWork,
  ...shipCheck,
  ...fieldUsage,
  ...fieldHistory,
  ...testKit,
  ...testData,
  ...codeSearch,
  ...versions,
  ...tableExplorer,
  ...triage,
  ...liveLog,
  ...updateSets,
];
