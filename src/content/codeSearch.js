// Global code search: "where is this actually used?"
//
// ServiceNow has no first-class way to grep every script field on the
// instance. This walks the script-bearing configuration tables, pushes a LIKE
// filter to the server so we never download whole tables, then extracts the
// matching lines client-side for display.

import { queryTable } from './tableApi.js';
import { assertNoInlineScript } from '../lib/queryGuard.js';

/**
 * Script-bearing artifacts. `fields` are pulled for display; `scriptFields`
 * are the ones actually searched.
 *
 * NOTE: field names vary slightly across ServiceNow releases. If a table
 * returns an error or nothing at all, verify its field list first - see
 * docs/decisions.md.
 */
export const SEARCHABLE_ARTIFACTS = [
  {
    table: 'sys_script',
    label: 'Business Rule',
    fields: ['sys_id', 'name', 'collection', 'when', 'active'],
    scriptFields: ['script', 'condition'],
  },
  {
    table: 'sys_script_include',
    label: 'Script Include',
    fields: ['sys_id', 'name', 'api_name', 'active'],
    scriptFields: ['script'],
  },
  {
    table: 'sys_script_client',
    label: 'Client Script',
    fields: ['sys_id', 'name', 'table', 'type', 'active'],
    scriptFields: ['script'],
  },
  {
    table: 'sys_ui_action',
    label: 'UI Action',
    fields: ['sys_id', 'name', 'table', 'active'],
    scriptFields: ['script', 'condition'],
  },
  {
    table: 'sys_ui_policy',
    label: 'UI Policy',
    fields: ['sys_id', 'short_description', 'table', 'active'],
    scriptFields: ['script_true', 'script_false'],
    nameField: 'short_description',
  },
  {
    table: 'sysevent_script_action',
    label: 'Script Action',
    fields: ['sys_id', 'name', 'event_name', 'active'],
    scriptFields: ['script'],
  },
  {
    table: 'sysauto_script',
    label: 'Scheduled Job',
    fields: ['sys_id', 'name', 'active'],
    scriptFields: ['script'],
  },
  {
    table: 'sys_transform_script',
    label: 'Transform Script',
    fields: ['sys_id', 'map.name', 'when'],
    scriptFields: ['script'],
    nameField: 'map.name',
  },
  {
    table: 'sys_processor',
    label: 'Processor',
    fields: ['sys_id', 'name', 'active'],
    scriptFields: ['script'],
  },
  {
    table: 'sys_ws_operation',
    label: 'Scripted REST Operation',
    fields: ['sys_id', 'name', 'http_method', 'active'],
    scriptFields: ['operation_script'],
  },
  {
    table: 'sys_security_acl',
    label: 'ACL',
    fields: ['sys_id', 'name', 'operation', 'active'],
    scriptFields: ['script', 'condition'],
  },
  {
    table: 'sp_widget',
    label: 'Portal Widget',
    fields: ['sys_id', 'name', 'id'],
    scriptFields: ['script', 'client_script'],
  },
  {
    table: 'sys_ui_script',
    label: 'UI Script',
    fields: ['sys_id', 'name', 'active'],
    scriptFields: ['script'],
  },
  {
    table: 'catalog_script_client',
    label: 'Catalog Client Script',
    fields: ['sys_id', 'name', 'type', 'active'],
    scriptFields: ['script'],
  },
];

export function searchableTableOptions() {
  return SEARCHABLE_ARTIFACTS.map(({ table, label }) => ({ table, label }));
}

/**
 * ServiceNow encoded queries use `^` and `^OR` as separators, so a search term
 * containing them would break out of the intended condition. Reject rather
 * than silently mangle - the user needs to know their term was altered.
 */
