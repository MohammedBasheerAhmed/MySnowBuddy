const test = require('node:test');
const assert = require('node:assert/strict');
const {
  KINDS,
  kindById,
  kindForWord,
  fieldsFor,
  GOTO_REQUIREMENTS,
  parseGoTo,
  cleanTerm,
  unsafeTermReason,
  rankKinds,
  pageAffinity,
  splitHumps,
  queryTokens,
  buildSearchQuery,
  buildStartsQuery,
  matchText,
  customness,
  scoreCandidate,
  rankCandidates,
  selectRows,
  normalizeRow,
  describeCandidate,
  toRow,
  refineCandidates,
  answersTerm,
  actionsFor,
  usageTarget,
  versionQuery,
  pendingEditMarker,
  parsePendingEdit,
  pendingEditMatches,
  classifyError,
  listRowsFor,
  noticeRowsFor,
  statusRow,
  STATUS_SCORE,
  createGoToEngine,
  BARE_KINDS,
  MORE_KINDS,
  MIN_ROWS,
  MAX_PARALLEL,
  LIMITS,
  BARE_SCORE_CAP,
} = require('../src/lib/goTo.js');
const { FIND_COMMANDS, findCommand } = require('../src/lib/slashCommands.js');
const { slashTier } = require('../src/lib/roleTier.js');

const sid = (n) => String(n).padStart(32, '0');
let counter = 0;

/** A Table API row as the palette reads it (display values on): a column is { value, display_value }. */
function apiRow(kindId, fields = {}) {
  counter += 1;
  const kind = kindById(kindId);
  const row = { sys_id: { value: sid(counter), display_value: sid(counter) } };
  Object.entries({ sys_created_by: 'admin', sys_updated_by: 'admin', sys_updated_on: '2024-03-01 10:00:00', ...fields }).forEach(([key, value]) => {
    row[key] = value && typeof value === 'object' ? value : { value: String(value), display_value: String(value) };
  });
  return { kind, row };
}
const cand = (kindId, fields) => {
  const { kind, row } = apiRow(kindId, fields);
  return normalizeRow(kind, row);
};

// ---- catalogue --------------------------------------------------------------------------------------------------------

test('columns checked on a real release (Australia): a fix script has no active column, an email script no description', () => {
  const kind = (id) => KINDS.find((k) => k.id === id);
  assert.ok(!kind('fix').active, 'sys_script_fix has no active column');
  assert.ok(fieldsFor(kind('fix')).includes('description'), 'sys_script_fix does have description');
  assert.ok(!fieldsFor(kind('es')).includes('description'), 'sys_script_email has no description column');
  assert.deepEqual(kind('es').describe({}, {}).extra, []);
});

test('the catalogue covers every kind in the brief, each with a table and search columns', () => {
  const tables = KINDS.map((k) => k.table);
  [
    'sys_script', 'sys_script_include', 'sys_script_client', 'sys_ui_action', 'sys_ui_policy', 'sys_ui_script', 'sys_ui_page', 'sys_ui_macro',
    'sysauto_script', 'sys_script_fix', 'sys_security_acl', 'sysevent_email_action', 'sys_script_email', 'sysevent_register', 'sysevent_script_action',
    'sys_hub_flow', 'sys_hub_action_type_definition', 'wf_workflow', 'sys_transform_map', 'sys_ws_definition', 'sp_widget', 'sp_page', 'sp_angular_provider',
    'sys_db_object', 'sys_dictionary', 'sys_properties', 'sys_user_role', 'sys_user_group', 'sys_user', 'sc_cat_item', 'sys_app', 'sys_update_set',
  ].forEach((table) => assert.ok(tables.includes(table), `missing ${table}`));
  KINDS.forEach((k) => {
    assert.ok(k.search.length && k.display && k.label && k.plural && k.icon, k.id);
    assert.ok(['user', 'developer', 'admin'].includes(k.tier), k.id);
    assert.equal(typeof k.describe(Object.fromEntries(fieldsFor(k).map((f) => [f, ''])), {}).extra.length, 'number', k.id);
  });
});

test('kind ids and every word that names a kind are unique', () => {
  assert.equal(new Set(KINDS.map((k) => k.id)).size, KINDS.length);
  const owner = new Map();
  KINDS.forEach((k) => {
    [...k.verbs, k.label, k.plural].map((w) => w.toLowerCase()).forEach((word) => {
      assert.ok(!owner.has(word) || owner.get(word) === k.id, `"${word}" names both ${owner.get(word)} and ${k.id}`);
      owner.set(word, k.id);
    });
  });
});

test('kinds that have a slash finder agree with it: same verb, table and display column, same role tier', () => {
  FIND_COMMANDS.forEach((def) => {
    const kind = KINDS.find((k) => k.id === def.verb);
    if (!kind) return; // incidents, changes, CIs...: records, not configuration
    assert.equal(kind.table, def.table, def.verb);
    assert.equal(kind.display, def.display, def.verb);
    def.search.forEach((column) => assert.ok(kind.search.includes(column), `${def.verb} searches ${column}`));
    def.aliases.forEach((alias) => assert.equal(kindForWord(alias).id, kind.id, alias));
    assert.equal(findCommand(def.verb).table, kind.table);
    assert.equal(kind.tier, slashTier(def.verb), `${def.verb} tier`);
  });
});

test('the columns requested include what is searched and shown, and the scope for application files', () => {
  const si = fieldsFor(kindById('si'));
  ['sys_id', 'name', 'api_name', 'active', 'sys_scope', 'sys_scope.scope', 'sys_updated_by', 'sys_created_by', 'sys_class_name'].forEach((f) => assert.ok(si.includes(f), f));
  assert.ok(!fieldsFor(kindById('u')).includes('sys_scope'));
  // The value of a property can be a secret: it is never requested.
  assert.ok(!fieldsFor(kindById('prop')).includes('value'));
  assert.ok(GOTO_REQUIREMENTS.every((r) => r.feature && r.table && r.columns.length && r.optional === true));
});

// ---- parsing what was typed -----------------------------------------------------------------------------------------------

test('a prefix names the kinds: verbs, full names, plurals and several at once', () => {
  assert.deepEqual(parseGoTo('br: incident closed'), { mode: 'kind', term: 'incident closed', kinds: ['br'], denied: [], tooShort: false, raw: 'br: incident closed' });
  assert.equal(parseGoTo('si:AjaxUtil').term, 'AjaxUtil');
  assert.deepEqual(parseGoTo('Business Rule: x1').kinds, ['br']);
  assert.deepEqual(parseGoTo('business rules : closed').kinds, ['br']);
  assert.deepEqual(parseGoTo('ACLs: incident.state').kinds, ['acl']);
  assert.deepEqual(parseGoTo('widget: approval').kinds, ['widget']);
  assert.deepEqual(parseGoTo('script include: ajax').kinds, ['si']);
  assert.deepEqual(parseGoTo('sj: nightly').kinds, ['job']);
  assert.deepEqual(parseGoTo('br,si: notify').kinds, ['br', 'si']);
  assert.deepEqual(parseGoTo('sys_script_include: ajax').kinds, ['si'], 'the table name works too');
  assert.deepEqual(parseGoTo('sysevent_email_action: closed').kinds, ['notif']);
});

test('an unknown word before a colon is part of the text, not a prefix', () => {
  const parsed = parseGoTo('incident: closed again');
  assert.equal(parsed.mode, 'bare');
  assert.equal(parsed.term, 'incident: closed again');
  assert.equal(parseGoTo('br,nope: x').mode, 'bare');
});

test('a prefix with no text yet still names the kind (the palette offers the list), and one letter is too short', () => {
  const empty = parseGoTo('br:');
  assert.deepEqual([empty.mode, empty.kinds, empty.term, empty.tooShort], ['kind', ['br'], '', true]);
  assert.equal(parseGoTo('br: i').tooShort, true);
  assert.equal(parseGoTo('br: in').tooShort, false);
});

test('text that is something else is left to the other palette features', () => {
  assert.equal(parseGoTo('/br incident').mode, 'none');
  assert.equal(parseGoTo('@abel').mode, 'none');
  assert.equal(parseGoTo('9de5069c0b0f0300b8b9e5cd35673a5b').mode, 'none');
  assert.equal(parseGoTo('INC0010042').mode, 'none');
  assert.equal(parseGoTo('active=true^priority=1').mode, 'none');
  assert.equal(parseGoTo('priority>=2').mode, 'none');
  assert.equal(parseGoTo('https://dev12345.service-now.com/incident.do').mode, 'none');
  assert.equal(parseGoTo('').mode, 'none');
  assert.equal(parseGoTo('   ').mode, 'none');
});

test('a bare fragment needs three characters, a prefixed one two; nothing shorter ever reaches a query', () => {
  assert.equal(parseGoTo('in').mode, 'none');
  assert.equal(parseGoTo('inc').mode, 'bare');
  assert.equal(parseGoTo('br: i').term, 'i');
  assert.equal(parseGoTo('br: i').tooShort, true);
  assert.equal(parseGoTo(`x${'y'.repeat(80)}`).mode, 'none');
});

