// Hot spots, the pure half: what is slow and what is noisy on the instance. Turns the rows the instance returns
// (syslog_transaction, syslog, sysevent, sys_audit, sys_trigger, outbound HTTP logs) into ranked, plain-language
// groups. No DOM and no network, so all of it is unit tested (tests/hotspots.test.js). The instance reads are in
// src/content/hotspots.js; the panel is src/sidebar/HotspotsPanel.jsx.
//
// Releases differ in which columns these tables have, so every reader here takes the first column that holds a value
// (readNumber / readText) and a section whose column is missing says so instead of showing zeros.

import { escapeQueryValue } from './slashCommands.js';

// --- Time windows ---------------------------------------------------------------------------------------

export const WINDOWS = [
  { id: '15m', label: '15 min', fn: 'minutesAgo', n: 15 },
  { id: '1h', label: '1 hour', fn: 'hoursAgo', n: 1 },
  { id: '24h', label: '24 hours', fn: 'hoursAgo', n: 24 },
  { id: '7d', label: '7 days', fn: 'daysAgo', n: 7 },
];
export const DEFAULT_WINDOW = '1h';

export const windowById = (id) => WINDOWS.find((w) => w.id === id) || WINDOWS.find((w) => w.id === DEFAULT_WINDOW);

/** "sys_created_on>=javascript:gs.hoursAgo(1)": the instance evaluates the helper, so no clock or time zone guessing here. */
export function windowCondition(id, field = 'sys_created_on') {
  const w = windowById(id);
  return `${field}>=javascript:gs.${w.fn}(${w.n})`;
}

// --- Sections -------------------------------------------------------------------------------------------

export const SECTIONS = [
  { id: 'slowPages', group: 'slow', title: 'Slowest requests', hint: 'Grouped by page or API: where the time goes' },
  { id: 'slowUsers', group: 'slow', title: 'Who is behind the slow requests', hint: 'The same slow requests, by user' },
  { id: 'sqlHeavy', group: 'slow', title: 'Database-heavy requests', hint: 'The requests that spent the most time in SQL' },
  { id: 'ruleHeavy', group: 'slow', title: 'Business-rule-heavy requests', hint: 'The requests that spent the most time in business rules' },
  { id: 'slowJobs', group: 'slow', title: 'Scheduled jobs', hint: 'Jobs that finished in the window, by total time' },
  { id: 'runningJobs', group: 'slow', title: 'Jobs running or stuck now', hint: 'Jobs claimed by a node and overdue' },
  { id: 'logMessages', group: 'noisy', title: 'Loudest log messages', hint: 'Ids and numbers collapsed so repeats group' },
  { id: 'errors', group: 'noisy', title: 'Top errors', hint: 'Error-level log entries, grouped' },
  { id: 'logSources', group: 'noisy', title: 'Loudest log sources', hint: 'Which script or job writes the most' },
  { id: 'events', group: 'noisy', title: 'Busiest events', hint: 'Events fired most often' },
  { id: 'users', group: 'noisy', title: 'Busiest users', hint: 'Requests by user, including integrations' },
  { id: 'outbound', group: 'noisy', title: 'Outbound calls', hint: 'REST and SOAP calls by endpoint' },
  { id: 'churn', group: 'noisy', title: 'Most-changed records', hint: 'Records updated again and again' },
  { id: 'tablesWritten', group: 'noisy', title: 'Most-written tables', hint: 'Where the audit trail grows fastest' },
];

// --- Small readers --------------------------------------------------------------------------------------

/** The value of a field whether the API gave a string, a { value } reference or a { display_value } pair. */
export function plain(value) {
  if (value && typeof value === 'object') return String(value.value ?? value.display_value ?? '');
  return value === undefined || value === null ? '' : String(value);
}

