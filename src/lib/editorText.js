// Text utilities for the script editor: a small JavaScript lexer (comments, strings, template
// literals, regex literals), masking, line math, highlighting tokens, bracket matching,
// line-based editing commands, find/replace helpers and a whitespace-only re-indenter.
// Pure functions, no DOM, so they are unit-tested in tests/editor.test.js.

export const COMMENT = 1;
export const STRING = 2;
export const TEMPLATE = 3;
export const REGEX = 4;

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'instanceof', 'else', 'do']);
const REGEX_AFTER_CHAR = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

const isIdStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
const isIdPart = (c) => isIdStart(c) || (c >= 48 && c <= 57);

/**
 * Non-code ranges of `text` in order. `end` is exclusive. `closed` is false for a line comment
 * (open until the end of its line) and for an unterminated string, template or block comment.
 * @returns {{type: number, start: number, end: number, closed: boolean}[]}
 */
export function lex(text) {
  const ranges = [];
  const n = text.length;
  let i = 0;
  let prev = ''; // last significant char; 'a' after a word, number, string or closing bracket
  let lastWord = '';
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i += 1;
      continue;
    }
    if (c === 47) {
      const next = text.charCodeAt(i + 1);
      if (next === 47) {
        let e = text.indexOf('\n', i);
        if (e === -1) e = n;
        ranges.push({ type: COMMENT, start: i, end: e, closed: false });
        i = e;
        continue;
      }
      if (next === 42) {
        const e = text.indexOf('*/', i + 2);
        if (e === -1) {
          ranges.push({ type: COMMENT, start: i, end: n, closed: false });
          i = n;
        } else {
          ranges.push({ type: COMMENT, start: i, end: e + 2, closed: true });
          i = e + 2;
        }
        continue;
      }
      if (REGEX_AFTER_CHAR.has(prev) || (prev === 'a' && REGEX_AFTER_WORD.has(lastWord))) {
        let j = i + 1;
        let inClass = false;
        let found = false;
        while (j < n) {
          const ch = text[j];
          if (ch === '\n') break;
          if (ch === '\\') {
            j += 2;
            continue;
          }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) {
            found = true;
            break;
          }
          j += 1;
        }
        if (found) {
          j += 1;
          while (j < n && isIdPart(text.charCodeAt(j))) j += 1;
          ranges.push({ type: REGEX, start: i, end: j, closed: true });
          i = j;
          prev = 'a';
          lastWord = '';
          continue;
        }
      }
      prev = '/';
      lastWord = '';
      i += 1;
      continue;
    }
    if (c === 39 || c === 34) {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const ch = text.charCodeAt(j);
        if (ch === 92) {
          j += 2;
          continue;
        }
        if (ch === c) {
          closed = true;
          j += 1;
          break;
        }
        if (ch === 10) break;
        j += 1;
      }
      if (j > n) j = n;
      ranges.push({ type: STRING, start: i, end: j, closed });
      i = j;
      prev = 'a';
      lastWord = '';
      continue;
    }
    if (c === 96) {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const ch = text.charCodeAt(j);
        if (ch === 92) {
          j += 2;
          continue;
        }
        if (ch === 96) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (j > n) j = n;
      ranges.push({ type: TEMPLATE, start: i, end: j, closed });
      i = j;
      prev = 'a';
      lastWord = '';
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(text.charCodeAt(j))) j += 1;
      lastWord = text.slice(i, j);
      prev = 'a';
      i = j;
      continue;
    }
    if (c >= 48 && c <= 57) {
      let j = i + 1;
      while (j < n && (isIdPart(text.charCodeAt(j)) || text.charCodeAt(j) === 46)) j += 1;
      prev = 'a';
      lastWord = '';
      i = j;
      continue;
    }
    const ch = text[i];
    prev = ch === ')' || ch === ']' ? 'a' : ch;
    lastWord = '';
    i += 1;
  }
  return ranges;
}

/** Offset of the first character of every line. */
export function lineStarts(text) {
  const out = [0];
  let i = text.indexOf('\n');
  while (i !== -1) {
    out.push(i + 1);
    i = text.indexOf('\n', i + 1);
  }
  return out;
}

