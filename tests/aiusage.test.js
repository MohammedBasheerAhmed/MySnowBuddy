const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateBaseUrl,
  chatCompletionsUrl,
  anthropicMessagesUrl,
  originPattern,
  normalizePrice,
  costOf,
  makeEntry,
  appendEntry,
  dayKey,
  monthKey,
  summarize,
  checkCaps,
  normalizeCaps,
  logToCsv,
  historyExpired,
  normalizeHistoryDays,
  LOG_LIMIT,
} = require('../src/lib/aiUsage.js');
const { applyCacheControl, fromOpenAIResponse, fromAnthropicResponse } = require('../src/providers/messages.js');

test('a base URL is accepted only when it is safe to send prompts to', () => {
  const ok = (input, url) => {
    const r = validateBaseUrl(input);
    assert.equal(r.ok, true, input);
    assert.equal(r.url, url, input);
  };
  ok('', '');
  ok('   ', '');
  ok('https://api.x.ai/v1', 'https://api.x.ai/v1');
  ok('https://api.x.ai/v1/', 'https://api.x.ai/v1');
  ok('https://openrouter.ai/api/v1///', 'https://openrouter.ai/api/v1');
  ok('https://my-gateway.example.com', 'https://my-gateway.example.com');
  ok('http://localhost:11434/v1', 'http://localhost:11434/v1');
  ok('http://127.0.0.1:1234/v1/', 'http://127.0.0.1:1234/v1');
  assert.equal(validateBaseUrl('http://localhost:11434/v1').local, true);
  assert.equal(validateBaseUrl('https://api.x.ai/v1').local, false);
  [
    ['http://api.x.ai/v1', /https/],
    ['http://192.168.1.5:11434/v1', /https/],
    ['ftp://api.x.ai/v1', /https/],
    ['https://user:pass@api.x.ai/v1', /user name/],
    ['https://user@api.x.ai/v1', /user name/],
    ['https://api.x.ai/v1?key=1', /query/],
    ['https://api.x.ai/v1#frag', /query/],
    ['https://api.x.ai/v1?', /query/],
    ['api.x.ai/v1', /web address/],
    ['not a url', /web address/],
    ['javascript:alert(1)', /https|web address/],
  ].forEach(([input, message]) => {
    const r = validateBaseUrl(input);
    assert.equal(r.ok, false, input);
    assert.match(r.error, message, input);
  });
  assert.equal(chatCompletionsUrl('https://api.x.ai/v1'), 'https://api.x.ai/v1/chat/completions');
  assert.equal(anthropicMessagesUrl('https://proxy.example.com/v1'), 'https://proxy.example.com/v1/messages');
  assert.equal(originPattern('https://api.x.ai/v1'), 'https://api.x.ai/*');
  assert.equal(originPattern('http://localhost:11434/v1'), 'http://localhost/*', 'permissions are per host, any port');
  assert.equal(originPattern('http://evil.example/v1'), '');
  assert.equal(originPattern(''), '');
});

test('cost is tokens x the price the user entered, with cache multipliers, and unknown until priced', () => {
  const price = { inPerM: 3, outPerM: 15 };
  assert.equal(costOf({ input: 1_000_000, output: 0 }, price), 3);
  assert.equal(costOf({ input: 0, output: 1_000_000 }, price), 15);
  assert.ok(Math.abs(costOf({ input: 1000, output: 500 }, price) - (0.003 + 0.0075)) < 1e-12);
  // Cache reads cost 0.1x and writes 1.25x of the input price unless the user changed them.
  assert.ok(Math.abs(costOf({ cacheRead: 1_000_000 }, price) - 0.3) < 1e-9);
  assert.ok(Math.abs(costOf({ cacheWrite: 1_000_000 }, price) - 3.75) < 1e-9);
  assert.ok(Math.abs(costOf({ cacheRead: 1_000_000, cacheWrite: 1_000_000 }, { ...price, cacheReadMult: 0.5, cacheWriteMult: 2 }) - (1.5 + 6)) < 1e-9);
  assert.equal(costOf({ input: 1000 }, null), null, 'no price, no cost: nothing is invented');
  assert.equal(costOf({ input: 1000 }, {}), null);
  assert.equal(costOf({ input: 1000 }, { inPerM: 0, outPerM: 0 }), null);
  assert.equal(costOf({ input: 1000 }, { inPerM: 'abc' }), null);
  assert.equal(costOf({}, price), 0);
  assert.deepEqual(normalizePrice({ inPerM: '3', outPerM: '15', cacheReadMult: '' }), { inPerM: 3, outPerM: 15, cacheReadMult: 0.1, cacheWriteMult: 1.25 });
});