/** First numeric value among `names` ("2,345" counts), or null when none of the columns is present. */
export function readNumber(row, names) {
  for (const name of names) {
    const text = plain(row?.[name]).replace(/,/g, '').trim();
    if (text === '') continue;
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function readText(row, names) {
  for (const name of names) {
    const text = plain(row?.[name]).trim();
    if (text) return text;
  }
  return '';
}

export const USER_COLUMNS = ['user_name', 'user', 'sys_created_by'];

/** { name, field } of the user who made a request, whichever column this release fills. */
export function readUser(row) {
  for (const field of USER_COLUMNS) {
    const name = plain(row?.[field]).trim();
    if (name) return { name, field };
  }
  return { name: '(unknown)', field: 'sys_created_by' };
}

// --- Numbers --------------------------------------------------------------------------------------------

/** Nearest-rank percentile of a list of numbers (p between 0 and 100). */
export function percentile(values, p) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * list.length));
  return list[Math.min(rank, list.length) - 1];
}

export function summarize(values) {
  const list = values.filter((v) => Number.isFinite(v));
  if (!list.length) return { count: 0, total: 0, avg: null, p50: null, p95: null, max: null };
  const total = list.reduce((a, b) => a + b, 0);
  return { count: list.length, total, avg: total / list.length, p50: percentile(list, 50), p95: percentile(list, 95), max: Math.max(...list) };
}

/** 850 -> "850 ms", 2400 -> "2.4 s", 72000 -> "1 min 12 s", 4000000 -> "1 h 7 min". */
export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`.replace('.0 s', ' s');
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)} min${totalSeconds % 60 ? ` ${totalSeconds % 60} s` : ''}`;
  const minutes = Math.round(totalSeconds / 60);
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}

