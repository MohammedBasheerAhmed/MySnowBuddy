import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RULE_TYPES, RULE_TYPE_ORDER, OPERATIONS, ACL_OPERATIONS, explanationToMarkdown } from '../lib/ruleExplain.js';
import { trusted } from './trusted.js';

const MARKS = { pass: ['✓', 'passes'], fail: ['✗', 'stops it'], unknown: ['?', 'cannot tell'], info: ['i', 'note'] };
const GROUPS = [
  ['skip', "Won't run", 'These stop for a reason you can read below.'],
  ['unknown', 'Cannot tell', 'Part of the answer lives on the instance (a script, a dynamic filter, a related record).'],
  ['run', 'Would run', 'Everything that can be checked here passes.'],
];

function RuleLink({ href, children }) {
  if (!href) return <span>{children}</span>;
  return (
    <a className="msb-panel__link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function Checks({ checks }) {
  return (
    <ul className="msb-why__checks">
      {checks.map((c) => (
        <li key={`${c.id}:${c.detail}`} className={`msb-why__check msb-why__check--${c.status}`}>
          <span className="msb-why__mark" role="img" aria-label={MARKS[c.status][1]}>
            {MARKS[c.status][0]}
          </span>
          <span>{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function Row({ rule }) {
  return (
    <li className={`msb-why__row msb-why__row--${rule.outcome}`}>
      <div className="msb-why__head">
        <span className="msb-why__tag">{rule.typeLabel}</span>
        <RuleLink href={rule.href}>
          <strong>{rule.name}</strong>
        </RuleLink>
        {rule.when && (
          <span className="msb-why__muted">
            {rule.when}
            {rule.type === 'br' || rule.type === 'uip' ? `, order ${rule.order}` : ''}
          </span>
        )}
      </div>
      <div className="msb-why__headline">{rule.headline}</div>
      <details className="msb-why__more">
        <summary>Every check</summary>
        <Checks checks={rule.checks} />
      </details>
    </li>
  );
}

function Group({ id, title, hint, rules }) {
  if (!rules.length) return null;
  return (
    <details className={`msb-why__group msb-why__group--${id}`} open={rules.length <= 12 || id !== 'run'}>
      <summary className="msb-panel__result-toggle">
        <span className="msb-why__group-title">{title}</span>
        <span className="msb-panel__badge">{rules.length}</span>
      </summary>
      <div className="msb-why__group-body">
        <div className="msb-panel__hint">{hint}</div>
        <ul className="msb-why__list">
          {rules.map((rule) => (
            <Row key={`${rule.type}:${rule.sysId}:${rule.name}`} rule={rule} />
          ))}
        </ul>
      </div>
    </details>
  );
}

/**
 * "Why did / didn't my rule run?" for the record on screen: every business rule, client script, UI policy, data policy
 * and ACL that could apply, with the first thing that stops each one, in plain words. Read-only. Data comes from
 * services.ruleExplainReport (src/content/ruleExplain.js); the logic is src/lib/ruleExplain.js.
 */
export default function WhyRulePanel({ context, params, services, onClose, onAskAi }) {
  const [operation, setOperation] = useState('');
  const [aclOperation, setAclOperation] = useState('');
  const [types, setTypes] = useState(() => new Set(RULE_TYPE_ORDER));
  const [nameInput, setNameInput] = useState(() => String(params?.args || '').trim());
  const [byName, setByName] = useState(() => String(params?.args || '').trim());
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const runId = useRef(0);

  async function run(options = {}) {
    runId.current += 1;
    const id = runId.current;
    setBusy(true);
    setError(null);
    try {
      const result = await services.ruleExplainReport({
        context,
        operation: options.operation ?? (operation || undefined),
        aclOperation: options.aclOperation ?? (aclOperation || undefined),
        ruleName: options.ruleName ?? byName,
      });
      if (id !== runId.current) return;
      setReport(result);
      setOperation((current) => current || result.subject.operation);
      setAclOperation((current) => current || result.subject.aclOperation);
    } catch (err) {
      if (id === runId.current) setError(err.message);
    } finally {
      if (id === runId.current) setBusy(false);
    }
  }

  useEffect(() => {
    run();
    return () => {
      runId.current += 1;
    };
    // Runs once per panel instance; the panel is re-keyed when its arguments change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flash(text) {
    setNotice(text);
    setTimeout(() => setNotice(null), 2500);
  }

  const visible = useMemo(() => {
    if (!report) return null;
    const out = { run: [], skip: [], unknown: [] };
    report.results.filter((r) => types.has(r.type)).forEach((r) => out[r.outcome].push(r));
    return out;
  }, [report, types]);
  const shown = visible ? visible.run.length + visible.skip.length + visible.unknown.length : 0;

  const changeOperation = (value) => {
    setOperation(value);
    run({ operation: value });
  };
  const changeAclOperation = (value) => {
    setAclOperation(value);
    run({ aclOperation: value });
  };
  const toggleType = (type) =>
    setTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next.size ? next : new Set([type]);
    });

  function explainByName() {
    const name = nameInput.trim();
    setByName(name);
    run({ ruleName: name });
  }

  function clearName() {
    setNameInput('');
    setByName('');
    run({ ruleName: '' });
  }

  const markdown = report && visible ? explanationToMarkdown({ subject: report.subject, groups: visible }) : '';
  const copyReport = trusted(async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      flash('Copied the explanation.');
    } catch {
      flash('Copy was blocked by the browser.');
    }
  });

  const s = report?.subject;

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Why did (or didn&apos;t) my rule run?</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className="msb-panel__form">
        <div className="msb-panel__hint">
          Checks every business rule, client script, UI policy, data policy and ACL that could apply to the record on screen, using the values
          on the form (unsaved edits included).
        </div>
        <div className="msb-why__controls">
          <label>
            Saving it counts as
            <select value={operation} onChange={(e) => changeOperation(e.target.value)} disabled={busy || !report}>
              {OPERATIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
          <label>
            ACLs for
            <select value={aclOperation} onChange={(e) => changeAclOperation(e.target.value)} disabled={busy || !report}>
              {ACL_OPERATIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="msb-why__chips" role="group" aria-label="Show these kinds of rule">
          {RULE_TYPE_ORDER.map((type) => (
            <button key={type} type="button" className="msb-why__chip" aria-pressed={types.has(type)} onClick={() => toggleType(type)}>
              {RULE_TYPES[type].plural}
            </button>
          ))}
        </div>
        <label>
          Explain a rule by name
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') explainByName();
            }}
            placeholder="Set priority from impact"
          />
        </label>
        <div className="msb-panel__actions">
          <button className="msb-panel__run" onClick={explainByName} disabled={busy || !nameInput.trim()}>
            Explain this rule
          </button>
          {byName && (
            <button className="msb-panel__secondary" onClick={clearName} disabled={busy}>
              Show everything that applies
            </button>
          )}
        </div>
      </div>

      {busy && (
        <div className="msb-why__busy" aria-live="polite">
          Reading the rules and the record...
        </div>
      )}
      {error && <div className="msb-panel__error">{error}</div>}
      {notice && <div className="msb-panel__hint">{notice}</div>}

      {report && !error && (
        <div className="msb-panel__results">
          <div className="msb-why__subject">
            <strong>{s.table}</strong>
            <span className="msb-why__muted">
              {s.isNew ? 'new record' : 'saved record'} · {s.fieldCount} fields read
              {s.unsaved ? ' · includes your unsaved changes' : ''}
            </span>
            {byName ? (
              <div className="msb-panel__hint">Showing rules whose name contains &ldquo;{report.byName}&rdquo;, on any table.</div>
            ) : (
              <div className="msb-panel__hint">
                Includes rules on {s.chain.slice(1).length ? `the parent tables (${s.chain.slice(1).join(', ')})` : 'this table'}. You are{' '}
                {report.user.isAdmin ? 'an admin' : report.user.roles ? `holding ${report.user.roles.length} roles` : 'of unknown roles'}.
              </div>
            )}
          </div>

          <div className="msb-why__summary" aria-live="polite">
            <span className="msb-why__count msb-why__count--skip">{visible.skip.length} won&apos;t run</span>
            <span className="msb-why__count msb-why__count--unknown">{visible.unknown.length} cannot tell</span>
            <span className="msb-why__count msb-why__count--run">{visible.run.length} would run</span>
          </div>

          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={() => run()} disabled={busy}>
              Refresh from the form
            </button>
            <button className="msb-panel__secondary" onClick={copyReport} disabled={!shown}>
              Copy as text
            </button>
            {onAskAi && shown > 0 && (
              <button className="msb-panel__secondary" onClick={() => onAskAi('Why did or did not my rule run', `${markdown}\n\nExplain which of these matter for what I am trying to do and what to change.`)}>
                Ask AI
              </button>
            )}
          </div>

          {shown === 0 && <div className="msb-panel__empty">{byName ? 'No rule with that name was found.' : 'No rule of the chosen kinds applies to this table.'}</div>}
          {GROUPS.map(([id, title, hint]) => (
            <Group key={id} id={id} title={title} hint={hint} rules={visible[id]} />
          ))}

          {report.notes.length > 0 && (
            <details className="msb-why__group">
              <summary className="msb-panel__result-toggle">
                <span className="msb-why__group-title">Not checked</span>
                <span className="msb-panel__badge">{report.notes.length}</span>
              </summary>
              <ul className="msb-why__list">
                {report.notes.map((n) => (
                  <li key={n} className="msb-why__row">
                    {n}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="msb-panel__hint msb-why__footnote">
            Scripts are never run here: a condition script, a dynamic filter or a rule&apos;s own script shows as &ldquo;cannot tell&rdquo;. The
            full ACL verdict (every level together) is in the Access debugger. A script that saves with setWorkflow(false), or an import
            that skips rules, bypasses business rules entirely.
          </div>
        </div>
      )}
    </div>
  );
}
