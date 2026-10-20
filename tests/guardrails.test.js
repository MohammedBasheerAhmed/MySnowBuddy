// Agent write guardrails (src/lib/agent/guardrails.js, policy.js, controlTools.js, agentTools.js): security tables,
// denied tables, live-change notes, the update set on the card, stale proposals and read-only-for-non-admins.
// The first half tests the pure rules; the second half runs the real executor against a small in-memory instance.
const test = require('node:test');
const assert = require('node:assert/strict');

const g = require('../src/lib/agent/guardrails.js');
const policy = require('../src/lib/agent/policy.js');
const { runAgent } = require('../src/lib/agent/agentLoop.js');
const { createAudit } = require('../src/lib/agent/audit.js');
const { createAgentTools } = require('../src/content/agentTools.js');

const SYS = 'a'.repeat(32);
const SCRIPT_ID = 'd'.repeat(32);
const NEW = 'c'.repeat(32);

// ---- pure rules ---------------------------------------------------------------------------------------

test('ACL and role tables are refused by default, for everyone', () => {
  ['sys_security_acl', 'sys_security_acl_role', 'sys_user_role', 'sys_user_has_role', 'sys_user_role_contains', 'sys_group_has_role', 'sys_security_acl_child'].forEach((table) => {
    assert.equal(g.isSecurityTable(table), true, table);
    ['create', 'update', 'delete'].forEach((op) => {
      const verdict = policy.assessWrite({ op, table, fields: {} });
      assert.ok(verdict.block, `${op} ${table} is refused with the default settings`);
    });
  });
  ['incident', 'sys_user', 'sys_user_grmember', 'sys_properties'].forEach((table) => assert.equal(g.isSecurityTable(table), false, table));
});

test('they are allowed only with the setting on AND an elevated security_admin session', () => {
  const guard = g.resolveGuardrails({ allowSecurityTableWrites: true });
  assert.equal(g.securityTableBlock('sys_security_acl', guard, { securityAdmin: true }), null);
  assert.equal(g.securityTableBlock('sys_security_acl', guard, { securityAdmin: false }), 'Elevate to security_admin to edit ACL or role records.');
  // The setting off is a refusal even for an elevated user, with the reason named.
  assert.match(g.securityTableBlock('sys_user_role', g.resolveGuardrails({}), { securityAdmin: true }), /protected.*Options > Agent/);
  // Not elevated always gets the exact sentence, whatever the setting says.
  assert.equal(g.securityTableBlock('sys_user_role', g.resolveGuardrails({}), { securityAdmin: false }), g.SECURITY_ELEVATION_MESSAGE);
  // Unknown session (the early check before the card): only the setting decides; the executor reads the roles.
  assert.equal(g.securityTableBlock('sys_user_role', guard, {}), null);
  assert.match(g.securityTableBlock('sys_user_role', g.resolveGuardrails({}), {}), /protected/);
  assert.equal(g.securityTableBlock('incident', g.resolveGuardrails({}), { securityAdmin: false }), null, 'other tables are not affected');
});

test('the policy applies it over the table chain and keeps the privilege warning when allowed', () => {
  const allowed = { guard: g.resolveGuardrails({ allowSecurityTableWrites: true }), session: { securityAdmin: true } };
  const refused = policy.assessWriteChain({ op: 'create', tables: ['sys_user_has_role', 'sys_metadata'], fields: { role: 'x' } });
  assert.match(refused.block, /protected|Elevate/);
  const ok = policy.assessWriteChain({ op: 'create', tables: ['sys_user_has_role'], fields: { role: 'x' }, ...allowed });
  assert.equal(ok.block, null);
  assert.ok(ok.warnings.some((w) => /privilege/.test(w)));
  assert.equal(policy.approvalMode({ tool: 'create_record', args: { table: 'sys_user_role', fields: {} } }), 'deny');
  assert.equal(policy.approvalMode({ tool: 'create_record', args: { table: 'sys_user_role', fields: {} }, guard: allowed.guard }), 'ask', 'allowed in settings: it goes on to an approval card');
  assert.match(policy.denyMessage('create_record', { table: 'sys_user_role', fields: {} }, { guard: g.resolveGuardrails({}) }), /^Not allowed: ACL and role tables are protected/);
});

