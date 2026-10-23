// The hooks that connect the tools to each other (src/lib/panelLinks.js and the small changes around it): failures to
// the tool that explains them, property names in the script editor, the page-aware suggestions and the ticket toolbar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../src/lib/panelLinks.js');
const F = require('../src/lib/failures.js');
const { isTicketTable, TICKET_TABLES } = require('../src/lib/ticketTables.js');
const { pageKind, suggestedIds, suggestFor, pageSuggestions, SUGGESTED, SUGGESTED_TITLES } = require('../src/lib/paletteContext.js');
const { PAGE_NOUN, JOB_FOR_PAGE, GUIDE_JOBS } = require('../src/lib/guideContent.js');
const { toolbarModel } = require('../src/lib/inline.js');
const { canSee, visibleTo, requiredTier } = require('../src/lib/roleTier.js');
const { isPortalUrl } = require('../src/lib/xray.js');
const { getHoverInfo, getDefinitionTarget } = require('../src/lib/completion.js');
const { toProperty } = require('../src/lib/properties.js');

const src = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const ID = '0123456789abcdef0123456789abcdef';
const ID2 = 'fedcba9876543210fedcba9876543210';

// ---- Opening a panel on a record ---------------------------------------------------------------------------------

test('a record is a table name and a sys_id and nothing else', () => {
  assert.deepEqual(L.recordRef('incident', ID), { table: 'incident', sysId: ID });
  assert.deepEqual(L.recordRef(' incident ', ID.toUpperCase()), { table: 'incident', sysId: ID }, 'trimmed, and the sys_id lower-cased');
  assert.equal(L.recordRef('incident', 'abc'), null);
  assert.equal(L.recordRef('', ID), null);
  assert.equal(L.recordRef('Incident Table', ID), null, 'a label is not a table name');
  assert.equal(L.recordRef('incident^active=true', ID), null);
  assert.equal(L.recordRef(null, undefined), null);
});

test('the context of a pinned record has what a panel reads and nothing from the page', () => {
  assert.deepEqual(L.recordContext({ table: 'sys_email', sysId: ID }), {
    table: 'sys_email',
    sysId: ID,
    isList: false,
    isPortal: false,
    selection: '',
    scriptBody: null,
    scriptFieldLabel: null,
  });
  assert.equal(L.recordContext({ table: 'sys_email', sysId: 'nope' }), null);
  assert.equal(L.recordContext(null), null);
});

test('opening a panel splits off the record to open it on; a bad record is dropped, not half-used', () => {
  assert.deepEqual(L.splitOpenParams({ args: 'x', context: { table: 'incident', sysId: ID } }), {
    context: L.recordContext({ table: 'incident', sysId: ID }),
    params: { args: 'x' },
  });
  assert.deepEqual(L.splitOpenParams({ args: 'x' }), { context: null, params: { args: 'x' } });
  assert.deepEqual(L.splitOpenParams({ context: { table: 'incident' } }), { context: null, params: {} }, 'no sys_id: the page record is used');
  assert.deepEqual(L.splitOpenParams(undefined), { context: null, params: {} });
  assert.deepEqual(L.splitOpenParams('text'), { context: null, params: {} });
});

// ---- Failures -> the tool that explains it -----------------------------------------------------------------------

const groupOf = (items) => F.groupFailures(items)[0];
const email = (id, when = '2026-10-20 12:00:00', extra = {}) =>
  F.normaliseEmail({ sys_id: id, sys_created_on: when, type: 'send-failed', recipients: 'a@b.com', subject: 'Hello', error_string: '550 rejected', ...extra });

test('a failed email gets "Why was it not sent?" on the email itself', () => {
  const links = L.failureLinks(groupOf([email(ID)]));
  assert.equal(links.length, 1);
  assert.equal(links[0].panel, 'notify');
  assert.equal(links[0].label, 'Why was it not sent?');
  assert.deepEqual(links[0].params, { context: { table: 'sys_email', sysId: ID } });
});

