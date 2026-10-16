// Encoded query tooling: parse, explain in plain English, and turn a filter
// into GlideRecord / GlideAggregate code. Everything here is deterministic and
// local, so none of it costs AI tokens.

// Longer operators first, and every operator that contains "IN" / "ON" / "LIKE" before those:
// field names are matched lazily, so nameEMPTYSTRING used to parse as nameEMPTYSTR IN G.
const OPERATORS = [
  'EMPTYSTRING',
  'NOT LIKE',
  'DATEPART',
  'RELATIVEGT',
  'RELATIVELT',
  'RELATIVEGE',
  'RELATIVELE',
  'RELATIVEEE',
  'MORETHAN',
  'LESSTHAN',
  'GT_OR_EQUALS_FIELD',
  'LT_OR_EQUALS_FIELD',
  'GT_FIELD',
  'LT_FIELD',
  'NOT IN',
  'NOTLIKE',
  'NOTON',
  'NSAMEAS',
  'STARTSWITH',
  'ENDSWITH',
  'ISNOTEMPTY',
  'ISEMPTY',
  'BETWEEN',
  'INSTANCEOF',
  'DYNAMIC',
  'SAMEAS',
  'VALCHANGES',
  'CHANGESFROM',
  'CHANGESTO',
  'ANYTHING',
  'LIKE',
  'IN',
  'ON',
  '!=',
  '>=',
  '<=',
  '=',
  '>',
  '<',
];

const CONDITION_RE = new RegExp(
  `^([A-Za-z0-9_.]+?)(${OPERATORS.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(.*)$`,
  's'
);

const ESCAPED_CARET = '\u0001';

/**
 * Parse an encoded query.
 * @returns {{groups: Array<Array<{field,op,value,or}>>, orderBy: Array<{field,desc}>, groupBy: string[], raw: string[]}}
 */
export function parseEncodedQuery(query) {
  const result = { groups: [[]], orderBy: [], groupBy: [], raw: [] };
  const text = String(query || '').trim();
  if (!text) return result;

  const tokens = text.replace(/\^\^/g, ESCAPED_CARET).split('^');

  tokens.forEach((rawToken) => {
    let token = rawToken.split(ESCAPED_CARET).join('^');
    if (!token || token === 'EQ') return;

    if (token.startsWith('ORDERBYDESC')) {
      result.orderBy.push({ field: token.slice(11), desc: true });
      return;
    }
    if (token.startsWith('ORDERBY')) {
      result.orderBy.push({ field: token.slice(7), desc: false });
      return;
    }
    if (token.startsWith('GROUPBY')) {
      result.groupBy.push(token.slice(7));
      return;
    }
    if (token.startsWith('RLQUERY')) {
      result.raw.push(token);
      return;
    }

    let or = false;
    if (token.startsWith('NQ')) {
      result.groups.push([]);
      token = token.slice(2);
    } else if (token.startsWith('OR')) {
      or = true;
      token = token.slice(2);
    }
    if (!token) return;

    const match = token.match(CONDITION_RE);
    if (!match) {
      result.raw.push(rawToken);
      return;
    }
    result.groups[result.groups.length - 1].push({
      field: match[1],
      op: match[2],
      value: match[3],
      or,
    });
  });

  return result;
}

const PHRASES = {
  '=': 'is',
  '!=': 'is not',
  '>': 'is greater than',
  '>=': 'is greater than or equal to',
  '<': 'is less than',
  '<=': 'is less than or equal to',
  STARTSWITH: 'starts with',
  ENDSWITH: 'ends with',
  LIKE: 'contains',
  NOTLIKE: 'does not contain',
  IN: 'is one of',
  'NOT IN': 'is not one of',
  ISEMPTY: 'is empty',
  ISNOTEMPTY: 'is not empty',
  BETWEEN: 'is between',
  ON: 'is on',
  NOTON: 'is not on',
  SAMEAS: 'is the same as the field',
  NSAMEAS: 'is different from the field',
  DYNAMIC: 'matches the dynamic filter',
  INSTANCEOF: 'is an instance of',
  VALCHANGES: 'has changed',
  CHANGESFROM: 'changes from',
  CHANGESTO: 'changes to',
  ANYTHING: 'is anything',
  EMPTYSTRING: 'is an empty string',
  'NOT LIKE': 'does not contain',
  DATEPART: 'falls on',
  RELATIVEGT: 'is after (relative)',
  RELATIVELT: 'is before (relative)',
  RELATIVEGE: 'is on or after (relative)',
  RELATIVELE: 'is on or before (relative)',
  RELATIVEEE: 'is on (relative)',
  MORETHAN: 'is more than',
  LESSTHAN: 'is less than',
  GT_FIELD: 'is greater than the field',
  LT_FIELD: 'is less than the field',
  GT_OR_EQUALS_FIELD: 'is greater than or equal to the field',
  LT_OR_EQUALS_FIELD: 'is less than or equal to the field',
};

function describeValue(op, value) {
  if (op === 'ISEMPTY' || op === 'ISNOTEMPTY' || op === 'VALCHANGES' || op === 'ANYTHING' || op === 'EMPTYSTRING') return '';
  if (op === 'BETWEEN') return value.split('@').join(' and ');
  if (op === 'IN' || op === 'NOT IN') return value.split(',').join(', ');
  if (/^javascript:/i.test(value)) return `(computed) ${value}`;
  if (/^[0-9a-f]{32}$/i.test(value)) return `${value} (sys_id)`;
  return value === '' ? '(empty)' : value;
}

