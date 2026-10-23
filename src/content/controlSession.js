// Network side of the control-plane tools: who the session is, update set and
// application scope switching, impersonation and ATF runs. Same-origin requests
// under the user's own session; nothing here decides whether a call may run
// (that is the approval policy), it only does the call and reads back the result.
//
// UNVERIFIED against a live instance (see the report / docs/decisions.md):
//  - the "Me" dynamic filter (sys_idDYNAMIC90d1921e5f510100a9ad2572f2b477fe) on sys_user and sys_user_preference
//  - user preferences "sys_update_set" and "apps.current_app" as the read-back of the current update set / app
//  - GET /api/now/ui/concoursepicker/application response shape (result.current)
//  - /impersonate.do and /logout_impersonate.do driven by fetch instead of a page load
//  - /api/sn_cicd/progress/{id} links.results.id and /api/sn_cicd/testsuite/results/{id} field names
// Every reader fails soft (null) so a missing endpoint degrades to "unknown", never to a wrong answer.

import { queryTable } from './tableApi.js';
import { sessionHeaders, getSessionToken } from './sessionToken.js';
import { callPage } from './pageBridge.js';
import { getNodeInfo, getCurrentUpdateSet, setCurrentUpdateSet, setCurrentApplication, shellUrl, recordUrl } from './quickActions.js';
import { runAtfSuite } from './atf.js';
import { startImpersonating, stopImpersonating } from './impersonation.js';
import * as page from './controlPage.js';
import { detectPageContext } from './context.js';
import { explainAccess } from './accessDebugger.js';
import { runHealthScan } from './healthScan.js';
import { loadShipCheck, readCurrentUpdateSet as readMyUpdateSet } from './myWork.js';
import { xrayServices } from './xray.js';
import { loadNotifyReport } from './notifyTrace.js';
import { processLoad } from './processView.js';
import { dataModelLoad, dataModelFindPaths } from './dataModel.js';
import { previewProblemSets, previewProblemLoad } from './previewProblems.js';
import { doctorServices } from './doctor.js';
import { propertyServices } from './properties.js';
import { clientTraceServices } from './clientTrace.js';
import { searchArtifacts } from '../lib/agent/insights.js';

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
// sys_filter_option_dynamic "Me": the same filter the platform uses for "assigned to me".
const ME = '90d1921e5f510100a9ad2572f2b477fe';

/** The session's user as the server sees it right now (changes immediately on impersonation). */
export async function readCurrentUserFromApi() {
  const rows = await queryTable('sys_user', `sys_idDYNAMIC${ME}`, ['sys_id', 'user_name', 'name'], { limit: 2 });
  // Exactly one row, or the filter was not understood (ServiceNow drops unknown conditions and returns everyone).
  return rows.length === 1 ? { sysId: rows[0].sys_id, userName: rows[0].user_name, name: rows[0].name, source: 'table-api' } : null;
}

/** The session's user: the server's answer, else the page's g_user. */
export async function readCurrentUser() {
  const fromApi = await readCurrentUserFromApi().catch(() => null);
  if (fromApi) return fromApi;
  const s = await callPage('getSessionInfo').catch(() => null);
  if (!s?.userId) return null;
  return { sysId: s.userId, userName: s.userName, name: [s.firstName, s.lastName].filter(Boolean).join(' ') || null, source: 'page' };
}

export const readSessionInfo = () => callPage('getSessionInfo').catch(() => null);

/** Role names granted to a user (including inherited ones), sorted. Throws when sys_user_has_role is not readable. */
export async function readUserRoles(userSysId) {
  if (!SYS_ID_RE.test(userSysId || '')) return null;
  const rows = await queryTable('sys_user_has_role', `user=${userSysId}`, ['role.name'], { limit: 500 });
  return [...new Set(rows.map((r) => r['role.name']).filter(Boolean))].sort();
}

/** Release and build, from stats.do (admin) or the build properties. */
export async function readBuild() {
  try {
    const node = await getNodeInfo();
    if (node.build || node.version) return { build: node.build, version: node.version, buildDate: node.buildDate, node: node.node, source: 'stats.do' };
  } catch {
    // Not admin, or the page changed; try the properties.
  }
  try {
    const rows = await queryTable('sys_properties', 'nameINglide.buildname,glide.buildtag,glide.war,glide.builddate', ['name', 'value'], { limit: 10 });
    const p = Object.fromEntries(rows.map((r) => [r.name, r.value]));
    if (rows.length) return { build: p['glide.buildname'] || null, version: p['glide.buildtag'] || p['glide.war'] || null, buildDate: p['glide.builddate'] || null, source: 'sys_properties' };
  } catch {
    // Not readable.
  }
  return null;
}

