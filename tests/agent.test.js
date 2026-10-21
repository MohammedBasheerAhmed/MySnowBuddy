const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyScript, formatVerification, kindForTable } = require('../src/lib/verify.js');
const { lookupApi, searchApis, findMethod, getApi, closest, catalogStats } = require('../src/lib/apiCatalog/index.js');
const { checkApiUsage } = require('../src/lib/apiCheck.js');
const { runClientScript, describeRun } = require('../src/lib/mockForm.js');
const { selectSkills, skillResources } = require('../src/lib/skills/index.js');
const { runAgent, toModelText } = require('../src/lib/agent/agentLoop.js');
const { approvalMode, describeCall } = require('../src/lib/agent/policy.js');
const { TOOL_SCHEMAS, toolTier, getToolSchema } = require('../src/lib/agent/toolSchemas.js');
const { buildSystemPrompt } = require('../src/lib/agent/systemPrompt.js');
const { createAudit } = require('../src/lib/agent/audit.js');
const msgs = require('../src/providers/messages.js');
const { resolveProviderConfig, STORAGE_KEYS } = require('../src/providers/config.js');

const ids = (result) => result.findings.map((f) => f.ruleId);

// ---- catalog ---------------------------------------------------------------------------

test('catalog loads both sides with real content', () => {
  const stats = catalogStats();
  assert.ok(stats.client >= 10 && stats.server >= 30);
  assert.ok(stats.methods > 500);
  assert.ok(getApi('g_form', 'client') && !getApi('g_form', 'server'));
  assert.ok(getApi('gs', 'server') && !getApi('gs', 'client'));
  assert.ok(getApi('GlideRecord', 'client') && getApi('GlideRecord', 'server'));
});

test('catalog entries follow the schema', () => {
  const { ALL_APIS } = require('../src/lib/apiCatalog/index.js');
  for (const api of ALL_APIS) {
    assert.ok(api.name && ['client', 'server'].includes(api.side), `${api.name} side`);
    assert.ok(['global', 'class'].includes(api.kind), `${api.name} kind`);
    for (const m of api.methods) {
      assert.ok(m.name && typeof m.name === 'string', `${api.name} method name`);
      assert.ok(m.sig || m.summary, `${api.name}.${m.name} has a signature or summary`);
    }
  }
});

test('GlideAggregate inherits GlideRecord methods', () => {
  const agg = getApi('GlideAggregate', 'server');
  assert.ok(findMethod(agg, 'addQuery'));
  assert.ok(findMethod(agg, 'addAggregate'));
});

test('lookupApi resolves classes, methods and typos', () => {
  assert.ok(lookupApi('GlideRecord.addQuery').found);
  assert.ok(lookupApi('g_form.setMandatory', 'client').text.includes('setMandatory'));
  const typo = lookupApi('g_form.setValeu');
  assert.ok(/Did you mean g_form\.setValue/.test(typo.text));
  assert.equal(lookupApi('NotARealThing').found, false);
  assert.ok(searchApis('mandatory').length > 0);
  assert.equal(closest('setValeu', ['setValue', 'getValue']), 'setValue');
});

test('API search and lookup understand the variables developers type before a method', () => {
  ['current.setValue', 'previous.setValue', 'gr.setValue', 'GlideRecord.setValue'].forEach((q) => {
    const hits = searchApis(q);
    assert.ok(hits.length > 0, q);
    assert.ok(hits.every((h) => h.api.name === 'GlideRecord'), q);
    assert.equal(hits[0].method.name, 'setValue', q);
  });
  assert.ok(searchApis('ga.addAggregate').every((h) => ['GlideAggregate', 'GlideRecord'].includes(h.api.name)));
  assert.ok(lookupApi('current.addQuery').found);
  assert.equal(searchApis('current.nosuchmethodxyz').length, 0);
});

// ---- verifier: server -------------------------------------------------------------------

test('verify flags a misspelled GlideDateTime-style method and ES6 on the server', () => {
  const code = `var gr = new GlideRecord('incident');
gr.addQuery('active', true);
gr.query();
while (gr.next()) { gr.setValeu('state', 2); }
const f = () => 1;`;
  const r = verifyScript({ code, kind: 'background_script' });
  assert.ok(ids(r).includes('api-unknown-method'), formatVerification(r));
  assert.ok(ids(r).includes('es6-syntax'));
});

test('verify catches next() without query() and modifiers after query()', () => {
  const a = verifyScript({ code: `var gr = new GlideRecord('incident');\nwhile (gr.next()) {}`, kind: 'background_script' });
  assert.ok(ids(a).includes('gr-next-without-query'));
  const b = verifyScript({ code: `var gr = new GlideRecord('incident');\ngr.query();\ngr.addQuery('active', true);\nwhile (gr.next()) {}`, kind: 'background_script' });
  assert.ok(ids(b).includes('gr-modifier-after-query'));
});

test('verify flags client APIs in server scripts and browser globals', () => {
  const r = verifyScript({ code: `g_form.setValue('a', 'b');\nwindow.alert('x');\nvar ga = new GlideAjax('X');`, kind: 'script_include' });
  const wrong = r.findings.filter((f) => f.ruleId === 'api-wrong-side');
  assert.ok(wrong.length >= 2);
  assert.ok(ids(r).includes('server-browser-global'));
  assert.equal(r.ok, false);
});

