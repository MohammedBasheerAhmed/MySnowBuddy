// Local MCP bridge client. Connects this extension to the loopback bridge
// (mcp/snowbuddy-mcp.js) so an external MCP client can call the extension's
// ServiceNow tools through the user's own logged-in tab.
//
// Flow: register the tool list, then long-poll for calls. Each call is relayed
// to a ServiceNow tab's content script (AGENT_TOOL_CALL) and the reply is posted
// back. The host is hardcoded to 127.0.0.1; only the port and token come from
// settings.
//
// The permission ceiling (Options > Agent > External agents) is enforced here
// (only allowed tools are registered, and every call is checked again) and in
// the page (agentBridge.js). `screenshot` and `list_tabs` run here: they need
// tab APIs a content script does not have.
import { mcpToolList, isMcpOnlyTool, getToolSchema } from '../lib/agent/toolSchemas.js';
import { effectiveTier, resolveMcpCeiling, ceilingAllows, ceilingLabel } from '../lib/agent/policy.js';
import { summarizePage } from '../lib/agent/control.js';
import { redactSecrets } from '../providers/redact.js';

// After the screenshot consent card closes, before the capture (so the card is not in the image).
const SCREENSHOT_SETTLE_MS = 250;

const SETTINGS_KEY = 'mysnowbuddy_settings';
const ALARM_NAME = 'msb-mcp-keepalive';
const DEFAULT_PORT = 17345;
const POLL_WAIT_MS = 20000;
const POLL_TIMEOUT_MS = 35000;
const REQUEST_TIMEOUT_MS = 10000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const SERVICE_NOW_URL = 'https://*.service-now.com/*';
const SERVICE_NOW_RE = /^https:\/\/[^/]+\.service-now\.com\//i;
const HOST_RE = /^[a-z0-9][a-z0-9.-]*$/i;
// Screenshots: PNG up to this many base64 characters, else a JPEG; the bridge accepts results up to 8 MB.
const MAX_PNG_B64 = 2500000;
const MAX_IMAGE_B64 = 6000000;
// A page that reloads during a call (submit, navigation, impersonation) is read again once it has loaded.
const RELOAD_WAIT_MS = 20000;
const PORT_CLOSED_RE = /message port closed|back\/forward cache|frame (was )?removed|page.*unload/i;

let settings = { enabled: false, token: '', port: DEFAULT_PORT, ceiling: 'write' };
let status = { state: 'off', detail: 'Local MCP bridge is disabled.', lastCall: null };
let running = false;
let runId = 0;
let activeController = null;
let wakeSleep = null;
let started = false;
let registerNeeded = false;

function setStatus(state, detail) {
  status = { ...status, state, detail };
}

function readSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const port = Number(s.mcpPort);
  return {
    enabled: s.mcpBridgeEnabled === true,
    token: typeof s.mcpToken === 'string' ? s.mcpToken.trim() : '',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    ceiling: resolveMcpCeiling(s),
  };
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return readSettings(stored[SETTINGS_KEY]);
}

function baseUrl() {
  return `http://127.0.0.1:${settings.port}`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      wakeSleep = null;
      resolve();
    }
    wakeSleep = done;
  });
}