async function myPreference(name) {
  const rows = await queryTable('sys_user_preference', `name=${name}^userDYNAMIC${ME}`, ['value'], { limit: 2 });
  return rows.length === 1 ? rows[0].value || null : null;
}

/** { sysId, name, source } of the session's update set: the picker API, else the user preference. */
export async function readCurrentUpdateSet() {
  const viaPicker = await getCurrentUpdateSet().catch(() => null);
  const viaPref = await myPreference('sys_update_set').catch(() => null);
  if (viaPicker?.sysId) return { sysId: viaPicker.sysId, name: viaPicker.name || null, source: 'picker', preference: viaPref || undefined };
  if (viaPref && SYS_ID_RE.test(viaPref)) {
    const rows = await queryTable('sys_update_set', `sys_id=${viaPref}`, ['name'], { limit: 1 }).catch(() => []);
    return { sysId: viaPref, name: rows[0]?.name || null, source: 'preference' };
  }
  return null;
}

async function pickerApplication() {
  const response = await fetch('/api/now/ui/concoursepicker/application', { credentials: 'same-origin', headers: await sessionHeaders() });
  if (!response.ok) return null;
  const data = await response.json();
  const cur = data?.result?.current || data?.result?.currentApplication || null;
  const id = cur?.sysId || cur?.sys_id || cur?.id || cur?.value;
  return id ? { sysId: String(id), name: cur.name || cur.title || cur.displayValue || null } : null;
}

/** { sysId, name, scope } of the session's application: the picker API, else the user preference. */
export async function readCurrentScope() {
  let cur = await pickerApplication().catch(() => null);
  let source = 'picker';
  if (!cur) {
    const id = await myPreference('apps.current_app').catch(() => null);
    if (id) cur = { sysId: id };
    source = 'preference';
  }
  if (!cur) return null;
  if (cur.sysId === 'global') return { sysId: 'global', name: 'Global', scope: 'global', source };
  if (SYS_ID_RE.test(cur.sysId)) {
    const rows = await queryTable('sys_scope', `sys_id=${cur.sysId}`, ['name', 'scope'], { limit: 1 }).catch(() => []);
    if (rows[0]) return { sysId: cur.sysId, name: rows[0].name, scope: rows[0].scope, source };
  }
  return { ...cur, source };
}

/** Ask the platform to switch, then read back what is current. The caller decides whether it took. */
export async function switchUpdateSet(sysId) {
  let requestError = null;
  try {
    await setCurrentUpdateSet(sysId, await getSessionToken());
  } catch (err) {
    requestError = err.message;
  }
  return { after: await readCurrentUpdateSet().catch(() => null), requestError };
}

export async function switchScope(appId) {
  let requestError = null;
  try {
    await setCurrentApplication(appId, await getSessionToken());
  } catch (err) {
    requestError = err.message;
  }
  return { after: await readCurrentScope().catch(() => null), requestError };
}

/** Start impersonating. Unlike tableApi.impersonateUser this does not reload, so the tool can answer first. */
export async function startImpersonation(userSysId) {
  if (!SYS_ID_RE.test(userSysId || '')) throw new Error('Invalid user.');
  await startImpersonating(userSysId);
}

export async function endImpersonation() {
  await stopImpersonating();
}

// ---- ATF through the CI/CD API ---------------------------------------------------------------------

