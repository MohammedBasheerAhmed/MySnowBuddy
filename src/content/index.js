import { createCommandPalette } from './commandPalette.js';
import { createToastHost } from './toast.js';
import { createWelcome } from './welcome.js';
import { createGuide } from './guide.js';
import { createWhatsNew } from './whatsNew.js';
import { getInstanceInfo, getCurrentUpdateSet, formDocuments, recordUrl } from './quickActions.js';
import { createAgentTools } from './agentTools.js';
import { createControlDeps } from './controlSession.js';
import { createApprovalDialog } from './approvalDialog.js';
import { installAgentBridge } from './agentBridge.js';
import { createAudit, chromeStorageAdapter } from '../lib/agent/audit.js';
import { detectPageContext, getCsrfToken, installSelectionTracking, startScriptWatcher, readFormScript, detectListInfo } from './context.js';
import { startImpersonating, stopImpersonating } from './impersonation.js';
import { queryTable, fetchRecord, runBackgroundScript, countRecords, queryAll, createRecord, updateRecord, deleteRecord } from './tableApi.js';
import { callPage } from './pageBridge.js';
import { startLogTail } from './logTail.js';
import { fetchVersionList, diffVersions } from './versions.js';
import { fetchTableFields, fetchFieldLive, tableHierarchy, fetchTableInfo, fetchColumnDetail, fetchListLayout } from './fieldInspector.js';
import { fetchAtfSuites, fetchAtfResults, fetchAtfSuiteResults, runAtfSuite, readAtfProgress } from './atf.js';
import { fetchScopes, exportScope, downloadScopeZip } from './scopeExport.js';
import { compareWithInstance } from './remoteRecord.js';
import { listInstances, recordRecent } from './stores.js';
import { createPageWatcher } from './pageWatcher.js';
import { createGuards } from './guards.js';
import { createBreakingCheck, checkBeforeSave } from './breakingCheck.js';
import { findReferences } from './references.js';
import { watchFormControls } from './a11y.js';
import {
  fetchCurrentRecord,
  fetchRelatedRecords,
  runDeterministicChecks,
  isConflictCheckSupported,
} from './conflictCheck.js';
import { fetchCiBatch, summarizeCisForPrompt } from './cmdb.js';
import { searchCode } from './codeSearch.js';
import { fetchLiveUpdateSets, findCollisions, findUncapturedChanges } from './updateSets.js';
import { fetchRecentLogs, fetchSlowTransactions, groupLogs, resolveStackTrace } from './logs.js';
import { getFormDiff } from './formDiff.js';
import { buildDependencyGraph } from './dependencies.js';
import { runSecurityAudit } from './securityAudit.js';
import { runRestRequest } from './restClient.js';
import { lintScript } from '../lib/lint.js';
import { wrapAsDryRun, wrapWithGuards } from '../lib/scriptSafety.js';
import { mountSidebar } from '../sidebar/mount.js';
import { getSettings, saveSettings, onSettingsChanged } from './storage.js';
import { createRoleAccess } from './roleAccess.js';
import { startInstanceTag } from './instanceTag.js';
import { installFieldTools } from './fieldTools.js';
import { installNavSlash } from './navSlash.js';
import { installXray, forwardXrayHotkey } from './xray.js';
import { resumeSaveTraceNotice } from './saveTrace.js';
import { installInline, toggleInline, toggleFieldNames, editScriptInPlace, inlineStatus } from './inline.js';
import { createPopover } from './popover.js';
import { explainText, describeKinds } from './smartSelect.js';
import { openScriptEditor } from './scriptEditor.js';
import { findDefinitionUrl } from './storedCommands.js';
import { extractScriptOutput } from '../lib/logTail.js';
import { startFileSync, stopFileSync, isFileSyncActive } from './fileSync.js';
import { createAutomation } from './automation.js';
import { FEATURE_SERVICES } from './featureServices.js';
import { installFeatures } from './featureStartup.js';
import { attachUiRoot, UI_HOST_ID } from './uiRoot.js';
import { matchesPaletteHotkey, matchesChatHotkey, matchesEditorHotkey, frameHotkeyRelay, sendFrameHotkey } from '../lib/hotkeyRelay.js';

const HOST_ID = UI_HOST_ID;

