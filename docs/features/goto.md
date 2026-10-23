# Go to anything

Type part of a name in the command palette and land on the record: a business rule, script include, ACL, notification,
flow, widget, table, property, role, user and more. It is Ctrl+P for a ServiceNow instance.

Code: `src/lib/goTo.js` (pure: catalogue, parsing, ranking, the search engine; tests in `tests/goto.test.js`),
`src/content/storedCommands.js` (`goToProvider`, `goToActions`, `resumePendingEdit`), `src/content/commandPalette.js`
(wiring, kind badges, the actions menu), `src/sidebar/goto.css` (build.js adds every stylesheet in that folder to
`content.css`), `src/lib/requirements/goto.js` (generated from the catalogue, for the Self-check panel),
`preview/fixtures/goto.js` (fake data for the preview, see the end).

Status: unit tested (84 tests in `tests/goto.test.js`) and looked at in the preview harness, light and dark, with the
keys driven by puppeteer. Reviewed on 2026-10-23 (see "Review fixes" at the end). **Not yet checked on a live instance.**

## Using it

| Type | You get |
| --- | --- |
| `incident closed` | The most likely kinds for that text and the page you are on: rules, script includes, client scripts, UI actions, ACLs, notifications... |
| `AjaxUtil` | One PascalCase word is read as a class: script includes first. It is split at the capitals, so it also finds `AJAXMessagingUtils` |
| `br: closed`, `si: ajax`, `acl: incident.state`, `widget: approval` | Only that kind. The verbs are the slash finders' (`/br`, `/si`, `/acl`...) |
| `business rule: closed`, `script includes: ajax`, `sys_script_include: ajax` | The full kind name (singular or plural) or the table name works too |
| `br,si: notify` | Several kinds |
| `br:` | A link to the list of Business Rules (nothing is searched until there are two characters) |
| `glide.ui.concourse`, `incident.state`, `x_acme_hr`, `abel@example.com` | The shape of the text picks the kinds: property, ACL and dictionary entry, application and table, user |

Kinds (verb in brackets): Business Rule (`br`), Script Include (`si`), Client Script (`cl`), UI Action (`uia`), UI Policy
(`uip`), UI Script (`uis`), UI Page (`uipg`), UI Macro (`macro`), Scheduled Job (`job`), Fix Script (`fix`), ACL (`acl`),
Notification (`notif`), Email Script (`es`), Event (`evt`), Script Action (`ea`), Flow and Subflow (`flow`), Flow Action
(`action`), Workflow (`wf`), Transform Map (`tm`), Scripted REST API (`sra`), Portal Widget (`widget`), Portal Page
(`page`), Angular Provider (`prov`), Table (`table`), Dictionary field (`dict`), System Property (`prop`), Role (`role`),
Group (`g`), User (`u`), Catalog Item (`item`), Application (`app`), Update Set (`us`).

Each result shows the kind as a badge, the name, and a grey line such as `incident · global · after update`. An ACL
shows its operation first (`read · record · global`). Inactive records are listed, ranked lower and marked `inactive`.
Role tiers apply (`src/lib/roleTier.js`): a user without the developer role is not offered rules, ACLs and so on.

Keys (all existing palette keys are unchanged): Enter opens, Shift or Ctrl+Enter opens in a new tab, Alt+Enter copies the
link, Alt+1..9 runs a numbered row, Alt+P pins an action. **Tab, or Right Arrow with the caret at the end of the text,
opens the actions of the highlighted result** (the footer shows `Tab actions` while one is highlighted). Up and Down move
in the list of actions, Enter runs one, Esc, Left or Tab close it (Esc closes only the actions, not the palette).

| Action | What it does |
| --- | --- |
| Open, Open in a new tab | Same as Enter and Shift+Enter |
| Open its list | Tables only: `<table>_list.do` (the row itself opens the table definition) |
| Edit the script here | Script kinds. On the open record: the in-place editor. Otherwise: opens the record and then the editor (below) |
| Where is this used | Script Include: the Change impact panel. UI script, UI macro, UI page, email script, widget, provider, event, table, role, property: the code search. Dictionary field: field usage. A Business Rule that is open: Change impact |
| Versions | Application files. On the open record: the version compare panel. Otherwise: the `sys_update_version` list for the record |
| Copy link, Copy sys_id | Clipboard |

