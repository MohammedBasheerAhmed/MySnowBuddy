// Deterministic ServiceNow-specific static analysis.
//
// This runs entirely in the browser with no AI call, which means it is free,
// instant and gives the same answer every time. The AI review (/review) runs
// AFTER this and receives these findings as input, so the model spends its
// attention on semantics rather than re-deriving well-known anti-patterns.
//
// IMPORTANT: these are regex/heuristic rules, not a JavaScript parser. They
// will occasionally produce false positives (for example a matched pattern
// inside a comment or string literal). Findings are advisory - always read the
// flagged line before acting on it.

import { buildScopes } from './scopes.js';

export const SEVERITY = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

const CLIENT_TABLES = ['sys_script_client', 'catalog_script_client', 'sys_ui_policy', 'catalog_ui_policy', 'sys_ui_script'];
const SERVER_TABLES = [
  'sys_script',
  'sys_script_include',
  'sysauto_script',
  'sysevent_script_action',
  'sys_security_acl',
  'sys_ws_operation',
  'sys_script_fix',
  'sys_transform_script',
  'sys_processor',
  'sys_script_email',
  'sys_hub_action_type_definition',
];
// UI actions run on either side (the "Client" checkbox), and some do both.
const EITHER_SIDE_TABLES = ['sys_ui_action'];

/**
 * 'client' | 'server' | '' (unknown or both). An explicit context.side wins; a
 * UI action's side is read from the script: client code calls g_form/gsftSubmit,
 * server code uses current/action/gs. A script that does both gets neither.
 */
export function scriptSide(ctx, masked = '') {
  if (ctx.side === 'client' || ctx.side === 'server') return ctx.side;
  if (CLIENT_TABLES.includes(ctx.table)) return 'client';
  if (SERVER_TABLES.includes(ctx.table)) return 'server';
  if (EITHER_SIDE_TABLES.includes(ctx.table)) {
    const client = /\b(?:g_form|g_user|g_list|g_modal|gsftSubmit|GlideAjax|GlideModal|GlideDialogWindow)\b/.test(masked);
    const server = /\b(?:current|previous|action|gs)\s*\.|\btypeof\s+window\s*={2,3}/.test(masked);
    if (client && !server) return 'client';
    if (server && !client) return 'server';
  }
  return '';
}

function isClientSide(ctx) {
  return ctx.side === 'client';
}

function isServerSide(ctx) {
  return ctx.side === 'server';
}

/**
 * Strip line comments and string literals so pattern rules do not fire on
 * text inside quotes or commentary. Block comments are blanked out too. We
 * preserve line structure (and line length) so reported line numbers and
 * columns still line up with the original source.
 *
 * lint, verify and apiCheck each mask the same script, so the last result is remembered.
 */
export function maskNonCode(source) {
  if (source === lastMask.source) return lastMask.masked;
  const masked = maskSource(source);
  lastMask = { source, masked };
  return masked;
}

let lastMask = { source: null, masked: '' };

