import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CATEGORIES,
  STEP_DEFS,
  MAX_PER_TABLE,
  categoryLabel,
  filterFindings,
  notCheckedList,
  reportToMarkdown,
  reportToCsv,
  buildRemediationPrompt,
} from '../lib/healthScan.js';
import { downloadText, suggestFilename } from '../lib/report.js';

const PAGE = 100;
const STATUS_TEXT = {
  pending: 'Waiting',
  running: 'Running',
  done: 'Done',
  skipped: 'Skipped',
  error: 'Failed',
  partial: 'Partly checked',
  cancelled: 'Cancelled',
};
const SEVERITIES = ['high', 'medium', 'low'];

/** Where a finding is: record, field and line(s). */
function whereText(f) {
  const lines = f.line ? ` · line ${f.lines?.length > 1 ? f.lines.slice(0, 6).join(', ') + (f.occurrences > 6 ? '…' : '') : f.line}` : '';
  return `${f.tableLabel} · ${f.recordName}${f.field ? ` · ${f.field}` : ''}${lines}`;
}

function Finding({ f, open = false }) {
  return (
    <details className={`msb-health__finding msb-panel__finding msb-panel__finding--${f.severity}`} open={open}>
      <summary className="msb-health__finding-summary">
        <span className={`msb-health__sev msb-health__sev--${f.severity}`}>{f.severity}</span>
        <span className="msb-health__finding-title">{f.title}</span>
        <span className="msb-health__finding-where">{whereText(f)}</span>
      </summary>
      <div className="msb-health__finding-body">
        {f.excerpt && <pre className="msb-panel__snippet">{f.excerpt}</pre>}
        {f.why && (
          <p>
            <strong>Why it matters: </strong>
            {f.why}
          </p>
        )}
        {f.fix && (
          <p>
            <strong>How to fix: </strong>
            {f.fix}
          </p>
        )}
        <div className="msb-health__finding-meta">
          {f.link && (
            <a className="msb-panel__link" href={f.link} target="_blank" rel="noopener noreferrer">
              Open {/_list\.do/.test(f.link) ? 'list' : 'record'}
            </a>
          )}
          <span>
            {categoryLabel(f.category)} · {f.ruleId}
            {f.scope ? ` · ${f.scope}` : ''}
          </span>
        </div>
      </div>
    </details>
  );
}

