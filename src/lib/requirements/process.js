// What the "process" feature (Flows, approvals and SLAs, /flows) needs from the instance, for the Self-check panel
// (src/lib/requirements/index.js).
// One entry per table: { feature, table, columns: [...], optional?: true, note?: "why" }.
// `columns` are the ones used in a condition (a wrong one would silently match every row) or needed for the headline;
// the display-only columns are listed in docs/features/process.md. Written from knowledge of the ServiceNow schema,
// not yet checked on a live instance.

const FEATURE = 'Flows, approvals and SLAs';

export const REQUIREMENTS = [
  { feature: FEATURE, table: 'sys_flow_context', columns: ['source_record', 'name', 'state', 'error_message', 'source_table'], note: 'Flow Designer executions run against the record: found by source_record, state and error_message drive the headline' },
  { feature: FEATURE, table: 'sys_hub_flow', columns: ['name'], optional: true, note: 'Names flows whose execution row has none (the flow column is only a sys_id); without it such a flow shows as unnamed' },
  { feature: FEATURE, table: 'sys_flow_log', columns: ['context', 'message'], optional: true, note: 'Log lines of a failed or running flow; the section just has no log lines without it' },
  { feature: FEATURE, table: 'sysapproval_approver', columns: ['sysapproval', 'document_id', 'approver', 'state', 'group'], note: 'Approvals: found by sysapproval (task approvals) or document_id (Flow Designer approvals on any table); at least one of the two must exist' },
  { feature: FEATURE, table: 'sysapproval_group', columns: ['parent'], optional: true, note: 'Group approval records of a task' },
  { feature: FEATURE, table: 'task_sla', columns: ['task', 'sla', 'stage', 'has_breached', 'percentage', 'planned_end_time'], note: 'SLAs timing a task: breach risk is worked out from planned_end_time and percentage' },
  { feature: FEATURE, table: 'task', columns: ['parent', 'number', 'state', 'active'], note: 'Child tasks of the record (parent = record); active says which are still open' },
  { feature: FEATURE, table: 'sc_task', columns: ['request_item'], optional: true, note: 'Catalog tasks of a requested item' },
  { feature: FEATURE, table: 'sc_req_item', columns: ['request'], optional: true, note: 'Requested items of a request' },
  { feature: FEATURE, table: 'change_task', columns: ['change_request'], optional: true, note: 'Change tasks of a change request' },
  { feature: FEATURE, table: 'problem_task', columns: ['problem'], optional: true, note: 'Problem tasks of a problem' },
  { feature: FEATURE, table: 'wf_context', columns: ['id', 'state', 'workflow_version'], optional: true, note: 'Legacy workflow contexts for the record; the Legacy Workflow plugin may be absent' },
  { feature: FEATURE, table: 'wf_executing', columns: ['context', 'activity'], optional: true, note: 'The activity a legacy workflow is in right now' },
  { feature: FEATURE, table: 'wf_history', columns: ['context'], optional: true, note: 'Activities a legacy workflow has been through' },
  { feature: FEATURE, table: 'sysevent', columns: ['instance', 'state'], optional: true, note: 'Events for the record that nobody has processed yet (state ready or queued)' },
];
