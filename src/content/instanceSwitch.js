// The instance switcher: "/i" in the palette (and a "Go to <instance>" command per known instance) opens the page
// you are on, on another instance. Enter goes there in this tab, Shift/Ctrl+Enter opens a new tab, Alt+Enter copies
// the link. A page that has no counterpart elsewhere (login, a session page) opens the other instance's home page,
// and the row says so before you pick it. Instances come from Options > Instances; which colour each one gets is in
// lib/instances.js. Only hosts that pass parseInstanceHost are ever navigated to.

import { classifyEnvironment, getInstanceInfo } from './quickActions.js';
import { listInstances, addInstance } from './stores.js';
import { rankInstances, mapPageToInstance, switchUrl, resolveColor, validColor, parseInstanceHost } from '../lib/instances.js';

const GROUP = 'Instance';

const hostLabel = (host) => String(host).split('.')[0];

function toneOf(entry) {
  return (classifyEnvironment(entry.label) || classifyEnvironment(hostLabel(entry.host)))?.tone || 'neutral';
}

function currentMapping() {
  return mapPageToInstance({ pathname: window.location.pathname, search: window.location.search, hash: window.location.hash });
}

function go(url, newTab) {
  if (newTab) window.open(url, '_blank', 'noopener,noreferrer');
  else window.location.assign(url);
}

/** Palette rows for the known instances matching `query`, best first; the instance you are on is marked and last. */
export async function instanceRows(query = '', { toast, score = 1100 } = {}) {
  const here = window.location.hostname.toLowerCase();
  const list = await listInstances().catch(() => []);
  const mapping = currentMapping();
  const ranked = rankInstances(list, query, here);

  const rows = ranked.map(({ entry, current }, index) => {
    const url = current ? '' : switchUrl(entry.host, mapping);
    const env = (classifyEnvironment(entry.label) || classifyEnvironment(hostLabel(entry.host)))?.label || '';
    return {
      id: `instance.go.${entry.host}`,
      title: entry.label || hostLabel(entry.host),
      hint: current ? `${entry.host} · you are here` : `${entry.host} · ${mapping.mapped ? 'same page' : 'home page'}`,
      group: GROUP,
      icon: 'instance',
      swatch: resolveColor({ saved: validColor(entry.color), tone: toneOf(entry), host: entry.host }),
      badge: env,
      score: score - index,
      ...(current ? {} : { copyUrl: url }),
      run: ({ newTab = false } = {}) => {
        if (current) {
          toast?.info(`You are already on ${entry.label || entry.host}.`);
          return;
        }
        go(url, newTab);
      },
    };
  });

  const known = list.some((entry) => String(entry.host).toLowerCase() === here);
  const tokens = String(query).trim();
  if (!known && !tokens && !parseInstanceHost(here).error) {
    const guess = getInstanceInfo();
    rows.push({
      id: 'instance.remember',
      title: `Remember ${here}`,
      hint: 'Add this instance to the switcher',
      group: GROUP,
      icon: 'instance',
      score: score - rows.length,
      run: async () => {
        try {
          await addInstance({ label: hostLabel(here).toUpperCase().slice(0, 12) || guess.label, host: here });
          toast?.success(`Added ${here}. Rename or recolour it in Options > Instances.`);
        } catch (err) {
          toast?.error(err.message || String(err));
        }
      },
    });
  }
  if (!rows.length) {
    rows.push({
      id: 'instance.none',
      title: tokens ? `No instance matches "${tokens}"` : 'No instances saved yet',
      hint: 'Add them in Options > Instances',
      group: GROUP,
      icon: 'instance',
      score,
      run: () => chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }),
    });
  }
  return rows;
}

/** Palette provider for "/i" and "/instance" followed by an optional filter. */
export function instanceSwitchProvider({ toast } = {}) {
  return async (query) => {
    const match = /^\/(?:i|inst|instance)(?:\s+(.*))?$/i.exec(query.trim());
    if (!match) return [];
    return instanceRows(match[1] || '', { toast });
  };
}

/** "Go to <instance>" commands for the palette's main list: same page, this tab (Shift/Ctrl+Enter: new tab). */
export async function buildInstanceCommands() {
  const here = window.location.hostname.toLowerCase();
  const rows = await instanceRows('');
  return rows
    .filter((row) => row.id.startsWith('instance.go.') && row.id !== `instance.go.${here}`)
    .map((row) => ({ ...row, title: `Go to ${row.title}`, keywords: `switch instance environment ${row.hint}`, badge: undefined }));
}
