// Encoded queries in the page: paste or type one and it is applied to the list, and a static filter can be turned into
// a dynamic one (relative dates, "me"). The palette row provider and the List filter panel share this file.
//
// Applying a query is navigation to the list URL with sysparm_query: the instance evaluates any javascript: parts when
// the list loads, exactly as if the same text were typed into the filter builder. The known filter helpers
// (gs.daysAgoStart, gs.getUserID ...) go straight through; any other script asks first, in the in-app dialog.

import { callPage } from './pageBridge.js';
import { queryTable } from './tableApi.js';
import { navigate, listUrl, copyText } from './quickActions.js';
import { askConfirm } from './confirmDialog.js';
import { makeDynamic, splitTableQuery, queryScriptRisk, looksLikeEncodedQuery } from '../lib/dynamicQuery.js';
import { explainQuery } from '../lib/query.js';
import { addSmartKind } from './smartSelect.js';
import { detectPageContext } from './context.js';

const GROUP = 'Filter';
const SYS_ID_LIST = /[0-9a-f]{32}/i;
const clip = (text, max = 90) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Who "me" is for the rewrite: sys_id and user name, plus the groups when the query lists group ids. */
export async function gatherUserContext(query = '') {
  const info = await callPage('getUserInfo').catch(() => null);
  const context = { now: new Date(), userId: info?.userId || '', userName: info?.userName || '' };
  if (context.userId && /\bIN\b[^^]*[0-9a-f]{32}/.test(query) && SYS_ID_LIST.test(query)) {
    const rows = await queryTable('sys_user_grmember', `user=${context.userId}`, ['group'], { limit: 200 }).catch(() => []);
    context.groupIds = rows.map((row) => (typeof row.group === 'object' ? row.group?.value : row.group)).filter(Boolean);
  }
  return context;
}

/** Static -> dynamic for the page's user. */
export async function makeQueryDynamic(query) {
  return makeDynamic(query, await gatherUserContext(query));
}

/**
 * Open `table`'s list with `query`. Scripts that are not the standard filter helpers need a yes first.
 * @returns {Promise<boolean>} false when the user declined
 */
export async function applyListFilter(table, query) {
  if (!/^[a-z][a-z0-9_]*$/.test(table || '')) throw new Error('Name the table first, for example: incident active=true^priority=1');
  const { custom } = queryScriptRisk(query);
  if (custom.length) {
    const ok = await askConfirm({
      title: 'This filter runs a script',
      message: `The list will evaluate ${custom.length === 1 ? 'this script' : 'these scripts'} on the instance when it loads, as you:`,
      details: custom.join('\n'),
      confirmLabel: 'Apply filter',
      danger: true,
    });
    if (!ok) return false;
  }
  navigate(listUrl(table, query));
  return true;
}

/** Palette rows for text that is an encoded query. */
export function encodedQueryProvider({ ctx = {}, toast } = {}) {
  return async (text) => {
    const split = splitTableQuery(text, ctx.table || '');
    if (!split) return [];
    const { table, query } = split;
    const scripts = queryScriptRisk(query);
    const note = scripts.custom.length ? ' · runs a script on the instance' : scripts.scripts.length ? ' · uses date and user helpers' : '';
    const fail = (err) => toast?.error(err.message || String(err));

    if (!table) {
      return [
        {
          id: 'query.needTable',
          title: 'Apply this filter to which table?',
          hint: 'Type the table first, for example: incident ' + clip(query, 40),
          group: GROUP,
          icon: 'table',
          score: 1100,
          run: () => toast?.info('Put the table name first, for example: incident active=true^priority=1'),
        },
      ];
    }

    const rows = [
      {
        id: 'query.apply',
        title: `Apply filter to the ${table} list`,
        hint: `${clip(query)}${note}`,
        group: GROUP,
        icon: 'table',
        score: 1100,
        run: () => applyListFilter(table, query).catch(fail),
      },
    ];

    let dynamic = null;
    try {
      dynamic = await makeQueryDynamic(query);
    } catch {
      dynamic = null;
    }
    if (dynamic && dynamic.changes.length) {
      const n = dynamic.changes.length;
      rows.push(
        {
          id: 'query.applyDynamic',
          title: `Apply the dynamic version (${n} change${n === 1 ? '' : 's'})`,
          hint: clip(dynamic.changes.map((c) => c.why).join('; '), 110),
          group: GROUP,
          icon: 'table',
          score: 1090,
          run: () => applyListFilter(table, dynamic.query).catch(fail),
        },
        {
          id: 'query.copyDynamic',
          title: 'Copy the dynamic encoded query',
          hint: clip(dynamic.query),
          group: GROUP,
          icon: 'copy',
          score: 1080,
          run: async () => {
            await copyText(dynamic.query);
            toast?.success('Copied the dynamic encoded query');
          },
        }
      );
    } else {
      rows.push({
        id: 'query.copy',
        title: 'Copy the encoded query',
        hint: clip(query),
        group: GROUP,
        icon: 'copy',
        score: 1080,
        run: async () => {
          await copyText(query);
          toast?.success('Copied the encoded query');
        },
      });
    }
    return rows;
  };
}

/** Services for the List filter panel (merged by featureServices.js). */
export const queryServices = {
  makeQueryDynamic: (query) => makeQueryDynamic(query),
  applyListFilter: (table, query) => applyListFilter(table, query),
};

// --- Selecting an encoded query on a page ---------------------------------------------------------------
// The smart selection popover (smartSelect.js) asks every registered kind whether it recognises the selection.

addSmartKind({
  kind: 'encodedQuery',
  detect: (text) => looksLikeEncodedQuery(text),
  describe: async (text, { toast } = {}) => {
    const split = splitTableQuery(text, detectPageContext()?.table || '');
    if (!split) return null;
    const { table, query } = split;
    const copy = async (value, what) => {
      await copyText(value);
      toast?.success(`Copied ${what}`);
    };
    const risk = queryScriptRisk(query);
    const dynamic = await makeQueryDynamic(query).catch(() => null);
    const actions = [];
    if (table) actions.push({ label: `Apply to the ${table} list`, primary: true, onClick: () => applyListFilter(table, query).catch((err) => toast?.error(err.message || String(err))) });
    if (table && dynamic?.changes.length) actions.push({ label: 'Apply dynamic version', onClick: () => applyListFilter(table, dynamic.query).catch((err) => toast?.error(err.message || String(err))) });
    actions.push({ label: dynamic?.changes.length ? 'Copy dynamic query' : 'Copy', onClick: () => copy(dynamic?.changes.length ? dynamic.query : query, 'the encoded query') });
    return {
      title: 'Encoded query',
      subtitle: table || 'open a list or start with a table name to apply it',
      tone: risk.custom.length ? 'warn' : 'info',
      body: explainQuery(query, { table }),
      actions,
    };
  },
});
