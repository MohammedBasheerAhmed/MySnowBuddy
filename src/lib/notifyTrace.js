// "Why wasn't the email sent?", the pure half. A notification reaches an inbox through a chain: the notification matches
// the record -> an event is fired -> the event is processed -> an email is generated for the recipients -> the email is
// sent. This module takes what the instance said about each link (notifications, events, emails, users, groups,
// properties) and names the FIRST broken link in plain words. The instance reads are in src/content/notifyTrace.js;
// the panel is src/sidebar/NotifyPanel.jsx; every table and column assumed is in docs/features/notify.md and
// src/lib/requirements/notify.js.
//
// Honesty rules, because a wrong "this is why" costs more than "cannot tell":
//   * Evidence beats inference. An email that exists proves the notification matched and its event ran, whatever the
//     record looks like now.
//   * A script (advanced condition) is never run. It is shown and reported as "not run here".
//   * A condition is judged against the record as it is NOW. That is stated whenever it decides the verdict.
//   * A table or column that could not be read is "could not check", never "nothing found".

import { evaluateQuery } from './ruleExplain.js';
import { parseEncodedQuery } from './query.js';

export const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const FIELD_RE = /^[a-z0-9_.]+$/i;

/** An event still "ready" this long after it was queued is not being processed. */
export const STUCK_EVENT_MINUTES = 30;
/** An email still "send-ready" this long after it was created is not being picked up by the sender. */
export const STUCK_EMAIL_MINUTES = 15;
/** Processed events are cleaned out of the queue after about this many days by default. */
export const EVENT_RETENTION_DAYS = 7;

export const STAGES = [
  { id: 'match', label: 'Matched' },
  { id: 'event', label: 'Event fired' },
  { id: 'processed', label: 'Event processed' },
  { id: 'created', label: 'Email created' },
  { id: 'sent', label: 'Email sent' },
];
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.id, s.label]));

/** Words for a stage status (shown next to the colour, so colour is never the only signal). */
export const STATUS_WORDS = { ok: 'Passed', fail: 'Stopped here', warn: 'Check this', wait: 'Waiting', unknown: 'Cannot tell', skip: 'Not reached', na: 'Not used' };

// --- Small helpers -------------------------------------------------------------------------------------

const text = (v) => (v === undefined || v === null ? '' : String(v));
const bool = (v) => v === true || v === 'true' || v === '1' || v === 1;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

export function clip(value, max = 80) {
  const s = text(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Table API cell(s) -> { values, display }. A cell is a plain string, or { value, display_value } (display_value=all). */
export function flatRow(row = {}) {
  const values = {};
  const display = {};
  Object.entries(row || {}).forEach(([key, cell]) => {
    if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
      values[key] = text(cell.value);
      if (cell.display_value !== undefined && text(cell.display_value) !== text(cell.value)) display[key] = text(cell.display_value);
    } else {
      values[key] = text(cell);
    }
  });
  return { values, display };
}

/** ServiceNow date-times from the Table API are UTC "YYYY-MM-DD HH:MM:SS". Returns epoch ms or null. */
export function parseSnTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text(value).trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
}

export function minutesSince(value, now) {
  const t = parseSnTime(value);
  return t === null ? null : Math.max(0, Math.round((now - t) / 60000));
}

/** "just now", "5 min", "3 h", "2 days". */
export function agoText(minutes) {
  if (minutes === null || minutes === undefined) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
}