/** 0-based line index of `offset`. */
export function lineOfOffset(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Start of the line that contains `pos`. */
export function lineStartAt(text, pos) {
  return pos <= 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
}

/** End of the line that contains `pos` (index of its newline, or the text length). */
export function lineEndAt(text, pos) {
  const e = text.indexOf('\n', pos);
  return e === -1 ? text.length : e;
}

// ---- cached analysis --------------------------------------------------------------------------

const CACHE_SIZE = 4;
const cache = [];

/** Lexer ranges and line starts for `text`, cached for the last few texts. */
export function analyze(text) {
  const src = String(text ?? '');
  for (let k = 0; k < cache.length; k += 1) {
    if (cache[k].text === src) {
      const hit = cache[k];
      if (k) {
        cache.splice(k, 1);
        cache.unshift(hit);
      }
      return hit;
    }
  }
  const info = { text: src, ranges: lex(src), starts: lineStarts(src), maskedText: null };
  cache.unshift(info);
  if (cache.length > CACHE_SIZE) cache.pop();
  return info;
}

/** The text with comments, strings, templates and regexes blanked (newlines kept), so brackets and words can be scanned safely. */
export function masked(info) {
  if (info.maskedText !== null) return info.maskedText;
  const { text, ranges } = info;
  const parts = [];
  let pos = 0;
  for (const r of ranges) {
    parts.push(text.slice(pos, r.start));
    const slice = text.slice(r.start, r.end);
    parts.push(slice.includes('\n') ? slice.replace(/[^\n]/g, ' ') : ' '.repeat(slice.length));
    pos = r.end;
  }
  parts.push(text.slice(pos));
  info.maskedText = parts.join('');
  return info.maskedText;
}

/** Index of the last range that starts before `offset`, or -1. */
function lastRangeBefore(ranges, offset) {
  let lo = 0;
  let hi = ranges.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].start < offset) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The non-code range a caret at `offset` is inside, or null. A caret right after an opening
 * quote is inside; a caret after a closing quote is not; a caret at the end of a line comment or
 * an unterminated string is inside.
 */
export function rangeAt(info, offset) {
  const k = lastRangeBefore(info.ranges, offset);
  if (k === -1) return null;
  const r = info.ranges[k];
  if (offset < r.end) return r;
  if (offset === r.end && !r.closed && r.type !== REGEX) return r;
  return null;
}

/** True when a line starting at `offset` begins inside a multi-line string, template or comment. */
function rangeCovering(info, offset) {
  const k = lastRangeBefore(info.ranges, offset);
  if (k === -1) return null;
  const r = info.ranges[k];
  return offset < r.end ? r : null;
}

// ---- highlighting -------------------------------------------------------------------------------

export const KEYWORDS = new Set(
  ('var let const function return if else for while do switch case break continue new try catch finally ' +
    'throw typeof instanceof in of this null undefined true false delete void default').split(' ')
);
export const GLOBALS = new Set(
  ('gs GlideRecord GlideRecordSecure GlideAggregate GlideDateTime GlideDate GlideTime GlideDuration GlideSystem GlideElement GlideAjax ' +
    'GlideSession GlideFilter GlideSchedule GlideEvaluator GlideQuery GlideSysAttachment GlideModal GlideDialogWindow ' +
    'g_form g_user g_list g_scratchpad g_modal g_navigation current previous answer action request response Class JSON ' +
    'Object Array Math Date String Number Boolean RegExp Error Packages sn_ws RESTMessageV2 SOAPMessageV2 AbstractAjaxProcessor').split(' ')
);
const MAX_LINE_HIGHLIGHT = 4000;
const RANGE_CLASS = { [COMMENT]: 'c', [STRING]: 's', [TEMPLATE]: 's', [REGEX]: 's' };
const CODE_TOKEN = /([A-Za-z_$][\w$]*)|(\d[\w.]*)|([^A-Za-z_$\d]+)/y;