// Artifact tables whose script field the linter understands, mapped to the
// fields worth pulling for context.
const LINTABLE_TABLES = {
  sys_script: { scriptField: 'script', fields: ['sys_id', 'name', 'script', 'when', 'collection', 'order', 'condition'] },
  sys_script_include: { scriptField: 'script', fields: ['sys_id', 'name', 'script', 'api_name', 'access'] },
  sys_script_client: { scriptField: 'script', fields: ['sys_id', 'name', 'script', 'type', 'table'] },
  sys_security_acl: { scriptField: 'script', fields: ['sys_id', 'name', 'script', 'operation', 'condition'] },
  sys_ui_action: { scriptField: 'script', fields: ['sys_id', 'name', 'script', 'table', 'condition'] },
  sysauto_script: { scriptField: 'script', fields: ['sys_id', 'name', 'script', 'run_type'] },
  sysevent_script_action: { scriptField: 'script', fields: ['sys_id', 'name', 'script', 'event_name'] },
  catalog_script_client: { scriptField: 'script', fields: ['sys_id', 'name', 'script', 'type', 'cat_item'] },
  sys_ui_script: { scriptField: 'script', fields: ['sys_id', 'name', 'script'] },
};

// Tables not listed above are still tried, since most scripted records use a `script` field.
const GENERIC_SCRIPT_TABLE = { scriptField: 'script', fields: ['sys_id', 'name', 'script'] };

// After the extension is reloaded or updated, the old content script is orphaned but its page root stays behind.
// A plain "root exists" check then blocks the fresh copy, leaving the tab without UI or agent bridge until refresh.
// So a newcomer pings the owner: a live owner answers synchronously, an orphan (invalidated context) cannot.
const PING_EVENT = 'msb-ping';
const PONG_ATTR = 'data-msb-pong';

/** Claim the page root synchronously (before any await, so two injections cannot both pass). null = a live copy owns it. */
function claimHost() {
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    existing.setAttribute(PONG_ATTR, '');
    document.dispatchEvent(new Event(PING_EVENT));
    if (existing.getAttribute(PONG_ATTR)) return null;
    existing.remove();
  }
  const host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  document.addEventListener(PING_EVENT, () => {
    if (chrome.runtime?.id && host.isConnected) host.setAttribute(PONG_ATTR, String(Date.now()));
  });
  return host;
}

/** The record's own title from a page title: no "| ServiceNow", no [DEV] tag prefix, '' for the generic shell title. */
function recordTitle(raw) {
  const title = String(raw || '')
    .replace(/\s*\|\s*ServiceNow.*$/i, '')
    .replace(/^\[[^\]]{1,12}\]\s*/, '')
    .trim();
  return /^(Classic\s*\|\s*)?Unified Navigation App$/i.test(title) ? '' : title;
}

