# MySnowBuddy

AI agent and developer toolkit for ServiceNow: an agent that reads your instance
and writes **verified** client and server scripts, a command palette, a
context-aware chat sidebar, and deterministic analysis tools for code quality,
deployment safety and instance comparison. Manifest V3 browser extension
(Chrome + Edge).

A core design principle: **deterministic checks run first, locally and for
free; the AI is only asked to do what a rule engine cannot.** Linting, conflict
detection, update set collisions, diffing and the security audit all produce
results without consuming a single token.

See [PROGRESS.md](PROGRESS.md) for current build status and
[docs/decisions.md](docs/decisions.md) for implementation decisions and open
follow-ups (start any new session by reading those two files first).

## Tech stack
- Plain JavaScript (no TypeScript)
- React for the chat sidebar and options page UI, transpiled via esbuild (JSX only)
- Anthropic (Claude Opus 5.5 by default, Sonnet 5.5 / Haiku 5.5 selectable) and
  OpenAI (`gpt-5-mini`, `gpt-5`) through one provider-neutral message format
  (`src/providers/`), both with tool calling
- Chat history and API keys are stored only in `chrome.storage.local`
  (never `.sync`, never sent anywhere except directly to the provider you pick)
- No runtime dependencies beyond React; the MCP bridge (`mcp/`) is dependency-free Node

## Project structure
```
manifest.json          Manifest V3 config (copied as-is into dist/)
build.js                esbuild build script
src/
  background/           Service worker, cross-instance client, compare engine
  providers/             OpenAI + Anthropic adapters, neutral message format, secret redaction
  page/                   Page-world bridge (reads g_form / g_ck)
  content/                Content script: command palette, context detection, and all
                           instance-facing features (search, update sets, logs,
                           form diff, dependencies, audit, REST)
  sidebar/                React chat sidebar + feature panels + speech input
  options/                React options/settings page
  lib/                     Shared: line-diff engine, linter, script safety,
                           artifact definitions, report/export helpers
    apiCatalog/            Verified client + server ServiceNow API catalog (data + lookup)
    agent/                 Tool schemas, agent loop, approval policy, audit/undo, run state
    skills/                Client Script and Server Script skill packs
    verify.js apiCheck.js  Verification pipeline and catalog checker
    mockForm.js            Client script simulator (mock g_form, g_user, GlideAjax, g_modal)
  sandbox/ offscreen/     Sandboxed page + offscreen host that evaluate simulated scripts
mcp/                    Local MCP server so external agents can use the extension's tools
preview/                Dev-only harness: the real sidebar with a scripted model (npm run preview)
tests/evals/            Eval cases for the skills (offline in npm test, live with a key)
dist/                   Build output - load THIS folder as an unpacked extension
```

## Setup
```
npm install
npm run build      # one-off build
npm run watch       # rebuild on file changes (re-run `npm run build` after
                     # editing manifest.json/options.html/css, since those are
                     # only copied once at watch startup)
npm test           # unit tests + offline evals
npm run eval -- --live   # score a real model against the eval cases (needs a key)
npm run preview    # dev harness at http://localhost:4173/preview.html
```

After loading the extension open its **Options** page, pick Anthropic or OpenAI
and paste a key.

> If npm install fails with `SELF_SIGNED_CERT_IN_CHAIN`, your network has a
> TLS-inspecting proxy that Node doesn't trust by default. Prefer configuring
> `NODE_EXTRA_CA_CERTS` with your corporate root CA. `npm install --strict-ssl=false`
> works as a one-off, scoped workaround but disables certificate verification —
> understand the risk before using it.

## Load as an unpacked extension
1. `npm run build`
2. Chrome/Edge → Extensions → Enable Developer Mode → "Load unpacked"
3. Select the `dist/` folder

## Features

### AI agent (client and server script skills)

Type a plain message in the sidebar and the agent works the way a careful
ServiceNow developer would: it **looks first, builds second, proves it, and only
then asks to change anything**.

```
"When priority becomes 1, require an assignment group"
  reads the page and what already runs on incident     (get_page_context, list_logic_for_table)
  reads the real field names                           (get_schema)
  drafts an onChange client script
  verifies it: catches a misspelled g_form method      (verify_script)
  fixes it, verifies again, simulates priority 3 -> 1  (test_client_script)
  asks you to approve saving it, inactive, with a diff (save_artifact)
```