test('an email row without a sys_id names no record, so it gets no button', () => {
  const noId = F.normaliseEmail({ sys_created_on: '2026-10-20 12:00:00', type: 'send-failed', recipients: 'a@b.com', subject: 'Hello', error_string: '550 rejected' });
  assert.equal(noId.target, null);
  assert.deepEqual(L.failureLinks(groupOf([noId])), []);
});

test('a failed flow gets "What is running on this record?" only when it names its source record', () => {
  const flow = (extra) => F.normaliseFlow({ sys_id: ID, sys_created_on: '2026-10-20 12:00:00', name: 'Onboard', state: 'error', error_message: 'x', ...extra });
  const links = L.failureLinks(groupOf([flow({ source_table: 'sn_hr_core_case', source_record: ID2 })]));
  assert.equal(links.length, 1);
  assert.equal(links[0].panel, 'process');
  assert.equal(links[0].label, 'What is running on this record?');
  assert.deepEqual(links[0].params, { context: { table: 'sn_hr_core_case', sysId: ID2 } });
  // The API can hand the value as { value, display_value }: the stored value is what counts.
  const wrapped = L.failureLinks(groupOf([flow({ source_table: { value: 'incident', display_value: 'Incident' }, source_record: { value: ID2, display_value: 'INC0010002' } })]));
  assert.deepEqual(wrapped[0].params, { context: { table: 'incident', sysId: ID2 } });
  // Not named, or named with something that is not a record: nothing is offered.
  assert.deepEqual(L.failureLinks(groupOf([flow({})])), []);
  assert.deepEqual(L.failureLinks(groupOf([flow({ source_table: 'incident' })])), [], 'a table without a record');
  assert.deepEqual(L.failureLinks(groupOf([flow({ source_table: 'incident', source_record: 'INC0010002' })])), [], 'a number is not a sys_id');
  assert.deepEqual(L.failureLinks(groupOf([flow({ source_table: 'Human Resources', source_record: ID2 })])), [], 'a label is not a table');
});

test('an event gets the email check only when the instance returned the record it was queued for', () => {
  const event = (extra) => F.normaliseEvent({ sys_id: ID, sys_created_on: '2026-10-20 12:00:00', name: 'incident.commented', state: 'error', ...extra });
  const links = L.failureLinks(groupOf([event({ table: 'incident', instance: ID2 })]));
  assert.equal(links.length, 1);
  assert.equal(links[0].panel, 'notify');
  assert.deepEqual(links[0].params, { context: { table: 'incident', sysId: ID2 } });
  assert.deepEqual(L.failureLinks(groupOf([event({ table: 'incident' })])), [], 'no instance column in the answer');
  assert.deepEqual(L.failureLinks(groupOf([event({ instance: ID2 })])), [], 'no table');
  assert.deepEqual(L.failureLinks(groupOf([event({ table: 'incident', instance: '' })])), []);
});

test('the event probe asks for the instance column, and it is listed for the self-check', () => {
  const probe = F.SOURCES.find((s) => s.id === 'event').probes[0];
  assert.ok(probe.fields.includes('instance'));
  assert.ok(/'instance'/.test(src('src/lib/requirements/existing.js').split("entry(FAILURES, 'sysevent'")[1].split('\n')[0]), 'requirements list the column');
});

test('other kinds of failure have no tool to hand over to', () => {
  const ecc = F.normaliseEcc({ sys_id: ID, sys_created_on: '2026-10-20 12:00:00', topic: 'Command', state: 'error', error_string: 'timed out' });
  const job = F.normaliseTrigger({ sys_id: ID, name: 'Nightly', next_action: '2026-10-20 10:00:00', state: '0' }, Date.UTC(2026, 9, 20, 12));
  assert.deepEqual(L.failureLinks(groupOf([ecc])), []);
  assert.deepEqual(L.failureLinks(groupOf([job])), []);
  assert.deepEqual(L.failureLinks(null), []);
  assert.deepEqual(L.failureLinks({}), []);
});

