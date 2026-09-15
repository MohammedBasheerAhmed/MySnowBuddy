// Pre-save diff: show exactly what the current form will write over the
// stored record, before the user clicks Update.
//
// This is the ServiceNow equivalent of `git diff` on an uncommitted change,
// and it is the cheapest way to catch "I accidentally pasted over someone
// else's script".

import { callPage } from './pageBridge.js';
import { fetchRecord } from './tableApi.js';
import { diffLines, summarizeDiff, hasChanges } from '../lib/diff.js';

// Journal/system fields change on every save and would drown the real diff.
const IGNORED_FIELDS = new Set([
  'sys_updated_on',
  'sys_updated_by',
  'sys_created_on',
  'sys_created_by',
  'sys_mod_count',
  'sys_id',
  'sys_tags',
]);

// Fields long enough to be worth a line-by-line diff rather than old -> new.
const MULTILINE_THRESHOLD = 120;

/**
 * Compare the live form values against the saved record.
 *
 * @returns {Promise<{supported:boolean, reason?:string, table?:string, sysId?:string,
 *   isNewRecord?:boolean, changes?:Array, unchangedCount?:number}>}
 */
export async function getFormDiff() {
  let form;
  try {
    form = await callPage('getFormValues');
  } catch (err) {
    return {
      supported: false,
      reason: `Could not read the form: ${err.message}. Open a record form and try again.`,
    };
  }

  if (!form || !form.values) {
    return {
      supported: false,
      reason: 'No ServiceNow form (g_form) was found on this page. Open a record form and try again.',
    };
  }

  if (form.isNewRecord || !form.sysId) {
    return {
      supported: false,
      reason: 'This is a new record, so there is no saved version to compare against.',
      table: form.table,
      isNewRecord: true,
    };
  }

  const fieldNames = Object.keys(form.values).filter((f) => !IGNORED_FIELDS.has(f));
  if (!fieldNames.length) {
    return { supported: false, reason: 'No comparable fields were readable on this form.' };
  }

  const stored = await fetchRecord(form.table, form.sysId, fieldNames);
  if (!stored) {
    return {
      supported: false,
      reason: `Could not read ${form.table} / ${form.sysId} through the Table API. You may lack read access.`,
    };
  }

  const changes = [];
  let unchangedCount = 0;

  fieldNames.forEach((field) => {
    const formValue = String(form.values[field] ?? '');
    const storedRaw = stored[field];
    // Reference fields come back as objects when display values are requested;
    // fall back to the raw value.
    const storedValue = String(
      (storedRaw && typeof storedRaw === 'object' ? storedRaw.value : storedRaw) ?? ''
    );

    if (formValue === storedValue) {
      unchangedCount += 1;
      return;
    }

    const isMultiline =
      formValue.includes('\n') ||
      storedValue.includes('\n') ||
      formValue.length > MULTILINE_THRESHOLD ||
      storedValue.length > MULTILINE_THRESHOLD;

    const change = {
      field,
      label: form.labels?.[field] || field,
      oldValue: storedValue,
      newValue: formValue,
      multiline: isMultiline,
      diffText: null,
    };

    if (isMultiline) {
      const diff = diffLines(storedValue, formValue);
      change.diffText = hasChanges(diff) ? summarizeDiff(diff, 2) : null;
    }

    changes.push(change);
  });

  return {
    supported: true,
    table: form.table,
    sysId: form.sysId,
    isNewRecord: false,
    changes,
    unchangedCount,
  };
}

/** Plain-text rendering used for the chat message and for export. */
export function formatFormDiff(result) {
  if (!result.supported) return result.reason;
  if (!result.changes.length) {
    return `No unsaved changes on this ${result.table} record. (${result.unchangedCount} fields checked.)`;
  }

  const truncate = (value) => {
    const single = value.replace(/\s+/g, ' ').trim();
    return single.length > 200 ? `${single.slice(0, 200)}...` : single || '(empty)';
  };

  const body = result.changes
    .map((change) => {
      if (change.multiline && change.diffText) {
        return `### ${change.label} (${change.field})\n${change.diffText}`;
      }
      return `### ${change.label} (${change.field})\n- old: ${truncate(change.oldValue)}\n+ new: ${truncate(change.newValue)}`;
    })
    .join('\n\n');

  return (
    `${result.changes.length} unsaved change(s) on ${result.table} / ${result.sysId}` +
    ` (${result.unchangedCount} fields unchanged):\n\n${body}`
  );
}
