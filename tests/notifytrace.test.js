const test = require('node:test');
const assert = require('node:assert/strict');
const {
  flatRow,
  parseSnTime,
  agoText,
  whenText,
  normalizeNotification,
  triggerText,
  conditionQuery,
  conditionCheckable,
  interpretCondition,
  evaluateLocally,
  conditionLines,
  normalizeEvent,
  classifyEvent,
  nearEventNames,
  normalizeEmail,
  classifyEmail,
  parseAddresses,
  subjectMatcher,
  matchEmails,
  readSwitches,
  normalizeUser,
  normalizeGroup,
  normalizeDevice,
  buildDirectory,
  recipientIdsNeeded,
  expandRecipients,
  recipientProblem,
  traceNotification,
  sortCandidates,
  emailPreviewText,
  looksSecretMail,
  notifyToMarkdown,
  conditionFieldsMissing,
  switchRowsOrThrow,
  isInbound,
  notificationIdFromHeaders,
  applyEmailLog,
  STUCK_EVENT_MINUTES,
  STUCK_EMAIL_MINUTES,
} = require('../src/lib/notifyTrace.js');

// --- Fixtures: incident INC0010042 on an instance, "now" is 2026-10-23 12:00 UTC ---------------------------------

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
const id = (n) => n.toString(16).padStart(32, '0');

const INC = id(0x9de5);
const ABEL = id(0xa1); // the caller, also the person who fires events in these fixtures
const BETH = id(0xa2);
const FRED = id(0xa3); // inactive
const DAVID = id(0xa4); // notifications disabled
const BOW = id(0xa5); // no email address
const SERVICE_DESK = id(0xb1);
const EMPTY_GROUP = id(0xb2);

const record = (extra = {}) => ({ table: 'incident', sysId: INC, chain: ['incident', 'task'], createdOn: ago(300), updatedOn: ago(20), modCount: 4, values: { priority: '1', state: '2', assigned_to: '', caller_id: ABEL }, display: { caller_id: 'Abel Tuter' }, ...extra });

const note = (extra = {}) =>
  normalizeNotification({
    sys_id: id(0xc1), name: 'Incident commented', collection: 'incident', active: 'true', generation_type: 'event', event_name: 'incident.commented', condition: '', recipient_users: '', recipient_groups: '',
    recipient_fields: 'caller_id', send_self: 'false', force_delivery: 'false', subject: 'Incident ${number} was commented on', sys_created_on: ago(60 * 24 * 90), ...extra,
  });

const event = (extra = {}) => normalizeEvent({ sys_id: id(0xe1), name: 'incident.commented', state: 'processed', table: 'incident', instance: INC, parm1: '', parm2: '', queue: 'default', sys_created_on: ago(10), processed: ago(9), user_name: 'abel.tuter', ...extra });

// Real emails name their notification in the first header line (checked live 2026-10-23); sys_email has no notification column.
const hdr = (notificationId) => `X-ServiceNow-Source:Notification-${notificationId}\r\nX-ServiceNow-SysEmail-Version:2\r\nContent-Type:multipart/mixed`;
const email = (extra = {}) => normalizeEmail({ sys_id: id(0xf1), type: 'sent', state: 'sent', subject: 'Incident INC0010042 was commented on', recipients: 'beth.anglin@acme.example', sys_created_on: ago(8), instance: INC, target_table: 'incident', headers: hdr(id(0xc1)), ...extra });

const user = (key, extra = {}) => normalizeUser({ sys_id: key, name: 'Someone', user_name: 'someone', email: 'someone@acme.example', active: 'true', locked_out: 'false', notification: '2', ...extra }, { notification: 'Enable' });

const directory = () =>
  buildDirectory({
    users: [
      user(ABEL, { name: 'Abel Tuter', user_name: 'abel.tuter', email: 'abel.tuter@acme.example' }),
      user(BETH, { name: 'Beth Anglin', user_name: 'beth.anglin', email: 'beth.anglin@acme.example' }),
      user(FRED, { name: 'Fred Luddy', user_name: 'fred.luddy', active: 'false', locked_out: 'true' }),
      normalizeUser({ sys_id: DAVID, name: 'David Loo', user_name: 'david.loo', email: 'david.loo@acme.example', active: 'true', notification: '1' }, { notification: 'Disable' }),
      user(BOW, { name: 'Bow Ruggeri', user_name: 'bow.ruggeri', email: '' }),
    ],
    groups: [normalizeGroup({ sys_id: SERVICE_DESK, name: 'Service Desk', active: 'true' }), normalizeGroup({ sys_id: EMPTY_GROUP, name: 'Legacy Ops', active: 'false' })],
    members: [{ group: SERVICE_DESK, user: BETH }, { group: SERVICE_DESK, user: FRED }, { group: SERVICE_DESK, user: DAVID }],
    devices: [],
  });

const callerField = { caller_id: { value: ABEL, display: 'Abel Tuter' } };
const expand = (n, extra = {}) => expandRecipients({ notification: n, directory: directory(), fieldValues: callerField, creator: null, parms: {}, ...extra });

const MET = { status: 'met', reason: 'priority is 1' };
const trace = (extra = {}) => {
  const n = extra.notification || note();
  return traceNotification({ notification: n, record: record(), condition: MET, events: [], emails: [], recipients: expand(n), now: NOW, ...extra });
};
const stage = (t, id2) => t.stages.find((s) => s.id === id2);

// --- Small helpers -------------------------------------------------------------------------------------------

test('flatRow separates values from display values (display_value=all) and keeps plain strings', () => {
  const { values, display } = flatRow({ number: 'INC1', caller_id: { value: ABEL, display_value: 'Abel Tuter' }, state: { value: '2', display_value: '2' }, empty: '' });
  assert.equal(values.caller_id, ABEL);
  assert.deepEqual(display, { caller_id: 'Abel Tuter' });
  assert.equal(values.state, '2');
  assert.equal(values.number, 'INC1');
});

test('instance times are read as UTC and shown with their zone', () => {
  assert.equal(parseSnTime('2026-10-23 12:00:00'), NOW);
  assert.equal(parseSnTime(''), null);
  assert.equal(parseSnTime('not a date'), null);
  assert.equal(whenText('2026-10-23 09:14:55'), '2026-10-23 09:14 UTC');
  assert.equal(whenText(''), '');
  assert.equal(agoText(0), 'just now');
  assert.equal(agoText(45), '45 min');
  assert.equal(agoText(180), '3 h');
  assert.equal(agoText(60 * 24 * 5), '5 days');
});

// --- Notifications -------------------------------------------------------------------------------------------

