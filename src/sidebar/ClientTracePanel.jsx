import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import {
  KINDS,
  KIND_FILTERS,
  SLOW_AJAX_MS,
  buildRows,
  selectDocuments,
  documentsOf,
  filterRows,
  fieldsOf,
  framesOf,
  collectRefs,
  attribute,
  describeRow,
  buildStories,
  findFindings,
  toMarkdown,
  fmtMs,
  frameText,
  isError,
  isJslog,
} from '../lib/clientTrace.js';

const SEVERITY_TEXT = { high: 'High', medium: 'Medium', low: 'Low' };
const ROW_STEP = 300;
const FINDINGS_SHOWN = 3;
const SCRIPT_KINDS = new Set(['field', 'message', 'form', 'ajax', 'glide', 'modal', 'error', 'console', 'log', 'network']);
const EMPTY = { state: null, events: [], version: 0 };

const LINKABLE = new Set(['sys_script_client', 'catalog_script_client', 'sys_ui_policy', 'catalog_ui_policy', 'sys_ui_action', 'sys_ui_script']);

/** The record's own form on this instance: only a known table and a validated sys_id go into the address. */
function recordHref(record) {
  if (!record || !LINKABLE.has(record.table) || !/^[0-9a-f]{32}$/.test(String(record.sysId || ''))) return '';
  return `/${record.table}.do?sys_id=${record.sysId}`;
}

function Who({ who }) {
  if (!who) return null;
  const href = who.known ? recordHref(who.record) : '';
  return (
    <div className={`msb-ct__by${who.known ? '' : ' msb-ct__by--unknown'}`}>
      <span className="msb-ct__by-label" title={who.known && who.detail && !who.engine ? who.detail : undefined}>
        {who.known ? who.label : 'Unknown script'}
      </span>
      {href && (
        <>
          {' '}
          <a className="msb-panel__link" href={href} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        </>
      )}
      {who.known && who.detail && who.engine && <span className="msb-ct__where"> {who.detail}</span>}
      {!who.known && <span className="msb-ct__where"> nearest frame: {who.where}</span>}
    </div>
  );
}

const ALWAYS_TIMED = new Set(['ajax', 'glide', 'network', 'longtask']);

/** What of the state the panel shows (not lastSeen, which changes on every poll and would re-render every row). */
function stateKey(s) {
  if (!s) return '';
  const frames = (s.frames || []).map((f) => [f.rid, f.frame, f.armed, f.missing, f.count]);
  return JSON.stringify([s.armed, s.minutesLeft, s.recorder, s.recorderArmed, s.host, s.page, frames]);
}

