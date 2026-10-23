// Dev-only (not shipped): fake instance answers for the Flows, approvals and SLAs panel (src/sidebar/ProcessPanel.jsx).
// Answers only the queries that panel makes (flows, approvals, SLAs, tasks, workflow, events, and the data dictionary
// reads that come first) and returns null for everything else, so other panels keep their own data.
//
// The page record (the incident INC0010042, sys_id 9de5069c...) is stuck in five different ways: a failed flow, a flow that
// is running, a pending approval from a person, a breached SLA, and a legacy workflow that has sat on a wait for 40 days.
// Open the panel with ?proc=<variant> in the preview URL to see the other states:
//   quiet    finished flow, approved approval, met SLA, no workflow: "Nothing is running"
//   running  only a flow that started a few minutes ago
//   denied   approvals and events answer 403 (the section says it could not be read)
//   nowf     the legacy workflow tables are not on the instance
//   nodict   the data dictionary cannot be read (nothing is checked first)
//   filter   the flow table ignores the condition and returns other records' rows
//   events   adds events that have been waiting to be processed
//   empty    nothing has ever run against the record (other records do have rows, so the tables are visible)
//   many     twelve more finished flows (the Show more button)
//   hidden   the quiet record, but flows, approvals and workflows sit behind an ACL: every read of those tables answers
//            200 with no rows, which must read as "could not tell", never as "nothing is running"

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const failure = (status, message) => json({ error: { message, detail: null }, status: 'failure' }, status);

const INCIDENT_ID = '9de5069c0b0f0300b8b9e5cd35673a5b';
const hex = (n) => `0000${n.toString(16)}`.slice(-4).repeat(8);
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const stamp = (ms) => new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);

// A field is a plain string, or [value, display value] for references and choices.
const f = (value, display) => [String(value), display === undefined ? String(value) : display];
const valueOf = (v) => (Array.isArray(v) ? v[0] : v == null ? '' : String(v));
const displayOf = (v) => (Array.isArray(v) ? v[1] : v == null ? '' : String(v));

