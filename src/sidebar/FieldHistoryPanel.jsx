import React, { useEffect, useState } from 'react';
import { timelineToMarkdown, historyPrompt } from '../lib/fieldHistory.js';

const SYS_ID = /^[0-9a-f]{32}$/i;

/** Who changed this value, and when? One field of the record on screen as a timeline (`/history state`). Read-only. */
export default function FieldHistoryPanel({ context, params, services, onClose, onAskAi }) {
  const initial = String(params?.args || '').trim().toLowerCase();
  const [field, setField] = useState(initial);
  const [fields, setFields] = useState([]);
  const [state, setState] = useState({ status: 'idle' });
  const [notice, setNotice] = useState('');
  const table = context?.table || '';
  const sysId = context?.sysId || '';
  const hasRecord = Boolean(table && SYS_ID.test(sysId));

  useEffect(() => {
    if (!hasRecord) return undefined;
    let live = true;
    services.fieldUsageFields?.(table).then((list) => live && setFields(list || []), () => {});
    return () => {
      live = false;
    };
  }, [table, hasRecord, services]);

  async function run(name = field) {
    setState({ status: 'loading' });
    try {
      setState({ status: 'done', data: await services.fieldHistory({ table, sysId, field: name.trim().toLowerCase() }) });
    } catch (err) {
      setState({ status: 'error', error: err.message || String(err) });
    }
  }

  // Opened with `/history state`: look it up right away.
  useEffect(() => {
    setField(initial);
    if (initial && hasRecord) run(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, sysId]);

  function flash(text) {
    setNotice(text);
    setTimeout(() => setNotice(''), 3000);
  }

  const data = state.status === 'done' ? state.data : null;
  const record = context?.number || sysId.slice(0, 8);

  async function copy() {
    try {
      await navigator.clipboard.writeText(timelineToMarkdown({ table, record, field: data.field }, data.timeline));
      flash('Copied as a Markdown table.');
    } catch {
      flash('The browser blocked the copy. Click in the page first, then try again.');
    }
  }

  return (
    <div className="msb-panel msb-hist">
      <div className="msb-panel__header">
        <strong>History of a field</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      {!hasRecord ? (
        <div className="msb-panel__empty">Open a saved record first. Then name a field to see every change to it: who, when, and how long each value stayed.</div>
      ) : (
        <>
          <form
            className="msb-vs__form"
            onSubmit={(e) => {
              e.preventDefault();
              if (field.trim()) run();
            }}
          >
            <label className="msb-vs__label">
              Field on {table}
              <input className="msb-panel__input" value={field} onChange={(e) => setField(e.target.value.trim())} placeholder="state" list="msb-hist-fields" spellCheck="false" autoCapitalize="off" />
            </label>
            <datalist id="msb-hist-fields">
              {fields.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label}
                </option>
              ))}
            </datalist>
            <button className="msb-panel__primary" type="submit" disabled={state.status === 'loading' || !field.trim()}>
              Show
            </button>
          </form>
          <div className="msb-panel__hint">Read from the audit trail, so only fields that are audited have a history. Times are UTC.</div>
        </>
      )}
      {notice && (
        <div className="msb-panel__hint" role="status">
          {notice}
        </div>
      )}
      {state.status === 'loading' && (
        <div className="msb-impact__busy" aria-live="polite">
          Reading the audit trail...
        </div>
      )}
      {state.status === 'error' && <div className="msb-panel__error">{state.error}</div>}

      {data && (
        <>
          <p className="msb-usage__headline" aria-live="polite">
            {data.summary}
          </p>
          {data.capped && <div className="msb-panel__hint">Only the first 500 changes are shown.</div>}
          {data.timeline.length > 0 && (
            <ol className="msb-hist__list" aria-label={`Changes to ${data.field}`}>
              {data.timeline.map((t, i) => (
                <li key={`${t.at}-${i}`} className={`msb-hist__item${t.bounced ? ' msb-hist__item--bounce' : ''}`}>
                  <div className="msb-hist__change">
                    <span className="msb-hist__from">{t.from || '(empty)'}</span>
                    <span> {'→'} </span>
                    <strong className="msb-hist__to">{t.to || '(empty)'}</strong>
                    {t.bounced && <span className="msb-impact__tag">went straight back</span>}
                  </div>
                  <div className="msb-impact__muted">
                    {t.at} UTC by {t.user || '(system)'}
                    {t.held ? `, held ${t.held}${i === data.timeline.length - 1 ? ' so far' : ''}` : ''}
                    {t.reason ? `, ${t.reason}` : ''}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {data.timeline.length > 0 && (
            <div className="msb-panel__actions">
              <button className="msb-panel__secondary" onClick={copy}>
                Copy as table
              </button>
              <button className="msb-panel__secondary" onClick={() => onAskAi?.(`History of ${table}.${data.field}`, historyPrompt({ table, record, field: data.field }, data.timeline))}>
                Ask AI about the pattern
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
