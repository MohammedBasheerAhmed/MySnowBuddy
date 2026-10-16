import React, { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import MoveEntries from './MoveEntries.jsx';
import { VERDICT_TEXT, shipCheckToMarkdown, buildShipCheckPrompt, recordPathForEntry } from '../lib/updateSetReview.js';
import { downloadText, suggestFilename } from '../lib/report.js';

const STATUS_ICON = { block: 'ban', warn: 'alert', info: 'eye', ok: 'check' };
const STATUS_LABEL = { block: 'Blocker', warn: 'Warning', info: 'Note', ok: 'OK' };
const VERDICT_ICON = { ready: 'check', warnings: 'alert', blockers: 'ban' };

function openPath(path) {
  // Root-relative paths built from validated table names and sys_ids only.
  if (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')) window.open(path, '_blank', 'noopener,noreferrer');
}

/** Pick the set named by "/ship <text>": a sys_id, an exact name, or a name fragment. */
function pickSet(sets, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  return (
    sets.find((s) => s.sysId === q) ||
    sets.find((s) => s.name.toLowerCase() === q) ||
    sets.find((s) => s.name.toLowerCase().includes(q)) ||
    null
  );
}

/**
 * Pre-commit review of one update set: checklist + verdict, scripts, entries
 * (with moving), release notes and export.
 *
 * Props: services, initialSetId, initialQuery, onAskAi(label, prompt)
 */
export default function ShipCheck({ services, initialSetId = '', initialQuery = '', onAskAi }) {
  const [sets, setSets] = useState(null);
  const [currentId, setCurrentId] = useState('');
  const [userName, setUserName] = useState('');
  const [selected, setSelected] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [open, setOpen] = useState({});
  const [picked, setPicked] = useState([]);
  const [moving, setMoving] = useState(null);

  const available = typeof services?.shipCheckLoad === 'function';

  async function run(setId) {
    if (!setId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setResult(null);
    setPicked([]);
    setMoving(null);
    try {
      const r = await services.shipCheckLoad(setId);
      setResult(r);
      setSets((prev) => (prev || []).map((x) => (x.sysId === setId && x.placeholder ? { ...x, name: r.set.name, state: r.set.state, placeholder: false } : x)));
      // Open the checks that need attention.
      setOpen(Object.fromEntries(r.checklist.checks.map((c) => [c.id, c.status === 'block'])));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!available) return undefined;
    let cancelled = false;
    services
      .shipCheckSets()
      .then((r) => {
        if (cancelled) return;
        const list = [...r.sets];
        // A set picked elsewhere (My work) may be older than the list's cap: keep it selectable.
        if (/^[0-9a-f]{32}$/i.test(initialSetId) && !list.some((x) => x.sysId === initialSetId)) {
          list.unshift({ sysId: initialSetId, name: 'Selected update set', state: '', placeholder: true });
        }
        setSets(list);
        setCurrentId(r.currentId);
        setUserName(r.userName);
        const match = pickSet(list, initialQuery);
        const chosen = (initialSetId && list.find((x) => x.sysId === initialSetId)?.sysId) || match?.sysId || r.currentId || list[0]?.sysId || '';
        setSelected(chosen);
        if (chosen) run(chosen);
        // After run(), which clears the notice synchronously.
        if (initialQuery && !match) setNotice(`No open update set matches "${initialQuery}". Showing ${chosen === r.currentId ? 'your current set' : 'the newest set'}.`);
      })
      .catch((err) => {
        if (cancelled) return;
        setSets([]);
        setError(err.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per panel
  }, [services]);

  const entriesByType = useMemo(() => {
    const groups = new Map();
    (result?.entries || []).forEach((e) => {
      const type = e.type || 'Other';
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(e);
    });
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [result]);

  if (!available) return <div className="msb-panel__error">The ship check is unavailable on this page.</div>;

  function toggle(id) {
    setOpen((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function togglePick(id) {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 25 ? prev : [...prev, id]));
  }

  async function copyNotes() {
    try {
      await navigator.clipboard.writeText(result.releaseNotes);
      setNotice('Release notes copied.');
    } catch {
      setNotice('The browser blocked the clipboard. Use Download instead.');
    }
  }

  function download() {
    downloadText(
      suggestFilename(`ship-check-${result.set.name.replace(/[^\w-]+/g, '-').slice(0, 40)}`),
      shipCheckToMarkdown({ set: result.set, checklist: result.checklist, releaseNotes: result.releaseNotes, host: result.host })
    );
  }

  function askAi() {
    onAskAi?.(`Summarize update set "${result.set.name}"`, buildShipCheckPrompt({ set: result.set, checklist: result.checklist, releaseNotes: result.releaseNotes }));
  }

  const setLabel = (s) => {
    const tags = [];
    if (s.sysId === currentId) tags.push('current');
    if (s.createdBy && s.createdBy === userName) tags.push('mine');
    if (s.state && s.state !== 'in progress') tags.push(s.state);
    return `${s.name}${tags.length ? ` (${tags.join(', ')})` : ''}`;
  };

  const checklist = result?.checklist;

  return (
    <div>
      <div className="msb-panel__form">
        <label>
          Update set
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              run(e.target.value);
            }}
            disabled={!sets || busy}
          >
            {!sets && <option>Loading...</option>}
            {sets && !sets.length && <option value="">No open update sets</option>}
            {(sets || []).map((s) => (
              <option key={s.sysId} value={s.sysId}>
                {setLabel(s)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="msb-panel__actions">
        <button className="msb-panel__secondary" onClick={() => run(selected)} disabled={busy || !selected}>
          {busy ? 'Checking...' : 'Check again'}
        </button>
        {result && (
          <>
            <button className="msb-panel__secondary" onClick={copyNotes}>
              Copy release notes
            </button>
            <button className="msb-panel__secondary" onClick={download}>
              Download report
            </button>
            {onAskAi && (
              <button className="msb-panel__secondary" onClick={askAi}>
                Ask AI to summarize
              </button>
            )}
          </>
        )}
      </div>

      {busy && <div className="msb-panel__empty">Reading the entries, checking collisions and analysing scripts...</div>}
      {notice && <div className="msb-panel__hint">{notice}</div>}
      {error && <div className="msb-panel__error">{error}</div>}

      {checklist && (
        <>
          <div className={`msb-mw-verdict msb-mw-verdict--${checklist.verdict}`} role="status">
            <Icon name={VERDICT_ICON[checklist.verdict]} size={18} />
            {VERDICT_TEXT[checklist.verdict]}
            <span className="msb-mw-verdict__counts">
              {checklist.counts.block} blocker{checklist.counts.block === 1 ? '' : 's'} &middot; {checklist.counts.warn} warning
              {checklist.counts.warn === 1 ? '' : 's'} &middot; {result.total} entr{result.total === 1 ? 'y' : 'ies'}
            </span>
          </div>

          <div className="msb-mw-list" style={{ marginTop: 8 }}>
            {checklist.checks.map((c) => (
              <div key={c.id} className="msb-mw-check">
                <button className="msb-mw-check__toggle" onClick={() => toggle(c.id)} aria-expanded={Boolean(open[c.id])} disabled={!c.items.length}>
                  <span className={`msb-mw-check__icon msb-mw-check__icon--${c.status}`} title={STATUS_LABEL[c.status]}>
                    <Icon name={STATUS_ICON[c.status]} size={15} />
                  </span>
                  <span>
                    <span className="msb-mw-check__title">{c.title}</span>
                    {c.items.length > 0 && <span className="msb-mw-muted"> &middot; {open[c.id] ? 'hide' : 'show'}</span>}
                    {c.detail && <div className="msb-mw-check__detail">{c.detail}</div>}
                  </span>
                </button>
                {open[c.id] && c.items.length > 0 && (
                  <ul className="msb-mw-check__items">
                    {c.items.slice(0, 100).map((it, i) => (
                      <li key={`${c.id}:${i}`}>
                        <span className="msb-mw-check__item-text">
                          <strong>{it.label}</strong>
                          {it.detail ? ` - ${it.detail}` : ''}
                        </span>
                        {it.path && (
                          <button className="msb-mw-small-btn" onClick={() => openPath(it.path)}>
                            Open
                          </button>
                        )}
                        {it.entrySysId && (
                          <button className="msb-mw-small-btn" onClick={() => setMoving([it.entrySysId])}>
                            Move...
                          </button>
                        )}
                      </li>
                    ))}
                    {c.items.length > 100 && <li>... {c.items.length - 100} more (see the downloaded report)</li>}
                  </ul>
                )}
              </div>
            ))}
          </div>

          {moving && (
            <MoveEntries
              services={services}
              entryIds={moving}
              onCancel={() => setMoving(null)}
              onDone={() => {
                setMoving(null);
                run(selected);
              }}
            />
          )}

          {result.scripts.length > 0 && (
            <details className="msb-panel__result" style={{ marginTop: 10 }}>
              <summary className="msb-panel__result-toggle">Scripts analysed ({result.scripts.length})</summary>
              <div className="msb-panel__result-body">
                {result.scripts.map((s) => (
                  <div key={`${s.entrySysId}:${s.field}`} className="msb-mw-item" style={{ paddingLeft: 0, paddingRight: 0 }}>
                    <div className="msb-mw-item__main">
                      <div className="msb-mw-item__title">
                        {s.targetName}
                        <span className="msb-mw-badge">{s.field}</span>
                        {s.syntaxError && <span className="msb-mw-badge msb-mw-badge--danger">syntax</span>}
                      </div>
                      {s.findings.length === 0 ? (
                        <div className="msb-mw-item__meta">No findings ({s.lines} lines{s.kind ? ', verified' : ', linted'}).</div>
                      ) : (
                        <ul className="msb-mw-findings">
                          {s.findings.slice(0, 8).map((f, i) => (
                            <li key={i}>
                              <span className={`msb-mw-sev--${f.severity}`}>{f.severity}</span> line {f.line}: {f.message}
                            </li>
                          ))}
                          {s.findings.length > 8 && <li>... {s.findings.length - 8} more</li>}
                        </ul>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          <details className="msb-panel__result" style={{ marginTop: 6 }}>
            <summary className="msb-panel__result-toggle">
              Entries ({result.entries.length}
              {result.total > result.entries.length ? ` of ${result.total}` : ''})
            </summary>
            <div className="msb-panel__result-body">
              <div className="msb-panel__hint" style={{ marginTop: 6 }}>
                Tick entries to move them to another update set (up to 25 at a time).
              </div>
              {picked.length > 0 && !moving && (
                <div className="msb-panel__actions">
                  <button className="msb-panel__run" onClick={() => setMoving(picked)}>
                    Move {picked.length} selected...
                  </button>
                  <button className="msb-panel__secondary" onClick={() => setPicked([])}>
                    Clear
                  </button>
                </div>
              )}
              <div className="msb-mw-list" style={{ marginTop: 6 }}>
                {entriesByType.map(([type, rows]) => (
                  <React.Fragment key={type}>
                    <div className="msb-mw-group">
                      {type} ({rows.length})
                    </div>
                    {rows.map((e) => (
                      <div key={e.sys_id} className="msb-mw-item">
                        <input
                          type="checkbox"
                          className="msb-mw-checkbox"
                          checked={picked.includes(e.sys_id)}
                          onChange={() => togglePick(e.sys_id)}
                          aria-label={`Select ${e.target_name || e.name}`}
                        />
                        <div className="msb-mw-item__main">
                          <div className="msb-mw-item__title">
                            {e.target_name || e.name}
                            {String(e.action).toUpperCase() === 'DELETE' && <span className="msb-mw-badge msb-mw-badge--danger">delete</span>}
                          </div>
                          <div className="msb-mw-item__meta">
                            {e.sys_updated_by} &middot; {e.sys_updated_on}
                          </div>
                        </div>
                        <div className="msb-mw-item__actions">
                          <button className="msb-mw-small-btn" onClick={() => openPath(recordPathForEntry(e))}>
                            Open
                          </button>
                        </div>
                      </div>
                    ))}
                  </React.Fragment>
                ))}
                {!result.entries.length && <div className="msb-panel__empty" style={{ padding: 10 }}>No entries.</div>}
              </div>
            </div>
          </details>

          <details className="msb-panel__result" style={{ marginTop: 6 }}>
            <summary className="msb-panel__result-toggle">Release notes</summary>
            <div className="msb-panel__result-body">
              <pre style={{ whiteSpace: 'pre-wrap' }}>{result.releaseNotes}</pre>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
