// Dev-only fake instance data for the Self-check panel (see preview/fixtures/index.js).
//
// It answers the Self-check's own reads: the batched sys_db_object / sys_dictionary lookups, the one-row table probes
// and the background-script probe. The dictionary is generated from the requirement lists, so every table and column
// any tool asks for exists, EXCEPT these on purpose, so every state shows up in the panel:
//
//   table not installed        sys_outbound_http_log, sys_hub_flow_run, the sys_atf_* tables   (tools: works with gaps)
//   table refused (403)        sys_security_acl                                                (Access debugger: will not work)
//   table busy (503)           task_sla                                                        (Save trace: not fully checked)
//   required column missing    sys_update_version.sys_recorded_at                              (Version history: will not work)
//   optional column missing    syslog_transaction.business_rule_time                           (Hot spots: works with gaps)
//   column hidden from you     sys_audit.reason  (in the dictionary, not returned)              (History of a field: works with gaps)
//
// Only the Self-check's own request shapes are answered (a long table list, a limit of 400 or 1000, the pagination
// header switch); every other panel's reads fall through to preview/fakeInstance.js.

import { ALL_REQUIREMENTS } from '../../src/lib/requirements/index.js';
import { planTables } from '../../src/lib/doctor.js';

const MISSING_TABLES = new Set(['sys_outbound_http_log', 'sys_hub_flow_run', 'sys_atf_step', 'sys_atf_test', 'sys_atf_test_result', 'sys_atf_test_suite_test', 'sys_atf_test_suite', 'sys_atf_test_suite_result']);
const DENIED_TABLES = new Set(['sys_security_acl']);
const BUSY_TABLES = new Set(['task_sla']);
const MISSING_COLUMNS = new Set(['sys_update_version.sys_recorded_at', 'syslog_transaction.business_rule_time']);
const HIDDEN_COLUMNS = new Set(['sys_audit.reason']);

const TASK_CHILDREN = new Set(['incident', 'problem', 'change_request', 'sc_req_item', 'sc_task', 'sc_request']);
const METADATA_CHILDREN = new Set(['sys_script', 'sys_script_include', 'sys_script_client', 'sys_ui_action', 'sys_ui_policy', 'sys_security_acl', 'sys_ui_script', 'sysevent_script_action', 'sys_transform_script', 'sys_ws_operation', 'sys_data_policy2', 'sp_widget']);
const PARENT_OVERRIDES = { catalog_script_client: 'sys_script_client', catalog_ui_policy: 'sys_ui_policy' };
const OWNED_BY_PARENT = {
  task: ['number', 'short_description', 'description', 'state', 'priority', 'active', 'assigned_to', 'assignment_group', 'parent', 'sys_class_name', 'opened_at'],
  sys_metadata: ['sys_name', 'sys_scope', 'sys_package', 'sys_policy', 'sys_update_name'],
};

const parentOf = (table) => PARENT_OVERRIDES[table] || (TASK_CHILDREN.has(table) ? 'task' : METADATA_CHILDREN.has(table) ? 'sys_metadata' : /^cmdb_ci_/.test(table) ? 'cmdb_ci' : '');

const base = (name) => String(name).split('.')[0];

// table -> Set of the columns the tools ask for
const wanted = new Map();
const plan = planTables(ALL_REQUIREMENTS);
plan.tables.forEach((t) => wanted.set(t, new Set(plan.columns[t])));

/** Every table that exists in this fake instance (the ones asked for, minus the missing ones, plus their parents). */
const universe = new Set();
plan.tables.filter((t) => !MISSING_TABLES.has(t)).forEach((t) => {
  universe.add(t);
  const parent = parentOf(t);
  if (parent) universe.add(parent);
});

// table -> Set of columns it owns in the dictionary. A child's column goes to the parent when the parent owns it.
const owned = new Map([...universe].map((t) => [t, new Set()]));
wanted.forEach((columns, table) => {
  if (!universe.has(table)) return;
  const parent = parentOf(table);
  columns.forEach((column) => {
    if (MISSING_COLUMNS.has(`${table}.${column}`)) return;
    const parentOwns = parent && (OWNED_BY_PARENT[parent]?.includes(column) || (wanted.get(parent)?.has(column) && !MISSING_COLUMNS.has(`${parent}.${column}`)));
    owned.get(parentOwns ? parent : table).add(column);
  });
});

const chain = (table) => {
  const out = [];
  for (let t = table; t && !out.includes(t) && out.length < 8; t = parentOf(t)) out.push(t);
  return out;
};
const columnsOf = (table) => new Set(chain(table).flatMap((t) => [...(owned.get(t) || [])]));

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const failure = (status, message, detail = null) => json(status, { error: { message, detail }, status: 'failure' });

const listOf = (query, key) => {
  const m = new RegExp(`(?:^|\\^)${key}IN([^^]+)`).exec(query);
  return m ? m[1].split(',').filter(Boolean) : [];
};

export function route(method, url, body) {
  // Only on the Self-check preview page: its dictionary answers must not leak into the other panels' previews.
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('open') !== 'doctor') return null;
  if (method === 'POST' && url.pathname === '/sys.scripts.do' && String(body || '').includes('NOWBUDDY_SELFCHECK_OK')) {
    return new Response('<HTML><BODY>[0:00:00.011] Script completed in scope global: script<HR/><PRE>*** Script: NOWBUDDY_SELFCHECK_OK<BR/></PRE><HR/></BODY></HTML>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  }
  if (method !== 'GET') return null;
  const m = /^\/api\/now\/table\/([^/]+)$/.exec(url.pathname);
  if (!m) return null;
  const table = decodeURIComponent(m[1]);
  const query = url.searchParams.get('sysparm_query') || '';
  const fields = url.searchParams.get('sysparm_fields') || '';

  // The hierarchy lookup: sys_db_object by a long list of names (and the parents of those, in shorter lists).
  if (table === 'sys_db_object' && fields === 'name,super_class.name' && url.searchParams.get('sysparm_limit') === '400') {
    const names = listOf(query, 'name');
    if (!names.length) return null;
    return json(200, { result: names.filter((n) => universe.has(n)).map((n) => ({ name: n, 'super_class.name': parentOf(n) })) });
  }

  // The column lookup: sys_dictionary by many table names and column names.
  if (table === 'sys_dictionary' && fields === 'name,element' && url.searchParams.get('sysparm_limit') === '1000') {
    const names = listOf(query, 'name');
    const elements = new Set(listOf(query, 'element'));
    if (names.length < 8 || !elements.size) return null;
    return json(200, { result: names.filter((n) => owned.has(n)).flatMap((n) => [...owned.get(n)].filter((c) => elements.has(c)).map((c) => ({ name: n, element: c }))) });
  }

  // The one-row probe of a table.
  if (url.searchParams.get('sysparm_suppress_pagination_header') === 'true' && url.searchParams.get('sysparm_limit') === '1' && wanted.has(table)) {
    if (MISSING_TABLES.has(table)) return failure(400, `Invalid table ${table}`);
    if (DENIED_TABLES.has(table)) return failure(403, 'User Not Authorized', 'Insufficient rights to query records');
    if (BUSY_TABLES.has(table)) return failure(503, 'Service temporarily unavailable');
    const have = columnsOf(table);
    const row = Object.fromEntries(fields.split(',').filter((f) => f === 'sys_id' || (have.has(base(f)) && !HIDDEN_COLUMNS.has(`${table}.${f}`))).map((f) => [f, '']));
    return json(200, { result: [row] });
  }
  return null;
}
