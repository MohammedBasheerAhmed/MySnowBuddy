const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/lib/testData.js');

const NOW = new Date(Date.UTC(2026, 9, 20, 12, 0, 0));
const ID = (n) => String(n).padStart(32, 'a');

const field = (name, extra = {}) => ({ name, label: name, type: 'string', mandatory: false, readOnly: false, calculated: false, array: false, active: true, display: false, unique: false, maxLength: '40', ...extra });
const INCIDENT = [
  field('number', { readOnly: true }),
  field('short_description', { mandatory: true, maxLength: '160', display: false }),
  field('description', { type: 'string', maxLength: '4000' }),
  field('caller_id', { type: 'reference', reference: 'sys_user', mandatory: true }),
  field('impact', { type: 'integer', choiceType: '1' }),
  field('active', { type: 'boolean' }),
  field('opened_at', { type: 'glide_date_time' }),
  field('sys_created_on', { type: 'glide_date_time' }),
  field('work_notes', { type: 'journal_input' }),
  field('user_password', { type: 'password' }),
  field('calc', { calculated: true }),
];

test('the same seed gives the same numbers and a different seed does not', () => {
  const a = T.createRng('x');
  const b = T.createRng('x');
  const seq = (r) => Array.from({ length: 6 }, () => r.int(0, 1000));
  assert.deepEqual(seq(a), seq(b));
  assert.notDeepEqual(seq(T.createRng('x')), seq(T.createRng('y')));
  const r = T.createRng(7);
  for (let i = 0; i < 200; i += 1) assert.ok(r.int(3, 5) >= 3 && r.int(3, 5) <= 5);
  const w = T.createRng(1);
  const hits = { a: 0, b: 0 };
  for (let i = 0; i < 400; i += 1) hits[w.weighted([{ value: 'a', weight: 9 }, { value: 'b', weight: 1 }]).value] += 1;
  assert.ok(hits.a > hits.b * 4, 'weights are respected');
  assert.equal(w.weighted([{ value: 'only', weight: 0 }]).value, 'only', 'all-zero weights do not hang');
});

test('patterns fill in the row number, the person and random digits', () => {
  const ctx = { rng: T.createRng(3), n: 7, now: NOW, persona: { first: 'Ava', last: 'Archer', userName: 'ava.archer7', email: 'ava.archer7@example.com' }, batch: 'k3' };
  assert.equal(T.expandPattern('Test user {n}', ctx), 'Test user 7');
  assert.equal(T.expandPattern('{n:3}-{first}.{last}', ctx), '007-Ava.Archer');
  assert.equal(T.expandPattern('{email}', ctx), 'ava.archer7@example.com');
  assert.match(T.expandPattern('SN-{rand:8}', ctx), /^SN-\d{8}$/);
  assert.equal(T.expandPattern('on {date} in {batch}', ctx), 'on 2026-10-20 in k3');
  assert.equal(T.expandPattern('{unknown}', ctx), '{unknown}', 'unknown placeholders stay as typed');
  assert.equal(T.formatGlideDate(NOW), '2026-10-20 12:00:00');
  assert.equal(T.formatGlideDate(NOW, false), '2026-10-20');
});

test('system, read-only, calculated, journal and password columns are never generated', () => {
  const ok = INCIDENT.filter(T.isGeneratable).map((f) => f.name);
  assert.deepEqual(ok, ['short_description', 'description', 'caller_id', 'impact', 'active', 'opened_at']);
});

test('the incident template turns on the useful fields and always the mandatory ones', () => {
  const plan = T.defaultPlanFields({ table: 'incident', fields: INCIDENT, choices: { impact: [{ value: '1', label: '1 - High' }, { value: '2', label: '2 - Medium' }, { value: '3', label: '3 - Low', inactive: true }] }, refs: { caller_id: [{ sysId: ID(1) }, { sysId: ID(2) }] } });
  assert.ok(plan.include.includes('short_description') && plan.include.includes('caller_id') && plan.include.includes('impact'));
  assert.ok(!plan.include.includes('opened_at'), 'optional date fields start off');
  assert.equal(plan.specs.impact.kind, 'choice');
  assert.deepEqual(plan.specs.impact.options.map((o) => o.value), ['1', '2'], 'inactive choices are not offered');
  assert.equal(plan.specs.caller_id.kind, 'ref');
  assert.deepEqual(plan.specs.caller_id.ids, [ID(1), ID(2)]);
  assert.equal(plan.specs.short_description.style, 'incident');
  assert.ok(T.templateFor('cmdb_ci_linux_server'), 'CI classes share the CI template');
  assert.equal(T.templateFor('u_custom'), null);
});

