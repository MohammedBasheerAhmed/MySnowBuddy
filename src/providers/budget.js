// Storage side of AI usage and spend caps (the arithmetic is in src/lib/aiUsage.js). Runs in the service worker, which
// is the only place model calls are made. Everything here fails soft: a storage problem must never stop a chat, so only
// a cap that is really reached refuses a call.
import { USAGE_KEY, PRICES_KEY, CAPS_KEY, appendEntry, makeEntry, checkCaps, priceKey } from '../lib/aiUsage.js';

const hasStorage = () => typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);

// The worker handles several calls at once; writes go through one queue so none overwrites another's entry.
let queue = Promise.resolve();

/** { log, prices, caps } as stored. */
export async function readBudgetState() {
  if (!hasStorage()) return { log: [], prices: {}, caps: {} };
  const stored = await chrome.storage.local.get([USAGE_KEY, PRICES_KEY, CAPS_KEY]);
  return { log: Array.isArray(stored[USAGE_KEY]) ? stored[USAGE_KEY] : [], prices: stored[PRICES_KEY] || {}, caps: stored[CAPS_KEY] || {} };
}

/** Throws a plain message when a cap for this provider is reached; returns the check (so callers can see "warn"). */
export async function assertWithinCaps(provider, now = new Date()) {
  let state;
  try {
    state = await readBudgetState();
  } catch {
    return { status: 'ok', items: [], worst: null, message: '' };
  }
  const result = checkCaps(state.log, state.caps, provider, now);
  if (result.status === 'blocked') throw new Error(result.message);
  return result;
}

/** Log one finished call. Never throws. */
export function recordCall({ provider, model, ms, usage, host, kind, now = new Date() }) {
  if (!hasStorage()) return Promise.resolve();
  queue = queue
    .then(async () => {
      const { log, prices } = await readBudgetState();
      const entry = makeEntry({ now, provider, model, ms, usage, price: prices[priceKey(provider, model)], host, kind });
      await chrome.storage.local.set({ [USAGE_KEY]: appendEntry(log, entry) });
    })
    .catch(() => {});
  return queue;
}
