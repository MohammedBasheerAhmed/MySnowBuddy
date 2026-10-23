const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/lib/properties.js');

const ID = '6816f79cc0a8016401c5a33be04be441';
const ID2 = '287ebd7da9fe198100f92cc8d1d2154e';
const row = (extra = {}) => ({ sys_id: ID, name: 'x_acme.sync.timeout', type: 'integer', value: '30', description: 'Seconds to wait.', ...extra });
const prop = (extra = {}) => P.toProperty(row(extra));

// --- Secrets ---------------------------------------------------------------------------------------------------------

test('names that say password, secret, token, key or credential are secret; harmless "key" words are not', () => {
  ['glide.ldap.bind.password', 'x_acme.api_key', 'x_acme.apikey', 'x_acme.oauth.client_secret', 'glide.sso.token', 'x_acme.encryption.key', 'x_acme.private_key', 'x_acme.credential_id', 'GLIDE.USER.PASSWORD.MIN'].forEach((n) =>
    assert.equal(P.nameLooksSecret(n), true, n)
  );
  ['glide.ui.keyboard_shortcuts', 'x_acme.search.keywords', 'glide.ui.session_timeout', 'glide.email.smtp.active', 'x_acme.hotkey.enabled', 'glide.servlet.uri'].forEach((n) => assert.equal(P.nameLooksSecret(n), false, n));
});

test('a password-type property is secret whatever its name', () => {
  assert.match(P.secretReason({ name: 'x_acme.bind', type: 'password2', value: 'abc' }), /password-type/);
  assert.match(P.secretReason({ name: 'x_acme.bind', type: 'Password', value: 'abc' }), /password-type/);
});

test('a value that holds a credential is secret even under an innocent name', () => {
  assert.match(P.secretReason({ name: 'x_acme.endpoint', type: 'string', value: 'https://svc:hunter2@host.example/api' }), /credential/);
  assert.match(P.secretReason({ name: 'x_acme.header', type: 'string', value: 'Bearer abcdefghijklmnop1234567890' }), /credential/);
  assert.equal(P.secretReason({ name: 'x_acme.endpoint', type: 'string', value: 'https://hr.acme.example/api/v2' }), '');
});

test('ordinary values are not mistaken for secrets', () => {
  ['true', '30', 'yyyy-MM-dd', 'Europe/London', 'admin,itil,sn_incident_write', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', 'user@example.com', '{"a":1,"b":[1,2]}', 'smtp.example.com'].forEach((v) =>
    assert.equal(P.secretReason({ name: 'x_acme.value', type: 'string', value: v }), '', v)
  );
});

test('the value of a hidden property is dropped when it is read, so nothing downstream can show or copy it', () => {
  const secret = prop({ name: 'x_acme.bind.password', type: 'password2', value: 'hunter2-hunter2' });
  assert.equal(secret.hidden, true);
  assert.equal(secret.value, '');
  assert.equal(P.valueText(secret), 'hidden');
  assert.equal(secret.editor.kind, 'none');
  assert.equal(JSON.stringify(secret).includes('hunter2'), false);
  const byName = prop({ name: 'x_acme.integration.api_key', type: 'string', value: 'AKIAFAKEKEY0000' });
  assert.equal(byName.hidden, true);
  assert.equal(JSON.stringify(byName).includes('AKIA'), false);
});

test('a hidden property cannot be written through the validator', () => {
  const secret = prop({ name: 'x_acme.token', type: 'string', value: 'abc' });
  const checked = P.validateValue(secret, 'new');
  assert.equal(checked.ok, false);
  assert.match(checked.error, /never/);
});

test('hidden properties never match a search on their value (no probing a secret)', () => {
  const secret = prop({ name: 'x_acme.bind.password', type: 'password2', value: 'hunter2-hunter2', description: 'Bind account' });
  assert.equal(P.rankProperties([secret], 'hunter2').length, 0);
  assert.equal(P.rankProperties([secret], 'bind account').length, 1);
});

// --- Typing and editing ---------------------------------------------------------------------------------------------

test('type names reduce to the kinds the editor knows', () => {
  assert.equal(P.typeKind('boolean'), 'boolean');
  assert.equal(P.typeKind('integer'), 'integer');
  assert.equal(P.typeKind('choicelist'), 'choice');
  assert.equal(P.typeKind('color'), 'color');
  assert.equal(P.typeKind('password2'), 'password');
  assert.equal(P.typeKind('uploaded_image'), 'image');
  assert.equal(P.typeKind(''), 'string');
  assert.equal(P.typeKind('short string'), 'string');
});

test('choices are split on commas and lines, trimmed and de-duplicated', () => {
  assert.deepEqual(P.parseChoices('debug, info ,warn\nerror,info,'), ['debug', 'info', 'warn', 'error']);
  assert.deepEqual(P.parseChoices(''), []);
});

test('the editor follows the type: switch, number, choice list, text, long text, none', () => {
  assert.equal(prop({ type: 'boolean', value: 'true' }).editor.kind, 'toggle');
  assert.equal(prop({ type: 'integer', value: '30' }).editor.kind, 'number');
  const choice = prop({ type: 'choicelist', value: 'info', choices: 'debug,info,warn' });
  assert.equal(choice.editor.kind, 'select');
  assert.deepEqual(choice.editor.options, ['debug', 'info', 'warn']);
  assert.equal(prop({ type: 'string', value: 'acme' }).editor.kind, 'text');
  assert.equal(prop({ type: 'string', value: 'a\nb' }).editor.kind, 'textarea');
  assert.equal(prop({ type: 'string', value: 'x'.repeat(150) }).editor.kind, 'textarea');
  assert.equal(prop({ type: 'image', value: 'abc' }).editor.kind, 'none');
  assert.equal(prop({ sys_id: '' }).editor.kind, 'none');
});

test('a string property holding exactly true or false is offered as a switch, and says so', () => {
  const p = prop({ type: '', value: 'true' });
  assert.equal(p.editor.kind, 'toggle');
  assert.equal(p.editor.inferred, true);
  assert.equal(prop({ type: 'boolean', value: 'true' }).editor.inferred, false);
  assert.equal(prop({ type: '', value: 'TRUE-ish' }).editor.kind, 'text');
});

test('a choice list with no readable choices falls back to text', () => {
  assert.equal(prop({ type: 'choicelist', value: 'a', choices: '' }).editor.kind, 'text');
});

test('values are checked against the type before anything is asked', () => {
  const int = prop({ type: 'integer', value: '30' });
  assert.deepEqual(P.validateValue(int, ' 45 '), { ok: true, value: '45' });
  assert.deepEqual(P.validateValue(int, '-5'), { ok: true, value: '-5' });
  assert.equal(P.validateValue(int, '3.5').ok, false);
  assert.equal(P.validateValue(int, 'abc').ok, false);
  assert.equal(P.validateValue(int, '').ok, false);
  assert.equal(P.validateValue(int, '30').unchanged, true);

  const bool = prop({ type: 'boolean', value: 'true' });
  assert.equal(P.validateValue(bool, 'false').ok, true);
  assert.equal(P.validateValue(bool, 'yes').ok, false);

  const choice = prop({ type: 'choicelist', value: 'info', choices: 'debug,info,warn' });
  assert.equal(P.validateValue(choice, 'warn').ok, true);
  assert.equal(P.validateValue(choice, 'chatty').ok, false);

  const text = prop({ type: 'string', value: 'acme' });
  assert.deepEqual(P.validateValue(text, ' beta '), { ok: true, value: ' beta ' }); // text keeps its spaces
  assert.equal(P.validateValue(text, 'a [REDACTED] b').ok, false);
  assert.equal(P.validateValue(text, 'acme').unchanged, true);
  // Clearing a text value is allowed.
  assert.deepEqual(P.validateValue(text, ''), { ok: true, value: '' });
});

