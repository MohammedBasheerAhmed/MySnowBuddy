// Regression tests for the hardening pass: provider-boundary redaction, scope-aware
// variable typing, lint table lists and loop detection, snippet escaping, and
// session-expiry handling in the Table API client.
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets, redactMessages, isSecretName } = require('../src/providers/redact.js');
const { sendChat } = require('../src/providers/index.js');
const { toAnthropicRequest, toOpenAIMessages } = require('../src/providers/messages.js');

// ---- 1. redaction ------------------------------------------------------------------------------

const hides = (text, secret) => {
  const out = redactSecrets(text);
  assert.ok(!out.includes(secret), `"${secret}" leaked from: ${out}`);
  assert.equal(redactSecrets(out), out, 'redaction is idempotent');
  return out;
};

test('redaction: credentials in URLs, Authorization headers and bearer tokens', () => {
  assert.equal(hides('see https://admin:Sup3rS3cret@dev1.service-now.com/api/now', 'Sup3rS3cret'), 'see https://admin:[REDACTED]@dev1.service-now.com/api/now');
  assert.equal(hides('Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpw'), 'Authorization: Basic [REDACTED]');
  hides("r.setRequestHeader('Authorization', 'Bearer abcDEF123456789xyz');", 'abcDEF123456789xyz');
  hides('curl -H "Bearer 0a1b2c3d4e5f6a7b8c9d"', '0a1b2c3d4e5f6a7b8c9d');
  hides('{"headers":{"Authorization":"Bearer ya29.a0AfH6SMBx-token"}}', 'ya29.a0AfH6SMBx');
});

test('redaction: private keys, JWTs and well-known key formats', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\nabcdef\n-----END RSA PRIVATE KEY-----';
  assert.equal(hides(pem, 'MIIEowIBAAKCAQEA7'), '-----BEGIN RSA PRIVATE KEY-----[REDACTED]-----END RSA PRIVATE KEY-----');
  hides('-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkq', 'MIIEvQIBADANBgkq'); // truncated, JSON-escaped newlines
  hides('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'dozjgNryP4J3');
  hides('key AKIAIOSFODNN7EXAMPLE in the log', 'AKIAIOSFODNN7EXAMPLE');
  hides('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI');
  hides("k = 'sk-ant-api03-abcdefghijklmnopqrstuvwx'", 'abcdefghijklmnop');
  hides('ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnop');
});

test('redaction: generic password / secret / token / api_key assignments', () => {
  hides('var password = "hunter2hunter2";', 'hunter2');
  hides("client_secret='abcd1234'", 'abcd1234');
  hides('{"api_key": "abcd1234efgh"}', 'abcd1234efgh');
  hides("var cfg = { accessToken: 'tok-123456' };", 'tok-123456');
  hides('gs.setProperty("x", "y"); var glide_pwd = "Pa55";', 'Pa55');
  // A script serialized with JSON.stringify: the quotes are escaped.
  hides(JSON.stringify({ script: 'var password = "hunter2"; var x = 1;' }), 'hunter2');
  // Call arguments and basic auth.
  hides("gr.setValue('u_password', 'hunter2');", 'hunter2');
  hides("rm.setRequestHeader('X-Api-Key', 'k3y-value-123');", 'k3y-value-123');
  hides("rm.setBasicAuth('admin', 'Pa55word');", 'Pa55word');
  // Unquoted: URL query parameters, log lines, config text.
  hides('GET /api/x?user=a&api_key=abc123def&x=1', 'abc123def');
  hides('Login failed password=hunter2 for admin', 'hunter2');
  hides('TOKEN: 9f8e7d6c5b4a', '9f8e7d6c5b4a');
});

test('redaction: sys_properties values whose name holds a secret', () => {
  const row = '{"name": "glide.ldap.password", "value": "s3cr3t!", "type": "password2"}';
  assert.equal(hides(row, 's3cr3t!'), '{"name": "glide.ldap.password", "value": "[REDACTED]", "type": "password2"}');
  const pretty = JSON.stringify([{ name: 'my.integration.api_key', value: 'k-998877' }, { name: 'glide.ui.title', value: 'My instance' }], null, 1);
  const out = hides(pretty, 'k-998877');
  assert.ok(out.includes('My instance'), 'ordinary properties are kept');
  hides('{"name": {"display_value": "x.token", "value": "x.token"}, "value": {"display_value": "abc", "value": "abc"}}', '"abc"');
  hides('<sys_properties><name>my.api.secret</name><type>string</type><value>topsecret</value></sys_properties>', 'topsecret');
  hides('<value>topsecret</value><name>my.api.secret</name>', 'topsecret');
  assert.ok(isSecretName('glide.ldap.password') && isSecretName('client_secret') && !isSecretName('glide.ui.title'));
});

