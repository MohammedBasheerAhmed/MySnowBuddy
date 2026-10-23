// Tab-triggered snippets for the script editor. Type a name and press Tab: the snippet goes in with its blanks
// selected one after the other (Tab moves on, Shift+Tab goes back). Template syntax:
//   ${1:table}  a blank with a suggestion; the number is the Tab order (1, 2, 3 ... then the end)
//   $1 or ${1}  a blank with no suggestion; the same number again is a copy that follows what you type in the first
//   $0          where the caret ends up (the end of the snippet when there is no $0)
//   \$ \} \\    a literal $, } or backslash
// Pure functions; the session that tracks the blanks while you type is in editorSnippetSession.js.
import { analyze, rangeAt } from './editorText.js';

export const SNIPPETS = {
  gr: "var gr = new GlideRecord('${1:table}');\ngr.addQuery('${2:field}', ${3:value});\ngr.query();\nwhile (gr.next()) {\n  $0\n}",
  grget: "var gr = new GlideRecord('${1:table}');\nif (gr.get(${2:sysId})) {\n  $0\n}",
  gra: "var ga = new GlideAggregate('${1:table}');\nga.addAggregate('COUNT');\nga.query();\nif (ga.next()) {\n  var count = ga.getAggregate('COUNT');\n  $0\n}",
  gdt: 'var gdt = new GlideDateTime();$0',
  info: "gs.info('${1:message}');$0",
  err: "gs.error('${1:message}');$0",
  try: 'try {\n  ${1:// work}\n} catch (e) {\n  gs.error(e.message);\n}$0',
  fn: 'function ${1:name}(${2:args}) {\n  $0\n}',
  ajax: "var ga = new GlideAjax('${1:ScriptIncludeName}');\nga.addParam('sysparm_name', '${2:methodName}');\nga.getXMLAnswer(function(answer) {\n  $0\n});",
  si: "var ${1:ClassName} = Class.create();\n${1}.prototype = {\n  initialize: function(${2}) {\n    $0\n  },\n\n  ${3:methodName}: function(${4}) {\n\n  },\n\n  type: '${1}'\n};",
  sia: "var ${1:ClassName} = Class.create();\n${1}.prototype = Object.extendsObject(global.AbstractAjaxProcessor, {\n  ${2:methodName}: function() {\n    var ${3:input} = this.getParameter('sysparm_${3}');\n    $0\n  },\n\n  type: '${1}'\n});",
  br: '(function executeRule(current, previous /*null when async*/) {\n  $0\n})(current, previous);',
  onchange: "function onChange(control, oldValue, newValue, isLoading, isTemplate) {\n  if (isLoading || newValue === '') {\n    return;\n  }\n  $0\n}",
  onload: 'function onLoad() {\n  $0\n}',
  onsubmit: 'function onSubmit() {\n  $0\n  return true;\n}',
};

/**
 * Reads a template into plain text and its blanks. `indent` goes after every line break, so a snippet typed on an
 * indented line keeps its shape. Blanks come back in Tab order with the final stop ($0, or the end) last; every
 * range is {start, end} relative to the start of the text, and the first range of a stop is the one you type in.
 * @returns {{text: string, stops: {index: number, ranges: {start: number, end: number}[]}[]}}
 */
export function parseTemplate(template, indent = '') {
  const tokens = [];
  const defaults = new Map();
  let literal = '';
  const flush = () => {
    if (literal) tokens.push({ literal });
    literal = '';
  };
  const unescape = (s) => s.replace(/\\([$}\\])/g, '$1');
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c === '\\' && /[$}\\]/.test(template[i + 1] || '')) {
      literal += template[i + 1];
      i += 2;
      continue;
    }
    if (c === '$') {
      const simple = /\$(\d+)/y;
      simple.lastIndex = i;
      let m = simple.exec(template);
      if (m) {
        flush();
        tokens.push({ stop: Number(m[1]), text: '' });
        i += m[0].length;
        continue;
      }
      const braced = /\$\{(\d+)(?::((?:[^}\\]|\\.)*))?\}/y;
      braced.lastIndex = i;
      m = braced.exec(template);
      if (m) {
        flush();
        const text = unescape(m[2] || '');
        if (text && !defaults.has(Number(m[1]))) defaults.set(Number(m[1]), text);
        tokens.push({ stop: Number(m[1]), text });
        i += m[0].length;
        continue;
      }
    }
    literal += c;
    i += 1;
  }
  flush();

  let text = '';
  const ranges = new Map();
  const put = (s) => {
    text += s.replace(/\n/g, `\n${indent}`);
  };
  for (const token of tokens) {
    if (token.literal !== undefined) {
      put(token.literal);
      continue;
    }
    const start = text.length;
    put(defaults.get(token.stop) || '');
    const list = ranges.get(token.stop) || [];
    list.push({ start, end: text.length });
    ranges.set(token.stop, list);
  }
  const order = [...ranges.keys()].filter((n) => n !== 0).sort((a, b) => a - b);
  const stops = order.map((index) => ({ index, ranges: ranges.get(index) }));
  stops.push({ index: 0, ranges: ranges.get(0) ? [ranges.get(0)[0]] : [{ start: text.length, end: text.length }] });
  return { text, stops };
}

/**
 * Snippet for the word just before the caret, if any.
 * @returns {{key: string, start: number, end: number, text: string, caret: number, stops: {index: number, ranges: {start: number, end: number}[]}[]} | null}
 *   `start`/`end` is the trigger word to replace; `caret` and `stops` are offsets in the text after the replacement.
 */
export function expandSnippet(source, caret) {
  const lineStart = source.lastIndexOf('\n', caret - 1) + 1;
  const before = source.slice(lineStart, caret);
  const word = /[A-Za-z]+$/.exec(before);
  if (!word || !Object.prototype.hasOwnProperty.call(SNIPPETS, word[0])) return null;
  if (/[\w$.]/.test(before[before.length - word[0].length - 1] || '')) return null;
  // Not in a comment or a string: "// see the gr" + Tab must not put a query (live code from its second line) in the comment.
  if (rangeAt(analyze(source), caret)) return null;
  return expandKey(word[0], caret - word[0].length, caret, /^[ \t]*/.exec(before)[0]);
}

/** The snippet `key` placed where [start, end) is, with `indent` on every line after the first. */
export function expandKey(key, start, end, indent = '') {
  if (!Object.prototype.hasOwnProperty.call(SNIPPETS, key)) return null;
  const parsed = parseTemplate(SNIPPETS[key], indent);
  const stops = parsed.stops.map((stop) => ({ index: stop.index, ranges: stop.ranges.map((r) => ({ start: start + r.start, end: start + r.end })) }));
  return { key, start, end, text: parsed.text, caret: stops[0].ranges[0].start, stops };
}
