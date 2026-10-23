// Dev-only fake instance data for the Data model map (see preview/fixtures/index.js). Not shipped.
//
// A realistic mini schema - task > incident / problem / change_request, sys_user > manager > department, the cmdb_ci
// hierarchy, a few link tables - answered through the real Table API shapes:
//   GET /api/now/table/sys_db_object   (name, label, super_class, super_class.name, sys_scope.scope, is_extendable)
//   GET /api/now/table/sys_dictionary  (name, element, column_label, internal_type, reference, active, display, dependent ...)
//   GET /api/now/table/sys_m2m         (a few generic columns)
//   GET /api/now/stats/<table>         (sysparm_count: a made-up row count for each table, real counts for the two above)
//
// It answers ONLY when the preview is opened on this panel (?open=datamodel), so the other panels' fake data
// (sys_dictionary for the Table explorer, etc.) is left alone. tests/datamodel.test.js sets
// globalThis.__DATAMODEL_FIXTURE__ = true to use the same data without a browser.

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const hex = (text) => {
  let h = 0x811c9dc5;
  const out = [];
  for (let round = 0; round < 4; round += 1) {
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ (text.charCodeAt(i) + round), 0x01000193) >>> 0;
    out.push(h.toString(16).padStart(8, '0'));
  }
  return out.join('');
};

// [name, label, parent, rows]
export const MINI_TABLES = [
  ['task', 'Task', '', 482113],
  ['incident', 'Incident', 'task', 91244],
  ['problem', 'Problem', 'task', 3120],
  ['problem_task', 'Problem Task', 'task', 880],
  ['change_request', 'Change Request', 'task', 15764],
  ['sc_request', 'Request', 'task', 22010],
  ['sc_req_item', 'Requested Item', 'task', 61873],
  ['sc_task', 'Catalog Task', 'task', 59002],
  ['sc_cat_item', 'Catalog Item', '', 412],
  ['sys_user', 'User', '', 18420],
  ['sys_user_group', 'Group', '', 640],
  ['sys_user_role', 'Role', '', 380],
  ['sys_user_grmember', 'Group Member', '', 24100],
  ['sys_user_has_role', 'User Role', '', 98210],
  ['sys_user_preference', 'User Preference', '', 204800],
  ['sys_email', 'Email', '', 1920400],
  ['sys_ui_list', 'List', '', 6400],
  ['cmn_department', 'Department', '', 74],
  ['cmn_location', 'Location', '', 310],
  ['core_company', 'Company', '', 96],
  ['cmn_cost_center', 'Cost Center', '', 58],
  ['cmdb_ci', 'Configuration Item', '', 55210],
  ['cmdb_ci_hardware', 'Hardware', 'cmdb_ci', 8840],
  ['cmdb_ci_computer', 'Computer', 'cmdb_ci_hardware', 8120],
  ['cmdb_ci_server', 'Server', 'cmdb_ci_computer', 4400],
  ['cmdb_ci_linux_server', 'Linux Server', 'cmdb_ci_server', 2900],
  ['cmdb_ci_win_server', 'Windows Server', 'cmdb_ci_server', 1500],
  ['cmdb_ci_service', 'Business Service', 'cmdb_ci', 120],
  ['cmdb_model', 'Product Model', '', 2210],
  ['cmdb_rel_ci', 'CI Relationship', '', 70350],
  ['cmdb_rel_type', 'CI Relationship Type', '', 62],
  ['task_ci', 'Affected CI', '', 40220],
  ['task_sla', 'Task SLA', '', 188400],
  ['contract_sla', 'SLA Definition', '', 24],
  ['sysapproval_approver', 'Approval', '', 52120],
];

const ROOT_COLUMNS = [
  ['sys_id', 'GUID', '', 'Sys ID'],
  ['sys_created_on', 'glide_date_time', '', 'Created'],
  ['sys_created_by', 'string', '', 'Created by'],
  ['sys_updated_on', 'glide_date_time', '', 'Updated'],
  ['sys_updated_by', 'string', '', 'Updated by'],
  ['sys_mod_count', 'integer', '', 'Updates'],
];

