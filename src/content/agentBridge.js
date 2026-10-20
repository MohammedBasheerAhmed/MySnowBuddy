// Receives tool calls from the local MCP bridge (via the service worker) and
// runs them with the same approval policy as the sidebar agent. An external
// agent never gets a quieter path than the built-in one: it is also held to the
// permission ceiling chosen in Options > Agent > External agents (checked here
// AND in the service worker, so neither side alone can be bypassed), never gets
// "auto dry runs", and every run/write call waits for a person in this tab.
import { approvalMode, isGuardedEnv, effectiveTier, resolveMcpCeiling, ceilingAllows, ceilingLabel, denyMessage } from '../lib/agent/policy.js';
import { redactDeep } from '../lib/agent/agentLoop.js';
import { getToolSchema, isMcpOnlyTool } from '../lib/agent/toolSchemas.js';
import { getSettings } from './storage.js';
import { resolveGuardrails } from '../lib/agent/guardrails.js';

const STARTED_TIMEOUT_MS = 1500;

/** The pure gate for one external call: null when it may proceed to the approval step, else the refusal text. */
export function mcpGate({ tool, args, settings }) {
  if (!getToolSchema(tool) || isMcpOnlyTool(tool)) return `Unknown tool "${tool}".`;
  const ceiling = resolveMcpCeiling(settings);
  const tier = effectiveTier(tool, args);
  if (!ceilingAllows(ceiling, tier)) {
    return `Blocked by the external-agent permission ceiling ("${ceilingLabel(ceiling)}", Options > Agent). ${tool} needs "${ceilingLabel(tier)}" or higher. Ask the user to change it if they want this.`;
  }
  return null;
}

/** Autonomy for external calls: never auto-runs; read-only under a read/draft ceiling. */
export const mcpAutonomy = (settings) => (ceilingAllows(resolveMcpCeiling(settings), 'run') ? 'ask' : 'readonly');

export function installAgentBridge({ tools, approval, getInstanceInfo, audit }) {
  // Calls the MCP bridge has given up on (timeout or client cancel). They must never run, even if approved late.
  const cancelled = new Set();

  // Tells the service worker the call is past its approval and is executing now, so a page reload during the
  // action is reported as "it ran, here is the page now" rather than "it never ran".
  async function announceStart(callId) {
    if (!callId) return;
    try {
      await Promise.race([chrome.runtime.sendMessage({ type: 'AGENT_TOOL_STARTED', callId }), new Promise((resolve) => setTimeout(resolve, STARTED_TIMEOUT_MS))]);
    } catch {
      // The worker restarted; the result still arrives through the normal reply.
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only the extension's own service worker may relay calls: no tab or page can.
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    if (message?.type === 'AGENT_TOOL_CANCEL') {
      const callId = String(message.callId || '');
      if (callId) {
        cancelled.add(callId);
        setTimeout(() => cancelled.delete(callId), 10 * 60 * 1000)?.unref?.();
        approval.cancel(callId);
      }
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'MCP_SCREENSHOT_CONSENT') {
      // A screenshot cannot be redacted, so the person allows each one in this tab. The card closes before capture.
      const callId = message.callId ? String(message.callId) : undefined;
      (async () => {
        if (callId && cancelled.has(callId)) return { approved: false };
        const decision = await approval.request({
          id: callId,
          tool: 'screenshot',
          args: {},
          mode: 'ask',
          source: 'mcp',
          preview: { warnings: ['Nothing in the image is redacted. Close anything secret on screen before you allow it.'] },
        });
        if (!decision.approved) await audit.record({ instance: getInstanceInfo().host, tool: 'screenshot', args: {}, ok: false, source: 'mcp', summary: 'Screenshot denied in the browser' });
        return { approved: Boolean(decision.approved) && !(callId && cancelled.has(callId)) };
      })()
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (message?.type !== 'AGENT_TOOL_CALL') return false;

    (async () => {
      const { tool, args = {} } = message;
      const callId = message.callId ? String(message.callId) : undefined;
      const stopIfCancelled = () => {
        if (callId && cancelled.has(callId)) throw new Error('This call was cancelled by the client; nothing was changed.');
      };
      stopIfCancelled();
      const settings = await getSettings();
      const refused = mcpGate({ tool, args, settings });
      if (refused) throw new Error(refused);
      const instance = getInstanceInfo();
      const guard = resolveGuardrails(settings);
      const mode = approvalMode({ tool, args, autonomy: mcpAutonomy(settings), isProd: isGuardedEnv(instance.env), guard });

      if (mode === 'deny') throw new Error(denyMessage(tool, args, { guard }));
      if (mode === 'ask' || mode === 'ask-strong') {
        const preview = await tools.preview(tool, args);
        // The executor would refuse it (unknown column, record gone, button not on the page): say why instead of
        // showing the user a card they cannot approve.
        if (preview?.blocked) throw new Error(`Not run: ${preview.blocked}`);
        const decision = await approval.request({ id: callId, tool, args, mode, source: 'mcp', preview });
        stopIfCancelled();
        if (!decision.approved) {
          await audit.record({ instance: instance.host, tool, args, ok: false, source: 'mcp', summary: 'Denied in the browser' });
          throw new Error('The user denied this action in the browser. Do not retry it; ask what they would like instead.');
        }
        await announceStart(callId);
      }
      stopIfCancelled();
      const data = await tools.execute(tool, args, { callId, source: 'mcp' });
      return redactDeep(data);
    })()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  });
}
