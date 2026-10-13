import React, { forwardRef, useImperativeHandle, useState, useEffect, useRef } from 'react';
import { redactSecrets } from '../providers/redact.js';
import { useSpeechInput } from './useSpeechInput.js';
import { useTheme } from './useTheme.js';
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
import Icon from './Icon.jsx';
import MessageBody from './MessageBody.jsx';

const HISTORY_KEY = 'mysnowbuddy_chat_history';
const WIDTH_KEY = 'mysnowbuddy_sidebar_width';
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;

const TOOLS = [
  { command: '/lint', title: 'Review script', hint: 'Lint the script on this form' },
  { command: '/formdiff', title: 'Unsaved changes', hint: 'Diff the form against the record' },
  { command: '/logs', title: 'Triage errors', hint: 'Recent errors, explained' },
  { command: '/search', title: 'Code search', hint: 'Find usages across the instance' },
  { command: '/script', title: 'Script runner', hint: 'Background scripts, dry run first' },
  { command: '/list', title: 'List filter', hint: 'Explain, count, export a query' },
  { command: '/tail', title: 'Live log', hint: 'Follow the system log' },
  { command: '/versions', title: 'Versions', hint: 'History and field diffs' },
  { command: '/updateset', title: 'Update sets', hint: 'Collisions and coverage' },
  { command: '/rest', title: 'REST builder', hint: 'Try Table API requests' },
  { command: '/automate', title: 'Automation', hint: 'Navigate and click through screens' },
  { command: '/remote', title: 'Other instance', hint: 'Compare this record elsewhere' },
  { command: '/prompts', title: 'Prompts', hint: 'Saved and built-in prompts' },
];

const SLASH_HELP = [
  'Analysis (no AI tokens used)',
  '  /lint                  deterministic review of the script on this form',
  '  /formdiff              show unsaved form changes vs the saved record',
  '  /deps <ScriptInclude>  callers and callees as a dependency graph',
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
  'Panels',
  '  /search                global code search',
  '  /list                  list filter: explain, GlideRecord code, count, export',
  '  /tail                  live system log',
  '  /versions              version history and field diff for this record',
  '  /fields                field inspector for this table',
  '  /remote                compare this record with another instance',
  '  /tests                 run ATF suites and see results',
  '  /scope                 export a scope as a ZIP of scripts',
  '  /updateset             update set collisions and coverage',
  '  /rest                  REST request builder',
  '  /automate              navigate and click through screens',
  '  /compare               compare two instances',
  '  /script                background script runner with history',
  '  /prompts               prompt library: saved and built-in prompts',
  '  /snippets              code snippet library',
  '',
  '  /clear                 clear conversation history',
].join('\n');

