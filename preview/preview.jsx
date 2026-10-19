// Dev-only harness (not shipped): mounts the REAL sidebar inside a shadow root
// with a faked chrome.* API, a scripted "model" and canned ServiceNow data, so
// the UI, the agent loop, the approval flow and the real tool executor can be
// exercised and looked at in a plain browser tab. Run: npm run preview
//
// URL parameters: theme=light|dark, scenario=client|server, env=dev|prod, autonomy=...,
// open=<panel name>|api|bench, q=<panel args>, width=<sidebar px>, page=form|list (the fake
// page behind the sidebar), record=<table>:<sys_id> (page context; default the incident).
// The panels' content services talk to a fake instance (preview/fakeInstance.js).
import { installFakeInstance, renderFakePage, sid } from './fakeInstance.js';
import { FEATURE_SERVICES } from '../src/content/featureServices.js';
import { fetchLiveUpdateSets, findCollisions, findUncapturedChanges } from '../src/content/updateSets.js';
import { fetchTableFields, fetchTableInfo, fetchColumnDetail, fetchListLayout } from '../src/content/fieldInspector.js';
import { listInstances } from '../src/content/stores.js';
import { installXray } from '../src/content/xray.js';
import { installInline } from '../src/content/inline.js';
import { createPopover } from '../src/content/popover.js';
import { createToastHost } from '../src/content/toast.js';
import { createCommandPalette } from '../src/content/commandPalette.js';
import { createWelcome } from '../src/content/welcome.js';
import { createGuide } from '../src/content/guide.js';
import { lintScript } from '../src/lib/lint.js';
import { attachUiRoot, UI_HOST_ID } from '../src/content/uiRoot.js';
import { writeGuard, flatValue } from '../src/lib/pushArtifact.js';
import { mountSidebar } from '../src/sidebar/mount.js';
import { createAgentTools } from '../src/content/agentTools.js';
import { createAudit } from '../src/lib/agent/audit.js';
import { runClientScript } from '../src/lib/mockForm.js';
import { wrapAsDryRun } from '../src/lib/scriptSafety.js';

const params = new URLSearchParams(location.search);
const THEME = params.get('theme') || 'light';
const SCENARIO = params.get('scenario') || 'client';
const ENV = params.get('env') || 'dev';

installFakeInstance();
renderFakePage(document.querySelector('.fake') || document.body);

// ---------------------------------------------------------------- instance data
const INSTANCE = {
  dev: { host: 'dev12345.service-now.com', instance: 'dev12345', label: 'DEV', tone: 'ok', env: 'dev' },
  prod: { host: 'acmeprod.service-now.com', instance: 'acmeprod', label: 'PROD', tone: 'danger', env: 'prod' },
}[ENV];

const INCIDENT_FIELDS = [
  ['number', 'Number', 'string', 40], ['caller_id', 'Caller', 'reference', 32, 'sys_user'], ['category', 'Category', 'string', 40],
  ['subcategory', 'Subcategory', 'string', 40], ['short_description', 'Short description', 'string', 160, null, true],
  ['description', 'Description', 'string', 4000], ['priority', 'Priority', 'integer', 40], ['impact', 'Impact', 'integer', 40],
  ['urgency', 'Urgency', 'integer', 40], ['state', 'State', 'integer', 40], ['assignment_group', 'Assignment group', 'reference', 32, 'sys_user_group'],
  ['assigned_to', 'Assigned to', 'reference', 32, 'sys_user'], ['u_phone', 'Contact phone', 'string', 40], ['sys_id', 'Sys ID', 'GUID', 32],
].map(([name, label, type, maxLength, reference, mandatory]) => ({ name, label, type, maxLength, reference, mandatory: Boolean(mandatory), readOnly: false }));

const SYS_SCRIPT_CLIENT_FIELDS = ['name', 'table', 'type', 'field', 'script', 'active', 'ui_type', 'global', 'description', 'sys_scope'].map((name) => ({ name, label: name, type: 'string' }));

const SCHEMAS = {
  incident: { tables: ['incident', 'task'], fields: INCIDENT_FIELDS },
  sys_script_client: { tables: ['sys_script_client'], fields: SYS_SCRIPT_CLIENT_FIELDS },
};

