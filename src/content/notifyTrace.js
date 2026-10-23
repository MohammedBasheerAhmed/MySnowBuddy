// "Why wasn't the email sent?", the instance half. Reads the notifications that could fire for the record on screen
// (including those on parent tables and inactive ones), the events and emails the record produced, the people the
// notification would send to, and the properties that switch outbound mail off, then hands everything to
// src/lib/notifyTrace.js, which names the first broken link. Read-only: nothing here writes to the instance.
//
// ServiceNow drops a query condition on a column it does not know and returns every row, so: columns used in
// conditions are checked on the rows that come back (instance on sysevent and sys_email), and sys_email.notification
// is probed before it is used as a filter. A table that cannot be read becomes a note in the report, never "nothing
// found".

import { queryTable, countRecords } from './tableApi.js';
import { tableHierarchy } from './fieldInspector.js';
import { isAdminSession } from './adminSession.js';
import { classifyEnvironment } from '../lib/instances.js';
import { redactSecrets } from '../providers/redact.js';
import {
  SYS_ID_RE,
  SWITCH_PROPERTIES,
  flatRow,
  normalizeNotification,
  normalizeEvent,
  normalizeEmail,
  normalizeUser,
  normalizeGroup,
  normalizeDevice,
  buildDirectory,
  recipientIdsNeeded,
  expandRecipients,
  conditionQuery,
  conditionCheckable,
  interpretCondition,
  evaluateLocally,
  conditionLines,
  traceNotification,
  sortCandidates,
  readSwitches,
  classifyEvent,
  classifyEmail,
  matchEmails,
  triggerText,
  emailPreviewText,
  looksSecretMail,
  recordPath,
  parseSnTime,
  whenText,
  isInbound,
  conditionFieldsMissing,
  applyEmailLog,
  switchRowsOrThrow,
  hiddenTableMessage,
} from '../lib/notifyTrace.js';

const TABLE_RE = /^[a-z][a-z0-9_]{0,79}$/;
const EVENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const EMAIL_RE = /^[^\s^,;<>]{1,120}@[^\s^,;<>]{1,120}$/;

const NOTIFICATION_FIELDS = [
  'sys_id', 'name', 'collection', 'active', 'generation_type', 'event_name', 'action_insert', 'action_update', 'condition', 'advanced_condition', 'recipient_users',
  'recipient_groups', 'recipient_fields', 'event_parm_1', 'event_parm_2', 'send_self', 'force_delivery', 'subject', 'sys_created_on', 'sys_updated_on', 'sys_updated_by',
];
const EVENT_FIELDS = ['sys_id', 'name', 'state', 'table', 'instance', 'parm1', 'parm2', 'queue', 'sys_created_on', 'processed', 'process_on', 'claimed_by', 'user_id', 'user_name'];
// sys_email has no notification column (confirmed live 2026-10-23): `headers` carries "X-ServiceNow-Source:Notification-<id>".
const EMAIL_FIELDS = ['sys_id', 'type', 'state', 'subject', 'recipients', 'copied', 'blind_copied', 'error_string', 'sys_created_on', 'sys_updated_on', 'instance', 'target_table', 'headers'];
const EMAIL_LOG_FIELDS = ['email', 'event', 'notification'];
const USER_FIELDS = ['sys_id', 'name', 'user_name', 'email', 'active', 'locked_out', 'notification'];

const LIMITS = { notifications: 300, events: 100, emails: 100, members: 300, conditions: 80, users: 400, groups: 25 };

const errorText = (err) => err?.message || String(err);

/** Run `fn` over `items`, at most `size` at a time, keeping the order of the results. */
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop -- bounded concurrency is the point of the pool.
      out[at] = await fn(items[at], at);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/** `field IN a,b,c` in chunks, with display values when asked (queryInChunks does not offer them). */
async function inChunks(table, field, values, fields, { displayValue = false, limit = 200, chunk = 40 } = {}) {
  const unique = [...new Set(values.filter(Boolean))];
  const rows = [];
  for (let i = 0; i < unique.length; i += chunk) {
    // eslint-disable-next-line no-await-in-loop -- sequential chunks keep the load on the instance low.
    rows.push(...(await queryTable(table, `${field}IN${unique.slice(i, i + chunk).join(',')}`, fields, { limit, displayValue })));
  }
  return rows;
}

const hostEnvironment = () => {
  try {
    return classifyEnvironment(String(location.hostname || '').split('.')[0])?.env || '';
  } catch {
    return '';
  }
};

// --- Reads --------------------------------------------------------------------------------------------

/** The record on screen: values, display values and the few facts the tracer needs about it. */
async function readRecord(table, sysId) {
  const rows = await queryTable(table, `sys_id=${sysId}`, [], { limit: 1, displayValue: true });
  if (!rows[0]) throw new Error(`The ${table} record was not found (or your account cannot read it).`);
  const { values, display } = flatRow(rows[0]);
  const label = values.number || display.name || values.name || values.short_description || sysId;
  return {
    table,
    sysId,
    values,
    display,
    label: String(label).slice(0, 80),
    createdOn: values.sys_created_on || '',
    updatedOn: values.sys_updated_on || '',
    updatedBy: values.sys_updated_by || '',
    modCount: values.sys_mod_count === undefined || values.sys_mod_count === '' ? null : Number(values.sys_mod_count),
  };
}

