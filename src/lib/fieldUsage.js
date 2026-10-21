// "Where is this field used?" (/usage incident.state): the pure half. No DOM, no network.
//
// A field name such as `state` appears in half the scripts on an instance, so the answer is only useful when it is
// narrowed to the table. Three ideas do that:
//   - an artifact bound to the table (or one of its parents) is a direct use;
//   - a script bound to nothing (Script Include, UI Script) is a likely use when it names the table, otherwise a possible one;
//   - an artifact bound to another table is left out, unless it names this table (a Business Rule on task_sla that
//     queries incident), and counted so the panel can say how many were left out.
//
// Each hit also says how the field is used (written, read, queried, changed on the form), because "who writes this"
// and "who only reads this" are different questions when something is going wrong with a value.
//
// The instance half is src/content/fieldUsage.js; the panel is src/sidebar/FieldUsagePanel.jsx.

import { stripComments } from './impact.js';

export const TABLE_RE = /^[a-z][a-z0-9_]{0,79}$/;
export const FIELD_RE = /^[a-z][a-z0-9_]{0,79}$/;

export const CERTAINTY_ORDER = { direct: 0, likely: 1, possible: 2 };
export const CERTAINTY_TEXT = {
  direct: 'On this table',
  likely: 'Names this table',
  possible: 'Might be another table',
};

/** Which column of a script table says which table it runs on (none: it runs everywhere). */
export const BOUND_COLUMN = {
  sys_script: 'collection',
  sys_script_client: 'table',
  sys_ui_action: 'table',
  sys_ui_policy: 'table',
  sys_security_acl: 'name',
};

export const KIND_ORDER = ['write', 'ui', 'query', 'read', 'mention'];
export const KIND_TEXT = {
  write: 'Sets it',
  ui: 'Changes it on the form',
  query: 'Queries or sorts on it',
  read: 'Reads it',
  mention: 'Mentions it',
};

/** "incident.state" or "incident state" (also "incident / state") -> { table, field }, or null. */
export function parseUsageTarget(text) {
  const parts = String(text || '')
    .trim()
    .toLowerCase()
    .split(/[\s.\/]+/)
    .filter(Boolean);
  if (parts.length !== 2) return null;
  const [table, field] = parts;
  return TABLE_RE.test(table) && FIELD_RE.test(field) ? { table, field } : null;
}

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The field as a whole word: `state` matches `current.state` and 'state', not `state_reason` or `estate`. */
export const fieldWord = (field) => new RegExp(`(?<![\\w$])${escapeRe(field)}(?![\\w$])`);

/**
 * How one line of script uses the field. The first of these that fits wins, in this order, because a line that both
 * reads and sets it matters most as a write.
 */
