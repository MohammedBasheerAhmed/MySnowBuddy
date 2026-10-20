# NowBuddy local MCP bridge

Lets an external AI agent (Claude Code or any MCP client) call NowBuddy's ServiceNow tools through your own logged-in browser tab.

```
MCP client  <--stdio-->  snowbuddy-mcp.js  <--http 127.0.0.1-->  NowBuddy extension  -->  your ServiceNow tab
```

`snowbuddy-mcp.js` is a single dependency-free Node (>= 18) script. The MCP client launches it as a stdio server; it also listens on `127.0.0.1:17345` (override with `MYSNOWBUDDY_PORT`) for the extension.

## Setup

1. Register the server with your MCP client. The first run creates the pairing token.

   Claude Code, Windows:
   ```
   claude mcp add mysnowbuddy -- node D:\MySnowBuddy\mcp\snowbuddy-mcp.js
   ```
   Claude Code, macOS / Linux:
   ```
   claude mcp add mysnowbuddy -- node /path/to/MySnowBuddy/mcp/snowbuddy-mcp.js
   ```
   To use another port: `claude mcp add mysnowbuddy -e MYSNOWBUDDY_PORT=18000 -- node ...` and set the same port in the extension options.

   Generic MCP client JSON config:
   ```json
   {
     "mcpServers": {
       "mysnowbuddy": {
         "command": "node",
         "args": ["D:\\MySnowBuddy\\mcp\\snowbuddy-mcp.js"],
         "env": { "MYSNOWBUDDY_PORT": "17345" }
       }
     }
   }
   ```

2. Read the token from `~/.mysnowbuddy/mcp-token` (`%USERPROFILE%\.mysnowbuddy\mcp-token` on Windows). The server also prints the file path on stderr at start.
3. In the browser: NowBuddy options > Agent > Local MCP bridge. Enable it and paste the token (and the port if you changed it).
4. Keep a `*.service-now.com` tab open and logged in. Ask your agent to call `snowbuddy_status` to confirm the link.

Tool calls go to the active ServiceNow tab of your focused window, otherwise the most recently used ServiceNow tab. Every tool also accepts `instance` (for example `dev12345.service-now.com`) or `tab_id` (from `list_tabs`) to pick a specific tab.

## Control ServiceNow from Claude Code (quickstart)

1. Do the setup above, open your instance in Chrome and log in.
2. In Claude Code, run `/mcp` and check that `mysnowbuddy` is connected, then ask it to call `snowbuddy_status`.
3. Ask for what you want. The agent works in a loop: `read_page` / `get_instance_info` to see where it is, `navigate` to open a list or record, act, then `read_page` or `query_table` to verify. Anything that runs or changes something pops up an approval card in your browser tab; on a production (or unrecognised) instance you also type the instance name.

Example prompts:

- "What am I looking at? Summarise the open record, its UI actions and any error messages."
- "Which update set and application am I in? Switch to the in-progress update set STRY0012345."
- "Open the active P1 incidents assigned to Network and list number, short description and assignee."
- "Set the state of INC0010023 to In Progress and add 'Investigating' to its work notes." (update_record, with a before/after diff to approve)
- "Resolve the incident that is open in my browser." (click_ui_action on the Resolve button, then it reads the page back)
- "Run the ATF suite 'Smoke tests' and tell me which tests failed."
- "Impersonate abel.tuter, open the incident list and tell me whether he can see INC0010023, then end impersonation."
- "Write a background script that deactivates users who never logged in; dry-run it first and show me what it would change."
- "Take a screenshot of the ServiceNow tab." (needs the toolbar-icon click described below)
- "Undo that." (undo_last_write restores the previous values, deletes a created record, re-inserts a deleted one, or switches the update set back)

## Tools by tier

Tiers decide what needs your approval. A permission ceiling (NowBuddy options > Agent > Local MCP bridge > "What an external agent may do") hides tools above the chosen tier from the MCP client and refuses them if called anyway; it is checked in the service worker and again in the page. The default is "Everything, with approval", the behaviour before the ceiling existed.

| Tier | Approval | Tools |
| --- | --- | --- |
| observe | none, runs at once | `read_page` (structured screen snapshot), `navigate` (open a list, record, new-record form or page; refuses to leave unsaved changes), `get_instance_info` (host, environment, build, user, roles, update set, scope), `get_page_context`, `get_form_model`, `get_field_state`, `get_schema`, `query_table`, `count_records`, `read_artifact`, `list_logic_for_table`, `search_code`, `read_logs`, `lookup_api`, `get_skill_guide`; MCP only: `screenshot`, `list_tabs` |
| draft | none (no side effects) | `verify_script`, `test_client_script` |
| run | approval in the browser (typed name on PROD for ATF) | `dry_run_script`, `run_atf` (with only `progressId` it just keeps waiting on a run and needs no approval) |
| write | approval in the browser, typed instance name on PROD | `click_ui_action`, `create_record`, `update_record`, `delete_record`, `save_artifact`, `set_form_field`, `save_form`, `run_background_script`, `switch_update_set`, `switch_application_scope`, `impersonate_user`, `end_impersonation`, `undo_last_write`, `run_ui_steps` |