test('the log keeps only the newest 500 entries, oldest first', () => {
  let log = [];
  for (let i = 0; i < LOG_LIMIT + 25; i += 1) log = appendEntry(log, makeEntry({ now: new Date(2026, 9, 20, 10, 0, i % 60), provider: 'anthropic', model: `m${i}` }));
  assert.equal(log.length, LOG_LIMIT);
  assert.equal(log[0].model, 'm25');
  assert.equal(log[LOG_LIMIT - 1].model, `m${LOG_LIMIT + 24}`);
  assert.deepEqual(appendEntry(undefined, { a: 1 }), [{ a: 1 }]);
  assert.equal(makeEntry({ kind: 'weird' }).kind, 'chat');
  const entry = makeEntry({ now: new Date(2026, 9, 20, 9, 5, 0), provider: 'openai', model: 'grok', ms: 1234.6, usage: { input: 10, output: 5, cacheRead: 3 }, price: { inPerM: 1, outPerM: 2 }, host: 'dev1.service-now.com', kind: 'agent' });
  assert.equal(entry.ms, 1235);
  assert.equal(entry.costUsd, (10 + 10 + 0.3) / 1e6);
  assert.equal(entry.kind, 'agent');
});

test('days and months roll over in the local time zone', () => {
  const at = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi, 0);
  assert.equal(dayKey(at(2026, 10, 20, 23, 59)), '2026-10-20');
  assert.equal(dayKey(at(2026, 10, 21, 0, 0)), '2026-10-21');
  assert.equal(monthKey(at(2026, 10, 31, 23, 59)), '2026-10');
  assert.equal(monthKey(at(2026, 11, 1, 0, 0)), '2026-11');
  const priced = (when, cost, tokens = 100) => ({ ...makeEntry({ now: when, provider: 'anthropic', model: 'a', usage: { input: tokens } }), costUsd: cost });
  const log = [priced(at(2026, 9, 30, 23, 59), 1), priced(at(2026, 10, 20, 0, 1), 2), priced(at(2026, 10, 20, 23, 58), 3), { ...priced(at(2026, 10, 20, 12), 0), costUsd: null }];
  const s = summarize(log, at(2026, 10, 20, 15));
  assert.equal(s.today.calls, 3);
  assert.equal(s.today.cost, 5);
  assert.equal(s.today.complete, false, 'one call had no price, so the cost is a lower bound');
  assert.equal(s.month.calls, 3);
  assert.equal(s.month.cost, 5);
  assert.equal(summarize(log, at(2026, 10, 21, 0, 5)).today.calls, 0, 'after midnight the day starts again');
  assert.equal(summarize(log, at(2026, 11, 1, 0, 5)).month.calls, 0, 'on the 1st the month starts again');
  assert.equal(summarize(log, at(2026, 10, 20)).recent[0].costUsd, null, 'newest first');
  assert.equal(summarize([], at(2026, 10, 20)).today.complete, true);
});

