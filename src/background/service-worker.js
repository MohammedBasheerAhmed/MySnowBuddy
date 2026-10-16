// Background service worker. Owns all outbound calls to the AI provider and
// all cross-instance Table API calls — content scripts relay requests here
// rather than calling external origins directly. Also handles the toolbar
// icon click, toggling the sidebar in the active tab's content script.
import { loadProviderConfig, sendChat, validateKey } from '../providers/index.js';
import { PROVIDERS } from '../providers/config.js';
import { compareInstances, buildDiffSummaryPrompt } from './compare.js';
import { fetchRecords, normalizeInstanceUrl } from './instanceClient.js';
import { normalizeRun } from '../lib/automation.js';
import { startMcpBridge, getMcpStatus } from './mcpBridge.js';
import { handlePushPreview, handlePushArtifact } from './push.js';
import { checkSender, isServiceNowUrl, senderOrigin } from '../lib/senderCheck.js';
import { sanitizeFrameHotkey } from '../lib/hotkeyRelay.js';

// Tabs opened before the extension was installed or reloaded have no content script yet.
async function sendToTab(tab, type) {
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
    return;
  } catch {
    // No receiver; fall through to injection.
  }

  if (!isServiceNowUrl(tab.url)) {
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    chrome.action.setTitle({ tabId: tab.id, title: 'MySnowBuddy only works on *.service-now.com pages' });
    return;
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.bundle.js'] });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch (err) {
    console.warn('[MySnowBuddy] could not reach the page', err);
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  sendToTab(tab, 'TOGGLE_SIDEBAR');
});

// Browser-level shortcuts. These fire even when focus is inside a ServiceNow
// iframe or a field that swallows key events, which the in-page listener
// cannot always reach.
const COMMAND_MESSAGES = {
  'open-palette': 'OPEN_PALETTE',
  'toggle-sidebar': 'TOGGLE_SIDEBAR',
};

chrome.commands?.onCommand.addListener(async (command) => {
  const type = COMMAND_MESSAGES[command];
  if (!type) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  sendToTab(tab, type);
});

const handlers = {
  CHAT_COMPLETION: handleChatCompletion,
  VALIDATE_API_KEY: handleValidateKey,
  AGENT_STEP: handleAgentStep,
  GET_PROVIDER_INFO: handleProviderInfo,
  OPEN_OPTIONS: () => chrome.runtime.openOptionsPage().then(() => ({ ok: true })),
  SANDBOX_RUN: handleSandboxRun,
  COMPARE_INSTANCES: handleCompareInstances,
  SUMMARIZE_DIFF: handleSummarizeDiff,
  FETCH_REMOTE_RECORD: handleFetchRemoteRecord,
  AUTOMATION_SAVE: handleAutomationSave,
  AUTOMATION_LOAD: handleAutomationLoad,
  AUTOMATION_HANDOFF: handleAutomationHandoff,
  MCP_BRIDGE_STATUS: () => getMcpStatus(),
  // Push one configuration record to another instance (src/background/push.js).
  PUSH_PREVIEW: handlePushPreview,
  PUSH_ARTIFACT: handlePushArtifact,
  // Hotkeys pressed in a sub-frame, relayed to the top frame (src/lib/hotkeyRelay.js).
  FRAME_HOTKEY: handleFrameHotkey,
  PALETTE_STATE: handlePaletteState,
};

// Who may send each message (src/lib/senderCheck.js), checked against the frame that sent it.
// 'page' = the top frame of a *.service-now.com page, 'frame' = any *.service-now.com frame,
// 'extension' = the extension's own pages (options), 'any' = page or extension.
// A type missing here is treated as 'page'.
const SENDER_POLICY = {
  CHAT_COMPLETION: 'page',
  VALIDATE_API_KEY: 'extension',
  AGENT_STEP: 'page',
  GET_PROVIDER_INFO: 'any',
  OPEN_OPTIONS: 'any',
  SANDBOX_RUN: 'page',
  COMPARE_INSTANCES: 'page',
  SUMMARIZE_DIFF: 'page',
  FETCH_REMOTE_RECORD: 'page',
  AUTOMATION_SAVE: 'page',
  AUTOMATION_LOAD: 'page',
  AUTOMATION_HANDOFF: 'page',
  MCP_BRIDGE_STATUS: 'extension',
  PUSH_PREVIEW: 'page',
  PUSH_ARTIFACT: 'page',
  FRAME_HOTKEY: 'frame',
  PALETTE_STATE: 'page',
};