export async function startAtfSuite(suiteSysId) {
  return runAtfSuite(suiteSysId, await getSessionToken());
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

export async function readCicdProgress(progressId) {
  if (!SYS_ID_RE.test(progressId || '')) throw new Error('Invalid progress id.');
  const response = await fetch(`/api/sn_cicd/progress/${progressId}`, { credentials: 'same-origin', headers: await sessionHeaders() });
  if (!response.ok) throw new Error(`Progress check failed (${response.status}).`);
  const r = (await response.json())?.result || {};
  const resultsId = r.links?.results?.id;
  return {
    status: r.status ?? '',
    statusLabel: r.status_label || '',
    percent: Number(r.percent_complete) || 0,
    message: r.status_message || r.status_detail || '',
    error: r.error || '',
    resultsId: SYS_ID_RE.test(resultsId || '') ? resultsId : null,
  };
}

export async function readSuiteResult(resultId) {
  if (!SYS_ID_RE.test(resultId || '')) return null;
  const response = await fetch(`/api/sn_cicd/testsuite/results/${resultId}`, { credentials: 'same-origin', headers: await sessionHeaders() });
  if (!response.ok) return null;
  const r = (await response.json())?.result || {};
  return {
    name: r.test_suite_name || null,
    status: r.test_suite_status || null,
    duration: r.test_suite_duration || null,
    passed: num(r.rolledup_test_success_count),
    failed: num(r.rolledup_test_failure_count),
    errors: num(r.rolledup_test_error_count),
    skipped: num(r.rolledup_test_skip_count),
  };
}

/**
 * Everything the control tools need from the page and the network, injected into createAgentTools as `control`.
 * @param {{confirm?: (request: object) => Promise<{approved: boolean}>}} [options]  asks the person in the page
 *   (the in-page approval dialog); used before leaving a form whose unsaved changes cannot be seen.
 */
export function createControlDeps({ confirm } = {}) {
  return {
    page,
    shellUrl,
    confirm,
    // A portal URL suffix that is not one of the out-of-box portals must exist in sp_portal.
    portalExists: async (suffix) => /^[a-z][a-z0-9_]*$/i.test(suffix || '') && (await queryTable('sp_portal', `url_suffix=${suffix}`, ['url_suffix'], { limit: 2 })).some((r) => String(r.url_suffix).toLowerCase() === suffix.toLowerCase()),
    // A real table, not a processor that looks like one (logout.do, cache.do...): the dictionary says so, or, for
    // users who cannot read sys_db_object, the Table API knows the table (400 = no such table).
    tableExists: async (table) => {
      try {
        if ((await queryTable('sys_db_object', `name=${table}`, ['name'], { limit: 1 })).length === 1) return true;
      } catch {
        // Not readable for this user; ask the table itself.
      }
      try {
        await queryTable(table, '', ['sys_id'], { limit: 1 });
        return true;
      } catch (err) {
        return /\(403\)/.test(String(err?.message));
      }
    },
    session: {
      readCurrentUser,
      readCurrentUserFromApi,
      readSessionInfo,
      readUserRoles,
      readBuild,
      readCurrentUpdateSet,
      readCurrentScope,
      switchUpdateSet,
      switchScope,
      startImpersonation,
      endImpersonation,
    },
    atf: { startSuite: startAtfSuite, readProgress: readCicdProgress, readSuiteResult },
    // Read-only analysis panels exposed as tools (access debugger, page X-ray, ship check, health scan, Email tracer,
    // Flows and approvals, Data model map and path finder, Preview problems, Go to anything). The tools shape the
    // reports into compact answers (src/lib/agent/insights.js); nothing here writes.
    insights: {
      explainAccess,
      fieldReport: (args) => xrayServices.xrayFieldReport(args),
      pageTable: () => detectPageContext()?.table || '',
      loadShipCheck,
      currentUpdateSet: readMyUpdateSet,
      runHealthScan,
      notifyReport: (args) => loadNotifyReport(args),
      processLoad: (args) => processLoad(args),
      dataModelLoad: (args) => dataModelLoad(args),
      dataModelFindPaths: (args) => dataModelFindPaths(args),
      previewProblemSets: (args) => previewProblemSets(args),
      previewProblemLoad: (args) => previewProblemLoad(args),
      // Self-check, system properties (search / get / who reads it) and the Client trace recording, read only: arm, disarm
      // and clear are deliberately not here.
      doctorRun: (options) => doctorServices.doctorRun(options),
      propertySearch: (query) => propertyServices.propertyExplorerSearch(query),
      propertyGet: (target) => propertyServices.propertyExplorerGet(target),
      propertyUsage: (name) => propertyServices.propertyExplorerUsage(name),
      clientTraceStatus: () => clientTraceServices.clientTraceStatus(),
      clientTraceLoad: () => clientTraceServices.clientTraceLoad(),
      clientTraceResolve: (refs) => clientTraceServices.clientTraceResolve(refs),
      findArtifacts: (args) => searchArtifacts({ ...args, query: (table, query, fields, options) => queryTable(table, query, fields, options), linkFor: recordUrl }),
    },
  };
}
