const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scanScript,
  scriptContext,
  recordChecks,
  scanTableDef,
  normalizeScanOptions,
  describeScope,
  parseUpdateName,
  parseDuration,
  parseSnDate,
  maskStringLiterals,
  checkBusinessRules,
  checkBusinessRuleOrder,
  checkClientCallable,
  checkScheduledJobs,
  checkUpdateSets,
  skippedUpgradeFindings,
  securityFindings,
  rateCounts,
  weightedPoints,
  countBySeverity,
  summarizeCategories,
  pickTop,
  aggregateByRule,
  buildReport,
  filterFindings,
  reportToMarkdown,
  reportToCsv,
  buildRemediationPrompt,
  isHotTable,
  evidenceClasses,
  classToTable,
  customerUpdateQuery,
  ANTI_PATTERNS,
  notCheckedList,
} = require('../src/lib/healthScan.js');
const { runSecurityAudit, openAclSeverity, isRecordAcl } = require('../src/content/securityAudit.js');
const { runHealthScan } = require('../src/content/healthScan.js');

const rec = (row, name = 'Test record') => ({ sysId: row.sys_id || 'a'.repeat(32), name, scope: 'Global', row });
const scan = (table, code, row = {}, field) => {
  const def = scanTableDef(table);
  const script = field ? def.scripts.find((s) => s.field === field) : def.scripts[0];
  return scanScript({ code, def, script, record: rec({ sys_id: 'b'.repeat(32), sys_scope: 'global', ...row }) });
};
const ids = (findings) => findings.map((f) => f.ruleId).sort();

// ---- script fixtures -------------------------------------------------------------------------

const BAD_CLIENT = [
  'function onChange(control, oldValue, newValue, isLoading, isTemplate) {',
  "  var gr = new GlideRecord('sys_user');",
  "  gr.addQuery('sys_id', newValue);",
  '  gr.query();',
  "  var ga = new GlideAjax('MyAjax');",
  "  ga.addParam('sysparm_name', 'get');",
  '  ga.getXMLWait();',
  "  document.getElementById('x').style.display = 'none';",
  "  g_form.setValue('assigned_to', '6816f79cc0a8016401c5a33be04be441');",
  '}',
].join('\n');

const GOOD_CLIENT = [
  'function onChange(control, oldValue, newValue, isLoading, isTemplate) {',
  "  if (isLoading || newValue === '') {",
  '    return;',
  '  }',
  "  var ga = new GlideAjax('MyAjax');",
  "  ga.addParam('sysparm_name', 'getManager');",
  "  ga.addParam('sysparm_user', newValue);",
  '  ga.getXMLAnswer(function (answer) {',
  "    g_form.setValue('u_manager', answer);",
  '  });',
  '}',
].join('\n');

const BAD_BR = [
  '(function executeRule(current, previous) {',
  "  var all = new GlideRecord('incident');",
  '  all.query();',
  '  while (all.next()) {',
  "    var u = new GlideRecord('sys_user');",
  '    u.get(all.caller_id);',
  '  }',
  "  var c = new GlideRecord('problem');",
  "  c.addQuery('active', true);",
  '  c.query();',
  '  gs.info(c.getRowCount());',
  '  gs.sleep(1000);',
  '  current.update();',
  "  eval('1+1');",
  "  var url = 'https://acme.service-now.com/nav_to.do';",
  '})(current, previous);',
].join('\n');

const GOOD_BR = [
  '(function executeRule(current, previous) {',
  '  if (current.priority.changes() && current.priority == 1) {',
  '    current.urgency = 1;',
  "    gs.addInfoMessage('Urgency raised');",
  '  }',
  '})(current, previous);',
].join('\n');

