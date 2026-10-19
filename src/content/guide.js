// Developer guide: one card that answers "what can I do here?" by job, with the page on screen first.
// Every line is a button that opens the palette with that phrase typed in, so reading the guide is also a first try.
// Opened from the palette ("Developer guide") and from the first-run card.

import { trustedDom } from '../sidebar/trusted.js';
import { GUIDE_JOBS, JOB_FOR_PAGE, PAGE_NOUN, guideShortcuts } from '../lib/guideContent.js';
import { pageKind } from '../lib/paletteContext.js';
import { paletteShortcut } from './welcome.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Jobs in display order: the one that suits this kind of page first. */
export function orderedJobs(kind) {
  const first = JOB_FOR_PAGE[kind] || JOB_FOR_PAGE.other;
  return [...GUIDE_JOBS.filter((job) => job.title === first), ...GUIDE_JOBS.filter((job) => job.title !== first)];
}

/**
 * @param {{ shadow: ShadowRoot, openPalette: (prefill?: string) => void, getContext: () => object, showTour: () => void }} deps
 * @returns {{ show: () => void, hide: () => void }}
 */
export function createGuide({ shadow, openPalette, getContext, showTour }) {
  let card = null;
  let opener = null; // what had focus before the card opened, so closing it does not strand a keyboard user

  function build() {
    let ctx = {};
    try {
      ctx = getContext() || {};
    } catch {
      ctx = {};
    }
    const kind = pageKind(ctx);

    const root = el('section', 'msb-guide');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Developer guide');
    root.appendChild(el('div', 'msb-guide__line'));

    const head = el('div', 'msb-guide__head');
    const titles = el('div', 'msb-guide__titles');
    titles.append(
      el('div', 'msb-guide__title', 'What can I do here?'),
      el('div', 'msb-guide__sub', `You are on ${PAGE_NOUN[kind] || PAGE_NOUN.other}${ctx.table ? ` (${ctx.table})` : ''}. Click a line to try it.`)
    );
    const close = el('button', 'msb-guide__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', trustedDom(() => hide()));
    head.append(titles, close);
    root.appendChild(head);

    const body = el('div', 'msb-guide__body');
    const jobs = orderedJobs(kind);
    jobs.forEach((job, index) => {
      const section = el('section', 'msb-guide__job');
      const heading = el('h3', 'msb-guide__jobTitle', job.title);
      if (index === 0) heading.appendChild(el('span', 'msb-guide__tag', 'for this page'));
      section.appendChild(heading);
      job.items.forEach((item) => {
        const row = el('button', 'msb-guide__item');
        row.type = 'button';
        row.append(el('span', 'msb-guide__say', item.say), el('span', 'msb-guide__what', item.what));
        row.addEventListener(
          'click',
          trustedDom(() => {
            hide();
            openPalette('prefill' in item ? item.prefill : item.say);
          })
        );
        section.appendChild(row);
      });
      body.appendChild(section);
    });

    const keys = el('section', 'msb-guide__job');
    keys.appendChild(el('h3', 'msb-guide__jobTitle', 'Keys worth learning'));
    const keyList = el('div', 'msb-guide__keys');
    guideShortcuts(paletteShortcut()).forEach(([combo, what]) => {
      keyList.append(el('kbd', 'msb-guide__kbd', combo), el('span', 'msb-guide__keyText', what));
    });
    keys.appendChild(keyList);
    body.appendChild(keys);
    root.appendChild(body);

    const actions = el('div', 'msb-guide__actions');
    const tour = el('button', 'msb-btn msb-btn--sm', 'Replay the quick tour');
    tour.type = 'button';
    tour.addEventListener(
      'click',
      trustedDom(() => {
        hide();
        showTour();
      })
    );
    const done = el('button', 'msb-btn msb-btn--sm msb-btn--primary', 'Close');
    done.type = 'button';
    done.addEventListener('click', trustedDom(() => hide()));
    actions.append(tour, done);
    root.appendChild(actions);

    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && event.isTrusted) hide();
    });
    return { root, focus: done };
  }

  function show() {
    if (card) hide();
    opener = document.activeElement;
    const built = build();
    card = built.root;
    shadow.appendChild(card);
    built.focus.focus({ preventScroll: true });
  }

  function hide() {
    card?.remove();
    card = null;
    if (opener?.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    opener = null;
  }

  return { show, hide };
}
