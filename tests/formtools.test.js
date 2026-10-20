const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSecretField,
  safeValue,
  valuesObject,
  valuesJson,
  valuesMarkdown,
  jsString,
  setValuesScript,
  duplicateFields,
  duplicateUrl,
  queryValue,
  skippedNote,
  highlightStates,
  highlightSummary,
  openAsUrl,
  hiddenLabel,
  MAX_URL_CHARS,
} = require('../src/lib/formTools.js');

const SYS_ID = '0123456789abcdef0123456789abcdef';
const F = (name, value, extra = {}) => ({ name, label: name.replace(/_/g, ' '), type: 'string', value, display: '', mandatory: false, readOnly: false, ...extra });

const FORM = [
  F('number', 'INC0010042', { readOnly: true }),
  F('short_description', 'VPN drops | every "10" minutes'),
  F('caller_id', '62826bf03710200044e0bfc8bcbe5df1', { type: 'reference', display: 'Abel Tuter' }),
  F('priority', '2'),
  F('state', '', {}),
  F('sys_created_on', '2026-10-01 10:00:00', { readOnly: true }),
  F('opened_at', '2026-10-01 10:00:00', { type: 'glide_date_time' }),
  F('work_notes', 'internal', { type: 'journal_input' }),
  F('u_api_key', 'abc123def456ghi789', {}),
  F('description', 'Line one\nLine two with a ^ caret and = sign'),
  F('assignment_group', '', { mandatory: true }),
];

test('secrets are recognised by name and by dictionary type, and never leave as values', () => {
  assert.equal(isSecretField(F('u_api_key', 'x')), true);
  assert.equal(isSecretField(F('client_secret', 'x')), true);
  assert.equal(isSecretField(F('u_label', 'x', { type: 'password2' })), true);
  assert.equal(isSecretField(F('u_label', 'x', { type: 'password' })), true);
  assert.equal(isSecretField(F('short_description', 'x')), false);
  assert.equal(safeValue(F('u_api_key', 'abc')), '[REDACTED]');
  assert.equal(safeValue(F('short_description', '')), '');
  assert.equal(safeValue(F('description', 'call with password=hunter2abc now')).includes('hunter2abc'), false, 'redactSecrets runs on ordinary values too');
});

test('JSON holds the non-empty fields in form order with secrets redacted', () => {
  const obj = valuesObject(FORM);
  assert.equal(obj.state, undefined, 'empty fields are left out');
  assert.equal(obj.u_api_key, '[REDACTED]');
  assert.equal(obj.caller_id, '62826bf03710200044e0bfc8bcbe5df1');
  assert.deepEqual(Object.keys(obj).slice(0, 2), ['number', 'short_description']);
  assert.equal(JSON.parse(valuesJson(FORM)).priority, '2');
  assert.equal(valuesJson([F('a', '')]), '');
  assert.equal(valuesJson(null), '');
});

test('the Markdown table escapes pipes and newlines and shows display values only when they add something', () => {
  const md = valuesMarkdown(FORM, { table: 'incident' });
  const lines = md.split('\n');
  assert.equal(lines[0], '**incident**');
  assert.ok(lines.some((l) => l.startsWith('| Label | Name |')));
  const sd = lines.find((l) => l.includes('`short_description`'));
  assert.ok(sd.includes('VPN drops \\| every "10" minutes'), sd);
  const desc = lines.find((l) => l.includes('`description`'));
  assert.ok(desc.includes('Line one Line two'), 'one table row per field');
  const caller = lines.find((l) => l.includes('`caller_id`'));
  assert.ok(caller.endsWith('| Abel Tuter |'), caller);
  const key = lines.find((l) => l.includes('`u_api_key`'));
  assert.ok(key.includes('[REDACTED]') && !key.includes('abc123'), key);
  assert.equal(valuesMarkdown([F('a', '')]), '');
});

test('string literals in the generated script are escaped', () => {
  assert.equal(jsString("it's a \\ test\nnext"), "'it\\'s a \\\\ test\\nnext'");
});

test('the set-values script skips system, read-only and secret fields and leaves the insert commented', () => {
  const script = setValuesScript('incident', FORM);
  assert.ok(script.startsWith("var gr = new GlideRecord('incident');\ngr.initialize();"));
  assert.ok(script.includes("gr.setValue('short_description', 'VPN drops | every \"10\" minutes');"));
  assert.ok(script.includes("gr.setValue('caller_id', '62826bf03710200044e0bfc8bcbe5df1');"));
  assert.ok(!script.includes("'number'") && !script.includes('sys_created_on') && !script.includes('abc123'));
  assert.ok(script.includes('// var sysId = gr.insert();') && !/^gr\.insert/m.test(script));
  assert.ok(script.includes('Left out because they hold secrets: u_api_key'));
  assert.ok(script.includes('Line one\\nLine two with a ^ caret'), 'newlines are escaped, not literal');
  assert.throws(() => setValuesScript('bad table', FORM), /table name/);
});

