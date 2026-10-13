import React, { useEffect, useState } from 'react';
import { remoteRecordUrl } from '../content/remoteRecord.js';
import { FieldChanges } from './DiffView.jsx';

/** Compare the record on screen with the same record on another instance. */
export default function RemoteRecordPanel({ context, services, onClose }) {
  const [host, setHost] = useState('');
  const [known, setKnown] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    services.listInstances?.().then(setKnown).catch(() => {});
  }, [services]);

  const hasRecord = context?.table && context?.sysId;

  async function handleCompare() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await services.compareWithInstance({ host, table: context.table, sysId: context.sysId }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function openThere(sysId) {
    window.open(remoteRecordUrl(result?.host || host, context.table, sysId), '_blank', 'noopener,noreferrer');
  }

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Same record on another instance</strong>
        <button onClick={onClose} aria-label="Close">
          {'\u2715'}
        </button>
      </div>

      <div className="msb-panel__form">
        {!hasRecord && <div className="msb-panel__warning">Open a saved record first.</div>}

        <label>
          Instance
          <input
            list="msb-known-instances"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="myinstance-dev.service-now.com"
          />
          <datalist id="msb-known-instances">
            {known.map((i) => (
              <option key={i.host} value={i.host}>
                {i.label}
              </option>
            ))}
          </datalist>
        </label>

        <div className="msb-panel__hint">
          Reads one record, using your session on that instance or the credentials saved for it in Options.
          Nothing is written.
        </div>

        <div className="msb-panel__actions">
          <button className="msb-panel__run" onClick={handleCompare} disabled={busy || !hasRecord || !host.trim()}>
            {busy ? 'Comparing...' : 'Compare'}
          </button>
          <button
            className="msb-panel__secondary"
            onClick={() => openThere(context.sysId)}
            disabled={!hasRecord || !host.trim()}
          >
            Open there
          </button>
        </div>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}

      {result && !result.found && (
        <div className="msb-panel__warning">
          This record does not exist on {result.host} (looked up by sys_id and by name).
        </div>
      )}

      {result?.found && (
        <>
          <div className="msb-panel__hint">
            Matched by {result.matchedBy} on {result.host}. {result.changes.length} field(s) differ.
          </div>
          <FieldChanges changes={result.changes} />
          {result.matchedBy === 'name' && (
            <button className="msb-panel__secondary" onClick={() => openThere(result.remoteSysId)}>
              Open the matching record
            </button>
          )}
        </>
      )}
    </div>
  );
}
