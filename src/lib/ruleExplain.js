// "Why did / didn't my rule run?", the pure half. Evaluates an encoded query against the values of ONE record and
// explains, rule by rule, whether a business rule, client script, UI policy, data policy or ACL applies to it, and the
// first thing that stops it. The instance queries are in src/content/ruleExplain.js; the panel is
// src/sidebar/WhyRulePanel.jsx.
//
// Honesty rules, because a wrong "won't run" costs more than "cannot tell":
//   * A condition that needs the instance (javascript:, DYNAMIC, date ranges relative to now, a value on a related
//     record that is not on the form, a condition SCRIPT) is reported as "cannot tell", never guessed.
//   * A rule that fails one check for certain is "won't run" even when another of its checks is a "cannot tell".
//   * Strings compare case-insensitively (the database collation does); numbers compare as numbers.

import { parseEncodedQuery } from './query.js';

export const RULE_TYPES = {
  br: { key: 'br', table: 'sys_script', label: 'Business rule', plural: 'Business rules' },
  cs: { key: 'cs', table: 'sys_script_client', label: 'Client script', plural: 'Client scripts' },
  uip: { key: 'uip', table: 'sys_ui_policy', label: 'UI policy', plural: 'UI policies' },
  dp: { key: 'dp', table: 'sys_data_policy2', label: 'Data policy', plural: 'Data policies' },
  acl: { key: 'acl', table: 'sys_security_acl', label: 'ACL', plural: 'ACLs' },
};
export const RULE_TYPE_ORDER = ['br', 'cs', 'uip', 'dp', 'acl'];

export const OPERATIONS = ['insert', 'update', 'delete', 'query'];
export const ACL_OPERATIONS = ['read', 'write', 'create', 'delete'];

/** Execution stage of a business rule: display rules run when the form loads, then before, after, async. */
const STAGE_RANK = { display: 0, before: 1, after: 2, async: 3 };

const SYS_ID = /^[0-9a-f]{32}$/i;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const MAX_SHOWN = 60;

const bool = (v) => v === true || v === 'true' || v === '1' || v === 1;
const text = (v) => (v === undefined || v === null ? '' : String(v));
const isBlank = (v) => text(v) === '';

