// Lightweight structural check for script text: unbalanced brackets, unterminated strings and
// comments. It is not a parser, so it errs on the side of saying nothing.

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set([')', ']', '}']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new']);
const REGEX_AFTER_CHAR = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** @returns {{line: number, message: string} | null} */
export function checkSyntax(src) {
  const text = String(src || '');
  const n = text.length;
  const stack = [];
  let line = 1;
  let i = 0;
  let prev = '';
  let lastWord = '';

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return { line, message: 'Unclosed comment (/*)' };
      line += (text.slice(i, end).match(/\n/g) || []).length;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const startLine = line;
      i += 1;
      while (i < n && text[i] !== c) {
        if (text[i] === '\\') {
          if (text[i + 1] === '\n') line += 1;
          i += 2;
          continue;
        }
        if (text[i] === '\n') return { line: startLine, message: `Unterminated string (${c})` };
        i += 1;
      }
      if (i >= n) return { line: startLine, message: `Unterminated string (${c})` };
      i += 1;
      prev = 'a';
      continue;
    }
    if (c === '`') {
      const startLine = line;
      i += 1;
      while (i < n && text[i] !== '`') {
        if (text[i] === '\\') i += 1;
        else if (text[i] === '\n') line += 1;
        i += 1;
      }
      if (i >= n) return { line: startLine, message: 'Unterminated template string (`)' };
      i += 1;
      prev = 'a';
      continue;
    }
    if (c === '/' && (REGEX_AFTER_CHAR.has(prev) || (prev === 'a' && REGEX_AFTER_WORD.has(lastWord)))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j += 1;
      }
      if (text[j] === '/') {
        i = j + 1;
        prev = 'a';
        continue;
      }
      // No closing slash on this line: it was a division after all.
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(text[j])) j += 1;
      lastWord = text.slice(i, j);
      i = j;
      prev = 'a';
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < n && /[\w.]/.test(text[i])) i += 1;
      prev = 'a';
      continue;
    }
    if (OPEN[c]) {
      stack.push({ ch: c, line });
    } else if (CLOSE.has(c)) {
      const top = stack.pop();
      if (!top) return { line, message: `Unexpected '${c}'` };
      if (OPEN[top.ch] !== c) {
        return { line, message: `Unexpected '${c}'; '${top.ch}' from line ${top.line} is still open` };
      }
    }
    prev = c === ')' || c === ']' ? 'a' : c;
    i += 1;
  }

  const open = stack.pop();
  return open ? { line: open.line, message: `Unclosed '${open.ch}'` } : null;
}
