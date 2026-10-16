// Export a scope's scripts as a ZIP of plain files (one script per file).

import { queryTable, queryAll } from './tableApi.js';
import { SCOPE_ARTIFACTS, buildScopeFiles, scopeFields } from '../lib/scopeExport.js';
import { createZip } from '../lib/zip.js';
import { downloadBlob, suggestFilename } from '../lib/report.js';

const SCOPE_RE = /^[a-z0-9_]+$/i;
const MAX_PER_TABLE = 2000;

/** Custom applications first, then everything else matching the search. */
export function fetchScopes(search = '') {
  if (search.includes('^')) throw new Error('Search text cannot contain "^".');
  const needle = search.trim();
  const filter = needle ? `nameLIKE${needle}^ORscopeLIKE${needle}` : 'scopeSTARTSWITHx_';
  return queryTable('sys_scope', `${filter}^ORDERBYname`, ['sys_id', 'scope', 'name', 'version'], { limit: 50 });
}

/**
 * Fetch every supported artifact in `scope` and lay it out as files.
 * Tables the user cannot read are skipped and reported.
 */
export async function exportScope(scope, { onProgress = () => {} } = {}) {
  if (!SCOPE_RE.test(scope || '')) throw new Error('Choose a scope first.');

  const sets = [];
  const skipped = [];
  const truncated = [];

  for (let i = 0; i < SCOPE_ARTIFACTS.length; i += 1) {
    const def = SCOPE_ARTIFACTS[i];
    onProgress(`Reading ${def.label} (${i + 1}/${SCOPE_ARTIFACTS.length})...`);
    try {
      // eslint-disable-next-line no-await-in-loop -- tables are read one at a time to limit load.
      const records = await queryAll(def.table, `sys_scope.scope=${scope}^ORDERBY${def.meta[0]}`, scopeFields(def), { max: MAX_PER_TABLE });
      if (records.length >= MAX_PER_TABLE) truncated.push(def.label);
      sets.push({ def, records });
    } catch {
      skipped.push(def.label);
    }
  }

  const files = buildScopeFiles(scope, sets);
  const artifactCount = sets.reduce((sum, s) => sum + s.records.length, 0);
  return { files, artifactCount, skipped, truncated };
}

export function downloadScopeZip(scope, files) {
  const bytes = createZip(files);
  downloadBlob(suggestFilename(`scope-${scope}`, 'zip'), new Blob([bytes], { type: 'application/zip' }));
}
