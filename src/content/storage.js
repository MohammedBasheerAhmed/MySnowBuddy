import { pruneStats } from '../lib/paletteRank.js';

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
  toolSurface: 'window', // where tools open: 'window' (floating, over the page) or 'sidebar' (docked)
  inlineEnabled: true, // page toolbar, field and list menus on the page itself
  roleTiersEnabled: true, // show each user only the tools their roles can use (lib/roleTier.js)
  developerRoles: 'delegated_developer, personalize_dictionary', // roles that count as developer without admin
};

export const THEMES = ['system', 'light', 'dark'];
export const nextTheme = (theme) => THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];

const DEFAULT_UI_STATE = {
  recentCommands: [], // command ids, most recent first
  recentCodeSearches: [], // the last few code searches: { term, wholeWord, activeOnly, tables }
  pinnedCommands: [], // command ids the user pinned; shown first when the palette opens
  commandStats: {}, // command id -> { n: times run, t: last run (epoch ms) }, for frecency ranking
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
const MAX_TRACKED_COMMANDS = 150;

export async function recordCommandUse(commandId) {
  if (!commandId) return;
  const { recentCommands, commandStats } = await getUiState();
  const next = [commandId, ...recentCommands.filter((id) => id !== commandId)].slice(0, MAX_RECENTS);
  const now = Date.now();
  const stats = pruneStats({ ...commandStats, [commandId]: { n: (commandStats[commandId]?.n || 0) + 1, t: now } }, MAX_TRACKED_COMMANDS, now);
  await saveUiState({ recentCommands: next, commandStats: stats });
}