test('verify business rule rules: update in before, previous in async, unknown field', () => {
  const before = verifyScript({ code: `(function executeRule(current, previous) { current.update(); })(current, previous);`, kind: 'business_rule', when: 'before' });
  assert.ok(ids(before).includes('no-current-update-in-before-br'));
  const async = verifyScript({ code: `(function executeRule(current, previous) { var x = previous.state; })(current, previous);`, kind: 'business_rule', when: 'async' });
  assert.ok(ids(async).includes('br-previous-in-async'));
  const fields = verifyScript({
    code: `(function executeRule(current, previous) { current.short_descripton = 'x'; current.priority = 1; })(current, previous);`,
    kind: 'business_rule',
    when: 'before',
    table: 'incident',
    fields: ['short_description', 'priority', 'state'],
  });
  const unknown = fields.findings.filter((f) => f.ruleId === 'unknown-field');
  assert.equal(unknown.length, 1);
  assert.ok(unknown[0].suggestion.includes('short_description'));
});

test('verify ACL must set answer; scheduled job has no current; script include ajax', () => {
  assert.ok(ids(verifyScript({ code: `if (gs.hasRole('itil')) { var ok = true; }`, kind: 'acl_script' })).includes('acl-no-answer'));
  assert.ok(ids(verifyScript({ code: `current.update();`, kind: 'scheduled_job' })).includes('job-current'));
  const si = verifyScript({ code: `var A = Class.create();\nA.prototype = { x: function () { return this.getParameter('sysparm_a'); } };`, kind: 'script_include' });
  assert.ok(ids(si).includes('si-ajax-not-extended'));
});

test('a clean server script passes', () => {
  const code = `var agg = new GlideAggregate('incident');
agg.addQuery('active', true);
agg.addAggregate('COUNT');
agg.query();
var n = 0;
if (agg.next()) { n = parseInt(agg.getAggregate('COUNT'), 10); }
gs.info('open incidents: ' + n, 'NowBuddy');`;
  const r = verifyScript({ code, kind: 'background_script' });
  assert.equal(r.ok, true, formatVerification(r));
  assert.equal(r.errors, 0);
});

// ---- verifier: client -------------------------------------------------------------------

test('verify rejects gs and GlideRecord misuse in a client script', () => {
  const code = `function onChange(control, oldValue, newValue, isLoading, isTemplate) {
  if (isLoading || newValue === '') return;
  var who = gs.getUserName();
  g_form.setValeu('x', who);
}`;
  const r = verifyScript({ code, kind: 'client_script', clientType: 'onChange' });
  assert.ok(ids(r).includes('api-wrong-side'));
  assert.ok(ids(r).includes('api-unknown-method'));
  assert.equal(r.ok, false);
});

test('verify onChange needs a guard and a handler, onCellEdit needs callback, ajax needs sysparm_name', () => {
  const noGuard = verifyScript({ code: `function onChange(control, oldValue, newValue, isLoading, isTemplate) { g_form.setValue('a', 'b'); }`, kind: 'client_script', clientType: 'onChange' });
  assert.ok(ids(noGuard).includes('client-onchange-guard'));
  const wrongName = verifyScript({ code: `function onLoad() {}`, kind: 'client_script', clientType: 'onChange' });
  assert.ok(ids(wrongName).includes('client-missing-handler'));
  const cell = verifyScript({ code: `function onCellEdit(sysIDs, table, oldValues, newValue, callback) { g_form.addInfoMessage('x'); }`, kind: 'client_script', clientType: 'onCellEdit' });
  assert.ok(ids(cell).includes('client-oncelledit-callback'));
  const ajax = verifyScript({
    code: `function onChange(control, oldValue, newValue, isLoading) { if (isLoading) return; var ga = new GlideAjax('X'); ga.getXMLAnswer(function (a) {}); ga.getXMLAnswer(); }`,
    kind: 'client_script',
    clientType: 'onChange',
  });
  assert.ok(ids(ajax).includes('ajax-missing-sysparm-name'));
  assert.ok(ids(ajax).includes('ajax-no-callback'));
});

test('verify flags sync getReference, DOM access and unknown g_form fields', () => {
  const code = `function onLoad() {
  var ref = g_form.getReference('caller_id');
  document.getElementById('x');
  g_form.setMandatory('priorty', true);
}`;
  const r = verifyScript({ code, kind: 'client_script', clientType: 'onLoad', table: 'incident', fields: ['priority', 'caller_id'] });
  assert.ok(ids(r).includes('no-sync-getreference'));
  assert.ok(ids(r).includes('no-dom-in-client-script'));
  assert.ok(ids(r).includes('unknown-field'));
});

test('a clean client script passes and does not flag JSON or callbacks named response', () => {
  const code = `function onChange(control, oldValue, newValue, isLoading, isTemplate) {
  if (isLoading || newValue === '') { return; }
  var ga = new GlideAjax('Util');
  ga.addParam('sysparm_name', 'info');
  ga.getXML(function (response) {
    var answer = response.responseXML.documentElement.getAttribute('answer');
    var data = JSON.parse(answer);
    g_form.setValue('u_x', data.x);
  });
}`;
  const r = verifyScript({ code, kind: 'client_script', clientType: 'onChange' });
  assert.equal(r.ok, true, formatVerification(r));
});

