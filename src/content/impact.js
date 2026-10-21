// Change impact (/impact), the instance half. Loads the script record on screen (or a Script
// Include by name) and finds who uses it, what it changes directly and through the Script Include
// methods it calls, what runs as a result, other update sets holding it, recent log errors and
// how busy its table is. Read-only. A section that fails becomes a note; the report still loads.
// The pure half is src/lib/impact.js; the panel is src/sidebar/ImpactPanel.jsx.
//
// ServiceNow drops query conditions on columns it does not know and returns every row, so each
// result below is filtered again on its condition columns before it is used.

import { queryTable, queryInChunks, countRecords } from './tableApi.js';
import { searchCode, recordUrl } from './codeSearch.js';
import { tableHierarchy } from './fieldInspector.js';
import { readCurrentUser } from './controlSession.js';
import {
  TABLE_RE,
  SYS_ID_RE,
  EVENT_RE,
  CLASS_RE,
  analyzeScript,
  analyzeScripts,
  scriptIncludeCalls,
  extractMethodBody,
  describeTrigger,
  allWrites,
  writeOps,
} from '../lib/impact.js';

const LIMITS = {
  callersPerTable: 60,
  scriptIncludes: 10,
  writtenTables: 6,
  businessRules: 300,
  notifications: 200,
  flows: 100,
  eventHandlers: 100,
  updateSets: 50,
  logRows: 25,
};

const truthy = (v) => v === true || v === 'true';
const errorText = (err) => err?.message || String(err);

/** Script-bearing tables the panel understands, with the columns it reads and how each is used. */
const SUBJECTS = {
  sys_script: {
    kind: 'Business rule',
    fields: ['name', 'collection', 'when', 'order', 'active', 'action_insert', 'action_update', 'action_delete', 'action_query', 'condition', 'filter_condition', 'script'],
    scripts: ['script', 'condition'],
    ownTable: (r) => r.collection,
  },
  sys_script_include: {
    kind: 'Script Include',
    fields: ['name', 'api_name', 'client_callable', 'active', 'script'],
    scripts: ['script'],
    usedBy: (r) => ({ term: r.name, label: 'Who calls it', verb: 'Called by' }),
    errorTerm: (r) => r.name,
  },
  sys_script_client: {
    kind: 'Client script',
    fields: ['name', 'table', 'type', 'field', 'active', 'script'],
    scripts: ['script'],
  },
  catalog_script_client: {
    kind: 'Catalog client script',
    fields: ['name', 'type', 'active', 'script'],
    scripts: ['script'],
  },
  sys_ui_action: {
    kind: 'UI action',
    fields: ['name', 'table', 'action_name', 'client', 'active', 'condition', 'script'],
    scripts: ['script', 'condition'],
    ownTable: (r) => r.table,
  },
  sys_ui_policy: {
    kind: 'UI policy',
    fields: ['short_description', 'table', 'active', 'script_true', 'script_false'],
    scripts: ['script_true', 'script_false'],
    nameField: 'short_description',
  },
  sysevent_script_action: {
    kind: 'Script action',
    fields: ['name', 'event_name', 'active', 'script'],
    scripts: ['script'],
    usedBy: (r) => (EVENT_RE.test(r.event_name || '') ? { term: r.event_name, label: 'Who fires the event', verb: 'Fired by' } : null),
    errorTerm: (r) => r.event_name,
  },
  sysauto_script: {
    kind: 'Scheduled job',
    fields: ['name', 'active', 'run_type', 'script'],
    scripts: ['script'],
  },
  sys_transform_script: {
    kind: 'Transform script',
    fields: ['map.name', 'when', 'script'],
    scripts: ['script'],
    nameField: 'map.name',
  },
  sys_processor: {
    kind: 'Processor',
    fields: ['name', 'active', 'script'],
    scripts: ['script'],
  },
  sys_ws_operation: {
    kind: 'Scripted REST resource',
    fields: ['name', 'http_method', 'operation_uri', 'active', 'operation_script'],
    scripts: ['operation_script'],
  },
  sys_security_acl: {
    kind: 'ACL',
    fields: ['name', 'operation', 'active', 'condition', 'script'],
    scripts: ['script'],
  },
  sp_widget: {
    kind: 'Portal widget',
    fields: ['name', 'id', 'script', 'client_script'],
    scripts: ['script', 'client_script'],
    usedBy: (r) => (r.id && r.id.length >= 3 ? { term: r.id, label: 'Who uses it', verb: 'Used by' } : null),
  },
  sys_ui_script: {
    kind: 'UI script',
    fields: ['name', 'active', 'script'],
    scripts: ['script'],
    usedBy: (r) => ({ term: r.name, label: 'Who loads it', verb: 'Loaded by' }),
  },
};

