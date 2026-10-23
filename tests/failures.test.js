const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/lib/failures.js');

const NOW = Date.UTC(2026, 9, 20, 15, 0, 0); // 2026-10-20 15:00:00 UTC
const ID = '0123456789abcdef0123456789abcdef';
const ID2 = 'fedcba9876543210fedcba9876543210';
const source = (id) => F.SOURCES.find((s) => s.id === id);
const probe = (sourceId, probeId) => source(sourceId).probes.find((p) => p.id === probeId);

test('the window is a number of minutes and a clause the instance evaluates', () => {
  assert.equal(F.windowMinutes('1h'), 60);
  assert.equal(F.windowMinutes('7d'), 10080);
  assert.equal(F.windowMinutes('nonsense'), 1440, 'an unknown key falls back to 24 hours');
  assert.equal(F.windowClause('24h'), 'sys_created_on>=javascript:gs.minutesAgoStart(1440)');
  assert.equal(F.windowClause('1h', 'sys_updated_on'), 'sys_updated_on>=javascript:gs.minutesAgoStart(60)');
});

test('ServiceNow times are read as UTC and compared with the window', () => {
  assert.equal(F.parseGlideTime('2026-10-20 14:03:11'), Date.UTC(2026, 9, 20, 14, 3, 11));
  assert.ok(Number.isNaN(F.parseGlideTime('yesterday')));
  assert.equal(F.inWindow('2026-10-20 14:30:00', '1h', NOW), true);
  assert.equal(F.inWindow('2026-10-20 13:00:00', '1h', NOW), false);
  assert.equal(F.inWindow('2026-10-14 16:00:00', '7d', NOW), true);
  assert.equal(F.inWindow('2026-10-20 18:00:00', '24h', NOW), false, 'a time in the future is not a recent failure');
  assert.equal(F.inWindow('', '24h', NOW), false);
  assert.equal(F.relativeAge('2026-10-20 14:56:00', NOW), '4 min ago');
  assert.equal(F.relativeAge('2026-10-20 10:00:00', NOW), '5 h ago');
  assert.equal(F.relativeAge('2026-10-17 15:00:00', NOW), '3 d ago');
  assert.equal(F.relativeAge('2026-10-20 15:00:00', NOW), 'just now');
  assert.equal(F.relativeAge('x', NOW), '');
});

test('values are read whether the API sent strings or { value, display_value }', () => {
  assert.equal(F.raw({ value: 'a', display_value: 'A' }), 'a');
  assert.equal(F.disp({ value: 'a', display_value: 'A' }), 'A');
  assert.equal(F.raw('x'), 'x');
  assert.equal(F.raw(undefined), '');
  assert.equal(F.disp({ value: 'only' }), 'only');
});

test('URLs lose credentials, query strings and fragments before they are shown', () => {
  assert.equal(F.safeUrl('https://user:secret@api.example.com/v1/items?token=abc&x=1#frag'), 'https://api.example.com/v1/items');
  assert.equal(F.safeUrl('/api/now/table/incident?sysparm_query=active=true'), '/api/now/table/incident');
  assert.equal(F.safeUrl(''), '');
  assert.match(F.httpHint(401), /credentials/i);
  assert.match(F.httpHint(0), /No answer/i);
  assert.match(F.httpHint(503), /failed/i);
  assert.equal(F.httpHint(200), '');
});

test('a failed email is explained in plain words', () => {
  const failed = F.normaliseEmail({ sys_id: ID, sys_created_on: '2026-10-20 14:00:00', type: 'send-failed', recipients: 'abel@example.com', subject: 'Incident INC0010001 resolved', error_string: '535 Authentication credentials invalid' });
  assert.equal(failed.source, 'email');
  assert.equal(failed.kind, 'send-failed');
  assert.equal(failed.title, 'Email "Incident INC0010001 resolved" failed to send');
  assert.match(failed.hint, /refused the login/);
  assert.deepEqual(failed.target, { table: 'sys_email', sysId: ID });
  assert.equal(failed.severity, 'error');

  const down = F.normaliseEmail({ sys_id: ID, type: 'send-failed', recipients: 'a@b.com', subject: 's', error_string: 'Connection timed out to smtp.example.com' });
  assert.match(down.hint, /could not be reached/);

  const ignored = F.normaliseEmail({ sys_id: ID, type: 'send-ignored', recipients: 'a@b.com', subject: 'Hello' });
  assert.equal(ignored.title, 'Email "Hello" was ignored, not sent');
  assert.equal(ignored.severity, 'warn');
  assert.match(ignored.hint, /switched off|excluded/);

  const nobody = F.normaliseEmail({ sys_id: ID, type: 'send-failed', recipients: '', subject: 'Nobody' });
  assert.match(nobody.hint, /no recipients/i, 'nobody to send to beats any other guess');
  assert.equal(F.normaliseEmail({ type: 'send-failed' }).target, null, 'a row without a sys_id has no record to open');
});

