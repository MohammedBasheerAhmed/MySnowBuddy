// What the "previewProblems" feature (Update set preview problems, /preview) needs from the instance, for the Self-check
// panel (src/lib/requirements/index.js).
// One entry per table: { feature, table, columns: [...], optional?: true, note?: "why" }.
//
// Column names of sys_update_preview_problem and sys_remote_update_set were confirmed on a live PDI on 2026-10-23 (the
// values were not: that PDI had no retrieved update set). The feature still finds the problem columns in sys_dictionary at
// run time, so a missing optional one degrades a section instead of stopping the feature.

const FEATURE = 'Update set preview problems';

export const REQUIREMENTS = [
  {
    feature: FEATURE,
    table: 'sys_remote_update_set',
    columns: ['name', 'state', 'sys_updated_on', 'sys_created_on'],
    note: 'The retrieved update sets listed in the picker, with their state (loaded, previewed, committed).',
  },
  {
    feature: FEATURE,
    table: 'sys_remote_update_set',
    columns: ['application', 'commit_date', 'parent'],
    optional: true,
    note: 'The application shown next to the set name, the commit date, and the batch parent (a set inside an update set batch says so).',
  },
  {
    feature: FEATURE,
    table: 'sys_update_preview_problem',
    columns: ['remote_update_set', 'description'],
    note: 'The preview problems. remote_update_set (a reference to sys_remote_update_set) links a problem to its set and is essential; the columns are discovered from sys_dictionary.',
  },
  {
    feature: FEATURE,
    table: 'sys_update_preview_problem',
    columns: ['remote_update', 'type', 'status'],
    optional: true,
    note: 'The remote update behind a problem, its type and whether it is resolved. Without them problems are listed without the record they change, or all treated as unresolved.',
  },
  {
    feature: FEATURE,
    table: 'sys_update_preview_problem',
    columns: ['missing_item', 'missing_item_table', 'missing_item_update', 'available_actions'],
    optional: true,
    note: 'What the platform itself recorded as missing (sys_id, table, the update that would provide it) and the actions it offers. The first source for finding the provider; without them the description and the remote update are read instead.',
  },
  {
    feature: FEATURE,
    table: 'sys_update_xml',
    columns: ['name', 'type', 'target_name', 'action', 'remote_update_set', 'update_set', 'payload'],
    note: 'The remote updates behind the problems, the search of the other retrieved sets for the one that creates a missing record (name holds "<table>_<sys_id>"), and the local updates of a colliding record. The payload is read only for the author and time of a colliding remote update, and for the sys_id held in the column a missing-reference problem names ("Could not find a record in <table> for column <column> ..."); nothing else of it is kept.',
  },
  {
    feature: FEATURE,
    table: 'sys_update_version',
    columns: ['name', 'sys_recorded_at', 'sys_created_by', 'source'],
    optional: true,
    note: 'Latest local version of a colliding record (author and time). Left out of the collision text when unreadable.',
  },
  {
    feature: FEATURE,
    table: 'sys_dictionary',
    columns: ['name', 'element', 'internal_type', 'reference'],
    note: 'Used to discover the columns of sys_update_preview_problem.',
  },
];
