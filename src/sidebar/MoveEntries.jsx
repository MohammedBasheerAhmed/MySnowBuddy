import React, { useEffect, useState } from 'react';
import { confirmMatches } from '../lib/updateSetReview.js';
import { trusted } from './trusted.js';

/**
 * Move customer updates (sys_update_xml) into another update set. Shows exactly
 * what moves, from where to where, before anything is written; re-reads each
 * entry afterwards and reports where the instance says it now is.
 *
 * Props: services, entryIds, defaultTargetId, onDone(result), onCancel
 */
export default function MoveEntries({ services, entryIds, defaultTargetId = '', onDone, onCancel }) {
  const [targets, setTargets] = useState(null);
  const [targetId, setTargetId] = useState(defaultTargetId);
  const [preview, setPreview] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const idsKey = (entryIds || []).join(',');

  useEffect(() => {
    let cancelled = false;
    services
      .myWorkSwitchTargets()
      .then((r) => !cancelled && setTargets(r.sets))
      .catch((err) => {
        if (cancelled) return;
        setTargets([]);
        setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [services]);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setTyped('');
    if (!targetId) return undefined;
    setBusy(true);
    setError(null);
    services
      .moveEntriesPreview({ entryIds, targetSetId: targetId })
      .then((p) => !cancelled && setPreview(p))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ids, not the array identity
  }, [services, idsKey, targetId]);

  async function handleMove() {
    setBusy(true);
    setError(null);
    try {
      setResult(await services.moveEntries({ entryIds, targetSetId: targetId, confirmName: typed }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const moved = result.results.filter((r) => r.ok).length;
    return (
      <div className="msb-mw-confirm">
        <div className="msb-mw-confirm__title">
          {moved} of {result.results.length + result.notAttempted} moved to "{result.target.name}"
        </div>
        <ul>
          {result.results.map((r) => (
            <li key={r.sysId} className={r.ok ? '' : 'msb-mw-confirm__blocked'}>
              {r.label}: {r.ok ? `now in "${r.nowIn}" (as the instance reports)` : r.error || `still in "${r.nowIn}"`}
            </li>
          ))}
          {result.notAttempted > 0 && <li className="msb-mw-confirm__blocked">{result.notAttempted} not attempted after the failure.</li>}
        </ul>
        {moved > 0 && <div className="msb-panel__hint">Each move is in /changes; /undo puts the last one back.</div>}
        <div className="msb-panel__actions">
          <button className="msb-panel__run" onClick={() => onDone?.(result)}>
            Done
          </button>
        </div>
      </div>
    );
  }

  const plan = preview?.plan;
  const moveCount = plan?.moves.length || 0;
  const canMove = plan && plan.moves.length > 0 && plan.blocked.length === 0 && (!preview.guarded || confirmMatches(typed, preview.instance));

  return (
    <div className="msb-mw-confirm">
      <div className="msb-mw-confirm__title">
        Move {entryIds.length} {entryIds.length === 1 ? 'entry' : 'entries'} to another update set
      </div>
      <div className="msb-panel__form" style={{ marginTop: 8 }}>
        <label>
          Move to
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} disabled={!targets || busy}>
            <option value="">{targets ? 'Pick an in-progress update set' : 'Loading...'}</option>
            {(targets || []).map((s) => (
              <option key={s.sysId} value={s.sysId}>
                {s.name}
                {s.applicationName ? ` [${s.applicationName}]` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      {busy && !plan && <div className="msb-panel__empty">Reading the entries...</div>}

      {plan && (
        <>
          {plan.moves.length > 0 && (
            <>
              <div className="msb-panel__hint" style={{ marginTop: 8 }}>
                Only the entry&apos;s Update set field changes. The records themselves are not touched.
              </div>
              <ul>
                {plan.moves.map((e) => (
                  <li key={e.sys_id}>
                    <strong>{e.target_name || e.name}</strong> ({e.type || 'entry'}) from "{e['update_set.name'] || '?'}" to "{preview.target.name}"
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan.skipped.length > 0 && (
            <ul>
              {plan.skipped.map(({ entry, reason }) => (
                <li key={entry.sys_id}>
                  {entry.target_name || entry.name}: {reason}
                </li>
              ))}
            </ul>
          )}
          {plan.blocked.length > 0 && (
            <ul>
              {plan.blocked.map(({ entry, reason }) => (
                <li key={entry.sys_id} className="msb-mw-confirm__blocked">
                  {entry.target_name || entry.name}: {reason}
                </li>
              ))}
            </ul>
          )}
          {plan.blocked.length > 0 && <div className="msb-panel__warning">Nothing moves while any entry is blocked. Pick another set.</div>}
          {(plan.warnings || []).map((w) => (
            <div key={w} className="msb-panel__warning">
              {w}
            </div>
          ))}
          {preview.guarded && plan.moves.length > 0 && plan.blocked.length === 0 && (
            <label className="msb-mw-confirm__typed">
              {preview.env === 'prod' ? 'This is a production instance.' : 'This instance is not recognisably dev, test or stage.'} Type
              its name ({preview.instance}) to confirm.
              <input value={typed} onChange={trusted((e) => setTyped(e.target.value))} placeholder={preview.instance} aria-label="Instance name" />
            </label>
          )}
        </>
      )}

      {error && <div className="msb-panel__error">{error}</div>}

      <div className="msb-panel__actions">
        <button className="msb-panel__run" onClick={trusted(handleMove)} disabled={!canMove || busy}>
          {busy && plan ? 'Moving...' : moveCount ? `Move ${moveCount} ${moveCount === 1 ? 'entry' : 'entries'}` : 'Move'}
        </button>
        <button className="msb-panel__secondary" onClick={onCancel} disabled={busy && Boolean(plan)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
