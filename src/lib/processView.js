// "Why is this ticket stuck?" (/flows), the pure half. Everything that can be running or can have run against a record is
// scattered over Flow Designer executions, legacy workflow contexts, approvals, SLAs, child tasks and queued events.
// This file says where each one is looked for (PROBES), checks that the tables and columns exist before asking,
// turns every row shape into one common shape, works out what the record is waiting on and in what words, and writes
// the Markdown summary. No DOM and no network, so it is all unit-tested (tests/processview.test.js).
// The instance half is src/content/processView.js; the panel is src/sidebar/ProcessPanel.jsx.
//
// ServiceNow silently ignores a condition on a column that does not exist and then returns every row. Two guards:
// the columns used in a condition are checked against the dictionary first (buildSchema / planProbes), and every row
// that comes back is checked against the record again (runProbe), so a wrong column becomes a visible "could not
// check", never a quiet "nothing here".

import { raw, disp, parseGlideTime } from './failures.js';

export { raw, disp, parseGlideTime };

export const SYS_ID_RE = /^[0-9a-f]{32}$/i;
export const TABLE_RE = /^[a-z][a-z0-9_]*$/;

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** When a wait starts to look wrong. Plain numbers so the wording and the tests agree. */
export const THRESHOLDS = {
  flowQueued: 15 * MIN, // a queued flow that has not started
  flowRunning: HOUR, // a flow still running
  waiting: DAY, // a flow or workflow wait: "possibly stuck"
  stuck: 7 * DAY, // ... "very likely stuck"
  event: 5 * MIN, // an event nobody has processed
};

const clip = (text, max = 160) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const num = (v) => {
  const n = Number.parseFloat(raw(v));
  return Number.isFinite(n) ? n : NaN;
};
const isTrue = (v) => raw(v).toLowerCase() === 'true';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const at = (when) => parseGlideTime(when);

/** A { table, sysId } pair when the id is a real sys_id, else null. */
export function target(table, sysId) {
  return TABLE_RE.test(table || '') && SYS_ID_RE.test(sysId || '') ? { table, sysId } : null;
}

/** Path of a record's form. */
export function recordPath(t) {
  return t && TABLE_RE.test(t.table || '') && SYS_ID_RE.test(t.sysId || '') ? `/${t.table}.do?sys_id=${t.sysId}` : '';
}

// --- Time ---------------------------------------------------------------------------------------------

/** Milliseconds since `when` (a ServiceNow date-time, UTC), NaN when it is not one. */
export function ageMs(when, now = Date.now()) {
  const t = at(when);
  return Number.isFinite(t) ? now - t : NaN;
}

/** "under a minute", "12 min", "5 h", "3 days", "4 months". Direction is not part of it. */
export function formatAge(ms) {
  if (!Number.isFinite(ms)) return '';
  const abs = Math.abs(ms);
  if (abs < 45 * 1000) return 'under a minute';
  const minutes = Math.round(abs / MIN);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(abs / HOUR);
  if (hours < 48) return `${hours} h`;
  const days = Math.round(abs / DAY);
  if (days < 100) return `${days} days`;
  return `${Math.round(days / 30)} months`;
}

/** "3 days ago", "in 40 min", "just now"; '' for something that is not a date. */
export function relativeTime(when, now = Date.now()) {
  const ms = ageMs(when, now);
  if (!Number.isFinite(ms)) return '';
  if (Math.abs(ms) < MIN) return 'just now';
  return ms > 0 ? `${formatAge(ms)} ago` : `in ${formatAge(ms)}`;
}

/** The exact stamp for a hover title. Instance times are stored in UTC. */
export function exactTime(when) {
  return Number.isFinite(at(when)) ? `${String(when).trim()} UTC` : '';
}

