// Verification pipeline for a script before it is shown to a user, saved, or run.
// Everything here is deterministic and free: syntax scan, the ServiceNow lint
// rules, the verified API catalog, client/server structural rules and (when the
// table's dictionary is supplied) field-name checks.
import { lintScript, maskNonCode } from './lint.js';
import { checkApiUsage } from './apiCheck.js';
import { checkSyntax } from './syntax.js';
import { getApi, closest, findMethod } from './apiCatalog/index.js';
import { buildScopes, lineLocator } from './scopes.js';
import { findRedactionPlaceholders, REDACTED } from '../providers/redact.js';

export const KIND_INFO = {
  client_script: { side: 'client', table: 'sys_script_client', label: 'Client Script' },
  catalog_client_script: { side: 'client', table: 'catalog_script_client', label: 'Catalog Client Script' },
  ui_policy_script: { side: 'client', table: 'sys_ui_policy', label: 'UI Policy script' },
  ui_script: { side: 'client', table: 'sys_ui_script', label: 'UI Script' },
  ui_action_client: { side: 'client', table: 'sys_ui_action', label: 'Client UI Action' },
  business_rule: { side: 'server', table: 'sys_script', label: 'Business Rule' },
  script_include: { side: 'server', table: 'sys_script_include', label: 'Script Include' },
  scheduled_job: { side: 'server', table: 'sysauto_script', label: 'Scheduled Job' },
  background_script: { side: 'server', table: 'sys_script', label: 'Background script' },
  acl_script: { side: 'server', table: 'sys_security_acl', label: 'ACL script' },
  scripted_rest: { side: 'server', table: 'sys_ws_operation', label: 'Scripted REST resource' },
  flow_script: { side: 'server', table: 'sys_hub_action_type_definition', label: 'Flow script step' },
};

/** Which verifier kind a form's table maps to, or null. */
export function kindForTable(table) {
  const entry = Object.entries(KIND_INFO).find(([key, v]) => v.table === table && key !== 'background_script');
  return entry ? entry[0] : null;
}

const CLIENT_TYPES = ['onLoad', 'onChange', 'onSubmit', 'onCellEdit'];
const SYSTEM_FIELDS = new Set(['sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by', 'sys_mod_count', 'sys_class_name', 'sys_domain', 'sys_tags']);

// ---- helpers -----------------------------------------------------------------------

