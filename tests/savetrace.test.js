const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseUtc, formatUtc, serverTime, buildWindow, windowCondition, offsetLabel, cell, urlPath, traceSources, classifyFailure, logLevel,
  mapRows, mergeTimeline, groupTimeline, onlyProblems, buildTrace, summarize, traceToText, MAX_WINDOW_SECONDS,
} = require('../src/lib/saveTrace.js');

const REC = '9de5069c0b0f0300b8b9e5cd35673a5b';
const OTHER = '6816f79cc0a8016401c5a33be04be441';
const ARMED = Date.UTC(2026, 9, 20, 15, 30, 0);
const NOW = ARMED + 6000;
const WIN = buildWindow({ armedAt: ARMED, now: NOW });
const at = (secAfterArm) => formatUtc(ARMED + secAfterArm * 1000);
const CTX = { table: 'incident', sysId: REC, userName: 'maria.dev' };
const SRC = (id) => traceSources({ table: 'incident', sysId: REC, userName: 'maria.dev', window: WIN, isTask: true }).find((s) => s.id === id);

test('UTC strings round-trip and the server clock wins over the local one', () => {
  assert.equal(parseUtc('2026-10-20 15:30:00'), ARMED);
  assert.equal(formatUtc(ARMED), '2026-10-20 15:30:00');
  assert.ok(Number.isNaN(parseUtc('')) && Number.isNaN(parseUtc('yesterday')));
  assert.equal(serverTime('Tue, 20 Oct 2026 15:30:05 GMT', 1), Date.UTC(2026, 9, 20, 15, 30, 5));
  assert.equal(serverTime(null, 42), 42, 'no Date header: the local clock stands in');
});

test('the window starts a little before Arm, is written as seconds ago, and is capped', () => {
  assert.equal(WIN.seconds, 8, '6 s + 2 s margin');
  assert.equal(WIN.startUtc, '2026-10-20 15:29:58');
  assert.equal(windowCondition(WIN), 'sys_created_on>=javascript:gs.secondsAgo(8)');
  const long = buildWindow({ armedAt: ARMED, now: ARMED + 3600_000 });
  assert.equal(long.seconds, MAX_WINDOW_SECONDS);
  assert.equal(long.truncated, true);
  assert.throws(() => buildWindow({ armedAt: NOW, now: ARMED }), /valid start/);
  assert.throws(() => buildWindow({ armedAt: NaN, now: ARMED }));
});

test('every source filters to the window; the ones that need the record are skipped without it', () => {
  const all = traceSources({ table: 'incident', sysId: REC, userName: 'maria.dev', window: WIN, isTask: true });
  assert.deepEqual(all.map((s) => s.id), ['audit', 'delete', 'log', 'logOther', 'transaction', 'update', 'event', 'email', 'flow', 'workflow', 'journal', 'sla', 'approval', 'attachment', 'child']);
  all.forEach((s) => assert.match(s.query, /sys_created_on>=javascript:gs\.secondsAgo\(8\)/, s.id));
  assert.equal(SRC('audit').query, `documentkey=${REC}^sys_created_on>=javascript:gs.secondsAgo(8)^ORDERBYsys_created_on`);
  assert.match(SRC('log').query, /sys_created_by=maria\.dev/);
  assert.match(SRC('logOther').query, /level=2\^sys_created_by!=maria\.dev/);
  const fresh = traceSources({ table: 'incident', sysId: '-1', userName: 'maria.dev', window: WIN });
  assert.match(fresh.find((s) => s.id === 'audit').skip, /saved record/);
  assert.equal(fresh.find((s) => s.id === 'log').skip, '');
  assert.equal(fresh.find((s) => s.id === 'event').query.includes('table=incident'), true, 'events fall back to the table');
  assert.equal(fresh.some((s) => s.id === 'child'), false, 'child tasks only for task tables');
});

