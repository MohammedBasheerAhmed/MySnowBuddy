import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SYS_ID_RE, TABLE_RE, exactTime, relativeTime, processMarkdown } from '../lib/processView.js';
import { copyText } from '../content/quickActions.js';
import { redactSecrets } from '../providers/redact.js';

const errorText = (err) => err?.message || String(err);
const INITIAL_ROWS = 8;

const LEVEL = {
  blocked: { label: 'Waiting', tone: 'warn' },
  running: { label: 'Running', tone: 'info' },
  clear: { label: 'All clear', tone: 'ok' },
  partial: { label: 'Incomplete', tone: 'warn' },
  unknown: { label: 'Unknown', tone: 'muted' },
};
const SEVERITY_TONE = { error: 'danger', warn: 'warn', info: 'info' };

/** A relative time that shows the exact stamp (UTC) on hover and to screen readers. */
function When({ label, when, now }) {
  const rel = relativeTime(when, now);
  const exact = exactTime(when);
  return (
    <span className="msb-proc__when" title={exact} aria-label={`${label} ${rel}, ${exact}`}>
      {label} {rel}
    </span>
  );
}

function Badge({ tone, children }) {
  return <span className={`msb-proc__badge msb-proc__badge--${tone}`}>{children}</span>;
}

function Row({ row, now }) {
  const stripe = row.badge.tone === 'danger' || row.badge.tone === 'warn' ? ` msb-proc__row--${row.badge.tone}` : '';
  const linesLabel = row.kind === 'flow' ? 'Log' : 'History';
  return (
    <li className={`msb-proc__row${stripe}`}>
      <div className="msb-proc__head">
        <Badge tone={row.badge.tone}>{row.badge.text}</Badge>
        {row.href ? (
          <a className="msb-panel__link msb-proc__title" href={row.href} target="_blank" rel="noopener noreferrer" title="Open the record">
            {row.title}
          </a>
        ) : (
          <span className="msb-proc__title">{row.title}</span>
        )}
      </div>
      {row.headline && <div className="msb-proc__headline">{row.headline}</div>}
      {row.error && (
        <div className="msb-proc__error" role="note">
          <span className="msb-proc__error-label">Error</span> {row.error}
        </div>
      )}
      {row.note && <div className="msb-proc__note">{row.note}</div>}
      {row.comment && <div className="msb-proc__note">Comment: {row.comment}</div>}
      {(row.times.length > 0 || row.facts.length > 0) && (
        <div className="msb-proc__meta">
          {row.times.map((t) => (
            <When key={t.label} label={t.label} when={t.when} now={now} />
          ))}
          {row.facts.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </div>
      )}
      {row.lines.length > 0 && (
        <details className="msb-proc__lines">
          <summary>
            {linesLabel} ({row.lines.length})
          </summary>
          <ul>
            {row.lines.map((line, i) => (
              <li key={i}>
                {line.when && (
                  <span className="msb-proc__line-when" title={exactTime(line.when)}>
                    {relativeTime(line.when, now)}
                  </span>
                )}
                <span>{line.text}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function Section({ section, now }) {
  const [shown, setShown] = useState(INITIAL_ROWS);
  const infoNotes = section.notes.filter((n) => n.level === 'info');
  const head = (
    <>
      <strong>{section.label}</strong>
      <span className="msb-panel__badge" title={`${section.count} found`}>
        {section.count}
      </span>
      <span className="msb-proc__badges">
        {section.badges.map((b) => (
          <Badge key={`${b.tone}${b.text}`} tone={b.tone}>
            {b.count > 1 ? `${b.count} ` : ''}
            {b.text}
          </Badge>
        ))}
      </span>
    </>
  );

  if (section.status === 'denied' || section.status === 'error') {
    return (
      <div className="msb-proc__stub msb-proc__stub--unread">
        <div className="msb-proc__stub-head">
          <strong>{section.label}</strong>
          <Badge tone="warn">Could not read</Badge>
        </div>
        <div>The reason is in the warning above.</div>
      </div>
    );
  }
  if (section.status === 'missing') {
    return (
      <div className="msb-proc__stub">
        <div className="msb-proc__stub-head">
          <strong>{section.label}</strong>
          <Badge tone="muted">Not on this instance</Badge>
        </div>
        <div>{section.note}</div>
      </div>
    );
  }
  if (section.count === 0) {
    return (
      <div className="msb-proc__stub">
        <div className="msb-proc__stub-head">{head}</div>
        <div>{section.status === 'partial' ? 'None found, but part of it could not be read (see the warning above).' : 'None found.'}</div>
        {infoNotes.map((n) => (
          <div key={n.text} className="msb-panel__hint">
            {n.text}
          </div>
        ))}
      </div>
    );
  }
  const rows = section.rows.slice(0, shown);
  return (
    <details className="msb-panel__result msb-proc__section" open={section.attention || undefined}>
      <summary className="msb-panel__result-toggle msb-proc__summary">{head}</summary>
      <div className="msb-panel__result-body">
        <ul className="msb-proc__rows">
          {rows.map((row) => (
            <Row key={row.id} row={row} now={now} />
          ))}
        </ul>
        {section.rows.length > shown && (
          <button className="msb-panel__secondary" onClick={() => setShown(shown + 25)}>
            Show {Math.min(25, section.rows.length - shown)} more ({section.rows.length - shown} not shown)
          </button>
        )}
        {section.truncated && <div className="msb-panel__hint">Only the newest rows were read; there may be older ones.</div>}
        {infoNotes.map((n) => (
          <div key={n.text} className="msb-panel__hint">
            {n.text}
          </div>
        ))}
      </div>
    </details>
  );
}

function Headline({ summary }) {
  const level = LEVEL[summary.level] || LEVEL.unknown;
  const failing = summary.level === 'blocked' && summary.severity === 'error';
  const tone = failing ? 'danger' : level.tone;
  return (
    <div className={`msb-proc__card msb-proc__card--${tone}`} role="status">
      <div className="msb-proc__card-top">
        <Badge tone={tone}>{failing ? 'Needs attention' : level.label}</Badge>
        {summary.tag && <span className="msb-proc__tag">{summary.tag}</span>}
      </div>
      <div className="msb-proc__lead">{summary.headline}</div>
      {summary.detail && <div className="msb-proc__detail">{summary.detail}</div>}
      {summary.also && summary.also.length > 0 && (
        <div className="msb-proc__also">
          <div className="msb-proc__also-title">Also waiting on</div>
          <ul>
            {summary.also.map((b) => (
              <li key={`${b.kind}${b.text}`}>
                <Badge tone={SEVERITY_TONE[b.severity] || 'muted'}>{b.tag}</Badge> <span>{b.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.closedNote && <div className="msb-proc__detail">{summary.closedNote}</div>}
      {summary.absentNote && <div className="msb-panel__hint">{summary.absentNote}</div>}
    </div>
  );
}

/**
 * Everything running or run against the record on screen, with a plain-words "what is it waiting for" on top: Flow Designer,
 * legacy workflow, approvals, SLAs, child tasks and queued events. Read-only.
 */
export default function ProcessPanel({ context, services, onClose, onAskAi }) {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const run = useRef(0);

  const target = context?.table && TABLE_RE.test(context.table) && SYS_ID_RE.test(context.sysId || '') ? { table: context.table, sysId: context.sysId } : null;
  const key = target ? `${target.table}:${target.sysId}` : '';

  async function load() {
    if (!target) return;
    const mine = (run.current += 1);
    setBusy(true);
    setError(null);
    try {
      const result = await services.processLoad({ ...target, isCancelled: () => mine !== run.current });
      if (mine === run.current && result) setReport(result);
    } catch (err) {
      if (mine === run.current) setError(errorText(err));
    } finally {
      if (mine === run.current) setBusy(false);
    }
  }

  useEffect(() => {
    setReport(null);
    load();
    return () => {
      run.current += 1;
    };
    // Reads again when the record on screen changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const markdown = useMemo(() => (report ? redactSecrets(processMarkdown(report, { instance: report.host })) : ''), [report]);

  function flash(text) {
    setNotice(text);
    setTimeout(() => setNotice(null), 2500);
  }

  async function copySummary() {
    try {
      await copyText(markdown);
      flash('Copied the summary as Markdown');
    } catch (err) {
      setError(errorText(err));
    }
  }

  const inScope = report ? report.sections.filter((s) => s.status !== 'na') : [];
  const notApplicable = report ? report.sections.filter((s) => s.status === 'na') : [];
  const summary = report?.summary;

  return (
    <div className="msb-panel msb-proc">
      <div className="msb-panel__header">
        <strong>Flows, approvals and SLAs</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      {!target && <div className="msb-panel__empty">Open a saved record (a form with a sys_id) to see what is running on it.</div>}

      {target && (
        <div className="msb-proc__bar">
          <div className="msb-proc__subject">
            <strong>{report?.record.label || target.table}</strong>
            {report?.record.summary && <span className="msb-proc__summary-text">{report.record.summary}</span>}
            <span className="msb-proc__muted">{target.table}</span>
          </div>
          <div className="msb-panel__actions msb-proc__actions">
            <button className="msb-panel__secondary" onClick={load} disabled={busy}>
              {busy ? 'Reading...' : 'Refresh'}
            </button>
            <button className="msb-panel__secondary" onClick={copySummary} disabled={!report || busy}>
              Copy summary as Markdown
            </button>
            {onAskAi && (
              <button
                className="msb-panel__secondary"
                disabled={!report || busy}
                onClick={() =>
                  onAskAi(
                    'Why is this record stuck?',
                    `This is what is running and what has run against a ServiceNow ${report.table} record. Why is it stuck or slow, and what should I check first?\n\n${markdown}`
                  )
                }
              >
                Ask AI
              </button>
            )}
          </div>
        </div>
      )}

      {error && <div className="msb-panel__error">{error}</div>}
      {notice && (
        <div className="msb-panel__hint" role="status">
          {notice}
        </div>
      )}
      {busy && !report && (
        <div className="msb-proc__busy" aria-live="polite">
          Reading flows, approvals, SLAs, tasks, workflows and events...
        </div>
      )}

      {report && summary && (
        <>
          <Headline summary={summary} />

          {summary.unreadable.length > 0 && (
            <div className="msb-panel__warning" role="alert">
              <strong>
                Could not read {summary.unreadable.length} {summary.unreadable.length === 1 ? 'source' : 'sources'}
              </strong>
              <ul className="msb-proc__unread">
                {summary.unreadable.map((u) => (
                  <li key={`${u.section}${u.text}`}>
                    {u.label}: {u.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {report.schemaNote && <div className="msb-panel__hint">{report.schemaNote}</div>}

          <div className="msb-proc__sections">
            {inScope.map((section) => (
              <Section key={section.id} section={section} now={report.generatedAt} />
            ))}
          </div>

          {notApplicable.length > 0 && (
            <div className="msb-proc__na">
              {notApplicable.map((s) => (
                <div key={s.id}>
                  <strong>{s.label}</strong> {s.note}
                </div>
              ))}
            </div>
          )}
          <div className="msb-panel__hint msb-proc__foot">
            Read {new Date(report.generatedAt).toISOString().slice(11, 16)} UTC. Times are relative to that moment; hover a time for the exact UTC stamp.
          </div>
        </>
      )}
    </div>
  );
}