**Skills.** A skill pack bundles the rules, templates and pitfalls for one kind of
work, and is loaded by the page you are on:

| Skill | Covers | Loaded when |
| --- | --- | --- |
| Client Script | onLoad / onChange / onSubmit / onCellEdit, catalog client scripts, UI policies, GlideAjax, `g_form` | a client script, UI policy or form is open |
| Server Script | Business Rule timing, Script Includes (incl. client-callable), ACLs, scheduled jobs, GlideRecord / GlideAggregate rules, scoped vs global | a business rule, script include, ACL or list is open |

`/skills` shows which is active. The guides are plain markdown in
`src/lib/skills/` and are also served to external agents as MCP resources.

**Grounding.** Most bad AI-generated ServiceNow code comes from invented methods
and invented field names, so the agent is held to two sources of truth:

- **API catalog** (`src/lib/apiCatalog/`): about 670 client and server methods,
  each tagged with where it runs, deprecation, scope limits and gotchas. A script
  that calls `g_form.setMandatroy`, uses `gs` in a browser script, `g_form` on the
  server, or `GlideRecord` where `GlideAjax` is needed is rejected. The API explorer
  panel (`/api`) browses it.
- **Live dictionary**: `get_schema` reads the real fields (including inherited ones)
  and every field name in a script and every column of a saved artifact is checked
  against it.

**Verification** (`verify_script`, `/verify`, no AI tokens): syntax, the API catalog,
~20 lint rules, structural rules (onChange needs an `isLoading` guard,
`GlideAjax` needs `sysparm_name` and a callback, `next()` before `query()`, `update()`
in a before rule, ACLs must set `answer`, ES6 in ES5 server scripts, browser globals
on the server, and more) and field names. A script with errors cannot be saved.

**Simulator and test bench.** `test_client_script` and the test bench panel
(`/testclient`) run a client script against a simulated form (fields, user roles,
`getReference`, stubbed `GlideAjax` answers, `g_modal`) and show every `g_form` call,
field change, message and warning, without touching a real form or server. The
script runs in a sandboxed extension page (no extension APIs, no cookies, no page
access) hosted by an offscreen document, with a 6 second kill switch.

**Safety model.** Every tool has a tier:

| Tier | Examples | Runs |
| --- | --- | --- |
| observe | read_page, navigate, get_instance_info, get_schema, query_table, read_artifact, search_code, read_logs, lookup_api, explain_access, explain_field, check_update_set, scan_instance_health | automatically |
| draft | verify_script, test_client_script | automatically (no side effects) |
| run | dry_run_script, run_atf | asks (or automatically in "Auto dry runs" mode; never ATF, never for external agents) |
| write | set_form_field, save_form, save_artifact, create_record, update_record, delete_record, click_ui_action, run_background_script, switch_update_set, switch_application_scope, impersonate_user, end_impersonation, run_ui_steps, undo_last_write | always asks, with a diff or the full record; on PROD you must type the instance name |

Autonomy can be set to *Read only*, *Ask first* or *Auto dry runs* from the
composer. Reads go through the Table API under your own permissions, with
credential-like tables blocked and `javascript:` queries refused, and every column
in a query is checked against the dictionary (ServiceNow silently ignores unknown
columns). A sensitive-table policy refuses credential tables and password fields
outright, refuses deleting users, tables and columns, warns on role/ACL/property/code
changes, and routes script fields to `save_artifact` (created inactive by default).
Writes are logged and, where possible, can be undone (`/changes`, `/undo`).
Everything tools return is treated as data, never as instructions, and every model
request is redacted centrally before it leaves the browser.

### Control ServiceNow from your browser (and from Claude Code)

The agent can drive the instance the way you would, with your approval for
anything that changes something:

- **See**: `read_page` returns a structured snapshot of the screen: form sections
  and fields (value, display value, mandatory/read-only/visible), unsaved changes,
  messages, UI action buttons, related lists, or a list's query, columns and rows.
  `get_instance_info` reports user, roles, build, update set and scope.
- **Move**: `navigate` opens lists, records, new records and pages on the same
  instance (never processors such as `logout.do` or URLs with action parameters),
  and refuses to leave a form with unsaved changes.
- **Act**: `click_ui_action` (exact match, refuses if a different record opened
  while you were deciding), `create_record` / `update_record` / `delete_record`
  with field-level diffs and undo, `run_background_script` (after a dry run),
  `switch_update_set` / `switch_application_scope` (read back to confirm),
  `impersonate_user` / `end_impersonation`, `run_atf`.
