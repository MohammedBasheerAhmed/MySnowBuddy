# Self-check (`/doctor`, `/selfcheck`)

One click answers: **which NowBuddy tools will work on THIS instance, and why not for the ones that will not.**
NowBuddy has about 60 panels and tools. Most were built and checked against a fake instance, and ServiceNow releases
differ (tables and columns move, ACLs hide tables). When a tool shows nothing, the developer cannot tell "there is
nothing" from "NowBuddy cannot read it". The Self-check tells them, and its report is precise enough to send to the
NowBuddy developer as a bug report.

Read-only. It makes GET requests under the user's own session, two picker reads, and, only on an instance whose name
says dev, test or stage, one background script that only prints a marker (`SCRIPT_PROBE`). It never writes a record. It
keeps no record data: a table probe reads at most one row (never values, scripts, payloads or audit old/new values) and
only the column names that came back are used.

## Opening it

- Palette: "Self-check" (keywords: doctor, diagnose, not working, why does this tool show nothing).
- Chat or slash bar: `/doctor` or `/selfcheck`.
- It runs as soon as it opens (about 50 s on a PDI, with a progress bar; 126 read-only requests) and again with **Run again**.
- **Copy report** puts a Markdown report on the clipboard; **Download .md** saves it; "Report text" shows it in the panel
  when the browser blocks the clipboard.

## What it checks

Every check is independent, timed, and says in plain words what happened and, when it is not fine, what to do.

| Group | Check | What it looks at |
| --- | --- | --- |
| This page | NowBuddy on this page | extension version from the manifest, host |
| | Page layout | classic page, classic with the `gsft_main` frame, Next Experience shell with the classic frame in a shadow root (`findClassicFrame`), workspace, portal. A shell with no reachable frame is a warning: page tools need the classic form |
| | Page bridge | `callPage('getSessionInfo')` answers, and the page has a signed-in user (`g_user`) |
| | Session token | a token can be read (never shown) |
| | Your settings | an allow-list: sidebar, palette, tool surface, page tools, safety guards, instance tag, role tiers and developer roles, AI agent on/off, MCP bridge on/off. No keys, tokens, ports |
| You and the instance | Who you are | role count, role tier (`src/lib/roleTier.js`), admin, whether security_admin is elevated. The user name is not reported |
| | Impersonation | only one started from NowBuddy can be seen (`mysnowbuddy_impersonation_origin`); one started from the ServiceNow menu cannot |
| | Instance and environment | host, tag from Options > Instances or the host-name guess, "looks like production" |
| | ServiceNow release | family, patch and hotfix from `stats.do` (admin) or `sys_properties` (`glide.buildtag`); warns when it differs from the release NowBuddy was calibrated on (`CALIBRATED_ON` in `src/lib/doctor.js`) |
| API access | Table API (read) | one read of the signed-in user's own `sys_user` row; if only that table is refused, `sys_db_object` is tried |
| | Stats API (counts) | `/api/now/stats/sys_user?sysparm_count=true`, as `countRecords` does |
| | Stats API (group by) | the same with `sysparm_group_by`, as Break this list down and Hot spots use |
| | Dictionary | whether `sys_db_object` and `sys_dictionary` can be read (see below) |
| | Update set and scope pickers | `GET /api/now/ui/concoursepicker/updateset` and `/application` return a current value |
| | Background script endpoint | `sys.scripts.do` runs `gs.print('NOWBUDDY_SELFCHECK_OK');`. **Run on its own only on an instance positively identified as dev, test or stage** (`guarded === false`). Production, and a host the name guess cannot place (most production instances are plain `acme.service-now.com`), skip it: it adds a script-history entry. The row offers "Run it anyway", which asks first (`scriptProbeAsk`, red, the one line shown). The AI / MCP `run_selfcheck` tool always passes `scriptProbe: 'never'` (a unit test reads controlTools.js to keep it so) |
| Tools | one row per feature | OK / Gaps / Will not work / Not checked, the exact `table.column` list, "What it reads" (every table and column with its state), an Open button |

A failing session (401, a login page served as 200, a redirect to the login, `x-is-logged-in: false`) is reported as
such, nothing else is tried after it, and every tool is "Not checked" rather than "Will not work". A 403 is an ACL
refusal. A 400 "Invalid table" is a table that does not exist.

### The verdict

- **Red**: NowBuddy cannot work on this page at all (no page bridge, no session token, or the Table API cannot be read).
- **Amber**: everything is reachable but some tool will not work, has gaps, could not be fully checked, or a check
  needs a look (an unfamiliar release, no admin role for the script endpoint...).
