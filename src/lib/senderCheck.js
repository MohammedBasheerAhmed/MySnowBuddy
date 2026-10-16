// Who may send a runtime message to the service worker.
//
// Every message that has a side effect, calls the model or reaches another
// instance is checked against the frame that SENT it (sender.origin, falling
// back to sender.url), never the tab's top-level URL: a ServiceNow tab can hold
// frames from anywhere, and a look-alike host must not pass a sloppy suffix test.
//
// Policies:
//   'page'       a content script in the top frame of a *.service-now.com page
//                (the only frame where the extension's UI and agent run)
//   'frame'      a content script in any *.service-now.com frame (hotkey relay)
//   'extension'  one of this extension's own pages (options)
//   'any'        'page' or 'extension'

/** https only, at least one label before service-now.com, no port, dots escaped. */
export const SERVICE_NOW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.service-now\.com$/i;

export const PAGE_ONLY = 'This request is only allowed from a ServiceNow page.';
export const EXTENSION_ONLY = "This request is only allowed from the extension's own pages.";

export function isServiceNowOrigin(origin) {
  return typeof origin === 'string' && SERVICE_NOW_ORIGIN_RE.test(origin);
}

function originOfUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return '';
  }
  // Non-special schemes have an opaque URL.origin outside the browser.
  if (parsed.protocol === 'chrome-extension:') return parsed.host ? `chrome-extension://${parsed.host}` : '';
  return parsed.origin === 'null' ? '' : parsed.origin;
}

/** True for an https URL on a *.service-now.com host (a tab URL, a target instance). */
export function isServiceNowUrl(url) {
  return isServiceNowOrigin(originOfUrl(url));
}

/**
 * Origin of the frame that sent the message. sender.origin when the browser
 * reports one (an opaque "null" origin counts as unknown), else the origin of
 * sender.url. '' when unknown. Never sender.tab.url.
 */
export function senderOrigin(sender) {
  if (sender && typeof sender.origin === 'string') return sender.origin === 'null' ? '' : sender.origin;
  return originOfUrl(sender?.url);
}

/**
 * Throws unless `sender` satisfies `policy` (see the header). Returns the kind
 * of sender: 'page' (a ServiceNow content script) or 'extension'.
 * @param {chrome.runtime.MessageSender} sender
 * @param {string} runtimeId chrome.runtime.id
 * @param {'page'|'frame'|'extension'|'any'} policy
 */
export function checkSender(sender, runtimeId, policy = 'page') {
  if (!runtimeId || !sender || sender.id !== runtimeId) throw new Error(PAGE_ONLY);
  const origin = senderOrigin(sender);
  if (origin && origin === `chrome-extension://${runtimeId}`) {
    if (policy === 'extension' || policy === 'any') return 'extension';
    throw new Error(PAGE_ONLY);
  }
  if (policy === 'extension') throw new Error(EXTENSION_ONLY);
  if (!isServiceNowOrigin(origin) || !sender.tab?.id) throw new Error(PAGE_ONLY);
  if (policy !== 'frame' && sender.frameId !== 0) throw new Error(PAGE_ONLY);
  return 'page';
}

/** Boolean form of checkSender. */
export function isAllowedSender(sender, runtimeId, policy = 'page') {
  try {
    checkSender(sender, runtimeId, policy);
    return true;
  } catch {
    return false;
  }
}