- **Explain**: `explain_access`, `explain_field`, `check_update_set` and
  `scan_instance_health` expose the analysis panels below as tools.

**Local MCP bridge.** `mcp/snowbuddy-mcp.js` lets Claude Code or any MCP client call
the same tools through your logged-in tab, plus two MCP-only tools: `screenshot`
(after you click the toolbar icon on that tab once) and `list_tabs` (every tool takes
`tab_id`). Options → Agent → "What an external agent may do" caps external agents at
read only, read and draft, up to dry runs and tests, or everything with approval;
it is enforced in the service worker and the page. Loopback only, token-paired,
approvals always happen in the browser. See [mcp/README.md](mcp/README.md).

**Evals.** `tests/evals/` holds 13 tasks (6 client, 7 server) with reference
solutions, simulator scenarios and known-bad scripts. `npm test` checks that the
reference solutions verify clean and behave, and that every bad script is caught.
`npm run eval -- --live` has a real model write each script from the skill guide
and scores it the same way (`--no-guide` shows what the guide adds).

### Command palette
`Ctrl+Shift+Space` anywhere on an instance (remappable at
`chrome://extensions/shortcuts`). It is the primary way to drive the
extension — every action lives in one searchable list instead of a nested menu.

Type to fuzzy-match commands, or use the input as an omnibox:

| You type | You get |
| --- | --- |
| `incident` | Incident list / new Incident, plus a live `sys_db_object` lookup for any other table |
| a 32-char sys_id | Resolves it through `sys_metadata`, `task`, `sys_user` and `cmdb_ci` and opens the record |
| `@jsmith` | Matching users, Enter to impersonate |
| `/lint`, `/review`, … | Runs the chat slash command |
| a problem, in your own words (`who changed this`, `why can't they see this`, `what did I change`) | The command that answers it |
| nothing | Pinned commands, then Suggested for this page, then recent commands and records, then everything grouped |

`Enter` runs, `Shift`/`Ctrl+Enter` opens navigations in a new tab, `↑`/`↓` or
`Ctrl+N`/`Ctrl+P` move, `Esc` closes. Commands are context-aware: when a record
is open, "This record" and "This table" groups appear.

The palette is page-aware: on a script record it suggests lint, the full-screen
editor and versions; on a list it suggests explain, count and copy query; on an
update set it suggests review and ship check. `Alt+P` pins the highlighted
command (up to 8, kept at the top), and `Alt+1`..`Alt+9` runs the Nth result.
First run shows a short tour card; "Quick tour" in the palette brings it back.

What it covers beyond the analysis features below:

- **This record** — copy sys_id / URL / markdown link, open XML, audit history,
  versions, the update set entry that captured it, record info (created and
  updated by/when, update count)
- **This table** — dictionary, business rules, client scripts, UI actions, UI
  policies, ACLs, data policies, notifications, form and list layouts, related
  lists, labels, choices and audit history, each as a pre-filtered list
- **Instance** — flush cache, node stats and build, XML stats, thread info
- **Tools** — background script runner, REST builder, impersonate, end
  impersonation, switch update set, toggle technical field names on the form
- **Navigate** — properties, logs, transactions, update sets, scheduled jobs,
  email, events, users, groups, roles, applications, plugins, REST explorer,
  Flow Designer, Script Debugger

### On the page itself
The tools sit where you are working, not behind a panel:

- **Bottom bar** — quick actions for the current page. On a record: copy sys_id
  or link, open XML, who changed it, recent versions, record info, and on a
  script: lint, edit in the full-screen editor or VS Code, ask the AI. On a list:
  explain the filter in plain words, count rows, copy the encoded query, copy
  the equivalent GlideRecord code.
- **`⋯` on a form label** — copy the field name or value, open its dictionary
  entry, see the ACLs on it, last change, or X-ray what controls it. Script
  fields also get **Lint** and **AI** buttons.
- **`⋯` on a list column header** — copy the name, dictionary entry, ACLs.
- **Select a sys_id anywhere** to peek at the record it points to.
- **Floating tool windows** — code search, REST builder, script runner, My work,
  Ship check, Access debugger and the API explorer open as draggable windows over
  the page. Several can be open at once; the dock button moves one into the
  sidebar.

