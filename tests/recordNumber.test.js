const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRecordNumber, tablesForNumber } = require('../src/lib/recordNumber.js');

test('record numbers are recognised and normalised to upper case', () => {
  assert.equal(parseRecordNumber('INC0010001'), 'INC0010001');
  assert.equal(parseRecordNumber('  chg0030002 '), 'CHG0030002');
  assert.equal(parseRecordNumber('STRY0012345'), 'STRY0012345');
  assert.equal(parseRecordNumber('KB0000015'), 'KB0000015');
});

test('things that are not record numbers are left to the other lookups', () => {
  assert.equal(parseRecordNumber('incident'), '');
  assert.equal(parseRecordNumber('1452ad185364101042a9ddeeff7b12b9'), '', 'a sys_id');
  assert.equal(parseRecordNumber('INC123'), '', 'too few digits');
  assert.equal(parseRecordNumber('INC 0010001'), '');
  assert.equal(parseRecordNumber("INC0010001^active=true"), '', 'no query syntax gets through');
  assert.equal(parseRecordNumber(null), '');
});

test('knowledge numbers look in kb_knowledge first, everything else in task first', () => {
  assert.deepEqual(tablesForNumber('KB0000015'), ['kb_knowledge', 'task']);
  assert.deepEqual(tablesForNumber('INC0010001'), ['task', 'kb_knowledge']);
});
