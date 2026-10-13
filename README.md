# MySnowBuddy

AI-assisted developer toolkit for ServiceNow: a command palette, a context-aware
chat sidebar, and a set of deterministic analysis tools for
code quality, deployment safety, and instance comparison. Manifest V3 browser
extension (Chrome + Edge).

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
- OpenAI (`gpt-5-mini`) as the v1 AI provider, via a provider-adapter module
  (`src/providers/`) so other providers can be added later without touching
  calling code
- Chat history and the API key are stored only in `chrome.storage.local`
  (never `.sync`, never sent anywhere except directly to OpenAI)

## Project structure
```
manifest.json          Manifest V3 config (copied as-is into dist/)
build.js                esbuild build script
src/
  background/           Service worker, cross-instance client, compare engine
  providers/             AI provider adapter(s) + secret redaction helper
  page/                   Page-world bridge (reads g_form / g_ck)
  content/                Content script: command palette, context detection, and all
                           instance-facing features (search, update sets, logs,
                           form diff, dependencies, audit, REST)
  sidebar/                React chat sidebar + feature panels + speech input
  options/                React options/settings page
  lib/                     Shared: line-diff engine, linter, script safety,
                           artifact definitions, report/export helpers
dist/                   Build output - load THIS folder as an unpacked extension
```

## Setup
```
npm install
npm run build      # one-off build
npm run watch       # rebuild on file changes (re-run `npm run build` after
                     # editing manifest.json/options.html/css, since those are
                     # only copied once at watch startup)
```

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
| nothing | Recent commands first, then everything grouped |

`Enter` runs, `Shift`/`Ctrl+Enter` opens navigations in a new tab, `↑`/`↓` or
`Ctrl+N`/`Ctrl+P` move, `Esc` closes. Commands are context-aware: when a record
is open, "This record" and "This table" groups appear.

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

Panels: `/search`, `/updateset`, `/rest`, `/compare`. Plus `/help` and `/clear`.

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
- **Full-screen script editor** (`/edit` or `Alt+Shift+E`): syntax highlighting, line numbers, find and replace, auto-indent, bracket and quote pairing, `Ctrl+/` comment, lint. `Ctrl+S` applies to the form field, `Ctrl+Enter` applies and closes, `Ctrl+Shift+S` (or Apply & save) applies and saves the record, with an extra confirmation on production. A syntax check runs before applying, and lint and syntax problems show as gutter markers while you type. Run and Dry run execute the script (or the selection) as a background script and show the output under the editor. Ask AI explains, fixes, tests or comments the script (or selection) in the chat sidebar, and Compare opens the other-instance comparison; `Alt+Shift+E` brings the editor back. `F12` or `Ctrl+click` jumps to a local function, Script Include or table. `Tab` after `gr`, `grget`, `gra`, `gdt`, `info`, `err`, `try`, `fn` or `ajax` expands a snippet. A chip shows the current update set (highlighted when it is Default). The palette lists the five latest records first when it opens.
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
- Secret redaction before sending script content to OpenAI is regex-based — a
  safety net, not a guarantee. Review `src/providers/redact.js` before trusting
  it with highly sensitive scripts.
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
Phases 1–4 are implemented (see [PROGRESS.md](PROGRESS.md)). Remaining ideas:
Classic UI (`gsft_main`) support, knowledge article drafting from resolved
tickets, table schema browser, `sys_audit` history explanation, shared team
prompt/snippet library, and additional AI providers (Gemini, Anthropic,
DeepSeek, Azure OpenAI) via the existing adapter interface.

## Team workflow
- GitHub repo, protected `main` (PR + 1 approval required), feature branches
  per roadmap item, squash merges
- Never commit API keys/secrets — they belong only in `chrome.storage.local`
  at runtime, never in source or test fixtures
