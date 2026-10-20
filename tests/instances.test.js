const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseInstanceHost,
  SWATCHES,
  validColor,
  resolveColor,
  makeInstance,
  patchInstance,
  moveInstance,
  mapPageToInstance,
  switchUrl,
  rankInstances,
  titleWithPrefix,
  titleWithoutPrefix,
  classifyEnvironment,
  looksProd,
} = require('../src/lib/instances.js');

// --- hosts -----------------------------------------------------------------------------------------

test('a host is accepted bare, or pasted with a scheme and one trailing slash', () => {
  assert.deepEqual(parseInstanceHost('dev12345.service-now.com'), { host: 'dev12345.service-now.com' });
  assert.deepEqual(parseInstanceHost('  HTTPS://Acme-Test.service-now.com/ '), { host: 'acme-test.service-now.com' });
});

test('a path, query, port, user info or another domain is refused with a reason', () => {
  const bad = [
    'dev1.service-now.com/incident_list.do',
    'dev1.service-now.com/?x=1',
    'dev1.service-now.com#top',
    'dev1.service-now.com:8443',
    'admin@dev1.service-now.com',
    'dev1.service-now.com.evil.com',
    'evil.com/dev1.service-now.com',
    'service-now.com',
    '-x.service-now.com',
    'dev 1.service-now.com',
    '',
    '   ',
  ];
  bad.forEach((raw) => assert.ok(parseInstanceHost(raw).error, `should refuse ${JSON.stringify(raw)}`));
  assert.match(parseInstanceHost('dev1.service-now.com/a').error, /path/);
  assert.match(parseInstanceHost('evil.com').error, /service-now\.com/);
});

// --- colours --------------------------------------------------------------------------------------------

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

test('every swatch keeps 4.5:1 against the white letter drawn on it', () => {
  SWATCHES.forEach(({ hex, name }) => assert.ok(1.05 / (luminance(hex) + 0.05) >= 4.5, `${name} ${hex}`));
  assert.equal(new Set(SWATCHES.map((s) => s.hex)).size, SWATCHES.length);
});

test('production is always red, whatever colour was chosen', () => {
  const red = SWATCHES[0].hex;
  assert.equal(resolveColor({ tone: 'danger' }), red);
  assert.equal(resolveColor({ saved: SWATCHES[2].hex, tone: 'danger', host: 'x.service-now.com' }), red);
});

test('a saved colour wins over the environment, which wins over the host name', () => {
  assert.equal(resolveColor({ saved: '#175CD3', tone: 'ok' }), '#175cd3');
  assert.equal(resolveColor({ tone: 'ok' }), SWATCHES[2].hex);
  assert.equal(resolveColor({ tone: 'warn' }), SWATCHES[1].hex);
  assert.equal(resolveColor({ saved: 'red', tone: 'ok' }), SWATCHES[2].hex, 'not a swatch: ignored');
});

test('an unknown instance gets a stable colour that is not red, orange or green', () => {
  const a = resolveColor({ host: 'acme.service-now.com' });
  assert.equal(a, resolveColor({ host: 'ACME.service-now.com' }));
  const seen = new Set(['alpha', 'beta', 'gamma', 'delta', 'omega', 'zeta', 'sigma', 'kappa'].map((n) => resolveColor({ host: `${n}.service-now.com` })));
  assert.ok(seen.size > 1);
  [SWATCHES[0].hex, SWATCHES[1].hex, SWATCHES[2].hex].forEach((hex) => assert.ok(!seen.has(hex)));
  assert.equal(validColor('#nothing'), '');
});

test('environment names are recognised from a label or host', () => {
  assert.equal(classifyEnvironment('acmeprod').env, 'prod');
  assert.equal(classifyEnvironment('dev12345').env, 'dev');
  assert.equal(classifyEnvironment('acme'), null);
  assert.ok(looksProd('Sales', 'prod12345'));
  assert.ok(!looksProd('Sales', 'acmedev'));
});

