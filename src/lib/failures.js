// "What went wrong recently?" (/failed), the pure half. The system log is not where most real failures leave a
// trace: a failed email lives in sys_email, a broken flow in sys_flow_context, an integration in the ECC queue or the
// outbound HTTP log, a bad import row in the import set, a stuck job in the scheduler, a dead event in sysevent.
// This file describes where each one is looked for (SOURCES), turns every row shape into one common shape,
// explains it in plain words, groups repeats ("42x"), does the window arithmetic and turns a failed read into a note.
// No DOM and no network, so it is all unit-tested (tests/failures.test.js). The instance half is
// src/content/failures.js; the panel is src/sidebar/FailuresPanel.jsx.
//
// ServiceNow drops query conditions on columns it does not know and returns every row, so each probe also carries
// a `keep` check that is applied to the rows again here.

// --- Time window --------------------------------------------------------------------------------------

export const WINDOWS = [
  { key: '1h', label: 'Last hour', minutes: 60 },
  { key: '24h', label: 'Last 24 hours', minutes: 1440 },
  { key: '7d', label: 'Last 7 days', minutes: 10080 },
];
export const DEFAULT_WINDOW = '24h';

export function windowMinutes(key) {
  return (WINDOWS.find((w) => w.key === key) || WINDOWS.find((w) => w.key === DEFAULT_WINDOW)).minutes;
}

/** The encoded-query clause "created in the window", evaluated by the instance (the same helper the log tail uses). */
export function windowClause(key, column = 'sys_created_on') {
  return `${column}>=javascript:gs.minutesAgoStart(${windowMinutes(key)})`;
}

/** Milliseconds for a ServiceNow date-time ("2026-10-20 14:03:11", stored in UTC), NaN when it is not one. */
export function parseGlideTime(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || '').trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

export function inWindow(when, key, now = Date.now()) {
  const t = parseGlideTime(when);
  return Number.isFinite(t) && now - t <= windowMinutes(key) * 60000 + 60000 && t <= now + 300000;
}

