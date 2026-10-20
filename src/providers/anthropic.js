// Anthropic (Claude) provider adapter, the sibling of openai.js. This is the
// only module that knows the Messages API wire format.
//
// Notes that matter on current Claude models:
//  - sampling parameters (temperature, top_p) are rejected, so none are sent;
//  - thinking is adaptive by default, and the thinking blocks of an assistant
//    turn must be echoed back unchanged inside a tool loop (messages.js keeps
//    them in `raw`);
//  - forced tool_choice is rejected, so tool use is always "auto";
//  - calls from a browser context need the direct-browser-access header.
import { ANTHROPIC_API_URL, ANTHROPIC_VERSION } from './config.js';
import { toAnthropicRequest, toAnthropicTools, fromAnthropicResponse, applyCacheControl } from './messages.js';
import { anthropicMessagesUrl } from '../lib/aiUsage.js';

const MAX_OUTPUT_TOKENS = 16000;

// `baseUrl` is an optional Anthropic-compatible proxy (validated); blank = the real API. `promptCache` marks the stable
// prefix for caching (see applyCacheControl).
export async function sendAnthropic({ apiKey, model, messages, tools = [], maxTokens = MAX_OUTPUT_TOKENS, effort = 'medium', baseUrl = '', promptCache = true }) {
  if (!apiKey) throw new Error('Missing Anthropic API key. Add it in the NowBuddy options page.');

  const { system, messages: wire } = toAnthropicRequest(messages);
  let body = {
    model,
    max_tokens: maxTokens,
    messages: wire,
    output_config: { effort },
  };
  if (system) body.system = system;
  if (tools.length) body.tools = toAnthropicTools(tools);
  if (promptCache) body = applyCacheControl(body);

  const response = await fetch(baseUrl ? anthropicMessagesUrl(baseUrl) : ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let detail = text.slice(0, 300);
    try {
      detail = JSON.parse(text)?.error?.message || detail;
    } catch {
      // Not JSON; keep the raw text.
    }
    if (response.status === 401) throw new Error('Anthropic rejected the API key. Check it in the options page.');
    if (response.status === 429) throw new Error('Anthropic rate limit reached. Wait a moment and try again.');
    throw new Error(`Anthropic request failed (${response.status}): ${detail}`);
  }

  return fromAnthropicResponse(await response.json());
}