// --- entries --------------------------------------------------------------------------------------------

test('makeInstance validates the host, trims the label and drops a colour that is not a swatch', () => {
  assert.deepEqual(makeInstance({ id: '1', label: ' QA ', host: 'https://qa1.service-now.com/', color: '#175cd3' }), { id: '1', label: 'QA', host: 'qa1.service-now.com', color: '#175cd3' });
  assert.deepEqual(makeInstance({ id: '1', label: '', host: 'qa1.service-now.com', color: 'pink' }), { id: '1', label: 'qa1', host: 'qa1.service-now.com' });
  assert.throws(() => makeInstance({ id: '1', host: 'qa1.service-now.com/x' }), /path/);
  assert.equal(makeInstance({ id: '1', label: 'x'.repeat(90), host: 'a.service-now.com' }).label.length, 40);
});

test('patching renames, recolours and clears a colour without touching other entries', () => {
  const list = [
    { id: 'a', label: 'A', host: 'a.service-now.com' },
    { id: 'b', label: 'B', host: 'b.service-now.com', color: '#175cd3' },
  ];
  const renamed = patchInstance(list, 'a', { label: '  Alpha ', color: '#067647' });
  assert.deepEqual(renamed[0], { id: 'a', label: 'Alpha', host: 'a.service-now.com', color: '#067647' });
  assert.strictEqual(renamed[1], list[1]);
  assert.equal('color' in patchInstance(list, 'b', { color: '' })[1], false);
  assert.equal(patchInstance(list, 'a', { label: '  ' })[0].label, 'a', 'an empty label falls back to the host name');
  assert.equal(list[0].label, 'A', 'the input is not changed');
});

test('moving swaps neighbours and stops at the ends', () => {
  const list = ['a', 'b', 'c'].map((id) => ({ id }));
  assert.deepEqual(moveInstance(list, 'b', -1).map((e) => e.id), ['b', 'a', 'c']);
  assert.deepEqual(moveInstance(list, 'b', 1).map((e) => e.id), ['a', 'c', 'b']);
  assert.strictEqual(moveInstance(list, 'a', -1), list);
  assert.strictEqual(moveInstance(list, 'c', 1), list);
  assert.strictEqual(moveInstance(list, 'zzz', 1), list);
});

// --- mapping a page ---------------------------------------------------------------------------------------

test('a list, a record and a Next Experience page carry over unchanged', () => {
  assert.deepEqual(mapPageToInstance({ pathname: '/incident_list.do', search: '?sysparm_query=active%3Dtrue%5Epriority%3D1' }), {
    path: '/incident_list.do?sysparm_query=active%3Dtrue%5Epriority%3D1',
    mapped: true,
    note: '',
  });
  assert.equal(mapPageToInstance({ pathname: '/sys_script.do', search: '?sys_id=0123456789abcdef0123456789abcdef', hash: '#x' }).path, '/sys_script.do?sys_id=0123456789abcdef0123456789abcdef#x');
  const nx = '/now/nav/ui/classic/params/target/incident_list.do%3Fsysparm_query%3Dactive%253Dtrue';
  assert.equal(mapPageToInstance({ pathname: nx }).path, nx);
});

test('parameters that belong to this session are dropped, the rest survive', () => {
  const m = mapPageToInstance({ pathname: '/incident.do', search: '?sys_id=-1&sysparm_ck=secret&sysparm_transaction_scope=abc&sysparm_record_list=x&sysparm_query=a%3Db' });
  assert.equal(m.path, '/incident.do?sys_id=-1&sysparm_query=a%3Db');
  assert.ok(!m.path.includes('secret'));
  assert.equal(mapPageToInstance({ pathname: '/incident.do', search: '?sysparm_ck=secret' }).path, '/incident.do');
});