test('denied tables: comma list, lower-cased, wildcards, bad patterns dropped', () => {
  assert.deepEqual(g.normalizeDeniedTables(' U_Vault_* , x_acme_*;incident  bad-name  *  u_vault_*'), ['u_vault_*', 'x_acme_*', 'incident']);
  assert.deepEqual(g.normalizeDeniedTables(['a_*', '', 'B*']), ['a_*', 'b*']);
  assert.deepEqual(g.normalizeDeniedTables(''), []);
  assert.deepEqual(g.normalizeDeniedTables(null), []);
  const list = ['u_vault_*', 'x_acme_*', 'exact_table'];
  assert.equal(g.matchDeniedTable('u_vault_notes', list), 'u_vault_*');
  assert.equal(g.matchDeniedTable('X_ACME_THING', list), 'x_acme_*');
  assert.equal(g.matchDeniedTable('exact_table', list), 'exact_table');
  assert.equal(g.matchDeniedTable('exact_table_2', list), '', 'no wildcard means an exact name');
  assert.equal(g.matchDeniedTable('my_u_vault_x', list), '', 'a pattern matches the whole name, not a part');
  assert.equal(g.matchDeniedTable('', list), '');
  assert.match(g.deniedTableBlock('x_acme_orders', { deniedTables: list }), /x_acme_orders is on your denied-tables list \(x_acme_\*\)/);
  assert.equal(g.deniedTableBlock('incident', { deniedTables: list }), null);
  // It joins the policy: a write to a denied table is refused, and the hard-coded credential tables stay refused.
  assert.match(policy.assessWrite({ op: 'update', table: 'u_vault_notes', fields: { a: 1 }, guard: { deniedTables: list } }).block, /denied-tables/);
  assert.match(policy.assessWrite({ op: 'update', table: 'oauth_credential', fields: {}, guard: { deniedTables: [] } }).block, /credentials/);
  assert.match(policy.writeBlockReason('save_artifact', { table: 'x_acme_rule' }, { guard: { deniedTables: list } }), /denied-tables/);
  assert.equal(policy.writeBlockReason('save_artifact', { table: 'sys_script' }, { guard: { deniedTables: list } }), null);
});

test('settings resolve to the safe defaults', () => {
  assert.deepEqual(g.resolveGuardrails(), { allowSecurityTableWrites: false, deniedTables: [], refuseActiveScriptEdits: false, readOnlyForNonAdmin: false });
  assert.deepEqual(g.resolveGuardrails({ allowSecurityTableWrites: 'yes', refuseActiveScriptEdits: 1, agentReadOnlyForNonAdmin: 'true' }), { allowSecurityTableWrites: false, deniedTables: [], refuseActiveScriptEdits: false, readOnlyForNonAdmin: false }, 'only a real true turns a switch on');
  assert.deepEqual(g.resolveGuardrails({ allowSecurityTableWrites: true, deniedTables: 'a_*', refuseActiveScriptEdits: true, agentReadOnlyForNonAdmin: true }), { allowSecurityTableWrites: true, deniedTables: ['a_*'], refuseActiveScriptEdits: true, readOnlyForNonAdmin: true });
});

test('active and inactive records say what an edit does; active edits can be refused', () => {
  assert.equal(g.liveChangeNote('true'), 'Live change: this script is active. It takes effect as soon as you approve.');
  assert.equal(g.liveChangeNote(true), g.LIVE_ACTIVE_NOTE);
  assert.equal(g.liveChangeNote('false'), 'This record is inactive, so it will not run until someone activates it.');
  assert.equal(g.liveChangeNote(false), g.LIVE_INACTIVE_NOTE);
  assert.equal(g.liveChangeNote(undefined), null, 'no active flag, no note');
  assert.equal(g.liveChangeNote(''), null);
  const on = g.resolveGuardrails({ refuseActiveScriptEdits: true });
  assert.match(g.activeEditBlock({ guard: on, active: 'true' }), /active, so an edit goes live immediately/);
  assert.equal(g.activeEditBlock({ guard: on, active: 'false' }), null);
  assert.equal(g.activeEditBlock({ guard: on, active: 'true', isConfig: false }), null, 'data records are not code');
  assert.equal(g.activeEditBlock({ guard: g.resolveGuardrails({}), active: 'true' }), null, 'off by default');
});

