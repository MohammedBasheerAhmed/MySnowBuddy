// The pure half of the Test panel (src/sidebar/TestKitPanel.jsx, src/content/testKit.js):
//   - unit tests for a Script Include: find its methods, generate a test script with a tiny assertion library, read the
//     results back, keep saved tests;
//   - the ACL / role matrix rows;
//   - the test checklist for the kind of record on screen.
// No DOM and no network, so all of it is unit-tested (tests/testkit.test.js). Snapshots live in testSnapshot.js and the
// ATF finder in testAtf.js.

import { maskScript } from './scriptSafety.js';

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_METHODS = 30;

// --- Finding the methods of a Script Include -----------------------------------------------------------------

/** Brace nesting for a masked script: for every index, the index of the `{` that encloses it (-1 at top level). */
function enclosingBraces(masked) {
  const enclosing = new Int32Array(masked.length + 1).fill(-1);
  const stack = [];
  for (let i = 0; i < masked.length; i += 1) {
    enclosing[i] = stack.length ? stack[stack.length - 1] : -1;
    if (masked[i] === '{') stack.push(i);
    else if (masked[i] === '}') stack.pop();
  }
  return enclosing;
}

function splitParams(text) {
  return String(text || '')
    .split(',')
    .map((p) => p.replace(/=[\s\S]*$/, '').replace(/^\.\.\./, '').trim())
    .filter((p) => NAME_RE.test(p));
}

/** The text of the braces that start at `open` in `text` (masked and original have the same offsets). */
function bodyFrom(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') {
      depth -= 1;
      if (!depth) return { start: open, end: i };
    }
  }
  return { start: open, end: masked.length - 1 };
}

/**
 * The methods of the class a Script Include script defines, in source order.
 * Understands Class.create() with `X.prototype = { m: function () {} }` (also inside Object.extendsObject(Parent, {...})),
 * `X.prototype.m = function () {}` and ES2021 `class X { m() {} }`.
 * @returns {{ className: string, methods: Array<{ name: string, params: string[], reads: string[] }> }}
 *   `reads` are the names this method reads with this.getParameter('...') (an AJAX processor).
 */