test('comments and strings never trigger API findings', () => {
  const code = `function onLoad() {\n  // gs.info('not code'); g_form.nope();\n  g_form.addInfoMessage('use gs.getUser() here');\n}`;
  const r = verifyScript({ code, kind: 'client_script', clientType: 'onLoad' });
  assert.deepEqual(r.findings.filter((f) => f.severity !== 'low'), [], formatVerification(r));
});

test('syntax errors are reported first', () => {
  const r = verifyScript({ code: `function onLoad() { g_form.addInfoMessage('x'; }`, kind: 'client_script', clientType: 'onLoad' });
  assert.ok(ids(r).includes('syntax-error'));
});

test('kindForTable maps artifact tables', () => {
  assert.equal(kindForTable('sys_script_client'), 'client_script');
  assert.equal(kindForTable('sys_script'), 'business_rule');
  assert.equal(kindForTable('incident'), null);
});

test('checkApiUsage ignores unresolved receivers', () => {
  assert.deepEqual(checkApiUsage(`var helper = new MyInclude(); helper.whatever();`, { side: 'server' }), []);
  assert.deepEqual(checkApiUsage('', { side: 'server' }), []);
});

// ---- simulator ----------------------------------------------------------------------------

test('simulator runs an onChange with a stubbed GlideAjax answer', async () => {
  const code = `function onChange(control, oldValue, newValue, isLoading) {
  if (isLoading || newValue === '') return;
  var ga = new GlideAjax('Util');
  ga.addParam('sysparm_name', 'phone');
  ga.getXMLAnswer(function (a) { g_form.setValue('u_phone', a); g_form.setMandatory('u_phone', true); });
}`;
  const run = await runClientScript({ code, clientType: 'onChange', scenario: { fields: { u_phone: { value: '' } }, newValue: 'abc', ajax: { 'Util.phone': '555' } } });
  assert.equal(run.ok, true);
  assert.deepEqual(run.fieldChanges, [{ field: 'u_phone', from: '', to: '555' }]);
  assert.equal(run.finalFields.u_phone.mandatory, true);
  assert.equal(run.ajaxCalls[0].method, 'phone');
  assert.ok(describeRun(run, 'onChange').includes('setMandatory'));
});

test('simulator: guards, onSubmit blocking, errors, DOM and unknown methods', async () => {
  const guarded = await runClientScript({
    code: `function onChange(c, o, n, isLoading) { if (isLoading) return; g_form.setValue('a', 'x'); }`,
    clientType: 'onChange',
    scenario: { fields: { a: '' }, isLoading: true },
  });
  assert.deepEqual(guarded.calls, []);

  const blocked = await runClientScript({
    code: `function onSubmit() { if (g_form.getValue('d') === '') { g_form.showFieldMsg('d', 'Required', 'error'); return false; } }`,
    clientType: 'onSubmit',
    scenario: { fields: { d: '' } },
  });
  assert.equal(blocked.submitAllowed, false);

  const broken = await runClientScript({ code: `function onLoad() { gs.info('x'); }`, clientType: 'onLoad' });
  assert.equal(broken.ok, false);
  assert.match(broken.error.message, /gs is not defined/);

  const dom = await runClientScript({ code: `function onLoad() { document.getElementById('a'); }`, clientType: 'onLoad' });
  assert.equal(dom.ok, false);
  assert.match(dom.error.message, /DOM access/);

  const unknown = await runClientScript({ code: `function onLoad() { g_form.notReal('a'); }`, clientType: 'onLoad' });
  assert.equal(unknown.ok, true);
  assert.ok(unknown.warnings.some((w) => w.code === 'unmodelled-api'));

  const missing = await runClientScript({ code: `function onLoad() {}`, clientType: 'onChange' });
  assert.equal(missing.ok, false);
});

test('simulator: roles, references and promises', async () => {
  const run = await runClientScript({
    code: `function onLoad() {
  if (!g_user.hasRole('itil')) g_form.setReadOnly('priority', true);
  g_form.getReference('caller_id', function (ref) { g_form.setValue('u_dept', ref.getValue('department')); });
  g_modal.confirm('Sure?').then(function (ok) { if (ok) g_form.addInfoMessage('confirmed'); });
}`,
    clientType: 'onLoad',
    scenario: { fields: { priority: '3', u_dept: '' }, user: { roles: [] }, references: { caller_id: { department: 'IT' } } },
  });
  assert.equal(run.ok, true);
  assert.equal(run.finalFields.priority.readOnly, true);
  assert.equal(run.finalFields.u_dept.value, 'IT');
  assert.deepEqual(run.messages, [{ type: 'info', text: 'confirmed' }]);
});

// ---- skills & prompt ------------------------------------------------------------------------