test('caps warn from 80% and block at 100%, per provider, and reset by themselves', () => {
  const now = new Date(2026, 10, 3, 14, 0, 0); // 2026-11-03
  const call = (when, cost, provider = 'anthropic', kind = 'chat', tokens = 100) => ({ ...makeEntry({ now: when, provider, model: 'm', usage: { input: tokens }, kind }), costUsd: cost });
  const caps = { anthropic: { dailyUsd: 10, monthlyUsd: 100 }, dailyCalls: 0, dailyTokens: 0 };
  const status = (spent) => checkCaps([call(now, spent)], caps, 'anthropic', now);
  assert.equal(status(7.9).status, 'ok');
  assert.equal(status(7.99).status, 'ok', 'just under 80%');
  assert.equal(status(8).status, 'warn', '80% exactly warns');
  assert.equal(status(9.99).status, 'warn');
  assert.equal(status(10).status, 'blocked', '100% blocks');
  const blocked = status(12);
  assert.match(blocked.message, /Anthropic daily spend cap reached/);
  assert.match(blocked.message, /NowBuddy options > Usage/);
  assert.match(blocked.message, /next day/);
  // The other provider is not affected by the first one's spend.
  assert.equal(checkCaps([call(now, 50)], caps, 'openai', now).status, 'ok');
  // Yesterday's spend does not count towards today's cap, and a validation ping never counts.
  const yesterday = new Date(2026, 10, 2, 22, 0, 0);
  assert.equal(checkCaps([call(yesterday, 50)], caps, 'anthropic', now).status, 'ok');
  assert.equal(checkCaps([call(now, 50, 'anthropic', 'validate')], caps, 'anthropic', now).status, 'ok');
  // The month cap sums every day of the month.
  const monthly = [call(new Date(2026, 10, 1), 60), call(new Date(2026, 10, 2), 40)];
  const m = checkCaps(monthly, caps, 'anthropic', now);
  assert.equal(m.status, 'blocked');
  assert.match(m.message, /monthly spend/);
  assert.match(m.message, /next month/);
  assert.equal(checkCaps(monthly, caps, 'anthropic', new Date(2026, 11, 1)).status, 'ok', 'December starts clean');
  // Call and token caps work with no prices at all.
  const free = (n) => Array.from({ length: n }, () => ({ ...makeEntry({ now, provider: 'openai', model: 'm', usage: { input: 1000, output: 500 } }), costUsd: null }));
  assert.equal(checkCaps(free(3), { dailyCalls: 4 }, 'openai', now).status, 'ok');
  assert.equal(checkCaps(free(4), { dailyCalls: 5 }, 'openai', now).status, 'warn', '4 of 5 is 80%');
  assert.equal(checkCaps(free(4), { dailyCalls: 4 }, 'openai', now).status, 'blocked', 'the 4th call used the cap up, so the 5th is refused');
});

test('caps: 90% of a token cap warns, zero or junk means no cap', () => {
  const now = new Date(2026, 10, 3, 14, 0, 0);
  const free = (n) => Array.from({ length: n }, () => ({ ...makeEntry({ now, provider: 'openai', model: 'm', usage: { input: 1000, output: 500 } }), costUsd: null }));
  assert.equal(checkCaps(free(3), { dailyTokens: 5000 }, 'openai', now).status, 'warn');
  assert.equal(checkCaps(free(3), { dailyTokens: 4501 }, 'openai', now).status, 'warn');
  assert.equal(checkCaps(free(3), { dailyTokens: 4500 }, 'openai', now).status, 'blocked');
  assert.equal(checkCaps(free(99), {}, 'openai', now).status, 'ok');
  assert.deepEqual(normalizeCaps({ anthropic: { dailyUsd: -5, monthlyUsd: 'x' }, dailyCalls: 2.9, dailyTokens: '100' }), { anthropic: { dailyUsd: 0, monthlyUsd: 0 }, openai: { dailyUsd: 0, monthlyUsd: 0 }, dailyCalls: 2, dailyTokens: 100 });
  assert.equal(checkCaps(null, null, 'openai', now).status, 'ok');
  assert.equal(checkCaps(free(3), { dailyCalls: 3 }, 'openai', now).worst.name, 'Daily calls');
});