/** "2026-10-23 09:14 UTC" (the instance's own clock is UTC in the Table API), or '' when unknown. */
export function whenText(value) {
  const t = parseSnTime(value);
  return t === null ? '' : `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const splitList = (value) =>
  text(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const idsOf = (value) => splitList(value).filter((s) => SYS_ID_RE.test(s));

// --- Notifications -------------------------------------------------------------------------------------

/**
 * A sysevent_email_action row (values) and its display values, in the shape the tracer uses.
 * kind: 'event' (fires on an event), 'engine' (fires when a record is inserted or updated), 'triggered' (a flow, workflow
 * or script asks for it).
 */
export function normalizeNotification(row = {}, display = {}) {
  const raw = (k) => text(row[k]);
  const eventRaw = raw('event_name').trim();
  // event_name is a plain string on most releases; when it is a reference the display value holds the name.
  const eventName = SYS_ID_RE.test(eventRaw) ? text(display.event_name).trim() : eventRaw;
  const onInsert = bool(row.action_insert);
  const onUpdate = bool(row.action_update);
  const generation = raw('generation_type').trim().toLowerCase();
  let kind = ['engine', 'event', 'triggered'].includes(generation) ? generation : '';
  if (!kind) kind = eventName ? 'event' : onInsert || onUpdate ? 'engine' : 'triggered';
  const script = raw('advanced_condition');
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '').trim();
  return {
    sysId: raw('sys_id'),
    name: raw('name').trim() || '(unnamed notification)',
    table: raw('collection').trim(),
    active: row.active === undefined ? true : bool(row.active),
    kind,
    eventName,
    onInsert,
    onUpdate,
    condition: raw('condition').trim(),
    advancedCondition: code ? script : '',
    recipientUsers: idsOf(raw('recipient_users')),
    recipientGroups: idsOf(raw('recipient_groups')),
    recipientFields: splitList(raw('recipient_fields')).filter((f) => FIELD_RE.test(f)),
    eventParm1: bool(row.event_parm_1),
    eventParm2: bool(row.event_parm_2),
    sendSelf: bool(row.send_self),
    mandatory: bool(row.force_delivery),
    subject: raw('subject'),
    createdOn: raw('sys_created_on'),
    updatedOn: raw('sys_updated_on'),
    updatedBy: raw('sys_updated_by'),
  };
}

/** "when the event incident.commented is queued", "when a record is inserted or updated", ... */
export function triggerText(n) {
  if (n.kind === 'event') return n.eventName ? `when the event ${n.eventName} is queued` : 'when an event is queued (none chosen)';
  if (n.kind === 'engine') {
    const ops = [n.onInsert && 'inserted', n.onUpdate && 'updated'].filter(Boolean);
    return ops.length ? `when a record is ${ops.join(' or ')}` : 'when a record is inserted or updated (neither is ticked)';
  }
  return 'only when a flow, workflow or script triggers it';
}

// --- The condition -------------------------------------------------------------------------------------

const CHANGE_OPS = /VALCHANGES|CHANGESFROM|CHANGESTO/;
const DYNAMIC_VALUE = /javascript:|DYNAMIC/i;

/**
 * The encoded query that asks the instance "does THIS record meet the notification's condition?": the record's
 * sys_id in front of every ^NQ group, so an OR of groups cannot match other rows. Returns '' when there is no condition.
 */
export function conditionQuery(sysId, condition) {
  if (!SYS_ID_RE.test(text(sysId))) throw new Error('A record sys_id is needed to check a condition.');
  const groups = text(condition)
    .split('^NQ')
    .map((g) => g.replace(/\^EQ$/, '').replace(/^\^+|\^+$/g, '').trim())
    .filter(Boolean);
  if (!groups.length) return '';
  return groups.map((g) => `sys_id=${sysId}^${g}`).join('^NQ');
}

/** Can the instance answer this condition for a stored record, or does it depend on the moment of the save? */
export function conditionCheckable(condition) {
  const c = text(condition);
  if (!c.trim()) return { checkable: false, why: '' };
  if (CHANGE_OPS.test(c)) return { checkable: false, why: 'the condition looks at what changed in the save (has changed / changes to / changes from), which can only be judged at the moment of the save' };
  if (DYNAMIC_VALUE.test(c)) return { checkable: false, why: 'the condition uses a dynamic value that depends on who is signed in' };
  return { checkable: true, why: '' };
}

/**
 * Fields a condition uses that are not on the record as it was read (no such field, or the user cannot read it). The
 * Table API drops a query term on a field it does not know, so for these its "the record matches" proves nothing.
 * Only the first part of a dot-walk is checked (caller_id.vip needs caller_id).
 */
export function conditionFieldsMissing(condition, values = {}) {
  const missing = new Set();
  parseEncodedQuery(text(condition)).groups.flat().forEach((c) => {
    const root = text(c.field).split('.')[0];
    if (root && FIELD_RE.test(root) && !(root in values)) missing.add(root);
  });
  return [...missing];
}

/**
 * Combine the instance's answer with a local reading of the condition.
 * @param {{ condition: string, matched: boolean|null, error?: string, local?: object|null, missing?: string[] }} args
 *   matched: did the Table API return the record for `sys_id=<id>^<condition>`? null = not asked or it failed.
 *   local: evaluateQuery() result for the same condition against the record's values (used for the reason text).
 *   missing: fields the condition uses that the record read did not have (conditionFieldsMissing).
 * @returns {{ status: 'none'|'met'|'not_met'|'unknown', reason: string, how: 'instance'|'local'|'none' }}
 */
export function interpretCondition({ condition, matched = null, error = '', local = null, missing = [] }) {
  const c = text(condition).trim();
  if (!c) return { status: 'none', reason: 'there is no condition', how: 'none' };
  const checkable = conditionCheckable(c);
  if (!checkable.checkable) return { status: 'unknown', reason: checkable.why, how: 'none' };
  if (matched === true && missing.length) {
    const list = missing.slice(0, 3).join(', ');
    return {
      status: 'unknown',
      reason: `it uses ${list}, which ${missing.length === 1 ? 'is' : 'are'} not on this record as your account reads it (no such field, or you cannot read it). The instance ignores a query term on a field it does not know, so its "yes" proves nothing`,
      how: 'none',
    };
  }
  if (matched === true) {
    const passed = local && local.result === 'true' && local.passed?.length ? local.passed.slice(0, 3).join('; ') : '';
    return { status: 'met', reason: passed || 'the record matches it', how: 'instance' };
  }
  if (matched === false) {
    const failure = local && local.result === 'false' && local.failure ? local.failure : '';
    return { status: 'not_met', reason: failure || 'the instance says this record does not match it', how: 'instance' };
  }
  // The instance could not be asked: fall back to reading the values, but only a certain answer counts.
  if (local && local.result === 'false' && local.failure) return { status: 'not_met', reason: `${local.failure} (worked out from the record's values; the instance could not be asked)`, how: 'local' };
  if (local && local.result === 'true') return { status: 'met', reason: 'the record\'s values satisfy it (worked out locally; the instance could not be asked)', how: 'local' };
  return { status: 'unknown', reason: error ? `the condition could not be checked: ${clip(error, 120)}` : 'the condition could not be checked', how: 'none' };
}

/** Local reading of a condition against a record's values (for the reason text and as a fallback). */
export function evaluateLocally(condition, record) {
  try {
    return evaluateQuery(condition, { table: record.table, chain: record.chain, isNew: false, current: record.values || {}, previous: null, display: record.display || {} });
  } catch {
    return null;
  }
}

/** The condition in short plain lines for display. */
export function conditionLines(condition) {
  const parsed = parseEncodedQuery(condition);
  const lines = [];
  parsed.groups.forEach((group, gi) => {
    if (!group.length) return;
    const parts = group.map((c, i) => `${i === 0 ? '' : c.or ? 'or ' : 'and '}${c.field} ${OP_WORDS[c.op] || c.op}${valueWords(c.op, c.value)}`);
    lines.push(`${gi === 0 ? '' : 'or, '}${parts.join(', ')}`);
  });
  if (parsed.raw.length) lines.push(`not understood here: ${parsed.raw.join(', ')}`);
  return lines;
}

const OP_WORDS = {
  '=': 'is', '!=': 'is not', '>': 'is above', '>=': 'is at least', '<': 'is below', '<=': 'is at most', STARTSWITH: 'starts with', ENDSWITH: 'ends with',
  LIKE: 'contains', NOTLIKE: 'does not contain', 'NOT LIKE': 'does not contain', IN: 'is one of', 'NOT IN': 'is none of', ISEMPTY: 'is empty', ISNOTEMPTY: 'is not empty',
  VALCHANGES: 'changed', CHANGESFROM: 'changes from', CHANGESTO: 'changes to', ANYTHING: 'is anything', EMPTYSTRING: 'is an empty string', SAMEAS: 'equals the field', NSAMEAS: 'differs from the field',
};
function valueWords(op, value) {
  if (['ISEMPTY', 'ISNOTEMPTY', 'VALCHANGES', 'ANYTHING', 'EMPTYSTRING'].includes(op)) return '';
  return ` ${/^[0-9a-f]{32}$/i.test(value) ? '(a record)' : clip(value, 40) || '(empty)'}`;
}

// --- Events --------------------------------------------------------------------------------------------

export function normalizeEvent(row = {}) {
  const userId = text(row.user_id);
  const userName = text(row.user_name);
  return {
    sysId: text(row.sys_id),
    name: text(row.name),
    state: text(row.state).toLowerCase(),
    table: text(row.table),
    instance: text(row.instance),
    parm1: text(row.parm1),
    parm2: text(row.parm2),
    queue: text(row.queue),
    createdOn: text(row.sys_created_on),
    processedOn: text(row.processed),
    processOn: text(row.process_on),
    claimedBy: text(row.claimed_by),
    userId: SYS_ID_RE.test(userId) ? userId : '',
    userName: userName || (userId && !SYS_ID_RE.test(userId) ? userId : ''),
  };
}

/** @returns {{ phase: 'processed'|'error'|'scheduled'|'pending'|'stuck'|'other', label: string, minutes: number|null }} */
export function classifyEvent(event, now = Date.now()) {
  const state = event.state;
  if (state === 'processed') return { phase: 'processed', label: 'Processed', minutes: minutesSince(event.processedOn || event.createdOn, now) };
  if (state === 'error') return { phase: 'error', label: 'Error', minutes: minutesSince(event.createdOn, now) };
  if (['ready', 'queued', 'claimed', 'processing', ''].includes(state)) {
    const due = parseSnTime(event.processOn);
    if (due !== null && due > now) return { phase: 'scheduled', label: 'Scheduled', minutes: 0 };
    const since = Math.max(parseSnTime(event.createdOn) ?? 0, due ?? 0);
    const minutes = since ? Math.max(0, Math.round((now - since) / 60000)) : null;
    if (minutes !== null && minutes >= STUCK_EVENT_MINUTES) return { phase: 'stuck', label: 'Stuck in the queue', minutes };
    return { phase: 'pending', label: state === 'ready' || !state ? 'Ready' : state[0].toUpperCase() + state.slice(1), minutes };
  }
  return { phase: 'other', label: state[0].toUpperCase() + state.slice(1), minutes: minutesSince(event.createdOn, now) };
}

const byNewest = (a, b) => (parseSnTime(b.createdOn) ?? 0) - (parseSnTime(a.createdOn) ?? 0);

const squash = (s) => text(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/** Event names fired for the record that look like a misspelling of the one the notification waits for. */
export function nearEventNames(eventName, events) {
  const want = squash(eventName);
  if (want.length < 4) return [];
  return [...new Set(events.map((e) => e.name))].filter((name) => name !== eventName && (squash(name) === want || distance(squash(name), want) <= 2));
}

// --- Emails --------------------------------------------------------------------------------------------

/** "a@x.com, b@x.com" -> ['a@x.com', 'b@x.com'] (lower case, no empties). */
export function parseAddresses(value) {
  return text(value)
    .split(/[,;]/)
    .map((s) => {
      const angle = /<([^>]+)>/.exec(s);
      return (angle ? angle[1] : s).trim().toLowerCase();
    })
    .filter((s) => s.includes('@'));
}

// The exact link from an email to the notification that made it (confirmed live 2026-10-23): a header line
// "X-ServiceNow-Source:Notification-<sys_id of the sysevent_email_action>". sys_email has no notification column.
const SOURCE_RE = /^X-ServiceNow-Source:\s*Notification-([0-9a-f]{32})(?![0-9a-f])/i;

/** The notification sys_id named in an email's headers, or '' (lines may end in CRLF). */
export function notificationIdFromHeaders(headers) {
  for (const line of text(headers).split(/\r?\n/)) {
    const m = SOURCE_RE.exec(line.trim());
    if (m) return m[1].toLowerCase();
  }
  return '';
}

/**
 * A sys_email row in the tracer's shape. `notificationId` comes from the X-ServiceNow-Source header; `linkKnown` says the
 * email's origin is known (it has headers, or an email log entry was applied by applyEmailLog), so it is never matched by
 * subject. Headers are only parsed here, never shown or copied (they hold addresses and message ids).
 */
export function normalizeEmail(row = {}) {
  const headers = text(row.headers);
  // A `notification` value is still honoured when a caller passes one (the older row shape, used by the agent's tests);
  // the content script never asks for it, because sys_email has no such column.
  const column = text(row.notification).toLowerCase();
  const headerId = notificationIdFromHeaders(headers) || (SYS_ID_RE.test(column) ? column : '');
  return {
    sysId: text(row.sys_id),
    type: text(row.type).toLowerCase(),
    state: text(row.state).toLowerCase(),
    subject: text(row.subject),
    recipients: parseAddresses(row.recipients),
    copied: parseAddresses(row.copied),
    blindCopied: parseAddresses(row.blind_copied),
    error: text(row.error_string),
    createdOn: text(row.sys_created_on),
    updatedOn: text(row.sys_updated_on),
    instance: text(row.instance),
    targetTable: text(row.target_table),
    notificationId: headerId,
    eventId: '',
    linkKnown: headers.trim() !== '' || Boolean(headerId),
    linkBy: headerId ? 'header' : '',
  };
}

/**
 * Tie emails to their notification and event with sys_email_log rows ({ email, event, notification }, the platform's own
 * log). A log entry wins over the header; an email with no entry keeps what its header said.
 * @param {object[]} emails normalized emails
 * @param {Array<{email: string, event?: string, notification?: string}>} logRows
 */
export function applyEmailLog(emails, logRows = []) {
  const byEmail = new Map();
  (logRows || []).forEach((r) => {
    const email = text(r?.email);
    if (!SYS_ID_RE.test(email)) return;
    const entry = byEmail.get(email) || { notification: '', event: '' };
    if (!entry.notification && SYS_ID_RE.test(text(r.notification))) entry.notification = text(r.notification).toLowerCase();
    if (!entry.event && SYS_ID_RE.test(text(r.event))) entry.event = text(r.event).toLowerCase();
    byEmail.set(email, entry);
  });
  return emails.map((e) => {
    const log = byEmail.get(e.sysId);
    if (!log || (!log.notification && !log.event)) return e;
    return { ...e, notificationId: log.notification || e.notificationId, eventId: log.event || e.eventId, linkKnown: true, linkBy: log.notification ? 'log' : e.linkBy };
  });
}

/** @returns {{ phase: 'sent'|'ready'|'ignored'|'failed'|'received'|'other', label: string, minutes: number|null, stuck: boolean }} */
export function classifyEmail(email, now = Date.now()) {
  const both = `${email.type} ${email.state}`;
  const minutes = minutesSince(email.createdOn, now);
  const make = (phase, label, stuck = false) => ({ phase, label, minutes, stuck });
  if (/ignored/.test(email.type) && !/^received/.test(email.type)) return make('ignored', 'Ignored (not sent)');
  if (/failed/.test(email.type)) return make('failed', 'Failed');
  if (/^received/.test(email.type)) return make('received', 'Received');
  if (email.type === 'sent') return make('sent', 'Sent');
  if (/ready/.test(email.type)) {
    const stuck = minutes !== null && minutes >= STUCK_EMAIL_MINUTES;
    return make('ready', stuck ? 'Waiting to send (stuck)' : 'Waiting to send', stuck);
  }
  if (/ignored/.test(both)) return make('ignored', 'Ignored (not sent)');
  if (/failed|error/.test(both)) return make('failed', 'Failed');
  if (/sent/.test(both)) return make('sent', 'Sent');
  if (/ready/.test(both)) {
    const stuck = minutes !== null && minutes >= STUCK_EMAIL_MINUTES;
    return make('ready', stuck ? 'Waiting to send (stuck)' : 'Waiting to send', stuck);
  }
  return make('other', email.type || email.state || 'Unknown');
}

/** "Incident ${number} was commented on" -> a matcher, or null when the subject is too generic to match on. */
export function subjectMatcher(template) {
  const parts = text(template).split(/\$\{[^}]*\}/);
  const literal = parts.join('').replace(/\s+/g, '');
  if (literal.length < 4) return null;
  const escaped = parts.map((p) => p.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  return new RegExp(`^\\s*(?:re:\\s*)?${escaped.join('.*?')}\\s*$`, 'i');
}

/** An email the instance received (a reply to the record), not one a notification created. */
export const isInbound = (email) => /^received/.test(text(email?.type));

/**
 * Which of the record's emails came from this notification: exactly, by the notification the email's header or the email
 * log names; and only for an email whose origin is unknown (no headers, no log entry), by the subject template. Inbound
 * replies ("RE: Incident ... was commented on") carry the record too and would match the subject, so they never count.
 */
export function matchEmails(notification, emails) {
  const outbound = emails.filter((e) => !isInbound(e));
  const exact = outbound.filter((e) => e.notificationId && e.notificationId === notification.sysId);
  const matcher = subjectMatcher(notification.subject);
  const bySubject = matcher ? outbound.filter((e) => !e.linkKnown && !e.notificationId && matcher.test(e.subject)) : [];
  const list = [...exact, ...bySubject].sort(byNewest);
  const by = exact.length && bySubject.length ? 'link and subject' : exact.length ? 'link' : bySubject.length ? 'subject' : '';
  return { emails: list, by, subjectOnly: !exact.length && bySubject.length > 0, canMatch: Boolean(matcher) || emails.some((e) => e.linkKnown), matcher: Boolean(matcher) };
}

// --- Instance switches ---------------------------------------------------------------------------------

/** Properties read (never changed). Only names that are not secrets. */
export const SWITCH_PROPERTIES = ['glide.email.smtp.active', 'glide.email.test.user', 'glide.email.default.sender', 'glide.installation.production'];

/**
 * The rows read for SWITCH_PROPERTIES, or an error when none came back: glide.email.smtp.active is a base-system
 * property, so an empty answer means an ACL hid sys_properties (the Table API filters rows without an error), not that
 * the settings are absent. A switched-off mail setting must never look like "nothing unusual".
 */
export function switchRowsOrThrow(rows = []) {
  const known = (rows || []).filter((r) => SWITCH_PROPERTIES.includes(text(r?.name)));
  if (!known.length) throw new Error('none of the email properties are visible to your account (an ACL on sys_properties may hide them)');
  return known;
}

/**
 * The error text for a table of which the user sees no rows at all. The Table API answers an ACL-hidden table with an
 * empty list rather than an error, so "no event for this record" would otherwise read as "the event never fired".
 */
export function hiddenTableMessage(table, what) {
  return `Your account sees no rows of ${table} at all (usually admin-only), so ${what} cannot be checked.`;
}

export function emptySwitches() {
  return { present: {}, sendingOff: null, testUser: '', defaultSender: '', production: null, hostEnvironment: '', findings: [] };
}

/**
 * @param {Array<{name: string, value: string}>} rows sys_properties rows for SWITCH_PROPERTIES (missing = not on this instance)
 * @param {{ hostEnvironment?: string }} [extra] hostEnvironment: 'prod'|'stage'|'test'|'dev'|'' from the instance name
 */
export function readSwitches(rows = [], { hostEnvironment = '' } = {}) {
  const out = emptySwitches();
  rows.forEach((r) => {
    const name = text(r.name);
    if (SWITCH_PROPERTIES.includes(name)) out.present[name] = text(r.value).trim();
  });
  const p = out.present;
  if ('glide.email.smtp.active' in p) out.sendingOff = p['glide.email.smtp.active'].toLowerCase() === 'false';
  if ('glide.email.test.user' in p) out.testUser = p['glide.email.test.user'];
  if ('glide.email.default.sender' in p) out.defaultSender = p['glide.email.default.sender'];
  if ('glide.installation.production' in p) out.production = p['glide.installation.production'].toLowerCase() === 'true';
  out.hostEnvironment = hostEnvironment;
  if (out.sendingOff) {
    out.findings.push({ id: 'sending-off', level: 'bad', text: 'Email sending is switched off on this instance (glide.email.smtp.active is false). Emails are created but never leave, whatever the notifications do.' });
  }
  if (out.testUser) {
    out.findings.push({ id: 'test-user', level: 'warn', text: `All outbound email is redirected to ${out.testUser} (glide.email.test.user), so the real recipients never receive it.` });
  }
  const nonProd = out.production === false || ['dev', 'test', 'stage'].includes(hostEnvironment);
  if (nonProd) {
    const why = out.production === false ? 'is marked as not production (glide.installation.production is false)' : `has a ${hostEnvironment} name`;
    out.findings.push({
      id: 'non-production',
      level: 'info',
      text: `This instance ${why}. Sub-production instances often have email switched off or redirected, especially after a clone.`,
    });
  }
  return out;
}

// --- Recipients ----------------------------------------------------------------------------------------

function notificationSetting(value, label) {
  const l = text(label).toLowerCase();
  const v = text(value).trim();
  if (l) return /disabl/.test(l) ? 'disabled' : /enabl|default/.test(l) ? 'enabled' : 'other';
  if (v === '1') return 'disabled';
  if (v === '2' || v === '3') return 'enabled';
  return '';
}

export function normalizeUser(row = {}, display = {}) {
  return {
    sysId: text(row.sys_id),
    name: text(row.name) || text(row.user_name) || text(row.sys_id),
    userName: text(row.user_name),
    email: text(row.email).trim(),
    active: row.active === undefined ? true : bool(row.active),
    lockedOut: bool(row.locked_out),
    notification: notificationSetting(row.notification, display.notification),
  };
}

export function normalizeGroup(row = {}) {
  return { sysId: text(row.sys_id), name: text(row.name) || text(row.sys_id), active: row.active === undefined ? true : bool(row.active), email: text(row.email).trim(), includeMembers: row.include_members === undefined ? null : bool(row.include_members) };
}

export function normalizeDevice(row = {}) {
  return { user: text(row.user), type: text(row.type), active: row.active === undefined ? true : bool(row.active), email: text(row.email_address).trim(), name: text(row.name) };
}

export function emptyDirectory() {
  return { users: new Map(), groups: new Map(), members: new Map(), membersCapped: new Set(), membersUnread: new Set(), devices: null };
}

/**
 * @param {{ users?: object[], groups?: object[], members?: Array<{group: string, user: string}>, devices?: object[]|null, capped?: string[], unread?: string[] }} parts
 *   normalized rows; `capped` = groups whose member list was cut short, `unread` = groups whose members were not read at all
 */
export function buildDirectory({ users = [], groups = [], members = [], devices = null, capped = [], unread = [] } = {}) {
  const dir = emptyDirectory();
  users.forEach((u) => dir.users.set(u.sysId, u));
  groups.forEach((g) => dir.groups.set(g.sysId, g));
  members.forEach((m) => {
    if (!dir.members.has(m.group)) dir.members.set(m.group, []);
    if (!dir.members.get(m.group).includes(m.user)) dir.members.get(m.group).push(m.user);
  });
  capped.forEach((g) => dir.membersCapped.add(g));
  unread.forEach((g) => dir.membersUnread.add(g));
  if (devices) {
    dir.devices = new Map();
    devices.forEach((d) => {
      if (!dir.devices.has(d.user)) dir.devices.set(d.user, []);
      dir.devices.get(d.user).push(d);
    });
  }
  return dir;
}

/**
 * Every sys_id the recipient expansion will need for a set of notifications, so the instance can be asked once.
 * @returns {{ users: string[], groups: string[], unknown: string[], fields: string[] }} unknown = ids found in fields/parms that may be a user or a group
 */
export function recipientIdsNeeded(notifications, { fieldValues = {}, parms = [], creatorIds = [] } = {}) {
  const users = new Set(creatorIds.filter((id) => SYS_ID_RE.test(id)));
  const groups = new Set();
  const unknown = new Set();
  const fields = new Set();
  notifications.forEach((n) => {
    n.recipientUsers.forEach((id) => users.add(id));
    n.recipientGroups.forEach((id) => groups.add(id));
    n.recipientFields.forEach((f) => {
      fields.add(f);
      idsOf(fieldValues[f]?.value).forEach((id) => unknown.add(id));
    });
  });
  parms.forEach((p) => idsOf(p).forEach((id) => unknown.add(id)));
  return { users: [...users], groups: [...groups], unknown: [...unknown], fields: [...fields] };
}

const REASON_ADVICE = {
  creator: 'Tick "Send to event creator" while you test, or make the change as a different user.',
  inactive: 'Use an active user, or take them off the notification.',
  disabled: 'Set Notification to Enable on the user, or tick Force delivery on the notification.',
  'no-email': 'Add an email address to the user (or an active email notification device).',
  'device-inactive': "Activate the user's email notification device (Notification Preferences).",
};

/**
 * Who the notification would go to for this record, who it would not, and why.
 * @param {{
 *   notification: object, directory?: object, fieldValues?: Record<string,{value:string, display?:string}>,
 *   creator?: { userIds?: string[], userNames?: string[], label?: string, source?: string }|null,
 *   parms?: { parm1?: string, parm2?: string }
 * }} args
 */
export function expandRecipients({ notification: n, directory = emptyDirectory(), fieldValues = {}, creator = null, parms = {}, noRecord = false }) {
  const people = new Map();
  const issues = [];
  const sources = [];
  let unreadGroups = 0;
  const creatorIds = new Set(creator?.userIds || []);
  const creatorNames = new Set((creator?.userNames || []).map((s) => s.toLowerCase()));

  const addPerson = (user, source) => {
    const key = user.sysId;
    if (!people.has(key)) people.set(key, { key, sysId: user.sysId, name: user.name, userName: user.userName, email: user.email, isAddress: false, sources: [], user });
    const entry = people.get(key);
    if (!entry.sources.includes(source)) entry.sources.push(source);
  };
  const addAddress = (address, source) => {
    const key = `address:${address.toLowerCase()}`;
    if (!people.has(key)) people.set(key, { key, sysId: '', name: address, userName: '', email: address, isAddress: true, sources: [], user: null });
    const entry = people.get(key);
    if (!entry.sources.includes(source)) entry.sources.push(source);
  };
  const addGroup = (group, via = '') => {
    if (directory.membersUnread?.has(group.sysId)) {
      // Not read is not empty: say so, and never claim the group adds nobody.
      sources.push({ label: `Group ${group.name}`, detail: `members not read${via ? ` (${via})` : ''}`, tone: 'neutral', href: recordPath('sys_user_group', group.sysId) });
      issues.push({ code: 'members-unread', level: 'warn', text: `The members of the group ${group.name} were not read, so who it adds is not known here.` });
      if (!group.active) issues.push({ code: 'group-inactive', level: 'warn', text: `The group ${group.name} is inactive.` });
      unreadGroups += 1;
      return;
    }
    const ids = directory.members.get(group.sysId) || [];
    let inactive = 0;
    let found = 0;
    ids.forEach((id) => {
      const u = directory.users.get(id);
      if (!u) return;
      found += 1;
      if (!u.active) inactive += 1;
      addPerson(u, `Member of ${group.name}${via ? ` (${via})` : ''}`);
    });
    const parts = [`${plural(found, 'member')}`];
    if (inactive) parts.push(`${inactive} inactive`);
    if (directory.membersCapped.has(group.sysId)) parts.push('list cut short');
    sources.push({ label: `Group ${group.name}`, detail: `${parts.join(', ')}${via ? ` (${via})` : ''}`, tone: found ? 'ok' : 'bad', href: recordPath('sys_user_group', group.sysId) });
    if (!group.active) issues.push({ code: 'group-inactive', level: 'warn', text: `The group ${group.name} is inactive.` });
    if (!found) issues.push({ code: 'group-empty', level: 'warn', text: `The group ${group.name} has no members, so it adds nobody.` });
    if (group.email) issues.push({ code: 'group-email', level: 'info', text: `The group ${group.name} has its own email address${group.includeMembers === false ? ' and "Include members" is off' : ''}; the instance may use that address as well as, or instead of, its members.` });
    if (directory.membersCapped.has(group.sysId)) issues.push({ code: 'members-capped', level: 'info', text: `Only part of the group ${group.name} was read (it has a lot of members).` });
  };
  const resolveToken = (token, source, label) => {
    if (SYS_ID_RE.test(token)) {
      const user = directory.users.get(token);
      if (user) {
        addPerson(user, source);
        return user.name;
      }
      const group = directory.groups.get(token);
      if (group) {
        addGroup(group, source.charAt(0).toLowerCase() + source.slice(1));
        return group.name;
      }
      issues.push({ code: 'id-missing', level: 'warn', text: `${label} holds a record that is not a user or group you can read (${token.slice(0, 8)}…).` });
      return '';
    }
    if (token.includes('@')) {
      addAddress(token, source);
      return token;
    }
    issues.push({ code: 'not-recipient', level: 'warn', text: `${label} holds "${clip(token, 40)}", which is not a user, a group or an email address.` });
    return '';
  };

  // Users listed on the notification.
  if (n.recipientUsers.length) {
    let missing = 0;
    n.recipientUsers.forEach((id) => {
      const user = directory.users.get(id);
      if (user) addPerson(user, 'Listed in Users');
      else missing += 1;
    });
    sources.push({ label: 'Users', detail: `${plural(n.recipientUsers.length, 'user')} listed${missing ? `, ${missing} could not be read` : ''}`, tone: 'ok' });
    if (missing) issues.push({ code: 'user-missing', level: 'warn', text: `${plural(missing, 'user')} listed on the notification could not be read (deleted, or your account cannot see them).` });
  }
  // Groups listed on the notification.
  n.recipientGroups.forEach((id) => {
    const group = directory.groups.get(id);
    if (group) addGroup(group);
    else {
      sources.push({ label: 'Group', detail: 'could not be read', tone: 'bad' });
      issues.push({ code: 'group-missing', level: 'warn', text: `A group listed on the notification could not be read (${id.slice(0, 8)}…).` });
    }
  });
  // Fields on the record that hold users, groups or addresses.
  n.recipientFields.forEach((field) => {
    if (noRecord) {
      sources.push({ label: `Field ${field}`, detail: 'read from the record when it is sent', tone: 'neutral' });
      return;
    }
    const entry = fieldValues[field];
    const tokens = splitList(entry?.value);
    if (!entry || !tokens.length) {
      sources.push({ label: `Field ${field}`, detail: entry ? 'empty on this record' : 'not read', tone: 'bad' });
      issues.push({ code: 'field-empty', level: 'warn', text: entry ? `The recipient field ${field} is empty on this record, so it adds nobody.` : `The recipient field ${field} could not be read from this record.` });
      return;
    }
    const names = tokens.map((t) => resolveToken(t, `Field ${field}`, `The recipient field ${field}`)).filter(Boolean);
    sources.push({ label: `Field ${field}`, detail: names.length ? clip(names.join(', '), 60) : clip(entry.display || entry.value, 60), tone: names.length ? 'ok' : 'bad' });
  });
  // Recipients passed in the event's parameters.
  [['parm1', n.eventParm1, 'Event parameter 1'], ['parm2', n.eventParm2, 'Event parameter 2']].forEach(([key, on, label]) => {
    if (!on) return;
    if (noRecord) {
      sources.push({ label, detail: 'read from the event when it is sent', tone: 'neutral' });
      return;
    }
    const tokens = splitList(parms[key]);
    if (!tokens.length) {
      sources.push({ label, detail: 'the event passed nothing', tone: 'bad' });
      issues.push({ code: 'parm-empty', level: 'warn', text: `${label} is meant to hold recipients, but the latest event passed nothing there.` });
      return;
    }
    const names = tokens.map((t) => resolveToken(t, label, label)).filter(Boolean);
    sources.push({ label, detail: names.length ? clip(names.join(', '), 60) : 'nothing usable', tone: names.length ? 'ok' : 'bad' });
  });

  const configured = n.recipientUsers.length + n.recipientGroups.length + n.recipientFields.length + (n.eventParm1 ? 1 : 0) + (n.eventParm2 ? 1 : 0);
  if (!configured) issues.push({ code: 'none-configured', level: 'bad', text: 'The notification lists no recipients: no users, no groups, no recipient fields and no event parameters.' });

  // Judge each person.
  const isCreator = (user) => Boolean(user) && (creatorIds.has(user.sysId) || (user.userName && creatorNames.has(user.userName.toLowerCase())));
  const list = [...people.values()].map((p) => {
    const reasons = [];
    const notes = [];
    const user = p.user;
    if (user) {
      if (!user.active) reasons.push({ code: 'inactive', text: 'The user is inactive, and inactive users do not get notifications.' });
      if (user.notification === 'disabled') {
        if (n.mandatory) notes.push('Notifications are disabled on this user, but this notification has Force delivery ticked, which normally overrides that.');
        else reasons.push({ code: 'disabled', text: 'Notifications are switched off on the user\'s profile (Notification: Disabled).' });
      }
      if (!n.sendSelf && isCreator(user)) {
        reasons.push({ code: 'creator', text: `This is the person who ${creator?.source === 'event' ? 'fired the event' : 'made the last change'}, and "Send to event creator" is off.` });
      }
      const devices = directory.devices ? directory.devices.get(user.sysId) || [] : null;
      const emailDevices = devices ? devices.filter((d) => /email/i.test(d.type)) : [];
      const activeDeviceAddress = emailDevices.some((d) => d.active && d.email);
      if (emailDevices.length && !emailDevices.some((d) => d.active)) {
        reasons.push({ code: 'device-inactive', text: "All of the user's email notification devices are inactive." });
      } else if (!user.email && !activeDeviceAddress) {
        reasons.push({ code: 'no-email', text: 'The user has no email address.' });
      }
      if (user.lockedOut) notes.push('Locked out of signing in. That alone does not stop email.');
      if (!directory.devices) notes.push('Notification devices were not checked.');
    } else {
      notes.push('An email address, not a user, so no user settings apply to it.');
    }
    return { key: p.key, sysId: p.sysId, name: p.name, userName: p.userName, email: p.email, isAddress: p.isAddress, sources: p.sources, status: reasons.length ? 'blocked' : 'receives', reasons: reasons.map((r) => ({ ...r, advice: REASON_ADVICE[r.code] || '' })), notes };
  });
  list.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'receives' ? -1 : 1));

  const counts = { total: list.length, receive: list.filter((p) => p.status === 'receives').length, blocked: list.filter((p) => p.status === 'blocked').length };
  const creatorExcluded = list.filter((p) => p.reasons.some((r) => r.code === 'creator'));
  sources.push({ label: 'Send to event creator', detail: n.sendSelf ? 'on: the person who caused it can receive it' : 'off: the person who caused it is left out', tone: n.sendSelf ? 'ok' : 'neutral' });
  return { people: list, issues, sources, counts, creatorExcluded: creatorExcluded.map((p) => p.name), mandatory: n.mandatory, unreadGroups };
}

