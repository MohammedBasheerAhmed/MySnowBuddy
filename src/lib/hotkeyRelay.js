// Hotkeys pressed inside a sub-frame (classic gsft_main, the Next Experience
// shell's frame) are relayed to the top frame, where the UI lives:
//   sub-frame content script -> service worker -> chrome.tabs.sendMessage(tab, msg, { frameId: 0 }).
// Never window.postMessage: any script on the page can post the same message.
// Only keydowns the browser generated from real input (isTrusted) are relayed.

export function matchesPaletteHotkey(event) {
  return event.ctrlKey && event.shiftKey && !event.altKey && (event.code === 'Space' || event.key === ' ');
}

export function matchesChatHotkey(event) {
  return event.altKey && event.shiftKey && !event.ctrlKey && event.code === 'KeyC';
}

export function matchesEditorHotkey(event) {
  return event.altKey && event.shiftKey && !event.ctrlKey && event.code === 'KeyE';
}

/** Keys the open palette needs from a sub-frame that holds focus. */
export const RELAY_NAV_KEYS = new Set(['Escape', 'ArrowDown', 'ArrowUp', 'Enter', 'Home', 'End']);

export const RELAY_ACTIONS = new Set(['palette', 'chat', 'editor', 'xray', 'key']);

function isPaletteNavKey(event) {
  const key = String(event.key || '');
  return RELAY_NAV_KEYS.has(key) || (Boolean(event.ctrlKey) && (key.toLowerCase() === 'n' || key.toLowerCase() === 'p'));
}

/**
 * What a sub-frame keydown relays to the top frame: { action, key? } or null.
 * Synthetic (untrusted) events never relay.
 */
export function frameHotkeyRelay(event, { paletteOpen = false } = {}) {
  if (!event || event.isTrusted !== true) return null;
  if (paletteOpen && isPaletteNavKey(event)) {
    return { action: 'key', key: { key: event.key, ctrlKey: Boolean(event.ctrlKey), shiftKey: Boolean(event.shiftKey), metaKey: Boolean(event.metaKey) } };
  }
  if (matchesPaletteHotkey(event)) return { action: 'palette' };
  if (matchesChatHotkey(event)) return { action: 'chat' };
  if (matchesEditorHotkey(event)) return { action: 'editor' };
  return null;
}

/** Service-worker side: the relay message rebuilt from known fields only, or null when it is not one. */
export function sanitizeFrameHotkey(payload) {
  const action = payload?.action;
  if (!RELAY_ACTIONS.has(action)) return null;
  if (action !== 'key') return { type: 'FRAME_HOTKEY', action };
  const k = payload.key || {};
  const key = { key: String(k.key || ''), ctrlKey: k.ctrlKey === true, shiftKey: k.shiftKey === true, metaKey: k.metaKey === true };
  if (!isPaletteNavKey(key)) return null;
  return { type: 'FRAME_HOTKEY', action, key };
}

/** Content-script side: ask the service worker to relay. Silent when the extension was reloaded. */
export function sendFrameHotkey(relay) {
  try {
    const sent = chrome.runtime.sendMessage({ type: 'FRAME_HOTKEY', payload: relay });
    sent?.catch?.(() => {});
  } catch {
    // Extension context invalidated (reloaded): nothing to tell.
  }
}