async function readNotifications(query, limit = LIMITS.notifications) {
  const rows = await queryTable('sysevent_email_action', query, NOTIFICATION_FIELDS, { limit, displayValue: true });
  return rows.map((row) => {
    const { values, display } = flatRow(row);
    return normalizeNotification(values, display);
  });
}

/** Does the user see any row of `table` at all? One row, one column, no filter. */
async function anyVisible(table) {
  // An admin session reads every table here: an empty one is empty (a fresh PDI has no events yet), not hidden.
  if (await isAdminSession()) return true;
  const rows = await queryTable(table, '', ['sys_id'], { limit: 1 });
  return rows.length > 0;
}

/** Events for a record; rows that do not carry this record's sys_id are dropped (a missing column would match everything). */
async function readEvents(sysId) {
  const rows = await queryTable('sysevent', `instance=${sysId}^ORDERBYDESCsys_created_on`, EVENT_FIELDS, { limit: LIMITS.events });
  if (rows.length && !rows.some((r) => 'instance' in r)) throw new Error('The event table has no instance column on this release, so events cannot be matched to a record.');
  // An ACL hides rows without an error: no event at all is only "none" if the user can see events in the first place.
  if (!rows.length && !(await anyVisible('sysevent'))) throw new Error(hiddenTableMessage('sysevent', 'whether the event fired'));
  return rows.filter((r) => r.instance === sysId).map(normalizeEvent);
}

/** Emails for a record, with the same guards. Each names its notification through its X-ServiceNow-Source header. */
async function readEmails(sysId) {
  const rows = await queryTable('sys_email', `instance=${sysId}^ORDERBYDESCsys_created_on`, EMAIL_FIELDS, { limit: LIMITS.emails, displayValue: true });
  const flat = rows.map(flatRow);
  if (flat.length && !flat.some((r) => 'instance' in r.values)) throw new Error('The email table has no instance column on this release, so emails cannot be matched to a record.');
  if (!flat.length && !(await anyVisible('sys_email'))) throw new Error(hiddenTableMessage('sys_email', 'whether an email was created'));
  const mine = flat.filter((r) => r.values.instance === sysId);
  return { emails: mine.map((r) => normalizeEmail(r.values)), truncated: rows.length >= LIMITS.emails };
}

/**
 * sys_email_log rows ({ email, event, notification }, all references) for a set of emails: the platform's own record of
 * which notification and event produced each one. Chunked and capped; rows for other emails (an ignored filter) are dropped.
 */
async function readEmailLog(emailIds) {
  const ids = [...new Set(emailIds.filter((id) => SYS_ID_RE.test(id)))].slice(0, LIMITS.emails);
  if (!ids.length) return [];
  const rows = await inChunks('sys_email_log', 'email', ids, EMAIL_LOG_FIELDS, { limit: 400, chunk: 40 });
  const want = new Set(ids);
  const value = (cell) => String((cell && typeof cell === 'object' ? cell.value : cell) ?? '');
  return rows.map((r) => ({ email: value(r.email), event: value(r.event), notification: value(r.notification) })).filter((r) => want.has(r.email));
}

async function readSwitchesFromInstance() {
  const rows = await queryTable('sys_properties', `nameIN${SWITCH_PROPERTIES.join(',')}`, ['name', 'value', 'type'], { limit: 10 });
  // Nothing secret is ever asked for; a password-typed property would still be dropped. No rows at all is an error, not "all fine".
  return readSwitches(switchRowsOrThrow(rows).filter((r) => !/password|secret/i.test(String(r.type || ''))), { hostEnvironment: hostEnvironment() });
}

/**
 * Users, groups, group members and notification devices for a set of ids. Anything that cannot be read becomes a note;
 * `devices` stays null (= not checked) when the device table is unavailable.
 */