async function bridgeFetch(path, init = {}, timeoutMs = REQUEST_TIMEOUT_MS, { track = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Only the poll loop's own requests are what stopLoop aborts; side requests (started notices) are not tracked.
  if (track) activeController = controller;
  try {
    const res = await fetch(baseUrl() + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${settings.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: controller.signal,
    });
    if (res.status === 401) throw new Error('The bridge rejected the pairing token. Re-paste it in options.');
    if (!res.ok && res.status !== 404) throw new Error(`Bridge returned HTTP ${res.status}.`);
    return res;
  } finally {
    clearTimeout(timer);
    if (activeController === controller) activeController = null;
  }
}

// ---- tab selection ----------------------------------------------------------

function hostOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const byRecency = (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0);

async function pickTab(args) {
  const wanted = hostOf(args && args.instance);
  if (wanted && (!HOST_RE.test(wanted) || !wanted.endsWith('.service-now.com'))) {
    throw new Error(`"${args.instance}" is not a *.service-now.com instance.`);
  }
  const rawTab = args && args.tab_id;
  if (rawTab !== undefined && rawTab !== null && rawTab !== '') {
    const id = Number(rawTab);
    if (!Number.isInteger(id) || id < 0) throw new Error('tab_id must be a tab id from list_tabs.');
    let tab;
    try {
      tab = await chrome.tabs.get(id);
    } catch {
      throw new Error(`There is no tab ${id}. Call list_tabs.`);
    }
    if (!tab || !SERVICE_NOW_RE.test(tab.url || '')) throw new Error(`Tab ${id} is not a ServiceNow tab. Call list_tabs.`);
    if (wanted && hostOf(tab.url) !== wanted) throw new Error(`Tab ${id} shows ${hostOf(tab.url)}, not ${wanted}.`);
    return tab;
  }
  if (wanted) {
    const tabs = (await chrome.tabs.query({ url: `https://${wanted}/*` })).sort(byRecency);
    const tab = tabs.find((t) => t.active) || tabs[0];
    if (!tab) throw new Error(`No open tab for ${wanted}. Open that instance in the browser first.`);
    return tab;
  }

  try {
    const win = await chrome.windows.getLastFocused();
    if (win && win.id !== undefined) {
      const [active] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (active && SERVICE_NOW_RE.test(active.url || '')) return active;
    }
  } catch {
    // No focused window; fall back to the most recent tab.
  }
  const tabs = (await chrome.tabs.query({ url: SERVICE_NOW_URL })).sort(byRecency);
  if (!tabs.length) throw new Error('No ServiceNow tab is open. Open a *.service-now.com tab in the browser and try again.');
  return tabs[0];
}

// Calls the page is working on (id -> tab id), calls the bridge has since cancelled, and calls the page reported as
// approved and executing (AGENT_TOOL_STARTED).
const activeCalls = new Map();
const cancelledCalls = new Set();
const startedCalls = new Set();

/** The bridge gave up on this call (timeout or client cancel): stop it in the page so it cannot run later. */
async function cancelCall(id) {
  cancelledCalls.add(id);
  setTimeout(() => cancelledCalls.delete(id), 10 * 60 * 1000)?.unref?.(); // housekeeping only; must not keep a process alive
  const tabId = activeCalls.get(id);
  // activeCalls lives in worker memory. After a worker restart it is empty, so the cancel goes to every ServiceNow tab:
  // a tab that never had the call ignores it, and the one that has its approval card open withdraws it.
  let tabIds = tabId !== undefined ? [tabId] : [];
  if (!tabIds.length) {
    try {
      tabIds = (await chrome.tabs.query({ url: SERVICE_NOW_URL })).map((t) => t.id);
    } catch {
      tabIds = [];
    }
  }
  await Promise.all(
    tabIds.map((t) =>
      chrome.tabs.sendMessage(t, { type: 'AGENT_TOOL_CANCEL', callId: id }, { frameId: 0 }).catch(() => {
        // The tab is gone or reloaded: nothing left to cancel.
      })
    )
  );
}

async function relayToTab(tab, call) {
  const message = { type: 'AGENT_TOOL_CALL', callId: call.id, tool: call.tool, args: call.args || {}, source: 'mcp' };
  activeCalls.set(call.id, tab.id);
  try {
    return await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
  } catch (err) {
    // Tabs opened before install/reload have no content script yet; inject once and retry.
    if (!/receiving end|establish connection/i.test(String(err && err.message))) throw err;
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.bundle.js'] });
    await new Promise((resolve) => setTimeout(resolve, 600));
    return chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
  }
}

// ---- tools that run here -------------------------------------------------------------

async function listTabs() {
  const tabs = (await chrome.tabs.query({ url: SERVICE_NOW_URL })).sort(byRecency);
  let focused;
  try {
    focused = (await chrome.windows.getLastFocused())?.id;
  } catch {
    focused = undefined;
  }
  // Only what is needed to pick a tab: host and a redacted title. Paths (record ids, queries) are not listed.
  return {
    tabs: tabs.slice(0, 50).map((t) => ({
      tab_id: t.id,
      instance: hostOf(t.url),
      title: safeTitle(t.title),
      active: Boolean(t.active),
      inFocusedWindow: focused !== undefined && t.windowId === focused,
    })),
    note: 'Pass tab_id to any tool to run it in that tab. Without it, tools use the active ServiceNow tab of the focused window.',
  };
}

const base64Of = (dataUrl) => String(dataUrl || '').slice(String(dataUrl || '').indexOf(',') + 1);

/**
 * The visible area of a ServiceNow tab. Chrome requires activeTab (granted when the user clicks the toolbar icon or
 * presses the extension's shortcut on that tab) or <all_urls>; MySnowBuddy deliberately does not ask for <all_urls>.
 */
async function captureTab(tab, callId) {
  if (!tab.active) {
    throw new Error(`Tab ${tab.id} is not the visible tab of its window, and Chrome can only capture the visible tab. Ask the user to bring it to the front.`);
  }
  // A screenshot cannot be redacted, so the person allows each one in the tab (whatever the permission ceiling).
  let consent;
  try {
    consent = await chrome.tabs.sendMessage(tab.id, { type: 'MCP_SCREENSHOT_CONSENT', callId }, { frameId: 0 });
  } catch {
    consent = null;
  }
  if (!consent || !consent.ok) throw new Error('The screenshot could not be confirmed in the browser (MySnowBuddy is not running in that tab). Nothing was captured.');
  if (!consent.approved) throw new Error('The user did not allow this screenshot. Do not retry it; use read_page instead.');
  if (cancelledCalls.has(callId)) throw new Error('This call was cancelled; nothing was captured.');
  // Let the closed approval card leave the screen before the capture.
  await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_SETTLE_MS));
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/activeTab|all_urls|permission/i.test(msg)) {
      throw new Error('Chrome lets MySnowBuddy capture a tab only after the user clicks the MySnowBuddy toolbar icon (or presses Alt+Shift+C) on that tab. Ask them to do that once, then try again. read_page works without it.');
    }
    throw new Error(`Screenshot failed: ${msg}`);
  }
  let data = base64Of(dataUrl);
  let mimeType = 'image/png';
  if (data.length > MAX_PNG_B64) {
    data = base64Of(await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 }));
    mimeType = 'image/jpeg';
    if (data.length > MAX_IMAGE_B64) throw new Error('The screenshot is too large to send. Make the browser window smaller and try again.');
  }
  return {
    image: { data, mimeType },
    result: { tab_id: tab.id, instance: hostOf(tab.url), title: safeTitle(tab.title), format: mimeType, note: 'The image is not redacted.' },
  };
}

