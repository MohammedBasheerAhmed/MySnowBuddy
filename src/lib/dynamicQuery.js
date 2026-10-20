// Encoded queries, made dynamic and applied to a list. Pure and deterministic (no AI tokens):
//
//   makeDynamic(query, { now, userId, userName, groupIds })
//       A filter saved from the list UI is static: "opened_at>=2026-10-13 00:00:00", "assigned_to=<your sys_id>".
//       Written as a script expression it keeps meaning the same thing tomorrow: "opened_at>=javascript:gs.daysAgoStart(7)",
//       "assigned_to=javascript:gs.getUserID()". Dates that sit exactly on a day, month, quarter or year boundary are
//       matched to the gs.* helpers, your own sys_id/user name/groups are replaced by the helpers that mean "me".
//       Anything not recognised is left alone and reported.
//   looksLikeEncodedQuery / splitTableQuery
//       Decide whether text typed into the palette IS an encoded query (and for which table), so it can be applied.
//   queryScripts / classifyScript
//       The javascript: parts of a query. The list evaluates them on the server when it loads, so anything outside the
//       known filter helpers is flagged for a confirmation before the filter is applied.

import { parseEncodedQuery } from './query.js';

const CARET = '\u0001';
const SYS_ID = /^[0-9a-f]{32}$/i;
const DAY = 86400000;

// --- Tokens ---------------------------------------------------------------------------------------------

const splitTokens = (query) =>
  String(query || '')
    .trim()
    .replace(/\^\^/g, CARET)
    .split('^');
const joinTokens = (tokens) => tokens.map((t) => t.split(CARET).join('^^')).join('^');

/** { prefix: 'NQ' | 'OR' | '', condition: { field, op, value } | null } for one token. */
function readToken(token) {
  const text = token.split(CARET).join('^');
  if (!text || text === 'EQ' || /^(ORDERBY|GROUPBY|RLQUERY)/.test(text)) return { prefix: '', condition: null, text };
  const prefix = /^(NQ|OR)/.exec(text)?.[1] || '';
  const parsed = parseEncodedQuery(text.slice(prefix.length));
  const condition = parsed.groups[0]?.[0];
  return { prefix, condition: condition ? { field: condition.field, op: condition.op, value: condition.value } : null, text };
}

// --- Dates ----------------------------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const GENERATE_RE = /^javascript:gs\.dateGenerate\(\s*'(\d{4}-\d{2}-\d{2})'\s*,\s*'(\d{2}:\d{2}:\d{2}|start|end)'\s*\)$/;