/** "3 min ago", "5 h ago", "2 d ago"; '' for something that is not a date. */
export function relativeAge(when, now = Date.now()) {
  const t = parseGlideTime(when);
  if (!Number.isFinite(t)) return '';
  const minutes = Math.max(0, Math.round((now - t) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

// --- Reading row values -------------------------------------------------------------------------------

/** The stored value of a field, whether the API returned a string or { value, display_value }. */
export function raw(v) {
  if (v && typeof v === 'object') return v.value == null ? '' : String(v.value);
  return v == null ? '' : String(v);
}
/** What a person sees: the display value when there is one. */
export function disp(v) {
  if (v && typeof v === 'object') return String(v.display_value || v.value || '');
  return v == null ? '' : String(v);
}
const clip = (text, max = 160) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const numberOf = (v) => {
  const n = Number.parseInt(raw(v), 10);
  return Number.isFinite(n) ? n : NaN;
};

/** Host and path of a URL without credentials or query string (those can hold keys and tokens). */
export function safeUrl(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  const stripped = text.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1').replace(/[?#].*$/, '');
  return clip(stripped, 140);
}
const hostOf = (url) => /^[a-z][a-z0-9+.-]*:\/\/([^/\s]+)/i.exec(safeUrl(url))?.[1] || safeUrl(url);

/** One sentence for an HTTP status code. */
export function httpHint(status) {
  if (status === 0 || Number.isNaN(status)) return 'No answer at all: the other side could not be reached (DNS, firewall, TLS or a MID Server problem).';
  if (status === 401) return 'The credentials were rejected. Check the authentication profile or the stored password.';
  if (status === 403) return 'The credentials were accepted but this call is not allowed for them.';
  if (status === 404) return 'The endpoint was not found. Check the URL and the path.';
  if (status === 408 || status === 504) return 'The other side took too long to answer.';
  if (status === 429) return 'The other side is rate limiting this instance.';
  if (status >= 500) return 'The other side (or this instance, for inbound calls) failed while handling the request.';
  if (status >= 400) return 'The request was rejected as invalid. The response body usually says which part.';
  return '';
}

// --- Plain-language reasons ---------------------------------------------------------------------------

/** First matching [pattern, sentence]. */
const firstMatch = (text, table) => table.find(([re]) => re.test(text))?.[1] || '';

const EMAIL_REASONS = [
  [/auth|credential|\b53[05]\b|login|password/i, 'The mail server refused the login. Check the SMTP account on the email properties.'],
  [/connect|timed? ?out|unreachable|refused|unknown host|no route/i, 'The mail server could not be reached.'],
  [/relay|\b55[0-3]\b|not permitted|not allowed/i, 'The mail server refused to accept the message or relay it for that address.'],
  [/invalid|malformed|bad address|no such user|mailbox|recipient/i, 'An address on the message is invalid or was rejected.'],
];
const FLOW_REASONS = [
  [/acl|security|not authorized|permission|access denied|insufficient/i, 'The flow ran as a user who may not touch something it used.'],
  [/time ?out|timed out/i, 'A step took too long.'],
  [/null|undefined|empty|no value|not set/i, 'A step used a value that was empty (a data pill with nothing in it).'],
  [/not found|no record|does not exist|cannot find/i, 'A step looked for a record that is not there.'],
  [/inactive|deactivated|not published|not active/i, 'A flow or action it depends on is inactive or not published.'],
];
const ECC_REASONS = [
  [/credential|auth|login|password|access denied/i, 'The MID Server was refused access by the target. Check the credential used.'],
  [/time ?out|timed out/i, 'The MID Server did not finish in time.'],
  [/unknown host|no such host|unreachable|refused|no route|connect/i, 'The MID Server could not reach the target from its network.'],
  [/script|exception|syntax/i, 'The probe or script the MID Server ran threw an error.'],
];
const IMPORT_REASONS = [
  [/mandatory|required|may not be (empty|null)|cannot be (empty|null)/i, 'A required field on the target table was empty for this row.'],
  [/duplicate|unique|already exists/i, 'A record with the same unique key already exists.'],
  [/reference|could not (find|resolve|match)|cannot (find|resolve|match)|no match/i, 'A reference value did not match any record.'],
  [/too long|length|truncat/i, 'A value is longer than the target field allows.'],
  [/date|time/i, 'A date or time value is not in the format the field expects.'],
  [/acl|security|not authorized|permission|insufficient/i, 'The import ran as a user who may not write to the target.'],
  [/script|exception|syntax|undefined/i, 'A transform script or field map script threw an error.'],
];

// --- Row -> common shape ------------------------------------------------------------------------------

/**
 * @typedef {{ id: string, source: string, kind: string, when: string, title: string, message: string, hint: string,
 *   severity: 'error' | 'warn', target: { table: string, sysId: string } | null, meta: object }} Failure
 */

function failure(source, kind, row, table, fields) {
  const sysId = raw(row.sys_id);
  return {
    id: `${table}:${sysId || Math.random().toString(36).slice(2)}`,
    source,
    kind,
    when: raw(row.sys_created_on),
    title: '',
    message: '',
    hint: '',
    severity: 'error',
    target: /^[0-9a-f]{32}$/i.test(sysId) ? { table, sysId } : null,
    meta: {},
    ...fields,
  };
}

export function normaliseEmail(row) {
  const type = raw(row.type).toLowerCase();
  const subject = clip(disp(row.subject), 80) || '(no subject)';
  const recipients = clip(disp(row.recipients), 120);
  const error = clip(disp(row.error_string) || disp(row.error), 400);
  const ignored = type === 'send-ignored';
  let hint;
  if (!recipients) hint = 'It had no recipients, so there was nobody to send it to.';
  else if (ignored) hint = 'The instance chose not to send it. Outbound email is usually switched off on this instance (common on non-production ones), or the recipient is excluded.';
  else hint = firstMatch(error, EMAIL_REASONS) || 'The instance tried and the mail server did not take it. The raw error below says why.';
  return failure('email', type, row, 'sys_email', {
    title: ignored ? `Email "${subject}" was ignored, not sent` : `Email "${subject}" failed to send`,
    message: error || (ignored ? 'send-ignored (no error recorded)' : 'send-failed (no error recorded)'),
    hint,
    severity: ignored ? 'warn' : 'error',
    meta: { recipients, table: raw(row.target_table) },
  });
}

export function normaliseFlow(row) {
  const state = raw(row.state).toLowerCase();
  const cancelled = state.startsWith('cancel');
  // `flow` is a plain string (a sys_id) on a flow context, so a bare id means the name could not be looked up.
  const known = disp(row.name) || disp(row.flow);
  const name = clip(/^[0-9a-f]{32}$/i.test(known) ? '' : known, 80);
  const sourceName = clip(disp(row.source_record), 80);
  const label = name ? `Flow "${name}"` : sourceName ? `Flow run for "${sourceName}"` : 'Flow run (name not available)';
  const error = clip(disp(row.error_message) || disp(row.error), 500);
  return failure('flow', cancelled ? 'cancelled' : 'error', row, 'sys_flow_context', {
    title: cancelled ? `${label} was cancelled` : `${label} failed`,
    message: error || '(no error message recorded; open the execution to see which step stopped)',
    hint: (error && firstMatch(error, FLOW_REASONS)) || 'Open the flow execution to see which step failed and what it was given.',
    severity: cancelled ? 'warn' : 'error',
    meta: { sourceTable: raw(row.source_table), sourceRecord: raw(row.source_record) },
  });
}

const minutesBetween = (earlier, later) => {
  const a = parseGlideTime(earlier);
  return Number.isFinite(a) ? Math.max(0, Math.round((later - a) / 60000)) : NaN;
};

export function normaliseTrigger(row, now = Date.now()) {
  const name = clip(disp(row.name), 80) || '(unnamed job)';
  const due = raw(row.next_action);
  const late = minutesBetween(due, now);
  const state = disp(row.state) || raw(row.state);
  return failure('jobs', 'overdue', row, 'sys_trigger', {
    when: due || raw(row.sys_created_on),
    title: `Scheduled job "${name}" is overdue`,
    message: `Was due ${due || '(unknown time)'}${Number.isFinite(late) ? ` (${late} min late)` : ''}; state ${state || 'unknown'}`,
    hint: 'The scheduler is behind, or no node is claiming the job. A job stuck in Queued is often held by a node that is gone. Check the scheduler workers and the stats page.',
    severity: 'warn',
    meta: { state },
  });
}

export function normaliseScheduledScript(row, now = Date.now()) {
  const name = clip(disp(row.name), 80) || '(unnamed job)';
  const due = raw(row.next_action);
  const late = minutesBetween(due, now);
  const last = raw(row.run_start);
  return failure('jobs', 'overdue', row, 'sysauto_script', {
    when: due || raw(row.sys_updated_on),
    title: `Scheduled job "${name}" has not run on time`,
    message: `Was due ${due || '(unknown time)'}${Number.isFinite(late) ? ` (${late} min late)` : ''}${last ? `; last started ${last}` : ''}`,
    hint: 'The job is active but its next run is in the past. The scheduler may be behind, or the job was left in a state that blocks its next run.',
    severity: 'warn',
    meta: {},
  });
}

export function normaliseEcc(row) {
  const topic = clip(disp(row.topic) || disp(row.name), 80) || 'message';
  const error = clip(disp(row.error_string) || disp(row.error) || disp(row.output), 400);
  return failure('integration', 'ecc', row, 'ecc_queue', {
    title: `MID Server message failed: ${topic}`,
    message: error || '(no error text recorded on the message)',
    hint: (error && firstMatch(error, ECC_REASONS)) || 'Open the ECC queue record and read its error and output. Check the MID Server is up and validated.',
    meta: { queue: raw(row.queue), agent: disp(row.agent) },
  });
}

const OUTBOUND_STATUS = ['response_code', 'http_status', 'status', 'response_status', 'status_code'];
const firstNumber = (row, keys) => {
  for (const key of keys) {
    const n = numberOf(row[key]);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
};

/** True for an outbound HTTP log row that is a failure: an error status, or an error text. */
export function outboundFailed(row) {
  const status = firstNumber(row, OUTBOUND_STATUS);
  const error = disp(row.error_message) || disp(row.error);
  return (Number.isFinite(status) && (status >= 400 || status === 0)) || Boolean(error && !(Number.isFinite(status) && status < 400));
}

export function normaliseOutbound(row) {
  const status = firstNumber(row, OUTBOUND_STATUS);
  const url = row.url || row.endpoint || row.name;
  const method = clip(disp(row.http_method) || disp(row.method), 10).toUpperCase();
  const error = clip(disp(row.error_message) || disp(row.error) || disp(row.message), 400);
  const shown = Number.isFinite(status) ? String(status) : 'no response';
  return failure('integration', 'outbound', row, 'sys_outbound_http_log', {
    title: `Call to ${hostOf(disp(url)) || 'an endpoint'} failed (${shown})`,
    message: error || `${method ? `${method} ` : ''}${safeUrl(disp(url))} answered ${shown}`,
    hint: httpHint(Number.isFinite(status) ? status : 0),
    meta: { status: Number.isFinite(status) ? status : null, url: safeUrl(disp(url)) },
  });
}

export function normaliseInbound(row) {
  const status = numberOf(row.http_response_code ?? row.response_status);
  const path = safeUrl(disp(row.url));
  const method = clip(disp(row.http_method), 10).toUpperCase();
  return failure('integration', 'inbound', row, 'syslog_transaction', {
    title: `Inbound API call returned ${Number.isFinite(status) ? status : 'an error'}: ${path || '(unknown path)'}`,
    message: `${method ? `${method} ` : ''}${path} answered ${Number.isFinite(status) ? status : 'an error'}${disp(row.sys_created_by) ? ` for ${disp(row.sys_created_by)}` : ''}`,
    hint: 'Something on this instance threw while handling the request. Look in the system log around this time for the stack trace.',
    meta: { status: Number.isFinite(status) ? status : null, url: path },
  });
}

export function normaliseImportRow(row) {
  const set = clip(disp(row.sys_import_set), 60);
  const error = clip(disp(row.sys_row_error) || disp(row.error), 400);
  const cls = raw(row.sys_class_name);
  const result = failure('import', 'row', row, /^[a-z][a-z0-9_]*$/.test(cls) ? cls : 'sys_import_set_row', {
    title: `Import row failed${set ? ` in ${set}` : ''}`,
    message: error || '(no row error recorded)',
    hint: (error && firstMatch(error, IMPORT_REASONS)) || 'Open the row: its error and the transform map history show which field or script stopped it.',
    meta: { importSet: set, target: raw(row.sys_target_table) },
  });
  return result;
}

export function normaliseImportRun(row) {
  const set = clip(disp(row.set) || disp(row.sys_import_set), 60);
  const errors = numberOf(row.errors);
  const message = clip(disp(row.error_message) || disp(row.status_message) || disp(row.message) || (Number.isFinite(errors) && errors > 0 ? `${errors} row${errors === 1 ? '' : 's'} in error` : ''), 400);
  return failure('import', 'run', row, 'sys_import_set_run', {
    title: `Import run ended in error${set ? `: ${set}` : ''}`,
    message: message || `state ${disp(row.state) || 'error'}`,
    hint: firstMatch(message, IMPORT_REASONS) || 'Open the import set run and its transform history.',
    meta: { importSet: set, map: disp(row.sys_transform_map) || disp(row.transform_map) || disp(row.map) },
  });
}

export function normaliseEvent(row) {
  const name = clip(disp(row.name), 80) || '(unnamed event)';
  const table = raw(row.table);
  // The parameters are left out on purpose: they often carry names, addresses or other personal data.
  return failure('event', 'error', row, 'sysevent', {
    title: `Event "${name}" stopped in error`,
    message: `Event ${name}${table ? ` on ${table}` : ''} could not be processed`,
    hint: 'A handler (a script action or a notification) failed while processing it. Open the event, then look for that event name in the system log at that time.',
    // The record the event was queued for (sysevent.instance), when the instance returned it: the email tracer starts there.
    meta: { event: name, table, record: raw(row.instance) },
  });
}

// --- Where each kind of failure is looked for ------------------------------------------------------------

const MAX_ROWS = 100;
const noWindowNote = 'Overdue means "now", so the time window does not apply.';

/**
 * @typedef {{ id: string, table: string, fields: string[], query: (windowKey: string) => string, limit?: number,
 *   displayValue?: boolean, keep: (row: object) => boolean, normalise: (row: object, now: number) => Failure,
 *   fallbackFor?: string }} Probe
 */

/** @type {Array<{ id: string, label: string, hint: string, note?: string, probes: Probe[] }>} */
export const SOURCES = [
  {
    id: 'email',
    label: 'Email',
    hint: 'Outbound mail that failed or was ignored',
    probes: [
      {
        id: 'email',
        table: 'sys_email',
        fields: ['sys_id', 'sys_created_on', 'type', 'state', 'recipients', 'subject', 'error_string', 'target_table'],
        query: (w) => `${windowClause(w)}^type=send-failed^ORtype=send-ignored^ORDERBYDESCsys_created_on`,
        keep: (row) => ['send-failed', 'send-ignored'].includes(raw(row.type).toLowerCase()),
        normalise: normaliseEmail,
      },
    ],
  },
  {
    id: 'flow',
    label: 'Flows',
    hint: 'Flow executions that errored or were cancelled',
    probes: [
      {
        id: 'flowContext',
        table: 'sys_flow_context',
        fields: ['sys_id', 'sys_created_on', 'name', 'flow', 'state', 'error_message', 'source_table', 'source_record'],
        query: (w) => `${windowClause(w)}^stateINERROR,CANCELLED,error,cancelled^ORDERBYDESCsys_created_on`,
        displayValue: true,
        keep: (row) => /^(error|cancel)/i.test(raw(row.state)),
        normalise: normaliseFlow,
      },
      {
        id: 'flowRun',
        table: 'sys_hub_flow_run',
        fallbackFor: 'flowContext',
        fields: ['sys_id', 'sys_created_on', 'name', 'flow', 'state', 'error_message'],
        query: (w) => `${windowClause(w)}^stateINERROR,CANCELLED,error,cancelled^ORDERBYDESCsys_created_on`,
        displayValue: true,
        keep: (row) => /^(error|cancel)/i.test(raw(row.state)),
        normalise: normaliseFlow,
      },
    ],
  },
  {
    id: 'jobs',
    label: 'Jobs',
    hint: 'Scheduled jobs that are overdue',
    note: noWindowNote,
    probes: [
      {
        id: 'trigger',
        table: 'sys_trigger',
        fields: ['sys_id', 'sys_created_on', 'name', 'state', 'next_action', 'trigger_type'],
        query: () => 'next_action<javascript:gs.minutesAgoStart(15)^stateIN0,1^ORDERBYnext_action',
        displayValue: true,
        keep: (row) => Number.isFinite(parseGlideTime(raw(row.next_action))),
        normalise: normaliseTrigger,
      },
      {
        id: 'scheduledScript',
        table: 'sysauto_script',
        fallbackFor: 'trigger',
        fields: ['sys_id', 'sys_updated_on', 'name', 'run_type', 'next_action', 'run_start'],
        query: () => 'active=true^run_type!=on_demand^next_action<javascript:gs.minutesAgoStart(60)^ORDERBYnext_action',
        keep: (row) => Number.isFinite(parseGlideTime(raw(row.next_action))),
        normalise: normaliseScheduledScript,
      },
    ],
  },
  {
    id: 'integration',
    label: 'Integrations',
    hint: 'MID Server messages in error, failed outbound calls, inbound API calls that returned 5xx',
    probes: [
      {
        id: 'ecc',
        table: 'ecc_queue',
        fields: ['sys_id', 'sys_created_on', 'topic', 'name', 'queue', 'agent', 'state', 'error_string'],
        query: (w) => `${windowClause(w)}^state=error^ORDERBYDESCsys_created_on`,
        displayValue: true,
        keep: (row) => raw(row.state).toLowerCase() === 'error',
        normalise: normaliseEcc,
      },
      {
        id: 'outbound',
        table: 'sys_outbound_http_log',
        fields: ['sys_id', 'sys_created_on', 'url', 'endpoint', 'name', 'http_method', 'method', 'response_code', 'http_status', 'status', 'response_status', 'status_code', 'error_message', 'error', 'message'],
        query: (w) => `${windowClause(w)}^ORDERBYDESCsys_created_on`,
        limit: 200,
        keep: outboundFailed,
        normalise: normaliseOutbound,
      },
      {
        id: 'inbound',
        table: 'syslog_transaction',
        fields: ['sys_id', 'sys_created_on', 'url', 'http_response_code', 'sys_created_by'],
        query: (w) => `${windowClause(w)}^http_response_code>=500^urlSTARTSWITH/api/^ORDERBYDESCsys_created_on`,
        keep: (row) => numberOf(row.http_response_code ?? row.response_status) >= 500 && /^\/?api\//i.test(String(raw(row.url)).replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/^\//, '/')),
        normalise: normaliseInbound,
      },
    ],
  },
  {
    id: 'import',
    label: 'Imports',
    hint: 'Import set rows and runs in error',
    probes: [
      {
        id: 'importRow',
        table: 'sys_import_set_row',
        fields: ['sys_id', 'sys_created_on', 'sys_import_set', 'sys_import_state', 'sys_row_error', 'sys_class_name', 'sys_target_table'],
        query: (w) => `${windowClause(w)}^sys_import_state=error^ORDERBYDESCsys_created_on`,
        displayValue: true,
        keep: (row) => raw(row.sys_import_state).toLowerCase() === 'error',
        normalise: normaliseImportRow,
      },
      {
        id: 'importRun',
        table: 'sys_import_set_run',
        fields: ['sys_id', 'sys_created_on', 'set', 'state', 'errors', 'sys_transform_map'],
        query: (w) => `${windowClause(w)}^stateINerror,failed,cancelled^ORerrors>0^ORDERBYDESCsys_created_on`,
        displayValue: true,
        keep: (row) => /^(error|fail|cancel)/i.test(raw(row.state)) || numberOf(row.errors) > 0,
        normalise: normaliseImportRun,
      },
    ],
  },
  {
    id: 'event',
    label: 'Events',
    hint: 'Events that stopped in error',
    probes: [
      {
        id: 'event',
        table: 'sysevent',
        fields: ['sys_id', 'sys_created_on', 'name', 'state', 'table', 'instance', 'queue'],
        query: (w) => `${windowClause(w)}^state=error^ORDERBYDESCsys_created_on`,
        keep: (row) => raw(row.state).toLowerCase() === 'error',
        normalise: normaliseEvent,
      },
    ],
  },
];

export const SOURCE_IDS = SOURCES.map((s) => s.id);
export const sourceLabel = (id) => SOURCES.find((s) => s.id === id)?.label || id;
export { MAX_ROWS };

// --- A failed read is a note ---------------------------------------------------------------------------

/** { available: false, note, sessionExpired? } for an error from reading `table`. */
export function softFail(err, table) {
  const text = (err && err.message) || String(err || '');
  if (err?.code === 'SESSION_EXPIRED') return { available: false, note: text, sessionExpired: true };
  if (/\b403\b|not allowed|forbidden|security|denied|acl/i.test(text)) return { available: false, note: `Your user cannot read ${table}.` };
  if (/\b(400|404)\b|invalid table|not found|unknown|does not exist|no such/i.test(text)) return { available: false, note: `${table} is not available on this instance.` };
  return { available: false, note: `Could not read ${table}: ${clip(text, 120)}` };
}

/** Rows -> failures for one probe, re-filtering what the instance returned and ordering newest first. */
export function runProbeRows(probe, rows, now = Date.now()) {
  const kept = (rows || []).filter((row) => {
    try {
      return probe.keep(row);
    } catch {
      return false;
    }
  });
  const items = kept.map((row) => probe.normalise(row, now));
  items.sort((a, b) => String(b.when).localeCompare(String(a.when)));
  return { available: true, items, truncated: (rows || []).length >= (probe.limit || MAX_ROWS) };
}

/**
 * Combine the results of one source's probes. `results` maps probe id -> { available, items, note, truncated }.
 * A fallback probe's result is ignored when its primary answered.
 */
export function mergeSource(source, results) {
  const notes = [];
  const items = [];
  let available = false;
  let truncated = false;
  let sessionExpired = false;
  source.probes.forEach((probe) => {
    const result = results[probe.id];
    if (!result || result.skipped) return;
    if (result.available) {
      available = true;
      truncated = truncated || Boolean(result.truncated);
      items.push(...result.items);
    } else {
      sessionExpired = sessionExpired || Boolean(result.sessionExpired);
      notes.push(result.note);
    }
  });
  // Notes only matter when nothing at all could be read for the source.
  return { id: source.id, label: source.label, hint: source.hint, available, items, truncated, sessionExpired, note: available ? '' : notes.join(' ') || 'Not available.', sourceNote: source.note || '' };
}

// --- Grouping ------------------------------------------------------------------------------------------

/** The text of a message with the changing parts replaced, so repeats of one error share a key. */
export function digest(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[0-9a-f]{32}/g, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}[ t]\d{2}:\d{2}:\d{2}/g, '<time>')
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, '<email>')
    .replace(/\b[a-z]{2,6}\d{5,}\b/g, '<number>')
    .replace(/([a-z])\d+\b/g, '$1<n>') // host names and ids that differ only in their trailing number (scan01, scan02)
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

// An HTTP status is part of what the failure IS: a 401 and a 500 from the same endpoint are different problems.
export const groupKey = (item) => `${item.source}|${item.kind}|${item.meta?.status ?? ''}|${digest(item.title)}|${digest(item.message)}`;

/**
 * Repeats of the same failure as one group: count, first and last time, the newest item as the example.
 * @param {Failure[]} items
 * @param {{ sort?: 'recent' | 'count' }} [options]
 */
export function groupFailures(items, { sort = 'recent' } = {}) {
  const groups = new Map();
  (items || []).forEach((item) => {
    const key = groupKey(item);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { key, source: item.source, kind: item.kind, severity: item.severity, title: item.title, message: item.message, hint: item.hint, target: item.target, meta: item.meta || {}, count: 1, first: item.when, last: item.when, items: [item] });
      return;
    }
    group.count += 1;
    group.items.push(item);
    if (String(item.when) > String(group.last)) {
      group.last = item.when;
      group.target = item.target;
      group.meta = item.meta || {};
      group.message = item.message;
    }
    if (String(item.when) < String(group.first)) group.first = item.when;
    if (item.severity === 'error') group.severity = 'error';
  });
  const list = [...groups.values()];
  list.sort(sort === 'count' ? (a, b) => b.count - a.count || String(b.last).localeCompare(String(a.last)) : (a, b) => String(b.last).localeCompare(String(a.last)) || b.count - a.count);
  return list;
}

