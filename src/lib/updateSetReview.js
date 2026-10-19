// Pure logic for "My work" and the update set ship check: parsing sys_update_xml
// payloads, analysing the scripts inside them, the pre-commit checklist and its
// verdict, release notes, and a few response parsers. No network, no DOM.
//
// UNVERIFIED against a live instance (see the final report / PROGRESS.md):
//   - sys_update_xml.name follows "<table>_<sys_id>" for ordinary records
//   - dictionary entries are named "sys_dictionary_<table>_<element>"
//   - the concoursepicker GET response shape (parsePickerCurrent is deliberately lenient)

import { lintScript } from './lint.js';
import { verifyScript } from './verify.js';
import { getApi } from './apiCatalog/index.js';
import { isDefaultUpdateSet } from './guards.js';
import { redactSecrets } from '../providers/redact.js';

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const MAX_XML_CHARS = 2000000;
const MAX_SCRIPT_CHARS = 200000;

// ---- XML ----------------------------------------------------------------------------------

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      } catch {
        return whole;
      }
    }
    const key = name.toLowerCase();
    return key in ENTITIES ? ENTITIES[key] : whole;
  });
}

const NAME_START = /[A-Za-z_]/;
const TAG_NAME = /^[A-Za-z_][\w.:-]*/;

function parseAttrs(text) {
  const attrs = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(text))) attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  return attrs;
}

/**
 * A small, forgiving XML reader: elements, attributes, text, CDATA (including
 * split "]]]]><![CDATA[>" sections), entities, comments and processing
 * instructions. A stray "<" that does not start a tag is kept as text, and an
 * unclosed document is returned as far as it was read.
 * @returns {{tag: string, attrs: object, children: object[], text: string}} a synthetic root
 */