const Sidebar = forwardRef(function Sidebar({ getContext, instance = null, onOpenPalette = null }, ref) {
  const [theme, changeTheme] = useTheme();
  const [themeMenu, setThemeMenu] = useState(false);
  useEffect(() => {
    if (!themeMenu) return undefined;
    const close = () => setThemeMenu(false);
    const timer = setTimeout(() => document.addEventListener('click', close), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', close);
    };
  }, [themeMenu]);
  const [visible, setVisible] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [context, setContext] = useState(null);
  const [notice, setNotice] = useState(null);
  const [showBgPanel, setShowBgPanel] = useState(false);
  // One panel at a time: { name, ...params } or null.
  const [panel, setPanel] = useState(null);
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

  useEffect(() => {
    chrome.storage.local.get(HISTORY_KEY).then((res) => {
      if (res[HISTORY_KEY]) setMessages(res[HISTORY_KEY]);
      historyLoaded.current = true;
    });
  }, []);

  useEffect(() => {
    if (!historyLoaded.current) return;
    chrome.storage.local.set({ [HISTORY_KEY]: messages });
  }, [messages]);

  useEffect(() => {
    chrome.storage.local.get(WIDTH_KEY).then((res) => {
      const stored = Number(res[WIDTH_KEY]);
      if (stored >= MIN_WIDTH && stored <= MAX_WIDTH) setWidth(stored);
    });
  }, []);

  // Stick to the bottom as the conversation grows.
  useEffect(() => {
    const node = messagesRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, statusText, visible]);

  // Auto-grow the composer up to the CSS max-height.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [input, visible]);

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

  function closeAllPanels() {
    setPanel(null);
    setShowBgPanel(false);
  }

  function openPanel(name, params = {}) {
    setShowBgPanel(false);
    setPanel({ name, ...params });
  }

  // Panels that read the open record get a snapshot of the page at open time.
  function openWithContext(name, params = {}) {
    const ctx = getContext();
    setContext(ctx);
    openPanel(name, { context: ctx, ...params });
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
    openSearchPanel: () => openPanel('search'),
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
    openApplyPanel: (code) => openWithContext('apply', { code }),
    sendPrompt: (label, prompt) => {
      setContext(getContext());
      setVisible(true);
      askAi(label, prompt);
    },
    runCommand: (command) => {
      setContext(getContext());
      setVisible(true);
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

  function pushLocal(userText, assistantText) {
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: userText, displayContent: userText },
      { role: 'assistant', content: assistantText, displayContent: assistantText, local: true },
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
  };

  async function handleSend(overrideText) {
    const trimmed = (typeof overrideText === 'string' ? overrideText : input).trim();
    if (!trimmed || busy) return;

    if (speech.listening) speech.stop();

    if (trimmed === '/help') {
      setInput('');
      pushLocal(trimmed, SLASH_HELP);
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

    setInput('');
    baseInputRef.current = '';

    const ctx = context || getContext();
    setBusy(true);

    try {
      const local = await runLocalCommand(trimmed, ctx);
      if (local) {
        pushLocal(trimmed, local.text);
        return;
      }

      const asyncCommand = await buildAsyncCommandPrompt(trimmed, ctx);

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

  // Send a prepared prompt to the model from a panel rather than the chat box.
  async function askAi(displayLabel, prompt) {
    if (busy) return;
    // The answer lands in the chat, so leave the panel view.
    closeAllPanels();
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
      const confirmed = window.confirm(
        `This script contains ${scriptRisk.writes.length} write operation(s) and dry run is OFF.\n\n` +
          'It will modify data on this instance. Continue?'
      );
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
          ? 'Dry run submitted. Writes were intercepted and logged - look for "[MySnowBuddy dry run]" entries in the system log.'
          : 'Script executed.'
      );
    } catch (err) {
      setBgResult(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function insertIntoComposer(text) {
    setInput(text);
    baseInputRef.current = text;
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function handleExportChat() {
    if (!messages.length) return;
    const text = [
      '# MySnowBuddy conversation',
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

  if (!visible) return null;

  return (
    <div
      className={`msb-sidebar${panel || showBgPanel ? ' msb-sidebar--focus' : ''}`}
      style={{ '--msb-sidebar-width': `${width}px` }}
    >
      <div
        className="msb-sidebar__resizer"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      />

      <div className="msb-sidebar__header">
        <span className="msb-sidebar__brand" aria-hidden="true">
          <Icon name="sparkle" size={16} />
        </span>
        <span className="msb-sidebar__titles">
          <span className="msb-sidebar__title">
            MySnowBuddy
            {instance && (
              <span
                className={`msb-env msb-env--${instance.tone}`}
                title={`Instance: ${instance.host}`}
              >
                {instance.label}
              </span>
            )}
          </span>
          <span className="msb-sidebar__subtitle">{window.location.hostname}</span>
        </span>
        <div className="msb-sidebar__header-actions">
          {onOpenPalette && (
            <button onClick={onOpenPalette} title="Command palette (Ctrl+Shift+Space)" aria-label="Command palette">
              <Icon name="command" />
            </button>
          )}
          <span className="msb-sidebar__menuwrap">
            <button
              onClick={() => setThemeMenu((open) => !open)}
              title="Theme"
              aria-label="Theme"
              aria-haspopup="menu"
              aria-expanded={themeMenu}
            >
              <Icon name={theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor'} />
            </button>
            {themeMenu && (
              <div className="msb-sidebar__menu" role="menu">
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

      {showBgPanel && (
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
                onClick={() => {
                  if (window.confirm('Clear the saved script history?')) {
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
            <input type="checkbox" checked={bgDryRun} onChange={(e) => setBgDryRun(e.target.checked)} />
            Dry run (intercept GlideRecord writes and log them instead)
          </label>

          {bgDryRun && (
            <div className="msb-sidebar__hint">
              Dry run does not intercept direct SQL, outbound REST, gs.setProperty, or side effects of
              events and flows that have already been triggered.
            </div>
          )}

          <div className="msb-sidebar__bg-actions">
            <button onClick={handleRunBackgroundScript} disabled={busy || !bgScript.trim()}>
              {bgDryRun ? 'Dry run' : 'Run for real'}
            </button>
            <button onClick={() => setShowBgPanel(false)}>Close</button>
          </div>
          {bgResult && <div className="msb-sidebar__bg-result">{bgResult}</div>}
          {bgOutput && <pre className="msb-sidebar__bg-output">{bgOutput}</pre>}
        </div>
      )}

      {panel?.name === 'compare' && (
        <ComparePanel onClose={closeAllPanels} currentInstanceUrl={window.location.hostname} />
      )}

      {panel?.name === 'search' && (
        <SearchPanel
          onClose={closeAllPanels}
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

      {panel?.name === 'updateset' && (
        <UpdateSetPanel
          onClose={closeAllPanels}
          services={servicesRef.current}
          onAskAi={(data) => askAi('Assess deployment risk for this update set', buildUpdateSetPrompt(data))}
        />
      )}

      {panel?.name === 'rest' && (
        <RestPanel
          onClose={closeAllPanels}
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

      {panel?.name === 'prompts' && (
        <PromptLibraryPanel
          key={panel.kind}
          initialKind={panel.kind}
          onClose={closeAllPanels}
          getContext={getContext}
          onRun={(title, prompt) => askAi(title, prompt)}
          onInsert={insertIntoComposer}
          onUseScript={loadScriptIntoRunner}
        />
      )}

      {panel?.name === 'query' && (
        <QueryPanel
          onClose={closeAllPanels}
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

      {panel?.name === 'logtail' && (
        <LogTailPanel
          onClose={closeAllPanels}
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

      {panel?.name === 'apply' && (
        <ApplyPanel
          code={panel.code}
          table={panel.context?.table}
          services={servicesRef.current}
          onClose={closeAllPanels}
        />
      )}

      {panel?.name === 'remote' && (
        <RemoteRecordPanel context={panel.context} services={servicesRef.current} onClose={closeAllPanels} />
      )}

      {panel?.name === 'versions' && (
        <VersionPanel context={panel.context} services={servicesRef.current} onClose={closeAllPanels} />
      )}

      {panel?.name === 'fields' && (
        <FieldInspectorPanel context={panel.context} services={servicesRef.current} onClose={closeAllPanels} />
      )}

      {panel?.name === 'atf' && (
        <AtfPanel
          services={servicesRef.current}
          onClose={closeAllPanels}
          onAskAi={(label, prompt) => askAi(label, prompt)}
        />
      )}

      {panel?.name === 'scope' && <ScopeExportPanel services={servicesRef.current} onClose={closeAllPanels} />}

      {panel?.name === 'automation' && <AutomationPanel services={servicesRef.current} onClose={closeAllPanels} />}

      <div className="msb-sidebar__messages" ref={messagesRef}>
        {!messages.length && !statusText && (
          <div className="msb-sidebar__empty">
            <div className="msb-sidebar__empty-mark" aria-hidden="true">
              <Icon name="sparkle" size={22} />
            </div>
            <h3>How can I help?</h3>
            <p>Ask about the record you are on, or pick a tool. Type / in the box for every command.</p>
            <div className="msb-sidebar__tools">
              {TOOLS.map((t) => (
                <button
                  key={t.command}
                  type="button"
                  className="msb-sidebar__tool"
                  onClick={() => handleSend(t.command)}
                >
                  <span className="msb-sidebar__tool-title">{t.title}</span>
                  <span className="msb-sidebar__tool-hint">{t.hint}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
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
              {m.role === 'user' ? 'You' : 'MySnowBuddy'}
            </div>
            <MessageBody
              text={m.displayContent ?? m.content}
              onApply={m.role === 'assistant' && !m.local ? (code) => openWithContext('apply', { code }) : undefined}
            />
          </div>
        ))}

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
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={speech.listening ? 'Listening...' : 'Ask MySnowBuddy, or type / for commands'}
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
          <button
            className="msb-sidebar__send"
            onClick={() => handleSend()}
            disabled={busy || !input.trim()}
            title="Send"
            aria-label="Send"
          >
            <Icon name="send" />
          </button>
        </div>
        <div className="msb-sidebar__composer-hint">
          <kbd>Enter</kbd> send <kbd>Shift</kbd>+<kbd>Enter</kbd> newline <kbd>/help</kbd> commands
        </div>
      </div>
    </div>
  );
});

export default Sidebar;
