const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/lib/hotspots.js');

const ID = '6816f79cc0a8016401c5a33be04be441';

test('windows become server-side helpers, so no clock or time zone is guessed here', () => {
  assert.equal(H.windowCondition('15m'), 'sys_created_on>=javascript:gs.minutesAgo(15)');
  assert.equal(H.windowCondition('1h'), 'sys_created_on>=javascript:gs.hoursAgo(1)');
  assert.equal(H.windowCondition('24h'), 'sys_created_on>=javascript:gs.hoursAgo(24)');
  assert.equal(H.windowCondition('7d', 'sys_updated_on'), 'sys_updated_on>=javascript:gs.daysAgo(7)');
  assert.equal(H.windowCondition('nonsense'), 'sys_created_on>=javascript:gs.hoursAgo(1)', 'an unknown window falls back to the default');
});

test('log messages that differ only by ids and numbers collapse to one', () => {
  const a = H.normalizeMessage(`Record 123 failed for ${ID} at 2026-10-20 12:30:01`);
  const b = H.normalizeMessage('Record 98765 failed for 11111111111111111111111111111111 at 2026-10-21 01:02:03');
  assert.equal(a, b);
  assert.equal(a, 'Record <n> failed for <id> at <time>');
  assert.equal(H.normalizeMessage('Could not reach 10.20.30.40:8080 for abel.tuter@example.com'), 'Could not reach <ip> for <email>');
  assert.equal(H.normalizeMessage('INC0012345 and CHG0000789 updated'), 'INC<n> and CHG<n> updated');
  assert.equal(H.normalizeMessage('query took 2345ms (3 rows)'), 'query took <n>ms (<n> rows)');
  assert.equal(H.normalizeMessage('step2 of v1 done'), 'step2 of v1 done', 'digits inside names are kept');
  assert.equal(H.normalizeMessage('  lots   of\n space '), 'lots of space');
  assert.equal(H.normalizeMessage('x'.repeat(300)).length, 140, 'long messages are cut');
  assert.equal(H.normalizeMessage(null), '');
});

test('a message group can be turned back into a filter', () => {
  assert.equal(H.messageFilter('Record <n> failed for <id>'), 'messageLIKEfailed for', 'the head is too short, so the longest fixed stretch is used');
  assert.equal(H.messageFilter('Business rule X aborted <n> times'), 'messageSTARTSWITHBusiness rule X aborted');
  assert.equal(H.messageFilter('<n> rows updated in the batch job'), 'messageLIKErows updated in the batch job');
  assert.equal(H.messageFilter('<n> <id>'), '', 'nothing fixed to search for');
  assert.equal(H.messageFilter('Failed: a^b is bad <n>'), 'messageSTARTSWITHFailed: a^^b is bad', 'a caret in the text is escaped');
  assert.equal(H.messageFilter('Cannot read property of null', 'description'), 'descriptionSTARTSWITHCannot read property of null');
});

test('URLs group by pattern: ids and numbers collapse, query strings go, jobs keep their name', () => {
  assert.equal(H.urlPattern(`/api/now/table/incident/${ID}?sysparm_limit=5`), '/api/now/table/incident/:id');
  assert.equal(H.urlPattern('/incident.do?sys_id=' + ID), '/incident.do');
  assert.equal(H.urlPattern('/api/x_app/v1/orders/42/lines'), '/api/x_app/v1/orders/:n/lines');
  assert.equal(H.urlPattern('JOB: Cleanup old sessions'), 'JOB: Cleanup old sessions');
  assert.equal(H.urlPattern(''), '(no url)');
  assert.equal(H.patternPrefix('/api/now/table/incident/:id'), '/api/now/table/incident/');
  assert.equal(H.patternPrefix('/incident_list.do'), '/incident_list.do');
  assert.equal(H.transactionKind('JOB: x'), 'job');
  assert.equal(H.transactionKind('/api/now/table/x'), 'rest');
  assert.equal(H.transactionKind('/xmlhttp.do'), 'ajax');
  assert.equal(H.transactionKind('/incident.do'), 'ui');
});

