// Update set preview problems - the pure half. No DOM, no network.
//
// A RETRIEVED update set (sys_remote_update_set) that will not commit: after "Preview Update Set" the instance writes one
// sys_update_preview_problem row per problem. This module turns those rows into something a developer can act on:
//
//   - which columns of sys_update_preview_problem hold what (discovered from the dictionary, never assumed),
//   - what kind of problem a row is, from the instance's own wording, with a plain explanation, the safe way out and
//     the thing to check first,
//   - the searches that find which OTHER retrieved set creates a missing record (the "provider"),
//   - for a collision, how the local copy and the remote update compare,
//   - the verdict ("Ready to commit" / "Blocked by N problems"), a checklist, a commit order and a Markdown report.
//
// The instance half is src/content/previewProblems.js; the panel is src/sidebar/PreviewProblemsPanel.jsx.
//
// UNVERIFIED against a live instance (see docs/features/previewfix.md): the wording of the descriptions, the values of the
// status column, the update-name conventions used to find providers. Every classifier rule is a loose pattern, and a row
// that matches none is shown with the instance's own text and a generic explanation, never hidden.

import { parseUpdatePayload, parseUpdateName } from './updateSetReview.js';
import { redactSecrets } from '../providers/redact.js';

export const PROBLEM_TABLE = 'sys_update_preview_problem';
export const SET_TABLE = 'sys_remote_update_set';
export const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const IDENT_RE = /^[a-z][a-z0-9_]*$/;

// ---- cells ---------------------------------------------------------------------------------------------------------

/** The raw value of a Table API cell (a plain string, or { value, display_value } when display values were asked for). */
export const cellValue = (cell) => String(cell && typeof cell === 'object' ? cell.value ?? '' : cell ?? '');
/** The text a person sees for a cell. */
export const cellLabel = (cell) => String(cell && typeof cell === 'object' ? cell.display_value || cell.value || '' : cell ?? '');

// ---- which column is which -----------------------------------------------------------------------------------------

const ROLE_NAMES = {
  type: ['type', 'problem_type', 'category', 'kind'],
  description: ['description', 'message', 'short_description', 'details', 'problem', 'text'],
  status: ['status', 'state', 'resolution'],
  severity: ['severity', 'level'],
  set: ['remote_update_set', 'remote_set'],
  update: ['remote_update', 'update', 'sys_update_xml', 'update_xml'],
  // Confirmed live (2026-10-23): the platform records what is missing and what it offers on the problem itself.
  missingItem: ['missing_item'],
  missingItemTable: ['missing_item_table'],
  missingItemUpdate: ['missing_item_update'],
  actions: ['available_actions'],
};

/**
 * Work out which column of sys_update_preview_problem plays which role, from the dictionary rows
 * ([{ name, label, type, reference }], the shape fetchTableFields returns). A reference column is recognised by what it
 * points at (sys_remote_update_set, sys_update_xml) before its name is looked at.
 * Roles: set (REQUIRED: the retrieved update set), update (the remote update), type, description, status, severity.
 * @returns {{ ok: boolean, set: string, update: string, type: string, description: string, status: string, severity: string,
 *             otherUpdates: string[], columns: string[], missing: string[], found: Record<string,string> }}
 */
export function mapProblemColumns(fields = []) {
  const list = (fields || []).filter((f) => IDENT_RE.test(String(f?.name || '')));
  const names = new Set(list.map((f) => f.name));
  const byName = (candidates) => candidates.find((n) => names.has(n)) || '';
  const referencing = (table) => list.filter((f) => f.reference === table).map((f) => f.name);

  const setRefs = referencing(SET_TABLE);
  const set = setRefs.includes('remote_update_set') ? 'remote_update_set' : setRefs[0] || byName(ROLE_NAMES.set);

  // missing_item_update may also be a reference to sys_update_xml: it is the update that would PROVIDE the missing item,
  // never the update the problem is about.
  const updateRefs = referencing('sys_update_xml').filter((n) => !/^missing_item/.test(n));
  const update = updateRefs.find((n) => /remote/.test(n)) || updateRefs[0] || byName(ROLE_NAMES.update);
  const otherUpdates = updateRefs.filter((n) => n !== update);

  const byLabel = (re) => list.find((f) => re.test(String(f.label || '')))?.name || '';
  const type = byName(ROLE_NAMES.type) || byLabel(/^type$/i);
  const description = byName(ROLE_NAMES.description) || byLabel(/descr|message/i);
  const status = byName(ROLE_NAMES.status) || byLabel(/^(status|state)$/i);
  const severity = byName(ROLE_NAMES.severity);
  const missingItem = byName(ROLE_NAMES.missingItem);
  const missingItemTable = byName(ROLE_NAMES.missingItemTable);
  const missingItemUpdate = byName(ROLE_NAMES.missingItemUpdate);
  const actions = byName(ROLE_NAMES.actions);

  const found = { set, update, type, description, status, severity, missingItem, missingItemTable, missingItemUpdate, actions };
  const columns = [...new Set(['sys_id', set, update, type, description, status, severity, missingItem, missingItemTable, missingItemUpdate, actions, 'sys_created_on', 'sys_updated_on', 'sys_updated_by'].filter(Boolean))];
  const missing = Object.entries(found)
    .filter(([, name]) => !name)
    .map(([role]) => role);
  return { ok: Boolean(set), ...found, otherUpdates, columns, missing, found };
}

/** What each missing role costs, in words for the panel ("Could not check ..."). */
export const MISSING_ROLE_TEXT = {
  set: 'No column links a problem to its retrieved update set, so the problems cannot be listed.',
  update: 'No column links a problem to its remote update, so the update behind each problem (and the record it changes) is not shown.',
  type: 'No type column was found, so problems are classified from their description alone.',
  description: 'No description column was found, so problems cannot be explained from the instance\'s wording; only the type and update are shown.',
  status: 'No status column was found, so every problem is treated as unresolved.',
  severity: '',
  // Optional: without them the missing record is found from the description and the remote update instead.
  missingItem: '',
  missingItemTable: '',
  missingItemUpdate: '',
  actions: '',
};

/**
 * What the platform offers for one problem (sys_update_preview_problem.available_actions), as it gave it: the display
 * value when it has one (a list of named actions), else the raw value. Ids that cannot be named are only counted, never
 * turned into a guessed button name. UNVERIFIED: the format of the value (no retrieved set existed on the PDI).
 * @returns {{ names: string[], ids: number } | null} null when the column is not there or is empty
 */
export function platformActions(cell) {
  const value = cellValue(cell).trim();
  const label = cellLabel(cell).trim();
  const source = label && label !== value ? label : value;
  const tokens = source.split(',').map((s) => s.trim()).filter(Boolean);
  if (!tokens.length) return null;
  return {
    names: [...new Set(tokens.filter((t) => !SYS_ID_RE.test(t)).map((t) => t.slice(0, 60)))].slice(0, 8),
    ids: tokens.filter((t) => SYS_ID_RE.test(t)).length,
  };
}

/** "The platform offers: ..." for a card, the next step and the report, or ''. */
export function offersText(actions) {
  if (!actions) return '';
  if (actions.names.length) return `The problem record offers: ${actions.names.join(', ')}${actions.ids ? ` (and ${actions.ids} more given only by id)` : ''}.`;
  if (actions.ids) return `The problem record lists ${actions.ids} action${actions.ids === 1 ? '' : 's'} by id only: open it to see ${actions.ids === 1 ? 'it' : 'them'}.`;
  return '';
}

// ---- rows -> problems ----------------------------------------------------------------------------------------------

/**
 * 'unresolved' | 'skipped' | 'ignored' | 'accepted' | 'resolved' | 'unknown' from the status column's value and label.
 * "Ignored" is kept apart from "skipped": on the releases this was written against, Accept remote update is believed to
 * record the status "ignored" (the problem is set aside and the update IS committed), so reading it as a skip would tell
 * the developer the opposite of what happens. UNVERIFIED; see docs/features/previewfix.md.
 */
export function statusKind(value, label = '') {
  const text = `${label} ${value}`.toLowerCase().trim();
  if (!text) return 'unresolved';
  if (/unresolved|not resolved|outstanding|\bopen\b|\bnew\b|pending|to do/.test(text)) return 'unresolved';
  if (/skip/.test(text)) return 'skipped';
  if (/ignor/.test(text)) return 'ignored';
  if (/accept/.test(text)) return 'accepted';
  if (/resolv|fixed|done|complete|closed|clear/.test(text)) return 'resolved';
  return 'unknown';
}