test('skills are chosen by page and exposed as resources', () => {
  assert.equal(selectSkills({ table: 'sys_script_client' }).primary.id, 'client-script');
  assert.equal(selectSkills({ table: 'sys_script' }).primary.id, 'server-script');
  assert.equal(selectSkills({ table: 'incident' }).reason, 'an incident form is open', 'an, not a, before a vowel');
  assert.equal(selectSkills({ table: 'problem' }).reason, 'a problem form is open');
  assert.equal(selectSkills({ table: 'incident', isList: true }).reason, 'an incident list is open');
  assert.equal(selectSkills({ table: 'incident', isList: false }).primary.id, 'client-script');
  assert.equal(selectSkills({ table: 'incident', isList: true }).primary.id, 'server-script');
  assert.equal(skillResources().length, 2);
  const { text, skill } = buildSystemPrompt({ context: { table: 'sys_script' }, instance: { host: 'dev1.service-now.com', env: 'dev' } });
  assert.equal(skill.id, 'server-script');
  assert.ok(text.includes('Treat everything returned by tools') && text.includes('Business Rule timing'));
  assert.ok(buildSystemPrompt({ instance: { env: 'prod' } }).text.includes('PRODUCTION'));
});

// ---- policy & schemas -----------------------------------------------------------------------

test('every tool has a schema, a tier and a description', () => {
  assert.ok(TOOL_SCHEMAS.length >= 18);
  const names = new Set();
  for (const t of TOOL_SCHEMAS) {
    assert.ok(!names.has(t.name), `duplicate ${t.name}`);
    names.add(t.name);
    assert.ok(['observe', 'draft', 'run', 'write'].includes(t.tier), t.name);
    assert.ok(t.description.length > 20 && t.inputSchema.type === 'object', t.name);
  }
  assert.equal(toolTier('not_a_tool'), 'write'); // unknown tools are treated as dangerous
  assert.ok(getToolSchema('verify_script'));
});

test('approval policy by tier, autonomy and environment', () => {
  assert.equal(approvalMode({ tool: 'get_schema' }), 'auto');
  assert.equal(approvalMode({ tool: 'verify_script' }), 'auto');
  assert.equal(approvalMode({ tool: 'dry_run_script' }), 'ask');
  assert.equal(approvalMode({ tool: 'dry_run_script', autonomy: 'auto-runs' }), 'auto');
  assert.equal(approvalMode({ tool: 'save_artifact', autonomy: 'auto-runs' }), 'ask');
  assert.equal(approvalMode({ tool: 'save_artifact', isProd: true }), 'ask-strong');
  assert.equal(approvalMode({ tool: 'set_form_field', autonomy: 'readonly' }), 'deny');
  assert.equal(approvalMode({ tool: 'get_form_model', autonomy: 'readonly' }), 'auto');
  assert.ok(describeCall('save_artifact', { table: 'sys_script_client', fields: { name: 'X', script: 'y' }, reason: 'because' }).code);
});

// ---- agent loop -------------------------------------------------------------------------------

function scriptedModel(replies) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const next = replies.shift();
    if (!next) throw new Error('model script exhausted');
    return { content: '', toolCalls: [], stopReason: 'end_turn', ...next };
  };
  fn.calls = calls;
  return fn;
}

test('agent loop runs tools, gates writes on approval, and finishes', async () => {
  const events = [];
  const model = scriptedModel([
    { toolCalls: [{ id: 't1', name: 'get_schema', args: { table: 'incident' } }, { id: 't2', name: 'save_artifact', args: { table: 'sys_script_client', fields: { name: 'x' }, reason: 'r' } }] },
    { content: 'All done.' },
  ]);
  const executed = [];
  const result = await runAgent({
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }],
    tools: TOOL_SCHEMAS,
    callModel: model,
    executeTool: async (name, args) => (executed.push(name), { ok: true }),
    approvalMode: (name) => approvalMode({ tool: name }),
    requestApproval: async () => ({ approved: false, note: 'not now' }),
    onEvent: (e) => events.push(e.type),
  });
  assert.equal(result.stopped, 'done');
  assert.equal(result.finalText, 'All done.');
  assert.deepEqual(executed, ['get_schema']); // the declined write never ran
  const toolMessages = result.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.match(toolMessages[1].content, /declined/);
  assert.ok(events.includes('approval_request') && events.includes('done'));
});

test('agent loop: approved writes run, errors are returned to the model, repeats are cut off', async () => {
  const model = scriptedModel([
    { toolCalls: [{ id: 'a', name: 'save_form', args: {} }] },
    { toolCalls: [{ id: 'b', name: 'get_schema', args: { table: 'x' } }] },
    { toolCalls: [{ id: 'c', name: 'get_schema', args: { table: 'x' } }] },
    { toolCalls: [{ id: 'd', name: 'get_schema', args: { table: 'x' } }] },
    { toolCalls: [{ id: 'e', name: 'get_schema', args: { table: 'x' } }] },
    { content: 'stopping' },
  ]);
  let saved = 0;
  const result = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    tools: TOOL_SCHEMAS,
    callModel: model,
    executeTool: async (name) => {
      if (name === 'save_form') saved += 1;
      else throw new Error('table not readable');
      return true;
    },
    approvalMode: (name) => approvalMode({ tool: name }),
    requestApproval: async () => ({ approved: true }),
  });
  assert.equal(saved, 1);
  const toolMsgs = result.messages.filter((m) => m.role === 'tool');
  assert.match(toolMsgs[1].content, /^Error: table not readable/);
  assert.match(toolMsgs[4].content, /already made this exact call/);
});

