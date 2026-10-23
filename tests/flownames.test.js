const test = require('node:test');
const assert = require('node:assert/strict');
const { withFlowNames } = require('../src/content/flowNames.js');

const ID = '0335e63573333300e289235f04f6a70f';
const ID2 = 'fedcba9876543210fedcba9876543210';
const cell = (value, display = value) => ({ value, display_value: display });

/** A table reader that answers sys_hub_flow from a fixed list and records what it was asked. */
function reader(flows, calls = []) {
  const read = async (table, query, fields, options) => {
    calls.push({ table, query, fields, options });
    return flows;
  };
  return { read, calls };
}

test('a flow context with no name gets the name of its flow, in the shape of the row it came from', async () => {
  const { read, calls } = reader([{ sys_id: ID, name: 'SLA notification and escalation flow' }]);
  const rows = [{ sys_id: cell('a'), name: cell(''), flow: cell(ID) }, { sys_id: cell('b'), name: cell('Own name'), flow: cell(ID2) }];
  const out = await withFlowNames(rows, read);
  assert.deepEqual(out[0].name, { value: 'SLA notification and escalation flow', display_value: 'SLA notification and escalation flow' });
  assert.equal(out[1], rows[1], 'a row that already has a name is returned as it was');
  assert.equal(calls.length, 1, 'one lookup for all the rows');
  assert.equal(calls[0].table, 'sys_hub_flow');
  assert.equal(calls[0].query, `sys_idIN${ID}`, 'only the ids that need a name are asked for');
});

test('plain-string rows get a plain-string name', async () => {
  const { read } = reader([{ sys_id: ID, name: 'Flow A' }]);
  const out = await withFlowNames([{ name: '', flow: ID }], read);
  assert.equal(out[0].name, 'Flow A');
});

test('the same flow is looked up once, and nothing is asked when nothing is missing', async () => {
  const first = reader([{ sys_id: ID, name: 'Flow A' }]);
  const out = await withFlowNames([{ name: '', flow: ID }, { name: '', flow: ID }], first.read);
  assert.equal(first.calls[0].query, `sys_idIN${ID}`);
  assert.deepEqual(out.map((r) => r.name), ['Flow A', 'Flow A']);

  const none = reader([]);
  const rows = [{ name: 'Named', flow: ID }, { name: '', flow: 'not an id' }, { name: '', flow: '' }];
  assert.equal(await withFlowNames(rows, none.read), rows);
  assert.equal(none.calls.length, 0);
});

test('a lookup that fails or finds nothing leaves the rows alone', async () => {
  const rows = [{ name: '', flow: ID }];
  assert.equal(await withFlowNames(rows, async () => { throw new Error('ACL'); }), rows);
  const out = await withFlowNames(rows, async () => []);
  assert.deepEqual(out, rows);
});
