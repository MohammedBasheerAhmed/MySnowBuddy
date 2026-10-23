import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  WINDOWS,
  DEFAULT_WINDOW,
  SOURCES,
  filterBySource,
  groupFailures,
  countsBySource,
  countLabel,
  relativeAge,
  recordPath,
  sourceLabel,
  buildFailurePrompt,
  failuresToMarkdown,
} from '../lib/failures.js';
import { failureLinks } from '../lib/panelLinks.js';
import { redactSecrets } from '../providers/redact.js';
import { downloadText, suggestFilename } from '../lib/report.js';

const SORTS = [
  { key: 'recent', label: 'Newest first' },
  { key: 'count', label: 'Most frequent first' },
];
const MAX_ASK_ALL = 8;
const SEVERITY_TEXT = { error: 'Error', warn: 'Warning' };

function copy(text) {
  return navigator.clipboard?.writeText(text).catch(() => {});
}

function Group({ group, onAsk, onCopied, onOpenPanel }) {
  const href = recordPath(group.target);
  const recent = group.items.slice(0, 5);
  // The tool that explains this kind of failure, when the row names the record it was about.
  const links = onOpenPanel ? failureLinks(group) : [];
  return (
    <details className={`msb-fail__group msb-fail__group--${group.severity}`}>
      <summary className="msb-panel__result-toggle msb-fail__summary">
        <span className="msb-fail__sev">{SEVERITY_TEXT[group.severity] || 'Error'}</span>
        <span className="msb-fail__title">{group.title}</span>
        <span className="msb-panel__badge" title={`${group.count} occurrence${group.count === 1 ? '' : 's'}`}>
          {countLabel(group)}
        </span>
        <span className="msb-fail__meta">
          {sourceLabel(group.source)}
          {group.last ? ` · ${relativeAge(group.last) || group.last}` : ''}
        </span>
      </summary>
      <div className="msb-fail__body">
        {group.hint && <p className="msb-fail__hint">{group.hint}</p>}
        <dl className="msb-fail__times">
          <div>
            <dt>First</dt>
            <dd>{group.first || 'unknown'}</dd>
          </div>
          <div>
            <dt>Last</dt>
            <dd>{group.last || 'unknown'}</dd>
          </div>
          <div>
            <dt>Times are</dt>
            <dd>UTC</dd>
          </div>
        </dl>
        <pre className="msb-panel__snippet msb-fail__raw" tabIndex={0} aria-label="Raw message">
          {group.message}
        </pre>
        {group.count > 1 && (
          <ul className="msb-fail__list" aria-label="Most recent occurrences">
            {recent.map((item) => (
              <li key={item.id}>
                <span>{item.when}</span>
                {recordPath(item.target) && (
                  <a className="msb-panel__link" href={recordPath(item.target)} target="_blank" rel="noopener noreferrer">
                    open
                  </a>
                )}
              </li>
            ))}
            {group.count > recent.length && <li className="msb-fail__more">and {group.count - recent.length} more</li>}
          </ul>
        )}
        <div className="msb-panel__actions">
          {href && (
            <a className="msb-panel__secondary msb-fail__button" href={href} target="_blank" rel="noopener noreferrer">
              Open record
            </a>
          )}
          <button
            className="msb-panel__secondary"
            onClick={() => {
              copy(`${group.title} (${countLabel(group)})\n${group.message}`);
              onCopied('Copied');
            }}
          >
            Copy
          </button>
          {links.map((link) => (
            <button key={link.id} className="msb-panel__secondary" title={link.title} onClick={() => onOpenPanel(link)}>
              {link.label}
            </button>
          ))}
          {onAsk && (
            <button className="msb-panel__run" onClick={() => onAsk(group)}>
              Ask AI to explain
            </button>
          )}
        </div>
      </div>
    </details>
  );
}

/**
 * The places a failure leaves a trace that the system log does not show: failed email, flows, overdue jobs,
 * integration errors, import rows, events. Read-only.
 */
