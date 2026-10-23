const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/lib/processView.js');
const { REQUIREMENTS } = require('../src/lib/requirements/process.js');

const NOW = Date.UTC(2026, 9, 23, 10, 0, 0); // 2026-10-23 10:00:00 UTC
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ID = '9de5069c0b0f0300b8b9e5cd35673a5b';
const hex = (n) => n.toString(16).padStart(32, '0');
const stamp = (ms) => new Date(NOW - ms).toISOString().replace('T', ' ').slice(0, 19);
const ahead = (ms) => new Date(NOW + ms).toISOString().replace('T', ' ').slice(0, 19);

/** A Table API row as sysparm_display_value=all returns it: { value, display_value } for every field. */
function row(fields, displays = {}) {
  const out = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: String(v), display_value: displays[k] ?? String(v) }]));
  // A display name for a field that has no stored value given: a reference or choice, so the value is some other id.
  Object.entries(displays).forEach(([k, d]) => {
    if (!(k in out)) out[k] = { value: hex(0xfeed), display_value: d };
  });
  return out;
}

// --- Schema fixture: every table and column the probes need, with the real hierarchy ---------------------------------

const TABLE_PARENTS = {
  incident: 'task', task: '', sc_request: 'task', sc_req_item: 'task', sc_task: 'task', change_request: 'task', change_task: 'task', problem: 'task', problem_task: 'task',
  sysapproval_group: 'task', sys_user: '', sys_flow_context: '', sys_flow_log: '', sysapproval_approver: '', task_sla: 'task', wf_context: '', wf_executing: '', wf_history: '', sysevent: '',
};
function schemaFor(primary, { drop = [], dropColumns = {} } = {}) {
  const objectRows = Object.entries(TABLE_PARENTS)
    .filter(([name]) => !drop.includes(name))
    .map(([name, sup]) => row({ name, 'super_class.name': sup }));
  const dictRows = [];
  P.PROBES.forEach((probe) => {
    [...(probe.need || []), ...(probe.needAny || [])].forEach((column) => {
      if ((dropColumns[probe.table] || []).includes(column)) return;
      // Columns that live on task (parent) are found through the hierarchy, not on the child table.
      dictRows.push(row({ name: probe.table === 'task' || probe.table === 'sysapproval_group' ? (column === 'parent' ? 'task' : probe.table) : probe.table, element: column }));
    });
  });
  return P.buildSchema({ objectRows, dictRows, primary });
}

// --- Data fixture: one incident with a failed flow, a running flow, a pending approval, a breached SLA and a stuck workflow

const FLOW_FAILED = row({ sys_id: hex(1), name: 'Notify assignment group', state: 'ERROR', source_table: 'incident', source_record: ID, error_message: 'Value for data pill Trigger.Record.assigned_to is null', started: stamp(2 * DAY), ended: stamp(2 * DAY - 4000), sys_created_on: stamp(2 * DAY), sys_updated_on: stamp(2 * DAY - 4000) }, { state: 'Error' });
const FLOW_RUNNING = row({ sys_id: hex(2), name: 'Update priority from impact', state: 'IN_PROGRESS', source_table: 'incident', source_record: ID, started: stamp(5 * MIN), sys_created_on: stamp(5 * MIN), sys_updated_on: stamp(4 * MIN) }, { state: 'In Progress' });
const FLOW_DONE = row({ sys_id: hex(3), name: 'Set SLA targets', state: 'COMPLETE', source_table: 'incident', source_record: ID, started: stamp(9 * DAY), ended: stamp(9 * DAY - 2000), sys_created_on: stamp(9 * DAY), sys_updated_on: stamp(9 * DAY - 2000) }, { state: 'Complete' });
const APPROVAL = row({ sys_id: hex(10), approver: hex(90), state: 'requested', sysapproval: ID, document_id: ID, comments: '', sys_created_on: stamp(3 * DAY + HOUR), sys_updated_on: stamp(3 * DAY) }, { approver: 'Abel Tuter', state: 'Requested' });
const SLA = row({ sys_id: hex(20), sla: 'P1 resolution 4h', stage: 'in_progress', has_breached: 'true', percentage: '118', planned_end_time: stamp(2 * HOUR), start_time: stamp(6 * HOUR), task: ID }, { stage: 'In progress' });
const WF = row({ sys_id: hex(30), workflow_version: 'Incident escalation', id: ID, table: 'incident', state: 'executing', started: stamp(40 * DAY), sys_created_on: stamp(40 * DAY) }, { state: 'Executing' });
const WF_EXEC = row({ sys_id: hex(31), context: hex(30), activity: 'Wait for change approval', 'activity.activity_definition': 'Approval - Group', state: 'executing', started: stamp(40 * DAY) });

function results(overrides = {}) {
  return {
    flowContext: { status: 'ok', items: [FLOW_FAILED, FLOW_RUNNING, FLOW_DONE].map(P.normaliseFlow) },
    approver: { status: 'ok', items: [APPROVAL].map(P.normaliseApproval) },
    sla: { status: 'ok', items: [SLA].map(P.normaliseSla) },
    childTasks: { status: 'ok', items: [] },
    wfContext: { status: 'ok', items: [WF].map(P.normaliseWorkflowContext) },
    wfExecuting: { status: 'ok', items: [WF_EXEC].map(P.normaliseExecuting) },
    wfHistory: { status: 'ok', items: [] },
    events: { status: 'ok', items: [] },
    ...overrides,
  };
}

function plansFor(table, { schema = schemaFor(table), ids = [hex(30)] } = {}) {
  const traits = P.tableTraits(table, schema.chain(table));
  return { plans: P.planProbes({ sysId: ID, schema, traits, ids }), traits };
}

function report(overrides = {}, { table = 'incident', record = { label: 'INC0010042', summary: 'Laptop will not boot', active: true } } = {}) {
  const { plans, traits } = plansFor(table);
  return P.buildReport({ table, sysId: ID, record, plans, results: results(overrides), traits, now: NOW });
}

// --- Time ----------------------------------------------------------------------------------------------------------

test('ages read in the unit a person would say', () => {
  assert.equal(P.formatAge(20 * 1000), 'under a minute');
  assert.equal(P.formatAge(12 * MIN + 20000), '12 min');
  assert.equal(P.formatAge(5 * HOUR + 20 * MIN), '5 h');
  assert.equal(P.formatAge(5 * HOUR + 40 * MIN), '6 h');
  assert.equal(P.formatAge(48 * HOUR - 4000), '2 days', 'just under two days is two days, not 47 h');
  assert.equal(P.formatAge(47 * HOUR), '47 h');
  assert.equal(P.formatAge(59 * MIN + 50000), '1 h');
  assert.equal(P.formatAge(48 * HOUR), '2 days');
  assert.equal(P.formatAge(40 * DAY), '40 days');
  assert.equal(P.formatAge(130 * DAY), '4 months');
  assert.equal(P.formatAge(NaN), '');
});

test('relative time points the right way and says nothing for a non-date', () => {
  assert.equal(P.relativeTime(stamp(3 * DAY), NOW), '3 days ago');
  assert.equal(P.relativeTime(ahead(40 * MIN), NOW), 'in 40 min');
  assert.equal(P.relativeTime(stamp(10 * 1000), NOW), 'just now');
  assert.equal(P.relativeTime('', NOW), '');
  assert.equal(P.relativeTime('tomorrow', NOW), '');
  assert.equal(P.exactTime('2026-10-20 14:03:11'), '2026-10-20 14:03:11 UTC');
  assert.equal(P.exactTime('nonsense'), '');
});

