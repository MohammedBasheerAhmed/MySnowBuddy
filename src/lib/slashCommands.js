// Slash command vocabulary for the palette: record finders ("/br name"), the reserved verbs
// handled in slashBar.js, and user-defined URL templates. Pure so it can be unit tested.

// [verb, aliases, label, table, fields to search, display field, hint field]
const FINDERS = [
  ['br', [], 'Business Rules', 'sys_script', ['name'], 'name', 'collection'],
  ['si', [], 'Script Includes', 'sys_script_include', ['name', 'api_name'], 'name', 'api_name'],
  ['cl', [], 'Client Scripts', 'sys_script_client', ['name'], 'name', 'table'],
  ['uia', [], 'UI Actions', 'sys_ui_action', ['name'], 'name', 'table'],
  ['uip', [], 'UI Policies', 'sys_ui_policy', ['short_description'], 'short_description', 'table'],
  ['uis', [], 'UI Scripts', 'sys_ui_script', ['name'], 'name', ''],
  ['uipg', [], 'UI Pages', 'sys_ui_page', ['name'], 'name', ''],
  ['macro', [], 'UI Macros', 'sys_ui_macro', ['name'], 'name', ''],
  ['acl', [], 'ACLs', 'sys_security_acl', ['name'], 'name', 'operation'],
  ['fix', [], 'Fix Scripts', 'sys_script_fix', ['name'], 'name', ''],
  ['job', ['sj'], 'Scheduled Jobs', 'sysauto_script', ['name'], 'name', ''],
  ['ea', [], 'Script Actions', 'sysevent_script_action', ['name'], 'name', 'event_name'],
  ['evt', [], 'Event Registry', 'sysevent_register', ['event_name'], 'event_name', 'table'],
  ['notif', [], 'Notifications', 'sysevent_email_action', ['name'], 'name', 'collection'],
  ['sra', [], 'Scripted REST APIs', 'sys_ws_definition', ['name'], 'name', ''],
  ['tm', [], 'Transform Maps', 'sys_transform_map', ['name'], 'name', 'target_table'],
  ['flow', [], 'Flows', 'sys_hub_flow', ['name'], 'name', ''],
  ['widget', [], 'Portal Widgets', 'sp_widget', ['name', 'id'], 'name', 'id'],
  ['page', [], 'Portal Pages', 'sp_page', ['title', 'id'], 'title', 'id'],
  ['dict', [], 'Dictionary entries', 'sys_dictionary', ['element', 'column_label'], 'element', 'name'],
  ['u', ['user'], 'Users', 'sys_user', ['user_name', 'name', 'email'], 'name', 'user_name'],
  ['g', ['grp', 'group'], 'Groups', 'sys_user_group', ['name'], 'name', ''],
  ['role', [], 'Roles', 'sys_user_role', ['name'], 'name', ''],
  ['app', [], 'Applications', 'sys_app', ['name', 'scope'], 'name', 'scope'],
  ['us', ['updateset'], 'Update Sets', 'sys_update_set', ['name'], 'name', 'state'],
  ['ci', ['cmdb'], 'Configuration Items', 'cmdb_ci', ['name'], 'name', 'sys_class_name'],
  ['inc', ['incident'], 'Incidents', 'incident', ['number', 'short_description'], 'number', 'short_description'],
  ['chg', ['change'], 'Changes', 'change_request', ['number', 'short_description'], 'number', 'short_description'],
  ['prb', ['problem'], 'Problems', 'problem', ['number', 'short_description'], 'number', 'short_description'],
  ['task', [], 'Tasks', 'task', ['number', 'short_description'], 'number', 'short_description'],
  ['req', [], 'Requests', 'sc_request', ['number', 'short_description'], 'number', 'short_description'],
  ['ritm', [], 'Requested Items', 'sc_req_item', ['number', 'short_description'], 'number', 'short_description'],
  ['sctask', [], 'Catalog Tasks', 'sc_task', ['number', 'short_description'], 'number', 'short_description'],
  ['kb', [], 'Knowledge Articles', 'kb_knowledge', ['number', 'short_description'], 'number', 'short_description'],
  ['item', ['cat'], 'Catalog Items', 'sc_cat_item', ['name'], 'name', ''],
  ['mail', ['email'], 'Emails', 'sys_email', ['subject', 'recipients'], 'subject', 'recipients'],
];