test('the card names the update set and calls out Default', () => {
  assert.deepEqual(g.updateSetCard({ name: 'STRY0001 login fix' }), { notes: ['Captured in the update set "STRY0001 login fix".'], warnings: [] });
  const def = g.updateSetCard({ name: 'Default [Global]' });
  assert.deepEqual(def.notes, ['Captured in the update set "Default [Global]".']);
  assert.match(def.warnings[0], /Default update set: changes there are easy to lose or ship by accident/);
  assert.match(g.updateSetCard(null).notes[0], /could not be read/);
  assert.equal(g.updateSetCard({ name: 'Default' }).warnings.length, 1);
  assert.equal(g.updateSetCard({ name: 'Defaults for the portal' }).warnings.length, 0, 'only the real Default sets');
});

test('a proposal is stale when sys_updated_on or sys_mod_count moved', () => {
  const pins = g.createStalePins();
  const seen = { updatedOn: '2026-10-20 10:00:00', modCount: '4' };
  pins.set(SYS, seen);
  assert.equal(pins.check(SYS, { updatedOn: '2026-10-20 10:00:00', modCount: '4' }), null, 'unchanged');
  assert.equal(pins.has(SYS), false, 'a pin is used once');
  pins.set(SYS, seen);
  assert.equal(pins.check(SYS, { updatedOn: '2026-10-20 10:05:00', modCount: '4' }), g.STALE_MESSAGE, 'a newer update time');
  pins.set(SYS, seen);
  assert.equal(pins.check(SYS, { updatedOn: '2026-10-20 10:00:00', modCount: '5' }), g.STALE_MESSAGE, 'a newer mod count');
  pins.set(SYS, seen);
  assert.equal(pins.check(SYS, null), g.STALE_MESSAGE, 'the record is gone or unreadable');
  assert.equal(pins.check('f'.repeat(32), { updatedOn: 'x', modCount: '9' }), null, 'no pin, nothing to compare with');
  pins.set(SYS, { updatedOn: '', modCount: '' });
  assert.equal(pins.check(SYS, { updatedOn: 'x', modCount: '1' }), null, 'a card built on nothing cannot go stale');
  assert.equal(g.STALE_MESSAGE, 'The record changed after this proposal was made. Ask again.');
  const small = g.createStalePins(2);
  ['1', '2', '3'].forEach((k) => small.set(k, seen));
  assert.equal(small.size(), 2, 'memory is bounded');
  assert.equal(small.has('1'), false);
});

test('read-only for non-admins: the switch, who counts, and which tools', () => {
  const on = g.resolveGuardrails({ agentReadOnlyForNonAdmin: true });
  assert.equal(g.nonAdminBlock('update_record', on, { admin: false }), 'Updating records is turned off for your role.');
  assert.equal(g.nonAdminBlock('save_artifact', on, { admin: false }), g.NON_ADMIN_READONLY_MESSAGE);
  assert.equal(g.nonAdminBlock('update_record', on, { admin: true }), null, 'admins are not affected');
  assert.equal(g.nonAdminBlock('update_record', on, {}), null, 'unknown: the executor, which reads the roles, decides');
  assert.equal(g.nonAdminBlock('update_record', g.resolveGuardrails({}), { admin: false }), null, 'off by default');
  assert.equal(g.nonAdminBlock('query_table', on, { admin: false }), null, 'reading is always fine');
  assert.equal(g.nonAdminBlock('switch_update_set', on, { admin: false }), null, 'switching sessions is not updating records');
  assert.equal(g.nonAdminBlock('dry_run_script', on, { admin: false }), null);
  ['set_form_field', 'save_form', 'save_artifact', 'undo_last_write', 'click_ui_action', 'run_ui_steps', 'create_record', 'update_record', 'delete_record', 'run_background_script'].forEach((tool) => assert.ok(g.RECORD_CHANGING_TOOLS.has(tool), tool));
  assert.equal(policy.approvalMode({ tool: 'create_record', args: { table: 'incident', fields: {} }, guard: on, session: { admin: false } }), 'deny');
  assert.equal(policy.approvalMode({ tool: 'create_record', args: { table: 'incident', fields: {} }, guard: on }), 'ask');
  assert.match(policy.denyMessage('delete_record', { table: 'incident' }, { guard: on, session: { admin: false } }), /Updating records is turned off for your role/);
});