function data() {
  const flowContext = [
    {
      sys_id: hex(0x101), name: 'Notify assignment group', state: f('ERROR', 'Error'), source_table: 'incident', source_record: INCIDENT_ID,
      error_message: 'Step "Look Up Manager" failed: Value for data pill [Trigger - Incident Updated.Incident Record.Assigned to.Manager] is null',
      started: stamp(2 * DAY + 8000), ended: stamp(2 * DAY), sys_created_on: stamp(2 * DAY + 8000), sys_updated_on: stamp(2 * DAY),
    },
    {
      sys_id: hex(0x102), name: 'Update priority from impact', state: f('IN_PROGRESS', 'In Progress'), source_table: 'incident', source_record: INCIDENT_ID,
      started: stamp(4 * MIN), sys_created_on: stamp(4 * MIN), sys_updated_on: stamp(4 * MIN - 1000),
    },
    {
      sys_id: hex(0x103), name: 'Set SLA targets', state: f('COMPLETE', 'Complete'), source_table: 'incident', source_record: INCIDENT_ID,
      started: stamp(6 * HOUR), ended: stamp(6 * HOUR - 2000), sys_created_on: stamp(6 * HOUR), sys_updated_on: stamp(6 * HOUR - 2000),
    },
    {
      sys_id: hex(0x104), name: 'Notify assignment group', state: f('COMPLETE', 'Complete'), source_table: 'incident', source_record: INCIDENT_ID,
      started: stamp(12 * DAY), ended: stamp(12 * DAY - 3000), sys_created_on: stamp(12 * DAY), sys_updated_on: stamp(12 * DAY - 3000),
    },
  ];
  const flowLog = [
    { sys_id: hex(0x201), context: hex(0x101), level: 'Info', message: 'Flow "Notify assignment group" started', sys_created_on: stamp(2 * DAY + 8000) },
    { sys_id: hex(0x202), context: hex(0x101), level: 'Info', message: 'Action "Look Up Record" (sys_user) completed', sys_created_on: stamp(2 * DAY + 6000) },
    { sys_id: hex(0x203), context: hex(0x101), level: 'Error', message: 'Action "Look Up Manager" failed: data pill is null', sys_created_on: stamp(2 * DAY + 1000) },
  ];
  const approver = [
    {
      sys_id: hex(0x301), approver: f(hex(0x901), 'Abel Tuter'), state: f('requested', 'Requested'), sysapproval: INCIDENT_ID, document_id: INCIDENT_ID,
      group: f('', ''), comments: '', due_date: '', sys_created_on: stamp(3 * DAY + HOUR), sys_updated_on: stamp(3 * DAY),
    },
    {
      sys_id: hex(0x302), approver: f(hex(0x902), 'Beth Anglin'), state: f('approved', 'Approved'), sysapproval: INCIDENT_ID, document_id: INCIDENT_ID,
      group: f(hex(0x911), 'Service Desk'), comments: 'Fine by me, go ahead with the swap.', due_date: '', sys_created_on: stamp(5 * DAY + HOUR), sys_updated_on: stamp(5 * DAY),
    },
  ];
  const sla = [
    {
      sys_id: hex(0x401), sla: f(hex(0x921), 'P1 resolution 4h'), stage: f('in_progress', 'In progress'), has_breached: 'true', percentage: '118', business_percentage: '118',
      planned_end_time: stamp(2 * HOUR), start_time: stamp(6 * HOUR), end_time: '', pause_time: '', task: INCIDENT_ID, sys_created_on: stamp(6 * HOUR), sys_updated_on: stamp(2 * HOUR),
    },
    {
      sys_id: hex(0x402), sla: f(hex(0x922), 'P1 response 15m'), stage: f('achieved', 'Achieved'), has_breached: 'false', percentage: '40', business_percentage: '40',
      planned_end_time: stamp(6 * HOUR - 15 * MIN), start_time: stamp(6 * HOUR), end_time: stamp(6 * HOUR - 6 * MIN), pause_time: '', task: INCIDENT_ID, sys_created_on: stamp(6 * HOUR), sys_updated_on: stamp(6 * HOUR - 6 * MIN),
    },
  ];
  const task = [
    {
      sys_id: hex(0x501), number: 'INC0010050', short_description: 'Docking station dead (affected by the same fault)', state: f('2', 'In Progress'), active: 'true', sys_class_name: f('incident', 'Incident'),
      assigned_to: f(hex(0x903), 'Carol Coughlin'), assignment_group: f(hex(0x912), 'Hardware'), parent: INCIDENT_ID, sys_created_on: stamp(5 * HOUR), sys_updated_on: stamp(2 * HOUR),
    },
    {
      sys_id: hex(0x502), number: 'INC0010047', short_description: 'Loan laptop for the caller', state: f('7', 'Closed'), active: 'false', sys_class_name: f('incident', 'Incident'),
      assigned_to: f(hex(0x904), 'Dave Loo'), assignment_group: f(hex(0x912), 'Hardware'), parent: INCIDENT_ID, sys_created_on: stamp(5 * HOUR), sys_updated_on: stamp(4 * HOUR),
    },
  ];
  const wfContext = [
    { sys_id: hex(0x601), workflow_version: f(hex(0x931), 'Incident escalation'), name: 'Incident escalation', table: 'incident', id: INCIDENT_ID, state: f('executing', 'Executing'), started: stamp(40 * DAY), ended: '', sys_created_on: stamp(40 * DAY), sys_updated_on: stamp(40 * DAY) },
    { sys_id: hex(0x602), workflow_version: f(hex(0x932), 'Legacy P1 notify'), name: 'Legacy P1 notify', table: 'incident', id: INCIDENT_ID, state: f('finished', 'Finished'), started: stamp(60 * DAY), ended: stamp(60 * DAY - 9000), sys_created_on: stamp(60 * DAY), sys_updated_on: stamp(60 * DAY - 9000) },
  ];
  const wfExecuting = [
    { sys_id: hex(0x701), context: hex(0x601), activity: f(hex(0x941), 'Wait for change approval'), 'activity.activity_definition': f(hex(0x951), 'Approval - Group'), state: f('executing', 'Executing'), started: stamp(40 * DAY), sys_created_on: stamp(40 * DAY) },
  ];
  const wfHistory = [
    { sys_id: hex(0x801), context: hex(0x601), activity: f(hex(0x942), 'Begin'), activity_index: '0', state: f('finished', 'Finished'), result: 'success', started: stamp(40 * DAY), ended: stamp(40 * DAY - 100), fault_description: '', sys_created_on: stamp(40 * DAY) },
    { sys_id: hex(0x802), context: hex(0x601), activity: f(hex(0x943), 'Set priority to 1'), activity_index: '1', state: f('finished', 'Finished'), result: 'success', started: stamp(40 * DAY - 100), ended: stamp(40 * DAY - 300), fault_description: '', sys_created_on: stamp(40 * DAY - 100) },
    { sys_id: hex(0x803), context: hex(0x601), activity: f(hex(0x944), 'Notify duty manager'), activity_index: '2', state: f('finished', 'Finished'), result: 'success', started: stamp(40 * DAY - 300), ended: stamp(40 * DAY - 900), fault_description: '', sys_created_on: stamp(40 * DAY - 300) },
    { sys_id: hex(0x804), context: hex(0x601), activity: f(hex(0x941), 'Wait for change approval'), activity_index: '3', state: f('executing', 'Executing'), result: '', started: stamp(40 * DAY - 900), ended: '', fault_description: '', sys_created_on: stamp(40 * DAY - 900) },
    { sys_id: hex(0x805), context: hex(0x602), activity: f(hex(0x945), 'Begin'), activity_index: '0', state: f('finished', 'Finished'), result: 'success', started: stamp(60 * DAY), ended: stamp(60 * DAY - 500), fault_description: '', sys_created_on: stamp(60 * DAY) },
    { sys_id: hex(0x806), context: hex(0x602), activity: f(hex(0x946), 'End'), activity_index: '1', state: f('finished', 'Finished'), result: 'success', started: stamp(60 * DAY - 500), ended: stamp(60 * DAY - 9000), fault_description: '', sys_created_on: stamp(60 * DAY - 500) },
  ];
  const events = [];
  return { sys_flow_context: flowContext, sys_flow_log: flowLog, sysapproval_approver: approver, sysapproval_group: [], task_sla: sla, task, sc_task: [], sc_req_item: [], change_task: [], problem_task: [], wf_context: wfContext, wf_executing: wfExecuting, wf_history: wfHistory, sysevent: events };
}