/** { email: 3, flow: 0 ... } occurrences per source, for the filter chips. */
export function countsBySource(items) {
  const counts = Object.fromEntries(SOURCE_IDS.map((id) => [id, 0]));
  (items || []).forEach((item) => {
    counts[item.source] = (counts[item.source] || 0) + 1;
  });
  return counts;
}

export const filterBySource = (items, source) => (source && source !== 'all' ? (items || []).filter((i) => i.source === source) : items || []);

// --- Text for the AI and for pasting --------------------------------------------------------------------

/** The classic form path of the record a failure points at ('/sys_email.do?sys_id=...'), or '' when there is none. */
export function recordPath(target) {
  return target && /^[a-z][a-z0-9_]*$/.test(target.table || '') && /^[0-9a-f]{32}$/i.test(target.sysId || '') ? `/${target.table}.do?sys_id=${target.sysId}` : '';
}

/** "42x", "1x"; the count as people write it. */
export const countLabel = (group) => `${group.count}x`;

/** The question sent to the chat for one group. The caller runs it through redactSecrets. */
export function buildFailurePrompt(group, { instance = '' } = {}) {
  const lines = [
    `Explain why this ServiceNow failure happened and how to fix it. Give the likely causes in order, and what to check on the instance.`,
    '',
    `Where: ${sourceLabel(group.source)} (${group.kind})${instance ? ` on ${instance}` : ''}`,
    `What: ${group.title}`,
    `Seen: ${group.count} time${group.count === 1 ? '' : 's'}, first ${group.first || 'unknown'}, last ${group.last || 'unknown'} (UTC)`,
    group.target ? `Record: ${group.target.table} ${group.target.sysId}` : '',
    '',
    'Raw message:',
    '```',
    clip(group.message, 1500),
    '```',
    group.hint ? `\nFirst guess from the extension: ${group.hint}` : '',
  ];
  return lines.filter((line, i) => line !== '' || lines[i - 1] !== '').join('\n');
}

/** A report of the groups for a ticket or a chat message. */
export function failuresToMarkdown(groups, { windowKey = DEFAULT_WINDOW, instance = '', generatedAt = '' } = {}) {
  const windowLabel = WINDOWS.find((w) => w.key === windowKey)?.label || windowKey;
  const out = [`# What went wrong${instance ? ` on ${instance}` : ''}`, '', `${windowLabel}${generatedAt ? `, read ${generatedAt}` : ''}. ${groups.length} distinct problem${groups.length === 1 ? '' : 's'}.`, ''];
  groups.forEach((g) => {
    out.push(`## ${g.title} (${countLabel(g)})`, '', `- Source: ${sourceLabel(g.source)}`, `- First: ${g.first || 'unknown'}, last: ${g.last || 'unknown'} (UTC)`);
    if (g.target) out.push(`- Record: ${g.target.table} ${g.target.sysId}`);
    out.push(`- Likely: ${g.hint || 'see the raw message'}`, '', '```', clip(g.message, 600), '```', '');
  });
  return out.join('\n');
}
