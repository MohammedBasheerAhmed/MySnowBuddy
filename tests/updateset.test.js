const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseXml,
  parseUpdatePayload,
  decodeEntities,
  parseUpdateName,
  tableForEntry,
  recordPathForEntry,
  extractScripts,
  scriptKind,
  scanScript,
  findHardcodedSysIds,
  findScriptIncludeRefs,
  findCustomTableRefs,
  analyseEntryScripts,
  riskyKind,
  buildShipChecklist,
  buildReleaseNotes,
  shipCheckToMarkdown,
  buildShipCheckPrompt,
  planMove,
  confirmMatches,
  parsePickerCurrent,
  parseGroupedStats,
  groupChangesBySet,
  myWorkWarnings,
  timeAgo,
  dictionaryUpdateNames,
  isDefaultSet,
  validateNewUpdateSetName,
} = require('../src/lib/updateSetReview.js');
const { expectedUpdateName, findCollisionsForEntries, findUncapturedChanges } = require('../src/content/updateSets.js');
const {
  pushableFields,
  planPush,
  matchQuery,
  pickKeyMatches,
  refusalReason,
  writeGuard,
  sanitizePushPayload,
  verifyWrite,
} = require('../src/lib/pushArtifact.js');

const ID1 = '0123456789abcdef0123456789abcdef';
const ID2 = 'fedcba9876543210fedcba9876543210';
const ID3 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// ---- XML ------------------------------------------------------------------------------

