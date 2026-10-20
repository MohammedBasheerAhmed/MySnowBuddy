import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { trusted } from './trusted.js';
import { askConfirm } from '../content/confirmDialog.js';
import {
  MARKER,
  MAX_PER_RUN,
  KINDS,
  TEXT_STYLES,
  TABLE_PRESETS,
  defaultPlanFields,
  buildRows,
  validatePlan,
  createAsk,
  cleanupAsk,
  runBatch,
  runCleanup,
  cleanupMode,
  cleanupSummary,
  settledIds,
  newBatchId,
  addRecords,
  removeRecords,
  batchesFor,
  previewText,
} from '../lib/testData.js';

const PREVIEW_ROWS = 8;
const PREVIEW_COLUMNS = 6;

/** A fresh generator of the chosen kind, keeping what can be kept from the old one. */
function specForKind(kind, old, field) {
  switch (kind) {
    case 'text':
      return { kind, style: 'word' };
    case 'pattern':
      return { kind, pattern: 'Test {n}' };
    case 'fixed':
      return { kind, value: '' };
    case 'int':
      return { kind, min: 0, max: 100 };
    case 'decimal':
      return { kind, min: 0, max: 1000, places: 2 };
    case 'bool':
      return { kind, chance: 0.5 };
    case 'date':
      return { kind, daysBack: 30, daysForward: 0, time: field.type !== 'glide_date' };
    case 'choice':
      return { kind, options: old?.options || [] };
    case 'ref':
      return { kind, table: field.reference, mode: 'random', ids: old?.ids || [] };
    default:
      return { kind: 'empty' };
  }
}

