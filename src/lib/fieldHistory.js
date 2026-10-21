// "Who changed this value, and when?" (/history state): one field of one record as a timeline, from the audit trail.
// The pure half: turning sys_audit rows into changes with how long each value was held. No DOM, no network.
// The instance half is src/content/fieldHistory.js; the panel is src/sidebar/FieldHistoryPanel.jsx.

export const FIELD_RE = /^[a-z][a-z0-9_]{0,79}$/;
export const SYS_ID_RE = /^[0-9a-f]{32}$/i;
export const TABLE_RE = /^[a-z][a-z0-9_]{0,79}$/;

/** Changes quicker than this that return to the earlier value are flagged as bouncing. */
export const BOUNCE_MS = 10 * 60 * 1000;

/** ServiceNow date-times come back in UTC as "2026-10-20 12:30:01". Milliseconds, or NaN. */
export function parseStamp(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/** "3 d 4 h", "12 min", "45 s": the two biggest units that are not zero. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const units = [
    ['d', 86400],
    ['h', 3600],
    ['min', 60],
  ];
  const parts = [];
  let rest = s;
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n) parts.push(`${n} ${name}`);
  }
  return parts.slice(0, 2).join(' ');
}

/** The query for one field of one record, oldest change first. */
export function auditQuery(table, sysId, field) {
  if (!TABLE_RE.test(table || '')) throw new Error('Open a record first.');
  if (!SYS_ID_RE.test(sysId || '')) throw new Error('Save the record first: it has no sys_id yet.');
  if (!FIELD_RE.test(field || '')) throw new Error('Type a field name, for example state.');
  return `tablename=${table}^documentkey=${sysId.toLowerCase()}^fieldname=${field}^ORDERBYsys_created_on`;
}

/** Choice rows ({ value, label }) as a lookup. */
export function labelLookup(choices) {
  const map = new Map();
  (choices || []).forEach((c) => map.set(String(c.value), c.label));
  return (value) => (map.has(String(value)) ? map.get(String(value)) : String(value ?? ''));
}

/**
 * @param {Array<{ sys_created_on: string, user?: string, oldvalue?: string, newvalue?: string, reason?: string }>} rows oldest first
 * @param {{ label?: (v: string) => string, now?: number }} options
 * @returns {Array<{ at: string, user: string, from: string, to: string, rawFrom: string, rawTo: string, reason: string, heldMs: number, held: string, bounced: boolean, automated: boolean }>}
 *   `held` is how long the new value stayed before the next change (for the last change: until now, so "still" applies)
 */
export function buildTimeline(rows, { label = (v) => String(v ?? ''), now = Date.now() } = {}) {
  const list = (rows || []).slice().sort((a, b) => parseStamp(a.sys_created_on) - parseStamp(b.sys_created_on));
  return list.map((row, i) => {
    const at = parseStamp(row.sys_created_on);
    const next = list[i + 1];
    const end = next ? parseStamp(next.sys_created_on) : now;
    const heldMs = Number.isFinite(at) && Number.isFinite(end) ? Math.max(0, end - at) : NaN;
    const previous = list[i - 1];
    const bounced =
      Boolean(previous) &&
      String(row.newvalue ?? '') === String(previous.oldvalue ?? '') &&
      String(row.oldvalue ?? '') === String(previous.newvalue ?? '') &&
      at - parseStamp(previous.sys_created_on) <= BOUNCE_MS;
    const user = String(row.user ?? '').trim();
    return {
      at: row.sys_created_on,
      user,
      from: label(row.oldvalue),
      to: label(row.newvalue),
      rawFrom: String(row.oldvalue ?? ''),
      rawTo: String(row.newvalue ?? ''),
      reason: String(row.reason ?? ''),
      heldMs,
      held: formatDuration(heldMs),
      bounced,
      automated: !user || /^(system|guest|admin_system)$/i.test(user),
    };
  });
}

/** One paragraph: how often it changed, who changed it most, where it spent the longest, any bouncing. */
export function summarize(timeline, { field = 'value' } = {}) {
  if (!timeline.length) return `No audited changes to ${field}. Either it never changed, or auditing is off for this table or field.`;
  const byUser = new Map();
  timeline.forEach((t) => byUser.set(t.user || '(system)', (byUser.get(t.user || '(system)') || 0) + 1));
  const [top, count] = [...byUser.entries()].sort((a, b) => b[1] - a[1])[0];
  const longest = timeline.filter((t) => Number.isFinite(t.heldMs)).sort((a, b) => b.heldMs - a.heldMs)[0];
  const bounces = timeline.filter((t) => t.bounced).length;
  const parts = [`${field} changed ${timeline.length} ${timeline.length === 1 ? 'time' : 'times'}`];
  parts.push(byUser.size === 1 ? `all by ${top}` : `most by ${top} (${count})`);
  if (longest && longest.held) parts.push(`longest stretch: ${longest.to || '(empty)'} for ${longest.held}`);
  if (bounces) parts.push(`${bounces} ${bounces === 1 ? 'change went' : 'changes went'} straight back to the earlier value`);
  return `${parts.join('; ')}.`;
}

export function timelineToMarkdown({ table, record, field }, timeline) {
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ') || '(empty)';
  const lines = [`## ${table} ${record}: history of ${field}`, '', '| When (UTC) | By | From | To | Held |', '| --- | --- | --- | --- | --- |'];
  timeline.forEach((t) => lines.push(`| ${cell(t.at)} | ${cell(t.user || '(system)')} | ${cell(t.from)} | ${cell(t.to)} | ${cell(t.held)} |`));
  return `${lines.join('\n')}\n`;
}

export function historyPrompt({ table, record, field }, timeline) {
  const rows = timeline
    .slice(-40)
    .map((t) => `- ${t.at} by ${t.user || '(system)'}: ${t.from || '(empty)'} -> ${t.to || '(empty)'}${t.held ? ` (held ${t.held})` : ''}${t.bounced ? ' [went straight back]' : ''}`)
    .join('\n');
  return `This is the audited history of ${field} on ${table} ${record} in ServiceNow, oldest first:\n\n${rows}\n\nWhat does the pattern suggest? Look for automation fighting a person, a value that keeps bouncing, a change made by an unexpected user, and long stalls. Name what to check (business rule, flow, integration, user) and keep it short.`;
}