test('payload parsing: CDATA, split CDATA, entities, attributes and several script fields', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- exported -->
<record_update table="sys_ui_policy">
  <sys_ui_policy action="INSERT_OR_UPDATE">
    <short_description>Hide &amp; show</short_description>
    <script_true><![CDATA[function onCondition() { if (a < b && c > d) { g_form.setDisplay('x', true); } }]]></script_true>
    <script_false><![CDATA[var s = "]]]]><![CDATA[>"; // tricky]]></script_false>
    <table display_value="Incident">incident</table>
    <sys_scope display_value="Global">global</sys_scope>
    <empty/>
  </sys_ui_policy>
</record_update>`;
  const parsed = parseUpdatePayload(xml);
  assert.equal(parsed.table, 'sys_ui_policy');
  assert.equal(parsed.action, 'INSERT_OR_UPDATE');
  const rec = parsed.records[0];
  assert.equal(rec.fields.short_description, 'Hide & show');
  assert.ok(rec.fields.script_true.includes('a < b && c > d'));
  assert.equal(rec.fields.script_false, 'var s = "]]>"; // tricky');
  assert.equal(rec.display.table, 'Incident');
  assert.equal(rec.fields.empty, '');

  const scripts = extractScripts(parsed);
  assert.deepEqual(
    scripts.map((s) => s.field),
    ['script_true', 'script_false']
  );
});

test('payload parsing: entity-escaped scripts, ">" in attributes, stray "<", unclosed documents', () => {
  const xml = '<record_update table="sys_script"><sys_script action="INSERT_OR_UPDATE" note="a>b"><name>BR &#8211; x &#x41;</name>' +
    '<script>if (x &lt; 2 &amp;&amp; y) { gs.info(&quot;hi&quot;); }</script><condition>a < b</condition></sys_script></record_update>';
  const rec = parseUpdatePayload(xml).records[0];
  assert.equal(rec.fields.name, 'BR – x A');
  assert.equal(rec.fields.script, 'if (x < 2 && y) { gs.info("hi"); }');
  assert.equal(rec.fields.condition, 'a < b');

  const doc = parseXml('<a><b>one</b><c>two');
  assert.equal(doc.children[0].children[1].text, 'two');
  assert.deepEqual(parseUpdatePayload('').records, []);
  assert.equal(decodeEntities('&unknown; &lt;'), '&unknown; <');
});

test('payload parsing: first value wins for repeated tags; records other than the main one are kept', () => {
  const xml = '<record_update table="sys_ui_section"><sys_ui_section action="INSERT_OR_UPDATE"><name>incident</name>' +
    '<sys_ui_element><element>number</element></sys_ui_element></sys_ui_section><sys_ui_element action="INSERT_OR_UPDATE"><element>state</element></sys_ui_element></record_update>';
  const parsed = parseUpdatePayload(xml);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].fields.name, 'incident');
  assert.equal(parsed.records[1].tag, 'sys_ui_element');
});

test('update names, tables and record paths', () => {
  assert.deepEqual(parseUpdateName(`sys_script_include_${ID1}`), { table: 'sys_script_include', sysId: ID1 });
  assert.deepEqual(parseUpdateName('sys_dictionary_incident_u_field'), { table: null, sysId: null });
  assert.equal(tableForEntry({ name: 'sys_dictionary_incident_u_field', type: 'Dictionary' }), 'sys_dictionary');
  assert.equal(tableForEntry({ name: 'odd', type: 'Business Rule' }), 'sys_script');
  assert.equal(recordPathForEntry({ name: `sys_script_${ID1}`, sys_id: ID2 }), `/sys_script.do?sys_id=${ID1}`);
  assert.equal(recordPathForEntry({ name: 'sys_dictionary_x_y', sys_id: ID2 }), `/sys_update_xml.do?sys_id=${ID2}`);
});

test('script kinds: server UI actions are linted, client ones verified', () => {
  assert.equal(scriptKind('sys_ui_action', 'script', { client: 'true' }), 'ui_action_client');
  assert.equal(scriptKind('sys_ui_action', 'script', { client: 'false' }), null);
  assert.equal(scriptKind('sys_script', 'condition', {}), null);
  assert.equal(scriptKind('sys_ws_operation', 'operation_script', {}), 'scripted_rest');
  // Unknown tables fall back to any *script field.
  const parsed = parseUpdatePayload('<record_update table="x_custom"><x_custom><my_script>var a = 1;</my_script><sys_script>no</sys_script><notes>n</notes></x_custom></record_update>');
  assert.deepEqual(extractScripts(parsed).map((s) => s.field), ['my_script']);
});

// ---- script analysis ----------------------------------------------------------------------

test('hard-coded sys_ids are found in strings, not in comments', () => {
  const code = `var g = '${ID1}'; // not '${ID2}'\n/* '${ID3}' */\nvar q = "assignment_group=${ID2}^active=true";`;
  const found = findHardcodedSysIds(code);
  assert.deepEqual(found, [
    { line: 1, sysId: ID1 },
    { line: 3, sysId: ID2 },
  ]);
  const scan = scanScript('var a = "x"; // c\nb();');
  assert.ok(!scan.code.includes('// c'));
  assert.equal(scan.strings[0].text, 'x');
});

test('Script Include references skip platform APIs, strings and comments', () => {
  const code = [
    'var util = new MyUtils();',
    'var r = global.OtherUtil.doThing(current);',
    'var gr = new GlideRecord("incident"); gs.info(JSON.stringify(Math.max(1, 2)));',
    '// new CommentedOut()',
    'var s = "new InString()";',
    "var ga = new GlideAjax('x_acme_app.AjaxHelper');",
    'var d = new GlideDateTime(); var a = new ArrayUtil();',
  ].join('\n');
  assert.deepEqual(findScriptIncludeRefs(code), ['AjaxHelper', 'MyUtils', 'OtherUtil']);
  assert.deepEqual(findCustomTableRefs("new GlideRecord('u_widget'); new GlideAggregate(\"x_acme_order\"); new GlideRecord('incident');"), ['u_widget', 'x_acme_order']);
});

test('analyseEntryScripts verifies known kinds and flags syntax errors', () => {
  const xml = `<record_update table="sys_script"><sys_script action="INSERT_OR_UPDATE"><name>Broken</name><when>before</when><collection>incident</collection>
<script><![CDATA[(function executeRule(current, previous) {
  var id = '${ID1}';
  new MyHelper().run(current;
})(current, previous);]]></script><condition>current.active == true</condition></sys_script></record_update>`;
  const scripts = analyseEntryScripts({ sys_id: ID2, name: `sys_script_${ID3}`, target_name: 'Broken', type: 'Business Rule' }, xml);
  assert.equal(scripts.length, 2);
  const main = scripts.find((s) => s.field === 'script');
  assert.equal(main.kind, 'business_rule');
  assert.equal(main.syntaxError, true);
  assert.deepEqual(main.sysIds.map((x) => x.sysId), [ID1]);
  assert.deepEqual(main.scriptIncludes, ['MyHelper']);
  const cond = scripts.find((s) => s.field === 'condition');
  assert.equal(cond.kind, null);
  assert.deepEqual(cond.scriptIncludes, []);
});

// ---- checklist ------------------------------------------------------------------------------

const set = { sys_id: ID1, name: 'STRY001 - widget', state: 'in progress', application: 'global', applicationName: 'Global', description: 'Adds a widget' };
const entry = (over = {}) => ({
  sys_id: ID2,
  name: `sys_script_include_${ID3}`,
  type: 'Script Include',
  target_name: 'WidgetUtil',
  action: 'INSERT_OR_UPDATE',
  application: 'global',
  sys_updated_on: '2026-10-01 10:00:00',
  ...over,
});

test('checklist: a clean set is ready', () => {
  const r = buildShipChecklist({ set, entries: [entry()], totalEntries: 1 });
  assert.equal(r.verdict, 'ready');
  assert.ok(r.checks.every((c) => c.status === 'ok' || c.status === 'info'));
});

test('checklist: empty sets and sets flagged Default are blockers; a Default-like name is only a note', () => {
  assert.equal(buildShipChecklist({ set, entries: [], totalEntries: 0 }).verdict, 'blockers');
  const flagged = buildShipChecklist({ set: { ...set, name: 'Default', defaultFlag: 'true' }, entries: [entry()], totalEntries: 1 });
  assert.equal(flagged.verdict, 'blockers');
  assert.ok(flagged.checks.some((c) => c.id === 'default' && c.status === 'block'));
  assert.equal(buildShipChecklist({ set: { ...set, isDefault: true }, entries: [entry()], totalEntries: 1 }).verdict, 'blockers');

  const named = buildShipChecklist({ set: { ...set, name: 'Default priority fixes', defaultFlag: 'false' }, entries: [entry()], totalEntries: 1 });
  assert.equal(named.verdict, 'ready');
  assert.match(named.checks.find((c) => c.id === 'default-name').detail, /flag is off/);
  // Flag not readable: still not a blocker, and the note says so.
  const unknown = buildShipChecklist({ set: { ...set, name: 'Default', defaultFlag: null, isDefault: true }, entries: [entry()], totalEntries: 1 });
  assert.equal(unknown.verdict, 'ready');
  assert.match(unknown.checks.find((c) => c.id === 'default-name').detail, /could not be read/);
});

test('checklist: overlaps with in-progress sets warn, with complete sets are notes; truncation says why', () => {
  const c = (state) => ({ name: entry().name, type: 'Script Include', targetName: 'WidgetUtil', updatedOn: '2026-10-01', conflictsWith: [{ updateSetName: 'Done', updateSetState: state, updatedOn: '2026-09-01' }] });
  const done = buildShipChecklist({ set, entries: [entry()], totalEntries: 1, collisions: [c('complete')] });
  assert.equal(done.verdict, 'ready');
  assert.equal(done.checks.find((x) => x.id === 'collisions-complete').status, 'info');
  assert.equal(done.checks.find((x) => x.id === 'collisions').status, 'ok');
  const open = buildShipChecklist({ set, entries: [entry()], totalEntries: 1, collisions: [c('in progress')] });
  assert.equal(open.checks.find((x) => x.id === 'collisions').status, 'warn');
  assert.match(open.checks.find((x) => x.id === 'collisions').title, /in-progress/);
  const cut = buildShipChecklist({ set, entries: [entry()], totalEntries: 1, collisionsTruncated: '3 entries had too many matches to read completely' });
  assert.equal(cut.verdict, 'warnings');
  assert.match(cut.checks.find((x) => x.id === 'collisions-truncated').detail, /^3 entries had too many/);
});

test('checklist: skipped scripts make the script check incomplete, never Ready', () => {
  const clean = Array.from({ length: 60 }, (_, i) => ({ entrySysId: `e${i}`, targetName: `S${i}`, field: 'script', findings: [], syntaxError: false, high: 0, sysIds: [], scriptIncludes: [], tables: [] }));
  const r = buildShipChecklist({ set, entries: [entry()], totalEntries: 1, scripts: clean, scriptsSkipped: 40, scriptRecordsChecked: 60 });
  assert.equal(r.verdict, 'warnings');
  assert.equal(r.checks.find((x) => x.id === 'scripts-partial').title, '60 of 100 script records checked');
  assert.equal(r.checks.find((x) => x.id === 'scripts').title, 'No problems in the scripts checked');
});

test('dictionary update names are exact, so u_x does not match columns of u_x_y', () => {
  const names = dictionaryUpdateNames('u_x', ['u_a', '']);
  assert.deepEqual([...names], ['sys_dictionary_u_x_null', 'sys_dictionary_u_x_u_a']);
  assert.equal(names.has('sys_dictionary_u_x_y_u_a'), false);
});

test('checklist: collisions, deletes, scope, risky types, truncation and failed steps are warnings', () => {
  const collisions = [
    { name: entry().name, type: 'Script Include', targetName: 'WidgetUtil', updatedOn: '2026-10-01 10:00:00', conflictsWith: [{ updateSetName: 'Other', updateSetState: 'in progress', updatedOn: '2026-10-02 10:00:00', updatedBy: 'bob' }] },
  ];
  const entries = [
    entry(),
    entry({ sys_id: ID3, name: `sys_security_acl_${ID1}`, type: 'Access Control', target_name: 'incident.write', action: 'DELETE' }),
    entry({ sys_id: ID1, name: `sys_properties_${ID2}`, type: 'System Property', target_name: 'x.prop', application: 'abc' }),
  ];
  const r = buildShipChecklist({ set, entries, totalEntries: 600, collisions, errors: [{ step: 'Dependency check', message: 'boom' }] });
  assert.equal(r.verdict, 'warnings');
  const ids = r.checks.map((c) => c.id);
  ['collisions', 'deletes', 'scope', 'risky-acl', 'risky-property', 'truncated', 'errors'].forEach((id) => assert.ok(ids.includes(id), id));
  assert.match(r.checks.find((c) => c.id === 'collisions').detail, /newer version/);
  assert.equal(riskyKind({ name: `sys_user_role_${ID1}`, type: 'Role' }).id, 'role');
  // Sorted: warnings before notes/ok.
  assert.equal(r.checks[0].status, 'warn');
});

test('checklist: syntax errors block; sys_ids shipped in the same set are only a note; dependencies warn', () => {
  const scripts = [
    { entrySysId: ID2, targetName: 'WidgetUtil', field: 'script', findings: [{ ruleId: 'syntax-error', severity: 'high', line: 3, message: 'Syntax: x' }], syntaxError: true, high: 1, sysIds: [], scriptIncludes: [], tables: [] },
  ];
  assert.equal(buildShipChecklist({ set, entries: [entry()], totalEntries: 1, scripts }).verdict, 'blockers');

  const withIds = [{ entrySysId: ID2, targetName: 'WidgetUtil', field: 'script', findings: [], syntaxError: false, high: 0, sysIds: [{ line: 2, sysId: ID3 }], scriptIncludes: [], tables: [] }];
  const inSet = buildShipChecklist({ set, entries: [entry()], totalEntries: 1, scripts: withIds });
  assert.equal(inSet.checks.find((c) => c.id === 'sysids').status, 'info');
  const elsewhere = buildShipChecklist({ set, entries: [entry({ name: `sys_script_include_${ID1}` })], totalEntries: 1, scripts: withIds });
  assert.equal(elsewhere.checks.find((c) => c.id === 'sysids').status, 'warn');

  const deps = buildShipChecklist({
    set,
    entries: [entry()],
    totalEntries: 1,
    dependencies: [{ kind: 'script_include', name: 'Helper', calledFrom: ['WidgetUtil'], otherSets: [{ name: 'Other', state: 'in progress' }] }],
  });
  assert.equal(deps.verdict, 'warnings');
  assert.match(deps.checks.find((c) => c.id === 'dependencies').items[0].detail, /"Other"/);
});

test('release notes group by type, mark deletions and escape Markdown', () => {
  const notes = buildReleaseNotes({
    set,
    entries: [
      entry({ type: 'Business Rule', target_name: 'b_rule *bold*' }),
      entry({ type: 'Business Rule', target_name: 'a rule', action: 'DELETE' }),
      entry(),
    ],
  });
  assert.match(notes, /^# STRY001 - widget/);
  assert.match(notes, /## Business Rule \(2\)\n- a rule \*\*\(deleted\)\*\*\n- b\\_rule \\\*bold\\\*/);
  assert.ok(notes.indexOf('## Business Rule') < notes.indexOf('## Script Include'));
  const checklist = buildShipChecklist({ set, entries: [entry()], totalEntries: 1 });
  const md = shipCheckToMarkdown({ set, checklist, releaseNotes: notes, host: 'dev1.service-now.com' });
  assert.match(md, /Verdict: \*\*Ready to commit\*\*/);
  const capped = buildReleaseNotes({ set, entries: [entry()], total: 700 });
  assert.match(capped, /1 of 700 changes listed/);
  assert.match(capped, /699 more changes are not listed/);
});

test('AI prompt is redacted', () => {
  const checklist = buildShipChecklist({ set, entries: [entry()], totalEntries: 1 });
  const prompt = buildShipCheckPrompt({ set, checklist, releaseNotes: 'password = "hunter2"' });
  assert.ok(!prompt.includes('hunter2'));
  assert.match(prompt, /REDACTED/);
});

// ---- moving entries -----------------------------------------------------------------------

test('planMove blocks other scopes, Default and closed sets; skips entries already there', () => {
  const target = { sys_id: ID1, name: 'Target', state: 'in progress', application: 'global', is_default: 'false' };
  const plan = planMove({
    target,
    entries: [
      { sys_id: '1', update_set: ID2, 'update_set.state': 'in progress', application: 'global' },
      { sys_id: '2', update_set: ID1, 'update_set.state': 'in progress', application: 'global' },
      { sys_id: '3', update_set: ID2, 'update_set.state': 'in progress', application: 'x_app' },
    ],
  });
  assert.deepEqual(plan.moves.map((e) => e.sys_id), ['1']);
  assert.deepEqual(plan.skipped.map((s) => s.entry.sys_id), ['2']);
  assert.deepEqual(plan.blocked.map((s) => s.entry.sys_id), ['3']);
  assert.equal(planMove({ target: { ...target, state: 'complete' }, entries: [{ sys_id: '1', update_set: ID2, 'update_set.state': 'in progress' }] }).blocked.length, 1);
  assert.equal(planMove({ target: { ...target, is_default: 'true' }, entries: [{ sys_id: '1', update_set: ID2, 'update_set.state': 'in progress' }] }).blocked.length, 1);
  assert.equal(planMove({ target: null, entries: [{ sys_id: '1' }] }).blocked.length, 1);
});

test('planMove: a Default-like name is a warning, not a block; a record already in the target is skipped', () => {
  const target = { sys_id: ID1, name: 'Default priority fixes', state: 'in progress', application: 'global', is_default: 'false' };
  const named = planMove({ target, entries: [{ sys_id: '1', name: 'a', update_set: ID2, 'update_set.state': 'in progress', application: 'global' }] });
  assert.equal(named.moves.length, 1);
  assert.match(named.warnings[0], /ordinary named set/);
  const unknown = planMove({ target: { ...target, name: 'Default', is_default: undefined }, entries: [{ sys_id: '1', name: 'a', update_set: ID2, 'update_set.state': 'in progress' }] });
  assert.equal(unknown.moves.length, 1);
  assert.match(unknown.warnings[0], /could not be read/);
  const dup = planMove({ target, targetNames: ['a'], entries: [{ sys_id: '1', name: 'a', update_set: ID2, 'update_set.state': 'in progress' }, { sys_id: '2', name: 'b', update_set: ID2, 'update_set.state': 'in progress' }] });
  assert.deepEqual(dup.moves.map((e) => e.sys_id), ['2']);
  assert.match(dup.skipped[0].reason, /already holds a version/);
});

test('planMove: entries are never moved out of a complete, ignored or unreadable set', () => {
  const target = { sys_id: ID1, name: 'Target', state: 'in progress', application: 'global', is_default: 'false' };
  const plan = planMove({
    target,
    entries: [
      { sys_id: '1', update_set: ID2, 'update_set.state': 'complete', 'update_set.name': 'Shipped' },
      { sys_id: '2', update_set: ID2, 'update_set.state': 'ignore' },
      { sys_id: '3', update_set: ID2 },
      { sys_id: '4', update_set: ID2, 'update_set.state': 'in progress' },
    ],
  });
  assert.deepEqual(plan.moves.map((e) => e.sys_id), ['4']);
  assert.deepEqual(plan.blocked.map((b) => b.entry.sys_id), ['1', '2', '3']);
  assert.match(plan.blocked[0].reason, /is complete \("Shipped"\)/);
  assert.match(plan.blocked[2].reason, /could not be read/);
});

test('typed confirmation matches the instance name only', () => {
  assert.equal(confirmMatches(' AcmeProd ', 'acmeprod'), true);
  assert.equal(confirmMatches('acme', 'acmeprod'), false);
  assert.equal(confirmMatches('', ''), false);
});

// ---- My work helpers ------------------------------------------------------------------------

test('picker and aggregate responses are read leniently', () => {
  assert.deepEqual(parsePickerCurrent({ result: { current: { sysId: ID1, name: 'Mine' } } }), { sysId: ID1, name: 'Mine' });
  assert.deepEqual(parsePickerCurrent({ result: { current: { sys_id: 'global', displayValue: 'Global' } } }), { sysId: 'global', name: 'Global' });
  // The shape a live Australia instance returns for the application picker: the id as a string, the names in a list.
  assert.deepEqual(
    parsePickerCurrent({ result: { current: 'global', list: [{ sysId: ID1, name: 'Mine', scopeName: 'x_mine' }, { sysId: 'global', name: 'Global', scopeName: 'global' }] } }),
    { sysId: 'global', name: 'Global' }
  );
  assert.deepEqual(parsePickerCurrent({ result: { current: ID1, list: [{ sysId: ID1, name: 'Mine' }] } }), { sysId: ID1, name: 'Mine' });
  // An id that is not in the list, or has no name, is not guessed.
  assert.equal(parsePickerCurrent({ result: { current: ID1, list: [{ sysId: 'global', name: 'Global' }] } }), null);
  assert.equal(parsePickerCurrent({ result: { current: 'global', list: [] } }), null);
  assert.equal(parsePickerCurrent({ result: { list: [] } }), null);
  assert.equal(parsePickerCurrent(null), null);

  const many = parseGroupedStats(
    { result: [{ stats: { count: '3', max: { sys_updated_on: '2026-10-01 10:00:00' } }, groupby_fields: [{ field: 'update_set', value: ID1 }] }] },
    'update_set'
  );
  assert.deepEqual(many.get(ID1), { count: 3, max: { sys_updated_on: '2026-10-01 10:00:00' } });
  const one = parseGroupedStats({ result: { stats: { count: '1' }, groupby_fields: [{ field: 'update_set', value: ID2 }] } }, 'update_set');
  assert.equal(one.get(ID2).count, 1);
});

test('recent changes group by set; warnings for Default sets and scope mismatches', () => {
  const changes = [
    { sys_id: '1', update_set: ID1, 'update_set.name': 'Default', 'update_set.state': 'in progress', application: 'global', 'update_set.application': 'global' },
    { sys_id: '2', update_set: ID2, 'update_set.name': 'Mine', 'update_set.state': 'in progress', application: 'x_app', 'update_set.application': 'global' },
    { sys_id: '3', update_set: ID1, 'update_set.name': 'Default', 'update_set.state': 'in progress', application: 'global', 'update_set.application': 'global' },
  ];
  const groups = groupChangesBySet(changes);
  assert.deepEqual(groups.map((g) => [g.setName, g.changes.length, g.isDefault]), [
    ['Default', 2, true],
    ['Mine', 1, false],
  ]);
  const w = myWorkWarnings({ changes, currentSet: { name: 'Mine', application: 'global' }, currentApp: { sysId: 'x_app_id' } });
  assert.deepEqual(w.defaultChanges.map((c) => c.sys_id), ['1', '3']);
  assert.deepEqual(w.scopeMismatches.map((c) => c.sys_id), ['2']);
  assert.equal(w.currentMismatch, true);
  assert.equal(w.currentIsDefault, false);

  // A readable flag wins over the name.
  assert.equal(isDefaultSet('false', 'Default priority fixes'), false);
  assert.equal(isDefaultSet('true', 'Sprint 4'), true);
  assert.equal(isDefaultSet(undefined, 'Default'), true);
  const flagged = myWorkWarnings({ changes: [{ sys_id: '9', update_set: ID3, 'update_set.name': 'Default priority fixes', 'update_set.is_default': 'false', 'update_set.state': 'in progress' }] });
  assert.equal(flagged.defaultChanges.length, 0);
});

// ---- update set queries (Table API stubbed) ----------------------------------------------------

function stubPageToken() {
  global.document = {
    documentElement: {
      hasAttribute() {
        throw new Error('no bridge in tests');
      },
    },
    getElementById: () => null,
    querySelector: (sel) => (sel === 'input[name="sysparm_ck"]' ? { value: 'test-token' } : null),
    scripts: [],
  };
}

const okRows = (rows) => new Response(JSON.stringify({ result: rows }), { status: 200, headers: { 'content-type': 'application/json' } });

function routeTables(routes) {
  const calls = [];
  global.fetch = async (url) => {
    const u = new URL(url, 'https://dev1.service-now.com');
    const table = u.pathname.split('/').pop();
    const call = { table, query: u.searchParams.get('sysparm_query') || '', limit: Number(u.searchParams.get('sysparm_limit')), fields: u.searchParams.get('sysparm_fields') || '' };
    calls.push(call);
    return okRows(routes[table] ? routes[table](call) : []);
  };
  return calls;
}

test('expected update names follow the record class and the dictionary convention', () => {
  assert.equal(expectedUpdateName('sys_script_client', { sys_id: ID1, sys_class_name: 'catalog_script_client' }), `catalog_script_client_${ID1}`);
  assert.equal(expectedUpdateName('sys_script', { sys_id: ID1 }), `sys_script_${ID1}`);
  assert.equal(expectedUpdateName('sys_dictionary', { sys_id: ID1, name: 'incident', element: 'u_x' }), 'sys_dictionary_incident_u_x');
  assert.equal(expectedUpdateName('sys_dictionary', { sys_id: ID1, name: 'u_t', element: '' }), 'sys_dictionary_u_t_null');
});

test('uncaptured changes: catalog client scripts and dictionary entries are matched by their real update names', async () => {
  stubPageToken();
  const calls = routeTables({
    sys_script_client: () => [{ sys_id: ID1, name: 'Cat CS', sys_class_name: 'catalog_script_client', sys_updated_on: 'x', sys_updated_by: 'me' }],
    sys_dictionary: () => [{ sys_id: ID2, element: 'u_x', name: 'incident', sys_class_name: 'sys_dictionary', sys_updated_on: 'x', sys_updated_by: 'me' }],
    sys_script: () => [{ sys_id: ID3, name: 'BR', sys_class_name: 'sys_script', sys_updated_on: 'x', sys_updated_by: 'me' }],
    sys_update_xml: () => [{ name: `catalog_script_client_${ID1}` }, { name: 'sys_dictionary_incident_u_x' }],
  });
  const r = await findUncapturedChanges({ days: 7, updatedBy: 'me' });
  assert.deepEqual(r.uncaptured.map((u) => u.name), ['BR']);
  assert.equal(r.checked, 3);
  assert.match(calls.find((c) => c.table === 'sys_dictionary').fields, /\bname\b.*element|element.*\bname\b/);
});

test('uncaptured changes: a capped lookup chunk reports nothing as uncaptured from that chunk', async () => {
  stubPageToken();
  routeTables({
    sys_script: () => [{ sys_id: ID3, name: 'BR', sys_updated_on: 'x', sys_updated_by: 'me' }],
    sys_update_xml: (call) => Array.from({ length: call.limit }, (_, i) => ({ name: `other_${i}` })),
  });
  const r = await findUncapturedChanges({ days: 7 });
  assert.equal(r.uncaptured.length, 0);
  assert.ok(r.errors.some((e) => /not listed/.test(e.error)));
});

test('collisions: other sets are filtered by state on the instance, re-checked here, and a capped chunk is reported', async () => {
  stubPageToken();
  const entries = [
    { sys_id: '1', name: 'sys_script_a', type: 'Business Rule', target_name: 'A', sys_updated_on: '2026-10-01' },
    { sys_id: '2', name: 'sys_script_b', type: 'Business Rule', target_name: 'B', sys_updated_on: '2026-10-01' },
  ];
  const calls = routeTables({
    sys_update_xml: () => [
      { name: 'sys_script_a', update_set: ID2, 'update_set.name': 'Open', 'update_set.state': 'in progress', sys_updated_on: '2026-10-02' },
      { name: 'sys_script_b', update_set: ID3, 'update_set.name': 'Done', 'update_set.state': 'complete' },
      { name: 'sys_script_a', update_set: ID1, 'update_set.name': 'This', 'update_set.state': 'in progress' },
      { name: 'sys_script_b', update_set: ID2, 'update_set.name': 'Old', 'update_set.state': 'ignore' },
      { name: 'sys_script_zzz', update_set: ID2, 'update_set.name': 'Open', 'update_set.state': 'in progress' },
    ],
  });
  const r = await findCollisionsForEntries(ID1, entries);
  assert.match(calls[0].query, new RegExp(`update_set!=${ID1}\\^update_set\\.stateINin progress,complete`));
  assert.equal(calls.length, 1, 'no list of recent sets is needed');
  assert.deepEqual(r.collisions.map((c) => [c.targetName, c.conflictsWith.map((o) => `${o.updateSetName}:${o.updateSetState}`)]), [
    ['A', ['Open:in progress']],
    ['B', ['Done:complete']],
  ]);
  assert.equal(r.truncated, false);

  routeTables({ sys_update_xml: (call) => Array.from({ length: call.limit }, () => ({ name: 'sys_script_a', update_set: ID2, 'update_set.state': 'in progress' })) });
  const capped = await findCollisionsForEntries(ID1, entries);
  assert.equal(capped.truncated, true);
  assert.match(capped.truncatedReason, /too many matches/);
});

test('timeAgo reads ServiceNow UTC timestamps', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  assert.equal(timeAgo('2026-10-16 11:59:30', now), 'just now');
  assert.equal(timeAgo('2026-10-16 11:30:00', now), '30 min ago');
  assert.equal(timeAgo('2026-10-15 12:00:00', now), '24 h ago');
  assert.equal(timeAgo('', now), '');
});

// ---- push ---------------------------------------------------------------------------------------

test('pushable fields never include sys_* columns, except sys_id on create', () => {
  const rec = { sys_id: ID1, sys_updated_on: 'x', sys_scope: 'global', name: 'A', script: 's', 'ref.name': 'x', collection: { value: 'incident', link: 'l' } };
  assert.deepEqual(pushableFields(rec, { mode: 'update' }), { name: 'A', script: 's', collection: 'incident' });
  assert.deepEqual(pushableFields(rec, { mode: 'create' }), { sys_id: ID1, name: 'A', script: 's', collection: 'incident' });
});

test('planPush: update writes only changed columns that exist on the target', () => {
  const source = { sys_id: ID1, name: 'BR', script: 'new', active: 'true', u_new: 'x', sys_scope: 'global', collection: ID3 };
  const target = { sys_id: ID2, name: 'BR', script: 'old', active: 'true', sys_scope: 'global', collection: ID2 };
  const plan = planPush({ table: 'sys_script', source, target, matchedBy: 'name' });
  assert.equal(plan.mode, 'update');
  assert.equal(plan.targetSysId, ID2);
  assert.deepEqual(plan.payload, { collection: ID3, script: 'new' });
  assert.deepEqual(plan.skipped, ['u_new']);
  assert.ok(plan.warnings.some((w) => /sys_ids differ/.test(w)));
  assert.ok(plan.warnings.some((w) => /collection points/.test(w)));
  assert.equal(plan.changes.find((c) => c.name === 'script').rows.length > 0, true);
  assert.equal(planPush({ table: 'sys_script', source, target: { ...target, script: 'new', collection: ID3 }, matchedBy: 'sys_id' }).mode, 'none');
});

test('planPush: create keeps the sys_id and refuses scoped records, data tables and password properties', () => {
  const create = planPush({ table: 'sys_script_include', source: { sys_id: ID1, name: 'U', script: 'x', api_name: 'global.U', sys_scope: 'global', description: '' }, target: null });
  assert.equal(create.mode, 'create');
  assert.deepEqual(create.payload, { api_name: 'global.U', name: 'U', script: 'x', sys_id: ID1 });
  assert.ok(planPush({ table: 'sys_script_include', source: { sys_id: ID1, name: 'U', sys_scope: ID2 }, target: null }).blockers.length);
  assert.ok(planPush({ table: 'incident', source: { sys_id: ID1, short_description: 'x' }, target: null }).blockers.length);
  assert.ok(planPush({ table: 'sys_properties', source: { sys_id: ID1, name: 'p', type: 'password2', value: 'enc' }, target: null }).blockers.length);
  assert.ok(refusalReason('sys_hub_flow'));
  assert.ok(refusalReason('sys_db_object'));
  assert.equal(refusalReason('sys_script'), null);
  assert.equal(refusalReason('sys_app_module'), null);
  assert.ok(refusalReason('sys_user'));
});

test('natural-key matching: query only with every key, rows re-checked exactly', () => {
  assert.deepEqual(matchQuery('sys_script', { name: 'BR', collection: 'incident' }), { query: 'name=BR^collection=incident', keys: ['name', 'collection'] });
  assert.equal(matchQuery('sys_script', { name: 'BR' }), null);
  assert.equal(matchQuery('sys_script_include', { name: 'a^ORname=b' }), null);
  assert.equal(matchQuery('sys_ui_policy', { name: 'x' }), null);
  const rows = [{ name: 'BR', collection: 'incident' }, { name: 'Other', collection: 'incident' }];
  assert.equal(pickKeyMatches(rows, { name: 'BR', collection: 'incident' }, ['name', 'collection']).length, 1);
  assert.equal(pickKeyMatches([{ name: 'br', collection: 'incident' }], { name: 'BR', collection: 'incident' }, ['name', 'collection']).length, 1);
});

test('write guard: only recognised dev/test/stage skip the typed name; a prod label wins', () => {
  assert.equal(writeGuard({ host: 'dev364920.service-now.com' }).guarded, false);
  assert.equal(writeGuard({ host: 'acme-test.service-now.com' }).guarded, false);
  assert.deepEqual(writeGuard({ host: 'acmeprod.service-now.com' }), { instance: 'acmeprod', env: 'prod', guarded: true, prod: true });
  assert.equal(writeGuard({ host: 'acme.service-now.com' }).guarded, true);
  assert.equal(writeGuard({ host: 'acme-dev.service-now.com', label: 'Production mirror' }).prod, true);
});

test('service-worker payload sanitising and post-write verification', () => {
  assert.deepEqual(sanitizePushPayload({ name: 'a', sys_updated_by: 'x', sys_id: ID1 }, { mode: 'update' }), { name: 'a' });
  assert.deepEqual(sanitizePushPayload({ name: 'a', sys_id: ID1 }, { mode: 'create' }), { name: 'a', sys_id: ID1 });
  assert.throws(() => sanitizePushPayload({ sys_id: ID1 }, { mode: 'create' }), /Nothing to push/);
  assert.throws(() => sanitizePushPayload({ 'bad name': 'x' }, { mode: 'update' }), /Invalid field/);
  assert.throws(() => sanitizePushPayload({ name: { value: 'x' } }, { mode: 'update' }), /plain value/);
  assert.throws(() => sanitizePushPayload({ name: 'a', sys_id: 'nope' }, { mode: 'create' }), /Invalid sys_id/);
  assert.deepEqual(verifyWrite({ script: 'a\nb', active: 'true', sys_id: ID1 }, { script: 'a\r\nb', active: 'false' }), ['active']);
});

// ---- service worker: cross-instance write path (fetch and chrome stubbed) -------------------------

const { writeRecord } = require('../src/background/instanceClient.js');
const { handlePushArtifact, handlePushPreview } = require('../src/background/push.js');

function installChrome({ creds = {}, instances = [] } = {}) {
  const store = { mysnowbuddy_instance_credentials: creds, mysnowbuddy_known_instances: instances };
  global.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (obj) => Object.assign(store, obj),
      },
    },
  };
  return store;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json;charset=UTF-8' } });
