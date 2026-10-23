const test = require('node:test');
const assert = require('node:assert/strict');
const dm = require('../src/lib/dataModel.js');
const fixture = require('../preview/fixtures/datamodel.js');
const content = require('../src/content/dataModel.js');

// ---- a schema built from plain rows -------------------------------------------------------------------------------

/** tables: { name: [label, parent] }, fields: { table: [[element, internal_type, reference, label?, extra?]] } */
function build(tables, fields) {
  const schema = dm.createSchema();
  dm.addTableRows(schema, Object.entries(tables).map(([name, [label, parent]]) => ({ name, label, 'super_class.name': parent || '' })));
  Object.keys(tables).forEach((table) => {
    dm.addFieldRows(
      schema,
      [table],
      (fields[table] || []).map(([element, type, reference, label, extra]) => ({ name: table, element, internal_type: type, reference: reference || '', column_label: label || element, ...(extra || {}) })),
      { full: true }
    );
  });
  return schema;
}

// A realistic slice: task > incident, sys_user > manager > department, the cmdb_ci hierarchy.
const SCHEMA = build(
  {
    task: ['Task'],
    incident: ['Incident', 'task'],
    problem: ['Problem', 'task'],
    problem_task: ['Problem Task', 'task'],
    sys_user: ['User'],
    sys_user_group: ['Group'],
    sys_user_grmember: ['Group Member'],
    cmn_department: ['Department'],
    cmn_location: ['Location'],
    core_company: ['Company'],
    cmdb_ci: ['Configuration Item'],
    cmdb_ci_hardware: ['Hardware', 'cmdb_ci'],
    cmdb_ci_computer: ['Computer', 'cmdb_ci_hardware'],
    cmdb_ci_server: ['Server', 'cmdb_ci_computer'],
    sys_scope: ['Application'],
    task_ci: ['Affected CI'],
  },
  {
    task: [
      ['number', 'string'],
      ['assigned_to', 'reference', 'sys_user', 'Assigned to'],
      ['assignment_group', 'reference', 'sys_user_group', 'Assignment group'],
      ['opened_by', 'reference', 'sys_user', 'Opened by'],
      ['parent', 'reference', 'task', 'Parent'],
      ['cmdb_ci', 'reference', 'cmdb_ci', 'Configuration item'],
      ['watch_list', 'glide_list', 'sys_user', 'Watch list'],
      ['sys_domain', 'domain_id', 'domain', 'Domain'],
    ],
    incident: [
      ['caller_id', 'reference', 'sys_user', 'Caller'],
      ['parent_incident', 'reference', 'incident', 'Parent incident'],
      ['origin_id', 'document_id', '', 'Origin'],
      ['sys_scope', 'reference', 'sys_scope', 'Scope'],
    ],
    problem: [['first_reported_by_task', 'reference', 'task', 'First reported by']],
    problem_task: [['problem', 'reference', 'problem', 'Problem']],
    sys_user: [
      ['name', 'string', '', 'Name', { display: 'true' }],
      ['manager', 'reference', 'sys_user', 'Manager'],
      ['department', 'reference', 'cmn_department', 'Department'],
      ['location', 'reference', 'cmn_location', 'Location'],
    ],
    sys_user_group: [['manager', 'reference', 'sys_user', 'Manager']],
    sys_user_grmember: [
      ['user', 'reference', 'sys_user', 'User'],
      ['group', 'reference', 'sys_user_group', 'Group'],
    ],
    cmn_department: [
      ['name', 'string'],
      ['dept_head', 'reference', 'sys_user', 'Department head'],
      ['company', 'reference', 'core_company', 'Company'],
    ],
    cmn_location: [['company', 'reference', 'core_company', 'Company']],
    cmdb_ci: [['owned_by', 'reference', 'sys_user', 'Owned by']],
    cmdb_ci_hardware: [['serial_number', 'string']],
    task_ci: [
      ['task', 'reference', 'task', 'Task'],
      ['ci_item', 'reference', 'cmdb_ci', 'Configuration item'],
    ],
  }
);

// ---- names, hierarchy, fields -------------------------------------------------------------------------------------

test('cleanName accepts plain table and column names and nothing else', () => {
  assert.equal(dm.cleanName(' Incident '), 'incident');
  assert.equal(dm.cleanName('x_acme_order'), 'x_acme_order');
  assert.equal(dm.cleanName('incident^active=true'), '');
  assert.equal(dm.cleanName('a.b'), '');
  assert.equal(dm.cleanName(''), '');
  assert.equal(dm.cleanName(null), '');
});

test('isSystemTable: sys_*, syslog, sysevent and sysauto, not tables that merely contain sys', () => {
  ['sys_user', 'sys_audit', 'syslog_transaction', 'sysevent', 'sysauto_script'].forEach((t) => assert.equal(dm.isSystemTable(t), true, t));
  ['incident', 'task_sla', 'cmn_department', 'x_sys_thing', 'sysapproval_approver'].forEach((t) => assert.equal(dm.isSystemTable(t), false, t));
});

test('chainOf flattens the hierarchy, nearest first, and survives a cycle and an unknown parent', () => {
  assert.deepEqual(dm.chainOf(SCHEMA, 'cmdb_ci_server'), ['cmdb_ci_server', 'cmdb_ci_computer', 'cmdb_ci_hardware', 'cmdb_ci']);
  assert.deepEqual(dm.chainOf(SCHEMA, 'task'), ['task']);
  assert.deepEqual(dm.chainOf(SCHEMA, 'not_loaded'), ['not_loaded']);
  const loop = build({ a: ['A', 'b'], b: ['B', 'a'] }, {});
  assert.deepEqual(dm.chainOf(loop, 'a'), ['a', 'b']);
  assert.equal(dm.isA(SCHEMA, 'incident', 'task'), true);
  assert.equal(dm.isA(SCHEMA, 'task', 'incident'), false);
  assert.equal(dm.isA(SCHEMA, 'incident', 'incident'), true);
});

