import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyText } from '../content/quickActions.js';
import { diffValues, diffSummary, jsonText, isMarker, matchWidgets, placementLabel, annotateOptions } from '../lib/portalInspector.js';

const errorText = (err) => err?.message || String(err);
const AUTO_MS = 2000;
const POLL_MS = 1500;

function Link({ href, title, children }) {
  return (
    <a className="msb-panel__link" href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

const sizeText = (bytes) => (bytes >= 1024 ? `about ${(bytes / 1024).toFixed(1)} KB` : `about ${bytes} bytes`);

// --- The JSON tree ----------------------------------------------------------------------------------------------

function Leaf({ name, value, mark }) {
  let text;
  let kind;
  if (value === null) {
    text = 'null';
    kind = 'null';
  } else if (typeof value === 'string') {
    if (isMarker(value)) {
      text = value;
      kind = 'marker';
    } else {
      text = JSON.stringify(value);
      kind = 'string';
    }
  } else {
    text = String(value);
    kind = typeof value === 'boolean' ? 'boolean' : 'number';
  }
  return (
    <li className={`msb-portal__leaf${mark ? ' msb-portal__leaf--changed' : ''}`}>
      <span className="msb-portal__key">{name}</span>
      <span className={`msb-portal__val msb-portal__val--${kind}`}>{text}</span>
      {mark && <span className="msb-portal__flag">{mark === 'added' ? 'new' : 'changed'}</span>}
    </li>
  );
}

function Node({ name, value, path, depth, marks, expand, inherited }) {
  // A mark on a list or object (it is new, or it changed type) covers everything inside it.
  const own = marks?.get(path) || inherited || null;
  if (value !== null && typeof value === 'object') {
    const isArray = Array.isArray(value);
    const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
    if (!entries.length) return <Leaf name={name} value={isArray ? '[]' : '{}'} />;
    const open = expand === 'all' ? true : expand === 'none' ? false : depth < 1;
    return (
      <li>
        <details open={open}>
          <summary>
            <span className="msb-portal__key">{name}</span>
            <span className="msb-portal__meta">{isArray ? `[${entries.length}]` : `{${entries.length}}`}</span>
            {own && <span className="msb-portal__flag">{own === 'added' ? 'new' : 'changed'}</span>}
          </summary>
          <ul className="msb-portal__tree">
            {entries.map(([k, v]) => {
              const childPath = isArray ? `${path}[${k}]` : path ? `${path}.${k}` : String(k);
              return <Node key={k} name={isArray ? `[${k}]` : k} value={v} path={childPath} depth={depth + 1} marks={marks} expand={expand} inherited={own === 'added' ? 'added' : null} />;
            })}
          </ul>
        </details>
      </li>
    );
  }
  return <Leaf name={name} value={value} mark={own} />;
}

/** A value from the page as a collapsible tree. The root's own entries are listed directly. */
function Tree({ label, value, marks, expand }) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') {
    return (
      <ul className="msb-portal__tree msb-portal__tree--root" aria-label={label}>
        <Leaf name={label} value={value} />
      </ul>
    );
  }
  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
  if (!entries.length) return <div className="msb-panel__empty">{label} is empty ({isArray ? '[]' : '{}'}).</div>;
  return (
    <ul className="msb-portal__tree msb-portal__tree--root" aria-label={label}>
      {entries.map(([k, v]) => (
        <Node key={k} name={isArray ? `[${k}]` : k} value={v} path={isArray ? `[${k}]` : String(k)} depth={0} marks={marks} expand={expand} />
      ))}
    </ul>
  );
}

// --- What the widget's code touches -------------------------------------------------------------------------------

const lineText = (lines) => (lines?.length ? `line ${lines.join(', ')}` : '');

/** One labelled line. `items`, when given, says whether there is anything to show; otherwise the line says `empty`. */
function Fact({ label, children, empty, items }) {
  const filled = items ? items.length > 0 : Boolean(children);
  return (
    <div className="msb-portal__fact">
      <dt>{label}</dt>
      <dd>{filled ? children : <span className="msb-portal__none">{empty || 'none'}</span>}</dd>
    </div>
  );
}

