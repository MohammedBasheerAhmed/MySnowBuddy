# Live check: the 0.9 tools on a real instance (about 20 minutes)

Every tool added in 0.9 was built and tested without a live ServiceNow instance: unit tests, and the local preview with
fake data. This page is how to find out what is true on a real one. You (or an assistant you hand this page to) run it
on a personal developer instance and bring back two kinds of text: the **Self-check report** and each tool's **Copy as
Markdown** output. Nothing here needs a secret.

Do it on a PDI or a dev instance, **not on production**. Almost everything only reads. The few things that do more are
marked **[writes]** and are tiny:

- The Self-check runs one background script that only prints `NOWBUDDY_SELFCHECK_OK` (one line in Scripts - Background
  history). It skips this on an instance that looks like production.
- **Reload and record** (Client trace) and **Reload with debug info** (Portal inspector) reload the page.
- The editor changes the form field only. Do not press Ctrl+S, Apply & save or Update.
- System properties: an optional change of `glide.ui.session_timeout` from its current value to one minute more, then back.
  The panel asks first, names the instance and the update set, and remembers the old value.

Time budget: Prepare 2, Self-check 3, then 1 to 2 minutes per tool. In a hurry, do sections 0 to 5 (about 13 minutes).

## 0. Prepare (2 minutes)

1. `npm run build` in the repo (or use the `dist/` you were given).
2. Open `chrome://extensions` (Edge: `edge://extensions`), make sure Developer mode is on and the extension is loaded from
   `dist/`. Click the **reload arrow** on the NowBuddy card. The version must read **0.9.0**.
3. Open your PDI (`https://<your instance>.service-now.com`), sign in as an admin, and **reload the tab** (F5). A tab
   that was open before the reload has no Client trace recorder.
4. Open the browser console once (F12, Console) and leave it open: any red line that mentions `NowBuddy` is worth copying back.
5. Chrome or Edge **111 or newer** (`chrome://version`). Older versions ignore the recorder's `"world": "MAIN"`.
6. Open any incident: press `Ctrl+Shift+Space` and type its number (a demo PDI has `INC0010002`; if yours has not, open any
   row of `incident_list.do`). Keep that record for the sections below.

## 1. Self-check (3 minutes) - `/doctor`

Run this **first**. It tells you which of the other sections are worth your time.

**Open:** palette, type `is nowbuddy working` (or `/doctor`). It starts at once and takes up to a minute on a PDI (126 read-only requests, with a progress bar).

**Do:** wait for the verdict. Press **Copy report** and paste it into a file or this chat (if the browser blocks the
clipboard use **Download .md** or "Report text"). Then scroll the **Tools** list and note the status of these rows: Client
trace, Email tracer, Flows, approvals and SLAs, System properties, Data model map, Portal inspector, Update set preview
problems, Go to anything.

**What the colours mean** (the word is always shown, the colour only backs it up):

| Verdict | Meaning | What to do |
| --- | --- | --- |
| **Green** | Every check passed and every tool has what it needs. | Run the other sections; send back the report anyway. |
| **Amber** | NowBuddy can read the instance, but some tool will not work, has gaps, could not be fully checked, or a check needs a look (an unfamiliar release, no admin role for the script endpoint). Common and not a failure. | Read **What is behind it** (the copied report calls it Causes): one line per problem with the tools it touches. Note every row marked **Will not work** among the 0.9 tools. |
| **Red** | NowBuddy cannot work on this page at all: no page bridge, no session token, or the Table API cannot be read. A failing session (401, a login page) says "Your session has ended". | Fix it first: sign in again and reload the tab, then run again. If it stays red, send the report and the console lines. |

**Looks right when:** the verdict is Green or Amber; "NowBuddy on this page" shows version 0.9.0; Page bridge, Session token
and Table API (read) are OK; the Dictionary row says `sys_db_object` and `sys_dictionary` can be read; every 0.9 tool is
OK or Gaps. The ServiceNow release row says whether this release is the one NowBuddy was calibrated on (Australia patch 7);
another release is only a warning.

**Most likely wrong:**