export function parseXml(xml) {
  const text = String(xml || '').slice(0, MAX_XML_CHARS);
  const root = { tag: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const top = stack[stack.length - 1];
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      top.text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(text.slice(i, lt));

    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      top.text += text.slice(lt + 9, end === -1 ? n : end);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }

    const closing = text[lt + 1] === '/';
    const nameAt = closing ? lt + 2 : lt + 1;
    if (!NAME_START.test(text[nameAt] || '')) {
      // Not a tag (e.g. "a < b" in an unescaped script): keep it as text.
      top.text += '<';
      i = lt + 1;
      continue;
    }

    // Find the end of the tag, skipping ">" inside quoted attribute values.
    let j = nameAt;
    let quote = null;
    while (j < n) {
      const c = text[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j += 1;
    }
    if (j >= n) {
      top.text += decodeEntities(text.slice(lt));
      break;
    }

    const inner = text.slice(nameAt, j);
    i = j + 1;
    const name = (inner.match(TAG_NAME) || [''])[0];

    if (closing) {
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].tag === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const node = {
      tag: name,
      attrs: parseAttrs(inner.slice(name.length, selfClosing ? -1 : undefined)),
      children: [],
      text: '',
    };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

/**
 * Read a sys_update_xml payload:
 *   <record_update table="sys_script"><sys_script action="INSERT_OR_UPDATE"><script><![CDATA[...]]></script>...</sys_script></record_update>
 * @returns {{table: string, action: string, records: Array<{tag: string, action: string, fields: Record<string,string>, display: Record<string,string>}>}}
 */
export function parseUpdatePayload(xml) {
  const doc = parseXml(xml);
  const rootEl = doc.children[0];
  if (!rootEl) return { table: '', action: '', records: [] };
  const recordEls = rootEl.tag === 'record_update' ? rootEl.children : [rootEl];
  const records = recordEls.map((el) => {
    const fields = {};
    const display = {};
    el.children.forEach((child) => {
      // A repeated tag keeps its first value: the record's own fields come before any nested rows.
      if (!(child.tag in fields)) fields[child.tag] = child.text;
      if (child.attrs.display_value !== undefined && !(child.tag in display)) display[child.tag] = child.attrs.display_value;
    });
    return { tag: el.tag, action: el.attrs.action || '', fields, display };
  });
  const table = rootEl.attrs.table || recordEls[0]?.tag || '';
  const main = records.find((r) => r.tag === table) || records[0];
  return { table, action: main?.action || '', records };
}

// ---- update names and tables ------------------------------------------------------------

/** "<table>_<sys_id>" -> { table, sysId }. Other shapes (dictionary, documentation) give nulls. */
export function parseUpdateName(name) {
  const m = String(name || '').match(/^([a-z0-9_]+?)_([0-9a-f]{32})$/i);
  return m ? { table: m[1], sysId: m[2].toLowerCase() } : { table: null, sysId: null };
}

// sys_update_xml.type is the record's table label. Used when the name does not parse.
const TYPE_TABLES = {
  'business rule': 'sys_script',
  'script include': 'sys_script_include',
  'client script': 'sys_script_client',
  'catalog client script': 'catalog_script_client',
  'ui action': 'sys_ui_action',
  'ui policy': 'sys_ui_policy',
  'catalog ui policy': 'catalog_ui_policy',
  'ui script': 'sys_ui_script',
  'ui page': 'sys_ui_page',
  'access control': 'sys_security_acl',
  'scheduled script execution': 'sysauto_script',
  'fix script': 'sys_script_fix',
  'script action': 'sysevent_script_action',
  'scripted rest resource': 'sys_ws_operation',
  widget: 'sp_widget',
  'transform script': 'sys_transform_script',
  'email script': 'sys_script_email',
  'system property': 'sys_properties',
  role: 'sys_user_role',
  'dictionary entry': 'sys_dictionary',
  table: 'sys_db_object',
};

/**
 * The update names of one table's dictionary entries: "sys_dictionary_<table>_<element>", and
 * "..._null" for the table's own row. UNVERIFIED convention. Matching these exactly (instead of a
 * "sys_dictionary_<table>_" prefix) keeps table u_x from matching columns of table u_x_y.
 */
export function dictionaryUpdateNames(table, elements = []) {
  const out = new Set([`sys_dictionary_${table}_null`]);
  elements.forEach((el) => {
    if (el) out.add(`sys_dictionary_${table}_${el}`);
  });
  return out;
}

/** Best guess at the table an update entry belongs to. */
export function tableForEntry(entry) {
  const fromName = parseUpdateName(entry?.name).table;
  if (fromName) return fromName;
  const name = String(entry?.name || '');
  if (name.startsWith('sys_dictionary_')) return 'sys_dictionary';
  return TYPE_TABLES[String(entry?.type || '').trim().toLowerCase()] || null;
}

/** Link to the record behind an update entry, or to the entry itself. Root-relative. */
export function recordPathForEntry(entry) {
  const { table, sysId } = parseUpdateName(entry?.name);
  if (table && sysId) return `/${table}.do?sys_id=${sysId}`;
  return `/sys_update_xml.do?sys_id=${encodeURIComponent(entry?.sys_id || '')}`;
}

// ---- scripts ------------------------------------------------------------------------------

// Fields that hold JavaScript, per table. Tables not listed fall back to any
// field named "script" or ending in "_script".
export const SCRIPT_FIELDS = {
  sys_script: ['script', 'condition'],
  sys_script_include: ['script'],
  sys_script_client: ['script'],
  catalog_script_client: ['script'],
  sys_ui_action: ['script', 'condition'],
  sys_ui_policy: ['script_true', 'script_false'],
  catalog_ui_policy: ['script_true', 'script_false'],
  sys_ui_script: ['script'],
  sys_ui_page: ['client_script', 'processing_script'],
  sys_security_acl: ['script'],
  sysauto_script: ['script'],
  sys_script_fix: ['script'],
  sysevent_script_action: ['script'],
  sys_ws_operation: ['operation_script'],
  sp_widget: ['script', 'client_script', 'link'],
  sys_transform_script: ['script'],
  sys_transform_map: ['script'],
  sys_script_email: ['script'],
  sys_processor: ['script'],
};

export const SCRIPT_TABLES = new Set(Object.keys(SCRIPT_FIELDS));

const isGenericScriptField = (name) => name === 'script' || (/_script$/.test(name) && !/^sys_/.test(name));

/** @returns {Array<{table: string, field: string, code: string, fields: object}>} */
export function extractScripts(parsed, tableHint = '') {
  const table = parsed?.table || tableHint || '';
  const main = parsed?.records?.find((r) => r.tag === table) || parsed?.records?.[0];
  if (!main) return [];
  const names = SCRIPT_FIELDS[table] || Object.keys(main.fields).filter(isGenericScriptField);
  return names
    .filter((name) => String(main.fields[name] || '').trim())
    .map((name) => ({ table, field: name, code: String(main.fields[name]).slice(0, MAX_SCRIPT_CHARS), fields: main.fields }));
}

/** The verify.js kind for a script field, or null to lint only. */
export function scriptKind(table, field, fields = {}) {
  const isScript = field === 'script';
  switch (table) {
    case 'sys_script_client':
      return isScript ? 'client_script' : null;
    case 'catalog_script_client':
      return isScript ? 'catalog_client_script' : null;
    case 'sys_script':
      return isScript ? 'business_rule' : null;
    case 'sys_script_include':
      return isScript ? 'script_include' : null;
    case 'sysauto_script':
      return isScript ? 'scheduled_job' : null;
    case 'sys_security_acl':
      return isScript ? 'acl_script' : null;
    case 'sys_ws_operation':
      return field === 'operation_script' ? 'scripted_rest' : null;
    case 'sys_ui_policy':
    case 'catalog_ui_policy':
      return field === 'script_true' || field === 'script_false' ? 'ui_policy_script' : null;
    case 'sys_ui_script':
      return isScript ? 'ui_script' : null;
    case 'sys_ui_action':
      return isScript && String(fields.client) === 'true' ? 'ui_action_client' : null;
    default:
      return null;
  }
}

/**
 * Split a script into string-literal contents and comment-free code, keeping line numbers.
 * @returns {{strings: Array<{line: number, text: string}>, code: string, noComments: string}}
 *   code: comments and string contents blanked; noComments: only comments blanked.
 */
export function scanScript(source) {
  const src = String(source || '');
  const strings = [];
  let code = '';
  let noComments = '';
  let line = 1;
  let i = 0;
  const n = src.length;
  const blank = (c) => (c === '\n' ? '\n' : ' ');

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        code += ' ';
        noComments += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      code += '  ';
      noComments += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line += 1;
        code += blank(src[i]);
        noComments += blank(src[i]);
        i += 1;
      }
      if (i < n) {
        code += '  ';
        noComments += '  ';
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const startLine = line;
      let value = '';
      code += quote;
      noComments += quote;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          value += src[i] + src[i + 1];
          code += '  ';
          noComments += src[i] + src[i + 1];
          if (src[i + 1] === '\n') line += 1;
          i += 2;
          continue;
        }
        if (src[i] === '\n') {
          line += 1;
          if (quote !== '`') break; // unterminated ordinary string ends at the line break
        }
        value += src[i];
        code += blank(src[i]);
        noComments += src[i];
        i += 1;
      }
      if (src[i] === quote) {
        code += quote;
        noComments += quote;
        i += 1;
      }
      strings.push({ line: startLine, text: value });
      continue;
    }
    if (c === '\n') line += 1;
    code += c;
    noComments += c;
    i += 1;
  }
  return { strings, code, noComments };
}