function assertSafeTerm(term) {
  if (!term || term.trim().length < 3) {
    throw new Error('Enter at least 3 characters to search.');
  }
  if (/[\^]/.test(term)) {
    throw new Error('Search term cannot contain "^" (it is an encoded-query separator).');
  }
  assertNoInlineScript(term, 'Search term');
  return term.trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract the matching lines (with line numbers) from one script field. */
function extractMatches(script, term, { wholeWord, maxPerField = 8 }) {
  if (!script) return [];

  // A word boundary only makes sense next to a word character: "getValue(" ends in "(", and
  // \b after it would demand a letter, so the search found nothing.
  const before = /^[\w$]/.test(term) ? '(?<![\\w$])' : '';
  const after = /[\w$]$/.test(term) ? '(?![\\w$])' : '';
  const pattern = wholeWord
    ? new RegExp(`${before}${escapeRegExp(term)}${after}`, 'i')
    : new RegExp(escapeRegExp(term), 'i');

  const matches = [];
  const lines = script.split('\n');
  for (let i = 0; i < lines.length && matches.length < maxPerField; i += 1) {
    if (!pattern.test(lines[i])) continue;
    const text = lines[i].trim();
    matches.push({
      lineNumber: i + 1,
      text: text.length > 220 ? `${text.slice(0, 220)}...` : text,
    });
  }
  return matches;
}

/**
 * Search every selected artifact table for `term`.
 *
 * @param {string} term Literal substring to find (not a regex).
 * @param {{tables?: string[], activeOnly?: boolean, wholeWord?: boolean, limitPerTable?: number}} options
 * @returns {Promise<{term:string, totalMatches:number, scannedTables:number, errors:Array, results:Array}>}
 */
export async function searchCode(term, options = {}) {
  const {
    tables = null,
    activeOnly = true,
    wholeWord = false,
    limitPerTable = 100,
  } = options;

  const safeTerm = assertSafeTerm(term);
  const targets = tables && tables.length
    ? SEARCHABLE_ARTIFACTS.filter((a) => tables.includes(a.table))
    : SEARCHABLE_ARTIFACTS;

  const errors = [];
  const results = [];

  const settled = await Promise.allSettled(
    targets.map(async (artifact) => {
      // Push the filter to the server: `scriptLIKEterm^ORconditionLIKEterm`.
      const likeClause = artifact.scriptFields
        .map((field) => `${field}LIKE${safeTerm}`)
        .join('^OR');

      // `active=true^aLIKEx^ORbLIKEx` means active AND (a OR b): an ^OR term binds to the
      // condition before it. Filtering on the server matters: filtered afterwards, inactive
      // matches used up the row limit and active ones were never seen.
      const hasActive = artifact.fields.includes('active');
      const query = activeOnly && hasActive ? `active=true^${likeClause}` : likeClause;
      const fields = [...new Set([...artifact.fields, ...artifact.scriptFields])];
      const rows = await queryTable(artifact.table, query, fields, { limit: limitPerTable });

      rows.forEach((row) => {
        if (activeOnly && 'active' in row && String(row.active) === 'false') return;

        artifact.scriptFields.forEach((field) => {
          const matches = extractMatches(row[field], safeTerm, { wholeWord });
          if (!matches.length) return;

          const nameField = artifact.nameField || 'name';
          results.push({
            table: artifact.table,
            label: artifact.label,
            sysId: row.sys_id,
            name: row[nameField] || row.name || '(unnamed)',
            field,
            scopeHint: row.collection || row.table || row.event_name || '',
            matches,
          });
        });
      });
    })
  );

  settled.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      errors.push({
        table: targets[index].table,
        label: targets[index].label,
        error: outcome.reason?.message || String(outcome.reason),
      });
    }
  });

  results.sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));

  return {
    term: safeTerm,
    totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0),
    totalRecords: results.length,
    scannedTables: targets.length,
    errors,
    results,
  };
}

/** Build a record URL on the current instance. */
export function recordUrl(table, sysId) {
  return `/${table}.do?sys_id=${encodeURIComponent(sysId)}`;
}
