// Content-script context detection helpers.
//
// IMPORTANT: content scripts run in an "isolated world" — they share the DOM
// with the page but NOT its JS global scope. That means we cannot read
// window.g_ck directly here even though it exists as a real global in the
// page's own JS context. getCsrfToken() works around this by injecting a
// tiny <script> tag (which executes in the page's world), reading
// window.g_ck there, and bridging the value back via a CustomEvent
// dispatched on the shared `window`/DOM event system.
export function getCsrfToken() {
  return new Promise((resolve) => {
    const eventName = `mysnowbuddy-csrf-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    function handler(event) {
      window.removeEventListener(eventName, handler);
      resolve(event.detail?.token || null);
    }
    window.addEventListener(eventName, handler);

    const script = document.createElement('script');
    script.textContent = `
      (function () {
        try {
          var token = (typeof window.g_ck !== 'undefined') ? window.g_ck : null;
          window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, { detail: { token: token } }));
        } catch (e) {
          window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, { detail: { token: null } }));
        }
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();

    // Safety timeout in case the page context never responds.
    setTimeout(() => {
      window.removeEventListener(eventName, handler);
      resolve(null);
    }, 1500);
  });
}

// Heuristic field-name hints used to find the "script-like" field on a
// ServiceNow form (Business Rule / Script Include / Client Script / ACL).
// NOTE: these selectors are best-effort and should be validated/refined
// against a real ServiceNow dev instance — see docs/decisions.md.
const KNOWN_SCRIPT_FIELD_HINTS = ['script', 'condition', 'advanced', 'client_script'];

function findScriptField() {
  const candidates = Array.from(document.querySelectorAll('textarea'));
  for (const el of candidates) {
    const name = (el.name || el.id || '').toLowerCase();
    if (KNOWN_SCRIPT_FIELD_HINTS.some((hint) => name.includes(hint))) {
      return el;
    }
  }
  return candidates.find((el) => el.value && el.value.length > 40) || null;
}

export function detectPageContext() {
  const url = new URL(window.location.href);
  const params = url.searchParams;

  let table = params.get('table') || null;
  if (!table) {
    const match = url.pathname.match(/\/([a-z0-9_]+)\.do$/i);
    if (match) {
      table = match[1];
    }
  }

  const sysId =
    params.get('sys_id') ||
    document.querySelector('input[name="sys_uniqueValue"]')?.value ||
    null;

  const scriptField = findScriptField();

  return {
    table,
    sysId,
    scriptBody: scriptField ? scriptField.value : null,
    scriptFieldLabel: scriptField ? scriptField.getAttribute('aria-label') || scriptField.name || scriptField.id || null : null,
  };
}
