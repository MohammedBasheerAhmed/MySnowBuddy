const test = require('node:test');
const assert = require('node:assert/strict');

test('switching the update set sends { sysId }, the body the platform picker accepts (sysparm_sys_id answered 400 "Missing sys_id")', async () => {
  const { setCurrentUpdateSet, setCurrentApplication } = require('../src/content/quickActions.js');
  const calls = [];
  const realFetch = global.fetch;
  const realDocument = global.document;
  // The session token comes from the page: a hidden sysparm_ck input is enough for the markup fallback.
  global.document = {
    querySelector: (selector) => (selector.includes('sysparm_ck') ? { value: 'test-token' } : null),
    getElementById: () => null,
    scripts: [],
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  };
  global.fetch = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"result":{"success":true}}', json: async () => ({ result: { success: true } }) };
  };
  try {
    const id = 'cd26859d9308db107b9cf1965d03d637';
    await setCurrentUpdateSet(id, 'token');
    await setCurrentApplication('global', 'token');
    const set = calls.find((c) => c.url.includes('/concoursepicker/updateset'));
    const app = calls.find((c) => c.url.includes('/concoursepicker/application'));
    assert.equal(set.method, 'PUT');
    assert.deepEqual(set.body, { sysId: id });
    assert.deepEqual(app.body, { app_id: 'global' });
  } finally {
    global.fetch = realFetch;
    global.document = realDocument;
  }
});