function Chips({ items, render }) {
  if (!items?.length) return null;
  return (
    <span className="msb-portal__chips">
      {items.map((item) => (
        <span className="msb-portal__chip" key={item.key ?? item.name ?? item.table}>
          {render(item)}
        </span>
      ))}
    </span>
  );
}

function CodeFacts({ detail }) {
  const a = detail.analysis;
  if (!a) return null;
  const si = new Map((detail.scriptIncludes?.items || []).map((s) => [s.name, s]));
  const nothing = !a.server.present && !a.client.present && !a.template.present;
  return (
    <>
      {nothing && <div className="msb-panel__empty">The widget record has no server script, client script or template to read.</div>}
      {a.server.present && (
        <dl className="msb-portal__facts">
          <Fact label="Tables" empty="none found in the server script" items={a.server.tables.length || a.server.dynamicTables ? [1] : []}>
            <Chips
              items={a.server.tables}
              render={(t) => (
                <>
                  <code>{t.table}</code> {t.ops.length ? t.ops.join(', ') : 'queried'}
                  {t.writes && <b className="msb-portal__warn"> writes</b>}
                  {t.fields.length > 0 && <span className="msb-portal__muted"> sets {t.fields.join(', ')}</span>}
                  {t.lines.length > 0 && <span className="msb-portal__muted"> ({lineText(t.lines)})</span>}
                </>
              )}
            />
            {a.server.dynamicTables > 0 && <span className="msb-portal__muted"> {a.server.dynamicTables} more with a table name held in a variable</span>}
          </Fact>
          <Fact label="Script Includes" empty="none called" items={a.server.scriptIncludes}>
            <Chips
              items={a.server.scriptIncludes}
              render={(s) => {
                const hit = si.get(s.name);
                return (
                  <>
                    {hit?.sysId ? <Link href={`/sys_script_include.do?sys_id=${hit.sysId}`}>{s.name}</Link> : <code>{s.name}</code>}
                    {s.methods.length > 0 && <span className="msb-portal__muted"> .{s.methods.join(', .')}</span>}
                    {hit && hit.found === false && <span className="msb-portal__muted"> not a Script Include on this instance</span>}
                  </>
                );
              }}
            />
          </Fact>
          <Fact label="Properties read" empty="none" items={a.server.properties}>
            <Chips items={a.server.properties} render={(p) => <><code>{p.name}</code> <span className="msb-portal__muted">{lineText(p.lines)}</span></>} />
          </Fact>
          <Fact label="Roles checked" empty="none" items={a.server.roles}>
            <Chips items={a.server.roles} render={(p) => <code>{p.name}</code>} />
          </Fact>
          <Fact label="URL parameters read" empty="none ($sp.getParameter)" items={a.server.urlParamsRead}>
            <Chips items={a.server.urlParamsRead} render={(p) => <code>{p.name}</code>} />
          </Fact>
          <Fact label="$sp calls" empty="none" items={a.server.spCalls}>
            <Chips items={a.server.spCalls} render={(p) => <><code>{p.name}</code>{p.count > 1 && <span className="msb-portal__muted"> x{p.count}</span>}</>} />
          </Fact>
          <Fact label="Actions it handles" empty="none (no input.action check)" items={a.server.inputActions}>
            <Chips items={a.server.inputActions} render={(p) => <><code>{p.name}</code> <span className="msb-portal__muted">{lineText(p.lines)}</span></>} />
          </Fact>
          <Fact label="Sets on c.data" empty="nothing found" items={a.server.dataKeys.map((k) => ({ ...k, key: k.name }))}>
            <Chips items={a.server.dataKeys.map((k) => ({ ...k, key: k.name }))} render={(k) => <code>{k.name}</code>} />
          </Fact>
          <Fact label="Options it reads" empty="none" items={a.server.optionsRead}>
            <Chips items={a.server.optionsRead} render={(p) => <code>{p.name}</code>} />
          </Fact>
          <Fact label="Events it queues" empty="none" items={a.server.events}>
            <Chips items={a.server.events} render={(p) => <code>{p.name}</code>} />
          </Fact>
          <Fact label="Embedded widgets" empty="none" items={[...a.server.embeddedWidgets, ...a.template.embeddedWidgets.filter((w) => !a.server.embeddedWidgets.some((s) => s.name === w.name))]}>
            <Chips items={[...a.server.embeddedWidgets, ...a.template.embeddedWidgets.filter((w) => !a.server.embeddedWidgets.some((s) => s.name === w.name))]} render={(p) => <code>{p.name}</code>} />
          </Fact>
        </dl>
      )}
      {a.client.present && (
        <>
          <h4 className="msb-portal__subtitle">Client controller</h4>
          <dl className="msb-portal__facts">
            <Fact label="Server round trips" empty="none" items={a.client.serverCalls}>
              <Chips items={a.client.serverCalls} render={(p) => <><code>server.{p.name}()</code>{p.count > 1 && <span className="msb-portal__muted"> x{p.count}</span>}</>} />
            </Fact>
            <Fact label="Actions it sends" empty="none" items={a.client.actionsSent}>
              <Chips items={a.client.actionsSent} render={(p) => <code>{p.name}</code>} />
            </Fact>
            <Fact label="Events" empty="none" items={a.client.events.map((e) => ({ ...e, key: `${e.role}:${e.name}` }))}>
              <Chips items={a.client.events.map((e) => ({ ...e, key: `${e.role}:${e.name}` }))} render={(e) => <><code>{e.name}</code> <span className="msb-portal__muted">{e.role}</span></>} />
            </Fact>
            <Fact label="GlideAjax" empty="none" items={a.client.scriptIncludes}>
              <Chips items={a.client.scriptIncludes} render={(s) => <><code>{s.name}</code>{s.methods.length > 0 && <span className="msb-portal__muted"> .{s.methods.join(', .')}</span>}</>} />
            </Fact>
            <Fact label="spUtil calls" empty="none" items={a.client.spUtil}>
              <Chips items={a.client.spUtil} render={(p) => <code>{p.name}</code>} />
            </Fact>
            {a.client.usesHttp && <Fact label="$http">used</Fact>}
          </dl>
        </>
      )}
      {(a.hints.dataNotSet.length > 0 || a.hints.actionsNotHandled.length > 0 || a.hints.actionsNeverSent.length > 0) && (
        <>
          <h4 className="msb-portal__subtitle">Worth a look</h4>
          <ul className="msb-portal__hints">
            {a.hints.dataNotSet.length > 0 && (
              <li>
                The HTML or client script reads <Chips items={a.hints.dataNotSet.map((name) => ({ name }))} render={(p) => <code>c.data.{p.name}</code>} /> but nothing in the widget sets it. Another widget or a computed key may.
              </li>
            )}
            {a.hints.actionsNotHandled.length > 0 && (
              <li>
                The client sends <Chips items={a.hints.actionsNotHandled.map((name) => ({ name }))} render={(p) => <code>{p.name}</code>} /> but the server script has no matching <code>input.action</code> check.
              </li>
            )}
            {a.hints.actionsNeverSent.length > 0 && (
              <li>
                The server handles <Chips items={a.hints.actionsNeverSent.map((name) => ({ name }))} render={(p) => <code>{p.name}</code>} /> but the client and HTML never send it.
              </li>
            )}
          </ul>
        </>
      )}
      <div className="msb-panel__hint">
        Read from the source text with comments ignored: a table or property name built at run time cannot be listed.
        {a.server.present && ` Server script ${a.server.lines} lines`}
        {a.client.present && `, client ${a.client.lines} lines`}
        {a.template.present && `, HTML ${a.template.lines} lines`}
        {a.css.present && `, CSS ${a.css.chars.toLocaleString()} characters`}.
      </div>
    </>
  );
}

