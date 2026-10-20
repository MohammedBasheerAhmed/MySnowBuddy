import React, { useEffect, useState } from 'react';
import { PROVIDERS, STORAGE_KEYS, keyStorageFor, baseUrlStorageFor, resolveProviderConfig } from '../providers/config.js';
import { validateBaseUrl, originPattern } from '../lib/aiUsage.js';
import { AUTONOMY_LEVELS, MCP_CEILINGS, resolveMcpCeiling } from '../lib/agent/policy.js';

const SETTINGS_STORAGE = 'mysnowbuddy_settings';

/** Provider, key and model. Keys are kept per vendor so switching never loses one. */
export function ProviderSection() {
  const [provider, setProvider] = useState('anthropic');
  const [keys, setKeys] = useState({ anthropic: '', openai: '' });
  const [models, setModels] = useState({});
  const [saved, setSaved] = useState(false);
  const [validation, setValidation] = useState(null);
  const [validating, setValidating] = useState(false);
  const [baseUrls, setBaseUrls] = useState({ anthropic: '', openai: '' });
  const [baseError, setBaseError] = useState('');
  const [promptCache, setPromptCache] = useState(true);

  useEffect(() => {
    chrome.storage.local.get(null).then((stored) => {
      const config = resolveProviderConfig(stored);
      setProvider(config.provider);
      setKeys({ anthropic: stored[STORAGE_KEYS.anthropicKey] || '', openai: stored[STORAGE_KEYS.openaiKey] || '' });
      setModels(stored[STORAGE_KEYS.models] || {});
      setBaseUrls({ anthropic: stored[STORAGE_KEYS.anthropicBaseUrl] || '', openai: stored[STORAGE_KEYS.openaiBaseUrl] || '' });
      setPromptCache(stored[SETTINGS_STORAGE]?.promptCache !== false);
    });
  }, []);

  const def = PROVIDERS[provider];
  const base = validateBaseUrl(baseUrls[provider]);
  const custom = base.ok && Boolean(base.url);
  // With a custom endpoint the model is whatever that server calls it; otherwise one of the listed models.
  const model = custom ? models[provider] || '' : def.models.some((m) => m.id === models[provider]) ? models[provider] : def.defaultModel;

  /** Check the endpoint, ask Chrome for access to its host (this runs inside the Save click), then store everything. */
  async function save() {
    setBaseError('');
    if (!base.ok) {
      setBaseError(base.error);
      return false;
    }
    if (base.url && !model.trim()) {
      setBaseError('Type the model id this endpoint expects, for example grok-4 or llama3.');
      return false;
    }
    if (base.url) {
      const granted = await chrome.permissions.request({ origins: [originPattern(base.url)] }).catch(() => false);
      if (!granted) {
        setBaseError(`Chrome did not give NowBuddy access to ${base.host}, so the endpoint was not saved.`);
        return false;
      }
    }
    const settings = (await chrome.storage.local.get(SETTINGS_STORAGE))[SETTINGS_STORAGE] || {};
    await chrome.storage.local.set({
      [STORAGE_KEYS.provider]: provider,
      [STORAGE_KEYS.anthropicKey]: keys.anthropic.trim(),
      [STORAGE_KEYS.openaiKey]: keys.openai.trim(),
      [STORAGE_KEYS.models]: { ...models, [provider]: model },
      [baseUrlStorageFor(provider)]: base.url,
      [SETTINGS_STORAGE]: { ...settings, promptCache },
    });
    setBaseUrls((u) => ({ ...u, [provider]: base.url }));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    return true;
  }

  async function test() {
    setValidating(true);
    setValidation(null);
    // Test what is on screen, not what was last saved.
    if (!(await save())) {
      setValidating(false);
      return;
    }
    const result = await chrome.runtime.sendMessage({ type: 'VALIDATE_API_KEY', payload: { provider, model, apiKey: keys[provider].trim(), baseUrl: base.url } });
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
        {provider === 'openai' ? 'OpenAI-compatible endpoint (optional)' : 'Anthropic proxy endpoint (optional)'}
        <input
          type="text"
          value={baseUrls[provider]}
          onChange={(e) => {
            setBaseUrls((u) => ({ ...u, [provider]: e.target.value }));
            setBaseError('');
          }}
          placeholder={provider === 'openai' ? 'https://api.x.ai/v1' : 'https://my-proxy.example.com/v1'}
          autoComplete="off"
          spellCheck="false"
        />
        <span className="msb-options__hint">
          {provider === 'openai'
            ? 'Leave empty for OpenAI itself. For another service that speaks the same API, give its base address, for example https://api.x.ai/v1 (xAI Grok), https://openrouter.ai/api/v1, or http://localhost:11434/v1 (Ollama, no key needed). NowBuddy calls <address>/chat/completions.'
            : 'Leave empty for api.anthropic.com. Only fill this in if you route Claude through your own gateway; NowBuddy calls <address>/messages.'}
        </span>
      </label>
      {custom && (
        <div className="msb-options__hint" role="note">
          Prompts, and the record data the agent has read, will be sent to <strong>{base.host}</strong> instead of the vendor above. Chrome asks you to allow that address when you save. Secrets are still masked before anything is sent.
        </div>
      )}
      {baseError && (
        <div className="msb-options__invalid" role="alert">
          {baseError}
        </div>
      )}

      <label className="msb-options__field">
        {custom ? 'Model id' : 'Model'}
        {custom ? (
          <input type="text" value={model} onChange={(e) => setModels((m) => ({ ...m, [provider]: e.target.value }))} placeholder="grok-4" autoComplete="off" spellCheck="false" />
        ) : (
          <select value={model} onChange={(e) => setModels((m) => ({ ...m, [provider]: e.target.value }))}>
            {def.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
      </label>

      <label>
        <input type="checkbox" checked={promptCache} onChange={() => setPromptCache((on) => !on)} />
        Prompt caching (Claude): reuse the unchanged start of a conversation at a lower token price. Turn off if a gateway rejects it.
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
      <AgentSafety settings={settings} update={update} />
    </section>
  );
}

/**
 * The write guardrails (src/lib/agent/guardrails.js). They are checked where a change is made, not only on the approval
 * card, so a card that was approved from an old screen still cannot get around them. Defaults are the safe ones.
 */
function AgentSafety({ settings, update }) {
  return (
    <fieldset className="msb-options__safety">
      <legend>Agent safety</legend>
      <p className="msb-options__hint">
        These rules apply to every change the agent makes, in the sidebar and for an external agent. Each change still needs your approval; these decide what is allowed to reach the approval card at all.
      </p>
      <label>
        <input type="checkbox" checked={settings.allowSecurityTableWrites === true} onChange={() => update({ allowSecurityTableWrites: settings.allowSecurityTableWrites !== true })} />
        Allow changes to ACL and role tables
      </label>
      <span className="msb-options__hint">
        Off by default: the agent may not create, change or delete access rules or role grants (sys_security_acl, sys_user_role, sys_user_has_role, sys_group_has_role and the related tables). Even when this is on, you must first elevate to security_admin in ServiceNow, otherwise the answer is "Elevate to security_admin to edit ACL or role records."
      </span>
      <label>
        <input type="checkbox" checked={settings.refuseActiveScriptEdits === true} onChange={() => update({ refuseActiveScriptEdits: settings.refuseActiveScriptEdits !== true })} />
        Refuse edits to active scripts and rules
      </label>
      <span className="msb-options__hint">
        Off by default. An edit to an active business rule, script include or similar goes live the moment it is saved; the approval card says so either way. Turn this on to make the agent leave active code to you.
      </span>
      <label>
        <input type="checkbox" checked={settings.agentReadOnlyForNonAdmin === true} onChange={() => update({ agentReadOnlyForNonAdmin: settings.agentReadOnlyForNonAdmin !== true })} />
        Read-only for users without the admin role
      </label>
      <span className="msb-options__hint">
        Off by default. When on, anyone who is not an admin can still ask questions and get drafts, but every change is refused with "Updating records is turned off for your role." If the roles cannot be read, changes are refused.
      </span>
      <label className="msb-options__field">
        Tables the agent may never read or change
        <input
          type="text"
          value={settings.deniedTables || ''}
          onChange={(e) => update({ deniedTables: e.target.value })}
          placeholder="u_vault_*, x_acme_*"
          autoComplete="off"
          spellCheck={false}
        />
        <span className="msb-options__hint">
          Comma-separated table names; * matches any characters. Added to the tables that are always denied (credentials, keys, certificates, OAuth and authentication tables), which cannot be switched off.
        </span>
      </label>
      <p className="msb-options__hint">
        Always on, whatever is set here: a change is refused if the record changed after the approval card was made, and the card names the update set a configuration change will be captured in.
      </p>
    </fieldset>
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

  const command = 'claude mcp add mysnowbuddy -- node "<path to NowBuddy>/mcp/snowbuddy-mcp.js"';
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
            Screenshots: Chrome only lets the extension capture a tab after you click the NowBuddy icon (or press Alt+Shift+C) on it.
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