function codeTokens(text, from, to, push) {
  CODE_TOKEN.lastIndex = from;
  while (CODE_TOKEN.lastIndex < to) {
    const at = CODE_TOKEN.lastIndex;
    const m = CODE_TOKEN.exec(text);
    if (!m) break;
    let value = m[0];
    if (at + value.length > to) {
      value = value.slice(0, to - at);
      CODE_TOKEN.lastIndex = to;
    }
    if (m[1] !== undefined) {
      if (KEYWORDS.has(value)) push('k', value);
      else if (GLOBALS.has(value)) push('g', value);
      else if (text[at + value.length] === '(') push('f', value);
      else push('', value);
    } else if (m[2] !== undefined) push('n', value);
    else push('', value);
  }
}

/** Highlight tokens of line `li`: [[cls, text], ...] where cls is '', 'c', 's', 'n', 'k', 'g' or 'f'. */
export function lineTokens(info, li) {
  const { text, ranges, starts } = info;
  const start = starts[li];
  const end = li + 1 < starts.length ? starts[li + 1] - 1 : text.length;
  const out = [];
  const push = (cls, value) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last && last[0] === cls) last[1] += value;
    else out.push([cls, value]);
  };
  if (end - start > MAX_LINE_HIGHLIGHT) {
    push('', text.slice(start, end));
    return out;
  }
  let k = lastRangeBefore(ranges, start + 1);
  if (k === -1 || ranges[k].end <= start) k += 1;
  let pos = start;
  while (pos < end) {
    const r = k < ranges.length ? ranges[k] : null;
    if (r && r.start <= pos) {
      const e = Math.min(r.end, end);
      push(RANGE_CLASS[r.type], text.slice(pos, e));
      pos = e;
      if (r.end <= end) k += 1;
      continue;
    }
    const codeEnd = r && r.start < end ? r.start : end;
    codeTokens(text, pos, codeEnd, push);
    pos = codeEnd;
  }
  return out;
}

// ---- brackets -------------------------------------------------------------------------------------

const OPENERS = '([{';
const CLOSERS = ')]}';
const MAX_BRACKET_SCAN = 200000;

// Char codes: ( 40 ) 41 [ 91 ] 93 { 123 } 125
const PARTNER = { 40: 41, 91: 93, 123: 125, 41: 40, 93: 91, 125: 123 };
const isOpenCode = (c) => c === 40 || c === 91 || c === 123;
const isCloseCode = (c) => c === 41 || c === 93 || c === 125;

function scanMatch(m, pos) {
  const ch = m.charCodeAt(pos);
  const stack = [];
  if (isOpenCode(ch)) {
    for (let i = pos + 1, end = Math.min(m.length, pos + 1 + MAX_BRACKET_SCAN); i < end; i += 1) {
      const c = m.charCodeAt(i);
      if (isOpenCode(c)) stack.push(c);
      else if (isCloseCode(c)) {
        if (!stack.length) return PARTNER[c] === ch ? i : -1;
        if (PARTNER[c] !== stack.pop()) return -1;
      }
    }
    return -1;
  }
  for (let i = pos - 1, end = Math.max(0, pos - 1 - MAX_BRACKET_SCAN); i >= end; i -= 1) {
    const c = m.charCodeAt(i);
    if (isCloseCode(c)) stack.push(c);
    else if (isOpenCode(c)) {
      if (!stack.length) return PARTNER[c] === ch ? i : -1;
      if (PARTNER[c] !== stack.pop()) return -1;
    }
  }
  return -1;
}

/**
 * The bracket next to the caret (before it first, then after it) and its partner.
 * @returns {{at: number, match: number} | null} match is -1 when unmatched
 */
export function matchBracket(text, caret) {
  const info = analyze(text);
  const m = masked(info);
  for (const pos of [caret - 1, caret]) {
    if (pos < 0 || pos >= m.length) continue;
    if (OPENERS.includes(m[pos]) || CLOSERS.includes(m[pos])) return { at: pos, match: scanMatch(m, pos) };
  }
  return null;
}

