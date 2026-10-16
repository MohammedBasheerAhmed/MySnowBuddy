import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { trusted } from './trusted.js';
import ShipCheck from './ShipCheck.jsx';
import MoveEntries from './MoveEntries.jsx';
import RemoteRecordPanel from './RemoteRecordPanel.jsx';
import { groupChangesBySet, myWorkWarnings, recordPathForEntry, timeAgo } from '../lib/updateSetReview.js';

function openPath(path) {
  // Root-relative paths built from validated table names and sys_ids only.
  if (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')) window.open(path, '_blank', 'noopener,noreferrer');
}

// A set literally named "Default" needs no extra Default badge next to its name.
const isDefaultName = (name) => String(name || '').trim().toLowerCase() === 'default';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

function Section({ title, action, children }) {
  return (
    <div className="msb-mw-section">
      <div className="msb-mw-section-title">
        <span>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

/**
 * "What am I working on?": current update set and application (with switchers), my
 * open update sets, my recent changes, and warnings (Default set, scope mismatch,
 * uncaptured changes). The ship check opens inside the same panel.
 */
export default function MyWorkPanel({ services, onClose, onAskAi }) {
  const [view, setView] = useState({ name: 'home' });
  const [ctx, setCtx] = useState(null);
  const [ctxError, setCtxError] = useState(null);
  const [sets, setSets] = useState(null);
  const [setsError, setSetsError] = useState(null);
  const [changes, setChanges] = useState(null);
  const [changesError, setChangesError] = useState(null);
  const [uncaptured, setUncaptured] = useState(null);
  const [uncapturedError, setUncapturedError] = useState(null);
  const [switcher, setSwitcher] = useState(null);
  const [targets, setTargets] = useState(null);
  const [choice, setChoice] = useState('');
  const [switching, setSwitching] = useState(false);
  const [switchNote, setSwitchNote] = useState(null);
  const [moveIds, setMoveIds] = useState(null);
  const generation = useRef(0);

  const available = typeof services?.myWorkContext === 'function';

  const load = useCallback(
    (refresh = false) => {
      if (!available) return;
      const gen = ++generation.current;
      const live = () => gen === generation.current;
      setCtxError(null);
      setSetsError(null);
      setChangesError(null);
      setUncapturedError(null);
      if (refresh) {
        setSets(null);
        setChanges(null);
        setUncaptured(null);
      }
      services
        .myWorkContext()
        .then((r) => live() && setCtx(r))
        .catch((err) => live() && setCtxError(err.message));
      const setsP = services
        .myWorkSets()
        .then((r) => live() && setSets(r))
        .catch((err) => live() && (setSets([]), setSetsError(err.message)));
      const changesP = services
        .myWorkChanges()
        .then((r) => live() && setChanges(r))
        .catch((err) => live() && (setChanges([]), setChangesError(err.message)));
      // The uncaptured scan is the slowest part (one query per config table), so it starts last.
      Promise.allSettled([setsP, changesP]).then(() => {
        if (!live()) return;
        services
          .myWorkUncaptured({ days: 7, refresh })
          .then((r) => live() && setUncaptured(r))
          .catch((err) => live() && setUncapturedError(err.message));
      });
    },
    [services, available]
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const warnings = useMemo(
    () => myWorkWarnings({ changes: changes || [], currentSet: ctx?.updateSet || null, currentApp: ctx?.application || null }),
    [changes, ctx]
  );
  const groups = useMemo(() => groupChangesBySet(changes || []), [changes]);

  if (!available) {
    return (
      <div className="msb-panel">
        <PanelHeader title="My work" onClose={onClose} />
        <div className="msb-panel__error">My work is unavailable on this page.</div>
      </div>
    );
  }

  async function openSwitcher(kind) {
    setSwitchNote(null);
    setSwitcher(kind);
    setChoice('');
    if (!targets) {
      try {
        setTargets(await services.myWorkSwitchTargets());
      } catch (err) {
        setSwitchNote({ tone: 'error', text: err.message });
      }
    }
  }

  async function doSwitch(kind, id) {
    if (!id) return;
    setSwitching(true);
    setSwitchNote(null);
    try {
      const r = kind === 'set' ? await services.myWorkSwitchUpdateSet(id) : await services.myWorkSwitchApplication(id);
      setCtx((prev) => ({ ...(prev || {}), updateSet: r.updateSet, application: r.application }));
      const now = kind === 'set' ? r.updateSet?.name : r.application?.name;
      setSwitchNote(
        r.applied
          ? { tone: 'ok', text: `Switched. The instance now reports "${now}". Reload the page if a form still shows the old one.` }
          : {
              tone: 'warn',
              text: `The instance still reports "${now || 'unknown'}". The switch may not have applied (this call is not yet verified on every release); use the platform picker in the header.`,
            }
      );
      setSwitcher(null);
      load(false);
    } catch (err) {
      setSwitchNote({ tone: 'error', text: err.message });
    } finally {
      setSwitching(false);
    }
  }

  if (view.name === 'review') {
    return (
      <div className="msb-panel">
        <PanelHeader title="Ship check" onClose={onClose} onBack={() => setView({ name: 'home' })} />
        <ShipCheck key={view.setId} services={services} initialSetId={view.setId} onAskAi={onAskAi} />
      </div>
    );
  }

  const current = ctx?.updateSet;
  const app = ctx?.application;
  const currentUsable = current && !current.isDefault && current.state === 'in progress';

  const sections = {
    // My open update sets
    sets: (
      <Section title="My open update sets">
        {sets === null && <div className="msb-panel__empty">Loading...</div>}
        {setsError && <div className="msb-panel__error">{setsError}</div>}
        {sets && !setsError && sets.length === 0 && <div className="msb-panel__empty">You have no update sets in progress.</div>}
        {sets && sets.length > 0 && (
          <div className="msb-mw-list">
            {sets.map((s) => {
              const isCurrent = current?.sysId === s.sysId;
              return (
                <div key={s.sysId} className="msb-mw-item">
                  <div className="msb-mw-item__main">
                    <div className="msb-mw-item__title">
                      {s.name}
                      {isCurrent && <span className="msb-mw-badge msb-mw-badge--accent">current</span>}
                      {s.isDefault && !isDefaultName(s.name) && <span className="msb-mw-badge msb-mw-badge--warn">Default</span>}
                    </div>
                    <div className="msb-mw-item__meta">
                      {s.entries === null ? 'entries: ?' : plural(s.entries, 'entry', 'entries')}
                      {s.lastChange ? ` · last change ${timeAgo(s.lastChange)}` : ''}
                      {s.applicationName ? ` · ${s.applicationName}` : ''}
                    </div>
                  </div>
                  <div className="msb-mw-item__actions">
                    <button className="msb-mw-small-btn" onClick={() => setView({ name: 'review', setId: s.sysId })}>
                      Ship check
                    </button>
                    {!isCurrent && (
                      <button className="msb-mw-small-btn" onClick={trusted(() => doSwitch('set', s.sysId))} disabled={switching}>
                        Make current
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {current && !current.isDefault && current.state === 'in progress' && sets && !sets.some((s) => s.sysId === current.sysId) && (
          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={() => setView({ name: 'review', setId: current.sysId })}>
              Ship check "{current.name}"
            </button>
          </div>
        )}
      </Section>
    ),
    // My recent changes
    changes: (
      <Section title="My recent changes">
        {changes === null && <div className="msb-panel__empty">Loading...</div>}
        {changesError && <div className="msb-panel__error">{changesError}</div>}
        {changes && !changesError && changes.length === 0 && <div className="msb-panel__empty">No captured changes by you yet.</div>}
        {groups.length > 0 && (
          <div className="msb-mw-list">
            {groups.map((g) => (
              <React.Fragment key={g.setId}>
                <div className="msb-mw-group">
                  {g.setName}
                  {g.isDefault && <span className="msb-mw-badge msb-mw-badge--warn">{isDefaultName(g.setName) ? 'will not ship' : 'Default'}</span>}
                  {g.setState && g.setState !== 'in progress' && <span className="msb-mw-badge">{g.setState}</span>}
                </div>
                {g.changes.map((c) => (
                  <div key={c.sys_id} className="msb-mw-item">
                    <div className="msb-mw-item__main">
                      <div className="msb-mw-item__title">
                        {c.target_name || c.name}
                        {String(c.action).toUpperCase() === 'DELETE' && <span className="msb-mw-badge msb-mw-badge--danger">delete</span>}
                      </div>
                      <div className="msb-mw-item__meta">
                        {c.type} &middot; {timeAgo(c.sys_updated_on)}
                      </div>
                    </div>
                    <div className="msb-mw-item__actions">
                      <button className="msb-mw-small-btn" onClick={() => openPath(recordPathForEntry(c))}>
                        Open
                      </button>
                    </div>
                  </div>
                ))}
              </React.Fragment>
            ))}
          </div>
        )}
      </Section>
    ),
  };

  return (
    <div className="msb-panel">
      <PanelHeader title="My work" onClose={onClose} onRefresh={() => load(true)} />

      {/* Where am I working? */}
      <div className="msb-mw-card">
        {!ctx && !ctxError && <div className="msb-panel__empty">Reading your session...</div>}
        {ctxError && <div className="msb-panel__error">{ctxError}</div>}
        {ctx && !ctx.user && !ctx.updateSet && !ctx.application && ctx.errors?.length > 0 && (
          <div className="msb-panel__error">{ctx.errors[0]}</div>
        )}
        {ctx && (
          <>
            <div className="msb-mw-row">
              <span className="msb-mw-label">Update set</span>
              <span className="msb-mw-value" title={current?.name || ''}>
                {current ? current.name : 'Unknown'}
                {current?.isDefault && !isDefaultName(current.name) && <span className="msb-mw-badge msb-mw-badge--warn">Default</span>}
                {current?.state && current.state !== 'in progress' && <span className="msb-mw-badge">{current.state}</span>}
              </span>
              <button className="msb-mw-small-btn" onClick={() => openSwitcher('set')} disabled={switching}>
                Switch
              </button>
            </div>
            <div className="msb-mw-row">
              <span className="msb-mw-label">Scope</span>
              <span className="msb-mw-value" title={app?.name || ''}>
                {app ? app.name : 'Unknown'}
              </span>
              <button className="msb-mw-small-btn" onClick={() => openSwitcher('app')} disabled={switching}>
                Switch
              </button>
            </div>
            {ctx.user && (
              <div className="msb-mw-muted msb-mw-signed-in">
                Signed in as {ctx.user.userName}
                {ctx.instance?.label ? ` on ${ctx.instance.host} (${ctx.instance.label})` : ''}
                {current?.source === 'preference' ? ' · update set read from your user preference' : ''}
              </div>
            )}
          </>
        )}

        {switcher && (
          <div className="msb-mw-inline-form">
            <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={!targets || switching} aria-label={switcher === 'set' ? 'Update set' : 'Application'}>
              <option value="">{targets ? (switcher === 'set' ? 'Pick an in-progress update set' : 'Pick an application') : 'Loading...'}</option>
              {switcher === 'set' &&
                (targets?.sets || []).map((s) => (
                  <option key={s.sysId} value={s.sysId}>
                    {s.name}
                    {s.applicationName ? ` [${s.applicationName}]` : ''}
                  </option>
                ))}
              {switcher === 'app' &&
                (targets?.apps || []).map((a) => (
                  <option key={a.sys_id} value={a.sys_id}>
                    {a.name}
                  </option>
                ))}
            </select>
            <button className="msb-panel__run" onClick={trusted(() => doSwitch(switcher, choice))} disabled={!choice || switching}>
              {switching ? 'Switching...' : 'Switch'}
            </button>
            <button className="msb-panel__secondary" onClick={() => setSwitcher(null)} disabled={switching}>
              Cancel
            </button>
          </div>
        )}
        {switchNote && (
          <div className={switchNote.tone === 'ok' ? 'msb-mw-ok' : switchNote.tone === 'warn' ? 'msb-panel__warning' : 'msb-panel__error'}>
            {switchNote.text}{' '}
            {switchNote.tone !== 'error' && (
              <button className="msb-panel__link" onClick={() => window.location.reload()}>
                Reload page
              </button>
            )}
          </div>
        )}
      </div>

      {/* Warnings */}
      {ctx && warnings.currentIsDefault && (
        <div className="msb-panel__warning">
          Your current update set is a Default one. Changes you make now will not ship with a named set.{' '}
          <button className="msb-panel__link" onClick={() => openSwitcher('set')}>
            Switch
          </button>
        </div>
      )}
      {ctx && warnings.currentMismatch && (
        <div className="msb-panel__warning">
          Your update set belongs to {current?.applicationName || 'another application'}, but your current scope is {app?.name}. Changes
          to records in {app?.name} go to a different update set.
        </div>
      )}
      {warnings.defaultChanges.length > 0 && (
        <div className="msb-panel__warning">
          {plural(warnings.defaultChanges.length, 'of your recent changes is', 'of your recent changes are')} in a Default update set and
          will not ship with your work.{' '}
          {currentUsable ? (
            <button className="msb-panel__link" onClick={() => setMoveIds(warnings.defaultChanges.slice(0, 25).map((c) => c.sys_id))}>
              Move {warnings.defaultChanges.length > 25 ? 'the first 25' : 'them'} to "{current.name}"...
            </button>
          ) : (
            'Switch to a named update set, then move them.'
          )}
        </div>
      )}
      {warnings.scopeMismatches.length > 0 && (
        <div className="msb-panel__warning">
          {plural(warnings.scopeMismatches.length, 'change sits', 'changes sit')} in an update set of another application scope:{' '}
          {warnings.scopeMismatches
            .slice(0, 4)
            .map((c) => c.target_name || c.name)
            .join(', ')}
          {warnings.scopeMismatches.length > 4 ? '...' : ''}. These usually fail preview on the target.
        </div>
      )}

      {uncaptured?.uncaptured.length > 0 && (
        <div className="msb-panel__warning">
          {plural(uncaptured.uncaptured.length, 'record you changed', 'records you changed')} in the last 7 days{' '}
          {uncaptured.uncaptured.length === 1 ? 'is' : 'are'} not in any update set, so {uncaptured.uncaptured.length === 1 ? 'it' : 'they'}{' '}
          will not leave this instance. See the list at the bottom.
        </div>
      )}

      {moveIds && (
        <MoveEntries
          services={services}
          entryIds={moveIds}
          defaultTargetId={currentUsable ? current.sysId : ''}
          onCancel={() => setMoveIds(null)}
          onDone={() => {
            setMoveIds(null);
            load(false);
          }}
        />
      )}

      {sections.sets}
      {sections.changes}

      {/* Uncaptured: the slowest check, so it sits last and does not push the rest down when it lands. */}
      <Section title="Not in any update set (7 days)">
        {!uncaptured && !uncapturedError && <div className="msb-panel__empty">Checking your recent configuration changes...</div>}
        {uncapturedError && <div className="msb-panel__error">{uncapturedError}</div>}
        {uncaptured && uncaptured.uncaptured.length === 0 && (
          <div className="msb-panel__empty">
            Every configuration record you changed is captured ({uncaptured.checked} checked).
            {uncaptured.errors?.length ? ` Skipped: ${uncaptured.errors.map((e) => e.table).join(', ')}.` : ''}
          </div>
        )}
        {uncaptured && uncaptured.uncaptured.length > 0 && (
          <>
            <div className="msb-panel__hint">
              Best effort: matched by update name, and some records are excluded from capture on purpose. These will not leave this
              instance.
            </div>
            <div className="msb-mw-list" style={{ marginTop: 4 }}>
              {uncaptured.uncaptured.slice(0, 20).map((u) => (
                <div key={`${u.table}:${u.sysId}`} className="msb-mw-item">
                  <div className="msb-mw-item__main">
                    <div className="msb-mw-item__title">
                      {u.name}
                      <span className="msb-mw-badge">{u.label}</span>
                    </div>
                    <div className="msb-mw-item__meta">changed {timeAgo(u.updatedOn)}</div>
                  </div>
                  <div className="msb-mw-item__actions">
                    <button className="msb-mw-small-btn" onClick={() => openPath(`/${u.table}.do?sys_id=${u.sysId}`)}>
                      Open
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {uncaptured.uncaptured.length > 20 && <div className="msb-panel__hint">... {uncaptured.uncaptured.length - 20} more.</div>}
          </>
        )}
      </Section>

    </div>
  );
}

function PanelHeader({ title, onClose, onBack, onRefresh }) {
  return (
    <div className="msb-panel__header">
      <strong>
        {onBack && (
          <button onClick={onBack} aria-label="Back to My work" title="Back to My work" style={{ marginRight: 4, verticalAlign: 'middle' }}>
            <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
              <Icon name="chevron" size={15} />
            </span>
          </button>
        )}
        {title}
      </strong>
      <span className="msb-mw-header-actions">
        {onRefresh && (
          <button onClick={onRefresh} aria-label="Refresh" title="Refresh">
            <Icon name="refresh" size={15} />
          </button>
        )}
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </span>
    </div>
  );
}

/** /ship and /review-set: the ship check on its own. The text after the command picks the set. */
export function ShipCheckPanel({ services, onClose, onAskAi, params }) {
  const args = String(params?.args || '').trim();
  const isId = /^[0-9a-f]{32}$/i.test(args);
  return (
    <div className="msb-panel">
      <PanelHeader title="Ship check" onClose={onClose} />
      <ShipCheck services={services} initialSetId={isId ? args.toLowerCase() : ''} initialQuery={isId ? '' : args} onAskAi={onAskAi} />
    </div>
  );
}

/** /push [host]: the record on screen, straight into the push preview. */
export function PushPanel({ context, services, onClose, params }) {
  return <RemoteRecordPanel context={context} services={services} onClose={onClose} initialHost={params?.args || ''} pushFirst />;
}

export const MY_WORK_PANELS = [
  {
    name: 'mywork',
    title: 'My work',
    hint: 'Update set, scope, open sets, recent changes',
    launcherHint: 'Update set, scope, changes',
    icon: 'briefcase',
    slash: ['/mywork', '/me'],
    help: 'your update set and scope, open sets, recent changes, warnings',
    keywords: 'my work update set scope application switch default uncaptured changes',
    group: 'tools',
    launcher: true,
    component: MyWorkPanel,
  },
  {
    name: 'shipcheck',
    title: 'Ship check',
    hint: 'Pre-commit review of an update set',
    icon: 'check',
    slash: ['/ship', '/review-set'],
    help: 'pre-commit checklist, release notes (/ship <set name>)',
    keywords: 'update set review commit release notes deploy checklist collisions',
    group: 'analyze',
    component: ShipCheckPanel,
  },
  {
    name: 'push',
    title: 'Push to instance',
    hint: 'Copy this record to another instance, with a preview',
    icon: 'upload',
    slash: ['/push'],
    help: 'copy this record to another instance (/push <host>; preview first)',
    keywords: 'push deploy copy promote instance record',
    group: 'record',
    withContext: true,
    component: PushPanel,
  },
];
