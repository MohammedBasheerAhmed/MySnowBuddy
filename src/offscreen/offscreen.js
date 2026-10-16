// Offscreen document: hosts the sandboxed page in an iframe and relays requests
// from the service worker. (Extension pages cannot eval, sandbox pages can.)
const frame = document.getElementById('sandbox');
const pending = new Map();
let nextId = 0;

// The sandbox has an opaque origin, so its load state cannot be read. Ping it until it answers.
let resolveReady;
const ready = new Promise((resolve) => {
  resolveReady = resolve;
});
const pinger = setInterval(() => {
  frame.contentWindow?.postMessage({ source: 'msb-sandbox-request', id: 'ping', action: 'ping' }, '*');
}, 100);

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow) return; // only the sandbox frame answers
  const data = event.data;
  if (!data || data.source !== 'msb-sandbox-response') return;
  if (data.id === 'ping') {
    clearInterval(pinger);
    resolveReady();
    return;
  }
  const settle = pending.get(data.id);
  if (!settle) return;
  pending.delete(data.id);
  settle(data);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  // Only the service worker (SANDBOX_RUN, after its sender check) drives the sandbox; content scripts have a tab.
  if (sender?.id !== chrome.runtime.id || sender.tab) return false;
  ready.then(() => {
    nextId += 1;
    const id = nextId;
    pending.set(id, sendResponse);
    frame.contentWindow.postMessage({ source: 'msb-sandbox-request', id, ...message.payload }, '*');
  });
  return true;
});
