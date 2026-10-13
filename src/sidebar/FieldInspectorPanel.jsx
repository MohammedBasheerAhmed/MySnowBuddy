import React, { useEffect, useMemo, useState } from 'react';

/** Dictionary details for every field of a table, plus the live state of a field on the open form. */
export default function FieldInspectorPanel({ context, services, onClose }) {
  const [table, setTable] = useState(context?.table || '');
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('');
  const [live, setLive] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function load(name = table) {
    setBusy(true);
    setError(null);
    setLive(null);
    try {
      setData(await services.fetchTableFields(name.trim()));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (context?.table) load(context.table);
    // Load once for the table the panel opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => {
    if (!data) return [];
    const needle = filter.trim().toLowerCase();
    return needle
      ? data.fields.filter((f) => f.name.toLowerCase().includes(needle) || (f.label || '').toLowerCase().includes(needle))
      : data.fields;
  }, [data, filter]);

  async function showLive(name) {
    setLive({ name, state: await services.fetchFieldLive(name) });
  }

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Field inspector</strong>
        <button onClick={onClose} aria-label="Close">
          {'\u2715'}
        </button>
      </div>

      <div className="msb-panel__form">
        <div className="msb-panel__row">
          <input
            value={table}
            onChange={(e) => setTable(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="Table name"
            aria-label="Table name"
          />
          <button className="msb-panel__run" onClick={() => load()} disabled={busy || !table.trim()}>
            {busy ? 'Loading...' : 'Load'}
          </button>
        </div>
        {data && (
          <>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${data.fields.length} fields`}
              aria-label="Filter fields"
            />
            <div className="msb-panel__hint">Extends: {data.tables.join(' > ')}</div>
          </>
        )}
      </div>

      {error && <div className="msb-panel__error">{error}</div>}

      {live && (
        <div className="msb-panel__result">
          <div className="msb-panel__result-body">
            <strong>{live.name}</strong> on the open form:
            {live.state ? (
              <pre className="msb-panel__snippet">
                {`value:    ${live.state.value}\ndisplay:  ${live.state.displayValue}\nmandatory: ${live.state.mandatory}\nread-only: ${live.state.readOnly}\nvisible:   ${live.state.visible}`}
              </pre>
            ) : (
              <div className="msb-panel__hint">This field is not on the open form.</div>
            )}
          </div>
        </div>
      )}

      {data && !visible.length && <div className="msb-panel__empty">No fields match.</div>}

      {visible.map((f) => (
        <div key={f.name} className="msb-panel__result msb-field">
          <div className="msb-field__top">
            <button
              className="msb-panel__link"
              title="Copy field name"
              onClick={() => navigator.clipboard?.writeText(f.name)}
            >
              {f.name}
            </button>
            <span className="msb-panel__badge">{f.type}</span>
          </div>
          <div className="msb-field__meta">
            {f.label}
            {f.reference ? ` - references ${f.reference}` : ''}
            {f.maxLength ? ` - max ${f.maxLength}` : ''}
            {f.mandatory ? ' - mandatory' : ''}
            {f.readOnly ? ' - read-only' : ''}
            {f.defaultValue ? ` - default: ${f.defaultValue}` : ''}
            {f.definedOn !== table.trim() ? ` - from ${f.definedOn}` : ''}
          </div>
          {context?.sysId && (
            <button className="msb-panel__link" onClick={() => showLive(f.name)}>
              Show on the open form
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