function makeAdder(rawLines, findings) {
  const seen = new Set();
  return (line, ruleId, severity, message, suggestion) => {
    const key = `${line}|${ruleId}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ ruleId, severity, line, lineText: (rawLines[line - 1] || '').trim(), message, suggestion });
  };
}

// 1-based line of an index. The line index of the last text is kept, so repeated lookups are a
// binary search rather than a slice-and-split of the whole script each time.
let lastLines = { text: null, at: null };
const lineOf = (text, index) => {
  if (lastLines.text !== text) lastLines = { text, at: lineLocator(text) };
  return lastLines.at(index);
};

const RECORD_ASSIGNMENT = /(?<![.\w$])(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*new\s+(GlideRecord|GlideRecordSecure|GlideAggregate)\s*\(/g;
// Same lookbehind as the per-variable patterns it replaced: this.gr.query() is not a call on a local `gr`.
const MEMBER_CALL = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const QUERY_MODIFIERS = new Set(['addQuery', 'addEncodedQuery', 'addActiveQuery', 'orderBy', 'orderByDesc', 'setLimit']);
// Whole identifiers only: `$ga` is matched as `$ga` (it used to go into a RegExp unescaped, where
// "$" is an anchor, so `$ga.addParam('sysparm_name', ...)` was never seen), and `my$ga` is not `ga`.
const AJAX_SYSPARM_NAME = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\.\s*addParam\s*\(\s*['"]sysparm_name['"]/g;
const AJAX_SYNC_CALL = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\.\s*(getXML|getXMLAnswer)\s*\(\s*\)/g;

// ---- client structure ----------------------------------------------------------------

function checkClientStructure(code, masked, { kind, clientType }, add) {
  const isHandlerScript = kind === 'client_script' || kind === 'catalog_client_script';

  if (isHandlerScript) {
    const declared = CLIENT_TYPES.find((t) => new RegExp(`\\bfunction\\s+${t}\\s*\\(`).test(masked));
    const wanted = clientType || declared;
    if (!wanted) {
      add(1, 'client-missing-handler', 'high', 'No onLoad / onChange / onSubmit / onCellEdit function was found.', 'A client script must declare its handler, e.g. function onChange(control, oldValue, newValue, isLoading, isTemplate) { ... }.');
    } else if (!new RegExp(`\\bfunction\\s+${wanted}\\s*\\(`).test(masked)) {
      add(1, 'client-missing-handler', 'high', `This is a ${wanted} script but there is no function ${wanted}(...) declaration.`, `Declare function ${wanted}(...) at the top level; the platform calls it by that name.`);
    }

    if (wanted === 'onChange') {
      // Look at the body only: the signature always mentions isLoading.
      const body = masked.replace(/\bfunction\s+onChange\s*\([^)]*\)/, '');
      if (!/\bisLoading\b/.test(body) && !/\bnewValue\s*(===?|!==?)\s*(''|"")/.test(code)) {
        add(1, 'client-onchange-guard', 'medium', 'onChange runs once when the form loads, but nothing here checks isLoading or an empty newValue.', "Start with: if (isLoading || newValue === '') { return; }");
      }
      const m = masked.match(/\bfunction\s+onChange\s*\(([^)]*)\)/);
      if (m && m[1].split(',').filter((p) => p.trim()).length < 4) {
        add(lineOf(masked, m.index), 'client-onchange-signature', 'medium', 'onChange should declare (control, oldValue, newValue, isLoading, isTemplate).', 'The platform passes five arguments; declare the ones you use in that order.');
      }
    }
    if (wanted === 'onSubmit' && !/\breturn\b/.test(masked)) {
      add(1, 'client-onsubmit-return', 'low', 'onSubmit never returns a value.', 'Return false to stop the submit (after showing why), or true to allow it.');
    }
    if (wanted === 'onCellEdit' && !/\bcallback\s*\(/.test(masked)) {
      add(1, 'client-oncelledit-callback', 'high', 'onCellEdit never calls callback(true|false).', 'The list stays frozen until callback(true) or callback(false) is called, including inside any async branch.');
    }
  }

  // GlideAjax calls: the Script Include method is chosen by sysparm_name.
  const ajaxVars = [...masked.matchAll(/(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*new\s+GlideAjax\s*\(/g)];
  // Indexed once (first occurrence per name) rather than one whole-script regex per variable.
  const namedCalls = new Set();
  const syncCalls = new Map();
  if (ajaxVars.length) {
    for (const c of code.matchAll(AJAX_SYSPARM_NAME)) namedCalls.add(c[1]);
    for (const c of masked.matchAll(AJAX_SYNC_CALL)) if (!syncCalls.has(c[1])) syncCalls.set(c[1], c);
  }
  for (const m of ajaxVars) {
    const name = m[1];
    if (!namedCalls.has(name)) {
      add(lineOf(masked, m.index), 'ajax-missing-sysparm-name', 'high', `GlideAjax "${name}" never sets sysparm_name, so no Script Include method is called.`, `${name}.addParam('sysparm_name', 'methodName');`);
    }
    const sync = syncCalls.get(name);
    if (sync) {
      add(lineOf(masked, sync.index), 'ajax-no-callback', 'high', `${name}.${sync[2]}() is called without a callback.`, 'Pass a function that receives the response; the call is asynchronous.');
    }
  }
}

// ---- server structure -------------------------------------------------------------------

const ES6_PATTERNS = [
  { re: /=>/, what: 'arrow function' },
  { re: /\b(?:let|const)\s+[\w${[]/, what: 'let/const' },
  { re: /\bclass\s+[A-Za-z_$]/, what: 'class declaration' },
  { re: /\b(?:async|await)\b/, what: 'async/await' },
  { re: /\.\.\.[\w$[({]/, what: 'spread/rest' },
  { re: /\bfor\s*\(\s*(?:var|let|const)\s+[\w$]+\s+of\b/, what: 'for...of' },
  { re: /\b(?:var|let|const)\s*[{[][^=]*\}?\s*=/, what: 'destructuring' },
  { re: /\.(?:includes|startsWith|endsWith|padStart|padEnd)\s*\(/, what: 'ES2015+ string/array method' },
  { re: /\bObject\s*\.\s*(?:entries|values|assign)\s*\(/, what: 'Object.entries/values/assign' },
  { re: /\bArray\s*\.\s*from\s*\(|\bPromise\b|\bnew\s+(?:Map|Set)\s*\(/, what: 'ES2015 built-in' },
];

function checkEcmaLevel(code, masked, side, esLevel, add) {
  if (esLevel === 'es12') return;
  const rawLines = code.split('\n');
  const maskedLines = masked.split('\n');
  const severity = side === 'server' ? 'medium' : 'low';
  const where =
    side === 'server'
      ? 'ServiceNow scripts run in ES5 mode by default; ES2021 syntax needs the application set to ECMAScript 2021 (ES12).'
      : 'Older browsers and Service Portal / mobile clients may not support ES2015+ syntax.';
  maskedLines.forEach((line, i) => {
    for (const { re, what } of ES6_PATTERNS) {
      if (re.test(line)) {
        add(i + 1, 'es6-syntax', severity, `${what} is ES2015+.`, `${where} Use ES5 equivalents (var, function, indexOf, string concatenation).`);
        return;
      }
    }
    // Template literals: backticks are blanked in the masked text, so look at the raw line.
    if (rawLines[i].includes('`') && !/^\s*(\/\/|\*)/.test(rawLines[i])) {
      add(i + 1, 'es6-syntax', severity, 'Template literal is ES2015+.', `${where} Use string concatenation.`);
    }
  });
}

