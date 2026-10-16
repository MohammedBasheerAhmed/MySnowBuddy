// Full-screen script editor for the script field on the open form: syntax highlighting, line
// numbers, context-aware completion, hover docs, parameter hints, live problems with quick
// fixes, find and replace, go to line / definition and line editing commands. It only changes
// the form field (it saves the record only on "Apply & save") and is built from DOM nodes,
// with no innerHTML. Every edit goes through execCommand('insertText') so native undo works.

import { callPage } from './pageBridge.js';
import { trustedDom } from '../sidebar/trusted.js';
import { verifyScript, formatVerification, KIND_INFO } from '../lib/verify.js';
import { checkSyntax } from '../lib/syntax.js';
import { expandSnippet, SNIPPETS } from '../lib/snippets.js';
import { analyzeScriptRisk, formatRiskSummary } from '../lib/scriptSafety.js';
import {
  analyze,
  lineTokens,
  lineOfOffset,
  lineEndAt,
  rangeAt,
  matchBracket,
  toggleLineComment,
  indentLines,
  outdentLines,
  insertIndent,
  moveLines,
  duplicateLines,
  deleteLines,
  newlineAndIndent,
  closeBracketOutdent,
  smartHome,
  offsetOf,
  parseLineInput,
  visualColumn,
  offsetAtVisualColumn,
  detectIndentUnit,
  buildSearchRegex,
  findAll,
  replacementAt,
  replaceAllMatches,
  reindent,
  diffRange,
} from '../lib/editorText.js';
import { getCompletions, applyCompletion, getHoverInfo, getSignatureHelp, getDefinitionTarget, collectNeeds, guessSide } from '../lib/completion.js';
import { diagnose, countProblems, quickFixEdit, editorKind, sideOfKind } from '../lib/editorDiagnostics.js';
import {
  ensureEditorData,
  missingEditorData,
  editorDataContext,
  editorDataBusy,
  loadedFieldNames,
  prefetchFields,
  readScriptRecord,
  fetchCatalogVariables,
  definitionUrl,
} from './editorData.js';

const INDENT = '  ';
const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
const CLOSERS = new Set([')', ']', '}']);
const LINE_HEIGHT = 20;
const TOP_PAD = 10;
const LEFT_PAD = 12;
const TAB_SIZE = 2;
const OVERSCAN = 40;
const MAX_LINT_CHARS = 200000;
const MAX_AI_CHARS = 30000;
const MAX_FIND_MATCHES = 5000;
const MAX_FIND_BOXES = 800;
const MAX_MARKS = 200;
const MAX_SUGGESTIONS = 60;
const QUICK_CHECK_CHARS = 40000;
const SLOW_CHECK_MS = 350;
const HOVER_DELAY = 400;
const DATA_DELAY = 150;
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
const KIND_ICON = { method: 'm', property: 'p', field: 'f', table: 't', class: 'C', global: 'g', variable: 'v', function: 'F', snippet: 's', scriptInclude: 'S', propertyName: '#', role: 'r', keyword: 'k' };
const SHORTCUTS = [
  ['Ctrl+Space', 'Suggestions: methods, fields, tables, Script Includes, properties, snippets'],
  ['Enter or Tab', 'Accept a suggestion (Esc closes the list)'],
  ['Ctrl+Shift+Space', 'Parameter hints'],
  ['F12 or Ctrl+click', 'Go to definition: Script Include, table, field, local function'],
  ['Ctrl+.', 'Quick fix for the problem on this line'],
  ['F8 / Shift+F8', 'Next / previous problem'],
  ['Ctrl+Shift+M', 'Show or hide the problems list'],
  ['Ctrl+F / Ctrl+H', 'Find / replace (regex, match case, whole word)'],
  ['F3 / Shift+F3', 'Find next / previous'],
  ['Ctrl+G', 'Go to line (line or line:column)'],
  ['Ctrl+/', 'Comment or uncomment lines'],
  ['Alt+Up / Alt+Down', 'Move lines up / down'],
  ['Shift+Alt+Up / Down', 'Duplicate lines'],
  ['Ctrl+Shift+K', 'Delete lines'],
  ['Tab / Shift+Tab', 'Indent / outdent'],
  ['Ctrl+] / Ctrl+[', 'Indent / outdent lines'],
  ['Tab after a snippet name', `Expand it: ${Object.keys(SNIPPETS).join(', ')}`],
  ['Shift+Alt+F', 'Re-indent the whole script (whitespace only)'],
  ['Home', 'First character of the line, then column 1'],
  ['Ctrl+S', 'Apply to the form'],
  ['Ctrl+Shift+S', 'Apply and save the record'],
  ['Ctrl+Enter', 'Apply and close'],
  ['F1', 'This list'],
  ['Esc', 'Close a popup, then the editor'],
];

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

