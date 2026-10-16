import React, { useMemo, useState } from 'react';
import { diffLines, collapseDiff, hasChanges } from '../lib/diff.js';
import { describeCall } from '../lib/agent/policy.js';
import { DiffView } from './DiffView.jsx';
import Icon from './Icon.jsx';
import { trusted } from './trusted.js';

const STATUS_ICON = { running: null, awaiting: 'lock', ok: 'check', failed: 'alert', declined: 'ban' };
const STATUS_LABEL = { awaiting: 'Needs your approval', failed: 'Failed', declined: 'Declined' };

/** Field-level before/after (update) or the field list (create, delete) for a record write. */
function FieldTable({ diff, list }) {
  if (diff?.length) {
    return (
      <div className="msb-approve__diff">
        <div className="msb-approve__caption">Field changes</div>
        <table className="msb-approve__fields">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Now</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {diff.map((row) => (
              <tr key={row.field}>
                <th scope="row" title={row.field}>
                  {row.label || row.field}
                </th>
                <td className="msb-approve__before">
                  <div className="msb-approve__cell">{row.before || <i>empty</i>}</div>
                </td>
                <td className="msb-approve__after">
                  <div className="msb-approve__cell">{row.after || <i>empty</i>}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (list?.length) {
    return (
      <div className="msb-approve__diff">
        <div className="msb-approve__caption">Fields ({list.length})</div>
        <table className="msb-approve__fields">
          <tbody>
            {list.map((row) => (
              <tr key={row.field}>
                <th scope="row" title={row.field}>
                  {row.label || row.field}
                </th>
                <td>
                  <div className="msb-approve__cell">{row.value || <i>empty</i>}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

function Preview({ call, preview }) {
  // The card is built from the full arguments (step.args is clipped for the saved timeline): nothing approved is hidden.
  const args = call.fullArgs || call.args || {};
  const info = describeCall(call.tool, args);
  const code = preview?.after ?? info.code ?? '';
  const structured = Boolean(preview?.fieldDiff?.length || preview?.fieldList?.length);
  const rows = useMemo(() => {
    if (preview?.before === undefined || !code) return null;
    const d = diffLines(preview.before, code);
    return hasChanges(d) ? collapseDiff(d, 3) : [];
  }, [preview, code]);

  return (
    <div className="msb-approve__body">
      {preview?.target && <div className="msb-approve__target">{preview.target}</div>}
      <div className="msb-approve__risk">{info.risk}</div>
      {info.detail && !structured && <div className="msb-approve__detail">{info.detail}</div>}
      {structured && args.reason && <div className="msb-approve__detail">{args.reason}</div>}
      {preview?.blocked && (
        <div className="msb-approve__verify msb-approve__verify--bad" role="alert">
          <Icon name="ban" size={13} />
          This will be refused: {preview.blocked}
        </div>
      )}
      {(preview?.warnings || []).map((w) => (
        <div key={w} className="msb-approve__verify msb-approve__verify--warn">
          <Icon name="alert" size={13} />
          {w}
        </div>
      ))}
      {(preview?.notes || []).map((n) => (
        <div key={n} className="msb-approve__note">
          {n}
        </div>
      ))}
      <FieldTable diff={preview?.fieldDiff} list={preview?.fieldList} />
      {preview === undefined && (
        <div className="msb-approve__verify msb-approve__verify--warn" role="status">
          <span className="msb-spinner msb-spinner--sm" /> Checking this change against the instance...
        </div>
      )}
      {preview?.error && (
        <div className="msb-approve__verify msb-approve__verify--bad" role="alert">
          <Icon name="alert" size={13} />
          Preview unavailable ({preview.error}). The verification and diff below are missing: review the call carefully, or decline.
        </div>
      )}
      {preview?.verification && (
        <div className={`msb-approve__verify msb-approve__verify--${preview.verification.ok ? 'ok' : 'bad'}`}>
          <Icon name={preview.verification.ok ? 'shield' : 'alert'} size={13} />
          {preview.verification.summary}
        </div>
      )}
      {preview?.risk && <div className="msb-approve__verify msb-approve__verify--warn msb-approve__pre">{preview.risk}</div>}
      {preview?.undo && (
        <div className="msb-approve__undo">
          <Icon name="undo" size={12} />
          {preview.undo}
        </div>
      )}
      {rows ? (
        <div className="msb-approve__diff">
          <div className="msb-approve__caption">Changes to the script</div>
          <DiffView rows={rows} />
        </div>
      ) : (
        code && (
          <div className="msb-approve__diff">
            <div className="msb-approve__caption">Script</div>
            <pre className="msb-approve__code">{code}</pre>
          </div>
        )
      )}
    </div>
  );
}

function Approval({ step, instance, onDecision }) {
  const strong = step.mode === 'ask-strong';
  const [typed, setTyped] = useState('');
  const needed = (instance?.instance || '').toLowerCase();
  const checking = step.preview === undefined; // the diff and verification are still loading
  // A call the executor will refuse anyway (blocked table, unknown column, record gone) cannot be approved.
  const locked = checking || Boolean(step.preview?.blocked) || (strong && typed.trim().toLowerCase() !== needed);
  const approveLabel = step.tool === 'dry_run_script' ? 'Run dry run' : step.tool === 'run_background_script' ? 'Run for real' : 'Approve';

  return (
    <div className={`msb-approve${strong ? ' msb-approve--prod' : ''}`}>
      <Preview call={step} preview={step.preview} />
      {strong && (
        <label className="msb-approve__prod">
          <span>
            <Icon name="alert" size={13} /> {instance?.env === 'prod' ? 'Production instance.' : 'Not recognisably a dev, test or stage instance.'} Type <b>{instance?.instance}</b> to allow this.
          </span>
          <input value={typed} onChange={trusted((e) => setTyped(e.target.value))} placeholder={instance?.instance} spellCheck={false} />
        </label>
      )}
      <div className="msb-approve__actions">
        <button type="button" className="msb-btn" onClick={() => onDecision(step.id, false)}>
          Decline
        </button>
        <button type="button" className="msb-btn msb-btn--primary" disabled={locked} onClick={trusted(() => onDecision(step.id, true))}>
          {approveLabel}
        </button>
      </div>
    </div>
  );
}

function ToolStep({ step, instance, onDecision }) {
  const [open, setOpen] = useState(false);
  const spinning = step.status === 'running';
  const icon = STATUS_ICON[step.status];
  const detail = step.status !== 'awaiting' && (step.text || Object.keys(step.args || {}).length);

  return (
    <li className={`msb-step msb-step--${step.status}`}>
      <span className="msb-step__node" aria-hidden="true">
        {spinning ? <span className="msb-spinner msb-spinner--sm" /> : <Icon name={icon || step.icon} size={12} />}
      </span>
      <div className="msb-step__main">
        <button
          type="button"
          className="msb-step__head"
          onClick={() => detail && setOpen((v) => !v)}
          aria-expanded={detail ? open : undefined}
          disabled={!detail}
        >
          <span className="msb-step__icon">
            <Icon name={step.icon} size={13} />
          </span>
          <span className="msb-step__title">{step.title}</span>
          {step.ms !== undefined && step.status === 'ok' && <span className="msb-step__time">{step.ms < 1000 ? `${step.ms}ms` : `${(step.ms / 1000).toFixed(1)}s`}</span>}
          {STATUS_LABEL[step.status] && <span className={`msb-step__flag msb-step__flag--${step.status}`}>{STATUS_LABEL[step.status]}</span>}
          {detail && <Icon name="chevron" size={12} className={`msb-step__chev${open ? ' msb-step__chev--open' : ''}`} />}
        </button>
        {step.summary && step.status !== 'awaiting' && <div className="msb-step__summary">{step.summary}</div>}
        {step.status === 'awaiting' && <Approval step={step} instance={instance} onDecision={onDecision} />}
        {open && detail && (
          <div className="msb-step__detail">
            {Object.keys(step.args || {}).length > 0 && <pre>{JSON.stringify(step.args, null, 1)}</pre>}
            {step.text && <pre>{step.text}</pre>}
          </div>
        )}
      </div>
    </li>
  );
}

/** The live or finished timeline of one agent turn. */
export default function AgentRun({ run, instance, onDecision }) {
  const toolSteps = run.steps.filter((s) => s.kind === 'tool');
  const waiting = toolSteps.some((s) => s.status === 'awaiting');

  return (
    <div className={`msb-run msb-run--${run.status}`}>
      <div className="msb-run__head">
        {run.skill && (
          <span className="msb-run__skill" title="Skill pack in use">
            <Icon name={run.skill.id === 'client-script' ? 'braces' : 'database'} size={12} />
            {run.skill.title} skill
          </span>
        )}
        <span className="msb-run__state">
          {run.status === 'running' ? (waiting ? 'Waiting for you' : 'Working') : run.status === 'done' ? `${toolSteps.length} step${toolSteps.length === 1 ? '' : 's'}` : run.status === 'aborted' ? 'Stopped' : run.status === 'limit' ? 'Step limit reached' : 'Stopped on an error'}
        </span>
      </div>

      {(run.steps.length > 0 || run.thinking) && (
        <ol className="msb-timeline">
          {run.steps.map((step) =>
            step.kind === 'note' ? (
              <li key={step.id} className="msb-step msb-step--note">
                <span className="msb-step__node" aria-hidden="true">
                  <Icon name="sparkle" size={11} />
                </span>
                <div className="msb-step__main msb-step__note">{step.text}</div>
              </li>
            ) : (
              <ToolStep key={step.id} step={step} instance={instance} onDecision={onDecision} />
            )
          )}
          {run.thinking && run.status === 'running' && !waiting && (
            <li className="msb-step msb-step--thinking">
              <span className="msb-step__node" aria-hidden="true">
                <span className="msb-dots">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <div className="msb-step__main msb-step__note">Thinking</div>
            </li>
          )}
        </ol>
      )}
      {run.error && <div className="msb-run__error">{run.error}</div>}
    </div>
  );
}
