// The one confirmation dialog of the extension, replacing the browser's blocking window.confirm().
//
//   const ok = await askConfirm({ title: 'Run this script?', message: '...', confirmLabel: 'Run script', danger: true });
//
// It lives in the closed shadow root (src/content/uiRoot.js), so page scripts cannot reach its buttons, and only
// real clicks and keys count (isTrusted): a synthetic click() from a page script never confirms. Requests queue;
// one is on screen at a time. Text is set with textContent only. Cancel is the focus for a dangerous action,
// Esc cancels, a click on the backdrop does NOT confirm, Tab stays inside the dialog.

import { getUiRoot } from './uiRoot.js';
import { trustedDom } from '../sidebar/trusted.js';

let host = null;
let hostRoot = null;
const queue = [];
let current = null;
let seq = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The element that had focus before the dialog (so closing it puts the person back where they were). */
function activeElementDeep() {
  // Our own UI (the script editor's textarea, a sidebar button) sits in the closed root: ask the root, since
  // document.activeElement only reports the host.
  const inUi = getUiRoot()?.activeElement;
  if (inUi) return inUi;
  let node = document.activeElement;
  for (let depth = 0; depth < 4 && node && node.tagName === 'IFRAME'; depth += 1) {
    try {
      node = node.contentDocument?.activeElement || node;
    } catch {
      break; // cross-origin frame
    }
  }
  return node;
}

function ensureHost(root) {
  if (host && hostRoot === root && host.isConnected) return host;
  host = el('div', 'msb-confirm');
  host.hidden = true;
  hostRoot = root;
  root.appendChild(host);
  return host;
}

function finish(answer) {
  if (!current) return;
  const { resolve, returnFocus } = current;
  current = null;
  host.hidden = true;
  host.replaceChildren();
  try {
    if (returnFocus && returnFocus !== document.body && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  } catch {
    // The element left the page.
  }
  resolve(answer);
  next();
}

function render(opts) {
  const id = `msb-confirm-${(seq += 1)}`;
  const card = el('div', `msb-confirm__card${opts.danger ? ' msb-confirm__card--danger' : ''}`);
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', `${id}-title`);
  card.setAttribute('aria-describedby', `${id}-text`);
  const title = el('h2', 'msb-confirm__title', opts.title);
  title.id = `${id}-title`;
  const text = el('p', 'msb-confirm__text', opts.message);
  text.id = `${id}-text`;
  card.append(title, text);
  if (opts.details) {
    const details = el('pre', 'msb-confirm__details', opts.details);
    details.tabIndex = 0; // a long list must be scrollable from the keyboard
    details.setAttribute('aria-label', 'Details');
    card.append(details);
  }
  const cancel = el('button', 'msb-btn', opts.cancelLabel);
  cancel.type = 'button';
  const ok = el('button', `msb-btn msb-btn--primary${opts.danger ? ' msb-confirm__ok--danger' : ''}`, opts.confirmLabel);
  ok.type = 'button';
  cancel.addEventListener('click', trustedDom(() => finish(false)));
  ok.addEventListener('click', trustedDom(() => finish(true)));
  const actions = el('div', 'msb-confirm__actions');
  actions.append(cancel, ok);
  card.append(actions);

  card.addEventListener('keydown', (event) => {
    // Keys belong to the dialog: the editor and the page have their own shortcuts.
    event.stopPropagation();
    if (event.isTrusted !== true) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const stops = [...card.querySelectorAll('button, [tabindex="0"]')].filter((node) => !node.disabled);
    const at = stops.indexOf(card.getRootNode().activeElement);
    const target = event.shiftKey ? (at <= 0 ? stops[stops.length - 1] : stops[at - 1]) : at === stops.length - 1 ? stops[0] : stops[at + 1];
    if (target) {
      event.preventDefault();
      target.focus();
    }
  });

  host.replaceChildren(card);
  host.hidden = false;
  // A dangerous action defaults to "Cancel", so a stray Enter cannot confirm it.
  (opts.danger ? cancel : ok).focus();
}

function next() {
  if (current || !queue.length) return;
  const item = queue.shift();
  const root = getUiRoot();
  if (!root) {
    item.resolve(false);
    next();
    return;
  }
  ensureHost(root);
  current = { resolve: item.resolve, returnFocus: activeElementDeep() };
  render(item.opts);
}

/**
 * Ask the person to confirm something. Resolves true on Confirm, false on Cancel or Esc.
 * Without the extension's UI root (unit tests) it falls back to the native dialog.
 * @param {{title: string, message?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean, details?: string}} options
 * @returns {Promise<boolean>}
 */
export function askConfirm({ title, message = '', confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false, details = '' } = {}) {
  const opts = { title: String(title || 'Are you sure?'), message: String(message), confirmLabel, cancelLabel, danger: Boolean(danger), details: String(details || '') };
  if (!getUiRoot()) {
    const native = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm([opts.title, opts.message, opts.details].filter(Boolean).join('\n\n')) : false;
    return Promise.resolve(native);
  }
  return new Promise((resolve) => {
    queue.push({ opts, resolve });
    next();
  });
}

/** True while a confirmation is on screen or waiting (so a second Esc or click cannot stack another one). */
export function confirmPending() {
  return Boolean(current) || queue.length > 0;
}