export const IMPACT_TABLES = Object.keys(SUBJECTS);
export const impactKind = (table) => SUBJECTS[table]?.kind || null;

// ---- The subject --------------------------------------------------------------------------

async function loadSubject({ table, sysId, name }) {
  if (name) {
    const full = String(name).trim();
    const short = full.split('.').pop();
    if (!CLASS_RE.test(short) || !/^[\w.$]+$/.test(full)) throw new Error(`"${full}" is not a Script Include name.`);
    const query = full.includes('.') ? `api_name=${full}^ORname=${short}` : `name=${short}`;
    const rows = await queryTable('sys_script_include', query, ['sys_id', ...SUBJECTS.sys_script_include.fields], { limit: 5 });
    const row = rows.find((r) => r.api_name === full) || rows.find((r) => r.name === short);
    if (!row) throw new Error(`No Script Include named "${full}" was found on this instance.`);
    return { table: 'sys_script_include', row };
  }

  const def = SUBJECTS[table];
  if (!def) {
    throw new Error('Open a script record (business rule, Script Include, client script, UI action, script action, scheduled job, Scripted REST resource, widget...), or type /impact <ScriptIncludeName>.');
  }
  if (!SYS_ID_RE.test(sysId || '')) throw new Error('Save the record first: a new record has no impact to check yet.');
  const rows = await queryTable(table, `sys_id=${sysId}`, ['sys_id', ...def.fields], { limit: 1 });
  const row = rows.find((r) => r.sys_id === sysId);
  if (!row) throw new Error('This record could not be read. It may have been deleted, or your user cannot read it.');
  return { table, row };
}

/** Script fields to analyse, with the form's unsaved text in place of its saved field when they differ. */
function scriptParts(def, row, context) {
  let primary = def.scripts[0];
  let unsaved = null;
  if (context?.scriptBody && context.sysId === row.sys_id) {
    const column = String(context.scriptFieldLabel || '').split('.').pop();
    if (def.scripts.includes(column)) primary = column;
    if (!def.scripts.some((f) => (row[f] || '') === context.scriptBody)) unsaved = context.scriptBody;
  }
  return {
    parts: def.scripts.map((field) => ({ field, text: field === primary && unsaved !== null ? unsaved : row[field] || '' })),
    usesUnsaved: unsaved !== null,
  };
}

// ---- Sections -------------------------------------------------------------------------------

async function loadUsedBy(spec, subjectTable, subjectSysId) {
  const search = await searchCode(spec.term, { activeOnly: true, wholeWord: true, limitPerTable: LIMITS.callersPerTable });
  const byRecord = new Map();
  const perTable = new Map();
  search.results.forEach((r) => {
    if (r.table === subjectTable && r.sysId === subjectSysId) return;
    const key = `${r.table}:${r.sysId}`;
    if (!byRecord.has(key)) {
      byRecord.set(key, { label: r.label, table: r.table, sysId: r.sysId, name: r.name, scopeHint: r.scopeHint, viaAjax: false, lines: [], link: recordUrl(r.table, r.sysId) });
      perTable.set(r.table, (perTable.get(r.table) || 0) + 1);
    }
    const item = byRecord.get(key);
    r.matches.forEach((m) => item.lines.push({ field: r.field, lineNumber: m.lineNumber, text: m.text }));
    if (r.matches.some((m) => /GlideAjax/.test(m.text))) item.viaAjax = true;
  });
  const items = [...byRecord.values()].sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
  return {
    applicable: true,
    term: spec.term,
    label: spec.label,
    verb: spec.verb,
    items,
    capped: [...perTable.values()].some((n) => n >= LIMITS.callersPerTable),
    searchErrors: search.errors.map((e) => e.label),
  };
}