/** Run time between two stamps, in the same words as ages; '' when either is missing or out of order. */
export function runTime(start, end) {
  const a = at(start);
  const b = at(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
  const seconds = Math.round((b - a) / 1000);
  if (seconds < 60) return `${seconds} s`;
  return formatAge(b - a);
}

// --- States -------------------------------------------------------------------------------------------

const words = (rawState, displayState) => `${rawState || ''} ${displayState || ''}`.toLowerCase().replace(/[_-]+/g, ' ');

const FLOW_LABELS = { error: 'Failed', cancelled: 'Cancelled', complete: 'Complete', waiting: 'Waiting', queued: 'Queued', running: 'Running', other: 'Unknown' };

/** Flow Designer context state -> { key, label }. Seen on instances: QUEUED, IN_PROGRESS, WAITING, COMPLETE, CANCELLED, ERROR. */
export function flowState(rawState, displayState = '') {
  const t = words(rawState, displayState);
  let key = 'other';
  if (/\b(error|fail\w*)\b/.test(t)) key = 'error';
  else if (/cancel/.test(t)) key = 'cancelled';
  else if (/complet|finish|success/.test(t)) key = 'complete';
  else if (/wait|paus|sleep/.test(t)) key = 'waiting';
  else if (/queue|ready|pending/.test(t)) key = 'queued';
  else if (/progress|running|execut|start/.test(t)) key = 'running';
  return { key, label: key === 'other' ? clip(displayState || rawState, 24) || FLOW_LABELS.other : FLOW_LABELS[key] };
}

const WORKFLOW_LABELS = { executing: 'Running', finished: 'Finished', cancelled: 'Cancelled', error: 'Failed', other: 'Unknown' };

/** Legacy workflow context state -> { key, label, active }. wf_context.state: executing, finished, cancelled. */
export function workflowState(rawState, displayState = '') {
  const t = words(rawState, displayState);
  let key = 'other';
  if (/error|fail|fault/.test(t)) key = 'error';
  else if (/cancel/.test(t)) key = 'cancelled';
  else if (/finish|complet/.test(t)) key = 'finished';
  else if (/execut|running|wait|progress|start/.test(t)) key = 'executing';
  return { key, label: key === 'other' ? clip(displayState || rawState, 24) || WORKFLOW_LABELS.other : WORKFLOW_LABELS[key], active: key === 'executing' };
}

const APPROVAL_LABELS = { pending: 'Waiting', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', notyet: 'Not yet requested', notrequired: 'No longer required', other: 'Unknown' };

/** sysapproval_approver.state -> { key, label }. Values: requested, approved, rejected, cancelled, not_required, "not requested". */
export function approvalState(rawState, displayState = '') {
  const t = words(rawState, displayState);
  let key = 'other';
  if (/not (yet )?requested/.test(t)) key = 'notyet';
  else if (/no longer required|not required/.test(t)) key = 'notrequired';
  else if (/reject/.test(t)) key = 'rejected';
  else if (/cancel/.test(t)) key = 'cancelled';
  else if (/approved/.test(t)) key = 'approved';
  else if (/request|waiting|pending/.test(t)) key = 'pending';
  return { key, label: key === 'other' ? clip(displayState || rawState, 24) || APPROVAL_LABELS.other : APPROVAL_LABELS[key] };
}

/** task_sla.stage -> a key. Values: in_progress, paused, breached, achieved, cancelled. */
export function slaStage(rawStage, displayStage = '') {
  const t = words(rawStage, displayStage);
  if (/breach/.test(t)) return 'breached';
  if (/achiev|complet|met\b/.test(t)) return 'achieved';
  if (/cancel/.test(t)) return 'cancelled';
  if (/paus/.test(t)) return 'paused';
  if (/progress|running|active/.test(t)) return 'in_progress';
  return 'other';
}

// --- Plain-language reasons ---------------------------------------------------------------------------

const firstMatch = (text, table) => table.find(([re]) => re.test(text))?.[1] || '';

// The same reasons the "What went wrong?" panel gives for a failed flow (src/lib/failures.js).
const FLOW_REASONS = [
  [/acl|security|not authorized|permission|access denied|insufficient/i, 'The flow ran as a user who may not touch something it used.'],
  [/time ?out|timed out/i, 'A step took too long.'],
  [/null|undefined|empty|no value|not set/i, 'A step used a value that was empty (a data pill with nothing in it).'],
  [/not found|no record|does not exist|cannot find/i, 'A step looked for a record that is not there.'],
  [/inactive|deactivated|not published|not active/i, 'A flow or action it depends on is inactive or not published.'],
];
const NO_ERROR_TEXT = '(no error message recorded; open the execution to see which step stopped)';

const WAIT_TEXT = {
  approval: 'It is waiting for an approval to be decided.',
  task: 'It is waiting for a task to be closed.',
  timer: 'It is waiting on a timer.',
  condition: 'It is waiting for a condition on the record to become true. The condition is checked again when the record is updated, so check it against the record as it is now.',
  other: 'It is running this activity.',
};

/** What a workflow activity is waiting for, from its name and its activity type. */
export function waitKind(activity, definition = '') {
  const t = `${definition} ${activity}`.toLowerCase();
  if (/approv/.test(t)) return 'approval';
  if (/timer|duration|sleep/.test(t)) return 'timer';
  if (/\btask\b|catalog task|create task/.test(t)) return 'task';
  if (/wait for|condition|\bwait\b/.test(t)) return 'condition';
  return 'other';
}

// --- Row -> common shape ------------------------------------------------------------------------------
// Rows come from the Table API with sysparm_display_value=all: every value is { value, display_value } (or a plain
// string in tests). `raw` is the stored value (dates in UTC, references as sys_ids), `disp` what a person sees.

export function normaliseFlow(row) {
  const sysId = raw(row.sys_id);
  const state = flowState(raw(row.state), disp(row.state));
  // `flow` is a plain string (a sys_id) on a flow context, so a bare id means the name could not be looked up.
  const known = disp(row.name) || disp(row.flow);
  const name = clip(/^[0-9a-f]{32}$/i.test(known) ? '' : known, 100) || '(unnamed flow)';
  const started = raw(row.started) || raw(row.sys_created_on);
  const finished = ['complete', 'error', 'cancelled'].includes(state.key);
  const ended = raw(row.ended) || (finished ? raw(row.sys_updated_on) : '');
  const error = clip(disp(row.error_message), 600);
  return {
    kind: 'flow',
    id: `flow:${sysId}`,
    sysId,
    name,
    state: state.key,
    stateLabel: state.label,
    stateText: disp(row.state),
    error,
    hint: error ? firstMatch(error, FLOW_REASONS) : '',
    started,
    ended,
    updated: raw(row.sys_updated_on),
    active: ['running', 'waiting', 'queued'].includes(state.key),
    sourceTable: raw(row.source_table),
    superseded: false,
    log: [],
    target: target('sys_flow_context', sysId),
  };
}

export function normaliseFlowLog(row) {
  return { contextId: raw(row.context), message: clip(disp(row.message), 300), level: disp(row.level), when: raw(row.sys_created_on) };
}

export function normaliseWorkflowContext(row) {
  const sysId = raw(row.sys_id);
  const state = workflowState(raw(row.state), disp(row.state));
  return {
    kind: 'workflow',
    id: `workflow:${sysId}`,
    sysId,
    name: clip(disp(row.workflow_version) || disp(row.name), 100) || '(unnamed workflow)',
    state: state.key,
    stateLabel: state.label,
    active: state.active,
    started: raw(row.started) || raw(row.sys_created_on),
    ended: raw(row.ended),
    executing: [],
    history: [],
    target: target('wf_context', sysId),
  };
}

export function normaliseExecuting(row) {
  const activity = clip(disp(row.activity), 100) || '(unnamed activity)';
  const definition = clip(disp(row['activity.activity_definition']), 60);
  const kind = waitKind(activity, definition);
  return { contextId: raw(row.context), activity, definition, state: disp(row.state), since: raw(row.started) || raw(row.sys_created_on), wait: kind, isWait: kind !== 'other' };
}

export function normaliseHistory(row) {
  return {
    contextId: raw(row.context),
    activity: clip(disp(row.activity), 100) || '(unnamed activity)',
    state: disp(row.state),
    result: clip(disp(row.result), 100),
    started: raw(row.started) || raw(row.sys_created_on),
    ended: raw(row.ended),
    fault: clip(disp(row.fault_description), 300),
    index: num(row.activity_index),
  };
}

export function normaliseApproval(row) {
  const sysId = raw(row.sys_id);
  const state = approvalState(raw(row.state), disp(row.state));
  const approver = clip(disp(row.approver), 80);
  const group = clip(disp(row.group), 80);
  return {
    kind: 'approval',
    id: `approval:${sysId}`,
    sysId,
    who: approver || group || '(nobody assigned)',
    approver,
    group,
    state: state.key,
    stateLabel: state.label,
    comments: clip(disp(row.comments), 300),
    created: raw(row.sys_created_on),
    updated: raw(row.sys_updated_on),
    due: raw(row.due_date),
    target: target('sysapproval_approver', sysId),
  };
}

/** A group approval record (sysapproval_group extends task): shown with the approvals, never counted twice. */
export function normaliseGroupApproval(row) {
  const sysId = raw(row.sys_id);
  const state = approvalState(raw(row.approval), disp(row.approval));
  const group = clip(disp(row.assignment_group), 80);
  return {
    kind: 'groupApproval',
    id: `groupApproval:${sysId}`,
    sysId,
    who: group || clip(disp(row.number), 40) || '(a group)',
    group,
    number: clip(disp(row.number), 40),
    state: state.key,
    stateLabel: state.label,
    comments: '',
    created: raw(row.sys_created_on),
    updated: raw(row.sys_updated_on),
    due: '',
    target: target('sysapproval_group', sysId),
  };
}

export function normaliseSla(row) {
  const sysId = raw(row.sys_id);
  const stage = slaStage(raw(row.stage), disp(row.stage));
  // business_percentage follows the SLA's schedule (it equals percentage when there is none); the plain percentage
  // counts nights and weekends, so it passes 100 long before an 8-to-5 SLA breaches.
  const business = Number.isFinite(num(row.business_percentage));
  const percentage = business ? num(row.business_percentage) : num(row.percentage);
  return {
    kind: 'sla',
    id: `sla:${sysId}`,
    sysId,
    name: clip(disp(row.sla), 100) || '(unnamed SLA)',
    stage,
    stageText: disp(row.stage),
    breached: isTrue(row.has_breached) || stage === 'breached',
    // 'false' read from the instance is a real "not breached"; '' (column not read) is not.
    breachKnown: raw(row.has_breached) !== '',
    percentage,
    businessPercentage: business,
    plannedEnd: raw(row.planned_end_time),
    started: raw(row.start_time) || raw(row.sys_created_on),
    ended: raw(row.end_time),
    pausedAt: raw(row.pause_time),
    updated: raw(row.sys_updated_on),
    done: stage === 'achieved' || stage === 'cancelled',
    target: target('task_sla', sysId),
  };
}

export function normaliseTask(row, fallbackTable = 'task') {
  const sysId = raw(row.sys_id);
  const table = TABLE_RE.test(raw(row.sys_class_name)) ? raw(row.sys_class_name) : fallbackTable;
  const stateText = clip(disp(row.state), 40);
  const activeRaw = raw(row.active);
  const open = activeRaw ? activeRaw.toLowerCase() === 'true' : !/closed|complete|cancel|resolved|skipped/i.test(stateText);
  return {
    kind: 'task',
    id: `task:${sysId}`,
    sysId,
    table,
    typeLabel: table === fallbackTable ? '' : clip(String(row.sys_class_name?.display_value || ''), 40),
    number: clip(disp(row.number), 40) || '(no number)',
    summary: clip(disp(row.short_description), 140),
    stateText,
    open,
    assignedTo: clip(disp(row.assigned_to), 60),
    group: clip(disp(row.assignment_group), 60),
    created: raw(row.sys_created_on),
    updated: raw(row.sys_updated_on),
    target: target(table, sysId),
  };
}

export function normaliseEvent(row) {
  const sysId = raw(row.sys_id);
  return {
    kind: 'event',
    id: `event:${sysId}`,
    sysId,
    name: clip(disp(row.name), 80) || '(unnamed event)',
    state: raw(row.state).toLowerCase(),
    stateText: disp(row.state),
    queue: clip(disp(row.queue), 40),
    created: raw(row.sys_created_on),
    processOn: raw(row.process_on),
    target: target('sysevent', sysId),
  };
}

// --- Schema: what exists on this instance ---------------------------------------------------------------

/**
 * Which tables exist and which columns they have (inherited columns included), from sys_db_object and sys_dictionary
 * rows. `primary` is the table on screen: it certainly exists, so if the object rows do not contain it the dictionary
 * could not be read (an ACL hides rows, it does not raise an error) and the schema is not trusted.
 * @param {{ objectRows: Array, dictRows: Array, primary: string }} input
 */
export function buildSchema({ objectRows = [], dictRows = [], primary = '' } = {}) {
  const parent = new Map();
  objectRows.forEach((r) => {
    const name = raw(r.name);
    if (name) parent.set(name, raw(r['super_class.name']));
  });
  if (!primary || !parent.has(primary)) return unverifiedSchema();
  const columns = new Map();
  dictRows.forEach((r) => {
    const name = raw(r.name);
    const element = raw(r.element);
    if (!name || !element) return;
    if (!columns.has(name)) columns.set(name, new Set());
    columns.get(name).add(element);
  });
  const chain = (table) => {
    const out = [];
    let current = table;
    while (current && parent.has(current) && !out.includes(current)) {
      out.push(current);
      current = parent.get(current);
    }
    return out;
  };
  return {
    trusted: true,
    exists: (table) => parent.has(table),
    has: (table, column) => chain(table).some((t) => columns.get(t)?.has(column)),
    chain,
  };
}

/** Used when the dictionary cannot be read: every table and column is assumed to exist and each answer is checked instead. */
export function unverifiedSchema() {
  return { trusted: false, exists: () => true, has: () => true, chain: () => [] };
}

/** The "they extend" facts about the table on screen. `chain` is [] when it could not be read. */
export function tableTraits(table, chain = []) {
  const names = chain.length ? chain : [];
  return {
    table,
    chain: names,
    known: names.length > 0,
    isTask: names.length ? names.includes('task') : null,
    is: (t) => (names.length ? names.includes(t) : table === t),
  };
}

// --- What is read ----------------------------------------------------------------------------------------

const taskFields = ['sys_id', 'number', 'short_description', 'state', 'active', 'sys_class_name', 'assigned_to', 'assignment_group', 'sys_created_on', 'sys_updated_on'];

/**
 * One entry per table read. `need` columns must exist (they are used in the condition); `needAny` needs at least one.
 * `role`: primary (failing makes the section unreadable), detail (failing makes it partial) or optional (a note only).
 * `query` gets { sysId, has, ids } and returns an encoded query, or null when no safe query can be built.
 * `keep` is applied to every returned row again; a row that fails it means the instance ignored the condition.
 */
export const PROBES = [
  {
    id: 'flowContext',
    section: 'flows',
    role: 'primary',
    table: 'sys_flow_context',
    need: ['source_record'],
    fields: ['sys_id', 'name', 'flow', 'state', 'error_message', 'source_table', 'source_record', 'started', 'ended', 'sys_created_on', 'sys_updated_on'],
    limit: 25,
    query: ({ sysId }) => `source_record=${sysId}^ORDERBYDESCsys_created_on`,
    keep: (row, { sysId }) => raw(row.source_record) === sysId,
    normalise: normaliseFlow,
  },
  {
    id: 'flowLog',
    section: 'flows',
    role: 'optional',
    stage: 2,
    table: 'sys_flow_log',
    need: ['context', 'message'],
    fields: ['sys_id', 'context', 'message', 'level', 'sys_created_on'],
    limit: 60,
    query: ({ ids }) => (ids.length ? `contextIN${ids.join(',')}^ORDERBYsys_created_on` : null),
    keep: (row, { ids }) => ids.includes(raw(row.context)),
    normalise: normaliseFlowLog,
  },
  {
    id: 'approver',
    section: 'approvals',
    role: 'primary',
    table: 'sysapproval_approver',
    needAny: ['sysapproval', 'document_id'],
    fields: ['sys_id', 'approver', 'group', 'state', 'comments', 'due_date', 'sysapproval', 'document_id', 'sys_created_on', 'sys_updated_on'],
    limit: 30,
    query: ({ sysId, has }) => {
      const parts = ['sysapproval', 'document_id'].filter(has).map((c) => `${c}=${sysId}`);
      return parts.length ? `${parts.join('^OR')}^ORDERBYDESCsys_created_on` : null;
    },
    keep: (row, { sysId }) => raw(row.sysapproval) === sysId || raw(row.document_id) === sysId,
    normalise: normaliseApproval,
  },
  {
    id: 'groupApproval',
    section: 'approvals',
    role: 'optional',
    table: 'sysapproval_group',
    need: ['parent'],
    applies: (traits) => traits.isTask !== false,
    fields: ['sys_id', 'number', 'approval', 'assignment_group', 'parent', 'sys_created_on', 'sys_updated_on'],
    limit: 10,
    query: ({ sysId }) => `parent=${sysId}^ORDERBYDESCsys_created_on`,
    keep: (row, { sysId }) => raw(row.parent) === sysId,
    normalise: normaliseGroupApproval,
  },
  {
    id: 'sla',
    section: 'slas',
    role: 'primary',
    table: 'task_sla',
    need: ['task'],
    applies: (traits) => traits.isTask !== false,
    fields: ['sys_id', 'sla', 'stage', 'has_breached', 'percentage', 'business_percentage', 'planned_end_time', 'start_time', 'end_time', 'pause_time', 'task', 'sys_created_on', 'sys_updated_on'],
    limit: 20,
    query: ({ sysId }) => `task=${sysId}^ORDERBYDESCsys_created_on`,
    keep: (row, { sysId }) => raw(row.task) === sysId,
    normalise: normaliseSla,
  },
  {
    id: 'childTasks',
    section: 'tasks',
    role: 'primary',
    table: 'task',
    need: ['parent'],
    applies: (traits) => traits.isTask !== false,
    fields: taskFields.concat('parent'),
    limit: 40,
    // A group approval (sysapproval_group) extends task and points at the record through parent: it is an approval,
    // shown under Approvals, not an open child task.
    query: ({ sysId }) => `parent=${sysId}^sys_class_name!=sysapproval_group^ORDERBYDESCsys_created_on`,
    drop: (row) => raw(row.sys_class_name) === 'sysapproval_group',
    keep: (row, { sysId }) => raw(row.parent) === sysId,
    normalise: (row) => normaliseTask(row, 'task'),
  },
  {
    id: 'catalogTasks',
    section: 'tasks',
    role: 'detail',
    table: 'sc_task',
    need: ['request_item'],
    applies: (traits) => traits.is('sc_req_item'),
    fields: taskFields.concat('request_item'),
    limit: 40,
    query: ({ sysId }) => `request_item=${sysId}^ORDERBYDESCsys_created_on`,
    keep: (row, { sysId }) => raw(row.request_item) === sysId,
    normalise: (row) => normaliseTask(row, 'sc_task'),
  },
  {
    id: 'requestItems',
    section: 'tasks',
    role: 'detail',
    table: 'sc_req_item',
    need: ['request'],
    applies: (traits) => traits.is('sc_request'),
    fields: taskFields.concat('request'),
    limit: 40,
    query: ({ sysId }) => `request=${sysId}^ORDERBYDESCsys_created_on`,
    keep: (row, { sysId }) => raw(row.request) === sysId,
    normalise: (row) => normaliseTask(row, 'sc_req_item'),
  },
  {
    id: 'changeTasks',
    section: 'tasks',
    role: 'detail',
    table: 'change_task',
    need: ['change_request'],
    applies: (traits) => traits.is('change_request'),
    fields: taskFields.concat('change_request'),
    limit: 40,
    query: ({ sysId }) => `change_request=${sysId}^ORDERBYDESCsys_created_on`,
    keep: (row, { sysId }) => raw(row.change_request) === sysId,
    normalise: (row) => normaliseTask(row, 'change_task'),
  },
  {
    id: 'problemTasks',
    section: 'tasks',
    role: 'detail',
    table: 'problem_task',
    need: ['problem'],
    applies: (traits) => traits.is('problem'),
    fields: taskFields.concat('problem'),
    limit: 40,
    query: ({ sysId }) => `problem=${sysId}^ORDERBYDESCsys_created_on`,
    keep: (row, { sysId }) => raw(row.problem) === sysId,
    normalise: (row) => normaliseTask(row, 'problem_task'),
  },
  {
    id: 'wfContext',
    section: 'workflow',
    role: 'primary',
    table: 'wf_context',
    need: ['id'],
    fields: ['sys_id', 'workflow_version', 'name', 'table', 'id', 'state', 'started', 'ended', 'sys_created_on', 'sys_updated_on'],
    limit: 15,
    query: ({ sysId }) => `id=${sysId}^ORDERBYDESCsys_created_on`,
    keep: (row, { sysId }) => raw(row.id) === sysId,
    normalise: normaliseWorkflowContext,
  },
  {
    id: 'wfExecuting',
    section: 'workflow',
    role: 'detail',
    stage: 2,
    table: 'wf_executing',
    need: ['context'],
    fields: ['sys_id', 'context', 'activity', 'activity.activity_definition', 'state', 'started', 'sys_created_on'],
    limit: 30,
    query: ({ ids }) => (ids.length ? `contextIN${ids.join(',')}^ORDERBYsys_created_on` : null),
    keep: (row, { ids }) => ids.includes(raw(row.context)),
    normalise: normaliseExecuting,
  },
  {
    id: 'wfHistory',
    section: 'workflow',
    role: 'optional',
    stage: 2,
    table: 'wf_history',
    need: ['context'],
    fields: ['sys_id', 'context', 'activity', 'activity_index', 'state', 'result', 'started', 'ended', 'fault_description', 'sys_created_on'],
    limit: 100,
    query: ({ ids }) => (ids.length ? `contextIN${ids.join(',')}^ORDERBYDESCsys_created_on` : null),
    keep: (row, { ids }) => ids.includes(raw(row.context)),
    normalise: normaliseHistory,
  },
  {
    id: 'events',
    section: 'events',
    role: 'primary',
    table: 'sysevent',
    need: ['instance', 'state'],
    fields: ['sys_id', 'name', 'state', 'queue', 'instance', 'process_on', 'sys_created_on'],
    limit: 20,
    // State first: only a handful of events are ever ready, while the table holds millions of processed ones.
    query: ({ sysId }) => `stateINready,queued^instance=${sysId}^ORDERBYsys_created_on`,
    keep: (row, { sysId }) => raw(row.instance) === sysId && ['ready', 'queued'].includes(raw(row.state).toLowerCase()),
    normalise: normaliseEvent,
  },
];

export const SECTION_DEFS = [
  { id: 'flows', label: 'Flow Designer', hint: 'Flow executions run against this record', tables: 'sys_flow_context' },
  { id: 'approvals', label: 'Approvals', hint: 'Who has been asked to approve, and what they answered', tables: 'sysapproval_approver' },
  { id: 'slas', label: 'SLAs', hint: 'Service level agreements timing this task', tables: 'task_sla', naNote: 'SLAs only run on task records (incidents, changes, requests and so on)' },
  { id: 'tasks', label: 'Tasks', hint: 'Child tasks, and catalog tasks for a requested item', tables: 'task', naNote: 'Child tasks only hang off task records' },
  { id: 'workflow', label: 'Workflow (legacy)', hint: 'Workflow contexts and the activity each one is in', tables: 'wf_context' },
  { id: 'events', label: 'Queued events', hint: 'Events for this record that nobody has processed yet', tables: 'sysevent' },
];
export const sectionLabel = (id) => SECTION_DEFS.find((s) => s.id === id)?.label || id;

/** Every table and column the probes use, for one dictionary read. */
export function dictionaryNeeds() {
  const tables = new Set();
  const columns = new Set();
  PROBES.forEach((p) => {
    tables.add(p.table);
    [...(p.need || []), ...(p.needAny || [])].forEach((c) => columns.add(c));
  });
  return { tables: [...tables], columns: [...columns] };
}

/**
 * Decide, for a set of probes, which can run. Returns one entry each:
 *   { probe, status: 'run', query } | { probe, status: 'na' | 'skipped' | 'missing' | 'error', note }
 * @param {{ probes?: Array, sysId: string, schema: object, traits: object, ids?: string[] }} input
 */
export function planProbes({ probes = PROBES, sysId, schema, traits, ids = [] }) {
  return probes.map((probe) => {
    if (probe.applies && !probe.applies(traits)) return { probe, status: 'na', note: '' };
    if (!schema.exists(probe.table)) return { probe, status: 'missing', note: `${probe.table} is not on this instance.` };
    const missing = (probe.need || []).filter((c) => !schema.has(probe.table, c));
    if (missing.length) return { probe, status: 'error', note: `Could not check ${probe.table}: it has no ${missing.join(', ')} column on this instance.` };
    if (probe.needAny && !probe.needAny.some((c) => schema.has(probe.table, c))) {
      return { probe, status: 'error', note: `Could not check ${probe.table}: it has none of the columns ${probe.needAny.join(', ')} on this instance.` };
    }
    const has = (column) => schema.has(probe.table, column);
    const query = probe.query({ sysId, has, ids });
    if (!query) return { probe, status: 'skipped', note: '' };
    return { probe, status: 'run', query };
  });
}

// --- A failed read is a note -----------------------------------------------------------------------------

/** { status: 'denied' | 'missing' | 'error', note, sessionExpired? } for an error from reading `table`. */
export function classifyReadError(err, table) {
  const text = (err && err.message) || String(err || '');
  if (err?.code === 'SESSION_EXPIRED') return { status: 'error', note: text, sessionExpired: true };
  if (/\b403\b|not allowed|forbidden|not authorized|security|denied|\bacl\b/i.test(text)) return { status: 'denied', note: `Your user cannot read ${table}.` };
  if (/invalid table|\b404\b|does not exist|no such table|unknown table/i.test(text)) return { status: 'missing', note: `${table} is not on this instance.` };
  return { status: 'error', note: `Could not read ${table}: ${clip(text, 140)}` };
}

/**
 * Rows from one probe -> a result. Rows that do not belong to the record mean the instance ignored the condition,
 * which is reported as a failure, not as "nothing found".
 */
export function runProbe(probe, rows, ctx) {
  const all = Array.isArray(rows) ? rows : [];
  // `drop`: rows that belong to the record but to another section (left out quietly, not a sign of an ignored filter).
  const list = probe.drop ? all.filter((row) => !probe.drop(row)) : all;
  const kept = list.filter((row) => {
    try {
      return probe.keep(row, ctx);
    } catch {
      return false;
    }
  });
  if (kept.length < list.length) {
    return { status: 'error', note: `Could not check ${probe.table}: the instance did not apply the filter on the record, so its rows were not used.`, items: [] };
  }
  return { status: 'ok', note: '', items: kept.map((row) => probe.normalise(row)), truncated: all.length >= probe.limit };
}

/**
 * The plans whose empty answer must be confirmed. The Table API answers a table the user may not read with an empty
 * list rather than an error, so "no flows for this record" is only true if the user can see some flow at all. Only
 * primary sources (the ones the headline rests on) are confirmed, and not `task`: the record on screen is one.
 */
export function plansToConfirm(plans, results) {
  return plans.filter((p) => {
    const r = results[p.probe.id];
    return p.status === 'run' && p.probe.role === 'primary' && p.probe.table !== 'task' && r?.status === 'ok' && r.items.length === 0;
  });
}

/** The result for a source whose table showed the user no rows at all: not "none", but "could not tell". */
export function unseenResult(probe) {
  return { status: 'denied', note: `Your user sees no rows of ${probe.table} at all, so "none for this record" proves nothing: the instance may have none, or an ACL hides them.`, items: [] };
}

// --- Assembling --------------------------------------------------------------------------------------------

const stamp = (when) => {
  const t = at(when);
  return Number.isFinite(t) ? t : 0;
};
const newestFirst = (field) => (a, b) => stamp(b[field]) - stamp(a[field]);

/** Failures first, then live runs, then newest first; a failed run is marked when a later run of the same flow completed. */
export function assembleFlows(flows = [], logs = []) {
  const list = flows.map((f) => ({ ...f }));
  list.forEach((f) => {
    if (f.state !== 'error' || !f.name) return;
    f.superseded = list.some((o) => o !== f && o.name === f.name && o.state === 'complete' && stamp(o.started) > stamp(f.started));
  });
  const byContext = new Map();
  logs.forEach((l) => {
    if (!byContext.has(l.contextId)) byContext.set(l.contextId, []);
    byContext.get(l.contextId).push(l);
  });
  list.forEach((f) => {
    f.log = (byContext.get(f.sysId) || []).sort((a, b) => stamp(a.when) - stamp(b.when)).slice(-12);
  });
  const rank = (f) => (f.state === 'error' && !f.superseded ? 0 : f.active ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b) || newestFirst('started')(a, b));
}

/** Contexts with their current activity and history; active first, then newest. */
export function assembleWorkflows(contexts = [], executing = [], history = []) {
  const list = contexts.map((c) => ({
    ...c,
    executing: executing.filter((e) => e.contextId === c.sysId).sort((a, b) => stamp(a.since) - stamp(b.since)),
    history: history
      .filter((h) => h.contextId === c.sysId)
      .sort((a, b) => stamp(a.started) - stamp(b.started) || (a.index || 0) - (b.index || 0)),
  }));
  return list.sort((a, b) => Number(b.active) - Number(a.active) || newestFirst('started')(a, b));
}

/** Pending first (oldest first, they have waited longest), then decided, newest first. */
export function assembleApprovals(approvers = [], groups = []) {
  const all = [...approvers, ...groups];
  const pending = all.filter((a) => a.state === 'pending').sort((a, b) => stamp(a.updated || a.created) - stamp(b.updated || b.created));
  const rest = all.filter((a) => a.state !== 'pending').sort((a, b) => stamp(b.updated || b.created) - stamp(a.updated || a.created));
  return [...pending, ...rest];
}

const SLA_ORDER = { breached: 0, paused: 2, in_progress: 1, other: 3, achieved: 4, cancelled: 5 };
export function assembleSlas(slas = []) {
  return [...slas].sort((a, b) => (SLA_ORDER[a.stage] ?? 3) - (SLA_ORDER[b.stage] ?? 3) || stamp(b.started) - stamp(a.started));
}

/** One list from several probes, a row seen twice (it matched two relations) once. Open first, then newest. */
export function assembleTasks(lists = []) {
  const seen = new Set();
  const out = [];
  lists.flat().forEach((t) => {
    if (seen.has(t.sysId)) return;
    seen.add(t.sysId);
    out.push(t);
  });
  return out.sort((a, b) => Number(b.open) - Number(a.open) || stamp(b.updated) - stamp(a.updated));
}

/** Where a workflow stands: its current activity, how long, and whether that is a wait. */
export function workflowStanding(context, now = Date.now()) {
  if (!context.active) return null;
  const current = context.executing[0] || null;
  if (!current) return { current: null, age: ageMs(context.started, now), wait: 'other', isWait: false };
  return { current, age: ageMs(current.since, now), wait: current.wait, isWait: current.isWait };
}

// --- SLA wording ------------------------------------------------------------------------------------------

/**
 * Breach risk of one SLA: { level: 'breached' | 'late' | 'atRisk' | 'paused' | 'ok' | 'met' | 'cancelled' | 'unknown', text }.
 * The planned end is the authority; the percentage backs it up when the planned end is missing.
 */
export function slaRisk(sla, now = Date.now()) {
  const pct = Number.isFinite(sla.percentage) ? Math.round(sla.percentage) : null;
  const used = pct === null ? '' : `${pct}% of the time used`;
  const endAge = ageMs(sla.plannedEnd, now);
  if (sla.stage === 'cancelled') return { level: 'cancelled', text: 'Cancelled' };
  if (sla.stage === 'achieved') return sla.breached ? { level: 'late', text: 'Completed, but only after it had breached' } : { level: 'met', text: 'Met' };
  if (sla.stage === 'paused') {
    const since = relativeTime(sla.pausedAt, now);
    return { level: 'paused', text: `Paused${since ? ` ${since}` : ''}; the clock is stopped${used ? ` at ${used}` : ''}` };
  }
  // The breach flag and the planned end decide. A full business percentage is a breach the flag has not caught up with;
  // the plain (wall-clock) percentage counts only when nothing else was readable.
  const pctBreach = pct !== null && pct >= 100 && (sla.businessPercentage || (!Number.isFinite(endAge) && !sla.breachKnown));
  if (sla.breached || pctBreach || (Number.isFinite(endAge) && endAge > 0)) {
    const when = Number.isFinite(endAge) && endAge > 0 ? ` ${formatAge(endAge)} ago` : '';
    return { level: 'breached', text: `Breached${when}${pct !== null ? `, ${pct}% of the time used` : ''}` };
  }
  const left = Number.isFinite(endAge) ? `due in ${formatAge(-endAge)}` : '';
  const detail = [used, left].filter(Boolean).join(', ');
  if (pct !== null && pct >= 75) return { level: 'atRisk', text: `At risk${detail ? `: ${detail}` : ''}` };
  if (pct === null && !left) return { level: 'unknown', text: 'Running; no timing was readable' };
  return { level: 'ok', text: `On track${detail ? `: ${detail}` : ''}` };
}

// --- What is it waiting for? ---------------------------------------------------------------------------------

/**
 * @typedef {{ kind: string, priority: number, severity: 'error' | 'warn' | 'info', tag: string, text: string,
 *   detail: string, since: string, target: { table: string, sysId: string } | null }} Blocker
 */

const sentence = (text) => (/[.!?)]$/.test(text) ? text : `${text}.`);
const quoted = (name) => `"${name}"`;
const listWords = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0] || 'sources');
const list = (names, max = 3) => (names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', '));

