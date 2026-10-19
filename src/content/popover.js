// A small answer shown next to what you pointed at, instead of in the sidebar.
//
// Lives in the extension's closed shadow root (see uiRoot.js), so instance CSS cannot restyle it
// and page scripts cannot reach it. Built from DOM nodes only: ServiceNow pages can carry a Trusted
// Types policy, and instance data (field values, audit rows) must never be parsed as HTML.
//
// spec = {
//   anchor     Element | DOMRect | { x, y }        what the popover points at
//   doc        the document the anchor lives in    pass it for the classic gsft_main frame so the
//                                                   rect is moved into top-window coordinates
//   title, subtitle
//   rows       [{ label, value, mono?, copy? }]
//   body       plain text, shown pre-wrapped
//   actions    [{ label, onClick, primary? }]
//   tone       'info' | 'ok' | 'warn' | 'danger'
//   busy       true while something loads (a spinner under the rows)
// }
// show(spec) opens it, update(patch) changes it in place (open busy, fill in when the fetch ends).

import { trustedDom } from '../sidebar/trusted.js';
import { UI_HOST_ID } from './uiRoot.js';
import { copyText } from './quickActions.js';
import { normalizeRect, translateRect, placePopover } from '../lib/inline.js';

const MAX_FRAME_DEPTH = 4;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Rect of an anchor in top-window coordinates. */
function anchorRect(anchor, doc) {
  let rect = typeof anchor?.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : normalizeRect(anchor);
  let win = doc?.defaultView || anchor?.ownerDocument?.defaultView || window;
  for (let depth = 0; depth < MAX_FRAME_DEPTH && win && win !== window; depth += 1) {
    const frame = win.frameElement;
    if (!frame) break;
    rect = translateRect(rect, frame.getBoundingClientRect());
    win = frame.ownerDocument?.defaultView;
  }
  return normalizeRect(rect);
}

export function createPopover({ shadow, toast } = {}) {
  const root = el('div', 'msb-pop');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'false');
  root.tabIndex = -1;

  const aurora = el('div', 'msb-pop__line');
  const head = el('div', 'msb-pop__head');
  const titles = el('div', 'msb-pop__titles');
  const titleEl = el('div', 'msb-pop__title');
  const subtitleEl = el('div', 'msb-pop__subtitle');
  titles.append(titleEl, subtitleEl);
  const closeBtn = el('button', 'msb-pop__close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  head.append(titles, closeBtn);
  const rowsEl = el('dl', 'msb-pop__rows');
  const bodyEl = el('pre', 'msb-pop__body');
  const busyEl = el('div', 'msb-pop__busy');
  busyEl.append(el('span', 'msb-spinner'), el('span', null, 'Loading…'));
  const actionsEl = el('div', 'msb-pop__actions');
  root.append(aurora, head, rowsEl, bodyEl, busyEl, actionsEl);
  shadow.appendChild(root);

  let spec = null;
  let returnFocus = null;
  let outsideDocs = [];

  function copy(text) {
    copyText(text)
      .then(() => toast?.success('Copied'))
      .catch((err) => toast?.error(err.message || String(err)));
  }

  function render() {
    const s = spec;
    root.className = `msb-pop msb-pop--${s.tone || 'info'}`;
    root.setAttribute('aria-label', s.title || 'Details');
    titleEl.textContent = s.title || '';
    subtitleEl.textContent = s.subtitle || '';
    subtitleEl.hidden = !s.subtitle;

    rowsEl.replaceChildren();
    (s.rows || []).forEach((row) => {
      const wrap = el('div', 'msb-pop__row');
      wrap.appendChild(el('dt', null, row.label));
      const dd = el('dd', row.mono ? 'msb-pop__mono' : null, row.value);
      wrap.appendChild(dd);
      if (row.copy) {
        const btn = el('button', 'msb-pop__copy', 'Copy');
        btn.type = 'button';
        btn.addEventListener('click', trustedDom(() => copy(row.value)));
        wrap.appendChild(btn);
      }
      rowsEl.appendChild(wrap);
    });
    rowsEl.hidden = !(s.rows || []).length;

    bodyEl.textContent = s.body || '';
    bodyEl.hidden = !s.body;
    busyEl.hidden = !s.busy;

    actionsEl.replaceChildren();
    (s.actions || []).forEach((action) => {
      const btn = el('button', `msb-btn msb-btn--sm${action.primary ? ' msb-btn--primary' : ''}`, action.label);
      btn.type = 'button';
      btn.addEventListener(
        'click',
        trustedDom(() => {
          try {
            action.onClick?.();
          } catch (err) {
            toast?.error(err.message || String(err));
          }
        })
      );
      actionsEl.appendChild(btn);
    });
    actionsEl.hidden = !(s.actions || []).length;
  }

  function place() {
    const rect = anchorRect(spec.anchor, spec.doc);
    const size = { width: root.offsetWidth, height: root.offsetHeight };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const { left, top, placement } = placePopover(rect, size, viewport);
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.dataset.placement = placement;
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && event.isTrusted) {
      event.stopPropagation();
      hide();
    }
  }

  // A press anywhere outside closes it; presses inside the classic frame never reach the top document.
  function onOutside(event) {
    if (!event.isTrusted) return;
    // The root is closed, so from a document listener our own nodes show up only as their host.
    const path = event.composedPath?.() || [];
    if (path.some((n) => n?.id === UI_HOST_ID || n?.dataset?.msbInline)) return;
    hide();
  }

  function listenOutside(doc) {
    const docs = new Set([document, doc].filter(Boolean));
    docs.forEach((d) => d.addEventListener('mousedown', onOutside, true));
    outsideDocs = [...docs];
  }

  function unlistenOutside() {
    outsideDocs.forEach((d) => {
      try {
        d.removeEventListener('mousedown', onOutside, true);
      } catch {
        // The frame is gone.
      }
    });
    outsideDocs = [];
  }

  function show(next) {
    const wasOpen = !root.hidden;
    spec = { ...next };
    if (!wasOpen) {
      returnFocus = shadow.activeElement || document.activeElement;
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('resize', hide);
    } else {
      unlistenOutside();
    }
    listenOutside(spec.doc);
    render();
    root.style.visibility = 'hidden';
    root.hidden = false;
    place();
    root.style.visibility = '';
    if (!wasOpen) (actionsEl.querySelector('.msb-btn--primary') || closeBtn).focus({ preventScroll: true });
  }

  function update(patch) {
    if (root.hidden || !spec) return;
    spec = { ...spec, ...patch };
    render();
    place();
  }

  function hide() {
    if (root.hidden) return;
    root.hidden = true;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', hide);
    unlistenOutside();
    spec = null;
    try {
      returnFocus?.focus?.({ preventScroll: true });
    } catch {
      // The element left the page.
    }
    returnFocus = null;
  }

  closeBtn.addEventListener('click', trustedDom(hide));

  return { element: root, show, update, hide, isOpen: () => !root.hidden };
}
