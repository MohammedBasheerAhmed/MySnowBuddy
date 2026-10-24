// Every slash command of the chat sidebar in one list: what the suggestion menu offers while you type "/", what /help
// prints, and what the palette adds to its own "/" list. Pure so it can be unit tested.
//
// A command is { verb, args, desc, group, aliases }. The panels come from src/sidebar/panelRegistry.js (add a panel there and it
// shows up here); the rest are the commands Sidebar.jsx handles itself. Sidebar.handleSend tries the commands that open a
// panel first, then the registered panels, then the others, so when two claim one verb the earlier one wins here too and the
// other is left out (it could never be reached).

export const CHECK = 'Check this page (no AI tokens)';
export const DEBUG = 'Debug and explore';
export const TOOLS = 'Tools';
export const ASK = 'Ask the AI';
export const CHAT = 'Agent and chat';

/** The order of the groups in the menu and in /help. */
export const GROUP_ORDER = [CHECK, DEBUG, TOOLS, ASK, CHAT];

// [verb, args, description, group, aliases]. Panels Sidebar.jsx opens itself (its PANEL_COMMANDS table).
const OPEN_PANELS = [
  ['/search', '', 'global code search', TOOLS, []],
  ['/list', '', 'list filter: explain, GlideRecord code, count, export', TOOLS, ['/query']],
  ['/tail', '', 'live system log', TOOLS, []],
  ['/versions', '', 'version history and field diff for this record', TOOLS, []],
  ['/fields', '', 'field inspector for this table', TOOLS, []],
  ['/remote', '', 'compare this record with another instance', TOOLS, []],
  ['/tests', '', 'run ATF suites and see results', TOOLS, []],
  ['/scope', '', 'export a scope as a ZIP of scripts', TOOLS, []],
  ['/api', '[text]', 'verified API explorer (client and server)', TOOLS, []],
  ['/testclient', '', 'simulate a client script against a fake form', TOOLS, ['/bench']],
  ['/updateset', '', 'update set collisions and coverage', TOOLS, ['/updatesets']],
  ['/rest', '', 'REST request builder', TOOLS, []],
  ['/automate', '', 'navigate and click through screens', TOOLS, []],
  ['/compare', '', 'compare two instances', TOOLS, []],
  ['/script', '', 'background script runner with history', TOOLS, []],
  ['/prompts', '', 'prompt library: saved and built-in prompts', TOOLS, ['/prompt']],
  ['/snippets', '', 'code snippet library', TOOLS, ['/snippet']],
];

// Answered by Sidebar.runLocalCommand, buildAsyncCommandPrompt and handleSend.
const OTHERS = [
  ['/lint', '', 'deterministic review of the script on this form', CHECK, []],
  ['/formdiff', '', 'show unsaved form changes against the saved record', CHECK, []],
  ['/deps', '<ScriptInclude>', 'callers and callees as a dependency graph', CHECK, []],
  ['/verify', '', 'syntax, API catalog, lint and structure check of the script on this form', CHECK, []],
  ['/skills', '', 'which skill pack is active, and the agent tools', CHECK, []],
  ['/review', '', 'lint plus an AI review of the script on this form', ASK, []],
  ['/explain', '<text>', 'explain an error, log line or field', ASK, []],
  ['/generate', '<request>', 'generate a background script', ASK, []],
  ['/conflictcheck', '', 'find conflicts with existing configuration', ASK, []],
  ['/dedupe', '', 'find likely duplicate CIs in the CMDB', ASK, []],
  ['/logs', '[text]', 'triage recent instance errors', ASK, []],
  ['/trace', '<stack trace>', 'resolve a stack trace to the failing script', ASK, []],
  ['/atf', '', 'generate an ATF test outline for this record', ASK, []],
  ['/document', '', 'generate technical documentation for this record', ASK, []],
  ['/audit', '', 'security and configuration audit', ASK, []],
  ['/chat', '<text>', 'plain chat with the model, no tools', CHAT, []],
  ['/agent', 'on|off', 'turn agent mode on or off', CHAT, []],
  ['/model', '', 'show the model in use and open settings', CHAT, []],
  ['/changes', '', 'what the agent changed on this instance (undo with /undo)', CHAT, []],
  ['/undo', '', 'undo the last change the agent made', CHAT, []],
  ['/help', '', 'list every command', CHAT, []],
  ['/clear', '', 'clear the conversation', CHAT, []],
];

const GROUP_OF_PANEL = { analyze: DEBUG, tools: TOOLS };

const entry = ([verb, args, desc, group, aliases]) => ({ verb, args, desc, group, aliases: [...aliases], keywords: '' });

function panelEntry(panel) {
  const [verb, ...aliases] = panel.slash || [];
  return {
    verb,
    args: '',
    desc: panel.help || panel.hint || panel.title,
    group: GROUP_OF_PANEL[panel.group] || TOOLS,
    aliases,
    keywords: panel.keywords || '',
    title: panel.title,
    panel: panel.name,
  };
}

