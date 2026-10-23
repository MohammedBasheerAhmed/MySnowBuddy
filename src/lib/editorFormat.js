// Conservative formatter for ES5-style ServiceNow scripts ("Format document" / "Format selection").
//
// What it does: re-indents from the bracket structure (editorText.reindent), puts one space after a comma and
// around assignment, equality and logical operators, one space between `if/for/while/switch/catch` and `(`, one
// space before a block's `{` and in `} else`, removes the space before `,` and `;`, trims trailing whitespace,
// collapses runs of blank lines to one, drops blank lines at the top and ends the file with one newline.
//
// What it never does: move a brace to another line, join or split lines, reflow or re-wrap anything, or touch
// the inside of strings, template literals, regular expressions and comments (apart from trailing whitespace
// and the indentation of block-comment lines).
//
// How it stays safe: after formatting it compares the token stream (ignoring whitespace) before and after and
// refuses when they differ, refuses when a second run would change the result again, and refuses when the new
// text has a syntax error the old one did not. Pure functions; tested in tests/editorplus.test.js.
import { analyze, lex, reindent, lineOfOffset, isOtherSpace, COMMENT, STRING, TEMPLATE, REGEX } from './editorText.js';
import { checkSyntax } from './syntax.js';

const MAX_CHARS = 400000;

const isWordStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || (c > 127 && !isOtherSpace(c));
const isWordPart = (c) => isWordStart(c) || (c >= 48 && c <= 57);
// Longest first. The logical assignments (??= ||= &&=) are one token each: spacing `??` apart from `=` would break the
// code. `a?.5:b` is `?` then `.5`, not optional chaining.
const OPERATOR = /(?:>>>=|\.\.\.|===|!==|\*\*=|<<=|>>=|\?\?=|\|\|=|&&=|>>>|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.(?!\d)|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|\*\*)/y;
const TYPE = { [COMMENT]: 'comment', [STRING]: 'string', [TEMPLATE]: 'template', [REGEX]: 'regex' };

/**
 * Tokens of the text: comments, strings, templates and regexes come from the lexer, the rest is split into
 * words, numbers and operators (longest operator first, so `==` and `= =` are different).
 * @returns {{type: string, start: number, end: number}[]}
 */
export function tokenize(text, ranges = lex(text)) {
  const out = [];
  const n = text.length;
  let i = 0;
  let r = 0;
  while (i < n) {
    const range = r < ranges.length ? ranges[r] : null;
    if (range && range.start === i) {
      out.push({ type: TYPE[range.type], start: i, end: range.end });
      i = range.end;
      r += 1;
      continue;
    }
    const c = text.charCodeAt(i);
    // A no-break space or another Unicode blank is whitespace too; a gap holding one is never touched (see spacingEdits).
    if (c === 32 || c === 9 || c === 10 || c === 13 || isOtherSpace(c)) {
      i += 1;
      continue;
    }
    let end = i + 1;
    let type = 'op';
    OPERATOR.lastIndex = i;
    let hit;
    // `#name` (a private class member) is one word.
    if (isWordStart(c) || (c === 35 && isWordStart(text.charCodeAt(i + 1)))) {
      while (end < n && isWordPart(text.charCodeAt(end))) end += 1;
      type = 'word';
    } else if (c >= 48 && c <= 57) {
      const hex = c === 48 && (text[i + 1] === 'x' || text[i + 1] === 'X');
      for (;;) {
        const d = text.charCodeAt(end);
        // 1e-5 is one number: the sign of a decimal exponent belongs to it.
        const sign = (d === 43 || d === 45) && !hex && (text[end - 1] === 'e' || text[end - 1] === 'E');
        if (end < n && (isWordPart(d) || d === 46 || sign)) end += 1;
        else break;
      }
      type = 'number';
    } else if ((hit = OPERATOR.exec(text))) {
      end = i + hit[0].length;
    }
    out.push({ type, start: i, end });
    i = end;
  }
  return out;
}

/** The code reduced to its tokens: whitespace is gone, and comments lose only their trailing and leading line whitespace. */
export function tokenSignature(text) {
  const info = analyze(text);
  return tokenize(info.text, info.ranges)
    .map((t) => {
      const s = info.text.slice(t.start, t.end);
      return t.type === 'comment' ? s.replace(/[ \t]+$/gm, '').replace(/\n[ \t]+/g, '\n') : s;
    })
    .join('\u0001');
}

// ---- spacing --------------------------------------------------------------------------------------------

