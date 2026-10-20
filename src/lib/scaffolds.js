// "New ... from a template": good, current, safe boilerplate for the artifacts a ServiceNow developer creates
// most. Everything here is pure (no DOM, no network): build(kind, options) returns the field values, the script
// and a URL that opens a NEW record form with those values already filled in through the form's default-values
// query (table.do?sys_id=-1&sysparm_query=...). Nothing is written to the instance; the developer presses Submit.
//
// Templates are ES5 (the default on every release) and are checked by tests/scaffolds.test.js against the same
// verifier the editor uses, so they cannot ship a made-up API. Lines under an "Example (uncomment to use)" header
// are examples: the test uncomments them and verifies that version too.

/** Past this many characters of encoded query the URL is not opened: the template goes to the clipboard instead. */
export const MAX_QUERY_URL = 6000;

const BR_WHEN = ['before', 'after', 'async', 'display'];
const CLIENT_TYPES = ['onLoad', 'onChange', 'onSubmit', 'onCellEdit'];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const UIA_VARIANTS = ['roundtrip', 'client', 'server'];
const SI_VARIANTS = ['class', 'ajax'];

/** What can be built. `words` are what a developer types after "new" / "/new". */
export const KINDS = {
  br: { label: 'Business Rule', table: 'sys_script', words: ['br', 'business rule', 'businessrule', 'rule'], verify: 'business_rule' },
  si: { label: 'Script Include', table: 'sys_script_include', words: ['si', 'script include', 'scriptinclude', 'include'], verify: 'script_include' },
  cs: { label: 'Client Script', table: 'sys_script_client', words: ['cs', 'client script', 'clientscript'], verify: 'client_script' },
  uia: { label: 'UI Action', table: 'sys_ui_action', words: ['uia', 'ui action', 'uiaction', 'action'], verify: 'ui_action_client' },
  sj: { label: 'Scheduled Job', table: 'sysauto_script', words: ['sj', 'job', 'scheduled job', 'scheduledjob'], verify: 'scheduled_job' },
  fix: { label: 'Fix Script', table: 'sys_script_fix', words: ['fix', 'fix script', 'fixscript'], verify: 'scheduled_job' },
  rest: { label: 'Scripted REST resource', table: 'sys_ws_operation', words: ['rest', 'scripted rest', 'scriptedrest', 'resource'], verify: 'scripted_rest' },
};

export const KIND_IDS = Object.keys(KINDS);

// --- Names ----------------------------------------------------------------------------------------

const TABLE_RE = /^[a-z][a-z0-9_]*$/;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const SCOPE_RE = /^(?:x_[a-z0-9]+_[a-z0-9_]+|sn_[a-z0-9_]+)$/;

/** A Script Include name must be a JavaScript identifier (it is the class name and the GlideAjax name). */
export function validateIdentifier(name) {
  const value = String(name ?? '').trim();
  if (!value) return { ok: false, error: 'Give it a name, for example MyHelper.' };
  if (/\s/.test(value)) return { ok: false, error: 'A Script Include name cannot contain spaces: it is the class name. Try ' + pascalCase(value) + '.' };
  if (!IDENT_RE.test(value)) return { ok: false, error: 'Use letters, digits, "_" and "$" only, starting with a letter.' };
  return { ok: true, name: value };
}

/** A readable record name: not empty, no control characters, not absurdly long. */
export function validateTitle(name) {
  const value = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, error: 'Give it a name.' };
  if (value.length > 100) return { ok: false, error: 'Keep the name under 100 characters.' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) return { ok: false, error: 'The name contains control characters.' };
  return { ok: true, name: value };
}

