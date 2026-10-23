# Flows, approvals and SLAs (`/flows`, `/process`)

"Why is this ticket stuck?" One read-only view of everything running, or run, against the record on screen, with a plain-words
"Waiting on: ..." at the top. Open it from the launcher (Flows, approvals and SLAs), the command palette ("what is running on this
record"), or `/flows` / `/process` in the chat box.

Files: `src/lib/processView.js` (pure: what is read, how rows are checked, the wording), `src/content/processView.js` (the reads),
`src/sidebar/ProcessPanel.jsx` and `process.css` (the panel), `tests/processview.test.js`, `preview/fixtures/process.js` (fake
instance answers for the preview), `src/lib/requirements/process.js` (what the Self-check panel tests).

## What it reads

Every source is independent. A table that is missing or that your user cannot read leaves that section out with a visible note
("Could not read N sources" box and a stub where the section would be); the others still load. The headline only says
"Nothing is running on this record" when every source that applies was read.

| Section | Table | Found by | Columns used |
| --- | --- | --- | --- |
| Flow Designer | `sys_flow_context` | `source_record = <sys_id>` | `name`, `flow`, `state`, `error_message`, `source_table`, `started`, `ended`, `sys_created_on`, `sys_updated_on` |
| Flow log (optional) | `sys_flow_log` | `context IN <flow contexts>` | `context`, `message`, `level`, `sys_created_on` |
| Approvals | `sysapproval_approver` | `sysapproval = <id>` OR `document_id = <id>` (only the columns that exist) | `approver`, `group`, `state`, `comments`, `due_date`, `sys_created_on`, `sys_updated_on` |
| Group approvals (optional) | `sysapproval_group` | `parent = <id>` | `number`, `approval`, `assignment_group` |
| SLAs | `task_sla` | `task = <id>` | `sla`, `stage`, `has_breached`, `percentage`, `business_percentage`, `planned_end_time`, `start_time`, `end_time`, `pause_time` |
| Tasks | `task` | `parent = <id>` | `number`, `short_description`, `state`, `active`, `sys_class_name`, `assigned_to`, `assignment_group` |
| Tasks (by table) | `sc_task.request_item`, `sc_req_item.request`, `change_task.change_request`, `problem_task.problem` | the record is the requested item, request, change or problem | same task columns; a task found twice is listed once |
| Legacy workflow | `wf_context` | `id = <id>` | `workflow_version`, `name`, `state`, `started`, `ended` |
| Current activity | `wf_executing` | `context IN <active contexts>` | `activity`, `activity.activity_definition`, `state`, `started` |
| History (optional) | `wf_history` | `context IN <contexts>` | `activity`, `activity_index`, `state`, `result`, `started`, `ended`, `fault_description` |
| Queued events | `sysevent` | `instance = <id>` and `state IN ready,queued` | `name`, `state`, `queue`, `process_on` |

SLAs and child tasks are only read for task records (the table extends `task`); on any other table, such as `sys_user`, the panel
says so in one line instead of showing an empty section. Flows, approvals, workflow and events apply to every table.

## How a wrong column cannot turn into a wrong answer

ServiceNow silently ignores a condition on a column that does not exist and then returns every row. Two guards:

1. Before reading, the data dictionary (`sys_db_object`, `sys_dictionary`) is asked which tables and which condition columns exist.
   A missing table is "not on this instance"; a missing condition column is "could not check <table>: it has no <column> column".
2. Every row that comes back is checked against the record again (`keep` in `PROBES`). If any row does not belong to the record, the
   whole source is reported as "could not check: the instance did not apply the filter", never as an empty list.

If the dictionary itself cannot be read (an ACL hides it, and an ACL returns no rows rather than an error), the table on screen is
missing from the answer, so the schema is not trusted: everything is tried and only guard 2 applies. The panel says so.

3. **An empty answer is confirmed.** The same ACL behaviour means "no flows for this record" could just be "you may not read
   sys_flow_context". When a primary source (flows, approvals, SLAs, workflow, events; not `task`, the record is one) comes back
   empty, one unfiltered one-row read (`sysparm_fields=sys_id`, `sysparm_limit=1`) checks the user sees any row of that table.
   If not, the section is "could not read: your user sees no rows of <table> at all" and the headline cannot be the all-clear.
   At most five extra small reads. A user who sees some rows but not this record's cannot be detected.

## What "waiting on" means (priority order)

1. A failed flow (Flow Designer state Error), unless a later run of the same flow completed.
2. A pending approval, longest wait first ("approval from Abel Tuter, requested 3 days ago"); several are one line.
3. A rejected approval, only when nothing is pending.
4. A flow in the Waiting state, a flow queued more than 15 minutes or running more than an hour, a legacy workflow in an activity
   (with the activity name, what kind of wait it is and how long; a long timer is not called stuck, anything else waiting over a day
   "may be stuck" and over seven days "very likely stuck").
5. Open child tasks.
6. An SLA that has breached (flag, 100 percent, or planned end in the past), then one that is paused.
7. Events in `ready` or `queued` that have waited more than five minutes.

Otherwise: "Running now: ..." (a flow in progress, an SLA clock counting), or "Nothing is running on this record". If a source could
not be read and nothing is blocking: "Nothing found that is holding this record up" plus how many sources could not be read.
A closed record (`active = false`) gets a line saying the findings may be left over.

Times are relative ("3 days ago") with the exact UTC stamp in the hover title. "Copy summary as Markdown" copies the same report
(secret-looking values are redacted); "Ask AI" sends it to the chat.

## Assumptions to check on a live instance

None of this was checked against a live instance (the PDI was not reachable); the Self-check panel lists the columns.

- `sys_flow_context`: `source_record` holds the record's sys_id (and `source_table` its table); `state` values QUEUED, IN_PROGRESS,
  WAITING, COMPLETE, CANCELLED, ERROR (matched by wording, so display labels work too); `started` and `ended` may not exist, in which
  case created and updated are used. `error_message`, `name` and `flow` are as the "What went wrong?" panel already reads them.
- `sys_flow_log` with `context` and `message` columns is guessed; if the table or the columns are not there the section just has no
  log lines and says so in a small note.
- `sysapproval_approver`: `sysapproval` (task approvals) and `document_id` (Flow Designer approvals on any table); `state`
  `requested` is pending; `group` is the approving group; `due_date` exists. "Waiting for X for N days" counts from `sys_updated_on`
  (when the approval became Requested, usually its creation), because sequential approvals are created before they are requested.
- `sysapproval_group.parent` and `.approval` for group approvals are the least certain of all; they are optional, and a pending group
  approval is only a blocker when no individual approval is pending.
- `task_sla`: `business_percentage` (falls back to `percentage`): the business percentage follows the SLA's schedule, while the
  plain percentage counts nights and weekends and passes 100 long before an 8-to-5 SLA breaches. "Breached" comes from
  `has_breached`, a planned end in the past, or a business percentage of 100 or more; the plain percentage counts only when nothing
  else was readable. `stage` values in_progress, paused, breached, achieved, completed, cancelled.
- `sysapproval_group` extends `task` and points at the record through `parent`, so child tasks are read with
  `sys_class_name!=sysapproval_group` (and such rows are dropped): a group approval is an approval, not an open task.
- `sysapproval_approver.group` references the group approval record (`sysapproval_group`), so its display value may be that
  record's number rather than the group's name.
- A rejection is "waiting on" only while nothing is pending and no approval was approved after it (a re-submitted record).
- `wf_context.state` values are believed to be executing, finished, cancelled; anything with "fault" is shown as failed.
- `wf_context.id` holds the record's sys_id; `wf_executing.context`/`.activity`; the activity type is read as the dot-walk
  `activity.activity_definition` (display value); `wf_history` columns are display only.
- `sysevent`: `instance` (the record's sys_id), `state` (ready, queued; rows in any other state mean the filter was ignored), and
  `process_on`: an event scheduled for later (`gs.eventQueueScheduled`, reminders, SLA warnings) is "Scheduled", not a backlog,
  and a due one has waited since the later of its creation and its `process_on`.
- A flow's run time is worked out from `started`/`ended` (or created/updated), not read from a `run_time` column.

## Not done

Flow Designer action-level execution details (the `sys_flow_report_doc_chunk` family) are not read; the flow's own record links to
the execution view. Inbound/outbound email is the Email tracer's job. No writes of any kind.
