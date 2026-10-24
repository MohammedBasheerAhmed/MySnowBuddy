// Command palette — the primary way to drive the extension.
//
// Opens over the page (inside the extension's Shadow DOM so instance CSS
// cannot bleed in), fuzzy-matches every registered command, and mixes in
// query-driven results: table lookups, pasted sys_ids, @user impersonation
// and /slash commands.
//
// Keyboard: Up/Down or Ctrl+N/P to move, Enter to run, Shift/Ctrl+Enter to
// open a navigation in a new tab, Alt+Enter to copy a navigation's link,
// Alt+1..9 to run the numbered result, Esc to close. On a "go to" result (a
// business rule, script include, ACL... found by name) Tab or Right Arrow opens
// its actions: open, new tab, edit the script, where it is used, versions, copy.
//
// Ranking learns from use: commands you run often and lately rise to the top
// of the empty palette and of ties in a search. Any search also ends with
// fallbacks (ask the AI, search the API catalog, search instance code), so
// the palette never dead-ends.

import { buildCommands, buildProviders, slashCommand, GROUPS } from './commands.js';
import { SPECIAL_VERBS, findCommand } from '../lib/slashCommands.js';
import { buildStoredCommands, goToDefinitionCommand, goToProvider, goToActions, resumePendingEdit, STORED_GROUPS } from './storedCommands.js';
import { slashNavProvider } from './slashBar.js';
import { encodedQueryProvider } from './queryTools.js';
import { scaffoldProvider } from './scaffoldCommands.js';
import { buildInstanceCommands, instanceSwitchProvider } from './instanceSwitch.js';
import { navigate, absoluteUrl, copyText, isSysId } from './quickActions.js';
import { recordCommandUse, getUiState, saveUiState } from './storage.js';
import { frecency, rankRecent, matchPositions, highlightRuns, looksLikeCode } from '../lib/paletteRank.js';
import { intentText, queryWords, wordsScore } from '../lib/paletteIntents.js';
import { pageKind, pageSuggestions, suggestFor, SUGGESTED_TITLES } from '../lib/paletteContext.js';
import { createIcon } from './icons.js';
import { trustedDom } from '../sidebar/trusted.js';
import { UI_HOST_ID } from './uiRoot.js';
import { visibleTo, tierNote } from '../lib/roleTier.js';

const GROUP_ICONS = {
  Pinned: 'pin',
  ...Object.fromEntries(Object.values(SUGGESTED_TITLES).map((title) => [title, 'command'])),
  Recent: 'clock',
  [GROUPS.record]: 'record',
  [GROUPS.table]: 'table',
  [GROUPS.analyze]: 'analyze',
  [GROUPS.ai]: 'ai',
  [GROUPS.navigate]: 'navigate',
  [GROUPS.instance]: 'instance',
  [GROUPS.tools]: 'tools',
  [STORED_GROUPS.bookmarks]: 'navigate',
  [STORED_GROUPS.recent]: 'clock',
  [STORED_GROUPS.library]: 'ai',
};

const PROVIDER_DEBOUNCE_MS = 180;
const GOTO_DEBOUNCE_MS = 240; // name searches wait a little longer: each one is several requests
// While the actions of a result are open, these keys belong to them.
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Tab', 'Home', 'End']);
const MAX_RESULTS = 40;
const ALL_COMMANDS_SHOWN = 200;
const RECENT_SHOWN = 6;
const QUICK_KEYS = 9; // Alt+1..Alt+9
const FALLBACK_GROUP = 'Anything else';

// Alt changes event.key on some layouts, so the digit comes from the physical key.
const quickIndex = (event) => {
  const m = event.altKey && !event.ctrlKey && !event.metaKey ? /^(?:Digit|Numpad)([1-9])$/.exec(event.code || '') : null;
  return m ? Number(m[1]) - 1 : -1;
};

// Alt+P pins or unpins the highlighted action (read from event.code: Alt changes event.key on some layouts).
const isPinKey = (event) => event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyP';

