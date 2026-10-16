#!/usr/bin/env node
'use strict';
// MySnowBuddy local MCP bridge.
//
// One process, two faces:
//   1. An MCP server (newline-delimited JSON-RPC 2.0 over stdio) that an MCP
//      client such as Claude Code launches.
//   2. A loopback-only HTTP server (127.0.0.1) that the MySnowBuddy browser
//      extension registers its tools with and long-polls for tool calls.
//
// stdout carries JSON-RPC and nothing else. All logging goes to stderr.
// No third-party dependencies; Node >= 18.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');

const VERSION = '0.1.0';
const DEFAULT_PORT = 17345;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Tool results may carry one screenshot (base64), so /v1/result accepts more than the other endpoints.
const MAX_RESULT_BODY_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_CHARS = 60000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);
const DEFAULT_PROTOCOL = '2025-03-26';
const ORIGIN_RE = /^(chrome-extension|moz-extension):\/\//;

const INSTRUCTIONS =
  'These tools act on the user\'s live, logged-in ServiceNow session through the MySnowBuddy browser extension. ' +
  'Work in loops: read_page (or get_instance_info) to see where you are, navigate to open a list or record, act, then ' +
  'read_page again to verify. Prefer Table API tools (query_table, create_record, update_record) over clicking. ' +
  'Run and write tools prompt the user for approval in the browser, so a call may take a while; if one is declined, ' +
  'do not retry it. Use list_tabs and tab_id when several ServiceNow tabs are open. ' +
  'Read the mysnowbuddy://skills/* resources first for guidance on writing scripts.';

const STATUS_TOOL = {
  name: 'snowbuddy_status',
  description:
    'Report whether the MySnowBuddy browser extension is connected to this bridge, the connected ServiceNow instance and how many tools are registered.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

function defaultTokenPath() {
  return path.join(os.homedir(), '.mysnowbuddy', 'mcp-token');
}

function loadOrCreateToken(tokenPath) {
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(existing)) return existing;
  } catch {
    // Fall through and create one.
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600); // no-op on Windows
  } catch {
    // Not supported on this platform.
  }
  return token;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function normalizeTool(t) {
  if (!t || typeof t.name !== 'string' || !t.name) return null;
  return {
    name: t.name,
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
    tier: typeof t.tier === 'string' ? t.tier : 'write',
  };
}

function toMcpTool(t) {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    // navigate changes no data but does change what the user's tab shows, so it is not advertised as read-only.
    annotations: { readOnlyHint: (t.tier === 'observe' || t.tier === 'draft') && t.name !== 'navigate' },
  };
}

function textResult(text, isError) {
  const out = { content: [{ type: 'text', text: String(text) }] };
  if (isError) out.isError = true;
  return out;
}

/** A screenshot from the extension as MCP image content, followed by its description; null when malformed. */
function imageContent(image) {
  if (!image || typeof image !== 'object' || !IMAGE_TYPES.has(image.mimeType)) return null;
  const data = typeof image.data === 'string' ? image.data : '';
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  return { type: 'image', data, mimeType: image.mimeType };
}