/** Throws unless the sender may send this message type. */
function requireSender(sender, type) {
  return checkSender(sender, chrome.runtime.id, SENDER_POLICY[type] || 'page');
}

startMcpBridge();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;

  Promise.resolve()
    .then(() => {
      requireSender(sender, message.type);
      return handler(message.payload, sender);
    })
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the message channel open for the async response
});

// A sub-frame's trusted hotkey goes to the top frame of the same tab, and only between frames of
// one origin (as the old same-origin postMessage relay did). Rebuilt from known fields only.
async function handleFrameHotkey(payload, sender) {
  const message = sanitizeFrameHotkey(payload);
  if (!message) throw new Error('Unknown hotkey.');
  let topOrigin = '';
  try {
    topOrigin = new URL(sender.tab.url || '').origin;
  } catch {
    // No tab URL.
  }
  if (!topOrigin || senderOrigin(sender) !== topOrigin) throw new Error('This request is only allowed from a ServiceNow page.');
  await chrome.tabs.sendMessage(sender.tab.id, message, { frameId: 0 });
  return { ok: true };
}

// The top frame says the palette opened or closed; sub-frames then relay (or stop relaying) navigation keys.
async function handlePaletteState(payload, sender) {
  await chrome.tabs.sendMessage(sender.tab.id, { type: 'PALETTE_STATE', open: payload?.open === true }).catch(() => {});
  return { ok: true };
}

async function handleChatCompletion(payload, sender) {
  requireServiceNowSender(sender);
  const { messages } = payload || {};
  const config = await loadProviderConfig();
  const reply = await sendChat(config, { messages });
  return { ok: true, content: reply.content };
}

// One model turn of the agent loop. The loop itself runs in the page's content
// script (it needs the page and the approval UI); the API key never leaves here.
async function handleAgentStep(payload, sender) {
  requireServiceNowSender(sender);
  const { messages, tools, effort } = payload || {};
  if (!Array.isArray(messages) || !messages.length) throw new Error('No messages.');
  const config = await loadProviderConfig();
  const reply = await sendChat(config, { messages, tools: Array.isArray(tools) ? tools : [], effort });
  return { ok: true, reply, provider: config.provider, model: config.model };
}

// What the sidebar shows next to the host name: which model is answering, and whether a key exists.
async function handleProviderInfo() {
  const config = await loadProviderConfig();
  const provider = PROVIDERS[config.provider];
  const model = provider.models.find((m) => m.id === config.model);
  return {
    ok: true,
    provider: config.provider,
    label: provider.label,
    model: config.model,
    modelLabel: (model?.label || config.model).split(' - ')[0],
    hasKey: Boolean(config.apiKey),
  };
}

async function handleValidateKey(payload) {
  const config = await loadProviderConfig();
  return validateKey({ provider: payload?.provider || config.provider, model: payload?.model || config.model, apiKey: payload?.apiKey });
}

// The dispatcher already checked the sender; handlers that reach the model or another
// instance check again so a refactor of the dispatcher cannot open them up.
function requireServiceNowSender(sender) {
  checkSender(sender, chrome.runtime.id, 'page');
}

// --- Sandbox (script simulation) ---------------------------------------------------------
// MV3 extension pages cannot eval. Simulations run in a sandboxed page hosted by an
// offscreen document; a runaway script is stopped by closing that document.
const SANDBOX_TIMEOUT_MS = 6000;
let offscreenReady = null;

async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('This browser does not support offscreen documents (needs Chrome or Edge 109+).');
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing?.length) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['IFRAME_SCRIPTING'],
      justification: 'Simulate client scripts in an isolated sandbox without touching the real form.',
    });
  })().catch((err) => {
    offscreenReady = null;
    throw err;
  });
  return offscreenReady;
}