const html = (status, body) => new Response(body, { status, headers: { 'content-type': 'text/html' } });

function stubFetch(responses) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  };
  return calls;
}

const sender = { tab: { url: 'https://dev111.service-now.com/sys_script.do' } };

test('writeRecord: a 401 on the session falls back to saved Basic credentials, once', async () => {
  installChrome({ creds: { 'dev222.service-now.com': { username: 'u', password: 'p' } } });
  const calls = stubFetch([json(401, { error: { message: 'User Not Authenticated' } }), json(201, { result: { sys_id: ID1 } })]);
  const r = await writeRecord('dev222.service-now.com', 'sys_script', { method: 'POST', fields: { name: 'x' } });
  assert.equal(r.auth, 'basic');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.credentials, 'include');
  assert.match(calls[1].init.headers.Authorization, /^Basic /);
  assert.equal(calls[1].init.credentials, 'omit');
});

test('writeRecord: a 403 is reported, never retried; a login page without credentials is an error', async () => {
  installChrome();
  let calls = stubFetch([json(403, { error: { message: 'ACL' } })]);
  await assert.rejects(writeRecord('dev222.service-now.com', 'sys_script', { method: 'PATCH', sysId: ID1, fields: { name: 'x' } }), /refused the write \(403\): ACL/);
  assert.equal(calls.length, 1);
  calls = stubFetch([html(200, '<html><form action="login.do">')]);
  await assert.rejects(writeRecord('dev222.service-now.com', 'sys_script', { method: 'PATCH', sysId: ID1, fields: { name: 'x' } }), /add credentials/);
  assert.equal(calls.length, 1);
  await assert.rejects(writeRecord('evil.example.com', 'sys_script', { method: 'POST', fields: {} }), /Invalid instance URL/);
});

