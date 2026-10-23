// "Multi-cursor lite" for the script editor: select the next occurrence of the word or selection (Ctrl+D), select
// every occurrence (Ctrl+Shift+L) or add a cursor with Alt+click, then type, paste, delete, press Enter or Tab and
// move with Left, Right, Home and End at all of them at once. The textarea itself only has one selection, so the
// editor keeps the others and applies one combined replacement per keystroke (a single undo step). These
// functions work on plain text and selections and return the new text; tests/editorplus.test.js checks them against
// a one-cursor-at-a-time reference.
//
// A selection is {start, end, primary?}; `primary` marks the one the textarea shows (the most recently added).

import { lineStartAt } from './editorText.js';

const WORD_CHAR = /[\w$]/;
const MAX_CURSORS = 1000;

/** Sorted, with overlapping and identical selections merged. Exactly one selection ends up primary. */
export function normalize(sels) {
  const sorted = sels
    .map((s) => ({ start: Math.min(s.start, s.end), end: Math.max(s.start, s.end), primary: Boolean(s.primary) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    // Two carets at the same spot are one caret; a caret inside a selection is swallowed by it; touching selections stay separate.
    if (last && (s.start < last.end || (s.start === last.start && s.end === last.end) || (s.start === last.start && last.start === last.end))) {
      last.end = Math.max(last.end, s.end);
      last.primary = last.primary || s.primary;
    } else out.push(s);
  }
  if (out.length && !out.some((s) => s.primary)) out[out.length - 1].primary = true;
  if (out.filter((s) => s.primary).length > 1) {
    let seen = false;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i].primary && seen) out[i].primary = false;
      else if (out[i].primary) seen = true;
    }
  }
  return out;
}

/** The identifier at or just before `offset`, or null. */
export function wordRangeAt(text, offset) {
  let s = Math.min(offset, text.length);
  let e = s;
  while (s > 0 && WORD_CHAR.test(text[s - 1])) s -= 1;
  while (e < text.length && WORD_CHAR.test(text[e])) e += 1;
  return s === e ? null : { start: s, end: e };
}

const isWholeWord = (text, s, e) => !(WORD_CHAR.test(text[s - 1] || '') || WORD_CHAR.test(text[e] || ''));

// An emoji or other character outside the Basic Multilingual Plane is two UTF-16 units; a caret or a deletion must never
// split one (a lone half shows as a replacement character and would be saved like that).
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
const splitsPair = (text, at) => at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));

/** `at`, moved to the start of the character when it sits between the two halves of one. */
export function snapToChar(text, at) {
  return splitsPair(text, at) ? at - 1 : at;
}

/** The offset one character before `at` (two units back over an emoji). */
const charBefore = (text, at) => (at >= 2 && splitsPair(text, at - 1) ? at - 2 : Math.max(0, at - 1));
/** The offset one character after `at`. */
const charAfter = (text, at) => (splitsPair(text, at + 1) ? Math.min(text.length, at + 2) : Math.min(text.length, at + 1));

/**
 * Ctrl+D. With only a caret it selects the word under it. With a selection it adds the next occurrence of the
 * selected text after the primary selection (wrapping round, skipping ones already selected).
 * @returns {{sels: object[], wholeWord: boolean} | null} null when there is nothing more to select
 */
export function nextOccurrence(text, sels, wholeWord = false) {
  const list = normalize(sels);
  const primary = list.find((s) => s.primary) || list[list.length - 1];
  if (!primary) return null;
  if (primary.start === primary.end) {
    const word = wordRangeAt(text, primary.start);
    if (!word) return null;
    return { sels: normalize(list.map((s) => (s === primary ? { ...word, primary: true } : { ...s, primary: false }))), wholeWord: true };
  }
  const needle = text.slice(primary.start, primary.end);
  if (!needle || needle.length > 5000) return null;
  const taken = (at) => list.some((s) => at < s.end && at + needle.length > s.start);
  for (let pass = 0; pass < 2; pass += 1) {
    let from = pass === 0 ? primary.end : 0;
    const limit = pass === 0 ? text.length : primary.start;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at === -1 || at >= limit) break;
      if (!taken(at) && (!wholeWord || isWholeWord(text, at, at + needle.length))) {
        return { sels: normalize([...list.map((s) => ({ ...s, primary: false })), { start: at, end: at + needle.length, primary: true }]), wholeWord };
      }
      from = at + 1;
    }
  }
  return null;
}

/** Ctrl+Shift+L: every occurrence of the selected text, or of the word under the caret. */
export function allOccurrences(text, sel, { wholeWord = null } = {}) {
  let start = Math.min(sel.start, sel.end);
  let end = Math.max(sel.start, sel.end);
  let whole = wholeWord;
  if (start === end) {
    const word = wordRangeAt(text, start);
    if (!word) return null;
    start = word.start;
    end = word.end;
    whole = true;
  }
  const needle = text.slice(start, end);
  if (!needle) return null;
  const out = [];
  let from = 0;
  let primary = null;
  while (out.length < MAX_CURSORS) {
    const at = text.indexOf(needle, from);
    if (at === -1) break;
    from = at + 1;
    if (whole && !isWholeWord(text, at, at + needle.length)) continue;
    const hit = { start: at, end: at + needle.length, primary: false };
    if (at === start) primary = hit;
    out.push(hit);
  }
  if (out.length < 2) return null;
  (primary || out[out.length - 1]).primary = true;
  return { sels: normalize(out), wholeWord: Boolean(whole) };
}