export const FIND_COMMANDS = FINDERS.map(([verb, aliases, label, table, search, display, hint]) => ({
  verb,
  aliases,
  label,
  table,
  search,
  display,
  hint,
}));

// Handled in slashBar.js; a custom command may not reuse these.
export const SPECIAL_VERBS = [
  ['tn', '<table> [encoded query]', 'Open a table list, optionally filtered'],
  ['tnn', '<table>', 'New record on a table'],
  ['tables', '<text>', 'Find tables by name or label'],
  ['sys', '<sys_id>', 'Open the record a sys_id belongs to'],
  ['i', '[text]', 'Switch instance: this page on another instance'],
  ['sa', '[text]', 'Switch application'],
  ['su', '[text]', 'Switch update set'],
  ['search', '<text>', 'Global text search on the instance'],
  ['props', '<text>', 'System properties matching a name or value'],
  ['log', '[text]', 'System log, optionally filtered by message'],
  ['code', '', 'Code search across the instance'],
  ['bg', '', 'Background script runner'],
  ['sync', '', 'Edit the script in VS Code via a synced file'],
  ['edit', '', 'Full-screen script editor'],
  ['similar', '', 'Records like the one that is open'],
  ['names', '', 'Show or hide database names on the page'],
  ['new', '<br|si|cs|uia|sj|fix|rest> [name] [on table]', 'New script from a verified template'],
  ['xml', '', 'XML of the current record'],
  ['cs', '', 'Flush the instance cache'],
  ['stats', '', 'Node stats'],
];

const FIND_BY_VERB = new Map();
FIND_COMMANDS.forEach((def) => {
  FIND_BY_VERB.set(def.verb, def);
  def.aliases.forEach((alias) => FIND_BY_VERB.set(alias, def));
});

const RESERVED = new Set([...FIND_BY_VERB.keys(), ...SPECIAL_VERBS.map(([verb]) => verb)]);

export function findCommand(verb) {
  return FIND_BY_VERB.get(String(verb || '').toLowerCase()) || null;
}

/** An encoded-query value: a caret would start a new condition, so it is doubled. */
export function escapeQueryValue(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .replace(/\^/g, '^^');
}

/** Encoded query for "/verb <term>": contains-match on every search field, sorted by the display field. */
export function buildFindQuery(def, term) {
  const value = escapeQueryValue(term);
  if (!value) return 'ORDERBYDESCsys_updated_on';
  return `${def.search.map((field) => `${field}LIKE${value}`).join('^OR')}^ORDERBY${def.display}`;
}

export function slashHelpRows(custom = []) {
  return [
    ...SPECIAL_VERBS,
    ...FIND_COMMANDS.map((def) => [def.verb, '<search>', `Find ${def.label.toLowerCase()}`]),
    ...custom.map((c) => [c.verb, c.template.includes('{') ? '<text>' : '', c.label || c.template]),
  ];
}

export const CUSTOM_VERB_RE = /^[a-z][a-z0-9_-]{0,15}$/;

/**
 * Validate a user-defined command. The template is a root-relative path; "{q}" is replaced with the
 * typed text as an encoded-query value, and "{raw}" with the text as-is. Throws a readable Error.
 */
export function normalizeCustomCommand({ verb, template }) {
  const name = String(verb || '').trim().replace(/^\//, '').toLowerCase();
  if (!CUSTOM_VERB_RE.test(name)) throw new Error('The command name must be 1-16 letters, digits, "-" or "_", starting with a letter.');
  if (RESERVED.has(name)) throw new Error(`"/${name}" is already a built-in command.`);

  const path = String(template || '').trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('..') || path.length > 500) {
    throw new Error('The target must be a root-relative path such as /incident_list.do?sysparm_query=numberLIKE{q}.');
  }
  return { verb: name, template: path };
}

export function expandTemplate(template, term) {
  return template
    .replace(/\{q\}/g, encodeURIComponent(escapeQueryValue(term)))
    .replace(/\{raw\}/g, encodeURIComponent(String(term ?? '').trim()));
}
