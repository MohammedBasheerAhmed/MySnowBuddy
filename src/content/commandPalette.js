// Command palette — the primary way to drive the extension.
//
// Opens over the page (inside the extension's Shadow DOM so instance CSS
// cannot bleed in), fuzzy-matches every registered command, and mixes in
// query-driven results: table lookups, pasted sys_ids, @user impersonation
// and /slash commands.
//
// Keyboard: Up/Down or Ctrl+N/P to move, Enter to run, Shift/Ctrl+Enter to
// open a navigation in a new tab, Esc to close.

import { buildCommands, buildProviders, slashCommand, GROUPS } from './commands.js';
import { buildStoredCommands, goToDefinitionCommand, openByNameProvider, STORED_GROUPS } from './storedCommands.js';
import { slashNavProvider } from './slashBar.js';
import { buildInstanceCommands } from './instanceTag.js';
import { navigate } from './quickActions.js';
import { recordCommandUse, getUiState } from './storage.js';
import { createIcon } from './icons.js';
import { trustedDom } from '../sidebar/trusted.js';

const GROUP_ICONS = {
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
const MAX_RESULTS = 40;

export function createCommandPalette(deps) {
  const { getContext, sidebar, toast } = deps;

  const overlay = document.createElement('div');
  overlay.className = 'msb-palette';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'MySnowBuddy command palette');
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
  input.placeholder = 'Search actions, or type /tn table, a sys_id, @user';
  input.setAttribute('aria-label', 'Command');

  const escHint = el('kbd', 'msb-palette__esc', 'Esc');
  const modeChip = el('span', 'msb-palette__mode');
  modeChip.hidden = true;
  inputRow.append(icon, input, modeChip, escHint);

  const resultsEl = el('div', 'msb-palette__results');
  resultsEl.setAttribute('role', 'listbox');

  const footer = el('div', 'msb-palette__footer');
  footer.append(
    hintGroup(['\u2191', '\u2193'], 'navigate'),
    hintGroup(['Enter'], 'run'),
    hintGroup(['Shift', 'Enter'], 'new tab')
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
  const searchProviders = latestOnly((term) => Promise.allSettled(providers.map((provider) => provider(term))));

  overlay.addEventListener('mousedown', (event) => {
    if (event.target.hasAttribute('data-msb-close')) close();
    else if (event.target !== input) setTimeout(() => focusInput(), 0);
  });

  input.addEventListener('input', () => {
    updateMode();
    render();
    scheduleProviders();
  });

  function updateMode() {
    const v = input.value;
    const label = v.startsWith('/') ? 'Shortcut' : v.startsWith('@') ? 'Impersonate' : /^[0-9a-f]{32}$/i.test(v.trim()) ? 'sys_id' : '';
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
      if (!NAV_KEYS.has(event.key) && !(event.ctrlKey && (letter === 'n' || letter === 'p'))) return;
      event.stopImmediatePropagation();
      onKeyDown(event);
    },
    true
  );

  function onKeyDown(event) {
    const key = event.key;
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
      execute(results[activeIndex], event.shiftKey || event.ctrlKey || event.metaKey);
    }
  }

  function move(delta) {
    if (!results.length) return;
    const next = (activeIndex + delta + results.length) % results.length;
    setActive(next);
  }

  function setActive(index) {
    activeIndex = Math.max(0, Math.min(index, results.length - 1));
    resultsEl.querySelectorAll('.msb-palette__item').forEach((el, i) => {
      el.classList.toggle('msb-palette__item--active', i === activeIndex);
      if (i === activeIndex) el.scrollIntoView({ block: 'nearest' });
    });
  }

  async function execute(command, newTab) {
    if (!command) return;
    close();
    try {
      recordCommandUse(command.id);
      if (command.url) {
        navigate(command.url, { newTab: newTab || command.newTab, raw: command.raw });
        return;
      }
      await command.run();
    } catch (err) {
      toast.error(err.message || String(err));
    }
  }

  function scheduleProviders() {
    clearTimeout(providerTimer);
    // Results still in flight are for the old text; they must not land after this keystroke.
    searchProviders.cancel();
    const query = input.value;
    providerTimer = setTimeout(() => runProviders(query), PROVIDER_DEBOUNCE_MS);
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

    render(dynamic);
  }

  function render(dynamic = []) {
    const query = input.value.trim();
    const scored = [];
    grouped = !query;

    if (!query) {
      const recentSet = new Map(commands.map((c) => [c.id, c]));
      recents
        .map((id) => recentSet.get(id))
        .filter(Boolean)
        .forEach((cmd) => scored.push({ ...cmd, group: 'Recent', score: 10000 }));
      commands.filter((cmd) => cmd.id.startsWith('recent.') && !recents.includes(cmd.id)).slice(0, 5).forEach((cmd) => scored.push({ ...cmd, score: 5000 }));
      commands.forEach((cmd) => {
        if (recents.includes(cmd.id) || cmd.id.startsWith('recent.')) return;
        scored.push({ ...cmd, score: 0 });
      });
    } else {
      const slash = slashCommand(query, sidebar);
      if (slash) scored.push(slash);
      dynamic.forEach((cmd) => scored.push(cmd));
      commands.forEach((cmd) => {
        const score = fuzzyScore(query, `${cmd.title} ${cmd.hint || ''} ${cmd.keywords || ''}`);
        if (score > 0) scored.push({ ...cmd, score: score + (recents.includes(cmd.id) ? 20 : 0) });
      });
      scored.sort((a, b) => b.score - a.score);
    }

    results = dedupe(scored).slice(0, MAX_RESULTS);
    activeIndex = 0;
    paint();
  }

  function paint() {
    resultsEl.replaceChildren();

    if (!results.length) {
      const empty = el('div', 'msb-palette__empty');
      empty.appendChild(el('div', null, 'No matching action.'));
      const tips = el('div', 'msb-palette__emptyTips');
      [
        ['incident', 'open a table'],
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
      if (index === activeIndex) item.classList.add('msb-palette__item--active');

      const iconWrap = el('span', 'msb-palette__itemIcon');
      iconWrap.appendChild(createIcon(cmd.icon || GROUP_ICONS[cmd.group] || 'record', 15));
      item.appendChild(iconWrap);

      const title = document.createElement('span');
      title.className = 'msb-palette__title';
      title.textContent = cmd.title;
      item.appendChild(title);

      // Always rendered, even when empty: it is the flexible spacer that keeps
      // the trailing badges right-aligned.
      const hint = document.createElement('span');
      hint.className = 'msb-palette__hint';
      hint.textContent = cmd.hint || '';
      item.appendChild(hint);

      // When results are score-sorted the groups interleave, so the group is
      // shown per row instead of as a header.
      if (!grouped && cmd.group) {
        const tag = document.createElement('span');
        tag.className = 'msb-palette__badge';
        tag.textContent = cmd.group;
        item.appendChild(tag);
      }

      if (cmd.url) {
        const badge = document.createElement('span');
        badge.className = 'msb-palette__badge msb-palette__badge--open';
        badge.textContent = 'open';
        item.appendChild(badge);
      }

      item.addEventListener('mouseenter', () => setActive(index));
      item.addEventListener('click', trustedDom((event) => execute(cmd, event.shiftKey || event.ctrlKey || event.metaKey)));
      resultsEl.appendChild(item);
    });
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

  async function open(prefill = '') {
    const ctx = safeContext(getContext);
    const stored = await buildStoredCommands({ ...deps, ctx }).catch(() => []);
    const instances = await buildInstanceCommands().catch(() => []);
    const definition = goToDefinitionCommand({ ctx, toast });
    commands = [...buildCommands({ ...deps, ctx }), ...(definition ? [definition] : []), ...stored, ...instances];
    providers = [
      ...buildProviders({ ...deps, ctx }),
      openByNameProvider(),
      slashNavProvider({
        ctx,
        sidebar,
        reopen: (text) => open(text),
        openScriptEditor: deps.openScriptEditor,
        startFileSync: deps.startFileSync,
        toast,
        getCsrfToken: deps.getCsrfToken,
      }),
    ];
    recents = (await getUiState()).recentCommands || [];

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
    overlay.hidden = true;
    deps.onOpenChange?.(false);
    input.value = '';
    results = [];
    resultsEl.replaceChildren();
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
export function fuzzyScore(query, target) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) {
    // Direct substring: strongly preferred, best when it starts a word.
    const at = t.indexOf(q);
    const boundary = at === 0 || /[\s._\-/]/.test(t[at - 1]);
    return 500 + (boundary ? 100 : 0) - Math.min(at, 50);
  }

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