/** Pages showing a portal widget, as extra "used by" entries. */
async function loadWidgetPages(sysId) {
  const page = 'sp_column.sp_row.sp_container.sp_page';
  const rows = await queryTable('sp_instance', `sp_widget=${sysId}`, ['sys_id', 'sp_widget', `${page}.id`, `${page}.title`, `${page}.sys_id`], { limit: 50 });
  const seen = new Set();
  return rows
    .filter((r) => r.sp_widget === sysId && r[`${page}.sys_id`])
    .filter((r) => !seen.has(r[`${page}.sys_id`]) && seen.add(r[`${page}.sys_id`]))
    .map((r) => ({
      label: 'Portal page',
      table: 'sp_page',
      sysId: r[`${page}.sys_id`],
      name: r[`${page}.title`] || r[`${page}.id`] || r[`${page}.sys_id`],
      scopeHint: r[`${page}.id`] || '',
      viaAjax: false,
      lines: [],
      link: recordUrl('sp_page', r[`${page}.sys_id`]),
    }));
}

/** Script Include methods the subject calls, each analysed on its own. */
async function loadIndirect(parts, subjectName, ownTable, notes) {
  const calls = scriptIncludeCalls(parts.map((p) => p.text).join('\n')).filter((c) => c.name !== subjectName);
  if (!calls.length) return [];
  const names = calls.map((c) => c.name).slice(0, 25);
  const rows = await queryInChunks('sys_script_include', 'name', names, ['sys_id', 'name', 'api_name', 'active', 'script'], { chunkSize: 25, limit: 100 });
  const byName = new Map(rows.filter((r) => names.includes(r.name)).map((r) => [r.name, r]));
  const confirmed = calls.filter((c) => byName.has(c.name));
  if (confirmed.length > LIMITS.scriptIncludes) {
    notes.push(`Only the first ${LIMITS.scriptIncludes} of ${confirmed.length} Script Includes it calls were followed.`);
  }

  const out = [];
  confirmed.slice(0, LIMITS.scriptIncludes).forEach((c) => {
    const row = byName.get(c.name);
    const base = { name: c.name, sysId: row.sys_id, via: c.via, link: recordUrl('sys_script_include', row.sys_id) };
    if (!c.methods.length) {
      out.push({ ...base, method: null, found: true, tables: [], events: [] });
      return;
    }
    c.methods.forEach((method) => {
      const body = extractMethodBody(row.script, method);
      if (!body) {
        out.push({ ...base, method, found: false, tables: [], events: [] });
        return;
      }
      // A server Script Include called from a business rule sees that rule's `current`.
      const a = analyzeScript(body.text, { ownTable: c.via === 'GlideAjax' ? null : ownTable, lineOffset: body.lineOffset });
      out.push({ ...base, method, found: true, tables: a.tables, events: a.events, dynamic: a.dynamicTables.length + a.dynamicEvents.length });
    });
  });
  return out;
}