export function pascalCase(text) {
  const parts = String(text ?? '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const joined = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return /^[0-9]/.test(joined) ? `My${joined}` : joined;
}

export function validateTable(table) {
  const value = String(table ?? '').trim().toLowerCase();
  if (!value) return { ok: false, error: 'Say which table, for example "on incident".' };
  if (!TABLE_RE.test(value)) return { ok: false, error: `"${table}" is not a table name (lower case letters, digits and "_").` };
  return { ok: true, table: value };
}

export const looksLikeScope = (text) => SCOPE_RE.test(String(text || ''));

// --- Encoding -------------------------------------------------------------------------------------

/**
 * The default-values query for a new record. A caret would start the next condition, so it is doubled (see
 * escapeQueryValue); newlines stay, because a script has them and the whole query is URL-encoded afterwards.
 */
export function encodeDefaults(values) {
  return Object.entries(values)
    .filter(([key, value]) => key && value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value).replace(/\^/g, '^^')}`)
    .join('^');
}

export function newRecordUrl(table, values) {
  return `/${table}.do?sys_id=-1&sysparm_query=${encodeURIComponent(encodeDefaults(values))}`;
}

// --- Templates ------------------------------------------------------------------------------------

const lines = (...rows) => rows.join('\n');

function brScript({ name, when }) {
  const tag = `[${name}]`;
  const head = {
    before: [
      '  // Runs BEFORE the record is saved. Change `current` directly: the platform saves it afterwards.',
      '  // Never call current.update() here; it re-runs every rule on this record and can loop.',
    ],
    after: [
      '  // Runs AFTER the record is saved. `current` is already in the database, so changing it needs current.update(),',
      '  // which re-runs rules. Prefer changing a different record, or call current.setWorkflow(false) first if you must.',
    ],
    async: [
      '  // Runs later, in the background, after the save. Keep it light: it does not slow the user down, but it',
      '  // still takes a worker. `previous` is not reliable here; capture old values in a before rule if you need them.',
    ],
    display: [
      '  // Runs when the form LOADS, before the user sees it. Use it to hand values to client scripts through',
      '  // g_scratchpad (read it in an onLoad client script). Do not change `current` here: it is not saved.',
    ],
  }[when];
  const example = {
    before: [
      '  // Example (uncomment to use):',
      "  // if (current.short_description.changes() && current.short_description.nil()) {",
      "  //   gs.addErrorMessage('Short description cannot be empty.');",
      '  //   current.setAbortAction(true);',
      '  // }',
    ],
    after: [
      '  // Example (uncomment to use):',
      "  // var child = new GlideRecord('task');",
      "  // child.addQuery('parent', current.getUniqueValue());",
      '  // child.query();',
      '  // while (child.next()) {',
      "  //   child.setValue('work_notes', 'Parent ' + current.getDisplayValue() + ' was updated.');",
      '  //   child.update();',
      '  // }',
    ],
    async: [
      '  // Example (uncomment to use):',
      "  // var audit = new GlideRecord('task');",
      '  // if (audit.get(current.getUniqueValue())) {',
      "  //   gs.info('Processed ' + audit.getDisplayValue());",
      '  // }',
    ],
    display: [
      '  // Example (uncomment to use):',
      "  // g_scratchpad.isNewRecord = current.isNewRecord();",
      "  // g_scratchpad.recordLabel = current.getDisplayValue();",
    ],
  }[when];
  return lines(
    '(function executeRule(current, previous /*null when async*/) {',
    '',
    ...head,
    '',
    '  // Guard first: do nothing unless the change you care about happened.',
    '  // if (!current.state.changes()) {',
    '  //   return;',
    '  // }',
    '',
    `  // Breadcrumb for debugging (remove it before you ship):`,
    `  // gs.info('${tag} ' + current.getTableName() + ' ' + current.getDisplayValue());`,
    '',
    ...example,
    '',
    '})(current, previous);',
    ''
  );
}