async function readDirectory({ userIds, groupIds, unknownIds }, notes) {
  const wantUsers = [...new Set([...userIds, ...unknownIds])].filter((id) => SYS_ID_RE.test(id)).slice(0, LIMITS.users);
  let userRows = [];
  if (wantUsers.length) {
    userRows = await inChunks('sys_user', 'sys_id', wantUsers, USER_FIELDS, { displayValue: true }).catch((err) => {
      notes.push(`Users could not be read, so who would receive it is incomplete: ${errorText(err)}`);
      return [];
    });
  }
  const users = userRows.map((row) => {
    const { values, display } = flatRow(row);
    return normalizeUser(values, display);
  });
  const foundUsers = new Set(users.map((u) => u.sysId));
  const groupWanted = [...new Set([...groupIds, ...unknownIds.filter((id) => !foundUsers.has(id))])].filter((id) => SYS_ID_RE.test(id));
  let groups = [];
  if (groupWanted.length) {
    groups = (await inChunks('sys_user_group', 'sys_id', groupWanted, ['sys_id', 'name', 'active', 'email', 'include_members']).catch((err) => {
      notes.push(`Groups could not be read: ${errorText(err)}`);
      return [];
    })).map(normalizeGroup);
  }
  const members = [];
  const capped = [];
  // One members read per group: keep the number of requests bounded on a table with many group-based notifications.
  const groupsToExpand = groups.slice(0, LIMITS.groups);
  const unread = groups.slice(LIMITS.groups).map((g) => g.sysId);
  if (unread.length) notes.push(`Only the members of the first ${LIMITS.groups} of ${groups.length} recipient groups were read.`);
  await pool(groupsToExpand, 4, async (group) => {
    try {
      const rows = await queryTable('sys_user_grmember', `group=${group.sysId}`, ['group', 'user'], { limit: LIMITS.members });
      const value = (cell) => (cell && typeof cell === 'object' ? cell.value : cell);
      // A membership row for another group would mean the condition was ignored: drop it rather than list strangers.
      rows.filter((r) => value(r.group) === group.sysId).forEach((r) => members.push({ group: group.sysId, user: value(r.user) }));
      if (rows.length >= LIMITS.members) capped.push(group.sysId);
    } catch (err) {
      unread.push(group.sysId);
      notes.push(`The members of ${group.name} could not be read: ${errorText(err)}`);
    }
  });
  const extraIds = [...new Set(members.map((m) => m.user))].filter((id) => SYS_ID_RE.test(id) && !foundUsers.has(id)).slice(0, LIMITS.users);
  if (extraIds.length) {
    const more = await inChunks('sys_user', 'sys_id', extraIds, USER_FIELDS, { displayValue: true }).catch((err) => {
      notes.push(`Some group members could not be read: ${errorText(err)}`);
      return [];
    });
    more.forEach((row) => {
      const { values, display } = flatRow(row);
      users.push(normalizeUser(values, display));
    });
  }
  let devices = null;
  const everyone = users.map((u) => u.sysId).slice(0, LIMITS.users);
  if (everyone.length) {
    try {
      devices = (await inChunks('cmn_notif_device', 'user', everyone, ['user', 'type', 'active', 'email_address', 'name'], { limit: 500 })).map(normalizeDevice);
    } catch (err) {
      notes.push(`Notification devices were not checked (${errorText(err)}).`);
    }
  } else {
    devices = [];
  }
  return buildDirectory({ users, groups, members, devices, capped, unread });
}

/** Does the instance say this record meets the condition? true / false, or throws when it cannot say. */
async function recordMeetsCondition(table, sysId, condition) {
  const rows = await queryTable(table, conditionQuery(sysId, condition), ['sys_id'], { limit: 1 });
  return rows.some((r) => r.sys_id === sysId);
}

// --- The record report ---------------------------------------------------------------------------------

const creatorOf = (notification, latestEvent, record) => {
  if (notification.kind === 'event' && latestEvent) {
    return { userIds: latestEvent.userId ? [latestEvent.userId] : [], userNames: latestEvent.userName ? [latestEvent.userName] : [], source: 'event' };
  }
  return { userIds: [], userNames: record.updatedBy ? [record.updatedBy] : [], source: 'save' };
};

/**
 * Everything about one record: each notification that could fire for it, walked through the chain.
 * @param {string} table
 * @param {string} sysId
 * @param {{ focusName?: string, focusNotificationId?: string, onProgress?: (text: string) => void }} [options]
 */