test('run time between two stamps', () => {
  assert.equal(P.runTime('2026-10-21 09:00:00', '2026-10-21 09:00:04'), '4 s');
  assert.equal(P.runTime('2026-10-21 09:00:00', '2026-10-21 09:20:00'), '20 min');
  assert.equal(P.runTime('2026-10-21 09:00:00', ''), '');
  assert.equal(P.runTime('2026-10-21 09:00:10', '2026-10-21 09:00:00'), '', 'an end before the start is not a run time');
});

// --- States --------------------------------------------------------------------------------------------------------

test('Flow Designer states, as stored and as displayed', () => {
  const key = (r, d) => P.flowState(r, d).key;
  assert.equal(key('ERROR', 'Error'), 'error');
  assert.equal(key('CANCELLED', 'Cancelled'), 'cancelled');
  assert.equal(key('COMPLETE', 'Complete'), 'complete');
  assert.equal(key('IN_PROGRESS', 'In Progress'), 'running');
  assert.equal(key('WAITING', 'Waiting'), 'waiting');
  assert.equal(key('QUEUED', 'Queued'), 'queued');
  assert.equal(key('error', ''), 'error', 'lower case works too');
  assert.equal(key('SOMETHING_NEW', 'Something new'), 'other');
  assert.equal(P.flowState('ERROR', 'Error').label, 'Failed');
  assert.equal(P.flowState('SOMETHING_NEW', 'Something new').label, 'Something new', 'an unknown state keeps the instance wording');
});

test('approval states, including the ones that must not look like a wait', () => {
  const key = (r, d) => P.approvalState(r, d).key;
  assert.equal(key('requested', 'Requested'), 'pending');
  assert.equal(key('approved', 'Approved'), 'approved');
  assert.equal(key('rejected', 'Rejected'), 'rejected');
  assert.equal(key('cancelled', 'Cancelled'), 'cancelled');
  assert.equal(key('not requested', 'Not Yet Requested'), 'notyet', 'not yet requested is not a pending approval');
  assert.equal(key('not_required', 'No Longer Required'), 'notrequired');
});

test('workflow and SLA states', () => {
  assert.equal(P.workflowState('executing', 'Executing').active, true);
  assert.equal(P.workflowState('finished', 'Finished').active, false);
  assert.equal(P.workflowState('cancelled', 'Cancelled').key, 'cancelled');
  assert.equal(P.slaStage('in_progress', 'In progress'), 'in_progress');
  assert.equal(P.slaStage('paused', 'Paused'), 'paused');
  assert.equal(P.slaStage('breached', 'Breached'), 'breached');
  assert.equal(P.slaStage('achieved', 'Achieved'), 'achieved');
  assert.equal(P.slaStage('cancelled', 'Cancelled'), 'cancelled');
});

test('what a workflow activity is waiting for', () => {
  assert.equal(P.waitKind('Wait for change approval', 'Approval - Group'), 'approval');
  assert.equal(P.waitKind('Wait 2 days', 'Timer'), 'timer');
  assert.equal(P.waitKind('Wait for condition', 'Wait for condition'), 'condition');
  assert.equal(P.waitKind('Create catalog task', 'Catalog Task'), 'task');
  assert.equal(P.waitKind('Set priority', 'Run Script'), 'other');
});

// --- Row shapes ----------------------------------------------------------------------------------------------------

test('a failed flow keeps its error, a reason in plain words and its own record', () => {
  const flow = P.normaliseFlow(FLOW_FAILED);
  assert.equal(flow.state, 'error');
  assert.equal(flow.name, 'Notify assignment group');
  assert.match(flow.error, /assigned_to is null/);
  assert.match(flow.hint, /empty/);
  assert.deepEqual(flow.target, { table: 'sys_flow_context', sysId: hex(1) });
  assert.equal(P.recordPath(flow.target), `/sys_flow_context.do?sys_id=${hex(1)}`);
});

test('a flow whose name is only a sys_id is shown as unnamed, not as the id', () => {
  const lost = P.normaliseFlow(row({ sys_id: hex(11), name: '', flow: hex(12), state: 'ERROR' }));
  assert.equal(lost.name, '(unnamed flow)');
  assert.equal(P.normaliseFlow(row({ sys_id: hex(11), name: '', flow: 'Readable flow', state: 'ERROR' })).name, 'Readable flow');
});

test('a flow without started or ended falls back to created and updated', () => {
  const flow = P.normaliseFlow(row({ sys_id: hex(4), name: 'Old flow', state: 'COMPLETE', sys_created_on: '2026-10-01 08:00:00', sys_updated_on: '2026-10-01 08:00:05' }));
  assert.equal(flow.started, '2026-10-01 08:00:00');
  assert.equal(flow.ended, '2026-10-01 08:00:05');
  assert.equal(P.presentItem(flow, NOW).facts[0], 'Ran 5 s');
});

test('a row without a real sys_id has no link', () => {
  assert.equal(P.normaliseFlow({ sys_id: 'x', name: 'n', state: 'ERROR' }).target, null);
  assert.equal(P.recordPath(null), '');
});

test('a task knows its own table, so the link opens the right form', () => {
  const task = P.normaliseTask(row({ sys_id: hex(50), number: 'SCTASK0010011', short_description: 'Image the laptop', state: '2', active: 'true', sys_class_name: 'sc_task', parent: ID }, { state: 'Work in Progress', sys_class_name: 'Catalog Task' }));
  assert.equal(task.table, 'sc_task');
  assert.equal(task.open, true);
  assert.equal(P.recordPath(task.target), `/sc_task.do?sys_id=${hex(50)}`);
  const closed = P.normaliseTask(row({ sys_id: hex(51), number: 'TASK1', state: '3', active: 'false' }, { state: 'Closed Complete' }));
  assert.equal(closed.open, false);
  const noActive = P.normaliseTask(row({ sys_id: hex(52), number: 'TASK2' }, { state: 'Closed Skipped' }));
  assert.equal(noActive.open, false, 'without an active column the state wording decides');
});

// --- Assembling ----------------------------------------------------------------------------------------------------

test('a failed run is marked superseded only when a later run of the same flow completed', () => {
  const failed = P.normaliseFlow(FLOW_FAILED);
  const laterOk = P.normaliseFlow(row({ sys_id: hex(5), name: 'Notify assignment group', state: 'COMPLETE', source_record: ID, started: stamp(DAY), sys_created_on: stamp(DAY), sys_updated_on: stamp(DAY) }));
  const earlierOk = P.normaliseFlow(row({ sys_id: hex(6), name: 'Notify assignment group', state: 'COMPLETE', source_record: ID, started: stamp(5 * DAY), sys_created_on: stamp(5 * DAY), sys_updated_on: stamp(5 * DAY) }));
  const other = P.normaliseFlow(row({ sys_id: hex(7), name: 'Another flow', state: 'COMPLETE', source_record: ID, started: stamp(DAY), sys_created_on: stamp(DAY), sys_updated_on: stamp(DAY) }));
  assert.equal(P.assembleFlows([failed, laterOk]).find((f) => f.state === 'error').superseded, true);
  assert.equal(P.assembleFlows([failed, earlierOk]).find((f) => f.state === 'error').superseded, false, 'an older success does not fix a newer failure');
  assert.equal(P.assembleFlows([failed, other]).find((f) => f.state === 'error').superseded, false, 'another flow does not count');
});

