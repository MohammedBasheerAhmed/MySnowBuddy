import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CONTEXT_VARIABLES,
  KINDS,
  LIMITS,
  allPrompts,
  contextValues,
  contextVariablesUsed,
  exportLibraryJson,
  extractVariables,
  filterPrompts,
  isBuiltin,
  loadLibrary,
  normalizePrompt,
  getSyncEnabled,
  parseImport,
  recordUse,
  removePrompt,
  renderTemplate,
  saveLibrary,
  setSyncEnabled,
  sortPrompts,
  toggleFavorite,
  upsertPrompt,
  userVariables,
} from '../lib/promptLibrary.js';
import { downloadText, suggestFilename } from '../lib/report.js';
import Icon from './Icon.jsx';

const EMPTY_DRAFT = { id: '', title: '', category: 'Custom', description: '', template: '' };

/**
 * Prompt and snippet library: browse, fill in and use saved entries, and manage
 * the user's own. Built-ins are read-only; "Customize" saves an editable copy.
 * Prompts go to the AI; snippets are code to insert, copy or run.
 */
export default function PromptLibraryPanel({ onClose, getContext, onRun, onInsert, onUseScript, initialKind = 'prompts' }) {
  const [kind, setKind] = useState(initialKind);
  const config = KINDS[kind];
  const CATEGORIES = config.categories;
  const noun = config.noun;
  const [library, setLibrary] = useState({ prompts: [], favorites: [], usage: {} });
  const [syncOn, setSyncOn] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [view, setView] = useState('list'); // list | use | edit
  const [selected, setSelected] = useState(null);
  const [pageValues, setPageValues] = useState({});
  const [values, setValues] = useState({});
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setCategory('');
    setView('list');
    Promise.all([loadLibrary(kind), getSyncEnabled()]).then(([lib, sync]) => {
      if (cancelled) return;
      setLibrary(lib);
      setSyncOn(sync);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  const everything = useMemo(() => allPrompts(library, kind), [library, kind]);
  const visible = useMemo(
    () =>
      sortPrompts(
        filterPrompts(everything, { query, category, favoritesOnly, favorites: library.favorites }),
        library.favorites,
        library.usage
      ),
    [everything, query, category, favoritesOnly, library.favorites, library.usage]
  );

  async function persist(next) {
    setLibrary(next);
    setLibrary(await saveLibrary(next, kind));
  }

  async function handleSyncToggle(enabled) {
    setError(null);
    try {
      await setSyncEnabled(enabled);
      setSyncOn(enabled);
      // Push what is here now; when turning it off the synced copy is simply left alone.
      if (enabled) await saveLibrary(library, kind);
      flash(enabled ? 'Syncing across your signed-in browsers.' : 'Sync turned off. Existing synced copies are kept.');
    } catch (err) {
      setError(err.message);
    }
  }

  // Counted when an entry is used, so the ones you reach for float to the top.
  function countUse(entry) {
    persist(recordUse(library, entry.id)).catch(() => {});
  }

  function flash(text) {
    setNotice(text);
    setTimeout(() => setNotice(null), 3500);
  }

  function openPrompt(prompt) {
    setError(null);
    setSelected(prompt);
    setValues({});
    setPageValues(contextValues(getContext(), window.location.hostname));
    setView('use');
  }

  function startNew() {
    setError(null);
    setDraft(EMPTY_DRAFT);
    setView('edit');
  }

  function startEdit(prompt) {
    setError(null);
    // A built-in is copied rather than edited in place.
    setDraft(isBuiltin(prompt.id) ? { ...prompt, id: '', title: `${prompt.title} (copy)` } : prompt);
    setView('edit');
  }

  async function handleSave() {
    setError(null);
    try {
      const prompt = normalizePrompt(draft);
      await persist(upsertPrompt(library, prompt));
      setView('list');
      flash(`Saved the ${noun}.`);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete(prompt) {
    if (!window.confirm(`Delete "${prompt.title}"?`)) return;
    await persist(removePrompt(library, prompt.id));
  }

  async function handleFavorite(prompt) {
    await persist(toggleFavorite(library, prompt.id));
  }

  function handleExport() {
    if (!library.prompts.length) {
      flash(`You have no saved ${noun}s to export.`);
      return;
    }
    downloadText(suggestFilename(`${noun}s`, 'json'), exportLibraryJson(library), 'application/json');
  }

  async function handleImport(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('That file is too large to be a prompt library.');
      const { prompts, skipped } = parseImport(await file.text());
      let next = library;
      let added = 0;
      for (const prompt of prompts) {
        try {
          next = upsertPrompt(next, prompt);
          added += 1;
        } catch {
          break; // library is full
        }
      }
      await persist(next);
      const notImported = prompts.length - added + skipped;
      flash(`Imported ${added} ${noun}(s)${notImported ? `, ${notImported} skipped` : ''}.`);
    } catch (err) {
      setError(err.message);
    }
  }

  // Everything the selected prompt still needs before it can be sent.
  const rendered = useMemo(() => {
    if (!selected) return null;
    // Snippets escape each value for the string literal it lands in; prompts insert it as typed.
    const { text, missing } = renderTemplate(selected.template, { ...pageValues, ...values }, { kind });
    const missingContext = missing.filter((name) => name in CONTEXT_VARIABLES);
    const missingInputs = missing.filter((name) => !(name in CONTEXT_VARIABLES));
    return { text, missingContext, missingInputs };
  }, [selected, pageValues, values, kind]);

  const canSend = rendered && !rendered.missingContext.length && !rendered.missingInputs.length;

  function handleRun() {
    countUse(selected);
    onRun(selected.title, rendered.text);
    onClose();
  }

  function handleInsert() {
    countUse(selected);
    onInsert(rendered.text);
    onClose();
  }

  function handleCopy() {
    countUse(selected);
    navigator.clipboard?.writeText(rendered.text);
    flash('Copied.');
  }

  function handleRunScript() {
    countUse(selected);
    onUseScript(rendered.text);
    onClose();
  }

  if (view === 'edit') {
    const detected = extractVariables(draft.template);
    return (
      <div className="msb-panel">
        <div className="msb-panel__header">
          <strong>{draft.id ? `Edit ${noun}` : `New ${noun}`}</strong>
          <button onClick={() => setView('list')} aria-label="Back">
            {'\u2190'}
          </button>
        </div>

        <div className="msb-panel__form">
          <label>
            Title
            <input
              value={draft.title}
              maxLength={LIMITS.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder={kind === 'snippets' ? 'Query active incidents' : 'Review my Business Rule'}
            />
          </label>
          <label>
            Category
            <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Description
            <input
              value={draft.description}
              maxLength={LIMITS.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Optional"
            />
          </label>
          <label>
            {kind === 'snippets' ? 'Code' : 'Prompt'}
            <textarea
              className="msb-panel__body msb-prompts__template"
              value={draft.template}
              maxLength={LIMITS.template}
              onChange={(e) => setDraft({ ...draft, template: e.target.value })}
              placeholder={kind === 'snippets' ? "var gr = new GlideRecord('{{table}}');" : 'Explain {{topic}} for {{table}}.'}
            />
          </label>

          <div className="msb-panel__hint">
            Use {'{{name}}'} for a value you will fill in when using the {noun}. Filled from the page
            automatically: {Object.keys(CONTEXT_VARIABLES).map((n) => `{{${n}}}`).join(' ')}.
            {detected.length > 0 && <> Detected: {detected.join(', ')}.</>}
          </div>

          {error && <div className="msb-panel__error">{error}</div>}

          <div className="msb-panel__actions">
            <button className="msb-panel__run" onClick={handleSave}>
              Save
            </button>
            <button className="msb-panel__secondary" onClick={() => setView('list')}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'use' && selected) {
    const inputs = userVariables(selected.template);
    const contextUsed = contextVariablesUsed(selected.template);
    return (
      <div className="msb-panel">
        <div className="msb-panel__header">
          <strong>{selected.title}</strong>
          <button onClick={() => setView('list')} aria-label="Back">
            {'\u2190'}
          </button>
        </div>

        <div className="msb-panel__form">
          {selected.description && <div className="msb-panel__hint">{selected.description}</div>}

          {inputs.map((name) => (
            <label key={name}>
              {name.replace(/_/g, ' ')}
              <textarea
                rows={2}
                value={values[name] || ''}
                onChange={(e) => setValues({ ...values, [name]: e.target.value })}
              />
            </label>
          ))}

          {contextUsed.length > 0 && (
            <div className="msb-prompts__context">
              {contextUsed.map((name) => (
                <span
                  key={name}
                  className={`msb-prompts__ctx${pageValues[name] ? '' : ' msb-prompts__ctx--missing'}`}
                  title={CONTEXT_VARIABLES[name]}
                >
                  <b>{name}</b>
                  {pageValues[name] ? (name === 'script' || name === 'selection' ? 'detected' : pageValues[name]) : 'not detected'}
                </span>
              ))}
            </div>
          )}

          {rendered.missingContext.length > 0 && (
            <div className="msb-panel__warning">
              This {noun} needs {rendered.missingContext.join(', ')} from the page, which was not detected.
              {' '}
              {rendered.missingContext.includes('selection')
                ? 'Select some text on the page first, then reopen this.'
                : 'Open a record that has it, or use Insert and fill it in by hand.'}
            </div>
          )}

          <label>
            Preview
            <pre className="msb-panel__snippet msb-prompts__preview">{rendered.text}</pre>
          </label>

          {notice && <div className="msb-panel__hint">{notice}</div>}

          {kind === 'snippets' ? (
            <div className="msb-panel__actions">
              <button className="msb-panel__run" onClick={handleCopy} disabled={rendered.missingInputs.length > 0}>
                Copy
              </button>
              <button
                className="msb-panel__secondary"
                onClick={handleRunScript}
                disabled={rendered.missingInputs.length > 0}
                title="Load into the background script runner (dry run is on by default)"
              >
                Open in script runner
              </button>
              <button
                className="msb-panel__secondary"
                onClick={handleInsert}
                disabled={rendered.missingInputs.length > 0}
                title="Put the snippet in the chat box"
              >
                Insert in chat
              </button>
            </div>
          ) : (
            <div className="msb-panel__actions">
              <button className="msb-panel__run" onClick={handleRun} disabled={!canSend}>
                Send to AI
              </button>
              <button
                className="msb-panel__secondary"
                onClick={handleInsert}
                disabled={rendered.missingInputs.length > 0}
                title="Put the prompt in the chat box so you can edit it first"
              >
                Insert in chat
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Library</strong>
        <button onClick={onClose} aria-label="Close">
          {'\u2715'}
        </button>
      </div>

      <div className="msb-panel__actions">
        <button className={kind === 'prompts' ? 'msb-panel__run' : 'msb-panel__secondary'} onClick={() => setKind('prompts')}>
          Prompts
        </button>
        <button className={kind === 'snippets' ? 'msb-panel__run' : 'msb-panel__secondary'} onClick={() => setKind('snippets')}>
          Code snippets
        </button>
      </div>

      <div className="msb-panel__form">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${noun}s`}
          aria-label={`Search ${noun}s`}
        />

        <div className="msb-panel__checks">
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label className="msb-panel__check">
            <input type="checkbox" checked={favoritesOnly} onChange={(e) => setFavoritesOnly(e.target.checked)} />
            Favorites
          </label>
        </div>
      </div>

      <div className="msb-panel__actions">
        <button className="msb-panel__secondary" onClick={startNew}>
          New {noun}
        </button>
        <button className="msb-panel__secondary" onClick={() => fileRef.current?.click()}>
          Import
        </button>
        <button className="msb-panel__secondary" onClick={handleExport}>
          Export
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={handleImport} />
      </div>

      <label className="msb-panel__check" title="Uses chrome.storage.sync, which is limited to about 80 KB">
        <input type="checkbox" checked={syncOn} onChange={(e) => handleSyncToggle(e.target.checked)} />
        Sync my prompts and snippets across browsers
      </label>

      {notice && <div className="msb-panel__hint">{notice}</div>}
      {error && <div className="msb-panel__error">{error}</div>}

      {loaded && visible.length === 0 && <div className="msb-panel__empty">No {noun}s match.</div>}

      {visible.map((prompt) => {
        const starred = library.favorites.includes(prompt.id);
        const builtin = isBuiltin(prompt.id);
        return (
          <div key={prompt.id} className="msb-panel__result msb-prompts__item">
            <div className="msb-prompts__main">
              <button className="msb-prompts__use" onClick={() => openPrompt(prompt)}>
                <span className="msb-prompts__title">{prompt.title}</span>
                {prompt.description && <span className="msb-prompts__desc">{prompt.description}</span>}
              </button>
              <span className="msb-panel__badge">{prompt.category}</span>
            </div>
            <div className="msb-prompts__tools">
              <button
                className={`msb-prompts__icon${starred ? ' msb-prompts__icon--on' : ''}`}
                onClick={() => handleFavorite(prompt)}
                aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
                aria-pressed={starred}
                title={starred ? 'Remove from favorites' : 'Add to favorites'}
              >
                <Icon name="star" size={14} />
              </button>
              <button className="msb-panel__link" onClick={() => startEdit(prompt)}>
                {builtin ? 'Customize' : 'Edit'}
              </button>
              {!builtin && (
                <button className="msb-panel__link" onClick={() => handleDelete(prompt)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
