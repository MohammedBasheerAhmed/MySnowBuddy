import React, { useEffect, useMemo, useRef, useState } from 'react';
import { dotWalkString, glideRecordLine, getElementLine, tableApiFragment, encodedQueryCondition, pickLeaf, cleanName } from '../lib/dataModel.js';
import { TablePicker, TableLink, errorText, useCopyNotice } from './DataModelParts.jsx';

const SHOW_ROUTES = 6;
const SHOW_VARIANTS = 8;

/** The five things worth copying for one path and one end column. */
function snippetsFor(path, leaf) {
  return [
    ['Dot-walk', dotWalkString(path, leaf), 'the dot-walk string'],
    ['GlideRecord', glideRecordLine(path, leaf), 'the GlideRecord line'],
    ['getElement', getElementLine(path, leaf), 'the getElement line'],
    ['Table API', tableApiFragment(path, leaf), 'the Table API fragment'],
    ['Encoded query', encodedQueryCondition(path, leaf), 'the encoded query condition'],
  ];
}

function Hop({ hop, labels }) {
  return (
    <li className="msb-dm-hop">
      <span className="msb-dm-mono">
        {hop.table}.{hop.field}
      </span>
      <span className="msb-dm-muted"> {hop.label && hop.label !== hop.field ? `(${hop.label}) ` : ''}</span>
      {hop.kind === 'list' ? <span className="msb-dm-tag msb-dm-tag--warn">list: cannot be walked</span> : hop.kind === 'generic' ? <span className="msb-dm-tag msb-dm-tag--warn">any table: cannot be walked</span> : null}
      {hop.definedOn && hop.definedOn !== hop.table && <span className="msb-dm-tag">from {hop.definedOn}</span>}
      {hop.target && (
        <span className="msb-dm-hop__to">
          {' '}
          {'→'} <span className="msb-dm-mono">{hop.target}</span>
          {labels?.[hop.target] && labels[hop.target] !== hop.target && <span className="msb-dm-muted"> {labels[hop.target]}</span>}
        </span>
      )}
    </li>
  );
}

function RouteLine({ tables, labels, onOpen }) {
  return (
    <div className="msb-dm-routeline">
      {tables.map((t, i) => (
        <React.Fragment key={`${t}:${i}`}>
          {i > 0 && (
            <span className="msb-dm-arrow" aria-hidden="true">
              {'→'}
            </span>
          )}
          <TableLink name={t} label="" onOpen={onOpen} title={`Show the map of ${t}${labels?.[t] && labels[t] !== t ? ` (${labels[t]})` : ''}`} />
        </React.Fragment>
      ))}
    </div>
  );
}