const FORM_VALUES = { number: 'INC0010042', caller_id: 'a8f98bb0eb32010045e1a5115206fe3a', category: 'hardware', short_description: 'Laptop will not boot', priority: '2', impact: '2', urgency: '2', state: '2', assignment_group: '', u_phone: '' };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fake chrome
const memory = {};
const store = {
  get: async (keys) => {
    if (keys === null || keys === undefined) return { ...memory };
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => k in memory).map((k) => [k, memory[k]]));
  },
  set: async (obj) => void Object.assign(memory, obj),
};
Object.assign(memory, {
  mysnowbuddy_settings: { theme: THEME, agentEnabled: true, agentAutonomy: params.get('autonomy') || 'ask' },
  mysnowbuddy_known_instances: [
    { id: 'i1', label: 'TEST', host: 'acmetest.service-now.com' },
    { id: 'i2', label: 'PROD', host: 'acmeprod.service-now.com' },
  ],
});
if (params.get('width')) memory.mysnowbuddy_sidebar_width = Number(params.get('width'));

// Push to another instance: the "other instance" holds an older copy of the record.
function fakePushPreview({ targetUrl, table, sourceRecord }) {
  const targetHost = String(targetUrl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const source = sourceRecord || {};
  const target = { ...source, sys_updated_on: '2026-09-01 10:00:00', sys_updated_by: 'admin' };
  if ('script' in target) target.script = String(source.script || '').replace(/getRowCount\(\)/, 'getRowCount() || 0').replace(/\n\ttype:/, '\n\t// v1\n\ttype:');
  if ('description' in target) target.description = 'Incident helpers (v1)';
  if ('client_callable' in target) target.client_callable = 'false';
  const label = targetHost.startsWith('acmeprod') ? 'PROD' : 'TEST';
  return {
    ok: true,
    source,
    sourceHost: location.hostname,
    targetHost,
    targetLabel: label,
    guard: writeGuard({ host: targetHost, label }),
    target: params.get('pushnew') === '1' ? null : params.get('pushcase') === '1' ? { ...target, sys_id: 'f00dfeedf00dfeedf00dfeedf00dfeed', name: String(source.name || '').toLowerCase() } : target,
    matchedBy: params.get('pushnew') === '1' ? null : params.get('pushcase') === '1' ? 'name' : 'sys_id',
    matchKeys: params.get('pushcase') === '1' ? ['name'] : null,
    nameCaseDiffers: params.get('pushcase') === '1',
    session: { userName: 'maria.dev', updateSet: { name: 'STRY0012 Incident P1 handling', state: 'in progress' } },
    table,
  };
}

const listeners = [];
function sandbox(payload) {
  if (payload.action === 'syntax') {
    try {
      // eslint-disable-next-line no-new-func
      new Function(payload.code);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: true, error: { message: err.message } };
    }
  }
  return runClientScript({ code: payload.code, clientType: payload.clientType, scenario: payload.scenario }).then((run) => ({ ok: true, run }));
}

// --- scripted model ---------------------------------------------------------------------
const BAD_SCRIPT = `function onChange(control, oldValue, newValue, isLoading, isTemplate) {
  if (isLoading || newValue === '') { return; }
  if (newValue === '1') {
    g_form.setMandatroy('assignment_group', true);
    g_form.addInfoMessage('P1: assignment group is required.');
  } else {
    g_form.setMandatory('assignment_group', false);
  }
}`;
const GOOD_SCRIPT = BAD_SCRIPT.replace('setMandatroy', 'setMandatory');
const SCENARIO_TEST = { table: 'incident', changedField: 'priority', oldValue: '3', newValue: '1', fields: { priority: { value: '3' }, assignment_group: { value: '' } } };

const call = (id, name, args) => ({ id, name, args });

