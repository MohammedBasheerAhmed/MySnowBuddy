import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildReport, formatMs, FEATURE_OPEN, scriptProbeAsk } from '../lib/doctor.js';
import { downloadText, suggestFilename } from '../lib/report.js';
import { askConfirm } from '../content/confirmDialog.js';
import { trusted } from './trusted.js';
import { PANELS } from './panelRegistry.js';

const CHECK_WORD = { ok: 'OK', warn: 'Look', fail: 'Problem', skip: 'Not run' };
const TOOL_WORD = { ok: 'OK', gaps: 'Gaps', broken: 'Will not work', unverified: 'Not checked' };
const TABLE_WORD = { ok: 'readable', missing: 'not on this instance', denied: 'cannot read (403)', unknown: 'not checked', unused: 'not needed' };
const COLUMN_WORD = { missing: 'missing', hidden: 'hidden from you', unverified: 'not checked' };
const VERDICT_WORD = { ok: 'Green', warn: 'Amber', fail: 'Red' };
const LEVEL_WORD = { blocking: 'Needed', gap: 'Optional', unverified: 'Not checked' };
const GROUPS = [
  { id: 'page', title: 'This page', hint: 'Is NowBuddy running here, and can it talk to the page?' },
  { id: 'you', title: 'You and the instance', hint: 'Who the session is, and which release this is.' },
  { id: 'api', title: 'API access', hint: 'The ways NowBuddy reads this instance.' },
];

/** The registered panel that opens a tool: named by its requirements, by FEATURE_OPEN, or by the same title. */
function openTarget(tool) {
  const named = tool.panel || FEATURE_OPEN[tool.feature]?.panel;
  if (named && PANELS.some((p) => p.name === named)) return { panel: named };
  const byTitle = PANELS.find((p) => p.title.toLowerCase() === tool.feature.toLowerCase());
  if (byTitle) return { panel: byTitle.name };
  return FEATURE_OPEN[tool.feature]?.slash ? { slash: FEATURE_OPEN[tool.feature].slash } : null;
}

function Badge({ kind, children }) {
  return <span className={`msb-doc__badge msb-doc__badge--${kind}`}>{children}</span>;
}