test('flows list failures first, then live ones, then newest first, with their log lines attached', () => {
  const flows = [FLOW_DONE, FLOW_FAILED, FLOW_RUNNING].map(P.normaliseFlow);
  const log = [
    P.normaliseFlowLog(row({ context: hex(1), message: 'Action Look up user started', level: 'Info', sys_created_on: stamp(2 * DAY) })),
    P.normaliseFlowLog(row({ context: hex(1), message: 'Action failed: assigned_to is null', level: 'Error', sys_created_on: stamp(2 * DAY - 3000) })),
    P.normaliseFlowLog(row({ context: hex(99), message: 'someone else', sys_created_on: stamp(DAY) })),
  ];
  const out = P.assembleFlows(flows, log);
  assert.deepEqual(out.map((f) => f.name), ['Notify assignment group', 'Update priority from impact', 'Set SLA targets']);
  const failed = out.find((f) => f.state === 'error');
  assert.equal(failed.log.length, 2);
  assert.match(failed.log[1].message, /failed/);
});

test('approvals: who has waited longest comes first, decided ones after', () => {
  const mk = (n, state, updated) => P.normaliseApproval(row({ sys_id: hex(100 + n), state, sys_created_on: updated, sys_updated_on: updated }, { approver: `Person ${n}` }));
  const out = P.assembleApprovals([mk(1, 'approved', stamp(DAY)), mk(2, 'requested', stamp(HOUR)), mk(3, 'requested', stamp(5 * DAY))]);
  assert.deepEqual(out.map((a) => a.state), ['pending', 'pending', 'approved']);
  assert.equal(out[0].sysId, hex(103), 'the oldest request first');
});

test('an approval with no approver falls back to the group, then to a placeholder', () => {
  const byGroup = P.normaliseApproval(row({ sys_id: hex(8), state: 'requested', group: hex(91) }, { group: 'CAB Approval' }));
  assert.equal(byGroup.who, 'CAB Approval');
  assert.equal(P.normaliseApproval(row({ sys_id: hex(9), state: 'requested' })).who, '(nobody assigned)');
});

test('child tasks found by two relations are listed once, open ones first', () => {
  const a = P.normaliseTask(row({ sys_id: hex(60), number: 'SCTASK1', active: 'false', sys_updated_on: stamp(DAY) }), 'task');
  const b = P.normaliseTask(row({ sys_id: hex(61), number: 'SCTASK2', active: 'true', sys_updated_on: stamp(2 * DAY) }), 'task');
  const dup = P.normaliseTask(row({ sys_id: hex(61), number: 'SCTASK2', active: 'true', sys_updated_on: stamp(2 * DAY) }), 'sc_task');
  const out = P.assembleTasks([[a, b], [dup]]);
  assert.deepEqual(out.map((t) => t.number), ['SCTASK2', 'SCTASK1']);
});

test('a workflow carries its executing activity and history in order', () => {
  const contexts = [WF].map(P.normaliseWorkflowContext);
  const history = [
    P.normaliseHistory(row({ context: hex(30), activity: 'Begin', result: 'success', started: stamp(40 * DAY), activity_index: '0' })),
    P.normaliseHistory(row({ context: hex(30), activity: 'Set priority', result: 'success', started: stamp(40 * DAY - 1000), activity_index: '1' })),
    P.normaliseHistory(row({ context: hex(77), activity: 'Not mine', started: stamp(DAY) })),
  ];
  const out = P.assembleWorkflows(contexts, [WF_EXEC].map(P.normaliseExecuting), history);
  assert.equal(out[0].executing[0].activity, 'Wait for change approval');
  assert.deepEqual(out[0].history.map((h) => h.activity), ['Begin', 'Set priority']);
  const standing = P.workflowStanding(out[0], NOW);
  assert.equal(standing.isWait, true);
  assert.equal(standing.wait, 'approval');
  assert.equal(P.formatAge(standing.age), '40 days');
  assert.equal(P.workflowStanding({ ...out[0], active: false }, NOW), null, 'a finished workflow has no current activity');
});

// --- SLA wording -----------------------------------------------------------------------------------------------------

test('breach risk, in words', () => {
  const sla = (fields) => P.normaliseSla(row({ sys_id: hex(21), sla: 'P1 resolution', stage: 'in_progress', has_breached: 'false', ...fields }, { stage: 'In progress' }));
  const risk = (fields) => P.slaRisk(sla(fields), NOW);
  assert.deepEqual(risk({ has_breached: 'true', percentage: '118', planned_end_time: stamp(2 * HOUR) }), { level: 'breached', text: 'Breached 2 h ago, 118% of the time used' });
  assert.equal(risk({ percentage: '40', planned_end_time: ahead(3 * HOUR) }).text, 'On track: 40% of the time used, due in 3 h');
  assert.equal(risk({ percentage: '85', planned_end_time: ahead(40 * MIN) }).level, 'atRisk');
  assert.equal(risk({ percentage: '85', planned_end_time: ahead(40 * MIN) }).text, 'At risk: 85% of the time used, due in 40 min');
  assert.equal(risk({ business_percentage: '100' }).level, 'breached', 'full business time is breached even if the flag has not caught up');
  // An 8-to-5 SLA overnight: the wall-clock percentage is past 100, the business one is not, and the flag says no.
  assert.equal(risk({ percentage: '150', business_percentage: '60', planned_end_time: ahead(5 * HOUR) }).text, 'On track: 60% of the time used, due in 5 h');
  assert.notEqual(risk({ percentage: '100' }).level, 'breached', 'the wall-clock percentage alone does not overrule a breach flag that says no');
  assert.equal(P.slaRisk(P.normaliseSla(row({ sys_id: hex(22), sla: 'x', stage: 'in_progress', percentage: '100' })), NOW).level, 'breached', 'with nothing else readable, a full percentage is a breach');
  assert.equal(risk({ percentage: '50', planned_end_time: stamp(MIN * 10) }).level, 'breached', 'a planned end in the past is breached');
  assert.equal(risk({}).level, 'unknown');
  const paused = P.slaRisk(sla({ stage: 'paused', pause_time: stamp(3 * HOUR), percentage: '40' }), NOW);
  assert.equal(paused.level, 'paused');
  assert.match(paused.text, /Paused 3 h ago; the clock is stopped at 40%/);
  assert.equal(P.slaRisk(sla({ stage: 'achieved' }), NOW).level, 'met');
  assert.equal(P.slaRisk(sla({ stage: 'achieved', has_breached: 'true' }), NOW).level, 'late');
  assert.equal(P.slaRisk(sla({ stage: 'cancelled' }), NOW).level, 'cancelled');
});

// --- The headline: what is it waiting for -------------------------------------------------------------------------

test('a failed flow outranks everything and the headline says so', () => {
  const r = report();
  assert.equal(r.summary.level, 'blocked');
  assert.match(r.summary.headline, /^Waiting on: the flow "Notify assignment group", which failed 2 days ago$/);
  assert.match(r.summary.detail, /assigned_to is null/);
  assert.match(r.summary.detail, /empty/, 'the plain-words reason follows the raw error');
  assert.equal(r.summary.tag, 'Failed flow');
  assert.equal(r.summary.severity, 'error');
  assert.deepEqual(r.summary.also.map((b) => b.kind), ['approvalPending', 'workflowWait', 'slaBreached']);
});