/** Position of the unmatched opener of `kind` ('(' '[' '{') enclosing `pos`, or -1. */
export function enclosingOpener(text, pos, kind = '{', maxScan = 50000) {
  const m = masked(analyze(text));
  let depth = 0;
  for (let i = pos - 1, steps = 0; i >= 0 && steps < maxScan; i -= 1, steps += 1) {
    const c = m[i];
    if (CLOSERS.includes(c)) depth += 1;
    else if (OPENERS.includes(c)) {
      if (depth === 0) return c === kind ? i : -1;
      depth -= 1;
    }
  }
  return -1;
}

// ---- line editing commands -------------------------------------------------------------------------
// Each returns one replacement {from, to, insert, selStart, selEnd} (or null), which the editor
// applies with a single insertText so the browser's undo keeps working.

/** Lines touched by a selection. A selection that ends at column 0 does not include that line. */
export function lineBlock(text, s, e) {
  const blockStart = lineStartAt(text, s);
  const endRef = e > s && text[e - 1] === '\n' ? e - 1 : e;
  return { blockStart, blockEnd: lineEndAt(text, Math.max(endRef, blockStart)) };
}

/**
 * Applies a per-line prefix edit to the selected lines. fn(line) returns
 * {at, removed, insert} (insert text at column `at` after removing `removed` chars) or null.
 */
function editLines(text, s, e, fn) {
  const { blockStart, blockEnd } = lineBlock(text, s, e);
  const lines = text.slice(blockStart, blockEnd).split('\n');
  const edits = lines.map((line) => fn(line));
  if (edits.every((x) => !x)) return null;
  const next = lines.map((line, i) => {
    const ed = edits[i];
    return ed ? line.slice(0, ed.at) + ed.insert + line.slice(ed.at + ed.removed) : line;
  });
  // The start of a selection stays in front of text inserted right at it, so the selection grows to include it.
  const map = (pos, sticky = false) => {
    let offset = blockStart;
    let delta = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const lineEnd = offset + lines[i].length;
      const ed = edits[i];
      if (pos <= lineEnd) {
        if (!ed) return pos + delta;
        const col = pos - offset;
        let newCol;
        if (col < ed.at || (sticky && col === ed.at && !ed.removed)) newCol = col;
        else if (col < ed.at + ed.removed) newCol = ed.at + ed.insert.length;
        else newCol = col - ed.removed + ed.insert.length;
        return offset + delta + newCol;
      }
      if (ed) delta += ed.insert.length - ed.removed;
      offset = lineEnd + 1;
    }
    return pos + delta;
  };
  return { from: blockStart, to: blockEnd, insert: next.join('\n'), selStart: map(s, s !== e), selEnd: map(e) };
}

