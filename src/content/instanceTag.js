// Makes the instance obvious at a glance: tab title prefix, a coloured favicon and a thin stripe at the top of the
// page. The label and colour come from the known-instance list (Options > Instances), so renaming or recolouring an
// instance there changes the open tabs at once. The switcher itself lives in instanceSwitch.js.

import { getInstanceInfo, classifyEnvironment } from './quickActions.js';
import { listInstances, INSTANCES_KEY } from './stores.js';
import { resolveColor, validColor, titleWithPrefix, titleWithoutPrefix } from '../lib/instances.js';

const FAVICON_ID = 'msb-favicon';
const TONE_VAR = { ok: 'var(--msb-ok)', warn: 'var(--msb-warn)', danger: 'var(--msb-danger-solid)' };

/** What this tab should show: label, environment tone, the colour a person chose (if any) and the colour to draw. */
export async function currentTag() {
  const info = getInstanceInfo();
  let { label, tone } = info;
  let saved = '';
  try {
    const known = (await listInstances()).find((i) => i.host.toLowerCase() === info.host.toLowerCase());
    if (known?.label) {
      label = known.label.toUpperCase().slice(0, 10);
      // A label that names an environment decides; otherwise the host name's own guess stands (a label of
      // "Sales" on prod12345 is still production).
      tone = classifyEnvironment(known.label)?.tone || info.tone;
    }
    saved = validColor(known?.color);
  } catch {
    // Storage unavailable; keep the guess from the hostname.
  }
  return { label, tone, saved, color: resolveColor({ saved, tone, host: info.host }) };
}

function faviconUrl(letter, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const g = canvas.getContext('2d');
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(1, 1, 30, 30, 8);
  g.fill();
  g.fillStyle = '#fff';
  g.font = 'bold 20px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter, 16, 17);
  return canvas.toDataURL('image/png');
}

/**
 * @param {ShadowRoot} shadow
 * @returns {Promise<{ refresh: () => Promise<void>, stop: () => void }>}
 */
export async function startInstanceTag(shadow) {
  let prefix = '';
  let bar = null;
  let stopped = false;
  const icon = document.createElement('link');
  icon.id = FAVICON_ID;
  icon.rel = 'icon';
  const removedIcons = [];
  let observer = null;

  // Polaris rewrites the title and icon as you navigate, so reapply on change.
  const apply = () => {
    if (stopped) return;
    if (!document.title.startsWith(prefix)) document.title = titleWithPrefix(document.title, prefix);
    document.querySelectorAll('link[rel~="icon"]').forEach((node) => {
      if (node.id === FAVICON_ID) return;
      if (!removedIcons.includes(node)) removedIcons.push(node);
      node.remove();
    });
    if (!icon.isConnected) document.head.appendChild(icon);
  };

  async function refresh() {
    const { label, tone, saved, color } = await currentTag();
    if (stopped) return;

    // Every surface (palette, windows, popovers, sidebar) draws its top rule in this colour: green on a dev instance,
    // amber on test or stage, red on production, the chosen colour when one is set (never on production).
    const envColor = saved && tone !== 'danger' ? color : TONE_VAR[tone];
    if (shadow.host) {
      if (envColor) shadow.host.style.setProperty('--msb-env', envColor);
      else shadow.host.style.removeProperty('--msb-env');
    }

    const wantBar = tone !== 'neutral' || Boolean(saved);
    if (wantBar && !bar) {
      bar = document.createElement('div');
      bar.setAttribute('aria-hidden', 'true');
      shadow.appendChild(bar);
    }
    if (bar) {
      bar.hidden = !wantBar;
      bar.className = `msb-envbar${saved && tone !== 'danger' ? '' : ` msb-envbar--${tone}`}`;
      bar.style.background = saved && tone !== 'danger' ? color : '';
    }

    const next = `[${label}] `;
    // The old prefix comes off before the new one goes on, so a rename does not stack "[A] [B] Title".
    if (prefix && prefix !== next) document.title = titleWithPrefix(document.title, next, prefix);
    prefix = next;
    icon.href = faviconUrl(label.charAt(0), color);
    apply();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    chrome.storage?.onChanged?.removeListener?.(onChanged);
    document.title = titleWithoutPrefix(document.title, prefix);
    icon.remove();
    removedIcons.forEach((node) => document.head.appendChild(node));
    bar?.remove();
    shadow.host?.style.removeProperty('--msb-env');
  }

  function onChanged(changes, area) {
    if (area === 'local' && changes[INSTANCES_KEY]) refresh().catch(() => {});
  }

  await refresh();
  observer = new MutationObserver(apply);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  try {
    chrome.storage?.onChanged?.addListener(onChanged);
  } catch {
    // No extension storage (preview): the tag is set once.
  }
  return { refresh, stop };
}