const SPACED_OPERATORS = new Set(['=', '==', '===', '!=', '!==', '<=', '>=', '&&', '||', '??', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '**=', '??=', '||=', '&&=', '=>']);
const KEYWORD_PAREN = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
const KEYWORD_BRACE = new Set(['else', 'try', 'finally', 'do']);
const AFTER_CLOSING_BRACE = new Set(['else', 'catch', 'finally']);
const CLOSERS = new Set([')', ']', '}']);

/** The gap that should sit between two neighbouring tokens on one line: ' ', '' or null (leave it alone). */
function wantedGap(tokens, k, text) {
  const a = tokens[k];
  const b = tokens[k + 1];
  if (a.type === 'comment' || b.type === 'comment') return null;
  const A = text.slice(a.start, a.end);
  const B = text.slice(b.start, b.end);
  if (B === ',' || B === ';') return '';
  if (A === ',') return CLOSERS.has(B) ? null : B === ',' ? '' : ' ';
  if (A === ';') return CLOSERS.has(B) || B === ';' ? null : ' ';
  if (SPACED_OPERATORS.has(A) || SPACED_OPERATORS.has(B)) return ' ';
  // `.catch(` and `.if(` are method calls, not keywords.
  const dotted = k > 0 && text.slice(tokens[k - 1].start, tokens[k - 1].end) === '.';
  if (B === '(' && a.type === 'word' && KEYWORD_PAREN.has(A) && !dotted) return ' ';
  if (B === '{' && (A === ')' || (a.type === 'word' && KEYWORD_BRACE.has(A) && !dotted))) return ' ';
  if (A === '}' && b.type === 'word' && AFTER_CLOSING_BRACE.has(B)) return ' ';
  return null;
}

/** Edits {start, end, insert} that fix the spacing between tokens that share a line. */
function spacingEdits(text) {
  const info = analyze(text);
  const tokens = tokenize(info.text, info.ranges);
  const edits = [];
  for (let k = 0; k + 1 < tokens.length; k += 1) {
    const gapStart = tokens[k].end;
    const gapEnd = tokens[k + 1].start;
    const gap = text.slice(gapStart, gapEnd);
    if (gap.includes('\n') || /[^ \t]/.test(gap)) continue;
    const want = wantedGap(tokens, k, text);
    if (want !== null && want !== gap) edits.push({ start: gapStart, end: gapEnd, insert: want });
  }
  return edits;
}

// ---- whitespace at the ends of lines --------------------------------------------------------------------

/** Edits that remove trailing spaces and tabs, except where they are part of a string or template. */
function trailingEdits(text) {
  const info = analyze(text);
  const { starts, ranges } = info;
  const edits = [];
  let r = 0;
  for (let li = 0; li < starts.length; li += 1) {
    const s = starts[li];
    const e = li + 1 < starts.length ? starts[li + 1] - 1 : text.length;
    let t = e;
    while (t > s && (text.charCodeAt(t - 1) === 32 || text.charCodeAt(t - 1) === 9)) t -= 1;
    if (t === e) continue;
    while (r < ranges.length && ranges[r].end <= t) r += 1;
    const hit = r < ranges.length ? ranges[r] : null;
    if (hit && hit.start < e && hit.type !== COMMENT) continue;
    edits.push({ start: t, end: e, insert: '' });
  }
  return edits;
}

/** True for each line that begins inside a multi-line comment, string or template (its content is not ours to change). */
function insideRanges(info) {
  const flags = new Uint8Array(info.starts.length);
  for (const r of info.ranges) {
    const nl = info.text.indexOf('\n', r.start);
    if (nl === -1 || nl >= r.end) continue;
    const first = lineOfOffset(info.starts, r.start) + 1;
    const last = lineOfOffset(info.starts, r.end - 1);
    for (let li = first; li <= last; li += 1) flags[li] = 1;
  }
  return flags;
}

function collapseBlankLines(text) {
  const info = analyze(text);
  const flags = insideRanges(info);
  const lines = text.split('\n');
  const out = [];
  let lastBlank = true; // blank lines at the very top are dropped too
  lines.forEach((line, li) => {
    const blank = line === '' && !flags[li];
    if (blank && lastBlank) return;
    out.push(line);
    lastBlank = blank;
  });
  return out.join('\n');
}

function endWithNewline(text) {
  const info = analyze(text);
  const last = info.ranges[info.ranges.length - 1];
  // A string, template or block comment that is still open at the end owns its trailing whitespace.
  if (last && last.end >= text.length && !last.closed && (last.type !== COMMENT || text.charCodeAt(last.start + 1) === 42)) return text;
  let cut = text.length;
  while (cut > 0 && /\s/.test(text[cut - 1])) cut -= 1;
  // The spaces at the end of an unterminated string on the last line belong to that string.
  if (last && last.type !== COMMENT && last.end > cut) cut = last.end;
  return `${text.slice(0, cut)}\n`;
}

