// OpenAI provider adapter. Keep this module the only place that knows about
// OpenAI's specific request/response shape; anthropic.js is its sibling.
import { OPENAI_MODEL, OPENAI_API_URL } from './config.js';
import { toOpenAIMessages, toOpenAITools, fromOpenAIResponse } from './messages.js';

// Reasoning models reject a non-default temperature.
const FIXED_TEMPERATURE = /^(gpt-5|o\d)/i;

/** Neutral messages in, neutral { content, toolCalls, ... } out. */
export async function sendOpenAI({ apiKey, model = OPENAI_MODEL, messages, tools = [] }) {
  if (!apiKey) {
    throw new Error('Missing OpenAI API key. Configure it in the MySnowBuddy options page.');
  }

  const body = { model, messages: toOpenAIMessages(messages) };
  if (!FIXED_TEMPERATURE.test(model)) body.temperature = 0.2;
  if (tools.length) body.tools = toOpenAITools(tools);

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    if (response.status === 401) throw new Error('OpenAI rejected the API key. Check it in the options page.');
    throw new Error(`OpenAI request failed (${response.status}): ${errorBody.slice(0, 300)}`);
  }

  return fromOpenAIResponse(await response.json());
}
