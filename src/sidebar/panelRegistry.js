// Feature panels that plug into the sidebar, the command palette and /help
// without editing Sidebar.jsx, commands.js or mount.js. Add one entry per panel.
//
// An entry is:
//   name         unique panel id
//   title        shown in the launcher, the palette and /help
//   hint         one line under the title (palette, /help)
//   launcherHint optional shorter hint for the launcher tile, which fits about 25 characters
//   icon         an Icon name from src/sidebar/Icon.jsx
//   slash        slash commands that open it, e.g. ['/access', '/why']; the text after the
//                command is passed to the panel as params.args
//   help         optional usage text for /help (defaults to hint)
//   keywords     extra palette search words
//   group        palette group key from GROUPS in src/content/commands.js (default 'tools')
//   withContext  true to snapshot the page context when the panel opens (panel gets `context`)
//   launcher     true to show a tile in the sidebar's empty-state tool grid
//   component    React component. Props: { context, params, services, onClose, onAskAi(label, prompt),
//                onUseScript(code), onInsert(text) }. `services` holds the content-side functions
//                registered in src/content/featureServices.js plus the built-in ones.
//
// Content-side data access for a panel goes in src/content/featureServices.js.

import AccessDebuggerPanel from './AccessDebuggerPanel.jsx';
import { MY_WORK_PANELS } from './MyWorkPanel.jsx';
import HealthScanPanel from './HealthScanPanel.jsx';
import ImpactPanel from './ImpactPanel.jsx';
import XrayPanel from './XrayPanel.jsx';

export const PANELS = [
  {
    name: 'access',
    title: 'Access debugger',
    hint: "Why can't a user see or edit this? Roles, ACLs and query rules",
    launcherHint: 'Why a user cannot see it',
    icon: 'lock',
    slash: ['/access', '/why'],
    help: "why a user can or can't read/write this (also /why <user> write <field>)",
    keywords: 'acl acls security role roles permission permissions access denied why cannot see edit read write user debug',
    group: 'analyze',
    withContext: true,
    launcher: true,
    component: AccessDebuggerPanel,
  },
];

// My work (/mywork), Ship check (/ship), Push to instance (/push): src/sidebar/MyWorkPanel.jsx.
PANELS.push(...MY_WORK_PANELS);

// Instance health and upgrade-readiness scan (/health, /scan): src/sidebar/HealthScanPanel.jsx.
PANELS.push({
  name: 'health',
  title: 'Health scan',
  hint: 'Custom code and config: quality, anti-patterns, upgrade risks, security',
  launcherHint: 'Quality, upgrade, security',
  icon: 'pulse',
  slash: ['/health', '/scan'],
  help: 'scan custom code and config (also /scan 14 = changed in the last 14 days, /scan <app> = one app)',
  keywords: 'health scan instance scan upgrade readiness technical debt anti-pattern antipattern best practice lint audit quality review custom code',
  group: 'analyze',
  launcher: true,
  component: HealthScanPanel,
});

// Page X-ray (/xray): what is on the page and what controls it: src/sidebar/XrayPanel.jsx, src/content/xray.js.
PANELS.push({
  name: 'xray',
  title: 'Page X-ray',
  hint: 'Fields, columns, variables and widgets on this page, and the logic behind each',
  launcherHint: 'What controls each field',
  icon: 'xray',
  slash: ['/xray'],
  help: 'what controls each field on this page (also /xray <field>); Alt+Shift+X marks up the page',
  keywords: 'xray x-ray inspect field why read only readonly mandatory hidden ui policy client script business rule data policy widget portal catalog variable list columns sys_id',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: XrayPanel,
});

// Change impact (/impact): who uses a script, what it changes, what runs as a result:
// src/sidebar/ImpactPanel.jsx, src/content/impact.js, src/lib/impact.js.
PANELS.push({
  name: 'impact',
  title: 'Change impact',
  hint: 'Before you edit a script: who uses it, what it changes, what runs as a result, who else is editing it',
  launcherHint: 'What a script change affects',
  icon: 'layers',
  slash: ['/impact'],
  help: 'what changing the script on this form affects (also /impact <ScriptInclude>)',
  keywords: 'impact blast radius dependencies callers who uses where used references side effects downstream business rule script include change risk retest regression update set collision',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: ImpactPanel,
});

export function panelByName(name) {
  return PANELS.find((p) => p.name === name) || null;
}

export function panelForSlash(command) {
  return PANELS.find((p) => (p.slash || []).includes(command)) || null;
}

/** /help lines for the registered panels, aligned like the built-in list. */
export function panelHelpLines() {
  return PANELS.flatMap((p) => (p.slash || []).slice(0, 1).map((cmd) => `  ${cmd.padEnd(23)}${p.help || p.hint || p.title}`));
}
