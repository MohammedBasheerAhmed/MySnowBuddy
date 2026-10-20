// OpenAI provider adapter. Keep this module the only place that knows about
// OpenAI's specific request/response shape; anthropic.js is its sibling.
import { OPENAI_MODEL, OPENAI_API_URL } from './config.js';
import { toOpenAIMessages, toOpenAITools, fromOpenAIResponse } from './messages.js';
import { chatCompletionsUrl } from '../lib/aiUsage.js';

// Reasoning models reject a non-default temperature.
const FIXED_TEMPERATURE = /^(gpt-5|o\d)/i;

/** Neutral messages in, neutral { content, toolCalls, ... } out. */
// `baseUrl` (already validated by validateBaseUrl) points at any OpenAI-compatible server: <base>/chat/completions.
// `keyOptional` is for a server on this machine that needs no key.
export async function sendOpenAI({ apiKey, model = OPENAI_MODEL, messages, tools = [], baseUrl = '', keyOptional = false }) {
  if (!apiKey && !keyOptional) {
    throw new Error(baseUrl ? 'Missing API key for the custom endpoint. Configure it in the NowBuddy options page.' : 'Missing OpenAI API key. Configure it in the NowBuddy options page.');
  }

  const body = { model, messages: toOpenAIMessages(messages) };
  if (!FIXED_TEMPERATURE.test(model)) body.temperature = 0.2;
  if (tools.length) body.tools = toOpenAITools(tools);

  const label = baseUrl ? `The endpoint ${new URL(baseUrl).host}` : 'OpenAI';
  const response = await fetch(baseUrl ? chatCompletionsUrl(baseUrl) : OPENAI_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    if (response.status === 401) throw new Error(`${label} rejected the API key. Check it in the options page.`);
    throw new Error(`${label} request failed (${response.status}): ${errorBody.slice(0, 300)}`);
  }

  return fromOpenAIResponse(await response.json());
}