test('rows: marker, mandatory fields, repeatable, and nothing is written for fields that are off', () => {
  const plan = T.defaultPlanFields({ table: 'incident', fields: INCIDENT, refs: { caller_id: [{ sysId: ID(1) }] } });
  const build = () => T.buildRows({ table: 'incident', fields: plan.fields, specs: plan.specs, include: plan.include, count: 5, seed: 'abc', now: NOW });
  const a = build();
  assert.equal(a.rows.length, 5);
  a.rows.forEach((row) => {
    assert.ok(row.short_description.startsWith(`${T.MARKER} `), row.short_description);
    assert.equal(row.caller_id, ID(1));
    assert.equal('opened_at' in row, false);
    assert.equal('number' in row, false);
    assert.equal('sys_created_on' in row, false);
  });
  assert.deepEqual(build().rows, a.rows, 'same seed, same rows');
  assert.notDeepEqual(T.buildRows({ table: 'incident', fields: plan.fields, specs: plan.specs, include: plan.include, count: 5, seed: 'other', now: NOW }).rows, a.rows);
  assert.equal(a.marker, 'short_description');
  assert.deepEqual(a.problems, []);
});

test('a mandatory reference with nothing to point at is reported, not silently left empty', () => {
  const plan = T.defaultPlanFields({ table: 'incident', fields: INCIDENT });
  const r = T.buildRows({ table: 'incident', fields: plan.fields, specs: plan.specs, include: plan.include, count: 2, seed: 1, now: NOW });
  assert.ok(r.problems.some((p) => /caller_id|mandatory/i.test(p)), r.problems.join('|'));
});

test('people agree with themselves: user name, email and names come from one person per row', () => {
  const users = [field('first_name'), field('last_name'), field('user_name', { unique: true }), field('email', { type: 'email' }), field('name', { calculated: true })];
  const plan = T.defaultPlanFields({ table: 'sys_user', fields: users });
  const { rows } = T.buildRows({ table: 'sys_user', fields: plan.fields, specs: plan.specs, include: plan.include, count: 3, seed: 5, now: NOW });
  rows.forEach((row) => {
    assert.equal(row.user_name, `${row.first_name}.${row.last_name}${rows.indexOf(row) + 1}`.toLowerCase());
    assert.equal(row.email, `${row.user_name}@example.com`);
  });
  assert.equal(new Set(rows.map((r) => r.user_name)).size, 3);
});

test('unique fields get a suffix instead of repeating, and long values are cut to the column size', () => {
  const fields = [field('name', { unique: true, mandatory: true, display: true, maxLength: '12' })];
  const specs = { name: { kind: 'fixed', value: 'same' } };
  const { rows } = T.buildRows({ table: 'u_thing', fields, specs, include: ['name'], count: 3, seed: 1, now: NOW });
  assert.equal(new Set(rows.map((r) => r.name)).size, 3);
  const long = T.buildRows({ table: 'u_thing', fields, specs: { name: { kind: 'fixed', value: 'x'.repeat(50) } }, include: ['name'], count: 1, seed: 1, now: NOW });
  assert.ok(long.rows[0].name.length <= 12);
});

test('a table with nothing to carry the marker says so', () => {
  const fields = [field('u_code', { mandatory: true })];
  const r = T.buildRows({ table: 'u_x', fields, specs: { u_code: { kind: 'fixed', value: 'a' } }, include: ['u_code'], count: 1, seed: 1, now: NOW });
  assert.equal(r.marker, null);
  assert.ok(r.notes.some((n) => /no .*marker/i.test(n)));
});