/** Other business rules in the same phase on the subject's table and its parents, in run order. */
async function loadAlongside(row) {
  const table = row.collection;
  if (!TABLE_RE.test(table || '') || !/^[a-z_]+$/.test(row.when || '')) return null;
  const tables = await tableHierarchy(table);
  const ops = ['insert', 'update', 'delete', 'query'].filter((op) => truthy(row[`action_${op}`]));
  const rows = await queryTable(
    'sys_script',
    `collectionIN${tables.join(',')}^active=true^when=${row.when}^ORDERBYorder`,
    ['sys_id', 'name', 'collection', 'when', 'order', 'action_insert', 'action_update', 'action_delete', 'action_query', 'active'],
    { limit: LIMITS.businessRules }
  );
  const items = rows
    .filter((r) => tables.includes(r.collection) && r.when === row.when && r.active !== 'false')
    .map((r) => ({
      sysId: r.sys_id,
      name: r.name,
      table: r.collection,
      order: Number(r.order) || 0,
      when: r.when,
      ops: ['insert', 'update', 'delete', 'query'].filter((op) => truthy(r[`action_${op}`])),
      isSelf: r.sys_id === row.sys_id,
      link: recordUrl('sys_script', r.sys_id),
    }))
    .filter((r) => r.isSelf || !ops.length || r.ops.some((op) => ops.includes(op)));
  if (!items.some((r) => r.isSelf)) {
    items.push({ sysId: row.sys_id, name: row.name, table, order: Number(row.order) || 0, when: row.when, ops, isSelf: true, link: recordUrl('sys_script', row.sys_id) });
  }
  items.sort((a, b) => a.order - b.order || Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name));
  return { tables, when: row.when, items, capped: rows.length >= LIMITS.businessRules };
}

/** Tables written (with their operations) and events fired, from the subject and the methods it calls. */
function writtenTargets(changes, indirect) {
  const tables = new Map();
  allWrites({ changes, indirect }).forEach((w) => {
    const ops = writeOps(w);
    // Fields set on `current` without a separate update() are saved by the operation already running.
    if (!ops.length || !TABLE_RE.test(w.table)) return;
    if (!tables.has(w.table)) tables.set(w.table, { table: w.table, ops: new Set(), workflowOff: true });
    const t = tables.get(w.table);
    ops.forEach((op) => t.ops.add(op));
    t.workflowOff = t.workflowOff && w.workflowOff;
  });
  const events = new Set([...(changes.events || []), ...indirect.flatMap((c) => c.events || [])].map((e) => e.name).filter((n) => EVENT_RE.test(n)));
  return { tables: [...tables.values()].sort((a, b) => a.table.localeCompare(b.table)), events: [...events].sort() };
}

