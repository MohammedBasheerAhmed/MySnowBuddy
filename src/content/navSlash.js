// Type "/tn incident" (or any slash command) into ServiceNow's own navigator filter and press Enter:
// the command palette opens with that text, the way SN Utils' navigator commands work. Typing just "/" into the empty
// filter opens it at once on the list of every command. The filter box lives
// in a shadow root of the Polaris header (or in the classic navigator), so the key is caught in the capture
// phase on the top document and the real input is read from composedPath().

import { navSlashQuery } from '../lib/navSlash.js';

export function installNavSlash({ palette, isEnabled = () => true }) {
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.isTrusted !== true || !isEnabled()) return;
      const field = event.composedPath?.()[0];
      if (!field || field.tagName !== 'INPUT') return;
      const query = navSlashQuery({
        field: { tag: field.tagName, id: field.id, placeholder: field.placeholder, type: field.type },
        key: event.key,
        value: field.value,
        isComposing: event.isComposing,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });
      if (!query) return;
      // The filter would otherwise search for "/tn incident" and find nothing.
      event.preventDefault();
      event.stopImmediatePropagation();
      palette.open(query);
    },
    true
  );
}
