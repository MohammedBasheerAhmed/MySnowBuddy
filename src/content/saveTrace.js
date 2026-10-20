// Save trace, the instance half: "what happened when I saved?" (panel: src/sidebar/SaveTracePanel.jsx,
// pure half: src/lib/saveTrace.js).
//
// Arm before saving: the instance's own clock and the session user are noted in sessionStorage, which survives the page
// reload a save causes (the content script restarts, the tab's storage does not). After the save, collect: every
// source is queried for rows created in the window, in parallel, and each one fails soft (a table this release does
// not have, or one the user may not read, only marks that source). Read-only.

import { queryTable } from './tableApi.js';
import { sessionHeaders } from './sessionToken.js';
import { readCurrentUser } from './controlSession.js';
import { tableHierarchy } from './fieldInspector.js';
import { SYS_ID_RE, buildWindow, serverTime, traceSources, classifyFailure, buildTrace } from '../lib/saveTrace.js';

const KEY = 'mysnowbuddy_savetrace';
const TABLE_RE = /^[a-z][a-z0-9_]*$/;

function readStore() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    return parsed && parsed.v === 1 && Number.isFinite(parsed.armedServerMs) && Number.isFinite(parsed.armedLocalMs) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStore(value) {
  try {
    if (value) sessionStorage.setItem(KEY, JSON.stringify(value));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the trace then only works until the page reloads.
  }
}

/** The instance's clock, from the Date header of a cheap read; null when it cannot be read. */
async function instanceTime() {
  try {
    const response = await fetch('/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id', { credentials: 'same-origin', headers: await sessionHeaders() });
    const ms = serverTime(response.headers.get('Date'), NaN);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** "Now" on the instance's clock, kept consistent with how Arm read it when a read fails. */
async function instanceNow(armed) {
  return (await instanceTime()) ?? armed.armedServerMs + (Date.now() - armed.armedLocalMs);
}

function describe(armed) {
  return { ...armed, ageSeconds: Math.max(0, Math.round((Date.now() - armed.armedLocalMs) / 1000)), reloadedSinceArm: performance.timeOrigin > armed.armedLocalMs };
}

export const readArmed = () => readStore();

/** Note the instance's time and the user; the next save is what gets traced. */
export async function armSaveTrace({ table = '', sysId = '' } = {}) {
  const [user, serverMs] = await Promise.all([readCurrentUser().catch(() => null), instanceTime()]);
  const armed = {
    v: 1,
    armedServerMs: serverMs ?? Date.now(),
    armedLocalMs: Date.now(),
    table: TABLE_RE.test(table) ? table : '',
    sysId: SYS_ID_RE.test(sysId) ? sysId.toLowerCase() : '',
    user: user ? { sysId: user.sysId, userName: user.userName } : null,
    host: window.location.hostname,
    clock: serverMs == null ? 'local' : 'instance',
  };
  writeStore(armed);
  return describe(armed);
}

export function disarmSaveTrace() {
  writeStore(null);
}

async function runSource(source) {
  if (source.skip) return { source, status: 'skipped', note: source.skip };
  try {
    const rows = await queryTable(source.table, source.query, source.fields, { limit: source.limit, displayValue: true });
    return { source, status: 'ok', rows };
  } catch (err) {
    return { source, ...classifyFailure(err) };
  }
}

/**
 * Everything created since Arm, merged. `table` / `sysId` are the record on screen now: after saving a NEW record the
 * form reloads on its real sys_id, which Arm could not know.
 */
export async function collectSaveTrace({ table = '', sysId = '' } = {}) {
  const armed = readStore();
  if (!armed) throw new Error('Save trace is not armed. Arm it, save the record, then collect.');
  const useTable = TABLE_RE.test(table) ? table : armed.table;
  const useSysId = SYS_ID_RE.test(sysId) ? sysId.toLowerCase() : armed.sysId;
  const window = buildWindow({ armedAt: armed.armedServerMs, now: await instanceNow(armed) });
  const isTask = useTable ? await tableHierarchy(useTable).then((chain) => chain.includes('task')).catch(() => false) : false;
  const userName = armed.user?.userName || '';
  const sources = traceSources({ table: useTable, sysId: useSysId, userName, window, isTask });
  const results = await Promise.all(sources.map(runSource));
  const trace = buildTrace({ results, ctx: { table: useTable, sysId: useSysId, userName }, window });
  return { trace, window, record: { table: useTable, sysId: useSysId }, user: userName, armed: describe(armed) };
}

/** On a page that reloaded after Arm (the save), say so once and offer to collect. */
export function resumeSaveTraceNotice({ toast, sidebar } = {}) {
  const armed = readStore();
  if (!armed || armed.host !== window.location.hostname) return;
  const state = describe(armed);
  if (!state.reloadedSinceArm || state.ageSeconds > 900) return;
  toast?.info('Save trace is armed. Collect what the save did.', {
    timeout: 15000,
    action: { label: 'Collect', onClick: () => sidebar?.openPanel?.('savetrace') },
  });
}

/** Services for the Save trace panel (merged by featureServices.js). */
export const saveTraceServices = {
  saveTraceState: async () => {
    const armed = readStore();
    return armed ? describe(armed) : null;
  },
  saveTraceArm: (args) => armSaveTrace(args),
  saveTraceDisarm: async () => {
    disarmSaveTrace();
    return null;
  },
  saveTraceCollect: (args) => collectSaveTrace(args),
};
