# Update set preview problems (`/preview`, panel `previewfix`)

For a RETRIEVED update set that will not commit. After "Preview Update Set" the instance lists problems ("Missing
reference", "Collision with a newer local version", "Unknown table" ...), each in its own record with cryptic text, and
the safe action is not obvious. This panel reads those problems and says, per problem: what it means, why it happens, the
safe way out, what to check first, and which platform button to press. It never presses any button: the platform's own
Accept remote update / Skip remote update actions are on the problem record, and the panel links there.

The Ship check (`src/lib/updateSetReview.js`) is the other half: it reviews a LOCAL set before you move it. This one is the
target side.

## How to open it

- On a retrieved update set record (`sys_remote_update_set`): it opens on that set.
- On a preview problem record (`sys_update_preview_problem`): it opens on the problem's set with that problem expanded.
- `/preview <name>` (or `/problems <name>`): a name fragment or a sys_id. One match opens it; several show the picker.
- Anywhere else: the picker lists the retrieved update sets with state and how many problems each has recorded, and a
  button that works out a commit order for all pending sets.

## What it shows

1. A verdict: Ready to commit / Blocked by N problems / Not previewed yet / Preview is still running / Already committed /
   Could not read the problems. Unresolved problems count as blockers; a status it does not recognise counts as unresolved
   (it never says "ready" on a guess).
2. A checklist: each blocker with the exact next step, linking to its card.
3. A commit order (only when providers were found): which retrieved set creates what another needs, followed through the
   providers of the providers (at most 6 sets), with cycles reported.
4. Problems grouped by type, each card with the instance's own wording, a plain explanation, the provider, the collision
   comparison, the next step, links (problem record, remote update, local record, the record's version list), and a closed
   "Why it happens and the safe way out" section. Skipped / accepted problems are behind "Show N problems".
5. "Copy as Markdown": a report for the change ticket.
6. "How this was read": the columns that were found and the ones that were not.

### Problem kinds (all in `KINDS` in `src/lib/previewProblems.js`)

Missing reference, newer local version (collision), missing table, missing column, application or plugin missing, unknown
update type, deleted here, delete of a record that is not here, protected record, application version older, and "other
problem" (generic explanation plus the instance's own text and all the links) for anything else. The classifier never
throws and never hides a row.

Each kind carries a skip-safety rating (`safe` / `depends` / `risky`). Only `safe` kinds are counted in "N can be skipped
safely" (today: a delete of a record that is not on this instance).

### Finding the provider of a missing record

The instance records what is missing on the problem itself (confirmed live, see below): `missing_item` (the sys_id),
`missing_item_table` (its table) and `missing_item_update` (the update that would provide it). These come first:

1. `missing_item_update` names the providing update. It is looked up by sys_id (or by name, if the column holds an update
   name) **inside the pending retrieved sets** (`remote_update_set IN ... ^ sys_id=<id>`); found there, it is an exact
   provider ("Commit X first"). Not found there, the card says "The instance names the update that would provide it (...),
   but none of the N pending retrieved sets searched holds it" with a link to that update, never "nothing provides it".
2. `missing_item` is the sys_id searched for below; `missing_item_table` feeds the "probably data (sys_user)" hint. A
   problem with a `missing_item` is a missing reference whatever its wording.
3. Only when these are empty: the description, then the remote update's payload (below).

`available_actions` is shown as given on the card and appended to the next step: "The problem record offers: ...". Names
are shown only when the value (or its display value) has them; ids are only counted ("lists 2 actions by id only: open it
to see them"). No button name is guessed from it.

For missing references the sys_id of the missing record is searched in the `sys_update_xml` rows of the OTHER retrieved
sets that are not committed (`remote_update_set IN ... ^ nameLIKE <sys_id>`), and the result is verified in code
(`rowMatchesSearch`). The platform's usual wording, "Could not find a record in sys_user_group for column assignment_group
referenced in this update", names the table and the column but **not** the sys_id, so for those the remote update's
payload is read (`sys_id`, `payload` only, at most 30 updates, 10 per request) and the sys_id(s) in that column are taken
from it (`referencedIds`); nothing else of the payload is kept. When that read fails the card says the column could not
be read instead of "nothing provides it".

For a missing column, the dictionary update `sys_dictionary_<table>_<column>` is searched (also from the bracketed
`(incident.u_field)` form). For a missing table, `sys_dictionary_<table>_null` (the table's own entry, written when the
table is created) is an **exact** match; any other `sys_dictionary_<table>_...` entry only adds a column, and the same
prefix also matches the columns of a longer table name (`u_x` against `u_x_y`), so those are *probable* only: they are
shown as "Possible provider", never turned into "Commit X first", never counted in the verdict and never used for the
commit order. Nothing found is said in words: "none of the N other sets creates it; probably missing from the source's
update set", or "probably data (sys_user), which update sets do not carry" when the text names a data table. If the
search could not run, the card says that instead of "nothing provides it" (`providerState`).

### Collisions

For an open collision (first 12): the local record's `sys_updated_on` / `sys_updated_by`, the latest local
`sys_update_xml` entries (for the update set that holds the local change), the latest `sys_update_version` rows, and the
remote update's own author and time, taken from its payload (`sys_updated_on` / `sys_updated_by` inside the XML; nothing
else of the payload is kept). Every time compared is a **stored** value (UTC, `YYYY-MM-DD HH:MM:SS`): the record is read
without display values and the version and update rows use the `value` half of `sysparm_display_value=all`, because a
display value is in the viewer's time zone and date format and would shift the comparison by the viewer's offset. The
text labels the times "UTC"; a value in any other format is shown but not compared. The text says how much newer the local copy is, or that the remote one is newer (so the
platform is probably flagging something other than age). The link goes to the record's version list, where the platform's
own Compare lives; there is no deep link into a diff.

## Confirmed live 2026-10-23 (Table API on the user's PDI)

- `sys_update_preview_problem` columns are exactly `available_actions`, `description`, `missing_item`,
  `missing_item_table`, `missing_item_update`, `remote_update`, `remote_update_set`, `status`, `type` (plus the `sys_`
  bookkeeping). `remote_update_set` references `sys_remote_update_set`, `remote_update` references `sys_update_xml`. There is
  no severity column (the `type` value carries it).
- `sys_remote_update_set` columns: `application`, `application_name`, `application_scope`, `application_version`,
  `collisions`, `commit_date`, `deleted`, `description`, `inserted`, `name`, `origin_sys_id`, `parent`, `release_date`,
  `remote_base_update_set`, `remote_parent_id`, `remote_sys_id`, `state`, `summary`, `update_set`, `update_source`,
  `updated`. There is **no** `loaded` column (the panel used it for "loaded on"; it now uses `sys_created_on` and reads
  `commit_date`). `parent` exists: a set inside an update set batch says so, with a link to the batch parent.
- That PDI had **no** retrieved update set, so no VALUES were seen: the type of `missing_item_update` (a reference to
  `sys_update_xml`, or an update name; both are handled), the format of `available_actions`, the `status` values and the
  description wording below are still unverified. Only the fixtures exercise them.

The code still discovers the problem columns from `sys_dictionary` at run time (by what a reference points at, then by
name), so an older release without the `missing_item*` columns falls back to the description and payload without a
warning, and a release without `remote_update_set` says the problems cannot be listed.

## Assumptions that need a live-instance check

These are the things the panel could not verify. The first group has a runtime safety net; the second does not.

**Discovered at run time, degrade gracefully**

- `sys_update_preview_problem` column roles (names now confirmed, above). Found from `sys_dictionary` by what a reference
  points at (a reference to `sys_remote_update_set` is the set column, a reference to `sys_update_xml` the update column;
  `missing_item_update` is never taken as the update column), then by name. If the dictionary cannot be read, one row is
  read with all columns and the roles are taken from the names. Only the set column is essential; without the others the
  panel says what it could not show ("How this was read" lists what was found).
- `sys_update_xml.remote_update_set` exists (checked in the dictionary before any query that uses it: a condition on a missing
  column would silently match every row). If not, providers and local update entries are skipped with a visible note and each
  card says the search could not run.

**Assumed, not checkable by the panel**

- The wording of problem descriptions and types. Every classifier rule is a loose pattern; verify with real problems that
  each of the common kinds lands in the right group (see the `CASES` list in `tests/previewproblems.test.js` for the
  strings that were used). The type column may hold a severity ("Error" / "Warning") instead of a kind; that is handled
  (the description decides the kind).
- Status values: `skipped` -> skipped, `ignored` -> **ignored** (its own status), `accepted` -> accepted, `resolved` /
  `fixed` / `done` -> resolved, empty or "unresolved" / "open" / "new" -> unresolved, anything else -> "Status unclear",
  counted as unresolved. "Ignored" is believed (not verified) to be what **Accept remote update** writes: the problem is
  set aside and the remote update IS committed. It used to be read as "skipped", which would have told the developer the
  local record stays as it is when the opposite happens; the panel now says "Ignored: no longer blocks the commit;
  Accept remote update normally records this" and suggests opening the record to be sure. Check on a live instance which
  value each button writes.
- The wording used for the classifier and the clue reader: "Could not find a record in <table> for column <column>
  referenced in this update" (missing reference, no sys_id in the text), "Found a local update that is newer than this
  one" (collision), "Could not find a table field (<table>.<column>) referenced in this update" (missing column). These
  are from memory of real instances, not verified for this release; the preview fixture uses them.
- `sys_remote_update_set.state` values (`loaded`, `previewing`, `previewed`, `committing`, `committed`), read by word.
  Update set batches: a child set is flagged, but the batch as a whole is not analysed.
- Update names follow `<table>_<sys_id>` (also assumed by `parseUpdateName` in the Ship check), and dictionary updates are
  named `sys_dictionary_<table>_<element>`. A missing record whose update uses another naming is not found as a provider.
- The platform's buttons are called "Accept remote update" and "Skip remote update" (the wording in this panel follows the
  assignment); the problem record is where they live.
- Whether the platform lets a commit proceed with unresolved warnings differs between releases; the panel treats every
  unresolved problem as a blocker, which is the safe reading.
- `sys_update_version.source` reads as the update set the version came from; only used for display.

## Read-only and safe

Nothing is written. Instance text is rendered by React (escaped); the only values that reach a URL or query are sys_ids
validated as 32 hex characters, and table and element names validated as identifiers. Problem descriptions pass through
`redactSecrets` (they are shown, copied and may be sent to the assistant when the user clicks "Ask the assistant"). The
payload of a remote update is read only for the two stamp fields above and dropped.

## Limits

- At most 1500 problems per set; 30 distinct references searched per load; the 60 most recently updated other retrieved
  sets searched; local copy compared for the first 12 collisions; at most 6 sets followed for the commit order. Each limit is
  shown in the panel's "Not checked or incomplete" box when it is hit.
- Update set batches (a parent set with children) are not modelled: each retrieved set is looked at on its own.
- The explanations are guidance. A problem that sits behind a platform rule NowBuddy does not know is shown with the
  instance's own text, never rewritten.

## Files

`src/lib/previewProblems.js` (pure logic), `src/content/previewProblems.js` (reads), `src/sidebar/PreviewProblemsPanel.jsx`,
`src/sidebar/previewfix.css`, `tests/previewproblems.test.js`, `preview/fixtures/previewProblems.js` (fake instance for the
preview harness; `?open=previewfix`, variants `ppvariant=nodict|denied|noprovider`), `src/lib/requirements/previewProblems.js`
(what the Self-check panel tests).

## Verifying live (about five minutes)

1. Retrieve two update sets where one depends on the other, preview the dependent one, open `/preview`.
2. Compare the verdict with the platform's own list of problems: counts, kinds, statuses.
3. Open "How this was read": the found columns should be `remote_update_set`, `remote_update`, `type`, `description`,
   `status`, `missing_item`, `missing_item_table`, `missing_item_update`, `available_actions` (only severity is expected to
   be "not found"). Note what a real `available_actions` and `missing_item_update` value looks like (open a problem record
   and the list with those columns) and which `status` value each of the record's buttons writes.
4. For a missing reference, confirm the provider shown is the set that actually contains the record.
5. For a collision, confirm the local author and time against the record's version list.
6. Self-check (`/doctor`) lists the tables and columns this feature reads.
