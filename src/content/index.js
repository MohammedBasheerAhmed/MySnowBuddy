import { createCommandPalette } from './commandPalette.js';
import { createToastHost } from './toast.js';
import { getInstanceInfo, getCurrentUpdateSet, formDocuments, recordUrl } from './quickActions.js';
import { detectPageContext, getCsrfToken, installSelectionTracking, startScriptWatcher, readFormScript, detectListInfo } from './context.js';
import { queryTable, fetchRecord, runBackgroundScript, impersonateUser, countRecords, queryAll } from './tableApi.js';
import { callPage } from './pageBridge.js';
import { startLogTail } from './logTail.js';
import { fetchVersionList, diffVersions } from './versions.js';
import { fetchTableFields, fetchFieldLive } from './fieldInspector.js';
import { fetchAtfSuites, fetchAtfResults, fetchAtfSuiteResults, runAtfSuite, readAtfProgress } from './atf.js';
import { fetchScopes, exportScope, downloadScopeZip } from './scopeExport.js';
import { compareWithInstance } from './remoteRecord.js';
import { listInstances, recordRecent } from './stores.js';
import { createPageWatcher } from './pageWatcher.js';
import { createGuards } from './guards.js';
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
import { startInstanceTag } from './instanceTag.js';
import { installFieldTools } from './fieldTools.js';
import { openScriptEditor } from './scriptEditor.js';
import { findDefinitionUrl } from './storedCommands.js';
import { extractScriptOutput } from '../lib/logTail.js';
import { startFileSync, stopFileSync, isFileSyncActive } from './fileSync.js';
import { createAutomation } from './automation.js';

const HOST_ID = 'mysnowbuddy-root';

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

async function init() {
  if (document.getElementById(HOST_ID)) return;

  const settings = await getSettings();
  if (!settings.sidebarEnabled && !settings.paletteEnabled) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
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
    notify() {},
    openBackgroundScriptPanel() {},
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
    sendPrompt() {},
    runCommand() {},
    registerBackgroundScriptRunner() {},
    registerServices() {},
  };

  // `toast` is declared below; the wrapper only reads it when a run reports back.
  const automation = createAutomation({
    toast: { success: (m) => toast.success(m), error: (m) => toast.error(m) },
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

      // Page automation (navigate and click through screens).
      runAutomation: (steps) => automation.run(steps),
      cancelAutomation: () => automation.cancel(),
      snapshotAutomation: () => automation.snapshot(),
      subscribeAutomation: (fn) => automation.subscribe(fn),
    });
  }

  const toast = createToastHost();
  shadow.appendChild(toast.element);

  automation.resume().catch((err) => console.error('[MySnowBuddy] automation resume failed', err));

  try {
    installSelectionTracking();
    startScriptWatcher();
    installFieldTools({ toast });
  } catch (err) {
    console.error('[MySnowBuddy] selection tracking failed', err);
  }

  if (settings.instanceTagEnabled !== false) {
    startInstanceTag(shadow).catch((err) => console.error('[MySnowBuddy] instance tag failed', err));
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
        const userQuery = window.prompt('Enter user_name to impersonate:');
        if (!userQuery) return;
        const results = await queryTable('sys_user', `user_name=${userQuery}`, ['sys_id', 'user_name']);
        if (!results.length) {
          toast.error(`No user found for "${userQuery}".`);
          return;
        }
        sysId = results[0].sys_id;
      }
      const token = await getCsrfToken();
      await impersonateUser(sysId, token);
    } catch (err) {
      toast.error(`Impersonation failed: ${err.message}`);
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
    isProd: () => getInstanceInfo().env === 'prod',
  };
  const openEditor = () => openScriptEditor({ shadow, toast, tools: editorTools });

  // Classic forms live in a same-origin iframe; tell it when the palette is open so it can relay keys.
  function broadcastPaletteState(open) {
    document.querySelectorAll('iframe').forEach((frame) => {
      try {
        frame.contentWindow?.postMessage({ source: 'msb-palette-state', open }, window.location.origin);
      } catch {
        // Cross-origin frame; nothing to relay.
      }
    });
  }

  const palette = createCommandPalette({
    getContext: detectPageContext,
    sidebar: sidebarApi,
    toast,
    getCsrfToken,
    openScriptEditor: openEditor,
    startFileSync: () => startFileSync({ toast }),
    stopFileSync,
    isFileSyncActive,
    setTheme: (theme) => saveSettings({ theme }),
    toggleTheme,
    onOpenChange: broadcastPaletteState,
    impersonate: () => impersonate(),
    impersonateByQuery: (sysId) => impersonate(sysId),
    impersonateUserName: (userName) => impersonateUserName(userName),
  });
  shadow.appendChild(palette.element);

  // Notice navigation (classic and Next Experience change pages without a reload).
  try {
    startPageFeatures();
  } catch (err) {
    console.error('[MySnowBuddy] page features failed', err);
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
        sidebarApi.open();
        sidebarApi.openUpdateSetPanel();
      },
    });
    watcher.subscribe((ctx) => guards.onPageChange(ctx));

    watcher.subscribe((ctx) => {
      if (ctx.isList || !ctx.table || !ctx.sysId) return;
      // Give the frame a moment to set its title.
      setTimeout(() => {
        const docs = formDocuments();
        const title = (docs[docs.length - 1].title || document.title || '').replace(/\s*\|\s*ServiceNow.*$/i, '');
        recordRecent(window.location.hostname, {
          table: ctx.table,
          sysId: ctx.sysId,
          title,
          path: recordUrl(ctx.table, ctx.sysId),
        }).catch(() => {});
      }, 1500);
    });
  }

  if (settings.paletteEnabled) {
    installHotkeys(palette, sidebarApi, openEditor);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'TOGGLE_SIDEBAR') sidebarApi.toggle();
    if (message?.type === 'OPEN_PALETTE') palette.toggle();
    if (message?.type === 'AUTOMATION_RESUME') automation.resume().catch(() => {});
  });

  // Classic UI runs the form inside the same-origin `gsft_main` iframe, where
  // this script deliberately does not mount a UI. The iframe instance still
  // forwards its hotkeys up here (see forwardHotkeysToTop) so the palette can
  // be opened while the cursor is in a form field.
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.source !== 'msb-frame-hotkey') return;
    if (event.data.action === 'palette') palette.toggle();
    if (event.data.action === 'chat') sidebarApi.toggle();
    if (event.data.action === 'editor') openEditor();
    if (event.data.action === 'key') palette.handleKey(event.data.key);
  });

  notifyIfFirstRun(toast);
}