test('fieldsOf: inherited fields are included and marked with the table that defines them', () => {
  const fields = dm.fieldsOf(SCHEMA, 'incident');
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.caller_id.inherited, false);
  assert.equal(byName.caller_id.definedOn, 'incident');
  assert.equal(byName.assigned_to.inherited, true);
  assert.equal(byName.assigned_to.definedOn, 'task');
  assert.deepEqual(fields.map((f) => f.name), [...fields.map((f) => f.name)].sort(), 'sorted by name');
});

test('fieldsOf: a field redefined on a child wins over the parent definition', () => {
  const schema = build({ base: ['Base'], child: ['Child', 'base'] }, { base: [['owner', 'reference', 'sys_user', 'Owner']], child: [['owner', 'reference', 'sys_user_group', 'Owner group']] });
  const owner = dm.fieldsOf(schema, 'child').find((f) => f.name === 'owner');
  assert.equal(owner.target, 'sys_user_group');
  assert.equal(owner.definedOn, 'child');
  assert.equal(dm.fieldsOf(schema, 'base').find((f) => f.name === 'owner').target, 'sys_user');
});

test('field kinds: reference is walkable, glide_list and document_id are not, domain_id and strings are not references at all', () => {
  const byName = Object.fromEntries(dm.fieldsOf(SCHEMA, 'incident').map((f) => [f.name, f]));
  assert.equal(byName.caller_id.kind, 'reference');
  assert.equal(byName.watch_list.kind, 'list');
  assert.equal(byName.origin_id.kind, 'generic');
  assert.equal(byName.origin_id.target, '');
  assert.equal(byName.sys_domain.kind, '');
  assert.equal(byName.number.kind, '');
  assert.deepEqual(dm.refFieldsOf(SCHEMA, 'incident').map((f) => f.name).includes('number'), false);
});

// ---- incoming and outgoing ----------------------------------------------------------------------------------------

const dictRow = (table, element, type, reference, label) => ({ name: table, element, internal_type: type, reference, column_label: label || element });

test('incomingEntries: fields pointing at the table or a parent, marked viaParent; document ids and other tables are left out', () => {
  const rows = [
    dictRow('problem', 'first_reported_by_task', 'reference', 'task'),
    dictRow('incident', 'parent_incident', 'reference', 'incident'),
    dictRow('task_ci', 'task', 'reference', 'task'),
    dictRow('task_ci', 'ci_item', 'reference', 'cmdb_ci'),
    dictRow('sys_email', 'instance', 'document_id', ''),
    dictRow('task_ci', 'task', 'reference', 'task'), // duplicate row
    dictRow('problem', 'watchers', 'glide_list', 'task', 'Watchers'),
  ];
  const entries = dm.incomingEntries(rows, ['incident', 'task']);
  assert.deepEqual(entries.map((e) => `${e.table}.${e.name}`), ['incident.parent_incident', 'problem.first_reported_by_task', 'problem.watchers', 'task_ci.task']);
  assert.equal(entries.find((e) => e.name === 'parent_incident').viaParent, false);
  assert.equal(entries.find((e) => e.name === 'task').viaParent, true);
  assert.equal(entries.find((e) => e.name === 'watchers').kind, 'list');
});

test('groupIncoming: grouped by table, system tables hidden on request and counted, filter by text', () => {
  const entries = dm.incomingEntries(
    [
      dictRow('sys_user_grmember', 'user', 'reference', 'sys_user'),
      dictRow('sys_user_preference', 'user', 'reference', 'sys_user'),
      dictRow('task', 'assigned_to', 'reference', 'sys_user'),
      dictRow('task', 'opened_by', 'reference', 'sys_user'),
      dictRow('cmn_department', 'dept_head', 'reference', 'sys_user'),
    ],
    ['sys_user']
  );
  const all = dm.groupIncoming(entries);
  assert.deepEqual(all.groups.map((g) => [g.table, g.count]), [['cmn_department', 1], ['sys_user_grmember', 1], ['sys_user_preference', 1], ['task', 2]]);
  assert.equal(all.groups.find((g) => g.table === 'sys_user_grmember').system, true);
  const hidden = dm.groupIncoming(entries, { hideSystem: true });
  assert.deepEqual(hidden.groups.map((g) => g.table), ['cmn_department', 'task']);
  assert.equal(hidden.hiddenGroups, 2);
  assert.equal(hidden.hiddenFields, 2);
  assert.equal(hidden.totalFields, 5);
  const found = dm.groupIncoming(entries, { query: 'DEPT' });
  assert.deepEqual(found.groups.map((g) => g.table), ['cmn_department']);
  assert.deepEqual(dm.groupIncoming(entries, { query: 'Group', labels: { sys_user_grmember: 'Group Member' } }).groups.map((g) => g.table), ['sys_user_grmember']);
});

test('groupOutgoing: several fields to one table form one group; generic fields come last with no target', () => {
  const groups = dm.groupOutgoing(dm.refFieldsOf(SCHEMA, 'incident'));
  const user = groups.find((g) => g.target === 'sys_user');
  assert.deepEqual(user.fields.map((f) => f.name), ['assigned_to', 'caller_id', 'opened_by', 'watch_list']);
  assert.equal(user.fields.find((f) => f.name === 'assigned_to').inherited, true);
  assert.equal(user.fields.find((f) => f.name === 'watch_list').kind, 'list');
  const last = groups[groups.length - 1];
  assert.equal(last.generic, true);
  assert.equal(last.target, '');
  assert.deepEqual(last.fields.map((f) => f.name), ['origin_id']);
});

