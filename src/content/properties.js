// System properties (/prop), the instance half. Reads sys_properties through the user's own session, finds the scripts
// that mention a property, says whether this instance may be written to, and keeps the list of changes made from the
// panel (chrome.storage.local) so Restore still works after a reload.
//
// The WRITES are not here: the panel asks first (askConfirm) and sends them through the agent's own update_record
// (services.agentExecute), so the write policy, the dictionary check and the audit log with undo apply exactly as they
// do for the agent and for the Test data panel. Nothing in this file writes to the instance.
//
// A property whose value is a secret never leaves this file with its value: toProperty() (src/lib/properties.js) drops it.
// The pure half is src/lib/properties.js; the panel is src/sidebar/PropertiesPanel.jsx.

import { queryTable, countRecords } from './tableApi.js';
import { searchCode, recordUrl } from './codeSearch.js';
import { getInstanceInfo, getCurrentUpdateSet } from './quickActions.js';
import { compareWithInstance } from './remoteRecord.js';
import { currentPageHref } from './context.js';
import { parseTablePage } from '../lib/urlTarget.js';
import {
  PROPERTY_TABLE,
  SEARCH_LIMIT,
  ALL_COLUMNS,
  CHANGES_KEY,
  DEV_SWITCH_NAMES,
  rawOf,
  toProperty,
  nameLooksSecret,
  searchQueries,
  rankProperties,
  mergeSwitches,
  classifyUsage,
  usageSummary,
  compareOutcome,
} from '../lib/properties.js';

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const NAME_RE = /^[A-Za-z0-9_.\-]+$/;
const RECENT_LIMIT = 12;

// --- Which columns this instance returns ---------------------------------------------------------------------------

let columnsCache = null;
const PROBE_ROWS = 10;

/**
 * The columns of sys_properties the instance actually returns, found by reading a few rows: an unknown column is
 * silently left out of an answer, and a search condition on an unknown column is silently ignored (it would match every
 * row), so nothing is searched on a column that did not come back. The union of several rows is used, because a field
 * ACL can leave a column out of one row (a private property's value) and not of the others.
 */
async function readableColumns() {
  if (columnsCache) return columnsCache;
  const rows = await queryTable(PROPERTY_TABLE, '', ALL_COLUMNS, { limit: PROBE_ROWS, displayValue: true });
  if (!rows[0]) throw new Error('No system property could be read. Your user may not be allowed to see sys_properties.');
  columnsCache = new Set(rows.flatMap((r) => Object.keys(r)));
  return columnsCache;
}

/** Forget which columns the instance returned (the next read looks again). */
export function propertyReset() {
  columnsCache = null;
}

// Every read asks for every column. A column the instance does not have is simply left out of the answer, and one a field
// ACL hides on a row is left out of that row only, which toProperty() reports per row ("unreadable", never "empty"). The
// probe above decides only which columns a search CONDITION may use.
async function readRows(query, limit) {
  await readableColumns();
  const rows = await queryTable(PROPERTY_TABLE, query, ALL_COLUMNS, { limit, displayValue: true });
  return rows.map(toProperty);
}

/** Things the instance did not return, in words, so a missing column is never mistaken for an empty one. */
function columnNotes(columns) {
  const notes = [];
  if (!columns.has('value')) notes.push('The value column was not returned: your user may not be allowed to read it.');
  if (!columns.has('description')) notes.push('This instance returned no description column, so descriptions were not searched.');
  return notes;
}

// --- Find, read -----------------------------------------------------------------------------------------------------

/** Ranked properties whose name, description or value match the words in `query`. */
export async function searchProperties(query) {
  const columns = await readableColumns();
  const { name, wide } = searchQueries(query, columns);
  const fields = ALL_COLUMNS;
  const [byName, byWide, total] = await Promise.all([
    queryTable(PROPERTY_TABLE, name, fields, { limit: SEARCH_LIMIT, displayValue: true }),
    queryTable(PROPERTY_TABLE, wide, fields, { limit: SEARCH_LIMIT, displayValue: true }),
    countRecords(PROPERTY_TABLE, wide).catch(() => null),
  ]);
  const merged = new Map();
  [...byName, ...byWide].forEach((row) => {
    const key = rawOf(row.sys_id) || rawOf(row.name);
    if (!merged.has(key)) merged.set(key, row);
  });
  const ranked = rankProperties([...merged.values()].map(toProperty), query);
  const capped = byName.length >= SEARCH_LIMIT || byWide.length >= SEARCH_LIMIT;
  const rows = ranked.slice(0, SEARCH_LIMIT);
  return { query, rows, total: Math.max(total ?? 0, rows.length), capped, notes: columnNotes(columns) };
}