test('a caret or a leading javascript: is refused before any query is built', () => {
  assert.equal(parseGoTo('closed^ORactive=false').mode, 'none');
  assert.equal(parseGoTo('closed^ORactive=false').reason, 'caret');
  assert.equal(parseGoTo('br: x^NQy').mode, 'none');
  assert.equal(parseGoTo('br: javascript:gs.getUserID()').mode, 'none');
  assert.equal(parseGoTo('br: javascript:gs.getUserID()').reason, 'script');
  assert.equal(parseGoTo('  JavaScript : alert(1)').mode, 'none');
  assert.equal(unsafeTermReason('a^b'), 'caret');
  assert.equal(unsafeTermReason('ordinary name'), '');
});

test('control characters and runs of spaces are cleaned', () => {
  assert.equal(cleanTerm('  incident \n\t closed  '), 'incident closed');
  assert.equal(parseGoTo('br:  incident\u0000 closed ').term, 'incident closed');
});

test('a bare fragment gets the most likely kinds, at most eight', () => {
  const parsed = parseGoTo('closed');
  assert.equal(parsed.mode, 'bare');
  assert.equal(parsed.kinds.length, BARE_KINDS);
  assert.ok(parsed.kinds.includes('br') && parsed.kinds.includes('si'));
});

test('the kinds after the likely ones are kept aside, for a name that is rare', () => {
  const parsed = parseGoTo('approval');
  assert.equal(parsed.more.length, MORE_KINDS);
  assert.ok(parsed.more.every((id) => !parsed.kinds.includes(id)));
  assert.equal(new Set([...parsed.kinds, ...parsed.more]).size, BARE_KINDS + MORE_KINDS);
  assert.equal(parseGoTo('br: approval').more, undefined);
});

test('the role tier removes kinds the user cannot read, and says which', () => {
  const user = parseGoTo('br: closed', { tier: 'user' });
  assert.deepEqual(user.kinds, []);
  assert.deepEqual(user.denied, ['br']);
  assert.deepEqual(parseGoTo('br: closed', { tier: 'developer' }).kinds, ['br']);
  assert.deepEqual(parseGoTo('prop: glide', { tier: 'developer' }).kinds, []);
  assert.deepEqual(parseGoTo('prop: glide', { tier: 'admin' }).kinds, ['prop']);
  const bare = parseGoTo('abel tuter', { tier: 'user' });
  assert.ok(bare.kinds.every((id) => kindById(id).tier === 'user'));
  assert.ok(bare.kinds.includes('u'));
});

// ---- which kinds are likely --------------------------------------------------------------------------------------------

test('on a form or list of a data table the kinds configured for that table come first', () => {
  const ids = (ctx, term = 'closed') => rankKinds(term, ctx).map((k) => k.id);
  const onIncident = ids({ table: 'incident', sysId: sid(1) }).slice(0, 6);
  ['br', 'cl', 'uia', 'acl', 'notif'].forEach((id) => assert.ok(onIncident.includes(id), `${id} near the top on incident`));
  assert.ok(pageAffinity(kindById('br'), { table: 'incident', isList: true }) > 0);
  assert.equal(pageAffinity(kindById('widget'), { table: 'incident' }), 0);
  assert.equal(ids({})[0], 'si');
});

test('on a configuration form the same kind comes first, on the portal tables the portal kinds', () => {
  assert.equal(rankKinds('closed', { table: 'sys_script' })[0].id, 'br');
  assert.equal(rankKinds('closed', { table: 'sys_ui_policy' })[0].id, 'uip');
  assert.equal(rankKinds('closed', { table: 'sys_security_acl' })[0].id, 'acl');
  const portal = rankKinds('closed', { table: 'sp_instance' }).slice(0, 7).map((k) => k.id);
  assert.ok(portal.includes('widget') && portal.includes('page') && portal.includes('prov'));
  assert.equal(rankKinds('abel', { table: 'sys_user' })[0].id, 'u');
});

test('the shape of the text points at a kind', () => {
  assert.equal(rankKinds('AjaxUtil')[0].id, 'si');
  assert.equal(rankKinds('glide.ui.concourse.onmenu')[0].id, 'prop');
  assert.equal(rankKinds('incident.state')[0].id, 'acl');
  assert.ok(rankKinds('incident.state').slice(0, BARE_KINDS).map((k) => k.id).includes('dict'));
  assert.equal(rankKinds('abel.tuter@example.com')[0].id, 'u');
  assert.ok(rankKinds('x_acme_hr').slice(0, 4).map((k) => k.id).includes('app'));
  assert.equal(rankKinds('u_custom_table')[0].id, 'table');
  const phrase = rankKinds('incident was resolved').slice(0, 5).map((k) => k.id);
  assert.ok(phrase.includes('notif') && phrase.includes('flow') && phrase.includes('br'));
  assert.ok(!phrase.includes('si'));
});

// ---- query building -------------------------------------------------------------------------------------------------------

test('every typed word must be found, searched in every search column, newest change first', () => {
  const br = kindById('br');
  assert.equal(buildSearchQuery(br, 'incident closed'), 'nameLIKEincident^nameLIKEclosed^ORDERBYDESCsys_updated_on');
  const si = kindById('si');
  assert.equal(buildSearchQuery(si, 'AjaxUtil'), 'nameLIKEAjax^ORapi_nameLIKEAjax^nameLIKEUtil^ORapi_nameLIKEUtil^ORDERBYDESCsys_updated_on');
  assert.equal(buildSearchQuery(si, 'IncidentUtils'), 'nameLIKEIncident^ORapi_nameLIKEIncident^nameLIKEUtils^ORapi_nameLIKEUtils^ORDERBYDESCsys_updated_on');
  assert.equal(buildSearchQuery(br, ''), null);
});

test('a name with a dot or an underscore is one word, a lower-case word is never split', () => {
  assert.deepEqual(queryTokens('global.AjaxUtil'), ['global.AjaxUtil']);
  assert.deepEqual(queryTokens('x_acme_hr'), ['x_acme_hr']);
  assert.deepEqual(queryTokens('incident'), ['incident']);
  assert.deepEqual(queryTokens('gForm'), ['gForm']);
  assert.deepEqual(splitHumps('AJAXMessagingUtils'), ['AJAX', 'Messaging', 'Utils']);
  assert.deepEqual(splitHumps('UTILS'), ['UTILS']);
  assert.equal(queryTokens('a b c d e f').length, 4);
});

test('typed text cannot add conditions: carets are doubled, newlines dropped, javascript: refused', () => {
  const br = kindById('br');
  const hostile = buildSearchQuery(br, 'x^ORactive=false^NQsys_idISNOTEMPTY');
  assert.equal(hostile, 'nameLIKEx^^ORactive=false^^NQsys_idISNOTEMPTY^ORDERBYDESCsys_updated_on');
  // ServiceNow reads "^^" as a literal caret, so what is left to separate conditions is the builder's own ORDERBY.
  assert.deepEqual(hostile.replace(/\^\^/g, '\u0001').split('^'), ['nameLIKEx\u0001ORactive=false\u0001NQsys_idISNOTEMPTY', 'ORDERBYDESCsys_updated_on']);
  assert.throws(() => buildSearchQuery(br, 'javascript:gs.log(1)'), /javascript/);
  // Every word is checked, not only the first.
  assert.throws(() => buildSearchQuery(br, 'closed javascript:gs.getUserID()'), /javascript/);
  assert.ok(!buildSearchQuery(br, 'line one\nline two').includes('\n'));
  assert.throws(() => buildStartsQuery(br, '  JAVASCRIPT:evil()'), /javascript/);
  assert.throws(() => buildStartsQuery(br, 'javascript : evil()'), /javascript/);
  assert.equal(buildStartsQuery(br, 'a^b'), 'nameSTARTSWITHa^^b^ORDERBYname');
});

test('the starts-with follow-up searches every search column and sorts by the shown name', () => {
  assert.equal(buildStartsQuery(kindById('si'), 'Ajax'), 'nameSTARTSWITHAjax^ORapi_nameSTARTSWITHAjax^ORDERBYname');
  assert.equal(buildStartsQuery(kindById('br'), ''), null);
});

test('dictionary entries are searched as table.column when the text has a dot, and empty collection rows are left out', () => {
  const dict = kindById('dict');
  assert.equal(buildSearchQuery(dict, 'incident.state'), 'elementISNOTEMPTY^name=incident^elementLIKEstate^ORDERBYelement');
  assert.equal(buildSearchQuery(dict, 'incident.'), 'elementISNOTEMPTY^name=incident^ORDERBYelement');
  assert.equal(buildSearchQuery(dict, 'short desc'), 'elementISNOTEMPTY^elementLIKEshort^ORcolumn_labelLIKEshort^elementLIKEdesc^ORcolumn_labelLIKEdesc^ORDERBYDESCsys_updated_on');
  assert.equal(buildStartsQuery(dict, 'incident.state'), null);
});

