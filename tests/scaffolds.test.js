const test = require('node:test');
const assert = require('node:assert/strict');
const { build, KIND_IDS, KINDS, encodeDefaults, resolveKind, parseNewArgs, isNewRequest, validateIdentifier, suggestTable, MAX_QUERY_URL } = require('../src/lib/scaffolds.js');
const { verifyScript } = require('../src/lib/verify.js');
const { parseEncodedQuery } = require('../src/lib/query.js');

/** The lines under an "Example (uncomment to use)" header, uncommented: the version a developer ends up with. */
function uncommentExamples(script) {
  let on = false;
  return script
    .split('\n')
    .map((line) => {
      if (/^\s*\/\/ Example \(uncomment/.test(line)) {
        on = true;
        return line;
      }
      const m = on && /^(\s*)\/\/ ?(.*)$/.exec(line);
      if (m && m[2].trim()) return `${m[1]}${m[2]}`;
      on = false;
      return line;
    })
    .join('\n');
}

const CASES = [
  ['br', { table: 'incident', when: 'before' }],
  ['br', { table: 'incident', when: 'after' }],
  ['br', { table: 'incident', when: 'async' }],
  ['br', { table: 'incident', when: 'display' }],
  ['br', { table: 'incident', when: 'before', scoped: true }],
  ['si', { name: 'MyHelper' }],
  ['si', { name: 'MyHelper', scoped: true }],
  ['si', { name: 'MyAjax', variant: 'ajax' }],
  ['si', { name: 'MyAjax', variant: 'ajax', scoped: true }],
  ['cs', { table: 'incident', type: 'onLoad' }],
  ['cs', { table: 'incident', type: 'onChange', field: 'priority' }],
  ['cs', { table: 'incident', type: 'onSubmit' }],
  ['cs', { table: 'incident', type: 'onCellEdit', field: 'state' }],
  ['uia', { table: 'incident', variant: 'roundtrip' }],
  ['uia', { table: 'incident', variant: 'client' }],
  ['uia', { table: 'incident', variant: 'server' }],
  ['sj', { table: 'incident' }],
  ['fix', { table: 'incident' }],
  ['rest', { table: 'incident', method: 'GET' }],
  ['rest', { table: 'incident', method: 'POST' }],
  ['rest', { table: 'incident', method: 'DELETE' }],
];

test("every template builds, and passes the editor's own verifier with and without its examples", () => {
  CASES.forEach(([kind, options]) => {
    const made = build(kind, options);
    const label = `${kind} ${JSON.stringify(options)}`;
    assert.equal(made.ok, true, `${label}: ${made.error}`);
    assert.ok(made.script.trim().length > 40, label);
    [false, true].forEach((examples) => {
      made.checks.forEach((check) => {
        const result = verifyScript({ ...check, code: examples ? uncommentExamples(check.code) : check.code });
        const bad = result.findings.filter((f) => f.severity !== 'low');
        assert.deepEqual(
          bad.map((f) => `${f.ruleId} line ${f.line}: ${f.message}`),
          [],
          `${label} ${check.kind} (${examples ? 'examples uncommented' : 'as shipped'})`
        );
      });
    });
  });
});

test('the examples the check uncomments really exist (so the second pass is not vacuous)', () => {
  ['br', 'cs', 'uia'].forEach((kind) => {
    const made = build(kind, { table: 'incident' });
    assert.notEqual(uncommentExamples(made.script), made.script, kind);
  });
  const x = uncommentExamples(build('br', { table: 'incident', when: 'before' }).script);
  assert.match(x, /^\s+if \(current\.short_description\.changes\(\)/m);
});

test('every kind has at least one case above', () => {
  KIND_IDS.forEach((kind) => assert.ok(CASES.some(([k]) => k === kind), kind));
});

test('templates follow the rules developers get wrong', () => {
  const before = build('br', { table: 'incident', when: 'before' }).script;
  assert.doesNotMatch(before.replace(/\/\/.*$/gm, ''), /current\.update\(/, 'no live current.update() in a before rule');
  assert.match(before, /executeRule\(current, previous/);
  assert.match(build('cs', { table: 'incident', type: 'onChange' }).script, /isLoading \|\| newValue === ''/);
  assert.match(build('cs', { table: 'incident', type: 'onCellEdit' }).script, /callback\(saveAndClose\)/);
  assert.match(build('sj', {}).script, /DRY_RUN = true/);
  assert.match(build('sj', {}).script, /setLimit\(BATCH_SIZE\)/);
  assert.match(build('si', { name: 'A', variant: 'ajax' }).script, /extendsObject\(AbstractAjaxProcessor/);
  assert.match(build('si', { name: 'A', variant: 'ajax', scoped: true }).script, /extendsObject\(global\.AbstractAjaxProcessor/);
  assert.match(build('uia', { table: 'incident' }).script, /gsftSubmit\(null, g_form\.getFormElement\(\), 'incident_action'\)/);
  assert.match(build('rest', { method: 'POST' }).script, /setStatus\(201\)/);
  // ES5: nothing a Rhino server or an old browser cannot run.
  CASES.forEach(([kind, options]) => assert.doesNotMatch(build(kind, options).script.replace(/\/\/.*$/gm, ''), /=>|\blet\b|\bconst\b|`/, `${kind} is ES5`));
});

test('the new-record URL carries the values and survives carets, equals, quotes, newlines and non-ASCII', () => {
  const nasty = "var a = 1 ^ 2;\nif (b === 'x=y' && c != \"z\") { /* 日本語 ✓ */ }\n^^\nend^";
  const query = encodeDefaults({ name: 'Rule A', script: nasty, empty: '', skip: undefined });
  assert.ok(!query.includes('empty') && !query.includes('skip'), 'empty values are left out');
  const parsed = parseEncodedQuery(query).groups[0];
  assert.deepEqual(parsed.map((c) => c.field), ['name', 'script']);
  assert.equal(parsed[1].value, nasty, 'the script comes back exactly as it went in');

  const made = build('br', { table: 'incident', when: 'before', name: 'A ^ B = C' });
  assert.equal(made.ok, true);
  assert.match(made.url, /^\/sys_script\.do\?sys_id=-1&sysparm_query=/);
  const decoded = decodeURIComponent(made.url.split('sysparm_query=')[1]);
  const back = Object.fromEntries(parseEncodedQuery(decoded).groups[0].map((c) => [c.field, c.value]));
  assert.equal(back.name, 'A ^ B = C');
  assert.equal(back.collection, 'incident');
  assert.equal(back.when, 'before');
  assert.equal(back.advanced, 'true');
  assert.equal(back.script, made.script.trimEnd(), 'the whole template arrives intact (the parser trims the final newline)');
});

test('a template too long for a link falls back to copy-and-paste', () => {
  const made = build('br', { table: 'incident', name: 'x'.repeat(90) });
  assert.equal(made.copyOnly, false);
  assert.ok(made.url.length < MAX_QUERY_URL + 200);
  const long = build('si', { name: `A${'b'.repeat(5000)}` });
  assert.equal(long.copyOnly, true);
  assert.ok(long.url.length < MAX_QUERY_URL, 'the link no longer carries the script');
  assert.ok(long.script.length > 100, 'but the script is still returned for the clipboard');
});

test('names are validated: identifiers for Script Includes, tables for rules', () => {
  assert.equal(validateIdentifier('My Helper').ok, false);
  assert.match(validateIdentifier('my helper').error, /MyHelper/);
  assert.equal(validateIdentifier('1abc').ok, false);
  assert.equal(validateIdentifier('Good_Name$').ok, true);
  assert.equal(build('si', {}).ok, false);
  assert.match(build('br', {}).error, /table/i);
  assert.equal(build('br', { table: 'Bad Table' }).ok, false);
  assert.equal(build('nope', {}).ok, false);
  assert.equal(build('cs', { table: 'incident', type: 'onChange', field: 'bad field!' }).ok, false);
});

test('what the developer types is understood', () => {
  assert.deepEqual(resolveKind('business rule on incident'), { kind: 'br', rest: 'on incident' });
  assert.deepEqual(resolveKind('si MyHelper'), { kind: 'si', rest: 'MyHelper' });
  assert.equal(resolveKind('script include').kind, 'si');
  assert.equal(resolveKind('scripted rest post').kind, 'rest');
  assert.equal(resolveKind('banana').kind, null);

  assert.deepEqual(parseNewArgs('si', 'MyHelper table incident'), { options: { name: 'MyHelper', table: 'incident' }, missing: [] });
  assert.deepEqual(parseNewArgs('si', 'Fancy Helper ajax scoped').options, { name: 'FancyHelper', variant: 'ajax', scoped: true });
  assert.deepEqual(parseNewArgs('br', 'Block closed edits on incident async').options, { name: 'Block closed edits', table: 'incident', when: 'async' });
  assert.deepEqual(parseNewArgs('br', '', { table: 'problem' }), { options: { table: 'problem' }, missing: [] });
  assert.deepEqual(parseNewArgs('br', '').missing, ['table']);
  assert.deepEqual(parseNewArgs('si', '').missing, ['name']);
  assert.deepEqual(parseNewArgs('cs', 'onload on incident').options, { type: 'onLoad', table: 'incident' });
  assert.deepEqual(parseNewArgs('rest', 'post on incident').options, { method: 'POST', table: 'incident' });
  assert.equal(parseNewArgs('uia', 'Close it server on incident').options.variant, 'server');

  assert.equal(isNewRequest('/new si'), true);
  assert.equal(isNewRequest('new business rule on incident'), true);
  assert.equal(isNewRequest('start a new script include'), true);
  assert.equal(isNewRequest('new incident'), false, 'not a template request');
  assert.equal(isNewRequest('new york'), false);
  assert.equal(isNewRequest('who changed this'), false);

  assert.equal(suggestTable('incident'), 'incident');
  assert.equal(suggestTable('sys_script'), '', 'the config table of the form being edited is not the table to build for');
  assert.equal(suggestTable(''), '');
  assert.ok(Object.values(KINDS).every((k) => k.label && k.table && k.words.length));
});

test('the palette provider answers /new and plain "new business rule", and asks for what is missing in the row text', async () => {
  const { scaffoldProvider } = require('../src/content/scaffoldCommands.js');
  const reopened = [];
  const ask = (ctx = {}) => scaffoldProvider({ ctx, toast: {}, reopen: (t) => reopened.push(t) });

  assert.deepEqual(await ask()('who changed this'), []);
  assert.deepEqual(await ask()('new incident'), [], 'a record search, not a template request');

  const kinds = await ask()('/new');
  assert.deepEqual(kinds.map((r) => r.id), KIND_IDS.map((id) => `new.pick.${id}`), 'bare /new lists every template');
  kinds[0].run();
  assert.equal(reopened.pop(), '/new br ', 'picking one continues in the palette');
  assert.deepEqual((await ask()('/new res')).map((r) => r.id), ['new.pick.rest']);

  const noTable = await ask()('new business rule');
  assert.match(noTable[0].hint, /on <table>/, 'it says what is missing');
  assert.ok(noTable.every((r) => r.id.startsWith('new.br.table.')));
  noTable[0].run();
  assert.equal(reopened.pop(), '/new br on incident');

  const fromPage = await ask({ table: 'problem' })('/new br after');
  assert.equal(fromPage[0].id, 'new.br.open');
  assert.match(fromPage[0].title, /Business Rule on problem after/, 'the table comes from the page');
  assert.ok(fromPage.some((r) => r.id === 'new.br.copy'));
  assert.deepEqual(fromPage.filter((r) => r.id.includes('.variant.')).map((r) => r.id), ['new.br.variant.before', 'new.br.variant.async', 'new.br.variant.display']);
  assert.ok(fromPage[0].score > fromPage[1].score);

  const onConfigForm = await ask({ table: 'sys_script' })('/new br');
  assert.ok(onConfigForm[0].id.startsWith('new.br.table.'), 'the config table of the form on screen is not offered as the target');

  const si = await ask()('/new si');
  assert.equal(si[0].id, 'new.si.name');
  assert.match((await ask()('/new si My Helper!'))[0].title, /MyHelper/, 'several words become a class name');
  const bad = await ask()('/new si 1bad');
  assert.equal(bad[0].id, 'new.si.error', 'an invalid name is explained in the row');
  const ajax = await ask()('/new si MyHelper ajax');
  assert.match(ajax[0].title, /MyHelper.*client callable/);
  assert.equal((await ask()('start a new script include MyHelper'))[0].id, 'new.si.open');
});