/** The classic form path of a record, or '' when the table or id is not valid. */
export function recordPath(table, sysId) {
  return /^[a-z][a-z0-9_]*$/.test(text(table)) && SYS_ID_RE.test(text(sysId)) ? `/${table}.do?sys_id=${sysId}` : '';
}

/** One sentence on why a recipient expansion has nobody (or nobody left). '' when someone would receive it. */
export function recipientProblem(rec) {
  if (!rec) return '';
  if (rec.counts.receive > 0) return '';
  // A group whose members were not read may hold everyone who would get it: no claim either way.
  if (rec.unreadGroups > 0) return '';
  if (rec.counts.total === 0) {
    const why = rec.issues.filter((i) => i.level !== 'info').map((i) => i.text.replace(/\.$/, ''));
    return why.length ? `nobody ends up on the recipient list: ${why.slice(0, 3).join('; ')}.` : 'nobody ends up on the recipient list.';
  }
  const blocked = rec.people.filter((p) => p.status === 'blocked').slice(0, 3).map((p) => `${p.name}: ${p.reasons[0].text.replace(/\.$/, '')}`);
  const more = rec.counts.blocked > 3 ? ` (and ${rec.counts.blocked - 3} more)` : '';
  return `everyone on the list is left out. ${blocked.join('; ')}${more}.`;
}