test('user names and ids are validated before they reach a query', () => {
  const bad = traceSources({ table: 'incident', sysId: `${REC}^active=true`, userName: 'a^ORb=c', window: WIN });
  assert.match(bad.find((s) => s.id === 'log').skip, /not known/);
  assert.match(bad.find((s) => s.id === 'audit').skip, /saved record/);
  const ok = traceSources({ table: 'incident', sysId: REC, userName: 'o.o@x-y', window: WIN });
  assert.match(ok.find((s) => s.id === 'update').query, /sys_created_by=o\.o@x-y/);
});

test('a missing table, a blocked table and a broken query are told apart', () => {
  assert.equal(classifyFailure(new Error('Table API query on "sys_flow_context" failed (400): Invalid table sys_flow_context')).status, 'unavailable');
  assert.equal(classifyFailure(new Error('Table API query on "sys_email" failed (403): User Not Authorized')).status, 'noaccess');
  assert.equal(classifyFailure(new Error('socket hang up')).status, 'error');
  assert.match(classifyFailure('Not available').note, /\S/);
});

test('log levels read from numbers and labels', () => {
  assert.deepEqual(['0', '1', '2', 'Error', 'Warning', 'Information', 'Debug', '', undefined].map(logLevel), ['info', 'warn', 'error', 'error', 'warn', 'info', 'info', 'info', 'info']);
});

test('audit rows become field changes with from and to', () => {
  const { events } = mapRows({ id: 'audit', kind: 'audit' }, [{ sys_created_on: at(1), fieldname: 'state', oldvalue: '1', newvalue: { value: '2', display_value: 'In Progress' }, user: 'maria.dev' }], CTX, WIN);
  assert.equal(events[0].title, 'state changed');
  assert.equal(events[0].detail, '1 → In Progress');
  assert.deepEqual(events[0].link, { table: 'incident', sysId: REC });
});

test('log lines: errors count, other people errors only when they name this record', () => {
  const rows = [
    { sys_created_on: at(1), level: '2', source: 'Business Rule: x', message: 'TypeError: boom' },
    { sys_created_on: at(1), level: '0', source: 'gs', message: 'ran ok' },
  ];
  const mine = mapRows({ id: 'log', kind: 'log' }, rows, CTX, WIN).events;
  assert.deepEqual(mine.map((e) => e.level), ['error', 'info']);
  const others = mapRows({ id: 'logOther', kind: 'log' }, [{ sys_created_on: at(2), level: '2', source: 'Flow', message: `failed for incident ${REC}` }, { sys_created_on: at(2), level: '2', source: 'Flow', message: 'unrelated failure' }], CTX, WIN);
  assert.equal(others.events.length, 1);
  assert.equal(others.events[0].level, 'error');
  assert.equal(others.dropped, 1);
});

test('transactions show duration, SQL and business rule time; slow and failed ones are flagged', () => {
  const rows = [
    { sys_created_on: at(2), url: 'https://dev1.service-now.com/incident.do?sys_id=x', http_method: 'POST', response_time: '512', sql_time: '130', sql_count: '41', business_rule_time: '210', business_rule_count: '6' },
    { sys_created_on: at(3), url: '/api/now/table/incident', response_time: '4200' },
    { sys_created_on: at(4), url: '/x.do', response_time: '20', status: '500' },
  ];
  const e = mapRows({ id: 'transaction', kind: 'transaction' }, rows, CTX, WIN).events;
  assert.equal(e[0].title, 'POST /incident.do');
  assert.equal(e[0].durationMs, 512);
  assert.equal(e[0].detail, 'SQL 41 queries, 130 ms · business rules 6, 210 ms');
  assert.equal(e[0].level, 'info');
  assert.equal(e[1].level, 'warn');
  assert.equal(e[2].level, 'error');
  assert.equal(urlPath('https://a.b/c/d?x=1'), '/c/d');
});

test('update set entries warn when they landed in the Default set', () => {
  const rows = [
    { sys_id: OTHER, sys_created_on: at(1), type: 'Business Rule', target_name: 'Set priority', update_set: { value: 'x', display_value: 'Default [Global]' } },
    { sys_created_on: at(1), type: 'Script Include', target_name: 'Util', update_set: 'STRY0012 work' },
  ];
  const e = mapRows({ id: 'update', kind: 'update' }, rows, CTX, WIN).events;
  assert.equal(e[0].level, 'warn');
  assert.match(e[0].detail, /Default/);
  assert.equal(e[1].level, 'info');
  assert.deepEqual(e[0].link, { table: 'sys_update_xml', sysId: OTHER });
});