export function formatCount(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1000) return String(Math.round(n));
  if (n < 100000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`.replace('.0k', 'k');
  return `${Math.round(n / 1000)}k`;
}

export const formatPercent = (part, whole) => (whole > 0 && Number.isFinite(part) ? `${Math.round((part / whole) * 100)}%` : '-');

// --- Normalising ----------------------------------------------------------------------------------------

/**
 * A log message with everything that varies collapsed, so "Record 123 failed" and "Record 456 failed" are one
 * message: sys_ids, GUIDs, record numbers (INC0012345 -> INC<n>), timestamps, IPs, e-mails, hex and plain numbers.
 */
export function normalizeMessage(text, max = 140) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  s = s
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{32}\b/gi, '<id>')
    .replace(/\b([A-Z]{2,6})\d{5,10}\b/g, '$1<n>')
    .replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?\b/g, '<time>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/(?<![A-Za-z_<])\d+(?:[.,]\d+)?/g, '<n>');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * A condition that finds the entries behind a normalised message: the text before the first placeholder when that is
 * long enough, else the longest fixed stretch. '' when the message is nothing but placeholders.
 */
export function messageFilter(normalized, field = 'message') {
  const text = String(normalized || '').replace(/…$/, '');
  const head = text.split('<')[0].trim();
  if (head.length >= 8) return `${field}STARTSWITH${escapeQueryValue(head)}`;
  const chunks = text.split(/<[a-z]+>/).map((c) => c.trim()).filter((c) => c.length >= 6);
  const longest = chunks.sort((a, b) => b.length - a.length)[0];
  return longest ? `${field}LIKE${escapeQueryValue(longest)}` : '';
}

/**
 * The request pattern of a transaction URL: query string dropped, sys_ids and numbers collapsed
 * ("/api/now/table/incident/<id>" -> "/api/now/table/incident/:id"). Scheduled jobs keep their name.
 */
export function urlPattern(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '(no url)';
  if (/^JOB:/i.test(raw)) return raw.replace(/\s+/g, ' ').slice(0, 90);
  let s = raw.split('#')[0].split('?')[0];
  s = s
    .replace(/\/[0-9a-f]{32}(?=\/|$)/gi, '/:id')
    .replace(/[0-9a-f]{32}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .replace(/\b([A-Z]{2,6})\d{5,10}\b/g, '$1<n>');
  return s.length > 100 ? `${s.slice(0, 99)}…` : s || '(no url)';
}

/** The stable beginning of a pattern, for an urlSTARTSWITH filter: everything before the first placeholder. */
export function patternPrefix(pattern) {
  return String(pattern || '').split(/:id|:n|<n>/)[0] || String(pattern || '');
}

/** 'job' | 'rest' | 'ajax' | 'ui' for a transaction URL. */
export function transactionKind(url) {
  const s = String(url ?? '');
  if (/^JOB:/i.test(s)) return 'job';
  if (/^\/api\//i.test(s)) return 'rest';
  if (/^\/xmlhttp\.do/i.test(s)) return 'ajax';
  return 'ui';
}

// --- Transactions ---------------------------------------------------------------------------------------

export const TRANSACTION_FIELDS = [
  'url',
  'response_time',
  'sql_time',
  'sql_count',
  'business_rule_time',
  'business_rule_count',
  'total_wait_time',
  'user_name',
  'user',
  'sys_created_by',
  'session',
  'type',
  'sys_id',
];

const timeOf = (row) => readNumber(row, ['response_time', 'total_wait_time']);
const sqlTimeOf = (row) => readNumber(row, ['sql_time']);
const ruleTimeOf = (row) => readNumber(row, ['business_rule_time']);

/** Which of the timing columns this release returned at all (so a missing one is reported, not shown as 0). */
export function availableColumns(rows) {
  const has = (names) => rows.some((r) => readNumber(r, names) !== null);
  return { response: has(['response_time', 'total_wait_time']), sql: has(['sql_time']), rules: has(['business_rule_time']) };
}

/** Transactions grouped by URL pattern, biggest total time first. */
export function summarizeTransactions(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const ms = timeOf(row);
    if (ms === null) return;
    const pattern = urlPattern(row.url);
    const g = groups.get(pattern) || { pattern, times: [], sql: 0, sqlKnown: false, rules: 0, rulesKnown: false, sqlCount: 0 };
    g.times.push(ms);
    const sql = sqlTimeOf(row);
    if (sql !== null) {
      g.sql += sql;
      g.sqlKnown = true;
    }
    const rules = ruleTimeOf(row);
    if (rules !== null) {
      g.rules += rules;
      g.rulesKnown = true;
    }
    g.sqlCount += readNumber(row, ['sql_count']) || 0;
    groups.set(pattern, g);
  });
  return [...groups.values()]
    .map((g) => {
      const s = summarize(g.times);
      return {
        pattern: g.pattern,
        kind: transactionKind(g.pattern),
        count: s.count,
        totalMs: s.total,
        avgMs: s.avg,
        p95Ms: s.p95,
        maxMs: s.max,
        sqlShare: g.sqlKnown && s.total > 0 ? g.sql / s.total : null,
        ruleShare: g.rulesKnown && s.total > 0 ? g.rules / s.total : null,
        sqlCount: g.sqlCount,
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** The same transactions by user. */
export function summarizeUsers(rows) {
  const users = new Map();
  rows.forEach((row) => {
    const ms = timeOf(row);
    if (ms === null) return;
    const { name, field } = readUser(row);
    const u = users.get(name) || { user: name, field, times: [], patterns: new Map() };
    u.times.push(ms);
    const pattern = urlPattern(row.url);
    u.patterns.set(pattern, (u.patterns.get(pattern) || 0) + ms);
    users.set(name, u);
  });
  return [...users.values()]
    .map((u) => {
      const s = summarize(u.times);
      const top = [...u.patterns.entries()].sort((a, b) => b[1] - a[1])[0];
      return { user: u.user, field: u.field, count: s.count, totalMs: s.total, avgMs: s.avg, maxMs: s.max, topPattern: top ? top[0] : '' };
    })
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** The single most expensive requests by one timing column ('sql_time', 'business_rule_time'). */
export function heaviest(rows, column, limit = 15) {
  return rows
    .map((row) => ({ row, ms: readNumber(row, [column]) }))
    .filter((r) => r.ms !== null && r.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit)
    .map(({ row, ms }) => ({
      sysId: plain(row.sys_id),
      pattern: urlPattern(row.url),
      ms,
      totalMs: timeOf(row),
      sqlCount: readNumber(row, ['sql_count']),
      ruleCount: readNumber(row, ['business_rule_count']),
      user: readUser(row).name,
    }));
}

/** Scheduled jobs from "JOB: name" transactions: runs, total and slowest. */
export function summarizeJobs(rows) {
  return summarizeTransactions(rows.filter((r) => transactionKind(r.url) === 'job')).map((g) => ({ ...g, name: g.pattern.replace(/^JOB:\s*/i, '') }));
}

/** Jobs a node has claimed and that were due `thresholdMin` or more minutes ago, oldest first. */
export function stuckJobs(rows, now = Date.now(), thresholdMin = 15) {
  return rows
    .map((row) => {
      const due = parseUtc(plain(row.next_action));
      return { name: plain(row.name) || '(unnamed)', node: plain(row.claimed_by), dueMs: due, overdueMin: due === null ? null : Math.max(0, Math.round((now - due) / 60000)), sysId: plain(row.sys_id) };
    })
    .filter((j) => j.overdueMin !== null && j.overdueMin >= thresholdMin)
    .sort((a, b) => b.overdueMin - a.overdueMin);
}

/** "2026-10-20 12:30:00" (the instance stores UTC) -> epoch ms, or null. */
export function parseUtc(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : null;
}

// --- Logs and events ------------------------------------------------------------------------------------

const LEVELS = { 0: 'Info', 1: 'Warning', 2: 'Error', 3: 'Debug' };
export const levelName = (value) => LEVELS[String(value)] || String(value || '');

/** Log rows grouped by normalised message: count, sources and the newest time. Most frequent first. */
export function groupMessages(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const text = plain(row.message) || plain(row.short_message);
    if (!text) return;
    const key = normalizeMessage(text);
    const g = groups.get(key) || { message: key, count: 0, sources: new Map(), levels: new Set(), last: '', sample: text };
    g.count += 1;
    const source = plain(row.source);
    if (source) g.sources.set(source, (g.sources.get(source) || 0) + 1);
    if (plain(row.level) !== '') g.levels.add(plain(row.level));
    const when = plain(row.sys_created_on);
    if (when > g.last) g.last = when;
    groups.set(key, g);
  });
  return [...groups.values()]
    .map((g) => ({
      message: g.message,
      count: g.count,
      source: [...g.sources.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '',
      sourceCount: g.sources.size,
      level: [...g.levels].map(levelName).join('/'),
      last: g.last,
      sample: g.sample.length > 300 ? `${g.sample.slice(0, 299)}…` : g.sample,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Aggregate API (sysparm_group_by) answer -> [{ values: { field: value }, count }]. Handles one group (object),
 * many (array) and groups with several fields.
 */
export function parseGroupCounts(data) {
  const rows = Array.isArray(data?.result) ? data.result : data?.result ? [data.result] : [];
  return rows
    .map((row) => {
      const values = {};
      (row.groupby_fields || []).forEach((g) => {
        values[g.field] = g.value ?? '';
      });
      const count = Number(row.stats?.count);
      return { values, count: Number.isFinite(count) ? count : 0 };
    })
    .filter((g) => Object.keys(g.values).length > 0);
}

/** The top groups by count for one field, with their share of the total. */
export function topGroups(groups, field, limit = 15) {
  const merged = new Map();
  groups.forEach((g) => {
    const key = g.values[field] ?? '';
    merged.set(key, (merged.get(key) || 0) + g.count);
  });
  const total = [...merged.values()].reduce((a, b) => a + b, 0);
  return {
    total,
    rows: [...merged.entries()]
      .map(([value, count]) => ({ value: value === '' ? '(empty)' : value, raw: value, count, share: total ? count / total : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit),
  };
}

/** Most-changed records from a tablename+documentkey grouping. */
export function topRecords(groups, limit = 15) {
  return groups
    .filter((g) => g.values.documentkey)
    .map((g) => ({ table: g.values.tablename || '', sysId: g.values.documentkey, count: g.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// --- Outbound -------------------------------------------------------------------------------------------

/** "https://api.example.com/v1/users/42?x=1" -> "api.example.com/v1/users/:n". */
export function endpointOf(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '(unknown endpoint)';
  const m = /^[a-z]+:\/\/([^/?#]+)([^?#]*)/i.exec(raw);
  const host = m ? m[1] : '';
  const path = urlPattern(m ? m[2] || '/' : raw);
  return `${host}${path === '(no url)' ? '' : path}`.slice(0, 110) || raw.slice(0, 110);
}

export function summarizeOutbound(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const endpoint = endpointOf(readText(row, ['endpoint', 'url']));
    const g = groups.get(endpoint) || { endpoint, count: 0, errors: 0, times: [] };
    g.count += 1;
    const code = readNumber(row, ['response_code', 'http_status', 'status']);
    if (code !== null && code >= 400) g.errors += 1;
    const ms = readNumber(row, ['response_time', 'elapsed']);
    if (ms !== null) g.times.push(ms);
    groups.set(endpoint, g);
  });
  return [...groups.values()]
    .map((g) => ({ endpoint: g.endpoint, count: g.count, errors: g.errors, avgMs: g.times.length ? summarize(g.times).avg : null, maxMs: g.times.length ? Math.max(...g.times) : null }))
    .sort((a, b) => b.count - a.count);
}

// --- Words ----------------------------------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One plain sentence for the top of a result. */
export function headlineFor(id, data = {}) {
  const top = data.rows?.[0];
  if (!top) return '';
  switch (id) {
    case 'slowPages':
      return `${top.pattern} costs the most time: ${plural(top.count, 'slow request')}, ${formatMs(top.avgMs)} on average, the slowest took ${formatMs(top.maxMs)}.`;
    case 'slowUsers':
      return `${top.user} is behind ${formatMs(top.totalMs)} of slow requests (${plural(top.count, 'request')}${top.topPattern ? `, mostly ${top.topPattern}` : ''}).`;
    case 'sqlHeavy':
      return `${top.pattern} spent ${formatMs(top.ms)} in the database${top.sqlCount ? ` over ${plural(top.sqlCount, 'query')}` : ''}.`;
    case 'ruleHeavy':
      return `${top.pattern} spent ${formatMs(top.ms)} in business rules${top.ruleCount ? ` (${plural(top.ruleCount, 'rule run')})` : ''}.`;
    case 'slowJobs':
      return `${top.name} used ${formatMs(top.totalMs)} over ${plural(top.count, 'run')}; the longest run took ${formatMs(top.maxMs)}.`;
    case 'runningJobs':
      return `${top.name} was due ${formatMs(top.overdueMin * 60000)} ago and is still claimed${top.node ? ` by ${top.node}` : ''}.`;
    case 'logMessages':
      return `"${top.message}" was logged ${plural(top.count, 'time')}${top.source ? ` by ${top.source}` : ''}.`;
    case 'errors':
      return `The most frequent error appears ${plural(top.count, 'time')}${top.source ? ` (${top.source})` : ''}: ${top.message}`;
    case 'logSources':
    case 'events':
    case 'users':
    case 'tablesWritten':
      return `${top.value} is the largest: ${formatCount(top.count)} (${formatPercent(top.count, data.total)} of ${formatCount(data.total)}).`;
    case 'outbound':
      return `${top.endpoint} was called ${plural(top.count, 'time')}${top.errors ? `, ${plural(top.errors, 'call')} failed` : ''}.`;
    case 'churn':
      return `One ${top.table || 'record'} was changed ${plural(top.count, 'time')} in the window.`;
    default:
      return '';
  }
}

/** A result ({ columns, rows: [{ cells }] }) as a Markdown table. */
export function resultToMarkdown(title, result, windowLabel = '') {
  const cell = (c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  const head = `| ${result.columns.map(cell).join(' | ')} |`;
  const rule = `| ${result.columns.map(() => '---').join(' | ')} |`;
  const body = result.rows.map((r) => `| ${r.cells.map(cell).join(' | ')} |`);
  return [`**${title}**${windowLabel ? ` (last ${windowLabel})` : ''}`, '', result.headline ? `${result.headline}\n` : '', head, rule, ...body].join('\n').replace(/\n\n\n/g, '\n\n');
}

/** What to ask the AI about one result. */
export function hotspotPrompt(title, result, windowLabel) {
  return (
    `On this ServiceNow instance, "${title}" looks like this for the last ${windowLabel}. ` +
    'Say what is most likely wrong or wasteful, which one or two of these to look at first and what to check there. ' +
    'Be concrete about ServiceNow causes (business rules on hot tables, missing indexes, script includes called in loops, ' +
    'jobs that overlap, integrations that retry, logging in loops) and do not invent data that is not in the table.\n\n' +
    resultToMarkdown(title, result, windowLabel)
  );
}