// --- Tracing one notification --------------------------------------------------------------------------

const check = (status, message, advice = '') => ({ status, text: message, advice });

function pickStatus(checks) {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  if (checks.some((c) => c.status === 'unknown')) return 'unknown';
  return 'ok';
}

function firstOf(checks, status) {
  return checks.find((c) => c.status === status);
}

function stageFromChecks(id, checks, okText, extra = {}) {
  const status = pickStatus(checks);
  const lead = firstOf(checks, 'fail') || firstOf(checks, 'warn') || firstOf(checks, 'unknown');
  return { id, label: STAGE_LABEL[id], status, headline: lead ? lead.text : okText, advice: lead?.advice || '', checks, ...extra };
}

function matchStage(n, ctx) {
  const { record, condition, produced } = ctx;
  const checks = [];
  checks.push(n.active ? check('pass', 'It is active.') : check('fail', 'The notification is inactive, so it never runs.', 'Open it and tick Active. Nothing else matters while it is off.'));
  checks.push(check('pass', n.table === record.table ? `It is on ${n.table}.` : `It is defined on ${n.table}, a parent of ${record.table}, so it applies to ${record.table} records too.`));

  if (n.kind === 'event') {
    checks.push(n.eventName ? check('pass', `It sends when the event ${n.eventName} is queued for a record.`) : check('fail', 'It is set to send on an event, but no event is chosen.', 'Pick the event on the "When to send" tab.'));
  } else if (n.kind === 'engine') {
    if (!n.onInsert && !n.onUpdate) {
      checks.push(check('fail', 'It is set to send when a record is saved, but neither "Inserted" nor "Updated" is ticked.', 'Tick Inserted and/or Updated on the "When to send" tab.'));
    } else {
      checks.push(check('pass', `It sends when a record is ${[n.onInsert && 'inserted', n.onUpdate && 'updated'].filter(Boolean).join(' or ')}.`));
      const made = parseSnTime(record.createdOn);
      const born = parseSnTime(n.createdOn);
      if (n.onInsert && !n.onUpdate && made !== null && born !== null && born > made) {
        checks.push(check('fail', `It only sends when a record is inserted. This record was created (${whenText(record.createdOn)}) before the notification was (${whenText(n.createdOn)}), so it could not have fired for it.`, 'Create a new record to test it, or tick Updated.'));
      }
      if (!n.onInsert && n.onUpdate && record.modCount === 0) {
        checks.push(check('fail', 'It only sends when a record is updated, and this record has not been updated since it was created.', 'Save a change to the record, or tick Inserted.'));
      }
    }
  } else {
    checks.push(check('unknown', 'It is set to "Triggered": it only sends when a flow, workflow or script asks for it by name. The tracer cannot see that call.', 'Look in the flow, workflow or script that should send it, and confirm it ran.'));
  }

  if (condition.status === 'none') checks.push(check('pass', 'There is no condition, so it applies to every record.'));
  else if (condition.status === 'met') checks.push(check('pass', `The condition is met: ${condition.reason}.`));
  else if (condition.status === 'not_met') {
    checks.push(check('fail', `The record does not meet the condition: ${condition.reason}.`, "The condition is judged against the record as it is now. If it held when the email should have gone and the record changed since, skipping it was correct. Otherwise fix the data or the notification's condition."));
  } else checks.push(check('unknown', `Cannot tell whether the condition holds: ${condition.reason}.`));

  if (n.advancedCondition) checks.push(check('unknown', 'It also has an advanced condition script. It was not run here; if the script returns false, no email is sent.', 'Read the script below and check its logic against this record.'));

  // An email that exists proves the notification ran for this occurrence, whatever the record looks like now.
  const judged = produced
    ? checks.map((c) => (c.status === 'fail' ? { ...c, status: 'warn', text: `${c.text} It did produce an email for this occurrence, so this may have changed since.` } : c.status === 'unknown' ? { ...c, status: 'pass', text: `${c.text} It produced an email, so it passed when it ran.` } : c))
    : checks;
  return stageFromChecks('match', judged, 'It is active, applies to this record and its condition is met.');
}

