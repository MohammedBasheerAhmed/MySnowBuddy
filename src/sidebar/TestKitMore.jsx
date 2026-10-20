import React, { useEffect, useRef, useState } from 'react';
import { atfRunAsk } from '../lib/confirmCopy.js';
import { NO_ATF_NOTE } from '../lib/testAtf.js';
import { diffToMarkdown } from '../lib/testSnapshot.js';
import { MATRIX_OPERATIONS, MATRIX_MAX_USERS, matrixToMarkdown, buildChecklist, checklistToMarkdown } from '../lib/testKit.js';
import { askConfirm } from '../content/confirmDialog.js';
import { trusted } from './trusted.js';

const SYS_ID = /^[0-9a-f]{32}$/i;
const copy = (text) => navigator.clipboard?.writeText(text);
const TABLE = /^[a-z][a-z0-9_]*$/;

function Chip({ kind, children }) {
  return <span className={`msb-tk__chip${kind ? ` msb-tk__chip--${kind}` : ''}`}>{children}</span>;
}

const KIND_LABEL = { pass: 'Passed', fail: 'Failed', skip: 'Skipped', running: 'Running', unknown: 'Not run' };
const KIND_CHIP = { pass: 'pass', fail: 'fail', skip: 'warn', running: 'warn', unknown: '' };

// --- ATF finder -----------------------------------------------------------------------------------------------------

const POLL_MS = 3000;
const MAX_POLLS = 200;

