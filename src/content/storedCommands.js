// Palette commands that come from saved data (bookmarks, recent records,
// impersonation presets, favourite prompts and snippets), plus the
// open-by-name provider and go-to-definition.

import { GROUPS } from './commands.js';
import { listBookmarks, listRecents, listPresets } from './stores.js';
import { recordUrl, copyText, navigate } from './quickActions.js';
import { queryTable } from './tableApi.js';
import { loadLibrary, allPrompts, contextValues, renderTemplate } from '../lib/promptLibrary.js';

export const STORED_GROUPS = {
  bookmarks: 'Bookmarks',
  recent: 'Recent records',
  library: 'Library',
};

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_.]{1,80}$/;
const NAME_SEARCH_TABLES = [
  ['sys_script_include', 'Script Include'],
  ['sys_script', 'Business Rule'],
  ['sys_script_client', 'Client Script'],
  ['sys_ui_action', 'UI Action'],
  ['sys_ui_script', 'UI Script'],
  ['sysauto_script', 'Scheduled Job'],
];

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
          const { text, missing } = renderTemplate(entry.template, contextValues(ctx, window.location.hostname));
          if (missing.length) {
            sidebar.open();
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

/** Type part of a script, business rule or UI action name to jump straight to it. */
export function openByNameProvider() {
  return async (query) => {
    const term = query.trim();
    if (term.length < 3 || /^[@/]/.test(term) || term.includes('^') || /^[0-9a-f]{32}$/i.test(term)) return [];

    const settled = await Promise.allSettled(
      NAME_SEARCH_TABLES.map(([table]) =>
        queryTable(table, `nameLIKE${term}^ORDERBYname`, ['sys_id', 'name'], { limit: 3 })
      )
    );

    const results = [];
    settled.forEach((res, i) => {
      if (res.status !== 'fulfilled') return;
      const [table, label] = NAME_SEARCH_TABLES[i];
      res.value.forEach((row, index) =>
        results.push({
          id: `name.${table}.${row.sys_id}`,
          title: row.name,
          hint: label,
          group: GROUPS.navigate,
          score: 700 - index * 5,
          url: recordUrl(table, row.sys_id),
        })
      );
    });
    return results;
  };
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