test('bad client script: every client anti-pattern is reported once, with lines', () => {
  const findings = scan('sys_script_client', BAD_CLIENT, { type: 'onChange' });
  const got = ids(findings);
  for (const id of ['client-gliderecord', 'client-getxmlwait', 'client-dom', 'onchange-no-isloading', 'hardcoded-sys-id']) {
    assert.ok(got.includes(id), `missing ${id} in ${got.join(', ')}`);
  }
  // Collapsed: one finding per rule per field.
  assert.equal(new Set(got).size, got.length);
  const gr = findings.find((f) => f.ruleId === 'client-gliderecord');
  assert.equal(gr.severity, 'high');
  assert.equal(gr.category, 'antipattern');
  assert.equal(gr.line, 2);
  assert.match(gr.excerpt, /new GlideRecord/);
  assert.equal(gr.link, `/sys_script_client.do?sys_id=${'b'.repeat(32)}`);
  assert.ok(gr.why && gr.fix);
  // The deprecated-API notes about client GlideRecord are folded into the anti-pattern.
  assert.ok(!findings.some((f) => f.ruleId === 'api-deprecated' || f.ruleId === 'api-unsupported-ui'), JSON.stringify(findings.map((x) => x.ruleId)));
});

test('good client script produces no findings', () => {
  assert.deepEqual(scan('sys_script_client', GOOD_CLIENT, { type: 'onChange' }), []);
});

test('bad business rule: server anti-patterns', () => {
  const findings = scan('sys_script', BAD_BR, { when: 'after' });
  const got = ids(findings);
  for (const id of ['unbounded-query', 'nested-query', 'getrowcount-count', 'gs-sleep', 'br-current-update', 'eval', 'hardcoded-instance-url']) {
    assert.ok(got.includes(id), `missing ${id} in ${got.join(', ')}`);
  }
  assert.equal(findings.find((f) => f.ruleId === 'br-current-update').severity, 'high');
  // The unbounded query is downgraded to medium for the scan (filters in helpers are invisible).
  assert.equal(findings.find((f) => f.ruleId === 'unbounded-query').severity, 'medium');
});

test('current.update() in an async rule is medium, not high', () => {
  const findings = scan('sys_script', '(function executeRule(current) {\n  current.update();\n})(current);', { when: 'async' });
  assert.equal(findings.find((f) => f.ruleId === 'br-current-update').severity, 'medium');
});

test('good business rule produces no findings', () => {
  assert.deepEqual(scan('sys_script', GOOD_BR, { when: 'before' }), []);
});

test('getRowCount on an iterated GlideRecord is not flagged', () => {
  const code = "var gr = new GlideRecord('incident');\ngr.addQuery('active', true);\ngr.query();\nvar n = gr.getRowCount();\nwhile (gr.next()) { gs.info(gr.number); }";
  assert.ok(!ids(scan('sys_script_include', code)).includes('getrowcount-count'));
});

test('hard-coded sys_id in a comment is ignored; in code it is flagged', () => {
  assert.deepEqual(scan('sys_script_include', "// owner '6816f79cc0a8016401c5a33be04be441'\nvar x = 1;"), []);
  assert.ok(ids(scan('sys_script_include', "var id = '6816f79cc0a8016401c5a33be04be441';")).includes('hardcoded-sys-id'));
});

test('DOM access in a UI script is not an anti-pattern; in a UI policy script it is', () => {
  const code = "function go() { document.getElementById('x').focus(); }";
  assert.ok(!ids(scan('sys_ui_script', code)).includes('client-dom'));
  assert.ok(ids(scan('sys_ui_policy', `function onCondition() { $('x').hide(); }`, { run_scripts: 'true' }, 'script_true')).includes('client-dom'));
});

test('mixed client/server UI action is not checked as client code', () => {
  const code = [
    'function runClient() {',
    "  gsftSubmit(null, g_form.getFormElement(), 'my_action');",
    '}',
    "if (typeof window == 'undefined') serverSide();",
    'function serverSide() {',
    '  current.state = 2;',
    '  current.update();',
    '}',
  ].join('\n');
  const def = scanTableDef('sys_ui_action');
  assert.equal(scriptContext(def, def.scripts[0], { client: 'true', script: code }).side, 'mixed');
  const findings = scan('sys_ui_action', code, { client: 'true', script: code });
  assert.ok(!findings.some((f) => f.ruleId === 'api-wrong-side'), JSON.stringify(ids(findings)));
  assert.ok(!findings.some((f) => f.ruleId === 'br-current-update'));
});