/** 32-hex sys_ids written inside string literals. @returns {Array<{line: number, sysId: string}>} */
export function findHardcodedSysIds(source) {
  const out = [];
  const seen = new Set();
  scanScript(source).strings.forEach(({ line, text }) => {
    const re = /(?<![0-9a-z_])([0-9a-f]{32})(?![0-9a-z_])/gi;
    let m;
    while ((m = re.exec(text))) {
      const sysId = m[1].toLowerCase();
      const key = `${line}|${sysId}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ line, sysId });
      }
    }
  });
  return out;
}

const JS_GLOBALS = new Set([
  'Array', 'Boolean', 'Date', 'Error', 'Function', 'JSON', 'Math', 'Number', 'Object', 'RegExp', 'String', 'TypeError',
  'RangeError', 'SyntaxError', 'Map', 'Set', 'Promise', 'Symbol', 'Packages', 'Class', 'Object', 'XMLDocument', 'XMLDocument2',
  'GlideRecord', 'GlideRecordSecure', 'GlideAggregate', 'GlideAjax', 'GlideDateTime', 'GlideDate', 'GlideTime', 'GlideDuration',
  'GlideSystem', 'GlideElement', 'GlideUser', 'GlideSession', 'GlideForm', 'GlideList2', 'GlideFilter', 'GlideEmailOutbound',
  'GlideScriptableInputStream', 'GlideStringUtil', 'GlideSysAttachment', 'GlideTableHierarchy', 'GlideSchedule',
  'GlideEvaluator', 'GlideScopedEvaluator', 'GlideModal', 'GlideDialogWindow', 'GlideOverlay', 'GlideMultipleUpdate',
  'GlideImpersonate', 'GlideLocale', 'GlideCalendarDateTime', 'GlideQuery', 'RESTMessageV2', 'SOAPMessageV2',
  'RESTAPIRequest', 'RESTAPIResponse', 'AbstractAjaxProcessor', 'ArrayUtil', 'JSUtil', 'GlideappCalculationHelper',
  'NOW', 'CustomEvent', 'Event', 'Element', 'Node', 'Ajax', 'ScopedGlideRecord', 'TemplatePrinter',
]);

const isPlatformName = (name) => JS_GLOBALS.has(name) || Boolean(getApi(name, 'server') || getApi(name, 'client'));

/**
 * Script Includes a script probably calls: `new Foo(`, `new global.Foo(`, `Foo.bar(` and
 * `new GlideAjax('Foo')`. Platform APIs and JS built-ins are left out.
 * @returns {string[]} bare names, sorted
 */
export function findScriptIncludeRefs(source) {
  const { code, noComments } = scanScript(source);
  const names = new Set();
  const add = (raw) => {
    const name = String(raw || '').split('.').pop();
    if (name && /^[A-Za-z_$][\w$]*$/.test(name) && !isPlatformName(name)) names.add(name);
  };
  let m;
  const newRe = /\bnew\s+(?:[a-z][\w]*\.)?([A-Z][\w$]*)\s*\(/g;
  while ((m = newRe.exec(code))) add(m[1]);
  const staticRe = /(?<![.\w$])(?:[a-z][\w]*\.)?([A-Z][\w$]*)\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g;
  while ((m = staticRe.exec(code))) add(m[1]);
  const ajaxRe = /\bnew\s+GlideAjax\s*\(\s*(['"])([\w.$]+)\1/g;
  while ((m = ajaxRe.exec(noComments))) add(m[2]);
  return [...names].sort();
}

/** Custom tables (u_*, x_*) opened with GlideRecord/GlideAggregate. */
export function findCustomTableRefs(source) {
  const { noComments } = scanScript(source);
  const names = new Set();
  const re = /\bnew\s+(?:GlideRecord|GlideRecordSecure|GlideAggregate)\s*\(\s*(['"])((?:u|x)_[a-z0-9_]+)\1/gi;
  let m;
  while ((m = re.exec(noComments))) names.add(m[2].toLowerCase());
  return [...names].sort();
}

/**
 * Analyse every script field of one update entry.
 * @param {{sys_id: string, name: string, target_name?: string, type?: string}} entry
 * @param {string} payloadXml
 * @returns {Array<{entrySysId, entryName, targetName, table, field, kind, lines, findings, syntaxError, high, sysIds, scriptIncludes, tables}>}
 */
export function analyseEntryScripts(entry, payloadXml) {
  const parsed = parseUpdatePayload(payloadXml);
  return extractScripts(parsed, tableForEntry(entry)).map(({ table, field, code, fields }) => {
    const kind = scriptKind(table, field, fields);
    const scope = String(fields.sys_scope || '');
    const scoped = Boolean(scope) && scope !== 'global';
    let findings;
    if (kind) {
      findings = verifyScript({
        code,
        kind,
        when: fields.when || '',
        clientType: fields.type || '',
        table: fields.collection || fields.table || '',
        scoped,
        esLevel: scoped ? 'es12' : 'es5',
      }).findings;
    } else {
      findings = lintScript(code, { table, when: fields.when || '' });
    }
    return {
      entrySysId: entry.sys_id,
      entryName: entry.name,
      targetName: entry.target_name || fields.name || entry.name,
      table,
      field,
      kind,
      lines: code.split('\n').length,
      findings,
      syntaxError: findings.some((f) => f.ruleId === 'syntax-error'),
      high: findings.filter((f) => f.severity === 'high').length,
      sysIds: findHardcodedSysIds(code),
      scriptIncludes: field === 'condition' ? [] : findScriptIncludeRefs(code),
      tables: findCustomTableRefs(code),
    };
  });
}

// ---- risk classification -------------------------------------------------------------------

export const RISKY_KINDS = [
  { id: 'acl', label: 'ACL', plural: 'ACLs', tables: ['sys_security_acl', 'sys_security_acl_role'], type: /access control|\bacl\b/i, why: 'Changes who can read or write data. Test with a non-admin user after deploying.' },
  { id: 'role', label: 'role', plural: 'roles', tables: ['sys_user_role', 'sys_user_role_contains', 'sys_user_role_lookup'], type: /\brole\b/i, why: 'Changes what users are allowed to do.' },
  { id: 'property', label: 'system property', plural: 'system properties', tables: ['sys_properties'], type: /system propert/i, why: 'Values often differ per environment; this set will overwrite the target value.' },
  { id: 'dictionary', label: 'dictionary change', plural: 'dictionary / schema changes', tables: ['sys_dictionary', 'sys_db_object', 'sys_dictionary_override'], type: /dictionary|^table$/i, why: 'Schema changes can be slow on large tables and are hard to back out.' },
];

export function riskyKind(entry) {
  const table = tableForEntry(entry);
  const type = String(entry?.type || '').trim();
  return RISKY_KINDS.find((k) => (table && k.tables.includes(table)) || k.type.test(type)) || null;
}

const refValue = (v) => (v && typeof v === 'object' ? v.value || '' : String(v ?? ''));

// ---- checklist -------------------------------------------------------------------------------

const label = (entry) => entry.target_name || entry.name;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

/**
 * Pre-commit checklist for one update set.
 * @param {object} input
 *   set: { sys_id, name, state, application, applicationName, isDefault, description }
 *   entries: sys_update_xml rows (sys_id, name, type, target_name, action, application, sys_updated_on, sys_updated_by)
 *   totalEntries: number|null, entryLimit: number
 *   collisions: findCollisions() collisions, collisionsTruncated: boolean
 *   scripts: analyseEntryScripts() results (flattened), scriptsSkipped: number
 *   dependencies: Array<{kind: 'script_include'|'table', name, calledFrom: string[], otherSets: Array<{name, state}>}>
 *   errors: Array<{step, message}>
 * @returns {{verdict: 'ready'|'warnings'|'blockers', counts: object, checks: object[]}}
 */
export function buildShipChecklist(input) {
  const { set = {}, entries = [], totalEntries = null, entryLimit = 500, collisions = [], collisionsTruncated = false, scripts = [], scriptsSkipped = 0, dependencies = [], errors = [] } = input || {};
  const checks = [];
  const add = (check) => checks.push({ items: [], ...check });
  const total = totalEntries ?? entries.length;

  // Empty / Default / state
  if (total === 0) {
    add({ id: 'empty', status: 'block', title: 'The update set is empty', detail: 'There is nothing to ship.' });
  }
  // Only the instance's is_default flag makes this a blocker; a name like "Default priority fixes"
  // is a note. `defaultFlag` is 'true' | 'false' | null (not readable); older callers pass isDefault.
  const defaultFlag = 'defaultFlag' in set ? set.defaultFlag : set.isDefault === true ? 'true' : null;
  if (defaultFlag === 'true') {
    add({
      id: 'default',
      status: 'block',
      title: 'This is a Default update set',
      detail: 'Default sets collect stray changes and are not meant to be shipped. Move the changes you want into a named update set.',
    });
  } else if (isDefaultUpdateSet(set.name)) {
    add({
      id: 'default-name',
      status: 'info',
      title: 'Named like a Default update set',
      detail:
        defaultFlag === null
          ? 'Its "Default set" flag could not be read, so it is not treated as one. Check it is not the catch-all Default set before shipping.'
          : 'Its "Default set" flag is off, so it is an ordinary named set.',
    });
  }
  if (set.state && set.state !== 'in progress') {
    add({ id: 'state', status: 'info', title: `State is "${set.state}"`, detail: set.state === 'complete' ? 'Already marked complete; changes made now go to another set.' : '' });
  }

  // Truncation and failed steps: an incomplete check never reads "Ready".
  if (total > entries.length) {
    add({ id: 'truncated', status: 'warn', title: `Only the first ${entries.length} of ${total} entries were checked`, detail: `Checks are capped at ${entryLimit} entries.` });
  }
  if (collisionsTruncated) {
    add({
      id: 'collisions-truncated',
      status: 'warn',
      title: 'The collision check is incomplete',
      detail: typeof collisionsTruncated === 'string' ? `${collisionsTruncated.charAt(0).toUpperCase()}${collisionsTruncated.slice(1)}.` : 'Not every entry could be checked.',
    });
  }
  if (errors.length) {
    add({
      id: 'errors',
      status: 'warn',
      title: `${plural(errors.length, 'check')} could not run`,
      detail: 'The verdict below does not include them.',
      items: errors.map((e) => ({ label: e.step, detail: e.message })),
    });
  }

  // Collisions: overlaps with in-progress sets are warnings; with complete (finished, not yet
  // committed elsewhere as far as this instance knows) sets they are notes.
  const describeOthers = (others) => others.map((o) => `"${o.updateSetName}" (${o.updateSetState}, ${o.updatedBy || '?'})`).join(', ');
  const open = collisions
    .map((c) => ({ ...c, others: c.conflictsWith.filter((o) => o.updateSetState === 'in progress') }))
    .filter((c) => c.others.length);
  const finished = collisions
    .map((c) => ({ ...c, others: c.conflictsWith.filter((o) => o.updateSetState !== 'in progress') }))
    .filter((c) => c.others.length && !open.some((x) => x.name === c.name));
  if (open.length) {
    const newer = open.filter((c) => c.others.some((o) => String(o.updatedOn || '') > String(c.updatedOn || '')));
    add({
      id: 'collisions',
      status: 'warn',
      title: `${plural(open.length, 'entry', 'entries')} also in other in-progress update sets`,
      detail: newer.length
        ? `${newer.length} of them have a newer version elsewhere. Whichever set is committed last wins.`
        : 'Whichever set is committed last wins. Agree the commit order or merge the sets.',
      items: open.map((c) => ({
        label: c.targetName || c.name,
        detail: `${c.type || ''} - also in ${describeOthers(c.conflictsWith)}`,
        tone: newer.includes(c) ? 'high' : 'medium',
      })),
    });
  } else if (entries.length) {
    add({ id: 'collisions', status: 'ok', title: 'No overlap with other in-progress update sets', detail: '' });
  }
  if (finished.length) {
    add({
      id: 'collisions-complete',
      status: 'info',
      title: `${plural(finished.length, 'entry', 'entries')} also in completed update sets`,
      detail: 'Those sets are finished. If this set is committed after them on a target, its version wins there.',
      items: finished.map((c) => ({ label: c.targetName || c.name, detail: `${c.type || ''} - also in ${describeOthers(c.others)}` })),
    });
  }

  // Scope
  const setApp = refValue(set.application);
  if (setApp) {
    const foreign = entries.filter((e) => refValue(e.application) && refValue(e.application) !== setApp);
    if (foreign.length) {
      add({
        id: 'scope',
        status: 'warn',
        title: `${plural(foreign.length, 'entry', 'entries')} from another application scope`,
        detail: `The set belongs to ${set.applicationName || setApp}. Mixed scopes usually fail preview on the target.`,
        items: foreign.map((e) => ({ label: label(e), detail: `${e.type || ''} - scope ${e['application.name'] || refValue(e.application)}`, entrySysId: e.sys_id, path: recordPathForEntry(e) })),
      });
    } else if (entries.length) {
      add({ id: 'scope', status: 'ok', title: 'All entries match the set’s scope', detail: '' });
    }
  }

  // Deletes
  const deletes = entries.filter((e) => String(e.action || '').toUpperCase() === 'DELETE');
  if (deletes.length) {
    add({
      id: 'deletes',
      status: 'warn',
      title: `${plural(deletes.length, 'deletion')}`,
      detail: 'Committing deletes these records on the target. Check each one is intended.',
      items: deletes.map((e) => ({ label: label(e), detail: e.type || '', entrySysId: e.sys_id, tone: 'high' })),
    });
  }

  // Risky types
  RISKY_KINDS.forEach((kind) => {
    const hits = entries.filter((e) => riskyKind(e)?.id === kind.id);
    if (!hits.length) return;
    add({
      id: `risky-${kind.id}`,
      status: 'warn',
      title: `${hits.length} ${hits.length === 1 ? kind.label : kind.plural}`,
      detail: kind.why,
      items: hits.map((e) => ({ label: label(e), detail: `${e.type || ''}${String(e.action).toUpperCase() === 'DELETE' ? ' (delete)' : ''}`, entrySysId: e.sys_id, path: recordPathForEntry(e) })),
    });
  });

  // Scripts
  if (scripts.length || scriptsSkipped) {
    const broken = scripts.filter((s) => s.syntaxError);
    const serious = scripts.filter((s) => !s.syntaxError && s.high > 0);
    const detail = `${plural(scripts.length, 'script')} analysed${scriptsSkipped ? `, ${scriptsSkipped} record(s) skipped (cap)` : ''}.`;
    if (scriptsSkipped) {
      // Records with scripts that were not analysed: the script check is incomplete.
      const checked = input.scriptRecordsChecked ?? new Set(scripts.map((s) => s.entrySysId)).size;
      add({
        id: 'scripts-partial',
        status: 'warn',
        title: `${checked} of ${checked + scriptsSkipped} script records checked`,
        detail: 'The rest were not analysed (cap). Review them by hand or ship a smaller set.',
      });
    }
    if (broken.length) {
      add({
        id: 'scripts-syntax',
        status: 'block',
        title: `${plural(broken.length, 'script')} with syntax errors`,
        detail: 'These fail at run time on the target.',
        items: broken.map((s) => scriptItem(s, (f) => f.ruleId === 'syntax-error')),
      });
    }
    if (serious.length) {
      add({
        id: 'scripts-high',
        status: 'warn',
        title: `${plural(serious.length, 'script')} with serious findings`,
        detail,
        items: serious.map((s) => scriptItem(s, (f) => f.severity === 'high')),
      });
    }
    if (!broken.length && !serious.length) {
      const minor = scripts.reduce((n, s) => n + s.findings.length, 0);
      add({
        id: 'scripts',
        status: scriptsSkipped ? 'info' : 'ok',
        title: scriptsSkipped ? 'No problems in the scripts checked' : 'Scripts pass the checks',
        detail: `${detail}${minor ? ` ${plural(minor, 'minor note')}.` : ''}`,
      });
    }
  }

  // Hard-coded sys_ids
  const shippedIds = new Set(entries.map((e) => parseUpdateName(e.name).sysId).filter(Boolean));
  const withIds = scripts.filter((s) => s.sysIds.length);
  if (withIds.length) {
    const unshipped = withIds.filter((s) => s.sysIds.some((x) => !shippedIds.has(x.sysId)));
    add({
      id: 'sysids',
      status: unshipped.length ? 'warn' : 'info',
      title: `Hard-coded sys_ids in ${plural(withIds.length, 'script')}`,
      detail: unshipped.length
        ? 'A sys_id only matches on the target if that record was created there by an update set or clone. Prefer a property or a lookup by name.'
        : 'Every referenced sys_id ships in this set.',
      items: withIds.map((s) => ({
        label: `${s.targetName} (${s.field})`,
        detail: s.sysIds
          .slice(0, 6)
          .map((x) => `line ${x.line}: ${x.sysId}${shippedIds.has(x.sysId) ? ' (in this set)' : ''}`)
          .join('; '),
        entrySysId: s.entrySysId,
      })),
    });
  }

  // Cross-set dependencies
  const pending = dependencies.filter((d) => d.otherSets?.length);
  if (pending.length) {
    add({
      id: 'dependencies',
      status: 'warn',
      title: `${plural(pending.length, 'dependency', 'dependencies')} with unshipped changes in other sets`,
      detail: 'Scripts here call something whose latest change sits in another open update set. Ship that set first or together.',
      items: pending.map((d) => ({
        label: `${d.kind === 'table' ? 'Table' : 'Script Include'} ${d.name}`,
        detail: `used by ${d.calledFrom.slice(0, 3).join(', ')}${d.calledFrom.length > 3 ? '...' : ''} - changed in ${d.otherSets.map((s) => `"${s.name}" (${s.state || 'open'})`).join(', ')}`,
      })),
    });
  }

  if (!String(set.description || '').trim() && total > 0) {
    add({ id: 'description', status: 'info', title: 'No description', detail: 'Add one so whoever commits this set knows what it does.' });
  }

  const counts = {
    block: checks.filter((c) => c.status === 'block').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    info: checks.filter((c) => c.status === 'info').length,
    ok: checks.filter((c) => c.status === 'ok').length,
    entries: total,
    scripts: scripts.length,
  };
  const verdict = counts.block ? 'blockers' : counts.warn ? 'warnings' : 'ready';
  const order = { block: 0, warn: 1, info: 2, ok: 3 };
  checks.sort((a, b) => order[a.status] - order[b.status]);
  return { verdict, counts, checks };
}

function scriptItem(script, pick) {
  const hits = script.findings.filter(pick);
  return {
    label: `${script.targetName} (${script.field})`,
    detail: hits
      .slice(0, 4)
      .map((f) => `line ${f.line}: ${f.message}`)
      .join(' | '),
    entrySysId: script.entrySysId,
    tone: 'high',
  };
}

export const VERDICT_TEXT = {
  ready: 'Ready to commit',
  warnings: 'Check the warnings',
  blockers: 'Not ready: fix the blockers',
};

// ---- release notes and export -----------------------------------------------------------

const mdText = (s) => String(s ?? '').replace(/([\\`*_[\]<>])/g, '\\$1').replace(/\s+/g, ' ').trim();

/** Markdown release notes grouped by type, deletions marked. */
export function buildReleaseNotes({ set = {}, entries = [], total = null }) {
  const lines = [`# ${mdText(set.name || 'Update set')}`, ''];
  if (String(set.description || '').trim()) lines.push(String(set.description).trim(), '');
  const all = Number.isFinite(total) && total > entries.length ? total : entries.length;
  const meta = [all > entries.length ? `${entries.length} of ${all} changes listed` : `${all} change${all === 1 ? '' : 's'}`];
  if (set.applicationName) meta.push(`application: ${mdText(set.applicationName)}`);
  if (set.state) meta.push(`state: ${mdText(set.state)}`);
  lines.push(`_${meta.join(' · ')}_`, '');

  const groups = new Map();
  entries.forEach((e) => {
    const type = String(e.type || '').trim() || 'Other';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(e);
  });
  [...groups.keys()]
    .sort((a, b) => a.localeCompare(b))
    .forEach((type) => {
      const rows = groups.get(type);
      lines.push(`## ${mdText(type)} (${rows.length})`);
      rows
        .map((e) => ({ name: label(e), deleted: String(e.action || '').toUpperCase() === 'DELETE' }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .forEach((r) => lines.push(`- ${mdText(r.name)}${r.deleted ? ' **(deleted)**' : ''}`));
      lines.push('');
    });
  if (!entries.length && !all) lines.push('No changes.', '');
  if (all > entries.length) lines.push(`_${all - entries.length} more change${all - entries.length === 1 ? ' is' : 's are'} not listed (cap)._`, '');
  return lines.join('\n');
}

const STATUS_MARK = { block: 'BLOCKER', warn: 'WARNING', info: 'NOTE', ok: 'OK' };

/** Full ship-check report: verdict, checklist, release notes. */
export function shipCheckToMarkdown({ set = {}, checklist, releaseNotes, host = '' }) {
  const lines = [`# Ship check: ${mdText(set.name)}`, ''];
  if (host) lines.push(`Instance: ${mdText(host)}  `);
  lines.push(`Verdict: **${VERDICT_TEXT[checklist.verdict]}**  `, `Generated: ${new Date().toISOString()}`, '', '## Checklist', '');
  checklist.checks.forEach((c) => {
    lines.push(`- **${STATUS_MARK[c.status]}** ${mdText(c.title)}${c.detail ? ` - ${mdText(c.detail)}` : ''}`);
    c.items.slice(0, 50).forEach((it) => lines.push(`  - ${mdText(it.label)}${it.detail ? `: ${mdText(it.detail)}` : ''}`));
    if (c.items.length > 50) lines.push(`  - ... ${c.items.length - 50} more`);
  });
  lines.push('', '---', '', releaseNotes || '');
  return lines.join('\n');
}

/** Redacted prompt for "Ask AI to summarize". */
export function buildShipCheckPrompt({ set = {}, checklist, releaseNotes }) {
  const findings = checklist.checks
    .filter((c) => c.status !== 'ok')
    .map((c) => {
      const items = c.items
        .slice(0, 8)
        .map((it) => `  - ${it.label}${it.detail ? `: ${it.detail}` : ''}`)
        .join('\n');
      return `- [${STATUS_MARK[c.status]}] ${c.title}${c.detail ? ` (${c.detail})` : ''}${items ? `\n${items}` : ''}`;
    })
    .join('\n');
  const prompt = [
    'You are reviewing a ServiceNow update set before it is committed and promoted.',
    'Write: (1) a short plain-English summary of what the set changes, for release notes;',
    '(2) the real deployment risks, most serious first, using the checklist below;',
    '(3) what to test on the target after committing. Be concise and concrete.',
    '',
    `Update set: ${set.name || ''} (state: ${set.state || '?'}, application: ${set.applicationName || '?'})`,
    `Automatic verdict: ${VERDICT_TEXT[checklist.verdict]}`,
    '',
    '## Checklist findings',
    findings || 'None.',
    '',
    '## Contents',
    String(releaseNotes || '').slice(0, 8000),
  ].join('\n');
  return redactSecrets(prompt);
}

// ---- moving entries --------------------------------------------------------------------------

/**
 * Which entries can move into `target`. Blocks a move into a set that is not in
 * progress, into a Default set, or across application scopes.
 * @returns {{moves: object[], skipped: Array<{entry, reason}>, blocked: Array<{entry, reason}>}}
 */
export function planMove({ entries = [], target, targetNames = [] }) {
  const moves = [];
  const skipped = [];
  const blocked = [];
  const warnings = [];
  if (!target) return { moves, skipped, warnings, blocked: entries.map((entry) => ({ entry, reason: 'Pick an update set to move to.' })) };
  const targetApp = refValue(target.application);
  const inTarget = new Set(targetNames);
  const defaultFlag = target.is_default === undefined || target.is_default === null || target.is_default === '' ? null : String(target.is_default);
  // Only the instance's flag blocks; a name like "Default priority fixes" is just a warning.
  if (defaultFlag !== 'true' && isDefaultUpdateSet(target.name)) {
    warnings.push(
      defaultFlag === null
        ? `"${target.name}" is named like a Default set and its Default flag could not be read. Make sure it is not the catch-all Default set.`
        : `"${target.name}" is named like a Default set, but it is an ordinary named set.`
    );
  }
  entries.forEach((entry) => {
    const sourceState = String(entry['update_set.state'] || '');
    if (refValue(entry.update_set) === target.sys_id) {
      skipped.push({ entry, reason: 'Already in that update set.' });
    } else if (sourceState !== 'in progress') {
      // Moving out of a complete or ignored set would change something already finished.
      const from = entry['update_set.name'] ? ` ("${entry['update_set.name']}")` : '';
      blocked.push({ entry, reason: `It sits in ${sourceState ? `a set that is ${sourceState}` : 'a set whose state could not be read'}${from}. Only entries of in-progress sets can be moved.` });
    } else if (target.state !== 'in progress') {
      blocked.push({ entry, reason: `"${target.name}" is ${target.state || 'not in progress'}.` });
    } else if (defaultFlag === 'true') {
      blocked.push({ entry, reason: 'Pick a named update set, not a Default one.' });
    } else if (targetApp && refValue(entry.application) && refValue(entry.application) !== targetApp) {
      blocked.push({ entry, reason: 'The entry belongs to a different application scope than that set.' });
    } else if (inTarget.has(entry.name)) {
      // Two versions of one record in a set: which one wins on commit is not something to leave to chance.
      skipped.push({ entry, reason: `"${target.name}" already holds a version of this record. Moving it would leave two; merge them by hand.` });
    } else {
      moves.push(entry);
    }
  });
  return { moves, skipped, blocked, warnings };
}

export { confirmMatches } from './pushArtifact.js';

// ---- My work helpers ------------------------------------------------------------------------

/**
 * The "current" entry of a concoursepicker GET response. The shape is unverified,
 * so several plausible layouts are accepted.
 * @returns {{sysId: string, name: string}|null}
 */
export function parsePickerCurrent(data) {
  const result = data?.result ?? data;
  if (!result || typeof result !== 'object') return null;
  // Current releases (seen on Australia): `current` is just the id and `list` holds every choice with its name.
  if (typeof result.current === 'string' && Array.isArray(result.list)) {
    const hit = result.list.find((entry) => entry && (entry.sysId || entry.sys_id || entry.value || entry.id) === result.current);
    const name = hit && (hit.name || hit.displayValue || hit.display_value || hit.label);
    if (name && (SYS_ID_RE.test(result.current) || result.current === 'global')) return { sysId: result.current, name: String(name) };
  }
  const candidates = [result.current, result.currentUpdateSet, result.current_update_set, result.currentApplication, result.current_app, result.selected, result];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const sysId = c.sysId || c.sys_id || c.value || c.id || '';
    const name = c.name || c.displayValue || c.display_value || c.label || '';
    if ((SYS_ID_RE.test(sysId) || sysId === 'global') && name) return { sysId, name: String(name) };
  }
  return null;
}

/**
 * Aggregate API (sysparm_group_by) result -> Map(groupValue -> {count, max}).
 * Handles one group (object) or many (array).
 */
export function parseGroupedStats(data, field) {
  const map = new Map();
  const rows = Array.isArray(data?.result) ? data.result : data?.result ? [data.result] : [];
  rows.forEach((row) => {
    const group = (row.groupby_fields || []).find((g) => g.field === field);
    if (!group) return;
    const count = Number(row.stats?.count);
    map.set(group.value, { count: Number.isFinite(count) ? count : 0, max: row.stats?.max || {} });
  });
  return map;
}

/**
 * Whether a set is a Default set: the instance's is_default flag when it is readable, the name
 * ("Default", "Default [Global]") only when it is not.
 */
export function isDefaultSet(flag, name) {
  if (flag === true || String(flag) === 'true') return true;
  if (flag === false || String(flag) === 'false') return false;
  return isDefaultUpdateSet(name);
}

/** Recent changes (newest first) grouped by update set, in order of each set's newest change. */
export function groupChangesBySet(changes = []) {
  const groups = new Map();
  changes.forEach((c) => {
    const id = refValue(c.update_set) || '(none)';
    if (!groups.has(id)) {
      groups.set(id, {
        setId: id,
        setName: c['update_set.name'] || '(no update set)',
        setState: c['update_set.state'] || '',
        isDefault: isDefaultSet(c['update_set.is_default'], c['update_set.name']),
        changes: [],
      });
    }
    groups.get(id).changes.push(c);
  });
  return [...groups.values()];
}

/** Warnings for the My work panel. */
export function myWorkWarnings({ changes = [], currentSet = null, currentApp = null }) {
  const defaultChanges = changes.filter(
    (c) => isDefaultSet(c['update_set.is_default'], c['update_set.name']) && c['update_set.state'] === 'in progress'
  );
  const scopeMismatches = changes.filter((c) => {
    const entryApp = refValue(c.application);
    const setApp = refValue(c['update_set.application']);
    return entryApp && setApp && entryApp !== setApp;
  });
  const setApp = refValue(currentSet?.application);
  const currentMismatch = Boolean(setApp && currentApp?.sysId && setApp !== currentApp.sysId);
  return {
    defaultChanges,
    scopeMismatches,
    currentIsDefault: Boolean(currentSet && ('isDefault' in currentSet ? currentSet.isDefault : isDefaultUpdateSet(currentSet.name))),
    currentMismatch,
  };
}

/** "3 min ago" style text from a ServiceNow "YYYY-MM-DD HH:mm:ss" (UTC) value. */
export function timeAgo(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return '';
  const t = Date.parse(`${text.replace(' ', 'T')}Z`);
  if (!Number.isFinite(t)) return text;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} days ago`;
  return text.slice(0, 10);
}

/**
 * A name for a new update set: trimmed, 3 to 80 characters, not "Default" (which would only create a second set that
 * the platform and this extension both treat as the throwaway one). `taken` are the names of in-progress sets.
 * Returns { ok: true, name } or { ok: false, error }.
 */
export function validateNewUpdateSetName(raw, taken = []) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 3) return { ok: false, error: 'Give the update set a name of at least 3 characters, for example "STRY0012345 Fix caller lookup".' };
  if (name.length > 80) return { ok: false, error: 'Keep the name to 80 characters or fewer.' };
  // Only the catch-all names: "Default value fix" is a fine name for real work.
  if (/^default(\s*\[[^\]]*\])?$/i.test(name)) return { ok: false, error: '"Default" is the update set to avoid. Pick a name that says what the work is.' };
  const clash = taken.find((t) => String(t || '').trim().toLowerCase() === name.toLowerCase());
  if (clash) return { ok: false, error: `An update set named "${clash}" is already in progress. Switch to it instead.` };
  return { ok: true, name };
}