test('a notification is classed by generation_type, then by what is ticked', () => {
  assert.equal(note().kind, 'event');
  assert.equal(normalizeNotification({ name: 'a', generation_type: 'engine', action_insert: 'true', event_name: 'stale.event' }).kind, 'engine');
  assert.equal(normalizeNotification({ name: 'b', generation_type: 'triggered' }).kind, 'triggered');
  // No generation_type column at all: fall back to the event name, then insert/update.
  assert.equal(normalizeNotification({ name: 'c', event_name: 'x.y' }).kind, 'event');
  assert.equal(normalizeNotification({ name: 'd', action_update: 'true' }).kind, 'engine');
  assert.equal(normalizeNotification({ name: 'e' }).kind, 'triggered');
  assert.equal(triggerText(note()), 'when the event incident.commented is queued');
  assert.equal(triggerText(normalizeNotification({ action_insert: 'true', action_update: 'true' })), 'when a record is inserted or updated');
  assert.match(triggerText(normalizeNotification({ name: 'e' })), /flow, workflow or script/);
});

test('an event name held as a reference is read from the display value; lists are split and checked', () => {
  const n = normalizeNotification({ name: 'r', event_name: id(0x77), recipient_users: `${ABEL},${BETH}`, recipient_groups: SERVICE_DESK, recipient_fields: 'caller_id, assigned_to,bad field!', event_parm_1: 'true' }, { event_name: 'incident.assigned' });
  assert.equal(n.eventName, 'incident.assigned');
  assert.deepEqual(n.recipientUsers, [ABEL, BETH]);
  assert.deepEqual(n.recipientGroups, [SERVICE_DESK]);
  assert.deepEqual(n.recipientFields, ['caller_id', 'assigned_to']);
  assert.equal(n.eventParm1, true);
});

test('an advanced condition that is only comments counts as none', () => {
  assert.equal(normalizeNotification({ advanced_condition: '// answer = true;\n/* later */' }).advancedCondition, '');
  assert.match(normalizeNotification({ advanced_condition: 'answer = current.priority == 1;' }).advancedCondition, /answer/);
});

// --- The condition -------------------------------------------------------------------------------------------

test('the check query puts the sys_id in front of every group, so an OR of groups cannot match other records', () => {
  assert.equal(conditionQuery(INC, 'priority=1^EQ'), `sys_id=${INC}^priority=1`);
  assert.equal(conditionQuery(INC, 'priority=1^ORpriority=2^state=2'), `sys_id=${INC}^priority=1^ORpriority=2^state=2`);
  assert.equal(conditionQuery(INC, 'priority=1^NQstate=6^EQ'), `sys_id=${INC}^priority=1^NQsys_id=${INC}^state=6`);
  assert.equal(conditionQuery(INC, ''), '');
  assert.equal(conditionQuery(INC, '^EQ'), '');
  assert.throws(() => conditionQuery('INC0010042', 'priority=1'), /sys_id/);
  assert.throws(() => conditionQuery(`${INC}^ORactive=true`, 'priority=1'), /sys_id/);
});

test('conditions that depend on the save or on the viewer are not checked against the stored record', () => {
  assert.equal(conditionCheckable('priority=1').checkable, true);
  assert.equal(conditionCheckable('stateCHANGESTO6').checkable, false);
  assert.match(conditionCheckable('priorityVALCHANGES').why, /moment of the save/);
  assert.equal(conditionCheckable('assigned_toDYNAMIC90d1921e5f510100a9ad2572f2b477fe').checkable, false);
  assert.equal(conditionCheckable('caller_id=javascript:gs.getUserID()').checkable, false);
  assert.equal(conditionCheckable('').checkable, false);
});

test('the instance answer wins; the local reading supplies the reason', () => {
  const local = evaluateLocally('priority=3', record());
  assert.equal(local.result, 'false');
  const out = interpretCondition({ condition: 'priority=3', matched: false, local });
  assert.equal(out.status, 'not_met');
  assert.match(out.reason, /priority is 1/);
  assert.equal(out.how, 'instance');

  assert.equal(interpretCondition({ condition: 'priority=1', matched: true, local: evaluateLocally('priority=1', record()) }).status, 'met');
  assert.equal(interpretCondition({ condition: '', matched: null }).status, 'none');
  assert.equal(interpretCondition({ condition: 'stateCHANGESTO6', matched: null }).status, 'unknown');
});

test('when the instance cannot be asked, only a certain local answer is used', () => {
  const failing = interpretCondition({ condition: 'priority=3', matched: null, error: 'timeout', local: evaluateLocally('priority=3', record()) });
  assert.equal(failing.status, 'not_met');
  assert.equal(failing.how, 'local');
  const unsure = interpretCondition({ condition: 'caller_id.manager.title=CIO', matched: null, error: 'Your user is not allowed to do this (403).', local: evaluateLocally('caller_id.manager.title=CIO', record()) });
  assert.equal(unsure.status, 'unknown');
  assert.match(unsure.reason, /could not be checked/);
});

test('the condition is described in short plain lines', () => {
  assert.deepEqual(conditionLines('priority=1^ORpriority=2^assigned_toISEMPTY^EQ'), ['priority is 1, or priority is 2, and assigned_to is empty']);
  assert.deepEqual(conditionLines(''), []);
});

// --- Events and emails ---------------------------------------------------------------------------------------

test('events: processed, error, scheduled, waiting and stuck are told apart', () => {
  assert.equal(classifyEvent(event(), NOW).phase, 'processed');
  assert.equal(classifyEvent(event({ state: 'error' }), NOW).phase, 'error');
  assert.equal(classifyEvent(event({ state: 'ready', processed: '', sys_created_on: ago(2) }), NOW).phase, 'pending');
  const stuck = classifyEvent(event({ state: 'ready', processed: '', sys_created_on: ago(STUCK_EVENT_MINUTES + 5) }), NOW);
  assert.equal(stuck.phase, 'stuck');
  assert.equal(stuck.minutes, STUCK_EVENT_MINUTES + 5);
  assert.equal(classifyEvent(event({ state: 'ready', processed: '', sys_created_on: ago(120), process_on: new Date(NOW + 3600e3).toISOString().slice(0, 19).replace('T', ' ') }), NOW).phase, 'scheduled');
  assert.equal(classifyEvent(event({ state: 'weird' }), NOW).phase, 'other');
});

test('emails: type decides, state backs it up; an outbox email is stuck after a while', () => {
  assert.equal(classifyEmail(email(), NOW).phase, 'sent');
  assert.equal(classifyEmail(email({ type: 'send-ready', state: 'ready', sys_created_on: ago(3) }), NOW).phase, 'ready');
  const stuck = classifyEmail(email({ type: 'send-ready', state: 'ready', sys_created_on: ago(STUCK_EMAIL_MINUTES + 1) }), NOW);
  assert.equal(stuck.stuck, true);
  assert.equal(classifyEmail(email({ type: 'send-ignored', state: 'ignored' }), NOW).phase, 'ignored');
  assert.equal(classifyEmail(email({ type: 'send-failed', state: 'send-failed', error_string: '535 Authentication credentials invalid' }), NOW).phase, 'failed');
  assert.equal(classifyEmail(email({ type: 'received', state: 'received' }), NOW).phase, 'received');
  assert.equal(classifyEmail(email({ type: '', state: 'sent' }), NOW).phase, 'sent');
});

