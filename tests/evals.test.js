// Offline eval: reference solutions must verify clean and behave correctly in
// the simulator; known-bad scripts must be caught by the named rule. Runs in
// `npm test`. The live model eval is `npm run eval -- --live`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CASES, checkExpectation } = require('./evals/cases.js');
const { verifyScript, formatVerification } = require('../src/lib/verify.js');
const { runClientScript } = require('../src/lib/mockForm.js');

const verifyInput = (c, code) => ({ code, kind: c.kind, when: c.when, clientType: c.clientType, table: c.table, fields: c.fields });

test('eval cases are well formed and cover both sides', () => {
  assert.ok(CASES.length >= 12);
  const ids = new Set();
  for (const c of CASES) {
    assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
    ids.add(c.id);
    assert.ok(c.prompt && c.solution && c.kind, c.id);
  }
  assert.ok(CASES.some((c) => c.side === 'client') && CASES.some((c) => c.side === 'server'));
});

for (const c of CASES) {
  test(`eval ${c.id}: the reference solution verifies clean`, () => {
    const result = verifyScript(verifyInput(c, c.solution));
    assert.equal(result.ok, true, `${c.id} should pass:\n${formatVerification(result)}`);
    // Warnings on a reference solution mean the verifier is too noisy or the solution is sloppy.
    assert.deepEqual(result.findings.filter((f) => f.severity === 'medium'), [], `${c.id} has warnings:\n${formatVerification(result)}`);
  });

  for (const s of c.scenarios || []) {
    test(`eval ${c.id}: simulator - ${s.name}`, async () => {
      const run = await runClientScript({ code: c.solution, clientType: c.clientType, scenario: s.scenario });
      assert.deepEqual(checkExpectation(run, s.expect), [], JSON.stringify(run.calls));
    });
  }

  for (const b of c.bad || []) {
    test(`eval ${c.id}: catches "${b.why}"`, () => {
      const result = verifyScript(verifyInput(c, b.code));
      assert.ok(result.findings.some((f) => f.ruleId === b.rule), `expected ${b.rule}, got:\n${formatVerification(result)}`);
    });
  }
}
