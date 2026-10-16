# Decisions

Terse log of implementation decisions and open follow-ups. Read this before
re-investigating something that's already been decided or flagged here.

## Confirmed / implemented
- **CSS isolation**: sidebar/toolbar CSS is loaded only inside a Shadow DOM
  root created by the content script (via a `<link>` to
  `chrome.runtime.getURL('content.css')`), not injected globally into the
  ServiceNow page. Required adding `content.css` to `web_accessible_resources`
  in `manifest.json` (the page's origin, not the extension, is what loads it).
- **CSRF token (`g_ck`) retrieval**: content scripts run in an isolated JS
  world and cannot read `window.g_ck` directly even though it's a real page
  global. Worked around by injecting a `<script>` tag (executes in the page's
  world), reading `window.g_ck` there, and bridging the value back via a
  `CustomEvent` dispatched on the shared `window`/DOM event system. See
  `src/content/context.js`.
- **Scope limited to top-level frame in v1**: `src/content/index.js` returns
  early if `window.top !== window`. This means Classic UI's split `gsft_main`
  iframe is NOT supported for context detection/toolbar in v1 — only
  Next Experience UI (no iframe) is supported. `all_frames: true` is still set
  in the manifest so this can be revisited without a manifest change later.
- **Chat calls always relayed through the background service worker**, never
  called directly from the content script — per the original spec, and also
  simplifies keeping the API key out of the page-accessible content script
  context as much as possible.
- **npm install SSL workaround**: this dev environment's network has a
  TLS-inspecting proxy causing `SELF_SIGNED_CERT_IN_CHAIN` errors from npm
  (confirmed: no proxy/cafile was configured in npm, so it's a
  network-level interception, not an npm config issue). Installed once with
  `npm install --strict-ssl=false` (scoped to that single command, not
  persisted to npm config). If this recurs on a new machine, prefer sourcing
  the corporate root CA and using `NODE_EXTRA_CA_CERTS`/`npm config set cafile`
  instead of disabling certificate verification.

- **Voice input via Web Speech API**, not an audio-upload transcription API.
  Rationale: no extra API key, no per-minute cost, no audio sent to the AI
  provider, and it's built into both Chrome and Edge. Trade-off: in Chrome,
  transcription happens server-side at the browser vendor, so users must not
  dictate secrets. A page-level `Permissions-Policy` on microphone can block
  it; the mic button hides itself if `SpeechRecognition` is unavailable.
- **Instance Compare matches records across instances by `name`, not `sys_id`.**
  The same logical artifact has different sys_ids on different instances, so
  sys_id matching would report everything as added+removed.
- **Diff engine is vendored** (`src/lib/diff.js`, LCS-based line diff) rather
  than adding a jsdiff dependency — keeps the dependency surface at
  react/react-dom/esbuild only.
- **Cross-instance auth is two-tier**: try the browser's existing session
  cookies (`credentials: 'include'`, permitted because the instance origin is
  in `host_permissions`), then fall back to per-instance Basic Auth
  credentials from the options page. A JSON-content-type/login-redirect check
  distinguishes "authenticated" from "bounced to login.do", because a login
  redirect still returns HTTP 200.
- **`cookies` permission removed from the manifest.** It was declared during
  Phase 1 scaffolding but never used (the compare client relies on
  `credentials: 'include'`, not the `chrome.cookies` API). Unused permissions
  are a store-review liability.
- **JSX text children do not process `\uXXXX` escapes.** Escape sequences
  written directly in JSX text render literally. Use real characters in JSX
  text, or wrap in an expression (`{'\u2014'}`). This was hit and fixed in
  `Options.jsx`. (esbuild re-encoding real non-ASCII characters as `\uXXXX`
  inside emitted *string literals* is correct and expected.)

### Phase 4
- **Page bridge is injected as a web-accessible file, not inline.** The Phase 1
  approach (a `<script>` tag with inline `textContent`) works for the one-shot
  `g_ck` read but is exactly what a strict `script-src` CSP blocks. The Phase 4
  bridge (`src/page/bridge.js` → `dist/pagebridge.js`) is injected as
  `<script src=chrome.runtime.getURL('pagebridge.js')>`, which is served from
  the extension origin and survives CSP. The old inline path in `context.js`
  was deliberately left in place as a fallback. `pagebridge.js` had to be added
  to `web_accessible_resources` for the page to be allowed to load it.
- **The page bridge is read-only by design.** Actions are a fixed allow-list
  (`getCsrfToken`, `getUserInfo`, `getFormMeta`, `getFormValues`). There is a
  comment in the file saying not to add an eval-style action: any page on the
  instance can dispatch `msb-page-request`, so an arbitrary-execution action
  would hand page JS an escalation path.
- **Deterministic-first prompt design.** Linting, conflict checks, update set
  analysis and the security audit all run locally, and their findings are
  embedded in the AI prompt with an explicit instruction not to simply repeat
  them. This cuts token spend, makes results reproducible, and keeps the model
  focused on judgement calls rather than pattern matching. `/lint`, `/formdiff`
  and `/deps` short-circuit before the AI entirely.
- **The linter masks strings and comments before matching.** `maskNonCode()`
  blanks out string literals and comments while preserving line numbers and
  offsets, so a rule like `no-eval` doesn't fire on the word "eval" inside a
  log message. Rules that legitimately need the original text (hardcoded
  sys_ids, instance URLs, credentials) opt in via `useRawLine: true`.
- **The linter is regex + brace-depth, not a parser.** Adding a real JS parser
  would mean a new dependency and a much larger bundle for a marginal accuracy
  gain on the rules we actually care about. Accepted trade-off: occasional
  false positives, documented in the README.
- **REST builder is same-origin only.** `validatePath()` rejects anything that
  isn't a root-relative path, rejects `//` protocol-relative URLs and `..`
  traversal, and re-checks `new URL(path, origin).origin` after resolution.
  Without this the extension would be a confused deputy: the panel sends
  requests with the user's live ServiceNow session, so an arbitrary URL would
  let it be pointed at any host with the user's cookies attached.
- **Dry run fails closed.** `wrapAsDryRun()` patches `GlideRecord.prototype`
  write methods to log instead of write. If `GlideRecord.prototype.update` is
  not a function (scope restrictions, a future release change), the wrapper
  calls `gs.error()` and does **not** execute the script. Silently running a
  write script that the user believed was a dry run is the worst outcome, so
  refusing to run is the correct failure mode. Non-GlideRecord write paths
  (GlideMultipleUpdate, direct SQL, outbound REST, `gs.setProperty`, already
  triggered events/flows) are not intercepted and this is stated in the UI.
- **Update set coverage relies on `sys_update_xml.name` = `<table>_<sys_id>`.**
  This convention lets us detect uncaptured changes without a join: build the
  expected name for each recently changed config record and check whether a
  matching update entry exists. Known caveat: scoped apps and
  source-control-managed apps legitimately have no update entries, so those
  appear as false positives.
- **Code search pushes `LIKE` filters to the server** and only filters `active`
  client-side. Downloading whole script tables to search locally would be slow
  and heavy on the instance. `Promise.allSettled` is used per table so a table
  that doesn't exist on a given release degrades to a reported error rather
  than failing the whole search.
- **Log grouping digests messages before counting.** sys_ids, timestamps and
  bare numbers are replaced with placeholders so 4,000 near-identical errors
  collapse into a handful of distinct groups with counts. Without this the
  model would spend its whole context window on repetition.
- **All new panels share one `.msb-panel__*` CSS system** rather than each
  panel shipping its own styles, to keep the bundle and the visual language
  consistent as the panel count grows.

### Phase 5 (UX)
- **The command palette is the primary surface, not the toolbar menu.** The
  nested menu did not scale past ~15 actions and cost two clicks per action.
  Everything is now a searchable command; the rail keeps only a launcher, an
  environment badge and four pinned actions.
- **One registry, two surfaces.** `src/content/commands.js` is the only place
  an action is defined. Commands are data (`url` or `run`), which is what makes
  "open in a new tab" work uniformly and keeps the palette free of special
  cases.
- **The palette is rebuilt on every open**, not cached, because record- and
  table-scoped commands depend on the page the user is currently looking at.
- **Keyboard shortcuts are registered twice**: an in-page capture-phase
  listener (fast, works without the service worker waking) and a
  `chrome.commands` entry (works when the in-page listener is bypassed, e.g.
  focus inside an editor that swallows keys). Both dispatch to the same
  toggle.
- **Sub-frames forward hotkeys instead of mounting UI.** Mounting the rail in
  `gsft_main` would double it up in Classic UI. Instead the sub-frame instance
  installs only a keydown listener and relays to the top frame via
  `postMessage`, with an `event.origin === window.location.origin` check on
  receipt so an embedded third-party frame cannot drive the palette.
- **No `innerHTML` for anything that could carry instance data.** The palette
  and toasts build DOM node by node; `innerHTML` is used only for the
  build-time constant SVG icon paths. ServiceNow pages may carry a Trusted
  Types policy, and this also removes a whole class of injection bug given the
  palette renders record names and user names.
- **Navigation is origin-locked.** `safePath()` in `quickActions.js` mirrors
  the REST builder's rule: root-relative only, no protocol-relative URLs, no
  traversal, and the resolved origin is re-checked. The palette navigates the
  user's authenticated session, so an off-origin target would be a phishing
  primitive.
- **Environment badge is guessed, and says so.** Hostname patterns
  (`prod`/`prd`/`live`, `uat`/`stage`, `test`/`qa`, `dev`/`sandbox`) map to a
  colour; anything unrecognised renders neutral with the instance name rather
  than guessing. Labelling a production instance "DEV" is worse than labelling
  it nothing.
- **Toasts replaced `sidebarApi.notify` for action feedback.** The sidebar may
  be disabled or closed, in which case the old notify call was a silent no-op.
- **Design tokens live on `:host`** in `theme.css` with a
  `prefers-color-scheme: dark` override. The build concatenates
  `theme.css` + `toolbar.css` + `sidebar.css` into `dist/content.css`, so the
  rail, palette, toasts, sidebar and feature panels all share one visual
  language and adapt to the user's theme without reading the instance's.
  The options page cannot reuse that file (its tokens are scoped to the shadow
  host), so `options.css` redeclares the same tokens on `:root` — the two must
  be kept in sync by hand.
- **Icons are one shared set, declared twice by necessity.**
  `src/content/icons.js` builds SVG nodes for the vanilla-DOM content UI;
  `src/sidebar/Icon.jsx` declares the same shapes as JSX for the React
  surfaces. The React version avoids `dangerouslySetInnerHTML` entirely, and
  the DOM version only ever assigns build-time constant markup.
- **Assistant output is rendered as text, never HTML.** `MessageBody.jsx`
  splits on ``` fences and emits `<span>`/`<pre>` text nodes, so a model that
  returns markup cannot inject anything into the sidebar.

### Phase 7 (agent, skills, verification)
- **The agent loop runs in the content script; the model call runs in the service worker.** The loop needs
  the page, the Table API session and the approval UI; the API key must stay in the worker. One `AGENT_STEP`
  message = one model turn. Chat history stores the final text plus a trimmed run (no payloads).
- **One tool contract, three consumers.** `src/lib/agent/toolSchemas.js` feeds the in-extension agent, the
  MCP bridge (registered at connect, plus a build-time snapshot) and the docs. A tool absent from it is
  unknown, and an unclassified tool name is treated as the most dangerous tier (`toolTier` defaults to write).
- **Approval tiers, not a yes/no.** observe and draft run freely; run (dry run) asks unless "Auto dry runs";
  write always asks and on PROD needs the instance name typed. Read-only autonomy denies run and write.
  External MCP calls go through the same policy (`agentBridge.js`), shown in an in-page dialog.
- **Verify-gated writes.** `save_artifact` refuses a script with high-severity findings and any column not in
  the live dictionary, writes only six configuration tables, creates inactive by default, and records the
  previous values for undo. `query_table` blocks credential-like tables and `javascript:`/`gs.` in queries
  (an encoded query can execute server-side script).
- **Tool results are data.** Redacted per value before JSON serialisation (escaped quotes defeat regex
  redaction of scripts), key-name based redaction, size capped, and the system prompt tells the model not to
  follow instructions found in them.
- **Simulation runs in a sandbox page, not in the content script.** MV3 forbids eval in extension contexts and
  the ServiceNow CSP would block a page-world approach. A manifest `sandbox` page may eval; an offscreen
  document (`IFRAME_SCRIPTING`) hosts it so the page CSP is irrelevant. A runaway script is stopped by
  closing the offscreen document after 6 s. The simulator is pure and takes the evaluator as a parameter,
  which is how it is unit-tested in Node.
- **A near-miss of a listed method is an error; an unlisted method is a note.** The catalog is deliberately
  conservative. Edit distance <= 2 from a real method is almost certainly a typo and would throw; anything
  further is reported low-severity. Wrong-side detection ignores generic names (`response`, `event`,
  `request`, `JSON`, ...) that are ordinary locals or builtins on the other side.
- **Anthropic specifics.** No temperature/top_p (rejected on current models), no forced tool choice, effort
  via `output_config`, `anthropic-dangerous-direct-browser-access` header for browser contexts, assistant
  blocks (including thinking) replayed verbatim within a tool loop. Default model Opus 5.5; Sonnet 5.5 and
  Haiku 5.5 selectable. Non-streaming with max_tokens 16000 (a request stays well under the 5 minute worker
  limit).
- **MCP over loopback long-poll instead of native messaging or a WebSocket.** No dependencies, works from an
  MV3 service worker (kept alive by an alarm), token-paired, Host/Origin checked. The MCP server is a separate
  process the MCP client launches, so the extension connects out to it.
- **Offline evals double as the verifier's regression suite.** Reference solutions must verify with no
  warnings; each known-bad script must trigger a named rule.

### Phase 8 (October 2026: control plane and analysis panels)
- **Plugin points instead of editing Sidebar.jsx.** `src/sidebar/panelRegistry.js` (one entry gives a panel,
  slash commands, a palette command and a /help line), `src/content/featureServices.js` (content services merged
  into every panel's `services`), and build.js concatenates every `src/sidebar/*.css`. Build and test temp
  folders are per process (`.build-tmp-PID`, `.test-dist-PID`) so parallel runs do not collide.
- **Control plane.** `read_page`, `navigate`, `get_instance_info` are observe tier. `navigate` changes no data, so
  it runs without approval, but it only opens real tables (checked against the instance), `/now/` routes and portal
  pages, never processors or URLs with action parameters, and never leaves a dirty form. MCP clients still see it as
  not read-only. Write tools: `click_ui_action` (exact match, pinned to the record shown on the card),
  `create/update/delete_record` (dictionary-checked, diff on the card, undo; delete undo re-inserts with the same
  sys_id but not journals/attachments/cascaded deletes), `run_background_script` (risk analysis + "was dry-run"),
  `switch_update_set` / `switch_application_scope` (read back; undo switches back), `impersonate_user` /
  `end_impersonation`; `run_atf` is run tier and is never auto-run.
- **Sensitive-table policy** (`assessWrite` in policy.js): credential tables and password fields are refused before
  any card is shown; deleting users/tables/columns is refused; role/ACL/property/code changes carry a warning;
  script fields of BRs, client scripts, Script Includes and UI policies must go through `save_artifact`.
- **External-agent ceiling** (Options: read only / read and draft / up to dry runs and tests / everything with
  approval) is enforced in the service worker and again in the page. Default keeps the earlier behaviour. MCP-only
  tools (`screenshot`, `list_tabs`) are in `MCP_ONLY_TOOLS`; the sidebar agent never sees them.
- **Screenshots use the `activeTab` grant** (click the toolbar icon or Alt+Shift+C on that tab once) rather than
  the all-sites permission. Screenshots are not redacted.
- **Page reloads during an MCP call**: the page reports `AGENT_TOOL_STARTED` once an approved call starts, so the
  bridge can say "it ran, here is the new page" versus "nothing ran".
- **Page bridge**: request ids are random and a request accepts only its first reply; replies remain data to
  validate, never authority. New read-only actions `getFormStatus` and `getSessionInfo`.
- **Redaction boundary**: every model request goes through `redactMessages()` inside `sendChat`
  (src/providers/index.js); only text is redacted, tool-call ids/arguments and thinking blocks pass unchanged. The MCP
  path uses `redactDeep`, which also hides values of rows whose `name` is secret-named. Writes refuse values that
  contain the `[REDACTED]` placeholder; verify raises `redacted-secret` when a script would save it.
- **Per-function variable typing** (`src/lib/scopes.js`) for apiCheck, verify and lint's unbounded-query rule.
- **tableApi.js**: an expired session (401, login redirect, login page served as 200, `X-Is-Logged-In: false`)
  throws one message with `err.code = 'SESSION_EXPIRED'`; ServiceNow's error.message/detail is included in other
  errors; GETs retry 429/503 twice (400 ms, 1200 ms or Retry-After capped at 5 s); writes never retry.
- **Code search** filters `active=true` on the server (was client-side, so inactive matches used up the row limit).
- **renderTemplate(template, values, { kind: 'snippets' })** escapes each value for its context (string literal,
  comment, code); prompts are unchanged.
- **Access debugger evaluation order**: table, parents, `*`; field: table.field, parent.field, *.field, table.*,
  parent.*, *.*. The most specific matching name decides and one passing ACL there is enough; table and field must
  both pass. Deny-Unless: every matching Deny-Unless ACL at that level must pass (assumption). Admin inherits every
  role except elevated ones and `maint`. No table ACL match: `glide.sm.default_mode` decides; no field ACL match: the
  field follows the record. Simple conditions are checked by querying `sys_id=X^condition` as the logged-in user;
  `javascript:`, dynamic values, `^NQ` or unknown columns are "runtime". The runtime check script is test-enforced
  read-only and refuses any user but the logged-in one.
- **Health scan custom-vs-baseline**: a record is custom if `sys_update_xml` has `<table>_<sys_id>` for it or it is
  in an `x_<glide.appcreator.company.code>_*` scope; customised baseline records count as custom; other vendors'
  store apps count as baseline. `sys_metadata.sys_customer_update` is not used. Score = high x10, medium x3, low x1,
  per category rated by its worst severity. Caps: 2,000 records per table, 10,000 update rows per table, scripts
  over 150k characters skipped (noted). Rules dropped for precision: ES6 checks, unverified-method notes, ACL "no
  answer", `setWorkflow(false)`.
- **Ship check**: any check that hit a cap or failed downgrades the verdict, so a partial check never says Ready.
- **Moving update set entries**: one at a time, re-read after each, stop at the first failure; blocked across scopes,
  into Default sets and into sets that are not in progress; audited with undo.
- **Push to instance**: never writes `sys_*` columns except `sys_id` on create (keeps later update sets aligned);
  refuses flows/workflows, `sys_db_object`/`sys_dictionary`, apps, users, non-config tables, password properties and
  creating records in a scoped app; typed-name gate uses `isGuardedEnv` plus any known-instance label containing
  prod/production, enforced in UI and service worker; the target is re-read before writing. Cross-instance writes try
  the browser session first and fall back to Basic Auth only on a 401 or a login page. `fetchRecords` now sends
  `sysparm_exclude_reference_link=true` (references used to compare as "[object Object]").
- **Page X-ray**: nothing is fetched until X-ray or its panel is opened; every condition column is checked against
  `sys_dictionary` before use; queries capped (200 client scripts, 200 business rules, ...) and the cap is shown;
  per-table cache 5 minutes, about 15 tables; MutationObserver throttled to 600 ms and ignores X-ray's own nodes;
  chips are out of the tab order (the panel is the keyboard path); wildcard `*.field` ACLs are left to the access
  debugger.
- **Script editor**: `src/lib/completion.js` is pure and reports what data it is missing; the editor fetches it on
  demand (capped, cached per page) so typing never waits on the network. Only visible lines are redrawn. Scripts
  over 40K characters (or whose full check took over 350 ms) get syntax and API checks while typing plus a "Run the
  full check" button. `g_form.getFieldNames` was removed from the catalog (does not exist on current releases).
- **Change impact** (`/impact`, 2026-10-16): static analysis of script text in `src/lib/impact.js` (comments
  stripped, GlideRecord variables tracked by position so reassignment maps to the right table, GlideQuery chains,
  `current` only traced with the subject's own table); Script Include methods it calls are followed one level deep
  (method body only, at most 10 Script Includes). Every instance query in `src/content/impact.js` is filtered again
  on its condition columns in the browser, because ServiceNow drops unknown conditions and returns every row. Each
  section fails on its own into a "Not checked" note. Caps: 60 callers per table, 6 written tables, 300 business
  rules, 25 log rows.
- **Analysis panels as tools**: `explain_access`, `explain_field`, `check_update_set`, `scan_instance_health` are
  observe tier and return compact results (names and ids, never script bodies or the full finding list); the health
  scan stops after 2 minutes and returns a partial report (the MCP call limit is 3 minutes).

## Unconfirmed — needs verification against a real ServiceNow instance

### Phase 8 assumptions (none of these has run on a live instance yet)
- **Control plane**: the "Me" dynamic filter `DYNAMIC90d1921e5f510100a9ad2572f2b477fe`; user preferences
  `sys_update_set` and `apps.current_app` as the read-back; concoursepicker GET shapes and the update set PUT body;
  `/impersonate.do` and `/logout_impersonate.do` driven by fetch; CI/CD `links.results.id` and suite result fields;
  `sys_atf_test_result.parent`; `g_form.modified` / `modifiedFields` / `getGlideUIElement`; the classic DOM selectors
  listed at the top of `src/content/controlPage.js`; workspace `now-button` clicks; navigating the classic frame
  inside the Next Experience shell; that the Table API keeps a given sys_id on insert.
- **Access debugger**: `sys_user_has_role` columns `inherited`, `granted_by`, `included_in_role`, `state`;
  `sys_group_has_role.inherits`; `sys_user_role_contains` (role/contains); `sys_user_role.elevated_privilege`;
  `glide.sm.default_mode`; `sys_script.action_query`; Deny-Unless columns (`decision_type`, `applies_to`,
  `security_attribute`, `advanced`, checked at runtime); `sys_db_object` scope-access columns; the Access Analyzer
  module title; `sys_id=javascript:gs.getUserID()` for the logged-in user; the runtime script's `can*()` output.
- **Health scan**: `sys_upgrade_history_log` disposition/resolution_status and the "Skipped"/"Not Reviewed" labels;
  `sys_security_acl.type` value `client_callable_script_include`; `sysauto_script.run_type='periodically'` and the
  `run_period` format; `sys_update_set.is_default`/`application`; `sys_upgrade_history.to_version`; the company-code
  property; `nameNOT LIKE`, `gs.daysAgoStart`, `sysparm_no_count` (every column is checked against sys_dictionary
  at run time, values are not).
- **Update sets and push**: Aggregate API group-by response shape; update names `<table>_<sys_id>` and
  `sys_dictionary_<table>_<element>`; `sys_update_xml.application`; `javascript:gs.getUserID()` inside Table API
  queries; moving entries by PATCHing `sys_update_xml.update_set`; whether a POST keeps the given `sys_id`; which
  update set a REST write on the target lands in. A cross-instance write with only the session cookie most likely
  gets a 401 (no target `g_ck`), so writes probably need Basic credentials in Options.
- **Page X-ray**: form ids `label.<table>.<field>` / `element.<table>.<field>`, `status.*[mandatory]`,
  `sys_readonly.*`, `sys_target`; list `th[name][glide_type]`, `tr[sys_id]` / `row_<table>_<id>`; catalog `IO:`,
  `label_IO:`, `sp_formfield_IO:`; portal widget class `v<sys_id>` and instance id `x<sys_id>`; workspace URLs
  `/now/<app>/record/<table>/<id>`; editor links `/sp_config?id=widget_editor&sys_id=` and `id=page_edit&p=`; columns
  read back but not validated: `sys_ui_policy_action.disabled`, `sys_data_policy2.enforce_ui`,
  `sys_data_policy_rule.disabled`, `sys_script_client.inherited`/`ui_type`, `sys_dictionary_override.<x>_override`,
  `catalog_ui_policy.catalog_conditions`, `catalog_ui_policy_action.catalog_variable`, `sp_portal.url_suffix`.
- **Change impact**: `sys_flow_record_trigger` with a `table` column (a missing table becomes a note); flow triggers
  on parent tables firing for child records (not listed); `sysevent_email_action.generation_type` values `engine` /
  `event` / `triggered`; `sp_instance.sp_column.sp_row.sp_container.sp_page` dot-walk; `syslog.message` containing
  `<table>.<sys_id>` for script errors; `gs.daysAgoStart` / `gs.hoursAgoStart` in Table and Aggregate API queries;
  `sys_script_client.field_name`; `sys_update_version.sys_recorded_at`.
- **Script editor**: `sys_script_include.client_callable`, `item_option_new.cat_item` / `variable_set` (a wrong
  column returns unfiltered rows capped at 300); character-width measurement, popup placement, underline alignment
  and undo inside the shadow root in a real browser.
- **Background script execution endpoint** (`src/content/tableApi.js`,
  `runBackgroundScript`): implemented against the historically documented
  `/sys.scripts.do` processor (requires security_admin/admin role). NOT yet
  tested against a live instance. Confirm the current release still uses this
  endpoint/payload shape before relying on it.
- **Impersonation endpoint** (`src/content/tableApi.js`, `impersonateUser`):
  implemented against `/impersonate.do?sysparm_start_impersonating=<sys_id>`
  (requires impersonate_user role). NOT yet tested against a live instance.
- **Context detection selectors** (`src/content/context.js`,
  `findScriptField`): heuristic (`textarea` name/id hints, or first large
  textarea as fallback). Validate against real Business Rule / Script Include
  / Client Script / ACL forms and refine selectors as needed.
- **Field lists per artifact type** (`src/lib/artifacts.js`,
  `src/content/conflictCheck.js`): field names were chosen from general
  ServiceNow knowledge, not read off a live schema. In particular the
  `sys_hub_flow` (Flows) field set is a best guess. If a Table API query
  returns empty or errors, check the field list first.
- **CMDB dedupe default query** (`src/content/cmdb.js`): uses
  `install_status!=7` (exclude retired) against `cmdb_ci`. Confirm this
  matches your instance's conventions.

### Phase 7 assumptions
- **API catalog contents** (all of `src/lib/apiCatalog/*.js`): written from memory. Highest-risk: methods marked
  `globalOnly`/`scopedOnly`, client `unsupportedIn` lists, GlideQuery, FlowAPI, and any method an author
  flagged as "moderately sure" (see the file notes).
- **Artifact column names** in `ARTIFACTS` (`agentTools.js`) and the `save_artifact` examples (`sys_script_client.field`,
  `ui_type`, `sys_script.collection/when`): unverified; `save_artifact` validates against `sys_dictionary`
  at runtime, so a wrong guess becomes an error with a suggestion rather than a bad write.
- **`getFormModel` in the page bridge** uses `g_form.isVisible/isReadOnly/getDisplayBox` guarded by existence checks.
- **`/api/now/table` POST/PATCH/DELETE** with the session token for configuration tables, and that a created
  record lands in the current update set.
- **`chrome.offscreen`** on Edge (expected, Chromium 109+); `chrome.runtime.getContexts` used to detect an existing document.

### Phase 4 assumptions
- **`syslog.level` numeric mapping** (`src/content/logs.js`): assumed
  `error=2`, `warn=1`, `info=0`. Verify; if wrong, error triage silently pulls
  the wrong severity rather than failing.
- **`sys_update_xml.name` convention** (`<table>_<sys_id>`): the whole
  uncaptured-changes check depends on this. Verify before trusting a "clean"
  result.
- **Whether `GlideRecord.prototype` is patchable** inside a background script's
  execution scope. If not, dry run refuses to run (safe) but the feature is
  useless — needs a real test.
- **Whether the page bridge loads under ServiceNow's CSP.** If
  `chrome.runtime.getURL('pagebridge.js')` is still blocked, `/formdiff` and
  the CSRF read will time out after 2.5s. Check the console for a CSP
  violation on the extension origin.
- **Field/table assumptions in the new modules**, none read from a live schema:
  - `sys_ui_policy.script_true` / `script_false` (code search)
  - `sys_ws_operation.operation_script`, `requires_authentication`,
    `requires_acl_authorization` (code search, security audit)
  - `sys_transform_script.sys_transform_map` as the display field
  - `sp_widget.script` / `client_script` / `public`
  - `sys_public` shape (security audit)
  - `sys_security_acl_role` as the M2M table used to find role-less ACLs
  - `sys_dictionary.element` as the name field (update set coverage)
- **`gs.daysAgoStart()` / `gs.minutesAgoStart()` inside encoded queries**
  (`javascript:` prefix) — used by update set coverage and log fetching.
  Widely used, but unverified here.
- **Stack trace formats** (`src/content/logs.js`, `parseStackTrace`): four
  shapes are handled based on general knowledge of ServiceNow trace output.
  Collect real traces from an instance and extend the patterns.

### Phase 5 assumptions
- **Update set switching** (`quickActions.setCurrentUpdateSet`): `PUT
  /api/now/ui/concoursepicker/updateset` with `{ sysparm_sys_id }`. This is the
  only write the quick-action layer performs. Confirm the payload shape and
  that the response is applied to the session before trusting it; the UI tells
  the user to reload rather than assuming the page picked it up.
- **`/logout_impersonate.do`** for ending impersonation, and `/threads.do`,
  `/xmlstats.do`, `/$restapi.do`, `/$flow-designer.do`, `/$scriptDebugger.do`
  for navigation. `/cache.do` and `/stats.do` are long-standing; the rest need
  a click-through per release.
- **`/stats.do` scraping** (`getNodeInfo`): the labels ("Instance name",
  "Build name", "Build date", "Build tag") are parsed out of the HTML with
  regexes. Cosmetic only — a miss shows "unknown" rather than failing.
- **Polaris classic-target URL shape**
  (`/now/nav/ui/classic/params/target/<encoded>`, `shellUrl()`). If it is
  wrong, navigation from a Next Experience page lands on a 404 instead of
  opening inside the shell.
- **Form label selectors** for the technical-field-name toggle:
  `label[id^="label."]` and `label[for="<table>.<field>"]`. Classic UI is the
  target; the Next Experience component tree may not expose either.
- **sys_id resolution probes** (`findRecordBySysId`) assume `sys_metadata`
  carries `sys_class_name` for configuration records. Non-metadata, non-task,
  non-user, non-CI records will not resolve.

## Deferred / accepted for now

### Phase 6 decisions and assumptions
- **`setFieldValue` is a page-bridge write.** It exists only so "Apply" can put
  AI-generated code into a script field. It never saves the form, only runs
  after the user confirms a diff, and returns the previous value for undo. It
  is the single write the bridge allows.
- **Safety guards are best-effort.** Default update set detection and the
  classic save-button ids (`sysverb_update/insert/delete*`) are unverified, and
  the update set lookup is cached for 20 s. Disable with the Options toggle.
- **Library sync uses `chrome.storage.sync`** (about 80 KB total, 8 KB per
  item). Large libraries are chunked; when over quota, sync fails and the
  local copy stays authoritative.
- **Remote record fetch** (`FETCH_REMOTE_RECORD`) runs in the service worker,
  is limited to `*.service-now.com`, and only accepts messages from a
  ServiceNow tab. It looks the record up by name, because sys_ids differ per
  instance.
- **Script history stores scripts locally in plaintext** (`chrome.storage.local`).
  Do not keep secrets in background scripts.
- **Unverified endpoints:** `/api/sn_cicd/testsuite/run`,
  `/api/sn_cicd/progress/<id>`, ATF result field names, `g_list.getQuery`,
  `sys_update_version` fields, `gs.secondsAgoStart`, `sys_scope.scope`
  dot-walks.
- **Open-by-name** queries six artifact tables with `nameLIKE` (3 rows each)
  on every keystroke past three characters; a table the user cannot read is
  skipped.

## Deferred / accepted for now
- **Instance credentials are stored unencrypted** in `chrome.storage.local`.
  Extension storage is not a secure secret store. Documented as a limitation
  in the README and options page; the preferred path is being logged into both
  instances so the session-cookie tier is used instead. Revisit before any
  public release.
- **Phase 3 cross-origin session cookie behavior is still unverified** against
  two live instances (this was the spike flagged in the original build prompt).
  The Basic Auth fallback was implemented precisely so the feature degrades
  gracefully if SameSite policy blocks the cookie path — but which tier
  actually works in practice is still unknown. Record the finding here after
  testing.