function createBridge(options = {}) {
  const tokenPath = options.tokenPath || defaultTokenPath();
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const generatedDir = options.generatedDir || path.join(__dirname, 'generated');
  const callTimeoutMs = options.callTimeoutMs ?? 180000;
  // How long a call that has started executing (approved in the browser) may still take before we give up on it.
  const execTimeoutMs = options.execTimeoutMs ?? 600000;
  const staleMs = options.staleMs ?? 45000;
  const maxPollWaitMs = options.maxPollWaitMs ?? 25000;
  const version = options.version || VERSION;
  const requestedPort = options.port ?? (Number(process.env.MYSNOWBUDDY_PORT) || DEFAULT_PORT);

  const token = loadOrCreateToken(tokenPath);

  let server = null;
  let rl = null;
  let boundPort = requestedPort;
  let stopped = false;

  let registered = []; // normalized tools from the extension
  let registeredKey = '';
  let instance = null;
  let lastSeen = 0;
  const queue = []; // calls waiting for the extension to pick up
  const pending = new Map(); // id -> {resolve, timer}
  const cancels = []; // ids the extension already picked up and must now stop
  const byRequest = new Map(); // JSON-RPC request id -> call id, so notifications/cancelled can find the call
  let waiter = null; // the one active long-poll {res, timer}

  const log = (...args) => {
    try {
      stderr.write(`[mysnowbuddy-mcp] ${args.join(' ')}\n`);
    } catch {
      // stderr gone; nothing to do.
    }
  };

  // ---- stdio (MCP) -------------------------------------------------------

  function send(msg) {
    if (stopped) return;
    stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }
  const reply = (id, result) => send({ id, result });
  const replyError = (id, code, message) => send({ id, error: { code, message } });

  function currentTools() {
    if (registered.length) return registered;
    const snapshot = readJsonFile(path.join(generatedDir, 'tools.json'));
    if (Array.isArray(snapshot)) return snapshot.map(normalizeTool).filter(Boolean);
    return [];
  }

  function skills() {
    const list = readJsonFile(path.join(generatedDir, 'skills.json'));
    if (!Array.isArray(list)) return [];
    return list.filter((s) => s && typeof s.id === 'string' && s.id);
  }

  function isConnected() {
    return lastSeen > 0 && Date.now() - lastSeen <= staleMs;
  }

  function statusPayload() {
    return {
      bridgeConnected: isConnected(),
      lastSeenSecondsAgo: lastSeen ? Math.round((Date.now() - lastSeen) / 1000) : null,
      instance: instance || null,
      toolCount: currentTools().length,
    };
  }

  function formatResult(result) {
    let text;
    try {
      text = JSON.stringify(result, null, 2);
    } catch {
      text = String(result);
    }
    if (text === undefined) text = 'null';
    if (text.length > MAX_RESULT_CHARS) {
      text = text.slice(0, MAX_RESULT_CHARS) + `\n...[truncated ${text.length - MAX_RESULT_CHARS} characters]`;
    }
    return text;
  }

  // Forget a call and, if the extension already has it, tell the extension to stop it (dismiss the approval card,
  // refuse to execute). Otherwise a timed-out or cancelled call could still be approved and run later.
  function cancelCall(id) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    const qi = queue.findIndex((c) => c.id === id);
    if (qi >= 0) queue.splice(qi, 1);
    else {
      cancels.push(id);
      flushWaiter();
    }
    return true;
  }

  function dispatchCall(tool, args, requestId) {
    return new Promise((resolveCall) => {
      const id = crypto.randomUUID();
      const resolve = (value) => {
        if (requestId !== undefined && requestId !== null) byRequest.delete(requestId);
        resolveCall(value);
      };
      if (requestId !== undefined && requestId !== null) byRequest.set(requestId, id);
      // Before the browser reports the call as started (approved and executing), a timeout really means nothing ran:
      // the call is withdrawn from the browser. After it started, only "it may have run" is honest.
      const timer = setTimeout(() => {
        cancelCall(id);
        resolve(
          textResult(
            `Timed out after ${Math.round(callTimeoutMs / 1000)}s waiting for "${tool}" (no approval in the browser). The call was cancelled there and did not run; ask again if you still want it.`,
            true
          )
        );
      }, callTimeoutMs);
      pending.set(id, { resolve, timer, tool, started: false });
      queue.push({ id, tool, args });
      flushWaiter();
    });
  }

  async function handleToolsCall(params, requestId) {
    const name = params && params.name;
    if (typeof name !== 'string' || !name) return { error: [-32602, 'Missing tool name'] };
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};

    if (name === STATUS_TOOL.name) return { result: textResult(JSON.stringify(statusPayload(), null, 2)) };

    const tool = currentTools().find((t) => t.name === name);
    if (!tool) return { error: [-32602, `Unknown tool: ${name}`] };

    if (!isConnected()) {
      return {
        result: textResult(
          'The MySnowBuddy extension is not connected to this bridge. Open a ServiceNow tab in a browser with MySnowBuddy installed, ' +
            'enable Agent > Local MCP bridge in its options, and check that the pairing token matches ' +
            `the one in ${tokenPath}.`,
          true
        ),
      };
    }
    return { result: await dispatchCall(name, args, requestId) };
  }

  async function handleRequest(msg) {
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;
    switch (method) {
      case 'initialize': {
        const pv = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL;
        return reply(id, {
          protocolVersion: pv,
          capabilities: { tools: { listChanged: true }, resources: {} },
          serverInfo: { name: 'mysnowbuddy', version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'notifications/initialized':
        return undefined;
      case 'notifications/cancelled': {
        const callId = params && byRequest.get(params.requestId);
        const entry = callId && pending.get(callId);
        if (entry) {
          cancelCall(callId);
          entry.resolve({ cancelled: true });
        }
        return undefined;
      }
      case 'ping':
        return isNotification ? undefined : reply(id, {});
      case 'tools/list':
        return reply(id, { tools: [...currentTools().map(toMcpTool), STATUS_TOOL] });
      case 'tools/call': {
        const out = await handleToolsCall(params, id);
        if (isNotification || (out.result && out.result.cancelled)) return undefined; // a cancelled request gets no reply
        return out.error ? replyError(id, out.error[0], out.error[1]) : reply(id, out.result);
      }
      case 'resources/list':
        return reply(id, {
          resources: skills().map((s) => ({
            uri: `mysnowbuddy://skills/${s.id}`,
            name: s.id,
            title: s.title || s.id,
            description: s.description || '',
            mimeType: 'text/markdown',
          })),
        });
      case 'resources/read': {
        const uri = params && params.uri;
        const prefix = 'mysnowbuddy://skills/';
        const skill = typeof uri === 'string' && uri.startsWith(prefix) ? skills().find((s) => s.id === uri.slice(prefix.length)) : null;
        if (!skill) return replyError(id, -32002, `Resource not found: ${uri}`);
        return reply(id, { contents: [{ uri, mimeType: 'text/markdown', text: String(skill.text || '') }] });
      }
      default:
        if (isNotification) return undefined;
        return replyError(id, -32601, `Method not found: ${method}`);
    }
  }

  function onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const m = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(trimmed);
      if (m) {
        let id = null;
        try {
          id = JSON.parse(m[1]);
        } catch {
          // keep null
        }
        replyError(id, -32700, 'Parse error');
      } else {
        log('ignoring unparseable stdin line');
      }
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const msg of messages) {
      // Responses to server-initiated requests (we send none) and junk are ignored.
      if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') continue;
      Promise.resolve(handleRequest(msg)).catch((err) => {
        log('handler error:', err && err.message);
        if (msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, 'Internal error');
      });
    }
  }

  // ---- HTTP (extension side) ---------------------------------------------

  function flushWaiter() {
    if (!waiter || (!queue.length && !cancels.length)) return;
    const w = waiter;
    waiter = null;
    clearTimeout(w.timer);
    lastSeen = Date.now();
    json(w.res, 200, { calls: queue.splice(0, queue.length), cancel: cancels.splice(0, cancels.length) }, w.cors);
  }

  function corsHeaders(origin) {
    if (!origin) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }

  function json(res, status, body, cors) {
    if (res.writableEnded || res.destroyed) return;
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      ...(cors || {}),
    });
    res.end(data);
  }

  function readBody(req, limit = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          const err = new Error('Request body too large');
          err.status = 413;
          reject(err);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          const err = new Error('Invalid JSON');
          err.status = 400;
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  function hostAllowed(host) {
    return host === `127.0.0.1:${boundPort}` || host === `localhost:${boundPort}`;
  }

  async function onHttp(req, res) {
    const origin = req.headers.origin;
    if (!hostAllowed(req.headers.host)) return json(res, 403, { error: 'Bad Host header' });
    if (origin !== undefined && !ORIGIN_RE.test(origin)) return json(res, 403, { error: 'Origin not allowed' });
    const cors = corsHeaders(origin);

    const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
    const route = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.method === 'GET' && route === '/v1/health') {
      return json(res, 200, { ok: true, name: 'mysnowbuddy-mcp', version }, cors);
    }

    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!bearer || !safeEqual(bearer, token)) return json(res, 401, { error: 'Unauthorized' }, cors);

    try {
      if (req.method === 'POST' && route === '/v1/register') {
        const body = await readBody(req);
        const tools = (Array.isArray(body.tools) ? body.tools : []).map(normalizeTool).filter(Boolean);
        const key = JSON.stringify(tools);
        const changed = key !== registeredKey;
        registered = tools;
        registeredKey = key;
        instance = body.instance && typeof body.instance === 'object' ? { host: String(body.instance.host || '') } : null;
        lastSeen = Date.now();
        if (changed) send({ method: 'notifications/tools/list_changed' });
        return json(res, 200, { ok: true }, cors);
      }

      if (req.method === 'GET' && route === '/v1/poll') {
        const wait = Math.max(0, Math.min(Number(url.searchParams.get('wait')) || 0, maxPollWaitMs));
        lastSeen = Date.now();
        if (queue.length || cancels.length) return json(res, 200, { calls: queue.splice(0, queue.length), cancel: cancels.splice(0, cancels.length) }, cors);
        if (waiter) {
          // A newer poll supersedes the old one (e.g. after a service worker restart).
          const old = waiter;
          waiter = null;
          clearTimeout(old.timer);
          json(old.res, 200, { calls: [] }, old.cors);
        }
        const w = { res, cors, timer: null };
        w.timer = setTimeout(() => {
          if (waiter === w) waiter = null;
          lastSeen = Date.now();
          json(res, 200, { calls: [] }, cors);
        }, wait);
        waiter = w;
        res.on('close', () => {
          if (waiter === w) {
            waiter = null;
            clearTimeout(w.timer);
          }
        });
        return undefined;
      }

      if (req.method === 'POST' && route === '/v1/started') {
        // The browser approved the call and is executing it: the approval timeout no longer applies, and if no result
        // ever arrives the client is told it may have run.
        const body = await readBody(req);
        const entry = pending.get(body.id);
        lastSeen = Date.now();
        if (!entry) return json(res, 404, { error: 'Unknown call id' }, cors);
        if (!entry.started) {
          entry.started = true;
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            if (pending.get(body.id) !== entry) return;
            pending.delete(body.id);
            entry.resolve(
              textResult(
                `"${entry.tool}" was approved and started in the browser, but no result arrived within ${Math.round(execTimeoutMs / 1000)}s. It may have run: check with read_page or query_table before you try again.`,
                true
              )
            );
          }, execTimeoutMs);
        }
        return json(res, 200, { ok: true }, cors);
      }

      if (req.method === 'POST' && route === '/v1/result') {
        const body = await readBody(req, MAX_RESULT_BODY_BYTES);
        const entry = pending.get(body.id);
        lastSeen = Date.now();
        if (!entry) return json(res, 404, { error: 'Unknown call id' }, cors);
        pending.delete(body.id);
        clearTimeout(entry.timer);
        if (body.ok) {
          const result = textResult(formatResult(body.result));
          const image = body.image !== undefined ? imageContent(body.image) : null;
          if (image) result.content.unshift(image);
          else if (body.image !== undefined) result.content.push({ type: 'text', text: '(The screenshot could not be attached: unsupported image data.)' });
          entry.resolve(result);
        } else entry.resolve(textResult(typeof body.error === 'string' && body.error ? body.error : formatResult(body.error ?? 'Tool call failed'), true));
        return json(res, 200, { ok: true }, cors);
      }

      return json(res, 404, { error: 'Not found' }, cors);
    } catch (err) {
      return json(res, err.status || 500, { error: err.message || 'Error' }, cors);
    }
  }

  // ---- lifecycle ---------------------------------------------------------

  const bridge = {
    token,
    get port() {
      return boundPort;
    },
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          onHttp(req, res).catch((err) => {
            log('http error:', err && err.message);
            json(res, 500, { error: 'Internal error' });
          });
        });
        server.once('error', reject);
        server.listen(requestedPort, '127.0.0.1', () => {
          server.removeListener('error', reject);
          server.on('error', (err) => log('http server error:', err.message));
          boundPort = server.address().port;
          rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
          rl.on('line', onLine);
          rl.on('close', () => {
            if (typeof options.onStdinClose === 'function') options.onStdinClose();
          });
          log(`listening on http://127.0.0.1:${boundPort}`);
          resolve(bridge);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        stopped = true;
        if (rl) rl.close();
        if (waiter) {
          clearTimeout(waiter.timer);
          json(waiter.res, 200, { calls: [] }, waiter.cors);
          waiter = null;
        }
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.resolve(textResult('The MySnowBuddy bridge is shutting down.', true));
          pending.delete(id);
        }
        if (!server) return resolve();
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
      });
    },
  };
  return bridge;
}

async function main() {
  const tokenPath = process.env.MYSNOWBUDDY_TOKEN_PATH || defaultTokenPath();
  const bridge = createBridge({
    tokenPath,
    onStdinClose: () => {
      bridge.stop().then(() => process.exit(0));
    },
  });
  try {
    await bridge.start();
  } catch (err) {
    process.stderr.write(`[mysnowbuddy-mcp] could not start HTTP server: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `[mysnowbuddy-mcp] pairing token file: ${tokenPath}\n` +
      '[mysnowbuddy-mcp] paste the token in MySnowBuddy options > Agent > Local MCP bridge\n'
  );
  process.on('SIGINT', () => bridge.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => bridge.stop().then(() => process.exit(0)));
}

module.exports = { createBridge };

if (require.main === module) main();