// ---- text matching ------------------------------------------------------------------------------------------------------

test('exact beats starts with beats word start beats contains, with realistic script include names', () => {
  const score = (text) => matchText('ajaxutil', text);
  assert.equal(score('AjaxUtil').tier, 'exact');
  assert.equal(score('AjaxUtilities').tier, 'prefix');
  assert.equal(score('Legacy_AjaxUtil').tier, 'word');
  assert.equal(score('MyAjaxUtil').tier, 'word'); // a camel hump starts a word
  assert.equal(score('Maximajaxutiler').tier, 'contains');
  const order = ['AjaxUtil', 'AjaxUtilities', 'Legacy_AjaxUtil', 'Maximajaxutiler'].map((t) => score(t).score);
  assert.deepEqual([...order].sort((a, b) => b - a), order);
});

test('separators do not matter for an exact or starts-with match', () => {
  assert.equal(matchText('incident closed', 'Incident_Closed').tier, 'exact');
  assert.equal(matchText('incident closed', 'Incident - closed notification').tier, 'prefix');
  assert.equal(matchText('incident.state', 'incident state').tier, 'exact');
});

test('several words match in any order, better when in order and at word starts', () => {
  const inOrder = matchText('closed incident', 'Closed incident notice');
  assert.equal(inOrder.tier, 'prefix');
  const words = matchText('notify p1', 'Notify caller on P1');
  assert.equal(words.tier, 'tokens');
  assert.equal(words.score, 600);
  const anyOrder = matchText('p1 notify', 'Notify caller on P1');
  assert.equal(anyOrder.tier, 'tokens');
  assert.equal(anyOrder.score, 380);
  assert.ok(words.score > anyOrder.score);
});

test('camel humps in the typed text find the class: AjaxUtil finds AJAXMessagingUtils', () => {
  const m = matchText('AjaxUtil', 'AJAXMessagingUtils');
  assert.equal(m.tier, 'tokens');
  assert.ok(m.score >= 600);
  assert.equal(matchText('AjaxUtil', 'IncidentUtils').tier, 'none');
});

test('a loose in-order match is last and needs three characters', () => {
  assert.equal(matchText('incdnt', 'Incident - closed').tier, 'fuzzy');
  assert.equal(matchText('xz', 'Incident').tier, 'none');
  assert.equal(matchText('zzz', 'Incident').tier, 'none');
  assert.ok(matchText('incdnt', 'Incident - closed').score < matchText('closed', 'Incident - closed').score);
});

test('match positions are for highlighting: whole words, not scattered letters', () => {
  assert.deepEqual(matchText('closed', 'Incident - closed').hits, [11, 12, 13, 14, 15, 16]);
  assert.deepEqual(matchText('incident closed', 'Incident - closed notification').hits.slice(0, 3), [0, 1, 2]);
  assert.deepEqual(matchText('nothing', 'Incident').hits, []);
  assert.deepEqual(matchText('', 'Incident').hits, []);
});

// ---- rows and ranking ---------------------------------------------------------------------------------------------------

const BR_FIELDS = (name, extra = {}) => ({ name, collection: 'incident', when: 'after', action_update: 'true', active: 'true', sys_scope: { value: 'global', display_value: 'Global' }, 'sys_scope.scope': 'global', ...extra });

test('a row becomes a candidate with the hint line, scope and flags', () => {
  const c = cand('br', BR_FIELDS('Incident - sync assignment group', { sys_created_by: 'maria.dev' }));
  assert.equal(c.name, 'Incident - sync assignment group');
  assert.equal(c.bound, 'incident');
  assert.equal(c.scope, 'global');
  assert.equal(c.active, true);
  assert.equal(describeCandidate(c), 'incident · global · after update');
  assert.equal(c.table, 'sys_script');
  assert.match(c.id, /^sys_script:/);
  const multi = cand('br', BR_FIELDS('Audit', { when: 'before', action_insert: 'true', action_update: 'true' }));
  assert.equal(describeCandidate(multi), 'incident · global · before insert/update');
});

test('a script include shows its API name and whether the browser can call it', () => {
  const c = cand('si', { name: 'AjaxUtil', api_name: 'x_acme_hr.AjaxUtil', client_callable: 'true', active: 'true', sys_scope: { value: sid(99), display_value: 'HR Tweaks' }, 'sys_scope.scope': 'x_acme_hr' });
  assert.equal(describeCandidate(c), 'x_acme_hr · client callable', 'the API name is the scope and the name, so it adds nothing');
  const odd = cand('si', { name: 'Helper', api_name: 'global.OtherName', client_callable: 'false', active: 'true' });
  assert.equal(describeCandidate(odd), 'global.OtherName');
  assert.deepEqual(c.aliases, ['x_acme_hr.AjaxUtil']);
});

test('the opening table is the row class when it has one, a row without a real sys_id is dropped', () => {
  const catalog = cand('cl', { name: 'Hide phone', table: 'sc_req_item', sys_class_name: 'catalog_script_client', active: 'true' });
  assert.equal(catalog.table, 'catalog_script_client');
  assert.equal(normalizeRow(kindById('br'), { sys_id: 'global', name: 'x' }), null);
  assert.equal(normalizeRow(kindById('br'), {}), null);
});

test('a dictionary row is named table.column and a user row shows the user name and e-mail', () => {
  const dict = cand('dict', { name: 'incident', element: 'short_description', column_label: 'Short description', internal_type: { value: 'string', display_value: 'String' }, active: 'true' });
  assert.equal(dict.name, 'incident.short_description');
  assert.equal(describeCandidate(dict), 'incident · Short description · String');
  const user = cand('u', { name: 'Abel Tuter', user_name: 'abel.tuter', email: 'abel.tuter@example.com', active: 'true' });
  assert.equal(describeCandidate(user), 'abel.tuter · abel.tuter@example.com');
  assert.deepEqual(user.aliases, ['abel.tuter', 'abel.tuter@example.com']);
});

test('custom records outrank platform ones that match equally; the signals are documented in customness()', () => {
  const platform = cand('br', BR_FIELDS('Incident - notify', { sys_created_by: 'system', sys_updated_by: 'system' }));
  const custom = cand('br', BR_FIELDS('Incident - notify', { sys_created_by: 'maria.dev', sys_updated_by: 'maria.dev' }));
  assert.equal(customness(platform), 0);
  assert.equal(customness(custom), 1);
  const ranked = rankCandidates([platform, custom], 'incident');
  assert.equal(ranked[0].c, custom);
  assert.ok(ranked[0].score - ranked[1].score >= 70);
  // A scoped application someone built is custom; a store or platform scope is not.
  assert.equal(customness({ scope: 'x_acme_hr', createdBy: 'system', updatedBy: 'system' }), 1);
  assert.equal(customness({ scope: 'sn_hr_core', createdBy: 'maria.dev', updatedBy: 'maria.dev' }), 0);
  assert.equal(customness({ scope: 'global', createdBy: 'admin', updatedBy: 'admin' }), 0.4);
  // Shipped content that a person has edited since counts a little.
  assert.equal(customness({ scope: 'global', createdBy: 'system', updatedBy: 'maria.dev' }), 0.2);
});

test('a better name match beats the custom boost', () => {
  const exactPlatform = cand('si', { name: 'IncidentUtils', api_name: 'global.IncidentUtils', sys_created_by: 'system', sys_updated_by: 'system', active: 'true' });
  const looseCustom = cand('si', { name: 'MyOldIncidentUtilsCopy', api_name: 'global.MyOldIncidentUtilsCopy', sys_created_by: 'maria.dev', sys_updated_by: 'maria.dev', active: 'true' });
  assert.equal(rankCandidates([looseCustom, exactPlatform], 'IncidentUtils')[0].c, exactPlatform);
});

test('recently opened records rise, the most recent most', () => {
  const a = cand('br', BR_FIELDS('Incident - alpha'));
  const b = cand('br', BR_FIELDS('Incident - bravo'));
  const c = cand('br', BR_FIELDS('Incident - gamma'));
  const none = rankCandidates([a, b, c], 'incident').map((r) => r.c.name);
  assert.deepEqual(none, ['Incident - alpha', 'Incident - bravo', 'Incident - gamma']);
  const recents = new Map([[c.sysId, 0], [b.sysId, 7]]);
  assert.deepEqual(rankCandidates([a, b, c], 'incident', { recents }).map((r) => r.c.name), ['Incident - gamma', 'Incident - bravo', 'Incident - alpha']);
  assert.ok(scoreCandidate(c, 'incident', { recents }).score > scoreCandidate(b, 'incident', { recents }).score);
});

