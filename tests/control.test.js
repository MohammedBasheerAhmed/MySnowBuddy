// Control plane: navigation rules, UI action matching, record CRUD with undo, session tools, ATF polling,
// the MCP permission ceiling, and the service-worker side of the MCP bridge (tabs, screenshots, reloads).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const control = require('../src/lib/agent/control.js');
const policy = require('../src/lib/agent/policy.js');
const { TOOL_SCHEMAS, MCP_ONLY_TOOLS, mcpToolList, toolTier } = require('../src/lib/agent/toolSchemas.js');
const { runAgent } = require('../src/lib/agent/agentLoop.js');
const { createAudit } = require('../src/lib/agent/audit.js');
const { createAgentTools } = require('../src/content/agentTools.js');
const { mcpGate, mcpAutonomy } = require('../src/content/agentBridge.js');
const { toolLabel, toolIcon, summarizeResult } = require('../src/lib/agent/runState.js');
const { buildSystemPrompt } = require('../src/lib/agent/systemPrompt.js');

const SYS = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const NEW = 'c'.repeat(32);

// ---- navigation rules -------------------------------------------------------------------------------

test('classifyPath allows plain views and refuses anything that can act on a GET', () => {
  assert.equal(control.classifyPath('/incident_list.do?sysparm_query=active=true').kind, 'list');
  assert.equal(control.classifyPath('/incident_list.do?sysparm_query=active=true').query, 'active=true');
  assert.deepEqual(
    (({ kind, table, needsTableCheck }) => ({ kind, table, needsTableCheck }))(control.classifyPath(`/incident.do?sys_id=${SYS}&sysparm_view=ess`)),
    { kind: 'form', table: 'incident', needsTableCheck: true }
  );
  assert.equal(control.classifyPath('/incident.do?sys_id=-1').kind, 'form');
  assert.equal(control.classifyPath('/now/sow/home').kind, 'workspace');
  assert.equal(control.classifyPath(`/now/nav/ui/classic/params/target/${encodeURIComponent('incident_list.do?sysparm_query=active=true')}`).kind, 'list');
  assert.equal(control.classifyPath('/sp?id=sc_cat_item&sys_id=x').kind, 'portal');
  assert.equal(control.classifyPath('/esc').kind, 'portal');

  const refused = [
    ['//evil.example.com/x', /Protocol-relative/],
    ['https://evil.example.com/', /must start with/],
    ['/incident.do/../logout.do', /traversal/],
    ['/incident_list.do?sysparm_query=javascript:gs.getUserID()', /script/],
    [`/incident.do?sys_id=${SYS}&sys_action=sysverb_delete`, /"sys_action" is not allowed/],
    ['/incident.do?sysparm_ck=abc&sys_id=-1', /"sysparm_ck" is not allowed/],
    ['/incident.do', /needs sys_id/],
    ['/incident.do?sys_id=123', /32-character/],
    ['/sys.scripts.do', /not a plain page view/],
    ['/api/now/table/incident', /not a plain page view/],
    ['/logout', /not a page view/],
    ['/now/x?q=javascript:alert(1)', /script/],
  ];
  for (const [p, re] of refused) assert.throws(() => control.classifyPath(p), re, p);
});

test('buildNavTarget builds list, record and new-record paths from structured arguments', () => {
  assert.equal(control.buildNavTarget({ table: 'incident', sysId: SYS }).path, `/incident.do?sys_id=${SYS}`);
  assert.equal(control.buildNavTarget({ table: 'incident', query: 'active=true' }).path, '/incident_list.do?sysparm_query=active%3Dtrue');
  assert.equal(control.buildNavTarget({ table: 'incident', view: 'ess' }).path, '/incident_list.do?sysparm_view=ess');
  assert.equal(control.buildNavTarget({ table: 'incident', query: 'active=true', view: 'ess' }).path, '/incident_list.do?sysparm_query=active%3Dtrue&sysparm_view=ess');
  assert.equal(control.buildNavTarget({ table: 'incident', newRecord: true, query: 'short_description=Hi' }).path, '/incident.do?sys_id=-1&sysparm_query=short_description%3DHi');
  assert.throws(() => control.buildNavTarget({ table: 'incident', sysId: 'nope' }), /32-character/);
  assert.throws(() => control.buildNavTarget({ table: 'inc;ident' }), /not a valid table/);
  assert.throws(() => control.buildNavTarget({ table: 'incident', path: '/x' }), /either path/);
  assert.throws(() => control.buildNavTarget({}), /needs a table/);
  assert.throws(() => control.buildNavTarget({ table: 'incident', query: 'caller_id=javascript:gs.getUserID()' }), /script/);
  assert.throws(() => control.buildNavTarget({ table: 'incident', view: 'a b' }), /plain name/);
});

test('page kind and workspace record parsing', () => {
  assert.equal(control.classifyPageKind({ topPath: '/now/nav/ui/classic/params/target/x', hasForm: true }), 'form');
  assert.equal(control.classifyPageKind({ topPath: '/incident_list.do', hasList: true }), 'list');
  assert.equal(control.classifyPageKind({ topPath: '/now/sow/record/incident/' + SYS }), 'workspace');
  assert.equal(control.classifyPageKind({ topPath: '/sp?id=index' }), 'portal');
  assert.equal(control.classifyPageKind({ topPath: '/navpage.do' }), 'other');
  assert.deepEqual(control.parseWorkspaceRecord(`/now/sow/record/incident/${SYS}/params/x`), { table: 'incident', sysId: SYS });
  assert.equal(control.parseWorkspaceRecord('/now/sow/home'), null);
});

// ---- UI actions -------------------------------------------------------------------------------------

test('matchUiAction: exact name or label only, top and bottom copies merged, ambiguity refused', () => {
  const actions = [
    { label: 'Update', actionName: 'sysverb_update', sysId: OTHER },
    { label: 'Update', actionName: 'sysverb_update_bottom', sysId: OTHER }, // same UI action at the bottom
    { label: 'Resolve', actionName: 'resolve_incident', sysId: null },
    { label: 'Resolve', actionName: 'resolve_incident_bottom', sysId: null },
    { label: 'Delete', actionName: 'sysverb_delete' },
  ];
  assert.equal(control.matchUiAction(actions, 'sysverb_update').action.actionName, 'sysverb_update');
  assert.equal(control.matchUiAction(actions, '  update ').action.actionName, 'sysverb_update', 'label, case and spacing ignored, copies merged');
  assert.equal(control.matchUiAction(actions, 'resolve').action.actionName, 'resolve_incident');
  assert.throws(() => control.matchUiAction(actions, 'Resolv'), /No UI action "Resolv".*Available: "Update"/s, 'never a fuzzy match');
  assert.throws(() => control.matchUiAction(actions, ''), /Say which/);
  const twoSaves = [
    { key: 'w0', label: 'Save' },
    { key: 'w1', label: 'Save' },
  ];
  assert.throws(() => control.matchUiAction(twoSaves, 'Save'), /matches 2 buttons/, 'distinct workspace buttons are never merged');
});

// ---- record writes ------------------------------------------------------------------------------------

test('normalizeFieldValues, diffRecord and snapshotForReinsert', () => {
  assert.deepEqual(control.normalizeFieldValues({ a: 1, b: true, c: null, d: 'x' }), { a: '1', b: 'true', c: '', d: 'x' });
  assert.throws(() => control.normalizeFieldValues({ sys_id: SYS }), /managed by the platform/);
  assert.throws(() => control.normalizeFieldValues({ a: { value: 1 } }), /string, number or boolean/);
  assert.throws(() => control.normalizeFieldValues({}), /empty/);
  assert.throws(() => control.normalizeFieldValues({ 'bad name': 1 }), /not a column/);
  assert.deepEqual(control.diffRecord({ a: '1', b: { value: '2' } }, { a: '1', b: '3' }, { b: 'Bee' }), [{ field: 'b', label: 'Bee', before: '2', after: '3' }]);
  assert.deepEqual(control.snapshotForReinsert({ sys_id: SYS, sys_created_on: 'x', sys_mod_count: '3', number: 'INC1', empty: '', sys_class_name: 'incident' }), { sys_id: SYS, number: 'INC1', sys_class_name: 'incident' });
});

test('sensitive-table policy blocks or warns before anyone is asked', () => {
  const block = (op, table, fields) => policy.assessWrite({ op, table, fields }).block;
  assert.match(block('update', 'oauth_credential', {}), /credentials/);
  assert.match(block('create', 'sys_user', { user_password: 'x' }), /password or secret/);
  assert.match(block('delete', 'sys_user', {}), /Deactivate users/);
  assert.match(block('delete', 'sys_dictionary', {}), /drops the column/);
  assert.match(block('update', 'sys_script', { script: 'x' }), /save_artifact/);
  assert.equal(block('update', 'sys_script', { active: 'false' }), null, 'deactivating a business rule is fine');
  assert.ok(policy.assessWrite({ op: 'create', table: 'sys_user_has_role', fields: { role: 'x' } }).warnings.some((w) => /privilege/.test(w)));
  assert.ok(policy.assessWrite({ op: 'update', table: 'sys_security_acl', fields: { active: 'false' } }).warnings.some((w) => /access control/.test(w)));
  assert.ok(policy.assessWrite({ op: 'update', table: 'sys_properties', fields: { value: '1' } }).warnings.some((w) => /instance/.test(w)));
  assert.ok(policy.assessWrite({ op: 'update', table: 'sys_ui_action', fields: { script: 'x' } }).warnings.some((w) => /not checked/.test(w)));

  assert.equal(policy.approvalMode({ tool: 'update_record', args: { table: 'sys_user', fields: { user_password: 'x' } } }), 'deny');
  assert.match(policy.denyMessage('delete_record', { table: 'sys_user' }), /^Not allowed: Deactivate/);
  assert.match(policy.denyMessage('save_form', {}), /read-only mode/);
});

