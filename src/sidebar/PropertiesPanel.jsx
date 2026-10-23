import React, { useCallback, useEffect, useRef, useState } from 'react';
import { trusted, isTrustedEvent } from './trusted.js';
import { askConfirm } from '../content/confirmDialog.js';
import {
  PROPERTY_TABLE,
  USAGE_KIND_TEXT,
  USAGE_LIMITS_NOTE,
  usageCounts,
  validateValue,
  highlightParts,
  resultsHeadline,
  propertyPath,
  startTarget,
  queryFromText,
  looksLikePropertyName,
  activeChanges,
  restoredChanges,
  changeFor,
  recordChange,
  markRestored,
  clearRestored,
  nudgeText,
  formatClock,
  changeAsk,
  restoreAsk,
  changeReason,
  writeUnlock,
} from '../lib/properties.js';

const clipText = (text, max = 48) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const errorText = (err) => (err && err.message) || String(err || 'Something went wrong.');

/** A property name that may wrap after a dot or an underscore instead of in the middle of a word. */
function Breakable({ text }) {
  return String(text)
    .split(/(?<=[._])/)
    .map((part, i) => (
      <React.Fragment key={i}>
        {i > 0 && <wbr />}
        {part}
      </React.Fragment>
    ));
}

/** A name or text with the parts that match the search marked. */
function Highlight({ text, query, name = false }) {
  return highlightParts(text, query).map((part, i) => {
    const inner = name ? <Breakable text={part.text} /> : part.text;
    return part.hit ? <mark key={i}>{inner}</mark> : <React.Fragment key={i}>{inner}</React.Fragment>;
  });
}

/** The value of a property as a short chip (lists). */
function ValueChip({ prop }) {
  if (prop.hidden) return <span className="msb-prop__chip msb-prop__chip--hidden">hidden</span>;
  if (prop.unreadable) return <span className="msb-prop__chip msb-prop__chip--hidden">unreadable</span>;
  if (prop.empty) return <span className="msb-prop__chip msb-prop__chip--empty">(empty)</span>;
  const boolean = prop.typeKind === 'boolean' || /^(true|false)$/.test(prop.value);
  const tone = boolean ? (prop.value === 'true' ? ' msb-prop__chip--on' : ' msb-prop__chip--off') : '';
  return (
    <span className={`msb-prop__chip${tone}`} title={prop.long ? 'Long value, open it to read it all' : undefined}>
      {clipText(prop.value, 26)}
    </span>
  );
}

/** The value in full, shown the way its type is read. */
function ValueView({ prop }) {
  if (prop.hidden) {
    return (
      <div className="msb-prop__hiddenbox">
        <strong>Hidden</strong>
        <span>
          NowBuddy never shows, copies or changes secrets. {prop.hiddenReason} Open the record in the platform to see or change it.
        </span>
      </div>
    );
  }
  if (prop.unreadable) {
    return (
      <div className="msb-prop__hiddenbox">
        <strong>Could not read the value</strong>
        <span>The instance did not return the value column. Your user may not be allowed to read it. This is not the same as an empty value.</span>
      </div>
    );
  }
  if (prop.empty) return <span className="msb-prop__empty">(empty)</span>;
  if (prop.long) {
    return (
      <pre className="msb-prop__long" tabIndex={0} aria-label="Property value">
        {prop.value}
      </pre>
    );
  }
  if (prop.typeKind === 'boolean' || /^(true|false)$/.test(prop.value)) {
    return <span className={`msb-prop__bool msb-prop__bool--${prop.value === 'true' ? 'on' : 'off'}`}>{prop.value}</span>;
  }
  return <code className="msb-prop__value">{prop.value}</code>;
}

/**
 * On production, or an instance NowBuddy cannot place, changes stay locked until the instance name is typed: the same rule
 * as My work and Push. The confirmation still follows.
 */
function Unlock({ guard, typed, setTyped }) {
  const unlock = writeUnlock(guard, typed);
  const where = guard.env === 'prod' ? `${guard.host} is production.` : `NowBuddy cannot tell whether ${guard.host} is production, so it treats it as production.`;
  if (!unlock.instance) {
    return (
      <div className="msb-panel__warning msb-prop__unlock" role="note">
        {where} The instance name could not be read, so properties cannot be changed from here. Use the platform.
      </div>
    );
  }
  return (
    <div className="msb-panel__warning msb-prop__unlock">
      <label className="msb-prop__unlock-label">
        <span>
          {where} To change or restore a property here, type <code>{unlock.instance}</code>.
        </span>
        <input type="text" value={typed} onChange={trusted((e) => setTyped(e.target.value))} placeholder={unlock.instance} aria-label="Instance name, to unlock changes" spellCheck="false" autoCapitalize="off" autoComplete="off" />
      </label>
      <span className="msb-prop__unlock-state" role="status">
        {unlock.ok ? 'Unlocked. Each change is still confirmed.' : 'Locked.'}
      </span>
    </div>
  );
}

