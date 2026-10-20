import React, { forwardRef, useImperativeHandle, useState, useEffect, useRef } from 'react';
import { redactSecrets } from '../providers/redact.js';
import { useSpeechInput } from './useSpeechInput.js';
import { useTheme } from './useTheme.js';
import { trusted, isTrustedEvent } from './trusted.js';
import { lintScript, formatLintFindings } from '../lib/lint.js';
import { analyzeScriptRisk, formatRiskSummary } from '../lib/scriptSafety.js';
import { downloadText, suggestFilename } from '../lib/report.js';
import { extractScriptOutput } from '../lib/logTail.js';
import { loadHistory, recordRun, clearHistory } from '../lib/scriptHistory.js';
import { buildLogTriagePrompt, buildTracePrompt } from '../content/logs.js';
import { buildUpdateSetPrompt } from '../content/updateSets.js';
import { buildAuditPrompt, formatAuditFindings } from '../content/securityAudit.js';
import { formatDependencyGraph } from '../content/dependencies.js';
import { formatFormDiff } from '../content/formDiff.js';
import ComparePanel from './ComparePanel.jsx';
import SearchPanel from './SearchPanel.jsx';
import UpdateSetPanel from './UpdateSetPanel.jsx';
import RestPanel from './RestPanel.jsx';
import PromptLibraryPanel from './PromptLibraryPanel.jsx';
import QueryPanel from './QueryPanel.jsx';
import LogTailPanel from './LogTailPanel.jsx';
import ApplyPanel from './ApplyPanel.jsx';
import RemoteRecordPanel from './RemoteRecordPanel.jsx';
import VersionPanel from './VersionPanel.jsx';
import FieldInspectorPanel from './FieldInspectorPanel.jsx';
import AtfPanel from './AtfPanel.jsx';
import ScopeExportPanel from './ScopeExportPanel.jsx';
import AutomationPanel from './AutomationPanel.jsx';
import ApiExplorerPanel from './ApiExplorerPanel.jsx';
import TestBenchPanel from './TestBenchPanel.jsx';
import { PANELS, panelByName, panelForSlash, panelHelpLines } from './panelRegistry.js';
import AgentRun from './AgentRun.jsx';
import Icon from './Icon.jsx';
import ToolWindow from './ToolWindow.jsx';
import { defaultWindowRect, upsertWindow } from '../lib/toolWindow.js';
import MessageBody, { HelpBody } from './MessageBody.jsx';
import { runAgent } from '../lib/agent/agentLoop.js';
import { TOOL_SCHEMAS } from '../lib/agent/toolSchemas.js';
import { approvalMode, isGuardedEnv, AUTONOMY_LEVELS, DEFAULT_AUTONOMY } from '../lib/agent/policy.js';
import { resolveGuardrails } from '../lib/agent/guardrails.js';
import { buildSystemPrompt } from '../lib/agent/systemPrompt.js';
import { newRun, reduceRun } from '../lib/agent/runState.js';
import { selectSkills } from '../lib/skills/index.js';
import { kindForTable } from '../lib/verify.js';
import { getSettings, saveSettings, onSettingsChanged } from '../content/storage.js';
import { getInstanceInfo } from '../content/quickActions.js';
import { askConfirm } from '../content/confirmDialog.js';
import { USAGE_KEY, CAPS_KEY, usageChip, historyExpired, normalizeHistoryDays, DEFAULT_HISTORY_DAYS } from '../lib/aiUsage.js';
import { runWritesAsk, clearHistoryAsk } from '../lib/confirmCopy.js';

// One transcript per instance: a consultant's client A chat must never load (or reach the model) on client B.
const HISTORY_KEY = `mysnowbuddy_chat_history:${window.location.hostname}`;
const HISTORY_SAVED_KEY = `${HISTORY_KEY}:savedAt`;
const WIDTH_KEY = 'mysnowbuddy_sidebar_width';
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;

const TOOLS = [
  { command: '/verify', icon: 'shield', title: 'Verify script', hint: 'Syntax, API catalog and lint' },
  { command: '/testclient', icon: 'flask', title: 'Test bench', hint: 'Simulate a client script' },
  { command: '/api', icon: 'braces', title: 'API explorer', hint: 'Verified client and server APIs' },
  { command: '/search', icon: 'search', title: 'Code search', hint: 'Find usages across the instance' },
  { command: '/logs', icon: 'log', title: 'Triage errors', hint: 'Recent errors, explained' },
  { command: '/script', icon: 'play', title: 'Script runner', hint: 'Background scripts, dry run first' },
  { command: '/updateset', icon: 'layers', title: 'Update sets', hint: 'Collisions and coverage' },
  { command: '/formdiff', icon: 'edit', title: 'Unsaved changes', hint: 'Diff the form against the record' },
  { command: '/list', icon: 'table', title: 'List filter', hint: 'Explain, count, export a query' },
  { command: '/tail', icon: 'clock', title: 'Live log', hint: 'Follow the system log' },
  { command: '/rest', icon: 'bolt', title: 'REST builder', hint: 'Try Table API requests' },
  { command: '/prompts', icon: 'book', title: 'Prompts', hint: 'Saved and built-in prompts' },
  ...PANELS.filter((p) => p.launcher && p.slash?.length).map((p) => ({ command: p.slash[0], icon: p.icon, title: p.title, hint: p.launcherHint || p.hint })),
];

const SUGGESTIONS = {
  'client-script': [
    'What client-side logic already runs on this table?',
    'Make a field mandatory when another field has a certain value',
    'Fill a field from the selected reference with GlideAjax',
    'Review and test the client script on this form',
  ],
  'server-script': [
    'Review the script on this form',
    'Write a business rule that stops duplicate records',
    'Why are errors spiking? Check the logs',
    'Find every script that calls a given Script Include',
  ],
};

const SLASH_HELP = [
  'Analysis (no AI tokens used)',
  '  /lint                  deterministic review of the script on this form',
  '  /formdiff              show unsaved form changes vs the saved record',
  '  /deps <ScriptInclude>  callers and callees as a dependency graph',
  '  /verify                syntax + API catalog + lint + structure check of the script on this form',
  '  /skills                which skill pack is active, and the agent tools',
  '  /changes               what the agent changed on this instance (undo with /undo)',
  '  /undo                  undo the last change the agent made',
  '',
  'AI-assisted',
  '  /review                lint + AI review of the script on this form',
  '  /explain <text>        explain an error, log line or field',
  '  /generate <request>    generate a background script',
  '  /conflictcheck         find conflicts with existing configuration',
  '  /dedupe                find likely duplicate CIs in the CMDB',
  '  /logs [text]           triage recent instance errors',
  '  /trace <stack trace>   resolve a stack trace to the failing script',
  '  /atf                   generate an ATF test outline for this record',
  '  /document              generate technical documentation for this record',
  '  /audit                 security and configuration audit',
  '',
  'Agent',
  '  (just type)            the agent reads the instance, writes, verifies and tests, and asks before changing anything',
  '  /chat <text>           plain chat, no tools',
  '  /agent on|off          turn agent mode on or off',
  '  /model                 show the model in use and open settings',
  '',
  'Panels',
  '  /search                global code search',
  '  /list                  list filter: explain, GlideRecord code, count, export',
  '  /tail                  live system log',
  '  /versions              version history and field diff for this record',
  '  /fields                field inspector for this table',
  '  /remote                compare this record with another instance',
  '  /tests                 run ATF suites and see results',
  '  /scope                 export a scope as a ZIP of scripts',
  '  /api [text]            verified API explorer (client + server)',
  '  /testclient            simulate a client script against a fake form',
  '  /updateset             update set collisions and coverage',
  '  /rest                  REST request builder',
  '  /automate              navigate and click through screens',
  '  /compare               compare two instances',
  '  /script                background script runner with history',
  '  /prompts               prompt library: saved and built-in prompts',
  '  /snippets              code snippet library',
  ...panelHelpLines(),
  '',
  '  /clear                 clear conversation history',
].join('\n');

// Window titles for the panels that Sidebar.jsx renders itself; registered panels use their registry title.
const WINDOW_TITLES = {
  compare: 'Compare instances',
  search: 'Code search',
  updateset: 'Update sets',
  rest: 'REST builder',
  prompts: 'Prompt library',
  query: 'List filter tools',
  logtail: 'Live log',
  apply: 'Apply to the form',
  remote: 'Other instance',
  versions: 'Version history',
  fields: 'Table explorer',
  atf: 'ATF',
  scope: 'Scope export',
  automation: 'Automation',
  api: 'API explorer',
  testbench: 'Client script test bench',
  bgscript: 'Script runner',
};
const windowTitle = (name) => WINDOW_TITLES[name] || panelByName(name)?.title || name;

