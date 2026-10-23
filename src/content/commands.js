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
import { queryTable, fetchRecord } from './tableApi.js';
import { restRecordUrl, glideRecordSnippet, recordJson } from '../lib/recordSnippets.js';
import { parseRecordNumber, tablesForNumber } from '../lib/recordNumber.js';
import { addBookmark } from './stores.js';
import { currentPageHref, detectListInfo } from './context.js';
import { queueEditorAction } from './scriptEditor.js'; // used only by the script editor commands block below
import { makeQueryDynamic, applyListFilter } from './queryTools.js';
import { copyRows, copyIds, openSelected, copyListLink, copyListRest, listToRunner, compareTicked } from './listTools.js';
import { resolveTarget } from '../lib/urlTarget.js';
import { isScriptLabel } from '../lib/inline.js';
import { formDocuments } from './quickActions.js';
import { PANELS, panelForSlash } from '../sidebar/panelRegistry.js';
import { toggleXray, xrayServices } from './xray.js';
import { toggleHiddenFields, toggleHighlights, copyFormValues, duplicateAsNew, openRecordAs } from './formTools.js';

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
  const { ctx = {}, sidebar, toast, getCsrfToken, impersonate, openScriptEditor, startFileSync, stopFileSync, isFileSyncActive, openPalette } = deps;
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
      title: 'Edit the script',
      hint: 'Alt+Shift+E \u00b7 opens over the field and saves with the form; Full screen button inside',
      group: GROUPS.record,
      keywords: 'edit script editor code fullscreen monaco highlight replace',
      run: () => openScriptEditor(),
    });
  }

  // --- Script editor extras (outline, format): start of the block owned by the editor work ---
  if (hasScript && openScriptEditor) {
    add({
      id: 'tools.editor.outline',
      title: 'Go to a function in the script',
      hint: 'Opens the editor with the list of functions and methods · Ctrl+Shift+O inside the editor',
      group: GROUPS.record,
      keywords: 'outline symbol function method go to jump navigate find in script',
      run: () => {
        queueEditorAction('outline');
        openScriptEditor();
      },
    });
    add({
      id: 'tools.editor.format',
      title: 'Format the script',
      hint: 'Indentation, spacing and trailing blanks, and it refuses if the code itself would change · Shift+Alt+F inside the editor',
      group: GROUPS.record,
      keywords: 'format beautify prettify indent tidy clean code style',
      run: () => {
        queueEditorAction('format');
        openScriptEditor();
      },
    });
  }
  // --- end of the script editor extras block ---

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
      id: 'record.copyRest',
      title: 'Copy REST API URL',
      hint: `/api/now/table/${table}/${sysId.slice(0, 8)}…`,
      group: GROUPS.record,
      keywords: 'rest api table url postman curl endpoint',
      run: async () => {
        await copyText(restRecordUrl(window.location.origin, table, sysId));
        toast.success('Copied Table API URL');
      },
    });

    add({
      id: 'record.copyGlide',
      title: 'Copy GlideRecord that loads this record',
      hint: `new GlideRecord('${table}') + gr.get(sys_id)`,
      group: GROUPS.record,
      keywords: 'glide gliderecord script snippet get code background',
      run: async () => {
        await copyText(glideRecordSnippet(table, sysId));
        toast.success('Copied GlideRecord snippet');
      },
    });

    add({
      id: 'record.copyJson',
      title: 'Copy record as JSON',
      hint: 'Every field that has a value, as stored',
      group: GROUPS.record,
      keywords: 'json values fields data export clipboard payload',
      run: async () => {
        const json = recordJson(await fetchRecord(table, sysId));
        if (!json) {
          toast.info('Nothing to copy: this record has no values, or you cannot read it.');
          return;
        }
        await copyText(json);
        toast.success('Copied record JSON');
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

  // --- Form tools: read the open form, never change a value (src/content/formTools.js) -------------------------
  if (table && !ctx.isList) {
    const formRun = (fn) => async () => {
      try {
        await fn();
      } catch (err) {
        toast.error(err.message || String(err));
      }
    };

    add({
      id: 'form.hidden',
      title: 'Show hidden fields',
      hint: 'Fields a UI policy or script hid, marked "hidden". Run again to hide them',
      group: GROUPS.record,
      keywords: 'hidden fields unhide reveal show ui policy display none',
      run: formRun(() => toggleHiddenFields({ toast })),
    });

    add({
      id: 'form.highlight',
      title: 'Highlight required, read-only and changed fields',
      hint: 'Outline and tag them. Run again to clear',
      group: GROUPS.record,
      keywords: 'highlight mandatory required read only readonly changed unsaved outline',
      run: formRun(() => toggleHighlights({ toast })),
    });

    add({
      id: 'form.copyValues',
      title: 'Copy the form values as JSON',
      hint: 'What is on the form now, unsaved edits included. Secrets redacted',
      group: GROUPS.record,
      keywords: 'copy values json fields form data',
      run: formRun(() => copyFormValues('json', { toast })),
    });

    add({
      id: 'form.copyMarkdown',
      title: 'Copy the form values as a Markdown table',
      hint: 'Label, name, value and display value, ready for a ticket or a chat',
      group: GROUPS.record,
      keywords: 'copy values markdown table fields form',
      run: formRun(() => copyFormValues('markdown', { toast })),
    });

    add({
      id: 'form.copyScript',
      title: 'Copy the form values as a "set values" script',
      hint: 'GlideRecord with a setValue per field; the insert is commented out',
      group: GROUPS.record,
      keywords: 'copy values script gliderecord setvalue insert fields form test data',
      run: formRun(() => copyFormValues('script', { toast })),
    });

    add({
      id: 'record.similar',
      title: 'Find similar records',
      hint: '/similar · same table, matched on the short description, best match first',
      group: GROUPS.record,
      keywords: 'similar related duplicate same problem seen before other tickets like this',
      run: () => openPalette?.('/similar'),
    });

    add({
      id: 'form.duplicate',
      title: 'Duplicate as a new record',
      hint: 'A new record in a new tab, prefilled from this form. You press Submit',
      group: GROUPS.record,
      keywords: 'duplicate copy clone new record prefilled',
      run: formRun(() => duplicateAsNew({ toast })),
    });

    if (sysId) {
      add({
        id: 'record.openJson',
        title: 'Open this record as JSON',
        hint: 'The Table API response, in a new tab',
        group: GROUPS.record,
        keywords: 'json rest api table api response raw',
        run: formRun(() => openRecordAs('json')),
      });
    }
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
    id: 'tools.newUpdateSet',
    title: 'New update set…',
    hint: 'Create one and switch to it, so changes stop landing in Default',
    group: GROUPS.tools,
    keywords: 'update set create new switch default named story ticket',
    run: openPanel(() => sidebar.openPanel('mywork', { args: 'new' })),
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

  if (deps.showGuide) {
    add({
      id: 'help.guide',
      title: 'Developer guide',
      hint: 'Everything it can do, by the job you are doing. Click a line to try it',
      group: GROUPS.tools,
      keywords: 'help guide cheat sheet shortcuts what can this do features learn show me everything recipes how to',
      run: () => deps.showGuide(),
    });
  }

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

  // --- What's new card (src/content/whatsNew.js): start of the block owned by the release-notes work ---
  if (deps.showWhatsNew) {
    add({
      id: 'tools.whatsNew',
      title: "What's new",
      hint: 'The tools added in this version, by the job you are doing. Click one to open it',
      group: GROUPS.tools,
      keywords: "what's new whats new what is new changelog new features added updated version latest recently added tools",
      run: () => deps.showWhatsNew(),
    });
  }
  // --- end of the What's new block ---

  // A JSON blob, Base64, a token, a timestamp, a table name ... that is selected on the page: say what it is.
  // A name selected anywhere on the page (a method, a field, a property): one step to every place it is used.
  const picked = String(ctx.selection || '').trim();
  if (/^[A-Za-z_$][\w$.]{2,79}$/.test(picked)) {
    const word = picked.replace(/^.*\./, '');
    if (word.length >= 3) {
      add({
        id: 'search.selection',
        title: `Find where “${word}” is used`,
        hint: 'Every script field on the instance that mentions it',
        group: GROUPS.tools,
        keywords: 'find references usages where used selection selected name code search method function script include',
        run: () => { sidebar.openForTool(); sidebar.openSearchPanel(word); },
      });
    }
    if (table && !ctx.isList && /^[a-z][a-z0-9_]*$/.test(word)) {
      add({
        id: 'search.selectionField',
        title: `Where is the field “${word}” used on ${table}?`,
        hint: 'Scripts that set or read it, policies, ACLs, data policies',
        group: GROUPS.tools,
        keywords: 'field usage where used selection selected field name who sets who reads references',
        run: () => { sidebar.openForTool(); sidebar.openPanel?.('fieldusage', { args: `${table}.${word}` }); },
      });
    }
  }

  if (deps.decodeSelection && ctx.selection && deps.selectionKind?.(ctx.selection)) {
    add({
      id: 'tools.smartSelect',
      title: 'Decode the selection',
      hint: `The selected text looks like ${deps.selectionKind(ctx.selection)}`,
      group: GROUPS.tools,
      keywords: 'decode selection selected text pretty print format json xml base64 jwt token timestamp epoch date url decode what is this',
      run: () => deps.decodeSelection(ctx.selection),
    });
  }

  if (openPalette) {
    add({
      id: 'tools.new',
      title: 'New script from a template…',
      hint: '/new br, si, cs, uia, sj, fix, rest · opens a new form with a checked template',
      group: GROUPS.tools,
      keywords: 'new create start business rule script include client script ui action scheduled job fix script rest template boilerplate scaffold',
      run: () => openPalette('/new '),
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

  if (deps.toggleFieldNames) {
    add({
      id: 'tools.fieldNames.toggle',
      title: 'Show or hide database names',
      hint: deps.fieldNamesOn?.() ? 'Names are showing: hide them' : 'Field names under every label, column names in lists',
      group: GROUPS.tools,
      keywords: 'technical names field names column names database names labels show hide tn dictionary element',
      run: () => deps.toggleFieldNames(),
    });
  }

  add({
    id: 'savetrace.arm',
    title: 'Trace the next save',
    hint: 'Arm it, press Update or Submit, then collect what the save caused',
    group: GROUPS.analyze || GROUPS.tools,
    keywords: 'save trace arm debug on save what happened when i saved timeline',
    run: openPanel(() => sidebar.openPanel('savetrace', { args: 'arm' })),
  });

  add({
    id: 'tools.fieldNameTip',
    title: 'Copy a field name or value',
    hint: 'Alt+click a label for its name, Alt+Shift+click for its value, Ctrl+Alt+click for where it is used',
    group: GROUPS.tools,
    keywords: 'field name value copy label dictionary',
    run: () => toast.info('Alt+click a field label to copy its name. Alt+Shift+click copies its value. Ctrl+Alt+click shows where the field is used.', { timeout: 8000 }),
  });

  // Classic lists: take the rows off the page (the ticked ones, else every row on screen).
  if (ctx.isList && table) {
    const listGroup = GROUPS.table;
    add({ id: 'tools.list.tsv', title: 'Copy list rows for Excel', hint: 'Ticked rows, else every row on screen, tab-separated', group: listGroup, keywords: 'copy rows excel sheets spreadsheet tab separated paste table', run: () => copyRows({ toast, format: 'tsv' }) });
    add({ id: 'tools.list.markdown', title: 'Copy list rows as a Markdown table', hint: 'For a ticket, a wiki or a pull request', group: listGroup, keywords: 'copy rows markdown table wiki ticket', run: () => copyRows({ toast, format: 'markdown' }) });
    add({ id: 'tools.list.json', title: 'Copy list rows as JSON', hint: 'Keyed by database column name, with the sys_id', group: listGroup, keywords: 'copy rows json array objects test data', run: () => copyRows({ toast, format: 'json' }) });
    add({ id: 'tools.list.sysids', title: 'Copy sys_ids of the list rows', hint: 'Comma list; the page toolbar also has a JavaScript array', group: listGroup, keywords: 'copy sys ids comma list array selected rows', run: () => copyIds({ toast }) });
    add({ id: 'tools.list.openSelected', title: 'Open the ticked rows in new tabs', hint: 'Up to 8; asks first above 3', group: listGroup, keywords: 'open selected rows tabs records bulk review', run: () => openSelected({ toast }) });
    add({ id: 'tools.list.compare', title: 'Compare the two ticked rows', hint: 'Every field that differs between the two records', group: listGroup, keywords: 'compare two records ticked rows diff difference which fields differ side by side', run: () => compareTicked({ toast, sidebar }) });
    add({ id: 'tools.list.rest', title: 'Copy the Table API URL of this list', hint: 'Same filter, the columns on screen, first 100 rows', group: listGroup, keywords: 'copy rest api url table api list filter postman curl integration sysparm_query sysparm_fields', run: () => copyListRest({ toast }) });
    add({ id: 'tools.list.runner', title: 'Open this list as a script in the runner', hint: 'A GlideRecord loop for the filter; dry run is on', group: listGroup, keywords: 'background script glide record loop list filter run script bulk update fix script query runner', run: () => listToRunner({ toast, sidebar }) });
    add({ id: 'tools.list.link', title: 'Copy a link to this filtered list', hint: 'Opens the same list and filter for whoever you send it to', group: listGroup, keywords: 'copy link url filtered list share query', run: () => copyListLink({ toast }) });
  }

  // Static filter -> dynamic: relative dates and "me" instead of the literal values the filter builder saved.
  if (ctx.isList && table) {
    const dynamicFilter = async (mode) => {
      const info = await detectListInfo().catch(() => null);
      if (!info?.query) return toast.info('This list has no filter to make dynamic.');
      const result = await makeQueryDynamic(info.query);
      if (!result.changes.length) return toast.info('Nothing in this filter can be made dynamic: it has no day-boundary dates or sys_ids of yours.', { timeout: 8000 });
      if (mode === 'copy') {
        await copyText(result.query);
        return toast.success(`Copied the dynamic query (${result.changes.length} change${result.changes.length === 1 ? '' : 's'})`);
      }
      return applyListFilter(info.table, result.query);
    };
    add({ id: 'tools.list.dynamic', title: 'Make the list filter dynamic', hint: 'Dates become gs.daysAgoStart(7), your sys_id becomes gs.getUserID()', group: GROUPS.table, keywords: 'dynamic filter encoded query relative dates last 7 days today me current user javascript gs static', run: () => dynamicFilter('apply').catch((err) => toast.error(err.message || String(err))) });
    add({ id: 'tools.list.dynamicCopy', title: 'Copy the list filter as a dynamic query', hint: 'For a report, a UI action, a GlideRecord or a saved filter', group: GROUPS.table, keywords: 'copy dynamic encoded query relative dates javascript gs filter', run: () => dynamicFilter('copy').catch((err) => toast.error(err.message || String(err))) });
  }

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
    run: () => deps.endImpersonation?.(),
  });

  add({
    id: 'tools.switchUpdateSet',
    title: 'Switch update set…',
    hint: 'Change the update set your changes are captured in',
    group: GROUPS.tools,
    keywords: 'update set switch current pick',
    // My work has the picker (and shows what each set holds); a browser prompt() with a numbered list blocked the page.
    run: openPanel(() => sidebar.openPanel('mywork', { args: 'switch' })),
  });

  add({
    id: 'testdata.cleanup',
    title: 'Clean up test data',
    hint: 'Remove the sample records NowBuddy created here (only those, from its own list)',
    group: GROUPS.tools,
    keywords: 'clean up cleanup remove delete test data sample records dummy fake users created by nowbuddy',
    run: openPanel(() => sidebar.openPanel('testdata', { args: 'cleanup' })),
  });

  // --- Instance ------------------------------------------------------------
  if (openPalette) {
    add({
      id: 'instance.switch',
      title: 'Switch instance',
      hint: '/i · this page on dev, test or prod',
      group: GROUPS.instance,
      keywords: 'switch instance environment go to other dev test prod same page /i',
      run: () => openPalette('/i '),
    });
  }

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

  // The Test panel (src/sidebar/TestKitPanel.jsx) on a given tab, offered where it applies.
  const testTab = (args) => openPanel(() => sidebar.openPanel('testkit', { args }));
  const SCRIPT_TABLES = ['sys_script', 'sys_ui_action', 'sys_script_include', 'sys_script_fix', 'sysauto_script'];
  if (table && sysId && SCRIPT_TABLES.includes(table)) {
    add({ id: 'test.run', title: 'Run this script against a record', hint: 'Dry run with current and previous bound to a record you pick; shows the writes it held back', group: GROUPS.tools, keywords: 'test run script against record dry run current previous pretend changed business rule', run: testTab('run') });
  }
  if (table === 'sys_script_include' && sysId) {
    add({ id: 'test.unit', title: 'Write a unit test for this script include', hint: 'Generates a runnable test with assertions, runs it as a dry run, saves it for later', group: GROUPS.tools, keywords: 'unit test script include assert methods generate test', run: testTab('unit') });
  }
  if (table) {
    add({ id: 'test.atf', title: 'Find ATF tests for this', hint: 'Automated tests that mention this table or script include, and how they last went', group: GROUPS.tools, keywords: 'atf automated test framework coverage suite tests results', run: testTab('atf') });
    add({ id: 'test.access', title: 'Who can access this?', hint: 'Read, write, create and delete for up to five users side by side', group: GROUPS.tools, keywords: 'access matrix acl users roles side by side who can read write delete', run: testTab('access') });
  }
  if (table && (sysId || ctx.isList)) {
    add({ id: 'test.snapshot', title: ctx.isList ? 'Snapshot this list' : 'Snapshot this record', hint: 'Save its state now, do something, then compare', group: GROUPS.tools, keywords: 'snapshot save state before after compare baseline record list rows', run: testTab('snapshot') });
    add({ id: 'test.compare', title: 'Compare with snapshot', hint: 'What changed since you took the snapshot, field by field', group: GROUPS.tools, keywords: 'compare snapshot diff changed since before after', run: testTab('snapshot') });
  }

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

    // INC0010001, CHG0030002, STRY0012345 -> open that record. Task numbers cover every task table in one lookup.
    async (query) => {
      const number = parseRecordNumber(query);
      if (!number) return [];
      const results = [];
      for (const table of tablesForNumber(number)) {
        // eslint-disable-next-line no-await-in-loop -- the second table is only asked when the first finds nothing.
        const rows = await queryTable(table, `number=${number}`, ['sys_id', 'number', 'short_description', 'sys_class_name'], { limit: 3 }).catch(() => []);
        rows.forEach((row) => {
          const rowTable = table === 'task' ? row.sys_class_name || 'task' : table;
          results.push({
            id: `number.${row.sys_id}`,
            title: `Open ${row.number || number}`,
            hint: [row.short_description, labelForTable(rowTable)].filter(Boolean).join(' · '),
            group: GROUPS.navigate,
            score: 1000,
            url: recordUrl(rowTable, row.sys_id),
          });
        });
        if (results.length) break;
      }
      return results;
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
  // A command that belongs to a tool panel says so and ranks first: Enter opens that tool.
  const panel = panelForSlash(term.split(/\s+/)[0].toLowerCase());
  return {
    id: `slash.${term}`,
    title: panel ? `Open ${panel.title}` : `Run ${term}`,
    hint: panel ? term : 'Sends the command to the AI chat sidebar',
    group: panel ? GROUPS[panel.group] || GROUPS.ai : GROUPS.ai,
    score: panel ? 1090 : 1000,
    run: () => {
      sidebar.runCommand(term);
    },
  };
}