/** Blockers from the assembled sections, most important first. */
export function findBlockers(data, now = Date.now()) {
  const out = [];
  const { flows = [], approvals = [], slas = [], tasks = [], workflows = [], events = [] } = data;

  flows.forEach((f) => {
    const age = ageMs(f.ended || f.started, now);
    if (f.state === 'error' && !f.superseded) {
      out.push({
        kind: 'flowFailed',
        priority: 1,
        severity: 'error',
        tag: 'Failed flow',
        text: `the flow ${quoted(f.name)}, which failed${Number.isFinite(age) ? ` ${formatAge(age)} ago` : ''}`,
        detail: [sentence(f.error || NO_ERROR_TEXT), f.hint].filter(Boolean).join(' '),
        since: f.ended || f.started,
        target: f.target,
      });
    } else if (f.state === 'waiting') {
      const waited = ageMs(f.updated || f.started, now);
      out.push({
        kind: 'flowWaiting',
        priority: 4,
        severity: waited >= THRESHOLDS.waiting ? 'warn' : 'info',
        tag: 'Waiting flow',
        text: `the flow ${quoted(f.name)}, which has been waiting${Number.isFinite(waited) ? ` for ${formatAge(waited)}` : ''}`,
        detail: stuckNote(waited) || 'A flow in the Waiting state is paused on a wait step (an approval, a timer, a condition or a task).',
        since: f.updated || f.started,
        target: f.target,
      });
    } else if (f.state === 'queued' || f.state === 'running') {
      const running = ageMs(f.started, now);
      const late = f.state === 'queued' ? running >= THRESHOLDS.flowQueued : running >= THRESHOLDS.flowRunning;
      if (late) {
        out.push({
          kind: 'flowLate',
          priority: 4,
          severity: 'warn',
          tag: f.state === 'queued' ? 'Queued flow' : 'Long-running flow',
          text: f.state === 'queued' ? `the flow ${quoted(f.name)}, which has been queued for ${formatAge(running)} without starting` : `the flow ${quoted(f.name)}, still running after ${formatAge(running)}`,
          detail: f.state === 'queued' ? 'Flows start within seconds. A flow that stays queued usually means the flow engine or the event queue is backed up.' : 'Most flows finish within seconds or minutes. Open the execution to see which step it is in.',
          since: f.started,
          target: f.target,
        });
      }
    }
  });

  const pending = approvals.filter((a) => a.kind === 'approval' && a.state === 'pending');
  const pendingGroups = approvals.filter((a) => a.kind === 'groupApproval' && a.state === 'pending');
  const waiting = pending.length ? pending : pendingGroups;
  if (waiting.length) {
    const first = waiting[0];
    const firstAge = ageMs(first.updated || first.created, now);
    const who = waiting.map((a) => `${a.who} (${formatAge(ageMs(a.updated || a.created, now)) || 'unknown time'})`);
    const overdue = waiting.filter((a) => ageMs(a.due, now) > 0);
    out.push({
      kind: 'approvalPending',
      priority: 2,
      severity: firstAge >= 3 * DAY || overdue.length ? 'warn' : 'info',
      tag: 'Approval',
      text:
        waiting.length === 1
          ? `${first.kind === 'groupApproval' ? 'approval from the group ' : 'approval from '}${first.who}${Number.isFinite(firstAge) ? `, requested ${formatAge(firstAge)} ago` : ''}`
          : `${waiting.length} approvals: ${list(who)}`,
      detail: overdue.length ? `${overdue.map((a) => a.who).join(', ')} ${overdue.length === 1 ? 'is' : 'are'} past the due date.` : 'The record cannot move on until the approver answers. Approvers can be reached from the approval record.',
      since: first.updated || first.created,
      target: first.target,
    });
  }

  // The newest rejection, and only while nothing is pending and nobody approved after it (a re-submitted record that
  // was then approved is not held up by the old rejection).
  const rejected = approvals.filter((a) => a.state === 'rejected').sort((x, y) => stamp(y.updated || y.created) - stamp(x.updated || x.created));
  const approvedLater = rejected.length > 0 && approvals.some((a) => a.state === 'approved' && stamp(a.updated || a.created) > stamp(rejected[0].updated || rejected[0].created));
  if (rejected.length && !pending.length && !approvedLater) {
    const a = rejected[0];
    out.push({
      kind: 'approvalRejected',
      priority: 3,
      severity: 'warn',
      tag: 'Rejected',
      text: `an approval that ${a.who} rejected${relativeTime(a.updated, now) ? ` ${relativeTime(a.updated, now)}` : ''}`,
      detail: a.comments ? `Their comment: ${a.comments}` : 'A rejection normally stops the flow or workflow that asked for it.',
      since: a.updated || a.created,
      target: a.target,
    });
  }

  workflows.forEach((w) => {
    const standing = workflowStanding(w, now);
    if (!standing) return;
    if (standing.current && standing.isWait) {
      const c = standing.current;
      out.push({
        kind: 'workflowWait',
        priority: 4,
        severity: standing.wait !== 'timer' && standing.age >= THRESHOLDS.waiting ? 'warn' : 'info',
        tag: 'Workflow',
        text: `the workflow ${quoted(w.name)}, at ${quoted(c.activity)} for ${formatAge(standing.age) || 'an unknown time'}`,
        detail: [WAIT_TEXT[standing.wait], standing.wait === 'timer' ? '' : stuckNote(standing.age)].filter(Boolean).join(' '),
        since: c.since,
        target: w.target,
      });
    } else {
      // Running but not on a wait, or no current activity found: still the most useful thing to say about it.
      out.push({
        kind: 'workflowRunning',
        priority: 4,
        severity: standing.age >= THRESHOLDS.waiting ? 'warn' : 'info',
        tag: 'Workflow',
        text: standing.current ? `the workflow ${quoted(w.name)}, at ${quoted(standing.current.activity)} for ${formatAge(standing.age) || 'an unknown time'}` : `the workflow ${quoted(w.name)}, which is still running (its current activity could not be read)`,
        detail: [WAIT_TEXT[standing.wait], stuckNote(standing.age)].filter(Boolean).join(' '),
        since: standing.current ? standing.current.since : w.started,
        target: w.target,
      });
    }
  });

  const open = tasks.filter((t) => t.open);
  if (open.length) {
    out.push({
      kind: 'tasksOpen',
      priority: 5,
      severity: 'info',
      tag: 'Tasks',
      text: `${plural(open.length, 'open task')}: ${list(open.map((t) => `${t.number}${t.stateText ? ` (${t.stateText})` : ''}`))}`,
      detail: 'The record usually waits for these to be closed before it can move on.',
      since: open.reduce((oldest, t) => (!oldest || stamp(t.created) < stamp(oldest) ? t.created : oldest), ''),
      target: open[0].target,
    });
  }

  slas
    .filter((s) => !s.done)
    .forEach((s) => {
      const risk = slaRisk(s, now);
      if (risk.level === 'breached') {
        out.push({ kind: 'slaBreached', priority: 6, severity: 'error', tag: 'SLA', text: `the SLA ${quoted(s.name)}: ${risk.text.charAt(0).toLowerCase()}${risk.text.slice(1)}`, detail: 'A breached SLA does not stop anything by itself; it is the clock that has run out.', since: s.plannedEnd, target: s.target });
      } else if (risk.level === 'paused') {
        out.push({ kind: 'slaPaused', priority: 7, severity: 'info', tag: 'SLA', text: `the SLA ${quoted(s.name)} to resume (${risk.text.charAt(0).toLowerCase()}${risk.text.slice(1)})`, detail: 'SLAs pause on the conditions in their definition, for example while the task is on hold or waiting for the caller.', since: s.pausedAt, target: s.target });
      }
    });

  const stale = events.filter((e) => {
    const d = eventDue(e, now);
    return !d.scheduled && d.age >= THRESHOLDS.event;
  });
  if (stale.length) {
    out.push({
      kind: 'eventsQueued',
      priority: 8,
      severity: 'warn',
      tag: 'Events',
      text: `${plural(stale.length, 'queued event')}: ${list(stale.map((e) => `${e.name} (${formatAge(eventDue(e, now).age)})`))}`,
      detail: 'Events are normally processed within a minute. A backlog means the event queue or its scheduled job is behind, and the notifications and script actions that wait for them are late.',
      since: stale[0].created,
      target: stale[0].target,
    });
  }

  return out.sort((a, b) => a.priority - b.priority || stamp(a.since) - stamp(b.since));
}

