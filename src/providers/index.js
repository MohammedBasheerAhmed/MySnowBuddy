// Provider dispatch. Calling code passes neutral messages and tool definitions
// and gets a neutral response, whichever vendor is configured.
import { resolveProviderConfig, PROVIDERS } from './config.js';
import { sendOpenAI } from './openai.js';
import { sendAnthropic } from './anthropic.js';
import { redactMessages } from './redact.js';
import { assertWithinCaps, recordCall } from './budget.js';

export async function loadProviderConfig() {
  const stored = await chrome.storage.local.get(null);
  return resolveProviderConfig(stored);
}

/**
 * @param {object} config { provider, model, apiKey }
 * @param {object} request { messages, tools?, effort?, kind?: 'chat' | 'agent' | 'validate', host?, skipBudget? }
 * @returns {Promise<{content: string, toolCalls: Array, raw?: object, stopReason: string, usage: object}>}
 */
export async function sendChat(config, { messages: input, tools = [], effort, kind = 'chat', host = '', skipBudget = false }) {
  // Last line of defence: every request (chat, agent steps, tool results, diff summaries)
  // passes through here, so secrets are redacted even when a caller forgot to.
  const messages = redactMessages(input);
  // A spend cap that is reached refuses the call here, before anything leaves the browser.
  if (!skipBudget) await assertWithinCaps(config.provider);
  const started = Date.now();
  const reply =
    config.provider === 'openai'
      ? await sendOpenAI({ apiKey: config.apiKey, model: config.model, messages, tools, baseUrl: config.baseUrl || '', keyOptional: Boolean(config.keyOptional) })
      : await sendAnthropic({ apiKey: config.apiKey, model: config.model, messages, tools, effort, baseUrl: config.baseUrl || '', promptCache: config.promptCache !== false });
  await recordCall({ provider: config.provider, model: config.model, ms: Date.now() - started, usage: reply.usage, host, kind });
  return reply;
}

export async function validateKey(config) {
  try {
    const cheapest = PROVIDERS[config.provider].models.at(-1).id;
    // A custom endpoint's model is whatever the user typed; only the real Anthropic API gets the cheapest listed model.
    const model = config.provider === 'anthropic' && !config.baseUrl ? cheapest : config.model;
    await sendChat({ ...config, model }, { messages: [{ role: 'user', content: 'ping' }], effort: 'low', kind: 'validate', skipBudget: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
