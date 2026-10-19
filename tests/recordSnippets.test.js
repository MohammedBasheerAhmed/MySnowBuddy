const test = require('node:test');
const assert = require('node:assert/strict');
const { restRecordUrl, glideRecordSnippet, recordJson } = require('../src/lib/recordSnippets.js');

const ID = '1452AD185364101042A9DDEEFF7B12B9';

test('the Table API URL carries the table and a lower-case sys_id, with no trailing slash on the origin', () => {
  assert.equal(
    restRecordUrl('https://dev1.service-now.com/', 'sys_script_include', ID),
    'https://dev1.service-now.com/api/now/table/sys_script_include/1452ad185364101042a9ddeeff7b12b9'
  );
});

test('the GlideRecord snippet loads the record by sys_id and is valid JavaScript', () => {
  const code = glideRecordSnippet('incident', ID);
  assert.match(code, /new GlideRecord\('incident'\)/);
  assert.match(code, /gr\.get\('1452ad185364101042a9ddeeff7b12b9'\)/);
  assert.doesNotThrow(() => new Function('GlideRecord', code)(function () { this.get = () => true; }));
});

test('snippets refuse a table or sys_id that is not safe to paste into code', () => {
  assert.throws(() => glideRecordSnippet("x');gs.print('", ID), /table name/);
  assert.throws(() => restRecordUrl('https://a.service-now.com', 'incident', '-1'), /sys_id/);
  assert.throws(() => glideRecordSnippet('incident', ''), /sys_id/);
});

test('record JSON keeps only fields that have a value', () => {
  const json = recordJson({ number: 'INC1', short_description: 'x', description: '', caller_id: null, state: '1' });
  assert.deepEqual(JSON.parse(json), { number: 'INC1', short_description: 'x', state: '1' });
  assert.equal(recordJson({ a: '' }), '');
  assert.equal(recordJson(null), '');
});