export async function loadRecordReport(table, sysId, { focusName = '', focusNotificationId = '', focusEventName = '', onProgress = () => {} } = {}) {
  if (!TABLE_RE.test(table || '') || !SYS_ID_RE.test(sysId || '')) throw new Error('Open a saved record first. This traces the emails of a record that exists.');
  const notes = [];
  const sections = {};
  const now = Date.now();

  onProgress('Reading the record, its notifications, events and emails...');
  const chain = await tableHierarchy(table).catch((err) => {
    notes.push(`The table hierarchy could not be read, so only notifications defined on ${table} itself are listed: ${errorText(err)}`);
    return [table];
  });
  const [recordResult, notificationResult, eventResult, emailResult, switchResult] = await Promise.allSettled([
    readRecord(table, sysId),
    readNotifications(`collectionIN${chain.join(',')}^ORDERBYname`),
    readEvents(sysId),
    readEmails(sysId),
    readSwitchesFromInstance(),
  ]);
  if (recordResult.status === 'rejected') throw recordResult.reason;
  const record = { ...recordResult.value, chain };
  if (notificationResult.status === 'rejected') {
    sections.notifications = { ok: false, error: errorText(notificationResult.reason) };
  } else sections.notifications = { ok: true };
  sections.events = eventResult.status === 'fulfilled' ? { ok: true } : { ok: false, error: errorText(eventResult.reason) };
  sections.emails = emailResult.status === 'fulfilled' ? { ok: true } : { ok: false, error: errorText(emailResult.reason) };
  sections.switches = switchResult.status === 'fulfilled' ? { ok: true } : { ok: false, error: errorText(switchResult.reason) };

  const notifications = notificationResult.status === 'fulfilled' ? notificationResult.value : [];
  const events = eventResult.status === 'fulfilled' ? eventResult.value : [];
  const emailRead = emailResult.status === 'fulfilled' ? emailResult.value : { emails: [] };
  const switches = switchResult.status === 'fulfilled' ? switchResult.value : readSwitches([], { hostEnvironment: hostEnvironment() });
  if (notifications.length >= LIMITS.notifications) notes.push(`More than ${LIMITS.notifications} notifications apply to this table; the list is cut.`);
  if (events.length >= LIMITS.events) notes.push(`Only the newest ${LIMITS.events} events for this record were read; an older one may be missing from the trace.`);
  if (emailRead.truncated) notes.push(`Only the newest ${LIMITS.emails} emails for this record were read.`);

  // The email log ties each email to its notification and event exactly. Without it the header still names the notification.
  if (emailRead.emails.length) {
    try {
      emailRead.emails = applyEmailLog(emailRead.emails, await readEmailLog(emailRead.emails.map((e) => e.sysId)));
      sections.emailLog = { ok: true };
    } catch (err) {
      sections.emailLog = { ok: false, error: errorText(err) };
      notes.push(`The email log (sys_email_log) could not be read, so emails are tied to a notification by their header only: ${errorText(err)}`);
    }
  }
  const unlinked = emailRead.emails.filter((e) => !isInbound(e) && !e.linkKnown).length;
  if (unlinked) notes.push(`${unlinked === 1 ? '1 email' : `${unlinked} emails`} for this record carry no notification header and no email log entry, so they were matched to a notification by subject only.`);

  // Conditions: ask the instance whether THIS record meets each one.
  onProgress(`Checking ${notifications.filter((n) => n.condition).length} conditions against the record...`);
  // Active ones first, so the cap never spends the requests on inactive notifications while an active one goes unasked.
  const toCheck = notifications
    .filter((n) => n.condition && conditionCheckable(n.condition).checkable)
    .sort((a, b) => Number(b.active) - Number(a.active))
    .slice(0, LIMITS.conditions);
  const answers = new Map();
  await pool(toCheck, 5, async (n) => {
    try {
      answers.set(n.sysId, { matched: await recordMeetsCondition(table, sysId, n.condition), error: '' });
    } catch (err) {
      answers.set(n.sysId, { matched: null, error: errorText(err) });
    }
  });
  const conditions = new Map(
    notifications.map((n) => {
      const answer = answers.get(n.sysId) || { matched: null, error: '' };
      const local = n.condition ? evaluateLocally(n.condition, record) : null;
      const missing = n.condition ? conditionFieldsMissing(n.condition, record.values) : [];
      return [n.sysId, interpretCondition({ condition: n.condition, matched: answer.matched, error: answer.error, local, missing })];
    })
  );

  // Recipient fields, read from the record (dot-walked ones with a second query).
  const fieldValues = {};
  const walked = [];
  notifications.forEach((n) =>
    n.recipientFields.forEach((f) => {
      if (f in record.values) fieldValues[f] = { value: record.values[f], display: record.display[f] || '' };
      else if (f.includes('.')) walked.push(f);
    })
  );
  const walkedFields = [...new Set(walked)];
  if (walkedFields.length) {
    try {
      const rows = await queryTable(table, `sys_id=${sysId}`, walkedFields, { limit: 1 });
      walkedFields.forEach((f) => {
        if (rows[0] && f in rows[0]) fieldValues[f] = { value: String(rows[0][f] ?? ''), display: '' };
      });
    } catch (err) {
      notes.push(`Dot-walked recipient fields could not be read: ${errorText(err)}`);
    }
  }

  // People: one directory for every notification that is active or in focus.
  onProgress('Reading the people each notification would send to...');
  // With a manageable number of notifications every one is expanded (so an inactive one can be opened too); otherwise only active or focused ones.
  const wanted = notifications.length <= 60 ? notifications : notifications.filter((n) => n.active || n.sysId === focusNotificationId || (focusName && n.name.toLowerCase().includes(focusName.toLowerCase())));
  const isWanted = new Set(wanted.map((n) => n.sysId));
  const latestEventOf = (n) => (n.kind === 'event' ? events.filter((e) => e.name === n.eventName).sort((a, b) => (parseSnTime(b.createdOn) ?? 0) - (parseSnTime(a.createdOn) ?? 0))[0] : null);
  const latestEvents = new Map(wanted.map((n) => [n.sysId, latestEventOf(n)]));
  const parms = [...latestEvents.values()].filter(Boolean).flatMap((e) => [e.parm1, e.parm2]);
  const creatorIds = [...latestEvents.values()].filter(Boolean).map((e) => e.userId);
  const need = recipientIdsNeeded(wanted, { fieldValues, parms, creatorIds });
  let directory = null;
  let directoryError = '';
  try {
    directory = await readDirectory({ userIds: need.users, groupIds: need.groups, unknownIds: need.unknown }, notes);
  } catch (err) {
    directoryError = errorText(err);
    sections.recipients = { ok: false, error: directoryError };
  }
  if (directory) sections.recipients = { ok: true };

  const candidates = notifications.map((notification) => {
    const latestEvent = latestEvents.get(notification.sysId) || latestEventOf(notification);
    const recipients =
      directory && isWanted.has(notification.sysId)
        ? expandRecipients({ notification, directory, fieldValues, creator: creatorOf(notification, latestEvent, record), parms: { parm1: latestEvent?.parm1 || '', parm2: latestEvent?.parm2 || '' } })
        : null;
    const condition = conditions.get(notification.sysId);
    const trace = traceNotification({
      notification,
      record,
      condition,
      events,
      emails: emailRead.emails,
      eventsError: sections.events.ok ? '' : sections.events.error,
      emailsError: sections.emails.ok ? '' : sections.emails.error,
      recipients,
      recipientsError: directoryError,
      switches,
      now,
    });
    return {
      notification: { ...notification, href: recordPath('sysevent_email_action', notification.sysId), triggerText: triggerText(notification), conditionLines: notification.condition ? conditionLines(notification.condition) : [], inherited: notification.table !== table },
      condition,
      recipients,
      trace,
    };
  });
  const sorted = sortCandidates(candidates);

  let selectedId = '';
  let focusMissing = '';
  if (focusNotificationId && sorted.some((c) => c.notification.sysId === focusNotificationId)) selectedId = focusNotificationId;
  else if (focusEventName && sorted.some((c) => c.notification.eventName === focusEventName)) selectedId = sorted.find((c) => c.notification.eventName === focusEventName).notification.sysId;
  else if (focusName) {
    const hit = sorted.find((c) => c.notification.name.toLowerCase().includes(focusName.toLowerCase()));
    if (hit) selectedId = hit.notification.sysId;
    else focusMissing = focusName;
  }
  if (!selectedId && sorted.length) selectedId = sorted[0].notification.sysId;
  let focusElsewhere = [];
  if (focusMissing) {
    focusElsewhere = await readNotifications(`nameLIKE${focusMissing.replace(/\^/g, ' ')}^ORDERBYname`, 5).then((list) => list.map((x) => ({ sysId: x.sysId, name: x.name, table: x.table, href: recordPath('sysevent_email_action', x.sysId) })), () => []);
  }

  const allEmails = emailRead.emails.map((e) => ({ ...e, ...classifyEmail(e, now), href: recordPath('sys_email', e.sysId) }));
  const allEvents = events.map((e) => ({ ...e, ...classifyEvent(e, now), href: recordPath('sysevent', e.sysId) }));
  const claimed = new Set(sorted.flatMap((c) => c.trace.emails.map((e) => e.sysId)));

  return {
    mode: 'record',
    generatedAt: now,
    host: typeof location !== 'undefined' ? location.hostname : '',
    subject: { table, sysId, label: record.label, chain, createdOn: record.createdOn, updatedOn: record.updatedOn, href: recordPath(table, sysId) },
    candidates: sorted,
    selectedId,
    focusMissing,
    focusElsewhere,
    events: allEvents,
    emails: allEmails,
    unmatchedEmails: allEmails.filter((e) => !claimed.has(e.sysId)),
    emailsUnlinked: unlinked,
    switches,
    sections,
    notes,
    listHref: `/sysevent_email_action_list.do?sysparm_query=${encodeURIComponent(`collectionIN${chain.join(',')}`)}`,
  };
}

