// Owner of the shadow root that holds the extension's in-page UI (sidebar,
// command palette, approval dialog, toasts, script editor).
//
// SECURITY: the root is CLOSED. Scripts on the ServiceNow page (UI scripts,
// widgets) share the DOM with us; with an open root they could reach every
// button and input through host.shadowRoot, fill the typed confirmations and
// dispatch clicks. A closed root is reachable only through the reference kept
// here. Content scripts run in an isolated world, so a page script cannot
// patch attachShadow to capture it. Code that needs the root takes it from
// getUiRoot() (or as a parameter), never from host.shadowRoot.

export const UI_HOST_ID = 'mysnowbuddy-root';

let uiRoot = null;

/** Attach the closed UI root to `host` and keep the reference. */
export function attachUiRoot(host) {
  uiRoot = host.attachShadow({ mode: 'closed' });
  return uiRoot;
}

/** The extension's UI root, or null before it is attached. */
export function getUiRoot() {
  return uiRoot;
}
