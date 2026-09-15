// Background service worker. Owns all outbound calls to the AI provider and
// all cross-instance Table API calls — content scripts relay requests here
// rather than calling external origins directly. Also handles the toolbar
// icon click, toggling the sidebar in the active tab's content script.
import { sendChatCompletion, validateApiKey } from '../providers/openai.js';
import { compareInstances, buildDiffSummaryPrompt } from './compare.js';

const KEY_STORAGE = 'mysnowbuddy_openai_key';

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' });
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
  chrome.tabs.sendMessage(tab.id, { type }).catch(() => {
    // No content script on this tab (not a ServiceNow page); nothing to do.
  });
});

const handlers = {
  CHAT_COMPLETION: handleChatCompletion,
  VALIDATE_API_KEY: (payload) => validateApiKey(payload?.apiKey),
  COMPARE_INSTANCES: handleCompareInstances,
  SUMMARIZE_DIFF: handleSummarizeDiff,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;

  Promise.resolve(handler(message.payload))
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