/** A tab title for an external agent: clipped and passed through the same secret redaction as tool results. */
function safeTitle(title) {
  return redactSecrets(String(title || '').slice(0, 120));
}

// ---- page reloads -----------------------------------------------------------------------

async function waitForTabComplete(tabId, timeoutMs = RELOAD_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  await new Promise((resolve) => setTimeout(resolve, 400));
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return null; // closed
    }
    if (tab && tab.status === 'complete') return tab;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/** A short read_page of a tab that has just reloaded, or a note saying why not. */
async function readPageAfterReload(tab) {
  const ready = await waitForTabComplete(tab.id);
  if (!ready) return { note: 'The page did not finish loading in time; call read_page.' };
  // The fresh content script needs a moment before it listens (document_idle, then its own start-up).
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'AGENT_TOOL_CALL', tool: 'read_page', args: { maxFields: 30, maxRows: 5 }, source: 'mcp' }, { frameId: 0 });
      if (reply && reply.ok) return summarizePage(reply.result);
      return { note: `read_page failed after the reload: ${String((reply && reply.error) || 'no answer')}` };
    } catch {
      // Not listening yet; try again.
    }
  }
  return { note: 'The page loaded but MySnowBuddy is not answering yet; call read_page.' };
}

const stripRouting = (args) => {
  const { tab_id: _tab, instance: _instance, ...rest } = args || {};
  return rest;
};

