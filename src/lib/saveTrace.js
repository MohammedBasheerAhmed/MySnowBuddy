// Save trace, the pure half: "what happened when I saved?" answered on the form.
//
// Arm it before saving (the instance's own clock and the user are noted), save, then collect everything the platform
// created in that window and merge it into one time-ordered timeline: field changes, log lines, the transaction, the
// update set entries, events, emails, flows, notes, SLAs, approvals, child records and attachments.
//
// This file builds the window, the queries, maps rows to events and formats the result. No DOM, no network
// (the instance half is src/content/saveTrace.js, the panel src/sidebar/SaveTracePanel.jsx).
//
// Two rules the queries follow because the platform is forgiving in ways that mislead:
//   * a condition on a column the release does not have is silently DROPPED and every row comes back, so each row is
//     checked again here against the window (and against the record where it names one);
//   * absolute date-time literals in an encoded query are read in the user's time zone, so the window is written as
//     "N seconds ago" (gs.secondsAgo) and the rows' UTC sys_created_on is compared in code.

export const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const NAME_RE = /^[A-Za-z0-9_.@-]{1,100}$/;
const TABLE_RE = /^[a-z][a-z0-9_]*$/;

export const MARGIN_SECONDS = 2; // the save starts after the click on Arm, but clocks and rounding disagree by a second
export const MAX_WINDOW_SECONDS = 900;
export const GROUP_GAP_MS = 1500;
export const SLOW_TRANSACTION_MS = 3000;

/** How each kind of event is labelled and drawn (icon names are from src/sidebar/Icon.jsx). */
export const KINDS = {
  audit: { label: 'Field change', icon: 'edit', order: 1 },
  delete: { label: 'Deleted', icon: 'trash', order: 2 },
  update: { label: 'Update set', icon: 'layers', order: 3 },
  log: { label: 'Log', icon: 'log', order: 4 },
  transaction: { label: 'Transaction', icon: 'pulse', order: 5 },
  event: { label: 'Event', icon: 'bolt', order: 6 },
  email: { label: 'Email', icon: 'send', order: 7 },
  flow: { label: 'Flow', icon: 'play', order: 8 },
  journal: { label: 'Note', icon: 'book', order: 9 },
  sla: { label: 'SLA', icon: 'clock', order: 10 },
  approval: { label: 'Approval', icon: 'check', order: 11 },
  child: { label: 'New record', icon: 'form', order: 12 },
  attachment: { label: 'Attachment', icon: 'download', order: 13 },
};

// --- Time ---------------------------------------------------------------------------------------------

const UTC_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

