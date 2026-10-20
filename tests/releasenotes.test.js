const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReleaseModel, releaseNotesToMarkdown, releaseNotesToText, entryVerb, testingNotes, deploymentNotes } = require('../src/lib/releaseNotes.js');

const id = (n) => String(n).padStart(32, '0');
const entry = (n, over = {}) => ({ sys_id: `e${n}`, name: `sys_script_${id(n)}`, type: 'Business Rule', target_name: `Rule ${n}`, action: 'INSERT_OR_UPDATE', application: 'app1', 'application.name': 'Assets', ...over });
const SET = { name: 'Fix duplicate assets', state: 'in progress', application: 'app1', applicationName: 'Assets', description: 'Stops duplicate parents.', createdBy: 'beth.anglin', updatedOn: '2026-10-20 09:00:00' };

test('an entry reads as created, changed or deleted', () => {
  assert.equal(entryVerb({ action: 'DELETE' }, true), 'deleted');
  assert.equal(entryVerb({ action: 'INSERT_OR_UPDATE' }, true), 'created');
  assert.equal(entryVerb({ action: 'INSERT_OR_UPDATE' }, false), 'changed');
});

test('the model groups by type (largest first), counts verbs and uses the record description', () => {
  const entries = [entry(1), entry(2), entry(3, { type: 'Script Include', name: `sys_script_include_${id(3)}`, target_name: 'AssetUtils' }), entry(4, { action: 'DELETE', target_name: 'Old rule' })];
  const model = buildReleaseModel({ set: SET, entries, descriptions: { e1: '  Aborts when the parent\nis set.  ' }, created: { e2: true }, host: 'dev.service-now.com', generatedAt: '2026-10-20' });
  assert.deepEqual(model.groups.map((g) => [g.type, g.items.length]), [['Business Rule', 3], ['Script Include', 1]]);
  assert.deepEqual(model.counts, { total: 4, listed: 4, created: 1, changed: 2, deleted: 1 });
  const rule1 = model.groups[0].items.find((i) => i.id === 'e1');
  assert.equal(rule1.description, 'Aborts when the parent is set.', 'whitespace and newlines collapse');
  assert.equal(model.meta.author, 'beth.anglin');
  assert.equal(model.truncated, 0);
});

test('risks come from the type, the scripts and the scope, and each says why', () => {
  const entries = [
    entry(1, { type: 'Access Control', name: `sys_security_acl_${id(1)}`, target_name: 'incident.state' }),
    entry(2, { type: 'System Property', name: `sys_properties_${id(2)}`, target_name: 'glide.x' }),
    entry(3),
    entry(4, { application: 'global', 'application.name': 'Global' }),
    entry(5, { application: 'app2', 'application.name': 'Other app' }),
    entry(6),
  ];
  const scripts = [{ entrySysId: 'e3', high: 2, syntaxError: false }, { entrySysId: 'e6', high: 0, syntaxError: true }];
  const model = buildReleaseModel({ set: SET, entries, scripts });
  const ids = model.risks.map((r) => r.id).sort();
  assert.deepEqual(ids, ['acl', 'global', 'lint', 'property', 'scope', 'syntax']);
  assert.ok(model.risks.every((r) => r.why && r.items.length));
  const lint = model.groups.flatMap((g) => g.items).find((i) => i.id === 'e3');
  assert.deepEqual(lint.flags, ['2 high lint findings']);
  assert.ok(model.groups.flatMap((g) => g.items).find((i) => i.id === 'e5').flags[0].startsWith('other scope: Other app'));
});

test('testing notes follow the types touched and list the unknown ones together', () => {
  const lines = testingNotes(new Set(['Business Rule', 'Access Control', 'Mystery Thing', 'Other Thing']));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /rule fires/);
  assert.match(lines[1], /non-admin/);
  assert.equal(lines[2], 'Smoke test the areas touched by: Mystery Thing, Other Thing.');
  assert.deepEqual(testingNotes(new Set(['Business Rule', 'Business Rule'])).length, 1, 'no duplicates');
});

test('the deployment list always has a back-out line and adds lines for what the set holds', () => {
  const plain = deploymentNotes({});
  assert.ok(plain.some((l) => /^Backout:/.test(l)));
  assert.ok(plain.every((l) => !/blockers/.test(l)));
  const risky = deploymentNotes({ risks: [{ id: 'dictionary' }, { id: 'property' }, { id: 'acl' }], deletions: 2, verdict: 'blockers' });
  assert.match(risky[0], /blockers/);
  assert.ok(risky.some((l) => /schema changes outside business hours/.test(l)));
  assert.ok(risky.some((l) => /system property values/.test(l)));
  assert.ok(risky.some((l) => /non-admin test user/.test(l)));
  assert.ok(risky.some((l) => /2 records are deleted/.test(l)));
});

test('Markdown escapes what could break it and keeps the structure', () => {
  const entries = [entry(1, { target_name: 'a|b *bold* <script>' }), entry(2, { action: 'DELETE', target_name: 'Gone' })];
  const text = releaseNotesToMarkdown(buildReleaseModel({ set: SET, entries, descriptions: { e1: 'uses `ticks`' } }));
  assert.match(text, /^# Release notes: Fix duplicate assets/);
  assert.match(text, /## Business Rule \(2\)/);
  assert.match(text, /a\|b \\\*bold\\\* \\<script\\>/);
  assert.match(text, /\*\*Deleted\*\* Gone/);
  assert.match(text, /uses \\`ticks\\`/);
  assert.match(text, /## Testing notes[\s\S]*- \[ \]/);
  assert.match(text, /## Deployment and backout/);
  assert.equal(/\n{3,}/.test(text), false);
  const bare = releaseNotesToMarkdown(buildReleaseModel({ set: SET, entries }), { testing: false, deployment: false });
  assert.equal(/Testing notes|Deployment/.test(bare), false, 'sections can be left out');
});

test('plain text has no markup characters from the formatter', () => {
  const entries = [entry(1, { target_name: 'Rule *one*' }), entry(2, { action: 'DELETE', target_name: 'Gone' })];
  const text = releaseNotesToText(buildReleaseModel({ set: SET, entries, created: { e1: true }, host: 'dev.service-now.com' }));
  assert.match(text, /^RELEASE NOTES: Fix duplicate assets/);
  assert.match(text, /BUSINESS RULE \(2\)/);
  assert.match(text, /- NEW: Rule \*one\*/, 'the text is the record name as is');
  assert.match(text, /- DELETED: Gone/);
  assert.equal(/^#|\*\*|\[ \]/m.test(text), false);
  assert.match(text, /DEPLOYMENT AND BACKOUT/);
});

test('a capped list says how many entries are missing, and an empty set still renders', () => {
  const model = buildReleaseModel({ set: SET, entries: [entry(1)], total: 40 });
  assert.equal(model.counts.total, 40);
  assert.equal(model.truncated, 39);
  assert.match(releaseNotesToMarkdown(model), /39 more changes not listed/);
  assert.match(releaseNotesToText(model), /39 more changes not listed/);
  const empty = buildReleaseModel({ set: { name: 'Empty' }, entries: [] });
  assert.equal(empty.groups.length, 0);
  assert.match(releaseNotesToText(empty), /0 changes/);
});
