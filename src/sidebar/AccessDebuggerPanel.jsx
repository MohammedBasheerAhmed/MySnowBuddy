import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { trusted } from './trusted.js';
import { redactSecrets } from '../providers/redact.js';
import { OPERATIONS, OPERATION_LABELS, isName, isSysId, parseAccessArgs, pathLabel, runtimeAnswer } from '../lib/accessTrace.js';

const STATUS_WORD = { pass: 'Pass', fail: 'Fail', unknown: 'Runtime' };
const VERDICT_ICON = { allowed: 'check', denied: 'ban', depends: 'clock' };
const ROLE_PREVIEW = 14;

const recordHref = (table, id) => (isName(table) && isSysId(id) ? `/${table}.do?sys_id=${id}` : '');

/** A link to a record, opened in a new tab; plain text when there is no record to open. */
function RecordLink({ table, id, children, title }) {
  const href = recordHref(table, id);
  if (!href) return <span>{children}</span>;
  return (
    <a className="msb-panel__link" href={href} target="_blank" rel="noopener noreferrer" title={title || `Open in a new tab`}>
      {children}
    </a>
  );
}

function StatusChip({ status }) {
  return <span className={`msb-acc__chip msb-acc__chip--${status}`}>{STATUS_WORD[status] || status}</span>;
}

