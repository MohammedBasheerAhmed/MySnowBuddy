// Palette commands that come from saved data (bookmarks, recent records,
// impersonation presets, favourite prompts and snippets), plus "go to anything"
// (type part of a name, land on the record; the logic is src/lib/goTo.js) and go-to-definition.

import { GROUPS } from './commands.js';
import { listBookmarks, listRecents, listPresets } from './stores.js';
import { recordUrl, listUrl, absoluteUrl, copyText, navigate } from './quickActions.js';
import { queryTable } from './tableApi.js';
import { loadLibrary, allPrompts, contextValues, renderTemplate } from '../lib/promptLibrary.js';
import {
  createGoToEngine,
  parseGoTo,
  kindById,
  rankCandidates,
  selectRows,
  toRow,
  refineCandidates,
  actionsFor,
  usageTarget,
  versionQuery,
  listRowsFor,
  noticeRowsFor,
  LIMITS,
  BARE_SCORE_CAP,
  PENDING_EDIT_KEY,
  pendingEditMarker,
  parsePendingEdit,
  pendingEditMatches,
} from '../lib/goTo.js';

export const STORED_GROUPS = {
  bookmarks: 'Bookmarks',
  recent: 'Recent records',
  library: 'Library',
};

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_.]{1,80}$/;
export const GO_TO_GROUP = 'Go to';

async function favouriteCommands({ ctx, sidebar, toast }) {
  const out = [];
  for (const kind of ['prompts', 'snippets']) {
    // eslint-disable-next-line no-await-in-loop -- two small storage reads.
    const library = await loadLibrary(kind);
    const byId = new Map(allPrompts(library, kind).map((p) => [p.id, p]));
    library.favorites.forEach((id) => {
      const entry = byId.get(id);
      if (!entry) return;
      out.push({
        id: `library.${id}`,
        title: `${kind === 'prompts' ? 'Prompt' : 'Snippet'}: ${entry.title}`,
        hint: entry.category,
        group: STORED_GROUPS.library,
        keywords: `${entry.description || ''} favourite favorite ${kind}`,
        run: async () => {
          const { text, missing } = renderTemplate(entry.template, contextValues(ctx, window.location.hostname), { kind });
          if (missing.length) {
            sidebar.openForTool();
            sidebar.openPromptPanel(kind);
            toast.info(`"${entry.title}" needs more input (${missing.join(', ')}).`);
            return;
          }
          if (kind === 'prompts') {
            sidebar.open();
            sidebar.sendPrompt(entry.title, text);
          } else {
            await copyText(text);
            toast.success(`Copied snippet "${entry.title}"`);
          }
        },
      });
    });
  }
  return out;
}

/** Commands built from stored data. Each source fails independently. */
export async function buildStoredCommands(deps) {
  const host = window.location.hostname;
  const { impersonateUserName } = deps;
  const out = [];

  const [bookmarks, recents, presets, favourites] = await Promise.all([
    listBookmarks(host).catch(() => []),
    listRecents(host).catch(() => []),
    listPresets().catch(() => []),
    favouriteCommands(deps).catch(() => []),
  ]);

  bookmarks.forEach((b) =>
    out.push({
      id: `bookmark.${b.id}`,
      title: b.title,
      hint: b.path,
      group: STORED_GROUPS.bookmarks,
      keywords: 'bookmark saved favourite page',
      url: b.path,
      raw: b.path.startsWith('/now/'),
    })
  );

  recents.slice(0, 15).forEach((r) =>
    out.push({
      id: `recent.${r.sysId}`,
      title: r.title,
      hint: r.table,
      group: STORED_GROUPS.recent,
      keywords: `recent history ${r.table}`,
      url: recordUrl(r.table, r.sysId),
    })
  );

  presets.forEach((p) =>
    out.push({
      id: `preset.${p.id}`,
      title: `Impersonate ${p.label}`,
      hint: p.userName,
      group: GROUPS.tools,
      keywords: 'impersonate preset user switch test as',
      run: () => impersonateUserName(p.userName),
    })
  );

  return [...out, ...favourites];
}

// ---- Go to anything ---------------------------------------------------------------------------------------------------
// Type part of a name ("incident closed", "AjaxUtil", "br: notify") and land on the rule, script include, ACL,
// notification, flow, widget, table, property, role or user. src/lib/goTo.js decides what to ask and how to rank;
// everything here is the glue: read-only queries through queryTable, the recent records for ranking, and the actions.

// One engine for the page session: tables the user cannot read stay skipped; results are cleared when the palette opens.
const goToEngine = createGoToEngine({ query: (table, query, fields, options) => queryTable(table, query, fields, options) });

/**
 * @param {{ ctx?: object, tier?: string|null }} deps `ctx` is the page on screen; `tier` the role tier of the user
 * @returns {{ search(query: string, onUpdate?: (rows: object[]) => void): Promise<object[]|null>, instant(query: string): object[],
 *            modeLabel(query: string): string, stripPrefix(query: string): string, cancel(): void, reset(): void }}
 */
