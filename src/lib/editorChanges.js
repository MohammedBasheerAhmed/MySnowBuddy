// "What did I change?" for the script editor: line hunks between the text that was loaded from the record
// and the text in the editor (for the gutter marks and the Changes list), and the edit that puts one hunk
// back to how it was. Pure functions; tested in tests/editorplus.test.js.
import { diffRange } from './editorText.js';

const MAX_CELLS = 4000000;

/**
 * @typedef {{oldStart: number, oldEnd: number, newStart: number, newEnd: number}} Hunk
 * Line indexes (0-based, end exclusive) in the saved text (old) and in the editor text (new).
 */

/** What a hunk is: lines only in the editor, lines only in the saved text, or lines that differ. */
export function hunkKind(h) {
  if (h.oldEnd === h.oldStart) return 'added';
  if (h.newEnd === h.newStart) return 'removed';
  return 'modified';
}

/** Compares a[aLo..aHi) with b[bLo..bHi) and pushes the hunks. Exact (LCS) when small, anchored on unique lines when big. */
function diffSpan(a, b, aLo, aHi, bLo, bHi, out, maxCells) {
  let lo = 0;
  while (aLo + lo < aHi && bLo + lo < bHi && a[aLo + lo] === b[bLo + lo]) lo += 1;
  let hi = 0;
  while (aHi - hi > aLo + lo && bHi - hi > bLo + lo && a[aHi - 1 - hi] === b[bHi - 1 - hi]) hi += 1;
  const as = aLo + lo;
  const ae = aHi - hi;
  const bs = bLo + lo;
  const be = bHi - hi;
  const n = ae - as;
  const m = be - bs;
  if (!n && !m) return;
  if (!n || !m) {
    out.push({ oldStart: as, oldEnd: ae, newStart: bs, newEnd: be });
    return;
  }
  if (n * m <= maxCells) {
    exactSpan(a, b, as, ae, bs, be, out);
    return;
  }
  // Too big for a table: use the lines that occur exactly once on each side as anchors (the longest run that keeps
  // their order), and compare what lies between the anchors.
  const countA = new Map();
  for (let i = as; i < ae; i += 1) countA.set(a[i], (countA.get(a[i]) || 0) + 1);
  const countB = new Map();
  const where = new Map();
  for (let j = bs; j < be; j += 1) {
    countB.set(b[j], (countB.get(b[j]) || 0) + 1);
    where.set(b[j], j);
  }
  const pairs = [];
  for (let i = as; i < ae; i += 1) {
    if (countA.get(a[i]) === 1 && countB.get(a[i]) === 1) pairs.push([i, where.get(a[i])]);
  }
  const anchors = longestIncreasing(pairs);
  if (!anchors.length) {
    out.push({ oldStart: as, oldEnd: ae, newStart: bs, newEnd: be });
    return;
  }
  let i0 = as;
  let j0 = bs;
  anchors.forEach(([i, j]) => {
    diffSpan(a, b, i0, i, j0, j, out, maxCells);
    i0 = i + 1;
    j0 = j + 1;
  });
  diffSpan(a, b, i0, ae, j0, be, out, maxCells);
}

/** The pairs whose second numbers increase, as many as possible (patience sorting). Pairs come sorted by the first number. */
function longestIncreasing(pairs) {
  const tails = [];
  const prev = new Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const out = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k !== -1; k = prev[k]) out.push(pairs[k]);
  return out.reverse();
}

/** Longest common subsequence of two line ranges, grouped into hunks. */
function exactSpan(a, b, as, ae, bs, be, out) {
  const n = ae - as;
  const m = be - bs;
  const w = m + 1;
  const table = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * w + j] = a[as + i] === b[bs + j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  let open = null;
  const close = (i, j) => {
    if (!open) return;
    out.push({ oldStart: open.i + as, oldEnd: i + as, newStart: open.j + bs, newEnd: j + bs });
    open = null;
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[as + i] === b[bs + j]) {
      close(i, j);
      i += 1;
      j += 1;
    } else {
      if (!open) open = { i, j };
      if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i += 1;
      else j += 1;
    }
  }
  if (i < n || j < m) {
    if (!open) open = { i, j };
    i = n;
    j = m;
  }
  close(i, j);
}

/**
 * The changed regions between `base` (as loaded) and `text` (as edited), in order. The common start and end of both
 * texts are skipped first, so a small edit in a long script is cheap. Big rewrites are compared by their unique lines;
 * when nothing lines up the whole middle is one hunk.
 * @returns {Hunk[]}
 */
export function lineHunks(base, text, { maxCells = MAX_CELLS } = {}) {
  const a = String(base ?? '').split('\n');
  const b = String(text ?? '').split('\n');
  const out = [];
  diffSpan(a, b, 0, a.length, 0, b.length, out, maxCells);
  return out;
}

/** The lines of a hunk on each side, for showing it. */
export function hunkLines(base, text, h) {
  const a = String(base ?? '').split('\n');
  const b = String(text ?? '').split('\n');
  return { oldLines: a.slice(h.oldStart, h.oldEnd), newLines: b.slice(h.newStart, h.newEnd) };
}

/** The text with that one hunk put back to the saved version. @returns {string} */
export function revertHunk(base, text, h) {
  const a = String(base ?? '').split('\n');
  const b = String(text ?? '').split('\n');
  return [...b.slice(0, h.newStart), ...a.slice(h.oldStart, h.oldEnd), ...b.slice(h.newEnd)].join('\n');
}

/** The single replacement {from, to, insert} that reverts the hunk in `text`, or null when nothing would change. */
export function revertEdit(base, text, h) {
  return diffRange(String(text ?? ''), revertHunk(base, text, h));
}

/** Line (0-based) of the next (dir 1) or previous (dir -1) hunk after `line`, wrapping round; -1 when there are none. */
export function nextHunkLine(hunks, line, dir = 1, lineCount = Infinity) {
  if (!hunks.length) return -1;
  const at = (h) => Math.min(h.newStart, Math.max(0, lineCount - 1));
  if (dir > 0) {
    const hit = hunks.find((h) => at(h) > line);
    return at(hit || hunks[0]);
  }
  const hit = [...hunks].reverse().find((h) => at(h) < line);
  return at(hit || hunks[hunks.length - 1]);
}

/** One line per hunk for a list: "Lines 12-15 changed" style text. */
export function hunkTitle(h) {
  const kind = hunkKind(h);
  const count = kind === 'removed' ? h.oldEnd - h.oldStart : h.newEnd - h.newStart;
  const first = h.newStart + 1;
  const where = kind === 'removed' ? (h.newStart === 0 ? 'at the top' : `after line ${h.newStart}`) : count > 1 ? `lines ${first}-${h.newEnd}` : `line ${first}`;
  const what = kind === 'added' ? 'added' : kind === 'removed' ? 'removed' : 'changed';
  return `${count} ${count === 1 ? 'line' : 'lines'} ${what}, ${where}`;
}