/** One property, by its record or its exact name. `others` counts further properties with the same name. */
export async function getProperty({ sysId = '', name = '' } = {}) {
  let query;
  if (sysId) {
    if (!SYS_ID_RE.test(sysId)) throw new Error('That is not a property record.');
    query = `sys_id=${sysId}`;
  } else {
    if (!NAME_RE.test(name || '')) throw new Error('A property name has letters, digits, dots, dashes and underscores only.');
    query = `name=${name}`;
  }
  const rows = await readRows(query, 5);
  const columns = await readableColumns();
  return { property: rows[0] || null, others: Math.max(0, rows.length - 1), notes: columnNotes(columns) };
}

/** The properties changed most recently (anyone's change), newest first. Empty when the instance has no update stamp. */
export async function recentProperties() {
  const columns = await readableColumns();
  if (!columns.has('sys_updated_on')) return [];
  return readRows('ORDERBYDESCsys_updated_on', RECENT_LIMIT);
}

/** The developer switches joined with what this instance holds (a missing one is reported, never created). */
export async function developerSwitches() {
  const rows = await readRows(`nameIN${DEV_SWITCH_NAMES.join(',')}`, DEV_SWITCH_NAMES.length * 2);
  return mergeSwitches(rows);
}

// --- Who reads it --------------------------------------------------------------------------------------------------

// Script places the shared code search (src/content/codeSearch.js) does not cover but that read properties: fix scripts,
// email scripts, UI pages and macros, and the default or calculation script of a dictionary entry.
// `activeOnly` is used only where the table certainly has an active column (a condition on a missing column is ignored,
// or, with glide.invalid_query.returns_no_rows on, matches nothing). Fix scripts are not filtered: whether
// sys_script_fix has an active column is not certain, and a fix script is run by hand anyway.
const EXTRA_TABLES = [
  { table: 'sys_script_fix', label: 'Fix Script', fields: ['sys_id', 'name'], scriptFields: ['script'] },
  { table: 'sys_script_email', label: 'Email Script', fields: ['sys_id', 'name'], scriptFields: ['script'] },
  { table: 'sys_ui_page', label: 'UI Page', fields: ['sys_id', 'name'], scriptFields: ['html', 'client_script', 'processing_script'] },
  { table: 'sys_ui_macro', label: 'UI Macro', fields: ['sys_id', 'name'], scriptFields: ['xml'], activeOnly: true },
  { table: 'sys_dictionary', label: 'Dictionary default', fields: ['sys_id', 'name', 'element'], scriptFields: ['default_value', 'calculation'], activeOnly: true, nameOf: (r) => `${r.name}.${r.element}` },
];

async function searchExtraTables(term) {
  const results = [];
  const errors = [];
  const capped = [];
  const needle = term.toLowerCase();
  await Promise.all(
    EXTRA_TABLES.map(async (def) => {
      try {
        const like = def.scriptFields.map((f) => `${f}LIKE${term}`).join('^OR');
        const query = def.activeOnly ? `active=true^${like}` : like;
        const rows = await queryTable(def.table, query, [...def.fields, ...def.scriptFields], { limit: 100 });
        if (rows.length >= 100) capped.push(def.label);
        rows.forEach((row) => {
          def.scriptFields.forEach((field) => {
            const source = typeof row[field] === 'string' ? row[field] : '';
            if (!source || !source.toLowerCase().includes(needle)) return;
            results.push({ table: def.table, label: def.label, sysId: row.sys_id, name: (def.nameOf ? def.nameOf(row) : row.name) || '(unnamed)', field, source });
          });
        });
      } catch (err) {
        errors.push({ table: def.table, label: def.label, error: err.message || String(err) });
      }
    })
  );
  return { results, errors, capped, scanned: EXTRA_TABLES.length };
}

/**
 * Is the property behind this name a secret (its name, its type or its value says so)? Then the lines of the scripts
 * that use it are masked: `gs.getProperty('x.bind', 'hunter2')` must not show its default. When the property cannot be
 * read, the answer is yes: masking a line too many is better than showing a password.
 */