function ceilingError(tool) {
  return `Blocked by the external-agent permission ceiling ("${ceilingLabel(settings.ceiling)}", Options > Agent). ${tool} is not allowed; ask the user to raise it if they want this.`;
}

async function runCall(call) {
  let outcome;
  const tool = String(call.tool || '');
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  let tab = null;
  try {
    // Checked here as well as in the page: a call above the ceiling never reaches a tab.
    if (!getToolSchema(tool)) throw new Error(`Unknown tool "${tool}".`);
    if (!ceilingAllows(settings.ceiling, effectiveTier(tool, args))) throw new Error(ceilingError(tool));
    if (tool === 'list_tabs') {
      outcome = { id: call.id, ok: true, result: await listTabs() };
    } else {
      tab = await pickTab(args);
      if (cancelledCalls.has(call.id)) return; // cancelled while we were choosing a tab
      if (tool === 'screenshot') {
        activeCalls.set(call.id, tab.id); // so a cancel withdraws the consent card in that tab
        const shot = await captureTab(tab, call.id);
        outcome = { id: call.id, ok: true, result: shot.result, image: shot.image };
      } else if (isMcpOnlyTool(tool)) {
        throw new Error(`Unknown tool "${tool}".`);
      } else {
        const reply = await relayToTab(tab, { ...call, args: stripRouting(args) });
        if (reply && reply.ok) {
          let result = reply.result;
          // The tool answered first and the page is now reloading (top-level navigation, impersonation): show the new page.
          if (result && typeof result === 'object' && result.pageReload === 'expected') result = { ...result, page: await readPageAfterReload(tab) };
          outcome = { id: call.id, ok: true, result };
        } else {
          outcome = { id: call.id, ok: false, error: String((reply && reply.error) || 'The page did not return a result.') };
        }
      }
    }
  } catch (err) {
    const message = String((err && err.message) || err);
    if (tab && PORT_CLOSED_RE.test(message) && startedCalls.has(call.id)) {
      // Approved and executing when the page went away: a submit or a navigation reloaded it. Say so, show the page now.
      outcome = {
        id: call.id,
        ok: true,
        result: {
          pageReloaded: true,
          note: 'The page reloaded while this action ran (normal after a submit or a navigation). Here is the page now; check it before assuming the outcome.',
          page: await readPageAfterReload(tab),
        },
      };
    } else if (tab && PORT_CLOSED_RE.test(message)) {
      outcome = { id: call.id, ok: false, error: 'The page reloaded before this call was approved or started, so nothing was run. Ask again if you still want it.' };
    } else {
      outcome = { id: call.id, ok: false, error: message };
    }
  } finally {
    activeCalls.delete(call.id);
    startedCalls.delete(call.id);
  }
  if (cancelledCalls.has(call.id)) return; // the bridge already answered the client; nothing to deliver
  status = { ...status, lastCall: { tool: call.tool, ok: outcome.ok, at: Date.now() } };
  try {
    await bridgeFetch('/v1/result', { method: 'POST', body: JSON.stringify(outcome) });
  } catch (err) {
    console.warn('[MySnowBuddy] could not deliver MCP result', err);
  }
}

// ---- main loop -----------------------------------------------------------------

async function register() {
  let host = '';
  try {
    host = hostOf((await pickTab({})).url);
  } catch {
    // No tab yet; the instance is reported once one exists on a later register.
  }
  const body = {
    // Only what the ceiling allows is advertised, so the MCP client never plans with a tool it cannot use.
    tools: mcpToolList().filter((t) => ceilingAllows(settings.ceiling, t.tier)),
    instance: { host },
    version: chrome.runtime.getManifest().version,
  };
  registerNeeded = false;
  await bridgeFetch('/v1/register', { method: 'POST', body: JSON.stringify(body) });
}

