// "What's new" card: which release notes a person has seen, and what the card lists.
//
// Pure logic (no DOM, no chrome.*) so it can be tested. The card itself is src/content/whatsNew.js.
//
// The rules, in plain words:
//   - The notes belong to a version (NOTES_VERSION). A person sees them once, when the extension reaches that version.
//   - Someone who has not yet dismissed the first-run card is new: they get that card instead, and the notes are marked as
//     seen for them without being shown (the first-run card and the guide already cover everything in them).
//   - A patch release that has no notes of its own (0.9.1 while the notes are for 0.9.0) shows nothing.
//   - A build older than the notes shows nothing.

/** The version the notes below describe. Change it together with GROUPS when a release has new things to show. */
export const NOTES_VERSION = '0.9.0';

/** chrome.storage.local key holding the newest notes version this person has seen (a version string). */
export const SEEN_KEY = 'mysnowbuddy_whatsnew_seen';

/** [major, minor, patch] from "0.9.0", or null when the text is not a plain three-part version. */
export function parseVersion(text) {
  const match = /^(\d{1,4})\.(\d{1,5})\.(\d{1,6})$/.exec(String(text ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** -1, 0 or 1; null when either side is not a version. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** True only when both are versions and `a` is the same or newer. (compareVersions alone is null for junk, and null >= 0 is true in JavaScript.) */
export function isAtLeast(a, b) {
  const order = compareVersions(a, b);
  return order !== null && order >= 0;
}

/**
 * What to do when a page loads.
 *   { action: 'show' }  put the card up (after the usual delay and only when nothing else is on screen)
 *   { action: 'mark' }  show nothing, but remember these notes as seen (a new person)
 *   { action: 'skip' }  nothing at all
 *
 * @param {{ welcomed: boolean, seenVersion?: string, currentVersion: string, notesVersion?: string }} input
 */
export function decideWhatsNew({ welcomed, seenVersion, currentVersion, notesVersion = NOTES_VERSION }) {
  if (!parseVersion(currentVersion) || !parseVersion(notesVersion)) return { action: 'skip', reason: 'version unknown' };
  if (!isAtLeast(currentVersion, notesVersion)) return { action: 'skip', reason: 'older build than the notes' };
  if (!welcomed) return { action: 'mark', reason: 'new here: the first-run card comes first' };
  if (isAtLeast(seenVersion, notesVersion)) return { action: 'skip', reason: 'already seen' };
  return { action: 'show', reason: 'new notes for this version' };
}

/**
 * Whether the card may come up right now. `busy` names what is in the way, so a caller can wait and ask again.
 * @param {{ paletteOpen?: boolean, hidden?: boolean, cardOpen?: boolean, typing?: boolean }} state
 */
export function canShowNow({ paletteOpen = false, hidden = false, cardOpen = false, typing = false } = {}) {
  if (hidden) return { ok: false, busy: 'tab hidden' };
  if (paletteOpen) return { ok: false, busy: 'palette open' };
  if (cardOpen) return { ok: false, busy: 'another card open' };
  if (typing) return { ok: false, busy: 'typing' };
  return { ok: true, busy: '' };
}

/** Whether an element takes typed text (so the card does not pull focus away from someone typing). Works on any object with these fields. */
export function isTypingIn(element) {
  if (!element) return false;
  const tag = String(element.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !/^(button|checkbox|radio|submit|reset|image|file|range|color)$/i.test(String(element.type || 'text'));
  return Boolean(element.isContentEditable);
}

/**
 * The tools in this release, by the job a developer is doing. Each line opens something:
 *   { panel: 'name' }     a panel from src/sidebar/panelRegistry.js
 *   { palette: 'text' }   the command palette with that text typed in
 *   { editor: true }      the script editor (it says so when the page has no script)
 * `slash` is shown beside the name; for a panel it must be one of that panel's slash commands (tests/whatsnew.test.js checks).
 */
export const GROUPS = [
  {
    title: 'Debug',
    items: [
      {
        name: 'Client trace',
        slash: '/watch',
        what: 'What the form’s scripts did: field changes, GlideAjax calls and errors, in order.',
        open: { panel: 'clienttrace' },
      },
      {
        name: 'Why wasn’t the email sent?',
        slash: '/notify',
        what: 'Follow a record to its email and see the first link that broke.',
        open: { panel: 'notify' },
      },
      {
        name: 'Flows, approvals and SLAs',
        slash: '/flows',
        what: 'What is running against a ticket, and what it is waiting for.',
        open: { panel: 'process' },
      },
    ],
  },
  {
    title: 'Code',
    items: [
      {
        name: 'Script editor: functions, Format, cursors',
        slash: 'Ctrl+Shift+O',
        what: 'Go to function, safe Format, changed-lines bar, multi-cursor. On a script record.',
        open: { editor: true },
      },
      {
        name: 'System properties',
        slash: '/prop',
        what: 'Find one, see which scripts read it, change it with a one-click restore.',
        open: { panel: 'properties' },
      },
    ],
  },
  {
    title: 'Explore',
    items: [
      {
        name: 'Go to anything',
        slash: 'br: si: acl:',
        what: 'Find a rule, script include, ACL, flow or widget by name. Tab for actions.',
        open: { palette: 'br: ' },
      },
      {
        name: 'Data model map',
        slash: '/map',
        what: 'How tables connect, and the dot-walk path from one table to another.',
        open: { panel: 'datamodel' },
      },
      {
        name: 'Portal inspector',
        slash: '/sp',
        what: 'Each widget on a portal page with its c.data, options and code.',
        open: { panel: 'portal' },
      },
    ],
  },
  {
    title: 'Ship',
    items: [
      {
        name: 'Update set preview problems',
        slash: '/preview',
        what: 'A retrieved update set that will not commit: each problem explained.',
        open: { panel: 'previewfix' },
      },
    ],
  },
];

/** How many tools the card lists, for the sub-heading. The self-check is the tenth, in the card’s button row. */
export const TOOL_COUNT = GROUPS.reduce((sum, group) => sum + group.items.length, 0) + 1;

/** The self-check line under the list: the panel it opens and the sentence beside it. */
export const SELF_CHECK = {
  panel: 'doctor',
  slash: '/doctor',
  label: 'Run the self-check',
  note: 'Not sure a tool works on your instance? Run the self-check to find out.',
};

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** The sub-heading: version and a count in plain words. */
export function subtitle(version) {
  const count = COUNT_WORDS[TOOL_COUNT] || String(TOOL_COUNT);
  return `Version ${version}: ${count} new tools. Click one to open it.`;
}
