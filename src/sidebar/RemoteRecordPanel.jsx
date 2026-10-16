import React, { useEffect, useState } from 'react';
import { remoteRecordUrl } from '../content/remoteRecord.js';
import { FieldChanges } from './DiffView.jsx';
import PushArtifact from './PushArtifact.jsx';

/** A known-instance label ("prod") or a short name ("dev123") becomes a full host. */
function resolveHost(text, known) {
  const value = String(text || '').trim();
  if (!value) return '';
  const byLabel = known.find((i) => String(i.label || '').toLowerCase() === value.toLowerCase());
  if (byLabel) return byLabel.host;
  return /[.:/]/.test(value) ? value : `${value}.service-now.com`;
}

/**
 * Compare the record on screen with the same record on another instance, and
 * optionally push it there (preview first). `initialHost` and `pushFirst` come
 * from the /push command.
 */
export default function RemoteRecordPanel({ context, services, onClose, initialHost = '', pushFirst = false }) {
  const [host, setHost] = useState(initialHost);
  const [known, setKnown] = useState([]);
  const [knownLoaded, setKnownLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [pushHost, setPushHost] = useState(pushFirst && initialHost.trim() ? initialHost.trim() : '');

  useEffect(() => {
    Promise.resolve(services.listInstances?.())
      .then((list) => setKnown(Array.isArray(list) ? list : []))
      .catch(() => {})
      .finally(() => setKnownLoaded(true));
  }, [services]);

  const hasRecord = context?.table && context?.sysId;

  async function handleCompare() {
    setBusy(true);
    setError(null);
    setResult(null);
    setPushHost('');
    try {
      setResult(await services.compareWithInstance({ host: resolveHost(host, known), table: context.table, sysId: context.sysId }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function openThere(sysId) {
    try {
      window.open(remoteRecordUrl(result?.host || resolveHost(host, known), context.table, sysId), '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>{pushFirst ? 'Push to another instance' : 'Same record on another instance'}</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className="msb-panel__form">
        {!hasRecord && <div className="msb-panel__warning">Open a saved record first.</div>}

        <label>
          Instance
          <input
            list="msb-known-instances"
            value={host}
            onChange={(e) => {
              setHost(e.target.value);
              setPushHost('');
            }}
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
          Compare reads one record, using your session on that instance or the credentials saved for it in Options. Push shows a
          preview and writes nothing until you confirm.
        </div>

        <div className="msb-panel__actions">
          <button className="msb-panel__run" onClick={handleCompare} disabled={busy || !hasRecord || !host.trim()}>
            {busy ? 'Comparing...' : 'Compare'}
          </button>
          <button
            className="msb-panel__secondary"
            onClick={() => setPushHost(host.trim())}
            disabled={busy || !hasRecord || !host.trim() || pushHost === host.trim()}
          >
            Push this record...
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

      {hasRecord && pushHost && knownLoaded && (
        <PushArtifact
          key={`${resolveHost(pushHost, known)}|${context.table}|${context.sysId}`}
          table={context.table}
          sysId={context.sysId}
          targetHost={resolveHost(pushHost, known)}
          services={services}
          recordName={context.title || ''}
          onClose={() => setPushHost('')}
        />
      )}

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
