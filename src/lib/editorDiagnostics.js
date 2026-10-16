// Live diagnostics for the script editor: runs the verifier (syntax, lint, API catalog,
// client/server structure, dictionary field names) and turns each finding into an editor
// problem with a column range where one can be found, plus a quick fix for typos.
import { verifyScript, kindForTable, KIND_INFO } from './verify.js';
import { checkApiUsage } from './apiCheck.js';
import { checkSyntax } from './syntax.js';

const SEVERITY = { high: 'error', medium: 'warning', low: 'info' };

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Verifier kind for a form: the table's own kind, a client or server UI Action, or a generic
 * client/server kind picked from the code when the table is not a known script table.
 */
export function editorKind(formTable, { uiActionClient = null, side = null } = {}) {
  if (formTable === 'sys_ui_action') return uiActionClient ? 'ui_action_client' : 'background_script';
  const kind = kindForTable(formTable);
  if (kind) return kind;
  return side === 'client' ? 'ui_script' : 'background_script';
}

export const sideOfKind = (kind) => KIND_INFO[kind]?.side || null;

/** Column where the last capture group of `pattern` matched in the line, or -1. */
function findToken(lineText, pattern) {
  const m = pattern.exec(lineText);
  return m ? m.index + m[0].lastIndexOf(m[m.length - 1]) : -1;
}

/**
 * Column range (0-based, end exclusive) of what a finding is about on its line, and a quick fix
 * when the finding names a likely replacement.
 * @returns {{startCol: number|null, endCol: number|null, fix: {title: string, startCol: number, endCol: number, text: string} | null}}
 */
export function locateFinding(lineText, finding) {
  const none = { startCol: null, endCol: null, fix: null };
  const text = String(lineText || '');
  const msg = String(finding?.message || '');
  const suggestion = String(finding?.suggestion || '');
  const rule = finding?.ruleId || '';

  const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(\)/.exec(msg);
  if (member && /^api-|^gr-/.test(rule)) {
    const [, receiver, name] = member;
    let col = findToken(text, new RegExp(`(?<![\\w$])${escapeRe(receiver)}\\s*\\.\\s*(${escapeRe(name)})(?![\\w$])`));
    if (col === -1) col = findToken(text, new RegExp(`\\.\\s*(${escapeRe(name)})(?![\\w$])`));
    if (col === -1) return none;
    const range = { startCol: col, endCol: col + name.length, fix: null };
    const near = /the closest is ([A-Za-z_$][\w$]*)\(\)/.exec(msg) || /Did you mean ([A-Za-z_$][\w$]*)\(\)/.exec(suggestion);
    if (rule === 'api-unknown-method' && near && near[1] !== name) {
      range.fix = { title: `Change to ${near[1]}()`, startCol: col, endCol: col + name.length, text: near[1], original: name };
    }
    return range;
  }

  if (rule === 'unknown-field') {
    const field = /^Field "([^"]+)"/.exec(msg);
    if (!field) return none;
    const name = field[1];
    let col = findToken(text, new RegExp(`(['"])(${escapeRe(name)})\\1`));
    if (col === -1) col = findToken(text, new RegExp(`\\.\\s*(${escapeRe(name)})(?![\\w$])`));
    if (col === -1) return none;
    const near = /Did you mean "([^"]+)"/.exec(suggestion);
    return {
      startCol: col,
      endCol: col + name.length,
      fix: near && near[1] !== name ? { title: `Change to ${near[1]}`, startCol: col, endCol: col + name.length, text: near[1], original: name } : null,
    };
  }

  if (rule === 'api-wrong-side' || rule === 'api-deprecated' || rule === 'api-scope-mismatch' || rule === 'api-unsupported-ui') {
    const subject = /^([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/.exec(msg);
    if (!subject) return none;
    const inner = /\(([A-Za-z_$][\w$]*)\(\) and others\)/.exec(msg);
    const name = inner ? inner[1] : subject[2] || subject[1];
    const col = findToken(text, new RegExp(`(?<![\\w$])(${escapeRe(name)})(?![\\w$])`));
    return col === -1 ? none : { startCol: col, endCol: col + name.length, fix: null };
  }
  return none;
}

/**
 * Problems for the editor: [{line, startCol, endCol, severity: 'error'|'warning'|'info', message,
 * suggestion, ruleId, fix}], sorted by line.
 * @param {string} code
 * @param {{kind: string, when?: string, clientType?: string, scoped?: boolean, table?: string, fields?: string[]|null, quick?: boolean}} options
 *   quick = syntax and API catalog only (cheap enough to run while typing in a very large script)
 */
export function diagnose(code, { kind, when = '', clientType = '', scoped = false, table = '', fields = null, quick = false } = {}) {
  const src = String(code || '');
  if (!src.trim() || !KIND_INFO[kind]) return [];
  let findings;
  if (quick) {
    // Large scripts: the cheap checks only (syntax and the API catalog); the full check runs on request.
    findings = checkApiUsage(src, { side: KIND_INFO[kind].side, scoped: Boolean(scoped) });
    const syntax = checkSyntax(src);
    if (syntax) findings.unshift({ ruleId: 'syntax-error', severity: 'high', line: syntax.line || 1, message: `Syntax: ${syntax.message}`, suggestion: 'Fix this first; the rest of the checks assume the script parses.' });
  } else {
    findings = verifyScript({ code: src, kind, when, clientType, scoped: Boolean(scoped), table, fields: fields && fields.length ? fields : null }).findings;
  }
  const lines = src.split('\n');
  return findings
    .filter((f) => f.ruleId !== 'empty')
    .map((f) => {
      const line = Math.min(Math.max(1, f.line || 1), lines.length);
      const loc = locateFinding(lines[line - 1], f);
      return {
        line,
        startCol: loc.startCol,
        endCol: loc.endCol,
        severity: SEVERITY[f.severity] || 'info',
        message: f.message,
        suggestion: f.suggestion || '',
        ruleId: f.ruleId,
        fix: loc.fix,
      };
    })
    .sort((a, b) => a.line - b.line || (a.startCol ?? -1) - (b.startCol ?? -1));
}

/** Counts by severity: {error, warning, info}. */
export function countProblems(problems) {
  const out = { error: 0, warning: 0, info: 0 };
  (problems || []).forEach((p) => {
    out[p.severity] = (out[p.severity] || 0) + 1;
  });
  return out;
}

/**
 * The edit for a problem's quick fix: {from, to, insert} in document offsets, or null when the
 * text at the fix's place is no longer what the problem was about (the code changed since).
 */
export function quickFixEdit(text, problem) {
  if (!problem?.fix) return null;
  const lines = String(text || '').split('\n');
  if (problem.line < 1 || problem.line > lines.length) return null;
  const lineText = lines[problem.line - 1];
  const { startCol, endCol, original } = problem.fix;
  if (startCol < 0 || endCol > lineText.length || startCol >= endCol) return null;
  if (original !== undefined && lineText.slice(startCol, endCol) !== original) return null;
  let offset = 0;
  for (let i = 0; i < problem.line - 1; i += 1) offset += lines[i].length + 1;
  return { from: offset + startCol, to: offset + endCol, insert: problem.fix.text };
}