test('agent loop: step limit forces a wrap-up, read-only denies, abort stops', async () => {
  const forever = Array.from({ length: 3 }, (_, i) => ({ toolCalls: [{ id: `x${i}`, name: 'get_schema', args: { table: `t${i}` } }] }));
  const limited = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    tools: TOOL_SCHEMAS,
    callModel: scriptedModel([...forever, { content: 'Summary of what happened.' }]),
    executeTool: async () => 'ok',
    approvalMode: () => 'auto',
    requestApproval: async () => ({ approved: true }),
    maxSteps: 3,
  });
  assert.equal(limited.stopped, 'limit');
  assert.equal(limited.finalText, 'Summary of what happened.');

  const readonly = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    tools: TOOL_SCHEMAS,
    callModel: scriptedModel([{ toolCalls: [{ id: 'w', name: 'save_form', args: {} }] }, { content: 'ok' }]),
    executeTool: async () => assert.fail('must not execute'),
    approvalMode: (name) => approvalMode({ tool: name, autonomy: 'readonly' }),
    requestApproval: async () => assert.fail('must not ask'),
  });
  assert.match(readonly.messages.find((m) => m.role === 'tool').content, /read-only/);

  const controller = new AbortController();
  controller.abort();
  const aborted = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    tools: [],
    callModel: scriptedModel([]),
    executeTool: async () => null,
    approvalMode: () => 'auto',
    requestApproval: async () => ({ approved: true }),
    signal: controller.signal,
  });
  assert.equal(aborted.stopped, 'aborted');
});

test('tool results are redacted and capped before the model sees them', () => {
  assert.ok(!toModelText({ script: 'var password = "hunter2hunter2";', api_key: 'abcd1234efgh', k: 'sk-abcdefghijklmnop1234' }).includes('hunter2'));
  const long = toModelText('x'.repeat(50000), 1000);
  assert.ok(long.length < 1200 && long.includes('truncated'));
});

// ---- audit ---------------------------------------------------------------------------------------

test('audit log records, finds the last undoable change and marks it undone', async () => {
  const store = {};
  const audit = createAudit({ get: async (k) => store[k], set: async (k, v) => void (store[k] = v) });
  await audit.record({ instance: 'a', tool: 'set_form_field', args: { name: 'x', value: 'y'.repeat(9000) }, ok: true });
  const w = await audit.record({ instance: 'a', tool: 'save_artifact', args: {}, ok: true, undo: { kind: 'record', table: 't', sysId: 's', previous: { a: 1 } } });
  assert.equal((await audit.lastUndoable('a')).id, w.id);
  assert.equal(await audit.lastUndoable('b'), null);
  await audit.markUndone(w.id);
  assert.equal(await audit.lastUndoable('a'), null);
  assert.ok((await audit.load())[1].args.value.length < 6100);
});

// ---- providers ------------------------------------------------------------------------------------

test('OpenAI and Anthropic wire formats round-trip tool calls', () => {
  const convo = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'checking', toolCalls: [{ id: 'c1', name: 'get_schema', args: { table: 'incident' } }, { id: 'c2', name: 'count_records', args: { table: 'incident' } }] },
    { role: 'tool', toolCallId: 'c1', name: 'get_schema', content: '{"a":1}' },
    { role: 'tool', toolCallId: 'c2', name: 'count_records', content: '42', isError: true },
  ];
  const openai = msgs.toOpenAIMessages(convo);
  assert.equal(openai[2].tool_calls[0].function.arguments, '{"table":"incident"}');
  assert.deepEqual(openai[3], { role: 'tool', tool_call_id: 'c1', content: '{"a":1}' });

  const { system, messages } = msgs.toAnthropicRequest(convo);
  assert.equal(system, 'sys');
  assert.equal(messages.length, 3); // user, assistant, ONE user message holding both tool results
  assert.equal(messages[2].content.length, 2);
  assert.equal(messages[2].content[1].is_error, true);
  assert.equal(messages[1].content[1].type, 'tool_use');
});

test('Anthropic raw blocks (thinking) are replayed untouched', () => {
  const raw = { provider: 'anthropic', blocks: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't', name: 'n', input: {} }] };
  const { messages } = msgs.toAnthropicRequest([{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: [{ id: 't', name: 'n', args: {} }], raw }]);
  assert.deepEqual(messages[1].content, raw.blocks);
  // A turn that came from OpenAI is rebuilt rather than replayed.
  const rebuilt = msgs.toAnthropicRequest([{ role: 'assistant', content: 'hi', raw: { provider: 'openai', blocks: [] } }]);
  assert.equal(rebuilt.messages[0].content[0].text, 'hi');
});

test('responses normalise; refusals and empty replies throw', () => {
  const a = msgs.fromAnthropicResponse({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'i', name: 'n', input: { a: 1 } }], usage: { input_tokens: 3, output_tokens: 4 } });
  assert.deepEqual(a.toolCalls, [{ id: 'i', name: 'n', args: { a: 1 } }]);
  assert.equal(a.stopReason, 'tool_use');
  assert.throws(() => msgs.fromAnthropicResponse({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }), /declined/);
  assert.throws(() => msgs.fromAnthropicResponse({ content: [] }), /no content/);

  const o = msgs.fromOpenAIResponse({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'x', function: { name: 'n', arguments: '{"b":2}' } }] } }] });
  assert.deepEqual(o.toolCalls[0].args, { b: 2 });
  assert.deepEqual(msgs.fromOpenAIResponse({ choices: [{ message: { content: 'hi', tool_calls: [{ id: 'y', function: { name: 'n', arguments: 'not json' } }] } }] }).toolCalls[0].args, {});
});