test('inactive records are kept, ranked lower and flagged for the badge', () => {
  const live = cand('br', BR_FIELDS('Incident - legacy escalation'));
  const dead = cand('br', BR_FIELDS('Incident - legacy escalation', { active: 'false' }));
  assert.equal(dead.active, false);
  const ranked = rankCandidates([dead, live], 'incident - legacy');
  assert.equal(ranked[0].c, live);
  assert.equal(ranked.length, 2);
  assert.equal(toRow(ranked[1]).inactive, true);
  assert.equal(toRow(ranked[0]).inactive, false);
  // A table without an active column is never called inactive.
  assert.equal(cand('widget', { name: 'Approval', id: 'approval' }).active, null);
});

test('rules for the table of the page on screen come first', () => {
  const onIncident = cand('br', BR_FIELDS('Close notes required', { collection: 'incident' }));
  const onChange = cand('br', BR_FIELDS('Close notes required', { collection: 'change_request' }));
  const ranked = rankCandidates([onChange, onIncident], 'close notes', { ctx: { table: 'incident', sysId: sid(7) } });
  assert.equal(ranked[0].c, onIncident);
  // A rule on task also applies to incidents, a little less.
  const onTask = cand('br', BR_FIELDS('Close notes required', { collection: 'task' }));
  const order = rankCandidates([onChange, onTask, onIncident], 'close notes', { ctx: { table: 'incident' } }).map((r) => r.c.bound);
  assert.deepEqual(order, ['incident', 'task', 'change_request']);
});

test('a match on the API name counts, a little less than the same match on the name', () => {
  const byApi = cand('si', { name: 'Helper', api_name: 'x_acme_hr.ApprovalHelper', active: 'true', sys_created_by: 'maria.dev', sys_updated_by: 'maria.dev' });
  const byName = cand('si', { name: 'ApprovalHelper', api_name: 'x_acme_hr.Different', active: 'true', sys_created_by: 'maria.dev', sys_updated_by: 'maria.dev' });
  const ranked = rankCandidates([byApi, byName], 'approvalhelper');
  assert.equal(ranked[0].c, byName);
  assert.ok(ranked[1].score > 400, 'the API name match is not lost');
  assert.deepEqual(ranked[1].hits, [], 'no highlight in the title for an API-name match');
});

test('a shorter name wins between two equal matches, then the name decides', () => {
  const a = cand('br', BR_FIELDS('Incident closed'));
  const b = cand('br', BR_FIELDS('Incident closed and then some more words appended'));
  assert.equal(rankCandidates([b, a], 'incident closed')[0].c, a);
  const x = cand('br', BR_FIELDS('Omega rule'));
  const y = cand('br', BR_FIELDS('Alpha rule'));
  assert.deepEqual(rankCandidates([x, y], 'rule').map((r) => r.c.name), ['Alpha rule', 'Omega rule']);
});

test('a row that matched only on another column is kept below the real name matches', () => {
  const byDescription = cand('u', { name: 'Fred Luddy', user_name: 'fred.luddy', email: 'fred@example.com', active: 'true' });
  const byName = cand('u', { name: 'Abel Tuter', user_name: 'abel.tuter', email: 'abel.tuter@example.com', active: 'true' });
  const ranked = rankCandidates([byDescription, byName], 'tuter');
  assert.equal(ranked[0].c, byName);
  assert.equal(ranked[1].tier, 'none');
  assert.ok(ranked[1].score > 0);
});

test('the best match of every kind is shown even when one kind has many equally good ones', () => {
  const rules = Array.from({ length: 10 }, (_, i) => cand('br', BR_FIELDS('Incident rule ' + i, { collection: 'incident' })));
  const util = cand('si', { name: 'IncidentUtils', api_name: 'global.IncidentUtils', active: 'true' });
  const ranked = rankCandidates([...rules, util], 'incident', { ctx: { table: 'incident' } });
  assert.equal(ranked[ranked.length - 1].c, util, 'the rules outrank it on the incident form');
  const shown = selectRows(ranked, { perKind: 10, perName: 10, total: 3 });
  assert.equal(shown.length, 3);
  assert.ok(shown.some((r) => r.c === util), 'but the script include still gets a row');
  assert.equal(shown[0].c.kind, 'br', 'the order is still by score');
});

test('the list shown keeps variety: a limit per kind and an overall limit', () => {
  const many = Array.from({ length: 12 }, (_, i) => cand('br', BR_FIELDS(`Incident rule ${i}`)));
  const others = [cand('si', { name: 'IncidentUtils', api_name: 'global.IncidentUtils', active: 'true' }), cand('acl', { name: 'incident.state', active: 'true' })];
  const ranked = rankCandidates([...many, ...others], 'incident');
  const bare = selectRows(ranked, LIMITS.bare);
  assert.equal(bare.filter((r) => r.c.kind === 'br').length, LIMITS.bare.perKind);
  assert.ok(bare.some((r) => r.c.kind === 'si') && bare.some((r) => r.c.kind === 'acl'));
  assert.equal(selectRows(ranked, { perKind: 25, total: 5 }).length, 5);
  assert.equal(selectRows(ranked, LIMITS.kind).length, 14);
});

test('an ACL shows its operation first, and four ACLs with one name do not fill a mixed list', () => {
  const acls = ['read', 'write', 'create', 'delete'].map((op) => cand('acl', { name: 'incident', operation: op, type: 'record', active: 'true', sys_scope: { value: 'global', display_value: 'Global' }, 'sys_scope.scope': 'global' }));
  assert.equal(describeCandidate(acls[1]), 'write · record · global');
  const field = cand('acl', { name: 'incident.state', operation: 'write', type: 'record', active: 'true', 'sys_scope.scope': 'global' });
  assert.equal(describeCandidate(field), 'incident · write · record · global');
  const ranked = rankCandidates([...acls, cand('br', BR_FIELDS('Incident - sync assignment group'))], 'incident');
  assert.equal(selectRows(ranked, LIMITS.bare).filter((r) => r.c.kind === 'acl').length, 2);
  assert.equal(selectRows(ranked, LIMITS.kind).filter((r) => r.c.kind === 'acl').length, 4, 'a search for ACLs alone shows them all');
});

test('a result row carries what the palette needs', () => {
  const entry = rankCandidates([cand('br', BR_FIELDS('Incident - sync assignment group', { sys_created_by: 'maria.dev' }))], 'sync')[0];
  const row = toRow(entry);
  assert.equal(row.id, `goto.sys_script.${entry.c.sysId}`);
  assert.equal(row.title, 'Incident - sync assignment group');
  assert.equal(row.kindLabel, 'Business Rule');
  assert.equal(row.hint, 'incident · global · after update');
  assert.deepEqual(row.goTo, { kind: 'br', table: 'sys_script', sysId: entry.c.sysId, name: 'Incident - sync assignment group' });
  assert.ok(row.score > 0 && row.score <= 1090);
  assert.ok(row.hits.length > 0);
});

test('while the next letter is typed, the rows already fetched are narrowed at once', () => {
  const list = [cand('br', BR_FIELDS('Incident - sync assignment group')), cand('br', BR_FIELDS('Notify caller on P1')), cand('si', { name: 'IncidentUtils', api_name: 'global.IncidentUtils', active: 'true' })];
  assert.deepEqual(refineCandidates(list, 'incident').map((c) => c.name), ['Incident - sync assignment group', 'IncidentUtils']);
  assert.deepEqual(refineCandidates(list, 'incident u').map((c) => c.name), ['IncidentUtils']);
  assert.deepEqual(refineCandidates(list, 'zzz'), []);
});

// ---- actions -------------------------------------------------------------------------------------------------------------

test('the actions depend on the kind: script kinds can be edited, only some have a "where is this used"', () => {
  const ids = (goTo, opts) => actionsFor(goTo, opts).map((a) => a.id);
  const si = { kind: 'si', table: 'sys_script_include', sysId: sid(1), name: 'AjaxUtil' };
  assert.deepEqual(ids(si), ['open', 'tab', 'edit', 'usage', 'versions', 'link', 'sysid']);
  assert.deepEqual(ids({ kind: 'u', table: 'sys_user', sysId: sid(2), name: 'Abel' }), ['open', 'tab', 'link', 'sysid']);
  assert.ok(!ids({ kind: 'br', sysId: sid(3), name: 'x' }).includes('usage'));
  assert.ok(ids({ kind: 'br', sysId: sid(3), name: 'x' }, { onPage: true }).includes('usage'));
  assert.equal(actionsFor(si).find((a) => a.id === 'edit').label, 'Open it, then edit the script');
  assert.equal(actionsFor(si, { onPage: true }).find((a) => a.id === 'edit').label, 'Edit the script here');
  assert.ok(ids({ kind: 'prop', sysId: sid(4), name: 'glide.ui.concourse.onmenu' }).includes('usage'));
  assert.deepEqual(ids({ kind: 'table', sysId: sid(8), name: 'incident' }), ['open', 'tab', 'list', 'usage', 'link', 'sysid']);
  assert.equal(actionsFor({ kind: 'table', sysId: sid(8), name: 'incident' }).find((a) => a.id === 'list').hint, 'incident_list.do');
  assert.ok(!ids({ kind: 'table', sysId: sid(8), name: 'bad name; x' }).includes('list'));
  assert.deepEqual(actionsFor({ kind: 'nope' }), []);
});