function scriptedReply(messages) {
  const lastUser = [...messages].map((m, i) => ({ m, i })).filter(({ m }) => m.role === 'user').pop();
  const since = messages.slice(lastUser.i + 1);
  const step = since.filter((m) => m.role === 'assistant').length;
  const goal = String(lastUser.m.content).toLowerCase();

  if (SCENARIO === 'server' || /business rule|duplicate/.test(goal)) {
    const script = `(function executeRule(current, previous /*null when async*/) {\n  var gr = new GlideRecord('incident');\n  gr.addQuery('caller_id', current.getValue('caller_id'));\n  gr.addQuery('short_description', current.getValue('short_description'));\n  gr.addActiveQuery();\n  gr.setLimit(1);\n  gr.query();\n  if (gr.next()) {\n    gs.addErrorMessage('A matching open incident already exists: ' + gr.getValue('number'));\n    current.setAbortAction(true);\n  }\n})(current, previous);`;
    if (step === 0) return { content: 'I will read the real fields first, then draft the rule.', toolCalls: [call('s1', 'get_schema', { table: 'incident' }), call('s2', 'list_logic_for_table', { table: 'incident', kind: 'server' })] };
    if (step === 1) return { content: '', toolCalls: [call('s3', 'verify_script', { code: script, kind: 'business_rule', when: 'before', table: 'incident' })] };
    return { content: `A **before** rule is the right place: it can stop the save.\n\n\`\`\`javascript\n${script}\n\`\`\`\n\nConfiguration: Table \`incident\`, When \`before\`, Insert \`true\`, Order \`100\`. It verified clean against the API catalog and the incident dictionary.`, toolCalls: [] };
  }

  if (step === 0) {
    return { content: 'I will see what already runs on this table and read the real field names.', toolCalls: [call('c1', 'get_page_context', {}), call('c2', 'list_logic_for_table', { table: 'incident', kind: 'client' }), call('c3', 'get_schema', { table: 'incident' })] };
  }
  if (step === 1) return { content: 'Nothing conflicts. Drafting an onChange script and verifying it.', toolCalls: [call('c4', 'verify_script', { code: BAD_SCRIPT, kind: 'client_script', clientType: 'onChange', table: 'incident' })] };
  if (step === 2) return { content: 'The verifier caught a misspelled method. Fixing it.', toolCalls: [call('c5', 'verify_script', { code: GOOD_SCRIPT, kind: 'client_script', clientType: 'onChange', table: 'incident' })] };
  if (step === 3) return { content: 'Clean. Simulating a priority change to 1.', toolCalls: [call('c6', 'test_client_script', { code: GOOD_SCRIPT, clientType: 'onChange', scenario: SCENARIO_TEST })] };
  if (step === 4) {
    return {
      content: 'It behaves as intended. Saving it as an inactive client script so you can review it.',
      toolCalls: [call('c7', 'save_artifact', { table: 'sys_script_client', reason: 'Require an assignment group when priority becomes 1.', fields: { name: 'Incident - require group on P1', table: 'incident', type: 'onChange', field: 'priority', active: false, ui_type: '0', script: GOOD_SCRIPT } })],
    };
  }
  return {
    content: `Done. I created **Incident - require group on P1** (inactive) on \`incident\`:\n\n\`\`\`javascript\n${GOOD_SCRIPT}\n\`\`\`\n\nTo go live, open the record and tick **Active**. Verified against the API catalog and the incident dictionary, and simulated with priority 3 -> 1.`,
    toolCalls: [],
  };
}