test('priority runs: failed flow, approval, rejected approval, waits, tasks, SLA, events', () => {
  const data = {
    flows: [{ kind: 'flow', state: 'waiting', name: 'W', started: stamp(DAY), updated: stamp(DAY), target: null }],
    approvals: [P.normaliseApproval(row({ sys_id: hex(1), state: 'requested', sys_updated_on: stamp(HOUR), sys_created_on: stamp(HOUR) }, { approver: 'Abel Tuter' }))],
    slas: [P.normaliseSla(row({ sys_id: hex(2), sla: 'S', stage: 'in_progress', has_breached: 'true', planned_end_time: stamp(HOUR) }))],
    tasks: [P.normaliseTask(row({ sys_id: hex(3), number: 'TASK1', active: 'true' }))],
    workflows: [],
    events: [P.normaliseEvent(row({ sys_id: hex(4), name: 'incident.assigned', state: 'ready', sys_created_on: stamp(20 * MIN) }))],
  };
  assert.deepEqual(P.findBlockers(data, NOW).map((b) => b.kind), ['approvalPending', 'flowWaiting', 'tasksOpen', 'slaBreached', 'eventsQueued']);
});

test('without a failure the first blocker is the pending approval, worded with a name and a wait', () => {
  const r = report({ flowContext: { status: 'ok', items: [FLOW_RUNNING, FLOW_DONE].map(P.normaliseFlow) } });
  assert.equal(r.summary.headline, 'Waiting on: approval from Abel Tuter, requested 3 days ago');
});

test('several pending approvals are one blocker naming them, longest wait first', () => {
  const mk = (n, name, ms) => P.normaliseApproval(row({ sys_id: hex(200 + n), state: 'requested', sys_created_on: stamp(ms), sys_updated_on: stamp(ms) }, { approver: name }));
  const blockers = P.findBlockers({ approvals: [mk(1, 'Abel Tuter', 3 * DAY), mk(2, 'Beth Anglin', 2 * DAY), mk(3, 'Carol Coughlin', DAY), mk(4, 'Dave Loo', HOUR)].sort(() => 0) }, NOW);
  assert.equal(blockers[0].text, '4 approvals: Abel Tuter (3 days), Beth Anglin (2 days), Carol Coughlin (24 h) and 1 more');
});

test('an approval past its due date is a warning and says so', () => {
  const a = P.normaliseApproval(row({ sys_id: hex(11), state: 'requested', sys_created_on: stamp(2 * HOUR), sys_updated_on: stamp(2 * HOUR), due_date: stamp(HOUR) }, { approver: 'Abel Tuter' }));
  const [b] = P.findBlockers({ approvals: [a] }, NOW);
  assert.equal(b.severity, 'warn');
  assert.match(b.detail, /Abel Tuter is past the due date/);
  assert.match(P.presentItem(a, NOW).facts.join(' '), /Overdue by 1 h/);
});

test('a rejection is reported when nothing is pending, and ignored behind a pending one', () => {
  const rejected = P.normaliseApproval(row({ sys_id: hex(12), state: 'rejected', comments: 'Not enough detail', sys_created_on: stamp(2 * DAY), sys_updated_on: stamp(DAY) }, { approver: 'Beth Anglin' }));
  const [b] = P.findBlockers({ approvals: [rejected] }, NOW);
  assert.equal(b.text, 'an approval that Beth Anglin rejected 24 h ago');
  assert.match(b.detail, /Not enough detail/);
  const pending = P.normaliseApproval(row({ sys_id: hex(13), state: 'requested', sys_created_on: stamp(HOUR), sys_updated_on: stamp(HOUR) }, { approver: 'Abel Tuter' }));
  assert.deepEqual(P.findBlockers({ approvals: [rejected, pending] }, NOW).map((x) => x.kind), ['approvalPending']);
});

test('a stuck workflow wait says where, for how long and why that is suspicious', () => {
  const r = report({ flowContext: { status: 'ok', items: [] }, approver: { status: 'ok', items: [] }, sla: { status: 'ok', items: [] } });
  assert.equal(r.summary.headline, 'Waiting on: the workflow "Incident escalation", at "Wait for change approval" for 40 days');
  assert.match(r.summary.detail, /waiting for an approval/);
  assert.match(r.summary.detail, /very likely stuck/);
  assert.equal(r.summary.severity, 'warn');
});

test('a long timer wait is not called stuck', () => {
  const timer = P.normaliseExecuting(row({ context: hex(30), activity: 'Wait 60 days', 'activity.activity_definition': 'Timer', state: 'executing', started: stamp(40 * DAY) }));
  const wf = P.assembleWorkflows([WF].map(P.normaliseWorkflowContext), [timer], []);
  const [b] = P.findBlockers({ workflows: wf }, NOW);
  assert.match(b.detail, /waiting on a timer/);
  assert.doesNotMatch(b.detail, /stuck/);
  assert.equal(b.severity, 'info');
});

test('open child tasks are counted and named, closed ones are not', () => {
  const tasks = [
    P.normaliseTask(row({ sys_id: hex(70), number: 'SCTASK0010011', active: 'true' }, { state: 'Work in Progress' })),
    P.normaliseTask(row({ sys_id: hex(71), number: 'SCTASK0010012', active: 'true' }, { state: 'Open' })),
    P.normaliseTask(row({ sys_id: hex(72), number: 'SCTASK0010010', active: 'false' }, { state: 'Closed Complete' })),
  ];
  const [b] = P.findBlockers({ tasks }, NOW);
  assert.equal(b.text, '2 open tasks: SCTASK0010011 (Work in Progress), SCTASK0010012 (Open)');
});

