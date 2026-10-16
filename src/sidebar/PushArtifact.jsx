import React, { useEffect, useMemo, useState } from 'react';
import { FieldChanges } from './DiffView.jsx';
import { planPush, confirmMatches } from '../lib/pushArtifact.js';
import { trusted } from './trusted.js';

/**
 * Push one configuration record to another instance: preview (target copy, field diff,
 * warnings), explicit confirmation (typed name on guarded instances), write through the
 * service worker, then show what the target now holds.
 *
 * Props:
 *   table, sysId        the source record
 *   targetHost          *.service-now.com host to write to
 *   sourceUrl           read the source from this instance (Instance Compare); omit to read it
 *                       from the current page's instance through services.pushPreviewFromPage
 *   services            sidebar services (needed when sourceUrl is omitted)
 *   recordName          display name, for the audit log
 *   onClose
 */
export default function PushArtifact({ table, sysId, targetHost, sourceUrl = '', services, recordName = '', onClose }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [typed, setTyped] = useState('');
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState(null);
  const [caseConfirmed, setCaseConfirmed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);
    const load = sourceUrl
      ? chrome.runtime
          .sendMessage({ type: 'PUSH_PREVIEW', payload: { targetUrl: targetHost, table, sourceUrl, sourceSysId: sysId } })
          .then((r) => {
            if (!r?.ok) throw new Error(r?.error || 'Could not reach the instances.');
            return r;
          })
      : services?.pushPreviewFromPage
        ? services.pushPreviewFromPage({ host: targetHost, table, sysId })
        : Promise.reject(new Error('Push is unavailable on this page.'));
    load
      .then((r) => !cancelled && setPreview(r))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [table, sysId, targetHost, sourceUrl, services]);

  const plan = useMemo(
    () => (preview ? planPush({ table, source: preview.source, target: preview.target, matchedBy: preview.matchedBy }) : null),
    [preview, table]
  );

  async function handlePush() {
    setPushing(true);
    setError(null);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'PUSH_ARTIFACT',
        payload: {
          targetUrl: preview.targetHost,
          table,
          mode: plan.mode,
          targetSysId: plan.targetSysId,
          fields: plan.payload,
          confirmName: typed,
          expectedUpdatedOn: preview.target?.sys_updated_on || '',
          sourceHost: preview.sourceHost,
          sourceSysId: sysId,
          recordName: recordName || preview.source?.name || '',
          // The worker re-plans from this (the previewed source) and a fresh read of the target.
          sourceRecord: preview.source,
          matchedBy: preview.matchedBy,
          confirmCaseMatch: caseConfirmed,
        },
      });
      if (!response?.ok) throw new Error(response?.error || 'The push failed.');
      setResult(response);
    } catch (err) {
      setError(err.message);
    } finally {
      setPushing(false);
    }
  }

  const host = preview?.targetHost || targetHost;
  const guard = preview?.guard;

  if (result) {
    return (
      <div className="msb-mw-confirm">
        <div className="msb-mw-ok">
          {result.mode === 'create' ? 'Created' : 'Updated'} on {result.host}: {result.written.length} field(s) written
          {result.auth === 'basic' ? ' (with the credentials saved in Options)' : ' (with your browser session)'}. Re-read from the
          target to confirm.
        </div>
        {result.mismatched.length > 0 && (
          <div className="msb-panel__warning">
            The target now holds different values for: {result.mismatched.join(', ')}. A business rule or data policy there probably
            changed them.
          </div>
        )}
        {result.keptSysId === false && (
          <div className="msb-panel__warning">The target gave the new record a different sys_id, so later update sets will not line up with it.</div>
        )}
        <div className="msb-panel__actions">
          <button className="msb-panel__run" onClick={() => window.open(result.url, '_blank', 'noopener,noreferrer')}>
            Open on {result.host}
          </button>
          {onClose && (
            <button className="msb-panel__secondary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    );
  }

  const canPush =
    plan &&
    !plan.blockers.length &&
    plan.mode !== 'none' &&
    !pushing &&
    (!guard?.guarded || confirmMatches(typed, guard.instance)) &&
    (!preview?.nameCaseDiffers || caseConfirmed);

  return (
    <div className="msb-mw-confirm">
      <div className="msb-mw-confirm__title">Push to {host}</div>
      <div className="msb-panel__warning">
        This writes straight into {host}, into whatever update set is current there for your user, and skips your normal promotion
        path. Use update sets for real deployments.
      </div>

      {loading && <div className="msb-panel__empty">Reading both copies...</div>}
      {error && <div className="msb-panel__error">{error}</div>}

      {preview && plan && (
        <>
          <div className="msb-panel__hint" style={{ marginTop: 8 }}>
            From {preview.sourceHost} to {preview.targetHost}.{' '}
            {preview.refused
              ? ''
              : preview.matchedBy === 'sys_id'
                ? 'Matched the target copy by sys_id.'
                : preview.matchedBy === 'name'
                  ? `Matched the target copy by ${(preview.matchKeys || ['name']).join(' + ')} (the sys_id differs).`
                  : 'Not found on the target by sys_id or name: a new record will be created with the same sys_id.'}
          </div>
          {preview.session && (
            <div className="msb-panel__hint">
              Captured on the target as {preview.session.userName}
              {preview.session.updateSet
                ? ` in "${preview.session.updateSet.name}" (from that user's update set preference; may differ).`
                : ' (no update set preference found there, so probably its Default set).'}
            </div>
          )}

          {plan.blockers.map((b) => (
            <div key={b} className="msb-panel__error">
              {b}
            </div>
          ))}
          {plan.warnings.map((w) => (
            <div key={w} className="msb-panel__warning">
              {w}
            </div>
          ))}

          {!plan.blockers.length && plan.mode === 'none' && <div className="msb-mw-ok">Nothing to push: the target already matches.</div>}

          {!plan.blockers.length && plan.mode === 'update' && preview.nameCaseDiffers && (
            <label className="msb-panel__check msb-mw-case-check">
              <input type="checkbox" checked={caseConfirmed} onChange={trusted((e) => setCaseConfirmed(e.target.checked))} />
              The target&apos;s {(preview.matchKeys || ['name']).join(' + ')} differs only in letter case (&quot;
              {(preview.matchKeys || ['name']).map((k) => String(preview.target?.[k] ?? '')).join(' / ')}&quot;). It is the same record.
            </label>
          )}

          {!plan.blockers.length && plan.changes.length > 0 && (
            <>
              <div className="msb-panel__counts">
                {plan.mode === 'create' ? `Fields set on the new record (${plan.changes.length})` : `Fields that change on the target (${plan.changes.length})`}
              </div>
              <div className="msb-panel__hint">Expand a field to see target (-) against source (+). sys_* fields are never written.</div>
              <FieldChanges changes={plan.changes} />
            </>
          )}

          {!plan.blockers.length && plan.mode !== 'none' && guard?.guarded && (
            <label className="msb-mw-confirm__typed">
              {guard.prod ? `${host} is a production instance.` : `${host} is not recognisably dev, test or stage.`} Type its name (
              {guard.instance}) to allow the write.
              <input value={typed} onChange={trusted((e) => setTyped(e.target.value))} placeholder={guard.instance} aria-label="Target instance name" />
            </label>
          )}

          <div className="msb-panel__actions">
            {plan.mode !== 'none' && !plan.blockers.length && (
              <button className={guard?.guarded ? 'msb-mw-danger-btn' : 'msb-panel__run'} onClick={trusted(handlePush)} disabled={!canPush}>
                {pushing
                  ? 'Pushing...'
                  : plan.mode === 'create'
                    ? `Create on ${host}`
                    : `Write ${plan.changes.length} field${plan.changes.length === 1 ? '' : 's'} to ${host}`}
              </button>
            )}
            {onClose && (
              <button className="msb-panel__secondary" onClick={onClose} disabled={pushing}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