test('credential excerpt is masked and categorised as security', () => {
  const findings = scan('sys_script_include', "var password = 'hunter2secret';");
  const cred = findings.find((f) => f.ruleId === 'hardcoded-credential');
  assert.ok(cred);
  assert.equal(cred.category, 'security');
  assert.ok(!cred.excerpt.includes('hunter2secret'), cred.excerpt);
  assert.equal(maskStringLiterals("a = 'x' + \"y\";"), "a = '***' + '***';");
});

test('deprecated API usage lands in the upgrade category', () => {
  const findings = scan('sys_script_include', "gs.log('hello', 'source');");
  const dep = findings.find((f) => f.ruleId === 'api-deprecated');
  assert.ok(dep, JSON.stringify(ids(findings)));
  assert.equal(dep.category, 'upgrade');
});

test('global UI script is a record-level finding', () => {
  const def = scanTableDef('sys_ui_script');
  assert.equal(recordChecks(def, rec({ global: 'true' }))[0].ruleId, 'global-ui-script');
  assert.deepEqual(recordChecks(def, rec({ global: 'false' })), []);
});

// ---- configuration checks --------------------------------------------------------------------

const br = (over) => rec({ sys_id: over.sys_id || 'c'.repeat(32), collection: 'incident', when: 'after', order: '100', condition: '', filter_condition: '', action_insert: 'false', action_update: 'true', action_delete: 'false', action_query: 'false', ...over }, over.name || 'BR');

test('business rule with no condition on a hot table', () => {
  const [f] = checkBusinessRules([br({})]);
  assert.equal(f.ruleId, 'br-no-condition-hot-table');
  assert.equal(f.severity, 'low');
  assert.equal(checkBusinessRules([br({ when: 'async' })])[0].severity, 'medium');
  assert.deepEqual(checkBusinessRules([br({ filter_condition: 'state=2^EQ' })]), []);
  assert.deepEqual(checkBusinessRules([br({ condition: 'current.state.changes()' })]), []);
  assert.deepEqual(checkBusinessRules([br({ collection: 'u_my_table' })]), []);
  assert.deepEqual(checkBusinessRules([br({ action_update: 'false', action_query: 'true', when: 'before' })]), []);
  assert.deepEqual(checkBusinessRules([br({ when: 'display' })]), []);
  assert.equal(checkBusinessRules([br({ filter_condition: 'EQ' })]).length, 1);
  assert.ok(isHotTable('cmdb_ci_server') && isHotTable('task') && !isHotTable('cmdb_rel_ci'));
});

test('business rules sharing an order only when actions overlap', () => {
  const a = br({ sys_id: '1'.repeat(32), name: 'A' });
  const b = br({ sys_id: '2'.repeat(32), name: 'B' });
  const c = br({ sys_id: '3'.repeat(32), name: 'C', action_update: 'false', action_insert: 'true' });
  const [f] = checkBusinessRuleOrder([a, b, c]);
  assert.equal(f.ruleId, 'br-same-order');
  assert.match(f.why, /"A", "B", "C"/);
  assert.match(f.link, /^\/sys_script_list\.do\?sysparm_query=/);
  assert.deepEqual(checkBusinessRuleOrder([a, c]), []);
  assert.deepEqual(checkBusinessRuleOrder([a, br({ sys_id: '4'.repeat(32), order: '200' })]), []);
});