export function extractMethods(source) {
  const text = String(source || '');
  const { masked } = maskScript(text);
  const enclosing = enclosingBraces(masked);

  const classMatch =
    /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*Class\s*\.\s*create\s*\(/.exec(masked) ||
    /\bclass\s+([A-Za-z_$][\w$]*)/.exec(masked) ||
    /\b([A-Za-z_$][\w$]*)\s*\.\s*prototype\b/.exec(masked);
  const className = classMatch ? classMatch[1] : '';

  // The object literals whose members are methods: the prototype assignments and class bodies.
  const bodies = new Set();
  const protoRe = /\.\s*prototype\s*=\s*(?:Object\s*\.\s*extendsObject\s*\([^,]+,\s*)?\{/g;
  let m;
  while ((m = protoRe.exec(masked))) bodies.add(m.index + m[0].length - 1);
  const classRe = /\bclass\s+[A-Za-z_$][\w$]*(?:\s+extends\s+[\w$.]+)?\s*\{/g;
  while ((m = classRe.exec(masked))) bodies.add(m.index + m[0].length - 1);
  if (!bodies.size) bodies.add(-1);

  const found = [];
  const add = (name, paramsText, headEnd) => {
    if (!NAME_RE.test(name) || ['if', 'for', 'while', 'switch', 'catch', 'function', 'return'].includes(name)) return;
    const open = masked.indexOf('{', headEnd);
    const body = open >= 0 ? text.slice(open, bodyFrom(masked, open).end + 1) : '';
    const reads = [...body.matchAll(/this\s*\.\s*getParameter\s*\(\s*(['"])([^'"]+)\1\s*\)/g)].map((r) => r[2]);
    found.push({ name, params: splitParams(paramsText), reads: [...new Set(reads)], at: headEnd });
  };

  const colonRe = /([A-Za-z_$][\w$]*)\s*:\s*function\s*[\w$]*\s*\(([^)]*)\)/g;
  while ((m = colonRe.exec(masked))) {
    if (bodies.has(enclosing[m.index])) add(m[1], m[2], m.index + m[0].length);
  }
  const assignRe = /[A-Za-z_$][\w$]*\s*\.\s*prototype\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*function\s*[\w$]*\s*\(([^)]*)\)/g;
  while ((m = assignRe.exec(masked))) add(m[1], m[2], m.index + m[0].length);
  const esRe = /(?:^|[\n;{}])\s*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
  while ((m = esRe.exec(masked))) {
    const at = m.index + m[0].lastIndexOf(m[1]);
    if (bodies.has(enclosing[at])) add(m[1], m[2], m.index + m[0].length - 1);
  }

  const seen = new Set();
  const methods = found
    .sort((a, b) => a.at - b.at)
    .filter((f) => (seen.has(f.name) ? false : seen.add(f.name)))
    .map(({ name, params, reads }) => ({ name, params, reads }));
  return { className, methods };
}

// --- Sample arguments -------------------------------------------------------------------------------------------

/** A JavaScript literal to start from for a parameter called `name`, guessed from the name. */
export function sampleFor(name) {
  const p = String(name || '').replace(/^_+/, '');
  if (/(^|_)(sys_?id|guid|uuid|id)$/i.test(p) || /[a-z]Id$/.test(p)) return "'00000000000000000000000000000000'";
  if (/(count|num|number|limit|max|min|size|total|amount|days|hours|index|offset|page|priority|level)$/i.test(p)) return '1';
  if (/^(is|has|can|should|use|enable|force)[A-Z_]/.test(p) || /(flag|enabled|active|bool)$/i.test(p)) return 'true';
  if (/(list|array|arr|ids|items|rows|names)$/i.test(p)) return '[]';
  if (/(obj|object|data|options|opts|params|config|map|payload|args|json)$/i.test(p)) return '{}';
  if (/(date|time|when)$/i.test(p)) return "'2026-01-01 00:00:00'";
  if (/(^gr$|record|current|previous|^rec$)/i.test(p)) return 'null /* TODO: a GlideRecord */';
  if (/(email|mail)/i.test(p)) return "'test@example.com'";
  return "'test'";
}

// --- The assertion library the generated test carries --------------------------------------------------------------

/**
 * ES5 so it runs in a background script. Each test prints one `MSB_TEST {json}` line when it finishes, so a crash later
 * in the script still leaves the earlier results; T.finish() prints the summary.
 */
export const ASSERT_LIB = `var T = (function () {
  var passed = 0, failed = 0, begun = new Date().getTime();
  function show(v) {
    try {
      if (v === undefined) return 'undefined';
      if (v === null) return 'null';
      if (typeof v === 'string') return '"' + v + '"';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    } catch (e) { return String(v); }
  }
  function fail(message) { throw { msbAssert: true, message: message }; }
  var api = {
    test: function (name, fn) {
      var t0 = new Date().getTime(), status = 'pass', message = '';
      try { fn(); } catch (e) {
        status = 'fail';
        message = (e && e.msbAssert) ? e.message : 'threw ' + (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e));
      }
      if (status === 'pass') passed++; else failed++;
      gs.info('MSB_TEST ' + JSON.stringify({ name: name, status: status, ms: new Date().getTime() - t0, message: message }));
    },
    fail: fail,
    assertTrue: function (v, msg) { if (v !== true) fail((msg ? msg + ': ' : '') + 'expected true but got ' + show(v)); },
    assertFalse: function (v, msg) { if (v !== false) fail((msg ? msg + ': ' : '') + 'expected false but got ' + show(v)); },
    assertEquals: function (actual, expected, msg) { if (actual !== expected) fail((msg ? msg + ': ' : '') + 'expected ' + show(expected) + ' but got ' + show(actual)); },
    assertNotEquals: function (actual, other, msg) { if (actual === other) fail((msg ? msg + ': ' : '') + 'expected anything but ' + show(other)); },
    assertDeepEquals: function (actual, expected, msg) { if (JSON.stringify(actual) !== JSON.stringify(expected)) fail((msg ? msg + ': ' : '') + 'expected ' + show(expected) + ' but got ' + show(actual)); },
    assertContains: function (haystack, needle, msg) {
      var has = (typeof haystack === 'string') ? haystack.indexOf(needle) >= 0 : (haystack && haystack.indexOf ? haystack.indexOf(needle) >= 0 : false);
      if (!has) fail((msg ? msg + ': ' : '') + show(haystack) + ' does not contain ' + show(needle));
    },
    assertThrows: function (fn, msg) {
      var threw = false;
      try { fn(); } catch (e) { threw = true; }
      if (!threw) fail((msg ? msg + ': ' : '') + 'expected it to throw, but it did not');
    },
    finish: function () {
      gs.info('MSB_TEST_SUMMARY ' + JSON.stringify({ passed: passed, failed: failed, total: passed + failed, ms: new Date().getTime() - begun }));
    }
  };
  return api;
})();`;

// --- Generating the test --------------------------------------------------------------------------------------------

// Line and paragraph separators are legal in JSON but end a line in a script, so they are escaped by code point.
const LS_RE = new RegExp(String.fromCharCode(0x2028), 'g');
const PS_RE = new RegExp(String.fromCharCode(0x2029), 'g');
const lit = (value) => JSON.stringify(String(value)).replace(LS_RE, '\\u2028').replace(PS_RE, '\\u2029');

/**
 * A runnable unit test for a Script Include. It starts as a smoke test (the class can be created, every method runs
 * with sample arguments and does not throw) with commented TODO assertions to fill in.
 * @param {{ className: string, methods: Array<{name, params, reads}>, source?: string, includeSource?: boolean, includePrivate?: boolean }} o
 */
export function generateUnitTest({ className, methods = [], source = '', includeSource = true, includePrivate = false } = {}) {
  if (!NAME_RE.test(className || '')) throw new Error('Name the Script Include class to test.');
  const callable = methods.filter((m) => m.name !== 'initialize' && m.name !== 'type' && (includePrivate || !m.name.startsWith('_'))).slice(0, MAX_METHODS);
  const lines = [`// NowBuddy unit test for ${className}. Edit the TODO lines and run it again; a dry run keeps writes out.`, ASSERT_LIB];
  if (includeSource && String(source).trim()) lines.push(`// The Script Include as it is on screen (not necessarily saved):`, source);

  lines.push(
    '',
    `T.test(${lit(`${className} can be created`)}, function () {`,
    `  var sut = new ${className}();`,
    `  T.assertTrue(sut !== null && typeof sut === 'object', 'new ${className}() returned an object');`,
    '});'
  );
  callable.forEach((method) => {
    const args = method.params.map(sampleFor);
    lines.push('', `T.test(${lit(`${className}.${method.name}(${method.params.join(', ')}): runs without throwing`)}, function () {`, `  var sut = new ${className}();`);
    if (method.reads.length) {
      lines.push(`  // This method reads its inputs with this.getParameter(); give it some.`, `  var input = { ${method.reads.map((r) => `${lit(r)}: 'test'`).join(', ')} };`, `  sut.getParameter = function (name) { return input[name]; };`);
    }
    lines.push(
      `  var result = sut.${method.name}(${args.join(', ')});`,
      `  // TODO: T.assertEquals(result, <the value you expect>);`,
      `  // TODO: T.assertThrows(function () { sut.${method.name}(${method.params.map(() => 'null').join(', ')}); }, 'bad input');`,
      '});'
    );
  });
  lines.push('', 'T.finish();');
  return { script: lines.join('\n'), methodCount: callable.length };
}

// --- Reading the results back ---------------------------------------------------------------------------------------

/**
 * @returns {{ tests: Array<{name, status: 'pass'|'fail', ms: number, message: string}>, summary: {passed, failed, total, ms}, complete: boolean }}
 *   `complete` is false when the script stopped before T.finish() (it crashed, or was not a T test at all).
 */
export function parseTestOutput(text) {
  const tests = [];
  let summary = null;
  String(text ?? '')
    .split('\n')
    .forEach((line) => {
      const row = line.replace(/^\*\*\* Script: /, '').trim();
      const test = /^MSB_TEST (\{.*\})$/.exec(row);
      const done = /^MSB_TEST_SUMMARY (\{.*\})$/.exec(row);
      try {
        if (test) {
          const t = JSON.parse(test[1]);
          tests.push({ name: String(t.name), status: t.status === 'pass' ? 'pass' : 'fail', ms: Number(t.ms) || 0, message: String(t.message || '') });
        } else if (done) {
          summary = JSON.parse(done[1]);
        }
      } catch {
        // A garbled line is not a result.
      }
    });
  const passed = tests.filter((t) => t.status === 'pass').length;
  return {
    tests,
    summary: summary || { passed, failed: tests.length - passed, total: tests.length, ms: tests.reduce((s, t) => s + t.ms, 0) },
    complete: Boolean(summary),
  };
}

// --- Saved tests -----------------------------------------------------------------------------------------------------

export const SAVED_LIMITS = { name: 80, script: 60000, max: 50 };

const clip = (value, max) => String(value ?? '').trim().slice(0, max);

/** A saved test entry, or null when it has no name or no script. */
export function makeSavedTest({ name, script, className = '', table = '', now = Date.now() } = {}) {
  const title = clip(name, SAVED_LIMITS.name);
  const body = String(script ?? '');
  if (!title || !body.trim()) return null;
  return { id: `t-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name: title, className: clip(className, 80), table: clip(table, 80), script: body.slice(0, SAVED_LIMITS.script), savedAt: now, lastRun: null };
}

/** Add (or replace the test with the same name and class), newest first, capped. */
export function upsertSavedTest(list, entry) {
  if (!entry) return list;
  const rest = (list || []).filter((t) => !(t.name === entry.name && t.className === entry.className));
  return [entry, ...rest].slice(0, SAVED_LIMITS.max);
}

export const removeSavedTest = (list, id) => (list || []).filter((t) => t.id !== id);

export function recordSavedRun(list, id, summary, now = Date.now()) {
  return (list || []).map((t) => (t.id === id ? { ...t, lastRun: { at: now, passed: summary.passed, failed: summary.failed, total: summary.total } } : t));
}

// --- Access matrix --------------------------------------------------------------------------------------------------

export const MATRIX_OPERATIONS = ['read', 'write', 'create', 'delete'];
export const MATRIX_MAX_USERS = 5;

/** One cell of the matrix from an explainAccess() result ({ verdict }). */
export function matrixCell(result) {
  const verdict = result?.verdict || {};
  const status = verdict.status === 'denied' ? 'denied' : verdict.status === 'allowed' ? 'allowed' : 'unknown';
  const decidedBy = (verdict.decidedBy || []).map((d) => (typeof d === 'string' ? d : d?.name)).filter(Boolean);
  return { status, reason: String(verdict.reason || ''), blockedBy: status === 'denied' ? decidedBy : [], decidedBy, caveats: verdict.caveats || [] };
}

export const matrixErrorCell = (message) => ({ status: 'unknown', reason: String(message || 'Could not be checked.'), blockedBy: [], decidedBy: [], caveats: [] });

/** Markdown for a ticket: one row per user, one column per operation. */
export function matrixToMarkdown({ table, sysId = '', field = '', operations, rows }) {
  const cell = (c) => (c.status === 'allowed' ? 'allowed' : c.status === 'denied' ? `DENIED${c.blockedBy.length ? ` (${c.blockedBy.slice(0, 2).join(', ')})` : ''}` : 'unknown');
  const lines = [`Access to ${table}${field ? `.${field}` : ''}${sysId ? ` (${sysId})` : ''}`, '', `| User | ${operations.join(' | ')} |`, `| --- | ${operations.map(() => '---').join(' | ')} |`];
  rows.forEach((row) => lines.push(`| ${String(row.label).replace(/\|/g, '\\|')} | ${operations.map((op) => cell(row.cells[op] || matrixErrorCell(''))).join(' | ')} |`));
  return lines.join('\n');
}

// --- Test checklist -------------------------------------------------------------------------------------------------

const CHECKLISTS = {
  businessRule: {
    title: 'Business rule',
    sections: [
      { name: 'Does it run when it should?', items: ['Trigger it with each event it is set for (insert, update, delete, query) and check the result.', 'Test with the condition true AND false: the rule must stay quiet when the condition is false.', 'Check the timing: a before rule changes `current` and must not call current.update(); an after rule updates other records; async work must not depend on `previous`.', 'Check the order against the other rules on the table (lower order runs first).'] },
      { name: 'Edge cases', items: ['Empty and null field values (use current.field.nil()).', 'Run it as a user without the roles it assumes (impersonate).', 'Update the record twice in a row: it must not loop or double-apply.', 'Bulk insert or update 100+ records (import set, list edit): look for slow queries and recursion.'] },
      { name: 'Prove it with the tools', items: ['Run this script against a record with a dry run and read the suppressed writes.', 'Pretend the key fields changed and check what changes in memory.', 'Take a snapshot of the record, trigger the rule, and compare.', 'Check the system log for errors from the rule, and what else ran as a result (Change impact).'] },
    ],
  },
  clientScript: {
    title: 'Client script',
    sections: [
      { name: 'Behaviour', items: ['onLoad: open an existing record AND a new one; the form must not flicker or throw.', 'onChange: change the field to each value, to empty, and back; guard `isLoading` and `newValue === ""`.', 'onSubmit: make it fail on purpose and check the message and that the form stays open.', 'Try the list editor and related-list edit if the field can be edited there.'] },
      { name: 'Environments', items: ['Check in the classic form, the Service Portal and the workspace if the table is used there (client scripts need "UI Type" set).', 'Check on mobile if the field is shown there.', 'Check the browser console for errors on load.'] },
      { name: 'Prove it with the tools', items: ['Run it in the Test bench with different field values.', 'Open X-ray on the field: what else changes it (UI policies, other client scripts)?'] },
    ],
  },
  scriptInclude: {
    title: 'Script Include',
    sections: [
      { name: 'Unit tests', items: ['Every public method called with typical input, empty input and bad input.', 'Methods that query: with no matching record, one record and many.', 'Client-callable: call it with GlideAjax and check the answer parses (and that a user without the role is refused).'] },
      { name: 'Safety', items: ['No user input concatenated into an encoded query (a ^ adds conditions).', 'No hard-coded sys_ids; use properties or lookups.', 'Scoped: check cross-scope access if other applications call it.'] },
      { name: 'Prove it with the tools', items: ['Write a unit test from this script include and run it (dry run).', 'Change impact: who calls it, and retest those callers.', 'Find ATF tests that cover it; run their suite.'] },
    ],
  },
  uiAction: {
    title: 'UI action',
    sections: [
      { name: 'Behaviour', items: ['Click it on a record where the condition is true, and check it is hidden where it is false.', 'Client+server: check the client part validates and the server part runs (gsftSubmit round trip, `current` and `action`).', 'Check where it shows: form button, context menu, related list, list banner.'] },
      { name: 'Edge cases', items: ['Click it twice quickly.', 'Run it as a user without the roles on the action.', 'Check the redirect: action.setRedirectURL() goes where you expect.'] },
    ],
  },
  acl: {
    title: 'ACL',
    sections: [
      { name: 'Who can and who cannot', items: ['A user with the required role: allowed. A user without it: denied.', 'Check read, write, create and delete separately; field ACLs on top of table ACLs.', 'An admin with and without elevated security_admin.', 'The same user on a record that matches the condition and one that does not.'] },
      { name: 'Prove it with the tools', items: ['Who can access this? Compare up to five users side by side.', 'Access debugger: the full trace for one user.', 'Impersonate a real user and try it in the UI.'] },
    ],
  },
  flow: {
    title: 'Flow',
    sections: [
      { name: 'Run it', items: ['Trigger it with the exact record state that starts it, and with one that must not start it.', 'Check every branch of every condition, and the error handler.', 'Check what it changes on the record and which notifications it sends (test with a safe recipient).'] },
      { name: 'Prove it with the tools', items: ['Snapshot the record, run the flow, compare.', 'Find ATF tests that cover it; run their suite.', 'Check the flow execution log for failed actions.'] },
    ],
  },
  uiPolicy: {
    title: 'UI policy',
    sections: [{ name: 'Behaviour', items: ['Set the condition true and false; fields must show, hide, become mandatory or read-only as designed.', 'Reverse if false: check it undoes its changes.', 'Check "on load" behaviour for existing and new records.', 'Check for conflicts with client scripts and other policies on the same field (X-ray).'] }],
  },
  scheduledJob: {
    title: 'Scheduled job or fix script',
    sections: [{ name: 'Before it runs for real', items: ['Dry run it first and read the suppressed writes.', 'Check it is idempotent: running it twice gives the same result.', 'Limit the batch (setLimit) for the first run and check the count.', 'Check the log output and that it ends in a summary line.'] }],
  },
  restApi: {
    title: 'Scripted REST API',
    sections: [{ name: 'Requests', items: ['A valid request, a missing parameter, a wrong type, an oversized body.', 'Check the status codes (200/201, 400, 401/403, 404) and the error body.', 'Call it as a user without the role the resource requires.'] }],
  },
  record: {
    title: 'Record',
    sections: [{ name: 'Before and after', items: ['Take a snapshot of the record, make the change, compare.', 'Check what else changed through business rules and flows (Page X-ray, Change impact).', 'Check who can see and edit it (Who can access this?).'] }],
  },
};

const CHECKLIST_TABLES = { sys_script: 'businessRule', sys_script_client: 'clientScript', sys_script_include: 'scriptInclude', sys_ui_action: 'uiAction', sys_security_acl: 'acl', sys_hub_flow: 'flow', sys_hub_flow_base: 'flow', sys_ui_policy: 'uiPolicy', sysauto_script: 'scheduledJob', sys_script_fix: 'scheduledJob', sys_ws_operation: 'restApi', sys_ws_definition: 'restApi' };

export const checklistKindForTable = (table) => CHECKLIST_TABLES[table] || 'record';

/** @returns {{ kind, title, sections: Array<{ name, items: string[] }> }} */
export function buildChecklist(kind) {
  const found = CHECKLISTS[kind] || CHECKLISTS.record;
  return { kind: CHECKLISTS[kind] ? kind : 'record', title: found.title, sections: found.sections.map((s) => ({ name: s.name, items: [...s.items] })) };
}

export function checklistToMarkdown(checklist, { name = '' } = {}) {
  const lines = [`## Test checklist: ${checklist.title}${name ? ` - ${name}` : ''}`];
  checklist.sections.forEach((section) => {
    lines.push('', `### ${section.name}`);
    section.items.forEach((item) => lines.push(`- [ ] ${item}`));
  });
  return lines.join('\n');
}