function checkServerStructure(code, masked, { kind, when, scoped, esLevel }, add) {
  checkEcmaLevel(code, masked, 'server', esLevel, add);

  masked.split('\n').forEach((line, i) => {
    if (/\b(?:window|document|navigator|localStorage|XMLHttpRequest)\b\s*[.[]|\b(?:setTimeout|setInterval|alert)\s*\(/.test(line)) {
      add(i + 1, 'server-browser-global', 'high', 'Browser-only API used in a server-side script.', 'The server (Rhino) has no window, document or timers. Use GlideDateTime, gs.sleep() (background scripts only) or events/scheduled jobs.');
    }
    if (scoped && /\bPackages\s*\./.test(line)) {
      add(i + 1, 'scoped-packages', 'high', 'Packages.* (Java access) is not allowed in scoped applications.', 'Use the documented Glide APIs instead.');
    }
  });

  // GlideRecord ordering mistakes, per binding: the same name in two functions is two variables.
  const scopes = buildScopes(masked);
  const lineAt = (index) => lineOf(masked, index);
  const vars = new Map();
  for (const m of masked.matchAll(RECORD_ASSIGNMENT)) {
    const scope = scopes.bindingAt(m[1], m.index + m[0].indexOf(m[1]));
    vars.set(`${scope}:${m[1]}`, { name: m[1], scope, declLine: lineAt(m.index) });
  }
  // Every `name.method(` call, indexed once by name (in document order) instead of one scan per variable.
  const callsByName = new Map();
  if (vars.size) {
    const names = new Set([...vars.values()].map((v) => v.name));
    for (const m of masked.matchAll(MEMBER_CALL)) {
      if (!names.has(m[1])) continue;
      if (!callsByName.has(m[1])) callsByName.set(m[1], []);
      callsByName.get(m[1]).push({ index: m.index, method: m[2] });
    }
  }
  for (const { name, scope } of vars.values()) {
    // Uses of this binding only (a same-named variable elsewhere resolves to another scope).
    const calls = (callsByName.get(name) || []).filter((c) => scopes.bindingAt(name, c.index) === scope);
    const query = calls.find((c) => c.method === 'query' || c.method === '_query');
    const gets = calls.some((c) => c.method === 'get');
    const iterates = calls.find((c) => c.method === 'next' || c.method === '_next' || c.method === 'hasNext');
    if (iterates && !query && !gets) {
      add(lineAt(iterates.index), 'gr-next-without-query', 'medium', `${name}.next() is called but ${name}.query() never is.`, `Call ${name}.query() after the addQuery calls, before iterating (or use ${name}.get(...)).`);
    }
    if (query) {
      const late = calls.find((c) => c.index > query.index && QUERY_MODIFIERS.has(c.method));
      if (late) {
        add(lineAt(late.index), 'gr-modifier-after-query', 'medium', `${name}.${late.method}() comes after ${name}.query(), so it has no effect on the result.`, `Move it above ${name}.query().`);
      }
    }
  }

  if (kind === 'business_rule' && when === 'async' && /\bprevious\s*\./.test(masked)) {
    add(lineOf(masked, masked.search(/\bprevious\s*\./)), 'br-previous-in-async', 'medium', '`previous` is not reliably available in async Business Rules.', 'Capture the old value in a before rule (for example via an event parameter) if the async logic needs it.');
  }
  if (kind === 'scheduled_job' && /\bcurrent\s*\./.test(masked)) {
    add(lineOf(masked, masked.search(/\bcurrent\s*\./)), 'job-current', 'high', '`current` does not exist in a scheduled job.', 'Query the records you need with GlideRecord.');
  }
  if (kind === 'acl_script' && !/\banswer\s*=/.test(masked)) {
    add(1, 'acl-no-answer', 'high', 'The ACL script never assigns `answer`.', 'Set answer = true or false; an unset answer denies access.');
  }
  if (kind === 'script_include') {
    const usesParam = /\bthis\s*\.\s*getParameter\s*\(/.test(masked);
    const extendsAjax = /AbstractAjaxProcessor/.test(masked);
    if (usesParam && !extendsAjax) {
      add(lineOf(masked, masked.search(/\bgetParameter\s*\(/)), 'si-ajax-not-extended', 'high', 'this.getParameter() only exists on classes that extend AbstractAjaxProcessor.', 'Use Object.extendsObject(AbstractAjaxProcessor, {...}) and tick "Client callable".');
    }
    if (/Class\s*\.\s*create\s*\(/.test(masked) && !/\btype\s*:\s*['"]/.test(code)) {
      add(1, 'si-missing-type', 'low', 'The class has no `type: "Name"` property.', "Add type: 'ClassName' to the prototype; ServiceNow uses it for introspection and logging.");
    }
  }
}

// ---- field names -------------------------------------------------------------------------

const G_FORM_FIELD_METHODS =
  'getValue|setValue|clearValue|getBooleanValue|getIntValue|getDecimalValue|setMandatory|setReadOnly|setReadonly|setDisabled|setDisplay|setVisible|isMandatory|showFieldMsg|hideFieldMsg|flash|getLabelOf|setLabelOf|addOption|removeOption|clearOptions|getReference|setFieldPlaceholder|getDisplayBox';

function checkFieldNames(code, masked, { side, kind, table, fields }, add) {
  if (!fields?.length) return;
  const known = new Set([...fields, ...SYSTEM_FIELDS]);
  const names = [...known];
  const unknown = (line, name, via) => {
    if (known.has(name) || name.includes('.')) return;
    const near = closest(name, names);
    add(line, 'unknown-field', 'high', `Field "${name}" does not exist on ${table} (${via}).`, near ? `Did you mean "${near}"? Check get_schema("${table}").` : `Check get_schema("${table}") for the real field names.`);
  };

  const rawLines = code.split('\n');
  const maskedLines = masked.split('\n');

  if (side === 'client' && kind !== 'catalog_client_script') {
    const re = new RegExp(`\\bg_form\\s*\\.\\s*(${G_FORM_FIELD_METHODS})\\s*\\(\\s*(['"])([A-Za-z0-9_.]+)\\2`, 'g');
    rawLines.forEach((raw, i) => {
      for (const m of raw.matchAll(re)) {
        // Ignore matches that sit inside a comment (the masked text blanks them out).
        if (!maskedLines[i].slice(m.index, m.index + 6).startsWith('g_form')) continue;
        unknown(i + 1, m[3], `g_form.${m[1]}`);
      }
    });
  }

  if (side === 'server' && (kind === 'business_rule' || kind === 'acl_script')) {
    const glide = getApi('GlideRecord', 'server');
    maskedLines.forEach((line, i) => {
      for (const m of line.matchAll(/\b(?:current|previous)\s*\.\s*([A-Za-z_][\w]*)\s*(\()?/g)) {
        if (m[2]) continue;
        // `current.variables.x` is the catalog-variable object, not a dictionary column.
        if (m[1] === 'variables') continue;
        if (glide && findMethod(glide, m[1], 'server')) continue;
        unknown(i + 1, m[1], 'current.' + m[1]);
      }
    });
    rawLines.forEach((raw, i) => {
      for (const m of raw.matchAll(/\b(?:current|previous)\s*\.\s*(?:getValue|setValue|getDisplayValue)\s*\(\s*(['"])([A-Za-z0-9_]+)\1/g)) {
        unknown(i + 1, m[2], 'current.getValue/setValue');
      }
    });
  }
}

// ---- orchestrator ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {string} input.code
 * @param {string} input.kind        a key of KIND_INFO
 * @param {string} [input.when]      business rule timing
 * @param {string} [input.clientType] onLoad | onChange | onSubmit | onCellEdit
 * @param {boolean} [input.scoped]
 * @param {string} [input.table]     table the script runs against (for field checks)
 * @param {string[]} [input.fields]  dictionary field names of that table
 * @param {string[]} [input.ui]      client UIs that must be supported, e.g. ['portal']
 * @param {'es5'|'es12'} [input.esLevel]
 * @param {(code: string) => ({line:number,message:string}|null)} [input.syntaxCheck] exact parser when available
 */
export function verifyScript(input) {
  const { code = '', kind, when = '', clientType = '', scoped = false, table = '', fields = null, ui = [], esLevel = 'es5', syntaxCheck } = input || {};
  const info = KIND_INFO[kind];
  if (!info) {
    return finish([{ ruleId: 'unknown-kind', severity: 'high', line: 1, lineText: '', message: `Unknown script kind "${kind}".`, suggestion: `Use one of: ${Object.keys(KIND_INFO).join(', ')}.` }], kind, input);
  }
  if (!code.trim()) {
    return finish([{ ruleId: 'empty', severity: 'high', line: 1, lineText: '', message: 'The script is empty.', suggestion: 'Write the script first.' }], kind, input);
  }

  const rawLines = code.split('\n');
  const masked = maskNonCode(code);
  const findings = [];
  const add = makeAdder(rawLines, findings);

  const syntax = (syntaxCheck || checkSyntax)(code);
  if (syntax) add(syntax.line || 1, 'syntax-error', 'high', `Syntax: ${syntax.message}`, 'Fix this first; the rest of the checks assume the script parses.');

  // Secrets are redacted before the model sees a script; writing that text back would replace the real value.
  const placeholders = findRedactionPlaceholders(code);
  placeholders.secret.forEach((line) =>
    add(line, 'redacted-secret', 'high', `"${REDACTED}" stands where a secret was: the extension hid the real value before the AI saw this script.`, 'Saving this would overwrite the real secret with the placeholder. Put the real value back by hand, or better, read it from a credential alias or an encrypted system property.')
  );
  placeholders.other.forEach((line) =>
    add(line, 'redacted-placeholder', 'low', `"${REDACTED}" appears in the script.`, 'If this came from an AI edit, it may stand for a value the extension hid; check it before saving.')
  );

  lintScript(code, { table: info.table, when, side: info.side }).forEach((f) => {
    if (f.ruleId === 'no-g-form-server-side') return; // reported by the API check with better advice
    add(f.line, f.ruleId, f.severity, f.message, f.suggestion);
  });

  checkApiUsage(code, { side: info.side, scoped, ui }).forEach((f) => add(f.line, f.ruleId, f.severity, f.message, f.suggestion));

  if (info.side === 'client') {
    checkClientStructure(code, masked, { kind, clientType }, add);
    checkEcmaLevel(code, masked, 'client', esLevel, add);
  } else {
    checkServerStructure(code, masked, { kind, when: String(when).toLowerCase(), scoped, esLevel }, add);
  }
  checkFieldNames(code, masked, { side: info.side, kind, table, fields }, add);

  return finish(findings, kind, input);
}

function finish(findings, kind, input) {
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
  const errors = sorted.filter((f) => f.severity === 'high').length;
  const warnings = sorted.filter((f) => f.severity === 'medium').length;
  const notes = sorted.length - errors - warnings;
  return {
    ok: errors === 0,
    kind,
    side: KIND_INFO[kind]?.side || null,
    errors,
    warnings,
    notes,
    findings: sorted,
    summary: summarize(errors, warnings, notes, input?.code),
  };
}

function summarize(errors, warnings, notes, code) {
  if (!code || !String(code).trim()) return 'Nothing to verify.';
  if (!errors && !warnings && !notes) return 'Passed: no problems found by the syntax, API catalog, lint and structure checks.';
  return `${errors ? 'FAILED' : 'Passed with notes'}: ${errors} error(s), ${warnings} warning(s), ${notes} note(s).`;
}

export function formatVerification(result, { maxFindings = 30 } = {}) {
  const lines = [result.summary];
  result.findings.slice(0, maxFindings).forEach((f) => {
    lines.push(`[${f.severity.toUpperCase()}] line ${f.line} (${f.ruleId}): ${f.message}`);
    if (f.lineText) lines.push(`    ${f.lineText.length > 140 ? `${f.lineText.slice(0, 140)}...` : f.lineText}`);
    if (f.suggestion) lines.push(`    Fix: ${f.suggestion}`);
  });
  if (result.findings.length > maxFindings) lines.push(`... and ${result.findings.length - maxFindings} more.`);
  return lines.join('\n');
}