test('push: a guarded target needs its typed name before anything is sent', async () => {
  installChrome();
  const calls = stubFetch([]);
  const payload = { targetUrl: 'acmeprod.service-now.com', table: 'sys_script', mode: 'update', targetSysId: ID2, fields: { script: 'x' }, sourceHost: 'dev111.service-now.com', sourceRecord: { sys_id: ID1, name: 'BR', script: 'x' }, matchedBy: 'name' };
  await assert.rejects(handlePushArtifact(payload, sender), /Type "acmeprod"/);
  await assert.rejects(handlePushArtifact({ ...payload, confirmName: 'acme' }, sender), /Type "acmeprod"/);
  // A known-instance label saying prod guards a dev-looking host too.
  installChrome({ instances: [{ host: 'acme-dev.service-now.com', label: 'Prod mirror' }] });
  await assert.rejects(handlePushArtifact({ ...payload, targetUrl: 'acme-dev.service-now.com' }, sender), /Type "acme-dev"/);
  assert.equal(calls.length, 0);
  await assert.rejects(handlePushArtifact({ ...payload, table: 'sys_hub_flow' }, sender), /update set/);
  await assert.rejects(handlePushArtifact(payload, { tab: { url: 'https://example.com/' } }), /ServiceNow page/);
});

test('push: update re-reads the target, refuses a stale preview, writes, verifies and audits', async () => {
  const store = installChrome();
  const target = { sys_id: ID2, name: 'BR', collection: 'incident', script: 'old', sys_updated_on: '2026-10-01 10:00:00' };
  const payload = {
    targetUrl: 'dev222.service-now.com',
    table: 'sys_script',
    mode: 'update',
    targetSysId: ID2,
    fields: { script: 'new', sys_updated_by: 'ignored' },
    expectedUpdatedOn: '2026-10-01 10:00:00',
    sourceHost: 'dev111.service-now.com',
    sourceSysId: ID1,
    sourceRecord: { sys_id: ID1, name: 'BR', collection: 'incident', script: 'new', sys_updated_by: 'someone' },
    matchedBy: 'name',
  };

  stubFetch([json(200, { result: [{ ...target, sys_updated_on: '2026-10-02 09:00:00' }] })]);
  await assert.rejects(handlePushArtifact(payload, sender), /changed since the preview/);

  const calls = stubFetch([
    json(200, { result: [target] }),
    (url, init) => {
      assert.equal(init.method, 'PATCH');
      assert.deepEqual(JSON.parse(init.body), { script: 'new' });
      return json(200, { result: { ...target, script: 'new' } });
    },
    json(200, { result: [{ ...target, script: 'new' }] }),
  ]);
  const r = await handlePushArtifact(payload, sender);
  assert.equal(r.ok, true);
  assert.equal(r.auth, 'session');
  assert.deepEqual(r.written, ['script']);
  assert.deepEqual(r.mismatched, []);
  assert.equal(r.url, `https://dev222.service-now.com/sys_script.do?sys_id=${ID2}`);
  assert.equal(calls.length, 3);
  const audit = store.mysnowbuddy_agent_audit;
  assert.equal(audit[0].tool, 'push_artifact');
  assert.equal(audit[0].instance, 'dev222.service-now.com');
  assert.deepEqual(audit[0].args.previous, { script: 'old' });
});

