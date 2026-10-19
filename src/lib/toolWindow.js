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