test('"where is this used" names what to search for', () => {
  assert.deepEqual(usageTarget({ kind: 'si', name: 'AjaxUtil' }), { type: 'impact', value: 'AjaxUtil' });
  assert.deepEqual(usageTarget({ kind: 'prop', name: 'glide.ui.concourse.onmenu' }), { type: 'code', value: 'glide.ui.concourse.onmenu' });
  assert.deepEqual(usageTarget({ kind: 'dict', name: 'incident.short_description' }), { type: 'field', value: 'incident.short_description' });
  assert.equal(usageTarget({ kind: 'u', name: 'Abel' }), null);
});

test('the version list uses the same query as the Record versions command', () => {
  assert.equal(versionQuery('sys_script_include', sid(5)), `name=sys_script_include_${sid(5)}^ORDERBYDESCsys_recorded_at`);
});

test('the "open it, then edit" marker expires and only matches the record it names', () => {
  const now = 1_700_000_000_000;
  const marker = pendingEditMarker('sys_script', sid(6), now);
  assert.deepEqual(parsePendingEdit(marker, now + 5000), { table: 'sys_script', sysId: sid(6) });
  assert.equal(parsePendingEdit(marker, now + 61_000), null);
  assert.equal(parsePendingEdit('not json', now), null);
  assert.equal(parsePendingEdit(JSON.stringify({ table: 'sys_script; drop', sysId: sid(6), at: now }), now), null);
  assert.equal(parsePendingEdit(JSON.stringify({ table: 'sys_script', sysId: 'short', at: now }), now), null);
  assert.equal(pendingEditMatches({ table: 'sys_script', sysId: sid(6) }, { table: 'sys_script', sysId: sid(6) }), true);
  assert.equal(pendingEditMatches({ table: 'sys_script', sysId: sid(6) }, { table: 'sys_script', sysId: sid(7) }), false);
  assert.equal(pendingEditMatches(null, {}), false);
});

// ---- errors ---------------------------------------------------------------------------------------------------------------

test('errors are told apart: a table that cannot be read is skipped, a busy or expired instance is not blamed on the table', () => {
  const err = (message, extra = {}) => Object.assign(new Error(message), extra);
  assert.equal(classifyError(err('Your user is not allowed to do this (403): User Not Authorized.')), 'denied');
  assert.equal(classifyError(err('Table API query on "sys_hub_flow" failed (400): Invalid table sys_hub_flow')), 'missing');
  assert.equal(classifyError(err('x', { code: 'SESSION_EXPIRED' })), 'expired');
  assert.equal(classifyError(err('Table API query on "x" failed (503): the instance is busy. Wait a moment and retry.')), 'busy');
  assert.equal(classifyError(err('Failed to fetch')), 'other');
  assert.equal(classifyError(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'aborted');
  assert.equal(classifyError(null), 'other');
});

// ---- the search engine ----------------------------------------------------------------------------------------------------

/** A fake queryTable: records every call, answers from `rows[table]`, optionally held until released. */
function fakeQuery({ rows = {}, fail = {}, hold = false } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const pending = [];
  const fn = (table, query, fields, options) =>
    new Promise((resolve, reject) => {
      calls.push({ table, query, fields, options });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const finish = () => {
        inFlight -= 1;
        if (options.signal?.aborted) return reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        if (fail[table]) return reject(typeof fail[table] === 'function' ? fail[table]() : fail[table]);
        const list = typeof rows[table] === 'function' ? rows[table](query, options) : rows[table] || [];
        return resolve(list.slice(0, options.limit));
      };
      options.signal?.addEventListener('abort', () => {
        if (!pending.includes(finish)) return;
        pending.splice(pending.indexOf(finish), 1);
        finish();
      });
      if (hold) pending.push(finish);
      else setTimeout(finish, 1);
    });
  fn.calls = calls;
  fn.release = () => pending.splice(0).forEach((finish) => finish());
  fn.pendingCount = () => pending.length;
  fn.maxInFlight = () => maxInFlight;
  return fn;
}

const brRow = (name, extra = {}) => apiRow('br', BR_FIELDS(name, extra)).row;
const siRow = (name, extra = {}) => apiRow('si', { name, api_name: `global.${name}`, active: 'true', ...extra }).row;

test('the engine searches the named kinds, reads display values, and passes a signal', async () => {
  const query = fakeQuery({ rows: { sys_script: [brRow('Incident - closed notice')], sys_script_include: [siRow('IncidentUtils')] } });
  const engine = createGoToEngine({ query });
  const result = await engine.search({ term: 'incident', kinds: ['br', 'si'], mode: 'bare' });
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(query.calls.map((c) => c.table).sort(), ['sys_script', 'sys_script_include']);
  const call = query.calls.find((c) => c.table === 'sys_script');
  assert.equal(call.options.displayValue, true);
  assert.equal(call.options.limit, LIMITS.bare.first);
  assert.ok(call.options.signal && call.options.signal.aborted === false);
  assert.equal(call.query, 'nameLIKEincident^ORDERBYDESCsys_updated_on');
  assert.ok(call.fields.includes('sys_scope.scope') && call.fields.includes('collection'));
});

test('no request is made for text that is too short or unsafe', async () => {
  const query = fakeQuery();
  const engine = createGoToEngine({ query });
  assert.deepEqual((await engine.search({ term: 'in', kinds: ['br'], mode: 'bare' })).candidates, []);
  assert.deepEqual((await engine.search({ term: ' i ', kinds: ['br'], mode: 'kind' })).candidates, []);
  assert.deepEqual((await engine.search({ term: 'a^b', kinds: ['br'], mode: 'kind' })).candidates, []);
  assert.deepEqual((await engine.search({ term: 'javascript:x', kinds: ['br'], mode: 'kind' })).candidates, []);
  assert.equal(query.calls.length, 0);
  assert.equal((await engine.search({ term: 'in', kinds: ['br'], mode: 'kind' })).candidates.length, 0);
  assert.equal(query.calls.length, 1, 'two characters are enough once a kind was named');
});

test('results are cached per kind and term until reset, so retyping costs nothing', async () => {
  const query = fakeQuery({ rows: { sys_script: [brRow('Incident - closed notice')] } });
  const engine = createGoToEngine({ query });
  await engine.search({ term: 'closed', kinds: ['br'], mode: 'bare' });
  assert.equal(query.calls.length, 1);
  const again = await engine.search({ term: 'Closed ', kinds: ['br'], mode: 'bare' });
  assert.equal(query.calls.length, 1, 'same text, same kind: from the cache');
  assert.equal(again.candidates.length, 1);
  assert.deepEqual(again.meta.cached, ['br']);
  await engine.search({ term: 'closed', kinds: ['br', 'si'], mode: 'bare' });
  assert.equal(query.calls.length, 2, 'only the new kind is asked');
  await engine.search({ term: 'closed', kinds: ['br'], mode: 'kind' });
  assert.equal(query.calls.length, 3, 'a different mode uses different limits, so it is a different entry');
  engine.reset();
  await engine.search({ term: 'closed', kinds: ['br'], mode: 'bare' });
  assert.equal(query.calls.length, 4);
});

test('at most five requests are in flight at once, in the order of the kinds', async () => {
  const query = fakeQuery({ hold: true, rows: {} });
  const engine = createGoToEngine({ query });
  const kinds = ['si', 'br', 'cl', 'uia', 'acl', 'notif', 'flow', 'widget'];
  const done = engine.search({ term: 'closed', kinds, mode: 'bare', refine: false });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(query.pendingCount(), MAX_PARALLEL);
  assert.deepEqual(query.calls.map((c) => c.table), ['sys_script_include', 'sys_script', 'sys_script_client', 'sys_ui_action', 'sys_security_acl']);
  query.release();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(query.calls.length, 8, 'the rest start as slots free up');
  query.release();
  await done;
  assert.ok(query.maxInFlight() <= MAX_PARALLEL);
});

test('a newer search aborts the older one and its results never arrive', async () => {
  const query = fakeQuery({ hold: true, rows: { sys_script: [brRow('Incident - closed notice')] } });
  const engine = createGoToEngine({ query });
  const seen = [];
  const first = engine.search({ term: 'inc', kinds: ['br', 'si', 'cl'], mode: 'bare', refine: false, onProgress: (p) => seen.push(['first', p.candidates.length]) });
  await new Promise((r) => setTimeout(r, 5));
  const firstSignal = query.calls[0].options.signal;
  const second = engine.search({ term: 'incident', kinds: ['br'], mode: 'bare', refine: false, onProgress: (p) => seen.push(['second', p.candidates.length]) });
  assert.equal(firstSignal.aborted, true, 'the old request is aborted');
  await new Promise((r) => setTimeout(r, 5));
  query.release();
  assert.equal(await first, null, 'a stale search resolves to nothing');
  const result = await second;
  assert.equal(result.candidates.length, 1);
  assert.ok(seen.every(([who]) => who === 'second'), 'no progress from the stale search');
});

test('stale requests that never started are dropped, not sent', async () => {
  const query = fakeQuery({ hold: true });
  const engine = createGoToEngine({ query });
  const kinds = ['si', 'br', 'cl', 'uia', 'acl', 'notif', 'flow', 'widget'];
  const first = engine.search({ term: 'closed', kinds, mode: 'bare', refine: false });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(query.calls.length, MAX_PARALLEL);
  const second = engine.search({ term: 'closed x', kinds: ['br'], mode: 'bare', refine: false });
  await new Promise((r) => setTimeout(r, 5));
  query.release();
  await first;
  query.release();
  await second;
  assert.equal(query.calls.length, MAX_PARALLEL + 1, 'only the five that had started, plus the new search');
});

test('cancel() stops everything and nothing is painted afterwards', async () => {
  const query = fakeQuery({ hold: true, rows: { sys_script: [brRow('Incident - closed notice')] } });
  const engine = createGoToEngine({ query });
  let painted = 0;
  const run = engine.search({ term: 'closed', kinds: ['br'], mode: 'bare', onProgress: () => { painted += 1; } });
  await new Promise((r) => setTimeout(r, 5));
  engine.cancel();
  query.release();
  assert.equal(await run, null);
  assert.equal(painted, 0);
});

test('progress is reported as each kind answers', async () => {
  const query = fakeQuery({ rows: { sys_script: [brRow('Incident - closed notice')], sys_script_include: [siRow('IncidentUtils'), siRow('IncidentHelper')] } });
  const engine = createGoToEngine({ query });
  const counts = [];
  const result = await engine.search({ term: 'incident', kinds: ['br', 'si'], mode: 'bare', onProgress: (p) => counts.push(p.candidates.length) });
  assert.deepEqual(counts, [1, 3]);
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(result.meta.searched.sort(), ['br', 'si']);
});

test('a table that does not exist or cannot be read is skipped silently for the rest of the session', async () => {
  const query = fakeQuery({
    rows: { sys_script: [brRow('Incident - closed notice')] },
    fail: { sys_hub_flow: new Error('Table API query on "sys_hub_flow" failed (400): Invalid table sys_hub_flow'), sys_security_acl: new Error('Your user is not allowed to do this (403).') },
  });
  const engine = createGoToEngine({ query });
  const first = await engine.search({ term: 'closed', kinds: ['br', 'flow', 'acl'], mode: 'bare', refine: false });
  assert.equal(first.candidates.length, 1, 'the others still answer');
  assert.deepEqual(first.meta.unavailable.sort(), ['acl', 'flow']);
  assert.deepEqual(first.meta.failed, []);
  assert.deepEqual(engine.unavailableTables().sort(), ['sys_hub_flow', 'sys_security_acl']);
  const before = query.calls.length;
  engine.reset();
  const second = await engine.search({ term: 'closed', kinds: ['br', 'flow', 'acl'], mode: 'bare', refine: false });
  assert.equal(query.calls.length - before, 1, 'only the readable table is asked again');
  assert.deepEqual(second.meta.unavailable.sort(), ['acl', 'flow']);
  engine.forgetUnavailable();
  assert.equal(engine.isUnavailable('sys_hub_flow'), false);
});

test('a busy instance or a network error is not remembered against the table', async () => {
  let attempts = 0;
  const rows = [brRow('Incident - closed notice')];
  const engine = createGoToEngine({
    query: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Table API query on "sys_script" failed (503): the instance is busy. Wait a moment and retry.');
      if (attempts === 2) throw new TypeError('Failed to fetch');
      return rows;
    },
  });
  const busy = await engine.search({ term: 'closed', kinds: ['br'], mode: 'bare', refine: false });
  assert.deepEqual(busy.meta.failed, [{ kind: 'br', reason: 'busy' }]);
  // Each search uses other words the row holds (rows that do not hold the typed words are never kept, see answersTerm).
  const offline = await engine.search({ term: 'closed notice', kinds: ['br'], mode: 'bare', refine: false });
  assert.deepEqual(offline.meta.failed, [{ kind: 'br', reason: 'other' }]);
  assert.equal(engine.isUnavailable('sys_script'), false);
  const later = await engine.search({ term: 'incident closed', kinds: ['br'], mode: 'bare', refine: false });
  assert.equal(later.candidates.length, 1, 'the next search tries the table again');
  assert.deepEqual(later.meta.failed, []);
});