// --- The email report: "why did this email go to these people?" -------------------------------------------

async function loadEmailReport(emailId, options) {
  const rows = await queryTable('sys_email', `sys_id=${emailId}`, EMAIL_FIELDS, { limit: 1, displayValue: true });
  if (!rows[0]) throw new Error('The email was not found (or your account cannot read it).');
  const { values, display } = flatRow(rows[0]);
  const email = normalizeEmail(values, display);
  const now = Date.now();
  const classified = { ...email, ...classifyEmail(email, now), href: recordPath('sys_email', email.sysId) };

  // Each address once per kind (a list can repeat one, and the panel keys rows by kind and address).
  const seenAddress = new Set();
  const addresses = [
    ...email.recipients.map((address) => ({ address, kind: 'To' })),
    ...email.copied.map((address) => ({ address, kind: 'Cc' })),
    ...email.blindCopied.map((address) => ({ address, kind: 'Bcc' })),
  ].filter((a) => !seenAddress.has(`${a.kind}:${a.address}`) && seenAddress.add(`${a.kind}:${a.address}`));
  const valid = [...new Set(addresses.map((a) => a.address))].filter((a) => EMAIL_RE.test(a));
  const known = new Map();
  if (valid.length) {
    try {
      const found = await inChunks('sys_user', 'email', valid, ['sys_id', 'name', 'user_name', 'email', 'active'], { limit: 200, chunk: 20 });
      found.forEach((u) => known.set(String(u.email).toLowerCase(), u));
    } catch {
      // The people behind the addresses are a bonus; the email itself is the answer.
    }
  }

  const hasTarget = TABLE_RE.test(email.targetTable) && SYS_ID_RE.test(email.instance);
  let base = null;
  if (hasTarget) {
    base = await loadRecordReport(email.targetTable, email.instance, { ...options, focusNotificationId: email.notificationId || '' }).catch((err) => ({ error: errorText(err) }));
  }

  let selectedId = '';
  let recipientsExplained = [];
  let trigger = null;
  if (isInbound(email)) {
    // A reply that came in: no notification sent it, so its addresses are not a recipient list to explain.
    trigger = { kind: 'inbound', text: 'The instance received this email (a reply or a new message); no notification sent it. The notifications below are traced for the record it belongs to.' };
    recipientsExplained = [];
    selectedId = base && !base.error ? base.selectedId : '';
  } else if (base && !base.error) {
    // The record report has applied the email log: its copy of this email knows the notification and event exactly.
    const logged = base.emails.find((e) => e.sysId === email.sysId);
    const own = base.candidates.find((c) => c.trace.emails.some((e) => e.sysId === email.sysId));
    selectedId = own ? own.notification.sysId : base.selectedId;
    const chosen = base.candidates.find((c) => c.notification.sysId === selectedId);
    const people = chosen?.recipients?.people || [];
    recipientsExplained = addresses.map(({ address, kind }) => {
      const person = people.find((p) => (p.email || '').toLowerCase() === address);
      const user = known.get(address);
      return {
        address,
        kind,
        name: person?.name || user?.name || '',
        sources: person ? person.sources : [],
        explained: Boolean(person),
        activeUser: user ? user.active !== 'false' : null,
        note: person ? '' : user ? 'This person is not on the notification\'s recipient list as it is now. The notification may have changed since the email was made, or the address came from somewhere else (a watch list, a forwarded copy, a script).' : 'No user has this address. It is a plain address.',
      };
    });
    const exactEvent = logged?.eventId ? base.events.find((e) => e.sysId === logged.eventId) : null;
    if (exactEvent) {
      trigger = { kind: 'event', event: exactEvent, text: `Triggered by the event ${exactEvent.name}, queued ${whenText(exactEvent.createdOn) || 'at an unknown time'}${exactEvent.userName ? ` by ${exactEvent.userName}` : ''} (named in the email log).` };
    } else if (chosen && chosen.notification.kind === 'event') {
      const at = parseSnTime(email.createdOn) ?? Infinity;
      const ev = base.events.filter((e) => e.name === chosen.notification.eventName && (parseSnTime(e.createdOn) ?? 0) <= at + 2000).sort((a, b) => (parseSnTime(b.createdOn) ?? 0) - (parseSnTime(a.createdOn) ?? 0))[0];
      trigger = ev ? { kind: 'event', event: ev, text: `Triggered by the event ${ev.name}, queued ${whenText(ev.createdOn) || 'at an unknown time'}${ev.userName ? ` by ${ev.userName}` : ''}.` } : { kind: 'event-missing', text: `This notification waits for the event ${chosen.notification.eventName}, but no such event is on file for the record before the email (events are cleaned out after about a week).` };
    } else if (chosen) {
      trigger = { kind: 'save', text: chosen.notification.kind === 'engine' ? `Created because the record was ${[chosen.notification.onInsert && 'inserted', chosen.notification.onUpdate && 'updated'].filter(Boolean).join(' or ')} (no event is involved).` : 'The notification is triggered by a flow, workflow or script; the caller is not visible here.' };
    }
  } else {
    recipientsExplained = addresses.map(({ address, kind }) => {
      const user = known.get(address);
      return { address, kind, name: user?.name || '', sources: [], explained: false, activeUser: user ? user.active !== 'false' : null, note: user ? '' : 'No user has this address. It is a plain address.' };
    });
  }

  return {
    ...(base && !base.error ? base : { mode: 'email', generatedAt: now, candidates: [], events: [], emails: [], unmatchedEmails: [], switches: readSwitches([], {}), sections: {}, notes: [], subject: null }),
    mode: 'email',
    selectedId: selectedId || base?.selectedId || '',
    email: classified,
    recipientsExplained,
    trigger,
    targetError: base?.error || (hasTarget ? '' : 'This email is not tied to a record (no target table and instance), so what triggered it cannot be traced.'),
  };
}

