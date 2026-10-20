import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RUN_KINDS, parseCallArgs, parseSetValues } from '../lib/testRun.js';
import { extractMethods, generateUnitTest, checklistKindForTable } from '../lib/testKit.js';
import { analyzeScriptRisk, formatRiskSummary } from '../lib/scriptSafety.js';
import { runScriptAsk } from '../lib/confirmCopy.js';
import { askConfirm } from '../content/confirmDialog.js';
import { getInstanceInfo } from '../content/quickActions.js';
import { trusted } from './trusted.js';
import { AtfTab, SnapshotsTab, AccessTab, ChecklistTab } from './TestKitMore.jsx';

const TABS = [
  ['run', 'Run on a record'],
  ['unit', 'Unit test'],
  ['atf', 'ATF'],
  ['snapshots', 'Snapshots'],
  ['access', 'Who can access'],
  ['checklist', 'Checklist'],
];

const ALIASES = { run: 'run', unit: 'unit', atf: 'atf', snapshot: 'snapshots', snapshots: 'snapshots', compare: 'snapshots', access: 'access', checklist: 'checklist' };

const SYS_ID = /^[0-9a-f]{32}$/i;
const copy = (text) => navigator.clipboard?.writeText(text);
const isProd = () => getInstanceInfo().env === 'prod';

function pickTab(params, target, context) {
  const asked = ALIASES[String(params?.args || '').trim().split(/\s+/)[0].toLowerCase()];
  if (asked) return asked;
  if (target?.kind === 'scriptInclude') return 'unit';
  if (target?.kind) return 'run';
  if (context?.table) return 'snapshots';
  return 'checklist';
}

function Chip({ kind, children }) {
  return <span className={`msb-tk__chip${kind ? ` msb-tk__chip--${kind}` : ''}`}>{children}</span>;
}