test('redaction leaves ordinary code and prose alone', () => {
  const code = [
    "var label = 'Password: ';",
    'gs.info(label + x);',
    "gs.info('Password: ' + name + ' and');",
    "gs.info('token=' + token);",
    "var token = gr.getValue('token');",
    'var token = current.u_token;',
    "var api_key = gs.getProperty('x.api_key');",
    '{ token: token, password: password }',
    "var passwordLabel = 'Enter your password';",
    "if (field == 'password') { return; }",
    "if (typeof s.mcpToken === 'string') { x(); }",
    "fetch(url, { credentials: 'same-origin' });",
    'validateKey({ apiKey: payload?.apiKey });',
    "r.setRequestHeader('Authorization', 'Basic ' + GlideStringUtil.base64Encode(u + ':' + p));",
    'var maxTokens = 1000; tokens: 5',
    'Bearer authentication is described in RFC 6750.',
    "if (pem.indexOf('-----BEGIN PRIVATE KEY-----') === 0) { parse(pem); }",
    'fields: ["user_name", "password", "email"]',
    'getCsrfToken: getCsrfToken2,',
    '{"name": "glide.ui.title", "value": "My instance"}',
  ].join('\n');
  assert.equal(redactSecrets(code), code);
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(undefined), undefined);
  assert.equal(redactSecrets(42), 42);
});

test('redactMessages redacts text but keeps tool-call structure and raw thinking blocks', () => {
  const raw = {
    provider: 'anthropic',
    blocks: [
      { type: 'thinking', thinking: 'the password = "hunter2" mentioned earlier', signature: 'sig-abc' },
      { type: 'tool_use', id: 'toolu_1', name: 'query_table', input: { table: 'sys_properties', token: 'keep-me-1234' } },
    ],
  };
  const toolCalls = [{ id: 'call_1', name: 'query_table', args: { table: 'sys_properties', query: 'name=x' } }];
  const input = [
    { role: 'system', content: 'Instance notes: api_key=abc123def' },
    { role: 'user', content: 'var password = "hunter2";' },
    { role: 'assistant', content: 'Looking.', toolCalls, raw },
    { role: 'tool', toolCallId: 'toolu_1', name: 'query_table', content: '[{"name": "x.password", "value": "s3cr3t"}]' },
    { role: 'user', content: [{ type: 'text', text: 'Authorization: Bearer zzz111yyy222xxx' }, { type: 'image', source: 'keep' }] },
  ];
  const out = redactMessages(input);
  const text = JSON.stringify(out.map((m) => m.content));
  for (const secret of ['abc123def', 'hunter2"', 's3cr3t', 'zzz111yyy222xxx']) assert.ok(!text.includes(secret), secret);
  assert.equal(out[2].raw, raw, 'raw blocks are passed through by reference');
  assert.equal(out[2].toolCalls, toolCalls);
  assert.equal(out[3].toolCallId, 'toolu_1');
  assert.deepEqual(out[4].content[1], { type: 'image', source: 'keep' });
  assert.equal(input[1].content, 'var password = "hunter2";', 'the caller\'s array is not mutated');
  // The Anthropic request replays the thinking block byte for byte.
  const { messages } = toAnthropicRequest(out);
  assert.deepEqual(messages[1].content, raw.blocks);
  // OpenAI keeps the tool-call ids and arguments.
  const oa = toOpenAIMessages(out);
  assert.equal(oa[2].tool_calls[0].id, 'call_1');
  assert.equal(oa[3].tool_call_id, 'toolu_1');
});

test('sendChat redacts every request at the provider boundary', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} }) };
  };
  try {
    const thinking = { type: 'thinking', thinking: 'plan', signature: 'sig-xyz' };
    await sendChat(
      { provider: 'anthropic', model: 'm', apiKey: 'k' },
      {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Search results:\nvar password = "hunter2"; // from a script' },
          { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_logs', args: {} }], raw: { provider: 'anthropic', blocks: [thinking, { type: 'tool_use', id: 't1', name: 'read_logs', input: {} }] } },
          { role: 'tool', toolCallId: 't1', name: 'read_logs', content: 'Login failed password=hunter2 via https://u:hunter2@x.service-now.com' },
        ],
      }
    );
    await sendChat({ provider: 'openai', model: 'gpt-5-mini', apiKey: 'k' }, { messages: [{ role: 'user', content: 'api_key=abc123def' }] }).catch(() => {});
  } finally {
    globalThis.fetch = realFetch;
  }
  const body = JSON.stringify(sent.map((s) => s.body));
  assert.ok(!body.includes('hunter2') && !body.includes('abc123def'), body);
  assert.deepEqual(sent[0].body.messages[1].content[0], { type: 'thinking', thinking: 'plan', signature: 'sig-xyz' });
  assert.equal(sent[0].body.messages[2].content[0].tool_use_id, 't1');
});

