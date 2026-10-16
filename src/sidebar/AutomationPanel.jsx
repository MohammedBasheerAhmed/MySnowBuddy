import React, { useEffect, useRef, useState } from 'react';
import { trusted } from './trusted.js';
import {
  parseSteps,
  describeStep,
  extractStepsText,
  buildPlanPrompt,
  buildContinuePrompt,
  AUTOMATION_SYNTAX,
} from '../lib/automation.js';

async function askModel(prompt) {
  const response = await chrome.runtime.sendMessage({
    type: 'CHAT_COMPLETION',
    payload: { messages: [{ role: 'user', content: prompt }] },
  });
  if (!response?.ok) throw new Error(response?.error || 'Unknown error from AI provider.');
  return extractStepsText(response.content);
}

/**
 * Runs a list of steps in this browser (goto, newtab, switchtab, click, type,
 * select, waitfor, wait). The runner lives in src/content/automation.js; a run
 * continues across page loads and tabs. AI only drafts steps; the user reviews
 * them before anything runs.
 */
export default function AutomationPanel({ onClose, services }) {
  const [goal, setGoal] = useState('');
  const [script, setScript] = useState('');
  const [errors, setErrors] = useState([]);
  const [log, setLog] = useState([]);
  const [running, setRunning] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [failure, setFailure] = useState(null);
  const logRef = useRef([]);

  function updateLog(next) {
    logRef.current = next;
    setLog(next);
  }

  useEffect(() => {
    const subscribe = services.subscribeAutomation;
    if (!subscribe) return undefined;
    return subscribe((event) => {
      if (event.type === 'step') {
        setRunning(true);
        const rows = logRef.current.filter((row) => row.index !== event.index);
        updateLog([...rows, { index: event.index, text: event.text, status: event.status }].sort((a, b) => a.index - b.index));
      } else if (event.type === 'finished' || event.type === 'handoff') {
        setRunning(false);
      } else if (event.type === 'failed') {
        setRunning(false);
        setFailure({ index: event.index, message: event.message });
        updateLog(logRef.current.map((row) => (row.index === event.index ? { ...row, status: 'failed', message: event.message } : row)));
      }
    });
  }, [services]);

  async function handleRun() {
    const { steps, errors: parseErrors } = parseSteps(script);
    setErrors(parseErrors);
    setFailure(null);
    if (parseErrors.length) return;
    updateLog(steps.map((step, index) => ({ index, text: describeStep(step), status: 'pending' })));
    try {
      await services.runAutomation(steps);
    } catch (err) {
      setErrors([{ line: 0, message: err.message }]);
    }
  }

  async function plan(prompt) {
    setPlanning(true);
    setErrors([]);
    try {
      const text = await askModel(prompt);
      setScript(text);
      setFailure(null);
      updateLog([]);
      setErrors(parseSteps(text).errors);
    } catch (err) {
      setErrors([{ line: 0, message: err.message }]);
    } finally {
      setPlanning(false);
    }
  }

  const handlePlan = () => plan(buildPlanPrompt(goal, services.snapshotAutomation()));

  const handleContinue = () => {
    const failed = log.find((row) => row.index === failure.index);
    plan(
      buildContinuePrompt({
        goal,
        done: log.filter((row) => row.status === 'done').map((row) => row.text),
        failedStep: failed?.text || 'unknown',
        error: failure.message,
        snapshot: services.snapshotAutomation(),
      })
    );
  };

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Automation</strong>
        <button onClick={onClose} aria-label="Close">{'\u2715'}</button>
      </div>

      <div className="msb-panel__form">
        <label>
          Describe what to do (optional)
          <textarea
            className="msb-panel__body"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Open the active incidents list and create a new incident called 'Printer is down'"
            rows={3}
          />
        </label>
        <div className="msb-panel__actions">
          <button className="msb-panel__secondary" onClick={handlePlan} disabled={planning || running || !goal.trim()}>
            {planning ? 'Planning...' : 'Plan with AI'}
          </button>
          {failure && goal.trim() && (
            <button className="msb-panel__secondary" onClick={handleContinue} disabled={planning || running}>
              Ask AI to fix and continue
            </button>
          )}
        </div>
        <div className="msb-panel__hint">
          Planning sends this page's button and field labels (never field values) to your AI provider. Review the
          steps before running.
        </div>

        <label>
          Steps (one per line)
          <textarea
            className="msb-panel__body"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder={AUTOMATION_SYNTAX}
            rows={8}
            spellCheck={false}
          />
        </label>

        <div className="msb-panel__hint">
          Runs as you. <code>goto</code>, <code>newtab</code> and <code>switchtab</code> stay on this instance, and the run
          continues after each page load or tab change. Clicks on buttons such as Save or Delete ask for confirmation. Use{' '}
          <code>text:Label</code> to click by visible text.
        </div>

        <div className="msb-panel__actions">
          <button className="msb-panel__run" onClick={trusted(handleRun)} disabled={running || planning || !script.trim()}>
            {running ? 'Running...' : 'Run'}
          </button>
          {running && (
            <button className="msb-panel__secondary" onClick={() => { services.cancelAutomation(); setRunning(false); }}>
              Stop
            </button>
          )}
        </div>
      </div>

      {errors.length > 0 && (
        <div className="msb-panel__error">
          {errors.map((e, i) => (
            <div key={i}>{e.line ? `Line ${e.line}: ` : ''}{e.message}</div>
          ))}
        </div>
      )}

      {log.length > 0 && (
        <div className="msb-panel__results">
          {log.map((row) => (
            <div key={row.index} className={row.status === 'failed' ? 'msb-panel__status--fail' : undefined}>
              {row.index + 1}. {row.text} - {row.status}
              {row.message ? `: ${row.message}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
