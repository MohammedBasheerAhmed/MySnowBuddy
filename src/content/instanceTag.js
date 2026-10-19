// Makes the instance obvious at a glance: tab title prefix, a coloured favicon and a thin
// stripe at the top of the page, plus palette commands to hop to another known instance.

import { getInstanceInfo, classifyEnvironment, safePath } from './quickActions.js';
import { listInstances } from './stores.js';

const COLORS = { danger: '#d92d20', warn: '#e08a00', ok: '#1a9a5b', neutral: '#6b7385' };
const FAVICON_ID = 'msb-favicon';

async function currentTag() {
  const info = getInstanceInfo();
  let { label, tone } = info;
  try {
    const known = (await listInstances()).find((i) => i.host.toLowerCase() === info.host.toLowerCase());
    if (known?.label) {
      label = known.label.toUpperCase().slice(0, 10);
      tone = classifyEnvironment(known.label)?.tone || 'neutral';
    }
  } catch {
    // Storage unavailable; keep the guess from the hostname.
  }
  return { label, tone };
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

/** @param {ShadowRoot} shadow */
export async function startInstanceTag(shadow) {
  const { label, tone } = await currentTag();
  const color = COLORS[tone] || COLORS.neutral;

  // Every surface (palette, windows, popovers, sidebar) draws its top rule in this colour: green on a dev instance,
  // amber on test or stage, red on production. Unknown instances keep the accent.
  const envColor = { ok: 'var(--msb-ok)', warn: 'var(--msb-warn)', danger: 'var(--msb-danger-solid)' }[tone];
  if (envColor && shadow.host) shadow.host.style.setProperty('--msb-env', envColor);

  if (tone !== 'neutral') {
    const bar = document.createElement('div');
    bar.className = `msb-envbar msb-envbar--${tone}`;
    bar.setAttribute('aria-hidden', 'true');
    shadow.appendChild(bar);
  }

  const prefix = `[${label}] `;
  const icon = document.createElement('link');
  icon.id = FAVICON_ID;
  icon.rel = 'icon';
  icon.href = faviconUrl(label.charAt(0), color);

  // Polaris rewrites the title and icon as you navigate, so reapply on change.
  const apply = () => {
    if (!document.title.startsWith(prefix)) document.title = prefix + document.title;
    document.querySelectorAll('link[rel~="icon"]').forEach((node) => {
      if (node.id !== FAVICON_ID) node.remove();
    });
    if (!icon.isConnected) document.head.appendChild(icon);
  };
  apply();
  new MutationObserver(apply).observe(document.head, { childList: true, subtree: true, characterData: true });
}

/** "Go to <instance>" commands for every other known instance, keeping the current page path. */
export async function buildInstanceCommands() {
  const here = window.location.hostname.toLowerCase();
  const instances = (await listInstances()).filter(
    (i) => /^[a-z0-9-]+\.service-now\.com$/i.test(i.host) && i.host.toLowerCase() !== here
  );
  const path = safePath(window.location.pathname + window.location.search);

  return instances.map((i) => ({
    id: `instance.go.${i.host}`,
    title: `Go to ${i.label}`,
    hint: `${i.host} \u00b7 same page`,
    group: 'Instance',
    keywords: `switch instance ${i.host}`,
    run: () => window.open(`https://${i.host}${path}`, '_blank', 'noopener,noreferrer'),
  }));
}
