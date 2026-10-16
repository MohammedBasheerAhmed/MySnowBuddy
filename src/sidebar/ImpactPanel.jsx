import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IMPACT_TABLES } from '../content/impact.js';
import {
  buildSignals,
  overallLevel,
  headline,
  describeChange,
  describeWhere,
  impactToMarkdown,
  buildImpactPrompt,
} from '../lib/impact.js';
import { downloadText, suggestFilename } from '../lib/report.js';

const SYS_ID = /^[0-9a-f]{32}$/i;
const LEVEL_TEXT = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' };

/** What to analyse: `/impact <ScriptInclude>` wins over the record on screen. */
function targetFrom(context, params) {
  const args = String(params?.args || '').trim();
  if (args) return { name: args };
  if (context?.table && IMPACT_TABLES.includes(context.table) && SYS_ID.test(context.sysId || '')) {
    return { table: context.table, sysId: context.sysId, context };
  }
  return null;
}

function Section({ title, count, open = false, children }) {
  return (
    <details className="msb-impact__section" open={open}>
      <summary className="msb-panel__result-toggle">
        <span className="msb-impact__section-title">{title}</span>
        {count !== undefined && count !== null && <span className="msb-panel__badge">{count}</span>}
      </summary>
      <div className="msb-impact__section-body">{children}</div>
    </details>
  );
}