test('client-callable Script Include without an ACL', () => {
  const si = (name, api, callable = 'true') => rec({ sys_id: 'd'.repeat(32), name, api_name: api, client_callable: callable }, name);
  const records = [si('MyAjax', 'global.MyAjax'), si('Covered', 'global.Covered'), si('Scoped', 'x_acme_app.Scoped'), si('NotCallable', 'global.NotCallable', 'false')];
  const flagged = checkClientCallable(records, new Set(['Covered', 'x_acme_app.Scoped'])).map((f) => f.recordName);
  assert.deepEqual(flagged, ['MyAjax']);
  assert.deepEqual(checkClientCallable(records, new Set(['*'])), []);
});

test('scheduled job frequency from a glide_duration value', () => {
  assert.equal(parseDuration('1970-01-01 00:05:00'), 300);
  assert.equal(parseDuration('1970-01-02 00:00:00'), 86400);
  assert.equal(parseDuration('garbage'), null);
  const job = (period, type = 'periodically') => rec({ run_type: type, run_period: period });
  assert.equal(checkScheduledJobs([job('1970-01-01 00:00:30')])[0].severity, 'medium');
  assert.equal(checkScheduledJobs([job('1970-01-01 00:05:00')])[0].severity, 'low');
  assert.deepEqual(checkScheduledJobs([job('1970-01-01 00:10:00')]), []);
  assert.deepEqual(checkScheduledJobs([job('1970-01-01 00:00:30', 'daily')]), []);
  assert.deepEqual(checkScheduledJobs([job('')]), []);
});

test('update sets: stale and large, Default ignored', () => {
  const now = Date.UTC(2026, 9, 16);
  const sets = [
    { sys_id: 'e'.repeat(32), name: 'STRY001', state: 'in progress', sys_created_on: '2026-06-01 00:00:00' },
    { sys_id: 'f'.repeat(32), name: 'Fresh', state: 'in progress', sys_created_on: '2026-10-10 00:00:00' },
    { sys_id: '9'.repeat(32), name: 'Default', is_default: 'true', state: 'in progress', sys_created_on: '2020-01-01 00:00:00' },
  ];
  const counts = new Map([['f'.repeat(32), 2400]]);
  const findings = checkUpdateSets(sets, counts, now);
  assert.deepEqual(findings.map((f) => `${f.recordName}:${f.ruleId}:${f.severity}`).sort(), ['Fresh:updateset-large:medium', 'STRY001:updateset-stale:medium']);
  // A completed set is not "in progress for a long time".
  assert.deepEqual(checkUpdateSets([{ ...sets[0], state: 'complete' }], new Map(), now), []);
});

test('skipped upgrade records and security findings map to categories', () => {
  const skipped = skippedUpgradeFindings([{ sys_id: '1'.repeat(32), target_name: 'incident BR', file_name: 'sys_script_x', type: 'Business Rule', priority: '2' }], { upgradeLabel: 'Australia' });
  assert.equal(skipped[0].category, 'upgrade');
  assert.equal(skipped[0].severity, 'medium');
  assert.match(skipped[0].why, /Australia/);
  assert.equal(skipped[0].link, `/sys_upgrade_history_log.do?sys_id=${'1'.repeat(32)}`);

  const sec = securityFindings({
    findings: [
      { severity: 'high', category: 'ACL', message: 'ACL "x" grants access', detail: 'Any user', link: `/sys_security_acl.do?sys_id=${'2'.repeat(32)}` },
      { severity: 'medium', category: 'Roles', message: '30 admins', detail: 'Review', link: '/sys_user_has_role_list.do?sysparm_query=role.name%3Dadmin' },
    ],
  });
  assert.equal(sec[0].table, 'sys_security_acl');
  assert.equal(sec[0].sysId, '2'.repeat(32));
  assert.equal(sec[0].category, 'security');
  assert.equal(sec[1].table, 'sys_user_has_role');
  assert.notEqual(sec[0].id, sec[1].id);
});

// ---- options and parsing ---------------------------------------------------------------------

