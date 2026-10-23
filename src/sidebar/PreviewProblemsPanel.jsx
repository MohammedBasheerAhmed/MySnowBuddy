import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  SYS_ID_RE,
  SET_TABLE,
  STATUS_TEXT,
  STATUS_EFFECT,
  KINDS,
  isOpen,
  isSysId,
  recordPath,
  listPath,
  previewProblemsMarkdown,
} from '../lib/previewProblems.js';
import { timeAgo } from '../lib/updateSetReview.js';
import { copyText } from '../content/quickActions.js';

const errorText = (err) => err?.message || String(err);

/** Today as YYYY-MM-DD in the viewer's own time zone. */
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const LEVEL_TONE = { ready: 'ok', blocked: 'danger', notpreviewed: 'warn', running: 'warn', committed: 'muted', unreadable: 'danger' };
const STATUS_TONE = { unresolved: 'danger', unknown: 'warn', skipped: 'muted', ignored: 'muted', accepted: 'ok', resolved: 'ok' };
const SKIP_TEXT = { safe: 'Skipping loses nothing', depends: 'Skip only after a check', risky: 'Skipping probably breaks something' };
const SKIP_TONE = { safe: 'ok', depends: 'warn', risky: 'danger' };
const STATE_TONE = { previewed: 'ok', committed: 'muted', loaded: 'warn', previewing: 'warn', committing: 'warn', other: 'muted' };

