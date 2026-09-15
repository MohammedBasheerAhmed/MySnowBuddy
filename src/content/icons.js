// Shared inline SVG icon set. Paths are build-time constants, never instance
// data, which is why `innerHTML` is safe here.

export const ICON_PATHS = {
  palette:
    '<path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
  chat:
    '<path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>',
  search:
    '<circle cx="11" cy="11" r="6" stroke="currentColor" stroke-width="2" fill="none"/><path d="M20 20l-4.2-4.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  lint:
    '<path d="M10 6h10M10 12h10M10 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M4 6l1.4 1.4L8 5M4 12l1.4 1.4L8 11M4 18l1.4 1.4L8 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  record:
    '<rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  table:
    '<rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M3 9h18M9 9v11" stroke="currentColor" stroke-width="2"/>',
  analyze:
    '<path d="M4 19V5M4 19h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 16v-4M12 16V7M16 16v-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  ai:
    '<path d="M12 3l1.8 4.9L19 9.7l-4.4 2.5L13.8 17 12 14.2 10.2 17l-1.4-4.8L5 9.7l5.2-1.8z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill="none"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" fill="currentColor"/>',
  navigate:
    '<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M15.5 8.5l-2.1 5.1-5.1 2.1 2.1-5.1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>',
  instance:
    '<rect x="3" y="4" width="18" height="7" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><rect x="3" y="13" width="18" height="7" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M7 7.5h.01M7 16.5h.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  tools:
    '<path d="M14.7 6.3a4 4 0 0 0 5.1 5.1L21 12l-9 9-3-3 9-9z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/><path d="M6.5 13.5L3 17a2.1 2.1 0 0 0 3 3l3.5-3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
  clock:
    '<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M12 7.5V12l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  user:
    '<circle cx="12" cy="8.5" r="3.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5 20a7 7 0 0 1 14 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
  drag:
    '<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>',
  command:
    '<path d="M9 6a2.5 2.5 0 1 0-2.5 2.5H17.5A2.5 2.5 0 1 1 15 6v12a2.5 2.5 0 1 0 2.5-2.5H6.5A2.5 2.5 0 1 1 9 18z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill="none"/>',
  send:
    '<path d="M4 12l16-8-6 16-2.4-6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/>',
  mic:
    '<rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
  download:
    '<path d="M12 4v10m0 0l-3.5-3.5M12 14l3.5-3.5M5 18h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  close:
    '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  copy:
    '<rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5 15V6a2 2 0 0 1 2-2h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
  trash:
    '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
};

export function createIcon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICON_PATHS[name] || ICON_PATHS.record;
  return svg;
}
