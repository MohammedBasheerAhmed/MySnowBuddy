import React, { useEffect, useRef, useState } from 'react';
import { SECTIONS, WINDOWS, DEFAULT_WINDOW, windowById, resultToMarkdown, hotspotPrompt } from '../lib/hotspots.js';

const GROUPS = [
  { id: 'slow', title: 'What is slow', hint: 'Requests, queries and jobs that take the most time' },
  { id: 'noisy', title: 'What is noisy', hint: 'What writes, fires or changes the most' },
];

/** What a section is doing: nothing yet, loading, or an answer (with `error` when it failed). */
const IDLE = { status: 'idle' };

function Cell({ value }) {
  return <span className="msb-hot__cell">{value}</span>;
}

function Result({ data }) {
  if (data.error) return <div className="msb-panel__error">{data.error}</div>;
  return (
    <>
      {data.headline && <p className="msb-hot__headline">{data.headline}</p>}
      {data.rows.length > 0 && (
        <div className="msb-table-wrap">
          <table className="msb-table msb-hot__table">
            <thead>
              <tr>
                {data.columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={`${row.cells[0]}-${i}`} style={{ '--msb-hot-weight': `${Math.round((row.weight || 0) * 100)}%` }}>
                  {row.cells.map((cell, j) => (
                    <td key={j} className={j === 0 ? 'msb-hot__first' : undefined}>
                      {j === 0 && row.href ? (
                        <a className="msb-panel__link" href={row.href} target="_blank" rel="noopener noreferrer" title="Open the matching list">
                          <Cell value={cell} />
                        </a>
                      ) : (
                        <Cell value={cell} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.note && <div className="msb-panel__hint">{data.note}</div>}
    </>
  );
}

function Section({ section, state, onLoad, onCopy, onAsk, windowLabel }) {
  const ref = useRef(null);
  const loaded = state.status === 'done';
  const hasRows = loaded && state.data.rows.length > 0;
  return (
    <details
      className="msb-hot__section"
      ref={ref}
      onToggle={(e) => {
        if (e.currentTarget.open && state.status === 'idle') onLoad(section.id);
      }}
    >
      <summary className="msb-panel__result-toggle">
        <span className="msb-hot__title">{section.title}</span>
        <span className="msb-hot__hint">{section.hint}</span>
        {loaded && hasRows && <span className="msb-panel__badge">{state.data.rows.length}</span>}
      </summary>
      <div className="msb-hot__body">
        {state.status === 'loading' && (
          <div className="msb-hot__busy" aria-live="polite">
            Asking the instance...
          </div>
        )}
        {loaded && <Result data={state.data} />}
        {loaded && hasRows && (
          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={() => onCopy(section)}>
              Copy as table
            </button>
            <button className="msb-panel__secondary" onClick={() => onAsk(section)}>
              Ask AI about this
            </button>
            <button className="msb-panel__secondary" onClick={() => onLoad(section.id, true)}>
              Reload
            </button>
          </div>
        )}
        {loaded && !hasRows && !state.data.error && (
          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={() => onLoad(section.id, true)}>
              Reload
            </button>
          </div>
        )}
        {loaded && state.data.error && (
          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={() => onLoad(section.id, true)}>
              Try again
            </button>
          </div>
        )}
        <span className="msb-hot__window">Last {windowLabel}</span>
      </div>
    </details>
  );
}

/**
 * Hot spots: what is slow and what is noisy. Read-only; a section asks the instance only when it is opened, for the
 * window chosen at the top, so nothing runs just because the panel is on screen.
 */
export default function HotspotsPanel({ services, onClose, onAskAi }) {
  const [windowId, setWindowId] = useState(DEFAULT_WINDOW);
  const [states, setStates] = useState({});
  const [notice, setNotice] = useState(null);
  const generation = useRef(0); // a window change makes older answers stale
  const openIds = useRef(new Set());
  const windowLabel = windowById(windowId).label;

  function flash(text) {
    setNotice(text);
    setTimeout(() => setNotice(null), 3000);
  }

  async function load(id, force = false) {
    const mine = generation.current;
    openIds.current.add(id);
    setStates((s) => ({ ...s, [id]: { status: 'loading' } }));
    try {
      if (force) await services.hotspotsClearCache?.();
      const data = await services.hotspotSection(id, windowId);
      if (mine === generation.current) setStates((s) => ({ ...s, [id]: { status: 'done', data } }));
    } catch (err) {
      if (mine === generation.current) setStates((s) => ({ ...s, [id]: { status: 'done', data: { columns: [], rows: [], headline: '', note: '', error: err.message } } }));
    }
  }

  // A new window: forget the answers, and fetch again only the sections that are open.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    generation.current += 1;
    setStates({});
    const ids = [...openIds.current];
    ids.forEach((id) => load(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId]);

  async function copy(section) {
    const state = states[section.id];
    if (state?.status !== 'done') return;
    try {
      await navigator.clipboard.writeText(resultToMarkdown(section.title, state.data, windowLabel));
      flash('Copied as a Markdown table.');
    } catch {
      flash('The browser blocked the copy. Click in the page first, then try again.');
    }
  }

  function ask(section) {
    const state = states[section.id];
    if (state?.status === 'done') onAskAi?.(`Hot spots: ${section.title}`, hotspotPrompt(section.title, state.data, windowLabel));
  }

  return (
    <div className="msb-panel msb-hot">
      <div className="msb-panel__header">
        <strong>Hot spots</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className="msb-hot__windows" role="radiogroup" aria-label="Time window">
        {WINDOWS.map((w) => (
          <button key={w.id} type="button" role="radio" aria-checked={windowId === w.id} className="msb-hot__window-btn" onClick={() => setWindowId(w.id)}>
            {w.label}
          </button>
        ))}
      </div>
      <div className="msb-panel__hint">Nothing is fetched until you open a section. Everything here only reads.</div>
      {notice && <div className="msb-panel__hint" role="status">{notice}</div>}

      {GROUPS.map((group) => (
        <section key={group.id} className="msb-hot__group" aria-label={group.title}>
          <h4 className="msb-hot__group-title">
            {group.title} <span>{group.hint}</span>
          </h4>
          {SECTIONS.filter((s) => s.group === group.id).map((section) => (
            <Section key={section.id} section={section} state={states[section.id] || IDLE} onLoad={load} onCopy={copy} onAsk={ask} windowLabel={windowLabel} />
          ))}
        </section>
      ))}
    </div>
  );
}