test('a paused SLA is last of the SLA blockers; a finished SLA is none', () => {
  const sla = (n, fields) => P.normaliseSla(row({ sys_id: hex(80 + n), sla: `SLA ${n}`, ...fields }));
  const out = P.findBlockers({ slas: [sla(1, { stage: 'paused', pause_time: stamp(3 * HOUR) }), sla(2, { stage: 'achieved' }), sla(3, { stage: 'in_progress', percentage: '30', planned_end_time: ahead(HOUR) })] }, NOW);
  assert.deepEqual(out.map((b) => b.kind), ['slaPaused']);
  assert.match(out[0].text, /^the SLA "SLA 1" to resume \(paused 3 h ago/);
});

test('a failed flow that a later run fixed is not a blocker, but is still listed with the reason', () => {
  const laterOk = row({ sys_id: hex(5), name: 'Notify assignment group', state: 'COMPLETE', source_record: ID, started: stamp(DAY), sys_created_on: stamp(DAY), sys_updated_on: stamp(DAY) });
  const r = report({ flowContext: { status: 'ok', items: [FLOW_FAILED, laterOk].map(P.normaliseFlow) }, approver: { status: 'ok', items: [] }, sla: { status: 'ok', items: [] }, wfContext: { status: 'ok', items: [] }, wfExecuting: { status: 'ok', items: [] } });
  assert.equal(r.summary.level, 'clear');
  const failed = r.sections.find((s) => s.id === 'flows').rows.find((x) => x.badge.text === 'Failed');
  assert.match(failed.note, /later run of this flow completed/);
  assert.equal(failed.attention, false);
});

test('a queued flow that never started and a flow running for hours are flagged; a fresh one is not', () => {
  const mk = (state, ms) => P.normaliseFlow(row({ sys_id: hex(300 + ms), name: 'F', state, started: stamp(ms), sys_created_on: stamp(ms), sys_updated_on: stamp(ms) }));
  assert.deepEqual(P.findBlockers({ flows: [mk('QUEUED', 30 * MIN)] }, NOW).map((b) => b.kind), ['flowLate']);
  assert.deepEqual(P.findBlockers({ flows: [mk('IN_PROGRESS', 3 * HOUR)] }, NOW).map((b) => b.kind), ['flowLate']);
  assert.deepEqual(P.findBlockers({ flows: [mk('IN_PROGRESS', 2 * MIN)] }, NOW), []);
});

test('queued events only count once they have waited past the usual minute or so', () => {
  const ev = (ms) => P.normaliseEvent(row({ sys_id: hex(400 + ms), name: 'incident.assigned', state: 'ready', sys_created_on: stamp(ms) }));
  assert.deepEqual(P.findBlockers({ events: [ev(MIN)] }, NOW), []);
  const [b] = P.findBlockers({ events: [ev(20 * MIN)] }, NOW);
  assert.equal(b.text, '1 queued event: incident.assigned (20 min)');
});

// --- The verdict: clear, running, partial, unknown ----------------------------------------------------------------------

const quiet = {
  flowContext: { status: 'ok', items: [FLOW_DONE].map(P.normaliseFlow) },
  approver: { status: 'ok', items: [] },
  sla: { status: 'ok', items: [] },
  wfContext: { status: 'ok', items: [] },
  wfExecuting: { status: 'ok', items: [] },
};

test('nothing running is only said when every applicable source was read', () => {
  const clear = report(quiet);
  assert.equal(clear.summary.level, 'clear');
  assert.equal(clear.summary.headline, 'Nothing is running on this record');
  assert.equal(clear.summary.detail, 'Finished earlier: 1 flow.');

  const denied = report({ ...quiet, approver: { status: 'denied', note: 'Your user cannot read sysapproval_approver.', items: [] } });
  assert.equal(denied.summary.level, 'partial');
  assert.notEqual(denied.summary.headline, 'Nothing is running on this record');
  assert.match(denied.summary.detail, /1 source could not be read/);
  assert.deepEqual(denied.summary.unreadable.map((u) => u.section), ['approvals']);
  const section = denied.sections.find((s) => s.id === 'approvals');
  assert.equal(section.status, 'denied');
  assert.equal(section.note, 'Your user cannot read sysapproval_approver.');
  assert.equal(section.count, 0);

  const failedRead = report({ ...quiet, events: { status: 'error', note: 'Could not read sysevent: boom', items: [] } });
  assert.equal(failedRead.summary.level, 'partial');
});

test('an empty record names only what applies when it says nothing was found', () => {
  const none = { flowContext: { status: 'ok', items: [] }, approver: { status: 'ok', items: [] }, wfContext: { status: 'ok', items: [] }, wfExecuting: { status: 'ok', items: [] }, events: { status: 'ok', items: [] } };
  const user = report(none, { table: 'sys_user', record: { label: 'abel.tuter' } });
  assert.equal(user.summary.level, 'clear');
  assert.equal(user.summary.detail, 'No flows, approvals, workflows or events were found for this record.');
  const incident = report({ ...none, sla: { status: 'ok', items: [] }, childTasks: { status: 'ok', items: [] } });
  assert.equal(incident.summary.detail, 'No flows, approvals, SLAs, tasks, workflows or events were found for this record.');
});

test('a table that is not on the instance does not stop the all-clear, but it is said', () => {
  const r = report({ ...quiet, wfContext: { status: 'missing', note: 'wf_context is not on this instance.', items: [] }, wfExecuting: { status: 'ok', items: [] } });
  assert.equal(r.summary.level, 'clear');
  assert.match(r.summary.absentNote, /wf_context/);
});

test('everything unreadable is an unknown, not an all-clear', () => {
  const fail = { status: 'denied', note: 'Your user cannot read x.', items: [] };
  const r = report({ flowContext: fail, approver: fail, sla: fail, childTasks: fail, wfContext: fail, events: fail });
  assert.equal(r.summary.level, 'unknown');
  assert.equal(r.summary.headline, 'Could not read what is running on this record');
  assert.equal(r.summary.unreadable.length, 6);
});

test('something live but not holding anything up is "running now"', () => {
  const r = report({ ...quiet, flowContext: { status: 'ok', items: [FLOW_RUNNING].map(P.normaliseFlow) } });
  assert.equal(r.summary.level, 'running');
  assert.equal(r.summary.headline, 'Running now: the flow "Update priority from impact" (started 5 min ago)');
});

test('a blocker is still reported when another source could not be read, with the gap shown beside it', () => {
  const r = report({ events: { status: 'denied', note: 'Your user cannot read sysevent.', items: [] } });
  assert.equal(r.summary.level, 'blocked');
  assert.equal(r.summary.unreadable.length, 1);
});

test('a closed record says its findings may be leftovers', () => {
  const r = report({}, { record: { label: 'INC0010042', active: false } });
  assert.match(r.summary.closedNote, /not active/);
  assert.equal(report().summary.closedNote, '');
});

test('a partial section (the current workflow activity could not be read) is listed and keeps the all-clear back', () => {
  const r = report({ ...quiet, wfContext: { status: 'ok', items: [WF].map(P.normaliseWorkflowContext) }, wfExecuting: { status: 'denied', note: 'Your user cannot read wf_executing.', items: [] } });
  const wf = r.sections.find((s) => s.id === 'workflow');
  assert.equal(wf.status, 'partial');
  assert.match(wf.note, /wf_executing/);
  assert.equal(r.summary.level, 'blocked', 'a running workflow is still named, as running with an unknown activity');
  assert.match(r.summary.headline, /current activity could not be read/);
  assert.equal(r.summary.unreadable.length, 1);
});

test('a failing optional source is a note and does not hold back the all-clear', () => {
  const r = report({ ...quiet, wfHistory: { status: 'denied', note: 'Your user cannot read wf_history.', items: [] } });
  assert.equal(r.summary.level, 'clear');
  const wf = r.sections.find((s) => s.id === 'workflow');
  assert.equal(wf.status, 'ok');
  assert.equal(wf.notes[0].level, 'info');
  assert.match(wf.notes[0].text, /wf_history/);
});

// --- What can be read, and what must not be believed -----------------------------------------------------------------

test('schema: a table the dictionary does not show is "not on this instance", a missing column is "could not check"', () => {
  const schema = schemaFor('incident', { drop: ['wf_context', 'sysapproval_group'], dropColumns: { sys_flow_context: ['source_record'] } });
  const { plans } = plansFor('incident', { schema });
  const by = (id) => plans.find((p) => p.probe.id === id);
  assert.equal(by('wfContext').status, 'missing');
  assert.equal(by('wfContext').note, 'wf_context is not on this instance.');
  assert.equal(by('flowContext').status, 'error');
  assert.match(by('flowContext').note, /no source_record column/);
  assert.equal(by('sla').status, 'run');
  assert.equal(by('sla').query, `task=${ID}^ORDERBYDESCsys_created_on`);
});

test('schema: SLAs and child tasks do not apply to a record that is not a task, and the section says so in one line', () => {
  const { plans, traits } = plansFor('sys_user');
  assert.equal(traits.isTask, false);
  assert.equal(plans.find((p) => p.probe.id === 'sla').status, 'na');
  assert.equal(plans.find((p) => p.probe.id === 'childTasks').status, 'na');
  assert.equal(plans.find((p) => p.probe.id === 'flowContext').status, 'run');
  assert.equal(plans.find((p) => p.probe.id === 'approver').status, 'run');
  const r = report({ ...quiet }, { table: 'sys_user', record: { label: 'abel.tuter' } });
  const slas = r.sections.find((s) => s.id === 'slas');
  assert.equal(slas.status, 'na');
  assert.equal(slas.note, 'Not applicable: SLAs only run on task records (incidents, changes, requests and so on), and sys_user is not one.');
  assert.equal(r.summary.level, 'clear', 'not applicable is not unreadable');
});

test('schema: catalog and change tasks are read only for the tables they belong to', () => {
  const ids = (table) => plansFor(table).plans.filter((p) => p.status === 'run').map((p) => p.probe.id);
  assert.ok(ids('sc_req_item').includes('catalogTasks'));
  assert.ok(!ids('incident').includes('catalogTasks'));
  assert.ok(ids('sc_request').includes('requestItems'));
  assert.ok(ids('change_request').includes('changeTasks'));
  assert.ok(ids('problem').includes('problemTasks'));
});

test('the approval query uses only the approval columns that exist', () => {
  const both = plansFor('incident').plans.find((p) => p.probe.id === 'approver');
  assert.equal(both.query, `sysapproval=${ID}^ORdocument_id=${ID}^ORDERBYDESCsys_created_on`);
  const noDoc = plansFor('incident', { schema: schemaFor('incident', { dropColumns: { sysapproval_approver: ['document_id'] } }) }).plans.find((p) => p.probe.id === 'approver');
  assert.equal(noDoc.query, `sysapproval=${ID}^ORDERBYDESCsys_created_on`);
  const neither = plansFor('incident', { schema: schemaFor('incident', { dropColumns: { sysapproval_approver: ['document_id', 'sysapproval'] } }) }).plans.find((p) => p.probe.id === 'approver');
  assert.equal(neither.status, 'error', 'with neither column there is nothing safe to ask');
});

test('the second-stage reads wait for the ids from the first stage', () => {
  const schema = schemaFor('incident');
  const traits = P.tableTraits('incident', schema.chain('incident'));
  const exec = P.PROBES.find((p) => p.id === 'wfExecuting');
  assert.equal(P.planProbes({ probes: [exec], sysId: ID, schema, traits, ids: [] })[0].status, 'skipped');
  assert.equal(P.planProbes({ probes: [exec], sysId: ID, schema, traits, ids: [hex(30), hex(31)] })[0].query, `contextIN${hex(30)},${hex(31)}^ORDERBYsys_created_on`);
});

test('when the dictionary cannot be read nothing is assumed to be missing, and the schema says it is unverified', () => {
  const unverified = P.buildSchema({ objectRows: [], dictRows: [], primary: 'incident' });
  assert.equal(unverified.trusted, false);
  assert.equal(unverified.exists('anything'), true);
  const traits = P.tableTraits('incident', unverified.chain('incident'));
  assert.equal(traits.isTask, null);
  const plans = P.planProbes({ sysId: ID, schema: unverified, traits, ids: [] });
  assert.equal(plans.find((p) => p.probe.id === 'sla').status, 'run', 'unknown hierarchy: try it');
});

test('the schema knows inherited columns and trusts itself only when it can see the table on screen', () => {
  const schema = schemaFor('incident');
  assert.equal(schema.trusted, true);
  assert.deepEqual(schema.chain('incident'), ['incident', 'task']);
  assert.equal(schema.has('incident', 'parent'), true, 'parent is defined on task');
  assert.equal(schema.has('sc_task', 'request_item'), true);
  assert.equal(schema.has('incident', 'no_such_column'), false);
  assert.equal(schema.exists('no_such_table'), false);
});

test('rows that do not belong to the record mean the filter was ignored, which is an error and never an empty list', () => {
  const probe = P.PROBES.find((p) => p.id === 'sla');
  const ctx = { sysId: ID, ids: [] };
  const mine = SLA;
  const stranger = row({ sys_id: hex(22), sla: 'Someone else', task: hex(999) });
  const ok = P.runProbe(probe, [mine], ctx);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.items.length, 1);
  const bad = P.runProbe(probe, [mine, stranger], ctx);
  assert.equal(bad.status, 'error');
  assert.match(bad.note, /did not apply the filter/);
  assert.deepEqual(bad.items, []);
  assert.equal(P.runProbe(probe, [], ctx).status, 'ok', 'no rows at all is a real empty answer');
});

