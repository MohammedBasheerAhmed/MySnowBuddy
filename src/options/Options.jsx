import React, { useEffect, useState } from 'react';

const KEY_STORAGE = 'mysnowbuddy_openai_key';
const SETTINGS_STORAGE = 'mysnowbuddy_settings';

export default function Options() {
  const [apiKey, setApiKey] = useState('');
  const [savedIndicator, setSavedIndicator] = useState(false);
  const [validation, setValidation] = useState(null);
  const [validating, setValidating] = useState(false);
  const [settings, setSettings] = useState({
    toolbarEnabled: true,
    sidebarEnabled: true,
    paletteEnabled: true,
    instanceBadgeEnabled: true,
  });

  useEffect(() => {
    chrome.storage.local.get([KEY_STORAGE, SETTINGS_STORAGE]).then((res) => {
      if (res[KEY_STORAGE]) setApiKey(res[KEY_STORAGE]);
      if (res[SETTINGS_STORAGE]) setSettings((s) => ({ ...s, ...res[SETTINGS_STORAGE] }));
    });
  }, []);

  async function handleSave() {
    await chrome.storage.local.set({ [KEY_STORAGE]: apiKey });
    setSavedIndicator(true);
    setTimeout(() => setSavedIndicator(false), 2000);
  }

  async function handleValidate() {
    setValidating(true);
    setValidation(null);
    const result = await chrome.runtime.sendMessage({ type: 'VALIDATE_API_KEY', payload: { apiKey } });
    setValidation(result);
    setValidating(false);
  }

  async function toggleSetting(key) {
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next);
    await chrome.storage.local.set({ [SETTINGS_STORAGE]: next });
  }

  return (
    <div className="msb-options">
      <header className="msb-options__header">
        <span className="msb-options__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path
              d="M12 3l1.8 4.9L19 9.7l-4.4 2.5L13.8 17 12 14.2 10.2 17l-1.4-4.8L5 9.7l5.2-1.8z"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div>
          <h1>MySnowBuddy</h1>
          <p className="msb-options__tagline">ServiceNow developer toolkit settings</p>
        </div>
      </header>

      <section>
        <h2>OpenAI API Key</h2>
        <p className="msb-options__hint">
          Stored only in this browser (chrome.storage.local). Never synced, never sent anywhere except directly to
          OpenAI.
        </p>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          autoComplete="off"
        />
        <div className="msb-options__actions">
          <button onClick={handleSave}>Save</button>
          <button onClick={handleValidate} disabled={validating || !apiKey}>
            {validating ? 'Validating...' : 'Test Key'}
          </button>
          {savedIndicator && <span className="msb-options__saved">Saved \u2713</span>}
        </div>
        {validation && (
          <div className={validation.ok ? 'msb-options__valid' : 'msb-options__invalid'}>
            {validation.ok ? 'Key is valid \u2713' : `Validation failed: ${validation.error}`}
          </div>
        )}
      </section>

      <section>
        <h2>Features</h2>
        <label>
          <input
            type="checkbox"
            checked={settings.toolbarEnabled}
            onChange={() => toggleSetting('toolbarEnabled')}
          />
          Show the floating toolbar
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.sidebarEnabled}
            onChange={() => toggleSetting('sidebarEnabled')}
          />
          Enable chat sidebar
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.paletteEnabled}
            onChange={() => toggleSetting('paletteEnabled')}
          />
          Enable the command palette keyboard shortcut
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.instanceBadgeEnabled}
            onChange={() => toggleSetting('instanceBadgeEnabled')}
          />
          Show the environment badge (PROD / TEST / DEV) on the toolbar
        </label>
      </section>

      <section>
        <h2>Keyboard shortcuts</h2>
        <ul>
          <li>
            <code>Ctrl+Shift+Space</code> {'\u2014'} open the command palette
          </li>
          <li>
            <code>Alt+Shift+C</code> {'\u2014'} toggle the AI chat sidebar
          </li>
          <li>
            In the palette: type a table name, paste a <code>sys_id</code>, type <code>@username</code> to
            impersonate, or <code>/command</code> to run a chat command. <code>Shift+Enter</code> opens a result
            in a new tab.
          </li>
        </ul>
        <p className="msb-options__hint">
          Shortcuts can be remapped at <code>chrome://extensions/shortcuts</code>.
        </p>
      </section>

      <section>
        <h2>Instance credentials (Instance Compare)</h2>
        <p className="msb-options__hint">
          Optional. Only needed for instances you are NOT already logged into in this browser. Stored in
          chrome.storage.local and sent only to that instance over HTTPS.
        </p>
        <InstanceCredentials />
      </section>

      <section>
        <h2>Known limitations (v1)</h2>
        <ul>
          <li>Secret redaction before sending script content to OpenAI is regex-based — a safety net, not a guarantee.</li>
          <li>Context detection selectors are heuristic and may need refinement per ServiceNow UI version.</li>
          <li>The environment badge is guessed from the instance name, so an unusual naming convention shows a neutral badge rather than a wrong one.</li>
          <li>Update set switching from the palette uses the platform picker API and is unconfirmed against a live instance — see docs/decisions.md.</li>
          <li>Classic UI iframe (gsft_main) forms are not yet supported for context detection — Next Experience UI only in v1.</li>
          <li>Background script execution and impersonation endpoints are unconfirmed against a live instance — see docs/decisions.md.</li>
          <li>Voice input uses the browser's built-in speech recognition, which in Chrome transcribes server-side. Do not dictate secrets.</li>
          <li>Instance credentials are stored unencrypted in local extension storage. Prefer logging into both instances instead.</li>
        </ul>
      </section>
    </div>
  );
}

const CREDS_KEY = 'mysnowbuddy_instance_credentials';

function InstanceCredentials() {
  const [creds, setCreds] = useState({});
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    chrome.storage.local.get(CREDS_KEY).then((res) => setCreds(res[CREDS_KEY] || {}));
  }, []);

  async function persist(next) {
    setCreds(next);
    await chrome.storage.local.set({ [CREDS_KEY]: next });
  }

  async function handleAdd() {
    setError(null);
    const cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!/\.service-now\.com$/i.test(cleanHost)) {
      setError('Host must be a *.service-now.com instance.');
      return;
    }
    if (!username || !password) {
      setError('Username and password are both required.');
      return;
    }
    await persist({ ...creds, [cleanHost]: { username, password } });
    setHost('');
    setUsername('');
    setPassword('');
  }

  async function handleRemove(key) {
    const next = { ...creds };
    delete next[key];
    await persist(next);
  }

  return (
    <div>
      <div className="msb-options__cred-form">
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="dev12345.service-now.com" />
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoComplete="off" />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          autoComplete="new-password"
        />
        <button onClick={handleAdd}>Add</button>
      </div>
      {error && <div className="msb-options__invalid">{error}</div>}

      {Object.keys(creds).length === 0 ? (
        <p className="msb-options__hint">No stored instance credentials.</p>
      ) : (
        <ul className="msb-options__cred-list">
          {Object.entries(creds).map(([key, value]) => (
            <li key={key}>
              <span>
                {key} — {value.username}
              </span>
              <button onClick={() => handleRemove(key)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
