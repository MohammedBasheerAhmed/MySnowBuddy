# Data model map

Opens with `/map`, `/dotwalk`, `/path` or `/schema` (also from the command palette: "how are these tables related", "how do I get from incident to the caller's department"). Read-only: it only reads `sys_db_object`, `sys_dictionary` and (optionally) `sys_m2m`, with the user's own session.

## What it is for

Exploring an unfamiliar data model is slow: tables extend each other, reference each other through dozens of fields, and nothing shows the picture. This panel shows it, and answers "how do I dot-walk from table A to table B" (for example incident to the caller's manager's department).

Three tabs:

- **Map** of one table (the page's table, or `/map incident`, or whatever you type). Facts (label, scope, extensible, row count), the extends chain up, the child tables (direct count and all levels), the reference fields it holds (inherited ones marked with the table that defines them), and the fields on other tables that point at it or at one of its parents. Shown as a **diagram** (SVG, incoming on the left, the table in the middle with parents above and children below, outgoing on the right; click a table to re-centre, Back returns; hover highlights the connected lines; zoom and Fit width; scrolls sideways at 380 px) and as an equivalent **list** (the source of truth: searchable, keyboard operable). A toggle hides system tables (`sys_*`, `syslog*`, `sysevent*`, `sysauto*`) from the incoming side; it starts on unless the table itself is a system table. Link tables (many to many) are listed. "Copy as Markdown" copies the list.
- **Path finder** (`/path incident sys_user`, or two pickers with type-ahead). Shortest dot-walk paths of up to four steps, grouped into routes (same tables in order, different field names). Per path: the dot-walk string, a GlideRecord line, a `getElement` line, a Table API `sysparm_fields=` fragment and an encoded-query condition, each with a Copy button, with a choice of the field to read at the end (default: the display column). "Look for longer paths" adds one step. When nothing is found the other direction is tried and said so. Paths through list fields or generic (document id) fields are reported but never walked.
- **Dot-walk** explorer: every field of the table; reference fields expand lazily into the target table's fields; click a name to copy its dot-walk path; filter box.

## Services for other features (src/content/dataModel.js)

All names start with `dataModel`. The ones other features can use:

- `dataModelFieldTree(table, depth)` - the field tree to `depth` levels (1 to 4): `{ table, depth, fields: [{ name, label, type, kind, target, definedOn, inherited, children? }], truncated }`. `kind` is `'reference'` (walkable, has `children` when depth allows), `'list'`, `'generic'` or `''`. Reads at most 300 tables, batched.
- `dataModelResolvePath(table, 'caller_id.manager')` - `{ ok: true, table: 'sys_user', trail }` or `{ ok: false, error }`. This is what a script-editor autocomplete needs to offer dot-walk completions after `current.caller_id.`.
- `dataModelFields({ table })` - every field of a table with inheritance, for a field picker.
- `dataModelFindTables(term)` - table-name type-ahead.
- `dataModelLoad`, `dataModelLinkTables`, `dataModelFindPaths` (with `isCancelled` and `onProgress`), `dataModelReset`.

Pure logic is in `src/lib/dataModel.js` (hierarchy, inherited fields, incoming/outgoing grouping, layout, the path search written as a stepper, snippet builders, field tree), tested in `tests/datamodel.test.js`.

## How it reads the instance

- `sys_db_object`: `name, label, super_class.name, sys_scope.scope, sys_scope.name, is_extendable` (the same columns the Table explorer uses), by `nameIN` in batches of 40; the parents of the batch next, one query per level. Children: `super_class.nameIN...` one query per level (up to six levels, 800 tables).
- `sys_dictionary`: `nameIN<up to 30 tables>^elementISNOTEMPTY^active=true^internal_type=reference^ORinternal_type=glide_list^ORinternal_type=document_id` for the reference columns (outgoing, and every step of the path search), or without the type condition for the explorer. Incoming: `referenceIN<table and parents>^internal_type=reference^ORinternal_type=glide_list...`, ordered by name and element, paged 500 at a time up to 4000 rows. Never one query per column or per table.
- `/api/now/stats/<table>` for the row count; `sys_m2m` (no column names assumed) only to mark a link table as "listed in sys_m2m".
- Loads run one at a time and are cached for the life of the page (Refresh forgets them). A path search reads at most 300 tables; at most 40 variants per end table and 5000 paths per step are kept, and on the last step only paths that can still reach the target are built (a wide schema used to build a few hundred thousand). When a limit cut something, the panel says so.
- A dictionary read is capped at 5000 rows. Rows come ordered by table, so a 30-table read that fills the cap was cut part way and the last tables would have been stored as having no columns; such a read is now repeated in halves instead of stored.
- "No path" is only said as a fact when the dictionary was readable and nothing was cut short. Otherwise the panel says "No path found ... the search did not read every table, so a path may still exist", and it names how far the other direction was searched (up to 3 steps) instead of claiming "in either direction".

## Assumptions to check on a real instance

These could not be checked live (the PDI session was logged out when this was built). They are also in `src/lib/requirements/datamodel.js` for the Self-check panel.

1. `sys_dictionary.reference` holds the **table name** (for example `sys_user`) for reference and glide_list columns, and `sys_dictionary.internal_type` returns `reference`, `glide_list`, `document_id` with `sysparm_display_value=false`. (`src/lib/refGraph.js` already relies on both.)
2. `document_id` columns have no `reference`; `sys_dictionary.dependent` names the column that holds the table name (read as optional; shown as "table in <column>").
3. `domain_id` (`sys_domain`) and `sys_class_name` columns are deliberately not treated as references. Fields named `sys_scope`, `sys_domain`, `sys_package` and tables `sys_scope`, `sys_package`, `domain`, `sys_db_object`, `sys_glide_object`, `sys_user_preference` are skipped as intermediate steps of a path (they connect to everything); they still count when they are the target.
4. `sys_db_object` readable by the user, with `super_class.name`, `sys_scope.scope`, `sys_scope.name`, `is_extendable`. Without read access to `sys_dictionary` (normally admin) the panel says so ("Your user cannot read sys_dictionary") instead of showing an empty map; a canary read of `sys_user` columns decides that.
5. `sys_m2m` is optional. Link tables are found by the rule "two to four reference fields (not counting scope and domain), at least one pointing at this table or a parent". For a table with more than 60 referring tables (sys_user) this is done on a button, not automatically.
6. Row count for a table includes its child tables (the Aggregate API counts the hierarchy). The panel says "(with child tables)" when the table has children.
7. `GlideRecord` line: the property chain `gr.caller_id.manager.name.toString()` (what server scripts use to dot-walk) and `gr.getElement('caller_id.manager.name').toString()`. `gr.getValue('a.b.c')` is **not** offered: `getValue` does not reliably dot-walk. Please confirm `getElement` with a dotted name on the target release.

## Known limits

- Only forward paths along walkable `reference` fields; list fields and document ids are listed but not walked. A path ends at a table that is the target or extends it ("viaChild" is said in the panel).
- Incoming references are grouped by the table that holds the dictionary entry; a field defined on a parent (for example `task.assigned_to`) is listed under the parent, not under every child table.
- Dictionary overrides (`sys_dictionary_override`) never change the referenced table, so they are not read.
- Domain separation and per-scope table access are not modelled.