// --- Options ----------------------------------------------------------------------------------------------------

function OptionTable({ rows, extra }) {
  if (!rows.length && !extra.length) return null;
  const show = (v) => (v === undefined || v === '' ? '(empty)' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <table className="msb-portal__options">
      <caption className="msb-portal__sr">Option schema next to the values in use</caption>
      <thead>
        <tr>
          <th scope="col">Option</th>
          <th scope="col">In use</th>
          <th scope="col">Default</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <th scope="row" title={r.hint || r.label}>
              <code>{r.name}</code>
              <span className="msb-portal__muted"> {r.type}</span>
            </th>
            <td>
              {r.present ? show(r.current) : <span className="msb-portal__muted">not set</span>}
              {r.differs && <b className="msb-portal__flag msb-portal__flag--inline"> differs</b>}
            </td>
            <td>{show(r.defaultValue)}</td>
          </tr>
        ))}
        {extra.map((r) => (
          <tr key={`x:${r.name}`}>
            <th scope="row">
              <code>{r.name}</code>
              <span className="msb-portal__muted"> not in the schema</span>
            </th>
            <td>{show(r.current)}</td>
            <td />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- Debug info notice ------------------------------------------------------------------------------------------

function DebugNotice({ debug, onReload, busy }) {
  const [asking, setAsking] = useState(false);
  if (debug?.debugInfo !== false) return null;
  return (
    <div className="msb-panel__warning msb-portal__notice" role="status">
      <p>Angular debug info is switched off on this page, so widget data and options cannot be read. Production portals usually turn it off.</p>
      {debug.canReload ? (
        asking ? (
          <div className="msb-panel__actions">
            <button type="button" className="msb-panel__run" onClick={onReload} disabled={busy}>
              Yes, reload this page now
            </button>
            <button type="button" className="msb-panel__secondary" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="msb-panel__actions">
            <button type="button" className="msb-panel__secondary" onClick={() => setAsking(true)}>
              Reload with debug info
            </button>
            <span className="msb-portal__muted">This reloads the page; unsaved changes on it are lost.</span>
          </div>
        )
      ) : (
        <p className="msb-portal__muted">This page does not offer angular.reloadWithDebugInfo(), so debug info cannot be turned on from here.</p>
      )}
    </div>
  );
}

// --- The panel --------------------------------------------------------------------------------------------------

/**
 * Widgets on the Service Portal page on screen: which widget is which, what is in c.data and the options, where the code
 * lives and what it touches. Reads only; the one thing it can do to the page is reload it with Angular debug info,
 * after asking.
 */
export default function PortalPanel({ params, services, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState(String(params?.args || '').trim());
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [live, setLive] = useState(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const [snap, setSnap] = useState(null);
  const [expand, setExpand] = useState('default');
  const [auto, setAuto] = useState(false);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState('');
  const [reloading, setReloading] = useState(false);
  const run = useRef(0);
  const listRef = useRef(null);
  const dataRef = useRef(null);
  const selectedRef = useRef('');
  const retries = useRef(0);
  const settle = useRef([]);

  dataRef.current = data;
  selectedRef.current = selected;

  const flash = useCallback((text) => {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => (current === text ? '' : current)), 3000);
  }, []);

  const load = useCallback(
    async (keepSelection = true) => {
      const mine = (run.current += 1);
      setLoading(true);
      setError('');
      try {
        const result = await services.portalLoad();
        if (mine !== run.current) return;
        setData(result);
        const kept = keepSelection ? result.widgets.find((w) => w.key === selectedRef.current) : null;
        if (kept) {
          select(kept.key, kept, result); // read the selected widget again with the fresh list
        } else {
          selectedRef.current = '';
          setSelected('');
          setDetail(null);
          setLive(null);
        }
      } catch (err) {
        if (mine === run.current) setError(errorText(err));
      } finally {
        if (mine === run.current) setLoading(false);
      }
    },
    [services]
  );

  useEffect(() => {
    load(false);
    return () => {
      run.current += 1;
      settle.current.forEach(clearTimeout);
      services.portalUnhighlight?.();
      services.portalPickCancel?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A portal navigates without reloading the page: notice a new address and read the list again. A page that looks like
  // a portal but has no widgets yet is probably still loading: look again a few times.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = dataRef.current;
      if (!current) return;
      if (services.portalHref() !== current.url.href) {
        retries.current = 0;
        load(false);
        // The new page's widgets appear a moment after the address changes: look again twice.
        settle.current.forEach(clearTimeout);
        settle.current = [window.setTimeout(() => load(true), 1500), window.setTimeout(() => load(true), 4000)];
      } else if (current.kind === 'portal-empty' && retries.current < 5) {
        retries.current += 1;
        load(true);
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [services, load]);

  const shown = useMemo(() => (data ? matchWidgets(data.widgets, filter) : []), [data, filter]);

  async function select(key, listed, page = dataRef.current) {
    selectedRef.current = key;
    setSelected(key);
    setDetail(null);
    setLive(null);
    setSnap(services.portalSnapshotGet(key));
    setExpand('default');
    setDetailBusy(true);
    try {
      const w = listed || page?.widgets.find((x) => x.key === key);
      const result = await services.portalWidgetDetail(key, {
        widgetId: w?.widgetId,
        instanceId: w?.instanceId,
        instanceTable: w?.instanceTable,
        pageSysId: page?.page?.sysId,
        pageId: page?.page?.id || page?.url?.pageId,
        portalSysId: page?.portal?.sysId,
      });
      if (selectedRef.current !== key) return;
      setDetail(result);
      setLive(result.live || null);
    } catch (err) {
      if (selectedRef.current === key) setDetail({ gone: false, error: errorText(err) });
    } finally {
      if (selectedRef.current === key) setDetailBusy(false);
    }
  }

  // /sp <name>: once the list is read, open the widget if the name matches exactly one.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !data || !filter) return;
    autoOpened.current = true;
    const matches = matchWidgets(data.widgets, filter);
    if (matches.length === 1) select(matches[0].key, matches[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // A widget chosen on the page may be further down the list than the visible part.
  useEffect(() => {
    listRef.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const refreshLive = useCallback(async () => {
    const key = selectedRef.current;
    if (!key) return;
    setLiveBusy(true);
    try {
      const result = await services.portalWidgetLive(key);
      if (selectedRef.current === key) setLive(result);
    } catch (err) {
      if (selectedRef.current === key) setLive({ scope: false, reason: 'bridge-error', explanation: errorText(err) });
    } finally {
      setLiveBusy(false);
    }
  }, [services]);

  useEffect(() => {
    if (!auto || !selected) return undefined;
    const timer = window.setInterval(refreshLive, AUTO_MS);
    return () => window.clearInterval(timer);
  }, [auto, selected, refreshLive]);

  function startPick() {
    if (picking) {
      services.portalPickCancel();
      return;
    }
    setPicking(true);
    services.portalPick({
      onPick: (key) => {
        setPicking(false);
        setFilter('');
        select(key);
      },
      onCancel: () => setPicking(false),
    });
  }

  async function reloadWithDebug() {
    setReloading(true);
    try {
      await services.portalReloadWithDebugInfo();
      flash('Reloading the page with debug info...');
    } catch (err) {
      setError(errorText(err));
      setReloading(false);
    }
  }

  async function copy(text, what) {
    try {
      await copyText(text);
      flash(`Copied ${what}`);
    } catch (err) {
      setError(errorText(err));
    }
  }

  function takeSnapshot() {
    if (!live?.scope) return;
    services.portalSnapshotSave(selected, live.data?.value, live.options?.value);
    setSnap(services.portalSnapshotGet(selected));
    flash('Snapshot taken. Use the page, then press Refresh to see what changed.');
  }

  const diff = useMemo(() => (snap && live?.scope ? diffValues(snap.data, live.data?.value) : null), [snap, live]);
  const marks = useMemo(() => (diff ? new Map(diff.entries.filter((e) => e.kind !== 'removed').map((e) => [e.path, e.kind])) : null), [diff]);
  const optionRows = useMemo(() => (detail?.analysis ? annotateOptions(detail.analysis.optionSchema, live?.options?.value) : null), [detail, live]);
  const widget = data?.widgets.find((w) => w.key === selected) || null;
  const noWidgetPage = data && data.kind !== 'portal';

  return (
    <div className="msb-panel msb-portal">
      <div className="msb-panel__header">
        <strong>Portal inspector</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      {error && (
        <div className="msb-panel__error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="msb-panel__hint" role="status">
          {notice}
        </div>
      )}
      {loading && !data && (
        <div className="msb-portal__busy" aria-live="polite">
          Looking for widgets on this page...
        </div>
      )}

      {data && noWidgetPage && data.kind !== 'portal-empty' && (
        <div className="msb-portal__nope" role="status">
          <strong>{data.message}</strong>
          <p>{data.hint}</p>
        </div>
      )}

      {data && data.kind === 'portal-empty' && (
        <div className="msb-panel__warning" role="status">
          <p>{data.message}</p>
          <p>{data.hint}</p>
          <div className="msb-panel__actions">
            <button type="button" className="msb-panel__secondary" onClick={() => load(false)} disabled={loading}>
              Look again
            </button>
          </div>
        </div>
      )}

      {data && (data.kind === 'portal' || data.kind === 'portal-empty') && (
        <>
          <DebugNotice debug={data.debug} onReload={reloadWithDebug} busy={reloading} />
          {data.notes.map((n) => (
            <div className="msb-panel__warning" key={n}>
              {n}
            </div>
          ))}

          <details className="msb-portal__page">
            <summary>
              Page: <code>{data.url.pageId || data.page?.id || 'home'}</code>
              {data.portal?.title && <span className="msb-portal__muted"> in {data.portal.title}</span>}
              {!data.portal?.title && data.url.suffix && <span className="msb-portal__muted"> in /{data.url.suffix}</span>}
            </summary>
            <div className="msb-portal__pagebody">
              {data.pageLinks.length > 0 && (
                <div className="msb-portal__links">
                  {data.pageLinks.map((l) => (
                    <Link key={l.id} href={l.href} title={l.title}>
                      {l.label}
                    </Link>
                  ))}
                </div>
              )}
              {data.url.params.length > 0 && (
                <dl className="msb-portal__facts">
                  {data.url.params.map((p) => (
                    <Fact key={p.name} label={p.name}>
                      {p.value ? <code>{p.value}</code> : <span className="msb-portal__none">(empty)</span>}
                    </Fact>
                  ))}
                </dl>
              )}
              {data.debug.angular && (
                <div className="msb-panel__hint">
                  AngularJS {data.debug.version || ''}, debug info {data.debug.debugInfo === true ? 'on' : data.debug.debugInfo === false ? 'off' : 'unknown'}
                  {data.frame ? ', portal inside the classic frame' : ''}.
                </div>
              )}
            </div>
          </details>
        </>
      )}

      {data && data.widgets.length > 0 && (
        <>
          <div className="msb-portal__bar">
            <h3 className="msb-portal__title">
              Widgets <span className="msb-panel__badge">{data.widgets.length}</span>
            </h3>
            <div className="msb-portal__tools">
              <button type="button" className="msb-panel__secondary" onClick={startPick} aria-pressed={picking}>
                {picking ? 'Cancel pick' : 'Pick on page'}
              </button>
              <button type="button" className="msb-panel__secondary" onClick={() => load(true)} disabled={loading}>
                {loading ? 'Reading...' : 'Refresh'}
              </button>
            </div>
          </div>
          {picking && (
            <div className="msb-panel__hint" role="status">
              Click a widget on the page to choose it. Escape cancels. Clicks on the page do nothing else while this is on.
            </div>
          )}
          <label className="msb-portal__filter">
            <span className="msb-portal__sr">Filter widgets</span>
            <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, id or place" />
          </label>
          {shown.length === 0 ? (
            <div className="msb-panel__empty">No widget matches "{filter}".</div>
          ) : (
            <ul className="msb-portal__list" aria-label="Widgets on this page" ref={listRef}>
              {shown.map((w) => (
                <li key={w.key}>
                  <button
                    type="button"
                    className="msb-portal__row"
                    title={[w.widgetId && `Widget sys_id ${w.widgetId}`, w.instanceId && `Instance sys_id ${w.instanceId}`].filter(Boolean).join(String.fromCharCode(10))}
                    aria-pressed={w.key === selected}
                    onClick={() => select(w.key, w)}
                    onMouseEnter={() => services.portalHighlight(w.key, w.label)}
                    onMouseLeave={() => services.portalUnhighlight()}
                    onFocus={() => services.portalHighlight(w.key, w.label)}
                    onBlur={() => services.portalUnhighlight()}
                  >
                    <span className="msb-portal__name">{w.label}</span>
                    <span className="msb-portal__sub">
                      {[w.id && w.name ? w.id : '', w.title ? `"${w.title}"` : '', placementLabel(w.placement), w.instances > 1 ? `${w.instances} on this page` : '']
                        .filter(Boolean)
                        .join(' · ') || (w.hasScope === false ? 'no scope' : '')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {widget && (
        <section className="msb-portal__detail" aria-label={`Widget ${widget.label}`}>
          <div className="msb-portal__head">
            <div>
              <h3 className="msb-portal__widget">{detail?.record?.name || widget.label}</h3>
              <div className="msb-portal__sub">
                {[widget.id, placementLabel(widget.placement), widget.instances > 1 ? `${widget.instances} instances on this page` : '1 instance'].filter(Boolean).join(' · ')}
              </div>
            </div>
            <button type="button" className="msb-panel__secondary" onClick={() => services.portalReveal(widget.key, widget.label)}>
              Show on page
            </button>
          </div>

          {detailBusy && (
            <div className="msb-portal__busy" aria-live="polite">
              Reading the widget...
            </div>
          )}
          {detail?.error && <div className="msb-panel__error">{detail.error}</div>}
          {detail?.gone && <div className="msb-panel__warning">This widget is no longer on the page. Refresh the list.</div>}

          {detail && !detail.gone && !detail.error && (
            <>
              {detail.links.length > 0 && (
                <div className="msb-portal__links">
                  {detail.links.map((l) => (
                    <Link key={l.id} href={l.href} title={l.title}>
                      {l.label}
                    </Link>
                  ))}
                </div>
              )}
              <dl className="msb-portal__facts msb-portal__ids">
                <Fact label="Widget sys_id">
                  {widget.widgetId ? (
                    <>
                      <code>{widget.widgetId}</code>{' '}
                      <button type="button" className="msb-panel__link" onClick={() => copy(widget.widgetId, 'the widget sys_id')}>
                        copy
                      </button>
                    </>
                  ) : null}
                </Fact>
                <Fact label="Instance sys_id">
                  {widget.instanceId ? (
                    <>
                      <code>{widget.instanceId}</code>{' '}
                      <button type="button" className="msb-panel__link" onClick={() => copy(widget.instanceId, 'the instance sys_id')}>
                        copy
                      </button>
                      {detail.instance?.title && <span className="msb-portal__muted"> "{detail.instance.title}"</span>}
                    </>
                  ) : null}
                </Fact>
                {live?.serverTimeMs != null && <Fact label="Last server call">{live.serverTimeMs} ms</Fact>}
              </dl>

              <details className="msb-portal__sec" open>
                <summary>
                  c.data
                  {live?.scope && live.data && <span className="msb-panel__badge">{sizeText(live.data.bytes)}</span>}
                </summary>
                {!live?.scope ? (
                  <>
                    <div className="msb-portal__why" role="status">
                      {live?.explanation || 'No data could be read.'}
                      {live?.reason === 'no-debug-info' && data.debug.canReload && <> Use the notice at the top.</>}
                    </div>
                    <div className="msb-panel__actions">
                      <button type="button" className="msb-panel__secondary" onClick={refreshLive} disabled={liveBusy}>
                        {liveBusy ? 'Reading...' : 'Try again'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="msb-panel__actions">
                      <button type="button" className="msb-panel__secondary" onClick={refreshLive} disabled={liveBusy}>
                        {liveBusy ? 'Reading...' : 'Refresh'}
                      </button>
                      <button type="button" className="msb-panel__secondary" onClick={() => copy(jsonText(live.data?.value), 'c.data as JSON')} disabled={!live.data}>
                        Copy JSON
                      </button>
                      <button type="button" className="msb-panel__secondary" onClick={takeSnapshot} disabled={!live.data}>
                        {snap ? 'New snapshot' : 'Take snapshot'}
                      </button>
                      <button type="button" className="msb-panel__secondary" onClick={() => setExpand(expand === 'all' ? 'none' : 'all')}>
                        {expand === 'all' ? 'Collapse all' : 'Expand all'}
                      </button>
                    </div>
                    <label className="msb-panel__check">
                      <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                      Refresh every 2 seconds
                    </label>
                    {live.data ? (
                      <>
                        <Tree key={`${selected}:${expand}`} label="c.data" value={live.data.value} marks={marks} expand={expand} />
                        {(live.data.truncated || live.data.masked > 0) && (
                          <div className="msb-panel__hint">
                            {live.data.truncated && 'Truncated: very large or deep values are cut short here. '}
                            {live.data.masked > 0 && `${live.data.masked} value${live.data.masked === 1 ? '' : 's'} with a secret-looking name or content ${live.data.masked === 1 ? 'is' : 'are'} hidden. `}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="msb-panel__empty">The scope has no data object.</div>
                    )}
                    {live.how && <div className="msb-panel__hint">Scope found as {live.how}.</div>}
                  </>
                )}

                {snap && (
                  <div className="msb-portal__diff">
                    <h4 className="msb-portal__subtitle">
                      Since the snapshot at {new Date(snap.at).toLocaleTimeString()}
                      {diff && <span className="msb-panel__badge">{diffSummary(diff)}</span>}
                    </h4>
                    {!live?.scope ? (
                      <div className="msb-panel__empty">The data cannot be read right now, so there is nothing to compare.</div>
                    ) : diff.total === 0 ? (
                      <div className="msb-panel__empty">c.data is the same as in the snapshot. Use the page, then press Refresh.</div>
                    ) : (
                      <ul className="msb-portal__changes" aria-label="Changed keys">
                        {diff.entries.map((e) => (
                          <li key={`${e.kind}:${e.path}`}>
                            <span className={`msb-portal__kind msb-portal__kind--${e.kind}`}>{e.kind}</span>
                            <code>{e.path}</code>
                            <span className="msb-portal__arrow">
                              {e.kind === 'changed' && (
                                <>
                                  {e.before} <span aria-label="became">to</span> {e.after}
                                </>
                              )}
                              {e.kind === 'added' && e.after}
                              {e.kind === 'removed' && <>was {e.before}</>}
                            </span>
                          </li>
                        ))}
                        {diff.more > 0 && <li className="msb-portal__muted">and {diff.more} more</li>}
                      </ul>
                    )}
                    <div className="msb-panel__actions">
                      <button
                        type="button"
                        className="msb-panel__secondary"
                        onClick={() => {
                          services.portalSnapshotClear(selected);
                          setSnap(null);
                        }}
                      >
                        Clear snapshot
                      </button>
                    </div>
                  </div>
                )}
              </details>

              <details className="msb-portal__sec">
                <summary>
                  Options
                  {live?.scope && live.options && <span className="msb-panel__badge">{sizeText(live.options.bytes)}</span>}
                </summary>
                {live?.scope && live.options ? (
                  <>
                    <div className="msb-panel__actions">
                      <button type="button" className="msb-panel__secondary" onClick={() => copy(jsonText(live.options.value), 'the options as JSON')}>
                        Copy JSON
                      </button>
                    </div>
                    <Tree key={`${selected}:o:${expand}`} label="options" value={live.options.value} expand={expand === 'none' ? 'none' : 'all'} />
                  </>
                ) : (
                  <div className="msb-portal__why" role="status">
                    {live?.scope ? 'The scope has no options object.' : live?.explanation || 'The options could not be read.'}
                  </div>
                )}
                {optionRows && (optionRows.rows.length > 0 || optionRows.extra.length > 0) && <OptionTable rows={optionRows.rows} extra={optionRows.extra} />}
                {detail.analysis?.optionSchema?.error && <div className="msb-panel__hint">{detail.analysis.optionSchema.error}</div>}
                {detail.savedOptions && (
                  <>
                    <h4 className="msb-portal__subtitle">Saved on the instance record</h4>
                    <Tree key={`${selected}:s`} label="widget_parameters" value={detail.savedOptions} expand="all" />
                  </>
                )}
                {detail.instanceError && <div className="msb-panel__hint">Could not read the instance record: {detail.instanceError}</div>}
              </details>

              <details className="msb-portal__sec">
                <summary>What its code touches</summary>
                {detail.recordError ? (
                  <div className="msb-panel__warning">Could not read the widget record: {detail.recordError}</div>
                ) : (
                  <>
                    <CodeFacts detail={detail} />
                    {detail.scriptIncludes?.error && <div className="msb-panel__hint">Could not check the Script Include names: {detail.scriptIncludes.error}</div>}
                    {detail.missingColumns.length > 0 && <div className="msb-panel__hint">Not returned by this instance: {detail.missingColumns.join(', ')}.</div>}
                  </>
                )}
              </details>

              {detail.record && (
                <div className="msb-panel__hint msb-portal__about">
                  Widget <code>{detail.record.id}</code> last changed {detail.record.updatedOn || 'at an unknown time'}
                  {detail.record.updatedBy ? ` by ${detail.record.updatedBy}` : ''}
                  {detail.record.isPublic ? '. Public: visible without logging in.' : '.'}
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