// ---- 2. scope-aware variable typing ------------------------------------------------------------

const { checkApiUsage } = require('../src/lib/apiCheck.js');
const { verifyScript } = require('../src/lib/verify.js');
const { lintScript } = require('../src/lib/lint.js');

const TWO_FUNCTIONS = [
  'var Util = Class.create();',
  'Util.prototype = {',
  '  count: function () {',
  "    var gr = new GlideAggregate('incident');",
  "    gr.addAggregate('COUNT');",
  '    gr.query();',
  "    return gr.next() ? gr.getAggregate('COUNT') : 0;",
  '  },',
  '  list: function () {',
  "    var gr = new GlideRecord('incident');",
  "    gr.addQuery('active', true);",
  '    gr.setLimit(10);',
  '    gr.query();',
  '    return gr.getRowCount();',
  '  },',
  "  type: 'Util'",
  '};',
].join('\n');

test('apiCheck types a reused variable name per function', () => {
  // Before: gr was typed GlideRecord everywhere, so addAggregate/getAggregate were "not in the GlideRecord catalog".
  assert.deepEqual(checkApiUsage(TWO_FUNCTIONS, { side: 'server' }), []);
  // A typo is still caught against the right class in each function.
  const typo = TWO_FUNCTIONS.replace("gr.addQuery('active', true);", "gr.addQuerry('active', true);");
  const found = checkApiUsage(typo, { side: 'server' }).filter((f) => f.ruleId === 'api-unknown-method');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 11);
  // A parameter shadows an outer typed variable; top-level variables are seen inside functions.
  const nested = [
    "var gr = new GlideRecord('incident');",
    'function helper(gr) { return gr.whatever(); }',
    "function inner() { gr.addQuerry('a', 1); }",
  ].join('\n');
  const nf = checkApiUsage(nested, { side: 'server' }).filter((f) => f.ruleId.startsWith('api-unknown'));
  assert.deepEqual(nf.map((f) => f.line), [3]);
});

test('verify tracks GlideRecord ordering per function', () => {
  const r = verifyScript({ kind: 'script_include', code: TWO_FUNCTIONS });
  assert.deepEqual(r.findings.filter((f) => f.ruleId.startsWith('gr-')), [], 'no cross-function "after query" findings');
  const missingQuery = [
    'function a() {',
    "  var gr = new GlideRecord('incident');",
    "  gr.addQuery('active', true);",
    '  gr.query();',
    '  while (gr.next()) {}',
    '}',
    'function b() {',
    "  var gr = new GlideRecord('problem');",
    '  while (gr.next()) {}',
    '}',
  ].join('\n');
  const m = verifyScript({ kind: 'background_script', code: missingQuery }).findings.filter((f) => f.ruleId === 'gr-next-without-query');
  assert.deepEqual(m.map((f) => f.line), [9]);
});

test('lint unbounded-query check is per function', () => {
  const code = [
    'function a() {',
    "  var gr = new GlideRecord('incident');",
    "  gr.addQuery('active', true);",
    '  gr.query();',
    '}',
    'function b() {',
    "  var gr = new GlideRecord('problem');",
    '  gr.query();',
    '}',
  ].join('\n');
  const found = lintScript(code, { table: 'sys_script_include' }).filter((f) => f.ruleId === 'no-unbounded-query');
  assert.deepEqual(found.map((f) => f.line), [8]);
  assert.deepEqual(lintScript(TWO_FUNCTIONS, { table: 'sys_script_include' }).filter((f) => f.ruleId === 'no-unbounded-query'), []);
  // A nested function's constrained gr must not hide the outer, unbounded gr.
  const nested = [
    'function a() {',
    "  var gr = new GlideRecord('incident');",
    '  var helper = function () {',
    "    var gr = new GlideRecord('problem');",
    "    gr.addQuery('active', true);",
    '    gr.query();',
    '  };',
    '  gr.query();',
    '}',
  ].join('\n');
  const outer = lintScript(nested, { table: 'sys_script_include' }).filter((f) => f.ruleId === 'no-unbounded-query');
  assert.deepEqual(outer.map((f) => [f.line, f.message.slice(0, 4)]), [[8, '"gr"']]);
});

// ---- 3. lint: table lists and N+1 loop detection ---------------------------------------------------

const ruleIds = (findings) => findings.map((f) => f.ruleId);

