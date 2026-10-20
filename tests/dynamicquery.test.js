const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDynamic, parseDateLiteral, dynamicDate, looksLikeEncodedQuery, splitTableQuery, queryScripts, classifyScript, queryScriptRisk } = require('../src/lib/dynamicQuery.js');

const NOW = new Date(2026, 9, 20, 15, 30, 0); // 2026-10-20, local time
const ME = '6816f79cc0a8016401c5a33be04be441';
const G1 = '287ebd7da9fe198100f92cc8d1d2154e';
const G2 = '1c741bd70b2322007518478d37673ae1';

test('date literals are only read when they sit on the start or end of a day', () => {
  assert.deepEqual(parseDateLiteral('2026-10-13 00:00:00'), { y: 2026, m: 10, d: 13, kind: 'start' });
  assert.deepEqual(parseDateLiteral('2026-10-13'), { y: 2026, m: 10, d: 13, kind: 'start' });
  assert.deepEqual(parseDateLiteral('2026-10-13 23:59:59'), { y: 2026, m: 10, d: 13, kind: 'end' });
  assert.deepEqual(parseDateLiteral("javascript:gs.dateGenerate('2026-10-13','start')"), { y: 2026, m: 10, d: 13, kind: 'start' });
  assert.deepEqual(parseDateLiteral("javascript:gs.dateGenerate('2026-10-13','23:59:59')"), { y: 2026, m: 10, d: 13, kind: 'end' });
  assert.equal(parseDateLiteral('2026-10-13 14:05:00'), null, 'a time of day has no helper');
  assert.equal(parseDateLiteral('2026-02-31'), null, 'an impossible date');
  assert.equal(parseDateLiteral('next tuesday'), null);
});

test('day boundaries become the matching gs helper', () => {
  const at = (literal) => dynamicDate(parseDateLiteral(literal), NOW)?.expr;
  assert.equal(at('2026-10-20 00:00:00'), 'javascript:gs.beginningOfToday()');
  assert.equal(at('2026-10-20 23:59:59'), 'javascript:gs.endOfToday()');
  assert.equal(at('2026-10-19 00:00:00'), 'javascript:gs.beginningOfYesterday()');
  assert.equal(at('2026-10-13 00:00:00'), 'javascript:gs.daysAgoStart(7)');
  assert.equal(at('2026-10-13 23:59:59'), 'javascript:gs.daysAgoEnd(7)');
  assert.equal(at('2026-10-01 00:00:00'), 'javascript:gs.beginningOfThisMonth()', 'October 1st is also the start of the quarter: the smallest period wins');
  assert.equal(at('2026-10-31 23:59:59'), 'javascript:gs.endOfThisMonth()');
  assert.equal(at('2026-09-01 00:00:00'), 'javascript:gs.beginningOfLastMonth()');
  assert.equal(at('2026-09-30 23:59:59'), 'javascript:gs.endOfLastMonth()');
  assert.equal(at('2026-01-01 00:00:00'), 'javascript:gs.beginningOfThisYear()');
  assert.equal(at('2025-12-31 23:59:59'), 'javascript:gs.endOfLastYear()');
  assert.equal(at('2026-07-01 00:00:00'), 'javascript:gs.beginningOfLastQuarter()');
  assert.equal(at('2026-05-01 00:00:00'), 'javascript:gs.monthsAgoStart(5)');
  assert.equal(at('2026-11-01 00:00:00'), 'javascript:gs.beginningOfNextMonth()');
  assert.equal(dynamicDate(parseDateLiteral('2026-10-25 00:00:00'), NOW), null, 'the future has no day helper');
  assert.ok(dynamicDate(parseDateLiteral('2026-10-01'), NOW).alternatives.includes('javascript:gs.beginningOfThisQuarter()'), 'the larger readings are offered too');
});