test('an expired session is reported once and the remaining requests are not sent', async () => {
  const expired = Object.assign(new Error('Your ServiceNow session has expired. Log in again, then retry.'), { code: 'SESSION_EXPIRED' });
  const query = fakeQuery({ fail: { sys_script_include: expired } });
  const engine = createGoToEngine({ query, concurrency: 1 });
  const result = await engine.search({ term: 'closed', kinds: ['si', 'br', 'cl', 'uia'], mode: 'bare', refine: false });
  assert.equal(result.meta.expired, true);
  assert.equal(query.calls.length, 1, 'the later kinds never went out');
  assert.equal(engine.unavailableTables().length, 0, 'an expired session says nothing about the tables');
});

test('a full first page is followed by a starts-with query, merged without duplicates', async () => {
  const full = Array.from({ length: LIMITS.bare.first }, (_, i) => siRow(`Zebra${i}Incident`));
  const exact = siRow('Incident');
  const query = fakeQuery({
    rows: { sys_script_include: (q) => (q.includes('STARTSWITH') ? [exact, full[0]] : full) },
  });
  const engine = createGoToEngine({ query });
  const result = await engine.search({ term: 'incident', kinds: ['si'], mode: 'bare' });
  assert.equal(query.calls.length, 2);
  assert.match(query.calls[1].query, /^nameSTARTSWITHincident\^ORapi_nameSTARTSWITHincident\^ORDERBYname$/);
  assert.equal(query.calls[1].options.limit, LIMITS.bare.starts);
  assert.equal(result.candidates.length, full.length + 1, 'the exact name was found; the duplicate was not added twice');
  const ranked = rankCandidates(result.candidates, 'incident');
  assert.equal(ranked[0].c.name, 'Incident');
});

test('a rare name tries the other kinds too, a common one does not', async () => {
  const rare = fakeQuery({ rows: { sys_script: [brRow('Approval rule')], sp_widget: [apiRow('widget', { name: 'Approval Card', id: 'approval-card' }).row] } });
  const engineA = createGoToEngine({ query: rare });
  const parsed = parseGoTo('approval');
  const first = await engineA.search({ term: 'approval', kinds: parsed.kinds, more: parsed.more, mode: 'bare', refine: false });
  assert.ok(first.candidates.length < MIN_ROWS + 1);
  assert.ok(rare.calls.some((c) => c.table === 'sp_widget'), 'the widget table was tried');
  assert.equal(rare.calls.length, BARE_KINDS + MORE_KINDS);
  assert.ok(first.candidates.some((c) => c.kind === 'widget'));

  const many = fakeQuery({ rows: { sys_script: [brRow('Approval 1'), brRow('Approval 2'), brRow('Approval 3')] } });
  const engineB = createGoToEngine({ query: many });
  await engineB.search({ term: 'approval', kinds: parsed.kinds, more: parsed.more, mode: 'bare', refine: false });
  assert.equal(many.calls.length, BARE_KINDS, 'enough rows: nothing more is asked');
  const named = fakeQuery({});
  await createGoToEngine({ query: named }).search({ term: 'approval', kinds: ['br'], more: parsed.more, mode: 'kind', refine: false });
  assert.equal(named.calls.length, 1, 'a named kind never widens');
});

test('a short first page needs no follow-up', async () => {
  const query = fakeQuery({ rows: { sys_script_include: [siRow('IncidentUtils')] } });
  const engine = createGoToEngine({ query });
  await engine.search({ term: 'incident', kinds: ['si'], mode: 'bare' });
  assert.equal(query.calls.length, 1);
});

test('rows without a usable sys_id are ignored', async () => {
  const query = fakeQuery({ rows: { sys_script: [{ sys_id: 'global', name: 'odd' }, brRow('Incident - closed notice')] } });
  const engine = createGoToEngine({ query });
  const result = await engine.search({ term: 'closed', kinds: ['br'], mode: 'bare' });
  assert.equal(result.candidates.length, 1);
});

// ---- list rows and notes ---------------------------------------------------------------------------------------------

const urlFor = (table, query) => `/${table}_list.do?sysparm_query=${encodeURIComponent(query)}`;
const noMeta = () => ({ unavailable: [], failed: [], expired: false });

