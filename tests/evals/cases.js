// Eval cases for the script skills. Each case is a task a developer would give
// the agent, a reference solution that must verify clean, and (for client
// scripts) simulator scenarios that prove it behaves.
//
// Offline (npm test): every reference solution must pass verification and its
// scenarios, and every `bad` script must be caught by the named rule. This is
// the regression suite for the verifier and the simulator.
// Live (npm run eval -- --live): a real model writes the script from `prompt`
// and the same checks score it. See tests/evals/run.js.

const INCIDENT = ['number', 'caller_id', 'category', 'short_description', 'description', 'priority', 'impact', 'urgency', 'state', 'assignment_group', 'assigned_to', 'u_phone', 'u_cause', 'sys_id'];

export const CASES = [
  // ------------------------------------------------------------------ client
  {
    id: 'client-mandatory-on-p1',
    side: 'client',
    kind: 'client_script',
    clientType: 'onChange',
    table: 'incident',
    fields: INCIDENT,
    prompt: 'On the incident form, when Priority changes to 1 make Assignment group mandatory; for any other priority make it optional.',
    solution: `function onChange(control, oldValue, newValue, isLoading, isTemplate) {
  if (isLoading || newValue === '') {
    return;
  }
  g_form.setMandatory('assignment_group', newValue === '1');
}`,
    scenarios: [
      { name: 'P1 makes it mandatory', scenario: { fields: { priority: '3', assignment_group: '' }, changedField: 'priority', oldValue: '3', newValue: '1' }, expect: { fields: { assignment_group: { mandatory: true } } } },
      { name: 'P3 makes it optional', scenario: { fields: { priority: '1', assignment_group: { value: '', mandatory: true } }, changedField: 'priority', oldValue: '1', newValue: '3' }, expect: { fields: { assignment_group: { mandatory: false } } } },
      { name: 'does nothing while the form loads', scenario: { fields: { assignment_group: '' }, newValue: '1', isLoading: true }, expect: { calls: 0 } },
    ],
    bad: [
      { why: 'misspelled g_form method', code: `function onChange(control, oldValue, newValue, isLoading, isTemplate) {\n  if (isLoading || newValue === '') return;\n  g_form.setMandatroy('assignment_group', true);\n}`, rule: 'api-unknown-method' },
      { why: 'no isLoading guard', code: `function onChange(control, oldValue, newValue, isLoading, isTemplate) {\n  g_form.setMandatory('assignment_group', newValue === '1');\n}`, rule: 'client-onchange-guard' },
      { why: 'invented field name', code: `function onChange(control, oldValue, newValue, isLoading, isTemplate) {\n  if (isLoading || newValue === '') return;\n  g_form.setMandatory('assigned_group', true);\n}`, rule: 'unknown-field' },
    ],
  },
  {
    id: 'client-readonly-non-admin',
    side: 'client',
    kind: 'client_script',
    clientType: 'onLoad',
    table: 'incident',
    fields: INCIDENT,
    prompt: 'On load of the incident form, make Priority read-only unless the user has the admin role.',
    solution: `function onLoad() {
  if (!g_user.hasRole('admin')) {
    g_form.setReadOnly('priority', true);
  }
}`,
    scenarios: [
      { name: 'itil user: read-only', scenario: { fields: { priority: '2' }, user: { roles: ['itil'] } }, expect: { fields: { priority: { readOnly: true } } } },
      { name: 'admin: editable', scenario: { fields: { priority: '2' }, user: { roles: ['admin'] } }, expect: { fields: { priority: { readOnly: false } } } },
    ],
    bad: [{ why: 'server API in a client script', code: `function onLoad() {\n  if (!gs.hasRole('admin')) { g_form.setReadOnly('priority', true); }\n}`, rule: 'api-wrong-side' }],
  },
  {
    id: 'client-ajax-fill-phone',
    side: 'client',
    kind: 'client_script',
    clientType: 'onChange',
    table: 'incident',
    fields: INCIDENT,
    prompt: "When Caller changes, call the client-callable Script Include 'UserUtils' (method getPhone, parameter sysparm_user_id) and put the answer in Contact phone (u_phone).",
    solution: `function onChange(control, oldValue, newValue, isLoading, isTemplate) {
  if (isLoading || newValue === '') {
    return;
  }
  var ga = new GlideAjax('UserUtils');
  ga.addParam('sysparm_name', 'getPhone');
  ga.addParam('sysparm_user_id', newValue);
  ga.getXMLAnswer(function (answer) {
    g_form.setValue('u_phone', answer);
  });
}`,
    scenarios: [
      { name: 'fills the phone from the answer', scenario: { fields: { caller_id: '', u_phone: '' }, changedField: 'caller_id', newValue: 'abc123', ajax: { 'UserUtils.getPhone': '555-0100' } }, expect: { fields: { u_phone: { value: '555-0100' } }, ajax: 1 } },
    ],
    bad: [
      { why: 'synchronous GlideAjax', code: `function onChange(c, o, newValue, isLoading) {\n  if (isLoading) return;\n  var ga = new GlideAjax('UserUtils');\n  ga.addParam('sysparm_name', 'getPhone');\n  var r = ga.getXMLWait();\n}`, rule: 'no-sync-glideajax' },
      { why: 'GlideAjax never names the method', code: `function onChange(c, o, newValue, isLoading) {\n  if (isLoading) return;\n  var ga = new GlideAjax('UserUtils');\n  ga.getXMLAnswer(function (a) { g_form.setValue('u_phone', a); });\n}`, rule: 'ajax-missing-sysparm-name' },
      { why: 'GlideRecord on the client', code: `function onChange(c, o, newValue, isLoading) {\n  if (isLoading) return;\n  var gr = new GlideRecord('sys_user');\n  gr.get(newValue);\n  g_form.setValue('u_phone', gr.phone);\n}`, rule: 'no-gliderecord-in-client-script' },
    ],
  },
  {
    id: 'client-onsubmit-block',
    side: 'client',
    kind: 'client_script',
    clientType: 'onSubmit',
    table: 'incident',
    fields: INCIDENT,
    prompt: 'On submit, block saving a priority 1 incident that has no description, and tell the user why on the description field.',
    solution: `function onSubmit() {
  if (g_form.getValue('priority') === '1' && g_form.getValue('description') === '') {
    g_form.showFieldMsg('description', 'A priority 1 incident needs a description.', 'error');
    return false;
  }
  return true;
}`,
    scenarios: [
      { name: 'P1 with no description is blocked', scenario: { fields: { priority: '1', description: '' } }, expect: { submitAllowed: false } },
      { name: 'P1 with a description saves', scenario: { fields: { priority: '1', description: 'Data centre is down' } }, expect: { submitAllowed: true } },
      { name: 'P3 saves', scenario: { fields: { priority: '3', description: '' } }, expect: { submitAllowed: true } },
    ],
    bad: [{ why: 'blocking native dialog and DOM', code: `function onSubmit() {\n  alert('no');\n  document.getElementById('x');\n  return false;\n}`, rule: 'no-dom-in-client-script' }],
  },
  {
    id: 'client-hide-cause',
    side: 'client',
    kind: 'client_script',
    clientType: 'onLoad',
    table: 'incident',
    fields: INCIDENT,
    prompt: 'On load, hide the Cause field unless the incident state is Resolved (6).',
    solution: `function onLoad() {
  g_form.setDisplay('u_cause', g_form.getValue('state') === '6');
}`,
    scenarios: [
      { name: 'hidden while open', scenario: { fields: { state: '2', u_cause: '' } }, expect: { fields: { u_cause: { visible: false } } } },
      { name: 'shown when resolved', scenario: { fields: { state: '6', u_cause: '' } }, expect: { fields: { u_cause: { visible: true } } } },
    ],
    bad: [{ why: 'wrong field name', code: `function onLoad() {\n  g_form.setDisplay('u_root_cause', false);\n}`, rule: 'unknown-field' }],
  },
  {
    id: 'client-getreference-department',
    side: 'client',
    kind: 'client_script',
    clientType: 'onChange',
    table: 'incident',
    fields: [...INCIDENT, 'u_department'],
    prompt: "When Caller changes, copy the caller's department sys_id into u_department using g_form.getReference with a callback.",
    solution: `function onChange(control, oldValue, newValue, isLoading, isTemplate) {
  if (isLoading || newValue === '') {
    return;
  }
  g_form.getReference('caller_id', function (caller) {
    g_form.setValue('u_department', caller.getValue('department'));
  });
}`,
    scenarios: [
      { name: 'copies the department', scenario: { fields: { caller_id: 'abc', u_department: '' }, changedField: 'caller_id', newValue: 'abc', references: { caller_id: { department: 'dept-1' } } }, expect: { fields: { u_department: { value: 'dept-1' } } } },
    ],
    bad: [{ why: 'getReference without a callback', code: `function onChange(c, o, newValue, isLoading) {\n  if (isLoading) return;\n  var caller = g_form.getReference('caller_id');\n}`, rule: 'no-sync-getreference' }],
  },

  // ------------------------------------------------------------------ server
  {
    id: 'server-br-block-duplicates',
    side: 'server',
    kind: 'business_rule',
    when: 'before',
    table: 'incident',
    fields: INCIDENT,
    prompt: 'Business rule on incident (before insert): stop the save when an active incident with the same caller and short description already exists, and tell the user which one.',
    solution: `(function executeRule(current, previous /*null when async*/) {
  var gr = new GlideRecord('incident');
  gr.addQuery('caller_id', current.getValue('caller_id'));
  gr.addQuery('short_description', current.getValue('short_description'));
  gr.addActiveQuery();
  gr.setLimit(1);
  gr.query();
  if (gr.next()) {
    gs.addErrorMessage('An open incident already exists: ' + gr.getValue('number'));
    current.setAbortAction(true);
  }
})(current, previous);`,
    bad: [
      { why: 'update() inside a before rule', code: `(function executeRule(current, previous) {\n  current.state = 2;\n  current.update();\n})(current, previous);`, rule: 'no-current-update-in-before-br' },
      { why: 'unconstrained query', code: `(function executeRule(current, previous) {\n  var gr = new GlideRecord('incident');\n  gr.query();\n  while (gr.next()) {}\n})(current, previous);`, rule: 'no-unbounded-query' },
      { why: 'invented field', code: `(function executeRule(current, previous) {\n  if (current.short_descripton == '') { current.setAbortAction(true); }\n})(current, previous);`, rule: 'unknown-field' },
    ],
  },
  {
    id: 'server-br-async-event',
    side: 'server',
    kind: 'business_rule',
    when: 'async',
    table: 'incident',
    fields: INCIDENT,
    prompt: 'Async business rule on incident: when priority changes to 1, queue the event incident.p1.raised with the incident number as parm1.',
    solution: `(function executeRule(current, previous /*null when async*/) {
  if (current.priority.changesTo('1')) {
    gs.eventQueue('incident.p1.raised', current, current.getValue('number'), gs.getUserName());
  }
})(current, previous);`,
    bad: [{ why: 'uses previous in an async rule', code: `(function executeRule(current, previous) {\n  if (previous.priority != current.priority) { gs.info('changed'); }\n})(current, previous);`, rule: 'br-previous-in-async' }],
  },
  {
    id: 'server-si-count',
    side: 'server',
    kind: 'script_include',
    prompt: 'Script Include MyUtils with a method getActiveCount(table) that returns the number of active records, efficiently.',
    solution: `var MyUtils = Class.create();
MyUtils.prototype = {
  initialize: function () {},

  getActiveCount: function (table) {
    var agg = new GlideAggregate(table);
    agg.addActiveQuery();
    agg.addAggregate('COUNT');
    agg.query();
    return agg.next() ? parseInt(agg.getAggregate('COUNT'), 10) : 0;
  },

  type: 'MyUtils'
};`,
    bad: [
      { why: 'ES6 in an ES5 server script', code: `var MyUtils = Class.create();\nMyUtils.prototype = {\n  count: (table) => { const gr = new GlideRecord(table); gr.query(); return gr.getRowCount(); },\n  type: 'MyUtils'\n};`, rule: 'es6-syntax' },
    ],
  },
  {
    id: 'server-si-client-callable',
    side: 'server',
    kind: 'script_include',
    prompt: "Client-callable Script Include MyUserUtils with a method getDepartment that returns the display value of the department of the user in 'sysparm_user_id'.",
    solution: `var MyUserUtils = Class.create();
MyUserUtils.prototype = Object.extendsObject(AbstractAjaxProcessor, {
  getDepartment: function () {
    var userId = this.getParameter('sysparm_user_id');
    var user = new GlideRecord('sys_user');
    if (user.get(userId)) {
      return user.getDisplayValue('department');
    }
    return '';
  },

  type: 'MyUserUtils'
});`,
    bad: [{ why: 'getParameter without extending AbstractAjaxProcessor', code: `var MyUserUtils = Class.create();\nMyUserUtils.prototype = {\n  getDepartment: function () { return this.getParameter('sysparm_user_id'); },\n  type: 'MyUserUtils'\n};`, rule: 'si-ajax-not-extended' }],
  },
  {
    id: 'server-acl-owner',
    side: 'server',
    kind: 'acl_script',
    table: 'incident',
    fields: INCIDENT,
    prompt: 'ACL script: allow itil users to read an incident only if they are the caller or it is assigned to them.',
    solution: `answer = false;
if (gs.hasRole('itil')) {
  var me = gs.getUserID();
  answer = current.getValue('caller_id') === me || current.getValue('assigned_to') === me;
}`,
    bad: [{ why: 'never sets answer', code: `if (gs.hasRole('itil')) {\n  gs.info('has role');\n}`, rule: 'acl-no-answer' }],
  },
  {
    id: 'server-scheduled-cleanup',
    side: 'server',
    kind: 'scheduled_job',
    prompt: 'Scheduled job: log how many incidents were closed more than 90 days ago (do not change anything).',
    solution: `var agg = new GlideAggregate('incident');
agg.addQuery('state', '7');
agg.addEncodedQuery('closed_at<javascript:gs.daysAgoStart(90)');
agg.addAggregate('COUNT');
agg.query();
var n = agg.next() ? parseInt(agg.getAggregate('COUNT'), 10) : 0;
gs.info('Incidents closed more than 90 days ago: ' + n, 'MySnowBuddy');`,
    bad: [{ why: 'current does not exist in a scheduled job', code: `if (current.state == 7) { gs.info('closed'); }`, rule: 'job-current' }],
  },
  {
    id: 'server-bg-group-report',
    side: 'server',
    kind: 'background_script',
    prompt: 'Background script: count active incidents per priority and print one line per priority.',
    solution: `var agg = new GlideAggregate('incident');
agg.addActiveQuery();
agg.addAggregate('COUNT');
agg.groupBy('priority');
agg.query();
while (agg.next()) {
  gs.info('Priority ' + agg.getValue('priority') + ': ' + agg.getAggregate('COUNT'));
}`,
    bad: [
      { why: 'next() without query()', code: `var gr = new GlideRecord('incident');\ngr.addActiveQuery();\nwhile (gr.next()) { gs.info(gr.number); }`, rule: 'gr-next-without-query' },
      { why: 'client API in a server script', code: `var p = g_form.getValue('priority');\ngs.info(p);`, rule: 'api-wrong-side' },
      { why: 'hallucinated GlideRecord method', code: `var gr = new GlideRecord('incident');\ngr.addActiveQuery();\ngr.query();\nwhile (gr.next()) { gr.updateRecord(); }`, rule: 'api-unknown-method' },
    ],
  },
];

