// Release notes for an update set, for a ticket, a change request or a pull request: what changed (grouped by type, one
// plain headline each, with the record's own description when it has one), what is risky, what to test and how to back out.
// Pure and deterministic; nothing here asks an AI. The instance half is src/content/releaseNotes.js and the panel
// src/sidebar/ReleaseNotesPanel.jsx. The checks come from the Ship check (src/lib/updateSetReview.js), not a second opinion.

import { riskyKind, tableForEntry } from './updateSetReview.js';

const refValue = (v) => (v && typeof v === 'object' ? v.value || '' : String(v ?? ''));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
const oneLine = (s, max = 200) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** "created" / "changed" / "deleted" for one entry. `created` is true for records made after the update set was started. */
export function entryVerb(entry, created = false) {
  if (String(entry?.action || '').toUpperCase() === 'DELETE') return 'deleted';
  return created ? 'created' : 'changed';
}

// What to test, by the kind of record touched. First match per type wins.
const TESTING = [
  [/business rule/i, 'Create, update and delete a record on the affected table and confirm the rule fires (before / after / async as configured) without side effects.'],
  [/script include/i, 'Run every caller of the changed Script Includes; test client-callable ones from the UI as a normal user.'],
  [/client script|catalog client script|ui policy|ui script/i, 'Open the affected forms as a normal user, change the fields involved and check onLoad / onChange / onSubmit behaviour (and workspace or mobile if you use them).'],
  [/ui action/i, 'Click each changed button, as a user with and without the roles it needs; check its condition hides it when it should.'],
  [/access control|\bacl\b/i, 'Test read, write, create and delete as a non-admin user with the role and again without it, on records both inside and outside their group.'],
  [/\brole\b/i, 'Check who now holds the role and what it lets them do.'],
  [/system propert/i, 'Check the property value on the target instance: this set overwrites it.'],
  [/dictionary|^table$/i, 'Check list and form layouts and existing data for the changed columns; schema changes on large tables can be slow.'],
  [/scheduled|fix script|script action/i, 'Run it once on the target (dry run first if it writes data) and check the log.'],
  [/flow|workflow|playbook/i, 'Trigger a test record through the flow and watch its execution.'],
  [/notification|email/i, 'Send a test notification and check recipients, subject and body.'],
  [/rest|web service|api/i, 'Call each changed resource with a valid and an invalid request.'],
  [/widget|portal|ui page|page/i, 'Load each changed page or widget in the portal as a normal user.'],
  [/transform|import|data source/i, 'Run the import with a small sample and check the target records.'],
];

/** Testing lines for the types in a set; types with no rule are listed together at the end. */
export function testingNotes(types, risks = []) {
  const lines = [];
  const unmatched = [];
  [...types].forEach((type) => {
    const rule = TESTING.find(([re]) => re.test(type));
    if (rule) {
      if (!lines.includes(rule[1])) lines.push(rule[1]);
    } else if (type) unmatched.push(type);
  });
  if (unmatched.length) lines.push(`Smoke test the areas touched by: ${unmatched.join(', ')}.`);
  if (risks.some((r) => r.id === 'lint')) lines.push('Re-run the changed scripts with edge cases (empty values, large lists, a user without the usual roles).');
  return lines;
}

/** Deployment and back-out lines. `verdict` is the Ship check verdict ('ready' | 'warnings' | 'blockers' | ''). */
export function deploymentNotes({ risks = [], deletions = 0, verdict = '' } = {}) {
  const has = (id) => risks.some((r) => r.id === id);
  const lines = [];
  if (verdict === 'blockers') lines.push('The Ship check reports blockers: resolve them before committing.');
  lines.push('Load the update set on the target and run Preview; fix every problem it reports before committing.');
  lines.push('Commit in order if other update sets contain the same records (the Ship check lists collisions).');
  if (has('dictionary')) lines.push('Commit schema changes outside business hours; they are the hardest part to undo.');
  if (has('property')) lines.push('Compare the system property values on the target before and after committing.');
  if (has('acl') || has('role')) lines.push('Verify access with a non-admin test user straight after committing.');
  lines.push('Backout: once the set is committed on the target, use Back Out on the committed update set to restore the previous versions of its records. Note the version number of each changed record first (Versions > Compare) so you can restore it by hand if needed.');
  lines.push('Not undone by a back-out: data created by the changes, schema changes, and values of system properties set after commit.');
  if (deletions) lines.push(`${plural(deletions, 'record')} are deleted by this set: a deleted record has to be recreated or restored from its version history.`);
  return lines;
}