test('a value that looks like a credential is never written: it would land in the audit log and then be hidden', () => {
  const text = prop({ type: 'string', value: 'https://hr.acme.example/api' });
  const url = P.validateValue(text, 'https://svc:hunter2@hr.acme.example/api');
  assert.equal(url.ok, false);
  assert.match(url.error, /never writes secrets/);
  assert.equal(P.validateValue(text, 'Bearer abcdefghijklmnop1234567890').ok, false);
  assert.equal(P.validateValue(text, 'AKIAFAKEKEY0000EXAMP').ok, false);
  assert.equal(P.validateValue(text, 'https://hr2.acme.example/api').ok, true, 'an ordinary value is fine');
});

test('a guarded instance is locked until its name is typed; a dev instance is not; an unknown name never unlocks', () => {
  const prod = { host: 'acmeprod.service-now.com', instance: 'acmeprod', env: 'prod', guarded: true };
  assert.deepEqual(P.writeUnlock(prod, ''), { needed: true, instance: 'acmeprod', ok: false });
  assert.equal(P.writeUnlock(prod, 'acmepro').ok, false);
  assert.equal(P.writeUnlock(prod, ' AcmeProd ').ok, true, 'case and spaces do not matter');
  assert.equal(P.writeUnlock(prod, 'acmeprod.service-now.com').ok, false, 'the instance name, not the host');
  assert.equal(P.writeUnlock({ host: 'localhost', instance: 'localhost', env: 'unknown', guarded: true }, 'localhost').ok, true);
  assert.deepEqual(P.writeUnlock({ host: 'dev1.service-now.com', instance: 'dev1', env: 'dev', guarded: false }, ''), { needed: false, instance: 'dev1', ok: true });
  assert.equal(P.writeUnlock({ host: 'x', instance: '', guarded: true }, '').ok, false, 'no name to type: stays locked');
  assert.equal(P.writeUnlock(null, 'anything').ok, false, 'no guard read yet: locked');
});

test('a current value that is not in the choice list can stay, but cannot be re-picked as new', () => {
  const choice = prop({ type: 'choicelist', value: 'legacy', choices: 'debug,info' });
  assert.equal(P.validateValue(choice, 'info').ok, true);
  assert.equal(P.validateValue(choice, 'legacy').unchanged, true);
});

test('toProperty reads both plain rows and display-value rows', () => {
  const plain = P.toProperty({ sys_id: ID, name: 'a.b', value: '1', type: 'integer', sys_scope: 'global' });
  assert.equal(plain.scope, 'global');
  const rich = P.toProperty({
    sys_id: { value: ID, display_value: ID },
    name: { value: 'x_acme.a', display_value: 'x_acme.a' },
    value: { value: '5', display_value: '5' },
    type: { value: 'integer', display_value: 'Integer' },
    description: { value: 'Five', display_value: 'Five' },
    sys_scope: { value: ID2, display_value: 'Acme HR' },
    'sys_scope.scope': { value: 'x_acme_hr', display_value: 'x_acme_hr' },
    is_private: { value: 'true', display_value: 'true' },
    sys_updated_by: { value: 'maria.dev', display_value: 'Maria Dev' },
  });
  assert.equal(rich.name, 'x_acme.a');
  assert.equal(rich.typeLabel, 'Integer');
  assert.equal(rich.typeKind, 'integer');
  assert.equal(rich.scope, 'x_acme_hr');
  assert.equal(rich.scopeName, 'Acme HR');
  assert.equal(rich.isPrivate, true);
  assert.equal(rich.updatedBy, 'maria.dev');
});

test('a value the instance did not return is "unreadable", never "empty", and cannot be edited', () => {
  const p = P.toProperty({ sys_id: ID, name: 'x_acme.a', type: 'string' });
  assert.equal(p.unreadable, true);
  assert.equal(p.empty, false);
  assert.equal(P.valueText(p), 'unreadable');
  assert.equal(p.editor.kind, 'none');
  assert.match(p.editor.reason, /could not be read/);
  assert.equal(P.valueText(P.toProperty({ sys_id: ID, name: 'x_acme.a', type: 'string', value: '' })), '(empty)');
});

test('a missing is_private column is "unknown", not "false"', () => {
  assert.equal(P.toProperty({ sys_id: ID, name: 'a.b', value: '1' }).isPrivate, null);
});

test('the record address holds the sys_id only', () => {
  assert.equal(P.propertyPath(ID), `/sys_properties.do?sys_id=${ID}`);
  assert.equal(P.propertyPath('x^y'), '');
  assert.equal(P.propertyPath(''), '');
});

// --- Finding ----------------------------------------------------------------------------------------------------------

test('search words: up to four, no query separators', () => {
  assert.deepEqual(P.searchTokens('  glide.ui   timeout '), ['glide.ui', 'timeout']);
  assert.deepEqual(P.searchTokens('a^ORactive=true'), ['a', 'ORactive=true']);
  assert.equal(P.searchTokens('a b c d e f').length, 4);
});

test('the name search and the wide search are built from the words; the description is searched only when it exists', () => {
  const q = P.searchQueries('glide.ui timeout', new Set(['name', 'value', 'description']));
  assert.equal(q.name, 'nameLIKEglide.ui^nameLIKEtimeout^ORDERBYname');
  assert.equal(q.wide, 'nameLIKEglide.ui^ORdescriptionLIKEglide.ui^ORvalueLIKEglide.ui^nameLIKEtimeout^ORdescriptionLIKEtimeout^ORvalueLIKEtimeout^ORDERBYname');
  const noDesc = P.searchQueries('timeout', new Set(['name', 'value']));
  assert.equal(noDesc.wide, 'nameLIKEtimeout^ORvalueLIKEtimeout^ORDERBYname');
  assert.equal(noDesc.wide.includes('description'), false);
});

test('empty, one-character and script-starting searches are refused', () => {
  assert.throws(() => P.searchQueries('   '), /Type part of a property/);
  assert.throws(() => P.searchQueries('a'), /at least two/);
  assert.throws(() => P.searchQueries('javascript:alert(1)'), /javascript/);
  // A caret cannot break out of the condition.
  assert.equal(P.searchQueries('abc^name=x').wide.includes('^name=x'), false);
});

test('a property name is told from words', () => {
  assert.equal(P.looksLikePropertyName('glide.ui.session_timeout'), true);
  assert.equal(P.looksLikePropertyName('x_acme_hr'), true);
  assert.equal(P.looksLikePropertyName('timeout'), false);
  assert.equal(P.looksLikePropertyName('session timeout'), false);
  assert.equal(P.looksLikePropertyName('a.b'), false);
});

const catalog = () =>
  [
    ['glide.ui.session_timeout', 'Seconds of inactivity before logout.', '1800'],
    ['glide.ui.session_timeout.warning', 'Warn before the session ends.', '60'],
    ['x_acme.sync.timeout_seconds', 'Wait for the HR system.', '30'],
    ['x_acme.http.retry', 'Retry after a timeout of the partner.', '3'],
    ['x_acme.sync.mode', 'How the sync runs.', 'timeout-safe'],
    ['glide.ui.escape_text', 'Escape text.', 'true'],
  ].map(([name, description, value]) => prop({ sys_id: ID, name, description, value, type: 'string' }));

