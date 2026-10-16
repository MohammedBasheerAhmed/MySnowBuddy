import React, { useEffect, useState } from 'react';
import { artifactOptions } from '../lib/artifacts.js';
import { compareResultToMarkdown, downloadText, suggestFilename } from '../lib/report.js';
import { listInstances } from '../content/stores.js';
import PushArtifact from './PushArtifact.jsx';
import { trusted } from './trusted.js';

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
  const [known, setKnown] = useState([]);
  const [pushing, setPushing] = useState(null);

  useEffect(() => {
    listInstances()
      .then(setKnown)
      .catch(() => {});
  }, []);

  async function handleCompare() {
    setBusy(true);
    setError(null);
    setResult(null);
    setSummary(null);
    setPushing(null);
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

  const targetHost = result ? new URL(result.target).hostname : '';

  function pushPanel(key, sysId) {
    if (!pushing || pushing.key !== key) return null;
    return (
      <PushArtifact
        key={`${key}|${sysId}`}
        table={result.table}
        sysId={sysId}
        sourceUrl={result.source}
        targetHost={targetHost}
        recordName={key}
        onClose={() => setPushing(null)}
      />
    );
  }

  function pushButton(key, sysId) {
    if (!/^[0-9a-f]{32}$/i.test(sysId || '')) return null;
    return (
      <button
        className="msb-mw-small-btn"
        onClick={trusted(() => setPushing(pushing?.key === key ? null : { key, sysId }))}
        aria-expanded={pushing?.key === key}
        title={`Copy the source version to ${targetHost} (preview first)`}
      >
        Push to target...
      </button>
    );
  }

  return (
    <div className="msb-compare">
      <div className="msb-compare__header">
        <strong>Compare Instances</strong>
        <button onClick={onClose}>{'✕'}</button>
      </div>

      <div className="msb-compare__form">
        <label>
          Source instance
          <input list="msb-compare-instances" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="dev12345.service-now.com" />
        </label>
        <label>
          Target instance
          <input list="msb-compare-instances" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} placeholder="dev67890.service-now.com" />
        </label>
        <datalist id="msb-compare-instances">
          {known.map((i) => (
            <option key={i.host} value={i.host}>
              {i.label}
            </option>
          ))}
        </datalist>
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
        <button className="msb-compare__run" onClick={trusted(handleCompare)} disabled={busy || !sourceUrl || !targetUrl}>
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
            <button onClick={trusted(handleSummarize)} disabled={summarizing} className="msb-compare__summarize">
              {summarizing ? 'Summarizing...' : 'AI summary of changes'}
            </button>
            <button onClick={handleExport} className="msb-panel__secondary">
              Export markdown
            </button>
          </div>
          {summary && <div className="msb-compare__summary">{summary}</div>}

          <Section title={`Only in target / Added (${result.added.length})`} items={result.added.map((i) => ({ key: i.key }))} />
          <Section
            title={`Only in source / Removed (${result.removed.length})`}
            items={result.removed.map((i) => ({ key: i.key, action: pushButton(i.key, i.record?.sys_id), panel: pushPanel(i.key, i.record?.sys_id) }))}
          />

          <div className="msb-compare__section">
            <div className="msb-compare__section-title">Modified ({result.modified.length})</div>
            {result.modified.map((item) => (
              <div key={item.key} className="msb-compare__modified">
                <div className="msb-mw-row">
                  <button className="msb-compare__modified-toggle" onClick={() => toggleExpanded(item.key)}>
                    {expanded[item.key] ? '▾' : '▸'} {item.key}
                    <span className="msb-compare__field-count">{item.fieldDiffs.map((fd) => fd.field).join(', ')}</span>
                  </button>
                  {pushButton(item.key, item.sourceSysId)}
                </div>
                {expanded[item.key] &&
                  item.fieldDiffs.map((fd) => (
                    <div key={fd.field} className="msb-compare__diff">
                      <div className="msb-compare__diff-field">{fd.field}</div>
                      <pre>{fd.diffText}</pre>
                    </div>
                  ))}
                {pushPanel(item.key, item.sourceSysId)}
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
          {items.map((item) => (
            <li key={item.key}>
              {item.action ? (
                <div className="msb-mw-row">
                  <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{item.key}</span>
                  {item.action}
                </div>
              ) : (
                item.key
              )}
              {item.panel}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
