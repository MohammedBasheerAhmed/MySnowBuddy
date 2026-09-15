// OpenAI provider adapter. Keep this module the only place that knows about
// OpenAI's specific request/response shape, so adding another provider later
// (Gemini/Anthropic/DeepSeek/Azure OpenAI) only means adding a sibling module
// with the same two exported functions, not touching any calling code.
import { OPENAI_MODEL, OPENAI_API_URL } from './config.js';

export async function sendChatCompletion(apiKey, messages, { temperature = 0.2 } = {}) {
  if (!apiKey) {
    throw new Error('Missing OpenAI API key. Configure it in the MySnowBuddy options page.');
  }

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`OpenAI request failed (${response.status}): ${errorBody.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI response did not include any content.');
  }
  return content;
}

export async function validateApiKey(apiKey) {
  try {
    await sendChatCompletion(apiKey, [{ role: 'user', content: 'ping' }], { temperature: 0 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