test('tiers: navigation and reads are automatic, ATF and writes ask, PROD asks harder', () => {
  for (const t of ['read_page', 'navigate', 'get_instance_info']) assert.equal(policy.approvalMode({ tool: t }), 'auto', t);
  for (const t of ['click_ui_action', 'create_record', 'update_record', 'delete_record', 'run_background_script', 'switch_update_set', 'switch_application_scope', 'impersonate_user', 'end_impersonation']) {
    assert.equal(toolTier(t), 'write', t);
    assert.equal(policy.approvalMode({ tool: t, args: { table: 'incident', fields: { a: 1 } }, autonomy: 'auto-runs' }), 'ask', t);
    assert.equal(policy.approvalMode({ tool: t, args: { table: 'incident', fields: { a: 1 } }, isProd: true }), 'ask-strong', t);
    assert.equal(policy.approvalMode({ tool: t, autonomy: 'readonly' }), 'deny', t);
  }
  assert.equal(policy.approvalMode({ tool: 'run_atf', args: { suite: 'x' } }), 'ask');
  assert.equal(policy.approvalMode({ tool: 'run_atf', args: { suite: 'x' }, autonomy: 'auto-runs' }), 'ask', 'auto dry runs never auto-run tests');
  assert.equal(policy.approvalMode({ tool: 'run_atf', args: { suite: 'x' }, isProd: true }), 'ask-strong');
  assert.equal(policy.effectiveTier('run_atf', { progressId: SYS }), 'observe', 'polling starts nothing');
  assert.equal(policy.effectiveTier('run_atf', { progressId: SYS, suite: 'x' }), 'run');
  assert.equal(policy.approvalMode({ tool: 'run_atf', args: { progressId: SYS } }), 'auto');
  for (const t of TOOL_SCHEMAS) assert.ok(policy.describeCall(t.name, {}).title && policy.describeCall(t.name, {}).risk, t.name);
});

test('MCP ceiling: legacy setting, ordering, and the page-side gate', () => {
  assert.equal(policy.resolveMcpCeiling({}), 'write', 'default keeps the old behaviour (everything, with approval)');
  assert.equal(policy.resolveMcpCeiling({ mcpAutonomy: 'readonly' }), 'draft', 'the old read-only switch allowed drafts');
  assert.equal(policy.resolveMcpCeiling({ mcpCeiling: 'run', mcpAutonomy: 'readonly' }), 'run');
  assert.equal(policy.resolveMcpCeiling({ mcpCeiling: 'bogus' }), 'write');
  assert.ok(policy.ceilingAllows('draft', 'observe') && policy.ceilingAllows('draft', 'draft') && !policy.ceilingAllows('draft', 'run'));
  assert.ok(!policy.ceilingAllows('nonsense', 'observe') && !policy.ceilingAllows('write', 'nonsense'), 'unknown values fail closed');

  assert.equal(mcpGate({ tool: 'read_page', args: {}, settings: { mcpCeiling: 'observe' } }), null);
  assert.match(mcpGate({ tool: 'verify_script', args: {}, settings: { mcpCeiling: 'observe' } }), /ceiling/);
  assert.match(mcpGate({ tool: 'update_record', args: {}, settings: { mcpCeiling: 'run' } }), /ceiling/);
  assert.equal(mcpGate({ tool: 'run_atf', args: { progressId: SYS }, settings: { mcpCeiling: 'observe' } }), null, 'polling is a read');
  assert.match(mcpGate({ tool: 'screenshot', args: {}, settings: {} }), /Unknown tool/, 'MCP-only tools never run in the page');
  assert.match(mcpGate({ tool: 'nope', args: {}, settings: {} }), /Unknown tool/);
  assert.equal(mcpAutonomy({ mcpCeiling: 'draft' }), 'readonly');
  assert.equal(mcpAutonomy({ mcpCeiling: 'write' }), 'ask', 'external agents never get auto dry runs');
});

test('the MCP tool list adds screenshot, list_tabs and tab routing; the sidebar never sees MCP-only tools', () => {
  const list = mcpToolList();
  const names = list.map((t) => t.name);
  assert.equal(list.length, TOOL_SCHEMAS.length + MCP_ONLY_TOOLS.length);
  assert.ok(names.includes('screenshot') && names.includes('list_tabs'));
  assert.ok(!TOOL_SCHEMAS.some((t) => t.name === 'screenshot' || t.name === 'list_tabs'));
  for (const t of list) {
    if (t.name === 'list_tabs') assert.ok(!t.inputSchema.properties?.tab_id);
    else assert.ok(t.inputSchema.properties.tab_id && t.inputSchema.properties.instance, t.name);
  }
  assert.ok(!TOOL_SCHEMAS.find((t) => t.name === 'read_page').inputSchema.properties.tab_id, 'routing is not added to the shared schema');
});

test('timeline labels, icons and summaries cover the control tools', () => {
  for (const name of ['read_page', 'navigate', 'click_ui_action', 'create_record', 'update_record', 'delete_record', 'run_background_script', 'switch_update_set', 'switch_application_scope', 'impersonate_user', 'end_impersonation', 'get_instance_info', 'run_atf']) {
    assert.notEqual(toolIcon(name), 'tool', name);
    assert.notEqual(toolLabel(name, {}), name, name);
  }
  assert.equal(summarizeResult('update_record', { updated: true, changed: ['state', 'close_notes'] }), 'changed state, close_notes');
  assert.equal(summarizeResult('run_atf', { finished: true, state: 'failed', result: { passed: 3, failed: 1 } }), 'failed: 3 passed, 1 failed');
  assert.equal(summarizeResult('navigate', { pageReload: 'expected' }), 'page loading');
  assert.match(buildSystemPrompt({}).text, /read_page -> navigate|read_page \(or get_instance_info/);
  assert.match(buildSystemPrompt({}).text, /do not retry/i);
});

test('the agent loop refuses a blocked write with its reason, without asking', async () => {
  let asked = 0;
  const replies = [{ toolCalls: [{ id: 't1', name: 'delete_record', args: { table: 'sys_user', sysId: SYS, reason: 'x' } }] }, { content: 'ok' }];
  const run = await runAgent({
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }],
    tools: TOOL_SCHEMAS,
    callModel: async () => ({ content: '', toolCalls: [], stopReason: 'end_turn', ...replies.shift() }),
    executeTool: async () => {
      throw new Error('must not run');
    },
    approvalMode: (name, args) => policy.approvalMode({ tool: name, args }),
    requestApproval: async () => {
      asked += 1;
      return { approved: true };
    },
  });
  assert.equal(asked, 0);
  const toolMsg = run.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /Not allowed: Deactivate users/);
});

// ---- executor with fakes ----------------------------------------------------------------------------------

function memoryAudit() {
  let store = [];
  return createAudit({ get: async () => store, set: async (_k, v) => void (store = v) });
}

const INCIDENT_FIELDS = [
  { name: 'number', label: 'Number', type: 'string' },
  { name: 'short_description', label: 'Short description', type: 'string' },
  { name: 'state', label: 'State', type: 'integer' },
  { name: 'active', label: 'Active', type: 'boolean' },
  { name: 'caller_id', label: 'Caller', type: 'reference' },
  { name: 'u_pin', label: 'PIN', type: 'password2' },
  { name: 'close_notes', label: 'Close notes', type: 'string' },
  { name: 'work_notes', label: 'Work notes', type: 'journal_input' },
];