These need the classic form and list DOM (including classic pages inside the
Next Experience shell). Native workspace forms get the bottom bar only. In the
options page, "Where tools open" switches windows to the sidebar, and the page
toolbar and menus can be turned off.

### Chat sidebar
Toggle with `Alt+Shift+C` or from the extension icon. The header shows an
environment badge derived from the instance name — PROD in red, TEST/STAGE in
amber, DEV in green, neutral when the convention is unrecognised, so a
production instance is obvious before you run anything — and a button for the
command palette. The empty state is a launcher grid for the main tools; opening
one takes over the whole sidebar until you close it.
Auto-detects the current table/record/script as context (shown as a "context
chip").

**Voice input** — click the microphone button to dictate instead of typing.
Uses the browser's built-in Web Speech API (no API key, no extra cost, audio
is not sent to the AI provider).

**Export** — the download button in the header saves the conversation as
markdown. Most panels can export their results too.

#### Slash commands

Deterministic, no AI tokens used:

| Command | What it does |
| --- | --- |
| `/lint` | Runs ~20 ServiceNow-specific static rules against the script on this form |
| `/formdiff` | Shows unsaved form changes vs. the saved record, with line-level diffs |
| `/deps <ScriptInclude>` | Builds the call graph (callers and callees) and renders it as Mermaid |
| `/verify` | Syntax + API catalog + lint + structure + field-name check of the script on this form |
| `/skills` | Which skill pack is active and the tools it uses |
| `/changes`, `/undo` | What the agent changed on this instance, and undo the last change |
| `/api [text]` | API explorer over the verified client and server catalog |
| `/testclient` | Client script test bench (simulated form) |
| `/chat <text>`, `/agent on\|off`, `/model` | Plain chat without tools; toggle agent mode; show the model and open settings |

AI-assisted:

| Command | What it does |
| --- | --- |
| `/review` | Runs the linter, then asks the model for what the linter cannot see: logic correctness, security, scale, maintainability |
| `/explain <text>` | Explains an error, log line, or field in plain English |
| `/generate <description>` | Generates a background script and loads it into the runner with dry run enabled |
| `/conflictcheck` | Deterministic checks (order collisions, duplicate triggers, ACL overlap, naming) plus an AI semantic pass |
| `/dedupe` | Pulls a CI batch from the CMDB and asks for likely duplicate groupings with evidence |
| `/logs [text]` | Pulls recent errors, groups them by root cause, and triages them alongside slow transactions |
| `/trace <stack trace>` | Resolves a stack trace to the failing script and shows the source around the reported line |
| `/atf` | Generates an ATF test outline for the current record, including steps and assertions |
| `/document` | Generates technical documentation for the current record |
| `/audit` | Runs the read-only security audit, then asks the model to prioritise the findings |

Panels: `/search`, `/updateset`, `/rest`, `/compare`, `/why` (`/access`), `/xray`,
`/impact`, `/health` (`/scan`), `/mywork` (`/me`), `/ship` (`/review-set`), `/push`. Plus
`/help` and `/clear`. Every panel is also in the command palette.

### Change impact (`/impact`)
Answers "what does changing this script affect?" before you edit it. Open a business
rule, Script Include, client script, UI action, script action, scheduled job, Scripted
REST resource, ACL, UI script or portal widget and run `/impact` (or `/impact
IncidentUtils` for a Script Include by name). The panel shows:
- **Who uses it**: every active script that calls the Script Include (GlideAjax callers
  marked), fires the script action's event, or loads the UI script or widget.
- **Runs alongside** (business rules): the other rules in the same phase on the table and
  its parents, in run order, with this one highlighted.
- **What it changes**: tables it reads, inserts, updates or deletes, the fields it sets,
  events it fires and `setWorkflow(false)`, with line numbers; unsaved form text is used
  when present. It follows the Script Include methods it calls one level deep.
- **What runs as a result**: business rules, notifications, flow triggers and script
  actions set off by those writes and events.
- **Who else is editing it**: other in-progress or completed update sets holding the
  record, plus version history, warnings and errors in the system log over the last 7
  days, and (business rules) how many records the table changed in the last day.