// Tools that show wide tables, diffs or logs open larger.
const WIDE_TOOLS = new Set(['compare', 'search', 'query', 'logtail', 'rest', 'versions', 'fields', 'remote', 'updateset', 'xray', 'health', 'access', 'impact', 'hotspots', 'atf', 'testbench', 'bgscript']);
const windowSize = (name) => (WIDE_TOOLS.has(name) ? { w: 560, h: 620 } : { w: 480, h: 580 });

const Sidebar = forwardRef(function Sidebar({ getContext, instance = null, onOpenPalette = null }, ref) {
  const [theme, changeTheme] = useTheme();
  const [themeMenu, setThemeMenu] = useState(false);
  const guardRef = useRef(resolveGuardrails({})); // the user's agent safety settings (Options > Agent > Agent safety)
  const themeButtonRef = useRef(null);
  const themeMenuRef = useRef(null);
  useEffect(() => {
    if (!themeMenu) return undefined;
    const close = () => setThemeMenu(false);
    const timer = setTimeout(() => document.addEventListener('click', close), 0);
    // Keyboard: the menu takes focus on the chosen item, as a menu button should.
    (themeMenuRef.current?.querySelector('[aria-checked="true"]') || themeMenuRef.current?.querySelector('button'))?.focus();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', close);
    };
  }, [themeMenu]);

  // Arrows, Home and End move through the theme menu; Escape and Tab close it (Escape returns focus to its button).
  function onThemeMenuKeyDown(event) {
    const items = [...themeMenuRef.current.querySelectorAll('button')];
    const at = items.indexOf(event.target);
    const target = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (target !== undefined) {
      event.preventDefault();
      items[(target + items.length) % items.length].focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setThemeMenu(false);
      themeButtonRef.current?.focus();
    } else if (event.key === 'Tab') {
      setThemeMenu(false);
    }
  }
  const [visible, setVisible] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [context, setContext] = useState(null);
  const [notice, setNotice] = useState(null);
  const [showBgPanel, setShowBgPanel] = useState(false);
  // One panel at a time: { name, ...params } or null.
  const [panel, setPanel] = useState(null);
  // Where tools open: floating windows over the page (default) or docked in the sidebar. Windows are
  // { wid, name, z, ...params }; the script runner is the one tool with its own state, so it has no entry.
  const [toolSurface, setToolSurface] = useState('window');
  const [windows, setWindows] = useState([]);
  const [bgZ, setBgZ] = useState(0);
  const zRef = useRef(10);
  const widRef = useRef(0);
  const [bgScript, setBgScript] = useState('');
  const [bgResult, setBgResult] = useState(null);
  const [bgOutput, setBgOutput] = useState('');
  const [bgHistory, setBgHistory] = useState([]);
  const [bgDryRun, setBgDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState(null);
  const [width, setWidth] = useState(400);
  const messagesRef = useRef(null);
  const textareaRef = useRef(null);
  const runnerRef = useRef(null);
  const servicesRef = useRef({});
  const historyLoaded = useRef(false);
  const baseInputRef = useRef('');
  const handleSendRef = useRef(null);
  const [agentEnabled, setAgentEnabled] = useState(true);
  const [autonomy, setAutonomy] = useState(DEFAULT_AUTONOMY);
  const [providerInfo, setProviderInfo] = useState(null);
  const [usage, setUsage] = useState({ log: [], caps: {} });
  const historyDays = useRef(DEFAULT_HISTORY_DAYS);
  const abortRef = useRef(null);
  const approvalsRef = useRef(new Map());

  const scriptRisk = analyzeScriptRisk(bgScript);

  const speech = useSpeechInput({
    onTranscript: ({ finalText, interimText }) => {
      if (finalText) {
        baseInputRef.current = `${baseInputRef.current}${baseInputRef.current ? ' ' : ''}${finalText.trim()}`;
        setInput(baseInputRef.current);
      } else {
        setInput(`${baseInputRef.current}${baseInputRef.current ? ' ' : ''}${interimText}`);
      }
    },
    onError: (message) => {
      setNotice(message);
      setTimeout(() => setNotice(null), 5000);
    },
  });

  function handleMicToggle() {
    if (!speech.listening) {
      baseInputRef.current = input;
    }
    speech.toggle();
  }

  // Chat history stays for the number of days chosen in Options (0 = nothing survives a page load).
  useEffect(() => {
    chrome.storage.local.get([HISTORY_KEY, HISTORY_SAVED_KEY, 'mysnowbuddy_settings']).then((res) => {
      historyDays.current = normalizeHistoryDays(res.mysnowbuddy_settings?.chatHistoryDays);
      if (res[HISTORY_KEY] && historyExpired(res[HISTORY_SAVED_KEY], historyDays.current)) {
        chrome.storage.local.remove([HISTORY_KEY, HISTORY_SAVED_KEY]).catch(() => {});
      } else if (res[HISTORY_KEY]) {
        setMessages(
          res[HISTORY_KEY].map((m) =>
            m.run?.status === 'running'
              ? { ...m, run: { ...m.run, status: 'aborted', thinking: false, steps: m.run.steps.map((st) => (st.status === 'running' || st.status === 'awaiting' ? { ...st, status: 'declined' } : st)) } }
              : m
          )
        );
      }
      historyLoaded.current = true;
    });
  }, []);

  useEffect(() => {
    if (!historyLoaded.current) return;
    if (historyDays.current === 0) {
      chrome.storage.local.remove([HISTORY_KEY, HISTORY_SAVED_KEY]).catch(() => {});
      return;
    }
    chrome.storage.local.set({ [HISTORY_KEY]: messages, [HISTORY_SAVED_KEY]: Date.now() }).catch(() => {});
  }, [messages]);

  // Today's AI calls and cost, from the usage log the service worker keeps (src/providers/budget.js).
  useEffect(() => {
    const read = () =>
      chrome.storage.local
        .get([USAGE_KEY, CAPS_KEY])
        .then((res) => setUsage({ log: Array.isArray(res[USAGE_KEY]) ? res[USAGE_KEY] : [], caps: res[CAPS_KEY] || {} }))
        .catch(() => {});
    read();
    const onChange = (changes, area) => {
      if (area === 'local' && (changes[USAGE_KEY] || changes[CAPS_KEY])) read();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  useEffect(() => {
    const apply = (settings) => {
      setAgentEnabled(settings.agentEnabled !== false);
      setToolSurface(settings.toolSurface === 'sidebar' ? 'sidebar' : 'window');
      setAutonomy(AUTONOMY_LEVELS.some((l) => l.id === settings.agentAutonomy) ? settings.agentAutonomy : DEFAULT_AUTONOMY);
      guardRef.current = resolveGuardrails(settings);
    };
    getSettings().then(apply);
    const off = onSettingsChanged(apply);
    const refreshProvider = () =>
      chrome.runtime
        .sendMessage({ type: 'GET_PROVIDER_INFO' })
        .then((info) => info?.ok && setProviderInfo(info))
        .catch(() => {});
    refreshProvider();
    const onStorage = (changes, area) => {
      if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('mysnowbuddy_') && /key|provider|models/.test(k))) refreshProvider();
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      off();
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, []);

  useEffect(() => {
    chrome.storage.local.get(WIDTH_KEY).then((res) => {
      const stored = Number(res[WIDTH_KEY]);
      if (stored >= MIN_WIDTH && stored <= MAX_WIDTH) setWidth(stored);
    });
  }, []);

  // Stick to the bottom as the conversation grows.
  useEffect(() => {
    const node = messagesRef.current;
    // The empty state is read from the top; only a live conversation sticks to the bottom.
    if (node) node.scrollTop = messages.length ? node.scrollHeight : 0;
  }, [messages, statusText, visible]);

  // Auto-grow the composer up to the CSS max-height.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [input, visible]);

  // Keyboard: the separator is focusable; Left widens the sidebar (it grows leftwards), Right narrows it.
  function onResizerKeyDown(event) {
    const step = event.shiftKey ? 64 : 16;
    const delta = { ArrowLeft: step, ArrowRight: -step }[event.key];
    const next = delta !== undefined ? width + delta : { Home: MIN_WIDTH, End: MAX_WIDTH }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next));
    setWidth(clamped);
    chrome.storage.local.set({ [WIDTH_KEY]: clamped });
  }

  function startResize(event) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;

    function onMove(e) {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - e.clientX)));
      setWidth(next);
    }
    function onUp(e) {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - e.clientX)));
      chrome.storage.local.set({ [WIDTH_KEY]: next });
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // Closes the docked panel. Floating windows belong to the page, so a chat action leaves them open.
  function closeAllPanels() {
    setPanel(null);
    if (toolSurface !== 'window') setShowBgPanel(false);
  }

  function raise() {
    zRef.current += 1;
    return zRef.current;
  }

  function openPanel(name, params = {}) {
    if (toolSurface === 'window') {
      const entry = { wid: ++widRef.current, name, ...params };
      const z = raise();
      setWindows((prev) => upsertWindow(prev, entry, z));
      return;
    }
    setShowBgPanel(false);
    setPanel({ name, ...params });
  }

  function closeWindow(wid) {
    setWindows((prev) => prev.filter((w) => w.wid !== wid));
  }

  function focusWindow(wid) {
    if (windows.find((w) => w.wid === wid)?.z === zRef.current) return;
    const z = raise();
    setWindows((prev) => prev.map((w) => (w.wid === wid ? { ...w, z } : w)));
  }

  // Dock a window into the sidebar, or pop the docked panel out into a window.
  function dockWindow(entry) {
    const { wid, z, ...rest } = entry;
    closeWindow(wid);
    setShowBgPanel(false);
    setPanel(rest);
    setVisible(true);
  }

  function popOutPanel() {
    if (!panel) return;
    const entry = { wid: ++widRef.current, ...panel };
    const z = raise();
    setWindows((prev) => upsertWindow(prev, entry, z));
    setPanel(null);
  }

  // The script runner is a window of its own while tools float.
  useEffect(() => {
    if (showBgPanel) setBgZ(raise());
  }, [showBgPanel]);

  // Panels that read the open record get a snapshot of the page at open time.
  function openWithContext(name, params = {}) {
    const ctx = getContext();
    setContext(ctx);
    openPanel(name, { context: ctx, ...params });
  }

  // Panels from panelRegistry.js; their extra params arrive as `params`.
  function openRegisteredPanel(name, params = {}) {
    const entry = panelByName(name);
    if (!entry) return false;
    if (entry.withContext) openWithContext(name, { params });
    else openPanel(name, { params });
    return true;
  }

  function loadScriptIntoRunner(text) {
    setBgScript(text);
    setBgDryRun(true);
    setBgOutput('');
    setBgResult('Script loaded. Dry run is ON by default - review it before running.');
    setPanel(null);
    setShowBgPanel(true);
  }

  useEffect(() => {
    if (showBgPanel) loadHistory().then(setBgHistory).catch(() => {});
  }, [showBgPanel]);

  // The sidebar stays open while the user navigates (Next Experience never reloads), so the context chips
  // (table, sys_id, script) follow the page instead of showing whatever was open when the sidebar opened.
  useEffect(() => {
    if (!visible) return undefined;
    const key = (c) => (c ? `${c.table}|${c.sysId}|${c.isList}|${c.scriptFieldLabel}|${(c.scriptBody || '').length}` : '');
    const timer = setInterval(() => {
      try {
        const next = getContext();
        setContext((prev) => (key(prev) === key(next) ? prev : next));
      } catch {
        // The page is mid-navigation; try again on the next tick.
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [visible, getContext]);

  useImperativeHandle(ref, () => ({
    open: () => {
      setContext(getContext());
      setVisible(true);
    },
    close: () => setVisible(false),
    toggle: () =>
      setVisible((v) => {
        const next = !v;
        if (next) setContext(getContext());
        return next;
      }),
    notify: (text) => {
      setNotice(text);
      setTimeout(() => setNotice(null), 4000);
    },
    openBackgroundScriptPanel: () => setShowBgPanel(true),
    openComparePanel: () => openPanel('compare'),
    openSearchPanel: (query = '') => openPanel('search', { query }),
    openUpdateSetPanel: () => openPanel('updateset'),
    openRestPanel: () => openPanel('rest'),
    openPromptPanel: (kind = 'prompts') => openWithContext('prompts', { kind }),
    openQueryPanel: () => openPanel('query'),
    openLogTailPanel: () => openPanel('logtail'),
    openVersionPanel: () => openWithContext('versions'),
    openFieldPanel: () => openWithContext('fields'),
    openRemotePanel: () => openWithContext('remote'),
    openAtfPanel: () => openPanel('atf'),
    openScopePanel: () => openPanel('scope'),
    openAutomationPanel: () => openPanel('automation'),
    openApiPanel: (query = '') => openPanel('api', { query }),
    openTestPanel: () => openPanel('testbench'),
    openApplyPanel: (code) => openWithContext('apply', { code }),
    openPanel: (name, params = {}) => {
      if (toolSurface !== 'window') setVisible(true);
      return openRegisteredPanel(name, params);
    },
    // Callers that are about to open a tool: the sidebar only needs to appear when tools dock there.
    openForTool: () => {
      if (toolSurface !== 'window') {
        setContext(getContext());
        setVisible(true);
      }
    },
    sendPrompt: (label, prompt) => {
      setContext(getContext());
      setVisible(true);
      askAi(label, prompt);
    },
    runCommand: (command) => {
      setContext(getContext());
      // A command that only opens a tool must not pop the chat open when tools float.
      const word = String(command).trim().split(/\s+/)[0];
      const opensTool = word === '/api' || Boolean(PANEL_COMMANDS[word]) || Boolean(panelForSlash(word));
      if (!(toolSurface === 'window' && opensTool)) setVisible(true);
      handleSendRef.current?.(command);
    },
    registerBackgroundScriptRunner: (fn) => {
      runnerRef.current = fn;
    },
    registerServices: (services) => {
      servicesRef.current = services || {};
    },
  }));

  function requireService(name, label) {
    const fn = servicesRef.current[name];
    if (!fn) throw new Error(`${label} is unavailable on this page.`);
    return fn;
  }

  function pushLocal(userText, assistantText, extra = {}) {
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: userText, displayContent: userText },
      { role: 'assistant', content: assistantText, displayContent: assistantText, local: true, ...extra },
    ]);
  }

  // ---------------------------------------------------------------------
  // Commands answered WITHOUT calling the AI provider: instant, free and
  // deterministic.
  // ---------------------------------------------------------------------
  async function runLocalCommand(rawInput, ctx) {
    if (rawInput.startsWith('/lint')) {
      setStatusText('Reading the record...');
      const lintCurrent = requireService('lintCurrent', 'Lint');
      const { findings, script } = await lintCurrent(ctx);
      if (!script) {
        return {
          text: 'No script field was detected on this page. Open a Business Rule, Script Include, Client Script or ACL.',
        };
      }
      return { text: formatLintFindings(findings) };
    }

    if (rawInput.startsWith('/formdiff')) {
      setStatusText('Comparing the form against the saved record...');
      const getFormDiff = requireService('getFormDiff', 'Form diff');
      return { text: formatFormDiff(await getFormDiff()) };
    }

    if (rawInput.startsWith('/deps')) {
      const name = rawInput.replace('/deps', '').trim();
      if (!name) return { text: 'Usage: /deps <ScriptIncludeName>' };

      setStatusText(`Building the dependency graph for ${name}...`);
      const buildDependencies = requireService('buildDependencies', 'Dependency graph');
      return { text: formatDependencyGraph(await buildDependencies(name)) };
    }

    if (rawInput.startsWith('/verify')) {
      setStatusText('Reading the record...');
      const read = requireService('readFormScript', 'Verify');
      const found = await read();
      if (!found?.body) return { text: 'No script was found on this page. Open a Business Rule, Script Include, Client Script, ACL or UI Policy.' };
      const kind = kindForTable(ctx?.table);
      if (!kind) return { text: `/verify understands script records (Business Rule, Script Include, Client Script, ACL, UI Policy, ...). ${ctx?.table || 'This page'} is not one of them.` };
      const record = await requireService('fetchArtifactRecord')(ctx).catch(() => null);
      setStatusText('Verifying...');
      const res = await requireService('agentExecute')('verify_script', {
        code: found.body,
        kind,
        when: record?.when || undefined,
        clientType: record?.type || undefined,
        table: record?.collection || record?.table || undefined,
      });
      const lines = [res.summary + (res.fieldNamesChecked ? '' : ' (field names not checked: no table schema available)')];
      res.findings.forEach((f) => {
        lines.push(`[${f.severity.toUpperCase()}] line ${f.line} - ${f.message}`, `    Fix: ${f.fix}`);
      });
      return { text: lines.join('\n') };
    }

    if (rawInput.startsWith('/skills')) {
      const { primary, secondary, reason } = selectSkills(ctx || {});
      return {
        text: [
          `Active skill: ${primary.title} (${reason}).`,
          primary.summary,
          '',
          'Tools it uses: ' + primary.tools.join(', '),
          '',
          `Also available: ${secondary.title}. ${secondary.digest}`,
          '',
          'The agent loads the full guide itself. External agents can read it as an MCP resource.',
        ].join('\n'),
      };
    }

    if (rawInput.startsWith('/changes')) {
      const list = await requireService('auditList')();
      if (!list.length) return { text: 'The agent has not changed anything on this instance yet.' };
      return {
        text: list
          .slice(0, 15)
          .map((e) => `${new Date(e.ts).toLocaleString()}  ${e.ok ? '' : '[denied] '}${e.summary || e.tool}${e.undone ? '  (undone)' : e.undo ? '  (can undo)' : ''}`)
          .join('\n'),
      };
    }

    if (rawInput.startsWith('/undo')) {
      // Same approval card (and typed name on a guarded instance) as an agent's undo, for exactly the change shown.
      const result = await requireService('agentUndo')();
      return { text: result.undone ? `Undone: ${result.undone}` : 'Undo cancelled. Nothing was changed.' };
    }

    if (rawInput.startsWith('/model')) {
      const info = providerInfo;
      setTimeout(() => chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }), 0);
      return { text: info ? `Using ${info.label} - ${info.model}${info.hasKey ? '' : ' (no API key yet)'}. Opening settings...` : 'Opening settings...' };
    }

    if (rawInput.startsWith('/agent')) {
      const arg = rawInput.replace('/agent', '').trim().toLowerCase();
      if (arg !== 'on' && arg !== 'off') return { text: `Agent mode is ${agentEnabled ? 'on' : 'off'}. Use /agent on or /agent off.` };
      await saveSettings({ agentEnabled: arg === 'on' });
      return { text: arg === 'on' ? 'Agent mode on. Plain messages now use tools.' : 'Agent mode off. Plain messages go to the model without tools.' };
    }

    return null;
  }

  function buildPromptForSlashCommand(rawInput, ctx) {
    if (rawInput.startsWith('/explain')) {
      const rest = rawInput.replace('/explain', '').trim();
      const target = rest || ctx?.scriptBody || '(nothing selected — paste the error/log text after /explain)';
      return `Explain the following in plain English for a ServiceNow admin:\n\n${redactSecrets(target)}`;
    }
    if (rawInput.startsWith('/generate')) {
      const description = rawInput.replace('/generate', '').trim();
      return (
        'Write a ServiceNow background script (server-side, GlideRecord/GlideAggregate as appropriate) ' +
        'for the request below. Return ONLY the script inside a single ```javascript code block, ' +
        'followed by a one-paragraph explanation of what it does and any risks. ' +
        'Prefer read-only/reporting logic unless the request explicitly asks to modify data, ' +
        'and never include destructive operations without an explicit guard.\n\n' +
        `Request: ${description}`
      );
    }
    return rawInput;
  }

  // Commands that need to fetch instance data before prompting the model.
  async function buildAsyncCommandPrompt(rawInput, ctx) {
    if (rawInput.startsWith('/review')) {
      setStatusText('Running deterministic checks...');
      const lintCurrent = servicesRef.current.lintCurrent;

      let findings = [];
      let script = ctx?.scriptBody || '';
      let table = ctx?.table || '';
      let when = '';

      if (lintCurrent) {
        const result = await lintCurrent(ctx);
        findings = result.findings;
        script = result.script || script;
        table = result.table || table;
        when = result.when || '';
      } else if (script) {
        findings = lintScript(script, { table });
      }

      if (!script) throw new Error('No script field was detected on this page.');

      const lintText = formatLintFindings(findings);
      return {
        prompt:
          'Review the following ServiceNow script. A deterministic linter has already run and its ' +
          'findings are included below - do NOT simply repeat them. Focus on what the linter cannot ' +
          'see: business-logic correctness, security and data-exposure risks, behaviour at realistic ' +
          'data volumes, error handling, and maintainability. Respond as a prioritised list with ' +
          'severity, explanation and a concrete suggested fix.\n\n' +
          `Table: ${table || 'unknown'}\nTiming: ${when || 'n/a'}\nField: ${ctx?.scriptFieldLabel || 'unknown'}\n\n` +
          `## Deterministic linter findings\n${lintText}\n\n` +
          `## Script\n\`\`\`javascript\n${redactSecrets(script).slice(0, 12000)}\n\`\`\``,
        preamble: `Deterministic linter:\n${lintText}\n\nAsking the model for a deeper review...`,
      };
    }

    if (rawInput.startsWith('/conflictcheck')) {
      const runConflictCheck = servicesRef.current.runConflictCheck;
      if (!runConflictCheck) throw new Error('Conflict check is unavailable on this page.');

      setStatusText('Fetching related records...');
      const { current, related, findings, supported } = await runConflictCheck(ctx);
      if (!supported) {
        throw new Error(
          'Conflict check supports Business Rules, Client Scripts, Script Includes and ACLs. ' +
            `This page (${ctx?.table || 'unknown table'}) is not supported.`
        );
      }

      const deterministicText = findings.length
        ? findings
            .map((f) => `- [${f.severity.toUpperCase()}] ${f.type}: ${f.message} (record: ${f.recordName})`)
            .join('\n')
        : '- None detected by the deterministic checks.';

      const relatedText = related
        .slice(0, 20)
        .map((r) => `### ${r.name}\n${redactSecrets(JSON.stringify(r, null, 2)).slice(0, 1500)}`)
        .join('\n\n');

      return {
        prompt:
          'You are checking a new/edited ServiceNow configuration record for conflicts with existing ' +
          'active configuration on the same instance. Identify logical duplication, execution-order ' +
          'risks, and security regressions. Be specific and reference the conflicting record names.\n\n' +
          `Table: ${ctx?.table}\n\n` +
          `## Record under review\n${redactSecrets(JSON.stringify(current, null, 2)).slice(0, 3000)}\n\n` +
          `## Deterministic findings already detected\n${deterministicText}\n\n` +
          `## Existing related active records\n${relatedText}`,
        preamble: `Deterministic checks found ${findings.length} potential conflict(s).\n${deterministicText}\n\nAsking the model for a semantic review...`,
      };
    }

    if (rawInput.startsWith('/dedupe')) {
      const fetchCis = servicesRef.current.fetchCis;
      if (!fetchCis) throw new Error('CMDB dedupe is unavailable on this page.');

      setStatusText('Fetching CI batch...');
      const cis = await fetchCis();
      if (!cis.length) throw new Error('No CIs returned. Try running this from a CMDB list.');

      return {
        prompt:
          'Below is a batch of ServiceNow CMDB configuration items. Identify likely DUPLICATE groups ' +
          '(same physical/logical asset recorded more than once). Group them, give a confidence level, ' +
          'and explain the evidence (matching serial, IP, FQDN, near-identical names, etc.). ' +
          'Ignore CIs that are merely similar in class but clearly distinct.\n\n' +
          JSON.stringify(cis, null, 2).slice(0, 12000),
        preamble: `Analyzing ${cis.length} CIs for duplicates...`,
      };
    }

    if (rawInput.startsWith('/logs')) {
      const fetchLogs = requireService('fetchLogs', 'Log triage');
      const contains = rawInput.replace('/logs', '').trim();

      setStatusText('Pulling recent errors...');
      const { groups, slow, minutes, total } = await fetchLogs({ contains });

      if (!groups.length) {
        return {
          skipAi: true,
          preamble: `No error entries in the last ${minutes} minutes${contains ? ` matching "${contains}"` : ''}.`,
        };
      }

      const topText = groups
        .slice(0, 8)
        .map((g) => `- ${g.count}x ${g.sample.slice(0, 160)}`)
        .join('\n');

      return {
        prompt: buildLogTriagePrompt({ groups, slow, minutes }),
        preamble: `${total} error entries in the last ${minutes} minutes, grouped into ${groups.length} distinct issue(s):\n${topText}\n\nAsking the model to triage...`,
      };
    }

    if (rawInput.startsWith('/trace')) {
      const traceText = rawInput.replace('/trace', '').trim();
      if (!traceText) throw new Error('Paste the stack trace after /trace.');

      const resolveTrace = requireService('resolveTrace', 'Stack trace resolution');
      setStatusText('Resolving referenced scripts...');
      const { resolved } = await resolveTrace(traceText);

      const preamble = resolved.length
        ? `Resolved ${resolved.length} artifact(s): ${resolved
            .map((r) => `${r.label} "${r.name}"${r.line ? ` line ${r.line}` : ''}`)
            .join(', ')}. Asking the model to diagnose...`
        : 'No referenced artifact resolved to a record on this instance. Diagnosing from the trace alone...';

      return { prompt: buildTracePrompt(traceText, resolved), preamble };
    }

    if (rawInput.startsWith('/atf')) {
      const fetchArtifactRecord = requireService('fetchArtifactRecord', 'ATF generation');
      setStatusText('Reading the record...');
      const record = await fetchArtifactRecord(ctx);
      if (!record) throw new Error('Open a Business Rule, Script Include, Client Script or UI Action first.');

      return {
        prompt:
          'Design an Automated Test Framework (ATF) test for the ServiceNow artifact below. Provide: ' +
          '(1) test name and purpose, (2) required test data setup and any Impersonate step, ' +
          '(3) the ordered ATF steps naming the specific step type for each, (4) the assertions that ' +
          'prove the logic works, including at least one negative case, and (5) cleanup considerations. ' +
          'Where a Run Server Side Script step is needed, give the actual script.\n\n' +
          `Table: ${ctx?.table}\n\n${redactSecrets(JSON.stringify(record, null, 2)).slice(0, 8000)}`,
        preamble: `Generating an ATF test outline for "${record.name || ctx?.sysId}"...`,
      };
    }

    if (rawInput.startsWith('/document')) {
      const fetchArtifactRecord = requireService('fetchArtifactRecord', 'Documentation generation');
      setStatusText('Reading the record...');
      const record = await fetchArtifactRecord(ctx);
      if (!record) throw new Error('Open a configuration record first.');

      return {
        prompt:
          'Write technical documentation in markdown for the ServiceNow artifact below. Use these ' +
          'sections: Purpose, Trigger/When it runs, Inputs, Logic walkthrough (step by step, in plain ' +
          'language), Outputs and side effects, Dependencies (tables, script includes, properties), ' +
          'Risks and gotchas, and a Change checklist for a future maintainer. Be precise, no filler.\n\n' +
          `Table: ${ctx?.table}\n\n${redactSecrets(JSON.stringify(record, null, 2)).slice(0, 8000)}`,
        preamble: `Documenting "${record.name || ctx?.sysId}"...`,
      };
    }

    if (rawInput.startsWith('/audit')) {
      const runAudit = requireService('runSecurityAudit', 'Security audit');
      setStatusText('Auditing instance configuration...');
      const result = await runAudit();

      return {
        prompt: buildAuditPrompt(result),
        preamble: `${formatAuditFindings(result)}\n\nAsking the model to prioritise these findings...`,
      };
    }

    return null;
  }

  function extractCodeBlock(text) {
    const match = text.match(/```(?:javascript|js)?\n([\s\S]*?)```/i);
    return match ? match[1].trim() : null;
  }

  // Commands that just open a panel; no model call involved.
  const PANEL_COMMANDS = {
    '/compare': () => openPanel('compare'),
    '/search': () => openPanel('search'),
    '/updateset': () => openPanel('updateset'),
    '/updatesets': () => openPanel('updateset'),
    '/rest': () => openPanel('rest'),
    '/automate': () => openPanel('automation'),
    '/prompts': () => openWithContext('prompts', { kind: 'prompts' }),
    '/prompt': () => openWithContext('prompts', { kind: 'prompts' }),
    '/snippets': () => openWithContext('prompts', { kind: 'snippets' }),
    '/snippet': () => openWithContext('prompts', { kind: 'snippets' }),
    '/list': () => openPanel('query'),
    '/query': () => openPanel('query'),
    '/tail': () => openPanel('logtail'),
    '/versions': () => openWithContext('versions'),
    '/fields': () => openWithContext('fields'),
    '/remote': () => openWithContext('remote'),
    '/tests': () => openPanel('atf'),
    '/scope': () => openPanel('scope'),
    '/script': () => setShowBgPanel(true),
    '/testclient': () => openPanel('testbench'),
    '/bench': () => openPanel('testbench'),
  };

  async function handleSend(overrideText) {
    let trimmed = (typeof overrideText === 'string' ? overrideText : input).trim();
    if (!trimmed || busy) return;

    // /chat skips the agent: a plain model call with no tools.
    let plainChat = false;
    if (/^\/chat(\s|$)/.test(trimmed)) {
      trimmed = trimmed.replace(/^\/chat\s*/, '');
      plainChat = true;
      if (!trimmed) {
        setInput('');
        pushLocal('/chat', 'Usage: /chat <message>. It talks to the model directly, without tools.');
        return;
      }
    }

    if (/^\/api(\s|$)/.test(trimmed)) {
      setInput('');
      closeAllPanels();
      openPanel('api', { query: trimmed.replace(/^\/api\s*/, '') });
      return;
    }

    if (speech.listening) speech.stop();

    if (trimmed === '/help') {
      setInput('');
      pushLocal(trimmed, SLASH_HELP, { help: true });
      return;
    }

    if (trimmed === '/clear') {
      setInput('');
      setMessages([]);
      return;
    }

    const panelCommand = PANEL_COMMANDS[trimmed.split(/\s+/)[0]];
    if (panelCommand) {
      setInput('');
      closeAllPanels();
      panelCommand();
      return;
    }

    const registered = panelForSlash(trimmed.split(/\s+/)[0]);
    if (registered) {
      setInput('');
      closeAllPanels();
      openRegisteredPanel(registered.name, { args: trimmed.replace(/^\S+\s*/, '') });
      return;
    }

    setInput('');
    baseInputRef.current = '';

    // Always read the page as it is now: the sidebar stays open across in-app navigation.
    const ctx = getContext();
    setBusy(true);

    try {
      const local = await runLocalCommand(trimmed, ctx);
      if (local) {
        pushLocal(trimmed, local.text);
        return;
      }

      const asyncCommand = await buildAsyncCommandPrompt(trimmed, ctx);

      // Plain messages go to the agent, which can look things up, verify and test.
      if (!asyncCommand && agentEnabled && !plainChat && !trimmed.startsWith('/')) {
        await runAgentTurn(trimmed, ctx);
        return;
      }

      // Some commands resolve entirely locally (e.g. /logs with no hits).
      if (asyncCommand?.skipAi) {
        pushLocal(trimmed, asyncCommand.preamble);
        return;
      }

      const promptContent = asyncCommand ? asyncCommand.prompt : buildPromptForSlashCommand(trimmed, ctx);

      const turnsToAdd = [{ role: 'user', content: promptContent, displayContent: trimmed }];
      if (asyncCommand?.preamble) {
        turnsToAdd.push({ role: 'assistant', content: asyncCommand.preamble, displayContent: asyncCommand.preamble, local: true });
      }

      const nextMessages = [...messages, ...turnsToAdd];
      setMessages(nextMessages);
      setStatusText('Waiting for the model...');

      const response = await chrome.runtime.sendMessage({
        type: 'CHAT_COMPLETION',
        payload: {
          messages: nextMessages.filter((m) => !m.local).map((m) => ({ role: m.role, content: m.content })),
        },
      });
      if (!response?.ok) {
        throw new Error(response?.error || 'Unknown error from AI provider.');
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: response.content, displayContent: response.content }]);

      // /generate drops its script straight into the background script runner
      // for the user to review before running.
      if (trimmed.startsWith('/generate')) {
        const code = extractCodeBlock(response.content);
        if (code) {
          setBgScript(code);
          setShowBgPanel(true);
          setBgDryRun(true);
          setBgResult('Generated script loaded below. Dry run is ON by default - review it before running.');
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${err.message}`, displayContent: `\u26a0\ufe0f ${err.message}`, local: true },
      ]);
    } finally {
      setBusy(false);
      setStatusText(null);
    }
  }

  function decideApproval(stepId, approved) {
    const resolve = approvalsRef.current.get(stepId);
    if (!resolve) return;
    approvalsRef.current.delete(stepId);
    resolve({ approved });
  }

  function stopAgent() {
    abortRef.current?.abort();
    approvalsRef.current.forEach((resolve) => resolve({ approved: false, note: 'stopped' }));
    approvalsRef.current.clear();
  }

  // One agent turn: the model looks things up, drafts, verifies and tests with
  // tools; anything that changes something waits here for the user.
  async function runAgentTurn(text, ctx) {
    const inst = instance || getInstanceInfo();
    const { text: systemText, skill } = buildSystemPrompt({ context: ctx, instance: inst, autonomy });
    const runId = `r${Date.now().toString(36)}`;

    const history = messages
      .filter((m) => !m.local && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
    while (history.length && history[0].role !== 'user') history.shift();

    const controller = new AbortController();
    abortRef.current = controller;

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text, displayContent: text },
      { role: 'assistant', kind: 'agent', run: newRun(runId, { id: skill.id, title: skill.title }), content: '', displayContent: '' },
    ]);

    const onEvent = (event) => setMessages((prev) => prev.map((m) => (m.run?.id === runId ? { ...m, run: reduceRun(m.run, event) } : m)));

    const tools = TOOL_SCHEMAS.filter((t) => autonomy !== 'readonly' || t.tier === 'observe' || t.tier === 'draft').map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));

    const callModel = async ({ messages: convo, tools: offered }) => {
      const res = await chrome.runtime.sendMessage({ type: 'AGENT_STEP', payload: { messages: convo, tools: offered, effort: 'medium' } });
      if (!res?.ok) throw new Error(res?.error || 'The AI provider did not answer.');
      return res.reply;
    };

    const requestApproval = ({ id, tool, args }) =>
      new Promise((resolve) => {
        approvalsRef.current.set(id, resolve);
        requireService('agentPreview')(tool, args)
          // `{}` / `{error}` still mark the preview as settled, so Approve never stays locked (or opens unseen).
          .then((preview) => onEvent({ type: 'approval_preview', id, preview: preview ?? {} }))
          .catch((err) => onEvent({ type: 'approval_preview', id, preview: { error: err?.message || 'The preview failed.' } }));
      });

    setStatusText(null);
    try {
      const result = await runAgent({
        messages: [{ role: 'system', content: systemText }, ...history, { role: 'user', content: text }],
        tools,
        callModel,
        executeTool: (name, args) => requireService('agentExecute')(name, args),
        // Read fresh for every call: the guard follows the user's instance label, which can change during a run.
        approvalMode: (name, args) => approvalMode({ tool: name, args, autonomy, isProd: isGuardedEnv(getInstanceInfo().env), guard: guardRef.current }),
        guard: guardRef.current,
        requestApproval,
        onEvent,
        signal: controller.signal,
      });
      setMessages((prev) => prev.map((m) => (m.run?.id === runId ? { ...m, content: result.finalText, displayContent: result.finalText } : m)));
    } finally {
      abortRef.current = null;
      approvalsRef.current.clear();
    }
  }

  // Send a prepared prompt to the model from a panel rather than the chat box.
  async function askAi(displayLabel, prompt) {
    if (busy) return;
    // The answer lands in the chat, so leave the panel view and make sure the chat is showing.
    closeAllPanels();
    setVisible(true);
    setBusy(true);
    setStatusText('Waiting for the model...');
    try {
      const nextMessages = [...messages, { role: 'user', content: prompt, displayContent: displayLabel }];
      setMessages(nextMessages);

      const response = await chrome.runtime.sendMessage({
        type: 'CHAT_COMPLETION',
        payload: {
          messages: nextMessages.filter((m) => !m.local).map((m) => ({ role: m.role, content: m.content })),
        },
      });
      if (!response?.ok) throw new Error(response?.error || 'Unknown error from AI provider.');

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: response.content, displayContent: response.content },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${err.message}`, displayContent: `\u26a0\ufe0f ${err.message}`, local: true },
      ]);
    } finally {
      setBusy(false);
      setStatusText(null);
    }
  }

  async function handleRunBackgroundScript() {
    if (!runnerRef.current) {
      setBgResult('Error: background script runner is not available.');
      return;
    }

    // Last line of defence before an AI-generated script touches real data.
    if (!bgDryRun && scriptRisk.hasWrites) {
      const confirmed = await askConfirm({ ...runWritesAsk(scriptRisk.writes.length), details: formatRiskSummary(scriptRisk) });
      if (!confirmed) return;
    }

    setBusy(true);
    setBgResult(null);
    setBgOutput('');
    try {
      const html = await runnerRef.current(bgScript, { dryRun: bgDryRun });
      setBgOutput(extractScriptOutput(html));
      recordRun({ script: bgScript, instance: window.location.hostname, scope: 'global', dryRun: bgDryRun })
        .then(setBgHistory)
        .catch(() => {});
      setBgResult(
        bgDryRun
          ? 'Dry run submitted. Writes were intercepted and logged - look for "[NowBuddy dry run]" entries in the system log.'
          : 'Script executed.'
      );
    } catch (err) {
      setBgResult(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function insertIntoComposer(text) {
    setVisible(true);
    setInput(text);
    baseInputRef.current = text;
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function handleExportChat() {
    if (!messages.length) return;
    const text = [
      '# NowBuddy conversation',
      '',
      `Exported: ${new Date().toISOString()}`,
      '',
      ...messages.map((m) => `## ${m.role}\n\n${m.displayContent ?? m.content}\n`),
    ].join('\n');
    downloadText(suggestFilename('chat'), text);
  }

  // Keep a ref to the latest handleSend so runCommand() (called imperatively
  // from the toolbar) always invokes the current closure.
  useEffect(() => {
    handleSendRef.current = handleSend;
  });

  const windowMode = toolSurface === 'window';

  // One tool panel, wherever it is shown (docked in the sidebar or in a window).
  function renderPanel(p, onClose) {
    return (
      <>
        {p.name === 'compare' && (
          <ComparePanel onClose={onClose} currentInstanceUrl={window.location.hostname} />
        )}

        {p.name === 'search' && (
          <SearchPanel
            key={p.query}
            initialTerm={p.query || ''}
            onClose={onClose}
            runSearch={(term, options) => requireService('searchCode', 'Code search')(term, options)}
            onAskAi={(search) =>
              askAi(
                `Explain the usages of "${search.term}"`,
                'The following are all references to a symbol across a ServiceNow instance. Explain how it ' +
                  'is used, group the callers by purpose, identify the riskiest places to change it, and ' +
                  'flag anything that looks like duplicated or dead logic.\n\n' +
                  search.results
                    .slice(0, 40)
                    .map(
                      (r) =>
                        `### ${r.label}: ${r.name} (${r.field})\n` +
                        r.matches.map((m) => `${m.lineNumber}: ${m.text}`).join('\n')
                    )
                    .join('\n\n')
                    .slice(0, 12000)
              )
            }
          />
        )}

        {p.name === 'updateset' && (
          <UpdateSetPanel
            onClose={onClose}
            services={servicesRef.current}
            onAskAi={(data) => askAi('Assess deployment risk for this update set', buildUpdateSetPrompt(data))}
          />
        )}

        {p.name === 'rest' && (
          <RestPanel
            onClose={onClose}
            runRequest={(request) => requireService('runRestRequest', 'REST builder')(request)}
            onAskAi={({ method, path, response }) =>
              askAi(
                `Explain the response from ${method} ${path}`,
                'Explain this ServiceNow API response for a developer. Cover what the HTTP status means, ' +
                  'what the payload represents, and anything that looks wrong.\n\n' +
                  `Request: ${method} ${path}\nStatus: ${response.status}\n\n` +
                  redactSecrets(response.body).slice(0, 8000)
              )
            }
          />
        )}

        {p.name === 'prompts' && (
          <PromptLibraryPanel
            key={p.kind}
            initialKind={p.kind}
            onClose={onClose}
            getContext={getContext}
            onRun={(title, prompt) => askAi(title, prompt)}
            onInsert={insertIntoComposer}
            onUseScript={loadScriptIntoRunner}
          />
        )}

        {p.name === 'query' && (
          <QueryPanel
            onClose={onClose}
            services={servicesRef.current}
            onUseScript={loadScriptIntoRunner}
            onAskAi={({ table, query, explanation }) =>
              askAi(
                `Improve the filter on ${table}`,
                'Review this ServiceNow list filter. Point out conditions that are slow on large tables ' +
                  '(leading wildcards, unindexed fields, dot-walks), anything that looks wrong, and a better ' +
                  'equivalent if one exists.\n\n' +
                  `Table: ${table}\nEncoded query: ${query}\n\nPlain English:\n${explanation}`
              )
            }
          />
        )}

        {p.name === 'logtail' && (
          <LogTailPanel
            onClose={onClose}
            services={servicesRef.current}
            onAskAi={(text) =>
              askAi(
                'Explain these log entries',
                'Explain these ServiceNow system log entries. Group related lines, identify the root cause of ' +
                  'any errors, and say what to check first.\n\n' +
                  text
              )
            }
          />
        )}

        {p.name === 'apply' && (
          <ApplyPanel
            code={p.code}
            table={p.context?.table}
            services={servicesRef.current}
            onClose={onClose}
          />
        )}

        {p.name === 'remote' && (
          <RemoteRecordPanel context={p.context} services={servicesRef.current} onClose={onClose} />
        )}

        {p.name === 'versions' && (
          <VersionPanel context={p.context} services={servicesRef.current} onClose={onClose} />
        )}

        {p.name === 'fields' && (
          <FieldInspectorPanel context={p.context} services={servicesRef.current} onClose={onClose} />
        )}

        {p.name === 'atf' && (
          <AtfPanel
            services={servicesRef.current}
            onClose={onClose}
            onAskAi={(label, prompt) => askAi(label, prompt)}
          />
        )}

        {p.name === 'scope' && <ScopeExportPanel services={servicesRef.current} onClose={onClose} />}

        {p.name === 'automation' && <AutomationPanel services={servicesRef.current} onClose={onClose} />}

        {p.name === 'api' && <ApiExplorerPanel key={p.query} initialQuery={p.query || ''} onClose={onClose} />}

        {p.name === 'testbench' && (
          <TestBenchPanel services={servicesRef.current} onClose={onClose} onAskAi={(label, prompt) => askAi(label, prompt)} />
        )}

        {(() => {
          const entry = panelByName(p.name);
          if (!entry) return null;
          const Panel = entry.component;
          return (
            <Panel
              key={`${p.name}:${p.params?.args || ''}`}
              context={p.context || null}
              params={p.params || {}}
              services={servicesRef.current}
              onClose={onClose}
              onAskAi={(label, prompt) => askAi(label, prompt)}
              onUseScript={loadScriptIntoRunner}
              onInsert={insertIntoComposer}
            />
          );
        })()}
      </>
    );
  }

  const bgPanelNode = showBgPanel ? (
      <div className="msb-sidebar__bg-panel">
        <textarea
          value={bgScript}
          onChange={(e) => setBgScript(e.target.value)}
          placeholder="Write a background script..."
        />
  
        {bgHistory.length > 0 && (
          <div className="msb-sidebar__bg-history">
            <select
              value=""
              onChange={(e) => {
                const entry = bgHistory[Number(e.target.value)];
                if (entry) {
                  setBgScript(entry.script);
                  setBgOutput('');
                  setBgDryRun(true);
                }
              }}
              aria-label="Script history"
            >
              <option value="">History ({bgHistory.length})</option>
              {bgHistory.map((entry, i) => (
                <option key={entry.ts + i} value={i}>
                  {new Date(entry.ts).toLocaleString()} {entry.dryRun ? '(dry) ' : ''}
                  {entry.script.replace(/\s+/g, ' ').slice(0, 40)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={async () => {
                if (await askConfirm(clearHistoryAsk())) {
                  clearHistory().then(() => setBgHistory([]));
                }
              }}
            >
              Clear history
            </button>
          </div>
        )}
  
        {bgScript.trim() && (
          <div className={`msb-sidebar__risk msb-sidebar__risk--${scriptRisk.highestSeverity || 'none'}`}>
            {formatRiskSummary(scriptRisk)}
          </div>
        )}
  
        <label className="msb-sidebar__dryrun">
          <input type="checkbox" checked={bgDryRun} onChange={trusted((e) => setBgDryRun(e.target.checked))} />
          Dry run (intercept GlideRecord writes and log them instead)
        </label>
  
        {bgDryRun && (
          <div className="msb-sidebar__hint">
            Dry run does not intercept direct SQL, outbound REST, gs.setProperty, or side effects of
            events and flows that have already been triggered.
          </div>
        )}
  
        <div className="msb-sidebar__bg-actions">
          <button onClick={trusted(handleRunBackgroundScript)} disabled={busy || !bgScript.trim()}>
            {bgDryRun ? 'Dry run' : 'Run for real'}
          </button>
          <button onClick={() => setShowBgPanel(false)}>Close</button>
        </div>
        {bgResult && <div className="msb-sidebar__bg-result">{bgResult}</div>}
        {bgOutput && <pre className="msb-sidebar__bg-output">{bgOutput}</pre>}
      </div>
  ) : null;

  const view = { w: window.innerWidth, h: window.innerHeight };
  // Stacking order -> rank, so the CSS z-index stays inside the band between the sidebar and the palette.
  const stack = [...windows.map((w) => ({ id: w.wid, z: w.z })), ...(windowMode && showBgPanel ? [{ id: 'bg', z: bgZ }] : [])].sort((a, b) => a.z - b.z);
  const rankOf = (id) => Math.min(8, stack.findIndex((x) => x.id === id));
  const windowsNode = (
    <>
      {windows.map((w, index) => (
        <ToolWindow
          key={w.wid}
          name={w.name}
          title={windowTitle(w.name)}
          z={rankOf(w.wid)}
          defaultRect={defaultWindowRect({ view, sidebarWidth: visible ? width : 0, size: windowSize(w.name), index })}
          onFocus={() => focusWindow(w.wid)}
          onClose={() => closeWindow(w.wid)}
          onDock={() => dockWindow(w)}
        >
          {renderPanel(w, () => closeWindow(w.wid))}
        </ToolWindow>
      ))}
      {windowMode && showBgPanel && (
        <ToolWindow
          key="bgscript"
          name="bgscript"
          title={windowTitle('bgscript')}
          z={rankOf('bg')}
          defaultRect={defaultWindowRect({ view, sidebarWidth: visible ? width : 0, size: windowSize('bgscript'), index: windows.length })}
          onFocus={() => bgZ !== zRef.current && setBgZ(raise())}
          onClose={() => setShowBgPanel(false)}
        >
          {bgPanelNode}
        </ToolWindow>
      )}
    </>
  );

  if (!visible) return windowsNode;

  const heroSkill = selectSkills(context || {});

  return (
    <>
    <div
      className={`msb-sidebar${panel || (showBgPanel && !windowMode) ? ' msb-sidebar--focus' : ''}`}
      style={{ '--msb-sidebar-width': `${width}px` }}
    >
      <div
        className="msb-sidebar__resizer"
        onPointerDown={startResize}
        onKeyDown={onResizerKeyDown}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize sidebar (Left and Right arrow keys)"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
      />

      <div className="msb-sidebar__header">
        <span className="msb-sidebar__brand" aria-hidden="true">
          <Icon name="braces" size={16} />
        </span>
        <span className="msb-sidebar__titles">
          <span className="msb-sidebar__title">
            NowBuddy
            {instance && (
              <span
                className={`msb-env msb-env--${instance.tone}`}
                title={`Instance: ${instance.host}`}
              >
                {instance.label}
              </span>
            )}
          </span>
          <span className="msb-sidebar__subtitle">
            {window.location.hostname}
            {providerInfo?.modelLabel && (
              <button type="button" className="msb-sidebar__model" title="Change the model in settings" onClick={() => chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' })}>
                {providerInfo.modelLabel}
              </button>
            )}
            {(() => {
              const chip = usageChip(usage.log, usage.caps, providerInfo?.provider || 'anthropic');
              return chip.show ? (
                <button type="button" className={`msb-sidebar__usage msb-sidebar__usage--${chip.status}`} title={chip.title} onClick={() => chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' })}>
                  {chip.text}
                </button>
              ) : null;
            })()}
          </span>
        </span>
        <div className="msb-sidebar__header-actions">
          {panel && (
            <button onClick={popOutPanel} title="Pop out to a window" aria-label="Pop out to a window">
              <Icon name="popout" />
            </button>
          )}
          {onOpenPalette && (
            <button onClick={onOpenPalette} title="Command palette (Ctrl+Shift+Space)" aria-label="Command palette">
              <Icon name="command" />
            </button>
          )}
          <span className="msb-sidebar__menuwrap">
            <button
              ref={themeButtonRef}
              onClick={() => setThemeMenu((open) => !open)}
              title="Theme"
              aria-label="Theme"
              aria-haspopup="menu"
              aria-expanded={themeMenu}
            >
              <Icon name={theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor'} />
            </button>
            {themeMenu && (
              <div className="msb-sidebar__menu" role="menu" aria-label="Theme" ref={themeMenuRef} onKeyDown={onThemeMenuKeyDown}>
                {[
                  ['system', 'Match system', 'monitor'],
                  ['light', 'Light', 'sun'],
                  ['dark', 'Dark', 'moon'],
                ].map(([value, label, icon]) => (
                  <button
                    key={value}
                    role="menuitemradio"
                    aria-checked={theme === value}
                    className={theme === value ? 'msb-sidebar__menu-item msb-sidebar__menu-item--on' : 'msb-sidebar__menu-item'}
                    onClick={() => {
                      changeTheme(value);
                      setThemeMenu(false);
                    }}
                  >
                    <Icon name={icon} size={14} />
                    {label}
                  </button>
                ))}
              </div>
            )}
          </span>
          <button
            onClick={handleExportChat}
            title="Export conversation as markdown"
            aria-label="Export conversation"
          >
            <Icon name="download" />
          </button>
          <button
            onClick={() => setMessages([])}
            title="Clear conversation"
            aria-label="Clear conversation"
          >
            <Icon name="trash" />
          </button>
          <button onClick={() => setVisible(false)} title="Close" aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
      </div>

      {notice && <div className="msb-sidebar__notice">{notice}</div>}

      {providerInfo && !providerInfo.hasKey && (
        <div className="msb-sidebar__keybanner">
          <Icon name="lock" size={14} />
          <span>Add your {providerInfo.label} API key to start.</span>
          <button type="button" onClick={() => chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' })}>
            Open settings
          </button>
        </div>
      )}

      {context && (
        <div className="msb-sidebar__context-chip">
          <span className="msb-sidebar__ctx">
            <b>table</b>
            {context.table || 'n/a'}
          </span>
          {context.sysId && (
            <span
              className="msb-sidebar__ctx msb-sidebar__ctx--copy"
              title="Copy sys_id"
              onClick={() => navigator.clipboard?.writeText(context.sysId)}
            >
              <b>sys_id</b>
              {context.sysId}
            </span>
          )}
          <span className="msb-sidebar__ctx">
            <b>script</b>
            {context.scriptBody ? context.scriptFieldLabel || 'script' : 'none detected'}
          </span>
        </div>
      )}

      {!windowMode && bgPanelNode}

      {panel && renderPanel(panel, closeAllPanels)}


      <div className="msb-sidebar__messages" ref={messagesRef}>
        {!messages.length && !statusText && (
          <div className="msb-hero">
            <h3>{agentEnabled ? 'Ask about this page' : 'Ask about this record'}</h3>
            <p>
              {agentEnabled
                ? 'Say what you want to understand or change. It reads the instance first, checks scripts against the real API catalog, and writes nothing until you approve.'
                : 'Ask about the record you are on, or pick a tool. Type / for every command.'}
            </p>
            {agentEnabled && (
              <>
                <div className="msb-hero__skill">
                  <Icon name={heroSkill.primary.id === 'client-script' ? 'braces' : 'database'} size={13} />
                  <span>
                    Using the <b>{heroSkill.primary.title} skill</b>: <em>{heroSkill.reason}</em>
                  </span>
                </div>
                <div className="msb-hero__prompts">
                  {(SUGGESTIONS[heroSkill.primary.id] || []).map((text) => (
                    <button key={text} type="button" className="msb-hero__prompt" onClick={trusted(() => handleSend(text))}>
                      {text}
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="msb-hero__label">Tools</div>
            <div className="msb-sidebar__tools">
              {TOOLS.map((t) => (
                <button key={t.command} type="button" className="msb-sidebar__tool" onClick={() => handleSend(t.command)}>
                  <span className="msb-sidebar__tool-icon" aria-hidden="true">
                    <Icon name={t.icon} size={15} />
                  </span>
                  <span className="msb-sidebar__tool-text">
                    <span className="msb-sidebar__tool-title">{t.title}</span>
                    <span className="msb-sidebar__tool-hint">{t.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.kind === 'agent' ? (
            <div key={i} className="msb-sidebar__message msb-sidebar__message--assistant msb-sidebar__message--agent">
              <div className="msb-sidebar__msg-role">
                <span className="msb-sidebar__msg-avatar" aria-hidden="true">
                  AI
                </span>
                NowBuddy
              </div>
              <AgentRun run={m.run} instance={instance || getInstanceInfo()} onDecision={decideApproval} />
              {m.displayContent && (
                <MessageBody text={m.displayContent} onApply={m.run.status !== 'running' ? (code) => openWithContext('apply', { code }) : undefined} />
              )}
            </div>
          ) : (
          <div
            key={i}
            className={`msb-sidebar__message msb-sidebar__message--${m.role}${
              m.local ? ' msb-sidebar__message--local' : ''
            }`}
          >
            <div className="msb-sidebar__msg-role">
              <span className="msb-sidebar__msg-avatar" aria-hidden="true">
                {m.role === 'user' ? 'You' : 'AI'}
              </span>
              {m.role === 'user' ? 'You' : 'NowBuddy'}
            </div>
            {m.help ? (
              <HelpBody text={m.displayContent ?? m.content} />
            ) : (
              <MessageBody
                text={m.displayContent ?? m.content}
                onApply={m.role === 'assistant' && !m.local ? (code) => openWithContext('apply', { code }) : undefined}
              />
            )}
          </div>
          )
        )}

        {statusText && (
          <div className="msb-sidebar__status">
            <span className="msb-spinner" aria-hidden="true" />
            {statusText}
          </div>
        )}
      </div>

      <div className="msb-sidebar__composer">
        <div className="msb-sidebar__input-row">
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              baseInputRef.current = e.target.value;
            }}
            onKeyDown={(e) => {
              // Enter that confirms an IME candidate (CJK etc.) must not send the half-typed message.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (isTrustedEvent(e)) handleSend(); // never on a page script's synthetic Enter
              }
            }}
            placeholder={speech.listening ? 'Listening...' : 'Ask NowBuddy, or type / for commands'}
            disabled={busy}
          />
          <button
            className="msb-sidebar__mic"
            onClick={() => openWithContext('prompts', { kind: 'prompts' })}
            disabled={busy}
            title="Prompt library"
            aria-label="Open prompt library"
          >
            <Icon name="book" />
          </button>
          {speech.supported && (
            <button
              className={`msb-sidebar__mic${speech.listening ? ' msb-sidebar__mic--active' : ''}`}
              onClick={handleMicToggle}
              disabled={busy}
              title={speech.listening ? 'Stop dictation' : 'Dictate with microphone'}
              aria-label={speech.listening ? 'Stop dictation' : 'Start dictation'}
            >
              <Icon name={speech.listening ? 'stop' : 'mic'} />
            </button>
          )}
          {busy && abortRef.current ? (
            <button className="msb-sidebar__send msb-sidebar__send--stop" onClick={stopAgent} title="Stop the agent" aria-label="Stop the agent">
              <Icon name="stop" />
            </button>
          ) : (
            <button
              className="msb-sidebar__send"
              onClick={trusted(() => handleSend())}
              disabled={busy || !input.trim()}
              title="Send"
              aria-label="Send"
            >
              <Icon name="send" />
            </button>
          )}
        </div>
        <div className="msb-sidebar__composer-hint">
          <span>
            <kbd>Enter</kbd> send <kbd>/</kbd> commands
          </span>
          {agentEnabled && (
            <label className="msb-autonomy" title={AUTONOMY_LEVELS.find((l) => l.id === autonomy)?.hint}>
              <Icon name="shield" size={11} />
              <select
                value={autonomy}
                onChange={(e) => {
                  setAutonomy(e.target.value);
                  saveSettings({ agentAutonomy: e.target.value });
                }}
                aria-label="How much the agent may do without asking"
              >
                {AUTONOMY_LEVELS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
    </div>
    {windowsNode}
    </>
  );
});

export default Sidebar;