test('provider config resolves from legacy and new storage', () => {
  assert.equal(resolveProviderConfig({ [STORAGE_KEYS.openaiKey]: 'sk-x' }).provider, 'openai');
  assert.equal(resolveProviderConfig({}).provider, 'anthropic');
  const c = resolveProviderConfig({ [STORAGE_KEYS.provider]: 'anthropic', [STORAGE_KEYS.anthropicKey]: 'k', [STORAGE_KEYS.models]: { anthropic: 'claude-haiku-5-5' } });
  assert.deepEqual(c, { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'k', baseUrl: '', keyOptional: false, promptCache: true });
  assert.equal(resolveProviderConfig({ [STORAGE_KEYS.provider]: 'anthropic', [STORAGE_KEYS.models]: { anthropic: 'bogus' } }).model, 'claude-opus-5-5');
  // A custom endpoint takes any model id; an invalid address is ignored rather than used; a local server needs no key.
  const custom = resolveProviderConfig({ [STORAGE_KEYS.provider]: 'openai', [STORAGE_KEYS.openaiBaseUrl]: 'https://api.x.ai/v1/', [STORAGE_KEYS.models]: { openai: ' grok-4 ' } });
  assert.equal(custom.baseUrl, 'https://api.x.ai/v1');
  assert.equal(custom.model, 'grok-4');
  assert.equal(resolveProviderConfig({ [STORAGE_KEYS.provider]: 'openai', [STORAGE_KEYS.openaiBaseUrl]: 'http://evil.example/v1', [STORAGE_KEYS.models]: { openai: 'grok-4' } }).baseUrl, '');
  assert.equal(resolveProviderConfig({ [STORAGE_KEYS.provider]: 'openai', [STORAGE_KEYS.openaiBaseUrl]: 'http://localhost:11434/v1' }).keyOptional, true);
  assert.equal(resolveProviderConfig({ [STORAGE_KEYS.provider]: 'openai', [STORAGE_KEYS.openaiBaseUrl]: 'https://api.x.ai/v1' }).keyOptional, false);
  assert.equal(resolveProviderConfig({ mysnowbuddy_settings: { promptCache: false } }).promptCache, false);
});

// ---- regressions from the full-repo bug hunt --------------------------------------------

test('auto dry runs still ask when the script has side effects a dry run cannot suppress', () => {
  const auto = { tool: 'dry_run_script', autonomy: 'auto-runs' };
  assert.equal(approvalMode({ ...auto, args: { code: 'var gr = new GlideRecord("incident"); gr.query();' } }), 'auto');
  for (const code of ["gs.setProperty('a','b');", 'new GlideMultipleUpdate("x");', "gs.eventQueue('e', gr);", 'new sn_ws.RESTMessageV2("a","b").execute();', 'gr.executeSQL()']) {
    assert.equal(approvalMode({ ...auto, args: { code } }), 'ask', code);
  }
  assert.equal(approvalMode({ tool: 'dry_run_script', autonomy: 'auto-runs' }), 'auto', 'no args: nothing to flag');
});

test('dry run wrapper covers the WithReferences writers and fails closed', () => {
  const { wrapAsDryRun, analyzeScriptRisk } = require('../src/lib/scriptSafety.js');
  const wrapped = wrapAsDryRun('gr.insertWithReferences();');
  assert.match(wrapped, /'updateWithReferences', 'insertWithReferences'/);
  assert.match(wrapped, /proto\[method\] !== __stub/);
  assert.ok(analyzeScriptRisk('gr.updateWithReferences();').hasWrites);
});

test('undo payloads are stored whole, never clipped', async () => {
  const store = {};
  const audit = createAudit({ get: async (k) => store[k], set: async (k, v) => void (store[k] = v) });
  const script = 'x'.repeat(9000);
  await audit.record({ instance: 'h', tool: 'save_artifact', ok: true, args: { fields: { script } }, undo: { kind: 'record', table: 't', sysId: 's', previous: { script } } });
  const entry = await audit.lastUndoable('h');
  assert.equal(entry.undo.previous.script.length, 9000);
  assert.ok(entry.args.fields.script.length < 9000, 'args are still clipped for display');
});

test('save_artifact approval card shows every non-script field', () => {
  const d = describeCall('save_artifact', { table: 'sys_script', fields: { name: 'n', active: true, condition: 'current.x == 1', script: 'a()' }, reason: 'why' });
  assert.match(d.detail, /active = true/);
  assert.match(d.detail, /condition = current\.x == 1/);
  assert.equal(d.code, 'a()');
});

test('write guard fails safe: only positively identified dev/test/stage skips the typed confirmation', () => {
  const { isGuardedEnv } = require('../src/lib/agent/policy.js');
  assert.equal(isGuardedEnv('prod'), true);
  assert.equal(isGuardedEnv('unknown'), true);
  assert.equal(isGuardedEnv(undefined), true);
  for (const env of ['dev', 'test', 'stage']) assert.equal(isGuardedEnv(env), false);
});

