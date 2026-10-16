import React, { useEffect, useMemo, useState } from 'react';

const copy = (text) => navigator.clipboard?.writeText(String(text));

const CHOICE_LABEL = { 1: 'choice list', 3: 'suggestion list' };

/** Everything about one column: help text, attributes, overrides and the choice list. */
function ColumnDetail({ detail }) {
  const facts = [
    detail.definedOn !== detail.table && `defined on ${detail.definedOn}`,
    detail.scope && `scope ${detail.scope}`,
    detail.maxLength && `max length ${detail.maxLength}`,
    detail.reference && `references ${detail.reference}`,
    detail.defaultValue && `default: ${detail.defaultValue}`,
    detail.calculation && 'calculated',
    detail.dependent && `dependent on ${detail.dependent}`,
    detail.virtual && 'virtual',
    detail.array && 'array',
    detail.primary && 'primary key',
  ].filter(Boolean);
  const flags = [detail.mandatory && 'mandatory', detail.readOnly && 'read-only', detail.unique && 'unique', detail.display && 'display value', detail.audit && 'audited', !detail.active && 'inactive'].filter(Boolean);

  return (
    <div className="msb-xp__detail">
      {facts.length > 0 && <div className="msb-field__meta">{facts.join(' · ')}</div>}
      {flags.length > 0 && <div className="msb-field__meta">{flags.join(' · ')}</div>}
      {(detail.hint || detail.help) && (
        <div className="msb-xp__doc">
          {detail.hint && <div>{detail.hint}</div>}
          {detail.help && <div className="msb-panel__hint">{detail.help}</div>}
        </div>
      )}
      {detail.calculation && <pre className="msb-panel__snippet">{detail.calculation}</pre>}

      {detail.attributes.length > 0 && (
        <div className="msb-xp__section">
          <div className="msb-xp__caption">Attributes</div>
          <div className="msb-xp__chips">
            {detail.attributes.map((a) => (
              <span key={a.name} className="msb-chip" title={a.value ? `${a.name}=${a.value}` : a.name}>
                {a.value ? `${a.name}=${a.value}` : a.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {detail.overrides.length > 0 && (
        <div className="msb-xp__section">
          <div className="msb-xp__caption">Dictionary overrides</div>
          {detail.overrides.map((o) => (
            <div key={`${o.table}-${o.baseTable}`} className="msb-field__meta">
              {o.table}
              {o.baseTable && o.baseTable !== o.table ? ` (from ${o.baseTable})` : ''}: {o.changes.length ? o.changes.join(', ') : 'no visible changes'}
            </div>
          ))}
        </div>
      )}

      {detail.choiceType && (
        <div className="msb-xp__section">
          <div className="msb-xp__caption">
            {CHOICE_LABEL[detail.choiceType] || 'choices'} ({detail.choices.length})
            {detail.choices.length > 0 && (
              <>
                {' '}
                <button className="msb-panel__link" onClick={() => copy(JSON.stringify(detail.choices.map(({ value, label, sequence }) => ({ value, label, sequence })), null, 2))}>
                  Copy JSON
                </button>
              </>
            )}
          </div>
          {detail.choices.length === 0 ? (
            <div className="msb-panel__hint">No choices were returned (the list may come from a reference, or your role cannot read sys_choice).</div>
          ) : (
            <table className="msb-xp__table">
              <thead>
                <tr>
                  <th>Value</th>
                  <th>Label</th>
                  <th>Order</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {detail.choices.map((c) => (
                  <tr key={`${c.definedOn}-${c.value}-${c.dependentValue}`} className={c.inactive ? 'msb-xp__inactive' : undefined}>
                    <td>
                      <button className="msb-panel__link" title="Copy value" onClick={() => copy(c.value)}>
                        {c.value === '' ? '(empty)' : c.value}
                      </button>
                    </td>
                    <td>{c.label}</td>
                    <td>{c.sequence}</td>
                    <td>{[c.inactive && 'inactive', c.dependentValue && `when ${c.dependentValue}`].filter(Boolean).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/** Table facts, every column's dictionary entry (with choices), and the list layouts of a table. */
export default function FieldInspectorPanel({ context, services, onClose }) {
  const [table, setTable] = useState(context?.table || '');
  const [loaded, setLoaded] = useState('');
  const [data, setData] = useState(null);
  const [info, setInfo] = useState(null);
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState('columns');
  const [layouts, setLayouts] = useState(null);
  const [open, setOpen] = useState({}); // column name -> { state: 'loading' | 'ready' | 'error', detail?, error? }
  const [live, setLive] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function load(name = table) {
    const wanted = name.trim();
    setBusy(true);
    setError(null);
    setLive(null);
    setOpen({});
    setLayouts(null);
    setInfo(null);
    setTab('columns');
    try {
      const [fields, tableInfo] = await Promise.all([services.fetchTableFields(wanted), services.fetchTableInfo ? services.fetchTableInfo(wanted).catch(() => null) : null]);
      setData(fields);
      setInfo(tableInfo);
      setLoaded(wanted);
      setTable(wanted);
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
    return needle ? data.fields.filter((f) => f.name.toLowerCase().includes(needle) || (f.label || '').toLowerCase().includes(needle) || (f.type || '').toLowerCase().includes(needle)) : data.fields;
  }, [data, filter]);

  async function toggleColumn(name) {
    if (open[name]) {
      setOpen((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      return;
    }
    setOpen((prev) => ({ ...prev, [name]: { state: 'loading' } }));
    try {
      const detail = await services.fetchColumnDetail(loaded, name);
      setOpen((prev) => (prev[name] ? { ...prev, [name]: { state: 'ready', detail } } : prev));
    } catch (err) {
      setOpen((prev) => (prev[name] ? { ...prev, [name]: { state: 'error', error: err.message } } : prev));
    }
  }

  async function showLayouts() {
    setTab('layouts');
    if (layouts || !services.fetchListLayout) return;
    try {
      setLayouts(await services.fetchListLayout(loaded));
    } catch (err) {
      setLayouts([]);
      setError(err.message);
    }
  }

  async function showLive(name) {
    setLive({ name, state: await services.fetchFieldLive(name) });
  }

  const copyAll = () =>
    copy(
      JSON.stringify(
        {
          table: info ? { name: info.name, label: info.label, plural: info.plural, parent: info.parent, scope: info.scope, numberPrefix: info.numberPrefix } : { name: loaded },
          columns: (data?.fields || []).map((f) => ({ name: f.name, label: f.label, type: f.type, reference: f.reference || undefined, maxLength: f.maxLength || undefined, mandatory: f.mandatory, readOnly: f.readOnly, default: f.defaultValue || undefined, definedOn: f.definedOn })),
        },
        null,
        2
      )
    );

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Table explorer</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className="msb-panel__form">
        <div className="msb-panel__row">
          <input value={table} onChange={(e) => setTable(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && table.trim() && load()} placeholder="Table name" aria-label="Table name" />
          <button className="msb-panel__run" onClick={() => load()} disabled={busy || !table.trim()}>
            {busy ? 'Loading...' : 'Load'}
          </button>
        </div>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}

      {data && (
        <div className="msb-panel__result msb-xp__card">
          <div className="msb-field__top">
            <strong>{info?.label || loaded}</strong>
            <span className="msb-panel__badge">{loaded}</span>
            {info?.scope && <span className="msb-panel__badge">{info.scope}</span>}
          </div>
          <div className="msb-field__meta">
            {[
              info?.plural && `plural: ${info.plural}`,
              info?.numberPrefix && `number prefix ${info.numberPrefix}`,
              `${data.fields.length} columns`,
              info && (info.extendable ? 'extendable' : 'not extendable'),
              info?.access && `access: ${info.access}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          <div className="msb-field__meta">
            Extends:{' '}
            {data.tables.map((t, i) => (
              <React.Fragment key={t}>
                {i > 0 && ' > '}
                {i === 0 ? t : (
                  <button className="msb-panel__link" onClick={() => load(t)} title={`Open ${t}`}>
                    {t}
                  </button>
                )}
              </React.Fragment>
            ))}
          </div>
          {info?.children?.length > 0 && (
            <div className="msb-field__meta">
              Extended by:{' '}
              {info.children.slice(0, 12).map((c, i) => (
                <React.Fragment key={c.name}>
                  {i > 0 && ', '}
                  <button className="msb-panel__link" onClick={() => load(c.name)} title={c.label}>
                    {c.name}
                  </button>
                </React.Fragment>
              ))}
              {info.children.length > 12 ? ` and ${info.children.length - 12} more` : ''}
            </div>
          )}
          {info?.help && <div className="msb-panel__hint">{info.help}</div>}
          <div className="msb-xp__tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'columns'} className={tab === 'columns' ? 'msb-xp__tab msb-xp__tab--on' : 'msb-xp__tab'} onClick={() => setTab('columns')}>
              Columns
            </button>
            <button role="tab" aria-selected={tab === 'layouts'} className={tab === 'layouts' ? 'msb-xp__tab msb-xp__tab--on' : 'msb-xp__tab'} onClick={showLayouts}>
              List layouts
            </button>
            <button className="msb-panel__link msb-xp__copyall" onClick={copyAll} title="Copy the table and its columns as JSON">
              Copy JSON
            </button>
          </div>
        </div>
      )}

      {data && tab === 'columns' && (
        <div className="msb-panel__form">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${data.fields.length} columns by name, label or type`} aria-label="Filter columns" />
        </div>
      )}

      {live && (
        <div className="msb-panel__result">
          <div className="msb-panel__result-body">
            <strong>{live.name}</strong> on the open form:
            {live.state ? (
              <pre className="msb-panel__snippet">{`value:    ${live.state.value}\ndisplay:  ${live.state.displayValue}\nmandatory: ${live.state.mandatory}\nread-only: ${live.state.readOnly}\nvisible:   ${live.state.visible}`}</pre>
            ) : (
              <div className="msb-panel__hint">This field is not on the open form.</div>
            )}
          </div>
        </div>
      )}

      {data && tab === 'columns' && !visible.length && <div className="msb-panel__empty">No columns match.</div>}

      {tab === 'columns' &&
        visible.map((f) => {
          const entry = open[f.name];
          const badges = [f.display && 'display', f.unique && 'unique', f.choiceType && 'choices', f.calculated && 'calculated', f.audit && 'audit'].filter(Boolean);
          return (
            <div key={f.name} className="msb-panel__result msb-field">
              <div className="msb-field__top">
                <button className="msb-panel__link" title="Copy column name" onClick={() => copy(f.name)}>
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
                {f.definedOn !== loaded ? ` - from ${f.definedOn}` : ''}
              </div>
              {badges.length > 0 && (
                <div className="msb-xp__chips">
                  {badges.map((b) => (
                    <span key={b} className="msb-chip">
                      {b}
                    </span>
                  ))}
                </div>
              )}
              <div className="msb-xp__actions">
                <button className="msb-panel__link" onClick={() => toggleColumn(f.name)} aria-expanded={Boolean(entry)}>
                  {entry ? 'Hide details' : f.choiceType ? 'Details and choices' : 'Details'}
                </button>
                {context?.sysId && loaded === context.table && (
                  <button className="msb-panel__link" onClick={() => showLive(f.name)}>
                    Show on the open form
                  </button>
                )}
              </div>
              {entry?.state === 'loading' && <div className="msb-panel__hint">Loading...</div>}
              {entry?.state === 'error' && <div className="msb-panel__error">{entry.error}</div>}
              {entry?.state === 'ready' && <ColumnDetail detail={entry.detail} />}
            </div>
          );
        })}

      {data && tab === 'layouts' && (
        <>
          {!layouts && <div className="msb-panel__hint msb-xp__pad">Loading list layouts...</div>}
          {layouts && !layouts.length && <div className="msb-panel__empty">No default list layouts are defined for {loaded} (a parent table's layout is used).</div>}
          {layouts?.map((l) => (
            <div key={l.view} className="msb-panel__result msb-field">
              <div className="msb-field__top">
                <strong>{l.view}</strong>
                <span className="msb-panel__badge">{l.columns.length} columns</span>
              </div>
              <div className="msb-xp__chips">
                {l.columns.map((c, i) => (
                  <button key={`${c}-${i}`} className="msb-chip msb-chip--action" title="Copy column name" onClick={() => copy(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