// element, internal_type, reference, label  (an optional 5th entry: extra dictionary columns)
export const MINI_COLUMNS = {
  task: [
    ['number', 'string', '', 'Number', { display: 'true' }],
    ['short_description', 'string', '', 'Short description'],
    ['description', 'string', '', 'Description'],
    ['state', 'integer', '', 'State'],
    ['priority', 'integer', '', 'Priority'],
    ['opened_by', 'reference', 'sys_user', 'Opened by'],
    ['opened_at', 'glide_date_time', '', 'Opened'],
    ['closed_by', 'reference', 'sys_user', 'Closed by'],
    ['assigned_to', 'reference', 'sys_user', 'Assigned to'],
    ['assignment_group', 'reference', 'sys_user_group', 'Assignment group'],
    ['parent', 'reference', 'task', 'Parent'],
    ['location', 'reference', 'cmn_location', 'Location'],
    ['company', 'reference', 'core_company', 'Company'],
    ['business_service', 'reference', 'cmdb_ci_service', 'Service'],
    ['cmdb_ci', 'reference', 'cmdb_ci', 'Configuration item'],
    ['watch_list', 'glide_list', 'sys_user', 'Watch list'],
    ['work_notes_list', 'glide_list', 'sys_user', 'Work notes list'],
    ['sys_class_name', 'sys_class_name', '', 'Task type'],
    ['sys_domain', 'domain_id', 'domain', 'Domain'],
  ],
  incident: [
    ['caller_id', 'reference', 'sys_user', 'Caller'],
    ['category', 'string', '', 'Category'],
    ['subcategory', 'string', '', 'Subcategory'],
    ['impact', 'integer', '', 'Impact'],
    ['urgency', 'integer', '', 'Urgency'],
    ['parent_incident', 'reference', 'incident', 'Parent incident'],
    ['problem_id', 'reference', 'problem', 'Problem'],
    ['rfc', 'reference', 'change_request', 'Change request'],
    ['caused_by', 'reference', 'change_request', 'Caused by Change'],
    ['close_code', 'string', '', 'Close code'],
    ['close_notes', 'string', '', 'Close notes'],
    ['origin_table', 'table_name', '', 'Origin table'],
    ['origin_id', 'document_id', '', 'Origin', { dependent: 'origin_table' }],
  ],
  problem: [
    ['first_reported_by_task', 'reference', 'task', 'First reported by'],
    ['known_error', 'boolean', '', 'Known error'],
    ['cause_notes', 'string', '', 'Cause notes'],
  ],
  problem_task: [['problem', 'reference', 'problem', 'Problem']],
  change_request: [
    ['requested_by', 'reference', 'sys_user', 'Requested by'],
    ['type', 'string', '', 'Type'],
    ['risk', 'integer', '', 'Risk'],
    ['backout_plan', 'string', '', 'Backout plan'],
  ],
  sc_request: [['requested_for', 'reference', 'sys_user', 'Requested for']],
  sc_req_item: [
    ['request', 'reference', 'sc_request', 'Request'],
    ['cat_item', 'reference', 'sc_cat_item', 'Item'],
    ['requested_for', 'reference', 'sys_user', 'Requested for'],
  ],
  sc_task: [['request_item', 'reference', 'sc_req_item', 'Request item']],
  sc_cat_item: [['name', 'string', '', 'Name', { display: 'true' }]],
  sys_user: [
    ['user_name', 'string', '', 'User ID'],
    ['first_name', 'string', '', 'First name'],
    ['last_name', 'string', '', 'Last name'],
    ['name', 'string', '', 'Name', { display: 'true' }],
    ['email', 'email', '', 'Email'],
    ['title', 'string', '', 'Title'],
    ['active', 'boolean', '', 'Active'],
    ['manager', 'reference', 'sys_user', 'Manager'],
    ['department', 'reference', 'cmn_department', 'Department'],
    ['location', 'reference', 'cmn_location', 'Location'],
    ['company', 'reference', 'core_company', 'Company'],
    ['cost_center', 'reference', 'cmn_cost_center', 'Cost center'],
    ['vip', 'boolean', '', 'VIP'],
    ['password_needs_reset', 'boolean', '', 'Password needs reset'],
    ['sys_domain', 'domain_id', 'domain', 'Domain'],
  ],
  sys_user_group: [
    ['name', 'string', '', 'Name', { display: 'true' }],
    ['description', 'string', '', 'Description'],
    ['manager', 'reference', 'sys_user', 'Manager'],
    ['parent', 'reference', 'sys_user_group', 'Parent'],
    ['email', 'email', '', 'Email'],
    ['active', 'boolean', '', 'Active'],
  ],
  sys_user_role: [['name', 'string', '', 'Name', { display: 'true' }]],
  sys_user_grmember: [
    ['user', 'reference', 'sys_user', 'User'],
    ['group', 'reference', 'sys_user_group', 'Group'],
  ],
  sys_user_has_role: [
    ['user', 'reference', 'sys_user', 'User'],
    ['role', 'reference', 'sys_user_role', 'Role'],
    ['inherited', 'boolean', '', 'Inherited'],
  ],
  sys_user_preference: [
    ['user', 'reference', 'sys_user', 'User'],
    ['name', 'string', '', 'Name'],
    ['value', 'string', '', 'Value'],
  ],
  sys_email: [
    ['user_id', 'reference', 'sys_user', 'User'],
    ['subject', 'string', '', 'Subject'],
    ['target_table', 'table_name', '', 'Target table'],
    ['instance', 'document_id', '', 'Target record', { dependent: 'target_table' }],
  ],
  sys_ui_list: [
    ['name', 'string', '', 'Name'],
    ['sys_user', 'reference', 'sys_user', 'User'],
  ],
  cmn_department: [
    ['name', 'string', '', 'Name', { display: 'true' }],
    ['id', 'string', '', 'ID'],
    ['dept_head', 'reference', 'sys_user', 'Department head'],
    ['parent', 'reference', 'cmn_department', 'Parent'],
    ['company', 'reference', 'core_company', 'Company'],
    ['primary_contact', 'reference', 'sys_user', 'Primary contact'],
    ['cost_center', 'reference', 'cmn_cost_center', 'Cost center'],
  ],
  cmn_location: [
    ['name', 'string', '', 'Name', { display: 'true' }],
    ['parent', 'reference', 'cmn_location', 'Parent'],
    ['company', 'reference', 'core_company', 'Company'],
    ['contact', 'reference', 'sys_user', 'Contact'],
    ['city', 'string', '', 'City'],
    ['country', 'string', '', 'Country'],
  ],
  core_company: [
    ['name', 'string', '', 'Name', { display: 'true' }],
    ['parent', 'reference', 'core_company', 'Parent'],
    ['manufacturer', 'boolean', '', 'Manufacturer'],
  ],
  cmn_cost_center: [
    ['name', 'string', '', 'Name', { display: 'true' }],
    ['account_number', 'string', '', 'Account number'],
    ['manager', 'reference', 'sys_user', 'Manager'],
  ],
  cmdb_ci: [
    ['name', 'string', '', 'Name', { display: 'true' }],
    ['sys_class_name', 'sys_class_name', '', 'Class'],
    ['operational_status', 'integer', '', 'Operational status'],
    ['managed_by', 'reference', 'sys_user', 'Managed by'],
    ['owned_by', 'reference', 'sys_user', 'Owned by'],
    ['assigned_to', 'reference', 'sys_user', 'Assigned to'],
    ['location', 'reference', 'cmn_location', 'Location'],
    ['company', 'reference', 'core_company', 'Company'],
    ['support_group', 'reference', 'sys_user_group', 'Support group'],
    ['department', 'reference', 'cmn_department', 'Department'],
  ],
  cmdb_ci_hardware: [
    ['serial_number', 'string', '', 'Serial number'],
    ['model_id', 'reference', 'cmdb_model', 'Model ID'],
  ],
  cmdb_ci_computer: [
    ['cpu_count', 'integer', '', 'CPU count'],
    ['ram', 'integer', '', 'RAM (MB)'],
    ['os', 'string', '', 'Operating system'],
  ],
  cmdb_ci_server: [['default_gateway', 'string', '', 'Default gateway']],
  cmdb_ci_linux_server: [['kernel_release', 'string', '', 'Kernel release']],
  cmdb_ci_win_server: [['os_service_pack', 'string', '', 'Service pack']],
  cmdb_ci_service: [['service_classification', 'string', '', 'Service classification']],
  cmdb_model: [
    ['name', 'string', '', 'Name', { display: 'true' }],
    ['manufacturer', 'reference', 'core_company', 'Manufacturer'],
  ],
  cmdb_rel_ci: [
    ['parent', 'reference', 'cmdb_ci', 'Parent'],
    ['child', 'reference', 'cmdb_ci', 'Child'],
    ['type', 'reference', 'cmdb_rel_type', 'Type'],
  ],
  cmdb_rel_type: [['name', 'string', '', 'Name', { display: 'true' }]],
  task_ci: [
    ['task', 'reference', 'task', 'Task'],
    ['ci_item', 'reference', 'cmdb_ci', 'Configuration item'],
  ],
  task_sla: [
    ['task', 'reference', 'task', 'Task'],
    ['sla', 'reference', 'contract_sla', 'SLA'],
    ['stage', 'string', '', 'Stage'],
    ['has_breached', 'boolean', '', 'Has breached'],
  ],
  contract_sla: [['name', 'string', '', 'Name', { display: 'true' }]],
  sysapproval_approver: [
    ['approver', 'reference', 'sys_user', 'Approver'],
    ['sysapproval', 'reference', 'task', 'Approval for'],
    ['document_id', 'document_id', '', 'Document', { dependent: 'source_table' }],
    ['source_table', 'table_name', '', 'Source table'],
    ['state', 'string', '', 'State'],
  ],
};