function applyEdits(text, edits, keep) {
  if (!edits.length) return text;
  const starts = analyze(text).starts;
  let out = text;
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const e = edits[i];
    if (keep && !keep(lineOfOffset(starts, e.start))) continue;
    out = out.slice(0, e.start) + e.insert + out.slice(e.end);
  }
  return out;
}

// ---- the formatter ----------------------------------------------------------------------------------------

function formatPass(text, unit, fromLine, toLine) {
  const whole = fromLine == null;
  const keep = whole ? null : (li) => li >= fromLine && li <= toLine;
  const indented = reindent(text, unit);
  if (indented.error) return { error: indented.error };
  let cur = text;
  if (whole) cur = indented.text;
  else {
    const before = text.split('\n');
    const after = indented.text.split('\n');
    cur = before.map((line, li) => (keep(li) ? after[li] : line)).join('\n');
  }
  cur = applyEdits(cur, spacingEdits(cur), keep);
  cur = applyEdits(cur, trailingEdits(cur), keep);
  if (whole) {
    cur = collapseBlankLines(cur);
    cur = endWithNewline(cur);
  }
  return { text: cur };
}

/**
 * Formats the whole text, or only lines `fromLine`..`toLine` (0-based, inclusive) when both are given.
 * @returns {{text: string, changed: boolean} | {error: string}} an error means nothing should be changed
 */
export function formatCode(source, { unit = '  ', fromLine = null, toLine = null } = {}) {
  const src = String(source ?? '');
  if (!src.trim()) return { text: src, changed: false };
  if (src.length > MAX_CHARS) return { error: 'This script is too long to format safely.' };
  let lf = src;
  let crlf = false;
  if (src.includes('\r')) {
    if (/\r(?!\n)/.test(src) || /(?<!\r)\n/.test(src)) return { error: 'The line endings are mixed, so nothing was changed.' };
    crlf = true;
    lf = src.replace(/\r\n/g, '\n');
  }
  const range = fromLine == null || toLine == null ? [null, null] : [Math.max(0, Math.min(fromLine, toLine)), Math.max(fromLine, toLine)];
  const first = formatPass(lf, unit, range[0], range[1]);
  if (first.error) return first;
  if (first.text === lf) return { text: src, changed: false };
  if (tokenSignature(first.text) !== tokenSignature(lf)) return { error: 'Formatting would have changed the code itself, so nothing was changed.' };
  const second = formatPass(first.text, unit, range[0], range[1]);
  if (second.error || second.text !== first.text) return { error: 'The result of formatting was not stable, so nothing was changed.' };
  if (!checkSyntax(lf) && checkSyntax(first.text)) return { error: 'Formatting would have broken the syntax, so nothing was changed.' };
  return { text: crlf ? first.text.replace(/\n/g, '\r\n') : first.text, changed: true };
}

/**
 * Where `offset` of `before` lands in `after`, when the two texts differ only in whitespace (as formatting does):
 * the caret keeps its place among the non-blank characters. A caret in the indentation goes to the new indentation's
 * end, one after code stays after that code, one on a blank line goes to the start of the line after the code above it.
 */
export function mapOffset(before, after, offset) {
  const ws = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const o = Math.max(0, Math.min(offset, before.length));
  let n = 0;
  for (let i = 0; i < o; i += 1) if (!ws(before[i])) n += 1;
  let k = o;
  while (k > 0 && (before[k - 1] === ' ' || before[k - 1] === '\t')) k -= 1;
  const onCodeLine = k > 0 && before[k - 1] !== '\n';
  let lineEnd = o;
  while (lineEnd < before.length && (before[lineEnd] === ' ' || before[lineEnd] === '\t')) lineEnd += 1;
  const blankLine = !onCodeLine && (lineEnd >= before.length || before[lineEnd] === '\n');
  let seen = 0;
  let p = 0;
  if (onCodeLine || blankLine) {
    while (p < after.length && seen < n) {
      if (!ws(after[p])) seen += 1;
      p += 1;
    }
    if (blankLine && n > 0) {
      while (p < after.length && after[p] !== '\n') p += 1;
      if (p < after.length) p += 1;
    }
    return p;
  }
  while (p < after.length) {
    if (!ws(after[p])) {
      if (seen === n) break;
      seen += 1;
    }
    p += 1;
  }
  return p;
}
