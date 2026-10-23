const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const lib = require('../src/lib/previewProblems.js');

// A stable fake sys_id for a label (problem ids and update ids are sys_ids on a real instance).
const sid = (label) => crypto.createHash('md5').update(label).digest('hex');

const {
  mapProblemColumns,
  normalizeProblem,
  statusKind,
  classifyProblem,
  extractClues,
  searchesFor,
  providerSearches,
  providerQuery,
  rowMatchesSearch,
  matchProviders,
  payloadStamp,
  buildCollision,
  prepareProblems,
  buildVerdict,
  buildChecklist,
  nextStep,
  commitOrder,
  edgesFromProblems,
  buildAnalysis,
  setStateKind,
  normalizeSet,
  previewProblemsMarkdown,
  recordPath,
  versionsPath,
  KINDS,
  KIND_ORDER,
} = lib;

const ID = {
  group: '9f4b2a8c6b0e4d1fa3c25a8e7d3b1c40',
  script: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  rule: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  setA: '11111111111111111111111111111111',
  setB: '22222222222222222222222222222222',
  setC: '33333333333333333333333333333333',
};

const FIELDS = [
  { name: 'sys_id', label: 'Sys ID', type: 'GUID' },
  { name: 'remote_update_set', label: 'Remote update set', type: 'reference', reference: 'sys_remote_update_set' },
  { name: 'remote_update', label: 'Remote update', type: 'reference', reference: 'sys_update_xml' },
  { name: 'type', label: 'Type', type: 'string' },
  { name: 'description', label: 'Description', type: 'string' },
  { name: 'status', label: 'Status', type: 'string' },
  // The real column set (confirmed live 2026-10-23); missing_item_update's type is not confirmed (a reference here).
  { name: 'missing_item', label: 'Missing item', type: 'string' },
  { name: 'missing_item_table', label: 'Missing item table', type: 'table_name' },
  { name: 'missing_item_update', label: 'Missing item update', type: 'reference', reference: 'sys_update_xml' },
  { name: 'available_actions', label: 'Available actions', type: 'string' },
  { name: 'sys_created_on', label: 'Created', type: 'glide_date_time' },
];

// ---- columns -----------------------------------------------------------------------------------

test('columns are recognised by what a reference points at, then by name', () => {
  const map = mapProblemColumns(FIELDS);
  assert.equal(map.ok, true);
  assert.equal(map.set, 'remote_update_set');
  assert.equal(map.update, 'remote_update');
  assert.equal(map.type, 'type');
  assert.equal(map.description, 'description');
  assert.equal(map.status, 'status');
  assert.deepEqual(map.missing, ['severity']);
  assert.ok(map.columns.includes('sys_id') && map.columns.includes('remote_update_set'));

  // A set column with an unexpected name is still found through its reference table; the status falls back to "state".
  const odd = mapProblemColumns([
    { name: 'parent_set', reference: 'sys_remote_update_set' },
    { name: 'target_update', reference: 'sys_update_xml' },
    { name: 'problem_type' },
    { name: 'message' },
    { name: 'state' },
  ]);
  assert.equal(odd.set, 'parent_set');
  assert.equal(odd.update, 'target_update');
  assert.equal(odd.type, 'problem_type');
  assert.equal(odd.description, 'message');
  assert.equal(odd.status, 'state');
});

test('with several references to updates the remote one wins; a table with no set column is not usable', () => {
  const map = mapProblemColumns([
    { name: 'local_update', reference: 'sys_update_xml' },
    { name: 'remote_update', reference: 'sys_update_xml' },
    { name: 'remote_update_set', reference: 'sys_remote_update_set' },
  ]);
  assert.equal(map.update, 'remote_update');
  assert.deepEqual(map.otherUpdates, ['local_update']);
  const none = mapProblemColumns([{ name: 'description' }]);
  assert.equal(none.ok, false);
  assert.ok(none.missing.includes('set'));
  assert.equal(mapProblemColumns([]).ok, false);
  assert.equal(mapProblemColumns(null).ok, false);
});

test('status words map to unresolved, skipped, accepted and resolved; unclear ones are treated as open', () => {
  assert.equal(statusKind('', ''), 'unresolved');
  assert.equal(statusKind('', 'Unresolved'), 'unresolved');
  assert.equal(statusKind('skipped', 'Skipped Remote Update'), 'skipped');
  assert.equal(statusKind('accepted', 'Accepted Remote Update'), 'accepted');
  // "Ignored" is what Accept remote update is believed to record: never read it as a skip.
  assert.equal(statusKind('ignored', 'Ignored'), 'ignored');
  assert.equal(statusKind('resolved', 'Resolved'), 'resolved');
  assert.equal(statusKind('7', 'Mystery'), 'unknown');
});

test('a row read with display values becomes a plain problem', () => {
  const map = mapProblemColumns(FIELDS);
  const p = normalizeProblem(
    {
      sys_id: { value: 'p1', display_value: 'p1' },
      remote_update_set: { value: ID.setA, display_value: 'Payroll release 4' },
      remote_update: { value: ID.script, display_value: 'sys_script_include_x' },
      type: { value: 'warning', display_value: 'Warning' },
      description: { value: 'Missing thing', display_value: 'Missing thing' },
      status: { value: '', display_value: '' },
      sys_created_on: { value: '2026-10-20 10:00:00', display_value: '2026-10-20 10:00:00' },
    },
    map
  );
  assert.equal(p.sysId, 'p1');
  assert.equal(p.setId, ID.setA);
  assert.equal(p.severity, 'warning');
  assert.equal(p.status, 'unresolved');
  assert.equal(p.updateId, ID.script);
  // Plain string cells (display value off) work too.
  assert.equal(normalizeProblem({ sys_id: 'x', description: 'plain' }, map).description, 'plain');
});

// ---- classification --------------------------------------------------------------------------------

const CASES = [
  ['missing_reference', `Could not find a record in sys_user_group with sys_id ${ID.group} referenced by field assignment_group`],
  ['missing_reference', `Missing reference: ${ID.group} was not found`],
  ['missing_reference', `Reference field 'category' points to a record that does not exist (${ID.rule})`],
  ['missing_reference', `The record ${ID.group} does not exist on this instance`],
  ['collision', 'Found a local update that is newer than the remote update'],
  ['collision', 'Collision: this record was changed locally after the remote update was made'],
  ['collision', 'The local version of this record is more recent than the remote update'],
  ['collision', 'Remote update is older than the local update'],
  ['missing_table', "There is no table 'u_asset_tracker' on this instance"],
  ['missing_table', 'Table u_asset_tracker does not exist'],
  ['missing_table', 'Unknown table x_acme_orders'],
  ['missing_column', "Field 'u_cost_center' does not exist in table 'incident'"],
  ['missing_column', 'Column u_owner not found on u_asset_tracker'],
  ['missing_app', "The application 'Acme HR' (x_acme_hr) is not installed"],
  ['missing_app', 'Plugin com.snc.itom is not active'],
  ['missing_app', 'Missing application scope x_acme_hr'],
  ['unknown_type', 'Unknown update type: sys_hub_flow_snapshot'],
  ['unknown_type', 'Unsupported record type'],
  ['local_deleted', 'The record was deleted locally'],
  ['delete_missing', 'The remote update deletes a record that does not exist on this instance'],
  ['protected', 'This record is protected and cannot be modified'],
  ['older_version', 'The application version in the update set is older than the installed version'],
  ['generic', 'Something went sideways with the frobnicator'],
  ['generic', ''],
];