/** { y, m, d, kind: 'start' | 'end' } for a date literal that sits on the start or end of a day, else null. */
export function parseDateLiteral(value) {
  const text = String(value || '').trim();
  const gen = GENERATE_RE.exec(text);
  let match;
  let time;
  if (gen) {
    match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(gen[1]);
    time = gen[2] === 'start' ? '00:00:00' : gen[2] === 'end' ? '23:59:59' : gen[2];
  } else {
    match = DATE_RE.exec(text);
    if (!match) return null;
    time = match[4] === undefined ? '00:00:00' : `${match[4]}:${match[5]}:${match[6] ?? '00'}`;
  }
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  if (time === '00:00:00') return { y, m, d, kind: 'start' };
  if (time === '23:59:59') return { y, m, d, kind: 'end' };
  return null;
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const quarterOf = (m) => Math.floor((m - 1) / 3);

/**
 * The gs.* helper expression that means this day boundary relative to `now`, plus other expressions that mean the same
 * thing today. null when no helper matches.
 */
export function dynamicDate({ y, m, d, kind }, now = new Date()) {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const k = Math.round((today - Date.UTC(y, m - 1, d)) / DAY); // days ago (negative: in the future)
  const monthsAgo = now.getFullYear() * 12 + now.getMonth() - (y * 12 + m - 1);
  const quartersAgo = now.getFullYear() * 4 + quarterOf(now.getMonth() + 1) - (y * 4 + quarterOf(m));
  const yearsAgo = now.getFullYear() - y;
  const start = kind === 'start';
  const edge = start ? d === 1 : d === daysInMonth(y, m);
  const named = (period) => `gs.${start ? 'beginningOf' : 'endOf'}${period}()`;
  const found = [];
  const numbered = []; // "9 months ago" reads worse than a named period, so these come after the named ones

  if (edge) {
    if (monthsAgo === 0) found.push(named('ThisMonth'));
    if (monthsAgo === 1) found.push(named('LastMonth'));
    if (monthsAgo === -1) found.push(named('NextMonth'));
    if (monthsAgo > 1 && monthsAgo <= 36) numbered.push(`gs.monthsAgo${start ? 'Start' : 'End'}(${monthsAgo})`);
  }
  if (edge && (start ? (m - 1) % 3 === 0 : m % 3 === 0)) {
    if (quartersAgo === 0) found.push(named('ThisQuarter'));
    if (quartersAgo === 1) found.push(named('LastQuarter'));
    if (quartersAgo === -1) found.push(named('NextQuarter'));
    if (quartersAgo > 1 && quartersAgo <= 12) numbered.push(`gs.quartersAgo${start ? 'Start' : 'End'}(${quartersAgo})`);
  }
  const yearEdge = start ? d === 1 && m === 1 : d === 31 && m === 12;
  if (yearEdge) {
    if (yearsAgo === 0) found.push(named('ThisYear'));
    if (yearsAgo === 1) found.push(named('LastYear'));
    if (yearsAgo === -1) found.push(named('NextYear'));
  }
  found.push(...numbered);
  if (k === 0) found.push(named('Today'));
  if (k === 1) found.push(named('Yesterday'));
  if (k >= 2 && k <= 3650) found.push(`gs.daysAgo${start ? 'Start' : 'End'}(${k})`);
  if (!found.length) return null;

  // A month, quarter or year boundary reads as that period; for everything else the day helpers are exact.
  const [best, ...alternatives] = found;
  return { expr: `javascript:${best}`, alternatives: alternatives.map((e) => `javascript:${e}`), daysAgo: k };
}

// --- Me, my groups --------------------------------------------------------------------------------------

const USER_NAME_FIELDS = new Set(['sys_created_by', 'sys_updated_by']);

function dynamicUser(cond, { userId, userName }) {
  if (!['=', '!='].includes(cond.op)) return null;
  if (userId && cond.value.toLowerCase() === String(userId).toLowerCase() && SYS_ID.test(cond.value)) {
    return { expr: 'javascript:gs.getUserID()', why: 'the current user' };
  }
  if (userName && USER_NAME_FIELDS.has(cond.field) && cond.value === userName) {
    return { expr: 'javascript:gs.getUserName()', why: 'the current user name' };
  }
  return null;
}

function dynamicGroups(cond, { groupIds }) {
  if (cond.op !== 'IN' || !Array.isArray(groupIds) || !groupIds.length) return null;
  const listed = cond.value.split(',').map((v) => v.trim().toLowerCase());
  if (!listed.every((v) => SYS_ID.test(v))) return null;
  const mine = new Set(groupIds.map((g) => String(g).toLowerCase()));
  if (listed.length !== mine.size || !listed.every((v) => mine.has(v))) return null;
  return { expr: 'javascript:getMyGroups()', why: 'the groups the current user belongs to' };
}

// --- makeDynamic ----------------------------------------------------------------------------------------

/**
 * @param {string} query static encoded query
 * @param {{ now?: Date, userId?: string, userName?: string, groupIds?: string[] }} [context]
 * @returns {{ query: string, changes: Array<{ token: string, to: string, why: string, alternatives?: string[] }>, unchanged: number, notes: string[] }}
 */
export function makeDynamic(query, context = {}) {
  const now = context.now || new Date();
  const tokens = splitTokens(query);
  const changes = [];
  let unchanged = 0;

  const out = tokens.map((raw) => {
    const { prefix, condition, text } = readToken(raw);
    if (!condition) return raw;
    const rewrite = (value, why, alternatives) => {
      const to = `${prefix}${condition.field}${condition.op}${value}`;
      changes.push({ token: text, to, why, ...(alternatives?.length ? { alternatives } : {}) });
      return to.split('^').join(CARET);
    };

    const user = dynamicUser(condition, context);
    if (user) return rewrite(user.expr, `${condition.value.slice(0, 8)}… is ${user.why}`);
    const groups = dynamicGroups(condition, context);
    if (groups) return rewrite(groups.expr, `these are ${groups.why}`);

    if (['=', '!=', '>', '>=', '<', '<='].includes(condition.op)) {
      const date = parseDateLiteral(condition.value);
      const dynamic = date && dynamicDate(date, now);
      if (dynamic) return rewrite(dynamic.expr, describeDate(date, dynamic), dynamic.alternatives);
    }
    if (condition.op === 'BETWEEN') {
      const [a, b, ...extra] = condition.value.split('@');
      const from = parseDateLiteral(a);
      const to = parseDateLiteral(b);
      const dynFrom = from && dynamicDate(from, now);
      const dynTo = to && dynamicDate(to, now);
      if (!extra.length && (dynFrom || dynTo)) {
        const value = `${dynFrom ? dynFrom.expr : a}@${dynTo ? dynTo.expr : b}`;
        return rewrite(value, [dynFrom && describeDate(from, dynFrom), dynTo && describeDate(to, dynTo)].filter(Boolean).join('; '));
      }
    }
    unchanged += 1;
    return raw;
  });

  const notes = [];
  if (changes.some((c) => /gs\.(daysAgo|beginningOf|endOf|monthsAgo|quartersAgo)/.test(c.to))) {
    notes.push(`Dates were matched against this browser's clock (${now.toDateString()}). If your instance runs in another time zone, check the first and last day.`);
  }
  if (changes.some((c) => /getMyGroups/.test(c.to))) notes.push('getMyGroups() is the global helper used by the standard "My groups" filters.');
  return { query: joinTokens(out), changes, unchanged, notes };
}

function describeDate(date, dynamic) {
  const label = `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')} ${date.kind === 'start' ? 'start' : 'end'} of day`;
  if (dynamic.daysAgo === 0) return `${label} is today`;
  if (dynamic.daysAgo === 1) return `${label} is yesterday`;
  if (dynamic.daysAgo > 1) return `${label} is ${dynamic.daysAgo} days ago`;
  return `${label} is in ${-dynamic.daysAgo} days`;
}

// --- Is this text an encoded query? ---------------------------------------------------------------------

const FIELD = '[a-z_][a-z0-9_]*(?:\\.[a-z_][a-z0-9_]*)*';
const OPERATOR =
  '(?:!=|>=|<=|=|>|<|NOT LIKE|NOT IN|NOTLIKE|LIKE|STARTSWITH|ENDSWITH|IN|ISEMPTY|ISNOTEMPTY|BETWEEN|SAMEAS|NSAMEAS|ON|NOTON|DYNAMIC|ANYTHING|EMPTYSTRING|RELATIVE(?:GT|LT|GE|LE|EE)|DATEPART|MORETHAN|LESSTHAN|VALCHANGES|CHANGESFROM|CHANGESTO|INSTANCEOF)';
// Case matters: field names are lower case and the word operators upper case, so ordinary words ("button", "login") never match.
const FIRST_CONDITION = new RegExp(`^(?:NQ|OR)?${FIELD}${OPERATOR}`);
const TABLE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * True when `text` is an encoded query ("active=true^priority=1", "opened_at>=javascript:gs.daysAgoStart(7)") and not
 * a sentence, a record number, a slash command or a sys_id. The first condition must start with a field name directly
 * followed by an operator, which ordinary words never do.
 */
export function looksLikeEncodedQuery(text) {
  const value = String(text || '').trim();
  if (value.length < 3 || value.length > 4000 || /^[/@]/.test(value) || /\n/.test(value)) return false;
  const first = value.replace(/^\^+/, '').replace(/^(ORDERBY(?:DESC)?[a-z_.]+\^)+/i, '');
  if (!FIRST_CONDITION.test(first)) return false;
  // "name=value" alone is a plain filter; "the user said: x=y" is not (spaces before the operator).
  return parseEncodedQuery(first).groups.some((g) => g.length > 0);
}

/**
 * "incident active=true^priority=1" -> { table: 'incident', query: 'active=true^priority=1' }; a bare query uses
 * `currentTable`. null when there is no table to apply it to.
 */
export function splitTableQuery(text, currentTable = '') {
  const value = String(text || '').trim();
  const lead = /^([a-z][a-z0-9_]*)\s+(\S.*)$/s.exec(value);
  if (lead && TABLE_NAME.test(lead[1]) && looksLikeEncodedQuery(lead[2]) && !looksLikeEncodedQuery(value)) {
    return { table: lead[1], query: lead[2].trim() };
  }
  if (!looksLikeEncodedQuery(value)) return null;
  return TABLE_NAME.test(currentTable || '') ? { table: currentTable, query: value } : { table: '', query: value };
}

// --- Script expressions ---------------------------------------------------------------------------------

/** The javascript: expressions in a query (BETWEEN values hold two). */
export function queryScripts(query) {
  const found = [];
  const re = /javascript:(.*?)(?=@javascript:|\^|$)/gi;
  let match;
  while ((match = re.exec(String(query || '')))) found.push(`javascript:${match[1]}`);
  return found;
}

const PERIODS = 'Today|Yesterday|Tomorrow|(?:This|Last|Next)(?:Week|Month|Quarter|Year)|Last\\d+Days';
const KNOWN_SCRIPTS = [
  new RegExp(`^javascript:gs\\.(?:beginningOf|endOf)(?:${PERIODS})\\(\\)$`),
  /^javascript:gs\.(?:days|hours|minutes|months|quarters|years)Ago(?:Start|End)?\(\s*-?\d{1,5}\s*\)$/,
  /^javascript:gs\.dateGenerate\(\s*'\d{4}-\d{2}-\d{2}'\s*,\s*'(?:\d{2}:\d{2}:\d{2}|start|end)'\s*\)$/,
  /^javascript:gs\.(?:getUserID|getUserName|nowDateTime|now)\(\)$/,
  /^javascript:(?:gs\.)?getMyGroups\(\)$/,
  /^javascript:gs\.getUser\(\)\.getMyGroups\(\)$/,
];

/** { known, kind } - known helpers are the ones the filter UI itself writes. */
export function classifyScript(expression) {
  const text = String(expression || '').trim();
  return KNOWN_SCRIPTS.some((re) => re.test(text)) ? { known: true } : { known: false };
}

/** { scripts: string[], custom: string[] } for a query: custom ones need a confirmation before the list runs them. */
export function queryScriptRisk(query) {
  const scripts = queryScripts(query);
  return { scripts, custom: scripts.filter((s) => !classifyScript(s).known) };
}
