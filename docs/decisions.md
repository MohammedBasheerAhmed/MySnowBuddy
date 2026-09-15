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

## Unconfirmed — needs verification against a real ServiceNow instance
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
