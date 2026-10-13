// History of scripts run through the background-script panel (most recent first).

const KEY = 'mysnowbuddy_script_history';
export const MAX_HISTORY = 30;
const MAX_SCRIPT_CHARS = 20000;

/** Add `entry` to the list, dropping an identical earlier script and capping the length. */
export function pushHistory(list, entry, max = MAX_HISTORY) {
  const script = String(entry.script || '').slice(0, MAX_SCRIPT_CHARS);
  if (!script.trim()) return list;
  const rest = list.filter((e) => e.script !== script);
  return [{ ...entry, script }, ...rest].slice(0, max);
}

export async function loadHistory() {
  const stored = await chrome.storage.local.get(KEY);
  return Array.isArray(stored[KEY]) ? stored[KEY] : [];
}

export async function recordRun({ script, instance, scope, dryRun }) {
  const list = await loadHistory();
  const next = pushHistory(list, { script, instance, scope, dryRun: Boolean(dryRun), ts: Date.now() });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function clearHistory() {
  await chrome.storage.local.remove(KEY);
}