function maskSource(source) {
  const out = [];
  let inBlockComment = false;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '\n') {
      out.push('\n');
      inString = false;
      stringChar = '';
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        out.push('  ');
        i += 1;
      } else {
        out.push(' ');
      }
      continue;
    }

    if (inString) {
      out.push(' ');
      if (ch === '\\') {
        // Skip the escaped character so \" does not end the string.
        if (next && next !== '\n') {
          out.push(' ');
          i += 1;
        }
      } else if (ch === stringChar) {
        inString = false;
        stringChar = '';
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      out.push('  ');
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      // Blank the rest of the line.
      while (i < source.length && source[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      i -= 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
      out.push(' ');
      continue;
    }

    out.push(ch);
  }

  return out.join('');
}

// Calls of $, $$, $j (ServiceNow's jQuery alias) and jQuery that are code (found in the masked
// line, so not inside a string or comment) and not a property access like obj.$(...).
const DOM_CALL_RE = /(^|[^\w$.])(\$\$|\$j|\$|jQuery)\s*\(/g;
const DOM_API_RE = /\b(document\s*\.\s*(getElementById|querySelector|getElementsBy)|angular\s*\.\s*element\s*\()/;

/**
 * DOM selector calls in one line. String contents are blanked in the masked line, so the call is
 * found there and its first argument is read from the raw line at the same position (masking keeps
 * columns). $$, $j and jQuery always reach the DOM; $ only counts with a string argument
 * ($('#id') in jQuery, $('elementId') in Prototype), so `$` as an ordinary variable is left alone.
 */
export function hasDomSelectorCall(raw, code) {
  DOM_CALL_RE.lastIndex = 0;
  let m;
  while ((m = DOM_CALL_RE.exec(code))) {
    if (m[2] !== '$') return true;
    if (/^\s*['"`]/.test(raw.slice(m.index + m[0].length))) return true;
  }
  return false;
}

/** Build [{ lineNumber, raw, code }] where `code` has comments/strings masked. */
export function buildLines(source) {
  const rawLines = source.split('\n');
  const maskedLines = maskNonCode(source).split('\n');
  return rawLines.map((raw, index) => ({
    lineNumber: index + 1,
    raw,
    code: maskedLines[index] ?? '',
  }));
}

/**
 * Rules that fire per matching line. Each rule may declare `appliesTo(ctx)` to
 * restrict itself to server-side, client-side or a specific table/when value.
 */
const LINE_RULES = [
  {
    id: 'no-current-update-in-before-br',
    severity: SEVERITY.HIGH,
    pattern: /\bcurrent\s*\.\s*update\s*\(/,
    appliesTo: (ctx) => ctx.table === 'sys_script' && ctx.when === 'before',
    message: 'current.update() inside a "before" Business Rule.',
    suggestion:
      'The platform saves `current` for you after a before rule. Calling update() here causes a ' +
      'second write and can trigger recursive rule execution. Just set the field values.',
  },
  {
    id: 'no-abort-in-after-br',
    severity: SEVERITY.MEDIUM,
    pattern: /\bcurrent\s*\.\s*setAbortAction\s*\(/,
    appliesTo: (ctx) => ctx.table === 'sys_script' && (ctx.when === 'after' || ctx.when === 'async'),
    message: 'setAbortAction() in an after/async Business Rule has no effect.',
    suggestion: 'The database operation has already committed. Move this logic to a before rule.',
  },
  {
    id: 'no-gliderecord-in-client-script',
    severity: SEVERITY.HIGH,
    pattern: /\bnew\s+GlideRecord\s*\(/,
    appliesTo: isClientSide,
    message: 'GlideRecord used in a client-side script.',
    suggestion:
      'Client-side GlideRecord is synchronous, slow, and unsupported in Service Portal/Mobile. ' +
      'Use GlideAjax with a Script Include, or g_form.getReference() with a callback.',
  },
  {
    id: 'no-sync-glideajax',
    severity: SEVERITY.HIGH,
    pattern: /\.\s*getXMLWait\s*\(/,
    message: 'Synchronous GlideAjax (getXMLWait) blocks the browser UI.',
    suggestion: 'Use getXML(callback) or getXMLAnswer(callback) instead. getXMLWait is not supported in Service Portal.',
  },
  {
    id: 'no-sync-getreference',
    severity: SEVERITY.MEDIUM,
    // Strings are blanked in the masked source, so a single string argument looks like whitespace.
    pattern: /\bgetReference\s*\(\s*\)/,
    message: 'g_form.getReference() called without a callback runs synchronously.',
    suggestion: 'Pass a callback as the second argument so the request does not block the form.',
  },
  {
    id: 'no-eval',
    severity: SEVERITY.HIGH,
    pattern: /(^|[^.\w])eval\s*\(/,
    message: 'Use of eval().',
    suggestion:
      'eval() executes arbitrary code and is a common injection sink. Use JSON.parse() for data, ' +
      'or a lookup object/GlideScriptEvaluator alternative for dispatch.',
  },
  {
    id: 'no-delete-multiple',
    severity: SEVERITY.HIGH,
    pattern: /\.\s*deleteMultiple\s*\(/,
    message: 'deleteMultiple() performs a bulk, irreversible delete.',
    suggestion:
      'Confirm the query is fully constrained and the row count was verified first. Consider a ' +
      'dry run that logs getRowCount() before deleting.',
  },
  {
    id: 'no-dom-in-client-script',
    severity: SEVERITY.MEDIUM,
    pattern: DOM_API_RE,
    // $('#id') / $('elementId') / $j(...) / $$('.x') / jQuery(...): see hasDomSelectorCall.
    match: (raw, code) => DOM_API_RE.test(code) || hasDomSelectorCall(raw, code),
    appliesTo: isClientSide,
    message: 'Direct DOM manipulation in a client script.',
    suggestion:
      'DOM access is unsupported in Service Portal, Mobile and Next Experience, and breaks on ' +
      'upgrade. Use the g_form API instead.',
  },
  {
    id: 'no-alert-in-client-script',
    severity: SEVERITY.LOW,
    pattern: /(^|[^.\w])alert\s*\(/,
    appliesTo: isClientSide,
    message: 'alert() blocks the browser and looks unpolished.',
    suggestion: 'Use g_form.addInfoMessage(), addErrorMessage() or showFieldMsg().',
  },
  {
    id: 'no-g-form-server-side',
    severity: SEVERITY.HIGH,
    pattern: /\bg_form\s*\./,
    appliesTo: isServerSide,
    message: 'g_form referenced in a server-side script.',
    suggestion: 'g_form only exists in the browser. This will throw at runtime.',
  },
  {
    id: 'no-gs-log-scoped',
    severity: SEVERITY.LOW,
    pattern: /\bgs\s*\.\s*log\s*\(/,
    appliesTo: isServerSide,
    message: 'gs.log() is deprecated in scoped applications.',
    suggestion: 'Use gs.info(), gs.warn() or gs.error() so the entry gets a proper level and source.',
  },
  {
    id: 'no-console-log-server',
    severity: SEVERITY.LOW,
    pattern: /\bconsole\s*\.\s*log\s*\(/,
    appliesTo: isServerSide,
    message: 'console.log() in a server-side script goes nowhere useful.',
    suggestion: 'Use gs.info() so the output lands in the system log.',
  },
  {
    id: 'no-hardcoded-sys-id',
    severity: SEVERITY.MEDIUM,
    // Deliberately checked against the RAW line: sys_ids legitimately live in
    // string literals, which is exactly the thing being flagged.
    useRawLine: true,
    pattern: /['"][0-9a-f]{32}['"]/,
    message: 'Hardcoded sys_id.',
    suggestion:
      'sys_ids differ between dev, test and prod, so this will silently break after deployment. ' +
      'Look the record up by a stable key, or read the value from a system property.',
  },
  {
    id: 'no-hardcoded-instance-url',
    severity: SEVERITY.MEDIUM,
    useRawLine: true,
    pattern: /https?:\/\/[a-z0-9-]+\.service-now\.com/i,
    message: 'Hardcoded instance URL.',
    suggestion: "Use gs.getProperty('glide.servlet.uri') so the script works in every environment.",
  },
  {
    id: 'no-embedded-credentials',
    severity: SEVERITY.HIGH,
    useRawLine: true,
    // Also catches client_secret, accessToken, "password": "..." and pw= (word boundary only on the left).
    pattern: /(?:\b|_)[A-Za-z0-9_]*(password|passwd|pwd|apikey|api_key|secret|token)[A-Za-z0-9_]*['"]?\s*[:=]\s*['"][^'"]{4,}['"]/i,
    message: 'Possible credential or secret hardcoded in the script.',
    suggestion:
      'Move it to a Connection & Credential Alias or an encrypted system property. Anything in a ' +
      'script record is readable by anyone who can read that record, and lands in update sets.',
  },
  {
    id: 'set-workflow-false',
    severity: SEVERITY.LOW,
    pattern: /\.\s*setWorkflow\s*\(\s*false\s*\)/,
    message: 'setWorkflow(false) suppresses business rules, flows and notifications for this write.',
    suggestion: 'Intentional for bulk data fixes, but confirm no required downstream automation is skipped.',
  },
  {
    id: 'no-gliderecord-in-loop-condition',
    severity: SEVERITY.MEDIUM,
    pattern: /\bwhile\s*\(\s*\w+\s*\.\s*next\s*\(\s*\)\s*\)\s*\{?\s*$/,
    // Informational anchor rule; the real detection is the structural pass.
    skip: true,
  },
];

const RECORD_DECL = /\b(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*new\s+(GlideRecord|GlideRecordSecure|GlideAggregate)\s*\(/d;
// Array / GlideQuery-stream methods whose callback runs once per element.
const ITERATING_CALL = /\.\s*(?:forEach|map|filter|some|every|reduce|reduceRight|find|findIndex|flatMap)\s*\(/g;

/** Matching close index for every open bracket, and the reverse. */
function bracketPairs(text, open, close) {
  const forward = new Map();
  const back = new Map();
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === open) stack.push(i);
    else if (text[i] === close && stack.length) {
      const o = stack.pop();
      forward.set(o, i);
      back.set(i, o);
    }
  }
  return { forward, back };
}

/** End (exclusive) of the single statement starting at `from`: a loop body written without braces. */
function statementEnd(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i; // the enclosing block ends first
      depth -= 1;
      if (depth === 0 && ch === '}') return i + 1; // a block statement such as if (x) { ... }
    } else if (ch === ';' && depth === 0) return i + 1;
  }
  return text.length;
}

/**
 * [start, end] ranges of every loop body in the masked source: for/while/do
 * with the brace on the same line or the next (Allman), brace-less single
 * statements, and callbacks passed to forEach/map/filter/... .
 */
export function loopBodies(text) {
  const parens = bracketPairs(text, '(', ')');
  const braces = bracketPairs(text, '{', '}');
  const bodies = [];

  const bodyAfter = (from) => {
    let i = from;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length || text[i] === ';') return null; // while (x);  or a do...while tail
    if (text[i] === '{') return [i, braces.forward.get(i) ?? text.length];
    return [i, statementEnd(text, i)];
  };
  // `} while (x)` closing a do { } block is not a loop of its own.
  const isDoWhileTail = (index) => {
    let j = index - 1;
    while (j >= 0 && /\s/.test(text[j])) j -= 1;
    const open = text[j] === '}' ? braces.back.get(j) : undefined;
    return open !== undefined && /\bdo\s*$/.test(text.slice(Math.max(0, open - 12), open));
  };

  for (const m of text.matchAll(/\b(while|for)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = parens.forward.get(open);
    if (close === undefined || (m[1] === 'while' && isDoWhileTail(m.index))) continue;
    const body = bodyAfter(close + 1);
    if (body) bodies.push(body);
  }
  for (const m of text.matchAll(/\bdo\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    bodies.push([open, braces.forward.get(open) ?? text.length]);
  }
  for (const m of text.matchAll(ITERATING_CALL)) {
    const open = m.index + m[0].length - 1;
    const close = parens.forward.get(open) ?? text.length;
    // Only an inline callback makes it a loop; ids.map(lookup) or .filter(Boolean) has no body here.
    if (/\bfunction\b|=>/.test(text.slice(open, close))) bodies.push([open, close]);
  }
  return bodies;
}

/** `name` at `index` as a binding key: a member (this.gr) or the scope that declares the variable. */
function bindingKeyAt(text, scopes, name, index) {
  let j = index - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j -= 1;
  return text[j] === '.' ? `.${name}` : `${scopes.bindingAt(name, index)}:${name}`;
}

// Every `name.method(` call in one pass. The lookbehind matches the per-variable patterns this
// replaced: a name preceded by "." still counts (this.gr.query() is a call on member `gr`).
const RECORD_CALL = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const CONSTRAINING_METHODS = new Set(['addQuery', 'addEncodedQuery', 'addActiveQuery', 'addNotNullQuery', 'addNullQuery', 'get', 'addJoinQuery', 'addDomainQuery']);
const AGGREGATING_METHODS = new Set(['addAggregate', 'groupBy']);
const QUERY_METHODS = new Set(['query', '_query']);
const NEW_RECORD = /\bnew\s+(?:GlideRecord|GlideRecordSecure|GlideAggregate)\s*\(/g;

/** Loop bodies merged into sorted, disjoint open intervals, with an "is this index inside one" test. */
function insideAnyBody(bodies) {
  const merged = [];
  [...bodies]
    .sort((a, b) => a[0] - b[0])
    .forEach(([start, end]) => {
      const last = merged[merged.length - 1];
      // Open intervals: (s1, e1) and (s2, e2) share points only when s2 < e1.
      if (last && start < last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    });
  return (index) => {
    let lo = 0;
    let hi = merged.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (merged[mid][0] < index) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 0 && index < merged[found][1];
  };
}

/**
 * Structural pass: queries created inside loop bodies (N+1), and per-variable
 * query analysis. Variables are tracked per function scope, so `gr` in one
 * function is not confused with `gr` in another.
 *
 * Linear in the script size: the calls are indexed once per line, and each call
 * updates only the variable it is made on (it used to test every variable
 * against every line, which took seconds on large Script Includes).
 */
function runStructuralChecks(lines, masked, findings) {
  const lineStarts = [];
  lines.reduce((offset, { code }) => {
    lineStarts.push(offset);
    return offset + code.length + 1;
  }, 0);
  const lineAt = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // N+1: a GlideRecord created anywhere inside a loop body.
  const inLoop = insideAnyBody(loopBodies(masked));
  const reported = new Set();
  for (const m of masked.matchAll(NEW_RECORD)) {
    if (!inLoop(m.index)) continue;
    const i = lineAt(m.index);
    if (reported.has(i)) continue;
    reported.add(i);
    findings.push({
      ruleId: 'no-query-in-loop',
      severity: SEVERITY.MEDIUM,
      line: lines[i].lineNumber,
      lineText: lines[i].raw.trim(),
      message: 'Database query created inside a loop.',
      suggestion:
        'This is an N+1 pattern: one extra query per iteration. Pre-load the related records into ' +
        'a map before the loop, or use GlideAggregate / an encoded IN query instead.',
    });
  }

  // First record declaration on each line (only those lines can create a variable).
  const decls = lines.map(({ code }) => RECORD_DECL.exec(code));
  const recordNames = new Set(decls.filter(Boolean).map((d) => d[1]));
  if (!recordNames.size) return;

  // bindingKey -> { name, line, constrained, limited, queried }
  const scopes = buildScopes(masked);
  const recordVars = new Map();

  lines.forEach(({ lineNumber, code, raw }, i) => {
    const at = lineStarts[i];
    const declMatch = decls[i];
    if (declMatch) {
      const name = declMatch[1];
      recordVars.set(bindingKeyAt(masked, scopes, name, at + declMatch.indices[1][0]), {
        name,
        line: lineNumber,
        type: declMatch[2],
        constrained: false,
        limited: false,
        queried: false,
        raw,
      });
    }
    if (!recordVars.size) return;

    // Only calls on a declared binding count: the same name in another function is another variable.
    for (const m of code.matchAll(RECORD_CALL)) {
      const [, name, method] = m;
      if (!recordNames.has(name)) continue;
      const info = recordVars.get(bindingKeyAt(masked, scopes, name, at + m.index));
      if (!info) continue;
      if (CONSTRAINING_METHODS.has(method)) info.constrained = true;
      if (method === 'setLimit') info.limited = true;
      // A COUNT/SUM/grouped GlideAggregate is the cheap way to read a whole table: it returns one row, not every row.
      if (info.type === 'GlideAggregate' && AGGREGATING_METHODS.has(method)) info.limited = true;
      if (QUERY_METHODS.has(method)) {
        info.queried = true;
        info.queryLine = lineNumber;
      }
    }
  });

  // Unbounded query detection, reported once per variable.
  recordVars.forEach((info) => {
    if (!info.queried) return;
    if (info.constrained || info.limited) return;
    findings.push({
      ruleId: 'no-unbounded-query',
      severity: SEVERITY.HIGH,
      line: info.queryLine || info.line,
      lineText: (info.raw || '').trim(),
      message: `"${info.name}" is queried with no addQuery/addEncodedQuery and no setLimit.`,
      suggestion:
        'This reads every row in the table. Add a query condition, or setLimit() if you genuinely ' +
        'only need a sample.',
    });
  });
}

/**
 * Lint a ServiceNow script.
 *
 * @param {string} script Raw script source.
 * @param {{table?: string, when?: string, fieldName?: string, side?: 'client'|'server'}} context
 *        `table` is the artifact table (sys_script, sys_script_client, ...) and
 *        `when` is the Business Rule timing (before/after/async/display).
 *        `side` overrides the side inferred from the table (UI actions run on either).
 * @returns {Array<{ruleId, severity, line, lineText, message, suggestion}>}
 */
export function lintScript(script, context = {}) {
  if (!script || !script.trim()) return [];

  const lines = buildLines(script);
  const masked = lines.map((l) => l.code).join('\n');
  const ctx = {
    table: context.table || '',
    when: (context.when || '').toLowerCase(),
    fieldName: context.fieldName || '',
  };
  ctx.side = scriptSide({ ...ctx, side: context.side }, masked);
  const findings = [];

  LINE_RULES.forEach((rule) => {
    if (rule.skip) return;
    if (rule.appliesTo && !rule.appliesTo(ctx)) return;

    lines.forEach(({ lineNumber, raw, code }) => {
      const target = rule.useRawLine ? raw : code;
      if (!target.trim()) return;
      // `match(raw, code)` is for rules that need both the masked and the raw line.
      if (rule.match ? !rule.match(raw, code) : !rule.pattern.test(target)) return;

      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        line: lineNumber,
        lineText: raw.trim(),
        message: rule.message,
        suggestion: rule.suggestion,
      });
    });
  });

  runStructuralChecks(lines, masked, findings);

  const order = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
}

/** Human-readable summary used both in the sidebar and in the AI prompt. */
export function formatLintFindings(findings) {
  if (!findings.length) return 'No issues found by the deterministic rules.';

  const counts = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});

  const header =
    `${findings.length} issue(s): ` +
    `${counts.high || 0} high, ${counts.medium || 0} medium, ${counts.low || 0} low.`;

  const body = findings
    .map((f) => {
      const lineText = f.lineText.length > 160 ? `${f.lineText.slice(0, 160)}...` : f.lineText;
      return `[${f.severity.toUpperCase()}] line ${f.line} - ${f.message}\n    ${lineText}\n    Fix: ${f.suggestion}`;
    })
    .join('\n\n');

  return `${header}\n\n${body}`;
}