test('the agent loop reports the real reason when a call is denied by a setting', async () => {
  const guard = g.resolveGuardrails({ deniedTables: 'x_acme_*' });
  const call = (args) => ({ id: 't1', name: 'create_record', args });
  const ask = async (args) => {
    let n = 0;
    const run = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      callModel: async () => (n++ === 0 ? { content: '', toolCalls: [call(args)], stopReason: 'tool_use' } : { content: 'done', toolCalls: [], stopReason: 'end_turn' }),
      executeTool: async () => assert.fail('must not run'),
      approvalMode: (name, a) => policy.approvalMode({ tool: name, args: a, guard }),
      requestApproval: async () => assert.fail('must not ask'),
      guard,
    });
    return run.messages.find((m) => m.role === 'tool').content;
  };
  assert.match(await ask({ table: 'x_acme_orders', fields: {} }), /^Not allowed: x_acme_orders is on your denied-tables list/);
  assert.match(await ask({ table: 'sys_user_role', fields: {} }), /^Not allowed: ACL and role tables are protected/);
});

// ---- the executor, against a small in-memory instance -------------------------------------------------

function memoryAudit() {
  let store = [];
  return createAudit({ get: async () => store, set: async (_k, v) => void (store = v) });
}

/** One instance with an incident, a business rule and a dictionary entry; every call the executor makes is recorded. */
function harness({ settings = {}, session = { admin: true, securityAdmin: false }, updateSet = { sysId: '1'.repeat(32), name: 'Default' } } = {}) {
  const db = {
    incident: [{ sys_id: SYS, number: 'INC1', short_description: 'Printer', state: '1', active: 'true', sys_class_name: 'incident', sys_mod_count: '1', sys_updated_on: '2026-10-20 10:00:00' }],
    sys_script: [{ sys_id: SCRIPT_ID, name: 'Rule', collection: 'incident', when: 'before', active: 'true', script: 'old', sys_class_name: 'sys_script', sys_mod_count: '3', sys_updated_on: '2026-10-19 09:00:00' }],
    sys_dictionary: [{ sys_id: 'e'.repeat(32), name: 'incident', element: 'u_x', label: 'X', active: 'true', sys_class_name: 'sys_dictionary', sys_mod_count: '1', sys_updated_on: '2026-10-18 09:00:00' }],
  };
  const state = { settings, session: session && { ...session }, updateSet, writes: [] };
  const match = (row, query) =>
    String(query || '')
      .split('^')
      .filter((c) => c && !c.startsWith('ORDERBY'))
      .every((c) => {
        const [k, v] = c.split('=');
        return String(row[k]) === v;
      });
  const queryTable = async (table, query, fields = [], { displayValue } = {}) => {
    const rows = (db[table] || []).filter((r) => match(r, query));
    return rows.map((r) => {
      const picked = fields.length ? Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]])) : { ...r };
      return displayValue ? Object.fromEntries(Object.entries(picked).map(([k, v]) => [k, { value: v, display_value: v }])) : picked;
    });
  };
  const fieldsOf = {
    incident: ['number', 'short_description', 'state', 'active'],
    sys_script: ['name', 'collection', 'when', 'active', 'condition', 'script'],
    sys_dictionary: ['name', 'element', 'label', 'active'],
    sys_user_role: ['name', 'description'],
    sys_user_has_role: ['user', 'role'],
  };
  const ctl = {
    page: { currentPath: () => '/navpage.do' },
    shellUrl: (p) => p,
    tableExists: async (t) => t in db,
    session: {
      readSessionInfo: async () => state.session,
      readCurrentUpdateSet: async () => state.updateSet,
      readCurrentUser: async () => ({ sysId: 'e'.repeat(32), userName: 'me' }),
    },
    atf: {},
    insights: {},
  };
  const tools = createAgentTools({
    getContext: () => ({ table: 'incident', sysId: SYS }),
    getInstanceInfo: () => ({ host: 'dev1.service-now.com', instance: 'dev1', env: 'dev' }),
    callPage: async (action) => (action === 'getSessionInfo' ? state.session : null),
    queryTable,
    fetchRecord: async (t, id, fields = []) => (await queryTable(t, `sys_id=${id}`, fields))[0] || null,
    countRecords: async () => 0,
    createRecord: async (t, f) => {
      state.writes.push(['create', t, f]);
      const row = { sys_id: NEW, ...f };
      (db[t] = db[t] || []).push(row);
      return row;
    },
    updateRecord: async (t, id, f) => {
      state.writes.push(['update', t, id, f]);
      const row = db[t].find((r) => r.sys_id === id);
      Object.assign(row, f);
      return { ...row };
    },
    deleteRecord: async (t, id) => {
      state.writes.push(['delete', t, id]);
      db[t] = db[t].filter((r) => r.sys_id !== id);
      return null;
    },
    fetchTableFields: async (t) => ({ tables: [t], fields: (fieldsOf[t] || []).map((name) => ({ name, label: name, type: 'string' })) }),
    tableHierarchy: async (t) => ({ sys_script: ['sys_script', 'sys_metadata'], sys_dictionary: ['sys_dictionary', 'sys_metadata'], incident: ['incident', 'task'] })[t] || [t],
    getCurrentUpdateSet: async () => state.updateSet,
    getSettings: async () => state.settings,
    runSandbox: async () => ({ ok: true, error: null }),
    recordUrl: (t, id) => `/${t}.do?sys_id=${id}`,
    audit: memoryAudit(),
    control: ctl,
  });
  return { tools, db, state, ctl };
}

