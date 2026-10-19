# Progress

Read this file first at the start of any new session, before re-exploring the
codebase or re-reading the full build spec.

## RESUME HERE (Phase 8 built 2026-10-16; next step is live verification on the PDI)
State: 503 tests pass, `npm run build` clean, `node preview/smoke.js` 9/9. Git: origin is
github.com/MohammedBasheerAhmed/MySnowBuddy, branch main (see memory github-repo-push). The extension is
loaded unpacked from D:\MySnowBuddy\dist in the user's Chrome; the user's PDI is https://dev364920.service-now.com
(Australia p7). At the end of the 2026-10-16 session the PDI session was logged out and the loaded extension was the OLD
build. Pre-Phase-8 source snapshot: scratchpad baseline-20261016-1206/mysnowbuddy.tar (see memory multi-agent-push-oct16).

**First thing to do next session**
1. Ask the user to reload the extension (chrome://extensions → MySnowBuddy → reload), log in to the PDI, refresh the tab.
2. Live-verify Phase 8, read-only first (never write to the PDI without asking): every assumption listed under
   "Phase 8 assumptions" in docs/decisions.md. Order: (a) columns/tables via sys_dictionary (cheap, one script);
   (b) open each panel (/why, /xray, /health, /mywork, /ship, /push preview only) on real records; (c) the editor
   autocomplete/hover/underline alignment in a real browser; (d) control-plane reads (read_page on a classic form, a list,
   the Next Experience shell, a workspace, a portal); (e) only with the user's OK: a write round trip on a throwaway record
   (create_record → update_record → undo → delete) and an update set switch + read-back.
3. Still from Phase 7: confirm the "script" chip shows the field on a Client Script / Business Rule.

**Added 2026-10-16 after Phase 8:** Change impact panel (`/impact`): src/lib/impact.js (pure), src/content/impact.js,
src/sidebar/ImpactPanel.jsx + impact.css, registered in panelRegistry/featureServices; tests/impact.test.js (17 tests,
503 total). Checked in the preview harness (light and dark) only. Its live assumptions are under "Change impact" in
docs/decisions.md. REST builder presets were expanded (Import Set, CMDB, Attachment, Service Catalog, Batch, discovery).
Next step for impact: the save-time breaking-change check for Script Includes (warn when a removed or renamed method
is still called), then "find all references" in the editor.

**Added 2026-10-18 (UI pass, not yet committed):** (1) Palette and sidebar restyled (aurora tokens in theme.css). (2) Palette: frecency
ranking (src/lib/paletteRank.js, ui state commandStats), match highlighting, Alt+1..9 quick run, Alt+Enter copy link, and
Ask AI / API catalog / code search fallbacks on every query. (3) SNUtils-style "show it on the page": tools open in
floating windows by default (src/sidebar/ToolWindow.jsx, windows.css, src/lib/toolWindow.js; setting toolSurface =
window|sidebar, palette commands "Tools: ..."; sidebar API openForTool); on-page tools (src/content/inline.js,
popover.js, src/lib/inline.js; setting inlineEnabled, palette "Toggle on-page tools"): bottom toolbar, field label
menus, script-field strip, list column menus, sys_id peek. All checked in the preview harness (?inline=1) in light and
dark with headless Chrome, 519 tests pass.
**Live-verified on the PDI 2026-10-18** (Australia patch 7): toolbar, Explain/Count popovers, floating windows, field menus,
script strip + Lint, sys_id peek, column menus, classic list inside the /now/nav/ui/classic shell. Live run found and fixed
three bugs the preview could not show: (a) labels carry no `label.<table>.<field>` id on this release, only
`for="<table>.<field>"` (also `ni.`/`sys_display.`/`sys_readonly.` prefixes), so annotation now goes through
`classicFormLabels()` in xray.js (+ `parseLabelFor` in lib/xray.js), shared by X-ray and the inline tools; (b) list column
buttons were appended after `.list_header_cell_container` and sat under the next column's resize handle, they now go
after `a.column_head`; (c) checkboxes have two labels per field, one empty, so labels are de-duplicated per field (live-checked:
one button per field on sys_script); (d) our `all:initial` buttons/chips reset inherited `visibility`, so a field hidden by a UI
policy (visibility:hidden) still showed a stray button: `visibility:inherit!important` added to inline and X-ray styles.
Second live pass (same day) found and fixed: (e) a bare `for=` is not a field: related-list row checkboxes use
`for="check_<table>.<...>.<sys_id>"`, got stray buttons and outvoted the form's table, so labels now resolve through their
wrapping `element.<table>.<field>` container (legacy `label.` ids still work); (f) the context's script field falls back to the
longest text field, so the toolbar offered Edit/Lint on an incident: `isScriptLabel()` (lib/inline.js) now gates the toolbar and
the palette's "Edit script in full-screen editor" / VS Code commands, which also now need a record (they showed on lists);
(g) API explorer search ignored `current.setValue` / `gr.addQuery`: `searchApis`/`lookupApi` resolve receiver aliases
(current, previous, gr, ga); (h) palette: name matches that start with the query now outrank mid-word ones, and code-like
input (`looksLikeCode`) puts the free API / code lookups before "Ask AI". Checked clean live: idle DOM stability (0 mutations
in 6 s), label click still focuses the field, button click does not, Versions/Info/Field ACLs/column menus, palette open +
fallbacks + Alt+N, window drag/dock/pop-out/close, Toggle on-page tools off (0 injected nodes) and on, console errors.
**Usability pass (same day, built and preview-verified, not yet live-checked):** the palette now understands problems, not
just tool names. `src/lib/paletteIntents.js` maps command ids to plain phrases ("who changed this", "why can't a user see
it", "where is this script include used") and matches multi-word queries by words in any order (`wordsScore`; two or more
words no longer fall into the loose character match). `src/lib/paletteContext.js` picks a page kind (script / record /
list / update set / other) and the palette opens with "Suggested for this script|record|list|update set" after Pinned and
Recent. Alt+P pins or unpins the highlighted action (ui state `pinnedCommands`, max 8, shown first, "pinned" badge while
searching). A first-run card (`src/content/welcome.js`, key `mysnowbuddy_welcomed`) says the four things worth knowing;
"Quick tour" in the palette shows it again. The palette placeholder and empty state teach describing a problem. Palette
footer wraps cleanly. Tests: tests/palette.test.js checks that every intent and suggestion id exists in commands.js /
the panel registry, so the index cannot drift. Preview: `?palette=open[&scriptform=1|&page=list]`, `?welcome=1`.
**Live-verified usability pass (PDI):** welcome card, Suggested/Pinned groups, Alt+P, problem phrases, `/tn`, GlideRecord
popover, AI button with no key (clear "Missing API key" message + banner), full-screen editor (read-only label is accurate:
`g_form.isReadOnly` is true for protected OOTB records), Access debugger end to end (about 20 s for a 126-role admin),
classic form inside the /now/nav shell (fields live in shadow roots). Found and fixed on the PDI: suggestions sat below the
fold under Recent (order is now Pinned, Suggested, Recent, Recent records; the page you are on is not a "recent record");
23 commands had no hint line; loose letter matching ran over the long intent text so an exact name like `GlideAggregate`
matched unrelated commands (loose match is title-only now); a resting mouse pointer stole the highlight when the list
redrew (hover now needs real movement; preview check fails without the fix); "Run /tn x -> AI chat" row on navigation
shortcuts removed; toasts overlapped the page toolbar (stack lifted above it); Access debugger shows elapsed seconds.
Verified live after the reload: exact-name search has no noise, a parked pointer no longer changes what Enter runs, the toast
sits above the toolbar, `/tn` has no AI row, the update-set page kind suggests Ship check / Update set review / Push, and
the welcome card does not return once dismissed (storage persists).
**API catalog checked against the live instance** (client classes from `window`, server classes with a `typeof` probe through
read-only POST /sys.scripts.do): Verify flagged `ga.setWantSessionMessages()` as unknown although the browser's GlideAjax has
it. Added GlideAjax (setWantSessionMessages, setErrorCallback, setScope, preventLoadingIcon, preventCancelNotification,
disableRunInBatch), GlideRecord (addInactiveQuery, addFunction, getBooleanAttribute, getEscapedDisplayValue, getLocation,
getRelatedLists, getRelatedTables, insertWithReferences, isEncodedQueryValid, setUseEngines) and gs (beginningOfTomorrow,
endOfTomorrow, endOfLastYear, yesterday, lastWeek, dateDiff, calDateDiff, flushMessages, getErrorMessages, getInfoMessages,
logError, logWarning, getImpersonatingUserName/DisplayName). `g_user` was marked `complete: true` but the live object has
getUserID, getPreference, setPreference and more, so it is `complete: false` now (a missing name is a note, not "does not
exist"). The earlier note that gs.urlEncode/urlDecode/base64Encode/base64Decode are missing from the global scope was
re-confirmed. Left out on purpose: live functions whose meaning could not be stated reliably (GlideRecord.find,
setQueryReferences, gs.addMessage, getDisplayValueFor, getEscapedProperty, isScopedApp, workflowFlush). Not yet probed: the
other server classes (GlideDateTime, GlideAggregate, GlideElement, GlideQuery) and g_form's long internal list.
Also fixed: windows hid a panel's Back button (My work) and left a nested Close button (Ship check).
Verified live after the next reload: window header fix (Ship check: no stray ×; My work keeps its Refresh), Access debugger
elapsed timer ("... 11s. A user with many roles can take 20 seconds."), /verify no longer flags GlideAjax
setWantSessionMessages, dark theme on the real page (restored to "match system" afterwards), no console errors.
Found live and fixed (needs one more reload to confirm): My work showed "Scope: Unknown". This release's application picker
returns `current` as a plain id string plus a `list` of {sysId, name, scopeName}; `parsePickerCurrent` only accepted an
object, and a user who never switched scope has no `apps.current_app` preference. The parser now resolves id + list, and
no preference means Global (default) instead of Unknown (a real read failure still shows Unknown).
Native Next Experience *workspace* forms get only the toolbar.

**Open work, in priority order**
- Live verification above (Phase 8, `/impact` and the ~35 older endpoints: concoursepicker, /api/sn_cicd, /impersonate.do,
  /logout_impersonate.do, cache.do, threads.do, xmlstats.do, stats API).
- Agent flow end to end needs an Anthropic API key (user has none yet).
- Known gaps from Phase 8 reports: after a top-level page reload the sidebar agent loses its run (the MCP bridge recovers);
  catalog variables don't get the live "why"; related-list headers aren't annotated by X-ray; domain hierarchy walking in the
  access debugger; view-specific UI policies are ranked, not fully evaluated; ship check doesn't cover update-set preview
  problems or ATF coverage; push session-only writes need the target's g_ck (Basic credentials in Options work); moves are
  capped at 25 entries; the preview harness has no agentUndo service (/undo does not work there); scripts > 40K chars get
  only syntax + API checks while typing in the editor.
- Idea backlog: find references / call graph, per-instance AI memory, token/cost meter, getReference callback typing and
  choice values in completion, full check off the main thread, agent tools for ship check moves and push (write tier).

**Tooling:** preview/driver.js (calibration driver), preview/fakeInstance.js (fake Table API for the preview harness, if the
visual QA run added it), puppeteer-core (installed with --no-save; re-run `npm i --no-save puppeteer-core` if missing).
Heredocs mangle backslashes in JS: patch with the Edit tool or a node script written with the Write tool. Build and test
temp dirs are per process, so parallel agents can build/test at once.

## Phase 8 (2026-10-16): control plane + analysis panels, built by seven parallel agents, then reviewed
Plugin points first: src/sidebar/panelRegistry.js (panel + slash + palette + /help), src/content/featureServices.js,
build.js auto-includes src/sidebar/*.css. Then, in parallel:
- **Control plane** (src/lib/agent/control.js, src/content/controlPage.js, controlSession.js, controlTools.js): read_page,
  navigate, get_instance_info, click_ui_action, create/update/delete_record with undo, run_background_script,
  switch_update_set, switch_application_scope, impersonate_user, end_impersonation, run_atf; MCP-only screenshot (Allow
  click per shot) and list_tabs; tab_id on every MCP tool; external-agent permission ceiling in Options; page-reload
  recovery for MCP calls.
- **Script editor** (src/lib/completion.js, editorText.js, editorDiagnostics.js, src/content/editorData.js, rewritten
  scriptEditor.js): autocomplete, hover docs, signature help, live problems + quick fixes, editing commands, go to
  definition, F1 shortcut list.
- **Access debugger** /why /access (src/lib/accessTrace.js, src/content/accessDebugger.js, AccessDebuggerPanel.jsx).
- **Health scan** /health /scan (src/lib/healthScan.js, src/content/healthScan.js, HealthScanPanel.jsx).
- **My work, ship check, moves, push** /mywork /ship /push (src/lib/updateSetReview.js, pushArtifact.js,
  src/content/myWork.js, src/background/push.js, MyWorkPanel.jsx, ShipCheck.jsx, MoveEntries.jsx, PushArtifact.jsx).
- **Page X-ray** /xray Alt+Shift+X (src/lib/xray.js, src/content/xray.js, XrayPanel.jsx).
- **Hardening**: central redaction in sendChat, src/lib/scopes.js per-function typing, lint/verify fixes, renderTemplate
  escaping, tableApi session-expiry + retry, bug-hunt fixes; lint/verify made ~linear (30 s → 0.12 s on a 750-variable
  script, identical findings on 1,248 result sets).
- **Analysis panels as agent/MCP tools** (lead): explain_access, explain_field, check_update_set, scan_instance_health.
- **Reviews**: a safety review (18 findings: approval cards could hide code, auto dry runs could be escaped, page scripts
  could operate the extension UI, delete via parent table, query injection in explain_access, MCP timeout semantics,
  screenshot redaction, undo checks, navigate URL variants, PROD label gate, redaction gaps, sender checks, push re-checks)
  and a correctness review (23 findings: ACL operation is a reference, health "Nothing found" on failure, catalog/dictionary
  update names, ship check Ready with unchecked scripts, collision scope, X-ray null state/views/NOT LIKE, report_on, ...).
  All 41 were fixed with regression tests. UI isolation: closed shadow root (src/content/uiRoot.js), hotkeys relayed via
  the service worker (src/lib/hotkeyRelay.js), isTrusted guard on every write/approve handler (src/sidebar/trusted.js),
  per-frame sender checks in the service worker (src/lib/senderCheck.js).
Nothing in Phase 8 has run on a live instance yet; every assumption is listed in docs/decisions.md.

## Status: Phases 1–7 (older notes below; Phase 7 was partly calibrated on the PDI, see Live calibration)

### Full-repo bug hunt (after Phase 7) — fixed, 170 tests pass
Four read-only reviews (background/agent, content scripts, libs/sandbox, React UI); findings verified in code before fixing.
Fixed: auto dry-run now asks when a script has side effects a dry run cannot suppress (REST/SOAP, events, setProperty,
GlideMultipleUpdate, SQL); leading `javascript:` blocked in search_code/read_artifact/read_logs/stack-trace queries
(src/lib/queryGuard.js); write guard fails safe for unrecognised instance names (policy.js isGuardedEnv) and the classifier
knows acmeprod / dev12345; undo payloads never clipped; undo of a created record (DELETE 204) no longer throws; field undo
bound to its record; save_artifact creates inactive by default, verifies script_true/script_false and shows every field on
the approval card; page watcher reports the first page; conflict check reads up to 2000 rows; editor types over closing
quotes; chat history per instance; Options no longer overwrites newer settings; REST panel Enter double-send; IME Enter;
sidebar reads fresh page context; verify (current.variables, GlideAggregate COUNT, credential names); conditionsOnly keeps ^^;
simulator no longer hangs on self-rescheduling callbacks; sandbox reply survives non-cloneable results.
**Still open (not fixed):** redaction only at some call sites; re-injection after extension reload now replaces an orphaned page root (untested in a real tab);
variable-name reuse across functions in verify/apiCheck; lint table lists miss
ui_action/acl/scripted_rest kinds; lint loop detection misses Allman-style/forEach; renderTemplate does not escape values in
snippets; security audit / update-set collision truncation (need a live instance to confirm).

### Simulator fidelity pass — done, 174 tests + smoke pass
mockForm.js: GlideAjax responseText is the XML string and getAnswer() follows getXMLWait(); client GlideRecord honours
operators, restarts on a second query(), exposes columns as properties, has get/setLimit/orderBy/getRowCount/addEncodedQuery
(plain conditions only, rest flagged) and flags writes; setTimeout/setInterval run in virtual time; g_modal callbacks fire;
onCellEdit warns if callback() is never called; unknown fields are not created when the scenario lists its fields.
Unverified against a real form: g_user.roles shape (string here), getXMLWait return value.

### Safety follow-ups — done, 179 tests + smoke pass
MCP cancel path: bridge tells the extension (poll response `cancel`) when a call times out or the client sends
notifications/cancelled; the extension dismisses the approval card and refuses to execute it (mcpBridge.js cancelCall,
agentBridge.js AGENT_TOOL_CANCEL, approvalDialog.cancel). Approve is locked until the sidebar preview settles, and a failed
preview is shown instead of swallowed. Step-limit wrap-up keeps tool definitions in the request. save_form confirms by
comparing sys_mod_count / sys_updated_on and says so when nothing changed.

### Live calibration against a PDI (Australia patch 7, dev364920) — done, 181 tests pass
Method: Claude-in-Chrome connector on the user's logged-in tab (Table API with the page's g_ck, sys.scripts.do for
read-only introspection). Confirmed: sys.scripts.do endpoint + output extraction work as coded; all 80 tables the code uses
exist. Found and fixed: g_form.getFieldNames() does NOT exist on this release (bridge now falls back to g_form.elements) so
"No script was found" appeared on every record; 7 wrong columns (sys_metadata.name -> sys_name, sys_public.description,
sys_script_client.field_name -> field, sys_transform_script.sys_transform_map -> map, sys_ui_policy.name, syslog_transaction
.user_name -> sys_created_by, task.name); API catalog corrections (removed SOAPMessageV2.setHttpMethod,
GlideDateTime.hasTime, AbstractAjaxProcessor.isPublic, GlideStringUtil.dotToUnderscore, GlideSession.getUrlOnStack,
client GlideRecord.addEncodedQuery; renamed getRoot->getRootElement, unescapeHTML->unEscapeHTML; marked scopedOnly the
methods absent from global scope: gs.base64Encode/Decode/urlEncode/urlDecode, GlideSysAttachment.getContent/
getContentBase64/writeBase64, RESTMessageV2.setRequestorContext). **ServiceNow silently ignores a condition or ORDERBY on a
column that does not exist** (name=x on a table with no name returns every row), so the agent's query_table/count_records now
reject unknown columns. New: Table explorer (sidebar/FieldInspectorPanel.jsx, content/fieldInspector.js): table facts,
columns with dictionary badges, per-column details + choices + overrides, list layouts.
Not verified: scoped-only API availability (needs a custom scope; platform scopes return "not authorized" from sys.scripts.do,
which the extension should surface instead of "(no output)"); agent approval flow with the model (no API key yet).

### Phase 7 — AI agent, skills, verification, simulator, MCP (done; verified as far as listed below)
Goal: make the tool great for ServiceNow developers and let an AI act on ServiceNow
safely, using client-script and server-script skills.

- **Providers** (`src/providers/`): neutral message format (`messages.js`), Anthropic adapter with
  tool use (`anthropic.js`: no sampling params, adaptive thinking, thinking blocks replayed unchanged
  in tool loops, refusals surfaced), OpenAI adapter with function calling, `index.js` dispatch,
  `config.js` providers/models/storage keys. Service worker: `CHAT_COMPLETION`, `AGENT_STEP`,
  `GET_PROVIDER_INFO`, `VALIDATE_API_KEY`, `SANDBOX_RUN`, `OPEN_OPTIONS`.
- **API catalog** (`src/lib/apiCatalog/`): 64 entries / 670 methods (client 14, server 50), schema in
  `SCHEMA.md`, lookup/search/fuzzy match in `index.js`. Written from general knowledge; not validated
  against an instance. `apiCheck.js` flags unknown methods (typo-near = error), wrong-side APIs,
  deprecated/scope/UI limits.
- **Verifier** (`src/lib/verify.js`): syntax, lint, catalog, client structure (handler present, onChange
  guard, onCellEdit callback, GlideAjax sysparm_name/callback), server structure (BR timing, GlideRecord
  ordering, ES5, browser globals, ACL answer, Script Include AJAX), field names against the dictionary.
- **Skills** (`src/lib/skills/`): Client Script and Server Script packs (guide, digest, tools), selected by page.
- **Simulator** (`src/lib/mockForm.js`, `src/sandbox/`, `src/offscreen/`): mock g_form/g_user/GlideAjax/
  g_modal/client GlideRecord, run in a manifest sandbox page hosted by an offscreen document.
- **Agent** (`src/lib/agent/`): 20 tools in `toolSchemas.js` (single source of truth, tiers), loop with
  approval gates (`agentLoop.js`), policy (`policy.js`), system prompt, audit + undo (`audit.js`), run
  state for the UI (`runState.js`). Page-side tools in `src/content/agentTools.js`.
- **UI**: agent timeline with inline approval cards and diffs (`AgentRun.jsx`), new hero/empty state,
  API explorer (`ApiExplorerPanel.jsx`), test bench (`TestBenchPanel.jsx`), autonomy selector, model chip,
  key banner, approval dialog for external agents, redesigned Options (provider/key/model, agent, MCP).
  Styles in `src/sidebar/agent.css`.
- **MCP bridge** (`mcp/snowbuddy-mcp.js`, `src/background/mcpBridge.js`): stdio MCP server + loopback HTTP
  long-poll to the extension; `tools/list` and skill resources from `mcp/generated/` (written by the build).
- **Evals** (`tests/evals/`): 13 cases; offline in `npm test`, live via `npm run eval -- --live`.
- **Dev harness** (`preview/`): the real sidebar with a scripted model and canned instance data.

**Verified in this phase:** 160 unit/eval tests pass; `npm run build` clean; real sidebar flow (reads ->
verify fail -> fix -> simulate -> approval card -> save, light/dark/PROD) screenshotted in headless Chrome
with no console errors; built extension loaded in Chrome: service worker starts, offscreen+sandbox
round trip (syntax check, client run, DOM blocked), non-ServiceNow senders rejected, Options page renders;
MCP chain (pairing, register, tools/list_changed, tool routing, wrong token 401, Host/Origin 403).
**Not verified:** any live model call; any ServiceNow endpoint; the content script / page bridge
`getFormModel` on a real form; Edge.

### Phase 1 — done (code complete)
- Scaffolding: `manifest.json`, `package.json`, `build.js` (esbuild, JSX-only, no TS), `.gitignore`
- Provider adapter: `src/providers/config.js` (model constant), `openai.js`, `redact.js`
- Service worker `src/background/service-worker.js` — message-handler map
  (`CHAT_COMPLETION`, `VALIDATE_API_KEY`, `COMPARE_INSTANCES`, `SUMMARIZE_DIFF`)
- Content script: `index.js` (Shadow DOM mount, service registration),
  `toolbar.js`/`toolbar.css`, `context.js` (CSRF bridge + heuristic detection),
  `tableApi.js`, `storage.js`
- Chat sidebar `src/sidebar/Sidebar.jsx` + `mount.js` + `sidebar.css`
- Options page `src/options/Options.jsx` + html/css

### Voice input — done
- `src/sidebar/useSpeechInput.js` — Web Speech API hook (no API key, no cost,
  audio not routed through the AI provider)
- Mic button in the sidebar input row with listening state + error surfacing

### Phase 2 — done (code complete)
- `/conflictcheck` — `src/content/conflictCheck.js` (deterministic: naming
  collisions, execution-order collisions, duplicate trigger conditions,
  overlapping ACLs) + AI semantic pass built in `Sidebar.jsx`
- `/generate` — prompt + code-block extraction, auto-loads result into the
  background script runner panel for review before execution
- `/dedupe` — `src/content/cmdb.js` fetches + trims a CI batch, model returns
  duplicate groupings with evidence
- Also added `/help` and `/clear`

### Phase 3 — done (code complete)
- `src/lib/diff.js` — vendored LCS line diff + context-collapsed summary (no deps)
- `src/lib/artifacts.js` — comparable artifact definitions (BRs, Script
  Includes, ACLs, Client Scripts, System Properties, Flows), matched across
  instances by `name`
- `src/background/instanceClient.js` — cross-instance Table API client;
  tries existing browser session first, falls back to stored Basic Auth creds
- `src/background/compare.js` — compare orchestration + redacted AI summary prompt
- `src/sidebar/ComparePanel.jsx` — source/target/artifact/query form,
  Added/Removed/Modified sections, expandable per-field diffs, AI summary button
- Options page: per-instance credential add/remove UI

### Phase 5 — UX overhaul (done, code complete)
Driven by the feedback that the UI was well behind SN Utils. The nested
toolbar menu was the bottleneck: every action cost two clicks and the action
list did not scale.

- **Command palette** — `src/content/commandPalette.js`. `Ctrl+Shift+Space`
  (also registered as a browser-level `chrome.commands` shortcut so it works
  when focus is inside a ServiceNow field or iframe). Fuzzy scoring with
  substring/word-boundary bonuses, grouped when idle, score-sorted when
  searching, recent commands persisted and floated to the top.
- **Single command registry** — `src/content/commands.js`. The palette and the
  toolbar both render from it, so an action is defined once. Commands with a
  `url` are navigations (Shift/Ctrl+Enter opens in a new tab); commands with a
  `run` execute in place.
- **Omnibox providers** — table lookup (curated list + live `sys_db_object`
  search), pasted sys_id resolution across `sys_metadata`/`task`/`sys_user`/
  `cmdb_ci`, `@user` impersonation typeahead, and `/slash` passthrough to the
  chat sidebar.
- **SN Utils-style actions** — `src/content/quickActions.js`: copy sys_id/URL/
  markdown link, record XML, audit history, versions, the capturing update set
  entry, record info, cache flush, node stats/build, XML stats, threads,
  technical field names on the form, update set switching, end impersonation,
  and 15 pre-filtered "configuration for this table" lists.
- **Toolbar rail** — `src/content/toolbar.js` rewritten. Draggable (position
  persisted), environment badge (PROD/TEST/DEV guessed from the instance name,
  neutral when unrecognised), palette launcher plus four pinned actions.
- **Toasts** — `src/content/toast.js`. Feedback no longer depends on the chat
  sidebar being mounted and open.
- **Design system** — `src/content/toolbar.css` rewritten around CSS custom
  properties on `:host` with a dark-mode block, covering the rail, palette and
  toasts.
- **Sub-frame hotkey forwarding** — the content script still mounts UI only in
  the top frame, but sub-frames now install a keydown listener that relays the
  shortcuts to the top frame via `postMessage` (origin-checked), so the palette
  opens from inside Classic UI's `gsft_main`.
- Manifest bumped to 0.5.0 with a `commands` block; options page gained
  palette/badge toggles and a keyboard shortcut reference.

### Phase 5b — visual overhaul (done, code complete)
Follow-up to the feedback that the UI still looked cheap next to SN Utils.
Every surface now renders from one token set instead of ad-hoc hex values.

- **`src/content/theme.css`** — the single source of design tokens (type scale,
  surfaces, ink, brand gradient, status triads, radii, shadows, focus ring,
  z-index) plus shared primitives (`.msb-btn`, `.msb-chip`, `.msb-kbd`,
  `.msb-spinner`) and a full dark-mode override. The build concatenates it
  ahead of `toolbar.css` and `sidebar.css` into `dist/content.css`.
- **`src/content/icons.js`** — one 21-icon SVG set shared by the rail and the
  palette, replacing the duplicated icon constants. `src/sidebar/Icon.jsx` is
  the React equivalent (JSX paths, never `dangerouslySetInnerHTML`).
- **Palette** — blurred overlay, spring entrance, per-row group icon, styled
  footer keys, and an empty state that teaches the omnibox syntax.
- **Sidebar** — floating rounded card with a branded header, chip-style context
  row (sys_id copies on click), role-labelled messages with fenced code blocks
  and copy buttons, an empty state with suggested commands, an auto-growing
  composer (Enter sends, Shift+Enter newlines) with icon send/mic buttons, and
  a drag handle that persists the sidebar width.
- **Feature panels** — Compare, Search, Update Set and REST now share sticky
  card headers, token-based inputs with focus rings, and consistent
  error/warning/finding treatments.
- **Options page** — mirrors the tokens in `:root` (it is a normal page, not
  the shadow host), card-per-section layout, light and dark.

### Prompt library — done (code complete, untested in browser)
- `src/lib/promptLibrary.js` — 250 built-in prompts across 15 categories (12 core
  here, the rest in `src/lib/builtinPrompts.js`), `{{variable}}` templating,
  storage (`mysnowbuddy_prompt_library`), validation, JSON import/export.
  `{{table}}`, `{{sys_id}}`, `{{script}}` (redacted), `{{field}}`, `{{instance}}`
  fill from the page; any other name becomes an input the user fills in.
- `src/sidebar/PromptLibraryPanel.jsx` — search, category filter, favourites,
  use (fill + preview, Send to AI / Insert in chat), create/edit/delete,
  Customize (copy a built-in), import/export.
- Entry points: `/prompts`, the book button in the composer, and the
  "Prompt library" palette command.
- Imports always get fresh ids so they cannot overwrite existing prompts or
  masquerade as built-ins.

### Phase 6 — developer quality-of-life (done, code complete, untested in browser)
Build and unit tests pass (36); none of the UI below has run on a live instance.
- **Prompt library** now has kinds (prompts and code snippets, with built-in
  snippets), usage tracking, a `{{selection}}` variable (text selected on the
  page) and optional sync across browsers (`chrome.storage.sync`, ~80 KB).
- **List filter tools** (`QueryPanel`): explain an encoded query, generate
  GlideRecord code, count, preview, CSV/JSON export, copy sys_ids.
- **Live log** (`LogTailPanel`, `logTail.js`): polls `syslog` with level and
  text filters.
- **Version diff** (`VersionPanel`, `versions.js`): field-level diff between
  `sys_update_version` entries.
- **Compare with another instance** (`RemoteRecordPanel`, `remoteRecord.js`,
  `FETCH_REMOTE_RECORD` in the service worker): same record, other environment.
- **Field inspector** (`FieldInspectorPanel`): dictionary view plus live value
  and state of fields on the open form.
- **ATF** (`AtfPanel`, `atf.js`): list suites, run one, poll progress, recent
  results.
- **Scope export** (`ScopeExportPanel`, `scopeExport.js`, `lib/zip.js`): one
  file per script, downloaded as a ZIP.
- **Apply AI code to the form** (`ApplyPanel`): shows a diff, writes via the
  page bridge `setFieldValue` (the only bridge write), with undo.
- **Script history and output** in the background script panel.
- **Safety guards** (`guards.js`): warn when the current update set is a
  Default one, confirm saves/deletes of configuration on PROD. Toggle in Options.
- **Palette**: bookmarks, recent records, impersonation presets, favourite
  prompts/snippets, open-by-name (type 3+ characters of a script name), go to
  definition for selected text, and commands for each panel above.
- **Options**: guards toggle, library sync toggle, known instances, presets.

### Phase 6 — unverified against a live instance
CI/CD ATF endpoints (`/api/sn_cicd/testsuite/run`, `/api/sn_cicd/progress/<id>`)
and ATF result field names; `g_list.getQuery/getTableName`; `sys_update_version`
fields (`name=<table>_<sys_id>`, `payload`); update set picker endpoint; classic
save-button ids (`sysverb_*`); Default update set detection;
`gs.secondsAgoStart` in the log tail; `sys_scope.scope` dot-walks in scope
export; name-based remote record lookup.

### Phase 4 — done (code complete)
Twelve developer-productivity features. Design principle: run deterministic
checks locally first, then feed those findings to the model so it spends its
attention on semantics rather than re-deriving known anti-patterns. `/lint`,
`/formdiff` and `/deps` consume no AI tokens at all.

- **Page-world bridge** — `src/page/bridge.js` (built to `dist/pagebridge.js`)
  + `src/content/pageBridge.js`. Content scripts run in an isolated world and
  cannot see `window.g_form` / `g_ck`, so the bridge is injected as an
  extension-hosted `<script src>` (inline injection is blocked by ServiceNow's
  CSP) and talks over a `CustomEvent` RPC with request IDs and a timeout.
  Read-only by design; it also resolves `gsft_main` for Classic UI forms.
- **ServiceNow linter** — `src/lib/lint.js`. ~17 line rules plus structural
  checks (N+1 queries in loops, unbounded queries) driven by brace-depth and
  per-variable constraint tracking. Masks string literals and comments before
  matching so quoted text does not false-positive. Surfaced via `/lint`, the
  toolbar, and as context for `/review`.
- **Code search** — `src/content/codeSearch.js` + `SearchPanel.jsx`. 14
  script-bearing tables, server-side `LIKE` push-down, `Promise.allSettled` so
  one unsupported table cannot kill the search, line-numbered excerpts.
- **Update set review** — `src/content/updateSets.js` + `UpdateSetPanel.jsx`.
  Collision detection across live update sets (chunked `IN` queries) and
  coverage detection for config changed recently with no `sys_update_xml` row.
- **Error triage** — `src/content/logs.js`. Groups near-identical `syslog`
  messages by digesting sys_ids/timestamps/numbers so the model sees distinct
  issues rather than thousands of duplicate lines. Adds slow transactions.
- **Stack trace resolution** — `/trace` parses four trace shapes, resolves the
  named artifact across five tables, and shows source around the failing line.
- **Safe background scripts** — `src/lib/scriptSafety.js`. Static write-risk
  analysis (12 patterns) shown before execution, plus `wrapAsDryRun` which
  patches `GlideRecord.prototype` write methods to log instead of write. Dry
  run is on by default; it **fails closed** if the prototype is not patchable,
  and running for real requires explicit confirmation.
- **Pre-save form diff** — `src/content/formDiff.js`. Compares live `g_form`
  values against the stored record via the bridge, reusing `lib/diff.js` for
  multiline fields.
- **Dependency graph** — `src/content/dependencies.js`. Extracts referenced
  names, filters ~45 built-in globals, confirms callees, finds callers via code
  search, renders Mermaid.
- **Security audit** — `src/content/securityAudit.js`. Read-only: open ACLs,
  public pages/widgets, risky system properties, admin sprawl, unauthenticated
  scripted REST. Bypasses nothing and exploits nothing.
- **REST builder** — `src/content/restClient.js` + `RestPanel.jsx`. Same-origin
  enforced via `validatePath` (rejects absolute, protocol-relative and
  traversal paths) to prevent the extension becoming a confused deputy.
  Generates a matching server-side `RESTMessageV2` snippet.
- **Markdown export** — `src/lib/report.js`. Chat transcript, compare results,
  lint findings, audit, search results and update set review.

Supporting changes: `tableApi.js` gained `fetchRecord` and `queryInChunks`;
the toolbar menu was regrouped into Navigate / This record / Instance / Tools;
`build.js` gained a fourth entry point for the page bridge; manifest bumped to
0.4.0 with `pagebridge.js` as a web-accessible resource.

### Verified
- `npm run build` succeeds; `dist/` contains all expected artifacts
- No lint/compile errors in any source file
- Removed the unused `cookies` permission from the manifest (unnecessary
  permissions are a store-review liability)

### NOT done — important
- **No testing against a real ServiceNow instance.** Everything below is
  unverified in practice:
  - background script endpoint (`sys.scripts.do`) and impersonation
    (`impersonate.do`) in `src/content/tableApi.js`
  - context-detection selectors in `src/content/context.js`
  - whether the page bridge survives ServiceNow's CSP in practice
  - whether `GlideRecord.prototype` is patchable in a background script (dry
    run fails closed if not, so the failure mode is safe but untested)
  - whether cross-instance session cookies work for Instance Compare
    (Basic Auth fallback exists for this reason)
  - the field lists in `src/lib/artifacts.js`, `conflictCheck.js`,
    `codeSearch.js`, `updateSets.js` and `securityAudit.js` (field names may
    differ by release, e.g. the `sys_hub_flow` shape, `sys_ui_policy` script
    fields, `sys_ws_operation` auth flags)
  - the `syslog.level` numeric mapping in `src/content/logs.js`
  - the `sys_update_xml.name` = `<table>_<sys_id>` convention that update set
    coverage detection depends on
  - Phase 5 endpoints: `/api/now/ui/concoursepicker/updateset` (update set
    switching), `/logout_impersonate.do`, `/threads.do`, `/xmlstats.do`,
    `/$restapi.do`, `/$flow-designer.do`, `/$scriptDebugger.do`
  - the Polaris classic-target URL shape
    (`/now/nav/ui/classic/params/target/<encoded>`) used by `shellUrl()`
  - whether the label selectors used by the technical-field-name toggle match
    the current form DOM
- Extension has never been loaded in Chrome/Edge — no runtime/console check
- No automated tests of any kind; the linter in particular would benefit from
  unit tests over known-good and known-bad script fixtures
- Classic UI is still unsupported for the toolbar and sidebar (the content
  script renders only in the top-level frame), though sub-frames now forward
  the keyboard shortcuts up to it and the page bridge attempts `gsft_main`
  resolution when reading `g_form`
- Git repo not initialized; no GitHub remote or branch protection
- `npm audit` reports 1 moderate severity vulnerability (unaddressed)

### UI refresh: floating toolbar removed
- The floating rail (`toolbar.js`, `.msb-rail*` CSS, `toolbarEnabled`, saved
  rail position) is gone. Entry points are the extension icon, `Alt+Shift+C`
  (sidebar) and `Ctrl+Shift+Space` (palette).
- The env badge moved into the sidebar header (still gated by
  `instanceBadgeEnabled`), next to a palette button.
- Sidebar empty state is now a 12-tool launcher grid. An open panel takes the
  whole sidebar body (`.msb-sidebar--focus`) instead of stacking above the chat;
  "Ask AI" from a panel closes it so the answer is visible.
- `toolbar.css` now holds only the palette and toast styles (name kept so
  `build.js` is unchanged).

### SN Utils-style features (done, code complete, untested on a live instance)
- `slashBar.js`: slash shortcuts in the palette (tn, tnn, sys, props, log, code, bg, xml, cs, stats, edit, sync).
- `instanceTag.js`: tab title prefix, favicon badge, top bar, instance switcher commands.
- `fieldTools.js`: Alt+click label copies the field name, Alt+Shift+click copies the value.
- `scriptEditor.js` + `editor.css`: hand-written full-screen editor (no new dependencies, as npm installs are blocked); applies to the form field only.
- Editor comfort pass: `lib/syntax.js` (bracket/string scanner, no eval under MV3 CSP), `lib/snippets.js` (Tab snippets), gutter lint markers, Run/Dry run, Ask AI (hides the editor, `Alt+Shift+E` returns), Compare, update set chip, F12 / Ctrl+click definition, Apply & save via the new `saveForm` bridge action (PROD confirm). Palette shows five recent records first. Unverified on a live instance.
- `fileSync.js`: two-way sync of the script field with a local file for VS Code via the File System Access API. Directory handle held in memory only because page JS shares the origin's IndexedDB.
- Palette polish: wider dialog, mode chip (Shortcut, Impersonate, sys_id), Enter hint on the active row.
- List export already existed (CSV, Markdown, JSON, sys_id list in the query panel).
- Unverified: editor behaviour across all browsers, `execCommand('insertText')` undo in a shadow-DOM textarea, sync polling on large scripts.

### Next steps
0. Set an API key (Options), then on a personal developer instance run the agent on a real form; then `npm run eval -- --live` and compare `--no-guide`; fix the catalog entries and endpoints the instance disproves.
1. Load `dist/` unpacked in Chrome and Edge; check for console errors
2. Test each palette command and slash command against a personal dev instance
3. Confirm the unverified assumptions listed above, starting with the page
   bridge, `sys.scripts.do`, the dry-run prototype patch, and `syslog.level`
4. Fix the endpoints/selectors/field lists; record findings in `docs/decisions.md`
5. Spike Instance Compare against two real instances to confirm which auth path works
6. Initialize the git repo and push with branch protection before the team scales up

**2026-10-19 (offline pass, PDI session had expired so no live checks):** README now documents the on-page tools (bottom bar, label/column menus, sys_id peek, floating windows), palette suggestions, pins and the tour. Added problem phrases for 10 more palette commands (versions, copy URL/markdown, unsaved form changes, ATF, bookmark, automation, X-ray toggle, XML stats). Welcome card text corrected to name the real toolbar actions. Still to confirm live after logging in: My work "Scope: Global".