test('a duplicate keeps what a new record can take and says what it dropped', () => {
  const { included, skipped } = duplicateFields(FORM);
  assert.deepEqual(included.map((f) => f.name), ['short_description', 'caller_id', 'priority', 'description']);
  const reasons = Object.fromEntries(skipped.map((s) => [s.name, s.reason]));
  assert.deepEqual(reasons, { opened_at: 'date', work_notes: 'journal', u_api_key: 'secret' });
  // The auto-number and system columns are not worth a note.
  assert.ok(!('number' in reasons) && !('sys_created_on' in reasons));
  // A read-only field that is not a number is reported.
  assert.equal(duplicateFields([F('calendar_stc', '12', { readOnly: true })]).skipped[0].reason, 'read-only');
  // A name that is not an auto-number is kept.
  assert.equal(duplicateFields([F('number', 'seven')]).included.length, 1);
  assert.equal(duplicateFields([F('x', 'a'.repeat(1001))]).skipped[0].reason, 'too long');
});

test('the prefilled URL encodes carets, equals signs, newlines and dots safely', () => {
  assert.equal(queryValue('a^b'), 'a^^b');
  const { url, included } = duplicateUrl('incident', FORM);
  assert.ok(url.startsWith('/incident.do?sys_id=-1&sysparm_query='));
  assert.ok(!url.includes('..') && !/[\s^]/.test(url), 'nothing the navigation guard or a browser would trip on');
  const decoded = decodeURIComponent(url.split('sysparm_query=')[1]);
  // "^" separates conditions; "^^" is a literal caret inside a value.
  const conditions = decoded.replace(/\^\^/g, '\u0001').split('^').map((c) => c.split('\u0001').join('^'));
  assert.deepEqual(conditions.map((c) => c.split('=')[0]), included);
  const description = conditions.find((c) => c.startsWith('description='));
  assert.equal(description, 'description=Line one\nLine two with a ^ caret and = sign');
  assert.ok(conditions.includes('priority=2'));
  assert.throws(() => duplicateUrl('', FORM), /table name/);
});

test('a duplicate never builds a URL longer than the cap; the rest is reported', () => {
  const many = Array.from({ length: 40 }, (_, i) => F(`u_field_${i}`, 'x'.repeat(400)));
  const { url, included, skipped } = duplicateUrl('incident', many);
  assert.ok(url.length <= MAX_URL_CHARS, `${url.length}`);
  assert.ok(included.length > 0 && included.length < 40);
  assert.equal(skipped.filter((s) => s.reason === 'too long').length, 40 - included.length);
  const wholeValues = decodeURIComponent(url.split('sysparm_query=')[1]).split('^').every((c) => /^u_field_\d+=x{400}$/.test(c));
  assert.ok(wholeValues, 'a value is either all there or not there');
});

test('the note about what was left out is short and plain', () => {
  assert.equal(skippedNote([]), '');
  assert.equal(skippedNote([{ name: 'u_api_key', reason: 'secret' }, { name: 'opened_at', reason: 'date' }]), 'Left out: u_api_key holds a secret; opened_at is a date (its format differs).');
  assert.match(skippedNote(Array.from({ length: 7 }, (_, i) => ({ name: `f${i}`, reason: 'read-only' }))), /f0, f1, f2, f3 and 3 more is read-only/);
});

test('highlight states list changed, required and read-only, in that priority', () => {
  const fields = [F('a', '', { mandatory: true }), F('b', '', { readOnly: true }), F('c', '', { mandatory: true, readOnly: true }), F('d', '')];
  const states = highlightStates(fields, ['a', 'zzz']);
  assert.deepEqual([...states.entries()], [['a', ['changed', 'required']], ['b', ['read-only']], ['c', ['required', 'read-only']]]);
  assert.equal(highlightSummary(states), '2 required, 2 read-only, 1 changed.');
  assert.equal(highlightStates(null).size, 0);
});

test('open-as URLs need a saved record and a real table', () => {
  assert.deepEqual(openAsUrl('json', 'incident', SYS_ID.toUpperCase()), { url: `/api/now/table/incident/${SYS_ID}?sysparm_display_value=all`, raw: true });
  assert.deepEqual(openAsUrl('xml', 'incident', SYS_ID), { url: `/incident.do?sys_id=${SYS_ID}&XML`, raw: true });
  assert.throws(() => openAsUrl('json', 'incident', '-1'), /Save the record/);
  assert.throws(() => openAsUrl('json', 'a/b', SYS_ID), /table name/);
  assert.throws(() => openAsUrl('csv', 'incident', SYS_ID), /Unknown format/);
});

test('the hidden-field count reads naturally', () => {
  assert.equal(hiddenLabel(1), '1 hidden field shown');
  assert.equal(hiddenLabel(3), '3 hidden fields shown');
});
