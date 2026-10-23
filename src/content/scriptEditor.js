// Full-screen script editor for the script field on the open form: syntax highlighting, line
// numbers, context-aware completion, hover docs, parameter hints, live problems with quick
// fixes, find and replace, go to line / definition and line editing commands. It only changes
// the form field (it saves the record only on "Apply & save") and is built from DOM nodes,
// with no innerHTML. Every edit goes through execCommand('insertText') so native undo works.

import { callPage } from './pageBridge.js';
import { editorBox } from '../lib/inline.js';
import { askConfirm } from './confirmDialog.js';
import { syntaxAsk, prodApplySaveAsk, runScriptAsk, discardAsk } from '../lib/confirmCopy.js';
import { trustedDom } from '../sidebar/trusted.js';
import { verifyScript, formatVerification, KIND_INFO } from '../lib/verify.js';
import { checkSyntax } from '../lib/syntax.js';
import { expandSnippet, expandKey, SNIPPETS } from '../lib/snippets.js';
import * as snip from '../lib/editorSnippetSession.js';
import { analyzeScriptRisk, formatRiskSummary } from '../lib/scriptSafety.js';
import {
  analyze,
  lineTokens,
  lineOfOffset,
  lineEndAt,
  lineStartAt,
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
  diffRange,
  joinLines,
  selectLines,
} from '../lib/editorText.js';
import { outline, symbolAt, filterSymbols, symbolLabel } from '../lib/editorOutline.js';
import { formatCode, mapOffset } from '../lib/editorFormat.js';
import { lineHunks, hunkKind, hunkLines, hunkTitle, revertEdit, nextHunkLine } from '../lib/editorChanges.js';
import * as multi from '../lib/editorMulti.js';
import { referenceTarget } from '../lib/scriptApi.js';
import { createValueLookup, canLookUpProperty } from '../lib/panelLinks.js';
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
  readSavedFieldValue,
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
const SYNC_DELAY = 350;
const MAX_OUTLINE_CHARS = 300000;
// The browser's own editing slows down sharply with the size of one replacement (a few seconds for 40,000 characters on a long
// script), so bigger single replacements are refused or split instead of freezing the page.
const MAX_NATIVE_EDIT = 40000;
const MAX_SPLIT_EDITS = 120;
const MAX_CHANGE_CHARS = 300000;
const OUTLINE_ICON = { class: ['C', 'class'], method: ['m', 'method'], function: ['F', 'function'], handler: ['F', 'function'], marker: ['#', 'propertyName'] };
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
  ['Shift+F12', 'Find all references: every script that uses the Script Include, method or table at the caret. On a field it opens Where is this field used, on a system property name the System properties panel'],
  ['Ctrl+.', 'Quick fix for the problem on this line'],
  ['F8 / Shift+F8', 'Next / previous problem'],
  ['Ctrl+Shift+M', 'Show or hide the problems list'],
  ['Ctrl+F / Ctrl+H', 'Find / replace (regex, match case, whole word)'],
  ['F3 / Shift+F3', 'Find next / previous'],
  ['Ctrl+G', 'Go to line (line or line:column)'],
  ['Ctrl+Shift+O', 'Go to symbol: functions, Script Include methods and handlers, filtered as you type'],
  ['Ctrl+D', 'Select the word, then add the next occurrence; typing, Backspace, Enter and Tab then act on every cursor'],
  ['Ctrl+Shift+L', 'Select every occurrence of the word or selection (rename a variable by typing)'],
  ['Alt+click', 'Add a cursor (Esc goes back to one)'],
  ['Ctrl+/', 'Comment or uncomment lines'],
  ['Alt+Up / Alt+Down', 'Move lines up / down'],
  ['Shift+Alt+Up / Down', 'Duplicate lines'],
  ['Ctrl+Shift+K', 'Delete lines'],
  ['Ctrl+L', 'Select the line (again for the next line)'],
  ['Ctrl+J', 'Join the line with the next one (or the selected lines)'],
  ['Tab / Shift+Tab', 'Indent / outdent'],
  ['Ctrl+M', 'Tab moves the focus to the buttons and lists instead of indenting (Ctrl+M again to switch back)'],
  ['Ctrl+] / Ctrl+[', 'Indent / outdent lines'],
  ['Tab after a snippet name', `Expand it and jump between its blanks with Tab: ${Object.keys(SNIPPETS).join(', ')}`],
  ['Shift+Alt+F', 'Format the script, or the selected lines (indentation, spacing, trailing blanks; refuses if the code itself would change)'],
  ['Alt+F3 / Shift+Alt+F3', 'Next / previous change since the record was loaded (the Changes button lists them and can revert one)'],
  ['Ctrl+Shift+Enter', 'Dry run the script, or the selection (writes are intercepted; output shows below)'],
  ['Home', 'First character of the line, then column 1'],
  ['Ctrl+S', 'Apply to the form'],
  ['Ctrl+Shift+S', 'Apply and save the record'],
  ['Ctrl+Enter', 'Apply and close'],
  ['F1', 'This list'],
  ['Esc', 'Close a popup, extra cursors, then the editor'],
];

let pendingAction = null;

/**
 * Ask the editor that is about to open (or is already open) to do something once it is ready: 'outline' or 'format'.
 * The command palette uses this; the request lapses after five seconds so a failed open cannot fire it later.
 */
export function queueEditorAction(name) {
  pendingAction = { name, at: Date.now() };
}

function takeQueuedAction() {
  const action = pendingAction;
  pendingAction = null;
  return action && Date.now() - action.at < 5000 ? action.name : '';
}

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
 *   openPanel?: (name: string, params?: object) => boolean,
 *   propertyValue?: (name: string) => Promise<object>,
 *   isProd?: () => boolean,
 *   field?: string,
 *   place?: { rect: () => (object | null) },
 * }} deps
 * `field` opens that field instead of the best guess. `place` edits IN PLACE: the editor sits over the form's own
 * field (`rect()` is its box in top-window coordinates, null when it is gone) and every change flows to the form as
 * you type, so the platform's own Save button saves it. Without `place` the editor is full screen.
 */
