// The single command registry. Both the command palette and the toolbar rail
// render from this list, so an action only ever has to be defined once.
//
// A command is:
//   { id, title, hint, group, keywords, url?, run?, newTab? }
// Commands with a `url` are navigations and support "open in a new tab" via
// Shift/Ctrl+Enter; commands with a `run` execute in place.

import {
  listUrl,
  recordUrl,
  newRecordUrl,
  xmlUrl,
  absoluteUrl,
  tableConfigTargets,
  toggleTechnicalNames,
  getRecordInfo,
  getNodeInfo,
  copyText,
  fetchSelectableUpdateSets,
  setCurrentUpdateSet,
  findRecordBySysId,
  isSysId,
} from './quickActions.js';
import { searchTables, labelForTable } from './tableCatalog.js';
import { queryTable } from './tableApi.js';
import { addBookmark } from './stores.js';
import { currentPageHref } from './context.js';
import { resolveTarget } from '../lib/urlTarget.js';
import { isScriptLabel } from '../lib/inline.js';
import { formDocuments } from './quickActions.js';
import { PANELS } from '../sidebar/panelRegistry.js';
import { toggleXray, xrayServices } from './xray.js';

const xrayStatus = () => xrayServices.xrayStatus();

// The page on screen as a root-relative path, plus a readable title.
function currentPageBookmark() {
  const url = resolveTarget(currentPageHref());
  if (!url) throw new Error('This page cannot be bookmarked.');
  const docs = formDocuments();
  const title = (docs[docs.length - 1].title || document.title || url.pathname).replace(/\s*\|\s*ServiceNow.*$/i, '');
  return { title, path: `${url.pathname}${url.search}` };
}

export const GROUPS = {
  record: 'This record',
  table: 'This table',
  analyze: 'Analyze',
  ai: 'AI',
  navigate: 'Navigate',
  instance: 'Instance',
  tools: 'Tools',
};

/**
 * Build the full command list for the page as it is right now.
 * Called each time the palette opens so table/record-scoped commands reflect
 * the page the user is actually looking at.
 *
 * @param {object} deps - { ctx, sidebar, toast, getCsrfToken, impersonate }
 */