/** Which ATF tests and suites mention this table or Script Include, how their last run went, and a button to run a suite. */
export function AtfTab({ target, context, services }) {
  const scriptTable = target?.kind && ['sys_script', 'sys_ui_action'].includes(context?.table);
  const [table, setTable] = useState(scriptTable ? target.runsOn || '' : target?.kind ? '' : context?.table || '');
  const [name, setName] = useState(target?.kind === 'scriptInclude' ? target.name : '');
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const timer = useRef(null);

  async function find() {
    setBusy(true);
    setError(null);
    try {
      setReport(await services.testAtfFind({ table: table.trim(), name: name.trim(), apiName: target?.apiName || '' }));
    } catch (err) {
      setError(err.message);
      setReport(null);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (table || name) find();
    return () => clearTimeout(timer.current);
    // One search when the tab opens, if there is something to search for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function poll(progressId, count = 0) {
    timer.current = setTimeout(async () => {
      try {
        const state = await services.readAtfProgress(progressId);
        setProgress((p) => ({ ...p, ...state }));
        if (state.percent >= 100 || /success|fail|cancel|complete/i.test(state.status)) {
          find();
          return;
        }
        if (count < MAX_POLLS) poll(progressId, count + 1);
      } catch (err) {
        setError(err.message);
      }
    }, POLL_MS);
  }

  async function runSuite(suite) {
    if (!(await askConfirm(atfRunAsk(suite.name, window.location.hostname)))) return;
    setError(null);
    setProgress({ name: suite.name, percent: 0, status: 'Starting' });
    try {
      const { progressId, status } = await services.runAtfSuite(suite.sysId);
      setProgress((p) => ({ ...p, status: status || 'Queued' }));
      if (progressId) poll(progressId);
    } catch (err) {
      setProgress(null);
      setError(err.message);
    }
  }

  const link = (id) => `/sys_atf_test.do?sys_id=${id}`;
  return (
    <div>
      <div className="msb-tk__subject">Which Automated Test Framework tests cover this table or Script Include, and how did they last go?</div>
      <div className="msb-tk__row">
        <input value={table} onChange={(e) => setTable(e.target.value.trim())} placeholder="table, e.g. incident" aria-label="Table" style={{ width: '9em' }} />
        <input value={name} onChange={(e) => setName(e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && find()} placeholder="Script Include name" aria-label="Script Include name" style={{ flex: 1 }} />
        <button className="msb-panel__run" onClick={find} disabled={busy || (!TABLE.test(table) && !name)}>
          {busy ? 'Looking...' : 'Find tests'}
        </button>
      </div>
      {error && <div className="msb-panel__error">{error}</div>}
      {progress && (
        <div className="msb-tk__notice" role="status">
          <strong>{progress.name}</strong>: {progress.status} {progress.percent ? `(${progress.percent}%)` : ''}
          {progress.message && <div className="msb-tk__muted">{progress.message}</div>}
        </div>
      )}
      {report && (
        <>
          <div className="msb-tk__row" aria-label="Summary">
            <Chip>{report.summary.tests} test{report.summary.tests === 1 ? '' : 's'}</Chip>
            {report.summary.passed > 0 && <Chip kind="pass">{report.summary.passed} passed last time</Chip>}
            {report.summary.failed > 0 && <Chip kind="fail">{report.summary.failed} failed last time</Chip>}
            {report.summary.neverRun > 0 && <Chip kind="warn">{report.summary.neverRun} never run</Chip>}
          </div>
          {!report.tests.length && <div className="msb-tk__notice msb-tk__notice--warn">{NO_ATF_NOTE}</div>}
          {report.suites.length > 0 && (
            <div className="msb-tk__section">
              <h4>Suites that hold them</h4>
              <ul className="msb-tk__list">
                {report.suites.map((s) => (
                  <li key={s.sysId} className="msb-tk__item">
                    <div className="msb-tk__item-head">
                      <strong>{s.name}</strong>
                      {s.last && <Chip kind={KIND_CHIP[s.last.kind]}>{`${KIND_LABEL[s.last.kind]}: ${s.last.passed} ok, ${s.last.failed} failed`}</Chip>}
                      <button className="msb-panel__secondary" onClick={trusted(() => runSuite(s))} disabled={Boolean(progress && progress.percent < 100)}>
                        Run suite...
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {report.tests.length > 0 && (
            <div className="msb-tk__section">
              <h4>Tests</h4>
              <ul className="msb-tk__list">
                {report.tests.map((t) => (
                  <li key={t.sysId} className="msb-tk__item">
                    <div className="msb-tk__item-head">
                      <a className="msb-panel__link" href={link(t.sysId)} target="_blank" rel="noopener noreferrer">
                        {t.name}
                      </a>
                      <Chip kind={KIND_CHIP[t.last?.kind || 'unknown']}>{KIND_LABEL[t.last?.kind || 'unknown']}</Chip>
                      {!t.active && <Chip kind="warn">inactive</Chip>}
                    </div>
                    <div className="msb-tk__muted">
                      Found by {t.matchedBy.join(', ')}
                      {t.last?.at ? ` · last run ${t.last.at}` : ''}
                      {t.last?.runTime ? ` · ${t.last.runTime}` : ''}
                    </div>
                    {t.last?.kind === 'fail' && t.last.output && <pre className="msb-tk__pre">{t.last.output}</pre>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="msb-tk__muted">Matches are by name, description and step inputs; a test that reaches it through another test or a flow will not appear.</div>
        </>
      )}
    </div>
  );
}

// --- Snapshots ---------------------------------------------------------------------------------------------------------------

const when = (at) => new Date(at).toLocaleString();

function RecordDiff({ result }) {
  const { diff } = result;
  const real = diff.changes.filter((c) => !c.system);
  const system = diff.changes.filter((c) => c.system);
  return (
    <div className="msb-tk__section">
      <div className={`msb-tk__summary${real.length ? '' : ' msb-tk__summary--dry'}`} role="status">
        {real.length ? `${real.length} field${real.length === 1 ? '' : 's'} changed since "${result.name}"` : `Nothing changed since "${result.name}"`}
        {diff.added.length || diff.removed.length ? ` (${diff.added.length} added, ${diff.removed.length} removed columns)` : ''}.
      </div>
      {diff.changes.length > 0 && (
        <table className="msb-tk__table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Before</th>
              <th>Now</th>
            </tr>
          </thead>
          <tbody>
            {[...real, ...system].map((c) => (
              <tr key={c.field}>
                <td>
                  {c.field}
                  {c.system && <span className="msb-tk__muted"> (system)</span>}
                </td>
                <td className="msb-tk__from">{String(c.before).slice(0, 300) || '(empty)'}</td>
                <td>{String(c.after).slice(0, 300) || '(empty)'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {diff.changes.length > 0 && (
        <div className="msb-tk__row">
          <button className="msb-panel__secondary" onClick={() => copy(diffToMarkdown(diff, { table: result.table, beforeName: result.name, afterName: 'now' }))}>
            Copy as Markdown
          </button>
        </div>
      )}
    </div>
  );
}

function ListDiff({ result }) {
  const { diff } = result;
  const none = !diff.added.length && !diff.removed.length && !diff.changed.length;
  return (
    <div className="msb-tk__section">
      <div className="msb-tk__summary" role="status">
        {none ? `No row changed since "${result.name}"` : `${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed since "${result.name}"`} ({diff.same} unchanged).
        {result.capped && ' Only the first 500 rows were compared.'}
      </div>
      {[
        ['Added', diff.added, 'pass'],
        ['Removed', diff.removed, 'fail'],
        ['Changed', diff.changed, 'warn'],
      ].map(
        ([title, rows, kind]) =>
          rows.length > 0 && (
            <div key={title} className="msb-tk__section">
              <h4>
                {title} ({rows.length})
              </h4>
              <ul className="msb-tk__list">
                {rows.slice(0, 50).map((r) => (
                  <li key={r.id} className="msb-tk__item">
                    <Chip kind={kind}>{title}</Chip> {r.label}
                    {r.fields?.length ? <span className="msb-tk__muted"> · {r.fields.join(', ')}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )
      )}
    </div>
  );
}

/** Take a snapshot of the record (or the rows of the list) on screen, do something, then compare. */
export function SnapshotsTab({ context, services }) {
  const table = context?.table || '';
  const isRecord = SYS_ID.test(context?.sysId || '') && TABLE.test(table);
  const isList = !isRecord && Boolean(context?.isList) && TABLE.test(table);
  const [name, setName] = useState('');
  const [items, setItems] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [listInfo, setListInfo] = useState(null);

  async function load() {
    try {
      setItems(await services.testSnapshotList({ table, sysId: isRecord ? context.sysId : '' }));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    if (isRecord || isList) load();
    if (isList) services.detectListInfo?.().then(setListInfo).catch(() => {});
    // Once, when the tab opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(task, after) {
    setBusy(true);
    setError(null);
    try {
      await task();
      after?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const take = () =>
    act(
      async () => {
        const made = isRecord
          ? await services.testSnapshotTake({ table, sysId: context.sysId, name })
          : await services.testSnapshotTakeList({ table, query: listInfo?.query || '', name });
        setNotice(`Saved "${made.name}" (${made.count} ${isRecord ? 'fields' : 'rows'}${made.capped ? ', first 500 only' : ''}). Do something, then compare.`);
        setName('');
        await load();
      },
      () => setResult(null)
    );

  const compare = (id) =>
    act(async () => {
      setResult(isRecord ? { type: 'record', ...(await services.testSnapshotCompare({ id })) } : { type: 'list', ...(await services.testSnapshotCompareList({ id })) });
    });

  if (!isRecord && !isList) {
    return <div className="msb-tk__notice">Open a saved record (to snapshot its fields) or a list (to snapshot its rows).</div>;
  }
  return (
    <div>
      <div className="msb-tk__subject">
        {isRecord ? (
          <>
            Snapshot this <strong>{table}</strong> record, change something (run a script, move the state, trigger a flow), then compare field by field.
          </>
        ) : (
          <>
            Snapshot the rows of this <strong>{table}</strong> list{listInfo?.query ? ' (with its filter)' : ''}, then see which rows were added, removed or changed.
          </>
        )}
      </div>
      <div className="msb-tk__row">
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && take()} placeholder="name, e.g. before" aria-label="Snapshot name" style={{ flex: 1 }} />
        <button className="msb-panel__run" onClick={trusted(take)} disabled={busy}>
          {busy ? 'Working...' : isRecord ? 'Take snapshot' : 'Snapshot the list'}
        </button>
      </div>
      {error && <div className="msb-panel__error">{error}</div>}
      {notice && <div className="msb-tk__notice">{notice}</div>}
      {items && !items.length && <div className="msb-panel__empty">No snapshots of this {isRecord ? 'record' : 'table'} yet. They are kept in this browser, 20 per instance.</div>}
      {items && items.length > 0 && (
        <ul className="msb-tk__list" style={{ marginTop: 8 }}>
          {items.map((s) => (
            <li key={s.id} className="msb-tk__item">
              <div className="msb-tk__item-head">
                <strong>{s.name}</strong>
                <span className="msb-tk__muted">
                  {when(s.at)} · {s.count} {s.kind === 'list' ? 'rows' : 'fields'}
                </span>
              </div>
              <div className="msb-tk__row">
                <button className="msb-panel__secondary" onClick={() => compare(s.id)} disabled={busy}>
                  Compare with now
                </button>
                <button
                  className="msb-panel__secondary"
                  onClick={trusted(async () => {
                    await services.testSnapshotRemove(s.id);
                    setResult(null);
                    load();
                  })}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {result?.type === 'record' && <RecordDiff result={result} />}
      {result?.type === 'list' && <ListDiff result={result} />}
    </div>
  );
}

// --- Access matrix -----------------------------------------------------------------------------------------------------------

const CELL_TEXT = { allowed: 'Allowed', denied: 'Denied', unknown: 'Unknown' };
const CELL_KIND = { allowed: 'pass', denied: 'fail', unknown: 'warn' };

/** Who can read, write, create and delete this record or field, for up to five users side by side. */
export function AccessTab({ context, services }) {
  const table = context?.table || '';
  const sysId = SYS_ID.test(context?.sysId || '') ? context.sysId : '';
  const [field, setField] = useState('');
  const [fields, setFields] = useState([]);
  const [users, setUsers] = useState([]);
  const [term, setTerm] = useState('');
  const [found, setFound] = useState([]);
  const [operations, setOperations] = useState(['read', 'write']);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useRef(0);

  useEffect(() => {
    services.accessCurrentUser?.().then((me) => me && setUsers([{ user: me.sysId, label: `${me.name || me.userName} (you)` }])).catch(() => {});
    if (TABLE.test(table)) services.accessTableFields?.(table).then(setFields).catch(() => {});
    // Once, when the tab opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function search() {
    setError(null);
    try {
      setFound(await services.accessSearchUsers(term));
    } catch (err) {
      setError(err.message);
    }
  }

  function add(u) {
    if (users.length >= MATRIX_MAX_USERS || users.some((x) => x.user === u.sysId)) return;
    setUsers([...users, { user: u.sysId, label: u.name || u.userName }]);
    setFound([]);
    setTerm('');
  }

  async function check() {
    const id = (run.current += 1);
    setBusy(true);
    setError(null);
    setRows(users.map((u) => ({ ...u, cells: null })));
    const todo = [...users];
    const worker = async () => {
      for (let u = todo.shift(); u; u = todo.shift()) {
        // eslint-disable-next-line no-await-in-loop -- each user is a handful of requests.
        const row = await services.testAccessRow({ user: u.user, table, sysId, field: field.trim(), operations });
        if (id !== run.current) return;
        setRows((current) => current.map((r) => (r.user === u.user ? { ...r, cells: row.cells } : r)));
      }
    };
    try {
      await Promise.all([worker(), worker()]);
    } catch (err) {
      setError(err.message);
    } finally {
      if (id === run.current) setBusy(false);
    }
  }

  useEffect(() => () => void (run.current += 1), []);

  const toggleOp = (op) => setOperations((ops) => (ops.includes(op) ? ops.filter((o) => o !== op) : [...ops, op]));
  const done = rows.length > 0 && rows.every((r) => r.cells);
  const ordered = MATRIX_OPERATIONS.filter((o) => operations.includes(o));

  if (!TABLE.test(table)) return <div className="msb-tk__notice">Open a record or a list first: the check is for a table (and a record or field on it).</div>;
  return (
    <div>
      <div className="msb-tk__subject">
        Can these users {ordered.join(', ') || 'do anything with'} <strong>{table}</strong>
        {field ? `.${field}` : ''}
        {sysId ? ' on this record' : ''}? Checked from the ACL definitions, side by side.
      </div>
      <div className="msb-tk__row">
        <input value={field} onChange={(e) => setField(e.target.value.trim())} list="msb-tk-fields" placeholder="field (optional)" aria-label="Field" style={{ flex: 1 }} />
        <datalist id="msb-tk-fields">
          {fields.slice(0, 300).map((f) => (
            <option key={f.name} value={f.name}>
              {f.label}
            </option>
          ))}
        </datalist>
      </div>
      <div className="msb-tk__row" role="group" aria-label="Operations">
        {MATRIX_OPERATIONS.map((op) => (
          <label key={op} className="msb-tk__check">
            <input type="checkbox" checked={operations.includes(op)} onChange={() => toggleOp(op)} />
            {op}
          </label>
        ))}
      </div>
      <div className="msb-tk__section">
        <h4>
          Users ({users.length}/{MATRIX_MAX_USERS})
        </h4>
        <div className="msb-tk__row">
          {users.map((u) => (
            <span key={u.user} className="msb-tk__chip">
              {u.label}{' '}
              <button aria-label={`Remove ${u.label}`} onClick={() => setUsers(users.filter((x) => x.user !== u.user))} style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit' }}>
                {'✕'}
              </button>
            </span>
          ))}
        </div>
        <div className="msb-tk__row">
          <input value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="add a user: name, user name or e-mail" aria-label="Find a user" style={{ flex: 1 }} />
          <button className="msb-panel__secondary" onClick={search} disabled={term.trim().length < 2 || users.length >= MATRIX_MAX_USERS}>
            Find
          </button>
        </div>
        {found.length > 0 && (
          <ul className="msb-tk__pick">
            {found.map((u) => (
              <li key={u.sysId}>
                <label>
                  <input type="checkbox" checked={users.some((x) => x.user === u.sysId)} onChange={() => add(u)} />
                  <span>{u.name}</span>
                  <span className="msb-tk__muted">
                    {u.userName}
                    {u.active ? '' : ' (inactive)'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <div className="msb-panel__error">{error}</div>}
      <div className="msb-tk__row">
        <button className="msb-panel__run" onClick={trusted(check)} disabled={busy || !users.length || !ordered.length}>
          {busy ? 'Checking...' : 'Check access'}
        </button>
        {done && (
          <button className="msb-panel__secondary" onClick={() => copy(matrixToMarkdown({ table, sysId, field, operations: ordered, rows }))}>
            Copy as Markdown
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <>
          <table className="msb-tk__table">
            <thead>
              <tr>
                <th>User</th>
                {ordered.map((op) => (
                  <th key={op}>{op}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.user}>
                  <td>{r.label}</td>
                  {ordered.map((op) => {
                    const cell = r.cells?.[op];
                    return (
                      <td key={op}>
                        {cell ? (
                          <span title={cell.reason}>
                            <Chip kind={CELL_KIND[cell.status]}>{CELL_TEXT[cell.status]}</Chip>
                            {cell.blockedBy.length > 0 && <div className="msb-tk__muted">{cell.blockedBy.slice(0, 2).join(', ')}</div>}
                          </span>
                        ) : (
                          <span className="msb-tk__muted">checking...</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {rows
            .flatMap((r) => ordered.map((op) => ({ r, op, cell: r.cells?.[op] })))
            .filter((x) => x.cell && x.cell.status !== 'allowed')
            .map((x) => (
              <div key={`${x.r.user}:${x.op}`} className="msb-tk__notice msb-tk__notice--warn">
                <div>
                  <strong>
                    {x.r.label}: {x.op}
                  </strong>{' '}
                  {CELL_TEXT[x.cell.status].toLowerCase()}. {x.cell.reason}
                </div>
              </div>
            ))}
          <div className="msb-tk__muted">Unknown usually means an ACL script or condition that cannot be evaluated from here. For a definitive answer, impersonate the user and try it, or open the Access debugger for the full trace.</div>
        </>
      )}
    </div>
  );
}

// --- Checklist ----------------------------------------------------------------------------------------------------------------

const KINDS = [
  ['businessRule', 'Business rule'],
  ['clientScript', 'Client script'],
  ['scriptInclude', 'Script Include'],
  ['uiAction', 'UI action'],
  ['uiPolicy', 'UI policy'],
  ['acl', 'ACL'],
  ['flow', 'Flow'],
  ['scheduledJob', 'Scheduled job / fix script'],
  ['restApi', 'Scripted REST API'],
  ['record', 'Any record'],
];

/** What to test for this kind of record, as a list to tick off and copy. */
export function ChecklistTab({ kind: initial, target, context, onAskAi }) {
  const [kind, setKind] = useState(initial);
  const [done, setDone] = useState({});
  const list = buildChecklist(kind);
  const name = target?.name || '';
  return (
    <div>
      <label className="msb-tk__field">
        What are you testing?
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {list.sections.map((section) => (
        <div key={section.name} className="msb-tk__section">
          <h4>{section.name}</h4>
          <ul className="msb-tk__checklist">
            {section.items.map((item) => (
              <li key={item}>
                <label>
                  <input type="checkbox" checked={Boolean(done[`${kind}:${item}`])} onChange={(e) => setDone({ ...done, [`${kind}:${item}`]: e.target.checked })} />
                  <span>{item}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="msb-tk__row">
        <button className="msb-panel__secondary" onClick={() => copy(checklistToMarkdown(list, { name }))}>
          Copy as Markdown
        </button>
        {target?.script && onAskAi && (
          <button
            className="msb-panel__secondary"
            onClick={() =>
              onAskAi(
                `Test cases for ${name || 'this script'}`,
                `Write concrete test cases (inputs, expected result, how to run each) for this ServiceNow ${list.title.toLowerCase()}, covering the checklist below. Use the ServiceNow test tools I have: dry run against a record, unit tests, ATF.\n\nChecklist:\n${checklistToMarkdown(list, { name })}\n\nScript:\n${target.script.slice(0, 8000)}`
              )
            }
          >
            Ask AI for concrete test cases
          </button>
        )}
      </div>
    </div>
  );
}