test('scan options are validated before anything reaches a query', () => {
  assert.equal(normalizeScanOptions({}).mode, 'instance');
  assert.equal(normalizeScanOptions({}).includeSecurity, true);
  assert.throws(() => normalizeScanOptions({ mode: 'scope', scopeId: 'x_acme^ORactive=true' }), /scope/);
  assert.equal(normalizeScanOptions({ mode: 'scope', scopeId: 'global' }).scopeId, 'global');
  assert.throws(() => normalizeScanOptions({ mode: 'updateset', updateSetId: 'nope' }), /update set/);
  assert.throws(() => normalizeScanOptions({ mode: 'recent', days: 0 }), /Days/);
  assert.throws(() => normalizeScanOptions({ mode: 'recent', days: 'javascript:gs.sleep(1)' }), /Days/);
  assert.equal(normalizeScanOptions({ mode: 'recent', days: '14', onlyMine: true }).days, 14);
  assert.equal(normalizeScanOptions({ maxPerTable: 99999 }).maxPerTable, 2000);
  assert.throws(() => normalizeScanOptions({ tables: ['incident'] }), /Unknown table/);
  assert.match(describeScope(normalizeScanOptions({ mode: 'recent', days: 7, onlyMine: true })), /last 7 days by me/);
});

test('update names parse exactly', () => {
  const tables = ['sys_script', 'sys_script_include'];
  assert.deepEqual(parseUpdateName(`sys_script_include_${'a'.repeat(32)}`, tables), { table: 'sys_script_include', sysId: 'a'.repeat(32) });
  assert.deepEqual(parseUpdateName(`sys_script_${'b'.repeat(32)}`, tables), { table: 'sys_script', sysId: 'b'.repeat(32) });
  assert.equal(parseUpdateName(`sys_script_client_${'b'.repeat(32)}`, tables), null);
  assert.equal(parseUpdateName('sys_dictionary_incident_state', tables), null);
  assert.equal(parseSnDate('2026-10-01 08:30:00'), Date.UTC(2026, 9, 1, 8, 30, 0));
});

// ---- scoring and report ----------------------------------------------------------------------

const f = (ruleId, severity, category = 'code', extra = {}) => ({
  id: `${ruleId}:${Math.random()}`,
  ruleId,
  severity,
  category,
  title: ruleId,
  why: 'why',
  fix: 'fix',
  table: 'sys_script',
  tableLabel: 'Business Rule',
  sysId: extra.sysId || 'a'.repeat(32),
  recordName: extra.recordName || 'R',
  field: 'script',
  line: 1,
  lines: [1],
  occurrences: 1,
  excerpt: extra.excerpt || '',
  link: '/sys_script.do?sys_id=x',
  ...extra,
});

test('ratings follow the worst severity; points weigh high x10, medium x3, low x1', () => {
  assert.deepEqual(rateCounts({ high: 0, medium: 0, low: 0 }), { rating: 'good', ratingLabel: 'Nothing found' });
  assert.equal(rateCounts({ high: 0, medium: 0, low: 4 }).rating, 'minor');
  assert.equal(rateCounts({ high: 0, medium: 1, low: 4 }).rating, 'review');
  assert.equal(rateCounts({ high: 1, medium: 0, low: 0 }).rating, 'attention');
  assert.equal(rateCounts({ high: 0, medium: 0, low: 0 }, false).rating, 'not-run');
  assert.equal(weightedPoints({ high: 2, medium: 3, low: 4 }), 33);
  assert.deepEqual(countBySeverity([f('a', 'high'), f('b', 'low'), f('c', 'low')]), { high: 1, medium: 0, low: 2 });
});

test('category summary marks steps that did not run', () => {
  const steps = [
    { id: 'code', status: 'done' },
    { id: 'security', status: 'skipped' },
    { id: 'config', status: 'done' },
  ];
  const cats = summarizeCategories([f('x', 'medium')], steps);
  const byId = Object.fromEntries(cats.map((c) => [c.id, c]));
  assert.equal(byId.code.rating, 'review');
  assert.equal(byId.security.rating, 'not-run');
  assert.equal(byId.config.rating, 'good');
});