for (const [kind, text] of CASES) {
  test(`classifies "${text.slice(0, 60)}" as ${kind}`, () => {
    assert.equal(classifyProblem({ typeLabel: 'Error', description: text }).kind, kind);
  });
}

test('the type column is tried first, and an Error/Warning severity word is not mistaken for a kind', () => {
  assert.equal(classifyProblem({ typeLabel: 'Missing Reference', description: 'See the update' }).kind, 'missing_reference');
  assert.equal(classifyProblem({ typeLabel: 'Collision', description: '' }).by, 'type');
  assert.equal(classifyProblem({ typeLabel: 'Warning', description: 'Found a local update that is newer' }).kind, 'collision');
  assert.equal(classifyProblem({ typeLabel: 'Error', description: '' }).kind, 'generic');
});

test('the classifier never throws on odd input and every kind has a full explanation', () => {
  for (const input of [undefined, null, {}, { description: 42 }, { typeLabel: null, description: null }, { description: 'x'.repeat(50000) }]) {
    assert.doesNotThrow(() => classifyProblem(input));
  }
  assert.equal(lib.kindInfo('never_seen_before'), KINDS.generic);
  KIND_ORDER.forEach((k) => {
    const info = KINDS[k];
    assert.ok(info, `${k} has an entry`);
    ['label', 'short', 'meaning', 'why', 'wayOut', 'checkFirst', 'action', 'skipSafety'].forEach((field) => assert.ok(info[field], `${k}.${field}`));
    assert.ok(['safe', 'depends', 'risky'].includes(info.skipSafety));
  });
  assert.deepEqual([...KIND_ORDER].sort(), Object.keys(KINDS).sort());
});

test('no explanation uses wording the style guide forbids', () => {
  const all = JSON.stringify(KINDS);
  assert.doesNotMatch(all, /leverage|seamless|payload|utili[sz]e|robust/i);
});

// ---- clues ----------------------------------------------------------------------------------------

test('clues: sys_ids without the record the update is about, tables, and table.column pairs', () => {
  const text = `Could not find a record in sys_user_group with sys_id ${ID.group} referenced by sys_script.filter_condition (update ${ID.script})`;
  const clues = extractClues(text, { selfIds: [ID.script] });
  assert.deepEqual(clues.sysIds, [ID.group]);
  assert.ok(clues.tables.includes('sys_script'));
  assert.deepEqual(clues.columns, [{ table: 'sys_script', element: 'filter_condition' }]);

  const field = extractClues("Field 'u_cost_center' does not exist in table 'incident'");
  assert.deepEqual(field.tables, ['incident']);
  assert.deepEqual(field.columns, [{ table: 'incident', element: 'u_cost_center' }]);

  const none = extractClues('Something odd');
  assert.deepEqual(none, { sysIds: [], tables: [], columns: [] });
  assert.deepEqual(extractClues(null), { sysIds: [], tables: [], columns: [] });
});

// ---- providers --------------------------------------------------------------------------------------

const missingRef = { kind: 'missing_reference', clues: { sysIds: [ID.group], tables: [], columns: [] } };
const missingCol = { kind: 'missing_column', clues: { sysIds: [], tables: ['incident'], columns: [{ table: 'incident', element: 'u_cost_center' }] } };
const missingTbl = { kind: 'missing_table', clues: { sysIds: [], tables: ['u_asset_tracker'], columns: [] } };

test('searches exist only for kinds that can have a provider, and are deduplicated and capped', () => {
  assert.deepEqual(searchesFor(missingRef).map((s) => s.key), [`id:${ID.group}`]);
  assert.deepEqual(searchesFor(missingCol).map((s) => s.key), ['col:incident.u_cost_center']);
  assert.deepEqual(searchesFor(missingTbl).map((s) => s.key), ['tbl:u_asset_tracker']);
  assert.deepEqual(searchesFor({ kind: 'collision', clues: missingRef.clues }), []);
  const result = providerSearches([missingRef, missingRef, missingCol, missingTbl], 2);
  assert.equal(result.searches.length, 2);
  assert.equal(result.capped, true);
  assert.equal(result.total, 3);
  assert.equal(providerSearches([]).searches.length, 0);
});

test('provider queries are built from validated parts only', () => {
  const [id] = searchesFor(missingRef);
  assert.equal(providerQuery(id, [ID.setB, ID.setC]), `remote_update_setIN${ID.setB},${ID.setC}^nameLIKE${ID.group}`);
  const [col] = searchesFor(missingCol);
  assert.equal(providerQuery(col, [ID.setB]), `remote_update_setIN${ID.setB}^name=sys_dictionary_incident_u_cost_center`);
  const [tbl] = searchesFor(missingTbl);
  assert.equal(providerQuery(tbl, [ID.setB]), `remote_update_setIN${ID.setB}^nameSTARTSWITHsys_dictionary_u_asset_tracker_`);
  assert.throws(() => providerQuery(id, []), /No retrieved/);
  assert.throws(() => providerQuery(id, ['not-an-id']), /No retrieved/);
  assert.throws(() => providerQuery({ mode: 'id', sysId: 'x^y' }, [ID.setB]), /sys_id/);
  assert.throws(() => providerQuery({ mode: 'col', table: 'a^b', element: 'c' }, [ID.setB]), /column/);
  assert.throws(() => providerQuery({ mode: 'nope' }, [ID.setB]), /Unknown/);
});

test('a provider row must really match: the instance query is loose, the matcher is exact', () => {
  const [id] = searchesFor(missingRef);
  assert.equal(rowMatchesSearch(id, { name: `sys_user_group_${ID.group}` }), true);
  assert.equal(rowMatchesSearch(id, { name: `sys_user_group_${ID.rule}` }), false);
  const [col] = searchesFor(missingCol);
  assert.equal(rowMatchesSearch(col, { name: 'sys_dictionary_incident_u_cost_center' }), true);
  assert.equal(rowMatchesSearch(col, { name: 'sys_dictionary_incident_u_cost_center_2' }), false);
});

