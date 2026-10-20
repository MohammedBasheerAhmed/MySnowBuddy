// What the AI calls cost and what is allowed to be spent. Pure: no chrome.* and no network, so it is unit-tested
// (tests/aiusage.test.js). The service worker (src/providers/budget.js) feeds it the stored log, prices and caps.
//
// Design (the GMG agent's, adapted to a browser extension): every model call is logged; cost is tokens x the price per
// million that the USER entered (no vendor prices are built in, so cost shows "set prices" until they are); caps are
// per day and per month in the user's own time zone, warn from 80% and refuse at 100%. Caps for calls and tokens work
// without any prices.

export const USAGE_KEY = 'mysnowbuddy_ai_usage';
export const PRICES_KEY = 'mysnowbuddy_ai_prices';
export const CAPS_KEY = 'mysnowbuddy_ai_caps';
export const LOG_LIMIT = 500;
export const WARN_AT = 0.8;
export const DEFAULT_CACHE_READ_MULT = 0.1;
export const DEFAULT_CACHE_WRITE_MULT = 1.25;
export const DEFAULT_HISTORY_DAYS = 30;

// --- Endpoints --------------------------------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Check a base URL typed by the user. https only, except http to this machine (Ollama, LM Studio); no user:password@,
 * no query string or fragment; a trailing slash is dropped. An empty string means "use the provider's own endpoint".
 * @returns {{ ok: boolean, url: string, host: string, origin: string, local: boolean, error?: string }}
 */
