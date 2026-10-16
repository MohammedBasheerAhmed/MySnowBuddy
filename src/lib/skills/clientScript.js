// Client Script skill: everything the agent needs to write browser-side
// ServiceNow logic correctly. The guide is plain markdown so it can also be
// served to external agents over MCP.

export const CLIENT_SCRIPT_GUIDE = `# ServiceNow Client Script skill

Use this for anything that runs in the browser on a form, catalog item or list: Client Scripts, Catalog Client Scripts, UI Policies and their scripts, UI Scripts, client-side UI Actions.

## 1. Pick the right tool first
- Show/hide, mandatory, read-only driven by a condition -> **UI Policy** (no code, reverses itself when the condition stops being true). Only add a UI Policy script when actions are not enough.
- Needs logic, a lookup, a message or a calculation -> **Client Script**.
- A rule that must hold no matter how the record is changed (import, API, flow) -> **Data Policy** or a **Business Rule / ACL**. Client code is user experience, never security.
- Fetching other records -> **GlideAjax** to a client-callable Script Include (see server skill).

## 2. Handler signatures (the platform calls these by name)
- \`function onLoad() {}\` runs when the form loads.
- \`function onChange(control, oldValue, newValue, isLoading, isTemplate) {}\` runs when the chosen field changes **and once on load** unless guarded.
- \`function onSubmit() {}\` return \`false\` to stop the save; return nothing/true to allow it.
- \`function onCellEdit(sysIDs, table, oldValues, newValue, callback) {}\` list cell edit; **always** call \`callback(true)\` or \`callback(false)\`.

## 3. Rules that prevent the usual bugs
1. onChange starts with \`if (isLoading || newValue === '') { return; }\` unless it must run on load.
2. Never use \`GlideRecord\`, \`gs\`, \`current\` or \`previous\` in a client script. \`gs\`/\`current\` do not exist in the browser; client GlideRecord is synchronous and unsupported in Service Portal/mobile.
3. \`g_form.getReference(field, callback)\` always with a callback. Without it the call is synchronous and blocks the form.
4. \`GlideAjax\`: construct with the Script Include name, \`addParam('sysparm_name', 'methodName')\` (this selects the method), add other params as \`sysparm_*\`, then \`getXMLAnswer(function (answer) {...})\`. Never \`getXMLWait()\`. The answer is a string: \`JSON.parse\` it when the server returns JSON.
5. \`g_form.getValue()\` always returns a string: checkboxes are \`'true'\`/\`'false'\`, numbers are \`'5'\`. Use \`getBooleanValue\`, \`getIntValue\`, \`getDecimalValue\` when you need a typed value.
6. \`g_form.setValue(name, value, displayValue)\` on a reference field: pass the display value as the third argument to avoid a server round trip. \`setValue\` fires that field's own onChange; compare with the current value first so two scripts cannot ping-pong.
7. Use \`g_form.addInfoMessage\`, \`addErrorMessage\`, \`showFieldMsg\` for feedback. Not \`alert()\`/\`confirm()\`; use \`g_modal.confirm()\` for a decision.
8. No DOM: no \`document\`, \`window\`, jQuery, \`g_form.getControl()\`. It breaks in Service Portal, workspaces, mobile and on upgrade. Everything you need is on \`g_form\`.
9. Field names are the dictionary names (\`short_description\`, \`caller_id\`), not labels. Check with get_schema before using one. Catalog scripts use **variable names**.
10. Keep it ES5 (var, function, no arrows or template literals) unless you know every target UI supports newer syntax.
11. Do not hide data you must keep: \`setDisplay(false)\` hides a field but it is still submitted; for security the server must still enforce.

## 4. Catalog client scripts
- They run on the catalog item/variable set; read variables with \`g_form.getValue('variable_name')\`.
- \`g_service_catalog.isOrderGuide()\` tells you if you are inside an order guide.
- Prefer a Catalog UI Policy for show/hide/mandatory on variables.

## 5. UI support (ask or assume Classic + Next Experience forms; call out the rest)
- Service Portal and mobile: no DOM, no \`GlideModal\`/\`GlideDialogWindow\`, no sync calls.
- Workspaces: \`g_form\`, \`g_user\`, GlideAjax, \`g_modal\` are supported; UI-type must include the workspace.
- The record's **UI Type** field controls where a script runs (Desktop, Mobile/Service Portal, All).

## 6. Templates

### onChange + lookup
\`\`\`javascript
function onChange(control, oldValue, newValue, isLoading, isTemplate) {
  if (isLoading || newValue === '') {
    return;
  }
  var ga = new GlideAjax('MyUserUtils');          // client-callable Script Include
  ga.addParam('sysparm_name', 'getDepartment');   // method to call
  ga.addParam('sysparm_user_id', newValue);
  ga.getXMLAnswer(function (answer) {
    g_form.setValue('u_department', answer);
  });
}
\`\`\`

### onLoad: lock down fields for non-admins
\`\`\`javascript
function onLoad() {
  if (!g_user.hasRole('admin')) {
    g_form.setReadOnly('priority', true);
  }
}
\`\`\`

### onSubmit: block with a message
\`\`\`javascript
function onSubmit() {
  if (g_form.getValue('priority') === '1' && g_form.getValue('description') === '') {
    g_form.showFieldMsg('description', 'Describe the impact of a P1.', 'error');
    return false;
  }
  return true;
}
\`\`\`

## 7. How to answer
1. State which artifact you are creating and why it is the right one (Client Script vs UI Policy).
2. Give the full script, then the configuration to set: Name, Table, Type, Field (onChange), UI Type, Active, Global/Applies to.
3. List assumptions (field names verified with get_schema, UI types supported).
4. Say how you tested it (test_client_script scenario) and what remains to check on a real form.
`;

export const CLIENT_SCRIPT_DIGEST =
  'Client scripts: UI Policy before script; onChange needs an isLoading/newValue guard; no gs/current/GlideRecord in the browser; ' +
  'GlideAjax with sysparm_name and an async callback; getValue returns strings; no DOM; enforce on the server too.';

export const CLIENT_SCRIPT_SKILL = {
  id: 'client-script',
  title: 'Client Script',
  summary: 'Browser-side logic: Client Scripts, Catalog Client Scripts, UI Policies, UI Scripts, client UI Actions.',
  side: 'client',
  tables: ['sys_script_client', 'catalog_script_client', 'sys_ui_policy', 'sys_ui_policy_action', 'catalog_ui_policy', 'sys_ui_script', 'sys_ui_action'],
  guide: CLIENT_SCRIPT_GUIDE,
  digest: CLIENT_SCRIPT_DIGEST,
  tools: ['get_form_model', 'get_schema', 'list_logic_for_table', 'lookup_api', 'verify_script', 'test_client_script', 'set_form_field', 'save_artifact'],
  // Artifact fields the agent should confirm with get_schema before saving.
  artifactHints: {
    sys_script_client: 'Fields include name, table, type (onLoad|onChange|onSubmit|onCellEdit), field (for onChange), script, active, ui_type. Confirm with get_schema("sys_script_client").',
  },
};