test('a named kind gets a link to its list with the same filter; a kind that cannot be read gets none; bare text gets none', () => {
  const rows = listRowsFor(parseGoTo('br,si: closed'), noMeta(), urlFor);
  assert.deepEqual(rows.map((r) => r.title), ['Business Rules matching “closed”', 'Script Includes matching “closed”']);
  assert.equal(rows[0].url, '/sys_script_list.do?sysparm_query=nameLIKEclosed%5EORDERBYDESCsys_updated_on');
  assert.ok(rows.every((r) => r.score < 350 && !r.status));
  const skipped = listRowsFor(parseGoTo('br,si: closed'), { ...noMeta(), unavailable: ['si'] }, urlFor);
  assert.deepEqual(skipped.map((r) => r.id), ['goto.list.br']);
  assert.deepEqual(listRowsFor(parseGoTo('closed'), noMeta(), urlFor), []);
  const empty = listRowsFor(parseGoTo('acl:'), noMeta(), urlFor);
  assert.equal(empty[0].title, 'ACLs list');
  assert.equal(empty[0].url, '/sys_security_acl_list.do?sysparm_query=ORDERBYDESCsys_updated_on');
});

test('the list link of a named kind carries the escaped text, never a raw caret', () => {
  const parsed = { mode: 'kind', kinds: ['br'], term: 'a^b', denied: [] };
  const [row] = listRowsFor(parsed, noMeta(), (table, query) => query);
  assert.equal(row.url, 'nameLIKEa^^b^ORDERBYDESCsys_updated_on');
});

test('"nothing found" is said only when the kinds were really searched; "could not read" is said when they were not', () => {
  const kind = parseGoTo('br,si: closed');
  assert.deepEqual(noticeRowsFor(kind, noMeta(), false, 0).map((r) => r.title), ['No match for “closed”']);
  assert.match(noticeRowsFor(kind, noMeta(), false, 0)[0].hint, /business rules, script includes you can read/);
  assert.deepEqual(noticeRowsFor(kind, noMeta(), false, 3), [], 'rows are shown: no note');
  // One kind cannot be read: say so, and still say nothing matched in the other.
  const half = noticeRowsFor(kind, { ...noMeta(), unavailable: ['si'] }, false, 0);
  assert.deepEqual(half.map((r) => r.title), ['Script Includes cannot be read here', 'No match for “closed”']);
  assert.match(half[1].hint, /business rules you can read\./);
  // Both cannot be read: never "No match".
  const none = noticeRowsFor(kind, { ...noMeta(), unavailable: ['si', 'br'] }, false, 0);
  assert.deepEqual(none.map((r) => r.id), ['goto.status.unavailable.si', 'goto.status.unavailable.br']);
  assert.match(none[0].hint, /sys_script_include/);
});

test('notes for a failed request, a busy instance, an expired session, a hidden kind and a search still running', () => {
  const kind = parseGoTo('br: closed');
  assert.match(noticeRowsFor(kind, { ...noMeta(), failed: [{ kind: 'br', reason: 'busy' }] }, false, 0)[0].hint, /busy/);
  assert.match(noticeRowsFor(kind, { ...noMeta(), failed: [{ kind: 'br', reason: 'other' }] }, false, 0)[0].hint, /did not answer/);
  const expired = noticeRowsFor(kind, { ...noMeta(), expired: true }, false, 0);
  assert.deepEqual(expired.map((r) => r.title), ['Your ServiceNow session has expired']);
  const hidden = noticeRowsFor(parseGoTo('br: closed', { tier: 'user' }), noMeta(), false, 0);
  assert.equal(hidden[0].title, 'Business Rules are hidden for your roles');
  assert.deepEqual(noticeRowsFor(kind, noMeta(), true, 0).map((r) => r.title), ['Searching business rules…']);
  assert.deepEqual(noticeRowsFor(kind, noMeta(), true, 2), []);
});

test('a bare search stays quiet about tables it could not read, and speaks up only when everything failed', () => {
  const bare = parseGoTo('closed');
  assert.deepEqual(noticeRowsFor(bare, { ...noMeta(), unavailable: ['br', 'si'] }, false, 0), []);
  assert.deepEqual(noticeRowsFor(bare, noMeta(), false, 0), [], 'no "nothing found" row for a bare search');
  assert.equal(noticeRowsFor(bare, { ...noMeta(), failed: [{ kind: 'br', reason: 'other' }] }, false, 0)[0].title, 'Could not search the instance for names');
  assert.deepEqual(noticeRowsFor(bare, { ...noMeta(), failed: [{ kind: 'br', reason: 'other' }] }, false, 2), []);
  assert.equal(noticeRowsFor(bare, { ...noMeta(), expired: true }, false, 0)[0].title, 'Your ServiceNow session has expired');
});

test('a note is a status row: it does nothing, has no group badge, and sorts below every real match', () => {
  const row = statusRow('x', 'Title', 'Hint');
  assert.equal(row.status, true);
  assert.equal(row.group, '');
  assert.equal(typeof row.run, 'function');
  assert.equal(row.score, STATUS_SCORE);
  assert.ok(STATUS_SCORE < 480, 'below a contains match');
});

// ---- review fixes (2026-10-23): what a real instance does that the first version did not expect -------------------------

test('every column a kind searches is a name the palette can check the answer against', () => {
  KINDS.forEach((k) => {
    const shown = new Set([k.display, ...k.alias]);
    k.search.forEach((column) => assert.ok(shown.has(column), `${k.id} searches ${column} but never reads it back as a name`));
  });
});

test('a row only counts when it really holds every typed word, case and accents aside', () => {
  const rule = cand('br', BR_FIELDS('Incident - sync assignment group'));
  assert.equal(answersTerm(rule, 'incident sync'), true);
  assert.equal(answersTerm(rule, 'SYNC incident'), true, 'any order, any case: the query is an AND of LIKEs');
  assert.equal(answersTerm(rule, 'incident closed'), false);
  const user = cand('u', { name: 'Abel Tuter', user_name: 'abel.tuter', email: 'abel.tuter@example.com', active: 'true' });
  assert.equal(answersTerm(user, 'abel example'), true, 'the words may sit in different names (name and e-mail)');
  assert.equal(answersTerm(cand('si', { name: 'Helper', api_name: 'x_acme_hr.AjaxUtil', active: 'true' }), 'AjaxUtil'), true, 'humps, found in the API name');
  assert.equal(answersTerm(cand('widget', { name: 'Café menu', id: 'cafe-menu' }), 'café'), true);
  assert.equal(answersTerm(cand('br', BR_FIELDS('Café opening hours')), 'cafe'), true, 'accents folded as the instance LIKE does');
  assert.equal(answersTerm(cand('dict', { name: 'incident', element: 'state', column_label: 'State', active: 'true' }), 'incident.state'), true);
});

test('when the instance ignores the condition and answers with every row, none of those rows is shown', async () => {
  // ServiceNow drops a condition on a column it does not have; the answer is then the first rows of the table.
  const everything = [brRow('Approval rule'), brRow('Close stale incidents'), brRow('Set location from caller'), brRow('Incident - closed notice')];
  const query = fakeQuery({ rows: { sys_script: everything } });
  const engine = createGoToEngine({ query });
  const result = await engine.search({ term: 'closed', kinds: ['br'], mode: 'kind', refine: false });
  assert.deepEqual(result.candidates.map((c) => c.name), ['Incident - closed notice']);
  const none = await engine.search({ term: 'zzzz', kinds: ['br'], mode: 'kind', refine: false });
  assert.deepEqual(none.candidates, []);
  assert.deepEqual(noticeRowsFor(parseGoTo('br: zzzz'), none.meta, false, 0).map((r) => r.id), ['goto.status.none']);
});

test('a full page from the instance still asks for the names that start with the text, even if few rows matched', async () => {
  const full = [siRow('IncidentUtils'), ...Array.from({ length: LIMITS.bare.first - 1 }, (_, i) => siRow(`Unrelated${i}`))];
  const query = fakeQuery({ rows: { sys_script_include: (q) => (q.includes('STARTSWITH') ? [siRow('Incident')] : full) } });
  const result = await createGoToEngine({ query }).search({ term: 'incident', kinds: ['si'], mode: 'bare' });
  assert.equal(query.calls.length, 2, 'the page was full, whatever the client kept of it');
  assert.deepEqual(result.candidates.map((c) => c.name).sort(), ['Incident', 'IncidentUtils']);
});

test('an answer cut off by a newer keystroke is never cached as "nothing matched"', async () => {
  // A request aborted while its body was read used to come back as an empty list instead of an AbortError.
  let calls = 0;
  const rows = [brRow('Incident - closed notice')];
  let engine = null;
  const query = async (table, q, fields, options) => {
    calls += 1;
    if (calls === 1) {
      engine.cancel(); // the user typed on while this request was in flight
      return options.signal.aborted ? [] : rows;
    }
    return rows;
  };
  engine = createGoToEngine({ query });
  assert.equal(await engine.search({ term: 'closed', kinds: ['br'], mode: 'kind', refine: false }), null);
  const again = await engine.search({ term: 'closed', kinds: ['br'], mode: 'kind', refine: false });
  assert.equal(calls, 2, 'asked again, not served from the cache');
  assert.equal(again.candidates.length, 1);
  assert.deepEqual(again.meta.cached, []);
});

