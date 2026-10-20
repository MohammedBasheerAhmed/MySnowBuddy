// Small persisted lists used by navigation, impersonation and cross-instance features.
// Everything lives in chrome.storage.local and is capped so it cannot grow without bound.

import { normalizeCustomCommand } from '../lib/slashCommands.js';
import { parseInstanceHost, makeInstance, patchInstance, moveInstance } from '../lib/instances.js';

const KEYS = {
  bookmarks: 'mysnowbuddy_bookmarks',
  recents: 'mysnowbuddy_recent_records',
  presets: 'mysnowbuddy_impersonation_presets',
  instances: 'mysnowbuddy_known_instances',
  customCommands: 'mysnowbuddy_custom_commands',
};

const CAPS = { bookmarks: 100, recents: 30, presets: 30, instances: 20, customCommands: 50 };

const SYS_ID_RE = /^[0-9a-f]{32}$/i;

/** Where the known-instance list lives; the instance tag and the quick actions watch this key. */
export const INSTANCES_KEY = KEYS.instances;

async function readList(name) {
  const res = await chrome.storage.local.get(KEYS[name]);
  return Array.isArray(res[KEYS[name]]) ? res[KEYS[name]] : [];
}

async function writeList(name, list) {
  await chrome.storage.local.set({ [KEYS[name]]: list.slice(0, CAPS[name]) });
}

const clip = (value, max) => String(value ?? '').trim().slice(0, max);

const NOUNS = { presets: 'impersonation presets', instances: 'instances', customCommands: 'custom commands' };

// Lists that append new entries at the end: writeList keeps the first CAPS entries, so a full
// list would silently drop the entry just added. Refuse it with a clear message instead.
async function appendEntry(name, rest, entry) {
  if (rest.length >= CAPS[name]) {
    throw new Error(`You can keep up to ${CAPS[name]} ${NOUNS[name]}. Remove one first.`);
  }
  await writeList(name, [...rest, entry]);
  return entry;
}

// --- Bookmarks (per instance, root-relative paths only) ----------------------

export async function listBookmarks(host) {
  return (await readList('bookmarks')).filter((b) => b.host === host);
}

export async function addBookmark(host, { title, path }) {
  if (!String(path || '').startsWith('/') || String(path).startsWith('//')) {
    throw new Error('Bookmarks must point to a page on this instance.');
  }
  const list = await readList('bookmarks');
  const entry = {
    id: crypto.randomUUID(),
    host,
    title: clip(title, 80) || path,
    path: clip(path, 1000),
    createdAt: Date.now(),
  };
  const rest = list.filter((b) => !(b.host === host && b.path === entry.path));
  await writeList('bookmarks', [entry, ...rest]);
  return entry;
}

export async function removeBookmark(id) {
  await writeList('bookmarks', (await readList('bookmarks')).filter((b) => b.id !== id));
}

// --- Recently opened records ---------------------------------------------------

export async function listRecents(host) {
  return (await readList('recents')).filter((r) => r.host === host);
}

export async function recordRecent(host, { table, sysId, title, path }) {
  if (!table || !SYS_ID_RE.test(sysId || '')) return;
  const list = await readList('recents');
  if (list[0]?.host === host && list[0]?.sysId === sysId) return;
  const entry = { host, table, sysId, title: clip(title, 80) || `${table} ${sysId.slice(0, 8)}`, path: clip(path, 1000), at: Date.now() };
  await writeList('recents', [entry, ...list.filter((r) => !(r.host === host && r.sysId === sysId))]);
}

// --- Impersonation presets -------------------------------------------------------

export async function listPresets() {
  return readList('presets');
}

export async function addPreset({ label, userName }) {
  const user = clip(userName, 100);
  if (!user) throw new Error('A user name is required.');
  const list = await readList('presets');
  const entry = { id: crypto.randomUUID(), label: clip(label, 60) || user, userName: user };
  return appendEntry('presets', list.filter((p) => p.userName !== user), entry);
}

export async function removePreset(id) {
  await writeList('presets', (await readList('presets')).filter((p) => p.id !== id));
}

// --- Known instances ----------------------------------------------------------------

export async function listCustomCommands() {
  return readList('customCommands');
}

export async function addCustomCommand({ verb, template }) {
  const clean = normalizeCustomCommand({ verb, template });
  const list = await readList('customCommands');
  const entry = { id: crypto.randomUUID(), ...clean, label: clean.template };
  return appendEntry('customCommands', list.filter((c) => c.verb !== clean.verb), entry);
}

export async function removeCustomCommand(id) {
  await writeList('customCommands', (await readList('customCommands')).filter((c) => c.id !== id));
}

// --- Known instances ----------------------------------------------------------------

// Lenient on purpose: Compare and Push take whatever was pasted from the address bar and keep the host. The
// instance list is strict (parseInstanceHost): a stored destination must be a bare *.service-now.com host.
export function normalizeHost(raw) {
  const host = String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  const parsed = parseInstanceHost(host);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.host;
}

export async function listInstances() {
  return readList('instances');
}

export async function addInstance({ label, host, color }) {
  const entry = makeInstance({ id: crypto.randomUUID(), label, host, color });
  const list = await readList('instances');
  return appendEntry('instances', list.filter((i) => i.host !== entry.host), entry);
}

export async function removeInstance(id) {
  await writeList('instances', (await readList('instances')).filter((i) => i.id !== id));
}

/** Rename or recolour one known instance (`color: ''` goes back to automatic). Returns the new list. */
export async function updateInstance(id, patch) {
  const next = patchInstance(await readList('instances'), id, patch);
  await writeList('instances', next);
  return next;
}

/** Move one known instance up (-1) or down (+1) in the picker. Returns the new list. */
export async function reorderInstance(id, delta) {
  const next = moveInstance(await readList('instances'), id, delta);
  await writeList('instances', next);
  return next;
}
