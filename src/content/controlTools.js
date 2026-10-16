// Control-plane tools: read the screen, move around, act on forms and records,
// run scripts for real and steer the session. Schemas in
// src/lib/agent/toolSchemas.js; tiers and approval in src/lib/agent/policy.js.
// createAgentTools (agentTools.js) merges these into its executor, so the
// sidebar agent and external MCP clients get exactly the same checks.
//
// Every write here re-validates its arguments at execution time (the approval
// card is a courtesy, never the only check), records an audit entry and, where
// it can be done, an undo payload.
import { buildNavTarget, matchUiAction, dedupeActions, normalizeFieldValues, placeholderProblemIn, diffRecord, snapshotForReinsert, summarizePage, classifyPageKind, parseWorkspaceRecord, newMessages, hashText, atfState, TABLE_RE, SYS_ID_RE } from '../lib/agent/control.js';
import { assessWriteChain, isGuardedEnv, CREDENTIAL_TABLE_RE } from '../lib/agent/policy.js';
import { analyzeScriptRisk, formatRiskSummary, wrapWithGuards } from '../lib/scriptSafety.js';
import { redactSecrets } from '../providers/redact.js';
import { assertNoInlineScript } from '../lib/queryGuard.js';
import { closest } from '../lib/apiCatalog/index.js';
import { compactReportForAgent } from '../lib/healthScan.js';
import { VERDICT_TEXT } from '../lib/updateSetReview.js';

