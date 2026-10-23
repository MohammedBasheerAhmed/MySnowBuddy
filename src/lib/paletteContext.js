// What the page on screen is, and which palette commands are the likely next step there.
//
// The palette used to open with the same list everywhere; on a script form a developer wants the editor and
// lint first, on a list the filter tools, on an update set the review. `suggestFor` picks those.

import { isScriptLabel } from './inline.js';
import { isTicketTable } from './ticketTables.js';

// Update sets and the retrieved ones (a developer on the Retrieved Update Sets list or a preview problem wants the
// preview fix tool, not the review of their own set).
const UPDATE_SET_TABLES = new Set(['sys_update_set', 'sys_update_xml', 'sys_remote_update_set', 'sys_update_preview_problem']);
const PREVIEW_TABLES = new Set(['sys_remote_update_set', 'sys_update_preview_problem']);

/**
 * 'script' (a record with a script field), 'ticket' (a task-type record), 'record', 'list', 'updateset', 'portal'
 * (a Service Portal page) or 'other'. `ctx` is the page context from src/content/context.js.
 */
export function pageKind(ctx = {}) {
  if (ctx.isPortal) return 'portal';
  const table = String(ctx.table || '');
  if (!table) return 'other';
  if (ctx.isList) return UPDATE_SET_TABLES.has(table) ? 'updateset' : 'list';
  if (!ctx.sysId) return 'other';
  // A single customer update is a record like any other; the update set and the retrieved ones are the review job.
  if (table === 'sys_update_set' || PREVIEW_TABLES.has(table)) return 'updateset';
  if (ctx.scriptBody && isScriptLabel(ctx.scriptFieldLabel)) return 'script';
  return isTicketTable(table) ? 'ticket' : 'record';
}

// Command ids, most useful first. Ids that are not on the page right now are skipped.
export const SUGGESTED = {
  script: ['tools.editor', 'tools.verify', 'analyze.lint', 'panel.impact', 'record.versionDiff', 'tools.background', 'tools.testbench'],
  record: ['record.versionDiff', 'panel.xray', 'panel.access', 'record.updateEntry', 'record.copySysId', 'table.fields', 'panel.process', 'panel.notify', 'panel.clienttrace'],
  // A ticket is a record that things happen to: flows run, approvals wait, emails go out. Those answers come first.
  ticket: ['panel.process', 'panel.notify', 'panel.xray', 'panel.access', 'record.versionDiff', 'record.updateEntry', 'record.copySysId', 'table.fields', 'panel.clienttrace'],
  list: ['analyze.listTools', 'table.fields', 'panel.xray', 'table.new', 'analyze.search', 'panel.datamodel'],
  updateset: ['panel.shipcheck', 'analyze.updateset', 'panel.push', 'panel.mywork', 'panel.previewfix'],
  portal: ['panel.portal', 'panel.xray', 'analyze.search'],
  other: ['panel.mywork', 'analyze.search', 'tools.background', 'tools.api', 'panel.health', 'panel.properties', 'panel.doctor'],
};

/** The suggestion ids for this page. On a retrieved update set or a preview problem the preview fix comes first. */
export function suggestedIds(ctx = {}) {
  const kind = pageKind(ctx);
  const list = SUGGESTED[kind] || [];
  if (kind === 'updateset' && PREVIEW_TABLES.has(String(ctx.table || ''))) return ['panel.previewfix', ...list.filter((id) => id !== 'panel.previewfix')];
  return list;
}

/** Every command id that suits this page, for nudging search results toward it. */
export function pageSuggestions(ctx) {
  return suggestedIds(ctx);
}

/** Up to `limit` commands from `commands` that suit this page, in the order of SUGGESTED. */
export function suggestFor(ctx, commands, limit = 4) {
  const byId = new Map(commands.map((command) => [command.id, command]));
  return suggestedIds(ctx)
    .map((id) => byId.get(id))
    .filter(Boolean)
    .slice(0, limit);
}

/** Heading for the suggestions, in plain words. */
export const SUGGESTED_TITLES = {
  script: 'Suggested for this script',
  record: 'Suggested for this record',
  ticket: 'Suggested for this ticket',
  list: 'Suggested for this list',
  updateset: 'Suggested for this update set',
  portal: 'Suggested for this portal page',
  other: 'Suggested',
};