/** The nudge: what was changed from this panel and not yet restored. */
function Nudge({ changes, busy, onRestore, onOpen, now }) {
  if (!changes.length) return null;
  return (
    <section className="msb-prop__nudge" aria-label="Changes made from this panel">
      <h3 className="msb-prop__h">Changed from this panel</h3>
      <ul className="msb-prop__nudge-list">
        {changes.map((c) => (
          <li key={c.id} className="msb-prop__nudge-item">
            <div className="msb-prop__nudge-main">
              <button type="button" className="msb-prop__namebtn" onClick={() => onOpen(c)}>
                {c.name}
              </button>
              <span className="msb-prop__nudge-text">{nudgeText(c, now)}</span>
              <span className="msb-prop__nudge-values">
                was <code>{clipText(c.original, 30) || '(empty)'}</code>, now <code>{clipText(c.current, 30) || '(empty)'}</code>
              </span>
            </div>
            <button type="button" className="msb-panel__secondary" disabled={busy} onClick={trusted(() => onRestore(c))}>
              Restore
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Edit control for the property's type. Applying goes through the confirmation in the panel. */
function Editor({ prop, busy, onApply }) {
  const editor = prop.editor;
  const [draft, setDraft] = useState(prop.value);
  useEffect(() => setDraft(prop.value), [prop.sysId, prop.value]);

  if (editor.kind === 'none') return <p className="msb-panel__hint">{editor.reason}</p>;
  if (editor.kind === 'toggle') {
    return (
      <div>
        <div className="msb-prop__seg" role="group" aria-label={`Set ${prop.name}`}>
          {['true', 'false'].map((v) => (
            <button key={v} type="button" className="msb-prop__segbtn" aria-pressed={prop.value === v} disabled={busy} onClick={trusted(() => prop.value !== v && onApply(prop, v))}>
              {v}
            </button>
          ))}
        </div>
        {editor.inferred && <p className="msb-panel__hint">The type is string, but the value is true or false, so it is offered as a switch.</p>}
      </div>
    );
  }
  const same = draft === prop.value;
  // Only a real click on the button or a real Enter in the box applies the change. A submit event proves nothing: the
  // browser fires a trusted one even for a script's button.click() or form.requestSubmit(), so the form only stops
  // navigation and the two real inputs are checked instead.
  const apply = () => {
    if (!same && !busy) onApply(prop, draft);
  };
  const onKeyDown = (event) => {
    if (event.key === 'Enter' && editor.kind !== 'textarea' && isTrustedEvent(event)) {
      event.preventDefault();
      apply();
    }
  };
  return (
    <form className="msb-prop__edit" onSubmit={(event) => event.preventDefault()}>
      {editor.kind === 'select' ? (
        <select aria-label={`New value for ${prop.name}`} value={editor.options.includes(draft) ? draft : ''} onChange={(e) => setDraft(e.target.value)}>
          {!editor.options.includes(prop.value) && <option value="">{prop.value === '' ? '(empty)' : `${prop.value} (current)`}</option>}
          {editor.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : editor.kind === 'textarea' ? (
        <textarea aria-label={`New value for ${prop.name}`} rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck="false" />
      ) : (
        <input
          type="text"
          aria-label={`New value for ${prop.name}`}
          value={draft}
          inputMode={editor.kind === 'number' ? 'numeric' : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck="false"
          autoCapitalize="off"
          autoComplete="off"
        />
      )}
      <button type="button" className="msb-panel__run" disabled={busy || same} onClick={trusted(apply)}>
        Change...
      </button>
    </form>
  );
}

/** Which scripts read, set or mention this property. */
function UsageSection({ name, state, only, setOnly, onFind }) {
  const data = state.data;
  const counts = data ? usageCounts(data.hits) : null;
  const shown = data ? (only === 'all' ? data.hits : data.hits.filter((h) => h.kind === only)) : [];
  return (
    <section className="msb-prop__section" aria-label="Scripts that use this property">
      <h3 className="msb-prop__h">Who reads it</h3>
      <div className="msb-panel__actions">
        <button type="button" className="msb-panel__secondary" onClick={onFind} disabled={state.phase === 'loading'}>
          {data ? 'Search again' : 'Find scripts that use it'}
        </button>
      </div>
      {state.phase === 'idle' && <p className="msb-panel__hint">Searches business rules, script includes, client scripts, UI actions, ACLs, widgets, fix scripts, UI pages and more for {name}. Read-only.</p>}
      {state.phase === 'loading' && (
        <p className="msb-prop__busy" role="status">
          Searching script tables...
        </p>
      )}
      {state.phase === 'error' && <div className="msb-panel__error">{state.error}</div>}
      {data && (
        <>
          <p className="msb-prop__summary" role="status">
            {data.summary}
          </p>
          {data.masked && <p className="msb-panel__hint">The values on these lines are masked, because this property is (or could be) a secret. The defaults scripts pass are not shown.</p>}
          {data.errors.length > 0 && (
            <details className="msb-prop__notes">
              <summary>
                {data.errors.length} {data.errors.length === 1 ? 'table' : 'tables'} could not be searched
              </summary>
              <ul>
                {data.errors.map((e) => (
                  <li key={e.table}>
                    {e.label}: {e.error}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {data.hits.length > 0 && (
            <div className="msb-prop__filters" role="group" aria-label="Show only">
              {[['all', `All ${data.hits.length}`], ['write', `Sets ${counts.write}`], ['read', `Reads ${counts.read}`], ['mention', `Mentions ${counts.mention}`]]
                .filter(([key]) => key === 'all' || counts[key] > 0)
                .map(([key, label]) => (
                  <button key={key} type="button" className="msb-prop__filter" aria-pressed={only === key} onClick={() => setOnly(key)}>
                    {label}
                  </button>
                ))}
            </div>
          )}
          <ul className="msb-prop__hits">
            {shown.map((hit) => (
              <li key={`${hit.table}:${hit.sysId}:${hit.field}`} className="msb-prop__hit">
                <div className="msb-prop__hit-head">
                  <a className="msb-panel__link" href={hit.url} target="_blank" rel="noopener noreferrer">
                    {hit.name}
                  </a>
                  <span className={`msb-prop__kind msb-prop__kind--${hit.kind}`}>{USAGE_KIND_TEXT[hit.kind]}</span>
                </div>
                <div className="msb-prop__hit-meta">
                  {hit.label}
                  {hit.field && hit.field !== 'script' ? `, ${hit.field}` : ''}
                </div>
                <ul className="msb-prop__lines">
                  {hit.lines.slice(0, 3).map((l) => {
                    const notes = [
                      l.kind === 'read' && l.arg ? `default ${l.arg}` : '',
                      l.kind === 'write' && l.arg ? `sets ${l.arg}` : '',
                      l.via ? `through ${l.via}` : '',
                      l.caseDiffers ? 'different capitals' : '',
                      l.kind !== hit.kind ? `only ${l.kind === 'mention' ? 'a mention' : l.kind === 'read' ? 'a read' : 'a write'}` : '',
                    ].filter(Boolean);
                    return (
                      <li key={l.line} className="msb-prop__line">
                        <span className="msb-prop__lineno">{l.line}</span>
                        <span className="msb-prop__linebody">
                          <code>{l.text}</code>
                          {notes.length > 0 && <span className="msb-prop__muted">{notes.join(' · ')}</span>}
                        </span>
                      </li>
                    );
                  })}
                  {hit.lines.length > 3 && <li className="msb-prop__muted msb-prop__more">and {hit.lines.length - 3} more lines</li>}
                </ul>
              </li>
            ))}
          </ul>
          <p className="msb-panel__hint">{USAGE_LIMITS_NOTE}</p>
        </>
      )}
    </section>
  );
}

/** Compare this property with the same one on another known instance. */
function CompareSection({ prop, services, here }) {
  const [known, setKnown] = useState([]);
  const [host, setHost] = useState('');
  const [state, setState] = useState({ phase: 'idle' });
  useEffect(() => {
    let live = true;
    Promise.resolve(services.listInstances?.())
      .then((list) => {
        if (!live) return;
        const others = (Array.isArray(list) ? list : []).filter((i) => i.host && i.host.toLowerCase() !== String(here || '').toLowerCase());
        setKnown(others);
        setHost((h) => h || others[0]?.host || '');
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [services, here]);
  useEffect(() => setState({ phase: 'idle' }), [prop.sysId]);
  // The property on screen now: a comparison that comes back after the person moved to another property is dropped,
  // so one property's "differs" never shows under another.
  const shownId = useRef(prop.sysId);
  shownId.current = prop.sysId;

  if (prop.hidden || !services.propertyExplorerCompare) return null;
  if (!known.length) {
    return (
      <section className="msb-prop__section" aria-label="Compare with another instance">
        <h3 className="msb-prop__h">Compare with another instance</h3>
        <p className="msb-panel__hint">Add your other instances in Options, and you can compare this value with theirs here.</p>
      </section>
    );
  }
  const label = known.find((i) => i.host === host)?.label || host;
  const compare = trusted(async () => {
    const asked = prop.sysId;
    setState({ phase: 'loading' });
    try {
      const data = await services.propertyExplorerCompare({ sysId: asked, host });
      if (shownId.current === asked) setState({ phase: 'done', data });
    } catch (err) {
      if (shownId.current === asked) setState({ phase: 'error', error: errorText(err) });
    }
  });
  const outcome = state.data?.outcome;
  return (
    <section className="msb-prop__section" aria-label="Compare with another instance">
      <h3 className="msb-prop__h">Compare with another instance</h3>
      <div className="msb-prop__edit">
        <select aria-label="Other instance" value={host} onChange={(e) => setHost(e.target.value)}>
          {known.map((i) => (
            <option key={i.host} value={i.host}>
              {i.label ? `${i.label} (${i.host})` : i.host}
            </option>
          ))}
        </select>
        <button type="button" className="msb-panel__secondary" onClick={compare} disabled={state.phase === 'loading' || !host}>
          {state.phase === 'loading' ? 'Comparing...' : `Compare with ${clipText(label, 18)}`}
        </button>
      </div>
      {state.phase === 'error' && <div className="msb-panel__error">{state.error}</div>}
      {outcome && (
        <div className="msb-prop__compare" role="status">
          <p>
            {outcome.text} {outcome.state === 'same' || outcome.state === 'differs' ? `(${state.data.host})` : ''}
          </p>
          {outcome.state === 'differs' && (
            <dl className="msb-prop__pairs">
              <dt>Here</dt>
              <dd>
                <code>{outcome.here === '' ? '(empty)' : clipText(outcome.here, 200)}</code>
              </dd>
              <dt>There</dt>
              <dd>
                <code>{outcome.there === '' ? '(empty)' : clipText(outcome.there, 200)}</code>
              </dd>
            </dl>
          )}
          {outcome.others?.length > 0 && <p className="msb-panel__hint">Other fields that differ: {outcome.others.join(', ')}.</p>}
        </div>
      )}
    </section>
  );
}

/**
 * System properties: find one, read it, see which scripts read it, change it safely and put it back.
 * `/prop glide.ui` pre-fills the search; an exact name opens that property; a sys_properties record on screen opens it.
 */
export default function PropertiesPanel({ context, params, services, onClose, onAskAi }) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState('home'); // home | list | detail
  const [list, setList] = useState({ phase: 'idle' });
  const [selected, setSelected] = useState(null); // { property, others, notes }
  const [detailError, setDetailError] = useState('');
  const [home, setHome] = useState({ switches: { phase: 'loading' }, recent: { phase: 'loading' } });
  const [usage, setUsage] = useState({ phase: 'idle' });
  const [only, setOnly] = useState('all');
  const [guard, setGuard] = useState(null);
  const [changes, setChanges] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [typed, setTyped] = useState('');
  const searchGen = useRef(0);
  const usageGen = useRef(0);
  // Which property the person asked for last. A slow read of an earlier one (a click, the record on the page, an exact
  // name search) is dropped when it comes back, so it never replaces what is on screen.
  const openGen = useRef(0);
  const headingRef = useRef(null);
  const rootRef = useRef(null);
  const firstView = useRef(true);
  const changesRef = useRef([]);
  changesRef.current = changes;

  const host = guard?.host || '';

  // --- Loading --------------------------------------------------------------------------------------------------

  const patchProperty = useCallback((prop) => {
    if (!prop?.sysId) return;
    const swap = (p) => (p.sysId === prop.sysId ? prop : p);
    setList((l) => (l.data ? { ...l, data: { ...l.data, rows: l.data.rows.map(swap) } } : l));
    setHome((h) => ({
      switches: h.switches.data ? { ...h.switches, data: h.switches.data.map((s) => (s.property?.sysId === prop.sysId ? { ...s, property: prop } : s)) } : h.switches,
      recent: h.recent.data ? { ...h.recent, data: h.recent.data.map(swap) } : h.recent,
    }));
  }, []);

  const loadHome = useCallback(() => {
    setHome({ switches: { phase: 'loading' }, recent: { phase: 'loading' } });
    Promise.allSettled([services.propertyExplorerSwitches(), services.propertyExplorerRecent()]).then(([sw, rc]) =>
      setHome({
        switches: sw.status === 'fulfilled' ? { phase: 'done', data: sw.value } : { phase: 'error', error: errorText(sw.reason) },
        recent: rc.status === 'fulfilled' ? { phase: 'done', data: rc.value } : { phase: 'error', error: errorText(rc.reason) },
      })
    );
  }, [services]);

  const saveChanges = useCallback(
    async (next) => {
      setChanges(next);
      try {
        await services.propertyExplorerSaveChanges(next);
      } catch (err) {
        setActionError(`The list of changes could not be saved in this browser: ${errorText(err)}`);
      }
    },
    [services]
  );

  const select = useCallback((property, extra = {}) => {
    openGen.current += 1;
    setSelected({ property, others: 0, notes: [], ...extra });
    setDetailError('');
    setNotice('');
    setActionError('');
    setUsage({ phase: 'idle' });
    setOnly('all');
    usageGen.current += 1;
    setView('detail');
  }, []);

  const openBySysId = useCallback(
    async (sysId) => {
      openGen.current += 1;
      const mine = openGen.current;
      setView('detail');
      setSelected(null);
      setDetailError('');
      try {
        const got = await services.propertyExplorerGet({ sysId });
        if (mine !== openGen.current) return;
        if (!got.property) {
          setDetailError('That property could not be found. It may have been deleted, or your user cannot read it.');
          return;
        }
        select(got.property, { others: got.others, notes: got.notes });
      } catch (err) {
        if (mine === openGen.current) setDetailError(errorText(err));
      }
    },
    [services, select]
  );

  const run = useCallback(
    async (text, { openExact = false } = {}) => {
      const q = queryFromText(text);
      if (!q) {
        setView('home');
        setList({ phase: 'idle' });
        return;
      }
      searchGen.current += 1;
      const mine = searchGen.current;
      openGen.current += 1;
      const opened = openGen.current;
      setList({ phase: 'loading', query: q });
      setView('list');
      setSelected(null);
      try {
        const data = await services.propertyExplorerSearch(q);
        if (mine !== searchGen.current) return;
        setList({ phase: 'done', query: q, data });
        const top = data.rows[0];
        // Opening the exact match only while the person has not opened something else meanwhile.
        if (openExact && top && top.name.toLowerCase() === q.toLowerCase() && opened === openGen.current) select(top);
      } catch (err) {
        if (mine === searchGen.current) setList({ phase: 'error', query: q, error: errorText(err) });
      }
    },
    [services, select]
  );

  // Once, when the panel opens: who and where we are, what was changed earlier, the switches.
  useEffect(() => {
    services.propertyExplorerGuard?.().then(setGuard, (err) => setActionError(errorText(err)));
    services.propertyExplorerChanges?.().then((saved) => setChanges(Array.isArray(saved) ? saved : []), () => {});
    loadHome();
    const tick = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opened (or opened again while showing) with text, or on a sys_properties record.
  useEffect(() => {
    const start = startTarget({ args: params?.args, context });
    if (start.kind === 'search') {
      setQuery(start.query);
      run(start.query, { openExact: start.openExact });
    } else if (start.kind === 'record') {
      openBySysId(start.sysId);
    } else if (!context) {
      services.propertyExplorerPage?.().then((page) => page?.sysId && openBySysId(page.sysId), () => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.args, context?.table, context?.sysId]);

  // A new property is the new heading: keyboard and screen reader users land on it, and the view starts at the top.
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    rootRef.current?.scrollIntoView?.({ block: 'start' });
    if (view === 'detail' && selected) headingRef.current?.focus({ preventScroll: true });
  }, [view, selected?.property?.sysId]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Usage -------------------------------------------------------------------------------------------------------

  const findUsage = async () => {
    const name = selected?.property?.name;
    if (!name) return;
    usageGen.current += 1;
    const mine = usageGen.current;
    setUsage({ phase: 'loading' });
    setOnly('all');
    try {
      const data = await services.propertyExplorerUsage(name);
      if (mine === usageGen.current) setUsage({ phase: 'done', data });
    } catch (err) {
      if (mine === usageGen.current) setUsage({ phase: 'error', error: errorText(err) });
    }
  };

  // --- Writing: change and restore, both asked first --------------------------------------------------------------

  const readFresh = async (sysId) => {
    const got = await services.propertyExplorerGet({ sysId });
    if (!got.property) throw new Error('The property no longer exists, or your user can no longer read it.');
    if (got.property.hidden) throw new Error('This property is hidden. NowBuddy does not change secrets.');
    return got.property;
  };

  // The update set a configuration change lands in; null when it cannot be read (the confirmation says so).
  const currentUpdateSet = async () => {
    try {
      return (await services.propertyExplorerUpdateSet?.()) || null;
    } catch {
      return null;
    }
  };

  const afterWrite = (after, wanted) => {
    patchProperty(after);
    setSelected((s) => (s && s.property.sysId === after.sysId ? { ...s, property: after } : s));
    return after.hidden ? false : after.value === wanted;
  };

  // The guard and the typed instance name, checked when the person clicks (not when the panel loaded).
  const unlockFor = async () => {
    const g = guard || (await services.propertyExplorerGuard());
    const unlock = writeUnlock(g, typed);
    if (!unlock.ok) throw new Error(unlock.instance ? `Type "${unlock.instance}" in the box at the top of the panel to change properties on this instance.` : 'The instance name could not be read, so properties cannot be changed from here.');
    return g;
  };

  // After the confirmation: the value must still be the one the confirmation showed. Someone (or a script) that changed
  // it while the dialog was open would otherwise be overwritten silently, and Restore would go back to the wrong value.
  const stillAsShown = async (shown) => {
    const live = await readFresh(shown.sysId);
    if (live.value !== shown.value) {
      patchProperty(live);
      setSelected((s) => (s && s.property.sysId === live.sysId ? { ...s, property: live } : s));
      throw new Error(`${shown.name} changed while you were confirming: it now holds "${clipText(live.value, 60) || '(empty)'}". Nothing was written. Look at the new value and try again.`);
    }
  };

  const applyChange = async (prop, wanted) => {
    if (busy) return;
    const checked = validateValue(prop, wanted);
    if (!checked.ok) {
      setActionError(checked.error);
      return;
    }
    if (!services.agentExecute) {
      setActionError('Changing a record is not available here.');
      return;
    }
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      const g = await unlockFor();
      // The confirmation shows what the instance holds right now, not what the panel showed a minute ago.
      const fresh = await readFresh(prop.sysId);
      const again = validateValue(fresh, checked.value);
      if (!again.ok) {
        patchProperty(fresh);
        setSelected((s) => (s ? { ...s, property: fresh } : s));
        setActionError(again.unchanged ? 'Nothing to change: the property already holds that value.' : again.error);
        return;
      }
      // What is confirmed is exactly what is written: this name, this record, this value.
      const next = again.value;
      const updateSet = await currentUpdateSet();
      const yes = await askConfirm(changeAsk({ prop: fresh, next, guard: g, host: g.host, updateSet }));
      if (!yes) return;
      await stillAsShown(fresh);
      const result = await services.agentExecute('update_record', { table: PROPERTY_TABLE, sysId: fresh.sysId, fields: { value: next }, reason: changeReason(fresh, next) });
      if (result && result.updated === false) {
        setNotice(result.note || 'Nothing was written.');
        return;
      }
      const after = await readFresh(fresh.sysId);
      const landed = afterWrite(after, next);
      await saveChanges(recordChange(changesRef.current, { host: g.host, sysId: fresh.sysId, name: fresh.name, previous: fresh.value, next: after.value, at: Date.now() }));
      setNow(Date.now());
      setNotice(
        landed
          ? `Changed ${fresh.name}. The old value is kept, so you can restore it.`
          : `Changed ${fresh.name}, but the instance now holds "${clipText(after.value, 60)}" instead of "${clipText(next, 60)}": a business rule or the property type changed it.`
      );
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (change) => {
    if (busy) return;
    if (!services.agentExecute) {
      setActionError('Changing a record is not available here.');
      return;
    }
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      const g = await unlockFor();
      if (change.host !== g.host) throw new Error('That change was made on another instance. Nothing was written.');
      const fresh = await readFresh(change.sysId);
      const updateSet = await currentUpdateSet();
      // The name shown is the record's name now, read with the value: the one the write goes to.
      const yes = await askConfirm(restoreAsk({ change: { ...change, name: fresh.name }, live: fresh.value, guard: g, host: g.host, updateSet }));
      if (!yes) return;
      await stillAsShown(fresh);
      const result = await services.agentExecute('update_record', { table: PROPERTY_TABLE, sysId: change.sysId, fields: { value: change.original }, reason: changeReason(fresh, change.original, true) });
      const after = await readFresh(change.sysId);
      afterWrite(after, change.original);
      await saveChanges(markRestored(changesRef.current, change.id, Date.now()));
      setNow(Date.now());
      setNotice(
        result && result.updated === false
          ? `${change.name} already held the original value. Marked as restored.`
          : after.value === change.original
            ? `Restored ${change.name} to "${clipText(change.original, 60) || '(empty)'}".`
            : `Wrote the original value back, but the instance now holds "${clipText(after.value, 60)}". A business rule may have changed it.`
      );
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // --- Small actions -----------------------------------------------------------------------------------------------

  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`Copied ${what}.`);
    } catch {
      setNotice('The browser blocked the copy. Click in the page first, then try again.');
    }
  };

  const openChange = (change) => openBySysId(change.sysId);
  const myChanges = activeChanges(changes, host);
  const earlier = restoredChanges(changes, host);
  const prop = selected?.property || null;
  const ownChange = prop ? changeFor(changes, host, prop.sysId) : null;
  const nudgeList = view === 'detail' && prop ? myChanges.filter((c) => c.sysId !== prop.sysId) : myChanges;
  const unlock = writeUnlock(guard, typed);
  const locked = !unlock.ok;
  // The unlock box shows while there is something on screen that could be changed or restored.
  const writableOnScreen = nudgeList.length > 0 || (view === 'detail' && prop && !prop.hidden && (prop.editor.kind !== 'none' || Boolean(ownChange)));

  const back = () => {
    openGen.current += 1;
    setSelected(null);
    setDetailError('');
    setNotice('');
    setActionError('');
    setView(list.phase === 'done' || list.phase === 'loading' ? 'list' : 'home');
  };

  // --- Rendering ---------------------------------------------------------------------------------------------------

  const resultRow = (p, withQuery) => (
    <li key={p.sysId || p.name}>
      <button type="button" className="msb-prop__row" onClick={() => select(p)}>
        <span className="msb-prop__row-top">
          <span className="msb-prop__name">{withQuery ? <Highlight text={p.name} query={withQuery} name /> : <Breakable text={p.name} />}</span>
          <ValueChip prop={p} />
        </span>
        {p.description && (
          <span className="msb-prop__desc">
            {withQuery ? <Highlight text={clipText(p.description, 160)} query={withQuery} /> : clipText(p.description, 160)}
          </span>
        )}
        <span className="msb-prop__meta">
          {[p.typeLabel, p.scope && p.scope !== 'global' ? p.scope : '', p.matchedIn === 'value' ? 'matches the value' : '', p.isPrivate ? 'private' : ''].filter(Boolean).join(' · ')}
        </span>
      </button>
    </li>
  );

  const renderHome = () => {
    const switches = home.switches;
    const recent = home.recent;
    return (
      <>
        <section className="msb-prop__section" aria-label="Developer switches">
          <h3 className="msb-prop__h">Developer switches</h3>
          <p className="msb-panel__hint">Properties developers often check or flip. Each one is looked up on this instance.</p>
          {switches.phase === 'loading' && <p className="msb-prop__busy">Looking them up...</p>}
          {switches.phase === 'error' && <div className="msb-panel__error">Could not read the properties: {switches.error}</div>}
          {switches.phase === 'done' && (
            <ul className="msb-prop__switches">
              {switches.data.map((s) => (
                <li key={s.name} className="msb-prop__switch">
                  <div className="msb-prop__row-top">
                    {s.found ? (
                      <button type="button" className="msb-prop__namebtn" onClick={() => select(s.property)}>
                        <Breakable text={s.name} />
                      </button>
                    ) : (
                      <span className="msb-prop__name">
                        <Breakable text={s.name} />
                      </span>
                    )}
                    {s.found ? <ValueChip prop={s.property} /> : <span className="msb-prop__chip msb-prop__chip--empty">not present on this instance</span>}
                  </div>
                  <p className="msb-prop__what">{s.what}</p>
                  <p className="msb-prop__care">Careful: {s.careful}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="msb-prop__section" aria-label="Recently changed properties">
          <h3 className="msb-prop__h">Changed lately</h3>
          {recent.phase === 'loading' && <p className="msb-prop__busy">Reading...</p>}
          {recent.phase === 'error' && <div className="msb-panel__error">Could not read recent changes: {recent.error}</div>}
          {recent.phase === 'done' && recent.data.length === 0 && <p className="msb-panel__hint">The instance did not return an update time for properties, so there is no recent list.</p>}
          {recent.phase === 'done' && recent.data.length > 0 && (
            <ul className="msb-prop__rows">
              {recent.data.map((p) => (
                <li key={p.sysId}>
                  <button type="button" className="msb-prop__row" onClick={() => select(p)}>
                    <span className="msb-prop__row-top">
                      <span className="msb-prop__name">
                        <Breakable text={p.name} />
                      </span>
                      <ValueChip prop={p} />
                    </span>
                    <span className="msb-prop__meta">{[p.updatedOn, p.updatedBy].filter(Boolean).join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {earlier.length > 0 && (
          <details className="msb-prop__notes">
            <summary>
              Restored earlier ({earlier.length})
            </summary>
            <ul>
              {earlier.map((c) => (
                <li key={c.id}>
                  {c.name}: put back to <code>{clipText(c.original, 40) || '(empty)'}</code> at {formatClock(c.restoredAt, now)}
                </li>
              ))}
            </ul>
            <button type="button" className="msb-panel__link" onClick={() => saveChanges(clearRestored(changes, host))}>
              Clear this list
            </button>
          </details>
        )}
      </>
    );
  };

  const renderList = () => (
    <>
      {list.phase === 'loading' && (
        <p className="msb-prop__busy" role="status">
          Searching...
        </p>
      )}
      {list.phase === 'error' && <div className="msb-panel__error">{list.error}</div>}
      {list.phase === 'done' && (
        <>
          <p className="msb-prop__summary" role="status">
            {resultsHeadline({ query: list.query, shown: list.data.rows.length, total: list.data.total, capped: list.data.capped })}
          </p>
          {list.data.notes.map((n) => (
            <p key={n} className="msb-panel__hint">
              {n}
            </p>
          ))}
          <ul className="msb-prop__rows">{list.data.rows.map((p) => resultRow(p, list.query))}</ul>
        </>
      )}
    </>
  );

  const renderDetail = () => {
    if (detailError) return <div className="msb-panel__error">{detailError}</div>;
    if (!prop) {
      return (
        <p className="msb-prop__busy" role="status">
          Reading the property...
        </p>
      );
    }
    const editable = prop.editor.kind !== 'none';
    return (
      <article aria-label={prop.name}>
        <h2 className="msb-prop__title" ref={headingRef} tabIndex={-1}>
          <Breakable text={prop.name} />
        </h2>
        <div className="msb-prop__tags">
          <span className="msb-prop__tag">{prop.typeLabel}</span>
          {prop.scope && <span className="msb-prop__tag">{prop.scope}</span>}
          {prop.isPrivate && <span className="msb-prop__tag">private</span>}
          {selected.others > 0 && <span className="msb-prop__tag">{selected.others} more with this name</span>}
        </div>

        <section className="msb-prop__section" aria-label="Value">
          <h3 className="msb-prop__h">Value</h3>
          <ValueView prop={prop} />
          <div className="msb-panel__actions">
            <button type="button" className="msb-panel__secondary" onClick={() => copy(prop.name, 'the name')}>
              Copy name
            </button>
            {!prop.hidden && !prop.unreadable && (
              <button type="button" className="msb-panel__secondary" onClick={() => copy(prop.value, 'the value')}>
                Copy value
              </button>
            )}
            {propertyPath(prop.sysId) && (
              <a className="msb-prop__linkbtn" href={propertyPath(prop.sysId)} target="_blank" rel="noopener noreferrer">
                Open the record
              </a>
            )}
          </div>
        </section>

        {prop.description && (
          <section className="msb-prop__section" aria-label="Description">
            <h3 className="msb-prop__h">What it is for</h3>
            <p className="msb-prop__text">{prop.description}</p>
          </section>
        )}

        <dl className="msb-prop__facts">
          {prop.choices.length > 0 && (
            <>
              <dt>Choices</dt>
              <dd>{prop.choices.join(', ')}</dd>
            </>
          )}
          {prop.suffix && (
            <>
              <dt>Suffix</dt>
              <dd>{prop.suffix}</dd>
            </>
          )}
          {prop.readRoles && (
            <>
              <dt>Read roles</dt>
              <dd>{prop.readRoles}</dd>
            </>
          )}
          {prop.writeRoles && (
            <>
              <dt>Write roles</dt>
              <dd>{prop.writeRoles}</dd>
            </>
          )}
          {prop.scopeName && prop.scopeName !== prop.scope && (
            <>
              <dt>Application</dt>
              <dd>{prop.scopeName}</dd>
            </>
          )}
          {(prop.updatedOn || prop.updatedBy) && (
            <>
              <dt>Last updated</dt>
              <dd>{[prop.updatedOn, prop.updatedBy && `by ${prop.updatedBy}`].filter(Boolean).join(' ')}</dd>
            </>
          )}
        </dl>

        {!prop.hidden && (
        <section className="msb-prop__section" aria-label="Change the value">
          <h3 className="msb-prop__h">Change it</h3>
          {ownChange && (
            <div className="msb-prop__nudge msb-prop__nudge--inline">
              <div className="msb-prop__nudge-item">
                <div className="msb-prop__nudge-main">
                  <span className="msb-prop__nudge-text">{nudgeText(ownChange, now)}</span>
                  <span className="msb-prop__nudge-values">
                    was <code>{clipText(ownChange.original, 30) || '(empty)'}</code>, now <code>{clipText(ownChange.current, 30) || '(empty)'}</code>
                  </span>
                </div>
                <button type="button" className="msb-panel__secondary" disabled={busy || locked} onClick={trusted(() => restore(ownChange))}>
                  Restore
                </button>
              </div>
            </div>
          )}
          {editable && guard?.guarded && locked && unlock.instance && (
            <p className="msb-panel__hint">
              Locked: type <code>{unlock.instance}</code> in the box at the top of the panel to change it here.
            </p>
          )}
          <Editor prop={prop} busy={busy || locked} onApply={applyChange} />
          {editable && <p className="msb-panel__hint">A property applies to the whole instance straight away. Each change is confirmed and can be restored.</p>}
        </section>
        )}

        <UsageSection name={prop.name} state={usage} only={only} setOnly={setOnly} onFind={findUsage} />
        <CompareSection prop={prop} services={services} here={host} />

        {!prop.hidden && onAskAi && (
          <div className="msb-panel__actions">
            <button
              type="button"
              className="msb-panel__secondary"
              onClick={() => onAskAi(`What does ${prop.name} do?`, `Explain the ServiceNow system property "${prop.name}" (type ${prop.typeLabel}, current value "${clipText(prop.value, 200)}"${prop.description ? `, description: "${clipText(prop.description, 300)}"` : ''}). What does it control, what is a sensible value, and what could go wrong if I change it?`)}
            >
              Ask AI what this does
            </button>
          </div>
        )}
      </article>
    );
  };

  const submit = (event) => {
    event.preventDefault();
    const q = queryFromText(query);
    setQuery(q);
    run(q, { openExact: looksLikePropertyName(q) });
  };

  return (
    <div className="msb-panel msb-prop" ref={rootRef}>
      <div className="msb-panel__header">
        <strong>System properties</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <form className="msb-prop__search" onSubmit={submit} role="search">
        <label className="msb-prop__label">
          Find a property
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="name, description or value" spellCheck="false" autoCapitalize="off" autoComplete="off" />
        </label>
        <button type="submit" className="msb-panel__run" disabled={list.phase === 'loading'}>
          Find
        </button>
      </form>

      {guard?.guarded && writableOnScreen && <Unlock guard={guard} typed={typed} setTyped={setTyped} />}

      <Nudge changes={nudgeList} busy={busy || locked} onRestore={restore} onOpen={openChange} now={now} />

      {(notice || actionError) && (
        <div className="msb-prop__messages">
          {notice && (
            <p className="msb-prop__notice" role="status">
              {notice}
            </p>
          )}
          {actionError && (
            <div className="msb-panel__error" role="alert">
              {actionError}
            </div>
          )}
        </div>
      )}

      {view !== 'home' && (
        <button type="button" className="msb-prop__back" onClick={view === 'detail' ? back : () => { searchGen.current += 1; openGen.current += 1; setView('home'); setList({ phase: 'idle' }); setQuery(''); }}>
          {view === 'detail' ? (list.phase === 'done' ? `Back to ${list.data.rows.length} ${list.data.rows.length === 1 ? 'result' : 'results'}` : 'Back') : 'Back to the start'}
        </button>
      )}

      {view === 'home' && renderHome()}
      {view === 'list' && renderList()}
      {view === 'detail' && renderDetail()}
    </div>
  );
}
