const test = require('node:test');
const assert = require('node:assert/strict');
const { newRun, reduceRun, summarizeResult, toolLabel, toolIcon } = require('../src/lib/agent/runState.js');
const { toModelText, redactDeep } = require('../src/lib/agent/agentLoop.js');
const { TOOL_SCHEMAS } = require('../src/lib/agent/toolSchemas.js');

const play = (events) => events.reduce(reduceRun, newRun('r1', { id: 'client-script', title: 'Client Script' }));

test('a tool call moves through running -> awaiting -> ok with a summary', () => {
  const run = play([
    { type: 'thinking' },
    { type: 'assistant_text', text: 'Let me look.', final: false },
    { type: 'tool_start', id: 't1', tool: 'get_schema', args: { table: 'incident' }, mode: 'auto' },
    { type: 'tool_result', id: 't1', tool: 'get_schema', ok: true, data: { fieldCount: 14 }, text: '{...}' },
    { type: 'tool_start', id: 't2', tool: 'save_artifact', args: { table: 'sys_script_client', fields: { name: 'X', script: 'a'.repeat(5000) } }, mode: 'ask' },
    { type: 'approval_request', id: 't2' },
  ]);
  assert.equal(run.steps.length, 3);
  assert.equal(run.steps[0].kind, 'note');
  assert.equal(run.steps[1].status, 'ok');
  assert.equal(run.steps[1].summary, '14 fields');
  assert.equal(run.steps[1].title, 'Reading the incident dictionary');
  assert.equal(run.steps[2].status, 'awaiting');
  assert.ok(run.steps[2].args.fields.script.length < 600, 'long scripts are clipped before they are persisted');
  assert.equal(run.thinking, false);
});

test('declined, failed and finished runs', () => {
  const run = play([
    { type: 'tool_start', id: 'a', tool: 'save_form', args: {}, mode: 'ask' },
    { type: 'approval_request', id: 'a' },
    { type: 'approval_result', id: 'a', approved: false },
    { type: 'tool_result', id: 'a', tool: 'save_form', ok: false, denied: true, text: 'The user declined' },
    { type: 'tool_start', id: 'b', tool: 'query_table', args: { table: 'x' }, mode: 'auto' },
    { type: 'tool_result', id: 'b', tool: 'query_table', ok: false, text: 'Error: table not readable' },
    { type: 'done', stopped: 'done' },
  ]);
  assert.equal(run.steps[0].status, 'declined');
  assert.equal(run.steps[1].status, 'failed');
  assert.match(run.steps[1].summary, /not readable/);
  assert.equal(run.status, 'done');
  assert.equal(play([{ type: 'done', stopped: 'aborted' }]).status, 'aborted');
  assert.equal(play([{ type: 'limit', maxSteps: 3 }, { type: 'done', stopped: 'limit' }]).status, 'limit');
});

test('approval previews attach to their step; unknown events are ignored', () => {
  const run = play([{ type: 'tool_start', id: 'p', tool: 'set_form_field', args: { name: 'script' }, mode: 'ask' }, { type: 'approval_preview', id: 'p', preview: { before: 'a', after: 'b' } }, { type: 'mystery' }]);
  assert.deepEqual(run.steps[0].preview, { before: 'a', after: 'b' });
});

test('every tool has a label and icon, and results summarise safely', () => {
  for (const t of TOOL_SCHEMAS) {
    assert.ok(toolLabel(t.name, {}) && toolLabel(t.name, {}) !== '', t.name);
    assert.notEqual(toolIcon(t.name), 'tool', `${t.name} should have its own icon`);
  }
  assert.equal(summarizeResult('query_table', { returned: 1 }), '1 row');
  assert.equal(summarizeResult('count_records', { count: 7 }), '7 records');
  assert.equal(summarizeResult('verify_script', undefined), '');
  assert.equal(summarizeResult('get_schema', { nope: true }), 'undefined fields'); // never throws
});

test('secrets are redacted by key and inside script text', () => {
  const text = toModelText({
    api_key: 'abcd1234efgh',
    password: 'swordfish99',
    script: 'var password = "hunter2hunter2"; // has an s',
    note: 'plain text with spaces is kept',
    nested: { client_secret: 'topsecretvalue' },
  });
  assert.ok(!text.includes('abcd1234efgh') && !text.includes('swordfish99') && !text.includes('hunter2') && !text.includes('topsecretvalue'));
  assert.ok(text.includes('plain text with spaces is kept'));
  assert.deepEqual(redactDeep({ token: 'abc def ghi' }), { token: 'abc def ghi' }); // a sentence under a "token" key is not a secret
});
