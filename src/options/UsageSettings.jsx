import React, { useEffect, useMemo, useState } from 'react';
import { PROVIDERS } from '../providers/config.js';
import {
  USAGE_KEY,
  PRICES_KEY,
  CAPS_KEY,
  priceKey,
  normalizePrice,
  normalizeCaps,
  summarize,
  checkCaps,
  logToCsv,
  normalizeHistoryDays,
  DEFAULT_CACHE_READ_MULT,
  DEFAULT_CACHE_WRITE_MULT,
} from '../lib/aiUsage.js';

const fmtNum = (n) => Math.round(n).toLocaleString('en-US');
const fmtUsd = (n) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

/** "$1.2300", "at least $1.20 (some calls had no price)" or "set prices to see cost". */
function costText(sum) {
  if (!sum.calls) return '$0.00';
  if (!sum.priced) return 'set prices to see cost';
  return sum.complete ? fmtUsd(sum.cost) : `at least ${fmtUsd(sum.cost)}`;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Today / this month, per model, prices, caps with progress bars, the recent calls and a CSV export. */
export function UsageSection() {
  const [log, setLog] = useState([]);
  const [prices, setPrices] = useState({});
  const [caps, setCaps] = useState(normalizeCaps({}));
  const [saved, setSaved] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    chrome.storage.local.get([USAGE_KEY, PRICES_KEY, CAPS_KEY]).then((stored) => {
      setLog(Array.isArray(stored[USAGE_KEY]) ? stored[USAGE_KEY] : []);
      setPrices(stored[PRICES_KEY] || {});
      setCaps(normalizeCaps(stored[CAPS_KEY]));
    });
    const onChange = (changes, area) => {
      if (area === 'local' && changes[USAGE_KEY]) setLog(Array.isArray(changes[USAGE_KEY].newValue) ? changes[USAGE_KEY].newValue : []);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const now = useMemo(() => new Date(), [log]);
  const summary = useMemo(() => summarize(log, now), [log, now]);
  // One meter per limit: each provider's own spend limits, and the shared call and token limits once.
  const meters = useMemo(() => {
    const seen = new Map();
    Object.keys(PROVIDERS).forEach((provider) => checkCaps(log, caps, provider, now).items.forEach((item) => seen.has(item.name) || seen.set(item.name, item)));
    return [...seen.values()];
  }, [log, caps, now]);

  // Every model that could be priced: the listed ones plus any the log has seen (custom endpoints).
  const priceRows = useMemo(() => {
    const rows = new Map();
    Object.entries(PROVIDERS).forEach(([provider, def]) => def.models.forEach((m) => rows.set(priceKey(provider, m.id), { provider, model: m.id, label: m.label.split(' - ')[0] })));
    log.forEach((e) => e.model && rows.set(priceKey(e.provider, e.model), rows.get(priceKey(e.provider, e.model)) || { provider: e.provider, model: e.model, label: e.model }));
    return [...rows.entries()].map(([key, row]) => ({ key, ...row }));
  }, [log]);

  const flash = (text) => {
    setSaved(text);
    setTimeout(() => setSaved(''), 2000);
  };

  async function savePrices() {
    const clean = {};
    Object.entries(prices).forEach(([key, price]) => {
      const normal = normalizePrice(price);
      if (normal) clean[key] = normal;
    });
    await chrome.storage.local.set({ [PRICES_KEY]: clean });
    setPrices(clean);
    flash('Prices saved ✓');
  }

  async function saveCaps() {
    const clean = normalizeCaps(caps);
    await chrome.storage.local.set({ [CAPS_KEY]: clean });
    setCaps(clean);
    flash('Caps saved ✓');
  }

  async function clearLog() {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 4000);
      return;
    }
    await chrome.storage.local.set({ [USAGE_KEY]: [] });
    setLog([]);
    setConfirmClear(false);
  }

  const setPrice = (key, field, value) => setPrices((p) => ({ ...p, [key]: { ...(p[key] || {}), [field]: value } }));
  const setProviderCap = (provider, field, value) => setCaps((c) => ({ ...c, [provider]: { ...c[provider], [field]: value } }));

  return (
    <section>
      <h2>AI usage and limits</h2>
      <p className="msb-options__hint">
        Every call to your AI provider is logged here, in this browser only (the newest 500). Cost is an estimate: tokens times the price per million you enter below. NowBuddy does not ship vendor prices, so it shows no cost until you add them.
      </p>

      <div className="msb-usage__cards">
        <div className="msb-usage__card">
          <span className="msb-usage__label">Today</span>
          <strong>{summary.today.calls} calls</strong>
          <span>{fmtNum(summary.today.tokens)} tokens</span>
          <span>{costText(summary.today)}</span>
        </div>
        <div className="msb-usage__card">
          <span className="msb-usage__label">This month</span>
          <strong>{summary.month.calls} calls</strong>
          <span>{fmtNum(summary.month.tokens)} tokens</span>
          <span>{costText(summary.month)}</span>
        </div>
      </div>

      {summary.models.length > 0 && (
        <table className="msb-usage__table">
          <caption>This month by model</caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Calls</th>
              <th scope="col">Tokens</th>
              <th scope="col">Estimated cost</th>
            </tr>
          </thead>
          <tbody>
            {summary.models.map((m) => (
              <tr key={priceKey(m.provider, m.model)}>
                <th scope="row">{m.model}</th>
                <td>{m.calls}</td>
                <td>{fmtNum(m.tokens)}</td>
                <td>{costText(m)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Limits</h3>
      <p className="msb-options__hint">0 means no limit. From 80% you get a warning in the chat panel; at 100% requests are refused until the day or month rolls over (your own time zone) or you raise the limit. Call and token limits work without prices.</p>
      <div className="msb-usage__grid">
        {Object.entries(PROVIDERS).map(([provider, def]) => (
          <React.Fragment key={provider}>
            <label className="msb-options__field">
              {def.label.split(' (')[0]} daily limit (USD)
              <input type="number" min="0" step="any" value={caps[provider]?.dailyUsd || 0} onChange={(e) => setProviderCap(provider, 'dailyUsd', e.target.value)} />
            </label>
            <label className="msb-options__field">
              {def.label.split(' (')[0]} monthly limit (USD)
              <input type="number" min="0" step="any" value={caps[provider]?.monthlyUsd || 0} onChange={(e) => setProviderCap(provider, 'monthlyUsd', e.target.value)} />
            </label>
          </React.Fragment>
        ))}
        <label className="msb-options__field">
          Calls per day
          <input type="number" min="0" step="1" value={caps.dailyCalls || 0} onChange={(e) => setCaps((c) => ({ ...c, dailyCalls: e.target.value }))} />
        </label>
        <label className="msb-options__field">
          Tokens per day
          <input type="number" min="0" step="1000" value={caps.dailyTokens || 0} onChange={(e) => setCaps((c) => ({ ...c, dailyTokens: e.target.value }))} />
        </label>
      </div>
      <div className="msb-options__actions">
        <button onClick={saveCaps}>Save limits</button>
        {saved === 'Caps saved ✓' && <span className="msb-options__saved">{saved}</span>}
      </div>
      {meters.map((item) => (
        <div key={item.name} className={`msb-usage__meter msb-usage__meter--${item.pct >= 1 ? 'blocked' : item.pct >= 0.8 ? 'warn' : 'ok'}`}>
          <label>
            <span>
              {item.name}: {item.format(item.used)} of {item.format(item.limit)} ({Math.min(999, Math.round(item.pct * 100))}%){item.pct >= 1 ? ' - limit reached' : item.pct >= 0.8 ? ' - nearly there' : ''}
            </span>
            <progress max="1" value={Math.min(1, item.pct)} aria-label={`${item.name} used`} />
          </label>
        </div>
      ))}

      <h3>Prices</h3>
      <p className="msb-options__hint">US dollars per million tokens, from your provider's price page. Cache reads and writes are priced as a multiple of the input price (defaults {DEFAULT_CACHE_READ_MULT} and {DEFAULT_CACHE_WRITE_MULT}).</p>
      <table className="msb-usage__table">
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Input per M</th>
            <th scope="col">Output per M</th>
            <th scope="col">Cache read x</th>
            <th scope="col">Cache write x</th>
          </tr>
        </thead>
        <tbody>
          {priceRows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              {['inPerM', 'outPerM', 'cacheReadMult', 'cacheWriteMult'].map((field) => (
                <td key={field}>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    aria-label={`${row.label} ${field === 'inPerM' ? 'input price per million tokens' : field === 'outPerM' ? 'output price per million tokens' : field === 'cacheReadMult' ? 'cache read multiplier' : 'cache write multiplier'}`}
                    value={prices[row.key]?.[field] ?? ''}
                    placeholder={field === 'cacheReadMult' ? String(DEFAULT_CACHE_READ_MULT) : field === 'cacheWriteMult' ? String(DEFAULT_CACHE_WRITE_MULT) : ''}
                    onChange={(e) => setPrice(row.key, field, e.target.value)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="msb-options__actions">
        <button onClick={savePrices}>Save prices</button>
        {saved === 'Prices saved ✓' && <span className="msb-options__saved">{saved}</span>}
      </div>

      <h3>Recent calls</h3>
      {summary.recent.length === 0 ? (
        <p className="msb-options__hint">Nothing yet. Calls appear here as you use the chat and the agent.</p>
      ) : (
        <table className="msb-usage__table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Model</th>
              <th scope="col">Kind</th>
              <th scope="col">Tokens</th>
              <th scope="col">Cost</th>
              <th scope="col">Instance</th>
            </tr>
          </thead>
          <tbody>
            {summary.recent.map((e, i) => (
              <tr key={`${e.time}-${i}`}>
                <th scope="row">{new Date(e.time).toLocaleString()}</th>
                <td>{e.model}</td>
                <td>{e.kind}</td>
                <td>{fmtNum(e.inputTokens + e.outputTokens + e.cacheRead + e.cacheWrite)}</td>
                <td>{e.costUsd == null ? '-' : fmtUsd(e.costUsd)}</td>
                <td>{e.host || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="msb-options__actions">
        <button onClick={() => download(`nowbuddy-ai-usage-${new Date().toISOString().slice(0, 10)}.csv`, logToCsv(log), 'text/csv')} disabled={!log.length}>
          Export CSV
        </button>
        <button onClick={clearLog} disabled={!log.length}>
          {confirmClear ? 'Click again to clear the log' : 'Clear the log'}
        </button>
      </div>
    </section>
  );
}

/** What leaves the browser, and how long chat history stays. */
export function DataSection({ settings, update }) {
  const saved = normalizeHistoryDays(settings.chatHistoryDays);
  // Typed text is committed on blur, so clearing the box to type a new number does not briefly mean "keep nothing".
  const [text, setText] = useState(String(saved));
  useEffect(() => setText(String(saved)), [saved]);
  const commit = () => {
    const next = normalizeHistoryDays(text === '' ? saved : text);
    setText(String(next));
    if (next !== saved) update({ chatHistoryDays: next });
  };
  return (
    <section>
      <h2>Your data and the AI</h2>
      <p className="msb-options__hint">
        What is sent: each message you type, the page context the chat shows (table, sys_id, the script on screen), and any record data or script the agent reads to answer you. It goes straight from this browser to the provider or custom endpoint you chose above, and nowhere else. NowBuddy has no servers, so the people who make it never see your prompts or your instance data. Secrets such as passwords, tokens and API keys are masked before anything is sent.
      </p>
      <p className="msb-options__hint">The agent runs as you, with your own ServiceNow permissions. Check that your agreement with the provider covers the data you plan to use, especially on a production instance.</p>
      <label className="msb-options__field">
        Keep chat history for this many days (0 keeps nothing after the page closes)
        <input
          type="number"
          min="0"
          max="365"
          step="1"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
        <span className="msb-options__hint">History stays in this browser only, one conversation per instance. Older history is removed the next time the chat opens.</span>
      </label>
    </section>
  );
}
