// Instance health and upgrade-readiness scan: data collection.
//
// READ-ONLY: only GET requests through the Table and Aggregate APIs, under the
// signed-in user's own session and ACLs. The rules and scoring live in
// src/lib/healthScan.js; this module fetches rows and feeds them in.
//
// Self-contained on purpose (runHealthScan(options, onProgress, signal) returns a
// plain report object), so it can be exposed as an agent / MCP tool later.
//
// Every column the scan relies on is checked against sys_dictionary first:
// ServiceNow silently ignores a condition on a column that does not exist and
// returns every row, so a missing column is reported as "not available on this
// instance" instead of being queried.
//
// Custom vs baseline (out-of-box): a record counts as custom when sys_update_xml
// (Customer Updates) holds an update named "<table>_<sys_id>" for it, or when it
// lives in an application whose scope starts with this instance's vendor prefix
// (x_<glide.appcreator.company.code>_). Baseline records loaded by upgrades and
// plugins have no customer update. Customized baseline records DO have one, so
// they are scanned too (their whole script, including ServiceNow's original code).
// sys_metadata.sys_customer_update is not used: ServiceNow relabelled it
// "No Longer Used" years ago.

import { sessionHeaders } from './sessionToken.js';
import { callPage } from './pageBridge.js';
import { runSecurityAudit } from './securityAudit.js';
import { fetchScopes } from './scopeExport.js';
import { fetchLiveUpdateSets } from './updateSets.js';
import {
  SCAN_TABLES,
  STEP_DEFS,
  MAX_SCRIPT_CHARS,
  normalizeScanOptions,
  parseUpdateName,
  evidenceClasses,
  classToTable,
  customerUpdateQuery,
  parseSnDate,
  scanScript,
  recordChecks,
  checkBusinessRules,
  checkBusinessRuleOrder,
  checkClientCallable,
  checkScheduledJobs,
  checkUpdateSets,
  skippedUpgradeFindings,
  securityFindings,
  buildReport,
} from '../lib/healthScan.js';

const PAGE = 1000;
const ID_CHUNK = 80;
const EVIDENCE_ROWS_PER_TABLE = 10000;
const UPDATE_SET_ROWS = 5000;
const MAX_SETS_COUNTED = 60;
const MAX_SKIPPED_LISTED = 50;

const str = (v) => (v == null ? '' : typeof v === 'object' ? String(v.value ?? '') : String(v));
const isTrue = (v) => str(v) === 'true' || str(v) === '1';

// ---- cancellable Table / Aggregate API access ------------------------------------------------

