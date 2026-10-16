const SETTINGS_KEY = 'mysnowbuddy_settings';
const UI_STATE_KEY = 'mysnowbuddy_ui_state';

const DEFAULT_SETTINGS = {
  sidebarEnabled: true,
  paletteEnabled: true,
  instanceBadgeEnabled: true,
  instanceTagEnabled: true,
  guardsEnabled: true,
  agentEnabled: true,
  agentAutonomy: 'ask',
  mcpBridgeEnabled: false,
  mcpToken: '',
  mcpPort: 17345,
  mcpAutonomy: 'ask',
  theme: 'system',
};

export const THEMES = ['system', 'light', 'dark'];
export const nextTheme = (theme) => THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];

const DEFAULT_UI_STATE = {
  recentCommands: [], // command ids, most recent first
};

export async function getSettings() {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Calls back with the full settings whenever they change; returns an unsubscribe function. */
export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      callback({ ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) });
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export async function getUiState() {
  const res = await chrome.storage.local.get(UI_STATE_KEY);
  return { ...DEFAULT_UI_STATE, ...(res[UI_STATE_KEY] || {}) };
}

export async function saveUiState(patch) {
  const current = await getUiState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [UI_STATE_KEY]: next });
  return next;
}

const MAX_RECENTS = 8;

export async function recordCommandUse(commandId) {
  if (!commandId) return;
  const { recentCommands } = await getUiState();
  const next = [commandId, ...recentCommands.filter((id) => id !== commandId)].slice(0, MAX_RECENTS);
  await saveUiState({ recentCommands: next });
}