test('push preview: the same instance is refused; refused tables skip the target lookup', async () => {
  installChrome();
  stubFetch([]);
  await assert.rejects(
    handlePushPreview({ targetUrl: 'dev111.service-now.com', table: 'sys_script', sourceRecord: { sys_id: ID1, name: 'x' } }, sender),
    /same instance/
  );
  const r = await handlePushPreview({ targetUrl: 'dev222.service-now.com', table: 'sys_hub_flow', sourceRecord: { sys_id: ID1, name: 'x' } }, sender);
  assert.ok(r.refused);
  assert.equal(r.target, null);
});

test('push preview: matches by sys_id, then by natural key with an exact re-check', async () => {
  installChrome();
  const source = { sys_id: ID1, name: 'BR', collection: 'incident', script: 'x' };
  // sys_id miss, then the key query returns an unrelated row (as if the condition were ignored), then the session lookup fails.
  stubFetch([
    json(200, { result: [] }),
    json(200, { result: [{ sys_id: ID3, name: 'Other', collection: 'incident' }] }),
    json(500, { error: { message: 'x' } }),
  ]);
  let r = await handlePushPreview({ targetUrl: 'dev222.service-now.com', table: 'sys_script', sourceRecord: source }, sender);
  assert.equal(r.target, null);
  assert.equal(r.matchedBy, null);
  assert.equal(r.session, null);

  stubFetch([json(200, { result: [] }), json(200, { result: [{ sys_id: ID3, name: 'BR', collection: 'incident' }] }), json(500, {})]);
  r = await handlePushPreview({ targetUrl: 'dev222.service-now.com', table: 'sys_script', sourceRecord: source }, sender);
  assert.equal(r.matchedBy, 'name');
  assert.equal(r.target.sys_id, ID3);
  assert.equal(r.guard.guarded, false);
  assert.equal(r.nameCaseDiffers, false);

  stubFetch([json(200, { result: [] }), json(200, { result: [{ sys_id: ID3, name: 'br', collection: 'incident' }] }), json(500, {})]);
  r = await handlePushPreview({ targetUrl: 'dev222.service-now.com', table: 'sys_script', sourceRecord: source }, sender);
  assert.equal(r.matchedBy, 'name');
  assert.equal(r.nameCaseDiffers, true);
});

