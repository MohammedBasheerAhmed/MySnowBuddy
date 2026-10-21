// "Find all references" for the script editor: where on this instance is this Script Include, method or name used?
//
// It uses the same read-only search as the code search (one LIKE query per script table, so it never downloads a
// table), then reads each matching script closely (src/lib/scriptApi.js) to tell a real call from a word that
// only appears in a string or an unrelated object. Nothing is written.

import { searchCode, recordUrl } from './codeSearch.js';
import { classifyReference, referenceLines } from '../lib/scriptApi.js';

const CERTAINTY_ORDER = { call: 0, maybe: 1 };

/**
 * @param {{kind: 'class'|'method'|'text', name: string, className?: string}} target from referenceTarget()
 * @param {{ excludeSysId?: string, activeOnly?: boolean }} options `excludeSysId` is the record being edited
 * @returns {Promise<{ target: object, hits: Array, capped: string[], errors: Array, scanned: number }>}
 */
export async function findReferences(target, { excludeSysId = '', activeOnly = true } = {}) {
  if (!target || !target.name) throw new Error('Put the caret on a name first.');
  const found = await searchCode(target.name, { wholeWord: true, activeOnly, withSource: true, limitPerTable: 100 });

  const hits = [];
  for (const result of found.results) {
    if (excludeSysId && result.sysId === excludeSysId) continue;
    const certainty = classifyReference(result.source, target);
    if (!certainty) continue;
    hits.push({
      table: result.table,
      label: result.label,
      sysId: result.sysId,
      name: result.name,
      field: result.field,
      certainty,
      lines: referenceLines(result.source, target),
      url: recordUrl(result.table, result.sysId),
    });
  }
  hits.sort((a, b) => CERTAINTY_ORDER[a.certainty] - CERTAINTY_ORDER[b.certainty] || a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
  const result = { target, hits, capped: found.capped || [], errors: found.errors, scanned: found.scannedTables };
  return { ...result, summary: summarizeReferences(result) };
}

/** One line for a result set: "7 uses of UserUtils.getEmail (5 confirmed)". */
export function summarizeReferences({ target, hits, capped, errors }) {
  const label = target.kind === 'method' ? `${target.className}.${target.name}` : target.kind === 'table' ? `the table ${target.name}` : target.name;
  const confirmed = hits.filter((h) => h.certainty === 'call').length;
  let text = hits.length
    ? `${hits.length} ${hits.length === 1 ? 'script uses' : 'scripts use'} ${label}${confirmed && confirmed < hits.length ? ` (${confirmed} confirmed, ${hits.length - confirmed} possible)` : ''}`
    : `No other script uses ${label}`;
  if (capped.length) text += `. Only the first 100 matches were read in ${capped.join(', ')}`;
  if (errors.length) text += `. ${errors.length} table${errors.length === 1 ? '' : 's'} could not be searched`;
  return text;
}
