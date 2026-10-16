// Regression tests for two review findings:
//  1. lint no-dom-in-client-script never matched $('#id') because it ran on masked code.
//  2. The security audit read ACL roles with one capped query, so ACLs whose role rows were cut
//     off were reported as "open".
const test = require('node:test');
const assert = require('node:assert/strict');
const { lintScript, hasDomSelectorCall, maskNonCode } = require('../src/lib/lint.js');
const { runSecurityAudit, formatAuditFindings, ACL_CANDIDATE_CAP } = require('../src/content/securityAudit.js');

const domHits = (code, table = 'sys_script_client') => lintScript(code, { table }).filter((f) => f.ruleId === 'no-dom-in-client-script').map((f) => f.line);

test('DOM rule: $, $j, $$ and jQuery selector calls in client scripts', () => {
  const code = [
    "$('#incident_number').hide();", // 1 jQuery/Prototype selector
    "var v = $j('.field').val();", // 2 ServiceNow jQuery alias
    "$$('div.notice').each(function (d) { d.hide(); });", // 3 Prototype $$
    "jQuery('#x').show();", // 4
    "var el = $( 'priority' );", // 5 Prototype $('id')
    'var t = $(`#${id}`);', // 6 template literal
    "document.getElementById('x');", // 7 still caught
  ].join('\n');
  assert.deepEqual(domHits(code), [1, 2, 3, 4, 5, 6, 7]);
});

test('DOM rule: no false positives for strings, comments, properties, plain $ variables or server code', () => {
  const code = [
    "g_form.addInfoMessage(\"Use $('#x') carefully\");", // 1 inside a string
    "// $('#x').hide();", // 2 comment
    "/* jQuery('#x') */ var a = 1;", // 3 block comment
    'var $ = helper; var y = $(el);', // 4 $ as a variable, no string argument
    "obj.$('#x');", // 5 a method called $
    "var price = '$' + amount;", // 6 dollar sign in a string
    'var total$ = 1; total$(2);', // 7 identifier ending in $
  ].join('\n');
  assert.deepEqual(domHits(code), []);
  assert.deepEqual(domHits("$('#x').hide();", 'sys_script'), [], 'server-side scripts are not checked by this rule');
});

test('hasDomSelectorCall reads the argument from the raw line at the masked position', () => {
  const raw = "  x = $('#a');";
  assert.equal(hasDomSelectorCall(raw, maskNonCode(raw)), true);
  assert.equal(hasDomSelectorCall('x = $(a);', maskNonCode('x = $(a);')), false);
});

// ---- security audit -----------------------------------------------------------------------------

const hex = (n) => n.toString(16).padStart(32, '0');

function stubPage() {
  // sessionHeaders() falls back to the token in the page markup when the page bridge is unavailable.
  global.document = {
    documentElement: {
      hasAttribute() {
        throw new Error('no bridge in tests');
      },
    },
    getElementById: () => null,
    querySelector: (sel) => (sel === 'input[name="sysparm_ck"]' ? { value: 'test-token' } : null),
    scripts: [],
  };
}

const ok = (result) => new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });

/** fetch stub routing Table API calls by table. */
function stubInstance({ acls, roles }) {
  const calls = [];
  global.fetch = async (url) => {
    const u = new URL(url, 'https://dev1.service-now.com');
    const table = u.pathname.split('/').pop();
    const query = u.searchParams.get('sysparm_query') || '';
    const limit = Number(u.searchParams.get('sysparm_limit'));
    const offset = Number(u.searchParams.get('sysparm_offset') || 0);
    calls.push({ table, query, limit, offset });
    if (table === 'sys_security_acl') return ok(acls.slice(offset, offset + limit));
    if (table === 'sys_security_acl_role') return roles(query, limit);
    return ok([]);
  };
  return calls;
}

const acl = (i, extra = {}) => ({ sys_id: hex(i), name: `t${i}`, operation: 'write', condition: '', script: '', ...extra });
const askedIds = (query) => (/sys_security_aclIN([^^]*)/.exec(query)?.[1] || '').split(',').filter(Boolean);

