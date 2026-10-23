// Dev-only (not shipped): fake instance answers for the "Why wasn't the email sent?" panel (preview/fixtures/index.js).
// The fake incident INC0010042 (priority 1, state In Progress, caller Abel Tuter, nobody assigned, saved by abel.tuter)
// has eight notifications that could fire, one for each way the chain breaks:
//   Incident opened             record-save, sent
//   Incident commented          event fired and processed, but the only recipient is the person who fired it
//   Incident assigned to me     condition fails (nobody is assigned)
//   Major incident declared     event never fired (a misspelled one was)
//   P1 escalation to managers   email created, then ignored by the instance
//   Incident update for watchers  email stuck in the outbox
//   Incident closed (legacy)    on the parent table task, inactive
//   Incident watchers digest     triggered by a flow, so the tracer cannot see its caller
// URL flags: ?mail=off (sending switched off, sub-production), ?mail=test (all mail redirected to a test inbox),
// ?mail=acl (a non-admin: sysevent, sys_email, sys_email_log and sys_properties answer with no rows at all, as an ACL does),
// ?mail=nolog (sys_email_log answers 403: emails are tied by their header only).
// Answers only the tables below, for queries about this data; everything else returns null (the base fake instance answers).

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The same ids the base fake instance derives (preview/fakeInstance.js `sid`), copied here to avoid a circular import.
function fnv(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
const sid = (key) => [0x811c9dc5, 0x2f1a3b4c, 0x9e3779b9, 0x7f4a7c15].map((s) => fnv(key, s)).join('');

const NOW = Date.now();
const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const minutesAgo = (m) => fmt(NOW - m * 60000);
const INCIDENT_ID = '9de5069c0b0f0300b8b9e5cd35673a5b';

const user = (k) => sid(`sys_user:${k}`);
const group = (k) => sid(`sys_user_group:${k}`);
const notif = (k) => sid(`sysevent_email_action:${k}`);
const mail = (k) => sid(`sys_email:${k}`);

/* ---------------------------------------------------------------- data */

const USERS = [
  ['maria.dev', 'Maria Gomez', 'maria.dev@acme.example', 'true', 'false', '2'],
  ['abel.tuter', 'Abel Tuter', 'abel.tuter@acme.example', 'true', 'false', '2'],
  ['beth.anglin', 'Beth Anglin', 'beth.anglin@acme.example', 'true', 'false', '2'],
  ['fred.luddy', 'Fred Luddy', 'fred.luddy@acme.example', 'false', 'true', '2'],
  ['david.loo', 'David Loo', 'david.loo@acme.example', 'true', 'false', '1'],
  ['bow.ruggeri', 'Bow Ruggeri', '', 'true', 'false', '2'],
].map(([userName, name, email, active, lockedOut, notification]) => ({ sys_id: user(userName), user_name: userName, name, email, active, locked_out: lockedOut, notification }));

const GROUPS = [
  { sys_id: group('Service Desk'), name: 'Service Desk', active: 'true', email: '', include_members: 'true' },
  { sys_id: group('Incident Managers'), name: 'Incident Managers', active: 'true', email: '', include_members: 'true' },
];
const MEMBERS = [
  ['Incident Managers', 'bow.ruggeri'],
  ['Incident Managers', 'fred.luddy'],
  ['Incident Managers', 'david.loo'],
  ['Incident Managers', 'beth.anglin'],
  ['Service Desk', 'beth.anglin'],
  ['Service Desk', 'maria.dev'],
].map(([g, u]) => ({ sys_id: sid(`sys_user_grmember:${g}:${u}`), group: group(g), user: user(u) }));
const DEVICES = USERS.filter((u) => u.email).map((u) => ({ sys_id: sid(`cmn_notif_device:${u.user_name}`), user: u.sys_id, type: 'Email', active: 'true', email_address: u.email, name: 'Primary email' }));

const NOTIFICATION_DEFAULTS = {
  active: 'true', generation_type: 'event', event_name: '', action_insert: 'false', action_update: 'false', condition: '', advanced_condition: '', recipient_users: '', recipient_groups: '',
  recipient_fields: '', event_parm_1: 'false', event_parm_2: 'false', send_self: 'false', force_delivery: 'false', subject: '', sys_created_on: minutesAgo(60 * 24 * 120), sys_updated_on: minutesAgo(60 * 24 * 30), sys_updated_by: 'admin',
};
const NOTIFICATIONS = [
  { key: 'opened', name: 'Incident opened', collection: 'incident', generation_type: 'engine', action_insert: 'true', condition: 'active=true^EQ', recipient_fields: 'caller_id', send_self: 'true', subject: 'Incident ${number} has been opened' },
  { key: 'commented', name: 'Incident commented', collection: 'incident', event_name: 'incident.commented', recipient_fields: 'caller_id,assigned_to', subject: 'Incident ${number} was commented on' },
  { key: 'assigned', name: 'Incident assigned to me', collection: 'incident', event_name: 'incident.assigned', condition: 'assigned_toISNOTEMPTY^EQ', recipient_fields: 'assigned_to', subject: 'Incident ${number} has been assigned to you' },
  { key: 'major', name: 'Major incident declared', collection: 'incident', event_name: 'incident.major_declared', condition: 'priority=1^EQ', recipient_groups: group('Incident Managers'), subject: 'MAJOR: ${number} ${short_description}' },
  { key: 'p1_escalation', name: 'P1 escalation to managers', collection: 'incident', event_name: 'incident.p1_escalation', condition: 'priority=1^EQ', recipient_groups: group('Incident Managers'), subject: 'P1 escalation: ${number} ${short_description}' },
  { key: 'watchers', name: 'Incident update for watchers', collection: 'incident', event_name: 'incident.updated_watchers', recipient_users: user('beth.anglin'), recipient_fields: 'caller_id', send_self: 'true', subject: 'Update on ${number}' },
  { key: 'closed_legacy', name: 'Incident closed (legacy)', collection: 'task', active: 'false', event_name: 'task.closed', recipient_fields: 'opened_by', subject: 'Task ${number} was closed' },
  { key: 'digest', name: 'Incident watchers digest', collection: 'incident', generation_type: 'triggered', recipient_users: user('beth.anglin'), subject: 'Daily digest of your incidents' },
].map((n) => ({ ...NOTIFICATION_DEFAULTS, ...n, sys_id: notif(n.key) }));
const NOTIFICATION_NAME = Object.fromEntries(NOTIFICATIONS.map((n) => [n.sys_id, n.name]));

const EVENTS = [
  { key: 'e1', name: 'incident.commented', state: 'processed', created: 25, processed: 24, user: 'abel.tuter' },
  { key: 'e2', name: 'incident.p1_escalation', state: 'processed', created: 180, processed: 179, user: 'maria.dev' },
  { key: 'e3', name: 'incident.updated_watchers', state: 'processed', created: 200, processed: 199, user: 'maria.dev' },
  { key: 'e4', name: 'incident.major_declare', state: 'processed', created: 15, processed: 14, user: 'maria.dev' },
  { key: 'e5', name: 'incident.commented', state: 'processed', created: 60 * 5, processed: 60 * 5 - 1, user: 'beth.anglin' },
].map((e) => ({
  sys_id: sid(`sysevent:${e.key}`), name: e.name, state: e.state, table: 'incident', instance: INCIDENT_ID, parm1: '', parm2: '', queue: 'default', sys_created_on: minutesAgo(e.created), processed: minutesAgo(e.processed),
  process_on: minutesAgo(e.created), claimed_by: 'app123.example:node2', user_id: user(e.user), user_name: e.user,
}));

const OPENED_BODY =
  '<html><head><style>.x{color:red}</style></head><body><p>Hello Abel,</p><p>Incident <b>INC0010042</b> &quot;Laptop will not boot&quot; has been opened and assigned to the Service Desk.</p>' +
  '<script>document.location="http://evil.example"</script><p><a href="javascript:alert(1)">Open the incident</a></p><div>Priority: 1 - Critical &amp; urgent</div></body></html>';
// As on a real instance (checked live 2026-10-23): sys_email has no notification column; the notification is named in the
// first header line "X-ServiceNow-Source:Notification-<sys_id>", and sys_email_log ties email, event and notification.
// `source` is that header's notification (null: an email from a script, whose header names no notification; '' headers:
// an email still waiting to be sent, whose headers are not written yet, so only the email log names its notification).
const headersFor = (source) => (source === undefined ? '' : `X-ServiceNow-Source:${source ? `Notification-${source}` : 'Script'}\r\nX-ServiceNow-SysEmail-Version:2\r\nContent-Type:multipart/mixed`);
const EMAILS = [
  { key: 'opened', type: 'sent', state: 'sent', subject: 'Incident INC0010042 has been opened', recipients: 'abel.tuter@acme.example', source: notif('opened'), created: 300, body: OPENED_BODY, body_text: '' },
  { key: 'p1', type: 'send-ignored', state: 'ignored', subject: 'P1 escalation: INC0010042 Laptop will not boot', recipients: 'beth.anglin@acme.example', source: notif('p1_escalation'), created: 179, error_string: 'Skipped by the outbound email filter "Block external domains on non-production".', body: '', body_text: 'P1 escalation for INC0010042.\nLaptop will not boot.' },
  { key: 'watchers', type: 'send-ready', state: 'ready', subject: 'Update on INC0010042', recipients: 'beth.anglin@acme.example,abel.tuter@acme.example', source: undefined, created: 199, body: '', body_text: 'The incident was updated.' },
  { key: 'reminder', type: 'sent', state: 'sent', subject: 'Your request INC0010042 needs attention', recipients: 'abel.tuter@acme.example', source: null, created: 600, body: '', body_text: 'Please add more detail.' },
].map((e) => ({ sys_id: mail(e.key), type: e.type, state: e.state, subject: e.subject, recipients: e.recipients, copied: '', blind_copied: '', error_string: e.error_string || '', sys_created_on: minutesAgo(e.created), sys_updated_on: minutesAgo(e.created - 1), instance: INCIDENT_ID, target_table: 'incident', headers: headersFor(e.source), notification_type: 'SMTP', body: e.body, body_text: e.body_text }));

// sys_email_log: the platform's own email -> event -> notification log (the opened email has no entry, so its header decides).
const EMAIL_LOG = [
  { email: mail('p1'), event: sid('sysevent:e2'), notification: notif('p1_escalation'), created: 179 },
  { email: mail('watchers'), event: sid('sysevent:e3'), notification: notif('watchers'), created: 199 },
].map((r) => ({ sys_id: sid(`sys_email_log:${r.email}`), email: r.email, event: r.event, notification: r.notification, sys_created_on: minutesAgo(r.created) }));

const mode = () => new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('mail') || '';
function properties() {
  const flag = mode();
  const rows = [{ name: 'glide.email.smtp.active', value: flag === 'off' ? 'false' : 'true', type: 'boolean' }, { name: 'glide.email.default.sender', value: 'noreply@acme.example', type: 'string' }];
  if (flag === 'test') rows.push({ name: 'glide.email.test.user', value: 'qa-inbox@acme.example', type: 'string' });
  if (flag === 'off') rows.push({ name: 'glide.installation.production', value: 'false', type: 'boolean' });
  return rows;
}

/* ---------------------------------------------------------------- tiny query engine */

const TABLES = {
  sysevent_email_action: { rows: () => NOTIFICATIONS, columns: Object.keys(NOTIFICATION_DEFAULTS).concat(['sys_id', 'name', 'collection']) },
  sysevent: { rows: () => EVENTS, columns: ['sys_id', 'name', 'state', 'table', 'instance', 'parm1', 'parm2', 'queue', 'sys_created_on', 'processed', 'process_on', 'claimed_by', 'user_id', 'user_name'] },
  sys_email: { rows: () => EMAILS, columns: ['sys_id', 'type', 'state', 'subject', 'recipients', 'copied', 'blind_copied', 'error_string', 'sys_created_on', 'sys_updated_on', 'instance', 'target_table', 'headers', 'notification_type', 'body', 'body_text'] },
  sys_email_log: { rows: () => EMAIL_LOG, columns: ['sys_id', 'email', 'event', 'notification', 'sys_created_on'] },
  sys_properties: { rows: properties, columns: ['name', 'value', 'type'] },
  sys_user: { rows: () => USERS, columns: ['sys_id', 'user_name', 'name', 'email', 'active', 'locked_out', 'notification'] },
  sys_user_group: { rows: () => GROUPS, columns: ['sys_id', 'name', 'active', 'email', 'include_members'] },
  sys_user_grmember: { rows: () => MEMBERS, columns: ['sys_id', 'group', 'user'] },
  cmn_notif_device: { rows: () => DEVICES, columns: ['sys_id', 'user', 'type', 'active', 'email_address', 'name'] },
};

const TOKEN = /^([a-z_][a-z0-9_.]*?)(!=|=|IN|LIKE|STARTSWITH|ISEMPTY|ISNOTEMPTY)(.*)$/;

function matches(row, columns, token) {
  const m = TOKEN.exec(token);
  if (!m) return true;
  const [, field, op, raw] = m;
  if (!columns.includes(field)) return true; // ServiceNow silently ignores a condition on a column it does not know
  const v = String(row[field] ?? '');
  switch (op) {
    case '=': return v === raw;
    case '!=': return v !== raw;
    case 'IN': return raw.split(',').includes(v);
    case 'LIKE': return v.toLowerCase().includes(raw.toLowerCase());
    case 'STARTSWITH': return v.toLowerCase().startsWith(raw.toLowerCase());
    case 'ISEMPTY': return v === '';
    case 'ISNOTEMPTY': return v !== '';
    default: return true;
  }
}

function select(def, query) {
  const tokens = String(query || '').split('^').filter(Boolean);
  let rows = def.rows().filter((row) => tokens.filter((t) => !t.startsWith('ORDERBY') && t !== 'EQ').every((t) => matches(row, def.columns, t)));
  const order = tokens.find((t) => t.startsWith('ORDERBY'));
  if (order) {
    const desc = order.startsWith('ORDERBYDESC');
    const field = order.slice(desc ? 11 : 7);
    rows = [...rows].sort((a, b) => (String(a[field] ?? '') < String(b[field] ?? '') ? -1 : 1) * (desc ? -1 : 1));
  }
  return rows;
}

const CHOICE = { notification: { 1: 'Disable', 2: 'Enable' } };
function displayOf(table, field, value) {
  if (table === 'sys_user' && field === 'notification') return CHOICE.notification[value] || value;
  if (table === 'sys_email_log' && field === 'notification') return NOTIFICATION_NAME[value] || value;
  return value;
}

function project(table, def, row, fields, displayMode) {
  const wanted = fields.length ? fields : def.columns;
  const out = {};
  wanted.forEach((f) => {
    if (!def.columns.includes(f)) return; // unknown columns are left out, as the Table API does
    const value = String(row[f] ?? '');
    out[f] = displayMode === 'all' ? { value, display_value: displayOf(table, f, value) } : value;
  });
  return out;
}

/** True when the request is this feature's, so another feature's queries on the same tables fall through to the base fake. */
function ownsQuery(table, query, fields) {
  const q = decodeURIComponent(query || '');
  const day = '\\^ORDERBYDESCsys_created_on$';
  if (table === 'sysevent_email_action') return true;
  // q === '': "can this user see any row at all?" (one sys_id, no filter).
  if (table === 'sysevent') return new RegExp(`^(instance=${INCIDENT_ID}|name=[A-Za-z0-9_.]+)${day}`).test(q) || EVENTS.some((e) => q === `sys_id=${e.sys_id}`) || q === '';
  if (table === 'sys_email') return new RegExp(`^(instance=${INCIDENT_ID}${day}|sys_idIN[0-9a-f,]+${day}|target_table=incident${day})`).test(q) || q === 'ORDERBYDESCsys_created_on' || q === '' || EMAILS.some((e) => q === `sys_id=${e.sys_id}`);
  if (table === 'sys_email_log') return /^emailIN[0-9a-f,]+$/.test(q) || new RegExp(`^notification=[0-9a-f]{32}${day}`).test(q);
  if (table === 'sys_properties') return /glide\.email/.test(q);
  if (table === 'sys_user') return fields.includes('notification') || /^emailIN/.test(q);
  if (table === 'sys_user_group') return fields.includes('include_members');
  if (table === 'sys_user_grmember') return GROUPS.some((g) => q === `group=${g.sys_id}`);
  if (table === 'cmn_notif_device') return true;
  return false;
}

export function route(method, u) {
  if (method !== 'GET') return null;
  const m = /^\/api\/now\/table\/([^/]+)$/.exec(u.pathname);
  if (!m) return null;
  const table = decodeURIComponent(m[1]);
  const def = TABLES[table];
  const query = u.searchParams.get('sysparm_query') || '';
  const fields = (u.searchParams.get('sysparm_fields') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!def || !ownsQuery(table, query, fields)) return null;
  const displayMode = u.searchParams.get('sysparm_display_value') || 'false';
  const limit = Number(u.searchParams.get('sysparm_limit') || 100);
  // An ACL hides rows without an error: the Table API answers 200 with an empty list.
  if (mode() === 'acl' && ['sysevent', 'sys_email', 'sys_email_log', 'sys_properties'].includes(table)) return json({ result: [] });
  if (mode() === 'nolog' && table === 'sys_email_log') return json({ error: { message: 'User Not Authorized', detail: null }, status: 'failure' }, 403);
  const rows = select(def, query).slice(0, limit);
  return json({ result: rows.map((r) => project(table, def, r, fields, displayMode)) });
}