test('percentiles, summaries and formatting', () => {
  assert.equal(H.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(H.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(H.percentile([7], 95), 7);
  assert.equal(H.percentile([], 50), null);
  assert.equal(H.percentile([NaN, 3], 50), 3);
  const s = H.summarize([100, 200, 300]);
  assert.deepEqual([s.count, s.total, s.avg, s.max], [3, 600, 200, 300]);
  assert.equal(H.summarize([]).avg, null);
  assert.equal(H.formatMs(850), '850 ms');
  assert.equal(H.formatMs(2400), '2.4 s');
  assert.equal(H.formatMs(12000), '12 s');
  assert.equal(H.formatMs(72000), '1 min 12 s');
  assert.equal(H.formatMs(4020000), '1 h 7 min');
  assert.equal(H.formatMs(NaN), '-');
  assert.equal(H.formatCount(950), '950');
  assert.equal(H.formatCount(1250), '1.3k');
  assert.equal(H.formatCount(48000), '48k');
  assert.equal(H.formatPercent(1, 4), '25%');
  assert.equal(H.formatPercent(1, 0), '-');
});

test('column fallbacks: the first column holding a value wins and a missing column is reported, not zeroed', () => {
  assert.equal(H.readNumber({ response_time: '2,345' }, ['response_time']), 2345);
  assert.equal(H.readNumber({ total_wait_time: '12' }, ['response_time', 'total_wait_time']), 12);
  assert.equal(H.readNumber({ response_time: '' }, ['response_time']), null);
  assert.equal(H.readNumber({}, ['response_time']), null);
  assert.equal(H.readText({ user: { value: 'abel' } }, ['user_name', 'user']), 'abel');
  assert.deepEqual(H.readUser({ user_name: '', sys_created_by: 'admin' }), { name: 'admin', field: 'sys_created_by' });
  assert.deepEqual(H.readUser({}), { name: '(unknown)', field: 'sys_created_by' });
  const cols = H.availableColumns([{ response_time: '10' }, { response_time: '20' }]);
  assert.deepEqual(cols, { response: true, sql: false, rules: false });
});

const tx = (url, ms, extra = {}) => ({ url, response_time: String(ms), sys_created_by: 'abel.tuter', ...extra });

test('slow requests group by pattern, biggest total time first, with shares of SQL and rules', () => {
  const rows = [
    tx(`/incident.do?sys_id=${ID}`, 2000, { sql_time: '1000', business_rule_time: '500', sql_count: '40' }),
    tx('/incident.do?sys_id=abc', 4000, { sql_time: '3000', business_rule_time: '500', sql_count: '60' }),
    tx('/api/now/table/task/' + ID, 100),
    tx('/api/now/table/task/abc12345678901234567890123456789', 100),
    tx('/home.do', 9000),
    { url: '/no-time.do' },
  ];
  const groups = H.summarizeTransactions(rows);
  assert.deepEqual(groups.map((g) => g.pattern), ['/home.do', '/incident.do', '/api/now/table/task/:id']);
  const inc = groups.find((g) => g.pattern === '/incident.do');
  assert.equal(inc.count, 2);
  assert.equal(inc.avgMs, 3000);
  assert.equal(inc.maxMs, 4000);
  assert.equal(inc.sqlShare, 4000 / 6000);
  assert.equal(inc.ruleShare, 1000 / 6000);
  assert.equal(inc.sqlCount, 100);
  assert.equal(groups.find((g) => g.pattern === '/home.do').sqlShare, null, 'no SQL column on those rows: unknown, not 0%');
  assert.equal(groups.find((g) => g.pattern === '/no-time.do'), undefined, 'a row with no time is not counted');
});

test('the same requests by user, with what each user mostly runs', () => {
  const users = H.summarizeUsers([
    tx('/a.do', 1000, { sys_created_by: 'amy' }),
    tx('/b.do', 5000, { sys_created_by: 'amy' }),
    tx('/a.do', 2000, { user_name: 'bob', sys_created_by: 'system' }),
  ]);
  assert.deepEqual(users.map((u) => u.user), ['amy', 'bob']);
  assert.equal(users[0].topPattern, '/b.do');
  assert.equal(users[0].totalMs, 6000);
  assert.equal(users[1].field, 'user_name');
});

test('heaviest requests by one timing column, ignoring rows without it', () => {
  const rows = [tx('/a.do', 10, { sql_time: '50', sys_id: '1', sql_count: '3' }), tx('/b.do', 20, { sql_time: '500', sys_id: '2' }), tx('/c.do', 30), tx('/d.do', 40, { sql_time: '0' })];
  const top = H.heaviest(rows, 'sql_time', 5);
  assert.deepEqual(top.map((t) => t.pattern), ['/b.do', '/a.do']);
  assert.equal(top[1].sqlCount, 3);
  assert.deepEqual(H.heaviest(rows, 'business_rule_time'), []);
});

test('scheduled jobs come from JOB transactions; stuck jobs are the claimed ones that are long overdue', () => {
  const jobs = H.summarizeJobs([tx('JOB: Cleanup', 60000), tx('JOB: Cleanup', 120000), tx('JOB: Sync', 1000), tx('/incident.do', 99999)]);
  assert.deepEqual(jobs.map((j) => j.name), ['Cleanup', 'Sync']);
  assert.equal(jobs[0].count, 2);
  const now = Date.UTC(2026, 9, 20, 13, 0, 0);
  const stuck = H.stuckJobs(
    [
      { name: 'Old', claimed_by: 'node1', next_action: '2026-10-20 11:00:00', sys_id: 'a' },
      { name: 'Recent', claimed_by: 'node2', next_action: '2026-10-20 12:55:00' },
      { name: 'Bad date', next_action: 'soon' },
    ],
    now
  );
  assert.deepEqual(stuck.map((j) => [j.name, j.overdueMin]), [['Old', 120]]);
  assert.equal(H.parseUtc('2026-10-20 13:00:00'), now);
  assert.equal(H.parseUtc('nope'), null);
});

test('log rows group by normalised message with the loudest source, level and newest time', () => {
  const rows = [
    { message: `Record 1 failed ${ID}`, source: 'MyBR', level: '2', sys_created_on: '2026-10-20 10:00:00' },
    { message: 'Record 2 failed ' + ID, source: 'MyBR', level: '2', sys_created_on: '2026-10-20 11:00:00' },
    { message: 'Record 3 failed ' + ID, source: 'Other', level: '1', sys_created_on: '2026-10-20 09:00:00' },
    { message: 'Something else', source: 'X', level: '0', sys_created_on: '2026-10-20 08:00:00' },
    { source: 'no message' },
  ];
  const groups = H.groupMessages(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].message, 'Record <n> failed <id>');
  assert.equal(groups[0].count, 3);
  assert.equal(groups[0].source, 'MyBR');
  assert.equal(groups[0].sourceCount, 2);
  assert.equal(groups[0].last, '2026-10-20 11:00:00');
  assert.equal(groups[0].level, 'Error/Warning');
  assert.equal(H.levelName('2'), 'Error');
});

test('Aggregate API answers are read for one group or many, with one field or two', () => {
  const many = H.parseGroupCounts({ result: [{ stats: { count: '5' }, groupby_fields: [{ field: 'source', value: 'A' }] }, { stats: { count: '2' }, groupby_fields: [{ field: 'source', value: 'B' }] }] });
  assert.deepEqual(many, [{ values: { source: 'A' }, count: 5 }, { values: { source: 'B' }, count: 2 }]);
  const one = H.parseGroupCounts({ result: { stats: { count: '9' }, groupby_fields: [{ field: 'name', value: 'x' }] } });
  assert.equal(one[0].count, 9);
  const two = H.parseGroupCounts({ result: [{ stats: { count: '4' }, groupby_fields: [{ field: 'tablename', value: 'incident' }, { field: 'documentkey', value: ID }] }] });
  assert.deepEqual(two[0].values, { tablename: 'incident', documentkey: ID });
  assert.deepEqual(H.parseGroupCounts(null), []);
  assert.deepEqual(H.parseGroupCounts({ result: [{ stats: { count: 'x' }, groupby_fields: [] }] }), [], 'a row with no group is dropped');
  const top = H.topGroups(many, 'source', 1);
  assert.equal(top.total, 7);
  assert.equal(top.rows[0].value, 'A');
  assert.equal(Math.round(top.rows[0].share * 100), 71);
  assert.equal(H.topGroups([{ values: { n: '' }, count: 1 }], 'n').rows[0].value, '(empty)');
  const records = H.topRecords([{ values: { tablename: 'incident', documentkey: 'k1' }, count: 3 }, { values: { tablename: 'task', documentkey: 'k2' }, count: 8 }, { values: { tablename: 'x', documentkey: '' }, count: 99 }], 5);
  assert.deepEqual(records.map((r) => r.sysId), ['k2', 'k1']);
});

test('outbound calls group by endpoint, counting failures', () => {
  assert.equal(H.endpointOf('https://api.example.com/v1/users/42?x=1'), 'api.example.com/v1/users/:n');
  assert.equal(H.endpointOf('https://host.example.com'), 'host.example.com/');
  assert.equal(H.endpointOf(''), '(unknown endpoint)');
  const rows = [
    { url: 'https://a.com/x/1', response_code: '200', response_time: '100' },
    { url: 'https://a.com/x/2', response_code: '503', response_time: '300' },
    { endpoint: 'https://b.com/y', http_status: '200' },
  ];
  const out = H.summarizeOutbound(rows);
  assert.equal(out[0].endpoint, 'a.com/x/:n');
  assert.equal(out[0].count, 2);
  assert.equal(out[0].errors, 1);
  assert.equal(out[0].avgMs, 200);
  assert.equal(out[1].avgMs, null);
});

test('every section has a one-sentence headline that names the top row', () => {
  assert.match(H.headlineFor('slowPages', { rows: [{ pattern: '/incident.do', count: 3, avgMs: 2400, maxMs: 4000 }] }), /\/incident\.do costs the most time: 3 slow requests, 2\.4 s on average/);
  assert.match(H.headlineFor('slowJobs', { rows: [{ name: 'Cleanup', totalMs: 180000, count: 2, maxMs: 120000 }] }), /Cleanup used 3 min over 2 runs/);
  assert.match(H.headlineFor('logSources', { total: 100, rows: [{ value: 'MyBR', count: 60 }] }), /MyBR is the largest: 60 \(60% of 100\)/);
  assert.match(H.headlineFor('outbound', { rows: [{ endpoint: 'a.com/x', count: 1, errors: 1 }] }), /1 call failed/);
  assert.equal(H.headlineFor('slowPages', { rows: [] }), '');
  assert.equal(H.headlineFor('unknown', { rows: [{}] }), '');
});

test('the sections are the ones the panel promises, each in slow or noisy', () => {
  assert.equal(new Set(H.SECTIONS.map((s) => s.id)).size, H.SECTIONS.length);
  H.SECTIONS.forEach((s) => {
    assert.ok(['slow', 'noisy'].includes(s.group), s.id);
    assert.ok(s.title && s.hint, s.id);
  });
  ['slowPages', 'sqlHeavy', 'slowJobs', 'logMessages', 'errors', 'events', 'outbound', 'churn', 'tablesWritten'].forEach((id) => assert.ok(H.SECTIONS.some((s) => s.id === id), id));
});

test('a result copies as a Markdown table and as an AI question that carries it', () => {
  const result = { headline: 'Top.', columns: ['Request', 'Avg'], rows: [{ cells: ['/a|b', '2 s'] }] };
  const md = H.resultToMarkdown('Slowest requests', result, '1 hour');
  assert.match(md, /^\*\*Slowest requests\*\* \(last 1 hour\)/);
  assert.match(md, /\| \/a\\\|b \| 2 s \|/);
  assert.match(H.hotspotPrompt('Slowest requests', result, '1 hour'), /do not invent data/);
});