test('detectLinkTables: a table with two to four reference fields, one of them aimed here', () => {
  const refs = (table, list) => list.map(([name, target]) => ({ table, name, kind: 'reference', target }));
  const refsByTable = new Map([
    ['sys_user_grmember', refs('sys_user_grmember', [['user', 'sys_user'], ['group', 'sys_user_group']])],
    ['sys_user_preference', refs('sys_user_preference', [['user', 'sys_user']])],
    ['cmdb_rel_ci', refs('cmdb_rel_ci', [['parent', 'cmdb_ci'], ['child', 'cmdb_ci'], ['type', 'cmdb_rel_type'], ['sys_scope', 'sys_scope']])],
    ['task', refs('task', [['a', 'sys_user'], ['b', 'sys_user'], ['c', 'x'], ['d', 'y'], ['e', 'z']])],
  ]);
  const incoming = [{ table: 'sys_user_grmember' }, { table: 'sys_user_preference' }, { table: 'task' }];
  const found = dm.detectLinkTables({ chain: ['sys_user'], incoming, refsByTable, defined: new Set(['sys_user_grmember']) });
  assert.deepEqual(found.map((l) => l.table), ['sys_user_grmember']);
  assert.deepEqual(found[0].others, [{ field: 'group', target: 'sys_user_group' }]);
  assert.equal(found[0].defined, true);
  const rel = dm.detectLinkTables({ chain: ['cmdb_ci'], incoming: [{ table: 'cmdb_rel_ci' }], refsByTable });
  assert.deepEqual(rel[0].toHere, ['child', 'parent']);
  assert.deepEqual(rel[0].others, [{ field: 'type', target: 'cmdb_rel_type' }], 'the scope reference does not count');
});

// ---- the map and its layout ---------------------------------------------------------------------------------------

function sampleModel(extra = {}) {
  const incomingRows = [
    dictRow('task_ci', 'task', 'reference', 'task', 'Task'),
    dictRow('problem', 'first_reported_by_task', 'reference', 'task', 'First reported by'),
    dictRow('incident', 'parent_incident', 'reference', 'incident', 'Parent incident'),
    dictRow('sys_user_preference', 'x', 'reference', 'incident', 'X'),
  ];
  return {
    table: 'incident',
    label: 'Incident',
    chain: ['incident', 'task'],
    labels: { task: 'Task', task_ci: 'Affected CI' },
    children: [],
    descendantCount: 0,
    outgoing: dm.refFieldsOf(SCHEMA, 'incident'),
    incoming: dm.incomingEntries(incomingRows, ['incident', 'task']),
    ...extra,
  };
}

test('buildMapGraph and describeGraph put the parents, children and both reference directions into one picture', () => {
  const graph = dm.buildMapGraph(sampleModel({ children: [{ name: 'major_incident', label: 'Major incident' }], descendantCount: 4 }));
  assert.deepEqual(graph.parents, [{ table: 'task', label: 'Task' }]);
  assert.equal(graph.descendantCount, 4);
  assert.deepEqual(graph.incoming.map((g) => g.table), ['incident', 'problem', 'sys_user_preference', 'task_ci']);
  assert.equal(dm.buildMapGraph(sampleModel(), { hideSystem: true }).incoming.some((g) => g.table === 'sys_user_preference'), false);
  const text = dm.describeGraph(graph);
  assert.match(text, /incident extends task/);
  assert.match(text, /4 tables extend it/);
  assert.match(text, /point here/);
});

test('mapToMarkdown writes the extends chain, both reference directions and what was left out', () => {
  const model = sampleModel({ rowCount: 91244, scopeName: 'Global', children: [{ name: 'major_incident', label: '' }], descendantCount: 3 });
  const text = dm.mapToMarkdown(model, dm.buildMapGraph(model, { hideSystem: true }));
  assert.ok(text.startsWith('# Incident (incident)\n'));
  assert.ok(text.includes('Extends: task\n'));
  assert.ok(text.includes('Extended by (3): major_incident, ...\n'));
  assert.ok(text.includes('- sys_user: assigned_to (from task), caller_id, opened_by (from task), watch_list (list, from task)\n'));
  assert.ok(text.includes('- (any table, document id): origin_id\n'));
  assert.ok(text.includes('## Pointed at by (1 system-table fields left out)\n'));
  assert.ok(text.includes('- task_ci: task (points at task)\n'));
  assert.ok(text.endsWith('\n'));
});

test('layoutMap: no two nodes overlap, edges join real nodes, every node is inside the picture', () => {
  const graph = dm.buildMapGraph(sampleModel({ children: Array.from({ length: 12 }, (_, i) => ({ name: `child_${i}`, label: '' })), descendantCount: 30 }));
  const layout = dm.layoutMap(graph);
  assert.deepEqual(dm.overlappingNodes(layout.nodes), []);
  const ids = new Set(layout.nodes.map((n) => n.id));
  layout.edges.forEach((e) => {
    assert.ok(ids.has(e.from), `edge from ${e.from}`);
    assert.ok(ids.has(e.to), `edge to ${e.to}`);
  });
  layout.nodes.forEach((n) => {
    assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= layout.width && n.y + n.h <= layout.height, `${n.id} is inside`);
  });
  assert.equal(new Set(layout.nodes.map((n) => n.id)).size, layout.nodes.length, 'unique ids');
});

test('layoutMap: incoming on the left, outgoing on the right, parents above and children below the table', () => {
  const layout = dm.layoutMap(dm.buildMapGraph(sampleModel({ children: [{ name: 'major_incident', label: '' }], descendantCount: 1 })));
  const node = (id) => layout.nodes.find((n) => n.id === id);
  const centre = node('c:incident');
  assert.ok(node('i:task_ci').x + node('i:task_ci').w < centre.x, 'incoming is left of the table');
  assert.ok(node('o:sys_user').x > centre.x + centre.w, 'outgoing is right of the table');
  assert.ok(node('p:task').y + node('p:task').h <= centre.y, 'parent is above');
  assert.ok(node('k:major_incident').y >= centre.y + centre.h, 'child is below');
  assert.equal(node('i:task_ci').kind, 'incoming');
  assert.equal(node('o:sys_user').kind, 'outgoing');
  assert.equal(node('o:generic').kind, 'generic');
});

test('layoutMap is deterministic and caps each side with a "+N more" node', () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ table: `t${String(i).padStart(2, '0')}`, name: 'ref', label: 'Ref', kind: 'reference', target: 'incident', viaParent: false }));
  const graph = dm.buildMapGraph(sampleModel({ incoming: entries }));
  const a = dm.layoutMap(graph, { maxPerSide: 8 });
  const b = dm.layoutMap(graph, { maxPerSide: 8 });
  assert.deepEqual(a, b);
  assert.equal(a.nodes.filter((n) => n.kind === 'incoming').length, 8);
  assert.equal(a.hidden.incoming, 22);
  assert.ok(a.nodes.some((n) => n.kind === 'more' && n.title === '+22 more'));
  assert.deepEqual(dm.overlappingNodes(a.nodes), []);
});