/** What an already-dealt-with problem means for the commit. */
export const STATUS_EFFECT = {
  skipped: 'Skipped: this update is left out of the commit and the local record stays as it is.',
  accepted: 'Accepted: the remote version is applied at commit, replacing the local one where they differ.',
  resolved: 'Resolved: the instance no longer treats this as a problem.',
  ignored: 'Ignored: the problem no longer blocks the commit. Accept remote update normally records this status, which means the remote version is applied at commit. Open the problem record if you need to be sure which button was pressed.',
};

export const STATUS_TEXT = { unresolved: 'Unresolved', skipped: 'Skipped', ignored: 'Ignored', accepted: 'Accepted', resolved: 'Resolved', unknown: 'Status unclear' };
/** Unknown statuses count as unresolved: it is safer to over-report a blocker than to say "ready" wrongly. */
export const isOpen = (kind) => kind === 'unresolved' || kind === 'unknown';

const SEVERITY_RE = /^(error|warning|warn|info|information|notice)$/i;
function severityOf(...texts) {
  for (const t of texts) {
    const m = SEVERITY_RE.exec(String(t || '').trim());
    if (m) return m[1].toLowerCase().startsWith('warn') ? 'warning' : m[1].toLowerCase().startsWith('error') ? 'error' : 'info';
  }
  return '';
}

/**
 * One Table API row of sys_update_preview_problem (read with display values) -> a plain problem object.
 * @param {object} row
 * @param {ReturnType<typeof mapProblemColumns>} map
 */
export function normalizeProblem(row, map) {
  const r = row || {};
  const typeLabel = map.type ? cellLabel(r[map.type]) : '';
  const statusValue = map.status ? cellValue(r[map.status]) : '';
  const statusLabel = map.status ? cellLabel(r[map.status]) : '';
  const rawUpdate = map.update ? r[map.update] : null;
  const cell = (role) => (map[role] ? r[map[role]] : undefined);
  const missingId = cellValue(cell('missingItem')).trim().toLowerCase();
  const missingTable = cellValue(cell('missingItemTable')).trim().toLowerCase();
  // A reference to sys_update_xml (a sys_id) or the update's name ("<table>_<sys_id>"); both are handled.
  const missingUpdate = cellValue(cell('missingItemUpdate')).trim();
  return {
    // What the instance itself recorded as missing; validated, because these values reach queries and links.
    missing: {
      sysId: SYS_ID_RE.test(missingId) ? missingId : '',
      table: IDENT_RE.test(missingTable) ? missingTable : '',
      updateId: SYS_ID_RE.test(missingUpdate) ? missingUpdate.toLowerCase() : '',
      updateName: !SYS_ID_RE.test(missingUpdate) && /^[a-z0-9_]{3,200}$/i.test(missingUpdate) ? missingUpdate : '',
      updateLabel: missingUpdate ? cellLabel(cell('missingItemUpdate')).slice(0, 200) : '',
    },
    actions: map.actions ? platformActions(cell('actions')) : null,
    sysId: cellValue(r.sys_id),
    setId: map.set ? cellValue(r[map.set]) : '',
    typeLabel,
    // Shown, copied and sent to the assistant, so anything that looks like a secret assignment is masked.
    description: map.description ? redactSecrets(cellLabel(r[map.description]).trim()) : '',
    statusValue,
    statusLabel,
    status: statusKind(statusValue, statusLabel),
    severity: severityOf(typeLabel, map.severity ? cellLabel(r[map.severity]) : ''),
    updateId: SYS_ID_RE.test(cellValue(rawUpdate)) ? cellValue(rawUpdate) : '',
    updateLabel: rawUpdate ? cellLabel(rawUpdate) : '',
    createdOn: cellValue(r.sys_created_on),
    updatedOn: cellValue(r.sys_updated_on),
    updatedBy: cellValue(r.sys_updated_by),
  };
}

// ---- what kind of problem is it ------------------------------------------------------------------------------------

// What the platform's own buttons do, in one place (used in every explanation).
export const ACTIONS = {
  accept: 'Accept remote update: the remote version is applied at commit, replacing the local one where they differ.',
  skip: 'Skip remote update: this one update is left out of the commit. Nothing is deleted; the local record stays as it is.',
  preview: 'Preview Update Set (on the retrieved update set): runs the check again. A problem that no longer applies disappears.',
};

// skipSafety: 'safe' = skipping loses nothing real, 'depends' = fine only after a check, 'risky' = skipping probably breaks something.
export const KINDS = {
  missing_reference: {
    label: 'Missing reference',
    short: 'Points at a record that is not on this instance',
    meaning: 'A record in this update set points at another record (by its sys_id) that does not exist on this instance.',
    why: 'What it points at was created on the source instance but has not arrived here. Usually that is a dependency in another update set that is not committed yet, a record the author forgot to capture, or data (users, groups, CIs) that update sets do not carry.',
    wayOut: 'Find where the missing record comes from. If another retrieved update set creates it, commit that set first and press Preview Update Set on this one again: the problem clears itself. If nothing provides it, ask the author to add the record to the set (or create it here), then retrieve the set again. Skip only when you know the pointer is optional.',
    checkFirst: 'Open the remote update, find which field holds the sys_id, and search for that sys_id on this instance.',
    action: 'Commit the provider first, then Preview Update Set again. Skip remote update drops only this update; Accept remote update applies it with the pointer unresolved.',
    skipSafety: 'risky',
  },
  collision: {
    label: 'Newer local version',
    short: 'Changed here after the remote version was made',
    meaning: 'The record already exists on this instance and has a local change that is newer than (or different from) the version in this update set. Committing would overwrite the local work.',
    why: 'Someone edited the record on this instance after the source made its version, or another update set already put a different version of it here.',
    wayOut: 'Compare the two versions. If the remote one is the one you want, Accept remote update (the old local version stays in the record\'s version history). If the local one is right, or already contains the change, Skip remote update. If both have wanted changes, skip it and re-apply the remote change by hand.',
    checkFirst: 'Who changed it here, and when, compared with the remote update\'s own timestamp.',
    action: 'Accept remote update to overwrite the local copy, or Skip remote update to keep it.',
    skipSafety: 'depends',
  },
  missing_table: {
    label: 'Missing table',
    short: 'A table the update needs does not exist here',
    meaning: 'The update belongs to a table that does not exist on this instance, so it cannot be applied.',
    why: 'The table is created by an application, plugin or another update set that has not been installed or committed here yet.',
    wayOut: 'Install the application or plugin that owns the table, or commit the update set that creates it, then preview again. Do not accept: the platform has nothing to attach the record to.',
    checkFirst: 'Which application owns the table, and whether it is installed and active on this instance.',
    action: 'Fix the dependency, then Preview Update Set again. Skip remote update only if you do not want any record of that table.',
    skipSafety: 'risky',
  },
  missing_column: {
    label: 'Missing column',
    short: 'A column the update fills in does not exist here',
    meaning: 'The update sets a column that is not defined on that table on this instance.',
    why: 'The column was added on the source (in this or another update set, or by a plugin) and has not reached this instance, or it exists under a different name here.',
    wayOut: 'Bring the column over first: commit the update set that adds the dictionary entry (the provider below, if one was found), or add the column here. Then preview again.',
    checkFirst: 'Whether the column exists on the table here under a slightly different name, and which set adds the dictionary entry.',
    action: 'Commit the set that adds the column, then Preview Update Set again.',
    skipSafety: 'risky',
  },
  missing_app: {
    label: 'Application or plugin missing',
    short: 'The application or plugin behind this update is not here',
    meaning: 'The update belongs to an application, plugin or scope that is not installed or not active on this instance.',
    why: 'The source instance has an application or plugin that this one lacks, or it is installed at another scope or is inactive.',
    wayOut: 'Install and activate the application or plugin (or the version this set was built against), then preview again. If you do not use that application at all, skipping the updates that belong to it is fine.',
    checkFirst: 'The scope or plugin name in the text, and whether it is installed and active under System Applications.',
    action: 'Install the application first, then Preview Update Set again. Skip remote update when you intentionally do not use the application.',
    skipSafety: 'depends',
  },
  unknown_type: {
    label: 'Unknown update type',
    short: 'The instance does not recognise this kind of record',
    meaning: 'The instance does not know the type of record this update contains, so it cannot apply it.',
    why: 'The record type comes from a plugin or release feature that this instance does not have, usually because the source instance is on a newer release or has a plugin that is not activated here.',
    wayOut: 'Compare the release and active plugins of the two instances. If this instance should have the feature, activate it and preview again. If it should not, skip these updates: they would be inert here anyway.',
    checkFirst: 'The update type named in the text, and the release of the source instance compared with this one.',
    action: 'Activate the missing plugin and preview again, or Skip remote update.',
    skipSafety: 'depends',
  },
  local_deleted: {
    label: 'Deleted here',
    short: 'The record was deleted on this instance',
    meaning: 'The update changes a record that was deleted on this instance.',
    why: 'Someone deleted the record here on purpose, or an earlier update set deleted it.',
    wayOut: 'If the deletion was intended, Skip remote update. If the record should exist, Accept remote update: it comes back as the remote version.',
    checkFirst: 'Who deleted it and why (the record\'s version history and the Deleted Records list show it).',
    action: 'Skip remote update to keep it deleted, Accept remote update to bring it back.',
    skipSafety: 'depends',
  },
  delete_missing: {
    label: 'Delete of a record that is not here',
    short: 'Deletes a record that is already gone',
    meaning: 'The update deletes a record that does not exist on this instance.',
    why: 'The record was never moved here, or it was already deleted.',
    wayOut: 'There is nothing to delete, so skipping loses nothing.',
    checkFirst: 'That you did not expect the record to be here: if you did, an earlier set is missing.',
    action: 'Skip remote update.',
    skipSafety: 'safe',
  },
  protected: {
    label: 'Protected record',
    short: 'The platform will not let this record be changed',
    meaning: 'The record is protected (read-only, locked or owned by the platform), so the update cannot change it.',
    why: 'Out-of-box records and some application records are protected so that customisations do not break upgrades.',
    wayOut: 'Do not try to force it. Skip remote update, and make the change through the supported route (a customer-owned copy, or the application\'s own settings).',
    checkFirst: 'Whether the record is a baseline record, and whether the application is licensed to be customised.',
    action: 'Skip remote update.',
    skipSafety: 'depends',
  },
  older_version: {
    label: 'Application version older',
    short: 'The set was built for an older application version',
    meaning: 'The update comes from an older application version than the one installed here.',
    why: 'The set was retrieved from an instance that has not upgraded the application as far as this one.',
    wayOut: 'Do not downgrade by accident: skip updates that would replace newer application files with older ones, or retrieve the set from an instance on the same version.',
    checkFirst: 'The application versions on both instances.',
    action: 'Skip remote update, or get a set built on the right version.',
    skipSafety: 'depends',
  },
  generic: {
    label: 'Other problem',
    short: 'NowBuddy has no specific explanation for this one',
    meaning: 'The instance reported a problem that NowBuddy does not have a specific explanation for. The instance\'s own wording above is the authority.',
    why: 'It is a type of problem this tool has not seen, or the wording differs on this release.',
    wayOut: 'Open the problem and its remote update and read what they say. Skip remote update leaves this update out; Accept remote update applies it anyway. If you are unsure, ask the author of the update set before you decide.',
    checkFirst: 'Open the remote update and the record it targets, and check that the target exists and that you can read it.',
    action: 'Open the problem record and choose Accept remote update or Skip remote update after reading it.',
    skipSafety: 'depends',
  },
};

