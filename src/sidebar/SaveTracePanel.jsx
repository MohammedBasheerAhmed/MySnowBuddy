import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { KINDS, groupTimeline, onlyProblems, offsetLabel, traceToText } from '../lib/saveTrace.js';

const SYS_ID = /^[0-9a-f]{32}$/i;
const LEVEL_TEXT = { error: 'Error', warn: 'Warning' };
const STATUS_TEXT = {
  ok: 'collected',
  empty: 'nothing in the window',
  skipped: 'skipped',
  unavailable: 'not available on this instance',
  noaccess: 'your user cannot read it',
  error: 'failed',
};

function recordHref(link) {
  return link && /^[a-z][a-z0-9_]*$/.test(link.table) && SYS_ID.test(link.sysId) ? `/${link.table}.do?sys_id=${link.sysId}` : '';
}

function EventRow({ event, base }) {
  const kind = KINDS[event.kind] || { label: event.kind, icon: 'log' };
  const href = recordHref(event.link);
  return (
    <li className={`msb-trace__event msb-trace__event--${event.level}`}>
      <span className="msb-trace__icon" aria-hidden="true">
        <Icon name={kind.icon} size={14} />
      </span>
      <div className="msb-trace__body">
        <div className="msb-trace__head">
          <span className="msb-trace__muted msb-trace__at" title="Time since the first event">
            {offsetLabel(event.t - base)}
          </span>
          <span className="msb-trace__kind">{kind.label}</span>
          {LEVEL_TEXT[event.level] && <span className={`msb-trace__level msb-trace__level--${event.level}`}>{LEVEL_TEXT[event.level]}</span>}
          <strong className="msb-trace__title">{event.title}</strong>
          {event.durationMs != null && <span className="msb-trace__muted">{event.durationMs} ms</span>}
          {href && (
            <a className="msb-panel__link msb-trace__open" href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${event.title}`}>
              Open
            </a>
          )}
        </div>
        {event.detail && <div className="msb-trace__detail">{event.detail}</div>}
      </div>
    </li>
  );
}

/**
 * "What happened when I saved?": arm, save, collect. One timeline of what the platform did in response.
 * `/savetrace arm` (or the palette's "Trace the next save") arms straight away.
 */
export default function SaveTracePanel({ context, params, services, onClose }) {
  const [armed, setArmed] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [notice, setNotice] = useState(null);
  const alive = useRef(true);

  const flash = (text) => {
    setNotice(text);
    setTimeout(() => alive.current && setNotice(null), 3000);
  };

  async function run(task) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      if (alive.current) setError(err.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const arm = () =>
    run(async () => {
      const state = await services.saveTraceArm({ table: context?.table, sysId: context?.sysId });
      setResult(null);
      setArmed(state);
    });

  const collect = () =>
    run(async () => {
      const data = await services.saveTraceCollect({ table: context?.table, sysId: context?.sysId });
      setResult(data);
      setArmed(data.armed);
    });

  const disarm = () =>
    run(async () => {
      await services.saveTraceDisarm();
      setArmed(null);
      setResult(null);
    });

  useEffect(() => {
    alive.current = true;
    (async () => {
      const state = await services.saveTraceState().catch(() => null);
      if (!alive.current) return;
      if (!state && String(params?.args || '').trim() === 'arm') {
        arm();
        return;
      }
      setArmed(state);
      // The page reloaded after Arm: that is the save. Collect without another click.
      if (state?.reloadedSinceArm) collect();
    })();
    return () => {
      alive.current = false;
    };
    // Once per panel instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trace = result?.trace;
  const groups = useMemo(() => {
    if (!trace) return [];
    const shown = problemsOnly ? onlyProblems(trace.events) : trace.events;
    const base = trace.events.length ? trace.events[0].t : 0;
    return groupTimeline(shown).map((g) => ({ ...g, offsetMs: g.startT - base }));
  }, [trace, problemsOnly]);

  async function copyText() {
    try {
      await navigator.clipboard.writeText(traceToText({ trace, record: result.record, user: result.user, problemsOnly }));
      flash('Copied the timeline as text.');
    } catch (err) {
      setError(err.message || 'Could not copy.');
    }
  }

  const tableName = armed?.table || context?.table || 'the record';

  return (
    <div className="msb-panel msb-trace">
      <div className="msb-panel__header">
        <strong>Save trace</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      {!armed && (
        <div className="msb-panel__form">
          <div className="msb-panel__hint">
            Arm it, save the record, then collect: everything the save caused, in order. Field changes, log lines, the transaction, update set
            entries, events, emails, flows, notes, SLAs, approvals and new records.
          </div>
          <div className="msb-panel__actions">
            <button className="msb-panel__run" onClick={arm} disabled={busy}>
              Trace the next save
            </button>
          </div>
        </div>
      )}

      {armed && !result && (
        <div className="msb-panel__form">
          <div className="msb-trace__armed" role="status">
            <strong>Armed</strong> on {armed.table || 'this page'} as {armed.user?.userName || 'the session user'}, {armed.ageSeconds}s ago.
            {armed.clock === 'local' ? ' The instance clock could not be read, so this computer’s clock is used.' : ''}
          </div>
          <div className="msb-panel__hint">
            Save {tableName} now{armed.reloadedSinceArm ? ' (the page has reloaded since you armed it)' : ''}, then press Collect.
          </div>
          <div className="msb-panel__actions">
            <button className="msb-panel__run" onClick={collect} disabled={busy}>
              {busy ? 'Collecting…' : 'Collect'}
            </button>
            <button className="msb-panel__secondary" onClick={disarm} disabled={busy}>
              Disarm
            </button>
          </div>
        </div>
      )}

      {error && <div className="msb-panel__error">{error}</div>}
      {notice && <div className="msb-panel__hint">{notice}</div>}

      {trace && (
        <>
          <div className={`msb-trace__summary${trace.summary.errors ? ' msb-trace__summary--error' : trace.summary.warnings ? ' msb-trace__summary--warn' : ''}`} role="status">
            <strong>{trace.summary.headline}</strong>
            <div className="msb-trace__muted">
              {result.record.table || 'record'} · {result.user || 'unknown user'} · window {trace.summary.window}
              {result.window.truncated ? ' (cut to the last 15 minutes)' : ''}
            </div>
          </div>

          <div className="msb-panel__actions">
            <label className="msb-trace__toggle">
              <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} />
              Show only problems
            </label>
            <button className="msb-panel__secondary" onClick={copyText}>
              Copy as text
            </button>
            <button className="msb-panel__secondary" onClick={collect} disabled={busy}>
              Collect again
            </button>
            <button className="msb-panel__secondary" onClick={disarm} disabled={busy}>
              Done
            </button>
          </div>

          {groups.length === 0 && (
            <div className="msb-panel__empty">
              {problemsOnly ? 'No warnings or errors in this save.' : 'Nothing was recorded in the window. Did the save finish before you collected?'}
            </div>
          )}

          {groups.map((group) => (
            <section key={group.startT} className="msb-trace__group" aria-label={`${offsetLabel(group.offsetMs)} after the first event`}>
              <div className="msb-trace__offset">{offsetLabel(group.offsetMs)}</div>
              <ul className="msb-trace__list">
                {group.events.map((event) => (
                  <EventRow key={event.id} event={event} base={trace.events[0].t} />
                ))}
              </ul>
            </section>
          ))}

          <details className="msb-trace__sources">
            <summary className="msb-panel__result-toggle">
              Where it looked
              {trace.summary.unavailable + trace.summary.blocked > 0 && (
                <span className="msb-panel__badge">{trace.summary.unavailable + trace.summary.blocked} not collected</span>
              )}
            </summary>
            <ul className="msb-trace__source-list">
              {trace.sources.map((source) => (
                <li key={source.id} className={`msb-trace__source msb-trace__source--${source.status}`}>
                  <span>{source.label}</span>
                  <span className="msb-trace__muted">
                    {source.status === 'ok' ? `${source.count} found` : STATUS_TEXT[source.status] || source.status}
                    {source.note && source.status !== 'unavailable' && source.status !== 'noaccess' ? ` · ${source.note}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
