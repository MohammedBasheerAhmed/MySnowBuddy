import { createToolbar } from './toolbar.js';
import { createCommandPalette } from './commandPalette.js';
import { createToastHost } from './toast.js';
import { getInstanceInfo, copyText } from './quickActions.js';
import { detectPageContext, getCsrfToken } from './context.js';
import { queryTable, fetchRecord, runBackgroundScript, impersonateUser } from './tableApi.js';
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
import { getSettings, getUiState, saveUiState } from './storage.js';

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
};

async function init() {
  if (document.getElementById(HOST_ID)) return;

  const settings = await getSettings();
  if (!settings.toolbarEnabled && !settings.sidebarEnabled && !settings.paletteEnabled) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

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
    runCommand() {},
    registerBackgroundScriptRunner() {},
    registerServices() {},
  };

  if (settings.sidebarEnabled) {
    const sidebarContainer = document.createElement('div');
    sidebarContainer.id = 'msb-sidebar-container';
    shadow.appendChild(sidebarContainer);

    sidebarApi = mountSidebar(sidebarContainer, { getContext: detectPageContext });

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
        const def = ctx?.table ? LINTABLE_TABLES[ctx.table] : null;
        let record = null;
        if (def && ctx.sysId) {
          record = await fetchRecord(ctx.table, ctx.sysId, def.fields);
        }

        const script = record?.[def?.scriptField || 'script'] || ctx?.scriptBody || '';
        const when = record?.when || '';

        return {
          script,
          when,
          table: ctx?.table || '',
          fieldName: def?.scriptField || ctx?.scriptFieldLabel || 'script',
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
        const csrfToken = method === 'GET' ? '' : await getCsrfToken();
        return runRestRequest({ method, path, body, csrfToken });
      },
    });
  }

  const toast = createToastHost();
  shadow.appendChild(toast.element);

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

  const palette = createCommandPalette({
    getContext: detectPageContext,
    sidebar: sidebarApi,
    toast,
    getCsrfToken,
    impersonate: () => impersonate(),
    impersonateByQuery: (sysId) => impersonate(sysId),
  });
  shadow.appendChild(palette.element);

  if (settings.toolbarEnabled) {
    const uiState = await getUiState();
    const toolbar = createToolbar({
      instance: getInstanceInfo(),
      showBadge: settings.instanceBadgeEnabled,
      position: uiState.toolbarPosition,
      onPositionChange: (pos) => saveUiState({ toolbarPosition: pos }),
      primary: {
        label: 'Command palette',
        hint: PALETTE_HINT,
        onClick: () => palette.toggle(),
      },
      buttons: [
        { id: 'chat', label: 'AI chat', icon: 'chat', onClick: () => sidebarApi.toggle() },
        {
          id: 'search',
          label: 'Code search',
          icon: 'search',
          onClick: () => {
            sidebarApi.open();
            sidebarApi.openSearchPanel();
          },
        },
        {
          id: 'lint',
          label: 'Lint this script',
          icon: 'lint',
          onClick: () => {
            sidebarApi.open();
            sidebarApi.runCommand('/lint');
          },
        },
        {
          id: 'sysid',
          label: 'Copy sys_id',
          icon: 'record',
          onClick: async () => {
            const ctx = detectPageContext();
            if (!ctx.sysId) {
              toast.error('No sys_id found on this page.');
              return;
            }
            await copyText(ctx.sysId);
            toast.success(`Copied sys_id ${ctx.sysId}`);
          },
        },
      ],
    });
    shadow.appendChild(toolbar);
  }

  if (settings.paletteEnabled) {
    installHotkeys(palette, sidebarApi);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'TOGGLE_SIDEBAR') sidebarApi.toggle();
    if (message?.type === 'OPEN_PALETTE') palette.toggle();
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

function installHotkeys(palette, sidebarApi) {
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
      }
    },
    true
  );
}

/** Installed in sub-frames only: relays the hotkeys to the top frame's UI. */
function forwardHotkeysToTop() {
  document.addEventListener(
    'keydown',
    (event) => {
      const action = matchesPaletteHotkey(event)
        ? 'palette'
        : matchesChatHotkey(event)
          ? 'chat'
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
  toast.info(`Press ${PALETTE_HINT} to open the MySnowBuddy command palette.`, { timeout: 9000 });
}

function start() {
  if (window.top !== window) {
    // Sub-frames get hotkey forwarding only — no duplicate toolbars.
    forwardHotkeysToTop();
    return;
  }
  init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
