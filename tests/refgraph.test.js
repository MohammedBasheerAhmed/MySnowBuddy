const test = require('node:test');
const assert = require('node:assert/strict');
const {
  referencingFieldsQuery,
  cascadeKind,
  countQuery,
  listPath,
  isNoisyTable,
  planCounts,
  summarize,
  outgoingReferences,
  relationshipQuery,
  relationships,
  refGraphMarkdown,
  DEFAULT_CAP,
} = require('../src/lib/refGraph.js');

const ID = '6816f79cc0a8016401c5a33be04be441';
const OTHER = '287ebd7da9fe198100f92cc8d1d2154e';
const row = (name, element, extra = {}) => ({ name, element, column_label: element, internal_type: 'reference', reference: 'sys_user', reference_cascade_rule: '', ...extra });

test('the dictionary query covers the record table and its parents, references and lists', () => {
  assert.equal(referencingFieldsQuery(['incident', 'task']), 'referenceINincident,task^internal_type=reference^ORinternal_type=glide_list^elementISNOTEMPTY^active=true');
  assert.throws(() => referencingFieldsQuery([]), /No table/);
  assert.throws(() => referencingFieldsQuery(['bad table', 'x^y']), /No table/);
});

test('cascade rules map to what a delete would do; blank is the default (clear)', () => {
  assert.equal(cascadeKind('delete'), 'delete');
  assert.equal(cascadeKind('delete_no_workflow'), 'delete');
  assert.equal(cascadeKind('restrict'), 'restrict');
  assert.equal(cascadeKind('clear'), 'clear');
  assert.equal(cascadeKind(''), 'clear');
  assert.equal(cascadeKind(undefined), 'clear');
  assert.equal(cascadeKind('none'), 'clear');
});

test('count queries are built from validated names and ids only', () => {
  assert.equal(countQuery('caller_id', ID), `caller_id=${ID}`);
  assert.equal(countQuery('watch_list', ID, 'glide_list'), `watch_listLIKE${ID}`);
  assert.equal(countQuery('opened_by.manager', ID), `opened_by.manager=${ID}`);
  assert.throws(() => countQuery('caller_id^ORactive=true', ID), /not a column/);
  assert.throws(() => countQuery('caller_id', `${ID}^ORx=1`), /not a sys_id/);
  assert.equal(listPath('incident', `caller_id=${ID}`), `/incident_list.do?sysparm_query=caller_id%3D${ID}`);
});

test('noisy tables are recognised, ordinary ones are not', () => {
  ['sys_audit', 'sys_audit_delete', 'syslog_transaction', 'sys_email', 'sys_attachment', 'ecc_queue', 'sysevent', 'sys_journal_field', 'sys_update_xml', 'sys_user_preference'].forEach((t) => assert.equal(isNoisyTable(t), true, t));
  ['incident', 'task', 'sys_user_grmember', 'sys_user_has_role', 'cmdb_ci', 'sys_security_acl_role', 'sc_req_item', 'u_custom_table'].forEach((t) => assert.equal(isNoisyTable(t), false, t));
});

test('the plan counts ordinary tables first, hides noisy ones and says how many', () => {
  const rows = [
    row('task', 'assigned_to', { reference_cascade_rule: 'clear' }),
    row('sys_audit', 'user'),
    row('incident', 'caller_id'),
    row('incident', 'caller_id'), // duplicate dictionary row
    row('sys_user_grmember', 'user', { reference_cascade_rule: 'delete' }),
    row('task', 'watch_list', { internal_type: 'glide_list' }),
    { name: 'bad table', element: 'x' },
    { name: 'incident', element: 'bad col!' },
  ];
  const plan = planCounts(rows, { sysId: ID });
  assert.deepEqual(plan.fields.map((f) => `${f.table}.${f.field}`), ['incident.caller_id', 'sys_user_grmember.user', 'task.assigned_to', 'task.watch_list']);
  assert.equal(plan.hiddenNoisy, 1);
  assert.equal(plan.total, 5);
  assert.equal(plan.fields.find((f) => f.field === 'watch_list').query, `watch_listLIKE${ID}`);
  assert.equal(plan.fields.find((f) => f.table === 'sys_user_grmember').cascade, 'delete');
  const all = planCounts(rows, { sysId: ID, showAll: true });
  assert.equal(all.fields.length, 5);
  assert.equal(all.fields[4].table, 'sys_audit', 'noisy tables sort last');
  assert.equal(all.hiddenNoisy, 0);
});

test('the cap keeps the plan bounded and reports what was left out', () => {
  const rows = Array.from({ length: DEFAULT_CAP + 30 }, (_, i) => row(`u_t${String(i).padStart(3, '0')}`, 'owner'));
  const plan = planCounts(rows, { sysId: ID });
  assert.equal(plan.fields.length, DEFAULT_CAP);
  assert.equal(plan.hiddenCap, 30);
  assert.equal(planCounts(rows, { sysId: ID, showAll: true }).fields.length, DEFAULT_CAP + 30);
});

