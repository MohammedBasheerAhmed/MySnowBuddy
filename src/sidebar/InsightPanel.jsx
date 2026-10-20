import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PERIODS, compareValues, breakdownMarkdown, breakdownCsv, seriesMarkdown, seriesCsv } from '../lib/insight.js';
import { copyText } from '../content/quickActions.js';

const TABLE_NAME = /^[a-z][a-z0-9_]*$/;
const UNIT_LABEL = { day: 'Days', week: 'Weeks', month: 'Months' };
const errorText = (err) => err?.message || String(err);

/**
 * Break the list on screen down by a column (counts per value, click a bar to filter) or over time (per day, week or
 * month). Everything is a count from the Aggregate API, so nothing but numbers comes back and nothing is changed.
 */
export default function InsightPanel({ context, params, services, onClose }) {
  const [table, setTable] = useState(context?.table || '');
  const [query, setQuery] = useState('');
  const [columns, setColumns] = useState(null); // { columns, dates }
  const [view, setView] = useState('value'); // 'value' | 'time'
  const [column, setColumn] = useState(String(params?.args || '').trim());
  const [dateColumn, setDateColumn] = useState('');
  const [unit, setUnit] = useState('day');
  const [count, setCount] = useState(PERIODS.day.default);
  const [data, setData] = useState(null); // by value: { total, distinct, bars }
  const [series, setSeries] = useState(null); // over time: { total, average, peak, points }
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [compare, setCompare] = useState(false);
  const [picked, setPicked] = useState([]);
  const request = useRef(0);

  const flash = (text) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 2500);
  };

  // The list on screen, then the columns of its table.
  async function start(nextTable, nextQuery) {
    setError(null);
    setData(null);
    setSeries(null);
    setColumns(null);
    try {
      const found = await services.insightColumns(nextTable);
      setColumns(found);
      setDateColumn((current) => current || found.dates[0]?.name || '');
      setColumn((current) => (current && /^[a-z]/.test(current) ? current : found.columns[0]?.name || ''));
      setQuery(nextQuery);
    } catch (err) {
      setError(errorText(err));
    }
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const info = await services.detectListInfo?.();
        if (!alive) return;
        const t = info?.table || context?.table || '';
        if (info) setTable(info.table);
        if (TABLE_NAME.test(t)) await start(t, info?.query || '');
        else setError('Open a list view (or type a table name below) to break it down.');
      } catch (err) {
        if (alive) setError(errorText(err));
      }
    })();
    return () => {
      alive = false;
      request.current += 1;
    };
    // Once per panel instance; the panel is re-keyed when its arguments change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runBreakdown(col = column) {
    if (!TABLE_NAME.test(table) || !col) return;
    const mine = (request.current += 1);
    setBusy(true);
    setError(null);
    setPicked([]);
    try {
      const result = await services.insightBreakdown(table, query, col);
      if (mine === request.current) setData(result);
    } catch (err) {
      if (mine === request.current) setError(errorText(err));
    } finally {
      if (mine === request.current) setBusy(false);
    }
  }

  async function runSeries(col = dateColumn, u = unit, n = count) {
    if (!TABLE_NAME.test(table) || !col) return;
    const mine = (request.current += 1);
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const result = await services.insightSeries({ table, query, column: col, unit: u, count: n, isCancelled: () => mine !== request.current, onProgress: (p) => mine === request.current && setProgress(p) });
      if (mine === request.current) setSeries(result);
    } catch (err) {
      if (mine === request.current) setError(errorText(err));
    } finally {
      if (mine === request.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  // Count as soon as there is something to count: the first suggested column, or the column the menu passed in.
  useEffect(() => {
    if (columns && view === 'value' && column && !data && !busy) runBreakdown(column);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns]);

  const labelOf = useMemo(() => {
    const all = [...(columns?.columns || []), ...(columns?.dates || [])];
    return (name) => all.find((c) => c.name === name)?.label || name;
  }, [columns]);

  const pickedBars = picked.map((i) => data?.bars[i]).filter(Boolean);
  const comparison = compare && pickedBars.length === 2 ? compareValues(pickedBars[0], pickedBars[1], data.total) : null;

  function clickBar(bar, index) {
    if (compare) {
      if (bar.other) return;
      setPicked((current) => (current.includes(index) ? current.filter((i) => i !== index) : [...current, index].slice(-2)));
      return;
    }
    if (bar.other) {
      flash('Several values are grouped here. Narrow the filter or pick a column with fewer values.');
      return;
    }
    services.insightApplyFilter(table, query, column, bar.value);
  }

  async function copy(text, what) {
    try {
      await copyText(text);
      flash(`Copied the ${what}`);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const listed = columns?.columns || [];
  const dates = columns?.dates || [];
  const step = series ? Math.ceil(series.points.length / 6) : 1;

  return (
    <div className="msb-panel msb-insight">
      <div className="msb-panel__header">
        <strong>Break this list down</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className="msb-panel__form">
        <label>
          Table
          <input
            value={table}
            onChange={(e) => setTable(e.target.value.trim())}
            onBlur={() => TABLE_NAME.test(table) && table !== context?.table && start(table, query)}
            placeholder="incident"
          />
        </label>
        {query && (
          <div className="msb-panel__hint">
            Filter: <code>{query}</code>
          </div>
        )}
      </div>

      {columns && (
        <div className="msb-insight__tabs" role="tablist" aria-label="View">
          {[
            ['value', 'By value'],
            ['time', 'Over time'],
          ].map(([id, label]) => (
            <button key={id} role="tab" aria-selected={view === id} className={`msb-insight__tab${view === id ? ' msb-insight__tab--on' : ''}`} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </div>
      )}

      {error && <div className="msb-panel__error">{error}</div>}
      {notice && <div className="msb-panel__hint">{notice}</div>}

      {columns && view === 'value' && (
        <>
          <div className="msb-panel__form">
            <label>
              Count by
              <select
                value={column}
                onChange={(e) => {
                  setColumn(e.target.value);
                  setData(null);
                  runBreakdown(e.target.value);
                }}
              >
                {!listed.some((c) => c.name === column) && column && <option value={column}>{column}</option>}
                {listed.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.label} ({c.name})
                  </option>
                ))}
              </select>
            </label>
          </div>
          {busy && <div className="msb-insight__busy">Counting…</div>}
          {data && !busy && (
            <>
              <div className="msb-insight__head" aria-live="polite">
                <strong>{data.total.toLocaleString()}</strong> record{data.total === 1 ? '' : 's'} across <strong>{data.distinct}</strong> value{data.distinct === 1 ? '' : 's'} of {labelOf(column)}
              </div>
              {data.bars.length === 0 ? (
                <div className="msb-panel__empty">No records match this filter.</div>
              ) : (
                <ul className="msb-insight__bars">
                  {data.bars.map((bar, i) => {
                    const on = picked.includes(i);
                    return (
                      <li key={`${bar.value}:${i}`}>
                        <button
                          type="button"
                          className={`msb-insight__bar${bar.other ? ' msb-insight__bar--other' : ''}${on ? ' msb-insight__bar--picked' : ''}`}
                          aria-pressed={compare ? on : undefined}
                          title={compare ? 'Pick two values to compare' : bar.other ? undefined : `Show only ${bar.label}`}
                          onClick={() => clickBar(bar, i)}
                        >
                          <span className="msb-insight__label">{bar.label}</span>
                          <span className="msb-insight__figures">
                            {bar.count.toLocaleString()} · {bar.share}%
                          </span>
                          <span className="msb-insight__track" aria-hidden="true">
                            <span className="msb-insight__fill" style={{ width: `${bar.bar}%` }} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="msb-panel__actions">
                <label className="msb-insight__check">
                  <input
                    type="checkbox"
                    checked={compare}
                    onChange={(e) => {
                      setCompare(e.target.checked);
                      setPicked([]);
                    }}
                  />
                  Compare two values
                </label>
                <button className="msb-panel__secondary" onClick={() => copy(breakdownMarkdown({ table, column, query, bars: data.bars, total: data.total }), 'Markdown table')}>
                  Copy Markdown
                </button>
                <button className="msb-panel__secondary" onClick={() => copy(breakdownCsv({ bars: data.bars }), 'CSV')}>
                  Copy CSV
                </button>
              </div>
              {compare && <div className="msb-insight__compare">{comparison ? comparison.text : 'Click two bars to compare them.'}</div>}
              {!compare && data.bars.length > 0 && <div className="msb-panel__hint">Click a bar to show only those records in the list.</div>}
            </>
          )}
        </>
      )}

      {columns && view === 'time' && (
        <>
          {dates.length === 0 ? (
            <div className="msb-panel__empty">This table has no date columns to count over time.</div>
          ) : (
            <div className="msb-panel__form">
              <label>
                Date column
                <select value={dateColumn} onChange={(e) => setDateColumn(e.target.value)}>
                  {dates.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.label} ({c.name})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Per
                <select
                  value={unit}
                  onChange={(e) => {
                    setUnit(e.target.value);
                    setCount(PERIODS[e.target.value].default);
                  }}
                >
                  {Object.keys(PERIODS).map((u) => (
                    <option key={u} value={u}>
                      {UNIT_LABEL[u]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                How many {UNIT_LABEL[unit].toLowerCase()}
                <input type="number" min="1" max={PERIODS[unit].max} value={count} onChange={(e) => setCount(Math.max(1, Math.min(PERIODS[unit].max, Number(e.target.value) || 1)))} />
              </label>
              <button className="msb-panel__run" disabled={busy || !dateColumn} onClick={() => runSeries()}>
                {busy ? 'Counting…' : 'Show'}
              </button>
              {progress && (
                <div className="msb-panel__hint">
                  {progress.done} of {progress.total} counted
                </div>
              )}
            </div>
          )}
          {series && !busy && (
            <>
              <div className="msb-insight__head" aria-live="polite">
                <strong>{series.total.toLocaleString()}</strong> in {series.points.length} {UNIT_LABEL[series.unit].toLowerCase()}, about <strong>{series.average}</strong> per {series.unit}
                {series.peak ? `; busiest: ${series.peak.label} (${series.peak.count})` : ''}
              </div>
              <div className="msb-insight__chart" role="list" aria-label={`${labelOf(series.column)} per ${series.unit}`}>
                {series.points.map((p, i) => (
                  <button
                    key={`${p.label}:${i}`}
                    type="button"
                    role="listitem"
                    className="msb-insight__col"
                    title={`${p.label}: ${p.count}. Click to open these records`}
                    aria-label={`${p.label}: ${p.count} records. Click to open them in the list`}
                    onClick={() => services.insightOpenQuery(table, p.query)}
                  >
                    <span className="msb-insight__colcount">{p.count}</span>
                    <span className="msb-insight__colbar" aria-hidden="true">
                      <span style={{ height: `${p.height}%` }} />
                    </span>
                    <span className="msb-insight__collabel" aria-hidden="true">
                      {i % step === 0 ? p.label : ''}
                    </span>
                  </button>
                ))}
              </div>
              <div className="msb-panel__actions">
                <button className="msb-panel__secondary" onClick={() => copy(seriesMarkdown({ table, column: series.column, unit: series.unit, points: series.points }), 'Markdown table')}>
                  Copy Markdown
                </button>
                <button className="msb-panel__secondary" onClick={() => copy(seriesCsv({ points: series.points }), 'CSV')}>
                  Copy CSV
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