/** An event page: trace the record the event was queued for, on the notifications that listen to this event. */
async function loadEventReport(eventId, options) {
  const rows = await queryTable('sysevent', `sys_id=${eventId}`, ['sys_id', 'name', 'table', 'instance'], { limit: 1 });
  const ev = rows[0];
  if (!ev) throw new Error('The event was not found (or your account cannot read it).');
  if (!TABLE_RE.test(String(ev.table || '')) || !SYS_ID_RE.test(String(ev.instance || ''))) {
    throw new Error(`This event (${ev.name || 'unnamed'}) is not tied to a record, so there is no record to trace its emails for.`);
  }
  return loadRecordReport(ev.table, ev.instance, { ...options, focusEventName: String(ev.name || '') });
}

// --- The notification report: "which records would this fire for, what did it last send?" ----------------------

async function loadNotificationReport({ id = '', name = '' }, { onProgress = () => {} } = {}) {
  const notes = [];
  onProgress('Reading the notification...');
  let list = [];
  if (SYS_ID_RE.test(id)) list = await readNotifications(`sys_id=${id}`, 1);
  else if (name) list = await readNotifications(`nameLIKE${name.replace(/\^/g, ' ').slice(0, 80)}^ORDERBYname`, 15);
  if (!list.length) throw new Error(name ? `No notification with a name containing "${name}" was found (or your account cannot read it).` : 'The notification was not found.');
  const exact = list.find((n) => n.name.toLowerCase() === name.toLowerCase());
  const n = exact || list[0];
  const others = list.filter((x) => x.sysId !== n.sysId).map((x) => ({ sysId: x.sysId, name: x.name, table: x.table, href: recordPath('sysevent_email_action', x.sysId) }));
  const now = Date.now();

  const sections = {};
  onProgress('Reading its recipients, events and emails...');
  const need = recipientIdsNeeded([n], {});
  const directoryPromise = readDirectory({ userIds: need.users, groupIds: need.groups, unknownIds: [] }, notes).then((d) => ({ d }), (err) => ({ err }));

  const eventsPromise =
    n.kind === 'event' && EVENT_NAME_RE.test(n.eventName)
      ? (async () => {
          const rows = await queryTable('sysevent', `name=${n.eventName}^ORDERBYDESCsys_created_on`, EVENT_FIELDS, { limit: 10 });
          if (!rows.length && !(await anyVisible('sysevent'))) throw new Error(hiddenTableMessage('sysevent', 'its events'));
          return rows.map(normalizeEvent).filter((e) => e.name === n.eventName);
        })().catch((err) => ({ err }))
      : Promise.resolve([]);

  // The email log names every email this notification produced. When it is unreadable or has nothing, the newest 100 emails
  // for records of the notification's table are checked by their X-ServiceNow-Source header (subject only as a last resort).
  const emailsPromise = (async () => {
    try {
      const value = (cell) => String((cell && typeof cell === 'object' ? cell.value : cell) ?? '');
      let logIds = [];
      let logNote = '';
      try {
        const logRows = await queryTable('sys_email_log', `notification=${n.sysId}^ORDERBYDESCsys_created_on`, EMAIL_LOG_FIELDS, { limit: 30 });
        // A row for another notification would mean the filter was ignored: only this one's rows are used.
        logIds = [...new Set(logRows.filter((r) => value(r.notification) === n.sysId).map((r) => value(r.email)))].filter((id) => SYS_ID_RE.test(id)).slice(0, 10);
      } catch (err) {
        logNote = `The email log (sys_email_log) could not be read: ${errorText(err)}`;
      }
      if (logIds.length) {
        const rows = await queryTable('sys_email', `sys_idIN${logIds.join(',')}^ORDERBYDESCsys_created_on`, EMAIL_FIELDS, { limit: 10, displayValue: true });
        const want = new Set(logIds);
        return { emails: rows.map(flatRow).filter((r) => want.has(r.values.sys_id)).map((r) => normalizeEmail(r.values)), by: 'log', note: logNote };
      }
      if (!TABLE_RE.test(n.table)) return { emails: [], by: '', note: logNote };
      const rows = await queryTable('sys_email', `target_table=${n.table}^ORDERBYDESCsys_created_on`, EMAIL_FIELDS, { limit: 100, displayValue: true });
      if (!rows.length && !(await anyVisible('sys_email'))) throw new Error(hiddenTableMessage('sys_email', 'its emails'));
      const all = rows.map(flatRow).filter((r) => r.values.target_table === n.table).map((r) => normalizeEmail(r.values));
      const matched = matchEmails(n, all);
      return {
        emails: matched.emails.slice(0, 10),
        by: matched.by.includes('subject') ? 'subject' : 'header',
        // target_table holds the record's own table, so mail for records of a table that extends this one is not searched.
        note: [logNote, `Emails were looked for among the newest 100 emails for ${n.table} records only; emails for records of tables that extend ${n.table} were not searched.`].filter(Boolean).join(' '),
      };
    } catch (err) {
      return { err };
    }
  })();

  let matching = null;
  const checkable = conditionCheckable(n.condition);
  if (!n.condition) {
    matching = { all: true };
  } else if (TABLE_RE.test(n.table) && checkable.checkable) {
    matching = await (async () => {
      try {
        const query = n.condition.replace(/\^EQ$/, '');
        const count = await countRecords(n.table, query);
        const sample = count ? await queryTable(n.table, query, ['sys_id', 'number', 'name', 'short_description'], { limit: 5 }) : [];
        return { count, sample: sample.map((r) => ({ sysId: r.sys_id, label: String(r.number || r.name || r.short_description || r.sys_id).slice(0, 80), href: recordPath(n.table, r.sys_id) })) };
      } catch (err) {
        return { error: errorText(err) };
      }
    })();
  } else {
    matching = { skipped: checkable.why || 'the table name is not usable' };
  }

  const switchesPromise = readSwitchesFromInstance().then(
    (value) => ({ value }),
    (err) => ({ value: readSwitches([], { hostEnvironment: hostEnvironment() }), err })
  );
  const [dir, events, emails, switchRead] = await Promise.all([directoryPromise, eventsPromise, emailsPromise, switchesPromise]);
  const switches = switchRead.value;
  sections.switches = switchRead.err ? { ok: false, error: errorText(switchRead.err) } : { ok: true };
  sections.recipients = dir.err ? { ok: false, error: errorText(dir.err) } : { ok: true };
  sections.events = events.err ? { ok: false, error: errorText(events.err) } : { ok: true };
  sections.emails = emails.err ? { ok: false, error: errorText(emails.err) } : { ok: true };
  const recipients = dir.d ? expandRecipients({ notification: n, directory: dir.d, noRecord: true }) : null;
  const eventList = Array.isArray(events) ? events.map((e) => ({ ...e, ...classifyEvent(e, now), href: recordPath('sysevent', e.sysId) })) : [];
  const emailList = emails.err ? [] : emails.emails.map((e) => ({ ...e, ...classifyEmail(e, now), href: recordPath('sys_email', e.sysId) }));
  if (emails.note) notes.push(emails.note);

  return {
    mode: 'notification',
    generatedAt: now,
    host: typeof location !== 'undefined' ? location.hostname : '',
    notification: { ...n, href: recordPath('sysevent_email_action', n.sysId), triggerText: triggerText(n), conditionLines: n.condition ? conditionLines(n.condition) : [] },
    others,
    recipients,
    events: eventList,
    emails: emailList,
    emailsBy: emails.by || '',
    matching,
    switches,
    sections,
    notes,
  };
}