function skipStage(id, message) {
  return { id, label: STAGE_LABEL[id], status: 'skip', headline: message, advice: '', checks: [] };
}

/** A step this kind of notification does not have (an on-save notification has no event). */
function naStage(id, message) {
  return { id, label: STAGE_LABEL[id], status: 'na', headline: message, advice: '', checks: [] };
}

function eventStages(n, ctx) {
  const { myEvents, latest, eventsError, record, now, near, allEvents } = ctx;
  if (n.kind !== 'event') {
    const why = n.kind === 'engine' ? 'Not used: this notification sends when the record is saved, not from an event.' : 'Not used: this notification is triggered by a flow or script, not by an event.';
    return [naStage('event', why), naStage('processed', why)];
  }
  if (!n.eventName) return [skipStage('event', 'Not reached: no event is chosen.'), skipStage('processed', 'Not reached.')];
  if (eventsError) {
    const unknown = { id: 'event', label: STAGE_LABEL.event, status: 'unknown', headline: `The event log could not be read, so this cannot be checked: ${clip(eventsError, 120)}`, advice: '', checks: [] };
    return [unknown, skipStage('processed', 'Not reached.')];
  }
  if (!myEvents.length) {
    const updated = minutesSince(record.updatedOn, now);
    const old = updated !== null && updated > EVENT_RETENTION_DAYS * 1440;
    const others = [...new Set(allEvents.map((e) => e.name))];
    const extra = [];
    if (near.length) extra.push(`An event with a nearly identical name was queued for this record: ${near.join(', ')}. Check the spelling.`);
    if (others.length) extra.push(`Events that were queued for this record: ${others.slice(0, 6).join(', ')}${others.length > 6 ? ` and ${others.length - 6} more` : ''}.`);
    else extra.push('No events at all were queued for this record.');
    if (old) {
      const stage = { id: 'event', label: STAGE_LABEL.event, status: 'unknown', headline: `No event ${n.eventName} was found for this record. Processed events are cleaned out after about ${EVENT_RETENTION_DAYS} days by default and this record was last changed ${agoText(updated)} ago, so it may simply be gone.`, advice: 'Make a small change to the record (or fire the event again) and trace it again within a few minutes.', checks: extra.map((t) => check('info', t)) };
      return [stage, skipStage('processed', 'Not reached.')];
    }
    const stage = {
      id: 'event',
      label: STAGE_LABEL.event,
      status: 'fail',
      code: 'event-missing',
      short: 'Event never fired',
      headline: `The event ${n.eventName} was never queued for this record, so this notification had nothing to react to.`,
      advice: `Find what should fire it (a business rule, flow or script calling gs.eventQueue('${n.eventName}', current, ...)) and check it ran: its condition, its order, whether the save skipped business rules, and that the event name is spelled exactly like this.`,
      checks: extra.map((t) => check('info', t)),
    };
    return [stage, skipStage('processed', 'Not reached: the event was never queued.')];
  }
  const klass = classifyEvent(latest, now);
  const by = latest.userName ? ` by ${latest.userName}` : '';
  const stage1 = { id: 'event', label: STAGE_LABEL.event, status: 'ok', headline: `Queued ${plural(myEvents.length, 'time')} for this record; the latest was ${whenText(latest.createdOn)}${by}.`, advice: '', checks: [] };
  let stage2;
  if (klass.phase === 'processed') {
    stage2 = { id: 'processed', label: STAGE_LABEL.processed, status: 'ok', headline: `The latest event was processed${latest.processedOn ? ` at ${whenText(latest.processedOn)}` : ''}${latest.queue ? ` (queue ${latest.queue})` : ''}.`, advice: '', checks: [] };
  } else if (klass.phase === 'error') {
    stage2 = { id: 'processed', label: STAGE_LABEL.processed, status: 'fail', code: 'event-error', short: 'Event failed', headline: 'Processing the latest event failed: it ended in state "error".', advice: `Open the event, then look in the system log around ${whenText(latest.createdOn)} for the exception. A notification or script action listening to ${n.eventName} threw while it ran.`, checks: [] };
  } else if (klass.phase === 'stuck') {
    stage2 = { id: 'processed', label: STAGE_LABEL.processed, status: 'fail', code: 'event-stuck', short: 'Event stuck', headline: `The latest event has been waiting in state "${latest.state || 'ready'}" for ${agoText(klass.minutes)}: nothing is processing the event queue.`, advice: 'Check the scheduled jobs that process events (System Scheduler > Scheduled Jobs), that the instance nodes are running, and whether processing is paused on this instance (common on a freshly cloned or sleeping sub-production instance).', checks: [] };
  } else if (klass.phase === 'scheduled') {
    stage2 = { id: 'processed', label: STAGE_LABEL.processed, status: 'wait', headline: `The latest event is scheduled to be processed at ${whenText(latest.processOn)}.`, advice: '', checks: [] };
  } else if (klass.phase === 'pending') {
    stage2 = { id: 'processed', label: STAGE_LABEL.processed, status: 'wait', headline: `The latest event is waiting in the queue (${agoText(klass.minutes)}). Events are normally picked up within a minute or two.`, advice: '', checks: [] };
  } else {
    stage2 = { id: 'processed', label: STAGE_LABEL.processed, status: 'unknown', headline: `The latest event is in state "${latest.state}", which the tracer does not recognise.`, advice: '', checks: [] };
  }
  return [stage1, stage2];
}