test('generators stay inside their ranges', () => {
  const ctx = { rng: T.createRng(11), n: 1, now: NOW, persona: { first: 'A', last: 'B', userName: 'a.b1', email: 'a.b1@example.com' } };
  for (let i = 0; i < 100; i += 1) {
    const int = Number(T.generateValue({ kind: 'int', min: 5, max: 9 }, ctx));
    assert.ok(int >= 5 && int <= 9);
    const dec = Number(T.generateValue({ kind: 'decimal', min: 1, max: 2, places: 3 }, ctx));
    assert.ok(dec >= 1 && dec <= 2);
    const date = new Date(`${T.generateValue({ kind: 'date', daysBack: 10 }, ctx).replace(' ', 'T')}Z`).getTime();
    assert.ok(date <= NOW.getTime() && date >= NOW.getTime() - 10 * 86400000);
  }
  assert.equal(T.generateValue({ kind: 'bool', chance: 1 }, ctx), 'true');
  assert.equal(T.generateValue({ kind: 'bool', chance: 0 }, ctx), 'false');
  assert.equal(T.generateValue({ kind: 'ref', mode: 'empty', ids: [ID(1)] }, ctx), '');
  assert.equal(T.generateValue({ kind: 'ref', mode: 'fixed', fixed: ID(9) }, ctx), ID(9));
  assert.equal(T.generateValue({ kind: 'empty' }, ctx), '');
});

test('the plan check: cap, table name, and only dev, test or stage instances', () => {
  const good = { table: 'incident', count: 10, env: 'dev', rows: [{ short_description: '[NB-test] x' }] };
  assert.equal(T.validatePlan(good).ok, true);
  assert.equal(T.validatePlan({ ...good, env: 'test' }).ok, true);
  assert.equal(T.validatePlan({ ...good, env: 'stage' }).ok, true);
  ['prod', 'unknown', undefined, ''].forEach((env) => {
    const r = T.validatePlan({ ...good, env });
    assert.equal(r.ok, false, String(env));
    assert.ok(r.problems.some((p) => /not recognised as dev, test or stage/.test(p)));
  });
  assert.equal(T.validatePlan({ ...good, count: 51 }).ok, false, 'hard cap of 50');
  assert.equal(T.validatePlan({ ...good, count: 50 }).ok, true);
  assert.equal(T.validatePlan({ ...good, count: 0 }).ok, false);
  assert.equal(T.validatePlan({ ...good, count: 2.5 }).ok, false);
  assert.equal(T.validatePlan({ ...good, table: 'bad table!' }).ok, false);
});

test('the agent write policy applies: credential tables and secret-looking fields are refused', () => {
  const credential = T.validatePlan({ table: 'oauth_credential', count: 1, env: 'dev', rows: [{ name: 'x' }] });
  assert.equal(credential.ok, false);
  const secret = T.validatePlan({ table: 'incident', count: 1, env: 'dev', rows: [{ api_key: 'x' }] });
  assert.equal(secret.ok, false);
  const users = T.validatePlan({ table: 'sys_user', count: 1, env: 'dev', rows: [{ user_name: 'x' }] });
  assert.equal(users.ok, true);
  assert.ok(users.warnings.some((w) => /user account/i.test(w)), 'creating users carries the policy warning');
});

test('the confirmation names the table, the count, the update set and what is not captured', () => {
  const ask = T.createAsk({ table: 'incident', count: 10, updateSet: 'Default [Global]', instance: 'dev364920.service-now.com', fieldCount: 7 });
  assert.match(ask.title, /Create 10 test incident records/);
  assert.match(ask.message, /dev364920/);
  assert.match(ask.message, /\[NB-test\]/);
  assert.match(ask.details, /Default \[Global\]/);
  assert.match(ask.details, /not captured in update sets/);
  assert.equal(ask.confirmLabel, 'Create 10');
  assert.match(T.createAsk({ table: 'incident', count: 1 }).title, /1 test incident record\?/);
  const clean = T.cleanupAsk({ table: 'sys_user', records: 3, deactivates: 3 });
  assert.match(clean.message, /never deletes users/);
  assert.equal(clean.danger, true);
});

test('the runner creates one record at a time, in order', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];
  const result = await T.runBatch({
    rows: [{ a: 1 }, { a: 2 }, { a: 3 }],
    sleep: async () => {},
    create: async (row, i) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      order.push(row.a);
      inFlight -= 1;
      return { sysId: ID(i + 1), display: `r${i}` };
    },
  });
  assert.equal(maxInFlight, 1, 'never in parallel');
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(result.created.length, 3);
  assert.equal(result.stopped, '');
});

