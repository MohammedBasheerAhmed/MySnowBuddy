# Portal inspector (`/sp`, `/portal`, `/widgets`)

Service Portal and Employee Center work is mostly three questions: which widget is this, what is in `c.data` and the
options right now, and where is its code. This panel answers them for the portal page on screen. It reads; the one thing
it can do to the page is reload it with Angular debug info, after asking.

Open it from the palette ("which widget is this", "widget data", "c.data"), from `/sp`, `/portal` or `/widgets`, or from
the Analyze group of the launcher. `/sp banner` filters the list by name, and opens the widget when only one matches.

## What it shows

- **Page kind.** A Service Portal page (a `/sp?id=...`, `/esc?id=...` or any single-segment portal suffix with widgets on
  it) gets the full tool. Next Experience / workspace pages, classic forms and lists and anything else say
  "This is not a Service Portal page." with a one-line reason. A portal-looking page with no widgets yet is retried a few
  times (it may still be loading).
- **Widget list.** Every widget on the page in page order: name, widget id, instance title, where it sits ("Row 2,
  col-md-6"), how many instances of that widget the page has. Widget and instance sys_ids are in the row tooltip and in
  the details. Hover or focus a row to outline the widget on the page; the outline is drawn inside the extension's own
  shadow root, so the portal's DOM is not touched. **Pick on page** lets you click a widget on the page instead ("which
  widget is this?"); while it is on, clicks on the page do nothing else, and Escape cancels. **Show on page** scrolls the
  widget into view and flashes the outline.
- **c.data and options.** A collapsible JSON tree of the widget's `data` and `options` read from its Angular scope.
  Copy JSON, Refresh, optional refresh every 2 seconds. Cycles are shown as `[circular]`, functions as `fn()`, DOM
  nodes, windows and Angular scopes as a label; depth is limited to 4 and each value to about 20 KB (the panel says when
  it truncated). Values under secret-looking names (`password`, `secret`, `token`, `api_key`, `authorization`, `cookie`,
  `g_ck`, ...) and values that look like a bearer token, JWT, private key or `user:pass@host` URL are replaced by
  `[hidden]`, in the tree and in the copied JSON.
  The secret check runs in the customer's page, so it is bounded: only the first 4 KB of a string are looked at (only
  the start of a long string is shown anyway) and every repeat in the patterns has a limit. The first version used an
  unbounded `user:pass@host` pattern that took about 3.5 seconds on a 40 KB string of letters (quadratic backtracking).
  `sysparm_ck` (the session's CSRF token, like `g_ck`) is hidden too, in the tree and in the URL parameters. Typed arrays
  and buffers are labelled (`[typed array, N items]`), never walked, and a value that throws even on `Array.isArray` (a
  revoked Proxy) is `[unreadable]` without losing the rest of the copy.
- **Snapshot and compare.** Take a snapshot, use the page, press Refresh: the panel lists exactly which keys of `c.data`
  were added, removed or changed (`items[0].state "New" to "Closed"`), and marks them in the tree. A whole object that
  appeared is one line. Snapshots live as long as the page does, so closing the panel does not lose them.
- **Options.** The live options, the option schema from the widget record next to the values in use (which differ from
  the default, which are not in the schema), and the options saved on the instance record (`widget_parameters`).
- **What its code touches** (from the `sp_widget` record, comments ignored): tables used in `new GlideRecord('x')` /
  `GlideAggregate` / `GlideQuery` with the operations seen and whether it writes; Script Includes called (confirmed
  against `sys_script_include`, linked when found) and the methods; `gs.getProperty` names; roles checked; `$sp` calls and
  `$sp.getParameter` names; `input.action` values the server handles and the actions the client sends; the keys the
  server script sets on `c.data`; options it reads; events it queues; embedded widgets; client-side server round trips,
  `$scope.$on` / `$broadcast` events, GlideAjax and spUtil calls. "Worth a look" lists keys the HTML or client script read
  from `c.data` that nothing sets, and actions the client sends that the server never checks (or the reverse). These are
  hints from reading source text, not proof, and are left out when the server script builds keys dynamically.
- **Links** (built from sys_ids only): widget record, Widget Editor, instance record, "where it is used" (list of every
  `sp_instance` of the widget), page record, Page Editor, portal record. The page's URL parameters are listed, with
  secret-looking ones hidden, and the page id is shown.
- **Angular debug info.** Production portals usually switch AngularJS debug info off, and then `scope()` answers nothing,
  so `c.data` cannot be read. The panel says so in one sentence and offers **Reload with debug info**, which asks first
  and then calls the documented `angular.reloadWithDebugInfo()`. That reloads the page; nothing else changes.

## How it works

- `src/lib/portalScope.js`: pure, DOM-free code that also runs in the page world: serialiser, secret masking, widget
  address validation, scope finder, debug-info check and the three bridge actions (`portalActions`).
- `src/lib/portalInspector.js`: pure: page classification, widget discovery from a document-like object, placement,
  links, source analysis, option schema, snapshot diff.
- `src/page/bridge.js` (page world) gained three actions: `portalScan`, `portalWidgetState`, `portalReloadWithDebugInfo`.
  The bridge has to stay a plain script (it is injected as one, and `tests/control.test.js` / `lib.test.js` run it as one),
  so it carries a copy of `portalScope.js` between two marker lines. `tests/portalinspector.test.js` fails when the copy
  differs; after editing `portalScope.js` run `UPDATE_PORTAL_BRIDGE=1 node tests/run.js portalinspector` and review the diff.
  The built bridge was also run in real Chrome against a real DOM and a fake `angular` to check it answers.
  The two reads take a widget **address** (widget sys_id, instance sys_id, position), never a selector or an expression;
  nothing from the caller is evaluated. The bridge header comment says so.
- `src/content/portalInspector.js`: finds widgets in the DOM, calls the bridge, reads `sp_widget`, `sp_instance`,
  `sp_page`, `sp_portal` and `sys_script_include` with the user's own session (every query names its columns and filters
  by sys_id; the page and portal lookups check the returned row, because an unknown column would match every row), draws the
  outline, runs "Pick on page".