test('a static filter becomes dynamic, keeping its structure, ORs and ordering', () => {
  const result = makeDynamic(`active=true^opened_at>=2026-10-13 00:00:00^ORsys_created_on<2026-10-20 23:59:59^assigned_to=${ME}^ORDERBYDESCopened_at`, { now: NOW, userId: ME });
  assert.equal(result.query, 'active=true^opened_at>=javascript:gs.daysAgoStart(7)^ORsys_created_on<javascript:gs.endOfToday()^assigned_to=javascript:gs.getUserID()^ORDERBYDESCopened_at');
  assert.equal(result.changes.length, 3);
  assert.equal(result.unchanged, 1, 'active=true is left as it is');
  assert.ok(result.notes.some((n) => /browser's clock/.test(n)));
});

test('BETWEEN converts each end on its own and keeps the other', () => {
  const both = makeDynamic('opened_atBETWEEN2026-10-13 00:00:00@2026-10-19 23:59:59', { now: NOW });
  assert.equal(both.query, 'opened_atBETWEENjavascript:gs.daysAgoStart(7)@javascript:gs.endOfYesterday()');
  const half = makeDynamic('opened_atBETWEEN2026-10-13 00:00:00@2026-10-19 14:00:00', { now: NOW });
  assert.equal(half.query, 'opened_atBETWEENjavascript:gs.daysAgoStart(7)@2026-10-19 14:00:00');
  assert.equal(makeDynamic('opened_atBETWEENa@b@c', { now: NOW }).changes.length, 0);
});

test('the dates the list UI itself writes (dateGenerate) are understood', () => {
  const r = makeDynamic("opened_at>=javascript:gs.dateGenerate('2026-10-13','00:00:00')", { now: NOW });
  assert.equal(r.query, 'opened_at>=javascript:gs.daysAgoStart(7)');
});

test('my sys_id, my user name and my groups become "me"', () => {
  assert.equal(makeDynamic(`opened_by=${ME}`, { userId: ME }).query, 'opened_by=javascript:gs.getUserID()');
  assert.equal(makeDynamic(`opened_by!=${ME.toUpperCase()}`, { userId: ME }).query, 'opened_by!=javascript:gs.getUserID()', 'case does not matter');
  assert.equal(makeDynamic(`opened_by=${G1}`, { userId: ME }).changes.length, 0, 'somebody else stays');
  assert.equal(makeDynamic('sys_created_by=abel.tuter', { userName: 'abel.tuter' }).query, 'sys_created_by=javascript:gs.getUserName()');
  assert.equal(makeDynamic('short_description=abel.tuter', { userName: 'abel.tuter' }).changes.length, 0, 'only the created/updated by fields hold a user name');
  assert.equal(makeDynamic(`assignment_groupIN${G1},${G2}`, { groupIds: [G2, G1] }).query, 'assignment_groupINjavascript:getMyGroups()');
  assert.equal(makeDynamic(`assignment_groupIN${G1}`, { groupIds: [G1, G2] }).changes.length, 0, 'a subset of my groups is not "my groups"');
  assert.equal(makeDynamic(`assignment_groupIN${G1},${G2}`, {}).changes.length, 0, 'without the group list nothing is guessed');
});

test('a value containing an escaped caret survives', () => {
  const r = makeDynamic('short_descriptionLIKEa^^b^opened_at>=2026-10-20 00:00:00', { now: NOW });
  assert.equal(r.query, 'short_descriptionLIKEa^^b^opened_at>=javascript:gs.beginningOfToday()');
});

test('nothing to change leaves the query exactly as it was', () => {
  const q = 'active=true^priority=1^ORDERBYnumber';
  const r = makeDynamic(q, { now: NOW });
  assert.equal(r.query, q);
  assert.equal(r.changes.length, 0);
  assert.equal(makeDynamic('', {}).query, '');
});

test('text typed in the palette counts as an encoded query only when it is one', () => {
  ['active=true', 'active=true^priority=1', 'priority<=2^stateIN1,2,3', 'short_descriptionLIKEvpn', 'opened_at>=javascript:gs.daysAgoStart(7)', '^active=true', 'ORDERBYnumber^active=true', 'assigned_toISEMPTY', 'caller_id.department.name=IT', 'NQactive=false'].forEach((q) => assert.equal(looksLikeEncodedQuery(q), true, q));
  ['', 'incident', 'INC0010001', 'who changed this', 'button', 'login', 'ordinary words with = inside', '/tn incident', '@abel', '6816f79cc0a8016401c5a33be04be441', 'x = y', 'what is active=true\nand more'].forEach((q) => assert.equal(looksLikeEncodedQuery(q), false, q));
});

test('the table comes from the page or from a leading table name', () => {
  assert.deepEqual(splitTableQuery('active=true', 'incident'), { table: 'incident', query: 'active=true' });
  assert.deepEqual(splitTableQuery('active=true', ''), { table: '', query: 'active=true' }, 'no table yet: the caller says so');
  assert.deepEqual(splitTableQuery('problem active=true^priority=1', 'incident'), { table: 'problem', query: 'active=true^priority=1' });
  assert.equal(splitTableQuery('open the incident list', 'incident'), null);
  assert.equal(splitTableQuery('incident', 'incident'), null);
});

test('script parts are found and the unknown ones are flagged', () => {
  assert.deepEqual(queryScripts('a=1^opened_atBETWEENjavascript:gs.daysAgoStart(7)@javascript:gs.endOfToday()^b=javascript:gs.getUserID()'), ['javascript:gs.daysAgoStart(7)', 'javascript:gs.endOfToday()', 'javascript:gs.getUserID()']);
  ['javascript:gs.beginningOfToday()', 'javascript:gs.daysAgoStart(30)', 'javascript:gs.monthsAgoEnd(2)', 'javascript:gs.getUserID()', 'javascript:getMyGroups()', "javascript:gs.dateGenerate('2026-10-13','start')", 'javascript:gs.beginningOfLast7Days()'].forEach((s) => assert.equal(classifyScript(s).known, true, s));
  ['javascript:gs.getProperty("x")', 'javascript:new GlideRecord("sys_user").get(1)', 'javascript:gs.daysAgo(1);gs.log(1)', 'javascript:gs.getUserID().toString()'].forEach((s) => assert.equal(classifyScript(s).known, false, s));
  const risk = queryScriptRisk("a=javascript:gs.getUserID()^b=javascript:gs.getProperty('x')");
  assert.deepEqual(risk.custom, ["javascript:gs.getProperty('x')"]);
  assert.deepEqual(queryScriptRisk('active=true').scripts, []);
});
