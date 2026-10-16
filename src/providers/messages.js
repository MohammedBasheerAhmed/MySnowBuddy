// Provider-neutral conversation format and the converters to each vendor's wire
// format. Pure functions, so they are unit-tested without any network.
//
// Neutral messages:
//   { role: 'system' | 'user', content }
//   { role: 'assistant', content, toolCalls?: [{ id, name, args }], raw?: { provider, blocks } }
//   { role: 'tool', toolCallId, name, content, isError? }
//
// `raw` carries the vendor's own assistant blocks. Anthropic requires thinking
// blocks to be sent back unchanged within a tool loop, so the adapter replays
// `raw` when it came from the same provider instead of rebuilding the turn.

function parseJsonObject(text) {
  if (text && typeof text === 'object') return text;
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

// ---- OpenAI ------------------------------------------------------------------

export function toOpenAIMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

export function fromOpenAIResponse(data) {
  const choice = data?.choices?.[0];
  const message = choice?.message;
  if (!message) throw new Error('OpenAI response did not include a message.');
  const toolCalls = (message.tool_calls || []).map((c) => ({
    id: c.id,
    name: c.function?.name,
    args: parseJsonObject(c.function?.arguments),
  }));
  if (!message.content && !toolCalls.length) throw new Error('OpenAI response did not include any content.');
  return {
    content: message.content || '',
    toolCalls,
    stopReason: choice.finish_reason === 'length' ? 'max_tokens' : toolCalls.length ? 'tool_use' : 'end_turn',
    usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 },
  };
}

// ---- Anthropic ---------------------------------------------------------------

export function toAnthropicTools(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

/** { system, messages } in the Messages API shape. */
export function toAnthropicRequest(messages) {
  const system = [];
  const out = [];

  const push = (role, content) => {
    const last = out[out.length - 1];
    // Parallel tool results must share one user message.
    if (last && last.role === role && Array.isArray(last.content) && Array.isArray(content)) {
      last.content.push(...content);
    } else {
      out.push({ role, content });
    }
  };

  for (const m of messages) {
    if (m.role === 'system') {
      system.push(m.content);
    } else if (m.role === 'tool') {
      push('user', [
        { type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? ''), ...(m.isError ? { is_error: true } : {}) },
      ]);
    } else if (m.role === 'assistant') {
      if (m.raw?.provider === 'anthropic' && Array.isArray(m.raw.blocks)) {
        out.push({ role: 'assistant', content: m.raw.blocks });
      } else {
        const blocks = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        (m.toolCalls || []).forEach((c) => blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} }));
        if (blocks.length) out.push({ role: 'assistant', content: blocks });
      }
    } else {
      push('user', m.content);
    }
  }
  return { system: system.join('\n\n'), messages: out };
}

export function fromAnthropicResponse(data) {
  if (data?.stop_reason === 'refusal') {
    const category = data.stop_details?.category;
    throw new Error(
      `The model declined this request${category ? ` (${category})` : ''}. Rephrase it or try a different model in the options page.`
    );
  }
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const content = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, args: parseJsonObject(b.input) }));
  if (!content && !toolCalls.length) throw new Error('The model returned no content.');
  return {
    content,
    toolCalls,
    raw: { provider: 'anthropic', blocks },
    stopReason: data.stop_reason === 'max_tokens' ? 'max_tokens' : toolCalls.length ? 'tool_use' : 'end_turn',
    usage: { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 },
  };
}