"Open it, then edit the script" leaves a marker in `sessionStorage` (`msb_goto_edit`, valid 60 seconds, used once) and
navigates. `resumePendingEdit` runs when the palette is created on the next page and opens the editor once the page's
table AND sys_id match and it has a script field. If the record has no script field, a toast says so.
The page's own scripts can read and write that sessionStorage key too, so the marker is treated as untrusted: only
`{ table, sysId, at }` with a valid table name, a 32-hex sys_id and a time in the last minute is accepted (200 characters
at most), it is removed on first read, and the most it can do is OPEN the editor on the record that is already on
screen. It never saves anything; saving stays the user's own action in the editor.

## What it asks the instance, and how often

- Read-only, through `queryTable` (the user's own session and ACLs). Nothing is queried until the user types; opening the
  palette sends no request.
- Bare text needs 3 characters, a `kind:` prefix 2. Nothing shorter is sent. A `^` in the text, or ANY typed word
  starting with `javascript:` (each word becomes its own LIKE value), is refused before a query is built. Every typed
  word goes through `escapeQueryValue` (carets doubled, newlines gone) and `src/lib/queryGuard.js`.
- 240 ms debounce. Each keystroke cancels the previous search: requests that had not started are dropped, requests in
  flight are aborted on the wire (`queryTable` passes the `AbortSignal` to `fetch`; an abort while the body is read, or
  while waiting to retry a busy instance, ends as an `AbortError`, which the engine drops quietly, never as a toast).
- **Every row the instance returns is checked again in the browser** (`answersTerm`): each typed word must be inside the
  name or one of the other names shown (case and accents ignored). Every search column of every kind is one of those (a
  test enforces it). This is the guard against ServiceNow silently dropping a condition on a column it does not have and
  answering with the first rows of the table; it also removes rows that only matched because `_` or `%` act as SQL
  wildcards. The preview acts this out with `ui page: ignored`.
- Only a complete answer to the search still on screen is cached; an answer to a search a newer keystroke cancelled is
  never kept (it could be empty or half read).
- At most 5 requests in flight (`MAX_PARALLEL`). A bare search asks the 8 most likely kinds, 10 rows each, most recently
  changed first. If they found fewer than 3 rows in all, the next 8 kinds are tried. A named kind gets 30 rows. When a first
  page is full, the top kinds get one more request for names that START with the text (6 or 12 rows), so an exact name is
  not hidden behind a dozen rules that merely contain it.
- Results are cached per (kind, text, mode) while the palette is open, so retyping or backspacing costs nothing. While the
  next letter is typed, the rows already fetched are narrowed on the spot.
- A table that answers 400 (no such table) or 403 is skipped silently for the rest of the page session. A 404 ("No
  Record found", how some releases answer an empty result) counts as zero rows, never as a missing table. A busy instance
  (429, 503) or a network error is not held against the table. An expired session says so once and stops sending.
- Honesty: a named kind says what could not be read ("Business Rules cannot be read here") or that nothing matched ("No
  match for ..., searched business rules you can read": the Table API leaves out rows your roles cannot read without
  saying so). A bare search stays quiet about tables it could not read and says something only when every request failed
  or the session expired. Those notes do nothing on Enter and are never the default row.

## Ranking (`src/lib/goTo.js`)

Text match, best first: exact name (1000) > starts with (800) > a word start (640) > the typed words in order at word
starts (600) > contains (480) > the words in order (440) > the words in any order (380) > fuzzy (250+). Separators do not
matter for exact and starts-with (`incident closed` equals `Incident_Closed`). One- and two-letter words only count at a
word start. A match on the API name, widget id, user name or e-mail counts 4% less than the same match on the name. Then:

- **Custom over platform**, up to +80: `customness()`. An `x_` scope is custom; `sn_`, `com.`, `sys_` scopes are platform;
  in the global scope a row created by `system` or `maint` is platform, by `admin` is 0.4, by any other user is custom;
  platform content a real user edited since gets +0.2. There is no cheap flag for "shipped by ServiceNow" on the row (a
  `sys_customer_update` lookup would be one request per record), so this is a heuristic.
- **Recently opened** (`listRecents`): +120 for the newest, down to +25.
- **The page on screen**: a rule, client script, UI action, ACL or notification for the table of the current form or list
  +60 (+30 for a rule on `task` when the page is a standard task table). The kind of the page itself, and its siblings, are
  preferred when choosing which kinds to search.
- **Inactive**: -150 and the `inactive` badge.
- A shorter name wins a tie. The best match of every kind is always shown, up to 4 rows per kind (2 with the same name) and
  14 in all for bare text; 25 for a named kind.
- **Against the rest of the palette**: from bare text a found name scores at most 820 (`BARE_SCORE_CAP`), so the palette's
  own answers keep their place: a record number, sys_id or @user (1000), and the table navigation (`Incident list`,
  `New Incident`, 830 to 900). Typing `incident` opens the incident list on Enter, as before; the ACLs and rules named
  `incident` follow. Names still come before a loose match on a command title (740 at most). After a kind prefix there is
  no cap.
- Names are shown as text only (`textContent` and `<mark>`), cut with an ellipsis when long. Bidi override and isolate
  characters (U+202A to U+202E, U+2066 to U+2069) are dropped from names and hints, so a name cannot display its letters in
  another order ("gpj.exe" stays "gpj.exe"); right-to-left text itself is kept.

## Assumptions to check on a real instance

The Self-check panel reads `src/lib/requirements/goto.js` (generated from the catalogue, registered in
`src/lib/requirements/index.js`). Every column used in a condition is one the platform has had for years; columns that are
only read are left out by the Table API when they do not exist, and the row just shows less. Should a searched column be
missing after all, the browser-side check (`answersTerm`) keeps the table's arbitrary rows off the screen; the kind then
shows "No match" instead of wrong results.

- Tables and the columns searched: `sys_script` (name), `sys_script_include` (name, api_name), `sys_script_client` (name),
  `sys_ui_action` (name), `sys_ui_policy` (short_description), `sys_ui_script`, `sys_ui_page`, `sys_ui_macro`,
  `sysauto_script`, `sys_script_fix`, `sys_security_acl` (name), `sysevent_email_action` (name), `sys_script_email`,
  `sysevent_register` (event_name), `sysevent_script_action`, `sys_transform_map`, `sys_ws_definition` (name, service_id),
  `sp_widget` (name, id), `sp_page` (title, id), `sp_angular_provider`, `sys_db_object` (name, label), `sys_dictionary`
  (element, column_label, and `name` for `table.column`), `sys_properties` (name), `sys_user_role`, `sys_user_group`,
  `sys_user` (user_name, name, email), `sc_cat_item`, `sys_app` (name, scope), `sys_update_set`.
- **Less sure, read only**: `sys_hub_flow.type` and `.status`, the table `sys_hub_action_type_definition` (Flow Designer
  actions), `wf_workflow`, `sys_script_email`, `sys_ws_definition.base_uri`, `sp_angular_provider.type`. If a table is
  missing or not readable that kind is skipped. Subflows are rows of `sys_hub_flow`, so `flow:` finds both and shows the
  `type` when the column exists. A flow row opens its form (`sys_hub_flow.do`), not the Flow Designer canvas.
- Rows are read with `sysparm_display_value=all` so references show their name (the ACL operation, the scope). The scope
  code is read as `sys_scope.scope` (a dot-walk in `sysparm_fields`). If the instance does not return that key, the scope
  shown is `global` for the global scope (its sys_id is literally `global`) and the application name otherwise, and the
  custom-or-platform guess falls back to the creator.
- `sys_class_name` is used as the table of the link when it is a valid table name (a catalog client script lives in
  `catalog_script_client`).
- Every query orders by `sys_updated_on`, a column every table has; the follow-up orders by the shown name.
- The value of a system property is never requested.

**Platform behaviour to confirm live** (each is handled the safe way in code, but none was seen on a real instance):

- A user who cannot read a table at all: does the Table API answer 403 (the kind says "cannot be read here") or 200 with
  no rows (the kind says "No match ... you can read")? Both are honest; only the first names the cause.
- An empty result answered as 404 "No Record found" on old releases: treated as zero rows.
- LIKE and case: the instance's database collation decides; on the usual case-insensitive collation `closed` finds
  `Closed`. The browser check folds case and accents only, so a collation that equates other letters (for example `ss`
  and `ß`) finds a row the palette then hides.
- A typed word that contains `=`, `<` or `>` after a kind prefix (`br: a=b`) goes into `nameLIKEa=b`; if the encoded-query
  parser reads that operator differently, the condition is dropped and the browser check shows "No match".
- `table.column` (`incident.state`) searches `sys_dictionary` rows of that table only: a column inherited from `task`
  (`state`) is not found under `incident`. `acl: incident.state` finds the field ACL.
- `sys_db_object.super_class` is shown with its display value, which is probably the label (`extends Task`).
- A flow opens its `sys_hub_flow` form, not the Flow Designer canvas; a widget opens its form, not the Widget Editor.
- Several ACLs with the same name and operation (for example two `incident` read ACLs) look the same in the list; the
  hint does not show their roles or condition.

## Known limits

- A bare search covers 8 kinds (16 when it finds almost nothing); use `kind:` for the rest.
- Page relevance knows the standard task tables only; it does not read the table hierarchy.
- The preview's own fixtures answer some of these tables with fixed rows (the portal fixture answers every query on
  `sp_widget`, `sp_page` and `sys_script_include`), so `preview/fixtures/goto.js` answers the palette's name searches
  and nothing else. It is registered in `preview/fixtures/index.js` ahead of those fixtures.
  `?palette=open&prefill=widget:%20hostile` shows hostile names (markup, a right-to-left override, Arabic, 500
  characters); `?palette=open&prefill=ui%20page:%20ignored` acts out an instance that ignores the condition.

## Review fixes (2026-10-23)

| Severity | What was wrong | Fix and test |
| --- | --- | --- |
| High | Typing a table name (`incident`) put ACLs and rules named `incident` above `Incident list` (go-to scores up to 1090, table navigation 900) | `BARE_SCORE_CAP` (820) for bare text; test "from bare text a name never outranks the incident list" |
| High | A row was shown even when none of its names held the typed text (score fallback 200), so a silently ignored condition would have listed arbitrary records as matches | `answersTerm` re-check in the engine; tests "every column a kind searches...", "when the instance ignores the condition..." |
| Medium | An abort while the body was read made `queryTable` return `[]`, and the engine cached that as "nothing matched" for the term | `readJson` rethrows `AbortError`; the engine caches only answers to the current search; two tests |
| Medium | `closed javascript:x` passed the check (only a leading `javascript:` was looked for), then failed inside the engine and was reported as "the instance did not answer" | every typed word is checked; test |
| Medium | A 404 marked the table missing for the whole page session | 404 is zero rows; test |
| Low | The "open it, then edit" marker matched on sys_id alone and was parsed whatever its size or shape | table and sys_id must match, exact shape, 200 characters; test |
| Low | A cancelled request waiting out a Retry-After (up to 5 s) held one of the five request slots | the wait ends on abort; test |
| Low | A provider answer arriving while the actions menu was open redrew the list and could close the menu under the keys | the redraw waits until the menu closes (`commandPalette.js`) |
| Low | Bidi override characters let a name display its letters in another order | dropped from names and hints; test |
| Low | Notes lower-cased acronyms ("Searching acls", "ui pages") | `inSentence`; test |

The `npm run a11y` critical `aria-allowed-attr` on palette options reported earlier did not reproduce: axe finds no
serious or critical issue with go-to rows on screen or with the actions menu open (light and dark).