test('addresses are read from lists and from "Name <address>" forms', () => {
  assert.deepEqual(parseAddresses('Beth Anglin <Beth.Anglin@acme.example>, abel@acme.example;  ,not-an-address'), ['beth.anglin@acme.example', 'abel@acme.example']);
});

test('near-miss event names are suggested', () => {
  const fired = [event({ name: 'incident.comented' }), event({ name: 'incident.assigned' })];
  assert.deepEqual(nearEventNames('incident.commented', fired), ['incident.comented']);
  assert.deepEqual(nearEventNames('incident.commented', [event({ name: 'Incident_Commented' })]), ['Incident_Commented']);
  assert.deepEqual(nearEventNames('x', fired), []);
});

test('emails are matched to a notification by the header it names, else (no headers) by subject template', () => {
  const n = note();
  const mine = email();
  // Same subject, but its header names another notification: the header wins, the subject is not used.
  const other = email({ sys_id: id(0xf2), headers: hdr(id(0xc9)) });
  // No headers yet (an email still waiting to be sent): only the subject can tie it.
  const loose = email({ sys_id: id(0xf3), headers: '', subject: 'Incident INC0010042 was commented on' });
  const m = matchEmails(n, [mine, other, loose]);
  assert.deepEqual(m.emails.map((e) => e.sysId).sort(), [id(0xf1), id(0xf3)].sort());
  assert.equal(m.by, 'link and subject');
  assert.equal(matchEmails(n, [other]).emails.length, 0);
  // Headers that name no notification (a script's email): known origin, never matched by subject.
  const script = email({ sys_id: id(0xf5), headers: 'X-ServiceNow-Source:Script\r\nContent-Type:text/html' });
  assert.equal(script.linkKnown, true);
  assert.equal(matchEmails(n, [script]).emails.length, 0);

  const noHeaders = normalizeEmail({ sys_id: id(0xf4), type: 'sent', subject: 'Incident INC0010042 was commented on', instance: INC });
  const bySubject = matchEmails(n, [noHeaders]);
  assert.equal(bySubject.emails.length, 1);
  assert.equal(bySubject.by, 'subject');
  assert.equal(bySubject.subjectOnly, true);
});

test('the X-ServiceNow-Source header is read strictly, line by line, with CRLF or LF', () => {
  const nid = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  assert.equal(notificationIdFromHeaders(`X-ServiceNow-Source:Notification-${nid}\r\nX-Other:1`), nid);
  assert.equal(notificationIdFromHeaders(`Content-Type:text/html\nX-ServiceNow-Source:Notification-${nid.toUpperCase()}\n`), nid);
  assert.equal(notificationIdFromHeaders('X-ServiceNow-Source:Script'), '');
  assert.equal(notificationIdFromHeaders(`Subject: X-ServiceNow-Source:Notification-${nid}`), '', 'only at the start of a line');
  assert.equal(notificationIdFromHeaders(`X-ServiceNow-Source:Notification-${nid}ab`), '', 'not a 32-hex id');
  assert.equal(notificationIdFromHeaders(''), '');
});

test('the email log ties an email to its notification and its event, and beats a missing header', () => {
  const pending = email({ sys_id: id(0xf6), headers: '', type: 'send-ready', state: 'ready' });
  const [linked, untouched] = applyEmailLog([pending, email()], [
    { email: id(0xf6), event: id(0xe1), notification: id(0xc1) },
    { email: id(0xdead), event: id(0xe9), notification: id(0xc9) },
  ]);
  assert.equal(linked.notificationId, id(0xc1));
  assert.equal(linked.eventId, id(0xe1));
  assert.equal(linked.linkKnown, true);
  assert.equal(linked.linkBy, 'log');
  assert.equal(untouched.linkBy, 'header');
  // Tied to an older event by the log: it answers for that event, not for the latest one.
  const older = applyEmailLog([email({ sys_created_on: ago(5) })], [{ email: id(0xf1), event: id(0xe0), notification: id(0xc1) }]);
  const t = trace({ events: [event({ sys_id: id(0xe0), sys_created_on: ago(60) }), event({ sys_created_on: ago(10) })], emails: older, recipients: expand(note(), { creator: null }) });
  assert.deepEqual(t.emailsRelevant, []);
  assert.equal(stage(t, 'created').status, 'fail');
});

test('a subject that is only placeholders is too generic to match on', () => {
  assert.equal(subjectMatcher('${number}'), null);
  assert.equal(subjectMatcher(''), null);
  assert.ok(subjectMatcher('Re: ${number} - assigned to you').test('RE: INC0010042 - assigned to you'));
  assert.equal(subjectMatcher('Incident ${number} resolved').test('Incident INC1 reopened'), false);
});

// --- Instance switches ---------------------------------------------------------------------------------------

test('switches: sending off, test redirect and a sub-production instance are reported, absent properties are not', () => {
  const sw = readSwitches(
    [
      { name: 'glide.email.smtp.active', value: 'false' },
      { name: 'glide.email.test.user', value: 'qa-inbox@acme.example' },
      { name: 'glide.installation.production', value: 'false' },
    ],
    { hostEnvironment: 'dev' }
  );
  assert.equal(sw.sendingOff, true);
  assert.equal(sw.testUser, 'qa-inbox@acme.example');
  assert.deepEqual(sw.findings.map((f) => f.id), ['sending-off', 'test-user', 'non-production']);
  assert.match(sw.findings[0].text, /switched off on this instance/);
  assert.match(sw.findings[1].text, /redirected to qa-inbox@acme.example/);
});

test('switches: an instance with email on and nothing unusual has no findings; missing properties stay unknown', () => {
  const on = readSwitches([{ name: 'glide.email.smtp.active', value: 'true' }, { name: 'glide.installation.production', value: 'true' }], { hostEnvironment: 'prod' });
  assert.equal(on.sendingOff, false);
  assert.deepEqual(on.findings, []);
  const none = readSwitches([], {});
  assert.equal(none.sendingOff, null);
  assert.deepEqual(none.findings, []);
  // A property this tracer did not ask for is ignored even if a caller passes it.
  assert.deepEqual(readSwitches([{ name: 'glide.email.smtp.password', value: 'hunter2' }]).present, {});
});

// --- Recipients ----------------------------------------------------------------------------------------------

test('a recipient field on the record supplies its user', () => {
  const rec = expand(note());
  assert.equal(rec.counts.total, 1);
  assert.equal(rec.people[0].name, 'Abel Tuter');
  assert.deepEqual(rec.people[0].sources, ['Field caller_id']);
  assert.equal(rec.people[0].status, 'receives');
});

test('the person who caused the event is left out when "Send to event creator" is off, and kept when it is on', () => {
  const creator = { userIds: [], userNames: ['Abel.Tuter'], source: 'event' };
  const off = expand(note(), { creator });
  assert.equal(off.people[0].status, 'blocked');
  assert.equal(off.people[0].reasons[0].code, 'creator');
  assert.match(off.people[0].reasons[0].text, /fired the event/);
  assert.match(off.people[0].reasons[0].advice, /Send to event creator/);
  assert.deepEqual(off.creatorExcluded, ['Abel Tuter']);
  const on = expand(note({ send_self: 'true' }), { creator });
  assert.equal(on.people[0].status, 'receives');
  // Matched by sys_id too.
  assert.equal(expand(note(), { creator: { userIds: [ABEL], userNames: [], source: 'save' } }).people[0].reasons[0].code, 'creator');
});

