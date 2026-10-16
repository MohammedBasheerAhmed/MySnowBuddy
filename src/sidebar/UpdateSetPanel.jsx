import React, { useEffect, useState } from 'react';
import { updateSetToMarkdown, downloadText, suggestFilename } from '../lib/report.js';
import ShipCheck from './ShipCheck.jsx';

/**
 * Update Set deployment review: the pre-commit ship check, collision detection
 * between live update sets, and configuration changes that were never captured.
 */
export default function UpdateSetPanel({ onClose, services, onAskAi }) {
  const [tab, setTab] = useState(typeof services?.shipCheckLoad === 'function' ? 'ship' : 'collisions');

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Update set review</strong>
        <button onClick={onClose} aria-label="Close">{'✕'}</button>
      </div>
      <div className="msb-mw-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'ship'} onClick={() => setTab('ship')}>
          Ship check
        </button>
        <button role="tab" aria-selected={tab === 'collisions'} onClick={() => setTab('collisions')}>
          Collisions &amp; coverage
        </button>
      </div>
      {tab === 'ship' ? (
        // The sidebar wires this panel's onAskAi through buildUpdateSetPrompt(), which passes a ready prompt through.
        <ShipCheck services={services} onAskAi={onAskAi ? (_label, prompt) => onAskAi({ prompt }) : undefined} />
      ) : (
        <CollisionsAndCoverage services={services} onAskAi={onAskAi} />
      )}
    </div>
  );
}

/** The original review: collisions between live update sets and uncaptured changes. */
function CollisionsAndCoverage({ services, onAskAi }) {
  const [sets, setSets] = useState([]);
  const [selected, setSelected] = useState('');
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [collisionResult, setCollisionResult] = useState(null);
  const [coverage, setCoverage] = useState(null);

  useEffect(() => {
    let cancelled = false;

    if (typeof services.fetchLiveUpdateSets !== 'function') {
      setError('Update set review is unavailable on this page.');
      setLoading(false);
      return undefined;
    }

    services
      .fetchLiveUpdateSets()
      .then((rows) => {
        if (cancelled) return;
        setSets(rows);
        if (rows.length) setSelected(rows[0].sys_id);
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [services]);

  async function handleCheckCollisions() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setCollisionResult(null);
    try {
      setCollisionResult(await services.findCollisions(selected));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCheckCoverage() {
    setBusy(true);
    setError(null);
    setCoverage(null);
    try {
      setCoverage(await services.findUncapturedChanges({ days: Number(days) }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleExport() {
    downloadText(
      suggestFilename('update-set-review'),
      updateSetToMarkdown({
        selectedSet: collisionResult?.selectedSet,
        collisions: collisionResult?.collisions,
        uncaptured: coverage?.uncaptured,
        days: coverage?.days,
      })
    );
  }

  const hasResults = collisionResult || coverage;

  return (
    <div>
      <div className="msb-panel__form">
        <label>
          Update set
          <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={loading}>
            {loading && <option>Loading...</option>}
            {!loading && !sets.length && <option value="">No in-progress update sets found</option>}
            {sets.map((s) => (
              <option key={s.sys_id} value={s.sys_id}>
                {s.name} ({s.state})
              </option>
            ))}
          </select>
        </label>

        <button className="msb-panel__run" onClick={handleCheckCollisions} disabled={busy || !selected}>
          {busy ? 'Working...' : 'Check for collisions'}
        </button>

        <label>
          Uncaptured changes in the last N days
          <input
            type="number"
            min="1"
            max="90"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </label>

        <button className="msb-panel__run" onClick={handleCheckCoverage} disabled={busy}>
          {busy ? 'Working...' : 'Find uncaptured changes'}
        </button>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}

      {hasResults && (
        <div className="msb-panel__actions">
          <button className="msb-panel__secondary" onClick={handleExport}>
            Export markdown
          </button>
          {onAskAi && (
            <button
              className="msb-panel__secondary"
              onClick={() =>
                onAskAi({
                  selectedSet: collisionResult?.selectedSet,
                  collisions: collisionResult?.collisions || [],
                  uncaptured: coverage?.uncaptured || [],
                  days: coverage?.days || Number(days),
                })
              }
            >
              Ask AI for deployment risk
            </button>
          )}
        </div>
      )}

      {collisionResult && (
        <div className="msb-panel__results">
          <div className="msb-panel__counts">
            {collisionResult.entries.length} entries in this set &middot;{' '}
            {collisionResult.collisions.length} collision(s)
          </div>

          {collisionResult.truncated && (
            <div className="msb-panel__warning">
              The collision check is incomplete: {collisionResult.truncatedReason || 'not every entry was checked'}.
            </div>
          )}

          {collisionResult.collisions.length === 0 ? (
            <div className="msb-panel__empty">
              No artifact in this set appears in another live update set.
            </div>
          ) : (
            collisionResult.collisions.map((c) => (
              <div key={c.name} className={`msb-panel__finding msb-panel__finding--${c.severity}`}>
                <div className="msb-panel__finding-title">
                  {c.targetName || c.name} <span className="msb-panel__badge">{c.type}</span>
                </div>
                <div className="msb-panel__finding-detail">
                  Also in:{' '}
                  {c.conflictsWith
                    .map((o) => `${o.updateSetName} (${o.updateSetState}, by ${o.updatedBy})`)
                    .join('; ')}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {coverage && (
        <div className="msb-panel__results">
          <div className="msb-panel__counts">
            {coverage.checked} record(s) changed in {coverage.days} days &middot;{' '}
            {coverage.uncaptured.length} not captured
          </div>

          {coverage.uncaptured.length === 0 ? (
            <div className="msb-panel__empty">Every recent change is captured in an update set.</div>
          ) : (
            coverage.uncaptured.slice(0, 100).map((u) => (
              <div key={`${u.table}:${u.sysId}`} className="msb-panel__finding msb-panel__finding--medium">
                <div className="msb-panel__finding-title">
                  {u.name} <span className="msb-panel__badge">{u.label}</span>
                </div>
                <div className="msb-panel__finding-detail">
                  Changed {u.updatedOn} by {u.updatedBy}
                </div>
              </div>
            ))
          )}

          {coverage.errors?.length > 0 && (
            <div className="msb-panel__warning">
              Skipped: {coverage.errors.map((e) => e.table).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