test('ranking: exact name, then names starting with it, then names containing it, then description, then value', () => {
  const ranked = P.rankProperties(catalog(), 'glide.ui.session_timeout');
  assert.equal(ranked[0].name, 'glide.ui.session_timeout');
  assert.equal(ranked[1].name, 'glide.ui.session_timeout.warning');

  const byWord = P.rankProperties(catalog(), 'timeout');
  assert.deepEqual(
    byWord.map((p) => [p.name, p.matchedIn]),
    [
      ['glide.ui.session_timeout', 'name'],
      ['x_acme.sync.timeout_seconds', 'name'],
      ['glide.ui.session_timeout.warning', 'name'],
      ['x_acme.http.retry', 'description'],
      ['x_acme.sync.mode', 'value'],
    ]
  );
});

test('ranking: every word has to match somewhere; the rest are dropped', () => {
  const ranked = P.rankProperties(catalog(), 'sync timeout');
  assert.deepEqual(ranked.map((p) => p.name), ['x_acme.sync.timeout_seconds', 'x_acme.sync.mode']);
  assert.equal(P.rankProperties(catalog(), 'nothing-like-this').length, 0);
});

test('ranking: a shorter name beats a longer one of the same kind, ties go alphabetical', () => {
  const ranked = P.rankProperties([prop({ name: 'a.timeout.long_name_here' }), prop({ name: 'a.timeout.x' })], 'timeout');
  assert.equal(ranked[0].name, 'a.timeout.x');
});

test('the match is marked in the text, overlapping words merged, case ignored', () => {
  assert.deepEqual(P.highlightParts('glide.ui.Session_timeout', 'session time'), [
    { text: 'glide.ui.', hit: false },
    { text: 'Session', hit: true },
    { text: '_', hit: false },
    { text: 'time', hit: true },
    { text: 'out', hit: false },
  ]);
  assert.deepEqual(P.highlightParts('abcabc', 'abc bca'), [{ text: 'abcabc', hit: true }]);
  assert.deepEqual(P.highlightParts('abc', ''), [{ text: 'abc', hit: false }]);
  assert.deepEqual(P.highlightParts('', 'x'), [{ text: '', hit: false }]);
});

test('the result headline says how many, and when it is cut', () => {
  assert.equal(P.resultsHeadline({ query: 'zzz', shown: 0, total: 0, capped: false }), 'No property matches "zzz".');
  assert.equal(P.resultsHeadline({ query: 'timeout', shown: 1, total: 1, capped: false }), '1 property for "timeout"');
  assert.match(P.resultsHeadline({ query: 'glide', shown: 100, total: 342, capped: true }), /best 100 of 342\. Add another word/);
});

// --- Who reads it -----------------------------------------------------------------------------------------------------

const NAME = 'x_acme_hr.sync.timeout_seconds';
const kinds = (source, name = NAME) => P.usageLines(source, name).lines.map((l) => [l.line, l.kind]);

test('gs.getProperty is a read, with the default it passes', () => {
  const src = `var t = parseInt(gs.getProperty('${NAME}', '30'), 10);`;
  const { lines } = P.usageLines(src, NAME);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'read');
  assert.equal(lines[0].arg, "'30'");
});

test('double quotes, spaces and GlideSystem are all reads', () => {
  assert.deepEqual(kinds(`x = gs.getProperty( "${NAME}" );`), [[1, 'read']]);
  assert.deepEqual(kinds(`x = GlideSystem.getProperty('${NAME}');`), [[1, 'read']]);
  assert.deepEqual(kinds(`x = gs . getProperty ( '${NAME}' );`), [[1, 'read']]);
  assert.deepEqual(kinds(`x = GlideProperties.get('${NAME}', 5);`), [[1, 'read']]);
});

test('gs.setProperty is a write, with the value it sets', () => {
  const { lines } = P.usageLines(`gs.setProperty('${NAME}', '60');`, NAME);
  assert.equal(lines[0].kind, 'write');
  assert.equal(lines[0].arg, "'60'");
  assert.deepEqual(kinds(`GlideProperties.set('${NAME}', 'x');`), [[1, 'write']]);
});

test('a line comment is not a use', () => {
  const src = `// gs.getProperty('${NAME}')\nvar a = 1;`;
  assert.deepEqual(P.usageLines(src, NAME), { lines: [], inComments: 1 });
});

test('a trailing comment is skipped but code before it on the line counts', () => {
  const src = `var t = gs.getProperty('${NAME}'); // was '${NAME}' for a while`;
  const out = P.usageLines(src, NAME);
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].kind, 'read');
  assert.equal(out.inComments, 1);
});

test('block comments and JSDoc are not uses, however many lines they span', () => {
  const src = `/**\n * Reads ${NAME}\n * with gs.getProperty('${NAME}', '60')\n */\nfunction a() {}\n/* gs.setProperty('${NAME}', '1'); */`;
  const out = P.usageLines(src, NAME);
  assert.equal(out.lines.length, 0);
  assert.equal(out.inComments, 3);
});

test('a // inside a string or a URL does not start a comment', () => {
  const src = `var u = 'https://example.com/a'; var t = gs.getProperty('${NAME}');`;
  assert.deepEqual(kinds(src), [[1, 'read']]);
  assert.deepEqual(kinds(`var s = "//"; gs.setProperty('${NAME}', '1');`), [[1, 'write']]);
});

test('a different property that only starts the same way is not a hit', () => {
  assert.deepEqual(kinds(`gs.getProperty('${NAME}_legacy', '1');`), []);
  assert.deepEqual(kinds(`gs.getProperty('${NAME}.override');`), []);
  assert.deepEqual(kinds(`gs.getProperty('other.${NAME}');`), []);
  assert.deepEqual(kinds(`gs.getProperty('${NAME}2');`), []);
});

test('a log line or a comparison that names the property is a mention, not a read', () => {
  assert.deepEqual(kinds(`gs.info('limit is ${NAME}');`), [[1, 'mention']]);
  assert.deepEqual(kinds(`if (gr.name == '${NAME}') { found = true; }`), [[1, 'mention']]);
  assert.deepEqual(kinds(`var v = current.getValue('${NAME}');`), [[1, 'mention']]);
});

test('another object with a getProperty method is not gs', () => {
  assert.deepEqual(kinds(`var v = mygs.getProperty('${NAME}');`), [[1, 'mention']]);
  assert.deepEqual(kinds(`var v = bag.getProperty('${NAME}');`), [[1, 'mention']]);
  assert.deepEqual(kinds(`gs.getUserName('${NAME}');`), [[1, 'mention']]);
});

test('a name kept in a variable is followed to the call that uses it', () => {
  const src = `var KEY = '${NAME}';\nvar value = gs.getProperty(KEY, '30');`;
  const { lines } = P.usageLines(src, NAME);
  assert.deepEqual(lines.map((l) => [l.line, l.kind, l.via]), [[1, 'read', 'KEY']]);
  const set = `var KEY = '${NAME}';\ngs.setProperty(KEY, '5');`;
  assert.equal(P.usageLines(set, NAME).lines[0].kind, 'write');
  const member = `var C = { TIMEOUT: '${NAME}' };\nvar v = gs.getProperty(C.TIMEOUT);`;
  assert.equal(P.usageLines(member, NAME).lines[0].via, 'TIMEOUT');
});