test('read errors say what happened in the words of this panel', () => {
  assert.deepEqual(P.classifyReadError(new Error('Your user is not allowed to do this (403): User Not Authorized.'), 'wf_context'), { status: 'denied', note: 'Your user cannot read wf_context.' });
  assert.deepEqual(P.classifyReadError(new Error('Table API query on "wf_context" failed (400): Invalid table wf_context'), 'wf_context'), { status: 'missing', note: 'wf_context is not on this instance.' });
  const other = P.classifyReadError(new Error('Table API query on "task" failed (500): boom'), 'task');
  assert.equal(other.status, 'error');
  assert.match(other.note, /^Could not read task: /);
  const expired = P.classifyReadError(Object.assign(new Error('Your ServiceNow session has expired.'), { code: 'SESSION_EXPIRED' }), 'task');
  assert.equal(expired.sessionExpired, true);
});

// --- The sections the panel draws --------------------------------------------------------------------------------------

test('the report for a stuck incident has every section, counts and badges', () => {
  const r = report();
  assert.equal(r.record.label, 'INC0010042');
  assert.deepEqual(r.sections.map((s) => s.id), ['flows', 'approvals', 'slas', 'tasks', 'workflow', 'events']);
  const flows = r.sections.find((s) => s.id === 'flows');
  assert.equal(flows.count, 3);
  assert.deepEqual(flows.badges.map((b) => `${b.count} ${b.text} ${b.tone}`), ['1 Failed danger', '1 Running info', '1 Complete ok']);
  assert.equal(flows.attention, true);
  const approvals = r.sections.find((s) => s.id === 'approvals');
  assert.deepEqual(approvals.badges, [{ tone: 'warn', text: 'Waiting', count: 1 }]);
  const sla = r.sections.find((s) => s.id === 'slas');
  assert.equal(sla.rows[0].badge.text, 'Breached');
  assert.equal(sla.rows[0].badge.tone, 'danger');
  const wf = r.sections.find((s) => s.id === 'workflow');
  assert.equal(wf.rows[0].badge.text, 'Possibly stuck');
  assert.equal(wf.rows[0].headline, 'In "Wait for change approval" for 40 days');
  const events = r.sections.find((s) => s.id === 'events');
  assert.equal(events.count, 0);
  assert.equal(events.status, 'ok');
});

test('a row has its exact time for the hover, the record link and the error without opening anything', () => {
  const flows = report().sections.find((s) => s.id === 'flows');
  const failed = flows.rows.find((x) => x.badge.text === 'Failed');
  assert.equal(failed.href, `/sys_flow_context.do?sys_id=${hex(1)}`);
  assert.match(failed.error, /assigned_to is null/);
  assert.equal(failed.times[0].label, 'Started');
  assert.equal(P.exactTime(failed.times[0].when), `${failed.times[0].when} UTC`);
  assert.equal(P.relativeTime(failed.times[0].when, NOW), '2 days ago');
});

test('a flow with no recorded error still shows that fact', () => {
  const flow = P.normaliseFlow(row({ sys_id: hex(9), name: 'Quiet failure', state: 'ERROR', sys_created_on: stamp(HOUR), sys_updated_on: stamp(HOUR) }));
  assert.match(P.presentItem(flow, NOW).error, /no error message recorded/);
});

test('pending approvals read "waiting for X for 3 days"', () => {
  const rows = report().sections.find((s) => s.id === 'approvals').rows;
  assert.equal(rows[0].headline, 'Waiting for Abel Tuter for 3 days');
  assert.equal(rows[0].badge.text, 'Waiting');
});