function StepList({ steps }) {
  return (
    <ol className="msb-health__steps" aria-live="polite">
      {steps.map((s) => (
        <li key={s.id} className={`msb-health__step msb-health__step--${s.status}`}>
          <span className="msb-health__step-dot" aria-hidden="true" />
          <span className="msb-health__step-label">{s.label}</span>
          <span className="msb-health__step-status">{STATUS_TEXT[s.status] || s.status}</span>
          {s.detail && <span className="msb-health__step-detail">{s.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

function initialMode(args) {
  const text = String(args || '').trim();
  if (/^\d{1,3}$/.test(text)) return { mode: 'recent', days: text, search: '' };
  if (text) return { mode: 'scope', days: '7', search: text };
  return { mode: 'instance', days: '7', search: '' };
}

/** Instance health and upgrade-readiness scan. Read-only. */
export default function HealthScanPanel({ params, services, onClose, onAskAi }) {
  const start = useMemo(() => initialMode(params?.args), [params?.args]);
  const [mode, setMode] = useState(start.mode);
  const [days, setDays] = useState(start.days);
  const [onlyMine, setOnlyMine] = useState(false);
  const [includeBaseline, setIncludeBaseline] = useState(false);
  const [includeSecurity, setIncludeSecurity] = useState(true);
  const [scopeSearch, setScopeSearch] = useState(start.search);
  const [scopes, setScopes] = useState(null);
  const [scopeId, setScopeId] = useState('');
  const [updateSets, setUpdateSets] = useState(null);
  const [updateSetId, setUpdateSetId] = useState('');
  const [pickerError, setPickerError] = useState(null);

  const [phase, setPhase] = useState('idle');
  const [steps, setSteps] = useState([]);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const controllerRef = useRef(null);

  const [filters, setFilters] = useState({ severity: 'all', category: 'all', table: 'all', text: '' });
  const [shown, setShown] = useState(PAGE);

  // Closing the panel cancels a running scan, including requests in flight.
  useEffect(() => () => controllerRef.current?.abort(), []);

  async function loadScopes(search = scopeSearch) {
    setPickerError(null);
    try {
      const rows = await services.healthListScopes(search);
      setScopes(rows);
      if (!scopeId && rows.length) setScopeId(rows[0].sys_id);
    } catch (err) {
      setPickerError(err.message);
    }
  }

  async function loadUpdateSets() {
    setPickerError(null);
    try {
      const rows = await services.healthListUpdateSets();
      setUpdateSets(rows);
      if (!updateSetId && rows.length) setUpdateSetId(rows[0].sys_id);
    } catch (err) {
      setPickerError(err.message);
    }
  }

  useEffect(() => {
    if (mode === 'scope' && scopes === null) loadScopes();
    if (mode === 'updateset' && updateSets === null) loadUpdateSets();
    // Load each picker once, the first time its mode is chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const scopeOptions = useMemo(() => [{ sys_id: 'global', name: 'Global', scope: 'global' }, ...(scopes || []).filter((s) => s.sys_id !== 'global')], [scopes]);

  function buildOptions() {
    const options = { mode, includeBaseline: mode === 'updateset' ? false : includeBaseline, includeSecurity };
    if (mode === 'scope') {
      const chosen = scopeOptions.find((s) => s.sys_id === (scopeId || 'global')) || scopeOptions[0];
      options.scopeId = chosen.sys_id;
      options.scopeName = chosen.name || chosen.scope;
    }
    if (mode === 'updateset') {
      const chosen = (updateSets || []).find((s) => s.sys_id === updateSetId);
      options.updateSetId = updateSetId;
      options.updateSetName = chosen?.name || '';
    }
    if (mode === 'recent') {
      options.days = Number(days);
      options.onlyMine = onlyMine;
    }
    return options;
  }

  async function runScan() {
    if (!services.runHealthScan) {
      setError('The scan service is not available on this page. Reload the page and try again.');
      setPhase('error');
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setError(null);
    setReport(null);
    setFilters({ severity: 'all', category: 'all', table: 'all', text: '' });
    setShown(PAGE);
    setSteps(STEP_DEFS.map((d) => ({ id: d.id, label: d.label, status: 'pending', detail: '', notes: [] })));
    setPhase('running');
    try {
      const result = await services.runHealthScan(buildOptions(), (state) => setSteps(state.steps), controller.signal);
      if (controllerRef.current !== controller) return;
      setReport(result);
      setPhase('done');
    } catch (err) {
      if (controllerRef.current !== controller) return;
      setError(err.message || String(err));
      setPhase('error');
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  function cancelScan() {
    controllerRef.current?.abort();
  }

  const filtered = useMemo(() => (report ? filterFindings(report.findings, filters) : []), [report, filters]);
  const tableOptions = useMemo(() => {
    if (!report) return [];
    const seen = new Map();
    report.findings.forEach((f) => f.table && !seen.has(f.table) && seen.set(f.table, f.tableLabel));
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [report]);
  const notChecked = useMemo(() => (report ? [...(report.notes || []), ...notCheckedList(report)] : []), [report]);
  const collectError = useMemo(() => {
    const step = report?.steps.find((s) => s.id === 'collect');
    return step?.status === 'error' ? step.detail : '';
  }, [report]);

  const setFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setShown(PAGE);
  };

  function exportMarkdown() {
    downloadText(suggestFilename('health-scan'), reportToMarkdown(report));
  }

  function exportCsv() {
    downloadText(suggestFilename('health-scan', 'csv'), reportToCsv(report), 'text/csv');
  }

  function askAi() {
    onAskAi('Remediation plan for the health scan', buildRemediationPrompt(report));
  }

  const canRun =
    (mode !== 'scope' || scopeOptions.length > 0) &&
    (mode !== 'updateset' || Boolean(updateSetId)) &&
    (mode !== 'recent' || (/^\d+$/.test(String(days)) && Number(days) >= 1 && Number(days) <= 365));

  return (
    <div className="msb-panel msb-health">
      <div className="msb-panel__header">
        <strong>Health scan</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      {phase === 'idle' && (
        <div className="msb-panel__form">
          <p className="msb-panel__hint">
            Reviews custom scripts and configuration for quality, anti-patterns, upgrade risks and security. Read-only.
          </p>
          <label>
            Scope
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="instance">Whole instance</option>
              <option value="scope">One application</option>
              <option value="updateset">One update set</option>
              <option value="recent">Changed recently</option>
            </select>
          </label>

          {mode === 'scope' && (
            <>
              <div className="msb-panel__row">
                <input
                  value={scopeSearch}
                  onChange={(e) => setScopeSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && loadScopes()}
                  placeholder="Search applications"
                  aria-label="Search applications"
                />
                <button className="msb-panel__secondary" onClick={() => loadScopes()}>
                  Search
                </button>
              </div>
              <label>
                Application
                <select value={scopeId || 'global'} onChange={(e) => setScopeId(e.target.value)}>
                  {scopeOptions.map((s) => (
                    <option key={s.sys_id} value={s.sys_id}>
                      {s.name || s.scope} {s.scope && s.scope !== s.name ? `(${s.scope})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {mode === 'updateset' && (
            <label>
              Update set
              <select value={updateSetId} onChange={(e) => setUpdateSetId(e.target.value)} disabled={!updateSets?.length}>
                {!updateSets && <option value="">Loading...</option>}
                {updateSets && !updateSets.length && <option value="">No open update sets</option>}
                {(updateSets || []).map((s) => (
                  <option key={s.sys_id} value={s.sys_id}>
                    {s.name} ({s.state})
                  </option>
                ))}
              </select>
            </label>
          )}

          {mode === 'recent' && (
            <div className="msb-panel__checks">
              <label className="msb-panel__check">
                Last
                <input
                  className="msb-health__days"
                  type="number"
                  min="1"
                  max="365"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  aria-label="Number of days"
                />
                days
              </label>
              <label className="msb-panel__check">
                <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
                Last updated by me
              </label>
            </div>
          )}

          <div className="msb-panel__checks">
            <label className="msb-panel__check">
              <input
                type="checkbox"
                checked={mode === 'updateset' ? false : includeBaseline}
                disabled={mode === 'updateset'}
                onChange={(e) => setIncludeBaseline(e.target.checked)}
              />
              Include baseline (out-of-box) records
            </label>
            <label className="msb-panel__check">
              <input type="checkbox" checked={includeSecurity} onChange={(e) => setIncludeSecurity(e.target.checked)} />
              Run the security audit
            </label>
          </div>
          <p className="msb-panel__hint">
            A record counts as custom when it has a customer update (sys_update_xml) or belongs to your own x_ applications.
            Up to {MAX_PER_TABLE.toLocaleString()} records per table, most recently changed first.
          </p>
          {pickerError && <div className="msb-panel__error">{pickerError}</div>}
          <button className="msb-panel__run" onClick={runScan} disabled={!canRun}>
            Run scan
          </button>
        </div>
      )}

      {phase === 'running' && (
        <div className="msb-health__running">
          <StepList steps={steps} />
          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={cancelScan}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <>
          <div className="msb-panel__error">{error}</div>
          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={() => setPhase('idle')}>
              Back
            </button>
          </div>
        </>
      )}

      {phase === 'done' && report && (
        <div className="msb-health__report">
          {report.cancelled && <div className="msb-panel__warning">Cancelled. These results are partial.</div>}

          <div className="msb-health__headline">
            {report.findings.length ? (
              <>
                <strong>{report.findings.length}</strong> finding{report.findings.length === 1 ? '' : 's'}:{' '}
                {SEVERITIES.map((s) => `${report.totals[s]} ${s}`).join(', ')}
              </>
            ) : collectError ? (
              <>Scan incomplete.</>
            ) : report.scanned.records ? (
              <>No issues found by the rules.</>
            ) : (
              <>Nothing to scan in this scope.</>
            )}
          </div>
          <div className="msb-panel__hint">
            {report.scopeLabel}. Scanned {report.scanned.records} record{report.scanned.records === 1 ? '' : 's'} ({report.scanned.scripts} scripts) in{' '}
            {report.scanned.tables} tables in {Math.max(1, Math.round(report.durationMs / 1000))} s.
          </div>

          {collectError && <div className="msb-panel__error">Could not collect the scripts to scan: {collectError}</div>}

          {!collectError && !report.scanned.records && !report.findings.length && (
            <div className="msb-panel__empty">
              {/* Only a custom-only scan (customer updates) can be widened with the baseline tick box. */}
              {report.baseline?.method === 'customer-updates'
                ? 'No custom scripts were found. Tick "Include baseline records" to scan out-of-box code too.'
                : 'No active scripts were found for this scope.'}
            </div>
          )}

          <div className="msb-health__cards">
            {report.categories.map((c) => (
              <button
                key={c.id}
                className={`msb-health__card msb-health__card--${c.rating}${filters.category === c.id ? ' msb-health__card--active' : ''}`}
                onClick={() => setFilter('category', filters.category === c.id ? 'all' : c.id)}
                title={`Score ${c.points}: high x10, medium x3, low x1. Click to filter.`}
                aria-pressed={filters.category === c.id}
              >
                <span className="msb-health__card-label">{c.label}</span>
                <span className="msb-health__rating">{c.ratingLabel}</span>
                <span className="msb-health__card-counts">
                  {c.total ? `${c.counts.high} high · ${c.counts.medium} med · ${c.counts.low} low` : c.status === 'done' ? 'No findings' : STATUS_TEXT[c.status] || c.status}
                </span>
              </button>
            ))}
          </div>

          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={exportMarkdown}>
              Export Markdown
            </button>
            <button className="msb-panel__secondary" onClick={exportCsv} disabled={!report.findings.length}>
              Export CSV
            </button>
            <button className="msb-panel__secondary" onClick={askAi} disabled={!report.findings.length}>
              Ask AI for a remediation plan
            </button>
            <button className="msb-panel__secondary" onClick={() => setPhase('idle')}>
              New scan
            </button>
          </div>

          {report.top.length > 0 && (
            <section className="msb-health__section">
              <h4 className="msb-health__heading">Top issues</h4>
              {report.top.map((f, i) => (
                <Finding key={`top-${f.id}`} f={f} open={i === 0} />
              ))}
            </section>
          )}

          {report.findings.length > 0 && (
            <section className="msb-health__section">
              <h4 className="msb-health__heading">All findings</h4>
              <div className="msb-health__filters">
                <select value={filters.severity} onChange={(e) => setFilter('severity', e.target.value)} aria-label="Severity">
                  <option value="all">All severities</option>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <select value={filters.category} onChange={(e) => setFilter('category', e.target.value)} aria-label="Category">
                  <option value="all">All categories</option>
                  {CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <select value={filters.table} onChange={(e) => setFilter('table', e.target.value)} aria-label="Table">
                  <option value="all">All tables</option>
                  {tableOptions.map(([table, label]) => (
                    <option key={table} value={table}>
                      {label}
                    </option>
                  ))}
                </select>
                <input value={filters.text} onChange={(e) => setFilter('text', e.target.value)} placeholder="Filter text" aria-label="Filter text" />
              </div>
              <div className="msb-panel__counts">
                {filtered.length} of {report.findings.length}
              </div>
              {filtered.length === 0 && <div className="msb-panel__empty">No findings match these filters.</div>}
              {filtered.slice(0, shown).map((f) => (
                <Finding key={f.id} f={f} />
              ))}
              {filtered.length > shown && (
                <button className="msb-panel__link msb-health__more" onClick={() => setShown((n) => n + PAGE)}>
                  Show {Math.min(PAGE, filtered.length - shown)} more
                </button>
              )}
            </section>
          )}

          {report.rules.length > 0 && (
            <details className="msb-panel__result msb-health__section">
              <summary className="msb-panel__result-toggle">By rule ({report.rules.length})</summary>
              <div className="msb-panel__result-body">
                {report.rules.map((r) => (
                  <div key={r.ruleId} className="msb-health__rule">
                    <div>
                      <span className={`msb-health__sev msb-health__sev--${r.severity}`}>{r.severity}</span> <strong>{r.title}</strong>
                    </div>
                    <div className="msb-panel__hint">
                      {categoryLabel(r.category)} · {r.count} finding{r.count === 1 ? '' : 's'} in {r.records} record{r.records === 1 ? '' : 's'}
                      {r.misses ? ` · Can miss: ${r.misses}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          <details className="msb-panel__result msb-health__section">
            <summary className="msb-panel__result-toggle">How this was checked{notChecked.length ? ` · ${notChecked.length} note${notChecked.length === 1 ? '' : 's'}` : ''}</summary>
            <div className="msb-panel__result-body">
              <StepList steps={report.steps} />
              <p className="msb-panel__hint">
                Custom code: {report.baseline?.label || 'n/a'}. Rules are regex and heuristics, not a parser: read each flagged line before changing it.
                Ratings follow the worst severity found.
              </p>
              {notChecked.length > 0 && (
                <ul className="msb-health__notes">
                  {notChecked.map((n, i) => (
                    // eslint-disable-next-line react/no-array-index-key -- notes can repeat.
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