export function createCommandPalette(deps) {
  const { getContext, sidebar, toast } = deps;

  const overlay = document.createElement('div');
  overlay.className = 'msb-palette';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'NowBuddy command palette');
  overlay.hidden = true;

  // Built node-by-node rather than with innerHTML: ServiceNow pages can carry
  // a Trusted Types policy, and an isolated-world innerHTML assignment is a
  // habit worth not forming in a extension that renders instance data.
  const backdrop = el('div', 'msb-palette__backdrop');
  backdrop.setAttribute('data-msb-close', '1');

  const dialog = el('div', 'msb-palette__dialog');
  const inputRow = el('div', 'msb-palette__inputRow');
  const icon = el('span', 'msb-palette__icon');
  icon.appendChild(createIcon('search', 17));

  const input = document.createElement('input');
  input.className = 'msb-palette__input';
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = 'Search, or describe what you need: "who changed this", /tn incident, a sys_id';
  input.setAttribute('aria-label', 'Command');
  // A combobox over a listbox: the highlighted option is announced as arrow keys move it, focus stays in the input.
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-haspopup', 'listbox');
  input.setAttribute('aria-expanded', 'true');

  const escHint = el('kbd', 'msb-palette__esc', 'Esc');
  const modeChip = el('span', 'msb-palette__mode');
  modeChip.hidden = true;
  inputRow.append(icon, input, modeChip, escHint);

  const resultsEl = el('div', 'msb-palette__results');
  resultsEl.setAttribute('role', 'listbox');
  resultsEl.id = 'msb-palette-results';
  resultsEl.setAttribute('aria-label', 'Results');
  input.setAttribute('aria-controls', resultsEl.id);

  const footer = el('div', 'msb-palette__footer');
  // The new-tab and copy-link hints only apply to navigations, so they follow the highlighted row.
  const urlHints = el('span', 'msb-palette__hintGroup');
  urlHints.append(hintGroup(['Shift', 'Enter'], 'new tab'), hintGroup(['Alt', 'Enter'], 'copy link'));
  urlHints.hidden = true;
  // Tab opens the actions of a result found by name; shown only while one is highlighted.
  const actionHints = hintGroup(['Tab'], 'actions');
  actionHints.classList.add('msb-palette__hintGroup--actions');
  actionHints.hidden = true;
  footer.append(
    hintGroup(['\u2191', '\u2193'], 'navigate'),
    hintGroup(['Enter'], 'run'),
    urlHints,
    actionHints,
    hintGroup(['Alt', '1-9'], 'jump'),
    hintGroup(['Alt', 'P'], 'pin')
  );
  const contextEl = el('span', 'msb-palette__context');
  footer.appendChild(contextEl);

  dialog.append(inputRow, resultsEl, footer);
  overlay.append(backdrop, dialog);

  let commands = [];
  let results = [];
  let grouped = true;
  let activeIndex = 0;
  let providers = [];
  let providerTimer = null;
  let recents = [];
  let pinned = [];
  let pageCtx = {};
  let stats = {};
  // "Go to anything": name searches run on their own pipeline so a slow table never delays the other results, and
  // their rows appear as each kind answers.
  let goTo = null;
  let goToRows = [];
  let goToTimer = null;
  let goToRunner = null;
  let lastDynamic = [];
  let menu = null; // { index, rowId, active, actions: [{ id, label, hint }] }: the actions of a highlighted result
  let moved = false; // the user moved the highlight since the text last changed
  const searchProviders = latestOnly((term) => Promise.allSettled(providers.map((provider) => provider(term))));

  // The page that was open when the palette was created may be waiting for the editor ("Open it, then edit the script").
  resumePendingEdit({ getContext, openScriptEditor: deps.openScriptEditor, toast });

  overlay.addEventListener('mousedown', (event) => {
    if (event.target.hasAttribute('data-msb-close')) close();
    else if (event.target !== input) setTimeout(() => focusInput(), 0);
  });

  input.addEventListener('input', () => {
    closeMenu({ redraw: false });
    updateMode();
    moved = false;
    lastDynamic = [];
    // The rows already fetched narrow at once while the next letter's request is on its way.
    goToRows = goTo ? goTo.instant(input.value) : [];
    render();
    scheduleProviders();
  });

  function updateMode() {
    const v = input.value;
    const label = v.startsWith('/') ? 'Shortcut' : v.startsWith('@') ? 'Impersonate' : /^[0-9a-f]{32}$/i.test(v.trim()) ? 'sys_id' : goTo ? goTo.modeLabel(v) : '';
    modeChip.textContent = label;
    modeChip.hidden = !label;
  }

  // The page can swallow arrows and Enter before they reach the input, so catch them at the window.
  const NAV_KEYS = new Set(['Escape', 'ArrowDown', 'ArrowUp', 'Enter', 'Home', 'End']);
  window.addEventListener(
    'keydown',
    (event) => {
      // A page script's synthetic Enter must not run the selected command (impersonate, switch, ...).
      if (overlay.hidden || event.isComposing || !event.isTrusted) return;
      const letter = event.key.toLowerCase();
      if (!NAV_KEYS.has(event.key) && !(event.ctrlKey && (letter === 'n' || letter === 'p')) && quickIndex(event) === -1 && !isPinKey(event) && !isMenuKey(event)) return;
      event.stopImmediatePropagation();
      onKeyDown(event);
    },
    true
  );

  // Tab or Right Arrow (with the caret at the end of the text) open the actions of a "go to" result; while they are
  // open, the arrows, Enter, Esc and Tab belong to them.
  function isMenuKey(event) {
    if (menu) return MENU_KEYS.has(event.key);
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !results[activeIndex]?.goTo) return false;
    if (event.key === 'Tab') return true;
    return event.key === 'ArrowRight' && input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
  }

  function onKeyDown(event) {
    const key = event.key;
    if (menu && handleMenuKey(event)) return;
    if (!menu && (key === 'Tab' || key === 'ArrowRight') && isMenuKey(event)) {
      event.preventDefault();
      openMenu(activeIndex);
      return;
    }
    if (isPinKey(event)) {
      event.preventDefault();
      togglePin(results[activeIndex]);
      return;
    }
    const quick = quickIndex(event);
    if (quick !== -1) {
      event.preventDefault();
      execute(results[quick], false);
      return;
    }
    if (key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (key === 'ArrowDown' || (event.ctrlKey && key.toLowerCase() === 'n')) {
      event.preventDefault();
      move(1);
      return;
    }
    if (key === 'ArrowUp' || (event.ctrlKey && key.toLowerCase() === 'p')) {
      event.preventDefault();
      move(-1);
      return;
    }
    if (key === 'Home') {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (key === 'End') {
      event.preventDefault();
      setActive(results.length - 1);
      return;
    }
    if (key === 'Enter') {
      event.preventDefault();
      if (event.altKey) copyLink(results[activeIndex]);
      else execute(results[activeIndex], event.shiftKey || event.ctrlKey || event.metaKey);
    }
  }

  // Alt+Enter: put a navigation's address on the clipboard instead of following it.
  async function copyLink(command) {
    if (!command) return;
    if (!command.url && !command.copyUrl) {
      toast.info('This action has no link to copy.');
      return;
    }
    close();
    try {
      await copyText(command.copyUrl || absoluteUrl(command.url));
      toast.success('Copied link');
    } catch (err) {
      toast.error(err.message || String(err));
    }
  }

  // Pinned actions open at the top of the palette. Only built-in actions can be pinned: records, bookmarks and
  // search hits change from page to page.
  async function togglePin(command) {
    if (!command) return;
    if (!commands.some((c) => c.id === command.id) || command.id.startsWith('recent.') || command.id.startsWith('bookmark.')) {
      toast.info('Only actions can be pinned, not records or search results.');
      return;
    }
    const wasPinned = pinned.includes(command.id);
    pinned = wasPinned ? pinned.filter((id) => id !== command.id) : [...pinned, command.id].slice(-8);
    await saveUiState({ pinnedCommands: pinned });
    toast.success(wasPinned ? `Unpinned "${command.title}"` : `Pinned "${command.title}". It now opens at the top.`);
    const keep = command.id;
    render();
    const at = results.findIndex((r) => r.id === keep);
    if (at !== -1) setActive(at);
  }

  function move(delta) {
    if (!results.length) return;
    const next = (activeIndex + delta + results.length) % results.length;
    setActive(next);
  }

  // ---- Actions of a "go to" result -----------------------------------------------------------------------------
  function openMenu(index) {
    const row = results[index];
    const actions = goToRunner && row?.goTo ? goToRunner.list(row) : [];
    if (!actions.length) return;
    menu = { index, rowId: row.id, active: 0, actions };
    paint();
    syncMenuActive();
  }

  function closeMenu({ redraw = true } = {}) {
    if (!menu) return;
    menu = null;
    // Results that arrived while the actions were open are drawn now.
    if (redraw) render(lastDynamic, { keepActive: true });
  }

  // The menu's items are not focused (focus stays in the input); aria-activedescendant announces the highlighted one.
  function syncMenuActive() {
    if (!menu) return;
    resultsEl.querySelectorAll('.msb-palette__menuItem').forEach((node, i) => {
      node.classList.toggle('msb-palette__menuItem--active', i === menu.active);
      node.setAttribute('aria-selected', String(i === menu.active));
      if (i === menu.active) {
        input.setAttribute('aria-activedescendant', node.id);
        node.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function handleMenuKey(event) {
    const key = event.key;
    const letter = key.toLowerCase();
    if (key === 'ArrowDown' || key === 'ArrowUp' || (event.ctrlKey && (letter === 'n' || letter === 'p'))) {
      event.preventDefault();
      const delta = key === 'ArrowUp' || letter === 'p' ? -1 : 1;
      menu.active = (menu.active + delta + menu.actions.length) % menu.actions.length;
      syncMenuActive();
      return true;
    }
    if (key === 'Home' || key === 'End') {
      event.preventDefault();
      menu.active = key === 'Home' ? 0 : menu.actions.length - 1;
      syncMenuActive();
      return true;
    }
    if (key === 'Enter' && !event.altKey) {
      event.preventDefault();
      runMenuAction(menu.active);
      return true;
    }
    if (key === 'Escape' || key === 'ArrowLeft' || key === 'Tab' || key === 'ArrowRight') {
      event.preventDefault();
      closeMenu();
      return true;
    }
    return false;
  }

  async function runMenuAction(actionIndex) {
    if (!menu) return;
    const row = results[menu.index];
    const action = menu.actions[actionIndex];
    close();
    if (!row || !action) return;
    try {
      await goToRunner.run(action.id, row);
    } catch (err) {
      toast.error(err.message || String(err));
    }
  }

  function buildMenu() {
    // A group of options inside the same listbox, so the screen reader reads them as part of the results.
    const list = el('div', 'msb-palette__menu');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', `Actions for ${results[menu.index]?.title || 'this result'}`);
    menu.actions.forEach((action, i) => {
      const node = el('div', 'msb-palette__menuItem');
      node.id = `msb-palette-menu-${i}`;
      node.setAttribute('role', 'option');
      node.setAttribute('aria-selected', 'false');
      node.appendChild(el('span', 'msb-palette__menuLabel', action.label));
      node.appendChild(el('span', 'msb-palette__menuHint', action.hint || ''));
      node.addEventListener('mousemove', (event) => {
        if ((event.movementX || event.movementY) && menu && menu.active !== i) {
          menu.active = i;
          syncMenuActive();
        }
      });
      node.addEventListener('click', trustedDom(() => runMenuAction(i)));
      list.appendChild(node);
    });
    return list;
  }

  function setActive(index) {
    moved = true;
    activeIndex = Math.max(0, Math.min(index, results.length - 1));
    resultsEl.querySelectorAll('.msb-palette__item').forEach((el, i) => {
      el.classList.toggle('msb-palette__item--active', i === activeIndex);
      el.setAttribute('aria-selected', String(i === activeIndex));
      if (i === activeIndex) {
        el.scrollIntoView({ block: 'nearest' });
        input.setAttribute('aria-activedescendant', el.id);
      }
    });
    urlHints.hidden = !(results[activeIndex]?.url || results[activeIndex]?.copyUrl);
    actionHints.hidden = !results[activeIndex]?.goTo;
  }

  async function execute(command, newTab) {
    if (!command) return;
    // A note ("Searching...", "Business Rules cannot be read here") has nothing to run; the palette stays open.
    if (command.status) return;
    close();
    try {
      // Only the registered actions are worth learning; one-off results (a sys_id, a user, a typed query) are not.
      if (commands.some((c) => c.id === command.id)) recordCommandUse(command.id);
      if (command.url) {
        navigate(command.url, { newTab: newTab || command.newTab, raw: command.raw });
        return;
      }
      // Shift/Ctrl/Cmd+Enter asks for a new tab; actions that do not care ignore the argument.
      await command.run({ newTab: Boolean(newTab) });
    } catch (err) {
      toast.error(err.message || String(err));
    }
  }

  function scheduleProviders() {
    clearTimeout(providerTimer);
    clearTimeout(goToTimer);
    // Results still in flight are for the old text; they must not land after this keystroke.
    searchProviders.cancel();
    goTo?.cancel();
    const query = input.value;
    // The list for a lone "/" is local and cheap: it should not wait out the debounce that spares the instance.
    providerTimer = setTimeout(() => runProviders(query), query.trim() === '/' ? 0 : PROVIDER_DEBOUNCE_MS);
    goToTimer = setTimeout(() => runGoTo(query), GOTO_DEBOUNCE_MS);
  }

  // Name search ("go to anything"): rows arrive as each kind answers, and the next keystroke cancels this run.
  async function runGoTo(query) {
    if (!goTo || overlay.hidden || input.value !== query) return;
    const paintRows = (rows) => {
      if (overlay.hidden || input.value !== query) return;
      if (!rows.length && !goToRows.length) return;
      goToRows = rows;
      // With the actions of a result open, the list stays put; it is redrawn when they close.
      if (!menu) render(lastDynamic, { keepActive: true });
    };
    const rows = await goTo.search(query.trim(), paintRows);
    if (rows) paintRows(rows);
  }

  async function runProviders(query) {
    const term = query.trim();
    if (!term) return;

    const settled = await searchProviders(term);
    if (!settled || overlay.hidden) return;

    const dynamic = settled
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r) => r.value || []);
    if (!dynamic.length) return;

    lastDynamic = dynamic;
    // With the actions of a result open the list stays put (a redraw could move that row away under the keys);
    // closing them draws these rows.
    if (!menu) render(dynamic, { keepActive: true });
  }

  function render(dynamic = [], { keepActive = false } = {}) {
    const query = input.value.trim();
    const scored = [];
    grouped = !query;
    // A redraw only because more results arrived keeps the highlight on the row it was on, unless that row is gone.
    const keepId = keepActive && moved && activeIndex > 0 ? results[activeIndex]?.id : null;

    if (!query) {
      const recentSet = new Map(commands.map((c) => [c.id, c]));
      // Pinned, then what suits the page on screen (the palette shows about seven rows, so this must not sit below
      // a long history), then what was used lately, then everything else.
      pinned
        .map((id) => recentSet.get(id))
        .filter(Boolean)
        .forEach((cmd) => scored.push({ ...cmd, group: 'Pinned', score: 20000 }));
      const kind = pageKind(pageCtx);
      suggestFor(pageCtx, commands, 4).forEach((cmd) => scored.push({ ...cmd, group: SUGGESTED_TITLES[kind], score: 10000 }));
      recents
        .filter((id) => !pinned.includes(id))
        .map((id) => recentSet.get(id))
        .filter(Boolean)
        .forEach((cmd) => scored.push({ ...cmd, group: 'Recent', score: 5000 }));
      // The record on screen is not a "recent record" worth listing.
      const hereId = pageCtx.sysId ? `recent.${pageCtx.sysId}` : '';
      commands
        .filter((cmd) => cmd.id.startsWith('recent.') && cmd.id !== hereId && !recents.includes(cmd.id))
        .slice(0, 4)
        .forEach((cmd) => scored.push({ ...cmd, score: 4000 }));
      commands.forEach((cmd) => {
        if (recents.includes(cmd.id) || cmd.id.startsWith('recent.')) return;
        scored.push({ ...cmd, score: 0 });
      });
    } else {
      // "Send this to the chat" is only the answer for a slash command the palette does not handle itself;
      // for /tn, /sys, /props and the like it is a confusing extra row.
      const verb = query.startsWith('/') ? query.slice(1).split(/\s+/)[0].toLowerCase() : '';
      const handledHere = verb && (SPECIAL_VERBS.some(([name]) => name === verb) || findCommand(verb));
      const slash = handledHere ? null : slashCommand(query, sidebar);
      if (slash) scored.push(slash);
      dynamic.forEach((cmd) => scored.push(cmd));
      goToRows.forEach((cmd) => scored.push(cmd));
      // A record found by name replaces its "recent record" row.
      const foundHere = new Set(goToRows.map((cmd) => cmd.goTo?.sysId).filter(Boolean));
      // Two or more words describe a problem ("who changed this"): every word must be found, in any order.
      // A loose character match across that much text would match nearly everything.
      const multiWord = queryWords(query).length >= 2;
      const onPage = new Set(pageSuggestions(pageCtx));
      commands.forEach((cmd) => {
        // A lone "/" asks for the list of commands; a loose text match on "/" would only add noise below it.
        if (query === '/') return;
        if (foundHere.size && cmd.id.startsWith('recent.') && foundHere.has(cmd.id.slice('recent.'.length))) return;
        const rest = `${cmd.hint || ''} ${cmd.keywords || ''} ${intentText(cmd.id)}`;
        // The exact text may be anywhere (title, hint, keywords, problem phrases). A loose "letters in order" match is
        // only trusted on the title: across all that text it matches nearly everything for a name like AssessmentUtils.
        const score =
          fuzzyScore(query, `${cmd.title} ${rest}`, { loose: false }) ||
          (multiWord ? wordsScore(query, cmd.title, rest) : fuzzyScore(query, cmd.title));
        // Use history only breaks near-ties: it can lift a command past a slightly better match, never past a different tier.
        // Of two equal answers, the one that suits this page wins ("where is this used" on a script include).
        const pageBoost = onPage.has(cmd.id) ? 60 : 0;
        if (score > 0) scored.push({ ...cmd, score: score + pageBoost + Math.min(80, frecency(stats[cmd.id]) * 12) });
      });
      scored.sort((a, b) => b.score - a.score);
    }

    const fallbacks = query ? fallbackCommands(query) : [];
    // "/" alone lists every command, which is more than a search result list holds.
    const cap = query === '/' ? ALL_COMMANDS_SHOWN : MAX_RESULTS;
    results = [...dedupe(scored).slice(0, cap - fallbacks.length), ...fallbacks];
    // The first row that does something: a note ("Searching...", "cannot be read here") is not the default for Enter.
    activeIndex = Math.max(0, results.findIndex((r) => !r.status));
    if (keepId) {
      const at = results.findIndex((r) => r.id === keepId);
      if (at !== -1) activeIndex = at;
    }
    if (menu && results[menu.index]?.id !== menu.rowId) menu = null; // the row the actions belonged to moved or went
    paint();
  }

  // What to offer after the matches, so a query that names no command still leads somewhere.
  function fallbackCommands(typed) {
    // After a prefix ("br: closed") the fallbacks are about what follows it.
    const query = goTo ? goTo.stripPrefix(typed) : typed;
    if (query.length < 2 || query.startsWith('/') || query.startsWith('@') || isSysId(query)) return [];
    const shown = query.length > 34 ? `${query.slice(0, 33)}…` : query;
    const open = (fn) => () => fn(query);
    const rows = [
      { id: 'fallback.ask', title: `Ask AI: “${shown}”`, hint: 'Send it to the chat sidebar', group: FALLBACK_GROUP, icon: 'ai', run: open((q) => sidebar.runCommand(q)) },
      { id: 'fallback.api', title: `Look up “${shown}” in the API catalog`, hint: 'GlideRecord, g_form, gs and more', group: FALLBACK_GROUP, icon: 'search', run: () => { sidebar.openForTool(); sidebar.openApiPanel(query); } },
      { id: 'fallback.code', title: `Search instance code for “${shown}”`, hint: 'Every script field', group: FALLBACK_GROUP, icon: 'search', run: () => { sidebar.openForTool(); sidebar.openSearchPanel(query); } },
    ];
    // Code goes to the free lookups first; asking the AI needs a key and is a worse first guess for `current.setValue`.
    return looksLikeCode(query) ? [rows[1], rows[2], rows[0]] : rows;
  }

  function paint() {
    resultsEl.replaceChildren();
    const query = grouped ? '' : input.value.trim();

    if (!results.length) {
      const empty = el('div', 'msb-palette__empty');
      empty.appendChild(el('div', null, 'No matching action.'));
      const tips = el('div', 'msb-palette__emptyTips');
      [
        ['who changed this', 'describe the problem'],
        ['incident', 'open a table'],
        ['si: AjaxUtil', 'find a script, rule or ACL by name'],
        ['/tn table', 'list with a filter'],
        ['a sys_id', 'jump to the record'],
        ['@user', 'impersonate'],
        ['/', 'all shortcuts'],
      ].forEach(([token, meaning]) => {
        const tip = el('span', 'msb-palette__emptyTip');
        tip.appendChild(el('code', null, token));
        tip.appendChild(el('span', null, meaning));
        tips.appendChild(tip);
      });
      empty.appendChild(tips);
      resultsEl.appendChild(empty);
      return;
    }

    let lastGroup = null;
    results.forEach((cmd, index) => {
      if (grouped && cmd.group !== lastGroup) {
        lastGroup = cmd.group;
        const header = document.createElement('div');
        header.className = 'msb-palette__group';
        header.textContent = cmd.group;
        resultsEl.appendChild(header);
      }

      const item = document.createElement('div');
      item.className = 'msb-palette__item';
      item.setAttribute('role', 'option');
      item.id = `msb-palette-opt-${index}`;
      item.setAttribute('aria-selected', String(index === activeIndex));
      if (index === activeIndex) {
        item.classList.add('msb-palette__item--active');
        input.setAttribute('aria-activedescendant', item.id);
      }

      const iconWrap = el('span', 'msb-palette__itemIcon');
      const iconName = cmd.icon || GROUP_ICONS[cmd.group] || 'record';
      item.dataset.icon = iconName; // the icon name picks the category colour
      if (cmd.swatch) {
        // An instance: its colour with its first letter, the same tile as the tab icon.
        iconWrap.classList.add('msb-palette__itemIcon--swatch');
        iconWrap.style.background = cmd.swatch;
        iconWrap.textContent = String(cmd.title || '?').replace(/^Go to /, '').charAt(0).toUpperCase();
      } else {
        iconWrap.appendChild(createIcon(iconName, 15));
      }
      item.appendChild(iconWrap);

      const title = document.createElement('span');
      title.className = 'msb-palette__title';
      // A result found by name carries its own highlight (whole words; empty when only another name matched).
      const hits = cmd.hits || (query && cmd.group !== FALLBACK_GROUP ? matchPositions(query, cmd.title) : []);
      if (hits.length) {
        // Text nodes and <mark>s only: instance data never goes through innerHTML.
        highlightRuns(cmd.title, hits).forEach((run) => title.appendChild(run.hit ? el('mark', 'msb-palette__hl', run.text) : document.createTextNode(run.text)));
      } else {
        title.textContent = cmd.title;
      }
      item.appendChild(title);

      // Always rendered, even when empty: it is the flexible spacer that keeps
      // the trailing badges right-aligned.
      const hint = document.createElement('span');
      hint.className = 'msb-palette__hint';
      hint.textContent = cmd.hint || '';
      item.appendChild(hint);

      // When results are score-sorted the groups interleave, so the group is
      // shown per row instead of as a header.
      if (!grouped && cmd.group && !cmd.kindLabel) {
        const tag = document.createElement('span');
        tag.className = 'msb-palette__badge';
        tag.textContent = cmd.group;
        item.appendChild(tag);
      }

      // A result found by name: what kind of thing it is, and whether it is switched off.
      if (cmd.kindLabel) item.appendChild(el('span', 'msb-palette__badge msb-palette__badge--kind', cmd.kindLabel));
      if (cmd.inactive) {
        item.classList.add('msb-palette__item--inactive');
        item.appendChild(el('span', 'msb-palette__badge msb-palette__badge--inactive', 'inactive'));
      }
      if (cmd.status) item.classList.add('msb-palette__item--status');

      if (cmd.badge) item.appendChild(el('span', 'msb-palette__badge', cmd.badge));
      if (!grouped && pinned.includes(cmd.id)) item.appendChild(el('span', 'msb-palette__badge', 'pinned'));
      if (cmd.url && !cmd.kindLabel) {
        const badge = document.createElement('span');
        badge.className = 'msb-palette__badge msb-palette__badge--open';
        badge.textContent = 'open';
        item.appendChild(badge);
      }

      if (index < QUICK_KEYS) item.appendChild(el('kbd', 'msb-palette__num', String(index + 1)));

      // Hover moves the highlight only when the mouse really moves. When the list redraws under a pointer that is
      // resting there, the browser reports a mouse event with no movement; following it would silently change which
      // row Enter runs.
      item.addEventListener('mousemove', (event) => {
        if (!event.movementX && !event.movementY) return;
        if (index !== activeIndex && !menu) setActive(index);
      });
      item.addEventListener('click', trustedDom((event) => execute(cmd, event.shiftKey || event.ctrlKey || event.metaKey)));
      resultsEl.appendChild(item);
      // The actions of the highlighted result open right under it.
      if (menu && menu.index === index) resultsEl.appendChild(buildMenu());
    });
    urlHints.hidden = !(results[activeIndex]?.url || results[activeIndex]?.copyUrl);
    actionHints.hidden = !results[activeIndex]?.goTo;
    syncMenuActive();
  }

  // ServiceNow (and the classic gsft_main iframe) can hold focus, so retry until the input has it.
  function focusInput(attempt = 0) {
    if (overlay.hidden) return;
    window.focus();
    input.focus({ preventScroll: true });
    if (overlay.getRootNode().activeElement !== input && attempt < 8) {
      setTimeout(() => focusInput(attempt + 1), 40);
    }
  }

  document.addEventListener(
    'focusin',
    (event) => {
      if (overlay.hidden) return;
      if (event.target !== overlay.getRootNode().host) input.focus({ preventScroll: true });
    },
    true
  );

  // The element that had focus before the palette opened, so closing it hands the focus back (a classic form lives
  // in a same-origin iframe: look inside it).
  let returnFocus = null;
  function activeElementDeep() {
    let doc = document;
    let node = doc.activeElement;
    for (let depth = 0; depth < 4 && node && node.tagName === 'IFRAME'; depth += 1) {
      try {
        doc = node.contentDocument;
        node = doc?.activeElement;
      } catch {
        break; // cross-origin frame
      }
    }
    return node;
  }

  async function open(prefill = '') {
    if (overlay.hidden) returnFocus = activeElementDeep();
    const ctx = safeContext(getContext);
    const tier = await deps.roleAccess?.ready().catch(() => null);
    const stored = await buildStoredCommands({ ...deps, ctx }).catch(() => []);
    const instances = await buildInstanceCommands().catch(() => []);
    const definition = goToDefinitionCommand({ ctx, toast });
    commands = [...buildCommands({ ...deps, ctx, openPalette: (text) => open(text) }), ...(definition ? [definition] : []), ...stored, ...instances];
    // Tools the user's roles cannot use are left out; one row says so and why.
    commands = visibleTo(tier, commands);
    const hiddenNote = tierNote(tier);
    if (hiddenNote) {
      commands.push({
        id: 'help.roles',
        title: 'Why are some tools hidden?',
        hint: `Your tools follow your ServiceNow roles (${tier})`,
        group: GROUPS.tools,
        keywords: 'role roles hidden missing permission admin developer access tools not showing',
        run: () => toast.info(hiddenNote),
      });
    }
    // Names (rules, script includes, ACLs...) are searched by the go-to pipeline above, not by a provider here.
    goTo = goToProvider({ ctx, tier });
    goTo.reset();
    goToRunner = goToActions({ sidebar, toast, openScriptEditor: deps.openScriptEditor, ctx });
    goToRows = [];
    lastDynamic = [];
    menu = null;
    moved = false;
    providers = [
      ...buildProviders({ ...deps, ctx }),
      encodedQueryProvider({ ctx, toast }),
      scaffoldProvider({ ctx, toast, reopen: (text) => open(text) }),
      instanceSwitchProvider({ toast }),
      slashNavProvider({
        roleAccess: deps.roleAccess,
        ctx,
        sidebar,
        reopen: (text) => open(text),
        openScriptEditor: deps.openScriptEditor,
        startFileSync: deps.startFileSync,
        toggleFieldNames: deps.toggleFieldNames,
        toast,
        getCsrfToken: deps.getCsrfToken,
      }),
    ];
    const ui = await getUiState();
    stats = ui.commandStats || {};
    recents = rankRecent(stats, ui.recentCommands || [], RECENT_SHOWN);
    pinned = Array.isArray(ui.pinnedCommands) ? ui.pinnedCommands : [];
    pageCtx = ctx;

    contextEl.textContent = ctx.table
      ? `${ctx.table}${ctx.sysId ? ` · ${ctx.sysId.slice(0, 8)}…` : ''}`
      : '';

    overlay.hidden = false;
    deps.onOpenChange?.(true);
    input.value = prefill;
    updateMode();
    render();
    if (prefill) scheduleProviders();
    // Focus has to wait for the element to be laid out inside the shadow root.
    focusInput();
  }

  function close() {
    const wasOpen = !overlay.hidden;
    overlay.hidden = true;
    if (wasOpen && returnFocus && returnFocus !== document.body && returnFocus.isConnected && returnFocus.id !== UI_HOST_ID) {
      try {
        returnFocus.focus({ preventScroll: true });
      } catch {
        // The element left the page.
      }
    }
    returnFocus = null;
    deps.onOpenChange?.(false);
    input.value = '';
    results = [];
    resultsEl.replaceChildren();
    // Stop name searches and forget their results (they are kept per open palette).
    clearTimeout(goToTimer);
    goTo?.cancel();
    goTo?.reset();
    goToRows = [];
    lastDynamic = [];
    menu = null;
  }

  function toggle(prefill) {
    if (overlay.hidden) open(prefill);
    else close();
  }

  return {
    element: overlay,
    open,
    close,
    toggle,
    isOpen: () => !overlay.hidden,
    handleKey: (key) => !overlay.hidden && onKeyDown({ preventDefault() {}, ...key }),
  };
}

/**
 * Latest-wins wrapper for an async search. A run superseded by a newer one, or
 * cancelled because the query changed, resolves to null, so stale results are
 * never painted (before, a slow run for "inc" could land after the user typed
 * "incident" and stay on screen when the newer run found nothing).
 */
export function latestOnly(fn) {
  let seq = 0;
  const run = async (...args) => {
    const id = ++seq;
    const result = await fn(...args);
    return id === seq ? result : null;
  };
  run.cancel = () => {
    seq += 1;
  };
  return run;
}

function safeContext(getContext) {
  try {
    return getContext() || {};
  } catch (err) {
    return {};
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function hintGroup(keys, label) {
  const wrap = el('span', 'msb-palette__hintGroup');
  keys.forEach((key) => wrap.appendChild(el('kbd', null, key)));
  wrap.appendChild(el('span', null, ` ${label}`));
  return wrap;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((cmd) => {
    if (seen.has(cmd.id)) return false;
    seen.add(cmd.id);
    return true;
  });
}

/**
 * Subsequence fuzzy match with bonuses for consecutive hits and word-boundary
 * starts, so "bru" ranks "Business Rules" above "Debug runner".
 */
export function fuzzyScore(query, target, { loose = true } = {}) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) {
    // Direct substring: strongly preferred, best when it starts a word.
    const at = t.indexOf(q);
    const boundary = at === 0 || /[\s._\-/]/.test(t[at - 1]);
    return 500 + (boundary ? 100 : 0) - Math.min(at, 50);
  }
  if (!loose) return 0;

  let score = 0;
  let ti = 0;
  let streak = 0;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return 0;
    const boundary = found === 0 || /[\s._\-/]/.test(t[found - 1]);
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 + (boundary ? 15 : 0);
    ti = found + 1;
  }
  return score;
}