const PALETTE_HINT = 'Ctrl+Shift+Space';

function matchesPaletteHotkey(event) {
  return event.ctrlKey && event.shiftKey && !event.altKey && (event.code === 'Space' || event.key === ' ');
}

function matchesChatHotkey(event) {
  return event.altKey && event.shiftKey && !event.ctrlKey && event.code === 'KeyC';
}

function matchesEditorHotkey(event) {
  return event.altKey && event.shiftKey && !event.ctrlKey && event.code === 'KeyE';
}

function installHotkeys(palette, sidebarApi, openEditor) {
  // Capture phase: ServiceNow form fields and the list editor swallow a lot of
  // key events on the bubble phase.
  document.addEventListener(
    'keydown',
    (event) => {
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

/** Installed in sub-frames only: relays the hotkeys to the top frame's UI. */
function forwardHotkeysToTop() {
  let paletteOpen = false;
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.data?.source !== 'msb-palette-state') return;
    paletteOpen = !!event.data.open;
  });

  const NAV_KEYS = new Set(['Escape', 'ArrowDown', 'ArrowUp', 'Enter', 'Home', 'End']);

  document.addEventListener(
    'keydown',
    (event) => {
      if (paletteOpen && (NAV_KEYS.has(event.key) || (event.ctrlKey && ['n', 'p'].includes(event.key.toLowerCase())))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.top.postMessage(
          {
            source: 'msb-frame-hotkey',
            action: 'key',
            key: { key: event.key, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, metaKey: event.metaKey },
          },
          window.location.origin
        );
        return;
      }
      const action = matchesPaletteHotkey(event)
        ? 'palette'
        : matchesChatHotkey(event)
          ? 'chat'
          : matchesEditorHotkey(event)
            ? 'editor'
            : null;
      if (!action) return;
      event.preventDefault();
      window.top.postMessage({ source: 'msb-frame-hotkey', action }, window.location.origin);
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
    `MySnowBuddy: ${PALETTE_HINT} opens the command palette (type / for shortcuts), Alt+Shift+E the script editor, Alt+Shift+C chat.`,
    { timeout: 9000 }
  );
}

function start() {
  if (window.top !== window) {
    // Sub-frames get hotkey forwarding only — no duplicate UIs.
    forwardHotkeysToTop();
    return;
  }
  init().catch((err) => console.error('[MySnowBuddy] failed to start', err));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