function siScript({ name, variant, scoped }) {
  const scopeNote = scoped
    ? [`// Scoped application: other scopes call this as <scope>.${name} and need "Accessible from: All application scopes".`, '// GlideAjax from the client uses the same scoped name.']
    : ['// Global scope. In a scoped application the name other scopes use is <scope>.' + name + '.'];
  if (variant === 'ajax') {
    return lines(
      ...scopeNote,
      '// Client callable: tick "Client callable" on this record, otherwise GlideAjax cannot reach it.',
      '// From a client script:',
      `//   var ga = new GlideAjax('${name}');`,
      "//   ga.addParam('sysparm_name', 'getDisplay');",
      "//   ga.addParam('sysparm_sys_id', g_form.getUniqueValue());",
      '//   ga.getXMLAnswer(function (answer) { g_form.addInfoMessage(answer); });',
      `var ${name} = Class.create();`,
      `${name}.prototype = Object.extendsObject(${scoped ? 'global.' : ''}AbstractAjaxProcessor, {`,
      '',
      '  /** Called with sysparm_name = getDisplay. Whatever it returns is the answer on the client. */',
      '  getDisplay: function () {',
      "    var sysId = this.getParameter('sysparm_sys_id');",
      '    if (!sysId) {',
      "      return '';",
      '    }',
      "    var gr = new GlideRecord('task');",
      '    if (!gr.get(sysId)) {',
      "      return '';",
      '    }',
      '    return gr.getDisplayValue();',
      '  },',
      '',
      `  type: '${name}'`,
      '});',
      ''
    );
  }
  return lines(
    ...scopeNote,
    `var ${name} = Class.create();`,
    `${name}.prototype = {`,
    '',
    '  initialize: function () {',
    '    // Runs on new ' + name + '(...). Keep constructor work cheap.',
    '  },',
    '',
    '  /** Example method: the display value of a task, or an empty string when it is not found. */',
    '  getDisplay: function (sysId) {',
    '    if (!sysId) {',
    "      return '';",
    '    }',
    "    var gr = new GlideRecord('task');",
    '    if (!gr.get(sysId)) {',
    "      return '';",
    '    }',
    '    return gr.getDisplayValue();',
    '  },',
    '',
    `  type: '${name}'`,
    '};',
    ''
  );
}

function csScript({ type, field }) {
  switch (type) {
    case 'onLoad':
      return lines(
        'function onLoad() {',
        '  // Runs once when the form opens. For anything slow use GlideAjax with a callback, never a synchronous call.',
        '  // Example (uncomment to use):',
        "  // g_form.setReadOnly('number', true);",
        '}',
        ''
      );
    case 'onSubmit':
      return lines(
        'function onSubmit() {',
        '  // Return false to stop the save (after telling the user why), true to let it through.',
        '  // Example (uncomment to use):',
        "  // if (g_form.getValue('short_description') === '') {",
        "  //   g_form.addErrorMessage('Short description is required.');",
        '  //   return false;',
        '  // }',
        '  return true;',
        '}',
        ''
      );
    case 'onCellEdit':
      return lines(
        'function onCellEdit(sysIDs, table, oldValues, newValue, callback) {',
        '  var saveAndClose = true;',
        '',
        '  // Your checks here. Set saveAndClose = false to reject the edit.',
        "  // Example (uncomment to use): reject an empty value",
        "  // if (newValue === '') {",
        '  //   saveAndClose = false;',
        '  // }',
        '',
        '  // Always call callback, on every path: the list stays frozen until you do.',
        '  callback(saveAndClose);',
        '}',
        ''
      );
    default:
      return lines(
        'function onChange(control, oldValue, newValue, isLoading, isTemplate) {',
        "  // onChange also fires once while the form loads, and when the field is emptied: usually do nothing then.",
        "  if (isLoading || newValue === '') {",
        '    return;',
        '  }',
        '',
        `  // This script is watching the field "${field}".`,
        '  // Example (uncomment to use):',
        "  // g_form.setMandatory('comments', newValue === '1');",
        "  // g_form.showFieldMsg('" + field + "', 'Changed from ' + oldValue + ' to ' + newValue, 'info');",
        '}',
        ''
      );
  }
}

function uiaScript({ variant, action }) {
  if (variant === 'server') {
    return lines(
      '// Server-side UI Action: runs on the server when the button is clicked (the "Client" box is NOT ticked).',
      '// `current` is the record on the form; `action` controls where the user lands afterwards.',
      '// Example (uncomment to use):',
      "// current.setValue('work_notes', 'Done from the button.');",
      'current.update();',
      'action.setRedirectURL(current);',
      ''
    );
  }
  if (variant === 'client') {
    return lines(
      '// Client-side UI Action: runs in the browser; the "Client" box is ticked and Onclick is runClientCode().',
      'function runClientCode() {',
      '  // Example (uncomment to use):',
      "  // g_form.addInfoMessage('Clicked on ' + g_form.getUniqueValue());",
      '}',
      ''
    );
  }
  return lines(
    '// Client + server UI Action. The "Client" box is ticked, Onclick is runClientCode(), and the "Action name"',
    `// field must be exactly ${action}: gsftSubmit sends it back and the server part below runs.`,
    'function runClientCode() {',
    '  // Client side: validate before the round trip.',
    '  // Example (uncomment to use):',
    "  // if (g_form.getValue('short_description') === '') {",
    "  //   g_form.addErrorMessage('Short description is required.');",
    '  //   return false;',
    '  // }',
    '',
    `  gsftSubmit(null, g_form.getFormElement(), '${action}');`,
    '}',
    '',
    "// Server side: runs on the server after gsftSubmit, where there is no `window`.",
    "if (typeof window == 'undefined') {",
    '  runServerCode();',
    '}',
    '',
    'function runServerCode() {',
    '  // `current` holds the form values from the round trip.',
    '  current.update();',
    '  action.setRedirectURL(current);',
    '}',
    ''
  );
}

