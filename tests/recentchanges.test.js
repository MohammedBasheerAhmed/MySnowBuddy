const test = require('node:test');
const assert = require('node:assert/strict');
const {
  windowClause,
  buildChangesQuery,
  shapeChange,
  headline,
  groupChanges,
  facet,
  isNewSince,
  nextMarker,
  relevance,
  ageText,
  changesToMarkdown,
  isSystemUser,
} = require('../src/lib/recentChanges.js');

const SYS = '0123456789abcdef0123456789abcdef';
const SYS2 = 'fedcba9876543210fedcba9876543210';

const raw = (over = {}) => ({
  sys_id: 'u1',
  name: `sys_script_${SYS}`,
  type: 'Business Rule',
  target_name: 'Abort addition of parent',
  action: 'INSERT_OR_UPDATE',
  update_set: { value: 'set1' },
  application: { value: 'app1' },
  'application.name': 'Asset Management',
  sys_updated_by: 'beth.anglin',
  sys_updated_on: '2026-10-20 09:15:00',
  ...over,
});

test('windows become gs helper clauses, so the instance decides what "today" is', () => {
  assert.equal(windowClause('1h').clause, 'sys_updated_on>=javascript:gs.hoursAgo(1)');
  assert.equal(windowClause('today').clause, 'sys_updated_on>=javascript:gs.beginningOfToday()');
  assert.equal(windowClause('7d').clause, 'sys_updated_on>=javascript:gs.daysAgoStart(7)');
  assert.equal(windowClause('custom', 30).clause, 'sys_updated_on>=javascript:gs.daysAgoStart(30)');
  assert.equal(windowClause('custom', 9999).days, 90, 'capped at 90 days');
  assert.equal(windowClause('custom', 'x').days, 7, 'nonsense falls back to a week');
  assert.equal(windowClause('custom', 1).label, 'the last day');
});

test('the query carries the filters and refuses anything that is not a plain value', () => {
  assert.equal(buildChangesQuery({ window: 'today', scope: 'others', userName: 'abel.tuter' }), 'sys_updated_on>=javascript:gs.beginningOfToday()^sys_updated_by!=abel.tuter^ORDERBYDESCsys_updated_on');
  assert.equal(buildChangesQuery({ window: '7d', scope: 'me', userName: 'abel.tuter', application: SYS, type: 'Script Include' }), `sys_updated_on>=javascript:gs.daysAgoStart(7)^sys_updated_by=abel.tuter^application=${SYS}^type=Script Include^ORDERBYDESCsys_updated_on`);
  assert.equal(buildChangesQuery({ application: 'global' }).includes('application=global'), true);
  const hostile = buildChangesQuery({ scope: 'others', userName: 'a^ORactive=true', application: 'x^y', type: 'Business Rule^ORsys_id!=' });
  assert.equal(hostile, 'sys_updated_on>=javascript:gs.beginningOfToday()^ORDERBYDESCsys_updated_on', 'a user, application or type carrying ^ adds no condition');
  assert.equal(buildChangesQuery({ scope: 'others', userName: '' }).includes('sys_updated_by'), false, 'no user known: no user filter');
});

test('a row becomes a plain headline, with the record, application and update set', () => {
  const row = shapeChange(raw(), { set1: 'Fix duplicates' });
  assert.equal(row.table, 'sys_script');
  assert.equal(row.sysId, SYS);
  assert.equal(row.appName, 'Asset Management');
  assert.equal(row.setName, 'Fix duplicates');
  assert.equal(headline(row), 'Business Rule "Abort addition of parent" updated by beth.anglin in update set Fix duplicates');
  assert.equal(headline(shapeChange(raw({ action: 'DELETE', update_set: '' }))), 'Business Rule "Abort addition of parent" deleted by beth.anglin');
  assert.equal(headline(shapeChange(raw({ target_name: '', type: '', sys_updated_by: '', sys_created_by: '' }))), `Record "sys_script_${SYS}" updated by someone in update set `.replace(' in update set ', ''));
  assert.equal(shapeChange(raw({ application: 'global', 'application.name': '' })).appName, 'Global');
});