1. A column state called **hidden** ("defined, but not returned") is believed to mean a field ACL. If it appears on many
   columns for an admin, the assumption that the Table API returns every requested column is wrong: many tools will show
   "Gaps" for no real reason.
2. A **missing table** is recognised by a 400 "Invalid table". If the release answers differently, the same tables show as
   "Not fully checked" or "not found" instead of "does not exist".
3. The **update set and scope pickers**, the **Stats API** and the **release** read (`stats.do`, else `glide.buildtag`) are
   each one assumption about an endpoint. Each shows as an amber row under API access.

**Copy back:** the whole Self-check report. It holds no token, key, user name or record value.

Result: [ ] OK  [ ] Partly  [ ] Broken

## 2. Go to anything (1 to 2 minutes) - palette, no slash

**Open:** `Ctrl+Shift+Space` anywhere.

**Do:**
1. Type `br: incident`. Wait a second.
2. Type `si: ajax`.
3. Type `incident` (no prefix). Then `glide.ui.session`.
4. Type `br: incident` again, move to a business rule with the arrow keys and press **Tab**. Press Esc once (closes only the
   menu).

**Looks right when:**
- Step 1 lists business rules whose names contain "incident", each with a kind badge, the name and a grey line such as
  `incident · global · after update`. Enter opens that rule's form.
- Step 2 lists Script Includes with "ajax" in the name.
- Step 3, bare `incident`: the first row is still the **Incident list**; found names come after it. `glide.ui.session`
  finds System Properties.
- Step 4: the menu offers Open, Open in a new tab, Edit the script here, Where is this used, Versions, Copy link, Copy
  sys_id. Nothing is typed into the page until you choose one.
- No kind says "cannot be read here" for an admin. A line such as "No match ... searched business rules you can read"
  for a name you can see in the list is a finding.

**Most likely wrong:**
1. A kind's table or search column is not what the code expects (the least sure ones: `flow:`, `action:`, `wf:`, `es:`,
   `sra:`). It shows as "Flows cannot be read here" or "No match" for a record you can see in its list. Try `flow: incident`
   and `wf: incident`.