test('layoutMap: a table with no incoming references has no empty left column', () => {
  const graph = dm.buildMapGraph(sampleModel({ incoming: [] }));
  const layout = dm.layoutMap(graph);
  const centre = layout.nodes.find((n) => n.kind === 'centre');
  assert.ok(centre.x <= 20, `the table starts at the left edge (${centre.x})`);
  const bare = dm.layoutMap(dm.buildMapGraph({ table: 'lonely', chain: ['lonely'], children: [], outgoing: [], incoming: [] }));
  assert.equal(bare.nodes.length, 1);
  assert.ok(bare.width > 0 && bare.height > 0);
});

test('layoutMap: edges are labelled with the field name, more fields as +N', () => {
  const layout = dm.layoutMap(dm.buildMapGraph(sampleModel()));
  const toUser = layout.edges.find((e) => e.id === 'e:o:sys_user');
  assert.equal(toUser.label, 'assigned_to +3');
  assert.deepEqual(toUser.fields, ['assigned_to', 'caller_id', 'opened_by', 'watch_list']);
  assert.equal(layout.edges.find((e) => e.id === 'e:i:task_ci').label, 'task');
});

// ---- path finder --------------------------------------------------------------------------------------------------

const walks = (result) => result.paths.map((p) => p.dotWalk);

test('findPaths: incident to sys_user - the shortest dot-walks, inherited fields included, lists and longer routes left out', () => {
  const result = dm.findPaths(SCHEMA, 'incident', 'sys_user');
  assert.equal(result.shortest, 1);
  assert.deepEqual(walks(result), ['assigned_to', 'caller_id', 'opened_by']);
  assert.equal(result.paths[0].hops[0].definedOn, 'task', 'assigned_to is inherited from task');
  assert.deepEqual(result.paths.map((p) => p.length), [1, 1, 1]);
  assert.deepEqual(result.list.map((p) => p.dotWalk), ['watch_list'], 'a list field is reported, never walked');
  assert.equal(result.routes.length, 1);
  assert.deepEqual(result.routes[0].tables, ['incident', 'sys_user']);
  assert.equal(result.routes[0].variants.length, 3);
});

test('findPaths: incident to cmn_department goes through a user; asking for longer paths adds the manager route', () => {
  const shortest = dm.findPaths(SCHEMA, 'incident', 'cmn_department');
  assert.deepEqual(walks(shortest), ['assigned_to.department', 'caller_id.department', 'opened_by.department']);
  assert.equal(shortest.shortest, 2);
  const longer = dm.findPaths(SCHEMA, 'incident', 'cmn_department', { extra: 1 });
  assert.ok(walks(longer).includes('caller_id.manager.department'), 'the manager route is a path of three steps');
  assert.ok(walks(longer).includes('caller_id.department'));
  const lengths = longer.routes.map((r) => r.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b), 'routes are ordered shortest first');
  assert.equal(lengths[0], 2);
  assert.ok(longer.routes.some((r) => r.tables.join('>') === 'incident>sys_user>sys_user>cmn_department'));
});

test('findPaths: a self reference (sys_user.manager) may be used once, so a cycle cannot run away', () => {
  const result = dm.findPaths(SCHEMA, 'sys_user', 'cmn_department', { maxDepth: 4, extra: 3 });
  const list = walks(result);
  assert.ok(list.includes('department'));
  assert.ok(list.includes('manager.department'));
  assert.ok(!list.some((p) => p.includes('manager.manager')), 'the same edge is never repeated within one path');
  assert.ok(list.every((p) => p.split('.').length <= 4));
});

test('findPaths: maxDepth limits how far it looks', () => {
  assert.deepEqual(walks(dm.findPaths(SCHEMA, 'incident', 'cmn_department', { maxDepth: 1 })), []);
  assert.deepEqual(walks(dm.findPaths(SCHEMA, 'incident', 'core_company', { maxDepth: 2 })), [], 'the company is three steps away');
  const found = dm.findPaths(SCHEMA, 'incident', 'core_company', { maxDepth: 3 });
  assert.equal(found.shortest, 3);
  assert.ok(walks(found).includes('caller_id.department.company'));
  assert.ok(walks(found).includes('caller_id.location.company'));
  const none = dm.findPaths(SCHEMA, 'incident', 'core_company', { maxDepth: 1 });
  assert.equal(none.paths.length, 0);
  assert.equal(none.shortest, -1);
});

test('routes: the route most field names lead along comes first among equal lengths', () => {
  const r = dm.findPaths(SCHEMA, 'incident', 'cmn_department').routes;
  assert.deepEqual(r[0].tables, ['incident', 'sys_user', 'cmn_department']);
  assert.equal(r[0].variants.length, 3);
});

test('findPaths: several routes of equal length are all returned and grouped by the tables they pass', () => {
  const diamond = build(
    { a: ['A'], b: ['B'], c: ['C'], d: ['D'] },
    { a: [['via_b', 'reference', 'b'], ['also_b', 'reference', 'b'], ['via_c', 'reference', 'c']], b: [['to_d', 'reference', 'd']], c: [['to_d', 'reference', 'd'], ['other_d', 'reference', 'd']] }
  );
  const result = dm.findPaths(diamond, 'a', 'd');
  assert.deepEqual(walks(result).sort(), ['also_b.to_d', 'via_b.to_d', 'via_c.other_d', 'via_c.to_d']);
  assert.deepEqual(result.routes.map((r) => [r.tables.join('>'), r.variants.length]), [['a>b>d', 2], ['a>c>d', 2]]);
});

test('findPaths: a field that points at a table extending the target counts (a problem is a task)', () => {
  const result = dm.findPaths(SCHEMA, 'problem_task', 'task');
  assert.deepEqual(walks(result), ['parent', 'problem']);
  assert.equal(result.paths.find((p) => p.dotWalk === 'problem').viaChild, true, 'a problem is a task, but not every task is a problem');
  assert.equal(result.paths.find((p) => p.dotWalk === 'parent').viaChild, false);
  const direct = dm.findPaths(SCHEMA, 'incident', 'task');
  assert.deepEqual(walks(direct), ['parent', 'parent_incident']);
  assert.equal(direct.paths[0].viaChild, false);
  assert.equal(direct.paths[1].viaChild, true, 'parent_incident points at an incident, which is a task');
  assert.equal(direct.inherits, true, 'incident already is a task');
});

