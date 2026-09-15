// Log and error triage: pull recent instance errors, slow transactions, and
// resolve stack traces back to the script record that produced them.

import { queryTable } from './tableApi.js';

// syslog.level is stored numerically. 0 = info/log, 1 = warning, 2 = error.
// This mapping is consistent across recent releases but is worth confirming on
// your instance - see docs/decisions.md.
const LEVELS = { error: '2', warn: '1', info: '0' };

const LOG_FIELDS = ['sys_id', 'sys_created_on', 'level', 'source', 'message', 'sys_created_by'];

/**
 * Recent entries from the system log.
 *
 * @param {{level?: 'error'|'warn'|'info'|'all', minutes?: number, contains?: string, limit?: number}} options
 */
export async function fetchRecentLogs(options = {}) {
  const { level = 'error', minutes = 60, contains = '', limit = 100 } = options;

  const windowMinutes = Math.max(1, Math.min(minutes, 60 * 24 * 7));
  const clauses = [`sys_created_on>=javascript:gs.minutesAgoStart(${windowMinutes})`];

  if (level !== 'all' && LEVELS[level] !== undefined) {
    clauses.push(`level=${LEVELS[level]}`);
  }
  if (contains) {
    if (contains.includes('^')) throw new Error('Filter text cannot contain "^".');
    clauses.push(`messageLIKE${contains.trim()}`);
  }
  clauses.push('ORDERBYDESCsys_created_on');

  return queryTable('syslog', clauses.join('^'), LOG_FIELDS, { limit });
}

/** Log entries that mention a specific sys_id - useful from a record form. */
export async function fetchLogsForRecord(sysId, { limit = 50 } = {}) {
  if (!sysId) return [];
  return queryTable(
    'syslog',
    `messageLIKE${sysId}^ORDERBYDESCsys_created_on`,
    LOG_FIELDS,
    { limit }
  );
}

/**
 * Slowest transactions in the recent past. Good for answering "the instance
 * feels slow, what is doing it?".
 */
export async function fetchSlowTransactions({ minutes = 60, limit = 40 } = {}) {
  const windowMinutes = Math.max(1, Math.min(minutes, 60 * 24));
  return queryTable(
    'syslog_transaction',
    `sys_created_on>=javascript:gs.minutesAgoStart(${windowMinutes})^ORDERBYDESCresponse_time`,
    ['sys_id', 'sys_created_on', 'url', 'type', 'response_time', 'user_name', 'sql_count', 'sql_time'],
    { limit }
  );
}

/**
 * Group similar log messages together so 400 copies of the same error collapse
 * into one line. Digests strip volatile parts (sys_ids, numbers, timestamps).
 */
export function groupLogs(logs) {
  const groups = new Map();

  logs.forEach((entry) => {
    const digest = (entry.message || '')
      .replace(/[0-9a-f]{32}/gi, '<sys_id>')
      .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/g, '<timestamp>')
      .replace(/\b\d+\b/g, '<n>')
      .slice(0, 300);

    if (!groups.has(digest)) {
      groups.set(digest, {
        digest,
        count: 0,
        sample: entry.message,
        source: entry.source,
        firstSeen: entry.sys_created_on,
        lastSeen: entry.sys_created_on,
      });
    }

    const group = groups.get(digest);
    group.count += 1;
    if (entry.sys_created_on < group.firstSeen) group.firstSeen = entry.sys_created_on;
    if (entry.sys_created_on > group.lastSeen) group.lastSeen = entry.sys_created_on;
  });

  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/**
 * Pull artifact references out of a ServiceNow stack trace.
 *
 * ServiceNow stack traces are not standardised across releases, so several
 * shapes are matched. This is deliberately generous - a false candidate simply
 * fails to resolve to a record and is dropped.
 */
