// Page-side implementations of the agent's tools (schemas in
// src/lib/agent/toolSchemas.js). The same executor serves the sidebar agent and
// calls arriving from an external MCP client, so every safety check lives here:
// table allow-lists, query sanitising, verification gates, audit and undo.
import { getToolSchema, toolTier } from '../lib/agent/toolSchemas.js';
import { getSkill, selectSkills } from '../lib/skills/index.js';
import { lookupApi } from '../lib/apiCatalog/index.js';
import { verifyScript, formatVerification, kindForTable, KIND_INFO } from '../lib/verify.js';
import { describeRun } from '../lib/mockForm.js';
import { closest } from '../lib/apiCatalog/index.js';
import { analyzeScriptRisk, formatRiskSummary, DRY_RUN_TAMPER_MARK } from '../lib/scriptSafety.js';
import { isSecretName, redactSecrets } from '../providers/redact.js';
import { isGuardedEnv } from '../lib/agent/policy.js';
import { resolveGuardrails, deniedTableBlock, nonAdminBlock, liveChangeNote, activeEditBlock, updateSetCard, createStalePins, RECORD_CHANGING_TOOLS, LIVE_INACTIVE_NOTE } from '../lib/agent/guardrails.js';
import { parseSteps } from '../lib/automation.js';
import { assertNoInlineScript } from '../lib/queryGuard.js';
import { parseEncodedQuery } from '../lib/query.js';
import { createControlTools } from './controlTools.js';
import { hashText, placeholderProblem, placeholderProblemIn, isCodeColumn } from '../lib/agent/control.js';

const TABLE_RE = /^[a-z][a-z0-9_]*$/i;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const MAX_ROWS = 50;
const MAX_CELL = 600;
const MAX_SCRIPT_CHARS = 14000;
const SCHEMA_TTL_MS = 5 * 60 * 1000;

// Tables the agent may never read through query_table, whatever the user's ACLs allow.
const DENIED_TABLE_RE = /(password|credential|secret|private_?key|certificate|oauth_(entity|credential)|sys_auth|keystore|_key$)/i;

// Configuration tables the agent may create or edit, and the only ones.
const WRITABLE_ARTIFACTS = new Set(['sys_script_client', 'sys_script', 'sys_script_include', 'sys_ui_policy', 'sys_ui_policy_action', 'catalog_script_client']);
const PROTECTED_FIELDS = new Set(['sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by', 'sys_mod_count', 'sys_class_name']);

const ARTIFACTS = {
  sys_script: { name: 'name', fields: ['name', 'collection', 'when', 'order', 'active', 'advanced', 'filter_condition', 'condition', 'script', 'action_insert', 'action_update', 'action_delete', 'action_query', 'description', 'sys_scope'] },
  sys_script_include: { name: 'name', fields: ['name', 'api_name', 'client_callable', 'active', 'access', 'script', 'description', 'sys_scope'] },
  sys_script_client: { name: 'name', fields: ['name', 'table', 'type', 'field', 'active', 'script', 'ui_type', 'global', 'description', 'sys_scope'] },
  catalog_script_client: { name: 'name', fields: ['name', 'cat_item', 'type', 'applies_to', 'script', 'active', 'ui_type', 'sys_scope'] },
  sys_ui_policy: { name: 'short_description', fields: ['short_description', 'table', 'active', 'conditions', 'on_load', 'run_scripts', 'script_true', 'script_false', 'global', 'reverse_if_false', 'sys_scope'] },
  sys_ui_policy_action: { name: 'ui_policy', fields: ['ui_policy', 'field', 'visible', 'mandatory', 'disabled', 'cleared'] },
  sys_ui_action: { name: 'name', fields: ['name', 'table', 'action_name', 'client', 'onclick', 'script', 'condition', 'active', 'form_button', 'list_button'] },
  sys_security_acl: { name: 'name', fields: ['name', 'operation', 'type', 'active', 'script', 'condition', 'admin_overrides'] },
  sysauto_script: { name: 'name', fields: ['name', 'run_type', 'active', 'script'] },
  sys_ws_operation: { name: 'name', fields: ['name', 'http_method', 'operation_uri', 'operation_script', 'active', 'requires_authentication', 'requires_acl_authorization'] },
  sys_ui_script: { name: 'name', fields: ['name', 'script', 'active', 'global', 'ui_type'] },
};

const SCRIPT_FIELD_RE = /^(script|operation_script|script_true|script_false|condition|filter_condition)$/;

const clip = (value, n = MAX_CELL) => {
  const s = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return s.length > n ? `${s.slice(0, n)}...` : s;
};

function assertTable(table) {
  if (!TABLE_RE.test(table || '')) throw new Error(`"${table}" is not a valid table name.`);
  return table;
}

// An encoded query can carry server-side JavaScript ("javascript:..."); never forward one.
function assertSafeQuery(query) {
  const q = String(query || '');
  if (/javascript\s*:/i.test(q) || /(^|[^a-z0-9_])gs\./i.test(q)) throw new Error('Queries may not contain script. Use plain encoded query conditions.');
  if (q.length > 2000) throw new Error('Query is too long.');
  return q;
}

// Name/value tables where the row's name (or type) says whether its value is a secret.
const SECRET_ROW_COLUMNS = { sys_properties: ['name', 'type'], sys_user_preference: ['name'] };
// A form field whose value must not leave the page: by name, or by dictionary type (password, password2).
const SECRET_FIELD_NAME_RE = /(password|passwd|secret|token|credential|private_?key|api_?key)/i;
const isSecretField = (name, type) => SECRET_FIELD_NAME_RE.test(String(name || '')) || /^password/i.test(String(type || ''));