function CheckRow({ check, onRerun, busy }) {
  return (
    <li className={`msb-doc__row msb-doc__row--${check.status}`}>
      <div className="msb-doc__head">
        <Badge kind={check.status}>{CHECK_WORD[check.status] || check.status}</Badge>
        <span className="msb-doc__title">{check.title}</span>
        {check.ms !== null && <span className="msb-doc__ms">{formatMs(check.ms)}</span>}
      </div>
      <div className="msb-doc__summary">{check.summary}</div>
      {check.action && check.status !== 'ok' && (
        <div className="msb-doc__todo">
          <strong>What to do:</strong> {check.action}
        </div>
      )}
      {check.rerun === 'scriptProbe' && onRerun && (
        <button type="button" className="msb-panel__secondary msb-doc__rerun" onClick={trusted(() => onRerun({ scriptProbe: 'always' }))} disabled={busy}>
          Run it anyway
        </button>
      )}
      {check.details.length > 0 && check.details.length <= 3 && (
        <ul className="msb-doc__lines">
          {check.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {check.details.length > 3 && (
        <details className="msb-doc__more">
          <summary className="msb-panel__result-toggle">Details ({check.details.length})</summary>
          <ul className="msb-doc__lines">
            {check.details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/** The same problem seen by several tools, once, with what to do about it. */
function Causes({ causes }) {
  const [all, setAll] = useState(false);
  const shown = all ? causes : causes.slice(0, 5);
  return (
    <div className="msb-doc__causes">
      <h4 className="msb-doc__subheading">What is behind it ({causes.length})</h4>
      <ul className="msb-doc__list">
        {shown.map((c) => (
          <li key={`${c.kind}:${c.table}.${c.column}`} className={`msb-doc__row msb-doc__row--${c.blocking ? 'broken' : 'gaps'}`}>
            <div className="msb-doc__head">
              <Badge kind={c.blocking ? 'broken' : 'gaps'}>{c.blocking ? 'Blocks' : 'Gap'}</Badge>
              <span className="msb-doc__title">
                <code>{c.column ? `${c.table}.${c.column}` : c.table}</code>
              </span>
            </div>
            <div className="msb-doc__summary">{c.text}</div>
            <div className="msb-doc__todo">
              <strong>What to do:</strong> {c.advice}
            </div>
            <div className="msb-doc__lines">
              Affects {c.features.length} tool{c.features.length === 1 ? '' : 's'}: {c.features.slice(0, 6).join(', ')}
              {c.features.length > 6 ? ` and ${c.features.length - 6} more` : ''}
            </div>
          </li>
        ))}
      </ul>
      {causes.length > 5 && (
        <button type="button" className="msb-panel__secondary msb-doc__rerun" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${causes.length}`}
        </button>
      )}
    </div>
  );
}

function ToolRow({ tool, services }) {
  const target = useMemo(() => openTarget(tool), [tool]);
  const problems = tool.problems.filter((p) => p.level !== 'unverified' || tool.status === 'unverified');
  const shown = problems.slice(0, 3);
  return (
    <li className={`msb-doc__row msb-doc__tool msb-doc__row--${tool.status}`}>
      <div className="msb-doc__head">
        <Badge kind={tool.status}>{TOOL_WORD[tool.status]}</Badge>
        <span className="msb-doc__title">{tool.feature}</span>
        {target?.panel && services?.openRegisteredPanel && (
          <button type="button" className="msb-panel__link msb-doc__open" onClick={() => services.openRegisteredPanel(target.panel)} aria-label={`Open ${tool.feature}`}>
            Open
          </button>
        )}
        {target?.slash && <span className="msb-doc__slash" title={`Open it with ${target.slash}`}>{target.slash}</span>}
      </div>
      {tool.status === 'ok' && <div className="msb-doc__summary">{tool.summary}</div>}
      {shown.length > 0 && (
        <ul className="msb-doc__problems">
          {shown.map((p) => (
            <li key={`${p.kind}:${p.table}.${p.column}`} className={`msb-doc__problem msb-doc__problem--${p.level}`}>
              {/* The level in words, not only in the colour of the bar. */}
              <span className="msb-doc__problem-level">{LEVEL_WORD[p.level] || p.level}:</span> {p.text}
            </li>
          ))}
          {problems.length > shown.length && <li className="msb-doc__problem msb-doc__problem--more">and {problems.length - shown.length} more (see below)</li>}
        </ul>
      )}
      <details className="msb-doc__more">
        <summary className="msb-panel__result-toggle">
          What it reads ({tool.tables.length} table{tool.tables.length === 1 ? '' : 's'})
        </summary>
        <ul className="msb-doc__tables">
          {tool.tables.map((t) => (
            <li key={t.table}>
              <div className="msb-doc__tablehead">
                <code>{t.table}</code>
                {t.optional && <span className="msb-doc__tag">optional</span>}
                <span className={`msb-doc__state msb-doc__state--${t.state}`}>{TABLE_WORD[t.state]}</span>
              </div>
              {t.note && <div className="msb-doc__note">{t.note}</div>}
              {t.columns.length > 0 && (
                <div className="msb-doc__cols">
                  {t.columns.map((c) => (
                    <code key={c.name} className={`msb-doc__col msb-doc__col--${c.state}`} title={c.definedOn ? `defined on ${c.definedOn}` : undefined}>
                      {c.name}
                      {c.state !== 'ok' ? ` (${COLUMN_WORD[c.state]})` : ''}
                    </code>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

/**
 * Self-check (/doctor): which NowBuddy tools work on this instance and why not for the ones that will not.
 * Data comes from services.doctorRun (src/content/doctor.js); everything it does is read-only.
 */
export default function DoctorPanel({ services, onClose }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [filter, setFilter] = useState('attention');
  const [expanded, setExpanded] = useState({});
  const runId = useRef(0);

  async function run(options = {}) {
    // The script check on production, or on an instance NowBuddy cannot place, runs only after a yes.
    if (options.scriptProbe === 'always' && result && result.instance && !(await askConfirm(scriptProbeAsk(result.instance)))) return;
    runId.current += 1;
    const id = runId.current;
    setBusy(true);
    setError(null);
    setProgress({ label: 'Starting', done: 0, total: 1 });
    try {
      const next = await services.doctorRun({
        ...options,
        isCancelled: () => id !== runId.current,
        onProgress: (p) => {
          if (id === runId.current) setProgress(p);
        },
      });
      if (id === runId.current) {
        setResult(next);
        setFilter(next.counts.broken + next.counts.gaps + next.counts.unverified ? 'attention' : 'all');
      }
    } catch (err) {
      if (id === runId.current) setError(err?.message || String(err));
    } finally {
      if (id === runId.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  useEffect(() => {
    run();
    return () => {
      runId.current += 1;
    };
    // Runs once when the panel opens; "Run again" starts another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const report = useMemo(() => (result ? buildReport(result) : ''), [result]);

  function flash(text) {
    setNotice(text);
    setTimeout(() => setNotice(null), 3000);
  }

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(report);
      flash('Copied the report. It has no keys, tokens, user names or record data.');
    } catch {
      flash('The browser blocked copying. Open "Report text" below and copy it from there.');
    }
  }

  const tools = result?.tools || [];
  const needAttention = tools.filter((t) => t.status !== 'ok');
  const visibleTools = filter === 'attention' ? needAttention : tools;
  const percent = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;

  return (
    <div className="msb-panel msb-doc">
      <div className="msb-panel__header">
        <strong>Self-check</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>
      <div className="msb-panel__hint">Which NowBuddy tools work on this instance, and why not for the ones that do not. Read-only: it only reads.</div>

      {error && <div className="msb-panel__error">{error}</div>}

      {busy && (
        <div className="msb-doc__progress" role="status" aria-live="polite">
          <div className="msb-doc__bar" role="progressbar" aria-label="Self-check progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="msb-doc__progresstext">
            {progress?.label || 'Working'} ({progress?.done || 0} of {progress?.total || 0}). This can take up to a minute on a busy instance.
          </div>
        </div>
      )}

      {result && (
        <div className={`msb-doc__result${busy ? ' msb-doc__result--stale' : ''}`} aria-busy={busy}>
          <section className={`msb-doc__verdict msb-doc__verdict--${result.overall.status}`} aria-label="Verdict">
            <div className="msb-doc__verdicthead">
              <Badge kind={result.overall.status}>{VERDICT_WORD[result.overall.status]}</Badge>
              <span className="msb-doc__headline">{result.overall.headline}</span>
            </div>
            {result.overall.detail && <div className="msb-doc__summary">{result.overall.detail}</div>}
            <div className="msb-doc__facts">
              <span>NowBuddy {result.extension.version || '(version unknown)'}</span>
              <span>{result.instance.release || 'release not readable'}</span>
              <span>{result.instance.label ? `${result.instance.label}${result.instance.looksProduction ? ', production' : ''}` : result.instance.host}</span>
              <span>tier {result.user.tier || 'unknown'}</span>
              <span>
                {formatMs(result.durationMs)}, {result.requests} requests
              </span>
            </div>
            {result.notes.length > 0 && (
              <ul className="msb-doc__notes">
                {result.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <div className="msb-panel__actions">
              <button className="msb-panel__run" onClick={trusted(() => run())} disabled={busy}>
                {busy ? 'Checking...' : 'Run again'}
              </button>
              <button className="msb-panel__secondary" onClick={copyReport}>
                Copy report
              </button>
              <button className="msb-panel__secondary" onClick={() => downloadText(suggestFilename('selfcheck'), report)}>
                Download .md
              </button>
            </div>
            {notice && (
              <div className="msb-panel__hint" role="status">
                {notice}
              </div>
            )}
          </section>

          {GROUPS.map((group) => {
            const rows = result.checks.filter((c) => c.group === group.id);
            const look = rows.filter((c) => c.status === 'warn' || c.status === 'fail').length;
            const notRun = rows.filter((c) => c.status === 'skip').length;
            const fine = rows.length - look - notRun;
            // A group with nothing to look at starts folded, so the tools are not a long scroll away.
            const open = expanded[group.id] ?? look > 0;
            return (
              <section key={group.id} className="msb-doc__group" aria-label={group.title}>
                <h3 className="msb-doc__heading">
                  <button type="button" className="msb-doc__toggle" aria-expanded={open} onClick={() => setExpanded((e) => ({ ...e, [group.id]: !open }))}>
                    <span className="msb-doc__chev" aria-hidden="true" />
                    {group.title}
                  </button>
                  <span className="msb-doc__count">{[look ? `${look} to look at` : '', fine ? `${fine} fine` : '', notRun ? `${notRun} not run` : ''].filter(Boolean).join(', ')}</span>
                </h3>
                {open && (
                  <ul className="msb-doc__list">
                    {rows.map((c) => (
                      <CheckRow key={c.id} check={c} onRerun={run} busy={busy} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}

          <section className="msb-doc__group" aria-label="Tools">
            <h3 className="msb-doc__heading">
              Tools
              <span className="msb-doc__count">
                {result.counts.broken} will not work, {result.counts.gaps} with gaps, {result.counts.unverified} not checked, {result.counts.ok} fine
              </span>
            </h3>
            {result.causes.length > 0 && <Causes causes={result.causes} />}
            <div className="msb-doc__filters" role="group" aria-label="Which tools to list">
              <button type="button" className="msb-panel__secondary" aria-pressed={filter === 'attention'} onClick={() => setFilter('attention')}>
                Needs attention ({needAttention.length})
              </button>
              <button type="button" className="msb-panel__secondary" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                All ({tools.length})
              </button>
            </div>
            {visibleTools.length === 0 ? (
              <div className="msb-panel__empty">{tools.length ? 'Every tool has what it needs.' : 'No tool listed any requirements.'}</div>
            ) : (
              <ul className="msb-doc__list">
                {visibleTools.map((t) => (
                  <ToolRow key={t.feature} tool={t} services={services} />
                ))}
              </ul>
            )}
            <div className="msb-panel__hint">
              Tools that read whatever table you point them at (Compare with another record, Break this list down, Table explorer) depend on the Table API, Stats API and Dictionary checks above.
            </div>
          </section>

          <details className="msb-doc__more msb-doc__reporttext">
            <summary className="msb-panel__result-toggle">Report text (for a ticket or a message)</summary>
            <textarea readOnly value={report} aria-label="Report text" rows={10} onFocus={(e) => e.target.select()} />
          </details>
        </div>
      )}
    </div>
  );
}