test('executor: ACL and role tables are refused unless allowed AND elevated, read from the live session', async () => {
  const create = (h) => h.tools.execute('create_record', { table: 'sys_user_role', fields: { name: 'x' }, reason: 'r' });
  let h = harness();
  await assert.rejects(create(h), /^Error: Elevate to security_admin to edit ACL or role records\.$/, 'default settings, not elevated');
  h = harness({ settings: { allowSecurityTableWrites: true } });
  await assert.rejects(create(h), /^Error: Elevate to security_admin to edit ACL or role records\.$/, 'allowed in settings but not elevated');
  h = harness({ session: { admin: true, securityAdmin: true } });
  await assert.rejects(create(h), /ACL and role tables are protected/, 'elevated but the setting is off');
  assert.deepEqual(h.state.writes, [], 'nothing reached the instance');
  h = harness({ settings: { allowSecurityTableWrites: true }, session: { admin: true, securityAdmin: true } });
  const ok = await create(h);
  assert.equal(ok.created, true, 'allowed and elevated: it goes ahead');
  assert.equal(h.state.writes.length, 1);
  // The card says the same before anyone is asked.
  h = harness();
  assert.match((await h.tools.preview('create_record', { table: 'sys_user_has_role', fields: { role: 'x' } })).blocked, /Elevate to security_admin/);
  // Updating and deleting go through the same check, by the record's real class.
  h = harness();
  await assert.rejects(h.tools.execute('delete_record', { table: 'sys_user_role', sysId: SYS, reason: 'r' }), /Elevate to security_admin/);
});

