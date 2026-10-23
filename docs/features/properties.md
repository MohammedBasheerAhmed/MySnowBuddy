# System properties (`/prop`)

Find a system property, read it (and what it means), see which scripts read it, change it for a test and put it back.
Panel name `properties`, slash `/prop` and `/property`, icon `sliders`. The palette verb `/props` is a separate, older
shortcut that opens the plain `sys_properties` list; it is untouched.

Files: `src/lib/properties.js` (pure rules, unit tested), `src/content/properties.js` (reads from the instance, services
`propertyExplorer*`), `src/sidebar/PropertiesPanel.jsx` and `properties.css`, `tests/properties.test.js`,
`preview/fixtures/properties.js`, `src/lib/requirements/properties.js` (for the Self-check panel).

## What it does

1. **Find.** Type part of a name, description or value (or paste `gs.getProperty('x_acme.timeout', '30')`: the name inside
   is used). Results are ranked (exact name, name starts with, name contains
   every word, description, value) and show value, type, scope and description. `/prop glide.ui` pre-fills the search. An
   exact name (`/prop glide.ui.session_timeout`) opens that property. When the page on screen is a `sys_properties`
   record the panel opens on it.
2. **Read.** Type-aware value (true/false chip, number, choice list, long text in a scrollable box), type, choices,
   application, description, suffix, private flag, read and write roles when the instance has those columns, last
   updated by and on. A link opens the record in the platform.
3. **Who reads it.** On request (one button, about 19 queries): the active scripts that contain the name, read closely
   and classified as *Sets it* (`gs.setProperty`), *Reads it* (`gs.getProperty`, `GlideSystem.getProperty`,
   `GlideProperties.get`) or *Mentions it* (a log line, a comparison, a name in a variable never passed to a property
   call). A name held in a variable (`var KEY = '...'; gs.getProperty(KEY)`) is followed to the call. The default a read
   passes (`gs.getProperty('x', '30')` shows `default '30'`) is shown. Occurrences inside comments are skipped and counted.
   The summary says how many tables were searched, whether any table returned a full page (so there may be more), and
   which tables could not be searched. If NO table could be searched, it is an error, never "no script uses it".