const M2M = [
  { sys_id: hex('m2m:grmember'), label: 'Group Members', m2m_table: 'sys_user_grmember', from_table: 'sys_user', to_table: 'sys_user_group' },
  { sys_id: hex('m2m:has_role'), label: 'User Roles', m2m_table: 'sys_user_has_role', from_table: 'sys_user', to_table: 'sys_user_role' },
  { sys_id: hex('m2m:task_ci'), label: 'Affected CIs', m2m_table: 'task_ci', from_table: 'task', to_table: 'cmdb_ci' },
];

function tableRows() {
  const byName = new Map(MINI_TABLES.map((t) => [t[0], t]));
  const parentCount = (name) => MINI_TABLES.filter((t) => t[2] === name).length;
  return MINI_TABLES.map(([name, label, parent]) => ({
    sys_id: hex(`sys_db_object:${name}`),
    name,
    label,
    super_class: parent ? hex(`sys_db_object:${parent}`) : '',
    'super_class.name': parent ? byName.get(parent)[0] : '',
    'sys_scope.scope': 'global',
    'sys_scope.name': 'Global',
    is_extendable: String(parentCount(name) > 0 || ['task', 'cmdb_ci'].includes(name)),
    extension_model: '',
    access: 'public',
  }));
}

function dictionaryRows() {
  const rows = [];
  MINI_TABLES.forEach(([table, label, parent]) => {
    rows.push({ sys_id: hex(`sys_dictionary:${table}.`), name: table, element: '', column_label: label, internal_type: 'collection', reference: '', active: 'true', display: 'false', max_length: '', dependent: '' });
    const own = [...(parent ? [] : ROOT_COLUMNS), ...(MINI_COLUMNS[table] || [])];
    own.forEach(([element, type, reference, columnLabel, extra = {}]) => {
      rows.push({ sys_id: hex(`sys_dictionary:${table}.${element}`), name: table, element, column_label: columnLabel, internal_type: type, reference: type === 'reference' || type === 'glide_list' ? reference : '', active: 'true', display: 'false', max_length: type === 'GUID' ? '32' : '40', dependent: '', ...extra });
    });
  });
  return rows;
}