export function goToProvider({ ctx = {}, tier = null } = {}) {
  let recents = new Map();
  let recentsLoaded = false;
  let last = { term: '', candidates: [] };
  let latest = 0; // the newest search; an older one that wakes up after an await gives up

  // Read once, on the first search: nothing is read before the user types.
  async function loadRecents() {
    if (recentsLoaded) return;
    recentsLoaded = true;
    try {
      const list = await listRecents(window.location.hostname);
      recents = new Map(list.map((r, index) => [r.sysId, index]));
    } catch {
      recents = new Map();
    }
  }

  function rowsFrom(parsed, candidates) {
    const limits = LIMITS[parsed.mode === 'kind' ? 'kind' : 'bare'];
    const ranked = rankCandidates(candidates, parsed.term, { recents, ctx });
    // Bare text: below the palette's table navigation and record lookups (BARE_SCORE_CAP explains why).
    const cap = parsed.mode === 'kind' ? undefined : BARE_SCORE_CAP;
    return selectRows(ranked, limits).map((entry) => ({ ...toRow(entry, { cap }), group: GO_TO_GROUP, url: recordUrl(entry.c.table, entry.c.sysId) }));
  }

  const emptyMeta = () => ({ unavailable: [], failed: [], expired: false, searched: [], cached: [] });

  async function search(query, onUpdate) {
    const mine = (latest += 1);
    const parsed = parseGoTo(query, { ctx, tier });
    if (parsed.mode === 'none') {
      goToEngine.cancel();
      last = { term: '', candidates: [] };
      return [];
    }
    if (parsed.mode === 'kind' && (parsed.tooShort || !parsed.kinds.length)) {
      goToEngine.cancel();
      last = { term: '', candidates: [] };
      return [...listRowsFor(parsed, emptyMeta(), listUrl), ...noticeRowsFor({ ...parsed, kinds: [] }, emptyMeta(), false, 1)];
    }

    await loadRecents();
    if (mine !== latest) return null;
    const build = (candidates, meta, pending) => {
      const shown = rowsFrom(parsed, candidates);
      return [...shown, ...listRowsFor(parsed, meta, listUrl), ...noticeRowsFor(parsed, meta, pending, shown.length)];
    };
    if (parsed.mode === 'kind') onUpdate?.(build([], emptyMeta(), true));

    const result = await goToEngine.search({
      term: parsed.term,
      kinds: parsed.kinds,
      more: parsed.more,
      mode: parsed.mode,
      onProgress: ({ candidates, meta }) => {
        last = { term: parsed.term, candidates };
        onUpdate?.(build(candidates, meta, true));
      },
    });
    if (!result) return null; // a newer search took over
    last = { term: parsed.term, candidates: result.candidates };
    return build(result.candidates, result.meta, false);
  }

  /** While the next letter is typed: the rows already fetched that still match, so the list narrows at once. */
  function instant(query) {
    const parsed = parseGoTo(query, { ctx, tier });
    if (parsed.mode === 'none' || parsed.tooShort || !last.candidates.length) return [];
    if (!parsed.term.toLowerCase().includes(last.term.toLowerCase())) return [];
    const same = parsed.mode === 'kind' ? last.candidates.filter((c) => parsed.kinds.includes(c.kind)) : last.candidates;
    return rowsFrom(parsed, refineCandidates(same, parsed.term));
  }

  /** The chip beside the input while a prefix is typed: "Business Rule", or "Find" for several kinds. */
  function modeLabel(query) {
    const parsed = parseGoTo(query, { ctx, tier });
    if (parsed.mode !== 'kind') return '';
    const ids = parsed.kinds.length ? parsed.kinds : parsed.denied || [];
    return ids.length === 1 ? kindById(ids[0]).label : 'Find';
  }

  /** The text after a kind prefix ("br: closed" gives "closed"); anything else comes back as it is. */
  function stripPrefix(query) {
    const parsed = parseGoTo(query, { ctx, tier });
    return parsed.mode === 'kind' ? parsed.term : query;
  }

  return { search, instant, modeLabel, stripPrefix, cancel: () => { latest += 1; goToEngine.cancel(); }, reset: () => goToEngine.reset() };
}

/** Kept for callers of the old name; the palette uses goToProvider() to show results as each kind answers. */
export function openByNameProvider(deps = {}) {
  const provider = goToProvider(deps);
  return async (query) => (await provider.search(query)) || [];
}

/**
 * The actions on a highlighted result (Tab or Right Arrow in the palette). Each one is an existing command or service:
 * navigation, the in-place script editor, the Change impact / code search / field usage panels, the version list.
 */