// --- Entry points --------------------------------------------------------------------------------------

/**
 * The report for whatever is on screen: a record, an email (sys_email), a notification (sysevent_email_action), or a
 * notification named in `args`.
 * @param {{ context?: object, args?: string, notificationId?: string, onProgress?: (text: string) => void }} request
 */
export async function loadNotifyReport({ context = {}, args = '', notificationId = '', onProgress = () => {} } = {}) {
  const table = String(context.table || '');
  const sysId = String(context.sysId || '');
  const onRecord = TABLE_RE.test(table) && SYS_ID_RE.test(sysId) && !context.isList;
  const name = String(args || '').replace(/\s+/g, ' ').trim().slice(0, 80);

  if (onRecord && table === 'sys_email') return loadEmailReport(sysId, { onProgress });
  if (onRecord && table === 'sysevent_email_action') return loadNotificationReport({ id: sysId }, { onProgress });
  if (onRecord && table === 'sysevent') return loadEventReport(sysId, { onProgress });
  if (onRecord) return loadRecordReport(table, sysId, { focusName: name, focusNotificationId: SYS_ID_RE.test(notificationId) ? notificationId : '', onProgress });
  if (name) return loadNotificationReport({ name }, { onProgress });
  return { mode: 'none', generatedAt: Date.now(), candidates: [], notes: [], sections: {} };
}