test('top 10 is severity first and capped per rule', () => {
  const findings = [
    ...Array.from({ length: 8 }, (_, i) => f('noisy', 'high', 'code', { recordName: `N${i}` })),
    f('rare', 'high', 'antipattern'),
    f('sec', 'medium', 'security'),
    ...Array.from({ length: 6 }, (_, i) => f(`low${i}`, 'low')),
  ];
  const top = pickTop(findings, 10);
  assert.equal(top.length, 10);
  assert.equal(top[0].ruleId, 'rare'); // anti-patterns rank before code at equal severity
  assert.equal(top.filter((x) => x.ruleId === 'noisy').length, 2);
  assert.ok(top.some((x) => x.ruleId === 'sec'));
  // When there are fewer distinct rules than slots, the cap relaxes.
  assert.equal(pickTop(findings.slice(0, 8), 10).length, 8);
});

test('rules aggregate counts and distinct records', () => {
  const rules = aggregateByRule([f('a', 'medium', 'code', { sysId: '1'.repeat(32) }), f('a', 'high', 'code', { sysId: '1'.repeat(32) }), f('a', 'low', 'code', { sysId: '2'.repeat(32) }), f('b', 'low')]);
  assert.equal(rules[0].ruleId, 'a');
  assert.equal(rules[0].count, 3);
  assert.equal(rules[0].records, 2);
  assert.equal(rules[0].severity, 'high');
  assert.equal(rules[0].points, 14);
});

