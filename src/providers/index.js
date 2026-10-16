// Provider dispatch. Calling code passes neutral messages and tool definitions
// and gets a neutral response, whichever vendor is configured.
import { resolveProviderConfig, PROVIDERS } from './config.js';
import { sendOpenAI } from './openai.js';
import { sendAnthropic } from './anthropic.js';
import { redactMessages } from './redact.js';

export async function loadProviderConfig() {
  const stored = await chrome.storage.local.get(null);
  return resolveProviderConfig(stored);
}

/**
 * @param {object} config { provider, model, apiKey }
 * @param {object} request { messages, tools?, effort? }
 * @returns {Promise<{content: string, toolCalls: Array, raw?: object, stopReason: string, usage: object}>}
 */
export function sendChat(config, { messages: input, tools = [], effort }) {
  // Last line of defence: every request (chat, agent steps, tool results, diff summaries)
  // passes through here, so secrets are redacted even when a caller forgot to.
  const messages = redactMessages(input);
  if (config.provider === 'openai') {
    return sendOpenAI({ apiKey: config.apiKey, model: config.model, messages, tools });
  }
  return sendAnthropic({ apiKey: config.apiKey, model: config.model, messages, tools, effort });
}

export async function validateKey(config) {
  try {
    const cheapest = PROVIDERS[config.provider].models.at(-1).id;
    await sendChat({ ...config, model: config.provider === 'anthropic' ? cheapest : config.model }, {
      messages: [{ role: 'user', content: 'ping' }],
      effort: 'low',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