- **Green**: every check passed and every tool has what it needs.

The word is always shown; colour only backs it up.

## How the tools are checked

Every feature lists what it reads in `src/lib/requirements/<name>.js` (`REQUIREMENTS = [{ feature, table, columns,
optional?, optionalColumns?, note?, panel? }]`; shape documented in `src/lib/requirements/index.js`). The Self-check reads
`ALL_REQUIREMENTS` and, with as few queries as it can:

1. reads `sys_db_object` for every listed table (chunks of 40, `nameIN...`), then for the parents it finds, level by level
   (usually 2 to 4 reads), so **inherited columns count** (a column on `task` is on `incident`);
2. reads `sys_dictionary` once per 25 tables and 100 column names (`nameIN...^elementIN...`) for every table in those chains;
3. reads **one row of each existing table** (5 at a time, `sysparm_limit=1`, only the light columns, never scripts,
   payloads, descriptions or values) to learn whether the user can read it (403 = refused) and which of the requested
   columns come back.

Per column: **ok**, **missing** (not in the dictionary), **hidden** (in the dictionary, but a sampled row did not return it:
a field ACL, usually) or **unverified**. When `sys_db_object` or `sys_dictionary` cannot be read, the sampled row decides
and the text says so; a table with no rows cannot be fully checked.

Per feature: **Will not work** (a required table is missing or refused, or a required column is missing), **Works with
gaps** (only optional pieces are missing, or a column is hidden), **Not fully checked** (a read did not answer: busy,
timeout, session ended, dictionary unreadable), **OK**.

The system columns (`sys_id`, `sys_created_on`, `sys_created_by`, `sys_updated_on`, `sys_updated_by`, `sys_mod_count`)
are assumed present. A dotted column (`update_set.name`) is checked on its first part only.