function RecordLink({ href, children }) {
  if (!href) return <span>{children}</span>;
  return (
    <a className="msb-panel__link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function UsedBy({ usedBy }) {
  const n = usedBy.items.length;
  return (
    <Section title={usedBy.label} count={`${n}${usedBy.capped ? '+' : ''}`} open={n > 0 && n <= 15}>
      {n === 0 ? (
        <div className="msb-panel__empty">No other active script mentions "{usedBy.term}".</div>
      ) : (
        <ul className="msb-impact__list">
          {usedBy.items.map((u) => (
            <li key={`${u.table}:${u.sysId}`} className="msb-impact__item">
              <div className="msb-impact__item-head">
                <RecordLink href={u.link}>{u.name}</RecordLink>
                <span className="msb-impact__tag">{u.label}</span>
                {u.viaAjax && <span className="msb-impact__tag">GlideAjax</span>}
                {u.scopeHint && <span className="msb-impact__muted">{u.scopeHint}</span>}
              </div>
              {u.lines.length > 0 && (
                <pre className="msb-impact__code">
                  {u.lines
                    .slice(0, 3)
                    .map((l) => `${l.field}:${l.lineNumber}  ${l.text}`)
                    .join('\n')}
                  {u.lines.length > 3 ? `\n… ${u.lines.length - 3} more` : ''}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Alongside({ alongside }) {
  const others = alongside.items.filter((r) => !r.isSelf).length;
  return (
    <Section title={`Runs alongside: other "${alongside.when}" rules`} count={`${others}${alongside.capped ? '+' : ''}`} open={others > 0 && others <= 20}>
      <ol className="msb-impact__order">
        {alongside.items.map((r) => (
          <li key={r.sysId} className={r.isSelf ? 'msb-impact__self' : undefined}>
            <span className="msb-impact__order-num">{r.order}</span>
            <RecordLink href={r.link}>{r.isSelf ? `${r.name} (this rule)` : r.name}</RecordLink>
            <span className="msb-impact__tag">{r.table}</span>
            {r.ops.length > 0 && <span className="msb-impact__muted">{r.ops.join('/')}</span>}
          </li>
        ))}
      </ol>
      <div className="msb-panel__hint">Lower order runs first. Rules on parent tables ({alongside.tables.slice(1).join(', ') || 'none'}) run too.</div>
    </Section>
  );
}

function Changes({ changes }) {
  const count = changes.tables.length + changes.events.length;
  return (
    <Section title="What it changes" count={count} open>
      {count === 0 && <div className="msb-panel__empty">No table reads or writes found in the script.</div>}
      <ul className="msb-impact__list">
        {changes.tables.map((t) => (
          <li key={`${t.table}:${t.isCurrent}`} className="msb-impact__item">
            <div className="msb-impact__item-head">
              <strong>{t.table}</strong>
              {t.isCurrent && <span className="msb-impact__tag">this record</span>}
              {t.workflowOff && <span className="msb-impact__tag msb-impact__tag--warn">setWorkflow(false)</span>}
            </div>
            <div>{describeChange(t) || 'reads'}</div>
            <div className="msb-impact__muted">{describeWhere(t.where)}</div>
          </li>
        ))}
        {changes.events.map((e) => (
          <li key={`event:${e.name}`} className="msb-impact__item">
            <div className="msb-impact__item-head">
              Fires event <code>{e.name}</code>
            </div>
            <div className="msb-impact__muted">{describeWhere(e.where)}</div>
          </li>
        ))}
      </ul>
      {changes.dynamicTables.length > 0 && (
        <div className="msb-panel__hint">Table chosen at run time, not traced: {describeWhere(changes.dynamicTables)}.</div>
      )}
      {changes.dynamicEvents.length > 0 && (
        <div className="msb-panel__hint">Event name chosen at run time, not traced: {describeWhere(changes.dynamicEvents)}.</div>
      )}
    </Section>
  );
}

function Indirect({ indirect }) {
  return (
    <Section title="Through the Script Includes it calls" count={indirect.length} open={indirect.some((c) => c.tables.length || c.events.length)}>
      <ul className="msb-impact__list">
        {indirect.map((c) => (
          <li key={`${c.name}.${c.method}`} className="msb-impact__item">
            <div className="msb-impact__item-head">
              <RecordLink href={c.link}>
                {c.name}
                {c.method ? `.${c.method}()` : ''}
              </RecordLink>
              {c.via === 'GlideAjax' && <span className="msb-impact__tag">GlideAjax</span>}
            </div>
            {c.method && !c.found && <div className="msb-impact__muted">Method not found in the Script Include (inherited, or built at run time).</div>}
            {c.found && !c.tables.length && !c.events.length && <div className="msb-impact__muted">No table reads or writes found.</div>}
            {c.tables.map((t) => (
              <div key={`${t.table}:${t.isCurrent}`}>
                <strong>{t.table}</strong>
                {t.isCurrent ? ' (current record)' : ''}: {describeChange(t) || 'reads'}
              </div>
            ))}
            {c.events.map((e) => (
              <div key={e.name}>
                Fires event <code>{e.name}</code>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Downstream({ downstream }) {
  const n = downstream.items.length;
  return (
    <Section title="What runs as a result" count={`${n}${downstream.capped ? '+' : ''}`} open={n > 0 && n <= 20}>
      {n === 0 && (
        <div className="msb-panel__empty">
          {downstream.tables.length || downstream.events.length
            ? `Nothing active found on ${[...downstream.tables, ...downstream.events].join(', ')}.`
            : 'It writes no other records and fires no events, so nothing else is set off.'}
        </div>
      )}
      <ul className="msb-impact__list">
        {downstream.items.map((d) => (
          <li key={d.link} className="msb-impact__item">
            <div className="msb-impact__item-head">
              <span className="msb-impact__tag">{d.kind}</span>
              <RecordLink href={d.link}>{d.name}</RecordLink>
            </div>
            <div className="msb-impact__muted">
              {d.detail}
              {d.maySkip ? ' · may be skipped: setWorkflow(false)' : ''}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function UpdateSets({ updateSets }) {
  const others = updateSets.items.filter((u) => !u.mine).length;
  return (
    <Section title="Update sets with this record" count={updateSets.items.length} open={others > 0}>
      {!updateSets.items.length && <div className="msb-panel__empty">Not in any in-progress or completed update set.</div>}
      <ul className="msb-impact__list">
        {updateSets.items.map((u) => (
          <li key={u.setId} className="msb-impact__item">
            <div className="msb-impact__item-head">
              <RecordLink href={u.link}>{u.setName}</RecordLink>
              <span className={`msb-impact__tag${u.mine ? '' : ' msb-impact__tag--warn'}`}>{u.state}</span>
            </div>
            <div className="msb-impact__muted">
              Last changed by {u.updatedBy || '?'}
              {u.mine ? ' (you)' : ''} on {u.updatedOn || '?'}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Errors({ errors }) {
  return (
    <Section title="System log, last 7 days" count={`${errors.count}${errors.capped ? '+' : ''}`} open={errors.count > 0}>
      {!errors.count && <div className="msb-panel__empty">No warnings or errors mention it.</div>}
      <ul className="msb-impact__list">
        {errors.samples.map((e) => (
          <li key={e.link} className="msb-impact__item">
            <div className="msb-impact__item-head">
              <span className={`msb-impact__tag${e.level === 'error' ? ' msb-impact__tag--danger' : ' msb-impact__tag--warn'}`}>{e.level}</span>
              <span className="msb-impact__muted">{e.createdOn}</span>
              <RecordLink href={e.link}>Open</RecordLink>
            </div>
            <pre className="msb-impact__code">{String(e.message || '').slice(0, 400)}</pre>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * Change impact for the script record on screen (or a Script Include by name): who uses it, what it
 * changes, what runs as a result, other update sets holding it and recent errors, with a risk summary.
 * Data comes from services.impactReport (src/content/impact.js); read-only.
 */
export default function ImpactPanel({ context, params, services, onClose, onAskAi }) {
  const initial = useMemo(() => targetFrom(context, params), [context, params]);
  const [target, setTarget] = useState(initial);
  const [nameInput, setNameInput] = useState('');
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const runId = useRef(0);

  async function run(next) {
    if (!next) return;
    runId.current += 1;
    const id = runId.current;
    setTarget(next);
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const result = await services.impactReport(next);
      if (id === runId.current) setReport(result);
    } catch (err) {
      if (id === runId.current) setError(err.message);
    } finally {
      if (id === runId.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (initial) run(initial);
    return () => {
      runId.current += 1;
    };
    // Runs once per panel instance; the panel is re-keyed when its arguments change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signals = useMemo(() => (report ? buildSignals(report) : []), [report]);
  const level = overallLevel(signals);

  function checkByName() {
    const name = nameInput.trim();
    if (name) run({ name });
  }

  function handleExport() {
    if (report) downloadText(suggestFilename('impact'), impactToMarkdown(report));
  }

  const s = report?.subject;

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Change impact</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      {!report && !busy && (
        <div className="msb-panel__form">
          {!target && (
            <div className="msb-panel__hint">
              Open a script record (business rule, Script Include, client script, UI action, script action, scheduled
              job, Scripted REST resource, widget...), or enter a Script Include name.
            </div>
          )}
          <label>
            Script Include name
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') checkByName();
              }}
              placeholder="IncidentUtils"
            />
          </label>
          <button className="msb-panel__run" onClick={checkByName} disabled={!nameInput.trim()}>
            Check impact
          </button>
        </div>
      )}

      {busy && (
        <div className="msb-impact__busy" aria-live="polite">
          Checking who uses it, what it changes and what runs as a result...
        </div>
      )}

      {error && <div className="msb-panel__error">{error}</div>}

      {report && (
        <div className="msb-panel__results">
          <div className="msb-impact__subject">
            <div className="msb-impact__kind">{s.kind}</div>
            <RecordLink href={s.link}>
              <strong>{s.name}</strong>
            </RecordLink>
            {s.trigger && <div className="msb-panel__hint">{s.trigger}</div>}
            {s.usesUnsaved && <div className="msb-panel__hint">Includes your unsaved changes on the form.</div>}
          </div>

          <div className={`msb-impact__summary msb-impact__summary--${level}`}>
            <div className="msb-impact__summary-head">
              <span className={`msb-impact__level msb-impact__level--${level}`}>{LEVEL_TEXT[level]}</span>
              <span>{headline(report)}</span>
            </div>
            {signals.length > 0 ? (
              <ul className="msb-impact__signals">
                {signals.map((x) => (
                  <li key={x.text} className={`msb-impact__signal msb-impact__signal--${x.severity}`}>
                    {x.text}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="msb-panel__hint">Nothing stands out. Still test the records it touches.</div>
            )}
          </div>

          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={() => run(target)} disabled={busy}>
              Refresh
            </button>
            <button className="msb-panel__secondary" onClick={handleExport}>
              Export markdown
            </button>
            {onAskAi && (
              <button className="msb-panel__secondary" onClick={() => onAskAi('Change impact', buildImpactPrompt(report))}>
                Ask AI what to retest
              </button>
            )}
          </div>

          {report.usedBy?.applicable && <UsedBy usedBy={report.usedBy} />}
          {report.alongside && <Alongside alongside={report.alongside} />}
          <Changes changes={report.changes} />
          {report.indirect?.length > 0 && <Indirect indirect={report.indirect} />}
          {report.downstream && <Downstream downstream={report.downstream} />}
          {report.updateSets && <UpdateSets updateSets={report.updateSets} />}
          {report.errors && <Errors errors={report.errors} />}

          {(report.history || report.volume) && (
            <div className="msb-impact__facts">
              {report.history && (
                <div>
                  {report.history.count} saved version{report.history.count === 1 ? '' : 's'}
                  {report.history.latest[0] ? `, last by ${report.history.latest[0].by} on ${report.history.latest[0].recordedAt}` : ''}
                </div>
              )}
              {report.volume && (
                <div>
                  {report.volume.count.toLocaleString('en-US')} {report.volume.label}
                </div>
              )}
            </div>
          )}

          {report.notes.length > 0 && (
            <Section title="Not checked" count={report.notes.length}>
              <ul className="msb-impact__list">
                {report.notes.map((n) => (
                  <li key={n} className="msb-impact__item">
                    {n}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <div className="msb-panel__hint msb-impact__footnote">
            Found by reading script text: references built at run time (a table name in a variable, gr[field]) and
            scripts inside Flow Designer actions are not traced.
          </div>
        </div>
      )}
    </div>
  );
}
