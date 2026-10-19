// Page X-ray: the pure half. Which configuration touches which form field or catalog variable,
// how a UI policy condition evaluates against the values on screen, and the likely causes of a
// field being read-only, mandatory or hidden right now. No DOM and no network, so all of it is
// unit-tested (tests/xray.test.js). The DOM and Table API half is src/content/xray.js.

import { parseEncodedQuery } from './query.js';

export const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const NAME_RE = /^[a-z0-9_]+$/i;
const FIELD_PATH_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/i;

export const isSysId = (value) => SYS_ID_RE.test(String(value ?? ''));
export const isName = (value) => NAME_RE.test(String(value ?? ''));
export const isFieldPath = (value) => FIELD_PATH_RE.test(String(value ?? ''));

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- Element ids ------------------------------------------------------------------------------

/**
 * Parse a classic form id such as "label.incident.caller_id" or "element.incident.caller_id.email"
 * (prefix "label." / "element."). Table names never contain dots, so everything after the table is
 * the field path. Catalog variables ("element.IO:<sys_id>") come back as { io }.
 */
export function parsePrefixedId(id, prefix) {
  const text = String(id || '');
  if (!text.startsWith(prefix)) return null;
  const rest = text.slice(prefix.length);
  const io = /^IO:([0-9a-f]{32})$/i.exec(rest);
  if (io) return { io: io[1].toLowerCase() };
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const table = rest.slice(0, dot);
  const field = rest.slice(dot + 1);
  if (!isName(table) || !isFieldPath(field)) return null;
  return { table, field };
}

/** Every catalog variable sys_id named in a string such as "IO:<id>", "element.IO:<id>" or "sys_display.IO:<id>". */
export function ioIdsIn(text) {
  const out = [];
  const re = /IO:([0-9a-f]{32})/gi;
  let match;
  while ((match = re.exec(String(text || '')))) out.push(match[1].toLowerCase());
  return out;
}

/** The sys_id at the end of a list row id such as "row_incident_<sys_id>", or of a sys_id attribute. */
export function rowSysId(attr, id) {
  if (isSysId(attr)) return String(attr).toLowerCase();
  const match = /([0-9a-f]{32})$/i.exec(String(id || ''));
  return match ? match[1].toLowerCase() : null;
}

/** Service Portal widget sys_id from an element's class tokens (widget CSS is scoped by "v<sys_id>"). */
export function widgetIdFromClasses(classes) {
  for (const token of classes || []) {
    if (token.length === 33 && token[0] === 'v' && isSysId(token.slice(1))) return token.slice(1).toLowerCase();
  }
  return null;
}

/** Service Portal instance sys_id from an element id ("x<sys_id>"). */
export function instanceIdFromId(id) {
  const match = /^x([0-9a-f]{32})$/i.exec(String(id || ''));
  return match ? match[1].toLowerCase() : null;
}

// --- URLs -------------------------------------------------------------------------------------

const NOT_PORTAL = new Set(['now', 'api', 'nav_to.do', 'navpage.do', 'login.do', 'logout.do', 'auth_redirect.do', 'scripts', 'styles', 'images', 'uxasset', 'amb']);

/** { suffix, pageId, sysId, table } when the URL looks like a Service Portal page (/sp, /esc, /csm...), else null. */
export function portalFromUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  const suffix = segments[0];
  if (!isName(suffix) || NOT_PORTAL.has(suffix.toLowerCase())) return null;
  const params = url.searchParams;
  return {
    suffix,
    pageId: params.get('id') || '',
    sysId: isSysId(params.get('sys_id')) ? params.get('sys_id').toLowerCase() : '',
    table: isName(params.get('table')) ? params.get('table') : '',
  };
}

/** Next Experience workspace pages: { kind: 'record' | 'list' | 'workspace', table, sysId }, or null. */
export function parseWorkspaceUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const path = url.pathname;
  if (!path.startsWith('/now/') || path.startsWith('/now/nav/ui/classic')) return null;
  const record = /\/record\/([a-z0-9_]+)\/([0-9a-f]{32}|-1)(?:[/?#]|$)/i.exec(path);
  if (record) return { kind: 'record', table: record[1], sysId: record[2] === '-1' ? '' : record[2].toLowerCase() };
  const list = /\/(?:list|params)\/.*?\btable\/([a-z0-9_]+)/i.exec(path);
  if (list) return { kind: 'list', table: list[1], sysId: '' };
  return { kind: 'workspace', table: '', sysId: '' };
}

/** The catalog item behind an order form URL (classic sysparm_id, portal id=sc_cat_item&sys_id=...). */
export function catalogItemFromUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return '';
  }
  const params = url.searchParams;
  const direct = params.get('sysparm_id');
  if (isSysId(direct)) return direct.toLowerCase();
  const page = params.get('id') || '';
  if (/^sc_cat_item/i.test(page) && isSysId(params.get('sys_id'))) return params.get('sys_id').toLowerCase();
  return '';
}

// --- Scripts ----------------------------------------------------------------------------------

