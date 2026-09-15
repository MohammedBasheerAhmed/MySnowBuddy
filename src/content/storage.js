const SETTINGS_KEY = 'mysnowbuddy_settings';
const UI_STATE_KEY = 'mysnowbuddy_ui_state';

const DEFAULT_SETTINGS = {
  toolbarEnabled: true,
  sidebarEnabled: true,
  paletteEnabled: true,
  instanceBadgeEnabled: true,
};

const DEFAULT_UI_STATE = {
  toolbarPosition: null, // { right, bottom } in px, set by dragging the rail
  recentCommands: [], // command ids, most recent first
};

export async function getSettings() {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
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