const HIDDEN = ['sys_flow_context', 'sysapproval_approver', 'wf_context'];

function variant(name, rows) {
  const out = { ...rows };
  if (name === 'quiet' || name === 'hidden') {
    out.sys_flow_context = rows.sys_flow_context.filter((r) => valueOf(r.state) === 'COMPLETE');
    out.sysapproval_approver = rows.sysapproval_approver.filter((r) => valueOf(r.state) === 'approved');
    out.task_sla = rows.task_sla.filter((r) => valueOf(r.stage) === 'achieved');
    out.task = rows.task.filter((r) => r.active === 'false');
    out.wf_context = rows.wf_context.filter((r) => valueOf(r.state) === 'finished');
    out.wf_executing = [];
  }
  if (name === 'hidden') HIDDEN.forEach((t) => (out[t] = []));
  if (name === 'running') {
    out.sys_flow_context = rows.sys_flow_context.filter((r) => valueOf(r.state) === 'IN_PROGRESS');
    out.sysapproval_approver = [];
    out.task_sla = [];
    out.task = [];
    out.wf_context = [];
    out.wf_executing = [];
  }
  if (name === 'events') {
    out.sysevent = [
      { sys_id: hex(0x901), name: 'incident.assigned', state: f('ready', 'Ready'), queue: 'default', instance: INCIDENT_ID, process_on: stamp(25 * MIN), sys_created_on: stamp(25 * MIN) },
      { sys_id: hex(0x902), name: 'incident.commented', state: f('ready', 'Ready'), queue: 'default', instance: INCIDENT_ID, process_on: stamp(2 * MIN), sys_created_on: stamp(2 * MIN) },
    ];
  }
  if (name === 'many') {
    for (let i = 0; i < 12; i += 1) {
      out.sys_flow_context = [...out.sys_flow_context, { sys_id: hex(0x1100 + i), name: `Nightly sync step ${i + 1}`, state: f('COMPLETE', 'Complete'), source_table: 'incident', source_record: INCIDENT_ID, started: stamp((14 + i) * DAY), ended: stamp((14 + i) * DAY - 1000), sys_created_on: stamp((14 + i) * DAY), sys_updated_on: stamp((14 + i) * DAY - 1000) }];
    }
  }
  if (name === 'empty') {
    Object.keys(out).forEach((k) => {
      out[k] = [];
    });
  }
  return out;
}

// The dictionary: the tables the panel reads and the columns it puts in a condition.
const TABLES = {
  incident: 'task', task: '', sys_user: '', sc_request: 'task', sc_req_item: 'task', sc_task: 'task', change_request: 'task', change_task: 'task', problem: 'task', problem_task: 'task',
  sysapproval_group: 'task', task_sla: 'task', sys_flow_context: '', sys_flow_log: '', sysapproval_approver: '', wf_context: '', wf_executing: '', wf_history: '', sysevent: '',
};
const COLUMNS = {
  sys_flow_context: ['source_record'], sys_flow_log: ['context', 'message'], sysapproval_approver: ['sysapproval', 'document_id'], task: ['parent'], task_sla: ['task'],
  sc_task: ['request_item'], sc_req_item: ['request'], change_task: ['change_request'], problem_task: ['problem'], wf_context: ['id'], wf_executing: ['context'], wf_history: ['context'], sysevent: ['instance', 'state'],
};

