const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classify,
  selectionCandidate,
  parseJson,
  parseXml,
  decodeBase64Text,
  parseJwt,
  decodeUrlEncoded,
  parseEpoch,
  parseDateTime,
  tableCandidate,
  fieldCandidate,
  relativeTime,
  formatStamp,
  describeSelection,
  firstLocalKind,
  LOOKUP_KINDS,
} = require('../src/lib/smartSelect.js');

const NOW = new Date(Date.UTC(2026, 9, 20, 12, 0, 0)); // 2026-10-20 12:00:00 UTC
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test('tiny and huge selections are never looked at', () => {
  assert.equal(selectionCandidate('  {} '), '');
  assert.equal(selectionCandidate('abc'), '');
  assert.equal(selectionCandidate(null), '');
  assert.equal(selectionCandidate('x'.repeat(60001)), '');
  assert.equal(selectionCandidate('  hello world  '), 'hello world');
  assert.deepEqual(classify('hello'), []);
});

test('ordinary prose and words stay quiet', () => {
  [
    'The quick brown fox jumps over the lazy dog',
    'Laptop will not boot',
    'incident',
    'priority',
    'internationalization',
    'caller',
    'Hello, world! How are you?',
    '12345',
    '4155551234',
    'user@example.com',
    'https://example.com/path',
    '2026-10-20',
    '1.2.3.4',
    'true',
    '{{variable}}',
    '[x]',
  ].forEach((text) => {
    assert.deepEqual(classify(text), [], text);
  });
});

test('a sys_id is reported alone and first so the existing peek keeps it', () => {
  assert.deepEqual(classify('0123456789abcdef0123456789abcdef'), ['sysid']);
  assert.deepEqual(classify(' 0123456789ABCDEF0123456789ABCDEF '), ['sysid']);
  assert.equal(firstLocalKind(['sysid']), '');
});

test('JSON: objects and arrays that really parse', () => {
  assert.deepEqual(classify('{"a":1,"b":[1,2]}'), ['json']);
  assert.deepEqual(classify('[{"a":1},{"a":2}]'), ['json']);
  assert.deepEqual(classify('  {\n "name": "x"\n}\n'), ['json']);
  assert.equal(parseJson('{"a":'), null, 'truncated');
  assert.equal(parseJson('{}'), null, 'empty');
  assert.equal(parseJson('[]'), null);
  assert.equal(parseJson('"just a string"'), null);
  assert.equal(parseJson('{a:1}'), null, 'not strict JSON');
  assert.equal(parseJson('[1]'), null, 'too small to bother');
});

test('JSON description: pretty, minified, key rows, clipped body', () => {
  const d = describeSelection('{"number":"INC1","state":2,"nested":{"a":1},"list":[1,2,3],"n":null}', 'json');
  assert.equal(d.title, 'JSON');
  assert.equal(d.subtitle, '5 keys');
  assert.deepEqual(d.rows.map((r) => r.label), ['number', 'state', 'nested', 'list', 'n']);
  assert.equal(d.rows[0].value, '"INC1"');
  assert.equal(d.rows[2].value, 'object (1 key)');
  assert.equal(d.rows[3].value, 'array (3 items)');
  assert.equal(d.rows[4].value, 'null');
  assert.equal(d.texts.minified, '{"number":"INC1","state":2,"nested":{"a":1},"list":[1,2,3],"n":null}');
  assert.match(d.texts.pretty, /^\{\n {2}"number": "INC1",/);
  const big = JSON.stringify(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'v'.repeat(200)])));
  const dBig = describeSelection(big, 'json');
  assert.equal(dBig.rows.length, 9, 'eight keys and a "more" row');
  assert.match(dBig.body, /more characters\)$/);
  assert.equal(dBig.texts.pretty.length > dBig.body.length, true, 'copy gets everything, the popover a clip');
  const arr = describeSelection('[{"a":1},{"a":2}]', 'json');
  assert.equal(arr.subtitle, '2 items');
  assert.equal(arr.rows[0].label, '[0]');
});