// ---- safety review follow-ups -----------------------------------------------------------------------

const { isAuthRejection } = require('../src/background/instanceClient.js');

test('writes are retried with Basic auth only after a 401 or a login page, never after other failures', async () => {
  const res = (status, body, type) => new Response(body, { status, headers: { 'content-type': type } });
  assert.equal(isAuthRejection(res(401, '{}', 'application/json'), '{}'), true);
  assert.equal(isAuthRejection(res(200, '<form action="login.do">', 'text/html'), '<form action="login.do">'), true);
  assert.equal(isAuthRejection(res(502, '<html>Bad gateway</html>', 'text/html'), '<html>Bad gateway</html>'), false);
  assert.equal(isAuthRejection(res(200, '<html>maintenance</html>', 'text/html'), '<html>maintenance</html>'), false);

  installChrome({ creds: { 'dev222.service-now.com': { username: 'u', password: 'p' } } });
  let calls = stubFetch([html(504, '<html>Gateway timeout</html>')]);
  await assert.rejects(writeRecord('dev222.service-now.com', 'sys_script', { method: 'POST', fields: { name: 'x' } }), /may or may not have been saved/);
  assert.equal(calls.length, 1, 'a 504 after the server may have saved is never retried');
  calls = stubFetch([html(200, '<html>Something else</html>')]);
  await assert.rejects(writeRecord('dev222.service-now.com', 'sys_script', { method: 'PATCH', sysId: ID1, fields: { name: 'x' } }), /may or may not have been saved/);
  assert.equal(calls.length, 1);
});

