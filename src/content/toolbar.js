// Floating action rail. Deliberately small: the command palette is the main
// surface, so the rail only carries the environment badge, a palette launcher
// and a handful of pinned actions.

import { createIcon } from './icons.js';

/**
 * @param {object} config
 * @param {{instance:string,label:string,tone:string,host:string}} config.instance
 * @param {boolean} config.showBadge
 * @param {{label:string,hint:string,onClick:Function}} config.primary
 * @param {Array<{id:string,label:string,icon:string,onClick:Function}>} config.buttons
 * @param {{right:number,bottom:number}|null} config.position
 * @param {(pos:{right:number,bottom:number})=>void} config.onPositionChange
 */
export function createToolbar(config) {
  const { instance, showBadge = true, primary, buttons = [], position, onPositionChange } = config;

  const rail = document.createElement('div');
  rail.className = 'msb-rail';
  if (position) {
    rail.style.right = `${position.right}px`;
    rail.style.bottom = `${position.bottom}px`;
  }

  if (showBadge && instance) {
    const badge = document.createElement('div');
    badge.className = `msb-rail__badge msb-rail__badge--${instance.tone}`;
    badge.textContent = instance.label;
    badge.title = `${instance.host}\nEnvironment is guessed from the instance name.`;
    rail.appendChild(badge);
  }

  const primaryBtn = document.createElement('button');
  primaryBtn.type = 'button';
  primaryBtn.className = 'msb-rail__primary';
  primaryBtn.title = `${primary.label} (${primary.hint})`;
  primaryBtn.setAttribute('aria-label', primary.label);
  primaryBtn.appendChild(createIcon('palette'));
  const hint = document.createElement('span');
  hint.className = 'msb-rail__primaryHint';
  hint.textContent = primary.hint;
  primaryBtn.appendChild(hint);
  primaryBtn.addEventListener('click', primary.onClick);
  rail.appendChild(primaryBtn);

  const group = document.createElement('div');
  group.className = 'msb-rail__group';
  buttons.forEach((button) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msb-rail__btn';
    btn.title = button.label;
    btn.setAttribute('aria-label', button.label);
    btn.appendChild(createIcon(button.icon || 'record'));
    const tip = document.createElement('span');
    tip.className = 'msb-rail__tip';
    tip.textContent = button.label;
    btn.appendChild(tip);
    btn.addEventListener('click', button.onClick);
    group.appendChild(btn);
  });
  rail.appendChild(group);

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'msb-rail__handle';
  handle.title = 'Drag to move';
  handle.setAttribute('aria-label', 'Move the MySnowBuddy toolbar');
  handle.appendChild(iconEl(ICONS.drag));
  handle.appendChild(createIcon('drag'));

  enableDragging(rail, handle, onPositionChange);

  return rail;
}

function enableDragging(rail, handle, onPositionChange) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startRight = 0;
  let startBottom = 0;

  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    rail.classList.add('msb-rail--dragging');
    const rect = rail.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    startRight = window.innerWidth - rect.right;
    startBottom = window.innerHeight - rect.bottom;
    event.preventDefault();
  });

  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const right = clamp(startRight - (event.clientX - startX), 4, window.innerWidth - 80);
    const bottom = clamp(startBottom - (event.clientY - startY), 4, window.innerHeight - 80);
    rail.style.right = `${right}px`;
    rail.style.bottom = `${bottom}px`;
  });

  const end = (event) => {
    if (!dragging) return;
    dragging = false;
    rail.classList.remove('msb-rail--dragging');
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch (err) {
      // Pointer capture was already released.
    }
    if (onPositionChange) {
      onPositionChange({
        right: Math.round(parseFloat(rail.style.right) || 20),
        bottom: Math.round(parseFloat(rail.style.bottom) || 20),
      });
    }
  };

  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}
