import React, { useCallback, useEffect, useRef, useState } from 'react';
import { flattenValue } from '../lib/export.js';
import { redactSecrets } from '../providers/redact.js';
import { trusted } from './trusted.js';
import { askConfirm } from '../content/confirmDialog.js';
import { atfRunAsk } from '../lib/confirmCopy.js';

const POLL_MS = 3000;
const MAX_POLLS = 200;

/** Run ATF suites and look at recent results. Starting a run always asks first. */
export default function AtfPanel({ services, onClose, onAskAi }) {
  const [tab, setTab] = useState('suites');
  const [search, setSearch] = useState('');
  const [suites, setSuites] = useState(null);
  const [results, setResults] = useState(null);
  const [suiteResults, setSuiteResults] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  const loadSuites = useCallback(async () => {
    setError(null);
    try {
      setSuites(await services.fetchAtfSuites(search));
    } catch (err) {
      setError(err.message);
    }
  }, [services, search]);

  const loadResults = useCallback(async () => {
    setError(null);
    try {
      const [tests, bySuite] = await Promise.all([services.fetchAtfResults(), services.fetchAtfSuiteResults()]);
      setResults(tests);
      setSuiteResults(bySuite);
    } catch (err) {
      setError(err.message);
    }
  }, [services]);

  useEffect(() => {
    loadSuites();
    // Initial load only; searching is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === 'results' && !results) loadResults();
  }, [tab, results, loadResults]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  function poll(progressId, count = 0) {
    timerRef.current = setTimeout(async () => {
      try {
        const state = await services.readAtfProgress(progressId);
        setProgress((p) => ({ ...p, ...state }));
        const done = state.percent >= 100 || /success|fail|cancel|complete/i.test(state.status);
        if (done) {
          setResults(null);
          return;
        }
        if (count < MAX_POLLS) poll(progressId, count + 1);
      } catch (err) {
        setError(err.message);
      }
    }, POLL_MS);
  }

  async function handleRun(suite) {
    if (!(await askConfirm(atfRunAsk(suite.name, window.location.hostname)))) return;
    setError(null);
    setProgress({ name: suite.name, percent: 0, status: 'Starting' });
    try {
      const { progressId, status } = await services.runAtfSuite(suite.sys_id);
      setProgress((p) => ({ ...p, status: status || 'Queued', progressId }));
      if (progressId) poll(progressId);
    } catch (err) {
      setProgress(null);
      setError(err.message);
    }
  }

  function explainFailure(row) {
    const name = flattenValue(row.test);
    onAskAi(
      `Why did "${name}" fail?`,
      'An ATF test failed on a ServiceNow instance. Explain the most likely cause from the output below, ' +
        'what to check first, and how to fix either the test or the code under test.\n\n' +
        `Test: ${name}\nStatus: ${flattenValue(row.status)}\nRun time: ${flattenValue(row.run_time)}\n\n` +
        `Output:\n${redactSecrets(flattenValue(row.output)).slice(0, 6000)}`
    );
  }

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>ATF</strong>
        <button onClick={onClose} aria-label="Close">
          {'\u2715'}
        </button>
      </div>

      <div className="msb-panel__actions">
        <button className={tab === 'suites' ? 'msb-panel__run' : 'msb-panel__secondary'} onClick={() => setTab('suites')}>
          Suites
        </button>
        <button
          className={tab === 'results' ? 'msb-panel__run' : 'msb-panel__secondary'}
          onClick={() => setTab('results')}
        >
          Results
        </button>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}

      {progress && (
        <div className="msb-panel__result">
          <div className="msb-panel__result-body">
            <strong>{progress.name}</strong>: {progress.status} {progress.percent ? `(${progress.percent}%)` : ''}
            {progress.message && <div className="msb-panel__hint">{progress.message}</div>}
          </div>
        </div>
      )}

      {tab === 'suites' && (
        <>
          <div className="msb-panel__form">
            <div className="msb-panel__row">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadSuites()}
                placeholder="Search suites"
                aria-label="Search suites"
              />
              <button className="msb-panel__secondary" onClick={loadSuites}>
                Search
              </button>
            </div>
          </div>
          {suites && !suites.length && <div className="msb-panel__empty">No suites found.</div>}
          {suites?.map((s) => (
            <div key={s.sys_id} className="msb-panel__result msb-prompts__item">
              <div className="msb-prompts__main">
                <span className="msb-prompts__title">{s.name}</span>
                {s.description && <span className="msb-prompts__desc">{s.description}</span>}
              </div>
              <button className="msb-panel__link" onClick={trusted(() => handleRun(s))} disabled={s.active === 'false'}>
                Run
              </button>
            </div>
          ))}
        </>
      )}

      {tab === 'results' && (
        <>
          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={loadResults}>
              Refresh
            </button>
          </div>
          {suiteResults?.map((r) => (
            <div key={r.sys_id} className="msb-panel__result msb-prompts__item">
              <div className="msb-prompts__main">
                <span className="msb-prompts__title">{flattenValue(r.test_suite)}</span>
                <span className="msb-prompts__desc">
                  {flattenValue(r.status)} - {flattenValue(r.success_count)} passed, {flattenValue(r.failure_count)} failed -{' '}
                  {flattenValue(r.sys_created_on)}
                </span>
              </div>
            </div>
          ))}
          {results?.map((r) => {
            const status = flattenValue(r.status);
            const failed = /fail|error/i.test(status);
            return (
              <div key={r.sys_id} className="msb-panel__result msb-prompts__item">
                <div className="msb-prompts__main">
                  <span className="msb-prompts__title">{flattenValue(r.test)}</span>
                  <span className="msb-prompts__desc">
                    {status} - {flattenValue(r.sys_created_on)}
                  </span>
                </div>
                {failed && (
                  <button className="msb-panel__link" onClick={() => explainFailure(r)}>
                    Explain failure
                  </button>
                )}
              </div>
            );
          })}
          {results && !results.length && <div className="msb-panel__empty">No results yet.</div>}
        </>
      )}
    </div>
  );
}