/** A small in-memory instance: tables of rows, plus every call the tools make. */
function harness(over = {}) {
  const db = {
    incident: [{ sys_id: SYS, number: 'INC0001', short_description: 'Printer', state: '1', active: 'true', sys_class_name: 'incident', sys_created_on: '2026-01-01', u_pin: 'enc', close_notes: '' }],
    sys_user: [
      { sys_id: 'd'.repeat(32), user_name: 'abel.tuter', name: 'Abel Tuter', active: 'true' },
      { sys_id: 'e'.repeat(32), user_name: 'me', name: 'Me', active: 'true' },
    ],
    sys_update_set: [
      { sys_id: '1'.repeat(32), name: 'Default', state: 'in progress' },
      { sys_id: '2'.repeat(32), name: 'STRY001', state: 'in progress' },
      { sys_id: '3'.repeat(32), name: 'Old', state: 'complete' },
    ],
    sys_atf_test_suite: [{ sys_id: '4'.repeat(32), name: 'Smoke', active: 'true' }],
    sys_atf_test: [{ sys_id: '5'.repeat(32), name: 'Login test' }],
    sys_atf_test_result: [],
    sys_properties: [
      { sys_id: '8'.repeat(32), name: 'x.api_key', value: 'abc123secret', type: 'string' },
      { sys_id: '9'.repeat(32), name: 'glide.ui.title', value: 'My Instance', type: 'string' },
      { sys_id: 'f'.repeat(32), name: 'x.harmless', value: 'p4ss', type: 'password2' },
    ],
  };
  const calls = { created: [], updated: [], deleted: [], scripts: [], navigateFrame: [], navigateTop: [], clicks: [], reloads: 0, started: [], switched: [], atfStarted: [] };
  const match = (row, query) =>
    String(query || '')
      .split('^')
      .filter((c) => c && !c.startsWith('ORDERBY'))
      .every((c) => {
        const [k, v] = c.split('=');
        return c.includes('!=') ? true : String(row[k]) === v;
      });
  const queryTable = async (table, query, fields = [], { displayValue } = {}) => {
    const rows = (db[table] || []).filter((r) => match(r, query));
    return rows.map((r) => {
      const pickd = fields.length ? Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]])) : { ...r };
      return displayValue ? Object.fromEntries(Object.entries(pickd).map(([k, v]) => [k, { value: v, display_value: v }])) : pickd;
    });
  };
  const status = { table: 'incident', sysId: SYS, isNewRecord: false, dirty: false, changedFields: [] };
  const frame = { id: 'gsft_main' };
  let marker = { doc: { n: 1 }, frame, href: 'h1', topHref: 't1' };
  const page = {
    snapshotDom: () => ({ ui: 'classic', topPath: '/navpage.do', contentPath: `/incident.do?sys_id=${status.sysId}`, title: 'INC0001', hasForm: true, hasList: false, formTable: 'incident', sysId: status.sysId, messages: [], sections: [{ name: 'Main', fields: ['number'] }], uiActions: [{ label: 'Resolve', actionName: 'resolve_incident' }], relatedLists: [] }),
    domFormFields: () => [],
    listUiActions: () => ({ mode: 'classic', actions: [{ el: { id: 'resolve' }, label: 'Resolve', actionName: 'resolve_incident' }, { el: { id: 'upd' }, label: 'Update', actionName: 'sysverb_update' }] }),
    clickControl: (el) => calls.clicks.push(el),
    pageMarker: () => marker,
    readMessages: () => [],
    waitForChange: async () => {
      marker = { ...marker, doc: { n: 2 } };
      return 'page-changed';
    },
    navigateFrame: (_f, p) => calls.navigateFrame.push(p),
    navigateTop: (u) => calls.navigateTop.push(u),
    reloadSoon: () => void (calls.reloads += 1),
    currentPath: () => '/navpage.do',
  };
  const session = {
    current: { sysId: '1'.repeat(32), name: 'Default' },
    takes: true,
    user: { sysId: 'e'.repeat(32), userName: 'me', name: 'Me' },
  };
  const ctl = {
    page,
    shellUrl: (p) => `/now/nav/ui/classic/params/target/${encodeURIComponent(p.slice(1))}`,
    tableExists: async (t) => t in db,
    session: {
      readCurrentUser: async () => session.user,
      readCurrentUserFromApi: async () => session.user,
      readSessionInfo: async () => ({ userName: 'me', admin: true, securityAdmin: false, roles: ['admin'] }),
      readUserRoles: async (id) => (id === 'd'.repeat(32) ? ['itil'] : ['admin', 'itil']),
      readBuild: async () => ({ build: 'australia', version: 'glide-australia-p7', source: 'stats.do' }),
      readCurrentUpdateSet: async () => session.current,
      readCurrentScope: async () => ({ sysId: 'global', name: 'Global', scope: 'global' }),
      switchUpdateSet: async (id) => {
        calls.switched.push(id);
        if (session.takes) session.current = { sysId: id, name: db.sys_update_set.find((u) => u.sys_id === id)?.name };
        return { after: session.current, requestError: session.takes ? null : 'Update set switch failed (400).' };
      },
      switchScope: async (id) => ({ after: { sysId: id, name: 'X' } }),
      startImpersonation: async (id) => {
        calls.started.push(id);
        session.user = { sysId: id, userName: 'abel.tuter' };
      },
      endImpersonation: async () => {
        calls.started.push('end');
        session.user = { sysId: 'e'.repeat(32), userName: 'me' };
      },
    },
    atf: {
      progress: [{ status: '1', percent: 40 }, { status: '2', percent: 100, resultsId: '6'.repeat(32) }],
      startSuite: async (id) => (calls.atfStarted.push(id), { progressId: '7'.repeat(32) }),
      readProgress: async () => ctl.atf.progress.shift() || { status: '2', percent: 100, resultsId: '6'.repeat(32) },
      readSuiteResult: async () => ({ passed: 3, failed: 0 }),
    },
    insights: {
      calls: [],
      explainAccess: async (a) => (ctl.insights.calls.push(['access', a]), { verdict: 'denied', text: 'Denied by incident.write', trace: { verdict: 'denied' } }),
      fieldReport: async (a) => (
        ctl.insights.calls.push(['field', a]),
        {
          onForm: true,
          live: { readOnly: true, mandatory: false, visible: true },
          causes: [{ kind: 'ui_policy', score: 90, title: 'UI policy: Lock state', table: 'sys_ui_policy', sysId: SYS }],
          column: { type: 'choice' },
          overrides: [],
          entry: { clientScripts: [{ script: { name: 'Set state', sysId: SYS, script: 'a long script body' }, reasons: ['onChange'] }], uiPolicies: [], dataPolicies: [], businessRules: [], acls: [], overrides: [] },
          notes: [],
        }
      ),
      pageTable: () => 'incident',
      currentUpdateSet: async () => ({ sysId: '1'.repeat(32), name: 'Default' }),
      loadShipCheck: async (id) => (
        ctl.insights.calls.push(['ship', id]),
        {
          set: { sysId: id, name: 'Default', state: 'in progress', applicationName: 'Global' },
          checklist: {
            verdict: 'blockers',
            counts: { block: 1, warn: 0, info: 0, ok: 1, entries: 3, scripts: 0 },
            checks: [
              { status: 'block', title: 'Default update set', detail: 'Changes in a Default set cannot be moved as a unit.', items: [] },
              { status: 'ok', title: 'No collisions' },
            ],
          },
          releaseNotes: '# Default',
        }
      ),
      runHealthScan: async (opts, _onProgress, signal) => (ctl.insights.calls.push(['health', opts, signal instanceof AbortSignal]), ctl.insights.report),
      report: null,
    },
  };
  const form = { previous: 'old value', context: { table: 'incident' } };
  const callPage = async (action, args = []) => {
    if (action === 'getFormStatus') return status.table ? { ...status } : null;
    if (action === 'setFieldValue') return { previous: form.previous };
    if (action === 'getFieldState') return { name: args[0], value: 'shown', displayValue: 'shown', type: args[0] === 'u_pin' ? 'password2' : 'string' };
    if (action === 'getFormModel') return { table: 'incident', sysId: status.sysId, isNewRecord: false, fieldCount: 2, fields: [{ name: 'number', label: 'Number', value: 'INC0001', type: 'string' }, { name: 'u_pin', label: 'PIN', value: 'enc', type: 'password2' }] };
    if (action === 'getListInfo') return null;
    return null;
  };
  const audit = memoryAudit();
  const tools = createAgentTools({
    getContext: () => ({ table: form.context.table, sysId: status.sysId }),
    getInstanceInfo: () => ({ host: 'dev1.service-now.com', instance: 'dev1', env: 'dev' }),
    callPage,
    queryTable,
    fetchRecord: async (t, id, fields = []) => (await queryTable(t, `sys_id=${id}`, fields))[0] || null,
    countRecords: async () => 0,
    createRecord: async (t, f) => {
      calls.created.push({ t, f });
      const row = { sys_id: f.sys_id || NEW, ...f };
      (db[t] = db[t] || []).push(row);
      return row;
    },
    updateRecord: async (t, id, f) => {
      calls.updated.push({ t, id, f });
      const row = db[t].find((r) => r.sys_id === id);
      Object.assign(row, f);
      return { ...row };
    },
    deleteRecord: async (t, id) => {
      calls.deleted.push({ t, id });
      db[t] = db[t].filter((r) => r.sys_id !== id);
      return null;
    },
    fetchTableFields: async (t) => {
      if (t === 'incident') return { tables: ['incident', 'task'], fields: INCIDENT_FIELDS };
      if (t === 'sys_atf_test_result') return { tables: [t], fields: ['parent', 'status', 'test', 'output'].map((name) => ({ name })) };
      if (t === 'sys_properties') return { tables: [t], fields: [{ name: 'name' }, { name: 'value', type: 'string' }, { name: 'type' }] };
      if (t === 'sys_user') return { tables: [t], fields: [{ name: 'user_name' }, { name: 'name' }, { name: 'active' }] };
      if (t === 'sys_script') return { tables: [t], fields: ['name', 'collection', 'when', 'active', 'condition', 'filter_condition', 'script'].map((name) => ({ name })) };
      return { tables: [t], fields: [] };
    },
    tableHierarchy: async (t) => ({ incident: ['incident', 'task'], sys_dictionary: ['sys_dictionary', 'sys_metadata'], sys_app: ['sys_app', 'sys_scope', 'sys_package'] })[t] || [t],
    runSandbox: async ({ code }) => ({ ok: true, error: /SYNTAX/.test(code) ? { message: 'Unexpected token' } : null }),
    runBackgroundScript: async (script) => (calls.scripts.push(script), `*** Script: ran`),
    getCsrfToken: async () => 'tok',
    wrapAsDryRun: (c) => `DRY(${c})`,
    extractScriptOutput: (html) => html,
    recordUrl: (t, id) => `/${t}.do?sys_id=${id}`,
    audit,
    control: ctl,
    atfPollMs: 1,
    ...over,
  });
  return { tools, db, calls, status, ctl, session, audit, form, setMarker: (m) => (marker = m) };
}

test('create_record checks every column, records undo, and undo deletes it', async () => {
  const h = harness();
  await assert.rejects(h.tools.execute('create_record', { table: 'incident', fields: { short_descriptoin: 'x' }, reason: 'r' }), /did you mean "short_description"/);
  await assert.rejects(h.tools.execute('create_record', { table: 'incident', fields: { u_pin: '1234' }, reason: 'r' }), /password field/);
  await assert.rejects(h.tools.execute('create_record', { table: 'unknown_table', fields: { a: 1 }, reason: 'r' }), /Cannot read the dictionary/);
  assert.equal(h.calls.created.length, 0, 'nothing reached the instance');

  const preview = await h.tools.preview('create_record', { table: 'incident', fields: { short_descriptoin: 'x' }, reason: 'r' });
  assert.match(preview.blocked, /did you mean/, 'the approval card says it will be refused');

  const r = await h.tools.execute('create_record', { table: 'incident', fields: { short_description: 'New one', state: 1 }, reason: 'r' });
  assert.equal(r.sysId, NEW);
  assert.equal(r.url, `/incident.do?sys_id=${NEW}`);
  assert.deepEqual(h.calls.created[0].f, { short_description: 'New one', state: '1' });
  const undone = await h.tools.execute('undo_last_write', {});
  assert.match(undone.undone, /Created incident/);
  assert.deepEqual(h.calls.deleted, [{ t: 'incident', id: NEW }]);
});

test('update_record writes only what changes, previews a field diff, and undo restores the old values', async () => {
  const h = harness();
  const preview = await h.tools.preview('update_record', { table: 'incident', sysId: SYS, fields: { state: '6', short_description: 'Printer' }, reason: 'resolve' });
  assert.deepEqual(preview.fieldDiff.map((d) => [d.field, d.label, d.before, d.after]), [['state', 'State', '1', '6']]);
  assert.match(preview.notes[0], /already have that value/);
  assert.equal(preview.undo, 'Undo restores the previous values.');

  const same = await h.tools.execute('update_record', { table: 'incident', sysId: SYS, fields: { state: '1' }, reason: 'r' });
  assert.equal(same.updated, false);
  assert.equal(h.calls.updated.length, 0);

  const r = await h.tools.execute('update_record', { table: 'incident', sysId: SYS, fields: { state: '6', short_description: 'Printer' }, reason: 'r' });
  assert.deepEqual(r.changed, ['state']);
  assert.deepEqual(h.calls.updated[0].f, { state: '6' }, 'unchanged fields are not sent');
  await h.tools.execute('undo_last_write', {});
  assert.deepEqual(h.calls.updated[1], { t: 'incident', id: SYS, f: { state: '1' } });
  assert.equal(h.db.incident[0].state, '1');
  await assert.rejects(h.tools.execute('update_record', { table: 'incident', sysId: OTHER, fields: { state: '2' }, reason: 'r' }), /No incident record/);
});

test('work notes are journal entries: written, shown as new, and never in the undo', async () => {
  const h = harness();
  const preview = await h.tools.preview('update_record', { table: 'incident', sysId: SYS, fields: { work_notes: 'Investigating' }, reason: 'r' });
  assert.equal(preview.fieldDiff[0].before, '(new journal entry)');
  assert.match(preview.undo, /Not available/);
  assert.ok(preview.warnings.some((w) => /journal entry/.test(w)));
  const r = await h.tools.execute('update_record', { table: 'incident', sysId: SYS, fields: { work_notes: 'Investigating', state: '2' }, reason: 'r' });
  assert.deepEqual(r.journalAdded, ['work_notes']);
  const entry = (await h.audit.load())[0];
  assert.deepEqual(entry.undo.previous, { state: '1' }, 'undo restores the state only');
  await h.tools.execute('update_record', { table: 'incident', sysId: SYS, fields: { work_notes: 'More' }, reason: 'r' });
  assert.equal((await h.audit.load())[0].undo, null, 'a journal-only update has no undo');
});