/** A copy of a field description with its value keys hidden when the field holds a secret. */
function hideSecretField(field, type, valueKeys) {
  if (!field || !isSecretField(field.name, type)) return field;
  const out = { ...field };
  for (const k of valueKeys) if (out[k] !== undefined && out[k] !== null && out[k] !== '') out[k] = '[hidden]';
  return out;
}

/**
 * Every piece of code a save_artifact write carries, with the verifier kind to check it as: the script columns,
 * a business rule `condition` (a server expression), and each javascript: value inside an encoded-query condition
 * (filter_condition, conditions).
 * @returns {Array<{field: string, code: string, kind: string, expression?: boolean}>}
 */
export function artifactCodeChecks(fields = {}, kind = null) {
  const out = [];
  for (const k of ['script', 'operation_script', 'script_true', 'script_false']) {
    if (kind && typeof fields[k] === 'string' && fields[k].trim()) out.push({ field: k, code: fields[k], kind });
  }
  if (typeof fields.condition === 'string' && fields.condition.trim()) {
    out.push({ field: 'condition', code: fields.condition, kind: kind && kind !== 'client_script' ? kind : 'background_script', expression: true });
  }
  for (const k of ['filter_condition', 'conditions']) {
    if (typeof fields[k] !== 'string') continue;
    [...fields[k].matchAll(/javascript\s*:\s*([^^]*)/gi)]
      .map((m) => m[1].trim())
      .filter(Boolean)
      .forEach((code, i) => out.push({ field: `${k} (javascript value ${i + 1})`, code, kind: 'background_script', expression: true }));
  }
  return out;
}

function requireArgs(name, args) {
  const schema = getToolSchema(name);
  if (!schema) throw new Error(`Unknown tool "${name}".`);
  for (const key of schema.inputSchema.required || []) {
    // An empty string is a real value (clearing a field); only a missing argument is an error.
    if (args?.[key] === undefined || args?.[key] === null) throw new Error(`${name} needs "${key}".`);
  }
}

/**
 * @param {object} deps injected so this module has no hidden globals
 */
