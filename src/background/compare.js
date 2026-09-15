import { COMPARE_ARTIFACTS } from '../lib/artifacts.js';
import { diffLines, summarizeDiff, hasChanges } from '../lib/diff.js';
import { fetchRecords, normalizeInstanceUrl } from './instanceClient.js';
import { redactSecrets } from '../providers/redact.js';

function indexByKey(records, keyField) {
  const map = new Map();
  records.forEach((record) => {
    const key = record[keyField];
    if (key) map.set(key, record);
  });
  return map;
}

export async function compareInstances({ sourceUrl, targetUrl, table, query = '' }) {
  const def = COMPARE_ARTIFACTS[table];
  if (!def) {
    throw new Error(`Unsupported artifact type: ${table}`);
  }

  const source = normalizeInstanceUrl(sourceUrl);
  const target = normalizeInstanceUrl(targetUrl);
  if (source === target) {
    throw new Error('Source and target instances must be different.');
  }

  const [sourceRecords, targetRecords] = await Promise.all([
    fetchRecords(source, table, def.fields, { query }),
    fetchRecords(target, table, def.fields, { query }),
  ]);

  const sourceIndex = indexByKey(sourceRecords, def.key);
  const targetIndex = indexByKey(targetRecords, def.key);

  const added = [];
  const removed = [];
  const modified = [];

  sourceIndex.forEach((sourceRecord, key) => {
    const targetRecord = targetIndex.get(key);
    if (!targetRecord) {
      removed.push({ key, record: sourceRecord });
      return;
    }

    const fieldDiffs = [];
    def.compareFields.forEach((field) => {
      const a = sourceRecord[field] ?? '';
      const b = targetRecord[field] ?? '';
      if (String(a) === String(b)) return;
      const diff = diffLines(String(a), String(b));
      if (hasChanges(diff)) {
        fieldDiffs.push({ field, diffText: summarizeDiff(diff) });
      }
    });

    if (fieldDiffs.length) {
      modified.push({
        key,
        sourceSysId: sourceRecord.sys_id,
        targetSysId: targetRecord.sys_id,
        fieldDiffs,
      });
    }
  });

  targetIndex.forEach((targetRecord, key) => {
    if (!sourceIndex.has(key)) {
      added.push({ key, record: targetRecord });
    }
  });

  return {
    source,
    target,
    table,
    label: def.label,
    counts: {
      sourceTotal: sourceRecords.length,
      targetTotal: targetRecords.length,
      added: added.length,
      removed: removed.length,
      modified: modified.length,
    },
    added,
    removed,
    modified,
  };
}

// Builds a compact, redacted prompt describing the diff. Truncated so a large
// comparison can't blow up the request size or cost.
export function buildDiffSummaryPrompt(result, { maxModified = 15, maxDiffChars = 1200 } = {}) {
  const lines = [];
  lines.push(
    `Compare of ${result.label} between source=${new URL(result.source).hostname} ` +
      `and target=${new URL(result.target).hostname}.`
  );
  lines.push(
    `Only in source (missing from target): ${result.removed.length} — ` +
      `${result.removed.slice(0, 20).map((r) => r.key).join(', ') || 'none'}`
  );
  lines.push(
    `Only in target (missing from source): ${result.added.length} — ` +
      `${result.added.slice(0, 20).map((r) => r.key).join(', ') || 'none'}`
  );
  lines.push(`Modified: ${result.modified.length}`);

  result.modified.slice(0, maxModified).forEach((item) => {
    lines.push(`\n--- ${item.key} ---`);
    item.fieldDiffs.forEach((fd) => {
      lines.push(`[${fd.field}]`);
      lines.push(redactSecrets(fd.diffText).slice(0, maxDiffChars));
    });
  });

  if (result.modified.length > maxModified) {
    lines.push(`\n(${result.modified.length - maxModified} further modified records omitted.)`);
  }

  return (
    'You are reviewing configuration drift between two ServiceNow instances. ' +
    'Summarize what changed and, importantly, why it matters operationally — ' +
    'call out risks such as a condition tightened in one instance that a deployment ' +
    'from the other would revert, deactivated logic, or security-relevant changes. ' +
    'Be concise and prioritize by risk.\n\n' +
    lines.join('\n')
  );
}