test('lint applies server rules to ACL, scripted REST and server UI action scripts', () => {
  assert.ok(ruleIds(lintScript("gs.log('x');\nanswer = g_form.getValue('a');", { table: 'sys_security_acl' })).includes('no-g-form-server-side'));
  assert.ok(ruleIds(lintScript("console.log('x');", { table: 'sys_ws_operation' })).includes('no-console-log-server'));
  assert.ok(ruleIds(lintScript("gs.log('x');", { table: 'sys_script_fix' })).includes('no-gs-log-scoped'));
  const serverAction = "current.state = 3;\ncurrent.update();\ngs.log('done');\naction.setRedirectURL(current);";
  assert.ok(ruleIds(lintScript(serverAction, { table: 'sys_ui_action' })).includes('no-gs-log-scoped'));
  // A server UI action may use GlideRecord freely.
  assert.ok(!ruleIds(lintScript("var gr = new GlideRecord('x');\ngr.get(current.sys_id);", { table: 'sys_ui_action' })).includes('no-gliderecord-in-client-script'));
});

test('lint applies client rules to client UI actions', () => {
  const clientAction = "function resolveIt() {\n  if (!confirm('Sure?')) return false;\n  alert('x');\n  gsftSubmit(null, g_form.getFormElement(), 'resolve_it');\n}";
  assert.ok(ruleIds(lintScript(clientAction, { table: 'sys_ui_action' })).includes('no-alert-in-client-script'));
  assert.ok(ruleIds(lintScript("var gr = new GlideRecord('x');", { table: 'sys_ui_action', side: 'client' })).includes('no-gliderecord-in-client-script'));
  // verify passes the side for its ui_action_client kind.
  assert.ok(ruleIds(verifyScript({ kind: 'ui_action_client', code: "function go() { alert('x'); }" }).findings).includes('no-alert-in-client-script'));
  // A mixed client + server UI action gets neither side's rules.
  const mixed = "function go() { g_form.setValue('a', 'b'); gsftSubmit(null, g_form.getFormElement(), 'go'); }\nif (typeof window == 'undefined') serverSide();\nfunction serverSide() { current.update(); gs.log('x'); }";
  const ids = ruleIds(lintScript(mixed, { table: 'sys_ui_action' }));
  assert.ok(!ids.includes('no-g-form-server-side') && !ids.includes('no-gs-log-scoped'));
});

const inLoop = (code) => lintScript(code, { table: 'sys_script' }).filter((f) => f.ruleId === 'no-query-in-loop').map((f) => f.line);

test('lint finds queries in Allman-style loops and Array callbacks', () => {
  assert.deepEqual(inLoop("var gr = new GlideRecord('incident');\ngr.setLimit(5);\ngr.query();\nwhile (gr.next())\n{\n    var u = new GlideRecord('sys_user');\n    u.get(gr.getValue('caller_id'));\n}"), [6]);
  assert.deepEqual(inLoop("for (var i = 0; i < ids.length; i++)\n{\n    var u = new GlideRecord('sys_user');\n    u.get(ids[i]);\n}"), [3]);
  assert.deepEqual(inLoop("ids.forEach(function (id) {\n    var gr = new GlideRecord('incident');\n    gr.get(id);\n});"), [2]);
  assert.deepEqual(inLoop("var names = ids.map((id) => {\n    var gr = new GlideRecord('incident');\n    return gr.get(id) ? gr.getDisplayValue() : '';\n});"), [2]);
  assert.deepEqual(inLoop("ids.forEach(function (id)\n{\n    var gr = new GlideAggregate('incident');\n    gr.addAggregate('COUNT');\n});"), [3]);
  assert.deepEqual(inLoop("do {\n    var gr = new GlideRecord('x');\n    gr.get(id);\n} while (more());"), [2]);
  assert.deepEqual(inLoop("for (var i = 0; i < 3; i++)\n    load(new GlideRecord('x'), i);"), [2]);
  assert.deepEqual(inLoop("while (gr.next())\n{\n  if (a)\n  {\n    x();\n  }\n  var u = new GlideRecord('y');\n}"), [7]);
});

test('lint loop detection has no false positives after a loop ends', () => {
  assert.deepEqual(inLoop("while (gr.next()) {\n    count++;\n}\nvar other = new GlideRecord('x');"), []);
  assert.deepEqual(inLoop("while (gr.next())\n{\n    count++;\n}\nvar other = new GlideRecord('x');"), []);
  assert.deepEqual(inLoop("for (var i = 0; i < 3; i++) { x(); }\nvar other = new GlideRecord('x');"), []);
  assert.deepEqual(inLoop("while (gr.next()) count++;\nvar other = new GlideRecord('x');"), []);
  assert.deepEqual(inLoop("ids.forEach(function (id) { list.push(id); });\nvar other = new GlideRecord('x');"), []);
  assert.deepEqual(inLoop("do {\n    i++;\n} while (i < 3)\nvar other = new GlideRecord('x');"), []);
  assert.deepEqual(inLoop("for (var i = 0; i < 3; i++) if (x) { y(); }\nvar other = new GlideRecord('x');"), []);
  assert.deepEqual(inLoop("// while (gr.next()) {\nvar other = new GlideRecord('x');\nvar s = 'for (x) {';\nvar g = new GlideRecord('y');"), []);
  assert.deepEqual(inLoop("var gr = new GlideRecord('x');\ngr.addQuery('a', 1);\ngr.query();\nwhile (gr.next()) {\n  gs.info(gr.number);\n}"), []);
});