function jobBody({ name, table, kindLabel }) {
  return lines(
    '(function () {',
    `  var TABLE = '${table}';`,
    "  var QUERY = 'active=true'; // only records that still NEED the change: a second run then finds nothing",
    '  var DRY_RUN = true; // true: log what would change and write nothing. Set to false to apply.',
    '  var BATCH_SIZE = 200; // one batch per run keeps the transaction short; run it again for the next batch',
    '',
    '  var gr = new GlideRecord(TABLE);',
    '  gr.addEncodedQuery(QUERY);',
    "  gr.orderBy('sys_created_on');",
    '  gr.setLimit(BATCH_SIZE);',
    '  gr.query();',
    '',
    '  var count = 0;',
    '  while (gr.next()) {',
    '    count++;',
    '    if (DRY_RUN) {',
    `      gs.info('[${name}] would update ' + gr.getDisplayValue() + ' (' + gr.getUniqueValue() + ')');`,
    '      continue;',
    '    }',
    "    // gr.setValue('FIELD', 'VALUE');",
    '    // gr.setWorkflow(false); // data fixes: skip business rules, flows and notifications',
    '    gr.update();',
    '  }',
    '',
    `  gs.info('[${name}] ' + (DRY_RUN ? 'DRY RUN: ' : '') + count + ' record(s) processed, batch limit ' + BATCH_SIZE);`,
    '})();',
    ''
  ).replace(/^/, kindLabel === 'Fix Script' ? '// Fix Script: run it from this record with the Run Fix Script button. Run it as a dry run first.\n// The script record itself travels in the update set; the DATA it changes does not.\n' : '// Scheduled Job: the schedule is set on this record. There is no `current` here: query what you need.\n');
}

function restScript({ method, table }) {
  const m = method.toUpperCase();
  const header = `// ${m} resource. request.pathParams, request.queryParams and request.body.data hold the input.\n// Return an object to send it as JSON; set the status code first when it is not 200.\n`;
  if (m === 'GET' || m === 'DELETE') {
    const action =
      m === 'DELETE'
        ? lines(
            '  var sysId = String(gr.getUniqueValue());',
            '  if (!gr.deleteRecord()) {',
            '    response.setStatus(500);',
            "    return { error: { message: 'Could not delete the record.' } };",
            '  }',
            '  response.setStatus(200);',
            '  return { result: { deleted: sysId } };'
          )
        : lines('  response.setStatus(200);', '  return { result: { sys_id: gr.getUniqueValue(), display: gr.getDisplayValue() } };');
    return (
      header +
      lines(
        '(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {',
        '',
        '  var id = request.queryParams.id;',
        '  if (!id) {',
        '    response.setStatus(400);',
        "    return { error: { message: 'Missing query parameter: id' } };",
        '  }',
        '',
        `  var gr = new GlideRecord('${table}');`,
        '  if (!gr.get(id)) {',
        '    response.setStatus(404);',
        "    return { error: { message: 'Not found: ' + id } };",
        '  }',
        '',
        action,
        '})(request, response);',
        ''
      )
    );
  }
  return (
    header +
    lines(
      '(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {',
      '',
      '  var body = request.body.data;',
      '  if (!body || !body.short_description) {',
      '    response.setStatus(400);',
      "    return { error: { message: 'short_description is required.' } };",
      '  }',
      '',
      `  var gr = new GlideRecord('${table}');`,
      '  gr.initialize();',
      "  gr.setValue('short_description', String(body.short_description));",
      '  var sysId = gr.insert();',
      '  if (!sysId) {',
      '    response.setStatus(500);',
      "    return { error: { message: 'The record could not be created.' } };",
      '  }',
      '',
      '  response.setStatus(201);',
      '  return { result: { sys_id: sysId, display: gr.getDisplayValue() } };',
      '})(request, response);',
      ''
    )
  );
}