test('a name kept in a variable that is never passed to a property call stays a mention', () => {
  const src = `var KEY = '${NAME}';\nlog(KEY);`;
  assert.deepEqual(kinds(src), [[1, 'mention']]);
});

test('capitalisation that differs is flagged', () => {
  const { lines } = P.usageLines(`gs.getProperty('X_ACME_HR.sync.timeout_seconds');`, NAME);
  assert.equal(lines[0].kind, 'read');
  assert.equal(lines[0].caseDiffers, true);
});

test('Jelly in a UI page: ${gs.getProperty()} is a read, the same text in an XML comment is not', () => {
  const html = `<j:jelly>\n  <!-- \${gs.getProperty('${NAME}')} -->\n  <p>\${gs.getProperty('${NAME}')} seconds</p>\n</j:jelly>`;
  const out = P.usageLines(html, NAME);
  assert.deepEqual(out.lines.map((l) => [l.line, l.kind]), [[3, 'read']]);
  assert.equal(out.inComments, 1);
});

test('line numbers count from 1 and one line is reported once', () => {
  const src = `a();\nb();\nvar x = gs.getProperty('${NAME}') + gs.getProperty('${NAME}');`;
  assert.deepEqual(kinds(src), [[3, 'read']]);
});

test('an odd name or an empty script gives nothing', () => {
  assert.deepEqual(P.usageLines('', NAME), { lines: [], inComments: 0 });
  assert.deepEqual(P.usageLines('x', ''), { lines: [], inComments: 0 });
  assert.deepEqual(P.usageLines('x', 'a b ^ c'), { lines: [], inComments: 0 });
});

test('a lone apostrophe in text cannot swallow the rest of the script', () => {
  const src = `// don't touch\nvar a = "it's";\nvar t = gs.getProperty('${NAME}');`;
  assert.deepEqual(kinds(src), [[3, 'read']]);
});

