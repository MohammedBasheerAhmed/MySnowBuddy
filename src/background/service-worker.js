// Background service worker. Owns all outbound calls to the AI provider and
// all cross-instance Table API calls — content scripts relay requests here
// rather than calling external origins directly. Also handles the toolbar
// icon click, toggling the sidebar in the active tab's content script.
import { sendChatCompletion, validateApiKey } from '../providers/openai.js';
import { compareInstances, buildDiffSummaryPrompt } from './compare.js';
import { fetchRecords, normalizeInstanceUrl } from './instanceClient.js';
import { normalizeRun } from '../lib/automation.js';

const KEY_STORAGE = 'mysnowbuddy_openai_key';

const SERVICE_NOW_RE = /^https:\/\/[^/]+\.service-now\.com\//i;

// Tabs opened before the extension was installed or reloaded have no content script yet.
async function sendToTab(tab, type) {
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
    return;
  } catch {
    // No receiver; fall through to injection.
  }

  if (!SERVICE_NOW_RE.test(tab.url || '')) {
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
  VALIDATE_API_KEY: (payload) => validateApiKey(payload?.apiKey),
  COMPARE_INSTANCES: handleCompareInstances,
  SUMMARIZE_DIFF: handleSummarizeDiff,
  FETCH_REMOTE_RECORD: handleFetchRemoteRecord,
  AUTOMATION_SAVE: handleAutomationSave,
  AUTOMATION_LOAD: handleAutomationLoad,
  AUTOMATION_HANDOFF: handleAutomationHandoff,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;

  Promise.resolve(handler(message.payload, sender))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the message channel open for the async response
});

async function getApiKey() {
  const stored = await chrome.storage.local.get(KEY_STORAGE);
  return stored[KEY_STORAGE];
}

async function handleChatCompletion(payload) {
  const { messages } = payload || {};
  const content = await sendChatCompletion(await getApiKey(), messages);
  return { ok: true, content };
}

async function handleCompareInstances(payload) {
  const result = await compareInstances(payload || {});
  return { ok: true, result };
}

async function handleSummarizeDiff(payload) {
  const prompt = buildDiffSummaryPrompt(payload?.result || {});
  const content = await sendChatCompletion(await getApiKey(), [{ role: 'user', content: prompt }]);
  return { ok: true, content };
}

// An in-progress automation run survives page loads. It lives here, per tab,
// so scripts running in the page cannot read or write it.
const automationKey = (tabId) => `msb_automation_${tabId}`;

function automationTabId(sender) {
  if (!sender?.tab?.id || sender.frameId !== 0 || !SERVICE_NOW_RE.test(sender.tab.url || '')) {
    throw new Error('Automation is only available in a ServiceNow tab.');
  }
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
  let senderHost = '';
  try {
    senderHost = new URL(sender?.tab?.url || '').hostname;
  } catch {
    // No tab URL: not a page we serve.
  }
  if (!/\.service-now\.com$/i.test(senderHost)) throw new Error('This request is only allowed from a ServiceNow page.');

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
