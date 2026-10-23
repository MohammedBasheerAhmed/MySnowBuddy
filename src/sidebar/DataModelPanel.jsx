import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildMapGraph, mapToMarkdown, parseArgs, cleanName, isSystemTable } from '../lib/dataModel.js';
import DataModelDiagram from './DataModelDiagram.jsx';
import DataModelPaths from './DataModelPaths.jsx';
import { TablePicker, TableLink, errorText, useCopyNotice } from './DataModelParts.jsx';

const IN_LIMIT = 16;
const OUT_LIMIT = 12;
const KID_LIMIT = 12;
const WALK_DEPTH = 6;

const num = (n) => Number(n).toLocaleString();

function Section({ title, count, hint, children }) {
  return (
    <section className="msb-dm-section">
      <h3 className="msb-dm-section__title">
        {title}
        {count !== undefined && <span className="msb-panel__badge">{count}</span>}
      </h3>
      {hint && <div className="msb-panel__hint">{hint}</div>}
      {children}
    </section>
  );
}

// --- The list view ------------------------------------------------------------------------------------------------

function OutgoingList({ groups, centre, onOpen, onPath }) {
  const [all, setAll] = useState(false);
  const shown = all ? groups : groups.slice(0, OUT_LIMIT);
  return (
    <>
      <ul className="msb-dm-rows">
        {shown.map((g) => (
          <li key={g.target || 'generic'} className="msb-dm-row">
            <div className="msb-dm-row__head">
              {g.generic ? <strong>Any table</strong> : <TableLink name={g.target} label={g.label} onOpen={onOpen} />}
              <span className="msb-panel__badge" title="fields">
                {g.count}
              </span>
              {!g.generic && (
                <button type="button" className="msb-dm-minor" onClick={() => onPath(centre, g.target)} title={`Find the dot-walk path from ${centre} to ${g.target}`}>
                  path
                </button>
              )}
            </div>
            {g.generic && <div className="msb-panel__hint">These fields hold a record of any table (a document id). They cannot be dot-walked: read the table name from the field beside it, then look the record up.</div>}
            <ul className="msb-dm-fieldlist">
              {g.fields.map((f) => (
                <li key={f.name}>
                  <span className="msb-dm-mono">{f.name}</span>
                  {f.label && f.label !== f.name && <span className="msb-dm-muted"> {f.label}</span>}
                  {f.kind === 'list' && <span className="msb-dm-tag msb-dm-tag--warn">list</span>}
                  {f.inherited && <span className="msb-dm-tag">from {f.definedOn}</span>}
                  {f.dependent && <span className="msb-dm-tag">table in {f.dependent}</span>}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {!all && groups.length > OUT_LIMIT && (
        <button type="button" className="msb-panel__secondary" onClick={() => setAll(true)}>
          Show {groups.length - OUT_LIMIT} more tables
        </button>
      )}
    </>
  );
}

function IncomingList({ groups, onOpen, onPath, centre }) {
  const [all, setAll] = useState(false);
  const shown = all ? groups : groups.slice(0, IN_LIMIT);
  return (
    <>
      <ul className="msb-dm-rows">
        {shown.map((g) => (
          <li key={g.table} className="msb-dm-row">
            <div className="msb-dm-row__head">
              <TableLink name={g.table} label={g.label} onOpen={onOpen} />
              <span className="msb-panel__badge" title="fields">
                {g.count}
              </span>
              {g.system && <span className="msb-dm-tag">system</span>}
              <button type="button" className="msb-dm-minor" onClick={() => onPath(g.table, centre)} title={`Find the dot-walk path from ${g.table} to ${centre}`}>
                path
              </button>
            </div>
            <ul className="msb-dm-fieldlist msb-dm-fieldlist--inline">
              {g.fields.map((f) => (
                <li key={f.name}>
                  <span className="msb-dm-mono" title={f.label}>
                    {f.name}
                  </span>
                  {f.kind === 'list' && <span className="msb-dm-tag msb-dm-tag--warn">list</span>}
                  {f.viaParent && <span className="msb-dm-tag">points at {f.target}</span>}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {!all && groups.length > IN_LIMIT && (
        <button type="button" className="msb-panel__secondary" onClick={() => setAll(true)}>
          Show {groups.length - IN_LIMIT} more tables
        </button>
      )}
    </>
  );
}

function LinkTables({ model, links, busy, onFind, onOpen }) {
  const list = links || model.linkTables;
  if (list === null || list === undefined) {
    return (
      <div className="msb-panel__actions">
        <button type="button" className="msb-panel__secondary" onClick={onFind} disabled={busy}>
          {busy ? 'Looking...' : 'Find link tables'}
        </button>
        <span className="msb-panel__hint">Many tables point here, so this is left until you ask.</span>
      </div>
    );
  }
  if (!list.length) return <div className="msb-panel__empty">No table looks like a link between this one and another (two to four reference fields, one pointing here).</div>;
  return (
    <ul className="msb-dm-rows">
      {list.slice(0, 20).map((l) => (
        <li key={l.table} className="msb-dm-row">
          <div className="msb-dm-row__head">
            <TableLink name={l.table} label={model.labels?.[l.table]} onOpen={onOpen} />
            {l.defined && <span className="msb-dm-tag msb-dm-tag--ok">listed in sys_m2m</span>}
          </div>
          <div className="msb-dm-muted">
            {l.others.length
              ? `Joins this table (${l.toHere.join(', ')}) with ${l.others.map((o) => `${o.target} (${o.field})`).join(', ')}.`
              : `Relates this table to itself (${l.toHere.join(', ')}).`}
          </div>
        </li>
      ))}
      {list.length > 20 && <li className="msb-dm-muted">{list.length - 20} more not shown.</li>}
    </ul>
  );
}

// --- The map tab --------------------------------------------------------------------------------------------------

function MapTab({ table, services, onGo, onPath, history }) {
  const [state, setState] = useState({ status: 'idle' });
  const [progress, setProgress] = useState('');
  const [view, setView] = useState('diagram');
  const [hideSystem, setHideSystem] = useState(true);
  const [query, setQuery] = useState('');
  const [links, setLinks] = useState(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const run = useRef(0);
  const root = useRef(null);
  const { notice, copy } = useCopyNotice();

  // A narrow panel (the docked sidebar) starts on the list; the diagram needs room, and is one click away.
  useEffect(() => {
    if (root.current && root.current.clientWidth > 0 && root.current.clientWidth < 520) setView('list');
  }, []);

  useEffect(() => {
    if (!cleanName(table)) {
      setState({ status: 'idle' });
      return undefined;
    }
    const mine = (run.current += 1);
    setState({ status: 'loading' });
    setProgress('Reading the table');
    setLinks(null);
    setQuery('');
    services
      .dataModelLoad({ table, isCancelled: () => mine !== run.current, onProgress: (p) => mine === run.current && setProgress(p.text || '') })
      .then((model) => {
        if (mine !== run.current || model.cancelled) return;
        setHideSystem(!isSystemTable(model.table));
        setState({ status: 'ready', model });
      })
      .catch((err) => mine === run.current && setState({ status: 'error', error: errorText(err) }));
    return () => {
      run.current += 1;
    };
  }, [table, refresh, services]);

  async function findLinks(model) {
    // The answer belongs to the map that asked: if another table (or a refresh) replaced it meanwhile, it is dropped.
    const mine = run.current;
    const stale = () => mine !== run.current;
    setLinkBusy(true);
    try {
      const r = await services.dataModelLinkTables({ chain: model.chain, incoming: model.incoming, isCancelled: stale });
      if (stale()) return;
      if (!r.cancelled) {
        setLinks(r.linkTables);
        setState((s) => (s.model ? { ...s, model: { ...s.model, labels: { ...s.model.labels, ...r.labels } } } : s));
      }
    } catch (err) {
      if (!stale()) setState((s) => (s.model ? { ...s, model: { ...s.model, notes: [...s.model.notes, `Could not look for link tables: ${errorText(err)}`] } } : s));
    } finally {
      setLinkBusy(false);
    }
  }

  const model = state.status === 'ready' ? state.model : null;
  const diagramGraph = useMemo(() => (model ? buildMapGraph(model, { hideSystem }) : null), [model, hideSystem]);
  const listGraph = useMemo(() => (model ? buildMapGraph(model, { hideSystem, query }) : null), [model, hideSystem, query]);

  return (
    <div className="msb-dm-map" ref={root}>
      {!cleanName(table) && <div className="msb-panel__empty">Type a table name above to see how it connects to the others.</div>}
      {state.status === 'loading' && (
        <div className="msb-dm-progress" role="status" aria-live="polite">
          {progress}...
        </div>
      )}
      {state.status === 'error' && (
        <div className="msb-panel__error" role="alert">
          {state.error}
        </div>
      )}

      {model && (
        <>
          <div className="msb-dm-facts">
            <div>
              <strong>{model.label}</strong> <span className="msb-dm-mono">{model.table}</span>
            </div>
            <div className="msb-dm-muted">
              {model.scopeName || model.scope ? `Scope ${model.scopeName || model.scope}` : 'Scope unknown'}
              {' · '}
              {`Extensible: ${model.extendable || model.childCount ? 'yes' : 'no'}`}
              {' · '}
              {model.rowCount === null ? 'row count not available' : `${num(model.rowCount)} row${model.rowCount === 1 ? '' : 's'}${model.childCount ? ' (with child tables)' : ''}`}
            </div>
          </div>

          {model.notes.map((n) => (
            <div key={n} className="msb-panel__warning" role="status">
              {n}
            </div>
          ))}

          <div className="msb-dm-toolbar">
            <div className="msb-dm-seg" role="group" aria-label="View">
              {[
                ['diagram', 'Diagram'],
                ['list', 'List'],
              ].map(([id, text]) => (
                <button key={id} type="button" className={`msb-dm-seg__btn${view === id ? ' is-on' : ''}`} aria-pressed={view === id} onClick={() => setView(id)}>
                  {text}
                </button>
              ))}
            </div>
            <label className="msb-dm-check">
              <input type="checkbox" checked={hideSystem} onChange={(e) => setHideSystem(e.target.checked)} />
              Hide system tables
            </label>
            <button type="button" className="msb-panel__secondary" onClick={() => setRefresh((n) => n + 1)} title="Read the table again from the instance">
              Refresh
            </button>
            <button type="button" className="msb-panel__secondary" onClick={() => copy(mapToMarkdown(model, buildMapGraph(model, { hideSystem })), 'the map as Markdown')}>
              Copy as Markdown
            </button>
          </div>
          <div className="msb-dm-notice" role="status" aria-live="polite">
            {notice}
          </div>
          {hideSystem && diagramGraph.hiddenIncomingFields > 0 && (
            <div className="msb-panel__hint">
              {diagramGraph.hiddenIncomingGroups} system table{diagramGraph.hiddenIncomingGroups === 1 ? '' : 's'} ({diagramGraph.hiddenIncomingFields} field{diagramGraph.hiddenIncomingFields === 1 ? '' : 's'}) hidden from the tables that point here.
            </div>
          )}

          {view === 'diagram' ? (
            <DataModelDiagram graph={diagramGraph} onOpen={onGo} />
          ) : (
            <>
              <div className="msb-dm-search">
                <label htmlFor="msb-dm-filter">Filter this list</label>
                <input id="msb-dm-filter" type="search" value={query} placeholder="table, label or field" onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
              </div>

              <Section title="Extends" count={listGraph.parents.length}>
                {listGraph.parents.length === 0 ? (
                  <div className="msb-panel__empty">A root table: it does not extend another.</div>
                ) : (
                  <ol className="msb-dm-chain" aria-label="Parent tables, nearest first">
                    {listGraph.parents.map((p) => (
                      <li key={p.table}>
                        <TableLink name={p.table} label={p.label} onOpen={onGo} />
                      </li>
                    ))}
                  </ol>
                )}
              </Section>

              <Section title="Extended by" count={model.descendantCount || model.children.length}>
                {model.children.length === 0 ? (
                  <div className="msb-panel__empty">No table extends this one.</div>
                ) : (
                  <>
                    <div className="msb-panel__hint">
                      {model.childCount} directly{model.descendantCount > model.childCount ? `, ${num(model.descendantCount)}${model.descendantsMore ? '+' : ''} counting every level` : ''}.
                    </div>
                    <ul className="msb-dm-rows msb-dm-rows--tight">
                      {model.children.slice(0, KID_LIMIT).map((c) => (
                        <li key={c.name}>
                          <TableLink name={c.name} label={c.label} onOpen={onGo} />
                        </li>
                      ))}
                    </ul>
                    {model.children.length > KID_LIMIT && <KidsMore kids={model.children.slice(KID_LIMIT)} onOpen={onGo} total={model.childCount} />}
                  </>
                )}
              </Section>

              <Section
                title="Points at"
                count={listGraph.outgoing.reduce((n, g) => n + g.count, 0)}
                hint="Reference fields on this table, inherited ones included."
              >
                {listGraph.outgoing.length === 0 ? <div className="msb-panel__empty">{query ? 'No match.' : 'This table has no reference fields.'}</div> : <OutgoingList groups={listGraph.outgoing} centre={model.table} onOpen={onGo} onPath={onPath} />}
              </Section>

              <Section
                title="Pointed at by"
                count={listGraph.incoming.reduce((n, g) => n + g.count, 0)}
                hint={`Fields on other tables that hold a ${model.table}${model.chain.length > 1 ? ` (or a ${model.chain.slice(1).join(' / ')})` : ''} record.`}
              >
                {listGraph.incoming.length === 0 ? (
                  <div className="msb-panel__empty">{query ? 'No match.' : model.incoming.length ? 'Only system tables point here. Untick "Hide system tables" to see them.' : 'No field on another table points here.'}</div>
                ) : (
                  <IncomingList groups={listGraph.incoming} centre={model.table} onOpen={onGo} onPath={onPath} />
                )}
              </Section>

              <Section title="Link tables" hint="Tables that join this one to another, a many-to-many.">
                <LinkTables model={model} links={links} busy={linkBusy} onFind={() => findLinks(model)} onOpen={onGo} />
              </Section>
            </>
          )}
          {history > 0 && <div className="msb-panel__hint">Back returns to the previous table.</div>}
        </>
      )}
    </div>
  );
}

function KidsMore({ kids, total, onOpen }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className="msb-panel__secondary" onClick={() => setOpen(true)}>
        Show {kids.length} more{total > kids.length + KID_LIMIT ? ' (first 60 of them)' : ''}
      </button>
    );
  return (
    <ul className="msb-dm-rows msb-dm-rows--tight">
      {kids.map((c) => (
        <li key={c.name}>
          <TableLink name={c.name} label={c.label} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

// --- The dot-walk explorer ---------------------------------------------------------------------------------------

const matches = (f, q) => !q || `${f.name} ${f.label} ${f.type}`.toLowerCase().includes(q);

function WalkNode({ field, path, depth, cache, open, toggle, copy, query }) {
  const walkable = field.kind === 'reference' && field.target && depth < WALK_DEPTH;
  const node = cache[path];
  const isOpen = open.has(path);
  const children = isOpen && node?.fields ? node.fields : null;
  const q = query.toLowerCase();
  const visibleChildren = children ? children.filter((c) => childVisible(c, `${path}.${c.name}`, cache, q)) : null;
  return (
    <li className="msb-dm-node-row" style={{ '--depth': depth }}>
      <div className="msb-dm-walkrow">
        {walkable ? (
          <button type="button" className="msb-dm-expand" aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${field.name}, fields of ${field.target}`} onClick={() => toggle(path, field.target)}>
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span className="msb-dm-expand msb-dm-expand--none" aria-hidden="true" />
        )}
        <button type="button" className="msb-dm-walkname" onClick={() => copy(path, path)} title={`Copy ${path}`}>
          <span className="msb-dm-mono">{field.name}</span>
          {field.label && field.label !== field.name && <span className="msb-dm-muted"> {field.label}</span>}
        </button>
        <span className="msb-dm-walkmeta">
          {field.kind === 'reference' ? `→ ${field.target}` : field.kind === 'list' ? 'list, not walkable' : field.kind === 'generic' ? 'any table, not walkable' : field.type}
          {field.inherited ? ` · from ${field.definedOn}` : ''}
        </span>
      </div>
      {isOpen && !node?.fields && !node?.error && <div className="msb-dm-muted msb-dm-walkstatus">Reading {field.target}...</div>}
      {isOpen && node?.error && <div className="msb-panel__error">{node.error}</div>}
      {visibleChildren && (
        <ul className="msb-dm-walklist">
          {visibleChildren.map((c) => (
            <WalkNode key={c.name} field={c} path={`${path}.${c.name}`} depth={depth + 1} cache={cache} open={open} toggle={toggle} copy={copy} query={query} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A field shows when it matches the filter, or when something already opened below it does. */
function childVisible(field, path, cache, q) {
  if (matches(field, q)) return true;
  const sub = cache[path]?.fields;
  return Boolean(sub && sub.some((c) => childVisible(c, `${path}.${c.name}`, cache, q)));
}

function WalkTab({ table, services }) {
  const [cache, setCache] = useState({});
  const [open, setOpen] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [state, setState] = useState({ status: 'idle' });
  const { notice, copy } = useCopyNotice();
  const run = useRef(0);

  useEffect(() => {
    setCache({});
    setOpen(new Set());
    setQuery('');
    if (!cleanName(table)) {
      setState({ status: 'idle' });
      return undefined;
    }
    const mine = (run.current += 1);
    setState({ status: 'loading' });
    services
      .dataModelFields({ table })
      .then((r) => {
        if (mine !== run.current || r.cancelled) return;
        setCache({ '': { fields: r.fields } });
        setState({ status: 'ready', label: r.label });
      })
      .catch((err) => mine === run.current && setState({ status: 'error', error: errorText(err) }));
    return () => {
      run.current += 1;
    };
  }, [table, services]);

  function toggle(path, target) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!open.has(path) && !cache[path]?.fields) {
      // Paths are relative to the table: an answer that arrives after the table changed would land under the new
      // table's field of the same name, so it is dropped.
      const mine = run.current;
      if (cache[path]?.error) {
        setCache((c) => {
          const n = { ...c };
          delete n[path];
          return n;
        });
      }
      services
        .dataModelFields({ table: target })
        .then((r) => mine === run.current && !r.cancelled && setCache((c) => ({ ...c, [path]: { fields: r.fields } })))
        .catch((err) => mine === run.current && setCache((c) => ({ ...c, [path]: { error: errorText(err) } })));
    }
  }

  const q = query.trim().toLowerCase();
  const roots = cache['']?.fields || [];
  const shown = roots.filter((f) => childVisible(f, f.name, cache, q));
  return (
    <div className="msb-dm-walk">
      <p className="msb-panel__hint">Every field of {table || 'a table'}. Open a reference field to see the fields of the table it points at. Click a name to copy its dot-walk path.</p>
      {state.status === 'loading' && <div className="msb-dm-progress">Reading the fields...</div>}
      {state.status === 'error' && <div className="msb-panel__error">{state.error}</div>}
      {state.status === 'ready' && (
        <>
          <div className="msb-dm-search">
            <label htmlFor="msb-dm-walkfilter">Filter fields</label>
            <input id="msb-dm-walkfilter" type="search" value={query} placeholder="name, label or type" onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
          </div>
          {q && <div className="msb-panel__hint">Only fields you have opened are searched below the first level.</div>}
          {shown.length === 0 ? (
            <div className="msb-panel__empty">{q ? 'No field matches.' : 'This table has no fields in the dictionary.'}</div>
          ) : (
            <ul className="msb-dm-walklist msb-dm-walklist--root">
              {shown.map((f) => (
                <WalkNode key={f.name} field={f} path={f.name} depth={0} cache={cache} open={open} toggle={toggle} copy={copy} query={q} />
              ))}
            </ul>
          )}
          <div className="msb-dm-notice" role="status" aria-live="polite">
            {notice}
          </div>
        </>
      )}
    </div>
  );
}

// --- The panel ------------------------------------------------------------------------------------------------------

const TABS = [
  ['map', 'Map'],
  ['path', 'Path finder'],
  ['walk', 'Dot-walk'],
];

/**
 * Data model map. One table: what it extends, what extends it, what it points at and what points at it, as a diagram and
 * as a list. A path finder for the dot-walk between two tables, and a field tree to explore a table. Read-only.
 */
export default function DataModelPanel({ context, params, services, onClose }) {
  const start = useMemo(() => parseArgs(params?.args, context?.table), [params, context]);
  const [tab, setTab] = useState(start.mode === 'path' ? 'path' : 'map');
  const [table, setTable] = useState(start.table);
  const [typed, setTyped] = useState(start.table);
  const [history, setHistory] = useState([]);
  const [seed, setSeed] = useState({ from: start.mode === 'path' ? start.from : '', to: start.mode === 'path' ? start.to : '', auto: start.mode === 'path', n: 0 });
  // A tab is read the first time it is opened and then kept, so going back to it finds it as it was left.
  const [visited, setVisited] = useState(() => new Set([start.mode === 'path' ? 'path' : 'map']));
  const selectTab = (id) => {
    setTab(id);
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
  };

  function go(name) {
    const next = cleanName(name);
    if (!next) return;
    if (next !== table && table) setHistory((h) => [...h.slice(-19), table]);
    setTable(next);
    setTyped(next);
    selectTab(tab === 'path' ? 'map' : tab);
  }
  function back() {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory(history.slice(0, -1));
    setTable(prev);
    setTyped(prev);
  }
  function pathBetween(from, to) {
    setSeed((s) => ({ from, to, auto: true, n: s.n + 1 }));
    selectTab('path');
  }

  return (
    <div className="msb-panel msb-dm">
      <div className="msb-panel__header">
        <strong>Data model map</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className="msb-dm-tabs" role="tablist" aria-label="Data model views">
        {TABS.map(([id, text]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`msb-dm-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`msb-dm-pane-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={`msb-dm-tab${tab === id ? ' is-on' : ''}`}
            onClick={() => selectTab(id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const at = TABS.findIndex(([x]) => x === tab);
              const next = TABS[(at + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0];
              selectTab(next);
              // The panel lives in a closed shadow root, where document.getElementById cannot see it: look in the tab list.
              const list = e.currentTarget.parentElement;
              requestAnimationFrame(() => list?.querySelector?.(`#msb-dm-tab-${next}`)?.focus?.());
            }}
          >
            {text}
          </button>
        ))}
      </div>

      {tab !== 'path' && (
        <form
          className="msb-dm-tableform"
          onSubmit={(e) => {
            e.preventDefault();
            go(typed);
          }}
        >
          <TablePicker label="Table" value={typed} onChange={setTyped} onSubmit={go} services={services} />
          <button type="button" className="msb-panel__secondary" onClick={back} disabled={!history.length} title="Back to the previous table">
            Back
          </button>
          {context?.table && cleanName(context.table) !== table && (
            <button type="button" className="msb-panel__secondary" onClick={() => go(context.table)} title={`The table on this page: ${context.table}`}>
              This page
            </button>
          )}
        </form>
      )}

      {TABS.map(([id]) =>
        visited.has(id) ? (
          <div key={id === 'path' ? `path:${seed.n}` : id} role="tabpanel" className="msb-dm-pane" id={`msb-dm-pane-${id}`} aria-labelledby={`msb-dm-tab-${id}`} hidden={tab !== id}>
            {id === 'map' && <MapTab table={table} services={services} onGo={go} onPath={pathBetween} history={history.length} />}
            {id === 'path' && <DataModelPaths services={services} initialFrom={seed.from || table} initialTo={seed.to} autoRun={seed.auto && Boolean(seed.from && seed.to)} onOpenMap={go} />}
            {id === 'walk' && <WalkTab table={table} services={services} />}
          </div>
        ) : null
      )}
    </div>
  );
}
