import React, { useEffect, useState } from 'react';
import {
  listInstances,
  addInstance,
  removeInstance,
  listPresets,
  addPreset,
  removePreset,
  listCustomCommands,
  addCustomCommand,
  removeCustomCommand,
} from '../content/stores.js';
import { getSyncEnabled, setSyncEnabled } from '../lib/promptLibrary.js';
import { ProviderSection, AgentSection, McpSection } from './AgentSettings.jsx';

const SETTINGS_STORAGE = 'mysnowbuddy_settings';

export default function Options() {
  const [settings, setSettings] = useState({
    sidebarEnabled: true,
    paletteEnabled: true,
    instanceBadgeEnabled: true,
  });
  const [syncOn, setSyncOn] = useState(false);

  useEffect(() => {
    getSyncEnabled().then(setSyncOn);
  }, []);

  async function toggleSync() {
    const next = !syncOn;
    setSyncOn(next);
    await setSyncEnabled(next);
  }

  useEffect(() => {
    chrome.storage.local.get([SETTINGS_STORAGE]).then((res) => {
      if (res[SETTINGS_STORAGE]) setSettings((s) => ({ ...s, ...res[SETTINGS_STORAGE] }));
    });
  }, []);

  // Merge a patch into the shared settings object (read fresh so two sections never overwrite each other).
  async function updateSettings(patch) {
    const stored = (await chrome.storage.local.get(SETTINGS_STORAGE))[SETTINGS_STORAGE] || {};
    const next = { ...stored, ...patch };
    setSettings((s) => ({ ...s, ...patch }));
    await chrome.storage.local.set({ [SETTINGS_STORAGE]: next });
  }

  async function toggleSetting(key) {
    await updateSettings({ [key]: !settings[key] });
  }

  const theme = settings.theme || 'system';
  useEffect(() => {
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }, [theme]);

  async function changeTheme(value) {
    await updateSettings({ theme: value });
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

      <ProviderSection />

      <AgentSection settings={settings} update={updateSettings} />

      <McpSection settings={settings} update={updateSettings} />

      <section>
        <h2>Appearance</h2>
        <p className="msb-options__hint">
          Applies to the sidebar, command palette, editor and this page. Match system follows your operating system.
        </p>
        <select value={theme} onChange={(e) => changeTheme(e.target.value)} aria-label="Theme">
          <option value="system">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </section>

      <section>
        <h2>Features</h2>
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
          Show the environment badge (PROD / TEST / DEV) in the sidebar header
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.instanceTagEnabled !== false}
            onChange={() => updateSettings({ instanceTagEnabled: settings.instanceTagEnabled === false })}
          />
          Tag the browser tab: [DEV] title prefix, coloured favicon and a stripe at the top of the page
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.guardsEnabled !== false}
            onChange={() => updateSettings({ guardsEnabled: settings.guardsEnabled === false })}
          />
          Safety guards: warn about the Default update set and confirm saves on PROD
        </label>
        <label>
          <input type="checkbox" checked={syncOn} onChange={toggleSync} />
          Sync my prompt library across browsers (uses chrome.storage.sync, about 80 KB limit)
        </label>
      </section>

      <section>
        <h2>Known instances</h2>
        <p className="msb-options__hint">
          Used by "Compare with another instance". Only *.service-now.com hosts are accepted.
        </p>
        <p className="msb-options__hint">
          Also offered by Push to instance (/push). A label with the word "prod" or "production" makes every push to that
          instance ask you to type its name, whatever its hostname looks like.
        </p>
        <PairList
          load={listInstances}
          add={({ a, b }) => addInstance({ label: a, host: b })}
          remove={removeInstance}
          labelPlaceholder="label (e.g. PROD)"
          valuePlaceholder="prod12345.service-now.com"
          render={(item) => `${item.label} \u2014 ${item.host}`}
        />
      </section>

      <section>
        <h2>Impersonation presets</h2>
        <p className="msb-options__hint">
          Appear in the command palette as "Impersonate ...". Use the user_name of the account.
        </p>
        <PairList
          load={listPresets}
          add={({ a, b }) => addPreset({ label: a, userName: b })}
          remove={removePreset}
          labelPlaceholder="label (e.g. ITIL user)"
          valuePlaceholder="user_name"
          render={(item) => `${item.label} \u2014 ${item.userName}`}
        />
      </section>

      <section>
        <h2>Custom slash commands</h2>
        <p className="msb-options__hint">
          Type <code>/name text</code> in the palette. The target is a path on the instance; <code>{'{q}'}</code> is
          replaced with your text as an encoded-query value and <code>{'{raw}'}</code> as plain text. Example:{' '}
          <code>/incident_list.do?sysparm_query=short_descriptionLIKE{'{q}'}</code>
        </p>
        <PairList
          load={listCustomCommands}
          add={({ a, b }) => addCustomCommand({ verb: a, template: b })}
          remove={removeCustomCommand}
          labelPlaceholder="name (e.g. mine)"
          valuePlaceholder="/incident_list.do?sysparm_query=assigned_to=javascript:gs.getUserID()"
          render={(item) => `/${item.verb} \u2014 ${item.template}`}
        />
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
        <p className="msb-options__hint">
          Push to instance writes to the target with your browser session first; ServiceNow usually refuses that without the
          target page&apos;s token, and the push then uses the credentials saved here.
        </p>
        <InstanceCredentials />
      </section>

      <section>
        <h2>Known limitations (v1)</h2>
        <ul>
          <li>Secret redaction before sending script content to the AI provider is regex-based — a safety net, not a guarantee.</li>
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

function PairList({ load, add, remove, labelPlaceholder, valuePlaceholder, render }) {
  const [items, setItems] = useState([]);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState(null);

  const refresh = () => load().then(setItems);
  useEffect(() => {
    refresh();
  }, []);

  async function handleAdd() {
    setError(null);
    try {
      await add({ a, b });
      setA('');
      setB('');
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRemove(id) {
    await remove(id);
    await refresh();
  }

  return (
    <div>
      <div className="msb-options__cred-form">
        <input value={a} onChange={(e) => setA(e.target.value)} placeholder={labelPlaceholder} />
        <input value={b} onChange={(e) => setB(e.target.value)} placeholder={valuePlaceholder} />
        <button onClick={handleAdd}>Add</button>
      </div>
      {error && <div className="msb-options__invalid">{error}</div>}
      {items.length > 0 && (
        <ul className="msb-options__cred-list">
          {items.map((item) => (
            <li key={item.id}>
              <span>{render(item)}</span>
              <button onClick={() => handleRemove(item.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
