import React, { useEffect, useState } from 'react';
import { DiffView } from './DiffView.jsx';
import { compareToMarkdown, comparePrompt } from '../lib/recordCompare.js';

const SYS_ID = /^[0-9a-f]{32}$/i;

/** Compare the record on screen with another record of the same table (`/vs INC0010002`). Read-only. */
export default function RecordComparePanel({ context, params, services, onClose, onAskAi }) {
  const initial = String(params?.args || '').trim();
  const [other, setOther] = useState(initial);
  const [includeSystem, setIncludeSystem] = useState(false);
  const [state, setState] = useState({ status: 'idle' });
  const [notice, setNotice] = useState('');
  // From a list with two ticked rows the first row is `params.left`; otherwise it is the record on screen.
  const subject = params?.left ? { table: params.table, sysId: params.left } : { table: context?.table, sysId: context?.sysId };
  const hasRecord = Boolean(subject.table && SYS_ID.test(subject.sysId || ''));
  const key = `${subject.table}:${subject.sysId}`;

  async function run(next = other, system = includeSystem) {
    setState({ status: 'loading' });
    try {
      const data = await services.compareWithRecord({ table: subject.table, sysId: subject.sysId, other: next, includeSystem: system });
      setState({ status: 'done', data });
    } catch (err) {
      setState({ status: 'error', error: err.message || String(err) });
    }
  }

  // Opened with `/vs INC0010002`: compare right away.
  useEffect(() => {
    setOther(initial);
    if (initial && hasRecord) run(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, key]);

  function flash(text) {
    setNotice(text);
    setTimeout(() => setNotice(''), 3000);
  }

  const data = state.status === 'done' ? state.data : null;
  const names = data && { table: data.table, left: data.left.label, right: data.right.label };
  const short = data ? data.changes.filter((c) => !c.long) : [];
  const long = data ? data.changes.filter((c) => c.long) : [];

  async function copy() {
    try {
      await navigator.clipboard.writeText(compareToMarkdown(names, data));
      flash('Copied as a Markdown table.');
    } catch {
      flash('The browser blocked the copy. Click in the page first, then try again.');
    }
  }

  return (
    <div className="msb-panel msb-vs">
      <div className="msb-panel__header">
        <strong>Compare with another record</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      {!hasRecord ? (
        <div className="msb-panel__empty">Open a saved record first. Then type a second record of the same table to see which fields differ.</div>
      ) : (
        <>
          <form
            className="msb-vs__form"
            onSubmit={(e) => {
              e.preventDefault();
              run();
            }}
          >
            <label className="msb-vs__label">
              Compare {subject.table} with
              <input className="msb-panel__input" value={other} onChange={(e) => setOther(e.target.value)} placeholder="INC0010002, a sys_id or a name" spellCheck="false" autoCapitalize="off" />
            </label>
            <button className="msb-panel__primary" type="submit" disabled={state.status === 'loading' || !other.trim()}>
              Compare
            </button>
          </form>
          <label className="msb-vs__check">
            <input
              type="checkbox"
              checked={includeSystem}
              onChange={(e) => {
                setIncludeSystem(e.target.checked);
                if (data) run(other, e.target.checked);
              }}
            />
            Include bookkeeping fields (created, updated, counters)
          </label>
          <div className="msb-panel__hint">Read-only. Both records are read as you, so a field you cannot see is missing on both sides.</div>
        </>
      )}
      {notice && (
        <div className="msb-panel__hint" role="status">
          {notice}
        </div>
      )}
      {state.status === 'loading' && (
        <div className="msb-impact__busy" aria-live="polite">
          Reading both records...
        </div>
      )}
      {state.status === 'error' && <div className="msb-panel__error">{state.error}</div>}

      {data && (
        <>
          <p className="msb-usage__headline" aria-live="polite">
            {data.headline}
          </p>
          {short.length > 0 && (
            <div className="msb-table-wrap">
              <table className="msb-table msb-vs__table">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">{data.left.label}</th>
                    <th scope="col">{data.right.label}</th>
                  </tr>
                </thead>
                <tbody>
                  {short.map((c) => (
                    <tr key={c.name}>
                      <th scope="row" className="msb-vs__field">
                        {c.name}
                      </th>
                      <td>{c.before || <span className="msb-impact__muted">(empty)</span>}</td>
                      <td>{c.after || <span className="msb-impact__muted">(empty)</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {long.map((c) => (
            <details key={c.name} className="msb-panel__result">
              <summary className="msb-panel__result-toggle">{c.name}</summary>
              <div className="msb-panel__result-body">{c.rows.length ? <DiffView rows={c.rows} /> : <div className="msb-panel__hint">Whitespace-only change.</div>}</div>
            </details>
          ))}
          {data.changes.length > 0 && (
            <div className="msb-panel__actions">
              <button className="msb-panel__secondary" onClick={copy}>
                Copy as table
              </button>
              <button className="msb-panel__secondary" onClick={() => onAskAi?.(`${data.table}: ${names.left} vs ${names.right}`, comparePrompt(names, data))}>
                Ask AI why they differ
              </button>
              <a className="msb-panel__link" href={`/${data.table}.do?sys_id=${data.right.sysId}`} target="_blank" rel="noopener noreferrer">
                Open {data.right.label}
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}