/** "a=1^ORb=2^c=3^ORDERBYx" -> [[a=1, b=2], [c=3]] */
function groups(query) {
  const out = [];
  String(query || '').split('^').forEach((part) => {
    if (!part || part.startsWith('ORDERBY')) return;
    if (part.startsWith('OR') && out.length) out[out.length - 1].push(part.slice(2));
    else out.push([part]);
  });
  return out;
}
function matches(row, condition) {
  let m = /^([a-z_.]+)IN(.*)$/.exec(condition);
  if (m) return m[2].split(',').includes(valueOf(row[m[1]]));
  m = /^([a-z_.]+)=(.*)$/.exec(condition);
  if (m) return valueOf(row[m[1]]) === m[2];
  return true;
}
const select = (rows, query) => rows.filter((row) => groups(query).every((g) => g.some((c) => matches(row, c))));

function project(row, fields, mode) {
  const wanted = fields.length ? fields : Object.keys(row);
  const out = {};
  wanted.forEach((name) => {
    if (!(name in row)) return;
    out[name] = mode === 'all' ? { value: valueOf(row[name]), display_value: displayOf(row[name]) } : valueOf(row[name]);
  });
  return out;
}

export function route(method, url) {
  if (method !== 'GET') return null;
  const m = /^\/api\/now\/table\/([^/]+)$/.exec(url.pathname);
  if (!m) return null;
  const table = decodeURIComponent(m[1]);
  const query = url.searchParams.get('sysparm_query') || '';
  const fields = (url.searchParams.get('sysparm_fields') || '').split(',').filter(Boolean);
  const mode = url.searchParams.get('sysparm_display_value') || 'false';
  const limit = Number(url.searchParams.get('sysparm_limit') || 1000);
  const mine = new URLSearchParams(typeof location === 'object' ? location.search : '').get('proc') || '';

  // The dictionary reads that come first.
  if (table === 'sys_db_object' && /^nameIN/.test(query) && /sys_flow_context/.test(query)) {
    if (mine === 'nodict') return json({ result: [] });
    const names = query.replace(/^nameIN/, '').split('^')[0].split(',');
    const gone = mine === 'nowf' ? ['wf_context', 'wf_executing', 'wf_history'] : [];
    return json({ result: names.filter((n) => n in TABLES && !gone.includes(n)).map((n) => ({ name: n, 'super_class.name': TABLES[n] })) });
  }
  if (table === 'sys_dictionary' && /^nameIN/.test(query) && /elementIN/.test(query) && /sys_flow_context/.test(query)) {
    const names = query.replace(/^nameIN/, '').split('^')[0].split(',');
    const wanted = /elementIN([^^]*)/.exec(query)[1].split(',');
    const rows = [];
    Object.entries(COLUMNS).forEach(([t, cols]) => {
      const owner = (c) => (t !== 'task' && c === 'parent' ? 'task' : t);
      cols.forEach((c) => {
        if (names.includes(owner(c)) && wanted.includes(c)) rows.push({ name: owner(c), element: c });
      });
    });
    return json({ result: rows });
  }

  // "Can this user see any row of the table at all?" (one sys_id, no filter), asked when a source came back empty.
  if (!query && fields.length === 1 && fields[0] === 'sys_id' && table in data()) {
    return json({ result: mine === 'hidden' && HIDDEN.includes(table) ? [] : [{ sys_id: hex(0xeee) }] });
  }

  // Only the queries this panel makes.
  const signature = {
    sys_flow_context: /source_record=/, sys_flow_log: /contextIN/, sysapproval_approver: /sysapproval=|document_id=/, sysapproval_group: /parent=/, task_sla: /task=/,
    task: /^parent=/, sc_task: /request_item=/, sc_req_item: /^request=/, change_task: /change_request=/, problem_task: /^problem=/, wf_context: /^id=/, wf_executing: /contextIN/, wf_history: /contextIN/, sysevent: /instance=/,
  }[table];
  if (!signature || !signature.test(query)) return null;

  if (mine === 'denied' && (table === 'sysapproval_approver' || table === 'sysevent')) return failure(403, 'User Not Authorized');
  if (mine === 'nowf' && table.startsWith('wf_')) return failure(400, `Invalid table ${table}`);

  let rows = variant(mine, data())[table] || [];
  if (mine === 'filter' && table === 'sys_flow_context') {
    // A condition the instance ignored: every flow on the instance comes back.
    rows = [...rows, { sys_id: hex(0x1ff), name: 'Onboard new hire', state: f('COMPLETE', 'Complete'), source_table: 'sn_hr_core_case', source_record: hex(0xabc), started: stamp(HOUR), sys_created_on: stamp(HOUR), sys_updated_on: stamp(HOUR) }];
  } else {
    rows = select(rows, query);
  }
  return json({ result: rows.slice(0, limit).map((r) => project(r, fields, mode)) });
}