test('a failed or cancelled flow names the flow and the likely reason', () => {
  const row = { sys_id: ID, sys_created_on: { value: '2026-10-20 13:00:00', display_value: '2026-10-20 23:00:00' }, name: { value: 'abc', display_value: 'Onboard new hire' }, state: { value: 'ERROR', display_value: 'Error' }, error_message: 'Value for data pill is null' };
  const item = F.normaliseFlow(row);
  assert.equal(item.title, 'Flow "Onboard new hire" failed');
  assert.equal(item.when, '2026-10-20 13:00:00', 'the stored UTC time, not the display time');
  assert.match(item.hint, /empty/);
  assert.equal(F.normaliseFlow({ sys_id: ID, name: 'X', state: 'cancelled' }).title, 'Flow "X" was cancelled');
  assert.equal(F.normaliseFlow({ sys_id: ID, name: 'X', state: 'cancelled' }).severity, 'warn');
  assert.match(F.normaliseFlow({ sys_id: ID, name: 'X', state: 'error' }).message, /no error message/);
  assert.match(F.normaliseFlow({ sys_id: ID, name: 'X', state: 'error', error_message: 'Insufficient permission to read' }).hint, /may not touch/);
});

test('a flow whose name could not be looked up is named by its record, never by a bare sys_id', () => {
  // Seen on a real instance: sys_flow_context.flow is a plain string holding the flow sys_id and `name` is empty.
  const lost = F.normaliseFlow({
    sys_id: ID,
    state: 'ERROR',
    name: '',
    flow: ID2,
    source_record: { value: ID, display_value: 'Task SLA: Priority 4 resolution (2 day)' },
    error_message: 'Failed to serialize plan data',
  });
  assert.equal(lost.title, 'Flow run for "Task SLA: Priority 4 resolution (2 day)" failed');
  assert.equal(F.normaliseFlow({ sys_id: ID, state: 'cancelled', flow: ID2 }).title, 'Flow run (name not available) was cancelled');
  assert.equal(F.normaliseFlow({ sys_id: ID, state: 'ERROR', name: '', flow: 'Onboard new hire' }).title, 'Flow "Onboard new hire" failed', 'a readable flow value is still a name');
  assert.equal(F.normaliseFlow({ sys_id: ID, state: 'ERROR', name: 'Looked up', flow: ID2 }).title, 'Flow "Looked up" failed', 'a name found by the lookup wins');
});

test('an overdue job says how late it is', () => {
  const trigger = F.normaliseTrigger({ sys_id: ID, name: 'Daily cleanup', state: 'Ready', next_action: '2026-10-20 13:30:00' }, NOW);
  assert.equal(trigger.title, 'Scheduled job "Daily cleanup" is overdue');
  assert.match(trigger.message, /90 min late/);
  assert.equal(trigger.when, '2026-10-20 13:30:00');
  assert.equal(trigger.severity, 'warn');
  const script = F.normaliseScheduledScript({ sys_id: ID, name: 'Sync users', next_action: '2026-10-20 12:00:00', run_start: '2026-10-19 12:00:00' }, NOW);
  assert.match(script.message, /180 min late/);
  assert.match(script.message, /last started 2026-10-19 12:00:00/);
  assert.deepEqual(script.target, { table: 'sysauto_script', sysId: ID });
});

test('MID Server messages in error are explained', () => {
  const item = F.normaliseEcc({ sys_id: ID, sys_created_on: '2026-10-20 14:00:00', topic: 'Discovery', state: 'error', error_string: 'Unknown host cmdb.corp.example', queue: 'output', agent: { value: 'x', display_value: 'mid-01' } });
  assert.equal(item.title, 'MID Server message failed: Discovery');
  assert.match(item.hint, /could not reach/);
  assert.equal(item.meta.agent, 'mid-01');
  assert.match(F.normaliseEcc({ sys_id: ID, state: 'error' }).message, /no error text/);
});