/**
 * @param {object} input
 *   set: { name, state, application, applicationName, description, createdBy, updatedOn }
 *   entries: sys_update_xml rows; total: number of entries in the set (may exceed entries.length)
 *   scripts: analyseEntryScripts() results (flattened) for the entries
 *   descriptions: { [entry sys_id]: text }  created: { [entry sys_id]: true }
 *   verdict: Ship check verdict; host, generatedAt: strings
 */
export function buildReleaseModel({ set = {}, entries = [], total = null, scripts = [], descriptions = {}, created = {}, verdict = '', host = '', generatedAt = '' } = {}) {
  const count = Number.isFinite(total) && total > entries.length ? total : entries.length;
  const riskMap = new Map(); // id -> { id, label, why, items: string[] }
  const addRisk = (id, label, why, item) => {
    if (!riskMap.has(id)) riskMap.set(id, { id, label, why, items: [] });
    const list = riskMap.get(id).items;
    if (!list.includes(item)) list.push(item);
  };

  const items = entries.map((entry) => {
    const name = oneLine(entry.target_name || entry.name, 120);
    const flags = [];
    const kind = riskyKind(entry);
    if (kind) {
      flags.push(kind.label);
      addRisk(kind.id, kind.plural, kind.why, name);
    }
    const own = scripts.filter((s) => s.entrySysId === entry.sys_id);
    const high = own.reduce((n, s) => n + (s.high || 0), 0);
    if (own.some((s) => s.syntaxError)) {
      flags.push('syntax error');
      addRisk('syntax', 'scripts with syntax errors', 'The script will not run.', name);
    } else if (high) {
      flags.push(`${plural(high, 'high lint finding')}`);
      addRisk('lint', 'scripts with high-severity lint findings', 'Review these before committing.', name);
    }
    const app = refValue(entry.application);
    const appName = entry['application.name'] || '';
    if (app === 'global' || /^global$/i.test(appName)) {
      flags.push('global scope');
      addRisk('global', 'changes in the global scope', 'Global changes affect every application on the target.', name);
    } else if (app && set.application && app !== set.application) {
      flags.push(`other scope: ${appName || app}`);
      addRisk('scope', 'entries from another application', 'This set was started in a different application than these entries.', name);
    }
    return {
      id: entry.sys_id,
      type: String(entry.type || '').trim() || 'Other',
      name,
      verb: entryVerb(entry, Boolean(created[entry.sys_id])),
      description: oneLine(descriptions[entry.sys_id] || '', 160),
      application: appName,
      flags,
      table: tableForEntry(entry) || '',
    };
  });

  const byType = new Map();
  items.forEach((it) => {
    if (!byType.has(it.type)) byType.set(it.type, []);
    byType.get(it.type).push(it);
  });
  const groups = [...byType.entries()]
    .map(([type, list]) => ({ type, items: list.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.items.length - a.items.length || a.type.localeCompare(b.type));

  const counts = { total: count, listed: entries.length, created: 0, changed: 0, deleted: 0 };
  items.forEach((it) => {
    counts[it.verb] += 1;
  });
  const risks = [...riskMap.values()].sort((a, b) => b.items.length - a.items.length);

  return {
    title: set.name || 'Update set',
    description: String(set.description || '').trim(),
    meta: { host, generatedAt, author: set.createdBy || '', updatedOn: set.updatedOn || '', state: set.state || '', application: set.applicationName || '' },
    counts,
    groups,
    risks,
    testing: testingNotes(byType.keys(), risks),
    deployment: deploymentNotes({ risks, deletions: counts.deleted, verdict }),
    truncated: count > entries.length ? count - entries.length : 0,
  };
}

// --- Rendering -------------------------------------------------------------------------------------------

const md = (s) => String(s ?? '').replace(/([\\`*_[\]<>])/g, '\\$1').replace(/\s+/g, ' ').trim();

function summaryLine(model) {
  const { counts } = model;
  const parts = [];
  if (counts.created) parts.push(`${counts.created} created`);
  if (counts.changed) parts.push(`${counts.changed} changed`);
  if (counts.deleted) parts.push(`${counts.deleted} deleted`);
  return `${plural(counts.total, 'change')}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

function metaLine(model) {
  const m = model.meta;
  return [m.application && `Application: ${m.application}`, m.host && `Instance: ${m.host}`, m.author && `Author: ${m.author}`, m.state && `State: ${m.state}`, m.generatedAt && `Generated: ${m.generatedAt}`].filter(Boolean);
}

/** Markdown for a wiki, pull request or ticket that renders it. */
export function releaseNotesToMarkdown(model, { testing = true, deployment = true } = {}) {
  const lines = [`# Release notes: ${md(model.title)}`, ''];
  if (model.description) lines.push(md(model.description), '');
  metaLine(model).forEach((l) => lines.push(`${md(l)}  `));
  lines.push('', `**${summaryLine(model)}**`, '');
  model.groups.forEach((g) => {
    lines.push(`## ${md(g.type)} (${g.items.length})`);
    g.items.forEach((it) => {
      const flags = it.flags.length ? ` _[${md(it.flags.join('; '))}]_` : '';
      lines.push(`- ${it.verb === 'deleted' ? '**Deleted** ' : it.verb === 'created' ? '**New** ' : ''}${md(it.name)}${it.description ? `: ${md(it.description)}` : ''}${flags}`);
    });
    lines.push('');
  });
  if (model.truncated) lines.push(`_${plural(model.truncated, 'more change')} not listed (the list is capped)._`, '');
  if (model.risks.length) {
    lines.push('## Risks', '');
    model.risks.forEach((r) => lines.push(`- **${md(r.label)}** (${r.items.length}): ${md(r.why)} ${md(r.items.slice(0, 5).join(', '))}${r.items.length > 5 ? `, and ${r.items.length - 5} more` : ''}`));
    lines.push('');
  }
  if (testing && model.testing.length) {
    lines.push('## Testing notes', '');
    model.testing.forEach((t) => lines.push(`- [ ] ${md(t)}`));
    lines.push('');
  }
  if (deployment && model.deployment.length) {
    lines.push('## Deployment and backout', '');
    model.deployment.forEach((t) => lines.push(`- [ ] ${md(t)}`));
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Plain text with no markup, for ticket fields that show everything literally. */
export function releaseNotesToText(model, { testing = true, deployment = true } = {}) {
  const plain = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const lines = [`RELEASE NOTES: ${plain(model.title)}`, ''];
  if (model.description) lines.push(plain(model.description), '');
  metaLine(model).forEach((l) => lines.push(plain(l)));
  lines.push('', summaryLine(model), '');
  model.groups.forEach((g) => {
    lines.push(`${plain(g.type).toUpperCase()} (${g.items.length})`);
    g.items.forEach((it) => {
      const flags = it.flags.length ? ` [${plain(it.flags.join('; '))}]` : '';
      lines.push(`- ${it.verb === 'deleted' ? 'DELETED: ' : it.verb === 'created' ? 'NEW: ' : ''}${plain(it.name)}${it.description ? ` - ${plain(it.description)}` : ''}${flags}`);
    });
    lines.push('');
  });
  if (model.truncated) lines.push(`(${plural(model.truncated, 'more change')} not listed: the list is capped.)`, '');
  if (model.risks.length) {
    lines.push('RISKS');
    model.risks.forEach((r) => lines.push(`- ${plain(r.label)} (${r.items.length}): ${plain(r.why)} ${plain(r.items.slice(0, 5).join(', '))}${r.items.length > 5 ? `, and ${r.items.length - 5} more` : ''}`));
    lines.push('');
  }
  if (testing && model.testing.length) {
    lines.push('TESTING NOTES');
    model.testing.forEach((t) => lines.push(`- ${plain(t)}`));
    lines.push('');
  }
  if (deployment && model.deployment.length) {
    lines.push('DEPLOYMENT AND BACKOUT');
    model.deployment.forEach((t) => lines.push(`- ${plain(t)}`));
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
