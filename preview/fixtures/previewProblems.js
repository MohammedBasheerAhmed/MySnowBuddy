// Dev-only (not shipped): fake instance answers for the "Update set preview problems" panel (preview/fixtures/index.js).
//
// A retrieved update set that will not commit ("Payroll release 4") with ten preview problems of mixed kinds, two more
// retrieved sets that create what it is missing ("Payroll groups and roles" needs "Payroll data model" in turn, so the
// commit order is data model, groups, release), a collision with a newer local version, an unseen kind of problem and two
// problems that were already skipped / accepted. Three more sets fill the picker (clean, not previewed, committed).
//
// The column names of sys_update_preview_problem here are the ones the feature expects to find; the real ones are NOT
// verified (docs/features/previewfix.md). Variants for checking the honest-failure paths:
//   ?ppvariant=nodict   the dictionary of the problem table cannot be read (columns are guessed from a row)
//   ?ppvariant=denied   the problem table answers 403
//   ?ppvariant=noprovider  sys_update_xml has no remote_update_set column
//
// Answers only the tables below, and only the queries about them; returns null for everything else.

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const failure = (status, message) => json({ error: { message, detail: null }, status: 'failure' }, status);

const variant = () => {
  try {
    return new URLSearchParams(location.search).get('ppvariant') || '';
  } catch {
    return '';
  }
};