/**
 * How long an event has been due. gs.eventQueueScheduled() queues an event in state ready with process_on in the
 * future (reminders, SLA warnings): that one is scheduled, not late. Otherwise the wait runs from the later of its
 * creation and its process_on.
 * @returns {{ scheduled: boolean, age: number }} age in ms, NaN when no time was readable
 */
export function eventDue(event, now = Date.now()) {
  const due = at(event.processOn);
  if (Number.isFinite(due) && due > now) return { scheduled: true, age: NaN };
  const from = Math.max(stamp(event.created), Number.isFinite(due) ? due : 0);
  return { scheduled: false, age: from ? now - from : NaN };
}

function stuckNote(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms >= THRESHOLDS.stuck) return `It has been like this for ${formatAge(ms)}, which is very likely stuck.`;
  if (ms >= THRESHOLDS.waiting) return `It has been like this for ${formatAge(ms)}, which may be stuck.`;
  return '';
}

/** Things that are alive but not holding the record up: running flows, an SLA clock that is counting. */
export function findRunning(data, now = Date.now()) {
  const out = [];
  (data.flows || [])
    .filter((f) => f.state === 'running' || f.state === 'queued')
    .forEach((f) => out.push({ kind: 'flowRunning', text: `the flow ${quoted(f.name)} (${f.state === 'queued' ? 'queued' : 'started'} ${relativeTime(f.started, now) || 'just now'})`, target: f.target }));
  (data.slas || [])
    .filter((s) => !s.done && s.stage !== 'paused')
    .forEach((s) => {
      const risk = slaRisk(s, now);
      if (risk.level === 'ok' || risk.level === 'atRisk' || risk.level === 'unknown') out.push({ kind: 'slaRunning', text: `the SLA clock ${quoted(s.name)} (${risk.text.charAt(0).toLowerCase()}${risk.text.slice(1)})`, target: s.target });
    });
  return out;
}