test('the runner stops after two failures in a row, but one failure does not end the run', async () => {
  const flaky = await T.runBatch({ rows: [1, 2, 3, 4], sleep: async () => {}, create: async (_, i) => { if (i === 1) throw new Error('boom'); return { sysId: ID(i + 1) }; } });
  assert.equal(flaky.created.length, 3);
  assert.equal(flaky.failed.length, 1);
  const broken = await T.runBatch({ rows: [1, 2, 3, 4, 5], sleep: async () => {}, create: async () => { throw new Error('policy says no'); } });
  assert.equal(broken.failed.length, 2);
  assert.match(broken.stopped, /two failures in a row: policy says no/);
  const noId = await T.runBatch({ rows: [1], sleep: async () => {}, create: async () => ({ sysId: 'nope' }) });
  assert.equal(noId.created.length, 0, 'an answer without a real sys_id is a failure');
});

test('the runner can be stopped between records', async () => {
  let n = 0;
  const result = await T.runBatch({ rows: [1, 2, 3, 4], sleep: async () => {}, shouldStop: () => n >= 2, create: async (_, i) => { n += 1; return { sysId: ID(i + 1) }; } });
  assert.equal(result.created.length, 2);
  assert.match(result.stopped, /Stopped by you/);
});

test('the journal remembers batches, survives a second add, and drops emptied batches', () => {
  let journal = T.addRecords([], { batchId: 'b1', table: 'incident', instance: 'dev1.service-now.com', at: 1000, seed: 's', records: [{ sysId: ID(1), display: 'INC1' }, { sysId: ID(2) }, { sysId: 'bad' }] });
  assert.equal(journal[0].records.length, 2, 'only real sys_ids are kept');
  journal = T.addRecords(journal, { batchId: 'b1', table: 'incident', instance: 'dev1.service-now.com', records: [{ sysId: ID(2) }, { sysId: ID(3) }] });
  assert.deepEqual(journal[0].records.map((r) => r.sysId), [ID(1), ID(2), ID(3)], 'no duplicates, appended');
  journal = T.addRecords(journal, { batchId: 'b2', table: 'sys_user', instance: 'other.service-now.com', at: 2000, records: [{ sysId: ID(9) }] });
  assert.deepEqual(T.batchesFor(journal, 'dev1.service-now.com').map((b) => b.id), ['b1'], 'a batch belongs to its instance');
  const after = T.removeRecords(journal, 'b1', [ID(1), ID(2)]);
  assert.deepEqual(after.find((b) => b.id === 'b1').records.map((r) => r.sysId), [ID(3)]);
  assert.equal(T.removeRecords(after, 'b1', [ID(3)]).some((b) => b.id === 'b1'), false);
  const many = Array.from({ length: 60 }, (_, i) => ({ batchId: `x${i}`, table: 't', instance: 'i', records: [{ sysId: ID(i + 1) }] })).reduce((j, e) => T.addRecords(j, e), []);
  assert.equal(many.length, T.JOURNAL_CAP);
  assert.match(T.newBatchId(1700000000000, () => 0.5), /^[a-z0-9]+$/);
});

test('cleanup deletes what exists, skips what is gone, reports failures, and deactivates users', async () => {
  const removed = [];
  const report = await T.runCleanup({
    table: 'incident',
    records: [{ sysId: ID(1) }, { sysId: ID(2) }, { sysId: ID(3) }],
    sleep: async () => {},
    exists: async (_table, ids) => new Set(ids.filter((id) => id !== ID(2))),
    remove: async (r) => {
      if (r.sysId === ID(3)) throw new Error('ACL says no');
      removed.push(r.sysId);
      return 'deleted';
    },
  });
  assert.deepEqual(removed, [ID(1)]);
  assert.deepEqual(report.alreadyGone, [ID(2)]);
  assert.deepEqual(report.failed, [{ sysId: ID(3), error: 'ACL says no' }]);
  assert.deepEqual(T.settledIds(report).sort(), [ID(1), ID(2)].sort(), 'failures stay in the journal for another try');
  assert.equal(T.cleanupSummary(report), 'Cleanup: 1 deleted, 1 already gone, 1 failed.');
  assert.equal(T.cleanupMode('sys_user'), 'deactivate');
  assert.equal(T.cleanupMode('incident'), 'delete');
  const users = await T.runCleanup({ table: 'sys_user', records: [{ sysId: ID(5) }], sleep: async () => {}, exists: async (_t, ids) => new Set(ids), remove: async () => 'deactivated' });
  assert.deepEqual(users.deactivated, [ID(5)]);
  assert.equal(T.cleanupSummary(users), 'Cleanup: 1 deactivated.');
  assert.equal(T.cleanupSummary({ removed: [], deactivated: [], alreadyGone: [], failed: [] }), 'Nothing to clean up.');
});