export function parseStackTrace(text) {
  if (!text) return [];

  const candidates = new Map();

  function add(name, line, hint) {
    if (!name) return;
    const clean = name.trim();
    if (clean.length < 2 || clean.length > 100) return;
    const key = `${clean}:${line || ''}`;
    if (!candidates.has(key)) candidates.set(key, { name: clean, line: line ? Number(line) : null, hint });
  }

  // "sys_script_include.MyUtils.script:42" / "sys_script.My Rule.script:12"
  const dotted = /\b(sys_script_include|sys_script_client|sys_script|sys_ui_action|sysauto_script|sys_ws_operation)\.([^.:\n]+)\.[A-Za-z_]+:(\d+)/g;
  let match = dotted.exec(text);
  while (match) {
    add(match[2], match[3], match[1]);
    match = dotted.exec(text);
  }

  // "Evaluator: java.lang.... at MyScriptInclude line 17"
  const atLine = /\bat\s+([A-Za-z0-9_.\- ]{2,80}?)\s*(?:,|:)?\s*line\s*(\d+)/gi;
  match = atLine.exec(text);
  while (match) {
    add(match[1], match[2], null);
    match = atLine.exec(text);
  }

  // "Script Include: MyUtils" / "Business Rule: Set priority"
  const labelled = /\b(Script Include|Business Rule|Client Script|UI Action|Scheduled Job)\s*[:\-]\s*([^\n,;]{2,80})/gi;
  match = labelled.exec(text);
  while (match) {
    add(match[2], null, match[1]);
    match = labelled.exec(text);
  }

  // Bare "new MyScriptInclude(" references inside the trace text.
  const constructed = /\bnew\s+([A-Z][A-Za-z0-9_]{2,60})\s*\(/g;
  match = constructed.exec(text);
  while (match) {
    add(match[1], null, 'constructor');
    match = constructed.exec(text);
  }

  return [...candidates.values()];
}

const TRACE_LOOKUP_TABLES = [
  { table: 'sys_script_include', label: 'Script Include', nameField: 'name' },
  { table: 'sys_script', label: 'Business Rule', nameField: 'name' },
  { table: 'sys_script_client', label: 'Client Script', nameField: 'name' },
  { table: 'sys_ui_action', label: 'UI Action', nameField: 'name' },
  { table: 'sysauto_script', label: 'Scheduled Job', nameField: 'name' },
];

/**
 * Resolve parsed stack-trace candidates to real records and return the source
 * lines around the reported line number.
 */
export async function resolveStackTrace(text, { contextLines = 6 } = {}) {
  const candidates = parseStackTrace(text);
  if (!candidates.length) return { candidates: [], resolved: [] };

  const resolved = [];

  for (const candidate of candidates) {
    for (const def of TRACE_LOOKUP_TABLES) {
      // eslint-disable-next-line no-await-in-loop -- traces are short; keeping
      // this sequential avoids hammering the instance with parallel lookups.
      const rows = await queryTable(
        def.table,
        `${def.nameField}=${candidate.name}`,
        ['sys_id', def.nameField, 'script'],
        { limit: 1 }
      );
      if (!rows.length) continue;

      const row = rows[0];
      const scriptLines = (row.script || '').split('\n');
      let excerpt = null;

      if (candidate.line && candidate.line <= scriptLines.length) {
        const start = Math.max(0, candidate.line - 1 - contextLines);
        const end = Math.min(scriptLines.length, candidate.line + contextLines);
        excerpt = scriptLines
          .slice(start, end)
          .map((lineText, index) => {
            const number = start + index + 1;
            const marker = number === candidate.line ? '>>' : '  ';
            return `${marker} ${String(number).padStart(4)} | ${lineText}`;
          })
          .join('\n');
      }

      resolved.push({
        name: candidate.name,
        line: candidate.line,
        table: def.table,
        label: def.label,
        sysId: row.sys_id,
        excerpt,
        scriptLength: scriptLines.length,
      });
      break;
    }
  }

  return { candidates, resolved };
}

/** Prompt for /logs - grouped errors plus slow transactions. */
export function buildLogTriagePrompt({ groups, slow, minutes }) {
  const groupText = groups.length
    ? groups
        .slice(0, 25)
        .map((g) => `- (${g.count}x, ${g.firstSeen} to ${g.lastSeen}) [${g.source || 'unknown source'}] ${g.sample.slice(0, 400)}`)
        .join('\n')
    : '- No error entries in the window.';

  const slowText = slow?.length
    ? slow
        .slice(0, 15)
        .map((t) => `- ${t.response_time}ms (${t.sql_count || '?'} queries, ${t.sql_time || '?'}ms SQL) ${t.url} [${t.user_name}]`)
        .join('\n')
    : '- No transaction data available.';

  return (
    'You are triaging a ServiceNow instance. Group the errors below by ROOT CAUSE (not by message text), ' +
    'rank them by operational impact, and for each one name the most likely artifact at fault and the ' +
    'next diagnostic step. Call out anything that looks like a recent regression.\n\n' +
    `## Errors in the last ${minutes} minutes (deduplicated, with occurrence counts)\n${groupText}\n\n` +
    `## Slowest transactions in the same window\n${slowText}`
  );
}

/** Prompt for /trace - stack trace plus resolved source context. */
export function buildTracePrompt(traceText, resolved) {
  const sourceText = resolved.length
    ? resolved
        .map(
          (r) =>
            `### ${r.label}: ${r.name}${r.line ? ` (reported line ${r.line} of ${r.scriptLength})` : ''}\n` +
            (r.excerpt ? `\`\`\`javascript\n${r.excerpt}\n\`\`\`` : '(line number not reported; full script not shown)')
        )
        .join('\n\n')
    : '(No referenced artifacts could be resolved to records on this instance.)';

  return (
    'Diagnose the following ServiceNow error. Explain in plain language what went wrong, which line is ' +
    'responsible, why it failed, and give a concrete corrected snippet.\n\n' +
    `## Stack trace / error text\n${traceText.slice(0, 4000)}\n\n` +
    `## Source resolved from the instance\n${sourceText}`
  );
}
