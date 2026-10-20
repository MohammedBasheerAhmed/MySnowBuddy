// Sandboxed page: the only place NowBuddy evaluates script text. It is
// reached through the offscreen document, has no access to chrome.* APIs, to
// the ServiceNow page, or to any cookie.
import { runClientScript } from '../lib/mockForm.js';

const MAX_CODE = 200000;

async function handle(msg) {
  const code = String(msg.code ?? '');
  if (code.length > MAX_CODE) throw new Error('Script is too large to simulate.');

  if (msg.action === 'ping') return {};

  if (msg.action === 'syntax') {
    try {
      // Parse only: the function is created but never called.
      // eslint-disable-next-line no-new-func
      new Function(code);
      return { error: null };
    } catch (err) {
      return { error: { message: err.message } };
    }
  }

  if (msg.action === 'runClient') {
    return { run: await runClientScript({ code, clientType: msg.clientType, scenario: msg.scenario || {} }) };
  }
  throw new Error(`Unknown sandbox action "${msg.action}".`);
}

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || msg.source !== 'msb-sandbox-request') return;
  let reply;
  try {
    reply = { ok: true, ...(await handle(msg)) };
  } catch (err) {
    reply = { ok: false, error: err.message };
  }
  const respond = (payload) => event.source.postMessage({ source: 'msb-sandbox-response', id: msg.id, ...payload }, '*');
  try {
    respond(reply);
  } catch {
    // The reply held something postMessage cannot clone (a returned function, a circular object). Without a
    // reply the service worker would wait out its timer and report a false "infinite loop".
    try {
      respond(JSON.parse(JSON.stringify(reply, (key, value) => (typeof value === 'function' ? `[function ${value.name || 'anonymous'}]` : value))));
    } catch {
      respond({ ok: false, error: 'The script finished, but its result could not be sent back (circular or non-serialisable value).' });
    }
  }
});