test('executor: denied tables cannot be read or written by the agent', async () => {
  const settings = { deniedTables: 'incident, u_vault_*' };
  const h = harness({ settings });
  await assert.rejects(h.tools.execute('query_table', { table: 'incident', fields: ['number'] }), /denied-tables list/);
  await assert.rejects(h.tools.execute('count_records', { table: 'u_vault_notes' }), /denied-tables list/);
  await assert.rejects(h.tools.execute('create_record', { table: 'incident', fields: { short_description: 'x' }, reason: 'r' }), /denied-tables list/);
  const clean = harness({ settings: { deniedTables: 'sys_script' } });
  await assert.rejects(clean.tools.execute('save_artifact', { table: 'sys_script', sysId: SCRIPT_ID, fields: { name: 'n' }, reason: 'r' }), /denied-tables list/);
  assert.match((await clean.tools.preview('save_artifact', { table: 'sys_script', sysId: SCRIPT_ID, fields: { name: 'n' }, reason: 'r' })).blocked, /denied-tables list/);
  // Without the setting the same reads work.
  const open = harness();
  assert.ok(await open.tools.execute('count_records', { table: 'incident' }).then(() => true));
  assert.deepEqual(h.state.writes, []);
});

test('executor: edits of active config say they go live, inactive ones say they will not run, and can be refused', async () => {
  const args = { table: 'sys_dictionary', sysId: 'e'.repeat(32), fields: { label: 'Y' }, reason: 'r' };
  let h = harness();
  const live = await h.tools.preview('update_record', args);
  assert.ok(live.warnings.includes('Live change: this script is active. It takes effect as soon as you approve.'));
  assert.equal(live.blocked, undefined);
  h.db.sys_dictionary[0].active = 'false';
  const idle = await h.tools.preview('update_record', args);
  assert.ok(idle.notes.includes('This record is inactive, so it will not run until someone activates it.'));
  assert.ok(!idle.warnings.some((w) => /Live change/.test(w)));
  // A data record has no live-change wording: it is not code.
  const data = await h.tools.preview('update_record', { table: 'incident', sysId: SYS, fields: { state: '2' }, reason: 'r' });
  assert.ok(!data.warnings.some((w) => /Live change/.test(w)) && !(data.notes || []).some((n) => /inactive/.test(n)));

  // Refusing edits of active code, at the card and at the write.
  h = harness({ settings: { refuseActiveScriptEdits: true } });
  assert.match((await h.tools.preview('update_record', args)).blocked, /active, so an edit goes live immediately/);
  await assert.rejects(h.tools.execute('update_record', args), /Editing active code is turned off/);
  assert.deepEqual(h.state.writes, []);
  h.db.sys_dictionary[0].active = 'false';
  assert.equal((await h.tools.execute('update_record', args)).updated, true, 'an inactive record may be edited');
  // save_artifact too.
  h = harness({ settings: { refuseActiveScriptEdits: true } });
  const art = { table: 'sys_script', sysId: SCRIPT_ID, fields: { name: 'Renamed' }, reason: 'r' };
  assert.match((await h.tools.preview('save_artifact', art)).blocked, /active, so an edit goes live/);
  await assert.rejects(h.tools.execute('save_artifact', art), /Editing active code is turned off/);
  h = harness();
  assert.ok((await h.tools.preview('save_artifact', art)).warnings.includes(g.LIVE_ACTIVE_NOTE));
  assert.equal((await h.tools.execute('save_artifact', art)).saved, true, 'off by default');
});

test('executor: configuration cards name the update set and flag Default', async () => {
  const args = { table: 'sys_dictionary', sysId: 'e'.repeat(32), fields: { label: 'Y' }, reason: 'r' };
  let h = harness();
  let card = await h.tools.preview('update_record', args);
  assert.ok(card.notes.includes('Captured in the update set "Default".'));
  assert.ok(card.warnings.some((w) => /Default update set/.test(w)));
  h = harness({ updateSet: { sysId: '2'.repeat(32), name: 'STRY0042 dictionary fix' } });
  card = await h.tools.preview('update_record', args);
  assert.ok(card.notes.includes('Captured in the update set "STRY0042 dictionary fix".'));
  assert.ok(!card.warnings.some((w) => /Default update set/.test(w)));
  const create = await h.tools.preview('create_record', { table: 'sys_dictionary', fields: { name: 'incident', element: 'u_y', label: 'Y' } });
  assert.ok(create.notes.includes('Captured in the update set "STRY0042 dictionary fix".'));
  const artifact = await h.tools.preview('save_artifact', { table: 'sys_script', fields: { name: 'New rule' }, reason: 'r' });
  assert.ok(artifact.notes.includes('Captured in the update set "STRY0042 dictionary fix".'));
  // Plain data records are not captured in update sets, so the card does not claim they are.
  const data = await h.tools.preview('update_record', { table: 'incident', sysId: SYS, fields: { state: '2' }, reason: 'r' });
  assert.ok(!(data.notes || []).some((n) => /update set/.test(n)));
});

