import React, { useEffect, useMemo, useState } from 'react';
import { diffLines, collapseDiff, hasChanges } from '../lib/diff.js';
import { lintScript, formatLintFindings } from '../lib/lint.js';
import { DiffView } from './DiffView.jsx';
import { trusted } from './trusted.js';

/**
 * Put a code block from the chat into a script field on the open form.
 * Shows the diff first, only edits the form (never saves it), and can undo.
 */
export default function ApplyPanel({ code, table, services, onClose }) {
  const [fields, setFields] = useState(null);
  const [target, setTarget] = useState('');
  const [current, setCurrent] = useState(null);
  const [applied, setApplied] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    services
      .getScriptFields()
      .then((list) => {
        if (cancelled) return;
        setFields(list);
        if (list.length) setTarget(list[0].name);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [services]);

  useEffect(() => {
    if (!target) return undefined;
    let cancelled = false;
    setCurrent(null);
    services
      .getFieldState(target)
      .then((state) => !cancelled && setCurrent(state))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [services, target, applied]);

  const rows = useMemo(() => {
    if (current === null) return null;
    const diff = diffLines(current.value || '', code);
    return hasChanges(diff) ? collapseDiff(diff, 3) : [];
  }, [current, code]);

  const lintText = useMemo(() => formatLintFindings(lintScript(code, { table })), [code, table]);

  async function handleApply() {
    setError(null);
    try {
      const { previous } = await services.setFieldValue(target, code);
      setApplied({ previous, name: target });
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleUndo() {
    setError(null);
    try {
      await services.setFieldValue(applied.name, applied.previous);
      setApplied(null);
    } catch (err) {
      setError(err.message);
    }
  }

  const field = fields?.find((f) => f.name === target);

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Apply code to the form</strong>
        <button onClick={onClose} aria-label="Close">
          {'\u2715'}
        </button>
      </div>

      <div className="msb-panel__form">
        {fields && !fields.length && (
          <div className="msb-panel__warning">No script field was found on this form. Open a record with a script first.</div>
        )}

        {fields?.length > 0 && (
          <label>
            Field
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!!applied}>
              {fields.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label || f.name} ({f.name})
                </option>
              ))}
            </select>
          </label>
        )}

        {current?.readOnly && <div className="msb-panel__warning">This field is read-only and cannot be changed.</div>}
        {field && code.length > Number(field.length || Infinity) && (
          <div className="msb-panel__warning">The code is longer than this field's maximum length.</div>
        )}

        <div className="msb-panel__hint">Lint check on the new code</div>
        <pre className="msb-panel__snippet">{lintText}</pre>

        {rows && (
          <>
            <div className="msb-panel__hint">Changes to this field</div>
            <DiffView rows={rows} />
          </>
        )}

        {error && <div className="msb-panel__error">{error}</div>}

        {applied ? (
          <>
            <div className="msb-panel__hint">
              Applied to the form. Nothing is saved until you save the record yourself.
            </div>
            <div className="msb-panel__actions">
              <button className="msb-panel__secondary" onClick={trusted(handleUndo)}>
                Undo
              </button>
              <button className="msb-panel__secondary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <div className="msb-panel__actions">
            <button
              className="msb-panel__run"
              onClick={trusted(handleApply)}
              disabled={!target || !current || current.readOnly || (rows && !rows.length)}
            >
              Apply to form
            </button>
            <button className="msb-panel__secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