test('providers are grouped per set, the other sets first, and carry the update names that answered', () => {
  const rows = {
    [`id:${ID.group}`]: [
      { name: `sys_user_group_${ID.group}`, target: 'Payroll Approvers', type: 'Group', setId: ID.setB },
      { name: `sys_user_group_${ID.group}`, target: 'Payroll Approvers', type: 'Group', setId: ID.setA },
      { name: `sys_user_group_${ID.rule}`, target: 'Unrelated', type: 'Group', setId: ID.setC },
    ],
  };
  const sets = { [ID.setA]: { name: 'Payroll release 4' }, [ID.setB]: { name: 'Groups and roles' }, [ID.setC]: { name: 'Other' } };
  const providers = matchProviders(missingRef, rows, sets, ID.setA);
  assert.deepEqual(providers.map((p) => [p.setName, p.own, p.strength]), [['Groups and roles', false, 'exact'], ['Payroll release 4', true, 'exact']]);
  assert.equal(providers[0].updates[0].target, 'Payroll Approvers');
  assert.deepEqual(matchProviders(missingRef, {}, sets, ID.setA), []);
  // A Map of sets works as well as an object.
  assert.equal(matchProviders(missingRef, rows, new Map([[ID.setB, { name: 'M' }]]), ID.setA)[0].setName, 'M');
});

test('a table provider is only "probable", a column provider is exact', () => {
  const tbl = matchProviders(missingTbl, { 'tbl:u_asset_tracker': [{ name: 'sys_dictionary_u_asset_tracker_u_owner', setId: ID.setB }] }, { [ID.setB]: { name: 'Assets' } }, ID.setA);
  assert.equal(tbl[0].strength, 'probable');
  const col = matchProviders(missingCol, { 'col:incident.u_cost_center': [{ name: 'sys_dictionary_incident_u_cost_center', setId: ID.setB }] }, { [ID.setB]: { name: 'Cost centers' } }, ID.setA);
  assert.equal(col[0].strength, 'exact');
});

// ---- collisions ------------------------------------------------------------------------------------

const REMOTE_XML = `<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script_include"><sys_script_include action="INSERT_OR_UPDATE"><name>PayrollUtils</name><script><![CDATA[var x = 1;]]></script><sys_updated_by>abel.tuter</sys_updated_by><sys_updated_on>2026-10-02 09:30:00</sys_updated_on></sys_script_include></record_update>`;

test('the remote update time and author are read from the payload, nothing else', () => {
  assert.deepEqual(payloadStamp(REMOTE_XML), { updatedOn: '2026-10-02 09:30:00', updatedBy: 'abel.tuter' });
  assert.equal(payloadStamp(''), null);
  assert.equal(payloadStamp('<record_update table="x"><x action="INSERT_OR_UPDATE"><name>n</name></x></record_update>'), null);
  assert.equal(payloadStamp('not xml at all'), null);
});

test('a collision compares the local copy with the remote update', () => {
  const c = buildCollision({
    record: { found: true, updatedOn: '2026-10-18 14:02:00', updatedBy: 'beth.anglin' },
    localUpdates: [{ updatedOn: '2026-10-18 14:02:00', updatedBy: 'beth.anglin', setName: 'Payroll hotfix' }],
    versions: [{ at: '2026-10-18 14:02:00', by: 'beth.anglin' }],
    remote: { updatedOn: '2026-10-02 09:30:00', updatedBy: 'abel.tuter' },
  });
  assert.equal(c.relation, 'local-newer');
  assert.equal(c.gap, '16 days');
  assert.equal(c.localState, 'found');
  assert.match(c.lines.join(' '), /beth\.anglin/);
  assert.match(c.lines.join(' '), /abel\.tuter/);
  assert.match(c.lines.join(' '), /16 days newer/);
  assert.match(c.lines.join(' '), /Payroll hotfix/);
});

test('collisions degrade: deleted record, remote newer, no stamps, nothing at all', () => {
  const deleted = buildCollision({ record: { found: false }, versions: [{ at: '2026-10-01 10:00:00', by: 'admin' }], remote: { updatedOn: '2026-10-02 09:30:00' } });
  assert.equal(deleted.localState, 'deleted');
  assert.ok(deleted.lines[0].includes('no longer exists here (or your user cannot read it); its last version'));
  const remoteNewer = buildCollision({ record: { found: true, updatedOn: '2026-10-01 10:00:00', updatedBy: 'x' }, remote: { updatedOn: '2026-10-03 10:00:00' } });
  assert.equal(remoteNewer.relation, 'remote-newer');
  assert.match(remoteNewer.lines.join(' '), /something other than age/);
  const unread = buildCollision({ record: { error: 'Your user is not allowed to do this (403).' } });
  assert.equal(unread.relation, 'unknown');
  assert.match(unread.lines[0], /could not be read/);
  assert.deepEqual(buildCollision().lines, []);
  assert.equal(buildCollision({ record: { found: true, updatedOn: '2026-10-01 10:00:00' }, remote: { updatedOn: '2026-10-01 10:00:20' } }).relation, 'same');
});

// ---- verdict, checklist, order ---------------------------------------------------------------------

const prob = (kind, status = 'unresolved', extra = {}) => ({ id: `${kind}-${status}`, kind, status, update: { target: kind }, providers: [], ...extra });

test('verdict: ready, blocked, not previewed, running, committed, unreadable', () => {
  assert.equal(buildVerdict({ stateKind: 'previewed', problems: [] }).level, 'ready');
  assert.match(buildVerdict({ stateKind: 'previewed', problems: [] }).headline, /Ready to commit/);
  const allDone = buildVerdict({ stateKind: 'previewed', problems: [prob('collision', 'skipped'), prob('missing_reference', 'accepted')] });
  assert.equal(allDone.level, 'ready');
  assert.match(allDone.detail, /All 2 problems are accepted or skipped/);

  const blocked = buildVerdict({
    stateKind: 'previewed',
    problems: [prob('missing_reference', 'unresolved', { providers: [{ setId: ID.setB, setName: 'B', own: false }] }), prob('missing_reference'), prob('delete_missing'), prob('collision', 'skipped')],
  });
  assert.equal(blocked.level, 'blocked');
  assert.equal(blocked.headline, 'Blocked by 3 problems');
  assert.equal(blocked.blockers, 3);
  assert.equal(blocked.safeToSkip, 1);
  assert.equal(blocked.fixable, 1);
  assert.match(blocked.detail, /2 missing reference, 1 delete of a record that is not here/);
  assert.match(blocked.detail, /1 is created in another retrieved update set/);
  assert.match(blocked.detail, /1 can be skipped safely/);
  assert.equal(buildVerdict({ stateKind: 'previewed', problems: [prob('collision')] }).headline, 'Blocked by 1 problem');

  assert.equal(buildVerdict({ stateKind: 'loaded', problems: [] }).level, 'notpreviewed');
  assert.equal(buildVerdict({ stateKind: 'previewing', problems: [] }).level, 'running');
  assert.equal(buildVerdict({ stateKind: 'committed', problems: [] }).level, 'committed');
  assert.equal(buildVerdict({ stateKind: 'previewed', readError: 'denied', problems: [] }).level, 'unreadable');
  // An unclear status is never read as "fine".
  assert.equal(buildVerdict({ stateKind: 'previewed', problems: [prob('generic', 'unknown')] }).level, 'blocked');
});

