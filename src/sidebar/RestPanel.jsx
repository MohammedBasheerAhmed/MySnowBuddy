import React, { useState } from 'react';
import { toRestMessageSnippet } from '../content/restClient.js';
import { downloadText, suggestFilename } from '../lib/report.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const PRESETS = [
  { label: 'Table API - list', method: 'GET', path: '/api/now/table/incident?sysparm_limit=5' },
  { label: 'Table API - single record', method: 'GET', path: '/api/now/table/incident/<sys_id>' },
  { label: 'Aggregate API', method: 'GET', path: '/api/now/stats/incident?sysparm_count=true' },
  { label: 'Current user', method: 'GET', path: '/api/now/ui/user/current_user' },
  { label: 'Attachment metadata', method: 'GET', path: '/api/now/attachment?sysparm_limit=5' },
];

/**
 * REST request builder. Requests are restricted to the current instance
 * origin by src/content/restClient.js - see the security note there.
 */
export default function RestPanel({ onClose, runRequest, onAskAi }) {
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('/api/now/table/incident?sysparm_limit=5');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [response, setResponse] = useState(null);
  const [showSnippet, setShowSnippet] = useState(false);

  const isWrite = method !== 'GET';

  async function handleSend() {
    setBusy(true);
    setError(null);
    setResponse(null);
    try {
      setResponse(await runRequest({ method, path, body }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function applyPreset(index) {
    const preset = PRESETS[index];
    if (!preset) return;
    setMethod(preset.method);
    setPath(preset.path);
    setBody('');
  }

  function handleExport() {
    if (!response) return;
    downloadText(suggestFilename('rest-response', 'json'), response.body, 'application/json');
  }

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>REST Builder</strong>
        <button onClick={onClose} aria-label="Close">{'\u2715'}</button>
      </div>

      <div className="msb-panel__form">
        <label>
          Preset
          <select value="" onChange={(e) => applyPreset(Number(e.target.value))}>
            <option value="">Choose a starting point...</option>
            {PRESETS.map((preset, index) => (
              <option key={preset.label} value={index}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        <div className="msb-panel__row">
          <select
            className="msb-panel__method"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            className="msb-panel__path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSend();
            }}
            placeholder="/api/now/table/incident"
          />
        </div>

        <div className="msb-panel__hint">
          Requests are sent to this instance only, using your existing session and permissions.
        </div>

        {isWrite && (
          <label>
            JSON body
            <textarea
              className="msb-panel__body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={'{\n  "short_description": "Example"\n}'}
              rows={6}
            />
          </label>
        )}

        {isWrite && (
          <div className="msb-panel__warning">
            {method} modifies data on this instance. Confirm the path and body before sending.
          </div>
        )}

        <button className="msb-panel__run" onClick={handleSend} disabled={busy || !path.trim()}>
          {busy ? 'Sending...' : `Send ${method}`}
        </button>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}

      {response && (
        <div className="msb-panel__results">
          <div className={`msb-panel__counts msb-panel__status--${response.ok ? 'ok' : 'fail'}`}>
            HTTP {response.status} &middot; {response.durationMs}ms &middot; {response.contentType || 'unknown type'}
          </div>

          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={handleExport}>
              Download response
            </button>
            <button className="msb-panel__secondary" onClick={() => setShowSnippet((v) => !v)}>
              {showSnippet ? 'Hide' : 'Show'} server-side snippet
            </button>
            {onAskAi && (
              <button className="msb-panel__secondary" onClick={() => onAskAi({ method, path, response })}>
                Explain response
              </button>
            )}
          </div>

          {showSnippet && (
            <pre className="msb-panel__snippet">{toRestMessageSnippet({ method, path, body })}</pre>
          )}

          <pre className="msb-panel__response">{response.body}</pre>
        </div>
      )}
    </div>
  );
}