test('a secret property: the default a read passes and the value a script sets are never shown, nor other literals on the line', () => {
  const SECRET = 'x_acme_hr.directory.bind';
  const src = `var who = 'svc_hr'; var pw = gs.getProperty('${SECRET}', 'Fallback-Pa55-b7d2');\ngs.setProperty('${SECRET}', 'NewPa55word9');\nvar KEY = '${SECRET}';\nvar x = gs.getProperty(KEY, 'hunter2hunter2');`;
  const out = P.usageLines(src, SECRET, { secret: true });
  assert.deepEqual(out.lines.map((l) => [l.line, l.kind]), [[1, 'read'], [2, 'write'], [3, 'read']]);
  out.lines.forEach((l) => assert.equal(l.arg, undefined, 'no default, no new value'));
  const text = JSON.stringify(out);
  ['Fallback-Pa55', 'NewPa55word9', 'svc_hr', 'hunter2'].forEach((s) => assert.equal(text.includes(s), false, s));
  assert.match(out.lines[0].text, /gs\.getProperty\('x_acme_hr\.directory\.bind' …$/);
  assert.match(out.lines[0].text, /var who = '\*\*\*'/);
  // The same script for an ordinary property keeps the default, which is what a developer wants to see.
  const plain = P.usageLines(`var t = gs.getProperty('x_acme.timeout', '30');`, 'x_acme.timeout');
  assert.equal(plain.lines[0].arg, "'30'");
  assert.match(plain.lines[0].text, /'30'/);
});

test('every usage line goes through the redactor, secret property or not', () => {
  const src = `var t = gs.getProperty('x_acme.endpoint', 'https://svc:hunter2@hr.example/api'); var k = 'AKIAFAKEKEY0000EXAMP';`;
  const { lines } = P.usageLines(src, 'x_acme.endpoint');
  assert.equal(JSON.stringify(lines).includes('hunter2'), false);
  assert.equal(JSON.stringify(lines).includes('AKIAFAKEKEY0000EXAMP'), false);
  assert.equal(lines[0].kind, 'read');
});

test('a match deep in a minified one-line script is shown around the match, not cut off before it', () => {
  const src = `${'var a=1;'.repeat(400)}var t=gs.getProperty('x_acme.timeout','30');${'var b=2;'.repeat(400)}`;
  const { lines } = P.usageLines(src, 'x_acme.timeout');
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^… .*gs\.getProperty\('x_acme\.timeout'/);
  assert.ok(lines[0].text.length <= 200);
  assert.equal(P.maskSecretLine("a('x.k', 'v')", 'x.k'), "a('x.k' …");
});

test('hits are classified per script: the strongest use wins, comment-only scripts are counted and left out', () => {
  const results = [
    { table: 'sys_script', label: 'Business Rule', sysId: 'a', name: 'B', field: 'script', source: `gs.info('${NAME}');\nvar t = gs.getProperty('${NAME}');`, url: '/a' },
    { table: 'sys_script_include', label: 'Script Include', sysId: 'b', name: 'A', field: 'script', source: `gs.setProperty('${NAME}', '1');`, url: '/b' },
    { table: 'sys_script', label: 'Business Rule', sysId: 'c', name: 'C', field: 'script', source: `// ${NAME}`, url: '/c' },
    { table: 'sys_script', label: 'Business Rule', sysId: 'd', name: 'D', field: 'script', source: `gs.info('${NAME}');`, url: '/d' },
    { table: 'sys_script', label: 'Business Rule', sysId: 'e', name: 'E', field: 'script', source: `gs.getProperty('${NAME}_legacy');`, url: '/e' },
  ];
  const { hits, commentOnly } = P.classifyUsage(results, NAME);
  assert.deepEqual(hits.map((h) => [h.name, h.kind]), [['A', 'write'], ['B', 'read'], ['D', 'mention']]);
  assert.equal(commentOnly, 1);
  assert.deepEqual(P.usageCounts(hits), { write: 1, read: 1, mention: 1 });
});

test('the summary says what was found, how much was searched, and what could not be', () => {
  const hits = [{ kind: 'read' }, { kind: 'read' }, { kind: 'write' }, { kind: 'mention' }];
  const text = P.usageSummary({ name: NAME, hits, searched: 19, capped: ['Business Rule'], errors: [{ label: 'UI Page' }], commentOnly: 2 });
  assert.match(text, /is read by 2 scripts, set by 1 script, mentioned in 1 more\./);
  assert.match(text, /19 script tables searched, active records only\./);
  assert.match(text, /2 scripts have the name only in a comment/);
  assert.match(text, /first 100 matches were read in Business Rule/);
  assert.match(text, /1 table could not be searched \(UI Page\)/);
  const none = P.usageSummary({ name: NAME, hits: [], searched: 19 });
  assert.match(none, /^No active script uses /);
  assert.match(P.usageSummary({ name: NAME, hits: [{ kind: 'mention' }], searched: 1 }), /mentioned in 1 script\./);
  assert.match(P.USAGE_LIMITS_NOTE, /built up in code/);
});

// --- Developer switches ----------------------------------------------------------------------------------------------

test('every developer switch has a name, a plain sentence and a warning, once, and none of them is hidden', () => {
  assert.ok(P.DEV_SWITCHES.length >= 6 && P.DEV_SWITCHES.length <= 12, 'a short, curated list');
  const names = P.DEV_SWITCHES.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  P.DEV_SWITCHES.forEach((s) => {
    assert.match(s.name, /^[a-z][a-z0-9_.]+$/);
    assert.ok(s.what.length > 20 && s.what.endsWith('.'), s.name);
    assert.ok(s.careful.length > 20 && s.careful.endsWith('.'), s.name);
    assert.equal(P.nameLooksSecret(s.name), false, `${s.name} would be hidden`);
  });
});

test('a switch the instance does not have is reported as missing, with no property made up for it', () => {
  const found = [prop({ name: 'glide.ui.session_timeout', value: '1800' })];
  const merged = P.mergeSwitches(found);
  assert.equal(merged.length, P.DEV_SWITCHES.length);
  assert.equal(merged.find((s) => s.name === 'glide.ui.session_timeout').found, true);
  const missing = merged.filter((s) => !s.found);
  assert.equal(missing.length, P.DEV_SWITCHES.length - 1);
  missing.forEach((s) => assert.equal(s.property, null));
});

// --- Changes and restore ----------------------------------------------------------------------------------------------

const at = (h, m, day = 23) => new Date(2026, 9, day, h, m).getTime();
const HOST = 'dev12345.service-now.com';
const change = (extra = {}) => ({ host: HOST, sysId: ID, name: 'x_acme.sync.timeout', previous: '30', next: '3600', at: at(14, 32), ...extra });

test('a change is kept with the value it replaced', () => {
  const list = P.recordChange([], change());
  assert.equal(list.length, 1);
  assert.deepEqual({ original: list[0].original, current: list[0].current, count: list[0].count, firstAt: list[0].firstAt }, { original: '30', current: '3600', count: 1, firstAt: at(14, 32) });
});

test('changing a property twice keeps the FIRST old value, so Restore goes back to what the instance had', () => {
  let list = P.recordChange([], change());
  list = P.recordChange(list, change({ previous: '3600', next: '7200', at: at(15, 10) }));
  assert.equal(list.length, 1);
  assert.equal(list[0].original, '30');
  assert.equal(list[0].current, '7200');
  assert.equal(list[0].count, 2);
  assert.equal(list[0].firstAt, at(14, 32));
  assert.equal(list[0].lastAt, at(15, 10));
});

test('changes are per instance and per property, newest first', () => {
  let list = P.recordChange([], change());
  list = P.recordChange(list, change({ sysId: ID2, name: 'x_acme.other', previous: 'a', next: 'b', at: at(16, 0) }));
  list = P.recordChange(list, change({ host: 'prod.service-now.com', at: at(16, 5) }));
  assert.deepEqual(P.activeChanges(list, HOST).map((c) => c.name), ['x_acme.other', 'x_acme.sync.timeout']);
  assert.equal(P.activeChanges(list, 'prod.service-now.com').length, 1);
  assert.equal(P.changeFor(list, HOST, ID2).current, 'b');
  assert.equal(P.changeFor(list, HOST, 'nope'), null);
});

test('a restored change leaves the active list; a new change after a restore starts a fresh record', () => {
  let list = P.recordChange([], change());
  list = P.markRestored(list, list[0].id, at(15, 0));
  assert.equal(P.activeChanges(list, HOST).length, 0);
  assert.equal(P.restoredChanges(list, HOST).length, 1);
  list = P.recordChange(list, change({ previous: '30', next: '90', at: at(17, 0) }));
  assert.equal(P.activeChanges(list, HOST).length, 1);
  assert.equal(P.activeChanges(list, HOST)[0].original, '30');
  assert.equal(P.activeChanges(list, HOST)[0].count, 1);
  assert.equal(P.clearRestored(list, HOST).length, 1);
});

test('the list is capped', () => {
  let list = [];
  for (let i = 0; i < P.CHANGES_CAP + 10; i += 1) list = P.recordChange(list, change({ sysId: sidOf(i), at: at(10, 0) + i }));
  assert.equal(list.length, P.CHANGES_CAP);
});
function sidOf(i) {
  return String(i).padStart(32, '0');
}

test('the clock shows the time today and the date for another day', () => {
  const now = at(18, 0);
  assert.equal(P.formatClock(at(14, 32), now), '14:32');
  assert.equal(P.formatClock(at(9, 5), now), '09:05');
  assert.equal(P.formatClock(at(14, 32, 22), now), 'Oct 22, 14:32');
});

test('the nudge reads "You changed this at 14:32 - restore?"', () => {
  const now = at(18, 0);
  const one = P.recordChange([], change())[0];
  assert.equal(P.nudgeText(one, now), 'You changed this at 14:32 - restore?');
  assert.equal(P.nudgeText(one, now, { withName: true }), 'You changed x_acme.sync.timeout at 14:32 - restore?');
  const twice = { ...one, count: 3 };
  assert.equal(P.nudgeText(twice, now), 'You changed this 3 times, first at 14:32 - restore?');
});

test('someone else changing the value after us is noticed', () => {
  const c = P.recordChange([], change())[0];
  assert.equal(P.restoreDrift(c, '3600'), false);
  assert.equal(P.restoreDrift(c, '99'), true);
});

// --- What the confirmations say ---------------------------------------------------------------------------------------

const PROD = { host: 'acmeprod.service-now.com', env: 'prod', guarded: true };
const UNKNOWN = { host: 'localhost', env: 'unknown', guarded: true };
const DEV = { host: 'dev12345.service-now.com', env: 'dev', guarded: false };

test('production gets a loud confirmation: danger, the word PRODUCTION, a labelled button', () => {
  const ask = P.changeAsk({ prop: prop(), next: '3600', guard: PROD, host: PROD.host });
  assert.equal(ask.danger, true);
  assert.match(ask.message, /PRODUCTION/);
  assert.match(ask.title, /on production\?$/);
  assert.equal(ask.confirmLabel, 'Change on production');
});

test('an instance NowBuddy cannot place is treated as production and says why', () => {
  const ask = P.changeAsk({ prop: prop(), next: '3600', guard: UNKNOWN, host: UNKNOWN.host });
  assert.equal(ask.danger, true);
  assert.match(ask.message, /cannot tell whether localhost is production/);
  assert.match(ask.title, /may be production/);
});

test('a development instance is confirmed plainly, still saying the change reaches everyone', () => {
  const ask = P.changeAsk({ prop: prop(), next: '3600', guard: DEV, host: DEV.host });
  assert.equal(ask.danger, false);
  assert.match(ask.message, /does not look like production, but the change still reaches every user/);
  assert.equal(ask.confirmLabel, 'Change property');
});

test('the confirmation shows the name, the old value, the new value and the instance', () => {
  const ask = P.changeAsk({ prop: prop({ value: '30' }), next: '3600', guard: DEV, host: DEV.host });
  assert.match(ask.details, /Property:\s+x_acme\.sync\.timeout/);
  assert.match(ask.details, /Now:\s+30/);
  assert.match(ask.details, /New:\s+3600/);
  assert.match(ask.details, /Instance:\s+dev12345\.service-now\.com/);
  assert.match(ask.details, /Update set:\s+\(unknown\)/);
  assert.match(ask.message, /keeps the old value/);
});

test('an empty value is written as (empty), and a long one is cut with a count', () => {
  const ask = P.changeAsk({ prop: prop({ type: 'string', value: 'abc' }), next: '', guard: DEV });
  assert.match(ask.details, /New:\s+\(empty\)/);
  assert.match(ask.message, /Clearing the value makes scripts fall back/);
  const long = P.changeAsk({ prop: prop({ type: 'string', value: 'x' }), next: 'y'.repeat(700), guard: DEV });
  assert.match(long.details, /\(100 more characters\)/);
});

test('risky changes carry their own warning', () => {
  const smtp = prop({ name: 'glide.email.smtp.active', type: 'boolean', value: 'true' });
  assert.match(P.changeAsk({ prop: smtp, next: 'false', guard: DEV }).message, /nobody gets a notification/i);
  const sec = prop({ name: 'glide.security.use_csrf_token', type: 'boolean', value: 'true' });
  assert.match(P.changeAsk({ prop: sec, next: 'false', guard: DEV }).message, /security setting/);
  const enabled = prop({ name: 'x_acme.sync.enabled', type: 'boolean', value: 'true' });
  assert.match(P.changeAsk({ prop: enabled, next: 'false', guard: DEV }).message, /"active" or "enabled"/);
  assert.equal(P.riskNotes(enabled, 'true').some((n) => /enabled/.test(n)), false);
});

test('a restore says when someone changed the value since, and names what comes back', () => {
  const c = P.recordChange([], change())[0];
  const plain = P.restoreAsk({ change: c, live: '3600', guard: DEV, host: DEV.host });
  assert.match(plain.details, /Restore:\s+30/);
  assert.match(plain.details, /Now:\s+3600/);
  assert.equal(plain.confirmLabel, 'Restore value');
  assert.doesNotMatch(plain.message, /not the/);
  const drifted = P.restoreAsk({ change: c, live: '99', guard: PROD, host: PROD.host });
  assert.match(drifted.message, /now holds 99, not the 3600 you set/);
  assert.equal(drifted.danger, true);
  assert.equal(drifted.confirmLabel, 'Restore on production');
});

test('the reason line recorded with a write says what was done', () => {
  assert.equal(P.changeReason(prop(), '1'), 'NowBuddy changed system property x_acme.sync.timeout for a test');
  assert.equal(P.changeReason(prop(), '1', true), 'NowBuddy restored system property x_acme.sync.timeout');
});

test('the confirmation says where the change is captured: a named update set, the Default one, or unknown', () => {
  const named = P.changeAsk({ prop: prop(), next: '1', guard: DEV, updateSet: { name: 'STRY0012 Incident P1 handling' } });
  assert.match(named.message, /current update set is "STRY0012 Incident P1 handling"\. The change is captured in it and travels with it to the next instance/);
  assert.match(named.details, /Update set:\s+STRY0012 Incident P1 handling/);
  const fallback = P.changeAsk({ prop: prop(), next: '1', guard: DEV, updateSet: { name: 'Default' } });
  assert.match(fallback.message, /"Default"\. The change is captured there, where it is easy to lose or ship by accident/);
  assert.match(P.updateSetNote({ name: 'Default [Global]' }), /easy to lose/);
  const unknown = P.changeAsk({ prop: prop(), next: '1', guard: DEV, updateSet: null });
  assert.match(unknown.message, /could not read the current update set/);
  const restore = P.restoreAsk({ change: P.recordChange([], change())[0], live: '3600', guard: DEV, updateSet: { name: 'STRY0012 Incident P1 handling' } });
  assert.match(restore.message, /travels with it to the next instance/);
  assert.match(restore.details, /Update set:\s+STRY0012/);
});

// --- Opening on a property --------------------------------------------------------------------------------------------

test('code pasted from a script is searched as the property name it holds', () => {
  assert.equal(P.queryFromText("gs.getProperty('x_acme.sync.timeout', '30')"), 'x_acme.sync.timeout');
  assert.equal(P.queryFromText('var t = gs.setProperty( "x_acme.sync.timeout" , 5);'), 'x_acme.sync.timeout');
  assert.equal(P.queryFromText('  glide.ui.session_timeout '), 'glide.ui.session_timeout');
  assert.equal(P.queryFromText('session timeout'), 'session timeout');
  assert.equal(P.queryFromText(''), '');
  assert.deepEqual(P.startTarget({ args: "gs.getProperty('x_acme.sync.timeout')" }), { kind: 'search', query: 'x_acme.sync.timeout', openExact: true });
});

test('the panel starts from the typed text, else the property record on screen, else the home view', () => {
  assert.deepEqual(P.startTarget({ args: ' glide.ui.session_timeout ' }), { kind: 'search', query: 'glide.ui.session_timeout', openExact: true });
  assert.deepEqual(P.startTarget({ args: 'session timeout' }), { kind: 'search', query: 'session timeout', openExact: false });
  assert.deepEqual(P.startTarget({ args: '', context: { table: 'sys_properties', sysId: ID } }), { kind: 'record', sysId: ID });
  assert.deepEqual(P.startTarget({ args: '', context: { table: 'incident', sysId: ID } }), { kind: 'home' });
  assert.deepEqual(P.startTarget({ args: '', context: { table: 'sys_properties', sysId: '' } }), { kind: 'home' });
  assert.deepEqual(P.startTarget({}), { kind: 'home' });
  // Typed text wins over the page.
  assert.equal(P.startTarget({ args: 'timeout', context: { table: 'sys_properties', sysId: ID } }).kind, 'search');
});

// --- Comparing with another instance ----------------------------------------------------------------------------------

test('comparing says same, differs, missing, or hidden, and never passes on a secret from the other side', () => {
  const p = prop({ type: 'string', value: '30' });
  assert.equal(P.compareOutcome(p, { found: false }).state, 'missing');
  assert.deepEqual(P.compareOutcome(p, { found: true, changes: [] }), { state: 'same', text: 'The value is the same on both instances.', others: [] });
  const differs = P.compareOutcome(p, { found: true, changes: [{ name: 'value', before: '30', after: '60' }, { name: 'description', before: 'a', after: 'b' }, { name: 'sys_mod_count', before: '1', after: '2' }] });
  assert.equal(differs.state, 'differs');
  assert.equal(differs.here, '30');
  assert.equal(differs.there, '60');
  assert.deepEqual(differs.others, ['description']);
  assert.equal(P.compareOutcome(prop({ name: 'x.password', value: 'abc' }), { found: true, changes: [{ name: 'value', before: 'abc', after: 'def' }] }).state, 'hidden');
  const leak = P.compareOutcome(p, { found: true, changes: [{ name: 'value', before: '30', after: 'https://u:hunter2@host/x' }] });
  assert.equal(leak.state, 'hidden');
  assert.equal(JSON.stringify(leak).includes('hunter2'), false);
  const passwordThere = P.compareOutcome(p, { found: true, changes: [{ name: 'value', before: '30', after: 'ENC:abc' }, { name: 'type', before: 'string', after: 'password2' }] });
  assert.equal(passwordThere.state, 'hidden');
});

// --- The columns the feature relies on --------------------------------------------------------------------------------

test('the core columns are the ones every instance has; the optional ones are probed', () => {
  assert.deepEqual(P.CORE_COLUMNS, ['sys_id', 'name', 'value', 'type']);
  assert.equal(new Set(P.ALL_COLUMNS).size, P.ALL_COLUMNS.length);
  assert.ok(P.OPTIONAL_COLUMNS.includes('description'));
});

// --- The instance half, against the preview fixture ---------------------------------------------------------------------
//
// src/content/properties.js reads through the Table API. These tests stub the page (a session token), fetch (answered by
// preview/fixtures/properties.js, the same fake the panel is looked at against) and chrome.storage / runtime.

const fixture = require('../preview/fixtures/properties.js');
const content = require('../src/content/properties.js');

function stubInstance({ hostname = 'dev12345.service-now.com', search = '', deny = null, remote = null } = {}) {
  global.document = {
    documentElement: {
      hasAttribute() {
        throw new Error('no bridge in tests');
      },
    },
    getElementById: () => null,
    querySelector: (sel) => (sel === 'input[name="sysparm_ck"]' ? { value: 'test-token' } : null),
    scripts: [],
  };
  global.window = { location: { hostname, href: `https://${hostname}/`, origin: `https://${hostname}` } };
  global.location = { search };
  const store = {};
  global.chrome = {
    storage: { local: { get: async (key) => ({ [key]: store[key] }), set: async (obj) => Object.assign(store, obj) } },
    runtime: { sendMessage: async (message) => (remote ? remote(message) : { ok: true, record: null }) },
  };
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const u = new URL(url, `https://${hostname}`);
    const table = u.pathname.split('/').pop();
    calls.push({ method: init.method || 'GET', table, kind: u.pathname.includes('/stats/') ? 'stats' : 'table', query: u.searchParams.get('sysparm_query') || '', fields: u.searchParams.get('sysparm_fields') || '', limit: u.searchParams.get('sysparm_limit') });
    if (deny && deny({ table, query: u.searchParams.get('sysparm_query') || '' })) return new Response(JSON.stringify({ error: { message: 'User Not Authorized' } }), { status: 403, headers: { 'content-type': 'application/json' } });
    return fixture.route(init.method || 'GET', u, init.body || null) || new Response(JSON.stringify({ result: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  content.propertyReset();
  return { calls, store };
}

test('instance: a search reads a few rows first to learn the columns, then searches by name and wide, and counts', async () => {
  const { calls } = stubInstance();
  const found = await content.searchProperties('timeout');
  const props = calls.filter((c) => c.table === 'sys_properties');
  assert.equal(props[0].limit, '10', 'the probe read');
  assert.equal(props[0].query, '', 'the probe has no condition');
  assert.match(props[1].query, /nameLIKEtimeout/);
  assert.ok(props.some((c) => c.kind === 'table' && /descriptionLIKEtimeout/.test(c.query)), 'the wide search includes the description');
  assert.ok(props.some((c) => c.kind === 'stats'), 'the count');
  assert.equal(found.rows[0].name, 'glide.ui.session_timeout');
  assert.ok(found.rows.some((r) => r.name === 'x_acme_hr.sync.timeout_seconds'));
  assert.equal(found.capped, false);
  assert.deepEqual(found.notes, []);
});

test('instance: the columns are probed once, not before every search', async () => {
  const { calls } = stubInstance();
  await content.searchProperties('timeout');
  await content.searchProperties('email');
  assert.equal(calls.filter((c) => c.table === 'sys_properties' && c.limit === '10' && !c.query).length, 1);
});

test('instance: without a description column the description is not searched, and the result says so', async () => {
  const { calls } = stubInstance({ search: '?fixture=nodescription' });
  const found = await content.searchProperties('timeout');
  assert.ok(calls.filter((c) => c.table === 'sys_properties').every((c) => !/description/.test(c.query)), 'no condition on a column that did not come back');
  assert.ok(found.rows.length > 0);
  assert.match(found.notes.join(' '), /no description column/);
});

test('instance: a hidden property comes back without its value, whether found by name, by type or by searching for the secret', async () => {
  stubInstance();
  const byName = await content.searchProperties('api_key');
  const hidden = byName.rows.find((r) => r.name === 'x_acme_hr.integration.api_key');
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.value, '');
  assert.equal(JSON.stringify(byName).includes('AKIAFAKEKEY'), false);

  const byType = await content.searchProperties('ldap');
  const password = byType.rows.find((r) => r.name === 'glide.ldap.bind.password');
  assert.equal(password.hidden, true);
  assert.equal(JSON.stringify(byType).includes('not-a-real-secret'), false);

  const bySecret = await content.searchProperties('AKIAFAKE');
  assert.equal(bySecret.rows.length, 0, 'a secret value cannot be searched for');
  const byPassword = await content.searchProperties('not-a-real-secret');
  assert.equal(byPassword.rows.length, 0);
});

test('instance: one property by sys_id or by name; a bad id or name is refused before a request is made', async () => {
  const { calls } = stubInstance();
  const { rows } = await content.searchProperties('x_acme_itsm.autoclose.days');
  const byId = await content.getProperty({ sysId: rows[0].sysId });
  assert.equal(byId.property.name, 'x_acme_itsm.autoclose.days');
  assert.equal(byId.property.editor.kind, 'number');
  const byName = await content.getProperty({ name: 'x_acme_itsm.autoclose.days' });
  assert.equal(byName.property.sysId, rows[0].sysId);
  assert.equal((await content.getProperty({ name: 'no.such.property' })).property, null);
  const before = calls.length;
  await assert.rejects(() => content.getProperty({ sysId: 'nope' }), /not a property record/);
  await assert.rejects(() => content.getProperty({ name: 'a^b' }), /letters, digits/);
  assert.equal(calls.length, before);
});

test('instance: the developer switches are looked up in one read; a missing one is reported as missing', async () => {
  const { calls } = stubInstance();
  const switches = await content.developerSwitches();
  assert.equal(switches.length, P.DEV_SWITCHES.length);
  assert.equal(switches.find((s) => s.name === 'glide.ui.session_timeout').found, true);
  assert.equal(switches.find((s) => s.name === 'sn_atf.runner.enabled').found, false, 'not on the fake instance');
  assert.equal(switches.find((s) => s.name === 'sn_atf.runner.enabled').property, null);
  assert.equal(calls.filter((c) => c.table === 'sys_properties' && /^nameIN/.test(c.query)).length, 1);
  assert.ok(calls.every((c) => c.method === 'GET'), 'nothing is created or changed');
});

test('instance: the recently changed list is newest first', async () => {
  stubInstance();
  const recent = await content.recentProperties();
  assert.ok(recent.length > 3);
  for (let i = 1; i < recent.length; i += 1) assert.ok(recent[i - 1].updatedOn >= recent[i].updatedOn);
});

test('instance: who reads a property - reads, writes and mentions from real-looking scripts, with the tables searched counted', async () => {
  const { calls } = stubInstance();
  const usage = await content.findPropertyUsage('x_acme_hr.sync.timeout_seconds');
  assert.equal(usage.searched, 19);
  assert.deepEqual(P.usageCounts(usage.hits), { write: 1, read: 5, mention: 1 });
  assert.equal(usage.commentOnly, 1, 'the retired business rule has the name only in a comment');
  const names = usage.hits.map((h) => h.name);
  assert.ok(names.includes('HRSyncClient') && names.includes('Reset HR sync timeout on Monday'));
  assert.ok(!names.includes('HRSyncLegacy'), 'a property that only starts the same way is not a hit');
  const widget = usage.hits.find((h) => h.name === 'HR sync status' && h.kind === 'read');
  assert.equal(widget.lines[0].via, 'KEY', 'a name held in a variable is followed');
  assert.equal(usage.hits.find((h) => h.name === 'Reset HR sync timeout on Monday').lines[0].arg, "'30'");
  assert.ok(usage.hits.every((h) => /^\/[a-z_]+\.do\?sys_id=[0-9a-f]{32}$/.test(h.url)));
  assert.match(usage.summary, /read by 5 scripts, set by 1 script, mentioned in 1 more\./);
  assert.ok(calls.every((c) => c.method === 'GET'));
  // The shared code search and the extra tables each ran one query per table.
  assert.ok(calls.some((c) => c.table === 'sys_script_include'));
  assert.ok(calls.some((c) => c.table === 'sys_ui_page'));
  assert.ok(calls.some((c) => c.table === 'sys_dictionary' && /default_valueLIKE/.test(c.query)));
});

test('instance: a script table that cannot be read is named; if none can be read it is an error, not "no script uses it"', async () => {
  stubInstance({ deny: ({ table }) => table === 'sys_ui_page' });
  const some = await content.findPropertyUsage('x_acme_hr.sync.timeout_seconds');
  assert.equal(some.errors.length, 1);
  assert.equal(some.errors[0].label, 'UI Page');
  assert.match(some.summary, /1 table could not be searched \(UI Page\)/);

  stubInstance({ deny: ({ table }) => table !== 'sys_properties' });
  await assert.rejects(() => content.findPropertyUsage('x_acme_hr.sync.timeout_seconds'), /No script table could be searched/);
  await assert.rejects(() => content.findPropertyUsage('a b'), /letters, digits/);
});

test('instance: the scripts that read a secret property come back masked, by its name or by its type alone', async () => {
  const { calls } = stubInstance();
  for (const name of ['x_acme_hr.integration.api_key', 'x_acme_hr.directory.bind']) {
    const usage = await content.findPropertyUsage(name);
    assert.equal(usage.masked, true, name);
    const hit = usage.hits.find((h) => h.name === 'HRDirectoryClient');
    assert.ok(hit, `${name}: the script is found`);
    assert.equal(hit.kind, 'read');
    const text = JSON.stringify(usage);
    ['Fallback-Pa55', 'AKIAFAKEKEY', 'svc_hr_lookup', 'not-a-real-secret'].forEach((s) => assert.equal(text.includes(s), false, `${name}: ${s}`));
  }
  assert.ok(calls.every((c) => c.method === 'GET'));
  // An ordinary property is not masked: its default is shown.
  const plain = await content.findPropertyUsage('x_acme_hr.sync.timeout_seconds');
  assert.equal(plain.masked, false);
  assert.equal(plain.hits.find((h) => h.name === 'Reset HR sync timeout on Monday').lines[0].arg, "'30'");
});

test('instance: a field ACL that hides the value of one probed row does not make every property unreadable', async () => {
  const { calls } = stubInstance();
  const inner = global.fetch;
  global.fetch = async (url, init) => {
    const res = await inner(url, init);
    const u = new URL(url, 'https://dev12345.service-now.com');
    if (!u.pathname.endsWith('/table/sys_properties') || u.searchParams.get('sysparm_query')) return res;
    // The column probe: its first row is a private property whose value this user may not read.
    const body = await res.json();
    delete body.result[0].value;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const got = await content.getProperty({ name: 'x_acme_itsm.autoclose.days' });
  assert.equal(got.property.unreadable, false);
  assert.equal(got.property.value, '7');
  assert.equal(got.property.editor.kind, 'number');
  assert.ok(calls.filter((c) => c.table === 'sys_properties' && c.query).every((c) => c.fields.split(',').includes('value')), 'the value is always asked for');
});

test('instance: the guard carries the instance name a person types to unlock a change', () => {
  stubInstance({ hostname: 'acmeprod.service-now.com' });
  assert.equal(content.propertyGuard().instance, 'acmeprod');
});

test('instance: fix scripts are searched without an active condition (the column is not certain to exist)', async () => {
  const { calls } = stubInstance();
  await content.findPropertyUsage('glide.email.smtp.active');
  const fix = calls.filter((c) => c.table === 'sys_script_fix');
  assert.equal(fix.length, 1);
  assert.doesNotMatch(fix[0].query, /active=/);
});

test('instance: a failed read is an error, never an empty result', async () => {
  stubInstance({ deny: ({ table }) => table === 'sys_properties' });
  await assert.rejects(() => content.searchProperties('timeout'), /not allowed/);
});

test('instance: the guard follows the instance: production and an unrecognised host are guarded, a dev instance is not', () => {
  stubInstance({ hostname: 'acmeprod.service-now.com' });
  assert.deepEqual({ env: content.propertyGuard().env, guarded: content.propertyGuard().guarded }, { env: 'prod', guarded: true });
  stubInstance({ hostname: 'dev12345.service-now.com' });
  assert.equal(content.propertyGuard().guarded, false);
  stubInstance({ hostname: 'localhost' });
  assert.equal(content.propertyGuard().guarded, true);
});

test('instance: the property record on screen is found from the page address', () => {
  stubInstance();
  global.window.location.href = `https://dev12345.service-now.com/sys_properties.do?sys_id=${ID}`;
  assert.deepEqual(content.propertyOnPage(), { sysId: ID });
  global.window.location.href = `https://dev12345.service-now.com/incident.do?sys_id=${ID}`;
  assert.equal(content.propertyOnPage(), null);
});

test('instance: the list of changes survives in extension storage', async () => {
  stubInstance();
  assert.deepEqual(await content.readChanges(), []);
  const list = P.recordChange([], change());
  await content.saveChanges(list);
  assert.deepEqual(await content.readChanges(), list);
  await content.saveChanges('not a list');
  assert.deepEqual(await content.readChanges(), []);
});

test('instance: comparing sends nothing for a hidden property, and only a sentence about the value comes back for a visible one', async () => {
  const sent = [];
  stubInstance({ remote: (m) => (sent.push(m), { ok: true, matchedBy: 'sys_id', record: { sys_id: ID, name: 'x_acme_hr.sync.timeout_seconds', value: '120', type: 'integer', description: 'Seconds.' } }) });
  const hidden = (await content.searchProperties('api_key')).rows.find((r) => r.hidden);
  const refused = await content.compareProperty({ sysId: hidden.sysId, host: 'acmetest.service-now.com' });
  assert.equal(refused.outcome.state, 'hidden');
  assert.equal(sent.length, 0, 'the hidden property was not even requested from the other instance');

  const visible = (await content.searchProperties('x_acme_hr.sync.timeout_seconds')).rows[0];
  const result = await content.compareProperty({ sysId: visible.sysId, host: 'acmetest.service-now.com' });
  assert.equal(sent.length, 1);
  assert.equal(result.outcome.state, 'differs');
  assert.equal(result.outcome.here, '30');
  assert.equal(result.outcome.there, '120');
  assert.deepEqual(Object.keys(result).sort(), ['host', 'matchedBy', 'outcome']);
});

test('instance: nothing in the instance half writes: the only change goes through the panel and agentExecute', () => {
  const names = Object.keys(content.propertyServices);
  names.forEach((n) => assert.match(n, /^propertyExplorer/));
  // Only reads, and the panel's own list of changes (extension storage). Nothing that writes to the instance.
  assert.deepEqual(names.sort(), ['propertyExplorerChanges', 'propertyExplorerCompare', 'propertyExplorerGet', 'propertyExplorerGuard', 'propertyExplorerPage', 'propertyExplorerRecent', 'propertyExplorerSaveChanges', 'propertyExplorerSearch', 'propertyExplorerSwitches', 'propertyExplorerUpdateSet', 'propertyExplorerUsage']);
});