export function buildCommands(deps) {
  const { ctx = {}, sidebar, toast, getCsrfToken, impersonate, openScriptEditor, startFileSync, stopFileSync, isFileSyncActive } = deps;
  const table = ctx.table || '';
  const sysId = ctx.sysId || '';
  const commands = [];

  const add = (cmd) => commands.push(cmd);
  // Tools open where the user chose (floating window or docked); only the chat itself needs the sidebar.
  const openPanel = (fn) => () => {
    sidebar.openForTool();
    fn();
  };
  const runSlash = (command) => () => {
    sidebar.runCommand(command);
  };

  // A list or a form without a script column has nothing to edit.
  const hasScript = Boolean(table && sysId && ctx.scriptBody && isScriptLabel(ctx.scriptFieldLabel));

  if (hasScript && openScriptEditor) {
    add({
      id: 'tools.editor',
      title: 'Edit script in full-screen editor',
      hint: 'Alt+Shift+E \u00b7 highlighting, find and replace, Ctrl+S applies to the form',
      group: GROUPS.record,
      keywords: 'edit script editor code fullscreen monaco highlight replace',
      run: () => openScriptEditor(),
    });
  }

  if (hasScript && startFileSync) {
    add({
      id: 'tools.fileSync',
      title: 'Edit script in VS Code (sync to a folder)',
      hint: 'Pick a folder; the script stays in sync with a local file',
      group: GROUPS.record,
      keywords: 'vscode vs code sync file local editor external',
      run: () => startFileSync(),
    });
  }

  if (stopFileSync && isFileSyncActive?.()) {
    add({
      id: 'tools.fileSyncStop',
      title: 'Stop file sync',
      hint: 'Stop syncing this script to your local file',
      group: GROUPS.record,
      keywords: 'stop end file sync vscode',
      run: () => {
        stopFileSync();
        toast.info('File sync stopped.');
      },
    });
  }

  // --- This record ---------------------------------------------------------
  if (table && sysId) {
    const label = labelForTable(table);

    add({
      id: 'record.copySysId',
      title: 'Copy sys_id',
      hint: sysId,
      group: GROUPS.record,
      keywords: 'sysid id clipboard',
      run: async () => {
        await copyText(sysId);
        toast.success(`Copied sys_id ${sysId}`);
      },
    });

    add({
      id: 'record.copyUrl',
      title: 'Copy record URL',
      hint: `${table}.do`,
      group: GROUPS.record,
      keywords: 'link share clipboard url',
      run: async () => {
        await copyText(absoluteUrl(recordUrl(table, sysId)));
        toast.success('Copied record URL');
      },
    });

    add({
      id: 'record.copyMarkdown',
      title: 'Copy record as markdown link',
      hint: 'A [title](link) to paste into a ticket or doc',
      group: GROUPS.record,
      keywords: 'link share clipboard markdown',
      run: async () => {
        const info = await getRecordInfo(table, sysId).catch(() => null);
        const text = `[${info?.className || label} ${sysId.slice(0, 8)}](${absoluteUrl(recordUrl(table, sysId))})`;
        await copyText(text);
        toast.success('Copied markdown link');
      },
    });

    add({
      id: 'record.xml',
      title: 'Open record XML',
      hint: 'Raw field values',
      group: GROUPS.record,
      keywords: 'xml export raw payload',
      url: xmlUrl(table, sysId),
      raw: true,
    });

    add({
      id: 'record.info',
      title: 'Record info',
      hint: 'Created / updated / update count',
      group: GROUPS.record,
      keywords: 'who created updated audit metadata',
      run: async () => {
        const info = await getRecordInfo(table, sysId);
        if (!info) {
          toast.error('Could not read this record.');
          return;
        }
        toast.info(
          `${info.className} · created ${info.createdOn} by ${info.createdBy} · ` +
            `updated ${info.updatedOn} by ${info.updatedBy} · ${info.updates} updates`,
          { timeout: 12000 }
        );
      },
    });

    add({
      id: 'record.history',
      title: 'Record audit history',
      hint: 'Who changed which field, and when (needs auditing on)',
      group: GROUPS.record,
      keywords: 'audit changes history who',
      url: listUrl('sys_audit', `documentkey=${sysId}^ORDERBYDESCsys_created_on`),
    });

    add({
      id: 'record.versions',
      title: 'Record versions',
      hint: 'sys_update_version',
      group: GROUPS.record,
      keywords: 'version compare revert update',
      url: listUrl('sys_update_version', `name=${table}_${sysId}^ORDERBYDESCsys_recorded_at`),
    });

    add({
      id: 'record.versionDiff',
      title: 'Compare versions of this record',
      hint: 'Field-level diff, no tokens',
      group: GROUPS.record,
      keywords: 'version history diff compare changes revert who changed',
      run: openPanel(() => sidebar.openVersionPanel()),
    });

    add({
      id: 'record.remote',
      title: 'Compare with another instance',
      hint: 'Same record, other environment',
      group: GROUPS.record,
      keywords: 'other instance environment dev test prod diff open same record',
      run: openPanel(() => sidebar.openRemotePanel()),
    });

    add({
      id: 'record.updateEntry',
      title: 'Update set entry for this record',
      hint: 'Check this change was captured for deployment',
      group: GROUPS.record,
      keywords: 'update set xml captured deployment',
      url: listUrl('sys_update_xml', `name=${table}_${sysId}^ORDERBYDESCsys_updated_on`),
    });

    add({
      id: 'record.newTab',
      title: 'Open this record in a new tab',
      hint: 'Keep this one and open another copy',
      group: GROUPS.record,
      keywords: 'tab window duplicate',
      url: recordUrl(table, sysId),
      newTab: true,
    });
  }

  // --- This table ----------------------------------------------------------
  if (table) {
    add({
      id: 'table.list',
      title: `Open ${table} list`,
      hint: labelForTable(table),
      group: GROUPS.table,
      keywords: 'list records open',
      url: listUrl(table),
    });

    add({
      id: 'table.new',
      title: `New ${table} record`,
      hint: 'Create a blank record on this table',
      group: GROUPS.table,
      keywords: 'create insert new',
      url: newRecordUrl(table),
    });

    add({
      id: 'table.fields',
      title: `Table explorer for ${table}: columns, choices, list layouts`,
      hint: 'Types, references, defaults',
      group: GROUPS.table,
      keywords: 'fields columns dictionary inspector explorer choices labels list layout types reference mandatory',
      run: openPanel(() => sidebar.openFieldPanel()),
    });

    tableConfigTargets(table).forEach((target) => {
      add({
        id: `table.cfg.${target.label.replace(/\s+/g, '').toLowerCase()}`,
        title: `${target.label} for ${table}`,
        group: GROUPS.table,
        keywords: `${target.label} configuration ${table}`,
        url: target.url,
      });
    });
  }

  // --- Analyze (deterministic, no AI tokens) -------------------------------
  add({
    id: 'analyze.lint',
    title: 'Lint this script',
    hint: 'Deterministic, no tokens',
    group: GROUPS.analyze,
    keywords: 'lint static analysis quality rules',
    run: runSlash('/lint'),
  });

  add({
    id: 'analyze.formdiff',
    title: 'Show unsaved form changes',
    hint: 'Deterministic, no tokens',
    group: GROUPS.analyze,
    keywords: 'diff dirty unsaved changes form',
    run: runSlash('/formdiff'),
  });

  add({
    id: 'analyze.listTools',
    title: 'List filter tools',
    hint: 'Explain, GlideRecord code, count, export',
    group: GROUPS.analyze,
    keywords: 'filter query encoded glide record code export csv count list',
    run: openPanel(() => sidebar.openQueryPanel()),
  });

  add({
    id: 'analyze.logTail',
    title: 'Live log',
    hint: 'Watch the system log',
    group: GROUPS.analyze,
    keywords: 'log tail live syslog watch errors',
    run: openPanel(() => sidebar.openLogTailPanel()),
  });

  add({
    id: 'analyze.search',
    title: 'Code search across the instance',
    hint: 'Find a word or call in every script field',
    group: GROUPS.analyze,
    keywords: 'find grep script search text',
    run: openPanel(() => sidebar.openSearchPanel()),
  });

  add({
    id: 'analyze.updateset',
    title: 'Update set review',
    hint: 'Collisions and uncaptured changes',
    group: GROUPS.analyze,
    keywords: 'update set deploy collision coverage',
    run: openPanel(() => sidebar.openUpdateSetPanel()),
  });

  add({
    id: 'analyze.audit',
    title: 'Security audit',
    hint: 'Look for ACLs that expose data too widely',
    group: GROUPS.analyze,
    keywords: 'security acl public risk audit',
    run: runSlash('/audit'),
  });

  add({
    id: 'analyze.compare',
    title: 'Compare instances',
    hint: 'See what differs between two instances',
    group: GROUPS.analyze,
    keywords: 'diff instances compare environments',
    run: openPanel(() => sidebar.openComparePanel()),
  });

  add({
    id: 'analyze.conflict',
    title: 'Conflict check',
    hint: 'Find other rules on this table that could clash',
    group: GROUPS.analyze,
    keywords: 'conflict order collision duplicate',
    run: runSlash('/conflictcheck'),
  });

  // --- AI ------------------------------------------------------------------
  add({
    id: 'ai.chat',
    title: 'Open AI chat',
    hint: 'Alt+Shift+C',
    group: GROUPS.ai,
    keywords: 'chat ask assistant ai sidebar',
    run: () => sidebar.toggle(),
  });

  add({
    id: 'ai.prompts',
    title: 'Prompt library',
    hint: 'Saved and built-in prompts',
    group: GROUPS.ai,
    keywords: 'prompt library templates saved snippets',
    run: openPanel(() => sidebar.openPromptPanel()),
  });

  add({
    id: 'ai.snippets',
    title: 'Code snippets',
    hint: 'GlideRecord, dates, REST and more',
    group: GROUPS.ai,
    keywords: 'snippets code templates glide record examples',
    run: openPanel(() => sidebar.openPromptPanel('snippets')),
  });

  add({
    id: 'ai.review',
    title: 'AI code review',
    hint: 'The AI reviews this script (uses tokens)',
    group: GROUPS.ai,
    keywords: 'review ai quality security',
    run: runSlash('/review'),
  });

  add({
    id: 'ai.logs',
    title: 'Error triage',
    hint: 'The AI explains the recent errors (uses tokens)',
    group: GROUPS.ai,
    keywords: 'errors logs triage syslog',
    run: runSlash('/logs'),
  });

  add({
    id: 'ai.atf',
    title: 'Generate ATF test outline',
    hint: 'The AI drafts ATF test steps (uses tokens)',
    group: GROUPS.ai,
    keywords: 'atf test automated outline',
    run: runSlash('/atf'),
  });

  add({
    id: 'ai.document',
    title: 'Generate documentation',
    hint: 'The AI drafts documentation for this script (uses tokens)',
    group: GROUPS.ai,
    keywords: 'document docs describe',
    run: runSlash('/document'),
  });

  // --- Tools ---------------------------------------------------------------
  add({
    id: 'tools.background',
    title: 'Background script runner',
    hint: 'Dry run on by default',
    group: GROUPS.tools,
    keywords: 'background script run execute gs',
    run: openPanel(() => sidebar.openBackgroundScriptPanel()),
  });

  add({
    id: 'tools.atf',
    title: 'ATF: run suites and results',
    hint: 'Run automated test suites and read the results',
    group: GROUPS.tools,
    keywords: 'atf test suite run results automated',
    run: openPanel(() => sidebar.openAtfPanel()),
  });

  add({
    id: 'tools.scopeExport',
    title: 'Export a scope as ZIP',
    hint: 'One file per script',
    group: GROUPS.tools,
    keywords: 'export scope application zip scripts git code review',
    run: openPanel(() => sidebar.openScopePanel()),
  });

  add({
    id: 'tools.bookmark',
    title: 'Bookmark this page',
    hint: 'Save this page so the palette can open it later',
    group: GROUPS.tools,
    keywords: 'bookmark save favourite page link',
    run: async () => {
      const { title, path } = currentPageBookmark();
      await addBookmark(window.location.hostname, { title, path });
      toast.success(`Bookmarked "${title}"`);
    },
  });

  add({
    id: 'tools.rest',
    title: 'REST builder',
    hint: 'Build and send a REST request to this instance',
    group: GROUPS.tools,
    keywords: 'rest api request http builder',
    run: openPanel(() => sidebar.openRestPanel()),
  });

  add({
    id: 'tools.api',
    title: 'API explorer',
    hint: 'Search the verified client and server API catalog',
    group: GROUPS.tools,
    keywords: 'api catalog reference docs gliderecord g_form gs methods lookup verified',
    run: openPanel(() => sidebar.openApiPanel()),
  });
  add({
    id: 'tools.testbench',
    title: 'Client script test bench',
    hint: 'Simulate a client script against a fake form',
    group: GROUPS.tools,
    keywords: 'client script test simulate sandbox g_form onchange onload onsubmit bench',
    run: openPanel(() => sidebar.openTestPanel()),
  });
  add({
    id: 'tools.verify',
    title: 'Verify the script on this form',
    hint: 'Syntax, API catalog, lint and structure checks (no AI tokens)',
    group: GROUPS.tools,
    keywords: 'verify check validate script lint api catalog hallucination',
    run: runSlash('/verify'),
  });
  add({
    id: 'tools.automate',
    title: 'Automation',
    hint: 'Navigate and click through screens',
    group: GROUPS.tools,
    keywords: 'automate automation macro script navigate click type steps browser',
    run: openPanel(() => sidebar.openAutomationPanel()),
  });

  add({
    id: 'tools.technicalNames',
    title: 'Toggle technical field names',
    hint: 'Show database names on the form',
    group: GROUPS.tools,
    keywords: 'field names technical dictionary labels show',
    run: () => {
      const { enabled, count } = toggleTechnicalNames();
      toast.info(enabled ? `Showing ${count} field names` : 'Field names hidden');
    },
  });

  // Page X-ray (src/content/xray.js) shows its own toast for on and off.
  add({
    id: 'analyze.xrayToggle',
    title: xrayStatus().on ? 'Turn off page X-ray' : 'Turn on page X-ray',
    hint: 'Alt+Shift+X · field logic chips, list columns, catalog variables, portal widgets',
    group: GROUPS.analyze,
    icon: 'xray',
    keywords: 'xray x-ray inspect annotate overlay field chips logic why read only mandatory hidden widget portal catalog variable columns',
    run: () => toggleXray(),
  });

  add({
    id: 'tools.theme.toggle',
    title: 'Toggle dark / light',
    hint: 'Switch the theme right now',
    group: GROUPS.tools,
    keywords: 'theme appearance dark light mode toggle switch night',
    run: async () => {
      const next = await deps.toggleTheme();
      toast.info(`Theme set to ${next}.`);
    },
  });

  [
    ['system', 'Theme: match system', 'follow the operating system light or dark setting'],
    ['light', 'Theme: light', 'always use the light theme'],
    ['dark', 'Theme: dark', 'always use the dark theme'],
  ].forEach(([value, title, hint]) =>
    add({
      id: `tools.theme.${value}`,
      title,
      hint,
      group: GROUPS.tools,
      keywords: 'theme appearance dark light mode system color',
      run: async () => {
        await deps.setTheme(value);
        toast.info(`Theme set to ${value === 'system' ? 'match system' : value}.`);
      },
    })
  );

  [
    ['window', 'Tools: open in floating windows', 'tools open over the page, several at once'],
    ['sidebar', 'Tools: dock in the sidebar', 'tools open inside the chat sidebar, one at a time'],
  ].forEach(([value, title, hint]) =>
    add({
      id: `tools.surface.${value}`,
      title,
      hint,
      group: GROUPS.tools,
      keywords: 'tools windows floating dock sidebar panel surface layout where open',
      run: async () => {
        await deps.setToolSurface(value);
        toast.info(value === 'window' ? 'Tools now open in floating windows.' : 'Tools now dock in the sidebar.');
      },
    })
  );

  if (deps.showWelcome) {
    add({
      id: 'help.tour',
      title: 'Quick tour',
      hint: 'What the palette, the page bar and the field menus do',
      group: GROUPS.tools,
      keywords: 'help tour tutorial getting started learn how to use what can this do welcome onboarding',
      run: () => deps.showWelcome(),
    });
  }

  add({
    id: 'tools.inline.toggle',
    title: 'Toggle on-page tools',
    hint: 'Page toolbar and the field, column and script menus',
    group: GROUPS.tools,
    keywords: 'inline page toolbar menus buttons labels columns on page tools hide show',
    run: async () => {
      const on = deps.inlineOn();
      await deps.setInline(!on);
      toast.info(on ? 'On-page tools hidden.' : 'On-page tools shown.');
    },
  });

  add({
    id: 'tools.fieldNameTip',
    title: 'Copy a field name or value',
    hint: 'Alt+click a label for its name, Alt+Shift+click for its value',
    group: GROUPS.tools,
    keywords: 'field name value copy label dictionary',
    run: () => toast.info('Alt+click a field label to copy its name. Alt+Shift+click copies its value.', { timeout: 8000 }),
  });

  add({
    id: 'tools.impersonate',
    title: 'Impersonate user…',
    hint: 'Type @username in the palette',
    group: GROUPS.tools,
    keywords: 'impersonate user switch test as',
    run: () => impersonate(),
  });

  add({
    id: 'tools.endImpersonation',
    title: 'End impersonation',
    hint: 'Go back to your own user',
    group: GROUPS.tools,
    keywords: 'stop end impersonation revert',
    url: '/logout_impersonate.do',
    raw: true,
  });

  add({
    id: 'tools.switchUpdateSet',
    title: 'Switch update set…',
    hint: 'Change the update set your changes are captured in',
    group: GROUPS.tools,
    keywords: 'update set switch current pick',
    run: async () => {
      const sets = await fetchSelectableUpdateSets();
      if (!sets.length) {
        toast.error('No in-progress update sets found.');
        return;
      }
      const names = sets.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
      const choice = window.prompt(`Switch to which update set?\n\n${names}`, '1');
      const index = Number(choice) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= sets.length) return;
      const token = await getCsrfToken();
      await setCurrentUpdateSet(sets[index].sys_id, token);
      toast.success(`Switched to "${sets[index].name}". Reload to pick it up.`, {
        action: { label: 'Reload', onClick: () => window.location.reload() },
        timeout: 10000,
      });
    },
  });

  // --- Instance ------------------------------------------------------------
  add({
    id: 'instance.cache',
    title: 'Flush instance cache',
    hint: '/cache.do',
    group: GROUPS.instance,
    keywords: 'cache flush clear refresh',
    url: '/cache.do',
    raw: true,
    newTab: true,
  });

  add({
    id: 'instance.stats',
    title: 'Node stats',
    hint: '/stats.do',
    group: GROUPS.instance,
    keywords: 'node stats build version instance',
    url: '/stats.do',
    raw: true,
    newTab: true,
  });

  add({
    id: 'instance.nodeInfo',
    title: 'Show node and build',
    hint: 'Which node and build you are on',
    group: GROUPS.instance,
    keywords: 'node build version release',
    run: async () => {
      const info = await getNodeInfo();
      toast.info(
        `Node ${info.node || 'unknown'} · build ${info.build || '?'} ${info.buildDate || ''}`,
        { timeout: 10000 }
      );
    },
  });

  add({
    id: 'instance.xmlstats',
    title: 'XML stats',
    hint: 'Transactions and semaphores on this node',
    group: GROUPS.instance,
    keywords: 'xmlstats semaphore transactions node',
    url: '/xmlstats.do',
    raw: true,
    newTab: true,
  });

  add({
    id: 'instance.threads',
    title: 'Thread info',
    hint: 'What is running now; spot stuck work',
    group: GROUPS.instance,
    keywords: 'threads stuck performance',
    url: '/threads.do',
    raw: true,
    newTab: true,
  });

  add({
    id: 'instance.copyInstanceUrl',
    title: 'Copy current page URL',
    hint: 'Copy the address of this page',
    group: GROUPS.instance,
    keywords: 'url copy share link page',
    run: async () => {
      await copyText(window.location.href);
      toast.success('Copied page URL');
    },
  });

  // --- Navigate ------------------------------------------------------------
  const navTargets = [
    ['System Properties', listUrl('sys_properties', 'ORDERBYname'), 'properties config glide'],
    ['System Log', listUrl('syslog', 'ORDERBYDESCsys_created_on'), 'log errors syslog'],
    ['Transaction Log', listUrl('syslog_transaction', 'ORDERBYDESCsys_created_on'), 'slow transactions performance'],
    ['Local Update Sets', listUrl('sys_update_set', 'ORDERBYDESCsys_updated_on'), 'update set deploy'],
    ['Retrieved Update Sets', listUrl('sys_remote_update_set', 'ORDERBYDESCsys_updated_on'), 'retrieved remote update set'],
    ['Scheduled Jobs', listUrl('sysauto_script', 'ORDERBYname'), 'scheduled job cron'],
    ['Schedule Items (sys_trigger)', listUrl('sys_trigger', 'ORDERBYnext_action'), 'trigger scheduled queue'],
    ['Email Log', listUrl('sys_email', 'ORDERBYDESCsys_created_on'), 'email notification outbound'],
    ['Events', listUrl('sysevent', 'ORDERBYDESCsys_created_on'), 'event queue'],
    ['Users', listUrl('sys_user', 'active=true^ORDERBYname'), 'user people account'],
    ['Groups', listUrl('sys_user_group', 'active=true^ORDERBYname'), 'group team assignment'],
    ['Roles', listUrl('sys_user_role', 'ORDERBYname'), 'role permission'],
    ['Applications', listUrl('sys_app', 'ORDERBYname'), 'application scope app'],
    ['Plugins', '/v_plugin_list.do', 'plugin install feature'],
    ['REST API Explorer', '/$restapi.do', 'rest api explorer'],
    ['Flow Designer', '/$flow-designer.do', 'flow designer automation'],
    ['Script Debugger', '/$scriptDebugger.do', 'debugger breakpoint step'],
  ];

  navTargets.forEach(([title, url, keywords]) => {
    add({
      id: `nav.${title.replace(/\W+/g, '').toLowerCase()}`,
      title,
      group: GROUPS.navigate,
      keywords,
      url,
    });
  });

  // Panels registered in src/sidebar/panelRegistry.js.
  PANELS.forEach((p) =>
    add({
      id: `panel.${p.name}`,
      title: p.title,
      hint: p.hint,
      group: GROUPS[p.group] || GROUPS.tools,
      keywords: [p.keywords, ...(p.slash || [])].filter(Boolean).join(' '),
      run: openPanel(() => sidebar.openPanel(p.name)),
    })
  );

  return commands;
}

