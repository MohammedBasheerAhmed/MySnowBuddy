// Run a server script against a record, as a test. Pure: this file only builds the script text and reads its output.
//
// A business rule, UI action, Script Include method or fix script is wrapped so `current` and `previous` are a real
// record of your choice, optionally with some fields pretended changed (in memory only, never saved). The caller then
// puts the result through wrapAsDryRun() (writes are intercepted and listed) or, for a real run, wrapWithGuards()
// behind a confirmation (src/content/testKit.js). Everything the wrapper prints starts with "[NowBuddy test]" so the
// output can be read back reliably (parseRunOutput).

import { maskScript, analyzeScriptRisk } from './scriptSafety.js';

export const TEST_MARK = '[NowBuddy test]';

const TABLE_RE = /^[a-z][a-z0-9_]*$/;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const FIELD_RE = /^[a-z_][a-z0-9_]*$/;
const CLASS_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?$/;
const METHOD_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_ARGS = 12;
const MAX_SET = 50;

export const RUN_KINDS = {
  businessRule: { label: 'Business rule', needsRecord: true, tables: ['sys_script'], noun: 'rule' },
  uiAction: { label: 'UI action (server script)', needsRecord: true, tables: ['sys_ui_action'], noun: 'UI action' },
  scriptInclude: { label: 'Script Include method', needsRecord: false, tables: ['sys_script_include'], noun: 'Script Include' },
  fixScript: { label: 'Fix script or background script', needsRecord: false, tables: ['sys_script_fix', 'sysauto_script'], noun: 'script' },
};

/** The run kind for the table of the record on screen, or null when it is not a script we can run. */
export function runKindForTable(table) {
  return Object.keys(RUN_KINDS).find((kind) => RUN_KINDS[kind].tables.includes(table)) || null;
}

/** A JavaScript string literal that is safe inside a script (JSON, plus the two line separators JSON leaves alone). */
// Line and paragraph separators are legal in JSON but end a line in a script, so they are escaped by code point.
const LS_RE = new RegExp(String.fromCharCode(0x2028), 'g');
const PS_RE = new RegExp(String.fromCharCode(0x2029), 'g');
const escapeSeparators = (text) => text.replace(LS_RE, '\\u2028').replace(PS_RE, '\\u2029');
const lit = (value) => escapeSeparators(JSON.stringify(String(value)));

/** JSON array of arguments for a Script Include method: ["@current", "abc", 5]. "@current" / "@previous" are the bound records. */
export function parseCallArgs(text) {
  const source = String(text ?? '').trim();
  if (!source) return { ok: true, args: [] };
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, error: 'Arguments must be a JSON array, for example ["@current", "abc", 5]. "@current" passes the record.' };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'Arguments must be a JSON array, for example ["@current", "abc", 5].' };
  if (parsed.length > MAX_ARGS) return { ok: false, error: `At most ${MAX_ARGS} arguments.` };
  return { ok: true, args: parsed };
}

/** JSON object of fields to pretend changed: {"state": "6", "assigned_to": ""}. Values become strings. */
export function parseSetValues(text) {
  const source = String(text ?? '').trim();
  if (!source) return { ok: true, values: {} };
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, error: 'Pretend-changed fields must be a JSON object, for example {"state": "6"}.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'Pretend-changed fields must be a JSON object, for example {"state": "6"}.' };
  const entries = Object.entries(parsed);
  if (entries.length > MAX_SET) return { ok: false, error: `At most ${MAX_SET} fields.` };
  const bad = entries.find(([key]) => !FIELD_RE.test(key));
  if (bad) return { ok: false, error: `"${bad[0]}" is not a field name.` };
  const values = {};
  entries.forEach(([key, value]) => {
    values[key] = value === null || value === undefined ? '' : String(value);
  });
  return { ok: true, values };
}

