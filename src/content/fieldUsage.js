// "Where is this field used?" (/usage incident.state), the instance half. Reads script fields with the same
// read-only search as the code search, narrowed on the server to the table and its parents where a script is bound
// to a table, plus the configuration that is not a script (UI policy actions, ACLs, data policies, dictionary
// overrides, filter conditions). Nothing is written. A source that cannot be read becomes a note.
// The pure half is src/lib/fieldUsage.js; the panel is src/sidebar/FieldUsagePanel.jsx.

import { searchCode, recordUrl } from './codeSearch.js';
import { queryTable } from './tableApi.js';
import { tableHierarchy } from './fieldInspector.js';
import {
  TABLE_RE,
  FIELD_RE,
  BOUND_COLUMN,
  certaintyFor,
  strongestKind,
  scriptUses,
  configSources,
  sortItems,
  headline,
} from '../lib/fieldUsage.js';

const CONFIG_LIMIT = 100;

/** Server-side narrowing for the tables whose scripts are bound to a table (ACLs are filtered afterwards). */
function boundQuery(chain) {
  return (artifact) => {
    const column = BOUND_COLUMN[artifact.table];
    if (!column || column === 'name') return '';
    return `${column}IN${chain.join(',')}`;
  };
}

/**
 * @param {{ table: string, field: string }} target
 * @returns {Promise<{ target: object, chain: string[], items: Array, headline: string, notes: string[], otherTables: number, capped: string[] }>}
 */
export async function buildFieldUsage({ table, field } = {}) {
  if (!TABLE_RE.test(table || '') || !FIELD_RE.test(field || '')) throw new Error('Give a table and a field, for example incident.state.');
  const chain = await tableHierarchy(table);
  const notes = [];

  // Scripts: one search per script table, narrowed to this table where the artifact has one.
  const scriptSearch = searchCode(field, { wholeWord: true, activeOnly: true, withSource: true, limitPerTable: 100, extraQuery: boundQuery(chain) })
    .then((found) => {
      const items = [];
      let otherTables = 0;
      found.results.forEach((hit) => {
        const certainty = certaintyFor(hit.table, { name: hit.name, scopeHint: hit.scopeHint, source: hit.source }, chain);
        if (!certainty) {
          otherTables += 1;
          return;
        }
        const uses = scriptUses(hit.source, field);
        if (!uses.length) return;
        items.push({
          label: hit.label,
          table: hit.table,
          sysId: hit.sysId,
          name: hit.name,
          field: hit.field,
          certainty,
          kind: strongestKind(uses),
          uses,
          url: recordUrl(hit.table, hit.sysId),
        });
      });
      found.errors.forEach((e) => notes.push(`${e.label} could not be searched: ${e.error}`));
      return { items, otherTables, capped: found.capped || [] };
    })
    .catch((err) => {
      notes.push(`Scripts could not be searched: ${err.message || err}`);
      return { items: [], otherTables: 0, capped: [] };
    });

  // Everything that is not a script, each source on its own so one unreadable table does not hide the rest.
  const configSearch = Promise.all(
    configSources(chain, field).map(async (source) => {
      try {
        const rows = await queryTable(source.table, source.query, source.fields, { limit: CONFIG_LIMIT });
        return rows
          .filter(source.keep)
          .map((row) => {
            const link = source.link ? source.link(row) : { table: source.table, sysId: row.sys_id };
            return {
              label: source.label,
              table: link.table,
              sysId: link.sysId,
              name: source.name(row),
              field: '',
              certainty: 'direct',
              kind: source.kind,
              uses: [],
              detail: source.detail(row),
              url: link.sysId ? recordUrl(link.table, link.sysId) : '',
            };
          });
      } catch (err) {
        notes.push(`${source.label}: ${err.message || err}`);
        return [];
      }
    }),
  ).then((groups) => groups.flat());

  const [scripts, config] = await Promise.all([scriptSearch, configSearch]);
  const items = sortItems([...scripts.items, ...config]);
  const target = { table, field };
  return {
    target,
    chain,
    items,
    otherTables: scripts.otherTables,
    capped: scripts.capped,
    notes,
    headline: headline(target, items, { otherTables: scripts.otherTables, capped: scripts.capped }),
  };
}

/** Services for the panel (merged by featureServices.js). */
export const fieldUsageServices = {
  fieldUsage: (target) => buildFieldUsage(target),
  fieldUsageFields: async (table) => {
    if (!TABLE_RE.test(table || '')) return [];
    const chain = await tableHierarchy(table);
    const rows = await queryTable('sys_dictionary', `nameIN${chain.join(',')}^elementISNOTEMPTY^internal_type!=collection`, ['element', 'column_label'], { limit: 500 });
    const seen = new Set();
    return rows
      .filter((r) => r.element && !seen.has(r.element) && seen.add(r.element))
      .map((r) => ({ name: r.element, label: r.column_label || '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
};