test('a group of repeats opens the newest one, and says so', () => {
  const flow = (id, when, record) => F.normaliseFlow({ sys_id: id, sys_created_on: when, name: 'Onboard', state: 'error', error_message: 'Value is null', source_table: 'incident', source_record: record });
  const group = groupOf([flow(ID, '2026-10-20 10:00:00', 'a'.repeat(32)), flow(ID2, '2026-10-20 12:00:00', 'b'.repeat(32)), flow('c'.repeat(32), '2026-10-20 11:00:00', 'c'.repeat(32))]);
  assert.equal(group.count, 3);
  const [link] = L.failureLinks(group);
  assert.deepEqual(link.params.context, { table: 'incident', sysId: 'b'.repeat(32) });
  assert.match(link.title, /most recent of 3/);
  assert.doesNotMatch(L.failureLinks(groupOf([flow(ID, '2026-10-20 10:00:00', 'a'.repeat(32))]))[0].title, /most recent/);
});

test('every panel the hooks open is a registered panel', () => {
  const registry = src('src/sidebar/panelRegistry.js');
  const names = new Set([...registry.matchAll(/^\s+name: '([a-z]+)',/gm)].map((m) => m[1]));
  const wanted = new Set([...L.whyMenuModel().map((e) => e.panel), 'notify', 'process', 'datamodel', 'properties', 'clienttrace', 'portal', 'previewfix', 'fieldusage', 'xray']);
  wanted.forEach((name) => assert.ok(names.has(name), `${name} is not in panelRegistry.js`));
});

// ---- System property names in the script editor ------------------------------------------------------------------

test('a property name is looked up only when it is a plain name that does not look like a secret', () => {
  assert.equal(L.canLookUpProperty('glide.servlet.uri'), true);
  assert.equal(L.canLookUpProperty('x_acme.timeout-ms'), true);
  assert.equal(L.canLookUpProperty('glide.ui.keyboard_shortcuts'), true, 'keyboard is not a key');
  ['x_acme.api_password', 'glide.smtp.password', 'x_acme.client_secret', 'x_acme.oauth_token', 'x_acme.api_key', 'x_acme.apikey', 'glide.credential.alias', 'x_acme.PASSWD'].forEach((name) =>
    assert.equal(L.canLookUpProperty(name), false, `${name} is secret-looking`)
  );
  ['', 'ab', 'has space', "quote'd", 'a;b', 'name\nline', 'x'.repeat(201)].forEach((name) => assert.equal(L.canLookUpProperty(name), false, JSON.stringify(name)));
  assert.equal(L.canLookUpProperty(null), false);
});

const prop = (row) => toProperty({ sys_id: ID, name: 'x_acme.timeout', type: 'integer', value: '30', ...row });

test('the hover line says what the property is set to, on one line', () => {
  assert.equal(L.propertyHoverLine({ property: prop({}), others: 0 }), 'Value on this instance: 30');
  assert.equal(L.propertyHoverLine({ property: prop({ value: '' }), others: 0 }), 'Value on this instance: (empty)');
  assert.equal(L.propertyHoverLine({ property: prop({ value: 'true', type: 'boolean' }), others: 0 }), 'Value on this instance: true');
  const long = L.propertyHoverLine({ property: prop({ value: `line one\nline two ${'x'.repeat(200)}` }), others: 0 });
  assert.ok(!long.includes('\n'), 'one line');
  assert.ok(long.length < 120 && long.endsWith('…'), 'clipped');
  assert.match(L.propertyHoverLine({ property: prop({}), others: 2 }), /\(2 more properties have this name\)/);
  assert.match(L.propertyHoverLine({ property: prop({}), others: 1 }), /\(1 more property has this name\)/);
});