function GeneratorEditor({ field, spec, onChange }) {
  const set = (patch) => onChange({ ...spec, ...patch });
  const num = (key, label, width = 64) => (
    <label className="msb-td__mini">
      {label}
      <input type="number" style={{ width }} value={spec[key] ?? ''} onChange={(e) => set({ [key]: e.target.value === '' ? '' : Number(e.target.value) })} />
    </label>
  );
  return (
    <div className="msb-td__gen">
      <select aria-label={`Generator for ${field.name}`} value={spec.kind} onChange={(e) => onChange(specForKind(e.target.value, spec, field))}>
        {KINDS.map((k) => (
          <option key={k.id} value={k.id}>
            {k.label}
          </option>
        ))}
      </select>
      {spec.kind === 'text' && (
        <select aria-label={`Kind of text for ${field.name}`} value={spec.style} onChange={(e) => set({ style: e.target.value })}>
          {TEXT_STYLES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}
      {spec.kind === 'pattern' && <input aria-label={`Pattern for ${field.name}`} value={spec.pattern || ''} onChange={(e) => set({ pattern: e.target.value })} placeholder="Test user {n}" />}
      {spec.kind === 'fixed' && <input aria-label={`Value for ${field.name}`} value={spec.value || ''} onChange={(e) => set({ value: e.target.value })} />}
      {(spec.kind === 'int' || spec.kind === 'decimal') && (
        <>
          {num('min', 'min')}
          {num('max', 'max')}
        </>
      )}
      {spec.kind === 'bool' && num('chance', 'chance 0-1', 56)}
      {spec.kind === 'date' && num('daysBack', 'days back')}
      {spec.kind === 'choice' && <span className="msb-td__hint">{spec.options?.length || 0} choices from the instance</span>}
      {spec.kind === 'ref' && (
        <>
          <select aria-label={`How to fill ${field.name}`} value={spec.mode} onChange={(e) => set({ mode: e.target.value })}>
            <option value="random">random existing</option>
            <option value="fixed">this sys_id</option>
            <option value="empty">leave empty</option>
          </select>
          {spec.mode === 'fixed' && <input aria-label={`sys_id for ${field.name}`} value={spec.fixed || ''} onChange={(e) => set({ fixed: e.target.value.trim() })} placeholder="32-character sys_id" />}
          {spec.mode === 'random' && <span className="msb-td__hint">{spec.ids?.length || 0} {spec.table || 'records'} found</span>}
        </>
      )}
    </div>
  );
}

const when = (at) => new Date(at).toLocaleString();

/**
 * Create believable test records (preview first, then a confirmed, capped, sequential run) and clean them up again.
 * `/testdata incident 10` pre-fills the table and count; `/testdata cleanup` opens the batch list.
 */
export default function TestDataPanel({ onClose, services, params }) {
  const [guard, setGuard] = useState(null);
  const [table, setTable] = useState('incident');
  const [count, setCount] = useState(10);
  const [seed, setSeed] = useState(() => String(Math.floor(Math.random() * 90000) + 10000));
  const [schema, setSchema] = useState(null);
  const [plan, setPlan] = useState(null); // { fields, specs, include, note }
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(null); // { kind, done, total }
  const [report, setReport] = useState('');
  const [journal, setJournal] = useState([]);
  const [tab, setTab] = useState('create');
  const stopRef = useRef(false);

  const refreshJournal = useCallback(async () => {
    try {
      setJournal(await services.testDataJournal());
    } catch (err) {
      setError(err.message || String(err));
    }
  }, [services]);

  const loadTable = useCallback(
    async (name) => {
      const t = String(name || '').trim();
      setLoading(true);
      setError('');
      setReport('');
      try {
        const loaded = await services.testDataSchema(t);
        setSchema(loaded);
        setPlan(defaultPlanFields({ table: t, fields: loaded.fields, choices: loaded.choices, refs: loaded.refs }));
        setNow(new Date());
      } catch (err) {
        setSchema(null);
        setPlan(null);
        setError(err.message || String(err));
      } finally {
        setLoading(false);
      }
    },
    [services]
  );

  useEffect(() => {
    services.testDataGuard().then(setGuard).catch((err) => setError(err.message || String(err)));
    refreshJournal();
    const args = String(params?.args || '').trim();
    if (/^clean/i.test(args)) setTab('batches');
    else {
      const m = /^([a-z][a-z0-9_]*)(?:\s+(\d+))?/i.exec(args);
      if (m) {
        setTable(m[1].toLowerCase());
        if (m[2]) setCount(Math.min(Math.max(Number(m[2]), 1), MAX_PER_RUN));
        loadTable(m[1].toLowerCase());
      }
    }
    // Run once when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const built = useMemo(() => {
    if (!plan) return null;
    return buildRows({ table, fields: plan.fields, specs: plan.specs, include: plan.include, count: Math.min(Math.max(Number(count) || 1, 1), MAX_PER_RUN), seed, now });
  }, [plan, table, count, seed, now]);

  const check = useMemo(() => validatePlan({ table, count: Number(count), env: guard?.env, rows: built?.rows || [] }), [table, count, guard, built]);
  const writable = Boolean(guard?.allowed);
  // The "not recognised as dev" reason already has its own banner when writes are off.
  const blockers = [...check.problems.filter((p) => writable || !/not recognised as dev/.test(p)), ...(built?.problems || [])];

  const setSpec = (name, spec) => setPlan((p) => ({ ...p, specs: { ...p.specs, [name]: spec } }));
  const toggle = async (field, on) => {
    setPlan((p) => ({ ...p, include: on ? [...new Set([...p.include, field.name])] : p.include.filter((n) => n !== field.name) }));
    const spec = plan.specs[field.name];
    if (on && spec?.kind === 'ref' && spec.mode === 'random' && !spec.ids?.length && field.reference) {
      try {
        const refs = await services.testDataRefs(field.reference);
        if (refs.length) setSpec(field.name, { ...spec, ids: refs.map((r) => r.sysId) });
      } catch {
        // The field stays "random existing" with nothing to pick from; the preview says so.
      }
    }
  };

  const handleCreate = trusted(async () => {
    if (!built || !check.ok || built.problems.length || running) return;
    setError('');
    setReport('');
    const updateSet = await services.getCurrentUpdateSet?.().catch(() => null);
    const confirmed = await askConfirm(createAsk({ table, count: built.rows.length, updateSet: updateSet?.name || '', instance: guard?.host || '', fieldCount: Object.keys(built.rows[0] || {}).length }));
    if (!confirmed) return;

    const batchId = newBatchId();
    const rows = built.rows;
    stopRef.current = false;
    setRunning({ kind: 'create', done: 0, total: rows.length });
    let current = await services.testDataJournal().catch(() => []);
    try {
      const result = await runBatch({
        rows,
        shouldStop: () => stopRef.current,
        create: async (row) => {
          const made = await services.agentExecute('create_record', { table, fields: row, reason: `NowBuddy test data, batch ${batchId}` });
          return { sysId: made?.sysId, display: made?.display };
        },
        onRecord: (state) => {
          setRunning({ kind: 'create', done: state.created + state.failed, total: state.total });
          if (state.ok) {
            current = addRecords(current, { batchId, table, instance: guard?.host || '', seed, records: [state.record] });
            // Saved after every record: a closed tab or a crash still leaves a list cleanup can work from.
            services.testDataSaveJournal(current).catch(() => {});
          }
        },
      });
      await services.testDataSaveJournal(current);
      setJournal(current);
      const parts = [`Created ${result.created.length} of ${rows.length} ${table} record${rows.length === 1 ? '' : 's'}.`];
      if (result.failed.length) parts.push(`${result.failed.length} failed: ${result.failed[0].error}`);
      if (result.stopped) parts.push(result.stopped);
      parts.push('They are listed under Batches; "Clean up" removes exactly these.');
      setReport(parts.join(' '));
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setRunning(null);
    }
  });

  const cleanBatches = async (batches, scope) => {
    const total = batches.reduce((n, b) => n + b.records.length, 0);
    if (!total || running) return;
    const deactivates = batches.filter((b) => cleanupMode(b.table) === 'deactivate').reduce((n, b) => n + b.records.length, 0);
    const confirmed = await askConfirm(cleanupAsk({ table: batches.length === 1 ? batches[0].table : '', records: total, deactivates, scope }));
    if (!confirmed) return;
    setError('');
    setReport('');
    let current = await services.testDataJournal().catch(() => journal);
    const lines = [];
    setRunning({ kind: 'cleanup', done: 0, total });
    let done = 0;
    try {
      for (const batch of batches) {
        const mode = cleanupMode(batch.table);
        // eslint-disable-next-line no-await-in-loop -- one batch after the other
        const result = await runCleanup({
          table: batch.table,
          records: batch.records,
          exists: (t, ids) => services.testDataExisting(t, ids),
          remove: async (record) => {
            const reason = `NowBuddy test data cleanup, batch ${batch.id}`;
            if (mode === 'deactivate') {
              await services.agentExecute('update_record', { table: batch.table, sysId: record.sysId, fields: { active: 'false' }, reason });
              return 'deactivated';
            }
            await services.agentExecute('delete_record', { table: batch.table, sysId: record.sysId, reason });
            return 'deleted';
          },
          onRecord: () => {
            done += 1;
            setRunning({ kind: 'cleanup', done, total });
          },
        });
        current = removeRecords(current, batch.id, settledIds(result));
        // eslint-disable-next-line no-await-in-loop
        await services.testDataSaveJournal(current);
        lines.push(`${batch.table}: ${cleanupSummary(result).replace(/^Cleanup: /, '')}`);
      }
      setJournal(current);
      setReport(lines.join(' ') || 'Nothing to clean up.');
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setRunning(null);
    }
  };

  const mine = batchesFor(journal, guard?.host || '');
  const busy = Boolean(running);
  const shownRows = built?.rows.slice(0, PREVIEW_ROWS) || [];
  const columns = built ? [...new Set(built.rows.flatMap((r) => Object.keys(r)))].slice(0, PREVIEW_COLUMNS) : [];

  return (
    <div className="msb-panel msb-td">
      <div className="msb-panel__header">
        <strong>Test data</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      {guard && !guard.allowed && (
        <div className="msb-panel__error" role="alert">
          Creating test data is turned off on this instance ({guard.label || guard.host}): it is not recognised as dev, test or stage. Preview still works.
        </div>
      )}
      {guard?.allowed && (
        <div className="msb-td__banner">
          Writes to {guard.host} ({guard.env}). Preview first; nothing is sent until you confirm. Every record starts with {MARKER}.
        </div>
      )}

      <div className="msb-td__tabs" role="tablist">
        {[
          ['create', 'Create'],
          ['batches', `Batches${mine.length ? ` (${mine.length})` : ''}`],
        ].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="msb-panel__error">{error}</div>}
      {report && <div className="msb-panel__hint msb-td__report">{report}</div>}
      {running && (
        <div className="msb-td__progress" role="status">
          {running.kind === 'create' ? 'Creating' : 'Cleaning up'} {running.done} of {running.total}…
          <button className="msb-panel__secondary" onClick={() => (stopRef.current = true)} disabled={running.kind !== 'create'}>
            Stop
          </button>
        </div>
      )}

      {tab === 'create' && (
        <>
          <div className="msb-panel__form">
            <div className="msb-panel__row">
              <label>
                Table
                <input list="msb-td-tables" value={table} onChange={(e) => setTable(e.target.value.trim().toLowerCase())} placeholder="incident" onKeyDown={(e) => e.key === 'Enter' && loadTable(table)} />
                <datalist id="msb-td-tables">
                  {TABLE_PRESETS.map((p) => (
                    <option key={p.table} value={p.table}>
                      {p.label}
                    </option>
                  ))}
                </datalist>
              </label>
              <label>
                How many (1-{MAX_PER_RUN})
                <input type="number" min={1} max={MAX_PER_RUN} value={count} onChange={(e) => setCount(e.target.value === '' ? '' : Math.min(Math.max(Number(e.target.value), 1), MAX_PER_RUN))} />
              </label>
              <label>
                Seed
                <input value={seed} onChange={(e) => setSeed(e.target.value)} />
              </label>
            </div>
            <div className="msb-panel__actions">
              <button className="msb-panel__run" onClick={() => loadTable(table)} disabled={loading || busy || !table}>
                {loading ? 'Reading the table…' : plan ? 'Reload fields' : 'Plan'}
              </button>
              <button className="msb-panel__secondary" onClick={() => setSeed(String(Math.floor(Math.random() * 90000) + 10000))} disabled={!plan}>
                Different data
              </button>
            </div>
            <div className="msb-td__quick">
              {TABLE_PRESETS.slice(0, 7).map((p) => (
                <button key={p.table} className="msb-panel__secondary" onClick={() => { setTable(p.table); loadTable(p.table); }} disabled={loading || busy}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {plan?.note && <div className="msb-panel__hint">{plan.note}</div>}

          {plan && (
            <details className="msb-td__fields" open>
              <summary>Fields ({plan.include.length} of {plan.fields.length} on)</summary>
              <table className="msb-table msb-td__table">
                <thead>
                  <tr>
                    <th>Use</th>
                    <th>Field</th>
                    <th>Generator</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.fields.map((f) => {
                    const on = plan.include.includes(f.name) || f.mandatory;
                    return (
                      <tr key={f.name} className={on ? '' : 'msb-td__off'}>
                        <td>
                          <input type="checkbox" aria-label={`Use ${f.label || f.name}`} checked={on} disabled={f.mandatory} onChange={(e) => toggle(f, e.target.checked)} />
                        </td>
                        <td>
                          <div>{f.label || f.name}{f.mandatory ? ' *' : ''}</div>
                          <code>{f.name}</code> <span className="msb-td__hint">{f.type}</span>
                        </td>
                        <td>{on && plan.specs[f.name] ? <GeneratorEditor field={f} spec={plan.specs[f.name]} onChange={(s) => setSpec(f.name, s)} /> : <span className="msb-td__hint">not set</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </details>
          )}

          {built && (
            <>
              <div className="msb-panel__hint">
                Preview: the first {Math.min(PREVIEW_ROWS, built.rows.length)} of {built.rows.length} record{built.rows.length === 1 ? '' : 's'}. Nothing has been sent.
              </div>
              {built.notes.map((n) => (
                <div key={n} className="msb-panel__hint">
                  {n}
                </div>
              ))}
              <div className="msb-table-wrap">
                <table className="msb-table">
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.map((row, i) => (
                      <tr key={i}>
                        {columns.map((c) => (
                          <td key={c}>{row[c]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {Object.keys(built.rows[0] || {}).length > PREVIEW_COLUMNS && <div className="msb-td__hint">Showing {PREVIEW_COLUMNS} of {Object.keys(built.rows[0]).length} columns.</div>}
              {[...blockers, ...check.warnings].map((p) => (
                <div key={p} className={blockers.includes(p) ? 'msb-panel__error' : 'msb-panel__warning'}>
                  {p}
                </div>
              ))}
              <div className="msb-panel__actions">
                <button className="msb-panel__run" onClick={handleCreate} disabled={!writable || busy || !check.ok || built.problems.length > 0}>
                  Create {built.rows.length}…
                </button>
                <button className="msb-panel__secondary" onClick={() => navigator.clipboard?.writeText(previewText(built.rows, 10))}>
                  Copy preview
                </button>
              </div>
            </>
          )}
        </>
      )}

      {tab === 'batches' && (
        <div className="msb-td__batches">
          {mine.length === 0 ? (
            <div className="msb-panel__empty">No test data from this browser on {guard?.host || 'this instance'}.</div>
          ) : (
            <>
              <ul className="msb-td__list">
                {mine.map((b) => (
                  <li key={b.id} className="msb-td__batch">
                    <div>
                      <strong>{b.records.length}</strong> {b.table} · {when(b.at)}
                      <div className="msb-td__hint">{b.records.slice(0, 2).map((r) => r.display || r.sysId.slice(0, 8)).join(', ')}{b.records.length > 2 ? '…' : ''}</div>
                    </div>
                    <button className="msb-panel__secondary" onClick={trusted(() => cleanBatches([b], 'batch'))} disabled={busy || !writable}>
                      {cleanupMode(b.table) === 'deactivate' ? 'Deactivate' : 'Clean up'}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="msb-panel__actions">
                <button className="msb-panel__run" onClick={trusted(() => cleanBatches(mine, 'all'))} disabled={busy || !writable}>
                  Clean up all my test data
                </button>
              </div>
              <div className="msb-td__hint">Only records NowBuddy created and journaled are touched. Users are set inactive, never deleted.</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
