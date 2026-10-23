# Client trace (`/watch`, `/clienttrace`, panel `clienttrace`)

A flight recorder for the browser side of a ServiceNow form. It answers the questions a developer otherwise answers by
guessing or with the browser console: who set this field, why did the field change by itself, why is the form slow,
which GlideAjax calls did my client scripts make, which JavaScript errors happened.

## What a developer does

1. Open the panel (`/watch`, or "Client trace" in the palette) on a form and press **Reload and record**. NowBuddy arms the
   recorder and reloads the page, so it sees the onLoad scripts from the first moment. (**Record from now** arms without a
   reload; the page load itself is then not included.)
2. Use the form: change a field, press Save, open a dialog.
3. Read the panel while it updates live. **What stands out** lists errors, slow or blocking calls, repeated GlideAjax,
   calls on fields that are not on the form, fields several scripts fight over, long freezes, the biggest silent gap and
   script includes that are missing or not client callable. **Timeline** lists every event with its time (ms since that
   frame started loading), the script behind it and, in **Call stack**, the raw frames. **Fields** tells the story per field
   ("changed from 3 to 1 at 64 ms by Client script: Reset priority (onChange on category)").
4. Filter by field, kind, frame, errors only, slow only. **Copy as Markdown** puts a ticket-ready report on the clipboard (it
   copies what the filters show), **Export JSON** saves the raw events, **Clear** empties the recording.

It stops by itself after 30 minutes (and says so in the panel). When the page loads while armed, one toast says it is
recording.

## What is recorded (and what never is)

Only while armed, in every frame of the page (the classic form lives in the `gsft_main` iframe):

| Kind | Source |
| --- | --- |
| Field changes | `g_form.setValue clearValue setMandatory setReadOnly setReadonly setDisabled setVisible setDisplay showFieldMsg hideFieldMsg showErrorBox hideErrorBox addOption removeOption clearOptions setLabelOf` |
| Messages | `addInfoMessage addErrorMessage addWarningMessage clearMessages hideAllFieldMsgs` |
| Form actions | `save submit setSectionDisplay hideRelatedList(s) showRelatedList(s) disableAttachments enableAttachments` |
| GlideAjax | `getXML getXMLWait getXMLAnswer`, with class, `sysparm_name` and parameters, duration, answer, synchronous flag |
| GlideRecord (client) | `query get insert update deleteRecord`, flagged when called without a callback (synchronous) |
| Dialogs | `GlideModal.render`, `GlideDialogWindow.render`, `g_modal.showFrame/confirm/alert/showFields` |
| Requests | XHR and `fetch` to `/xmlhttp.do`, `/api/...`, `/angular.do` with status and duration (not those a GlideAjax or GlideRecord call already describes) |
| Errors | uncaught exceptions, unhandled promise rejections, `console.error`, `console.warn`, `jslog` |
| Busy time | long tasks (100 ms and over) from `PerformanceObserver`, the page markers (load started, DOMContentLoaded, load) |