function createdStage(n, ctx, earlier) {
  const { relevant, earlierEmails, emailsError, recipients, recipientsError, latest, by } = ctx;
  if (earlier.some((s) => s.status === 'fail' || s.status === 'wait')) return skipStage('created', 'Not reached: an earlier step stopped.');
  if (!relevant.length && earlier.some((s) => s.id === 'event' && s.status === 'unknown')) {
    return { id: 'created', label: STAGE_LABEL.created, status: 'unknown', headline: 'No email for this record was found, and it cannot be told whether the event ever ran, so the chain cannot be followed.', advice: 'Trigger it again with a small change to the record and trace it within a few minutes.', checks: [] };
  }
  if (relevant.length) {
    const how = { link: 'named by the email header or the email log', subject: 'matched by subject only', 'link and subject': 'named by the email header or log, or matched by subject' }[by];
    const first = `${plural(relevant.length, 'email')} created for this record from this notification${how ? ` (${how})` : ''}.`;
    return { id: 'created', label: STAGE_LABEL.created, status: 'ok', headline: first, advice: '', checks: [] };
  }
  if (emailsError) {
    const problem = recipientProblem(recipients);
    return {
      id: 'created',
      label: STAGE_LABEL.created,
      status: 'unknown',
      headline: `The emails could not be read, so this cannot be checked: ${clip(emailsError, 120)}${problem ? ` Separately, ${problem}` : ''}`,
      advice: problem ? 'Fix the recipient problem above, then trace again once your account can read the emails.' : '',
      checks: [],
    };
  }
  if (n.kind === 'triggered') {
    return { id: 'created', label: STAGE_LABEL.created, status: 'unknown', headline: 'No email from this notification was found for this record. It is triggered by a flow, workflow or script, and nothing the tracer can see shows that it was asked to send.', advice: 'Check that the flow, workflow or script that triggers it ran for this record.', checks: [] };
  }
  const notes = [];
  if (earlierEmails.length && latest) notes.push(`Earlier events did produce ${plural(earlierEmails.length, 'email')} from this notification, so it works in general; something differs for the latest one (a recipient, the condition, the record).`);
  if (recipients) {
    const problem = recipientProblem(recipients);
    if (problem) {
      const creatorOnly = recipients.counts.total > 0 && recipients.people.every((p) => p.reasons.some((r) => r.code === 'creator'));
      return {
        id: 'created',
        label: STAGE_LABEL.created,
        status: 'fail',
        code: creatorOnly ? 'creator-excluded' : recipients.counts.total === 0 ? 'no-recipients' : 'all-blocked',
        short: creatorOnly ? 'Event creator excluded' : recipients.counts.total === 0 ? 'No recipients' : 'Every recipient left out',
        headline: `No email was created because ${problem}`,
        advice: creatorOnly ? REASON_ADVICE.creator : recipients.counts.total === 0 ? 'Add recipients on the "Who will receive" tab, or fix the field that should supply them.' : (recipients.people.find((p) => p.status === 'blocked')?.reasons[0]?.advice || 'Fix the first reason listed under "Who would get it".'),
        checks: notes.map((t) => check('info', t)),
      };
    }
  } else {
    notes.push(recipientsError ? `The recipients could not be read: ${clip(recipientsError, 120)}` : 'The recipients were not checked.');
  }
  // Emails normally name their notification (header or email log). One that names nothing in the same window may be this
  // notification's mail under a subject a template or mail script changed, so "none was created" cannot be said.
  if (ctx.others.length && recipients) {
    const since = n.kind === 'event' && latest ? ' since the latest event' : '';
    const count = plural(ctx.others.length, ctx.matcher ? 'other email' : 'email');
    const one = ctx.others.length === 1;
    return {
      id: 'created',
      label: STAGE_LABEL.created,
      status: 'unknown',
      code: 'cannot-tie',
      headline: ctx.matcher
        ? `No email with this notification's subject was found, but ${count} ${one ? 'was' : 'were'} created for this record${since} with no notification header and no email log entry to say where ${one ? 'it' : 'they'} came from. A template or mail script can change the subject, so ${one ? 'it' : 'one of them'} may be from this notification.`
        : `This notification's subject is empty or only placeholders (it may come from an email template), and the ${count} created for this record${since} ${one ? 'carries' : 'carry'} no notification header and no email log entry, so ${one ? 'it cannot' : 'they cannot'} be tied to it.`,
      advice: 'Open the emails under "Other emails for this record" and compare their subject and recipients with this notification.',
      checks: notes.map((t) => check('info', t)),
    };
  }
  const causes = [];
  if (n.advancedCondition) causes.push('the advanced condition script returned false (it was not run here)');
  causes.push('the condition was false at the moment the event ran or the record was saved, and the record has changed since');
  causes.push('the email exists but is not linked to this record (the instance field of sys_email is empty), or has been cleaned out');
  if (n.kind === 'engine') causes.push('the save skipped business rules and notifications (setWorkflow(false), an import, or a bulk update)');
  const unknown = !recipients || (recipients.unreadGroups > 0 && recipients.counts.receive === 0);
  return {
    id: 'created',
    label: STAGE_LABEL.created,
    status: unknown ? 'unknown' : 'fail',
    code: 'no-email',
    short: 'No email created',
    headline: unknown ? 'No email for this record was found, and the recipients could not be checked.' : `${n.kind === 'event' ? 'The event was processed' : 'Nothing above stops it'}, there are recipients, but no email for this record was created from this notification.`,
    advice: `Most likely: ${causes.join('; ')}.`,
    checks: notes.map((t) => check('info', t)),
  };
}