async function loadDownstream(changes, indirect, subject, notes) {
  const { tables: written, events } = writtenTargets(changes, indirect);
  if (!written.length && !events.length) return { tables: [], events: [], items: [], capped: false };
  if (written.length > LIMITS.writtenTables) {
    notes.push(`Only the first ${LIMITS.writtenTables} of ${written.length} tables it writes were followed.`);
  }
  const targets = written.slice(0, LIMITS.writtenTables);
  const exact = targets.map((t) => t.table);
  const hierarchies = await Promise.all(targets.map((t) => tableHierarchy(t.table).catch(() => [t.table])));
  const all = [...new Set(hierarchies.flat())];
  const items = [];
  let capped = false;

  // Business rules on each written table and its parents, for the operations it performs.
  const opsFor = (table) => {
    const ops = new Set();
    let maySkip = true;
    targets.forEach((t, i) => {
      if (!hierarchies[i].includes(table)) return;
      t.ops.forEach((op) => ops.add(op));
      maySkip = maySkip && t.workflowOff;
    });
    return { ops, maySkip };
  };

  const jobs = [];
  if (all.length) {
    jobs.push(
      queryTable(
        'sys_script',
        `collectionIN${all.join(',')}^active=true^ORDERBYorder`,
        ['sys_id', 'name', 'collection', 'when', 'order', 'action_insert', 'action_update', 'action_delete', 'active'],
        { limit: LIMITS.businessRules }
      ).then((rows) => {
        if (rows.length >= LIMITS.businessRules) capped = true;
        rows
          .filter((r) => all.includes(r.collection) && r.active !== 'false' && r.sys_id !== subject.sysId)
          .forEach((r) => {
            const { ops, maySkip } = opsFor(r.collection);
            const hit = ['insert', 'update', 'delete'].filter((op) => ops.has(op) && truthy(r[`action_${op}`]));
            if (!hit.length) return;
            items.push({
              kind: 'Business rule',
              name: r.name,
              table: r.collection,
              detail: `${r.when} ${hit.join('/')} on ${r.collection}, order ${r.order || 0}`,
              maySkip,
              sort: `0|${r.collection}|${String(Number(r.order) || 0).padStart(8, '0')}`,
              link: recordUrl('sys_script', r.sys_id),
            });
          });
      }).catch((err) => notes.push(`Business rules on the tables it writes could not be read: ${errorText(err)}`))
    );

    // Notifications sent when a record is inserted or updated (exact table only).
    jobs.push(
      queryTable(
        'sysevent_email_action',
        `collectionIN${exact.join(',')}^active=true`,
        ['sys_id', 'name', 'collection', 'action_insert', 'action_update', 'generation_type', 'active'],
        { limit: LIMITS.notifications }
      ).then((rows) => {
        if (rows.length >= LIMITS.notifications) capped = true;
        rows
          .filter((r) => exact.includes(r.collection) && r.active !== 'false' && (!r.generation_type || r.generation_type === 'engine'))
          .forEach((r) => {
            const t = targets.find((x) => x.table === r.collection);
            const hit = ['insert', 'update'].filter((op) => t.ops.has(op) && truthy(r[`action_${op}`]));
            if (!hit.length) return;
            items.push({
              kind: 'Notification',
              name: r.name,
              table: r.collection,
              detail: `when a record is ${hit.map((op) => (op === 'insert' ? 'inserted' : 'updated')).join(' or ')} on ${r.collection}`,
              maySkip: t.workflowOff,
              sort: `1|${r.name}`,
              link: recordUrl('sysevent_email_action', r.sys_id),
            });
          });
      }).catch((err) => notes.push(`Notifications on the tables it writes could not be read: ${errorText(err)}`))
    );

    // Flow Designer record triggers (exact table only). Not every release exposes this table.
    jobs.push(
      queryTable('sys_flow_record_trigger', `tableIN${exact.join(',')}`, ['sys_id', 'table', 'sys_name', 'condition'], { limit: LIMITS.flows })
        .then((rows) => {
          if (rows.length >= LIMITS.flows) capped = true;
          rows
            .filter((r) => exact.includes(r.table))
            .forEach((r) => {
              const t = targets.find((x) => x.table === r.table);
              items.push({
                kind: 'Flow trigger',
                name: r.sys_name || r.sys_id,
                table: r.table,
                detail: `record trigger on ${r.table}${r.condition ? ', with a condition' : ''}`,
                maySkip: t.workflowOff,
                sort: `2|${r.sys_name || ''}`,
                link: recordUrl('sys_flow_record_trigger', r.sys_id),
              });
            });
        })
        .catch((err) => notes.push(`Flows were not checked (${errorText(err)}).`))
    );
  }

  if (events.length) {
    jobs.push(
      queryTable('sysevent_script_action', `event_nameIN${events.join(',')}^active=true`, ['sys_id', 'name', 'event_name', 'active'], { limit: LIMITS.eventHandlers })
        .then((rows) => {
          rows
            .filter((r) => events.includes(r.event_name) && r.active !== 'false' && r.sys_id !== subject.sysId)
            .forEach((r) => items.push({ kind: 'Script action', name: r.name, table: '', detail: `on event ${r.event_name}`, maySkip: false, sort: `3|${r.name}`, link: recordUrl('sysevent_script_action', r.sys_id) }));
        })
        .catch((err) => notes.push(`Script actions for the events it fires could not be read: ${errorText(err)}`))
    );
    jobs.push(
      queryTable('sysevent_email_action', `event_nameIN${events.join(',')}^active=true`, ['sys_id', 'name', 'event_name', 'generation_type', 'active'], { limit: LIMITS.eventHandlers })
        .then((rows) => {
          rows
            .filter((r) => events.includes(r.event_name) && r.active !== 'false' && r.generation_type === 'event')
            .forEach((r) => items.push({ kind: 'Notification', name: r.name, table: '', detail: `on event ${r.event_name}`, maySkip: false, sort: `1|${r.name}`, link: recordUrl('sysevent_email_action', r.sys_id) }));
        })
        .catch((err) => notes.push(`Notifications for the events it fires could not be read: ${errorText(err)}`))
    );
  }

  await Promise.all(jobs);
  const parents = all.filter((t) => !exact.includes(t));
  if (parents.length) notes.push(`Notifications and flows defined on parent tables (${parents.join(', ')}) are not listed; business rules there are.`);
  items.sort((a, b) => a.sort.localeCompare(b.sort));
  return { tables: exact, events, items: items.map(({ sort, ...rest }) => rest), capped };
}