async function handleSandboxRun(payload, sender) {
  requireServiceNowSender(sender);
  await ensureOffscreen();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), SANDBOX_TIMEOUT_MS);
  });
  try {
    const reply = await Promise.race([chrome.runtime.sendMessage({ target: 'offscreen', payload }), timeout]);
    if (!reply) throw new Error('The sandbox did not answer.');
    return reply;
  } catch (err) {
    if (err.message === 'timeout') {
      // A script that never returns (infinite loop): throw the whole sandbox away.
      offscreenReady = null;
      await chrome.offscreen.closeDocument().catch(() => {});
      throw new Error('The script took longer than 6 seconds and was stopped. Check for an infinite loop.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function handleCompareInstances(payload, sender) {
  requireServiceNowSender(sender);
  const result = await compareInstances(payload || {});
  return { ok: true, result };
}

async function handleSummarizeDiff(payload, sender) {
  requireServiceNowSender(sender);
  const prompt = buildDiffSummaryPrompt(payload?.result || {});
  const reply = await sendChat(await loadProviderConfig(), { messages: [{ role: 'user', content: prompt }] });
  return { ok: true, content: reply.content };
}

// An in-progress automation run survives page loads. It lives here, per tab,
// so scripts running in the page cannot read or write it.
const automationKey = (tabId) => `msb_automation_${tabId}`;

function automationTabId(sender) {
  try {
    requireServiceNowSender(sender);
  } catch {
    throw new Error('Automation is only available in a ServiceNow tab.');
  }
  if (!isServiceNowUrl(sender.tab.url)) throw new Error('Automation is only available in a ServiceNow tab.');
  return sender.tab.id;
}

async function handleAutomationSave(run, sender) {
  const key = automationKey(automationTabId(sender));
  const clean = run ? normalizeRun(run) : null;
  if (clean) await chrome.storage.session.set({ [key]: clean });
  else await chrome.storage.session.remove(key);
  return { ok: true };
}

async function handleAutomationLoad(_payload, sender) {
  const key = automationKey(automationTabId(sender));
  const stored = await chrome.storage.session.get(key);
  return { ok: true, run: stored[key] || null };
}

// Moves a run into another tab of the same instance (new or existing) and resumes it there.
async function handleAutomationHandoff(payload, sender) {
  const tabId = automationTabId(sender);
  const run = normalizeRun(payload?.run);
  if (!run) throw new Error('Invalid run.');
  const origin = new URL(sender.tab.url).origin;

  let target;
  if (payload.mode === 'newtab') {
    const path = String(payload.path || '');
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw new Error('Invalid path.');
    target = await chrome.tabs.create({ url: origin + path, active: true, windowId: sender.tab.windowId });
    await chrome.storage.session.set({ [automationKey(target.id)]: run });
    await chrome.storage.session.remove(automationKey(tabId));
  } else if (payload.mode === 'switchtab') {
    const tabs = (await chrome.tabs.query({ url: `${origin}/*`, windowId: sender.tab.windowId })).sort((a, b) => a.index - b.index);
    const n = Number(payload.tab);
    target = tabs[n - 1];
    if (!target?.id) throw new Error(`There is no tab ${n} on this instance (found ${tabs.length}).`);
    if (target.id === tabId) throw new Error(`Tab ${n} is the current tab.`);
    await chrome.storage.session.set({ [automationKey(target.id)]: run });
    await chrome.storage.session.remove(automationKey(tabId));
    try {
      await chrome.tabs.sendMessage(target.id, { type: 'AUTOMATION_RESUME' }, { frameId: 0 });
    } catch {
      await chrome.storage.session.remove(automationKey(target.id));
      throw new Error(`Tab ${n} is not ready. Reload it and try again.`);
    }
    await chrome.tabs.update(target.id, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
  } else {
    throw new Error('Unknown tab action.');
  }

  return { ok: true };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(automationKey(tabId));
});

const SYS_ID_RE = /^[0-9a-f]{32}$/i;

// Fetch one record from another instance. Only callable from a ServiceNow page,
// and the target is limited to *.service-now.com by normalizeInstanceUrl.
async function handleFetchRemoteRecord(payload, sender) {
  requireServiceNowSender(sender);

  const { instanceUrl, table, sysId, name } = payload || {};
  if (!/^[a-z0-9_]+$/i.test(table || '') || !SYS_ID_RE.test(sysId || '')) throw new Error('Invalid record.');
  const base = normalizeInstanceUrl(instanceUrl);

  let rows = await fetchRecords(base, table, [], { query: `sys_id=${sysId}`, limit: 1 });
  let matchedBy = 'sys_id';
  if (!rows.length && name && !String(name).includes('^')) {
    rows = await fetchRecords(base, table, [], { query: `name=${name}`, limit: 2 });
    matchedBy = 'name';
    if (rows.length > 1) throw new Error(`More than one "${name}" exists on ${new URL(base).hostname}; cannot pick one.`);
  }
  return { ok: true, record: rows[0] || null, matchedBy, host: new URL(base).hostname };
}