function abortError() {
  const err = new Error('Scan cancelled.');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

const isAbort = (err) => err?.name === 'AbortError';

async function getJson(path, params, signal) {
  throwIfAborted(signal);
  const response = await fetch(`${path}?${params.toString()}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: await sessionHeaders(),
    signal,
  });
  if (!response.ok) {
    const table = decodeURIComponent(path.split('/').pop());
    let message = `Reading ${table} failed (${response.status}).`;
    if (response.status === 403) message = `Your user cannot read ${table} (403).`;
    if (response.status === 401) message = 'The session expired. Reload the page and sign in again.';
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

async function fetchRows(table, query, fields, { limit = 100, offset = 0 } = {}, signal) {
  const params = new URLSearchParams();
  if (query) params.set('sysparm_query', query);
  if (fields?.length) params.set('sysparm_fields', fields.join(','));
  params.set('sysparm_limit', String(Math.max(1, Math.min(limit, PAGE))));
  if (offset) params.set('sysparm_offset', String(offset));
  params.set('sysparm_display_value', 'false');
  params.set('sysparm_exclude_reference_link', 'true');
  params.set('sysparm_no_count', 'true');
  const data = await getJson(`/api/now/table/${encodeURIComponent(table)}`, params, signal);
  return data.result || [];
}

/** Page through a query, one request at a time, up to `max` rows. */
async function fetchPaged(table, query, fields, max, signal) {
  const rows = [];
  while (rows.length < max) {
    const want = Math.min(PAGE, max - rows.length);
    // eslint-disable-next-line no-await-in-loop -- sequential paging keeps the load on the instance low.
    const page = await fetchRows(table, query, fields, { limit: want, offset: rows.length }, signal);
    rows.push(...page);
    if (page.length < want) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function countRows(table, query, signal) {
  const params = new URLSearchParams({ sysparm_count: 'true' });
  if (query) params.set('sysparm_query', query);
  const data = await getJson(`/api/now/stats/${encodeURIComponent(table)}`, params, signal);
  const count = Number(data?.result?.stats?.count);
  if (!Number.isFinite(count)) throw new Error(`The instance returned no count for ${table}.`);
  return count;
}

async function fetchByIds(table, ids, fields, extraQuery, signal) {
  const rows = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const query = `sys_idIN${chunk.join(',')}${extraQuery ? `^${extraQuery}` : ''}`;
    // eslint-disable-next-line no-await-in-loop -- chunks stay sequential.
    rows.push(...(await fetchRows(table, query, fields, { limit: chunk.length }, signal)));
  }
  return rows;
}

const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- schema ----------------------------------------------------------------------------------

/** Which tables exist and which columns they have (inherited columns included). */
async function loadSchema(tables, signal) {
  const parent = new Map();
  const asked = new Set();
  let pending = [...new Set(tables)];
  for (let depth = 0; depth < 10 && pending.length; depth += 1) {
    pending.forEach((t) => asked.add(t));
    // eslint-disable-next-line no-await-in-loop -- each level depends on the previous one.
    const rows = await fetchRows('sys_db_object', `nameIN${pending.join(',')}`, ['name', 'super_class.name'], { limit: PAGE }, signal);
    const next = [];
    rows.forEach((r) => {
      const name = str(r.name);
      const sup = str(r['super_class.name']);
      parent.set(name, sup);
      if (sup && !asked.has(sup)) next.push(sup);
    });
    pending = [...new Set(next)];
  }

  const columns = new Map([...parent.keys()].map((t) => [t, new Map()]));
  if (columns.size) {
    const { rows } = await fetchPaged(
      'sys_dictionary',
      `nameIN${[...columns.keys()].join(',')}^elementISNOTEMPTY^ORDERBYname^ORDERBYelement`,
      ['name', 'element', 'internal_type', 'reference'],
      12000,
      signal
    );
    rows.forEach((r) => columns.get(str(r.name))?.set(str(r.element), { type: str(r.internal_type), reference: str(r.reference) }));
  }

  const chain = (table) => {
    const out = [];
    let current = table;
    while (current && parent.has(current) && !out.includes(current)) {
      out.push(current);
      current = parent.get(current);
    }
    return out;
  };
  const column = (table, name) => {
    for (const t of chain(table)) {
      const hit = columns.get(t)?.get(name);
      if (hit) return hit;
    }
    return null;
  };
  return { exists: (t) => parent.has(t), has: (t, c) => Boolean(column(t, c)), column };
}

function resolveFields(def, schema) {
  const missing = [];
  const want = (col) => {
    if (schema.has(def.table, col)) return true;
    missing.push(col);
    return false;
  };
  const fields = ['sys_id', 'sys_updated_on', 'sys_updated_by'];
  if (want(def.nameField.split('.')[0])) fields.push(def.nameField);
  const hasScope = schema.has(def.table, 'sys_scope');
  if (hasScope) fields.push('sys_scope', 'sys_scope.name', 'sys_scope.scope');
  const scripts = def.scripts.filter((s) => want(s.field));
  scripts.forEach((s) => fields.push(s.field));
  (def.extra || []).forEach((c) => want(c) && fields.push(c));
  const hasActive = schema.has(def.table, 'active');
  if (hasActive) fields.push('active');
  const hasGate = Boolean(def.gate) && schema.has(def.table, def.gate);
  if (hasGate) fields.push(def.gate);
  const hasClass = schema.has(def.table, 'sys_class_name');
  // A record's customer update is named after its own class (catalog_ui_policy_<id> read through sys_ui_policy).
  if (hasClass) fields.push('sys_class_name');
  return { fields: [...new Set(fields)], scripts, missing, hasActive, hasGate, hasScope, hasClass };
}

/** Conditions every row must meet: active, scripts switched on, exact class. */
function rowFilter(def, resolved) {
  const parts = [];
  if (resolved.hasActive) parts.push('active=true');
  if (resolved.hasGate) parts.push(`${def.gate}=true`);
  if (def.exactClass && resolved.hasClass) parts.push(`sys_class_name=${def.table}`);
  return parts.join('^');
}

const joinQuery = (...parts) => parts.filter(Boolean).join('^');
const ORDER = 'ORDERBYDESCsys_updated_on^ORDERBYsys_id';

// ---- custom-record evidence ------------------------------------------------------------------

/** sys_ids with a customer update named "<class>_<sys_id>" (the table or a child class), most recently updated first. */
async function customerUpdateIds(def, signal) {
  const { rows, truncated } = await fetchPaged('sys_update_xml', customerUpdateQuery(def), ['name'], EVIDENCE_ROWS_PER_TABLE, signal);
  const classes = evidenceClasses(def);
  const ids = [];
  const seen = new Set();
  rows.forEach((r) => {
    const parsed = parseUpdateName(str(r.name), classes);
    if (parsed && !seen.has(parsed.sysId)) {
      seen.add(parsed.sysId);
      ids.push(parsed.sysId);
    }
  });
  return { ids, truncated };
}

/** Which of `names` ("<class>_<sys_id>") have a customer update. */
async function customerUpdateNames(names, signal) {
  const found = new Set();
  const unique = [...new Set(names)];
  for (let i = 0; i < unique.length; i += 40) {
    // eslint-disable-next-line no-await-in-loop -- chunks stay sequential.
    const hits = await fetchRows('sys_update_xml', `nameIN${unique.slice(i, i + 40).join(',')}`, ['name'], { limit: PAGE }, signal);
    hits.forEach((h) => found.add(str(h.name)));
  }
  return found;
}

/** The subset of `rows` that have a customer update (named after each row's own class). */
async function withCustomerUpdates(def, rows, signal) {
  const nameOf = (r) => `${str(r.sys_class_name) || def.table}_${str(r.sys_id)}`;
  const found = await customerUpdateNames(rows.map(nameOf), signal);
  return rows.filter((r) => found.has(nameOf(r)));
}

/** The subset of `ids` (rows of `table`) that also match `condition`. */
async function idsMatching(table, ids, condition, signal) {
  const keep = new Set();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    // eslint-disable-next-line no-await-in-loop -- chunks stay sequential.
    const rows = await fetchRows(table, joinQuery(`sys_idIN${chunk.join(',')}`, condition), ['sys_id'], { limit: chunk.length }, signal);
    rows.forEach((r) => keep.add(str(r.sys_id)));
  }
  return keep;
}

/** The scope / date condition of the scan mode ('' for the whole instance). */
function baseCondition(plan) {
  if (plan.options.mode === 'scope') return `sys_scope=${plan.options.scopeId}`;
  if (plan.options.mode === 'recent') {
    return `sys_updated_on>=javascript:gs.daysAgoStart(${plan.options.days})${plan.userName ? `^sys_updated_by=${plan.userName}` : ''}`;
  }
  return '';
}

/**
 * keepRecords for the security audit: narrows its record-level checks (open ACLs, public pages
 * and widgets, scripted REST) to the records this scan covers, so a custom-only scan does not
 * list baseline ACLs. Null means "everything" (whole instance with baseline included).
 */
function makeRecordFilter(plan, signal) {
  if (plan.options.mode === 'updateset') {
    return async (table, ids) => new Set(ids.filter((id) => plan.updateSetNames.has(`${table}_${id}`)));
  }
  const base = baseCondition(plan);
  if (!base && !plan.customOnly) return null;
  return async (table, ids) => {
    let keep = [...new Set(ids)];
    if (base && keep.length) keep = [...(await idsMatching(table, keep, base, signal))];
    if (plan.customOnly && keep.length) {
      const custom = await customerUpdateNames(keep.map((id) => `${table}_${id}`), signal);
      const rest = keep.filter((id) => !custom.has(`${table}_${id}`));
      const vendor = plan.vendorPrefix && rest.length ? await idsMatching(table, rest, `sys_scope.scopeSTARTSWITH${plan.vendorPrefix}`, signal) : new Set();
      keep = keep.filter((id) => custom.has(`${table}_${id}`) || vendor.has(id));
    }
    return new Set(keep);
  };
}

/** "x_<company code>_" for this instance's own scoped apps, or null. */
async function vendorScopePrefix(schema, signal) {
  if (!schema.exists('sys_properties')) return null;
  try {
    const rows = await fetchRows('sys_properties', 'name=glide.appcreator.company.code', ['value'], { limit: 1 }, signal);
    const code = str(rows[0]?.value).trim().toLowerCase();
    return /^[a-z0-9]{1,24}$/.test(code) ? `x_${code}_` : null;
  } catch (err) {
    if (isAbort(err)) throw err;
    return null;
  }
}

async function currentUserName() {
  const info = await callPage('getUserInfo').catch(() => null);
  const name = str(info?.userName).trim();
  if (!name || /[\^=]/.test(name) || /^\s*javascript:/i.test(name)) {
    throw new Error('Could not tell which user you are on this page. Reload the page and try again, or untick "Last updated by me".');
  }
  return name;
}

// ---- step 1: collect --------------------------------------------------------------------------

async function collectTable(def, resolved, plan, signal) {
  const filter = rowFilter(def, resolved);
  const max = plan.options.maxPerTable;
  const { fields } = resolved;

  if (plan.options.mode === 'updateset') {
    const ids = [...(plan.updateSetIds.get(def.table) || [])];
    const rows = ids.length ? await fetchByIds(def.table, ids.slice(0, max), fields, filter, signal) : [];
    return { rows, truncated: ids.length > max };
  }

  if (plan.options.mode === 'scope' && !resolved.hasScope) throw new Error('this table has no application (sys_scope) column here');
  const base = baseCondition(plan);

  if (!plan.customOnly) {
    const { rows, truncated } = await fetchPaged(def.table, joinQuery(base, filter, ORDER), fields, max, signal);
    return { rows: plan.recentCheck(rows), truncated };
  }

  if (plan.options.mode === 'recent') {
    const { rows, truncated } = await fetchPaged(def.table, joinQuery(base, filter, ORDER), fields, max, signal);
    const recent = plan.recentCheck(rows);
    const inVendorScope = (r) => plan.vendorPrefix && str(r['sys_scope.scope']).startsWith(plan.vendorPrefix);
    const custom = await withCustomerUpdates(def, recent.filter((r) => !inVendorScope(r)), signal);
    return { rows: [...recent.filter(inVendorScope), ...custom], truncated };
  }

  // Whole instance (or the global application): customer updates first, then fetch those records.
  const evidence = await customerUpdateIds(def, signal);
  const rows = await fetchByIds(def.table, evidence.ids.slice(0, max), fields, joinQuery(base, filter), signal);
  let truncated = evidence.truncated || evidence.ids.length > max;
  if (plan.vendorPrefix && resolved.hasScope && plan.options.mode === 'instance' && rows.length < max) {
    const seen = new Set(rows.map((r) => str(r.sys_id)));
    const vendor = await fetchPaged(def.table, joinQuery(`sys_scope.scopeSTARTSWITH${plan.vendorPrefix}`, filter, ORDER), fields, max - rows.length, signal);
    vendor.rows.forEach((r) => !seen.has(str(r.sys_id)) && rows.push(r));
    truncated = truncated || vendor.truncated;
  }
  return { rows, truncated, evidenceCapped: evidence.truncated };
}

const toRecord = (def, row) => ({ sysId: str(row.sys_id), name: str(row[def.nameField]) || '(unnamed)', scope: str(row['sys_scope.name']), row });

// ---- step 4: configuration ------------------------------------------------------------------------

/** Query condition selecting client_callable_script_include ACLs, or a reason it cannot be built. */
async function callableAclQuery(schema, signal) {
  const typeColumn = schema.column('sys_security_acl', 'type');
  if (!typeColumn) return { reason: 'sys_security_acl has no type column on this instance' };
  const TYPE = 'client_callable_script_include';
  if (typeColumn.type === 'reference') {
    const ref = typeColumn.reference;
    const refTable = /^[a-z][a-z0-9_]*$/.test(ref) && !/^[0-9a-f]{32}$/.test(ref) ? ref : 'sys_security_type';
    const rows = await fetchRows(refTable, `name=${TYPE}`, ['sys_id', 'name'], { limit: 5 }, signal);
    // Re-check the name: a condition on a missing column would be ignored and return any row.
    const hit = rows.find((r) => str(r.name) === TYPE);
    if (!hit) return { reason: `this instance has no ${TYPE} ACL type` };
    return { query: `type=${str(hit.sys_id)}` };
  }
  const choices = await fetchRows('sys_choice', `name=sys_security_acl^element=type^value=${TYPE}`, ['value'], { limit: 5 }, signal);
  if (!choices.some((c) => str(c.value) === TYPE)) return { reason: `this instance has no ${TYPE} ACL type` };
  return { query: `type=${TYPE}` };
}

async function runConfigChecks(ctx) {
  const { schema, collected, options, signal, step, emit } = ctx;
  const findings = [];
  const byTable = (table) => collected.find((c) => c.def.table === table);
  const skip = (text) => step.notes.push(text);

  // Business rules.
  const brs = byTable('sys_script');
  if (!brs) skip('Business rule checks skipped: no business rules were scanned.');
  else {
    const has = (c) => !brs.resolved.missing.includes(c);
    if (!has('collection') || !has('when') || !has('action_update')) skip('Business rule checks skipped: collection/when/action columns are not on this instance.');
    else {
      if (has('condition') && has('filter_condition')) findings.push(...checkBusinessRules(brs.records));
      else skip('No-condition check skipped: condition/filter_condition columns are not on this instance.');
      if (has('order')) findings.push(...checkBusinessRuleOrder(brs.records));
      else skip('Same-order check skipped: the order column is not on this instance.');
    }
  }
  emit('Business rules checked');

  // Client-callable Script Includes without an ACL.
  const sis = byTable('sys_script_include');
  const callable = sis && !sis.resolved.missing.includes('client_callable') ? sis.records.filter((r) => isTrue(r.row.client_callable)) : [];
  if (callable.length) {
    try {
      const acl = await callableAclQuery(schema, signal);
      if (acl.reason) skip(`Client-callable ACL check skipped: ${acl.reason}.`);
      else {
        const { rows, truncated } = await fetchPaged('sys_security_acl', joinQuery(acl.query, 'active=true'), ['name'], 5000, signal);
        findings.push(...checkClientCallable(callable, new Set(rows.map((r) => str(r.name)))));
        if (truncated) skip('Over 5,000 client-callable ACLs; only the first 5,000 were compared.');
      }
    } catch (err) {
      if (isAbort(err)) throw err;
      skip(`Client-callable ACL check failed: ${err.message}`);
    }
  }
  emit('Script Include ACLs checked');

  // Scheduled jobs.
  const jobs = byTable('sysauto_script');
  if (jobs) {
    if (jobs.resolved.missing.includes('run_type') || jobs.resolved.missing.includes('run_period')) skip('Scheduled job frequency check skipped: run_type/run_period are not on this instance.');
    else findings.push(...checkScheduledJobs(jobs.records));
  }

  // Update sets.
  try {
    if (!schema.exists('sys_update_set')) skip('Update set checks skipped: sys_update_set is not readable.');
    else if (!schema.has('sys_update_set', 'state') || !schema.has('sys_update_set', 'sys_created_on')) skip('Update set checks skipped: state/sys_created_on columns missing.');
    else {
      let query = 'state=in progress';
      if (options.mode === 'updateset') query = `sys_id=${options.updateSetId}`;
      else if (options.mode === 'scope') {
        if (schema.has('sys_update_set', 'application')) query += `^application=${options.scopeId}`;
        else query = '';
      }
      if (!query) skip('Update set checks skipped: update sets have no application column here.');
      else {
        const fields = ['sys_id', 'name', 'sys_created_on', 'state'];
        if (schema.has('sys_update_set', 'is_default')) fields.push('is_default');
        const { rows: sets } = await fetchPaged('sys_update_set', `${query}^ORDERBYsys_created_on`, fields, 200, signal);
        // The chosen update set is checked whatever its state; otherwise only open ones.
        const live = sets.filter((s) => (options.mode === 'updateset' || str(s.state) === 'in progress') && !isTrue(s.is_default) && str(s.name) !== 'Default');
        const counts = new Map();
        if (schema.has('sys_update_xml', 'update_set')) {
          for (const set of live.slice(0, MAX_SETS_COUNTED)) {
            // eslint-disable-next-line no-await-in-loop -- one small count per update set.
            counts.set(str(set.sys_id), await countRows('sys_update_xml', `update_set=${str(set.sys_id)}`, signal));
          }
          if (live.length > MAX_SETS_COUNTED) skip(`Entry counts read for the ${MAX_SETS_COUNTED} oldest in-progress update sets only.`);
        }
        findings.push(...checkUpdateSets(live, counts, Date.now()));
        emit(`${live.length} in-progress update set(s) checked`);
      }
    }
  } catch (err) {
    if (isAbort(err)) throw err;
    skip(`Update set checks failed: ${err.message}`);
  }
  return findings;
}

// ---- step 5: upgrade readiness -------------------------------------------------------------------

async function runSkippedRecordCheck({ schema, signal, step }) {
  const LOG = 'sys_upgrade_history_log';
  if (!schema.exists(LOG) || !schema.exists('sys_upgrade_history')) {
    step.notes.push('Skipped-record review not available: the upgrade history tables are not readable here.');
    return { findings: [], count: null };
  }
  for (const col of ['disposition', 'upgrade_history']) {
    if (!schema.has(LOG, col)) {
      step.notes.push(`Skipped-record review not available: ${LOG}.${col} is not on this instance.`);
      return { findings: [], count: null };
    }
  }

  // Choice values differ by release, so find them by label.
  const choices = await fetchRows('sys_choice', `name=${LOG}^elementINdisposition,resolution_status`, ['element', 'value', 'label', 'language'], { limit: 300 }, signal);
  const pick = (element, re) => {
    const own = choices.filter((c) => str(c.element) === element && re.test(str(c.label).trim()));
    return str((own.find((c) => !str(c.language) || str(c.language) === 'en') || own[0])?.value);
  };
  // Every "Skipped..." disposition (Skipped, Skipped Error, Skipped Manual Merge, ...), by label.
  const dispositionLabels = new Map();
  choices
    .filter((c) => str(c.element) === 'disposition' && /^skipped/i.test(str(c.label).trim()) && (!str(c.language) || str(c.language) === 'en'))
    .forEach((c) => {
      const value = str(c.value);
      if (/^[\w .-]+$/.test(value) && !dispositionLabels.has(value)) dispositionLabels.set(value, str(c.label).trim());
    });
  if (!dispositionLabels.size) {
    step.notes.push('Skipped-record review not available: no "Skipped" disposition choice was found on this instance.');
    return { findings: [], count: null };
  }
  step.notes.push(`Upgrade dispositions counted as skipped: ${[...new Set(dispositionLabels.values())].join(', ')}.`);

  const historyFields = ['sys_id', 'sys_created_on'];
  if (schema.has('sys_upgrade_history', 'to_version')) historyFields.push('to_version');
  const [latest] = await fetchRows('sys_upgrade_history', 'ORDERBYDESCsys_created_on', historyFields, { limit: 1 }, signal);
  if (!latest) {
    step.notes.push('No upgrade history on this instance.');
    return { findings: [], count: 0 };
  }
  const label = str(latest.to_version) || `upgrade of ${str(latest.sys_created_on).slice(0, 10)}`;

  let query = `upgrade_history=${str(latest.sys_id)}^dispositionIN${[...dispositionLabels.keys()].join(',')}`;
  if (schema.has(LOG, 'resolution_status')) {
    const notReviewed = pick('resolution_status', /^not\s*reviewed$/i);
    query += notReviewed ? `^resolution_status=${notReviewed}^ORresolution_statusISEMPTY` : '^resolution_statusISEMPTY';
  } else {
    step.notes.push('Review status is not on this instance, so every skipped record is listed.');
  }
  const count = await countRows(LOG, query, signal);
  const fields = ['sys_id', 'disposition', ...['file_name', 'target_name', 'type', 'priority'].filter((c) => schema.has(LOG, c))];
  const order = schema.has(LOG, 'priority') ? '^ORDERBYpriority' : '';
  const rows = count ? await fetchRows(LOG, `${query}${order}`, fields, { limit: MAX_SKIPPED_LISTED }, signal) : [];
  if (count > rows.length) step.notes.push(`${count} skipped records await review; ${rows.length} are listed, highest priority first.`);
  return { findings: skippedUpgradeFindings(rows, { upgradeLabel: label, dispositionLabels }), count, label };
}

// ---- main ------------------------------------------------------------------------------------------

/**
 * Run the scan.
 * @param {object} rawOptions   see normalizeScanOptions in src/lib/healthScan.js
 * @param {(state: {steps: Array, current: string}) => void} onProgress
 * @param {AbortSignal} [signal] cancels in-flight requests and stops the scan; the partial report is returned
 * @returns {Promise<object>} report (see buildReport)
 */
export async function runHealthScan(rawOptions = {}, onProgress = () => {}, signal = undefined) {
  const options = normalizeScanOptions(rawOptions);
  const startedAt = Date.now();
  const steps = STEP_DEFS.map((d) => ({ id: d.id, label: d.label, status: 'pending', detail: '', notes: [] }));
  const stepOf = (id) => steps.find((s) => s.id === id);
  const emit = (current) => {
    try {
      onProgress({ steps: steps.map((s) => ({ ...s, notes: [...s.notes] })), current });
    } catch {
      // A broken progress listener must not stop the scan.
    }
  };
  const findings = [];
  const tables = [];
  const notes = [];
  const collected = [];
  const stash = { antipattern: [], upgrade: [] };
  let baseline = {};
  let cancelled = false;

  const runStep = async (id, fn) => {
    const step = stepOf(id);
    step.status = 'running';
    emit(id);
    try {
      const result = await fn(step, (detail) => {
        step.detail = detail;
        emit(id);
      });
      if (step.status === 'running') step.status = 'done';
      return result;
    } catch (err) {
      if (isAbort(err) || signal?.aborted) throw abortError();
      step.status = 'error';
      step.detail = err.message || String(err);
      return null;
    } finally {
      emit(id);
    }
  };

  try {
    throwIfAborted(signal);
    const defs = options.tables ? SCAN_TABLES.filter((d) => options.tables.includes(d.table)) : SCAN_TABLES;
    let schema = null;
    let plan = null;

    await runStep('collect', async (step, progress) => {
      progress('Reading the data dictionary');
      schema = await loadSchema(
        [...defs.map((d) => d.table), 'sys_update_xml', 'sys_update_set', 'sys_upgrade_history', 'sys_upgrade_history_log', 'sys_security_acl', 'sys_properties'],
        signal
      );
      const customOnly = !options.includeBaseline && (options.mode === 'instance' || options.mode === 'recent' || (options.mode === 'scope' && options.scopeId === 'global'));
      if (customOnly && (!schema.exists('sys_update_xml') || !schema.has('sys_update_xml', 'name'))) {
        throw new Error('Customer updates (sys_update_xml) are not readable, so custom code cannot be told apart from baseline. Tick "Include baseline records" to scan everything.');
      }
      plan = { options, customOnly, vendorPrefix: null, userName: '', updateSetIds: new Map(), updateSetNames: new Set(), recentCheck: (rows) => rows };
      if (customOnly) plan.vendorPrefix = await vendorScopePrefix(schema, signal);
      if (options.mode === 'recent') {
        if (options.onlyMine) plan.userName = await currentUserName();
        // Guard against the server ignoring the date condition: re-check it here (one day of slack for time zones).
        const cutoff = Date.now() - (options.days + 1) * 86400000;
        plan.recentCheck = (rows) => rows.filter((r) => (parseSnDate(r.sys_updated_on) ?? Infinity) >= cutoff);
      }
      if (options.mode === 'updateset') {
        if (!schema.has('sys_update_xml', 'update_set')) throw new Error('sys_update_xml.update_set is not on this instance.');
        progress('Reading the update set');
        const { rows, truncated } = await fetchPaged('sys_update_xml', `update_set=${options.updateSetId}^ORDERBYname`, ['name'], UPDATE_SET_ROWS, signal);
        // Child classes (catalog_ui_policy_<id>) are read through their scanned parent table.
        const tableOf = classToTable(defs);
        const classes = [...tableOf.keys()];
        rows.forEach((r) => {
          const name = str(r.name);
          if (/^[a-z0-9_]+_[0-9a-f]{32}$/.test(name)) plan.updateSetNames.add(name);
          const parsed = parseUpdateName(name, classes);
          if (!parsed) return;
          const table = tableOf.get(parsed.table);
          if (!plan.updateSetIds.has(table)) plan.updateSetIds.set(table, new Set());
          plan.updateSetIds.get(table).add(parsed.sysId);
        });
        if (truncated) step.notes.push(`The update set has over ${UPDATE_SET_ROWS} entries; only the first ${UPDATE_SET_ROWS} were read.`);
      }

      if (options.includeBaseline) baseline = { method: 'all', label: 'Baseline (out-of-box) records included' };
      else if (options.mode === 'updateset') baseline = { method: 'update-set', label: 'Records captured in the update set' };
      else if (!customOnly) baseline = { method: 'scope', label: 'All records in the chosen application' };
      else {
        baseline = {
          method: 'customer-updates',
          label: `Records with a customer update (sys_update_xml)${plan.vendorPrefix ? ` or in ${plan.vendorPrefix}* applications` : ''}`,
          vendorPrefix: plan.vendorPrefix,
        };
      }

      const seen = new Set();
      for (const def of defs) {
        throwIfAborted(signal);
        const entry = { table: def.table, label: def.label, status: 'scanned', records: 0, scripts: 0, lines: 0, truncated: false, missing: [], note: '' };
        tables.push(entry);
        if (!schema.exists(def.table)) {
          entry.status = 'unavailable';
          entry.note = 'not available on this instance';
          continue;
        }
        const resolved = resolveFields(def, schema);
        entry.missing = resolved.missing;
        if (!resolved.scripts.length) {
          entry.status = 'unavailable';
          entry.note = 'script column not available on this instance';
          continue;
        }
        progress(`${def.label}s...`);
        try {
          // eslint-disable-next-line no-await-in-loop -- tables are read one after another to keep the load low.
          const { rows, truncated, evidenceCapped } = await collectTable(def, resolved, plan, signal);
          const records = rows.filter((r) => !seen.has(str(r.sys_id))).map((r) => toRecord(def, r));
          records.forEach((r) => seen.add(r.sysId));
          entry.records = records.length;
          entry.truncated = Boolean(truncated);
          if (truncated) entry.note = `capped at ${options.maxPerTable} records${evidenceCapped ? ' (customer-update history is very long; older custom records may be missed)' : ''}`;
          collected.push({ def, resolved, records, entry });
        } catch (err) {
          if (isAbort(err)) throw err;
          entry.status = 'error';
          entry.note = err.message;
        }
      }
      const total = collected.reduce((n, c) => n + c.records.length, 0);
      progress(`${total} record(s) in ${collected.length} table(s)`);
    });

    const items = [];
    collected.forEach((c) =>
      c.records.forEach((record) =>
        c.resolved.scripts.forEach((script) => {
          if (c.resolved.hasGate && !isTrue(record.row[c.def.gate])) return;
          const code = str(record.row[script.field]);
          if (!code.trim()) return;
          items.push({ c, record, script, code });
        })
      )
    );

    await runStep('code', async (step, progress) => {
      if (!collected.length) {
        step.status = 'skipped';
        step.detail = 'No records to analyse.';
        return;
      }
      let tooLarge = 0;
      let added = 0;
      for (let i = 0; i < items.length; i += 1) {
        if (i % 15 === 0) {
          throwIfAborted(signal);
          progress(`${i} of ${items.length} scripts`);
          // eslint-disable-next-line no-await-in-loop -- let the page breathe between batches.
          await yieldToUi();
        }
        const { c, record, script, code } = items[i];
        if (code.length > MAX_SCRIPT_CHARS) {
          tooLarge += 1;
          continue;
        }
        c.entry.scripts += 1;
        c.entry.lines += code.split('\n').length;
        scanScript({ code, def: c.def, script, record }).forEach((f) => {
          if (f.category === 'code') {
            findings.push(f);
            added += 1;
          } else if (f.category === 'upgrade') stash.upgrade.push(f);
          else stash.antipattern.push(f);
        });
      }
      if (tooLarge) step.notes.push(`${tooLarge} script(s) over ${MAX_SCRIPT_CHARS / 1000}k characters were not analysed.`);
      progress(`${items.length - tooLarge} scripts analysed, ${added} finding(s)`);
    });

    await runStep('antipattern', async (step, progress) => {
      if (stepOf('code').status !== 'done') {
        step.status = 'skipped';
        step.detail = 'Needs the code analysis step.';
        return;
      }
      findings.push(...stash.antipattern);
      collected.forEach((c) => c.records.forEach((record) => findings.push(...recordChecks(c.def, record))));
      const count = findings.filter((f) => f.category === 'antipattern').length;
      progress(`${count} finding(s)`);
    });

    await runStep('config', async (step, progress) => {
      if (!schema) {
        step.status = 'skipped';
        step.detail = 'Needs the data dictionary.';
        return;
      }
      const own = await runConfigChecks({ schema, collected, options, signal, step, emit: progress });
      findings.push(...own);
      progress(`${own.length} finding(s)`);
    });

    await runStep('upgrade', async (step, progress) => {
      findings.push(...stash.upgrade);
      const deprecated = stash.upgrade.length;
      if (!schema) {
        step.status = 'skipped';
        step.detail = 'Needs the data dictionary.';
        return;
      }
      if (options.mode !== 'instance') {
        step.notes.push('Skipped records from the last upgrade are an instance-wide check; run a whole-instance scan to include them.');
        progress(`${deprecated} deprecated API finding(s)`);
        return;
      }
      progress('Reading the upgrade history');
      const skipped = await runSkippedRecordCheck({ schema, signal, step });
      findings.push(...skipped.findings);
      progress(`${deprecated} deprecated API finding(s)${skipped.count != null ? `, ${skipped.count} skipped record(s) to review${skipped.label ? ` from ${skipped.label}` : ''}` : ''}`);
    });

    await runStep('security', async (step, progress) => {
      if (!options.includeSecurity) {
        step.status = 'skipped';
        step.detail = 'Turned off for this scan.';
        return;
      }
      progress('Running the security audit');
      // Open ACLs, public pages/widgets and scripted REST follow the scan's scope (custom records
      // only by default); system properties and admin roles are always instance-wide.
      const keepRecords = plan ? makeRecordFilter(plan, signal) : null;
      if (keepRecords) step.notes.push('ACL, public page, widget and scripted REST checks cover only the records in this scan\'s scope; properties and admin roles are instance-wide.');
      else if (!plan && (options.mode !== 'instance' || !options.includeBaseline)) step.notes.push('The scan scope could not be read, so the security checks cover the whole instance.');
      const audit = await runSecurityAudit(keepRecords ? { keepRecords } : {});
      throwIfAborted(signal);
      const own = securityFindings(audit);
      findings.push(...own);
      const errors = audit.errors || [];
      const failed = errors.filter((e) => !e.incomplete);
      errors.forEach((e) => step.notes.push(e.incomplete ? `${e.check} ran partly: ${String(e.error).replace(/^incomplete:\s*/, '')}` : `${e.check} could not run: ${e.error}`));
      if (failed.length && !Object.keys(audit.counts || {}).length) {
        // Nothing ran (typically a user without admin): never rate this "Nothing found".
        step.status = 'error';
        progress(`No security check could run (${failed.map((e) => e.check).join(', ')}).`);
        return;
      }
      if (errors.length) step.status = 'partial';
      progress(
        `${own.length} finding(s)${failed.length ? `; ${failed.length} check(s) could not run` : ''}${errors.length > failed.length ? `; ${errors.length - failed.length} ran partly` : ''}`
      );
    });
  } catch (err) {
    if (!isAbort(err) && !signal?.aborted) throw err;
    cancelled = true;
    // Findings the script pass already produced are kept in the partial report.
    if (stepOf('antipattern').status === 'pending') findings.push(...stash.antipattern);
    if (stepOf('upgrade').status === 'pending') findings.push(...stash.upgrade);
    steps.forEach((s) => {
      if (s.status === 'running' || s.status === 'pending') s.status = 'cancelled';
    });
    emit('');
  }

  if (tables.some((t) => t.truncated)) notes.push(`Some tables hit the ${options.maxPerTable}-record cap; the most recently updated records were scanned.`);

  return buildReport({
    findings,
    steps,
    tables,
    options,
    baseline,
    notes,
    origin: typeof location !== 'undefined' ? location.origin : '',
    startedAt,
    finishedAt: Date.now(),
    cancelled,
  });
}

/** Services for the sidebar panel (src/sidebar/HealthScanPanel.jsx). */
export const healthServices = {
  runHealthScan,
  healthListScopes: (search = '') => fetchScopes(search),
  healthListUpdateSets: () => fetchLiveUpdateSets({ limit: 100 }),
};
