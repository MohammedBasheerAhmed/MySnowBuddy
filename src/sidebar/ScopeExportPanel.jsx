import React, { useEffect, useState } from 'react';

/** Export every script in an application scope as a ZIP of plain files. */
export default function ScopeExportPanel({ services, onClose }) {
  const [search, setSearch] = useState('');
  const [scopes, setScopes] = useState(null);
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    setError(null);
    try {
      const rows = await services.fetchScopes(search);
      setScopes(rows);
      setScope(rows[0]?.scope || '');
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // Initial load only; searching is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleExport() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const out = await services.exportScope(scope, { onProgress: setStatus });
      if (!out.artifactCount) throw new Error('No scripted artifacts were found in that scope.');
      services.downloadScopeZip(scope, out.files);
      setResult(out);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Export a scope</strong>
        <button onClick={onClose} aria-label="Close">
          {'\u2715'}
        </button>
      </div>

      <div className="msb-panel__form">
        <div className="msb-panel__row">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="Search by name or scope (blank: custom apps)"
            aria-label="Search scopes"
          />
          <button className="msb-panel__secondary" onClick={load} disabled={busy}>
            Search
          </button>
        </div>

        <label>
          Scope
          <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={busy}>
            {scopes && !scopes.length && <option value="">No scopes found</option>}
            {scopes?.map((s) => (
              <option key={s.sys_id} value={s.scope}>
                {s.name} ({s.scope})
              </option>
            ))}
          </select>
        </label>

        <div className="msb-panel__hint">
          Reads scripts, one table at a time, and downloads one file per script plus a metadata file. Handy for
          code review, grep and git. Nothing on the instance changes.
        </div>

        <button className="msb-panel__run" onClick={handleExport} disabled={busy || !scope}>
          {busy ? 'Exporting...' : 'Export to ZIP'}
        </button>
      </div>

      {status && <div className="msb-panel__hint">{status}</div>}
      {error && <div className="msb-panel__error">{error}</div>}

      {result && (
        <div className="msb-panel__result">
          <div className="msb-panel__result-body">
            Exported {result.artifactCount} artifact(s) as {result.files.length} file(s).
            {result.truncated.length > 0 && (
              <div className="msb-panel__warning">
                Capped at 2000 records for: {result.truncated.join(', ')}. The export is incomplete for these.
              </div>
            )}
            {result.skipped.length > 0 && (
              <div className="msb-panel__hint">Could not read: {result.skipped.join(', ')}.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