/**
 * Replace every selection with its own text. `make(sel, text)` returns the string that goes in; carets end up after it.
 * `edits` is the same change as separate replacements in the old text's offsets (ascending), for editors that have to
 * apply a long script's edits one by one.
 */
export function replaceEach(text, sels, make) {
  const list = normalize(sels);
  let out = '';
  let pos = 0;
  const next = [];
  const edits = [];
  for (const s of list) {
    out += text.slice(pos, s.start);
    const insert = make(s, text);
    out += insert;
    edits.push({ from: s.start, to: s.end, insert });
    next.push({ start: out.length, end: out.length, primary: s.primary });
    pos = s.end;
  }
  out += text.slice(pos);
  return { text: out, sels: normalize(next), edits };
}

/** Typing: the text replaces every selection. */
export function typeText(text, sels, insert) {
  return replaceEach(text, sels, () => insert);
}

/** Delete the given ranges (merged first) and leave a caret where each was. */
function deleteRanges(text, ranges, primaryIndex) {
  const marked = ranges.map((r, i) => ({ ...r, primary: i === primaryIndex }));
  const list = normalize(marked);
  let out = '';
  let pos = 0;
  const next = [];
  const edits = [];
  for (const r of list) {
    out += text.slice(pos, r.start);
    if (r.end > r.start) edits.push({ from: r.start, to: r.end, insert: '' });
    next.push({ start: out.length, end: out.length, primary: r.primary });
    pos = r.end;
  }
  out += text.slice(pos);
  return { text: out, sels: normalize(next), edits };
}

/** Backspace: each selection goes, or the character before each caret. */
export function backspace(text, sels) {
  const list = normalize(sels);
  const ranges = list.map((s) => (s.start !== s.end ? { start: s.start, end: s.end } : { start: charBefore(text, s.start), end: s.start }));
  return deleteRanges(text, ranges, list.findIndex((s) => s.primary));
}

/** Delete: each selection goes, or the character after each caret. */
export function deleteForward(text, sels) {
  const list = normalize(sels);
  const ranges = list.map((s) => (s.start !== s.end ? { start: s.start, end: s.end } : { start: s.start, end: charAfter(text, s.end) }));
  return deleteRanges(text, ranges, list.findIndex((s) => s.primary));
}

/** Enter: a new line that keeps the indentation of the line each cursor is on. */
export function newline(text, sels) {
  return replaceEach(text, sels, (s) => {
    const lineStart = lineStartAt(text, s.start);
    return `\n${/^[ \t]*/.exec(text.slice(lineStart, s.start))[0]}`;
  });
}

/** Tab: spaces up to the next indent stop (or a tab character) at every cursor; with a selection the selection is replaced. */
export function tabAll(text, sels, unit = '  ') {
  return replaceEach(text, sels, (s) => {
    if (unit === '\t') return '\t';
    const lineStart = lineStartAt(text, s.start);
    return ' '.repeat(unit.length - ((s.start - lineStart) % unit.length));
  });
}

/** Paste: one line of the clipboard per cursor when the counts match, otherwise the whole text at every cursor. */
export function pasteText(text, sels, clip) {
  const list = normalize(sels);
  // A textarea holds only \n line breaks (it turns \r\n and \r into \n), so the pasted text is made the same first.
  const plain = String(clip).replace(/\r\n?/g, '\n');
  const lines = plain.split('\n');
  if (list.length > 1 && lines.length === list.length) {
    let k = 0;
    return replaceEach(text, list, () => lines[k++]);
  }
  return replaceEach(text, list, () => plain);
}

/** Left, Right, Home or End at every cursor (no Shift: selections collapse). Cursors that land together become one. */
export function moveAll(text, sels, key) {
  const moved = normalize(sels).map((s) => {
    let at;
    if (key === 'ArrowLeft') at = s.start !== s.end ? s.start : charBefore(text, s.start);
    else if (key === 'ArrowRight') at = s.start !== s.end ? s.end : charAfter(text, s.end);
    else if (key === 'Home') {
      const lineStart = lineStartAt(text, s.start);
      const lineEnd = text.indexOf('\n', lineStart);
      const indent = lineStart + /^[ \t]*/.exec(text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd))[0].length;
      at = s.start === indent ? lineStart : indent;
    } else if (key === 'End') {
      const e = text.indexOf('\n', s.end);
      at = e === -1 ? text.length : e;
    } else at = s.start;
    return { start: at, end: at, primary: s.primary };
  });
  return { text, sels: normalize(moved) };
}

export { MAX_CURSORS };