test('query guard rejects values that would run as script', () => {
  const { assertNoInlineScript, hasInlineScript } = require('../src/lib/queryGuard.js');
  assert.throws(() => assertNoInlineScript('javascript:gs.getUserID()'));
  assert.throws(() => assertNoInlineScript('  JavaScript : x'));
  assert.equal(assertNoInlineScript('gs.getUserID()'), 'gs.getUserID()', 'searching for code that mentions gs. is fine');
  assert.equal(hasInlineScript('my javascript: note'), false, 'only a leading javascript: is evaluated');
});

test('instance names: common production and developer-instance conventions are recognised', () => {
  const { classifyEnvironment } = require('../src/content/quickActions.js');
  const envOf = (n) => classifyEnvironment(n)?.env || 'unknown';
  for (const n of ['acme-prod', 'acmeprod', 'acmeprd2', 'live']) assert.equal(envOf(n), 'prod', n);
  for (const n of ['acme-dev', 'dev12345']) assert.equal(envOf(n), 'dev', n);
  assert.equal(envOf('acme-uat'), 'stage');
  assert.equal(envOf('acme'), 'unknown');
});

test('step-limit wrap-up keeps tool definitions in the request and survives a tool call reply', async () => {
  const seen = [];
  const stubborn = [
    { toolCalls: [{ id: 'a', name: 'get_schema', args: { table: 't' } }] },
    { toolCalls: [{ id: 'b', name: 'get_schema', args: { table: 'u' } }], content: '', raw: [{ type: 'tool_use' }] },
  ];
  const run = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    tools: TOOL_SCHEMAS,
    callModel: async (req) => {
      seen.push(req.tools.length);
      return stubborn.shift() || { content: '' };
    },
    executeTool: async () => 'ok',
    approvalMode: () => 'auto',
    requestApproval: async () => ({ approved: true }),
    maxSteps: 1,
  });
  assert.equal(run.stopped, 'limit');
  assert.ok(seen.every((n) => n === TOOL_SCHEMAS.length), 'every request, including the wrap-up, carries the tool definitions');
  assert.match(run.finalText, /step limit/, 'a wrap-up that asks for tools falls back to a plain message');
  assert.ok(!run.messages.at(-1).raw && !run.messages.at(-1).toolCalls, 'no dangling tool_use is stored');
});

test('save_form only reports saved when the record really changed', async () => {
  const { createAgentTools } = require('../src/content/agentTools.js');
  const build = (rows) => {
    const calls = { saved: 0 };
    let i = 0;
    const tools = createAgentTools({
      getContext: () => ({ table: 'incident', sysId: 'a'.repeat(32) }),
      getInstanceInfo: () => ({ host: 'x.service-now.com' }),
      callPage: async () => void (calls.saved += 1),
      fetchRecord: async () => rows[Math.min(i++, rows.length - 1)],
      audit: createAudit({ get: async () => [], set: async () => {} }),
      saveCheckDelayMs: 1,
    });
    return { tools, calls };
  };
  const changed = build([{ sys_mod_count: '1', sys_updated_on: 'a' }, { sys_mod_count: '2', sys_updated_on: 'b' }]);
  assert.deepEqual(await changed.tools.execute('save_form', {}).then((r) => ({ saved: r.saved, confirmed: r.confirmed })), { saved: true, confirmed: true });
  const blocked = build([{ sys_mod_count: '1', sys_updated_on: 'a' }]);
  const r = await blocked.tools.execute('save_form', {});
  assert.equal(r.saved, false, 'an unchanged record must not be reported as saved');
  assert.equal(r.submitted, true);
  assert.equal(blocked.calls.saved, 1);
});

test('query_table and count_records reject columns the table does not have (ServiceNow ignores them silently)', async () => {
  const { createAgentTools } = require('../src/content/agentTools.js');
  let ran = 0;
  const tools = createAgentTools({
    getContext: () => ({}),
    getInstanceInfo: () => ({ host: 'x' }),
    fetchTableFields: async () => ({ fields: [{ name: 'number' }, { name: 'short_description' }, { name: 'sys_id' }, { name: 'caller_id' }] }),
    tableHierarchy: async (t) => [t],
    queryTable: async () => (ran += 1, []),
    countRecords: async () => (ran += 1, 0),
    audit: createAudit({ get: async () => [], set: async () => {} }),
  });
  await assert.rejects(tools.execute('query_table', { table: 'incident', query: 'nameLIKEfoo' }), /no field "name"/);
  await assert.rejects(tools.execute('count_records', { table: 'incident', query: 'active=true^ORDERBYopened' }), /no field "active"/);
  await assert.rejects(tools.execute('query_table', { table: 'incident', query: '', fields: ['numbr'] }), /did you mean "number"/);
  assert.equal(ran, 0, 'nothing reached the instance');
  await tools.execute('query_table', { table: 'incident', query: 'short_descriptionLIKEfoo^caller_id.name=Abel^ORDERBYnumber', fields: ['number', 'sys_id'] });
  assert.equal(ran, 1, 'valid columns, including a dot-walk and system columns, go through');
});

test('the catalog knows the GlideAjax methods the browser class has', () => {
  ['setWantSessionMessages', 'setErrorCallback', 'setScope', 'preventLoadingIcon', 'preventCancelNotification', 'disableRunInBatch'].forEach((name) => {
    assert.ok(lookupApi(`GlideAjax.${name}`, 'client').found, name);
  });
});