test('a section that could not be read has no rows and says why', () => {
  const r = report({ approver: { status: 'denied', note: 'Your user cannot read sysapproval_approver.', items: [] } });
  const s = r.sections.find((x) => x.id === 'approvals');
  assert.equal(s.status, 'denied');
  assert.equal(s.rows.length, 0);
  assert.equal(s.attention, true);
  assert.match(s.note, /cannot read/);
});

test('badges list the urgent ones first', () => {
  const rows = [
    { badge: { text: 'Complete', tone: 'ok' } },
    { badge: { text: 'Complete', tone: 'ok' } },
    { badge: { text: 'Waiting', tone: 'warn' } },
    { badge: { text: 'Failed', tone: 'danger' } },
  ];
  assert.deepEqual(P.sectionBadges(rows).map((b) => `${b.count} ${b.text}`), ['1 Failed', '1 Waiting', '2 Complete']);
});

// --- Markdown ----------------------------------------------------------------------------------------------------------

test('the Markdown summary leads with the verdict and keeps every number and message', () => {
  const md = P.processMarkdown(report(), { instance: 'dev12345.service-now.com' });
  assert.match(md, /^# Flows, approvals and SLAs: INC0010042 \(incident\)/);
  assert.match(md, /Read 2026-10-23 10:00 UTC on dev12345\.service-now\.com\. Times below are UTC\./);
  assert.match(md, /\*\*Waiting on: the flow "Notify assignment group", which failed 2 days ago\*\*/);
  assert.match(md, /Also:\n- approval from Abel Tuter/);
  assert.match(md, /## Flow Designer \(3\)/);
  assert.match(md, /- \*\*Failed\*\* Notify assignment group - started .* UTC \(2 days ago\)/);
  assert.match(md, /Error: Value for data pill Trigger\.Record\.assigned_to is null/);
  assert.match(md, /## Approvals \(1\)/);
  assert.match(md, /Waiting for Abel Tuter for 3 days/);
  assert.match(md, /## SLAs \(1\)\n\n- \*\*Breached\*\* P1 resolution 4h/);
  assert.match(md, /## Queued events \(0\)\n\nNone\./);
  assert.ok(!/\n{3,}/.test(md));
});

test('the Markdown says plainly what could not be read and what does not apply', () => {
  const r = report({ approver: { status: 'denied', note: 'Your user cannot read sysapproval_approver.', items: [] } }, { table: 'sys_user', record: { label: 'abel.tuter' } });
  const md = P.processMarkdown(r);
  assert.match(md, /Could not read:\n- Approvals: Your user cannot read sysapproval_approver\./);
  assert.match(md, /## Approvals\n\nCould not read: Your user cannot read sysapproval_approver\./);
  assert.match(md, /## SLAs\n\nNot applicable: /);
});

// --- Requirements for the Self-check panel -----------------------------------------------------------------------------

test('the requirements list names every table the feature reads, with its condition columns', () => {
  assert.ok(Array.isArray(REQUIREMENTS) && REQUIREMENTS.length > 0);
  REQUIREMENTS.forEach((r) => {
    assert.equal(r.feature, 'Flows, approvals and SLAs');
    assert.ok(P.TABLE_RE.test(r.table), r.table);
    assert.ok(Array.isArray(r.columns) && r.columns.length, r.table);
  });
  const tables = new Set(REQUIREMENTS.map((r) => r.table));
  P.PROBES.forEach((probe) => assert.ok(tables.has(probe.table), `${probe.table} is read but not listed`));
  P.PROBES.forEach((probe) => {
    const listed = REQUIREMENTS.filter((r) => r.table === probe.table).flatMap((r) => r.columns);
    [...(probe.need || []), ...(probe.needAny || [])].forEach((c) => assert.ok(listed.includes(c), `${probe.table}.${c} is used in a condition but not listed`));
  });
});

// --- The whole read, against the preview fixture ---------------------------------------------------------------------
// src/content/processView.js is run end to end with fetch answered by preview/fixtures/process.js, so the order of the
// reads (dictionary first, then the record's own tables, then the contexts found), the queries and the report are all real.

async function loadWith(variantName, { table = 'incident', sysId = ID } = {}) {
  const fixture = require('../preview/fixtures/process.js');
  const { processLoad } = require('../src/content/processView.js');
  const realFetch = global.fetch;
  const realDocument = global.document;
  const realLocation = global.location;
  const requests = [];
  global.document = { querySelector: (selector) => (selector.includes('sysparm_ck') ? { value: 'test-token' } : null), getElementById: () => null, scripts: [], addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };
  global.location = { search: variantName ? `?proc=${variantName}` : '', host: 'dev12345.service-now.com' };
  global.fetch = async (path) => {
    const url = new URL(path, 'https://dev12345.service-now.com');
    requests.push({ table: url.pathname.split('/').pop(), query: url.searchParams.get('sysparm_query') || '', fields: url.searchParams.get('sysparm_fields') || '', limit: url.searchParams.get('sysparm_limit') || '' });
    const answered = fixture.route('GET', url, null);
    if (answered) return answered;
    // The record itself (everything the fixture does not own).
    const field = (value) => ({ value, display_value: value });
    return new Response(JSON.stringify({ result: [{ number: field('INC0010042'), short_description: field('Laptop will not boot'), active: field('true') }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const report = await processLoad({ table, sysId });
    return { report, requests };
  } finally {
    global.fetch = realFetch;
    global.document = realDocument;
    global.location = realLocation;
  }
}

test('end to end: the stuck incident is read in the right order and explained', async () => {
  const { report, requests } = await loadWith('');
  assert.equal(report.summary.level, 'blocked');
  assert.match(report.summary.headline, /^Waiting on: the flow "Notify assignment group", which failed 2 days ago$/);
  assert.deepEqual(report.summary.also.map((b) => b.kind), ['approvalPending', 'workflowWait', 'tasksOpen', 'slaBreached']);
  assert.equal(report.schemaTrusted, true);
  assert.equal(report.record.label, 'INC0010042');
  assert.deepEqual(report.sections.map((s) => `${s.id}:${s.status}:${s.count}`), ['flows:ok:4', 'approvals:ok:2', 'slas:ok:2', 'tasks:ok:2', 'workflow:ok:2', 'events:ok:0']);
  const flows = report.sections.find((s) => s.id === 'flows');
  assert.equal(flows.rows[0].lines.length, 3, 'the log of the failed flow was found through its context id');
  assert.equal(report.sections.find((s) => s.id === 'workflow').rows[0].lines.length, 4, 'and the workflow history through its context id');

  // Order: the dictionary before anything else, the second stage after the first.
  const tables = requests.map((r) => r.table);
  assert.equal(tables[0], 'sys_db_object');
  assert.ok(tables.indexOf('sys_dictionary') < tables.indexOf('sys_flow_context'));
  assert.ok(tables.indexOf('wf_context') < tables.indexOf('wf_executing'));
  assert.ok(tables.indexOf('sys_flow_context') < tables.lastIndexOf('sys_flow_log'));
});

test('end to end: no read of a table that belongs to the record is ever unscoped', async () => {
  const { requests } = await loadWith('');
  const owned = new Set(P.PROBES.map((p) => p.table));
  const reads = requests.filter((r) => owned.has(r.table) && !['sys_db_object', 'sys_dictionary'].includes(r.table));
  assert.ok(reads.length >= 8, 'every source was read');
  // The only unfiltered read is the one-row, one-column "can this user see the table at all?" check.
  const confirm = (r) => r.query === '' && r.fields === 'sys_id' && r.limit === '1';
  reads.filter((r) => !confirm(r)).forEach((r) => assert.ok(r.query.includes(ID) || /^contextIN/.test(r.query), `${r.table}: ${r.query}`));
  assert.deepEqual(reads.filter(confirm).map((r) => r.table), ['sysevent'], 'only the empty source (events) was confirmed');
});

test('end to end: tables hidden by an ACL (no rows, no error) are "could not tell", never "nothing is running"', async () => {
  const { report, requests } = await loadWith('hidden');
  assert.notEqual(report.summary.level, 'clear');
  assert.equal(report.summary.level, 'partial');
  assert.deepEqual(report.sections.filter((s) => s.status === 'denied').map((s) => s.id), ['flows', 'approvals', 'workflow']);
  assert.match(report.summary.unreadable.map((u) => u.text).join(' '), /sees no rows of sys_flow_context at all/);
  // One confirmation per empty primary source, never more.
  const confirms = requests.filter((r) => r.query === '' && r.fields === 'sys_id');
  assert.equal(confirms.length, new Set(confirms.map((r) => r.table)).size);
  assert.ok(confirms.length <= 5);
});

test('a group approval that hangs off the record through parent is an approval, not an open child task', () => {
  const probe = P.PROBES.find((p) => p.id === 'childTasks');
  assert.match(probe.query({ sysId: ID }), /sys_class_name!=sysapproval_group/);
  const groupApproval = row({ sys_id: hex(40), number: 'GAPV0001', state: 'requested', active: 'true', sys_class_name: 'sysapproval_group', parent: ID });
  const child = row({ sys_id: hex(41), number: 'INC0010050', state: '2', active: 'true', sys_class_name: 'incident', parent: ID });
  const result = P.runProbe(probe, [groupApproval, child], { sysId: ID });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.items.map((t) => t.number), ['INC0010050']);
});

test('an event scheduled for later is not a backlog; a due one waits from its process_on', () => {
  const ev = (fields) => P.normaliseEvent(row({ sys_id: hex(50), name: 'sla.warning', state: 'ready', instance: ID, ...fields }));
  const scheduled = ev({ sys_created_on: stamp(3 * DAY), process_on: ahead(2 * HOUR) });
  assert.deepEqual(P.findBlockers({ events: [scheduled] }, NOW), []);
  const shown = P.presentItem(scheduled, NOW);
  assert.equal(shown.badge.text, 'Scheduled');
  assert.equal(shown.attention, false);
  assert.match(shown.headline, /Scheduled to be processed in 2 h/);
  const due = ev({ sys_created_on: stamp(3 * DAY), process_on: stamp(10 * MIN) });
  const blockers = P.findBlockers({ events: [due] }, NOW);
  assert.equal(blockers[0].kind, 'eventsQueued');
  assert.match(blockers[0].text, /sla\.warning \(10 min\)/);
  // The events probe keeps only ready and queued rows: a processed one means the state filter was ignored.
  const probe = P.PROBES.find((p) => p.id === 'events');
  assert.equal(P.runProbe(probe, [row({ sys_id: hex(51), name: 'x', state: 'processed', instance: ID })], { sysId: ID }).status, 'error');
});

test('an old rejection is not "waiting on" once a later approval was given', () => {
  const approval = (n, state, updatedAgo) => P.normaliseApproval(row({ sys_id: hex(60 + n), approver: hex(90 + n), state, sysapproval: ID, sys_created_on: stamp(updatedAgo + HOUR), sys_updated_on: stamp(updatedAgo) }, { approver: `Approver ${n}` }));
  const rejectedThenApproved = P.assembleApprovals([approval(1, 'rejected', 5 * DAY), approval(2, 'approved', 2 * DAY)]);
  assert.equal(P.findBlockers({ approvals: rejectedThenApproved }, NOW).some((b) => b.kind === 'approvalRejected'), false);
  const stillRejected = P.assembleApprovals([approval(1, 'approved', 5 * DAY), approval(2, 'rejected', 2 * DAY)]);
  const b = P.findBlockers({ approvals: stillRejected }, NOW).find((x) => x.kind === 'approvalRejected');
  assert.ok(b);
  assert.match(b.text, /Approver 2 rejected/);
});

test('a faulted legacy workflow is shown as failed, not as an unknown state', () => {
  assert.equal(P.workflowState('faulted', 'Faulted').key, 'error');
});

test('end to end: a source that answers 403 is a note and the rest still load', async () => {
  const { report } = await loadWith('denied');
  assert.equal(report.summary.level, 'blocked');
  assert.deepEqual(report.sections.filter((s) => s.status === 'denied').map((s) => s.id), ['approvals', 'events']);
  assert.deepEqual(report.summary.unreadable.map((u) => u.text), ['Your user cannot read sysapproval_approver.', 'Your user cannot read sysevent.']);
  assert.equal(report.sections.find((s) => s.id === 'flows').count, 4);
});

test('end to end: tables missing from the instance are said to be missing, not to be empty', async () => {
  const { report } = await loadWith('nowf');
  const wf = report.sections.find((s) => s.id === 'workflow');
  assert.equal(wf.status, 'missing');
  assert.equal(wf.note, 'wf_context is not on this instance.');
  assert.equal(wf.count, 0);
});

test('end to end: an unreadable dictionary falls back to checking every answer', async () => {
  const { report, requests } = await loadWith('nodict');
  assert.equal(report.schemaTrusted, false);
  assert.match(report.schemaNote, /data dictionary could not be read/);
  assert.equal(report.sections.find((s) => s.id === 'flows').count, 4);
  assert.ok(!requests.some((r) => r.table === 'sys_dictionary'), 'no dictionary read when the object table showed nothing');
});

test('end to end: a filter the instance ignored is reported, not shown as an empty or a full list', async () => {
  const { report } = await loadWith('filter');
  const flows = report.sections.find((s) => s.id === 'flows');
  assert.equal(flows.status, 'error');
  assert.match(flows.note, /did not apply the filter/);
  assert.equal(flows.count, 0);
  assert.equal(report.summary.level, 'blocked', 'the other sources still answer');
});

test('end to end: a user record has flows and approvals but no SLAs or tasks to read', async () => {
  const { report, requests } = await loadWith('', { table: 'sys_user', sysId: 'a8f98bb0eb32010045e1a5115206fe3a' });
  assert.deepEqual(report.sections.filter((s) => s.status === 'na').map((s) => s.id), ['slas', 'tasks']);
  assert.ok(!requests.some((r) => r.table === 'task_sla' || r.table === 'task'), 'not asked at all');
  assert.equal(report.summary.level, 'clear');
});

test('end to end: quiet and empty records say so', async () => {
  const quietReport = (await loadWith('quiet')).report;
  assert.equal(quietReport.summary.headline, 'Nothing is running on this record');
  assert.equal(quietReport.summary.detail, 'Finished earlier: 2 flows, 1 approval, 1 SLA, 1 task, 1 workflow.');
  const emptyReport = (await loadWith('empty')).report;
  assert.equal(emptyReport.summary.level, 'clear');
  assert.equal(emptyReport.summary.detail, 'No flows, approvals, SLAs, tasks, workflows or events were found for this record.');
});

test('end to end: a bad record is refused before anything is read', async () => {
  const { processLoad } = require('../src/content/processView.js');
  await assert.rejects(() => processLoad({ table: 'incident', sysId: 'nope' }), /Open a saved record/);
  await assert.rejects(() => processLoad({ table: 'Bad Table', sysId: ID }), /Open a saved record/);
});
