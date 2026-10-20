import React, { useState } from 'react';
import { toRestMessageSnippet } from '../content/restClient.js';
import { downloadText, suggestFilename } from '../lib/report.js';
import { trusted } from './trusted.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const json = (value) => JSON.stringify(value, null, 2);

// Starting points for the common out-of-box APIs. <placeholders> must be
// replaced before sending; handleSend refuses a path that still has one.
const PRESETS = [
  { group: 'Table API', label: 'List records', method: 'GET', path: '/api/now/table/incident?sysparm_limit=5' },
  { group: 'Table API', label: 'Get one record', method: 'GET', path: '/api/now/table/incident/<sys_id>' },
  {
    group: 'Table API',
    label: 'Create record',
    method: 'POST',
    path: '/api/now/table/incident',
    body: json({ short_description: 'Created from NowBuddy' }),
  },
  {
    group: 'Table API',
    label: 'Update record',
    method: 'PATCH',
    path: '/api/now/table/incident/<sys_id>',
    body: json({ work_notes: 'Updated from NowBuddy' }),
  },
  { group: 'Table API', label: 'Delete record', method: 'DELETE', path: '/api/now/table/incident/<sys_id>' },

  { group: 'Aggregate API', label: 'Count records', method: 'GET', path: '/api/now/stats/incident?sysparm_count=true' },
  {
    group: 'Aggregate API',
    label: 'Count grouped by field',
    method: 'GET',
    path: '/api/now/stats/incident?sysparm_count=true&sysparm_group_by=priority',
  },

  {
    group: 'Import Set API',
    label: 'Insert one row',
    method: 'POST',
    path: '/api/now/import/<staging_table>',
    body: json({ u_name: 'Example' }),
  },
  {
    group: 'Import Set API',
    label: 'Insert multiple rows',
    method: 'POST',
    path: '/api/now/import/<staging_table>/insertMultiple',
    body: json({ records: [{ u_name: 'Example 1' }, { u_name: 'Example 2' }] }),
  },
  { group: 'Import Set API', label: 'Get import result', method: 'GET', path: '/api/now/import/<staging_table>/<sys_id>' },

  { group: 'CMDB APIs', label: 'List CIs of a class', method: 'GET', path: '/api/now/cmdb/instance/cmdb_ci_server?sysparm_limit=5' },
  { group: 'CMDB APIs', label: 'Get CI with relations', method: 'GET', path: '/api/now/cmdb/instance/cmdb_ci_server/<sys_id>' },
  { group: 'CMDB APIs', label: 'Class metadata', method: 'GET', path: '/api/now/cmdb/meta/cmdb_ci_server' },
  {
    group: 'CMDB APIs',
    label: 'Identify CI (dry run, no commit)',
    method: 'POST',
    path: '/api/now/identifyreconcile/query',
    body: json({ items: [{ className: 'cmdb_ci_linux_server', values: { name: 'example-host' } }] }),
  },

  { group: 'Attachment API', label: 'List attachments', method: 'GET', path: '/api/now/attachment?sysparm_limit=5' },
  { group: 'Attachment API', label: 'Attachment metadata', method: 'GET', path: '/api/now/attachment/<sys_id>' },

  { group: 'Service Catalog API', label: 'Catalogs', method: 'GET', path: '/api/sn_sc/servicecatalog/catalogs' },
  { group: 'Service Catalog API', label: 'Catalog items', method: 'GET', path: '/api/sn_sc/servicecatalog/items?sysparm_limit=5' },
  { group: 'Service Catalog API', label: 'Item details', method: 'GET', path: '/api/sn_sc/servicecatalog/items/<sys_id>' },

  { group: 'Other APIs', label: 'Change requests (Change Management API)', method: 'GET', path: '/api/sn_chg_rest/change?sysparm_limit=5' },
  { group: 'Other APIs', label: 'Knowledge articles (Knowledge API plugin)', method: 'GET', path: '/api/sn_km_api/knowledge/articles?limit=5' },
  {
    group: 'Other APIs',
    label: 'Batch API - several calls in one',
    method: 'POST',
    path: '/api/now/v1/batch',
    body: json({
      batch_request_id: '1',
      rest_requests: [
        {
          id: '1',
          method: 'GET',
          url: '/api/now/table/incident?sysparm_limit=1',
          headers: [{ name: 'Accept', value: 'application/json' }],
        },
      ],
    }),
  },
  { group: 'Other APIs', label: 'Current user', method: 'GET', path: '/api/now/ui/user/current_user' },

  {
    group: 'Discover APIs on this instance',
    label: 'Scripted REST APIs',
    method: 'GET',
    path: '/api/now/table/sys_ws_definition?sysparm_fields=name,namespace,base_uri,active&sysparm_limit=100',
  },
  {
    group: 'Discover APIs on this instance',
    label: 'Scripted REST resources',
    method: 'GET',
    path: '/api/now/table/sys_ws_operation?sysparm_fields=name,http_method,operation_uri,active&sysparm_limit=100',
  },
];

const PRESET_GROUPS = [...new Set(PRESETS.map((preset) => preset.group))];

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
    // Enter in the path field bypasses the disabled button, so guard here too (no double POST/DELETE).
    if (busy || !path.trim()) return;
    const placeholder = path.match(/<[^>]+>/);
    if (placeholder) {
      setError(`Replace ${placeholder[0]} in the path with a real value before sending.`);
      return;
    }
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
    setBody(preset.body || '');
    setError(null);
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
          <select value="" onChange={(e) => e.target.value !== '' && applyPreset(Number(e.target.value))}>
            <option value="">Choose a starting point...</option>
            {PRESET_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {PRESETS.map(
                  (preset, index) =>
                    preset.group === group && (
                      <option key={index} value={index}>
                        {preset.label}
                      </option>
                    )
                )}
              </optgroup>
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
            onKeyDown={trusted((e) => {
              if (e.key === 'Enter') handleSend();
            })}
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

        <button className="msb-panel__run" onClick={trusted(handleSend)} disabled={busy || !path.trim()}>
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
