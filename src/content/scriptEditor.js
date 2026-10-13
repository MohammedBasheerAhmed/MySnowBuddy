// Full-screen script editor for the script field on the open form: syntax highlighting, line
// numbers, find and replace, auto-indent and comment toggling. It only changes the form field
// (never saves the record) and is built from DOM nodes, with no innerHTML.

import { callPage } from './pageBridge.js';
import { lintScript, formatLintFindings } from '../lib/lint.js';
import { checkSyntax } from '../lib/syntax.js';
import { expandSnippet } from '../lib/snippets.js';
import { analyzeScriptRisk, formatRiskSummary } from '../lib/scriptSafety.js';

const KEYWORDS = new Set(
  ('var let const function return if else for while do switch case break continue new try catch finally ' +
    'throw typeof instanceof in of this null undefined true false delete void default').split(' ')
);
const GLOBALS = new Set(
  ('gs GlideRecord GlideAggregate GlideDateTime GlideDate GlideDuration GlideSystem GlideElement GlideAjax ' +
    'GlideSession GlideFilter GlideSchedule GlideEvaluator g_form g_user g_list g_scratchpad g_modal current ' +
    'previous answer action request response Class JSON Object Array Math Date String Number Boolean RegExp ' +
    'Error Packages sn_ws RESTMessageV2 SOAPMessageV2').split(' ')
);
const TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([\s\S])/g;
const MAX_HIGHLIGHT_CHARS = 150000;
const INDENT = '  ';
const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
const CLOSERS = new Set([')', ']', '}']);
const LINE_HEIGHT = 20;
const TOP_PAD = 10;
const MAX_LINT_CHARS = 200000;
const MAX_AI_CHARS = 30000;
const AI_ACTIONS = [
  ['explain', 'Explain this script'],
  ['fix', 'Find bugs and fix'],
  ['test', 'Write a test'],
  ['comment', 'Add comments'],
];
const AI_INSTRUCTIONS = {
  explain: 'Explain what this ServiceNow script does, step by step, and call out anything risky or surprising.',
  fix: 'Review this ServiceNow script for bugs and ServiceNow best-practice problems. Return the corrected script in one code block and list each change you made.',
  test: 'Write a test for this ServiceNow script: a background script that exercises it with sample data and prints what it expects, plus the ATF steps if they apply.',
  comment: 'Add concise comments and JSDoc to this ServiceNow script without changing its behaviour. Return the whole script in one code block.',
};

/** The field most likely to be "the" script: `script`, then script-like names, then the longest. */
export function bestScriptField(fields) {
  return (
    fields.find((f) => f.name === 'script') ||
    fields.find((f) => /script/i.test(f.name) && f.length > 0) ||
    [...fields].sort((a, b) => b.length - a.length)[0]
  );
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const node = h('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function tokens(src) {
  const out = [];
  const push = (cls, text) => {
    const last = out[out.length - 1];
    if (last && last[0] === cls) last[1] += text;
    else out.push([cls, text]);
  };
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(src))) {
    if (m[1] !== undefined) push('c', m[1]);
    else if (m[2] !== undefined) push('s', m[2]);
    else if (m[3] !== undefined) push('n', m[3]);
    else if (m[4] !== undefined) {
      const word = m[4];
      if (KEYWORDS.has(word)) push('k', word);
      else if (GLOBALS.has(word)) push('g', word);
      else if (src[TOKEN_RE.lastIndex] === '(') push('f', word);
      else push('', word);
    } else push('', m[5]);
  }
  return out;
}

function paintCode(pre, src) {
  if (src.length > MAX_HIGHLIGHT_CHARS) {
    pre.textContent = `${src}\n`;
    return;
  }
  const frag = document.createDocumentFragment();
  tokens(src).forEach(([cls, text]) => {
    if (!cls) frag.appendChild(document.createTextNode(text));
    else frag.appendChild(h('span', `msb-ed__t-${cls}`, text));
  });
  frag.appendChild(document.createTextNode('\n'));
  pre.replaceChildren(frag);
}

/**
 * @param {{shadow: ShadowRoot, toast: object, tools?: {
 *   runScript?: (script: string, options: {dryRun: boolean}) => Promise<string>,
 *   askAi?: (label: string, prompt: string) => void,
 *   openCompare?: () => void,
 *   getUpdateSet?: () => Promise<{name: string} | null>,
 *   findDefinition?: (name: string) => Promise<string | null>,
 *   isProd?: () => boolean,
 * }}} deps
 */