A risk summary on top ranks the signals (deletes, `current.update()` in a business rule,
another developer's update set, wide use). Export it as markdown or ask the AI what to
retest. It reads script text, so references built at run time are listed as not traced.

### Access debugger (`/why`, `/access`)
Answers "why can't this user see or edit this?" without impersonating anyone.
Pick a user (you by default), a table, a record, an optional field and an
operation. The trace shows the user's roles and how each was obtained (direct,
via a group, contained in another role), then the ACLs in ServiceNow's evaluation
order (table, parent tables, `*`; field ACLs from `table.field` to `*.*`) with an
exact role check per ACL, conditions in plain English, script excerpts, admin
overrides and Deny-Unless ACLs where the release has them. It also flags what can
still block access when ACLs pass: before-query business rules, domains, UI and
data policies. A verdict sits on top (Allowed, Denied, Depends on runtime).
"Check as me now" asks the platform directly with a read-only background script.
`/why abel.tuter write state` prefills and runs it.

### Page X-ray (`/xray`, `Alt+Shift+X`)
Shows what is on the page and what controls it. On forms, each field gets a chip
with its name, type and how much logic touches it; the panel lists the client
scripts, UI policies, data policies, business rules, ACLs and dictionary overrides
for a field and ranks the likely reasons it is read-only, mandatory or hidden right
now. Lists get column names and the query in plain English; catalog items map
`IO:` variables to names; Service Portal pages outline widgets with links to the
widget, instance and editor. Nothing is fetched until you turn it on, and
everything is removed when you turn it off.

### Health scan (`/health`, `/scan`)
A read-only, prioritised report on custom code and configuration: lint and API
findings, anti-patterns (GlideRecord or synchronous GlideAjax in client scripts,
DOM access, `current.update()` in business rules, hard-coded sys_ids and URLs,
unbounded and nested queries), configuration hygiene (unconditioned rules on large
tables, rules sharing an order, client-callable Script Includes without an ACL,
very frequent scheduled jobs, stale update sets), skipped upgrade records awaiting
review, and the security audit. Scope it to the whole instance (custom records
only by default), one application, one update set or the last N days. Each finding
links to the record and says why it matters and how to fix it. Export Markdown or
CSV, or ask the AI for a remediation plan.

### My work, ship check and push (`/mywork`, `/ship`, `/push`)
- **My work**: current update set and application with switchers (read back to
  confirm), your in-progress update sets, your recent changes grouped by set, and
  warnings for Default sets, scope mismatches and changes that were never captured.
- **Ship check**: a verdict (Ready, Warnings, Blockers) before you commit an update
  set: collisions with other sets, other scopes, deletes, risky types, lint and
  verify findings in the scripts inside the set, hard-coded sys_ids, and Script
  Includes or tables whose latest change sits in another open set. Generates
  release notes. Entries can be moved to another set (with confirmation and undo).
- **Push to instance**: copy one record to another instance with a field diff
  first. It matches by sys_id, then by name, re-checks the target before writing,
  never writes `sys_*` columns, refuses flows, dictionary, users and passwords, and
  needs the instance name typed for production. It writes into the target's current
  update set and skips your promotion process, so use update sets for real releases.

### Code Search
Searches every script-bearing configuration table (business rules, script
includes, client scripts, UI actions, UI policies, ACLs, script actions,
scheduled jobs, transform scripts, processors, scripted REST, portal widgets,
UI scripts, catalog client scripts) for a literal string. Filters are pushed to
the server so whole tables are never downloaded. Results show matching lines
with line numbers, link to the record, and can be exported or handed to the AI
for a usage analysis.

### Update Set Review
Two checks that catch the most common deployment failures:

- **Collisions** — artifacts present in more than one live update set, where
  whichever commits last silently wins.
- **Coverage** — configuration records changed in the last N days that have no
  `sys_update_xml` entry, meaning the change will never leave this instance.

Optionally hands both results to the model for a deployment risk assessment.

### Error Triage
Pulls recent `syslog` errors, collapses near-identical messages into groups
with occurrence counts (so the model sees 12 distinct issues, not 4,000 lines),
adds the slowest transactions in the same window, and asks for a root-cause
ranked triage. `/trace` resolves a stack trace back to the exact script and
line and shows the surrounding source.

### Safe background script runner
Every script is analysed for write operations before it can run, and the
findings are shown inline. **Dry run is on by default**: the script executes
with `GlideRecord` write methods intercepted, so it logs what it *would* have
changed instead of changing it. If the prototype cannot be intercepted in the
current scope, the wrapper refuses to run the script rather than silently
performing writes. Turning dry run off requires an explicit confirmation.