/** Ctrl+/: comment the selected lines with //, or uncomment them when all are commented. */
export function toggleLineComment(text, s, e) {
  const { blockStart, blockEnd } = lineBlock(text, s, e);
  const code = text.slice(blockStart, blockEnd).split('\n').filter((l) => l.trim());
  if (!code.length) return null;
  const all = code.every((l) => /^\s*\/\//.test(l));
  if (all) {
    return editLines(text, s, e, (line) => {
      const m = /^(\s*)\/\/( ?)/.exec(line);
      return m ? { at: m[1].length, removed: 2 + m[2].length, insert: '' } : null;
    });
  }
  const min = Math.min(...code.map((l) => /^[ \t]*/.exec(l)[0].length));
  return editLines(text, s, e, (line) => (line.trim() ? { at: min, removed: 0, insert: '// ' } : null));
}

/** Tab with a selection: indent every selected line that has content. */
export function indentLines(text, s, e, unit = '  ') {
  return editLines(text, s, e, (line) => (line.trim() ? { at: 0, removed: 0, insert: unit } : null));
}

/** Shift+Tab: remove one level of indentation from every selected line. */
export function outdentLines(text, s, e, unit = '  ') {
  const width = unit === '\t' ? 2 : unit.length;
  return editLines(text, s, e, (line) => {
    if (line.startsWith('\t')) return { at: 0, removed: 1, insert: '' };
    const spaces = /^ */.exec(line)[0].length;
    const removed = Math.min(spaces, width);
    return removed ? { at: 0, removed, insert: '' } : null;
  });
}

/** Tab with no selection: indentation up to the next indent stop. */
export function insertIndent(text, caret, unit = '  ') {
  if (unit === '\t') return { from: caret, to: caret, insert: '\t', selStart: caret + 1, selEnd: caret + 1 };
  const col = caret - lineStartAt(text, caret);
  const insert = ' '.repeat(unit.length - (col % unit.length));
  return { from: caret, to: caret, insert, selStart: caret + insert.length, selEnd: caret + insert.length };
}

/** Alt+Up / Alt+Down: move the selected lines one line up (dir -1) or down (dir 1). */
export function moveLines(text, s, e, dir) {
  const { blockStart, blockEnd } = lineBlock(text, s, e);
  const block = text.slice(blockStart, blockEnd);
  if (dir < 0) {
    if (blockStart === 0) return null;
    const prevStart = lineStartAt(text, blockStart - 1);
    const prev = text.slice(prevStart, blockStart - 1);
    const shift = prev.length + 1;
    return { from: prevStart, to: blockEnd, insert: `${block}\n${prev}`, selStart: s - shift, selEnd: Math.min(e - shift, blockEnd) };
  }
  if (blockEnd >= text.length) return null;
  const nextEnd = lineEndAt(text, blockEnd + 1);
  const next = text.slice(blockEnd + 1, nextEnd);
  const shift = next.length + 1;
  return { from: blockStart, to: nextEnd, insert: `${next}\n${block}`, selStart: s + shift, selEnd: Math.min(e + shift, nextEnd) };
}

/** Shift+Alt+Down / Shift+Alt+Up: duplicate the selected lines; the selection follows the copy below (dir 1) or stays (dir -1). */
export function duplicateLines(text, s, e, dir = 1) {
  const { blockStart, blockEnd } = lineBlock(text, s, e);
  const block = text.slice(blockStart, blockEnd);
  const shift = dir > 0 ? block.length + 1 : 0;
  return { from: blockEnd, to: blockEnd, insert: `\n${block}`, selStart: s + shift, selEnd: e + shift };
}

/** Ctrl+Shift+K: delete the selected lines. */
export function deleteLines(text, s, e) {
  const { blockStart, blockEnd } = lineBlock(text, s, e);
  if (blockEnd < text.length) return { from: blockStart, to: blockEnd + 1, insert: '', selStart: blockStart, selEnd: blockStart };
  if (blockStart > 0) {
    const caret = lineStartAt(text, blockStart - 1);
    return { from: blockStart - 1, to: blockEnd, insert: '', selStart: caret, selEnd: caret };
  }
  return blockEnd > 0 ? { from: 0, to: blockEnd, insert: '', selStart: 0, selEnd: 0 } : null;
}

/** Enter: new line with the current indentation, one level deeper after an opening bracket, and split `{}` pairs. */
export function newlineAndIndent(text, s, e, unit = '  ') {
  const lineStart = lineStartAt(text, s);
  const before = text.slice(lineStart, s);
  const lead = /^[ \t]*/.exec(before)[0];
  const lastChar = before.replace(/\s+$/, '').slice(-1);
  const opener = lastChar !== '' && OPENERS.includes(lastChar) && rangeAt(analyze(text), s) === null;
  const after = text.slice(e, lineEndAt(text, e));
  const closerMatch = /^[ \t]*([)\]}])/.exec(after);
  let insert = `\n${lead}${opener ? unit : ''}`;
  const caret = s + insert.length;
  let to = e;
  if (opener && closerMatch) {
    insert += `\n${lead}`;
    to = e + closerMatch[0].length - 1;
  }
  return { from: s, to, insert, selStart: caret, selEnd: caret };
}

/** Typing a closing bracket on a line that is only whitespace: align it with the line that opened the block. */
export function closeBracketOutdent(text, s, e, ch) {
  if (s !== e || !CLOSERS.includes(ch)) return null;
  const lineStart = lineStartAt(text, s);
  const before = text.slice(lineStart, s);
  if (before.trim()) return null;
  const open = enclosingOpener(text, s, OPENERS[CLOSERS.indexOf(ch)]);
  if (open === -1) return null;
  const openLine = text.slice(lineStartAt(text, open), open);
  const indent = /^[ \t]*/.exec(openLine)[0];
  if (indent === before) return null;
  const insert = indent + ch;
  return { from: lineStart, to: s, insert, selStart: lineStart + insert.length, selEnd: lineStart + insert.length };
}

