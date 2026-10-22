// Navigation shortcuts typed into the palette, in the style of SN Utils' slash bar:
// "/tn incident active=true", "/tnn change_request", "/sys <sys_id>" and so on.
// Anything not recognised here still falls through to the chat sidebar's /commands.

import {
  listUrl,
  newRecordUrl,
  recordUrl,
  xmlUrl,
  findRecordBySysId,
  isSysId,
  setCurrentApplication,
  setCurrentUpdateSet,
} from './quickActions.js';
import { searchTables } from './tableCatalog.js';
import { queryTable } from './tableApi.js';
import { similarKeywords, similarQuery, rankSimilar } from '../lib/similar.js';
import { listCustomCommands } from './stores.js';
import { canUseSlash, slashTier } from '../lib/roleTier.js';
import { findCommand, buildFindQuery, escapeQueryValue, expandTemplate, slashHelpRows, SPECIAL_VERBS } from '../lib/slashCommands.js';

const GROUP = 'Shortcuts';
const TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/;
const FIND_LIMIT = 8;

const SPECIAL_SET = new Set(SPECIAL_VERBS.map(([verb]) => verb));

/**
 * @param {{ctx: object, sidebar: object, reopen: (text: string) => void}} deps
 * @returns {(query: string) => Promise<object[]>}
 */