test('delete_record keeps a copy without secrets, and undo re-inserts it with the same sys_id', async () => {
  const h = harness();
  const preview = await h.tools.preview('delete_record', { table: 'incident', sysId: SYS, reason: 'dup' });
  assert.ok(preview.fieldList.some((f) => f.field === 'number' && f.value === 'INC0001'));
  assert.ok(!preview.fieldList.some((f) => f.field === 'u_pin'), 'password-typed fields are not shown');
  assert.match(preview.undo, /same sys_id/);
  const r = await h.tools.execute('delete_record', { table: 'incident', sysId: SYS, reason: 'dup' });
  assert.equal(r.deleted, true);
  assert.equal(h.db.incident.length, 0);
  const entry = (await h.audit.load())[0];
  assert.equal(entry.undo.deleted, true);
  assert.ok(!('u_pin' in entry.undo.snapshot), 'password fields are never kept');
  assert.ok(!('sys_created_on' in entry.undo.snapshot));
  const back = await h.tools.execute('undo_last_write', {});
  assert.equal(back.sysId, SYS);
  assert.equal(h.calls.created[0].f.sys_id, SYS);
  assert.equal(h.db.incident[0].number, 'INC0001');
  await assert.rejects(h.tools.execute('delete_record', { table: 'sys_user', sysId: SYS, reason: 'x' }), /Deactivate users/);
});

test('navigate never leaves unsaved work, opens classic pages in the frame, and reloads the tab otherwise', async () => {
  const h = harness();
  h.status.dirty = true;
  h.status.changedFields = ['short_description'];
  await assert.rejects(h.tools.execute('navigate', { table: 'incident' }), /unsaved changes \(short_description\)/);
  assert.equal(h.calls.navigateFrame.length + h.calls.navigateTop.length, 0);
  h.status.dirty = false;

  const r = await h.tools.execute('navigate', { table: 'incident', query: 'active=true' });
  assert.deepEqual(h.calls.navigateFrame, ['/incident_list.do?sysparm_query=active%3Dtrue']);
  assert.equal(r.loaded, true);
  assert.equal(r.page.kind, 'form');

  await assert.rejects(h.tools.execute('navigate', { table: 'incident', query: 'nmae=x' }), /no field "nmae"/);
  await assert.rejects(h.tools.execute('navigate', { path: '/logout_list.do' }), /no table "logout"/);
  await assert.rejects(h.tools.execute('navigate', { table: 'oauth_credential' }), /credentials/);

  h.setMarker({ doc: {}, frame: null, href: 'x', topHref: 'y' });
  const top = await h.tools.execute('navigate', { table: 'incident', sysId: SYS });
  assert.equal(top.pageReload, 'expected');
  assert.deepEqual(h.calls.navigateTop, [`/now/nav/ui/classic/params/target/${encodeURIComponent(`incident.do?sys_id=${SYS}`)}`]);
  await h.tools.execute('navigate', { path: '/now/sow/home' });
  assert.equal(h.calls.navigateTop[1], '/now/sow/home', 'Next Experience routes are opened as they are');
});

test('read_page combines the markup and g_form, and hides secret values', async () => {
  const h = harness();
  const page = await h.tools.execute('read_page', {});
  assert.equal(page.kind, 'form');
  assert.equal(page.table, 'incident');
  assert.equal(page.sysId, SYS);
  assert.equal(page.form.dirty, false);
  assert.deepEqual(page.form.fields.find((f) => f.name === 'u_pin').value, '[hidden]');
  assert.deepEqual(page.uiActions, [{ label: 'Resolve', actionName: 'resolve_incident' }]);
});

test('click_ui_action clicks only the approved button on the expected record', async () => {
  const h = harness();
  await assert.rejects(h.tools.execute('click_ui_action', { action: 'Resolve', sysId: OTHER }), /not b{32}\. Nothing was clicked/);
  await assert.rejects(h.tools.execute('click_ui_action', { action: 'Close' }), /No UI action "Close"/);
  assert.equal(h.calls.clicks.length, 0);

  const preview = await h.tools.preview('click_ui_action', { action: 'resolve' });
  assert.match(preview.target, /"Resolve" \(resolve_incident\) on incident INC0001/);
  h.status.sysId = OTHER; // the user opened another record while the card was waiting
  await assert.rejects(h.tools.execute('click_ui_action', { action: 'resolve' }), /different record/);
  assert.equal(h.calls.clicks.length, 0);

  h.status.sysId = SYS;
  const r = await h.tools.execute('click_ui_action', { action: 'Resolve', sysId: SYS });
  assert.deepEqual(h.calls.clicks, [{ id: 'resolve' }]);
  assert.equal(r.outcome, 'page-changed');
  assert.equal((await h.audit.load())[0].tool, 'click_ui_action');
});

test('switch_update_set verifies by reading back, reports honestly, and undo switches back', async () => {
  const h = harness();
  await assert.rejects(h.tools.execute('switch_update_set', { updateSet: 'Old' }), /complete; only an in-progress/);
  const r = await h.tools.execute('switch_update_set', { updateSet: 'STRY001' });
  assert.equal(r.switched, true);
  assert.equal(r.current.name, 'STRY001');
  await h.tools.execute('undo_last_write', {});
  assert.deepEqual(h.calls.switched, ['2'.repeat(32), '1'.repeat(32)]);

  h.session.takes = false;
  const failed = await h.tools.execute('switch_update_set', { updateSet: 'STRY001' });
  assert.equal(failed.switched, false);
  assert.match(failed.note, /did not take/);
  assert.match(failed.error, /400/);
  assert.equal((await h.audit.load())[0].ok, false, 'a switch that did not take is logged as not ok and has no undo');
});

test('run_background_script refuses a syntax error, runs with guards, and knows whether it was dry-run', async () => {
  const h = harness();
  await assert.rejects(h.tools.execute('run_background_script', { code: 'SYNTAX(', reason: 'r' }), /Not run: .*Unexpected token/);
  assert.equal(h.calls.scripts.length, 0);
  const code = "gs.info('hello');";
  const before = await h.tools.preview('run_background_script', { code, reason: 'r' });
  assert.ok(before.warnings.some((w) => /not been dry-run/.test(w)));
  await h.tools.execute('dry_run_script', { code });
  const after = await h.tools.preview('run_background_script', { code: `${code}\n`, reason: 'r' });
  assert.deepEqual(after.warnings, [], 'the same script (whitespace aside) was dry-run');
  const r = await h.tools.execute('run_background_script', { code, reason: 'r' });
  assert.equal(r.dryRunFirst, true);
  assert.match(h.calls.scripts.at(-1), /==== MySnowBuddy run ====/);
});

test('run_atf starts a suite and waits; progressId only polls; a single test is explained', async () => {
  const h = harness();
  const r = await h.tools.execute('run_atf', { suite: 'Smoke', waitSeconds: 5 });
  assert.equal(r.state, 'successful');
  assert.equal(r.finished, true);
  assert.deepEqual(r.result, { passed: 3, failed: 0 });
  assert.deepEqual(h.calls.atfStarted, ['4'.repeat(32)]);

  h.ctl.atf.progress = [{ status: '1', percent: 10 }];
  const waiting = await h.tools.execute('run_atf', { progressId: '7'.repeat(32), waitSeconds: 0 });
  assert.equal(waiting.finished, false);
  assert.match(waiting.next, /progressId/);
  assert.equal(h.calls.atfStarted.length, 1, 'polling started nothing');

  await assert.rejects(h.tools.execute('run_atf', { suite: 'Login test' }), /single test, not a suite/);
});

test('impersonation: resolves the user, reloads, and end_impersonation spends the undo', async () => {
  const h = harness();
  const preview = await h.tools.preview('impersonate_user', { user: 'abel.tuter', reason: 'test access' });
  assert.match(preview.target, /Abel Tuter \(abel.tuter\)/);
  const r = await h.tools.execute('impersonate_user', { user: 'abel.tuter', reason: 'test access' });
  assert.equal(r.confirmed, true);
  assert.equal(r.pageReload, 'expected');
  assert.equal(h.calls.reloads, 1);
  await assert.rejects(h.tools.execute('impersonate_user', { user: 'abel.tuter', reason: 'x' }), /already the session user/);
  await h.tools.execute('end_impersonation', {});
  assert.deepEqual(h.calls.started, ['d'.repeat(32), 'end']);
  const last = await h.audit.lastUndoable('dev1.service-now.com');
  assert.ok(!last || last.undo.kind !== 'impersonation', 'the impersonation undo is spent');
  await assert.rejects(h.tools.execute('impersonate_user', { user: 'nobody^x', reason: 'x' }), /may not contain/);
});

test('get_instance_info reports user, roles, update set, scope and build', async () => {
  const h = harness();
  const info = await h.tools.execute('get_instance_info', {});
  assert.equal(info.environment, 'dev');
  assert.equal(info.writesNeedTypedConfirmation, false);
  assert.equal(info.user.userName, 'me');
  assert.equal(info.roles.admin, true);
  assert.equal(info.roles.securityAdminElevated, false);
  assert.equal(info.updateSet.name, 'Default');
  assert.equal(info.scope.scope, 'global');
  assert.equal(info.build.version, 'glide-australia-p7');
});