4. **Change it, safely.** A switch (true/false), a number box, a select (choice list) or a text box, by the property's
   type. On a production or unrecognised instance (`policy.instanceGuard`: only a host positively named dev, test or
   stage is not guarded) changes and restores stay **locked until the instance name is typed** in the box at the top of
   the panel (`writeUnlock`), the same rule as My work and Push; the confirmation is then red with Cancel focused.
   Pressing Change reads the property again, asks (`askConfirm`) with the name, the old value, the new value, the
   instance and the update set, and **reads it once more after the yes**: if the value moved while the dialog was open,
   nothing is written and the panel says so (no silent overwrite, and Restore keeps the right original). The value
   written is exactly the one confirmed. Only a real click on Change or a real Enter in the box applies (a submit event
   is not trusted: the browser fires a trusted one even for a script's `requestSubmit()`). A value that looks like a
   credential (URL with a password, bearer token, key format) is refused: it would land in the audit log and then be
   hidden. The confirmation also names the current update set: a property is configuration, so the
   change is captured in the set and travels with it to the next instance (the Default set gets a stronger warning).
   The write goes through `services.agentExecute('update_record', ...)`, the path the Test
   data panel uses, so the write policy, the dictionary check and the audit log with undo apply. The panel reads the
   property back afterwards and says so if the instance holds something other than what was written.
5. **Restore.** Every change is remembered (`chrome.storage.local`, per instance, 30 entries) with the value before the
   FIRST change. The panel shows "Changed from this panel" with "You changed this at 14:32 - restore?" at the top of
   every view until it is restored. Restore asks first, reads the live value, and says when somebody changed it since.
6. **Developer switches.** Nine properties developers often check or flip, each with one plain sentence about what it does
   and one about when to be careful. Each is looked up; a missing one shows "not present on this instance". Nothing is
   ever created.
7. **Compare.** If other instances are saved in Options: "Compare with <instance>" reads the same property there (the
   existing cross-instance record compare, `compareWithInstance`) and says same / differs, with the two values.

## Secrets

A property is hidden when its `type` contains password or encrypt, when its **name** contains password, secret, token,
key or credential (a few harmless words such as keyboard and keyword are exempt), or when its **value** contains
something the redactor would hide (a URL with a password, a bearer token). For a hidden property the value is dropped in
`toProperty()` before it leaves the content script, so the panel cannot show or copy it; it cannot be edited, compared or
sent to the AI; and searching for text never matches a hidden value. Name, type, description and the Who-reads-it search
still work, but for a hidden property (by name, or by type alone, looked up first; when it cannot be looked up it is
treated as secret) the script lines are masked: every literal except the name is replaced, nothing after the name is
kept, and the default a read passes or the value a script sets is never shown (`maskSecretLine`, `usage.masked`). Every
usage line, secret property or not, goes through the redactor, and a very long (minified) line is shown around the match.
Because the name rule is broad, properties such as `glide.user.password.*` settings are hidden too; open the
record in the platform for those.

## Assumptions that need a live-instance check

None of these could be checked against a live instance when this was built (the PDI was logged out).

- `sys_properties` columns `name`, `value`, `type` exist (certain). `description`, `choices`, `suffix`, `is_private`,
  `read_roles`, `write_roles`, `sys_scope`, `sys_updated_on`, `sys_updated_by` are asked for in every read (an unknown
  column is simply left out of the answer). A probe read of 10 rows (the union of their keys) decides only which columns a
  search CONDITION may use: a condition on a missing column is ignored by the instance (it matches every row), so the
  description is searched only when the `description` column came back. Not live-checked: whether a field ACL on
  `value` makes the Table API leave the key out (the panel then says "unreadable") or return it empty (it would then show
  "(empty)"). Before the 2026-10-23 review the probe read ONE row and dropped every column that row lacked from all later
  reads, so one private property first in the table could make every property "unreadable".
- `type` stored values: `boolean`, `integer`, `choicelist`, `color`, `string`, `password2` or `password`, `image` and so on.
  Anything unknown is treated as a string. A string property whose value is exactly `true` or `false` is offered as a switch.
- `choices` holds a comma separated list of values for `choicelist` properties.
- `sysparm_display_value=all` returns `{ value, display_value }` for each field, and a dot-walked `sys_scope.scope` comes back
  under that key. If not, the application name (`sys_scope` display value) is shown instead.
- Query shape: `nameLIKEa^ORdescriptionLIKEa^ORvalueLIKEa^nameLIKEb^OR...` means (any field has a) AND (any field has b).
- `update_record` on `sys_properties` with `fields: { value }` works for the user (an admin, or a role with write access) and
  is not blocked by the user's guardrail settings. Failures are shown as the error text.
- Script tables searched besides the shared code search: `sys_script_fix.script`, `sys_script_email.script`,
  `sys_ui_page.html/client_script/processing_script`, `sys_ui_macro.xml`, `sys_dictionary.default_value/calculation`.
  `active=true` is used only on macros and dictionary entries, where the column certainly exists. Fix scripts are not
  filtered (whether `sys_script_fix` has an `active` column is not certain, and with
  `glide.invalid_query.returns_no_rows` on, a condition on a missing column would return nothing). The usage summary
  still says "active records only", which is true of the shared code search tables, not of fix scripts, email scripts
  and UI pages.
- The typed unlock uses the first label of the host (`acmeprod` for `acmeprod.service-now.com`), as My work does.
- The developer switches exist on a standard instance: `glide.ui.session_timeout`, `glide.invalid_query.returns_no_rows`,
  `glide.email.smtp.active`, `glide.email.read.active`, `glide.email.test.user`, `glide.servlet.uri`, `glide.sys.default.tz`,
  `com.glide.attachment.max_size`, `sn_atf.runner.enabled`. The panel reports a missing one; it never fails on it.
- A change to a `sys_properties` record through the Table API is captured in the user's current update set (the property
  table is configuration). The confirmation says so on that assumption; if properties are excluded from capture on some
  instance the sentence is merely over-cautious. The current update set comes from `/api/now/ui/concoursepicker/updateset`
  (`getCurrentUpdateSet`); when it cannot be read the confirmation says that instead.
- `compareWithInstance` matches the other instance's record by sys_id and then by name, and returns the fields that differ
  as `{ name, before (here), after (there) }`.

## Known limits

- A property name built up in code (`'prefix.' + key`), or read in a Flow Designer action, a workflow activity, a
  notification's conditions or any record that is not a script field, is not found. The panel says so under the results.
- Only active scripts are searched, at most 100 matches per table. A table that returns a full page is named in the summary.
- The nudge lives in the panel. It does not pop up when the panel is closed (follow-up idea: a small toast on page load
  when an unrestored change is older than an hour).
- Tested in the preview harness with a fake instance; the write path was driven with the preview's fake `update_record`
  replaced by a call to the fixture, because the shipped preview fake does not write.