/** The order problems are listed in: what has to be fixed outside this set first. */
export const KIND_ORDER = ['missing_reference', 'missing_table', 'missing_column', 'missing_app', 'unknown_type', 'older_version', 'collision', 'local_deleted', 'protected', 'generic', 'delete_missing'];

// Order matters: the first rule that matches wins, so the narrow ones come first. The `type` column is tried before the description.
const RULES = [
  ['delete_missing', /(delet|remov)[^.]{0,60}(does not exist|doesn'?t exist|not found|already (been )?(deleted|removed|gone)|no longer exist)|nothing to delete/],
  ['local_deleted', /(deleted|removed)\s+(locally|on this instance|from this instance|here)|local\w*\s+(record|copy|version)?\s*(was|has been|is)\s+deleted|record (was )?deleted (locally|here)|deleted (in|on) (the )?(target|local)/],
  ['unknown_type', /unknown\s+(update\s+|record\s+|entity\s+)?type|unsupported\s+(update\s+|record\s+)?type|unrecogni[sz]ed\s+(update\s+|record\s+)?type|no\s+(handler|processor)\s+(for|found)|type\b[^.]{0,30}(is not|isn'?t|not)\s+(supported|recogni[sz]ed|known)/],
  ['older_version', /(application|app|plugin|package)\s+version[^.]{0,60}(older|lower|earlier|downgrad)|downgrad|(older|lower|earlier)\s+(application\s+)?version\s+than/],
  ['missing_app', /(application|app|plugin|scope|store app)\b.{0,80}(is not|isn'?t|not|has not been|hasn'?t been|was not|missing|could not|cannot).{0,20}(installed|active|activated|found|available|present|exist)|(missing|unknown|unavailable|inactive|uninstalled)\s+(application|app|plugin|scope)|requires?\s+(the\s+)?(application|plugin|app)\b/],
  ['missing_reference', /(could not|cannot|can'?t|unable to|did not|didn'?t|not able to)\s+(be\s+)?(find|found|resolve|locate)\s+(a |the |an? )?(record|referenced|reference|row)|missing\s+reference|reference[^.]{0,60}(not found|does not exist|doesn'?t exist|cannot be resolved|could not be resolved|unresolved|is missing)|(refers|points|pointing) to (a |an |the )?(record|missing|non-?existent)|(record|sys_id)[^.]{0,60}(not found|does not exist|doesn'?t exist|is missing|no longer exists)/],
  ['missing_column', /(could not|cannot|can'?t|unable to)\s+find\s+(a |the )?(table\s+)?(field|column)\b|(field|column|element|dictionary entry|attribute)\b[^.]{0,60}(does not exist|doesn'?t exist|not found|is missing|unknown|no such|not defined|cannot be found)|(missing|unknown|no such|nonexistent|undefined)\s+(field|column)/],
  ['missing_table', /(could not|cannot|can'?t|unable to)\s+find\s+(a |the )?table\b|(table|class)\b[^.]{0,50}(does not exist|doesn'?t exist|not found|is missing|is unknown|no such|not defined|could not be found|cannot be found)|(missing|unknown|no such|nonexistent|undefined)\s+table|\bno table\b/],
  ['protected', /protected|read[- ]only|sys_policy|cannot be (modified|changed|overwritten|updated)|not allowed to (modify|change|update)|\blocked\b/],
  ['collision', /collision|conflict|newer|more recent|later than|changed (locally|on this instance)|modified (locally|since|after)|local\w*\s+(update|version|record|copy|change)s?\b[^.]{0,40}(exists?|already|differs?|changed|modified)|older than (the )?local|remote\b[^.]{0,30}\bolder/],
];

/** @returns {{ kind: string, by: 'type'|'description'|'none' }} */
export function classifyProblem(problem) {
  const type = String(problem?.typeLabel || '').toLowerCase();
  const text = String(problem?.description || '').toLowerCase();
  if (type && !SEVERITY_RE.test(type.trim())) {
    for (const [kind, re] of RULES) if (re.test(type)) return { kind, by: 'type' };
  }
  for (const [kind, re] of RULES) if (re.test(text)) return { kind, by: 'description' };
  return { kind: 'generic', by: 'none' };
}

/** Explanation record for a kind; an unknown kind gets the generic one. */
export const kindInfo = (kind) => KINDS[kind] || KINDS.generic;

// ---- what does the text name ---------------------------------------------------------------------------------------

/**
 * Identifiers named in a problem's description: sys_ids (not counting the record the update itself is about), tables and
 * columns. Loose on purpose; the provider search only runs on what was found.
 * @returns {{ sysIds: string[], tables: string[], columns: Array<{table: string, element: string}> }}
 */
export function extractClues(description, { selfIds = [] } = {}) {
  const text = String(description || '');
  const skip = new Set(selfIds.map((s) => String(s).toLowerCase()));
  const sysIds = [...new Set((text.match(/[0-9a-f]{32}/gi) || []).map((s) => s.toLowerCase()))].filter((s) => !skip.has(s));

  const tables = new Set();
  const columns = [];
  const refs = [];
  const addTable = (t) => {
    const name = String(t || '').toLowerCase();
    if (IDENT_RE.test(name) && name.length > 2 && !/^(the|and|for|with|this|that|record|field|column|table|from|does|not)$/.test(name)) tables.add(name);
  };
  // The platform's usual wording for a missing reference names the table and the column that holds the pointer, but not
  // the sys_id: "Could not find a record in sys_user_group for column assignment_group referenced in this update". The
  // sys_id is then read from the remote update itself (referencedIds below).
  [...text.matchAll(/\brecord in\s+(?:table\s+)?['"`]?([a-z][a-z0-9_]*)['"`]?\s+for\s+(?:the\s+)?(?:column|field)\s+['"`]?([a-z][a-z0-9_]*)/gi)].forEach((m) => {
    addTable(m[1]);
    if (!refs.some((r) => r.table === m[1].toLowerCase() && r.column === m[2].toLowerCase())) refs.push({ table: m[1].toLowerCase(), column: m[2].toLowerCase() });
  });
  [...text.matchAll(/\btable\s+['"`[(]?([a-z][a-z0-9_]*)/gi)].forEach((m) => addTable(m[1]));
  [...text.matchAll(/['"`[(]([a-z][a-z0-9_]*)['"`\])]\s+table\b/gi)].forEach((m) => addTable(m[1]));
  const addColumn = (t, e) => {
    const table = t.toLowerCase();
    const element = e.toLowerCase();
    addTable(table);
    if (!columns.some((c) => c.table === table && c.element === element)) columns.push({ table, element });
  };
  // table.column written the way the platform writes it
  [...text.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\.([a-z][a-z0-9_]*)\b/gi)].forEach((m) => addColumn(m[1], m[2]));
  // (incident.u_cost_center): in brackets the table needs no underscore ("Could not find a table field (incident.u_x)")
  [...text.matchAll(/[([]([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)[)\]]/gi)].forEach((m) => addColumn(m[1], m[2]));
  // "field 'u_x' ... table 'incident'" in either order
  const fieldMatch = /\b(?:field|column|element)\s+['"`[(]?([a-z][a-z0-9_]*)(?![a-z0-9_.])/i.exec(text);
  if (fieldMatch && tables.size === 1 && !refs.length && !columns.some((c) => c.element === fieldMatch[1].toLowerCase())) {
    columns.push({ table: [...tables][0], element: fieldMatch[1].toLowerCase() });
  }
  return refs.length ? { sysIds, tables: [...tables], columns, refs } : { sysIds, tables: [...tables], columns };
}

/**
 * The sys_ids a remote update holds in one column (any record of the payload; a list column holds several). Used when
 * the problem text names the column but not the sys_id of the missing record. Nothing else of the payload is kept.
 */
export function referencedIds(payloadXml, column) {
  if (!payloadXml || !IDENT_RE.test(String(column || ''))) return [];
  let parsed;
  try {
    parsed = parseUpdatePayload(payloadXml);
  } catch {
    return [];
  }
  const out = new Set();
  parsed.records.forEach((r) => {
    String(r.fields?.[column] ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => SYS_ID_RE.test(s))
      .forEach((s) => out.add(s));
  });
  return [...out].slice(0, 5);
}

/** Tables whose rows are data, which update sets normally do not carry. */
const DATA_TABLE = /^(sys_user|sys_user_group|sys_user_grmember|sys_user_has_role|core_company|cmn_location|cmn_department|cmn_cost_center|cmdb_ci\w*|cmdb_rel_ci|task|incident|problem|change_request|change_task|sc_request|sc_req_item|sc_task|sn_customerservice_case|kb_knowledge)$/;
export const isDataTable = (table) => DATA_TABLE.test(String(table || ''));

// ---- finding the provider ------------------------------------------------------------------------------------------

/**
 * The searches that could find which update creates what a problem is missing, as plain descriptions (the instance half
 * runs them). Only missing references, tables and columns have providers.
 *   id:<sys_id>          an update whose name holds the sys_id ("<table>_<sys_id>")
 *   col:<table>.<column>  the dictionary entry of a column ("sys_dictionary_<table>_<column>")
 *   tbl:<table>           dictionary entries of a table ("sys_dictionary_<table>_...", probable only)
 *   upd:<sys_id>          the update the instance itself names in missing_item_update (by sys_id)
 *   uname:<name>          the same, when the column holds the update's name
 */
export function searchesFor(problem) {
  const clues = problem.clues || { sysIds: [], tables: [], columns: [] };
  const out = [];
  const named = problem.missing || {};
  if (PROVIDER_KINDS.includes(problem.kind)) {
    // The instance's own answer comes first.
    if (named.updateId) out.push({ key: `upd:${named.updateId}`, mode: 'upd', updateId: named.updateId, strength: 'exact' });
    else if (named.updateName) out.push({ key: `uname:${named.updateName.toLowerCase()}`, mode: 'uname', name: named.updateName.toLowerCase(), strength: 'exact' });
  }
  if (problem.kind === 'missing_reference') {
    clues.sysIds.forEach((sysId) => out.push({ key: `id:${sysId}`, mode: 'id', sysId, strength: 'exact' }));
  }
  if (problem.kind === 'missing_column') {
    clues.columns.forEach((c) => out.push({ key: `col:${c.table}.${c.element}`, mode: 'col', table: c.table, element: c.element, strength: 'exact' }));
  }
  if (problem.kind === 'missing_table') {
    clues.tables.forEach((table) => out.push({ key: `tbl:${table}`, mode: 'tbl', table, strength: 'probable' }));
  }
  return out;
}

/** Every distinct search for a list of problems, capped. */
export function providerSearches(problems, cap = 30) {
  const seen = new Map();
  problems.forEach((p) => searchesFor(p).forEach((s) => seen.set(s.key, s)));
  const all = [...seen.values()];
  return { searches: all.slice(0, cap), skipped: all.slice(cap), capped: all.length > cap, total: all.length };
}

/** Encoded query for one search, over the retrieved sets in `setIds` (the column that links a remote update to its set). */
export function providerQuery(search, setIds = [], setColumn = 'remote_update_set') {
  const ids = setIds.filter((id) => SYS_ID_RE.test(id));
  if (!ids.length) throw new Error('No retrieved update sets to search.');
  const base = `${setColumn}IN${ids.join(',')}`;
  if (search.mode === 'id') {
    if (!SYS_ID_RE.test(search.sysId || '')) throw new Error('Not a sys_id.');
    return `${base}^nameLIKE${search.sysId}`;
  }
  if (search.mode === 'col') {
    if (!IDENT_RE.test(search.table || '') || !IDENT_RE.test(search.element || '')) throw new Error('Not a column.');
    return `${base}^name=sys_dictionary_${search.table}_${search.element}`;
  }
  if (search.mode === 'tbl') {
    if (!IDENT_RE.test(search.table || '')) throw new Error('Not a table.');
    return `${base}^nameSTARTSWITHsys_dictionary_${search.table}_`;
  }
  if (search.mode === 'upd') {
    if (!SYS_ID_RE.test(search.updateId || '')) throw new Error('Not a sys_id.');
    return `${base}^sys_id=${search.updateId}`;
  }
  if (search.mode === 'uname') {
    if (!/^[a-z0-9_]{3,200}$/i.test(search.name || '')) throw new Error('Not an update name.');
    return `${base}^name=${search.name}`;
  }
  throw new Error('Unknown search.');
}

/** Does an update row from another set really answer this search? (The instance query is loose; this is exact.) */
export function rowMatchesSearch(search, row) {
  const name = String(row?.name || '').toLowerCase();
  if (search.mode === 'id') return name.includes(String(search.sysId).toLowerCase());
  if (search.mode === 'col') return name === `sys_dictionary_${search.table}_${search.element}`;
  if (search.mode === 'tbl') {
    // "sys_dictionary_<other table>_null" is another table's own entry (u_x_y for a search on u_x), never a column of this one.
    return name === `sys_dictionary_${search.table}_null` || (name.startsWith(`sys_dictionary_${search.table}_`) && !name.endsWith('_null'));
  }
  if (search.mode === 'upd') return String(row?.sysId || '').toLowerCase() === search.updateId;
  if (search.mode === 'uname') return name === search.name;
  return false;
}

/**
 * How sure a matching row is. A table search is exact only for the table's own dictionary entry
 * ("sys_dictionary_<table>_null", written when the table is created); any other entry with the prefix only adds a column,
 * and the prefix of u_x also matches the columns of a table u_x_y, so those stay "probable".
 */
const rowStrength = (search, row) => (search.mode === 'tbl' ? (String(row?.name || '').toLowerCase() === `sys_dictionary_${search.table}_null` ? 'exact' : 'probable') : search.strength);

/** Providers this analysis is sure of (an exact match in another set). Probable ones are shown, never acted on. */
const sureProviders = (problem) => (problem.providers || []).filter((x) => !x.own && x.strength !== 'probable');

/**
 * The retrieved sets that create what a problem is missing.
 * @param {object} problem  a prepared problem (kind, clues)
 * @param {Record<string, Array<{name: string, target: string, type: string, setId: string}>>} rowsByKey results per search key
 * @param {Map<string,{name: string, state: string}>|Record<string,{name: string, state: string}>} setsById
 * @param {string} ownSetId
 * @returns {Array<{ setId: string, setName: string, setState: string, own: boolean, strength: 'exact'|'probable', updates: Array<{name: string, target: string, type: string}> }>}
 */
export function matchProviders(problem, rowsByKey = {}, setsById = {}, ownSetId = '') {
  const lookup = (id) => (setsById instanceof Map ? setsById.get(id) : setsById[id]) || {};
  const found = new Map();
  searchesFor(problem).forEach((search) => {
    (rowsByKey[search.key] || []).forEach((row) => {
      if (!rowMatchesSearch(search, row) || !SYS_ID_RE.test(String(row.setId || ''))) return;
      const strength = rowStrength(search, row);
      const entry = found.get(row.setId) || { setId: row.setId, setName: lookup(row.setId).name || row.setId, setState: lookup(row.setId).state || '', own: row.setId === ownSetId, strength, updates: [] };
      if (strength === 'exact') entry.strength = 'exact';
      if (entry.updates.length < 3 && !entry.updates.some((u) => u.name === row.name)) entry.updates.push({ name: row.name, target: row.target || '', type: row.type || '' });
      found.set(row.setId, entry);
    });
  });
  return [...found.values()].sort((a, b) => Number(a.own) - Number(b.own) || (a.strength === b.strength ? 0 : a.strength === 'exact' ? -1 : 1) || a.setName.localeCompare(b.setName));
}

// ---- collisions ----------------------------------------------------------------------------------------------------

// A stored glide_date_time: "2026-10-18 14:02:00", always UTC. Anything else (a display value in the viewer's own format
// and time zone) is not compared, because reading it as UTC would shift it by the viewer's offset.
const STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const parseStamp = (text) => {
  const t = String(text || '').trim();
  if (!STAMP_RE.test(t)) return NaN;
  return Date.parse(`${t.replace(' ', 'T')}Z`);
};

function gapText(ms) {
  const minutes = Math.round(Math.abs(ms) / 60000);
  if (minutes < 2) return 'about the same time';
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/** The author and time stored inside a remote update's payload (the record's own sys_updated_on / sys_updated_by), or null. */
export function payloadStamp(payloadXml) {
  if (!payloadXml) return null;
  const parsed = parseUpdatePayload(payloadXml);
  const main = parsed.records.find((r) => r.tag === parsed.table) || parsed.records[0];
  if (!main) return null;
  const updatedOn = String(main.fields.sys_updated_on || '').trim();
  const updatedBy = String(main.fields.sys_updated_by || '').trim();
  return updatedOn || updatedBy ? { updatedOn, updatedBy } : null;
}

/**
 * How the local copy of a record compares with the remote update. Everything is optional: a part that could not be read
 * is simply left out of the text.
 * @param {{ record?: {found?: boolean, updatedOn?: string, updatedBy?: string, error?: string}|null,
 *           localUpdates?: Array<{updatedOn: string, updatedBy: string, setName?: string}>,
 *           versions?: Array<{at: string, by: string, source?: string}>,
 *           remote?: {updatedOn?: string, updatedBy?: string}|null }} input
 */
export function buildCollision({ record = null, localUpdates = [], versions = [], remote = null } = {}) {
  const lastVersion = versions[0] || null;
  const lastUpdate = localUpdates[0] || null;
  let localState = 'unknown';
  if (record?.found === true) localState = 'found';
  else if (record?.found === false) localState = 'deleted';

  const localAt = (record?.found ? record.updatedOn : '') || lastVersion?.at || lastUpdate?.updatedOn || '';
  const localBy = (record?.found ? record.updatedBy : '') || lastVersion?.by || lastUpdate?.updatedBy || '';
  const remoteAt = remote?.updatedOn || '';
  const remoteBy = remote?.updatedBy || '';

  let relation = 'unknown';
  let gap = '';
  const lt = parseStamp(localAt);
  const rt = parseStamp(remoteAt);
  if (Number.isFinite(lt) && Number.isFinite(rt)) {
    const diff = lt - rt;
    if (Math.abs(diff) < 60000) relation = 'same';
    else relation = diff > 0 ? 'local-newer' : 'remote-newer';
    gap = gapText(diff);
  }

  // Every stamp here is the stored value (the Table API without display values, and the payload), which is UTC; the
  // text says so, because the platform's own forms show the viewer's time zone.
  const when = (t) => (!t ? 'at an unknown time' : STAMP_RE.test(t) ? `${t} UTC` : t);
  const lines = [];
  if (localState === 'deleted') {
    lines.push(`The record no longer exists here (or your user cannot read it)${lastVersion ? `; its last version was recorded ${when(lastVersion.at)}${lastVersion.by ? ` by ${lastVersion.by}` : ''}` : ''}.`);
  } else if (localAt || localBy) {
    lines.push(`Local copy last changed ${when(localAt)}${localBy ? ` by ${localBy}` : ''}.`);
  } else if (record?.error) {
    lines.push(`The local record could not be read: ${record.error}`);
  }
  if (lastUpdate && lastUpdate.updatedOn && lastUpdate.updatedOn !== localAt) {
    lines.push(`Latest local update entry: ${when(lastUpdate.updatedOn)}${lastUpdate.updatedBy ? ` by ${lastUpdate.updatedBy}` : ''}${lastUpdate.setName ? ` in "${lastUpdate.setName}"` : ''}.`);
  } else if (lastUpdate && lastUpdate.setName) {
    lines.push(`Captured locally in the update set "${lastUpdate.setName}".`);
  }
  if (remoteAt || remoteBy) lines.push(`The remote update was made ${when(remoteAt)}${remoteBy ? ` by ${remoteBy}` : ''} on the source instance.`);
  if (relation === 'local-newer') lines.push(`The local copy is ${gap} newer: committing would overwrite it.`);
  else if (relation === 'remote-newer') lines.push(`The remote update is ${gap} newer than the local copy, so the platform is probably flagging something other than age (a different local version already pending). Compare the versions before choosing.`);
  else if (relation === 'same') lines.push('Both were changed at about the same time.');

  return { localState, local: { at: localAt, by: localBy }, remote: { at: remoteAt, by: remoteBy }, relation, gap, lastVersion, lastUpdate, lines };
}

// ---- links ---------------------------------------------------------------------------------------------------------

const safeTable = (t) => (IDENT_RE.test(String(t || '')) ? t : '');
export const recordPath = (table, sysId) => (safeTable(table) && SYS_ID_RE.test(sysId || '') ? `/${table}.do?sys_id=${sysId}` : '');
export const listPath = (table, query) => (safeTable(table) ? `/${table}_list.do?sysparm_query=${encodeURIComponent(query || '')}` : '');
/** The version list of one record, newest first, where the platform's own Compare action lives. */
export const versionsPath = (updateName) => (/^[a-z0-9_]+$/i.test(updateName || '') ? listPath('sys_update_version', `name=${updateName}^ORDERBYDESCsys_recorded_at`) : '');

// ---- assembling one problem ----------------------------------------------------------------------------------------

/**
 * Normalised problems + the remote updates they point at -> problems with a kind, the update's name and table, and clues.
 * @param {ReturnType<typeof normalizeProblem>[]} rows
 * @param {Record<string, {sys_id: string, name: string, target_name?: string, type?: string, action?: string, sys_updated_on?: string, sys_updated_by?: string}>} updatesById
 * @param {Record<string, string[]>} refValues  per problem sys_id: the sys_ids its remote update holds in the column the
 *   problem text names (read from the payload when the text gives no sys_id)
 */
export function prepareProblems(rows = [], updatesById = {}, refValues = {}) {
  return rows.map((row) => {
    const update = updatesById[row.updateId] || null;
    const updateName = update?.name || '';
    const parsedName = parseUpdateName(updateName);
    const missing = row.missing || {};
    let { kind, by } = classifyProblem(row);
    // The instance recorded a missing record: that is a missing reference whatever the wording says.
    if (kind === 'generic' && missing.sysId) {
      kind = 'missing_reference';
      by = 'missing_item';
    }
    const selfIds = [parsedName.sysId].filter(Boolean);
    const clues = extractClues(row.description, { selfIds });
    // What the instance recorded (missing_item, missing_item_table) comes first; the text and the payload are fallbacks.
    if (missing.sysId && !selfIds.includes(missing.sysId)) clues.sysIds = [missing.sysId, ...clues.sysIds.filter((s) => s !== missing.sysId)];
    if (missing.table) clues.tables = [missing.table, ...clues.tables.filter((t) => t !== missing.table)];
    const fromPayload = (refValues[row.sysId] || []).filter((s) => SYS_ID_RE.test(s) && !selfIds.includes(s) && !clues.sysIds.includes(s));
    if (fromPayload.length) clues.sysIds = [...clues.sysIds, ...fromPayload];
    return {
      ...row,
      missing: { sysId: '', table: '', updateId: '', updateName: '', updateLabel: '', ...missing },
      id: row.sysId,
      kind,
      classifiedBy: by,
      clues,
      update: update
        ? { sysId: update.sys_id || row.updateId, name: updateName, target: update.target_name || '', type: update.type || '', action: update.action || '', updatedOn: update.sys_updated_on || '', updatedBy: update.sys_updated_by || '' }
        : row.updateId
          ? { sysId: row.updateId, name: '', target: row.updateLabel || '', type: '', action: '', updatedOn: '', updatedBy: '' }
          : null,
      record: parsedName.table ? { table: parsedName.table, sysId: parsedName.sysId, updateName } : null,
    };
  });
}

const sortProblems = (a, b) => {
  const ka = KIND_ORDER.indexOf(a.kind);
  const kb = KIND_ORDER.indexOf(b.kind);
  return (ka < 0 ? 99 : ka) - (kb < 0 ? 99 : kb) || String(a.update?.target || a.update?.name || '').localeCompare(String(b.update?.target || b.update?.name || ''));
};

const PROVIDER_KINDS = ['missing_reference', 'missing_table', 'missing_column'];

/**
 * What the provider search found for one problem: 'found' (another set creates it), 'own' (only this set does), 'error' (the
 * search could not run or failed), 'nosearch' (the text names nothing to search for), 'alone' (no other retrieved sets),
 * 'none' (searched, nobody creates it), or '' for a kind that has no provider.
 */
export function providerState(problem, { searchError = '', otherSetCount = 0 } = {}) {
  if (!PROVIDER_KINDS.includes(problem.kind)) return '';
  const providers = problem.providers || [];
  if (providers.some((p) => !p.own)) return 'found';
  if (providers.length) return 'own';
  if (searchError) return 'error';
  // The instance names the providing update (missing_item_update), but no pending retrieved set searched holds it.
  if (problem.missing?.updateId || problem.missing?.updateName) return 'named';
  if (!(problem.searches || []).length) return 'nosearch';
  if (!otherSetCount) return 'alone';
  return 'none';
}

/** The update the instance names in missing_item_update, as text ('' when it names none). */
const namedUpdate = (problem) => {
  const m = problem.missing || {};
  if (!m.updateId && !m.updateName) return '';
  return m.updateLabel && m.updateLabel !== m.updateId ? m.updateLabel : m.updateName || m.updateId;
};

/** "The instance says the missing record is a sys_user_group record <sys_id>." or ''. */
export function missingText(problem) {
  const m = problem.missing || {};
  if (!m.sysId && !m.table) return '';
  return `The instance recorded the missing item: ${m.table ? `a ${m.table} record` : 'a record'}${m.sysId ? ` with sys_id ${m.sysId}` : ''}.`;
}

/** Plain-words note about the provider search for one problem ('' for a kind that has no provider). */
function providerNote(problem, { state, searchError, otherSetCount }) {
  const providers = problem.providers || [];
  switch (state) {
    case 'found': {
      const sure = providers.filter((p) => !p.own && p.strength !== 'probable');
      if (!sure.length) {
        const maybe = providers.filter((p) => !p.own);
        return `Probably created in ${maybe.map((p) => `"${p.setName}"`).join(' or ')}: ${maybe.length === 1 ? 'it holds' : 'they hold'} dictionary entries whose names start with this table's name, but not the entry that creates the table. Check before committing in that order.`;
      }
      return sure.length === 1 ? `Created in "${sure[0].setName}".` : `Created in ${sure.map((p) => `"${p.setName}"`).join(' and ')} (committing either one first is enough).`;
    }
    case 'own':
      return 'This update set itself contains it, so the preview may be out of date: press Preview Update Set again.';
    case 'error':
      return `Could not search the other retrieved update sets: ${searchError}${namedUpdate(problem) ? ` The instance names the update that would provide it: ${namedUpdate(problem)}.` : ''}`;
    case 'named':
      return `The instance names the update that would provide it (${namedUpdate(problem)}), but none of the ${otherSetCount} pending retrieved update set${otherSetCount === 1 ? '' : 's'} searched holds it. Open that update to see which update set it belongs to.`;
    case 'nosearch': {
      if (problem.kind !== 'missing_reference') return 'The problem text does not name the table or column clearly enough to search the other update sets.';
      const ref = problem.clues?.refs?.[0];
      const dataTable = (problem.clues?.tables || []).find(isDataTable);
      const data = dataTable ? ` If it is a ${dataTable} record, it is probably data, which update sets do not carry: create or import it here.` : '';
      return ref
        ? `The sys_id held in ${ref.column} could not be read from the remote update, so NowBuddy could not search the other update sets. Open the remote update and look at ${ref.column}.${data}`
        : `The problem text names no sys_id, so NowBuddy could not search the other update sets. Open the remote update to see what it points at.${data}`;
    }
    case 'alone':
      return 'There are no other retrieved update sets waiting on this instance, so nothing here can provide it.';
    case 'none': {
      const n = `${otherSetCount} other retrieved update set${otherSetCount === 1 ? '' : 's'}`;
      if (problem.kind === 'missing_reference') {
        const dataTable = problem.clues.tables.find(isDataTable);
        return `None of the ${n} creates it. ${dataTable ? `It is probably data (${dataTable}), which update sets do not carry: create or import it here.` : "It is probably missing from the source instance's update set: ask the author to add it."}`;
      }
      return `None of the ${n} creates it. It is probably missing from the source instance's update set, or comes from an application or plugin that is not installed here.`;
    }
    default:
      return '';
  }
}

// ---- state of the set, verdict, checklist --------------------------------------------------------------------------

/** 'loaded' | 'previewing' | 'previewed' | 'committing' | 'committed' | 'other' from the set's state value / label. */
export function setStateKind(value, label = '') {
  const text = `${value} ${label}`.toLowerCase();
  if (/committing/.test(text)) return 'committing';
  if (/backed|partial/.test(text)) return 'other';
  if (/committed/.test(text)) return 'committed';
  if (/previewing/.test(text)) return 'previewing';
  if (/previewed/.test(text)) return 'previewed';
  if (/loaded|loading/.test(text)) return 'loaded';
  return 'other';
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function kindCountsText(problems) {
  const counts = new Map();
  problems.forEach((p) => counts.set(p.kind, (counts.get(p.kind) || 0) + 1));
  return KIND_ORDER.filter((k) => counts.has(k))
    .map((k) => `${counts.get(k)} ${kindInfo(k).label.toLowerCase()}`)
    .join(', ');
}

/**
 * @param {{ stateKind: string, readError?: string, problems: Array }} input
 * @returns {{ level: 'ready'|'blocked'|'notpreviewed'|'running'|'committed'|'unreadable', headline: string, detail: string, blockers: number, safeToSkip: number, fixable: number }}
 */
export function buildVerdict({ stateKind = 'other', readError = '', problems = [] } = {}) {
  const open = problems.filter((p) => isOpen(p.status));
  const safeToSkip = open.filter((p) => kindInfo(p.kind).skipSafety === 'safe').length;
  const fixable = open.filter((p) => sureProviders(p).length > 0).length;
  const base = { blockers: open.length, safeToSkip, fixable };
  if (readError) return { ...base, level: 'unreadable', headline: 'Could not read the preview problems', detail: readError };
  if (stateKind === 'committed') return { ...base, level: 'committed', headline: 'Already committed', detail: problems.length ? `The ${plural(problems.length, 'problem')} listed here were recorded before the commit.` : 'This update set is committed; there is nothing left to resolve.' };
  if (stateKind === 'previewing') return { ...base, level: 'running', headline: 'Preview is still running', detail: 'Wait for it to finish, then refresh. The list below may be incomplete.' };
  if (stateKind === 'loaded' && !problems.length) return { ...base, level: 'notpreviewed', headline: 'Not previewed yet', detail: 'Press Preview Update Set on the retrieved update set. Until you do, the instance has not looked for problems.' };
  if (!open.length) {
    return {
      ...base,
      level: 'ready',
      headline: 'Ready to commit',
      detail: problems.length ? `All ${plural(problems.length, 'problem')} ${problems.length === 1 ? 'is' : 'are'} accepted or skipped. If you committed another update set after previewing this one, press Preview Update Set again first.` : 'The last preview found no problems. If you committed another update set since, press Preview Update Set again first.',
    };
  }
  const parts = [kindCountsText(open)];
  if (fixable) parts.push(`${fixable} ${fixable === 1 ? 'is' : 'are'} created in another retrieved update set (commit that one first)`);
  if (safeToSkip) parts.push(`${safeToSkip} can be skipped safely`);
  return { ...base, level: 'blocked', headline: `Blocked by ${plural(open.length, 'problem')}`, detail: parts.filter(Boolean).join('; ') };
}

/** The exact thing to do for one open problem, in one line. */
export function nextStep(problem) {
  const external = sureProviders(problem);
  if (external.length) return `Commit "${external[0].setName}" first, then press Preview Update Set again.`;
  const maybe = (problem.providers || []).filter((p) => !p.own);
  if (maybe.length) return `Open "${maybe[0].setName}" and check that it creates what is missing (it holds dictionary entries for that table). If it does, commit it first, then press Preview Update Set again.`;
  const info = kindInfo(problem.kind);
  if (problem.providerState === 'own') return 'Press Preview Update Set again: this set contains what is missing, so the list may be out of date.';
  if (problem.providerState === 'named' || (problem.providerState === 'error' && namedUpdate(problem))) {
    return `Open the update the instance names (${namedUpdate(problem)}) to see which update set holds it. If that set is not committed here yet, commit it first, then press Preview Update Set again.`;
  }
  if (problem.providerState === 'error' || problem.providerState === 'nosearch') {
    return 'NowBuddy could not tell which update set creates it. Open the remote update, note what it points at, and look for that in the other retrieved sets (or ask the author).';
  }
  const dataTable = problem.kind === 'missing_reference' ? (problem.clues?.tables || []).find(isDataTable) : '';
  if (dataTable) return `Nothing in the other retrieved sets provides it, and it is probably data (${dataTable}): create or import that record here, then press Preview Update Set again. Skip remote update only if the pointer is optional.`;
  if (problem.kind === 'missing_reference' || problem.kind === 'missing_table' || problem.kind === 'missing_column') {
    return 'Nothing in the other retrieved sets provides it: ask the author to add it to the set, or Skip remote update if the pointer is optional.';
  }
  if (problem.kind === 'collision') return 'Compare the versions, then press Accept remote update (overwrite the local copy) or Skip remote update (keep it).';
  if (problem.kind === 'delete_missing') return 'Press Skip remote update: there is nothing to delete.';
  return info.action;
}

/**
 * The checklist for the verdict card. Each item is { state: 'done'|'todo'|'info', title, text?, problemId? }.
 */
export function buildChecklist({ stateKind, problems = [], readError = '' }) {
  const items = [];
  if (readError) {
    items.push({ state: 'todo', title: 'Read the preview problems', text: readError });
    return items;
  }
  const previewed = ['previewed', 'committing', 'committed'].includes(stateKind) || problems.length > 0;
  items.push({
    state: previewed ? 'done' : 'todo',
    title: previewed ? 'The update set has been previewed' : 'Preview the update set',
    text: previewed ? '' : 'Press Preview Update Set on the retrieved update set.',
  });
  const open = problems.filter((p) => isOpen(p.status));
  const closed = problems.filter((p) => !isOpen(p.status));
  open.forEach((p) => {
    items.push({
      state: 'todo',
      problemId: p.id,
      title: `${kindInfo(p.kind).label}${p.update?.target || p.update?.name ? `: ${p.update.target || p.update.name}` : ''}`,
      text: nextStep(p),
    });
  });
  if (closed.length) {
    const skipped = closed.filter((p) => p.status === 'skipped').length;
    const accepted = closed.filter((p) => p.status === 'accepted').length;
    const ignored = closed.filter((p) => p.status === 'ignored').length;
    const rest = closed.length - skipped - accepted - ignored;
    const detail = [skipped && `${skipped} skipped`, accepted && `${accepted} accepted`, ignored && `${ignored} ignored`, rest > 0 && `${rest} resolved`].filter(Boolean).join(', ');
    items.push({ state: 'done', title: `${plural(closed.length, 'problem')} already dealt with`, text: detail });
  }
  return items;
}

// ---- commit order --------------------------------------------------------------------------------------------------

/**
 * A commit order from provider edges: a set that provides what another needs is committed first.
 * @param {Array<{from: string, to: string}>} edges  `from` must be committed before `to`
 * @param {Record<string,{name: string, state?: string}>|Map} sets
 * @param {string} focus  the set being looked at (marked in the chain)
 * @returns {{ chain: Array<{setId: string, name: string, state: string, focus: boolean}>, cycles: string[][] }}
 */
export function commitOrder(edges = [], sets = {}, focus = '') {
  const lookup = (id) => (sets instanceof Map ? sets.get(id) : sets[id]) || {};
  const nodes = new Set();
  const out = new Map();
  const indeg = new Map();
  edges.forEach(({ from, to }) => {
    if (!from || !to || from === to) return;
    nodes.add(from);
    nodes.add(to);
    if (!out.has(from)) out.set(from, new Set());
    if (!out.get(from).has(to)) {
      out.get(from).add(to);
      indeg.set(to, (indeg.get(to) || 0) + 1);
    }
  });
  const nameOf = (id) => lookup(id).name || id;
  const ready = [...nodes].filter((n) => !indeg.get(n)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const order = [];
  while (ready.length) {
    const n = ready.shift();
    order.push(n);
    [...(out.get(n) || [])].forEach((m) => {
      indeg.set(m, indeg.get(m) - 1);
      if (!indeg.get(m)) {
        ready.push(m);
        ready.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      }
    });
  }
  const stuck = [...nodes].filter((n) => !order.includes(n));
  const chain = order.map((id) => ({ setId: id, name: nameOf(id), state: lookup(id).state || '', focus: id === focus }));
  return { chain, cycles: stuck.length ? [stuck.map(nameOf)] : [] };
}

/** Provider edges for the open problems of one set: [{ from: providerSetId, to: thisSetId }]. */
export function edgesFromProblems(setId, problems = []) {
  const edges = [];
  const seen = new Set();
  problems
    .filter((p) => isOpen(p.status))
    .forEach((p) =>
      sureProviders(p)
        .filter((x) => x.setId && x.setId !== setId)
        .forEach((x) => {
          const key = `${x.setId}>${setId}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push({ from: x.setId, to: setId });
          }
        })
    );
  return edges;
}

// ---- the whole analysis --------------------------------------------------------------------------------------------

/**
 * Everything the panel shows for one retrieved update set, from what the instance half read.
 * @param {object} raw
 * @param {{ sysId: string, name: string, state?: string, stateLabel?: string }} raw.set
 * @param {ReturnType<typeof mapProblemColumns>} raw.map
 * @param {ReturnType<typeof normalizeProblem>[]} raw.rows
 * @param {Record<string, object>} raw.updates          remote updates by sys_id
 * @param {Array<{sysId: string, name: string, state: string}>} raw.candidateSets  retrieved sets searched for providers
 * @param {Record<string, Array>} raw.providerRows      provider search results by search key
 * @param {Record<string, string>} raw.providerErrors   error text by search key
 * @param {Record<string, object>} raw.collisionData    per remote update sys_id: { record, localUpdates, versions, remote }
 * @param {Array<{from: string, to: string}>} raw.extraEdges  edges found by walking the provider sets
 * @param {Array<string>} raw.notes
 */
export function buildAnalysis(raw) {
  const set = raw.set || {};
  const stateKind = setStateKind(set.state || '', set.stateLabel || '');
  const readError = raw.readError || '';
  const prepared = prepareProblems(raw.rows || [], raw.updates || {}, raw.refValues || {});
  const setsById = Object.fromEntries((raw.candidateSets || []).map((s) => [s.sysId, { name: s.name, state: s.stateLabel || s.state || '' }]));
  const otherSetCount = (raw.candidateSets || []).filter((s) => s.sysId !== set.sysId).length;

  const problems = prepared.map((p) => {
    p.searches = searchesFor(p);
    p.providers = p.searches.length ? matchProviders(p, raw.providerRows || {}, setsById, set.sysId) : [];
    const errors = p.searches.map((s) => raw.providerErrors?.[s.key]).filter(Boolean);
    const searchError = !p.providers.length && errors.length ? errors[0] : '';
    p.providerState = providerState(p, { searchError, otherSetCount });
    p.providerNote = providerNote(p, { state: p.providerState, searchError, otherSetCount });
    const info = kindInfo(p.kind);
    p.explain = { label: info.label, short: info.short, meaning: info.meaning, why: info.why, wayOut: info.wayOut, checkFirst: info.checkFirst, action: info.action, skipSafety: info.skipSafety };
    if (p.kind === 'collision') {
      const data = raw.collisionData?.[p.update?.sysId] || raw.collisionData?.[p.id] || null;
      p.collision = data ? buildCollision(data) : null;
    }
    p.links = {
      problem: recordPath(PROBLEM_TABLE, p.id),
      update: p.update?.sysId ? recordPath('sys_update_xml', p.update.sysId) : '',
      record: p.record ? recordPath(p.record.table, p.record.sysId) : '',
      versions: p.record && p.kind === 'collision' ? versionsPath(p.record.updateName) : '',
      providers: p.providers.filter((x) => !x.own).map((x) => ({ setId: x.setId, name: x.setName, href: recordPath(SET_TABLE, x.setId) })),
      missingUpdate: p.missing?.updateId ? recordPath('sys_update_xml', p.missing.updateId) : '',
    };
    p.missingText = missingText(p);
    // What the platform offers on the problem record (available_actions), exactly as it gave it.
    p.offers = offersText(p.actions);
    p.next = isOpen(p.status) ? [nextStep(p), p.offers].filter(Boolean).join(' ') : '';
    return p;
  });
  problems.sort((a, b) => Number(isOpen(b.status)) - Number(isOpen(a.status)) || sortProblems(a, b));

  const counts = { total: problems.length, open: 0, byStatus: {}, byKind: {} };
  problems.forEach((p) => {
    counts.byStatus[p.status] = (counts.byStatus[p.status] || 0) + 1;
    if (isOpen(p.status)) counts.open += 1;
    const k = (counts.byKind[p.kind] = counts.byKind[p.kind] || { total: 0, open: 0 });
    k.total += 1;
    if (isOpen(p.status)) k.open += 1;
  });

  const edges = [...edgesFromProblems(set.sysId, problems), ...(raw.extraEdges || [])];
  const namesById = { ...setsById, [set.sysId]: { name: set.name, state: set.stateLabel || set.state || '' }, ...(raw.chainSets || {}) };
  const order = edges.length ? commitOrder(edges, namesById, set.sysId) : { chain: [], cycles: [] };

  const verdict = buildVerdict({ stateKind, readError, problems });
  const checklist = buildChecklist({ stateKind, problems, readError });

  return {
    set,
    stateKind,
    counts,
    problems,
    groups: KIND_ORDER.filter((k) => counts.byKind[k]).map((k) => ({ kind: k, label: kindInfo(k).label, short: kindInfo(k).short, total: counts.byKind[k].total, open: counts.byKind[k].open })),
    verdict,
    checklist,
    order,
    columns: raw.map ? { found: raw.map.found, missing: raw.map.missing, used: raw.map.columns } : null,
    limits: [...(raw.notes || [])],
    truncated: Boolean(raw.truncated),
  };
}

// ---- the retrieved update set list ---------------------------------------------------------------------------------

/** Does the text look like a sys_id? */
export const isSysId = (text) => SYS_ID_RE.test(String(text || '').trim());

/** Reduce rows of sys_remote_update_set (read with display values) to what the picker shows. */
export function normalizeSet(row, counts = {}) {
  const r = row || {};
  const stateValue = cellValue(r.state);
  const stateLabel = cellLabel(r.state);
  const sysId = cellValue(r.sys_id);
  return {
    sysId,
    name: cellLabel(r.name) || sysId,
    state: stateValue,
    stateLabel: stateLabel || stateValue,
    stateKind: setStateKind(stateValue, stateLabel),
    application: cellLabel(r.application) || cellLabel(r.application_name) || '',
    updatedOn: cellValue(r.sys_updated_on),
    createdOn: cellValue(r.sys_created_on),
    // There is no "loaded" column (confirmed live 2026-10-23): the set row is created when it is retrieved.
    loadedOn: cellValue(r.sys_created_on),
    commitDate: cellValue(r.commit_date),
    // A child of an update set batch: the batch parent is committed (and previewed) as a whole.
    parentId: SYS_ID_RE.test(cellValue(r.parent)) ? cellValue(r.parent) : '',
    parentName: SYS_ID_RE.test(cellValue(r.parent)) ? cellLabel(r.parent) : '',
    problemCount: Number.isFinite(counts[sysId]) ? counts[sysId] : null,
  };
}

/** Sets that can still provide something (not yet committed). */
export const isPending = (set) => set.stateKind !== 'committed';

// ---- the Markdown report -------------------------------------------------------------------------------------------

const mdEscape = (text) => String(text || '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

/**
 * A Markdown report for the change ticket.
 * @param {ReturnType<typeof buildAnalysis>} analysis
 * @param {{ base?: string, host?: string, today?: string }} options  `base` is the instance origin for links
 */
export function previewProblemsMarkdown(analysis, { base = '', host = '', today = '' } = {}) {
  const abs = (path) => (path ? `${String(base).replace(/\/$/, '')}${path}` : '');
  const { set, verdict, problems, order } = analysis;
  const open = problems.filter((p) => isOpen(p.status));
  const closed = problems.filter((p) => !isOpen(p.status));
  const lines = [];
  lines.push(`# Update set preview report: ${set.name || set.sysId}`);
  lines.push('');
  lines.push([host && `Instance: ${host}`, set.stateLabel && `Update set state: ${set.stateLabel}`, today && `Checked: ${today}`].filter(Boolean).join(' - '));
  lines.push('');
  lines.push(`**${verdict.headline}.** ${verdict.detail}`);
  lines.push('');

  if (open.length) {
    lines.push(`## To resolve (${open.length})`);
    lines.push('');
    open.forEach((p, i) => {
      const what = p.update?.target || p.update?.name || p.id;
      lines.push(`${i + 1}. **${kindInfo(p.kind).label}** - ${mdEscape(what)}${p.update?.type ? ` (${mdEscape(p.update.type)})` : ''}`);
      if (p.description) lines.push(`   - The instance says: "${mdEscape(p.description)}"`);
      lines.push(`   - What it means: ${kindInfo(p.kind).meaning}`);
      if (p.missingText) lines.push(`   - ${p.missingText}`);
      if (p.providerNote) lines.push(`   - Provider: ${p.providerNote}`);
      if (p.collision?.lines?.length) p.collision.lines.forEach((l) => lines.push(`   - ${l}`));
      lines.push(`   - Next step: ${p.next}`);
      const link = abs(p.links?.problem);
      if (link) lines.push(`   - Problem record: ${link}`);
    });
    lines.push('');
  }

  if (closed.length) {
    lines.push(`## Already dealt with (${closed.length})`);
    lines.push('');
    lines.push('| Problem | Update | Status |');
    lines.push('| --- | --- | --- |');
    closed.forEach((p) => lines.push(`| ${kindInfo(p.kind).label} | ${mdEscape(p.update?.target || p.update?.name || p.id)} | ${STATUS_TEXT[p.status] || p.status} |`));
    lines.push('');
  }

  if (order?.chain?.length > 1) {
    lines.push('## Suggested commit order');
    lines.push('');
    order.chain.forEach((c, i) => lines.push(`${i + 1}. ${mdEscape(c.name)}${c.focus ? ' (this update set)' : ''}`));
    if (order.cycles?.length) lines.push('', `These depend on each other and need a decision from the authors: ${order.cycles[0].map(mdEscape).join(', ')}.`);
    lines.push('');
  }

  if (analysis.limits?.length) {
    lines.push('## Not checked');
    lines.push('');
    analysis.limits.forEach((l) => lines.push(`- ${l}`));
    lines.push('');
  }
  lines.push('_Generated by NowBuddy. The explanations are guidance; the platform\'s own Accept remote update / Skip remote update buttons make the change._');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
