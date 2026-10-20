// Safety tooling for the background script runner.
//
// Running an AI-generated script against a production instance is the single
// most dangerous thing this extension can do. Two mitigations live here:
//   1. analyzeScriptRisk() - static detection of write/destructive operations,
//      shown to the user BEFORE they press Run.
//   2. wrapAsDryRun() - executes the script with GlideRecord write methods
//      intercepted, so it reports what it WOULD have changed instead of
//      changing it.

const WRITE_PATTERNS = [
  { pattern: /\.\s*deleteMultiple\s*\(/, severity: 'high', label: 'bulk delete (deleteMultiple)' },
  { pattern: /\.\s*deleteRecord\s*\(/, severity: 'high', label: 'record delete (deleteRecord)' },
  { pattern: /\.\s*updateMultiple\s*\(/, severity: 'high', label: 'bulk update (updateMultiple)' },
  { pattern: /\.\s*insert(WithReferences)?\s*\(/, severity: 'medium', label: 'record insert' },
  { pattern: /\.\s*update(WithReferences)?\s*\(/, severity: 'medium', label: 'record update' },
  { pattern: /\.\s*setWorkflow\s*\(\s*false\s*\)/, severity: 'medium', label: 'business rules suppressed (setWorkflow(false))' },
  { pattern: /\beventQueue(Scheduled)?\b/, severity: 'medium', label: 'event queued', unintercepted: true },
  { pattern: /\bnew\s+GlideRecord\s*\([^)]*\)\s*[\s\S]{0,80}?\.\s*initialize\s*\(/, severity: 'medium', label: 'new record initialised' },
  { pattern: /\b(RESTMessageV2|SOAPMessageV2|RESTMessage|SOAPMessage|GlideHTTPRequest|HttpClient)\b/, severity: 'medium', label: 'outbound REST/SOAP/HTTP call', unintercepted: true },
  { pattern: /\bsetProperty\b/, severity: 'high', label: 'system property write', unintercepted: true },
  { pattern: /\bGlideMultipleUpdate\b/, severity: 'high', label: 'GlideMultipleUpdate bulk write', unintercepted: true },
  { pattern: /\bGlideDBUtil\b|\bexecuteSQL\b|\bGlideTableManager\b/, severity: 'high', label: 'direct database utility call', unintercepted: true },
  { pattern: /\bimpersonate\b|\bGlideImpersonate\b/, severity: 'high', label: 'session impersonation', unintercepted: true },
  { pattern: /\bGlideEmailOutbound\b|\bsn_notify\b/, severity: 'medium', label: 'outbound email or notification', unintercepted: true },
  { pattern: /\bGlideSysAttachment\b|\bAttachment\s*\(/, severity: 'medium', label: 'attachment API (can write or delete files)', unintercepted: true },
  { pattern: /\bsn_fd\b|\bFlowAPI\b|\bWorkflow\s*\(|\bstartFlow\b|\bstartSubflow\b|\bexecuteAction\b/, severity: 'medium', label: 'flow, subflow or workflow start', unintercepted: true },
  { pattern: /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bGlide(Scoped)?Evaluator\b|\bevaluateScript\b/, severity: 'high', label: 'dynamic code (eval)', unintercepted: true },
  { pattern: /\bgs\s*\[|\bsn_ws\s*\[|\bGlideRecord(Secure)?\s*\[/, severity: 'high', label: 'computed member access on a platform API (hides what is called)', unintercepted: true },
  { pattern: /\.\s*prototype\b|\b__proto__\b|\bdefineProperty\b/, severity: 'high', label: 'changes platform object prototypes', unintercepted: true },
];

/**
 * The script with comments blanked and string contents replaced by spaces (quotes kept), line structure intact.
 * Regular-expression literals are not understood; `flags.slash` tells the caller one may be present.
 */
export function maskScript(script) {
  const src = String(script || '');
  const out = [];
  const flags = { template: false, slash: false };
  let quote = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      if (ch === '\\' && next !== undefined) {
        out.push(' ', next === '\n' ? '\n' : ' ');
        i += 1;
      } else if (ch === quote) {
        out.push(ch);
        quote = '';
      } else out.push(ch === '\n' ? '\n' : ' ');
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      i -= 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i += 1) out.push(src[i] === '\n' ? '\n' : ' ');
      i -= 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      if (ch === '`') flags.template = true;
      quote = ch;
      out.push(ch);
      continue;
    }
    if (ch === '/') flags.slash = true;
    out.push(ch);
  }
  return { masked: out.join(''), flags };
}

/**
 * Detect operations that mutate instance state.
 * `hasUninterceptedWrites` is true when the script does something a dry run cannot suppress
 * (outbound calls, events, property writes, bulk/SQL writes), so it is not safe to run unattended.
 * @returns {{writes: Array<{severity:string,label:string,line:number,lineText:string,unintercepted:boolean}>, hasWrites:boolean, hasUninterceptedWrites:boolean, highestSeverity:string|null}}
 */
export function analyzeScriptRisk(script) {
  const writes = [];
  if (!script || !script.trim()) {
    return { writes, hasWrites: false, hasUninterceptedWrites: false, highestSeverity: null };
  }

  // Comments are blanked properly (not by guessing from a leading "*"), and string contents are blanked so a
  // word inside a message is not a finding. Calls hidden in strings show up as computed access instead.
  const original = script.split('\n');
  const lines = maskScript(script).masked.split('\n');
  lines.forEach((codeText, index) => {
    const trimmed = (original[index] || '').trim();

    WRITE_PATTERNS.forEach(({ pattern, severity, label, unintercepted }) => {
      if (!pattern.test(codeText)) return;
      writes.push({
        severity,
        label,
        unintercepted: Boolean(unintercepted),
        line: index + 1,
        lineText: trimmed.length > 180 ? `${trimmed.slice(0, 180)}...` : trimmed,
      });
    });
  });

  const highestSeverity = writes.some((w) => w.severity === 'high')
    ? 'high'
    : writes.length
      ? 'medium'
      : null;

  return { writes, hasWrites: writes.length > 0, hasUninterceptedWrites: writes.some((w) => w.unintercepted), highestSeverity };
}

export function formatRiskSummary(risk) {
  if (!risk.hasWrites) {
    return 'No write operations detected. This looks read-only, but review it anyway.';
  }
  const lines = risk.writes
    .map((w) => `  [${w.severity.toUpperCase()}] line ${w.line}: ${w.label}\n      ${w.lineText}`)
    .join('\n');
  return `${risk.writes.length} write operation(s) detected:\n${lines}`;
}

// ---- Strict read-only check (what "Auto dry runs" may run without asking) ---------------------------------
//
// A dry run intercepts GlideRecord writes, but nothing else, and a script can always find a way around an
// interception. So a dry run only skips the approval card when the script provably uses nothing but known
// read-only calls. Anything unrecognised fails closed to "ask". This is an allow-list, not a deny-list.

const READ_METHODS = new Set(
  [
    // GlideRecord / GlideAggregate / GlideElement reads
    'addQuery', 'addEncodedQuery', 'addNullQuery', 'addNotNullQuery', 'addActiveQuery', 'addInactiveQuery', 'addOrCondition',
    'addJoinQuery', 'query', 'next', 'hasNext', 'get', 'getValue', 'getDisplayValue', 'getUniqueValue', 'getRowCount',
    'getTableName', 'getRecordClassName', 'getClassDisplayValue', 'getElement', 'getLabel', 'getED', 'getEncodedQuery',
    'getLink', 'getAttribute', 'getReferenceTable', 'getRefRecord', 'getChoiceValue', 'getName', 'getBooleanValue',
    'isValid', 'isValidRecord', 'isValidField', 'isNewRecord', 'canRead', 'canWrite', 'canCreate', 'canDelete', 'orderBy',
    'orderByDesc', 'setLimit', 'chooseWindow', 'nil', 'changes', 'changesFrom', 'changesTo', 'addAggregate', 'getAggregate',
    'groupBy', 'addHaving', 'orderByAggregate', 'getAggregateEncodedQuery',
    // gs reads and logging
    'info', 'warn', 'error', 'debug', 'log', 'print', 'getProperty', 'getUserID', 'getUserName', 'getUserDisplayName',
    'hasRole', 'nowDateTime', 'now', 'nowNoTZ', 'daysAgo', 'daysAgoStart', 'daysAgoEnd', 'minutesAgo', 'hoursAgo',
    'monthsAgo', 'yearsAgo', 'beginningOfToday', 'endOfToday', 'beginningOfYesterday', 'endOfYesterday', 'getMessage',
    'tableExists', 'getCurrentScopeName', 'generateGUID', 'dateDiff',
    // GlideDateTime / GlideDuration (in memory)
    'getNumericValue', 'getDate', 'getTime', 'getDayOfWeek', 'getDayOfMonth', 'getMonth', 'getYear', 'addDays', 'addSeconds',
    'addMonths', 'addYears', 'addWeeks', 'before', 'after', 'compareTo', 'getDurationValue', 'getDisplayValueInternal',
    // JavaScript built-ins on local values
    'push', 'pop', 'shift', 'unshift', 'join', 'indexOf', 'lastIndexOf', 'slice', 'splice', 'concat', 'sort', 'reverse',
    'map', 'forEach', 'filter', 'some', 'every', 'reduce', 'split', 'substring', 'substr', 'charAt', 'charCodeAt',
    'toLowerCase', 'toUpperCase', 'trim', 'replace', 'match', 'search', 'toString', 'toFixed', 'valueOf', 'hasOwnProperty',
    'keys', 'stringify', 'parse', 'getFullYear', 'getHours', 'getMinutes', 'floor', 'ceil', 'round', 'max', 'min', 'abs',
  ]
);
const GS_READ = new Set(['info', 'warn', 'error', 'debug', 'log', 'print', 'getProperty', 'getUserID', 'getUserName', 'getUserDisplayName', 'hasRole', 'nowDateTime', 'now', 'nowNoTZ', 'daysAgo', 'daysAgoStart', 'daysAgoEnd', 'minutesAgo', 'hoursAgo', 'monthsAgo', 'yearsAgo', 'beginningOfToday', 'endOfToday', 'beginningOfYesterday', 'endOfYesterday', 'getMessage', 'tableExists', 'nil', 'getCurrentScopeName', 'generateGUID', 'dateDiff']);
const READ_CONSTRUCTORS = new Set(['GlideRecord', 'GlideRecordSecure', 'GlideAggregate', 'GlideDateTime', 'GlideDate', 'GlideDuration', 'Date', 'Array', 'Object']);
const GLOBAL_FUNCS = new Set(['parseInt', 'parseFloat', 'isNaN', 'String', 'Number', 'Boolean']);
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'with', 'do', 'else', 'try', 'var', 'new', 'in', 'of', 'delete', 'void', 'throw', 'case']);
const GLIDE_CLASSES = /\b(GlideRecord|GlideRecordSecure|GlideAggregate)\b/g;
const FORBIDDEN_WORDS = /\b(eval|Function|prototype|constructor|__proto__|defineProperty|getSession|impersonate|Packages|java|global|this|arguments|apply|call|bind)\b/;

/**
 * Whether a script only reads: true only when every call is a known read-only API.
 * @returns {{safe: boolean, reasons: string[]}}
 */
export function checkReadOnlyScript(script) {
  const reasons = [];
  const src = String(script || '');
  if (!src.trim()) return { safe: true, reasons };
  const { masked, flags } = maskScript(src);
  if (flags.template) reasons.push('template literal');
  if (flags.slash) reasons.push('"/" (division or a regular expression) cannot be checked');
  if (/\w*__\w*/.test(masked)) reasons.push('identifier with "__"');
  const forbidden = masked.match(FORBIDDEN_WORDS);
  if (forbidden) reasons.push(`uses ${forbidden[1]}`);
  // Computed member access with a string key: x['name'] (the key is blanked by the mask), and calling a computed member.
  if (/[\w$)\]]\s*\[\s*(['"])\s*\1\s*\]/.test(masked)) reasons.push('computed member access with a string key');
  if (/\]\s*\(/.test(masked)) reasons.push('calls a computed member (x[name]())');
  // gs may only be used as gs.<read method>(...); anything else aliases or hides it.
  for (const m of masked.matchAll(/\bgs\b(\s*\.\s*(\w+)\s*\()?/g)) {
    if (!m[1] || !GS_READ.has(m[2])) {
      reasons.push(m[2] ? `gs.${m[2]} is not a known read-only call` : 'gs is used other than gs.method(...)');
      break;
    }
  }
  // GlideRecord classes only as `new X(`; any other use (aliasing, prototype, static calls) is refused.
  for (const m of masked.matchAll(GLIDE_CLASSES)) {
    if (!/\bnew\s+$/.test(masked.slice(Math.max(0, m.index - 8), m.index)) || !/^\s*\(/.test(masked.slice(m.index + m[0].length))) {
      reasons.push(`${m[1]} is used other than "new ${m[1]}(...)"`);
      break;
    }
  }
  for (const m of masked.matchAll(/\bnew\s+([\w$.]+)/g)) {
    if (!READ_CONSTRUCTORS.has(m[1])) {
      reasons.push(`new ${m[1]} is not a known read-only class`);
      break;
    }
  }
  for (const m of masked.matchAll(/\.\s*([\w$]+)\s*\(/g)) {
    if (!READ_METHODS.has(m[1])) {
      reasons.push(`.${m[1]}() is not a known read-only call`);
      break;
    }
  }
  const declared = new Set([...masked.matchAll(/\bfunction\s+([\w$]+)/g)].map((m) => m[1]));
  for (const m of masked.matchAll(/(^|[^\w$.\s]|\s)([\w$]+)\s*\(/g)) {
    const name = m[2];
    const before = masked.slice(0, m.index + m[1].length).trimEnd();
    if (KEYWORDS.has(name) || declared.has(name) || GLOBAL_FUNCS.has(name) || READ_CONSTRUCTORS.has(name)) continue;
    if (/\b(new|function)$/.test(before) || before.endsWith('.')) continue;
    reasons.push(`${name}() is not a known read-only call`);
    break;
  }
  return { safe: reasons.length === 0, reasons };
}

/**
 * Wrap a script so GlideRecord writes are intercepted and logged instead of
 * executed.
 *
 * LIMITATIONS - these are real and the user is told about them in the UI:
 *   * Only GlideRecord/GlideRecordSecure/GlideAggregate prototypes are patched.
 *     Writes performed through other APIs (GlideMultipleUpdate, direct SQL,
 *     outbound REST, gs.setProperty, workflow/flow activations, events that
 *     have already fired) are NOT intercepted.
 *   * If the prototype cannot be patched in the current scope, the wrapper
 *     refuses to run the script at all rather than silently executing writes.
 *
 * This fails closed by design.
 *
 * The user's script is compiled as its own function OUTSIDE the wrapper (under a random name), so it cannot
 * reach the wrapper's saved originals by name and restore real writes. After it runs, every patched method is
 * checked; if the script replaced one, the run is reported as TAMPERED (writes after that point may be real).
 */
export const DRY_RUN_TAMPER_MARK = '[NowBuddy dry run] TAMPERED';

function randomSuffix() {
  try {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function wrapAsDryRun(script) {
  const userFn = `msbDryRunUser_${randomSuffix()}`;
  return `// ==== NowBuddy DRY RUN ====
// GlideRecord write methods are intercepted below. Writes are logged, not applied.
// NOT intercepted: GlideMultipleUpdate, direct SQL, outbound REST, gs.setProperty,
// gs.eventQueue side effects, flows/workflows already triggered.
var ${userFn} = function () {
${indent(script, 2)}
};
(function (userScript) {
  var __canPatch = typeof GlideRecord !== 'undefined'
    && GlideRecord.prototype
    && typeof GlideRecord.prototype.update === 'function';

  if (!__canPatch) {
    gs.error('[NowBuddy] Dry run is NOT available in this scope - the GlideRecord prototype could not be intercepted. The script was NOT executed.');
    return;
  }

  var __writes = [];
  var __targets = [GlideRecord.prototype];
  if (typeof GlideRecordSecure !== 'undefined' && GlideRecordSecure.prototype && GlideRecordSecure.prototype !== GlideRecord.prototype) {
    __targets.push(GlideRecordSecure.prototype);
  }
  if (typeof GlideAggregate !== 'undefined' && GlideAggregate.prototype && __targets.indexOf(GlideAggregate.prototype) === -1) {
    __targets.push(GlideAggregate.prototype);
  }

  var __saved = [];
  var __methods = ['update', 'insert', 'deleteRecord', 'deleteMultiple', 'updateMultiple', 'updateWithReferences', 'insertWithReferences'];
  var __patchFailed = false;

  function __describe(gr) {
    try {
      var table = typeof gr.getTableName === 'function' ? gr.getTableName() : 'unknown';
      var id = typeof gr.getUniqueValue === 'function' ? (gr.getUniqueValue() || 'new') : 'unknown';
      return table + ' / ' + id;
    } catch (e) {
      return 'unknown record';
    }
  }

  __targets.forEach(function (proto) {
    __methods.forEach(function (method) {
      if (typeof proto[method] !== 'function') return;
      // An inherited method (a subclass prototype) is restored by deleting the own copy, never by pinning the
      // parent's stub onto the child.
      var __entry = { proto: proto, method: method, original: proto[method], own: Object.prototype.hasOwnProperty.call(proto, method), stub: null };
      __saved.push(__entry);
      var __stub = function () {
        var detail = method + ' -> ' + __describe(this);
        if (method === 'deleteMultiple' || method === 'updateMultiple') {
          try {
            detail += ' (' + this.getRowCount() + ' matching rows)';
          } catch (e) { /* row count unavailable */ }
        }
        __writes.push(detail);
        return method === 'insert' || method === 'insertWithReferences' ? null : true;
      };
      proto[method] = __stub;
      __entry.stub = __stub;
      if (proto[method] !== __stub) __patchFailed = true;
    });
  });

  function __restore() {
    for (var __k = __saved.length - 1; __k >= 0; __k--) {
      var __e = __saved[__k];
      if (__e.own) __e.proto[__e.method] = __e.original;
      else delete __e.proto[__e.method];
    }
  }

  if (__patchFailed) {
    __restore();
    gs.error('[NowBuddy] Dry run is NOT available in this scope - a GlideRecord method could not be intercepted. The script was NOT executed.');
    return;
  }

  var __tampered = [];
  try {
    userScript();
  } catch (__err) {
    gs.error('[NowBuddy dry run] Script threw: ' + __err);
  } finally {
    __saved.forEach(function (entry) {
      if (entry.proto[entry.method] !== entry.stub) __tampered.push(entry.method);
    });
    __restore();
  }
  if (__tampered.length) {
    gs.error('${DRY_RUN_TAMPER_MARK}: the script replaced ' + __tampered.join(', ') + ' while it ran. Writes after that point may have been REAL. Check the records it touches.');
  }

  gs.info('[NowBuddy dry run] Completed. ' + __writes.length + ' write operation(s) were SUPPRESSED.');
  for (var __i = 0; __i < __writes.length && __i < 200; __i++) {
    gs.info('[NowBuddy dry run] ' + (__i + 1) + '. ' + __writes[__i]);
  }
  if (__writes.length > 200) {
    gs.info('[NowBuddy dry run] ... ' + (__writes.length - 200) + ' more suppressed write(s) not listed.');
  }
})(${userFn});
${userFn} = null;`;
}

/**
 * Wrap a normal (non-dry) run with error capture and timing, so a thrown
 * exception produces a readable log entry instead of a raw stack dump.
 */
export function wrapWithGuards(script) {
  return `// ==== NowBuddy run ====
(function () {
  var __start = new Date().getTime();
  try {
${indent(script, 4)}
  } catch (__err) {
    gs.error('[NowBuddy] Script failed: ' + __err);
    throw __err;
  } finally {
    gs.info('[NowBuddy] Finished in ' + (new Date().getTime() - __start) + 'ms.');
  }
})();`;
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return (text || '')
    .split('\n')
    .map((line) => (line.trim() ? pad + line : line))
    .join('\n');
}