test('the worker re-plans the push: planner blockers, case-only matches and payload drift are refused', async () => {
  installChrome();
  const base = { targetUrl: 'dev222.service-now.com', sourceHost: 'dev111.service-now.com', sourceSysId: ID1 };

  // Password property (create): blocked by the planner even though the page sent the fields.
  stubFetch([json(200, { result: [] })]);
  await assert.rejects(
    handlePushArtifact(
      { ...base, table: 'sys_properties', mode: 'create', fields: { name: 'p', type: 'password2', value: 'enc', sys_id: ID1 }, sourceRecord: { sys_id: ID1, name: 'p', type: 'password2', value: 'enc' } },
      sender
    ),
    /Password properties/
  );

  // New record in a scoped app.
  stubFetch([json(200, { result: [] })]);
  await assert.rejects(
    handlePushArtifact(
      { ...base, table: 'sys_script_include', mode: 'create', fields: { name: 'U', sys_id: ID1 }, sourceRecord: { sys_id: ID1, name: 'U', sys_scope: ID3 } },
      sender
    ),
    /scoped application/
  );

  // Case-only name match: refused until confirmed.
  const target = { sys_id: ID2, name: 'br', collection: 'incident', script: 'old', sys_updated_on: 't1' };
  const update = {
    ...base,
    table: 'sys_script',
    mode: 'update',
    targetSysId: ID2,
    expectedUpdatedOn: 't1',
    matchedBy: 'name',
    fields: { name: 'BR', script: 'new' },
    sourceRecord: { sys_id: ID1, name: 'BR', collection: 'incident', script: 'new' },
  };
  stubFetch([json(200, { result: [target] })]);
  await assert.rejects(handlePushArtifact(update, sender), /letter case/);
  const calls = stubFetch([json(200, { result: [target] }), json(200, { result: { ...target, name: 'BR', script: 'new' } }), json(200, { result: [{ ...target, name: 'BR', script: 'new' }] })]);
  const r = await handlePushArtifact({ ...update, confirmCaseMatch: true }, sender);
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(calls[1].init.body), { name: 'BR', script: 'new' });

  // Fields that differ from what the planner computes are refused (nothing is written).
  const drift = stubFetch([json(200, { result: [target] })]);
  await assert.rejects(handlePushArtifact({ ...update, confirmCaseMatch: true, fields: { name: 'BR', script: 'new', active: 'false' } }, sender), /differs from the preview/);
  assert.equal(drift.length, 1);

  // A sys_id match must still point at the source's own sys_id.
  stubFetch([json(200, { result: [{ ...target, sys_id: ID2 }] })]);
  await assert.rejects(handlePushArtifact({ ...update, matchedBy: 'sys_id' }, sender), /not the one the preview matched/);
});

test('a new update set needs a real, unused name and never "Default"', () => {
  assert.deepEqual(validateNewUpdateSetName('  STRY001   Fix caller  '), { ok: true, name: 'STRY001 Fix caller' });
  assert.equal(validateNewUpdateSetName('ab').ok, false);
  assert.equal(validateNewUpdateSetName('x'.repeat(81)).ok, false);
  assert.equal(validateNewUpdateSetName('Default').ok, false);
  assert.equal(validateNewUpdateSetName('default [Global]').ok, false);
  assert.equal(validateNewUpdateSetName('Default value fix').ok, true, 'a name that merely starts with the word is fine');
  const clash = validateNewUpdateSetName('stry001 fix', ['STRY001 Fix']);
  assert.equal(clash.ok, false);
  assert.match(clash.error, /already in progress/);
  assert.equal(validateNewUpdateSetName(null).ok, false);
});