/**
 * Query-driven results that cannot be precomputed: table lookups, sys_id
 * resolution and user impersonation. Each returns commands to merge into the
 * palette's result list.
 */
export function buildProviders(deps) {
  const { ctx = {}, toast, impersonateByQuery } = deps;

  return [
    // "@jsmith" -> impersonate
    async (query) => {
      if (!query.startsWith('@') || query.length < 2) return [];
      const term = query.slice(1);
      const users = await queryTable(
        'sys_user',
        `active=true^user_nameLIKE${term}^ORnameLIKE${term}^ORDERBYuser_name`,
        ['sys_id', 'user_name', 'name', 'email'],
        { limit: 8 }
      );
      return users.map((user) => ({
        id: `impersonate.${user.sys_id}`,
        title: `Impersonate ${user.name || user.user_name}`,
        hint: user.user_name + (user.email ? ` · ${user.email}` : ''),
        group: GROUPS.tools,
        score: 1000,
        run: () => impersonateByQuery(user.sys_id),
      }));
    },

    // A pasted sys_id -> open the record it belongs to
    async (query) => {
      const term = query.trim();
      if (!isSysId(term)) return [];
      const found = await findRecordBySysId(term, ctx.table);
      if (!found) {
        return [
          {
            id: 'sysid.notfound',
            title: 'sys_id not found in sys_metadata, task, sys_user or cmdb_ci',
            hint: term,
            group: GROUPS.navigate,
            score: 1000,
            run: () => toast.error('Could not resolve that sys_id.'),
          },
        ];
      }
      return [
        {
          id: `sysid.${found.sysId}`,
          title: `Open ${found.name || found.table}`,
          hint: `${found.table} · ${found.sysId}`,
          group: GROUPS.navigate,
          score: 1000,
          url: recordUrl(found.table, found.sysId),
        },
      ];
    },

    // Any other text -> table lookup (list, new record, configuration)
    async (query) => {
      const term = query.trim();
      if (term.length < 2 || term.startsWith('@') || term.startsWith('/') || isSysId(term)) return [];

      const tables = await searchTables(term, 6);
      const results = [];
      tables.forEach((t, index) => {
        results.push({
          id: `tablenav.list.${t.name}`,
          title: `${t.label} list`,
          hint: `${t.name}_list.do`,
          group: GROUPS.navigate,
          score: 900 - index * 10,
          url: listUrl(t.name),
        });
        results.push({
          id: `tablenav.new.${t.name}`,
          title: `New ${t.label}`,
          hint: `${t.name}.do?sys_id=-1`,
          group: GROUPS.navigate,
          score: 880 - index * 10,
          url: newRecordUrl(t.name),
        });
      });
      return results;
    },
  ];
}

/**
 * Slash commands typed directly into the palette are handed to the chat
 * sidebar, which already owns the command vocabulary.
 */
export function slashCommand(query, sidebar) {
  const term = query.trim();
  if (!term.startsWith('/')) return null;
  return {
    id: `slash.${term}`,
    title: `Run ${term}`,
    hint: 'Sends the command to the AI chat sidebar',
    group: GROUPS.ai,
    score: 1000,
    run: () => {
      sidebar.runCommand(term);
    },
  };
}
