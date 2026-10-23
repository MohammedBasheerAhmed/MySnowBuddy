// The compact answers of explain_email, explain_process, map_table, find_dotwalk_path, explain_preview_problems and
// find_artifact (src/lib/agent/insights.js). The inputs are real: reports are built by the same library functions the
// panels use, or by the content modules run against the preview fixtures, so a change in a report's shape fails here.
const test = require('node:test');
const assert = require('node:assert/strict');

const I = require('../src/lib/agent/insights.js');
const N = require('../src/lib/notifyTrace.js');
const P = require('../src/lib/processView.js');
const { TOOL_SCHEMAS, toolTier } = require('../src/lib/agent/toolSchemas.js');

const json = (v) => JSON.stringify(v);

// ---- small helpers --------------------------------------------------------------------------------------------------

test('addresses are masked in every string of a result, and masking twice changes nothing', () => {
  assert.equal(I.maskAddresses('Sent to beth.anglin@acme.example and x@y.io'), 'Sent to b***@acme.example and x***@y.io');
  const deep = I.maskDeep({ a: 'abel.tuter@acme.example', b: ['fred@x.example', { c: 'no address' }], n: 4, u: undefined });
  assert.deepEqual(deep, { a: 'a***@acme.example', b: ['f***@x.example', { c: 'no address' }], n: 4, u: undefined });
  assert.equal(I.maskAddresses(I.maskAddresses('a.b@c.example')), 'a***@c.example');
});

test('names: letters, digits and a few separators pass; query syntax never does', () => {
  for (const ok of ['Incident commented', 'AjaxUtil', 'x_acme_hr.Util', "José O'Brien-Smith", 'abel.tuter@example.com', 'Approval (customer) / PO #7, v2']) {
    assert.equal(I.assertNameTerm(ok, 'name'), ok);
  }
  for (const bad of ['javascript:gs.log(1)', 'a^ORb', 'name=admin', 'x;y', '<script>', '', '   ', 'a'.repeat(81), 'a\u0000b', 'back`tick', 'x|y', 'a\\b', '{x}', '[x]', '"q"']) {
    assert.throws(() => I.assertNameTerm(bad, 'name'), /name/, JSON.stringify(bad));
  }
  assert.equal(I.assertNameTerm('  two   words ', 'name'), 'two words');
});

test('the kind ids in the find_artifact schema are exactly the ids the Go to anything catalogue has', () => {
  const schema = TOOL_SCHEMAS.find((t) => t.name === 'find_artifact');
  assert.deepEqual([...schema.inputSchema.properties.kind.enum].sort(), [...I.ARTIFACT_KIND_IDS].sort());
  assert.equal(I.resolveKind('business rule').id, 'br');
  assert.equal(I.resolveKind('Script Includes').id, 'si');
  assert.throws(() => I.resolveKind('banana'), /kind must be one of br, si/);
});

test('every new tool is read-only (observe) and has a schema with a description', () => {
  for (const name of ['explain_email', 'explain_process', 'map_table', 'find_dotwalk_path', 'explain_preview_problems', 'find_artifact']) {
    assert.equal(toolTier(name), 'observe', name);
    const schema = TOOL_SCHEMAS.find((t) => t.name === name);
    assert.ok(schema && schema.description.length > 60 && schema.inputSchema.type === 'object', name);
  }
  assert.deepEqual(TOOL_SCHEMAS.find((t) => t.name === 'find_dotwalk_path').inputSchema.required, ['to']);
  assert.deepEqual(TOOL_SCHEMAS.find((t) => t.name === 'find_artifact').inputSchema.required, ['term']);
});

// ---- explain_email: reports built with the Email tracer's own functions ---------------------------------------------

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
const id = (n) => n.toString(16).padStart(32, '0');
const INC = id(0x9de5);
const ABEL = id(0xa1);
const BETH = id(0xa2);
const FRED = id(0xa3);
const record = { table: 'incident', sysId: INC, chain: ['incident', 'task'], createdOn: ago(300), updatedOn: ago(20), modCount: 4, values: { priority: '1' }, display: {} };

const note = (extra = {}) =>
  N.normalizeNotification({
    sys_id: id(0xc1), name: 'Incident commented', collection: 'incident', active: 'true', generation_type: 'event', event_name: 'incident.commented', condition: '',
    recipient_fields: 'caller_id', send_self: 'false', subject: 'Incident ${number} was commented on', sys_created_on: ago(60 * 24 * 90), ...extra,
  });
const user = (key, extra = {}) => N.normalizeUser({ sys_id: key, name: 'Someone', user_name: 'someone', email: 'someone@acme.example', active: 'true', notification: '2', ...extra }, { notification: 'Enable' });
const directory = () =>
  N.buildDirectory({
    users: [
      user(ABEL, { name: 'Abel Tuter', user_name: 'abel.tuter', email: 'abel.tuter@acme.example' }),
      user(BETH, { name: 'Beth Anglin', user_name: 'beth.anglin', email: 'beth.anglin@acme.example' }),
      user(FRED, { name: 'Fred Luddy', user_name: 'fred.luddy', active: 'false' }),
    ],
    groups: [],
    members: [],
    devices: [],
  });
const MET = { status: 'met', reason: 'priority is 1' };
const candidate = (n, { events = [], emails = [], fieldValues = { caller_id: { value: ABEL, display: 'Abel Tuter' } }, creator = null, switches } = {}) => {
  const recipients = N.expandRecipients({ notification: n, directory: directory(), fieldValues, creator, parms: {} });
  const trace = N.traceNotification({ notification: n, record, condition: MET, events, emails, recipients, switches, now: NOW });
  return { notification: { ...n, href: N.recordPath('sysevent_email_action', n.sysId), triggerText: N.triggerText(n), conditionLines: [], inherited: n.table !== record.table }, condition: MET, recipients, trace };
};
const OK_SECTIONS = { notifications: { ok: true }, events: { ok: true }, emails: { ok: true }, recipients: { ok: true }, switches: { ok: true } };
const recordReport = (candidates, extra = {}) => {
  const sorted = N.sortCandidates(candidates);
  return {
    mode: 'record',
    generatedAt: NOW,
    subject: { table: 'incident', sysId: INC, label: 'INC0010042', chain: ['incident', 'task'], href: N.recordPath('incident', INC) },
    candidates: sorted,
    selectedId: sorted[0]?.notification.sysId || '',
    focusMissing: '',
    focusElsewhere: [],
    events: [],
    emails: [],
    unmatchedEmails: [],
    switches: N.readSwitches([], {}),
    sections: OK_SECTIONS,
    notes: [],
    ...extra,
  };
};

test('explain_email: the first broken link, its advice, the five steps and who is left out - with no address in the result', () => {
  // The only recipient (the caller) is also the person who fired the event, and "Send to event creator" is off.
  const fired = N.normalizeEvent({ sys_id: id(0xe1), name: 'incident.commented', state: 'processed', table: 'incident', instance: INC, sys_created_on: ago(10), processed: ago(9), user_name: 'abel.tuter', user_id: ABEL });
  const stuck = candidate(note(), { events: [fired], creator: { userIds: [ABEL], userNames: ['abel.tuter'], source: 'event' } });
  const out = I.shapeEmailReport(recordReport([stuck]));
  assert.equal(out.mode, 'record');
  assert.equal(out.record.label, 'INC0010042');
  assert.equal(out.verdict.status, 'blocked');
  assert.match(out.verdict.summary, /Email created/);
  assert.match(out.verdict.summary + (out.verdict.advice || ''), /creator/i);
  assert.equal(out.notification.name, 'Incident commented');
  assert.equal(out.notification.sends, 'when the event incident.commented is queued');
  assert.deepEqual(out.steps.map((s) => s.step), ['Matched', 'Event fired', 'Event processed', 'Email created', 'Email sent']);
  assert.equal(out.steps.find((s) => s.step === 'Email created').status, 'fail');
  assert.equal(out.steps.find((s) => s.step === 'Email sent').status, 'skip');
  assert.equal(out.recipients.wouldReceive, 0);
  assert.equal(out.recipients.leftOut[0].name, 'Abel Tuter');
  assert.match(out.recipients.leftOut[0].why, /Send to event creator/);
  assert.equal(out.events[0].name, 'incident.commented');
  assert.ok(!/@/.test(json(out).replace(/\w\*\*\*@/g, '')), 'no unmasked address anywhere in the result');
});

test('explain_email: addresses from a recipient field and from the mail settings are masked, secret-looking mail is not quoted', () => {
  const n = note({ recipient_fields: 'u_vendor_email' });
  const onlyAddress = candidate(n, { fieldValues: { u_vendor_email: { value: 'vendor.contact@partner.example', display: '' } } });
  const reset = N.normalizeEmail({ sys_id: id(0xf1), type: 'sent', state: 'sent', subject: 'Password reset for abel.tuter', recipients: 'abel.tuter@acme.example', sys_created_on: ago(8), instance: INC, target_table: 'incident', notification: n.sysId });
  const sentCandidate = candidate(n, { fieldValues: { u_vendor_email: { value: 'vendor.contact@partner.example', display: '' } }, emails: [reset], events: [N.normalizeEvent({ sys_id: id(0xe2), name: 'incident.commented', state: 'processed', table: 'incident', instance: INC, sys_created_on: ago(12), processed: ago(11) })] });
  const switches = N.readSwitches([{ name: 'glide.email.test.user', value: 'qa-inbox@acme.example' }], {});
  const out = I.shapeEmailReport(recordReport([sentCandidate, onlyAddress], { switches }));
  const text = json(out);
  assert.ok(!text.includes('vendor.contact@') && !text.includes('qa-inbox@') && !text.includes('abel.tuter@'), 'local parts of addresses are gone');
  assert.ok(text.includes('qa-***@') || text.includes('q***@partner') || text.includes('q***@acme.example'), 'the domain stays');
  assert.ok(out.instanceMailSettings.some((s) => /redirected/.test(s)));
  assert.ok(!text.includes('Password reset'), 'a subject that looks like a password mail is not repeated');
  assert.match(json(out.emails), /hidden/);
});