- `src/sidebar/PortalPanel.jsx`, `portal.css`. `install()` does nothing until the panel is opened.

A part that cannot be read is named in the panel ("Could not read the widget record: ...", "Not returned by this
instance: ..."), never shown as empty.

## Assumptions that need a live check

None of these could be checked against a real portal while this was written. The unit tests and the preview prove the
logic against fake DOM and fake scopes; they do not prove ServiceNow looks like that.

DOM (the same markers Page X-ray uses, itself unverified):

1. The widget's root element carries the class `v<widget sys_id>`; the instance wrapper has id `x<sp_instance sys_id>`,
   on that element or an ancestor within 8 levels. Instance wrappers without a `v` class, and bare `<sp-widget>` elements,
   are listed as a fallback (with less information).
2. Rows are `<sp-page-row>` and columns are Bootstrap `col-xs|sm|md|lg|xl-N` classes. If not, the place is left blank.
3. Portal markup is recognised by `sp-page-row`, `sp-widget` or `ng-app` containing `$sp`.
4. A portal inside the classic `gsft_main` frame is read through that frame; a cross-origin frame cannot be.

AngularJS (the extension reads only; it works in the page world through `angular.element(el)`):

5. `window.angular` is the AngularJS 1.x global. With debug info on, `.scope()` / `.isolateScope()` return scopes; with it
   off they return `undefined`, and no `ng-scope` / `ng-binding` classes exist (that is how debug info is detected).
6. The widget scope (own or inherited) has `data`, `options`, `widget` and the controller `c` (`c.data`). `widget.sys_id`
   is the widget's sys_id, `widget.name` and `widget.id` its name and id, `widget.rectangle_id` the instance sys_id (only
   an extra identity check), `widget._server_time` the last server call in ms. A scope is accepted only when it carries
   this widget's identity, or has `c.data` with `data` / `options`; a scope that carries a **different** widget is rejected,
   so an embedded widget never shows its parent's data.
7. `$rootScope.portal` / a scope's `page` carry `sys_id`, `id`, `title`, `url_suffix`. Optional: without them the panel
   looks the page up by `sp_page.id` and the portal by `sp_portal.url_suffix`.
8. `angular.reloadWithDebugInfo()` exists and turns debug info on for the tab (it sets `window.name`). Whether debug info
   stays on while navigating inside the portal is not known.

Instance:

9. Editor links: `/sp_config?id=widget_editor&sys_id=<widget sys_id>` and `/sp_config?id=page_edit&p=<page id>`.
10. Columns (also in `src/lib/requirements/portal.js` for the Self-check panel): `sp_widget` (`sys_id`, `name`, `id`,
    `script`, `client_script`, `template`, `css`, `option_schema`, `data_table`, `link`, `roles`, `public`,
    `sys_updated_on`, `sys_updated_by`), `sp_instance` (`sys_id`, `sp_widget`, `title`, `sys_class_name`,
    `widget_parameters`, `sys_updated_on`), `sp_page` (`sys_id`, `id`, `title`), `sp_portal` (`sys_id`, `title`,
    `url_suffix`), `sys_script_include` (`sys_id`, `name`).
11. `sp_instance.widget_parameters` is the instance options as JSON; `option_schema` is a JSON list of
    `{name, label, type, section, hint, default_value}`; reading `sp_instance` through the Table API also returns child
    classes with `sys_class_name`.
12. A user without access to `sp_widget` (common for portal end users) gets the live data but a visible "could not read
    the widget record" instead of the code summary.

### Quick live check

Open `/sp?id=index` as an admin. Open the panel: the widget names and rows should match what Page X-ray shows. Select a
widget, press Take snapshot, click something on the page, press Refresh. If the data section says debug info is off, use
the reload button and try again. Then check the "Scope found as ..." line under the tree: it says which element and scope
the data came from, which is what to look at if the data looks wrong.

## Limits

- AngularJS portals only (Service Portal, Employee Center on `/esc`). Next Experience pages have no widget scopes.
- Only `data` and `options` of the widget scope are read, not other scope fields or `$rootScope`.
- Data held only on the server (not in `c.data`) is invisible here; use the Widget Editor's preview or logs for that.
- Secret masking is by name and value pattern, a safety net, not a guarantee.
- The source analysis is regex-based: a table, property or action name built at run time is counted, not resolved.
- **Pick on page** swallows clicks on the page while it is on (two minutes at most, Escape or Cancel pick ends it).

## Try it without an instance

`PORT=<port> node preview/serve.js`, then open
`http://localhost:<port>/preview.html?page=portal&open=portal` (add `&debug=off` for the debug-info-off state,
`&theme=dark`, `&q=banner`). The preview page becomes a fake portal with three widgets (four instances), each with a fake
Angular scope, and the buttons inside the widgets change their data so Snapshot and compare can be tried. The bridge
actions are answered by the real `portalActions` code. Fixture: `preview/fixtures/portal.js`.

## Follow-up ideas

- Record every `c.server.get` round trip (request and response) next to the data changes. Needs wrapping `$http`, so it
  is not read-only; left out on purpose.
- Auto-snapshot on each server response and keep a short history of `c.data`.
- Show the embedded-widget tree and which `spUtil.recordWatch` subscriptions a widget holds.
- A "which widgets use this Script Include / property" link back from the code summary.