test('a hidden, unreadable or secret-looking property shows no value at all', () => {
  const secret = [
    prop({ name: 'x_acme.api_password', value: 'hunter2' }),
    prop({ name: 'x_acme.endpoint', type: 'password2', value: 'hunter2' }),
    prop({ name: 'x_acme.endpoint', type: 'string', value: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' }),
    prop({ name: 'x_acme.endpoint', value: 'https://user:pass1234@host.example/api' }),
  ];
  secret.forEach((p) => {
    assert.equal(p.hidden, true, p.name);
    assert.equal(L.propertyHoverLine({ property: p, others: 0 }), '');
    assert.ok(!JSON.stringify(p).includes('hunter2'), 'the service already dropped the value');
  });
  // The value column was not returned: unreadable is not "(empty)".
  const unreadable = toProperty({ sys_id: ID, name: 'x_acme.timeout', type: 'integer' });
  assert.equal(unreadable.unreadable, true);
  assert.equal(L.propertyHoverLine({ property: unreadable, others: 0 }), '');
  // Even a property object that slipped through unmarked is not shown when its name says secret.
  assert.equal(L.propertyHoverLine({ property: { name: 'x_acme.client_secret', value: 'abc', hidden: false, empty: false }, others: 0 }), '');
});

test('a name with no property is said so, with the honest "or you cannot read it"; bad answers show nothing', () => {
  assert.match(L.propertyHoverLine({ property: null, others: 0 }), /No property with this name was found here, or your user cannot read it/);
  assert.equal(L.propertyHoverLine(null), '');
  assert.equal(L.propertyHoverLine('nope'), '');
  assert.equal(L.propertyHoverLine(undefined), '');
});

test('the value lookup reads each name once per session and never reads a secret-looking name', async () => {
  const asked = [];
  const lookup = L.createValueLookup(async (name) => {
    asked.push(name);
    return { property: prop({ name, value: '42' }), others: 0 };
  });
  assert.equal(lookup.peek('x_acme.timeout'), undefined, 'not looked up yet');
  const [a, b] = await Promise.all([lookup.load('x_acme.timeout'), lookup.load('x_acme.timeout')]);
  assert.equal(a, 'Value on this instance: 42');
  assert.equal(b, a);
  assert.deepEqual(asked, ['x_acme.timeout'], 'two hovers at once, one request');
  assert.equal(lookup.peek('x_acme.timeout'), 'Value on this instance: 42');
  await lookup.load('x_acme.timeout');
  assert.equal(asked.length, 1, 'the second hover is answered from the cache');
  assert.equal(await lookup.load('x_acme.api_key'), '');
  assert.equal(await lookup.load('glide.smtp.password'), '');
  assert.equal(await lookup.load('has space'), '');
  assert.deepEqual(asked, ['x_acme.timeout'], 'secret-looking and invalid names never reach the service');
});

test('a failing read shows nothing, and is not retried on every hover', async () => {
  let calls = 0;
  const lookup = L.createValueLookup(async () => {
    calls += 1;
    throw new Error('403 Forbidden');
  });
  assert.equal(await lookup.load('x_acme.timeout'), '');
  assert.equal(await lookup.load('x_acme.timeout'), '');
  assert.equal(calls, 1);
  assert.equal(lookup.peek('x_acme.timeout'), '');
  const synchronous = L.createValueLookup(() => {
    throw new Error('boom');
  });
  assert.equal(await synchronous.load('x_acme.timeout'), '');
  assert.equal(await L.createValueLookup(null).load('x_acme.timeout'), '', 'no service wired in');
});

test('the editor hover names the property, and go to definition says it is a property', () => {
  const text = "var t = gs.getProperty('x_acme.timeout', '30');\ngs.setProperty('x_acme.flag', 'true');";
  const ctx = { side: 'server', table: 'incident', fields: {}, properties: [{ name: 'x_acme.timeout', type: 'integer', description: 'Seconds' }] };
  const hover = getHoverInfo(text, text.indexOf('x_acme.timeout') + 3, ctx);
  assert.equal(hover.kind, 'propertyName');
  assert.equal(hover.name, 'x_acme.timeout');
  assert.equal(hover.title, 'System property x_acme.timeout');
  assert.deepEqual(getDefinitionTarget(text, text.indexOf('x_acme.timeout') + 3, ctx), { type: 'property', name: 'x_acme.timeout' });
  assert.deepEqual(getDefinitionTarget(text, text.indexOf('x_acme.flag') + 3, ctx), { type: 'property', name: 'x_acme.flag' }, 'setProperty works the same');
  assert.ok(L.canLookUpProperty(hover.name));
});

test('the editor wiring: the hover value, the Shift+F12 hand-over and the two tools it needs', () => {
  const editor = src('src/content/scriptEditor.js');
  assert.match(editor, /createValueLookup\(tools\.propertyValue/);
  assert.match(editor, /if \(info\.kind === 'propertyName'\) showPropertyValue\(info, offset\)/);
  assert.match(editor, /def\?\.type === 'property' && tools\.openPanel[^\n]*tools\.openPanel\('properties', \{ args: def\.name \}\)/);
  assert.ok(editor.indexOf("def?.type === 'property'") < editor.indexOf('referenceTarget(ta.value'), 'the panel is tried before the text search');
  const index = src('src/content/index.js');
  assert.match(index, /openPanel: \(name, params\) => Boolean\(sidebarApi\.openPanel\?\.\(name, params\)\)/);
  assert.match(index, /propertyValue: \(name\) => FEATURE_SERVICES\.propertyExplorerGet\(\{ name \}\)/);
});

// ---- Page-aware suggestions -------------------------------------------------------------------------------------

test('tickets are recognised by table name', () => {
  ['incident', 'problem', 'change_request', 'sc_req_item', 'sc_task', 'task', 'sn_customerservice_case', 'change_task', 'sc_request'].forEach((t) => assert.equal(isTicketTable(t), true, t));
  ['sys_user', 'cmdb_ci', 'sys_script', 'kb_knowledge', 'x_acme_widget', '', null, undefined, 'incident_sla'].forEach((t) => assert.equal(isTicketTable(t), false, String(t)));
  assert.equal(isTicketTable('Incident'), true, 'case does not matter');
  assert.ok(TICKET_TABLES.every((t) => /^[a-z][a-z0-9_]*$/.test(t)));
});

test('retrieved update sets and preview problems are update-set pages', () => {
  const record = (table) => ({ table, sysId: ID });
  assert.equal(pageKind(record('sys_remote_update_set')), 'updateset');
  assert.equal(pageKind(record('sys_update_preview_problem')), 'updateset');
  assert.equal(pageKind({ table: 'sys_remote_update_set', isList: true }), 'updateset');
  assert.equal(pageKind({ table: 'sys_update_preview_problem', isList: true }), 'updateset');
  assert.equal(pageKind(record('sys_update_set')), 'updateset');
  assert.equal(pageKind(record('sys_update_xml')), 'record', 'a single customer update is still a record');
  assert.equal(pageKind({ table: 'sys_update_xml', isList: true }), 'updateset');
});

test('the preview fix comes first on a retrieved update set and a preview problem, and stays last on your own update set', () => {
  assert.equal(suggestedIds({ table: 'sys_remote_update_set', sysId: ID })[0], 'panel.previewfix');
  assert.equal(suggestedIds({ table: 'sys_update_preview_problem', isList: true })[0], 'panel.previewfix');
  assert.equal(suggestedIds({ table: 'sys_remote_update_set', sysId: ID }).filter((id) => id === 'panel.previewfix').length, 1, 'listed once');
  assert.equal(suggestedIds({ table: 'sys_update_set', sysId: ID }).indexOf('panel.previewfix'), SUGGESTED.updateset.length - 1);
  const commands = ['panel.shipcheck', 'analyze.updateset', 'panel.push', 'panel.mywork', 'panel.previewfix'].map((id) => ({ id }));
  assert.ok(suggestFor({ table: 'sys_remote_update_set', sysId: ID }, commands, 4).some((c) => c.id === 'panel.previewfix'), 'it is among the four the palette shows');
  assert.ok(!suggestFor({ table: 'sys_update_set', sysId: ID }, commands, 4).some((c) => c.id === 'panel.previewfix'));
  assert.deepEqual(pageSuggestions({ table: 'sys_remote_update_set', sysId: ID }), suggestedIds({ table: 'sys_remote_update_set', sysId: ID }));
});

test('a ticket is a record whose flows and emails come first', () => {
  const ticket = { table: 'incident', sysId: ID };
  assert.equal(pageKind(ticket), 'ticket');
  assert.equal(pageKind({ table: 'incident', sysId: ID, scriptBody: 'long description text', scriptFieldLabel: 'Description' }), 'ticket', 'the longest-text fallback is not a script');
  assert.equal(pageKind({ table: 'incident', isList: true }), 'list', 'a list of tickets is a list');
  assert.equal(pageKind({ table: 'incident', sysId: '' }), 'other');
  assert.equal(pageKind({ table: 'sys_user', sysId: ID }), 'record');
  assert.deepEqual(SUGGESTED.ticket.slice(0, 2), ['panel.process', 'panel.notify']);
  // Everything a record is offered, a ticket is offered too.
  SUGGESTED.record.forEach((id) => assert.ok(SUGGESTED.ticket.includes(id), `a ticket also gets ${id}`));
  const commands = SUGGESTED.ticket.map((id) => ({ id }));
  assert.deepEqual(suggestFor(ticket, commands, 2).map((c) => c.id), ['panel.process', 'panel.notify']);
});

test('a script on a ticket table is still a script', () => {
  assert.equal(pageKind({ table: 'sys_script', sysId: ID, scriptBody: 'x = 1;', scriptFieldLabel: 'Script' }), 'script');
});

test('a Service Portal page is its own kind, with the portal tools first', () => {
  assert.equal(pageKind({ isPortal: true }), 'portal', 'a portal page has no table');
  assert.equal(pageKind({ isPortal: true, table: 'incident', sysId: ID }), 'portal', 'a ticket shown in the portal is still a portal page');
  assert.deepEqual(SUGGESTED.portal, ['panel.portal', 'panel.xray', 'analyze.search']);
  assert.equal(pageKind({ isPortal: false, table: 'incident', sysId: ID }), 'ticket');
});

test('portal addresses: a page id or a default portal suffix, never a platform path', () => {
  assert.equal(isPortalUrl('https://dev1.service-now.com/sp?id=index'), true);
  assert.equal(isPortalUrl('https://dev1.service-now.com/sp'), true);
  assert.equal(isPortalUrl('https://dev1.service-now.com/esc?id=sc_home'), true);
  assert.equal(isPortalUrl('https://dev1.service-now.com/csm'), true);
  assert.equal(isPortalUrl('https://dev1.service-now.com/mycompany?id=form&table=incident&sys_id=' + ID), true, 'a custom portal suffix with a page id');
  assert.equal(isPortalUrl('https://dev1.service-now.com/mycompany'), false, 'a custom suffix with no page id could be anything');
  assert.equal(isPortalUrl('https://dev1.service-now.com/incident.do?sys_id=' + ID), false);
  assert.equal(isPortalUrl('https://dev1.service-now.com/incident_list.do'), false);
  assert.equal(isPortalUrl('https://dev1.service-now.com/nav_to.do?uri=incident.do'), false);
  assert.equal(isPortalUrl('https://dev1.service-now.com/now/nav/ui/classic/params/target/incident.do'), false);
  assert.equal(isPortalUrl('https://dev1.service-now.com/api/now/table/incident?id=1'), false);
  assert.equal(isPortalUrl('not a url'), false);
  assert.equal(isPortalUrl(''), false);
});

test('every kind of page has a heading, a noun and a first job in the guide', () => {
  Object.keys(SUGGESTED).forEach((kind) => {
    assert.ok(SUGGESTED_TITLES[kind], `${kind} has a suggestion heading`);
    assert.ok(PAGE_NOUN[kind], `${kind} has a noun`);
    assert.ok(GUIDE_JOBS.some((job) => job.title === JOB_FOR_PAGE[kind]), `${kind} points at a real guide job`);
  });
  assert.equal(PAGE_NOUN.ticket, 'a ticket');
  assert.equal(PAGE_NOUN.portal, 'a portal page');
});

// ---- The ticket toolbar ------------------------------------------------------------------------------------------

test('a saved ticket gets a Why? button after Used by; other records and lists do not', () => {
  const ids = (model) => model.map((i) => i.id);
  const incident = toolbarModel({ table: 'incident', sysId: ID });
  assert.deepEqual(ids(incident), ['copySysId', 'copyLink', 'xml', 'info', 'versions', 'refs', 'why', 'formtools', 'names']);
  const why = incident.find((i) => i.id === 'why');
  assert.equal(why.short, 'Why?');
  assert.ok(why.label.toLowerCase().startsWith(why.short.toLowerCase()), 'the accessible name starts with the visible text');
  assert.ok(!ids(toolbarModel({ table: 'sys_user', sysId: ID })).includes('why'));
  assert.ok(!ids(toolbarModel({ table: 'sys_script', sysId: ID, hasScript: true })).includes('why'));
  assert.ok(!ids(toolbarModel({ table: 'incident', sysId: '-1' })).includes('why'), 'a new record has nothing running yet');
  assert.ok(!ids(toolbarModel({ table: 'incident', isList: true })).includes('why'));
});

test('the Why? button content wiring: the menu, the role filter and the panel it opens', () => {
  const inline = src('src/content/inline.js');
  assert.match(inline, /case 'why':\s*return openWhyMenu\(anchor, table\)/);
  assert.match(inline, /visibleTo\(roleAccess\?\.tier\(\) \?\? null, whyMenuModel\(\)\)/);
});

test('the Why? menu offers the panels a role can use', () => {
  const menu = L.whyMenuModel();
  assert.deepEqual(menu.map((e) => e.panel), ['process', 'notify', 'access', 'clienttrace']);
  assert.ok(menu.every((e) => e.id === `panel.${e.panel}` && e.label.trim()));
  assert.deepEqual(visibleTo('user', menu).map((e) => e.panel), ['process', 'access'], 'configuration readers are for developers');
  assert.deepEqual(visibleTo('developer', menu).map((e) => e.panel), ['process', 'notify', 'access', 'clienttrace']);
  assert.equal(visibleTo(null, menu), menu, 'roles unknown: everything');
});

// ---- Who sees which new tool -----------------------------------------------------------------------------------

test('the new panels are tiered by what they read', () => {
  ['panel.notify', 'panel.clienttrace', 'panel.datamodel', 'panel.portal', 'panel.previewfix'].forEach((id) => {
    assert.equal(requiredTier(id), 'developer', id);
    assert.equal(canSee('user', id), false, id);
    assert.equal(canSee('developer', id), true, id);
  });
  assert.equal(requiredTier('panel.properties'), 'admin');
  assert.equal(canSee('developer', 'panel.properties'), false);
  assert.equal(canSee('admin', 'panel.properties'), true);
  ['panel.process', 'panel.doctor', 'panel.access', 'panel.failures'].forEach((id) => assert.equal(requiredTier(id), 'user', `${id} is for everyone`));
  ['user', 'developer', 'admin', null].forEach((tier) => assert.equal(canSee(tier, 'panel.doctor'), true, 'the self-check explains why tools do not work, so everyone has it'));
});

test('every suggestion a role cannot see is skipped, so the palette never suggests a hidden tool', () => {
  const commands = SUGGESTED.ticket.map((id) => ({ id }));
  const forUser = suggestFor({ table: 'incident', sysId: ID }, visibleTo('user', commands), 4).map((c) => c.id);
  assert.ok(!forUser.includes('panel.notify'));
  assert.equal(forUser[0], 'panel.process');
  assert.equal(forUser.length, 4, 'the list is filled from the rest');
});

// ---- The sidebar and the groups of failures --------------------------------------------------------------------

test('the sidebar opens a registered panel on the named record and re-keys the panel when the record changes', () => {
  const sidebar = src('src/sidebar/Sidebar.jsx');
  assert.match(sidebar, /splitOpenParams\(params\)/);
  assert.match(sidebar, /entry\.withContext && pinned\) openPanel\(name, \{ context: pinned, params: rest \}\)/);
  assert.match(sidebar, /key=\{`\$\{p\.name\}:\$\{p\.params\?\.args \|\| ''\}:\$\{p\.context\?\.table \|\| ''\}:\$\{p\.context\?\.sysId \|\| ''\}`\}/);
});

test('a failure group carries the newest row\'s facts, so the buttons act on the newest', () => {
  const flow = (id, when, record) => F.normaliseFlow({ sys_id: id, sys_created_on: when, name: 'Onboard', state: 'error', error_message: 'Value is null', source_table: 'incident', source_record: record });
  const [group] = F.groupFailures([flow(ID, '2026-10-20 10:00:00', 'a'.repeat(32)), flow(ID2, '2026-10-20 12:00:00', 'b'.repeat(32))]);
  assert.equal(group.meta.sourceRecord, 'b'.repeat(32));
  assert.equal(group.target.sysId, ID2);
  const [single] = F.groupFailures([flow(ID, '2026-10-20 10:00:00', 'a'.repeat(32))]);
  assert.equal(single.meta.sourceTable, 'incident');
});

test('the panels hand over to each other through the services they are given', () => {
  assert.match(src('src/sidebar/FailuresPanel.jsx'), /failureLinks\(group\)/);
  assert.match(src('src/sidebar/FailuresPanel.jsx'), /services\.openRegisteredPanel\?\.\(link\.panel, link\.params\)/);
  const xray = src('src/sidebar/XrayPanel.jsx');
  assert.match(xray, /services\.openRegisteredPanel\('clienttrace', \{ args: field \}\)/);
  assert.match(xray, /What does the page do to this field at run time\?/);
  const fields = src('src/sidebar/FieldInspectorPanel.jsx');
  assert.match(fields, /services\.openRegisteredPanel\('datamodel', \{ args: loaded \}\)/);
  assert.match(fields, /services\.openRegisteredPanel\('datamodel', \{ args: `\$\{loaded\} \$\{f\.reference\}` \}\)/);
  const xrayPage = src('src/content/xray.js');
  assert.match(xrayPage, /state\.sidebar\.openPanel\('portal', \{ args \}\)/);
});

test('the table explorer\'s path arguments are what the data model panel reads', () => {
  const { parseArgs } = require('../src/lib/dataModel.js');
  assert.deepEqual(parseArgs('incident'), { mode: 'map', table: 'incident', from: 'incident', to: '' });
  assert.deepEqual(parseArgs('incident sys_user'), { mode: 'path', table: 'incident', from: 'incident', to: 'sys_user' });
  assert.deepEqual(parseArgs('sc_req_item sc_cat_item'), { mode: 'path', table: 'sc_req_item', from: 'sc_req_item', to: 'sc_cat_item' });
});

// Found live (2026-10-23): typing "/prop x" offered the older reserved "/props <text>" help row first and Enter took it,
// so the System properties tool could not be opened from the palette. A tool's own slash command now opens that tool.
test('a tool slash command opens its tool instead of a reserved-verb help row', async () => {
  const { slashCommand } = require('../src/content/commands.js');
  const row = slashCommand('/prop glide.email', { runCommand: () => {} });
  assert.match(row.title, /^Open System properties$/);
  assert.equal(row.hint, '/prop glide.email');
  assert.ok(row.score > 1000, 'it outranks a plain passthrough');
  const plain = slashCommand('/definitely-not-a-tool x', { runCommand: () => {} });
  assert.match(plain.title, /^Run /);
});
