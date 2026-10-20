import React, { useEffect, useMemo, useRef, useState } from 'react';
import { releaseNotesToMarkdown, releaseNotesToText } from '../lib/releaseNotes.js';
import { VERDICT_TEXT } from '../lib/updateSetReview.js';
import { downloadText, suggestFilename } from '../lib/report.js';

const SYS_ID = /^[0-9a-f]{32}$/i;

/**
 * Release notes (/release): what an update set changes, what is risky, what to test and how to back out, ready to paste
 * into a ticket. Data comes from services.releaseNotesBuild (src/content/releaseNotes.js); read-only, no AI.
 */
export default function ReleaseNotesPanel({ params, services, onClose }) {
  const [sets, setSets] = useState(null);
  const [setId, setSetId] = useState('');
  const [result, setResult] = useState(null); // { model, verdict, set }
  const [format, setFormat] = useState('markdown');
  const [testing, setTesting] = useState(true);
  const [deployment, setDeployment] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const runId = useRef(0);

  async function generate(id = setId) {
    if (!SYS_ID.test(id)) return;
    runId.current += 1;
    const mine = runId.current;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const built = await services.releaseNotesBuild(id);
      if (mine === runId.current) setResult(built);
    } catch (err) {
      if (mine === runId.current) setError(err.message);
    } finally {
      if (mine === runId.current) setBusy(false);
    }
  }

  useEffect(() => {
    let live = true;
    services
      .releaseNotesSets()
      .then((r) => {
        if (!live) return;
        setSets(r.sets);
        const wanted = String(params?.args || '').trim();
        const first = SYS_ID.test(wanted) ? wanted : r.currentId || r.sets[0]?.sysId || '';
        setSetId(first);
        if (SYS_ID.test(wanted)) generate(first);
      })
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
      runId.current += 1;
    };
    // Runs once per panel instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const text = useMemo(() => {
    if (!result) return '';
    const options = { testing, deployment };
    return format === 'markdown' ? releaseNotesToMarkdown(result.model, options) : releaseNotesToText(result.model, options);
  }, [result, format, testing, deployment]);

  function flash(message) {
    setNotice(message);
    setTimeout(() => setNotice(null), 3000);
  }

  const model = result?.model;
  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Release notes</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className="msb-panel__form">
        <label>
          Update set
          <select value={setId} onChange={(e) => setSetId(e.target.value)} disabled={!sets || busy}>
            {!sets && <option value="">Loading...</option>}
            {sets?.map((s) => (
              <option key={s.sysId} value={s.sysId}>
                {s.name} ({s.state}
                {s.applicationName ? `, ${s.applicationName}` : ''})
              </option>
            ))}
          </select>
        </label>
        <button className="msb-panel__run" onClick={() => generate()} disabled={!SYS_ID.test(setId) || busy}>
          {busy ? 'Reading the update set...' : 'Generate release notes'}
        </button>
        <div className="msb-panel__hint">Reads the update set and the checks from the Ship check. Nothing is changed and no AI is used.</div>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}
      {notice && <div className="msb-panel__hint">{notice}</div>}

      {model && (
        <>
          <div className="msb-notes__facts">
            <span className="msb-panel__badge">{model.counts.total} changes</span>
            {model.counts.created > 0 && <span className="msb-panel__badge">{model.counts.created} new</span>}
            {model.counts.deleted > 0 && <span className="msb-panel__badge">{model.counts.deleted} deleted</span>}
            <span className="msb-panel__badge">{model.risks.length} risk {model.risks.length === 1 ? 'area' : 'areas'}</span>
            {result.verdict && <span className="msb-panel__badge">Ship check: {VERDICT_TEXT[result.verdict] || result.verdict}</span>}
          </div>

          <div className="msb-notes__tabs" role="group" aria-label="Format">
            <button type="button" className="msb-panel__secondary" aria-pressed={format === 'markdown'} onClick={() => setFormat('markdown')}>
              Markdown
            </button>
            <button type="button" className="msb-panel__secondary" aria-pressed={format === 'text'} onClick={() => setFormat('text')}>
              Plain text for a ticket
            </button>
          </div>
          <div className="msb-panel__form msb-recent__controls">
            <label className="msb-panel__check">
              <input type="checkbox" checked={testing} onChange={(e) => setTesting(e.target.checked)} />
              Testing notes
            </label>
            <label className="msb-panel__check">
              <input type="checkbox" checked={deployment} onChange={(e) => setDeployment(e.target.checked)} />
              Deployment and backout
            </label>
          </div>

          <pre className="msb-panel__snippet msb-notes__preview" tabIndex={0} aria-label="Release notes preview">
            {text}
          </pre>

          <div className="msb-panel__actions">
            <button
              className="msb-panel__run"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(text)
                  .then(() => flash('Copied.'))
                  .catch(() => flash('The browser did not allow copying.'))
              }
            >
              Copy
            </button>
            <button
              className="msb-panel__secondary"
              onClick={() => downloadText(suggestFilename('release-notes', format === 'markdown' ? 'md' : 'txt'), text, format === 'markdown' ? 'text/markdown' : 'text/plain')}
            >
              Download
            </button>
          </div>
        </>
      )}
    </div>
  );
}
