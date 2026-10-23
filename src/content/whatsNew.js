// "What's new" card: the tools added in this version, by the job a developer is doing. Every line opens the tool.
//
// Shown once per version, a few seconds after the page settles, and only to people who already dismissed the first-run
// welcome card (anyone who has not gets that card instead and never both). It waits while the palette, another card, the
// editor or a confirmation is on screen, while someone is typing in a field, and while the tab is hidden.
// "What's new" in the palette brings it back. What it lists and the rules for who sees it: src/lib/whatsNew.js.

import { trustedDom } from '../sidebar/trusted.js';
import { WELCOMED_KEY } from './welcome.js';
import { GROUPS, SELF_CHECK, SEEN_KEY, NOTES_VERSION, decideWhatsNew, canShowNow, isAtLeast, isTypingIn, subtitle } from '../lib/whatsNew.js';

const SHOW_AFTER_MS = 4000;
const RETRY_MS = 5000;
const MAX_TRIES = 8;
// Other things that own the screen. The card never covers them.
const OTHER_OVERLAYS = '.msb-welcome, .msb-guide, .msb-confirm, .msb-ed';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The element that really has the focus. A classic form lives in a same-origin iframe (gsft_main), and in the Next
 * Experience shell that iframe and the workspace fields sit inside shadow roots, so document.activeElement is only the
 * frame or the outermost host: look inside both, or someone typing in a form field would not count as typing.
 */
export function deepActiveElement(doc = document) {
  let node = doc?.activeElement || null;
  for (let depth = 0; depth < 12 && node; depth += 1) {
    const inner = node.shadowRoot?.activeElement;
    if (inner) {
      node = inner;
      continue;
    }
    const tag = String(node.tagName || '').toUpperCase();
    if (tag !== 'IFRAME' && tag !== 'FRAME') break;
    let framed = null;
    try {
      framed = node.contentDocument?.activeElement || null;
    } catch {
      break; // a cross-origin frame
    }
    if (!framed || framed === node.contentDocument?.body) break;
    node = framed;
  }
  return node;
}

/**
 * @param {{
 *   shadow: ShadowRoot,
 *   openPalette: (text?: string) => void,
 *   openPanel: (name: string) => void,
 *   openEditor?: () => unknown,
 *   isPaletteOpen?: () => boolean,
 *   getVersion?: () => string,
 *   delayMs?: number,
 * }} deps
 * @returns {{ show: () => void, hide: () => void, maybeShow: () => Promise<void> }}
 */
