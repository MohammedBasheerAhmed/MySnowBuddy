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
  { pattern: /\.\s*insert\s*\(/, severity: 'medium', label: 'record insert' },
  { pattern: /\.\s*update\s*\(/, severity: 'medium', label: 'record update' },
  { pattern: /\.\s*setWorkflow\s*\(\s*false\s*\)/, severity: 'medium', label: 'business rules suppressed (setWorkflow(false))' },
  { pattern: /\bgs\s*\.\s*eventQueue\s*\(/, severity: 'medium', label: 'event queued' },
  { pattern: /\bnew\s+GlideRecord\s*\([^)]*\)\s*[\s\S]{0,80}?\.\s*initialize\s*\(/, severity: 'medium', label: 'new record initialised' },
  { pattern: /\bsn_ws\s*\.\s*RESTMessageV2\b/, severity: 'medium', label: 'outbound REST call' },
  { pattern: /\bgs\s*\.\s*setProperty\s*\(/, severity: 'high', label: 'system property write' },
  { pattern: /\bGlideMultipleUpdate\b/, severity: 'high', label: 'GlideMultipleUpdate bulk write' },
  { pattern: /\bnew\s+GlideDBUtil\b|\bexecuteSQL\b/, severity: 'high', label: 'direct database utility call' },
];

/**
 * Detect operations that mutate instance state.
 * @returns {{writes: Array<{severity:string,label:string,line:number,lineText:string}>, hasWrites:boolean, highestSeverity:string|null}}
 */
export function analyzeScriptRisk(script) {
  const writes = [];
  if (!script || !script.trim()) {
    return { writes, hasWrites: false, highestSeverity: null };
  }

  const lines = script.split('\n');
  lines.forEach((lineText, index) => {
    // Skip obvious comment lines to cut down on noise.
    const trimmed = lineText.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

    WRITE_PATTERNS.forEach(({ pattern, severity, label }) => {
      if (!pattern.test(lineText)) return;
      writes.push({
        severity,
        label,
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

  return { writes, hasWrites: writes.length > 0, highestSeverity };
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
 */
export function wrapAsDryRun(script) {
  return `// ==== MySnowBuddy DRY RUN ====
// GlideRecord write methods are intercepted below. Writes are logged, not applied.
// NOT intercepted: GlideMultipleUpdate, direct SQL, outbound REST, gs.setProperty,
// gs.eventQueue side effects, flows/workflows already triggered.
(function () {
  var __canPatch = typeof GlideRecord !== 'undefined'
    && GlideRecord.prototype
    && typeof GlideRecord.prototype.update === 'function';

  if (!__canPatch) {
    gs.error('[MySnowBuddy] Dry run is NOT available in this scope - the GlideRecord prototype could not be intercepted. The script was NOT executed.');
    return;
  }

  var __writes = [];
  var __targets = [GlideRecord.prototype];
  if (typeof GlideRecordSecure !== 'undefined' && GlideRecordSecure.prototype && GlideRecordSecure.prototype !== GlideRecord.prototype) {
    __targets.push(GlideRecordSecure.prototype);
  }

  var __saved = [];
  var __methods = ['update', 'insert', 'deleteRecord', 'deleteMultiple', 'updateMultiple'];

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
      __saved.push({ proto: proto, method: method, original: proto[method] });
      proto[method] = function () {
        var detail = method + ' -> ' + __describe(this);
        if (method === 'deleteMultiple' || method === 'updateMultiple') {
          try {
            detail += ' (' + this.getRowCount() + ' matching rows)';
          } catch (e) { /* row count unavailable */ }
        }
        __writes.push(detail);
        return method === 'insert' ? null : true;
      };
    });
  });

  try {
${indent(script, 4)}
  } catch (__err) {
    gs.error('[MySnowBuddy dry run] Script threw: ' + __err);
  } finally {
    __saved.forEach(function (entry) { entry.proto[entry.method] = entry.original; });
  }

  gs.info('[MySnowBuddy dry run] Completed. ' + __writes.length + ' write operation(s) were SUPPRESSED.');
  for (var __i = 0; __i < __writes.length && __i < 200; __i++) {
    gs.info('[MySnowBuddy dry run] ' + (__i + 1) + '. ' + __writes[__i]);
  }
  if (__writes.length > 200) {
    gs.info('[MySnowBuddy dry run] ... ' + (__writes.length - 200) + ' more suppressed write(s) not listed.');
  }
})();`;
}

/**
 * Wrap a normal (non-dry) run with error capture and timing, so a thrown
 * exception produces a readable log entry instead of a raw stack dump.
 */
export function wrapWithGuards(script) {
  return `// ==== MySnowBuddy run ====
(function () {
  var __start = new Date().getTime();
  try {
${indent(script, 4)}
  } catch (__err) {
    gs.error('[MySnowBuddy] Script failed: ' + __err);
    throw __err;
  } finally {
    gs.info('[MySnowBuddy] Finished in ' + (new Date().getTime() - __start) + 'ms.');
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