test('findPaths: same table, unknown table, and bad names never throw', () => {
  const same = dm.findPaths(SCHEMA, 'incident', 'incident');
  assert.equal(same.same, true);
  assert.deepEqual(same.paths, []);
  assert.deepEqual(dm.findPaths(SCHEMA, 'incident', 'no_such_table').paths, []);
  assert.deepEqual(dm.findPaths(SCHEMA, 'incident; drop', 'sys_user').paths, []);
});

test('findPaths: generic references are reported only when nothing walkable exists, and tables that were not read are named', () => {
  const generic = build({ a: ['A'], z: ['Z'] }, { a: [['doc', 'document_id', '', 'Document']] });
  const result = dm.findPaths(generic, 'a', 'z');
  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.generic.map((p) => p.dotWalk), ['doc']);
  assert.equal(result.generic[0].hops[0].kind, 'generic');
  assert.deepEqual(dm.findPaths(SCHEMA, 'incident', 'sys_user').generic, [], 'a walkable path hides the generic list');

  const partial = build({ a: ['A'], b: ['B'], z: ['Z'] }, {});
  partial.fields.delete('b'); // b was never read
  dm.addFieldRows(partial, ['a'], [{ name: 'a', element: 'to_b', internal_type: 'reference', reference: 'b' }], { full: false });
  const unread = dm.findPaths(partial, 'a', 'z');
  assert.deepEqual(unread.unexpanded, ['b']);
});

test('findPaths: fields to sys_scope and sys_domain are not routes', () => {
  const result = dm.findPaths(SCHEMA, 'incident', 'sys_scope');
  assert.deepEqual(result.paths.map((p) => p.dotWalk), ['sys_scope'], 'allowed when the scope table is the target itself');
  const through = dm.findPaths(SCHEMA, 'incident', 'sys_user', { extra: 1 });
  assert.ok(!through.paths.some((p) => p.dotWalk.includes('sys_scope')));
});

test('findPaths: a huge fan-out is bounded and says so', () => {
  const fields = { a: [], x: [['to_z', 'reference', 'z']] };
  for (let i = 0; i < 60; i += 1) fields.a.push([`f${String(i).padStart(2, '0')}`, 'reference', 'x']);
  const wide = build({ a: ['A'], x: ['X'], z: ['Z'] }, fields);
  const result = dm.findPaths(wide, 'a', 'z');
  assert.equal(result.truncated, true);
  assert.equal(result.paths.length, dm.PATH_LIMITS.perEnd);
  assert.equal(result.routes.length, 1);
});

test('the stepper asks for the hierarchy of the frontier and the fields of every step but the last', () => {
  const state = dm.startPathSearch('incident', 'sys_user', { maxDepth: 2 });
  assert.deepEqual(dm.pathNeeds(state), { hierarchy: ['incident'], fields: ['incident'] });
  dm.advancePathSearch(state, SCHEMA);
  const second = dm.pathNeeds(state);
  assert.ok(second.hierarchy.includes('sys_user'));
  assert.ok(second.fields.includes('sys_user_group'));
  // The target was reached: the search stops without asking for more.
  dm.advancePathSearch(state, SCHEMA);
  assert.equal(state.done, true);
  assert.deepEqual(dm.pathNeeds(state), { hierarchy: [], fields: [] });
});

// ---- snippets -----------------------------------------------------------------------------------------------------

const PATH = dm.findPaths(SCHEMA, 'incident', 'cmn_department', { extra: 1 }).paths.find((p) => p.dotWalk === 'caller_id.manager.department');

test('copy snippets: dot-walk string, GlideRecord line, getElement, Table API fragment, encoded query', () => {
  assert.equal(dm.dotWalkString(PATH), 'caller_id.manager.department');
  assert.equal(dm.dotWalkString(PATH, 'name'), 'caller_id.manager.department.name');
  assert.equal(dm.glideRecordLine(PATH, 'name'), 'gr.caller_id.manager.department.name.toString()');
  assert.equal(dm.getElementLine(PATH, 'name'), "gr.getElement('caller_id.manager.department.name').toString()");
  assert.equal(dm.tableApiFragment(PATH, 'name'), 'sysparm_fields=caller_id.manager.department.name');
  assert.equal(dm.encodedQueryCondition(PATH, 'name'), 'caller_id.manager.department.name=');
  assert.equal(dm.encodedQueryCondition(PATH, 'name', 'LIKE'), 'caller_id.manager.department.nameLIKE');
  assert.equal(dm.glideRecordLine(PATH, 'name', 'current'), 'current.caller_id.manager.department.name.toString()');
});

test('copy snippets never carry anything but plain names', () => {
  assert.equal(dm.glideRecordLine(PATH, 'name', "x'); evil('"), 'gr.caller_id.manager.department.name.toString()', 'a bad variable name falls back to gr');
  assert.equal(dm.dotWalkString(PATH, "name'); drop"), 'caller_id.manager.department', 'a bad column name is dropped');
  assert.equal(dm.tableApiFragment(PATH, ''), 'sysparm_fields=caller_id.manager.department.sys_id');
});

test('pickLeaf prefers the display column, then name, number, short_description, sys_id', () => {
  assert.equal(dm.pickLeaf(dm.fieldsOf(SCHEMA, 'sys_user')), 'name');
  assert.equal(dm.pickLeaf([{ name: 'number', display: false }, { name: 'title', display: true }]), 'title');
  assert.equal(dm.pickLeaf([{ name: 'number' }, { name: 'short_description' }]), 'number');
  assert.equal(dm.pickLeaf([{ name: 'foo' }]), 'sys_id');
  assert.equal(dm.pickLeaf([]), 'sys_id');
});

// ---- walking a dot-walked name, the field tree, arguments -------------------------------------------------------------