export async function openScriptEditor({ shadow, toast, tools = {} }) {
  const existing = shadow.querySelector('.msb-ed');
  if (existing) {
    existing.hidden = false;
    existing.dispatchEvent(new CustomEvent('msb-show'));
    return;
  }

  const fields = await callPage('getScriptFields').catch(() => []);
  if (!Array.isArray(fields) || !fields.length) {
    toast.error('No script field was found on this page. Open a record with a script first.');
    return;
  }
  const meta = await callPage('getFormMeta').catch(() => null);
  const table = meta?.table || '';

  let field = bestScriptField(fields);
  let baseline = '';

  const overlay = h('div', 'msb-ed');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Script editor');
  const dialog = h('div', 'msb-ed__dialog');

  // --- Header ---
  const header = h('div', 'msb-ed__header');
  const title = h('div', 'msb-ed__title', table ? `${table}` : 'Script');
  const fieldSelect = document.createElement('select');
  fieldSelect.className = 'msb-ed__select';
  fieldSelect.setAttribute('aria-label', 'Script field');
  fields.forEach((f) => {
    const opt = document.createElement('option');
    opt.value = f.name;
    opt.textContent = `${f.label || f.name} (${f.name})`;
    fieldSelect.appendChild(opt);
  });
  fieldSelect.value = field.name;
  const chip = h('span', 'msb-ed__chip');
  chip.hidden = true;
  const status = h('span', 'msb-ed__status');
  const actions = h('div', 'msb-ed__actions');
  header.append(title, fieldSelect, chip, status, actions);

  // --- Find bar ---
  const findBar = h('div', 'msb-ed__find');
  findBar.hidden = true;
  const findInput = document.createElement('input');
  findInput.placeholder = 'Find';
  findInput.setAttribute('aria-label', 'Find');
  const replaceInput = document.createElement('input');
  replaceInput.placeholder = 'Replace with';
  replaceInput.setAttribute('aria-label', 'Replace with');
  const matchCase = document.createElement('input');
  matchCase.type = 'checkbox';
  matchCase.id = 'msb-ed-case';
  const matchCaseLabel = h('label', null, 'Aa');
  matchCaseLabel.htmlFor = 'msb-ed-case';
  matchCaseLabel.title = 'Match case';
  const findCount = h('span', 'msb-ed__count');

  // --- Editor surface ---
  const body = h('div', 'msb-ed__body');
  const gutter = h('div', 'msb-ed__gutter');
  const gutterInner = h('pre', 'msb-ed__gutter-inner');
  const marks = h('div', 'msb-ed__marks');
  gutter.append(gutterInner, marks);
  const surface = h('div', 'msb-ed__surface');
  const hl = h('div', 'msb-ed__hl');
  const bands = h('div', 'msb-ed__bands');
  const code = h('pre', 'msb-ed__code');
  hl.append(bands, code);
  const ta = document.createElement('textarea');
  ta.className = 'msb-ed__input';
  ta.wrap = 'off';
  ta.spellcheck = false;
  ta.autocapitalize = 'off';
  ta.setAttribute('aria-label', 'Script');
  surface.append(hl, ta);
  body.append(gutter, surface);

  const lintBox = h('pre', 'msb-ed__lint');
  lintBox.hidden = true;

  const footer = h('div', 'msb-ed__footer');
  const position = h('span', null, 'Ln 1, Col 1');
  const problems = h('span', 'msb-ed__problems');
  const hints = h(
    'span',
    'msb-ed__hints',
    'Ctrl+S apply \u00b7 Ctrl+Shift+S apply & save \u00b7 F12 definition \u00b7 Tab after gr, grget, gra, gdt, info, try, fn, ajax adds a snippet \u00b7 Esc close'
  );
  footer.append(position, problems, hints);

  // --- Behaviour ---
  const isDirty = () => ta.value !== baseline;

  function refresh() {
    paintCode(code, ta.value);
    const lines = ta.value.split('\n').length;
    gutterInner.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    updatePosition();
    status.textContent = isDirty() ? 'Modified' : 'No changes';
    status.classList.toggle('msb-ed__status--dirty', isDirty());
    scheduleLint();
  }

  function syncScroll() {
    const t = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    code.style.transform = t;
    gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`;
    marks.style.transform = `translateY(${-ta.scrollTop}px)`;
    bands.style.transform = `translateY(${-ta.scrollTop}px)`;
  }

  // --- Problem markers (syntax and lint) ---
  let problemItems = [];
  let lintTimer = 0;

  function paintMarks(items) {
    marks.replaceChildren();
    bands.replaceChildren();
    items.slice(0, 200).forEach((item) => {
      const top = `${TOP_PAD + (item.line - 1) * LINE_HEIGHT}px`;
      const mark = h('span', `msb-ed__mark msb-ed__mark--${item.level}`);
      mark.style.top = top;
      mark.title = item.message;
      marks.appendChild(mark);
      const band = h('div', `msb-ed__band msb-ed__band--${item.level}`);
      band.style.top = top;
      bands.appendChild(band);
    });
  }

  function collectProblems() {
    const items = [];
    const syntax = checkSyntax(ta.value);
    if (syntax) items.push({ line: syntax.line, level: 'error', message: `Syntax: ${syntax.message}` });
    if (ta.value.length <= MAX_LINT_CHARS) {
      lintScript(ta.value, { table }).forEach((f) => {
        if (f.line) items.push({ line: f.line, level: f.severity || 'low', message: `${f.message}${f.suggestion ? ` \u2014 ${f.suggestion}` : ''}` });
      });
    }
    return items;
  }

  function updateProblems() {
    problemItems = collectProblems();
    paintMarks(problemItems);
    const errors = problemItems.filter((p) => p.level === 'error').length;
    const warnings = problemItems.length - errors;
    problems.textContent = problemItems.length
      ? `${errors ? `${errors} syntax error${errors > 1 ? 's' : ''}` : ''}${errors && warnings ? ', ' : ''}${warnings ? `${warnings} lint finding${warnings > 1 ? 's' : ''}` : ''}`
      : '';
    problems.classList.toggle('msb-ed__problems--error', errors > 0);
  }

  function scheduleLint() {
    clearTimeout(lintTimer);
    lintTimer = setTimeout(updateProblems, 400);
  }

  function goToLine(line) {
    const lines = ta.value.split('\n');
    const index = lines.slice(0, Math.max(0, line - 1)).reduce((sum, l) => sum + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(index, index);
    revealLine(index);
    updatePosition();
  }

  function updatePosition() {
    const before = ta.value.slice(0, ta.selectionStart);
    const line = before.split('\n').length;
    const col = before.length - before.lastIndexOf('\n');
    position.textContent = `Ln ${line}, Col ${col} \u00b7 ${ta.value.length.toLocaleString()} chars`;
  }

  // execCommand keeps the native undo stack; setRangeText is the fallback.
  function replaceRange(start, end, text) {
    ta.focus();
    ta.setSelectionRange(start, end);
    const ok = document.execCommand && document.execCommand('insertText', false, text);
    if (!ok) {
      ta.setRangeText(text, start, end, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function lineBlock() {
    const v = ta.value;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const blockStart = v.lastIndexOf('\n', s - 1) + 1;
    let blockEnd = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
    if (blockEnd === -1) blockEnd = v.length;
    return { blockStart, blockEnd, s, e };
  }

  function transformLines(fn) {
    const { blockStart, blockEnd, s, e } = lineBlock();
    const lines = ta.value.slice(blockStart, blockEnd).split('\n');
    const next = lines.map(fn);
    const firstDelta = next[0].length - lines[0].length;
    const totalDelta = next.join('\n').length - lines.join('\n').length;
    replaceRange(blockStart, blockEnd, next.join('\n'));
    ta.setSelectionRange(Math.max(blockStart, s + firstDelta), e + totalDelta);
  }

  function indent(outdent) {
    const { s, e } = lineBlock();
    if (!outdent && s === e) {
      replaceRange(s, e, INDENT);
      return;
    }
    transformLines((line) => (outdent ? line.replace(/^( {1,2}|\t)/, '') : INDENT + line));
  }

  function toggleComment() {
    const { blockStart, blockEnd } = lineBlock();
    const lines = ta.value.slice(blockStart, blockEnd).split('\n');
    const allCommented = lines.filter((l) => l.trim()).every((l) => /^\s*\/\//.test(l));
    transformLines((line) => {
      if (!line.trim()) return line;
      return allCommented ? line.replace(/^(\s*)\/\/ ?/, '$1') : line.replace(/^(\s*)/, '$1// ');
    });
  }

  // Returns true when the key was handled as bracket/quote pairing.
  function pairKey(event) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const v = ta.value;
    const key = event.key;

    if (key === 'Backspace' && s === e && PAIRS[v[s - 1]] === v[s]) {
      replaceRange(s - 1, s + 1, '');
      return true;
    }
    if (CLOSERS.has(key) && s === e && v[s] === key) {
      ta.setSelectionRange(s + 1, s + 1);
      return true;
    }
    if (!PAIRS[key]) return false;

    const close = PAIRS[key];
    if (s !== e) {
      replaceRange(s, e, key + v.slice(s, e) + close);
      ta.setSelectionRange(s + 1, e + 1);
      return true;
    }
    const quote = key === close;
    if (quote && /[\w$]/.test(v[s - 1] || '')) return false;
    replaceRange(s, s, key + close);
    ta.setSelectionRange(s + 1, s + 1);
    return true;
  }

  function newline() {
    const v = ta.value;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const lead = /^[ \t]*/.exec(v.slice(lineStart, s))[0];
    const opener = '{[('.includes(v[s - 1] || ' ') && v[s - 1] !== ' ';
    const closer = '}])'.includes(v[e] || ' ') && v[e] !== ' ';
    let insert = `\n${lead}${opener ? INDENT : ''}`;
    const caret = s + insert.length;
    if (opener && closer) insert += `\n${lead}`;
    replaceRange(s, e, insert);
    ta.setSelectionRange(caret, caret);
  }

  // --- Find and replace ---
  function pattern() {
    const q = findInput.value;
    if (!q) return null;
    return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase.checked ? 'g' : 'gi');
  }

  function countMatches() {
    const re = pattern();
    findCount.textContent = re ? `${(ta.value.match(re) || []).length} found` : '';
  }

  function revealLine(index) {
    const line = ta.value.slice(0, index).split('\n').length - 1;
    ta.scrollTop = Math.max(0, line * LINE_HEIGHT - ta.clientHeight / 2);
    syncScroll();
  }

  function findNext(backwards = false) {
    const re = pattern();
    if (!re) return;
    const matches = [...ta.value.matchAll(re)];
    if (!matches.length) {
      findCount.textContent = 'No matches';
      return;
    }
    const from = backwards ? ta.selectionStart : ta.selectionEnd;
    const hit = backwards
      ? [...matches].reverse().find((m) => m.index < from) || matches[matches.length - 1]
      : matches.find((m) => m.index >= from) || matches[0];
    ta.setSelectionRange(hit.index, hit.index + hit[0].length);
    revealLine(hit.index);
    findCount.textContent = `${matches.length} found`;
  }

  function replaceOne() {
    const re = pattern();
    if (!re) return;
    const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (selected && new RegExp(`^${re.source}$`, re.flags.replace('g', '')).test(selected)) {
      replaceRange(ta.selectionStart, ta.selectionEnd, replaceInput.value);
    }
    findNext();
  }

  function replaceAll() {
    const re = pattern();
    if (!re) return;
    const next = ta.value.replace(re, () => replaceInput.value);
    if (next === ta.value) return;
    replaceRange(0, ta.value.length, next);
    countMatches();
  }

  function showFind(open) {
    findBar.hidden = !open;
    if (open) {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel && !sel.includes('\n')) findInput.value = sel;
      findInput.focus();
      findInput.select();
      countMatches();
    } else {
      ta.focus();
    }
  }

  // --- Actions ---
  async function apply({ save = false } = {}) {
    const syntax = checkSyntax(ta.value);
    if (syntax && !window.confirm(`Syntax problem on line ${syntax.line}: ${syntax.message}\n\nApply anyway?`)) {
      goToLine(syntax.line);
      return false;
    }
    if (save && tools.isProd?.() && !window.confirm('This is a PRODUCTION instance. Apply this change and save the record?')) {
      return false;
    }
    try {
      await callPage('setFieldValue', [field.name, ta.value]);
      baseline = ta.value;
      refresh();
      if (save) {
        await callPage('saveForm');
        toast.success('Applied and saved.');
      } else {
        toast.success('Applied to the form. Save the record to keep it.');
      }
      return true;
    } catch (err) {
      toast.error(err.message || String(err));
      return false;
    }
  }

  function showPanel(text) {
    lintBox.textContent = text;
    lintBox.hidden = false;
  }

  function runLint() {
    const syntax = checkSyntax(ta.value);
    const head = syntax ? `Syntax error on line ${syntax.line}: ${syntax.message}\n\n` : '';
    showPanel(head + formatLintFindings(lintScript(ta.value, { table })));
  }

  function selectedText() {
    return ta.value.slice(ta.selectionStart, ta.selectionEnd);
  }

  async function run(dryRun) {
    const part = selectedText().trim();
    const script = part || ta.value;
    if (!script.trim()) return;
    const syntax = checkSyntax(script);
    if (syntax && !window.confirm(`Syntax problem on line ${syntax.line}: ${syntax.message}\n\nRun anyway?`)) return;
    if (!dryRun) {
      let message = `Run ${part ? 'the selected code' : 'this script'} on ${window.location.hostname}?`;
      const risk = analyzeScriptRisk(script);
      if (risk.hasWrites) message += `\n\n${formatRiskSummary(risk)}`;
      if (tools.isProd?.()) message = `PRODUCTION instance.\n\n${message}`;
      if (!window.confirm(message)) return;
    }
    showPanel(dryRun ? 'Dry run in progress...' : 'Running...');
    try {
      const output = await tools.runScript(script, { dryRun });
      showPanel(`${dryRun ? '[Dry run] ' : ''}${part ? 'Selection' : 'Script'} output:\n\n${output || '(no output)'}`);
    } catch (err) {
      showPanel(`Run failed: ${err.message || err}`);
    }
  }

  function askAi(kind) {
    const part = selectedText().trim();
    let code = part || ta.value;
    if (!code.trim()) return;
    const truncated = code.length > MAX_AI_CHARS;
    if (truncated) code = code.slice(0, MAX_AI_CHARS);
    const known = problemItems.filter((p) => p.level === 'error' || p.level === 'high').slice(0, 8);
    const knownText =
      kind === 'fix' && known.length ? `\n\nProblems already detected:\n${known.map((p) => `- line ${p.line}: ${p.message}`).join('\n')}` : '';
    const prompt =
      `${AI_INSTRUCTIONS[kind]}\n\nSource: ${table || 'unknown table'}, field "${field.name}"${part ? ' (selected part only)' : ''}.` +
      `${knownText}\n\n\`\`\`javascript\n${code}\n\`\`\`${truncated ? '\n(Script truncated for length.)' : ''}`;
    const label = AI_ACTIONS.find(([k]) => k === kind)?.[1] || 'Ask AI';
    tools.askAi(label, prompt);
    overlay.hidden = true;
    toast.success('The answer is in the chat sidebar. Press Alt+Shift+E to come back to the editor.');
  }

  function openCompare() {
    if (isDirty()) toast.success('Compare uses the record as it is on the form. Apply your changes first to include them.');
    tools.openCompare();
    overlay.hidden = true;
  }

  async function goToDefinition() {
    const v = ta.value;
    let s = ta.selectionStart;
    let e = s;
    while (s > 0 && /[\w$]/.test(v[s - 1])) s -= 1;
    while (e < v.length && /[\w$]/.test(v[e])) e += 1;
    const word = v.slice(s, e);
    if (!/^[A-Za-z_]\w{1,80}$/.test(word)) {
      toast.error('Put the caret on a name first.');
      return;
    }
    const local = new RegExp(`(?:function\\s+${word}\\b|\\b(?:var|let|const)\\s+${word}\\b|\\b${word}\\s*:\\s*function)`).exec(v);
    if (local && (local.index < s || local.index >= e)) {
      goToLine(v.slice(0, local.index).split('\n').length);
      return;
    }
    if (!tools.findDefinition) return;
    try {
      const url = await tools.findDefinition(word);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      else toast.error(`No definition found for "${word}".`);
    } catch (err) {
      toast.error(err.message || String(err));
    }
  }

  async function updateChip() {
    if (!tools.getUpdateSet) return;
    try {
      const us = await tools.getUpdateSet();
      chip.hidden = !us;
      if (us) {
        chip.textContent = `Update set: ${us.name}`;
        chip.classList.toggle('msb-ed__chip--warn', /default/i.test(us.name));
        chip.title = /default/i.test(us.name) ? 'Changes will land in the Default update set' : 'Current update set';
      }
    } catch {
      chip.hidden = true;
    }
  }

  function close() {
    if (isDirty() && !window.confirm('Discard changes that have not been applied to the form?')) return;
    clearTimeout(lintTimer);
    overlay.remove();
  }

  async function loadField(name) {
    const state = await callPage('getFieldState', [name]);
    field = fields.find((f) => f.name === name) || field;
    baseline = String(state?.value ?? '');
    ta.value = baseline;
    ta.readOnly = !!state?.readOnly;
    title.textContent = `${table ? `${table} \u00b7 ` : ''}${field.label || field.name}${state?.readOnly ? ' (read-only)' : ''}`;
    ta.scrollTop = 0;
    ta.scrollLeft = 0;
    refresh();
    syncScroll();
  }

  actions.append(
    button('Find', 'msb-ed__btn', () => showFind(findBar.hidden)),
    button('Lint', 'msb-ed__btn', runLint)
  );
  if (tools.runScript) {
    const dry = button('Dry run', 'msb-ed__btn', () => run(true));
    dry.title = 'Run the script (or the selection) with writes intercepted';
    const live = button('Run', 'msb-ed__btn', () => run(false));
    live.title = 'Run the script (or the selection) as a background script';
    actions.append(dry, live);
  }
  if (tools.askAi) {
    const ai = document.createElement('select');
    ai.className = 'msb-ed__select';
    ai.setAttribute('aria-label', 'Ask AI about this script');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Ask AI...';
    ai.appendChild(placeholder);
    AI_ACTIONS.forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      ai.appendChild(opt);
    });
    ai.addEventListener('change', () => {
      const kind = ai.value;
      ai.value = '';
      if (kind) askAi(kind);
    });
    actions.appendChild(ai);
  }
  if (tools.openCompare) actions.append(button('Compare', 'msb-ed__btn', openCompare));
  actions.append(
    button('Apply to form', 'msb-ed__btn msb-ed__btn--primary', () => apply()),
    button('Apply & save', 'msb-ed__btn', () => apply({ save: true })),
    button('Close', 'msb-ed__btn', close)
  );
  findBar.append(
    findInput,
    replaceInput,
    matchCase,
    matchCaseLabel,
    button('Prev', 'msb-ed__btn', () => findNext(true)),
    button('Next', 'msb-ed__btn', () => findNext(false)),
    button('Replace', 'msb-ed__btn', replaceOne),
    button('All', 'msb-ed__btn', replaceAll),
    findCount
  );

  fieldSelect.addEventListener('change', async () => {
    if (isDirty() && !window.confirm('Switch field and discard changes that have not been applied?')) {
      fieldSelect.value = field.name;
      return;
    }
    await loadField(fieldSelect.value);
  });

  let frame = 0;
  ta.addEventListener('input', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      refresh();
      syncScroll();
      if (!findBar.hidden) countMatches();
    });
  });
  ta.addEventListener('scroll', syncScroll);
  ['keyup', 'click', 'focus'].forEach((type) => ta.addEventListener(type, updatePosition));
  ta.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey) goToDefinition();
  });

  ta.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.key === 'Tab') {
      event.preventDefault();
      const snippet = !event.shiftKey && !ta.readOnly && ta.selectionStart === ta.selectionEnd ? expandSnippet(ta.value, ta.selectionStart) : null;
      if (snippet) {
        replaceRange(snippet.start, snippet.end, snippet.text);
        ta.setSelectionRange(snippet.caret, snippet.caret);
      } else {
        indent(event.shiftKey);
      }
    } else if (event.key === 'F12') {
      event.preventDefault();
      goToDefinition();
    } else if (event.key === 'Enter' && !mod && !event.altKey && !event.shiftKey && !ta.readOnly) {
      event.preventDefault();
      newline();
    } else if (mod && event.key === '/') {
      event.preventDefault();
      toggleComment();
    } else if (mod && key === 's') {
      event.preventDefault();
      apply({ save: event.shiftKey });
    } else if (mod && event.key === 'Enter') {
      event.preventDefault();
      apply().then((ok) => {
        if (ok && !isDirty()) overlay.remove();
      });
    } else if (mod && key === 'f') {
      event.preventDefault();
      showFind(true);
    } else if (!mod && !event.altKey && !ta.readOnly && pairKey(event)) {
      event.preventDefault();
    }
  });

  findInput.addEventListener('input', countMatches);
  matchCase.addEventListener('change', countMatches);
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      findNext(event.shiftKey);
    }
  });

  overlay.addEventListener('keydown', (event) => {
    // The page has its own shortcuts; keep keystrokes inside the editor.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!findBar.hidden) showFind(false);
      else close();
    }
  });

  overlay.addEventListener('msb-show', () => {
    if (!isDirty()) loadField(field.name).catch(() => {});
    updateChip();
    requestAnimationFrame(() => ta.focus());
  });

  dialog.append(header, findBar, body, lintBox, footer);
  overlay.appendChild(dialog);
  shadow.appendChild(overlay);

  await loadField(field.name);
  updateChip();
  requestAnimationFrame(() => ta.focus());
}
