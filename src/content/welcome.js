// First-run welcome: one small card that says what is on the page and how to start, shown once.
// "Quick tour" in the command palette shows it again.
//
// Plain words on purpose: this is the only explanation a new user gets without opening Options.

import { trustedDom } from '../sidebar/trusted.js';

const STORAGE_KEY = 'mysnowbuddy_welcomed';
const SHOW_AFTER_MS = 2500;

const isMac = () => /mac/i.test(navigator.platform || navigator.userAgent || '');

/** The palette shortcut as the user's keyboard writes it. Chrome lets people rebind it, so the card says where to look. */
export const paletteShortcut = () => (isMac() ? '⌃⇧Space' : 'Ctrl+Shift+Space');

/** What the card tells a developer, in the order they will need it. Exported so the text can be reviewed and tested. */
export function tourSteps() {
  return [
    {
      key: paletteShortcut(),
      title: 'Search everything',
      text: 'Type what you want to do: "who changed this", a table name, a sys_id, or /tn incident. Alt+P pins what you use most.',
    },
    {
      key: 'The bar at the bottom',
      title: 'This page’s quick actions',
      text: 'Copy the sys_id, see who changed it, check versions, lint the script or edit it right over its field. On a list: explain the filter, count, copy the query. Names shows every field name.',
    },
    {
      key: 'Hover a label, then ⋯',
      title: 'Know any field',
      text: 'Copy its name, open its dictionary entry or ACLs, X-ray what controls it. Double-click a label to copy its name. Select a sys_id anywhere to peek at that record.',
    },
    {
      key: 'Tools open as windows',
      title: 'Drag them, stack them, dock them',
      text: 'Code search, REST builder, script runner and more float over the page. The dock button in a window’s title bar moves it into the sidebar.',
    },
  ];
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {{ shadow: ShadowRoot, openPalette: () => void }} deps
 * @returns {{ show: () => void, hide: () => void, maybeShow: () => Promise<void> }}
 */
export function createWelcome({ shadow, openPalette, openGuide }) {
  let card = null;
  let opener = null; // what had focus before the card opened, so closing it does not strand a keyboard user
  let timer = null;

  function build() {
    const root = el('section', 'msb-welcome');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Getting started with NowBuddy');

    root.appendChild(el('div', 'msb-welcome__line'));
    const head = el('div', 'msb-welcome__head');
    const titles = el('div', 'msb-welcome__titles');
    titles.append(el('div', 'msb-welcome__title', 'NowBuddy is on this page'), el('div', 'msb-welcome__sub', 'Four things worth knowing'));
    const close = el('button', 'msb-welcome__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', trustedDom(() => hide(true)));
    head.append(titles, close);
    root.appendChild(head);

    const list = el('ol', 'msb-welcome__steps');
    tourSteps().forEach((step) => {
      const item = el('li', 'msb-welcome__step');
      item.append(el('kbd', 'msb-welcome__key', step.key), el('div', 'msb-welcome__stepTitle', step.title), el('div', 'msb-welcome__stepText', step.text));
      list.appendChild(item);
    });
    root.appendChild(list);

    const actions = el('div', 'msb-welcome__actions');
    const open = el('button', 'msb-btn msb-btn--sm msb-btn--primary', 'Open the palette');
    open.type = 'button';
    open.addEventListener(
      'click',
      trustedDom(() => {
        hide(true);
        openPalette();
      })
    );
    const guideBtn = el('button', 'msb-btn msb-btn--sm', 'Everything it can do');
    guideBtn.type = 'button';
    guideBtn.addEventListener(
      'click',
      trustedDom(() => {
        hide(true);
        openGuide?.();
      })
    );
    const done = el('button', 'msb-btn msb-btn--sm', 'Got it');
    done.type = 'button';
    done.addEventListener('click', trustedDom(() => hide(true)));
    actions.append(open);
    if (openGuide) actions.append(guideBtn);
    actions.append(done);
    root.appendChild(actions);

    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && event.isTrusted) hide(true);
    });
    return { root, open };
  }

  function show() {
    if (card) return;
    opener = document.activeElement;
    const built = build();
    card = built.root;
    shadow.appendChild(card);
    built.open.focus({ preventScroll: true });
  }

  function hide(remember = false) {
    clearTimeout(timer);
    card?.remove();
    card = null;
    if (opener?.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    opener = null;
    if (remember) chrome.storage.local.set({ [STORAGE_KEY]: true }).catch?.(() => {});
  }

  async function maybeShow() {
    let seen = true;
    try {
      seen = Boolean((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]);
    } catch {
      return; // no storage (extension reloaded): do not nag
    }
    if (seen) return;
    timer = setTimeout(() => {
      if (!document.hidden) show();
    }, SHOW_AFTER_MS);
  }

  return { show, hide, maybeShow };
}