test('walkTo follows reference fields and explains why it stops', () => {
  assert.deepEqual(dm.walkTo(SCHEMA, 'incident', 'caller_id.manager'), { ok: true, table: 'sys_user', trail: [{ table: 'incident', field: 'caller_id', target: 'sys_user' }, { table: 'sys_user', field: 'manager', target: 'sys_user' }] });
  assert.equal(dm.walkTo(SCHEMA, 'incident', '').table, 'incident');
  assert.match(dm.walkTo(SCHEMA, 'incident', 'number.x').error, /not a reference/);
  assert.match(dm.walkTo(SCHEMA, 'incident', 'origin_id.number').error, /any table/);
  assert.match(dm.walkTo(SCHEMA, 'incident', 'watch_list.name').error, /list of references/);
  assert.match(dm.walkTo(SCHEMA, 'incident', 'nope').error, /no field "nope"/);
});

test('fieldTree: reference fields carry the target table fields down to the depth, others do not', () => {
  const one = dm.fieldTree(SCHEMA, 'incident', 1);
  assert.ok(one.fields.every((f) => !f.children));
  const two = dm.fieldTree(SCHEMA, 'incident', 2);
  const caller = two.fields.find((f) => f.name === 'caller_id');
  assert.ok(caller.children.some((f) => f.name === 'manager'));
  assert.ok(caller.children.find((f) => f.name === 'manager').children === undefined, 'depth 2 stops there');
  const three = dm.fieldTree(SCHEMA, 'incident', 3);
  assert.ok(three.fields.find((f) => f.name === 'caller_id').children.find((f) => f.name === 'manager').children.some((f) => f.name === 'department'));
  assert.equal(two.fields.find((f) => f.name === 'watch_list').children, undefined, 'a list is not expanded');
  const small = dm.fieldTree(SCHEMA, 'incident', 3, { maxNodes: 5 });
  assert.equal(small.truncated, true);
});

test('parseArgs: one table is the map, two are the path finder, filler words are ignored', () => {
  assert.deepEqual(dm.parseArgs('incident', ''), { mode: 'map', table: 'incident', from: 'incident', to: '' });
  assert.deepEqual(dm.parseArgs('incident sys_user'), { mode: 'path', table: 'incident', from: 'incident', to: 'sys_user' });
  assert.deepEqual(dm.parseArgs('path incident to sys_user').mode, 'path');
  assert.deepEqual(dm.parseArgs('Incident -> Sys_User'), { mode: 'path', table: 'incident', from: 'incident', to: 'sys_user' });
  assert.deepEqual(dm.parseArgs('', 'problem'), { mode: 'map', table: 'problem', from: 'problem', to: '' });
  assert.deepEqual(dm.parseArgs('', ''), { mode: 'map', table: '', from: '', to: '' });
  assert.equal(dm.parseArgs('incident^active=true').table, '');
});

// ---- the instance half, against the preview fixture ----------------------------------------------------------------