async function loadUpdateSets(table, sysId) {
  const updateName = `${table}_${sysId}`;
  const [rows, me] = await Promise.all([
    queryTable(
      'sys_update_xml',
      `name=${updateName}^update_set.stateINin progress,complete^ORDERBYDESCsys_updated_on`,
      ['sys_id', 'name', 'update_set', 'update_set.name', 'update_set.state', 'sys_updated_on', 'sys_updated_by'],
      { limit: LIMITS.updateSets }
    ),
    readCurrentUser().catch(() => null),
  ]);
  const seen = new Set();
  const items = rows
    .filter((r) => r.name === updateName && ['in progress', 'complete'].includes(r['update_set.state']))
    .filter((r) => !seen.has(r.update_set) && seen.add(r.update_set))
    .map((r) => ({
      setId: r.update_set,
      setName: r['update_set.name'] || r.update_set,
      state: r['update_set.state'],
      updatedBy: r.sys_updated_by,
      updatedOn: r.sys_updated_on,
      mine: Boolean(me?.userName) && r.sys_updated_by === me.userName,
      link: recordUrl('sys_update_set', r.update_set),
    }));
  return { items };
}

async function loadHistory(table, sysId) {
  const updateName = `${table}_${sysId}`;
  const [count, rows] = await Promise.all([
    countRecords('sys_update_version', `name=${updateName}`),
    queryTable('sys_update_version', `name=${updateName}^ORDERBYDESCsys_recorded_at`, ['sys_id', 'name', 'sys_recorded_at', 'sys_created_on', 'sys_created_by'], { limit: 3 }),
  ]);
  return {
    count,
    latest: rows.filter((r) => r.name === updateName).map((r) => ({ recordedAt: r.sys_created_on || r.sys_recorded_at, by: r.sys_created_by })),
  };
}

async function loadErrors(sysId, term) {
  const named = term && /^[\w.-]{6,80}$/.test(term) ? term : null;
  const rows = await queryTable(
    'syslog',
    `sys_created_on>=javascript:gs.daysAgoStart(7)^levelIN1,2^messageLIKE${sysId}${named ? `^ORmessageLIKE${named}` : ''}^ORDERBYDESCsys_created_on`,
    ['sys_id', 'sys_created_on', 'level', 'message', 'source'],
    { limit: LIMITS.logRows }
  );
  const hits = rows.filter((r) => ['1', '2'].includes(String(r.level)) && (String(r.message).includes(sysId) || (named && String(r.message).includes(named))));
  return {
    count: hits.length,
    capped: rows.length >= LIMITS.logRows,
    samples: hits.slice(0, 5).map((r) => ({ createdOn: r.sys_created_on, level: String(r.level) === '2' ? 'error' : 'warning', message: r.message, link: recordUrl('syslog', r.sys_id) })),
  };
}

