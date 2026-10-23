// sys_flow_context.flow is a plain string (the flow's sys_id), not a reference, so the Table API never turns it into a
// name, and `name` on the context is often empty. Rows like that get their name looked up in sys_hub_flow here.
// Fails soft: if the lookup cannot be read, the rows come back unchanged and the panels fall back to the source record.

import { queryTable } from './tableApi.js';

const SYS_ID = /^[0-9a-f]{32}$/i;
const LOOKUP_LIMIT = 50;

const valueOf = (cell) => String(cell && typeof cell === 'object' ? (cell.value ?? '') : (cell ?? '')).trim();

/**
 * @param {object[]} rows sys_flow_context rows, as plain strings or as { value, display_value } cells
 * @param {typeof queryTable} [query] the table reader (a parameter so a test can stand in for the instance)
 */
export async function withFlowNames(rows, query = queryTable) {
  const wanted = [];
  for (const row of rows || []) {
    const id = valueOf(row.flow);
    if (!valueOf(row.name) && SYS_ID.test(id) && !wanted.includes(id)) wanted.push(id);
  }
  if (!wanted.length) return rows;
  let names;
  try {
    const found = await query('sys_hub_flow', `sys_idIN${wanted.slice(0, LOOKUP_LIMIT).join(',')}`, ['sys_id', 'name'], { limit: LOOKUP_LIMIT });
    names = new Map(found.map((r) => [valueOf(r.sys_id), valueOf(r.name)]));
  } catch {
    return rows;
  }
  return rows.map((row) => {
    const name = names.get(valueOf(row.flow));
    if (!name || valueOf(row.name)) return row;
    return { ...row, name: row.flow && typeof row.flow === 'object' ? { value: name, display_value: name } : name };
  });
}