test('grouping puts the busiest group first and keeps newest-first order inside it', () => {
  const rows = [
    shapeChange(raw({ sys_id: 'a', sys_updated_by: 'beth', 'application.name': 'Alpha' })),
    shapeChange(raw({ sys_id: 'b', sys_updated_by: 'abel', 'application.name': 'Beta' })),
    shapeChange(raw({ sys_id: 'c', sys_updated_by: 'beth', 'application.name': 'Beta' })),
  ];
  const byApp = groupChanges(rows, 'application');
  assert.deepEqual(byApp.map((g) => [g.key, g.count]), [['Beta', 2], ['Alpha', 1]]);
  assert.deepEqual(byApp[0].rows.map((r) => r.id), ['b', 'c']);
  assert.deepEqual(groupChanges(rows, 'person').map((g) => [g.key, g.count]), [['beth', 2], ['abel', 1]]);
  assert.deepEqual(groupChanges(rows, 'type').map((g) => g.key), ['Business Rule']);
  assert.equal(groupChanges(rows, 'none').length, 1);
  assert.equal(groupChanges(rows, 'nonsense')[0].count, 3);
});

test('filter lists count each value once per row', () => {
  const rows = [shapeChange(raw({ sys_id: 'a' })), shapeChange(raw({ sys_id: 'b', type: 'Script Include' })), shapeChange(raw({ sys_id: 'c', application: { value: 'app2' }, 'application.name': 'Zed' }))];
  assert.deepEqual(facet(rows, 'type').map((f) => [f.value, f.count]), [['Business Rule', 2], ['Script Include', 1]]);
  assert.deepEqual(facet(rows, 'application').map((f) => [f.value, f.label, f.count]), [['app1', 'Asset Management', 2], ['app2', 'Zed', 1]]);
  assert.deepEqual(facet(rows, 'person').map((f) => f.value), ['beth.anglin']);
});

test('"since I last looked": nothing is new before a marker exists, the marker only moves forward', () => {
  const rows = [shapeChange(raw({ sys_updated_on: '2026-10-20 09:15:00' })), shapeChange(raw({ sys_updated_on: '2026-10-20 08:00:00' }))];
  assert.equal(isNewSince(rows[0], ''), false);
  assert.equal(isNewSince(rows[0], '2026-10-20 09:00:00'), true);
  assert.equal(isNewSince(rows[1], '2026-10-20 09:00:00'), false);
  assert.equal(isNewSince(rows[0], '2026-10-20 09:15:00'), false, 'seen exactly at the marker is not new');
  assert.equal(nextMarker(rows, ''), '2026-10-20 09:15:00');
  assert.equal(nextMarker(rows, '2026-10-21 00:00:00'), '2026-10-21 00:00:00', 'never goes backwards');
  assert.equal(nextMarker([], 'x'), 'x');
});

test('what touches the record on screen: the record itself, then its table', () => {
  const ctx = { table: 'sys_script', sysId: SYS.toUpperCase() };
  assert.equal(relevance(shapeChange(raw()), ctx), 'record');
  assert.equal(relevance(shapeChange(raw({ name: `sys_script_${SYS2}` })), ctx), '');
  const incident = { table: 'incident', sysId: SYS };
  assert.equal(relevance(shapeChange(raw({ name: 'sys_dictionary_incident_u_foo', target_name: 'u_foo' })), incident), 'table');
  assert.equal(relevance(shapeChange(raw({ name: `sys_security_acl_${SYS2}`, type: 'Access Control', target_name: 'incident.state' })), incident), 'table');
  assert.equal(relevance(shapeChange(raw({ name: `sys_security_acl_${SYS2}`, target_name: 'incident_task.state' })), incident), '', 'incident_task is another table');
  assert.equal(relevance(shapeChange(raw()), {}), '');
});

test('ages read plainly', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  assert.equal(ageText('2026-10-20 09:59:30', now), 'just now');
  assert.equal(ageText('2026-10-20 09:30:00', now), '30 min ago');
  assert.equal(ageText('2026-10-20 07:00:00', now), '3 h ago');
  assert.equal(ageText('2026-10-18 10:00:00', now), '2 d ago');
  assert.equal(ageText('garbage', now), 'garbage');
});

test('the feed exports as Markdown with every character that could break it escaped', () => {
  const rows = [shapeChange(raw({ target_name: 'a|b *bold*' }), { set1: 'S1' })];
  const text = changesToMarkdown(rows, { windowLabel: 'the last hour', host: 'dev.service-now.com' });
  assert.match(text, /^# What changed in the last hour/);
  assert.match(text, /## Asset Management \(1\)/);
  assert.match(text, /a\\\|b \\\*bold\\\*/);
  assert.equal(isSystemUser('System'), true);
  assert.equal(isSystemUser('beth.anglin'), false);
});