/** Home: jump to the first non-blank character, or to column 0 when already there. */
export function smartHome(text, caret) {
  const start = lineStartAt(text, caret);
  const first = start + /^[ \t]*/.exec(text.slice(start, lineEndAt(text, caret)))[0].length;
  return caret === first ? start : first;
}

/** Offset of 1-based `line` and `col`, clamped to the text. */
export function offsetOf(text, line, col = 1) {
  const starts = lineStarts(text);
  const li = Math.min(Math.max(1, Math.floor(line) || 1), starts.length) - 1;
  const start = starts[li];
  const end = lineEndAt(text, start);
  return Math.min(start + Math.max(0, (Math.floor(col) || 1) - 1), end);
}

/** "12", "12:5", ":12" -> {line, col} or null. */
export function parseLineInput(value) {
  const m = /^\s*:?\s*(\d+)\s*(?:[:,]\s*(\d+))?\s*$/.exec(String(value || ''));
  return m ? { line: Number(m[1]), col: m[2] ? Number(m[2]) : 1 } : null;
}

/** Visual column of `offset` on its line with tabs expanded. */
export function visualColumn(text, offset, tabSize = 2) {
  const start = lineStartAt(text, offset);
  let col = 0;
  for (let i = start; i < offset; i += 1) col = text[i] === '\t' ? col + tabSize - (col % tabSize) : col + 1;
  return col;
}

/** Offset on the line starting at `lineStart` that is closest to visual column `col`. */
export function offsetAtVisualColumn(text, lineStart, col, tabSize = 2) {
  const end = lineEndAt(text, lineStart);
  let v = 0;
  for (let i = lineStart; i < end; i += 1) {
    const w = text[i] === '\t' ? tabSize - (v % tabSize) : 1;
    if (col < v + w / 2) return i;
    v += w;
  }
  return end;
}

/** Most likely indentation unit of the text: '\t', or 2/4/8 spaces; null when there is no evidence. */
export function detectIndentUnit(text) {
  let tabs = 0;
  let spaced = 0;
  let prev = 0;
  const deltas = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)[0];
    if (lead.startsWith('\t')) tabs += 1;
    else if (lead.length) spaced += 1;
    if (!lead.includes('\t')) {
      const d = Math.abs(lead.length - prev);
      if (d === 2 || d === 4 || d === 8) deltas.set(d, (deltas.get(d) || 0) + 1);
      prev = lead.length;
    }
  }
  if (tabs > spaced && tabs > 0) return '\t';
  let best = 0;
  let bestCount = 0;
  [2, 4, 8].forEach((d) => {
    const count = deltas.get(d) || 0;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  });
  return best ? ' '.repeat(best) : null;
}

// ---- find and replace ---------------------------------------------------------------------------------

/** @returns {{re: RegExp|null, error?: string}} */
export function buildSearchRegex(query, { regex = false, matchCase = false, wholeWord = false } = {}) {
  if (!query) return { re: null };
  let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return { re: new RegExp(source, matchCase ? 'gm' : 'gim') };
  } catch {
    return { re: null, error: 'Invalid regular expression' };
  }
}

/** Every non-empty match: [{index, length}], capped. */
export function findAll(text, re, max = 5000) {
  const out = [];
  if (!re) return out;
  re.lastIndex = 0;
  let m;
  while (out.length < max && (m = re.exec(text))) {
    if (!m[0].length) {
      re.lastIndex += 1;
      continue;
    }
    out.push({ index: m.index, length: m[0].length });
  }
  re.lastIndex = 0;
  return out;
}

/** Expands $&, $1..$99, $<name> and $$ in a regex replacement. */
export function expandReplacement(replacement, match) {
  return String(replacement).replace(/\$(\$|&|\d{1,2}|<([^>]+)>)/g, (all, token, name) => {
    if (token === '$') return '$';
    if (token === '&') return match[0];
    if (name !== undefined) return match.groups?.[name] ?? '';
    const n = Number(token);
    return n > 0 && n < match.length ? match[n] ?? '' : all;
  });
}