test('the page-side MCP gate: ceiling, refused previews, approvals, and only the worker may relay', async () => {
  const listeners = [];
  let stored = { mysnowbuddy_settings: { mcpCeiling: 'write' } };
  const started = [];
  globalThis.chrome = {
    runtime: { id: 'ext', onMessage: { addListener: (fn) => listeners.push(fn) }, sendMessage: async (m) => (started.push(m), { ok: true }) },
    storage: { local: { get: async () => stored } },
  };
  try {
    const { installAgentBridge } = require('../src/content/agentBridge.js');
    const executed = [];
    const asked = [];
    installAgentBridge({
      tools: { preview: async (_t, args) => (args.bad ? { blocked: 'no such column' } : {}), execute: async (tool) => (executed.push(tool), { ok: true }) },
      approval: { request: async (r) => (asked.push(r), { approved: r.args.approve === true }), cancel() {} },
      getInstanceInfo: () => ({ host: 'dev1.service-now.com', env: 'dev' }),
      audit: { record: async () => {} },
    });
    const send = (tool, args, sender = { id: 'ext' }) => new Promise((resolve) => listeners[0]({ type: 'AGENT_TOOL_CALL', callId: `c${asked.length}${executed.length}`, tool, args }, sender, resolve));
    const write = { table: 'incident', sysId: SYS, fields: { state: '2' }, reason: 'r' };
    assert.equal((await send('read_page', {})).ok, true);
    assert.equal(asked.length, 0, 'reads are not asked');
    assert.match((await send('update_record', { ...write, bad: true })).error, /Not run: no such column/);
    assert.equal(asked.length, 0, 'a call the executor would refuse is not put in front of the user');
    assert.match((await send('update_record', write)).error, /denied this action/);
    assert.equal((await send('update_record', { ...write, approve: true })).ok, true);
    assert.deepEqual(executed, ['read_page', 'update_record']);
    assert.equal(started.at(-1).type, 'AGENT_TOOL_STARTED', 'the worker is told the approved call is running');
    assert.match((await send('delete_record', { table: 'sys_user', sysId: SYS, reason: 'r' })).error, /Not allowed: Deactivate/);

    stored = { mysnowbuddy_settings: { mcpCeiling: 'draft' } };
    assert.match((await send('update_record', { ...write, approve: true })).error, /permission ceiling/);
    assert.match((await send('dry_run_script', { code: 'x' })).error, /permission ceiling/);
    assert.equal((await send('verify_script', { code: 'x', kind: 'background_script' })).ok, true);
    assert.equal(listeners[0]({ type: 'AGENT_TOOL_CALL', tool: 'read_page' }, { id: 'ext', tab: { id: 1 } }, () => {}), false, 'a tab can never relay a call');
  } finally {
    delete globalThis.chrome;
  }
});

// ---- hardening review fixes --------------------------------------------------------------------------------

test('the page bridge returns g_user roles (the check used to be inverted)', () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', 'bridge.js'), 'utf8');
  const listeners = {};
  const responses = [];
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  }
  const document = { addEventListener: (t, fn) => (listeners[t] = fn), dispatchEvent: (e) => e.type === 'msb-page-response' && responses.push(e.detail) };
  const window = { frames: { length: 0 }, g_user: { userName: 'admin', userID: 'u1', roles: ['admin', 'itil'], hasRoleExactly: (r) => r === 'admin' } };
  vm.runInNewContext(src, { window, document, CustomEvent });
  listeners['msb-page-request']({ detail: { id: 'r1', action: 'getUserInfo', args: [] } });
  assert.deepEqual([...responses[0].result.roles], ['admin', 'itil']);
  window.g_user.roles = 'admin, itil';
  listeners['msb-page-request']({ detail: { id: 'r2', action: 'getSessionInfo', args: [] } });
  assert.deepEqual([...responses[1].result.roles], ['admin', 'itil']);
  assert.equal(responses[1].result.admin, true);
});

test('page bridge request ids are random', () => {
  const { newRequestId } = require('../src/content/pageBridge.js');
  const a = newRequestId();
  assert.match(a, /^msb-[0-9a-f]{32}$/);
  assert.notEqual(a, newRequestId());
});

test('redactDeep hides the value of a row whose name is a secret (sys_properties over MCP)', () => {
  const { redactDeep } = require('../src/lib/agent/agentLoop.js');
  const out = redactDeep({
    rows: [
      { name: 'glide.ldap.password', value: 'Sup3r-S3cret' },
      { name: 'x.api.token', value: { value: 'abc123def', display_value: 'abc123def' } },
      { name: 'glide.ui.title', value: 'My Instance' },
    ],
  });
  assert.equal(out.rows[0].value, '[REDACTED]');
  assert.deepEqual(out.rows[1].value, { value: '[REDACTED]', display_value: '[REDACTED]' });
  assert.equal(out.rows[2].value, 'My Instance');
});

test('writes never put the redaction placeholder back over a real value', async () => {
  assert.match(control.placeholderProblem('u_note', 'token [REDACTED]'), /placeholder that hid a value/);
  assert.match(control.placeholderProblem('script', "r.setBasicAuth('admin', '[REDACTED]');"), /where a secret was \(line 1\)/);
  assert.equal(control.placeholderProblem('script', "s.replace(/x/g, '[REDACTED]');"), null, 'a sanitiser in code may contain the word');
  assert.equal(control.placeholderProblem('u_note', 'fine'), null);

  const h = harness();
  await assert.rejects(h.tools.execute('set_form_field', { name: 'close_notes', value: '[REDACTED]' }), /Nothing was written/);
  await assert.rejects(h.tools.execute('update_record', { table: 'incident', sysId: SYS, fields: { close_notes: 'key [REDACTED]' }, reason: 'r' }), /placeholder/);
  await assert.rejects(h.tools.execute('create_record', { table: 'incident', fields: { short_description: '[REDACTED]' }, reason: 'r' }), /placeholder/);
  await assert.rejects(h.tools.execute('save_artifact', { table: 'sys_script_include', fields: { name: 'X', description: '[REDACTED]' }, reason: 'r' }), /placeholder/);
  assert.equal(h.calls.updated.length + h.calls.created.length, 0);
  const preview = await h.tools.preview('update_record', { table: 'incident', sysId: SYS, fields: { close_notes: '[REDACTED]' }, reason: 'r' });
  assert.match(preview.blocked, /placeholder/);
});

// ---- the service-worker side of MCP ---------------------------------------------------------------------

