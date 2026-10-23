const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { createBridge } = require('../mcp/snowbuddy-mcp.js');

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop';

const TOOLS = [
  { name: 'servicenow_query', description: 'Query a table', inputSchema: { type: 'object', properties: { table: { type: 'string' } } }, tier: 'observe' },
  { name: 'servicenow_update', description: 'Update a record', inputSchema: { type: 'object', properties: {} }, tier: 'write' },
  { name: 'servicenow_draft', description: 'Draft a script', inputSchema: { type: 'object', properties: {} }, tier: 'draft' },
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'msb-mcp-'));
}

async function setup(opts = {}) {
  const dir = tmpDir();
  const generatedDir = path.join(dir, 'generated');
  fs.mkdirSync(generatedDir);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stderr.resume();
  const bridge = createBridge({
    port: 0,
    tokenPath: path.join(dir, 'home', '.mysnowbuddy', 'mcp-token'),
    stdin,
    stdout,
    stderr,
    generatedDir,
    callTimeoutMs: 2000,
    staleMs: 45000,
    ...opts,
  });
  await bridge.start();

  // Minimal MCP client over the fake stdio.
  const messages = [];
  const waiters = [];
  let buf = '';
  stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line); // throws if anything but JSON reaches stdout
      messages.push(msg);
      for (const w of waiters.slice()) if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const waitFor = (pred) => {
    const found = messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => waiters.push({ pred, resolve }));
  };
  let nextId = 1;
  const client = {
    messages,
    sendRaw: (line) => stdin.write(line + '\n'),
    request(method, params) {
      const id = nextId++;
      const p = waitFor((m) => m.id === id);
      stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return p;
    },
    notify(method, params) {
      stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    waitFor,
  };

  const base = `http://127.0.0.1:${bridge.port}`;
  const ext = {
    base,
    headers: (extra) => ({ Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json', ...extra }),
    async post(p, body, headers) {
      const res = await fetch(base + p, { method: 'POST', headers: ext.headers(headers), body: JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async get(p, headers) {
      const res = await fetch(base + p, { headers: ext.headers(headers) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    register: (tools = TOOLS) => ext.post('/v1/register', { tools, instance: { host: 'dev1.service-now.com' }, version: '0.5.0' }),
  };

  const cleanup = async () => {
    await bridge.stop();
    stdin.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { bridge, client, ext, dir, generatedDir, cleanup };
}

// Raw request so we can control the Host header (fetch forbids it).
function rawRequest({ port, path: p, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('token file is created with a 64-hex token and reused', async () => {
  const s = await setup();
  try {
    assert.match(s.bridge.token, /^[0-9a-f]{64}$/);
    const file = path.join(s.dir, 'home', '.mysnowbuddy', 'mcp-token');
    assert.equal(fs.readFileSync(file, 'utf8').trim(), s.bridge.token);
    const again = createBridge({ port: 0, tokenPath: file, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    assert.equal(again.token, s.bridge.token);
  } finally {
    await s.cleanup();
  }
});

test('health is open; other endpoints require the bearer token', async () => {
  const s = await setup();
  try {
    const health = await fetch(s.ext.base + '/v1/health');
    assert.equal(health.status, 200);
    const hb = await health.json();
    assert.equal(hb.ok, true);
    assert.equal(hb.name, 'mysnowbuddy-mcp');

    const none = await fetch(s.ext.base + '/v1/poll?wait=0');
    assert.equal(none.status, 401);
    const wrong = await fetch(s.ext.base + '/v1/poll?wait=0', { headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
    const reg = await fetch(s.ext.base + '/v1/register', { method: 'POST', body: '{}' });
    assert.equal(reg.status, 401);
    const ok = await s.ext.get('/v1/poll?wait=0');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { calls: [] });
  } finally {
    await s.cleanup();
  }
});

test('rejects bad Host and bad Origin; CORS only for extension origins', async () => {
  const s = await setup();
  try {
    const badHost = await rawRequest({ port: s.bridge.port, path: '/v1/health', headers: { Host: 'evil.example.com' } });
    assert.equal(badHost.status, 403);
    const wrongPort = await rawRequest({ port: s.bridge.port, path: '/v1/health', headers: { Host: '127.0.0.1:1' } });
    assert.equal(wrongPort.status, 403);
    const localhost = await rawRequest({ port: s.bridge.port, path: '/v1/health', headers: { Host: `localhost:${s.bridge.port}` } });
    assert.equal(localhost.status, 200);

    const webOrigin = await rawRequest({
      port: s.bridge.port,
      path: '/v1/health',
      headers: { Host: `127.0.0.1:${s.bridge.port}`, Origin: 'https://evil.example.com' },
    });
    assert.equal(webOrigin.status, 403);

    const extOrigin = await rawRequest({
      port: s.bridge.port,
      path: '/v1/health',
      headers: { Host: `127.0.0.1:${s.bridge.port}`, Origin: EXT_ORIGIN },
    });
    assert.equal(extOrigin.status, 200);
    assert.equal(extOrigin.headers['access-control-allow-origin'], EXT_ORIGIN);

    const preflight = await rawRequest({
      port: s.bridge.port,
      path: '/v1/register',
      method: 'OPTIONS',
      headers: { Host: `127.0.0.1:${s.bridge.port}`, Origin: EXT_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], EXT_ORIGIN);
    assert.match(preflight.headers['access-control-allow-headers'], /Authorization/);
  } finally {
    await s.cleanup();
  }
});

test('request bodies over 2 MB are rejected', async () => {
  const s = await setup();
  try {
    const big = JSON.stringify({ tools: [], pad: 'x'.repeat(2 * 1024 * 1024 + 10) });
    const res = await rawRequest({
      port: s.bridge.port,
      path: '/v1/register',
      method: 'POST',
      headers: { Host: `127.0.0.1:${s.bridge.port}`, Authorization: `Bearer ${s.bridge.token}`, 'Content-Type': 'application/json' },
      body: big,
    }).catch((err) => ({ status: 'error', err }));
    assert.ok(res.status === 413 || res.status === 'error');
    // Bridge still serves afterwards.
    assert.equal((await fetch(s.ext.base + '/v1/health')).status, 200);
  } finally {
    await s.cleanup();
  }
});

test('MCP initialize, ping, unknown method and parse errors', async () => {
  const s = await setup();
  try {
    const init = await s.client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: true }, resources: {} });
    assert.equal(init.result.serverInfo.name, 'mysnowbuddy');
    assert.equal(typeof init.result.instructions, 'string');

    const init2 = await s.client.request('initialize', {});
    assert.equal(init2.result.protocolVersion, '2025-03-26');

    s.client.notify('notifications/initialized');
    const ping = await s.client.request('ping');
    assert.deepEqual(ping.result, {});

    const unknown = await s.client.request('bogus/method');
    assert.equal(unknown.error.code, -32601);

    s.client.sendRaw('{"jsonrpc":"2.0","id":99,"method":"ping"');
    const parse = await s.client.waitFor((m) => m.id === 99);
    assert.equal(parse.error.code, -32700);

    const before = s.client.messages.length;
    s.client.sendRaw('not json at all');
    const after = await s.client.request('ping');
    assert.deepEqual(after.result, {});
    assert.equal(s.client.messages.length, before + 1, 'garbage without an id gets no reply');
  } finally {
    await s.cleanup();
  }
});

test('register replaces the tool list and emits list_changed once per change', async () => {
  const s = await setup();
  try {
    const empty = await s.client.request('tools/list');
    assert.deepEqual(empty.result.tools.map((t) => t.name), ['snowbuddy_status']);

    assert.deepEqual((await s.ext.register()).body, { ok: true });
    await s.client.waitFor((m) => m.method === 'notifications/tools/list_changed');
    const listed = await s.client.request('tools/list');
    const byName = Object.fromEntries(listed.result.tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), ['servicenow_draft', 'servicenow_query', 'servicenow_update', 'snowbuddy_status']);
    assert.equal(byName.servicenow_query.annotations.readOnlyHint, true);
    assert.equal(byName.servicenow_draft.annotations.readOnlyHint, true);
    assert.equal(byName.servicenow_update.annotations.readOnlyHint, false);
    assert.equal(byName.servicenow_query.inputSchema.properties.table.type, 'string');

    const notifications = () => s.client.messages.filter((m) => m.method === 'notifications/tools/list_changed').length;
    assert.equal(notifications(), 1);
    await s.ext.register(); // identical -> no new notification
    await s.client.request('ping');
    assert.equal(notifications(), 1);
    await s.ext.register(TOOLS.slice(0, 1));
    await s.client.request('ping');
    assert.equal(notifications(), 2);
    const replaced = await s.client.request('tools/list');
    assert.deepEqual(replaced.result.tools.map((t) => t.name), ['servicenow_query', 'snowbuddy_status']);
  } finally {
    await s.cleanup();
  }
});

test('tools/list falls back to the generated snapshot until the extension registers', async () => {
  const s = await setup();
  try {
    fs.writeFileSync(path.join(s.generatedDir, 'tools.json'), JSON.stringify([TOOLS[0]]));
    const before = await s.client.request('tools/list');
    assert.deepEqual(before.result.tools.map((t) => t.name), ['servicenow_query', 'snowbuddy_status']);
    await s.ext.register(TOOLS.slice(1, 2));
    const after = await s.client.request('tools/list');
    assert.deepEqual(after.result.tools.map((t) => t.name), ['servicenow_update', 'snowbuddy_status']);
  } finally {
    await s.cleanup();
  }
});

test('tools/call round trip through poll and result', async () => {
  const s = await setup();
  try {
    await s.ext.register();
    const call = s.client.request('tools/call', { name: 'servicenow_query', arguments: { table: 'incident' } });
    const polled = await s.ext.get('/v1/poll?wait=2000');
    assert.equal(polled.body.calls.length, 1);
    const [{ id, tool, args }] = polled.body.calls;
    assert.equal(tool, 'servicenow_query');
    assert.deepEqual(args, { table: 'incident' });

    const posted = await s.ext.post('/v1/result', { id, ok: true, result: { rows: [{ number: 'INC1' }] } });
    assert.equal(posted.status, 200);
    const done = await call;
    assert.equal(done.result.isError, undefined);
    assert.deepEqual(JSON.parse(done.result.content[0].text), { rows: [{ number: 'INC1' }] });

    // Result for a finished/unknown id.
    assert.equal((await s.ext.post('/v1/result', { id, ok: true, result: 1 })).status, 404);
  } finally {
    await s.cleanup();
  }
});

test('a waiting long-poll is released as soon as a call is queued', async () => {
  const s = await setup();
  try {
    await s.ext.register();
    const poll = s.ext.get('/v1/poll?wait=5000');
    await new Promise((r) => setTimeout(r, 50));
    const call = s.client.request('tools/call', { name: 'servicenow_query', arguments: {} });
    const polled = await poll;
    assert.equal(polled.body.calls.length, 1);
    await s.ext.post('/v1/result', { id: polled.body.calls[0].id, ok: false, error: 'boom' });
    const done = await call;
    assert.equal(done.result.isError, true);
    assert.equal(done.result.content[0].text, 'boom');
  } finally {
    await s.cleanup();
  }
});

test('long poll returns empty calls after the wait elapses', async () => {
  const s = await setup();
  try {
    const t0 = Date.now();
    const res = await s.ext.get('/v1/poll?wait=150');
    assert.deepEqual(res.body, { calls: [] });
    assert.ok(Date.now() - t0 >= 100);
  } finally {
    await s.cleanup();
  }
});

test('large results are truncated', async () => {
  const s = await setup();
  try {
    await s.ext.register();
    const call = s.client.request('tools/call', { name: 'servicenow_query', arguments: {} });
    const polled = await s.ext.get('/v1/poll?wait=2000');
    await s.ext.post('/v1/result', { id: polled.body.calls[0].id, ok: true, result: { blob: 'x'.repeat(100000) } });
    const done = await call;
    const text = done.result.content[0].text;
    assert.ok(text.length < 61000);
    assert.match(text, /truncated/);
  } finally {
    await s.cleanup();
  }
});

test('tools/call times out when the extension never answers', async () => {
  const s = await setup({ callTimeoutMs: 200 });
  try {
    await s.ext.register();
    const done = await s.client.request('tools/call', { name: 'servicenow_query', arguments: {} });
    assert.equal(done.result.isError, true);
    assert.match(done.result.content[0].text, /Timed out/);
  } finally {
    await s.cleanup();
  }
});

test('tools/call fails fast when the extension is not connected', async () => {
  const s = await setup();
  try {
    fs.writeFileSync(path.join(s.generatedDir, 'tools.json'), JSON.stringify([TOOLS[0]]));
    const t0 = Date.now();
    const done = await s.client.request('tools/call', { name: 'servicenow_query', arguments: {} });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(done.result.isError, true);
    assert.match(done.result.content[0].text, /ServiceNow tab/);
    assert.match(done.result.content[0].text, /token/);
  } finally {
    await s.cleanup();
  }
});

test('a stale extension (no poll within staleMs) also fails fast', async () => {
  const s = await setup({ staleMs: 100 });
  try {
    await s.ext.register();
    await new Promise((r) => setTimeout(r, 200));
    const done = await s.client.request('tools/call', { name: 'servicenow_query', arguments: {} });
    assert.equal(done.result.isError, true);
    assert.match(done.result.content[0].text, /not connected/);
  } finally {
    await s.cleanup();
  }
});

test('unknown tool and missing name are -32602', async () => {
  const s = await setup();
  try {
    await s.ext.register();
    const unknown = await s.client.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.error.code, -32602);
    const missing = await s.client.request('tools/call', {});
    assert.equal(missing.error.code, -32602);
  } finally {
    await s.cleanup();
  }
});

test('snowbuddy_status reports connection state', async () => {
  const s = await setup();
  try {
    const status = async () => JSON.parse((await s.client.request('tools/call', { name: 'snowbuddy_status', arguments: {} })).result.content[0].text);
    const before = await status();
    assert.equal(before.bridgeConnected, false);
    assert.equal(before.lastSeenSecondsAgo, null);
    assert.equal(before.toolCount, 0);

    await s.ext.register();
    const after = await status();
    assert.equal(after.bridgeConnected, true);
    assert.equal(after.instance.host, 'dev1.service-now.com');
    assert.equal(after.toolCount, 3);
    assert.equal(typeof after.lastSeenSecondsAgo, 'number');
  } finally {
    await s.cleanup();
  }
});

test('skills are exposed as resources', async () => {
  const s = await setup();
  try {
    const none = await s.client.request('resources/list');
    assert.deepEqual(none.result.resources, []);

    fs.writeFileSync(
      path.join(s.generatedDir, 'skills.json'),
      JSON.stringify([{ id: 'business-rules', title: 'Business rules', description: 'How to write them', text: '# Business rules\nUse gs.info.' }])
    );
    const list = await s.client.request('resources/list');
    assert.equal(list.result.resources.length, 1);
    assert.equal(list.result.resources[0].uri, 'mysnowbuddy://skills/business-rules');
    assert.equal(list.result.resources[0].mimeType, 'text/markdown');

    const read = await s.client.request('resources/read', { uri: 'mysnowbuddy://skills/business-rules' });
    assert.equal(read.result.contents[0].text, '# Business rules\nUse gs.info.');
    assert.equal(read.result.contents[0].mimeType, 'text/markdown');

    const missing = await s.client.request('resources/read', { uri: 'mysnowbuddy://skills/nope' });
    assert.ok(missing.error);
  } finally {
    await s.cleanup();
  }
});

test('stdout only ever carries JSON-RPC', async () => {
  const s = await setup();
  try {
    await s.ext.register();
    await s.client.request('tools/list');
    for (const m of s.client.messages) assert.equal(m.jsonrpc, '2.0');
  } finally {
    await s.cleanup();
  }
});

// ---- extension side (src/background/mcpBridge.js) against the real bridge ----

test('extension client registers, relays calls to a ServiceNow tab and reports results', async () => {
  const s = await setup();
  const listeners = { changed: [] };
  const sent = [];
  let tabs = [{ id: 7, url: 'https://dev1.service-now.com/now/nav/ui/home', active: true, lastAccessed: 5 }];
  const settings = { mcpBridgeEnabled: true, mcpToken: s.bridge.token, mcpPort: s.bridge.port };
  globalThis.chrome = {
    storage: {
      local: { get: async () => ({ mysnowbuddy_settings: settings }) },
      onChanged: { addListener: (fn) => listeners.changed.push(fn) },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { getManifest: () => ({ version: '9.9.9' }) },
    windows: { getLastFocused: async () => ({ id: 1 }) },
    tabs: {
      query: async (q) => {
        if (q.active) return tabs.filter((t) => t.active);
        return tabs.filter((t) => !q.url || (q.url === 'https://*.service-now.com/*' ? /service-now\.com/.test(t.url) : t.url.startsWith(q.url.replace('/*', ''))));
      },
      sendMessage: async (tabId, msg, opts) => {
        sent.push({ tabId, msg, opts });
        if (msg.type === 'AGENT_TOOL_CANCEL') return { ok: true };
        if (msg.args && msg.args.hang) return new Promise(() => {}); // a call stuck on an approval card
        return { ok: true, result: { echoed: msg.args } };
      },
    },
  };
  try {
    const { startMcpBridge, getMcpStatus } = await import('../src/background/mcpBridge.js');
    startMcpBridge();

    const list = async () => (await s.client.request('tools/list')).result.tools;
    for (let i = 0; i < 100 && (await list()).length <= 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok((await list()).length > 1, 'extension registered its tools');

    const name = (await list()).find((t) => t.name !== 'snowbuddy_status').name;
    const done = await s.client.request('tools/call', { name, arguments: { table: 'incident' } });
    assert.equal(done.result.isError, undefined);
    assert.deepEqual(JSON.parse(done.result.content[0].text), { echoed: { table: 'incident' } });
    assert.equal(sent[0].tabId, 7);
    assert.match(sent[0].msg.callId, /^[0-9a-f-]{36}$/, 'the page is told which call this is, so it can be cancelled');
    assert.deepEqual(sent[0].msg, { type: 'AGENT_TOOL_CALL', callId: sent[0].msg.callId, tool: name, args: { table: 'incident' }, source: 'mcp' });
    assert.deepEqual(sent[0].opts, { frameId: 0 });
    assert.equal(getMcpStatus().state, 'connected');
    assert.equal(getMcpStatus().lastCall.tool, name);

    // A call that never finishes: when the bridge times out, the extension must tell the tab to cancel exactly that call.
    const hung = await s.client.request('tools/call', { name, arguments: { hang: true } });
    assert.match(hung.result.content[0].text, /Timed out/);
    for (let i = 0; i < 100 && !sent.some((x) => x.msg.type === 'AGENT_TOOL_CANCEL'); i++) await new Promise((r) => setTimeout(r, 20));
    const cancel = sent.find((x) => x.msg.type === 'AGENT_TOOL_CANCEL');
    assert.ok(cancel, 'the extension relayed the cancel');
    assert.equal(cancel.tabId, 7);
    assert.equal(cancel.msg.callId, sent.find((x) => x.msg.args && x.msg.args.hang).msg.callId);

    tabs = [];
    const none = await s.client.request('tools/call', { name, arguments: {} });
    assert.equal(none.result.isError, true);
    assert.match(none.result.content[0].text, /No ServiceNow tab/);
  } finally {
    // Disable the bridge so the poll loop stops and the process can exit.
    settings.mcpBridgeEnabled = false;
    for (const fn of listeners.changed) fn({ mysnowbuddy_settings: {} }, 'local');
    await new Promise((r) => setTimeout(r, 50));
    await s.cleanup();
    delete globalThis.chrome;
  }
});

test('a call the extension already picked up is cancelled when the bridge times out', async () => {
  const s = await setup({ callTimeoutMs: 250 });
  try {
    await s.ext.register();
    const call = s.client.request('tools/call', { name: 'servicenow_update', arguments: {} });
    const polled = await s.ext.get('/v1/poll?wait=2000');
    const [{ id }] = polled.body.calls;
    const done = await call; // times out: the extension never answers (e.g. the approval card is left open)
    assert.match(done.result.content[0].text, /Timed out/);
    assert.match(done.result.content[0].text, /cancelled/);

    const next = await s.ext.get('/v1/poll?wait=500');
    assert.deepEqual(next.body.cancel, [id], 'the extension is told to dismiss the card and refuse to run it');
    assert.equal((await s.ext.post('/v1/result', { id, ok: true, result: 1 })).status, 404, 'a late result is rejected');
  } finally {
    await s.cleanup();
  }
});

test('notifications/cancelled from the client cancels the call and gets no reply', async () => {
  const s = await setup();
  try {
    await s.ext.register();
    s.client.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 'req-77', method: 'tools/call', params: { name: 'servicenow_update', arguments: {} } }));
    const polled = await s.ext.get('/v1/poll?wait=2000');
    const [{ id }] = polled.body.calls;

    s.client.notify('notifications/cancelled', { requestId: 'req-77', reason: 'user stopped' });
    const next = await s.ext.get('/v1/poll?wait=2000');
    assert.deepEqual(next.body.cancel, [id]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!s.client.messages.some((m) => m.id === 'req-77'), 'a cancelled request must not be answered');
  } finally {
    await s.cleanup();
  }
});

test('a cancel is delivered to a poll that is already waiting', async () => {
  const s = await setup({ callTimeoutMs: 300 });
  try {
    await s.ext.register();
    const call = s.client.request('tools/call', { name: 'servicenow_update', arguments: {} });
    const first = await s.ext.get('/v1/poll?wait=2000');
    const [{ id }] = first.body.calls;
    const waiting = s.ext.get('/v1/poll?wait=3000'); // the extension is long-polling when the timer fires
    await call;
    assert.deepEqual((await waiting).body.cancel, [id]);
  } finally {
    await s.cleanup();
  }
});

test('annotations: reads are read-only, navigate and writes are not; the generated snapshot lists the control tools', async () => {
  const s = await setup();
  try {
    await s.ext.register([
      { name: 'read_page', description: 'Read', inputSchema: { type: 'object', properties: {} }, tier: 'observe' },
      { name: 'navigate', description: 'Open', inputSchema: { type: 'object', properties: {} }, tier: 'observe' },
      { name: 'update_record', description: 'Write', inputSchema: { type: 'object', properties: {} }, tier: 'write' },
    ]);
    const hints = Object.fromEntries((await s.client.request('tools/list')).result.tools.map((t) => [t.name, t.annotations.readOnlyHint]));
    assert.deepEqual(hints, { read_page: true, navigate: false, update_record: false, snowbuddy_status: true });
  } finally {
    await s.cleanup();
  }
  const { TOOL_SCHEMAS: snapshot } = require('../src/lib/agent/snapshot.js');
  const names = snapshot.map((t) => t.name);
  for (const n of ['read_page', 'navigate', 'click_ui_action', 'update_record', 'screenshot', 'list_tabs']) assert.ok(names.includes(n), n);
  assert.ok(snapshot.find((t) => t.name === 'read_page').inputSchema.properties.tab_id, 'tab routing is advertised');
  // The read-only analysis tools an MCP client can call (why was no email sent, what is stuck, ...) are observe tier, so a
  // "Read only" ceiling keeps them and the client sees them as read-only.
  for (const n of ['explain_access', 'explain_field', 'check_update_set', 'scan_instance_health', 'explain_email', 'explain_process', 'map_table', 'find_dotwalk_path', 'explain_preview_problems', 'find_artifact', 'run_selfcheck', 'find_property', 'read_client_trace']) {
    const entry = snapshot.find((t) => t.name === n);
    assert.ok(entry, `${n} is in the snapshot`);
    assert.equal(entry.tier, 'observe', n);
    assert.ok(entry.inputSchema.properties.tab_id && entry.inputSchema.properties.instance, `${n} can be pointed at a tab`);
  }
});