test('XML: well-formed documents only', () => {
  assert.deepEqual(classify('<incident><number>INC1</number></incident>'), ['xml']);
  assert.deepEqual(classify('<?xml version="1.0"?><response><result/></response>'), ['xml']);
  assert.deepEqual(classify('<a href="x">link</a>'), ['xml']);
  assert.equal(parseXml('<a><b></a>'), null, 'bad nesting');
  assert.equal(parseXml('<a></a><b></b>'), null, 'two roots');
  assert.equal(parseXml('<a>1 < 2</a>'), null, 'stray <');
  assert.equal(parseXml('<a>'), null, 'unclosed');
  assert.equal(parseXml('text <a></a>'), null);
  assert.equal(parseXml('<br>'), null, 'too short and unclosed');
  assert.deepEqual(classify('a < b and c > d, so what'), []);
});

test('XML pretty-print and minify', () => {
  const x = parseXml('<response><result><number>INC1</number><state>2</state></result><empty/></response>');
  assert.equal(x.root, 'response');
  assert.equal(x.elements, 5);
  assert.equal(x.pretty, '<response>\n  <result>\n    <number>INC1</number>\n    <state>2</state>\n  </result>\n  <empty/>\n</response>');
  const spaced = parseXml('<a>\n  <b>one</b>\n  <!-- note -->\n  <c> two </c>\n</a>');
  assert.equal(spaced.minified, '<a><b>one</b><c>two</c></a>');
  assert.match(spaced.pretty, /<!-- note -->/);
  const d = describeSelection('<a><b>x</b></a>', 'xml');
  assert.equal(d.subtitle, '<a> · 2 elements');
  assert.equal(d.texts.minified, '<a><b>x</b></a>');
});

test('Base64: only when it decodes to readable text', () => {
  const text = 'Hello, ServiceNow world';
  assert.deepEqual(classify(b64(text)), ['base64']);
  assert.equal(decodeBase64Text(b64(text)), text);
  assert.equal(decodeBase64Text(b64('héllo wörld ✓')), 'héllo wörld ✓', 'UTF-8');
  const urlSafe = b64('subjects?_d=1>>>>').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(decodeBase64Text(urlSafe), 'subjects?_d=1>>>>', 'base64url without padding');
  assert.equal(decodeBase64Text('internationalization'), null, 'a long word that happens to be valid Base64 characters');
  assert.equal(decodeBase64Text('0123456789abcdef0123456789abcdef'), null, 'hex');
  assert.equal(decodeBase64Text('1234567890123456'), null, 'digits');
  assert.equal(decodeBase64Text(Buffer.from([0, 1, 2, 3, 255, 254, 253, 252, 0, 9, 8, 7]).toString('base64')), null, 'binary');
  assert.equal(decodeBase64Text('SGVsbG8='), null, 'too short to be sure');
  assert.equal(decodeBase64Text('not base64 at all!!'), null);
  assert.equal(decodeBase64Text('QWxhZGRpbjpvcGVuIHNlc2FtZQ'), null, 'standard Base64 must be padded');
});

