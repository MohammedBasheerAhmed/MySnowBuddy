// Push one configuration record to another instance: preview (read both sides) and
// write. Runs in the service worker because content scripts are bound to the page's
// own origin. Every rule that protects the target is enforced here as well as in the
// UI: allowed tables, no sys_* columns, the typed-name gate, and a re-read of the
// target right before writing so a stale preview is never applied.

import { fetchRecords, writeRecord, normalizeInstanceUrl, knownInstanceLabel } from './instanceClient.js';
import {
  matchQuery,
  matchKeys,
  pickKeyMatches,
  exactKeyMatch,
  samePayload,
  planPush,
  sanitizePushPayload,
  writeGuard,
  verifyWrite,
  refusalReason,
  confirmMatches,
  flatValue,
} from '../lib/pushArtifact.js';
import { createAudit, chromeStorageAdapter } from '../lib/agent/audit.js';

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const TABLE_RE = /^[a-z0-9_]+$/i;
const hostOf = (base) => new URL(base).hostname;

function requirePageSender(sender) {
  let host = '';
  try {
    host = new URL(sender?.tab?.url || '').hostname;
  } catch {
    // No tab URL.
  }
  if (!/\.service-now\.com$/i.test(host)) throw new Error('This request is only allowed from a ServiceNow page.');
  return host;
}

async function readById(base, table, sysId, fields = []) {
  const rows = await fetchRecords(base, table, fields, { query: `sys_id=${sysId}`, limit: 1 });
  return rows[0] && flatValue(rows[0].sys_id) === sysId ? rows[0] : null;
}

/** The target's copy: same sys_id first, then the table's natural key. */
async function findOnTarget(base, table, source) {
  const sysId = flatValue(source.sys_id);
  if (SYS_ID_RE.test(sysId)) {
    const byId = await readById(base, table, sysId);
    if (byId) return { record: byId, matchedBy: 'sys_id', keys: null };
  }
  const match = matchQuery(table, source);
  if (!match) return { record: null, matchedBy: null, keys: null };
  const rows = await fetchRecords(base, table, [], { query: match.query, limit: 5 });
  const hits = pickKeyMatches(rows, source, match.keys);
  if (hits.length > 1) {
    const what = match.keys.map((k) => `${k}="${flatValue(source[k])}"`).join(', ');
    throw new Error(`More than one record on ${hostOf(base)} has ${what}. Cannot tell which one to update.`);
  }
  return {
    record: hits[0] || null,
    matchedBy: hits.length ? 'name' : null,
    keys: match.keys,
    // Matched only when letter case is ignored: the push needs the user's explicit confirmation.
    caseOnly: hits.length === 1 && !exactKeyMatch(hits[0], source, match.keys),
  };
}

/**
 * Which update set the target will capture the write in, as far as we can tell: the
 * authenticated user's "sys_update_set" preference. Best effort, unverified; null when unreadable.
 */
async function describeTargetSession(base) {
  try {
    const users = await fetchRecords(base, 'sys_user', ['sys_id', 'user_name'], { query: 'sys_id=javascript:gs.getUserID()', limit: 2 });
    if (users.length !== 1) return null;
    const user = users[0];
    const prefs = await fetchRecords(base, 'sys_user_preference', ['value'], { query: `user=${flatValue(user.sys_id)}^name=sys_update_set`, limit: 2 });
    const setId = prefs.length === 1 ? flatValue(prefs[0].value) : '';
    let updateSet = null;
    if (SYS_ID_RE.test(setId)) {
      const set = await readById(base, 'sys_update_set', setId, ['sys_id', 'name', 'state']);
      if (set) updateSet = { name: flatValue(set.name), state: flatValue(set.state) };
    }
    return { userName: flatValue(user.user_name), updateSet };
  } catch {
    return null;
  }
}

/**
 * payload: { targetUrl, table, sourceRecord } (record read by the page from its own instance)
 *       or { targetUrl, table, sourceUrl, sourceSysId } (read here, e.g. from Instance Compare)
 */
export async function handlePushPreview(payload, sender) {
  const pageHost = requirePageSender(sender);
  const { targetUrl, table, sourceRecord, sourceUrl, sourceSysId } = payload || {};
  if (!TABLE_RE.test(table || '')) throw new Error('Invalid table.');
  const target = normalizeInstanceUrl(targetUrl);

  let source = sourceRecord && typeof sourceRecord === 'object' && !Array.isArray(sourceRecord) ? sourceRecord : null;
  let sourceBase;
  if (source) {
    sourceBase = normalizeInstanceUrl(pageHost);
  } else {
    sourceBase = normalizeInstanceUrl(sourceUrl);
    if (!SYS_ID_RE.test(sourceSysId || '')) throw new Error('Invalid record.');
    source = await readById(sourceBase, table, sourceSysId);
    if (!source) throw new Error(`The record was not found on ${hostOf(sourceBase)}.`);
  }
  if (sourceBase === target) throw new Error('Source and target are the same instance. Pick another instance.');

  const targetHost = hostOf(target);
  const targetLabel = await knownInstanceLabel(targetHost);
  const base = {
    ok: true,
    source,
    sourceHost: hostOf(sourceBase),
    targetHost,
    targetLabel,
    guard: writeGuard({ host: targetHost, label: targetLabel }),
  };
  const refusal = refusalReason(table);
  if (refusal) return { ...base, target: null, matchedBy: null, refused: refusal, session: null };

  const match = await findOnTarget(target, table, source);
  const session = await describeTargetSession(target);
  return { ...base, target: match.record, matchedBy: match.matchedBy, matchKeys: match.keys, nameCaseDiffers: Boolean(match.caseOnly), session };
}