// --- a small encoded-query evaluator, enough for the queries the Data model map sends --------------------------------

const COND = /^([a-z0-9_.]+?)(ISNOTEMPTY|ISEMPTY|NOT ?LIKE|NOTIN|STARTSWITH|ENDSWITH|LIKE|IN|!=|>=|<=|=|>|<)(.*)$/;

function test(row, cond) {
  const m = COND.exec(cond);
  if (!m) return true;
  const [, field, op, raw] = m;
  const v = String(row[field] ?? '');
  const lower = v.toLowerCase();
  const t = raw.toLowerCase();
  switch (op) {
    case '=': return v === raw;
    case '!=': return v !== raw;
    case 'IN': return raw.split(',').includes(v);
    case 'NOTIN': return !raw.split(',').includes(v);
    case 'LIKE': return lower.includes(t);
    case 'NOTLIKE':
    case 'NOT LIKE': return !lower.includes(t);
    case 'STARTSWITH': return lower.startsWith(t);
    case 'ENDSWITH': return lower.endsWith(t);
    case 'ISEMPTY': return v === '';
    case 'ISNOTEMPTY': return v !== '';
    default: return true;
  }
}

function select(rows, query) {
  const groups = [];
  const order = [];
  String(query || '')
    .split('^')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'EQ')
    .forEach((token) => {
      if (token.startsWith('ORDERBYDESC')) order.push({ field: token.slice(11), desc: true });
      else if (token.startsWith('ORDERBY')) order.push({ field: token.slice(7), desc: false });
      else if (token.startsWith('OR') && groups.length && COND.test(token.slice(2))) groups[groups.length - 1].push(token.slice(2));
      else groups.push([token]);
    });
  let out = rows.filter((row) => groups.every((g) => g.some((c) => test(row, c))));
  if (order.length) {
    out = [...out].sort((a, b) => {
      for (const o of order) {
        const x = String(a[o.field] ?? '');
        const y = String(b[o.field] ?? '');
        if (x !== y) return (x < y ? -1 : 1) * (o.desc ? -1 : 1);
      }
      return 0;
    });
  }
  return out;
}