window.chrome = {
  runtime: {
    id: 'preview',
    getURL: (p) => p,
    sendMessage: async (message) => {
      await wait(message.type === 'AGENT_STEP' ? 650 : 5);
      switch (message.type) {
        case 'GET_PROVIDER_INFO':
          return { ok: true, provider: 'anthropic', label: 'Anthropic (Claude)', model: 'claude-opus-5-5', modelLabel: 'Claude Opus 5.5', hasKey: params.get('nokey') !== '1' };
        case 'AGENT_STEP':
          return { ok: true, reply: { ...scriptedReply(message.payload.messages), stopReason: 'tool_use', usage: {} }, provider: 'anthropic', model: 'claude-opus-5-5' };
        case 'SANDBOX_RUN':
          return sandbox(message.payload);
        case 'CHAT_COMPLETION':
          return { ok: true, content: 'This is the plain chat path.' };
        case 'PUSH_PREVIEW':
          await wait(300);
          return fakePushPreview(message.payload);
        case 'PUSH_ARTIFACT': {
          await wait(300);
          const { targetUrl, table, mode, targetSysId, fields } = message.payload;
          const host = String(targetUrl).replace(/^https?:\/\//, '');
          const sysId = targetSysId || flatValue(fields.sys_id);
          return { ok: true, host, sysId, url: `https://${host}/${table}.do?sys_id=${sysId}`, auth: 'session', mode, written: Object.keys(fields).filter((k) => k !== 'sys_id'), mismatched: [], keptSysId: mode === 'create' ? true : null };
        }
        default:
          return { ok: true };
      }
    },
    onMessage: { addListener() {}, removeListener() {} },
    openOptionsPage: async () => {},
  },
  storage: {
    local: store,
    sync: store,
    session: store,
    onChanged: { addListener() {}, removeListener() {} },
  },
};

// ---------------------------------------------------------------- fake ServiceNow
const audit = createAudit({ get: async (k) => memory[k], set: async (k, v) => void (memory[k] = v) });
const formState = { ...FORM_VALUES };

const callPage = async (action, args = []) => {
  switch (action) {
    case 'getFormMeta':
      return { table: 'incident', sysId: '9de5069c0b0f0300b8b9e5cd35673a5b', isNewRecord: false };
    case 'getFormModel':
      return {
        table: 'incident',
        sysId: '9de5069c0b0f0300b8b9e5cd35673a5b',
        isNewRecord: false,
        fieldCount: INCIDENT_FIELDS.length,
        fields: INCIDENT_FIELDS.map((f) => ({ name: f.name, label: f.label, value: formState[f.name] ?? '', mandatory: f.mandatory, readOnly: false, visible: true })),
        user: { userName: 'abel.tuter' },
      };
    case 'getFieldState':
      return { name: args[0], value: formState[args[0]] ?? '', label: args[0], mandatory: false, readOnly: false, visible: true };
    case 'setFieldValue': {
      const previous = formState[args[0]] ?? '';
      formState[args[0]] = args[1];
      return { previous };
    }
    default:
      return null;
  }
};

const agentTools = createAgentTools({
  getContext: () => ({ table: 'incident', sysId: '9de5069c0b0f0300b8b9e5cd35673a5b', isList: false, selection: '', scriptBody: null, scriptFieldLabel: null }),
  getInstanceInfo: () => INSTANCE,
  callPage,
  queryTable: async (table, query) => {
    if (table === 'sys_script_client') return [{ name: 'Incident - set category defaults', table: 'incident', type: 'onLoad', field: '', active: 'true', ui_type: '0' }];
    if (table === 'sys_ui_policy') return [{ short_description: 'Incident - hide cause when open', table: 'incident', active: 'true', on_load: 'true', run_scripts: 'false', conditions: 'state!=7' }];
    if (table === 'sys_ui_action') return [{ name: 'Resolve Incident', table: 'incident', action_name: 'resolve', active: 'true' }];
    if (table === 'sys_script') return [{ name: 'incident autoclose', collection: 'incident', when: 'before', order: '100', active: 'true' }];
    return [];
  },
  fetchRecord: async () => null,
  countRecords: async () => 42,
  createRecord: async (table, fields) => ({ sys_id: 'f1e2d3c4b5a697887766554433221100', ...fields }),
  updateRecord: async (table, sysId, fields) => ({ sys_id: sysId, ...fields }),
  deleteRecord: async () => null,
  fetchTableFields: async (table) => {
    await wait(120);
    if (!SCHEMAS[table]) throw new Error(`Table ${table} was not found.`);
    return SCHEMAS[table];
  },
  tableHierarchy: async (t) => (t === 'incident' ? ['incident', 'task'] : [t]),
  searchCode: async (term) => ({ term, totalRecords: 0, totalMatches: 0, errors: [], results: [] }),
  fetchLogs: async () => ({ groups: [], slow: [], minutes: 60, total: 0 }),
  runBackgroundScript: async (script) => `<pre>*** Script: [dry run] done\n${script.length} chars</pre>`,
  getCsrfToken: async () => 'token',
  wrapAsDryRun,
  extractScriptOutput: (html) => html.replace(/<[^>]+>/g, ''),
  runSandbox: (payload) => chrome.runtime.sendMessage({ type: 'SANDBOX_RUN', payload }),
  runAutomation: async () => undefined,
  subscribeAutomation: () => () => {},
  getCurrentUpdateSet: async () => ({ sysId: 'x', name: 'Incident improvements' }),
  recordUrl: (t, id) => `/${t}.do?sys_id=${id}`,
  audit,
});

// ---------------------------------------------------------------- mount
const host = document.createElement('div');
host.id = UI_HOST_ID;
if (THEME === 'dark' || THEME === 'light') host.setAttribute('data-theme', THEME);
document.body.appendChild(host);
// Closed, as in the extension: reach the UI through window.__msb.shadow (below), not host.shadowRoot.
const shadow = attachUiRoot(host);
const link = document.createElement('link');
link.rel = 'stylesheet';
link.href = 'content.css';
shadow.appendChild(link);
const container = document.createElement('div');
shadow.appendChild(container);

// ?record=sys_script_include:IncidentUtils (a fixture key) or <table>:<sys_id> sets the page context.
const [recordTable, recordKey] = (params.get('record') || '').split(':');
const recordSysId = recordKey && !/^[0-9a-f]{32}$/.test(recordKey) ? sid(`${recordTable}:${recordKey}`) : recordKey;
const context = () =>
  recordTable
    ? { table: recordTable, sysId: recordSysId, isList: false, selection: '', scriptBody: null, scriptFieldLabel: null, title: recordKey }
    : params.get('page') === 'list'
      ? { table: 'incident', sysId: '', isList: true, selection: '', scriptBody: null, scriptFieldLabel: null }
      : { table: 'incident', sysId: '9de5069c0b0f0300b8b9e5cd35673a5b', isList: false, selection: '', scriptBody: null, scriptFieldLabel: null };
const api = mountSidebar(container, { getContext: context, instance: INSTANCE, onOpenPalette: () => {} });
api.registerServices({
  // Feature panels (panelRegistry.js) and the built-ins they lean on, backed by preview/fakeInstance.js.
  ...FEATURE_SERVICES,
  fetchLiveUpdateSets: () => fetchLiveUpdateSets(),
  findCollisions: (setId) => findCollisions(setId),
  findUncapturedChanges: (options) => findUncapturedChanges(options),
  fetchTableFields: (table) => fetchTableFields(table),
  fetchTableInfo: (table) => fetchTableInfo(table),
  fetchColumnDetail: (table, element) => fetchColumnDetail(table, element),
  fetchListLayout: (table) => fetchListLayout(table),
  listInstances: () => listInstances(),
  agentExecute: (name, args) => agentTools.execute(name, args),
  agentPreview: (name, args) => agentTools.preview(name, args),
  readFormScript: async () => ({ body: GOOD_SCRIPT, label: 'Script' }),
  auditList: async () => audit.load(),
  fetchArtifactRecord: async () => null,
});
api.open();
installXray({ sidebar: api });

// ?inline=1: the on-page tools (toolbar, label and column menus) over the fake classic form or list.
if (params.get('inline')) {
  history.replaceState(null, '', params.get('page') === 'list' ? '/incident_list.do?sysparm_query=active%3Dtrue' : '/incident.do?sys_id=9de5069c0b0f0300b8b9e5cd35673a5b');
  const toast = createToastHost();
  shadow.appendChild(toast.element);
  window.__toast = toast;
  installInline({ shadow, toast, sidebar: api, popover: createPopover({ shadow, toast }), openEditor: () => toast.info('Full-screen editor'), tools: { lintScript }, enabled: true });
}
// ?palette=1: the real command palette over the fake page; ?welcome=1: the first-run card; ?guide=1: the developer guide. ?scriptform=1 makes the
// fake page a script form, ?record=<table>:<key> any other record.
let palette = null;
let welcome = null;
let guide = null;
if (params.get('palette') || params.get('welcome') || params.get('guide')) {
  const toast = window.__toast || createToastHost();
  if (!window.__toast) shadow.appendChild(toast.element);
  window.__toast = toast;
  const pageContext = () => (params.get('scriptform') ? { ...context(), table: 'sys_script', scriptBody: GOOD_SCRIPT, scriptFieldLabel: 'Script' } : context());
  palette = createCommandPalette({
    getContext: pageContext,
    sidebar: api,
    toast,
    getCsrfToken: async () => 'preview',
    openScriptEditor: () => toast.info('Full-screen editor'),
    startFileSync: () => toast.info('File sync'),
    stopFileSync: () => {},
    isFileSyncActive: () => false,
    setTheme: async () => {},
    setToolSurface: async () => {},
    setInline: async () => {},
    inlineOn: () => false,
    toggleTheme: () => {},
    showWelcome: () => welcome?.show(),
    showGuide: () => guide?.show(),
    onOpenChange: () => {},
    impersonate: () => {},
    impersonateByQuery: () => {},
    impersonateUserName: () => {},
  });
  shadow.appendChild(palette.element);
  welcome = createWelcome({ shadow, openPalette: () => palette.open(), openGuide: () => guide?.show() });
  guide = createGuide({ shadow, openPalette: (text) => palette.open(text), getContext: pageContext, showTour: () => welcome?.show() });
  if (params.get('welcome')) welcome.show();
  if (params.get('guide')) guide.show();
  if (params.get('palette') === 'open') setTimeout(() => palette.open(), 300);
}
window.__msb = { api, agentTools, audit, shadow, palette, welcome, guide };

// Script the panels for screenshots: ?open=api|bench|<any panel name from panelRegistry.js>
const open = params.get('open');
if (open === 'api') setTimeout(() => api.openApiPanel(params.get('q') || ''), 50);
else if (open === 'bench') setTimeout(() => api.openTestPanel(), 50);
else if (open) setTimeout(() => api.openPanel(open, { args: params.get('q') || '' }), 50);
