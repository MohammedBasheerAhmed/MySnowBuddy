// The agent loop: model -> tool calls -> results -> model, with approval gates.
// Pure orchestration. The model call, tool execution and approval UI are all
// injected, so the same loop serves the sidebar and is tested without a browser.
import { redactSecrets, isSecretName, REDACTED } from '../../providers/redact.js';
import { denyMessage } from './policy.js';

const MAX_RESULT_CHARS = 14000;
const MAX_IDENTICAL_CALLS = 3;

const SECRET_KEY = /pass(word|wd)?|secret|token|api[_-]?key|credential|private[_-]?key/i;

// Redact string values before serializing: once JSON-escaped, quotes inside a
// script (password = \"x\") no longer match the redaction patterns.
export function redactDeep(value, key = '') {
  if (typeof value === 'string') return SECRET_KEY.test(key) && value.length > 3 && !/\s/.test(value) ? '[REDACTED]' : redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, key));
  if (value && typeof value === 'object') {
    // A name/value row (sys_properties, a form field) whose NAME is a secret: its value is the secret,
    // whatever the value key is called.
    const secretRow = typeof value.name === 'string' && isSecretName(value.name);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretRow && ROW_VALUE_KEYS.has(k) ? hideAll(v) : redactDeep(v, k)]));
  }
  return value;
}

const ROW_VALUE_KEYS = new Set(['value', 'display_value', 'display', 'displayValue']);
const hideAll = (v) => {
  if (typeof v === 'string') return v ? REDACTED : v;
  if (Array.isArray(v)) return v.map(hideAll);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hideAll(x)]));
  return v;
};

function serialize(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(redactDeep(value), null, 1) ?? 'null';
  } catch {
    return String(value);
  }
}

/** Redacted and size-capped text for the model. */
export function toModelText(value, limit = MAX_RESULT_CHARS) {
  const text = redactSecrets(serialize(value));
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... [truncated ${text.length - limit} characters. Narrow the query or ask for specific fields.]`;
}

/**
 * @param {object} p
 * @param {Array}  p.messages        neutral conversation so far (system first). Mutated copy is returned.
 * @param {Array}  p.tools           tool schemas offered to the model
 * @param {(req:{messages:Array,tools:Array})=>Promise<object>} p.callModel
 * @param {(name:string,args:object,ctx:{id:string})=>Promise<any>} p.executeTool   throws on failure
 * @param {(name:string,args:object)=>'auto'|'ask'|'ask-strong'|'deny'} p.approvalMode
 * @param {(req:{id:string,tool:string,args:object,mode:string})=>Promise<{approved:boolean,note?:string}>} p.requestApproval
 * @param {(event:object)=>void} [p.onEvent]
 * @param {number} [p.maxSteps]
 * @param {AbortSignal} [p.signal]
 */
export async function runAgent({
  messages,
  tools,
  callModel,
  executeTool,
  approvalMode,
  requestApproval,
  onEvent = () => {},
  maxSteps = 16,
  signal,
}) {
  const convo = [...messages];
  const seenCalls = new Map();
  let finalText = '';
  let stopped = 'done';
  let step = 0;

  const aborted = () => signal?.aborted;

  try {
    while (step < maxSteps) {
      if (aborted()) {
        stopped = 'aborted';
        break;
      }
      step += 1;
      onEvent({ type: 'thinking', step });

      const reply = await callModel({ messages: convo, tools });
      convo.push({ role: 'assistant', content: reply.content, toolCalls: reply.toolCalls, raw: reply.raw });
      if (reply.content) onEvent({ type: 'assistant_text', text: reply.content, step, final: !reply.toolCalls?.length });

      if (!reply.toolCalls?.length) {
        finalText = reply.content;
        if (reply.stopReason === 'max_tokens') {
          finalText += '\n\n(The reply was cut off by the output limit. Ask me to continue.)';
        }
        break;
      }

      for (const call of reply.toolCalls) {
        if (aborted()) {
          convo.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'Cancelled by the user.', isError: true });
          continue;
        }
        const result = await handleCall(call);
        convo.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result.text, isError: result.isError });
      }
      if (aborted()) {
        stopped = 'aborted';
        break;
      }
    }

    if (stopped === 'done' && !finalText) {
      // Out of steps: ask for a wrap-up. The tool definitions stay in the request because the history holds
      // tool_use/tool_result blocks, and providers reject that with no tools defined; the prompt says not to use them.
      stopped = 'limit';
      onEvent({ type: 'limit', maxSteps });
      convo.push({
        role: 'user',
        content: 'You have used all your tool steps. Do NOT call any more tools. In a few sentences, say what you did, what you found, and what is left for the user.',
      });
      const wrap = await callModel({ messages: convo, tools });
      const wantedMoreTools = Boolean(wrap.toolCalls?.length);
      finalText =
        wrap.content ||
        `I reached the ${maxSteps}-step limit before finishing. Everything above is what I did so far; ask me to continue and I will pick up from there.`;
      // A reply that still asks for tools is stored as plain text: a tool_use with no result would corrupt later turns.
      convo.push(wantedMoreTools ? { role: 'assistant', content: finalText } : { role: 'assistant', content: wrap.content, raw: wrap.raw });
      onEvent({ type: 'assistant_text', text: finalText, step, final: true });
    }
  } catch (err) {
    stopped = 'error';
    onEvent({ type: 'error', message: err.message });
    finalText = finalText || `Error: ${err.message}`;
  }

  onEvent({ type: 'done', stopped });
  return { messages: convo, finalText, stopped, steps: step };

  async function handleCall(call) {
    const args = call.args || {};
    const key = `${call.name}:${JSON.stringify(args)}`;
    const repeats = (seenCalls.get(key) || 0) + 1;
    seenCalls.set(key, repeats);
    if (repeats > MAX_IDENTICAL_CALLS) {
      const text = `You already made this exact call ${repeats - 1} times. Change your approach or tell the user what is blocking you.`;
      onEvent({ type: 'tool_result', id: call.id, tool: call.name, ok: false, text });
      return { text, isError: true };
    }

    const mode = approvalMode(call.name, args);
    onEvent({ type: 'tool_start', id: call.id, tool: call.name, args, mode });

    if (mode === 'deny') {
      const text = denyMessage(call.name, args);
      onEvent({ type: 'tool_result', id: call.id, tool: call.name, ok: false, denied: true, text });
      return { text, isError: true };
    }

    if (mode === 'ask' || mode === 'ask-strong') {
      onEvent({ type: 'approval_request', id: call.id, tool: call.name, args, mode });
      const decision = await requestApproval({ id: call.id, tool: call.name, args, mode });
      onEvent({ type: 'approval_result', id: call.id, approved: Boolean(decision?.approved) });
      if (!decision?.approved) {
        const text = `The user declined this action${decision?.note ? `: ${decision.note}` : ''}. Do not retry it; ask what they would like instead.`;
        onEvent({ type: 'tool_result', id: call.id, tool: call.name, ok: false, denied: true, text });
        return { text, isError: false };
      }
    }

    try {
      const data = await executeTool(call.name, args, { id: call.id });
      const text = toModelText(data);
      onEvent({ type: 'tool_result', id: call.id, tool: call.name, ok: true, data, text });
      return { text, isError: false };
    } catch (err) {
      const text = `Error: ${err.message}`;
      onEvent({ type: 'tool_result', id: call.id, tool: call.name, ok: false, text });
      return { text, isError: true };
    }
  }
}
