import React, { useEffect, useMemo, useRef, useState } from 'react';
import { STATUS_WORDS, whenText, agoText, minutesSince, notifyToMarkdown, notificationToMarkdown, recordPath } from '../lib/notifyTrace.js';
import { copyText } from '../content/quickActions.js';
import { trusted } from './trusted.js';

const errorText = (err) => err?.message || String(err);

// A stage / verdict status -> the colour family. Colour is never the only signal: every pill carries words.
const TONE = { ok: 'ok', fail: 'bad', warn: 'warn', wait: 'warn', unknown: 'neutral', skip: 'faint', na: 'faint' };
const VERDICT_TONE = { sent: 'ok', blocked: 'bad', waiting: 'warn', warn: 'warn', unknown: 'neutral' };
const VERDICT_WORD = { sent: 'Sent', blocked: 'Stopped', waiting: 'In progress', warn: 'Sent, but...', unknown: 'Cannot tell' };
const PHASE_TONE = { processed: 'ok', sent: 'ok', error: 'bad', failed: 'bad', ignored: 'bad', stuck: 'bad', ready: 'warn', pending: 'warn', scheduled: 'warn', received: 'neutral', other: 'neutral' };
const CHECK_MARK = { pass: ['Passed', 'ok'], fail: ['Stops it', 'bad'], warn: ['Check', 'warn'], unknown: ['Cannot tell', 'neutral'], info: ['Note', 'faint'] };