/**
 * payload: { targetUrl, table, mode: 'create'|'update', targetSysId, fields, confirmName,
 *            expectedUpdatedOn, sourceHost, sourceSysId, recordName,
 *            sourceRecord (the previewed source), matchedBy ('sys_id'|'name'|null), confirmCaseMatch }
 *
 * The write is re-planned here from the previewed source and a fresh read of the target: the
 * planner's blockers are enforced again, and the fields to write must equal what was previewed.
 */
export async function handlePushArtifact(payload, sender) {
  requirePageSender(sender);
  const {
    targetUrl,
    table,
    mode,
    targetSysId,
    fields,
    confirmName,
    expectedUpdatedOn,
    sourceHost,
    sourceSysId,
    recordName,
    sourceRecord,
    matchedBy,
    confirmCaseMatch,
  } = payload || {};
  if (!TABLE_RE.test(table || '')) throw new Error('Invalid table.');
  const refusal = refusalReason(table);
  if (refusal) throw new Error(refusal);
  if (mode !== 'create' && mode !== 'update') throw new Error('Invalid push mode.');
  if (!sourceRecord || typeof sourceRecord !== 'object' || Array.isArray(sourceRecord)) throw new Error('The source record is missing. Preview again.');

  const base = normalizeInstanceUrl(targetUrl);
  const host = hostOf(base);
  if (sourceHost && normalizeInstanceUrl(sourceHost) === base) throw new Error('Source and target are the same instance.');
  const clean = sanitizePushPayload(fields, { mode });

  const guard = writeGuard({ host, label: await knownInstanceLabel(host) });
  if (guard.guarded && !confirmMatches(confirmName, guard.instance)) {
    throw new Error(`Type "${guard.instance}" to confirm a write to ${host}.`);
  }

  // The preview may be stale: re-read the target right before writing.
  let previous = null;
  if (mode === 'update') {
    if (!SYS_ID_RE.test(targetSysId || '')) throw new Error('Invalid target record.');
    previous = await readById(base, table, targetSysId);
    if (!previous) throw new Error('The target record no longer exists. Preview again.');
    if (expectedUpdatedOn && flatValue(previous.sys_updated_on) !== String(expectedUpdatedOn)) {
      throw new Error('The target record changed since the preview. Preview again.');
    }
    // The record being written must still be the one the preview matched.
    if (matchedBy === 'sys_id') {
      if (flatValue(sourceRecord.sys_id) !== targetSysId) throw new Error('The target record is not the one the preview matched. Preview again.');
    } else if (matchedBy === 'name') {
      const keys = matchKeys(table);
      if (!pickKeyMatches([previous], sourceRecord, keys).length) throw new Error('The target record no longer matches by name. Preview again.');
      if (!exactKeyMatch(previous, sourceRecord, keys) && confirmCaseMatch !== true) {
        throw new Error('The target matches only when letter case is ignored. Confirm it is the same record in the preview first.');
      }
    } else {
      throw new Error('Unknown match. Preview again.');
    }
  } else if (clean.sys_id && (await readById(base, table, clean.sys_id, ['sys_id']))) {
    throw new Error('A record with this sys_id now exists on the target. Preview again.');
  }

  // Re-run the planner on the fresh target: its blockers apply here too (password properties,
  // new records in scoped apps, ...), and what it would write must be exactly what was previewed.
  const plan = planPush({ table, source: sourceRecord, target: previous, matchedBy: mode === 'update' ? matchedBy : null });
  if (plan.blockers.length) throw new Error(plan.blockers[0]);
  if (plan.mode === 'none') throw new Error('Nothing to push: the target already matches.');
  if (plan.mode !== mode) throw new Error('The target changed since the preview. Preview again.');
  const planned = sanitizePushPayload(plan.payload, { mode });
  if (!samePayload(planned, clean)) throw new Error('What would be written differs from the preview. Preview again.');

  const audit = createAudit(chromeStorageAdapter);
  const written = Object.keys(clean).filter((k) => k !== 'sys_id');
  const args = {
    table,
    mode,
    from: sourceHost || '',
    sourceSysId: sourceSysId || '',
    targetSysId: targetSysId || clean.sys_id || '',
    fields: written,
    // Old values, for recovering by hand. Cross-instance pushes have no automatic undo.
    previous: previous ? Object.fromEntries(written.map((k) => [k, flatValue(previous[k])])) : null,
  };
  const what = `${table} "${String(recordName || '').slice(0, 80) || flatValue(previous?.name) || clean.name || targetSysId || clean.sys_id}"`;

  let result;
  try {
    result = await writeRecord(base, table, { method: mode === 'create' ? 'POST' : 'PATCH', sysId: targetSysId, fields: clean });
  } catch (err) {
    await audit.record({ instance: host, tool: 'push_artifact', args, ok: false, summary: `Push of ${what} to ${host} failed: ${err.message}`, source: 'push' }).catch(() => {});
    throw err;
  }

  const sysId = flatValue(result.record.sys_id) || targetSysId;
  const after = (SYS_ID_RE.test(sysId) && (await readById(base, table, sysId).catch(() => null))) || result.record;
  const mismatched = verifyWrite(clean, after);
  await audit
    .record({
      instance: host,
      tool: 'push_artifact',
      args: { ...args, targetSysId: sysId },
      ok: true,
      summary: `Pushed ${what} from ${sourceHost || 'another instance'} to ${host} (${mode === 'create' ? 'created' : `${written.length} field(s) updated`})`,
      source: 'push',
    })
    .catch(() => {});

  return {
    ok: true,
    host,
    sysId,
    url: `https://${host}/${encodeURIComponent(table)}.do?sys_id=${encodeURIComponent(sysId)}`,
    auth: result.auth,
    mode,
    written,
    mismatched,
    keptSysId: mode === 'create' && clean.sys_id ? sysId === clean.sys_id : null,
  };
}