/** Blank out // and /* *\/ comments (line numbers kept) so commented-out code is not reported. */
export function stripComments(source) {
  const text = String(source || '');
  let out = '';
  let quote = '';
  let block = false;
  let line = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\n') {
      out += '\n';
      line = false;
      if (quote !== '`') quote = '';
      continue;
    }
    if (line) {
      out += ' ';
      continue;
    }
    if (block) {
      if (ch === '*' && next === '/') {
        block = false;
        out += '  ';
        i += 1;
      } else out += ' ';
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === '\\' && next !== undefined && next !== '\n') {
        out += next;
        i += 1;
      } else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') {
      line = true;
      out += '  ';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      block = true;
      out += '  ';
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    out += ch;
  }
  return out;
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** g_form.<method>('<field>', <arg>) calls with a literal field name: [{ method, field, arg, line }]. */
export function gformCalls(script) {
  const code = stripComments(script);
  const out = [];
  // The second argument is read through a lookahead so a nested call in it (g_form.getValue('x')) is still found.
  const re = /\bg_form\s*\.\s*([A-Za-z_$][\w$]*)\s*\(\s*(['"])([^'"\\\n]{1,160})\2(?=\s*(?:,\s*([^)\n]{0,120}))?)/g;
  let match;
  while ((match = re.exec(code))) {
    out.push({ method: match[1], field: match[3].trim(), arg: (match[4] || '').trim(), line: lineAt(code, match.index) });
  }
  return out;
}

// g_form methods that change a field's state, and which state they change.
export const STATE_METHODS = {
  setReadOnly: 'readOnly',
  setReadonly: 'readOnly',
  setDisabled: 'readOnly',
  setMandatory: 'mandatory',
  setDisplay: 'hidden',
  setVisible: 'hidden',
};

/** true / false for a literal boolean argument, null for anything computed. */
export function literalBool(arg) {
  const text = String(arg ?? '')
    .trim()
    .replace(/\)+\s*;?\s*$/, '')
    .trim();
  if (/^(true|!0|1)$/.test(text)) return true;
  if (/^(false|!1|0)$/.test(text)) return false;
  return null;
}

/** "variables.x" and "x" name the same catalog variable; plain fields compare as-is. */
export function sameField(a, b) {
  const norm = (v) => String(v || '').replace(/^variables\./, '');
  return norm(a) === norm(b);
}

/**
 * Calls in a script that change `field`'s state: [{ kind, value, method, line, indirect }].
 * value is the resulting state (true = read-only / mandatory / hidden), null when computed.
 * "indirect" calls pass a variable as the field name while the script mentions the field as a string.
 */
export function stateCalls(script, field) {
  if (!script || !field) return [];
  const out = [];
  gformCalls(script).forEach((call) => {
    const kind = STATE_METHODS[call.method];
    if (!kind || !sameField(call.field, field)) return;
    const b = literalBool(call.arg);
    out.push({ kind, value: kind === 'hidden' ? (b === null ? null : !b) : b, method: call.method, line: call.line, indirect: false });
  });
  if (out.length) return out;

  const code = stripComments(script);
  const mentions = new RegExp(`(['"])(?:variables\\.)?${escapeRe(field)}\\1`).test(code);
  if (!mentions) return out;
  const re = /\bg_form\s*\.\s*(setReadOnly|setReadonly|setDisabled|setMandatory|setDisplay|setVisible)\s*\(\s*(?!['"])([^,)\n]{1,80})(?=(?:,\s*([^)\n]{0,80}))?)/g;
  let match;
  while ((match = re.exec(code))) {
    const kind = STATE_METHODS[match[1]];
    const b = literalBool(match[3]);
    out.push({ kind, value: kind === 'hidden' ? (b === null ? null : !b) : b, method: match[1], line: lineAt(code, match.index), indirect: true });
  }
  return out;
}

const CURRENT_METHOD_SKIP = new Set(['setAbortAction', 'setWorkflow', 'setLimit', 'setNewGuidValue', 'getTableName', 'getRecordClassName', 'isNewRecord', 'isValidRecord', 'getUniqueValue', 'getLink', 'getClassDisplayValue', 'setUseEngines', 'autoSysFields']);
const CURRENT_PROP_SKIP = new Set(['variables', 'sys_meta', 'prototype', 'constructor', 'operation']);

/** Field names a server script reads or writes through current.<field> / previous.<field> / current.getValue('<field>'). */
export function serverFieldRefs(script) {
  const code = stripComments(script);
  const out = new Set();
  const prop = /\b(?:current|previous)\s*\.\s*([a-z_][a-z0-9_]*)\b(?!\s*\()/gi;
  let match;
  while ((match = prop.exec(code))) if (!CURRENT_PROP_SKIP.has(match[1])) out.add(match[1]);
  const method = /\b(?:current|previous)\s*\.\s*((?:get|set|is)[A-Za-z]*|changes\w*|nil)\s*\(\s*(['"])([a-z_][a-z0-9_]*)\2/gi;
  while ((match = method.exec(code))) if (!CURRENT_METHOD_SKIP.has(match[1])) out.add(match[3]);
  return out;
}

/** Fields named in an encoded query's conditions; a dot-walk also counts for its first field. */
export function fieldsInQuery(query) {
  const out = new Set();
  if (!query) return out;
  parseEncodedQuery(String(query))
    .groups.flat()
    .forEach((c) => {
      out.add(c.field);
      if (c.field.includes('.')) out.add(c.field.split('.')[0]);
    });
  return out;
}

// --- Conditions -------------------------------------------------------------------------------

const and3 = (results) => (results.some((r) => r === false) ? false : results.every((r) => r === true) ? true : null);
const or3 = (results) => (results.some((r) => r === true) ? true : results.every((r) => r === false) ? false : null);

function compareNumbers(a, b, op) {
  if (a === '' || b === '' || !Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return null;
  const x = Number(a);
  const y = Number(b);
  if (op === '<') return x < y;
  if (op === '<=') return x <= y;
  if (op === '>') return x > y;
  return x >= y;
}

function evaluateOne(c, values) {
  if (!Object.prototype.hasOwnProperty.call(values, c.field)) return null;
  const v = String(values[c.field] ?? '');
  const value = String(c.value ?? '');
  if (/^javascript:/i.test(value)) return null;
  const lower = v.toLowerCase();
  const want = value.toLowerCase();
  switch (c.op) {
    case '=':
      return v === value;
    case '!=':
      return v !== value;
    case 'ISEMPTY':
      return v === '';
    case 'ISNOTEMPTY':
      return v !== '';
    case 'ANYTHING':
      return true;
    case 'IN':
      return value.split(',').includes(v);
    case 'NOT IN':
      return !value.split(',').includes(v);
    case 'LIKE':
      return lower.includes(want);
    case 'NOTLIKE':
    case 'NOT LIKE': // the parser emits the spaced form for "does not contain"
      return !lower.includes(want);
    case 'EMPTYSTRING':
      return v === '';
    case 'STARTSWITH':
      return lower.startsWith(want);
    case 'ENDSWITH':
      return lower.endsWith(want);
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compareNumbers(v, value, c.op);
    case 'SAMEAS':
      return Object.prototype.hasOwnProperty.call(values, value) ? v === String(values[value] ?? '') : null;
    case 'NSAMEAS':
      return Object.prototype.hasOwnProperty.call(values, value) ? v !== String(values[value] ?? '') : null;
    default:
      return null; // dates, dynamic filters, "changes" operators: not decidable from the form alone
  }
}

/**
 * Evaluate a UI policy / data policy condition against the values on the form.
 * true / false when decidable, null when it depends on something the form does not show
 * (dot-walks, javascript: values, dynamic filters, fields that are not on the form).
 * Precedence follows the platform: "a^ORb^c" is (a OR b) AND c; NQ groups are OR'd.
 */
export function evaluateCondition(query, values = {}) {
  const text = String(query || '').trim();
  if (!text) return true;
  const parsed = parseEncodedQuery(text);
  const groups = parsed.groups.filter((g) => g.length);
  if (parsed.raw.length) return null; // related-list queries or tokens we cannot read
  if (!groups.length) return true;
  return or3(
    groups.map((group) => {
      const clauses = [];
      group.forEach((c) => {
        if (c.or && clauses.length) clauses[clauses.length - 1].push(c);
        else clauses.push([c]);
      });
      return and3(clauses.map((clause) => or3(clause.map((c) => evaluateOne(c, values)))));
    })
  );
}

const tri = (value) => {
  const s = String(value ?? '').toLowerCase();
  return s === 'true' ? true : s === 'false' ? false : null; // 'ignore' / '' leave the state alone
};

/** What a UI policy (or data policy) action sets for one state kind: true / false / null (leave alone). */
export function actionValue(action, kind) {
  if (!action) return null;
  if (kind === 'readOnly') return tri(action.disabled ?? action.readOnly);
  if (kind === 'mandatory') return tri(action.mandatory);
  if (kind === 'hidden') {
    const visible = tri(action.visible);
    return visible === null ? null : !visible;
  }
  return null;
}

/**
 * Whether a policy action explains `kind` being `current` (true = read-only / mandatory / hidden).
 * 'applied' (condition true), 'reversed' (condition false + reverse if false), 'maybe' / 'maybe-reversed'
 * (condition not decidable), or null when it cannot be the cause.
 */
export function policyCause(action, kind, conditionResult, reverseIfFalse = true, current = true) {
  const v = actionValue(action, kind);
  if (v === null) return null;
  if (conditionResult === true) return v === current ? 'applied' : null;
  if (conditionResult === false) return reverseIfFalse && !v === current ? 'reversed' : null;
  if (v === current) return 'maybe';
  if (reverseIfFalse && !v === current) return 'maybe-reversed';
  return null;
}

/** "mandatory, read-only, hidden" for a policy action (only what it sets to true/false). */
export function describeAction(action) {
  const parts = [];
  const ro = actionValue(action, 'readOnly');
  const mand = actionValue(action, 'mandatory');
  const hidden = actionValue(action, 'hidden');
  if (mand !== null) parts.push(mand ? 'mandatory' : 'not mandatory');
  if (ro !== null) parts.push(ro ? 'read-only' : 'editable');
  if (hidden !== null) parts.push(hidden ? 'hidden' : 'visible');
  if (tri(action?.cleared) === true) parts.push('cleared');
  return parts.join(', ') || 'no state change';
}

// --- Field index ------------------------------------------------------------------------------

function emptyEntry() {
  return { clientScripts: [], uiPolicies: [], dataPolicies: [], businessRules: [], acls: [], overrides: [] };
}

/** Distinct artifacts touching a field, by kind, plus a total. */
export function countEntry(entry) {
  if (!entry) return { clientScripts: 0, uiPolicies: 0, dataPolicies: 0, businessRules: 0, acls: 0, overrides: 0, total: 0 };
  const distinct = (rows, key) => new Set(rows.map(key)).size;
  const counts = {
    clientScripts: entry.clientScripts.length,
    uiPolicies: distinct(entry.uiPolicies, (r) => r.policy.sysId),
    dataPolicies: distinct(entry.dataPolicies, (r) => r.policy.sysId),
    businessRules: entry.businessRules.length,
    acls: entry.acls.length,
    overrides: entry.overrides.length,
  };
  counts.total = counts.clientScripts + counts.uiPolicies + counts.dataPolicies + counts.businessRules + counts.acls;
  return counts;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One-line summary for a chip tooltip. */
export function summarizeEntry(entry) {
  const c = countEntry(entry);
  const parts = [
    c.clientScripts && plural(c.clientScripts, 'client script', 'client scripts'),
    c.uiPolicies && plural(c.uiPolicies, 'UI policy', 'UI policies'),
    c.dataPolicies && plural(c.dataPolicies, 'data policy', 'data policies'),
    c.businessRules && plural(c.businessRules, 'business rule', 'business rules'),
    c.acls && plural(c.acls, 'ACL', 'ACLs'),
    c.overrides && plural(c.overrides, 'dictionary override', 'dictionary overrides'),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No client scripts, UI policies, data policies, business rules or field ACLs found';
}

/**
 * Index every artifact by the fields it touches.
 * logic: { tables, clientScripts, uiPolicies (with actions), dataPolicies (with rules), businessRules, acls, overrides }
 * fieldNames: known field names, used to spot scripts that pass a field name through a variable.
 * Returns { fields: Map<field, entry>, tableAcls }.
 */
export function buildFieldIndex(logic = {}, fieldNames = []) {
  const fields = new Map();
  const entry = (name) => {
    if (!fields.has(name)) fields.set(name, emptyEntry());
    return fields.get(name);
  };
  const known = new Set(fieldNames);
  const tables = logic.tables || [];

  (logic.clientScripts || []).forEach((cs) => {
    const reasons = new Map();
    const add = (field, reason) => {
      if (!field) return;
      if (!reasons.has(field)) reasons.set(field, new Set());
      reasons.get(field).add(reason);
    };
    if (cs.type === 'onChange' && cs.field) add(cs.field, 'onChange');
    gformCalls(cs.script).forEach((call) => add(call.field.replace(/^variables\./, ''), call.method));
    // Field names passed through a variable: credit the literal field names the script mentions.
    if (known.size && /\bg_form\s*\.\s*(setReadOnly|setReadonly|setDisabled|setMandatory|setDisplay|setVisible)\s*\(\s*(?!['"])/.test(stripComments(cs.script))) {
      const literal = /(['"])([a-z0-9_]+)\1/gi;
      const code = stripComments(cs.script);
      let match;
      while ((match = literal.exec(code))) if (known.has(match[2]) && !reasons.has(match[2])) add(match[2], 'indirect');
    }
    reasons.forEach((set, field) => entry(field).clientScripts.push({ script: cs, reasons: [...set], calls: stateCalls(cs.script, field) }));
  });

  (logic.uiPolicies || []).forEach((policy) => {
    const touched = new Set();
    (policy.actions || []).forEach((action) => {
      if (!action.field) return;
      touched.add(action.field);
      entry(action.field).uiPolicies.push({ policy, action, role: 'action' });
    });
    fieldsInQuery(policy.conditions).forEach((field) => {
      if (touched.has(field)) return;
      touched.add(field);
      entry(field).uiPolicies.push({ policy, action: null, role: 'condition' });
    });
    if (policy.runScripts) {
      const script = `${policy.scriptTrue || ''}\n${policy.scriptFalse || ''}`;
      gformCalls(script).forEach((call) => {
        const field = call.field.replace(/^variables\./, '');
        if (touched.has(field)) return;
        touched.add(field);
        entry(field).uiPolicies.push({ policy, action: null, role: 'script', calls: stateCalls(script, field) });
      });
    }
  });

  (logic.dataPolicies || []).forEach((policy) => {
    const touched = new Set();
    (policy.rules || []).forEach((rule) => {
      if (!rule.field) return;
      touched.add(rule.field);
      entry(rule.field).dataPolicies.push({ policy, rule, role: 'rule' });
    });
    fieldsInQuery(policy.conditions).forEach((field) => {
      if (touched.has(field)) return;
      touched.add(field);
      entry(field).dataPolicies.push({ policy, rule: null, role: 'condition' });
    });
  });

  (logic.businessRules || []).forEach((rule) => {
    const where = new Map();
    const mark = (set, label) =>
      set.forEach((field) => {
        if (!where.has(field)) where.set(field, []);
        if (!where.get(field).includes(label)) where.get(field).push(label);
      });
    mark(serverFieldRefs(rule.script), 'script');
    mark(serverFieldRefs(rule.condition), 'condition');
    mark(fieldsInQuery(rule.filterCondition), 'filter');
    where.forEach((labels, field) => entry(field).businessRules.push({ rule, where: labels }));
  });

  const tableAcls = [];
  (logic.acls || []).forEach((acl) => {
    const name = String(acl.name || '');
    const dot = name.indexOf('.');
    const table = dot < 0 ? name : name.slice(0, dot);
    const field = dot < 0 ? '' : name.slice(dot + 1);
    if (table !== '*' && tables.length && !tables.includes(table)) return;
    if (!field || field === '*' || field === 'None') tableAcls.push(acl);
    else entry(field).acls.push(acl);
  });

  (logic.overrides || []).forEach((o) => {
    if (o.element) entry(o.element).overrides.push(o);
  });

  return { fields, tableAcls };
}

// --- Catalog ----------------------------------------------------------------------------------

// item_option_new.type codes (the Table API returns the number unless display values are asked for).
export const VARIABLE_TYPES = {
  1: 'Yes / No',
  2: 'Multi Line Text',
  3: 'Multiple Choice',
  4: 'Numeric Scale',
  5: 'Select Box',
  6: 'Single Line Text',
  7: 'CheckBox',
  8: 'Reference',
  9: 'Date',
  10: 'Date/Time',
  11: 'Label',
  12: 'Break',
  14: 'Custom',
  15: 'UI Page',
  16: 'Wide Single Line Text',
  17: 'Custom with Label',
  18: 'Lookup Select Box',
  19: 'Container Start',
  20: 'Container End',
  21: 'List Collector',
  22: 'Lookup Multiple Choice',
  23: 'HTML',
  24: 'Container Split',
  25: 'Masked',
  26: 'Email',
  27: 'URL',
  28: 'IP Address',
  29: 'Duration',
  31: 'Requested For',
  32: 'Rich Text Label',
  33: 'Attachment',
};

export function variableTypeName(code, display = '') {
  if (display && !/^\d+$/.test(display)) return display;
  return VARIABLE_TYPES[Number(code)] || (code ? `type ${code}` : '');
}

/**
 * Index catalog logic by variable name.
 * variables: [{ sysId, name, ... }]; clientScripts: [{ sysId, name, type, catVariable, script }];
 * uiPolicies: [{ sysId, name, conditions, runScripts, scriptTrue, scriptFalse, actions: [{ catalogVariable, variable, ... }] }]
 * catVariable / catalogVariable / condition fields may be "IO:<sys_id>" or a plain name.
 */
export function catalogVariableIndex({ variables = [], clientScripts = [], uiPolicies = [] } = {}) {
  // Keyed by variable sys_id: two variable sets can each have a variable with the same name.
  const keyOf = (v) => String(v.sysId).toLowerCase();
  const index = new Map(variables.map((v) => [keyOf(v), { variable: v, clientScripts: [], uiPolicies: [] }]));

  /**
   * Variable sys_ids a reference names: "IO:<sys_id>" / a sys_id exactly, or a plain name, resolved
   * first within the owner's variable set, then within its catalog item, then anywhere on the form.
   */
  const resolve = (ref, owner = {}) => {
    const text = String(ref || '')
      .replace(/^variables\./, '')
      .trim();
    if (!text) return [];
    const ids = ioIdsIn(text);
    if (ids.length) return ids.filter((id) => index.has(id));
    if (isSysId(text)) return index.has(text.toLowerCase()) ? [text.toLowerCase()] : [];
    let candidates = variables.filter((v) => v.name === text);
    const narrow = (key) => {
      if (candidates.length < 2 || !owner[key]) return;
      const same = candidates.filter((v) => v[key] === owner[key]);
      if (same.length) candidates = same;
    };
    narrow('variableSet');
    narrow('catItem');
    return candidates.map(keyOf);
  };

  clientScripts.forEach((cs) => {
    const reasons = new Map();
    const add = (ids, reason) =>
      ids.forEach((id) => {
        if (!reasons.has(id)) reasons.set(id, new Set());
        reasons.get(id).add(reason);
      });
    if (cs.type === 'onChange') add(resolve(cs.catVariable, cs), 'onChange');
    gformCalls(cs.script).forEach((call) => add(resolve(call.field, cs), call.method));
    reasons.forEach((set, id) => {
      const entry = index.get(id);
      entry.clientScripts.push({ script: cs, reasons: [...set], calls: stateCalls(cs.script, entry.variable.name) });
    });
  });

  uiPolicies.forEach((policy) => {
    const touched = new Set();
    const push = (ids, row) =>
      ids.forEach((id) => {
        if (touched.has(id)) return;
        touched.add(id);
        index.get(id).uiPolicies.push(typeof row === 'function' ? row(index.get(id).variable.name) : row);
      });
    (policy.actions || []).forEach((action) => {
      const ids = resolve(action.catalogVariable, policy);
      push(ids.length ? ids : resolve(action.variable, policy), { policy, action, role: 'action' });
    });
    // Conditions name variables as "IO:<sys_id>" (not a parseable field name): take those ids directly,
    // and resolve any plain names that remain.
    const condition = String(policy.conditions || '');
    push(ioIdsIn(condition).filter((id) => index.has(id)), { policy, action: null, role: 'condition' });
    fieldsInQuery(condition.replace(/IO:[0-9a-f]{32}/gi, 'io_ref')).forEach((field) => {
      if (field !== 'io_ref') push(resolve(field, policy), { policy, action: null, role: 'condition' });
    });
    if (policy.runScripts) {
      const script = `${policy.scriptTrue || ''}\n${policy.scriptFalse || ''}`;
      gformCalls(script).forEach((call) => push(resolve(call.field, policy), (name) => ({ policy, action: null, role: 'script', calls: stateCalls(script, name) })));
    }
  });

  return index;
}

/** A catalog condition ("IO:<id>=true^EQ") with variable names instead of sys_ids, for display. */
export function readableCatalogCondition(condition, variables = []) {
  const byId = new Map(variables.map((v) => [String(v.sysId).toLowerCase(), v.name]));
  return String(condition || '')
    .replace(/IO:([0-9a-f]{32})/gi, (all, id) => byId.get(id.toLowerCase()) || all)
    .replace(/\^EQ$/, '');
}

// --- Why is this field read-only / mandatory / hidden? -----------------------------------------

export const STATE_LABELS = { readOnly: 'read-only', mandatory: 'mandatory', hidden: 'hidden' };

/**
 * Whether a UI policy or client script applies to the form view on screen: true, false, or null when it
 * cannot be told (current view unknown, or the row's view name did not come back). Rows that are not
 * explicitly global=false apply to every view. A view of '' is the default view.
 */
export function appliesToView(row, view) {
  if (!row || row.global !== false) return true;
  if (view === null || view === undefined) return null;
  const want = String(row.view ?? '')
    .trim()
    .toLowerCase();
  if (!want) return null;
  const current = String(view).trim().toLowerCase();
  const isDefault = (v) => v === '' || v === 'default' || v === 'default view';
  if (isDefault(current)) return isDefault(want);
  return want
    .split(',')
    .map((s) => s.trim())
    .includes(current);
}

function confidence(score) {
  if (score >= 70) return 'likely';
  if (score >= 40) return 'possible';
  return 'unlikely';
}

const CLIENT_TYPE_SCORE = { onLoad: 82, onChange: 62, onCellEdit: 15, onSubmit: 15 };

/**
 * Candidate causes of a field's current state, most likely first.
 *
 * input: {
 *   field, state: { readOnly, mandatory, visible, onForm },
 *   values: current form values (for policy conditions),
 *   entry: buildFieldIndex(...).fields.get(field),
 *   dictionary: { readOnly, mandatory } for the field's own definition,
 *   overrides: [{ table, readOnly: bool|null, mandatory: bool|null }] that apply to this table,
 *   tableAcls: table-level ACLs, readOnlyRatio: share of form fields that are read-only (0..1) or null,
 *   view: the form view on screen ('' = default) or null when unknown
 * }
 * A state of null (unknown) produces no causes for that state.
 * Returns { readOnly: [...], mandatory: [...], hidden: [...] }; a list is empty when that state is off.
 * A cause is { kind, score, confidence, title, detail, table?, sysId? }.
 */
export function rankCauses(input = {}) {
  const { field = '', table = '', state = {}, values = {}, dictionary = {}, overrides = [], tableAcls = [], readOnlyRatio = null, view = null } = input;
  const entry = input.entry || emptyEntry();
  // Parent-table logic only reaches this form when it is inherited.
  const fromParent = (row) => Boolean(table && row.table && row.table !== table);
  const notInherited = (row) => fromParent(row) && (row.inherit === false || row.inherited === false);
  // ui_type 1 = Mobile / Service Portal only: never runs on the desktop form being explained.
  const mobileOnly = (row) => String(row.uiType ?? '') === '1';
  // View-specific rows: skipped on another view, ranked lower when the view cannot be matched.
  const viewPenalty = (row) => (appliesToView(row, view) === null ? 20 : 0);
  const viewNote = (row) => (viewPenalty(row) ? ` Only on view "${row.view || 'unknown'}", which could not be matched to this form's view.` : '');
  const skip = (row) => notInherited(row) || mobileOnly(row) || appliesToView(row, view) === false;
  const out = { readOnly: [], mandatory: [], hidden: [] };
  const active = { readOnly: state.readOnly === true, mandatory: state.mandatory === true, hidden: state.visible === false || state.onForm === false };

  Object.keys(out).forEach((kind) => {
    if (!active[kind]) return;
    const causes = [];
    const push = (cause) => causes.push({ ...cause, confidence: confidence(cause.score) });

    if (kind === 'hidden' && state.onForm === false) {
      push({ kind: 'layout', score: 92, title: 'Not on this form view', detail: 'The field is not in the form layout for this view (Configure > Form Layout).' });
    }

    entry.uiPolicies.forEach(({ policy, action, role, calls }) => {
      if (skip(policy)) return;
      if (role === 'action') {
        const result = evaluateCondition(policy.conditions, values);
        const how = policyCause(action, kind, result, policy.reverseIfFalse !== false);
        if (!how) return;
        const base = { applied: 95, reversed: 88, maybe: 60, 'maybe-reversed': 50 }[how];
        const score = (policy.onLoad === false && (how === 'applied' || how === 'reversed') ? base - 25 : base) - (fromParent(policy) ? 5 : 0) - viewPenalty(policy);
        const detail = {
          applied: 'Its condition matches the values on the form.',
          reversed: 'Its condition does not match and "Reverse if false" undoes the action.',
          maybe: 'Applies when its condition is true; the condition could not be checked on the form.',
          'maybe-reversed': 'Applies (reversed) when its condition is false; the condition could not be checked on the form.',
        }[how];
        push({ kind: 'ui_policy', score, title: `UI policy: ${policy.name || '(no description)'}`, detail: `${detail}${policy.onLoad === false ? ' Runs only on change, not on load.' : ''}${fromParent(policy) ? ` Defined on ${policy.table}.` : ''}${viewNote(policy)}`, table: policy.recordTable || 'sys_ui_policy', sysId: policy.sysId });
      } else if (role === 'script') {
        const hit = (calls || []).filter((c) => c.kind === kind && c.value !== false);
        if (!hit.length) return;
        const literal = hit.some((c) => c.value === true);
        push({ kind: 'ui_policy_script', score: (literal ? 56 : 40) - viewPenalty(policy), title: `UI policy script: ${policy.name || '(no description)'}`, detail: `Calls g_form.${hit[0].method}() on line ${hit[0].line} of its script.${viewNote(policy)}`, table: policy.recordTable || 'sys_ui_policy', sysId: policy.sysId });
      }
    });

    entry.clientScripts.forEach(({ script, calls }) => {
      if (skip(script)) return;
      const relevant = (calls || []).filter((c) => c.kind === kind);
      if (!relevant.length) return;
      const toward = relevant.filter((c) => c.value === true);
      const computed = relevant.filter((c) => c.value === null);
      if (!toward.length && !computed.length) return; // only ever turns the state off
      const typeScore = CLIENT_TYPE_SCORE[script.type] ?? 55;
      let score;
      if (toward.length && !toward.every((c) => c.indirect)) score = typeScore;
      else if (toward.length) score = Math.min(typeScore, 30);
      else score = Math.min(typeScore, 45) - (computed.every((c) => c.indirect) ? 15 : 0);
      if (fromParent(script)) score -= 10;
      score -= viewPenalty(script);
      const first = toward[0] || computed[0];
      push({
        kind: 'client_script',
        score,
        title: `Client script (${script.type || 'script'}): ${script.name || '(no name)'}`,
        detail: `Calls g_form.${first.method}(${first.indirect ? 'a variable' : `'${field}'`}, ${first.value === null ? '...' : String(kind === 'hidden' ? !first.value : first.value)}) on line ${first.line}.${fromParent(script) ? ` Defined on ${script.table}.` : ''}${viewNote(script)}`,
        table: script.recordTable || 'sys_script_client',
        sysId: script.sysId,
      });
    });

    if (kind !== 'hidden') {
      const flag = kind === 'readOnly' ? 'readOnly' : 'mandatory';
      const decisive = overrides.find((o) => o[flag] === true || o[flag] === false);
      if (decisive && decisive[flag] === true) {
        push({ kind: 'override', score: 76, title: `Dictionary override on ${decisive.table}`, detail: `The override sets ${STATE_LABELS[kind]} for this table.`, table: 'sys_dictionary_override', sysId: decisive.sysId });
      } else if (!decisive && dictionary[flag] === true) {
        push({ kind: 'dictionary', score: 74, title: `Dictionary: ${kind === 'readOnly' ? 'Read only' : 'Mandatory'} is checked`, detail: `Set on the column definition${dictionary.definedOn ? ` (${dictionary.definedOn})` : ''}.`, table: 'sys_dictionary', sysId: dictionary.sysId });
      }
    }

    if (kind === 'readOnly') {
      if (readOnlyRatio !== null && readOnlyRatio >= 0.9) {
        push({ kind: 'form', score: 72, title: 'The whole form is read-only', detail: 'Almost every field is read-only, so the record itself is probably not writable for you (table write ACL, or the record is in a closed state).' });
      }
      const writes = entry.acls.filter((acl) => /write/i.test(String(acl.operation || '')));
      if (writes.length) {
        push({ kind: 'acl', score: 52, title: `Field write ACL: ${writes[0].name}${writes.length > 1 ? ` (+${writes.length - 1})` : ''}`, detail: 'If you fail this ACL the form shows the field read-only. Use the access debugger to evaluate it for a user.', table: 'sys_security_acl', sysId: writes[0].sysId });
      } else if (tableAcls.some((acl) => /write/i.test(String(acl.operation || '')))) {
        push({ kind: 'acl', score: 32, title: 'Table write ACLs', detail: 'There is no field-level write ACL, but table-level write ACLs also make fields read-only when they fail.' });
      }
    }

    if (kind !== 'hidden') {
      entry.dataPolicies.forEach(({ policy, rule, role }) => {
        if (role !== 'rule' || notInherited(policy)) return;
        const v = kind === 'readOnly' ? tri(rule.disabled ?? rule.readOnly) : tri(rule.mandatory);
        if (v !== true) return;
        const result = evaluateCondition(policy.conditions, values);
        if (result === false) return;
        const client = policy.enforceUi !== false;
        push({ kind: 'data_policy', score: (result === true ? 48 : 38) - (client ? 0 : 20), title: `Data policy: ${policy.name || '(no description)'}`, detail: `${result === true ? 'Its condition matches the form.' : 'Its condition could not be checked on the form.'}${client ? ' Data policies marked "Use as UI Policy on client" act like UI policies.' : ' Not applied on the client, so it only blocks the save.'}`, table: 'sys_data_policy2', sysId: policy.sysId });
      });
    }

    if (!causes.length) {
      push({
        kind: 'none',
        score: 0,
        title: 'No configured cause found',
        detail: 'Check client scripts on other views or parent tables, UI scripts, UI actions, g_form calls in widgets or formatters, and scripts that use a variable for the field name.',
      });
    }
    causes.sort((a, b) => b.score - a.score);
    out[kind] = causes.slice(0, 12);
  });

  return out;
}

// --- Live state and overlay geometry ----------------------------------------------------------

/**
 * Fill the states g_form left unknown (null: isReadOnly / isVisible missing on some releases) from the
 * form markup's reading of the same field. Known g_form values always win.
 */
export function fillUnknownState(state, fallback) {
  const out = { ...state };
  let merged = false;
  if (fallback) {
    ['readOnly', 'visible', 'mandatory'].forEach((key) => {
      if ((out[key] === null || out[key] === undefined) && fallback[key] !== null && fallback[key] !== undefined) {
        out[key] = fallback[key];
        merged = true;
      }
    });
  }
  return { state: out, merged };
}

/**
 * Where the portal hover tag goes: just above the widget box, else just below it, else (a box filling the
 * viewport) inside its top-left corner. Kept outside the box so it never covers the widget's controls.
 */
export function tagPlacement(rect, tagHeight, tagWidth, viewport) {
  let top = Math.max(0, rect.top);
  let side = 'inside';
  if (rect.top >= tagHeight) {
    top = rect.top - tagHeight;
    side = 'above';
  } else if (rect.bottom + tagHeight <= viewport.height) {
    top = rect.bottom;
    side = 'below';
  }
  const left = Math.max(0, Math.min(rect.left, viewport.width - tagWidth));
  return { top, left, side };
}

// --- Display helpers --------------------------------------------------------------------------

const SHORT_TYPES = {
  glide_date_time: 'date/time',
  glide_date: 'date',
  glide_time: 'time',
  journal_input: 'journal',
  journal: 'journal',
  glide_list: 'list',
  glide_duration: 'duration',
  timer: 'duration',
  html: 'html',
  translated_html: 'html',
  translated_text: 'text',
  translated_field: 'text',
  script: 'script',
  script_plain: 'script',
  script_server: 'script',
  conditions: 'conditions',
  user_image: 'image',
  sys_class_name: 'class',
};

/** Compact type label for a chip: "reference", "choice", "date/time"... */
export function shortType(field) {
  if (!field) return '';
  // Dictionary choice: 1 dropdown with --None--, 3 dropdown without it, 2 suggestion. A suggestion field (task.short_description,
  // checked on a live instance) is free text that only offers values, so it stays a string.
  if (field.choiceType && field.choiceType !== '2' && field.type !== 'reference') return 'choice';
  return SHORT_TYPES[field.type] || field.type || '';
}

/** Root-relative record URL, or '' when the table or sys_id does not look valid. */
export function recordPath(table, sysId) {
  return isName(table) && isSysId(sysId) ? `/${table}.do?sys_id=${String(sysId).toLowerCase()}` : '';
}