test('the CSV export quotes cells and defuses spreadsheet formulas', () => {
  const log = [{ ...makeEntry({ now: new Date(2026, 9, 20, 9, 0, 0), provider: 'openai', model: '=cmd|"x"', usage: { input: 5 }, host: 'a,b.service-now.com' }), costUsd: 0.5 }];
  const csv = logToCsv(log);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^time,provider,model,kind,ms,input_tokens/);
  assert.match(lines[1], /"'=cmd\|""x"""/);
  assert.match(lines[1], /"a,b.service-now.com"/);
  assert.match(lines[1], /0\.500000/);
});

test('chat history is dropped after the retention days, and 0 keeps nothing', () => {
  const day = 86400000;
  const now = Date.now();
  assert.equal(historyExpired(now - 2 * day, 30, now), false);
  assert.equal(historyExpired(now - 31 * day, 30, now), true);
  assert.equal(historyExpired(now - 1000, 0, now), true, '0 days: nothing survives a page load');
  assert.equal(historyExpired(undefined, 30, now), false, 'history saved before retention existed is kept, then stamped');
  assert.equal(normalizeHistoryDays(undefined), 30);
  assert.equal(normalizeHistoryDays('7'), 7);
  assert.equal(normalizeHistoryDays(-3), 30);
  assert.equal(normalizeHistoryDays(9999), 365);
  assert.equal(normalizeHistoryDays(0), 0);
});

test('prompt caching marks the stable prefix and does not touch the original request', () => {
  const body = {
    model: 'm',
    system: 'You are NowBuddy.',
    tools: [{ name: 'a', input_schema: {} }, { name: 'b', input_schema: {} }],
    messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }],
  };
  const snapshot = JSON.stringify(body);
  const out = applyCacheControl(body);
  assert.equal(JSON.stringify(body), snapshot, 'the input is not mutated');
  assert.deepEqual(out.system, [{ type: 'text', text: 'You are NowBuddy.', cache_control: { type: 'ephemeral' } }]);
  assert.equal(out.tools[0].cache_control, undefined);
  assert.deepEqual(out.tools[1].cache_control, { type: 'ephemeral' });
  assert.deepEqual(out.messages[2].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(out.messages[0].content, 'hello', 'earlier turns are left alone');
  const breakpoints = JSON.stringify(out).match(/cache_control/g).length;
  assert.equal(breakpoints, 3, 'the API allows four; three are used');
  // A string last message becomes one cached text block; a trailing thinking block cannot carry the mark.
  assert.deepEqual(applyCacheControl({ messages: [{ role: 'user', content: 'x' }] }).messages[0].content, [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }]);
  const thinking = applyCacheControl({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 't' }] }] });
  assert.equal(JSON.stringify(thinking).includes('cache_control'), false);
  assert.deepEqual(applyCacheControl({}), {});
});

test('cached tokens are read from both vendors and kept apart from fresh input', () => {
  const openai = fromOpenAIResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } } });
  assert.deepEqual(openai.usage, { input: 200, output: 50, cacheRead: 800, cacheWrite: 0 });
  const plain = fromOpenAIResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  assert.deepEqual(plain.usage, { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
  const anthropic = fromAnthropicResponse({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 } });
  assert.deepEqual(anthropic.usage, { input: 5, output: 7, cacheRead: 900, cacheWrite: 100 });
});

