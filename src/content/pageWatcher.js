// Notices when the page on screen changes (classic and Next Experience navigate
// without a full reload), so features can react to the new table/record.

import { currentPageHref } from './context.js';

const POLL_MS = 2500;

export function createPageWatcher(getContext) {
  const listeners = new Set();
  let lastKey = null;

  function check() {
    const ctx = getContext();
    const key = `${currentPageHref()}|${ctx.table}|${ctx.sysId}`;
    if (key === lastKey) return;
    lastKey = key;
    listeners.forEach((fn) => {
      try {
        fn(ctx);
      } catch (err) {
        console.error('[MySnowBuddy] page watcher listener failed', err);
      }
    });
  }

  setInterval(check, POLL_MS);
  check();

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
