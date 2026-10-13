# Progress

Read this file first at the start of any new session, before re-exploring the
codebase or re-reading the full build spec.

## Status: Phases 1–5 implemented and building cleanly. NOT yet tested against any live ServiceNow instance.

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
1. Load `dist/` unpacked in Chrome and Edge; check for console errors
2. Test each palette command and slash command against a personal dev instance
3. Confirm the unverified assumptions listed above, starting with the page
   bridge, `sys.scripts.do`, the dry-run prototype patch, and `syslog.level`
4. Fix the endpoints/selectors/field lists; record findings in `docs/decisions.md`
5. Spike Instance Compare against two real instances to confirm which auth path works
6. Initialize the git repo and push with branch protection before the team scales up