test('a custom endpoint is called at <base>/chat/completions, with a key only when there is one', async () => {
  const { sendOpenAI } = require('../src/providers/openai.js');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  try {
    await sendOpenAI({ apiKey: 'sk-test', model: 'grok-4', messages: [{ role: 'user', content: 'hi' }], baseUrl: 'https://api.x.ai/v1' });
    await sendOpenAI({ apiKey: '', model: 'llama3', messages: [{ role: 'user', content: 'hi' }], baseUrl: 'http://localhost:11434/v1', keyOptional: true });
    await sendOpenAI({ apiKey: 'sk-test', model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(calls[0].url, 'https://api.x.ai/v1/chat/completions');
    assert.equal(calls[0].headers.Authorization, 'Bearer sk-test');
    assert.equal(calls[0].body.model, 'grok-4');
    assert.equal(calls[1].url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(calls[1].headers.Authorization, undefined, 'no key, no header');
    assert.equal(calls[2].url, 'https://api.openai.com/v1/chat/completions');
    await assert.rejects(() => sendOpenAI({ apiKey: '', model: 'x', messages: [], baseUrl: 'https://api.x.ai/v1' }), /Missing API key/);
    await assert.rejects(() => sendOpenAI({ apiKey: '', model: 'x', messages: [] }), /Missing OpenAI API key/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('sendChat refuses a call over its cap before any request is made, and logs the ones it makes', async () => {
  const store = {};
  const realChrome = globalThis.chrome;
  const realFetch = globalThis.fetch;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])),
        set: async (obj) => Object.assign(store, JSON.parse(JSON.stringify(obj))),
      },
    },
  };
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } }) };
  };
  try {
    const { sendChat, validateKey } = require('../src/providers/index.js');
    store.mysnowbuddy_ai_prices = { 'openai:gpt-5-mini': { inPerM: 1, outPerM: 2 } };
    store.mysnowbuddy_ai_caps = { dailyCalls: 2 };
    const config = { provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk-test' };
    await sendChat(config, { messages: [{ role: 'user', content: 'a' }], kind: 'chat', host: 'dev1.service-now.com' });
    await sendChat(config, { messages: [{ role: 'user', content: 'b' }], kind: 'agent', host: 'dev1.service-now.com' });
    assert.equal(store.mysnowbuddy_ai_usage.length, 2);
    assert.equal(store.mysnowbuddy_ai_usage[1].kind, 'agent');
    assert.equal(store.mysnowbuddy_ai_usage[0].host, 'dev1.service-now.com');
    assert.equal(store.mysnowbuddy_ai_usage[0].costUsd, (100 + 100) / 1e6);
    await assert.rejects(() => sendChat(config, { messages: [{ role: 'user', content: 'c' }] }), /Daily calls cap reached/);
    assert.equal(requests, 2, 'the third call never left the browser');
    // Checking a key still works when a cap is reached, and is logged as a validation.
    assert.deepEqual(await validateKey(config), { ok: true });
    assert.equal(store.mysnowbuddy_ai_usage[2].kind, 'validate');
    assert.equal(requests, 3);
  } finally {
    globalThis.chrome = realChrome;
    globalThis.fetch = realFetch;
  }
});

test('the header chip stays quiet until there is something to say, then warns and blocks', () => {
  const { usageChip } = require('../src/lib/aiUsage.js');
  const now = new Date(2026, 10, 3, 14, 0, 0);
  const call = (cost, kind = 'chat') => ({ ...makeEntry({ now, provider: 'anthropic', model: 'm', usage: { input: 10 }, kind }), costUsd: cost });
  assert.equal(usageChip([], {}, 'anthropic', now).show, false);
  assert.equal(usageChip([call(0, 'validate')], {}, 'anthropic', now).show, false, 'a key check is not usage');
  assert.equal(usageChip([call(null)], {}, 'anthropic', now).text, '1 call today', 'no prices: no cost shown');
  assert.equal(usageChip([call(0.5), call(0.25)], {}, 'anthropic', now).text, '2 calls today · $0.75');
  assert.equal(usageChip([call(0.5), call(null)], {}, 'anthropic', now).text, '2 calls today · ≥$0.50');
  const caps = { anthropic: { dailyUsd: 1 } };
  assert.equal(usageChip([call(0.85)], caps, 'anthropic', now).status, 'warn');
  assert.equal(usageChip([call(1)], caps, 'anthropic', now).status, 'blocked');
  assert.match(usageChip([call(1)], caps, 'anthropic', now).title, /cap reached/);
  assert.equal(usageChip([call(0.5)], caps, 'anthropic', new Date(2026, 10, 4, 9, 0, 0)).show, false, 'tomorrow is a clean day');
});