"What is behind it" folds the same problem seen by several tools into one cause ("`sys_security_acl` cannot be read:
affects 8 tools"), blocking causes first, with what to do about each. Each problem line under a tool starts with its
level in words (Needed / Optional / Not checked); the coloured bar only backs it up.

**Cost.** With the full list (32 features, 101 tables, 286 column names) a run makes about 120 to 130 requests: 5 API
checks, 3 to 4 hierarchy reads of `sys_db_object` (40 names each), about 15 `sys_dictionary` reads (25 tables x 100
names) and one `sysparm_limit=1` probe per existing table, 5 at a time, within a 120 s budget (12 s per request). The
per-table probe cannot be batched with the Table API: it is the only way to learn whether the user may read a table
(403) and which columns come back. ServiceNow's Batch API (`POST /api/now/v1/batch`) could fold them into a few
requests, but it is not verified on the PDI and needs its own role on some instances, so it is not used.

### `src/lib/requirements/existing.js`

Written on 2026-10-23 by reading each older tool's `queryTable` / `countRecords` / `queryInChunks` calls. Covered: What
went wrong?, Hot spots, What changed lately?, Release notes, Save trace, Why didn't my rule run?, Break this list down,
What points at this record?, Page X-ray, Access debugger, Health scan, Change impact, My work, Ship check, Where is this
field used?, History of a field, Test (Test kit and the ATF finder), Test data, Code search, Version history, Table
explorer, Triage errors, Live log, Update sets. Columns that PROGRESS.md "Live calibration" corrected are used in their
corrected form. `tests/doctor.test.js` keeps the lists that live in code (failures `SOURCES`, `traceSources`,
`SEARCHABLE_ARTIFACTS`, health scan `SCAN_TABLES`) and this file in step.

Review of 2026-10-23 (19 features checked against their code): required/optional now follows what each tool does when a
read fails. Made required: Access debugger `sys_security_acl_role` (the debugger stops without it), Where is this field
used? `sys_db_object` (the search starts with the table chain). Made optional: Where is this field used? `sys_dictionary`
(field picker only), Page X-ray `sys_db_object` (falls back to the table), My work `sys_user` (the page is asked first),
Change impact `sys_script` / `sys_script_include` and Hot spots `syslog_transaction` (each section loads on its own),
Table explorer's `sys_db_object` facts columns (the facts card may fail). Hot spots no longer lists the outbound log's
alternative column names (one was always missing, so the tool could never be OK). Dropped: Ship check `sys_scope` and
Break this list down `sys_choice` (not read). Added: the columns and optional tables the code reads but the list missed
(update payloads, `sys_update_version.payload/action`, `sys_update_xml.application`, Test targets `sys_script_fix` and
`sysauto_script`, Release notes' dependency reads, `sys_dictionary.read_only`/`max_length`). `tests/doctor.test.js` pins
the required/optional flags above. Code issues found on the way, NOT fixed here (other owners' files): Page X-ray reads
`sys_script_client.inherited` (probably `applies_extended` on the platform; the Self-check will report it missing), Hot
spots' outbound "Failed" count never reads `response_status` (about 65% sure that is the platform's column name).

Tools that read whatever table the user points them at (Compare with another record; the table choice in Break this list
down, Table explorer, Test data) have no fixed tables: they depend on the Table API, Stats API and Dictionary checks.

## The report

Markdown: verdict, run time and request count, extension version, instance and release, page layout, role tier and role
count, dictionary state, tool counts, a table of every check with its time, **Causes** (one line per problem with the
tools it touches), the tools that will not work with their `table.column` list, the tools with gaps, and a table of
every tool. It contains **no tokens, keys, user name or record values**.

## Files

- `src/lib/doctor.js` - pure logic: HTTP outcome classification, plain-words text, the check builders, requirement
  merging, inheritance-aware column resolution, tool evaluation, root causes, the verdict, the report.
- `src/content/doctor.js` - the instance half. `doctorRun(options)` returns the structured result (plain data, safe to
  `JSON.stringify`; an AI agent or the MCP bridge can call it later). `createDoctor(deps)` takes every dependency, which
  is how `tests/doctor.test.js` runs the whole thing against a fake instance. Options: `onProgress`, `scriptProbe`
  (`'auto'` | `'always'` | `'never'`), `requirements`.
- `src/sidebar/DoctorPanel.jsx`, `src/sidebar/doctor.css` - the panel (works at 380 px, light and dark).
- `src/lib/requirements/existing.js`, `index.js` - the requirement lists.
- `preview/fixtures/doctor.js` - fake answers for the preview harness. The dictionary is generated from the requirement
  lists, with on purpose: `sys_outbound_http_log`, `sys_hub_flow_run` and the `sys_atf_*` tables not installed,
  `sys_security_acl` refused (403), `task_sla` busy (503), `sys_update_version.sys_recorded_at` and
  `syslog_transaction.business_rule_time` missing, `sys_audit.reason` hidden. Open it with
  `preview.html?open=doctor`. It needs to come before the other fixtures in `preview/fixtures/index.js`, because some
  of them answer every `sys_db_object` query.

## Assumptions that need a live-instance check

- Every table and column in `existing.js` outside the ones PROGRESS.md lists as live-verified. The Self-check run on a
  real instance is how they get confirmed; each "is not a column" or "does not exist" it prints for a tool that worked
  before is a bug in the list, or a release difference worth a look.
- A 400 with "Invalid table ..." is what the Table API answers for a missing table (assumed; a plain 404 is reported as
  "not found", not as a missing table).
- A 403 on a table the user cannot read, as opposed to an empty result.
- The Table API returns every requested valid column as a key (empty when null) and omits one the user may not read.
  The "hidden" state depends on it. If a real instance shows many "defined, but not returned" columns for an ordinary
  user, this assumption is wrong and the state should be demoted to a note. The opposite failure is quieter: if the
  Table API returns a field-ACL-denied column with an EMPTY value instead of leaving it out, the Self-check calls the
  column ok while the tool shows it blank. Check both on the PDI as a non-admin user (a field ACL on, say,
  `sys_user.email`).
- A dot-walked column (`update_set.name`) is checked on its first part only; a reference that exists but whose target
  column is denied or renamed is not caught.
- `sysparm_suppress_pagination_header=true` and `sysparm_no_count=true` are accepted (an instance that ignores them only
  does a count it did not need).
- `/api/now/ui/concoursepicker/updateset` and `/application` answer a GET with `result.current` (as the update set
  switcher assumes).
- `stats.do` for the release (admin only), else `sys_properties` `glide.buildtag` / `glide.buildname`.

## Known limits

- Impersonation started from the ServiceNow menu is invisible.
- Writes cannot be checked without writing: Test data's create access, the production save guard, the update set
  switcher's PUT are not tested.
- It tests what the current user can read. Run it again as another user (impersonate) to see their view.
- A table with no rows cannot have its columns confirmed when the dictionary is unreadable.
- A tool whose requirements list is missing is not in the Tools list; the AI chat and agent are not covered.
