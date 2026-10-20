const test = require('node:test');
const assert = require('node:assert/strict');

const ME = '6816f79cc0a8016401c5a33be04be441';
const ABEL = '62826bf03710200044e0bfc8bcbe5df1';
const OTHER = '11111111111111111111111111111111';

// A tiny instance: who the session is, the calls made, and a chrome.storage.local that survives between calls.
function setup(sessionUser = ME) {
  const state = { user: sessionUser, calls: [], store: {} };
  const reply = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
  global.window = { location: { hostname: 'dev1.service-now.com' } };
  global.document = { querySelector: (s) => (s.includes('sysparm_ck') ? { value: 'test-token' } : null), getElementById: () => null, scripts: [], addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };
  global.chrome = { storage: { local: { get: async (k) => ({ [k]: state.store[k] }), set: async (o) => Object.assign(state.store, o) } } };
  global.fetch = async (url, init = {}) => {
    state.calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    const m = /\/api\/now\/ui\/impersonate\/([0-9a-f]{32})$/.exec(String(url));
    if (m) {
      state.user = m[1];
      return reply({ result: { impersonatedUser: m[1] } }, 201);
    }
    if (String(url).includes('/api/now/table/sys_user')) return reply({ result: [{ sys_id: state.user, user_name: 'x' }] });
    return reply({ error: { message: 'unexpected ' + url } }, 404);
  };
  return state;
}

test('starting impersonation posts to the impersonate API and remembers who you were', async () => {
  const state = setup();
  const { startImpersonating } = require('../src/content/impersonation.js');
  await startImpersonating(ABEL);
  const post = state.calls.find((c) => c.method === 'POST');
  assert.equal(post.url, `/api/now/ui/impersonate/${ABEL}`);
  assert.equal(state.user, ABEL);
  const saved = state.store.mysnowbuddy_impersonation_origin['dev1.service-now.com'];
  assert.deepEqual(saved, { origin: ME, impersonated: ABEL });
});

test('ending impersonation impersonates the remembered original user, then forgets it', async () => {
  const state = setup();
  const { startImpersonating, stopImpersonating } = require('../src/content/impersonation.js');
  await startImpersonating(ABEL);
  await stopImpersonating();
  assert.equal(state.user, ME, 'the session is back to the original user');
  assert.equal(state.store.mysnowbuddy_impersonation_origin['dev1.service-now.com'], undefined);
});

test('impersonating again while impersonating keeps the real user as the one to return to', async () => {
  const state = setup();
  const { startImpersonating, stopImpersonating } = require('../src/content/impersonation.js');
  await startImpersonating(ABEL);
  await startImpersonating(OTHER);
  await stopImpersonating();
  assert.equal(state.user, ME);
});

test('a stale remembered user (impersonation ended elsewhere) is replaced, not trusted', async () => {
  const state = setup(OTHER);
  state.store.mysnowbuddy_impersonation_origin = { 'dev1.service-now.com': { origin: ME, impersonated: ABEL } };
  const { startImpersonating, stopImpersonating } = require('../src/content/impersonation.js');
  await startImpersonating(ABEL);
  await stopImpersonating();
  assert.equal(state.user, OTHER, 'goes back to the user who really started it');
});

test('ending an impersonation NowBuddy did not start says how to end it by hand', async () => {
  setup();
  const { stopImpersonating } = require('../src/content/impersonation.js');
  await assert.rejects(stopImpersonating(), /avatar menu/);
});

test('impersonating yourself or a bad id is refused before any request', async () => {
  const state = setup();
  const { startImpersonating } = require('../src/content/impersonation.js');
  await assert.rejects(startImpersonating(ME), /already the session user/);
  await assert.rejects(startImpersonating('abc^x'), /Invalid user/);
  assert.equal(state.calls.some((c) => c.method === 'POST'), false);
});
