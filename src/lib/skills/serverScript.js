// Server Script skill: Business Rules, Script Includes, scheduled jobs, ACLs,
// background scripts and the other server-side script types.

export const SERVER_SCRIPT_GUIDE = `# ServiceNow Server Script skill

Use this for anything that runs on the instance: Business Rules, Script Includes, Scheduled Jobs, ACL scripts, Scripted REST, Fix scripts, transform scripts, Flow script steps, background scripts.

## 1. Pick the right artifact
- React to a record insert/update/delete/query -> **Business Rule**.
- Reusable logic or a client-callable service -> **Script Include**.
- Run on a schedule -> **Scheduled Script Execution**.
- Decide access -> **ACL** (set \`answer\`); never enforce security only on the client.
- Multi-step, human-readable automation -> prefer **Flow Designer**; use script steps sparingly.
- One-off data fix -> **Fix Script / background script**, run as a **dry run** first.

## 2. Business Rule timing (get this right before anything else)
| when | use it for |
| --- | --- |
| before | validate and change \`current\` before it is saved. Do **not** call \`current.update()\`: the platform saves it. \`current.setAbortAction(true)\` stops the save. |
| after | update other records, create related records. \`setAbortAction\` has no effect now. |
| async | slow or outbound work (REST, e-mail). \`previous\` is not reliably available. |
| display | prepare data for the form (\`g_scratchpad.x = ...\`). |
Set the **condition** field instead of testing the same thing in script when you can. Keep **order** deliberate (100 default; lower runs first).

## 3. GlideRecord rules
1. \`addQuery(...)\` and \`orderBy\` **before** \`query()\`; iterate with \`while (gr.next())\`.
2. Single record by sys_id: \`if (gr.get(sysId)) { ... }\` (no \`query()\` needed).
3. Always constrain a query; add \`setLimit(n)\` if you only need a sample. Counts: use **GlideAggregate** (\`addAggregate('COUNT')\`), not \`getRowCount()\` on big results.
4. Never create a GlideRecord inside a loop (N+1). Load related records first, or use an \`IN\` query / GlideAggregate.
5. Compare values as strings: \`gr.getValue('state') === '3'\` or \`String(gr.state) === '3'\`. \`gr.state\` is a GlideElement, not a primitive.
6. Empty check: \`gr.field.nil()\` / \`current.field.nil()\`.
7. Build queries with \`addQuery(field, operator, value)\`. Never concatenate user input into an encoded query: a \`^\` in the input adds conditions (query injection).
8. \`setWorkflow(false)\` and \`autoSysFields(false)\` skip business rules/flows and audit fields. Only for deliberate bulk fixes, and say so.
9. Use \`GlideRecordSecure\` (or \`canRead()\`/\`canWrite()\`) when the user's ACLs must be honoured. Plain GlideRecord ignores ACLs.
10. \`deleteMultiple()\` and \`updateMultiple()\` are bulk and hard to undo: verify the row count with a dry run first.

## 4. Platform conventions
- Logging: \`gs.info/warn/error(message, source)\`. \`gs.log\` is deprecated in scoped apps; \`gs.print\` works only in global background scripts.
- No hard-coded sys_ids, instance URLs or credentials. Use system properties (\`gs.getProperty\`), Connection & Credential aliases, or a lookup by a stable key.
- ES5 by default (var, function, no arrows/let/const/template literals/async) unless the application is set to ES2021. No \`window\`, \`document\`, timers.
- Scoped applications: no \`Packages.*\`, limited global API; call global code through \`global.Name\`; use \`sn_ws.RESTMessageV2\` for REST.
- Dates: use \`GlideDateTime\`, not \`new Date()\`, for stored values.
- Wrap outbound calls (RESTMessageV2) in try/catch, check \`getStatusCode()\`, never log secrets.

## 5. Script Include patterns

### Class
\`\`\`javascript
var MyUtils = Class.create();
MyUtils.prototype = {
  initialize: function () {},

  getActiveCount: function (table) {
    var agg = new GlideAggregate(table);
    agg.addActiveQuery();
    agg.addAggregate('COUNT');
    agg.query();
    return agg.next() ? parseInt(agg.getAggregate('COUNT'), 10) : 0;
  },

  type: 'MyUtils'
};
\`\`\`

### Client-callable (GlideAjax target) - tick "Client callable"
\`\`\`javascript
var MyUserUtils = Class.create();
MyUserUtils.prototype = Object.extendsObject(AbstractAjaxProcessor, {
  getDepartment: function () {
    var userId = this.getParameter('sysparm_user_id');
    var user = new GlideRecord('sys_user');
    if (user.get(userId)) {
      return user.getDisplayValue('department');
    }
    return '';
  },

  type: 'MyUserUtils'
});
\`\`\`
The browser calls it with \`new GlideAjax('MyUserUtils')\` and \`addParam('sysparm_name', 'getDepartment')\`. Validate every \`sysparm_*\` value on the server and honour ACLs; the endpoint is reachable by any logged-in user.

### Business Rule skeleton
\`\`\`javascript
(function executeRule(current, previous /*null when async*/) {
  if (current.priority.changesTo('1')) {
    gs.eventQueue('incident.p1.raised', current, current.getValue('number'), gs.getUserName());
  }
})(current, previous);
\`\`\`

### ACL script
\`\`\`javascript
answer = false;
if (gs.hasRole('itil') && current.getValue('caller_id') !== gs.getUserID()) {
  answer = true;
}
\`\`\`

## 6. Testing
- Always run generated background scripts as a **dry run** (writes intercepted) and read the output before running for real.
- A Business Rule is only proven by its trigger: describe the ATF test or the record changes that fire it.

## 7. How to answer
1. Name the artifact, the table and the timing, and why.
2. Give the full script and the configuration to set (Name, Table, When, Order, Condition, Active, Advanced, Client callable, Accessible from / scope).
3. List assumptions and fields you checked with get_schema.
4. Flag risk: volume, ACLs bypassed, writes, scope. State how you verified it (verify_script, dry_run_script).
`;

export const SERVER_SCRIPT_DIGEST =
  'Server scripts: pick BR timing deliberately (no current.update() in before); addQuery before query; no queries in loops; ' +
  'string compare via getValue; GlideAggregate for counts; ES5 and no browser globals; GlideRecordSecure when ACLs matter; dry-run before real runs.';

export const SERVER_SCRIPT_SKILL = {
  id: 'server-script',
  title: 'Server Script',
  summary: 'Server-side logic: Business Rules, Script Includes, scheduled jobs, ACLs, Scripted REST, background scripts.',
  side: 'server',
  tables: ['sys_script', 'sys_script_include', 'sysauto_script', 'sys_security_acl', 'sys_ws_operation', 'sys_ws_definition', 'sysevent_script_action', 'sys_script_fix', 'sys_transform_script', 'sys_hub_action_type_definition'],
  guide: SERVER_SCRIPT_GUIDE,
  digest: SERVER_SCRIPT_DIGEST,
  tools: ['get_schema', 'query_table', 'list_logic_for_table', 'read_artifact', 'search_code', 'lookup_api', 'verify_script', 'dry_run_script', 'read_logs', 'save_artifact'],
  artifactHints: {
    sys_script: 'Fields include name, collection (the table), when, order, active, advanced, filter_condition/condition, script, action_insert/update/delete/query. Confirm with get_schema("sys_script").',
    sys_script_include: 'Fields include name, api_name, script, client_callable, active, access. Confirm with get_schema("sys_script_include").',
  },
};