test('Base64 that holds JSON or XML is pretty-printed', () => {
  const json = describeSelection(b64('{"user":"abel","roles":["itil","admin"]}'), 'base64');
  assert.match(json.subtitle, /\(JSON\)/);
  assert.match(json.body, /^\{\n {2}"user": "abel"/);
  assert.equal(json.texts.decoded, '{"user":"abel","roles":["itil","admin"]}');
  const xml = describeSelection(b64('<a><b>x</b></a>'), 'base64');
  assert.match(xml.subtitle, /\(XML\)/);
  const plain = describeSelection(b64('just some words here'), 'base64');
  assert.equal(plain.body, 'just some words here');
  assert.match(plain.subtitle, /20 characters/);
});

test('JWT: decoded, never verified', () => {
  assert.deepEqual(classify(JWT), ['jwt']);
  const jwt = parseJwt(JWT);
  assert.equal(jwt.header.alg, 'HS256');
  assert.equal(jwt.payload.name, 'John Doe');
  assert.equal(parseJwt('a.b.c'), null);
  assert.equal(parseJwt('eyJhbGciOiJIUzI1NiJ9.notjson.sig'), null);
  assert.equal(parseJwt('one.two'), null);
  const d = describeSelection(JWT, 'jwt', { now: NOW, timeZone: 'UTC' });
  assert.equal(d.title, 'JSON Web Token');
  assert.match(d.subtitle, /signature not checked/);
  assert.equal(d.rows[0].value, 'HS256');
  const issued = d.rows.find((r) => r.label === 'Issued');
  assert.equal(issued.value.startsWith('2018-01-18 01:30:22'), true);
  assert.match(issued.value, /years? ago/);
});

test('URL-encoded text', () => {
  assert.deepEqual(classify('active%3Dtrue%5Epriority%3D1'), ['urlencoded']);
  assert.equal(decodeUrlEncoded('active%3Dtrue%5Epriority%3D1'), 'active=true^priority=1');
  assert.equal(decodeUrlEncoded('a%20b'), null, 'one escape is ordinary');
  assert.equal(decodeUrlEncoded('hello world %20 %21'), null, 'whitespace means prose');
  assert.equal(decodeUrlEncoded('%E0%A4%A%%'), null, 'malformed');
  assert.equal(decodeUrlEncoded('plain-text-without-escapes'), null);
  assert.equal(decodeUrlEncoded('name%3Dabel+tuter%26x%3D1'), 'name=abel tuter&x=1');
  assert.equal(describeSelection('active%3Dtrue%5Epriority%3D1', 'urlencoded').body, 'active=true^priority=1');
});

test('epoch seconds and milliseconds, within a believable range', () => {
  assert.deepEqual(classify('1760961600'), ['epoch']);
  assert.deepEqual(classify('1760961600000'), ['epoch']);
  assert.equal(parseEpoch('1760961600').unit, 'seconds');
  assert.equal(parseEpoch('1760961600000').unit, 'milliseconds');
  assert.equal(parseEpoch('4155551234'), null, 'a phone number is not 2101');
  assert.equal(parseEpoch('0123456789'), null, 'too early');
  assert.equal(parseEpoch('176096160'), null, '9 digits');
  assert.equal(parseEpoch('17609616000'), null, '11 digits');
  assert.equal(parseEpoch('1760961600.5'), null);
  const d = describeSelection('1760961600', 'epoch', { now: NOW, timeZone: 'Asia/Kolkata' });
  assert.equal(d.title, 'Epoch seconds');
  assert.deepEqual(
    d.rows.map((r) => [r.label, r.value]),
    [
      ['Your time', '2025-10-20 17:30:00'],
      ['UTC', '2025-10-20 12:00:00'],
      ['When', '1 year ago'],
    ]
  );
  assert.equal(d.texts.iso, '2025-10-20T12:00:00.000Z');
});

test('ServiceNow date-times read both ways', () => {
  assert.deepEqual(classify('2026-10-19 09:30:15'), ['datetime']);
  assert.deepEqual(classify('2026-10-19T09:30:15Z'), ['datetime']);
  assert.equal(parseDateTime('2026-13-19 09:30:15'), null, 'month 13');
  assert.equal(parseDateTime('2026-02-31 09:30:15'), null, 'no 31st of February');
  assert.equal(parseDateTime('2026-10-19 24:00:00'), null);
  assert.equal(parseDateTime('2026-10-19'), null, 'a bare date is ordinary text');
  const d = describeSelection('2026-10-19 09:30:15', 'datetime', { now: NOW, timeZone: 'Asia/Kolkata' });
  assert.equal(d.rows.length, 1, 'with a fixed zone only the UTC reading is shown');
  assert.equal(d.rows[0].value, '2026-10-19 15:00:15 your time (1 day ago)');
  const local = describeSelection('2026-10-19 09:30:15', 'datetime', { now: NOW });
  assert.equal(local.rows.length, 2);
  assert.equal(local.rows[0].label, 'If it is UTC');
  assert.equal(local.rows[1].label, 'If it is your time');
});

test('record numbers, tables and fields are candidates the instance must confirm', () => {
  assert.deepEqual(classify('INC0010001'), ['recordNumber']);
  assert.deepEqual(classify('chg0030002'), ['recordNumber']);
  assert.deepEqual(classify('sys_user_group'), ['table']);
  assert.deepEqual(classify('cmdb_ci_server'), ['table']);
  assert.deepEqual(classify('incident.caller_id'), []);
  assert.deepEqual(classify('sys_user.user_name'), ['field']);
  assert.equal(tableCandidate('sys_user'), 'sys_user');
  assert.equal(tableCandidate('incident'), '', 'a plain word is ordinary text');
  assert.equal(tableCandidate('Sys_User'), '');
  assert.equal(tableCandidate('sys__user'), '');
  assert.equal(tableCandidate('sys_'), '');
  assert.equal(tableCandidate('a_b'), '', 'too short');
  assert.deepEqual(fieldCandidate('sys_user.user_name'), { table: 'sys_user', field: 'user_name' });
  assert.equal(fieldCandidate('example.com'), null);
  assert.equal(fieldCandidate('file.name'), null);
  ['recordNumber', 'table', 'field'].forEach((k) => assert.equal(LOOKUP_KINDS.has(k), true));
  assert.equal(firstLocalKind(['recordNumber', 'json']), 'json');
  assert.equal(firstLocalKind(['table']), '');
});

test('the most specific reading comes first and a record number is not Base64', () => {
  assert.deepEqual(classify('INC0010001'), ['recordNumber']);
  assert.deepEqual(classify('{"a":"INC0010001"}'), ['json']);
  assert.deepEqual(classify(b64('{"a":1,"b":2}')), ['base64']);
});

test('callers can add detectors, and a broken one cannot break the rest', () => {
  const extra = [
    { kind: 'query', detect: (t) => t.includes('^') },
    {
      kind: 'boom',
      detect: () => {
        throw new Error('x');
      },
    },
  ];
  assert.deepEqual(classify('active=true^priority=1', { extra }), ['query']);
  assert.deepEqual(classify('{"a":1,"b":2}', { extra }), ['json']);
  assert.deepEqual(classify('plain words here', { extra }), []);
});

test('relative times and stamps', () => {
  const at = (ms) => new Date(NOW.getTime() + ms);
  assert.equal(relativeTime(at(0), NOW), 'just now');
  assert.equal(relativeTime(at(-30000), NOW), 'just now');
  assert.equal(relativeTime(at(-5 * 60000), NOW), '5 minutes ago');
  assert.equal(relativeTime(at(-3600000), NOW), '1 hour ago');
  assert.equal(relativeTime(at(2 * 3600000), NOW), 'in 2 hours');
  assert.equal(relativeTime(at(-3 * 86400000), NOW), '3 days ago');
  assert.equal(relativeTime(at(40 * 86400000), NOW), 'in 1 month');
  assert.equal(relativeTime(at(-800 * 86400000), NOW), '2 years ago');
  assert.equal(formatStamp(NOW, 'UTC'), '2026-10-20 12:00:00');
  assert.equal(formatStamp(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)), 'UTC'), '2026-01-01 00:00:00', 'midnight is 00, not 24');
});

test('describeSelection answers null for a kind the text is not', () => {
  assert.equal(describeSelection('hello world', 'json'), null);
  assert.equal(describeSelection('hello world', 'xml'), null);
  assert.equal(describeSelection('hello world', 'epoch'), null);
  assert.equal(describeSelection('hello world', 'nonsense'), null);
  assert.equal(describeSelection('', 'json'), null);
});