export function goToActions({ sidebar, toast, openScriptEditor, ctx = {} }) {
  const here = (g) => Boolean(ctx.sysId) && String(ctx.sysId).toLowerCase() === String(g.sysId).toLowerCase();
  const urlOf = (g) => recordUrl(g.table, g.sysId);
  const needSidebar = (opened) => {
    if (opened === false) toast.info('Turn on the sidebar in Options to see this panel.');
  };

  return {
    list: (row) => (row?.goTo ? actionsFor(row.goTo, { onPage: here(row.goTo) }) : []),

    async run(id, row) {
      const g = row?.goTo;
      if (!g) return;
      switch (id) {
        case 'open':
          navigate(urlOf(g));
          return;
        case 'tab':
          navigate(urlOf(g), { newTab: true });
          return;
        case 'list':
          if (/^[a-z][a-z0-9_]{0,79}$/.test(g.name)) navigate(listUrl(g.name));
          return;
        case 'edit':
          if (here(g) && openScriptEditor) {
            await openScriptEditor();
            return;
          }
          // Open the record; the next page opens the editor (resumePendingEdit, called when the palette is created).
          try {
            sessionStorage.setItem(PENDING_EDIT_KEY, pendingEditMarker(g.table, g.sysId));
          } catch {
            toast.info('Opening the record. Use "Edit the script" there.');
          }
          navigate(urlOf(g));
          return;
        case 'usage': {
          const target = usageTarget(g);
          if (!target) return;
          sidebar.openForTool?.();
          if (target.type === 'impact') needSidebar(sidebar.openPanel?.('impact', { args: target.value }));
          else if (target.type === 'impact-page') needSidebar(sidebar.openPanel?.('impact', { args: '' }));
          else if (target.type === 'field') needSidebar(sidebar.openPanel?.('fieldusage', { args: target.value }));
          else sidebar.openSearchPanel?.(target.value);
          return;
        }
        case 'versions':
          if (here(g) && sidebar.openVersionPanel) {
            sidebar.openForTool?.();
            sidebar.openVersionPanel();
            return;
          }
          navigate(listUrl('sys_update_version', versionQuery(g.table, g.sysId)));
          return;
        case 'link':
          await copyText(absoluteUrl(urlOf(g)));
          toast.success('Copied link');
          return;
        case 'sysid':
          await copyText(g.sysId);
          toast.success(`Copied sys_id ${g.sysId}`);
          return;
        default:
      }
    },
  };
}

/**
 * Called once when the palette is created, on every page load. "Open it, then edit the script" leaves a short-lived
 * marker in sessionStorage and navigates; this opens the in-place editor when the page for that record is ready.
 * With no marker (nearly always) it returns at once.
 */
export function resumePendingEdit({ getContext, openScriptEditor, toast, tries = 25, everyMs = 400 }) {
  let marker = null;
  try {
    const stored = sessionStorage.getItem(PENDING_EDIT_KEY);
    if (stored === null) return;
    sessionStorage.removeItem(PENDING_EDIT_KEY); // used once
    marker = parsePendingEdit(stored);
  } catch {
    return;
  }
  if (!marker || typeof openScriptEditor !== 'function') return;
  let left = tries;
  const timer = setInterval(() => {
    left -= 1;
    let ctx = {};
    try {
      ctx = getContext() || {};
    } catch {
      ctx = {};
    }
    if (pendingEditMatches(marker, ctx) && ctx.scriptFieldLabel) {
      clearInterval(timer);
      openScriptEditor();
    } else if (left <= 0) {
      clearInterval(timer);
      if (pendingEditMatches(marker, ctx)) toast?.info('This record has no script field the editor can open.');
    }
  }, everyMs);
}

/** URL of the Script Include or table named `name`, or null. */
export async function findDefinitionUrl(name) {
  const full = String(name || '').trim();
  if (!IDENTIFIER_RE.test(full)) return null;
  const short = full.split('.').pop();
  const includes = await queryTable('sys_script_include', `name=${short}^ORapi_name=${full}`, ['sys_id'], { limit: 1 });
  if (includes.length) return recordUrl('sys_script_include', includes[0].sys_id);
  const tables = await queryTable('sys_db_object', `name=${short}`, ['sys_id'], { limit: 1 });
  return tables.length ? recordUrl('sys_db_object', tables[0].sys_id) : null;
}

/** "Go to definition" for the text selected on the page, when it looks like a name. */
export function goToDefinitionCommand({ ctx, toast }) {
  const selection = String(ctx.selection || '').trim();
  if (!IDENTIFIER_RE.test(selection)) return null;

  return {
    id: 'tools.goToDefinition',
    title: `Go to definition: ${selection}`,
    hint: 'Script Include or table',
    group: GROUPS.tools,
    keywords: 'definition go to open script include table class',
    run: async () => {
      const url = await findDefinitionUrl(selection);
      if (url) navigate(url);
      else toast.error(`No Script Include or table named "${selection}" was found.`);
    },
  };
}