Dry run does **not** intercept direct SQL, outbound REST, `gs.setProperty`, or
side effects of events and flows that have already been triggered.

### Security audit
Read-only review of configuration the signed-in user can already read: ACLs
that grant access with no role/condition/script, public pages and widgets,
risky system property values, admin role sprawl, and scripted REST operations
with authentication or ACL enforcement disabled. No ACLs are bypassed and
nothing is exploited — it reports, then optionally asks the model to prioritise.

### REST Builder
Build and send requests against the current instance using your own session,
with presets, response timing, JSON formatting, and a generated server-side
`RESTMessageV2` snippet. Requests are restricted to the current instance origin
(absolute URLs, protocol-relative URLs and path traversal are rejected) so the
extension cannot be turned into a confused deputy.

### Instance Compare
Compares Business Rules, Script Includes, ACLs, Client Scripts, System
Properties, or Flows between two instances. Produces Added / Removed /
Modified lists with expandable line-level diffs, an optional AI summary that
highlights operational risk, and a markdown export suitable for a change
advisory board.

Records are matched across instances by `name` (not `sys_id`, which differs
per instance). Authentication uses your existing browser session for each
instance, falling back to per-instance credentials stored in the options page.

### Power-user tools
- **Theme**: match system, light or dark. Change it from the sun/moon/monitor button in the sidebar header, the palette (`Theme: ...`), or the Appearance section of the options page. It applies to the sidebar, palette, editor and options page.
- **Slash shortcuts in the palette**: type `/tn incident`, `/tnn`, `/sys <sys_id>`, `/props`, `/log`, `/code`, `/bg`, `/xml`, `/cs`, `/stats`, `/edit`, `/sync`. Type `/` to see the list.
- **Instance tag**: the browser tab title and favicon carry the environment (PROD, TEST, DEV) and a coloured bar sits at the top of the page. The palette lists your known instances to jump between them. Setting: `instanceTagEnabled`.
- **Field tools**: Alt+click a form field label to copy its name, Alt+Shift+click to copy its value.
- **Full-screen script editor** (`/edit` or `Alt+Shift+E`): autocomplete (`Ctrl+Space`, or automatically after `.` and inside strings) for `g_form`, `g_user`, `gs`, `current`/`previous`, inferred `GlideRecord` variables, dictionary fields with dot-walking, table names, Script Includes and their methods, system properties, roles and snippets; hover docs and parameter hints from the API catalog; live problems with wavy underlines, a Problems list, `F8` to jump and `Ctrl+.` quick fixes; `Alt+Up/Down` move line, `Shift+Alt+Up/Down` duplicate, `Ctrl+Shift+K` delete line, `Ctrl+G` go to line, regex find and replace, `Shift+Alt+F` re-indent; `F1` lists every shortcut. Also: syntax highlighting, line numbers, auto-indent, bracket and quote pairing, `Ctrl+/` comment, lint. `Ctrl+S` applies to the form field, `Ctrl+Enter` applies and closes, `Ctrl+Shift+S` (or Apply & save) applies and saves the record, with an extra confirmation on production. A syntax check runs before applying, and lint and syntax problems show as gutter markers while you type. Run and Dry run execute the script (or the selection) as a background script and show the output under the editor. Ask AI explains, fixes, tests or comments the script (or selection) in the chat sidebar, and Compare opens the other-instance comparison; `Alt+Shift+E` brings the editor back. `F12` or `Ctrl+click` jumps to a local function, Script Include or table. `Tab` after `gr`, `grget`, `gra`, `gdt`, `info`, `err`, `try`, `fn` or `ajax` expands a snippet. A chip shows the current update set (highlighted when it is Default). The palette lists the five latest records first when it opens.
- **Edit in VS Code** (`/sync`): pick a local folder and the open script is kept in sync with `<table>/<name>.<field>.js`. Saving in the editor updates the form field; edits on the form update the file. Chrome and Edge only (File System Access API). The folder is chosen each time and never remembered, and sync stops when you leave the record.

### Developer toolbox
Available from the command palette and the sidebar:
- **Prompt library and snippets** (250 built-in prompts, your own, optional sync).
- **List filter tools**: explain a query, generate GlideRecord code, count, export.
- **Live log**, **version diff**, **field inspector**, **ATF runner**, **scope export (ZIP)**.
- **Compare with another instance** for the open record.
- **Apply AI code** to the open form with a diff and undo.
- **Bookmarks, recent records, impersonation presets, open by name, go to definition.**
- **Safety guards** for Default update sets and saves on PROD.