export async function openScriptEditor({ shadow, toast, tools = {}, field: wantField = '', place: placeArg = null }) {
  const existing = shadow.querySelector('.msb-ed');
  if (existing) {
    existing.hidden = false;
    existing.dispatchEvent(new CustomEvent('msb-show', { detail: { field: wantField, place: placeArg } }));
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

  let field = fields.find((f) => f.name === wantField) || bestScriptField(fields);
  let place = placeArg;
  let lastPlace = placeArg;
  let syncTimer = 0;
  let followFrame = 0;
  let boxKey = '';
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
  const changeBars = h('div', 'msb-ed__changebars');
  gutter.append(gutterInner, marks, changeBars);
  const surface = h('div', 'msb-ed__surface');
  const hl = h('div', 'msb-ed__hl');
  const bands = h('div', 'msb-ed__bands');
  const deco = h('div', 'msb-ed__deco');
  const findLayer = h('div');
  const bracketLayer = h('div');
  const snipLayer = h('div');
  const multiLayer = h('div');
  const squiggleLayer = h('div');
  deco.append(findLayer, bracketLayer, snipLayer, multiLayer, squiggleLayer);
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
  // The output of Report, Dry run and Run: a drawer that can be copied from and closed.
  const lintBox = h('div', 'msb-ed__lint');
  lintBox.hidden = true;
  lintBox.setAttribute('role', 'region');
  lintBox.setAttribute('aria-label', 'Output');
  const lintTitle = h('span', 'msb-ed__lint-title', 'Output');
  const lintBody = h('pre', 'msb-ed__lint-body');
  lintBody.tabIndex = 0;
  const lintHead = h('div', 'msb-ed__lint-head');
  lintHead.append(lintTitle, button('Copy', 'msb-ed__pfix', () => copyOutput()), button('Close', 'msb-ed__pfix', () => closeOutput()));
  lintBox.append(lintHead, lintBody);

  // What changed since the record was loaded: one row per changed region, each with Show and Revert.
  const changesList = h('div', 'msb-ed__plist msb-ed__changes-list');
  changesList.hidden = true;
  changesList.setAttribute('role', 'region');
  changesList.setAttribute('aria-label', 'Changes since the record was loaded');

  const refList = h('div', 'msb-ed__plist');
  refList.hidden = true;
  refList.setAttribute('aria-label', 'References');

  const footer = h('div', 'msb-ed__footer');
  const position = h('span', null, 'Ln 1, Col 1');
  const problemsButton = button('', 'msb-ed__problems', () => toggleProblems());
  problemsButton.title = 'Show problems (Ctrl+Shift+M)';
  const refsButton = button('References', 'msb-ed__problems msb-ed__problems--ok', () => findAllReferences());
  refsButton.title = 'Find every script that uses the name at the caret (Shift+F12)';
  const hints = h('span', 'msb-ed__hints', 'Ctrl+Space suggestions · F12 definition · Ctrl+Shift+O symbols · Ctrl+S apply · F1 all shortcuts · Esc close');
  const symbolButton = button('Outline', 'msb-ed__problems msb-ed__symbol', () => showOutline());
  symbolButton.title = 'Go to symbol (Ctrl+Shift+O)';
  const changesButton = button('', 'msb-ed__problems msb-ed__problems--ok', () => toggleChanges());
  changesButton.hidden = true;
  footer.append(position, symbolButton, problemsButton, changesButton, refsButton, hints);

  // --- Go to symbol ---
  const outlineBox = h('div', 'msb-ed__outline');
  outlineBox.hidden = true;
  outlineBox.setAttribute('role', 'dialog');
  outlineBox.setAttribute('aria-label', 'Go to symbol');
  const outlineInput = document.createElement('input');
  outlineInput.placeholder = 'Go to symbol: type part of a name';
  outlineInput.setAttribute('aria-label', 'Go to symbol');
  outlineInput.setAttribute('role', 'combobox');
  outlineInput.setAttribute('aria-controls', 'msb-ed-outline-list');
  outlineInput.setAttribute('aria-expanded', 'true');
  outlineInput.setAttribute('autocomplete', 'off');
  const outlineList = h('div', 'msb-ed__outline-list');
  outlineList.id = 'msb-ed-outline-list';
  outlineList.setAttribute('role', 'listbox');
  outlineList.setAttribute('aria-label', 'Symbols');
  outlineBox.append(outlineInput, outlineList);

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
  // What a system property is set to, for the hover over its name: one read per name per editor session.
  const propertyValues = createValueLookup(tools.propertyValue ? (name) => tools.propertyValue(name) : null);
  let dataTimer = 0;
  let frame = 0;
  const ac = { open: false, explicit: false, result: null, active: 0, loading: false };
  // Extra cursors (Ctrl+D, Ctrl+Shift+L, Alt+click). The textarea keeps the primary one; these are plain {start, end}.
  let extras = [];
  let multiWord = false;
  // A snippet that was just expanded: its blanks, which one Tab goes to next, and the text they were read from.
  let snippet = null;
  let snippetText = '';
  let snippetBusy = false;
  // Ctrl+M: Tab moves the focus out of the text instead of indenting (as in VS Code), so every button is keyboard reachable.
  let tabMovesFocus = false;
  let resizeWatch = null;
  // What was loaded from the record, to show what changed (the Changes button and the bars beside the line numbers).
  let savedText = '';
  let hunks = [];
  // The outline of the script, for the footer breadcrumb and Go to symbol.
  let outlineSymbols = [];
  let outlineText = null;
  let outlineTimer = 0;
  let outlineShown = [];
  let outlineActive = 0;

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
    changeBars.style.transform = `translateY(${y}px)`;
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
    updateChanges();
    if (extras.length) paintMulti();
    // Lines were added or removed since the last check: the markers would sit on the wrong lines
    // until the next check (a moment later), so hide them meanwhile.
    if (problems.length && analyze(ta.value).starts.length !== problemsLineCount) {
      marks.replaceChildren();
      bands.replaceChildren();
      squiggleLayer.replaceChildren();
    }
    updatePosition();
    status.textContent = place ? (isDirty() ? 'Syncing…' : 'In sync with the form') : isDirty() ? 'Modified' : 'No changes';
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
    position.textContent = `Ln ${line + 1}, Col ${caret - info.starts[line] + 1}${sel ? ` (${sel} selected)` : ''}${extras.length ? ` · ${extras.length + 1} cursors` : ''} · ${charsLabel[0]} chars`;
    updateCrumb();
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
    if (snippet && snippetTab(shift ? -1 : 1)) return true;
    if (shift) return applyEdit(outdentLines(text, s, e, unit));
    if (s === e) {
      const expansion = expandSnippet(text, s); // never inside a comment or a string
      if (expansion) {
        startSnippet(expansion);
        return true;
      }
      return applyEdit(insertIndent(text, s, unit));
    }
    return applyEdit(indentLines(text, s, e, unit));
  }

  // --- Snippet blanks ---
  function paintSnippet() {
    snipLayer.replaceChildren();
    if (!snippet) return;
    const info = analyze(ta.value);
    snippet.stops.forEach((stop, si) => {
      if (si === snippet.stops.length - 1) return; // the last stop is only where the caret ends up
      stop.ranges.forEach((r, ri) => {
        const line = lineOfOffset(info.starts, r.start);
        const lineEnd = line + 1 < info.starts.length ? info.starts[line + 1] - 1 : ta.value.length;
        const node = box(`msb-ed__snip${si === snippet.active ? ' msb-ed__snip--active' : ''}${ri ? ' msb-ed__snip--copy' : ''}`, line, r.start, Math.max(r.start, Math.min(r.end, lineEnd)));
        if (r.start === r.end) node.style.width = '3px';
        snipLayer.appendChild(node);
      });
    });
  }

  function endSnippet() {
    if (!snippet) return;
    snippet = null;
    paintSnippet();
  }

  /** Put an expanded snippet in (replacing the word that triggered it) and select its first blank. */
  function startSnippet(expansion) {
    clearExtras();
    snippetBusy = true;
    try {
      replaceRange(expansion.start, expansion.end, expansion.text);
    } finally {
      snippetBusy = false;
    }
    const session = snip.startSession(expansion);
    if (!session) {
      ta.setSelectionRange(expansion.caret, expansion.caret);
      snippet = null;
      afterEdit();
      return;
    }
    snippet = snip.withText(session, ta.value);
    snippetText = ta.value;
    const first = snip.activeRange(snippet);
    ta.setSelectionRange(first.start, first.end);
    afterEdit();
    paintSnippet();
  }

  /** Tab or Shift+Tab inside a snippet: on to the next blank. False when the caret is not in a blank (then Tab is just Tab). */
  function snippetTab(dir) {
    if (!snippet || !snip.selectionInBlank(snippet, ta.selectionStart, ta.selectionEnd)) {
      endSnippet();
      return false;
    }
    const jump = snip.jump(snippet, ta.value, dir);
    snippet = jump.session;
    ta.setSelectionRange(jump.select.start, jump.select.end);
    closeCompletion();
    hideSignature();
    updatePosition();
    revealCaret();
    paintSnippet();
    return true;
  }

  /** After every edit while a snippet is open: move the blanks, and make the copies of the blank being typed in follow it. */
  function trackSnippet() {
    if (!snippet) {
      snippetText = ta.value;
      return;
    }
    const edit = snip.locateEdit(snippetText, ta.value, ta.selectionStart);
    const tracked = snip.trackEdit(snippet, edit);
    const synced = tracked && snip.syncCopies(ta.value, tracked);
    if (!synced) {
      endSnippet(); // an edit somewhere else: stop following rather than guess
      snippetText = ta.value;
      return;
    }
    snippet = synced.session;
    if (synced.text !== ta.value) {
      const from = ta.selectionStart;
      const to = ta.selectionEnd;
      const d = diffRange(ta.value, synced.text);
      snippetBusy = true;
      try {
        replaceRange(d.from, d.to, d.insert);
      } finally {
        snippetBusy = false;
      }
      ta.setSelectionRange(from, to); // the copies come after the blank being typed in, so the caret has not moved
    }
    snippetText = ta.value;
    paintSnippet();
  }

  // --- Format ---
  /** Shift+Alt+F: format the selected lines, or the whole script when nothing is selected. Refuses rather than guess. */
  function format() {
    if (ta.readOnly) {
      toast.error('This field is read-only.');
      return;
    }
    clearExtras();
    const text = ta.value;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    let range = {};
    if (s !== e) {
      const starts = analyze(text).starts;
      const last = text[e - 1] === '\n' ? e - 1 : e; // a selection that ends at column 0 does not include that line
      range = { fromLine: lineOfOffset(starts, s), toLine: lineOfOffset(starts, Math.max(last, s)) };
    }
    const part = range.fromLine !== undefined;
    const result = formatCode(text, { unit, ...range });
    if (result.error) {
      toast.error(result.error);
      return;
    }
    if (!result.changed) {
      toast.success(part ? 'The selected lines are already formatted.' : 'The script is already formatted.');
      return;
    }
    const next = result.text;
    const d = diffRange(text, next);
    if (d.insert.length > MAX_NATIVE_EDIT) {
      toast.error('Formatting this much at once would freeze the page for several seconds. Select the part you want formatted and press Shift+Alt+F again.');
      return;
    }
    replaceRange(d.from, d.to, d.insert);
    ta.setSelectionRange(mapOffset(text, next, s), mapOffset(text, next, e));
    afterEdit();
    toast.success(part ? 'Formatted the selected lines. Ctrl+Z undoes it.' : 'Formatted the script. Ctrl+Z undoes it.');
  }

  // --- Lines: join, select ---
  function joinSelectedLines() {
    const edit = joinLines(ta.value, ta.selectionStart, ta.selectionEnd);
    if (!edit) {
      toast.info('There is no next line to join.');
      return;
    }
    if (edit.error) {
      toast.error(edit.error);
      return;
    }
    applyEdit(edit);
  }

  function selectWholeLines() {
    const r = selectLines(ta.value, ta.selectionStart, ta.selectionEnd);
    ta.setSelectionRange(r.selStart, r.selEnd);
    updatePosition();
    paintBrackets();
  }

  // --- Go to symbol (outline) ---
  function currentOutline() {
    if (outlineText !== ta.value) {
      outlineSymbols = ta.value.length > MAX_OUTLINE_CHARS ? [] : outline(ta.value);
      outlineText = ta.value;
    }
    return outlineSymbols;
  }

  /** The footer shows where the caret is ("IncidentUtils › getOpen"); the outline is re-read when typing pauses. */
  function updateCrumb() {
    if (outlineText !== ta.value) {
      clearTimeout(outlineTimer);
      outlineTimer = setTimeout(() => {
        currentOutline();
        paintCrumb();
      }, 250);
    }
    paintCrumb();
  }

  function paintCrumb() {
    const sym = symbolAt(outlineSymbols, ta.selectionStart);
    const label = sym ? sym.path : 'Outline';
    if (symbolButton.textContent !== label) symbolButton.textContent = label;
    symbolButton.title = sym ? `In ${sym.path}. Go to symbol (Ctrl+Shift+O)` : 'Go to symbol (Ctrl+Shift+O)';
  }

  function highlighted(parent, label, positions) {
    const hits = new Set(positions || []);
    let run = '';
    let runHit = false;
    const flush = () => {
      if (!run) return;
      parent.appendChild(runHit ? h('span', 'msb-ed__ac-hit', run) : document.createTextNode(run));
      run = '';
    };
    [...label].forEach((ch, i) => {
      const hit = hits.has(i);
      if (hit !== runHit) flush();
      runHit = hit;
      run += ch;
    });
    flush();
  }

  function showOutline() {
    clearTimeout(outlineTimer);
    const symbols = currentOutline();
    if (!symbols.length) {
      toast.info(ta.value.length > MAX_OUTLINE_CHARS ? 'This script is too long for the outline.' : 'No functions or methods were found in this script.');
      return;
    }
    const here = symbolAt(symbols, ta.selectionStart);
    outlineInput.value = '';
    outlineActive = here ? Math.max(0, symbols.indexOf(here)) : 0;
    outlineBox.hidden = false;
    renderOutline(true);
    outlineInput.focus();
  }

  function closeOutline(focusEditor = true) {
    if (outlineBox.hidden) return;
    outlineBox.hidden = true;
    outlineList.replaceChildren();
    if (focusEditor) ta.focus();
  }

  function renderOutline(keepActive = false) {
    const query = outlineInput.value;
    outlineShown = filterSymbols(currentOutline(), query);
    if (!keepActive) outlineActive = 0;
    outlineActive = Math.min(outlineActive, Math.max(0, Math.min(outlineShown.length, 300) - 1));
    outlineList.replaceChildren();
    if (!outlineShown.length) {
      outlineList.appendChild(h('div', 'msb-ed__ac-empty', 'No symbol matches'));
      outlineInput.removeAttribute('aria-activedescendant');
      return;
    }
    outlineShown.slice(0, 300).forEach(({ sym, positions }, index) => {
      const row = h('div', `msb-ed__ac-item${index === outlineActive ? ' msb-ed__ac-item--active' : ''}`);
      row.id = `msb-ed-ol-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === outlineActive ? 'true' : 'false');
      const [letter, cls] = OUTLINE_ICON[sym.kind] || ['?', 'function'];
      const icon = h('span', `msb-ed__ac-icon msb-ed__ac-icon--${cls}`, letter);
      icon.title = sym.kind;
      const label = h('span', 'msb-ed__ol-label');
      if (!query.trim()) label.style.paddingLeft = `${Math.min(sym.depth, 6) * 14}px`;
      highlighted(label, sym.name, positions);
      const detail = h('span', 'msb-ed__ac-detail', sym.kind === 'class' || sym.kind === 'marker' ? '' : `(${sym.params})`);
      const where = h('span', 'msb-ed__pline', `Ln ${sym.line}`);
      row.append(icon, label, detail, where);
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        jumpToSymbol(sym);
      });
      outlineList.appendChild(row);
    });
    if (outlineShown.length > 300) outlineList.appendChild(h('div', 'msb-ed__ac-empty', `${outlineShown.length - 300} more. Type to narrow the list.`));
    outlineInput.setAttribute('aria-activedescendant', `msb-ed-ol-${outlineActive}`);
    outlineList.children[outlineActive]?.scrollIntoView?.({ block: 'nearest' });
  }

  function moveOutline(delta) {
    const count = Math.min(outlineShown.length, 300);
    if (!count) return;
    outlineActive = (outlineActive + delta + count) % count;
    [...outlineList.children].slice(0, count).forEach((row, i) => {
      row.classList.toggle('msb-ed__ac-item--active', i === outlineActive);
      row.setAttribute('aria-selected', i === outlineActive ? 'true' : 'false');
    });
    outlineInput.setAttribute('aria-activedescendant', `msb-ed-ol-${outlineActive}`);
    outlineList.children[outlineActive]?.scrollIntoView?.({ block: 'nearest' });
  }

  function jumpToSymbol(sym) {
    closeOutline(false);
    clearExtras();
    goToOffset(sym.offset);
  }

  // --- Changes since the record was loaded ---
  let changesFor = null;
  let changesBase = null;

  function updateChanges() {
    if (changesFor === ta.value && changesBase === savedText) return;
    changesFor = ta.value;
    changesBase = savedText;
    hunks = ta.value.length > MAX_CHANGE_CHARS || savedText.length > MAX_CHANGE_CHARS ? [] : lineHunks(savedText, ta.value);
    renderChangeBars();
    const n = hunks.length;
    changesButton.hidden = n === 0 && changesList.hidden;
    changesButton.textContent = n ? plural(n, 'change') : 'No changes';
    changesButton.title = n ? 'Show what changed since the record was loaded, and revert parts of it (Alt+F3 jumps to the next change)' : 'Nothing differs from the record as it was loaded';
    if (!changesList.hidden) renderChangesList();
  }

  function renderChangeBars() {
    changeBars.replaceChildren();
    const lines = analyze(ta.value).starts.length;
    hunks.slice(0, MAX_MARKS).forEach((hunk, index) => {
      const kind = hunkKind(hunk);
      const bar = h('div', `msb-ed__chg msb-ed__chg--${kind}`);
      if (kind === 'removed') bar.style.top = `${TOP_PAD + Math.min(hunk.newStart, lines) * LINE_HEIGHT - 3}px`;
      else {
        bar.style.top = `${TOP_PAD + hunk.newStart * LINE_HEIGHT}px`;
        bar.style.height = `${(hunk.newEnd - hunk.newStart) * LINE_HEIGHT}px`;
      }
      bar.title = `${hunkTitle(hunk)}. Click to review it.`;
      bar.addEventListener('click', () => toggleChanges(true, index));
      changeBars.appendChild(bar);
    });
  }

  function toggleChanges(open = changesList.hidden, focusIndex = -1) {
    changesList.hidden = !open;
    if (open) {
      closeOutline(false);
      renderChangesList(focusIndex);
    }
    changesFor = null;
    updateChanges();
  }

  function renderChangesList(focusIndex = -1) {
    changesList.replaceChildren();
    const head = h('div', 'msb-ed__pempty', hunks.length ? `${plural(hunks.length, 'change')} since the record was loaded.` : 'No changes since the record was loaded.');
    if (hunks.length && !ta.readOnly) head.appendChild(button('Revert all', 'msb-ed__pfix', () => revertAll()));
    head.appendChild(button('Close', 'msb-ed__pfix', () => toggleChanges(false)));
    changesList.appendChild(head);
    hunks.slice(0, 80).forEach((hunk, index) => {
      const row = h('div', 'msb-ed__crow');
      const top = h('div', 'msb-ed__crow-head');
      top.append(h('span', 'msb-ed__pmsg', hunkTitle(hunk)), button('Show', 'msb-ed__pfix', () => goToLine(Math.min(hunk.newStart + 1, analyze(ta.value).starts.length))));
      if (!ta.readOnly) top.appendChild(button('Revert', 'msb-ed__pfix', () => revertChange(hunk)));
      row.appendChild(top);
      const { oldLines, newLines } = hunkLines(savedText, ta.value, hunk);
      const diff = h('div', 'msb-ed__diff');
      const addLines = (lines, cls, sign) => {
        lines.slice(0, 6).forEach((line) => diff.appendChild(h('pre', `msb-ed__diff-line msb-ed__diff-line--${cls}`, `${sign} ${line}`)));
        if (lines.length > 6) diff.appendChild(h('pre', 'msb-ed__diff-line', `  … ${lines.length - 6} more`));
      };
      addLines(oldLines, 'del', '-');
      addLines(newLines, 'add', '+');
      row.appendChild(diff);
      changesList.appendChild(row);
      if (index === focusIndex) row.scrollIntoView?.({ block: 'nearest' });
    });
    if (hunks.length > 80) changesList.appendChild(h('div', 'msb-ed__pempty', `… and ${hunks.length - 80} more. Use Revert all, or work through these first.`));
  }

  function revertChange(hunk) {
    if (ta.readOnly) return;
    // The row was drawn from an earlier comparison: only revert it while it still describes the text (line numbers move).
    changesFor = null;
    updateChanges();
    if (!hunks.some((x) => x.oldStart === hunk.oldStart && x.oldEnd === hunk.oldEnd && x.newStart === hunk.newStart && x.newEnd === hunk.newEnd)) {
      toast.info('The script changed since that list was drawn; it is up to date now. Pick the change again.');
      return;
    }
    const edit = revertEdit(savedText, ta.value, hunk);
    if (!edit) return;
    clearExtras();
    replaceRange(edit.from, edit.to, edit.insert);
    const caretAt = edit.from + edit.insert.length;
    ta.setSelectionRange(caretAt, caretAt);
    afterEdit();
    changesFor = null;
    updateChanges();
    toast.success('Change reverted. Ctrl+Z puts it back.');
  }

  function revertAll() {
    if (ta.readOnly) return;
    const d = diffRange(ta.value, savedText);
    if (!d) return;
    if (d.insert.length > MAX_NATIVE_EDIT) {
      toast.error('That is too much to revert at once in a long script. Revert the changes one at a time from this list.');
      return;
    }
    clearExtras();
    replaceRange(d.from, d.to, d.insert);
    ta.setSelectionRange(0, 0);
    afterEdit();
    changesFor = null;
    updateChanges();
    toast.success('Everything is back as it was loaded. Ctrl+Z puts it back.');
  }

  function jumpChange(dir) {
    if (!hunks.length) {
      toast.info('No changes since the record was loaded.');
      return;
    }
    const starts = analyze(ta.value).starts;
    const line = nextHunkLine(hunks, lineOfOffset(starts, ta.selectionStart), dir, starts.length);
    if (line >= 0) goToLine(line + 1);
  }

  // --- Extra cursors ---
  function allSelections() {
    return [...extras.map((x) => ({ start: x.start, end: x.end, primary: false })), { start: ta.selectionStart, end: ta.selectionEnd, primary: true }];
  }

  function paintMulti() {
    multiLayer.replaceChildren();
    if (!extras.length) return;
    const text = ta.value;
    const info = analyze(text);
    let drawn = 0;
    for (const sel of extras) {
      if (drawn >= MAX_FIND_BOXES) break;
      if (sel.start === sel.end) {
        const node = box('msb-ed__multi-caret', lineOfOffset(info.starts, sel.start), sel.start, sel.start + 1);
        node.style.width = '2px';
        multiLayer.appendChild(node);
        drawn += 1;
        continue;
      }
      const first = lineOfOffset(info.starts, sel.start);
      const last = lineOfOffset(info.starts, sel.end);
      for (let li = first; li <= last && drawn < MAX_FIND_BOXES; li += 1) {
        const from = Math.max(sel.start, info.starts[li]);
        const to = Math.min(sel.end, li + 1 < info.starts.length ? info.starts[li + 1] - 1 : text.length);
        multiLayer.appendChild(box('msb-ed__multi-sel', li, from, Math.max(from, to)));
        drawn += 1;
      }
    }
  }

  function clearExtras() {
    if (!extras.length) return;
    extras = [];
    multiWord = false;
    paintMulti();
    updatePosition();
  }

  /** Make `sels` (any order, exactly one primary) the cursors: the primary goes to the textarea, the rest are drawn. */
  function setSelections(sels) {
    const list = multi.normalize(sels);
    if (!list.length) return;
    const primary = list.find((x) => x.primary) || list[list.length - 1];
    extras = list.filter((x) => x !== primary).map(({ start, end }) => ({ start, end }));
    closeCompletion();
    hideSignature();
    ta.setSelectionRange(primary.start, primary.end);
    paintMulti();
    updatePosition();
    paintBrackets();
  }

  function showPrimary() {
    const p = caretPoint(ta.selectionEnd);
    if (p.y < 0 || p.y + LINE_HEIGHT * 2 > ta.clientHeight) goToOffset(ta.selectionStart, ta.selectionEnd);
  }

  function selectNextOccurrence() {
    const r = multi.nextOccurrence(ta.value, allSelections(), multiWord);
    if (!r) {
      toast.info(extras.length ? 'No more matches.' : 'Put the caret in a word first.');
      return;
    }
    multiWord = r.wholeWord;
    setSelections(r.sels);
    showPrimary();
  }

  function selectAllOccurrences() {
    const r = multi.allOccurrences(ta.value, { start: ta.selectionStart, end: ta.selectionEnd }, { wholeWord: multiWord || null });
    if (!r) {
      toast.info('There is only one of it, or nothing is selected.');
      return;
    }
    multiWord = r.wholeWord;
    setSelections(r.sels);
    toast.info(`${r.sels.length} cursors. Type to change them all; Esc goes back to one.`);
  }

  /** Apply the outcome of a multi-cursor edit as one replacement, so one Ctrl+Z undoes it. */
  function applyMulti(result) {
    if (ta.readOnly) return;
    const d = diffRange(ta.value, result.text);
    if (d && d.insert.length > MAX_NATIVE_EDIT) {
      // Cursors far apart in a long script: one replacement from the first to the last would be huge, so change each spot on its own.
      if (!result.edits || result.edits.length > MAX_SPLIT_EDITS) {
        toast.error('That is too many cursors across a long script to edit at once. Use fewer cursors, or Find and replace.');
        return;
      }
      for (let i = result.edits.length - 1; i >= 0; i -= 1) {
        const edit = result.edits[i];
        if (edit.from !== edit.to || edit.insert) replaceRange(edit.from, edit.to, edit.insert);
      }
      if (ta.value !== result.text) {
        ta.value = result.text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      toast.info('This is a long script, so Ctrl+Z undoes these one cursor at a time.');
    } else if (d) {
      replaceRange(d.from, d.to, d.insert);
      if (ta.value !== result.text) {
        // The browser did not take the edit as asked: make the text what it should be rather than leave a mix.
        ta.value = result.text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    setSelections(result.sels);
    afterEdit();
  }

  /** What a key does while there are extra cursors: 'done' (handled here), 'native' (typing and deleting, see beforeinput), 'keep' (carry on, keep the cursors) or 'normal' (back to one cursor). */
  function multiKeydown(event) {
    const key = event.key;
    if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return 'keep';
    if (ta.readOnly) return 'normal';
    const mod = event.ctrlKey || event.metaKey;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const plain = !mod && !event.altKey && !event.shiftKey;
    if (key === 'Escape') {
      clearExtras();
      return 'done';
    }
    if (mod && !event.altKey && (lower === 'd' || (event.shiftKey && lower === 'l'))) return 'keep';
    if (plain && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End')) {
      setSelections(multi.moveAll(ta.value, allSelections(), key).sels);
      showPrimary();
      return 'done';
    }
    if (plain && key === 'Enter') {
      applyMulti(multi.newline(ta.value, allSelections()));
      return 'done';
    }
    if (plain && key === 'Tab' && !tabMovesFocus) {
      applyMulti(multi.tabAll(ta.value, allSelections(), unit));
      return 'done';
    }
    if (!mod && !event.altKey && (key.length === 1 || key === 'Backspace' || key === 'Delete')) return 'native';
    if (key.length === 1 && event.getModifierState && event.getModifierState('AltGraph')) return 'native';
    if (mod && !event.altKey && !event.shiftKey && (lower === 'c' || lower === 'v')) return 'native';
    return 'normal';
  }

  ta.addEventListener('beforeinput', (event) => {
    if (!extras.length || programmatic || composing || event.isComposing) return;
    const type = event.inputType;
    const sels = allSelections();
    let result = null;
    if (type === 'insertText' && event.data) result = multi.typeText(ta.value, sels, event.data);
    else if (type === 'deleteContentBackward') result = multi.backspace(ta.value, sels);
    else if (type === 'deleteContentForward') result = multi.deleteForward(ta.value, sels);
    else if (type === 'insertLineBreak' || type === 'insertParagraph') result = multi.newline(ta.value, sels);
    else if (type === 'insertFromPaste' || type === 'insertFromPasteAsQuotation') {
      // In a textarea Chrome passes the pasted text as `data`; `dataTransfer` is there in other editing hosts.
      const clip = event.dataTransfer ? event.dataTransfer.getData('text/plain') : event.data || '';
      if (clip) result = multi.pasteText(ta.value, sels, clip);
    }
    if (!result) {
      clearExtras(); // anything else (cut, drop, undo, word delete) acts on the primary cursor only
      return;
    }
    event.preventDefault();
    applyMulti(result);
  });

  ta.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !ta.readOnly) {
      event.preventDefault();
      ta.focus();
      const rect = ta.getBoundingClientRect();
      const info = analyze(ta.value);
      const line = Math.max(0, Math.min(info.starts.length - 1, Math.floor((event.clientY - rect.top + ta.scrollTop - TOP_PAD) / LINE_HEIGHT)));
      const x = Math.max(0, event.clientX - rect.left + ta.scrollLeft - LEFT_PAD);
      const at = multi.snapToChar(ta.value, offsetAtVisualColumn(ta.value, info.starts[line], Math.floor(x / charWidth), TAB_SIZE));
      setSelections([...allSelections().map((sel) => ({ ...sel, primary: false })), { start: at, end: at, primary: true }]);
      return;
    }
    clearExtras();
  });

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
    if (item.kind === 'snippet') {
      const lead = /^[ \t]*/.exec(ta.value.slice(lineStartAt(ta.value, edit.from), edit.from))[0];
      const expansion = expandKey(item.label, edit.from, edit.to, lead);
      if (expansion) {
        startSnippet(expansion);
        return;
      }
    }
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

  // The hover over a property name also says what the property is set to here. Read-only; never for a name that looks like a
  // secret (canLookUpProperty), and nothing is shown when the read fails or the value is hidden.
  function showPropertyValue(info, offset) {
    if (!tools.propertyValue || !info.name || !canLookUpProperty(info.name)) return;
    const paint = (line) => {
      if (!line || hoverAt !== offset || hoverBox.hidden || hoverBox.firstChild?.textContent !== info.title) return;
      hoverBox.querySelector('.msb-ed__doc-value')?.remove();
      hoverBox.appendChild(h('div', 'msb-ed__doc-text msb-ed__doc-value', line));
      placeBox(hoverBox, caretPoint(info.from), { below: false });
    };
    const cached = propertyValues.peek(info.name);
    if (cached !== undefined) paint(cached);
    else propertyValues.load(info.name).then(paint);
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
    if (info.kind === 'propertyName') showPropertyValue(info, offset);
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

  // --- Find all references ---
  function renderRefs(rows, summary) {
    refList.replaceChildren();
    const head = h('div', 'msb-ed__pempty', summary);
    head.appendChild(button('Close', 'msb-ed__pfix', () => { refList.hidden = true; }));
    refList.appendChild(head);
    rows.forEach((hit) => {
      const row = h('div', 'msb-ed__prow');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      const dot = h('span', `msb-ed__pdot msb-ed__pdot--${hit.certainty === 'call' ? 'info' : 'warning'}`);
      dot.title = hit.certainty === 'call' ? 'Confirmed use' : 'Possible use: the name appears but the receiver could not be confirmed';
      const first = hit.lines[0];
      const msg = h('span', 'msb-ed__pmsg', `${hit.label}: ${hit.name}${first ? ` — ${first.text}` : ''}`);
      const where = h('span', 'msb-ed__pline', first ? `${hit.field} Ln ${first.line}` : hit.field);
      row.append(dot, msg, where);
      const open = () => window.open(hit.url, '_blank', 'noopener,noreferrer');
      row.addEventListener('click', open);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
      refList.appendChild(row);
    });
  }

  async function findAllReferences() {
    if (!tools.findReferences) {
      toast.error('Finding references is not available here.');
      return;
    }
    let ownName = '';
    if (table === 'sys_script_include') {
      const values = await callPage('getFormValues').catch(() => null);
      ownName = String(values?.values?.name || '').trim();
    }
    // A field or a table at the caret has a better answer than a text search (the table is known from the form or from
    // new GlideRecord('...')), so resolve the name the way F12 does first.
    let target = null;
    try {
      for (let round = 0; round < 3; round += 1) {
        const needs = collectNeeds(ta.value, ta.selectionStart, intelCtx());
        if (!needs.length) break;
        // eslint-disable-next-line no-await-in-loop -- dot-walked names need one table at a time.
        if (!(await ensureEditorData(needs))) break;
      }
      const def = getDefinitionTarget(ta.value, ta.selectionStart, intelCtx());
      if (def?.type === 'field' && tools.openFieldUsage) {
        tools.openFieldUsage(def.table, def.name);
        toast.info(`Where ${def.table}.${def.name} is used is open in the sidebar.`);
        return;
      }
      // A system property name opens the System properties panel (its value, who reads and sets it), not a text search.
      if (def?.type === 'property' && tools.openPanel && /^[A-Za-z0-9_.-]+$/.test(def.name) && tools.openPanel('properties', { args: def.name })) {
        toast.info(`The system property ${def.name} is open in the sidebar.`);
        return;
      }
      if (def?.type === 'table' && /^[a-z][a-z0-9_]*$/.test(def.name)) target = { kind: 'table', name: def.name };
      // `current` and `previous` come back as the API entry for the record; the table they stand for is the rule's table.
      const record = def?.type === 'api' && /^(?:current|previous):/.test(def.hover?.title || '') ? intelCtx().table : '';
      if (record && /^[a-z][a-z0-9_]*$/.test(record)) target = { kind: 'table', name: record };
    } catch {
      // Fall back to the plain reference search below.
    }
    if (!target) target = referenceTarget(ta.value, ta.selectionStart, { table, ownName });
    if (!target) {
      toast.error('Put the caret on a name of three or more characters first.');
      return;
    }
    refList.hidden = false;
    refList.replaceChildren(h('div', 'msb-ed__pempty', `Searching the instance for ${target.kind === 'method' ? `${target.className}.` : target.kind === 'table' ? 'scripts that use the table ' : ''}${target.name}…`));
    try {
      const result = await tools.findReferences(target, { excludeSysId: meta?.sysId || '' });
      renderRefs(result.hits, result.summary);
    } catch (err) {
      refList.hidden = true;
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
  // One question at a time: a second Esc or Ctrl+S while a dialog is open is a "no", never a second dialog.
  let asking = false;
  async function ask(options) {
    if (asking) return false;
    asking = true;
    try {
      return await askConfirm(options);
    } finally {
      asking = false;
    }
  }

  // One apply (and one save) at a time: a held Ctrl+S or a double click must not submit the form twice.
  let applying = false;
  async function apply(options) {
    if (applying) return false;
    applying = true;
    try {
      return await applyNow(options);
    } finally {
      applying = false;
    }
  }

  async function applyNow({ save = false } = {}) {
    const syntax = checkSyntax(ta.value);
    if (syntax && !(await ask(syntaxAsk('apply', syntax)))) {
      goToLine(syntax.line);
      return false;
    }
    if (save && tools.isProd?.() && !(await ask(prodApplySaveAsk()))) {
      return false;
    }
    try {
      await callPage('setFieldValue', [field.name, ta.value]);
      baseline = ta.value;
      refresh();
      if (save) {
        // A Script Include that would break its callers asks first; going back leaves the script applied but not saved.
        if (tools.beforeSave && !(await tools.beforeSave())) {
          toast.info('Applied to the form. Not saved.');
          return false;
        }
        await callPage('saveForm');
        savedRead += 1; // a read of the record that is still on its way holds the text from before this save
        savedText = ta.value;
        updateChanges();
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

  function showPanel(text, title = 'Output') {
    lintTitle.textContent = title;
    lintBody.textContent = text;
    lintBox.hidden = false;
  }

  function closeOutput() {
    lintBox.hidden = true;
    ta.focus();
  }

  async function copyOutput() {
    try {
      await navigator.clipboard.writeText(lintBody.textContent);
      toast.success('Output copied.');
    } catch {
      toast.error('The browser blocked copying here. Select the text and press Ctrl+C.');
    }
  }

  function runCheck() {
    if (ta.value.length > MAX_LINT_CHARS) {
      const syntax = checkSyntax(ta.value);
      showPanel(syntax ? `Syntax error on line ${syntax.line}: ${syntax.message}` : 'The script is too long for the full check; the syntax looks fine.', 'Report');
      return;
    }
    showPanel('Checking…', 'Report');
    // Let the panel paint first: the full check can take a moment on a long script.
    setTimeout(() => {
      const result = verifyScript({ code: ta.value, kind, when: rec.when, clientType: rec.clientType, scoped: rec.scoped === true, table: rec.target, fields: loadedFieldNames(rec.target) });
      showPanel(formatVerification(result, { maxFindings: 60 }), 'Report');
    }, 30);
  }

  function selectedText() {
    return ta.value.slice(ta.selectionStart, ta.selectionEnd);
  }

  // One run at a time: a held key or a second click must not start the script again while it runs.
  let running = false;
  async function run(dryRun) {
    if (running) {
      toast.info('The script is still running. Wait for its output first.');
      return;
    }
    running = true;
    try {
      await runNow(dryRun);
    } finally {
      running = false;
    }
  }

  async function runNow(dryRun) {
    const part = selectedText().trim();
    const script = part || ta.value;
    if (!script.trim()) return;
    const syntax = checkSyntax(script);
    if (syntax && !(await ask(syntaxAsk('run', syntax)))) return;
    if (!dryRun) {
      const risk = analyzeScriptRisk(script);
      const wanted = runScriptAsk({ part: Boolean(part), hostname: window.location.hostname, riskSummary: risk.hasWrites ? formatRiskSummary(risk) : '', prod: Boolean(tools.isProd?.()) });
      if (!(await ask(wanted))) return;
    } else {
      // A dry run only intercepts GlideRecord writes. Say so before running something it cannot hold back.
      const loose = analyzeScriptRisk(script).writes.filter((w) => w.unintercepted);
      if (loose.length) {
        const sure = await ask({
          title: 'A dry run cannot hold these back',
          message: 'A dry run only intercepts GlideRecord writes. This script also does the things below, and those would really happen.',
          details: loose.slice(0, 8).map((w) => `line ${w.line}: ${w.label}`).join('\n'),
          confirmLabel: 'Dry run anyway',
          danger: true,
        });
        if (!sure) return;
      }
    }
    const heading = `${dryRun ? 'Dry run' : 'Run'}: ${part ? 'selection' : 'script'}`;
    showPanel(dryRun ? 'Dry run in progress...' : 'Running...', heading);
    try {
      const output = await tools.runScript(script, { dryRun });
      showPanel(`${dryRun ? '[Dry run: GlideRecord writes are intercepted and listed below. Anything else the script does still happens.]\n\n' : ''}${output || '(no output)'}`, heading);
    } catch (err) {
      showPanel(`Run failed: ${err.message || err}`, heading);
    }
  }

  /** Ctrl+Shift+Enter: a dry run from the keyboard. It never runs for real, so no key press can change data. */
  function dryRunFromKeyboard() {
    if (!tools.runScript) {
      toast.error('Running scripts is not available here.');
      return;
    }
    run(true);
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

  // --- In place: the editor sits over the form's own field and keeps it in sync ---
  /** Write the editor's text into the form field (no save, no prompts). False when the form refused it. */
  async function pushToForm() {
    clearTimeout(syncTimer);
    if (!place || ta.readOnly || !isDirty()) return true;
    const value = ta.value;
    try {
      await callPage('setFieldValue', [field.name, value]);
      baseline = value;
      refresh();
      return true;
    } catch (err) {
      toast.error(`Could not update the form field: ${err.message || err}`);
      return false;
    }
  }

  function scheduleSync() {
    if (!place) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushToForm, SYNC_DELAY);
  }

  function layoutInPlace() {
    if (!place || overlay.hidden) return;
    const rect = place.rect();
    const box = rect && editorBox(rect, { width: window.innerWidth, height: window.innerHeight });
    dialog.style.visibility = box?.visible ? '' : 'hidden';
    if (!box) return;
    const key = `${box.left},${box.top},${box.width},${box.height}`;
    if (key === boxKey) return;
    boxKey = key;
    Object.assign(dialog.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  }

  function follow() {
    // Hidden (Ask AI, Compare) or closed: stop following; showing it again calls setPlace, which starts it again.
    if (overlay.hidden || !overlay.isConnected) {
      followFrame = 0;
      return;
    }
    layoutInPlace();
    followFrame = requestAnimationFrame(follow);
  }

  const placeButton = button('Full screen', 'msb-ed__btn', () => setPlace(place ? null : lastPlace));
  const applyButton = button('Apply to form', 'msb-ed__btn msb-ed__btn--primary', trustedDom(() => apply()));
  const saveButton = button('Apply & save', 'msb-ed__btn', trustedDom(() => apply({ save: true })));

  /** Switch between in place (a `place` object) and full screen (null). */
  function setPlace(next) {
    place = next || null;
    if (place) lastPlace = place;
    cancelAnimationFrame(followFrame);
    boxKey = '';
    dialog.removeAttribute('style');
    overlay.classList.toggle('msb-ed--inplace', Boolean(place));
    overlay.setAttribute('aria-modal', place ? 'false' : 'true');
    overlay.setAttribute('aria-label', place ? 'Script editor, in place' : 'Script editor');
    fieldSelect.hidden = Boolean(place);
    applyButton.hidden = Boolean(place);
    saveButton.textContent = place ? 'Save record' : 'Apply & save';
    saveButton.title = place ? 'Save the record (Ctrl+S)' : '';
    placeButton.hidden = !lastPlace;
    placeButton.textContent = place ? 'Full screen' : 'Back to field';
    placeButton.title = place ? 'Open the editor full screen' : 'Put the editor back over the field';
    hints.textContent = place
      ? 'Synced to the form as you type · Ctrl+S saves the record · F1 shortcuts · Esc close'
      : 'Ctrl+Space suggestions · F12 definition · Ctrl+Shift+O symbols · Ctrl+S apply · F1 all shortcuts · Esc close';
    if (place) {
      layoutInPlace();
      follow();
      pushToForm();
    }
    requestAnimationFrame(() => {
      measureChar();
      paint(true);
      refresh();
    });
  }

  async function close() {
    if (place) {
      if (!(await pushToForm())) return; // never lose edits the form did not take
    } else if (isDirty() && !(await ask(discardAsk('close')))) return;
    clearTimeout(diagTimer);
    clearTimeout(findTimer);
    clearTimeout(hoverTimer);
    clearTimeout(dataTimer);
    clearTimeout(syncTimer);
    clearTimeout(outlineTimer);
    cancelAnimationFrame(frame);
    cancelAnimationFrame(followFrame);
    resizeWatch?.disconnect();
    overlay.remove();
  }

  // "Changes since the record was loaded" compare with the record as saved on the instance, read once per load: the
  // form's own text may already hold edits (typed on the form, or synced from this editor before it was closed).
  let savedRead = 0;
  function readSavedBaseline(type) {
    const ask = (savedRead += 1);
    const name = field.name;
    callPage('getFormMeta')
      .catch(() => null)
      .then((now) => (now && now.table === table && !now.isNewRecord ? readSavedFieldValue({ table, sysId: now.sysId, field: name, type }) : null))
      .then((saved) => {
        if (saved === null || ask !== savedRead || field.name !== name || saved === savedText) return;
        savedText = saved;
        changesFor = null;
        updateChanges();
      })
      .catch(() => {});
  }

  async function loadField(name) {
    const state = await callPage('getFieldState', [name]);
    field = fields.find((f) => f.name === name) || field;
    // A textarea holds \n line breaks only; a value with \r\n would otherwise look edited the moment it loads (and in
    // place be written back to the form unasked).
    baseline = String(state?.value ?? '').replace(/\r\n?/g, '\n');
    savedText = baseline;
    readSavedBaseline(state?.type);
    extras = [];
    multiWord = false;
    multiLayer.replaceChildren();
    snippet = null;
    snipLayer.replaceChildren();
    ta.value = baseline;
    ta.readOnly = !!state?.readOnly;
    formatButton.disabled = ta.readOnly;
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

  function runQueuedAction() {
    const action = takeQueuedAction();
    if (!action) return;
    setTimeout(() => {
      if (action === 'outline') showOutline();
      else if (action === 'format') format();
    }, 200);
  }

  // --- Wiring ---
  const problemsToggle = button('Problems', 'msb-ed__btn', () => toggleProblems());
  problemsToggle.title = 'Problems found by the syntax, lint, API catalog and field checks (Ctrl+Shift+M)';
  const checkButton = button('Report', 'msb-ed__btn', runCheck);
  checkButton.title = 'Full verification report';
  const formatButton = button('Format', 'msb-ed__btn', () => format());
  formatButton.title = 'Format the script, or the selected lines: indentation, spacing, trailing blanks (Shift+Alt+F)';
  actions.append(button('Find', 'msb-ed__btn', () => showFind(findBar.hidden)), formatButton, problemsToggle, checkButton);
  if (tools.runScript) {
    const dry = button('Dry run', 'msb-ed__btn', trustedDom(() => run(true)));
    dry.title = 'Run the script (or the selection) with GlideRecord writes intercepted (Ctrl+Shift+Enter)';
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
  actions.append(placeButton, applyButton, saveButton, helpButton, button('Close', 'msb-ed__btn', close));
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
    if (isDirty() && !(await ask(discardAsk('switch')))) {
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
    if (!programmatic && extras.length) clearExtras(); // an edit the extra cursors did not take part in (cut, undo, drop)
    if (!snippetBusy) trackSnippet();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(refresh);
    scheduleSync();
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

    if (extras.length) {
      const verdict = multiKeydown(event);
      if (verdict === 'done') {
        event.preventDefault();
        return;
      }
      if (verdict === 'native') return; // typing and deleting: see the beforeinput handler
      if (verdict === 'normal') clearExtras();
    }

    if (ac.open && handlePopupKey(event)) {
      event.preventDefault();
      return;
    }
    if (key === 'Escape' && snippet) {
      event.preventDefault();
      endSnippet();
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
    if (key === 'F12') return handled(() => (event.shiftKey ? findAllReferences() : goToDefinition()));
    if (key === 'F8') return handled(() => nextProblem(event.shiftKey ? -1 : 1));
    if (key === 'F3' && event.altKey) return handled(() => jumpChange(event.shiftKey ? -1 : 1));
    if (key === 'F3') return handled(() => findNext(event.shiftKey));
    if (mod && key === '.') return handled(quickFixAtCaret);
    if (mod && event.shiftKey && (lower === 'm' || code === 'KeyM')) return handled(() => toggleProblems());
    if (mod && event.shiftKey && !event.altKey && (lower === 'o' || code === 'KeyO')) return handled(showOutline);
    if (mod && !event.shiftKey && (lower === 'g' || code === 'KeyG')) return handled(() => showGoto(true));
    if (mod && !event.shiftKey && (lower === 'f' || code === 'KeyF')) return handled(() => showFind(true));
    if (mod && !event.shiftKey && (lower === 'h' || code === 'KeyH')) return handled(() => showFind(true, true));
    // Apply / save only on a real keystroke, never on a page script's synthetic keydown.
    // In place the editor IS the field, so Ctrl+S saves the record like it would from the field itself.
    // A held key repeats: only the first press counts for apply, save and dry run.
    if (mod && (lower === 's' || code === 'KeyS')) return handled(() => !event.repeat && event.isTrusted && apply({ save: place ? true : event.shiftKey }));
    if (mod && event.shiftKey && key === 'Enter') return handled(() => event.isTrusted && !event.repeat && dryRunFromKeyboard());
    if (mod && key === 'Enter') {
      return handled(
        () =>
          event.isTrusted &&
          !event.repeat &&
          apply().then((ok) => {
            if (ok && !isDirty()) close();
          })
      );
    }
    // Tab indents, so from the keyboard there would be no way out to the buttons and lists: Ctrl+M switches Tab to moving the focus.
    if (mod && !event.shiftKey && !event.altKey && (lower === 'm' || code === 'KeyM')) {
      return handled(() => {
        tabMovesFocus = !tabMovesFocus;
        toast.info(tabMovesFocus ? 'Tab now moves the focus to the buttons. Ctrl+M again to indent with Tab.' : 'Tab indents again.');
      });
    }
    if (ta.readOnly) return undefined;

    if (mod && !event.shiftKey && !event.altKey && (lower === 'd' || code === 'KeyD')) return handled(selectNextOccurrence);
    if (mod && event.shiftKey && !event.altKey && (lower === 'l' || code === 'KeyL')) return handled(selectAllOccurrences);
    if (mod && !event.shiftKey && !event.altKey && (lower === 'l' || code === 'KeyL')) return handled(selectWholeLines);
    if (mod && !event.shiftKey && !event.altKey && (lower === 'j' || code === 'KeyJ')) return handled(joinSelectedLines);
    if (key === 'Tab' && !mod && !event.altKey && !tabMovesFocus) return handled(() => tab(event.shiftKey));
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

  outlineInput.addEventListener('input', () => renderOutline());
  outlineInput.addEventListener('keydown', (event) => {
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      moveOutline(key === 'ArrowDown' ? 1 : -1);
    } else if (key === 'PageDown' || key === 'PageUp') {
      event.preventDefault();
      moveOutline(key === 'PageDown' ? 8 : -8);
    } else if (key === 'Enter') {
      event.preventDefault();
      const hit = outlineShown[outlineActive];
      if (hit) jumpToSymbol(hit.sym);
    }
  });
  outlineBox.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!outlineBox.hidden && !outlineBox.contains(shadow.activeElement)) closeOutline(false);
    }, 0);
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
    else if (!outlineBox.hidden) closeOutline();
    else if (!lintBox.hidden) closeOutput();
    else if (!gotoBar.hidden) showGoto(false);
    else if (!findBar.hidden) showFind(false);
    else if (!hoverBox.hidden) hideHover();
    else close();
  });

  overlay.addEventListener('msb-show', (event) => {
    const want = event.detail || {};
    const other = want.field && want.field !== field.name ? fields.find((f) => f.name === want.field) : null;
    if (other && !isDirty()) {
      fieldSelect.value = other.name;
      field = other;
    }
    // A queued Format or Go to symbol (from the palette) waits for the field's text, or it would act on the old one.
    const loaded = !isDirty() ? loadField(field.name).catch(() => {}) : Promise.resolve();
    if (isDirty() && other) toast.info(`Apply or discard your changes to ${field.label || field.name} before editing ${other.label || other.name}.`);
    setPlace(want.place || null);
    updateChip();
    loaded.then(runQueuedAction);
    requestAnimationFrame(() => {
      measureChar();
      paint(true);
      paintSquiggles();
      ta.focus();
    });
  });

  dialog.append(header, findBar, gotoBar, body, problemList, refList, changesList, lintBox, footer, help, outlineBox);
  overlay.appendChild(dialog);
  shadow.appendChild(overlay);
  measureChar();
  updateKindChip();

  await loadField(field.name);
  setPlace(place);
  if (typeof ResizeObserver === 'function') {
    resizeWatch = new ResizeObserver(() => { if (place) { measureChar(); paint(true); } });
    resizeWatch.observe(surface);
  }
  loadContext();
  updateChip();
  requestAnimationFrame(() => {
    measureChar();
    paint(true);
    paintSquiggles();
    ta.focus();
  });
  runQueuedAction();
}
