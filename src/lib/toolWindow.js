// Geometry for the floating tool windows (src/sidebar/ToolWindow.jsx). Pure, so it can be tested.

export const MIN_WINDOW = { w: 340, h: 260 };
const EDGE = 8; // gap kept to the viewport edge
const GRAB = 72; // how much of a window must stay on screen so it can be dragged back

/** Keep a rect usable: at least the minimum size, no larger than the viewport, and not lost off an edge. */
export function clampRect(rect, view) {
  const w = Math.min(Math.max(rect.w, MIN_WINDOW.w), Math.max(MIN_WINDOW.w, view.w - EDGE * 2));
  const h = Math.min(Math.max(rect.h, MIN_WINDOW.h), Math.max(MIN_WINDOW.h, view.h - EDGE * 2));
  const x = Math.min(Math.max(rect.x, GRAB - w), view.w - GRAB);
  const y = Math.min(Math.max(rect.y, 0), view.h - GRAB);
  return { x, y, w, h };
}

/** Resize from the east and/or south edge by a pointer delta; the top-left corner stays put. */
export function resizeRect(rect, mode, dx, dy, view) {
  const maxW = Math.max(MIN_WINDOW.w, view.w - rect.x - EDGE);
  const maxH = Math.max(MIN_WINDOW.h, view.h - rect.y - EDGE);
  return {
    ...rect,
    w: mode.includes('e') ? Math.min(maxW, Math.max(MIN_WINDOW.w, rect.w + dx)) : rect.w,
    h: mode.includes('s') ? Math.min(maxH, Math.max(MIN_WINDOW.h, rect.h + dy)) : rect.h,
  };
}

/** Where a new window opens: beside the sidebar when it is showing, cascaded so stacked windows stay visible. */
export function defaultWindowRect({ view, sidebarWidth = 0, size = { w: 480, h: 580 }, index = 0 }) {
  const gutter = sidebarWidth ? sidebarWidth + 12 + 12 : 16;
  const cascade = (index % 6) * 28;
  const x = view.w - gutter - size.w - cascade;
  const y = 64 + cascade;
  return clampRect({ x, y, w: size.w, h: Math.min(size.h, view.h - 64 - cascade - EDGE) }, view);
}

/** Opening a tool that already has a window brings that window forward with the new parameters. */
export function upsertWindow(windows, entry, z) {
  const at = windows.findIndex((w) => w.name === entry.name);
  if (at === -1) return [...windows, { ...entry, z }];
  return windows.map((w, i) => (i === at ? { ...entry, wid: w.wid, z } : w));
}

// --- Keyboard operation -------------------------------------------------------------------------
// With the title bar focused: arrows move the window, Alt+arrows resize it (right and down grow it),
// Shift makes the step four times larger, Enter or Space maximises, Escape closes.

export const KEY_STEP = 16;
export const KEY_STEP_BIG = 64;
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** How far one arrow press moves or resizes, or null when the key is not an arrow. */
export function keyDelta(key, shift = false) {
  const dir = ARROWS[key];
  if (!dir) return null;
  const step = shift ? KEY_STEP_BIG : KEY_STEP;
  return { dx: dir[0] * step, dy: dir[1] * step };
}

/** The window one arrow press further, still inside the viewport. */
export function moveByKey(rect, key, shift, view) {
  const d = keyDelta(key, shift);
  return d ? clampRect({ ...rect, x: rect.x + d.dx, y: rect.y + d.dy }, view) : rect;
}

/** The window one arrow press larger or smaller (its top-left corner stays put). */
export function resizeByKey(rect, key, shift, view) {
  const d = keyDelta(key, shift);
  return d ? resizeRect(rect, 'se', d.dx, d.dy, view) : rect;
}

/** What a key press on the title bar asks for: { type: 'move' | 'resize' | 'maximize' | 'close', ... } or null. */
export function windowKeyAction({ key, shiftKey = false, altKey = false, ctrlKey = false, metaKey = false }) {
  if (ctrlKey || metaKey) return null;
  if (key === 'Escape') return { type: 'close' };
  if (key === 'Enter' || key === ' ') return { type: 'maximize' };
  if (!ARROWS[key]) return null;
  return { type: altKey ? 'resize' : 'move', key, shift: shiftKey };
}

/** Text read out with the title bar so the keys can be discovered without a manual. */
export const WINDOW_KEY_HINT = 'Arrow keys move the window, Shift makes the step larger, Alt with arrow keys resizes it, Enter maximizes or restores, Escape closes.';
