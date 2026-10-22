const test = require('node:test');
const assert = require('node:assert/strict');
const { tierFromSession, canSee, visibleTo, requiredTier, parseRoleList, tierNote } = require('../src/lib/roleTier.js');

test('the tier follows the roles: admin, developer, everyone else, unknown', () => {
  assert.equal(tierFromSession({ roles: ['itil'], admin: true }), 'admin');
  assert.equal(tierFromSession({ roles: ['itil', 'Admin'], admin: null }), 'admin');
  assert.equal(tierFromSession({ roles: ['itil', 'delegated_developer'], admin: false }), 'developer');
  assert.equal(tierFromSession({ roles: ['itil'], admin: false }), 'user');
  assert.equal(tierFromSession({ roles: [], admin: false }), 'user');
  assert.equal(tierFromSession({ roles: ['x_acme_dev'] }, 'x_acme_dev, other'), 'developer');
  assert.equal(tierFromSession(null), null);
  assert.equal(tierFromSession({ admin: false }), null);
  assert.equal(tierFromSession({}), null);
});

test('each tier sees its own tools and the ones below; unknown sees all', () => {
  assert.equal(canSee('user', 'analyze.lint'), true);
  assert.equal(canSee('user', 'versions'), false);
  assert.equal(canSee('user', 'tools.impersonate'), false);
  assert.equal(canSee('developer', 'versions'), true);
  assert.equal(canSee('developer', 'tools.background'), false);
  assert.equal(canSee('admin', 'tools.background'), true);
  assert.equal(canSee(null, 'tools.background'), true);
  assert.equal(canSee('user', 'tools.endImpersonation'), true, 'a user must always be able to end an impersonation');
  assert.equal(requiredTier('something.new'), 'user');
});

test('visibleTo filters by id and leaves the list alone when the tier is unknown', () => {
  const items = [{ id: 'copyName' }, { id: 'dictionary' }, { id: 'copyValue' }];
  assert.deepEqual(visibleTo('user', items).map((i) => i.id), ['copyName', 'copyValue']);
  assert.equal(visibleTo(null, items), items);
});

test('role lists and notes', () => {
  assert.deepEqual(parseRoleList(' A, b  c ,,'), ['a', 'b', 'c']);
  assert.deepEqual(parseRoleList(['X', 'x']), ['x']);
  assert.match(tierNote('user'), /hidden/);
  assert.equal(tierNote('admin'), '');
  assert.equal(tierNote(null), '');
});

test('slash verbs follow the same tiers', () => {
  const { canUseSlash, slashTier } = require('../src/lib/roleTier.js');
  assert.equal(slashTier('inc'), 'user');
  assert.equal(slashTier('br'), 'developer');
  assert.equal(slashTier('bg'), 'admin');
  assert.equal(canUseSlash('user', 'tn'), true);
  assert.equal(canUseSlash('user', 'br'), false);
  assert.equal(canUseSlash('developer', 'bg'), false);
  assert.equal(canUseSlash('admin', 'bg'), true);
  assert.equal(canUseSlash(null, 'bg'), true);
});
