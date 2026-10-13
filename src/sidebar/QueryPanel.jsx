import React, { useEffect, useState } from 'react';
import { explainQuery, toGlideRecord, toGlideAggregate } from '../lib/query.js';
import { toCsv, toMarkdownTable, toJson, sysIdList } from '../lib/export.js';
import { downloadText, suggestFilename } from '../lib/report.js';

const DEFAULT_FIELDS = 'sys_id,number,name,short_description,state,sys_updated_on';
const PREVIEW_ROWS = 10;
const EXPORT_MAX = 2000;

/**
 * Turn the list filter on screen into plain English, GlideRecord code, a row
 * count, and an export. Everything is read-only.
 */
export default function QueryPanel({ onClose, services, onUseScript, onAskAi }) {
  const [table, setTable] = useState('');
  const [query, setQuery] = useState('');
  const [fields, setFields] = useState('');
  const [count, setCount] = useState(null);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  async function loadFromPage() {
    setError(null);
    try {
      const info = await services.detectListInfo?.();
      if (!info) {
        setError('No list was detected. Open a list view, or type a table and filter below.');
        return;
      }
      setTable(info.table);
      setQuery(info.query || '');
      setCount(null);
      setRows(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadFromPage();
    // Run once when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flash(text) {
    setNotice(text);
    setTimeout(() => setNotice(null), 3000);
  }

  let explanation = '';
  let glideRecord = '';
  let glideAggregate = '';
  let codeError = null;
  if (table.trim()) {
    try {
      explanation = explainQuery(query, { table: table.trim() });
      glideRecord = toGlideRecord(table.trim(), query);
      glideAggregate = toGlideAggregate(table.trim(), query);
    } catch (err) {
      codeError = err.message;
    }
  }

  async function run(task) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const columnsList = () =>
    (fields.trim() || DEFAULT_FIELDS)
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);

  const handleCount = () => run(async () => setCount(await services.countRecords(table.trim(), query)));

  const handlePreview = () =>
    run(async () => {
      setRows(await services.queryAll(table.trim(), query, columnsList(), { max: PREVIEW_ROWS, displayValue: true }));
    });

  const handleExport = (format) =>
    run(async () => {
      const data = await services.queryAll(table.trim(), query, columnsList(), { max: EXPORT_MAX, displayValue: true });
      if (!data.length) throw new Error('The filter matched no records.');
      const columns = Object.keys(data[0]);
      const builders = {
        csv: () => toCsv(data, columns),
        md: () => toMarkdownTable(data, columns),
        json: () => toJson(data, columns),
      };
      const mime = { csv: 'text/csv', md: 'text/markdown', json: 'application/json' }[format];
      downloadText(suggestFilename(`${table.trim()}`, format), builders[format](), mime);
      flash(`Exported ${data.length} row(s)${data.length >= EXPORT_MAX ? ` (capped at ${EXPORT_MAX})` : ''}.`);
    });

  const handleCopyIds = () =>
    run(async () => {
      const data = await services.queryAll(table.trim(), query, ['sys_id'], { max: EXPORT_MAX });
      await navigator.clipboard?.writeText(sysIdList(data).join(','));
      flash(`Copied ${data.length} sys_id(s).`);
    });

  const canRun = table.trim() && !busy && !codeError;
  const previewColumns = rows?.length ? Object.keys(rows[0]) : [];

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>List filter tools</strong>
        <button onClick={onClose} aria-label="Close">
          {'\u2715'}
        </button>
      </div>

      <div className="msb-panel__form">
        <label>
          Table
          <input value={table} onChange={(e) => setTable(e.target.value)} placeholder="incident" />
        </label>
        <label>
          Encoded query
          <textarea
            className="msb-panel__body"
            rows={3}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="active=true^priority=1"
          />
        </label>
        <button className="msb-panel__secondary" onClick={loadFromPage}>
          Use the list on this page
        </button>
      </div>

      {codeError && <div className="msb-panel__error">{codeError}</div>}
      {error && <div className="msb-panel__error">{error}</div>}
      {notice && <div className="msb-panel__hint">{notice}</div>}

      {explanation && <pre className="msb-panel__snippet">{explanation}</pre>}

      <div className="msb-panel__actions">
        <button className="msb-panel__run" onClick={handleCount} disabled={!canRun}>
          Count
        </button>
        <button className="msb-panel__secondary" onClick={handlePreview} disabled={!canRun}>
          Preview {PREVIEW_ROWS}
        </button>
        {count !== null && <span className="msb-panel__badge">{count} record(s)</span>}
      </div>

      {rows && (
        <div className="msb-table-wrap">
          {rows.length ? (
            <table className="msb-table">
              <thead>
                <tr>
                  {previewColumns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {previewColumns.map((c) => (
                      <td key={c}>{typeof row[c] === 'object' ? row[c]?.display_value || row[c]?.value : row[c]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="msb-panel__empty">No records match.</div>
          )}
        </div>
      )}

      <div className="msb-panel__form">
        <label>
          Columns for preview and export (comma separated)
          <input value={fields} onChange={(e) => setFields(e.target.value)} placeholder={DEFAULT_FIELDS} />
        </label>
      </div>
      <div className="msb-panel__actions">
        <button className="msb-panel__secondary" onClick={() => handleExport('csv')} disabled={!canRun}>
          CSV
        </button>
        <button className="msb-panel__secondary" onClick={() => handleExport('md')} disabled={!canRun}>
          Markdown
        </button>
        <button className="msb-panel__secondary" onClick={() => handleExport('json')} disabled={!canRun}>
          JSON
        </button>
        <button className="msb-panel__secondary" onClick={handleCopyIds} disabled={!canRun}>
          Copy sys_ids
        </button>
      </div>

      {glideRecord && (
        <>
          <div className="msb-panel__hint">GlideRecord</div>
          <pre className="msb-panel__snippet">{glideRecord}</pre>
          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={() => navigator.clipboard?.writeText(glideRecord)}>
              Copy
            </button>
            <button className="msb-panel__secondary" onClick={() => onUseScript(glideRecord)}>
              Open in script runner
            </button>
          </div>
          <div className="msb-panel__hint">GlideAggregate (count)</div>
          <pre className="msb-panel__snippet">{glideAggregate}</pre>
          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={() => navigator.clipboard?.writeText(glideAggregate)}>
              Copy
            </button>
            <button className="msb-panel__secondary" onClick={() => onUseScript(glideAggregate)}>
              Open in script runner
            </button>
            <button
              className="msb-panel__secondary"
              onClick={() => onAskAi({ table: table.trim(), query, explanation })}
            >
              Ask AI to improve
            </button>
          </div>
        </>
      )}
    </div>
  );
}