test('an outbound call is a failure only with an error status or an error text', () => {
  assert.equal(F.outboundFailed({ response_code: '200' }), false);
  assert.equal(F.outboundFailed({ response_code: '404' }), true);
  assert.equal(F.outboundFailed({ http_status: '500' }), true);
  assert.equal(F.outboundFailed({ status: '0' }), true, 'no answer at all');
  assert.equal(F.outboundFailed({ error_message: 'SSL handshake failed' }), true);
  assert.equal(F.outboundFailed({ response_code: '200', error_message: 'warning only' }), false, 'a 2xx with a note is not a failure');
  assert.equal(F.outboundFailed({}), false, 'a row with none of the columns is not guessed to be a failure');
  const item = F.normaliseOutbound({ sys_id: ID, sys_created_on: '2026-10-20 14:00:00', url: 'https://u:p@api.partner.com/orders?apikey=SECRET', http_method: 'post', response_code: '401' });
  assert.equal(item.title, 'Call to api.partner.com failed (401)');
  assert.ok(!JSON.stringify(item).includes('SECRET') && !JSON.stringify(item).includes('u:p'), 'no key or password reaches the screen');
  assert.match(item.message, /POST https:\/\/api\.partner\.com\/orders answered 401/);
  assert.match(item.hint, /credentials/i);
  assert.match(F.normaliseOutbound({ sys_id: ID, url: 'https://x.com', error_message: 'connect timed out' }).title, /no response/);
});

test('an inbound API call that returned 5xx is listed with its path only', () => {
  const item = F.normaliseInbound({ sys_id: ID, sys_created_on: '2026-10-20 14:00:00', url: '/api/x_acme/orders/123?token=abc', http_method: 'GET', response_status: '500', sys_created_by: 'svc.integration' });
  assert.equal(item.title, 'Inbound API call returned 500: /api/x_acme/orders/123');
  assert.match(item.message, /GET \/api\/x_acme\/orders\/123 answered 500 for svc\.integration/);
  assert.ok(!item.message.includes('token'));
  const keep = probe('integration', 'inbound').keep;
  assert.equal(keep({ response_status: '502', url: '/api/now/table/x' }), true);
  assert.equal(keep({ response_status: '200', url: '/api/now/table/x' }), false);
  assert.equal(keep({ response_status: '500', url: '/incident.do' }), false, 'a UI page error is not an API failure');
  assert.equal(keep({ response_status: '500', url: 'https://dev1.service-now.com/api/now/x' }), true);
});

test('import rows and runs in error say what stopped them', () => {
  const row = F.normaliseImportRow({ sys_id: ID, sys_created_on: '2026-10-20 14:00:00', sys_import_set: { value: ID2, display_value: 'ISET0010022' }, sys_import_state: 'error', sys_row_error: 'Mandatory field caller_id is empty', sys_class_name: 'u_users_import' });
  assert.equal(row.title, 'Import row failed in ISET0010022');
  assert.match(row.hint, /required field/);
  assert.deepEqual(row.target, { table: 'u_users_import', sysId: ID }, 'the row opens in its own import table');
  assert.equal(F.normaliseImportRow({ sys_id: ID, sys_class_name: 'bad name!' }).target.table, 'sys_import_set_row');
  assert.match(F.normaliseImportRow({ sys_id: ID, sys_row_error: 'Duplicate key value' }).hint, /unique key/);
  assert.match(F.normaliseImportRow({ sys_id: ID, sys_row_error: 'Could not find a match for reference' }).hint, /did not match/);
  const run = F.normaliseImportRun({ sys_id: ID, sys_import_set: 'ISET1', state: 'error', error_message: 'Script exception in onBefore', transform_map: 'Users map' });
  assert.equal(run.title, 'Import run ended in error: ISET1');
  assert.match(run.hint, /script/);
  assert.equal(run.meta.map, 'Users map');
});