test('explain_email: other notifications are capped and counted; a requested name that is not on the table says so', () => {
  const many = Array.from({ length: 12 }, (_, i) => candidate(note({ sys_id: id(0x100 + i), name: `Notification ${i}`, event_name: `incident.event${i}` })));
  const out = I.shapeEmailReport(recordReport(many, { focusMissing: 'Nonexistent', focusElsewhere: [{ sysId: id(0x900), name: 'Nonexistent elsewhere', table: 'change_request', href: '/x' }] }));
  assert.equal(out.notificationsOnTable, 12);
  assert.equal(out.otherNotifications.length, 6);
  assert.equal(out.moreNotifications, 5);
  assert.equal(out.requestedNotification.foundOnThisTable, false);
  assert.equal(out.requestedNotification.similarElsewhere[0].table, 'change_request');
});

test('explain_email: no notification, or notifications that could not be read, is said plainly', () => {
  const none = I.shapeEmailReport(recordReport([]));
  assert.equal(none.verdict.status, 'no-notification');
  assert.match(none.verdict.summary, /No notification is defined for incident or its parent tables \(task\)/);
  const unread = I.shapeEmailReport(recordReport([], { sections: { ...OK_SECTIONS, notifications: { ok: false, error: 'Your user is not allowed to do this (403).' } } }));
  assert.match(unread.verdict.summary, /could not be read/);
  assert.match(json(unread.couldNotRead), /notifications: Your user is not allowed/);
  assert.doesNotMatch(unread.verdict.summary, /No notification is defined/, 'never "nothing found" when the truth is "could not read"');
});

test('explain_email: the email mode explains each address; the notification mode lists what it matches and sends', () => {
  const n = note();
  const c = candidate(n);
  const sent = N.normalizeEmail({ sys_id: id(0xf2), type: 'sent', state: 'sent', subject: 'Incident INC0010042 was commented on', recipients: 'abel.tuter@acme.example,stranger@elsewhere.example', copied: 'beth.anglin@acme.example', sys_created_on: ago(8), instance: INC, target_table: 'incident', notification: n.sysId });
  const classified = { ...sent, ...N.classifyEmail(sent, NOW), href: N.recordPath('sys_email', sent.sysId) };
  const emailMode = I.shapeEmailReport({
    ...recordReport([c]),
    mode: 'email',
    email: classified,
    recipientsExplained: [
      { address: 'abel.tuter@acme.example', kind: 'To', name: 'Abel Tuter', sources: ['Field caller_id'], explained: true, activeUser: true, note: '' },
      { address: 'stranger@elsewhere.example', kind: 'To', name: '', sources: [], explained: false, activeUser: null, note: 'No user has this address. It is a plain address.' },
    ],
    trigger: { kind: 'event', text: 'Triggered by the event incident.commented, queued 2026-10-23 11:50 UTC.' },
    targetError: '',
  });
  assert.equal(emailMode.mode, 'email');
  assert.equal(emailMode.email.state, 'Sent');
  assert.equal(emailMode.email.toCount, 2);
  assert.equal(emailMode.email.ccCount, 1);
  assert.deepEqual(emailMode.addresses.map((a) => a.onTheNotificationsList), [true, false]);
  assert.equal(emailMode.addresses[0].address, 'a***@acme.example');
  assert.match(emailMode.trigger, /incident\.commented/);
  assert.ok(!json(emailMode).includes('stranger@') && !json(emailMode).includes('abel.tuter@'));

  // An email that is not tied to a record cannot be traced; that is said, not "no notification is defined".
  const loose = I.shapeEmailReport({
    mode: 'email',
    generatedAt: NOW,
    subject: null,
    candidates: [],
    events: [],
    emails: [],
    unmatchedEmails: [],
    switches: N.readSwitches([], {}),
    sections: {},
    notes: [],
    email: classified,
    recipientsExplained: [{ address: 'abel.tuter@acme.example', kind: 'To', name: '', sources: [], explained: false, activeUser: null, note: 'No user has this address. It is a plain address.' }],
    trigger: null,
    targetError: 'This email is not tied to a record (no target table and instance), so what triggered it cannot be traced.',
  });
  assert.equal(loose.verdict.status, 'cannot-trace');
  assert.match(loose.verdict.summary, /could not be traced: This email is not tied to a record/);
  assert.equal(loose.record, undefined);

  const decorated = { ...n, href: N.recordPath('sysevent_email_action', n.sysId), triggerText: N.triggerText(n), conditionLines: [] };
  const byNotification = I.shapeEmailReport({
    mode: 'notification',
    notification: decorated,
    others: [],
    recipients: N.expandRecipients({ notification: n, directory: directory(), noRecord: true }),
    events: [],
    emails: [],
    matching: { count: 7, sample: [{ sysId: INC, label: 'INC0010042', href: '/x' }] },
    switches: N.readSwitches([{ name: 'glide.email.smtp.active', value: 'false' }], {}),
    sections: OK_SECTIONS,
    notes: [],
  });
  assert.equal(byNotification.mode, 'notification');
  assert.match(byNotification.summary, /Incident commented is active and sends when the event/);
  assert.deepEqual(byNotification.matching, { recordsMatchingNow: 7, examples: ['INC0010042'] });
  assert.ok(byNotification.instanceMailSettings.some((s) => /switched off/.test(s)));
});

// ---- the instance reads, end to end against the preview fixtures -----------------------------------------------------

const fixtures = () => ({
  notify: require('../preview/fixtures/notify.js'),
  process: require('../preview/fixtures/process.js'),
  dataModel: require('../preview/fixtures/datamodel.js'),
  preview: require('../preview/fixtures/previewProblems.js'),
  goto: require('../preview/fixtures/goto.js'),
});

/** Answers fetch from the fixtures, runs `fn`, and puts everything back. */
async function onFakeInstance(fn, { record = true } = {}) {
  const f = fixtures();
  const saved = { fetch: global.fetch, document: global.document, location: global.location, dm: global.__DATAMODEL_FIXTURE__, pp: global.__PREVIEWFIX_FIXTURE__ };
  global.__DATAMODEL_FIXTURE__ = true;
  global.__PREVIEWFIX_FIXTURE__ = true;
  global.document = {
    documentElement: { hasAttribute() { throw new Error('no bridge in tests'); } },
    getElementById: () => null,
    querySelector: (selector) => (selector.includes('sysparm_ck') ? { value: 'test-token' } : null),
    scripts: [],
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  };
  global.location = { search: '', host: 'dev12345.service-now.com', hostname: 'dev12345.service-now.com' };
  global.fetch = async (path) => {
    const url = new URL(path, 'https://dev12345.service-now.com');
    for (const fixture of [f.goto, f.notify, f.process, f.preview, f.dataModel]) {
      const answered = fixture.route('GET', url, null);
      if (answered) return answered;
    }
    const cell = (value) => ({ value, display_value: value });
    const last = decodeURIComponent(url.pathname.split('/').pop());
    if (last === 'incident') return incidentAnswer(url);
    if (last === 'sys_properties') return propertiesAnswer(url);
    if (last === 'sys_script_include' && /scriptLIKE/.test(url.searchParams.get('sysparm_query') || '')) return usageAnswer(url);
    const result = record ? [{ number: cell('INC0010042'), short_description: cell('Laptop will not boot'), active: cell('true') }] : [];
    return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    return await fn();
  } finally {
    global.fetch = saved.fetch;
    global.document = saved.document;
    global.location = saved.location;
    global.__DATAMODEL_FIXTURE__ = saved.dm;
    global.__PREVIEWFIX_FIXTURE__ = saved.pp;
  }
}

const PROC_ID = '9de5069c0b0f0300b8b9e5cd35673a5b';