test('pages that cannot exist elsewhere fall back to the home page, and say why', () => {
  ['/', '/login.do', '/logout.do', '/auth_redirect.do', '/sys_attachment.do', '/oauth_entity.do'].forEach((pathname) => {
    const m = mapPageToInstance({ pathname, search: '?x=1' });
    assert.deepEqual([m.path, m.mapped], ['/', false], pathname);
    assert.ok(m.note);
  });
  ['//evil.com/x', '/a/../b', '/a\\b', 'incident.do'].forEach((pathname) => assert.equal(mapPageToInstance({ pathname }).mapped, false, pathname));
});

test('the switch address is https on a validated host, with a root-relative path only', () => {
  assert.equal(switchUrl('PROD1.service-now.com', { path: '/incident_list.do?a=1' }), 'https://prod1.service-now.com/incident_list.do?a=1');
  assert.equal(switchUrl('prod1.service-now.com', { path: '//evil.com' }), 'https://prod1.service-now.com/');
  assert.equal(switchUrl('prod1.service-now.com', null), 'https://prod1.service-now.com/');
  assert.throws(() => switchUrl('evil.com', { path: '/' }));
  assert.throws(() => switchUrl('prod1.service-now.com/x', { path: '/' }));
});

// --- ranking ------------------------------------------------------------------------------------------------

const LIST = [
  { id: '1', label: 'DEV', host: 'acmedev.service-now.com' },
  { id: '2', label: 'TEST', host: 'acmetest.service-now.com' },
  { id: '3', label: 'PROD', host: 'acmeprod.service-now.com' },
  { id: '4', label: 'Sandbox dev', host: 'sbx77.service-now.com' },
];

test('with no query the configured order is kept and the current instance goes last', () => {
  assert.deepEqual(rankInstances(LIST, '', 'acmetest.service-now.com').map((r) => r.entry.id), ['1', '3', '4', '2']);
  const rows = rankInstances(LIST, '', 'ACMETEST.service-now.com');
  assert.deepEqual(rows.map((r) => r.current), [false, false, false, true]);
  assert.deepEqual(rankInstances(LIST, '').map((r) => r.entry.id), ['1', '2', '3', '4']);
});

test('a query needs every word to match and puts a label that starts with it first', () => {
  assert.deepEqual(rankInstances(LIST, 'prod').map((r) => r.entry.id), ['3']);
  assert.deepEqual(rankInstances(LIST, 'dev').map((r) => r.entry.id), ['1', '4'], 'DEV label beats "Sandbox dev"');
  assert.deepEqual(rankInstances(LIST, 'sandbox dev').map((r) => r.entry.id), ['4']);
  assert.deepEqual(rankInstances(LIST, 'acme').map((r) => r.entry.id), ['1', '2', '3'], 'host matches tie: configured order');
  assert.deepEqual(rankInstances(LIST, 'nothing'), []);
});

test('the current instance stays last even when it matches best', () => {
  assert.deepEqual(rankInstances(LIST, 'dev', 'acmedev.service-now.com').map((r) => r.entry.id), ['4', '1']);
});

test('bad entries and a missing list do not throw', () => {
  assert.deepEqual(rankInstances(undefined, 'x'), []);
  assert.deepEqual(rankInstances([null, {}, { host: '' }], ''), []);
});

// --- tab title ------------------------------------------------------------------------------------------------

test('the title prefix is added once, replaced on a rename and removed on stop', () => {
  assert.equal(titleWithPrefix('Incidents', '[DEV] '), '[DEV] Incidents');
  assert.equal(titleWithPrefix('[DEV] Incidents', '[DEV] '), '[DEV] Incidents');
  assert.equal(titleWithPrefix('[DEV] Incidents', '[QA] ', '[DEV] '), '[QA] Incidents');
  assert.equal(titleWithPrefix('Incidents', '[QA] ', '[DEV] '), '[QA] Incidents');
  assert.equal(titleWithoutPrefix('[QA] Incidents', '[QA] '), 'Incidents');
  assert.equal(titleWithoutPrefix('Incidents', '[QA] '), 'Incidents');
  assert.equal(titleWithoutPrefix('Incidents', ''), 'Incidents');
});
