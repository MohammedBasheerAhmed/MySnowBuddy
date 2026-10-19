// What the page on screen is, and which palette commands are the likely next step there.
//
// The palette used to open with the same list everywhere; on a script form a developer wants the editor and
// lint first, on a list the filter tools, on an update set the review. `suggestFor` picks those.

import { isScriptLabel } from './inline.js';

/**
 * 'script' (a record with a script field), 'record', 'list', 'updateset' or 'other'.
 * `ctx` is the page context from src/content/context.js.
 */
export function pageKind(ctx = {}) {
  const table = String(ctx.table || '');
  if (!table) return 'other';
  if (ctx.isList) return table === 'sys_update_set' || table === 'sys_update_xml' ? 'updateset' : 'list';
  if (!ctx.sysId) return 'other';
  if (table === 'sys_update_set') return 'updateset';
  return ctx.scriptBody && isScriptLabel(ctx.scriptFieldLabel) ? 'script' : 'record';
}

// Command ids, most useful first. Ids that are not on the page right now are skipped.
export const SUGGESTED = {
  script: ['tools.editor', 'tools.verify', 'analyze.lint', 'panel.impact', 'record.versionDiff', 'tools.background', 'tools.testbench'],
  record: ['record.versionDiff', 'panel.xray', 'panel.access', 'record.updateEntry', 'record.copySysId', 'table.fields'],
  list: ['analyze.listTools', 'table.fields', 'panel.xray', 'table.new', 'analyze.search'],
  updateset: ['panel.shipcheck', 'analyze.updateset', 'panel.push', 'panel.mywork'],
  other: ['panel.mywork', 'analyze.search', 'tools.background', 'tools.api', 'panel.health'],
};

/** Up to `limit` commands from `commands` that suit this page, in the order of SUGGESTED. */
export function suggestFor(ctx, commands, limit = 4) {
  const byId = new Map(commands.map((command) => [command.id, command]));
  return (SUGGESTED[pageKind(ctx)] || [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .slice(0, limit);
}

/** Heading for the suggestions, in plain words. */
export const SUGGESTED_TITLES = {
  script: 'Suggested for this script',
  record: 'Suggested for this record',
  list: 'Suggested for this list',
  updateset: 'Suggested for this update set',
  other: 'Suggested',
};