function toggleButton(label, title) {
  const node = h('button', 'msb-ed__toggle', label);
  node.type = 'button';
  node.title = title;
  node.setAttribute('aria-label', title);
  node.setAttribute('aria-pressed', 'false');
  node.addEventListener('click', () => node.setAttribute('aria-pressed', node.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'));
  return node;
}

const pressed = (node) => node.getAttribute('aria-pressed') === 'true';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
  const recordPromise = readScriptRecord(table).catch(() => null);

  let field = bestScriptField(fields);
  let baseline = '';
  let unit = INDENT;
  let rec = { target: '', uiActionClient: null, when: '', clientType: '', scoped: null, catItem: '', variableSet: '' };
  let kind = editorKind(table, {});
  let side = sideOfKind(kind) || 'server';
  let formFields = null;

  const overlay = h('div', 'msb-ed');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Script editor');
  const dialog = h('div', 'msb-ed__dialog');

  // --- Header ---
  const header = h('div', 'msb-ed__header');
  const title = h('div', 'msb-ed__title', table || 'Script');
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
  const kindChip = h('span', 'msb-ed__chip');
  const chip = h('span', 'msb-ed__chip');
  chip.hidden = true;
  const status = h('span', 'msb-ed__status');
  const actions = h('div', 'msb-ed__actions');
  header.append(title, fieldSelect, kindChip, chip, status, actions);

  // --- Find bar ---
  const findBar = h('div', 'msb-ed__find');
  findBar.hidden = true;
  const findInput = document.createElement('input');
  findInput.placeholder = 'Find';
  findInput.setAttribute('aria-label', 'Find');
  const replaceInput = document.createElement('input');
  replaceInput.placeholder = 'Replace with';
  replaceInput.setAttribute('aria-label', 'Replace with');
  const caseToggle = toggleButton('Aa', 'Match case');
  const wordToggle = toggleButton('W', 'Whole word');
  const regexToggle = toggleButton('.*', 'Regular expression');
  const findCount = h('span', 'msb-ed__count');
  findCount.setAttribute('aria-live', 'polite');

  // --- Go to line bar ---
  const gotoBar = h('div', 'msb-ed__goto');
  gotoBar.hidden = true;
  const gotoInput = document.createElement('input');
  gotoInput.placeholder = 'Line or line:col';
  gotoInput.setAttribute('aria-label', 'Go to line');
  const gotoHint = h('span', null, '');

  // --- Editor surface ---
  const body = h('div', 'msb-ed__body');
  const gutter = h('div', 'msb-ed__gutter');
  const gutterInner = h('pre', 'msb-ed__gutter-inner');
  const marks = h('div', 'msb-ed__marks');
  gutter.append(gutterInner, marks);
  const surface = h('div', 'msb-ed__surface');
  const hl = h('div', 'msb-ed__hl');
  const bands = h('div', 'msb-ed__bands');
  const deco = h('div', 'msb-ed__deco');
  const findLayer = h('div');
  const bracketLayer = h('div');
  const squiggleLayer = h('div');
  deco.append(findLayer, bracketLayer, squiggleLayer);
  const code = h('pre', 'msb-ed__code');
  hl.append(bands, deco, code);
  const ta = document.createElement('textarea');
  ta.className = 'msb-ed__input';
  ta.wrap = 'off';
  ta.spellcheck = false;
  ta.autocapitalize = 'off';
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('aria-label', 'Script');
  const measure = h('span', 'msb-ed__measure', 'x'.repeat(100));
  const acBox = h('div', 'msb-ed__ac');
  acBox.hidden = true;
  const acList = h('div', 'msb-ed__ac-list');
  acList.id = 'msb-ed-ac-list';
  acList.setAttribute('role', 'listbox');
  acList.setAttribute('aria-label', 'Suggestions');
  const acDoc = h('div', 'msb-ed__ac-doc');
  acBox.append(acList, acDoc);
  // Clicks in the list (rows, scrollbar) must not take the focus from the editor.
  acBox.addEventListener('mousedown', (event) => event.preventDefault());
  const sigBox = h('div', 'msb-ed__sig');
  sigBox.hidden = true;
  sigBox.setAttribute('role', 'status');
  const hoverBox = h('div', 'msb-ed__hover');
  hoverBox.hidden = true;
  hoverBox.setAttribute('role', 'tooltip');
  surface.append(hl, ta, measure, sigBox, hoverBox, acBox);
  body.append(gutter, surface);

  const problemList = h('div', 'msb-ed__plist');
  problemList.hidden = true;
  problemList.setAttribute('aria-label', 'Problems');
  const lintBox = h('pre', 'msb-ed__lint');
  lintBox.hidden = true;

  const footer = h('div', 'msb-ed__footer');
  const position = h('span', null, 'Ln 1, Col 1');
  const problemsButton = button('', 'msb-ed__problems', () => toggleProblems());
  problemsButton.title = 'Show problems (Ctrl+Shift+M)';
  const hints = h('span', 'msb-ed__hints', 'Ctrl+Space suggestions · F12 definition · Ctrl+S apply · F1 all shortcuts · Esc close');
  footer.append(position, problemsButton, hints);

  // --- Shortcut help ---
  const help = h('div', 'msb-ed__help');
  help.hidden = true;
  help.setAttribute('role', 'dialog');
  help.setAttribute('aria-label', 'Keyboard shortcuts');
  const helpHead = h('div', 'msb-ed__help-head', 'Keyboard shortcuts');
  const helpClose = button('Close', 'msb-ed__btn', () => toggleHelp(false));
  helpHead.appendChild(helpClose);
  const helpList = h('dl', 'msb-ed__help-list');
  SHORTCUTS.forEach(([keys, what]) => helpList.append(h('dt', null, keys), h('dd', null, what)));
  help.append(helpHead, helpList);

  // --- State ---
  let charWidth = 7.8;
  let renderedFirst = 0;
  let renderedLast = -1;
  let paintedText = null;
  let paintedLines = 0;
  let composing = false;
  let programmatic = 0;
  let problems = [];
  let diagText = null;
  let diagWasFull = false;
  let problemsLineCount = 0;
  let quickMode = false;
  let fullCheckMs = 0;
  let diagTimer = 0;
  let findMatches = [];
  let findTimer = 0;
  let hoverTimer = 0;
  let hoverAt = -1;
  let dataTimer = 0;
  let frame = 0;
  const ac = { open: false, explicit: false, result: null, active: 0, loading: false };

  const isDirty = () => ta.value !== baseline;
  const intelCtx = () => ({ side, table: rec.target || null, scoped: rec.scoped, formFields, ...editorDataContext() });

  // --- Geometry ---
  function measureChar() {
    const width = measure.getBoundingClientRect().width / 100;
    if (width > 2 && width < 40) charWidth = width;
  }

  function caretPoint(offset) {
    const text = ta.value;
    const info = analyze(text);
    const line = lineOfOffset(info.starts, offset);
    return {
      x: LEFT_PAD + visualColumn(text, offset, TAB_SIZE) * charWidth - ta.scrollLeft,
      y: TOP_PAD + line * LINE_HEIGHT - ta.scrollTop,
      line,
    };
  }

  /** Offset of the character under a mouse point, or -1 when the point is past the line. */
  function offsetAtPoint(clientX, clientY) {
    const rect = ta.getBoundingClientRect();
    const text = ta.value;
    const info = analyze(text);
    const line = Math.floor((clientY - rect.top + ta.scrollTop - TOP_PAD) / LINE_HEIGHT);
    if (line < 0 || line >= info.starts.length) return -1;
    const x = clientX - rect.left + ta.scrollLeft - LEFT_PAD;
    if (x < 0) return -1;
    const col = Math.floor(x / charWidth);
    const start = info.starts[line];
    const end = line + 1 < info.starts.length ? info.starts[line + 1] - 1 : text.length;
    const offset = offsetAtVisualColumn(text, start, col, TAB_SIZE);
    return offset >= end ? -1 : offset;
  }

  function placeBox(box, point, { below = true } = {}) {
    const maxX = surface.clientWidth - box.offsetWidth - 8;
    box.style.left = `${Math.max(4, Math.min(point.x, maxX))}px`;
    const room = surface.clientHeight;
    const underTop = point.y + LINE_HEIGHT + 2;
    const overTop = point.y - box.offsetHeight - 2;
    const fitsUnder = underTop + box.offsetHeight <= room;
    const top = below ? (fitsUnder || overTop < 0 ? underTop : overTop) : overTop >= 0 ? overTop : underTop;
    box.style.top = `${Math.max(0, top)}px`;
  }

  // --- Painting (only the lines on screen, plus a margin) ---
  function paint(force = false) {
    const text = ta.value;
    const info = analyze(text);
    const lines = info.starts.length;
    const top = ta.scrollTop;
    const height = ta.clientHeight || 600;
    const firstVisible = Math.max(0, Math.floor((top - TOP_PAD) / LINE_HEIGHT));
    const lastVisible = Math.min(lines - 1, Math.ceil((top + height) / LINE_HEIGHT));
    const windowMoved = firstVisible < renderedFirst || lastVisible > renderedLast;
    if (force || text !== paintedText || windowMoved) {
      renderedFirst = Math.max(0, firstVisible - OVERSCAN);
      renderedLast = Math.min(lines - 1, lastVisible + OVERSCAN);
      const frag = document.createDocumentFragment();
      for (let li = renderedFirst; li <= renderedLast; li += 1) {
        lineTokens(info, li).forEach(([cls, value]) => frag.appendChild(cls ? h('span', `msb-ed__t-${cls}`, value) : document.createTextNode(value)));
        frag.appendChild(document.createTextNode('\n'));
      }
      code.replaceChildren(frag);
      paintedText = text;
      if (lines !== paintedLines) {
        paintedLines = lines;
        gutterInner.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
      }
      paintFind();
    }
    syncScroll();
  }

  function syncScroll() {
    const x = -ta.scrollLeft;
    const y = -ta.scrollTop;
    code.style.transform = `translate(${x}px, ${renderedFirst * LINE_HEIGHT + y}px)`;
    deco.style.transform = `translate(${x}px, ${y}px)`;
    gutterInner.style.transform = `translateY(${y}px)`;
    marks.style.transform = `translateY(${y}px)`;
    bands.style.transform = `translateY(${y}px)`;
  }

  function box(className, line, startOffset, endOffset) {
    const text = ta.value;
    const node = h('div', className);
    const startCol = visualColumn(text, startOffset, TAB_SIZE);
    const endCol = Math.max(startCol + 1, visualColumn(text, endOffset, TAB_SIZE));
    node.style.left = `${LEFT_PAD + startCol * charWidth}px`;
    node.style.width = `${(endCol - startCol) * charWidth}px`;
    node.style.top = `${TOP_PAD + line * LINE_HEIGHT}px`;
    return node;
  }

  function paintBrackets() {
    bracketLayer.replaceChildren();
    if (ta.selectionStart !== ta.selectionEnd || ta.value.length > MAX_LINT_CHARS) return;
    const hit = matchBracket(ta.value, ta.selectionStart);
    if (!hit) return;
    const info = analyze(ta.value);
    const cls = hit.match === -1 ? 'msb-ed__bracket msb-ed__bracket--bad' : 'msb-ed__bracket';
    [hit.at, hit.match].filter((p) => p >= 0).forEach((p) => bracketLayer.appendChild(box(cls, lineOfOffset(info.starts, p), p, p + 1)));
  }

  function paintSquiggles() {
    squiggleLayer.replaceChildren();
    const info = analyze(ta.value);
    problems.slice(0, MAX_MARKS).forEach((p) => {
      if (p.startCol == null || p.line > info.starts.length) return;
      const start = info.starts[p.line - 1];
      const node = box(`msb-ed__squiggle msb-ed__squiggle--${p.severity}`, p.line - 1, start + p.startCol, start + p.endCol);
      node.style.top = `${TOP_PAD + p.line * LINE_HEIGHT - 4}px`;
      squiggleLayer.appendChild(node);
    });
  }

  function paintFind() {
    findLayer.replaceChildren();
    if (findBar.hidden || !findMatches.length) return;
    const info = analyze(ta.value);
    const from = info.starts[renderedFirst] ?? 0;
    const to = renderedLast + 1 < info.starts.length ? info.starts[renderedLast + 1] : ta.value.length;
    let drawn = 0;
    for (const m of findMatches) {
      if (m.index + m.length < from) continue;
      if (m.index > to || drawn >= MAX_FIND_BOXES) break;
      const line = lineOfOffset(info.starts, m.index);
      const lineEnd = line + 1 < info.starts.length ? info.starts[line + 1] - 1 : ta.value.length;
      const current = m.index === ta.selectionStart && m.index + m.length === ta.selectionEnd;
      findLayer.appendChild(box(`msb-ed__match${current ? ' msb-ed__match--current' : ''}`, line, m.index, Math.min(m.index + m.length, lineEnd)));
      drawn += 1;
    }
  }

  function refresh() {
    paint();
    // Lines were added or removed since the last check: the markers would sit on the wrong lines
    // until the next check (a moment later), so hide them meanwhile.
    if (problems.length && analyze(ta.value).starts.length !== problemsLineCount) {
      marks.replaceChildren();
      bands.replaceChildren();
      squiggleLayer.replaceChildren();
    }
    updatePosition();
    status.textContent = isDirty() ? 'Modified' : 'No changes';
    status.classList.toggle('msb-ed__status--dirty', isDirty());
    paintBrackets();
    scheduleDiagnostics();
    if (!findBar.hidden) scheduleFind();
  }

  let charsLabel = ['', 0];
  function updatePosition() {
    const info = analyze(ta.value);
    const caret = ta.selectionStart;
    const line = lineOfOffset(info.starts, caret);
    const sel = ta.selectionEnd - ta.selectionStart;
    if (charsLabel[1] !== ta.value.length || !charsLabel[0]) charsLabel = [ta.value.length.toLocaleString(), ta.value.length];
    position.textContent = `Ln ${line + 1}, Col ${caret - info.starts[line] + 1}${sel ? ` (${sel} selected)` : ''} · ${charsLabel[0]} chars`;
  }

  // --- Problems (verifier + lint + syntax), debounced ---
  function scheduleDiagnostics() {
    clearTimeout(diagTimer);
    diagTimer = setTimeout(runDiagnostics, ta.value.length > 60000 ? 1200 : 500);
  }

  // The full check (lint + structure + fields) can take a second on a very large script, so while
  // typing such a script only the quick checks run; the full one runs on request.
  function runDiagnostics({ full = false } = {}) {
    const text = ta.value;
    const quick = !full && (text.length > QUICK_CHECK_CHARS || fullCheckMs > SLOW_CHECK_MS);
    if (text === diagText && (diagWasFull || quick)) {
      if (!marks.childNodes.length && problems.length) renderProblems(); // markers were hidden while lines moved
      return;
    }
    if (text.length > MAX_LINT_CHARS) {
      const syntax = checkSyntax(text);
      problems = syntax ? [{ line: syntax.line, startCol: null, endCol: null, severity: 'error', message: `Syntax: ${syntax.message}`, suggestion: '', ruleId: 'syntax-error', fix: null }] : [];
    } else {
      const started = performance.now();
      try {
        problems = diagnose(text, { kind, when: rec.when, clientType: rec.clientType, scoped: rec.scoped === true, table: rec.target, fields: loadedFieldNames(rec.target), quick });
      } catch {
        problems = [];
      }
      if (!quick) fullCheckMs = performance.now() - started;
    }
    diagText = text;
    diagWasFull = !quick && text.length <= MAX_LINT_CHARS;
    quickMode = quick || text.length > MAX_LINT_CHARS;
    renderProblems();
  }

  function renderProblems() {
    problemsLineCount = analyze(ta.value).starts.length;
    marks.replaceChildren();
    bands.replaceChildren();
    const seenLines = new Set();
    problems.slice(0, MAX_MARKS).forEach((p) => {
      const top = `${TOP_PAD + (p.line - 1) * LINE_HEIGHT}px`;
      const mark = h('span', `msb-ed__mark msb-ed__mark--${p.severity}`);
      mark.style.top = top;
      mark.title = p.message;
      marks.appendChild(mark);
      if (p.startCol == null && !seenLines.has(p.line)) {
        seenLines.add(p.line);
        const band = h('div', `msb-ed__band msb-ed__band--${p.severity}`);
        band.style.top = top;
        bands.appendChild(band);
      }
    });
    paintSquiggles();
    const counts = countProblems(problems);
    const parts = [];
    if (counts.error) parts.push(plural(counts.error, 'error'));
    if (counts.warning) parts.push(plural(counts.warning, 'warning'));
    if (counts.info) parts.push(plural(counts.info, 'note'));
    problemsButton.textContent = `${parts.length ? parts.join(', ') : 'No problems'}${quickMode ? ' (quick check)' : ''}`;
    problemsButton.title = quickMode
      ? 'Large script: only the syntax and API checks run while you type. Open the list to run the full check.'
      : 'Show problems (Ctrl+Shift+M)';
    problemsButton.classList.toggle('msb-ed__problems--error', counts.error > 0);
    problemsButton.classList.toggle('msb-ed__problems--ok', !parts.length);
    if (!problemList.hidden) renderProblemList();
  }

  function renderProblemList() {
    problemList.replaceChildren();
    if (quickMode && ta.value.length <= MAX_LINT_CHARS) {
      const row = h('div', 'msb-ed__pempty', 'Large script: only the syntax and API checks run while you type. ');
      row.appendChild(
        button('Run the full check', 'msb-ed__pfix', () => {
          runDiagnostics({ full: true });
          renderProblemList();
        })
      );
      problemList.appendChild(row);
    }
    if (!problems.length) {
      problemList.appendChild(h('div', 'msb-ed__pempty', quickMode ? 'No problems found by the quick check.' : 'No problems found by the syntax, lint, API catalog and field checks.'));
      return;
    }
    problems.slice(0, MAX_MARKS).forEach((p) => {
      const row = h('div', 'msb-ed__prow');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      const dot = h('span', `msb-ed__pdot msb-ed__pdot--${p.severity}`);
      dot.title = p.severity;
      const msg = h('span', 'msb-ed__pmsg', p.suggestion ? `${p.message} — ${p.suggestion}` : p.message);
      const where = h('span', 'msb-ed__pline', `Ln ${p.line}`);
      row.append(dot, msg, where);
      if (p.fix && !ta.readOnly) {
        const fixButton = button(p.fix.title, 'msb-ed__pfix', (event) => {
          event.stopPropagation();
          applyQuickFix(p);
        });
        row.appendChild(fixButton);
      }
      const jump = () => goToLine(p.line, p.startCol == null ? null : p.startCol + 1);
      row.addEventListener('click', jump);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          jump();
        }
      });
      problemList.appendChild(row);
    });
  }

  function toggleProblems(open = problemList.hidden) {
    problemList.hidden = !open;
    if (open) {
      runDiagnostics();
      renderProblemList();
    }
  }

  function applyQuickFix(problem) {
    const edit = quickFixEdit(ta.value, problem);
    if (!edit) {
      toast.error('The code changed since this problem was found. Try again in a moment.');
      return;
    }
    replaceRange(edit.from, edit.to, edit.insert);
    ta.setSelectionRange(edit.from + edit.insert.length, edit.from + edit.insert.length);
    afterEdit();
  }

  function quickFixAtCaret() {
    runDiagnostics();
    const line = lineOfOffset(analyze(ta.value).starts, ta.selectionStart) + 1;
    const fixable = problems.filter((p) => p.line === line && p.fix);
    if (!fixable.length) {
      toast.error('No quick fix on this line.');
      return;
    }
    applyQuickFix(fixable[0]);
    toast.success(`${fixable[0].fix.title}.`);
  }

  function nextProblem(dir) {
    runDiagnostics();
    if (!problems.length) {
      toast.success('No problems found.');
      return;
    }
    const line = lineOfOffset(analyze(ta.value).starts, ta.selectionStart) + 1;
    const sorted = [...problems].sort((a, b) => a.line - b.line);
    const hit = dir > 0 ? sorted.find((p) => p.line > line) || sorted[0] : [...sorted].reverse().find((p) => p.line < line) || sorted[sorted.length - 1];
    goToLine(hit.line, hit.startCol == null ? null : hit.startCol + 1);
    toast.success(hit.message);
  }

  // --- Editing primitives ---
  // execCommand keeps the native undo stack; setRangeText is the fallback.
  function replaceRange(start, end, text) {
    ta.focus();
    ta.setSelectionRange(start, end);
    programmatic += 1;
    try {
      const ok = document.execCommand && document.execCommand('insertText', false, text);
      if (!ok) {
        ta.setRangeText(text, start, end, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } finally {
      programmatic -= 1;
    }
  }

  function applyEdit(edit) {
    if (!edit) return false;
    replaceRange(edit.from, edit.to, edit.insert);
    ta.setSelectionRange(edit.selStart, edit.selEnd);
    afterEdit();
    return true;
  }

  /** Replace the whole text with `next`, touching only the part that differs. */
  function replaceText(next, caret) {
    const d = diffRange(ta.value, next);
    if (!d) return;
    replaceRange(d.from, d.to, d.insert);
    if (caret !== undefined) ta.setSelectionRange(caret, caret);
    afterEdit();
  }

  function afterEdit() {
    closeCompletion();
    hideHover();
    updatePosition();
    revealCaret();
  }

  function revealCaret() {
    const p = caretPoint(ta.selectionEnd);
    if (p.y < 0) ta.scrollTop += p.y - LINE_HEIGHT;
    else if (p.y + LINE_HEIGHT * 2 > ta.clientHeight) ta.scrollTop += p.y + LINE_HEIGHT * 2 - ta.clientHeight;
    syncScroll();
  }

  function goToOffset(offset, end = offset, { focus = true } = {}) {
    if (focus) ta.focus();
    ta.setSelectionRange(offset, end);
    const line = lineOfOffset(analyze(ta.value).starts, offset);
    ta.scrollTop = Math.max(0, line * LINE_HEIGHT - ta.clientHeight / 2);
    paint();
    updatePosition();
    paintBrackets();
  }

  function goToLine(line, col = null) {
    goToOffset(offsetOf(ta.value, line, col || 1));
    if (col == null) {
      const start = ta.selectionStart;
      const lead = /^[ \t]*/.exec(ta.value.slice(start, start + 200))[0].length;
      ta.setSelectionRange(start + lead, start + lead);
    }
  }

  // Returns true when the key was handled as bracket/quote pairing.
  function pairKey(event) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const v = ta.value;
    const key = event.key;

    if (key === 'Backspace' && s === e && s > 0 && PAIRS[v[s - 1]] === v[s]) {
      replaceRange(s - 1, s + 1, '');
      afterTyping();
      return true;
    }
    if (CLOSERS.has(key) && s === e && v[s] === key) {
      ta.setSelectionRange(s + 1, s + 1);
      afterTyping();
      return true;
    }
    if (CLOSERS.has(key)) {
      const outdent = closeBracketOutdent(v, s, e, key);
      if (outdent) {
        applyEdit(outdent);
        afterTyping();
        return true;
      }
      return false;
    }
    // Typing a quote right before the same quote that auto-pairing inserted steps over it.
    if (PAIRS[key] === key && s === e && v[s] === key) {
      ta.setSelectionRange(s + 1, s + 1);
      afterTyping();
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
    // Inside a string or comment a quote is just a character.
    if (quote && rangeAt(analyze(v), s)) return false;
    // Do not pair in front of a word: typing ( before "foo" should not give "()foo".
    if (/[\w$]/.test(v[s] || '')) return false;
    replaceRange(s, s, key + close);
    ta.setSelectionRange(s + 1, s + 1);
    afterTyping(quote);
    return true;
  }

  /** After a programmatic keystroke: refresh hints, and complete inside a string that was just opened. */
  function afterTyping(openedQuote = false) {
    updatePosition();
    if (openedQuote) runCompletion(false);
    else if (ac.open) runCompletion(ac.explicit);
    updateSignature();
  }

  function tab(shift) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const text = ta.value;
    if (shift) return applyEdit(outdentLines(text, s, e, unit));
    if (s === e) {
      const snippet = expandSnippet(text, s);
      if (snippet) {
        replaceRange(snippet.start, snippet.end, snippet.text);
        ta.setSelectionRange(snippet.caret, snippet.caret);
        afterEdit();
        return true;
      }
      return applyEdit(insertIndent(text, s, unit));
    }
    return applyEdit(indentLines(text, s, e, unit));
  }

  function format() {
    const text = ta.value;
    const result = reindent(text, unit);
    if (result.error) {
      toast.error(result.error);
      return;
    }
    if (!result.changed) {
      toast.success('The indentation is already consistent.');
      return;
    }
    const info = analyze(text);
    const line = lineOfOffset(info.starts, ta.selectionStart);
    const oldLine = text.slice(info.starts[line], lineEndAt(text, info.starts[line]));
    const col = ta.selectionStart - info.starts[line];
    const nextLines = result.text.split('\n');
    const newLine = nextLines[line] || '';
    const delta = /^[ \t]*/.exec(newLine)[0].length - /^[ \t]*/.exec(oldLine)[0].length;
    let caret = nextLines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0) + Math.max(0, Math.min(newLine.length, col + delta));
    caret = Math.min(caret, result.text.length);
    replaceText(result.text, caret);
    toast.success('Re-indented (whitespace only).');
  }

  // --- Completion popup ---
  function closeCompletion() {
    if (!ac.open && acBox.hidden) return;
    ac.open = false;
    ac.result = null;
    acBox.hidden = true;
    acList.replaceChildren();
    ta.removeAttribute('aria-activedescendant');
    ta.setAttribute('aria-expanded', 'false');
  }

  function requestData(needs, onArrive) {
    clearTimeout(dataTimer);
    ac.loading = needs.length > 0;
    if (!needs.length) return;
    dataTimer = setTimeout(() => {
      ensureEditorData(needs).then((changed) => {
        ac.loading = false;
        if (changed) onArrive();
        else if (ac.open && !ac.result?.items.length) {
          if (ac.explicit) renderCompletion();
          else closeCompletion();
        }
      });
    }, DATA_DELAY);
  }

  function runCompletion(explicit) {
    if (composing || ta.readOnly || ta.selectionStart !== ta.selectionEnd) {
      closeCompletion();
      return;
    }
    let result = null;
    try {
      result = getCompletions(ta.value, ta.selectionStart, intelCtx(), { explicit, limit: MAX_SUGGESTIONS });
    } catch {
      result = null;
    }
    if (!result) {
      closeCompletion();
      return;
    }
    const anchor = result.from;
    const missing = missingEditorData(result.needs);
    requestData(missing, () => {
      if (ac.open && ac.result && ac.result.from === anchor) runCompletion(ac.explicit);
    });
    const waiting = missing.length > 0;
    if (!result.items.length && !waiting) {
      closeCompletion();
      return;
    }
    if (!explicit && !ac.open && result.items.length === 1 && result.items[0].label === result.prefix && !waiting) {
      closeCompletion();
      return;
    }
    const sameAnchor = ac.open && ac.result && ac.result.from === result.from;
    const previous = sameAnchor ? ac.result.items[ac.active]?.label : null;
    ac.open = true;
    ac.explicit = explicit || (sameAnchor && ac.explicit);
    ac.result = result;
    const keep = previous ? result.items.findIndex((i) => i.label === previous) : -1;
    ac.active = keep >= 0 && result.prefix === '' ? keep : 0;
    renderCompletion();
  }

  function renderCompletion() {
    const result = ac.result;
    if (!result) return;
    acList.replaceChildren();
    result.items.forEach((item, index) => {
      const row = h('div', `msb-ed__ac-item${index === ac.active ? ' msb-ed__ac-item--active' : ''}${item.deprecated ? ' msb-ed__ac-item--deprecated' : ''}`);
      row.id = `msb-ed-ac-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === ac.active ? 'true' : 'false');
      const icon = h('span', `msb-ed__ac-icon msb-ed__ac-icon--${item.kind}`, KIND_ICON[item.kind] || '?');
      icon.title = item.kind;
      const label = h('span', 'msb-ed__ac-label');
      const hits = new Set(item.positions || []);
      let run = '';
      let runHit = false;
      const flush = () => {
        if (!run) return;
        label.appendChild(runHit ? h('span', 'msb-ed__ac-hit', run) : document.createTextNode(run));
        run = '';
      };
      [...item.label].forEach((ch, i) => {
        const hit = hits.has(i);
        if (hit !== runHit) flush();
        runHit = hit;
        run += ch;
      });
      flush();
      const detail = h('span', 'msb-ed__ac-detail', item.deprecated ? `deprecated${item.detail ? ` · ${item.detail}` : ''}` : item.detail || '');
      row.append(icon, label, detail);
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        ac.active = index;
        acceptCompletion();
      });
      acList.appendChild(row);
    });
    if (!result.items.length) acList.appendChild(h('div', 'msb-ed__ac-empty', ac.loading || editorDataBusy() ? 'Loading…' : 'No suggestions'));
    renderCompletionDoc();
    acBox.hidden = false;
    ta.setAttribute('aria-controls', acList.id);
    ta.setAttribute('aria-expanded', 'true');
    if (result.items.length) ta.setAttribute('aria-activedescendant', `msb-ed-ac-${ac.active}`);
    placeBox(acBox, caretPoint(result.from));
    const active = acList.children[ac.active];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function renderCompletionDoc() {
    const item = ac.result?.items[ac.active];
    acDoc.replaceChildren();
    if (!item) return;
    const lines = [];
    if (item.sig) lines.push(item.owner ? `${item.owner}.${item.sig}` : item.sig);
    if (item.doc && item.kind !== 'snippet') lines.push(item.doc);
    if (item.kind === 'snippet') lines.push(item.doc);
    if (item.flags?.length) lines.push(item.flags.join(' · '));
    acDoc.textContent = lines.join('\n');
  }

  function moveActive(delta) {
    const count = ac.result?.items.length || 0;
    if (!count) return;
    ac.active = (ac.active + delta + count) % count;
    [...acList.children].forEach((row, i) => {
      row.classList.toggle('msb-ed__ac-item--active', i === ac.active);
      row.setAttribute('aria-selected', i === ac.active ? 'true' : 'false');
    });
    ta.setAttribute('aria-activedescendant', `msb-ed-ac-${ac.active}`);
    const row = acList.children[ac.active];
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    renderCompletionDoc();
  }

  function acceptCompletion() {
    const result = ac.result;
    const item = result?.items[ac.active];
    if (!item) {
      closeCompletion();
      return;
    }
    const edit = applyCompletion(ta.value, result, item);
    closeCompletion();
    replaceRange(edit.from, edit.to, edit.insert);
    ta.setSelectionRange(edit.caret, edit.caret);
    updatePosition();
    if (edit.retrigger) runCompletion(false);
    updateSignature();
  }

  function handlePopupKey(event) {
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      moveActive(key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (key === 'PageDown' || key === 'PageUp') {
      moveActive(key === 'PageDown' ? 8 : -8);
      return true;
    }
    if ((key === 'Enter' || key === 'Tab') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (!ac.result?.items.length) {
        closeCompletion();
        return false;
      }
      acceptCompletion();
      return true;
    }
    if (key === 'Escape') {
      closeCompletion();
      return true;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End') closeCompletion();
    return false;
  }

  // --- Parameter hints ---
  function hideSignature() {
    sigBox.hidden = true;
  }

  function updateSignature(force = false) {
    if (!force && sigBox.hidden && ta.selectionStart !== ta.selectionEnd) return;
    let help = null;
    try {
      help = ta.selectionStart === ta.selectionEnd ? getSignatureHelp(ta.value, ta.selectionStart, intelCtx()) : null;
    } catch {
      help = null;
    }
    if (!help) {
      hideSignature();
      if (force) toast.error('No parameter hints here.');
      return;
    }
    sigBox.replaceChildren();
    const sig = h('div', 'msb-ed__doc-sig');
    const param = help.params[help.active];
    if (param) {
      sig.append(document.createTextNode(help.label.slice(0, param.start)), h('span', 'msb-ed__sig-active', help.label.slice(param.start, param.end)), document.createTextNode(help.label.slice(param.end)));
    } else sig.textContent = help.label;
    if (help.overloads > 1) sig.appendChild(h('span', 'msb-ed__sig-count', `${help.overload + 1} of ${help.overloads}`));
    sigBox.appendChild(sig);
    if (help.summary) sigBox.appendChild(h('div', 'msb-ed__doc-note', help.summary));
    sigBox.hidden = false;
    const point = caretPoint(ta.selectionStart);
    placeBox(sigBox, point, { below: false });
  }

  // --- Hover docs ---
  function hideHover() {
    clearTimeout(hoverTimer);
    hoverAt = -1;
    hoverBox.hidden = true;
  }

  function showDoc(info, anchorOffset) {
    hoverBox.replaceChildren();
    hoverBox.appendChild(h('div', 'msb-ed__doc-title', info.title));
    if (info.signature) hoverBox.appendChild(h('div', 'msb-ed__doc-sig', `${info.signature}${info.returns ? ` → ${info.returns}` : ''}`));
    if (info.summary) hoverBox.appendChild(h('div', 'msb-ed__doc-text', info.summary));
    (info.flags || []).forEach((f) => hoverBox.appendChild(h('div', 'msb-ed__doc-flag', f)));
    if (info.notes) hoverBox.appendChild(h('div', 'msb-ed__doc-note', info.notes.length > 400 ? `${info.notes.slice(0, 400)}…` : info.notes));
    if (info.side && info.side !== side) hoverBox.appendChild(h('div', 'msb-ed__doc-flag', `This is a ${info.side}-side API.`));
    hoverBox.hidden = false;
    placeBox(hoverBox, caretPoint(anchorOffset), { below: false });
  }

  function hoverOffset(offset, attempt = 0) {
    let info = null;
    try {
      info = getHoverInfo(ta.value, offset, intelCtx());
    } catch {
      info = null;
    }
    if (attempt < 2) {
      const needs = collectNeeds(ta.value, offset, intelCtx());
      if (needs.length) {
        ensureEditorData(needs).then((changed) => {
          if (changed && hoverAt === offset) hoverOffset(offset, attempt + 1);
        });
      }
    }
    if (!info) {
      if (!hoverBox.hidden && attempt === 0) hoverBox.hidden = true;
      return;
    }
    showDoc(info, info.from);
  }

  ta.addEventListener('mousemove', (event) => {
    if (event.buttons) return;
    clearTimeout(hoverTimer);
    const x = event.clientX;
    const y = event.clientY;
    hoverTimer = setTimeout(() => {
      const offset = offsetAtPoint(x, y);
      if (offset < 0 || ac.open) {
        hoverBox.hidden = true;
        hoverAt = -1;
        return;
      }
      if (offset === hoverAt && !hoverBox.hidden) return;
      hoverAt = offset;
      hoverOffset(offset);
    }, HOVER_DELAY);
  });
  ta.addEventListener('mouseleave', hideHover);
  ta.addEventListener('mousedown', hideHover);

  // --- Go to definition ---
  async function goToDefinition(index = ta.selectionStart) {
    const ctxFor = () => intelCtx();
    try {
      for (let round = 0; round < 3; round += 1) {
        const needs = collectNeeds(ta.value, index, ctxFor());
        if (!needs.length) break;
        // eslint-disable-next-line no-await-in-loop -- dot-walked names need one table at a time.
        if (!(await ensureEditorData(needs))) break;
      }
      const target = getDefinitionTarget(ta.value, index, ctxFor());
      if (!target) {
        toast.error('Put the caret on a name first.');
        return;
      }
      if (target.type === 'local') {
        goToOffset(target.index);
        return;
      }
      if (target.type === 'api') {
        showDoc(target.hover, target.hover.from);
        return;
      }
      let url = null;
      if (target.type === 'name') url = tools.findDefinition ? await tools.findDefinition(target.name) : null;
      else url = await definitionUrl(target);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      else {
        const what = { field: 'field', table: 'table', scriptInclude: 'Script Include', property: 'system property', role: 'role' }[target.type] || 'definition';
        toast.error(`No ${what} found for "${target.table ? `${target.table}.` : ''}${target.name}".`);
      }
    } catch (err) {
      toast.error(err.message || String(err));
    }
  }

  // --- Find and replace ---
  function searchRegex() {
    const { re, error } = buildSearchRegex(findInput.value, { regex: pressed(regexToggle), matchCase: pressed(caseToggle), wholeWord: pressed(wordToggle) });
    findCount.classList.toggle('msb-ed__count--error', Boolean(error));
    if (error) findCount.textContent = error;
    return re;
  }

  function scheduleFind() {
    clearTimeout(findTimer);
    findTimer = setTimeout(updateMatches, 120);
  }

  function updateFindStatus() {
    if (!findInput.value || findCount.classList.contains('msb-ed__count--error')) {
      if (!findInput.value) findCount.textContent = '';
      return;
    }
    const capped = findMatches.length >= MAX_FIND_MATCHES ? '+' : '';
    const current = findMatches.findIndex((m) => m.index === ta.selectionStart && m.index + m.length === ta.selectionEnd);
    findCount.textContent = findMatches.length ? `${current >= 0 ? `${current + 1} of ` : ''}${findMatches.length}${capped} found` : 'No matches';
  }

  function updateMatches() {
    const re = searchRegex();
    findMatches = re ? findAll(ta.value, re, MAX_FIND_MATCHES) : [];
    updateFindStatus();
    paintFind();
  }

  function findNext(backwards = false) {
    if (!findInput.value) {
      showFind(true);
      return;
    }
    updateMatches();
    if (!findMatches.length) return;
    const from = backwards ? ta.selectionStart : ta.selectionEnd;
    const hit = backwards
      ? [...findMatches].reverse().find((m) => m.index < from) || findMatches[findMatches.length - 1]
      : findMatches.find((m) => m.index >= from) || findMatches[0];
    // Keep the focus in the find box (Enter again finds the next one); the current match is highlighted.
    goToOffset(hit.index, hit.index + hit.length, { focus: findBar.contains(shadow.activeElement) ? false : true });
    updateMatches();
  }

  function replaceOne() {
    if (ta.readOnly) return;
    const re = searchRegex();
    if (!re) return;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const back = shadow.activeElement;
    const replacement = replacementAt(ta.value, re, s, e, replaceInput.value, pressed(regexToggle));
    if (replacement !== null) {
      replaceRange(s, e, replacement);
      ta.setSelectionRange(s + replacement.length, s + replacement.length);
    }
    findNext();
    // Editing needs the textarea focused; give the focus back to the find bar afterwards.
    if (back && back !== ta && findBar.contains(back)) back.focus();
  }

  function replaceAll() {
    if (ta.readOnly) return;
    const re = searchRegex();
    if (!re) return;
    const { text, count } = replaceAllMatches(ta.value, re, replaceInput.value, pressed(regexToggle));
    if (!count) {
      findCount.textContent = 'No matches';
      return;
    }
    const back = shadow.activeElement;
    replaceText(text, Math.min(ta.selectionStart, text.length));
    updateMatches();
    findCount.textContent = `Replaced ${count}`;
    if (back && back !== ta && findBar.contains(back)) back.focus();
  }

  function showFind(open, replace = false) {
    findBar.hidden = !open;
    if (open) {
      gotoBar.hidden = true;
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel && !sel.includes('\n')) findInput.value = sel;
      const target = replace && findInput.value ? replaceInput : findInput;
      target.focus();
      target.select();
      updateMatches();
    } else {
      findMatches = [];
      paintFind();
      ta.focus();
    }
  }

  // --- Go to line ---
  function showGoto(open = true) {
    gotoBar.hidden = !open;
    if (open) {
      findBar.hidden = true;
      paintFind();
      const lines = analyze(ta.value).starts.length;
      gotoHint.textContent = `1 to ${lines}`;
      gotoInput.value = '';
      gotoInput.focus();
    } else ta.focus();
  }

  function submitGoto() {
    const parsed = parseLineInput(gotoInput.value);
    if (!parsed) {
      gotoHint.textContent = 'Type a line number, or line:column.';
      return;
    }
    gotoBar.hidden = true;
    goToLine(parsed.line, parsed.col > 1 ? parsed.col : null);
  }

  // --- Shortcut help ---
  function toggleHelp(open = help.hidden) {
    help.hidden = !open;
    if (open) helpClose.focus();
    else ta.focus();
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

  function runCheck() {
    if (ta.value.length > MAX_LINT_CHARS) {
      const syntax = checkSyntax(ta.value);
      showPanel(syntax ? `Syntax error on line ${syntax.line}: ${syntax.message}` : 'The script is too long for the full check; the syntax looks fine.');
      return;
    }
    showPanel('Checking…');
    // Let the panel paint first: the full check can take a moment on a long script.
    setTimeout(() => {
      const result = verifyScript({ code: ta.value, kind, when: rec.when, clientType: rec.clientType, scoped: rec.scoped === true, table: rec.target, fields: loadedFieldNames(rec.target) });
      showPanel(formatVerification(result, { maxFindings: 60 }));
    }, 30);
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

  function askAi(which) {
    const part = selectedText().trim();
    let text = part || ta.value;
    if (!text.trim()) return;
    const truncated = text.length > MAX_AI_CHARS;
    if (truncated) text = text.slice(0, MAX_AI_CHARS);
    runDiagnostics();
    const known = problems.filter((p) => p.severity === 'error').slice(0, 8);
    const knownText =
      which === 'fix' && known.length ? `\n\nProblems already detected:\n${known.map((p) => `- line ${p.line}: ${p.message}`).join('\n')}` : '';
    const prompt =
      `${AI_INSTRUCTIONS[which]}\n\nSource: ${table || 'unknown table'}, field "${field.name}"${part ? ' (selected part only)' : ''}.` +
      `${knownText}\n\n\`\`\`javascript\n${text}\n\`\`\`${truncated ? '\n(Script truncated for length.)' : ''}`;
    const label = AI_ACTIONS.find(([k]) => k === which)?.[1] || 'Ask AI';
    tools.askAi(label, prompt);
    overlay.hidden = true;
    toast.success('The answer is in the chat sidebar. Press Alt+Shift+E to come back to the editor.');
  }

  function openCompare() {
    if (isDirty()) toast.success('Compare uses the record as it is on the form. Apply your changes first to include them.');
    tools.openCompare();
    overlay.hidden = true;
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

  function updateKindChip() {
    const label = KIND_INFO[kind]?.label || 'Script';
    const scope = rec.scoped === true ? 'scoped' : rec.scoped === false ? 'global' : '';
    kindChip.textContent = [label, rec.target, side, scope].filter(Boolean).join(' · ');
    kindChip.title = 'Completion, hints and checks use this context';
  }

  function close() {
    if (isDirty() && !window.confirm('Discard changes that have not been applied to the form?')) return;
    clearTimeout(diagTimer);
    clearTimeout(findTimer);
    clearTimeout(hoverTimer);
    clearTimeout(dataTimer);
    cancelAnimationFrame(frame);
    overlay.remove();
  }

  async function loadField(name) {
    const state = await callPage('getFieldState', [name]);
    field = fields.find((f) => f.name === name) || field;
    baseline = String(state?.value ?? '');
    ta.value = baseline;
    ta.readOnly = !!state?.readOnly;
    unit = detectIndentUnit(baseline) || INDENT;
    title.textContent = `${table ? `${table} · ` : ''}${field.label || field.name}${state?.readOnly ? ' (read-only)' : ''}`;
    ta.scrollTop = 0;
    ta.scrollLeft = 0;
    closeCompletion();
    hideSignature();
    hideHover();
    diagText = null;
    fullCheckMs = 0;
    paint(true);
    refresh();
  }

  async function loadContext() {
    const record = await recordPromise;
    if (record) rec = record;
    kind = editorKind(table, { uiActionClient: rec.uiActionClient, side: guessSide(ta.value) });
    side = sideOfKind(kind) || 'server';
    updateKindChip();
    diagText = null;
    scheduleDiagnostics();
    if (rec.target) {
      prefetchFields(rec.target).then((changed) => {
        if (changed) {
          diagText = null;
          scheduleDiagnostics();
        }
      });
    }
    if (rec.catItem || rec.variableSet) {
      fetchCatalogVariables(rec)
        .then((vars) => {
          formFields = vars.length ? vars : null;
        })
        .catch(() => {});
    }
  }

  // --- Wiring ---
  const problemsToggle = button('Problems', 'msb-ed__btn', () => toggleProblems());
  problemsToggle.title = 'Problems found by the syntax, lint, API catalog and field checks (Ctrl+Shift+M)';
  const checkButton = button('Report', 'msb-ed__btn', runCheck);
  checkButton.title = 'Full verification report';
  actions.append(button('Find', 'msb-ed__btn', () => showFind(findBar.hidden)), problemsToggle, checkButton);
  if (tools.runScript) {
    const dry = button('Dry run', 'msb-ed__btn', trustedDom(() => run(true)));
    dry.title = 'Run the script (or the selection) with writes intercepted';
    const live = button('Run', 'msb-ed__btn', trustedDom(() => run(false)));
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
      const which = ai.value;
      ai.value = '';
      if (which) askAi(which);
    });
    actions.appendChild(ai);
  }
  if (tools.openCompare) actions.append(button('Compare', 'msb-ed__btn', openCompare));
  const helpButton = button('?', 'msb-ed__btn', () => toggleHelp());
  helpButton.title = 'Keyboard shortcuts (F1)';
  helpButton.setAttribute('aria-label', 'Keyboard shortcuts');
  actions.append(
    button('Apply to form', 'msb-ed__btn msb-ed__btn--primary', trustedDom(() => apply())),
    button('Apply & save', 'msb-ed__btn', trustedDom(() => apply({ save: true }))),
    helpButton,
    button('Close', 'msb-ed__btn', close)
  );
  findBar.append(
    findInput,
    replaceInput,
    caseToggle,
    wordToggle,
    regexToggle,
    button('Prev', 'msb-ed__btn', () => findNext(true)),
    button('Next', 'msb-ed__btn', () => findNext(false)),
    button('Replace', 'msb-ed__btn', replaceOne),
    button('All', 'msb-ed__btn', replaceAll),
    findCount,
    button('Done', 'msb-ed__btn', () => showFind(false))
  );
  gotoBar.append(h('span', null, 'Go to line'), gotoInput, button('Go', 'msb-ed__btn', submitGoto), gotoHint);

  fieldSelect.addEventListener('change', async () => {
    if (isDirty() && !window.confirm('Switch field and discard changes that have not been applied?')) {
      fieldSelect.value = field.name;
      return;
    }
    await loadField(fieldSelect.value);
  });

  ta.addEventListener('compositionstart', () => {
    composing = true;
    closeCompletion();
  });
  ta.addEventListener('compositionend', () => {
    composing = false;
  });

  ta.addEventListener('input', (event) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(refresh);
    hideHover();
    if (composing || event.isComposing || programmatic) return;
    const data = event.data || '';
    if (ac.open) runCompletion(ac.explicit);
    else if (event.inputType === 'insertText' && /[\w$.'"]$/.test(data)) runCompletion(false);
    if (!sigBox.hidden || /[(,]$/.test(data)) updateSignature();
  });
  ta.addEventListener('scroll', () => {
    hideHover();
    paint();
    if (ac.open && ac.result) placeBox(acBox, caretPoint(ac.result.from));
    if (!sigBox.hidden) placeBox(sigBox, caretPoint(ta.selectionStart), { below: false });
  });
  ta.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
      if (!sigBox.hidden) updateSignature();
    }
    updatePosition();
    paintBrackets();
    if (!findBar.hidden && findMatches.length) {
      updateFindStatus();
      paintFind();
    }
  });
  ta.addEventListener('click', (event) => {
    updatePosition();
    paintBrackets();
    if (!sigBox.hidden) updateSignature();
    if (event.ctrlKey || event.metaKey) goToDefinition(ta.selectionStart);
  });
  ta.addEventListener('focus', updatePosition);
  ta.addEventListener('blur', () => {
    setTimeout(() => {
      if (shadow.activeElement !== ta) {
        closeCompletion();
        hideSignature();
      }
    }, 120);
  });

  ta.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const code = event.code || '';
    if (key !== 'Control' && key !== 'Shift' && key !== 'Alt' && key !== 'Meta') hideHover();

    if (ac.open && handlePopupKey(event)) {
      event.preventDefault();
      return;
    }
    if (key === 'Escape' && !sigBox.hidden) {
      event.preventDefault();
      hideSignature();
      return;
    }
    const handled = (fn) => {
      event.preventDefault();
      fn();
    };

    if (mod && (key === ' ' || code === 'Space')) return handled(() => (event.shiftKey ? updateSignature(true) : runCompletion(true)));
    if (key === 'F1') return handled(() => toggleHelp(true));
    if (key === 'F12') return handled(() => goToDefinition());
    if (key === 'F8') return handled(() => nextProblem(event.shiftKey ? -1 : 1));
    if (key === 'F3') return handled(() => findNext(event.shiftKey));
    if (mod && key === '.') return handled(quickFixAtCaret);
    if (mod && event.shiftKey && (lower === 'm' || code === 'KeyM')) return handled(() => toggleProblems());
    if (mod && !event.shiftKey && (lower === 'g' || code === 'KeyG')) return handled(() => showGoto(true));
    if (mod && !event.shiftKey && (lower === 'f' || code === 'KeyF')) return handled(() => showFind(true));
    if (mod && !event.shiftKey && (lower === 'h' || code === 'KeyH')) return handled(() => showFind(true, true));
    // Apply / save only on a real keystroke, never on a page script's synthetic keydown.
    if (mod && (lower === 's' || code === 'KeyS')) return handled(() => event.isTrusted && apply({ save: event.shiftKey }));
    if (mod && key === 'Enter') {
      return handled(
        () =>
          event.isTrusted &&
          apply().then((ok) => {
            if (ok && !isDirty()) close();
          })
      );
    }
    if (ta.readOnly) return undefined;

    if (key === 'Tab' && !mod && !event.altKey) return handled(() => tab(event.shiftKey));
    if (mod && (key === '/' || code === 'Slash')) return handled(() => applyEdit(toggleLineComment(ta.value, ta.selectionStart, ta.selectionEnd)));
    if (mod && !event.shiftKey && (key === ']' || key === '[')) {
      return handled(() => applyEdit((key === ']' ? indentLines : outdentLines)(ta.value, ta.selectionStart, ta.selectionEnd, unit)));
    }
    if (event.altKey && !mod && (key === 'ArrowUp' || key === 'ArrowDown')) {
      const dir = key === 'ArrowDown' ? 1 : -1;
      return handled(() => applyEdit(event.shiftKey ? duplicateLines(ta.value, ta.selectionStart, ta.selectionEnd, dir) : moveLines(ta.value, ta.selectionStart, ta.selectionEnd, dir)));
    }
    if (mod && event.shiftKey && (lower === 'k' || code === 'KeyK')) return handled(() => applyEdit(deleteLines(ta.value, ta.selectionStart, ta.selectionEnd)));
    if (event.shiftKey && event.altKey && !mod && (lower === 'f' || code === 'KeyF')) return handled(format);
    if (key === 'Enter' && !mod && !event.altKey && !event.shiftKey) {
      return handled(() => {
        applyEdit(newlineAndIndent(ta.value, ta.selectionStart, ta.selectionEnd, unit));
        updateSignature();
      });
    }
    if (key === 'Home' && !mod && !event.shiftKey && !event.altKey) {
      return handled(() => {
        const caret = smartHome(ta.value, ta.selectionStart);
        ta.setSelectionRange(caret, caret);
        updatePosition();
      });
    }
    if (!mod && !event.altKey && pairKey(event)) event.preventDefault();
    return undefined;
  });

  findInput.addEventListener('input', scheduleFind);
  [caseToggle, wordToggle, regexToggle].forEach((t) => t.addEventListener('click', updateMatches));
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      findNext(event.shiftKey);
    }
  });
  replaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if ((event.ctrlKey || event.metaKey) && event.altKey) replaceAll();
      else replaceOne();
    }
  });
  gotoInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitGoto();
    }
  });

  overlay.addEventListener('keydown', (event) => {
    // The page has its own shortcuts; keep keystrokes inside the editor.
    event.stopPropagation();
    if (event.key === 'F1' && event.target !== ta) {
      event.preventDefault();
      toggleHelp();
      return;
    }
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    if (!help.hidden) toggleHelp(false);
    else if (!gotoBar.hidden) showGoto(false);
    else if (!findBar.hidden) showFind(false);
    else if (!hoverBox.hidden) hideHover();
    else close();
  });

  overlay.addEventListener('msb-show', () => {
    if (!isDirty()) loadField(field.name).catch(() => {});
    updateChip();
    requestAnimationFrame(() => {
      measureChar();
      paint(true);
      paintSquiggles();
      ta.focus();
    });
  });

  dialog.append(header, findBar, gotoBar, body, problemList, lintBox, footer, help);
  overlay.appendChild(dialog);
  shadow.appendChild(overlay);
  measureChar();
  updateKindChip();

  await loadField(field.name);
  loadContext();
  updateChip();
  requestAnimationFrame(() => {
    measureChar();
    paint(true);
    paintSquiggles();
    ta.focus();
  });
}