async function init() {
  const host = claimHost();
  if (!host) return;

  const settings = await getSettings();
  if (!settings.sidebarEnabled && !settings.paletteEnabled) {
    host.remove();
    return;
  }

  // Closed: page scripts must not reach the UI through the host element (see uiRoot.js).
  const shadow = attachUiRoot(host);
  const applyTheme = (theme) => {
    if (theme === 'light' || theme === 'dark') host.setAttribute('data-theme', theme);
    else host.removeAttribute('data-theme');
  };
  applyTheme(settings.theme);
  onSettingsChanged((next) => applyTheme(next.theme));
  watchFormControls(shadow);

  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = chrome.runtime.getURL('content.css');
  shadow.appendChild(style);

  let sidebarApi = {
    open() {},
    close() {},
    toggle() {},
    openForTool() {},
    notify() {},
    openBackgroundScriptPanel() {},
    loadBackgroundScript() {},
    openComparePanel() {},
    openSearchPanel() {},
    openUpdateSetPanel() {},
    openRestPanel() {},
    openPromptPanel() {},
    openQueryPanel() {},
    openLogTailPanel() {},
    openVersionPanel() {},
    openFieldPanel() {},
    openRemotePanel() {},
    openAtfPanel() {},
    openScopePanel() {},
    openAutomationPanel() {},
    openApiPanel() {},
    openTestPanel() {},
    sendPrompt() {},
    runCommand() {},
    registerBackgroundScriptRunner() {},
    registerServices() {},
  };

  // `toast` is declared below; the wrapper only reads it when a run reports back.
  const automation = createAutomation({
    toast: { success: (m) => toast.success(m), error: (m) => toast.error(m) },
  });

  // The agent's tools run here, next to the page. The sidebar agent and any
  // external MCP client share one executor, one audit log and one approval policy.
  const audit = createAudit(chromeStorageAdapter);
  const agentTools = createAgentTools({
    getContext: detectPageContext,
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
    fetchLogs: async ({ contains = '', minutes = 60 } = {}) => {
      const [logs, slow] = await Promise.all([
        fetchRecentLogs({ contains, minutes, limit: 200 }),
        fetchSlowTransactions({ minutes, limit: 30 }).catch(() => []),
      ]);
      return { groups: groupLogs(logs), slow, minutes, total: logs.length };
    },
    runBackgroundScript,
    getCsrfToken,
    wrapAsDryRun,
    extractScriptOutput,
    runSandbox: (payload) => chrome.runtime.sendMessage({ type: 'SANDBOX_RUN', payload }),
    runAutomation: (steps) => automation.run(steps),
    subscribeAutomation: (fn) => automation.subscribe(fn),
    getCurrentUpdateSet,
    recordUrl,
    audit,
    getSettings, // the agent's safety settings are read fresh at every write
    // `approval` is created further down; the hook is only called later, when navigate needs a person to decide.
    control: createControlDeps({ confirm: (request) => approval.request(request) }),
  });

  if (settings.sidebarEnabled) {
    const sidebarContainer = document.createElement('div');
    sidebarContainer.id = 'msb-sidebar-container';
    shadow.appendChild(sidebarContainer);

    sidebarApi = mountSidebar(sidebarContainer, {
      getContext: detectPageContext,
      instance: settings.instanceBadgeEnabled ? getInstanceInfo() : null,
      onOpenPalette: settings.paletteEnabled ? () => palette.toggle() : null,
    });

    // The runner receives { dryRun } from the sidebar. Dry run wraps the
    // script so GlideRecord writes are intercepted rather than applied.
    sidebarApi.registerBackgroundScriptRunner(async (script, options = {}) => {
      const token = await getCsrfToken();
      const finalScript = options.dryRun ? wrapAsDryRun(script) : wrapWithGuards(script);
      return runBackgroundScript(finalScript, token);
    });

    sidebarApi.registerServices({
      // Services for the panels in src/sidebar/panelRegistry.js; built-in names below win on a clash.
      ...FEATURE_SERVICES,

      // Lets a panel hand over to another one (X-ray -> where is this field used).
      openRegisteredPanel: (name, params) => sidebarApi.openPanel?.(name, params),

      // Phase 2: conflict checker - deterministic checks run locally here,
      // the semantic pass happens in the sidebar via the service worker.
      runConflictCheck: async (ctx) => {
        if (!ctx?.table || !isConflictCheckSupported(ctx.table)) {
          return { supported: false, current: null, related: [], findings: [] };
        }
        const current = (await fetchCurrentRecord(ctx.table, ctx.sysId)) || {
          name: 'unsaved record',
          script: ctx.scriptBody,
        };
        const related = await fetchRelatedRecords(ctx.table, current);
        const findings = runDeterministicChecks(ctx.table, current, related);
        return { supported: true, current, related, findings };
      },

      // Phase 2: CMDB dedupe - pulls a bounded CI batch from the current page's
      // list context when available, otherwise a default cmdb_ci query.
      fetchCis: async () => {
        const ctx = detectPageContext();
        const table = ctx?.table && ctx.table.startsWith('cmdb_ci') ? ctx.table : 'cmdb_ci';
        const cis = await fetchCiBatch({ table });
        return summarizeCisForPrompt(cis);
      },

      // Deterministic linting. Prefers the saved record (so Business Rule
      // timing is known) and falls back to whatever is typed in the form.
      lintCurrent: async (ctx) => {
        const def = ctx?.table ? LINTABLE_TABLES[ctx.table] || GENERIC_SCRIPT_TABLE : null;
        let record = null;
        if (def && ctx.sysId) {
          record = await fetchRecord(ctx.table, ctx.sysId, def.fields).catch(() => null);
        }

        let script = record?.[def?.scriptField || 'script'] || ctx?.scriptBody || '';
        let fieldName = def?.scriptField || ctx?.scriptFieldLabel || 'script';
        if (!script) {
          const fromForm = await readFormScript();
          if (fromForm) {
            script = fromForm.body;
            fieldName = fromForm.label;
          }
        }
        const when = record?.when || '';

        return {
          script,
          when,
          table: ctx?.table || '',
          fieldName,
          findings: lintScript(script, { table: ctx?.table, when }),
        };
      },

      // Generic record fetch used by /atf and /document.
      fetchArtifactRecord: async (ctx) => {
        if (!ctx?.table || !ctx?.sysId) return null;
        const def = LINTABLE_TABLES[ctx.table];
        return fetchRecord(ctx.table, ctx.sysId, def ? def.fields : []);
      },

      // Global code search.
      searchCode: (term, options) => searchCode(term, options),

      // Update set analysis.
      fetchLiveUpdateSets: () => fetchLiveUpdateSets(),
      findCollisions: (updateSetSysId) => findCollisions(updateSetSysId),
      findUncapturedChanges: (options) => findUncapturedChanges(options),

      // Log triage: errors are grouped locally so the model only sees the
      // deduplicated set, not thousands of near-identical lines.
      fetchLogs: async ({ contains = '', minutes = 60 } = {}) => {
        const [logs, slow] = await Promise.all([
          fetchRecentLogs({ contains, minutes, limit: 200 }),
          fetchSlowTransactions({ minutes, limit: 30 }).catch(() => []),
        ]);
        return { groups: groupLogs(logs), slow, minutes, total: logs.length };
      },

      resolveTrace: (text) => resolveStackTrace(text),

      // Pre-save form diff.
      getFormDiff: () => getFormDiff(),

      // Script Include dependency graph.
      buildDependencies: (name) => buildDependencyGraph(name),

      // Read-only security audit.
      runSecurityAudit: () => runSecurityAudit(),

      // REST builder. CSRF token is attached here so the panel never has to
      // handle it directly.
      runRestRequest: async ({ method, path, body }) => {
        const csrfToken = await getCsrfToken();
        return runRestRequest({ method, path, body, csrfToken });
      },

      // List filter tools.
      detectListInfo: () => detectListInfo(),
      countRecords: (table, query) => countRecords(table, query),
      queryAll: (table, query, fields, options) => queryAll(table, query, fields, options),

      // Live log, versions, field inspector.
      startLogTail: (options) => startLogTail(options),
      fetchVersionList: (table, sysId) => fetchVersionList(table, sysId),
      diffVersions: (fromId, toId) => diffVersions(fromId, toId),
      fetchTableFields: (table) => fetchTableFields(table),
      fetchFieldLive: (name) => fetchFieldLive(name),
      fetchTableInfo: (table) => fetchTableInfo(table),
      fetchColumnDetail: (table, element) => fetchColumnDetail(table, element),
      fetchListLayout: (table) => fetchListLayout(table),

      // ATF. Starting a run needs the CSRF token, attached here.
      fetchAtfSuites: (search) => fetchAtfSuites(search),
      fetchAtfResults: () => fetchAtfResults(),
      fetchAtfSuiteResults: () => fetchAtfSuiteResults(),
      runAtfSuite: async (suiteSysId) => runAtfSuite(suiteSysId, await getCsrfToken()),
      readAtfProgress: (progressId) => readAtfProgress(progressId),

      // Scope export, other-instance compare.
      fetchScopes: (search) => fetchScopes(search),
      exportScope: (scope, options) => exportScope(scope, options),
      downloadScopeZip: (scope, files) => downloadScopeZip(scope, files),
      compareWithInstance: (args) => compareWithInstance(args),
      listInstances: () => listInstances(),

      // Apply AI code to the open form (the single write the page bridge allows).
      getScriptFields: () => callPage('getScriptFields'),
      getFieldState: (name) => callPage('getFieldState', [name]),
      setFieldValue: (name, value) => callPage('setFieldValue', [name, value]),

      // AI agent: tool execution, approval previews, the audit log.
      agentExecute: (name, args) => agentTools.execute(name, args),
      agentUndo: () => agentTools.undoWithApproval((request) => approval.request(request)),
      agentPreview: (name, args) => agentTools.preview(name, args),
      readFormScript: () => readFormScript(),
      auditList: async () => (await audit.load()).filter((e) => e.instance === window.location.hostname),

      // Page automation (navigate and click through screens).
      runAutomation: (steps) => automation.run(steps),
      cancelAutomation: () => automation.cancel(),
      snapshotAutomation: () => automation.snapshot(),
      subscribeAutomation: (fn) => automation.subscribe(fn),
    });
  }

  const toast = createToastHost();
  shadow.appendChild(toast.element);

  const approval = createApprovalDialog({ getInstanceInfo });
  shadow.appendChild(approval.element);
  installAgentBridge({ tools: agentTools, approval, getInstanceInfo, audit });

  automation.resume().catch((err) => console.error('[NowBuddy] automation resume failed', err));

  try {
    installSelectionTracking();
    startScriptWatcher();
    installFieldTools({
      toast,
      isEnabled: () => inlineStatus().on,
      openUsage: (table, field) => sidebarApi.openPanel?.('fieldusage', { args: `${table}.${field}` }),
    });
  } catch (err) {
    console.error('[NowBuddy] selection tracking failed', err);
  }

  // Page X-ray: Alt+Shift+X and the palette toggle; chips open the sidebar 'xray' panel.
  try {
    installXray({ sidebar: sidebarApi, toast });
    resumeSaveTraceNotice({ toast, sidebar: sidebarApi });
  } catch (err) {
    console.error('[NowBuddy] page X-ray failed', err);
  }

  installFeatures({ shadow, toast, sidebar: sidebarApi });

  if (settings.instanceTagEnabled !== false) {
    startInstanceTag(shadow).catch((err) => console.error('[NowBuddy] instance tag failed', err));
  }

  async function impersonateUserName(userName) {
    if (!userName || String(userName).includes('^')) {
      toast.error('That user name is not valid.');
      return;
    }
    const results = await queryTable('sys_user', `user_name=${userName}`, ['sys_id', 'user_name']);
    if (!results.length) {
      toast.error(`No user found for "${userName}".`);
      return;
    }
    return impersonate(results[0].sys_id);
  }

  async function impersonate(sysIdOrNull) {
    try {
      let sysId = sysIdOrNull;
      if (!sysId) {
        // The palette already searches users as you type @name; a browser prompt() would block the page.
        setTimeout(() => palette.open('@'), 0);
        return;
      }
      await startImpersonating(sysId);
      window.location.reload();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function endImpersonating() {
    try {
      await stopImpersonating();
      window.location.reload();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function toggleTheme() {
    const { theme } = await getSettings();
    const dark = theme === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : theme === 'dark';
    const next = dark ? 'light' : 'dark';
    await saveSettings({ theme: next });
    return next;
  }

  // Services the full-screen editor uses beyond editing text.
  const editorTools = {
    runScript: async (script, { dryRun }) => {
      const token = await getCsrfToken();
      const html = await runBackgroundScript(dryRun ? wrapAsDryRun(script) : wrapWithGuards(script), token);
      return extractScriptOutput(html);
    },
    askAi: (label, prompt) => sidebarApi.sendPrompt(label, prompt),
    openCompare: () => sidebarApi.openRemotePanel(),
    getUpdateSet: () => getCurrentUpdateSet(),
    findDefinition: (name) => findDefinitionUrl(name),
    openFieldUsage: (table, field) => sidebarApi.openPanel?.('fieldusage', { args: `${table}.${field}` }),
    findReferences: (target, opts) => findReferences(target, opts),
    // The editor hands a system property name to the System properties panel and reads its value for the hover (read-only).
    openPanel: (name, params) => Boolean(sidebarApi.openPanel?.(name, params)),
    propertyValue: (name) => FEATURE_SERVICES.propertyExplorerGet({ name }),
    beforeSave: () => checkBeforeSave({ toast }),
    isProd: () => getInstanceInfo().env === 'prod',
  };
  // `field` and `place` are optional: the on-page Edit button opens the editor over the field itself.
  // With no `place` the script opens right over the field when one is on screen (that is the easy way); `fullScreen` or a
  // page without a visible script field gets the full-screen editor.
  const openEditor = (opts) => {
    if (!opts?.place && !opts?.fullScreen && editScriptInPlace()) return undefined;
    return openScriptEditor({ shadow, toast, tools: editorTools, field: opts?.field, place: opts?.place });
  };

  // Classic forms live in a sub-frame; tell the tab's frames (through the service worker, not
  // window.postMessage, which page scripts can forge) when the palette is open so they relay keys.
  function broadcastPaletteState(open) {
    try {
      chrome.runtime.sendMessage({ type: 'PALETTE_STATE', payload: { open: Boolean(open) } })?.catch?.(() => {});
    } catch {
      // Extension context invalidated (reloaded); nothing to relay.
    }
  }

  let welcome = null;
  let guide = null;
  let whatsNew = null;
  const popover = createPopover({ shadow, toast });
  const roleAccess = createRoleAccess({ getSettings });
  roleAccess.refresh();
  onSettingsChanged(() => roleAccess.refresh());
  const palette = createCommandPalette({
    roleAccess,
    showWelcome: () => welcome?.show(),
    showGuide: () => guide?.show(),
    showWhatsNew: () => whatsNew?.show(),
    getContext: detectPageContext,
    sidebar: sidebarApi,
    toast,
    getCsrfToken,
    openScriptEditor: openEditor,
    startFileSync: () => startFileSync({ toast }),
    stopFileSync,
    isFileSyncActive,
    setTheme: (theme) => saveSettings({ theme }),
    setToolSurface: (toolSurface) => saveSettings({ toolSurface }),
    setInline: (inlineEnabled) => saveSettings({ inlineEnabled }),
    inlineOn: () => inlineStatus().on,
    toggleFieldNames: () => toggleFieldNames(),
    fieldNamesOn: () => inlineStatus().names,
    decodeSelection: (text) => explainText(text, { popover, toast, anchor: { x: Math.round(window.innerWidth / 2) - 150, y: 140 } }),
    selectionKind: (text) => describeKinds(text),
    toggleTheme,
    onOpenChange: broadcastPaletteState,
    impersonate: () => impersonate(),
    impersonateByQuery: (sysId) => impersonate(sysId),
    impersonateUserName: (userName) => impersonateUserName(userName),
    endImpersonation: () => endImpersonating(),
  });
  shadow.appendChild(palette.element);

  // First-run card, shown once; "Quick tour" in the palette brings it back.
  welcome = createWelcome({ shadow, openPalette: () => palette.open(), openGuide: () => guide?.show() });
  guide = createGuide({ shadow, openPalette: (text) => palette.open(text), getContext: detectPageContext, showTour: () => welcome?.show() });
  welcome.maybeShow();
  // "What's new": once per version, only for people who already dismissed the first-run card; "What's new" in the palette brings it back.
  whatsNew = createWhatsNew({
    shadow,
    openPalette: (text) => palette.open(text),
    openPanel: (name) => {
      sidebarApi.openForTool();
      sidebarApi.openPanel?.(name);
    },
    openEditor: () => openEditor(),
    isPaletteOpen: () => palette.isOpen(),
    getVersion: () => chrome.runtime.getManifest().version,
  });
  whatsNew.maybeShow();

  // On-page tools (page toolbar, field and column menus, sys_id peek). Installed always, dormant when
  // switched off in Options, so the setting (or the palette command) can turn them on without a reload.
  try {
    installInline({
      shadow,
      toast,
      sidebar: sidebarApi,
      popover,
      openEditor,
      tools: { lintScript },
      roleAccess,
      enabled: settings.inlineEnabled !== false,
    });
    onSettingsChanged((next) => toggleInline(next.inlineEnabled !== false));
  } catch (err) {
    console.error('[NowBuddy] on-page tools failed', err);
  }

  // Notice navigation (classic and Next Experience change pages without a reload).
  try {
    startPageFeatures();
  } catch (err) {
    console.error('[NowBuddy] page features failed', err);
  }

  function startPageFeatures() {
    const watcher = createPageWatcher(detectPageContext);

    const guards = createGuards({
      toast,
      getSettings,
      getContext: detectPageContext,
      getInstanceInfo,
      getCurrentUpdateSet,
      onChangeUpdateSet: () => {
        // The notice says changes are going to Default; the fix is a named set, so open My work on its create form.
        sidebarApi.openForTool();
        if (!sidebarApi.openPanel?.('mywork', { args: 'new' })) sidebarApi.openUpdateSetPanel();
      },
    });
    watcher.subscribe((ctx) => guards.onPageChange(ctx));
    createBreakingCheck({ toast, getSettings, getContext: detectPageContext });

    watcher.subscribe((ctx) => {
      if (ctx.isList || !ctx.table || !ctx.sysId) return;
      // The title settles after the frame loads, and the shell shows a generic one first: retry until it is the record's.
      let attempts = 0;
      const tryRecord = () => {
        attempts += 1;
        const docs = formDocuments();
        const title = recordTitle(docs[docs.length - 1]?.title || document.title);
        if (!title && attempts < 8) {
          setTimeout(tryRecord, 1500);
          return;
        }
        recordRecent(window.location.hostname, {
          table: ctx.table,
          sysId: ctx.sysId,
          title,
          path: recordUrl(ctx.table, ctx.sysId),
        }).catch(() => {});
      };
      setTimeout(tryRecord, 1500);
    });
  }

  if (settings.paletteEnabled) {
    installHotkeys(palette, sidebarApi, openEditor);
    installNavSlash({ palette });
  }

  // Only the extension (the service worker) can send these; page scripts cannot.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'TOGGLE_SIDEBAR') sidebarApi.toggle();
    if (message?.type === 'OPEN_PALETTE') palette.toggle();
    if (message?.type === 'AUTOMATION_RESUME') automation.resume().catch(() => {});
    // Classic UI runs the form inside the `gsft_main` iframe, where this script deliberately
    // does not mount a UI. The iframe's copy relays trusted hotkeys up here through the service
    // worker (see forwardHotkeysToTop) so the palette can be opened while the cursor is in a form field.
    if (message?.type === 'FRAME_HOTKEY') {
      if (message.action === 'palette') palette.toggle();
      if (message.action === 'chat') sidebarApi.toggle();
      if (message.action === 'editor') openEditor();
      if (message.action === 'key' && message.key) palette.handleKey(message.key);
    }
  });

  notifyIfFirstRun(toast);
}

const PALETTE_HINT = 'Ctrl+Shift+Space';

function installHotkeys(palette, sidebarApi, openEditor) {
  // Capture phase: ServiceNow form fields and the list editor swallow a lot of
  // key events on the bubble phase.
  document.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted) return; // a page script's synthetic keydown
      if (matchesPaletteHotkey(event)) {
        event.preventDefault();
        event.stopPropagation();
        palette.toggle();
        return;
      }
      if (matchesChatHotkey(event)) {
        event.preventDefault();
        event.stopPropagation();
        sidebarApi.toggle();
        return;
      }
      if (matchesEditorHotkey(event)) {
        event.preventDefault();
        event.stopPropagation();
        openEditor();
      }
    },
    true
  );
}

