// The agent's tool contract: names, JSON schemas and risk tiers. Pure data, so
// the in-extension agent, the local MCP bridge and the docs all read the same
// definitions. Implementations live in src/content/agentTools.js.
//
// Tiers (what the user has to approve):
//   observe  read-only, runs automatically (navigate is here: opening a page view changes no data, it refuses
//            to leave a form with unsaved changes, and only plain list/form/workspace/portal views can be opened)
//   draft    no side effects (verification, simulation), runs automatically
//   run      executes code on the instance with writes intercepted or rolled back (dry run, ATF), asks first
//   write    changes the form, the data or the session, always asks first (extra step on PROD)
//
// policy.js effectiveTier() can lower a call's tier from its arguments (run_atf with only a progressId just
// polls). MCP_ONLY_TOOLS run in the service worker for external agents; the sidebar agent never sees them.

export const TIERS = ['observe', 'draft', 'run', 'write'];

const KINDS = [
  'client_script',
  'catalog_client_script',
  'ui_policy_script',
  'ui_script',
  'ui_action_client',
  'business_rule',
  'script_include',
  'scheduled_job',
  'background_script',
  'acl_script',
  'scripted_rest',
  'flow_script',
];

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

export const TOOL_SCHEMAS = [
  // ---- observe ---------------------------------------------------------------
  {
    name: 'get_skill_guide',
    tier: 'observe',
    description:
      'Returns the ServiceNow scripting guide (rules, patterns, pitfalls) for client-side or server-side work. ' +
      'Call this once before writing any script. With no argument it picks the guide that matches the open page.',
    inputSchema: {
      type: 'object',
      properties: { skill: str('Which guide to load.', { enum: ['client-script', 'server-script'] }) },
    },
  },
  {
    name: 'get_page_context',
    tier: 'observe',
    description:
      'What the user is looking at: instance, table, record sys_id, whether it is a list or a form, the script field ' +
      'it contains and the active skill. Call this first to orient yourself.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_form_model',
    tier: 'observe',
    description:
      'Every field on the open form with its label, type, current value, and whether it is mandatory, read-only or ' +
      'visible. Use it to write client scripts against real field names and to see the live state of the form.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_field_state',
    tier: 'observe',
    description: 'Live state of one field on the open form: value, display value, label, mandatory, read-only, visible.',
    inputSchema: { type: 'object', properties: { name: str('Field name, e.g. "short_description".') }, required: ['name'] },
  },
  {
    name: 'get_schema',
    tier: 'observe',
    description:
      'Dictionary of a table including inherited fields: name, label, type, reference target, max length, mandatory. ' +
      'Always check this before using a field name you have not seen.',
    inputSchema: { type: 'object', properties: { table: str('Table name, e.g. "incident".') }, required: ['table'] },
  },
  {
    name: 'query_table',
    tier: 'observe',
    description:
      'Read rows through the Table API under the user\'s own permissions. Read-only, at most 50 rows. ' +
      'Use sysparm-style encoded queries, e.g. "active=true^priority=1".',
    inputSchema: {
      type: 'object',
      properties: {
        table: str('Table name.'),
        query: str('Encoded query.'),
        fields: { type: 'array', items: { type: 'string' }, description: 'Fields to return (strongly recommended).' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        displayValue: { type: 'boolean', description: 'Return display values instead of raw values.' },
      },
      required: ['table'],
    },
  },
  {
    name: 'count_records',
    tier: 'observe',
    description: 'Number of rows matching an encoded query, without transferring them.',
    inputSchema: {
      type: 'object',
      properties: { table: str('Table name.'), query: str('Encoded query.') },
      required: ['table'],
    },
  },
  {
    name: 'read_artifact',
    tier: 'observe',
    description:
      'Read a configuration record with its scripts: business rule, script include, client script, UI policy, UI action, ' +
      'ACL, scheduled job, scripted REST operation, catalog client script, UI script. Give a sys_id or a name.',
    inputSchema: {
      type: 'object',
      properties: {
        table: str('Artifact table, e.g. "sys_script_client".'),
        sysId: str('sys_id of the record.'),
        name: str('Exact name, when the sys_id is not known.'),
      },
      required: ['table'],
    },
  },
  {
    name: 'list_logic_for_table',
    tier: 'observe',
    description:
      'Everything configured to run on a table, so you can see what already exists before adding more: client scripts ' +
      '(type, field, UI type), UI policies, business rules (when, order, condition) and UI actions.',
    inputSchema: {
      type: 'object',
      properties: {
        table: str('Table name.'),
        kind: str('Which side to list.', { enum: ['client', 'server', 'all'] }),
      },
      required: ['table'],
    },
  },
  {
    name: 'search_code',
    tier: 'observe',
    description: 'Find a literal string across every script-bearing configuration table on the instance.',
    inputSchema: { type: 'object', properties: { term: str('Text to find (case-insensitive).') }, required: ['term'] },
  },
  {
    name: 'read_logs',
    tier: 'observe',
    description: 'Recent system log errors grouped by root cause, with occurrence counts.',
    inputSchema: {
      type: 'object',
      properties: {
        contains: str('Only messages containing this text.'),
        minutes: { type: 'integer', minimum: 1, maximum: 1440 },
      },
    },
  },
  {
    name: 'lookup_api',
    tier: 'observe',
    description:
      'Look up a ServiceNow API class or method in the verified catalog (client and server). Returns signature, ' +
      'where it runs, deprecation and gotchas. Use it instead of guessing method names.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('Class, method or "Class.method", e.g. "GlideRecord.addQuery" or "g_form.setMandatory".'),
        side: str('Restrict to one side.', { enum: ['client', 'server'] }),
      },
      required: ['query'],
    },
  },
  {
    name: 'read_page',
    tier: 'observe',
    description:
      'Structured snapshot of the screen: page kind (form, list, workspace, portal, other), title and path; for a form ' +
      'its sections and fields (name, label, type, value, display value, mandatory, read-only, visible), unsaved ' +
      'changes, info/error messages, UI action buttons and related lists; for a list its table, query, columns and ' +
      'first rows with sys_ids. Call it before and after acting on the page.',
    inputSchema: {
      type: 'object',
      properties: {
        maxFields: { type: 'integer', minimum: 1, maximum: 200, description: 'Form fields to return (default 80).' },
        maxRows: { type: 'integer', minimum: 1, maximum: 25, description: 'List rows to return (default 10).' },
      },
    },
  },
  {
    name: 'navigate',
    tier: 'observe',
    description:
      'Open a list, a record, a new-record form or a page on this instance in the user\'s tab, wait for it to load and ' +
      'return a short read_page summary. Give table (+ sysId, or newRecord: true, or query for a list) or a ' +
      'root-relative path (/incident_list.do?sysparm_query=..., /now/..., /sp?id=...). Refuses when the open form has ' +
      'unsaved changes. Opening a page never saves or changes data.',
    inputSchema: {
      type: 'object',
      properties: {
        table: str('Table to open, e.g. "incident".'),
        sysId: str('Record to open.'),
        newRecord: { type: 'boolean', description: 'Open an empty new-record form (nothing is saved).' },
        query: str('Encoded query: filters a list, or pre-fills a new record.'),
        view: str('Form or list view name.'),
        path: str('Root-relative path instead of table/sysId.'),
      },
    },
  },
  {
    name: 'get_instance_info',
    tier: 'observe',
    description:
      'Who and where you are: instance host, environment (prod/test/dev guess), release/build when readable, the current ' +
      'user with roles (admin, elevated security_admin), the current update set and application scope.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'explain_access',
    tier: 'observe',
    description:
      'Why a user can or cannot read/write/create/delete a table, record or field: the user\'s roles and where each comes ' +
      'from, the ACLs in ServiceNow evaluation order with a role check per ACL, before-query business rules, domain and ' +
      'policy caveats. Returns a verdict (allowed / denied / depends on runtime) and a plain-text trace. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        table: str('Table name, e.g. "incident".'),
        user: str('user_name, email or sys_id; empty or "me" for the logged-in user.'),
        sysId: str('A record to check (optional).'),
        field: str('A column to check field-level ACLs (optional).'),
        operation: str('Operation to explain.', { enum: ['read', 'write', 'create', 'delete', 'report_view', 'report_on'] }),
      },
      required: ['table'],
    },
  },
  {
    name: 'explain_field',
    tier: 'observe',
    description:
      'What controls one field on the open form: dictionary settings and overrides, client scripts, UI policies, data ' +
      'policies, business rules and ACLs that touch it, and when the form is open, a ranked list of likely reasons it is ' +
      'read-only, mandatory or hidden right now. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        table: str('Table of the form, e.g. "incident". Defaults to the open form.'),
        field: str('Field name, e.g. "assignment_group".'),
      },
      required: ['field'],
    },
  },
  {
    name: 'check_update_set',
    tier: 'observe',
    description:
      'Pre-commit review of an update set: verdict (ready / warnings / blockers) with the checklist (collisions with other ' +
      'in-progress sets, other scopes, deletes, risky types, script lint/verify findings, hard-coded sys_ids, cross-set ' +
      'dependencies) and release notes. Defaults to the current update set. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { updateSet: str('sys_id of the update set (optional; the current one by default).') },
    },
  },
  {
    name: 'scan_instance_health',
    tier: 'observe',
    description:
      'Read-only health and upgrade-readiness scan of custom code and configuration: lint/API findings, anti-patterns, ' +
      'configuration hygiene, skipped upgrade records and the security audit. Returns totals, categories, the most ' +
      'common rules and the worst findings with links. Can take a minute or two; returns a partial result after 2 minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: str('What to scan.', { enum: ['instance', 'scope', 'updateset', 'recent'] }),
        scopeId: str('Application sys_id, or "global", when mode is "scope".'),
        updateSetId: str('Update set sys_id when mode is "updateset".'),
        days: { type: 'number', description: 'Changed in the last N days (1-365) when mode is "recent".' },
        onlyMine: { type: 'boolean', description: 'With mode "recent": only records last updated by the current user.' },
        includeBaseline: { type: 'boolean', description: 'Also scan out-of-box records (default false).' },
        includeSecurity: { type: 'boolean', description: 'Include the security audit (default true).' },
      },
    },
  },

  // ---- draft -----------------------------------------------------------------
  {
    name: 'verify_script',
    tier: 'draft',
    description:
      'Check a script without running it: syntax, the verified API catalog (unknown methods, wrong side, deprecated), ' +
      'ServiceNow lint rules and client-script rules. Returns findings; fix every error before presenting the script.',
    inputSchema: {
      type: 'object',
      properties: {
        code: str('The script source.'),
        kind: str('What the script is.', { enum: KINDS }),
        when: str('Business rule timing.', { enum: ['before', 'after', 'async', 'display'] }),
        clientType: str('Client script type.', { enum: ['onLoad', 'onChange', 'onSubmit', 'onCellEdit'] }),
        scoped: { type: 'boolean', description: 'True for a scoped application (stricter API rules).' },
        table: str('Table the script belongs to, to check field names against its dictionary.'),
      },
      required: ['code', 'kind'],
    },
  },
  {
    name: 'test_client_script',
    tier: 'draft',
    description:
      'Run a client script in an isolated sandbox against a simulated form (g_form, g_user, GlideAjax, g_modal) and ' +
      'report every g_form call it makes. Use it to prove the script does what was asked before it touches a real form.',
    inputSchema: {
      type: 'object',
      properties: {
        code: str('The client script source (the function declaration).'),
        clientType: str('Which handler to call.', { enum: ['onLoad', 'onChange', 'onSubmit', 'onCellEdit'] }),
        scenario: {
          type: 'object',
          description:
            'Simulated state. fields: { name: { value, label, type, mandatory, readOnly, visible, options } }. ' +
            'For onChange: changedField, oldValue, newValue, isLoading. user: { roles: [..], userName }. ' +
            'ajax: { "ScriptIncludeName.method": "answer string" } to stub GlideAjax answers. ' +
            'references: { fieldName: { column: value } } to stub g_form.getReference.',
        },
      },
      required: ['code', 'clientType'],
    },
  },

  // ---- run -------------------------------------------------------------------
  {
    name: 'dry_run_script',
    tier: 'run',
    description:
      'Execute a server-side background script on the instance with GlideRecord writes intercepted, so it reports what ' +
      'it WOULD change instead of changing it. Reads, logging and other side effects still happen. Shows the user the ' +
      'script and asks first.',
    inputSchema: { type: 'object', properties: { code: str('The background script.') }, required: ['code'] },
  },
  {
    name: 'run_atf',
    tier: 'run',
    description:
      'Run an Automated Test Framework suite through the CI/CD API and wait for the result (pass/fail counts and the ' +
      'failing tests). Asks first. If it is still running when the wait ends, call again with only progressId to keep ' +
      'waiting (that starts nothing). Single tests cannot be started this way: put them in a suite.',
    inputSchema: {
      type: 'object',
      properties: {
        suite: str('Test suite sys_id or exact name.'),
        progressId: str('Progress id from an earlier run_atf call: keep waiting for that run instead of starting one.'),
        waitSeconds: { type: 'integer', minimum: 0, maximum: 150, description: 'How long to wait for the result (default 60).' },
      },
    },
  },

  // ---- write -----------------------------------------------------------------
  {
    name: 'set_form_field',
    tier: 'write',
    description:
      'Set one field on the open form (unsaved). For a script field the user sees a diff first. The form is not saved ' +
      'until save_form is approved.',
    inputSchema: {
      type: 'object',
      properties: { name: str('Field name.'), value: str('New value.') },
      required: ['name', 'value'],
    },
  },
  {
    name: 'save_form',
    tier: 'write',
    description: 'Save the open form, the same as pressing Save. Always asks first; on PROD instances it asks twice.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'save_artifact',
    tier: 'write',
    description:
      'Create or update a configuration record (client script, business rule, script include, UI policy, UI policy ' +
      'action, catalog client script) through the Table API. Scripts are verified first and the save is refused when ' +
      'verification finds errors. The previous values are kept so undo_last_write can restore them.',
    inputSchema: {
      type: 'object',
      properties: {
        table: str('Artifact table.', {
          enum: ['sys_script_client', 'sys_script', 'sys_script_include', 'sys_ui_policy', 'sys_ui_policy_action', 'catalog_script_client'],
        }),
        sysId: str('sys_id to update; omit to create a new record.'),
        fields: { type: 'object', description: 'Field values to write, e.g. { name, table, type, script, active }.' },
        reason: str('One sentence the user will see explaining why.'),
      },
      required: ['table', 'fields', 'reason'],
    },
  },
  {
    name: 'undo_last_write',
    tier: 'write',
    description:
      'Restore the record or form field changed by the most recent write this agent made (undo goes in order). The approval ' +
      'card shows which change; the same write rules apply as for the original change.',
    inputSchema: {
      type: 'object',
      properties: { entryId: str('Optional: the audit entry id the card showed; refused if it is no longer the last change.') },
    },
  },
  {
    name: 'run_ui_steps',
    tier: 'write',
    description:
      'Last resort: drive the page with clicks and typing when no other tool can. Steps are click, type, select, waitfor ' +
      'and wait (navigation is not allowed). Prefer set_form_field, which is faster and more reliable.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: str('Step type.', { enum: ['click', 'type', 'select', 'waitfor', 'wait'] }),
              target: str('CSS selector, or "text:Label" to click by visible text.'),
              value: str('Text to type or option to select; milliseconds for wait.'),
            },
            required: ['action'],
          },
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'click_ui_action',
    tier: 'write',
    description:
      'Run a UI action button on the open form, by its label ("Resolve") or action name ("sysverb_update"), the same as ' +
      'the user clicking it. Asks first and shows which button on which record. Waits and returns the resulting page and ' +
      'messages. Pass sysId to make sure it runs on the record you expect.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('Button label or action name, from read_page uiActions.'),
        sysId: str('sys_id of the record you expect to be open; the click is refused if another record is open.'),
      },
      required: ['action'],
    },
  },
  {
    name: 'create_record',
    tier: 'write',
    description:
      'Insert a record into any table through the Table API. Every column is checked against the dictionary first. Asks ' +
      'first, showing every field. Undo deletes it. For scripts on business rules, client scripts, script includes and UI ' +
      'policies use save_artifact, which verifies the code.',
    inputSchema: {
      type: 'object',
      properties: {
        table: str('Table name.'),
        fields: { type: 'object', description: 'Column: value pairs (raw values; sys_ids for references).' },
        reason: str('One sentence the user will see explaining why.'),
      },
      required: ['table', 'fields', 'reason'],
    },
  },
  {
    name: 'update_record',
    tier: 'write',
    description:
      'Change fields on one record through the Table API. Columns are checked against the dictionary. Asks first, showing ' +
      'each field before and after. Undo restores the previous values.',
    inputSchema: {
      type: 'object',
      properties: {
        table: str('Table name.'),
        sysId: str('sys_id of the record.'),
        fields: { type: 'object', description: 'Only the columns to change, as column: value (raw values).' },
        reason: str('One sentence the user will see explaining why.'),
      },
      required: ['table', 'sysId', 'fields', 'reason'],
    },
  },
  {
    name: 'delete_record',
    tier: 'write',
    description:
      'Delete one record through the Table API, as its real class. Asks first, showing every field. Undo re-inserts it ' +
      'with the same sys_id; not restored: records the platform deleted or cleared along with it, journal entries, ' +
      'attachments, and password or secret-bearing fields (the card lists them). Very large records have no undo.',
    inputSchema: {
      type: 'object',
      properties: {
        table: str('Table name.'),
        sysId: str('sys_id of the record.'),
        reason: str('One sentence the user will see explaining why.'),
      },
      required: ['table', 'sysId', 'reason'],
    },
  },
  {
    name: 'run_background_script',
    tier: 'write',
    description:
      'Run a server-side script for real, as the user, in the global scope (Scripts - Background). Writes, deletes, ' +
      'events and outbound calls really happen and cannot be undone. Asks first and shows the static risk analysis. Run ' +
      'dry_run_script on the same code first.',
    inputSchema: {
      type: 'object',
      properties: { code: str('The script.'), reason: str('One sentence the user will see explaining why.') },
      required: ['code', 'reason'],
    },
  },
  {
    name: 'switch_update_set',
    tier: 'write',
    description:
      'Make another in-progress update set the current one for this session, then read it back and say whether the switch ' +
      'took. Asks first. Undo switches back.',
    inputSchema: { type: 'object', properties: { updateSet: str('Update set sys_id or exact name.') }, required: ['updateSet'] },
  },
  {
    name: 'switch_application_scope',
    tier: 'write',
    description:
      'Change the current application scope of this session ("global" or a scoped app), then read it back and say whether ' +
      'it took. Asks first. Undo switches back.',
    inputSchema: {
      type: 'object',
      properties: { scope: str('"global", the application sys_id, or its scope name such as "x_acme_app".') },
      required: ['scope'],
    },
  },
  {
    name: 'impersonate_user',
    tier: 'write',
    description:
      'Start impersonating a user so the session acts with their roles (to test access or a user experience). Asks first ' +
      'with a strong warning. The page reloads; call get_instance_info afterwards. End it with end_impersonation.',
    inputSchema: {
      type: 'object',
      properties: { user: str('user_name or sys_id of the user.'), reason: str('One sentence the user will see explaining why.') },
      required: ['user', 'reason'],
    },
  },
  {
    name: 'end_impersonation',
    tier: 'write',
    description: 'Stop impersonating and return to the user\'s own session. Asks first. The page reloads.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// Tools only the MCP bridge offers (they run in the service worker, not the page): an external agent cannot see the
// screen any other way, and it needs to choose between tabs. The sidebar agent never gets them.
export const MCP_ONLY_TOOLS = [
  {
    name: 'screenshot',
    tier: 'observe',
    description:
      'PNG image of the visible ServiceNow tab. Chrome only allows it after the user has clicked the MySnowBuddy icon ' +
      '(or pressed its shortcut) on that tab. Prefer read_page for anything you need to act on.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tabs',
    tier: 'observe',
    description: 'Open ServiceNow tabs: tab_id, instance, title, path and whether each is the active tab of its window.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const byName = new Map([...TOOL_SCHEMAS, ...MCP_ONLY_TOOLS].map((t) => [t.name, t]));

export const getToolSchema = (name) => byName.get(name) || null;
export const toolTier = (name) => byName.get(name)?.tier || 'write';
export const isReadOnlyTier = (tier) => tier === 'observe' || tier === 'draft';
export const ARTIFACT_KINDS = KINDS;
export const isMcpOnlyTool = (name) => MCP_ONLY_TOOLS.some((t) => t.name === name);

// Every MCP tool can be pointed at a tab: by instance host, or by the tab_id that list_tabs returns.
const ROUTING_PROPS = {
  instance: str('Optional: run on this instance (e.g. "dev12345.service-now.com") instead of the active ServiceNow tab.'),
  tab_id: { type: 'integer', description: 'Optional: run in this tab (from list_tabs).' },
};

/** The tool list the MCP bridge registers: every tool plus the MCP-only ones, each with the routing arguments. */
export function mcpToolList() {
  const pick = ({ name, description, inputSchema, tier }) => ({ name, description, inputSchema, tier });
  return [...TOOL_SCHEMAS, ...MCP_ONLY_TOOLS].map((t) =>
    t.name === 'list_tabs' ? pick(t) : { ...pick(t), inputSchema: { ...t.inputSchema, properties: { ...(t.inputSchema.properties || {}), ...ROUTING_PROPS } } }
  );
}