/** Text input with a small suggestion list (users, tables). */
function Typeahead({ value, onChange, onPick, onEnter, search, renderItem, placeholder, label, minChars = 2 }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef(null);
  const seq = useRef(0);

  useEffect(() => () => clearTimeout(timer.current), []);

  function handleInput(text) {
    onChange(text);
    clearTimeout(timer.current);
    seq.current += 1;
    if (text.trim().length < minChars) {
      setItems([]);
      setOpen(false);
      return;
    }
    const id = seq.current;
    timer.current = setTimeout(async () => {
      try {
        const found = await search(text);
        if (id !== seq.current) return;
        setItems((found || []).slice(0, 10));
        setOpen(true);
        setActive(-1);
      } catch {
        if (id === seq.current) setOpen(false);
      }
    }, 250);
  }

  function pick(item) {
    seq.current += 1;
    setOpen(false);
    setItems([]);
    onPick(item);
  }

  function handleKey(e) {
    if (e.key === 'ArrowDown' && open && items.length) {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === 'ArrowUp' && open && items.length) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && items[active]) {
        e.preventDefault();
        pick(items[active]);
      } else {
        setOpen(false);
        onEnter?.();
      }
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="msb-acc__ta">
      <input
        value={value}
        onChange={(e) => handleInput(e.target.value)}
        onKeyDown={handleKey}
        onBlur={() => setOpen(false)}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
      />
      {open && items.length > 0 && (
        <ul className="msb-acc__ta-list" role="listbox" aria-label={label}>
          {items.map((item, i) => (
            <li
              key={item.key || i}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'msb-acc__ta-item msb-acc__ta-item--on' : 'msb-acc__ta-item'}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(item);
              }}
            >
              {renderItem(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const userLabel = (u) => (u ? `${u.name || u.userName}${u.userName && u.name ? ` (${u.userName})` : ''}` : '');

function Check({ label, check, children }) {
  if (!check) return null;
  return (
    <li className={`msb-acc__check msb-acc__check--${check.status}`}>
      <span className="msb-acc__check-label">{label}</span>
      <span className="msb-acc__check-body">
        {check.detail}
        {children}
      </span>
    </li>
  );
}

function AclRow({ row }) {
  const { roles, condition, script, appliesTo, attribute } = row.checks;
  return (
    <div className={`msb-acc__acl msb-acc__acl--${row.status}`}>
      <div className="msb-acc__acl-top">
        <RecordLink table="sys_security_acl" id={row.sysId}>
          {row.name}
        </RecordLink>
        {row.decision === 'deny' && <span className="msb-panel__badge">Deny-Unless</span>}
        <StatusChip status={row.status} />
      </div>
      {row.description && <div className="msb-panel__hint">{row.description}</div>}
      <ul className="msb-acc__checks">
        {row.admin && (
          <li className="msb-acc__check msb-acc__check--pass">
            <span className="msb-acc__check-label">Admin</span>
            <span className="msb-acc__check-body">Admin overrides is on and the user has admin, so this ACL passes.</span>
          </li>
        )}
        <Check label="Roles" check={roles} />
        <Check label="Condition" check={condition.query ? condition : null}>
          {condition.text && <pre className="msb-acc__pre">{condition.text}</pre>}
        </Check>
        <Check label="Script" check={script.excerpt ? script : null}>
          {script.excerpt && (
            <details className="msb-acc__more">
              <summary>Show script</summary>
              <pre className="msb-acc__pre">{script.excerpt}</pre>
            </details>
          )}
        </Check>
        <Check label="Applies to" check={appliesTo}>
          {appliesTo?.text && <pre className="msb-acc__pre">{appliesTo.text}</pre>}
        </Check>
        <Check label="Attribute" check={attribute} />
      </ul>
    </div>
  );
}

function LevelSection({ level, hierarchy }) {
  const used = level.tiers.filter((t) => !t.skipped && (t.allow.length || t.deny.length || t.ignored.length));
  const skipped = level.tiers.filter((t) => t.skipped && (t.allow.length || t.deny.length));
  const order = level.tiers.map((t) => t.name).join(', ');
  const title = level.title || (level.level === 'table' ? `Record ACLs (${hierarchy.join(' > ')})` : 'Field ACLs');
  return (
    <details className="msb-acc__section" open>
      <summary>
        <span>{title}</span>
        <StatusChip status={level.status} />
      </summary>
      <div className="msb-acc__body">
        {level.notReached && <div className="msb-panel__hint">Not reached: the record level already denies access. Shown for reference.</div>}
        <div className="msb-acc__note">{level.note}</div>
        <div className="msb-panel__hint">Checked in this order: {order}</div>
        {used.map((tier) => (
          <div key={tier.name} className="msb-acc__tier">
            <div className="msb-acc__tier-name">
              <code>{tier.name}</code>
              {tier.decides && <span className="msb-panel__badge">decides</span>}
            </div>
            {[...tier.deny, ...tier.allow].map((row) => (
              <AclRow key={row.sysId} row={row} />
            ))}
            {tier.ignored.map((row) => (
              <div key={row.sysId} className="msb-panel__hint">
                <RecordLink table="sys_security_acl" id={row.sysId}>
                  {row.name}
                </RecordLink>{' '}
                does not apply to this record.
              </div>
            ))}
          </div>
        ))}
        {skipped.length > 0 && (
          <details className="msb-acc__more">
            <summary>
              Not used: a more specific ACL matched ({skipped.reduce((n, t) => n + t.allow.length, 0)} on {skipped.map((t) => t.name).join(', ')})
            </summary>
            {skipped.map((tier) => (
              <div key={tier.name} className="msb-acc__tier">
                <div className="msb-acc__tier-name">
                  <code>{tier.name}</code>
                </div>
                {tier.allow.map((row) => (
                  <AclRow key={row.sysId} row={row} />
                ))}
              </div>
            ))}
          </details>
        )}
      </div>
    </details>
  );
}

function UserSection({ user }) {
  const [all, setAll] = useState(false);
  const roles = all ? user.roles : user.roles.slice(0, ROLE_PREVIEW);
  const flags = [
    user.active ? null : 'inactive',
    user.lockedOut ? 'locked out' : null,
    user.isAdmin ? 'admin' : null,
    user.external ? 'external' : null,
    user.isMe ? 'you' : null,
  ].filter(Boolean);
  return (
    <details className="msb-acc__section" open>
      <summary>
        <span>
          User · {user.roles.length} role{user.roles.length === 1 ? '' : 's'} · {user.groups.length} group{user.groups.length === 1 ? '' : 's'}
        </span>
      </summary>
      <div className="msb-acc__body">
        <div className="msb-acc__user">
          <RecordLink table="sys_user" id={user.sysId}>
            {user.name || user.userName}
          </RecordLink>
          {user.userName && <span className="msb-panel__badge">{user.userName}</span>}
          {flags.map((f) => (
            <span key={f} className={`msb-acc__flag${f === 'inactive' || f === 'locked out' ? ' msb-acc__flag--bad' : ''}`}>
              {f}
            </span>
          ))}
        </div>
        {user.email && <div className="msb-panel__hint">{user.email}</div>}
        {user.domain && <div className="msb-panel__hint">Domain: {user.domain}</div>}

        <div className="msb-acc__caption">Roles</div>
        {!user.roles.length && <div className="msb-panel__empty">No roles.</div>}
        <ul className="msb-acc__roles">
          {roles.map((r) => (
            <li key={r.name}>
              <RecordLink table="sys_user_role" id={r.id}>
                {r.name}
              </RecordLink>
              {r.elevated && <span className="msb-acc__flag">elevated</span>}
              <span className="msb-acc__path">
                {r.paths.map((p, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && '; '}
                    {p.map((node, j) => (
                      <React.Fragment key={j}>
                        {j > 0 && ' > '}
                        {node.kind === 'group' ? (
                          <>
                            group{' '}
                            <RecordLink table="sys_user_group" id={node.id}>
                              {node.name}
                            </RecordLink>
                          </>
                        ) : node.kind === 'role' ? (
                          <RecordLink table="sys_user_role" id={node.id}>
                            {node.name}
                          </RecordLink>
                        ) : (
                          node.name
                        )}
                      </React.Fragment>
                    ))}
                  </React.Fragment>
                ))}
              </span>
            </li>
          ))}
        </ul>
        {user.roles.length > ROLE_PREVIEW && (
          <button className="msb-panel__link" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${user.roles.length} roles`}
          </button>
        )}
        {user.unconfirmedRoles.length > 0 && (
          <div className="msb-panel__hint">
            Granted by groups or containment but not active for the user (pending, or the group grant does not apply): {user.unconfirmedRoles.join(', ')}
          </div>
        )}

        {user.groups.length > 0 && (
          <>
            <div className="msb-acc__caption">Groups</div>
            <div className="msb-acc__groups">
              {user.groups.slice(0, 40).map((g) => (
                <span key={g.sysId} className={g.active ? 'msb-chip' : 'msb-chip msb-acc__inactive'} title={g.active ? '' : 'Inactive group'}>
                  <RecordLink table="sys_user_group" id={g.sysId}>
                    {g.name}
                  </RecordLink>
                </span>
              ))}
              {user.groups.length > 40 && <span className="msb-panel__hint">and {user.groups.length - 40} more</span>}
            </div>
          </>
        )}
      </div>
    </details>
  );
}

function OtherSection({ others }) {
  if (!others.length) return null;
  return (
    <details className="msb-acc__section" open>
      <summary>
        <span>Other things that affect access</span>
      </summary>
      <div className="msb-acc__body">
        {others.map((o, i) => (
          <div key={`${o.kind}-${i}`} className={`msb-acc__other msb-acc__other--${o.severity}`}>
            <div className="msb-acc__other-title">
              <Icon name={o.severity === 'warn' ? 'alert' : 'eye'} size={13} />
              <span>{o.title}</span>
            </div>
            {o.detail && <div className="msb-acc__other-detail">{o.detail}</div>}
            {o.items?.length > 0 && (
              <ul className="msb-acc__items">
                {o.items.map((item, j) => (
                  <li key={j}>
                    <RecordLink table={item.link?.table} id={item.link?.sysId}>
                      {item.name}
                    </RecordLink>
                    {item.meta && <span className="msb-panel__hint"> · {item.meta}</span>}
                    {item.condition && <pre className="msb-acc__pre">{item.condition}</pre>}
                    {item.script && (
                      <details className="msb-acc__more">
                        <summary>Show script</summary>
                        <pre className="msb-acc__pre">{item.script}</pre>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

const YES_NO = (v) => (v === true ? 'yes' : v === false ? 'no' : '-');

function RuntimeResult({ runtime, full }) {
  if (!runtime) return null;
  if (runtime.state === 'loading') return <div className="msb-panel__hint msb-acc__runtime">Asking the instance...</div>;
  if (runtime.state === 'error') return <div className="msb-panel__error">{runtime.error}</div>;
  const r = runtime.result;
  const answer = runtimeAnswer(r, full.request.operation, full.request.field);
  const expected = full.verdict.status === 'allowed' ? true : full.verdict.status === 'denied' ? false : null;
  let compare = '';
  if (answer !== null && expected !== null) compare = answer === expected ? 'Matches the trace.' : 'Differs from the trace: something the trace cannot see decides (a script, a condition, or an elevated role).';
  else if (answer !== null) compare = `The platform says ${answer ? 'allowed' : 'denied'}.`;
  const cell = (v) => <span className={v === true ? 'msb-acc__yes' : v === false ? 'msb-acc__no' : ''}>{YES_NO(v)}</span>;
  return (
    <div className="msb-acc__runtime">
      <div className="msb-acc__caption">
        Platform answer <span className="msb-acc__as">(as {r.user})</span>
      </div>
      <table className="msb-acc__grid">
        <thead>
          <tr>
            <th />
            <th>Read</th>
            <th>Write</th>
            <th>Create</th>
            <th>Delete</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>{full.request.sysId ? 'Record' : 'Table'}</th>
            <td>{cell(r.record.read)}</td>
            <td>{cell(r.record.write)}</td>
            <td>{cell(r.record.create)}</td>
            <td>{cell(r.record.delete)}</td>
          </tr>
          {r.field && (
            <tr>
              <th>{full.request.field}</th>
              <td>{cell(r.field.read)}</td>
              <td>{cell(r.field.write)}</td>
              <td>{cell(r.field.create)}</td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
      {compare && <div className="msb-acc__note">{compare}</div>}
      <div className="msb-panel__hint">ACLs only. Before-query business rules and domains are not part of this answer.</div>
    </div>
  );
}

function VerifySection({ full, runtime, onRun }) {
  const { verify, user } = full;
  return (
    <details className="msb-acc__section" open={!verify.canRunAsMe}>
      <summary>
        <span>Verify on the instance</span>
      </summary>
      <div className="msb-acc__body">
        {verify.canRunAsMe ? (
          <>
            <div className="msb-acc__note">This is you, so the platform can answer directly.</div>
            {!runtime && (
              <button className="msb-panel__secondary" onClick={onRun}>
                Check as me now
              </button>
            )}
            <div className="msb-panel__hint">Runs a read-only background script as you (needs admin). The answer appears under the verdict.</div>
          </>
        ) : (
          <ul className="msb-acc__steps">
            <li>Impersonate {user.name || user.userName} (user menu &gt; Impersonate user), open the record and try. End the impersonation afterwards.</li>
            {verify.analyzer ? (
              <li>
                {verify.analyzer.url ? (
                  <a className="msb-panel__link" href={verify.analyzer.url} target="_blank" rel="noopener noreferrer">
                    Open {verify.analyzer.title}
                  </a>
                ) : (
                  <span>{verify.analyzer.title} (System Security)</span>
                )}{' '}
                shows the ACLs a user, group or role passes without impersonating.
              </li>
            ) : (
              <li>The Access Analyzer was not found on this instance.</li>
            )}
            <li>System Security &gt; Debugging &gt; Debug Security Rules lists every ACL checked on a page while you are impersonating. Turn it off afterwards.</li>
          </ul>
        )}
      </div>
    </details>
  );
}

function InactiveSection({ inactive, related }) {
  if (!inactive.length && !related.length) return null;
  return (
    <details className="msb-acc__section">
      <summary>
        <span>Inactive and related ACLs</span>
      </summary>
      <div className="msb-acc__body">
        {inactive.length > 0 && (
          <>
            <div className="msb-acc__caption">Inactive (ignored)</div>
            <ul className="msb-acc__items">
              {inactive.map((a) => (
                <li key={a.sysId}>
                  <RecordLink table="sys_security_acl" id={a.sysId}>
                    {a.name}
                  </RecordLink>
                  {a.decision === 'deny' && <span className="msb-panel__badge">Deny-Unless</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        {related.length > 0 && (
          <>
            <div className="msb-acc__caption">Filtered queries</div>
            <div className="msb-panel__hint">query_range and query_match ACLs decide which filters the user may run, so a list can come back empty even when read passes.</div>
            <ul className="msb-acc__items">
              {related.map((a) => (
                <li key={a.sysId}>
                  <RecordLink table="sys_security_acl" id={a.sysId}>
                    {a.name}
                  </RecordLink>{' '}
                  <span className="msb-panel__badge">{a.operation}</span>
                  {a.roles.length > 0 && <span className="msb-panel__hint"> · {a.roles.join(', ')}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}

/** The verdict and the full trace. `full` is the trace from explainAccess({ full: true }). */
export function TraceView({ full, busy = false, runtime = null, copied = false, onRun, onAskAi, onCopy }) {
  const { verdict } = full;
  return (
    <div className={busy ? 'msb-acc__result msb-acc__result--stale' : 'msb-acc__result'} aria-busy={busy}>
      <div className={`msb-acc__verdict msb-acc__verdict--${verdict.status}`} role="status">
        <div className="msb-acc__verdict-top">
          <Icon name={VERDICT_ICON[verdict.status] || 'eye'} size={16} />
          <strong>{verdict.title}</strong>
        </div>
        <div className="msb-acc__verdict-who">
          {full.user.name || full.user.userName} · {full.request.operation} · {full.request.table}
          {full.request.field ? `.${full.request.field}` : ''}
          {full.record ? ` · ${full.record.label}` : full.request.sysId ? '' : ' · no record'}
        </div>
        <div className="msb-acc__reason">{verdict.reason}</div>
        {verdict.decidedBy.length > 0 && (
          <div className="msb-acc__decided">
            {verdict.status === 'allowed' ? 'Passed by' : verdict.status === 'denied' ? 'Decided by' : 'Waiting on'}:{' '}
            {verdict.decidedBy.map((dcd, i) => {
              // Several ACLs can share a name (one per operation or type); number them so the links can be told apart.
              const same = verdict.decidedBy.filter((x) => x.name === dcd.name);
              const nth = same.length > 1 ? ` (${same.indexOf(dcd) + 1} of ${same.length})` : '';
              return (
                <React.Fragment key={dcd.sysId}>
                  {i > 0 && ', '}
                  <RecordLink table="sys_security_acl" id={dcd.sysId}>
                    {dcd.name}
                    {nth}
                  </RecordLink>
                </React.Fragment>
              );
            })}
          </div>
        )}
        {verdict.caveats.map((c) => (
          <div key={c} className="msb-acc__caveat">
            <Icon name="alert" size={13} />
            <span>{c}</span>
          </div>
        ))}
      </div>

      <div className="msb-panel__actions">
        {full.verify.canRunAsMe && (
          <button className="msb-panel__secondary" onClick={onRun} disabled={runtime?.state === 'loading'} title="Ask the platform with a read-only background script">
            Check as me now
          </button>
        )}
        <button className="msb-panel__secondary" onClick={onAskAi}>
          Ask AI
        </button>
        <button className="msb-panel__secondary" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy trace'}
        </button>
      </div>

      {full.verify.canRunAsMe && runtime && <RuntimeResult runtime={runtime} full={full} />}

      <UserSection user={full.user} />
      {full.levels.map((level) => (
        <LevelSection key={level.level} level={level} hierarchy={full.hierarchy} />
      ))}
      <OtherSection others={full.others} />
      <InactiveSection inactive={full.inactive} related={full.related} />
      <VerifySection full={full} runtime={runtime} onRun={onRun} />

      {full.notes?.length > 0 && (
        <div className="msb-acc__notes">
          {full.notes.map((n) => (
            <div key={n} className="msb-panel__hint">
              {n}
            </div>
          ))}
        </div>
      )}
      <div className="msb-panel__hint msb-acc__pad">
        Roles are checked exactly. Conditions are checked against the record where possible. Scripts only run at runtime. A role path like "{pathLabel([{ kind: 'group', name: 'X' }, { kind: 'role', name: 'itil' }])}" means group X grants itil, which contains the role.
      </div>
    </div>
  );
}

/** "Why can't this user see / edit this?" ACL, role and visibility trace. */
export default function AccessDebuggerPanel({ context, params, services, onClose, onAskAi }) {
  const initialArgs = parseAccessArgs(params?.args || '');
  const startSysId = initialArgs.sysId || (context?.sysId && isSysId(context.sysId) && !context.isList ? context.sysId : '');

  const [me, setMe] = useState(null);
  const [user, setUser] = useState(null); // picked user; null = "me" or whatever was typed
  const [userText, setUserText] = useState(initialArgs.user && !/^me$/i.test(initialArgs.user) ? initialArgs.user : '');
  const [table, setTable] = useState(context?.table || '');
  const [sysId, setSysId] = useState(startSysId);
  const [operation, setOperation] = useState(initialArgs.operation || 'read');
  const [field, setField] = useState(initialArgs.field || '');
  const [fields, setFields] = useState(null);
  const [fieldsFor, setFieldsFor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [copied, setCopied] = useState(false);
  const runRef = useRef(0);
  const fieldsRef = useRef(0);

  async function loadFields(name) {
    const wanted = String(name || '').trim();
    const id = ++fieldsRef.current;
    if (!isName(wanted)) {
      setFields(null);
      setFieldsFor('');
      return;
    }
    if (wanted === fieldsFor && fields) return;
    try {
      const list = await services.accessTableFields(wanted);
      if (id !== fieldsRef.current) return;
      setFields(list);
      setFieldsFor(wanted);
    } catch {
      if (id !== fieldsRef.current) return;
      setFields(null);
      setFieldsFor('');
    }
  }

  async function explain(over = {}) {
    const args = {
      user: over.user ?? (user?.sysId || userText.trim()),
      table: String(over.table ?? table).trim(),
      sysId: String(over.sysId ?? sysId).trim(),
      field: over.field ?? field,
      operation: over.operation ?? operation,
      full: true,
    };
    if (!args.table) {
      setError('Enter a table.');
      return;
    }
    const id = ++runRef.current;
    setBusy(true);
    setError(null);
    setRuntime(null);
    try {
      const next = await services.explainAccess(args);
      if (id === runRef.current) setResult(next);
    } catch (err) {
      if (id === runRef.current) {
        setResult(null);
        setError(err.message);
      }
    } finally {
      if (id === runRef.current) setBusy(false);
    }
  }

  useEffect(() => {
    services
      .accessCurrentUser()
      .then(setMe)
      .catch(() => {});
    if (context?.table) loadFields(context.table);
    if (params?.args && context?.table) explain();
    // Runs once for the page the panel opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runRuntime() {
    const full = result?.full;
    if (!full) return;
    setRuntime({ state: 'loading' });
    try {
      const r = await services.accessRuntimeCheck({ userId: full.user.sysId, table: full.request.table, sysId: full.request.sysId, field: full.request.field });
      setRuntime(r.ok ? { state: 'done', result: r } : { state: 'error', error: r.error });
    } catch (err) {
      setRuntime({ state: 'error', error: err.message });
    }
  }

  function askAi() {
    const full = result.full;
    const who = full.user.userName || full.user.name;
    const target = `${full.request.table}${full.request.field ? `.${full.request.field}` : ''}`;
    onAskAi(
      `Explain access: can ${who} ${OPERATION_LABELS[full.request.operation]} ${target}?`,
      'Below is a ServiceNow access trace computed from the instance: the user, their roles (and how they got them), ' +
        'the ACLs in evaluation order with each check, and other things that can hide or lock records. ' +
        'Explain in plain English why the user does or does not get access and which rule decides. ' +
        'Then list the safest fix options (for example a role through a group, or a narrower ACL condition), ' +
        'and how to confirm the fix. Do not suggest giving admin or deactivating ACLs. "RUNTIME" means a condition or ' +
        'script is decided when the record is opened.\n\n' +
        redactSecrets(JSON.stringify(result.trace, null, 1)).slice(0, 14000)
    );
  }

  async function copyTrace() {
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy to the clipboard.');
    }
  }

  function pickMe() {
    setUser(null);
    setUserText('');
  }

  const full = result?.full;
  const fieldMissing = field && fields && !fields.some((f) => f.name === field);

  return (
    <div className="msb-panel msb-acc">
      <div className="msb-panel__header">
        <strong>Access debugger</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className="msb-panel__form">
        <div className="msb-acc__field">
          <span className="msb-acc__caption">User</span>
          <div className="msb-panel__row">
            <Typeahead
              value={user ? userLabel(user) : userText}
              onChange={(text) => {
                setUser(null);
                setUserText(text);
              }}
              onPick={(u) => {
                setUser(u);
                setUserText('');
              }}
              onEnter={() => !busy && explain()}
              search={async (text) => (await services.accessSearchUsers(text)).map((u) => ({ ...u, key: u.sysId }))}
              renderItem={(u) => (
                <>
                  <span className="msb-acc__ta-main">
                    {u.name || u.userName}
                    {!u.active && <span className="msb-acc__flag msb-acc__flag--bad">inactive</span>}
                  </span>
                  <span className="msb-acc__ta-sub">{[u.userName, u.email].filter(Boolean).join(' · ')}</span>
                </>
              )}
              placeholder={me ? `You (${me.name || me.userName}), or type a name` : 'You, or type a name'}
              label="User"
            />
            <button className="msb-panel__secondary" onClick={pickMe} disabled={!user && !userText} title="Check yourself">
              Me
            </button>
          </div>
        </div>

        <div className="msb-acc__field">
          <span className="msb-acc__caption">Table</span>
          <Typeahead
            value={table}
            onChange={(text) => {
              setTable(text);
              if (text.trim() !== fieldsFor) {
                setFields(null);
                setFieldsFor('');
              }
            }}
            onPick={(t) => {
              setTable(t.name);
              setField('');
              loadFields(t.name);
            }}
            onEnter={() => {
              loadFields(table);
              if (!busy) explain();
            }}
            search={async (text) => (await services.accessSearchTables(text)).map((t) => ({ ...t, key: t.name }))}
            renderItem={(t) => (
              <>
                <span className="msb-acc__ta-main">{t.label || t.name}</span>
                <span className="msb-acc__ta-sub">{t.name}</span>
              </>
            )}
            placeholder="Table, e.g. incident"
            label="Table"
          />
        </div>

        <div className="msb-acc__field">
          <span className="msb-acc__caption">Record sys_id (optional)</span>
          <input
            className="msb-acc__mono"
            value={sysId}
            onChange={(e) => setSysId(e.target.value.trim())}
            onKeyDown={(e) => e.key === 'Enter' && !busy && explain()}
            placeholder="Leave empty to check the table"
            aria-label="Record sys_id"
            spellCheck={false}
          />
        </div>

        <div className="msb-panel__row">
          <div className="msb-acc__field msb-acc__op">
            <span className="msb-acc__caption">Operation</span>
            <select value={operation} onChange={(e) => setOperation(e.target.value)} aria-label="Operation">
              {OPERATIONS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </div>
          <div className="msb-acc__field msb-acc__grow">
            <span className="msb-acc__caption">Field (optional)</span>
            {fields && !fieldMissing ? (
              <select value={field} onChange={(e) => setField(e.target.value)} aria-label="Field">
                <option value="">Whole record</option>
                {fields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                    {f.label && f.label !== f.name ? ` (${f.label})` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="msb-acc__mono"
                value={field}
                onChange={(e) => setField(e.target.value.trim())}
                onFocus={() => loadFields(table)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && explain()}
                placeholder="Whole record"
                aria-label="Field"
                spellCheck={false}
              />
            )}
          </div>
        </div>

        <button className="msb-panel__run" onClick={() => explain()} disabled={busy || !table.trim()}>
          {busy ? 'Tracing...' : 'Explain access'}
        </button>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}

      {!full && !busy && !error && (
        <div className="msb-panel__empty">
          Pick a user, a table and an operation. You get the roles, every ACL in the order ServiceNow checks them, and other rules that hide or lock records. Read-only.
        </div>
      )}
      {busy && !full && <div className="msb-panel__hint msb-acc__pad">Reading roles, groups and ACLs...</div>}

      {full && (
        <TraceView full={full} busy={busy} runtime={runtime} copied={copied} onRun={trusted(runRuntime)} onAskAi={askAi} onCopy={copyTrace} />
      )}
    </div>
  );
}