export function clip(value, max = MAX_SHOWN) {
  const s = text(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// --- Values --------------------------------------------------------------------------------------------

const BOOL_WORDS = { true: true, false: false, 1: true, 0: false };

/** Equality the way the database sees it: numbers as numbers, true/1 alike, strings without regard to case. */
export function looseEquals(a, b) {
  const x = text(a).trim();
  const y = text(b).trim();
  if (NUMBER.test(x) && NUMBER.test(y)) return Number(x) === Number(y);
  const bx = BOOL_WORDS[x.toLowerCase()];
  const by = BOOL_WORDS[y.toLowerCase()];
  const boolish = (s) => ['true', 'false'].includes(s.toLowerCase());
  if (bx !== undefined && by !== undefined && (boolish(x) || boolish(y))) return bx === by;
  return x.toLowerCase() === y.toLowerCase();
}

/** Negative, zero or positive; numbers numerically, everything else (dates included) as lower-case text. */
export function compareValues(a, b) {
  const x = text(a).trim();
  const y = text(b).trim();
  if (NUMBER.test(x) && NUMBER.test(y)) return Number(x) - Number(y);
  const lx = x.toLowerCase();
  const ly = y.toLowerCase();
  return lx < ly ? -1 : lx > ly ? 1 : 0;
}

/** What to call a value in a sentence: the display value of a reference, "(empty)" for nothing, clipped. */
export function shownValue(actual, display) {
  if (isBlank(actual)) return '(empty)';
  const shown = !isBlank(display) && display !== actual ? display : actual;
  return clip(shown);
}

// --- One condition -------------------------------------------------------------------------------------

const WANTED = {
  '=': (v) => `wanted ${quoted(v)}`,
  '!=': (v) => `must not be ${quoted(v)}`,
  '>': (v) => `must be greater than ${quoted(v)}`,
  '>=': (v) => `must be ${quoted(v)} or more`,
  '<': (v) => `must be less than ${quoted(v)}`,
  '<=': (v) => `must be ${quoted(v)} or less`,
  LIKE: (v) => `must contain "${clip(v)}"`,
  'NOT LIKE': (v) => `must not contain "${clip(v)}"`,
  NOTLIKE: (v) => `must not contain "${clip(v)}"`,
  STARTSWITH: (v) => `must start with "${clip(v)}"`,
  ENDSWITH: (v) => `must end with "${clip(v)}"`,
  IN: (v) => `must be one of ${listText(v)}`,
  'NOT IN': (v) => `must not be any of ${listText(v)}`,
  ISEMPTY: () => 'must be empty',
  ISNOTEMPTY: () => 'must not be empty',
  EMPTYSTRING: () => 'must be an empty string',
  BETWEEN: (v) => `must be between ${text(v).split('@').map(quoted).join(' and ')}`,
  SAMEAS: (v) => `must equal ${v}`,
  NSAMEAS: (v) => `must differ from ${v}`,
  GT_FIELD: (v) => `must be greater than ${v}`,
  LT_FIELD: (v) => `must be less than ${v}`,
  GT_OR_EQUALS_FIELD: (v) => `must be ${v} or more`,
  LT_OR_EQUALS_FIELD: (v) => `must be ${v} or less`,
  VALCHANGES: () => 'must have changed',
  CHANGESFROM: (v) => `must change from ${quoted(v)}`,
  CHANGESTO: (v) => `must change to ${quoted(v)}`,
  ANYTHING: () => 'anything goes',
};

function quoted(v) {
  return isBlank(v) ? '(empty)' : clip(v);
}

function listText(v) {
  const items = text(v).split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 4 ? `${items.slice(0, 4).join(', ')} or ${items.length - 4} more` : items.join(', ') || '(nothing)';
}

const RELATIVE_OPS = new Set(['RELATIVEGT', 'RELATIVELT', 'RELATIVEGE', 'RELATIVELE', 'RELATIVEEE', 'DATEPART', 'ON', 'NOTON', 'MORETHAN', 'LESSTHAN']);

/** A field's value on the form (`current`) or as saved (`previous`): { found, value, display }. */
function read(field, ctx, which) {
  if (which === 'previous') {
    if (ctx.isNew) return { found: true, value: '', display: '' };
    if (!ctx.previous) return { found: false, why: 'the saved values were not available' };
    if (field in ctx.previous) return { found: true, value: text(ctx.previous[field]), display: text(ctx.display?.[field]) };
    return { found: false, why: `${field} is not in the saved record` };
  }
  const current = ctx.current || {};
  if (field in current) {
    const value = text(current[field]);
    // A display value belongs to the SAVED value: once the form changes the field it no longer applies.
    const sameAsSaved = !ctx.previous || text(ctx.previous[field]) === value;
    return { found: true, value, display: sameAsSaved ? text(ctx.display?.[field]) : '' };
  }
  if (field.includes('.')) return { found: false, why: `${field} is on a related record and its value is not on the form` };
  return { found: false, why: `${field} is not on the form` };
}

const result = (outcome, reason) => ({ outcome, reason });
const cannot = (reason) => result(null, reason);

/**
 * @param {{field: string, op: string, value: string}} cond
 * @returns {{outcome: boolean|null, reason: string}} outcome null = cannot tell
 */
export function evaluateCondition(cond, ctx = {}) {
  const { field, op } = cond;
  const raw = text(cond.value);
  const wanted = (WANTED[op] || (() => 'did not match'))(raw);

  if (/javascript:/i.test(raw) || op === 'DYNAMIC') {
    return cannot(`${field} is compared with ${op === 'DYNAMIC' ? 'a dynamic filter' : `a script (${clip(raw, 40)})`}, which the instance works out`);
  }
  if (RELATIVE_OPS.has(op)) return cannot(`${field} is compared with a date relative to now, which depends on the instance clock`);
  if (op === 'ANYTHING') return result(true, `${field} may be anything`);
  if (op === 'INSTANCEOF') {
    if (!Array.isArray(ctx.chain)) return cannot('the table hierarchy was not available');
    const ok = ctx.chain.includes(raw);
    return result(ok, ok ? `the record is a ${raw}` : `the record is a ${ctx.table || 'record'}, wanted an instance of ${raw}`);
  }

  if (op === 'VALCHANGES' || op === 'CHANGESFROM' || op === 'CHANGESTO') return evaluateChange(cond, ctx, wanted);

  const cur = read(field, ctx, 'current');
  if (!cur.found) return cannot(cur.why);
  const shown = shownValue(cur.value, cur.display);
  const is = `${field} is ${shown}`;
  const yes = (phrase) => result(true, phrase || is);
  const no = () => result(false, `${is}, ${wanted}`);
  const either = (fn) => fn(cur.value) || (!isBlank(cur.display) && fn(cur.display));

  switch (op) {
    case '=':
      return either((v) => looseEquals(v, raw)) ? yes() : no();
    case '!=':
      return either((v) => looseEquals(v, raw)) ? no() : yes();
    case '>':
    case '>=':
    case '<':
    case '<=': {
      if (isBlank(cur.value)) return result(false, `${is}, ${wanted}`);
      const diff = compareValues(cur.value, raw);
      const ok = op === '>' ? diff > 0 : op === '>=' ? diff >= 0 : op === '<' ? diff < 0 : diff <= 0;
      return ok ? yes() : no();
    }
    case 'LIKE':
      return contains(cur, raw) ? yes(`${field} contains "${clip(raw)}"`) : no();
    case 'NOT LIKE':
    case 'NOTLIKE':
      return contains(cur, raw) ? no() : yes(`${field} does not contain "${clip(raw)}"`);
    case 'STARTSWITH':
      return texts(cur).some((t) => t.toLowerCase().startsWith(raw.toLowerCase())) ? yes(`${field} starts with "${clip(raw)}"`) : no();
    case 'ENDSWITH':
      return texts(cur).some((t) => t.toLowerCase().endsWith(raw.toLowerCase())) ? yes(`${field} ends with "${clip(raw)}"`) : no();
    case 'IN':
    case 'NOT IN': {
      const items = raw.split(',').map((s) => s.trim());
      // A list field (watch list, groups) holds comma separated values: any of its items may match.
      const actual = [cur.value, ...cur.value.split(',').map((s) => s.trim()), cur.display].filter((s) => !isBlank(s));
      const hit = actual.some((a) => items.some((i) => looseEquals(a, i)));
      return (op === 'IN') === hit ? yes() : no();
    }
    case 'ISEMPTY':
    case 'EMPTYSTRING':
      return isBlank(cur.value) ? yes(`${field} is empty`) : no();
    case 'ISNOTEMPTY':
      return isBlank(cur.value) ? no() : yes();
    case 'BETWEEN': {
      const [low, high] = raw.split('@');
      if (isBlank(cur.value) || high === undefined) return no();
      return compareValues(cur.value, low) >= 0 && compareValues(cur.value, high) <= 0 ? yes() : no();
    }
    case 'SAMEAS':
    case 'NSAMEAS':
    case 'GT_FIELD':
    case 'LT_FIELD':
    case 'GT_OR_EQUALS_FIELD':
    case 'LT_OR_EQUALS_FIELD': {
      const other = read(raw, ctx, 'current');
      if (!other.found) return cannot(other.why);
      const diff = compareValues(cur.value, other.value);
      const ok =
        op === 'SAMEAS' ? looseEquals(cur.value, other.value) : op === 'NSAMEAS' ? !looseEquals(cur.value, other.value) : op === 'GT_FIELD' ? diff > 0 : op === 'LT_FIELD' ? diff < 0 : op === 'GT_OR_EQUALS_FIELD' ? diff >= 0 : diff <= 0;
      return ok ? result(true, `${is} and ${raw} is ${shownValue(other.value, other.display)}`) : result(false, `${is} and ${raw} is ${shownValue(other.value, other.display)}, ${wanted}`);
    }
    default:
      return cannot(`${field} uses the operator ${op}, which is not evaluated here`);
  }
}

function texts(read1) {
  return [read1.display, read1.value].filter((s) => !isBlank(s));
}

function contains(read1, needle) {
  if (isBlank(needle)) return true;
  return texts(read1).some((t) => t.toLowerCase().includes(needle.toLowerCase()));
}

function evaluateChange(cond, ctx, wanted) {
  const { field, op } = cond;
  const raw = text(cond.value);
  const cur = read(field, ctx, 'current');
  if (!cur.found) return cannot(cur.why);
  const prev = read(field, ctx, 'previous');
  if (!prev.found) return cannot(prev.why);
  const changed = !looseEquals(cur.value, prev.value);
  const was = shownValue(prev.value, prev.display);
  const now = shownValue(cur.value, cur.display);
  const story = changed ? `${field} changed from ${was} to ${now}` : `${field} has not changed (it is ${now})`;
  if (op === 'VALCHANGES') return changed ? result(true, story) : result(false, `${story}, ${wanted}`);
  if (op === 'CHANGESFROM') {
    const ok = changed && looseEquals(prev.value, raw);
    return ok ? result(true, story) : result(false, `${story}, ${wanted}`);
  }
  const ok = changed && looseEquals(cur.value, raw);
  return ok ? result(true, story) : result(false, `${story}, ${wanted}`);
}

// --- A whole query -------------------------------------------------------------------------------------

const and3 = (list) => (list.includes(false) ? false : list.includes(null) ? null : true);
const or3 = (list) => (list.includes(true) ? true : list.includes(null) ? null : false);

/**
 * Evaluate an encoded query against a record.
 * @param {string} query
 * @param {{current?: object, previous?: object|null, display?: object, isNew?: boolean, chain?: string[], table?: string}} ctx
 *   current: the values on the form; previous: the saved values (null when unknown); display: display values of the
 *   saved record, used for reference fields.
 * @returns {{result: 'true'|'false'|'unknown', failure: string, passed: string[], unknownReasons: string[], notes: string[], empty: boolean}}
 */
export function evaluateQuery(query, ctx = {}) {
  const parsed = parseEncodedQuery(query);
  const groups = parsed.groups.filter((g) => g.length);
  const notes = [];
  if (parsed.raw.length) notes.push(`Not understood here, so ignored: ${parsed.raw.map((r) => clip(r, 40)).join(', ')}`);

  if (!groups.length) {
    return { result: parsed.raw.length ? 'unknown' : 'true', failure: '', passed: [], unknownReasons: parsed.raw.length ? ['the filter uses syntax that is not evaluated here'] : [], notes, empty: !parsed.raw.length };
  }

  const evaluated = groups.map((group) => {
    // "a ^ b ^ OR c" means a AND (b OR c): an OR joins the condition before it.
    const clauses = [];
    group.forEach((cond) => {
      const one = { ...cond, ...evaluateCondition(cond, ctx) };
      if (cond.or && clauses.length) clauses[clauses.length - 1].push(one);
      else clauses.push([one]);
    });
    const clauseResults = clauses.map((clause) => or3(clause.map((c) => c.outcome)));
    return { clauses, clauseResults, result: and3(clauseResults) };
  });

  let overall = or3(evaluated.map((g) => g.result));
  if (overall === true && parsed.raw.length) overall = null; // part of the filter was not understood: cannot confirm

  const failure = overall === false ? failureText(evaluated) : '';
  const passed = [];
  const unknownReasons = [];
  evaluated.forEach((g) => {
    g.clauses.forEach((clause, i) => {
      if (g.clauseResults[i] === true && (overall === true || g.result === true)) passed.push((clause.find((c) => c.outcome === true) || clause[0]).reason);
      if (g.clauseResults[i] === null) clause.filter((c) => c.outcome === null).forEach((c) => unknownReasons.push(c.reason));
    });
  });
  if (parsed.raw.length) unknownReasons.push('part of the filter uses syntax that is not evaluated here');

  return { result: overall === true ? 'true' : overall === false ? 'false' : 'unknown', failure, passed, unknownReasons, notes, empty: false };
}

function failureText(evaluated) {
  const reasonFor = (group) => {
    const index = group.clauseResults.indexOf(false);
    const clause = group.clauses[index] || [];
    const reasons = clause.filter((c) => c.outcome === false).map((c) => c.reason);
    return reasons.length > 1 ? `${reasons.join(' and ')} (either would have been enough)` : reasons[0] || '';
  };
  if (evaluated.length === 1) return reasonFor(evaluated[0]);
  return evaluated.map((g, i) => `group ${i + 1}: ${reasonFor(g)}`).join(' | ');
}

/** "a, b and 2 more" for a list of reasons. */
export function summarize(reasons, max = 3) {
  const list = reasons.filter(Boolean);
  if (list.length <= max) return list.join(', ');
  return `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
}

// --- Rules ---------------------------------------------------------------------------------------------

/**
 * Turn a Table API row (strings) into the shape the explainers use.
 * @param {'br'|'cs'|'uip'|'dp'|'acl'} type
 * @param {object} row
 * @param {{roleNames?: string[]}} [extra] role names resolved by the caller (the row only holds sys_ids)
 */
export function normalizeRule(type, row = {}, extra = {}) {
  const base = { type, sysId: text(row.sys_id), active: row.active === undefined ? true : bool(row.active), roleNames: extra.roleNames || null };
  switch (type) {
    case 'br':
      return {
        ...base,
        name: text(row.name) || '(unnamed rule)',
        table: text(row.collection),
        when: text(row.when) || 'before',
        order: Number(row.order) || 0,
        ops: { insert: bool(row.action_insert), update: bool(row.action_update), delete: bool(row.action_delete), query: bool(row.action_query) },
        filter: text(row.filter_condition),
        advanced: bool(row.advanced),
        conditionScript: text(row.condition),
        roleIds: text(row.role_conditions).split(',').map((s) => s.trim()).filter(Boolean),
      };
    case 'cs':
      return {
        ...base,
        name: text(row.name) || '(unnamed script)',
        table: text(row.table),
        csType: text(row.type),
        field: text(row.field) || text(row.field_name),
        uiType: text(row.ui_type),
        appliesExtended: 'applies_extended' in row ? bool(row.applies_extended) : null,
        order: 0,
      };
    case 'uip':
      return {
        ...base,
        name: text(row.short_description) || '(unnamed policy)',
        table: text(row.table),
        filter: text(row.conditions),
        onLoad: bool(row.on_load),
        reverseIfFalse: bool(row.reverse_if_false),
        inherit: bool(row.inherit),
        runScripts: bool(row.run_scripts),
        view: text(row.view),
        order: Number(row.order) || 0,
      };
    case 'dp':
      return {
        ...base,
        name: text(row.short_description) || '(unnamed policy)',
        table: text(row.model_table),
        filter: text(row.conditions),
        enforceUi: bool(row.enforce_ui),
        reverseIfFalse: bool(row.reverse_if_false),
        inherit: bool(row.inherit),
        order: 0,
      };
    case 'acl': {
      const acl = parseAclName(row.name);
      return {
        ...base,
        name: text(row.name) || '(unnamed ACL)',
        table: acl.table,
        aclField: acl.field,
        operation: text(row['operation.name']) || text(row.operation),
        filter: text(row.condition),
        advanced: bool(row.advanced),
        script: text(row.script),
        adminOverrides: row.admin_overrides === undefined ? true : bool(row.admin_overrides),
        order: 0,
      };
    }
    default:
      throw new Error(`Unknown rule type "${type}".`);
  }
}

/** "incident.priority" -> { table: 'incident', field: 'priority' }; "incident" -> field ''; "*.priority" -> table '*'. */
export function parseAclName(name) {
  const value = text(name).trim();
  const dot = value.indexOf('.');
  if (dot < 0) return { table: value, field: '' };
  return { table: value.slice(0, dot), field: value.slice(dot + 1) === '*' ? '' : value.slice(dot + 1) };
}

const pass = (id, detail) => ({ id, status: 'pass', detail });
const fail = (id, detail) => ({ id, status: 'fail', detail });
const unsure = (id, detail) => ({ id, status: 'unknown', detail });
const info = (id, detail) => ({ id, status: 'info', detail });

function activeCheck(rule) {
  return rule.active ? pass('active', 'it is active') : fail('active', 'it is inactive');
}

/** Does a rule on `ruleTable` apply to this record's table? Parent tables apply unless `inherits` is false. */
function tableCheck(rule, ctx, { inherits = true } = {}) {
  const table = rule.table;
  const here = ctx.table || 'this record';
  if (table === '*' || !table) return pass('table', 'it applies to every table');
  const chain = ctx.chain && ctx.chain.length ? ctx.chain : [ctx.table];
  const index = chain.indexOf(table);
  if (index === 0) return pass('table', `it is on ${table}`);
  if (index > 0) {
    if (inherits === false) return fail('table', `it is on ${table}, the parent of ${here}, and is not set to apply to tables that extend it`);
    if (inherits === null) return unsure('table', `it is on ${table}, the parent of ${here}; whether it applies to extended tables is not known`);
    return pass('table', `it is on ${table}, the parent of ${here}, so it applies here too`);
  }
  return fail('table', `it is on ${table}, but this record is on ${here}`);
}

function rolesCheck(roleNames, ctx, what = 'it') {
  if (!roleNames || !roleNames.length) return pass('roles', 'no role is required');
  const mine = ctx.roles;
  const need = roleNames.join(' or ');
  if (!Array.isArray(mine)) return unsure('roles', `${what} needs ${need}; your roles could not be read`);
  if (mine.includes('admin')) return pass('roles', `${what} needs ${need}; you have admin, which passes every role check`);
  const have = roleNames.filter((r) => mine.includes(r));
  if (have.length) return pass('roles', `${what} needs ${need}; you have ${have.join(', ')}`);
  return fail('roles', `${what} needs ${need}; you have ${mine.length ? summarize(mine, 5) : 'no roles'}`);
}

function queryCheck(id, filter, ctx, label = 'the condition') {
  if (!text(filter).trim()) return pass(id, 'no condition');
  const evaluated = evaluateQuery(filter, ctx);
  if (evaluated.result === 'true') return pass(id, `${label} is met: ${summarize(evaluated.passed) || 'all parts match'}`);
  if (evaluated.result === 'false') return fail(id, `${label} is not met: ${evaluated.failure}`);
  return unsure(id, `${label} cannot be worked out here: ${summarize(evaluated.unknownReasons, 2)}`);
}

function explainBusinessRule(rule, ctx) {
  const operation = ctx.operation || (ctx.isNew ? 'insert' : 'update');
  const checks = [activeCheck(rule), tableCheck(rule, ctx)];

  if (rule.when === 'display') {
    checks.push(pass('operation', 'a display rule: it runs when the form loads, not when the record is saved'));
  } else {
    const ops = OPERATIONS.filter((o) => rule.ops[o]);
    if (rule.ops[operation]) {
      checks.push(pass('operation', `it runs on ${ops.join(', ')}`));
    } else {
      const hint = rule.ops.insert && !rule.ops.update && !ctx.isNew ? '; this record already exists' : '';
      checks.push(fail('operation', `it runs on ${ops.length ? ops.join(', ') : 'no operation'}, not on ${operation}${hint}`));
    }
  }

  // A display rule sees the record as it is loaded; the others see the values being saved.
  const values = rule.when === 'display' && ctx.previous ? { ...ctx, current: ctx.previous } : ctx;
  checks.push(queryCheck('filter', rule.filter, values, 'the filter condition'));
  checks.push(rolesCheck(rule.roleNames, ctx));
  if (rule.advanced && rule.conditionScript.trim()) {
    checks.push(unsure('condition-script', `it has a condition script (${clip(rule.conditionScript, 50)}), which the instance evaluates`));
  }
  if (rule.advanced) checks.push(info('script', 'its script can still stop early or abort the save; that is not evaluated here'));
  if (rule.when === 'async') checks.push(info('async', 'async rules run a moment later in the background, so their effect appears after the save'));
  return checks;
}

function explainClientScript(rule, ctx) {
  const checks = [activeCheck(rule), tableCheck(rule, ctx, { inherits: rule.appliesExtended })];
  const ui = ctx.uiType || 'desktop';
  if (rule.uiType === '1' && ui === 'desktop') checks.push(fail('ui', 'it is set for mobile / service portal only, not the desktop form'));
  else checks.push(pass('ui', rule.uiType === '1' ? 'it is set for mobile / service portal' : 'it applies to the desktop form'));

  if (rule.csType === 'onLoad') {
    checks.push(pass('trigger', 'it runs when the form loads'));
  } else if (rule.csType === 'onSubmit') {
    checks.push(pass('trigger', 'it runs when the form is submitted'));
  } else if (rule.csType === 'onCellEdit') {
    checks.push(fail('trigger', 'it runs when a cell is edited in a list, not on a form'));
  } else if (rule.csType === 'onChange') {
    if (!rule.field) {
      checks.push(unsure('trigger', 'it is an onChange script but names no field'));
    } else if (ctx.current && Object.keys(ctx.current).length && !(rule.field in ctx.current)) {
      checks.push(fail('trigger', `it watches ${rule.field}, which is not on this form`));
    } else {
      const cur = read(rule.field, ctx, 'current');
      checks.push(pass('trigger', `it runs when ${rule.field} changes (now ${cur.found ? shownValue(cur.value, cur.display) : 'unknown'})`));
    }
  } else {
    checks.push(unsure('trigger', `its type "${rule.csType || 'unknown'}" is not recognised`));
  }
  return checks;
}

function explainUiPolicy(rule, ctx) {
  const checks = [activeCheck(rule), tableCheck(rule, ctx, { inherits: rule.inherit })];
  if (rule.view) checks.push(unsure('view', 'it is limited to a form view; which view is on screen is not known here'));
  const evaluated = rule.filter ? evaluateQuery(rule.filter, ctx) : null;
  if (!evaluated) {
    checks.push(pass('filter', 'no condition, so it always applies'));
  } else if (evaluated.result === 'true') {
    checks.push(pass('filter', `the condition is met: ${summarize(evaluated.passed) || 'all parts match'}, so its actions apply`));
  } else if (evaluated.result === 'false') {
    const reverse = rule.reverseIfFalse ? '; "reverse if false" is on, so the opposite actions apply instead' : '';
    checks.push(fail('filter', `the condition is not met: ${evaluated.failure}${reverse}`));
  } else {
    checks.push(unsure('filter', `the condition cannot be worked out here: ${summarize(evaluated.unknownReasons, 2)}`));
  }
  checks.push(info('on_load', rule.onLoad ? 'it is checked when the form loads and whenever a field changes' : 'it is checked only when a field changes, not on load'));
  if (rule.runScripts) checks.push(info('scripts', 'it also runs its "execute if true / false" scripts, which are not evaluated here'));
  return checks;
}

function explainDataPolicy(rule, ctx) {
  const checks = [activeCheck(rule), tableCheck(rule, ctx, { inherits: rule.inherit })];
  const evaluated = rule.filter ? evaluateQuery(rule.filter, ctx) : null;
  if (!evaluated) {
    checks.push(pass('filter', 'no condition, so it always applies'));
  } else if (evaluated.result === 'true') {
    checks.push(pass('filter', `the condition is met: ${summarize(evaluated.passed) || 'all parts match'}, so its field rules are enforced`));
  } else if (evaluated.result === 'false') {
    const reverse = rule.reverseIfFalse ? '; "reverse if false" is on, so the opposite rules apply instead' : '';
    checks.push(fail('filter', `the condition is not met: ${evaluated.failure}${reverse}`));
  } else {
    checks.push(unsure('filter', `the condition cannot be worked out here: ${summarize(evaluated.unknownReasons, 2)}`));
  }
  checks.push(info('ui', rule.enforceUi ? 'it is also enforced on the form, like a UI policy' : 'it is enforced when the record is saved; the form does not show it until then'));
  return checks;
}

function explainAcl(rule, ctx) {
  const operation = ctx.aclOperation || 'write';
  const checks = [activeCheck(rule)];
  const wild = rule.table === '*';
  checks.push(wild ? pass('table', `it applies to the field ${rule.aclField || '*'} on every table`) : tableCheck(rule, ctx));
  const opName = text(rule.operation).toLowerCase();
  checks.push(opName === operation ? pass('operation', `it protects ${operation}`) : fail('operation', `it protects ${opName || 'another operation'}, not ${operation}`));
  if (rule.aclField) checks.push(info('field', `it guards the field ${rule.aclField}, not the whole record`));

  const mine = ctx.roles;
  if (rule.adminOverrides && Array.isArray(mine) && mine.includes('admin') && checks.every((c) => c.status !== 'fail')) {
    checks.push(pass('admin', 'admin overrides is on and you have admin, so it passes whatever its roles, condition and script say'));
    return checks;
  }
  checks.push(rolesCheck(rule.roleNames, ctx));
  checks.push(queryCheck('filter', rule.filter, ctx, 'the condition'));
  if (rule.advanced && rule.script.trim()) checks.push(unsure('script', `it has a script (${clip(rule.script, 50)}), which the instance evaluates`));
  return checks;
}

const EXPLAINERS = { br: explainBusinessRule, cs: explainClientScript, uip: explainUiPolicy, dp: explainDataPolicy, acl: explainAcl };

/** Words for an outcome, per type (an ACL "passes" rather than "runs"). */
export function outcomeWord(type, outcome) {
  if (type === 'acl') return outcome === 'run' ? 'Would pass' : outcome === 'skip' ? 'Would not pass' : 'Cannot tell';
  return outcome === 'run' ? 'Would run' : outcome === 'skip' ? "Won't run" : 'Cannot tell';
}

/**
 * Explain one rule for one record.
 * @param {object} rule from normalizeRule
 * @param {object} ctx { table, chain, isNew, operation, aclOperation, current, previous, display, roles, uiType }
 */
export function explainRule(rule, ctx = {}) {
  const checks = EXPLAINERS[rule.type](rule, ctx);
  const failed = checks.find((c) => c.status === 'fail');
  const unclear = checks.find((c) => c.status === 'unknown');
  let outcome = 'run';
  let headline;
  if (failed) {
    outcome = 'skip';
    headline = `${outcomeWord(rule.type, 'skip')}: ${failed.detail}`;
  } else if (unclear) {
    outcome = 'unknown';
    headline = `${outcomeWord(rule.type, 'unknown')}: ${unclear.detail}`;
  } else {
    const passes = checks.filter((c) => c.status === 'pass' && !['active', 'table', 'roles'].includes(c.id));
    headline = `${outcomeWord(rule.type, 'run')}: ${passes.length ? passes.map((c) => c.detail).slice(-2).join('; ') : 'nothing stops it'}`;
  }
  return {
    type: rule.type,
    typeLabel: RULE_TYPES[rule.type].label,
    sysId: rule.sysId,
    name: rule.name,
    table: rule.table,
    when: rule.when || rule.csType || '',
    order: rule.order || 0,
    stage: rule.type === 'br' ? STAGE_RANK[rule.when] ?? 1 : 0,
    outcome,
    headline,
    checks,
    link: { table: RULE_TYPES[rule.type].table, sysId: rule.sysId },
  };
}

/** Execution order: type, then (business rules) display/before/after/async, then the rule's order, then name. */
export function compareExplained(a, b) {
  return RULE_TYPE_ORDER.indexOf(a.type) - RULE_TYPE_ORDER.indexOf(b.type) || a.stage - b.stage || a.order - b.order || a.name.localeCompare(b.name);
}

/**
 * Explain many rules and group them.
 * @returns {{results: object[], groups: {run: object[], skip: object[], unknown: object[]}, counts: object}}
 */
export function explainAll(rules, ctx = {}) {
  const results = rules.map((rule) => explainRule(rule, ctx)).sort(compareExplained);
  const groups = { run: [], skip: [], unknown: [] };
  results.forEach((r) => groups[r.outcome].push(r));
  return { results, groups, counts: { run: groups.run.length, skip: groups.skip.length, unknown: groups.unknown.length, total: results.length } };
}

/** Every dot-walked field a set of rules' conditions read, so the caller can fetch their saved values. */
export function dottedFields(rules) {
  const found = new Set();
  rules.forEach((rule) => {
    parseEncodedQuery(rule.filter || '').groups.forEach((g) => g.forEach((c) => c.field.includes('.') && found.add(c.field)));
  });
  return [...found];
}

/** Which operation a save of this record would be, unless the user picks another. */
export function defaultOperation(isNew) {
  return isNew ? 'insert' : 'update';
}

/** The report as markdown, for a ticket or a message. */
export function explanationToMarkdown({ subject = {}, groups }) {
  const lines = [`# Why rules ran or not: ${subject.table || 'record'}${subject.isNew ? ' (new record)' : ''}`, ''];
  [['run', 'Would run'], ['skip', "Won't run"], ['unknown', 'Cannot tell']].forEach(([key, title]) => {
    const list = groups[key] || [];
    if (!list.length) return;
    lines.push(`## ${title} (${list.length})`, '');
    list.forEach((r) => lines.push(`- **${r.name}** (${r.typeLabel}${r.when ? `, ${r.when}` : ''}): ${r.headline}`));
    lines.push('');
  });
  return lines.join('\n');
}