test('audit: roles are read per candidate ACL in chunks; only ACLs without roles are open', async () => {
  stubPage();
  const acls = Array.from({ length: 100 }, (_, i) => acl(i + 1));
  const calls = stubInstance({
    acls,
    // Every ACL except #7 has a role.
    roles: (query) => ok(askedIds(query).filter((id) => id !== hex(7)).map((id) => ({ sys_security_acl: id, sys_user_role: hex(999) }))),
  });
  const result = await runSecurityAudit();
  const open = result.findings.filter((f) => f.category === 'ACL');
  assert.deepEqual(open.map((f) => f.link), [`/sys_security_acl.do?sys_id=${hex(7)}`]);
  assert.deepEqual(result.incomplete, []);
  const roleCalls = calls.filter((c) => c.table === 'sys_security_acl_role');
  assert.equal(roleCalls.length, 3, '100 candidates in chunks of 40');
  assert.ok(roleCalls.every((c) => c.query.startsWith('sys_security_aclIN')));
  assert.match(calls.find((c) => c.table === 'sys_security_acl').query, /conditionISEMPTY\^scriptISEMPTY/);
});

test('audit: a role chunk that hits the cap marks its ACLs unknown, not open, and says the check is incomplete', async () => {
  stubPage();
  const acls = Array.from({ length: 50 }, (_, i) => acl(i + 1));
  stubInstance({
    acls,
    roles: (query, limit) => {
      const ids = askedIds(query);
      // The first chunk (40 ACLs) answers with exactly `limit` rows, none for ACL #1: possibly cut off.
      if (ids.includes(hex(1))) return ok(Array.from({ length: limit }, (_, i) => ({ sys_security_acl: ids[1 + (i % (ids.length - 1))] })));
      // Second chunk: complete, ACL #45 has no role.
      return ok(ids.filter((id) => id !== hex(45)).map((id) => ({ sys_security_acl: id })));
    },
  });
  const result = await runSecurityAudit();
  const open = result.findings.filter((f) => f.category === 'ACL').map((f) => f.link);
  assert.deepEqual(open, [`/sys_security_acl.do?sys_id=${hex(45)}`]);
  assert.equal(result.incomplete.length, 1);
  assert.match(result.incomplete[0].reason, /not judged/);
  assert.ok(result.errors.some((e) => e.incomplete && e.check === 'Open ACLs'));
  assert.match(formatAuditFindings(result), /ran only partly/);
});

test('audit: rows that do not belong to the chunk (an ignored condition) also make the chunk unknown', async () => {
  stubPage();
  stubInstance({ acls: [acl(1), acl(2)], roles: () => ok([{ sys_security_acl: hex(500) }]) });
  const result = await runSecurityAudit();
  assert.equal(result.findings.filter((f) => f.category === 'ACL').length, 0);
  assert.equal(result.incomplete.length, 1);
});

test('audit: a failing role lookup fails the check instead of reporting every ACL as open', async () => {
  stubPage();
  stubInstance({ acls: [acl(1), acl(2)], roles: () => new Response('{"error":{}}', { status: 500, headers: { 'content-type': 'application/json' } }) });
  const result = await runSecurityAudit();
  assert.equal(result.findings.filter((f) => f.category === 'ACL').length, 0);
  assert.ok(result.errors.some((e) => e.check === 'Open ACLs' && !e.incomplete));
});

test('audit: conditions, scripts, deny-unless ACLs and the candidate cap', async () => {
  stubPage();
  // The instance filter is re-checked locally, and deny-unless ACLs never "grant" access.
  stubInstance({ acls: [acl(1, { condition: 'active=true' }), acl(2, { script: 'answer = true;' }), acl(3, { decision_type: 'deny' })], roles: () => ok([]) });
  let result = await runSecurityAudit();
  assert.equal(result.findings.filter((f) => f.category === 'ACL').length, 0);

  stubPage();
  const many = Array.from({ length: ACL_CANDIDATE_CAP + 5 }, (_, i) => acl(i + 1));
  stubInstance({ acls: many, roles: (query) => ok(askedIds(query).map((id) => ({ sys_security_acl: id }))) });
  result = await runSecurityAudit();
  assert.ok(result.incomplete.some((n) => /first 3000/.test(n.reason)));
  assert.equal(result.findings.filter((f) => f.category === 'ACL').length, 0);
});