export function useKind(line, field) {
  const f = escapeRe(field);
  const text = String(line || '');
  if (new RegExp(`\\.\\s*${f}\\s*(?:=(?!=)|\\+=|-=)`).test(text)) return 'write';
  if (new RegExp(`\\.\\s*(?:setValue|setDisplayValue|setJournalEntry|setWorkflow)\\s*\\(\\s*['"]${f}['"]`).test(text)) return 'write';
  if (new RegExp(`\\.\\s*${f}\\s*\\.\\s*(?:setValue|setDisplayValue|setError)\\s*\\(`).test(text)) return 'write';
  if (new RegExp(`g_form\\s*\\.\\s*\\w+\\s*\\(\\s*['"]${f}['"]`).test(text) && !/g_form\s*\.\s*(?:getValue|getDisplayValue|getBooleanValue|getReference|getElement)\s*\(/.test(text)) {
    return /g_form\s*\.\s*(?:setValue|clearValue)\s*\(/.test(text) ? 'write' : 'ui';
  }
  if (new RegExp(`\\.\\s*(?:addQuery|addOrCondition|addNullQuery|addNotNullQuery|orderBy|orderByDesc|groupBy|addAggregate)\\s*\\(\\s*['"]${f}['"]`).test(text)) return 'query';
  if (new RegExp(`(?:^|[\\s'"^])(?:OR|NQ)?${f}(?=[=!<>A-Z]|[\\^'"]|$)`).test(text) && /addEncodedQuery|encodedQuery|setQuery|addQuery\s*\(\s*['"][^'"]*\^/.test(text)) return 'query';
  if (new RegExp(`\\.\\s*${f}\\b|(?:getValue|getDisplayValue|getElement|getBooleanValue|getReference|nil|changes|changesTo|changesFrom)\\s*\\(\\s*['"]${f}['"]`).test(text)) return 'read';
  return 'mention';
}

/**
 * Every line of a script that uses the field (comments ignored), each with how it is used.
 * @returns {Array<{ line: number, text: string, kind: string }>}
 */
export function scriptUses(source, field, max = 5) {
  const re = fieldWord(field);
  const lines = stripComments(String(source || '')).split('\n');
  const original = String(source || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length && out.length < max; i += 1) {
    if (!re.test(lines[i])) continue;
    const text = (original[i] || '').trim();
    out.push({ line: i + 1, text: text.length > 160 ? `${text.slice(0, 159)}…` : text, kind: useKind(lines[i], field) });
  }
  return out;
}

/** The strongest way the lines use the field (see KIND_ORDER), or '' for none. */
export function strongestKind(uses) {
  for (const kind of KIND_ORDER) if (uses.some((u) => u.kind === kind)) return kind;
  return '';
}

/** Does this script name the table in quotes (`new GlideRecord('incident')`, `current.getTableName() == 'incident'`)? */
export function namesTable(source, tables) {
  const text = stripComments(String(source || ''));
  return (tables || []).some((t) => new RegExp(`['"]${escapeRe(t)}['"]`).test(text));
}

/**
 * The table an artifact is bound to ('' when it runs everywhere). Code search gives the table in `scopeHint`,
 * except for ACLs, whose name is `table.field` or `table`.
 */
export function boundTable(artifactTable, hit) {
  if (!BOUND_COLUMN[artifactTable]) return '';
  const value = String((artifactTable === 'sys_security_acl' ? hit?.name : hit?.scopeHint) || '').trim();
  const table = artifactTable === 'sys_security_acl' ? value.split('.')[0] : value;
  return TABLE_RE.test(table) ? table : '';
}

/**
 * How a script hit relates to the table being asked about, or null when it does not (it is bound to a different
 * table and never names this one).
 * @param {string} artifactTable e.g. sys_script
 * @param {{ scopeHint?: string, name?: string, source?: string }} hit
 * @param {string[]} chain the table and its parents, nearest first
 */
export function certaintyFor(artifactTable, hit, chain) {
  const bound = boundTable(artifactTable, hit);
  if (bound) {
    if (chain.includes(bound)) return 'direct';
    return namesTable(hit.source, chain.slice(0, 1)) ? 'likely' : null;
  }
  return namesTable(hit.source, chain) ? 'likely' : 'possible';
}

/** ACLs that guard the field itself: `incident.state` and the same on each parent table. */
export function aclNames(chain, field) {
  return chain.map((t) => `${t}.${field}`);
}

/**
 * An encoded query mentions the field? `state=6^ORstateIN7` and `active=true^priority=1` do for `state` and
 * `priority`; `state_reason=x` does not for `state`.
 */
export function queryMentions(encoded, field) {
  return new RegExp(`(?:^|\\^)(?:OR|NQ)?${escapeRe(field)}(?=[=!<>A-Z]|\\^|$)`).test(String(encoded || ''));
}

/**
 * The places that are not scripts, as queries for the instance half to run. `keep` filters a row again, because
 * ServiceNow ignores a condition on a column it does not know and returns every row.
 */
export function configSources(chain, field) {
  const inChain = `IN${chain.join(',')}`;
  return [
    {
      id: 'ui_policy_action',
      label: 'UI Policy action',
      table: 'sys_ui_policy_action',
      query: `field=${field}^ui_policy.table${inChain}`,
      fields: ['sys_id', 'field', 'visible', 'mandatory', 'disabled', 'ui_policy', 'ui_policy.short_description', 'ui_policy.table', 'ui_policy.active'],
      keep: (row) => row.field === field && chain.includes(String(row['ui_policy.table'] || '')) && String(row['ui_policy.active'] ?? 'true') !== 'false',
      name: (row) => row['ui_policy.short_description'] || '(unnamed policy)',
      detail: (row) => ['visible', 'mandatory', 'disabled'].filter((k) => row[k] === 'true' || row[k] === 'false').map((k) => `${k} ${row[k] === 'true' ? 'on' : 'off'}`).join(', '),
      link: (row) => ({ table: 'sys_ui_policy', sysId: row.ui_policy }),
      kind: 'ui',
    },
    {
      id: 'client_onchange',
      label: 'Client Script (onChange)',
      table: 'sys_script_client',
      query: `active=true^type=onChange^field=${field}^table${inChain}`,
      fields: ['sys_id', 'name', 'table', 'type', 'field', 'active'],
      keep: (row) => row.field === field && row.type === 'onChange' && chain.includes(row.table) && row.active !== 'false',
      name: (row) => row.name || '(unnamed)',
      detail: (row) => `runs when ${field} changes`,
      kind: 'read',
    },
    {
      id: 'acl',
      label: 'ACL on the field',
      table: 'sys_security_acl',
      query: `active=true^nameIN${aclNames(chain, field).join(',')}`,
      fields: ['sys_id', 'name', 'operation', 'active'],
      keep: (row) => aclNames(chain, field).includes(row.name) && row.active !== 'false',
      name: (row) => row.name,
      detail: (row) => row.operation || '',
      kind: 'ui',
    },
    {
      id: 'data_policy',
      label: 'Data policy rule',
      table: 'sys_data_policy_rule',
      query: `field=${field}^table${inChain}`,
      fields: ['sys_id', 'field', 'table', 'mandatory', 'disabled'],
      keep: (row) => row.field === field && chain.includes(row.table),
      name: (row) => `${row.table}.${row.field}`,
      detail: (row) => ['mandatory', 'disabled'].filter((k) => row[k] === 'true').join(', ') || 'rule',
      kind: 'ui',
    },
    {
      id: 'dictionary_override',
      label: 'Dictionary override',
      table: 'sys_dictionary_override',
      query: `element=${field}^nameIN${chain.join(',')}`,
      fields: ['sys_id', 'name', 'element'],
      keep: (row) => row.element === field && chain.includes(row.name),
      name: (row) => `${row.name}.${row.element}`,
      detail: () => 'overrides the dictionary entry for this table',
      kind: 'ui',
    },
    {
      id: 'business_rule_filter',
      label: 'Business Rule filter condition',
      table: 'sys_script',
      query: `active=true^filter_conditionLIKE${field}^collectionIN${chain.join(',')}`,
      fields: ['sys_id', 'name', 'collection', 'when', 'filter_condition', 'active'],
      keep: (row) => chain.includes(row.collection) && row.active !== 'false' && queryMentions(row.filter_condition, field),
      name: (row) => row.name || '(unnamed)',
      detail: (row) => `${row.when || ''} when ${String(row.filter_condition || '').slice(0, 100)}`.trim(),
      kind: 'read',
    },
    {
      id: 'ui_policy_condition',
      label: 'UI Policy condition',
      table: 'sys_ui_policy',
      query: `active=true^conditionsLIKE${field}^tableIN${chain.join(',')}`,
      fields: ['sys_id', 'short_description', 'table', 'conditions', 'active'],
      keep: (row) => chain.includes(row.table) && row.active !== 'false' && queryMentions(row.conditions, field),
      name: (row) => row.short_description || '(unnamed policy)',
      detail: (row) => `applies when ${String(row.conditions || '').slice(0, 100)}`,
      kind: 'read',
    },
  ];
}

// --- Putting a report together ------------------------------------------------------------------------------

/**
 * Sorted, grouped report rows from script hits and config hits.
 * @param {Array} items { label, name, certainty, kind, uses, detail, url, source }
 */
export function sortItems(items) {
  return [...items].sort(
    (a, b) =>
      CERTAINTY_ORDER[a.certainty] - CERTAINTY_ORDER[b.certainty] ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.label.localeCompare(b.label) ||
      a.name.localeCompare(b.name),
  );
}

/** Counts by how the field is used, for the headline: { write: 3, read: 9 ... }. */
export function countByKind(items) {
  const counts = {};
  items.forEach((i) => {
    counts[i.kind] = (counts[i.kind] || 0) + 1;
  });
  return counts;
}

/** One line: "incident.state: 4 set it, 11 read it, 2 query it; 3 on the form". */
export function headline({ table, field }, items, { otherTables = 0, capped = [] } = {}) {
  const label = `${table}.${field}`;
  if (!items.length) return `Nothing found that uses ${label}${otherTables ? ` (${otherTables} on other tables were left out)` : ''}.`;
  const c = countByKind(items);
  const parts = [
    c.write && `${c.write} set it`,
    c.read && `${c.read} read it`,
    c.query && `${c.query} query or sort on it`,
    c.ui && `${c.ui} control it on the form`,
    c.mention && `${c.mention} mention it`,
  ].filter(Boolean);
  let text = `${label}: ${parts.join(', ')}`;
  if (otherTables) text += `. ${otherTables} more on other tables were left out`;
  if (capped.length) text += `. Only the first 100 matches were read in ${capped.join(', ')}`;
  return `${text}.`;
}

export function usageToMarkdown({ table, field }, items, note = '') {
  const lines = [`## Where ${table}.${field} is used`, ''];
  if (note) lines.push(note, '');
  if (!items.length) return `${lines.join('\n')}Nothing found.\n`;
  lines.push('| How | Where | Name | Detail |', '| --- | --- | --- | --- |');
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  items.forEach((i) => {
    const first = i.uses?.[0];
    const detail = first ? `${i.field || 'script'} line ${first.line}: ${first.text}` : i.detail || '';
    lines.push(`| ${cell(KIND_TEXT[i.kind])} | ${cell(i.label)} | ${cell(i.name)} | ${cell(detail)} |`);
  });
  return `${lines.join('\n')}\n`;
}

/** A prompt for the AI chat: the structured findings, and what to do with them. */
export function usagePrompt({ table, field }, items) {
  const rows = items
    .slice(0, 40)
    .map((i) => `- ${KIND_TEXT[i.kind]}: ${i.label} "${i.name}" (${CERTAINTY_TEXT[i.certainty]})${i.uses?.[0] ? ` line ${i.uses[0].line}: ${i.uses[0].text}` : i.detail ? `: ${i.detail}` : ''}`)
    .join('\n');
  return `These are the places on a ServiceNow instance that use the field ${table}.${field}.\n\n${rows}\n\nWhat would break if I changed the type, choices or length of ${field}? Which of these set it, and could two of them fight over the value? Keep it short and name the records.`;
}