### Options page
OpenAI API key entry + validation, sidebar/palette toggles, safety guards, library
sync, known instances, impersonation presets, and per-instance
credential management for Instance Compare.

## Known limitations
- **The agent has not been run against a real model, and most features have not been
  run against a real ServiceNow instance.** A first calibration on a personal developer
  instance confirmed the Table API tables and columns the older features use, the
  background script endpoint and the API catalog (several entries were fixed). The
  control-plane tools, script editor, access debugger, page X-ray, health scan and
  update set tools (October 2026) are unit tested (400+ tests) but their DOM selectors,
  endpoints and some columns are assumptions; each is listed in
  [docs/decisions.md](docs/decisions.md). Not yet: a live Anthropic/OpenAI call.
- The API catalog was written from general ServiceNow knowledge, not exported from
  an instance or the docs. Entries are conservative (`complete: false` almost
  everywhere, so an unlisted method is only a low-severity note, except a near-miss
  of a listed method, which is treated as a typo). Treat a wrong entry as a bug and
  fix it in `src/lib/apiCatalog/`.
- `save_artifact` checks column names against the live dictionary, but the field
  lists used to *read* artifacts (`ARTIFACTS` in `src/content/agentTools.js`) are
  unverified; unknown columns are ignored by the Table API rather than failing.
- The simulator does not run other scripts triggered by `setValue` (onChange
  cascades), UI policies, or real Script Includes; it reports that as a warning.
- Secret redaction is applied to every model request in one place (`sendChat` in
  `src/providers/index.js`), but it is pattern-based: a safety net, not a guarantee.
  Review `src/providers/redact.js` before trusting it with highly sensitive scripts.
  Screenshots taken for external agents are not redacted.
- The linter uses regex and brace-depth heuristics, not a JavaScript parser.
  Expect occasional false positives; read the flagged line before acting.
- Field lists per artifact type (`src/lib/artifacts.js`,
  `src/content/codeSearch.js`, `src/content/updateSets.js`) were chosen from
  general ServiceNow knowledge, not read from a live schema. Tables whose field
  names differ on your release will fail gracefully and be reported as skipped.
- `syslog.level` numeric mapping and the `sys_update_xml.name` = `<table>_<sys_id>`
  convention are assumptions that need confirming on your instance.
- Context detection selectors (`src/content/context.js`) are heuristic and
  target Next Experience UI. Classic UI's split `gsft_main` iframe is not yet
  supported (the content script currently only runs in the top-level frame).
- The background-script-runner and impersonate-user endpoints
  (`src/content/tableApi.js`) target the historically documented ServiceNow
  mechanisms (`sys.scripts.do`, `impersonate.do`) but have **not been verified
  against a live instance**.
- Dry run depends on `GlideRecord.prototype` being patchable in the execution
  scope. It fails closed (refuses to run) if it is not.
- Voice input relies on the browser's Web Speech API. In Chrome, audio is
  transcribed server-side by the browser vendor — do not dictate credentials or
  sensitive data. A page `Permissions-Policy` restricting microphone access can
  block it.
- Instance credentials are stored unencrypted in `chrome.storage.local`.
  Prefer being logged into both instances in the browser instead.
- Cross-instance session reuse depends on browser cookie/SameSite behavior and
  has **not been verified against two live instances** — the Basic Auth
  fallback exists precisely because this may not work everywhere.
- **Nothing has been tested against a real ServiceNow instance yet** — no live
  instance was available during development. This is the immediate next step.

## Roadmap
Phases 1–7 are implemented (see [PROGRESS.md](PROGRESS.md)). Next, in order:
run everything against a personal developer instance, validate the API catalog
against it, and use `npm run eval -- --live` to tune the skills. Remaining ideas:
Classic UI (`gsft_main`) support, knowledge article drafting from resolved
tickets, table schema browser, `sys_audit` history explanation, shared team
prompt/snippet library, and more AI providers (Gemini, Azure OpenAI) via the existing adapter interface.

## Team workflow
- GitHub repo, protected `main` (PR + 1 approval required), feature branches
  per roadmap item, squash merges
- Never commit API keys/secrets — they belong only in `chrome.storage.local`
  at runtime, never in source or test fixtures