// The fake incident INC0010042 as the record reads and condition checks of the Email tracer see it (the notify fixture
// leaves the record itself to the base fake instance): priority 1, caller Abel Tuter, nobody assigned.
const fnv = (text, seed) => {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};
const fixtureId = (key) => [0x811c9dc5, 0x2f1a3b4c, 0x9e3779b9, 0x7f4a7c15].map((seed) => fnv(key, seed)).join('');
const stamp = (minutes) => new Date(Date.now() - minutes * 60000).toISOString().replace('T', ' ').slice(0, 19);
// sys_properties: an ordinary property, a secret by name, a password type, a value that holds a credential, and a "key" that is not one.
const PROPERTIES = [
  { sys_id: id(0x801), name: 'glide.ui.session_timeout', value: '30', type: 'integer', description: 'Minutes of inactivity before logout', sys_scope: 'global', 'sys_scope.scope': 'global', sys_updated_on: '2026-10-01 09:00:00', sys_updated_by: 'admin' },
  { sys_id: id(0x802), name: 'x_acme.vendor.api_key', value: 'sk_live_abcdef1234567890', type: 'string', description: 'Key for the vendor API', sys_scope: 'x_acme', 'sys_scope.scope': 'x_acme' },
  { sys_id: id(0x803), name: 'x_acme.vendor.login', value: 'hunter2hunter2', type: 'password2', description: 'Vendor login', sys_scope: 'x_acme', 'sys_scope.scope': 'x_acme' },
  { sys_id: id(0x804), name: 'x_acme.vendor.notes', value: 'token=abcd1234efgh5678 for the vendor', type: 'string', description: 'Notes about the vendor', sys_scope: 'x_acme', 'sys_scope.scope': 'x_acme' },
  { sys_id: id(0x805), name: 'glide.ui.keyboard_shortcuts', value: 'true', type: 'boolean', description: 'Keyboard shortcuts on forms', sys_scope: 'global', 'sys_scope.scope': 'global' },
];
function propertiesAnswer(url) {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const query = url.searchParams.get('sysparm_query') || '';
  const groups = [];
  query.split('^').forEach((token) => {
    if (!token || token.startsWith('ORDERBY')) return;
    const or = token.startsWith('OR');
    const m = /^(?:OR)?(name|description|value|sys_id)(LIKE|=)(.*)$/.exec(token);
    if (!m) return;
    const test = (row) => (m[2] === '=' ? String(row[m[1]]) === m[3] : String(row[m[1]] ?? '').toLowerCase().includes(m[3].toLowerCase()));
    if (or && groups.length) groups[groups.length - 1].push(test);
    else groups.push([test]);
  });
  const rows = PROPERTIES.filter((row) => groups.every((g) => g.some((t) => t(row))));
  if (url.pathname.includes('/stats/')) return json({ result: { stats: { count: String(rows.length) } } });
  const asked = (url.searchParams.get('sysparm_fields') || '').split(',').filter(Boolean);
  const display = url.searchParams.get('sysparm_display_value') === 'all';
  const shape = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !asked.length || asked.includes(k)).map(([k, v]) => [k, display ? { value: v, display_value: v } : v]));
  return json({ result: rows.slice(0, Number(url.searchParams.get('sysparm_limit') || 50)).map(shape) });
}
function usageAnswer(url) {
  const term = /scriptLIKE([^^]+)/.exec(url.searchParams.get('sysparm_query') || '')?.[1] || '';
  const source = ["var key = gs.getProperty('x_acme.vendor.api_key', 'fallbackSecret123');", "gs.info('using ' + key.length);"].join('\n');
  const rows = term === 'x_acme.vendor.api_key' ? [{ sys_id: id(0x901), name: 'VendorClient', api_name: 'x_acme.VendorClient', active: 'true', script: source }] : [];
  return new Response(JSON.stringify({ result: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function incidentAnswer(url) {
  const query = url.searchParams.get('sysparm_query') || '';
  const row = { sys_id: PROC_ID, number: 'INC0010042', short_description: 'Laptop will not boot', active: 'true', priority: '1', state: '2', caller_id: fixtureId('sys_user:abel.tuter'), assigned_to: '', sys_created_on: stamp(300), sys_updated_on: stamp(20), sys_updated_by: 'abel.tuter', sys_mod_count: '4' };
  const matches = !/assigned_toISNOTEMPTY/.test(query);
  const asked = (url.searchParams.get('sysparm_fields') || '').split(',').filter(Boolean);
  const display = url.searchParams.get('sysparm_display_value') === 'all';
  const picked = Object.fromEntries(Object.entries(row).filter(([k]) => !asked.length || asked.includes(k)));
  const result = matches ? [display ? Object.fromEntries(Object.entries(picked).map(([k, v]) => [k, { value: v, display_value: k === 'caller_id' ? 'Abel Tuter' : v }])) : picked] : [];
  return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('explain_process: the stuck incident - what it waits on first, attention items first, links, capped sections', async () => {
  const { processLoad } = require('../src/content/processView.js');
  const report = await onFakeInstance(() => processLoad({ table: 'incident', sysId: PROC_ID }));
  const out = I.shapeProcessReport(report);
  assert.equal(out.level, 'blocked');
  assert.match(out.headline, /^Waiting on: the flow "Notify assignment group", which failed 2 days ago$/);
  assert.equal(out.waitingOn[0].kind, 'Failed flow');
  assert.match(out.waitingOn[0].link, /^\/sys_flow_context\.do\?sys_id=[0-9a-f]{32}$/);
  assert.deepEqual(out.sections.map((s) => s.id), ['flows', 'approvals', 'slas', 'tasks', 'workflow', 'events']);
  const flows = out.sections.find((s) => s.id === 'flows');
  assert.equal(flows.count, 4);
  assert.equal(flows.items[0].state, 'Failed', 'the failed flow comes first');
  assert.equal(flows.items[0].needsAttention, true);
  assert.match(flows.items[0].error, /Look Up Manager/);
  assert.ok(json(out).length < 8000, `compact (${json(out).length} characters)`);
  assert.equal(out.cutShort, undefined, 'a normal record is not cut short');
  assert.ok(!('lines' in flows.items[0]) && !json(out).includes('"rows"'), 'log lines and raw rows are not copied');

  // Capped: more rows than fit are counted, not listed; attention items stay on top.
  const big = JSON.parse(json(report));
  const section = big.sections.find((s) => s.id === 'tasks');
  section.rows = Array.from({ length: 9 }, (_, i) => ({ ...section.rows[0], title: `TASK${i}`, attention: i === 8 }));
  section.count = 9;
  const capped = I.shapeProcessReport(big).sections.find((s) => s.id === 'tasks');
  assert.ok(capped.items.length >= 1 && capped.items.length <= 4, 'at most four items in one section');
  assert.equal(capped.more, 9 - capped.items.length);
  assert.equal(capped.items[0].title, 'TASK8');
  const all = I.shapeProcessReport(big).sections.reduce((n, s) => n + (s.items?.length || 0), 0);
  assert.ok(all <= 12, `a dozen items over all sections at most (${all})`);
});

test('explain_process: secrets in an error or a comment are redacted; sources that could not be read are named', async () => {
  const { processLoad } = require('../src/content/processView.js');
  const report = JSON.parse(json(await onFakeInstance(() => processLoad({ table: 'incident', sysId: PROC_ID }))));
  report.sections.find((s) => s.id === 'flows').rows[0].error = 'Login failed with password=hunter2hunter2 for the service account';
  report.sections.find((s) => s.id === 'approvals').rows[1].comment = 'use api_key=sk_live_abcdef1234567890 for the call';
  report.summary.unreadable = [{ section: 'events', label: 'Queued events', text: 'Your user cannot read sysevent.' }];
  const out = I.shapeProcessReport(report);
  assert.ok(!json(out).includes('hunter2hunter2') && !json(out).includes('abcdef1234567890'));
  assert.match(json(out), /REDACTED/);
  assert.deepEqual(out.couldNotRead, ['Queued events: Your user cannot read sysevent.']);
});

test('explain_process: a table with no SLAs says so instead of listing nothing', async () => {
  const { processLoad } = require('../src/content/processView.js');
  const report = await onFakeInstance(() => processLoad({ table: 'sys_user', sysId: PROC_ID }));
  const out = I.shapeProcessReport(report);
  const slas = out.sections.find((s) => s.id === 'slas');
  assert.equal(slas.status, 'na');
  assert.match(slas.note, /Not applicable/);
  assert.equal(slas.items, undefined);
});

// ---- map_table and find_dotwalk_path --------------------------------------------------------------------------------

test('map_table: parents, references grouped by target, who points here - system tables left out unless asked', async () => {
  const dm = require('../src/content/dataModel.js');
  const model = await onFakeInstance(async () => {
    dm.dataModelReset();
    return dm.dataModelLoad({ table: 'incident' });
  });
  const out = I.shapeMapReport(model);
  assert.equal(out.table, 'incident');
  assert.deepEqual(out.extends, ['task']);
  const users = out.pointsAt.find((g) => g.table === 'sys_user');
  assert.ok(users.fields.includes('caller_id') && users.fields.some((f) => f.startsWith('assigned_to (from task)')));
  assert.ok(users.fields.some((f) => /^watch_list \(list\)/.test(f)));
  assert.ok(out.pointsAt.some((g) => g.table === '(any table, document id)'));
  assert.ok(out.pointedAtBy.some((g) => g.table === 'problem'));
  assert.ok(out.pointedAtBy.every((g) => !/^sys_/.test(g.table)), 'system tables are not listed by default');
  assert.ok(out.counts.fieldsPointingHere > 0 && out.counts.tablesPointedAt === out.pointsAt.length);
  assert.ok(json(out).length < 5000, `compact (${json(out).length} characters)`);
  assert.ok(!('labels' in out) && !('incoming' in out), 'no raw model fields');
});

test('map_table: a heavily used table is capped and counted, and system tables come back with showSystem', () => {
  const incoming = [
    ...Array.from({ length: 40 }, (_, i) => ({ table: `u_table_${String(i).padStart(2, '0')}`, name: 'owner', label: 'Owner', kind: 'reference', target: 'sys_user', viaParent: false })),
    { table: 'sys_audit_delete', name: 'user', label: 'User', kind: 'reference', target: 'sys_user', viaParent: false },
  ];
  const model = { table: 'sys_user', label: 'User', chain: ['sys_user'], labels: {}, children: [], descendantCount: 0, outgoing: [], incoming, linkTables: null, notes: [] };
  const plain = I.shapeMapReport(model);
  // sys_user is itself a system table, so its system referrers are shown without being asked.
  assert.equal(plain.pointedAtBy.length, 25);
  assert.equal(plain.morePointedAtByTables, 16);
  assert.equal(plain.linkTables, 'not looked for: many tables point here');
  const incident = I.shapeMapReport({ ...model, table: 'cmn_department', chain: ['cmn_department'] });
  assert.equal(incident.pointedAtBy.length, 25);
  assert.equal(incident.morePointedAtByTables, 15, 'for an ordinary table the sys_ referrer is left out');
  assert.equal(incident.systemTableFieldsLeftOut, 1);
  const withSystem = I.shapeMapReport({ ...model, table: 'cmn_department', chain: ['cmn_department'] }, { showSystem: true });
  assert.equal(withSystem.morePointedAtByTables, 16);
  assert.equal(withSystem.systemTableFieldsLeftOut, undefined);
});

test('find_dotwalk_path: the shortest routes with their dot-walk strings; no path, and a table that extends the target, are said', async () => {
  const dm = require('../src/content/dataModel.js');
  const { found, none, inherits, same } = await onFakeInstance(async () => {
    dm.dataModelReset();
    return {
      found: await dm.dataModelFindPaths({ from: 'incident', to: 'cmn_department' }),
      none: await dm.dataModelFindPaths({ from: 'sc_cat_item', to: 'incident', maxDepth: 3 }),
      inherits: await dm.dataModelFindPaths({ from: 'incident', to: 'task' }),
      same: await dm.dataModelFindPaths({ from: 'incident', to: 'incident' }),
    };
  });
  const out = I.shapePathReport(found);
  assert.equal(out.result, 'paths');
  assert.equal(out.shortestSteps, 2);
  assert.equal(out.routes[0].via, 'incident > sys_user > cmn_department');
  assert.ok(out.routes[0].dotWalk.includes('caller_id.department'));
  assert.match(out.summary, /shortest 2 steps/);
  assert.match(out.usage, /Add the column/);
  const nothing = I.shapePathReport(none);
  assert.equal(nothing.result, 'none');
  assert.match(nothing.summary, /^No dot-walk path of up to 3 steps from sc_cat_item to incident/);
  assert.equal(nothing.routes, undefined);
  assert.equal(I.shapePathReport(inherits).result, 'inherits');
  assert.equal(I.shapePathReport(same).result, 'same-table');
});

test('find_dotwalk_path: routes and variants are capped', () => {
  const variants = (n) => Array.from({ length: n }, (_, i) => ({ dotWalk: `field${i}.name`, viaChild: false, length: 2, tables: [] }));
  const routes = Array.from({ length: 9 }, (_, i) => ({ key: `r${i}`, tables: ['a', `b${i}`, 'c'], length: 2, variants: variants(6) }));
  const out = I.shapePathReport({ from: 'a', to: 'c', maxDepth: 4, paths: routes.flatMap((r) => r.variants), routes, list: [], generic: [], reverse: null });
  assert.equal(out.routes.length, 6);
  assert.equal(out.moreRoutes, 3);
  assert.equal(out.routes[0].dotWalk.length, 4);
  assert.equal(out.routes[0].moreDotWalks, 2);
});

// ---- explain_preview_problems ---------------------------------------------------------------------------------------

test('explain_preview_problems: the verdict, each open problem with its next step, the provider set and a commit order', async () => {
  const pp = require('../src/content/previewProblems.js');
  const { sets, analysis } = await onFakeInstance(async () => {
    const list = await pp.previewProblemSets({ search: 'Payroll release' });
    return { sets: list.sets, analysis: await pp.previewProblemLoad({ setId: list.sets[0].sysId }) };
  });
  assert.equal(sets.length, 1);
  const out = I.shapePreviewAnalysis(analysis);
  assert.equal(out.updateSet.name, 'Payroll release 4 (STRY0012480)');
  assert.equal(out.verdict.level, 'blocked');
  assert.equal(out.verdict.headline, 'Blocked by 8 problems');
  assert.equal(out.verdict.canSkipSafely, 1);
  assert.equal(out.counts.open, 8);
  assert.equal(out.counts.alreadyDealtWith, 2);
  assert.equal(out.openProblems.length, 8);
  const first = out.openProblems.find((p) => p.target === 'Notify payroll approvers');
  assert.match(first.nextStep, /^Commit "Payroll groups and roles/);
  assert.match(first.provider, /Created in "Payroll groups and roles/);
  assert.match(first.link, /^\/sys_update_preview_problem\.do\?sys_id=/);
  assert.ok(first.meaning, 'the first problem of a kind says what the kind means');
  const refs = out.openProblems.filter((p) => p.problem === 'Missing reference');
  assert.equal(refs.length, 3);
  assert.deepEqual(refs.map((p) => Boolean(p.meaning)), [true, false, false], 'the meaning is not repeated for the same kind');
  assert.ok(out.openProblems.find((p) => p.problem === 'Newer local version').collision.length >= 2);
  assert.deepEqual(out.commitOrder.slice(0, 2), ['Payroll data model (STRY0012465)', 'Payroll groups and roles (STRY0012471)']);
  assert.ok(json(out).length < 8000, `compact (${json(out).length} characters)`);
});

test('explain_preview_problems: open problems are capped, descriptions are redacted, an unreadable set says so', async () => {
  const pp = require('../src/content/previewProblems.js');
  const analysis = JSON.parse(json(await onFakeInstance(async () => pp.previewProblemLoad({ setId: (await pp.previewProblemSets({ search: 'Payroll release' })).sets[0].sysId }))));
  const proto = analysis.problems.find((p) => p.status === 'unresolved' || p.status === 'unknown');
  analysis.problems = Array.from({ length: 14 }, (_, i) => ({ ...proto, id: `p${i}`, description: i === 0 ? 'Login failed: api_key=sk_live_abcdef1234567890' : proto.description }));
  const out = I.shapePreviewAnalysis(analysis);
  assert.equal(out.openProblems.length, 8);
  assert.equal(out.moreOpenProblems, 6);
  assert.ok(!json(out).includes('abcdef1234567890'));
  // A key that starts near the cut-off point: redacted first, then clipped, so not even its first characters get through.
  const KEY = 'sk-ant-api03-Zq8vT1xY2wR4pL6mN0bC';
  analysis.problems[0] = { ...analysis.problems[0], description: `${'Could not reach the integration endpoint while committing. '.repeat(3).slice(0, 165)} key ${KEY}` };
  const nearCut = I.shapePreviewAnalysis(analysis);
  assert.ok(!json(nearCut).includes('sk-ant'), json(nearCut.openProblems[0].instanceSays));
  const unreadable = I.shapePreviewAnalysis({ set: { sysId: INC, name: 'X', stateLabel: 'Loaded' }, problems: [], verdict: { level: 'unreadable', headline: 'Could not read the preview problems', detail: 'sys_update_preview_problem could not be read: 403' }, limits: ['The dictionary could not be read.'], counts: { total: 0 } });
  assert.equal(unreadable.verdict.level, 'unreadable');
  assert.deepEqual(unreadable.notChecked, ['The dictionary could not be read.']);
});

test('explain_preview_problems: without a name the retrieved sets are listed with their problem counts', async () => {
  const pp = require('../src/content/previewProblems.js');
  const { sets, note: setNote } = await onFakeInstance(() => pp.previewProblemSets({}));
  const out = I.shapeRetrievedSets(sets, setNote);
  assert.equal(out.retrievedUpdateSets[0].name, 'Payroll release 4 (STRY0012480)');
  assert.equal(out.retrievedUpdateSets[0].problemsRecorded, 10);
  assert.match(out.note, /Pass updateSet/);
  const many = I.shapeRetrievedSets(Array.from({ length: 20 }, (_, i) => ({ name: `S${i}`, sysId: id(i + 1), stateLabel: 'Loaded', problemCount: 0 })));
  assert.equal(many.retrievedUpdateSets.length, 15);
  assert.equal(many.more, 5);
});

// ---- find_artifact --------------------------------------------------------------------------------------------------

const cell = (value, display) => ({ value, display_value: display ?? value });
let nextRow = 0;
/** A Table API row as the Go to anything search asks for it (display_value=all). */
const artifactRow = (table, name, extra = {}) => ({
  sys_id: cell(id(0x7000 + (nextRow += 1))),
  sys_class_name: cell(table),
  sys_updated_on: cell('2026-10-20 10:00:00'),
  sys_updated_by: cell('admin'),
  sys_created_by: cell('maria.dev'),
  name: cell(name),
  active: cell('true'),
  sys_scope: cell('global', 'Global'),
  'sys_scope.scope': cell('global'),
  ...extra,
});

test('find_artifact: refuses anything that could become query syntax, and says what to use instead for ids and numbers', async () => {
  const query = async () => assert.fail('nothing may be sent');
  for (const term of ['javascript:gs.log(1)', 'a^ORb', 'name=admin', 'x;y', '']) {
    await assert.rejects(I.searchArtifacts({ query, term }), /term/, JSON.stringify(term));
  }
  await assert.rejects(I.searchArtifacts({ query, term: 'ab' }), /at least 3 characters/);
  await assert.rejects(I.searchArtifacts({ query, term: 'a', kind: 'br' }), /at least 3 characters \(2 when kind is given\)/);
  await assert.rejects(I.searchArtifacts({ query, term: 'INC0010042' }), /record number/);
  await assert.rejects(I.searchArtifacts({ query, term: id(5) }), /sys_id/);
  await assert.rejects(I.searchArtifacts({ query, term: 'incident', kind: 'banana' }), /kind must be one of/);
  await assert.rejects(I.searchArtifacts({ query, term: 'incident', kind: 'prop', tier: 'user' }), /need a role/);
});

test('find_artifact: ranked rows with kind, name, table, sys_id, scope, active and a link; capped, with a count of the rest', async () => {
  const asked = [];
  const query = async (table, q, fields, options) => {
    asked.push({ table, q, options });
    if (table !== 'sys_script') return [];
    return Array.from({ length: 40 }, (_, i) => artifactRow('sys_script', `Close incident ${String(i).padStart(2, '0')}`, { sys_id: cell(id(0x1000 + i)), collection: cell('incident'), when: cell('before'), action_update: cell('true'), active: cell(i === 3 ? 'false' : 'true') }));
  };
  const out = await I.searchArtifacts({ query, term: 'close incident', kind: 'business rule', limit: 5 });
  assert.equal(out.kind, 'Business Rule');
  assert.equal(out.results.length, 5);
  assert.equal(out.moreMatches, 35);
  const first = out.results[0];
  assert.deepEqual(Object.keys(first).sort(), ['active', 'detail', 'kind', 'kindId', 'link', 'name', 'scope', 'sysId', 'table'].sort());
  assert.equal(first.kindId, 'br');
  assert.equal(first.table, 'sys_script');
  assert.match(first.sysId, /^[0-9a-f]{32}$/);
  assert.equal(first.link, `/sys_script.do?sys_id=${first.sysId}`);
  assert.match(first.detail, /incident/);
  assert.match(out.note, /most recently changed|narrow/);
  assert.deepEqual(asked.map((a) => a.table), ['sys_script', 'sys_script'], 'one kind: the search and the starts-with follow-up, nothing else');
  assert.ok(asked.every((a) => a.options.limit <= 30 && a.options.displayValue === true));
  assert.ok(!asked.some((a) => /javascript/i.test(a.q)));
  const withInactive = await I.searchArtifacts({ query, term: 'close incident 03', kind: 'br', limit: 25 });
  assert.equal(withInactive.results.find((r) => r.name === 'Close incident 03').active, false, 'inactive rows are listed and marked');
});

test('find_artifact: a table that cannot be read is named, never presented as "no match"; an expired session is an error', async () => {
  const denied = Object.assign(new Error('Your user is not allowed to do this (403).'), {});
  const query = async (table) => {
    if (table === 'sys_script') throw denied;
    if (table === 'sys_script_include') return [artifactRow('sys_script_include', 'IncidentUtil', { api_name: cell('global.IncidentUtil'), client_callable: cell('false') })];
    return [];
  };
  const out = await I.searchArtifacts({ query, term: 'incident' });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].kind, 'Script Include');
  assert.ok(out.couldNotRead.includes('Business Rule'));
  assert.match(out.note, /Not readable with your roles: .*Business Rule/);
  const empty = await I.searchArtifacts({ query: async (table) => { if (table === 'sys_script_include') throw denied; return []; }, term: 'zzzzqq', kind: 'si' });
  assert.equal(empty.results.length, 0);
  assert.deepEqual(empty.couldNotRead, ['Script Include']);
  assert.match(empty.note, /Nothing could be searched|Not readable/);
  assert.doesNotMatch(empty.note, /No match/, 'a table that was not read did not "match nothing"');
  const expired = async () => {
    throw Object.assign(new Error('Your ServiceNow session has expired. Log in again, then retry.'), { code: 'SESSION_EXPIRED' });
  };
  await assert.rejects(I.searchArtifacts({ query: expired, term: 'incident' }), /session has expired/);
});

test('find_artifact: e-mail addresses in a user row are masked; two searches at once do not cancel each other', async () => {
  const query = async (table) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (table === 'sys_user') return [artifactRow('sys_user', 'Abel Tuter', { user_name: cell('abel.tuter'), email: cell('abel.tuter@acme.example'), title: cell('Developer') })];
    return [];
  };
  const [a, b] = await Promise.all([I.searchArtifacts({ query, term: 'abel', kind: 'u' }), I.searchArtifacts({ query, term: 'tuter', kind: 'u' })]);
  assert.equal(a.results.length, 1);
  assert.equal(b.results.length, 1);
  assert.ok(!json(a).includes('abel.tuter@acme'), 'the address is masked');
  assert.match(a.results[0].detail, /a\*\*\*@acme\.example/);
});

test('find_artifact: kinds whose table may not be read (denied-tables list) are never queried, and the answer says so', async () => {
  const asked = [];
  const query = async (table) => {
    asked.push(table);
    if (table === 'sys_user') return [artifactRow('sys_user', 'Abel Tuter', { user_name: cell('abel.tuter') })];
    if (table === 'sys_user_group') return [artifactRow('sys_user_group', 'Abel group')];
    return [];
  };
  const out = await I.searchArtifacts({ query, term: 'abel', exclude: ['si', 'prop'] });
  assert.ok(asked.includes('sys_script'), 'the other kinds are searched');
  assert.ok(!asked.includes('sys_script_include') && !asked.includes('sys_properties'), `asked: ${asked.join(', ')}`);
  assert.match(out.note, /Not searched \(denied-tables list or credentials\): Script Include, System Property\./);
  asked.length = 0;
  const users = await I.searchArtifacts({ query, term: 'abel', kind: 'u', exclude: ['prop'] });
  assert.equal(users.results[0].table, 'sys_user', 'a kind that is not excluded is searched as before');
  asked.length = 0;
  await assert.rejects(I.searchArtifacts({ query, term: 'abel', kind: 'u', exclude: ['u'] }), /Users are not searched: sys_user is on the denied-tables list/);
  assert.equal(asked.filter((t) => t === 'sys_user').length, 0);
  // Every kind excluded: an error that names the reason, not "you lack a role".
  await assert.rejects(I.searchArtifacts({ query, term: 'abel', exclude: I.ARTIFACT_KIND_IDS }), /denied-tables list or holds credentials, so nothing was searched/);
  // Nothing excluded: the same search as before (no note about it).
  const plain = await I.searchArtifacts({ query, term: 'abel' });
  assert.doesNotMatch(plain.note || '', /Not searched/);
});

test('find_artifact: against the preview fixture - a script include is found through its capitals, and the search covers more kinds when little is found', async () => {
  const { queryTable } = require('../src/content/tableApi.js');
  const out = await onFakeInstance(() => I.searchArtifacts({ query: queryTable, term: 'AjaxUtil' }));
  assert.equal(out.results[0].name, 'AjaxUtil');
  assert.equal(out.results[0].kind, 'Script Include');
  assert.equal(out.results[0].scope, 'x_acme_hr');
  assert.ok(out.searchedKinds.includes('Business Rule'));
  const rare = await onFakeInstance(() => I.searchArtifacts({ query: queryTable, term: 'closed' }));
  assert.ok(rare.searchedKinds.length > 8, 'the next kinds are tried when the likely ones find almost nothing');
});

// ---- size: even a crowded record fits the agent loop's 14,000-character limit for one tool result ---------------------

const LONG = (n, word = 'word ') => word.repeat(Math.ceil(n / word.length)).slice(0, n);
const SIZE_LIMIT = 10000;
const measure = (label, value) => {
  const size = json(value).length;
  if (process.env.SHOW_SIZES) console.log(`size ${label}: ${size}`);
  return size;
};

test('size: explain_email with a crowded record stays small', () => {
  const people = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, sysId: id(0x500 + i), name: `Person Number ${i} ${LONG(30)}`, email: `p${i}@acme.example`, status: i % 2 ? 'blocked' : 'receives', sources: ['Listed in Users'], reasons: i % 2 ? [{ code: 'inactive', text: LONG(300) }] : [] }));
  const events = Array.from({ length: 10 }, (_, i) => ({ sysId: id(0x600 + i), name: `incident.event${i}`, label: 'Processed', createdOn: ago(i + 1), userName: 'abel.tuter', href: `/sysevent.do?sys_id=${id(0x600 + i)}` }));
  const emails = Array.from({ length: 10 }, (_, i) => ({ sysId: id(0x700 + i), label: 'Failed', subject: LONG(400), createdOn: ago(i + 1), error: LONG(500), href: `/sys_email.do?sys_id=${id(0x700 + i)}` }));
  const many = Array.from({ length: 14 }, (_, i) => candidate(note({ sys_id: id(0x100 + i), name: `Notification ${i} ${LONG(60)}`, event_name: `incident.event${i}` })));
  const report = JSON.parse(json(recordReport(many, { notes: Array.from({ length: 12 }, () => LONG(400)), emails: [], unmatchedEmails: emails })));
  const chosen = report.candidates[0];
  chosen.recipients = { people, counts: { total: 40, receive: 20, blocked: 20 }, issues: Array.from({ length: 10 }, () => ({ level: 'warn', text: LONG(400) })), sources: Array.from({ length: 12 }, () => ({ label: LONG(40), detail: LONG(200) })) };
  chosen.trace.events = events;
  chosen.trace.emails = emails;
  chosen.trace.stages.forEach((s) => {
    s.headline = LONG(600);
    s.advice = LONG(600);
    s.status = 'fail';
  });
  chosen.trace.verdict = { status: 'blocked', code: 'x', short: 'x', headline: LONG(900), advice: LONG(900) };
  report.switches = { findings: Array.from({ length: 4 }, () => ({ text: LONG(500) })) };
  report.sections = { notifications: { ok: false, error: LONG(500) }, events: { ok: false, error: LONG(500) }, emails: { ok: false, error: LONG(500) } };
  const size = measure('explain_email', I.shapeEmailReport(report));
  assert.ok(size < SIZE_LIMIT, `explain_email worst case is ${size} characters`);
});

test('size: explain_process with every section full stays small', async () => {
  const { processLoad } = require('../src/content/processView.js');
  const report = JSON.parse(json(await onFakeInstance(() => processLoad({ table: 'incident', sysId: PROC_ID }))));
  const longRow = (r, i) => ({ ...r, title: LONG(300), headline: LONG(400), error: LONG(600), note: LONG(400), comment: LONG(400), facts: [LONG(200), LONG(200), LONG(200), LONG(200)], attention: i % 2 === 0 });
  report.sections.forEach((s) => {
    if (s.status === 'na') return;
    const proto = s.rows[0] || { title: 'x', badge: { text: 'Open', tone: 'warn' }, facts: [], href: '/x' };
    s.rows = Array.from({ length: 12 }, (_, i) => longRow(proto, i));
    s.count = 12;
  });
  report.summary.blockers = Array.from({ length: 9 }, () => ({ text: LONG(500), detail: LONG(600), severity: 'error', tag: 'Failed flow', target: { table: 'sys_flow_context', sysId: id(7) } }));
  report.summary.running = Array.from({ length: 6 }, () => ({ text: LONG(400) }));
  report.summary.unreadable = Array.from({ length: 9 }, () => ({ label: LONG(40), text: LONG(400) }));
  const shaped = I.shapeProcessReport(report);
  const size = measure('explain_process', shaped);
  assert.ok(size < SIZE_LIMIT, `explain_process worst case is ${size} characters`);
  assert.match(shaped.cutShort, /cut shorter/, 'a crowded record says its lists were cut shorter');
  assert.ok(shaped.sections.filter((s) => s.status !== 'na').every((s) => s.count === 12 && s.more > 0), 'and every section still says how many it has');
});

test('size: map_table, find_dotwalk_path and find_artifact worst cases stay small', async () => {
  const incoming = Array.from({ length: 120 }, (_, i) => ({ table: `u_${LONG(30, 'a')}_${String(i).padStart(3, '0')}`, name: LONG(30, 'f'), label: 'F', kind: i % 3 ? 'reference' : 'list', target: 'sys_user', viaParent: i % 2 === 0 }));
  const outgoing = Array.from({ length: 120 }, (_, i) => ({ name: `${LONG(28, 'g')}${i}`, kind: 'reference', target: `t_${LONG(25, 'b')}_${i % 40}`, definedOn: 'task', inherited: true }));
  const children = Array.from({ length: 60 }, (_, i) => ({ name: `child_${LONG(25, 'c')}_${i}`, label: 'C' }));
  const linkTables = Array.from({ length: 30 }, (_, i) => ({ table: `m2m_${i}`, others: [{ field: 'a', target: 'x' }, { field: 'b', target: 'y' }, { field: 'c', target: 'z' }, { field: 'd', target: 'w' }] }));
  const map = measure('map_table', I.shapeMapReport({ table: 'sys_user', label: 'User', chain: ['sys_user', 'a', 'b'], labels: {}, children, childCount: 60, descendantCount: 900, descendantsMore: true, outgoing, incoming, linkTables, notes: Array.from({ length: 9 }, () => LONG(400)) }, { showSystem: true }));
  assert.ok(map < SIZE_LIMIT, `map_table worst case is ${map} characters`);

  const variants = (n) => Array.from({ length: n }, (_, i) => ({ dotWalk: `${LONG(30, 'f')}${i}.${LONG(30, 'g')}.${LONG(30, 'h')}`, viaChild: true, length: 3, tables: [] }));
  const routes = Array.from({ length: 30 }, (_, i) => ({ key: `r${i}`, tables: [LONG(30, 'a'), LONG(30, 'b'), LONG(30, 'c'), `d${i}`], length: 3, variants: variants(20) }));
  const path = measure('find_dotwalk_path', I.shapePathReport({ from: 'a', to: 'b', maxDepth: 4, paths: routes.flatMap((r) => r.variants), routes, list: variants(9), generic: [], reverse: null, unexpanded: Array.from({ length: 20 }, (_, i) => `t${i}`), notes: [LONG(500), LONG(500), LONG(500), LONG(500)] }));
  assert.ok(path < SIZE_LIMIT, `find_dotwalk_path worst case is ${path} characters`);

  const query = async (table) => (table === 'sys_script' ? Array.from({ length: 30 }, (_, i) => artifactRow('sys_script', LONG(500, 'n'), { sys_id: cell(id(0x2000 + i)), collection: cell(LONG(200, 'c')), when: cell(LONG(100, 'w')) })) : []);
  const found = measure('find_artifact', await I.searchArtifacts({ query, term: 'nnnn', kind: 'br', limit: 25 }));
  assert.ok(found < SIZE_LIMIT, `find_artifact worst case is ${found} characters`);
});

test('size: explain_preview_problems with many long problems stays small', async () => {
  const pp = require('../src/content/previewProblems.js');
  const analysis = JSON.parse(json(await onFakeInstance(async () => pp.previewProblemLoad({ setId: (await pp.previewProblemSets({ search: 'Payroll release' })).sets[0].sysId }))));
  const proto = analysis.problems.find((p) => p.kind === 'collision') || analysis.problems[0];
  analysis.problems = Array.from({ length: 30 }, (_, i) => ({
    ...proto,
    id: `p${i}`,
    kind: `kind${i}`,
    status: 'unresolved',
    description: LONG(600),
    update: { ...proto.update, target: LONG(300) },
    providerNote: LONG(600),
    next: LONG(600),
    explain: { ...proto.explain, meaning: LONG(600), label: LONG(80) },
    collision: { lines: [LONG(400), LONG(400), LONG(400), LONG(400)] },
  }));
  analysis.limits = Array.from({ length: 12 }, () => LONG(400));
  analysis.order = { chain: Array.from({ length: 12 }, (_, i) => ({ name: LONG(200), setId: id(i + 1), focus: i === 3 })), cycles: [[LONG(100), LONG(100)]] };
  const size = measure('explain_preview_problems', I.shapePreviewAnalysis(analysis));
  assert.ok(size < SIZE_LIMIT, `explain_preview_problems worst case is ${size} characters`);
});

// ---- the six tools end to end: createControlTools with the real wiring (controlSession) against the preview fixtures --------

function realTools() {
  const { createControlTools } = require('../src/content/controlTools.js');
  const { createControlDeps } = require('../src/content/controlSession.js');
  const { queryTable } = require('../src/content/tableApi.js');
  const control = createControlDeps();
  control.session = { ...control.session, readSessionInfo: async () => ({ admin: true, roles: ['admin'] }) };
  control.insights = { ...control.insights, pageTable: () => 'incident' };
  const status = { table: 'incident', sysId: PROC_ID, isNewRecord: false, dirty: false, changedFields: [] };
  return createControlTools({
    control,
    callPage: async (action) => (action === 'getFormStatus' ? status : null),
    queryTable,
    fetchRecord: async () => null,
    recordUrl: (table, sysId) => `/${table}.do?sys_id=${sysId}`,
    getInstanceInfo: () => ({ host: 'dev12345.service-now.com' }),
  }).tools;
}

test('end to end: the six tools through the real wiring - open record by default, compact answers, no address leaks', async () => {
  const tools = realTools();
  const got = await onFakeInstance(async () => ({
    one: await tools.explain_email({ notification: 'Incident commented' }),
    all: await tools.explain_email({}),
    process: await tools.explain_process({}),
    map: await tools.map_table({ table: 'incident' }),
    path: await tools.find_dotwalk_path({ to: 'cmn_department' }),
    preview: await tools.explain_preview_problems({ updateSet: 'Payroll release 4' }),
    listed: await tools.explain_preview_problems({}),
    found: await tools.find_artifact({ term: 'AjaxUtil', kind: 'si' }),
  }));
  if (process.env.SHOW_E2E) console.log(JSON.stringify(got.one, null, 1));
  // The Email tracer on the open incident: the chosen notification, five steps, who is left out.
  assert.equal(got.one.mode, 'record');
  assert.equal(got.one.record.label, 'INC0010042');
  assert.equal(got.one.notification.name, 'Incident commented');
  assert.equal(got.one.steps.length, 5);
  assert.equal(got.all.notificationsOnTable, 8);
  assert.ok(got.all.otherNotifications.length + 1 <= 8);
  for (const key of ['one', 'all']) {
    assert.ok(!/[A-Za-z.]+@acme\.example/.test(json(got[key])), `${key}: no unmasked address`);
    assert.ok(json(got[key]).length < 9000, `${key}: compact`);
  }
  assert.equal(got.process.level, 'blocked');
  assert.equal(got.map.table, 'incident');
  assert.equal(got.path.result, 'paths');
  assert.equal(got.preview.verdict.level, 'blocked');
  assert.equal(got.listed.retrievedUpdateSets.length, 6);
  assert.equal(got.found.results[0].name, 'AjaxUtil');
  assert.match(got.found.results[0].link, /^\/sys_script_include\.do\?sys_id=[0-9a-f]{32}$/);
});

// ---- run_selfcheck, find_property, read_client_trace --------------------------------------------------------------------

test('the Self-check, property and Client trace tools are observe tier with schemas that name what they need', () => {
  for (const name of ['run_selfcheck', 'find_property', 'read_client_trace']) {
    assert.equal(toolTier(name), 'observe', name);
    const schema = TOOL_SCHEMAS.find((t) => t.name === name);
    assert.ok(schema && schema.description.length > 80 && schema.inputSchema.type === 'object', name);
  }
  assert.deepEqual(TOOL_SCHEMAS.find((t) => t.name === 'find_property').inputSchema.required, ['query']);
  assert.deepEqual(TOOL_SCHEMAS.find((t) => t.name === 'find_property').inputSchema.properties.mode.enum, ['search', 'get', 'usage']);
  assert.deepEqual(TOOL_SCHEMAS.find((t) => t.name === 'read_client_trace').inputSchema.properties.scope.enum, ['current', 'all']);
  assert.ok(!TOOL_SCHEMAS.some((t) => /arm|disarm|clear_trace/.test(t.name)), 'no tool starts, stops or clears the recorder');
});

/** A small ServiceNow for the Self-check: tables with columns, one the user may not read, one that is not installed. */
function selfCheckDeps(over = {}) {
  const tables = {
    task: { parent: '', cols: ['number', 'short_description'] },
    incident: { parent: 'task', cols: ['caller_id'] },
    sys_script: { parent: '', cols: ['name', 'collection'] },
    sys_email: { parent: '', cols: ['subject', 'type'] },
    sys_security_acl: { parent: '', cols: ['name'], denied: true },
    sys_user: { parent: '', cols: ['user_name'] },
  };
  const chain = (t) => (t && tables[t] ? [t, ...chain(tables[t].parent)] : []);
  const ok = (body, ms = 5) => ({ kind: 'ok', status: 200, message: '', ms, body: JSON.stringify(body) });
  let clock = 1_700_000_000_000;
  return {
    request: async (path) => {
      const u = new URL(path, 'https://dev1.service-now.com');
      const m = /^\/api\/now\/table\/([^/]+)$/.exec(u.pathname);
      if (m) {
        const t = m[1];
        if (!tables[t]) return { kind: 'missing', status: 400, message: `Invalid table ${t}`, ms: 4, body: '' };
        if (tables[t].denied) return { kind: 'denied', status: 403, message: 'User Not Authorized', ms: 4, body: '' };
        const have = new Set(['sys_id', ...chain(t).flatMap((x) => tables[x].cols)]);
        return ok({ result: [Object.fromEntries((u.searchParams.get('sysparm_fields') || '').split(',').filter((f) => have.has(f)).map((f) => [f, '']))] });
      }
      if (u.pathname.startsWith('/api/now/stats/')) return ok(u.searchParams.get('sysparm_group_by') ? { result: [{ stats: { count: '3' }, groupby_fields: [{ field: 'active', value: 'true' }] }] } : { result: { stats: { count: '1' } } });
      if (u.pathname.startsWith('/api/now/ui/concoursepicker/')) return ok({ result: { current: { sysId: 'global', name: 'Global' } } });
      return { kind: 'notfound', status: 404, message: '', ms: 1, body: '' };
    },
    queryChunks: async (table, field, values) => values.filter((v) => tables[v]).map((v) => ({ name: v, 'super_class.name': tables[v].parent })),
    query: async (table, query) => {
      const names = /nameIN([^^]+)/.exec(query)[1].split(',');
      const elements = new Set(/elementIN([^^]+)/.exec(query)[1].split(','));
      return names.filter((n) => tables[n]).flatMap((n) => tables[n].cols.filter((c) => elements.has(c)).map((c) => ({ name: n, element: c })));
    },
    session: async () => ({ userName: 'abel.tuter', userId: id(0x77), roles: ['itil'], admin: false }),
    token: async () => true,
    settings: async () => ({ mcpToken: 'tok_SECRET' }),
    pageFacts: () => ({ pathname: '/now/nav/ui/classic/params/target/incident.do', foundFrame: true, frameReadable: true, isTop: true }),
    impersonation: async () => ({ state: 'none' }),
    instance: async () => ({ host: 'dev1.service-now.com', instance: 'dev1', env: 'dev', label: 'DEV', tone: 'ok' }),
    build: async () => ({ info: { buildtag: 'glide-australia-12-18-2025__patch7' }, source: 'stats.do', ms: 50 }),
    script: async () => assert.fail('the background script probe must not run'),
    version: () => '0.8.0',
    requirements: () => [
      { feature: 'Tool Alpha', table: 'incident', columns: ['caller_id', 'number'] },
      { feature: 'Tool Beta', table: 'sys_script', columns: ['name'], optionalColumns: ['filter_condition'] },
      { feature: 'Tool Gamma', table: 'sn_hr_core_case', columns: ['number'] },
      { feature: 'Tool Delta', table: 'sys_security_acl', columns: ['name'] },
      { feature: 'Tool Epsilon', table: 'sys_email', columns: ['subject', 'nope_required'] },
    ],
    now: () => (clock += 250),
    ...over,
  };
}

test('run_selfcheck: the verdict, the API results and each failing tool with its exact table.column names - no secret, no user name', async () => {
  const { createDoctor } = require('../src/content/doctor.js');
  const result = await createDoctor(selfCheckDeps()).run({ scriptProbe: 'never' });
  const out = I.shapeSelfCheck(result);
  assert.equal(out.verdict.status, 'warn');
  assert.match(out.verdict.headline, /3 tools will not work here/);
  assert.deepEqual(out.apiReach.map((c) => c.check), ['Table API (read)', 'Stats API (counts)', 'Stats API (group by)', 'Dictionary (tables and columns)', 'Update set and scope pickers', 'Background script endpoint']);
  assert.equal(out.apiReach.find((c) => c.check === 'Background script endpoint').status, 'skip');
  const byTool = Object.fromEntries(out.toolsNeedingAttention.map((t) => [t.tool, t]));
  assert.deepEqual(byTool['Tool Gamma'].needs, ['sn_hr_core_case (table is not on this instance)']);
  assert.deepEqual(byTool['Tool Delta'].needs, ['sys_security_acl (table not readable for your user)']);
  assert.deepEqual(byTool['Tool Epsilon'].needs, ['sys_email.nope_required']);
  assert.deepEqual(byTool['Tool Beta'].optionalMissing, ['sys_script.filter_condition']);
  assert.equal(byTool['Tool Beta'].status, 'gaps');
  assert.deepEqual(out.toolsThatAreFine, ['Tool Alpha']);
  assert.ok(out.causes.length >= 3 && out.causes[0].blocking);
  assert.equal(out.instance.release, 'Australia patch 7');
  assert.equal(out.you.tier, 'user');
  assert.match(out.scriptCheck, /never runs a script/);
  assert.doesNotMatch(json(out), /tok_SECRET|abel\.tuter|X-UserToken|undefined|NaN/);
  assert.ok(json(out).length < 6000, `compact (${json(out).length} characters)`);
  assert.equal(out.cutShort, undefined);
});

test('run_selfcheck: an ended session says so, and a crowd of broken tools is capped with the rest counted', async () => {
  const { createDoctor } = require('../src/content/doctor.js');
  const gone = await createDoctor(selfCheckDeps({ request: async () => ({ kind: 'session', status: 401, message: 'The session has ended.', ms: 5, body: '' }) })).run({ scriptProbe: 'never' });
  const out = I.shapeSelfCheck(gone);
  assert.equal(out.verdict.status, 'fail');
  assert.match(out.verdict.headline, /session has ended/i);
  assert.ok(out.toolsNeedingAttention.every((t) => t.status === 'unverified'), 'tools are "not checked", not "broken"');
  assert.ok(out.notes.some((n) => /session has ended/i.test(n)));

  const many = Array.from({ length: 60 }, (_, i) => ({ feature: `Tool ${String(i).padStart(2, '0')} ${LONG(30)}`, table: `u_table_${i}`, columns: Array.from({ length: 30 }, (_, c) => `column_${LONG(30, 'x')}_${c}`) }));
  const crowded = await createDoctor(selfCheckDeps({ requirements: () => many })).run({ scriptProbe: 'never' });
  const shaped = I.shapeSelfCheck(crowded);
  const size = measure('run_selfcheck', shaped);
  assert.ok(size < SIZE_LIMIT, `run_selfcheck worst case is ${size} characters`);
  assert.ok(shaped.toolsNeedingAttention.length <= 15 && shaped.moreTools >= 45, `capped with the rest counted (${shaped.toolsNeedingAttention.length} shown, ${shaped.moreTools} more)`);
  assert.ok(shaped.toolsNeedingAttention.every((t) => (t.needs || []).length <= 10));
});

test('find_property: the real service against a fake sys_properties - a secret never carries its value, anywhere', async () => {
  const props = require('../src/content/properties.js');
  const got = await onFakeInstance(async () => {
    props.propertyReset();
    return {
      session: I.shapePropertySearch(await props.searchProperties('session')),
      vendor: I.shapePropertySearch(await props.searchProperties('vendor')),
      keyboard: I.shapePropertySearch(await props.searchProperties('keyboard')),
      byValue: I.shapePropertySearch(await props.searchProperties('abcdef1234567890')),
      exact: I.shapePropertyGet(await props.getProperty({ name: 'glide.ui.session_timeout' }), 'glide.ui.session_timeout'),
      secret: I.shapePropertyGet(await props.getProperty({ name: 'x_acme.vendor.api_key' }), 'x_acme.vendor.api_key'),
      password: I.shapePropertyGet(await props.getProperty({ name: 'x_acme.vendor.login' }), 'x_acme.vendor.login'),
      missing: I.shapePropertyGet(await props.getProperty({ name: 'no.such.property' }), 'no.such.property'),
    };
  });
  const everything = json(got);
  for (const secret of ['sk_live_abcdef1234567890', 'hunter2hunter2', 'abcd1234efgh5678']) assert.ok(!everything.includes(secret), `${secret} must not appear anywhere`);
  assert.equal(got.session.results[0].name, 'glide.ui.session_timeout');
  assert.equal(got.session.results[0].value, '30');
  assert.match(got.session.results[0].link, /^\/sys_properties\.do\?sys_id=[0-9a-f]{32}$/);
  const vendor = Object.fromEntries(got.vendor.results.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(vendor).sort(), ['x_acme.vendor.api_key', 'x_acme.vendor.login', 'x_acme.vendor.notes']);
  Object.values(vendor).forEach((r) => assert.ok(r.hidden && /^\(hidden: /.test(r.value), r.name));
  assert.equal(got.keyboard.results[0].value, 'true', '"keyboard" is not a "key"');
  assert.equal(got.byValue.results.length, 0, 'searching for the text of a secret value finds nothing: it cannot be used to probe one');
  assert.match(got.byValue.note, /No property matches/);
  assert.equal(got.exact.found, true);
  assert.equal(got.exact.property.value, '30');
  assert.equal(got.exact.property.type, 'integer');
  assert.equal(got.secret.property.hidden, true);
  assert.equal(got.password.property.hidden, true);
  assert.equal(got.missing.found, false);
  assert.match(got.missing.note, /No property has this exact name/);
});

test('find_property: usage lists the scripts that read a property; a secret one does not give away its default', async () => {
  const props = require('../src/content/properties.js');
  const out = await onFakeInstance(async () => I.shapePropertyUsage(await props.findPropertyUsage('x_acme.vendor.api_key')));
  assert.equal(out.counts.read, 1);
  assert.equal(out.hits[0].in, 'Script Include');
  assert.equal(out.hits[0].name, 'VendorClient');
  assert.match(out.hits[0].link, /^\/sys_script_include\.do\?sys_id=[0-9a-f]{32}$/);
  assert.match(out.hits[0].lines[0].text, /gs\.getProperty/);
  assert.ok(!json(out).includes('fallbackSecret123'), 'the default of a secret property is not returned');
  assert.equal(out.hits[0].lines[0].arg, undefined);
  assert.match(out.summary, /read by 1 script/);
  assert.match(out.limits, /cannot be found by searching/);
  const none = await onFakeInstance(async () => I.shapePropertyUsage(await props.findPropertyUsage('glide.ui.session_timeout')));
  assert.deepEqual(none.hits, []);
  assert.match(none.summary, /No active script uses glide\.ui\.session_timeout/);
});

test('find_property: lists are capped and the answer stays small even for long names, values and many hits', () => {
  const P = require('../src/lib/properties.js');
  const rows = Array.from({ length: 100 }, (_, i) => P.toProperty({ sys_id: id(0xa00 + i), name: `x_acme.${LONG(60, 'name_')}.${i}`, value: LONG(900), type: 'string', description: LONG(400) }));
  const search = I.shapePropertySearch({ query: 'x_acme', rows, total: 340, capped: true, notes: ['a', 'b', 'c', 'd', 'e'] });
  const size = measure('find_property search', search);
  assert.ok(size < SIZE_LIMIT, `find_property search worst case is ${size} characters`);
  assert.ok(search.results.length <= 15);
  assert.equal(search.moreMatches, 340 - search.results.length);
  assert.ok(search.results.every((r) => r.value.length <= 125));
  const hits = Array.from({ length: 40 }, (_, i) => ({ table: 'sys_script', label: LONG(60), sysId: id(0xb00 + i), name: LONG(300), field: 'script', url: `/sys_script.do?sys_id=${id(0xb00 + i)}`, kind: 'read', lines: Array.from({ length: 12 }, (_, l) => ({ line: l + 1, kind: 'read', text: LONG(300), arg: LONG(100) })) }));
  const usage = I.shapePropertyUsage({ name: 'glide.ui.x', hits, summary: LONG(900), capped: ['Business Rule'], errors: Array.from({ length: 9 }, () => ({ label: LONG(60) })), commentOnly: 3 });
  const usageSize = measure('find_property usage', usage);
  assert.ok(usageSize < SIZE_LIMIT, `find_property usage worst case is ${usageSize} characters`);
  assert.ok(usage.hits.length <= 12 && usage.moreHits >= 28);
});

let traceFixture = null;
async function withTraceFixture(fn) {
  const saved = { window: global.window, location: global.location };
  global.location = { search: '?trace=demo-armed' };
  global.window = { location: { hostname: 'localhost', host: 'localhost', pathname: '/incident.do', origin: 'http://localhost' }, addEventListener() {}, frames: [] };
  try {
    if (!traceFixture) {
      // The fixture module reads the address once, when it is first loaded, and sets the sample recording.
      delete globalThis.__msbClientTraceFixture;
      require('../preview/fixtures/clienttrace.js');
      traceFixture = globalThis.__msbClientTraceFixture;
    }
    globalThis.__msbClientTraceFixture = traceFixture;
    return await fn(traceFixture);
  } finally {
    delete globalThis.__msbClientTraceFixture;
    global.window = saved.window;
    global.location = saved.location;
  }
}

test('read_client_trace: the recorded demo form - what stands out, who set each field, a short timeline; hidden values stay hidden', async () => {
  const { clientTraceServices } = require('../src/content/clientTrace.js');
  const out = await withTraceFixture(async (fixture) => {
    assert.ok(fixture && fixture.events.length > 20, 'the preview recording is there');
    const load = await clientTraceServices.clientTraceLoad();
    const status = await clientTraceServices.clientTraceStatus();
    return { load, status, shaped: I.shapeClientTrace(load), priority: I.shapeClientTrace(load, { field: 'priority' }), all: I.shapeClientTrace(load, { scope: 'all', limit: 5 }) };
  });
  assert.equal(out.status.armed, true);
  const t = out.shaped;
  assert.equal(t.recording.armed, true);
  assert.equal(t.recording.recorder, 'running');
  assert.ok(t.events > 20);
  assert.equal(t.note, undefined, 'there is a recording, so no "nothing recorded" note');
  const titles = t.findings.map((f) => f.title).join(' | ');
  assert.match(titles, /JavaScript error: Uncaught TypeError/);
  assert.match(titles, /Slow GlideAjax|Synchronous call blocks the browser/);
  assert.match(titles, /Same GlideAjax called 3 times/);
  assert.match(titles, /not on the form|is on a field that is not on the form/);
  assert.equal(t.findings[0].severity, 'high', 'the most serious first');
  const priority = t.fields.find((f) => f.field === 'priority');
  assert.equal(priority.steps[0].did, 'changed from "3" to "1"');
  assert.match(priority.steps[0].from, /onChange_287ebd7da9fe198100f92cc8d1d2154e/, 'a script that is not named by the instance is shown by its stack frame');
  // The same recording with the instance's answers (the fixture's own lookups): scripts get their names, classes are checked.
  const resolved = await withTraceFixture(() => clientTraceServices.clientTraceResolve(I.traceRefs(out.load)));
  const named = I.shapeClientTrace(out.load, { resolved });
  assert.equal(named.fields.find((f) => f.field === 'priority').steps[0].from, 'Client script: Reset priority when category changes (onChange on category)');
  assert.ok(named.findings.some((f) => /Slow.*not client callable|not client callable/.test(f.title) && f.severity === 'high'), 'the lookup of the GlideAjax class adds its finding');
  assert.ok(I.traceRefs(out.load).ids.length <= 40 && I.traceRefs(out.load).ids.includes('287ebd7da9fe198100f92cc8d1d2154e'));
  assert.ok(t.timeline.length <= 20);
  assert.ok(t.timeline.some((r) => r.problem && /TypeError/.test(r.what)), 'problems are kept in the timeline');
  const text = json(t);
  assert.ok(!/hunter|sk_live/.test(text));
  assert.doesNotMatch(text, /password=(?!\[hidden\])\S+/i);
  assert.deepEqual(out.priority.fields.map((f) => f.field), ['priority']);
  assert.ok(out.priority.events < t.events);
  assert.ok(out.all.timeline.length <= 5 && out.all.moreTimeline >= 1);
  assert.ok(json(t).length < 8000, `compact (${json(t).length} characters)`);
});

test('read_client_trace: nothing recorded, recorder missing, recording on but empty - each said plainly, never "nothing happened"', () => {
  const off = I.shapeClientTrace({ state: { armed: false, recorder: 'running', frames: [] }, events: [] });
  assert.equal(off.events, 0);
  assert.match(off.note, /recording is off.*Reload and record.*never starts or stops/s);
  const on = I.shapeClientTrace({ state: { armed: true, minutesLeft: 9, recorder: 'running', frames: [] }, events: [] });
  assert.match(on.note, /Recording is on \(9 min left\), but nothing has been captured yet/);
  const missing = I.shapeClientTrace({ state: { armed: true, recorder: 'missing', frames: [] }, events: [] });
  assert.match(missing.note, /recorder is not loaded in this page/);
});

test('read_client_trace: a long recording is cut to the limit, problems first, and stays small', () => {
  const frame = [{ fn: `onLoad_${'c'.repeat(32)}`, line: 3, col: 1, url: '/incident.do' }];
  const events = Array.from({ length: 3000 }, (_, i) => ({
    seq: i + 1, id: i + 1, rid: 'r1', frame: 'gsft_main', t: i, at: 1_000_000 + i, stack: frame,
    ...(i % 500 === 0 ? { kind: 'error', name: 'TypeError', args: [`Uncaught TypeError: ${LONG(300)} ${i}`], flags: { exception: true } } : { kind: 'field', name: 'g_form.setValue', field: `field_${i % 60}`, args: [LONG(200)], result: { before: LONG(100), after: LONG(100), changed: true } }),
  }));
  const out = I.shapeClientTrace({ state: { armed: true, minutesLeft: 3, recorder: 'running', frames: [{ rid: 'r1', frame: 'gsft_main', count: 3000 }] }, events }, { limit: 20 });
  const size = measure('read_client_trace', out);
  assert.ok(size < SIZE_LIMIT, `read_client_trace worst case is ${size} characters`);
  assert.ok(out.timeline.length <= 20 && out.moreTimeline > 2900);
  assert.equal(out.timeline.filter((r) => r.problem).length, 6, 'all six errors survive the cut');
  assert.ok(out.fields.length <= 8 && out.fields.length + out.moreFields === 60, 'every one of the 60 fields is either shown or counted');
  assert.match(out.cutShort, /cut shorter/);
});

test('end to end through the real wiring: find_property and read_client_trace; the Self-check is wired to the real service and never to a script probe', async () => {
  const tools = realTools();
  const { createControlDeps } = require('../src/content/controlSession.js');
  const insights = createControlDeps().insights;
  assert.equal(typeof insights.doctorRun, 'function');
  assert.ok(!('clientTraceArm' in insights) && !('clientTraceDisarm' in insights) && !('clientTraceClear' in insights), 'arm, disarm and clear are not reachable from a tool');

  const got = await onFakeInstance(async () => ({
    search: await tools.find_property({ query: 'vendor' }),
    get: await tools.find_property({ query: 'x_acme.vendor.api_key', mode: 'get' }),
    usage: await tools.find_property({ query: 'x_acme.vendor.api_key', mode: 'usage' }),
  }));
  assert.equal(got.search.results.length, 3);
  assert.ok(got.search.results.every((r) => r.hidden));
  assert.equal(got.get.property.hidden, true);
  assert.equal(got.usage.counts.read, 1);
  assert.ok(!/sk_live_abcdef1234567890|hunter2hunter2|fallbackSecret123|abcd1234efgh5678/.test(json(got)));

  const trace = await withTraceFixture(() => tools.read_client_trace({ field: 'category' }));
  assert.deepEqual(trace.fields.map((f) => f.field), ['category']);
  assert.equal(trace.recording.armed, true);
  assert.match(trace.fields[0].steps[0].from, /^Client script: /, 'through the real wiring the scripts are named by the instance lookup');
});
