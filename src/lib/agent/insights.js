// Compact answers for the read-only analysis tools of the agent and the MCP bridge: explain_email, explain_process,
// map_table, find_dotwalk_path, explain_preview_problems and find_artifact. The panels behind them (Email tracer, Flows
// and approvals, Data model, Preview problems, Go to anything) build big reports for a person to read; the agent has a
// context budget (one tool result is cut at 14,000 characters), so each shaper here keeps the verdict, the top reasons
// and the links, caps every list and says how much was left out. Pure: no DOM, no network, no chrome.* (the instance
// reads are injected, see searchArtifacts).
//
// Rules every shaper follows:
//   * lists are capped, and a `more...` count says what was cut; if the result is still over SHAPE_BUDGET, the lists are
//     cut harder in steps (`fit`), never the text in the middle of a sentence
//   * free text from the instance (error messages, descriptions, comments) is redacted and clipped
//   * email addresses are masked (b***@acme.example), the same way the Email tracer masks them in its Markdown
//   * nothing is invented: a section that could not be read is named, never shown as empty

import { redactSecrets } from '../../providers/redact.js';
import { whenText, looksSecretMail } from '../notifyTrace.js';
import { recordPath as targetPath } from '../processView.js';
import { isOpen, recordPath as recordLink, SET_TABLE } from '../previewProblems.js';
import { buildMapGraph, isSystemTable } from '../dataModel.js';
import { KINDS, LIMITS, kindById, kindForWord, parseGoTo, createGoToEngine, rankCandidates, selectRows } from '../goTo.js';
import { secretReason, nameLooksSecret, propertyPath, usageCounts, USAGE_LIMITS_NOTE } from '../properties.js';
import { KINDS as TRACE_KINDS, buildRows, selectDocuments, findFindings, buildStories, describeRow, attribute, collectRefs, isProblem, isSlow, fmtMs, documentsOf } from '../clientTrace.js';

/** Characters of JSON a shaper aims to stay under (the agent loop cuts a result at 14,000). */
export const SHAPE_BUDGET = 9000;
export const DEFAULT_MATCHES = 15;
export const MAX_MATCHES = 25;

/** Kind ids the find_artifact tool accepts (also written, by hand, in toolSchemas.js; a test keeps them equal). */
export const ARTIFACT_KIND_IDS = KINDS.map((k) => k.id);
/** Each kind with the table it searches, so a caller can leave out the kinds whose table may not be read. */
export const ARTIFACT_KINDS = KINDS.map((k) => ({ id: k.id, table: k.table }));

// ---- Small helpers --------------------------------------------------------------------------------------------------

const text = (v) => (v === undefined || v === null ? '' : String(v));

export function clip(value, max = 160) {
  const s = text(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const ADDRESS_RE = /([^\s,;<>()"'])[^\s,;<>()"']*@([^\s,;<>()"']+)/g;

/** a***@acme.example: addresses are not handed to an agent; the domain stays because it often explains a miss. */
export const maskAddresses = (value) => text(value).replace(ADDRESS_RE, '$1***@$2');

/** Free text from the instance: secrets redacted, then clipped (clipping first could cut a key short of its pattern). */
const safe = (value, max) => clip(redactSecrets(text(value)), max);

/** maskAddresses over every string in a result (arrays and plain objects are walked). */
export function maskDeep(value) {
  if (typeof value === 'string') return maskAddresses(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)]));
  return value;
}