/**
 * A safe text preview of one email: tags stripped, secrets redacted, never HTML. Mail that looks like it carries a
 * password or a one-time code is not shown at all.
 */
export async function previewEmailText({ sysId }) {
  if (!SYS_ID_RE.test(sysId || '')) throw new Error('That is not an email record.');
  const rows = await queryTable('sys_email', `sys_id=${sysId}`, ['sys_id', 'subject', 'body', 'body_text'], { limit: 1, displayValue: true });
  if (!rows[0]) throw new Error('The email was not found (or your account cannot read it).');
  const { values } = flatRow(rows[0]);
  if (looksSecretMail(values.subject)) {
    return { hidden: true, text: '', reason: 'This email looks like it carries a password, a code or a link that signs someone in, so its text is not shown here. Open the record if you need it.' };
  }
  const source = (values.body_text || '').trim() ? values.body_text : values.body || '';
  if (!source.trim()) return { hidden: false, text: '', empty: true, truncated: false };
  const { text, truncated } = emailPreviewText(source);
  return { hidden: false, text: redactSecrets(text), truncated, empty: !text };
}

export const notifyServices = {
  notifyReport: (args) => loadNotifyReport(args),
  notifyEmailText: (args) => previewEmailText(args),
};

// Called once from src/content/featureStartup.js when the page loads (optional). Nothing to set up: this feature only reads on request.
export function install() {}