/** One route (a list of tables) with the field-name variants, the hops of the chosen one and the copy rows. */
function Route({ route, target, leaf, labels, copy, onOpen, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const [pick, setPick] = useState(0);
  const [allVariants, setAllVariants] = useState(false);
  const variants = allVariants ? route.variants : route.variants.slice(0, SHOW_VARIANTS);
  const path = route.variants[Math.min(pick, route.variants.length - 1)];
  const end = path.tables[path.tables.length - 1];
  return (
    <li className="msb-dm-route">
      <div className="msb-dm-route__head">
        <button type="button" className="msb-dm-expand" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the steps and copy buttons for ${route.tables.join(' to ')}`} onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'}
        </button>
        <RouteLine tables={route.tables} labels={labels} onOpen={onOpen} />
        <span className="msb-dm-muted msb-dm-route__count">
          {route.length} step{route.length === 1 ? '' : 's'}
          {route.variants.length > 1 ? `, ${route.variants.length} field names` : ''}
        </span>
      </div>
      {!open && <div className="msb-dm-mono msb-dm-route__first">{route.variants[0].dotWalk}</div>}
      {open && (
        <div className="msb-dm-route__body">
          {route.variants.length > 1 && (
            <div className="msb-dm-variants" role="group" aria-label="Field names for this route">
              {variants.map((v, i) => (
                <button key={v.dotWalk} type="button" className={`msb-dm-chip${i === pick ? ' is-on' : ''}`} aria-pressed={i === pick} onClick={() => setPick(i)}>
                  {v.dotWalk}
                </button>
              ))}
              {!allVariants && route.variants.length > SHOW_VARIANTS && (
                <button type="button" className="msb-dm-chip msb-dm-chip--more" onClick={() => setAllVariants(true)}>
                  +{route.variants.length - SHOW_VARIANTS} more
                </button>
              )}
            </div>
          )}
          <ol className="msb-dm-hops" aria-label="Steps">
            {path.hops.map((h) => (
              <Hop key={`${h.table}.${h.field}`} hop={h} labels={labels} />
            ))}
          </ol>
          {path.viaChild && (
            <div className="msb-panel__hint">
              The last field points at {end}, a table that extends {target}. Every value is a {target} record, but not every {target} record is one of these.
            </div>
          )}
          <ul className="msb-dm-copyrows">
            {snippetsFor(path, leaf).map(([name, text, what]) => (
              <li key={name} className="msb-dm-copyrow">
                <span className="msb-dm-copyrow__name">{name}</span>
                <code className="msb-dm-copyrow__text">{text}</code>
                <button type="button" className="msb-panel__secondary" onClick={() => copy(text, what)} aria-label={`Copy ${what}`}>
                  Copy
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/** The routes of one finished search, with the "field at the end" choice that feeds the copy rows. */
function Results({ result, services, copy, onOpen, onLonger, busy }) {
  const [leaf, setLeaf] = useState('');
  const [leafFields, setLeafFields] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const labels = result.labels || {};

  useEffect(() => {
    let live = true;
    setLeaf('');
    setLeafFields(null);
    services
      .dataModelFields({ table: result.to })
      .then((r) => {
        if (!live || r.cancelled) return;
        setLeafFields(r.fields);
        setLeaf(pickLeaf(r.fields));
      })
      .catch(() => live && setLeafFields([]));
    return () => {
      live = false;
    };
  }, [result.to, services]);

  const routes = showAll ? result.routes : result.routes.slice(0, SHOW_ROUTES);
  const endColumns = (leafFields || []).filter((f) => f.kind !== 'generic');

  return (
    <div className="msb-dm-results">
      <div className="msb-dm-results__head">
        <strong>
          {result.routes.length} route{result.routes.length === 1 ? '' : 's'}, {result.paths.length} path{result.paths.length === 1 ? '' : 's'}
        </strong>
        <span className="msb-dm-muted">
          from <span className="msb-dm-mono">{result.from}</span> to <span className="msb-dm-mono">{result.to}</span>
        </span>
      </div>

      <div className="msb-dm-leaf">
        <label htmlFor={`leaf-${result.from}-${result.to}`}>Field to read at the end</label>
        {leafFields && endColumns.length > 0 ? (
          <select id={`leaf-${result.from}-${result.to}`} value={leaf} onChange={(e) => setLeaf(e.target.value)}>
            {endColumns.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
                {f.label && f.label !== f.name ? ` (${f.label})` : ''}
              </option>
            ))}
          </select>
        ) : (
          <input id={`leaf-${result.from}-${result.to}`} type="text" value={leaf} placeholder="sys_id" onChange={(e) => setLeaf(cleanName(e.target.value))} spellCheck={false} />
        )}
      </div>

      <ul className="msb-dm-routes">
        {routes.map((r, i) => (
          <Route key={r.key} route={r} target={result.to} defaultOpen={i === 0} leaf={leaf} labels={labels} copy={copy} onOpen={onOpen} />
        ))}
      </ul>
      {!showAll && result.routes.length > SHOW_ROUTES && (
        <button type="button" className="msb-panel__secondary" onClick={() => setShowAll(true)}>
          Show {result.routes.length - SHOW_ROUTES} more routes
        </button>
      )}

      {result.list.length > 0 && (
        <details className="msb-dm-more">
          <summary>{result.list.length} through a list field (cannot be dot-walked)</summary>
          <ul className="msb-dm-plain">
            {result.list.map((p) => (
              <li key={p.dotWalk}>
                <span className="msb-dm-mono">{p.dotWalk}</span> <span className="msb-dm-muted">{p.tables.join(' → ')}. A list field holds several records; read it with getValue() and look each one up.</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {onLonger && result.shortest >= 0 && result.shortest + result.extra < result.maxDepth && (
        <div className="msb-panel__actions">
          <button type="button" className="msb-panel__secondary" onClick={onLonger} disabled={busy}>
            Look for longer paths
          </button>
          <span className="msb-panel__hint">Now showing {result.shortest + result.extra === result.shortest ? `only ${result.shortest}-step paths` : `up to ${result.shortest + result.extra} steps`}.</span>
        </div>
      )}
    </div>
  );
}

/**
 * Path finder: pick two tables, see the dot-walk paths between them, copy the string, a GlideRecord line, a Table API
 * fragment or an encoded-query condition. Reads the dictionary a level at a time, in batches; Cancel stops it.
 */
export default function DataModelPaths({ services, initialFrom = '', initialTo = '', autoRun = false, onOpenMap }) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [state, setState] = useState({ status: 'idle' });
  const [progress, setProgress] = useState('');
  const { notice, copy } = useCopyNotice();
  const run = useRef(0);
  const asked = useRef({ from: '', to: '', extra: 0 });

  async function find(extra = 0, a = from, b = to) {
    const f = cleanName(a);
    const t = cleanName(b);
    if (!f || !t) {
      setState({ status: 'error', error: 'Enter two table names, for example incident and sys_user.' });
      return;
    }
    const mine = (run.current += 1);
    asked.current = { from: f, to: t, extra };
    setState((s) => ({ status: 'busy', previous: s.result }));
    setProgress('Starting');
    try {
      const result = await services.dataModelFindPaths({ from: f, to: t, maxDepth: 4, extra, isCancelled: () => mine !== run.current, onProgress: (p) => mine === run.current && setProgress(p.text || '') });
      if (mine !== run.current) return;
      if (result.cancelled) setState({ status: 'cancelled' });
      else setState({ status: 'done', result });
    } catch (err) {
      if (mine === run.current) setState({ status: 'error', error: errorText(err) });
    }
  }

  function cancel() {
    run.current += 1;
    setState({ status: 'cancelled' });
  }

  useEffect(() => {
    if (autoRun && initialFrom && initialTo) find(0, initialFrom, initialTo);
    return () => {
      run.current += 1;
    };
    // Once per mount; the panel is re-keyed when new arguments arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const result = state.status === 'done' ? state.result : null;
  const busy = state.status === 'busy';
  const swap = () => {
    setFrom(to);
    setTo(from);
  };
  const noRoutes = result && !result.same && !result.inherits && result.routes.length === 0;
  // "No path" is only a fact when the dictionary was readable and the search was not cut short.
  const unreadable = Boolean(result && result.notes.length);
  const incomplete = Boolean(result && (result.limited || result.truncated || result.unexpanded.length > 0 || result.reverseIncomplete));
  const summaryKey = useMemo(() => (result ? `${result.from}>${result.to}:${result.extra}` : ''), [result]);

  return (
    <section className="msb-dm-paths" aria-label="Path finder">
      <p className="msb-panel__hint">Find how to dot-walk from one table to another along reference fields, for example from incident to a user&apos;s department.</p>
      <form
        className="msb-dm-pathform"
        onSubmit={(e) => {
          e.preventDefault();
          find(0);
        }}
      >
        <TablePicker label="From table" value={from} onChange={setFrom} services={services} placeholder="incident" />
        <button type="button" className="msb-panel__secondary msb-dm-swap" onClick={swap} aria-label="Swap the two tables" title="Swap">
          {'⇄'}
        </button>
        <TablePicker label="To table" value={to} onChange={setTo} services={services} placeholder="sys_user" onSubmit={() => find(0)} />
        <div className="msb-dm-pathform__go">
          {busy ? (
            <button type="button" className="msb-panel__secondary" onClick={cancel}>
              Cancel
            </button>
          ) : (
            <button type="submit" className="msb-panel__run">
              Find paths
            </button>
          )}
        </div>
      </form>

      {busy && (
        <div className="msb-dm-progress" role="status" aria-live="polite">
          {progress}
        </div>
      )}
      {state.status === 'cancelled' && <div className="msb-panel__hint">Cancelled.</div>}
      {state.status === 'error' && (
        <div className="msb-panel__error" role="alert">
          {state.error}
        </div>
      )}

      {result && (
        <>
          {result.notes.map((n) => (
            <div key={n} className="msb-panel__warning">
              {n}
            </div>
          ))}
          {result.same && <div className="msb-panel__hint">That is one table. Pick two different tables.</div>}
          {result.inherits && (
            <div className="msb-panel__hint">
              {result.from} extends {result.to}, so every field of {result.to} is already a field of {result.from}. No dot-walk is needed for those.
            </div>
          )}
          {noRoutes && !result.reverse && !unreadable && (
            <div className="msb-panel__empty">
              {incomplete ? 'No path found' : 'No path'} of up to {result.maxDepth} steps from {result.from} to {result.to}
              {result.reverseDepth ? `, and none of up to ${result.reverseDepth} steps from ${result.to} to ${result.from},` : ''} along reference fields.
              {incomplete && ' The search did not read every table (see below), so a path may still exist.'}
              {result.generic.length > 0 && ' Fields that can hold a record of any table do not count:'}
            </div>
          )}
          {noRoutes && result.reverse && (
            <div className="msb-panel__hint">
              No path from <span className="msb-dm-mono">{result.from}</span> to <span className="msb-dm-mono">{result.to}</span>. References run the other way: from <span className="msb-dm-mono">{result.to}</span> to <span className="msb-dm-mono">{result.from}</span>.
            </div>
          )}
          {noRoutes && result.generic.length > 0 && (
            <ul className="msb-dm-plain">
              {result.generic.slice(0, 5).map((p) => (
                <li key={p.dotWalk}>
                  <span className="msb-dm-mono">{[...p.hops.slice(0, -1).map((h) => h.field), p.hops[p.hops.length - 1].field].join('.')}</span>{' '}
                  <span className="msb-dm-muted">on {p.hops[p.hops.length - 1].table} holds a record of any table (a document id), so a dot-walk cannot go through it.</span>
                </li>
              ))}
            </ul>
          )}

          {result.routes.length > 0 && <Results key={summaryKey} result={result} services={services} copy={copy} onOpen={onOpenMap} busy={busy} onLonger={() => find(asked.current.extra + 1, result.from, result.to)} />}
          {noRoutes && result.reverse && <Results key={`${summaryKey}:reverse`} result={{ ...result.reverse, labels: result.labels }} services={services} copy={copy} onOpen={onOpenMap} busy={busy} onLonger={null} />}

          {incomplete && (
            <div className="msb-panel__hint">
              {result.reverseIncomplete && `The search from ${result.to} back to ${result.from} was cut short too. `}
              {result.truncated && 'Some variants were left out to keep the search small. '}
              {result.limited && 'The search stopped after reading the most tables it reads in one go. '}
              {result.unexpanded.length > 0 && `${result.unexpanded.length} table${result.unexpanded.length === 1 ? ' was' : 's were'} not read (${result.unexpanded.slice(0, 5).join(', ')}${result.unexpanded.length > 5 ? ', ...' : ''}), so routes through ${result.unexpanded.length === 1 ? 'it' : 'them'} are missing.`}
            </div>
          )}
        </>
      )}

      <div className="msb-dm-notice" role="status" aria-live="polite">
        {notice}
      </div>
    </section>
  );
}