/** How many records the business rule's table saw in the last day, for the operations it runs on. */
async function loadVolume(row) {
  const table = row.collection;
  if (!TABLE_RE.test(table || '')) return null;
  const updates = truthy(row.action_update);
  if (!updates && !truthy(row.action_insert)) return null;
  const column = updates ? 'sys_updated_on' : 'sys_created_on';
  const count = await countRecords(table, `${column}>=javascript:gs.hoursAgoStart(24)`);
  return { table, count, label: `records on ${table} ${updates ? 'changed' : 'created'} in the last 24 hours` };
}

// ---- The report ----------------------------------------------------------------------------

/**
 * Full impact report. `name` (a Script Include) wins over `table` + `sysId`; `context` is the page
 * context, used to analyse unsaved form text.
 */
export async function buildImpactReport({ table, sysId, name, context } = {}) {
  const { table: subjectTable, row } = await loadSubject({ table, sysId, name });
  const def = SUBJECTS[subjectTable];
  const notes = [];
  const ownTableRaw = def.ownTable?.(row);
  const ownTable = TABLE_RE.test(ownTableRaw || '') ? ownTableRaw : null;
  const { parts, usesUnsaved } = scriptParts(def, row, context);

  const subject = {
    table: subjectTable,
    kind: def.kind,
    sysId: row.sys_id,
    name: row[def.nameField || 'name'] || '(unnamed)',
    trigger: describeTrigger(subjectTable, row),
    active: 'active' in row ? row.active !== 'false' : null,
    ownTable,
    usesUnsaved,
    link: recordUrl(subjectTable, row.sys_id),
  };
  const changes = analyzeScripts(parts, { ownTable });

  // Each section settles on its own; a failure becomes a note.
  const section = (label, promise) =>
    promise.catch((err) => {
      if (err?.code === 'SESSION_EXPIRED') throw err;
      notes.push(`${label} could not be checked: ${errorText(err)}`);
      return null;
    });

  const usedBySpec = def.usedBy?.(row);
  const usedByJob = usedBySpec?.term
    ? section(
        'Who uses it',
        Promise.all([
          loadUsedBy(usedBySpec, subjectTable, row.sys_id),
          subjectTable === 'sp_widget' ? loadWidgetPages(row.sys_id).catch(() => []) : Promise.resolve([]),
        ]).then(([usedBy, pages]) => ({ ...usedBy, items: [...pages, ...usedBy.items] }))
      )
    : Promise.resolve(null);

  const indirectJob = section('The Script Includes it calls', loadIndirect(parts, subjectTable === 'sys_script_include' ? row.name : null, ownTable, notes)).then((r) => r || []);
  const downstreamJob = indirectJob.then((indirect) => section('What runs as a result', loadDownstream(changes, indirect, subject, notes)));

  const [usedBy, indirect, downstream, alongside, updateSets, history, errors, volume] = await Promise.all([
    usedByJob,
    indirectJob,
    downstreamJob,
    subjectTable === 'sys_script' ? section('Rules that run alongside', loadAlongside(row)) : Promise.resolve(null),
    section('Update sets', loadUpdateSets(subjectTable, row.sys_id)),
    section('Version history', loadHistory(subjectTable, row.sys_id)),
    section('The system log', loadErrors(row.sys_id, def.errorTerm?.(row))),
    subjectTable === 'sys_script' ? section('Record volume', loadVolume(row)) : Promise.resolve(null),
  ]);

  if (usedBy?.searchErrors?.length) notes.push(`Code search could not read: ${usedBy.searchErrors.join(', ')}.`);
  if (!usedBySpec && subjectTable !== 'sys_script') {
    notes.push(`A ${def.kind.toLowerCase()} is not called by name from other scripts, so "who uses it" does not apply.`);
  }

  return {
    origin: window.location.origin,
    generatedAt: new Date().toISOString(),
    subject,
    usedBy,
    alongside,
    changes,
    indirect,
    downstream,
    updateSets,
    history,
    errors,
    volume,
    notes,
  };
}

export const impactServices = {
  impactReport: (args) => buildImpactReport(args),
};