test('state words map to the set states', () => {
  assert.equal(setStateKind('loaded', 'Loaded'), 'loaded');
  assert.equal(setStateKind('previewed', 'Previewed'), 'previewed');
  assert.equal(setStateKind('previewing', 'Previewing'), 'previewing');
  assert.equal(setStateKind('committed', 'Committed'), 'committed');
  assert.equal(setStateKind('committing', ''), 'committing');
  assert.equal(setStateKind('', ''), 'other');
});

test('next step: provider first, then the platform action for the kind', () => {
  assert.match(nextStep(prob('missing_reference', 'unresolved', { providers: [{ setName: 'Groups and roles', own: false }] })), /Commit "Groups and roles" first/);
  assert.match(nextStep(prob('missing_reference')), /ask the author/);
  assert.match(nextStep(prob('collision')), /Accept remote update.*Skip remote update/);
  assert.match(nextStep(prob('delete_missing')), /Skip remote update/);
  assert.ok(nextStep(prob('generic')).length > 10);
  // A set that only provides to itself is not a "commit first" step.
  assert.doesNotMatch(nextStep(prob('missing_reference', 'unresolved', { providers: [{ setName: 'Self', own: true }] })), /Commit "Self"/);
});

test('commit order puts providers first, is stable, and reports cycles', () => {
  const sets = { [ID.setA]: { name: 'App release', state: 'Previewed' }, [ID.setB]: { name: 'Groups', state: 'Loaded' }, [ID.setC]: { name: 'Tables', state: 'Previewed' } };
  const order = commitOrder([{ from: ID.setB, to: ID.setA }, { from: ID.setC, to: ID.setB }], sets, ID.setA);
  assert.deepEqual(order.chain.map((c) => c.name), ['Tables', 'Groups', 'App release']);
  assert.equal(order.chain[2].focus, true);
  assert.deepEqual(order.cycles, []);
  const cyc = commitOrder([{ from: ID.setA, to: ID.setB }, { from: ID.setB, to: ID.setA }], sets, ID.setA);
  assert.equal(cyc.chain.length, 0);
  assert.deepEqual(cyc.cycles[0].sort(), ['App release', 'Groups']);
  assert.deepEqual(commitOrder([], sets).chain, []);
  // Duplicates and self edges are ignored.
  assert.deepEqual(commitOrder([{ from: ID.setB, to: ID.setA }, { from: ID.setB, to: ID.setA }, { from: ID.setA, to: ID.setA }], sets, ID.setA).chain.map((c) => c.name), ['Groups', 'App release']);
});

test('edges come from open problems only, and never from the set itself', () => {
  const problems = [
    prob('missing_reference', 'unresolved', { providers: [{ setId: ID.setB, own: false }, { setId: ID.setA, own: true }] }),
    prob('missing_reference', 'skipped', { providers: [{ setId: ID.setC, own: false }] }),
    prob('missing_reference', 'unresolved', { providers: [{ setId: ID.setB, own: false }] }),
  ];
  assert.deepEqual(edgesFromProblems(ID.setA, problems), [{ from: ID.setB, to: ID.setA }]);
});

// ---- the whole analysis ----------------------------------------------------------------------------

const MAP = mapProblemColumns(FIELDS);
const cell = (v, d) => ({ value: v, display_value: d ?? v });
const row = (id, type, description, update, status = '') => ({
  sys_id: cell(id),
  remote_update_set: cell(ID.setA, 'Payroll release 4'),
  remote_update: cell(update, update),
  type: cell(type),
  description: cell(description),
  status: cell(status),
  sys_created_on: cell('2026-10-20 10:00:00'),
});

function sampleRaw(overrides = {}) {
  const rows = [
    normalizeProblem(row(sid('p1'), 'Error', `Could not find a record in sys_user_group with sys_id ${ID.group}`, sid('u1')), MAP),
    normalizeProblem(row(sid('p2'), 'Error', 'Found a local update that is newer than the remote update', sid('u2')), MAP),
    normalizeProblem(row(sid('p3'), 'Warning', 'The remote update deletes a record that does not exist on this instance', sid('u3'), 'Skipped Remote Update'), MAP),
    normalizeProblem(row(sid('p4'), 'Error', 'Something went sideways with the frobnicator', sid('u4')), MAP),
  ];
  return {
    set: { sysId: ID.setA, name: 'Payroll release 4', state: 'previewed', stateLabel: 'Previewed' },
    map: MAP,
    rows,
    updates: {
      [sid('u1')]: { sys_id: sid('u1'), name: `sys_script_include_${ID.script}`, target_name: 'PayrollUtils', type: 'Script Include', action: 'INSERT_OR_UPDATE' },
      [sid('u2')]: { sys_id: sid('u2'), name: `sys_script_${ID.rule}`, target_name: 'Validate pay run', type: 'Business Rule' },
      [sid('u3')]: { sys_id: sid('u3'), name: `sys_ui_policy_${ID.rule}`, target_name: 'Old policy', type: 'UI Policy', action: 'DELETE' },
      [sid('u4')]: { sys_id: sid('u4'), name: 'weird_name', target_name: 'Odd one', type: 'Thing' },
    },
    candidateSets: [
      { sysId: ID.setA, name: 'Payroll release 4', state: 'previewed', stateLabel: 'Previewed' },
      { sysId: ID.setB, name: 'Groups and roles', state: 'loaded', stateLabel: 'Loaded' },
    ],
    providerRows: { [`id:${ID.group}`]: [{ name: `sys_user_group_${ID.group}`, target: 'Payroll Approvers', type: 'Group', setId: ID.setB }] },
    providerErrors: {},
    collisionData: { [sid('u2')]: { record: { found: true, updatedOn: '2026-10-18 14:02:00', updatedBy: 'beth.anglin' }, remote: { updatedOn: '2026-10-02 09:30:00', updatedBy: 'abel.tuter' } } },
    notes: [],
    ...overrides,
  };
}

test('an analysis ties problems to providers, collisions, links, verdict, checklist and order', () => {
  const a = buildAnalysis(sampleRaw());
  assert.equal(a.problems.length, 4);
  assert.equal(a.counts.open, 3);
  assert.equal(a.counts.byStatus.skipped, 1);
  assert.deepEqual(a.groups.map((g) => g.kind), ['missing_reference', 'collision', 'generic', 'delete_missing']);

  const ref = a.problems.find((p) => p.id === sid('p1'));
  assert.equal(ref.kind, 'missing_reference');
  assert.equal(ref.record.table, 'sys_script_include');
  assert.equal(ref.providers[0].setName, 'Groups and roles');
  assert.equal(ref.providerNote, 'Created in "Groups and roles".');
  assert.equal(ref.links.problem, `/sys_update_preview_problem.do?sys_id=${sid('p1')}`);
  assert.equal(ref.links.update, `/sys_update_xml.do?sys_id=${sid('u1')}`);
  assert.equal(ref.links.providers[0].href, `/sys_remote_update_set.do?sys_id=${ID.setB}`);
  assert.match(ref.next, /Commit "Groups and roles" first/);

  const col = a.problems.find((p) => p.id === sid('p2'));
  assert.equal(col.collision.relation, 'local-newer');
  assert.equal(col.links.record, `/sys_script.do?sys_id=${ID.rule}`);
  assert.match(col.links.versions, /^\/sys_update_version_list\.do\?sysparm_query=name%3Dsys_script_/);

  const generic = a.problems.find((p) => p.id === sid('p4'));
  assert.equal(generic.kind, 'generic');
  assert.equal(generic.record, null);
  assert.equal(generic.links.record, '');
  assert.ok(generic.explain.meaning.length > 20);

  assert.equal(a.verdict.level, 'blocked');
  assert.equal(a.verdict.headline, 'Blocked by 3 problems');
  assert.deepEqual(a.order.chain.map((c) => c.name), ['Groups and roles', 'Payroll release 4']);
  assert.ok(a.checklist.some((i) => i.state === 'todo' && i.problemId === sid('p1')));
  assert.ok(a.checklist.some((i) => i.state === 'done' && /already dealt with/.test(i.title)));
  // Open problems come before resolved ones.
  assert.equal(a.problems[a.problems.length - 1].status, 'skipped');
});

