import React, { useMemo, useState } from 'react';
import Icon from './Icon.jsx';

const TYPES = ['onLoad', 'onChange', 'onSubmit', 'onCellEdit'];

const DEFAULT_SCENARIO = {
  fields: { short_description: { value: '', label: 'Short description' } },
  changedField: 'short_description',
  oldValue: '',
  newValue: 'Example',
  isLoading: false,
  user: { roles: ['itil'] },
  ajax: {},
  references: {},
};

function detectType(code) {
  return TYPES.find((t) => new RegExp(`\\bfunction\\s+${t}\\s*\\(`).test(code)) || 'onChange';
}

const SEVERITY_TONE = { high: 'high', medium: 'medium', low: 'low' };

/**
 * Run a client script against a simulated form: no real form, server or Script
 * Include is touched. Shows every g_form call the script makes.
 */
export default function TestBenchPanel({ services, onClose, onAskAi }) {
  const [code, setCode] = useState('');
  const [type, setType] = useState('onChange');
  const [scenarioText, setScenarioText] = useState(JSON.stringify(DEFAULT_SCENARIO, null, 2));
  const [result, setResult] = useState(null);
  const [verify, setVerify] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const scenarioError = useMemo(() => {
    try {
      JSON.parse(scenarioText);
      return null;
    } catch (err) {
      return err.message;
    }
  }, [scenarioText]);

  async function loadFromForm() {
    setError(null);
    try {
      const found = await services.readFormScript();
      if (!found?.body) throw new Error('No script was found on the open form.');
      setCode(found.body);
      setType(detectType(found.body));
      setResult(null);
      setVerify(null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function fillFromLiveForm() {
    setError(null);
    try {
      const model = await services.agentExecute('get_form_model', {});
      const fields = {};
      model.fields.slice(0, 40).forEach((f) => {
        fields[f.name] = { value: f.value ?? '', label: f.label || f.name, mandatory: Boolean(f.mandatory), readOnly: Boolean(f.readOnly), visible: f.visible !== false };
      });
      const current = JSON.parse(scenarioText);
      setScenarioText(JSON.stringify({ ...current, table: model.table, fields }, null, 2));
    } catch (err) {
      setError(err.message);
    }
  }

  async function run() {
    setBusy(true);
    setError(null);
    setVerify(null);
    try {
      setResult(await services.agentExecute('test_client_script', { code, clientType: type, scenario: JSON.parse(scenarioText) }));
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setBusy(true);
    setError(null);
    try {
      setVerify(await services.agentExecute('verify_script', { code, kind: 'client_script', clientType: type }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Client script test bench</strong>
        <button onClick={onClose} aria-label="Close">
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="msb-panel__form">
        <div className="msb-panel__actions">
          <button className="msb-panel__secondary" onClick={loadFromForm}>
            <Icon name="code" size={13} /> Script from the form
          </button>
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Handler to run">
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>

        <label>
          Script
          <textarea
            className="msb-panel__body msb-code-input"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setType(detectType(e.target.value));
            }}
            rows={9}
            spellCheck={false}
            placeholder={'function onChange(control, oldValue, newValue, isLoading, isTemplate) {\n  if (isLoading || newValue === \'\') return;\n  ...\n}'}
          />
        </label>

        <label>
          Scenario (the simulated form, user and answers)
          <textarea className="msb-panel__body msb-code-input" value={scenarioText} onChange={(e) => setScenarioText(e.target.value)} rows={9} spellCheck={false} />
        </label>
        {scenarioError && <div className="msb-panel__error">Scenario is not valid JSON: {scenarioError}</div>}
        <div className="msb-panel__hint">
          <code>ajax</code> maps <code>"ScriptInclude.method"</code> to the answer a real call would return. <code>references</code> stubs <code>g_form.getReference</code>.
        </div>

        <div className="msb-panel__actions">
          <button className="msb-panel__run" onClick={run} disabled={busy || !code.trim() || Boolean(scenarioError)}>
            <Icon name="play" size={13} /> {busy ? 'Running...' : 'Run simulation'}
          </button>
          <button className="msb-panel__secondary" onClick={check} disabled={busy || !code.trim()}>
            <Icon name="shield" size={13} /> Verify
          </button>
          <button className="msb-panel__secondary" onClick={fillFromLiveForm}>
            Use live form values
          </button>
        </div>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}

      {verify && (
        <div className="msb-bench__section">
          <div className={`msb-bench__banner msb-bench__banner--${verify.ok ? 'ok' : 'bad'}`}>
            <Icon name={verify.ok ? 'shield' : 'alert'} size={14} /> {verify.summary}
          </div>
          {verify.findings.map((f, i) => (
            <div key={i} className={`msb-panel__finding msb-panel__finding--${SEVERITY_TONE[f.severity]}`}>
              <div className="msb-panel__finding-title">
                line {f.line} · {f.message}
              </div>
              <div className="msb-panel__finding-detail">{f.fix}</div>
            </div>
          ))}
        </div>
      )}

      {result && (
        <div className="msb-bench__section">
          <div className={`msb-bench__banner msb-bench__banner--${result.ok ? 'ok' : 'bad'}`}>
            <Icon name={result.ok ? 'check' : 'alert'} size={14} />
            {result.ok ? `${type} ran without errors` : result.summary.split('\n')[0]}
            {type === 'onSubmit' && result.ok && <span className="msb-bench__tag">{result.submitAllowed ? 'submit allowed' : 'submit blocked'}</span>}
          </div>

          <h4 className="msb-bench__h">g_form calls</h4>
          {result.calls.length ? (
            <ol className="msb-bench__calls">
              {result.calls.map((c, i) => (
                <li key={i}>
                  <code>{c}</code>
                </li>
              ))}
            </ol>
          ) : (
            <div className="msb-panel__empty">The script made no calls.</div>
          )}

          {result.fieldChanges.length > 0 && (
            <>
              <h4 className="msb-bench__h">Field changes</h4>
              <table className="msb-bench__table">
                <tbody>
                  {result.fieldChanges.map((c, i) => (
                    <tr key={i}>
                      <td>{c.field}</td>
                      <td className="msb-bench__from">{c.from || '(empty)'}</td>
                      <td>→</td>
                      <td className="msb-bench__to">{c.to || '(empty)'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {result.messages.length > 0 && (
            <>
              <h4 className="msb-bench__h">Messages shown to the user</h4>
              {result.messages.map((m, i) => (
                <div key={i} className={`msb-bench__msg msb-bench__msg--${m.type.startsWith('error') || m.type.includes('error') ? 'error' : 'info'}`}>
                  {m.field ? `${m.field}: ` : ''}
                  {m.text}
                </div>
              ))}
            </>
          )}

          {result.ajaxCalls.length > 0 && (
            <>
              <h4 className="msb-bench__h">GlideAjax</h4>
              {result.ajaxCalls.map((a, i) => (
                <div key={i} className="msb-bench__ajax">
                  <code>
                    {a.scriptInclude}.{a.method}
                  </code>{' '}
                  {JSON.stringify(a.params)}
                </div>
              ))}
            </>
          )}

          {result.warnings.length > 0 && (
            <>
              <h4 className="msb-bench__h">Heads up</h4>
              {result.warnings.map((w, i) => (
                <div key={i} className="msb-panel__warning">
                  {w}
                </div>
              ))}
            </>
          )}

          <details className="msb-panel__result">
            <summary className="msb-panel__result-toggle">Final state of the simulated form</summary>
            <div className="msb-panel__result-body">
              <pre>{JSON.stringify(result.finalFields, null, 1)}</pre>
            </div>
          </details>

          {!result.ok && onAskAi && (
            <button
              className="msb-panel__secondary"
              onClick={() => onAskAi('Fix this client script', `This client script threw an error when simulated.\n\n${result.summary}\n\nScript:\n\`\`\`javascript\n${code}\n\`\`\`\nFix it and keep it ES5 and free of server-only APIs.`)}
            >
              <Icon name="sparkle" size={13} /> Ask AI to fix it
            </button>
          )}
        </div>
      )}
    </div>
  );
}