test('the summary says what a delete would do, strongest consequence first', () => {
  const r = (table, field, count, cascade = 'clear') => ({ table, field, count, cascade });
  const none = summarize([r('incident', 'caller_id', 0), r('task', 'assigned_to', 0)]);
  assert.equal(none.level, 'none');
  assert.match(none.headline, /Nothing else points at this record/);

  const clear = summarize([r('incident', 'caller_id', 14), r('task', 'assigned_to', 3), r('change_request', 'requested_by', 0)]);
  assert.equal(clear.level, 'clear');
  assert.equal(clear.total, 17);
  assert.equal(clear.fieldsHit, 2);
  assert.match(clear.headline, /^17 records in 2 fields would lose this reference.*incident\.caller_id, task\.assigned_to/);

  const cascade = summarize([r('sys_user_grmember', 'user', 5, 'delete'), r('incident', 'caller_id', 1)]);
  assert.equal(cascade.level, 'cascade');
  assert.match(cascade.headline, /^Deleting it also deletes 5 records \(sys_user_grmember\.user\), and empties 1 reference elsewhere\./);

  const blocked = summarize([r('sys_user_grmember', 'user', 5, 'delete'), r('a', 'b', 1, 'restrict')]);
  assert.equal(blocked.level, 'blocked');
  assert.match(blocked.headline, /^Deleting it is blocked: 1 record in a\.b/);

  const unknown = summarize([{ table: 'x', field: 'y', cascade: 'clear', error: '403' }]);
  assert.equal(unknown.level, 'unknown');
  assert.equal(summarize([r('a', 'b', 1), { table: 'c', field: 'd', cascade: 'clear', error: 'x' }]).failed, 1);
  assert.match(summarize([r('a', 'b', 1), r('c', 'd', 1), r('e', 'f', 1), r('g', 'h', 1)]).headline, /and 1 more/);
});

test("the record's own references come out with a name, a table and a link", () => {
  const fields = [
    { name: 'caller_id', label: 'Caller', type: 'reference', reference: 'sys_user' },
    { name: 'watch_list', label: 'Watch list', type: 'glide_list', reference: 'sys_user' },
    { name: 'assignment_group', label: 'Assignment group', type: 'reference', reference: 'sys_user_group' },
    { name: 'short_description', label: 'Short description', type: 'string' },
    { name: 'parent', label: 'Parent', type: 'reference', reference: 'task' },
  ];
  const record = {
    caller_id: { value: ID, display_value: 'Abel Tuter' },
    watch_list: { value: `${ID},${OTHER}`, display_value: 'Abel Tuter,Bow Ruggeri' },
    assignment_group: { value: '', display_value: '' },
    short_description: { value: 'x', display_value: 'x' },
    parent: ID,
  };
  const out = outgoingReferences(fields, record);
  assert.deepEqual(out.map((o) => `${o.label}:${o.display}:${o.table}`), ['Caller:Abel Tuter:sys_user', 'Parent:' + ID + ':task', 'Watch list:Abel Tuter:sys_user', 'Watch list:Bow Ruggeri:sys_user']);
  assert.equal(out[0].path, `/sys_user.do?sys_id=${ID}`);
  assert.deepEqual(outgoingReferences([], record), []);
  assert.deepEqual(outgoingReferences(fields, null), []);
});

test('CMDB relationships split into above and below', () => {
  assert.equal(relationshipQuery(ID), `parent=${ID}^ORchild=${ID}`);
  assert.throws(() => relationshipQuery('x'), /not a sys_id/);
  const rows = [
    { parent: { value: ID, display_value: 'web01' }, child: { value: OTHER, display_value: 'db01' }, type: { display_value: 'Depends on::Used by' } },
    { parent: { value: OTHER, display_value: 'lb01' }, child: { value: ID, display_value: 'web01' }, type: { display_value: 'Sends data to::Receives data from' } },
    { parent: { value: OTHER, display_value: 'other' }, child: { value: OTHER, display_value: 'other' }, type: '' },
  ];
  const rel = relationships(rows, ID);
  assert.deepEqual(rel.children.map((c) => `${c.name}|${c.type}`), ['db01|Depends on::Used by']);
  assert.deepEqual(rel.parents.map((c) => `${c.name}|${c.type}`), ['lb01|Sends data to::Receives data from']);
  assert.equal(rel.children[0].path, `/cmdb_ci.do?sys_id=${OTHER}`);
});

test('the Markdown report lists only fields with records', () => {
  const incoming = [
    { table: 'incident', field: 'caller_id', count: 14, cascade: 'clear' },
    { table: 'task', field: 'assigned_to', count: 0, cascade: 'clear' },
    { table: 'sys_user_grmember', field: 'user', count: 2, cascade: 'delete' },
  ];
  const summary = summarize(incoming);
  const md = refGraphMarkdown({ table: 'sys_user', name: 'Abel Tuter', sysId: ID, summary, incoming, outgoing: [{ label: 'Manager', display: 'Boss', table: 'sys_user' }] });
  assert.match(md, /### What points at Abel Tuter \(sys_user\)/);
  assert.match(md, /\| incident\.caller_id \| 14 \| reference cleared \|/);
  assert.match(md, /\| sys_user_grmember\.user \| 2 \| deleted too \|/);
  assert.ok(!md.includes('task.assigned_to'));
  assert.match(md, /- Manager: Boss \(sys_user\)/);
});