test('users, groups, inactive members and disabled notifications are each explained', () => {
  const n = note({ recipient_users: `${ABEL},${DAVID},${BOW}`, recipient_groups: `${SERVICE_DESK},${EMPTY_GROUP}`, recipient_fields: '' });
  const rec = expand(n);
  const byName = Object.fromEntries(rec.people.map((p) => [p.name, p]));
  assert.equal(byName['Abel Tuter'].status, 'receives');
  assert.equal(byName['Beth Anglin'].status, 'receives');
  assert.equal(byName['Beth Anglin'].sources.includes('Member of Service Desk'), true);
  assert.equal(byName['Fred Luddy'].reasons[0].code, 'inactive');
  assert.equal(byName['David Loo'].reasons[0].code, 'disabled');
  assert.equal(byName['Bow Ruggeri'].reasons[0].code, 'no-email');
  assert.deepEqual([rec.counts.total, rec.counts.receive, rec.counts.blocked], [5, 2, 3]);
  assert.equal(rec.issues.some((i) => i.code === 'group-empty' && /Legacy Ops/.test(i.text)), true);
  assert.equal(rec.issues.some((i) => i.code === 'group-inactive' && /Legacy Ops/.test(i.text)), true);
  assert.equal(rec.people[0].status, 'receives'); // those who would receive it come first
});

test('a notification with Force delivery overrides a user who switched notifications off, and names that box', () => {
  const rec = expand(note({ recipient_users: DAVID, recipient_fields: '', force_delivery: 'true' }));
  assert.equal(rec.people[0].status, 'receives');
  assert.match(rec.people[0].notes.join(' '), /Force delivery/);
  const off = expand(note({ recipient_users: DAVID, recipient_fields: '' }));
  assert.match(off.people[0].reasons[0].advice, /tick Force delivery/);
});

test('an empty recipient field is named, with the field', () => {
  const rec = expand(note({ recipient_fields: 'assigned_to' }), { fieldValues: { assigned_to: { value: '', display: '' } } });
  assert.equal(rec.counts.total, 0);
  assert.equal(rec.issues[0].code, 'field-empty');
  assert.match(recipientProblem(rec), /assigned_to is empty on this record/);
});

test('a notification with no recipients at all says so', () => {
  const rec = expand(note({ recipient_fields: '' }));
  assert.equal(rec.issues[0].code, 'none-configured');
  assert.match(recipientProblem(rec), /no recipients/);
});

test('event parameters, plain addresses and groups held in a field are expanded', () => {
  const n = note({ recipient_fields: 'assignment_group,watch_list', event_parm_1: 'true', event_parm_2: 'true' });
  const rec = expand(n, {
    fieldValues: { assignment_group: { value: SERVICE_DESK }, watch_list: { value: `${BETH},ops-list@acme.example` } },
    parms: { parm1: `${ABEL}`, parm2: '' },
  });
  const names = rec.people.map((p) => p.name);
  assert.equal(names.includes('Beth Anglin'), true);
  assert.equal(names.includes('ops-list@acme.example'), true);
  assert.equal(rec.people.find((p) => p.isAddress).reasons.length, 0);
  assert.equal(rec.issues.some((i) => i.code === 'parm-empty' && /Event parameter 2/.test(i.text)), true);
  assert.equal(rec.people.find((p) => p.name === 'Abel Tuter').sources.includes('Event parameter 1'), true);
});

test('an inactive email device blocks a user who has an address', () => {
  const dir = buildDirectory({ users: [user(ABEL, { name: 'Abel Tuter', user_name: 'abel.tuter' })], devices: [normalizeDevice({ user: ABEL, type: 'Email', active: 'false', email_address: 'abel.tuter@acme.example' })] });
  const rec = expandRecipients({ notification: note(), directory: dir, fieldValues: callerField });
  assert.equal(rec.people[0].reasons[0].code, 'device-inactive');
  // A user with no address on the record but an active device is fine.
  const dir2 = buildDirectory({ users: [user(ABEL, { name: 'Abel Tuter', email: '' })], devices: [normalizeDevice({ user: ABEL, type: 'Email', active: 'true', email_address: 'abel@home.example' })] });
  assert.equal(expandRecipients({ notification: note(), directory: dir2, fieldValues: callerField }).people[0].status, 'receives');
});

test('the ids a set of notifications needs are collected once', () => {
  const a = note({ recipient_users: `${ABEL},${BETH}`, recipient_groups: SERVICE_DESK, recipient_fields: 'caller_id,assignment_group' });
  const b = note({ sys_id: id(0xc2), recipient_users: BETH, recipient_groups: EMPTY_GROUP, recipient_fields: 'caller_id' });
  const need = recipientIdsNeeded([a, b], { fieldValues: { caller_id: { value: ABEL }, assignment_group: { value: SERVICE_DESK } }, parms: [`${DAVID}`, 'x@y.example'], creatorIds: [FRED] });
  assert.deepEqual(need.users.sort(), [ABEL, BETH, FRED].sort());
  assert.deepEqual(need.groups.sort(), [SERVICE_DESK, EMPTY_GROUP].sort());
  assert.deepEqual(need.unknown.sort(), [ABEL, SERVICE_DESK, DAVID].sort());
  assert.deepEqual(need.fields.sort(), ['assignment_group', 'caller_id']);
});

// --- Tracing: every failure mode, in the order of the chain ----------------------------------------------------

