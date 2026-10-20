const test = require('node:test');
const assert = require('node:assert/strict');
const { similarKeywords, similarQuery, rankSimilar } = require('../src/lib/similar.js');

test('keywords skip filler, short words and duplicates, longest first', () => {
  assert.deepEqual(similarKeywords('Unable to connect to the VPN from home: VPN drops every 10 minutes'), ['vpn', 'connect', 'minutes', 'drops']);
  assert.deepEqual(similarKeywords('It is not working'), []);
  assert.deepEqual(similarKeywords('Outlook outlook OUTLOOK keeps asking for password', 2), ['password', 'outlook']);
  assert.deepEqual(similarKeywords(''), []);
  assert.deepEqual(similarKeywords(null), []);
});

test('the query is an OR of LIKEs, excludes the record, and cannot be injected into', () => {
  assert.equal(similarQuery(['vpn', 'drops'], { excludeSysId: '0123456789abcdef0123456789abcdef' }), 'short_descriptionLIKEvpn^ORshort_descriptionLIKEdrops^sys_id!=0123456789abcdef0123456789abcdef^ORDERBYDESCsys_updated_on');
  assert.equal(similarQuery(['a^b=c'], {}), 'short_descriptionLIKEabc^ORDERBYDESCsys_updated_on', 'carets and equals are stripped from words');
  assert.equal(similarQuery(['vpn'], { excludeSysId: 'x^y' }), 'short_descriptionLIKEvpn^ORDERBYDESCsys_updated_on', 'a bad sys_id is not passed through');
  assert.equal(similarQuery([]), '');
});

test('hits are ranked by shared keywords, then by recency', () => {
  const rows = [
    { number: 'A', short_description: 'VPN drops', sys_updated_on: '2026-10-01 10:00:00' },
    { number: 'B', short_description: 'VPN drops every night', sys_updated_on: '2026-09-01 10:00:00' },
    { number: 'C', short_description: 'Printer jam', sys_updated_on: '2026-10-05 10:00:00' },
    { number: 'D', short_description: { display_value: 'vpn only', value: 'vpn only' }, sys_updated_on: { display_value: '2026-10-09 10:00:00' } },
  ];
  const ranked = rankSimilar(rows, ['vpn', 'drops', 'night']);
  assert.deepEqual(ranked.map((h) => h.row.number), ['B', 'A', 'D']);
  assert.deepEqual(ranked.map((h) => h.shared), [3, 2, 1]);
});
