import React, { useEffect, useRef, useState } from 'react';
import { refGraphMarkdown, listPath, SYS_ID_RE } from '../lib/refGraph.js';
import { copyText } from '../content/quickActions.js';

const CASCADE_TEXT = { delete: 'deleted too', restrict: 'blocks the delete', clear: 'reference cleared' };
const LEVEL_TEXT = { blocked: 'Delete is blocked', cascade: 'Delete cascades', clear: 'References would be cleared', none: 'Nothing points here', unknown: 'Could not count' };
const errorText = (err) => err?.message || String(err);

function Link({ href, children }) {
  return (
    <a className="msb-panel__link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * Which records point at the record on screen (counted per table.field, with what a delete would do to each), what it
 * points at, and for a CI its relationships. Read-only.
 */
export default function RefGraphPanel({ context, services, onClose }) {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [showZero, setShowZero] = useState(false);
  const run = useRef(0);

  const target = context?.table && SYS_ID_RE.test(context.sysId || '') ? { table: context.table, sysId: context.sysId } : null;

  async function load(showAll = false) {
    if (!target) return;
    const mine = (run.current += 1);
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const result = await services.refGraphLoad({ ...target, showAll, isCancelled: () => mine !== run.current, onProgress: (p) => mine === run.current && setProgress(p) });
      if (mine === run.current) setReport(result);
    } catch (err) {
      if (mine === run.current) setError(errorText(err));
    } finally {
      if (mine === run.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  useEffect(() => {
    load(false);
    return () => {
      run.current += 1;
    };
    // Once per panel instance; the panel is re-keyed when the record changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyReport() {
    try {
      await copyText(refGraphMarkdown({ table: report.table, name: report.name, sysId: report.sysId, summary: report.summary, incoming: report.incoming, outgoing: report.outgoing }));
      setNotice('Copied the report as Markdown');
      setTimeout(() => setNotice(null), 2500);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const hit = report ? report.incoming.filter((r) => r.count > 0) : [];
  const zero = report ? report.incoming.filter((r) => r.count === 0 && !r.error) : [];
  const failed = report ? report.incoming.filter((r) => r.error) : [];

  return (
    <div className="msb-panel msb-refs">
      <div className="msb-panel__header">
        <strong>What points at this record?</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      {!target && <div className="msb-panel__empty">Open a saved record (a form with a sys_id) to see what refers to it.</div>}
      {error && <div className="msb-panel__error">{error}</div>}
      {notice && <div className="msb-panel__hint">{notice}</div>}
      {busy && (
        <div className="msb-refs__busy" aria-live="polite">
          Counting references{progress ? `: ${progress.done} of ${progress.total} fields` : '…'}
        </div>
      )}

      {report && !busy && (
        <>
          <div className="msb-refs__subject">
            <strong>{report.name}</strong>
            <span className="msb-refs__muted">{report.table}</span>
          </div>

          <div className={`msb-refs__summary msb-refs__summary--${report.summary.level}`} role="status">
            <div className="msb-refs__level">{LEVEL_TEXT[report.summary.level]}</div>
            <div>{report.summary.headline}</div>
          </div>

          <h3 className="msb-refs__title">
            Points at this record <span className="msb-panel__badge">{hit.length}</span>
          </h3>
          {hit.length === 0 ? (
            <div className="msb-panel__empty">No reference or list field holds this record.</div>
          ) : (
            <ul className="msb-refs__list">
              {hit.map((r) => (
                <li key={`${r.table}.${r.field}`} className="msb-refs__item">
                  <Link href={listPath(r.table, r.query)}>
                    {r.table}.{r.field}
                  </Link>
                  <span className="msb-refs__count">{r.count.toLocaleString()}</span>
                  <span className={`msb-refs__tag msb-refs__tag--${r.cascade}`}>{CASCADE_TEXT[r.cascade]}</span>
                </li>
              ))}
            </ul>
          )}

          {(zero.length > 0 || failed.length > 0) && (
            <details className="msb-refs__more" open={showZero} onToggle={(e) => setShowZero(e.currentTarget.open)}>
              <summary>
                {zero.length} field{zero.length === 1 ? '' : 's'} with none{failed.length ? `, ${failed.length} could not be counted` : ''}
              </summary>
              <ul className="msb-refs__list msb-refs__list--quiet">
                {zero.map((r) => (
                  <li key={`${r.table}.${r.field}`}>
                    {r.table}.{r.field}
                  </li>
                ))}
                {failed.map((r) => (
                  <li key={`${r.table}.${r.field}`}>
                    {r.table}.{r.field}: {r.error}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {(report.plan.hiddenNoisy > 0 || report.plan.hiddenCap > 0) && (
            <div className="msb-refs__hidden">
              {report.plan.hiddenNoisy > 0 && `${report.plan.hiddenNoisy} audit, log, mail and attachment fields were skipped. `}
              {report.plan.hiddenCap > 0 && `${report.plan.hiddenCap} more fields were not counted. `}
              <button className="msb-panel__secondary" onClick={() => load(true)} disabled={busy}>
                Show all
              </button>
            </div>
          )}

          <h3 className="msb-refs__title">
            This record points at <span className="msb-panel__badge">{report.outgoing.length}</span>
          </h3>
          {report.outgoing.length === 0 ? (
            <div className="msb-panel__empty">It holds no references to other records.</div>
          ) : (
            <ul className="msb-refs__list">
              {report.outgoing.map((o, i) => (
                <li key={`${o.field}:${o.sysId}:${i}`} className="msb-refs__item">
                  <span className="msb-refs__muted">{o.label}</span>
                  <Link href={o.path}>{o.display}</Link>
                  <span className="msb-refs__tag">{o.table}</span>
                </li>
              ))}
            </ul>
          )}

          {report.rel && (report.rel.parents.length > 0 || report.rel.children.length > 0) && (
            <>
              <h3 className="msb-refs__title">Relationships</h3>
              {[
                ['Above (depends on this, or sends to it)', report.rel.parents],
                ['Below (this depends on, or contains)', report.rel.children],
              ].map(([title, rows]) =>
                rows.length ? (
                  <div key={title}>
                    <div className="msb-refs__muted">{title}</div>
                    <ul className="msb-refs__list">
                      {rows.map((r, i) => (
                        <li key={`${r.id}:${i}`} className="msb-refs__item">
                          <Link href={r.path}>{r.name}</Link>
                          {r.type && <span className="msb-refs__tag">{r.type}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null
              )}
            </>
          )}

          <div className="msb-panel__hint">{report.note}</div>
          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={copyReport}>
              Copy as Markdown
            </button>
            <button className="msb-panel__secondary" onClick={() => load(false)} disabled={busy}>
              Refresh
            </button>
          </div>
        </>
      )}
    </div>
  );
}