function Link({ href, children }) {
  if (!href) return null;
  return (
    <a className="msb-panel__link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function Tag({ tone = 'muted', children, title }) {
  return (
    <span className={`msb-pf__tag msb-pf__tag--${tone}`} title={title}>
      {children}
    </span>
  );
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** [{ kind, items }] in the order the kinds first appear (the analysis already sorts by kind). */
function groupByKind(problems) {
  const groups = [];
  problems.forEach((p) => {
    const last = groups[groups.length - 1];
    if (last && last.kind === p.kind) last.items.push(p);
    else groups.push({ kind: p.kind, items: [p] });
  });
  return groups;
}

function askPrompt(p) {
  return [
    'A ServiceNow update set preview reported this problem on a retrieved update set, and I do not recognise the type.',
    '',
    `Problem text from the instance: "${p.description || '(empty)'}"`,
    p.typeLabel ? `Type column: ${p.typeLabel}` : '',
    p.update?.name ? `Update: ${p.update.name}${p.update.type ? ` (${p.update.type})` : ''}` : '',
    '',
    'What does it mean, what usually causes it, and what is the safest way to resolve it: Accept remote update, Skip remote update, or something to do first?',
  ]
    .filter((line, i, all) => line || all[i - 1])
    .join('\n');
}

function ProblemCard({ problem: p, expanded, onToggle, cardRef, onAskAi }) {
  const open = isOpen(p.status);
  const info = KINDS[p.kind] || KINDS.generic;
  const what = p.update?.target || p.update?.name || '';
  return (
    <li className={`msb-pf__card${open ? '' : ' msb-pf__card--closed'}`} ref={cardRef} tabIndex={-1} aria-label={`${info.label}${what ? `: ${what}` : ''}`}>
      <div className="msb-pf__card-head">
        <Tag tone={STATUS_TONE[p.status] || 'muted'}>{STATUS_TEXT[p.status] || p.status}</Tag>
        {p.severity && <Tag tone={p.severity === 'error' ? 'danger' : p.severity === 'warning' ? 'warn' : 'muted'}>{p.severity === 'error' ? 'Error' : p.severity === 'warning' ? 'Warning' : 'Info'}</Tag>}
        <strong className="msb-pf__card-title">{what || info.label}</strong>
        {p.update?.type && <span className="msb-pf__muted">{p.update.type}</span>}
      </div>

      {p.description ? (
        <blockquote className="msb-pf__said" aria-label="What the instance says">
          {p.description}
        </blockquote>
      ) : (
        <div className="msb-pf__muted">The instance gave no description for this problem{p.typeLabel ? ` (type: ${p.typeLabel})` : ''}.</div>
      )}

      <p className="msb-pf__meaning">{open ? p.explain.meaning : STATUS_EFFECT[p.status] || p.explain.meaning}</p>
      {p.missingText && <p className="msb-pf__meaning">{p.missingText}</p>}

      {p.providerNote && (
        <p className={`msb-pf__provider${p.providers.some((x) => !x.own && x.strength !== 'probable') ? ' msb-pf__provider--found' : ''}`}>
          <strong>{p.providers.some((x) => !x.own && x.strength !== 'probable') ? 'Provider found. ' : p.providers.some((x) => !x.own) ? 'Possible provider. ' : 'Provider. '}</strong>
          {p.providerNote}
          {p.providers
            .filter((x) => !x.own)
            .map((x) => (
              <span key={x.setId}>
                {' '}
                <Link href={recordPath(SET_TABLE, x.setId)}>Open "{x.setName}"</Link>
                {x.strength === 'probable' ? ' (probable match: it adds columns of that table)' : ''}
              </span>
            ))}
        </p>
      )}

      {p.collision && p.collision.lines.length > 0 && (
        <div className="msb-pf__collision">
          <strong>Local copy against the remote update</strong>
          <ul>
            {p.collision.lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {open && (
        <p className="msb-pf__next">
          <strong>Next step. </strong>
          {p.next}
        </p>
      )}

      <details className="msb-pf__more" open={expanded} onToggle={(e) => onToggle(p.id, e.currentTarget.open)}>
        <summary>Why it happens and the safe way out</summary>
        <dl className="msb-pf__facts">
          <dt>Why it happens</dt>
          <dd>{p.explain.why}</dd>
          <dt>Safe way out</dt>
          <dd>{p.explain.wayOut}</dd>
          <dt>Check first</dt>
          <dd>{p.explain.checkFirst}</dd>
          <dt>The buttons</dt>
          <dd>{p.explain.action}</dd>
        </dl>
        <Tag tone={SKIP_TONE[p.explain.skipSafety]}>{SKIP_TEXT[p.explain.skipSafety]}</Tag>
        {p.kind === 'generic' && onAskAi && (
          <button type="button" className="msb-panel__secondary msb-pf__ask" onClick={() => onAskAi('Explain preview problem', askPrompt(p))}>
            Ask the assistant about this
          </button>
        )}
      </details>

      <div className="msb-pf__links">
        <Link href={p.links.problem}>Problem record (Accept / Skip are there)</Link>
        <Link href={p.links.update}>Remote update</Link>
        <Link href={p.links.missingUpdate}>Update that provides it (named by the instance)</Link>
        <Link href={p.links.record}>Local record</Link>
        <Link href={p.links.versions}>Local versions (compare there)</Link>
      </div>
    </li>
  );
}

function SetPicker({ services, initialFilter, onPick, onClose, bannerNote }) {
  const [state, setState] = useState({ loading: true, sets: [], note: '', error: '' });
  const [filter, setFilter] = useState(initialFilter || '');
  const [order, setOrder] = useState(null);
  const [orderBusy, setOrderBusy] = useState(null);
  const run = useRef(0);

  async function load() {
    const mine = (run.current += 1);
    setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      const result = await services.previewProblemSets({ limit: 100 });
      if (mine === run.current) setState({ loading: false, sets: result.sets, note: result.note, error: '' });
    } catch (err) {
      if (mine === run.current) setState({ loading: false, sets: [], note: '', error: errorText(err) });
    }
  }

  useEffect(() => {
    load();
    return () => {
      run.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function workOutOrder() {
    setOrder(null);
    setOrderBusy({ done: 0, total: 0 });
    try {
      const result = await services.previewProblemOrder({ onProgress: (p) => setOrderBusy(p) });
      setOrder({ result });
    } catch (err) {
      setOrder({ error: errorText(err) });
    } finally {
      setOrderBusy(null);
    }
  }

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? state.sets.filter((s) => `${s.name} ${s.application}`.toLowerCase().includes(q)) : state.sets;
  }, [state.sets, filter]);
  const pendingWithProblems = state.sets.filter((s) => s.stateKind !== 'committed' && (s.problemCount || 0) > 0).length;

  return (
    <div className="msb-panel msb-pf">
      <div className="msb-panel__header">
        <strong>Update set preview problems</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>
      <p className="msb-pf__lead">Pick a retrieved update set to see why it will not commit, in plain words, with the safe way out for each problem.</p>
      {bannerNote && <div className="msb-panel__warning">{bannerNote}</div>}
      {state.error && <div className="msb-panel__error">{state.error}</div>}
      {state.note && <div className="msb-panel__warning">{state.note}</div>}

      <div className="msb-panel__form">
        <label>
          Filter by name
          <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Part of the update set name" />
        </label>
      </div>

      {state.loading && <div className="msb-pf__busy" aria-live="polite">Reading the retrieved update sets…</div>}
      {!state.loading && !state.error && state.sets.length === 0 && (
        <div className="msb-panel__empty">
          There are no retrieved update sets on this instance. Retrieve one under System Update Sets, then preview it.{' '}
          <Link href="/sys_remote_update_set_list.do">Open Retrieved Update Sets</Link>
        </div>
      )}
      {!state.loading && state.sets.length > 0 && shown.length === 0 && <div className="msb-panel__empty">No retrieved update set matches "{filter}".</div>}

      <ul className="msb-pf__sets">
        {shown.map((s) => (
          <li key={s.sysId}>
            <button type="button" className="msb-pf__set" onClick={() => onPick(s.sysId)}>
              <span className="msb-pf__set-name">{s.name}</span>
              <span className="msb-pf__set-meta">
                <Tag tone={STATE_TONE[s.stateKind] || 'muted'}>{s.stateLabel || 'Unknown state'}</Tag>
                {s.problemCount === null ? <span className="msb-pf__muted">problems not counted</span> : s.problemCount === 0 ? <span className="msb-pf__muted">{s.stateKind === 'loaded' ? 'not previewed yet' : 'no problems recorded'}</span> : <strong>{plural(s.problemCount, 'problem')} recorded</strong>}
                {s.application && <span className="msb-pf__muted">{s.application}</span>}
                {s.updatedOn && <span className="msb-pf__muted">{timeAgo(s.updatedOn)}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {!state.loading && pendingWithProblems > 1 && (
        <div className="msb-pf__order">
          <h3 className="msb-pf__h3">Commit order for all pending sets</h3>
          <p className="msb-pf__muted">Searches each set that has problems for the sets that create what it is missing.</p>
          <button type="button" className="msb-panel__secondary" onClick={workOutOrder} disabled={Boolean(orderBusy)}>
            {orderBusy ? `Checking ${orderBusy.done} of ${orderBusy.total || '…'}` : 'Work out the commit order'}
          </button>
          {order?.error && <div className="msb-panel__error">{order.error}</div>}
          {order?.result &&
            (order.result.chain.length ? (
              <>
                <ol className="msb-pf__chain">
                  {order.result.chain.map((c) => (
                    <li key={c.setId}>
                      <Link href={recordPath(SET_TABLE, c.setId)}>{c.name}</Link> {c.state && <Tag tone="muted">{c.state}</Tag>}
                    </li>
                  ))}
                </ol>
                <div className="msb-panel__hint">Only sets that depend on each other are listed; the others can be committed in any order.</div>
              </>
            ) : (
              <div className="msb-panel__empty">No set was found that creates what another one is missing, so no order is needed.</div>
            ))}
          {order?.result?.cycles?.length > 0 && <div className="msb-panel__warning">These depend on each other and need a decision from the authors: {order.result.cycles[0].join(', ')}.</div>}
          {order?.result?.note && <div className="msb-panel__hint">{order.result.note}</div>}
        </div>
      )}

      <div className="msb-panel__actions">
        <button type="button" className="msb-panel__secondary" onClick={load} disabled={state.loading}>
          Refresh
        </button>
        <Link href="/sys_remote_update_set_list.do">Retrieved Update Sets list</Link>
      </div>
    </div>
  );
}

function SetView({ services, setId, focusProblem, onBack, onClose, onAskAi }) {
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [showClosed, setShowClosed] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const run = useRef(0);
  const cards = useRef({});

  async function load() {
    const mine = (run.current += 1);
    setBusy(true);
    setError(null);
    setPhase('Reading the update set');
    try {
      const result = await services.previewProblemLoad({ setId, isCancelled: () => mine !== run.current, onProgress: (p) => mine === run.current && setPhase(p.phase) });
      if (mine === run.current && result) setAnalysis(result);
    } catch (err) {
      if (mine === run.current) setError(errorText(err));
    } finally {
      if (mine === run.current) {
        setBusy(false);
        setPhase('');
      }
    }
  }

  useEffect(() => {
    load();
    return () => {
      run.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setId]);

  useEffect(() => {
    if (!analysis || !focusProblem) return;
    const target = analysis.problems.find((p) => p.id === focusProblem);
    if (target && !isOpen(target.status)) setShowClosed(true);
    setExpanded((prev) => new Set(prev).add(focusProblem));
    setTimeout(() => cards.current[focusProblem]?.scrollIntoView?.({ block: 'start' }), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis?.set?.sysId]);

  function toggle(id, isOpenNow) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isOpenNow) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function jumpTo(id) {
    setExpanded((prev) => new Set(prev).add(id));
    const el = cards.current[id];
    if (el) {
      el.scrollIntoView?.({ block: 'start' });
      el.focus?.({ preventScroll: true });
    }
  }

  async function copyReport() {
    try {
      const md = previewProblemsMarkdown(analysis, { base: window.location.origin, host: window.location.host, today: localDate() });
      await copyText(md);
      setNotice('Copied the report as Markdown');
      setTimeout(() => setNotice(null), 2500);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const a = analysis;
  const open = a ? a.problems.filter((p) => isOpen(p.status)) : [];
  const closed = a ? a.problems.filter((p) => !isOpen(p.status)) : [];

  return (
    <div className="msb-panel msb-pf">
      <div className="msb-panel__header">
        <strong>Update set preview problems</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className="msb-pf__crumbs">
        <button type="button" className="msb-panel__link" onClick={onBack}>
          All retrieved update sets
        </button>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}
      {notice && <div className="msb-panel__hint" role="status">{notice}</div>}
      {busy && (
        <div className="msb-pf__busy" aria-live="polite">
          {phase || 'Reading'}…
        </div>
      )}

      {a && !busy && (
        <>
          <div className="msb-pf__subject">
            <strong className="msb-pf__set-title">{a.set.name}</strong>
            <Tag tone={STATE_TONE[a.stateKind] || 'muted'}>{a.set.stateLabel || 'Unknown state'}</Tag>
            <Link href={recordPath(SET_TABLE, a.set.sysId)}>Open the retrieved update set</Link>
          </div>
          {a.set.parentId && (
            <div className="msb-panel__hint">
              Part of the update set batch <Link href={recordPath(SET_TABLE, a.set.parentId)}>{a.set.parentName || a.set.parentId}</Link>. A batch is normally previewed and committed as a whole, from its top set.
            </div>
          )}

          <div className={`msb-pf__verdict msb-pf__verdict--${LEVEL_TONE[a.verdict.level] || 'muted'}`} role="status">
            <div className="msb-pf__verdict-head">{a.verdict.headline}</div>
            <div>{a.verdict.detail}</div>
            {a.counts.total > 0 && (
              <div className="msb-pf__counts">
                <span>{plural(a.counts.open, 'unresolved problem')}</span>
                {['skipped', 'ignored', 'accepted', 'resolved'].map((k) => (a.counts.byStatus[k] ? <span key={k}>{a.counts.byStatus[k]} {STATUS_TEXT[k].toLowerCase()}</span> : null))}
              </div>
            )}
          </div>

          {a.verdict.level !== 'unreadable' && (
            <>
          <h3 className="msb-pf__h3">Checklist</h3>
          <ul className="msb-pf__check">
            {a.checklist.map((item, i) => (
              <li key={i} className={`msb-pf__check-item msb-pf__check-item--${item.state}`}>
                <Tag tone={item.state === 'done' ? 'ok' : 'danger'}>{item.state === 'done' ? 'Done' : 'To do'}</Tag>
                <span>
                  {item.problemId ? (
                    <button type="button" className="msb-panel__link" onClick={() => jumpTo(item.problemId)}>
                      {item.title}
                    </button>
                  ) : (
                    <strong>{item.title}</strong>
                  )}
                  {item.text && <span className="msb-pf__check-text"> {item.text}</span>}
                </span>
              </li>
            ))}
          </ul>
            </>
          )}

          {a.order.chain.length > 1 && (
            <>
              <h3 className="msb-pf__h3">Commit order</h3>
              <ol className="msb-pf__chain">
                {a.order.chain.map((c) => (
                  <li key={c.setId}>
                    <Link href={recordPath(SET_TABLE, c.setId)}>{c.name}</Link> {c.focus && <Tag tone="ok">this update set</Tag>}
                  </li>
                ))}
              </ol>
              <div className="msb-panel__hint">A set that creates what another one needs goes first. After each commit, press Preview Update Set on the next one again.</div>
            </>
          )}
          {a.order.cycles.length > 0 && <div className="msb-panel__warning">These depend on each other and need a decision from the authors: {a.order.cycles[0].join(', ')}.</div>}

          {open.length > 0 && (
            <>
              <h3 className="msb-pf__h3">
                To resolve <span className="msb-panel__badge">{open.length}</span>
              </h3>
              {groupByKind(open).map(({ kind, items }) => {
                const info = KINDS[kind] || KINDS.generic;
                const total = a.counts.byKind[kind]?.total || items.length;
                return (
                  <section key={kind} className="msb-pf__group" aria-label={info.label}>
                    <h4 className="msb-pf__h4">
                      {info.label}
                      <span className="msb-pf__muted">
                        {' '}
                        {items.length} unresolved{total > items.length ? `, ${total - items.length} already dealt with` : ''}
                      </span>
                    </h4>
                    <div className="msb-pf__muted">{info.short}</div>
                    <ul className="msb-pf__cards">
                      {items.map((p) => (
                        <ProblemCard key={p.id} problem={p} expanded={expanded.has(p.id)} onToggle={toggle} cardRef={(el) => (cards.current[p.id] = el)} onAskAi={onAskAi} />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </>
          )}

          {closed.length > 0 && (
            <>
              <h3 className="msb-pf__h3">
                Already dealt with <span className="msb-panel__badge">{closed.length}</span>
              </h3>
              <button type="button" className="msb-panel__secondary" aria-expanded={showClosed} onClick={() => setShowClosed((v) => !v)}>
                {showClosed ? 'Hide them' : `Show ${plural(closed.length, 'problem')}`}
              </button>
              {showClosed && (
                <ul className="msb-pf__cards">
                  {closed.map((p) => (
                    <ProblemCard key={p.id} problem={p} expanded={expanded.has(p.id)} onToggle={toggle} cardRef={(el) => (cards.current[p.id] = el)} onAskAi={onAskAi} />
                  ))}
                </ul>
              )}
            </>
          )}

          {a.limits.length > 0 && (
            <div className="msb-panel__warning">
              <strong>Not checked or incomplete</strong>
              <ul className="msb-pf__limits">
                {a.limits.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          )}

          <details className="msb-pf__how">
            <summary>How this was read</summary>
            <p className="msb-panel__hint">
              The columns of the problem table are looked up in the dictionary, not assumed. Used:{' '}
              {a.columns ? Object.entries(a.columns.found).filter(([, v]) => v).map(([k, v]) => `${k} = ${v}`).join(', ') || 'none found' : 'not determined'}.
              {a.columns?.missing?.length ? ` Not found: ${a.columns.missing.join(', ')}.` : ''} Explanations come from the wording of each problem, so a type NowBuddy has not seen shows the instance's own text with a generic explanation. The platform's Accept and Skip buttons are on the problem record; this panel never presses them.
            </p>
            <Link href={a.columns?.found?.set ? listPath('sys_update_preview_problem', `${a.columns.found.set}=${a.set.sysId}`) : ''}>Open the problem list for this set</Link>
          </details>

          <div className="msb-panel__actions">
            {a.verdict.level !== 'unreadable' && (
              <button type="button" className="msb-panel__secondary" onClick={copyReport}>
                Copy as Markdown
              </button>
            )}
            <button type="button" className="msb-panel__secondary" onClick={load} disabled={busy}>
              Refresh
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A retrieved update set that will not commit: each preview problem in plain words, which other retrieved set creates
 * what is missing, how a colliding local record compares, the verdict and a commit order. Read-only.
 * Opens on the retrieved update set (or a problem) on screen, on a name given as `/preview <name>`, else on a picker.
 */
export default function PreviewProblemsPanel({ context, params, services, onClose, onAskAi }) {
  const args = String(params?.args || '').trim();
  const [view, setView] = useState({ kind: 'start' });

  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        if (args) {
          if (isSysId(args)) return !cancelled && setView({ kind: 'set', setId: args });
          const { sets } = await services.previewProblemSets({ search: args, limit: 20 });
          if (cancelled) return undefined;
          const exact = sets.filter((s) => s.name.toLowerCase() === args.toLowerCase());
          const pick = exact.length === 1 ? exact[0] : sets.length === 1 ? sets[0] : null;
          if (pick) return setView({ kind: 'set', setId: pick.sysId });
          return setView({ kind: 'pick', filter: sets.length ? args : '', banner: sets.length ? '' : `No retrieved update set has "${args}" in its name. All of them are listed.` });
        }
        if (context?.table === 'sys_remote_update_set' && SYS_ID_RE.test(context.sysId || '')) return setView({ kind: 'set', setId: context.sysId });
        if (context?.table === 'sys_update_preview_problem' && SYS_ID_RE.test(context.sysId || '')) {
          const setId = await services.previewProblemSetOfProblem(context.sysId);
          if (cancelled) return undefined;
          if (setId) return setView({ kind: 'set', setId, focusProblem: context.sysId });
          return setView({ kind: 'pick', filter: '', banner: 'The update set of this problem could not be found.' });
        }
      } catch (err) {
        if (!cancelled) return setView({ kind: 'pick', filter: '', banner: errorText(err) });
      }
      return !cancelled && setView({ kind: 'pick', filter: '', banner: '' });
    }
    start();
    return () => {
      cancelled = true;
    };
    // The panel is re-keyed when the arguments change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (view.kind === 'start') {
    return (
      <div className="msb-panel msb-pf">
        <div className="msb-panel__header">
          <strong>Update set preview problems</strong>
          <button onClick={onClose} aria-label="Close">
            {'✕'}
          </button>
        </div>
        <div className="msb-pf__busy" aria-live="polite">
          Looking for the retrieved update set…
        </div>
      </div>
    );
  }
  if (view.kind === 'set') {
    return <SetView key={view.setId} services={services} setId={view.setId} focusProblem={view.focusProblem} onBack={() => setView({ kind: 'pick', filter: '', banner: '' })} onClose={onClose} onAskAi={onAskAi} />;
  }
  return <SetPicker services={services} initialFilter={view.filter} bannerNote={view.banner} onPick={(setId) => setView({ kind: 'set', setId })} onClose={onClose} />;
}