export function validateBaseUrl(input) {
  const text = String(input ?? '').trim();
  const empty = { ok: true, url: '', host: '', origin: '', local: false };
  if (!text) return empty;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ...empty, ok: false, error: 'That is not a web address. Start with https://' };
  }
  const local = LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    return { ...empty, ok: false, error: 'Use https://. Plain http:// is only allowed for localhost or 127.0.0.1.' };
  }
  if (parsed.username || parsed.password) return { ...empty, ok: false, error: 'Do not put a user name or password in the address. The key goes in the key field.' };
  if (parsed.search || parsed.hash || /[?#]/.test(text)) return { ...empty, ok: false, error: 'Leave off the ?query and #fragment.' };
  const path = parsed.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${parsed.origin}${path}`, host: parsed.host, origin: parsed.origin, local };
}

/** `<base>/chat/completions` for OpenAI-compatible servers. */
export const chatCompletionsUrl = (base) => `${base}/chat/completions`;

/** `<base>/messages` for an Anthropic-compatible proxy (the base already ends in /v1 for the real API). */
export const anthropicMessagesUrl = (base) => `${base}/messages`;

/** The match pattern Chrome asks permission for: any port on that host. */
export function originPattern(url) {
  const checked = validateBaseUrl(url);
  if (!checked.ok || !checked.url) return '';
  const parsed = new URL(checked.url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

// --- Cost -------------------------------------------------------------------------------------------------------

const num = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);

/** A model's price as the user entered it, or null when no price is set. */
export function normalizePrice(price) {
  if (!price || typeof price !== 'object') return null;
  const inPerM = num(price.inPerM);
  const outPerM = num(price.outPerM);
  if (!inPerM && !outPerM) return null;
  return {
    inPerM,
    outPerM,
    cacheReadMult: price.cacheReadMult === '' || price.cacheReadMult == null || !Number.isFinite(Number(price.cacheReadMult)) ? DEFAULT_CACHE_READ_MULT : Math.max(0, Number(price.cacheReadMult)),
    cacheWriteMult: price.cacheWriteMult === '' || price.cacheWriteMult == null || !Number.isFinite(Number(price.cacheWriteMult)) ? DEFAULT_CACHE_WRITE_MULT : Math.max(0, Number(price.cacheWriteMult)),
  };
}

export const priceKey = (provider, model) => `${provider}:${model}`;

/**
 * Estimated cost in USD of one call, or null while the model has no price.
 * `input` is the tokens NOT served from the cache; cache reads/writes are priced as a multiple of the input price.
 */
export function costOf(usage, price) {
  const p = normalizePrice(price);
  if (!p) return null;
  const u = usage || {};
  const input = num(u.input);
  const output = num(u.output);
  const read = num(u.cacheRead);
  const write = num(u.cacheWrite);
  return (input * p.inPerM + output * p.outPerM + read * p.inPerM * p.cacheReadMult + write * p.inPerM * p.cacheWriteMult) / 1e6;
}

export const totalTokens = (entry) => num(entry?.inputTokens) + num(entry?.outputTokens) + num(entry?.cacheRead) + num(entry?.cacheWrite);

// --- The log ----------------------------------------------------------------------------------------------------

/** { time, provider, model, ms, inputTokens, outputTokens, cacheRead, cacheWrite, costUsd | null, host, kind } */
export function makeEntry({ now = new Date(), provider, model, ms = 0, usage = {}, price = null, host = '', kind = 'chat' } = {}) {
  return {
    time: new Date(now).toISOString(),
    provider: String(provider || ''),
    model: String(model || ''),
    ms: Math.max(0, Math.round(ms)),
    inputTokens: num(usage.input),
    outputTokens: num(usage.output),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
    costUsd: costOf(usage, price),
    host: String(host || ''),
    kind: ['chat', 'agent', 'validate'].includes(kind) ? kind : 'chat',
  };
}

/** Append, keeping only the newest `limit` entries (the buffer is stored oldest first). */
export function appendEntry(log, entry, limit = LOG_LIMIT) {
  const list = Array.isArray(log) ? log : [];
  const next = [...list, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

// --- Day and month windows (the user's own time zone) -------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const monthKey = (date) => dayKey(date).slice(0, 7);

function sum(entries) {
  let calls = 0;
  let tokens = 0;
  let cost = 0;
  let priced = 0;
  entries.forEach((e) => {
    calls += 1;
    tokens += totalTokens(e);
    if (typeof e.costUsd === 'number') {
      cost += e.costUsd;
      priced += 1;
    }
  });
  // `complete` is false when some calls had no price, so the cost is a lower bound.
  return { calls, tokens, cost, priced, complete: priced === entries.length };
}

/** Everything the Usage view and the chip need. Validation pings do not count against caps but are listed. */
export function summarize(log, now = new Date()) {
  const list = (Array.isArray(log) ? log : []).filter((e) => e && e.time);
  const today = dayKey(now);
  const month = monthKey(now);
  const inDay = list.filter((e) => dayKey(e.time) === today);
  const inMonth = list.filter((e) => monthKey(e.time) === month);
  const byModel = new Map();
  inMonth.forEach((e) => {
    const key = priceKey(e.provider, e.model);
    if (!byModel.has(key)) byModel.set(key, { provider: e.provider, model: e.model, entries: [] });
    byModel.get(key).entries.push(e);
  });
  return {
    today: sum(inDay),
    month: sum(inMonth),
    models: [...byModel.values()].map(({ provider, model, entries }) => ({ provider, model, ...sum(entries) })).sort((a, b) => b.calls - a.calls),
    recent: [...list].reverse().slice(0, 25),
  };
}

// --- Caps ---------------------------------------------------------------------------------------------------------

/**
 * caps: { anthropic: { dailyUsd, monthlyUsd }, openai: { dailyUsd, monthlyUsd }, dailyCalls, dailyTokens } - 0 means no cap.
 * Anything missing or not a positive number is "no cap".
 */
export function normalizeCaps(caps) {
  const c = caps && typeof caps === 'object' ? caps : {};
  const perProvider = (p) => ({ dailyUsd: num(c[p]?.dailyUsd), monthlyUsd: num(c[p]?.monthlyUsd) });
  return { anthropic: perProvider('anthropic'), openai: perProvider('openai'), dailyCalls: Math.floor(num(c.dailyCalls)), dailyTokens: Math.floor(num(c.dailyTokens)) };
}

const PROVIDER_LABEL = { anthropic: 'Anthropic', openai: 'OpenAI-compatible' };
const money = (n) => `$${n.toFixed(n >= 100 ? 0 : 2)}`;
const where = 'NowBuddy options > Usage';

/**
 * Where the spend stands against every cap that applies to a call to `provider`.
 * @returns {{ status: 'ok' | 'warn' | 'blocked', items: Array, worst: object | null, message: string }}
 */
export function checkCaps(log, capsInput, provider, now = new Date()) {
  const caps = normalizeCaps(capsInput);
  // Pings that only validate a key never count; they should not lock anybody out of fixing their key.
  const list = (Array.isArray(log) ? log : []).filter((e) => e && e.time && e.kind !== 'validate');
  const today = dayKey(now);
  const month = monthKey(now);
  const mine = list.filter((e) => e.provider === provider);
  const items = [];
  const add = (name, used, limit, format, period) => {
    if (!limit) return;
    items.push({ name, used, limit, pct: used / limit, format, period });
  };
  const usd = (entries) => entries.reduce((total, e) => total + (typeof e.costUsd === 'number' ? e.costUsd : 0), 0);
  const label = PROVIDER_LABEL[provider] || provider;
  add(`${label} daily spend`, usd(mine.filter((e) => dayKey(e.time) === today)), caps[provider]?.dailyUsd, (n) => money(n), 'day');
  add(`${label} monthly spend`, usd(mine.filter((e) => monthKey(e.time) === month)), caps[provider]?.monthlyUsd, (n) => money(n), 'month');
  const todayAll = list.filter((e) => dayKey(e.time) === today);
  add('Daily calls', todayAll.length, caps.dailyCalls, (n) => `${Math.round(n)} calls`, 'day');
  add('Daily tokens', todayAll.reduce((total, e) => total + totalTokens(e), 0), caps.dailyTokens, (n) => `${Math.round(n).toLocaleString('en-US')} tokens`, 'day');

  const worst = items.length ? [...items].sort((a, b) => b.pct - a.pct)[0] : null;
  const status = !worst ? 'ok' : worst.pct >= 1 ? 'blocked' : worst.pct >= WARN_AT ? 'warn' : 'ok';
  let message = '';
  if (status === 'blocked') {
    message = `${worst.name} cap reached (${worst.format(worst.used)} of ${worst.format(worst.limit)}). It resets at the start of the next ${worst.period}, or raise the cap in ${where}.`;
  } else if (status === 'warn') {
    message = `${worst.name}: ${Math.round(worst.pct * 100)}% of the ${worst.format(worst.limit)} cap used.`;
  }
  return { status, items, worst, message };
}

// --- CSV ----------------------------------------------------------------------------------------------------------

const csvCell = (value) => {
  const text = value == null ? '' : String(value);
  // A leading = + - @ would be run as a formula by a spreadsheet; the log only holds our own fields, but be safe.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function logToCsv(log) {
  const header = ['time', 'provider', 'model', 'kind', 'ms', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'cost_usd', 'instance'];
  const rows = (Array.isArray(log) ? log : []).map((e) => [e.time, e.provider, e.model, e.kind, e.ms, e.inputTokens, e.outputTokens, e.cacheRead, e.cacheWrite, e.costUsd == null ? '' : e.costUsd.toFixed(6), e.host]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

// --- Chat history retention ---------------------------------------------------------------------------------------

/** days: 0 keeps nothing after the page closes; otherwise history older than `days` is dropped on load. */
export function historyExpired(savedAt, days, now = Date.now()) {
  const keep = Number.isFinite(Number(days)) ? Math.max(0, Math.floor(Number(days))) : DEFAULT_HISTORY_DAYS;
  if (keep === 0) return true;
  const saved = Number(savedAt);
  if (!Number.isFinite(saved) || saved <= 0) return false; // history from before retention existed: keep, then stamp it
  return now - saved > keep * 86400000;
}

export function normalizeHistoryDays(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(365, Math.floor(n)) : DEFAULT_HISTORY_DAYS;
}

// --- The small chip in the chat header ---------------------------------------------------------------------------

/**
 * What the sidebar header shows: "12 calls today · $0.42" (cost only once prices exist), turning into a warning from
 * 80% of a cap and an error at 100%. Hidden until there is something to say.
 * @returns {{ show: boolean, status: 'ok' | 'warn' | 'blocked', text: string, title: string }}
 */
export function usageChip(log, caps, provider, now = new Date()) {
  const { today } = summarize(log, now);
  const check = checkCaps(log, caps, provider, now);
  const quiet = { show: false, status: 'ok', text: '', title: '' };
  if (check.status === 'blocked') return { show: true, status: 'blocked', text: 'Limit reached', title: check.message };
  if (check.status === 'warn') return { show: true, status: 'warn', text: 'Near limit', title: check.message };
  const real = (Array.isArray(log) ? log : []).some((e) => e && e.kind !== 'validate' && dayKey(e.time) === dayKey(now));
  if (!real || !today.calls) return quiet;
  const cost = today.priced ? ` · ${today.complete ? '' : '≥'}$${today.cost.toFixed(2)}` : '';
  return { show: true, status: 'ok', text: `${today.calls} call${today.calls === 1 ? '' : 's'} today${cost}`, title: 'AI calls today. Open the options page for usage, prices and limits.' };
}