// Stable 32-character ids.
function id(label) {
  let out = '';
  for (let part = 0; part < 4; part += 1) {
    let h = 2166136261 ^ (part * 16777619);
    for (const c of `${label}:${part}`) {
      h ^= c.charCodeAt(0);
      h = Math.imul(h, 16777619) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

export const IDS = {
  release: id('set:release'),
  groups: id('set:groups'),
  data: id('set:data'),
  catalog: id('set:catalog'),
  portal: id('set:portal'),
  hotfix: id('set:hotfix'),
};

// ---- the retrieved update sets -------------------------------------------------------------------------------------

const SETS = [
  { sys_id: IDS.release, name: 'Payroll release 4 (STRY0012480)', state: 'previewed', application: 'Payroll', commit_date: '', collisions: '3', parent: '', description: 'Payroll rounding, approver notifications and the cost center field', sys_created_on: '2026-10-21 08:14:00', sys_updated_on: '2026-10-22 16:40:00' },
  { sys_id: IDS.groups, name: 'Payroll groups and roles (STRY0012471)', state: 'previewed', application: 'Payroll', commit_date: '', collisions: '0', parent: '', description: 'Approver group and the roles that go with it', sys_created_on: '2026-10-21 08:02:00', sys_updated_on: '2026-10-22 16:12:00' },
  { sys_id: IDS.data, name: 'Payroll data model (STRY0012465)', state: 'previewed', application: 'Payroll', commit_date: '', collisions: '0', parent: '', description: 'u_payroll_run, the cost center column and the payroll_admin role', sys_created_on: '2026-10-21 07:55:00', sys_updated_on: '2026-10-22 15:58:00' },
  { sys_id: IDS.catalog, name: 'Quarterly catalog refresh (STRY0012390)', state: 'loaded', application: 'Service Catalog', commit_date: '', collisions: '0', parent: '', description: '', sys_created_on: '2026-10-19 10:30:00', sys_updated_on: '2026-10-19 10:30:00' },
  { sys_id: IDS.portal, name: 'HR portal widget fixes (STRY0012402)', state: 'previewed', application: 'HR Portal', commit_date: '', collisions: '0', parent: '', description: '', sys_created_on: '2026-10-18 13:05:00', sys_updated_on: '2026-10-18 13:20:00' },
  { sys_id: IDS.hotfix, name: 'Old hotfix 2026-08 (STRY0011877)', state: 'committed', application: 'Global', commit_date: '2026-08-14 11:42:00', collisions: '0', parent: '', description: '', sys_created_on: '2026-08-14 09:00:00', sys_updated_on: '2026-08-14 11:42:00' },
];
const STATE_LABEL = { loaded: 'Loaded', previewed: 'Previewed', committed: 'Committed', previewing: 'Previewing' };

// ---- the records the updates are about -------------------------------------------------------------------------------

const REC = {
  rule: id('rec:rule'),
  policy: id('rec:policy'),
  utils: id('rec:utils'),
  calc: id('rec:calc'),
  costRule: id('rec:costrule'),
  guard: id('rec:guard'),
  export: id('rec:export'),
  rest: id('rec:rest'),
  rounding: id('rec:rounding'),
  tax: id('rec:tax'),
  userMissing: id('rec:user'),
  group: id('rec:group'),
  role: id('rec:role'),
  roleAdmin: id('rec:roleadmin'),
  portalWidget: id('rec:widget'),
};

// A remote update (sys_update_xml row that belongs to a retrieved set).
const U = (key, set, name, target, type, extra = {}) => ({ sys_id: id(`upd:${key}`), name, target_name: target, type, action: 'INSERT_OR_UPDATE', remote_update_set: set, update_set: '', sys_created_on: '2026-10-21 08:14:00', sys_updated_on: '2026-10-21 08:14:00', sys_updated_by: 'abel.tuter', payload: '', ...extra });

const COLLISION_PAYLOAD = (table, tag, name, by, on) => `<?xml version="1.0" encoding="UTF-8"?><record_update table="${table}"><${tag} action="INSERT_OR_UPDATE"><name>${name}</name><script><![CDATA[var ${name} = Class.create();\n${name}.prototype = { initialize: function () {}, type: '${name}' };]]></script><sys_updated_by>${by}</sys_updated_by><sys_updated_on>${on}</sys_updated_on></${tag}></record_update>`;

// A business rule whose assignment_group points at a group another retrieved set creates (the problem text does not name
// the sys_id, as on a real instance; it is read from here).
const NOTIFY_PAYLOAD = `<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script"><sys_script action="INSERT_OR_UPDATE"><name>Notify payroll approvers</name><collection>u_payroll_run</collection><assignment_group display_value="Payroll Approvers">${REC.group}</assignment_group><script><![CDATA[gs.eventQueue('payroll.approve', current);]]></script><sys_updated_by>abel.tuter</sys_updated_by><sys_updated_on>2026-10-20 15:10:00</sys_updated_on></sys_script></record_update>`;

const UPDATES = [
  U('br-notify', IDS.release, `sys_script_${REC.rule}`, 'Notify payroll approvers', 'Business Rule', { payload: NOTIFY_PAYLOAD }),
  U('up-cost', IDS.release, `sys_ui_policy_${REC.policy}`, 'Show cost center for payroll requests', 'UI Policy'),
  U('si-utils', IDS.release, `sys_script_include_${REC.utils}`, 'PayrollUtils', 'Script Include', { payload: `<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><name>PayrollUtils</name><default_approver display_value="Old Approver">${REC.userMissing}</default_approver><script><![CDATA[var PayrollUtils = Class.create();]]></script></sys_script_include></record_update>` }),
  U('si-calc', IDS.release, `sys_script_${REC.calc}`, 'Calculate payroll totals', 'Business Rule', { payload: COLLISION_PAYLOAD('sys_script', 'sys_script', 'Calculate payroll totals', 'abel.tuter', '2026-10-02 09:30:00') }),
  U('br-cost', IDS.release, `sys_script_${REC.costRule}`, 'Set cost center on incident', 'Business Rule'),
  U('br-guard', IDS.release, `sys_script_${REC.guard}`, 'Payroll run guard', 'Business Rule'),
  U('ua-export', IDS.release, `sys_ui_action_${REC.export}`, 'Old payroll export', 'UI Action', { action: 'DELETE' }),
  U('ws-run', IDS.release, `sys_ws_operation_${REC.rest}`, 'Get payroll run', 'Scripted REST Resource'),
  U('pr-round', IDS.release, `sys_properties_${REC.rounding}`, 'payroll.rounding', 'System Property', { payload: COLLISION_PAYLOAD('sys_properties', 'sys_properties', 'payroll.rounding', 'abel.tuter', '2026-09-29 11:00:00') }),
  U('si-tax', IDS.release, `sys_script_include_${REC.tax}`, 'TaxHelper', 'Script Include', { payload: COLLISION_PAYLOAD('sys_script_include', 'sys_script_include', 'TaxHelper', 'abel.tuter', '2026-09-30 15:20:00') }),
  // What the other sets create.
  U('grp', IDS.groups, `sys_user_group_${REC.group}`, 'Payroll Approvers', 'Group'),
  U('grp-br', IDS.groups, `sys_script_${id('rec:grpbr')}`, 'Restrict payroll approver access', 'Business Rule'),
  U('role-admin', IDS.data, `sys_user_role_${REC.roleAdmin}`, 'payroll_admin', 'Role'),
  U('dict-cost', IDS.data, 'sys_dictionary_incident_u_cost_center', 'incident.u_cost_center', 'Dictionary Entry'),
  U('dict-run', IDS.data, 'sys_dictionary_u_payroll_run_null', 'u_payroll_run', 'Dictionary Entry'),
  U('dict-run-period', IDS.data, 'sys_dictionary_u_payroll_run_u_period', 'u_payroll_run.u_period', 'Dictionary Entry'),
  U('widget', IDS.portal, `sp_widget_${REC.portalWidget}`, 'Leave balance', 'Widget'),
  // Local update entries (they belong to a local update set, not a retrieved one).
  { sys_id: id('upd:local-calc'), name: `sys_script_${REC.calc}`, target_name: 'Calculate payroll totals', type: 'Business Rule', action: 'INSERT_OR_UPDATE', remote_update_set: '', update_set: id('localset:hotfix'), update_set_name: 'Payroll hotfix (STRY0012455)', sys_created_on: '2026-10-18 14:02:00', sys_updated_on: '2026-10-18 14:02:00', sys_updated_by: 'beth.anglin', payload: '' },
];
const updateId = (key) => id(`upd:${key}`);

// ---- the problems --------------------------------------------------------------------------------------------------

// The columns are the real ones (confirmed live 2026-10-23): the platform records the missing item, its table, the update
// that would provide it and the actions it offers. Their VALUES here are made up: the PDI had no retrieved set to look at,
// so the format of available_actions in particular is a guess (the panel shows it as given).
const P = (key, set, update, type, description, status = '', extra = {}) => ({ sys_id: id(`prob:${key}`), remote_update_set: set, remote_update: update ? updateId(update) : '', type, description, status, missing_item: '', missing_item_table: '', missing_item_update: '', available_actions: status ? '' : 'skip,accept', sys_created_on: '2026-10-22 16:38:00', sys_updated_on: '2026-10-22 16:38:00', sys_updated_by: 'admin', ...extra });
const PROBLEMS = [
  // The platform's own wording (no sys_id in the text). The instance names the missing group and the update that creates it.
  P('1', IDS.release, 'br-notify', 'Error', 'Could not find a record in sys_user_group for column assignment_group referenced in this update', '', { missing_item: REC.group, missing_item_table: 'sys_user_group', missing_item_update: updateId('grp') }),
  // missing_item only: the provider is found by searching the other sets for the sys_id.
  P('2', IDS.release, 'up-cost', 'Error', `Reference to sys_user_role with sys_id ${REC.roleAdmin} does not exist (field: roles)`, '', { missing_item: REC.roleAdmin, missing_item_table: 'sys_user_role' }),
  // Nothing recorded in the missing_item columns: the sys_id is read from the remote update (the fallback).
  P('3', IDS.release, 'si-utils', 'Error', 'Could not find a record in sys_user for column default_approver referenced in this update'),
  P('4', IDS.release, 'si-calc', 'Warning', 'Found a local update that is newer than this one'),
  P('5', IDS.release, 'br-cost', 'Error', 'Could not find a table field (incident.u_cost_center) referenced in this update'),
  P('6', IDS.release, 'br-guard', 'Error', "Table 'u_payroll_run' does not exist"),
  P('7', IDS.release, 'ua-export', 'Warning', 'The remote update deletes a record that does not exist on this instance', '', { available_actions: 'skip' }),
  P('8', IDS.release, 'ws-run', 'Error', 'Remote payload hash differs from the stored hash; the update may have been edited after it was retrieved'),
  P('9', IDS.release, 'pr-round', 'Warning', 'Found a local update to this record that is newer than the remote update', 'Skipped Remote Update'),
  P('10', IDS.release, 'si-tax', 'Warning', 'Found a local update to this record that is newer than the remote update', 'Accepted Remote Update'),
  P('11', IDS.groups, 'grp-br', 'Error', `Could not find a record in sys_user_role with sys_id ${REC.roleAdmin}`),
  P('12', IDS.hotfix, null, 'Warning', 'Found a local update to this record that is newer than the remote update', 'Skipped Remote Update'),
  P('13', IDS.hotfix, null, 'Warning', 'Found a local update to this record that is newer than the remote update', 'Skipped Remote Update'),
  P('14', IDS.hotfix, null, 'Warning', 'Found a local update to this record that is newer than the remote update', 'Accepted Remote Update'),
];

// ---- dictionary ----------------------------------------------------------------------------------------------------

const D = (name, element, label, type, reference = '') => ({ name, element, column_label: label, internal_type: type, reference, max_length: '', mandatory: 'false', read_only: 'false', default_value: '', active: 'true', unique: 'false', display: 'false', choice: '0', calculation: '', attributes: '', array: 'false', audit: 'false', primary: 'false' });
const DICTIONARY = {
  sys_update_preview_problem: [
    D('sys_update_preview_problem', 'sys_id', 'Sys ID', 'GUID'),
    D('sys_update_preview_problem', 'remote_update_set', 'Remote update set', 'reference', 'sys_remote_update_set'),
    D('sys_update_preview_problem', 'remote_update', 'Remote update', 'reference', 'sys_update_xml'),
    D('sys_update_preview_problem', 'type', 'Type', 'string'),
    D('sys_update_preview_problem', 'description', 'Description', 'string'),
    D('sys_update_preview_problem', 'status', 'Status', 'string'),
    // Confirmed live: these four columns exist. Their types are not confirmed; missing_item_update is drawn as a reference
    // to sys_update_xml here (the code also accepts an update name in it).
    D('sys_update_preview_problem', 'missing_item', 'Missing item', 'string'),
    D('sys_update_preview_problem', 'missing_item_table', 'Missing item table', 'table_name'),
    D('sys_update_preview_problem', 'missing_item_update', 'Missing item update', 'reference', 'sys_update_xml'),
    D('sys_update_preview_problem', 'available_actions', 'Available actions', 'string'),
    D('sys_update_preview_problem', 'sys_created_on', 'Created', 'glide_date_time'),
    D('sys_update_preview_problem', 'sys_updated_on', 'Updated', 'glide_date_time'),
    D('sys_update_preview_problem', 'sys_updated_by', 'Updated by', 'string'),
  ],
  // The real column list (confirmed live 2026-10-23); there is no "loaded" column.
  sys_remote_update_set: ['sys_id', 'application', 'application_name', 'application_scope', 'application_version', 'collisions', 'commit_date', 'deleted', 'description', 'inserted', 'name', 'origin_sys_id', 'parent', 'release_date', 'remote_base_update_set', 'remote_parent_id', 'remote_sys_id', 'state', 'summary', 'update_set', 'update_source', 'updated', 'sys_created_on', 'sys_updated_on'].map((e) => D('sys_remote_update_set', e, e, e === 'parent' ? 'reference' : 'string', e === 'parent' ? 'sys_remote_update_set' : '')),
  sys_update_xml: ['sys_id', 'name', 'type', 'target_name', 'action', 'update_set', 'remote_update_set', 'payload', 'sys_created_on', 'sys_updated_on', 'sys_updated_by'].map((e) => D('sys_update_xml', e, e, e === 'update_set' ? 'reference' : e === 'remote_update_set' ? 'reference' : 'string', e === 'update_set' ? 'sys_update_set' : e === 'remote_update_set' ? 'sys_remote_update_set' : '')),
};

// ---- local state of the colliding records ----------------------------------------------------------------------------

const LOCAL_RECORDS = {
  [REC.calc]: { sys_updated_on: '2026-10-18 14:02:00', sys_updated_by: 'beth.anglin' },
  [REC.rounding]: { sys_updated_on: '2026-10-10 09:15:00', sys_updated_by: 'admin' },
  [REC.tax]: { sys_updated_on: '2026-10-05 12:40:00', sys_updated_by: 'beth.anglin' },
};
const VERSIONS = [
  { name: `sys_script_${REC.calc}`, sys_recorded_at: '2026-10-18 14:02:00', sys_created_by: 'beth.anglin', source: 'Payroll hotfix (STRY0012455)' },
  { name: `sys_script_${REC.calc}`, sys_recorded_at: '2026-09-12 10:30:00', sys_created_by: 'abel.tuter', source: 'Payroll release 3 (STRY0012311)' },
];

// ---- a very small query engine ---------------------------------------------------------------------------------------

function parseQuery(query) {
  const clauses = [];
  let order = null;
  String(query || '')
    .split('^')
    .filter(Boolean)
    .forEach((part) => {
      const ob = /^ORDERBY(DESC)?([a-z_.]+)$/.exec(part);
      if (ob) {
        order = { field: ob[2], desc: Boolean(ob[1]) };
        return;
      }
      const m = /^([a-z_.]+?)(ISEMPTY|ISNOTEMPTY|IN|LIKE|STARTSWITH|=)(.*)$/.exec(part);
      if (m) clauses.push({ field: m[1], op: m[2], value: m[3] });
      else clauses.push({ field: '', op: 'UNSUPPORTED', value: part });
    });
  return { clauses, order };
}

function matches(row, { field, op, value }) {
  const have = String(row[field] ?? '');
  switch (op) {
    case '=':
      return have === value;
    case 'IN':
      return value.split(',').includes(have);
    case 'LIKE':
      return have.toLowerCase().includes(value.toLowerCase());
    case 'STARTSWITH':
      return have.toLowerCase().startsWith(value.toLowerCase());
    case 'ISEMPTY':
      return have === '';
    case 'ISNOTEMPTY':
      return have !== '';
    default:
      return true;
  }
}

function select(rows, query) {
  const { clauses, order } = parseQuery(query);
  let out = rows.filter((row) => clauses.every((c) => matches(row, c)));
  if (order) out = [...out].sort((a, b) => String(a[order.field] ?? '').localeCompare(String(b[order.field] ?? '')) * (order.desc ? -1 : 1));
  return out;
}

/** What a cell shows: references show a name, choices their label. */
function displayOf(table, field, row) {
  const v = row[field];
  if (table === 'sys_update_preview_problem') {
    if (field === 'remote_update_set') return SETS.find((s) => s.sys_id === v)?.name || v;
    if (field === 'remote_update') return UPDATES.find((u) => u.sys_id === v)?.target_name || v;
    if (field === 'missing_item_update') return UPDATES.find((u) => u.sys_id === v)?.name || v;
  }
  if (table === 'sys_remote_update_set' && field === 'state') return STATE_LABEL[v] || v;
  if (table === 'sys_update_xml') {
    if (field === 'update_set') return row.update_set_name || v;
    if (field === 'remote_update_set') return SETS.find((s) => s.sys_id === v)?.name || v;
  }
  return v ?? '';
}

function project(table, row, fields, mode) {
  const names = fields.length ? fields : Object.keys(row).filter((k) => k !== 'update_set_name');
  const out = {};
  names.forEach((f) => {
    if (!(f in row) && !f.includes('.')) return;
    const raw = f.includes('.') ? '' : row[f] ?? '';
    if (mode === 'all') out[f] = { value: raw, display_value: displayOf(table, f, row) };
    else if (mode === 'true') out[f] = displayOf(table, f, row);
    else out[f] = raw;
  });
  return out;
}

function listAnswer(table, rows, params) {
  const fields = (params.get('sysparm_fields') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const mode = params.get('sysparm_display_value') || 'false';
  const offset = Number(params.get('sysparm_offset') || 0);
  const limit = Number(params.get('sysparm_limit') || 10000);
  return json({ result: select(rows, params.get('sysparm_query') || '').slice(offset, offset + limit).map((r) => project(table, r, fields, mode)) });
}

// ---- routes ----------------------------------------------------------------------------------------------------------

const MINE = new Set(['sys_update_preview_problem', 'sys_remote_update_set', 'sys_update_xml']);
const ALL_IDS = new Set([...UPDATES.map((u) => u.sys_id), ...Object.values(REC)]);

/** Is every sys_id a query asks for one of this fixture's? (The shared fake owns all other sys_update_xml rows.) */
function askedForMine(query) {
  const ids = [];
  String(query || '')
    .split('^')
    .forEach((part) => {
      const m = /^sys_id(?:=|IN)(.*)$/.exec(part);
      if (m) ids.push(...m[1].split(','));
    });
  return ids.length > 0 && ids.every((x) => ALL_IDS.has(x));
}

// Answers only when the preview is opened on this panel (?open=previewfix), like the data model fixture, so other panels' fake data is left alone.
const enabled = () => globalThis.__PREVIEWFIX_FIXTURE__ === true || (typeof location !== 'undefined' && new URLSearchParams(location.search).get('open') === 'previewfix');

export function route(method, url) {
  if (method !== 'GET' || !enabled()) return null;
  const path = url.pathname;
  const params = url.searchParams;
  const query = params.get('sysparm_query') || '';
  const kind = variant();
  let m;

  if ((m = /^\/api\/now\/table\/([^/]+)$/.exec(path))) {
    const table = decodeURIComponent(m[1]);

    if (table === 'sys_db_object') {
      const name = /^name=(.+)$/.exec(query)?.[1];
      if (name && MINE.has(name)) return json({ result: [{ 'super_class.name': '' }] });
      return null;
    }
    if (table === 'sys_dictionary') {
      const first = /^nameIN([a-z_]+)\^/.exec(query)?.[1];
      if (first && MINE.has(first) && !/^nameIN[a-z_]+,/.test(query)) {
        if (first === 'sys_update_preview_problem' && kind === 'nodict') return json({ result: [] });
        if (first === 'sys_update_xml' && kind === 'noprovider') return json({ result: DICTIONARY[first].filter((d) => d.element !== 'remote_update_set').map((r) => project(table, r, (params.get('sysparm_fields') || '').split(','), 'false')) });
        return json({ result: DICTIONARY[first].map((r) => project(table, r, (params.get('sysparm_fields') || '').split(',').filter(Boolean), 'false')) });
      }
      return null;
    }
    if (table === 'sys_remote_update_set') return listAnswer(table, SETS, params);
    if (table === 'sys_update_preview_problem') {
      if (kind === 'denied') return failure(403, 'User Not Authorized');
      return listAnswer(table, PROBLEMS, params);
    }
    if (table === 'sys_update_xml') {
      if (/remote_update_set/.test(query) || askedForMine(query)) {
        if (/remote_update_set/.test(query) && kind === 'noprovider') return null;
        return listAnswer(table, UPDATES, params);
      }
      return null;
    }
    if (table === 'sys_update_version') {
      const name = /^name=([a-z0-9_]+)/.exec(query)?.[1];
      if (name && VERSIONS.some((v) => v.name === name)) return listAnswer(table, VERSIONS, params);
      return null;
    }
    // The record behind a colliding update (read for its last change).
    const sysId = /^sys_id=([0-9a-f]{32})$/.exec(query)?.[1];
    if (sysId && LOCAL_RECORDS[sysId]) return listAnswer(table, [{ sys_id: sysId, ...LOCAL_RECORDS[sysId] }], params);
    return null;
  }

  if ((m = /^\/api\/now\/stats\/sys_update_preview_problem$/.exec(path))) {
    if (kind === 'denied') return failure(403, 'User Not Authorized');
    const group = params.get('sysparm_group_by');
    const rows = select(PROBLEMS, query);
    if (!group) return json({ result: { stats: { count: String(rows.length) } } });
    const counts = new Map();
    rows.forEach((r) => counts.set(r[group], (counts.get(r[group]) || 0) + 1));
    return json({ result: [...counts.entries()].map(([value, count]) => ({ stats: { count: String(count) }, groupby_fields: [{ field: group, value, display_value: displayOf('sys_update_preview_problem', group, { [group]: value }) }] })) });
  }
  return null;
}

