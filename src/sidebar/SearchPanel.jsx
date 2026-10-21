import React, { useEffect, useState } from 'react';
import { getUiState, saveUiState } from '../content/storage.js';
import { rememberSearch, cleanSearches, describeSearch } from '../lib/recentSearches.js';
import { searchableTableOptions, recordUrl } from '../content/codeSearch.js';
import { searchResultsToMarkdown, downloadText, suggestFilename } from '../lib/report.js';

const TABLE_OPTIONS = searchableTableOptions();

/**
 * Global code search across every script-bearing configuration table.
 * The actual query runs in the content script (same-origin, user's session);
 * this component only collects options and renders results.
 */
export default function SearchPanel({ onClose, runSearch, onAskAi, initialTerm = '' }) {
  const [term, setTerm] = useState(initialTerm);
  const [wholeWord, setWholeWord] = useState(false);
  const [activeOnly, setActiveOnly] = useState(true);
  const [selectedTables, setSelectedTables] = useState([]);
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    getUiState().then((ui) => setRecent(cleanSearches(ui.recentCodeSearches)), () => {});
  }, []);

  function remember(entry) {
    const next = rememberSearch(recent, entry);
    setRecent(next);
    saveUiState({ recentCodeSearches: next }).catch(() => {});
  }

  function runAgain(entry) {
    setTerm(entry.term);
    setWholeWord(entry.wholeWord);
    setActiveOnly(entry.activeOnly);
    setSelectedTables(entry.tables);
    handleSearch(entry);
  }

  async function handleSearch(again) {
    const using = again && again.term ? again : { term, wholeWord, activeOnly, tables: selectedTables };
    if (!using.term.trim()) return;
    setBusy(true);
    setError(null);
    setSearch(null);
    try {
      const result = await runSearch(using.term, {
        wholeWord: using.wholeWord,
        activeOnly: using.activeOnly,
        tables: using.tables.length ? using.tables : null,
      });
      setSearch(result);
      remember(using);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function toggleTable(table) {
    setSelectedTables((prev) =>
      prev.includes(table) ? prev.filter((t) => t !== table) : [...prev, table]
    );
  }

  function toggleExpanded(key) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleExport() {
    if (!search) return;
    downloadText(suggestFilename('code-search'), searchResultsToMarkdown(search));
  }

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Code Search</strong>
        <button onClick={onClose} aria-label="Close">{'\u2715'}</button>
      </div>

      <div className="msb-panel__form">
        <label>
          Find in all script fields
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
            }}
            placeholder="getUserRoles"
          />
        </label>

        <div className="msb-panel__checks">
          <label className="msb-panel__check">
            <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />
            Whole word
          </label>
          <label className="msb-panel__check">
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
            Active only
          </label>
          <button className="msb-panel__link" onClick={() => setShowTablePicker((v) => !v)}>
            {selectedTables.length ? `${selectedTables.length} table(s)` : 'All tables'}
          </button>
        </div>

        {showTablePicker && (
          <div className="msb-panel__picker">
            {TABLE_OPTIONS.map((opt) => (
              <label key={opt.table} className="msb-panel__check">
                <input
                  type="checkbox"
                  checked={selectedTables.includes(opt.table)}
                  onChange={() => toggleTable(opt.table)}
                />
                {opt.label}
              </label>
            ))}
            <button className="msb-panel__link" onClick={() => setSelectedTables([])}>
              Reset to all
            </button>
          </div>
        )}

        {recent.length > 0 && !search && (
          <div className="msb-panel__recent" role="group" aria-label="Recent searches">
            <span className="msb-panel__hint">Recent</span>
            {recent.map((entry) => (
              <button key={`${entry.term}|${describeSearch(entry)}`} type="button" className="msb-panel__chip" title={describeSearch(entry) || 'Search again'} onClick={() => runAgain(entry)} disabled={busy}>
                {entry.term}
              </button>
            ))}
          </div>
        )}

        <button className="msb-panel__run" onClick={() => handleSearch()} disabled={busy || term.trim().length < 3}>
          {busy ? 'Searching...' : 'Search'}
        </button>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}

      {search && (
        <div className="msb-panel__results">
          <div className="msb-panel__counts">
            {search.totalMatches} match(es) in {search.totalRecords} record(s) across {search.scannedTables} table(s)
          </div>

          <div className="msb-panel__actions">
            <button className="msb-panel__secondary" onClick={handleExport}>
              Export markdown
            </button>
            {onAskAi && (
              <button className="msb-panel__secondary" onClick={() => onAskAi(search)} disabled={!search.totalMatches}>
                Ask AI about usages
              </button>
            )}
          </div>

          {search.errors?.length > 0 && (
            <div className="msb-panel__warning">
              Could not search: {search.errors.map((e) => e.label).join(', ')}. The field list for those
              tables may differ on this release.
            </div>
          )}

          {search.results.length === 0 && <div className="msb-panel__empty">No matches.</div>}

          {search.results.map((result) => {
            const key = `${result.table}:${result.sysId}:${result.field}`;
            return (
              <div key={key} className="msb-panel__result">
                <button className="msb-panel__result-toggle" onClick={() => toggleExpanded(key)}>
                  {expanded[key] ? '\u25be' : '\u25b8'} {result.label}: {result.name}
                  <span className="msb-panel__badge">
                    {result.field} &middot; {result.matches.length}
                  </span>
                </button>

                {expanded[key] && (
                  <div className="msb-panel__result-body">
                    {result.scopeHint && <div className="msb-panel__hint">on {result.scopeHint}</div>}
                    <pre>
                      {result.matches
                        .map((m) => `${String(m.lineNumber).padStart(5)} | ${m.text}`)
                        .join('\n')}
                    </pre>
                    <a
                      className="msb-panel__link"
                      href={recordUrl(result.table, result.sysId)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open record
                    </a>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