test('"javascript:" as any typed word is refused before a query, not reported as an instance failure', async () => {
  assert.equal(unsafeTermReason('closed javascript:gs.getUserID()'), 'script');
  const parsed = parseGoTo('closed javascript:gs.getUserID()');
  assert.deepEqual([parsed.mode, parsed.reason], ['none', 'script']);
  assert.equal(parseGoTo('br: notify JavaScript:alert(1)').mode, 'none');
  assert.equal(unsafeTermReason('javascript tips'), '', 'the word alone, without the colon, is an ordinary name');
  const query = fakeQuery();
  const result = await createGoToEngine({ query }).search({ term: 'closed javascript:x', kinds: ['br'], mode: 'kind' });
  assert.equal(query.calls.length, 0);
  assert.deepEqual(result.meta.failed, []);
});

test('a 404 is an empty answer (older releases say "No Record found"), never a reason to skip the table', async () => {
  const notFound = new Error('Table API query on "sys_script" failed (404): No Record found - Record does not exist or ACL restricts the record retrieval');
  assert.equal(classifyError(notFound), 'empty');
  assert.equal(classifyError(new Error('Table API query on "x" failed (400): Invalid table x')), 'missing');
  const query = fakeQuery({ fail: { sys_script: notFound } });
  const engine = createGoToEngine({ query });
  const result = await engine.search({ term: 'closed', kinds: ['br'], mode: 'kind', refine: false });
  assert.equal(engine.isUnavailable('sys_script'), false);
  assert.deepEqual([result.meta.unavailable, result.meta.failed, result.meta.searched], [[], [], ['br']]);
  assert.equal(noticeRowsFor(parseGoTo('br: closed'), result.meta, false, 0)[0].id, 'goto.status.none');
});

test('a marker a page script wrote can only ever name the record on screen, in the exact shape', () => {
  const now = 1_700_000_000_000;
  const good = { table: 'sys_script', sysId: sid(6).toUpperCase(), at: now };
  assert.deepEqual(parsePendingEdit(JSON.stringify(good), now), { table: 'sys_script', sysId: sid(6) });
  assert.equal(parsePendingEdit(JSON.stringify({ ...good, table: ['sys_script'] }), now), null, 'not a string');
  assert.equal(parsePendingEdit(JSON.stringify({ ...good, sysId: [sid(6)] }), now), null);
  assert.equal(parsePendingEdit(JSON.stringify([good]), now), null);
  assert.equal(parsePendingEdit(JSON.stringify({ ...good, at: String(now) }), now), null);
  assert.equal(parsePendingEdit(JSON.stringify({ ...good, at: now + 60_000 }), now), null, 'not from the future');
  assert.equal(parsePendingEdit(JSON.stringify({ ...good, pad: 'x'.repeat(300) }), now), null, 'nothing long is parsed');
  assert.equal(parsePendingEdit(null, now), null);
  const marker = parsePendingEdit(JSON.stringify(good), now);
  assert.equal(pendingEditMatches(marker, { table: 'sys_script', sysId: sid(6) }), true);
  assert.equal(pendingEditMatches(marker, { table: 'sys_script_include', sysId: sid(6) }), false, 'the same sys_id on another table is not it');
  assert.equal(pendingEditMatches(marker, { sysId: sid(6) }), false, 'a page whose table is unknown is not it');
});

test('from bare text a name never outranks the incident list: scores stay under the table navigation, in order', () => {
  // src/content/commands.js gives "<Table> list" 850-900 and "New <Table>" 830-880; a record number or sys_id 1000.
  assert.ok(BARE_SCORE_CAP < 830, 'below the lowest table navigation row');
  assert.ok(BARE_SCORE_CAP > 740, 'above the best loose match on a command title');
  const acl = cand('acl', { name: 'incident', operation: 'read', type: 'record', active: 'true', sys_created_by: 'maria.dev', sys_updated_by: 'maria.dev' });
  const rule = cand('br', BR_FIELDS('Incident - debug logging'));
  const ranked = rankCandidates([rule, acl], 'incident', { ctx: { table: 'incident' } });
  assert.equal(ranked[0].c, acl);
  assert.ok(toRow(ranked[0]).score > 900, 'uncapped (after a kind prefix) the exact name is on top');
  const capped = ranked.map((entry) => toRow(entry, { cap: BARE_SCORE_CAP }).score);
  assert.ok(capped.every((score) => score <= BARE_SCORE_CAP));
  assert.deepEqual([...capped].sort((a, b) => b - a), capped, 'the order of the names is kept');
});

test('a name cannot reorder itself on screen: bidi override controls are dropped, right-to-left text is kept', () => {
  const spoof = cand('widget', { name: 'Hostile \u202Egpj.exe\u202C override', id: 'x\u2067y\u2069' });
  assert.equal(spoof.name, 'Hostile gpj.exe override');
  assert.deepEqual(spoof.aliases, ['xy']);
  const arabic = cand('widget', { name: '\u0639\u0646\u0635\u0631 \u0648\u0627\u062C\u0647\u0629', id: 'arabic' });
  assert.equal(arabic.name, '\u0639\u0646\u0635\u0631 \u0648\u0627\u062C\u0647\u0629');
  const markup = cand('widget', { name: '<img src=x onerror=alert(1)>', id: 'markup' });
  assert.equal(toRow(rankCandidates([markup], 'img')[0]).title, '<img src=x onerror=alert(1)>', 'kept as text; the palette sets it with textContent');
});

test('notes name the kinds the way a sentence would, acronyms kept', () => {
  const titles = (input, meta = noMeta(), pending = false) => noticeRowsFor(parseGoTo(input), meta, pending, 0).map((r) => `${r.title} / ${r.hint}`);
  assert.match(titles('acl,uipg: closed', noMeta(), true)[0], /^Searching ACLs, UI pages…/);
  assert.match(titles('sra: x1')[0], /Searched scripted REST APIs you can read/);
  assert.match(titles('br: x1', { ...noMeta(), failed: [{ kind: 'br', reason: 'other' }] })[0], /^Could not search business rules/);
});

// queryTable (src/content/tableApi.js) as the engine uses it: an AbortSignal, and what an abort looks like.
function installPageStub() {
  const listeners = new Set();
  globalThis.document = {
    documentElement: { hasAttribute: () => true, setAttribute() {} },
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    dispatchEvent: (event) => {
      const { id } = event.detail;
      queueMicrotask(() => listeners.forEach((fn) => fn({ detail: { id, ok: true, result: 'a'.repeat(32) } })));
      return true;
    },
    getElementById: () => null,
    querySelector: () => null,
    scripts: [],
  };
}

async function withFetch(fetchImpl, fn) {
  installPageStub();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
const fakeResponse = (status, text, headers = {}) => ({ ok: status >= 200 && status < 300, status, redirected: false, url: '', headers: new Headers(headers), text });

test('queryTable passes the signal, and an abort while the body is read is an AbortError, not an empty answer', async () => {
  const { queryTable } = require('../src/content/tableApi.js');
  const inits = [];
  await withFetch(
    async (url, init) => {
      inits.push(init);
      return fakeResponse(200, async () => {
        throw abortError();
      });
    },
    async () => {
      const controller = new AbortController();
      await assert.rejects(queryTable('sys_script', 'nameLIKEx', ['sys_id'], { signal: controller.signal }), (err) => classifyError(err) === 'aborted');
      assert.equal(inits[0].signal, controller.signal);
    }
  );
  // Every other caller passes no signal: nothing is added to fetch, and a body that cannot be read is still an empty answer.
  await withFetch(
    async (url, init) => {
      inits.push(init);
      return fakeResponse(200, async () => {
        throw new TypeError('network error');
      });
    },
    async () => {
      assert.deepEqual(await queryTable('sys_script', 'nameLIKEx', ['sys_id']), []);
      assert.equal('signal' in inits[1], false);
    }
  );
});

test('queryTable stops waiting to retry a busy instance as soon as the search is cancelled', async () => {
  const { queryTable } = require('../src/content/tableApi.js');
  let calls = 0;
  await withFetch(
    async (url, init) => {
      calls += 1;
      if (init.signal?.aborted) throw abortError();
      return fakeResponse(503, async () => '', { 'retry-after': '5' });
    },
    async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = queryTable('sys_script', 'nameLIKEx', ['sys_id'], { signal: controller.signal });
      setTimeout(() => controller.abort(), 30);
      await assert.rejects(pending, (err) => err.name === 'AbortError');
      assert.ok(Date.now() - started < 1000, 'did not sit out the 5 second Retry-After');
      assert.equal(calls, 2);
    }
  );
});