function sentStage(n, ctx, earlier) {
  const { relevant, switches, now, record } = ctx;
  if (!relevant.length) return skipStage('sent', 'Not reached: no email was created.');
  if (earlier.some((s) => s.status === 'fail')) return skipStage('sent', 'Not reached: an earlier step stopped.');
  const latest = [...relevant].sort(byNewest)[0];
  const klass = classifyEmail(latest, now);
  const who = latest.recipients.length ? ` to ${clip(latest.recipients.slice(0, 3).join(', '), 70)}${latest.recipients.length > 3 ? ` and ${latest.recipients.length - 3} more` : ''}` : '';
  const off = switches.sendingOff ? ' Email sending is switched off on this instance, which explains it.' : '';
  const mk = (status, headline, advice = '', extra = {}) => ({ id: 'sent', label: STAGE_LABEL.sent, status, headline, advice, checks: [], ...extra });
  // A record-save notification has no event to anchor "the latest occurrence": say when the email is older than the last save.
  const madeAt = parseSnTime(latest.createdOn);
  const savedAt = parseSnTime(record?.updatedOn);
  const beforeSave =
    n.kind === 'engine' && n.onUpdate && madeAt !== null && savedAt !== null && savedAt - madeAt > 2 * 60000
      ? ` That email is from before the latest change to the record (${whenText(record.updatedOn)}); no email from this notification is on file for that change.`
      : '';
  if (klass.phase === 'sent') {
    if (switches.testUser) {
      return mk('warn', `Sent${who} at ${whenText(latest.createdOn)}, but this instance redirects all mail to ${switches.testUser} (glide.email.test.user), so the real recipients did not get it.${beforeSave}`, 'Clear glide.email.test.user on this instance if mail should reach real people.');
    }
    return mk('ok', `Sent${who} at ${whenText(latest.createdOn)}. The mail server took it; that is the last thing the instance can see.${beforeSave}`, 'If the person still did not see it, check their spam or quarantine folder and the mail server logs for this message.');
  }
  if (klass.phase === 'ready') {
    if (klass.stuck) {
      return mk('fail', `The email has been waiting to be sent for ${agoText(klass.minutes)}: the outbound sender is not picking it up.${off}`, 'Check the outbound email account (System Mail > Outbound), whether sending is switched on, and the scheduled job that sends email.', { code: 'email-stuck', short: 'Email stuck in the outbox' });
    }
    return mk('wait', `The email is waiting to be sent (${agoText(klass.minutes)}). The sender normally runs every minute or so.${off}`);
  }
  if (klass.phase === 'ignored') {
    return mk('fail', `The instance created the email but chose not to send it (type send-ignored).${latest.error ? ` It says: ${clip(latest.error, 160).replace(/[.\s]+$/, '')}.` : ''}${off}`, 'Ignored usually means every recipient was dropped (inactive or opted out), an email filter matched, the same email was sent a moment ago, or sending is off. Open the email and read its log.', { code: 'email-ignored', short: 'Email ignored' });
  }
  if (klass.phase === 'failed') {
    return mk('fail', `Sending failed${latest.error ? `: ${clip(latest.error, 200).replace(/[.\s]+$/, '')}` : ' (the instance recorded no reason)'}.`, 'The mail server refused or could not be reached. Check the outbound email account, the sender address and the recipient addresses.', { code: 'email-failed', short: 'Sending failed' });
  }
  return mk('unknown', `The email is in type "${latest.type || 'unknown'}" / state "${latest.state || 'unknown'}", which the tracer does not recognise.`);
}

/**
 * Walk the chain for one notification and one record.
 * @param {{
 *   notification: object,
 *   record: { table: string, sysId: string, chain?: string[], createdOn?: string, updatedOn?: string, modCount?: number|null },
 *   condition: { status: string, reason: string },
 *   events?: object[], emails?: object[], eventsError?: string, emailsError?: string,
 *   recipients?: object|null, recipientsError?: string, switches?: object, now?: number
 * }} input
 */
export function traceNotification(input) {
  const { notification: n, record, condition, events = [], emails = [], eventsError = '', emailsError = '', recipients = null, recipientsError = '', switches = emptySwitches(), now = Date.now() } = input;

  const myEvents = n.kind === 'event' && n.eventName ? events.filter((e) => e.name === n.eventName).sort(byNewest) : [];
  const latest = myEvents[0] || null;
  const matched = matchEmails(n, emails);
  const latestMs = latest ? parseSnTime(latest.createdOn) : null;
  // For an event notification the question is about the latest event: only emails created after it answer it.
  // An email the log ties to an event answers for that event exactly; otherwise it counts when it was made after the event.
  const relevant = latestMs === null ? matched.emails : matched.emails.filter((e) => (e.eventId ? e.eventId === latest.sysId : (parseSnTime(e.createdOn) ?? 0) >= latestMs - 2000));
  const earlierEmails = matched.emails.filter((e) => !relevant.includes(e));
  // Outbound emails for the record in the same window that no notification claims (used only when there is no reference column).
  const claimed = new Set(matched.emails.map((e) => e.sysId));
  const others = emails.filter((e) => !isInbound(e) && !e.linkKnown && !e.notificationId && !claimed.has(e.sysId) && (latestMs === null || (parseSnTime(e.createdOn) ?? 0) >= latestMs - 2000));

  const ctx = {
    record, condition, produced: relevant.length > 0, myEvents, latest, eventsError, now, near: n.kind === 'event' ? nearEventNames(n.eventName, events) : [], allEvents: events, relevant, earlierEmails, emailsError, recipients, recipientsError, switches,
    by: matched.by, matcher: matched.matcher, others,
  };

  const stages = [matchStage(n, ctx)];
  stages.push(...eventStages(n, ctx));
  stages.push(createdStage(n, ctx, stages));
  stages.push(sentStage(n, ctx, stages));

  const verdict = verdictFor(n, stages, { relevant, switches });
  const tier = rankTier(n, stages, { myEvents, matched });
  return {
    notificationId: n.sysId,
    stages,
    verdict,
    tier,
    events: myEvents.map((e) => ({ ...e, ...classifyEvent(e, now) })),
    emails: matched.emails.map((e) => ({ ...e, ...classifyEmail(e, now) })),
    emailsBy: matched.by,
    emailsRelevant: relevant.map((e) => e.sysId),
    lastActivity: Math.max(latestMs ?? 0, ...matched.emails.map((e) => parseSnTime(e.createdOn) ?? 0)),
  };
}

function verdictFor(n, stages, { relevant, switches }) {
  const failed = stages.find((s) => s.status === 'fail');
  const off = switches.sendingOff ? ' Email sending is also switched off on this instance.' : '';
  // `headline` is the full sentence (tickets, copy); `summary` is the one line the panel shows above the chain, whose
  // failing step carries the full sentence and the advice.
  if (failed) {
    const short = failed.short || matchShort(failed);
    const step = stages.indexOf(failed) + 1;
    return {
      status: 'blocked',
      stage: failed.id,
      code: failed.code || (failed.id === 'match' ? matchCode(failed) : failed.id),
      short,
      headline: `Stopped at "${failed.label}": ${failed.headline}${failed.id === 'sent' ? '' : off}`,
      summary: `Stopped at step ${step}, "${failed.label}": ${short}.${switches.sendingOff && failed.id !== 'sent' ? ' Email sending is also switched off on this instance.' : ''}`,
      advice: failed.advice,
    };
  }
  const waiting = stages.find((s) => s.status === 'wait');
  if (waiting) return { status: 'waiting', stage: waiting.id, code: 'waiting', short: 'In progress', headline: `Still moving: ${waiting.headline}`, summary: `Still moving: ${waiting.headline}`, advice: '' };
  const warned = stages.find((s) => s.status === 'warn' && s.id === 'sent');
  if (warned) return { status: 'warn', stage: warned.id, code: 'redirected', short: 'Redirected', headline: warned.headline, summary: warned.headline, advice: warned.advice };
  const unclear = stages.find((s) => s.status === 'unknown');
  if (unclear) {
    const headline = `Cannot tell at "${unclear.label}": ${unclear.headline}`;
    return { status: 'unknown', stage: unclear.id, code: 'unknown', short: 'Cannot tell', headline, summary: headline, advice: unclear.advice };
  }
  if (relevant.length) {
    const sent = stages.find((s) => s.id === 'sent');
    return { status: 'sent', stage: 'sent', code: 'sent', short: 'Sent', headline: sent.headline, summary: sent.headline, advice: sent.advice };
  }
  const none = 'Nothing stops this notification, but no email was found for it.';
  return { status: 'unknown', stage: null, code: 'unknown', short: 'Cannot tell', headline: none, summary: none, advice: '' };
}