Never recorded (all of this is removed in the page, before an event enters the buffer, so it is in neither the panel, the
Markdown and JSON exports, nor what the AI agent's `read_client_trace` tool reads):

* values of password-type fields (`g_form.getControl(field).type === 'password'`, or a dictionary type containing
  "password");
* **anything that contains what a password input on the page holds at that moment**: a script that copies the typed
  password into a GlideAjax parameter with an innocent name, into another field, a message or a log line is caught too
  (the inputs are found with one document query at most once a second, or again when a password input fires
  `input`/`change` or after a g_form field call; their values are read fresh for every event, and never stored);
* values of any field, GlideAjax parameter, object key or URL parameter whose name contains password / passwd /
  passphrase / pwd / secret / token / key / credential / authorization / bearer / cookie / session id / `sysparm_ck` /
  `g_ck`, or has pass / passcode / pin / otp as a whole part of the name (`u_pin`, `sysparm_pass`);
* in encoded queries (client GlideRecord, `sysparm_query` of a request, checked decoded): the value of every condition on
  such a field whatever the operator (`u_api_key!=x`, `u_tokenLIKEx`, `ORu_password=x`);
* anything that looks like a credential (JWT, `Bearer ...`, PEM blocks, long opaque strings), alone or inside free text;
  `password=...`, `client_secret_value: ...`, `Authorization: Bearer ...` style values in any text, including g_form
  messages, GlideAjax answers and error messages;
* request bodies and headers (never read), cookies (never read).

URL query strings are kept only for requests, and never inside stack frames. Text is capped at 200 characters, a stack at
8 frames, arguments at 8, the buffer at 1500 events per frame. Typed arrays and binary data are summarized as `[binary]`
without reading them.

## How it works

```
page world (MAIN)                      isolated world (content script)              panel (React)
src/page/recorder.js                   src/content/clientTrace.js                  src/sidebar/ClientTracePanel.jsx
  -> src/lib/clientTraceRecorder.js      services clientTraceLoad/Arm/Disarm/        src/lib/clientTrace.js
     createRecorder(win)                 Clear/Status/Resolve                        (rows, attribution, stories,
     ring buffer of events    <-- DOM CustomEvents (unguessable id) -->               findings, Markdown)
```

* **The recorder** (`src/page/recorder.js`) is a manifest content script with `"world": "MAIN"`, `"run_at": "document_start"`,
  `all_frames`, on `https://*.service-now.com/*`, built to `dist/recorder.js` as a self-contained IIFE. It needs Chrome 111 or
  newer (the `world` key). It also refuses to run on any host that is not `*.service-now.com`.
* **Zero cost unless armed.** Unarmed, it registers one DOM listener (the extension's requests), one `storage` listener
  and one `pageshow` listener (a page restored from the back/forward cache decides again from the flag, so a recording past
  its 30 minutes stops there), nothing else: no wrappers, no timers, no property traps. Armed means
  `sessionStorage['msb_trace_armed']` holds a future expiry time (epoch ms).
  The content script writes it; sessionStorage is shared by the same-origin frames of the tab, so the form frame arms itself
  at its own `document_start` after a reload, and gets a `storage` event when Arm or Disarm is pressed without a reload.
* **Passive wrappers only.** Every wrapper calls the original with the same `this` and arguments, returns its value and
  rethrows its exception (the same object). Recording is inside try/catch; if it throws, the original has still run. The
  only calls it makes into the page are the read-only `g_form.hasField / getValue / getControl / getGlideUIElement`, to say
  whether a field exists and what a `setValue` did (before / after are compared raw; when `getValue` cannot be read the
  event does not claim the value was unchanged), plus reading the `value` of password inputs for the secret check. A call identical to the one already running (the platform calling
  itself) is not recorded twice; a script an `onChange` handler runs is recorded as a child (indented in the timeline).
  Stack capture is skipped for floods (over 300 events per second). After Disarm the wrappers on g_form, GlideAjax and
  GlideRecord stay as inert pass-throughs until the page reloads; console, XHR and fetch wrappers are removed again (if
  nobody wrapped on top of them).
* **Late globals.** `g_form`, `GlideAjax`, `GlideRecord`, `GlideModal`, `GlideDialogWindow`, `g_modal` and `jslog` are hooked
  the moment they appear: a property trap on `window` catches the assignment (and turns itself back into a plain data
  property on the first assignment), and a bounded poll (25 ms for the first second, then 250 ms until a minute is up)
  catches what a trap cannot (a function declaration replaces it; a non-configurable property cannot have one). The hook
  goes on the object that owns the method (own property or prototype), keeps `toString()`, `length` and enumerability, and
  is applied once per object. While armed, a trapped global that the page has not defined yet exists as an accessor that
  returns `undefined` (so `'GlideModal' in window` is true where it was false); Disarm removes it again. A `var g_form`
  declaration followed by an assignment leaves `g_form` configurable (it would otherwise not be). Neither changes what
  `typeof` or a read returns.
* **Re-arming** does not wrap twice: if a page script wrapped `console.error`, XHR or `fetch` on top of ours, Disarm
  cannot take ours out from under it; ours then stays as a pass-through and is reused by the next Arm.
* **Transport.** The content script cannot read page globals but shares the DOM, so it uses the same pattern as
  `src/page/bridge.js` / `src/content/pageBridge.js`: a `msb-trace-request` CustomEvent with an unguessable id; the recorder
  answers synchronously with a `msb-trace-response` CustomEvent carrying that id (actions `status`, `pull {since}`, `arm`,
  `disarm`, `clear`). Events are pulled incrementally (`since` = last seq seen), so the panel polls once a second while it is
  open and recording.
* **Frames.** Every frame has its own recorder; the UI lives only in the top frame (`src/content/index.js` mounts nothing in
  sub-frames). The service worker is not touched. The top frame asks each child frame (`window.frames`) for new events with
  `postMessage` to the exact origin; a child answers its parent the same way, and a frame that has children of its own
  passes their answers up. A frame that is about to unload (the form frame reloading after Save) sends what the top frame has
  not seen from its `pagehide` handler (marked `final`, because its source window is already gone). Only trusted message
  events are accepted (`event.isTrusted`: a real `postMessage`), so a page script cannot construct a MessageEvent with a
  null source and the right origin and dispatch it. A same-origin page script can still post real messages from a child
  frame, so every event that arrives is rebuilt from known fields with caps by `sanitizeEvent()` and is only ever
  displayed, never acted on; the frames list is capped at 40 so a flood cannot grow it. The worst a page script can do is
  show made-up rows, clear the recording, or arm its own tab (still capped at 30 minutes). This choice replaces the "hotkey relay"
  pattern (which goes through the service worker) because it would need a change to the shared service worker.
* **Event shape.** `{ seq, id, t, at, kind, name, field?, args?, result?, durationMs?, frame, stack: [{fn, line, col, url?}],
  parent?, depth?, phase?, ref?, flags? }`. `seq` is the order stored, `id` the identity; a GlideAjax or GlideRecord call
  with a callback is two events (phase `start`, then phase `end` with `ref` = the start's `id`) which the panel folds into one
  row; `t` is ms since that frame's navigation start.

## Which script was that? (attribution)

From each event's stack, the panel collects 32-hex sys_ids found in function names and in the PATH of script URLs (never the
query: it holds the record's own id), and UI script file names (`<name>.jsdbx`). `src/content/clientTrace.js` looks them up,
read-only, in `sys_script_client`, `sys_ui_policy`, `sys_ui_action`, `sys_ui_script`, `catalog_script_client` and
`catalog_ui_policy` (only tables that exist: `sys_db_object` says which), and GlideAjax class names in `sys_script_include`
(exists? client callable?). Only a row whose sys_id (or exact name) is one that was asked for is used, so a query that
ServiceNow partly ignores cannot attach a wrong name. The label reads "Client script: Reset priority (onChange on category)".
If no frame resolves, it says **Unknown script** and shows the nearest frame. Nothing is guessed. A table that cannot be
read shows a "Could not check <table>" line under "About the script names". If `sys_db_object` answers without
`sys_script_client` (rows hidden by an ACL, since that table exists everywhere), the table check is treated as unknown and
every table is asked, so an unreadable one is reported instead of silently skipped. At most 200 ids, 50 UI script names
and 50 classes are looked up per call, all validated (32 hex / `[A-Za-z0-9_.-]`) before they go into a query.

**Copy as Markdown** escapes `[ ] < > \`` in page text, so a console message such as `![x](https://...)` or `<img ...>`
stays text in the ticket instead of becoming an image that loads or HTML.

### What a real classic form looks like (confirmed live 2026-10-23, PDI, incident form, 521 events, no breakage)

* A client script's `g_form` call has a frame such as `onLoad_<32 hex> at /incident.do:2253:9`. The page **inlines** the
  client scripts as functions named `onLoad_<32 hex>` (8 on that form) and `onChange_<name>` (`onChange_cmdb_ci_bsm`,
  `onChangeBusinessServiceShowBSM`). The hex of `onLoad_` is **not** the sys_id of any record (checked against
  `sys_metadata`, `sys_script_client`, `sys_ui_policy`, `sys_ui_script`, `sys_ui_action`, `sys_script`,
  `catalog_script_client`, `sys_ui_macro`), so the sys_id lookup alone cannot name them.
* UI policy actions come from the platform's engine: frames `klass._runAction at /scripts/ui_policy.jsx:683:11` (also
  :669, :711). The page embeds the policies as `ui_policy_add([{"actions":[{"cleared","disabled","mandatory","name",
  "visible"}], "condition_fields", "conditions", "onload", "reverse", "script_false", "script_true",
  "short_description", "source_table", "sys_id", "table", ...}])` and defines `window.onCondition_<32 hex>_true/_false`.
* The platform writes many `jslog(...)` lines (`(anonymous) at /incident.do:5530:4`, "added render event for ...").

### So attribution also uses the page's own source

`src/content/clientTrace.js` reads the inline `<script>` text of the frame the events came from (`document.scripts`,
never a refetch; at most 400 scripts / 4 million characters; only while that frame still shows the same page path as the
recording), and the pure helpers in `src/lib/clientTrace.js` work on it. Nothing is evaluated.

1. **UI policy engine.** A call whose stack has a frame in `/scripts/...ui_policy...jsx` is labelled as the UI policy
   engine. The embedded `ui_policy_add([...])` data is cut out as an exact bracket-balanced slice (strings and comments
   skipped) and read with `JSON.parse` (`extractUiPolicies`); a call that cannot be parsed is counted and noted. The
   policies with an action on that field and that effect (`setMandatory` -> mandatory, `setVisible`/`setDisplay` ->
   visible, `setReadOnly`/`setDisabled` -> disabled, `clearValue` -> cleared; "ignore" never matches) are the candidates:
   one is named `UI policy "<short_description>"` with an Open link (sys_ui_policy, its validated sys_id) and the line
   "the only UI policy on this page with a mandatory action on close_notes"; several read `UI policy engine: one of "A",
   "B"`; none reads `UI policy engine` and says so. A frame in `onCondition_<hex>_true/false` whose hex is the `sys_id` of
   a policy embedded in the same page is that policy's script.
2. **Client script by its source text.** For a frame in a page function (`onLoad_<hex>`, `onChange_...`), the function's
   body is cut out of the inline script (`extractFunctionSource`; a name defined twice is skipped). Up to two distinctive
   single lines of it (25 to 120 characters, cut at `^ = < > !`, no boilerplate such as `if (isLoading ...)`, nothing that
   looks like a secret) are searched with `active=true^tableIN<form table and its parents>^scriptLIKE<line>` on
   `sys_script_client`, then `catalog_script_client` (no table condition). A script is named only when **exactly one**
   record comes back, its script holds that line, and at least 80% of the function's other lines (whitespace collapsed)
   are in it too: `Client script "<name>" (matched by its source text)`. Otherwise it stays Unknown script. At most 25
   such queries per lookup; what the budget or an unreadable frame left undecided is asked again (a few times) instead of
   being remembered as not found. The AI tool, which asks with ids only, gets the same: when a caller passes no page
   functions or pages, they are worked out from the recording.
3. **jslog.** Log rows (`jslog`) are hidden by default behind "Platform debug log (jslog)"; the count line says how many
   are hidden, Copy as Markdown says how many it left out, Export JSON keeps them all.

## Assumptions that need a live-instance check

Items 1 and the stack shapes above were checked live (2026-10-23). The rest was exercised against a local fake classic
form in headless Chrome: see "Tests" below.

1. **Still to check live:** that `scriptLIKE<line>` on `sys_script_client.script` finds the record (the page is assumed to
   inline the script body verbatim, apart from the function name), that `ui_policy_add` takes valid JSON on every form
   (catalog forms use another format and are not read), whether the `onCondition_<hex>` hex is the policy sys_id (only
   used when the page's own policy data says so), and the frames for UI actions.
2. `g_form.hasField(name)` exists and returns `false` for a field that is not on the form (it is what flags "not on the
   form"). Check it on a catalog item (variables) and for a field hidden by a UI policy: a wrong `false` would be a false
   alarm.
3. `GlideAjax` is a Prototype-style class with `initialize`, `addParam`, `getXML`, `getXMLWait`, `getXMLAnswer` on its
   prototype, and keeps `processor` and `params` on the instance. The recorder reads class and parameters from its own
   capture and falls back to those two properties; if both differ in a release, class and method show as blank.
   `getXMLAnswer` is assumed to be built on `getXML` (a nested call on the same object is not recorded twice).
4. Client `GlideRecord` methods `query get insert update deleteRecord` are on its prototype, and `tableName` /
   `getEncodedQuery()` exist. A call with no function argument is treated as synchronous.
5. `g_form` is assigned as a global (`window.g_form`) in the frame that shows the form. In the Next Experience workspace,
   forms may not use this (not covered).
6. `GlideModal.prototype.render` and `g_modal.showFrame/confirm/alert/showFields` exist.
7. Columns: `sys_script_client.name/table/type/field`, `sys_ui_policy.short_description/table`,
   `sys_ui_action.name/table/action_name`, `sys_ui_script.name`, `catalog_script_client.name/type/cat_item`,
   `catalog_ui_policy.short_description`, `sys_script_include.name/client_callable` (`api_name` is only used to confirm
   a scoped class), `sys_db_object.name`. See `src/lib/requirements/clientTrace.js` (Self-check).
8. The `.jsdbx` file name for UI scripts is from memory.

## Known limits

* While armed, `console.error` and `console.warn` calls show `recorder.js` as their source in DevTools (the wrapper is what
  calls them). Disarm puts the originals back.
* A call made before the recorder hooked the object (a script that runs before `g_form` is assigned, when the trap could not
  be installed) is missed; "Record from now" misses everything before the press.
* Long tasks are seen by every same-origin frame; the panel keeps one row for the same stall.
* The buffer holds 1500 events per frame; the panel's own copy holds 6000. Older events are dropped and counted.
* A full tab reload (Reload and record) starts a new recording; the previous one is gone. The form frame reloading
  (opening another record) keeps earlier loads, listed under "Every page load".
* Frames of another origin are not recorded (a recorder in each same-origin frame only).
* Password inputs inside shadow DOM (workspace / Next Experience components) are not seen by the password-value check;
  those forms do not use the `g_form` global the recorder hooks either. A password input that a script creates and fills
  without any input event, and sends within the same second, can be missed by that check (name-based redaction still
  applies).
* The panel and the recorder run in the page being measured. Rows are memoized and an idle poll changes nothing, so the
  panel adds no busy time while it waits; opening "Show in timeline" on a finding renders every row of the recording.

## Tests

`tests/clienttrace.test.js` (node:test, 110 tests; the last 12 cover the page-source attribution: `ui_policy_add` parsing
with brackets in strings and a broken call, function bodies with braces in strings and comments, safe fragments, the 80%
body check, frame names, UI policy candidates (one, several, none, unreadable, `onCondition_`), source matches against a
fake instance (table chain, inactive and other-table rows, two identical scripts, a frame that moved to another page, the
25-query budget, the AI tool's ids-only call) and the jslog filter. The 18 added in the security review are the "Adversarial" section and the content
tests at the end: password-input values under innocent names, scrubbed messages / answers / errors, encoded-query and
decoded URL redaction, hostile values (20 M typed array, throwing and revoked Proxies, cyclic, frozen, 5 MB strings),
arity / enumeration / Promise identity / frozen and sealed objects / a Prototype-style `$super` subclass, unreadable
`getValue`, re-arm after a page wrapped XHR / fetch / console on top, back/forward cache expiry, a huge `window.name`, a
page `.stack` getter that calls g_form, the transport surviving a replaced `CustomEvent` / `dispatchEvent`, forged
untrusted messages, the frame cap, a recorder still armed after the page cleared the flag, ACL-hidden `sys_db_object`,
the lookup cap, Markdown escaping): the recorder against fake window / g_form / GlideAjax / GlideRecord / XHR /
fetch (same return value, `this`, arguments and exception; still calls through when logging throws; ring cap; redaction; unknown
field; nested and identical calls; late and non-configurable globals; bounded poll; console/XHR/fetch restore; error and
rejection capture; transport; arm flag, expiry and storage events; boot off ServiceNow), stack parsing (V8 and Firefox format),
attribution, the content-side lookups against a fake instance (only asked-for rows used, catalog subclass wins, missing tables skipped, unreadable tables noted and not remembered as "not found"), stories, findings, filters, Markdown export, event sanitising.

Outside the suite (not repeatable from `npm test`; the scripts were throwaway), the work was exercised twice in real Chrome
against a FAKE classic form served from localhost (a shell page with a `gsft_main` iframe, a `g_form` assigned 30 ms after the
document starts, a Prototype-style `GlideAjax`, sync and async XHR, a thrown error, a rejected promise):

1. The recorder and the content-side module bundled together and injected at document start: arm at load, arm while the page is
   open (the form frame follows through the `storage` event), the form frame reloading (its last events arrive through the
   `pagehide` flush), Disarm, Clear.
2. The REAL built extension (a copy of `dist/`, Chrome 155) on `https://dev99999.service-now.com` mapped to the local server:
   the manifest MAIN-world script runs in the shell and in the form frame at `document_start`, the isolated content script and the
   page share `sessionStorage`, the recorder's answers cross worlds as CustomEvents, 27 events from 2 frames reach the panel, the
   toast appears and its Open button opens the panel, Reload and record, Record from now (live), Stop recording (both frames
   stop and the flag clears), Fields tab. That run is what showed the `pagehide` source-window problem (a frame that is
   unloading has no source window left) and why the recorder's own helper functions are named `msb...` (so their frames are
   dropped even if the script URL is not reported).

3. Review pass (2026-10-23), real built extension in Chrome 155 against a fake `https://dev99999.service-now.com` (shell,
   `gsft_main` form frame, a sandboxed frame, an `about:blank` frame, a small Prototype.js with `argumentNames` and
   `$super`, a password input filled by script). A page self-test (return values, `this`, thrown error identity, `for in`
   keys, `fn.length`, `argumentNames()`, `toString`, a `$super` subclass made after hooking, `apply` / `call` with another
   form, argument identity, `getXMLWait` return value, sync XHR, `send()` return, client GlideRecord sync and async,
   `fetch` called unbound, a 404, a GlideAjax callback that throws reaching `window.onerror`) gave the same results with
   no extension, with the extension unarmed and armed, except `'GlideModal' in window` while armed (see Late globals).
   Unarmed: `XMLHttpRequest.prototype.open/send`, `fetch`, `console.error` native, no accessor on `window.g_form`,
   GlideForm methods untouched, the sandboxed frame (where sessionStorage throws) without errors. Armed: 28 events in the
   form frame, none of the planted secrets (password input value sent as `sysparm_value`, `sysparm_api_key`,
   `sysparm_ck` in body and URL, `password=` in console text, a password field's value) in the recording. Disarmed: all
   natives back, the trap gone. No console or page error came from the recorder in any phase.

Nothing here touched a real ServiceNow instance. What a real form's stack frames, `g_form` and `GlideAjax` look like is the
list above.

## Checking it on a real instance (5 minutes)

1. Open an incident form, `/watch`, **Reload and record**. Expect a toast "NowBuddy is recording this page" and, in the panel, events
   from 2 frames (the shell and `gsft_main`). If the panel says "No recorder answered in: gsft_main", the manifest script did not load
   in the form frame: reload once (a page open before the update has no recorder).
2. Open **Fields**. For a field a client script sets on load, is the script named? If every line says "Unknown script", open "Call
   stack" on one timeline row and compare the frames with assumption 1 above.
3. Change a field that has an onChange client script. The script's own `g_form` calls should show indented under it.
4. Save the form. `g_form.save` should appear, and the form frame's last events should still be there after the page reloads (under
   "Every page load").
5. Press **Stop recording**, check DevTools: `console.error` is the browser's again, and `XMLHttpRequest.prototype.send.toString()` no longer
   mentions the recorder.
