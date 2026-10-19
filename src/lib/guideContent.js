// What the developer guide says. Organised by the job a developer is doing, not by the name of a tool, because that is
// how people look for help. Each line has a `say` phrase: clicking it opens the palette with that phrase typed in, so
// the guide teaches the habit it is selling (describe the problem, press Enter).
//
// `prefill` overrides what is typed into the palette (an example like INC0010001 should open it empty).
// `target` is the palette command the phrase should lead to. tests/guide.test.js checks the target exists and that the
// phrase really matches its problem phrases (src/lib/paletteIntents.js), so the guide cannot drift from the palette.

export const GUIDE_JOBS = [
  {
    title: 'Understand a record or a form',
    items: [
      { say: 'who changed this', what: 'Who changed a field or script, when, and what the old version said.', target: 'record.versionDiff' },
      { say: "why can't a user see this record", what: 'Roles, groups and ACLs for a user on this record, with the one that blocks them.', target: 'panel.access' },
      { say: 'why is this field read only', what: 'X-ray: every UI policy, client script and rule that touches the fields on this form.', target: 'panel.xray' },
      { say: 'what did i modify on the form', what: 'The unsaved changes on the form, field by field.', target: 'analyze.formdiff' },
    ],
  },
  {
    title: 'Write and check code',
    items: [
      { say: 'where is this used', what: 'Before you edit a script: who calls it, what it writes, what runs as a result.', target: 'panel.impact' },
      { say: 'check my script for made up methods', what: 'Syntax, made-up API methods, lint and structure. No AI tokens.', target: 'tools.verify' },
      { say: 'edit in a bigger editor', what: 'Full-screen editor with highlighting, find and replace and autocomplete.', target: 'tools.editor' },
      { say: 'how do i use gliderecord', what: 'Method signatures for GlideRecord, gs, g_form and more, checked against a real instance.', target: 'tools.api' },
    ],
  },
  {
    title: 'Run and debug',
    items: [
      { say: 'run a script', what: 'Background script runner. Dry run is on until you switch it off.', target: 'tools.background' },
      { say: 'test my client script', what: 'Try an onChange or onLoad against a simulated form without saving anything.', target: 'tools.testbench' },
      { say: 'watch the logs', what: 'Live system log while you reproduce a problem.', target: 'analyze.logTail' },
      { say: 'call an api', what: 'REST builder for the Table API and your own endpoints.', target: 'tools.rest' },
    ],
  },
  {
    title: 'Ship it',
    items: [
      { say: 'start a new update set', what: 'Create one in your current scope and switch to it, so changes stop landing in Default.', target: 'tools.newUpdateSet' },
      { say: 'what did i change', what: 'Your update set, your scope and your recent changes, with what will not ship.', target: 'panel.mywork' },
      { say: 'is my update set safe to move', what: 'Ship check: collisions, missing dependencies, scripts that fail lint, a release checklist.', target: 'panel.shipcheck' },
      { say: 'difference between dev and prod', what: 'Compare two instances, or one record against its twin elsewhere.', target: 'analyze.compare' },
    ],
  },
  {
    title: 'Look after the instance',
    items: [
      { say: 'is my instance healthy', what: 'Health scan: code quality, anti-patterns, upgrade risks and security.', target: 'panel.health' },
      { say: 'my change is not showing', what: 'Flush the cache.', target: 'instance.cache' },
      { say: 'test as another user', what: 'Impersonate a user (or type @name), and end it again.', target: 'tools.impersonate' },
    ],
  },
  {
    title: 'Get around fast',
    items: [
      { say: 'INC0010001', what: 'Type any record number to open it: incidents, changes, stories, KB articles.', target: null, prefill: '' },
      { say: '/tn incident', what: 'Jump to a table by name, with its list, new record and configuration.', target: null },
      { say: 'a pasted sys_id', what: 'Paste a sys_id and the palette finds the record, whichever table it is in.', target: null, prefill: '' },
    ],
  },
];

/** Keys worth learning, as [keys, what it does]. The palette key comes from the caller (the user can rebind it). */
export function guideShortcuts(paletteKey) {
  return [
    [paletteKey, 'Open the palette'],
    ['Alt+P', 'Pin the highlighted command to the top'],
    ['Alt+1 … 9', 'Run the Nth result'],
    ['Alt+Shift+X', 'X-ray the form'],
    ['Alt+Shift+E', 'Full-screen script editor'],
  ];
}

/** Plain heading for what the page on screen is, for the "Right now" line. */
export const PAGE_NOUN = {
  script: 'a script',
  record: 'a record',
  list: 'a list',
  updateset: 'an update set',
  other: 'a page',
};

/** The job to show first for the kind of page on screen (a title from GUIDE_JOBS). */
export const JOB_FOR_PAGE = {
  script: 'Write and check code',
  record: 'Understand a record or a form',
  list: 'Get around fast',
  updateset: 'Ship it',
  other: 'Get around fast',
};