Notes:

- Dry runs: on a production or unrecognised instance every dry run needs the typed instance name, and "Auto dry runs" (sidebar only) only skips the card for scripts that a strict allow-list proves read-only. The script runs outside the interception code, which reports loudly if the script replaced an intercepted method. Every dry run is in the audit log.
- `navigate` is in the observe tier because opening a view changes no data: it only opens list and form views of real tables (checked against the dictionary), Next Experience routes and portal pages, never processors (`logout.do`, `cache.do`, `impersonate.do`...) or URLs with action parameters, and it refuses to leave a classic form with unsaved changes. Leaving a workspace or portal form, whose unsaved edits NowBuddy cannot see, asks you in the tab first. It does change what your tab shows, so MCP clients see it as not read-only.
- Record writes check every column against the dictionary first. Credential tables and password fields are always refused, deleting users, tables or columns is refused, and role, ACL, property and code changes carry a warning on the card. Script fields of business rules, client scripts, script includes and UI policies go through `save_artifact`, which verifies the code.
- `run_background_script` runs for real in the global scope; its card shows the static risk analysis and whether the exact script was dry-run first. It cannot be undone.
- `switch_update_set` / `switch_application_scope` read the session back afterwards and say plainly when the switch did not take.
- When a page reloads (a submit, a top-level navigation, impersonation), the bridge waits for it and appends a short `read_page` of the new page to the result.
- `screenshot` returns a PNG (a JPEG when the PNG would be very large). Chrome only allows it after you have clicked the NowBuddy toolbar icon, or pressed Alt+Shift+C, on that tab (the `activeTab` rule); NowBuddy deliberately does not request access to all sites to avoid this. Only the visible tab of a window can be captured. Screenshots cannot be redacted, so every one is allowed by you in the tab first (an Allow/Deny card), whatever the permission ceiling. `list_tabs` returns only the tab id, host, a redacted title and whether it is active, never paths.

## Security model

- The HTTP server binds to 127.0.0.1 only. The extension only ever talks to 127.0.0.1.
- Every endpoint except `GET /v1/health` needs `Authorization: Bearer <token>`. The token is 32 random bytes stored in a file readable only by you (mode 0600 where supported) and compared in constant time.
- Requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` are refused (DNS rebinding), and so is any `Origin` that is not a browser extension. CORS allows only the calling extension's origin. Bodies are capped at 2 MB (8 MB for tool results, which can carry a screenshot).
- Run- and write-tier tools still ask you for approval in the browser; the agent cannot approve its own changes, and external agents never get "auto dry runs". Calls wait up to 3 minutes for your approval. A call the client cancels or that times out before you approve it is withdrawn from the browser (from every ServiceNow tab, even after a service worker restart) and can no longer be approved. Once you approve, the browser tells the bridge the call has started: from then on the approval timeout no longer applies, and if no result ever arrives the client is told the action may have run, never that nothing changed.
- The permission ceiling is enforced in the extension (service worker and page), not by this bridge, so a modified bridge cannot raise it.
- Nothing leaves your machine except through your own ServiceNow session and your MCP client. The bridge has no outbound network access.
- Anyone who can read the token file can drive your session, so treat it like a password. Delete the file to rotate it, then re-paste it in options.

## Generated files (optional)

`npm run build` writes `mcp/generated/tools.json` (tool snapshot, served until the extension registers so the tool list is never empty) and `mcp/generated/skills.json` (array of `{id,title,description,text}`, served as `mysnowbuddy://skills/<id>` resources).

## Troubleshooting

- `snowbuddy_status` says `bridgeConnected: false`, or calls fail with "extension is not connected": open a ServiceNow tab in a browser with NowBuddy installed, check the bridge is enabled in options, and that the pasted token matches the file. The options page shows the connection state (`connecting`, `connected`, `error`).
- "The bridge rejected the pairing token": re-paste the token, no spaces or quotes.
- "Could not start HTTP server" / EADDRINUSE: another bridge (often a second MCP client) already holds the port. Use a different `MYSNOWBUDDY_PORT` on both sides.
- "No ServiceNow tab is open": open one, or reload tabs that were open before the extension was installed.
- Calls time out after 3 minutes: an approval prompt may be waiting in the browser tab.
- "Blocked by the external-agent permission ceiling": raise the level in options > Agent > Local MCP bridge, if you want the agent to do that.
- `screenshot` says Chrome does not allow it: click the NowBuddy toolbar icon on that tab once (or press Alt+Shift+C), then ask again. The tab must be the visible one in its window.
- After idling the browser may put the extension's service worker to sleep; it reconnects within about 30 seconds (keepalive alarm).
- Logs: the bridge writes to stderr (your MCP client usually shows it, for example `claude mcp list` / `/mcp`). The extension's side is in the service worker console at `chrome://extensions`.