const project = (row, fields) => (fields.length ? Object.fromEntries(fields.filter((f) => f in row).map((f) => [f, row[f]])) : row);

const enabled = () => globalThis.__DATAMODEL_FIXTURE__ === true || (typeof location !== 'undefined' && new URLSearchParams(location.search).get('open') === 'datamodel');

/** Answer sys_db_object, sys_dictionary, sys_m2m (rows) and the Aggregate API counts; null for anything else. */
export function route(method, url /* URL */) {
  if (method !== 'GET' || !enabled()) return null;
  let m = /^\/api\/now\/table\/(sys_db_object|sys_dictionary|sys_m2m)$/.exec(url.pathname);
  if (m) {
    const source = m[1] === 'sys_db_object' ? tableRows() : m[1] === 'sys_dictionary' ? dictionaryRows() : M2M;
    const fields = (url.searchParams.get('sysparm_fields') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const offset = Number(url.searchParams.get('sysparm_offset') || 0);
    const limit = Number(url.searchParams.get('sysparm_limit') || 10000);
    return json({ result: select(source, url.searchParams.get('sysparm_query') || '').slice(offset, offset + limit).map((r) => project(r, fields)) });
  }
  m = /^\/api\/now\/stats\/([a-z0-9_]+)$/.exec(url.pathname);
  if (m) {
    const table = m[1];
    if (table === 'sys_db_object' || table === 'sys_dictionary') {
      const source = table === 'sys_db_object' ? tableRows() : dictionaryRows();
      return json({ result: { stats: { count: String(select(source, url.searchParams.get('sysparm_query') || '').length) } } });
    }
    const hit = MINI_TABLES.find((t) => t[0] === table);
    if (hit && !url.searchParams.get('sysparm_query')) return json({ result: { stats: { count: String(hit[3]) } } });
  }
  return null;
}