/**
 * What to run through the verifier. A round-trip UI Action is two scripts in one field (browser, then server after
 * gsftSubmit), so each half is checked on its own side.
 */
function verifyParts(kind, verify, script) {
  const cut = script.indexOf('// Server side:');
  if (kind === 'uia' && cut > 0) {
    return [
      { ...verify, kind: 'ui_action_client', code: script.slice(0, cut) },
      { ...verify, kind: 'background_script', code: script.slice(cut) },
    ];
  }
  return [{ ...verify, code: script }];
}

// --- Build ----------------------------------------------------------------------------------------

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/**
 * @param {keyof typeof KINDS} kind
 * @param {{ name?: string, table?: string, when?: string, type?: string, field?: string, method?: string,
 *           variant?: string, scoped?: boolean }} [options]
 * @returns {{ ok: true, kind: string, label: string, table: string, values: object, script: string, url: string,
 *             copyOnly: boolean, notes: string[], verify: object } | { ok: false, error: string }}
 */
export function build(kind, options = {}) {
  const def = KINDS[kind];
  if (!def) return { ok: false, error: `Unknown template "${kind}". Choose one of: ${KIND_IDS.join(', ')}.` };
  const scoped = options.scoped === true;
  const notes = [];
  const values = { active: 'true' };
  let script = '';
  const verify = { kind: def.verify, scoped };
  let title;

  if (kind === 'br') {
    const table = validateTable(options.table);
    if (!table.ok) return { ok: false, error: table.error };
    const when = oneOf(String(options.when || '').toLowerCase(), BR_WHEN, 'before');
    title = validateTitle(options.name || `${table.table} ${when} rule`);
    if (!title.ok) return { ok: false, error: title.error };
    Object.assign(values, { name: title.name, collection: table.table, when, order: '100', advanced: 'true', action_insert: 'true', action_update: 'true' });
    if (when === 'display') Object.assign(values, { action_insert: 'false', action_update: 'false' });
    script = brScript({ name: title.name, when });
    Object.assign(verify, { when, table: table.table });
    notes.push(when === 'display' ? 'Runs when the form loads, before the user sees it.' : `Runs ${when} on insert and update; change the "When to run" tab as needed.`);
    if (when === 'before') notes.push('A before rule saves `current` for you: never call current.update() in it.');
  } else if (kind === 'si') {
    const ident = validateIdentifier(options.name);
    if (!ident.ok) return { ok: false, error: ident.error };
    const variant = oneOf(options.variant, SI_VARIANTS, 'class');
    title = ident;
    Object.assign(values, { name: ident.name, client_callable: variant === 'ajax' ? 'true' : 'false' });
    if (scoped) values.access = 'package_private';
    script = siScript({ name: ident.name, variant, scoped });
    notes.push(variant === 'ajax' ? 'Client callable is ticked. Call it from a client script with GlideAjax and a callback.' : 'Call it with new ' + ident.name + '().getDisplay(sysId).');
    notes.push(scoped ? 'Scoped: other scopes call it as <scope>.' + ident.name + '; set "Accessible from" to share it.' : 'Global scope. Make it a scoped application if it belongs to one app.');
  } else if (kind === 'cs') {
    const table = validateTable(options.table);
    if (!table.ok) return { ok: false, error: table.error };
    const type = oneOf(options.type, CLIENT_TYPES, 'onChange');
    const needsField = type === 'onChange' || type === 'onCellEdit';
    const field = String(options.field || 'short_description').trim();
    if (needsField && !/^[a-z][a-z0-9_.]*$/.test(field)) return { ok: false, error: `"${field}" is not a field name.` };
    title = validateTitle(options.name || `${table.table} ${type}${needsField ? ` ${field}` : ''}`);
    if (!title.ok) return { ok: false, error: title.error };
    Object.assign(values, { name: title.name, table: table.table, type, ui_type: '10' });
    if (needsField) values.field = field;
    script = csScript({ type, field });
    Object.assign(verify, { clientType: type, table: table.table });
    notes.push(needsField ? `Watches ${table.table}.${field}.` : `Runs ${type === 'onLoad' ? 'when the form opens' : 'when the form is submitted'}.`);
  } else if (kind === 'uia') {
    const table = validateTable(options.table);
    if (!table.ok) return { ok: false, error: table.error };
    const variant = oneOf(options.variant, UIA_VARIANTS, 'roundtrip');
    title = validateTitle(options.name || `${table.table} action`);
    if (!title.ok) return { ok: false, error: title.error };
    const action = String(title.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'my_action';
    Object.assign(values, { name: title.name, table: table.table, action_name: action, form_button: 'true', client: variant === 'server' ? 'false' : 'true' });
    if (variant !== 'server') values.onclick = 'runClientCode()';
    script = uiaScript({ variant, action });
    if (variant === 'server') verify.kind = 'background_script';
    notes.push(variant === 'roundtrip' ? `Client + server: the Action name is ${action} and must match the gsftSubmit call.` : variant === 'client' ? 'Client side only: Onclick is runClientCode().' : 'Server side only: the Client box stays unticked.');
  } else if (kind === 'sj' || kind === 'fix') {
    const table = validateTable(options.table || 'incident');
    if (!table.ok) return { ok: false, error: table.error };
    title = validateTitle(options.name || (kind === 'sj' ? `${table.table} cleanup job` : `${table.table} data fix`));
    if (!title.ok) return { ok: false, error: title.error };
    values.name = title.name;
    if (kind === 'sj') values.run_type = 'daily';
    script = jobBody({ name: title.name, table: table.table, kindLabel: def.label });
    notes.push('DRY_RUN starts as true: read the log, then set it to false.');
    notes.push(kind === 'fix' ? 'Fix scripts change data, and data is not captured in an update set: run it on each instance.' : 'Set the schedule on the record before activating it.');
  } else if (kind === 'rest') {
    const table = validateTable(options.table || 'incident');
    if (!table.ok) return { ok: false, error: table.error };
    const method = oneOf(String(options.method || 'GET').toUpperCase(), HTTP_METHODS, 'GET');
    title = validateTitle(options.name || `${method} ${table.table}`);
    if (!title.ok) return { ok: false, error: title.error };
    Object.assign(values, { name: title.name, http_method: method });
    script = restScript({ method, table: table.table });
    notes.push('Open this from the Resources related list of your Scripted REST API so it is linked to that API.');
  }

  // Both fields hold the script on their own table.
  values[kind === 'rest' ? 'operation_script' : 'script'] = script;

  let url = newRecordUrl(def.table, values);
  const copyOnly = url.length > MAX_QUERY_URL;
  if (copyOnly) {
    const without = { ...values };
    delete without.script;
    delete without.operation_script;
    url = newRecordUrl(def.table, without);
    notes.push('The template is too long for a link: it is on the clipboard, paste it into the script field.');
  }
  return { ok: true, kind, label: def.label, table: def.table, values, script, url, copyOnly, notes, verify: { ...verify, code: script }, checks: verifyParts(kind, verify, script) };
}

// --- What the developer typed ---------------------------------------------------------------------------

const LEAD_RE = /^\/?(?:new|create|start|make|scaffold)\b\s*/i;

/** Is this text a request for a template ("/new si", "new business rule on incident", "start a new script include")? */
export function isNewRequest(text) {
  const t = String(text || '').trim();
  if (/^\/new\b/i.test(t)) return true;
  return /^(?:new|create|start|make|scaffold)\b(?:\s+(?:a|an))?\s+/i.test(t) && Boolean(resolveKind(stripLead(t)).kind);
}

/** "/new br on incident" -> { kind: 'br', rest: 'on incident', text: 'br on incident' }; kind is null when none is named yet. */
export function splitRequest(text) {
  const stripped = stripLead(text);
  return { ...resolveKind(stripped), text: stripped };
}

function stripLead(text) {
  return String(text || '')
    .trim()
    .replace(LEAD_RE, '')
    .replace(/^(?:(?:a|an|new)\s+)+/i, '')
    .trim();
}

/** The kind named at the start of `text`, longest wording first, and what follows it. */
export function resolveKind(text) {
  const t = String(text || '').trim();
  const lower = t.toLowerCase();
  let best = null;
  Object.entries(KINDS).forEach(([id, def]) => {
    def.words.forEach((word) => {
      if ((lower === word || lower.startsWith(`${word} `)) && (!best || word.length > best.word.length)) best = { id, word };
    });
  });
  return best ? { kind: best.id, rest: t.slice(best.word.length).trim() } : { kind: null, rest: t };
}

const KEY_WORDS = new Set(['table', 'on', 'for', 'when', 'type', 'field', 'method', 'name', 'as']);
const FLAGS = new Set(['scoped', 'global']);

/**
 * "MyHelper table incident ajax", "on incident when async", "block closed edits on incident": every piece is
 * optional. Words that name a variant (before/after/async/display, onLoad.., ajax, client/server, GET/POST..)
 * set it; "on <table>" / "table <t>" set the table; whatever is left is the name.
 * @returns {{ options: object, missing: string[] }}
 */
export function parseNewArgs(kind, rest, { table = '' } = {}) {
  const tokens = String(rest || '').trim().split(/\s+/).filter(Boolean);
  const options = {};
  const free = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    const next = tokens[i + 1];
    if (KEY_WORDS.has(lower) && next && lower !== 'as') {
      i += 1;
      if (lower === 'on' || lower === 'for' || lower === 'table') options.table = next.toLowerCase();
      else if (lower === 'when') options.when = next.toLowerCase();
      else if (lower === 'type') options.type = next;
      else if (lower === 'field') options.field = next;
      else if (lower === 'method') options.method = next.toUpperCase();
      else if (lower === 'name') {
        options.name = tokens.slice(i).join(' ');
        break;
      }
    } else if (FLAGS.has(lower)) options.scoped = lower === 'scoped';
    else if (kind === 'br' && BR_WHEN.includes(lower)) options.when = lower;
    else if (kind === 'cs' && CLIENT_TYPES.some((t) => t.toLowerCase() === lower)) options.type = CLIENT_TYPES.find((t) => t.toLowerCase() === lower);
    else if (kind === 'si' && SI_VARIANTS.includes(lower) && lower !== 'class') options.variant = lower;
    else if (kind === 'si' && lower === 'client') options.variant = 'ajax';
    else if (kind === 'uia' && UIA_VARIANTS.includes(lower)) options.variant = lower;
    else if (kind === 'rest' && HTTP_METHODS.includes(token.toUpperCase())) options.method = token.toUpperCase();
    else free.push(token);
  }
  if (!options.name && free.length) options.name = kind === 'si' ? (free.length === 1 ? free[0] : pascalCase(free.join(' '))) : free.join(' ');
  if (!options.table && table && ['br', 'cs', 'uia'].includes(kind)) options.table = table;
  const missing = [];
  if (['br', 'cs', 'uia'].includes(kind) && !options.table) missing.push('table');
  if (kind === 'si' && !options.name) missing.push('name');
  return { options, missing };
}

/** A table to suggest from the page: a real data table, not the config table of the form being edited. */
export function suggestTable(pageTable) {
  const t = String(pageTable || '');
  return TABLE_RE.test(t) && !/^(?:sys_|sysauto|sysevent|sc_cat_item_producer$)/.test(t) ? t : '';
}

/** Describe what a request will build, for a palette row. */
export function describeRequest(kind, options) {
  const def = KINDS[kind];
  const bits = [];
  if (options.name) bits.push(`"${options.name}"`);
  if (options.table) bits.push(`on ${options.table}`);
  if (kind === 'br') bits.push(options.when || 'before');
  if (kind === 'cs') bits.push(options.type || 'onChange');
  if (kind === 'si' && options.variant === 'ajax') bits.push('client callable');
  if (kind === 'uia') bits.push(options.variant || 'client + server');
  if (kind === 'rest') bits.push(options.method || 'GET');
  return `${def.label}${bits.length ? ` ${bits.join(' ')}` : ''}`;
}