test('executor: a record that changed after the card was made is refused', async () => {
  const update = { table: 'incident', sysId: SYS, fields: { state: '2' }, reason: 'r' };
  let h = harness();
  await h.tools.preview('update_record', update);
  h.db.incident[0].sys_mod_count = '2'; // somebody saved it meanwhile
  await assert.rejects(h.tools.execute('update_record', update), /^Error: The record changed after this proposal was made\. Ask again\.$/);
  assert.deepEqual(h.state.writes, []);
  // Asking again builds a new card on the new state, and that one goes through.
  await h.tools.preview('update_record', update);
  assert.equal((await h.tools.execute('update_record', update)).updated, true);
  assert.equal(h.state.writes.length, 1);

  h = harness();
  await h.tools.preview('update_record', update);
  h.db.incident[0].sys_updated_on = '2026-10-20 11:00:00';
  await assert.rejects(h.tools.execute('update_record', update), /changed after this proposal/);
  // No card was built (a call that never needed approval): nothing to compare with, the write goes ahead.
  h = harness();
  assert.equal((await h.tools.execute('update_record', update)).updated, true);

  // Deleting and save_artifact are checked the same way.
  h = harness();
  await h.tools.preview('delete_record', { table: 'incident', sysId: SYS, reason: 'r' });
  h.db.incident[0].sys_mod_count = '9';
  await assert.rejects(h.tools.execute('delete_record', { table: 'incident', sysId: SYS, reason: 'r' }), /changed after this proposal/);
  assert.equal(h.db.incident.length, 1, 'not deleted');
  h = harness();
  const art = { table: 'sys_script', sysId: SCRIPT_ID, fields: { name: 'Renamed' }, reason: 'r' };
  await h.tools.preview('save_artifact', art);
  h.db.sys_script[0].sys_mod_count = '4';
  await assert.rejects(h.tools.execute('save_artifact', art), /changed after this proposal/);
  await h.tools.preview('save_artifact', art);
  assert.equal((await h.tools.execute('save_artifact', art)).saved, true);
});

test('executor: read-only for non-admins stops every record-changing tool, and fails closed when the roles are unknown', async () => {
  const settings = { agentReadOnlyForNonAdmin: true };
  const update = { table: 'incident', sysId: SYS, fields: { state: '2' }, reason: 'r' };
  let h = harness({ settings, session: { admin: false, securityAdmin: false } });
  await assert.rejects(h.tools.execute('update_record', update), /^Error: Updating records is turned off for your role\.$/);
  await assert.rejects(h.tools.execute('create_record', { table: 'incident', fields: { short_description: 'x' }, reason: 'r' }), /turned off for your role/);
  await assert.rejects(h.tools.execute('save_artifact', { table: 'sys_script', fields: { name: 'n' }, reason: 'r' }), /turned off for your role/);
  assert.equal((await h.tools.preview('update_record', update)).blocked, 'Updating records is turned off for your role.');
  assert.ok(await h.tools.execute('count_records', { table: 'incident' }).then(() => true), 'reading still works');
  assert.deepEqual(h.state.writes, []);
  // The user's own /undo is a write too.
  await assert.rejects(h.tools.undoWithApproval(async () => assert.fail('no card')), /turned off for your role/);
  // Admins are not affected.
  h = harness({ settings, session: { admin: true, securityAdmin: false } });
  assert.equal((await h.tools.execute('update_record', update)).updated, true);
  // Roles that cannot be read: refused, because a restriction the user turned on never fails open.
  h = harness({ settings, session: null });
  await assert.rejects(h.tools.execute('update_record', update), /turned off for your role/);
  // Off by default: a non-admin can use the agent as before.
  h = harness({ session: { admin: false, securityAdmin: false } });
  assert.equal((await h.tools.execute('update_record', update)).updated, true);
});
