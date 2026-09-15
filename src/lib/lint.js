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

export const SEVERITY = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

const CLIENT_TABLES = ['sys_script_client', 'catalog_script_client', 'sys_ui_policy', 'sys_ui_script'];
const SERVER_TABLES = ['sys_script', 'sys_script_include', 'sysauto_script', 'sysevent_script_action'];

function isClientSide(table) {
  return CLIENT_TABLES.includes(table);
}

function isServerSide(table) {
  return SERVER_TABLES.includes(table);
}

/**
 * Strip line comments and string literals so pattern rules do not fire on
 * text inside quotes or commentary. Block comments are blanked out too. We
 * preserve line structure (and line length) so reported line numbers and
 * columns still line up with the original source.
 */
function maskNonCode(source) {
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

/** Build [{ lineNumber, raw, code }] where `code` has comments/strings masked. */
function buildLines(source) {
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
    appliesTo: (ctx) => isClientSide(ctx.table),
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
    pattern: /\bgetReference\s*\(\s*(['"])[^'"]*\1\s*\)/,
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
    pattern: /\b(document\s*\.\s*(getElementById|querySelector|getElementsBy)|jQuery\s*\(|\$\s*\(\s*['"]#|angular\s*\.\s*element\s*\()/,
    appliesTo: (ctx) => isClientSide(ctx.table),
    message: 'Direct DOM manipulation in a client script.',
    suggestion:
      'DOM access is unsupported in Service Portal, Mobile and Next Experience, and breaks on ' +
      'upgrade. Use the g_form API instead.',
  },
  {
    id: 'no-alert-in-client-script',
    severity: SEVERITY.LOW,
    pattern: /(^|[^.\w])alert\s*\(/,
    appliesTo: (ctx) => isClientSide(ctx.table),
    message: 'alert() blocks the browser and looks unpolished.',
    suggestion: 'Use g_form.addInfoMessage(), addErrorMessage() or showFieldMsg().',
  },
  {
    id: 'no-g-form-server-side',
    severity: SEVERITY.HIGH,
    pattern: /\bg_form\s*\./,
    appliesTo: (ctx) => isServerSide(ctx.table),
    message: 'g_form referenced in a server-side script.',
    suggestion: 'g_form only exists in the browser. This will throw at runtime.',
  },
  {
    id: 'no-gs-log-scoped',
    severity: SEVERITY.LOW,
    pattern: /\bgs\s*\.\s*log\s*\(/,
    appliesTo: (ctx) => isServerSide(ctx.table),
    message: 'gs.log() is deprecated in scoped applications.',
    suggestion: 'Use gs.info(), gs.warn() or gs.error() so the entry gets a proper level and source.',
  },
  {
    id: 'no-console-log-server',
    severity: SEVERITY.LOW,
    pattern: /\bconsole\s*\.\s*log\s*\(/,
    appliesTo: (ctx) => isServerSide(ctx.table),
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
    pattern: /\b(password|passwd|apikey|api_key|secret|token)\b\s*[:=]\s*['"][^'"]{4,}['"]/i,
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

/**
 * Structural pass: brace-depth tracking to catch patterns that need to know
 * whether a statement is inside a loop, and per-variable query analysis.
 */
function runStructuralChecks(lines, findings) {
  const loopStack = [];
  let depth = 0;

  // varName -> { line, constrained, limited, queried }
  const recordVars = new Map();

  lines.forEach(({ lineNumber, code, raw }) => {
    const declMatch = code.match(/\b(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*new\s+(GlideRecord|GlideRecordSecure|GlideAggregate)\s*\(/);
    if (declMatch) {
      recordVars.set(declMatch[1], {
        line: lineNumber,
        type: declMatch[2],
        constrained: false,
        limited: false,
        queried: false,
        raw,
      });
    }

    recordVars.forEach((info, name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\s*\\.\\s*(addQuery|addEncodedQuery|addActiveQuery|addNotNullQuery|addNullQuery|get|addJoinQuery|addDomainQuery)\\s*\\(`).test(code)) {
        info.constrained = true;
      }
      if (new RegExp(`\\b${escaped}\\s*\\.\\s*setLimit\\s*\\(`).test(code)) {
        info.limited = true;
      }
      if (new RegExp(`\\b${escaped}\\s*\\.\\s*(query|_query)\\s*\\(`).test(code)) {
        info.queried = true;
        info.queryLine = lineNumber;
      }
    });

    // Track whether we are inside a loop body.
    const isLoopHeader = /\b(while|for)\s*\(/.test(code);
    const opens = (code.match(/\{/g) || []).length;
    const closes = (code.match(/\}/g) || []).length;

    if (isLoopHeader && opens > 0) {
      loopStack.push(depth + 1);
    }

    if (loopStack.length > 0 && /\bnew\s+(GlideRecord|GlideRecordSecure|GlideAggregate)\s*\(/.test(code) && !isLoopHeader) {
      findings.push({
        ruleId: 'no-query-in-loop',
        severity: SEVERITY.MEDIUM,
        line: lineNumber,
        lineText: raw.trim(),
        message: 'Database query created inside a loop.',
        suggestion:
          'This is an N+1 pattern: one extra query per iteration. Pre-load the related records into ' +
          'a map before the loop, or use GlideAggregate / an encoded IN query instead.',
      });
    }

    depth += opens - closes;
    while (loopStack.length > 0 && depth < loopStack[loopStack.length - 1]) {
      loopStack.pop();
    }
  });

  // Unbounded query detection, reported once per variable.
  recordVars.forEach((info, name) => {
    if (!info.queried) return;
    if (info.constrained || info.limited) return;
    findings.push({
      ruleId: 'no-unbounded-query',
      severity: SEVERITY.HIGH,
      line: info.queryLine || info.line,
      lineText: (info.raw || '').trim(),
      message: `"${name}" is queried with no addQuery/addEncodedQuery and no setLimit.`,
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
 * @param {{table?: string, when?: string, fieldName?: string}} context
 *        `table` is the artifact table (sys_script, sys_script_client, ...) and
 *        `when` is the Business Rule timing (before/after/async/display).
 * @returns {Array<{ruleId, severity, line, lineText, message, suggestion}>}
 */
export function lintScript(script, context = {}) {
  if (!script || !script.trim()) return [];

  const ctx = {
    table: context.table || '',
    when: (context.when || '').toLowerCase(),
    fieldName: context.fieldName || '',
  };

  const lines = buildLines(script);
  const findings = [];

  LINE_RULES.forEach((rule) => {
    if (rule.skip) return;
    if (rule.appliesTo && !rule.appliesTo(ctx)) return;

    lines.forEach(({ lineNumber, raw, code }) => {
      const target = rule.useRawLine ? raw : code;
      if (!target.trim()) return;
      if (!rule.pattern.test(target)) return;

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

  runStructuralChecks(lines, findings);

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