test('everything works: matched, fired, processed, created, sent', () => {
  const t = trace({ events: [event()], emails: [email()] });
  assert.deepEqual(t.stages.map((s) => s.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(t.verdict.status, 'sent');
  assert.match(t.verdict.headline, /Sent to beth.anglin@acme.example/);
  assert.match(t.verdict.advice, /spam/);
  assert.equal(t.tier, 0);
});

test('inactive is the first thing that stops a notification', () => {
  const t = trace({ notification: note({ active: 'false' }) });
  assert.equal(t.stages[0].status, 'fail');
  assert.equal(t.verdict.status, 'blocked');
  assert.equal(t.verdict.stage, 'match');
  assert.equal(t.verdict.code, 'inactive');
  assert.match(t.verdict.headline, /inactive/);
  assert.equal(t.tier, 3);
  // Nothing after the first failure is reached.
  assert.equal(stage(t, 'created').status, 'skip');
});

test('a condition that is not met stops it, and says which value is wrong', () => {
  const n = note({ condition: 'priority=3^EQ' });
  const local = evaluateLocally(n.condition, record());
  const t = trace({ notification: n, condition: interpretCondition({ condition: n.condition, matched: false, local }) });
  assert.equal(t.verdict.code, 'condition');
  assert.match(t.verdict.headline, /does not meet the condition: priority is 1/);
  assert.match(t.verdict.advice, /as it is now/);
});

test('an advanced condition script is shown as not run, not guessed', () => {
  const n = note({ advanced_condition: 'answer = current.priority == 1;' });
  const t = trace({ notification: n, events: [event()] });
  assert.equal(t.stages[0].status, 'unknown');
  assert.match(t.stages[0].headline, /advanced condition script.*not run/);
});

test('but an email that exists proves the script and the condition passed when it ran', () => {
  const n = note({ condition: 'priority=3^EQ', advanced_condition: 'answer = false;' });
  const t = trace({ notification: n, condition: { status: 'not_met', reason: 'priority is 1, wanted 3' }, events: [event()], emails: [email()] });
  assert.equal(t.stages[0].status, 'warn');
  assert.match(t.stages[0].headline, /did produce an email/);
  assert.equal(t.verdict.status, 'sent');
});

test('an event that was never fired is named, with the near miss and what was fired instead', () => {
  const t = trace({ events: [event({ name: 'incident.comented' }), event({ sys_id: id(0xe2), name: 'incident.assigned' })] });
  assert.equal(t.verdict.stage, 'event');
  assert.equal(t.verdict.code, 'event-missing');
  assert.match(t.verdict.headline, /incident\.commented was never queued/);
  assert.match(t.verdict.advice, /gs\.eventQueue\('incident\.commented'/);
  const details = stage(t, 'event').checks.map((c) => c.text).join(' ');
  assert.match(details, /nearly identical name.*incident\.comented/);
  assert.match(details, /incident\.assigned/);
});

test('no event on an old record may simply have been cleaned out, so it is not called a failure', () => {
  const t = traceNotification({ notification: note(), record: record({ updatedOn: ago(60 * 24 * 20) }), condition: MET, events: [], emails: [], recipients: expand(note()), now: NOW });
  assert.equal(stage(t, 'event').status, 'unknown');
  assert.match(stage(t, 'event').headline, /cleaned out after about 7 days/);
  assert.notEqual(t.verdict.status, 'blocked');
});

test('an unreadable event log is "cannot tell", never "never fired"', () => {
  const t = trace({ eventsError: 'Your user is not allowed to do this (403).' });
  assert.equal(stage(t, 'event').status, 'unknown');
  assert.match(stage(t, 'event').headline, /could not be read/);
});

test('an event stuck in ready, in error, and one still waiting', () => {
  const stuck = trace({ events: [event({ state: 'ready', processed: '', sys_created_on: ago(90) })] });
  assert.equal(stuck.verdict.code, 'event-stuck');
  assert.match(stuck.verdict.headline, /waiting in state "ready" for 2 h/);

  const failed = trace({ events: [event({ state: 'error' })] });
  assert.equal(failed.verdict.code, 'event-error');
  assert.match(failed.verdict.advice, /incident\.commented threw/);

  const waiting = trace({ events: [event({ state: 'ready', processed: '', sys_created_on: ago(1) })] });
  assert.equal(waiting.verdict.status, 'waiting');
  assert.equal(stage(waiting, 'created').status, 'skip');
});

test('processed but no email: the recipients decide the sentence', () => {
  // The only recipient caused the event.
  const creator = { userIds: [], userNames: ['abel.tuter'], source: 'event' };
  const n = note();
  const excluded = trace({ events: [event()], recipients: expand(n, { creator }) });
  assert.equal(excluded.verdict.stage, 'created');
  assert.equal(excluded.verdict.code, 'creator-excluded');
  assert.match(excluded.verdict.headline, /No email was created because everyone on the list is left out.*Abel Tuter.*Send to event creator/);
  assert.match(excluded.verdict.advice, /Send to event creator/);
  assert.equal(excluded.verdict.short, 'Event creator excluded');

  // Nobody is on the list.
  const nobody = trace({ events: [event()], recipients: expand(note({ recipient_fields: 'assigned_to' }), { fieldValues: { assigned_to: { value: '' } } }) });
  assert.equal(nobody.verdict.code, 'no-recipients');
  assert.match(nobody.verdict.headline, /assigned_to is empty on this record/);

  // Everyone has notifications disabled.
  const disabled = trace({ events: [event()], recipients: expand(note({ recipient_users: DAVID, recipient_fields: '' })) });
  assert.equal(disabled.verdict.code, 'all-blocked');
  assert.match(disabled.verdict.headline, /David Loo: Notifications are switched off on the user's profile/);
  assert.match(disabled.verdict.advice, /Notification to Enable|Mandatory/);
});

test('processed, recipients fine, still no email: the likely causes are listed and the script is named', () => {
  const t = trace({ notification: note({ advanced_condition: 'answer = false;' }), events: [event()] });
  assert.equal(t.verdict.stage, 'created');
  assert.equal(t.verdict.code, 'no-email');
  assert.match(t.verdict.advice, /advanced condition script returned false/);
  assert.match(t.verdict.advice, /condition was false at the moment/);
});

test('earlier events produced mail but the latest did not: the tracer says the notification works in general', () => {
  const earlier = email({ sys_created_on: ago(300) });
  const t = trace({ events: [event({ sys_created_on: ago(10) })], emails: [earlier], recipients: expand(note(), { creator: { userIds: [ABEL], userNames: [], source: 'event' } }) });
  assert.equal(t.verdict.stage, 'created');
  assert.match(stage(t, 'created').checks[0].text, /works in general/);
});

test('an email that was created but ignored, failed, or is stuck in the outbox', () => {
  const ignored = trace({ events: [event()], emails: [email({ type: 'send-ignored', state: 'ignored', error_string: 'All recipients are inactive' })] });
  assert.equal(ignored.verdict.code, 'email-ignored');
  assert.match(ignored.verdict.headline, /chose not to send it.*All recipients are inactive/);

  const failed = trace({ events: [event()], emails: [email({ type: 'send-failed', state: 'send-failed', error_string: '535 5.7.3 Authentication unsuccessful' })] });
  assert.equal(failed.verdict.code, 'email-failed');
  assert.match(failed.verdict.headline, /535 5\.7\.3 Authentication unsuccessful/);

  const stuck = trace({ events: [event({ sys_created_on: ago(300), processed: ago(299) })], emails: [email({ type: 'send-ready', state: 'ready', sys_created_on: ago(240) })] });
  assert.equal(stuck.verdict.code, 'email-stuck');
  assert.match(stuck.verdict.headline, /waiting to be sent for 4 h/);

  const fresh = trace({ events: [event()], emails: [email({ type: 'send-ready', state: 'ready', sys_created_on: ago(1) })] });
  assert.equal(fresh.verdict.status, 'waiting');
});

test('sending switched off is named at the step where mail piles up, and on every other failure', () => {
  const sw = readSwitches([{ name: 'glide.email.smtp.active', value: 'false' }]);
  const piled = trace({ switches: sw, events: [event()], emails: [email({ type: 'send-ignored', state: 'ignored' })] });
  assert.match(piled.verdict.headline, /Email sending is switched off on this instance/);
  const earlier = trace({ switches: sw, notification: note({ active: 'false' }) });
  assert.equal(earlier.verdict.stage, 'match');
  assert.match(earlier.verdict.headline, /also switched off on this instance/);
});

test('a test redirect makes "sent" a warning: the real recipients never got it', () => {
  const sw = readSwitches([{ name: 'glide.email.test.user', value: 'qa-inbox@acme.example' }]);
  const t = trace({ switches: sw, events: [event()], emails: [email()] });
  assert.equal(stage(t, 'sent').status, 'warn');
  assert.equal(t.verdict.status, 'warn');
  assert.match(t.verdict.headline, /redirects all mail to qa-inbox@acme.example/);
});

test('record-save notifications: insert-only after the record was made, update-only on a never-updated record', () => {
  const insertOnly = note({ generation_type: 'engine', event_name: '', action_insert: 'true', action_update: 'false', sys_created_on: ago(60) });
  const t1 = trace({ notification: insertOnly });
  assert.equal(t1.stages[0].status, 'fail');
  assert.match(t1.verdict.headline, /was created .* before the notification was/);
  assert.equal(stage(t1, 'event').status, 'na');
  assert.match(stage(t1, 'event').headline, /not from an event/);

  const updateOnly = note({ generation_type: 'engine', event_name: '', action_insert: 'false', action_update: 'true' });
  const t2 = traceNotification({ notification: updateOnly, record: record({ modCount: 0 }), condition: MET, recipients: expand(updateOnly), now: NOW });
  assert.match(t2.verdict.headline, /has not been updated since it was created/);

  const neither = note({ generation_type: 'engine', event_name: '', action_insert: 'false', action_update: 'false' });
  assert.match(trace({ notification: neither }).verdict.headline, /neither "Inserted" nor "Updated" is ticked/);
});

test('a record-save notification that sent is traced through without events', () => {
  const n = note({ generation_type: 'engine', event_name: '', action_insert: 'true', action_update: 'true' });
  const t = trace({ notification: n, emails: [email()] });
  assert.equal(t.verdict.status, 'sent');
  assert.deepEqual(t.stages.map((s) => s.status), ['ok', 'na', 'na', 'ok', 'ok']);
});

test('a triggered notification cannot be traced to its caller, and says so', () => {
  const n = note({ generation_type: 'triggered', event_name: '' });
  const t = trace({ notification: n });
  assert.equal(t.stages[0].status, 'unknown');
  assert.match(t.stages[0].headline, /flow, workflow or script asks for it by name/);
});

test('candidates sort: event-fired first, then condition-met, then the rest, inactive last', () => {
  const mk = (name, extra) => {
    const n = note({ sys_id: id(name.length * 7 + name.charCodeAt(0)), name, ...extra.note });
    return { notification: n, trace: trace({ notification: n, ...extra.trace }) };
  };
  const list = [
    mk('Zeta inactive', { note: { active: 'false' }, trace: {} }),
    mk('Beta never fired', { note: { event_name: 'incident.big' }, trace: { condition: MET } }),
    mk('Gamma condition fails', { note: { condition: 'priority=3' }, trace: { condition: { status: 'not_met', reason: 'priority is 1' } } }),
    mk('Alpha fired', { note: { event_name: 'incident.commented' }, trace: { events: [event()], emails: [] } }),
  ];
  const sorted = sortCandidates(list).map((c) => c.notification.name);
  assert.deepEqual(sorted, ['Alpha fired', 'Beta never fired', 'Gamma condition fails', 'Zeta inactive']);
});

// --- Email text preview -------------------------------------------------------------------------------------------

test('the preview is text: tags, scripts, styles and comments are removed, entities decoded', () => {
  const html = '<html><head><style>p{color:red}</style><title>x</title></head><body><!-- hidden --><p>Hello&nbsp;Abel,</p><p>Incident <b>INC0010042</b> has a new comment:</p><script>alert(1)</script><div>It&#39;s &lt;urgent&gt; &amp; open</div><a href="javascript:alert(2)" onclick="x()">link</a></body></html>';
  const { text, truncated } = emailPreviewText(html);
  assert.equal(truncated, false);
  assert.equal(text, "Hello Abel,\nIncident INC0010042 has a new comment:\nIt's <urgent> & open\nlink");
  assert.equal(/<script|alert|onclick|style|hidden/.test(text), false);
});

test('an unterminated script and a stray less-than sign are handled; long text is cut', () => {
  assert.equal(emailPreviewText('before <script>alert(1)').text, 'before');
  assert.equal(emailPreviewText('if a < b then c').text, 'if a < b then c');
  const long = emailPreviewText('x'.repeat(5000), { max: 100 });
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, 101);
});

test('mail that carries passwords or one-time codes is recognised so its body can stay hidden', () => {
  assert.equal(looksSecretMail('Your password has been reset'), true);
  assert.equal(looksSecretMail('Your verification code'), true);
  assert.equal(looksSecretMail('Incident INC0010042 was commented on'), false);
});

// --- Markdown -----------------------------------------------------------------------------------------------------

test('the Markdown summary has the verdict, the steps and the recipients, and no email addresses', () => {
  const creator = { userIds: [], userNames: ['abel.tuter'], source: 'event' };
  const n = note({ condition: 'priority=1^EQ' });
  const rec = expand(n, { creator });
  const t = trace({ notification: n, events: [event()], recipients: rec });
  const md = notifyToMarkdown({ subject: { table: 'incident', label: 'INC0010042' }, candidate: { notification: n, trace: t, recipients: rec }, switches: readSwitches([{ name: 'glide.email.smtp.active', value: 'false' }]), host: 'dev12345.service-now.com', checkedAt: NOW });
  assert.match(md, /^# Why wasn't the email sent\? INC0010042/);
  assert.match(md, /Record: incident INC0010042 on dev12345.service-now.com\. Checked 2026-10-23 12:00 UTC\./);
  assert.match(md, /## Incident commented/);
  assert.match(md, /\*\*Result: Stopped at "Email created":/);
  assert.match(md, /\| Event fired \| passed \|/);
  assert.match(md, /\| Email created \| STOPPED HERE \|/);
  assert.match(md, /- Abel Tuter: would NOT receive it\./);
  assert.match(md, /Email sending is switched off on this instance/);
  assert.equal(/@acme\.example/.test(md), false);
});

test('email addresses are masked in the Markdown but the domain stays', () => {
  const n = note();
  const rec = expand(n);
  const t = trace({ notification: n, events: [event()], emails: [email({ recipients: 'beth.anglin@acme.example, ops@partner.example' })] });
  assert.match(t.verdict.headline, /Sent to beth.anglin@acme.example, ops@partner.example/);
  const md = notifyToMarkdown({ subject: { table: 'incident', label: 'INC0010042' }, candidate: { notification: n, trace: t, recipients: rec }, checkedAt: NOW });
  assert.ok(md.includes('b***@acme.example'));
  assert.ok(md.includes('o***@partner.example'));
  assert.equal(md.includes('beth.anglin@'), false);
});

test('an error that already ends with a full stop does not get a second one', () => {
  const t = trace({ events: [event()], emails: [email({ type: 'send-ignored', state: 'ignored', error_string: 'Skipped by the outbound filter.' })] });
  assert.ok(t.verdict.headline.includes('It says: Skipped by the outbound filter.'));
  assert.equal(t.verdict.headline.includes('..'), false);
});

test('the Markdown for no selection says so', () => {
  assert.match(notifyToMarkdown({ subject: { table: 'incident' }, candidate: null }), /No notification was selected/);
});

// --- Review fixes: where a real instance answers differently from the fake one ---------------------------------------

// An email whose origin is unknown: no headers (not written yet) and no email log entry.
const noColumnEmail = (extra = {}) => normalizeEmail({ sys_id: id(0xf9), type: 'sent', state: 'sent', subject: 'Incident INC0010042 was commented on', recipients: 'beth.anglin@acme.example', sys_created_on: ago(8), instance: INC, target_table: 'incident', headers: '', ...extra });

test('an inbound reply on the record is never taken for an email the notification created', () => {
  const reply = noColumnEmail({ sys_id: id(0xfa), type: 'received', state: 'processed', subject: 'RE: Incident INC0010042 was commented on' });
  assert.equal(isInbound(reply), true);
  assert.equal(matchEmails(note(), [reply]).emails.length, 0);
  const t = trace({ events: [event()], emails: [reply], recipients: expand(note(), { creator: null }) });
  assert.notEqual(stage(t, 'created').status, 'ok', 'a reply is not "email created"');
  assert.notEqual(t.verdict.status, 'sent');
});

test('emails that name no notification (no header, no log entry) since the event make "no email was created" a cannot-tell', () => {
  const recipients = expand(note());
  // A mail script changed the subject, so the template does not match; the email exists all the same.
  const changed = noColumnEmail({ subject: 'INC0010042: new comment from Abel' });
  const t = trace({ events: [event()], emails: [changed], recipients });
  assert.equal(stage(t, 'created').status, 'unknown');
  assert.equal(stage(t, 'created').code, 'cannot-tie');
  assert.match(stage(t, 'created').headline, /1 other email was created for this record since the latest event/);
  assert.notEqual(t.verdict.status, 'blocked');

  // A subject that comes from an email template (empty here) cannot be matched at all.
  const templated = note({ subject: '' });
  const t2 = trace({ notification: templated, events: [event()], emails: [changed], recipients: expand(templated) });
  assert.equal(stage(t2, 'created').status, 'unknown');
  assert.match(stage(t2, 'created').headline, /subject is empty or only placeholders/);

  // No other email at all in the window: "none was created" still stands.
  const old = noColumnEmail({ subject: 'Something else', sys_created_on: ago(400) });
  const t3 = trace({ events: [event()], emails: [old], recipients });
  assert.equal(stage(t3, 'created').status, 'fail');
  assert.equal(t3.verdict.code, 'no-email');

  // An email whose header names another notification, or a script: its origin is known, so "none was created" stands.
  const t4 = trace({ events: [event()], emails: [email({ headers: hdr(id(0xc9)), subject: 'Other' }), email({ sys_id: id(0xf7), headers: 'X-ServiceNow-Source:Script' })], recipients });
  assert.equal(stage(t4, 'created').status, 'fail');
  // The same unknown email, once the email log names its notification, no longer leaves room for doubt.
  const logged = applyEmailLog([changed], [{ email: id(0xf9), event: id(0xe1), notification: id(0xc9) }]);
  assert.equal(stage(trace({ events: [event()], emails: logged, recipients }), 'created').status, 'fail');
});

test('a condition on a field the record does not have is "cannot tell", because the instance ignores that term', () => {
  assert.deepEqual(conditionFieldsMissing('u_vip=true^priority=1^caller_id.vip=true^EQ', { priority: '1', caller_id: ABEL }), ['u_vip']);
  assert.deepEqual(conditionFieldsMissing('priority=1^NQstate=2', { priority: '1', state: '2' }), []);
  const unknown = interpretCondition({ condition: 'u_vip=true^EQ', matched: true, missing: ['u_vip'] });
  assert.equal(unknown.status, 'unknown');
  assert.match(unknown.reason, /u_vip, which is not on this record/);
  // A "no" is still a no: the rest of the condition failed.
  assert.equal(interpretCondition({ condition: 'u_vip=true^priority=2^EQ', matched: false, missing: ['u_vip'] }).status, 'not_met');
});

test('a record-save notification whose only email is older than the latest save says so', () => {
  const n = note({ generation_type: 'engine', event_name: '', action_insert: 'true', action_update: 'true' });
  const t = trace({ notification: n, record: record({ updatedOn: ago(20) }), emails: [email({ sys_created_on: ago(300) })] });
  assert.equal(t.verdict.status, 'sent');
  assert.match(t.verdict.headline, /That email is from before the latest change to the record/);
  const fresh = trace({ notification: n, record: record({ updatedOn: ago(20) }), emails: [email({ sys_created_on: ago(20) })] });
  assert.equal(/before the latest change/.test(fresh.verdict.headline), false);
});

test('a group whose members were not read is never called empty, and the email step cannot tell', () => {
  const dir = buildDirectory({ groups: [normalizeGroup({ sys_id: SERVICE_DESK, name: 'Service Desk', active: 'true' })], unread: [SERVICE_DESK], devices: [] });
  const n = note({ recipient_groups: SERVICE_DESK, recipient_fields: '' });
  const rec = expandRecipients({ notification: n, directory: dir, fieldValues: {}, creator: null, parms: {} });
  assert.equal(rec.issues.some((i) => i.code === 'group-empty'), false);
  assert.ok(rec.issues.some((i) => i.code === 'members-unread'));
  assert.equal(recipientProblem(rec), '');
  const t = trace({ notification: n, events: [event()], recipients: rec });
  assert.equal(stage(t, 'created').status, 'unknown');
  assert.notEqual(t.verdict.status, 'blocked');
});

test('mail settings that are all hidden are an error, never "nothing unusual"', () => {
  assert.throws(() => switchRowsOrThrow([]), /none of the email properties are visible/);
  assert.throws(() => switchRowsOrThrow([{ name: 'glide.ui.something', value: 'x' }]), /not visible|none of the email properties/);
  assert.equal(switchRowsOrThrow([{ name: 'glide.email.smtp.active', value: 'true' }]).length, 1);
});

test('the Markdown names the steps a record-save notification does not use', () => {
  const n = note({ generation_type: 'engine', event_name: '', action_insert: 'true' });
  const t = trace({ notification: n, emails: [email()] });
  const md = notifyToMarkdown({ subject: { table: 'incident', label: 'INC0010042' }, candidate: { notification: n, trace: t, recipients: expand(n) }, checkedAt: NOW });
  assert.match(md, /\| Event fired \| not used \|/);
  assert.equal(md.includes('undefined'), false);
});

// --- The whole read, against the preview fixture ---------------------------------------------------------------------
// src/content/notifyTrace.js runs end to end with fetch answered by preview/fixtures/notify.js (plus the record and its
// table hierarchy, which the base fake instance answers in the preview).

function fnv(textIn, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < textIn.length; i += 1) {
    h ^= textIn.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
const sid = (key) => [0x811c9dc5, 0x2f1a3b4c, 0x9e3779b9, 0x7f4a7c15].map((s) => fnv(key, s)).join('');
const FIXTURE_INC = '9de5069c0b0f0300b8b9e5cd35673a5b';

const notifyWithContext = (context, mailFlag) => notifyWith(mailFlag, context);

async function notifyWith(mailFlag, context = { table: 'incident', sysId: FIXTURE_INC }) {
  const fixture = require('../preview/fixtures/notify.js');
  const { loadNotifyReport } = require('../src/content/notifyTrace.js');
  const real = { fetch: global.fetch, document: global.document, location: global.location };
  const requests = [];
  const minutes = (m) => new Date(Date.now() - m * 60000).toISOString().replace('T', ' ').slice(0, 19);
  const values = {
    sys_id: FIXTURE_INC,
    number: 'INC0010042',
    short_description: 'Laptop will not boot',
    priority: '1',
    state: '2',
    active: 'true',
    assigned_to: String(),
    caller_id: sid('sys_user:abel.tuter'),
    opened_by: sid('sys_user:abel.tuter'),
    sys_created_on: minutes(400),
    sys_updated_on: minutes(20),
    sys_updated_by: 'abel.tuter',
    sys_mod_count: '5',
  };
  const json = (result) => new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  global.document = { querySelector: (s) => (s.includes('sysparm_ck') ? { value: 'test-token' } : null), getElementById: () => null, scripts: [], addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };
  global.location = { search: mailFlag ? `?mail=${mailFlag}` : String(), hostname: 'dev12345.service-now.com', host: 'dev12345.service-now.com' };
  global.fetch = async (path) => {
    const url = new URL(path, 'https://dev12345.service-now.com');
    const table = url.pathname.split('/').pop();
    const query = url.searchParams.get('sysparm_query') || String();
    requests.push({ table, query });
    const answered = fixture.route('GET', url, null);
    if (answered) return answered;
    if (table === 'sys_db_object') return json([{ 'super_class.name': query === 'name=incident' ? 'task' : String() }]);
    if (table === 'incident' && query === `sys_id=${FIXTURE_INC}`) {
      return json([Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, display_value: v }]))]);
    }
    if (table === 'incident' && query.startsWith(`sys_id=${FIXTURE_INC}^`)) {
      // "Does the record meet this condition?": every term is judged on the values above.
      const ok = query
        .split('^')
        .slice(1)
        .filter((t) => t && t !== 'EQ')
        .every((t) => {
          const m = /^([a-z_]+)(ISNOTEMPTY|ISEMPTY|=)(.*)$/.exec(t);
          if (!m) return true;
          const v = values[m[1]] ?? String();
          if (m[2] === '=') return v === m[3];
          return m[2] === 'ISEMPTY' ? !v : Boolean(v);
        });
      return json(ok ? [{ sys_id: FIXTURE_INC }] : []);
    }
    return json([]);
  };
  try {
    const report = await loadNotifyReport({ context });
    return { report, requests };
  } finally {
    global.fetch = real.fetch;
    global.document = real.document;
    global.location = real.location;
  }
}

test('end to end: the fixture incident names the right first broken link for each notification', async () => {
  const { report } = await notifyWith(String());
  const byName = Object.fromEntries(report.candidates.map((c) => [c.notification.name, c.trace.verdict]));
  assert.equal(byName['Incident opened'].status, 'sent');
  assert.equal(byName['Incident commented'].code, 'creator-excluded');
  assert.equal(byName['Major incident declared'].code, 'event-missing');
  assert.equal(byName['P1 escalation to managers'].code, 'email-ignored');
  assert.equal(byName['Incident update for watchers'].code, 'email-stuck');
  assert.equal(report.sections.events.ok, true);
  assert.equal(report.sections.switches.ok, true);
  assert.equal(report.sections.emailLog.ok, true);
  // Every email is tied exactly: the opened one by its header, the waiting one (no headers yet) by the email log.
  const how = Object.fromEntries(report.emails.map((e) => [e.subject, e.linkBy]));
  assert.equal(how['Incident INC0010042 has been opened'], 'header');
  assert.equal(how['Update on INC0010042'], 'log');
  assert.equal(report.emailsUnlinked, 0);
  const watchers = report.candidates.find((c) => c.notification.name === 'Incident update for watchers');
  assert.equal(watchers.trace.emailsBy, 'link');
  // The script's reminder names no notification and is left among the other emails, not matched by subject.
  assert.deepEqual(report.unmatchedEmails.map((e) => e.subject), ['Your request INC0010042 needs attention']);
});

test('end to end: an email log that cannot be read leaves the header link working and says so', async () => {
  const { report } = await notifyWith('nolog');
  assert.equal(report.sections.emailLog.ok, false);
  assert.match(report.notes.join(' '), /email log \(sys_email_log\) could not be read/);
  const byName = Object.fromEntries(report.candidates.map((c) => [c.notification.name, c.trace]));
  assert.equal(byName['P1 escalation to managers'].verdict.code, 'email-ignored', 'tied by its header');
  assert.equal(byName['Incident update for watchers'].emailsBy, 'subject', 'no headers and no log: the subject is the fallback');
  assert.equal(report.emailsUnlinked, 1);
});

test('end to end: an email page names its event from the email log', async () => {
  const fixtureIds = { p1: sid('sys_email:p1') };
  const { report } = await notifyWithContext({ table: 'sys_email', sysId: fixtureIds.p1 });
  assert.equal(report.mode, 'email');
  assert.equal(report.selectedId, sid('sysevent_email_action:p1_escalation'));
  assert.match(report.trigger.text, /Triggered by the event incident\.p1_escalation.*named in the email log/);
});

test('end to end: a user who cannot see events, emails or properties gets "cannot tell", never "never fired"', async () => {
  const { report, requests } = await notifyWith('acl');
  assert.equal(report.sections.events.ok, false);
  assert.match(report.sections.events.error, /sees no rows of sysevent at all/);
  const major0 = report.candidates.find((c) => c.notification.name === 'Major incident declared');
  assert.match(major0.trace.verdict.summary, /whether the event fired cannot be checked/, 'the reason is not cut off in the verdict');
  assert.equal(report.sections.emails.ok, false);
  assert.equal(report.sections.switches.ok, false);
  report.candidates.forEach((c) => {
    assert.ok(!['event-missing', 'no-email', 'no-recipients'].includes(c.trace.verdict.code), `${c.notification.name}: ${c.trace.verdict.code}`);
  });
  const major = report.candidates.find((c) => c.notification.name === 'Major incident declared');
  assert.equal(major.trace.stages.find((s) => s.id === 'event').status, 'unknown');
  // One unfiltered one-row read per hidden table, no more.
  assert.equal(requests.filter((r) => r.table === 'sysevent' && !r.query).length, 1);
  assert.equal(requests.filter((r) => r.table === 'sys_email' && !r.query).length, 1);
});

