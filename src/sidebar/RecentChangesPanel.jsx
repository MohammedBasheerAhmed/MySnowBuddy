import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FieldChanges } from './DiffView.jsx';
import {
  WINDOWS,
  SCOPES,
  GROUPINGS,
  groupChanges,
  facet,
  headline,
  isNewSince,
  nextMarker,
  relevance,
  ageText,
  changesToMarkdown,
} from '../lib/recentChanges.js';
import { downloadText, suggestFilename } from '../lib/report.js';

const recordHref = (row) => (row.table && row.sysId ? `/${row.table}.do?sys_id=${row.sysId}` : `/sys_update_xml.do?sys_id=${encodeURIComponent(row.id)}`);

function Badge({ tone, children }) {
  return <span className={`msb-recent__badge msb-recent__badge--${tone}`}>{children}</span>;
}

function ChangeRow({ row, marker, ctx, services, nowMs }) {
  const [diff, setDiff] = useState(null); // { busy, error, result }
  const touch = relevance(row, ctx);
  const fresh = isNewSince(row, marker);

  async function compare() {
    if (diff?.result) {
      setDiff(null);
      return;
    }
    setDiff({ busy: true });
    try {
      setDiff({ result: await services.recentChangesDiff({ table: row.table, sysId: row.sysId }) });
    } catch (err) {
      setDiff({ error: err.message });
    }
  }

  const canCompare = Boolean(row.table && row.sysId) && row.action !== 'DELETE' && (row.versionCount === undefined || row.versionCount >= 2);
  return (
    <li className="msb-recent__row">
      <div className="msb-recent__headline">{headline(row)}</div>
      <div className="msb-recent__meta">
        <span title={`${row.when} UTC`}>{ageText(row.when, nowMs)}</span>
        {row.appName && <span>{row.appName}</span>}
        {row.latestVersion && row.latestVersion.by && row.latestVersion.by !== row.who && <span>last saved by {row.latestVersion.by}</span>}
        {fresh && <Badge tone="new">new</Badge>}
        {touch === 'record' && <Badge tone="hit">this record</Badge>}
        {touch === 'table' && <Badge tone="near">this table</Badge>}
        {row.action === 'DELETE' && <Badge tone="del">deleted</Badge>}
      </div>
      <div className="msb-recent__actions">
        <a className="msb-panel__link" href={recordHref(row)} target="_blank" rel="noopener noreferrer">
          Open
        </a>
        {canCompare && (
          <button type="button" className="msb-panel__secondary" onClick={compare} disabled={diff?.busy} aria-expanded={Boolean(diff?.result)}>
            {diff?.busy ? 'Comparing...' : diff?.result ? 'Hide comparison' : 'Compare with previous version'}
          </button>
        )}
      </div>
      {diff?.error && <div className="msb-panel__error">{diff.error}</div>}
      {diff?.result && (
        <div className="msb-recent__diff">
          {diff.result.note ? (
            <div className="msb-panel__hint">{diff.result.note}</div>
          ) : (
            <>
              <div className="msb-panel__hint">
                Version of {diff.result.from.at} ({diff.result.from.by || 'unknown'}) compared with {diff.result.to.at} ({diff.result.to.by || 'unknown'})
              </div>
              <FieldChanges changes={diff.result.changes} />
            </>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * What changed lately? (/recent): configuration changes by anyone in a window, grouped, with the version diff one click away.
 * Data comes from services.recentChangesLoad (src/content/recentChanges.js); read-only.
 */
export default function RecentChangesPanel({ context, services, onClose }) {
  const [win, setWin] = useState('today');
  const [days, setDays] = useState(7);
  const [scope, setScope] = useState('all');
  const [by, setBy] = useState('application');
  const [app, setApp] = useState('');
  const [type, setType] = useState('');
  const [hideSystem, setHideSystem] = useState(true);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const runId = useRef(0);
  const [nowMs] = useState(() => Date.now());

  async function load(next = {}) {
    runId.current += 1;
    const id = runId.current;
    setBusy(true);
    setError(null);
    try {
      const result = await services.recentChangesLoad({ window: win, days, scope, hideSystem, ...next });
      if (id === runId.current) {
        setData(result);
        setApp('');
        setType('');
      }
    } catch (err) {
      if (id === runId.current) setError(err.message);
    } finally {
      if (id === runId.current) setBusy(false);
    }
  }

  useEffect(() => {
    load();
    return () => {
      runId.current += 1;
    };
    // Loads once when the panel opens; the controls reload on demand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ctx = useMemo(() => ({ table: context?.table || '', sysId: context?.sysId || '' }), [context]);
  const all = data?.rows || [];
  const rows = useMemo(() => all.filter((r) => (!app || r.appId === app) && (!type || r.type === type)), [all, app, type]);
  const apps = useMemo(() => facet(all, 'application'), [all]);
  const types = useMemo(() => facet(all, 'type'), [all]);
  const marker = data?.marker || '';
  const newCount = useMemo(() => rows.filter((r) => isNewSince(r, marker)).length, [rows, marker]);
  const people = useMemo(() => new Set(rows.map((r) => r.who).filter(Boolean)).size, [rows]);
  const mine = useMemo(() => rows.filter((r) => relevance(r, ctx)), [rows, ctx]);
  const groups = useMemo(() => groupChanges(rows, by), [rows, by]);

  function flash(text) {
    setNotice(text);
    setTimeout(() => setNotice(null), 3000);
  }

  async function markSeen() {
    const next = nextMarker(all, marker);
    if (await services.recentChangesMarkSeen(next)) {
      setData((d) => ({ ...d, marker: next }));
      flash('Marked as seen. Newer changes will show as new.');
    }
  }

  const markdown = () => changesToMarkdown(rows, { windowLabel: data?.windowLabel, host: data?.host, by });

  return (
    <div className="msb-panel msb-recent">
      <div className="msb-panel__header">
        <strong>What changed lately?</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className="msb-panel__form msb-recent__controls">
        <label>
          When
          <select value={win} onChange={(e) => setWin(e.target.value)}>
            {WINDOWS.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        {win === 'custom' && (
          <label>
            Days (1-90)
            <input type="number" min="1" max="90" value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
        )}
        <label>
          Who
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            {SCOPES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="msb-panel__check">
          <input type="checkbox" checked={hideSystem} onChange={(e) => setHideSystem(e.target.checked)} />
          Hide changes made by the system
        </label>
        <button className="msb-panel__run" onClick={() => load()} disabled={busy}>
          {busy ? 'Loading...' : 'Show changes'}
        </button>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}
      {notice && <div className="msb-panel__hint">{notice}</div>}
      {data?.errors?.map((e) => (
        <div key={e} className="msb-panel__hint">
          {e}
        </div>
      ))}

      {data && (
        <>
          <div className="msb-recent__summary">
            <strong>
              {rows.length} change{rows.length === 1 ? '' : 's'}
            </strong>{' '}
            in {data.windowLabel}, by {people} {people === 1 ? 'person' : 'people'}
            {data.truncated && <div className="msb-panel__hint">Showing the newest {all.length}. Choose a shorter window to see them all.</div>}
            {marker ? (
              <div className="msb-recent__since">
                <span>
                  {newCount} new since you last looked ({marker} UTC)
                </span>
                <button type="button" className="msb-panel__secondary" onClick={markSeen}>
                  Mark all as seen
                </button>
              </div>
            ) : (
              <div className="msb-recent__since">
                <span>You have not marked anything as seen yet.</span>
                <button type="button" className="msb-panel__secondary" onClick={markSeen}>
                  Mark all as seen
                </button>
              </div>
            )}
          </div>

          <div className="msb-panel__form msb-recent__controls">
            <label>
              Group by
              <select value={by} onChange={(e) => setBy(e.target.value)}>
                {GROUPINGS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Application
              <select value={app} onChange={(e) => setApp(e.target.value)}>
                <option value="">All ({apps.length})</option>
                {apps.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label} ({a.count})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Type
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">All ({types.length})</option>
                {types.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label} ({t.count})
                  </option>
                ))}
              </select>
            </label>
          </div>

          {mine.length > 0 && (
            <div className="msb-recent__mine">
              <div className="msb-recent__group-title">Touching what you are working on ({mine.length})</div>
              <ul className="msb-recent__list">
                {mine.map((row) => (
                  <ChangeRow key={`mine-${row.id}`} row={row} marker={marker} ctx={ctx} services={services} nowMs={nowMs} />
                ))}
              </ul>
            </div>
          )}

          {!rows.length && !busy && <div className="msb-panel__empty">Nothing changed in {data.windowLabel}{app || type ? ' with these filters' : ''}.</div>}

          {groups.map((g) => (
            <details key={g.key || 'all'} className="msb-recent__group" open={groups.length === 1 || g === groups[0]}>
              {g.key && (
                <summary className="msb-panel__result-toggle">
                  <span className="msb-recent__group-title">{g.key}</span>
                  <span className="msb-panel__badge">{g.count}</span>
                </summary>
              )}
              <ul className="msb-recent__list">
                {g.rows.map((row) => (
                  <ChangeRow key={row.id} row={row} marker={marker} ctx={ctx} services={services} nowMs={nowMs} />
                ))}
              </ul>
            </details>
          ))}

          {rows.length > 0 && (
            <div className="msb-panel__actions">
              <button
                className="msb-panel__secondary"
                onClick={() =>
                  navigator.clipboard
                    ?.writeText(markdown())
                    .then(() => flash('Copied as Markdown.'))
                    .catch(() => flash('The browser did not allow copying.'))
                }
              >
                Copy as Markdown
              </button>
              <button className="msb-panel__secondary" onClick={() => downloadText(suggestFilename('recent-changes', 'md'), markdown(), 'text/markdown')}>
                Download
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