test('an event in error leaves its parameters out', () => {
  const item = F.normaliseEvent({ sys_id: ID, sys_created_on: '2026-10-20 14:00:00', name: 'incident.assigned', table: 'incident', state: 'error', parm1: 'abel.tuter@example.com', parm2: 'secret text' });
  assert.equal(item.title, 'Event "incident.assigned" stopped in error');
  assert.equal(item.message, 'Event incident.assigned on incident could not be processed');
  assert.ok(!JSON.stringify(item).includes('abel.tuter') && !JSON.stringify(item).includes('secret'));
});

test('a failed read becomes a note, not an error', () => {
  const session = Object.assign(new Error('Your ServiceNow session has expired.'), { code: 'SESSION_EXPIRED' });
  assert.deepEqual(F.softFail(session, 'sys_email'), { available: false, note: 'Your ServiceNow session has expired.', sessionExpired: true });
  assert.equal(F.softFail(new Error('Table API query on "sys_email" failed (403): User Not Authorized'), 'sys_email').note, 'Your user cannot read sys_email.');
  assert.equal(F.softFail(new Error('Table API query failed (400): Invalid table sys_hub_flow_run'), 'sys_hub_flow_run').note, 'sys_hub_flow_run is not available on this instance.');
  assert.equal(F.softFail(new Error('404 not found'), 'x').available, false);
  assert.match(F.softFail(new Error('socket hang up'), 'ecc_queue').note, /Could not read ecc_queue: socket hang up/);
  assert.equal(F.softFail(undefined, 't').available, false);
});

test('rows the instance returned are filtered again, ordered and flagged when cut off', () => {
  const p = probe('email', 'email');
  const rows = [
    { sys_id: ID, sys_created_on: '2026-10-20 10:00:00', type: 'send-failed', subject: 'old' },
    { sys_id: ID2, sys_created_on: '2026-10-20 14:00:00', type: 'send-ignored', subject: 'new' },
    { sys_id: ID, sys_created_on: '2026-10-20 14:30:00', type: 'sent', subject: 'fine, but the instance ignored our condition' },
    null,
  ];
  const out = F.runProbeRows(p, rows, NOW);
  assert.equal(out.available, true);
  assert.deepEqual(out.items.map((i) => i.title), ['Email "new" was ignored, not sent', 'Email "old" failed to send'], 'newest first, the sent one dropped');
  assert.equal(out.truncated, false);
  assert.equal(F.runProbeRows(p, Array.from({ length: F.MAX_ROWS }, () => ({ sys_id: ID, type: 'send-failed' })), NOW).truncated, true, 'a full page means there may be more');
  assert.equal(F.runProbeRows({ ...p, keep: () => { throw new Error('boom'); } }, [{}], NOW).items.length, 0, 'a broken keep check drops the row, it does not throw');
});

test('a source with one unreadable probe still shows the other, and a fallback is not double counted', () => {
  const flow = source('flow');
  const ok = F.runProbeRows(probe('flow', 'flowContext'), [{ sys_id: ID, name: 'F', state: 'ERROR' }], NOW);
  const merged = F.mergeSource(flow, { flowContext: ok, flowRun: { skipped: true } });
  assert.equal(merged.available, true);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.note, '');

  const dead = F.mergeSource(flow, { flowContext: F.softFail(new Error('404'), 'sys_flow_context'), flowRun: F.softFail(new Error('403 not allowed'), 'sys_hub_flow_run') });
  assert.equal(dead.available, false);
  assert.match(dead.note, /sys_flow_context is not available/);
  assert.match(dead.note, /cannot read sys_hub_flow_run/);

  const expired = F.mergeSource(source('email'), { email: F.softFail(Object.assign(new Error('expired'), { code: 'SESSION_EXPIRED' }), 'sys_email') });
  assert.equal(expired.sessionExpired, true);
  assert.equal(F.mergeSource(source('jobs'), {}).available, false);
  assert.match(F.mergeSource(source('jobs'), {}).sourceNote, /time window does not apply/);
});

