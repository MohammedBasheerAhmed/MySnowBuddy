import React, { useEffect, useState } from 'react';
import { PROVIDERS, STORAGE_KEYS, keyStorageFor, resolveProviderConfig } from '../providers/config.js';
import { AUTONOMY_LEVELS, MCP_CEILINGS, resolveMcpCeiling } from '../lib/agent/policy.js';

/** Provider, key and model. Keys are kept per vendor so switching never loses one. */
export function ProviderSection() {
  const [provider, setProvider] = useState('anthropic');
  const [keys, setKeys] = useState({ anthropic: '', openai: '' });
  const [models, setModels] = useState({});
  const [saved, setSaved] = useState(false);
  const [validation, setValidation] = useState(null);
  const [validating, setValidating] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(null).then((stored) => {
      const config = resolveProviderConfig(stored);
      setProvider(config.provider);
      setKeys({ anthropic: stored[STORAGE_KEYS.anthropicKey] || '', openai: stored[STORAGE_KEYS.openaiKey] || '' });
      setModels(stored[STORAGE_KEYS.models] || {});
    });
  }, []);

  const def = PROVIDERS[provider];
  const model = def.models.some((m) => m.id === models[provider]) ? models[provider] : def.defaultModel;

  async function save() {
    await chrome.storage.local.set({
      [STORAGE_KEYS.provider]: provider,
      [STORAGE_KEYS.anthropicKey]: keys.anthropic.trim(),
      [STORAGE_KEYS.openaiKey]: keys.openai.trim(),
      [STORAGE_KEYS.models]: { ...models, [provider]: model },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function test() {
    setValidating(true);
    setValidation(null);
    // Test what is on screen, not what was last saved.
    await save();
    const result = await chrome.runtime.sendMessage({ type: 'VALIDATE_API_KEY', payload: { provider, model, apiKey: keys[provider].trim() } });
    setValidation(result);
    setValidating(false);
  }

  return (
    <section>
      <h2>AI provider</h2>
      <p className="msb-options__hint">
        Keys stay in this browser (chrome.storage.local) and are sent only to the provider you pick. Claude gives the best results for the agent and for script writing.
      </p>

      <div className="msb-options__choices" role="radiogroup" aria-label="AI provider">
        {Object.entries(PROVIDERS).map(([id, p]) => (
          <button key={id} type="button" role="radio" aria-checked={provider === id} className={`msb-options__choice${provider === id ? ' msb-options__choice--on' : ''}`} onClick={() => setProvider(id)}>
            <strong>{p.label}</strong>
            <span>{keys[id] ? 'Key saved' : 'No key yet'}</span>
          </button>
        ))}
      </div>

      <label className="msb-options__field">
        {def.keyLabel}
        <input type="password" value={keys[provider]} onChange={(e) => setKeys((k) => ({ ...k, [provider]: e.target.value }))} placeholder={provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'} autoComplete="off" />
        <span className="msb-options__hint">{def.keyHint}</span>
      </label>

      <label className="msb-options__field">
        Model
        <select value={model} onChange={(e) => setModels((m) => ({ ...m, [provider]: e.target.value }))}>
          {def.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <div className="msb-options__actions">
        <button onClick={save}>Save</button>
        <button onClick={test} disabled={validating || !keys[provider]}>
          {validating ? 'Testing...' : 'Save and test'}
        </button>
        {saved && <span className="msb-options__saved">Saved ✓</span>}
      </div>
      {validation && <div className={validation.ok ? 'msb-options__valid' : 'msb-options__invalid'}>{validation.ok ? 'The key works ✓' : `The test failed: ${validation.error}`}</div>}
    </section>
  );
}

/** How much the in-browser agent may do, and the local MCP bridge for external agents. */
export function AgentSection({ settings, update }) {
  const autonomy = AUTONOMY_LEVELS.some((l) => l.id === settings.agentAutonomy) ? settings.agentAutonomy : 'ask';
  return (
    <section>
      <h2>Agent</h2>
      <p className="msb-options__hint">
        In agent mode a plain message can look things up on the instance, write and verify scripts, simulate client scripts and, only with your approval, change the form or save configuration. Everything it does runs under your own ServiceNow session and permissions, and changes are logged so they can be undone.
      </p>
      <label>
        <input type="checkbox" checked={settings.agentEnabled !== false} onChange={() => update({ agentEnabled: settings.agentEnabled === false })} />
        Use the agent for plain messages (turn off to talk to the model without tools)
      </label>
      <label className="msb-options__field">
        Default autonomy
        <select value={autonomy} onChange={(e) => update({ agentAutonomy: e.target.value })}>
          {AUTONOMY_LEVELS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label} - {l.hint}
            </option>
          ))}
        </select>
        <span className="msb-options__hint">Changes to a production instance, or one that is not recognisably dev, test or stage, always need you to type the instance name, whatever you pick here.</span>
      </label>
    </section>
  );
}

const STATE_TEXT = { off: 'Off', connecting: 'Connecting', connected: 'Connected', error: 'Not reachable' };

export function McpSection({ settings, update }) {
  const [status, setStatus] = useState(null);
  const [copied, setCopied] = useState(false);
  const port = Number(settings.mcpPort) || 17345;
  const ceiling = resolveMcpCeiling(settings);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      chrome.runtime
        .sendMessage({ type: 'MCP_BRIDGE_STATUS' })
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    poll();
    const timer = setInterval(poll, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const command = 'claude mcp add mysnowbuddy -- node "<path to MySnowBuddy>/mcp/snowbuddy-mcp.js"';
  function copy() {
    navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <section>
      <h2>
        Local MCP bridge <span className={`msb-options__pill msb-options__pill--${status?.state || 'off'}`}>{STATE_TEXT[status?.state] || 'Off'}</span>
      </h2>
      <p className="msb-options__hint">
        Lets an external AI agent (Claude Code or any MCP client) use this extension's ServiceNow tools through your logged-in tab, instead of guessing from screenshots. It talks to a small program on this computer, over the loopback interface only. Anything that changes or runs something asks you in the browser first.
      </p>
      <label>
        <input type="checkbox" checked={settings.mcpBridgeEnabled === true} onChange={() => update({ mcpBridgeEnabled: settings.mcpBridgeEnabled !== true })} />
        Enable the local MCP bridge
      </label>

      {settings.mcpBridgeEnabled === true && (
        <>
          <label className="msb-options__field">
            Pairing token
            <input type="password" value={settings.mcpToken || ''} onChange={(e) => update({ mcpToken: e.target.value.trim() })} placeholder="paste the contents of ~/.mysnowbuddy/mcp-token" autoComplete="off" />
            <span className="msb-options__hint">
              The MCP server creates this file the first time it runs. Without the token nothing can talk to the extension.
            </span>
          </label>
          <label className="msb-options__field">
            Port
            <input type="text" value={port} onChange={(e) => update({ mcpPort: Number(e.target.value.replace(/\D/g, '')) || 17345 })} />
          </label>
          <label className="msb-options__field">
            What an external agent may do
            <select
              value={ceiling}
              onChange={(e) => {
                const next = e.target.value;
                // mcpAutonomy is kept in step for older builds that only read it.
                update({ mcpCeiling: next, mcpAutonomy: next === 'observe' || next === 'draft' ? 'readonly' : 'ask' });
              }}
            >
              {MCP_CEILINGS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="msb-options__hint">
              {MCP_CEILINGS.find((c) => c.id === ceiling)?.hint} Tools above this level are hidden from the agent and refused if called. Anything that runs or changes something still asks you in the browser, every time.
            </span>
          </label>
          <p className="msb-options__hint">
            Screenshots: Chrome only lets the extension capture a tab after you click the MySnowBuddy icon (or press Alt+Shift+C) on it.
          </p>
          {status && status.detail && <div className={status.state === 'connected' ? 'msb-options__valid' : 'msb-options__hint'}>{status.detail}</div>}
        </>
      )}

      <p className="msb-options__hint">
        Add it to Claude Code with: <code>{command}</code>{' '}
        <button type="button" className="msb-options__link" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </p>
    </section>
  );
}

export { keyStorageFor };