test('report, filters, markdown, csv and the AI digest', () => {
  const report = buildReport({
    findings: [f('client-gliderecord', 'high', 'antipattern', { excerpt: "var password = 'abc123456';" }), f('si-missing-type', 'low', 'code'), f('updateset-stale', 'low', 'config', { table: 'sys_update_set' })],
    steps: [{ id: 'collect', label: 'Find custom code', status: 'done', notes: [] }, { id: 'security', label: 'Security audit', status: 'skipped', detail: 'Turned off for this scan.', notes: [] }],
    tables: [
      { table: 'sys_script', label: 'Business Rule', status: 'scanned', records: 3, scripts: 3, lines: 40, missing: [] },
      { table: 'sys_processor', label: 'Processor', status: 'unavailable', note: 'not available on this instance', missing: [] },
    ],
    options: normalizeScanOptions({}),
    baseline: { method: 'customer-updates', label: 'Records with a customer update' },
    origin: 'https://dev1.service-now.com',
    startedAt: 1,
    finishedAt: 2,
  });
  assert.equal(report.scanned.records, 3);
  assert.equal(report.top[0].ruleId, 'client-gliderecord');
  assert.equal(filterFindings(report.findings, { severity: 'low' }).length, 2);
  assert.equal(filterFindings(report.findings, { category: 'config' }).length, 1);
  assert.equal(filterFindings(report.findings, { table: 'sys_update_set' }).length, 1);
  assert.equal(filterFindings(report.findings, { text: 'GLIDERECORD' }).length, 1);

  const md = reportToMarkdown(report);
  assert.match(md, /# Instance health scan/);
  assert.match(md, /\| Anti-patterns \| Needs attention \| 1 \| 0 \| 0 \| 10 \|/);
  assert.match(md, /Processor \(sys_processor\): not available on this instance/);
  assert.match(md, /https:\/\/dev1\.service-now\.com\/sys_script\.do/);

  const csv = reportToCsv(report);
  assert.equal(csv.split('\r\n')[0], 'severity,category,rule,title,table,record,sys_id,field,line,occurrences,excerpt,why,fix,link');
  assert.equal(csv.split('\r\n').length, 4);

  const prompt = buildRemediationPrompt(report);
  assert.match(prompt, /remediation plan/);
  assert.ok(!prompt.includes('abc123456'), 'secrets are redacted from the digest');
  assert.match(prompt, /Security audit: skipped/);
});

// ---- review follow-up regressions ------------------------------------------------------------

test('custom evidence: child classes count and sibling tables are excluded from the prefix search', () => {
  const policy = scanTableDef('sys_ui_policy');
  assert.deepEqual(evidenceClasses(policy), ['sys_ui_policy', 'catalog_ui_policy']);
  const q = customerUpdateQuery(policy);
  assert.match(q, /^nameSTARTSWITHsys_ui_policy_\^ORnameSTARTSWITHcatalog_ui_policy_\^/);
  assert.match(q, /\^nameNOT LIKEsys_ui_policy_action_/);
  assert.match(q, /\^nameNOT LIKEcatalog_ui_policy_action_/);
  assert.ok(q.endsWith('^ORDERBYDESCsys_updated_on'));
  const br = customerUpdateQuery(scanTableDef('sys_script'));
  for (const sibling of ['sys_script_include_', 'sys_script_client_', 'sys_script_fix_', 'sys_script_email_']) assert.ok(br.includes(`^nameNOT LIKE${sibling}`), sibling);
  assert.ok(customerUpdateQuery(scanTableDef('sys_ui_action')).includes('^nameNOT LIKEsys_ui_action_view_'));
  // A catalog UI policy update parses and maps back to the scanned sys_ui_policy table.
  assert.deepEqual(parseUpdateName(`catalog_ui_policy_${'a'.repeat(32)}`, evidenceClasses(policy)), { table: 'catalog_ui_policy', sysId: 'a'.repeat(32) });
  assert.equal(classToTable().get('catalog_ui_policy'), 'sys_ui_policy');
  assert.equal(parseUpdateName(`sys_ui_policy_action_${'a'.repeat(32)}`, evidenceClasses(policy)), null);
});

test('N+1 rule no longer claims forEach / Allman loops are missed', () => {
  assert.doesNotMatch(ANTI_PATTERNS['nested-query'].misses, /forEach|brace/);
});

test('skipped upgrade findings name their disposition label', () => {
  const [f] = skippedUpgradeFindings([{ sys_id: '1'.repeat(32), disposition: '9', target_name: 'x', type: 'UI Page', priority: '1' }], {
    upgradeLabel: 'Australia',
    dispositionLabels: new Map([['9', 'Skipped Manual Merge']]),
  });
  assert.match(f.why, /Skipped Manual Merge, priority 1/);
  assert.equal(f.severity, 'medium');
});

test('a partial or failed check is never rated "Nothing found"', () => {
  assert.deepEqual(rateCounts({ high: 0, medium: 0, low: 0 }, 'partial'), { rating: 'partial', ratingLabel: 'Partly checked' });
  assert.equal(rateCounts({ high: 1, medium: 0, low: 0 }, 'partial').rating, 'attention');
  const cats = (status) => Object.fromEntries(summarizeCategories([], [{ id: 'security', status }]).map((c) => [c.id, c]));
  assert.equal(cats('partial').security.rating, 'partial');
  assert.equal(cats('partial').security.partial, true);
  assert.equal(cats('error').security.rating, 'not-run');
  assert.equal(cats('done').security.rating, 'good');
});

// Browser stubs for the content modules (same approach as tests/domrule-acl.test.js).
const sid = (n) => n.toString(16).padStart(32, '0');
function stubPage() {
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
const answer = (result, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { result } : { error: { message: 'denied' } }), { status, headers: { 'content-type': 'application/json' } });
function stubTables(route) {
  const calls = [];
  global.fetch = async (url) => {
    const u = new URL(url, 'https://dev1.service-now.com');
    const table = decodeURIComponent(u.pathname.split('/').pop());
    const query = u.searchParams.get('sysparm_query') || '';
    calls.push({ table, query });
    return route(table, query) || answer([]);
  };
  return calls;
}

test('audit: ACL operation is read through operation.name; sys_ids never appear; non-record ACLs are skipped', async () => {
  stubPage();
  const acls = [
    { sys_id: sid(1), name: 'incident', operation: sid(900), 'operation.name': 'read', 'type.name': 'record', condition: '', script: '' },
    { sys_id: sid(2), name: 'incident.state', operation: sid(901), 'operation.name': 'write', 'type.name': 'record', condition: '', script: '' },
    { sys_id: sid(3), name: 'x', operation: sid(902), condition: '', script: '' },
    { sys_id: sid(4), name: 'api/now/x', operation: sid(903), 'operation.name': 'execute', 'type.name': 'rest_endpoint', condition: '', script: '' },
  ];
  stubTables((table) => (table === 'sys_security_acl' ? answer(acls) : null));
  const result = await runSecurityAudit();
  const open = result.findings.filter((f) => f.category === 'ACL');
  assert.deepEqual(open.map((f) => `${f.severity}|${f.message}`).sort(), [
    'high|ACL "incident.state" (write) grants access with no role, condition or script.',
    'medium|ACL "incident" (read) grants access with no role, condition or script.',
    'medium|ACL "x" (unknown operation) grants access with no role, condition or script.',
  ]);
  assert.equal(openAclSeverity('delete'), 'high');
  assert.equal(openAclSeverity('report_on'), 'medium');
  assert.equal(isRecordAcl({ type: 'record' }), true);
  assert.equal(isRecordAcl({ type: sid(5), 'type.name': 'ui_page' }), false);
});

test('audit: keepRecords narrows record checks before the role lookup; failed reads are errors, not "nothing found"', async () => {
  stubPage();
  const acls = [1, 2, 3].map((i) => ({ sys_id: sid(i), name: `t${i}`, 'operation.name': 'write', condition: '', script: '' }));
  const calls = stubTables((table) => {
    if (table === 'sys_security_acl') return answer(acls);
    if (table === 'sys_public') return answer(null, 403);
    if (table === 'sp_widget') return answer([{ sys_id: sid(50), name: 'Login' }]);
    return null;
  });
  const asked = [];
  const result = await runSecurityAudit({
    keepRecords: async (table) => {
      asked.push(table);
      return new Set(table === 'sys_security_acl' ? [sid(2)] : []);
    },
  });
  assert.deepEqual(result.findings.filter((f) => f.category === 'ACL').map((f) => f.link), [`/sys_security_acl.do?sys_id=${sid(2)}`]);
  assert.equal(calls.find((c) => c.table === 'sys_security_acl_role').query, `sys_security_aclIN${sid(2)}`);
  assert.ok(!result.findings.some((f) => /Login/.test(f.message)), 'the baseline widget is filtered out');
  assert.ok(asked.includes('sp_widget'));
  assert.ok(result.errors.some((e) => e.check === 'Public pages' && !e.incomplete && /403/.test(e.error)));
});

test('scan: the security step is an error when no check could run, partial when some failed', async () => {
  stubPage();
  global.location = { origin: 'https://dev1.service-now.com' };
  // No scanned table exists; every security read is refused.
  stubTables((table) => (table === 'sys_db_object' || table === 'sys_dictionary' ? answer([]) : answer(null, 403)));
  let report = await runHealthScan({ includeBaseline: true, tables: ['sys_processor'] });
  let security = report.steps.find((s) => s.id === 'security');
  assert.equal(security.status, 'error');
  assert.match(security.detail, /No security check could run/);
  assert.equal(report.categories.find((c) => c.id === 'security').rating, 'not-run');

  // Only public pages are refused: the rest ran, so the step is partial.
  stubTables((table) => (table === 'sys_public' ? answer(null, 403) : null));
  report = await runHealthScan({ includeBaseline: true, tables: ['sys_processor'] });
  security = report.steps.find((s) => s.id === 'security');
  assert.equal(security.status, 'partial');
  assert.ok(security.notes.some((n) => /^Public pages could not run/.test(n)));
  assert.equal(report.categories.find((c) => c.id === 'security').rating, 'partial');
  assert.match(notCheckedList(report).join('\n'), /Security audit: partial/);
});