test('repeats of one failure become one group with a count, first and last time', () => {
  const mail = (id, when, recipient, subject) => F.normaliseEmail({ sys_id: id, sys_created_on: when, type: 'send-failed', recipients: recipient, subject, error_string: `550 mailbox ${recipient} unavailable` });
  const items = [
    mail('a'.repeat(32), '2026-10-20 10:00:00', 'one@example.com', 'Ticket INC0010001 updated'),
    mail('b'.repeat(32), '2026-10-20 12:00:00', 'two@example.com', 'Ticket INC0010002 updated'),
    mail('c'.repeat(32), '2026-10-20 11:00:00', 'three@example.com', 'Ticket INC0010003 updated'),
    F.normaliseFlow({ sys_id: ID, sys_created_on: '2026-10-20 13:00:00', name: 'F', state: 'error', error_message: 'x' }),
  ];
  const groups = F.groupFailures(items);
  assert.equal(groups.length, 2, 'three emails to different people about different tickets are one problem');
  const email = groups.find((g) => g.source === 'email');
  assert.equal(email.count, 3);
  assert.equal(F.countLabel(email), '3x');
  assert.equal(email.first, '2026-10-20 10:00:00');
  assert.equal(email.last, '2026-10-20 12:00:00');
  assert.equal(email.target.sysId, 'b'.repeat(32), 'Open record goes to the newest one');
  assert.equal(groups[0].source, 'flow', 'newest problem first');
  assert.equal(F.groupFailures(items, { sort: 'count' })[0].source, 'email', 'or the most frequent first');
  assert.equal(F.groupFailures([]).length, 0);
  assert.equal(F.groupFailures(null).length, 0);
});

test('different kinds or different errors are not merged', () => {
  const a = F.normaliseEmail({ sys_id: ID, type: 'send-failed', recipients: 'x@y.com', subject: 'S', error_string: 'Connection refused' });
  const b = F.normaliseEmail({ sys_id: ID2, type: 'send-ignored', recipients: 'x@y.com', subject: 'S' });
  const c = F.normaliseEmail({ sys_id: ID2, type: 'send-failed', recipients: 'x@y.com', subject: 'S', error_string: 'Authentication failed' });
  assert.equal(F.groupFailures([a, b, c]).length, 3);
  const warnThenError = F.groupFailures([{ ...a, severity: 'warn' }, { ...a, severity: 'error', when: '2026-10-21 00:00:00' }]);
  assert.equal(warnThenError[0].severity, 'error', 'a group is as serious as its worst member');
});

test('a different HTTP status is a different problem, a different host number is the same one', () => {
  const call = (id, status) => F.normaliseOutbound({ sys_id: id, sys_created_on: '2026-10-20 14:00:00', url: 'https://api.partner.example/v2/orders', http_method: 'POST', response_code: String(status) });
  const groups = F.groupFailures([call('a'.repeat(32), 401), call('b'.repeat(32), 401), call('c'.repeat(32), 500)]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.count).sort(), [1, 2]);
  const mid = (id, host) => F.normaliseEcc({ sys_id: id, sys_created_on: '2026-10-20 14:00:00', topic: 'Discovery', state: 'error', error_string: `Unknown host ${host}.corp.example` });
  assert.equal(F.groupFailures([mid('a'.repeat(32), 'scan01'), mid('b'.repeat(32), 'scan02'), mid('c'.repeat(32), 'scan17')]).length, 1);
  assert.equal(F.groupFailures([mid('a'.repeat(32), 'scan01'), mid('b'.repeat(32), 'billing')]).length, 2, 'a different host name stays separate');
});

test('the digest ignores the parts that change between repeats', () => {
  assert.equal(F.digest(`Failed for ${ID} at 2026-10-20 14:00:00 for a@b.com attempt 7 INC0010042`), 'failed for <id> at <time> for <email> attempt <n> <number>');
  assert.equal(F.digest(''), '');
});

test('chips count occurrences per source and filter the list', () => {
  const items = [{ source: 'email' }, { source: 'email' }, { source: 'flow' }];
  const counts = F.countsBySource(items);
  assert.equal(counts.email, 2);
  assert.equal(counts.flow, 1);
  assert.equal(counts.import, 0, 'every source has a chip, even with none');
  assert.deepEqual(Object.keys(counts), F.SOURCE_IDS);
  assert.equal(F.filterBySource(items, 'email').length, 2);
  assert.equal(F.filterBySource(items, 'all').length, 3);
  assert.equal(F.filterBySource(items, '').length, 3);
  assert.equal(F.filterBySource(null, 'email').length, 0);
});