test('g_user is not treated as exhaustive: the browser object has more functions than the documented six', () => {
  const api = getApi('g_user', 'client');
  assert.equal(api.complete, false);
  // A real but undocumented function is a note to confirm, a typo still gets a suggestion.
  assert.match(lookupApi('g_user.getUserID', 'client').text, /not exhaustive|official docs|Did you mean/);
  assert.ok(!/does not exist/.test(lookupApi('g_user.getUserID', 'client').text));
  assert.match(lookupApi('g_user.hasRol', 'client').text, /Did you mean g_user\.hasRole/);
});

test('the catalog knows server methods found on a live instance (GlideRecord and gs)', () => {
  ['addInactiveQuery', 'addFunction', 'getBooleanAttribute', 'getEscapedDisplayValue', 'getLocation', 'getRelatedLists', 'getRelatedTables', 'insertWithReferences', 'isEncodedQueryValid', 'setUseEngines'].forEach((name) => {
    assert.ok(lookupApi(`GlideRecord.${name}`, 'server').found, `GlideRecord.${name}`);
  });
  ['beginningOfTomorrow', 'endOfTomorrow', 'endOfLastYear', 'yesterday', 'lastWeek', 'dateDiff', 'calDateDiff', 'flushMessages', 'getErrorMessages', 'getInfoMessages', 'logError', 'logWarning', 'getImpersonatingUserName', 'getImpersonatingUserDisplayName'].forEach((name) => {
    assert.ok(lookupApi(`gs.${name}`, 'server').found, `gs.${name}`);
  });
  [['GlideAggregate', 'addTrend'], ['GlideElement', 'getDisplayValueExt'], ['GlideUser', 'getUserRoles'], ['GlideUser', 'getLocation']].forEach(([cls, name]) => {
    assert.ok(lookupApi(`${cls}.${name}`, 'server').found, `${cls}.${name}`);
  });
  // The global-scope gap found earlier stays recorded.
  assert.match(lookupApi('gs.base64Encode', 'server').text, /scoped|missing/i);
});

test('named providers resolve to a fixed address, any model id and the right protocol', () => {
  const { PROVIDERS, apiOf, keyStorageFor, baseUrlStorageFor } = require('../src/providers/config.js');
  // Every provider speaks a known protocol, has what the settings screen needs, and presets have a valid address.
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.ok(['anthropic', 'openai'].includes(p.api), id);
    assert.ok(p.label && p.keyLabel && p.keyHint && Array.isArray(p.models), id);
    if (p.baseUrl) assert.match(p.baseUrl, /^(https:\/\/[^/?#]+(\/[^?#]*[^/])?|http:\/\/localhost:\d+\/v1)$/, id);
    if (id !== 'custom') assert.ok(p.models.some((m) => m.id === p.defaultModel), `${id} default is a listed model`);
  }
  // Per-provider storage: the two older vendors keep their keys, the others get their own.
  assert.equal(keyStorageFor('anthropic'), STORAGE_KEYS.anthropicKey);
  assert.equal(keyStorageFor('openai'), STORAGE_KEYS.openaiKey);
  assert.equal(keyStorageFor('gemini'), 'mysnowbuddy_key_gemini');
  assert.notEqual(keyStorageFor('gemini'), keyStorageFor('deepseek'));
  assert.equal(baseUrlStorageFor('custom'), 'mysnowbuddy_base_url_custom');
  // Gemini: fixed address, the OpenAI protocol, any model id, the user's key.
  const gem = resolveProviderConfig({ [STORAGE_KEYS.provider]: 'gemini', [keyStorageFor('gemini')]: 'AIzaX', [STORAGE_KEYS.models]: { gemini: ' gemini-3-pro ' } });
  assert.equal(apiOf('gemini'), 'openai');
  assert.equal(gem.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(gem.model, 'gemini-3-pro');
  assert.equal(gem.apiKey, 'AIzaX');
  assert.equal(gem.keyOptional, false);
  // No model chosen yet: the preset's default.
  assert.equal(resolveProviderConfig({ [STORAGE_KEYS.provider]: 'deepseek' }).model, 'deepseek-chat');
  // A typed address cannot redirect a preset; only OpenAI, Anthropic and "other" take one.
  assert.equal(resolveProviderConfig({ [STORAGE_KEYS.provider]: 'deepseek', mysnowbuddy_base_url_deepseek: 'https://evil.example/v1' }).baseUrl, 'https://api.deepseek.com');
  assert.equal(resolveProviderConfig({ [STORAGE_KEYS.provider]: 'custom', mysnowbuddy_base_url_custom: 'https://api.together.xyz/v1/', [STORAGE_KEYS.models]: { custom: 'm' } }).baseUrl, 'https://api.together.xyz/v1');
  assert.equal(resolveProviderConfig({ [STORAGE_KEYS.provider]: 'custom', mysnowbuddy_base_url_custom: 'http://evil.example/v1' }).baseUrl, '');
  // Ollama needs no key; the others do.
  assert.equal(resolveProviderConfig({ [STORAGE_KEYS.provider]: 'ollama' }).keyOptional, true);
  assert.equal(resolveProviderConfig({ [STORAGE_KEYS.provider]: 'groq' }).keyOptional, false);
  assert.equal(resolveProviderConfig({ [STORAGE_KEYS.provider]: 'custom', mysnowbuddy_base_url_custom: 'http://localhost:1234/v1' }).keyOptional, true);
});