/** Milliseconds for a stored "YYYY-MM-DD HH:MM:SS" value (the Table API returns them in UTC), or NaN. */
export function parseUtc(text) {
  const m = UTC_RE.exec(String(text || '').trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

const pad = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD HH:MM:SS" in UTC. */
export function formatUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** The instance's clock from a response's Date header; the local clock when the header is missing (same delta either way). */
export function serverTime(dateHeader, fallbackMs) {
  const ms = Date.parse(String(dateHeader || ''));
  return Number.isFinite(ms) ? ms : fallbackMs;
}

/**
 * The window to collect: from just before Arm to now, never longer than 15 minutes.
 * @returns {{ startMs: number, endMs: number, seconds: number, startUtc: string, endUtc: string, truncated: boolean }}
 */
export function buildWindow({ armedAt, now }) {
  let startMs = Number(armedAt) - MARGIN_SECONDS * 1000;
  const endMs = Number(now);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) throw new Error('The save trace has no valid start time. Arm it again.');
  let truncated = false;
  if (endMs - startMs > MAX_WINDOW_SECONDS * 1000) {
    startMs = endMs - MAX_WINDOW_SECONDS * 1000;
    truncated = true;
  }
  return { startMs, endMs, seconds: Math.ceil((endMs - startMs) / 1000), startUtc: formatUtc(startMs), endUtc: formatUtc(endMs), truncated };
}

/** The window as an encoded-query condition that does not depend on any time zone. */
export const windowCondition = (window) => `sys_created_on>=javascript:gs.secondsAgo(${window.seconds})`;

/** "+1.20s" for an offset in milliseconds. */
export function offsetLabel(ms) {
  const s = Math.max(0, ms) / 1000;
  return `+${s < 10 ? s.toFixed(2) : s < 100 ? s.toFixed(1) : Math.round(s)}s`;
}

// --- Cells and text -----------------------------------------------------------------------------------

/** { value, display } for a Table API cell: a plain string, or { value, display_value } when display values were requested. */
export function cell(v) {
  if (v && typeof v === 'object') return { value: String(v.value ?? ''), display: String(v.display_value ?? v.value ?? '') };
  return { value: String(v ?? ''), display: String(v ?? '') };
}

export const clip = (text, max = 160) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const raw = (row, field) => cell(row?.[field]).value;
const shown = (row, field) => cell(row?.[field]).display;
const truthy = (v) => v === true || /^(true|1|yes)$/i.test(String(v ?? ''));

/** The path of a transaction URL without the query string, shortened. */
export function urlPath(url) {
  const text = String(url || '').split('?')[0];
  return clip(text.replace(/^https?:\/\/[^/]+/i, '') || text, 90);
}

// --- Sources ----------------------------------------------------------------------------------------------

const escapeValue = (v) => String(v).replace(/\^/g, '^^');
const join = (...parts) => parts.filter(Boolean).join('^');

/**
 * The queries for one trace. Every source is independent: the caller runs them in parallel and a failure of one
 * only marks that source. A source that needs the record is skipped (not failed) when it has no sys_id yet.
 * @param {{ table?: string, sysId?: string, userName?: string, window: object, isTask?: boolean }} input
 * @returns {Array<{ id, label, kind, table, fields: string[], query: string, limit: number, skip?: string }>}
 */
export function traceSources({ table = '', sysId = '', userName = '', window, isTask = false }) {
  const win = windowCondition(window);
  const record = SYS_ID_RE.test(sysId) ? sysId.toLowerCase() : '';
  const user = NAME_RE.test(userName) ? escapeValue(userName) : '';
  const needsRecord = 'Needs a saved record: save it, then collect again.';
  const needsUser = 'The session user is not known.';
  const base = ['sys_id', 'sys_created_on'];

  const sources = [
    { id: 'audit', label: 'Field changes (audit)', kind: 'audit', table: 'sys_audit', fields: [...base, 'fieldname', 'oldvalue', 'newvalue', 'user', 'tablename', 'documentkey'], limit: 100, query: join(record && `documentkey=${record}`, win, 'ORDERBYsys_created_on'), skip: record ? '' : needsRecord },
    { id: 'delete', label: 'Deletions (audit)', kind: 'delete', table: 'sys_audit_delete', fields: [...base, 'tablename', 'documentkey', 'display_value', 'user'], limit: 25, query: join(win, user && `user=${user}`, 'ORDERBYsys_created_on'), skip: user ? '' : needsUser },
    { id: 'log', label: 'System log, your session', kind: 'log', table: 'syslog', fields: [...base, 'level', 'source', 'message', 'sys_created_by'], limit: 150, query: join(win, user && `sys_created_by=${user}`, 'ORDERBYsys_created_on'), skip: user ? '' : needsUser },
    { id: 'logOther', label: 'Errors logged by others about this record', kind: 'log', table: 'syslog', fields: [...base, 'level', 'source', 'message', 'sys_created_by'], limit: 40, query: join(win, 'level=2', user && `sys_created_by!=${user}`, 'ORDERBYsys_created_on') },
    { id: 'transaction', label: 'Transactions', kind: 'transaction', table: 'syslog_transaction', fields: [...base, 'url', 'http_method', 'response_time', 'sql_time', 'sql_count', 'business_rule_time', 'business_rule_count', 'status'], limit: 25, query: join(win, user && `sys_created_by=${user}`, 'ORDERBYsys_created_on'), skip: user ? '' : needsUser },
    { id: 'update', label: 'Update set entries', kind: 'update', table: 'sys_update_xml', fields: [...base, 'name', 'type', 'target_name', 'action', 'update_set', 'application'], limit: 60, query: join(win, user && `sys_created_by=${user}`, 'ORDERBYsys_created_on'), skip: user ? '' : needsUser },
    { id: 'event', label: 'Events', kind: 'event', table: 'sysevent', fields: [...base, 'name', 'parm1', 'parm2', 'state', 'table', 'instance'], limit: 50, query: join(win, record ? `instance=${record}` : TABLE_RE.test(table) && `table=${table}`, 'ORDERBYsys_created_on') },
    { id: 'email', label: 'Emails', kind: 'email', table: 'sys_email', fields: [...base, 'type', 'state', 'subject', 'recipients', 'error_string', 'instance'], limit: 25, query: join(win, 'ORDERBYsys_created_on') },
    { id: 'flow', label: 'Flows', kind: 'flow', table: 'sys_flow_context', fields: [...base, 'name', 'state', 'source_table', 'source_record', 'started', 'ended', 'error_message'], limit: 30, query: join(win, 'ORDERBYsys_created_on') },
    { id: 'workflow', label: 'Workflows', kind: 'flow', table: 'wf_context', fields: [...base, 'name', 'state', 'table', 'id', 'started', 'ended'], limit: 20, query: join(win, record && `id=${record}`, 'ORDERBYsys_created_on'), skip: record ? '' : needsRecord },
    { id: 'journal', label: 'Work notes and comments', kind: 'journal', table: 'sys_journal_field', fields: [...base, 'element', 'value', 'sys_created_by', 'element_id'], limit: 20, query: join(record && `element_id=${record}`, win, 'ORDERBYsys_created_on'), skip: record ? '' : needsRecord },
    { id: 'sla', label: 'SLAs', kind: 'sla', table: 'task_sla', fields: [...base, 'sla', 'stage', 'has_breached', 'task'], limit: 20, query: join(record && `task=${record}`, win, 'ORDERBYsys_created_on'), skip: record ? '' : needsRecord },
    { id: 'approval', label: 'Approvals', kind: 'approval', table: 'sysapproval_approver', fields: [...base, 'approver', 'state', 'comments', 'sysapproval'], limit: 20, query: join(record && `sysapproval=${record}`, win, 'ORDERBYsys_created_on'), skip: record ? '' : needsRecord },
    { id: 'attachment', label: 'Attachments', kind: 'attachment', table: 'sys_attachment', fields: [...base, 'file_name', 'size_bytes', 'content_type', 'table_sys_id'], limit: 20, query: join(record && `table_sys_id=${record}`, win, 'ORDERBYsys_created_on'), skip: record ? '' : needsRecord },
  ];
  if (isTask) {
    sources.push({ id: 'child', label: 'Child tasks created', kind: 'child', table: 'task', fields: [...base, 'number', 'short_description', 'sys_class_name', 'parent'], limit: 20, query: join(record && `parent=${record}`, win, 'ORDERBYsys_created_on'), skip: record ? '' : needsRecord });
  }
  return sources;
}

/** 'unavailable' (no such table on this release), 'noaccess', or 'error' for a failed query. */
export function classifyFailure(err) {
  const text = String((err && err.message) || err || '');
  if (/invalid table|table .* (does not exist|not found)|no such table|unknown table/i.test(text)) return { status: 'unavailable', note: 'Not available on this instance.' };
  if (/\b40[13]\b|forbidden|not allowed|access denied|acl|insufficient|security/i.test(text)) return { status: 'noaccess', note: 'Your user cannot read this table.' };
  if (/\b404\b|not found/i.test(text)) return { status: 'unavailable', note: 'Not available on this instance.' };
  return { status: 'error', note: clip(text || 'The query failed.', 140) };
}

// --- Rows to events ---------------------------------------------------------------------------------------

const LEVELS = { 0: 'info', 1: 'warn', 2: 'error', 3: 'info', information: 'info', info: 'info', warning: 'warn', warn: 'warn', error: 'error', debug: 'info' };

/** 'info' | 'warn' | 'error' for a syslog level (number or label). */
export const logLevel = (value) => LEVELS[String(value ?? '').trim().toLowerCase()] || 'info';

const FAILED_STATE = /(error|fail|cancel|abort|timed.?out)/i;

function make(kind, row, extra) {
  return { kind, t: parseUtc(raw(row, 'sys_created_on')), durationMs: null, level: 'info', detail: '', link: null, ...extra };
}

const linkOf = (table, row, field = 'sys_id') => (SYS_ID_RE.test(raw(row, field)) ? { table, sysId: raw(row, field).toLowerCase() } : null);

/** What each source's rows say. `ctx` = { table, sysId, userName }. A row that clearly belongs to another record returns null. */
const MAPPERS = {
  audit(row, ctx) {
    const field = shown(row, 'fieldname') || 'a field';
    const by = shown(row, 'user');
    const change = `${clip(shown(row, 'oldvalue') || '(empty)', 60)} → ${clip(shown(row, 'newvalue') || '(empty)', 60)}`;
    return make('audit', row, { title: `${field} changed`, detail: by && by !== ctx.userName ? `${change} (by ${by})` : change, link: ctx.sysId ? { table: ctx.table, sysId: ctx.sysId } : null });
  },
  delete(row) {
    return make('delete', row, { title: `Deleted ${shown(row, 'tablename') || 'a record'}`, detail: clip(shown(row, 'display_value'), 120), level: 'warn' });
  },
  log(row, ctx, source) {
    const level = logLevel(raw(row, 'level'));
    const message = shown(row, 'message');
    if (source.id === 'logOther') {
      const mentions = [ctx.table && ctx.table.length > 3 ? ctx.table : '', ctx.sysId].filter(Boolean);
      if (!mentions.some((m) => message.includes(m) || shown(row, 'source').includes(m))) return null;
    }
    return make('log', row, { title: shown(row, 'source') || 'Log', detail: clip(message, 400), level: source.id === 'logOther' ? 'error' : level });
  },
  transaction(row) {
    const ms = Number(raw(row, 'response_time'));
    const parts = [];
    const sqlCount = raw(row, 'sql_count');
    const sqlTime = raw(row, 'sql_time');
    if (sqlCount || sqlTime) parts.push(`SQL ${sqlCount || '?'} queries${sqlTime ? `, ${sqlTime} ms` : ''}`);
    const brCount = raw(row, 'business_rule_count');
    const brTime = raw(row, 'business_rule_time');
    if (brCount || brTime) parts.push(`business rules ${brCount || '?'}${brTime ? `, ${brTime} ms` : ''}`);
    const status = raw(row, 'status');
    const bad = /^[45]\d\d$/.test(status);
    return make('transaction', row, {
      title: `${shown(row, 'http_method')} ${urlPath(raw(row, 'url'))}`.trim() || 'Transaction',
      detail: [bad ? `status ${status}` : '', ...parts].filter(Boolean).join(' · '),
      durationMs: Number.isFinite(ms) && ms >= 0 ? ms : null,
      level: bad ? 'error' : ms >= SLOW_TRANSACTION_MS ? 'warn' : 'info',
    });
  },
  update(row) {
    const set = shown(row, 'update_set');
    const isDefault = /^default\b/i.test(set);
    return make('update', row, {
      title: `Captured ${shown(row, 'type') || 'record'}: ${shown(row, 'target_name') || shown(row, 'name') || 'unnamed'}`,
      detail: `in update set ${set || '(unknown)'}${shown(row, 'action') ? ` · ${shown(row, 'action')}` : ''}${isDefault ? ' · the Default update set is easy to lose or ship by accident' : ''}`,
      level: isDefault ? 'warn' : 'info',
      link: linkOf('sys_update_xml', row),
    });
  },
  event(row, ctx) {
    const state = shown(row, 'state');
    const instance = raw(row, 'instance');
    if (ctx.sysId && SYS_ID_RE.test(instance) && instance.toLowerCase() !== ctx.sysId) return null;
    const parms = [shown(row, 'parm1') && `parm1 ${clip(shown(row, 'parm1'), 50)}`, shown(row, 'parm2') && `parm2 ${clip(shown(row, 'parm2'), 50)}`].filter(Boolean);
    return make('event', row, { title: `Event ${shown(row, 'name') || ''}`.trim(), detail: [state && `state ${state}`, ...parms].filter(Boolean).join(' · '), level: FAILED_STATE.test(state) ? 'error' : 'info', link: linkOf('sysevent', row) });
  },
  email(row, ctx) {
    const instance = raw(row, 'instance');
    if (ctx.sysId && SYS_ID_RE.test(instance) && instance.toLowerCase() !== ctx.sysId) return null;
    const state = shown(row, 'state');
    const error = shown(row, 'error_string');
    const failed = Boolean(error) || FAILED_STATE.test(state);
    return make('email', row, {
      title: `Email: ${clip(shown(row, 'subject') || '(no subject)', 80)}`,
      detail: [shown(row, 'type') !== state ? shown(row, 'type') : '', state, shown(row, 'recipients') && `to ${clip(shown(row, 'recipients'), 80)}`, error && `error: ${clip(error, 160)}`].filter(Boolean).join(' · '),
      level: failed ? 'error' : /ignored|skipped/i.test(state) ? 'warn' : 'info',
      link: linkOf('sys_email', row),
    });
  },
  flow(row, ctx, source) {
    const target = source.id === 'workflow' ? raw(row, 'id') : raw(row, 'source_record');
    if (ctx.sysId && SYS_ID_RE.test(target) && target.toLowerCase() !== ctx.sysId) return null;
    const state = shown(row, 'state');
    const started = parseUtc(raw(row, 'started'));
    const ended = parseUtc(raw(row, 'ended'));
    const error = shown(row, 'error_message');
    return make('flow', row, {
      title: `${source.id === 'workflow' ? 'Workflow' : 'Flow'}: ${shown(row, 'name') || 'unnamed'}`,
      detail: [state, error && `error: ${clip(error, 200)}`].filter(Boolean).join(' · '),
      durationMs: Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null,
      level: error || FAILED_STATE.test(state) ? 'error' : 'info',
      link: linkOf(source.table, row),
    });
  },
  journal(row, ctx) {
    const element = raw(row, 'element');
    const label = element === 'work_notes' ? 'Work note' : element === 'comments' ? 'Comment' : element || 'Journal entry';
    return make('journal', row, { title: `${label} added`, detail: clip(shown(row, 'value'), 220), link: ctx.sysId ? { table: ctx.table, sysId: ctx.sysId } : null });
  },
  sla(row) {
    const breached = truthy(raw(row, 'has_breached'));
    return make('sla', row, { title: `SLA: ${shown(row, 'sla') || 'attached'}`, detail: [shown(row, 'stage'), breached && 'breached'].filter(Boolean).join(' · '), level: breached ? 'error' : 'info', link: linkOf('task_sla', row) });
  },
  approval(row) {
    const state = shown(row, 'state');
    return make('approval', row, { title: `Approval requested from ${shown(row, 'approver') || 'someone'}`, detail: [state, clip(shown(row, 'comments'), 120)].filter(Boolean).join(' · '), level: /reject/i.test(state) ? 'warn' : 'info', link: linkOf('sysapproval_approver', row) });
  },
  child(row) {
    return make('child', row, { title: `Created ${shown(row, 'number') || 'a child task'}`, detail: clip(shown(row, 'short_description'), 140), link: linkOf(raw(row, 'sys_class_name') || 'task', row) });
  },
  attachment(row) {
    const size = Number(raw(row, 'size_bytes'));
    return make('attachment', row, { title: `Attached ${shown(row, 'file_name') || 'a file'}`, detail: [shown(row, 'content_type'), Number.isFinite(size) && size > 0 ? `${Math.max(1, Math.round(size / 1024))} KB` : ''].filter(Boolean).join(' · '), link: linkOf('sys_attachment', row) });
  },
};

/**
 * The events for one source's rows, newest rows outside the window dropped (a dropped query condition returns every row).
 * @returns {{ events: object[], dropped: number }}
 */
export function mapRows(source, rows, ctx, window) {
  const mapper = MAPPERS[source.kind];
  if (!mapper) return { events: [], dropped: 0 };
  const events = [];
  let dropped = 0;
  (rows || []).forEach((row, i) => {
    const event = mapper(row, ctx, source);
    const t = event && event.t;
    if (!event || !Number.isFinite(t) || t < window.startMs - 1000 || t > window.endMs + 5000) {
      dropped += 1;
      return;
    }
    events.push({ ...event, id: `${source.id}:${i}`, source: source.id });
  });
  return { events, dropped };
}

// --- Timeline ---------------------------------------------------------------------------------------------

/** All events, oldest first; at the same instant a field change comes before the log lines it caused. */
export function mergeTimeline(events) {
  return [...events].sort((a, b) => a.t - b.t || (KINDS[a.kind]?.order || 99) - (KINDS[b.kind]?.order || 99) || String(a.id).localeCompare(String(b.id)));
}

/** Events within `gapMs` of the previous one share a group (one save produces a burst, then silence). */
export function groupTimeline(events, gapMs = GROUP_GAP_MS) {
  const groups = [];
  const t0 = events.length ? events[0].t : 0;
  events.forEach((event) => {
    const last = groups[groups.length - 1];
    if (last && event.t - last.endT <= gapMs) {
      last.events.push(event);
      last.endT = event.t;
    } else {
      groups.push({ startT: event.t, endT: event.t, offsetMs: event.t - t0, events: [event] });
    }
  });
  return groups;
}

export const onlyProblems = (events) => events.filter((e) => e.level !== 'info');

/**
 * Everything the panel shows, from the per-source results.
 * @param {Array<{ source, status: 'ok'|'skipped'|'unavailable'|'noaccess'|'error', rows?: object[], note?: string }>} results
 */
export function buildTrace({ results, ctx, window }) {
  const sources = [];
  const all = [];
  results.forEach((result) => {
    const { source } = result;
    if (result.status !== 'ok') {
      sources.push({ id: source.id, label: source.label, status: result.status, count: 0, note: result.note || '' });
      return;
    }
    const { events, dropped } = mapRows(source, result.rows, ctx, window);
    all.push(...events);
    const capped = (result.rows || []).length >= source.limit;
    sources.push({ id: source.id, label: source.label, status: events.length ? 'ok' : 'empty', count: events.length, note: [capped ? `Showing the first ${source.limit}.` : '', dropped ? `${dropped} row${dropped === 1 ? '' : 's'} outside the window or about another record left out.` : ''].filter(Boolean).join(' ') });
  });
  const events = mergeTimeline(all);
  return { events, groups: groupTimeline(events), sources, summary: summarize(events, sources, window) };
}

/** Counts and a one-line headline. */
export function summarize(events, sources, window) {
  const errors = events.filter((e) => e.level === 'error').length;
  const warnings = events.filter((e) => e.level === 'warn').length;
  const spanMs = events.length ? events[events.length - 1].t - events[0].t : 0;
  const unavailable = (sources || []).filter((s) => s.status === 'unavailable').length;
  const blocked = (sources || []).filter((s) => s.status === 'noaccess' || s.status === 'error').length;
  const parts = [events.length ? `${events.length} thing${events.length === 1 ? '' : 's'} happened over ${(spanMs / 1000).toFixed(1)}s` : 'Nothing was recorded in the window'];
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return { total: events.length, errors, warnings, spanMs, unavailable, blocked, headline: parts.join(' · '), window: `${window.startUtc} to ${window.endUtc} UTC` };
}

// --- Text for a ticket ------------------------------------------------------------------------------------

/** Plain text of the timeline for pasting into a ticket or chat. */
export function traceToText({ trace, record = {}, user = '', problemsOnly = false }) {
  const events = problemsOnly ? onlyProblems(trace.events) : trace.events;
  const t0 = trace.events.length ? trace.events[0].t : 0;
  const lines = [
    `Save trace: ${record.table || 'record'}${record.sysId ? ` ${record.sysId}` : ''}${user ? ` · ${user}` : ''}`,
    `${trace.summary.headline}`,
    `Window (UTC): ${trace.summary.window}`,
    '',
  ];
  if (!events.length) lines.push(problemsOnly ? '(no warnings or errors)' : '(nothing recorded)');
  events.forEach((e) => {
    const flag = e.level === 'error' ? '[ERROR] ' : e.level === 'warn' ? '[warn] ' : '';
    const dur = e.durationMs != null ? ` (${e.durationMs} ms)` : '';
    lines.push(`${offsetLabel(e.t - t0).padEnd(8)} ${(KINDS[e.kind]?.label || e.kind).padEnd(13)} ${flag}${e.title}${dur}${e.detail ? ` - ${e.detail}` : ''}`);
  });
  const missing = trace.sources.filter((s) => ['unavailable', 'noaccess', 'error'].includes(s.status));
  if (missing.length) {
    lines.push('', 'Not collected:');
    missing.forEach((s) => lines.push(`- ${s.label}: ${s.note}`));
  }
  return lines.join('\n');
}