// --- Sections ----------------------------------------------------------------------------------------------

const BAD = new Set(['denied', 'error']);

/**
 * Combine the probe results into sections. `plans` is what planProbes returned for both stages; `results` maps probe id ->
 * a result from runProbe or a read failure: { status, note, items, truncated }.
 * Section status: ok | partial | missing | denied | error | na.
 */
export function buildSections({ plans, results, traits, now = Date.now() }) {
  const byId = new Map(plans.map((p) => [p.probe.id, p]));
  const resultOf = (id) => {
    const plan = byId.get(id);
    if (!plan) return { status: 'na', note: '', items: [] };
    if (plan.status === 'run') return results[id] || { status: 'skipped', note: '', items: [] };
    return { status: plan.status, note: plan.note, items: [] };
  };
  const items = (id) => (resultOf(id).status === 'ok' ? resultOf(id).items : []);

  const data = {
    flows: assembleFlows(items('flowContext'), items('flowLog')),
    approvals: assembleApprovals(items('approver'), items('groupApproval')),
    slas: assembleSlas(items('sla')),
    tasks: assembleTasks(['childTasks', 'catalogTasks', 'requestItems', 'changeTasks', 'problemTasks'].map(items)),
    workflows: assembleWorkflows(items('wfContext'), items('wfExecuting'), items('wfHistory')),
    events: items('events').sort((a, b) => stamp(a.created) - stamp(b.created)),
  };
  const itemsOf = { flows: data.flows, approvals: data.approvals, slas: data.slas, tasks: data.tasks, workflow: data.workflows, events: data.events };

  const sections = SECTION_DEFS.map((def) => {
    const probes = PROBES.filter((p) => p.section === def.id).map((p) => ({ probe: p, result: resultOf(p.id) }));
    const live = probes.filter((x) => x.result.status !== 'na');
    const base = { id: def.id, label: def.label, hint: def.hint, items: itemsOf[def.id], truncated: false, notes: [], absent: [] };
    if (!live.length) {
      return { ...base, status: 'na', items: [], note: `Not applicable: ${def.naNote || `${def.label} do not apply here`}, and ${traits.table} is not one.` };
    }
    const notes = [];
    const absent = [];
    let status = 'ok';
    let note = '';
    live.forEach(({ probe, result }) => {
      if (result.status === 'ok') {
        base.truncated = base.truncated || Boolean(result.truncated);
        return;
      }
      if (result.status === 'skipped') return;
      if (result.status === 'missing') {
        absent.push(probe.table);
        if (probe.role === 'primary') {
          status = status === 'ok' ? 'missing' : status;
          note = note || result.note;
        }
        return;
      }
      // denied or error
      notes.push({ text: result.note, level: probe.role === 'optional' ? 'info' : 'warn', table: probe.table, sessionExpired: Boolean(result.sessionExpired) });
      if (probe.role === 'primary') {
        status = result.status === 'denied' && status !== 'error' ? 'denied' : 'error';
        note = result.note;
      } else if (probe.role === 'detail' && status === 'ok') {
        status = 'partial';
      }
    });
    return { ...base, status, note: note || (status === 'partial' ? notes.filter((n) => n.level === 'warn').map((n) => n.text).join(' ') : ''), notes, absent };
  });

  return { sections, data };
}