function stubInstance(options = {}) {
  global.__DATAMODEL_FIXTURE__ = true;
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
  const calls = [];
  global.fetch = async (url) => {
    const u = new URL(url, 'https://dev1.service-now.com');
    const table = u.pathname.split('/').pop();
    calls.push({ table, kind: u.pathname.includes('/stats/') ? 'stats' : 'table', query: u.searchParams.get('sysparm_query') || '', fields: u.searchParams.get('sysparm_fields') || '' });
    if (options.deny && options.deny({ table, query: u.searchParams.get('sysparm_query') || '' })) return new Response(JSON.stringify({ error: { message: 'User Not Authorized' } }), { status: 403, headers: { 'content-type': 'application/json' } });
    if (options.empty && options.empty({ table })) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return fixture.route('GET', u, null) || new Response(JSON.stringify({ result: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

test('dataModelLoad: the map of incident from the instance - parents, inherited references, incoming from table and parent', async () => {
  const calls = stubInstance();
  content.dataModelReset();
  const map = await content.dataModelLoad({ table: 'incident' });
  assert.equal(map.table, 'incident');
  assert.equal(map.label, 'Incident');
  assert.equal(map.rowCount, 91244);
  assert.deepEqual(map.chain, ['incident', 'task']);
  assert.deepEqual(map.children, []);
  const out = Object.fromEntries(map.outgoing.map((f) => [f.name, f]));
  assert.equal(out.caller_id.target, 'sys_user');
  assert.equal(out.assigned_to.inherited, true);
  assert.equal(out.assigned_to.definedOn, 'task');
  assert.equal(out.watch_list.kind, 'list');
  assert.equal(out.origin_id.kind, 'generic');
  assert.equal(out.sys_domain, undefined, 'a domain id is not a reference');
  const inc = map.incoming.map((e) => `${e.table}.${e.name}`);
  assert.ok(inc.includes('task_sla.task'));
  assert.ok(inc.includes('incident.parent_incident'));
  assert.ok(inc.includes('problem.first_reported_by_task'));
  assert.equal(map.incoming.find((e) => e.table === 'task_sla').viaParent, true, 'task_sla.task points at the parent task');
  assert.equal(map.incoming.find((e) => e.name === 'parent_incident').viaParent, false);
  assert.equal(map.labels.task_sla, 'Task SLA');
  assert.deepEqual(map.notes, []);
  const joins = (map.linkTables || []).find((l) => l.table === 'task_ci');
  assert.deepEqual(joins.others, [{ field: 'ci_item', target: 'cmdb_ci' }]);
  assert.equal(joins.defined, true, 'sys_m2m lists task_ci');
  // Batched reads: no query asks for one column or one table at a time.
  const dict = calls.filter((c) => c.table === 'sys_dictionary' && c.kind === 'table');
  assert.ok(dict.length <= 4, `dictionary queries: ${dict.length}`);
  assert.ok(dict.every((c) => /nameIN|referenceIN/.test(c.query)));
});

test('dataModelLoad: children and the descendant count of a hierarchy (cmdb_ci)', async () => {
  stubInstance();
  content.dataModelReset();
  const map = await content.dataModelLoad({ table: 'cmdb_ci' });
  assert.deepEqual(map.children.map((c) => c.name), ['cmdb_ci_hardware', 'cmdb_ci_service']);
  assert.equal(map.childCount, 2);
  assert.equal(map.descendantCount, 6, 'hardware, service, computer, server, linux and windows server');
  assert.equal(map.descendantsMore, false);
  const server = await content.dataModelLoad({ table: 'cmdb_ci_server' });
  assert.deepEqual(server.chain, ['cmdb_ci_server', 'cmdb_ci_computer', 'cmdb_ci_hardware', 'cmdb_ci']);
  assert.ok(server.outgoing.some((f) => f.name === 'model_id' && f.definedOn === 'cmdb_ci_hardware' && f.inherited));
  assert.ok(server.incoming.some((e) => e.table === 'task_ci' && e.name === 'ci_item' && e.viaParent), 'a reference to cmdb_ci can hold a server');
});

test('dataModelLoad: an unknown table is an error, a cancelled run answers cancelled, a denied dictionary is named', async () => {
  stubInstance();
  content.dataModelReset();
  await assert.rejects(() => content.dataModelLoad({ table: 'no_such_table' }), /No table called "no_such_table"/);
  await assert.rejects(() => content.dataModelLoad({ table: 'incident; drop' }), /table name/);
  content.dataModelReset();
  assert.deepEqual(await content.dataModelLoad({ table: 'incident', isCancelled: () => true }), { cancelled: true });

  stubInstance({ empty: ({ table }) => table === 'sys_dictionary' });
  content.dataModelReset();
  const blind = await content.dataModelLoad({ table: 'incident' });
  assert.ok(blind.notes.some((n) => /cannot read sys_dictionary/.test(n)), blind.notes.join('|'));
  assert.deepEqual(blind.outgoing, []);

  stubInstance({ deny: ({ table }) => table === 'sys_dictionary' });
  content.dataModelReset();
  await assert.rejects(() => content.dataModelLoad({ table: 'incident' }), /not allowed/);

  stubInstance({ deny: ({ table, query }) => table === 'sys_dictionary' && query.startsWith('referenceIN') });
  content.dataModelReset();
  const partial = await content.dataModelLoad({ table: 'incident' });
  assert.ok(partial.notes.some((n) => /Could not read which fields point at this table/.test(n)), partial.notes.join('|'));
  assert.ok(partial.outgoing.length > 5, 'the outgoing references were still read');
  assert.deepEqual(partial.incoming, []);
});

test('dataModelFindPaths reads the dictionary in batches and finds the manager route', async () => {
  const calls = stubInstance();
  content.dataModelReset();
  const progress = [];
  const result = await content.dataModelFindPaths({ from: 'incident', to: 'cmn_department', onProgress: (p) => progress.push(p.text) });
  const walked = result.paths.map((p) => p.dotWalk);
  ['assigned_to.department', 'caller_id.department', 'opened_by.department', 'cmdb_ci.department'].forEach((w) => assert.ok(walked.includes(w), w));
  assert.ok(result.routes.some((r) => r.tables.join('>') === 'incident>sys_user>cmn_department' && r.variants.length >= 3));
  assert.ok(progress.length >= 2);
  assert.ok(progress.some((t) => /Step 1/.test(t)));
  const dict = calls.filter((c) => c.table === 'sys_dictionary');
  assert.ok(dict.length <= 6, `dictionary queries: ${dict.length}`);
  assert.ok(dict.every((c) => c.query.startsWith('nameIN')));
  assert.equal(result.labels.cmn_department, 'Department');

  const before = calls.length;
  const longer = await content.dataModelFindPaths({ from: 'incident', to: 'cmn_department', extra: 1 });
  assert.ok(longer.paths.some((p) => p.dotWalk === 'caller_id.manager.department'));
  assert.ok(calls.length - before < 20, 'the second search reuses what was read');
});

test('dataModelFindPaths: nothing forward falls back to the other direction; unreachable says so', async () => {
  stubInstance();
  content.dataModelReset();
  const back = await content.dataModelFindPaths({ from: 'sys_user_group', to: 'incident' });
  assert.deepEqual(back.paths, []);
  assert.ok(back.reverse.paths.some((p) => p.dotWalk === 'assignment_group'), 'an incident points at a group, not the other way round');
  const lost = await content.dataModelFindPaths({ from: 'sc_cat_item', to: 'incident', maxDepth: 3 });
  assert.deepEqual(lost.paths, []);
  assert.equal(lost.reverse, null, 'nothing in the other direction either');
  const wrongWay = await content.dataModelFindPaths({ from: 'cmn_department', to: 'incident', maxDepth: 2 });
  assert.deepEqual(wrongWay.paths, []);
  assert.ok(wrongWay.reverse && wrongWay.reverse.paths.some((p) => p.dotWalk === 'caller_id.department' || p.dotWalk.endsWith('department')), 'incident reaches the department');
  await assert.rejects(() => content.dataModelFindPaths({ from: 'incident', to: 'no_such_table' }), /No table called/);
  assert.deepEqual(await content.dataModelFindPaths({ from: 'incident', to: 'sys_user', isCancelled: () => true }), { cancelled: true });
});

test('dataModelFieldTree and dataModelResolvePath: for other features that want dot-walk completions', async () => {
  stubInstance();
  content.dataModelReset();
  const tree = await content.dataModelFieldTree('incident', 2);
  const caller = tree.fields.find((f) => f.name === 'caller_id');
  assert.ok(caller.children.some((f) => f.name === 'email'), 'the user table fields are under caller_id');
  assert.ok(tree.fields.some((f) => f.name === 'number'), 'non-reference fields are in the tree too');
  const reached = await content.dataModelResolvePath('incident', 'caller_id.manager');
  assert.equal(reached.ok, true);
  assert.equal(reached.table, 'sys_user');
  const blocked = await content.dataModelResolvePath('incident', 'watch_list.name');
  assert.equal(blocked.ok, false);
  const fields = await content.dataModelFields({ table: 'sys_user' });
  assert.equal(dm.pickLeaf(fields.fields), 'name');
  assert.ok(content.dataModelServices.dataModelFieldTree);
  assert.ok(Object.keys(content.dataModelServices).every((k) => k.startsWith('dataModel')));
});

// ---- review fixes ------------------------------------------------------------------------------------------------------

test('findPaths: on the last step only paths that can still arrive are kept, and the answer does not change', () => {
  const state = dm.startPathSearch('incident', 'cmn_department', { maxDepth: 2 });
  dm.advancePathSearch(state, SCHEMA);
  dm.advancePathSearch(state, SCHEMA);
  assert.ok(state.frontier.length > 0);
  assert.ok(state.frontier.every((p) => p.tables[p.tables.length - 1] === 'cmn_department'), state.frontier.map((p) => p.tables.join('>')).join(' | '));
  assert.deepEqual(walks(dm.findPaths(SCHEMA, 'incident', 'cmn_department', { maxDepth: 2 })).sort(), ['assigned_to.department', 'caller_id.department', 'opened_by.department']);
  // A table whose parents are not read yet is kept: it may still turn out to extend the target.
  const partial = dm.createSchema();
  dm.addTableRows(partial, [{ name: 'a', label: 'A' }, { name: 'b', label: 'B', 'super_class.name': 'unread_parent' }, { name: 'z', label: 'Z' }]);
  dm.addFieldRows(partial, ['a'], [{ name: 'a', element: 'to_b', internal_type: 'reference', reference: 'b' }]);
  const s2 = dm.startPathSearch('a', 'z', { maxDepth: 1 });
  dm.advancePathSearch(s2, partial);
  assert.deepEqual(s2.frontier.map((p) => p.tables.join('>')), ['a>b']);
});

test('walkTo: a name missing from the reference columns is not called "no field" when only references were read', () => {
  const refsOnly = dm.createSchema();
  dm.addTableRows(refsOnly, [{ name: 'incident', label: 'Incident' }, { name: 'sys_user', label: 'User' }]);
  dm.addFieldRows(refsOnly, ['incident'], [{ name: 'incident', element: 'caller_id', internal_type: 'reference', reference: 'sys_user' }]);
  dm.addFieldRows(refsOnly, ['sys_user'], []);
  assert.match(dm.walkTo(refsOnly, 'incident', 'number').error, /no reference field "number"/);
  assert.match(dm.walkTo(SCHEMA, 'incident', 'nope').error, /has no field "nope"/, 'a fully read table still says "no field"');
});

test('loadFields: a dictionary chunk that fills the row cap is read again in halves, so no table is stored with columns missing', async () => {
  // hub points at 30 tables; each has 200 columns, so one 30-table read (6000 rows) would be cut at 5000.
  const targets = Array.from({ length: 30 }, (_, i) => `u_t${String(i).padStart(2, '0')}`);
  const tables = [{ name: 'u_hub', label: 'Hub' }, ...targets.map((t) => ({ name: t, label: t }))];
  const dict = [
    ...targets.map((t) => ({ name: 'u_hub', element: `ref_${t}`, internal_type: 'reference', reference: t, column_label: t })),
    ...targets.flatMap((t) => Array.from({ length: 200 }, (_, j) => ({ name: t, element: `c${String(j).padStart(3, '0')}`, internal_type: 'string', reference: '', column_label: `C${j}` }))),
  ];
  global.__DATAMODEL_FIXTURE__ = true;
  global.document = { documentElement: { hasAttribute() { throw new Error('no bridge'); } }, getElementById: () => null, querySelector: (s) => (s === 'input[name="sysparm_ck"]' ? { value: 't' } : null), scripts: [] };
  const json = (result) => new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
  let dictReads = 0;
  global.fetch = async (url) => {
    const u = new URL(url, 'https://dev1.service-now.com');
    const table = u.pathname.split('/').pop();
    const q = u.searchParams.get('sysparm_query') || '';
    const limit = Number(u.searchParams.get('sysparm_limit') || 50);
    const offset = Number(u.searchParams.get('sysparm_offset') || 0);
    const inList = (field) => (q.match(new RegExp(`(?:^|\\^)${field.replace('.', '\\.')}IN([^^]*)`)) || [])[1]?.split(',') || null;
    if (table === 'sys_db_object') {
      const names = inList('name');
      return json(names ? tables.filter((t) => names.includes(t.name)) : []);
    }
    if (table === 'sys_dictionary') {
      dictReads += 1;
      const names = inList('name');
      const rows = names ? dict.filter((r) => names.includes(r.name)).sort((a, b) => (a.name + a.element < b.name + b.element ? -1 : 1)) : [];
      return json(rows.slice(offset, offset + limit));
    }
    return json([]);
  };
  content.dataModelReset();
  await content.dataModelFieldTree('u_hub', 2);
  const readsForTree = dictReads;
  for (const t of targets) {
    // eslint-disable-next-line no-await-in-loop
    const { fields } = await content.dataModelFields({ table: t });
    assert.equal(fields.length, 200, `${t} has every column`);
  }
  assert.equal(dictReads, readsForTree, 'the columns came from the cache: nothing was stored half read');
  assert.ok(readsForTree < 60, `dictionary reads: ${readsForTree}`);
});

test('dataModelFindPaths says how far the other direction was searched, and whether that search was complete', async () => {
  stubInstance();
  content.dataModelReset();
  const lost = await content.dataModelFindPaths({ from: 'sc_cat_item', to: 'incident', maxDepth: 4 });
  assert.equal(lost.reverse, null);
  assert.equal(lost.reverseDepth, 3);
  assert.equal(typeof lost.reverseIncomplete, 'boolean');
  const found = await content.dataModelFindPaths({ from: 'incident', to: 'sys_user' });
  assert.equal(found.reverseDepth, 0, 'not tried when the forward search found paths');
});

test('the requirements list names the tables and columns the feature reads', () => {
  const { REQUIREMENTS } = require('../src/lib/requirements/datamodel.js');
  assert.ok(REQUIREMENTS.length >= 2);
  REQUIREMENTS.forEach((r) => {
    assert.equal(r.feature, 'Data model map');
    assert.ok(r.table && Array.isArray(r.columns) && r.columns.length, r.table);
  });
  assert.ok(REQUIREMENTS.some((r) => r.table === 'sys_dictionary' && r.columns.includes('reference')));
  assert.ok(REQUIREMENTS.some((r) => r.table === 'sys_db_object' && r.columns.includes('super_class')));
});