test('events, emails and flows for another record are left out; failures are errors', () => {
  const ev = mapRows({ id: 'event', kind: 'event' }, [
    { sys_created_on: at(1), name: 'incident.assigned', state: 'processed', instance: REC },
    { sys_created_on: at(1), name: 'incident.assigned', state: 'error', instance: REC },
    { sys_created_on: at(1), name: 'other', state: 'ready', instance: OTHER },
  ], CTX, WIN);
  assert.deepEqual(ev.events.map((e) => e.level), ['info', 'error']);
  assert.equal(ev.dropped, 1);
  const mail = mapRows({ id: 'email', kind: 'email' }, [
    { sys_created_on: at(2), subject: 'Assigned', state: 'send-ready', recipients: 'a@b.c', instance: REC },
    { sys_created_on: at(2), subject: 'Bad', state: 'send-failed', error_string: 'SMTP 550' },
    { sys_created_on: at(2), subject: 'Not mine', state: 'sent', instance: OTHER },
  ], CTX, WIN);
  assert.deepEqual(mail.events.map((e) => e.level), ['info', 'error']);
  assert.match(mail.events[1].detail, /SMTP 550/);
  const flows = mapRows({ id: 'flow', kind: 'flow', table: 'sys_flow_context' }, [
    { sys_created_on: at(2), name: 'Notify', state: 'COMPLETE', source_record: REC, started: at(2), ended: at(3) },
    { sys_created_on: at(2), name: 'Broken', state: 'ERROR', error_message: 'null pointer', source_record: REC },
  ], CTX, WIN).events;
  assert.equal(flows[0].durationMs, 1000);
  assert.equal(flows[1].level, 'error');
});

test('journal, SLA, approval, child and attachment rows read naturally', () => {
  const j = mapRows({ id: 'journal', kind: 'journal' }, [{ sys_created_on: at(1), element: 'work_notes', value: 'Called the user' }], CTX, WIN).events[0];
  assert.equal(j.title, 'Work note added');
  const s = mapRows({ id: 'sla', kind: 'sla', table: 'task_sla' }, [{ sys_created_on: at(1), sla: 'P1 resolution', stage: 'In progress', has_breached: 'true' }], CTX, WIN).events[0];
  assert.equal(s.level, 'error');
  const a = mapRows({ id: 'approval', kind: 'approval' }, [{ sys_created_on: at(1), approver: 'Abel Tuter', state: 'rejected' }], CTX, WIN).events[0];
  assert.equal(a.level, 'warn');
  const c = mapRows({ id: 'child', kind: 'child' }, [{ sys_id: OTHER, sys_created_on: at(1), number: 'INC0010050', short_description: 'Follow-up', sys_class_name: 'incident' }], CTX, WIN).events[0];
  assert.deepEqual(c.link, { table: 'incident', sysId: OTHER });
  const f = mapRows({ id: 'attachment', kind: 'attachment' }, [{ sys_created_on: at(1), file_name: 'log.txt', size_bytes: '2048', content_type: 'text/plain' }], CTX, WIN).events[0];
  assert.equal(f.detail, 'text/plain · 2 KB');
});

test('rows outside the window are dropped: a dropped query condition returns everything', () => {
  const old = formatUtc(ARMED - 3600_000);
  const r = mapRows({ id: 'log', kind: 'log' }, [{ sys_created_on: old, level: '2', message: 'old news' }, { sys_created_on: at(1), level: '0', message: 'now' }, { sys_created_on: 'nonsense', message: 'x' }], CTX, WIN);
  assert.equal(r.events.length, 1);
  assert.equal(r.dropped, 2);
});

