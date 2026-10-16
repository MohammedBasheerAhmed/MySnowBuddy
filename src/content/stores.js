// Small persisted lists used by navigation, impersonation and cross-instance features.
// Everything lives in chrome.storage.local and is capped so it cannot grow without bound.

import { normalizeCustomCommand } from '../lib/slashCommands.js';

const KEYS = {
  bookmarks: 'mysnowbuddy_bookmarks',
  recents: 'mysnowbuddy_recent_records',
  presets: 'mysnowbuddy_impersonation_presets',
  instances: 'mysnowbuddy_known_instances',
  customCommands: 'mysnowbuddy_custom_commands',
};

const CAPS = { bookmarks: 100, recents: 30, presets: 30, instances: 20, customCommands: 50 };

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const INSTANCE_HOST_RE = /^[a-z0-9-]+\.service-now\.com$/i;

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

export function normalizeHost(raw) {
  const host = String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  if (!INSTANCE_HOST_RE.test(host)) throw new Error('Enter a hostname like dev12345.service-now.com.');
  return host;
}

export async function listInstances() {
  return readList('instances');
}

export async function addInstance({ label, host }) {
  const normalized = normalizeHost(host);
  const list = await readList('instances');
  const entry = { id: crypto.randomUUID(), label: clip(label, 40) || normalized.split('.')[0], host: normalized };
  return appendEntry('instances', list.filter((i) => i.host !== normalized), entry);
}

export async function removeInstance(id) {
  await writeList('instances', (await readList('instances')).filter((i) => i.id !== id));
}
