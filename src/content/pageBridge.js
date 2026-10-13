// Content-script side of the page-world bridge.
//
// Content scripts run in an isolated world: they share the DOM with the page
// but NOT its JavaScript globals. `window.g_form` and `window.g_ck` are
// therefore invisible here. This module injects src/page/bridge.js into the
// page world (as an extension-hosted file, so it survives ServiceNow's CSP)
// and exposes a promise-based RPC over CustomEvents.

const REQUEST_EVENT = 'msb-page-request';
const RESPONSE_EVENT = 'msb-page-response';
const DEFAULT_TIMEOUT_MS = 2500;

let injectionPromise = null;
let nextId = 0;

function injectBridge() {
  if (injectionPromise) return injectionPromise;

  injectionPromise = new Promise((resolve, reject) => {
    // If a previous content script instance already injected it, reuse it.
    if (document.documentElement.hasAttribute('data-msb-bridge')) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('pagebridge.js');
    script.async = false;
    script.addEventListener('load', () => {
      document.documentElement.setAttribute('data-msb-bridge', '1');
      script.remove();
      resolve();
    });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error('Failed to inject the page bridge script.'));
    });
    (document.head || document.documentElement).appendChild(script);
  });

  return injectionPromise;
}

/**
 * Call an action exposed by src/page/bridge.js.
 * @param {string} action One of: getCsrfToken, getUserInfo, getFormMeta, getFormValues,
 *   getScriptFields, getFieldState, setFieldValue, getListInfo
 * @param {Array} args Arguments forwarded to the action.
 * @param {{timeoutMs?: number}} options
 * @returns {Promise<any>}
 */
export async function callPage(action, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  await injectBridge();

  const id = `msb-${Date.now()}-${nextId++}`;

  return new Promise((resolve, reject) => {
    let settled = false;

    function cleanup() {
      document.removeEventListener(RESPONSE_EVENT, onResponse);
      clearTimeout(timer);
    }

    function onResponse(event) {
      const detail = event?.detail;
      if (!detail || detail.id !== id) return;
      settled = true;
      cleanup();
      if (detail.ok) resolve(detail.result);
      else reject(new Error(detail.error || 'Page bridge call failed.'));
    }

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error(`Page bridge timed out calling "${action}".`));
    }, timeoutMs);

    document.addEventListener(RESPONSE_EVENT, onResponse);
    document.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: { id, action, args } }));
  });
}

/** Convenience wrapper that resolves to null instead of throwing. */
export async function tryCallPage(action, args = []) {
  try {
    return await callPage(action, args);
  } catch {
    return null;
  }
}