// Memoized: the panel runs in the page it is recording, so re-rendering hundreds of unchanged rows every second would
// itself show up as busy time in the trace.
const Row = React.memo(function Row({ row, who, focus, showFrame }) {
  const d = describeRow(row);
  if (row.kind === 'page') {
    return (
      <li className="msb-ct__row msb-ct__row--page" data-key={row.key} data-depth="0">
        <span className="msb-ct__time">+{fmtMs(row.t)}</span>
        <span className="msb-ct__page">
          {d.title}
          {d.detail && row.name === 'page load started' ? ` ${d.detail}` : ''}
          {showFrame && <span className="msb-ct__tag">{row.frame}</span>}
        </span>
      </li>
    );
  }
  const kind = KINDS[row.kind]?.label || row.kind;
  const failed = isError(row) || Boolean(row.flags?.failed);
  const slow = (row.durationMs ?? 0) >= SLOW_AJAX_MS;
  const level = failed ? ' msb-ct__row--error' : row.flags?.unknownField || slow || row.flags?.blocking ? ' msb-ct__row--warn' : '';
  const depth = Math.min(row.depth || 0, 3);
  return (
    <li className={`msb-ct__row${level}${focus ? ' msb-ct__row--focus' : ''}`} data-key={row.key} data-depth={depth}>
      <span className="msb-ct__time" title="Milliseconds since this frame started loading">
        +{fmtMs(row.t)}
      </span>
      <div className="msb-ct__main">
        <div className="msb-ct__head">
          <span className="msb-ct__kind">{kind}</span>
          <strong className="msb-ct__title">{d.title}</strong>
          {row.flags?.unknownField && <span className="msb-ct__tag msb-ct__tag--warn">not on the form</span>}
          {row.flags?.blocking && <span className="msb-ct__tag msb-ct__tag--warn">blocks the browser</span>}
          {row.flags?.failed && <span className="msb-ct__tag msb-ct__tag--danger">failed</span>}
          {row.flags?.threw && <span className="msb-ct__tag msb-ct__tag--danger">threw</span>}
          {row.pending && <span className="msb-ct__tag">no answer yet</span>}
          {row.durationMs !== undefined && (row.durationMs >= 20 || ALWAYS_TIMED.has(row.kind)) && <span className={`msb-ct__tag${slow ? ' msb-ct__tag--warn' : ''}`}>{fmtMs(row.durationMs)}</span>}
          {showFrame && <span className="msb-ct__tag">{row.frame}</span>}
        </div>
        {d.detail && <div className="msb-ct__detail">{d.detail}</div>}
        <Who who={who} />
        {row.stack?.length > 0 && (
          <details className="msb-ct__more">
            <summary>Call stack</summary>
            <ol className="msb-ct__stack" aria-label="Call stack, nearest first">
              {row.stack.map((f, i) => (
                <li key={i}>{frameText(f)}</li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </li>
  );
});

function Story({ story, onShow }) {
  const warn = story.steps.some((s) => s.unknownField);
  return (
    <li className={`msb-ct__story${warn ? ' msb-ct__story--warn' : ''}`}>
      <div className="msb-ct__story-head">
        <strong>{story.field}</strong>
        <span className="msb-ct__muted">
          {story.steps.length} step{story.steps.length === 1 ? '' : 's'}
          {story.scripts > 1 ? `, ${story.scripts} different scripts changed its value` : ''}
        </span>
        <button type="button" className="msb-panel__link" onClick={() => onShow(story.field)}>
          Show in timeline
        </button>
      </div>
      <ol className="msb-ct__steps">
        {story.steps.map((step) => (
          <li key={step.rowKey} className={step.unknownField ? 'msb-ct__step msb-ct__step--warn' : 'msb-ct__step'}>
            <span className="msb-ct__time">+{fmtMs(step.t)}</span>
            <span>
              {step.text}
              <span className={`msb-ct__by-inline${step.known ? '' : ' msb-ct__by-inline--unknown'}`} title={step.known ? '' : `Nearest frame: ${step.where}`}>
                {' '}
                by {step.known ? step.by : 'an unknown script'}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </li>
  );
}

/**
 * Client trace (/watch): a flight recorder for the browser side of a form. Arm it, reload, use the form, read what the
 * page's scripts did: every g_form change, GlideAjax and GlideRecord call, request, error and long freeze, in order,
 * with the script behind each one when the instance can name it.
 */
export default function ClientTracePanel({ services, params, onClose }) {
  const [data, setData] = useState(EMPTY);
  const [resolved, setResolved] = useState({ ids: {}, names: {}, classes: {}, notes: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState('timeline');
  const [scope, setScope] = useState('current');
  // The X-ray field button opens this panel with the field name in params.args: start filtered to it.
  const [field, setField] = useState(() => (/^[A-Za-z0-9_.]{1,80}$/.test(String(params?.args || '').trim()) ? String(params.args).trim() : ''));
  const [kind, setKind] = useState('all');
  const [frame, setFrame] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [slowOnly, setSlowOnly] = useState(false);
  const [focus, setFocus] = useState(null);
  const [limit, setLimit] = useState(ROW_STEP);
  const [allFindings, setAllFindings] = useState(false);
  const [showJslog, setShowJslog] = useState(false);
  const [retry, setRetry] = useState(0);
  const alive = useRef(true);
  const armedRef = useRef(false);
  const asked = useRef(new Set());
  const retries = useRef(0);
  const listRef = useRef(null);

  const flash = (text) => {
    setNotice(text);
    setTimeout(() => alive.current && setNotice(''), 3500);
  };

  const load = useCallback(async () => {
    try {
      const next = await services.clientTraceLoad();
      if (!alive.current) return;
      armedRef.current = Boolean(next.state?.armed);
      // Same version: only the state line may have changed, and usually nothing has (then nothing re-renders).
      setData((prev) => {
        if (prev.version !== next.version || prev.events !== next.events) return next;
        return stateKey(prev.state) === stateKey(next.state) ? prev : { ...prev, state: next.state };
      });
      setReadError('');
    } catch (err) {
      if (alive.current) setReadError(err.message || 'Could not read the recorder.');
    }
  }, [services]);

  // Live updating: every second while recording, every few seconds otherwise (to notice an arm from elsewhere).
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    // `stopped` belongs to this run of the effect: a tick still awaiting load() when the effect re-runs must not start a
    // second polling loop next to the new one.
    let stopped = false;
    let timer;
    const tick = async () => {
      if (!document.hidden) await load();
      if (!stopped) timer = setTimeout(tick, armedRef.current ? 1000 : 4000);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load]);

  const allRows = useMemo(() => buildRows(data.events), [data.events]);
  const scoped = useMemo(() => selectDocuments(allRows, scope), [allRows, scope]);
  const docs = useMemo(() => documentsOf(allRows), [allRows]);
  const frameNames = useMemo(() => new Set(scoped.map((r) => r.frame)), [scoped]);
  const frameList = useMemo(() => framesOf(scoped), [scoped]);

  // Which scripts were those? Ask the instance once per new id / class / page function / page load (for what is shown:
  // the lookups are capped per call, so asking for every old page load could crowd out the current one). What the
  // content script could not decide yet (query budget used up, frame not readable) is asked again a few times.
  useEffect(() => {
    const refs = collectRefs(scoped);
    const fresh = {
      ids: refs.ids.filter((id) => !asked.current.has(`i:${id}`)),
      names: refs.names.filter((n) => !asked.current.has(`n:${n}`)),
      classes: refs.classes.filter((c) => !asked.current.has(`c:${c}`)),
      functions: refs.functions.filter((f) => !asked.current.has(`f:${f.rid}|${f.fn}`)),
      pages: refs.pages.filter((p) => !asked.current.has(`p:${p.rid}`)),
    };
    if (!fresh.ids.length && !fresh.names.length && !fresh.classes.length && !fresh.functions.length && !fresh.pages.length) return;
    fresh.ids.forEach((id) => asked.current.add(`i:${id}`));
    fresh.names.forEach((n) => asked.current.add(`n:${n}`));
    fresh.classes.forEach((c) => asked.current.add(`c:${c}`));
    fresh.functions.forEach((f) => asked.current.add(`f:${f.rid}|${f.fn}`));
    fresh.pages.forEach((p) => asked.current.add(`p:${p.rid}`));
    services
      .clientTraceResolve(fresh)
      .then((out) => {
        if (!alive.current) return;
        setResolved(out);
        const later = [...(out?.pending?.functions || []).map((k) => `f:${k}`), ...(out?.pending?.pages || []).map((r) => `p:${r}`)];
        if (later.length && retries.current < 5) {
          later.forEach((k) => asked.current.delete(k));
          retries.current += 1;
          setTimeout(() => alive.current && setRetry((n) => n + 1), 3000);
        }
      })
      .catch((err) => alive.current && setResolved((prev) => ({ ...prev, notes: [...prev.notes, `Could not look up script names: ${err.message}`] })));
  }, [scoped, services, retry]);

  const whoByKey = useMemo(() => {
    const map = new Map();
    scoped.forEach((row) => {
      if (SCRIPT_KINDS.has(row.kind)) map.set(row.key, attribute(row, resolved));
    });
    return map;
  }, [scoped, resolved]);

  const fields = useMemo(() => fieldsOf(scoped), [scoped]);
  const filtered = useMemo(() => filterRows(scoped, { field, kind, errorsOnly, slowOnly, frame, hideJslog: !showJslog }), [scoped, field, kind, errorsOnly, slowOnly, frame, showJslog]);
  const jslogCount = useMemo(() => scoped.filter(isJslog).length, [scoped]);
  // Hidden by the jslog switch alone (not also by another filter), so the count line stays exact.
  const jslogHidden = useMemo(() => (showJslog ? 0 : filterRows(scoped, { field, kind, errorsOnly, slowOnly, frame }).filter(isJslog).length), [scoped, field, kind, errorsOnly, slowOnly, frame, showJslog]);
  const findings = useMemo(() => findFindings(scoped, resolved), [scoped, resolved]);
  const allStories = useMemo(() => buildStories(scoped, resolved), [scoped, resolved]);
  const stories = useMemo(() => allStories.filter((s) => !field || s.field === field), [allStories, field]);
  const focusKeys = useMemo(() => (focus ? new Set(focus.keys) : null), [focus]);
  const filtersOn = Boolean(field || frame || kind !== 'all' || errorsOnly || slowOnly);

  useEffect(() => {
    if (!focus || !listRef.current) return;
    const first = listRef.current.querySelector('[data-focus-first="1"], .msb-ct__row--focus');
    first?.scrollIntoView?.({ block: 'center' });
  }, [focus, view]);

  const state = data.state;
  const armed = Boolean(state?.armed);
  const missing = state?.recorder === 'missing';
  const noRecorderFrames = (state?.frames || []).filter((f) => f.missing);

  async function run(task) {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (err) {
      if (alive.current) setError(err.message || 'That did not work.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const reset = () => {
    setFocus(null);
    setField('');
    setFrame('');
    setKind('all');
    setErrorsOnly(false);
    setSlowOnly(false);
    setLimit(ROW_STEP);
  };

  const armAndReload = () =>
    run(async () => {
      reset();
      const next = await services.clientTraceArm({ reload: true });
      flash(next.reloading ? 'Reloading the page. The recorder starts with it.' : 'Armed.');
    });
  const armNow = () =>
    run(async () => {
      reset();
      await services.clientTraceArm({ reload: false });
      await load();
      flash('Recording from now. The page load itself is not included; use Reload and record for that.');
    });
  const disarm = () =>
    run(async () => {
      await services.clientTraceDisarm();
      await load();
      flash('Stopped. The recording is kept until you clear it.');
    });
  const clear = () =>
    run(async () => {
      await services.clientTraceClear();
      asked.current = new Set();
      retries.current = 0;
      reset();
      await load();
    });

  const showFinding = (finding) => {
    setView('timeline');
    setField('');
    setFrame('');
    setKind('all');
    setErrorsOnly(false);
    setSlowOnly(false);
    setScope('all');
    setLimit(Math.max(limit, scoped.length));
    setFocus({ keys: finding.rowKeys, title: finding.title });
  };

  const showField = (name) => {
    setView('timeline');
    setField(name);
    setFocus(null);
  };

  async function copyMarkdown() {
    try {
      const text = toMarkdown({
        rows: filtered,
        findings,
        stories,
        resolved,
        meta: { host: state?.host, page: docs.filter((d) => d.href).pop()?.href || state?.page, recordedAt: scoped[0]?.at, scope, hiddenLogs: jslogHidden },
      });
      await navigator.clipboard.writeText(text);
      flash('Copied as Markdown, ready to paste into a ticket.');
    } catch (err) {
      setError(err.message || 'Could not copy.');
    }
  }

  function exportJson() {
    try {
      const payload = { exportedAt: new Date().toISOString(), host: state?.host, scope, events: data.events };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `client-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      flash('Saved the events as a JSON file.');
    } catch (err) {
      setError(err.message || 'Could not save the file.');
    }
  }

  const hasEvents = data.events.length > 0;
  const shownRows = filtered.slice(0, limit);
  const topFindings = allFindings ? findings : findings.slice(0, FINDINGS_SHOWN);

  let stateLine;
  let stateTone = '';
  if (!state) stateLine = 'Reading the recorder…';
  else if (armed && missing) {
    stateLine = 'Armed, but the recorder is not loaded in this page. It loads when a page starts: reload once.';
    stateTone = ' msb-ct__state--warn';
  } else if (armed) {
    stateLine = `Recording. ${allRows.length} event${allRows.length === 1 ? '' : 's'}${frameNames.size > 1 ? ` from ${frameNames.size} frames` : ''}. Stops by itself in ${state.minutesLeft} min.`;
    stateTone = ' msb-ct__state--on';
  } else if (hasEvents) stateLine = `Stopped. ${allRows.length} event${allRows.length === 1 ? '' : 's'} kept.`;
  else if (missing) {
    stateLine = 'Not recording. The recorder is not loaded in this page yet: reload the page once after installing or updating NowBuddy.';
    stateTone = ' msb-ct__state--warn';
  } else stateLine = 'Not recording.';

  return (
    <div className="msb-panel msb-ct">
      <div className="msb-panel__header">
        <strong>Client trace</strong>
        <span className="msb-ct__sub">what the page's scripts did</span>
        <button type="button" onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className={`msb-ct__state${stateTone}`} role="status">
        <Icon name="record" size={14} />
        <span>{stateLine}</span>
      </div>
      {armed && noRecorderFrames.length > 0 && (
        <div className="msb-panel__warning" role="status">
          No recorder answered in: {noRecorderFrames.map((f) => f.frame).join(', ')}. Reload the page so it loads from the first moment.
        </div>
      )}

      <div className="msb-panel__actions">
        {(!armed || missing) && (
          <button type="button" className="msb-panel__run" onClick={armAndReload} disabled={busy}>
            Reload and record
          </button>
        )}
        {!armed && (
          <button type="button" className="msb-panel__secondary" onClick={armNow} disabled={busy}>
            Record from now
          </button>
        )}
        {armed && (
          <button type="button" className={missing ? 'msb-panel__secondary' : 'msb-panel__run'} onClick={disarm} disabled={busy}>
            Stop recording
          </button>
        )}
        {armed && !missing && (
          <button type="button" className="msb-panel__secondary" onClick={armAndReload} disabled={busy}>
            Reload and record again
          </button>
        )}
        {hasEvents && (
          <button type="button" className="msb-panel__secondary" onClick={clear} disabled={busy}>
            Clear
          </button>
        )}
      </div>

      {(error || readError) && <div className="msb-panel__error">{error || readError}</div>}
      {notice && (
        <div className="msb-panel__hint" role="status">
          {notice}
        </div>
      )}

      {!hasEvents && !armed && (
        <div className="msb-ct__empty">
          <p className="msb-ct__lead">Find out who changed a field, why a form is slow, and which call failed, without guessing.</p>
          <ol className="msb-ct__steps-help">
            <li>
              <strong>Press Reload and record.</strong> NowBuddy arms the recorder and reloads the page, so it sees the onLoad scripts from the first moment.
            </li>
            <li>
              <strong>Use the form.</strong> Change a field, press Save, open a dialog: whatever you want to understand.
            </li>
            <li>
              <strong>Read the timeline here.</strong> Every field change, GlideAjax and GlideRecord call, request and error, in order, with the script behind it.
            </li>
          </ol>
          <p className="msb-panel__hint">
            The recorder only watches: it never changes the form. Password fields and values named like a secret are never stored. It stops by itself after 30 minutes. Record from now skips the reload, so
            the page load is not included.
          </p>
        </div>
      )}

      {!hasEvents && armed && !missing && <div className="msb-panel__empty">Waiting for activity. Change a field, save the form or open a dialog.</div>}

      {hasEvents && (
        <>
          {findings.length > 0 ? (
            <section className="msb-ct__section" aria-label="What stands out">
              <h3 className="msb-ct__h">What stands out</h3>
              <ul className="msb-ct__findings">
                {topFindings.map((f) => (
                  <li key={f.id} className={`msb-ct__finding msb-ct__finding--${f.severity}`}>
                    <div className="msb-ct__finding-head">
                      <span className={`msb-ct__sev msb-ct__sev--${f.severity}`}>{SEVERITY_TEXT[f.severity]}</span>
                      <strong>{f.title}</strong>
                    </div>
                    <div className="msb-ct__detail">
                      {f.detail}
                      {f.detail ? ' ' : ''}
                      <button type="button" className="msb-panel__link" onClick={() => showFinding(f)}>
                        Show in timeline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {findings.length > FINDINGS_SHOWN && (
                <button type="button" className="msb-panel__link" onClick={() => setAllFindings(!allFindings)}>
                  {allFindings ? 'Show fewer' : `Show all ${findings.length}`}
                </button>
              )}
            </section>
          ) : (
            <div className="msb-panel__hint msb-ct__quiet">Nothing stands out so far: no errors, slow or blocking calls, repeats or calls on missing fields.</div>
          )}

          <div className="msb-ct__bar">
            <div className="msb-ct__views" role="group" aria-label="View">
              <button type="button" className="msb-ct__view" aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>
                Timeline
              </button>
              <button type="button" className="msb-ct__view" aria-pressed={view === 'fields'} onClick={() => setView('fields')}>
                Fields ({allStories.length})
              </button>
            </div>
            <div className="msb-panel__actions msb-ct__export">
              <button type="button" className="msb-panel__secondary" onClick={copyMarkdown}>
                Copy as Markdown
              </button>
              <button type="button" className="msb-panel__secondary" onClick={exportJson}>
                Export JSON
              </button>
            </div>
          </div>

          <div className="msb-panel__form msb-ct__filters">
            <div className="msb-ct__filter-row">
              <label>
                Field
                <select value={field} onChange={(e) => { setField(e.target.value); setFocus(null); }}>
                  <option value="">All fields</option>
                  {(field && !fields.includes(field) ? [field, ...fields] : fields).map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              {view === 'timeline' && (
                <label>
                  Kind
                  <select value={kind} onChange={(e) => { setKind(e.target.value); setFocus(null); }}>
                    {KIND_FILTERS.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {view === 'timeline' && frameList.length > 1 && (
              <div className="msb-ct__filter-row">
                <label>
                  Frame
                  <select value={frame} onChange={(e) => { setFrame(e.target.value); setFocus(null); }}>
                    <option value="">All frames</option>
                    {frameList.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <div className="msb-panel__checks">
              {view === 'timeline' && (
                <>
                  <label className="msb-panel__check">
                    <input type="checkbox" checked={errorsOnly} onChange={(e) => { setErrorsOnly(e.target.checked); setFocus(null); }} />
                    Errors only
                  </label>
                  <label className="msb-panel__check">
                    <input type="checkbox" checked={slowOnly} onChange={(e) => { setSlowOnly(e.target.checked); setFocus(null); }} />
                    Slow only ({SLOW_AJAX_MS} ms+)
                  </label>
                  {jslogCount > 0 && (
                    <label className="msb-panel__check" title="jslog() lines, mostly the platform's own debug output. Export JSON always has them.">
                      <input type="checkbox" checked={showJslog} onChange={(e) => setShowJslog(e.target.checked)} />
                      Platform debug log (jslog) ({jslogCount})
                    </label>
                  )}
                </>
              )}
              {docs.length > 1 && (
                <label className="msb-panel__check">
                  <input type="checkbox" checked={scope === 'all'} onChange={(e) => setScope(e.target.checked ? 'all' : 'current')} />
                  Every page load ({docs.length})
                </label>
              )}
            </div>
          </div>

          <div className="msb-panel__counts" role="status">
            {view === 'timeline' ? `${filtered.length} of ${scoped.length} event${scoped.length === 1 ? '' : 's'}` : `${stories.length} field${stories.length === 1 ? '' : 's'}`}
            {scope === 'current' && docs.length > 1 ? ' (latest page load of each frame)' : ''}
            {view === 'timeline' && jslogHidden > 0 ? `, ${jslogHidden} platform debug log line${jslogHidden === 1 ? '' : 's'} hidden` : ''}
            {filtersOn && view === 'timeline' && (
              <>
                {' '}
                <button type="button" className="msb-panel__link" onClick={reset}>
                  Clear filters
                </button>
              </>
            )}
            {focus && view === 'timeline' && (
              <>
                {' '}
                <button type="button" className="msb-panel__link" onClick={() => setFocus(null)}>
                  Stop highlighting
                </button>
              </>
            )}
          </div>

          {view === 'timeline' && (
            <>
              {filtered.length === 0 ? (
                <div className="msb-panel__empty">
                  {jslogHidden > 0 ? `Only platform debug log lines here (${jslogHidden}). Tick "Platform debug log (jslog)" to see them.` : filtersOn ? 'Nothing matches these filters.' : 'Nothing recorded yet.'}
                </div>
              ) : (
                <ol className="msb-ct__list" ref={listRef} aria-label="Timeline">
                  {shownRows.map((row) => (
                    <Row key={row.key} row={row} who={whoByKey.get(row.key)} focus={focusKeys ? focusKeys.has(row.key) : false} showFrame={frameNames.size > 1} />
                  ))}
                </ol>
              )}
              {filtered.length > shownRows.length && (
                <button type="button" className="msb-panel__secondary" onClick={() => setLimit(limit + ROW_STEP)}>
                  Show {Math.min(ROW_STEP, filtered.length - shownRows.length)} more of {filtered.length - shownRows.length}
                </button>
              )}
            </>
          )}

          {view === 'fields' &&
            (stories.length === 0 ? (
              <div className="msb-panel__empty">No g_form calls on a field were recorded.</div>
            ) : (
              <ul className="msb-ct__stories" ref={listRef} aria-label="What happened to each field">
                {stories.map((story) => (
                  <Story key={story.key} story={story} onShow={showField} />
                ))}
              </ul>
            ))}

          {hasEvents && (
            <details className="msb-ct__sources">
              <summary className="msb-panel__result-toggle">About the script names</summary>
              <div className="msb-panel__hint">
                A classic form inlines its client scripts as functions such as onLoad_&lt;id&gt; whose id is not a record&apos;s sys_id. So a script is named in one of these ways, and only then:
              </div>
              <ul className="msb-panel__hint msb-ct__about">
                <li>its sys_id or UI script file name in the call stack matches a record on this instance;</li>
                <li>
                  <strong>matched by its source text</strong>: a line of that function, read from this page, is searched for in active client scripts of this table and its parents, and exactly one script holds
                  it and most of the function&apos;s other lines;
                </li>
                <li>
                  <strong>UI policy</strong>: the call came from the UI policy engine (ui_policy.jsx), and this page&apos;s UI policies are checked for an action on that field with that effect. One match is named; several
                  are listed as &quot;one of&quot;, because the stack does not say which ran.
                </li>
              </ul>
              <div className="msb-panel__hint">Otherwise it says Unknown script and shows the nearest stack frame. Nothing is guessed.</div>
              {resolved.notes?.map((n) => (
                <div key={n} className="msb-panel__warning">
                  {n}
                </div>
              ))}
            </details>
          )}
        </>
      )}
    </div>
  );
}