export function createWhatsNew({ shadow, openPalette, openPanel, openEditor, isPaletteOpen = () => false, getVersion, delayMs = SHOW_AFTER_MS }) {
  let card = null;
  let opener = null; // what had focus before the card opened, so closing it does not strand a keyboard user
  let timer = null;
  let tries = 0;

  const version = () => {
    try {
      return String(getVersion?.() || NOTES_VERSION);
    } catch {
      return NOTES_VERSION;
    }
  };

  function remember() {
    try {
      chrome.storage.local.set({ [SEEN_KEY]: NOTES_VERSION })?.catch?.(() => {});
    } catch {
      // No storage (the extension was reloaded): it may show again next time, which is harmless.
    }
  }

  function run(open) {
    try {
      const result = open.panel ? openPanel?.(open.panel) : open.editor ? openEditor?.() : openPalette?.(open.palette ?? '');
      result?.catch?.((err) => console.error('[NowBuddy] what’s new', err));
    } catch (err) {
      console.error('[NowBuddy] what’s new', err);
    }
  }

  function line(item) {
    const row = el('button', 'msb-whatsnew__item');
    row.type = 'button';
    row.append(el('span', 'msb-whatsnew__name', item.name), el('span', 'msb-whatsnew__tag', item.slash), el('span', 'msb-whatsnew__what', item.what));
    row.addEventListener(
      'click',
      trustedDom(() => {
        hide();
        run(item.open);
      })
    );
    return row;
  }

  function build() {
    const root = el('section', 'msb-whatsnew');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'What’s new in NowBuddy');
    root.appendChild(el('div', 'msb-whatsnew__line'));

    const head = el('div', 'msb-whatsnew__head');
    const titles = el('div', 'msb-whatsnew__titles');
    titles.append(el('div', 'msb-whatsnew__title', 'What’s new in NowBuddy'), el('div', 'msb-whatsnew__sub', subtitle(version())));
    const close = el('button', 'msb-whatsnew__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', trustedDom(() => hide()));
    head.append(titles, close);
    root.appendChild(head);

    const body = el('div', 'msb-whatsnew__body');
    GROUPS.forEach((group) => {
      const section = el('section', 'msb-whatsnew__group');
      section.appendChild(el('h3', 'msb-whatsnew__groupTitle', group.title));
      group.items.forEach((item) => section.appendChild(line(item)));
      body.appendChild(section);
    });
    root.appendChild(body);

    root.appendChild(el('p', 'msb-whatsnew__note', SELF_CHECK.note));

    const actions = el('div', 'msb-whatsnew__actions');
    const check = el('button', 'msb-btn msb-btn--sm', SELF_CHECK.label);
    check.type = 'button';
    check.addEventListener(
      'click',
      trustedDom(() => {
        hide();
        run({ panel: SELF_CHECK.panel });
      })
    );
    const done = el('button', 'msb-btn msb-btn--sm msb-btn--primary', 'Got it');
    done.type = 'button';
    done.addEventListener('click', trustedDom(() => hide()));
    actions.append(check, done);
    root.appendChild(actions);

    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && event.isTrusted) hide();
    });
    return { root, focus: done };
  }

  function show() {
    clearTimeout(timer);
    timer = null;
    if (card) {
      card.querySelector('.msb-btn--primary')?.focus({ preventScroll: true });
      return;
    }
    opener = deepActiveElement();
    const built = build();
    card = built.root;
    shadow.appendChild(card);
    built.focus.focus({ preventScroll: true });
    // Shown means seen: it appears once per version even if the page changes under it.
    remember();
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    card?.remove();
    card = null;
    if (opener?.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    opener = null;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(attempt, ms);
  }

  function onVisible() {
    if (document.hidden) document.addEventListener('visibilitychange', onVisible, { once: true });
    else schedule(delayMs);
  }

  async function attempt() {
    timer = null;
    if (card) return;
    if (document.hidden) {
      document.addEventListener('visibilitychange', onVisible, { once: true });
      return;
    }
    // Another tab may have shown it while this one waited.
    try {
      const stored = await chrome.storage.local.get(SEEN_KEY);
      if (isAtLeast(stored?.[SEEN_KEY], NOTES_VERSION)) return;
    } catch {
      return;
    }
    const state = canShowNow({
      paletteOpen: Boolean(isPaletteOpen()),
      hidden: document.hidden,
      cardOpen: Boolean(shadow.querySelector(OTHER_OVERLAYS)),
      typing: isTypingIn(deepActiveElement()),
    });
    if (state.ok) {
      show();
      return;
    }
    tries += 1;
    if (tries < MAX_TRIES) schedule(RETRY_MS); // else: it will try again on the next page load
  }

  async function maybeShow() {
    let stored;
    try {
      stored = await chrome.storage.local.get([WELCOMED_KEY, SEEN_KEY]);
    } catch {
      return; // no storage (extension reloaded): do not nag
    }
    const decision = decideWhatsNew({ welcomed: Boolean(stored?.[WELCOMED_KEY]), seenVersion: stored?.[SEEN_KEY], currentVersion: version() });
    if (decision.action === 'mark') remember(); // new here: the first-run card covers this
    else if (decision.action === 'show') schedule(delayMs);
  }

  return { show, hide, maybeShow };
}