const matchCode = (stage) => {
  const bad = stage.checks.find((c) => c.status === 'fail');
  if (!bad) return 'match';
  if (/inactive/.test(bad.text)) return 'inactive';
  if (/condition/.test(bad.text)) return 'condition';
  return 'not-triggered';
};
const matchShort = (stage) => ({ inactive: 'Inactive', condition: 'Condition not met', 'not-triggered': 'Would not fire' }[matchCode(stage)] || 'Does not match');

/** 0 = an event fired or an email exists; 1 = active and the condition holds (or may hold); 2 = the rest; 3 = inactive. */
function rankTier(n, stages, { myEvents, matched }) {
  if (!n.active) return 3;
  if (myEvents.length || matched.emails.length) return 0;
  const match = stages[0];
  return match.status === 'ok' || match.status === 'unknown' ? 1 : 2;
}

/** Candidates, best first: event-fired ones, then condition-met, then the rest, inactive last; newest activity first inside a group. */
export function sortCandidates(list) {
  return [...list].sort((a, b) => a.trace.tier - b.trace.tier || b.trace.lastActivity - a.trace.lastActivity || a.notification.name.localeCompare(b.notification.name));
}

// --- Email text preview --------------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };

/** Tags stripped, entities decoded, blank runs collapsed. The result is shown as TEXT only; HTML from the instance is never rendered. */
export function emailPreviewText(body, { max = 4000 } = {}) {
  let s = text(body);
  s = s.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<(?:script|style)\b[\s\S]*$/i, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\s*br\s*\/?>|<\/\s*(p|div|tr|li|h[1-6]|table|ul|ol)\s*>/gi, '\n');
  s = s.replace(/<\/\s*t[dh]\s*>/gi, '  ');
  s = s.replace(/<\/?[a-z!][^>]*>/gi, '');
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 8 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[name.toLowerCase()] ?? m;
  });
  s = s.replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? { text: `${s.slice(0, max)}…`, truncated: true } : { text: s, truncated: false };
}

/** Subjects and notifications that usually carry a password or one-time code: their body is not shown. */
export function looksSecretMail(subject, notificationName = '') {
  return /password|passcode|one[- ]?time|verification code|security code|reset link|access token|api key|secret/i.test(`${subject} ${notificationName}`);
}

// --- Markdown for a ticket -----------------------------------------------------------------------------

const STAGE_MARK = { ok: 'passed', fail: 'STOPPED HERE', warn: 'check this', wait: 'waiting', unknown: 'cannot tell', skip: 'not reached', na: 'not used' };
/** a***@acme.example: addresses are not pasted into tickets; the domain stays because it often explains a miss. */
const maskAddresses = (s) => text(s).replace(/([^\s,;<>()"'])[^\s,;<>()"']*@([^\s,;<>()"']+)/g, '$1***@$2');
const cell = (s) => text(s).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/**
 * @param {{ subject: object, candidate: object, switches?: object, host?: string, checkedAt?: number }} args
 * candidate: { notification, trace, recipients } as in the report. Names are shown, email addresses are not.
 */
export function notifyToMarkdown({ subject = {}, candidate, switches = emptySwitches(), host = '', checkedAt = Date.now() }) {
  const lines = [`# Why wasn't the email sent? ${subject.label || subject.table || ''}`.trim(), ''];
  lines.push(`Record: ${subject.table || '?'} ${subject.label || ''}${host ? ` on ${host}` : ''}. Checked ${whenText(new Date(checkedAt).toISOString().slice(0, 19).replace('T', ' '))}.`, '');
  if (!candidate) {
    lines.push('No notification was selected.');
    return lines.join('\n');
  }
  const { notification: n, trace, recipients } = candidate;
  lines.push(`## ${n.name}`, '', `- Sends ${triggerText(n)}${n.active ? '' : ' (inactive)'}.`);
  if (n.condition) lines.push(`- Condition: \`${n.condition}\``);
  if (n.advancedCondition) lines.push('- Has an advanced condition script (not run by the tracer).');
  lines.push('', `**Result: ${trace.verdict.headline}**`);
  if (trace.verdict.advice) lines.push('', `Next: ${trace.verdict.advice}`);
  lines.push('', '| Step | Result | What was found |', '| --- | --- | --- |');
  trace.stages.forEach((s) => lines.push(`| ${s.label} | ${STAGE_MARK[s.status]} | ${cell(s.headline)} |`));
  if (recipients) {
    lines.push('', `### Recipients (${recipients.counts.receive} would receive it, ${recipients.counts.blocked} would not)`, '');
    recipients.people.forEach((p) => {
      lines.push(`- ${p.name}: ${p.status === 'receives' ? 'would receive it' : `would NOT receive it. ${p.reasons.map((r) => r.text).join(' ')}`}`);
    });
    recipients.issues.filter((i) => i.level !== 'info').forEach((i) => lines.push(`- Note: ${i.text}`));
  }
  if (switches.findings.length) {
    lines.push('', '### Instance settings', '');
    switches.findings.forEach((f) => lines.push(`- ${f.text}`));
  }
  if (trace.events.length) {
    lines.push('', '### Events', '');
    trace.events.slice(0, 5).forEach((e) => lines.push(`- ${e.name}, ${e.label.toLowerCase()}, queued ${whenText(e.createdOn)}${e.userName ? ` by ${e.userName}` : ''}`));
  }
  if (trace.emails.length) {
    lines.push('', '### Emails', '');
    trace.emails.slice(0, 5).forEach((e) => lines.push(`- ${e.label}: "${clip(e.subject, 80)}", ${whenText(e.createdOn)}${e.error ? `, error: ${clip(e.error, 120)}` : ''}`));
  }
  return maskAddresses(lines.join('\n'));
}

/** The notification-centred report (a sysevent_email_action page, or /notify <name>) as Markdown. Names, not addresses. */
export function notificationToMarkdown({ notification: n, recipients = null, matching = null, events = [], emails = [], switches = emptySwitches(), host = '', checkedAt = Date.now() }) {
  const lines = [`# Notification: ${n.name}`, ''];
  lines.push(`${host ? `Instance ${host}. ` : ''}Checked ${whenText(new Date(checkedAt).toISOString().slice(0, 19).replace('T', ' '))}.`, '');
  lines.push(`- ${n.active ? 'Active' : 'INACTIVE'}; on ${n.table || '?'}; sends ${triggerText(n)}.`);
  if (n.condition) lines.push(`- Condition: \`${n.condition}\``);
  if (n.advancedCondition) lines.push('- Has an advanced condition script (not run by the tracer).');
  if (matching) {
    if (matching.all) lines.push(`- No condition: it applies to every ${n.table} record.`);
    else if (matching.error) lines.push(`- Records that meet the condition now: could not be counted (${clip(matching.error, 100)}).`);
    else if (matching.skipped) lines.push(`- Records that meet the condition now: not counted (${matching.skipped}).`);
    else lines.push(`- Records that meet the condition now: ${matching.count}${matching.sample?.length ? ` (for example ${matching.sample.map((s) => s.label).join(', ')})` : ''}.`);
  }
  if (recipients) {
    lines.push('', `## Recipients (${recipients.counts.receive} would receive it, ${recipients.counts.blocked} would not)`, '');
    recipients.sources.forEach((s) => lines.push(`- ${s.label}: ${s.detail}`));
    recipients.people.filter((p) => p.status === 'blocked').forEach((p) => lines.push(`- Left out: ${p.name}. ${p.reasons.map((r) => r.text).join(' ')}`));
  }
  if (events.length) {
    lines.push('', '## Latest events', '');
    events.slice(0, 5).forEach((e) => lines.push(`- ${e.name}: ${e.label.toLowerCase()}, ${whenText(e.createdOn)}`));
  }
  if (emails.length) {
    lines.push('', '## Latest emails', '');
    emails.slice(0, 5).forEach((e) => lines.push(`- ${e.label}: "${clip(e.subject, 80)}", ${whenText(e.createdOn)}${e.error ? `, error: ${clip(e.error, 120)}` : ''}`));
  }
  if (switches.findings.length) {
    lines.push('', '## Instance settings', '');
    switches.findings.forEach((f) => lines.push(`- ${f.text}`));
  }
  return maskAddresses(lines.join('\n'));
}