/**
 * Installed in sub-frames only: relays trusted hotkeys to the top frame's UI through the
 * service worker (src/lib/hotkeyRelay.js). The palette state arrives the same way.
 */
function forwardHotkeysToTop() {
  let paletteOpen = false;
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'PALETTE_STATE') paletteOpen = message.open === true;
  });

  document.addEventListener(
    'keydown',
    (event) => {
      const relay = frameHotkeyRelay(event, { paletteOpen });
      if (!relay) return;
      event.preventDefault();
      if (relay.action === 'key') event.stopImmediatePropagation();
      sendFrameHotkey(relay);
    },
    true
  );
}

const FIRST_RUN_KEY = 'mysnowbuddy_seen_palette_hint';

async function notifyIfFirstRun(toast) {
  const stored = await chrome.storage.local.get(FIRST_RUN_KEY);
  if (stored[FIRST_RUN_KEY]) return;
  await chrome.storage.local.set({ [FIRST_RUN_KEY]: true });
  toast.info(
    `NowBuddy: ${PALETTE_HINT} opens the command palette (type / for shortcuts), Alt+Shift+E the script editor, Alt+Shift+C chat.`,
    { timeout: 9000 }
  );
}

function start() {
  if (window.top !== window) {
    // Sub-frames get hotkey forwarding only — no duplicate UIs.
    forwardHotkeysToTop();
    forwardXrayHotkey();
    return;
  }
  init().catch((err) => console.error('[NowBuddy] failed to start', err));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