function Link({ href, children }) {
  if (!href) return <span>{children}</span>;
  return (
    <a className="msb-panel__link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function Pill({ tone = 'neutral', children }) {
  return <span className={`msb-notify__pill msb-notify__pill--${tone}`}>{children}</span>;
}

function When({ value, now }) {
  const text = whenText(value);
  if (!text) return null;
  const ago = agoText(minutesSince(value, now));
  return (
    <span className="msb-notify__when">
      {text}
      {ago && ago !== 'just now' ? ` (${ago} ago)` : ago ? ' (just now)' : ''}
    </span>
  );
}

// --- Instance switches ---------------------------------------------------------------------------------

function Banners({ switches, error }) {
  if (!switches?.findings?.length && !error) return null;
  const LABEL = { bad: 'Sending is off', warn: 'Mail is redirected', info: 'Not production' };
  return (
    <div className="msb-notify__banners">
      {error && (
        <div className="msb-notify__banner msb-notify__banner--info" role="note">
          <strong>Mail settings not checked.</strong> The instance properties that switch outbound email off could not be read ({error}), so a disabled mail setting would not show here.
        </div>
      )}
      {(switches?.findings || []).map((f) => (
        <div key={f.id} className={`msb-notify__banner msb-notify__banner--${f.level}`} role={f.level === 'bad' ? 'alert' : 'note'}>
          <strong>{f.id === 'sending-off' ? LABEL.bad : f.id === 'test-user' ? LABEL.warn : LABEL.info}.</strong> {f.text}
        </div>
      ))}
    </div>
  );
}

// --- The chain -----------------------------------------------------------------------------------------

function Checks({ checks, open }) {
  if (!checks?.length) return null;
  return (
    <details className="msb-notify__details" open={open}>
      <summary>{open ? 'Details' : `Every check (${checks.length})`}</summary>
      <ul className="msb-notify__checks">
        {checks.map((c, i) => (
          <li key={`${i}:${c.text}`} className={`msb-notify__check msb-notify__check--${CHECK_MARK[c.status]?.[1] || 'faint'}`}>
            <span className="msb-notify__check-mark">{CHECK_MARK[c.status]?.[0] || 'Note'}</span>
            <span>{c.text}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Chain({ stages }) {
  const firstFail = stages.find((s) => s.status === 'fail');
  return (
    <ol className="msb-notify__chain" aria-label="Steps from the notification to the inbox">
      {stages.map((s, i) => {
        const first = firstFail && firstFail.id === s.id;
        return (
          <li key={s.id} className={`msb-notify__stage msb-notify__stage--${s.status}${first ? ' msb-notify__stage--first' : ''}`}>
            <span className="msb-notify__num" aria-hidden="true">
              {i + 1}
            </span>
            <div className="msb-notify__stage-body">
              <div className="msb-notify__stage-head">
                <strong>{s.label}</strong>
                <Pill tone={TONE[s.status]}>{s.status === 'fail' && !first ? 'Also stopped' : STATUS_WORDS[s.status]}</Pill>
                {first && <span className="msb-notify__first">First broken link</span>}
              </div>
              <div className="msb-notify__stage-text">{s.headline}</div>
              {s.advice && (s.status === 'fail' || s.status === 'unknown' || s.status === 'warn') && (
                <div className="msb-notify__advice">
                  <strong>What to check: </strong>
                  {s.advice}
                </div>
              )}
              <Checks checks={s.checks} open={s.status === 'fail' || s.status === 'unknown'} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Verdict({ candidate }) {
  const { verdict } = candidate.trace;
  const tone = VERDICT_TONE[verdict.status] || 'neutral';
  return (
    <div className={`msb-notify__verdict msb-notify__verdict--${tone}`} role="status">
      <div className="msb-notify__verdict-head">
        <Pill tone={tone}>{VERDICT_WORD[verdict.status] || 'Result'}</Pill>
        <strong>{candidate.notification.name}</strong>
      </div>
      <p className="msb-notify__verdict-text">{verdict.summary || verdict.headline}</p>
      {verdict.advice && verdict.status !== 'blocked' && (
        <p className="msb-notify__advice">
          <strong>Next: </strong>
          {verdict.advice}
        </p>
      )}
    </div>
  );
}

// --- Recipients ----------------------------------------------------------------------------------------

function Recipients({ recipients, noRecord }) {
  if (!recipients) return <div className="msb-panel__hint">The people this notification would send to were not read.</div>;
  const { counts } = recipients;
  return (
    <div className="msb-notify__recipients">
      {!noRecord && (
        <div className="msb-notify__summary" aria-live="polite">
          <Pill tone={counts.receive ? 'ok' : 'bad'}>{counts.receive} would get it</Pill>
          <Pill tone={counts.blocked ? 'bad' : 'faint'}>{counts.blocked} would not</Pill>
        </div>
      )}
      {recipients.sources.length > 0 && (
        <ul className="msb-notify__sources" aria-label="Where the recipients come from">
          {recipients.sources.map((s, i) => (
            <li key={`${s.label}:${i}`} className={`msb-notify__source msb-notify__source--${s.tone}`}>
              <span className="msb-notify__source-label">{s.href ? <Link href={s.href}>{s.label}</Link> : s.label}</span>
              <span>{s.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {recipients.issues.length > 0 && (
        <ul className="msb-notify__issues">
          {recipients.issues.map((issue, i) => (
            <li key={`${issue.code}:${i}`} className={`msb-notify__issue msb-notify__issue--${issue.level}`}>
              {issue.text}
            </li>
          ))}
        </ul>
      )}
      {recipients.people.length > 0 && (
        <ul className="msb-notify__people" aria-label="Who would and would not get it">
          {recipients.people.map((p) => (
            <li key={p.key} className={`msb-notify__person msb-notify__person--${p.status}`}>
              <div className="msb-notify__person-head">
                {p.sysId && !p.isAddress ? <Link href={recordPath('sys_user', p.sysId)}>{p.name}</Link> : <strong>{p.name}</strong>}
                <Pill tone={p.status === 'receives' ? 'ok' : 'bad'}>{p.status === 'receives' ? (noRecord ? 'Eligible' : 'Gets it') : 'Left out'}</Pill>
              </div>
              <div className="msb-notify__muted">{p.sources.join('; ')}</div>
              {p.reasons.map((r) => (
                <div key={r.code} className="msb-notify__reason">
                  {r.text} {r.advice && <span className="msb-notify__muted">{r.advice}</span>}
                </div>
              ))}
              {p.notes.map((note) => (
                <div key={note} className="msb-notify__muted">
                  {note}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Events and emails ---------------------------------------------------------------------------------

function EventRow({ event, now }) {
  return (
    <li className="msb-notify__row">
      <div className="msb-notify__row-head">
        <Link href={recordPath('sysevent', event.sysId)}>{event.name}</Link>
        <Pill tone={PHASE_TONE[event.phase]}>{event.label}</Pill>
      </div>
      <div className="msb-notify__muted">
        Queued <When value={event.createdOn} now={now} />
        {event.userName ? ` by ${event.userName}` : ''}
        {event.queue ? `, queue ${event.queue}` : ''}
        {event.parm1 ? `, parm1 "${event.parm1.slice(0, 60)}"` : ''}
        {event.parm2 ? `, parm2 "${event.parm2.slice(0, 60)}"` : ''}
      </div>
    </li>
  );
}

function EmailText({ sysId, services }) {
  const [state, setState] = useState({ status: 'idle' });
  async function toggle() {
    if (state.status === 'open') {
      setState({ ...state, status: 'closed' });
      return;
    }
    if (state.result) {
      setState({ ...state, status: 'open' });
      return;
    }
    setState({ status: 'loading' });
    try {
      const result = await services.notifyEmailText({ sysId });
      setState({ status: 'open', result });
    } catch (err) {
      setState({ status: 'error', error: errorText(err) });
    }
  }
  return (
    <div className="msb-notify__preview">
      <button className="msb-panel__secondary" onClick={toggle} aria-expanded={state.status === 'open'} disabled={state.status === 'loading'}>
        {state.status === 'open' ? 'Hide text' : state.status === 'loading' ? 'Reading...' : 'Show text'}
      </button>
      {state.status === 'error' && <div className="msb-panel__error">{state.error}</div>}
      {state.status === 'open' && state.result && (
        <div>
          {state.result.hidden && <div className="msb-panel__warning">{state.result.reason}</div>}
          {!state.result.hidden && state.result.empty && <div className="msb-panel__hint">The email has no body text.</div>}
          {!state.result.hidden && !state.result.empty && (
            <>
              <pre className="msb-notify__text" tabIndex={0} aria-label="Email text">
                {state.result.text}
              </pre>
              <div className="msb-panel__hint">Shown as plain text with tags removed{state.result.truncated ? ' and cut short' : ''}. HTML from the instance is never rendered here.</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EmailRow({ email, now, services, later = false, mark = '' }) {
  const recipients = email.recipients.slice(0, 3).join(', ') + (email.recipients.length > 3 ? ` and ${email.recipients.length - 3} more` : '');
  return (
    <li className="msb-notify__row">
      <div className="msb-notify__row-head">
        <Link href={recordPath('sys_email', email.sysId)}>{email.subject || '(no subject)'}</Link>
        <Pill tone={PHASE_TONE[email.phase] === 'warn' && email.stuck ? 'bad' : PHASE_TONE[email.phase]}>{email.label}</Pill>
        {later && <span className="msb-notify__tag">from an earlier event</span>}
        {mark && <span className="msb-notify__tag">{mark}</span>}
      </div>
      <div className="msb-notify__muted">
        Created <When value={email.createdOn} now={now} />
        {recipients ? `, to ${recipients}` : ', no recipients on the email'}
      </div>
      {email.error && <div className="msb-notify__reason">{email.error}</div>}
      <EmailText sysId={email.sysId} services={services} />
    </li>
  );
}

// --- One notification ----------------------------------------------------------------------------------

function Section({ title, count, children, open = true }) {
  return (
    <details className="msb-notify__section" open={open}>
      <summary className="msb-panel__result-toggle">
        <span className="msb-notify__section-title">{title}</span>
        {count !== undefined && <span className="msb-panel__badge">{count}</span>}
      </summary>
      <div className="msb-notify__section-body">{children}</div>
    </details>
  );
}

function ConditionBlock({ notification }) {
  return (
    <div className="msb-notify__condition">
      {notification.condition ? (
        <>
          <div className="msb-notify__muted">Condition (must hold for the record):</div>
          {notification.conditionLines?.length > 0 && <div>{notification.conditionLines.join('; ')}</div>}
          <code className="msb-notify__code">{notification.condition}</code>
        </>
      ) : (
        <div className="msb-notify__muted">No condition: it applies to every record of its table.</div>
      )}
      {notification.advancedCondition && (
        <details className="msb-notify__details">
          <summary>Advanced condition script (shown, never run)</summary>
          <pre className="msb-notify__text" tabIndex={0} aria-label="Advanced condition script">
            {notification.advancedCondition}
          </pre>
        </details>
      )}
    </div>
  );
}

function SelectedNotification({ candidate, report, services }) {
  const { notification: n, trace, recipients } = candidate;
  const now = report.generatedAt;
  const relevant = new Set(trace.emailsRelevant);
  return (
    <div className="msb-notify__selected">
      <Verdict candidate={candidate} />
      <div className="msb-notify__meta">
        <Link href={n.href}>{n.name}</Link>
        <span className="msb-notify__muted">
          {n.active ? 'Active' : 'Inactive'}, sends {n.triggerText}. Defined on {n.table}
          {n.inherited ? ' (a parent of this record\'s table)' : ''}.
        </span>
        <ConditionBlock notification={n} />
      </div>
      <Chain stages={trace.stages} />

      <Section title="Who would get it" count={recipients ? `${recipients.counts.receive} of ${recipients.counts.total}` : undefined}>
        <Recipients recipients={recipients} />
      </Section>

      <Section title="Events for this record" count={trace.events.length} open={trace.events.length > 0 || n.kind === 'event'}>
        {!report.sections.events?.ok && <div className="msb-panel__error">The event log could not be read: {report.sections.events?.error}</div>}
        {report.sections.events?.ok && n.kind !== 'event' && <div className="msb-panel__hint">This notification does not use an event.</div>}
        {report.sections.events?.ok && n.kind === 'event' && trace.events.length === 0 && (
          <div className="msb-panel__hint">
            No event named <code>{n.eventName || '(none chosen)'}</code> is on file for this record.
          </div>
        )}
        {trace.events.length > 0 && (
          <ul className="msb-notify__rows">
            {trace.events.slice(0, 6).map((e) => (
              <EventRow key={e.sysId} event={e} now={now} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Emails from this notification" count={trace.emails.length} open={trace.emails.length > 0 || ['created', 'sent'].includes(trace.verdict.stage)}>
        {!report.sections.emails?.ok && <div className="msb-panel__error">The emails could not be read: {report.sections.emails?.error}</div>}
        {report.sections.emails?.ok && trace.emails.length === 0 && <div className="msb-panel__hint">No email for this record names this notification in its header or in the email log{report.emailsUnlinked ? `; ${report.emailsUnlinked === 1 ? 'one email names none and was' : `${report.emailsUnlinked} emails name none and were`} checked by subject` : ''}.</div>}
        {trace.emails.length > 0 && (
          <ul className="msb-notify__rows">
            {trace.emails.slice(0, 6).map((e) => (
              <EmailRow key={e.sysId} email={e} now={now} services={services} later={n.kind === 'event' && !relevant.has(e.sysId)} />
            ))}
          </ul>
        )}
        {/subject/.test(trace.emailsBy) && trace.emails.length > 0 && <div className="msb-panel__hint">Some were matched by subject only (they carry no notification header or email log entry), so a different notification with the same subject could be mixed in.</div>}
      </Section>
    </div>
  );
}

// --- The picker ----------------------------------------------------------------------------------------

function Picker({ candidates, selectedId, onSelect }) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? candidates.filter((c) => c.notification.name.toLowerCase().includes(f) || (c.notification.eventName || '').toLowerCase().includes(f)) : candidates;
  }, [candidates, filter]);
  return (
    <div className="msb-notify__picker">
      <div className="msb-notify__picker-head">
        <strong id="notify-picker-label">Notifications that could fire</strong>
        <span className="msb-panel__badge">{candidates.length}</span>
      </div>
      <div className="msb-panel__hint">Event-fired ones first, then those whose condition holds, then the rest.</div>
      {candidates.length > 8 && (
        <input className="msb-notify__filter" type="text" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name or event" aria-label="Filter notifications" />
      )}
      <ul className="msb-notify__picker-list" aria-labelledby="notify-picker-label">
        {shown.map((c) => {
          const v = c.trace.verdict;
          const inactive = !c.notification.active;
          return (
            <li key={c.notification.sysId}>
              <button className="msb-notify__pick" aria-pressed={c.notification.sysId === selectedId} onClick={() => onSelect(c.notification.sysId)}>
                <span className="msb-notify__pick-name">{c.notification.name}</span>
                <span className="msb-notify__pick-meta">
                  {c.notification.kind === 'event' ? c.notification.eventName || 'event' : c.notification.kind === 'engine' ? 'on save' : 'triggered'} - {c.notification.table}
                </span>
                <Pill tone={inactive ? 'faint' : VERDICT_TONE[v.status] || 'neutral'}>{inactive ? 'Inactive' : v.status === 'sent' ? 'Sent' : v.status === 'blocked' ? v.short : v.short || VERDICT_WORD[v.status]}</Pill>
              </button>
            </li>
          );
        })}
        {shown.length === 0 && <li className="msb-panel__empty">No notification matches &ldquo;{filter}&rdquo;.</li>}
      </ul>
    </div>
  );
}

// --- Email page ----------------------------------------------------------------------------------------

function EmailCard({ report, services }) {
  const e = report.email;
  return (
    <div className="msb-notify__emailcard">
      <div className="msb-notify__row-head">
        <strong>This email</strong>
        <Pill tone={PHASE_TONE[e.phase]}>{e.label}</Pill>
      </div>
      <div>
        <Link href={e.href}>{e.subject || '(no subject)'}</Link>
      </div>
      <div className="msb-notify__muted">
        Created <When value={e.createdOn} now={report.generatedAt} />
      </div>
      {e.error && <div className="msb-notify__reason">{e.error}</div>}
      {report.trigger && <p className="msb-notify__trigger">{report.trigger.text}</p>}
      {report.targetError && <div className="msb-panel__hint">{report.targetError}</div>}
      {report.recipientsExplained.length > 0 && (
        <>
          <div className="msb-notify__subhead">Why it went to these addresses</div>
          <ul className="msb-notify__people">
            {report.recipientsExplained.map((r) => (
              <li key={`${r.kind}:${r.address}`} className={`msb-notify__person msb-notify__person--${r.explained ? 'receives' : 'blocked'}`}>
                <div className="msb-notify__person-head">
                  <strong>{r.name || r.address}</strong>
                  <span className="msb-notify__tag">{r.kind}</span>
                  {r.activeUser === false && <Pill tone="bad">Inactive user</Pill>}
                </div>
                {r.name && <div className="msb-notify__muted">{r.address}</div>}
                {r.sources.length > 0 && <div className="msb-notify__muted">{r.sources.join('; ')}</div>}
                {r.note && <div className="msb-notify__muted">{r.note}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      <EmailText sysId={e.sysId} services={services} />
    </div>
  );
}

// --- A notification page -------------------------------------------------------------------------------

function NotificationView({ report, services }) {
  const n = report.notification;
  const now = report.generatedAt;
  const m = report.matching;
  return (
    <div className="msb-notify__selected">
      <div className="msb-notify__verdict msb-notify__verdict--neutral">
        <div className="msb-notify__verdict-head">
          <Pill tone={n.active ? 'ok' : 'faint'}>{n.active ? 'Active' : 'Inactive'}</Pill>
          <strong>{n.name}</strong>
        </div>
        <p className="msb-notify__verdict-text">
          Sends {n.triggerText}. Defined on {n.table}.
        </p>
        <Link href={n.href}>Open the notification</Link>
      </div>
      <ConditionBlock notification={n} />
      <Section title="Records that meet the condition now">
        {m?.all && <div className="msb-panel__hint">There is no condition, so it applies to every {n.table} record.</div>}
        {m?.error && <div className="msb-panel__error">Could not count them: {m.error}</div>}
        {m?.skipped && <div className="msb-panel__hint">Not counted: {m.skipped}.</div>}
        {m && !m.all && !m.error && !m.skipped && (
          <>
            <div>
              <strong>{m.count}</strong> {m.count === 1 ? 'record' : 'records'} on {n.table} {m.count === 1 ? 'meets' : 'meet'} the condition as it is now.
              {n.kind === 'event' ? ' It sends only when its event is also queued for the record.' : ''}
            </div>
            <ul className="msb-notify__rows">
              {m.sample.map((s) => (
                <li key={s.sysId} className="msb-notify__row">
                  <Link href={s.href}>{s.label}</Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
      <Section title="Who it sends to" count={report.recipients ? report.recipients.counts.total : undefined}>
        {report.sections.recipients?.ok === false && <div className="msb-panel__error">The people could not be read: {report.sections.recipients.error}</div>}
        <Recipients recipients={report.recipients} noRecord />
      </Section>
      <Section title="Latest events it reacts to" count={report.events.length} open={report.events.length > 0}>
        {report.sections.events?.ok === false && <div className="msb-panel__error">Events could not be read: {report.sections.events.error}</div>}
        {n.kind !== 'event' && <div className="msb-panel__hint">This notification does not use an event.</div>}
        {n.kind === 'event' && report.sections.events?.ok && report.events.length === 0 && <div className="msb-panel__hint">No event named {n.eventName} is on file (processed events are cleaned out after about a week).</div>}
        <ul className="msb-notify__rows">
          {report.events.slice(0, 5).map((e) => (
            <EventRow key={e.sysId} event={e} now={now} />
          ))}
        </ul>
      </Section>
      <Section title="Latest emails it created" count={report.emails.length} open={report.emails.length > 0}>
        {report.sections.emails?.ok === false && <div className="msb-panel__error">Emails could not be read: {report.sections.emails.error}</div>}
        {report.sections.emails?.ok && report.emails.length === 0 && <div className="msb-panel__hint">No email from this notification was found.</div>}
        <ul className="msb-notify__rows">
          {report.emails.slice(0, 5).map((e) => (
            <EmailRow key={e.sysId} email={e} now={now} services={services} />
          ))}
        </ul>
        {report.emailsBy === 'subject' && report.emails.length > 0 && <div className="msb-panel__hint">Some were matched by subject only, because they carry no notification header.</div>}
      </Section>
      {report.others?.length > 0 && (
        <Section title="Other notifications with a similar name" count={report.others.length} open={false}>
          <ul className="msb-notify__rows">
            {report.others.map((o) => (
              <li key={o.sysId} className="msb-notify__row">
                <Link href={o.href}>{o.name}</Link> <span className="msb-notify__muted">on {o.table}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

// --- The panel -----------------------------------------------------------------------------------------

/**
 * Why wasn't the email sent? For the record on screen: every notification that could fire for it, walked through the
 * chain (matched, event fired, event processed, email created, email sent) with the first broken link named. Also an
 * email page ("why did it go to these people") and a notification page ("which records, what did it last send").
 * Read-only. Data: services.notifyReport (src/content/notifyTrace.js); logic: src/lib/notifyTrace.js.
 */
export default function NotifyPanel({ context, params, services, onClose, onAskAi }) {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [nameInput, setNameInput] = useState(() => String(params?.args || '').trim());
  const [name, setName] = useState(() => String(params?.args || '').trim());
  const run = useRef(0);

  async function load(options = {}) {
    const mine = (run.current += 1);
    setBusy(true);
    setError(null);
    try {
      const result = await services.notifyReport({
        context,
        args: options.name ?? name,
        notificationId: options.keepSelection ? selectedId : '',
        onProgress: (text) => mine === run.current && setProgress(text),
      });
      if (mine !== run.current) return;
      setReport(result);
      setSelectedId(result.selectedId || '');
    } catch (err) {
      if (mine === run.current) setError(errorText(err));
    } finally {
      if (mine === run.current) {
        setBusy(false);
        setProgress('');
      }
    }
  }

  useEffect(() => {
    load();
    return () => {
      run.current += 1;
    };
    // Once per panel instance; the panel is re-keyed when its arguments change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flash(text) {
    setNotice(text);
    setTimeout(() => setNotice(null), 2500);
  }

  const candidate = report?.candidates?.find((c) => c.notification.sysId === selectedId) || null;

  const markdown = useMemo(() => {
    if (!report) return '';
    if (report.mode === 'notification') {
      return notificationToMarkdown({ notification: report.notification, recipients: report.recipients, matching: report.matching, events: report.events, emails: report.emails, switches: report.switches, host: report.host, checkedAt: report.generatedAt });
    }
    if (!candidate) return '';
    return notifyToMarkdown({ subject: report.subject, candidate, switches: report.switches, host: report.host, checkedAt: report.generatedAt });
  }, [report, candidate]);

  const copySummary = trusted(async () => {
    try {
      await copyText(markdown);
      flash('Copied the summary as Markdown.');
    } catch {
      flash('Copy was blocked by the browser.');
    }
  });

  function traceByName() {
    const next = nameInput.trim();
    setName(next);
    load({ name: next });
  }

  function clearName() {
    setNameInput('');
    setName('');
    load({ name: '' });
  }

  const isRecord = report && (report.mode === 'record' || report.mode === 'email');
  // An email that is not tied to a record (or whose record could not be traced) has no notifications section at all:
  // it must not read as "the notifications could not be read".
  const traced = Boolean(isRecord && report.subject && report.sections?.notifications);

  return (
    <div className="msb-panel msb-notify">
      <div className="msb-panel__header">
        <strong>Why wasn&apos;t the email sent?</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className="msb-panel__form">
        <div className="msb-panel__hint">
          Walks the chain for the record on screen: the notification matches, its event is fired and processed, the email is created and sent. It names the first link that
          broke. Read-only.
        </div>
        <label>
          Pick a notification by name (optional)
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') traceByName();
            }}
            placeholder="Incident commented"
          />
        </label>
        <div className="msb-panel__actions msb-notify__actions">
          <button className="msb-panel__run" onClick={traceByName} disabled={busy}>
            {nameInput.trim() ? 'Trace this notification' : 'Trace'}
          </button>
          {name && (
            <button className="msb-panel__secondary" onClick={clearName} disabled={busy}>
              Show every notification
            </button>
          )}
        </div>
      </div>

      {busy && (
        <div className="msb-notify__busy" aria-live="polite">
          {progress || 'Reading the instance...'}
        </div>
      )}
      {error && (
        <div className="msb-panel__error" role="alert">
          {error}
          <div>
            <button className="msb-panel__secondary" onClick={() => load({ keepSelection: true })} disabled={busy}>
              Try again
            </button>
          </div>
        </div>
      )}
      {notice && <div className="msb-panel__hint" aria-live="polite">{notice}</div>}

      {report && !error && (
        <div className="msb-panel__results">
          {report.mode === 'none' && (
            <div className="msb-panel__empty">
              Open a record (an incident, a change, any form) to trace its emails, or type a notification name above. On an email or notification page it explains that one.
            </div>
          )}

          {isRecord && report.subject && (
            <div className="msb-notify__subject">
              <strong>
                <Link href={report.subject.href}>{report.subject.label}</Link>
              </strong>
              <span className="msb-notify__muted">
                {report.subject.table}
                {report.subject.chain.length > 1 ? `, also checked ${report.subject.chain.slice(1).join(', ')}` : ''}. Judged on the saved record, not unsaved edits.
              </span>
            </div>
          )}

          {report.mode !== 'none' && <Banners switches={report.switches} error={report.sections?.switches?.ok === false ? report.sections.switches.error : ''} />}

          {report.mode === 'email' && <EmailCard report={report} services={services} />}

          {traced && !report.sections.notifications.ok && (
            <div className="msb-panel__error" role="alert">
              The notifications could not be read, so nothing can be traced: {report.sections.notifications.error}
            </div>
          )}

          {traced && report.sections.notifications.ok && report.candidates.length === 0 && (
            <div className="msb-panel__empty">
              No notifications are defined on {report.subject?.table} or its parent tables, so this record cannot send any notification email.{' '}
              {report.listHref && <Link href={report.listHref}>Open the notification list</Link>}
            </div>
          )}

          {isRecord && report.focusMissing && (
            <div className="msb-panel__warning">
              No notification named &ldquo;{report.focusMissing}&rdquo; applies to this record&apos;s table or its parents, so it cannot fire for it. Showing the ones that can.
              {report.focusElsewhere?.length > 0 && (
                <div>
                  A notification with a similar name exists on another table:{' '}
                  {report.focusElsewhere.map((o, i) => (
                    <span key={o.sysId}>
                      {i > 0 ? ', ' : ''}
                      <Link href={o.href}>
                        {o.name} ({o.table})
                      </Link>
                    </span>
                  ))}
                  .
                </div>
              )}
            </div>
          )}

          {traced && report.candidates.length > 0 && (
            <>
              <Picker candidates={report.candidates} selectedId={selectedId} onSelect={setSelectedId} />
              {candidate && <SelectedNotification candidate={candidate} report={report} services={services} />}
              {report.unmatchedEmails.length > 0 && (
                <Section title="Other emails for this record" count={report.unmatchedEmails.length} open={false}>
                  <div className="msb-panel__hint">Not linked to any notification above (sent by a flow, a script, or an inbound reply).</div>
                  <ul className="msb-notify__rows">
                    {report.unmatchedEmails.slice(0, 8).map((e) => (
                      <EmailRow key={e.sysId} email={e} now={report.generatedAt} services={services} />
                    ))}
                  </ul>
                </Section>
              )}
              {report.events.length > 0 && (
                <Section title="Every event for this record" count={report.events.length} open={false}>
                  <ul className="msb-notify__rows">
                    {report.events.slice(0, 15).map((e) => (
                      <EventRow key={e.sysId} event={e} now={report.generatedAt} />
                    ))}
                  </ul>
                </Section>
              )}
            </>
          )}

          {report.mode === 'notification' && <NotificationView report={report} services={services} />}

          {report.mode !== 'none' && (
            <div className="msb-panel__actions">
              <button className="msb-panel__secondary" onClick={() => load({ keepSelection: true })} disabled={busy}>
                Refresh
              </button>
              <button className="msb-panel__secondary" onClick={copySummary} disabled={!markdown}>
                Copy summary as Markdown
              </button>
              {onAskAi && markdown && (
                <button className="msb-panel__secondary" onClick={() => onAskAi("Why wasn't the email sent", `${markdown}\n\nExplain what is most likely wrong and exactly what I should change to fix it.`)}>
                  Ask AI
                </button>
              )}
            </div>
          )}

          {report.notes?.length > 0 && (
            <Section title="Not checked" count={report.notes.length} open={false}>
              <ul className="msb-notify__issues">
                {report.notes.map((note) => (
                  <li key={note} className="msb-notify__issue msb-notify__issue--info">
                    {note}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {report.mode !== 'none' && (
            <div className="msb-panel__hint msb-notify__footnote">
              Scripts are never run: an advanced condition shows as &ldquo;cannot tell&rdquo;. Conditions are judged against the record as it is now. &ldquo;Sent&rdquo; means the
              mail server took the message; spam filters and mailbox rules are beyond what the instance can see. Event times and email times are UTC.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
