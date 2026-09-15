import React, { useState } from 'react';
import { artifactOptions } from '../lib/artifacts.js';
import { compareResultToMarkdown, downloadText, suggestFilename } from '../lib/report.js';

const OPTIONS = artifactOptions();

export default function ComparePanel({ onClose, currentInstanceUrl }) {
  const [sourceUrl, setSourceUrl] = useState(currentInstanceUrl || '');
  const [targetUrl, setTargetUrl] = useState('');
  const [table, setTable] = useState(OPTIONS[0].table);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [summary, setSummary] = useState(null);
  const [summarizing, setSummarizing] = useState(false);
  const [expanded, setExpanded] = useState({});

  async function handleCompare() {
    setBusy(true);
    setError(null);
    setResult(null);
    setSummary(null);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'COMPARE_INSTANCES',
        payload: { sourceUrl, targetUrl, table, query },
      });
      if (!response?.ok) throw new Error(response?.error || 'Comparison failed.');
      setResult(response.result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSummarize() {
    if (!result) return;
    setSummarizing(true);
    setError(null);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SUMMARIZE_DIFF',
        payload: { result },
      });
      if (!response?.ok) throw new Error(response?.error || 'Summary failed.');
      setSummary(response.content);
    } catch (err) {
      setError(err.message);
    } finally {
      setSummarizing(false);
    }
  }

  function toggleExpanded(key) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleExport() {
    if (!result) return;
    downloadText(suggestFilename(`compare-${result.table}`), compareResultToMarkdown(result, summary));
  }

  return (
    <div className="msb-compare">
      <div className="msb-compare__header">
        <strong>Compare Instances</strong>
        <button onClick={onClose}>{'\u2715'}</button>
      </div>

      <div className="msb-compare__form">
        <label>
          Source instance
          <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="dev12345.service-now.com" />
        </label>
        <label>
          Target instance
          <input value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} placeholder="dev67890.service-now.com" />
        </label>
        <label>
          Artifact type
          <select value={table} onChange={(e) => setTable(e.target.value)}>
            {OPTIONS.map((opt) => (
              <option key={opt.table} value={opt.table}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Encoded query (optional)
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="active=true" />
        </label>
        <button className="msb-compare__run" onClick={handleCompare} disabled={busy || !sourceUrl || !targetUrl}>
          {busy ? 'Comparing...' : 'Compare'}
        </button>
      </div>

      {error && <div className="msb-compare__error">{error}</div>}

      {result && (
        <div className="msb-compare__results">
          <div className="msb-compare__counts">
            {result.label}: {result.counts.sourceTotal} in source, {result.counts.targetTotal} in target
          </div>

          <div className="msb-panel__actions">
            <button onClick={handleSummarize} disabled={summarizing} className="msb-compare__summarize">
              {summarizing ? 'Summarizing...' : 'AI summary of changes'}
            </button>
            <button onClick={handleExport} className="msb-panel__secondary">
              Export markdown
            </button>
          </div>
          {summary && <div className="msb-compare__summary">{summary}</div>}

          <Section title={`Only in target / Added (${result.added.length})`} items={result.added.map((i) => i.key)} />
          <Section title={`Only in source / Removed (${result.removed.length})`} items={result.removed.map((i) => i.key)} />

          <div className="msb-compare__section">
            <div className="msb-compare__section-title">Modified ({result.modified.length})</div>
            {result.modified.map((item) => (
              <div key={item.key} className="msb-compare__modified">
                <button className="msb-compare__modified-toggle" onClick={() => toggleExpanded(item.key)}>
                  {expanded[item.key] ? '\u25be' : '\u25b8'} {item.key}
                  <span className="msb-compare__field-count">
                    {item.fieldDiffs.map((fd) => fd.field).join(', ')}
                  </span>
                </button>
                {expanded[item.key] &&
                  item.fieldDiffs.map((fd) => (
                    <div key={fd.field} className="msb-compare__diff">
                      <div className="msb-compare__diff-field">{fd.field}</div>
                      <pre>{fd.diffText}</pre>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, items }) {
  return (
    <div className="msb-compare__section">
      <div className="msb-compare__section-title">{title}</div>
      {items.length === 0 ? (
        <div className="msb-compare__empty">None</div>
      ) : (
        <ul className="msb-compare__list">
          {items.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