2. The scope read (`sys_scope.scope` as a dot-walk in the field list). If the instance does not return it, every row says
   `global` and the "custom over platform" ranking looks wrong (ServiceNow's own rules above yours).
3. A table the user cannot read answers 403 (named in the line) or 200 with no rows (silently "No match"). If an admin gets
   either, the Self-check row for Go to anything shows which table.

**Copy back:** what each of the four queries showed (a screenshot is fine), and the Self-check "Go to anything" row.

Result: [ ] OK  [ ] Partly  [ ] Broken

## 3. Script editor additions (2 minutes) - on a business rule

**Open:** with `br: incident` (section 2) open any business rule that has a script of more than 15 lines. Click **Edit**
beside the Script field, or press `Alt+Shift+E`.

**Do (the editor changes only the form field; do not save):**
1. `Ctrl+Shift+O`: the function list. Type a few letters, Enter. Click the position text in the footer (for example
   `executeRule`): the same list opens.
2. `Shift+Alt+F` (or the **Format** button).
3. Type a character on a line. A bar appears beside the line numbers. Press `Alt+F3`. Open the **N changes** button and use
   **Revert all**.
4. Click inside a word, press `Ctrl+D` twice, type some letters, press Esc. Then `Ctrl+Z`.
5. On an empty line type `gr` and press Tab. Type a name, Tab again. Esc.
6. Close the editor, then reload the form. If the browser asks about unsaved changes, leave the page.

**Looks right when:** the list shows the rule's functions and jumps to them; Format either changes only spacing or says
in a toast that it refused and why (a refusal on an ordinary script is worth reporting); the bar and the changes list match
what you typed; `Ctrl+D` adds cursors and typing edits all of them; `gr` expands a template with the blanks selected;
**no Chrome window appeared** (bookmark, downloads, address bar).

**Most likely wrong:**
1. The browser shortcuts `Ctrl+D` (bookmark), `Ctrl+L` (address bar), `Ctrl+J` (downloads) and `Ctrl+Shift+O` (bookmark
   manager) are cancelled by the editor. Only a real Chrome tab proves it. It would show as a Chrome dialog or page opening
   instead of the editor action.
2. The in-place editor writing back to the real `g_form` (the existing sync is unchanged code, but the new features run on
   top of it). It would show as the form field not matching the editor after Revert or Format.
3. Speed and `Alt+click` (adds a cursor) on a long script or on Windows: typing lag of a second or more, or a Windows menu
   appearing on `Alt+click`.

**Copy back:** what happened at each numbered step (one word each is enough), the Chrome version, and any toast text.

Result: [ ] OK  [ ] Partly  [ ] Broken

## 4. Client trace (2 minutes) - `/watch`

**Needs:** the incident from section 0 (a standard incident form has client scripts and UI policies).

**Open:** on the incident, palette, `what did the client scripts do to the form` (or `/watch`).

**Do:**
1. Press **Reload and record**. The page reloads; a toast says NowBuddy is recording.
2. When the form is back, change **Category** or **Priority** (do not save). Reopen the panel if it closed.
3. Read **What stands out**, **Timeline** and **Fields**. On one row open **Call stack**.
4. Press **Copy as Markdown**, then **Stop recording**.

**Looks right when:** the panel shows events from two frames if the form sits in `gsft_main` (the shell and the form);
the timeline has your field change and the scripts it triggered, with a script name on most rows ("Client script: ...
(onChange on category)") or "Unknown script" with the nearest stack frame; nothing is saved to the record.

**Most likely wrong:**
1. **Script names.** Naming a script depends on ServiceNow client script functions carrying the script's sys_id in their
   name, or a `.jsdbx` file name. If real stacks are anonymous, every row says **Unknown script** and shows the raw frame
   (function, file, line). The tool still works, but less usefully. Copy the Call stack text back: it is the evidence.
2. **The recorder is not in the form frame.** The panel says "No recorder answered in: gsft_main" or "Not recording. The
   recorder is not loaded in this page yet". Reload the tab once (it needs the extension to have been reloaded first) and
   check Chrome is 111 or newer. On a Next Experience workspace form the recorder may see nothing at all.
3. **GlideAjax and `g_form.hasField`.** A GlideAjax row with a blank class or method, or a warning such as "call on a
   field that is not on the form" for a field that clearly is (a field hidden by a UI policy, a catalog variable).

**Copy back:** the Markdown from **Copy as Markdown**, the Call stack text of one row, and the Self-check "Client trace" row.

Result: [ ] OK  [ ] Partly  [ ] Broken

## 5. Why wasn't the email sent? (2 minutes) - `/notify`

**Needs:** an incident with some history (its activity log shows comments or assignments). **Needs data the PDI may not
have:** emails. A PDI often has few `sys_email` rows and outbound email may be switched off; the tool should say which.

**Open:** on the incident, palette, `why was the email not sent` (or `/notify`).

**Do:**
1. Read the list **Notifications that could fire** (names such as "Incident commented" or "Incident assigned to me"; yours
   may differ). Pick the first one (or type part of a name) and press **Trace**.
2. Read the verdict and the five steps: Matched, Event fired, Event processed, Email created, Email sent.
3. Open **Who would get it** and the banner about mail settings.
4. Optional: open `sys_email_list.do`, open any email row, then `/notify`: it explains why the mail went to its recipients.

**Looks right when:** the list holds the notifications defined on incident and task (active and inactive); each step says
Passed, Stopped here, Not reached or Cannot tell with a sentence; one step is marked **First broken link**, or all pass; an
old record says "cannot tell" (events are cleaned out after about 7 days) rather than "never fired"; the settings banner
says whether sending is switched off or redirected; **no** "could not read" note for an admin.

**Most likely wrong:**
1. **`sys_email.notification` probably does not exist** on most releases (the link is believed to live in `sys_email_log`).
   Then step 4 relies on matching the subject and says **Cannot tell** and "other emails for this record" instead of a
   definite answer. That is the designed fallback, but tell us.
2. **Events and emails are not found for the record** (`sysevent.instance`, `name`, `state`; `sys_email.instance`). It would show
   as "never queued" for an event you know fired, or "your account sees no rows of sysevent at all" for an admin.
3. **People rules.** "Left out" for a user who does get the mail, or "Gets it" for one who does not. Compare with the user's
   **Notification** field (1 = Disabled), their Notification Devices, and the notification's own "Send to event creator" box.

**Copy back:** **Copy summary as Markdown** (addresses are masked), a screenshot of the five steps if they look wrong, and the
Self-check "Email tracer" row.

Result: [ ] OK  [ ] Partly  [ ] Broken  [ ] Skipped (no mail data)

## 6. Flows, approvals and SLAs (2 minutes) - `/flows`

**Needs:** an incident that has an SLA (the **Task SLAs** related list is not empty). **Needs data the PDI may not
have:** a running flow or a pending approval. With none, the check is that the panel says "Nothing is running on this
record" only after it read every source, and names any source it could not read. A change request in Assess with approvers
is a good second record if you have one.

**Open:** on the record, palette, `why is this ticket stuck` (or `/flows`).

**Do:**
1. Read the headline ("Waiting on: ..." or "Running now: ..." or "Nothing is running") and the sections below it.
2. Compare with the platform: the **Task SLAs** and **Approvals** related lists on the form, and the list
   `sys_flow_context_list.do` filtered with Source record = this record.
3. Press **Copy summary as Markdown**.

**Looks right when:** SLA names, stage and percentage match the Task SLAs list; every approval in the Approvals list
appears with the same state and approver; every flow execution appears with the same state; a source that cannot be read
shows in the "Could not read N sources" box, never as an empty section; on a table that is not a task (a user record) the
panel says SLAs and tasks do not apply.

**Most likely wrong:**
1. **`sys_flow_context.source_record`** holding the record's sys_id (and the state values). If not, flows are missing even
   though Flow Designer shows runs, or a box says "the instance did not apply the filter".
2. **SLA breach.** The panel says "breached" from `has_breached`, a planned end in the past or the business percentage. It
   shows as breached when the list says In progress (or the reverse).
3. **Approvals.** `sysapproval_approver.sysapproval` or `document_id` is not how this release links approvals: a pending
   approval is missing, the approver is a group record number instead of a name, or "waiting for N days" is off.

**Copy back:** the Markdown summary, and a note of what the related lists said where it differs.

Result: [ ] OK  [ ] Partly  [ ] Broken  [ ] Skipped (nothing running)

## 7. System properties (2 minutes) - `/prop`

**Open:** palette, `find a system property`, or `/prop glide.servlet.uri`.

**Do:**
1. The read: with `/prop glide.servlet.uri` the panel opens that property (value, type, description, scope, last updated).
2. Under **Who reads it** press **Find scripts that use it** (about 20 queries, 10 to 20 seconds). Many stock notifications and scripts use `glide.servlet.uri`.
3. Search for `session` and look at the **Developer switches** block.
4. **[writes] Optional, only if you are happy to:** open `/prop glide.ui.session_timeout`. Change its number to one more
   than it is now. Read the confirmation (it names the instance and the current update set), confirm. Then press
   **Restore** under "Changed from this panel", confirm. The change goes into your current update set (Default on a PDI;
   the restore adds one more entry); delete nothing. If the panel says the property is "not present on this instance", skip.

**Looks right when:** the value, type and description match the platform's record (open it with the link); Who reads it
lists scripts under Sets it, Reads it or Mentions it, with a summary of how many tables were searched and which could not
be; a property of type password, or with secret in its name, shows no value and cannot be edited; after the optional change the
panel reads the property back and says so; after Restore it is the original value.

**Most likely wrong:**
1. **Optional columns** (`description`, `choices`, `suffix`, `is_private`, `read_roles`, `write_roles`, `sys_scope`). If the
   instance does not return one, that part of the view is blank and description search quietly skips it.
2. **The write.** `update_record` on `sys_properties` is refused, or succeeds but is not in the update set, or the read-back
   says "the instance holds something other than what was written". It shows as an error line in the panel.
3. **Who reads it.** A property you know a script reads shows no result, or "no table could be searched" (an error, never
   "nobody uses it"). Or everything lands in "Mentions it".

**Copy back:** what step 2 listed (a screenshot), the Self-check "System properties" row, and the exact error text if the
change failed.

Result: [ ] OK  [ ] Partly  [ ] Broken  [ ] Skipped

## 8. Data model map and dot-walk paths (2 minutes) - `/map`, `/path`

**Open:** palette, `how are these tables related`, or `/map incident`.

**Do:**
1. **Map**: read the facts line, the diagram, then switch to **List**. Click a table in the diagram to re-centre it, then Back.
2. **Path finder**: `/path incident cmn_department`, press **Find paths**. Press Copy on the GlideRecord line.
3. **Dot-walk** tab: expand `caller_id`.
4. Optional: in Scripts - Background (read only) run
   `var gr = new GlideRecord('incident'); gr.get('number', 'INC0010002'); gs.info(gr.getElement('caller_id.department.name'));`
   and compare with what the panel offered.

**Looks right when:** the map says incident extends Task, lists its reference fields (caller_id, assigned_to,
assignment_group, ...) and the tables that point back at it; the row count is close to the Incident list's total; the
path finder lists `caller_id.department` among the routes (through `sys_user`), with the five copy lines; the Dot-walk tab
lists the fields of `sys_user` under `caller_id`. A message "Your user cannot read sys_dictionary" for an admin is a finding.

**Most likely wrong:**
1. **`sys_dictionary.reference` and `internal_type`** hold what the code expects (a table name; `reference`, `glide_list`,
   `document_id`). If not, the map shows no references, or paths are missing: the diagram has few lines and the path finder
   says "No path found" between two tables you know are linked.
2. **The extends chain** (`sys_db_object.super_class`, read as `super_class.name`). If not, incident has no parent in the
   diagram and inherited fields are not marked "from task".
3. **The `getElement('a.b.c')` line** works for dot-walks on the target release. If the optional script prints nothing or an
   empty value, say so: the tool says it does not offer `getValue('a.b.c')` for that reason.

**Copy back:** **Copy as Markdown** from the Map tab, the path list as text or a screenshot, and the Self-check "Data model
map" row.

Result: [ ] OK  [ ] Partly  [ ] Broken

## 9. Portal inspector (1 to 2 minutes) - `/sp`

**Needs:** a Service Portal page. On a PDI open `https://<your instance>.service-now.com/sp?id=index` (admin). An Employee
Center (`/esc`) works the same if it is installed.

**Open:** on that page, palette, `which widget is on this portal page` (or `/sp`).

**Do:**
1. Read the widget list and compare it with Page X-ray (`Alt+Shift+X`) outlines.
2. Pick a widget. Read **c.data** and **options**. If it says Angular debug info is off, press **Reload with debug info**
   (it asks, then reloads the page) and open the panel again.
3. Press **Take snapshot**, click something in the portal (a search box, a tile), press **Refresh**.
4. Look at the "Scope found as ..." line under the tree.

**Looks right when:** the widget names and order match the page; c.data shows the widget's data; after the click the
snapshot comparison lists the keys that changed; the links (widget record, Widget Editor, page) open real pages.

**Most likely wrong:**
1. **Widget markers on the page** (`v<widget sys_id>` classes and `x<instance sys_id>` ids). If not, the panel says
   "no widgets found" or lists fewer widgets, with less information.
2. **AngularJS scope access.** c.data stays empty or the panel keeps saying debug info is off after the reload (the
   reload may not keep debug info while you move around the portal).
3. **The widget record read** (`sp_widget` columns) and the Widget Editor link `/sp_config?id=widget_editor&sys_id=...`. It
   shows as "Could not read the widget record" or a link that does not open the editor.

**Copy back:** a screenshot of the list and one widget's tree, **Copy JSON** of one widget's c.data, and the Self-check
"Portal inspector" row.

Result: [ ] OK  [ ] Partly  [ ] Broken  [ ] Skipped (no portal)

## 10. Update set preview problems (1 minute) - `/preview`

**Needs data a fresh PDI does not have:** a retrieved update set that has been previewed and has problems. There is no safe
one-minute way to make one, so the honest check is below. If you already have any retrieved update set (even a committed
one), use it.

**Open:** palette, `update set will not commit` (or `/preview`).

**Do:**
1. With no retrieved update sets the picker should say so plainly and not fail. With some, it lists them with their state
   and how many problems each has.
2. Open one. Read the verdict (Ready to commit, Blocked by N problems, Not previewed yet, Already committed, ...).
3. If it has problems: open **How this was read**.
4. Press **Copy as Markdown**.

**Looks right when:** the picker and verdict match **System Update Sets > Retrieved Update Sets** (state, problem count);
**How this was read** lists the columns it found for `sys_update_preview_problem` (set, remote update, type, description,
status) and names any it did not; no verdict ever says "Ready" when problems are unresolved.

**Most likely wrong:**
1. **`sys_update_preview_problem` column names** are found from the dictionary at run time. A role in "How this was read"
   shown as not found means that section is thin (no type, no status, ...).
2. **Problem wording.** Problems land in "Other problem" with only the instance's own text, because the patterns that sort
   them into Missing reference, Newer local version, Missing table and so on do not match this release's wording.
3. **Status and state values** (`skipped`, `accepted`, `resolved`; `sys_remote_update_set.state` loaded/previewed/committed).
   It would show as "Status unclear" on problems you resolved, or a wrong verdict.

An optional 10-minute extra, if you want a real problem: export a small local update set as XML, import it back with
**Retrieved Update Sets > Import Update Set from XML**, and Preview it. **Do not Commit.** It only creates a retrieved update
set that you can delete afterwards. It usually shows no problem (the records are identical), so it tests the "Ready to
commit" path, not the explanations.

**Copy back:** the Markdown report (or a screenshot of the empty picker), "How this was read", and the Self-check "Update set
preview problems" row.

Result: [ ] OK  [ ] Partly  [ ] Broken  [ ] Skipped (no retrieved set)

## Not covered here

The AI agent and MCP tools for several of these (`explain_email`, `explain_process`, `map_table`, `find_dotwalk_path`,
`explain_preview_problems`, `find_artifact`, `run_selfcheck`, `find_property`, `read_client_trace`) need an AI key or an MCP
client. They call the same code as the panels, so a panel that works is most of the evidence.

## What to send back

1. The Self-check report (section 1), the whole text.
2. For each section you ran: the **Result** line, and what is listed under **Copy back**.
3. Any red `NowBuddy` line from the console, with the step you were on.
4. Chrome or Edge version, the ServiceNow release (the Self-check report has it), and whether the user was an admin.

A one-line-per-tool summary is enough to start with:

| Tool | Result | Note |
| --- | --- | --- |
| Self-check | | |
| Go to anything | | |
| Script editor additions | | |
| Client trace | | |
| Email tracer | | |
| Flows, approvals and SLAs | | |
| System properties | | |
| Data model map and paths | | |
| Portal inspector | | |
| Update set preview problems | | |

## Assumptions in one table

Each row is an assumption that could not be checked without a live instance, the tool it belongs to, and how a wrong
guess shows up. The full lists are in [features/](features/) (one page per tool) and the tables and columns are in
`src/lib/requirements/`, which the Self-check tests for you.

| Assumption | Tool | How to tell it is wrong |
| --- | --- | --- |
| The Table API returns every requested valid column, so a column that does not come back is "hidden" by an ACL | Self-check | Many "defined, but not returned" columns for an admin; many tools show Gaps |
| A missing table answers 400 "Invalid table" (a 403 means an ACL, a 404 "not found") | Self-check | Missing tables show as "Not fully checked" instead of "does not exist" |
| `concoursepicker/updateset` and `/application` answer a GET with `result.current`; the release is readable from `stats.do` or `glide.buildtag` | Self-check | Amber rows under API access; "ServiceNow release" says "not readable" |
| Every kind's table and search columns exist (least sure: `flow:`, `action:`, `wf:`, `es:`, `sra:`) | Go to anything | "Flows cannot be read here" or "No match" for a record you can see in its list |
| The scope comes back as `sys_scope.scope` in the field list | Go to anything | Every row says `global`; platform rules rank above yours |
| A table the user cannot read answers 403, or 200 with no rows | Go to anything, Email tracer, Flows | Named "cannot be read" (403) versus a silent "No match" or "nothing" (200); the "sees no rows at all" check says which |
| The browser lets the editor cancel `Ctrl+D`, `Ctrl+L`, `Ctrl+J` and `Ctrl+Shift+O` in a real tab | Script editor | A Chrome bookmark, address bar, downloads or bookmark manager opens instead |
| Edits and reverts in the in-place editor reach the real `g_form` field | Script editor | The form field does not match the editor after Format or Revert |
| Client script functions carry the script's sys_id (or a `.jsdbx` file name) in their stack frame | Client trace | Every row says "Unknown script" with only a raw frame |
| The manifest's MAIN-world recorder runs in the `gsft_main` frame and the shell, on Chrome 111+ | Client trace | "No recorder answered in: gsft_main"; "Not recording. The recorder is not loaded" |
| `GlideAjax` keeps `processor` and `params`; `g_form.hasField` is false only for a field not on the form | Client trace | Blank class or method on a GlideAjax row; a false "not on the form" warning |
| `sys_email.notification` exists (it probably does not) | Email tracer | "Cannot tell" at Email created, with a note about other emails |
| `sysevent` has `instance`, `name`, `state`, and old events are cleaned out after about 7 days | Email tracer | "Never queued" for an event that fired, or "cannot tell" on a recent record |
| `sys_user.notification` 1 means Disabled; `cmn_notif_device` rows decide who has an active email device | Email tracer | "Left out" for someone who gets the mail, or the reverse |
| `sys_flow_context.source_record` holds the record's sys_id; the state values are QUEUED, IN_PROGRESS, WAITING, COMPLETE, CANCELLED, ERROR | Flows | Flow Designer shows runs the panel does not; "the instance did not apply the filter" |
| `task_sla.has_breached`, the business percentage and `stage` mean what the panel thinks | Flows | "Breached" in the panel but In progress in the Task SLAs list |
| Approvals link by `sysapproval` or `document_id`; the group approval link is `sysapproval_group.parent` | Flows | A pending approval is missing; the approver reads as a record number; wrong wait time |
| `sys_properties` optional columns exist; `update_record` on it works and is captured in the update set | System properties | Blank description or choices; an error line on Change; "holds something other than what was written" |
| The scripts searched by Who reads it, and how a read is told from a mention | System properties | A known reader is missing; "no table could be searched"; everything under "Mentions it" |
| `sys_dictionary.reference` holds the table name and `internal_type` is `reference`, `glide_list`, `document_id` | Data model map | No references in the map; "No path found" between linked tables |
| `sys_db_object.super_class` gives the parent table | Data model map | Incident has no parent; inherited fields not marked |
| `getElement('a.b.c')` dot-walks on this release | Data model map | The optional background script prints nothing or an empty value |
| Widget root has class `v<widget sys_id>`, instance wrapper id `x<instance sys_id>`; `window.angular` scopes carry `data` and `options` | Portal inspector | "No widgets found"; c.data empty or "debug info is off" after the reload |
| `/sp_config?id=widget_editor&sys_id=...` and `page_edit&p=...` are the editor links | Portal inspector | A link that does not open the Widget Editor or Page Editor |
| `sys_update_preview_problem` has set, update, type, description and status columns the dictionary scan finds | Update set preview problems | "How this was read" lists a role as not found; thin cards |
| Problem wording and status values match the patterns in `src/lib/previewProblems.js` | Update set preview problems | Problems land in "Other problem"; "Status unclear" on resolved problems |
| `sys_update_xml.remote_update_set` exists, so a missing record's provider can be found | Update set preview problems | Cards say "the search could not run" instead of naming a provider set |