/** A name or part of a name: letters, digits, spaces and . _ @ + ' ( ) / & , # - only. No ^ = : ; quotes or brackets, so nothing can become query syntax. */
export const NAME_TERM_RE = /^[\p{L}\p{N} ._@+'’()\/&,#-]{1,80}$/u;

export function assertNameTerm(value, label) {
  const s = text(value).replace(/\s+/g, ' ').trim();
  if (!s) throw new Error(`${label} is empty.`);
  if (!NAME_TERM_RE.test(s)) throw new Error(`${label} must be a name or part of one (letters, digits, spaces and . _ @ + ' ( ) / & , # - only, up to 80 characters).`);
  return s;
}

const more = (total, shown) => (total > shown ? total - shown : undefined);

/**
 * Build the result with the first set of limits; if it is over budget, build it again with the next, tighter set.
 * The last set is returned whatever its size. A result built from a tighter set says so (`cutShort`).
 */
function fit(tiers, build) {
  let out;
  for (let i = 0; i < tiers.length; i += 1) {
    out = build(tiers[i]);
    if (JSON.stringify(out).length <= SHAPE_BUDGET) {
      if (i > 0) out.cutShort = 'Lists were cut shorter to keep this answer small; the "more" counts say how much was left out.';
      return out;
    }
  }
  out.cutShort = 'Lists were cut shorter to keep this answer small; the "more" counts say how much was left out.';
  return out;
}

// ---- explain_email --------------------------------------------------------------------------------------------------

const SECTION_WORD = { notifications: 'notifications', events: 'events', emails: 'emails', recipients: 'people', switches: 'mail settings' };

const eventFact = (e) => ({ name: clip(e.name, 80), state: e.label, queued: whenText(e.createdOn) || undefined, by: e.userName || undefined, link: e.href || undefined });

const emailFact = (e) => ({
  state: e.label,
  subject: looksSecretMail(e.subject, e.notificationName) ? '(hidden: this looks like mail that carries a password or code)' : clip(e.subject, 100),
  created: whenText(e.createdOn) || undefined,
  error: e.error ? safe(e.error, 140) : undefined,
  link: e.href || undefined,
});

function recipientFacts(r, t) {
  if (!r) return undefined;
  const left = r.people.filter((p) => p.status === 'blocked');
  const getting = r.people.filter((p) => p.status === 'receives');
  return {
    wouldReceive: r.counts.receive,
    wouldNotReceive: r.counts.blocked,
    leftOut: left.slice(0, t.people).map((p) => ({ name: clip(p.name, 60), why: safe(p.reasons.map((x) => x.text).join(' '), 160) })),
    moreLeftOut: more(left.length, t.people),
    receiving: getting.slice(0, t.people).map((p) => clip(p.name, 60)),
    moreReceiving: more(getting.length, t.people),
    problems: r.issues.filter((i) => i.level !== 'info').slice(0, t.people > 5 ? 3 : 1).map((i) => safe(i.text, 160)),
    sources: r.sources.slice(0, t.people > 5 ? 5 : 2).map((s) => `${clip(s.label, 40)}: ${clip(s.detail, 80)}`),
  };
}

function notificationFacts(c) {
  const n = c.notification;
  return {
    name: clip(n.name, 100),
    sysId: n.sysId,
    active: n.active,
    table: n.table || undefined,
    inheritedFromParentTable: n.inherited || undefined,
    sends: clip(n.triggerText, 120),
    condition: n.condition ? clip(n.condition, 200) : undefined,
    conditionResult: c.condition?.reason ? clip(c.condition.reason, 160) : undefined,
    advancedConditionScript: n.advancedCondition ? 'present, not run by the tracer' : undefined,
    link: n.href || undefined,
  };
}

const stepFact = (s) => ({ step: s.label, status: s.status, finding: clip(s.headline, 200) });

function matchingFacts(m) {
  if (!m) return undefined;
  if (m.all) return { appliesTo: 'every record of the table (no condition)' };
  if (m.error) return { couldNotCount: safe(m.error, 140) };
  if (m.skipped) return { notCounted: clip(m.skipped, 140) };
  return { recordsMatchingNow: m.count, examples: (m.sample || []).slice(0, 5).map((s) => clip(s.label, 60)) };
}

const EMAIL_TIERS = [
  { people: 8, others: 6, events: 3, emails: 3, notes: 4, orphan: 2 },
  { people: 5, others: 3, events: 2, emails: 2, notes: 2, orphan: 1 },
  { people: 3, others: 0, events: 1, emails: 1, notes: 1, orphan: 0 },
  { people: 2, others: 0, events: 1, emails: 1, notes: 0, orphan: 0 },
];

/**
 * The Email tracer's report (loadNotifyReport) as a compact answer: which notification, the first broken link with its
 * advice, the five steps, who would and would not get it, the other notifications considered, and the mail settings
 * that switch sending off. Handles the record, email and notification modes. Addresses are masked.
 */
export function shapeEmailReport(report = {}) {
  return fit(EMAIL_TIERS, (t) => shapeEmail(report, t));
}

function shapeEmail(report, t) {
  const mode = report.mode || 'record';
  const out = { mode };
  const sections = report.sections || {};
  const unread = Object.entries(sections)
    .filter(([, s]) => s && s.ok === false)
    .map(([key, s]) => `${SECTION_WORD[key] || key}: ${safe(s.error, 140)}`);

  if (mode === 'notification') {
    const n = report.notification || {};
    out.summary = `${clip(n.name, 100) || 'The notification'} is ${n.active ? 'active' : 'INACTIVE'} and sends ${clip(n.triggerText, 120) || 'when it is triggered'}.`;
    out.notification = { name: clip(n.name, 100), sysId: n.sysId, active: n.active, table: n.table || undefined, sends: clip(n.triggerText, 120), condition: n.condition ? clip(n.condition, 200) : undefined, advancedConditionScript: n.advancedCondition ? 'present, not run by the tracer' : undefined, link: n.href || undefined };
    out.matching = matchingFacts(report.matching);
    out.recipients = recipientFacts(report.recipients, t);
    out.events = (report.events || []).slice(0, t.events).map(eventFact);
    out.emails = (report.emails || []).slice(0, t.emails).map(emailFact);
    if ((report.others || []).length && t.others) out.otherMatchingNames = report.others.slice(0, Math.min(5, t.others)).map((o) => ({ name: clip(o.name, 80), table: o.table || undefined, sysId: o.sysId }));
  } else {
    const subject = report.subject;
    if (subject) out.record = { table: subject.table, sysId: subject.sysId, label: clip(subject.label, 80), tablesChecked: subject.chain, link: subject.href || undefined };
    const candidates = report.candidates || [];
    const chosen = candidates.find((c) => c.notification.sysId === report.selectedId) || candidates[0] || null;
    if (chosen) {
      const v = chosen.trace.verdict;
      out.verdict = { status: v.status, code: v.code, summary: clip(v.headline, 300), advice: v.advice ? clip(v.advice, 240) : undefined };
      out.notification = notificationFacts(chosen);
      out.steps = chosen.trace.stages.slice(0, 6).map(stepFact);
      out.recipients = recipientFacts(chosen.recipients, t);
      out.events = chosen.trace.events.slice(0, t.events).map(eventFact);
      out.emails = chosen.trace.emails.slice(0, t.emails).map(emailFact);
    } else {
      const table = subject?.table || 'this table';
      if (mode === 'email' && report.targetError) {
        // An email that is not tied to a record, or whose record could not be traced: no notification list exists to judge.
        out.verdict = { status: 'cannot-trace', summary: `The notification behind this email could not be traced: ${clip(report.targetError, 200)}` };
      } else {
        const none = sections.notifications && sections.notifications.ok === false
          ? `The notifications could not be read, so nothing can be said about this record: ${safe(sections.notifications.error, 140)}`
          : `No notification is defined for ${table}${subject?.chain?.length > 1 ? ` or its parent tables (${subject.chain.slice(1).join(', ')})` : ''}, so nothing would send an email for this record.`;
        out.verdict = { status: 'no-notification', summary: none };
      }
    }
    const others = candidates.filter((c) => c !== chosen);
    out.notificationsOnTable = candidates.length;
    out.otherNotifications = others.slice(0, t.others).map((c) => ({ name: clip(c.notification.name, 80), active: c.notification.active, result: c.trace.verdict.short, link: c.notification.href || undefined }));
    out.moreNotifications = more(others.length, t.others);
    if (report.focusMissing) {
      out.requestedNotification = { name: clip(report.focusMissing, 80), foundOnThisTable: false, similarElsewhere: (report.focusElsewhere || []).slice(0, 3).map((x) => ({ name: clip(x.name, 80), table: x.table || undefined, link: x.href || undefined })) };
    }
    const orphan = report.unmatchedEmails || [];
    if (orphan.length && t.orphan) out.emailsFromOtherSources = { count: orphan.length, latest: orphan.slice(0, t.orphan).map(emailFact) };

    if (mode === 'email' && report.email) {
      const e = report.email;
      out.email = { ...emailFact(e), toCount: (e.recipients || []).length, ccCount: (e.copied || []).length, bccCount: (e.blindCopied || []).length };
      out.addresses = (report.recipientsExplained || []).slice(0, t.people).map((r) => ({
        address: r.address,
        kind: r.kind,
        name: r.name ? clip(r.name, 60) : undefined,
        onTheNotificationsList: r.explained,
        suppliedBy: r.sources?.length ? r.sources.slice(0, 2).map((s) => clip(s, 60)) : undefined,
        note: r.explained ? undefined : clip(r.note, 160),
      }));
      out.moreAddresses = more((report.recipientsExplained || []).length, t.people);
      if (report.trigger?.text) out.trigger = clip(report.trigger.text, 200);
      if (report.targetError) out.targetError = clip(report.targetError, 200);
    }
  }
  const settings = (report.switches?.findings || []).slice(0, 3).map((f) => clip(f.text, 200));
  if (settings.length) out.instanceMailSettings = settings;
  if (unread.length) out.couldNotRead = unread.slice(0, 5);
  if ((report.notes || []).length && t.notes) out.notes = report.notes.slice(0, t.notes).map((x) => safe(x, 160));
  return maskDeep(out);
}

// ---- explain_process ------------------------------------------------------------------------------------------------

function processRow(row) {
  return {
    title: clip(row.title, 100),
    state: row.badge?.text || undefined,
    headline: row.headline ? clip(row.headline, 140) : undefined,
    error: row.error ? safe(row.error, 220) : undefined,
    note: row.note ? clip(row.note, 120) : undefined,
    comment: row.comment ? safe(row.comment, 100) : undefined,
    facts: row.facts?.length ? row.facts.slice(0, 2).map((f) => clip(f, 60)) : undefined,
    needsAttention: row.attention || undefined,
    link: row.href || undefined,
  };
}

const PROCESS_TIERS = [
  { items: 12, perSection: 4, blockers: 4, running: 3 },
  { items: 8, perSection: 3, blockers: 3, running: 2 },
  { items: 5, perSection: 2, blockers: 2, running: 1 },
  { items: 3, perSection: 1, blockers: 1, running: 1 },
];

/**
 * The Flows, approvals and SLAs report (processLoad) as a compact answer: what the record is waiting on, what is
 * running, and the items of each section (those needing attention first, a dozen at most over all sections), with what
 * could not be read.
 */
export function shapeProcessReport(report = {}) {
  return fit(PROCESS_TIERS, (t) => shapeProcess(report, t));
}

function shapeProcess(report, t) {
  const s = report.summary || {};
  const record = report.record || {};
  const blockers = s.blockers || [];
  const running = s.running || [];
  const sections = report.sections || [];

  // Items needing attention first in every section, then the rest, until the overall budget of items is spent.
  let room = t.items;
  const chosen = new Map(sections.map((sec) => [sec.id, []]));
  [(r) => r.attention, (r) => !r.attention].forEach((wanted) => {
    sections.forEach((sec) => {
      if (sec.status === 'na') return;
      const list = chosen.get(sec.id);
      (sec.rows || []).filter(wanted).forEach((row) => {
        if (room > 0 && list.length < t.perSection) {
          list.push(row);
          room -= 1;
        }
      });
    });
  });

  const out = {
    record: { table: report.table, sysId: report.sysId, label: clip(record.label, 80) || undefined, summary: record.summary ? clip(record.summary, 100) : undefined, active: record.active ?? undefined },
    level: s.level,
    headline: clip(s.headline, 240),
    detail: s.detail ? clip(s.detail, 240) : undefined,
    closedNote: s.closedNote ? clip(s.closedNote, 160) : undefined,
    waitingOn: blockers.slice(0, t.blockers).map((b) => ({ what: clip(b.text, 160), detail: b.detail ? safe(b.detail, 180) : undefined, severity: b.severity || undefined, kind: b.tag || undefined, link: b.target ? targetPath(b.target) || undefined : undefined })),
    moreWaitingOn: more(blockers.length, t.blockers),
    runningNow: running.slice(0, t.running).map((r) => clip(r.text, 140)),
    sections: sections.map((sec) => {
      const rows = sec.rows || [];
      const base = { id: sec.id, label: sec.label, status: sec.status, count: sec.count ?? rows.length };
      if (sec.status === 'na') return { ...base, note: clip(sec.note, 140) };
      const items = chosen.get(sec.id);
      return {
        ...base,
        note: sec.status !== 'ok' && sec.note ? clip(sec.note, 160) : undefined,
        items: items.map(processRow),
        more: more(rows.length, items.length),
        cutByTheReader: sec.truncated || undefined,
      };
    }),
    couldNotRead: (s.unreadable || []).slice(0, 5).map((u) => `${clip(u.label, 40)}: ${clip(u.text, 140)}`),
    absentNote: s.absentNote ? clip(s.absentNote, 160) : undefined,
    note: report.schemaNote ? clip(report.schemaNote, 200) : undefined,
  };
  return maskDeep(out);
}

// ---- map_table ------------------------------------------------------------------------------------------------------

const MAP_TIERS = [
  { groups: 25, fields: 5, children: 10, links: 6, notes: 4 },
  { groups: 18, fields: 3, children: 6, links: 4, notes: 2 },
  { groups: 12, fields: 2, children: 4, links: 2, notes: 1 },
  { groups: 8, fields: 1, children: 0, links: 0, notes: 1 },
];

/**
 * The map of one table (dataModelLoad) as a compact answer: the extends chain, how many tables extend it, the
 * reference fields it holds grouped by target table, and the fields on other tables that point at it. System tables
 * are left out of "pointed at by" unless asked for (or the table itself is one).
 * @param {object} model what dataModelLoad returned
 * @param {{ showSystem?: boolean }} [options]
 */
export function shapeMapReport(model = {}, { showSystem = false } = {}) {
  return fit(MAP_TIERS, (t) => shapeMap(model, showSystem, t));
}

function shapeMap(model, showSystem, t) {
  const hideSystem = !showSystem && !isSystemTable(model.table);
  const graph = buildMapGraph(model, { hideSystem });
  const fieldNote = (f) => `${f.name}${f.kind === 'list' ? ' (list)' : ''}${f.inherited ? ` (from ${f.definedOn})` : ''}`;
  const incomingNote = (f) => `${f.name}${f.kind === 'list' ? ' (list)' : ''}${f.viaParent ? ` (points at ${f.target})` : ''}`;
  const outFields = graph.outgoing.reduce((n, g) => n + g.count, 0);
  const inFields = graph.incoming.reduce((n, g) => n + g.count, 0);
  const total = Number(model.descendantCount) || graph.children.length;
  return {
    table: model.table,
    label: model.label || undefined,
    scope: model.scopeName || model.scope || undefined,
    rowCount: model.rowCount ?? undefined,
    rowCountNote: model.rowCount != null && total ? 'includes the rows of child tables' : undefined,
    extends: graph.parents.map((p) => p.table),
    extendedBy: total
      ? { directChildren: Number(model.childCount) || graph.children.length, allDescendants: model.descendantsMore ? `${total}+` : total, examples: graph.children.slice(0, t.children).map((c) => c.table), moreExamples: t.children ? more(graph.children.length, t.children) : undefined }
      : undefined,
    pointsAt: graph.outgoing.slice(0, t.groups).map((g) => ({
      table: g.generic ? '(any table, document id)' : g.target,
      fields: g.fields.slice(0, t.fields).map(fieldNote),
      moreFields: more(g.fields.length, t.fields),
    })),
    morePointsAtTables: more(graph.outgoing.length, t.groups),
    pointedAtBy: graph.incoming.slice(0, t.groups).map((g) => ({
      table: g.table,
      fields: g.fields.slice(0, t.fields).map(incomingNote),
      moreFields: more(g.fields.length, t.fields),
    })),
    morePointedAtByTables: more(graph.incoming.length, t.groups),
    systemTableFieldsLeftOut: graph.hiddenIncomingFields || undefined,
    linkTables: model.linkTables === null
      ? 'not looked for: many tables point here'
      : Array.isArray(model.linkTables)
        ? model.linkTables.slice(0, t.links).map((l) => ({ table: l.table, joinsTo: (l.others || []).slice(0, 3).map((o) => o.target) }))
        : undefined,
    moreLinkTables: Array.isArray(model.linkTables) ? more(model.linkTables.length, t.links) : undefined,
    counts: { referenceFields: outFields, tablesPointedAt: graph.outgoing.length, fieldsPointingHere: inFields, tablesPointingHere: graph.incoming.length },
    incomingTruncated: model.incomingTruncated || undefined,
    notes: (model.notes || []).slice(0, t.notes).map((n) => clip(n, 160)),
  };
}

// ---- find_dotwalk_path ----------------------------------------------------------------------------------------------

const PATH_TIERS = [
  { routes: 6, variants: 4 },
  { routes: 4, variants: 3 },
  { routes: 3, variants: 2 },
  { routes: 2, variants: 1 },
];

function routeFacts(routes, t, limit = t.routes) {
  return routes.slice(0, limit).map((r) => ({
    via: r.tables.map((x) => clip(x, 60)).join(' > '),
    steps: r.length,
    dotWalk: r.variants.slice(0, t.variants).map((v) => clip(v.dotWalk, 120)),
    moreDotWalks: more(r.variants.length, t.variants),
    endsOnChildTable: r.variants.some((v) => v.viaChild) || undefined,
  }));
}

/** The path finder's result (dataModelFindPaths) as a compact answer: the shortest routes with their dot-walk strings. */
export function shapePathReport(result = {}) {
  return fit(PATH_TIERS, (t) => shapePath(result, t));
}

function shapePath(result, t) {
  const { from, to } = result;
  const routes = result.routes || [];
  const out = { from, to, searchedUpTo: result.maxDepth, truncated: result.truncated || undefined, tablesNotExpanded: result.unexpanded?.length ? result.unexpanded.slice(0, 6) : undefined };
  if (result.same) {
    out.result = 'same-table';
    out.summary = `${from} and ${to} are the same table; no dot-walk is needed.`;
  } else if (result.inherits) {
    out.result = 'inherits';
    out.summary = `${from} extends ${to}, so every field of ${to} is already a field of ${from}.`;
  } else if (routes.length) {
    out.result = 'paths';
    out.pathCount = (result.paths || []).length;
    out.shortestSteps = routes[0].length;
    out.routes = routeFacts(routes, t);
    out.moreRoutes = more(routes.length, t.routes);
    out.summary = `${out.pathCount} dot-walk path${out.pathCount === 1 ? '' : 's'} from ${from} to ${to}, shortest ${routes[0].length} step${routes[0].length === 1 ? '' : 's'}: ${clip(routes[0].variants[0].dotWalk, 120)}.`;
    out.usage = 'Add the column to read at the end (for example .name). Stopping at the reference gives its display value. A route that endsOnChildTable ends on a table that extends the target.';
  } else if (result.reverse?.routes?.length) {
    out.result = 'reverse-only';
    out.reverse = { from: result.reverse.from, to: result.reverse.to, shortestSteps: result.reverse.routes[0].length, routes: routeFacts(result.reverse.routes, t, Math.min(3, t.routes)) };
    out.summary = `No path from ${from} to ${to}, but ${result.reverse.from} reaches ${result.reverse.to}: ${clip(result.reverse.routes[0].variants[0].dotWalk, 120)}.`;
  } else {
    out.result = 'none';
    out.summary = `No dot-walk path of up to ${result.maxDepth} steps from ${from} to ${to}${result.limited ? ' (the search stopped at its table limit)' : ''}.`;
  }
  if ((result.list || []).length && !routes.length) {
    out.listFields = result.list.slice(0, 3).map((p) => `${clip(p.dotWalk, 100)} (a list of references: it cannot be dot-walked)`);
  }
  if ((result.generic || []).length) {
    out.genericFields = result.generic.slice(0, 3).map((p) => `${clip(p.dotWalk, 100)} (holds a record of any table: it cannot be dot-walked)`);
  }
  if (result.limited) out.limited = 'The search read as many tables as it is allowed to; a longer route may exist.';
  if ((result.notes || []).length) out.notes = result.notes.slice(0, 2).map((n) => clip(n, 160));
  return out;
}

// ---- explain_preview_problems ---------------------------------------------------------------------------------------

/** The retrieved update sets (previewProblemSets) as a short list, for when no update set was named. */
export function shapeRetrievedSets(sets = [], note = '') {
  const shown = 15;
  return {
    retrievedUpdateSets: sets.slice(0, shown).map((s) => ({ name: clip(s.name, 100), sysId: s.sysId, state: s.stateLabel || s.state, problemsRecorded: s.problemCount ?? undefined, application: s.application ? clip(s.application, 60) : undefined })),
    more: more(sets.length, shown),
    note: note ? clip(note, 200) : 'Pass updateSet (a name or sys_id from this list) to see why one of them will not commit.',
  };
}

const PREVIEW_TIERS = [{ problems: 8 }, { problems: 6 }, { problems: 4 }, { problems: 2 }];

/** The preview-problems analysis (previewProblemLoad) as a compact answer: the verdict, each open problem with its next step. */
export function shapePreviewAnalysis(analysis = {}) {
  return fit(PREVIEW_TIERS, (t) => shapePreview(analysis, t));
}

function shapePreview(analysis, t) {
  const set = analysis.set || {};
  const problems = analysis.problems || [];
  const open = problems.filter((p) => isOpen(p.status));
  const closed = problems.filter((p) => !open.includes(p));
  const v = analysis.verdict || {};
  const chain = analysis.order?.chain || [];
  return {
    updateSet: { sysId: set.sysId, name: clip(set.name, 100), state: set.stateLabel || set.state, application: set.application ? clip(set.application, 60) : undefined, link: recordLink(SET_TABLE, set.sysId) || undefined },
    verdict: { level: v.level, headline: clip(v.headline, 120), detail: v.detail ? clip(v.detail, 260) : undefined, openProblems: v.blockers, canSkipSafely: v.safeToSkip || undefined, createdInAnotherRetrievedSet: v.fixable || undefined },
    counts: { total: analysis.counts?.total ?? problems.length, open: open.length, alreadyDealtWith: closed.length },
    byKind: (analysis.groups || []).filter((g) => g.open).slice(0, 12).map((g) => `${clip(g.label, 50)}: ${g.open}`),
    // What a kind of problem means is said once, on its first problem; the rest repeat only what is specific to them.
    openProblems: open.slice(0, t.problems).map((p, i, shown) => ({
      problem: clip(p.explain?.label || p.kind, 60),
      target: clip(p.update?.target || p.update?.name || p.id, 100),
      updateType: p.update?.type ? clip(p.update.type, 40) : undefined,
      instanceSays: p.description ? safe(p.description, 180) : undefined,
      meaning: p.explain?.meaning && !shown.slice(0, i).some((q) => q.kind === p.kind) ? clip(p.explain.meaning, 200) : undefined,
      provider: p.providerNote ? clip(p.providerNote, 200) : undefined,
      collision: p.collision?.lines?.length ? p.collision.lines.slice(0, 2).map((l) => clip(l, 160)) : undefined,
      nextStep: p.next ? clip(p.next, 200) : undefined,
      skipSafety: p.explain?.skipSafety || undefined,
      link: p.links?.problem || undefined,
    })),
    moreOpenProblems: more(open.length, t.problems),
    commitOrder: chain.length > 1 ? chain.slice(0, 8).map((c) => `${clip(c.name, 80)}${c.focus ? ' (this update set)' : ''}`) : undefined,
    commitOrderCycles: analysis.order?.cycles?.length ? analysis.order.cycles.slice(0, 2).map((c) => c.slice(0, 6).map((n) => clip(n, 60))) : undefined,
    notChecked: (analysis.limits || []).slice(0, 4).map((l) => clip(l, 160)),
    truncated: analysis.truncated || undefined,
  };
}

// ---- run_selfcheck --------------------------------------------------------------------------------------------------

const SELF_TIERS = [
  { tools: 15, causes: 5, names: 10, ok: 60, checks: 8 },
  { tools: 10, causes: 4, names: 6, ok: 30, checks: 5 },
  { tools: 6, causes: 3, names: 4, ok: 0, checks: 3 },
  { tools: 4, causes: 2, names: 3, ok: 0, checks: 2 },
];

// How a problem is written after its table.column, so "needs" says what is wrong with each name.
const PROBLEM_SUFFIX = { 'table-missing': ' (table is not on this instance)', 'table-denied': ' (table not readable for your user)', 'column-hidden': ' (defined, but not returned to your user)', 'table-unknown': ' (could not be checked)', 'column-unverified': ' (could not be checked)' };
const problemName = (p) => `${p.column ? `${p.table}.${p.column}` : p.table}${PROBLEM_SUFFIX[p.kind] || ''}`;

/**
 * The Self-check result (doctorRun) as a compact answer: the verdict, the API results, the tools that will not work or
 * work with gaps with the exact table.column names behind each, and the causes that explain several tools at once.
 * The result holds no token, key, user name or record value (the Self-check's own rule); free text is redacted again.
 */
export function shapeSelfCheck(result = {}) {
  return fit(SELF_TIERS, (t) => shapeSelf(result, t));
}

function shapeSelf(result, t) {
  const o = result.overall || {};
  const checks = result.checks || [];
  const tools = result.tools || [];
  const attention = tools.filter((x) => x.status !== 'ok');
  const names = (problems, level) => problems.filter((p) => p.level === level).map(problemName);
  const cap = (list) => list.slice(0, t.names);
  const out = {
    verdict: { status: o.status, headline: clip(o.headline, 200), detail: o.detail ? clip(o.detail, 240) : undefined },
    instance: { host: result.instance?.host || undefined, release: result.instance?.release || undefined, environment: result.instance?.env || undefined, looksProduction: result.instance?.looksProduction || undefined },
    nowbuddyVersion: result.extension?.version || undefined,
    you: { tier: result.user?.tier ?? undefined, roles: result.user?.roleCount ?? undefined, admin: result.user?.admin ?? undefined },
    page: result.page?.label || undefined,
    counts: result.counts,
    apiReach: checks.filter((c) => c.group === 'api').map((c) => ({ check: clip(c.title, 50), status: c.status, summary: safe(c.summary, 160), ms: Number.isFinite(c.ms) ? c.ms : undefined, todo: c.status !== 'ok' && c.status !== 'skip' && c.action ? safe(c.action, 140) : undefined })),
    otherChecksToLookAt: checks.filter((c) => c.group !== 'api' && c.status !== 'ok').slice(0, t.checks).map((c) => ({ check: clip(c.title, 50), status: c.status, summary: safe(c.summary, 160), todo: c.action ? safe(c.action, 140) : undefined })),
    otherChecksPassed: checks.filter((c) => c.group !== 'api' && c.status === 'ok').length,
    toolsNeedingAttention: attention.slice(0, t.tools).map((x) => {
      const needs = names(x.problems, 'blocking');
      const optional = names(x.problems, 'gap');
      const unchecked = names(x.problems, 'unverified');
      return {
        tool: clip(x.feature, 50),
        status: x.status,
        summary: safe(x.summary, 200),
        needs: needs.length ? cap(needs) : undefined,
        optionalMissing: optional.length ? cap(optional) : undefined,
        notChecked: unchecked.length ? cap(unchecked) : undefined,
        moreNames: more(needs.length, t.names) || more(optional.length, t.names) || more(unchecked.length, t.names),
      };
    }),
    moreTools: more(attention.length, t.tools),
    toolsThatAreFine: t.ok ? tools.filter((x) => x.status === 'ok').slice(0, t.ok).map((x) => clip(x.feature, 40)) : tools.filter((x) => x.status === 'ok').length,
    causes: (result.causes || []).slice(0, t.causes).map((c) => ({ what: c.column ? `${c.table}.${c.column}` : c.table, kind: c.kind, blocking: c.blocking || undefined, affects: c.features.slice(0, 5), moreAffected: more(c.features.length, 5), advice: clip(c.advice, 160) })),
    moreCauses: more((result.causes || []).length, t.causes),
    dictionary: result.schema ? { sys_db_object: result.schema.dbObject, sys_dictionary: result.schema.dictionary, tablesLookedUp: result.schema.tablesLooked, columnListCut: result.schema.truncated || undefined } : undefined,
    notes: (result.notes || []).slice(0, 4).map((n) => safe(n, 160)),
    requests: result.requests,
    tookMs: result.durationMs,
    scriptCheck: 'not run: this tool never runs a script on the instance',
  };
  return maskDeep(out);
}

// ---- find_property --------------------------------------------------------------------------------------------------

/** The exact property name get and usage need: letters, digits, dots, dashes and underscores, 3 to 100 characters. */
export const PROPERTY_NAME_RE = /^[A-Za-z0-9_.\-]{3,100}$/;

/**
 * What to print for a property's value. A password-type property, one whose name says secret, and one whose value looks
 * like a credential show a reason and never the value; the check is made again here, whatever the caller marked.
 */
function propertyValue(p, max) {
  const reason = p.hidden ? p.hiddenReason || 'It is a secret.' : secretReason({ name: p.name, type: p.type, value: p.value });
  if (reason) return { hidden: true, value: `(hidden: ${clip(reason, 100)})` };
  if (p.unreadable) return { value: '(not returned: your user may not be allowed to read the value)' };
  return { value: p.value === '' ? '(empty)' : safe(p.value, max) };
}

function propertyRow(p, valueMax = 120) {
  const v = propertyValue(p, valueMax);
  return {
    name: clip(p.name, 120),
    value: v.value,
    hidden: v.hidden || undefined,
    type: clip(p.typeLabel || p.type, 30) || undefined,
    description: p.description ? safe(p.description, 120) : undefined,
    scope: p.scope ? clip(p.scope, 40) : undefined,
    matchedIn: p.matchedIn || undefined,
    link: propertyPath(p.sysId) || undefined,
  };
}

const PROPERTY_TIERS = [{ rows: 15 }, { rows: 10 }, { rows: 6 }, { rows: 3 }];

/** propertyExplorerSearch's answer: the best matches, secrets never carrying a value. */
export function shapePropertySearch({ query = '', rows = [], total = 0, capped = false, notes = [] } = {}) {
  return fit(PROPERTY_TIERS, (t) => {
    const shown = rows.slice(0, t.rows);
    return {
      query: clip(query, 80),
      results: shown.map((p) => propertyRow(p)),
      moreMatches: more(Math.max(total, rows.length), shown.length),
      capped: capped || undefined,
      note: shown.length ? (capped ? 'The instance returned only the first 100 matches of each search; add a word to narrow it.' : undefined) : `No property matches "${clip(query, 60)}".`,
      notes: notes.slice(0, 3).map((n) => clip(n, 160)),
    };
  });
}

/** propertyExplorerGet's answer for one exact name. */
export function shapePropertyGet({ property = null, others = 0, notes = [] } = {}, name = '') {
  if (!property) {
    return { found: false, name: clip(name, 120), note: 'No property has this exact name, or your user cannot read it. Use mode "search" to look for similar names.', notes: notes.slice(0, 3).map((n) => clip(n, 160)) };
  }
  const row = propertyRow(property, 600);
  return {
    found: true,
    property: {
      ...row,
      choices: property.choices?.length ? property.choices.slice(0, 12).map((c) => clip(c, 40)) : undefined,
      isPrivate: property.isPrivate ?? undefined,
      readRoles: property.readRoles ? clip(property.readRoles, 100) : undefined,
      writeRoles: property.writeRoles ? clip(property.writeRoles, 100) : undefined,
      updatedOn: property.updatedOn || undefined,
      updatedBy: property.updatedBy || undefined,
    },
    others: others || undefined,
    othersNote: others ? `${others} more propert${others === 1 ? 'y has' : 'ies have'} the same name (different scopes); this is the first.` : undefined,
    notes: notes.slice(0, 3).map((n) => clip(n, 160)),
  };
}

const USAGE_TIERS = [{ hits: 12, lines: 2 }, { hits: 8, lines: 2 }, { hits: 5, lines: 1 }, { hits: 3, lines: 1 }];

/** findPropertyUsage's answer: which active scripts read, set or only mention the property, with the lines. */
export function shapePropertyUsage(usage = {}) {
  const name = usage.name || '';
  const secretName = nameLooksSecret(name);
  const hits = usage.hits || [];
  return fit(USAGE_TIERS, (t) => ({
    name: clip(name, 120),
    summary: clip(usage.summary, 360),
    counts: usageCounts(hits),
    hits: hits.slice(0, t.hits).map((h) => ({
      kind: h.kind,
      in: clip(h.label, 40),
      name: clip(h.name, 80),
      field: h.field || undefined,
      link: h.url || undefined,
      lines: (h.lines || []).slice(0, t.lines).map((l) => ({
        line: l.line,
        kind: l.kind,
        text: safe(l.text, 160),
        // The second argument of a read is its default, and the default of a secret can be the secret.
        arg: l.arg && !secretName ? safe(l.arg, 40) : undefined,
        via: l.via || undefined,
      })),
    })),
    moreHits: more(hits.length, t.hits),
    commentOnly: usage.commentOnly || undefined,
    notFullySearched: usage.capped?.length ? `Only the first 100 matches were read in ${usage.capped.join(', ')}.` : undefined,
    couldNotSearch: usage.errors?.length ? usage.errors.slice(0, 5).map((e) => clip(e.label, 40)) : undefined,
    limits: USAGE_LIMITS_NOTE,
  }));
}

// ---- read_client_trace ----------------------------------------------------------------------------------------------

const TRACE_TIERS = [
  { rows: 20, findings: 8, stories: 8, steps: 6 },
  { rows: 12, findings: 5, stories: 5, steps: 4 },
  { rows: 8, findings: 3, stories: 3, steps: 3 },
  { rows: 4, findings: 2, stories: 2, steps: 2 },
];

/** The recorder's state (clientTraceStatus / the state inside clientTraceLoad), reduced to what an agent needs. */
function traceRecording(state = {}) {
  return {
    armed: Boolean(state.armed),
    minutesLeft: state.armed ? state.minutesLeft : undefined,
    recorder: state.recorder,
    frames: Array.isArray(state.frames) ? state.frames.slice(0, 8).map((f) => ({ frame: clip(f.frame, 40), events: f.count, missing: f.missing || undefined })) : undefined,
    page: state.page ? clip(state.page, 100) : undefined,
  };
}

/** Said when there is nothing to read, so "nothing recorded" is never mistaken for "nothing happened". */
export function traceNothingNote(state = {}, eventCount = 0) {
  if (state.recorder === 'missing') return 'The recorder is not loaded in this page (it loads when the page starts). Ask the user to reload the page once, then arm Client trace.';
  if (eventCount) return '';
  if (state.armed) return `Recording is on${state.minutesLeft ? ` (${state.minutesLeft} min left)` : ''}, but nothing has been captured yet. Ask the user to reproduce the problem on the form, then read again.`;
  return 'Nothing was recorded and recording is off. Ask the user to open the Client trace panel, press "Reload and record", and reproduce the problem. This tool never starts or stops recording.';
}

/** At most this many script ids, UI script names and GlideAjax classes are looked up on the instance for one read. */
export const TRACE_LOOKUP_CAPS = { ids: 40, names: 10, classes: 10 };

/** What to ask the instance about, for the rows that will be shown: the script ids, UI script names and classes in them, capped. */
export function traceRefs(load = {}, { scope = 'current' } = {}, caps = TRACE_LOOKUP_CAPS) {
  const refs = collectRefs(selectDocuments(buildRows(load.events || []), scope));
  return { ids: refs.ids.slice(0, caps.ids), names: refs.names.slice(0, caps.names), classes: refs.classes.slice(0, caps.classes) };
}

/**
 * The Client trace recording (clientTraceLoad) as a compact answer: what stands out first, a story per field, and a
 * short timeline (problems and slow calls kept when it has to be cut). A script the instance confirmed (`resolved`, from
 * clientTraceResolve) is named; any other is "Unknown script" and shown by its nearest stack frame, never guessed.
 * @param {{ state: object, events: object[] }} load
 * @param {{ scope?: 'current'|'all', field?: string, limit?: number, resolved?: object, lookupNote?: string }} [options]
 */
export function shapeClientTrace(load = {}, { scope = 'current', field = '', limit = 20, resolved = {}, lookupNote = '' } = {}) {
  const state = load.state || {};
  const rows = buildRows(load.events || []);
  const scoped = selectDocuments(rows, scope);
  const view = field ? scoped.filter((r) => r.field === field) : scoped;
  const findings = findFindings(scoped, resolved).filter((f) => !field || f.rowKeys.some((k) => view.some((r) => r.key === k)));
  const stories = buildStories(scoped, resolved).filter((s) => !field || s.field === field);
  const pageLoads = documentsOf(scoped).length;
  const who = (row) => {
    const found = attribute(row, resolved);
    return clip(found.known ? found.label : found.where, 100);
  };
  return fit(
    TRACE_TIERS.map((t) => ({ ...t, rows: Math.min(t.rows, limit) })),
    (t) => {
      // Problems and slow calls first when the list has to be cut; shown in time order.
      const notable = (r) => isProblem(r) || isSlow(r);
      const keep = new Set([...view.filter(notable), ...view.filter((r) => !notable(r))].slice(0, t.rows).map((r) => r.key));
      const shown = view.filter((r) => keep.has(r.key));
      const out = {
        recording: traceRecording(state),
        scope,
        field: field || undefined,
        events: view.length,
        pageLoads,
        note: traceNothingNote(state, view.length) || undefined,
        scriptNames: lookupNote || (resolved.notes?.length ? `Some scripts could not be looked up: ${clip(resolved.notes[0], 120)}` : undefined),
        findings: findings.slice(0, t.findings).map((f) => ({ severity: f.severity, title: safe(f.title, 140), detail: safe(f.detail, 200) })),
        moreFindings: more(findings.length, t.findings),
        fields: stories.slice(0, t.stories).map((s) => ({
          field: s.field,
          frame: s.frame || undefined,
          scriptsChangingIt: s.scripts,
          steps: s.steps.slice(0, t.steps).map((st) => ({ at: fmtMs(st.t), did: safe(st.text, 120), from: st.known ? clip(st.by, 80) : clip(st.where, 100) })),
          moreSteps: more(s.steps.length, t.steps),
        })),
        moreFields: more(stories.length, t.stories),
        timeline: shown.map((r) => {
          const d = describeRow(r);
          const problem = isProblem(r);
          return {
            at: fmtMs(r.t),
            frame: r.frame || undefined,
            kind: TRACE_KINDS[r.kind]?.label || r.kind,
            what: safe(d.title, 140),
            detail: d.detail ? safe(d.detail, 160) : undefined,
            took: Number.isFinite(r.durationMs) && r.durationMs >= 1 ? fmtMs(r.durationMs) : undefined,
            problem: problem || undefined,
            slow: isSlow(r) || undefined,
            from: problem ? who(r) : undefined,
          };
        }),
        moreTimeline: more(view.length, shown.length),
      };
      return maskDeep(out);
    }
  );
}

// ---- find_artifact --------------------------------------------------------------------------------------------------

const NONE_REASON = {
  empty: 'term is empty.',
  command: 'term must be a name, not a command.',
  'sys_id': 'That is a sys_id. Use read_artifact (table + sysId) or query_table to open it.',
  'record number': 'That looks like a record number (INC0010042...). find_artifact searches configuration by name; use query_table or navigate for a record.',
  'too long': 'term is too long (80 characters at most).',
  caret: 'term may not contain ^.',
  script: 'term may not start with "javascript:".',
  'looks like a query or a link': 'term must be a name or part of a name, not a query or a link.',
  'too short': 'term needs at least 3 characters (2 when kind is given).',
};

/** The kind a word names ("br", "business rule", "script includes"), or a plain error listing the ids. */
export function resolveKind(word) {
  const kind = kindForWord(word);
  if (!kind) throw new Error(`kind must be one of ${ARTIFACT_KIND_IDS.join(', ')} (or its full name, such as "business rule").`);
  return kind;
}

const detailOf = (c) => [c.bound !== c.name ? c.bound : '', ...(c.lead || []), ...(c.extra || [])].filter(Boolean).join(' · ');

/**
 * Go to anything for the agent: search configuration records by name across the kinds (or in one kind). Read-only
 * through the injected `query` (queryTable). A fresh engine per call, so two searches at once never cancel each other.
 * `exclude`: kind ids that are never searched (their table is a credential table or on the user's denied-tables list).
 * @param {{ query: Function, term: string, kind?: string, limit?: number, tier?: string|null, ctx?: object, exclude?: string[],
 *           linkFor?: (table: string, sysId: string) => string }} input
 */
export async function searchArtifacts({ query, term, kind = '', limit, tier = null, ctx = {}, exclude = [], linkFor = (table, id) => `/${table}.do?sys_id=${id}` } = {}) {
  const clean = assertNameTerm(term, 'term');
  const wanted = kind ? resolveKind(kind) : null;
  const max = Math.max(1, Math.min(MAX_MATCHES, Math.round(Number(limit)) || DEFAULT_MATCHES));
  const parsed = parseGoTo(wanted ? `${wanted.id}: ${clean}` : clean, { ctx, tier });
  if (parsed.mode === 'none') throw new Error(NONE_REASON[parsed.reason] || 'term must be a name or part of a name.');
  if (parsed.mode === 'kind' && parsed.tooShort) throw new Error(NONE_REASON['too short']);
  const skipped = new Set(Array.isArray(exclude) ? exclude : []);
  if (wanted && skipped.has(wanted.id)) throw new Error(`${wanted.plural} are not searched: ${wanted.table} is on the denied-tables list or holds credentials.`);
  const leftOut = [...parsed.kinds, ...(parsed.more || [])].filter((id) => skipped.has(id));
  if (leftOut.length) {
    parsed.kinds = parsed.kinds.filter((id) => !skipped.has(id));
    parsed.more = (parsed.more || []).filter((id) => !skipped.has(id));
    if (!parsed.kinds.length && parsed.more.length) [parsed.kinds, parsed.more] = [parsed.more, []];
    if (!parsed.kinds.length) throw new Error('Every kind this term could be is on the denied-tables list or holds credentials, so nothing was searched.');
  }
  if (!parsed.kinds.length) throw new Error(`${wanted ? wanted.plural : 'These kinds'} need a role you do not have in this session, so they are not searched.`);

  const engine = createGoToEngine({ query });
  const result = await engine.search({ term: parsed.term, kinds: parsed.kinds, more: parsed.more || [], mode: parsed.mode });
  if (!result) throw new Error('The search was cancelled.');
  const { candidates, meta } = result;
  if (meta.expired) throw new Error('The ServiceNow session has expired. Log in again, then retry.');

  const ranked = rankCandidates(candidates, parsed.term, { recents: new Map(), ctx });
  const limits = LIMITS[parsed.mode === 'kind' ? 'kind' : 'bare'];
  const chosen = selectRows(ranked, { perKind: limits.perKind, perName: limits.perName, total: max });
  const labelOf = (id) => kindById(id)?.label || id;
  const searched = [...new Set([...meta.searched, ...meta.cached])];
  const unreadable = [...new Set(meta.unavailable)];
  const build = (rowCap) => {
    const shown = chosen.slice(0, rowCap);
    const out = {
      term: parsed.term,
      kind: wanted ? wanted.label : undefined,
      results: shown.map(({ c }) => ({
        kind: labelOf(c.kind),
        kindId: c.kind,
        name: clip(c.name, 100),
        table: c.table,
        sysId: c.sysId,
        scope: c.scope || c.scopeName ? clip(c.scope || c.scopeName, 40) : undefined,
        active: c.active === null ? undefined : c.active,
        detail: detailOf(c) ? clip(detailOf(c), 100) : undefined,
        link: linkFor(c.table, c.sysId),
      })),
      moreMatches: more(ranked.length, shown.length),
      searchedKinds: searched.map(labelOf),
      couldNotRead: unreadable.length ? unreadable.map(labelOf) : undefined,
      failedKinds: meta.failed.length ? meta.failed.map((f) => `${labelOf(f.kind)} (${f.reason})`) : undefined,
    };
    const notes = [];
    if (!shown.length) {
      notes.push(searched.length ? `No match for "${parsed.term}" in ${searched.map(labelOf).join(', ')}.` : `Nothing could be searched for "${parsed.term}".`);
    }
    if (unreadable.length) notes.push(`Not readable with your roles: ${unreadable.map(labelOf).join(', ')}.`);
    if (leftOut.length) notes.push(`Not searched (denied-tables list or credentials): ${leftOut.map(labelOf).join(', ')}.`);
    if (parsed.mode === 'bare') notes.push('A name without a kind searches the most likely kinds only; pass kind to search one kind in full.');
    if (out.moreMatches) notes.push('Each kind returns its most recently changed matches first; add words to the term or pass kind to narrow it.');
    if (notes.length) out.note = notes.join(' ');
    return maskDeep(out);
  };
  // Rows are cut, best matches kept, if a crowd of long names would push the answer over the budget.
  return fit([max, Math.ceil(max * 0.75), Math.ceil(max / 2), Math.ceil(max / 4)], build);
}