export function createAgentTools(deps) {
  const {
    getContext,
    getInstanceInfo,
    callPage,
    queryTable,
    fetchRecord,
    countRecords,
    createRecord,
    updateRecord,
    deleteRecord,
    fetchTableFields,
    tableHierarchy,
    searchCode,
    fetchLogs,
    runBackgroundScript,
    getCsrfToken,
    wrapAsDryRun,
    extractScriptOutput,
    runSandbox,
    runAutomation,
    subscribeAutomation,
    getCurrentUpdateSet,
    recordUrl,
    audit,
    control,
    getSettings = async () => ({}),
    saveCheckDelayMs = 750,
    atfPollMs,
  } = deps;

  // The user's safety settings (Options > Agent > Agent safety), read fresh on every check so a change applies at once.
  async function getGuardrails() {
    let settings = {};
    try {
      settings = (await getSettings()) || {};
    } catch {
      settings = {};
    }
    return { guard: resolveGuardrails(settings) };
  }

  /** Admin / elevated security_admin of the live session. Unknown counts as "no": a restriction never fails open. */
  async function sessionNow() {
    const info = control?.session?.readSessionInfo ? await control.session.readSessionInfo().catch(() => null) : await callPage('getSessionInfo').catch(() => null);
    return { admin: info?.admin === true, securityAdmin: info?.securityAdmin === true };
  }

  /** What the approval card showed for a record, so a write refuses if the record moved on before it was approved. */
  const stalePins = createStalePins();

  /** "Updating records is turned off for your role" for a non-admin when the user turned that on, else null. */
  async function nonAdminRefusal(tool) {
    if (!RECORD_CHANGING_TOOLS.has(tool)) return null;
    const { guard } = await getGuardrails();
    if (!guard.readOnlyForNonAdmin) return null;
    return nonAdminBlock(tool, guard, await sessionNow());
  }

  const schemaCache = new Map();
  // Scripts dry-run in this session (by hash), so a real run's approval card can say whether it was tried first.
  const dryRuns = new Set();

  async function getSchema(table) {
    assertTable(table);
    const hit = schemaCache.get(table);
    if (hit && Date.now() - hit.at < SCHEMA_TTL_MS) return hit.value;
    const value = await fetchTableFields(table);
    schemaCache.set(table, { at: Date.now(), value });
    return value;
  }

  // The undo entry the approval card showed (undo_last_write executes only that one).
  let undoPin = null;

  /** Why an undo would break the write rules, or null. Record undos are checked over the record's real class chain. */
  async function undoRefusal(u) {
    if (!u) return 'nothing recorded';
    if (u.kind === 'field') return formFieldRefusal(u.table, u.field);
    let verdict = null;
    if (u.created) verdict = await controlTools.checkRecordWrite({ op: 'delete', table: u.table, sysId: u.sysId, restoring: true });
    else if (u.deleted) verdict = await controlTools.checkRecordWrite({ op: 'create', table: u.table, fields: u.snapshot || {}, restoring: true });
    else if (u.kind === 'record') verdict = await controlTools.checkRecordWrite({ op: 'update', table: u.table, sysId: u.sysId, fields: u.previous || {}, restoring: true });
    return verdict?.block || null;
  }

  /** Why set_form_field must not write this field of the open form, or null. */
  async function formFieldRefusal(table, name) {
    if (table && DENIED_TABLE_RE.test(table)) return `${table} holds credentials or keys; the agent never changes it.`;
    const listed = table ? deniedTableBlock(table, (await getGuardrails()).guard) : null;
    if (listed) return listed;
    if (SECRET_FIELD_NAME_RE.test(String(name || ''))) return `"${name}" looks like a password or secret; the agent never writes those.`;
    let type = (await fieldTypesOf(table))[name];
    if (!type) type = (await callPage('getFieldState', [name]).catch(() => null))?.type;
    if (/^password/i.test(type || '')) return `"${name}" is a password field; the agent never writes those.`;
    return null;
  }

  /** Dictionary type of every column of a table ({} when unreadable), for hiding password-typed values. */
  const fieldTypesOf = async (table) => {
    if (!table || !TABLE_RE.test(table)) return {};
    try {
      return Object.fromEntries((await getSchema(table)).fields.map((f) => [f.name, f.type || '']));
    } catch {
      return {};
    }
  };

  const fieldNamesOf = async (table) => {
    try {
      return (await getSchema(table)).fields.map((f) => f.name);
    } catch {
      return null; // unknown or unreadable table: skip field checks rather than guess
    }
  };

  // ServiceNow silently IGNORES a condition on a column that does not exist (name=x on a table with no "name"
  // returns every row), so an invented column would give the model unrelated rows it believes matched.
  const SYSTEM_COLUMNS = new Set(['sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by', 'sys_mod_count', 'sys_class_name', 'sys_domain', 'sys_domain_path', 'sys_tags']);
  async function assertKnownColumns(table, query, fields = []) {
    const parsed = parseEncodedQuery(query);
    const used = new Set([...parsed.groups.flat().map((c) => c.field), ...parsed.orderBy.map((o) => o.field), ...parsed.groupBy, ...fields]);
    if (!used.size) return;
    const known = await fieldNamesOf(table);
    if (!known) return; // unreadable dictionary: cannot judge, so do not block
    for (const column of used) {
      const root = column.split('.')[0]; // a dot-walk is validated by its first hop
      if (SYSTEM_COLUMNS.has(root) || known.includes(root)) continue;
      const near = closest(root, known);
      throw new Error(`${table} has no field "${root}"${near ? ` (did you mean "${near}"?)` : ''}. A condition on a missing field is silently ignored by ServiceNow, so this was not run. Call get_schema("${table}").`);
    }
  }

  async function syntaxFor(code) {
    try {
      const reply = await runSandbox({ action: 'syntax', code });
      if (!reply?.ok) return null;
      const error = reply.error;
      return () => (error ? { line: 1, message: error.message } : null);
    } catch {
      return null; // sandbox unavailable: the built-in scanner takes over
    }
  }

  async function runVerify(args) {
    const info = KIND_INFO[args.kind];
    const table = args.table || '';
    const fields = table ? await fieldNamesOf(table) : null;
    const syntaxCheck = await syntaxFor(args.code);
    const result = verifyScript({
      code: args.code,
      kind: args.kind,
      when: args.when,
      clientType: args.clientType,
      scoped: Boolean(args.scoped),
      table: table || (info ? '' : ''),
      fields,
      syntaxCheck: syntaxCheck || undefined,
    });
    return { result, fieldsChecked: Boolean(fields) };
  }

  function compactFindings(result, max = 25) {
    return result.findings.slice(0, max).map((f) => ({ severity: f.severity, line: f.line, rule: f.ruleId, message: f.message, fix: f.suggestion }));
  }

  const isScriptField = (name) => SCRIPT_FIELD_RE.test(name);

  // ---- tools -------------------------------------------------------------------------------

  const tools = {
    async get_skill_guide({ skill } = {}) {
      const ctx = getContext();
      const chosen = skill ? getSkill(skill) : selectSkills(ctx).primary;
      if (!chosen) throw new Error('Unknown skill. Use "client-script" or "server-script".');
      return { skill: chosen.id, title: chosen.title, guide: chosen.guide };
    },

    async get_page_context() {
      const ctx = getContext();
      const instance = getInstanceInfo();
      const { primary, reason } = selectSkills(ctx);
      let form = null;
      try {
        form = await callPage('getFormMeta');
      } catch {
        // No form on this page.
      }
      return {
        instance: { host: instance.host, environment: instance.env, label: instance.label },
        page: ctx.isList ? 'list' : form ? 'form' : 'other',
        table: ctx.table || form?.table || null,
        sysId: ctx.sysId || form?.sysId || null,
        isNewRecord: form?.isNewRecord ?? null,
        scriptField: ctx.scriptFieldLabel || null,
        hasScript: Boolean(ctx.scriptBody),
        scriptPreview: ctx.scriptBody ? clip(ctx.scriptBody, 1500) : null,
        selection: ctx.selection ? clip(ctx.selection, 500) : null,
        activeSkill: { id: primary.id, because: reason },
      };
    },

    async get_form_model() {
      const model = await callPage('getFormModel');
      if (!model) throw new Error('No form is open on this page. Open a record first.');
      // Password-typed fields are hidden even when their name looks harmless (same rule as read_page).
      const types = await fieldTypesOf(model.table);
      return { ...model, fields: (model.fields || []).map((f) => hideSecretField(f, f.type || types[f.name], ['value', 'display'])) };
    },

    async get_field_state({ name }) {
      const state = await callPage('getFieldState', [name]);
      if (!state) throw new Error('No form is open on this page.');
      const types = await fieldTypesOf(getContext().table);
      return hideSecretField(state, state.type || types[name], ['value', 'displayValue']);
    },

    async get_schema({ table }) {
      const { tables, fields } = await getSchema(table);
      return {
        table,
        hierarchy: tables,
        fieldCount: fields.length,
        // One line per field keeps a 300-field table affordable.
        fields: fields.slice(0, 600).map((f) => {
          const bits = [f.name, f.label, f.maxLength ? `${f.type}(${f.maxLength})` : f.type];
          if (f.reference) bits.push(`-> ${f.reference}`);
          const flags = [f.mandatory && 'mandatory', f.readOnly && 'read-only'].filter(Boolean);
          if (flags.length) bits.push(flags.join(','));
          return bits.join(' | ');
        }),
      };
    },

    async query_table({ table, query = '', fields = [], limit = 20, displayValue = false }) {
      assertTable(table);
      if (DENIED_TABLE_RE.test(table)) throw new Error(`Reading ${table} through the agent is not allowed.`);
      const listedTable = deniedTableBlock(table, (await getGuardrails()).guard);
      if (listedTable) throw new Error(listedTable);
      const cleanFields = (Array.isArray(fields) ? fields : []).filter((f) => /^[a-z0-9_.]+$/i.test(f)).slice(0, 25);
      const safeQuery = assertSafeQuery(query);
      await assertKnownColumns(table, safeQuery, cleanFields);
      // On name/value tables (system properties, user preferences) the name decides whether the value is a secret,
      // so name and type are always fetched for that decision and stripped again if the caller did not ask for them.
      const extra = cleanFields.length ? (SECRET_ROW_COLUMNS[table] || []).filter((c) => !cleanFields.includes(c)) : [];
      const rows = await queryTable(table, safeQuery, [...cleanFields, ...extra], { limit: Math.min(Number(limit) || 20, MAX_ROWS), displayValue: Boolean(displayValue) });
      const types = await fieldTypesOf(table);
      const plain = (v) => (typeof v === 'object' && v ? v.value ?? v.display_value ?? '' : v ?? '');
      return {
        table,
        returned: rows.length,
        note: rows.length === Math.min(Number(limit) || 20, MAX_ROWS) ? 'There may be more rows; narrow the query or raise the limit (max 50).' : undefined,
        rows: rows.map((row) => {
          const secretRow = Boolean(SECRET_ROW_COLUMNS[table]) && (isSecretName(String(plain(row.name))) || /^password/i.test(String(plain(row.type))));
          return Object.fromEntries(
            Object.entries(row)
              .filter(([k]) => !extra.includes(k))
              .map(([k, v]) => {
                const shown = typeof v === 'object' && v ? v.display_value || v.value : v;
                const hide = /^password/i.test(types[k] || '') || (secretRow && k === 'value');
                return [k, hide ? (String(plain(v)) ? '[REDACTED]' : '') : clip(shown)];
              })
          );
        }),
      };
    },

    async count_records({ table, query = '' }) {
      assertTable(table);
      if (DENIED_TABLE_RE.test(table)) throw new Error(`Reading ${table} through the agent is not allowed.`);
      const listedTable = deniedTableBlock(table, (await getGuardrails()).guard);
      if (listedTable) throw new Error(listedTable);
      const safeQuery = assertSafeQuery(query);
      await assertKnownColumns(table, safeQuery);
      return { table, query, count: await countRecords(table, safeQuery) };
    },

    async read_artifact({ table, sysId, name }) {
      const def = ARTIFACTS[table];
      if (!def) throw new Error(`read_artifact supports: ${Object.keys(ARTIFACTS).join(', ')}.`);
      let query;
      if (sysId) {
        if (!SYS_ID_RE.test(sysId)) throw new Error('sysId must be a 32-character sys_id.');
        query = `sys_id=${sysId}`;
      } else if (name) {
        if (/[\^]/.test(name)) throw new Error('Name may not contain "^".');
        assertNoInlineScript(name, 'Name');
        query = `${def.name}=${name}`;
      } else {
        throw new Error('Give a sysId or a name.');
      }
      const rows = await queryTable(table, query, ['sys_id', ...def.fields], { limit: 3 });
      if (!rows.length) return { found: false, table, hint: 'No record matched. Use query_table or search_code to find the right name.' };
      return {
        found: true,
        records: rows.map((row) => {
          const out = {};
          for (const [k, v] of Object.entries(row)) out[k] = isScriptField(k) ? clip(v, MAX_SCRIPT_CHARS) : clip(v, 400);
          out.url = recordUrl(table, row.sys_id);
          return out;
        }),
      };
    },

    async list_logic_for_table({ table, kind = 'all' }) {
      assertTable(table);
      const chain = await tableHierarchy(table).catch(() => [table]);
      const inList = chain.join(',');
      const jobs = [];
      if (kind !== 'server') {
        jobs.push(['client_scripts', 'sys_script_client', `tableIN${inList}^ORDERBYname`, ['name', 'table', 'type', 'field', 'active', 'ui_type']]);
        jobs.push(['ui_policies', 'sys_ui_policy', `tableIN${inList}^ORDERBYshort_description`, ['short_description', 'table', 'active', 'on_load', 'run_scripts', 'conditions']]);
        jobs.push(['ui_actions', 'sys_ui_action', `tableIN${inList}^client=true`, ['name', 'table', 'action_name', 'active']]);
      }
      if (kind !== 'client') {
        jobs.push(['business_rules', 'sys_script', `collectionIN${inList}^ORDERBYorder`, ['name', 'collection', 'when', 'order', 'active', 'filter_condition', 'action_insert', 'action_update', 'action_delete', 'action_query']]);
      }
      const settled = await Promise.allSettled(jobs.map(([, t, q, f]) => queryTable(t, q, f, { limit: 40 })));
      const out = { table, hierarchy: chain };
      const skipped = [];
      settled.forEach((s, i) => {
        const [key, tbl] = jobs[i];
        if (s.status === 'fulfilled') {
          out[key] = s.value.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clip(v, 160)])));
        } else {
          skipped.push({ table: tbl, reason: s.reason?.message });
        }
      });
      if (skipped.length) out.skipped = skipped;
      return out;
    },

    async search_code({ term }) {
      const found = await searchCode(term);
      return {
        term: found.term,
        totalRecords: found.totalRecords,
        results: found.results.slice(0, 25).map((r) => ({
          type: r.label,
          name: r.name,
          field: r.field,
          sysId: r.sysId,
          lines: r.matches.slice(0, 3).map((m) => `${m.lineNumber}: ${clip(m.text, 160)}`),
        })),
        skippedTables: found.errors.map((e) => e.table),
        truncated: found.results.length > 25,
      };
    },

    async read_logs({ contains = '', minutes = 60 } = {}) {
      const data = await fetchLogs({ contains, minutes: Math.min(Number(minutes) || 60, 1440) });
      return {
        minutes: data.minutes,
        totalEntries: data.total,
        groups: data.groups.slice(0, 12).map((g) => ({ count: g.count, message: clip(g.sample, 260) })),
        slowTransactions: (data.slow || []).slice(0, 5),
      };
    },

    async lookup_api({ query, side }) {
      return lookupApi(query, side).text;
    },

    async verify_script(args) {
      requireArgs('verify_script', args);
      const { result, fieldsChecked } = await runVerify(args);
      return {
        ok: result.ok,
        summary: result.summary,
        fieldNamesChecked: fieldsChecked,
        findings: compactFindings(result),
        next: result.ok ? 'No errors. Address warnings if they matter, then present the script.' : 'Fix every [high] finding and verify again before presenting this script.',
      };
    },

    async test_client_script({ code, clientType, scenario = {} }) {
      const reply = await runSandbox({ action: 'runClient', code, clientType, scenario });
      if (!reply?.ok) throw new Error(reply?.error || 'The simulator failed to start.');
      const run = reply.run;
      return {
        ok: run.ok,
        summary: describeRun(run, clientType),
        calls: run.calls,
        fieldChanges: run.fieldChanges,
        messages: run.messages,
        ajaxCalls: run.ajaxCalls,
        warnings: run.warnings.map((w) => w.message),
        finalFields: run.finalFields,
        submitAllowed: run.submitAllowed,
        note: 'This is a simulation: no real form, server or Script Include was touched. GlideAjax answers come from scenario.ajax.',
      };
    },

    async dry_run_script({ code }) {
      const { result } = await runVerify({ code, kind: 'background_script' });
      const syntax = result.findings.find((f) => f.ruleId === 'syntax-error');
      if (syntax) throw new Error(`Not run: ${syntax.message}`);
      const risk = analyzeScriptRisk(code);
      const host = getInstanceInfo().host;
      let html;
      try {
        html = await runBackgroundScript(wrapAsDryRun(code), await getCsrfToken());
      } catch (err) {
        await audit.record({ instance: host, tool: 'dry_run_script', args: { code }, ok: false, summary: `Dry run failed: ${clip(err.message, 120)}` });
        throw err;
      }
      const output = extractScriptOutput(html);
      // The wrapper checks after the run whether the script swapped out an intercepted method.
      const tampered = String(output || '').includes(DRY_RUN_TAMPER_MARK) || String(html || '').includes(DRY_RUN_TAMPER_MARK);
      // Every dry run is logged: it runs code on the instance even when nothing is written.
      await audit.record({
        instance: host,
        tool: 'dry_run_script',
        args: { code },
        ok: !tampered,
        summary: tampered ? 'Dry run TAMPERED: the script replaced an intercepted write method; real writes may have happened' : 'Dry-ran a server script',
      });
      if (!tampered) dryRuns.add(hashText(code));
      return {
        risk: formatRiskSummary(risk),
        output: clip(output, 8000) || '(no output)',
        tampered: tampered || undefined,
        note: tampered
          ? 'WARNING: the script replaced an intercepted GlideRecord method while it ran, so writes after that point may have been REAL. Tell the user and check the records it touches.'
          : 'GlideRecord writes were intercepted and logged as "[NowBuddy dry run]". Direct SQL, outbound REST, gs.setProperty and already-queued events are not intercepted.',
      };
    },

    async set_form_field({ name, value }) {
      // The model may have seen this value redacted; never write the placeholder over the real secret.
      const placeholder = placeholderProblem(name, value, { code: isScriptField(name) || isCodeColumn(name) });
      if (placeholder) throw new Error(placeholder);
      const ctx = getContext();
      const table = ctx.table;
      // Same table and field rules as record writes: never on a credential table, never a password or secret field.
      const refusal = await formFieldRefusal(table, name);
      if (refusal) throw new Error(refusal);
      let verification = null;
      if (isScriptField(name) && table && kindForTable(table)) {
        const kind = kindForTable(table);
        const { result } = await runVerify({ code: String(value), kind, table: undefined });
        verification = { ok: result.ok, summary: result.summary, findings: compactFindings(result, 10) };
      }
      const { previous } = await callPage('setFieldValue', [name, String(value)]);
      // An old value holding a secret is never stored in the audit log, so that change has no undo.
      const keepPrevious = !(typeof previous === 'string' && previous && redactSecrets(previous) !== previous);
      await audit.record({
        instance: getInstanceInfo().host,
        tool: 'set_form_field',
        args: { name, value },
        ok: true,
        summary: `Set ${name} on the open form`,
        undo: keepPrevious ? { kind: 'field', field: name, value: previous, table: ctx.table || null, sysId: ctx.sysId || null } : null,
      });
      return {
        set: name,
        previousLength: previous.length,
        saved: false,
        verification,
        note: keepPrevious ? 'The form is not saved yet.' : 'The form is not saved yet. The old value held a secret, so it was not kept and this change cannot be undone by NowBuddy.',
      };
    },

    async save_form() {
      // g_form.save() is asynchronous and can be blocked (mandatory fields, onSubmit scripts), so "I called it"
      // is not "it saved": compare the record's modification markers before and after instead.
      const { table, sysId } = getContext();
      const readState = () => (table && sysId ? fetchRecord(table, sysId, ['sys_mod_count', 'sys_updated_on']).catch(() => null) : Promise.resolve(null));
      const before = await readState();
      // Recorded first: a successful save may reload the page and tear this script down before it could log.
      await audit.record({ instance: getInstanceInfo().host, tool: 'save_form', args: {}, ok: true, summary: 'Requested a save of the open form' });
      await callPage('saveForm');
      if (!before) return { submitted: true, saved: null, note: 'Save was requested, but this record cannot be checked (new or unidentified record). Look at the form to confirm.' };
      for (let attempt = 0; attempt < 8; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- a short, bounded wait for the server to apply the save
        await new Promise((resolve) => setTimeout(resolve, saveCheckDelayMs));
        // eslint-disable-next-line no-await-in-loop
        const after = await readState();
        if (after && (after.sys_mod_count !== before.sys_mod_count || after.sys_updated_on !== before.sys_updated_on)) return { saved: true, confirmed: true };
      }
      return {
        saved: false,
        submitted: true,
        note: 'Save was requested but the record did not change. There was nothing to save, or a mandatory field or an onSubmit script blocked it. Check the form before telling the user it is saved.',
      };
    },

    async save_artifact({ table, sysId, fields, reason }) {
      if (!WRITABLE_ARTIFACTS.has(table)) throw new Error(`save_artifact can only write: ${[...WRITABLE_ARTIFACTS].join(', ')}.`);
      if (sysId && !SYS_ID_RE.test(sysId)) throw new Error('sysId must be a 32-character sys_id.');
      if (!fields || typeof fields !== 'object' || !Object.keys(fields).length) throw new Error('fields is empty.');
      const placeholder = placeholderProblemIn(Object.fromEntries(Object.entries(fields).filter(([, v]) => typeof v === 'string')));
      if (placeholder) throw new Error(placeholder);

      // 0. The user's safety settings, against the record as it is right now: a denied table, active code (when the user
      // turned edits of it off) and a record that changed after the approval card was made.
      const { guard } = await getGuardrails();
      const listed = deniedTableBlock(table, guard);
      if (listed) throw new Error(listed);
      if (sysId) {
        const state = await fetchRecord(table, sysId, ['active', 'sys_updated_on', 'sys_mod_count']).catch(() => null);
        const activeBlock = activeEditBlock({ guard, active: state?.active, isConfig: true });
        if (activeBlock) throw new Error(activeBlock);
        const stale = stalePins.check(sysId, { updatedOn: state?.sys_updated_on, modCount: state?.sys_mod_count });
        if (stale) throw new Error(stale);
      }

      // 1. Every column must really exist: invented field names are the commonest AI mistake.
      const known = await fieldNamesOf(table);
      const keys = Object.keys(fields);
      keys.forEach((key) => {
        if (!/^[a-z_][a-z0-9_]*$/.test(key) || PROTECTED_FIELDS.has(key)) throw new Error(`Field "${key}" may not be written.`);
        if (known && !known.includes(key)) {
          const near = closest(key, known);
          throw new Error(`${table} has no field "${key}"${near ? ` (did you mean "${near}"?)` : ''}. Call get_schema("${table}").`);
        }
      });

      // 2. Code must pass verification (errors block; warnings do not). Not only the script columns: a business rule
      // condition is server JavaScript, and encoded-query conditions can carry javascript: values. Nothing that runs
      // goes unchecked.
      const kind = kindForTable(table);
      let verification = null;
      const checks = artifactCodeChecks(fields, kind);
      if (checks.length) {
        let existing = {};
        if (sysId) existing = (await fetchRecord(table, sysId, ['type', 'when', 'table', 'collection'])) || {};
        const targetTable = fields.table || fields.collection || existing.table || existing.collection || '';
        for (const check of checks) {
          // eslint-disable-next-line no-await-in-loop -- a handful of short checks
          const { result } = await runVerify({
            code: check.code,
            kind: check.kind,
            table: targetTable && TABLE_RE.test(targetTable) ? targetTable : undefined,
            clientType: check.expression ? undefined : fields.type || existing.type || undefined,
            when: fields.when || existing.when || undefined,
            scoped: false,
          });
          verification = { ok: result.ok, summary: result.summary, findings: compactFindings(result, 10) };
          if (!result.ok) {
            throw new Error(`Not saved: ${check.field} has errors.\n${formatVerification(result, { maxFindings: 12 })}\nFix them, run verify_script, then call save_artifact again.`);
          }
        }
      }

      // New records start inactive unless the caller explicitly says otherwise: nothing goes live by omission.
      const toWrite = !sysId && fields.active === undefined && (!known || known.includes('active')) ? { ...fields, active: false } : fields;

      // 3. Keep what is replaced so the change can be undone.
      let previous = null;
      if (sysId) {
        previous = await fetchRecord(table, sysId, keys);
        if (!previous) throw new Error(`No ${table} record with sys_id ${sysId}.`);
        Object.keys(previous).forEach((k) => {
          if (!keys.includes(k)) delete previous[k];
        });
      }

      const saved = sysId ? await updateRecord(table, sysId, toWrite) : await createRecord(table, toWrite);
      const id = saved?.sys_id || sysId;
      await audit.record({
        instance: getInstanceInfo().host,
        tool: 'save_artifact',
        args: { table, sysId: id, fields, reason },
        ok: true,
        summary: `${sysId ? 'Updated' : 'Created'} ${table} ${fields.name || fields.short_description || id}`,
        undo: sysId ? { kind: 'record', table, sysId, previous } : { kind: 'record', table, sysId: id, created: true },
      });
      const updateSet = await getCurrentUpdateSet().catch(() => null);
      return {
        saved: true,
        action: sysId ? 'updated' : 'created',
        table,
        sysId: id,
        url: recordUrl(table, id),
        active: saved?.active ?? toWrite.active,
        updateSet: updateSet?.name || null,
        verification,
        note: toWrite.active === false || String(saved?.active) === 'false' ? 'It is inactive. Activate it on the record when you are ready.' : undefined,
      };
    },

    async undo_last_write({ entryId } = {}) {
      const host = getInstanceInfo().host;
      const entry = await audit.lastUndoable(host);
      if (!entry) throw new Error('There is nothing to undo on this instance.');
      // Undo goes strictly in order and only ever undoes the change shown for approval: the log is shared by every
      // tab and every agent, so the "last" change may have moved on since the card was shown.
      const pin = undoPin && Date.now() - undoPin.at < 10 * 60 * 1000 ? undoPin.id : null;
      undoPin = null;
      const expected = entryId || pin;
      if (expected && entry.id !== expected) {
        throw new Error('The last change on this instance is no longer the one that was approved for undo (something else changed meanwhile). Nothing was undone; ask again.');
      }
      const u = entry.undo;
      // An undo is a write like any other: the same table and field rules apply (a created sys_user is not deleted).
      const refusal = await undoRefusal(u);
      if (refusal) throw new Error(`Not undone: ${refusal}`);
      if (u.kind === 'field') {
        // The change was made on one form; never write the old value into a different record.
        const now = getContext();
        if ((u.table && u.table !== now.table) || (u.sysId && u.sysId !== now.sysId)) {
          throw new Error(`That change was made on ${u.table || 'another form'} ${u.sysId || ''}. Open that record to undo it.`);
        }
        await callPage('setFieldValue', [u.field, u.value]);
      } else if (u.created) {
        await deleteRecord(u.table, u.sysId);
      } else if (u.deleted) {
        // Re-insert the deleted record with its own sys_id (the Table API honours sys_id on insert).
        const back = await createRecord(u.table, { ...u.snapshot, sys_id: u.sysId });
        const id = back?.sys_id && typeof back.sys_id === 'object' ? back.sys_id.value : back?.sys_id;
        await audit.markUndone(entry.id);
        await audit.record({ instance: host, tool: 'undo_last_write', args: { undid: entry.id }, ok: true, summary: `Undid: ${entry.summary}` });
        return id === u.sysId
          ? { undone: entry.summary, sysId: id, url: recordUrl(u.table, id) }
          : { undone: entry.summary, sysId: id || null, note: `The instance re-created it with a different sys_id (${id || 'unknown'}). References to the old sys_id are not restored.` };
      } else if (u.kind === 'record') {
        await updateRecord(u.table, u.sysId, u.previous);
      } else if (!(control && (await controlTools.undoSession(u)))) {
        throw new Error('That change cannot be undone automatically.');
      }
      await audit.markUndone(entry.id);
      await audit.record({ instance: host, tool: 'undo_last_write', args: { undid: entry.id }, ok: true, summary: `Undid: ${entry.summary}` });
      return { undone: entry.summary, ...(u.kind === 'impersonation' ? { pageReload: 'expected' } : {}) };
    },

    async run_ui_steps({ steps }) {
      const allowed = (steps || []).filter((s) => ['click', 'type', 'select', 'waitfor', 'wait'].includes(String(s.action).toLowerCase()));
      if (allowed.length !== (steps || []).length) throw new Error('Only click, type, select, waitfor and wait are allowed. Navigation is not.');
      const parsed = parseSteps(JSON.stringify(allowed));
      if (parsed.errors.length) throw new Error(parsed.errors.map((e) => e.message).join(' '));
      let outcome = { finished: false };
      const stop = subscribeAutomation((event) => {
        if (event.type === 'finished') outcome = { finished: true };
        if (event.type === 'failed') outcome = { finished: false, failedAt: event.index + 1, error: event.message };
      });
      try {
        await runAutomation(parsed.steps);
      } finally {
        stop();
      }
      await audit.record({ instance: getInstanceInfo().host, tool: 'run_ui_steps', args: { steps: allowed }, ok: outcome.finished, summary: `Drove the page (${allowed.length} steps)` });
      if (!outcome.finished) throw new Error(`Stopped at step ${outcome.failedAt}: ${outcome.error}`);
      return { steps: allowed.length, finished: true };
    },
  };

  // Control-plane tools (read_page, navigate, click_ui_action, record CRUD, real script runs, session control, ATF).
  const controlTools = createControlTools({
    control,
    callPage,
    queryTable,
    fetchRecord,
    createRecord,
    updateRecord,
    deleteRecord,
    getSchema,
    fieldNamesOf,
    assertKnownColumns,
    runVerify,
    audit,
    recordUrl,
    getInstanceInfo,
    runBackgroundScript,
    getCsrfToken,
    extractScriptOutput,
    dryRuns,
    tableHierarchy,
    getGuardrails,
    stalePins,
    pollMs: atfPollMs,
  });
  for (const [name, fn] of Object.entries(controlTools.tools)) {
    tools[name] = (args, meta) => {
      if (!control) throw new Error(`${name} is not available here.`);
      return fn(args, meta || {});
    };
  }

  async function previewUndo() {
    const entry = await audit.lastUndoable(getInstanceInfo().host).catch(() => null);
    if (!entry) return { blocked: 'There is nothing to undo on this instance.' };
    undoPin = { id: entry.id, at: Date.now() };
    const refusal = await undoRefusal(entry.undo).catch((err) => err.message);
    return { target: entry.summary, entryId: entry.id, blocked: refusal ? `Undo would break the write rules: ${refusal}` : undefined };
  }

  return {
    tier: toolTier,

    /** @param {object} [meta] { callId, source } of the call, for tools that ask the person in the page themselves */
    async execute(name, args = {}, meta = {}) {
      const fn = Object.prototype.hasOwnProperty.call(tools, name) ? tools[name] : null;
      if (!fn) throw new Error(`Unknown tool "${name}".`);
      requireArgs(name, args);
      // Authoritative: the approval step may have been skipped or answered from an old card, this runs at the write.
      const refusal = await nonAdminRefusal(name);
      if (refusal) throw new Error(refusal);
      return fn(args, meta);
    },

    /**
     * The user's own /undo: the same approval card (and typed name on a guarded instance) as an agent's undo, and it
     * undoes exactly the entry that card showed.
     * @param {(request: object) => Promise<{approved: boolean}>} requestApproval
     */
    async undoWithApproval(requestApproval) {
      const noWrite = await nonAdminRefusal('undo_last_write');
      if (noWrite) throw new Error(noWrite);
      const preview = await previewUndo();
      if (preview.blocked) throw new Error(preview.blocked);
      const decision = await requestApproval({ tool: 'undo_last_write', args: {}, mode: isGuardedEnv(getInstanceInfo().env) ? 'ask-strong' : 'ask', source: 'user', preview });
      if (!decision?.approved) return { undone: null, declined: true };
      return tools.undo_last_write({ entryId: preview.entryId });
    },

    /** Extra context for an approval card: what changes (before/after) and whether it verifies. */
    async preview(name, args = {}) {
      const noWrite = await nonAdminRefusal(name).catch(() => null);
      if (noWrite) return { blocked: noWrite };
      if (control && Object.prototype.hasOwnProperty.call(controlTools.tools, name)) {
        return (await controlTools.preview(name, args)) || {};
      }
      if (name === 'undo_last_write') return previewUndo();
      try {
        if (name === 'set_form_field') {
          const state = await callPage('getFieldState', [args.name]).catch(() => null);
          const out = { before: state?.value ?? '', after: String(args.value ?? '') };
          const placeholder = placeholderProblem(args.name, args.value, { code: isScriptField(args.name) || isCodeColumn(args.name) });
          const refusal = await formFieldRefusal(getContext().table, args.name).catch(() => null);
          if (placeholder || refusal) out.blocked = placeholder || refusal;
          // A secret's current value is never put on a card.
          if (refusal) out.before = '';
          const table = getContext().table;
          if (isScriptField(args.name) && table && kindForTable(table)) {
            const { result } = await runVerify({ code: out.after, kind: kindForTable(table) });
            out.verification = { ok: result.ok, summary: result.summary };
          }
          return out;
        }
        if (name === 'save_artifact') {
          const out = { after: typeof args.fields?.script === 'string' ? args.fields.script : '' };
          const { guard } = await getGuardrails();
          const warnings = [];
          const notes = [];
          const listed = deniedTableBlock(args.table, guard);
          if (listed) out.blocked = listed;
          if (args.sysId && SYS_ID_RE.test(args.sysId)) {
            const prev = await fetchRecord(args.table, args.sysId, ['script', 'active', 'sys_updated_on', 'sys_mod_count']).catch(() => null);
            out.before = prev?.script ?? '';
            if (prev) {
              // What this card is built on: the write refuses if the record moved on before it is approved.
              stalePins.set(args.sysId, { updatedOn: prev.sys_updated_on, modCount: prev.sys_mod_count });
              const live = liveChangeNote(prev.active);
              if (live) (live === LIVE_INACTIVE_NOTE ? notes : warnings).push(live);
              const activeBlock = activeEditBlock({ guard, active: prev.active, isConfig: true });
              if (activeBlock && !out.blocked) out.blocked = activeBlock;
            }
          }
          const setCard = updateSetCard(await Promise.resolve().then(() => getCurrentUpdateSet()).catch(() => null));
          notes.push(...setCard.notes);
          warnings.push(...setCard.warnings);
          if (warnings.length) out.warnings = warnings;
          if (notes.length) out.notes = notes;
          const kind = kindForTable(args.table);
          if (kind && out.after) {
            const { result } = await runVerify({ code: out.after, kind, clientType: args.fields?.type, when: args.fields?.when });
            out.verification = { ok: result.ok, summary: result.summary };
          }
          return out;
        }
        if (name === 'dry_run_script') {
          const { result } = await runVerify({ code: args.code, kind: 'background_script' });
          return { after: String(args.code ?? ''), verification: { ok: result.ok, summary: result.summary }, risk: formatRiskSummary(analyzeScriptRisk(args.code)) };
        }
      } catch {
        // A preview is a courtesy; the approval card still works without one.
      }
      return {};
    },
  };
}