test('the question for the AI carries the facts and the report is readable', () => {
  const [group] = F.groupFailures([F.normaliseEmail({ sys_id: ID, sys_created_on: '2026-10-20 14:00:00', type: 'send-failed', recipients: 'a@b.com', subject: 'Hi', error_string: '535 bad credentials' })]);
  const prompt = F.buildFailurePrompt(group, { instance: 'dev1.service-now.com' });
  assert.match(prompt, /Where: Email \(send-failed\) on dev1\.service-now\.com/);
  assert.match(prompt, /Seen: 1 time, first 2026-10-20 14:00:00/);
  assert.match(prompt, /Record: sys_email 0123456789abcdef0123456789abcdef/);
  assert.match(prompt, /535 bad credentials/);
  assert.match(prompt, /First guess from the extension/);
  const report = F.failuresToMarkdown([group], { windowKey: '24h', instance: 'dev1', generatedAt: '2026-10-20 15:00' });
  assert.match(report, /^# What went wrong on dev1/);
  assert.match(report, /Last 24 hours, read 2026-10-20 15:00\. 1 distinct problem\./);
  assert.match(report, /## Email "Hi" failed to send \(1x\)/);
});

test('Open record only ever builds a plain record path', () => {
  assert.equal(F.recordPath({ table: 'sys_email', sysId: ID }), `/sys_email.do?sys_id=${ID}`);
  assert.equal(F.recordPath(null), '');
  assert.equal(F.recordPath({ table: 'x/../y', sysId: ID }), '', 'a table name is a name, not a path');
  assert.equal(F.recordPath({ table: 'sys_email', sysId: 'nope' }), '');
});

test('every source describes real, well-formed probes', () => {
  assert.deepEqual(F.SOURCE_IDS, ['email', 'flow', 'jobs', 'integration', 'import', 'event']);
  const ids = new Set();
  F.SOURCES.forEach((s) => {
    assert.ok(s.label && s.hint, s.id);
    s.probes.forEach((p) => {
      assert.ok(!ids.has(p.id), `duplicate probe id ${p.id}`);
      ids.add(p.id);
      assert.match(p.table, /^[a-z][a-z0-9_]*$/, p.id);
      assert.ok(p.fields.includes('sys_id') && p.fields.every((f) => /^[a-z][a-z0-9_]*$/.test(f)), `${p.id} fields`);
      assert.equal(typeof p.keep, 'function');
      assert.equal(typeof p.normalise, 'function');
      ['1h', '24h', '7d'].forEach((w) => {
        const q = p.query(w);
        assert.ok(/ORDERBY/.test(q), `${p.id} orders its rows`);
        assert.ok(!/\s/.test(q.replace(/javascript:[^^]*/g, '')), `${p.id} query has no stray spaces: ${q}`);
        // Only the fixed helper with a number is ever put into a query: nothing typed by a person.
        (q.match(/javascript:[^^]*/g) || []).forEach((js) => assert.match(js, /^javascript:gs\.minutesAgoStart\(\d+\)$/, p.id));
      });
    });
  });
  F.SOURCES.forEach((s) => s.probes.filter((p) => p.fallbackFor).forEach((p) => assert.ok(s.probes.some((o) => o.id === p.fallbackFor), `${p.id} falls back for a probe that exists`)));
  assert.ok(probe('email', 'email').query('1h').startsWith('sys_created_on>=javascript:gs.minutesAgoStart(60)^'), 'the window comes first so the ORs below only widen the type');
});

// Found live on a PDI (2026-10-23): syslog_transaction keeps the HTTP status in http_response_code (there is no
// response_status), and sys_import_set_run has set / errors / sys_transform_map (no error_message or transform_map).
test('an inbound API failure reads the status from http_response_code', () => {
  const f = require('../src/lib/failures.js').normaliseInbound({ sys_id: 'a'.repeat(32), url: '/api/x_acme/orders', http_response_code: '503', sys_created_by: 'svc' });
  assert.equal(f.meta.status, 503);
  assert.match(f.title, /503/);
});

test('an import run with errors names its set, transform map and error count', () => {
  const f = require('../src/lib/failures.js').normaliseImportRun({ sys_id: 'b'.repeat(32), set: 'ISET0010001', state: 'complete', errors: '4', sys_transform_map: 'Users map' });
  assert.match(f.title, /ISET0010001/);
  assert.match(f.message, /4 rows in error/);
  assert.equal(f.meta.map, 'Users map');
});