// ---- 5. Table API session handling -------------------------------------------------------------

// The session token comes from the page bridge; answer its request event with a token.
function installPageStub() {
  const listeners = new Set();
  globalThis.document = {
    documentElement: { hasAttribute: () => true, setAttribute() {} },
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    dispatchEvent: (event) => {
      const { id } = event.detail;
      queueMicrotask(() => listeners.forEach((fn) => fn({ detail: { id, ok: true, result: 'a'.repeat(32) } })));
      return true;
    },
    getElementById: () => null,
    querySelector: () => null,
    scripts: [],
  };
}

function fakeResponse({ status = 200, body = '', headers = {}, redirected = false, url = 'https://dev1.service-now.com/api/now/table/x' }) {
  const h = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected,
    url,
    headers: h,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

async function withFetch(responses, fn) {
  installPageStub();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return fakeResponse(next);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const tableApi = require('../src/content/tableApi.js');
const EXPIRED = 'Your ServiceNow session has expired. Log in again, then retry.';
const LOGIN_PAGE = '<!DOCTYPE html><html><head><title>Log in | ServiceNow</title></head><body><form action="login.do" method="post"><input name="user_name"><input type="password" name="user_password" id="user_password"><button name="not_important" id="sysverb_login">Log in</button></form></body></html>';

test('an expired session is reported clearly instead of a JSON parse error', async () => {
  await withFetch([{ status: 200, body: LOGIN_PAGE, headers: { 'content-type': 'text/html' } }], async () => {
    await assert.rejects(tableApi.queryTable('incident', 'active=true'), { message: EXPIRED });
    await assert.rejects(tableApi.countRecords('incident'), { message: EXPIRED });
    await assert.rejects(tableApi.createRecord('sys_script', { name: 'x' }), { message: EXPIRED });
    await assert.rejects(tableApi.runBackgroundScript('gs.info(1)', 'tok'), { message: EXPIRED });
  });
  await withFetch([{ status: 401, body: '{"error":{"message":"User Not Authenticated","detail":"Required to provide Auth information"},"status":"failure"}' }], async () => {
    await assert.rejects(tableApi.fetchRecord('incident', 'a'.repeat(32)), { message: EXPIRED });
    await assert.rejects(tableApi.updateRecord('incident', 'a'.repeat(32), { state: 2 }), { message: EXPIRED });
  });
  await withFetch([{ status: 200, body: '<html></html>', redirected: true, url: 'https://dev1.service-now.com/login.do' }], async () => {
    await assert.rejects(tableApi.queryTable('incident', ''), { message: EXPIRED });
  });
  await withFetch([{ status: 200, body: '', headers: { 'x-is-logged-in': 'false' } }], async () => {
    await assert.rejects(tableApi.deleteRecord('incident', 'a'.repeat(32)), { message: EXPIRED });
  });
});

test('Table API errors include the ServiceNow message and detail', async () => {
  const body = '{"error":{"message":"User Not Authorized","detail":"ACL Exception Insert Failed due to security constraints"},"status":"failure"}';
  await withFetch([{ status: 403, body }], async () => {
    await assert.rejects(tableApi.queryTable('sys_user', ''), /User Not Authorized.*ACL Exception Insert Failed/);
    await assert.rejects(tableApi.createRecord('sys_script', {}), /not allowed.*User Not Authorized.*ACL Exception/);
  });
  await withFetch([{ status: 400, body: '{"error":{"message":"Invalid table nope","detail":null},"status":"failure"}' }], async () => {
    await assert.rejects(tableApi.queryTable('nope', ''), /\(400\).*Invalid table nope/);
    await assert.rejects(tableApi.countRecords('nope'), /Invalid table nope/);
  });
  // An HTML page that is not the login form (maintenance, proxy error) is named as such.
  await withFetch([{ status: 200, body: '<html><body>Instance is hibernating</body></html>' }], async () => {
    await assert.rejects(tableApi.queryTable('incident', ''), /HTML page instead of JSON/);
  });
});

test('GET requests retry 429/503 briefly; writes never retry', async () => {
  const ok = { status: 200, body: '{"result":[{"sys_id":"1"}]}' };
  await withFetch([{ status: 429, body: '', headers: { 'retry-after': '0' } }, { status: 503, body: '', headers: { 'retry-after': '0' } }, ok], async (calls) => {
    assert.deepEqual(await tableApi.queryTable('incident', ''), [{ sys_id: '1' }]);
    assert.equal(calls.length, 3);
  });
  await withFetch([{ status: 503, body: '{"error":{"message":"Transaction cancelled: maximum execution time exceeded"}}', headers: { 'retry-after': '0' } }], async (calls) => {
    await assert.rejects(tableApi.queryTable('incident', ''), /503.*maximum execution time/);
    assert.equal(calls.length, 3, 'two retries, then give up');
  });
  await withFetch([{ status: 429, body: '', headers: { 'retry-after': '0' } }, { status: 201, body: '{"result":{"sys_id":"2"}}' }], async (calls) => {
    await assert.rejects(tableApi.createRecord('sys_script', { name: 'x' }), /429/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
  });
  await withFetch([{ status: 204, body: '' }], async () => {
    assert.equal(await tableApi.deleteRecord('incident', 'a'.repeat(32)), null);
  });
  // Without Retry-After the client backs off instead of retrying at once.
  await withFetch([{ status: 503, body: '' }, { status: 200, body: '{"result":{"stats":{"count":"7"}}}' }], async (calls) => {
    const started = Date.now();
    assert.equal(await tableApi.countRecords('incident'), 7);
    assert.equal(calls.length, 2);
    assert.ok(Date.now() - started >= 300, 'waited before retrying');
  });
});

// ---- 6. bug hunt ----------------------------------------------------------------------------------

// Page-bridge stub answering each action from `handlers` (the CSRF token by default).
function installBridge(handlers = {}) {
  const listeners = new Set();
  globalThis.document = {
    documentElement: { hasAttribute: () => true, setAttribute() {} },
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    dispatchEvent: (event) => {
      const { id, action, args } = event.detail;
      const handler = handlers[action] || (action === 'getCsrfToken' ? () => 'a'.repeat(32) : null);
      queueMicrotask(() => {
        let detail;
        try {
          detail = handler ? { id, ok: true, result: handler(...(args || [])) } : { id, ok: false, error: `no ${action}` };
        } catch (err) {
          detail = { id, ok: false, error: err.message };
        }
        listeners.forEach((fn) => fn({ detail }));
      });
      return true;
    },
    getElementById: () => null,
    querySelector: () => null,
    scripts: [],
  };
}

test('readFormScript skips an empty "script" field in favour of a filled script field', async () => {
  const { readFormScript } = require('../src/content/context.js');
  installBridge({
    getScriptFields: () => [
      { name: 'script', label: 'Script', length: 0 },
      { name: 'client_script_v2', label: 'Workspace client script', length: 42 },
    ],
    getFieldState: (name) => ({ name, value: name === 'client_script_v2' ? 'function onClick(g_form) { g_form.save(); }' : '' }),
  });
  assert.deepEqual(await readFormScript(), { body: 'function onClick(g_form) { g_form.save(); }', label: 'Workspace client script' });
  installBridge({
    getScriptFields: () => [{ name: 'condition', label: 'Condition', length: 12 }, { name: 'script', label: 'Script', length: 30 }],
    getFieldState: (name) => ({ name, value: name === 'script' ? 'current.setValue("a", 1);' : 'x' }),
  });
  assert.equal((await readFormScript()).label, 'Script', 'a filled script field still wins');
});

function installChromeStorage(initial = {}) {
  const store = { ...initial };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => (key === null ? { ...store } : typeof key === 'string' ? { [key]: store[key] } : Object.fromEntries(key.map((k) => [k, store[k]]))),
        set: async (items) => Object.assign(store, items),
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  return store;
}

test('a full preset / instance / command list refuses a new entry instead of silently dropping it', async () => {
  const stores = require('../src/content/stores.js');
  installChromeStorage();
  for (let i = 0; i < 30; i += 1) await stores.addPreset({ label: `P${i}`, userName: `user${i}` });
  await assert.rejects(stores.addPreset({ label: 'New', userName: 'newbie' }), /up to 30/);
  assert.ok(!(await stores.listPresets()).some((p) => p.userName === 'newbie'));
  // Re-saving an existing entry still works when the list is full.
  const again = await stores.addPreset({ label: 'Renamed', userName: 'user3' });
  assert.ok((await stores.listPresets()).some((p) => p.id === again.id && p.label === 'Renamed'));
  for (let i = 0; i < 20; i += 1) await stores.addInstance({ label: `I${i}`, host: `inst${i}.service-now.com` });
  await assert.rejects(stores.addInstance({ host: 'extra.service-now.com' }), /up to 20/);
  assert.equal((await stores.listInstances()).length, 20);
});

test('sys_id lookup reports an expired session instead of "not found"', async () => {
  const { findRecordBySysId } = require('../src/content/quickActions.js');
  await withFetch([{ status: 401, body: '' }], async (calls) => {
    await assert.rejects(findRecordBySysId('a'.repeat(32), 'incident'), { message: EXPIRED });
    assert.equal(calls.length, 1, 'stops at the first probe');
  });
  // A table the user cannot read is still skipped.
  await withFetch([{ status: 403, body: '' }, { status: 200, body: '{"result":[{"sys_id":"x","sys_class_name":"sys_script","name":"BR"}]}' }], async () => {
    assert.deepEqual(await findRecordBySysId('a'.repeat(32), 'incident'), { table: 'sys_script', sysId: 'a'.repeat(32), name: 'BR' });
  });
});

test('table configuration ACL list matches this table only', () => {
  const { tableConfigTargets } = require('../src/content/quickActions.js');
  const acl = tableConfigTargets('incident').find((t) => t.label === 'ACLs');
  const query = decodeURIComponent(acl.url.split('sysparm_query=')[1]);
  assert.equal(query, 'name=incident^ORnameSTARTSWITHincident.');
});

test('code search: whole-word terms may end in punctuation, and inactive rows are filtered on the server', async () => {
  const { searchCode } = require('../src/content/codeSearch.js');
  const row = { sys_id: '1', name: 'BR', collection: 'incident', active: 'true', script: "var v = gr.getValue('state');\nvar w = gr.getValues();", condition: '' };
  await withFetch([{ status: 200, body: JSON.stringify({ result: [row] }) }], async (calls) => {
    const found = await searchCode('getValue(', { tables: ['sys_script'], wholeWord: true });
    assert.equal(found.totalMatches, 1);
    assert.equal(found.results[0].matches[0].lineNumber, 1);
    const query = new URL(calls[0].url, 'https://x.service-now.com').searchParams.get('sysparm_query');
    assert.equal(query, 'active=true^scriptLIKEgetValue(^ORconditionLIKEgetValue(');
    // Tables without an active column get no active condition.
    await searchCode('getValue', { tables: ['sp_widget'] });
    assert.equal(new URL(calls[1].url, 'https://x.service-now.com').searchParams.get('sysparm_query'), 'scriptLIKEgetValue^ORclient_scriptLIKEgetValue');
    await searchCode('getValue', { tables: ['sys_script'], activeOnly: false });
    assert.equal(new URL(calls[2].url, 'https://x.service-now.com').searchParams.get('sysparm_query'), 'scriptLIKEgetValue^ORconditionLIKEgetValue');
  });
});

test('stack trace resolution looks in the table the trace names first', async () => {
  const { resolveStackTrace } = require('../src/content/logs.js');
  const hit = { status: 200, body: JSON.stringify({ result: [{ sys_id: 'c1', name: 'Set priority', script: 'a();\nb();\nc();' }] }) };
  await withFetch([hit], async (calls) => {
    const { resolved } = await resolveStackTrace('Error at sys_script_client.Set priority.script:2');
    assert.equal(resolved[0].table, 'sys_script_client');
    assert.ok(calls[0].url.startsWith('/api/now/table/sys_script_client?'));
  });
  await withFetch([hit], async (calls) => {
    const { resolved } = await resolveStackTrace('Business Rule: Set priority');
    assert.equal(resolved[0].table, 'sys_script');
    assert.ok(calls[0].url.startsWith('/api/now/table/sys_script?'));
  });
});

test('palette provider search delivers only the newest, uncancelled run', async () => {
  const { latestOnly } = require('../src/content/commandPalette.js');
  const pending = [];
  const search = latestOnly((term) => new Promise((resolve) => pending.push(() => resolve(`results for ${term}`))));
  const first = search('inc');
  const second = search('incident');
  pending[1]();
  pending[0]();
  assert.equal(await first, null, 'a superseded run is dropped even when it finishes last');
  assert.equal(await second, 'results for incident');
  // The user typed again before the debounced run started: the in-flight run is cancelled.
  const third = search('prob');
  search.cancel();
  pending[2]();
  assert.equal(await third, null);
});

test('verify refuses a script that still holds a redaction placeholder where a secret was', () => {
  const ids = (code) => verifyScript({ kind: 'script_include', code }).findings.filter((f) => f.ruleId.startsWith('redacted-')).map((f) => [f.ruleId, f.severity, f.line]);
  // What the model saw (and might write back): the real password would be overwritten.
  assert.deepEqual(ids("var r = new sn_ws.RESTMessageV2();\nr.setBasicAuth('admin', '[REDACTED]');"), [['redacted-secret', 'high', 2]]);
  assert.deepEqual(ids('var password = "[REDACTED]";'), [['redacted-secret', 'high', 1]]);
  assert.equal(verifyScript({ kind: 'script_include', code: 'var password = "[REDACTED]";' }).ok, false);
  // A sanitiser that legitimately writes the word is only a note.
  assert.deepEqual(ids("function mask(s) { return s.replace(/\\d+/g, '[REDACTED]'); }"), [['redacted-placeholder', 'low', 1]]);
  assert.deepEqual(ids('var x = 1;'), []);
});

test('a GlideAjax variable whose name contains $ is matched literally', () => {
  const ajax = (code) => verifyScript({ kind: 'client_script', clientType: 'onLoad', code: `function onLoad() {\n${code}\n}` }).findings.filter((f) => f.ruleId.startsWith('ajax-')).map((f) => f.ruleId);
  assert.deepEqual(ajax("var $ga = new GlideAjax('X');\n$ga.addParam('sysparm_name', 'y');\n$ga.getXMLAnswer(function (a) {});"), []);
  assert.deepEqual(ajax("var $ga = new GlideAjax('X');\n$ga.getXML();"), ['ajax-missing-sysparm-name', 'ajax-no-callback']);
  // Another variable whose name merely ends the same way does not count.
  assert.deepEqual(ajax("var ga = new GlideAjax('X');\nmy$ga.addParam('sysparm_name', 'y');"), ['ajax-missing-sysparm-name']);
});

// ---- performance: lint / verify / apiCheck stay linear in the number of record variables ----

// A Script Include with `vars` GlideRecord-like variables in ~`lines` lines (4 per method).
function generateLargeScript(vars, { lines = 3000, reuse = false } = {}) {
  const out = ['var Big = Class.create();', 'Big.prototype = {'];
  let v = 0;
  let fn = 0;
  while (v < vars) {
    out.push(`  method${fn}: function (id) {`);
    for (let k = 0; k < 4 && v < vars; k += 1, v += 1) {
      const name = reuse ? `gr${k}` : `gr${v}`;
      const cls = v % 5 === 0 ? 'GlideAggregate' : v % 13 === 0 ? 'GlideRecordSecure' : 'GlideRecord';
      out.push(`    var ${name} = new ${cls}('incident');`);
      if (v % 3) out.push(`    ${name}.addQuery('active', true);`);
      if (cls === 'GlideAggregate' && v % 2) out.push(`    ${name}.addAggregate('COUNT');`);
      out.push(`    ${name}.query();`);
      out.push(`    while (${name}.next()) { gs.info(${name}.getValue('number')); }`);
      if (v % 7 === 0) out.push(`    ids.forEach(function (x) { var u${v} = new GlideRecord('sys_user'); u${v}.get(x); });`);
      if (v % 11 === 0) out.push(`    ${name}.setLimit(5);`);
      if (v % 17 === 0) out.push(`    ${name}.getAggregatte('COUNT');`);
    }
    out.push('    return id;', '  },');
    fn += 1;
  }
  let f = 0;
  while (out.length < lines - 2) {
    out.push(`  h${f}: function (a) { return a * ${f}; },`);
    f += 1;
  }
  out.push("  type: 'Big'", '};');
  return out.join('\n');
}

// FNV-1a over "ruleId:line|..." so a whole findings list compares as one number.
function findingsDigest(findings) {
  let h = 0x811c9dc5;
  for (const ch of findings.map((f) => `${f.ruleId}:${f.line}|`).join('')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${findings.length}/${h.toString(16)}`;
}

function largeScriptDigests() {
  const out = {};
  for (const [vars, reuse] of [[200, false], [120, true]]) {
    const code = generateLargeScript(vars, { reuse });
    out[`${vars}-${reuse}`] = {
      lint: findingsDigest(lintScript(code, { table: 'sys_script_include' })),
      api: findingsDigest(checkApiUsage(code, { side: 'server' })),
      verify: findingsDigest(verifyScript({ code, kind: 'script_include' }).findings),
    };
  }
  return out;
}

test('large generated scripts give exactly the findings of the old per-variable implementation', () => {
  // Digests recorded with the previous O(variables x script) implementation.
  assert.deepEqual(largeScriptDigests(), {
    '200-false': { lint: '83/b5302648', api: '12/dc1ad6c3', verify: '114/901ef8a8' },
    '120-true': { lint: '50/2b9252eb', api: '8/fd31a4fa', verify: '69/358825b9' },
  });
});

test('lint + verify of a 3000-line script with 200 record variables takes well under a second', () => {
  const code = generateLargeScript(200);
  assert.ok(code.split('\n').length >= 3000);
  lintScript('var gr = new GlideRecord("x");\ngr.query();', { table: 'sys_script_include' }); // warm up
  // Distinct strings, so neither call reuses the other's cached masking or scopes.
  const started = process.hrtime.bigint();
  lintScript(`${code}\n`, { table: 'sys_script_include' });
  verifyScript({ code: `${code}\n\n`, kind: 'script_include' });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // ~80 ms alone and ~125 ms inside a full `npm test` run on the development machine (it was
  // ~9.5 s before the call index); about 3x that, to stay quiet on a loaded runner.
  assert.ok(ms < 400, `lint + verify took ${ms.toFixed(0)} ms`);
});