export default function FailuresPanel({ onClose, services, onAskAi }) {
  const [windowKey, setWindowKey] = useState(DEFAULT_WINDOW);
  const [sort, setSort] = useState('recent');
  const [source, setSource] = useState('all');
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const runId = useRef(0);

  async function load(nextWindow = windowKey) {
    runId.current += 1;
    const id = runId.current;
    setBusy(true);
    setError(null);
    try {
      const result = await services.failureReport({ window: nextWindow });
      if (id === runId.current) setReport(result);
    } catch (err) {
      if (id === runId.current) {
        setReport(null);
        setError(err.message);
      }
    } finally {
      if (id === runId.current) setBusy(false);
    }
  }

  useEffect(() => {
    load(DEFAULT_WINDOW);
    return () => {
      runId.current += 1;
    };
    // Loads once when the panel opens; the window buttons and Refresh load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flash(text) {
    setNotice(text);
    setTimeout(() => setNotice(null), 2500);
  }

  const counts = useMemo(() => (report ? countsBySource(report.items) : {}), [report]);
  const total = report ? report.items.length : 0;
  const groups = useMemo(() => (report ? groupFailures(filterBySource(report.items, source), { sort }) : []), [report, source, sort]);
  const unavailable = report ? report.sources.filter((s) => !s.available) : [];
  const truncated = report ? report.sources.filter((s) => s.truncated).map((s) => s.label) : [];
  const windowLabel = WINDOWS.find((w) => w.key === windowKey)?.label || windowKey;

  function pickWindow(key) {
    setWindowKey(key);
    load(key);
  }

  function askAbout(group) {
    onAskAi?.(`Why: ${group.title}`.slice(0, 80), redactSecrets(buildFailurePrompt(group, { instance: report?.instance })));
  }

  // Hands one failure to the tool that explains it, on the record the row names (not the record on screen).
  function openTool(link) {
    if (!services.openRegisteredPanel?.(link.panel, link.params)) flash('That tool is not available here.');
  }

  function askAboutAll() {
    const top = groupFailures(report.items, { sort: 'count' }).slice(0, MAX_ASK_ALL);
    const text = failuresToMarkdown(top, { windowKey, instance: report.instance, generatedAt: report.generatedAt });
    onAskAi?.(
      'What went wrong recently',
      redactSecrets(`These are the failures found on this ServiceNow instance. Which ones matter most, what is probably causing each, and what should I check first?\n\n${text}`)
    );
  }

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>What went wrong?</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className="msb-panel__hint">
        Failed email, flows, overdue jobs, integration errors, import rows and events: the places the system log does not show.
      </div>

      <div className="msb-fail__controls">
        <div className="msb-fail__segments" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button key={w.key} className="msb-panel__secondary" aria-pressed={windowKey === w.key} onClick={() => pickWindow(w.key)} disabled={busy && windowKey === w.key}>
              {w.label}
            </button>
          ))}
        </div>
        <button className="msb-panel__secondary" onClick={() => load()} disabled={busy}>
          {busy ? 'Reading...' : 'Refresh'}
        </button>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}
      {notice && <div className="msb-panel__hint">{notice}</div>}
      {busy && !report && <div className="msb-impact__busy">Reading six places in parallel...</div>}

      {report && (
        <>
          <div className="msb-fail__chips" role="group" aria-label="Filter by source">
            <button className="msb-fail__chip" aria-pressed={source === 'all'} onClick={() => setSource('all')}>
              All <span className="msb-panel__badge">{total}</span>
            </button>
            {SOURCES.map((s) => {
              const state = report.sources.find((r) => r.id === s.id);
              const off = state && !state.available;
              return (
                <button
                  key={s.id}
                  className="msb-fail__chip"
                  aria-pressed={source === s.id}
                  onClick={() => setSource(source === s.id ? 'all' : s.id)}
                  title={off ? state.note : s.hint}
                >
                  {s.label} <span className="msb-panel__badge">{off ? 'n/a' : counts[s.id] || 0}</span>
                </button>
              );
            })}
          </div>

          <div className="msb-fail__summary-line" role="status">
            {total === 0
              ? `Nothing found in ${windowLabel.toLowerCase()}${unavailable.length ? `, but ${unavailable.length} source${unavailable.length === 1 ? ' was' : 's were'} not readable` : ''}.`
              : `${groups.length} distinct problem${groups.length === 1 ? '' : 's'}, ${filterBySource(report.items, source).length} occurrence${filterBySource(report.items, source).length === 1 ? '' : 's'}, ${windowLabel.toLowerCase()}.`}
          </div>
          {truncated.length > 0 && <div className="msb-panel__hint">Showing the newest rows only for {truncated.join(', ')}; there may be more.</div>}

          {groups.length > 1 && (
            <label className="msb-fail__sort">
              Order
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="msb-fail__groups">
            {groups.map((group) => (
              <Group key={group.key} group={group} onAsk={onAskAi ? askAbout : null} onCopied={flash} onOpenPanel={services.openRegisteredPanel ? openTool : null} />
            ))}
          </div>

          {total > 0 && (
            <div className="msb-panel__actions">
              <button
                className="msb-panel__secondary"
                onClick={() => {
                  copy(failuresToMarkdown(groups, { windowKey, instance: report.instance, generatedAt: report.generatedAt }));
                  flash('Copied the report');
                }}
              >
                Copy report
              </button>
              <button
                className="msb-panel__secondary"
                onClick={() => downloadText(suggestFilename('failures'), failuresToMarkdown(groups, { windowKey, instance: report.instance, generatedAt: report.generatedAt }))}
              >
                Download .md
              </button>
              {onAskAi && (
                <button className="msb-panel__run" onClick={askAboutAll}>
                  Ask AI what matters
                </button>
              )}
            </div>
          )}

          {unavailable.length > 0 && (
            <details className="msb-fail__notes">
              <summary className="msb-panel__result-toggle">Not checked ({unavailable.length})</summary>
              <ul>
                {unavailable.map((s) => (
                  <li key={s.id}>
                    <strong>{s.label}:</strong> {s.note}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {report.sources.some((s) => s.sourceNote) && (
            <div className="msb-panel__hint">{report.sources.filter((s) => s.sourceNote).map((s) => `${s.label}: ${s.sourceNote}`).join(' ')}</div>
          )}
        </>
      )}
    </div>
  );
}