/** What a run printed, sorted: the summary first, then what changed, what a dry run held back, the result and the log. */
export function RunResult({ run, onAskAi, label }) {
  const { parsed } = run;
  const failed = Boolean(parsed.error || parsed.tampered || parsed.unavailable);
  return (
    <div>
      <div className={`msb-tk__summary${failed ? ' msb-tk__summary--fail' : ''}`} role="status">
        {run.dryRun ? <Chip kind="pass">Dry run</Chip> : <Chip kind="warn">Real run</Chip>} {run.summary}
      </div>
      {parsed.changes.length > 0 && (
        <div className="msb-tk__section">
          <h4>Changed in memory (not saved)</h4>
          <table className="msb-tk__table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              {parsed.changes.map((c) => (
                <tr key={c.field}>
                  <td>{c.field}</td>
                  <td className="msb-tk__from">{c.before || '(empty)'}</td>
                  <td>{c.after || '(empty)'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {run.dryRun && (
        <div className="msb-tk__section">
          <h4>Writes the dry run held back ({parsed.writeCount ?? parsed.writes.length})</h4>
          {parsed.writes.length ? (
            <ol className="msb-tk__list">
              {parsed.writes.map((w, i) => (
                <li key={i} className="msb-tk__item">
                  {w}
                </li>
              ))}
            </ol>
          ) : (
            <div className="msb-panel__empty">None: the script made no writes.</div>
          )}
        </div>
      )}
      {parsed.result !== null && (
        <div className="msb-tk__section">
          <h4>Returned</h4>
          <pre className="msb-tk__pre">{parsed.result}</pre>
        </div>
      )}
      {parsed.logs.length > 0 && (
        <div className="msb-tk__section">
          <h4>Script output</h4>
          <pre className="msb-tk__pre">{parsed.logs.join('\n')}</pre>
        </div>
      )}
      {parsed.notes.length > 0 && <div className="msb-tk__muted">{parsed.notes.join(' · ')}</div>}
      {(failed || parsed.logs.length > 0) && onAskAi && (
        <div className="msb-tk__row">
          <button
            className="msb-panel__secondary"
            onClick={() =>
              onAskAi(`Explain this test run: ${label}`, `I ran a ServiceNow script as a test (${run.dryRun ? 'dry run' : 'real run'}). Explain what happened and what to fix.\n\nSummary: ${run.summary}\n\nOutput:\n${parsed.raw.slice(0, 6000)}\n\nScript under test:\n${run.script.slice(0, 8000)}`)
            }
          >
            Ask AI to explain
          </button>
        </div>
      )}
    </div>
  );
}

// --- Run on a record ---------------------------------------------------------------------------------------------------

function RunTab({ target, context, services, onAskAi }) {
  const [kind, setKind] = useState(target?.kind || 'businessRule');
  const [script, setScript] = useState(target?.script || context?.scriptBody || '');
  const [table, setTable] = useState(target?.runsOn || (target?.kind ? '' : context?.table) || '');
  const [term, setTerm] = useState('');
  const [records, setRecords] = useState(null);
  const [sysId, setSysId] = useState(target?.kind === 'scriptInclude' ? '' : context?.sysId && !target?.kind ? context.sysId : '');
  const [setText, setSetText] = useState('');
  const [className, setClassName] = useState(target?.className || '');
  const [method, setMethod] = useState(target?.methods?.find((m) => m.name !== 'initialize' && !m.name.startsWith('_'))?.name || '');
  const [argsText, setArgsText] = useState('');
  const [includeSource, setIncludeSource] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [run, setRun] = useState(null);
  const spec = RUN_KINDS[kind];
  const methods = target?.methods || [];
  const seq = useRef(0);

  async function loadRecords(search = '') {
    if (!/^[a-z][a-z0-9_]*$/.test(table)) return;
    const id = (seq.current += 1);
    try {
      const rows = await services.testFindRecords({ table, term: search });
      if (id === seq.current) setRecords(rows);
    } catch (err) {
      if (id === seq.current) {
        setRecords([]);
        setError(err.message);
      }
    }
  }

  useEffect(() => {
    if (spec?.needsRecord || table) loadRecords('');
    // Load the newest records when the table is known or changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  const risk = useMemo(() => analyzeScriptRisk(script), [script]);

  async function start(dryRun) {
    setError(null);
    const set = parseSetValues(setText);
    const args = parseCallArgs(argsText);
    if (!set.ok) return setError(set.error);
    if (!args.ok) return setError(args.error);
    if (!dryRun) {
      const ask = runScriptAsk({ hostname: window.location.hostname, riskSummary: risk.hasWrites ? formatRiskSummary(risk) : '', prod: isProd() });
      if (!(await askConfirm({ ...ask, title: isProd() ? 'Run for real on PRODUCTION?' : 'Run for real?', message: `${ask.message} It runs against the chosen record, and any write it makes is real.`, danger: true }))) return;
    }
    setBusy(true);
    setRun(null);
    try {
      setRun(
        await services.testRunOnRecord({
          kind,
          script,
          table: table.trim(),
          sysId: sysId.trim(),
          set: set.values,
          className: className.trim(),
          method: method.trim(),
          args: args.args,
          includeSource,
          dryRun,
          confirmed: !dryRun,
        })
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const needsRecord = spec.needsRecord;
  const ready = kind === 'scriptInclude' ? className.trim() && method.trim() && (!needsRecord || SYS_ID.test(sysId)) : script.trim() && (!needsRecord || SYS_ID.test(sysId));

  return (
    <div>
      <div className="msb-tk__subject">
        {target?.kind ? (
          <>
            <strong>{spec.label}</strong>: {target.name}
            {target.runsOn ? ` (on ${target.runsOn})` : ''}
          </>
        ) : (
          <>Open a business rule, UI action, Script Include or fix script, or choose what to run and paste the script.</>
        )}
      </div>

      <label className="msb-tk__field">
        What it is
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(RUN_KINDS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </label>

      {kind === 'scriptInclude' ? (
        <>
          <div className="msb-tk__row">
            <label className="msb-tk__field" style={{ flex: 1 }}>
              Class
              <input value={className} onChange={(e) => setClassName(e.target.value)} placeholder="IncidentUtils" />
            </label>
            <label className="msb-tk__field" style={{ flex: 1 }}>
              Method
              {methods.length ? (
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {methods.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}({m.params.join(', ')})
                    </option>
                  ))}
                </select>
              ) : (
                <input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="isOpen" />
              )}
            </label>
          </div>
          <label className="msb-tk__field">
            Arguments (JSON array; "@current" passes the record)
            <input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder='["@current", "abc", 5]' />
          </label>
          <label className="msb-tk__check">
            <input type="checkbox" checked={includeSource} onChange={(e) => setIncludeSource(e.target.checked)} />
            Test the version on screen (include its source, saved or not)
          </label>
        </>
      ) : (
        <label className="msb-tk__field">
          Script
          <textarea className="msb-tk__code" rows={6} value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false} />
        </label>
      )}

      <div className="msb-tk__section">
        <h4>{needsRecord ? 'Run it against which record?' : 'Bind a record as "current" (optional)'}</h4>
        <div className="msb-tk__row">
          <input
            value={table}
            onChange={(e) => setTable(e.target.value.trim())}
            placeholder="table, e.g. incident"
            aria-label="Table of the record"
            style={{ width: '9em' }}
          />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadRecords(term)}
            placeholder="number, name or sys_id"
            aria-label="Find a record"
            style={{ flex: 1 }}
          />
          <button className="msb-panel__secondary" onClick={() => loadRecords(term)}>
            Find
          </button>
        </div>
        {records && !records.length && <div className="msb-panel__empty">No records found on that table.</div>}
        {records && records.length > 0 && (
          <ul className="msb-tk__pick">
            {records.map((r) => (
              <li key={r.sysId}>
                <label>
                  <input type="radio" name="msb-tk-record" checked={sysId === r.sysId} onChange={() => setSysId(r.sysId)} />
                  <span>{r.label}</span>
                  <span className="msb-tk__muted">{r.updatedOn}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {sysId && <div className="msb-tk__muted">Selected: {sysId}</div>}
      </div>

      {spec.needsRecord || sysId ? (
        <label className="msb-tk__field">
          Pretend these fields changed (JSON, in memory only, never saved)
          <input value={setText} onChange={(e) => setSetText(e.target.value)} placeholder='{"state": "6", "assigned_to": ""}' />
        </label>
      ) : null}

      {error && <div className="msb-panel__error">{error}</div>}

      <div className="msb-tk__row">
        <button className="msb-panel__run" onClick={trusted(() => start(true))} disabled={busy || !ready}>
          {busy ? 'Running...' : 'Dry run'}
        </button>
        <button className="msb-panel__secondary msb-tk__danger" onClick={trusted(() => start(false))} disabled={busy || !ready} title="Writes are real. Asks first.">
          Run for real...
        </button>
      </div>
      <div className="msb-tk__muted">A dry run holds back GlideRecord writes and lists them. It does not block events, e-mail, REST calls or flows.</div>
      {run?.warnings?.length > 0 && (
        <div className="msb-tk__notice msb-tk__notice--warn">
          {run.warnings.map((w, i) => (
            <div key={i}>{w.text}</div>
          ))}
        </div>
      )}
      {run && <RunResult run={run} onAskAi={onAskAi} label={target?.name || spec.label} />}
    </div>
  );
}

// --- Unit test ----------------------------------------------------------------------------------------------------------

function UnitTab({ target, context, services, onUseScript, onAskAi }) {
  const [source, setSource] = useState(target?.kind === 'scriptInclude' ? target.script : '');
  const parsed = useMemo(() => extractMethods(source), [source]);
  const [className, setClassName] = useState(target?.className || '');
  const [includeSource, setIncludeSource] = useState(true);
  const [includePrivate, setIncludePrivate] = useState(false);
  const [script, setScript] = useState('');
  const [name, setName] = useState('');
  const [saved, setSaved] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [outcome, setOutcome] = useState(null);

  useEffect(() => {
    services.testSavedList().then(setSaved).catch(() => {});
  }, [services]);

  const effectiveClass = className || parsed.className;

  function generate() {
    setError(null);
    try {
      const made = generateUnitTest({ className: effectiveClass, methods: parsed.methods, source, includeSource, includePrivate });
      setScript(made.script);
      setOutcome(null);
      setName(`${effectiveClass} unit test`);
      setNotice(`${made.methodCount} method${made.methodCount === 1 ? '' : 's'} covered. Fill in the TODO assertions, then run it.`);
    } catch (err) {
      setError(err.message);
    }
  }

  async function runIt(dryRun, savedId = '') {
    setError(null);
    if (!dryRun) {
      const ask = runScriptAsk({ hostname: window.location.hostname, prod: isProd() });
      if (!(await askConfirm({ ...ask, title: isProd() ? 'Run the tests for real on PRODUCTION?' : 'Run the tests for real?', message: `${ask.message} Writes the code under test makes are real.`, danger: true }))) return;
    }
    setBusy(true);
    setOutcome(null);
    try {
      const result = await services.testRunUnit({ script, dryRun, confirmed: !dryRun });
      setOutcome(result);
      if (savedId) setSaved(await services.testSavedRecordRun(savedId, result.results.summary));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    try {
      setSaved(await services.testSavedSave({ name, script, className: effectiveClass, table: context?.table || '' }));
      setNotice('Saved. It is kept in this browser; load it later to run it again.');
    } catch (err) {
      setError(err.message);
    }
  }

  const summary = outcome?.results.summary;
  return (
    <div>
      <div className="msb-tk__subject">
        {target?.kind === 'scriptInclude' ? (
          <>
            <strong>Script Include</strong>: {target.name}
          </>
        ) : (
          <>Open a Script Include, or paste its source here.</>
        )}
      </div>
      {target?.kind !== 'scriptInclude' && (
        <label className="msb-tk__field">
          Script Include source
          <textarea className="msb-tk__code" rows={5} value={source} onChange={(e) => setSource(e.target.value)} spellCheck={false} />
        </label>
      )}
      <div className="msb-tk__row">
        <label className="msb-tk__field" style={{ flex: 1 }}>
          Class
          <input value={effectiveClass} onChange={(e) => setClassName(e.target.value)} placeholder="IncidentUtils" />
        </label>
      </div>
      <div className="msb-tk__muted">
        {parsed.methods.length ? `Found ${parsed.methods.length} method${parsed.methods.length === 1 ? '' : 's'}: ${parsed.methods.map((m) => m.name).join(', ')}` : 'No methods found in the source yet.'}
      </div>
      <div className="msb-tk__row">
        <label className="msb-tk__check">
          <input type="checkbox" checked={includeSource} onChange={(e) => setIncludeSource(e.target.checked)} />
          Include the source (test the unsaved version)
        </label>
        <label className="msb-tk__check">
          <input type="checkbox" checked={includePrivate} onChange={(e) => setIncludePrivate(e.target.checked)} />
          Private methods (_name)
        </label>
      </div>
      <div className="msb-tk__row">
        <button className="msb-panel__run" onClick={generate} disabled={!effectiveClass}>
          Write the test
        </button>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}
      {notice && <div className="msb-tk__notice">{notice}</div>}

      {script && (
        <>
          <label className="msb-tk__field">
            Test (edit the TODO lines)
            <textarea className="msb-tk__code" rows={12} value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false} />
          </label>
          <div className="msb-tk__row">
            <button className="msb-panel__run" onClick={trusted(() => runIt(true))} disabled={busy}>
              {busy ? 'Running...' : 'Run (dry run)'}
            </button>
            <button className="msb-panel__secondary msb-tk__danger" onClick={trusted(() => runIt(false))} disabled={busy}>
              Run for real...
            </button>
            <button className="msb-panel__secondary" onClick={() => copy(script)}>
              Copy
            </button>
            {onUseScript && (
              <button className="msb-panel__secondary" onClick={() => onUseScript(script)}>
                Open in script runner
              </button>
            )}
          </div>
          <div className="msb-tk__row">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name to save it under" aria-label="Test name" style={{ flex: 1 }} />
            <button className="msb-panel__secondary" onClick={trusted(save)} disabled={!name.trim()}>
              Save
            </button>
          </div>
        </>
      )}

      {outcome && (
        <div className="msb-tk__section">
          <div className={`msb-tk__summary${summary.failed || !outcome.results.complete ? ' msb-tk__summary--fail' : ''}`} role="status">
            {outcome.dryRun ? <Chip kind="pass">Dry run</Chip> : <Chip kind="warn">Real run</Chip>} {summary.passed} passed, {summary.failed} failed of {summary.total} in {summary.ms} ms
            {!outcome.results.complete && ' (the script stopped before the end)'}
          </div>
          {outcome.results.tests.length > 0 && (
            <table className="msb-tk__table">
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Result</th>
                  <th>ms</th>
                </tr>
              </thead>
              <tbody>
                {outcome.results.tests.map((t) => (
                  <tr key={t.name}>
                    <td>
                      {t.name}
                      {t.message && <div className="msb-tk__muted">{t.message}</div>}
                    </td>
                    <td>
                      <Chip kind={t.status === 'pass' ? 'pass' : 'fail'}>{t.status === 'pass' ? 'Pass' : 'Fail'}</Chip>
                    </td>
                    <td>{t.ms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {outcome.run.error && <div className="msb-panel__error">{outcome.run.error}</div>}
          {outcome.dryRun && outcome.run.writes.length > 0 && (
            <div className="msb-tk__section">
              <h4>Writes the dry run held back ({outcome.run.writeCount ?? outcome.run.writes.length})</h4>
              <ol className="msb-tk__list">
                {outcome.run.writes.map((w, i) => (
                  <li key={i} className="msb-tk__item">
                    {w}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {summary.failed > 0 && onAskAi && (
            <div className="msb-tk__row">
              <button
                className="msb-panel__secondary"
                onClick={() =>
                  onAskAi(
                    `Why did ${summary.failed} test(s) fail?`,
                    `These unit tests for a ServiceNow Script Include failed. Say whether the code or the test is wrong and how to fix it.\n\n${outcome.results.tests
                      .filter((t) => t.status === 'fail')
                      .map((t) => `- ${t.name}: ${t.message}`)
                      .join('\n')}\n\nTest script:\n${script.slice(0, 8000)}`
                  )
                }
              >
                Ask AI about the failures
              </button>
            </div>
          )}
        </div>
      )}

      {saved.length > 0 && (
        <div className="msb-tk__section">
          <h4>Saved tests</h4>
          <ul className="msb-tk__list">
            {saved.map((t) => (
              <li key={t.id} className="msb-tk__item">
                <div className="msb-tk__item-head">
                  <strong>{t.name}</strong>
                  {t.lastRun && (
                    <Chip kind={t.lastRun.failed ? 'fail' : 'pass'}>
                      {t.lastRun.passed}/{t.lastRun.total} passed
                    </Chip>
                  )}
                  <span className="msb-tk__muted">{new Date(t.savedAt).toLocaleDateString()}</span>
                </div>
                <div className="msb-tk__row">
                  <button
                    className="msb-panel__secondary"
                    onClick={() => {
                      setScript(t.script);
                      setName(t.name);
                      setOutcome(null);
                    }}
                  >
                    Load
                  </button>
                  <button
                    className="msb-panel__secondary"
                    onClick={trusted(async () => {
                      setScript(t.script);
                      setName(t.name);
                      await runIt(true, t.id);
                    })}
                    disabled={busy}
                  >
                    Run (dry run)
                  </button>
                  <button className="msb-panel__secondary" onClick={trusted(async () => setSaved(await services.testSavedRemove(t.id)))}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- The panel -------------------------------------------------------------------------------------------------------------

/**
 * Testing in one place: run the script on screen against a record, write and run unit tests for a Script Include,
 * find the ATF tests that cover it, snapshot and compare records, check who can access a record, and a checklist.
 * Data comes from services.test* (src/content/testKit.js).
 */
export default function TestKitPanel({ context, params, services, onClose, onAskAi, onUseScript }) {
  const [target, setTarget] = useState(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState(() => pickTab(params, null, context));

  useEffect(() => {
    let live = true;
    services
      .testTarget({ table: context?.table, sysId: context?.sysId })
      .then((t) => {
        if (!live) return;
        setTarget(t);
        // A requested tab wins; otherwise the page decides now that it is known.
        if (!ALIASES[String(params?.args || '').trim().split(/\s+/)[0].toLowerCase()]) setTab(pickTab(params, t, context));
      })
      .catch(() => {})
      .finally(() => live && setReady(true));
    return () => {
      live = false;
    };
    // The panel is re-keyed when its arguments change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checklistKind = checklistKindForTable(context?.table || '');

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Test</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>
      <div className="msb-tk__tabs" role="tablist" aria-label="Testing tools">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className="msb-tk__tab" onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {!ready && <div className="msb-impact__busy">Reading the page...</div>}
      {ready && tab === 'run' && <RunTab key={target?.sysId || 'none'} target={target} context={context} services={services} onAskAi={onAskAi} />}
      {ready && tab === 'unit' && <UnitTab key={target?.sysId || 'none'} target={target} context={context} services={services} onUseScript={onUseScript} onAskAi={onAskAi} />}
      {ready && tab === 'atf' && <AtfTab target={target} context={context} services={services} />}
      {ready && tab === 'snapshots' && <SnapshotsTab context={context} services={services} />}
      {ready && tab === 'access' && <AccessTab context={context} services={services} />}
      {ready && tab === 'checklist' && <ChecklistTab kind={checklistKind} target={target} context={context} onAskAi={onAskAi} />}
    </div>
  );
}