// --- Rows the panel draws ---------------------------------------------------------------------------------------

const TONE_ORDER = { danger: 0, warn: 1, info: 2, ok: 3, muted: 4 };

/**
 * One row per item in plain terms. `badge.tone` is danger | warn | info | ok | muted; the panel always prints the
 * badge text, so colour is never the only signal.
 * @returns {{ id, kind, title, badge: { text, tone }, headline: string, times: Array<{label, when}>, facts: string[], error: string,
 *   note: string, comment: string, lines: Array<{when?: string, text: string}>, href: string, attention: boolean }}
 */
export function presentItem(item, now = Date.now(), { table = '' } = {}) {
  const row = { id: item.id, kind: item.kind, title: '', badge: { text: '', tone: 'muted' }, headline: '', times: [], facts: [], error: '', note: '', comment: '', lines: [], href: recordPath(item.target), attention: false };
  const time = (label, when) => when && Number.isFinite(at(when)) && row.times.push({ label, when });

  if (item.kind === 'flow') {
    const tone = { error: 'danger', waiting: 'warn', cancelled: 'warn', running: 'info', queued: 'info', complete: 'ok' }[item.state] || 'muted';
    row.title = item.name;
    row.badge = { text: item.stateLabel, tone };
    time('Started', item.started);
    time(item.state === 'error' ? 'Failed' : 'Ended', item.ended);
    const took = runTime(item.started, item.ended);
    if (took && item.state !== 'queued') row.facts.push(`Ran ${took}`);
    if (item.active) {
      const age = ageMs(item.started, now);
      if (Number.isFinite(age)) row.headline = item.state === 'waiting' ? `Waiting for ${formatAge(ageMs(item.updated || item.started, now))}` : `${item.state === 'queued' ? 'Queued' : 'Running'} for ${formatAge(age)}`;
    }
    if (item.state === 'error') {
      row.error = item.error || NO_ERROR_TEXT;
      row.note = item.superseded ? 'A later run of this flow completed, so this failure may already be resolved.' : item.hint;
      row.attention = !item.superseded;
    }
    if (item.sourceTable && item.sourceTable !== table) row.facts.push(`Source table ${item.sourceTable}`);
    row.lines = item.log.map((l) => ({ when: l.when, text: `${l.level ? `${l.level}: ` : ''}${l.message}` }));
    return row;
  }

  if (item.kind === 'approval' || item.kind === 'groupApproval') {
    const tone = { pending: 'warn', approved: 'ok', rejected: 'danger', cancelled: 'muted', notyet: 'muted', notrequired: 'muted' }[item.state] || 'muted';
    row.title = item.kind === 'groupApproval' ? `Group approval: ${item.who}` : item.who;
    row.badge = { text: item.stateLabel, tone };
    if (item.state === 'pending') {
      const since = item.updated || item.created;
      row.headline = `Waiting for ${item.who} for ${formatAge(ageMs(since, now)) || 'an unknown time'}`;
      row.attention = true;
      time('Requested', item.created);
      time('Last updated', item.updated !== item.created ? item.updated : '');
      if (item.due) {
        time('Due', item.due);
        if (ageMs(item.due, now) > 0) {
          row.facts.push(`Overdue by ${formatAge(ageMs(item.due, now))}`);
          row.attention = true;
        }
      }
    } else {
      time(item.state === 'approved' || item.state === 'rejected' ? item.stateLabel : 'Last updated', item.updated || item.created);
    }
    if (item.group && item.approver) row.facts.push(`Group ${item.group}`);
    if (item.number) row.facts.push(item.number);
    row.comment = item.comments;
    if (item.state === 'rejected') row.attention = true;
    return row;
  }

  if (item.kind === 'sla') {
    const risk = slaRisk(item, now);
    const tone = { breached: 'danger', late: 'warn', atRisk: 'warn', paused: 'warn', ok: 'info', met: 'ok', cancelled: 'muted', unknown: 'muted' }[risk.level];
    const badgeText = { breached: 'Breached', late: 'Met late', atRisk: 'At risk', paused: 'Paused', ok: 'On track', met: 'Met', cancelled: 'Cancelled', unknown: 'Running' }[risk.level];
    row.title = item.name;
    row.badge = { text: badgeText, tone };
    row.headline = risk.level === 'met' || risk.level === 'cancelled' ? '' : risk.text;
    time('Started', item.started);
    time(item.done ? 'Ended' : 'Planned end', item.done ? item.ended : item.plannedEnd);
    if (item.stageText) row.facts.push(`Stage ${item.stageText}`);
    row.attention = risk.level === 'breached';
    return row;
  }

  if (item.kind === 'task') {
    row.title = `${item.number}${item.summary ? `  ${item.summary}` : ''}`;
    row.badge = { text: item.stateText || (item.open ? 'Open' : 'Closed'), tone: item.open ? 'warn' : 'ok' };
    if (item.typeLabel) row.facts.push(item.typeLabel);
    if (item.assignedTo) row.facts.push(`Assigned to ${item.assignedTo}`);
    else if (item.group) row.facts.push(`Group ${item.group}`);
    else if (item.open) row.facts.push('Not assigned');
    time('Updated', item.updated);
    return row;
  }

  if (item.kind === 'workflow') {
    const standing = workflowStanding(item, now);
    const tone = { executing: 'info', finished: 'ok', cancelled: 'muted', error: 'danger' }[item.state] || 'muted';
    row.title = item.name;
    row.badge = { text: item.stateLabel, tone };
    time('Started', item.started);
    time('Ended', item.ended);
    if (standing?.current) {
      const c = standing.current;
      row.headline = `In ${quoted(c.activity)} for ${formatAge(standing.age) || 'an unknown time'}`;
      row.note = [WAIT_TEXT[standing.wait], standing.wait === 'timer' ? '' : stuckNote(standing.age)].filter(Boolean).join(' ');
      if (standing.isWait && standing.age >= THRESHOLDS.waiting && standing.wait !== 'timer') {
        row.badge = { text: 'Possibly stuck', tone: 'warn' };
        row.attention = true;
      }
    } else if (standing) {
      row.headline = 'Running; its current activity could not be read';
    }
    row.lines = item.history.map((h) => ({ when: h.started, text: `${h.activity}${h.result ? `: ${h.result}` : h.state ? ` (${h.state})` : ''}${h.fault ? `. ${h.fault}` : ''}` }));
    return row;
  }

  if (item.kind === 'event') {
    const due = eventDue(item, now);
    row.title = item.name;
    time('Queued', item.created);
    if (item.queue) row.facts.push(`Queue ${item.queue}`);
    if (due.scheduled) {
      row.badge = { text: 'Scheduled', tone: 'info' };
      row.headline = `Scheduled to be processed ${relativeTime(item.processOn, now)}`;
      time('Due', item.processOn);
      return row;
    }
    const late = due.age >= THRESHOLDS.event;
    row.badge = { text: late ? 'Not processed' : 'Queued', tone: late ? 'warn' : 'info' };
    row.headline = `Waiting ${formatAge(due.age) || 'for an unknown time'} to be processed`;
    row.attention = late;
    return row;
  }

  return row;
}