export function slashNavProvider({ roleAccess = null, ctx = {}, sidebar, reopen, openScriptEditor, startFileSync, toggleFieldNames, toast, getCsrfToken }) {
  const helpRows = (prefix, custom = []) =>
    slashHelpRows(custom)
      .filter(([verb]) => verb.startsWith(prefix) && canUseSlash(roleAccess?.tier() ?? null, findCommand(verb)?.verb || verb))
      .map(([verb, args, meaning], index) => ({
        id: `slashhelp.${verb}`,
        title: `/${verb}${args ? ` ${args}` : ''}`,
        hint: meaning,
        group: GROUP,
        score: 1100 - index,
        run: () => reopen(`/${verb} `),
      }));

  const reloadAction = { label: 'Reload', onClick: () => window.location.reload() };

  async function findRows(def, arg) {
    const query = buildFindQuery(def, arg);
    const rows = [
      {
        id: `slash.find.${def.verb}.list`,
        title: arg ? `${def.label} matching "${arg}"` : `${def.label} list`,
        hint: `${def.table}_list.do`,
        group: GROUP,
        score: 1100,
        url: listUrl(def.table, query),
      },
    ];
    if (!arg) return rows;
    const fields = ['sys_id', def.display, ...(def.hint ? [def.hint] : [])];
    const records = await queryTable(def.table, query, fields, { limit: FIND_LIMIT }).catch(() => []);
    records.forEach((row, index) =>
      rows.push({
        id: `slash.find.${def.verb}.${row.sys_id}`,
        title: row[def.display] || row.sys_id,
        hint: (def.hint && row[def.hint]) || def.table,
        group: GROUP,
        score: 1090 - index,
        url: recordUrl(def.table, row.sys_id),
      })
    );
    return rows;
  }

  async function switchApplicationRows(arg) {
    const text = escapeQueryValue(arg);
    const apps = await queryTable(
      'sys_app',
      `active=true${text ? `^nameLIKE${text}` : ''}^ORDERBYDESCsys_updated_on`,
      ['sys_id', 'name', 'scope'],
      { limit: 10 }
    );
    const choices = [...(!text || 'global'.includes(text.toLowerCase()) ? [{ sys_id: 'global', name: 'Global', scope: 'global' }] : []), ...apps];
    return choices.map((app, index) => ({
      id: `slash.sa.${app.sys_id}`,
      title: `Switch to ${app.name}`,
      hint: app.scope,
      group: GROUP,
      score: 1100 - index,
      run: async () => {
        await setCurrentApplication(app.sys_id, await getCsrfToken());
        toast.success(`Application is now "${app.name}".`, { action: reloadAction, timeout: 10000 });
      },
    }));
  }

  async function switchUpdateSetRows(arg) {
    const text = escapeQueryValue(arg);
    const sets = await queryTable(
      'sys_update_set',
      `state=in progress${text ? `^nameLIKE${text}` : ''}^ORDERBYDESCsys_updated_on`,
      ['sys_id', 'name', 'sys_updated_on'],
      { limit: 10 }
    );
    return sets.map((set, index) => ({
      id: `slash.su.${set.sys_id}`,
      title: `Switch to ${set.name}`,
      hint: set.sys_updated_on,
      group: GROUP,
      score: 1100 - index,
      run: async () => {
        await setCurrentUpdateSet(set.sys_id, await getCsrfToken());
        toast.success(`Update set is now "${set.name}".`, { action: reloadAction, timeout: 10000 });
      },
    }));
  }

  return async (query) => {
    const term = query.trim();
    if (!term.startsWith('/')) return [];

    const verb = (term.slice(1).split(/\s+/)[0] || '').toLowerCase();
    const arg = term.slice(1 + verb.length).trim();

    const custom = await listCustomCommands().catch(() => []);
    const userCommand = custom.find((c) => c.verb === verb);
    const finder = findCommand(verb);

    if (!SPECIAL_SET.has(verb) && !finder && !userCommand) return helpRows(verb, custom);
    const mainVerb = finder?.verb || verb;
    if (!userCommand && !canUseSlash(roleAccess?.tier() ?? null, mainVerb)) {
      const need = slashTier(mainVerb);
      return [{ id: 'slash.role', title: `/${verb} needs the ${need} role`, hint: 'Your ServiceNow roles do not include it (Options > Show tools by role)', group: GROUP, score: 1100, run: () => {} }];
    }
    if (!arg && (verb === 'tn' || verb === 'tnn' || verb === 'sys' || verb === 'props' || verb === 'search' || verb === 'tables')) {
      return helpRows(verb, custom).slice(0, 1);
    }

    if (userCommand) {
      return [
        {
          id: `slash.custom.${userCommand.verb}`,
          title: arg ? `/${userCommand.verb} ${arg}` : `/${userCommand.verb}`,
          hint: userCommand.template,
          group: GROUP,
          score: 1100,
          url: expandTemplate(userCommand.template, arg),
        },
      ];
    }
    if (finder) return findRows(finder, arg);

    switch (verb) {
      case 'sa':
        return switchApplicationRows(arg);

      case 'su':
        return switchUpdateSetRows(arg);

      case 'search':
        return [
          {
            id: 'slash.search',
            title: `Search the instance for "${arg}"`,
            hint: '/textsearch.do',
            group: GROUP,
            score: 1100,
            url: `/textsearch.do?sysparm_search=${encodeURIComponent(arg)}`,
            raw: true,
            newTab: true,
          },
        ];

      case 'tables': {
        const tables = await searchTables(arg, 8);
        return tables.map((t, index) => ({
          id: `slash.tables.${t.name}`,
          title: `${t.label || t.name} list`,
          hint: t.name,
          group: GROUP,
          score: 1100 - index,
          url: listUrl(t.name),
        }));
      }

      case 'tn':
      case 'tnn': {
        const [tablePart, ...queryParts] = arg.split(/\s+/);
        const filter = queryParts.join(' ');
        const names = new Map();
        // A literal table name works even when the catalog has not indexed it.
        if (TABLE_NAME_RE.test(tablePart)) names.set(tablePart, tablePart);
        (await searchTables(tablePart, 5)).forEach((t) => names.set(t.name, t.label || t.name));
        return [...names].map(([name, label], index) => ({
          id: `slash.${verb}.${name}`,
          title: verb === 'tn' ? `${label} list` : `New ${label}`,
          hint: verb === 'tn' ? filter || `${name}_list.do` : `${name}.do?sys_id=-1`,
          group: GROUP,
          score: 1100 - index,
          url: verb === 'tn' ? listUrl(name, filter) : newRecordUrl(name),
        }));
      }

      case 'similar': {
        if (!ctx.table || !isSysId(ctx.sysId)) return [{ id: 'slash.similar.none', title: 'Open a saved record first', hint: 'Similar records are matched on its short description', group: GROUP, score: 1100, run: () => {} }];
        const rec = (await queryTable(ctx.table, `sys_id=${ctx.sysId}`, ['short_description', 'name', 'title'], { limit: 1 }).catch(() => []))[0] || {};
        const text = [rec.short_description, rec.name, rec.title].find((v) => typeof v === 'string' && v.trim()) || '';
        const keywords = similarKeywords(text);
        if (!keywords.length) return [{ id: 'slash.similar.nowords', title: 'Nothing to match on', hint: 'This record has no short description with distinctive words', group: GROUP, score: 1100, run: () => {} }];
        const query = similarQuery(keywords, { excludeSysId: ctx.sysId });
        const found = await queryTable(ctx.table, query, ['sys_id', 'number', 'short_description', 'name', 'state', 'sys_updated_on'], { limit: 30, displayValue: true }).catch(() => []);
        const flat = (v) => (v && typeof v === 'object' ? v.display_value ?? v.value ?? '' : v ?? '');
        const hits = rankSimilar(found, keywords).slice(0, 8);
        const head = { id: 'slash.similar.list', title: `All ${ctx.table} matching ${keywords.join(', ')}`, hint: 'Open the list with this filter', group: GROUP, score: 1100, url: listUrl(ctx.table, query) };
        return [
          head,
          ...hits.map(({ row, shared, total }, index) => ({
            id: `slash.similar.${flat(row.sys_id)}`,
            title: `${flat(row.number) ? `${flat(row.number)}  ` : ''}${flat(row.short_description) || flat(row.name) || '(no description)'}`,
            hint: `${shared}/${total} words · ${flat(row.state) || ctx.table} · ${String(flat(row.sys_updated_on)).slice(0, 10)}`,
            group: GROUP,
            score: 1090 - index,
            url: recordUrl(ctx.table, flat(row.sys_id)),
          })),
          ...(hits.length ? [] : [{ id: 'slash.similar.empty', title: 'No similar records found', hint: `Searched for ${keywords.join(', ')}`, group: GROUP, score: 1080, run: () => {} }]),
        ];
      }

      case 'sys': {
        if (!isSysId(arg)) return [{ id: 'slash.sys.invalid', title: 'Paste a 32-character sys_id', group: GROUP, score: 1100, run: () => {} }];
        const found = await findRecordBySysId(arg, ctx.table);
        if (!found) return [{ id: 'slash.sys.none', title: 'sys_id not found', hint: arg, group: GROUP, score: 1100, run: () => {} }];
        return [
          {
            id: `slash.sys.${found.sysId}`,
            title: `Open ${found.name || found.table}`,
            hint: `${found.table} \u00b7 ${found.sysId}`,
            group: GROUP,
            score: 1100,
            url: recordUrl(found.table, found.sysId),
          },
        ];
      }

      case 'props':
        return [
          {
            id: 'slash.props',
            title: `System properties matching "${arg}"`,
            group: GROUP,
            score: 1100,
            url: listUrl('sys_properties', `nameLIKE${arg}^ORvalueLIKE${arg}^ORDERBYname`),
          },
        ];

      case 'log':
        return [
          {
            id: 'slash.log',
            title: arg ? `System log matching "${arg}"` : 'System log, newest first',
            group: GROUP,
            score: 1100,
            url: listUrl('syslog', `${arg ? `messageLIKE${arg}^` : ''}ORDERBYDESCsys_created_on`),
          },
        ];

      case 'code':
        return [{ id: 'slash.code', title: 'Code search', group: GROUP, score: 1100, run: () => { sidebar.openForTool(); sidebar.openSearchPanel(); } }];

      case 'bg':
        return [{ id: 'slash.bg', title: 'Background script runner', group: GROUP, score: 1100, run: () => { sidebar.openForTool(); sidebar.openBackgroundScriptPanel(); } }];

      case 'names':
        return toggleFieldNames ? [{ id: 'slash.names', title: 'Show or hide database names on the page', hint: 'Field names under every label, column names in lists', group: GROUP, score: 1100, run: () => toggleFieldNames() }] : [];

      case 'edit':
        return openScriptEditor ? [{ id: 'slash.edit', title: 'Edit the script (over the field)', group: GROUP, score: 1100, run: () => openScriptEditor() }] : [];

      case 'sync':
        return startFileSync ? [{ id: 'slash.sync', title: 'Edit script in VS Code (sync to a folder)', group: GROUP, score: 1100, run: () => startFileSync() }] : [];

      case 'xml':
        if (!ctx.table || !ctx.sysId) return [];
        return [{ id: 'slash.xml', title: 'Open record XML', group: GROUP, score: 1100, url: xmlUrl(ctx.table, ctx.sysId), raw: true, newTab: true }];

      case 'cs':
        return [{ id: 'slash.cs', title: 'Flush instance cache', hint: '/cache.do', group: GROUP, score: 1100, url: '/cache.do', raw: true, newTab: true }];

      case 'stats':
        return [{ id: 'slash.stats', title: 'Node stats', hint: '/stats.do', group: GROUP, score: 1100, url: '/stats.do', raw: true, newTab: true }];

      default:
        return [];
    }
  };
}