async function loop(myRun) {
  const alive = () => myRun === runId && settings.enabled && settings.token;
  let registered = false;
  let backoff = BACKOFF_MIN_MS;
  running = true;
  try {
    while (alive()) {
      try {
        if (!registered || registerNeeded) {
          if (!registered) setStatus('connecting', `Connecting to the bridge on 127.0.0.1:${settings.port}...`);
          await register();
          registered = true;
        }
        const res = await bridgeFetch(`/v1/poll?wait=${POLL_WAIT_MS}`, {}, POLL_TIMEOUT_MS);
        if (!alive()) break;
        const data = await res.json();
        setStatus('connected', `Connected to the bridge on 127.0.0.1:${settings.port}.`);
        backoff = BACKOFF_MIN_MS;
        for (const id of Array.isArray(data.cancel) ? data.cancel : []) cancelCall(String(id));
        for (const call of Array.isArray(data.calls) ? data.calls : []) {
          // Calls may wait on a human approval, so never block polling on one.
          runCall(call);
        }
      } catch (err) {
        if (!alive()) break;
        registered = false;
        const aborted = err && err.name === 'AbortError';
        setStatus('error', aborted ? 'The bridge did not respond.' : String((err && err.message) || err));
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  } finally {
    if (myRun === runId) running = false;
  }
}

function stopLoop() {
  runId += 1;
  running = false;
  if (activeController) activeController.abort();
  if (wakeSleep) wakeSleep();
}

function startLoop() {
  stopLoop();
  if (!settings.enabled) {
    setStatus('off', 'Local MCP bridge is disabled.');
    return;
  }
  if (!settings.token) {
    setStatus('off', 'Paste the pairing token in options to enable the bridge.');
    return;
  }
  setStatus('connecting', 'Connecting...');
  loop(runId);
}

async function applySettings() {
  const next = await loadSettings();
  const changed = next.enabled !== settings.enabled || next.token !== settings.token || next.port !== settings.port;
  // A new ceiling applies to calls at once; the advertised tool list follows on the next poll (within ~20 s).
  if (next.ceiling !== settings.ceiling) registerNeeded = true;
  settings = next;
  if (changed || (settings.enabled && settings.token && !running)) startLoop();
}

/** Withdraw a call in the browser (the same path the bridge's cancel list takes). Exported for tests. */
export const withdrawCall = (id) => cancelCall(String(id));

export function getMcpStatus() {
  return { ok: true, ...status, enabled: settings.enabled, hasToken: Boolean(settings.token), port: settings.port, running };
}

export function startMcpBridge() {
  if (started) return;
  started = true;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) applySettings();
  });

  // The page says a relayed call has been approved and is executing (see agentBridge.js announceStart).
  // It is forwarded to the bridge as well, so a call that times out after it started is reported as "may have run",
  // never "nothing was changed". Forwarded even when this worker restarted and no longer knows the call: the bridge
  // only accepts ids it is still waiting for.
  chrome.runtime.onMessage?.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'AGENT_TOOL_STARTED') return false;
    const callId = String(message.callId || '');
    const fromPage = sender?.id === chrome.runtime.id && sender.tab && sender.frameId === 0 && SERVICE_NOW_RE.test(sender.tab.url || '');
    if (fromPage && callId) {
      if (activeCalls.get(callId) === sender.tab.id) startedCalls.add(callId);
      if (settings.enabled && settings.token) {
        bridgeFetch('/v1/started', { method: 'POST', body: JSON.stringify({ id: callId }) }, REQUEST_TIMEOUT_MS, { track: false }).catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return false;
  });

  if (chrome.alarms) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM_NAME && !running) applySettings();
    });
  }

  applySettings();
}