/** Badges for a section's header: "1 Failed", "2 Complete", most urgent first. */
export function sectionBadges(rows) {
  const counts = new Map();
  rows.forEach((r) => {
    const key = `${r.badge.tone}|${r.badge.text}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([key, count]) => {
      const [tone, text] = key.split('|');
      return { tone, text, count };
    })
    .sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || b.count - a.count);
}

// --- The whole report -------------------------------------------------------------------------------------------

const KIND_NOUN = { flows: ['flow', 'flows'], approvals: ['approval', 'approvals'], slas: ['SLA', 'SLAs'], tasks: ['task', 'tasks'], workflow: ['workflow', 'workflows'], events: ['event', 'events'] };

/**
 * The headline and everything under it.
 * level: blocked (something is holding the record up) | running | clear | partial (no blocker, but a source was not
 * read) | unknown (nothing could be read).
 */
export function summarize(sections, data, { now = Date.now(), recordActive = null } = {}) {
  const readable = sections.filter((s) => s.status !== 'na');
  const unread = readable.filter((s) => s.status === 'denied' || s.status === 'error' || s.status === 'partial');
  const unreadable = [];
  sections.forEach((s) => {
    s.notes.filter((n) => n.level === 'warn').forEach((n) => unreadable.push({ section: s.id, label: s.label, text: n.text }));
    if (s.status === 'denied' || s.status === 'error') {
      if (!s.notes.some((n) => n.level === 'warn')) unreadable.push({ section: s.id, label: s.label, text: s.note });
    }
  });
  const blockers = findBlockers(data, now);
  const running = findRunning(data, now);
  const closedNote = recordActive === false ? 'This record is not active (it is closed), so what is listed may be left over from before it was closed.' : '';

  const usable = readable.filter((s) => s.status === 'ok' || s.status === 'partial' || s.status === 'missing');
  if (!usable.length) {
    return { level: 'unknown', headline: 'Could not read what is running on this record', detail: 'None of the sources could be read. The notes below say why for each one.', blockers: [], running: [], unreadable, closedNote };
  }
  if (blockers.length) {
    const first = blockers[0];
    return { level: 'blocked', headline: `Waiting on: ${first.text}`, detail: first.detail, severity: first.severity, tag: first.tag, target: first.target, blockers, also: blockers.slice(1), running, unreadable, closedNote };
  }
  if (unread.length) {
    return {
      level: 'partial',
      headline: 'Nothing found that is holding this record up',
      detail: `${plural(unread.length, 'source')} could not be read, so this may not be the whole picture.`,
      blockers: [],
      running,
      unreadable,
      closedNote,
    };
  }
  if (running.length) {
    return { level: 'running', headline: `Running now: ${running[0].text}`, detail: running.length > 1 ? `Also running: ${running.slice(1).map((r) => r.text).join('; ')}.` : 'Nothing is waiting on anyone.', blockers: [], running, unreadable, closedNote };
  }
  const countOf = (def) => (data[def.id === 'workflow' ? 'workflows' : def.id] || []).length;
  const earlier = SECTION_DEFS.map((def) => (countOf(def) ? plural(countOf(def), KIND_NOUN[def.id][0], KIND_NOUN[def.id][1]) : '')).filter(Boolean);
  // Only what applies and exists here is named: a user record has no SLAs to be missing.
  const checked = SECTION_DEFS.filter((def) => sections.find((s) => s.id === def.id)?.status === 'ok').map((def) => KIND_NOUN[def.id][1]);
  const absent = [...new Set(sections.flatMap((s) => s.absent))];
  return {
    level: 'clear',
    headline: 'Nothing is running on this record',
    detail: earlier.length ? `Finished earlier: ${earlier.join(', ')}.` : `No ${listWords(checked)} were found for this record.`,
    blockers: [],
    running: [],
    unreadable,
    closedNote,
    absentNote: absent.length ? `Not on this instance: ${absent.join(', ')}.` : '',
  };
}

/** Everything the panel needs, from the sections buildSections made. */
export function buildReport({ table, sysId, record = {}, chain = [], plans, results, traits, schemaTrusted = true, now = Date.now() }) {
  const { sections, data } = buildSections({ plans, results, traits, now });
  const summary = summarize(sections, data, { now, recordActive: record.active ?? null });
  const rows = Object.fromEntries(sections.map((s) => [s.id, s.items.map((item) => presentItem(item, now, { table }))]));
  return {
    table,
    sysId,
    record: { label: record.label || '', summary: record.summary || '', active: record.active ?? null },
    chain,
    schemaTrusted,
    generatedAt: now,
    summary,
    sections: sections.map((s) => ({
      id: s.id,
      label: s.label,
      hint: s.hint,
      status: s.status,
      note: s.note || '',
      notes: s.notes,
      absent: s.absent,
      truncated: s.truncated,
      rows: rows[s.id],
      badges: sectionBadges(rows[s.id]),
      count: rows[s.id].length,
      attention: rows[s.id].some((r) => r.attention) || s.status === 'denied' || s.status === 'error' || s.status === 'partial',
    })),
  };
}

// --- Markdown ----------------------------------------------------------------------------------------------------

const utc = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

/** The report as Markdown, for a ticket comment or a chat. */
export function processMarkdown(report, { instance = '' } = {}) {
  const now = report.generatedAt;
  const s = report.summary;
  const lines = [];
  lines.push(`# Flows, approvals and SLAs: ${report.record.label || report.sysId} (${report.table})`);
  lines.push('');
  lines.push(`Read ${utc(now)} UTC${instance ? ` on ${instance}` : ''}. Times below are UTC.`);
  lines.push('');
  lines.push(`**${s.headline}**`);
  if (s.detail) lines.push(s.detail);
  if (s.closedNote) lines.push(s.closedNote);
  if (s.also?.length) {
    lines.push('');
    lines.push('Also:');
    s.also.forEach((b) => lines.push(`- ${b.text}`));
  }
  if (s.unreadable.length) {
    lines.push('');
    lines.push('Could not read:');
    s.unreadable.forEach((u) => lines.push(`- ${u.label}: ${u.text}`));
  }
  report.sections.forEach((section) => {
    lines.push('');
    if (section.status === 'na') {
      lines.push(`## ${section.label}`, '', section.note);
      return;
    }
    if (section.status === 'denied' || section.status === 'error' || section.status === 'missing') {
      lines.push(`## ${section.label}`, '', `Could not read: ${section.note}`);
      return;
    }
    lines.push(`## ${section.label} (${section.count})`);
    if (!section.count) lines.push('', 'None.');
    section.rows.forEach((row) => {
      lines.push('');
      const when = row.times.map((t) => `${t.label.toLowerCase()} ${t.when} UTC (${relativeTime(t.when, now)})`).join(', ');
      lines.push(`- **${row.badge.text}** ${row.title}${when ? ` - ${when}` : ''}`);
      if (row.headline) lines.push(`  - ${row.headline}`);
      if (row.error) lines.push(`  - Error: ${row.error}`);
      if (row.note) lines.push(`  - ${row.note}`);
      if (row.comment) lines.push(`  - Comment: ${row.comment}`);
      if (row.facts.length) lines.push(`  - ${row.facts.join('; ')}`);
    });
    section.notes.forEach((n) => lines.push('', `Note: ${n.text}`));
  });
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
