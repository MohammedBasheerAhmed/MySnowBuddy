import React, { useEffect, useMemo, useRef, useState } from 'react';
import { parseUsageTarget, KIND_ORDER, KIND_TEXT, CERTAINTY_ORDER, CERTAINTY_TEXT, usageToMarkdown, usagePrompt } from '../lib/fieldUsage.js';

/** What to look up: `/usage incident.state` wins; otherwise the table on screen, waiting for a field. */
function startFrom(context, params) {
  const args = String(params?.args || '').trim();
  const parsed = parseUsageTarget(args);
  if (parsed) return { table: parsed.table, field: parsed.field, run: true };
  if (args && /^[a-z][a-z0-9_]*$/i.test(args)) return { table: args.toLowerCase(), field: '', run: false };
  return { table: context?.table || '', field: '', run: false };
}

function Item({ item }) {
  const shown = item.uses.slice(0, 3);
  return (
    <li className="msb-impact__item">
      <div className="msb-impact__item-head">
        {item.url ? (
          <a className="msb-panel__link" href={item.url} target="_blank" rel="noopener noreferrer">
            {item.name}
          </a>
        ) : (
          <span>{item.name}</span>
        )}
        <span className="msb-impact__tag">{item.label}</span>
        {item.certainty !== 'direct' && <span className="msb-impact__muted">{CERTAINTY_TEXT[item.certainty]}</span>}
      </div>
      {item.detail && <div className="msb-impact__muted">{item.detail}</div>}
      {shown.length > 0 && (
        <pre className="msb-impact__code">
          {shown.map((u) => `${item.field}:${u.line}  ${u.text}`).join('\n')}
          {item.uses.length > shown.length ? `\n… ${item.uses.length - shown.length} more` : ''}
        </pre>
      )}
    </li>
  );
}

/**
 * Where is this field used? Scripts that set, read, query or change it on the form, and the configuration that
 * controls it (UI policies, ACLs, data policies, dictionary overrides). Read-only; it asks only when you press Find.
 */
export default function FieldUsagePanel({ context, params, services, onClose, onAskAi }) {
  const start = useMemo(() => startFrom(context, params), [context, params]);
  const [table, setTable] = useState(start.table);
  const [field, setField] = useState(start.field);
  const [fields, setFields] = useState([]);
  const [state, setState] = useState({ status: 'idle' });
  const [only, setOnly] = useState('all');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);

  // The field names of the table, for the suggestions under the box.
  useEffect(() => {
    let live = true;
    if (!/^[a-z][a-z0-9_]*$/i.test(table)) {
      setFields([]);
      return undefined;
    }
    const t = setTimeout(() => {
      services.fieldUsageFields?.(table.toLowerCase()).then((list) => live && setFields(list || []), () => live && setFields([]));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [table, services]);

  async function run(next = { table, field }) {
    const target = parseUsageTarget(`${next.table}.${next.field}`);
    if (!target) {
      setState({ status: 'error', error: 'Give a table and a field, for example incident and state.' });
      return;
    }
    generation.current += 1;
    const mine = generation.current;
    setOnly('all');
    setState({ status: 'loading' });
    try {
      const data = await services.fieldUsage(target);
      if (mine === generation.current) setState({ status: 'done', data });
    } catch (err) {
      if (mine === generation.current) setState({ status: 'error', error: err.message || String(err) });
    }
  }

  // Opened (or opened again while showing) with a table.field: fill the boxes and look it up.
  useEffect(() => {
    setTable(start.table);
    setField(start.field);
    if (start.run) run({ table: start.table, field: start.field });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start.table, start.field, start.run]);

  function flash(text) {
    setNotice(text);
    setTimeout(() => setNotice(''), 3000);
  }

  const data = state.status === 'done' ? state.data : null;
  const items = data ? data.items : [];
  const shown = only === 'all' ? items : items.filter((i) => i.kind === only);
  const kinds = KIND_ORDER.filter((k) => items.some((i) => i.kind === k));
  const groups = [...new Set(shown.map((i) => i.certainty))].sort((a, b) => CERTAINTY_ORDER[a] - CERTAINTY_ORDER[b]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(usageToMarkdown(data.target, shown, data.headline));
      flash('Copied as a Markdown table.');
    } catch {
      flash('The browser blocked the copy. Click in the page first, then try again.');
    }
  }

  return (
    <div className="msb-panel msb-usage">
      <div className="msb-panel__header">
        <strong>Where is this field used?</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>
      <form
        className="msb-usage__form"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <label className="msb-usage__label">
          Table
          <input className="msb-panel__input" value={table} onChange={(e) => setTable(e.target.value.trim())} placeholder="incident" spellCheck="false" autoCapitalize="off" />
        </label>
        <label className="msb-usage__label">
          Field
          <input className="msb-panel__input" value={field} onChange={(e) => setField(e.target.value.trim())} placeholder="state" list="msb-usage-fields" spellCheck="false" autoCapitalize="off" />
        </label>
        <datalist id="msb-usage-fields">
          {fields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.label}
            </option>
          ))}
        </datalist>
        <button className="msb-panel__primary" type="submit" disabled={state.status === 'loading'}>
          Find
        </button>
      </form>
      <div className="msb-panel__hint">Finds scripts that set, read or query the field, and the policies, ACLs and rules that control it. Read-only.</div>
      {notice && (
        <div className="msb-panel__hint" role="status">
          {notice}
        </div>
      )}

      {state.status === 'loading' && (
        <div className="msb-impact__busy" aria-live="polite">
          Searching scripts and configuration...
        </div>
      )}
      {state.status === 'error' && <div className="msb-panel__error">{state.error}</div>}

      {data && (
        <>
          <p className="msb-usage__headline" aria-live="polite">
            {data.headline}
          </p>
          {kinds.length > 1 && (
            <div className="msb-usage__filters" role="radiogroup" aria-label="Show only">
              {['all', ...kinds].map((k) => (
                <button key={k} type="button" role="radio" aria-checked={only === k} className="msb-usage__filter" onClick={() => setOnly(k)}>
                  {k === 'all' ? `All ${items.length}` : `${KIND_TEXT[k]} ${items.filter((i) => i.kind === k).length}`}
                </button>
              ))}
            </div>
          )}
          {groups.map((certainty) => (
            <section key={certainty} aria-label={CERTAINTY_TEXT[certainty]}>
              <h4 className="msb-usage__group">{CERTAINTY_TEXT[certainty]}</h4>
              <ul className="msb-impact__list">
                {shown
                  .filter((i) => i.certainty === certainty)
                  .map((item) => (
                    <Item key={`${item.table}:${item.sysId}:${item.field}:${item.label}`} item={item} />
                  ))}
              </ul>
            </section>
          ))}
          {data.notes.length > 0 && (
            <details className="msb-usage__notes">
              <summary>{data.notes.length} source{data.notes.length === 1 ? '' : 's'} could not be read</summary>
              <ul>
                {data.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </details>
          )}
          {items.length > 0 && (
            <div className="msb-panel__actions">
              <button className="msb-panel__secondary" onClick={copy}>
                Copy as table
              </button>
              <button className="msb-panel__secondary" onClick={() => onAskAi?.(`Where ${data.target.table}.${data.target.field} is used`, usagePrompt(data.target, shown))}>
                Ask AI about this
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