// ---- shared checking logic (offline and live) --------------------------------------------

/** Pull the first fenced code block out of a model reply, or the whole text. */
export function extractCode(text) {
  const m = String(text || '').match(/```(?:javascript|js)?\n([\s\S]*?)```/i);
  return (m ? m[1] : String(text || '')).trim();
}

/** Check one simulator expectation against a run; returns a list of failure strings. */
export function checkExpectation(run, expect) {
  const failures = [];
  if (!run.ok) return [`script threw: ${run.error?.message}`];
  if (expect.calls !== undefined && run.calls.length !== expect.calls) failures.push(`expected ${expect.calls} g_form calls, got ${run.calls.length}`);
  if (expect.submitAllowed !== undefined && run.submitAllowed !== expect.submitAllowed) failures.push(`expected submitAllowed=${expect.submitAllowed}, got ${run.submitAllowed}`);
  if (expect.ajax !== undefined && run.ajaxCalls.length !== expect.ajax) failures.push(`expected ${expect.ajax} GlideAjax call(s), got ${run.ajaxCalls.length}`);
  for (const [name, want] of Object.entries(expect.fields || {})) {
    const got = run.finalFields[name];
    for (const [key, value] of Object.entries(want)) {
      if (!got || got[key] !== value) failures.push(`field ${name}.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(got?.[key])}`);
    }
  }
  return failures;
}