async function usageIsSecret(name) {
  if (nameLooksSecret(name)) return true;
  try {
    const rows = await readRows(`name=${name}`, 5);
    return rows.some((p) => p.hidden);
  } catch {
    return true;
  }
}

/** Every active script that mentions the property name, read closely: reads it, sets it, or only mentions it. */
export async function findPropertyUsage(name) {
  if (!NAME_RE.test(name || '') || name.length < 3) throw new Error('A property name has letters, digits, dots, dashes and underscores only.');
  const [base, extra, secret] = await Promise.all([searchCode(name, { wholeWord: true, activeOnly: true, withSource: true, limitPerTable: 100 }), searchExtraTables(name), usageIsSecret(name)]);
  const searched = base.scannedTables + extra.scanned;
  const errors = [...base.errors, ...extra.errors];
  // Nothing could be read at all: say so, rather than "no script uses it".
  if (errors.length >= searched) throw new Error(`No script table could be searched: ${errors[0]?.error || 'unknown error'}`);
  const results = [...base.results, ...extra.results].map((r) => ({ ...r, url: recordUrl(r.table, r.sysId) }));
  const { hits, commentOnly } = classifyUsage(results, name, { secret });
  const capped = [...(base.capped || []), ...extra.capped];
  return { name, hits, commentOnly, searched, capped, errors, masked: secret, summary: usageSummary({ name, hits, searched, capped, errors, commentOnly }) };
}

// --- This instance, this page --------------------------------------------------------------------------------------

/** Production or not, by the same rule every writer uses (policy.instanceGuard): only a positively identified dev, test or stage is not guarded. */
export function propertyGuard() {
  const info = getInstanceInfo();
  // `instance` is the name a person types to unlock a change on a guarded instance (writeUnlock in src/lib/properties.js).
  return { host: info.host, instance: info.instance, env: info.env, label: info.label, guarded: Boolean(info.guarded) };
}

/** The sys_properties record on screen, or null. Used when the panel was not handed the page context. */
export function propertyOnPage() {
  try {
    const page = parseTablePage(currentPageHref());
    return page.table === PROPERTY_TABLE && page.sysId ? { sysId: page.sysId } : null;
  } catch {
    return null;
  }
}

// --- Changes made from the panel -----------------------------------------------------------------------------------

export async function readChanges() {
  const res = await chrome.storage.local.get(CHANGES_KEY);
  return Array.isArray(res[CHANGES_KEY]) ? res[CHANGES_KEY] : [];
}

export async function saveChanges(list) {
  await chrome.storage.local.set({ [CHANGES_KEY]: Array.isArray(list) ? list : [] });
}

// --- Another instance ----------------------------------------------------------------------------------------------

/**
 * The same property on another instance (the cross-instance record compare): is the value the same? Only a sentence about
 * the value leaves here; a hidden property is never compared, and a value that looks like a credential is not passed on.
 */
export async function compareProperty({ sysId, host }) {
  const { property } = await getProperty({ sysId });
  if (!property) throw new Error('The property could not be read.');
  if (property.hidden) return { host, outcome: compareOutcome(property, { found: true, changes: [] }) };
  const remote = await compareWithInstance({ host, table: PROPERTY_TABLE, sysId });
  return { host: remote.host, matchedBy: remote.matchedBy || '', outcome: compareOutcome(property, { found: remote.found, changes: remote.changes || [] }) };
}

/** Merged into the services every sidebar panel receives (src/content/featureServices.js). */
export const propertyServices = {
  propertyExplorerSearch: (query) => searchProperties(query),
  propertyExplorerGet: (target) => getProperty(target),
  propertyExplorerRecent: () => recentProperties(),
  propertyExplorerSwitches: () => developerSwitches(),
  propertyExplorerUsage: (name) => findPropertyUsage(name),
  propertyExplorerGuard: async () => propertyGuard(),
  propertyExplorerUpdateSet: () => getCurrentUpdateSet(),
  propertyExplorerPage: async () => propertyOnPage(),
  propertyExplorerChanges: () => readChanges(),
  propertyExplorerSaveChanges: (list) => saveChanges(list),
  propertyExplorerCompare: (target) => compareProperty(target),
};

// Called once from src/content/featureStartup.js when the page loads (optional). Nothing needs to run at load.
export function install() {}