test('the timeline is ordered, a change comes before the log it caused, and bursts are grouped', () => {
  const e = [
    { id: 'c', kind: 'log', t: ARMED + 1000, level: 'info' },
    { id: 'a', kind: 'audit', t: ARMED + 1000, level: 'info' },
    { id: 'd', kind: 'email', t: ARMED + 9000, level: 'error' },
    { id: 'b', kind: 'transaction', t: ARMED + 1400, level: 'warn' },
  ];
  const merged = mergeTimeline(e);
  assert.deepEqual(merged.map((x) => x.id), ['a', 'c', 'b', 'd']);
  const groups = groupTimeline(merged);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].events.map((x) => x.id), ['a', 'c', 'b']);
  assert.equal(groups[1].offsetMs, 8000);
  assert.deepEqual(onlyProblems(merged).map((x) => x.id), ['b', 'd']);
  assert.equal(offsetLabel(0), '+0.00s');
  assert.equal(offsetLabel(12345), '+12.3s');
  assert.equal(cell({ value: 'a', display_value: 'A' }).display, 'A');
});

test('buildTrace puts the sources, the timeline and the headline together, and never hides a failed source', () => {
  const sources = traceSources({ table: 'incident', sysId: REC, userName: 'maria.dev', window: WIN, isTask: false });
  const by = (id) => sources.find((s) => s.id === id);
  const results = [
    { source: by('audit'), status: 'ok', rows: [{ sys_created_on: at(1), fieldname: 'state', oldvalue: '1', newvalue: '2' }] },
    { source: by('log'), status: 'ok', rows: [{ sys_created_on: at(1), level: '2', source: 'BR', message: 'boom' }, { sys_created_on: formatUtc(ARMED - 7200_000), level: '0', message: 'old' }] },
    { source: by('flow'), status: 'unavailable', note: 'Not available on this instance.' },
    { source: by('email'), status: 'noaccess', note: 'Your user cannot read this table.' },
    { source: by('journal'), status: 'ok', rows: [] },
  ];
  const trace = buildTrace({ results, ctx: CTX, window: WIN });
  assert.equal(trace.events.length, 2);
  assert.equal(trace.summary.errors, 1);
  assert.match(trace.summary.headline, /2 things happened/);
  assert.match(trace.summary.headline, /1 error/);
  assert.equal(trace.sources.find((s) => s.id === 'flow').status, 'unavailable');
  assert.equal(trace.sources.find((s) => s.id === 'log').note.includes('1 row'), true);
  assert.equal(trace.sources.find((s) => s.id === 'journal').status, 'empty');
  assert.equal(trace.summary.unavailable, 1);
  assert.equal(trace.summary.blocked, 1);
});

test('the text for a ticket has offsets, flags and what could not be collected', () => {
  const sources = traceSources({ table: 'incident', sysId: REC, userName: 'maria.dev', window: WIN });
  const trace = buildTrace({
    results: [
      { source: sources.find((s) => s.id === 'audit'), status: 'ok', rows: [{ sys_created_on: at(1), fieldname: 'state', oldvalue: '1', newvalue: '2' }] },
      { source: sources.find((s) => s.id === 'log'), status: 'ok', rows: [{ sys_created_on: at(2), level: '2', source: 'BR', message: 'boom' }] },
      { source: sources.find((s) => s.id === 'flow'), status: 'unavailable', note: 'Not available on this instance.' },
    ],
    ctx: CTX,
    window: WIN,
  });
  const text = traceToText({ trace, record: { table: 'incident', sysId: REC }, user: 'maria.dev' });
  assert.match(text, /^Save trace: incident 9de5/);
  assert.match(text, /\+0\.00s\s+Field change\s+state changed - 1 → 2/);
  assert.match(text, /\+1\.00s\s+Log\s+\[ERROR\] BR - boom/);
  assert.match(text, /Not collected:\n- Flows: Not available on this instance\./);
  const only = traceToText({ trace, problemsOnly: true });
  assert.ok(!only.includes('state changed'));
  assert.match(only, /boom/);
  assert.match(traceToText({ trace: { ...trace, events: [], summary: summarize([], [], WIN), sources: [] }, problemsOnly: true }), /no warnings or errors/);
});