function argCode(arg, hasRecord) {
  if (arg === '@current' || arg === '@previous') {
    if (!hasRecord) throw new Error('"@current" needs a record: choose one first.');
    return arg === '@current' ? 'current' : 'previous';
  }
  return escapeSeparators(JSON.stringify(arg === undefined ? null : arg));
}

/** Things worth telling the user before they run the script as a test. Each is { level: 'info' | 'warn', text }. */
export function analyzeForRun(kind, script) {
  const warnings = [];
  const masked = maskScript(script || '').masked;
  if (/\b(g_form|g_user|g_list|g_modal|g_navigation)\b|\bdocument\b|\bwindow\b|\bgetElementById\b/.test(masked)) {
    warnings.push({ level: 'warn', text: 'It uses client-side objects (g_form, document, window ...). They do not exist on the server, so this run will fail at that line. Use the Test bench for client scripts.' });
  }
  if (kind === 'businessRule') {
    if (/\bcurrent\s*\.\s*update\s*\(/.test(masked)) warnings.push({ level: 'info', text: 'It calls current.update(). In a before rule the platform saves the record for you; here the call is only logged as a suppressed write.' });
    if (/\bfunction\s+executeRule\b/.test(masked) && !callsExecuteRule(masked)) warnings.push({ level: 'info', text: 'It defines executeRule() without calling it. The test calls executeRule(current, previous) for you.' });
    warnings.push({ level: 'info', text: '"previous" is a second copy of the stored record, so current.changes() is only true for the fields you pretend changed or that the script sets.' });
  }
  const risk = analyzeScriptRisk(script || '');
  risk.writes
    .filter((w) => w.unintercepted)
    .forEach((w) => warnings.push({ level: 'warn', text: `Line ${w.line}: ${w.label}. A dry run does NOT block this.` }));
  return warnings;
}

function callsExecuteRule(masked) {
  return /\bexecuteRule\s*\([^)]*\)\s*\)?\s*\(/.test(masked) || /\)\s*\(\s*current\b/.test(masked) || /(^|[;\n])\s*executeRule\s*\(/.test(masked);
}

const REPORT_HELPER = `function __msbReport(cur, prev) {
  try {
    var fields = cur.getFields();
    var changed = 0;
    for (var i = 0; i < fields.size(); i++) {
      var name = String(fields.get(i).getName());
      var before = String(prev.getValue(name));
      var after = String(cur.getValue(name));
      if (before !== after) {
        changed++;
        gs.info('${TEST_MARK} changed ' + name + ': ' + before + ' -> ' + after);
      }
    }
    if (!changed) gs.info('${TEST_MARK} no field differs from the stored record');
    if (typeof cur.isActionAborted === 'function') gs.info('${TEST_MARK} action aborted: ' + cur.isActionAborted());
  } catch (e) {
    gs.info('${TEST_MARK} could not compare fields: ' + e);
  }
}`;

const ACTION_SHIM = `var action = {
  setRedirectURL: function (g) { gs.info('${TEST_MARK} action.setRedirectURL -> ' + (g && g.getTableName ? g.getTableName() + ' ' + g.getUniqueValue() : g)); },
  setReturnURL: function (g) { gs.info('${TEST_MARK} action.setReturnURL -> ' + (g && g.getTableName ? g.getTableName() + ' ' + g.getUniqueValue() : g)); },
  setNoOp: function () { gs.info('${TEST_MARK} action.setNoOp()'); },
  getGlideURI: function () { return { get: function () { return ''; } }; }
};`;

/**
 * The script body for one test run (not yet wrapped for dry run).
 * @param {object} o
 * @param {'businessRule'|'uiAction'|'scriptInclude'|'fixScript'} o.kind
 * @param {string} o.script        the script as it is on screen
 * @param {string} [o.table]       table of the record to bind
 * @param {string} [o.sysId]       record to bind (required for rules and UI actions)
 * @param {object} [o.set]         fields to pretend changed (in memory only)
 * @param {string} [o.className]   Script Include class (required for scriptInclude)
 * @param {string} [o.method]      method to call (required for scriptInclude)
 * @param {Array}  [o.args]        arguments; "@current" / "@previous" pass the bound records
 * @param {boolean} [o.includeSource] include the on-screen Script Include source before the call (default true)
 * @returns {{ script: string, warnings: Array<{level: string, text: string}>, label: string }}
 */
export function buildRecordScript({ kind, script = '', table = '', sysId = '', set = {}, className = '', method = '', args = [], includeSource = true } = {}) {
  const spec = RUN_KINDS[kind];
  if (!spec) throw new Error('Choose what to run: a business rule, UI action, Script Include method or fix script.');
  const wantsRecord = spec.needsRecord || Boolean(sysId);
  if (wantsRecord) {
    if (!TABLE_RE.test(table)) throw new Error('Name the table of the record to run it against.');
    if (!SYS_ID_RE.test(sysId)) throw new Error('Choose the record to run it against (its 32-character sys_id).');
  }
  if (kind === 'scriptInclude') {
    if (!CLASS_RE.test(className)) throw new Error('Name the Script Include class.');
    if (!METHOD_RE.test(method)) throw new Error('Name the method to call.');
  } else if (!String(script).trim()) {
    throw new Error('There is no script to run.');
  }
  if (!Array.isArray(args) || args.length > MAX_ARGS) throw new Error(`At most ${MAX_ARGS} arguments.`);

  const out = [`// ${TEST_MARK} ${spec.label}${wantsRecord ? ` against ${table} ${sysId}` : ''}`];
  if (wantsRecord) {
    out.push(
      `var current = new GlideRecord(${lit(table)});`,
      `if (!current.get(${lit(sysId)})) {`,
      `  gs.error('${TEST_MARK} No ' + ${lit(table)} + ' record with that sys_id, or you cannot read it.');`,
      `  throw new Error('record not found');`,
      '}',
      `var previous = new GlideRecord(${lit(table)});`,
      `previous.get(${lit(sysId)});`,
      `gs.info('${TEST_MARK} record: ' + ${lit(table)} + ' / ' + current.getDisplayValue());`
    );
    Object.entries(set || {}).forEach(([field, value]) => {
      if (!FIELD_RE.test(field)) throw new Error(`"${field}" is not a field name.`);
      out.push(`current.setValue(${lit(field)}, ${lit(value)});`, `gs.info('${TEST_MARK} pretend ' + ${lit(field)} + ' = ' + ${lit(value)});`);
    });
    out.push(REPORT_HELPER);
  }

  if (kind === 'businessRule') {
    out.push('var g_scratchpad = {};', script);
    const masked = maskScript(script).masked;
    if (/\bfunction\s+executeRule\b/.test(masked) && !callsExecuteRule(masked)) out.push('executeRule(current, previous);');
    out.push('__msbReport(current, previous);');
  } else if (kind === 'uiAction') {
    out.push(ACTION_SHIM, script, '__msbReport(current, previous);');
  } else if (kind === 'scriptInclude') {
    const call = `${includeSource && String(script).trim() ? className.split('.').pop() : className}`;
    if (includeSource && String(script).trim()) out.push(script);
    const argText = args.map((a) => argCode(a, wantsRecord)).join(', ');
    out.push(
      `var __msbResult = new ${call}().${method}(${argText});`,
      `var __msbText;`,
      `try {`,
      `  __msbText = (__msbResult !== null && typeof __msbResult === 'object' && typeof __msbResult.getTableName !== 'function') ? JSON.stringify(__msbResult) : String(__msbResult);`,
      `} catch (e) {`,
      `  __msbText = String(__msbResult);`,
      `}`,
      `gs.info('${TEST_MARK} result: ' + __msbText);`
    );
    if (wantsRecord) out.push('__msbReport(current, previous);');
  } else {
    out.push(script);
    if (wantsRecord) out.push('__msbReport(current, previous);');
  }

  return { script: out.join('\n'), warnings: analyzeForRun(kind, script), label: spec.label };
}

// --- Reading the output back ------------------------------------------------------------------------------

const WRITE_LINE = /^\[NowBuddy dry run\] (\d+)\. (.*)$/;

/**
 * Sort the lines a test run printed into what a person wants to see.
 * @returns {{ writes: string[], writeCount: number|null, changes: Array<{field, before, after}>, notes: string[], logs: string[],
 *   result: string|null, aborted: boolean|null, error: string|null, tampered: boolean, unavailable: boolean, raw: string }}
 */
export function parseRunOutput(text) {
  const raw = String(text ?? '');
  const parsed = { writes: [], writeCount: null, changes: [], notes: [], logs: [], result: null, aborted: null, error: null, tampered: false, unavailable: false, raw };
  raw.split('\n').forEach((line) => {
    const row = line.replace(/\s+$/, '');
    if (!row) return;
    let m;
    if ((m = WRITE_LINE.exec(row))) {
      parsed.writes.push(m[2]);
    } else if ((m = /^\[NowBuddy dry run\] Completed\. (\d+) write operation/.exec(row))) {
      parsed.writeCount = Number(m[1]);
    } else if (/^\[NowBuddy dry run\] \.\.\. \d+ more suppressed/.test(row)) {
      parsed.notes.push(row.replace('[NowBuddy dry run] ', ''));
    } else if ((m = /^\[NowBuddy dry run\] Script threw: (.*)$/.exec(row)) || (m = /^\[NowBuddy\] Script failed: (.*)$/.exec(row))) {
      parsed.error = m[1];
    } else if (/\[NowBuddy dry run\] TAMPERED/.test(row)) {
      parsed.tampered = true;
    } else if (/Dry run is NOT available/.test(row)) {
      parsed.unavailable = true;
      parsed.error = parsed.error || row.replace(/^\[NowBuddy\] /, '');
    } else if ((m = /^\[NowBuddy test\] changed ([a-z0-9_.]+): (.*?) -> (.*)$/.exec(row))) {
      parsed.changes.push({ field: m[1], before: m[2], after: m[3] });
    } else if ((m = /^\[NowBuddy test\] result: ([\s\S]*)$/.exec(row))) {
      parsed.result = m[1];
    } else if ((m = /^\[NowBuddy test\] action aborted: (true|false)/.exec(row))) {
      parsed.aborted = m[1] === 'true';
    } else if (row.startsWith(TEST_MARK)) {
      parsed.notes.push(row.slice(TEST_MARK.length).trim());
    } else if (/^\[NowBuddy\] Finished in/.test(row)) {
      parsed.notes.push(row.replace('[NowBuddy] ', ''));
    } else {
      parsed.logs.push(row);
    }
  });
  if (parsed.error === null) {
    const failed = parsed.logs.find((l) => /^(\*\*\* )?(Error|Exception)\b|Evaluator: /i.test(l));
    if (failed) parsed.error = failed;
  }
  return parsed;
}

/** A short plain sentence for the top of the result. */
export function summarizeRun(parsed, { dryRun = true } = {}) {
  if (parsed.unavailable) return 'Dry run is not available in this scope, so nothing was run.';
  if (parsed.tampered) return 'The script replaced a write method while it ran. Writes after that point may have been real: check the records it touches.';
  if (parsed.error) return `It stopped with an error: ${parsed.error}`;
  const parts = [];
  if (parsed.changes.length) parts.push(`${parsed.changes.length} field${parsed.changes.length === 1 ? '' : 's'} changed in memory`);
  const writes = parsed.writeCount ?? parsed.writes.length;
  if (dryRun) parts.push(writes ? `${writes} write${writes === 1 ? '' : 's'} suppressed` : 'no writes');
  if (parsed.aborted) parts.push('the action was aborted (setAbortAction)');
  if (parsed.result !== null) parts.push(`returned ${parsed.result.length > 60 ? `${parsed.result.slice(0, 59)}…` : parsed.result}`);
  return `Ran without errors: ${parts.join(', ') || 'nothing to report'}.`;
}
