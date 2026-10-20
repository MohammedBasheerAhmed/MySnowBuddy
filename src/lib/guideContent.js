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
      { say: 'has this happened before', what: 'Records on the same table that share the distinctive words of this one, best match first. Also /similar.', target: 'record.similar' },
      { say: 'what happened when i saved', what: 'Arm it, save, collect: field changes, log lines, the transaction, update set entries, events, emails, flows and SLAs in one timeline, with the errors on top.', target: 'panel.savetrace' },
      { say: 'can i delete this record', what: 'Everything that points at it, what a delete would clear, cascade or block, and what it points at.', target: 'panel.refs' },
      { say: 'break this list down', what: 'On a list: counts per state, priority or group, or per day, week and month. Click a bar to filter the list to it.', target: 'panel.insight' },
      { say: 'who changed this', what: 'Who changed a field or script, when, and what the old version said.', target: 'record.versionDiff' },
      { say: "why can't a user see this record", what: 'Roles, groups and ACLs for a user on this record, with the one that blocks them.', target: 'panel.access' },
      { say: 'why is this field read only', what: 'X-ray: every UI policy, client script and rule that touches the fields on this form.', target: 'panel.xray' },
      { say: 'what did i modify on the form', what: 'The unsaved changes on the form, field by field.', target: 'analyze.formdiff' },
      { say: 'the field disappeared', what: 'Show hidden fields: rows a UI policy or script hid come back, marked "hidden". Run it again to hide them. The Form button on the page bar also highlights required, read-only and changed fields and copies the values.', target: 'form.hidden' },
      { say: 'clone it into a new record', what: 'Duplicate this record: a new record opens in a new tab, prefilled from the form (secrets, dates and journals left out). You press Submit.', target: 'form.duplicate' },
      { say: 'decode what i selected', what: 'Select JSON, XML, Base64, a token, a timestamp, a table name or a record number on the page: a popover says what it is and offers to pretty-print, decode, convert or open it.', target: 'tools.smartSelect' },
    ],
  },
  {
    title: 'Write and check code',
    items: [
      { say: 'who broke it', what: 'Configuration changes by anyone in the last hour, today or this week, grouped by application, with what is new since you last looked and a diff of each.', target: 'panel.recent' },
      { say: "why didn't my rule run", what: 'For the record on screen: every business rule, client script, UI policy, data policy and ACL that could apply, with the first condition that stops each one, in plain words.', target: 'panel.whyrule' },
      { say: 'where is this used', what: 'Before you edit a script: who calls it, what it writes, what runs as a result.', target: 'panel.impact' },
      { say: 'check my script for made up methods', what: 'Syntax, made-up API methods, lint and structure. No AI tokens.', target: 'tools.verify' },
      { say: 'start a new business rule', what: 'Opens a new form already filled in: name, table, timing and a checked script template. /new si, cs, uia, sj, fix and rest do the same for other scripts.', target: 'tools.new' },
      { say: 'edit in a bigger editor', what: 'Highlighting, find and replace and autocomplete. Click Edit beside a script field to edit it right over the field (it saves with the form), or open it full screen.', target: 'tools.editor' },
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
      { say: 'run this against a record', what: 'Test a business rule, UI action or script include method on a real record as a dry run: current and previous bound, fields pretended changed, the writes it held back listed.', target: 'test.run' },
      { say: 'write a unit test', what: 'From a script include: a runnable test with assertions for every method, a pass/fail table, saved so you can run it again.', target: 'test.unit' },
      { say: 'which atf tests cover this', what: 'The Automated Test Framework tests and suites that mention a table or script include, how they last went, and a button to run the suite.', target: 'test.atf' },
      { say: 'snapshot this record', what: 'Save a record (or a list) before you test, do something, then see exactly which fields or rows changed.', target: 'test.snapshot' },
      { say: 'who can access this', what: 'Read, write, create and delete for up to five users side by side, with the ACL that blocks each.', target: 'test.access' },
      { say: 'create sample records', what: 'Ten believable incidents, users or CIs for testing: preview first, dev/test only, a confirmation, then one click to remove exactly those again.', target: 'panel.testdata' },
    ],
  },
  {
    title: 'Ship it',
    items: [
      { say: 'start a new update set', what: 'Create one in your current scope and switch to it, so changes stop landing in Default.', target: 'tools.newUpdateSet' },
      { say: 'what did i change', what: 'Your update set, your scope and your recent changes, with what will not ship.', target: 'panel.mywork' },
      { say: 'release notes for my update set', what: 'Turn an update set into notes for the ticket: what changed, what is risky, what to test, how to back out. Copy as Markdown or plain text.', target: 'panel.releasenotes' },
      { say: 'is my update set safe to move', what: 'Ship check: collisions, missing dependencies, scripts that fail lint, a release checklist.', target: 'panel.shipcheck' },
      { say: 'difference between dev and prod', what: 'Compare two instances, or one record against its twin elsewhere.', target: 'analyze.compare' },
    ],
  },
  {
    title: 'Look after the instance',
    items: [
      { say: 'what went wrong recently', what: 'Failed email, flows, integrations, import rows, overdue jobs and stuck events in the last hour, day or week, repeats grouped (42x), with a plain-words reason.', target: 'panel.failures' },
      { say: 'what is slow or noisy', what: 'Hot spots: the slowest pages and jobs, SQL-heavy requests, repeating log messages, busy events and records changed again and again. Nothing loads until you open a section.', target: 'panel.hotspots' },
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
      { say: 'paste these rows into excel', what: 'On any list: copy the ticked rows (else all on screen) for a spreadsheet, as Markdown or JSON, or just their sys_ids. The Copy rows button on the page bar does the same.', target: 'tools.list.tsv' },
      { say: '/names', what: 'Show the database name under every label and column title. Double-click any label to copy its name. Slash commands also work typed into the navigator filter.', target: null },
      { say: 'make the filter dynamic', what: 'On a list: swap fixed dates and your own sys_id for gs.daysAgoStart(7) and gs.getUserID(), so the saved filter stays right tomorrow.', target: 'tools.list.dynamic' },
      { say: 'active=true^priority=1', what: 'Paste or type an encoded query (javascript: parts too) and it opens the list with that filter. Start with a table name to use another table.', target: null },
      { say: '/i prod', what: 'Open this same page on another instance. Enter stays in this tab, Shift+Enter opens a new one. Names and colours are set in Options.', target: null },
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