// scan_instance_health stops after this and returns what it has, well inside the MCP bridge's 3-minute call limit.
const HEALTH_SCAN_BUDGET_MS = 120000;
const FIELD_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/i;
const USER_TERM_RE = /^[\p{L}\p{N} ._@+'’-]{1,80}$/u;
const ACCESS_OPERATIONS = ['read', 'write', 'create', 'delete', 'report_view', 'report_on'];

const SECRET_NAME_RE = /(password|passwd|secret|token|credential|private_?key|api_?key)/i;
const SYSTEM_COLUMNS = new Set(['sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by', 'sys_mod_count', 'sys_class_name']);
const DEFAULT_LIST_COLUMNS = ['number', 'name', 'short_description', 'user_name', 'title', 'state', 'active', 'sys_updated_on'];
const DISPLAY_COLUMNS = ['number', 'name', 'short_description', 'user_name', 'title', 'sys_name'];
// Largest record copy kept for undo of a delete (characters of JSON); a bigger record has no undo, and the card says so.
const MAX_UNDO_CHARS = 200000;
// Portal pages that hold a form whose unsaved edits MySnowBuddy cannot see.
const PORTAL_FORM_PAGES = new Set(['form', 'ticket', 'sc_cat_item', 'sc_cat_item_guide', 'sc_request', 'csm_ticket', 'standard_ticket', 'hri_case', 'record_producer']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clip = (value, n) => {
  const s = value == null ? '' : String(value);
  return s.length > n ? `${s.slice(0, n)}...` : s;
};
const flat = (v) => (v && typeof v === 'object' ? String(v.display_value || v.value || '') : v == null ? '' : String(v));
const raw = (v) => (v && typeof v === 'object' ? String(v.value ?? '') : v == null ? '' : String(v));
const clampInt = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
};
const displayOf = (row = {}) => DISPLAY_COLUMNS.map((k) => flat(row[k])).find(Boolean) || '';
const hasScript = (q) => /javascript\s*:/i.test(String(q || '')) || /(^|[^a-z0-9_])gs\./i.test(String(q || ''));

function assertPlainName(value, label) {
  const s = String(value || '').trim();
  if (!s) throw new Error(`${label} is empty.`);
  if (s.includes('^')) throw new Error(`${label} may not contain "^".`);
  if (s.length > 200) throw new Error(`${label} is too long.`);
  assertNoInlineScript(s, label);
  return s;
}

/**
 * @param {object} ctx helpers shared with agentTools.js plus `control` (src/content/controlSession.js createControlDeps)
 */
export function createControlTools(ctx) {
  const { control, callPage, queryTable, fetchRecord, createRecord, updateRecord, deleteRecord, getSchema, fieldNamesOf, assertKnownColumns, runVerify, audit, recordUrl, getInstanceInfo, runBackgroundScript, getCsrfToken, extractScriptOutput, dryRuns, tableHierarchy, pollMs = 2000 } = ctx;
  const host = () => getInstanceInfo().host;
  // What the approval card showed for a click, so a different record opened meanwhile is never clicked.
  const pinned = new Map();
  const pinKey = (args) => `${String(args?.action || '').toLowerCase()}|${args?.sysId || ''}`;

  // ---- shared lookups ------------------------------------------------------------------------------

  async function labelsOf(table) {
    try {
      return Object.fromEntries((await getSchema(table)).fields.map((f) => [f.name, f.label || f.name]));
    } catch {
      return {};
    }
  }

  function assertWritableTable(table) {
    if (!TABLE_RE.test(table || '')) throw new Error(`"${table}" is not a valid table name.`);
    if (CREDENTIAL_TABLE_RE.test(table)) throw new Error(`${table} holds credentials or keys; the agent never reads or changes it.`);
  }

  /** Dictionary of a table for a write. Unlike reads, a write never goes ahead when the columns cannot be checked. */
  async function schemaForWrite(table) {
    let schema = null;
    try {
      schema = await getSchema(table);
    } catch {
      schema = null;
    }
    if (!schema?.fields?.length) {
      throw new Error(`Cannot read the dictionary of ${table} (the table does not exist, or you cannot read sys_dictionary), so the columns cannot be checked. Nothing was written.`);
    }
    return schema.fields;
  }

  function checkColumns(table, fields, schemaFields) {
    const byName = new Map(schemaFields.map((f) => [f.name, f]));
    for (const key of Object.keys(fields)) {
      const def = byName.get(key);
      if (!def) {
        const near = closest(key, [...byName.keys()]);
        throw new Error(`${table} has no field "${key}"${near ? ` (did you mean "${near}"?)` : ''}. Call get_schema("${table}"). Nothing was written.`);
      }
      if (/^password/i.test(def.type || '')) throw new Error(`"${key}" is a password field; the agent never writes those.`);
    }
  }

  /** Columns of `fields` that are journal fields (work notes, comments): writing one adds an entry. */
  const journalFields = (schemaFields, fields) => {
    const types = new Map(schemaFields.map((f) => [f.name, f.type || '']));
    return Object.keys(fields).filter((k) => /^journal/i.test(types.get(k) || ''));
  };

  const mismatches = (requested, saved) =>
    saved && typeof saved === 'object'
      ? Object.keys(requested)
          .filter((k) => k in saved && raw(saved[k]) !== requested[k])
          .map((k) => ({ field: k, requested: clip(requested[k], 200), stored: clip(raw(saved[k]), 200) }))
      : [];

  async function currentRecord() {
    const status = await callPage('getFormStatus').catch(() => null);
    if (status?.table) {
      const display = status.sysId && !status.isNewRecord ? await fetchRecord(status.table, status.sysId, DISPLAY_COLUMNS).then(displayOf).catch(() => '') : '';
      return { table: status.table, sysId: status.isNewRecord ? null : status.sysId, isNewRecord: Boolean(status.isNewRecord), display, dirty: status.dirty, changedFields: status.changedFields || [] };
    }
    const ws = parseWorkspaceRecord(control.page.currentPath());
    return ws ? { ...ws, display: '', dirty: null, changedFields: [] } : { table: null, sysId: null, display: '', dirty: null, changedFields: [] };
  }

  // ---- read_page ---------------------------------------------------------------------------------------

  function cleanField(f) {
    const out = { name: f.name };
    if (f.label) out.label = f.label;
    if (f.type) out.type = f.type;
    const secret = SECRET_NAME_RE.test(f.name) || /^password/i.test(f.type || '');
    if (f.value !== undefined) out.value = secret ? (f.value ? '[hidden]' : '') : f.value;
    if (f.display && !secret && f.display !== f.value) out.display = f.display;
    if (f.mandatory) out.mandatory = true;
    if (f.readOnly) out.readOnly = true;
    if (f.visible === false) out.visible = false;
    return out;
  }

  async function readForm(out, dom, fieldCap) {
    const [model, status] = await Promise.all([callPage('getFormModel').catch(() => null), callPage('getFormStatus').catch(() => null)]);
    out.table = model?.table || status?.table || dom.formTable || null;
    const sysId = model?.sysId || status?.sysId || dom.sysId || null;
    out.isNewRecord = Boolean(model?.isNewRecord ?? status?.isNewRecord ?? sysId === '-1');
    out.sysId = out.isNewRecord ? null : sysId;
    if (out.table && out.sysId) out.url = recordUrl(out.table, out.sysId);
    const fields = model?.fields?.length ? model.fields : control.page.domFormFields(fieldCap + 1);
    out.form = {
      dirty: status?.dirty ?? null,
      changedFields: status?.changedFields?.length ? status.changedFields : undefined,
      fieldCount: model?.fieldCount ?? fields.length,
      sections: dom.sections?.length
        ? dom.sections.slice(0, 30).map((s) => ({ name: s.name, fields: s.fields.slice(0, 60) }))
        : status?.sections?.length
          ? status.sections.map((name) => ({ name }))
          : undefined,
      fields: fields.slice(0, fieldCap).map(cleanField),
      truncated: fields.length > fieldCap ? `${fields.length - fieldCap} more fields; raise maxFields or use get_field_state.` : undefined,
      source: model?.fields?.length ? 'g_form' : 'markup',
    };
    out.uiActions = dedupeActions(dom.uiActions || []).slice(0, 40).map((a) => ({ label: a.label, ...(a.actionName ? { actionName: a.actionName } : {}) }));
    if (dom.relatedLists?.length) out.relatedLists = dom.relatedLists;
  }

  async function readList(out, dom, rowCap) {
    const info = await callPage('getListInfo').catch(() => null);
    const pagePath = dom.contentPath || dom.topPath || '';
    const fromPath = pagePath.match(/\/([a-z][a-z0-9_]*)_list\.do/i)?.[1] || null;
    const table = info?.table || dom.list?.table || fromPath;
    let query = info?.query ?? null;
    if (query === null) {
      try {
        query = new URL(pagePath, 'https://instance.invalid').searchParams.get('sysparm_query') || '';
      } catch {
        query = '';
      }
    }
    out.table = table;
    const list = { table, query, rowsOnScreen: dom.list?.rowsOnScreen ?? null };
    const domColumns = dom.list?.columns || [];
    if (table && TABLE_RE.test(table) && !CREDENTIAL_TABLE_RE.test(table) && !hasScript(query) && query.length <= 2000) {
      // The Table API gives clean values and sys_ids; the list's own columns decide what is shown.
      const known = await fieldNamesOf(table);
      const allowed = (c) => !known || SYSTEM_COLUMNS.has(c.split('.')[0]) || known.includes(c.split('.')[0]);
      let columns = domColumns.filter(allowed).slice(0, 8);
      if (!columns.length) columns = DEFAULT_LIST_COLUMNS.filter((c) => known?.includes(c)).slice(0, 5);
      try {
        const rows = await queryTable(table, query, ['sys_id', ...columns.filter((c) => c !== 'sys_id')], { limit: rowCap, displayValue: true });
        list.columns = columns;
        list.rows = rows.map((r) => Object.fromEntries([['sys_id', raw(r.sys_id)], ...columns.filter((c) => c !== 'sys_id').map((c) => [c, clip(flat(r[c]), 160)])]));
        list.source = 'table-api';
      } catch (err) {
        list.note = `Rows could not be read through the Table API (${err.message}).`;
      }
    }
    if (!list.rows && dom.list) {
      list.columns = domColumns;
      list.rows = dom.list.rows;
      list.source = 'page';
      if (hasScript(query)) list.note = 'The list filter contains script, so rows were read from the page instead of re-queried.';
    }
    out.list = list;
  }

  async function readWorkspace(out, dom, fieldCap) {
    const rec = parseWorkspaceRecord(dom.topPath);
    if (dom.headings?.length) out.headings = dom.headings;
    if (dom.buttons?.length) out.buttons = dom.buttons;
    if (!rec || CREDENTIAL_TABLE_RE.test(rec.table)) return;
    out.table = rec.table;
    out.sysId = rec.sysId;
    out.url = recordUrl(rec.table, rec.sysId);
    try {
      const [rows, schema] = await Promise.all([queryTable(rec.table, `sys_id=${rec.sysId}`, [], { limit: 1, displayValue: true }), getSchema(rec.table).catch(() => null)]);
      if (!rows[0]) return;
      const defs = new Map((schema?.fields || []).map((f) => [f.name, f]));
      const fields = Object.entries(rows[0])
        .filter(([k, v]) => flat(v) !== '' && (!k.startsWith('sys_') || ['sys_updated_on', 'sys_updated_by', 'sys_class_name'].includes(k)))
        .map(([k, v]) => cleanField({ name: k, label: defs.get(k)?.label, type: defs.get(k)?.type, value: raw(v).slice(0, 300), display: flat(v).slice(0, 120) }));
      out.form = {
        source: 'table-api',
        note: 'Workspace form: these are the saved values, not unsaved edits on screen. Buttons are read from the page (best effort).',
        fieldCount: fields.length,
        fields: fields.slice(0, fieldCap),
      };
    } catch (err) {
      out.form = { source: 'none', note: `The record could not be read (${err.message}).` };
    }
  }

  async function readPage({ maxFields, maxRows } = {}) {
    const fieldCap = clampInt(maxFields, 1, 200, 80);
    const rowCap = clampInt(maxRows, 1, 25, 10);
    const dom = control.page.snapshotDom({ maxRows: rowCap });
    const kind = classifyPageKind({ topPath: dom.topPath, hasForm: dom.hasForm, hasList: dom.hasList });
    const out = { kind, ui: dom.ui, title: dom.title, path: dom.topPath };
    if (dom.contentPath && dom.contentPath !== dom.topPath) out.contentPath = dom.contentPath;
    if (dom.messages?.length) out.messages = dom.messages;
    if (dom.dialog) out.dialog = dom.dialog;
    if (kind === 'form') await readForm(out, dom, fieldCap);
    else if (kind === 'list') await readList(out, dom, rowCap);
    else if (kind === 'workspace') await readWorkspace(out, dom, fieldCap);
    else {
      if (dom.headings?.length) out.headings = dom.headings;
      if (dom.buttons?.length) out.buttons = dom.buttons;
    }
    return out;
  }

  // ---- resolvers -----------------------------------------------------------------------------------------

  async function resolveOne(table, value, nameColumns, fields, label) {
    const v = assertPlainName(value, label);
    if (SYS_ID_RE.test(v)) {
      const row = await fetchRecord(table, v, ['sys_id', ...fields]);
      if (!row) throw new Error(`No ${label} with sys_id ${v} (or you cannot read it).`);
      return row;
    }
    for (const column of nameColumns) {
      // eslint-disable-next-line no-await-in-loop -- at most two exact-name lookups, in order of preference
      const rows = await queryTable(table, `${column}=${v}`, ['sys_id', ...fields], { limit: 5 });
      if (rows.length === 1) return rows[0];
      if (rows.length > 1) throw new Error(`${rows.length} ${label}s are called "${v}". Use the sys_id: ${rows.map((r) => r.sys_id).join(', ')}.`);
    }
    throw new Error(`No ${label} "${v}". Check the exact name with query_table.`);
  }

  async function resolveUpdateSet(value) {
    const v = assertPlainName(value, 'update set');
    if (SYS_ID_RE.test(v)) {
      const row = await fetchRecord('sys_update_set', v, ['sys_id', 'name', 'state', 'application']);
      if (!row) throw new Error(`No update set with sys_id ${v}.`);
      return row;
    }
    const rows = await queryTable('sys_update_set', `name=${v}`, ['sys_id', 'name', 'state', 'application'], { limit: 10 });
    const open = rows.filter((r) => r.state === 'in progress');
    if (open.length === 1) return open[0];
    if (open.length > 1) throw new Error(`${open.length} in-progress update sets are called "${v}" (different applications). Use the sys_id: ${open.map((r) => r.sys_id).join(', ')}.`);
    if (rows.length) return rows[0]; // exists but not in progress: the caller explains
    throw new Error(`No update set "${v}". List them with query_table on sys_update_set (state=in progress).`);
  }

  async function resolveScope(value) {
    const v = assertPlainName(value, 'application');
    if (v.toLowerCase() === 'global') return { sys_id: 'global', name: 'Global', scope: 'global' };
    return resolveOne('sys_scope', v, ['scope', 'name'], ['name', 'scope'], 'application');
  }

  async function resolveSuite(value) {
    const v = assertPlainName(value, 'suite');
    try {
      return await resolveOne('sys_atf_test_suite', v, ['name'], ['name', 'active'], 'test suite');
    } catch (err) {
      const asTest = await (SYS_ID_RE.test(v) ? fetchRecord('sys_atf_test', v, ['name']) : queryTable('sys_atf_test', `name=${v}`, ['name'], { limit: 1 }).then((r) => r[0])).catch(() => null);
      if (asTest) {
        throw new Error(`"${asTest.name || v}" is a single test, not a suite. The CI/CD API only runs suites: add the test to a suite, or open the test (navigate) and use its "Run Test" button with the user.`);
      }
      throw err;
    }
  }

  // ---- tools ---------------------------------------------------------------------------------------------

  const tools = {
    read_page: (args) => readPage(args),

    async navigate(args = {}, meta = {}) {
      const target = buildNavTarget(args);
      if (target.table) {
        if (CREDENTIAL_TABLE_RE.test(target.table)) throw new Error(`${target.table} holds credentials or keys; the agent does not open it.`);
        const exists = await control.tableExists(target.table).catch(() => false);
        if (!exists) throw new Error(`There is no table "${target.table}" you can read on this instance. Only list and form views of real tables can be opened this way.`);
        if (target.query) await assertKnownColumns(target.table, target.query);
      }
      if (target.needsPortalCheck) {
        const isPortal = control.portalExists ? await control.portalExists(target.suffix).catch(() => false) : false;
        if (!isPortal) throw new Error(`/${target.suffix} is not a portal on this instance (no sp_portal has that URL suffix). Nothing was opened.`);
      }
      // Never throw away someone's unsaved work.
      const status = await callPage('getFormStatus').catch(() => null);
      if (status?.dirty) {
        const which = status.changedFields?.length ? ` (${status.changedFields.slice(0, 8).join(', ')})` : '';
        throw new Error(`The open form (${status.table || 'record'}) has unsaved changes${which}. Save it with save_form, or ask the user, before leaving it. Nothing was opened.`);
      }
      // A workspace or portal form keeps its edits where MySnowBuddy cannot see them: a person decides.
      if (!status?.table && onInvisibleForm()) {
        if (!control.confirm) throw new Error('This page is a workspace or portal form whose unsaved changes MySnowBuddy cannot see. Ask the user to leave it first. Nothing was opened.');
        const decision = await control.confirm({
          id: meta.callId,
          tool: 'navigate',
          args,
          mode: 'ask',
          source: meta.source || 'agent',
          preview: { target: `Open ${target.path}`, warnings: ['Any unsaved changes on the current page will be lost.'] },
        });
        if (!decision?.approved) throw new Error('The user chose to stay on this page (it may have unsaved changes). Nothing was opened.');
      }
      const before = control.page.pageMarker();
      if (target.classic && before.frame) {
        // Classic page inside a frame: load it in the frame, so the shell, the sidebar and this run stay alive.
        control.page.navigateFrame(before.frame, target.path);
        const outcome = await control.page.waitForChange(before, { timeoutMs: 20000 });
        const page = await readPage({ maxFields: 40, maxRows: 5 }).catch(() => null);
        return {
          opened: target.path,
          loaded: outcome === 'page-changed',
          page: summarizePage(page),
          note: outcome === 'page-changed' ? undefined : 'The page did not finish loading within 20 seconds; call read_page to check.',
        };
      }
      control.page.navigateTop(target.classic ? control.shellUrl(target.path) : target.path);
      return {
        opened: target.path,
        pageReload: 'expected',
        note: 'The whole tab is loading the page. Call read_page next to see it.',
      };
    },

    async get_instance_info() {
      const inst = getInstanceInfo();
      const s = control.session;
      const [user, build, updateSet, scope, session] = await Promise.all([
        s.readCurrentUser().catch(() => null),
        s.readBuild().catch(() => null),
        s.readCurrentUpdateSet().catch(() => null),
        s.readCurrentScope().catch(() => null),
        s.readSessionInfo().catch(() => null),
      ]);
      const notes = [];
      let roles = user?.sysId ? await s.readUserRoles(user.sysId).catch(() => null) : null;
      if (!roles && Array.isArray(session?.roles)) {
        roles = session.roles;
        notes.push('Roles come from the page (g_user); sys_user_has_role was not readable.');
      }
      if (!build) notes.push('Release/build is not readable for this user (stats.do and the build properties need admin).');
      if (!updateSet) notes.push('The current update set could not be read.');
      if (!scope) notes.push('The current application scope could not be read.');
      return {
        host: inst.host,
        instance: inst.instance,
        environment: inst.env,
        writesNeedTypedConfirmation: isGuardedEnv(inst.env),
        build,
        user: user ? { sysId: user.sysId, userName: user.userName, name: user.name } : null,
        roles: {
          admin: roles ? roles.includes('admin') : session?.admin ?? null,
          securityAdminElevated: session?.securityAdmin ?? null,
          count: roles ? roles.length : null,
          list: roles ? roles.slice(0, 60) : null,
        },
        updateSet: updateSet ? { sysId: updateSet.sysId, name: updateSet.name } : null,
        scope: scope ? { sysId: scope.sysId, name: scope.name || null, scope: scope.scope || null } : null,
        notes: notes.length ? notes : undefined,
      };
    },

    // ---- read-only analysis (the access debugger, page X-ray, ship check and health scan panels) ----------

    async explain_access({ table, user = '', sysId = '', field = '', operation = 'read' } = {}) {
      if (!TABLE_RE.test(String(table || ''))) throw new Error('table must be a table name, e.g. "incident".');
      if (sysId && !SYS_ID_RE.test(sysId)) throw new Error('sysId must be a 32-character sys_id.');
      if (field && !FIELD_RE.test(field)) throw new Error('field must be a column name, e.g. "assignment_group".');
      // The user ends up inside an encoded query: allow only what names, user names and emails need, so a value can
      // never carry "javascript:", "^OR", "=" or other query syntax.
      if (user && !USER_TERM_RE.test(String(user))) throw new Error('user must be a user name, email, full name or sys_id (letters, digits, spaces and . _ @ + \' - only).');
      if (!ACCESS_OPERATIONS.includes(operation)) throw new Error(`operation must be one of ${ACCESS_OPERATIONS.join(', ')}.`);
      const result = await control.insights.explainAccess({ user: user === 'me' ? '' : user, table, sysId, field, operation });
      return { verdict: result.verdict, explanation: result.text, trace: result.trace };
    },

    async explain_field({ table = '', field } = {}) {
      const t = String(table || control.insights.pageTable() || '');
      if (!TABLE_RE.test(t)) throw new Error('No form is open; pass the table.');
      if (!FIELD_RE.test(String(field || ''))) throw new Error('field must be a column name, e.g. "assignment_group".');
      const r = await control.insights.fieldReport({ table: t, field });
      // Names and ids only: the scripts themselves are a read_artifact call away.
      const ref = (o) => (o ? { name: o.name || '(no name)', sysId: o.sysId || undefined, table: o.table || undefined } : null);
      const list = (items, map) => (items?.length ? items.slice(0, 15).map(map) : undefined);
      const e = r.entry;
      const logic = e
        ? {
            clientScripts: list(e.clientScripts, (x) => ({ ...ref(x.script), reasons: x.reasons })),
            uiPolicies: list(e.uiPolicies, (x) => ({ ...ref(x.policy), role: x.role })),
            dataPolicies: list(e.dataPolicies, (x) => ({ ...ref(x.policy), role: x.role })),
            businessRules: list(e.businessRules, (x) => ({ ...ref(x.rule), where: x.where })),
            acls: list(e.acls, ref),
          }
        : null;
      return {
        table: t,
        field,
        onForm: r.onForm,
        liveState: r.live ? { readOnly: r.live.readOnly, mandatory: r.live.mandatory, visible: r.live.visible } : null,
        likelyCauses: (r.causes || []).slice(0, 8),
        dictionary: r.column || null,
        overrides: (r.overrides || []).slice(0, 10),
        logic,
        notes: r.notes?.length ? r.notes : undefined,
        capped: r.capped || undefined,
      };
    },

    async check_update_set({ updateSet = '' } = {}) {
      let id = String(updateSet || '').trim();
      if (id && !SYS_ID_RE.test(id)) throw new Error('updateSet must be a 32-character sys_id (call get_instance_info for the current one).');
      if (!id) {
        const current = await control.insights.currentUpdateSet();
        if (!current?.sysId || !SYS_ID_RE.test(current.sysId)) throw new Error('The current update set could not be read; pass updateSet.');
        id = current.sysId;
      }
      const r = await control.insights.loadShipCheck(id);
      return {
        updateSet: { sysId: r.set.sysId, name: r.set.name, state: r.set.state, application: r.set.applicationName || undefined },
        verdict: r.checklist.verdict,
        summary: VERDICT_TEXT[r.checklist.verdict],
        counts: r.checklist.counts,
        checks: r.checklist.checks
          .filter((c) => c.status !== 'ok')
          .map((c) => ({
            status: c.status,
            title: c.title,
            detail: c.detail || undefined,
            items: c.items?.length ? c.items.slice(0, 8).map((i) => [i.label, i.detail].filter(Boolean).join(': ')) : undefined,
            more: c.items?.length > 8 ? c.items.length - 8 : undefined,
          })),
        passed: r.checklist.checks.filter((c) => c.status === 'ok').map((c) => c.title),
        releaseNotes: clip(r.releaseNotes, 4000),
      };
    },

    async scan_instance_health(args = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_SCAN_BUDGET_MS);
      try {
        const report = await control.insights.runHealthScan(args, () => {}, controller.signal);
        const compact = compactReportForAgent(report);
        if (controller.signal.aborted) compact.note = 'Stopped after 2 minutes; this is a partial result. Narrow the scope (mode "scope", "updateset" or "recent") for a complete one.';
        return compact;
      } finally {
        clearTimeout(timer);
      }
    },

    async click_ui_action({ action, sysId } = {}) {
      if (sysId && !SYS_ID_RE.test(sysId)) throw new Error('sysId must be a 32-character sys_id.');
      const found = control.page.listUiActions();
      if (found.mode === 'none') throw new Error('No form with UI actions is open. Open a record first (navigate), then read_page.');
      const { action: hit } = matchUiAction(found.actions, action);
      const record = await currentRecord();
      if (sysId && record.sysId !== sysId) throw new Error(`The open record is ${record.table || '?'} ${record.sysId || '(new)'}, not ${sysId}. Nothing was clicked.`);
      const shown = pinned.get(pinKey({ action, sysId }));
      if (shown && shown !== `${record.table}|${record.sysId}`) throw new Error('A different record is open than the one you approved. Nothing was clicked; read_page and ask again.');
      pinned.delete(pinKey({ action, sysId }));

      const before = control.page.pageMarker();
      const messagesBefore = control.page.readMessages(before.doc);
      // Recorded first: a submit can reload the page and end this script before it could log.
      await audit.record({
        instance: host(),
        tool: 'click_ui_action',
        args: { action, label: hit.label, actionName: hit.actionName, table: record.table, sysId: record.sysId },
        ok: true,
        summary: `Clicked "${hit.label}" on ${record.table || 'the page'} ${record.display || record.sysId || ''}`.trim(),
      });
      control.page.clickControl(hit.el);
      const outcome = await control.page.waitForChange(before, { timeoutMs: 12000, messagesBefore });
      const page = await readPage({ maxFields: 30, maxRows: 5 }).catch(() => null);
      const fresh = newMessages(outcome === 'page-changed' ? [] : messagesBefore, page?.messages || []);
      return {
        clicked: hit.label,
        actionName: hit.actionName || undefined,
        record: { table: record.table, sysId: record.sysId, display: record.display || undefined },
        outcome,
        messages: fresh.length ? fresh : undefined,
        page: summarizePage(page),
        note:
          outcome === 'dialog'
            ? 'A dialog opened. read_page shows it; ask the user how to answer it.'
            : outcome === 'no-visible-change'
              ? 'Nothing visibly changed. The action may still have run (client-side actions often show nothing). Check with read_page or query the record.'
              : found.mode === 'workspace'
                ? 'Workspace button clicked by label (best effort). Verify the result.'
                : undefined,
      };
    },

    async create_record({ table, fields, reason } = {}) {
      assertWritableTable(table);
      const clean = normalizeFieldValues(fields);
      const placeholder = placeholderProblemIn(clean);
      if (placeholder) throw new Error(placeholder);
      const verdict = await checkRecordWrite({ op: 'create', table, fields: clean });
      if (verdict.block) throw new Error(verdict.block);
      checkColumns(table, clean, await schemaForWrite(table));
      const saved = await createRecord(table, clean);
      const id = raw(saved?.sys_id);
      if (!SYS_ID_RE.test(id)) throw new Error('The instance did not return the new record. Check the table before trying again.');
      const display = displayOf(saved);
      await audit.record({
        instance: host(),
        tool: 'create_record',
        args: { table, fields: clean, reason },
        ok: true,
        summary: `Created ${table} ${display || id}`,
        undo: { kind: 'record', table, sysId: id, created: true },
      });
      const notApplied = mismatches(clean, saved);
      return {
        created: true,
        table,
        sysId: id,
        display: display || undefined,
        url: recordUrl(table, id),
        notApplied: notApplied.length ? notApplied : undefined,
        note: notApplied.length ? 'Some values were stored differently (a business rule, data policy or reference lookup changed them).' : undefined,
      };
    },

    async update_record({ table, sysId, fields, reason } = {}) {
      assertWritableTable(table);
      if (!SYS_ID_RE.test(sysId || '')) throw new Error('sysId must be a 32-character sys_id.');
      const clean = normalizeFieldValues(fields);
      const placeholder = placeholderProblemIn(clean);
      if (placeholder) throw new Error(placeholder);
      // Policy and the write itself follow the record's real class, never only the table name given.
      const verdict = await checkRecordWrite({ op: 'update', table, sysId, fields: clean });
      if (verdict.block) throw new Error(verdict.block);
      const cls = verdict.cls;
      const schemaFields = await schemaForWrite(cls);
      checkColumns(cls, clean, schemaFields);
      const journal = journalFields(schemaFields, clean);
      const current = await fetchRecord(cls, sysId, [...Object.keys(clean), ...DISPLAY_COLUMNS.filter((c) => !(c in clean))]).catch(() => null);
      if (!current) throw new Error(`No ${table} record with sys_id ${sysId} (or you cannot read it). Nothing was written.`);
      const previous = Object.fromEntries(Object.keys(clean).map((k) => [k, journal.includes(k) ? '' : raw(current[k])]));
      const changes = diffRecord(previous, clean);
      if (!changes.length) return { updated: false, table: cls, sysId, note: 'Every field already has that value. Nothing was written.' };
      const toWrite = Object.fromEntries(changes.map((c) => [c.field, clean[c.field]]));
      // A journal entry (work notes, comments) is added, not replaced: undo cannot take it back, so it is not in the undo.
      // An old value holding a secret is never kept in the audit log either, so it is not restorable.
      const restorable = changes.filter((c) => !journal.includes(c.field));
      const notKept = restorable.filter((c) => secretBearing(previous[c.field])).map((c) => c.field);
      const before = Object.fromEntries(restorable.filter((c) => !notKept.includes(c.field)).map((c) => [c.field, previous[c.field]]));
      const saved = await updateRecord(cls, sysId, toWrite);
      await audit.record({
        instance: host(),
        tool: 'update_record',
        args: { table: cls, sysId, fields: toWrite, reason },
        ok: true,
        summary: `Updated ${cls} ${displayOf(current) || sysId}: ${changes.map((c) => c.field).join(', ')}`,
        undo: Object.keys(before).length ? { kind: 'record', table: cls, sysId, previous: before } : null,
      });
      const notApplied = mismatches(toWrite, saved);
      return {
        updated: true,
        table: cls,
        sysId,
        url: recordUrl(cls, sysId),
        changed: changes.map((c) => c.field),
        notApplied: notApplied.length ? notApplied.filter((m) => !journal.includes(m.field)) : undefined,
        journalAdded: journal.length ? journal.filter((k) => k in toWrite) : undefined,
        undoNotKept: notKept.length ? notKept : undefined,
        note: notApplied.some((m) => !journal.includes(m.field)) ? 'Some values were stored differently (a business rule, data policy or reference lookup changed them).' : undefined,
      };
    },

    async delete_record({ table, sysId, reason } = {}) {
      assertWritableTable(table);
      if (!SYS_ID_RE.test(sysId || '')) throw new Error('sysId must be a 32-character sys_id.');
      // A parent table name (sys_metadata, task, sys_package) must not hide what the record really is.
      const verdict = await checkRecordWrite({ op: 'delete', table, sysId });
      if (verdict.block) throw new Error(verdict.block);
      const cls = verdict.cls;
      const row = await fetchRecord(cls, sysId, []).catch(() => null);
      if (!row) throw new Error(`No ${table} record with sys_id ${sysId} (or you cannot read it). Nothing was deleted.`);
      const kept = await reinsertPayload(cls, sysId, row);
      await deleteRecord(cls, sysId);
      const display = displayOf(row);
      await audit.record({
        instance: host(),
        tool: 'delete_record',
        args: { table: cls, sysId, reason },
        ok: true,
        summary: `Deleted ${cls} ${display || sysId}`,
        undo: kept.undo,
      });
      return {
        deleted: true,
        table: cls,
        sysId,
        display: display || undefined,
        undo: deleteUndoText(kept),
      };
    },

    async run_background_script({ code, reason } = {}) {
      const { result } = await runVerify({ code, kind: 'background_script' });
      const syntax = result.findings.find((f) => f.ruleId === 'syntax-error');
      if (syntax) throw new Error(`Not run: ${syntax.message}`);
      const risk = analyzeScriptRisk(code);
      const dryRunFirst = dryRuns.has(hashText(code));
      let html;
      try {
        html = await runBackgroundScript(wrapWithGuards(code), await getCsrfToken());
      } catch (err) {
        await audit.record({ instance: host(), tool: 'run_background_script', args: { code, reason }, ok: false, summary: `Background script failed: ${clip(err.message, 120)}` });
        throw err;
      }
      await audit.record({ instance: host(), tool: 'run_background_script', args: { code, reason }, ok: true, summary: `Ran a background script${reason ? `: ${clip(reason, 100)}` : ''}` });
      return {
        ran: true,
        dryRunFirst,
        risk: formatRiskSummary(risk),
        output: clip(extractScriptOutput(html), 8000) || '(no output)',
        note: 'This was a real run in the global scope. MySnowBuddy cannot undo it.',
      };
    },

    async switch_update_set({ updateSet } = {}) {
      const target = await resolveUpdateSet(updateSet);
      if (target.state !== 'in progress') throw new Error(`"${target.name}" is ${target.state || 'not in progress'}; only an in-progress update set can be made current.`);
      const before = await control.session.readCurrentUpdateSet().catch(() => null);
      if (before?.sysId === target.sys_id) return { switched: false, current: { sysId: before.sysId, name: before.name }, note: 'It is already the current update set.' };
      const { after, requestError } = await control.session.switchUpdateSet(target.sys_id);
      const took = after?.sysId === target.sys_id || after?.preference === target.sys_id;
      await audit.record({
        instance: host(),
        tool: 'switch_update_set',
        args: { updateSet: target.sys_id, name: target.name },
        ok: took,
        summary: took ? `Switched the update set to ${target.name}` : `Tried to switch the update set to ${target.name} (did not take)`,
        undo: took && before?.sysId ? { kind: 'updateSet', sysId: before.sysId, name: before.name } : null,
      });
      if (!took) {
        return {
          switched: false,
          requested: { sysId: target.sys_id, name: target.name },
          current: after ? { sysId: after.sysId, name: after.name } : null,
          error: requestError || undefined,
          note: 'The switch did not take: reading it back shows a different update set. Open the update set (navigate table sys_update_set + sysId) and use click_ui_action "Make This My Current Set", or ask the user to use the picker.',
        };
      }
      return { switched: true, previous: before ? { sysId: before.sysId, name: before.name } : null, current: { sysId: after.sysId, name: after.name || target.name } };
    },

    async switch_application_scope({ scope } = {}) {
      const target = await resolveScope(scope);
      const before = await control.session.readCurrentScope().catch(() => null);
      if (before?.sysId === target.sys_id) return { switched: false, current: before, note: 'It is already the current application.' };
      const { after, requestError } = await control.session.switchScope(target.sys_id);
      const took = after?.sysId === target.sys_id;
      await audit.record({
        instance: host(),
        tool: 'switch_application_scope',
        args: { scope: target.sys_id, name: target.name },
        ok: took,
        summary: took ? `Switched the application to ${target.name}` : `Tried to switch the application to ${target.name} (did not take)`,
        undo: took && before?.sysId ? { kind: 'scope', sysId: before.sysId, name: before.name } : null,
      });
      if (!took) {
        return {
          switched: false,
          requested: { sysId: target.sys_id, name: target.name, scope: target.scope },
          current: after,
          error: requestError || undefined,
          note: 'The switch did not take: reading it back shows a different application. Ask the user to use the application picker (you can only switch to applications you may develop in).',
        };
      }
      return { switched: true, previous: before, current: after };
    },

    async impersonate_user({ user, reason } = {}) {
      const target = await resolveOne('sys_user', user, ['user_name'], ['user_name', 'name', 'active'], 'user');
      if (String(target.active) === 'false') throw new Error(`${target.user_name} is inactive.`);
      const me = await control.session.readCurrentUser().catch(() => null);
      if (me?.sysId === target.sys_id) throw new Error('That is already the session user.');
      await control.session.startImpersonation(target.sys_id);
      const now = await control.session.readCurrentUserFromApi().catch(() => null);
      await audit.record({
        instance: host(),
        tool: 'impersonate_user',
        args: { user: target.user_name, sysId: target.sys_id, reason },
        ok: true,
        summary: `Impersonated ${target.user_name}`,
        undo: { kind: 'impersonation', userName: target.user_name },
      });
      control.page.reloadSoon(400);
      return {
        impersonating: target.user_name,
        name: target.name,
        confirmed: now?.sysId === target.sys_id ? true : 'not yet: confirm with get_instance_info after the reload',
        pageReload: 'expected',
        note: 'Everything now runs as this user until end_impersonation. The page is reloading.',
      };
    },

    async end_impersonation() {
      await control.session.endImpersonation();
      const now = await control.session.readCurrentUserFromApi().catch(() => null);
      // The impersonation's own undo entry is spent.
      const list = await audit.load().catch(() => []);
      const open = list.find((e) => e.ok && !e.undone && e.undo?.kind === 'impersonation' && e.instance === host());
      if (open) await audit.markUndone(open.id);
      await audit.record({ instance: host(), tool: 'end_impersonation', args: {}, ok: true, summary: 'Ended impersonation' });
      control.page.reloadSoon(400);
      return { ended: true, user: now?.userName || null, pageReload: 'expected' };
    },

    async run_atf({ suite, progressId, waitSeconds } = {}) {
      const wait = clampInt(waitSeconds, 0, 150, 60);
      let id = progressId || null;
      let suiteInfo = null;
      if (id) {
        if (!SYS_ID_RE.test(id)) throw new Error('progressId must be the 32-character id an earlier run_atf returned.');
      } else {
        if (!suite) throw new Error('Give suite (sys_id or exact name), or progressId to keep waiting on a run.');
        const row = await resolveSuite(suite);
        suiteInfo = { sysId: row.sys_id, name: row.name };
        const started = await control.atf.startSuite(row.sys_id);
        if (!started?.progressId) throw new Error('The CI/CD API accepted the request but returned no progress id; check the suite results list.');
        id = started.progressId;
        await audit.record({ instance: host(), tool: 'run_atf', args: { suite: row.sys_id, name: row.name }, ok: true, summary: `Started the ATF suite ${row.name}` });
      }
      const deadline = Date.now() + wait * 1000;
      let progress = await control.atf.readProgress(id);
      while (['pending', 'running'].includes(atfState(progress.status)) && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- bounded polling of a running test suite
        await sleep(pollMs);
        // eslint-disable-next-line no-await-in-loop
        progress = await control.atf.readProgress(id);
      }
      const state = atfState(progress.status);
      const out = { progressId: id, suite: suiteInfo || undefined, state, percent: progress.percent, message: progress.message || progress.error || undefined };
      if (state === 'pending' || state === 'running') {
        return { ...out, finished: false, next: `Still running. Call run_atf with progressId "${id}" (and no suite) to keep waiting; that starts nothing.` };
      }
      out.finished = true;
      if (progress.resultsId) {
        out.result = await control.atf.readSuiteResult(progress.resultsId).catch(() => null);
        out.resultUrl = recordUrl('sys_atf_test_suite_result', progress.resultsId);
        out.failures = await failedTests(progress.resultsId);
      }
      return out;
    },
  };

  async function failedTests(resultId) {
    const names = await fieldNamesOf('sys_atf_test_result');
    if (!names || !['parent', 'status', 'test'].every((c) => names.includes(c))) return undefined;
    const rows = await queryTable('sys_atf_test_result', `parent=${resultId}^status!=success`, ['test', 'status', 'output'], { limit: 20, displayValue: true }).catch(() => []);
    return rows.map((r) => ({ test: flat(r.test), status: flat(r.status), output: clip(flat(r.output), 300) || undefined }));
  }

  /** Why the executor will refuse these columns, for the approval card, or null. */
  async function columnProblem(table, fields) {
    try {
      assertWritableTable(table);
      checkColumns(table, fields, await schemaForWrite(table));
      return null;
    } catch (err) {
      return err.message;
    }
  }

  /**
   * The record's real class and its whole table chain: the table named in the call, the class the record really
   * is (sys_class_name) and that class's parents. Policy is applied to every one of them, and writes go through
   * the real class, so "sys_metadata" or "task" can never stand in for a blocked or richer child table.
   */
  async function recordChain(table, sysId) {
    let cls = table;
    if (sysId) {
      const row = await fetchRecord(table, sysId, ['sys_class_name']).catch(() => null);
      const c = raw(row?.sys_class_name);
      if (TABLE_RE.test(c)) cls = c;
    }
    const parents = tableHierarchy ? await tableHierarchy(cls).catch(() => [cls]) : [cls];
    return { cls, tables: [...new Set([table, cls, ...(Array.isArray(parents) ? parents : [])])] };
  }

  /** The policy verdict for a record write over its whole table chain (also used by undo). */
  async function checkRecordWrite({ op, table, sysId, fields = {}, restoring = false }) {
    if (!TABLE_RE.test(table || '')) return { block: `"${table}" is not a valid table name.`, warnings: [], cls: table, tables: [table] };
    const chain = await recordChain(table, op === 'create' ? null : sysId);
    return { ...assessWriteChain({ op, tables: chain.tables, fields, restoring }), ...chain };
  }

  /** A value undo must not keep: it holds something the redactor would hide (a password in a script...). */
  const secretBearing = (value) => typeof value === 'string' && value !== '' && redactSecrets(value) !== value;

  /**
   * What undo needs to re-insert a deleted record. Secret-named, password-typed and secret-bearing values are never
   * kept in the audit log, so they are listed as `dropped` (shown on the approval card). Too large: no undo.
   * @returns {{undo: object|null, dropped: Array<{field: string, why: string}>, tooLarge: boolean}}
   */
  async function reinsertPayload(cls, sysId, row) {
    const snapshot = snapshotForReinsert(row);
    let types = {};
    try {
      types = Object.fromEntries((await getSchema(cls)).fields.map((f) => [f.name, f.type || '']));
    } catch {
      types = {};
    }
    const dropped = [];
    for (const key of Object.keys(snapshot)) {
      if (key === 'sys_id') continue;
      const why = SECRET_NAME_RE.test(key) ? 'secret field' : /^password/i.test(types[key] || '') ? 'password field' : secretBearing(snapshot[key]) ? 'contains a secret' : '';
      if (why) {
        dropped.push({ field: key, why });
        delete snapshot[key];
      }
    }
    if (JSON.stringify(snapshot).length > MAX_UNDO_CHARS) return { undo: null, dropped, tooLarge: true };
    return { undo: { kind: 'record', table: cls, sysId, deleted: true, snapshot }, dropped, tooLarge: false };
  }

  const deleteUndoText = ({ tooLarge, dropped }) =>
    tooLarge
      ? 'No undo: the record is too large to keep a copy.'
      : `Undo re-inserts the record with the same sys_id and values.${dropped.length ? ` Not kept, so not restored: ${dropped.map((d) => `${d.field} (${d.why})`).join(', ')}.` : ''} Records the platform deletes or clears along with it, journal entries and attachments are not restored either.`;

  /** Pages whose unsaved edits MySnowBuddy cannot see: a workspace record, or a portal page with a form. */
  function onInvisibleForm() {
    const here = control.page.currentUrl ? control.page.currentUrl() : control.page.currentPath();
    const [pathOnly, search = ''] = String(here || '').split('?');
    if (parseWorkspaceRecord(pathOnly)) return true;
    const id = new URLSearchParams(search).get('id') || '';
    return /^\/[a-z][a-z0-9_]*$/i.test(pathOnly) && PORTAL_FORM_PAGES.has(id.toLowerCase());
  }

  // ---- approval previews ----------------------------------------------------------------------------------

  const previews = {
    async click_ui_action(args) {
      const found = control.page.listUiActions();
      if (found.mode === 'none') return { blocked: 'No form with UI actions is open, so this will fail.' };
      let hit;
      try {
        hit = matchUiAction(found.actions, args.action).action;
      } catch (err) {
        return { blocked: err.message };
      }
      const record = await currentRecord();
      pinned.set(pinKey(args), `${record.table}|${record.sysId}`);
      const warnings = [];
      if (args.sysId && record.sysId !== args.sysId) warnings.push(`The open record is not ${args.sysId}; the click will be refused.`);
      if (record.dirty) warnings.push(`The form has unsaved changes${record.changedFields?.length ? ` (${record.changedFields.slice(0, 8).join(', ')})` : ''}: a submitting action saves them too.`);
      if (/delete/i.test(`${hit.label} ${hit.actionName || ''}`)) warnings.push('This button deletes the record.');
      if (found.mode === 'workspace') warnings.push('Workspace button, matched by its label (best effort).');
      return {
        target: `"${hit.label}"${hit.actionName ? ` (${hit.actionName})` : ''} on ${record.table || 'this page'} ${record.display || record.sysId || (record.isNewRecord ? '(new record)' : '')}`.trim(),
        warnings,
        undo: 'Not available: MySnowBuddy cannot undo a UI action.',
      };
    },

    // Cards show every value in full (they scroll): what is approved is exactly what is written.
    async create_record(args) {
      const clean = normalizeFieldValues(args.fields);
      const verdict = await checkRecordWrite({ op: 'create', table: args.table, fields: clean });
      const labels = await labelsOf(args.table);
      return {
        target: `New ${args.table} record`,
        blocked: verdict.block || placeholderProblemIn(clean) || (await columnProblem(args.table, clean)) || undefined,
        fieldList: Object.entries(clean).map(([field, value]) => ({ field, label: labels[field] || field, value })),
        warnings: verdict.warnings,
        undo: 'Undo deletes the new record.',
      };
    },

    async update_record(args) {
      const clean = normalizeFieldValues(args.fields);
      if (!SYS_ID_RE.test(args.sysId || '')) return { blocked: 'sysId is not a valid sys_id.' };
      const verdict = await checkRecordWrite({ op: 'update', table: args.table, sysId: args.sysId, fields: clean });
      const cls = verdict.cls || args.table;
      const [rows, labels] = await Promise.all([
        queryTable(cls, `sys_id=${args.sysId}`, [...Object.keys(clean), ...DISPLAY_COLUMNS.filter((c) => !(c in clean))], { limit: 1, displayValue: true }),
        labelsOf(cls),
      ]);
      const row = rows[0];
      if (!row) return { blocked: `No ${args.table} record with sys_id ${args.sysId}.` };
      const journal = journalFields(await getSchema(cls).then((s) => s.fields).catch(() => []), clean);
      const before = Object.fromEntries(Object.keys(clean).map((k) => [k, journal.includes(k) ? '' : raw(row[k])]));
      const shown = (k) => (journal.includes(k) ? '(new journal entry)' : flat(row[k]) && flat(row[k]) !== raw(row[k]) ? `${flat(row[k])} (${raw(row[k])})` : raw(row[k]));
      const diff = diffRecord(before, clean, labels).map((d) => ({ ...d, before: shown(d.field) }));
      const restorable = diff.filter((d) => !journal.includes(d.field));
      const notKept = restorable.filter((d) => secretBearing(before[d.field])).map((d) => d.field);
      const undoable = restorable.length - notKept.length;
      return {
        target: `${cls} ${displayOf(row) || args.sysId}${cls !== args.table ? ` (named as ${args.table})` : ''}`,
        blocked: verdict.block || placeholderProblemIn(clean) || (await columnProblem(cls, clean)) || undefined,
        fieldDiff: diff,
        notes: diff.length < Object.keys(clean).length ? [`${Object.keys(clean).length - diff.length} field(s) already have that value and are skipped.`] : undefined,
        warnings: [
          ...verdict.warnings,
          ...(journal.length ? [`${journal.join(', ')}: adds a journal entry, which undo cannot remove.`] : []),
          ...(notKept.length ? [`${notKept.join(', ')}: the old value holds a secret, so it is not kept and undo cannot restore it.`] : []),
        ],
        undo: undoable ? `Undo restores the previous values${journal.length || notKept.length ? ' (except the fields named above)' : ''}.` : 'Not available for these fields.',
      };
    },

    async delete_record(args) {
      if (!SYS_ID_RE.test(args.sysId || '')) return { blocked: 'sysId is not a valid sys_id.' };
      const verdict = await checkRecordWrite({ op: 'delete', table: args.table, sysId: args.sysId });
      const cls = verdict.cls || args.table;
      const [rows, rawRow, labels, schema] = await Promise.all([
        queryTable(cls, `sys_id=${args.sysId}`, [], { limit: 1, displayValue: true }),
        fetchRecord(cls, args.sysId, []).catch(() => null),
        labelsOf(cls),
        getSchema(cls).catch(() => null),
      ]);
      const row = rows[0];
      if (!row || !rawRow) return { blocked: `No ${args.table} record with sys_id ${args.sysId}.` };
      const passwordTyped = new Set((schema?.fields || []).filter((f) => /^password/i.test(f.type || '')).map((f) => f.name));
      // The whole record, from its real class: every non-empty field except secrets, which are named instead.
      const fieldList = Object.entries(row)
        .filter(([k, v]) => flat(v) !== '' && !SECRET_NAME_RE.test(k) && !passwordTyped.has(k))
        .map(([field, v]) => ({ field, label: labels[field] || field, value: flat(v) }));
      const kept = await reinsertPayload(cls, args.sysId, rawRow);
      return {
        target: `${cls} ${displayOf(row) || args.sysId}${cls !== args.table ? ` (named as ${args.table})` : ''}`,
        blocked: verdict.block || undefined,
        fieldList,
        warnings: verdict.warnings,
        undo: deleteUndoText(kept),
      };
    },

    async run_background_script(args) {
      const code = String(args.code ?? '');
      const { result } = await runVerify({ code, kind: 'background_script' });
      const warnings = [];
      if (!dryRuns.has(hashText(code))) warnings.push('This exact script has not been dry-run in this session. If unsure, decline and ask for dry_run_script first.');
      return {
        after: code,
        verification: { ok: result.ok, summary: result.summary },
        risk: formatRiskSummary(analyzeScriptRisk(code)),
        warnings,
        undo: 'Not available: a real run cannot be undone.',
      };
    },

    async switch_update_set(args) {
      const target = await resolveUpdateSet(args.updateSet);
      const before = await control.session.readCurrentUpdateSet().catch(() => null);
      return {
        target: `${before?.name || 'unknown'} -> ${target.name}`,
        blocked: target.state !== 'in progress' ? `"${target.name}" is ${target.state || 'not in progress'}.` : undefined,
        undo: before?.sysId ? `Undo switches back to "${before.name || before.sysId}".` : 'Undo is not available: the current update set could not be read.',
      };
    },

    async switch_application_scope(args) {
      const target = await resolveScope(args.scope);
      const before = await control.session.readCurrentScope().catch(() => null);
      return {
        target: `${before?.name || 'unknown'} -> ${target.name}${target.scope && target.scope !== 'global' ? ` (${target.scope})` : ''}`,
        undo: before?.sysId ? `Undo switches back to "${before.name || before.sysId}".` : 'Undo is not available: the current application could not be read.',
      };
    },

    async impersonate_user(args) {
      const target = await resolveOne('sys_user', args.user, ['user_name'], ['user_name', 'name', 'active'], 'user');
      const roles = await control.session.readUserRoles(target.sys_id).catch(() => null);
      const warnings = ['Every action in this browser session, by you or an agent, runs as this user until impersonation ends.'];
      if (roles?.includes('admin')) warnings.push('This user has the admin role.');
      if (String(target.active) === 'false') warnings.push('This user is inactive; impersonation will be refused.');
      return { target: `${target.name || target.user_name} (${target.user_name})`, warnings, undo: 'end_impersonation (or undo) returns to your own user.' };
    },

    async run_atf(args) {
      if (args.progressId && !args.suite) return {};
      const row = await resolveSuite(args.suite);
      const warnings = isGuardedEnv(getInstanceInfo().env) ? ['This is not a recognised dev/test instance. ATF usually should not run on production.'] : [];
      return { target: `Suite "${row.name}"`, warnings, undo: 'Not applicable: ATF rolls back the records its steps create.' };
    },
  };

  return {
    tools,
    async preview(name, args = {}) {
      const fn = previews[name];
      if (!fn) return null;
      try {
        return (await fn(args)) || {};
      } catch (err) {
        return { blocked: err.message };
      }
    },
    /** Record-write policy over the record's real class chain; undo_last_write runs every undo through it. */
    checkRecordWrite,
    /** undo_last_write for the session kinds; returns true when it handled the entry. */
    async undoSession(u) {
      if (u.kind === 'updateSet') {
        const { after } = await control.session.switchUpdateSet(u.sysId);
        if (after?.sysId !== u.sysId && after?.preference !== u.sysId) throw new Error(`Could not switch back to update set "${u.name || u.sysId}". Use the picker.`);
        return true;
      }
      if (u.kind === 'scope') {
        const { after } = await control.session.switchScope(u.sysId);
        if (after?.sysId !== u.sysId) throw new Error(`Could not switch back to application "${u.name || u.sysId}". Use the picker.`);
        return true;
      }
      if (u.kind === 'impersonation') {
        await control.session.endImpersonation();
        control.page.reloadSoon(400);
        return true;
      }
      return false;
    },
  };
}