test('with no provider the panel says why, in the right words for each reason', () => {
  const none = buildAnalysis(sampleRaw({ providerRows: {} })).problems.find((p) => p.id === sid('p1'));
  assert.match(none.providerNote, /None of the 1 other retrieved update set creates it/);
  assert.match(none.providerNote, /missing from the source instance's update set/);

  const alone = buildAnalysis(sampleRaw({ providerRows: {}, candidateSets: [{ sysId: ID.setA, name: 'Payroll release 4', state: 'previewed' }] })).problems.find((p) => p.id === sid('p1'));
  assert.match(alone.providerNote, /no other retrieved update sets/);

  const failed = buildAnalysis(sampleRaw({ providerRows: {}, providerErrors: { [`id:${ID.group}`]: 'Your user is not allowed to do this (403).' } })).problems.find((p) => p.id === sid('p1'));
  assert.match(failed.providerNote, /Could not search the other retrieved update sets: Your user is not allowed/);

  const same = buildAnalysis(sampleRaw({ providerRows: { [`id:${ID.group}`]: [{ name: `sys_user_group_${ID.group}`, setId: ID.setA }] } })).problems.find((p) => p.id === sid('p1'));
  assert.match(same.providerNote, /This update set itself contains it/);

  const nameless = buildAnalysis(
    sampleRaw({ rows: [normalizeProblem(row(sid('q1'), 'Error', 'Missing reference', sid('u1')), MAP)] })
  ).problems[0];
  assert.match(nameless.providerNote, /names no sys_id/);

  const data = buildAnalysis(
    sampleRaw({ rows: [normalizeProblem(row(sid('q2'), 'Error', `Could not find a record in table sys_user with sys_id ${ID.group}`, sid('u1')), MAP)], providerRows: {} })
  ).problems[0];
  assert.match(data.providerNote, /probably data \(sys_user\)/);
});

test('a set with no problems is ready (or not previewed), and an unreadable one says so', () => {
  const ready = buildAnalysis(sampleRaw({ rows: [] }));
  assert.equal(ready.verdict.level, 'ready');
  assert.equal(ready.groups.length, 0);
  assert.equal(ready.order.chain.length, 0);
  const loaded = buildAnalysis(sampleRaw({ rows: [], set: { sysId: ID.setA, name: 'X', state: 'loaded', stateLabel: 'Loaded' } }));
  assert.equal(loaded.verdict.level, 'notpreviewed');
  assert.equal(loaded.checklist[0].state, 'todo');
  const bad = buildAnalysis({ set: { sysId: ID.setA, name: 'X' }, readError: 'The problem table could not be read.' });
  assert.equal(bad.verdict.level, 'unreadable');
  assert.equal(bad.problems.length, 0);
  assert.doesNotThrow(() => buildAnalysis({}));
});

test('a problem type nobody has seen still produces a full, linked entry', () => {
  const a = buildAnalysis(
    sampleRaw({ rows: [normalizeProblem(row(sid('z1'), 'Cosmic ray', 'Bit flipped in transit', sid('u4')), MAP)] })
  );
  const p = a.problems[0];
  assert.equal(p.kind, 'generic');
  assert.equal(p.explain.label, 'Other problem');
  assert.equal(p.links.problem, `/sys_update_preview_problem.do?sys_id=${sid('z1')}`);
  assert.equal(p.description, 'Bit flipped in transit');
  assert.equal(a.verdict.level, 'blocked');
});

test('prepareProblems keeps a problem whose update could not be read', () => {
  const [p] = prepareProblems([normalizeProblem(row(sid('p1'), 'Error', 'Table x does not exist', sid('u9')), MAP)], {});
  assert.equal(p.update.sysId, sid('u9'));
  assert.equal(p.record, null);
  assert.equal(p.kind, 'missing_table');
  const [q] = prepareProblems([normalizeProblem({ sys_id: cell(sid('p2')), description: cell('whatever') }, MAP)], {});
  assert.equal(q.update, null);
});

// ---- the set list ----------------------------------------------------------------------------------

test('set rows become picker entries with a state kind and a problem count', () => {
  const s = normalizeSet({ sys_id: cell(ID.setA), name: cell('Payroll release 4'), state: cell('previewed', 'Previewed'), sys_updated_on: cell('2026-10-20 10:00:00'), application: cell(ID.setB, 'Payroll') }, { [ID.setA]: 5 });
  assert.equal(s.stateKind, 'previewed');
  assert.equal(s.problemCount, 5);
  assert.equal(s.application, 'Payroll');
  assert.equal(normalizeSet({ sys_id: ID.setB, name: 'plain', state: 'committed' }).problemCount, null);
  assert.equal(lib.isPending(normalizeSet({ sys_id: ID.setB, state: 'committed' })), false);
  assert.equal(lib.isSysId(ID.setA), true);
  assert.equal(lib.isSysId('Payroll'), false);
});

// ---- links -----------------------------------------------------------------------------------------

test('links only form for valid tables and sys_ids', () => {
  assert.equal(recordPath('sys_script', ID.rule), `/sys_script.do?sys_id=${ID.rule}`);
  assert.equal(recordPath('sys_script^x', ID.rule), '');
  assert.equal(recordPath('sys_script', 'nope'), '');
  assert.equal(versionsPath('sys_script_x'), '/sys_update_version_list.do?sysparm_query=name%3Dsys_script_x%5EORDERBYDESCsys_recorded_at');
  assert.equal(versionsPath('bad name'), '');
});

// ---- Markdown --------------------------------------------------------------------------------------

test('the Markdown report has the verdict, each blocker with its next step and link, and the order', () => {
  const a = buildAnalysis(sampleRaw());
  const md = previewProblemsMarkdown(a, { base: 'https://dev1.service-now.com', host: 'dev1.service-now.com', today: '2026-10-23' });
  assert.match(md, /^# Update set preview report: Payroll release 4/);
  assert.match(md, /\*\*Blocked by 3 problems\.\*\*/);
  assert.match(md, /## To resolve \(3\)/);
  assert.match(md, /\*\*Missing reference\*\* - PayrollUtils \(Script Include\)/);
  assert.match(md, /The instance says: "Could not find a record in sys_user_group/);
  assert.match(md, /Provider: Created in "Groups and roles"/);
  assert.match(md, /Next step: Commit "Groups and roles" first/);
  assert.ok(md.includes(`Problem record: https://dev1.service-now.com/sys_update_preview_problem.do?sys_id=${sid('p1')}`));
  assert.match(md, /Local copy last changed 2026-10-18 14:02:00 UTC by beth\.anglin/);
  assert.match(md, /## Already dealt with \(1\)/);
  assert.match(md, /\| Delete of a record that is not here \| Old policy \| Skipped \|/);
  assert.match(md, /1\. Groups and roles\n2\. Payroll release 4 \(this update set\)/);
  assert.doesNotMatch(md, /\n{3,}/);
});

test('the Markdown report works for a clean set and escapes table separators', () => {
  const clean = previewProblemsMarkdown(buildAnalysis(sampleRaw({ rows: [] })));
  assert.match(clean, /\*\*Ready to commit\.\*\*/);
  assert.doesNotMatch(clean, /## To resolve/);
  const pipe = buildAnalysis(sampleRaw({ rows: [normalizeProblem(row(sid('p9'), 'Error', 'a | b', sid('u3'), 'Skipped'), MAP)] }));
  assert.match(previewProblemsMarkdown(pipe), /Old policy/);
});

// ---- honesty: a search that did not run is never reported as "nobody creates it" ----------------------

test('when the provider search could not run, the next step says so instead of "nothing provides it"', () => {
  const failed = buildAnalysis(sampleRaw({ providerRows: {}, providerErrors: { [`id:${ID.group}`]: 'sys_update_xml.remote_update_set is not readable here.' } })).problems.find((p) => p.id === sid('p1'));
  assert.equal(failed.providerState, 'error');
  assert.match(failed.next, /could not tell which update set creates it/);
  assert.doesNotMatch(failed.next, /Nothing in the other retrieved sets/);

  const none = buildAnalysis(sampleRaw({ providerRows: {} })).problems.find((p) => p.id === sid('p1'));
  assert.equal(none.providerState, 'none');
  assert.match(none.next, /Nothing in the other retrieved sets/);

  const own = buildAnalysis(sampleRaw({ providerRows: { [`id:${ID.group}`]: [{ name: `sys_user_group_${ID.group}`, setId: ID.setA }] } })).problems.find((p) => p.id === sid('p1'));
  assert.equal(own.providerState, 'own');
  assert.match(own.next, /Preview Update Set again/);

  const alone = buildAnalysis(sampleRaw({ providerRows: {}, candidateSets: [{ sysId: ID.setA, name: 'Payroll release 4', state: 'previewed' }] })).problems.find((p) => p.id === sid('p1'));
  assert.equal(alone.providerState, 'alone');
  // Kinds without a provider have no provider state.
  assert.equal(buildAnalysis(sampleRaw()).problems.find((p) => p.id === sid('p2')).providerState, '');
});

test('searches over the cap are reported as skipped so the content half can mark them as not searched', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ kind: 'missing_reference', clues: { sysIds: [String(i).repeat(32)], tables: [], columns: [] } }));
  const result = providerSearches(many, 3);
  assert.equal(result.searches.length, 3);
  assert.equal(result.skipped.length, 2);
  assert.equal(result.capped, true);
  assert.deepEqual(providerSearches(many, 10).skipped, []);
});

test('a description that holds a secret assignment is masked before it is shown, copied or sent anywhere', () => {
  const p = normalizeProblem(row(sid('s1'), 'Error', 'Could not find a record; connection used password=hunter2hunter2 and api_key: "abcd1234efgh5678"', sid('u1')), MAP);
  assert.doesNotMatch(p.description, /hunter2hunter2|abcd1234efgh5678/);
  assert.match(p.description, /\[REDACTED\]/);
  assert.match(p.description, /Could not find a record/);
});

// ---- review fixes: the platform's own wording, statuses, table providers, time zones, the instance half -------------

test('the platform wording for a missing reference names the table and column, not the sys_id; the sys_id comes from the remote update', () => {
  const text = 'Could not find a record in sys_user_group for column assignment_group referenced in this update';
  assert.equal(classifyProblem({ typeLabel: 'Error', description: text }).kind, 'missing_reference');
  const clues = extractClues(text);
  assert.deepEqual(clues.sysIds, []);
  assert.deepEqual(clues.refs, [{ table: 'sys_user_group', column: 'assignment_group' }]);
  assert.ok(clues.tables.includes('sys_user_group'));
  assert.deepEqual(clues.columns, [], 'assignment_group is not a column of sys_user_group');

  const payload = `<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script"><sys_script action="INSERT_OR_UPDATE"><name>x</name><assignment_group display_value="Payroll">${ID.group}</assignment_group><watch_list>${ID.rule},${ID.script.toUpperCase()}</watch_list></sys_script></record_update>`;
  assert.deepEqual(lib.referencedIds(payload, 'assignment_group'), [ID.group]);
  assert.deepEqual(lib.referencedIds(payload, 'watch_list'), [ID.rule, ID.script], 'a list column gives each sys_id');
  assert.deepEqual(lib.referencedIds(payload, 'nope'), []);
  assert.deepEqual(lib.referencedIds('not xml', 'assignment_group'), []);
  assert.deepEqual(lib.referencedIds(payload, 'a^b'), []);

  // With the value from the payload the provider search runs and finds the set that creates the group.
  const raw = sampleRaw({ rows: [normalizeProblem(row(sid('r1'), 'Error', text, sid('u1')), MAP)], refValues: { [sid('r1')]: [ID.group] } });
  const p = buildAnalysis(raw).problems[0];
  assert.deepEqual(p.searches.map((s) => s.key), [`id:${ID.group}`]);
  assert.equal(p.providerState, 'found');
  assert.match(p.next, /Commit "Groups and roles" first/);
  // Without it, the panel says the column could not be read and that a group is probably data.
  const blind = buildAnalysis(sampleRaw({ rows: raw.rows })).problems[0];
  assert.equal(blind.providerState, 'nosearch');
  assert.match(blind.providerNote, /assignment_group could not be read/);
  assert.match(blind.providerNote, /probably data/);
});

test('the platform wording for a collision and a missing table field land in the right kinds', () => {
  assert.equal(classifyProblem({ typeLabel: 'Warning', description: 'Found a local update that is newer than this one' }).kind, 'collision');
  const field = 'Could not find a table field (incident.u_cost_center) referenced in this update';
  assert.equal(classifyProblem({ typeLabel: 'Error', description: field }).kind, 'missing_column');
  assert.deepEqual(extractClues(field).columns, [{ table: 'incident', element: 'u_cost_center' }], 'a core table without an underscore is read in brackets');
  assert.equal(classifyProblem({ typeLabel: 'Error', description: 'Could not find a table (u_payroll_run) referenced in this update' }).kind, 'missing_table');
});

test('an "ignored" problem is never explained as a skip', () => {
  const ignored = buildAnalysis(sampleRaw({ rows: [normalizeProblem(row(sid('i1'), 'Warning', 'Found a local update that is newer than this one', sid('u2'), 'ignored'), MAP)] }));
  const p = ignored.problems[0];
  assert.equal(p.status, 'ignored');
  assert.equal(lib.isOpen(p.status), false);
  assert.doesNotMatch(lib.STATUS_EFFECT.ignored, /left out of the commit/);
  assert.match(lib.STATUS_EFFECT.ignored, /Accept remote update/);
  assert.equal(lib.STATUS_TEXT.ignored, 'Ignored');
  assert.match(ignored.checklist.find((i) => /already dealt with/.test(i.title)).text, /1 ignored/);
  assert.equal(ignored.verdict.level, 'ready');
});

test('a table provider: the table own dictionary entry is exact, a column of it is only probable and never "commit first"', () => {
  const sets = { [ID.setB]: { name: 'Assets' }, [ID.setC]: { name: 'Asset tracker extras' } };
  const search = searchesFor(missingTbl)[0];
  assert.equal(rowMatchesSearch(search, { name: 'sys_dictionary_u_asset_tracker_null' }), true);
  assert.equal(rowMatchesSearch(search, { name: 'sys_dictionary_u_asset_tracker_log_null' }), false, 'another table (u_asset_tracker_log) is not this one');
  const exact = matchProviders(missingTbl, { 'tbl:u_asset_tracker': [{ name: 'sys_dictionary_u_asset_tracker_null', setId: ID.setB }] }, sets, ID.setA);
  assert.equal(exact[0].strength, 'exact');

  const probableOnly = { ...prob('missing_table'), clues: missingTbl.clues, providers: matchProviders(missingTbl, { 'tbl:u_asset_tracker': [{ name: 'sys_dictionary_u_asset_tracker_u_owner', setId: ID.setC }] }, sets, ID.setA) };
  assert.equal(probableOnly.providers[0].strength, 'probable');
  assert.doesNotMatch(nextStep(probableOnly), /^Commit/);
  assert.match(nextStep(probableOnly), /check that it creates/);
  assert.deepEqual(edgesFromProblems(ID.setA, [probableOnly]), [], 'a guess never orders the commits');
  assert.equal(buildVerdict({ stateKind: 'previewed', problems: [probableOnly] }).fixable, 0);
});

test('collision times: stored values are compared and labelled UTC; a display value in another format is not compared', () => {
  const c = buildCollision({ record: { found: true, updatedOn: '2026-10-18 14:02:00', updatedBy: 'beth.anglin' }, remote: { updatedOn: '2026-10-02 09:30:00' } });
  assert.match(c.lines[0], /2026-10-18 14:02:00 UTC/);
  const display = buildCollision({ record: { found: false }, versions: [{ at: '18-10-2026 16:02:00', by: 'beth.anglin' }], remote: { updatedOn: '2026-10-02 09:30:00' } });
  assert.equal(display.relation, 'unknown', 'a dd-mm-yyyy display value is not read as UTC');
});

// ---- the instance half against the preview fixture --------------------------------------------------------------------

function onFixture() {
  const fixture = require('../preview/fixtures/previewProblems.js');
  global.__PREVIEWFIX_FIXTURE__ = true;
  global.document = {
    documentElement: {
      hasAttribute() {
        throw new Error('no bridge in tests');
      },
    },
    getElementById: () => null,
    querySelector: (s) => (s.includes('sysparm_ck') ? { value: 'test-token' } : null),
    scripts: [],
  };
  const calls = [];
  const json = (result) => new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
  global.fetch = async (path) => {
    const url = new URL(path, 'https://dev1.service-now.com');
    calls.push({ table: url.pathname.split('/').pop(), query: url.searchParams.get('sysparm_query') || '', fields: url.searchParams.get('sysparm_fields') || '' });
    const answered = fixture.route('GET', url, null);
    if (answered) return answered;
    if (url.pathname.endsWith('/sys_db_object')) return json([{ 'super_class.name': '' }]);
    return json([]);
  };
  return { fixture, calls };
}

test('previewProblemLoad: the sys_id of a missing reference is read from the remote update, and the provider is found', async () => {
  const { fixture, calls } = onFixture();
  const content = require('../src/content/previewProblems.js');
  const a = await content.previewProblemLoad({ setId: fixture.IDS.release });
  const notify = a.problems.find((p) => p.update?.target === 'Notify payroll approvers');
  assert.equal(notify.kind, 'missing_reference');
  assert.equal(notify.providerState, 'found', notify.providerNote);
  assert.match(notify.next, /^Commit "Payroll groups and roles/);
  // Only the two columns were asked for, in a bounded number of reads; nothing of the payload reaches the analysis.
  const payloadReads = calls.filter((c) => c.table === 'sys_update_xml' && c.fields === 'sys_id,payload');
  assert.ok(payloadReads.length >= 1 && payloadReads.length <= 3, `payload reads: ${payloadReads.length}`);
  assert.ok(!JSON.stringify(a).includes('gs.eventQueue'), 'no script text of the payload is kept');
  const field = a.problems.find((p) => p.update?.target === 'Set cost center on incident');
  assert.equal(field.kind, 'missing_column');
  assert.equal(field.providerState, 'found');
  // Collision times come from stored values (UTC), not display values.
  const calc = a.problems.find((p) => p.update?.target === 'Calculate payroll totals');
  assert.equal(calc.collision.relation, 'local-newer');
  assert.ok(calc.collision.lines.some((l) => /UTC/.test(l)));
});

// ---- confirmed live 2026-10-23: missing_item, missing_item_table, missing_item_update, available_actions -------------

test('the real problem columns are picked up; missing_item_update never becomes the remote update', () => {
  const map = mapProblemColumns(FIELDS);
  assert.equal(map.update, 'remote_update');
  assert.equal(map.missingItem, 'missing_item');
  assert.equal(map.missingItemTable, 'missing_item_table');
  assert.equal(map.missingItemUpdate, 'missing_item_update');
  assert.equal(map.actions, 'available_actions');
  ['missing_item', 'missing_item_table', 'missing_item_update', 'available_actions'].forEach((c) => assert.ok(map.columns.includes(c), c));
  // From the names alone (dictionary unreadable, columns learned from a row) it works the same.
  const fromRow = mapProblemColumns(['available_actions', 'description', 'missing_item', 'missing_item_table', 'missing_item_update', 'remote_update', 'remote_update_set', 'status', 'type'].map((name) => ({ name })));
  assert.equal(fromRow.update, 'remote_update');
  assert.equal(fromRow.missingItemUpdate, 'missing_item_update');
  assert.deepEqual(fromRow.missing, ['severity']);
  assert.equal(lib.MISSING_ROLE_TEXT.missingItem, '', 'an older release without them is not warned about');
});

const withMissing = (id, description, extra, update = sid('u1')) =>
  normalizeProblem({ ...row(id, 'Error', description, update), missing_item: cell(''), missing_item_table: cell(''), missing_item_update: cell(''), available_actions: cell(''), ...extra }, MAP);

test('what the instance recorded as missing is read, validated, and used before the description', () => {
  const p = withMissing(sid('m1'), 'Could not find a record in sys_user_group for column assignment_group referenced in this update', {
    missing_item: cell(ID.group.toUpperCase()),
    missing_item_table: cell('sys_user_group'),
    missing_item_update: cell(sid('prov'), 'sys_user_group_x'),
    available_actions: cell('skip,accept'),
  });
  assert.deepEqual(p.missing, { sysId: ID.group, table: 'sys_user_group', updateId: sid('prov'), updateName: '', updateLabel: 'sys_user_group_x' });
  assert.deepEqual(p.actions, { names: ['skip', 'accept'], ids: 0 });
  const bad = withMissing(sid('m2'), 'x', { missing_item: cell('nope^x'), missing_item_table: cell('a^b'), missing_item_update: cell('x=1^y') });
  assert.deepEqual(bad.missing, { sysId: '', table: '', updateId: '', updateName: '', updateLabel: 'x=1^y' });
  const byName = withMissing(sid('m3'), 'Could not find a record in sys_user_group for column assignment_group referenced in this update', { missing_item_update: cell(`sys_user_group_${ID.group}`) });
  assert.equal(byName.missing.updateName, `sys_user_group_${ID.group}`);

  // The instance's own update comes first, then the sys_id search; the payload is not needed.
  const [prepared] = prepareProblems([p], {});
  assert.deepEqual(searchesFor(prepared).map((s) => s.key), [`upd:${sid('prov')}`, `id:${ID.group}`]);
  assert.equal(providerQuery(searchesFor(prepared)[0], [ID.setB]), `remote_update_setIN${ID.setB}^sys_id=${sid('prov')}`);
  assert.equal(providerQuery(searchesFor(prepareProblems([byName], {})[0])[0], [ID.setB]), `remote_update_setIN${ID.setB}^name=sys_user_group_${ID.group}`);
  assert.throws(() => providerQuery({ mode: 'upd', updateId: 'x^y' }, [ID.setB]), /sys_id/);

  // Found through the update the instance names: an exact provider, a "commit first" step, the offers appended.
  const raw = sampleRaw({ rows: [p], providerRows: { [`upd:${sid('prov')}`]: [{ sysId: sid('prov'), name: `sys_user_group_${ID.group}`, target: 'Payroll Approvers', type: 'Group', setId: ID.setB }] } });
  const a = buildAnalysis(raw).problems[0];
  assert.equal(a.providerState, 'found');
  assert.equal(a.providers[0].strength, 'exact');
  assert.match(a.next, /^Commit "Groups and roles" first/);
  assert.match(a.next, /The problem record offers: skip, accept\./);
  assert.match(a.missingText, /a sys_user_group record with sys_id 9f4b/);
  assert.equal(a.links.missingUpdate, `/sys_update_xml.do?sys_id=${sid('prov')}`);
  assert.match(previewProblemsMarkdown(buildAnalysis(raw)), /The instance recorded the missing item: a sys_user_group record/);

  // Named but not in any pending retrieved set searched: said in words, never "nothing provides it".
  const named = buildAnalysis(sampleRaw({ rows: [p], providerRows: {} })).problems[0];
  assert.equal(named.providerState, 'named');
  assert.match(named.providerNote, /The instance names the update that would provide it \(sys_user_group_x\)/);
  assert.match(named.next, /^Open the update the instance names/);
  assert.doesNotMatch(named.next, /Nothing in the other retrieved sets/);
  // A data table recorded by the instance gives the data hint even when the text names none.
  const data = buildAnalysis(sampleRaw({ rows: [withMissing(sid('m4'), 'Missing thing', { missing_item: cell(ID.rule), missing_item_table: cell('sys_user') })], providerRows: {} })).problems[0];
  assert.equal(data.kind, 'missing_reference', 'a missing item makes it a missing reference whatever the wording');
  assert.match(data.providerNote, /probably data \(sys_user\)/);
});

test('available_actions is shown as given: names when it has them, a count when it only has ids', () => {
  assert.equal(lib.platformActions(cell('')), null);
  assert.deepEqual(lib.platformActions(cell(`${ID.rule},${ID.script}`, 'Skip remote update, Accept remote update')), { names: ['Skip remote update', 'Accept remote update'], ids: 0 });
  const ids = lib.platformActions(cell(`${ID.rule},${ID.script}`));
  assert.deepEqual(ids, { names: [], ids: 2 });
  assert.equal(lib.offersText(ids), 'The problem record lists 2 actions by id only: open it to see them.');
  assert.equal(lib.offersText(null), '');
});

test('retrieved sets: no "loaded" column; the commit date and the batch parent are read', () => {
  const s = normalizeSet({ sys_id: cell(ID.setA), name: cell('Child'), state: cell('previewed', 'Previewed'), sys_created_on: cell('2026-10-20 10:00:00'), commit_date: cell(''), parent: cell(ID.setB, 'Release batch') });
  assert.equal(s.loadedOn, '2026-10-20 10:00:00');
  assert.equal(s.parentId, ID.setB);
  assert.equal(s.parentName, 'Release batch');
  assert.equal(normalizeSet({ sys_id: ID.setA, parent: 'not-an-id' }).parentId, '');
});

test('previewProblemLoad on the real column shape: the named update, missing_item, and the payload fallback each find their answer', async () => {
  const { fixture, calls } = onFixture();
  const content = require('../src/content/previewProblems.js');
  const a = await content.previewProblemLoad({ setId: fixture.IDS.release });
  const notify = a.problems.find((p) => p.update?.target === 'Notify payroll approvers');
  assert.equal(notify.missing.table, 'sys_user_group');
  assert.ok(notify.searches.some((s) => s.mode === 'upd'));
  assert.match(notify.next, /^Commit "Payroll groups and roles/);
  assert.match(notify.next, /The problem record offers: skip, accept\./);
  const policy = a.problems.find((p) => p.update?.target === 'Show cost center for payroll requests');
  assert.equal(policy.providerState, 'found', 'missing_item alone is enough');
  const utils = a.problems.find((p) => p.update?.target === 'PayrollUtils');
  assert.equal(utils.providerState, 'none', 'found the sys_id in the payload, and no set creates the user');
  assert.match(utils.providerNote, /probably data \(sys_user\)/);
  assert.ok(calls.some((c) => c.table === 'sys_update_xml' && /\^sys_id=/.test(c.query) && /remote_update_setIN/.test(c.query)), 'the named update is looked up only inside the retrieved sets');
  assert.ok(calls.filter((c) => c.table === 'sys_remote_update_set').every((c) => !c.fields.split(',').includes('loaded')));
  assert.ok(a.columns.found.missingItem && a.columns.found.actions);
});
