const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSteps, isRiskyLabel, normalizeRun, extractStepsText } = require('../src/lib/automation.js');

test('newtab and switchtab are validated', () => {
  const ok = parseSteps('newtab /sys_user_list.do\nswitchtab 2');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.steps.map((s) => [s.action, s.target]), [['newtab', '/sys_user_list.do'], ['switchtab', '2']]);
  assert.equal(parseSteps('newtab https://evil.example').errors.length, 1);
  assert.equal(parseSteps('switchtab zero').errors.length, 1);
  assert.equal(parseSteps('switchtab 0').errors.length, 1);
});

test('extractStepsText takes the first code block or the whole reply', () => {
  assert.equal(extractStepsText('Sure:\n```\ngoto /a.do\nclick #b\n```\nDone'), 'goto /a.do\nclick #b');
  assert.equal(extractStepsText('goto /a.do'), 'goto /a.do');
});

test('parses one step per line, skipping blanks and comments', () => {
  const { steps, errors } = parseSteps(
    ['# open incidents', 'goto /incident_list.do', '', 'click text:New', 'type #a = hello = world', 'select #b = 2', 'waitfor .row', 'wait 500'].join('\n')
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(steps.map((s) => s.action), ['goto', 'click', 'type', 'select', 'waitfor', 'wait']);
  assert.equal(steps[2].value, 'hello = world');
  assert.equal(steps[5].value, '500');
});

test('accepts a JSON array', () => {
  const { steps, errors } = parseSteps('[{"action":"click","target":"#go"}]');
  assert.deepEqual(errors, []);
  assert.equal(steps[0].target, '#go');
});

test('reports bad lines without dropping good ones', () => {
  const { steps, errors } = parseSteps('goto https://evil.example\nfly away\ntype #a\nclick #ok');
  assert.equal(steps.length, 1);
  assert.deepEqual(errors.map((e) => e.line), [1, 2, 3]);
});

test('goto rejects off-instance and traversal targets', () => {
  for (const target of ['//evil.example', 'http://evil.example', '/a/../b']) {
    assert.equal(parseSteps(`goto ${target}`).errors.length, 1, target);
  }
});

test('flags data-changing labels as risky', () => {
  assert.ok(isRiskyLabel('sysverb_update Save'));
  assert.ok(isRiskyLabel('Delete'));
  assert.ok(!isRiskyLabel('Next'));
});

test('normalizeRun rejects malformed runs', () => {
  assert.equal(normalizeRun({ steps: [{ action: 'nope' }], index: 0 }), null);
  assert.equal(normalizeRun({ steps: [{ action: 'click', target: '#a' }], index: 5 }), null);
  assert.ok(normalizeRun({ steps: [{ action: 'click', target: '#a' }], index: 1 }));
});
