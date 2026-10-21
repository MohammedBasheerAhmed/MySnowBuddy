import React, { useEffect, useState } from 'react';
import { FieldChanges } from './DiffView.jsx';

/** Version history of the open record, with a field-level diff between any two versions. */
export default function VersionPanel({ context, services, onClose }) {
  const [versions, setVersions] = useState(null);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [changes, setChanges] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!context?.table || !context?.sysId) {
      setError('Open a saved record first.');
      return undefined;
    }
    services
      .fetchVersionList(context.table, context.sysId)
      .then((rows) => {
        if (cancelled) return;
        setVersions(rows);
        // Newest first: compare the latest two by default.
        if (rows.length > 1) {
          setToId(rows[0].sys_id);
          setFromId(rows[1].sys_id);
        }
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [services, context?.table, context?.sysId]);

  async function handleCompare() {
    setBusy(true);
    setError(null);
    setChanges(null);
    try {
      setChanges(await services.diffVersions(fromId, toId));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const label = (v) => `${v.sys_created_on || v.sys_recorded_at} - ${v.sys_created_by}${v.state ? ` (${v.state})` : ''}`;

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Version history</strong>
        <button onClick={onClose} aria-label="Close">
          {'\u2715'}
        </button>
      </div>

      <div className="msb-panel__form">
        {versions && versions.length < 2 && (
          <div className="msb-panel__warning">This record has fewer than two versions to compare.</div>
        )}

        {versions?.length > 1 && (
          <>
            <label>
              Older version
              <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
                {versions.map((v) => (
                  <option key={v.sys_id} value={v.sys_id}>
                    {label(v)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Newer version
              <select value={toId} onChange={(e) => setToId(e.target.value)}>
                {versions.map((v) => (
                  <option key={v.sys_id} value={v.sys_id}>
                    {label(v)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="msb-panel__run"
              onClick={handleCompare}
              disabled={busy || !fromId || !toId || fromId === toId}
            >
              {busy ? 'Comparing...' : 'Show changes'}
            </button>
          </>
        )}
      </div>

      {error && <div className="msb-panel__error">{error}</div>}
      {changes && <FieldChanges changes={changes} />}
    </div>
  );
}