test('MCP from the extension side: ceiling, list_tabs, tab_id, screenshots and page reloads', async () => {
  const { createBridge } = require('../mcp/snowbuddy-mcp.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-ctl-'));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stderr.resume();
  const bridge = createBridge({ port: 0, tokenPath: path.join(dir, 'token'), stdin, stdout, stderr, generatedDir: path.join(dir, 'gen'), callTimeoutMs: 15000, maxPollWaitMs: 150 });
  await bridge.start();
  const messages = [];
  let buf = '';
  stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  let nextId = 1;
  const request = async (method, params) => {
    const id = nextId++;
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let i = 0; i < 2000; i++) {
      const found = messages.find((m) => m.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no reply to ${method}`);
  };
  const call = (name, args = {}) => request('tools/call', { name, arguments: args });

  const listeners = { changed: [], message: [] };
  const sent = [];
  const settings = { mcpBridgeEnabled: true, mcpToken: bridge.token, mcpPort: bridge.port, mcpCeiling: 'write' };
  const tabs = [
    { id: 7, windowId: 1, url: 'https://dev1.service-now.com/incident_list.do?sysparm_query=x', title: 'Incidents password=hunter2abc', active: true, lastAccessed: 9, status: 'complete' },
    { id: 8, windowId: 1, url: 'https://dev2.service-now.com/now/sow/home', title: 'SOW', active: false, lastAccessed: 5, status: 'complete' },
  ];
  let pageAnswer = null;
  let screenshotAllowed = true;
  globalThis.chrome = {
    storage: { local: { get: async () => ({ mysnowbuddy_settings: { ...settings } }) }, onChanged: { addListener: (fn) => listeners.changed.push(fn) } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { id: 'ext', getManifest: () => ({ version: '9.9.9' }), onMessage: { addListener: (fn) => listeners.message.push(fn) } },
    windows: { getLastFocused: async () => ({ id: 1 }) },
    tabs: {
      query: async (q) => (q.active ? tabs.filter((t) => t.active && t.windowId === q.windowId) : tabs.filter((t) => !q.url || /service-now\.com/.test(t.url))),
      get: async (id) => {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error('No tab');
        return t;
      },
      captureVisibleTab: async (windowId, opts) => (opts.format === 'png' ? 'data:image/png;base64,iVBORw0KGgo=' : 'data:image/jpeg;base64,/9j/'),
      sendMessage: async (tabId, msg) => {
        sent.push({ tabId, msg });
        if (msg.type === 'MCP_SCREENSHOT_CONSENT') return { ok: true, approved: screenshotAllowed };
        if (msg.tool === 'read_page') return { ok: true, result: { kind: 'list', title: 'Incidents', path: '/incident_list.do', list: { table: 'incident', query: '', rows: [] } } };
        if (pageAnswer) return pageAnswer(tabId, msg);
        return { ok: true, result: { echoed: msg.args } };
      },
    },
  };
  const setSettings = (patch) => {
    Object.assign(settings, patch);
    for (const fn of listeners.changed) fn({ mysnowbuddy_settings: {} }, 'local');
  };
  const toolNames = async () => (await request('tools/list')).result.tools.map((t) => t.name);
  try {
    const { startMcpBridge } = await import('../src/background/mcpBridge.js');
    startMcpBridge();
    for (let i = 0; i < 200 && (await toolNames()).length <= 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok((await toolNames()).includes('update_record'), 'everything is listed under the default ceiling');

    // The ceiling applies to calls at once, before the advertised list has caught up.
    setSettings({ mcpCeiling: 'observe' });
    await new Promise((r) => setTimeout(r, 20));
    const blocked = await call('update_record', { table: 'incident', sysId: SYS, fields: { state: '2' }, reason: 'x' });
    assert.equal(blocked.result.isError, true);
    assert.match(blocked.result.content[0].text, /permission ceiling \("Read only"/);
    assert.ok(!sent.some((s) => s.msg.tool === 'update_record'), 'never relayed to the page');
    for (let i = 0; i < 200 && (await toolNames()).includes('update_record'); i++) await new Promise((r) => setTimeout(r, 20));
    const names = await toolNames();
    assert.ok(!names.includes('update_record') && !names.includes('verify_script') && !names.includes('dry_run_script'));
    assert.ok(names.includes('read_page') && names.includes('screenshot') && names.includes('list_tabs') && names.includes('navigate'));

    const listed = JSON.parse((await call('list_tabs')).result.content[0].text);
    assert.deepEqual(listed.tabs.map((t) => [t.tab_id, t.instance, t.active]), [[7, 'dev1.service-now.com', true], [8, 'dev2.service-now.com', false]]);
    assert.ok(listed.tabs.every((t) => !('path' in t)), 'list_tabs never lists paths (record ids, queries)');
    assert.ok(!JSON.stringify(listed).includes('hunter2abc'), 'tab titles are redacted');

    await call('read_page', { tab_id: 8, maxRows: 3 });
    const routed = sent.at(-1);
    assert.equal(routed.tabId, 8);
    assert.deepEqual(routed.msg.args, { maxRows: 3 }, 'routing arguments are not passed to the page');
    const wrongHost = await call('read_page', { tab_id: 8, instance: 'dev1.service-now.com' });
    assert.match(wrongHost.result.content[0].text, /shows dev2/);
    const noTab = await call('read_page', { tab_id: 99 });
    assert.match(noTab.result.content[0].text, /no tab 99/i);

    const shot = await call('screenshot', {});
    assert.deepEqual(shot.result.content[0], { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
    assert.match(shot.result.content[1].text, /"tab_id": 7/);
    assert.ok(sent.some((x) => x.msg.type === 'MCP_SCREENSHOT_CONSENT' && x.tabId === 7), 'every screenshot is allowed in the tab first');
    assert.ok(!shot.result.content[1].text.includes('incident_list.do'), 'no path in the screenshot result');
    screenshotAllowed = false;
    const refused = await call('screenshot', {});
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /did not allow/);
    assert.ok(!refused.result.content.some((c) => c.type === 'image'));
    screenshotAllowed = true;
    // After a worker restart the call's tab is unknown: the cancel goes to every ServiceNow tab.
    const { withdrawCall } = await import('../src/background/mcpBridge.js');
    await withdrawCall('call-the-worker-forgot');
    const cancels = sent.filter((x) => x.msg.type === 'AGENT_TOOL_CANCEL' && x.msg.callId === 'call-the-worker-forgot');
    assert.deepEqual(cancels.map((x) => x.tabId).sort(), [7, 8]);
    const hidden = await call('screenshot', { tab_id: 8 });
    assert.equal(hidden.result.isError, true);
    assert.match(hidden.result.content[0].text, /not the visible tab/);

    // A tool that answers and then reloads the tab gets the new page appended.
    setSettings({ mcpCeiling: 'write' });
    await new Promise((r) => setTimeout(r, 20));
    pageAnswer = (_tab, msg) => (msg.tool === 'navigate' ? { ok: true, result: { opened: '/incident_list.do', pageReload: 'expected' } } : { ok: true, result: {} });
    const nav = JSON.parse((await call('navigate', { table: 'incident' })).result.content[0].text);
    assert.equal(nav.pageReload, 'expected');
    assert.equal(nav.page.kind, 'list');
    assert.equal(nav.page.list.table, 'incident');

    // The page reloads in the middle of an approved click: reported as having run, with the page now.
    pageAnswer = async (tabId, msg) => {
      if (msg.tool !== 'click_ui_action') return { ok: true, result: {} };
      if (msg.args.started) for (const fn of listeners.message) fn({ type: 'AGENT_TOOL_STARTED', callId: msg.callId }, { id: 'ext', tab: { id: tabId, url: 'https://dev1.service-now.com/incident.do' }, frameId: 0 }, () => {});
      throw new Error('The message port closed before a response was received.');
    };
    const clicked = JSON.parse((await call('click_ui_action', { action: 'Resolve', started: true })).result.content[0].text);
    assert.equal(clicked.pageReloaded, true);
    assert.equal(clicked.page.kind, 'list');
    const notStarted = await call('click_ui_action', { action: 'Resolve' });
    assert.equal(notStarted.result.isError, true);
    assert.match(notStarted.result.content[0].text, /before this call was approved/);
  } finally {
    settings.mcpBridgeEnabled = false;
    for (const fn of listeners.changed) fn({ mysnowbuddy_settings: {} }, 'local');
    await new Promise((r) => setTimeout(r, 50));
    await bridge.stop();
    stdin.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
    delete globalThis.chrome;
  }
});

test('the bridge turns a screenshot into MCP image content and rejects malformed image data', async () => {
  const { createBridge } = require('../mcp/snowbuddy-mcp.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-img-'));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stderr.resume();
  const bridge = createBridge({ port: 0, tokenPath: path.join(dir, 'token'), stdin, stdout, stderr, generatedDir: path.join(dir, 'gen'), callTimeoutMs: 3000 });
  await bridge.start();
  const lines = [];
  stdout.on('data', (c) => c.toString('utf8').split('\n').filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
  const base = `http://127.0.0.1:${bridge.port}`;
  const headers = { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' };
  const post = (p, body) => fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    await post('/v1/register', { tools: [{ name: 'screenshot', description: 'x', inputSchema: { type: 'object' }, tier: 'observe' }], instance: { host: 'dev1.service-now.com' } });
    const ask = async (id, image) => {
      stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'screenshot', arguments: {} } }) + '\n');
      const polled = await (await fetch(`${base}/v1/poll?wait=2000`, { headers })).json();
      await post('/v1/result', { id: polled.calls[0].id, ok: true, result: { tab_id: 7 }, image });
      for (let i = 0; i < 200 && !lines.some((m) => m.id === id); i++) await new Promise((r) => setTimeout(r, 10));
      return lines.find((m) => m.id === id).result;
    };
    const good = await ask(1, { data: 'iVBORw0KGgo=', mimeType: 'image/png' });
    assert.deepEqual(good.content[0], { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
    assert.equal(good.content[1].type, 'text');
    const bad = await ask(2, { data: '<svg onload=x>', mimeType: 'image/svg+xml' });
    assert.ok(!bad.content.some((c) => c.type === 'image'));
    assert.match(bad.content.at(-1).text, /could not be attached/);
    const big = { data: 'A'.repeat(3 * 1024 * 1024), mimeType: 'image/jpeg' };
    const large = await ask(3, big);
    assert.equal(large.content[0].type, 'image', 'results up to 8 MB are accepted for screenshots');
  } finally {
    await bridge.stop();
    stdin.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- read-only analysis tools (access debugger, X-ray, ship check, health scan) -----------------------

test('analysis tools are observe tier, labelled, and taught in the system prompt', () => {
  for (const name of ['explain_access', 'explain_field', 'check_update_set', 'scan_instance_health']) {
    assert.equal(toolTier(name), 'observe', name);
    assert.ok(TOOL_SCHEMAS.some((t) => t.name === name), `${name} has a schema`);
    assert.notEqual(toolIcon(name), toolIcon('no_such_tool'), `${name} has its own icon`);
    assert.ok(toolLabel(name, { table: 'incident', field: 'state', mode: 'recent', days: 7 }).length > 5, `${name} has a label`);
  }
  const prompt = buildSystemPrompt({}).text;
  assert.match(prompt, /explain_access/);
  assert.match(prompt, /scan_instance_health/);
});

test('explain_access validates input, maps "me" to the logged-in user and returns the verdict and text', async () => {
  const h = harness();
  await assert.rejects(h.tools.execute('explain_access', { table: 'incident; drop' }), /table name/);
  await assert.rejects(h.tools.execute('explain_access', { table: 'incident', sysId: 'nope' }), /sys_id/);
  const r = await h.tools.execute('explain_access', { table: 'incident', user: 'me', field: 'state', operation: 'write' });
  assert.equal(r.verdict, 'denied');
  assert.match(r.explanation, /incident\.write/);
  assert.deepEqual(h.ctl.insights.calls.at(-1), ['access', { user: '', table: 'incident', sysId: '', field: 'state', operation: 'write' }]);
});

test('explain_field defaults to the open form table and returns names, not script bodies', async () => {
  const h = harness();
  const r = await h.tools.execute('explain_field', { field: 'state' });
  assert.deepEqual(h.ctl.insights.calls.at(-1), ['field', { table: 'incident', field: 'state' }]);
  assert.equal(r.liveState.readOnly, true);
  assert.equal(r.likelyCauses[0].title, 'UI policy: Lock state');
  assert.deepEqual(r.logic.clientScripts, [{ name: 'Set state', sysId: SYS, table: undefined, reasons: ['onChange'] }]);
  assert.ok(!JSON.stringify(r).includes('a long script body'));
  await assert.rejects(h.tools.execute('explain_field', { field: 'state); x' }), /column name/);
});

test('check_update_set defaults to the current update set and leaves passed checks as titles', async () => {
  const h = harness();
  const r = await h.tools.execute('check_update_set', {});
  assert.deepEqual(h.ctl.insights.calls.at(-1), ['ship', '1'.repeat(32)]);
  assert.equal(r.verdict, 'blockers');
  assert.equal(r.checks.length, 1);
  assert.equal(r.checks[0].title, 'Default update set');
  assert.deepEqual(r.passed, ['No collisions']);
  await assert.rejects(h.tools.execute('check_update_set', { updateSet: 'Default' }), /sys_id/);
  assert.match(summarizeResult('check_update_set', r), /blockers: 1 blocker/);
});

test('scan_instance_health passes a cancel signal and returns a compact report, never every finding', async () => {
  const { buildReport } = require('../src/lib/healthScan.js');
  const findings = Array.from({ length: 45 }, (_, i) => ({
    id: `f${i}`,
    category: 'code',
    ruleId: i % 2 ? 'current-update' : 'hardcoded-sys-id',
    severity: i < 5 ? 'high' : 'medium',
    title: i % 2 ? 'current.update() in a business rule' : 'Hard-coded sys_id',
    why: 'w',
    fix: 'f',
    table: 'sys_script',
    tableLabel: 'Business rule',
    sysId: SYS,
    recordName: `BR ${i}`,
    field: 'script',
    line: i + 1,
    lines: [i + 1],
    occurrences: 1,
    excerpt: "var password = 'hunter2';",
    link: `/sys_script.do?sys_id=${SYS}`,
  }));
  const h = harness();
  h.ctl.insights.report = buildReport({ findings, steps: [], tables: [{ table: 'sys_script', status: 'scanned', records: 45, scripts: 45, lines: 900 }], options: { mode: 'instance' }, startedAt: 1, finishedAt: 2 });
  const r = await h.tools.execute('scan_instance_health', { mode: 'instance' });
  const [, opts, hadSignal] = h.ctl.insights.calls.at(-1);
  assert.equal(opts.mode, 'instance');
  assert.equal(hadSignal, true);
  assert.equal(r.findings.length, 30);
  assert.equal(r.moreFindings, 15);
  assert.equal(r.totals.high, 5);
  assert.ok(r.rules.length >= 2);
  assert.ok(!JSON.stringify(r).includes('hunter2'), 'excerpts are redacted');
  assert.match(summarizeResult('scan_instance_health', r), /5 high/);
});

test('explain_access refuses query syntax in the user argument (no javascript:, ^, = or :)', async () => {
  const h = harness();
  for (const user of ["javascript:gs.getProperty('x')", 'abel^ORuser_name=admin', 'a=b', 'x:y']) {
    await assert.rejects(h.tools.execute('explain_access', { table: 'incident', user }), /user must be/, user);
  }
  await assert.rejects(h.tools.execute('explain_access', { table: 'incident', operation: 'drop' }), /operation must be/);
  const before = h.ctl.insights.calls.length;
  await h.tools.execute('explain_access', { table: 'incident', user: "José O'Brien-Smith" });
  await h.tools.execute('explain_access', { table: 'incident', user: 'abel.tuter@example.com' });
  assert.equal(h.ctl.insights.calls.length, before + 2, 'ordinary names and emails still work');
});

// ---- safety review follow-up ----------------------------------------------------------------------------------

test('approval cards never shorten or drop a field, and the card is built from the full arguments', () => {
  const longCond = `current.state == 6 && ${'x'.repeat(500)}`;
  const info = policy.describeCall('save_artifact', { table: 'sys_script', fields: { name: 'BR', condition: longCond, filter_condition: 'active=true^assigned_to=javascript:gs.getUserID()', script: 'gs.info(1);' }, reason: 'r' });
  assert.ok(info.detail.includes(longCond), 'a long condition is shown in full');
  assert.ok(info.detail.includes('javascript:gs.getUserID()'));
  assert.ok(policy.describeCall('create_record', { table: 'sys_ui_action', fields: { script: 'y'.repeat(900) } }).detail.includes('y'.repeat(900)));
  const { newRun, reduceRun } = require('../src/lib/agent/runState.js');
  let run = reduceRun(newRun('r'), { type: 'tool_start', id: 't', tool: 'save_artifact', args: { fields: { condition: longCond } }, mode: 'ask' });
  assert.equal(run.steps[0].fullArgs.fields.condition, longCond, 'the card reads the unclipped arguments');
  assert.ok(run.steps[0].args.fields.condition.length < longCond.length, 'the saved timeline stays clipped');
  run = reduceRun(run, { type: 'tool_result', id: 't', tool: 'save_artifact', ok: true, data: {}, text: 'ok' });
  assert.equal(run.steps[0].fullArgs, undefined);
});

test('save_artifact verifies business rule conditions and javascript: values in conditions', async () => {
  const { artifactCodeChecks } = require('../src/content/agentTools.js');
  const checks = artifactCodeChecks({ script: 'a', condition: 'current.active', filter_condition: 'active=true^assigned_to=javascript:gs.getUserID()^EQ', conditions: 'x=1' }, 'business_rule');
  assert.deepEqual(checks.map((c) => [c.field, c.kind]), [['script', 'business_rule'], ['condition', 'business_rule'], ['filter_condition (javascript value 1)', 'background_script']]);
  const h = harness();
  await assert.rejects(h.tools.execute('save_artifact', { table: 'sys_script', fields: { name: 'X', condition: 'SYNTAX(' }, reason: 'r' }), /Not saved: condition has errors/);
  await assert.rejects(h.tools.execute('save_artifact', { table: 'sys_script', fields: { name: 'X', filter_condition: 'active=true^caller_id=javascript:SYNTAX(' }, reason: 'r' }), /filter_condition \(javascript value 1\) has errors/);
  assert.equal(h.calls.created.length, 0);
});

test('dry run: the script cannot reach the wrapper, and replacing an intercepted method is reported', () => {
  const vm = require('node:vm');
  const { wrapAsDryRun, DRY_RUN_TAMPER_MARK } = require('../src/lib/scriptSafety.js');
  const run = (code) => {
    const logs = [];
    const real = [];
    function GlideRecord(t) {
      this.t = t;
    }
    GlideRecord.prototype.update = function realUpdate() {
      real.push('update');
      return true;
    };
    GlideRecord.prototype.insert = function realInsert() {
      real.push('insert');
      return 'id';
    };
    GlideRecord.prototype.getTableName = function getTableName() {
      return this.t;
    };
    GlideRecord.prototype.getUniqueValue = () => 'x';
    const gs = { info: (m) => logs.push(['info', m]), error: (m) => logs.push(['error', m]) };
    vm.runInNewContext(wrapAsDryRun(code), { GlideRecord, gs });
    return { logs, real, proto: GlideRecord.prototype };
  };
  const reach = run("__saved.forEach(function (e) { e.proto[e.method] = e.original; }); new GlideRecord('incident').update();");
  assert.deepEqual(reach.real, [], 'the saved originals are out of reach of the script');
  assert.ok(reach.logs.some(([lvl, m]) => lvl === 'error' && /Script threw: ReferenceError/.test(m)));
  const normal = run("var gr = new GlideRecord('incident'); gr.update(); gr.insert();");
  assert.deepEqual(normal.real, []);
  assert.ok(normal.logs.some(([, m]) => /2 write operation\(s\) were SUPPRESSED/.test(m)));
  assert.equal(normal.proto.update.name, 'realUpdate', 'the real method is put back afterwards');
  const tamper = run("GlideRecord.prototype.update = function () { return 'mine'; }; new GlideRecord('incident').update();");
  assert.ok(tamper.logs.some(([lvl, m]) => lvl === 'error' && m.includes(DRY_RUN_TAMPER_MARK) && /update/.test(m)));
  assert.equal(tamper.proto.update.name, 'realUpdate');
});

test('auto dry runs only for provably read-only scripts; guarded instances always type the name', () => {
  const { checkReadOnlyScript, analyzeScriptRisk } = require('../src/lib/scriptSafety.js');
  const read = "var gr = new GlideRecord('incident');\ngr.addQuery('active', true);\ngr.query();\nwhile (gr.next()) { gs.info(gr.getValue('number')); }";
  assert.equal(checkReadOnlyScript(read).safe, true, checkReadOnlyScript(read).reasons.join());
  const sneaky = [
    "var g = gs; g.setProperty('a', 'b');",
    "gs['setProperty']('a', 'b');",
    "var x = 'setProperty'; gs[x]('a','b');",
    "new GlideHTTPRequest('https://x').get();",
    "new sn_ws.RESTMessageV2('a', 'b').execute();",
    "gs.eventQueueScheduled('e', null, '', '', new GlideDateTime());",
    "gs.getSession().impersonate('abc');",
    "eval('gs.setProperty(1,2)');",
    '__saved.length = 0;',
    "var r = GlideRecord; var g = new r('incident'); g.deleteMultiple();",
    "var gr = new GlideRecord('incident'); gr.query(); gr.setValue('state', 7); gr.update();",
    "var a = 1\n* gs.setProperty('x', 'y')",
  ];
  for (const code of sneaky) {
    assert.equal(checkReadOnlyScript(code).safe, false, code);
    assert.equal(policy.approvalMode({ tool: 'dry_run_script', args: { code }, autonomy: 'auto-runs' }), 'ask', code);
  }
  assert.ok(analyzeScriptRisk("var a = 1\n* gs.setProperty('x', 'y')").hasUninterceptedWrites, 'a line starting with * is code, not a comment');
  assert.ok(analyzeScriptRisk("var g = gs;\ng.setProperty('a', 'b');").hasUninterceptedWrites, 'aliasing does not hide a property write');
  assert.ok(analyzeScriptRisk("gs['setProperty']('a', 'b');").hasUninterceptedWrites);
  assert.ok(!analyzeScriptRisk("// gs.setProperty('a','b')\n/* gs.setProperty() */\ngs.info('setProperty in a message');").hasWrites);
  assert.equal(policy.approvalMode({ tool: 'dry_run_script', args: { code: read }, autonomy: 'auto-runs' }), 'auto');
  assert.equal(policy.approvalMode({ tool: 'dry_run_script', args: { code: read }, autonomy: 'auto-runs', isProd: true }), 'ask-strong');
  assert.equal(policy.approvalMode({ tool: 'dry_run_script', args: { code: read }, isProd: true }), 'ask-strong');
});

test('every dry run is audited, and a tampered run is flagged and not counted as dry-run', async () => {
  const { DRY_RUN_TAMPER_MARK } = require('../src/lib/scriptSafety.js');
  const h = harness({ runBackgroundScript: async () => `*** Script: ${DRY_RUN_TAMPER_MARK}: the script replaced update` });
  const r = await h.tools.execute('dry_run_script', { code: "gs.info('x');" });
  assert.equal(r.tampered, true);
  assert.match(r.note, /may have been REAL/);
  const entry = (await h.audit.load())[0];
  assert.equal(entry.tool, 'dry_run_script');
  assert.equal(entry.ok, false);
  const card = await h.tools.preview('run_background_script', { code: "gs.info('x');", reason: 'r' });
  assert.ok(card.warnings.some((w) => /not been dry-run/.test(w)), 'a tampered dry run does not count');
  const ok = harness();
  await ok.tools.execute('dry_run_script', { code: "gs.info('x');" });
  assert.equal((await ok.audit.load())[0].ok, true);
});

test('a parent table name cannot hide what a record really is (delete, update)', async () => {
  const h = harness();
  const COL = '1a'.repeat(16);
  h.db.sys_metadata = [{ sys_id: COL, sys_class_name: 'sys_dictionary', name: 'incident' }];
  h.db.sys_dictionary = [{ sys_id: COL, sys_class_name: 'sys_dictionary', name: 'incident', element: 'u_x' }];
  await assert.rejects(h.tools.execute('delete_record', { table: 'sys_metadata', sysId: COL, reason: 'x' }), /drops the column/);
  assert.match((await h.tools.preview('delete_record', { table: 'sys_metadata', sysId: COL, reason: 'x' })).blocked, /drops the column/);
  const APP = '2b'.repeat(16);
  h.db.sys_package = [{ sys_id: APP, sys_class_name: 'sys_app', name: 'My app' }];
  await assert.rejects(h.tools.execute('delete_record', { table: 'sys_package', sysId: APP, reason: 'x' }), /removes everything/);
  assert.equal(h.calls.deleted.length, 0);

  h.db.task = [{ sys_id: SYS, sys_class_name: 'incident', number: 'INC0001' }];
  const card = await h.tools.preview('delete_record', { table: 'task', sysId: SYS, reason: 'dup' });
  assert.match(card.target, /^incident INC0001 \(named as task\)/);
  assert.ok(card.fieldList.some((f) => f.field === 'state'), 'the card lists the fields of the real class');
  const upd = await h.tools.execute('update_record', { table: 'task', sysId: SYS, fields: { state: '2' }, reason: 'r' });
  assert.equal(upd.table, 'incident');
  assert.equal(h.calls.updated.at(-1).t, 'incident');
  const r = await h.tools.execute('delete_record', { table: 'task', sysId: SYS, reason: 'dup' });
  assert.equal(r.table, 'incident');
  assert.deepEqual(h.calls.deleted.at(-1), { t: 'incident', id: SYS });
  const undo = (await h.audit.load())[0].undo;
  assert.equal(undo.table, 'incident');
  assert.equal(undo.snapshot.state, '2', 'child-table fields are kept for undo');
});

test('the delete card names what undo cannot restore, and says when there is no undo', async () => {
  const h = harness();
  h.db.incident[0].close_notes = "password = 'Sup3rS3cret99'";
  const card = await h.tools.preview('delete_record', { table: 'incident', sysId: SYS, reason: 'x' });
  assert.match(card.undo, /Not kept, so not restored: .*u_pin \(password field\).*close_notes \(contains a secret\)/);
  assert.ok(!card.fieldList.some((f) => f.field === 'u_pin'));
  h.db.incident[0].close_notes = 'x'.repeat(250000);
  const big = await h.tools.preview('delete_record', { table: 'incident', sysId: SYS, reason: 'x' });
  assert.match(big.undo, /No undo: the record is too large/);
});

test('undo obeys the write rules and only undoes the change that was approved', async () => {
  const h = harness();
  await h.tools.execute('create_record', { table: 'sys_user', fields: { user_name: 'temp', name: 'Temp' }, reason: 'r' });
  assert.match((await h.tools.preview('undo_last_write', {})).blocked, /Deactivate users/);
  await assert.rejects(h.tools.execute('undo_last_write', {}), /Not undone: Deactivate users/);
  assert.equal(h.calls.deleted.length, 0, 'undo never deletes what the policy forbids deleting');

  const h2 = harness();
  await h2.tools.execute('update_record', { table: 'incident', sysId: SYS, fields: { state: '2' }, reason: 'r' });
  const card = await h2.tools.preview('undo_last_write', {});
  await h2.audit.record({ instance: 'dev1.service-now.com', tool: 'update_record', ok: true, summary: 'another tab', undo: { kind: 'record', table: 'incident', sysId: SYS, previous: { state: '2' } } });
  await assert.rejects(h2.tools.execute('undo_last_write', {}), /no longer the one that was approved/);
  await assert.rejects(h2.tools.execute('undo_last_write', { entryId: card.entryId }), /no longer the one/);

  const h3 = harness({ getInstanceInfo: () => ({ host: 'dev1.service-now.com', instance: 'dev1', env: 'prod' }) });
  await h3.tools.execute('update_record', { table: 'incident', sysId: SYS, fields: { state: '2' }, reason: 'r' });
  const asked = [];
  const declined = await h3.tools.undoWithApproval(async (req) => (asked.push(req), { approved: false }));
  assert.equal(declined.undone, null);
  assert.equal(asked[0].mode, 'ask-strong', '/undo on a guarded instance needs the typed name');
  assert.equal(asked[0].source, 'user');
  assert.equal(h3.db.incident[0].state, '2');
  const done = await h3.tools.undoWithApproval(async () => ({ approved: true }));
  assert.match(done.undone, /Updated incident/);
  assert.equal(h3.db.incident[0].state, '1');
});

test('navigate: encoded, doubled and cased variants are judged like the plain path; portals must exist', async () => {
  const refused = [
    ['/now//nav/ui/classic/params/target/logout.do', /needs sys_id/],
    ['/now/NAV/ui/classic/params/target/logout.do', /needs sys_id/],
    ['/now/nav/ui/classic/params/target%2Flogout.do', /needs sys_id/],
    ['/now/x/params/target/logout.do', /unexpected way/],
    ['/now/nav/ui/classic/params/target/incident.do%253Fsys_id%253D-1', /encoded twice/],
    ['/logout?id=1', /not a page view/],
    ['/xmlhttp?id=1', /not a page view/],
    ['/%6cogout.do', /needs sys_id/],
  ];
  for (const [p, re] of refused) assert.throws(() => control.classifyPath(p), re, p);
  assert.equal(control.classifyPath('/now/nav/ui/classic/params/target/LOGOUT_list.do').table, 'logout', 'lower-cased, so the table check sees it');
  assert.equal(control.classifyPath('/sp?id=index').needsPortalCheck, false);
  assert.equal(control.classifyPath('/myportal?id=index').needsPortalCheck, true);
  const h = harness();
  h.ctl.portalExists = async (s) => s === 'myportal';
  assert.equal((await h.tools.execute('navigate', { path: '/myportal?id=index' })).pageReload, 'expected');
  await assert.rejects(h.tools.execute('navigate', { path: '/nosuch?id=index' }), /not a portal/);
  await assert.rejects(h.tools.execute('navigate', { path: '/now/nav/ui/classic/params/target/logout_list.do' }), /no table "logout"/);
});

test('navigate asks the person before leaving a workspace or portal form', async () => {
  const h = harness();
  h.status.table = null; // no classic g_form on screen
  h.ctl.page.currentPath = () => `/now/sow/record/incident/${SYS}`;
  await assert.rejects(h.tools.execute('navigate', { table: 'incident' }), /cannot see/);
  const asks = [];
  let answer = false;
  h.ctl.confirm = async (req) => (asks.push(req), { approved: answer });
  await assert.rejects(h.tools.execute('navigate', { table: 'incident' }, { callId: 'c9', source: 'mcp' }), /chose to stay/);
  assert.equal(asks[0].id, 'c9', 'an MCP cancel can withdraw the question');
  assert.equal(h.calls.navigateFrame.length + h.calls.navigateTop.length, 0);
  answer = true;
  await h.tools.execute('navigate', { table: 'incident' });
  assert.equal(h.calls.navigateFrame.length, 1);
});

test('the PROD guard: a production label raises the guard and never lowers it', () => {
  assert.deepEqual(policy.instanceGuard({ env: 'test', label: 'Finance PROD' }), { env: 'prod', guarded: true, raisedByLabel: true });
  assert.equal(policy.instanceGuard({ env: 'prod', label: 'DEV' }).env, 'prod');
  assert.equal(policy.instanceGuard({ env: 'dev', label: 'Sandbox' }).guarded, false);
  assert.equal(policy.instanceGuard({ env: 'dev', label: 'acmeprod' }).guarded, true);
  const saved = globalThis.window;
  globalThis.window = { location: { hostname: 'qa-financial.service-now.com' } };
  const qa = require('../src/content/quickActions.js');
  try {
    assert.equal(qa.getInstanceInfo().env, 'test');
    qa.rememberKnownInstances([{ host: 'qa-financial.service-now.com', label: 'Finance PROD' }]);
    assert.equal(qa.getInstanceInfo().env, 'prod');
    assert.equal(qa.getInstanceInfo().guarded, true);
    assert.equal(policy.isGuardedEnv(qa.getInstanceInfo().env), true, 'every writer that reads env inherits it');
    qa.rememberKnownInstances([{ host: 'qa-financial.service-now.com', label: 'dev box' }]);
    assert.equal(qa.getInstanceInfo().env, 'test', 'a label never lowers the hostname guess');
  } finally {
    qa.rememberKnownInstances([]);
    globalThis.window = saved;
  }
});

test('set_form_field follows the table and field rules and keeps no secret in its undo', async () => {
  const h = harness();
  await assert.rejects(h.tools.execute('set_form_field', { name: 'u_pin', value: '1234' }), /password field/);
  await assert.rejects(h.tools.execute('set_form_field', { name: 'u_api_key', value: 'x' }), /password or secret/);
  h.form.context.table = 'oauth_credential';
  await assert.rejects(h.tools.execute('set_form_field', { name: 'name', value: 'x' }), /credentials/);
  h.form.context.table = 'incident';
  h.form.previous = "var password = 'Hunter22Secret';";
  const r = await h.tools.execute('set_form_field', { name: 'close_notes', value: 'done' });
  assert.match(r.note, /held a secret/);
  assert.equal((await h.audit.load())[0].undo, null, 'the secret is not stored for undo');
  h.form.previous = 'plain';
  await h.tools.execute('set_form_field', { name: 'close_notes', value: 'done2' });
  assert.equal((await h.audit.load())[0].undo.value, 'plain');
  assert.match((await h.tools.preview('set_form_field', { name: 'u_pin', value: '1' })).blocked, /password field/);
});

test('secrets are hidden by row name and by field type in query_table and the form tools', async () => {
  const h = harness();
  const q = await h.tools.execute('query_table', { table: 'sys_properties', query: 'name=x.api_key', fields: ['value'] });
  assert.deepEqual(q.rows, [{ value: '[REDACTED]' }], 'the name is fetched to decide, then stripped again');
  const all = await h.tools.execute('query_table', { table: 'sys_properties', query: '', fields: ['name', 'value'] });
  assert.equal(all.rows.find((r) => r.name === 'glide.ui.title').value, 'My Instance');
  assert.equal(all.rows.find((r) => r.name === 'x.harmless').value, '[REDACTED]', 'a password-typed property with a harmless name');
  assert.ok(all.rows.every((r) => !('type' in r)));
  const model = await h.tools.execute('get_form_model', {});
  assert.equal(model.fields.find((f) => f.name === 'u_pin').value, '[hidden]');
  assert.equal(model.fields.find((f) => f.name === 'number').value, 'INC0001');
  assert.equal((await h.tools.execute('get_field_state', { name: 'u_pin' })).value, '[hidden]');
  assert.equal((await h.tools.execute('get_field_state', { name: 'number' })).value, 'shown');
});

test('the bridge never says "nothing was changed" about a call that had started', async () => {
  const { createBridge } = require('../mcp/snowbuddy-mcp.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-start-'));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stderr.resume();
  const bridge = createBridge({ port: 0, tokenPath: path.join(dir, 'token'), stdin, stdout, stderr, generatedDir: path.join(dir, 'gen'), callTimeoutMs: 200, execTimeoutMs: 400 });
  await bridge.start();
  const lines = [];
  stdout.on('data', (c) => c.toString('utf8').split('\n').filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
  const base = `http://127.0.0.1:${bridge.port}`;
  const headers = { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' };
  const post = (p, body) => fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
  const ask = async (id, started) => {
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'update_record', arguments: {} } }) + '\n');
    const polled = await (await fetch(`${base}/v1/poll?wait=1000`, { headers })).json();
    if (started) assert.equal((await post('/v1/started', { id: polled.calls[0].id })).status, 200);
    for (let i = 0; i < 300 && !lines.some((m) => m.id === id); i++) await new Promise((r) => setTimeout(r, 10));
    return lines.find((m) => m.id === id).result.content[0].text;
  };
  try {
    await post('/v1/register', { tools: [{ name: 'update_record', description: 'x', inputSchema: { type: 'object' }, tier: 'write' }], instance: { host: 'dev1.service-now.com' } });
    const startedText = await ask(1, true);
    assert.match(startedText, /may have run/);
    assert.doesNotMatch(startedText, /nothing was changed|did not run/);
    const waitingText = await ask(2, false);
    assert.match(waitingText, /did not run/);
    assert.equal((await post('/v1/started', { id: 'not-a-call' })).status, 404);
  } finally {
    await bridge.stop();
    stdin.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