/** Whether the command opens a tool (harmless to run at once) rather than asking the AI or changing the chat. */
export const opensTool = (cmd) => cmd.group === DEBUG || cmd.group === TOOLS;

/**
 * The commands in menu order, plus the verbs that lost a clash.
 * @param {{name?: string, slash?: string[], help?: string, hint?: string, title?: string, group?: string, keywords?: string}[]} panels PANELS of panelRegistry.js
 * @returns {{entries: object[], shadowed: string[]}}
 */
export function resolveCatalog(panels = []) {
  const candidates = [
    ...OPEN_PANELS.map(entry),
    ...panels.filter((p) => p.slash?.length).map(panelEntry),
    ...OTHERS.map(entry),
  ];
  const claimed = new Set();
  const shadowed = [];
  const kept = [];
  candidates.forEach((cmd) => {
    if (claimed.has(cmd.verb)) {
      shadowed.push(cmd.verb);
      return;
    }
    const aliases = cmd.aliases.filter((alias) => {
      if (!claimed.has(alias)) return true;
      shadowed.push(alias);
      return false;
    });
    claimed.add(cmd.verb);
    aliases.forEach((alias) => claimed.add(alias));
    kept.push({ ...cmd, aliases });
  });
  // Stable: commands keep their order inside a group.
  const entries = GROUP_ORDER.flatMap((group) => kept.filter((cmd) => cmd.group === group));
  return { entries, shadowed };
}

export const buildCatalog = (panels) => resolveCatalog(panels).entries;

/** What to type after the verb: "/deps <ScriptInclude>". */
export const usage = (cmd) => (cmd.args ? `${cmd.verb} ${cmd.args}` : cmd.verb);

/** The verb being typed when the text is only "/word" (no space yet), else null: after a space the user is typing arguments. */
export function slashToken(text) {
  const m = /^\s*\/([^\s]*)$/.exec(String(text ?? ''));
  return m ? m[1].toLowerCase() : null;
}

const wordsOf = (text) => String(text ?? '').toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);

function rank(cmd, token) {
  const names = [cmd.verb, ...cmd.aliases].map((v) => v.slice(1).toLowerCase());
  if (names[0] === token) return 0;
  if (names.includes(token)) return 1;
  if (names[0].startsWith(token)) return 2;
  if (names.some((n) => n.startsWith(token))) return 3;
  if (names[0].includes(token)) return 4;
  // Two letters match too many descriptions ("pr" is the start of "pre-commit"): words are only searched from three.
  if (token.length >= 3 && wordsOf(`${cmd.desc} ${cmd.title || ''}`).some((w) => w.startsWith(token))) return 5;
  if (token.length >= 3 && wordsOf(cmd.keywords).includes(token)) return 6;
  return null;
}

/**
 * The commands that fit the text typed so far, best first: "/" lists all of them, "/pr" the ones whose verb starts with it, then
 * verbs that contain it, then words of the description. Empty when the text is not a bare "/word".
 * Each result is { ...command, via } where `via` is the alias that matched when it was not the main verb.
 */
export function matchCommands(catalog, text, limit = Infinity) {
  const token = slashToken(text);
  if (token === null) return [];
  if (!token) return catalog.slice(0, limit).map((cmd) => ({ ...cmd, via: '' }));
  return catalog
    .map((cmd, index) => ({ cmd, index, at: rank(cmd, token) }))
    .filter((hit) => hit.at !== null)
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .slice(0, limit)
    .map(({ cmd }) => ({ ...cmd, via: cmd.aliases.find((alias) => alias.slice(1).toLowerCase().startsWith(token) && !cmd.verb.slice(1).toLowerCase().startsWith(token)) || '' }));
}

/** The text that replaces what was typed when a command is picked. */
export const completion = (cmd) => `${cmd.verb} `;

const helpRow = (left, desc) => {
  const cmd = `  ${left}`;
  return `${cmd.padEnd(Math.max(cmd.length + 2, 26))}${desc}`;
};

/** The text of /help: one section per group, "  /verb <args>   what it does". */
export function helpText(catalog) {
  const lines = [];
  GROUP_ORDER.forEach((group) => {
    const rows = catalog.filter((cmd) => cmd.group === group);
    if (!rows.length) return;
    lines.push(group);
    rows.forEach((cmd) => {
      const also = cmd.aliases.length && !/\balso\b/i.test(cmd.desc) ? ` (also ${cmd.aliases.join(', ')})` : '';
      lines.push(helpRow(usage(cmd), `${cmd.desc}${also}`));
    });
    if (group === CHAT) lines.push(helpRow('(just type)', 'the agent reads the instance, writes, verifies and tests, and asks before changing anything'));
    lines.push('');
  });
  lines.push('Finding your way');
  lines.push(helpRow('/', 'in the box: suggestions as you type; Up and Down choose, Tab completes, Esc closes'));
  lines.push(helpRow('Command palette', 'type / there for the navigation shortcuts: /tn incident, /br name, /sys <sys_id>, /sa, /su and more'));
  return lines.join('\n');
}