/** Plain-English description of a query. */
export function explainQuery(query, { table = '' } = {}) {
  const parsed = typeof query === 'string' ? parseEncodedQuery(query) : query;
  const lines = [];
  const subject = table ? `${table} records` : 'Records';
  const hasConditions = parsed.groups.some((g) => g.length);

  if (!hasConditions && !parsed.raw.length) {
    lines.push(`${subject}: all of them (no conditions).`);
  } else {
    parsed.groups.forEach((group, gi) => {
      if (!group.length) return;
      lines.push(gi === 0 ? `${subject} where:` : `OR, ${subject} where:`);
      group.forEach((c, ci) => {
        const joiner = ci === 0 ? '  -' : c.or ? '  - OR' : '  - AND';
        const value = describeValue(c.op, c.value);
        lines.push(`${joiner} ${c.field} ${PHRASES[c.op] || c.op}${value ? ` ${value}` : ''}`);
      });
    });
  }

  if (parsed.raw.length) {
    lines.push(`Not interpreted (shown as written): ${parsed.raw.join(', ')}`);
  }
  if (parsed.orderBy.length) {
    lines.push(
      `Sorted by ${parsed.orderBy.map((o) => `${o.field} ${o.desc ? 'descending' : 'ascending'}`).join(', then ')}.`
    );
  }
  if (parsed.groupBy.length) lines.push(`Grouped by ${parsed.groupBy.join(', ')}.`);
  return lines.join('\n');
}

function assertTable(table) {
  if (!/^[a-z0-9_]+$/i.test(table || '')) throw new Error('Enter a valid table name.');
}

function jsString(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `'${escaped}'`;
}

// Operators that addQuery(field, operator, value) accepts verbatim.
const ADDQUERY_OPS = new Set(['!=', '>', '>=', '<', '<=', 'STARTSWITH', 'ENDSWITH', 'LIKE', 'IN']);

function canExpress(parsed) {
  if (parsed.raw.length || parsed.groups.length > 1) return false;
  return parsed.groups[0].every((c) => {
    if (c.or || /^javascript:/i.test(c.value)) return false;
    return c.op === '=' || c.op === 'NOTLIKE' || c.op === 'NOT IN' || c.op === 'ISEMPTY' || c.op === 'ISNOTEMPTY' || ADDQUERY_OPS.has(c.op);
  });
}

function emitConditions(v, query, parsed) {
  if (!canExpress(parsed)) {
    // OR groups, dynamic filters and exotic operators round-trip safely as an encoded string.
    const conditions = conditionsOnly(query);
    return conditions ? [`${v}.addEncodedQuery(${jsString(conditions)});`] : [];
  }
  return parsed.groups[0].map((c) => {
    if (c.op === 'ISEMPTY') return `${v}.addNullQuery(${jsString(c.field)});`;
    if (c.op === 'ISNOTEMPTY') return `${v}.addNotNullQuery(${jsString(c.field)});`;
    if (c.op === '=') return `${v}.addQuery(${jsString(c.field)}, ${jsString(c.value)});`;
    const op = c.op === 'NOTLIKE' ? 'NOT LIKE' : c.op;
    return `${v}.addQuery(${jsString(c.field)}, ${jsString(op)}, ${jsString(c.value)});`;
  });
}

/** GlideRecord snippet for a filter. */
export function toGlideRecord(table, query, { limit = 0, variable = 'gr' } = {}) {
  assertTable(table);
  const parsed = parseEncodedQuery(query);
  const lines = [`var ${variable} = new GlideRecord(${jsString(table)});`];
  lines.push(...emitConditions(variable, query, parsed));
  parsed.orderBy.forEach((o) => lines.push(`${variable}.${o.desc ? 'orderByDesc' : 'orderBy'}(${jsString(o.field)});`));
  if (limit > 0) lines.push(`${variable}.setLimit(${Number(limit)});`);
  lines.push(
    `${variable}.query();`,
    `while (${variable}.next()) {`,
    `    gs.info(${variable}.getUniqueValue());`,
    '}'
  );
  return lines.join('\n');
}

/** GlideAggregate snippet for a filter. */
export function toGlideAggregate(table, query, { groupBy = [], variable = 'ga' } = {}) {
  assertTable(table);
  const parsed = parseEncodedQuery(query);
  const groups = groupBy.length ? groupBy : parsed.groupBy;
  const lines = [`var ${variable} = new GlideAggregate(${jsString(table)});`];
  lines.push(...emitConditions(variable, query, parsed));
  lines.push(`${variable}.addAggregate('COUNT');`);
  groups.forEach((g) => lines.push(`${variable}.groupBy(${jsString(g)});`));
  lines.push(`${variable}.query();`);

  if (groups.length) {
    const label = groups.map((g) => `${variable}.getValue(${jsString(g)})`).join(" + ' | ' + ");
    lines.push(`while (${variable}.next()) {`, `    gs.info(${label} + ': ' + ${variable}.getAggregate('COUNT'));`, '}');
  } else {
    lines.push(`if (${variable}.next()) {`, `    gs.info('Count: ' + ${variable}.getAggregate('COUNT'));`, '}');
  }
  return lines.join('\n');
}

/** Strip sort/group clauses so a query can be used for counting. */
export function conditionsOnly(query) {
  // "^^" is an escaped literal caret, not a separator: protect it while splitting.
  return String(query || '')
    .replace(/\^\^/g, '\u0001')
    .split('^')
    .filter((t) => t && !t.startsWith('ORDERBY') && !t.startsWith('GROUPBY'))
    .join('^')
    .replace(/\u0001/g, '^^');
}