/** Replacement text for the match at exactly [start, end), or null when the selection is not a match. */
export function replacementAt(text, re, start, end, replacement, regexMode) {
  if (!re || end <= start) return null;
  const sticky = new RegExp(re.source, `${re.flags.replace(/[gy]/g, '')}y`);
  sticky.lastIndex = start;
  const m = sticky.exec(text);
  if (!m || m.index !== start || m[0].length !== end - start) return null;
  return regexMode ? expandReplacement(replacement, m) : replacement;
}

/** Replace every match. @returns {{text: string, count: number}} */
export function replaceAllMatches(text, re, replacement, regexMode) {
  if (!re) return { text, count: 0 };
  let count = 0;
  const out = text.replace(re, (...args) => {
    const match = args[0];
    if (!match) return match;
    count += 1;
    if (!regexMode) return replacement;
    const groupsArg = args[args.length - 1];
    const hasGroups = groupsArg && typeof groupsArg === 'object';
    const groups = args.slice(0, hasGroups ? -3 : -2);
    groups.groups = hasGroups ? groupsArg : undefined;
    return expandReplacement(replacement, groups);
  });
  return { text: out, count };
}

/** The smallest single replacement that turns `a` into `b`: {from, to, insert}, or null when equal. */
export function diffRange(a, b) {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p += 1;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s += 1;
  return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) };
}

// ---- re-indent (format) ----------------------------------------------------------------------------------

/**
 * Re-indents code from its bracket structure. Only leading whitespace changes (whitespace-only
 * lines become empty); lines that start inside a string or template literal are left exactly as
 * they are. Returns {error} instead of guessing when the brackets do not balance.
 * @returns {{text: string, changed: boolean} | {error: string}}
 */
export function reindent(text, unit = '  ') {
  const info = analyze(text);
  const m = masked(info);
  const lines = text.split('\n');
  const stack = [];
  const out = [];
  for (let li = 0; li < lines.length; li += 1) {
    const raw = lines[li];
    const start = info.starts[li];
    const mline = m.slice(start, start + raw.length);
    const covering = rangeCovering(info, start);
    const trimmed = raw.replace(/^[ \t]+/, '');
    const top = stack[stack.length - 1];
    let next = raw;
    if (covering && covering.type === COMMENT) {
      // Inside a block comment only the " * " continuation lines are aligned; anything else
      // (for example commented-out code) keeps its own indentation.
      if (!trimmed) next = '';
      else if (trimmed.startsWith('*')) next = `${top ? top.base + unit : ''} ${trimmed}`;
    } else if (!covering) {
      if (!trimmed) next = '';
      else {
        const mtrim = mline.slice(raw.length - trimmed.length);
        let indent;
        if (CLOSERS.includes(mtrim[0])) indent = top ? top.base : '';
        else if (top && top.isSwitch) indent = /^(case\b|default\s*:)/.test(trimmed) ? top.base + unit : top.base + unit + unit;
        else indent = top ? top.base + unit : '';
        if (/^\.[A-Za-z_$]/.test(mtrim)) indent += unit;
        next = indent + trimmed;
      }
    }
    out.push(next);
    const base = /^[ \t]*/.exec(next)[0];
    for (let i = 0; i < mline.length; i += 1) {
      const c = mline[i];
      if (OPENERS.includes(c)) {
        stack.push({ ch: c, base, isSwitch: c === '{' && /\bswitch\b[^{]*$/.test(mline.slice(0, i)) });
      } else if (CLOSERS.includes(c)) {
        const top = stack.pop();
        if (!top || OPENERS.indexOf(top.ch) !== CLOSERS.indexOf(c)) {
          return { error: `Brackets do not balance on line ${li + 1}. Fix that first.` };
        }
      }
    }
  }
  if (stack.length) return { error: 'A bracket is never closed. Fix that first.' };
  const result = out.join('\n');
  return { text: result, changed: result !== text };
}
