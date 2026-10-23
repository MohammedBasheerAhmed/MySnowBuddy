# Connections between the tools

Small hooks that take a developer from the answer in one tool to the tool that explains the next question. Pure logic is in
`src/lib/panelLinks.js` (tests: `tests/glue.test.js`); nothing here reads or writes anything the tools did not already read.

| From | Hook | Opens |
| --- | --- | --- |
| What went wrong? (email row) | "Why was it not sent?" | Email tracer on the failed `sys_email` record itself (its email page: what triggered it, who it was for, where it stopped) |
| What went wrong? (flow row) | "What is running on this record?" | Flows, approvals and SLAs on the flow's source record (`sys_flow_context.source_table` + `source_record`) |
| What went wrong? (event row) | "Check the email for this record" | Email tracer on the record the event was queued for (`sysevent.table` + `sysevent.instance`) |
| Script editor, Shift+F12 or References on a `gs.getProperty('x')` / `gs.setProperty('x'` name | System properties on that name | `properties` with `args` = the name; without the sidebar it falls back to the text search |
| Script editor, hover on the same name | One line "Value on this instance: ..." | Nothing opens. One read per name per editor session through `propertyExplorerGet` |
| X-ray, field detail | "What does the page do to this field at run time?" | Client trace (`args` = the field; the panel does not pre-filter yet, so the tooltip says to press Reload and record and then filter) |
| X-ray, Service Portal hover label | "Inspect" | Portal inspector filtered to that widget instance (or widget) |
| Table explorer | "Map this table", and "Path to <table>" on a reference column | Data model map (`args` = `incident`, or `incident sys_user` for the path finder) |
| Command palette | Page-aware suggestions | Tickets: flows and email first. Retrieved update sets and preview problems: Preview problems first. Portal pages: Portal inspector, X-ray, code search |
| Page toolbar on a saved ticket | "Why?" | A menu: what is running on it, why an email was not sent, why a user cannot see it, what the form scripts did (each entry follows the role tiers) |

## How a panel opens on another record

`services.openRegisteredPanel(name, { context: { table, sysId } })`. The sidebar validates the pair (a table name and a 32 character
sys_id, nothing else), gives a panel that reads the record (`withContext`) that record instead of the page's, and re-keys the panel
when the record changes. A context that does not validate is dropped and the panel opens on the page's record.

## What the hooks never do

- The property hover never asks for, and never shows, a property whose name contains password, secret, token, key or credential
  (`nameLooksSecret`), a password-type property or a value that looks like a credential (`toProperty` drops those values). A read that
  fails shows nothing. A name with no row says so with "or your user cannot read it", because an ACL answers with no rows.
- A failure row gets a button only when it names a record (a table name and a sys_id). No `source_record`, no button.

## Assumptions to check on a live instance

- `sysevent.instance` is the sys_id of the record the event was queued for (the email tracer and the process view read it the same
  way). It was added to the events probe of What went wrong? and to the self-check list; an instance without it just shows no button.
- `sys_flow_context.source_record` holds the record's sys_id and `source_table` its table name (already assumed by the process view).
- The ticket tables are a fixed list (`src/lib/ticketTables.js`: task, incident, problem, change_request, sc_request, sc_req_item,
  sc_task, the customer service and HR cases and their tasks). A custom table that extends task is not recognised, so it gets no
  "Why?" button and the plain record suggestions; the tools are still in the palette and the launcher.
- A Service Portal page is recognised from its address (one path segment with `id=`, or /sp, /esc, /csm, /hrsd, /ec) or from
  `sp-page-row` / `ng-app="$sp"` in the top document (`isPortal` on the page context).

## Role tiers added (`src/lib/roleTier.js`)

Developer: `panel.notify`, `panel.clienttrace`, `panel.datamodel`, `panel.portal`, `panel.previewfix`. Admin: `panel.properties`.
Everyone: `panel.process`, `panel.doctor` (it explains why other tools do not work for a user). These are guesses from what each
panel reads; the "Show tools by role" setting turns the filtering off.
