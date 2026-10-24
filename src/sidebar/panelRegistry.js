// Feature panels that plug into the sidebar, the command palette, the "/" suggestions and /help
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
import FieldUsagePanel from './FieldUsagePanel.jsx';
import RecordComparePanel from './RecordComparePanel.jsx';
import FieldHistoryPanel from './FieldHistoryPanel.jsx';
import SaveTracePanel from './SaveTracePanel.jsx';
import HotspotsPanel from './HotspotsPanel.jsx';
import FailuresPanel from './FailuresPanel.jsx';
import TestKitPanel from './TestKitPanel.jsx';
import XrayPanel from './XrayPanel.jsx';
import WhyRulePanel from './WhyRulePanel.jsx';
import RecentChangesPanel from './RecentChangesPanel.jsx';
import ReleaseNotesPanel from './ReleaseNotesPanel.jsx';
import TestDataPanel from './TestDataPanel.jsx';
import InsightPanel from './InsightPanel.jsx';
import RefGraphPanel from './RefGraphPanel.jsx';
import ClientTracePanel from './ClientTracePanel.jsx';
import NotifyPanel from './NotifyPanel.jsx';
import ProcessPanel from './ProcessPanel.jsx';
import PropertiesPanel from './PropertiesPanel.jsx';
import DataModelPanel from './DataModelPanel.jsx';
import PortalPanel from './PortalPanel.jsx';
import PreviewProblemsPanel from './PreviewProblemsPanel.jsx';
import DoctorPanel from './DoctorPanel.jsx';

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

// Where is this field used? (/usage incident.state): scripts that set, read or query a field, and the policies, ACLs and
// rules that control it: src/sidebar/FieldUsagePanel.jsx, src/content/fieldUsage.js, src/lib/fieldUsage.js.
PANELS.push({
  name: 'fieldusage',
  title: 'Where is this field used?',
  hint: 'Every script that sets, reads or queries a field, and the UI policies, ACLs and rules that control it',
  launcherHint: 'Who sets or reads a field',
  icon: 'search',
  slash: ['/usage', '/field'],
  help: 'where a field is used: scripts that set or read it, policies, ACLs (also /usage incident.state)',
  keywords: 'field usage where is this field used who sets this field who writes this field who changes the value what sets state what reads this column references find usages of a field ui policy acl data policy business rule client script dictionary override remove a field safely',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: FieldUsagePanel,
});

// Compare two records (/vs INC0010002): the record on screen against another of the same table, field by field:
// src/sidebar/RecordComparePanel.jsx, src/content/recordCompare.js, src/lib/recordCompare.js.
PANELS.push({
  name: 'recordcompare',
  title: 'Compare with another record',
  hint: 'Why does this record work and that one not? Every field that differs between two records of the same table',
  launcherHint: 'Two records, field by field',
  icon: 'layers',
  slash: ['/vs', '/diff'],
  help: 'compare this record with another of the same table (also /vs INC0010002, a sys_id or a name)',
  keywords: 'compare two records diff difference between records why does this one work and that one not which fields differ side by side compare tickets compare users compare cis compare business rules working vs broken',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: RecordComparePanel,
});

// Who changed this value? (/history state): one field of the record on screen as a timeline from the audit trail:
// src/sidebar/FieldHistoryPanel.jsx, src/content/fieldHistory.js, src/lib/fieldHistory.js.
PANELS.push({
  name: 'fieldhistory',
  title: 'History of a field',
  hint: 'Who changed this value, when, and how long each value stayed. Spots values that keep bouncing back',
  launcherHint: 'Who changed this value',
  icon: 'clock',
  slash: ['/history', '/changes'],
  help: 'every change to one field of this record (also /history state)',
  keywords: 'field history who changed this value when did the state change audit trail timeline who set assignment group changed how long in state bounced flipped back automation fighting sys_audit what changed this field',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: FieldHistoryPanel,
});

// What went wrong recently? (/failed): failed email, flows, overdue jobs, integration errors, import rows, events:
// src/sidebar/FailuresPanel.jsx, src/content/failures.js, src/lib/failures.js.
PANELS.push({
  name: 'failures',
  title: 'What went wrong?',
  hint: 'Failed email, flows, overdue jobs, integration errors, import rows and events: what the system log does not show',
  launcherHint: 'Failures beyond the log',
  icon: 'alert',
  slash: ['/failed', '/wrong'],
  help: 'failed email, flows, jobs, integrations, imports and events in the last hour, day or week',
  keywords: 'what went wrong failures failed error errors email not sent flow failed integration error rest outbound mid server ecc queue import failed import set row job did not run scheduled job stuck overdue events stuck triage',
  group: 'analyze',
  withContext: false,
  launcher: true,
  component: FailuresPanel,
});

// What is slow or noisy? (/hotspots): slowest requests, jobs, log and event noise, record churn:
// src/sidebar/HotspotsPanel.jsx, src/content/hotspots.js, src/lib/hotspots.js.
PANELS.push({
  name: 'hotspots',
  title: 'Hot spots',
  hint: 'What is slow and what is noisy: slow pages and queries, jobs, repeating log messages, busy events, records changed again and again',
  launcherHint: 'What is slow or noisy',
  icon: 'bolt',
  slash: ['/hotspots', '/slow'],
  help: 'slow requests, jobs and queries, noisy logs, events and records for the last 15 minutes to 7 days',
  keywords: 'hot spots slow noisy performance slow page slow query slow transaction response time sql too many logs log spam noisy job event queue outbound churn audit most changed busiest users slowest',
  group: 'analyze',
  withContext: false,
  launcher: true,
  component: HotspotsPanel,
});

// What changed lately? (/recent): configuration changes by anyone, grouped, with the version diff one click away:
// src/sidebar/RecentChangesPanel.jsx, src/content/recentChanges.js, src/lib/recentChanges.js.
PANELS.push({
  name: 'recent',
  title: 'What changed lately?',
  hint: 'Configuration changes by anyone in the last hour, today or this week: who, what, which update set, and a diff',
  launcherHint: 'Who changed what, lately',
  icon: 'refresh',
  slash: ['/recent', '/lately'],
  help: 'configuration changes by anyone, newest first, with new-since-you-looked and a diff (also /recent)',
  keywords: 'recent changes what changed lately who broke it what did others change since yesterday update sets versions diff team colleagues somebody changed',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: RecentChangesPanel,
});

// Release notes (/release): an update set as notes for a ticket, with risks, testing and backout:
// src/sidebar/ReleaseNotesPanel.jsx, src/content/releaseNotes.js, src/lib/releaseNotes.js.
PANELS.push({
  name: 'releasenotes',
  title: 'Release notes',
  hint: 'An update set as release notes: what changed, what is risky, what to test, how to back out. Copy into the ticket',
  launcherHint: 'Update set to ticket text',
  icon: 'book',
  slash: ['/release', '/notes'],
  help: 'release notes for an update set (also /release <update set sys_id>)',
  keywords: 'release notes change summary update set what is in this update set changelog ticket change request pull request testing notes backout deployment checklist',
  group: 'analyze',
  launcher: true,
  component: ReleaseNotesPanel,
});

// What happened when I saved? (/savetrace): arm, save, collect one timeline of what the save caused:
// src/sidebar/SaveTracePanel.jsx, src/content/saveTrace.js, src/lib/saveTrace.js.
PANELS.push({
  name: 'savetrace',
  title: 'Save trace',
  hint: 'What happened when I saved: field changes, logs, update set, events, emails, flows, SLAs in one timeline',
  launcherHint: 'What a save did, in order',
  icon: 'clock',
  slash: ['/savetrace', '/trace'],
  help: 'arm, save the record, collect what the save caused (also /savetrace arm)',
  keywords: 'save trace what happened when i saved debug on save timeline business rules ran log transaction audit update set events emails flow sla approval sys_audit syslog why did my save fail what did the save do',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: SaveTracePanel,
});

// Test data (/testdata): realistic sample records, previewed first, created one by one behind a confirmation on
// dev/test/stage only, and cleaned up from a journal: src/sidebar/TestDataPanel.jsx, src/content/testData.js,
// src/lib/testData.js.
PANELS.push({
  name: 'testdata',
  title: 'Test data',
  hint: 'Create sample incidents, users, groups or CIs (preview first, dev/test only), then clean them up again',
  launcherHint: 'Sample records, then clean up',
  icon: 'database',
  slash: ['/testdata'],
  help: 'make sample records, then remove them (also /testdata incident 10, /testdata cleanup)',
  keywords: 'test data sample data dummy records fake users generate create many incidents seed data populate dev instance cleanup remove test records bulk',
  group: 'tools',
  withContext: false,
  launcher: true,
  component: TestDataPanel,
});

// Why did (or didn't) my rule run? (/rules): every business rule, client script, UI policy, data policy and ACL that
// could apply to the record on screen, with the first thing that stops each one:
// src/sidebar/WhyRulePanel.jsx, src/content/ruleExplain.js, src/lib/ruleExplain.js.
PANELS.push({
  name: 'whyrule',
  title: "Why didn't my rule run?",
  hint: 'For the record on screen: which business rules, client scripts, UI policies, data policies and ACLs would run, and what stops the rest',
  launcherHint: 'Why a rule did or did not fire',
  icon: 'search',
  slash: ['/rules', '/whyrule'],
  help: 'why each rule did or did not run for this record (also /rules <rule name>)',
  keywords: 'why did my rule not run fire trigger business rule client script ui policy data policy acl condition inactive wrong table wrong operation order role filter condition debug',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: WhyRulePanel,
});

// Break this list down (/breakdown): counts per value or per day / week / month, click a bar to filter the list:
// src/sidebar/InsightPanel.jsx, src/content/insight.js, src/lib/insight.js.
PANELS.push({
  name: 'insight',
  title: 'Break this list down',
  hint: 'Counts per value of any column, or over time; click a bar to filter the list to it',
  launcherHint: 'Counts per column or per day',
  icon: 'table',
  slash: ['/breakdown', '/insight'],
  help: 'count the list on screen by a column or over time (also /breakdown <column>)',
  keywords: 'break down breakdown group by count per column distribution how many by state priority group chart over time per day week month trend histogram pivot aggregate statistics',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: InsightPanel,
});

// What points at this record? (/refs): references to the record, what a delete would do, what it points at:
// src/sidebar/RefGraphPanel.jsx, src/content/insight.js, src/lib/refGraph.js.
PANELS.push({
  name: 'refs',
  title: 'What points at this record?',
  hint: 'Every record and field that references this one, what deleting it would do, and what it points at',
  launcherHint: 'Who uses this record',
  icon: 'layers',
  slash: ['/refs', '/references'],
  help: 'what references the record on screen and what a delete would do to them',
  keywords: 'references referenced by used by who uses this record can i delete this safe to delete dependencies reference graph relationships cmdb parents children cascade orphan user group',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: RefGraphPanel,
});

// Testing kit (/test): run the script on screen against a record, unit tests for a Script Include, ATF finder, snapshots,
// access matrix, checklist: src/sidebar/TestKitPanel.jsx, TestKitMore.jsx, src/content/testKit.js, src/lib/testKit.js.
PANELS.push({
  name: 'testkit',
  title: 'Test',
  hint: 'Run a script against a record, write unit tests, find ATF coverage, snapshot and compare, who can access it',
  launcherHint: 'Run, unit test, snapshot, ATF',
  icon: 'flask',
  slash: ['/test', '/tests'],
  help: 'testing tools (also /test run | unit | atf | snapshot | access | checklist)',
  keywords: 'test testing run script against record dry run unit test script include assert atf coverage snapshot compare before after diff acl matrix who can access checklist qa verify regression pretend changed',
  group: 'tools',
  withContext: true,
  launcher: true,
  component: TestKitPanel,
});

// ---- Batch added 2026-10-23. Each entry is owned by one feature; edit your own only. ----

// Client trace (/watch): what the page's scripts did to the form, in order: src/sidebar/ClientTracePanel.jsx,
// src/content/clientTrace.js, src/lib/clientTrace.js, src/page/recorder.js.
PANELS.push({
  name: 'clienttrace',
  title: 'Client trace',
  hint: 'Record what client scripts do to the form: every field change, GlideAjax call, error and delay, in order, with the script behind it',
  launcherHint: 'What the page scripts did',
  icon: 'record',
  slash: ['/watch', '/clienttrace'],
  help: 'record g_form changes, GlideAjax calls and errors on the form (arm it, reload the form, read the timeline)',
  keywords: 'client trace watch recorder flight recorder who changed this field on the form g_form setvalue setmandatory glideajax client script onchange onload slow form console error javascript error what set this value why did the field change',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: ClientTracePanel,
});

// Why wasn't the email sent? (/notify): notifications that match the record, the events and emails it produced:
// src/sidebar/NotifyPanel.jsx, src/content/notifyTrace.js, src/lib/notifyTrace.js.
PANELS.push({
  name: 'notify',
  title: "Why wasn't the email sent?",
  hint: 'For the record on screen: which notifications could fire, what stops each one, the events and emails it produced and their recipients',
  launcherHint: 'Why an email did not go out',
  icon: 'mail',
  slash: ['/notify', '/whymail'],
  help: 'why an email was or was not sent for this record (also /notify <notification name>)',
  keywords: 'notification email not sent why did nobody get the email notification did not fire event not fired recipients subscription condition advanced condition sys_email outbox ignored send ready failed mail trace email log digest',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: NotifyPanel,
});

// Flows, approvals and SLAs (/flows): everything running or run against the record on screen:
// src/sidebar/ProcessPanel.jsx, src/content/processView.js, src/lib/processView.js.
PANELS.push({
  name: 'process',
  title: 'Flows, approvals and SLAs',
  hint: 'Every flow, workflow, approval, SLA and task attached to the record on screen: state, timing, errors and who it is waiting on',
  launcherHint: 'What is running on this record',
  icon: 'flow',
  slash: ['/flows', '/process'],
  help: 'flows, workflows, approvals and SLAs on this record, with errors and who is blocking',
  keywords: 'flow designer flow execution workflow context approval waiting sla breached task process stuck waiting for approval flow error what is running on this record why is this ticket stuck who has to approve workflow history',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: ProcessPanel,
});

// System properties (/prop): find, read, change and trace a property: src/sidebar/PropertiesPanel.jsx,
// src/content/properties.js, src/lib/properties.js.
PANELS.push({
  name: 'properties',
  title: 'System properties',
  hint: 'Find a property, see its value and where scripts read it, change it with an undo, and compare it with the defaults',
  launcherHint: 'Find, read, change a property',
  icon: 'sliders',
  slash: ['/prop', '/property'],
  help: 'look up a system property, who reads it, change it with undo (also /prop glide.ui.session_timeout)',
  keywords: 'system property sys_properties glide property value setting config gs getproperty who reads this property where is this property used change a property debug property glide ui timeout switch flag',
  group: 'tools',
  withContext: false,
  launcher: true,
  component: PropertiesPanel,
});

// Data model map (/map): how tables extend and reference each other, and the dot-walk path between two:
// src/sidebar/DataModelPanel.jsx, src/content/dataModel.js, src/lib/dataModel.js.
PANELS.push({
  name: 'datamodel',
  title: 'Data model map',
  hint: 'How a table connects to the others: parents, children, what it references and what references it. Find the dot-walk path between two tables',
  launcherHint: 'Tables and how they connect',
  icon: 'graph',
  slash: ['/map', '/dotwalk', '/path', '/schema'],
  help: "map a table's relationships (also /map incident, /path incident sys_user for a dot-walk path)",
  keywords: 'data model schema map er diagram entity relationship table relationships extends parent child reference fields dot walk dotwalk path how do i get from incident to department join tables many to many cmdb hierarchy table tree',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: DataModelPanel,
});

// Portal inspector (/sp): widgets on a Service Portal page with their data, options and code:
// src/sidebar/PortalPanel.jsx, src/content/portalInspector.js, src/lib/portalInspector.js.
PANELS.push({
  name: 'portal',
  title: 'Portal inspector',
  hint: 'Widgets on this Service Portal page: name, instance options, the data each one holds, and a link to its code',
  launcherHint: 'Widgets, data and options',
  icon: 'window',
  slash: ['/sp', '/portal', '/widgets'],
  help: 'widgets on this portal page with their c.data, options and code (also /sp <widget name>)',
  keywords: 'service portal widget inspector sp widget c.data options angular scope widget editor server script client controller portal page widget instance which widget is this debug widget data json employee center esc',
  group: 'analyze',
  withContext: false,
  launcher: true,
  component: PortalPanel,
});

// Update set preview problems (/preview): what blocks a commit, in plain words, and what to do about each:
// src/sidebar/PreviewProblemsPanel.jsx, src/content/previewProblems.js, src/lib/previewProblems.js.
PANELS.push({
  name: 'previewfix',
  title: 'Update set preview problems',
  hint: 'A retrieved update set that will not commit: each preview problem in plain words, the local record behind it, and the safe way out',
  launcherHint: 'Why an update set will not commit',
  icon: 'alert',
  slash: ['/preview', '/problems'],
  help: 'explain the preview problems of an update set before you commit it (also /preview <update set name>)',
  keywords: 'update set preview problems commit blocked missing reference collision skipped remote update newer local version accept remote skip remote update set problem cannot commit retrieved update set preview',
  group: 'analyze',
  withContext: true,
  launcher: true,
  component: PreviewProblemsPanel,
});

// Self-check (/doctor): which NowBuddy tools will work on this instance, from what it can read: src/sidebar/DoctorPanel.jsx,
// src/content/doctor.js, src/lib/requirements/.
PANELS.push({
  name: 'doctor',
  title: 'Self-check',
  hint: 'Which NowBuddy tools work on this instance: your session, the tables and columns each one reads, and what to do about a gap',
  launcherHint: 'Which tools work here',
  icon: 'stethoscope',
  slash: ['/doctor', '/selfcheck'],
  help: 'check that NowBuddy can reach this instance and which tools have what they need (copyable report)',
  keywords: 'doctor self check diagnose troubleshoot not working extension broken why does this tool show nothing missing table missing column permission session expired version release compatibility report support',
  group: 'tools',
  withContext: false,
  launcher: false,
  component: DoctorPanel,
});

export function panelByName(name) {
  return PANELS.find((p) => p.name === name) || null;
}

export function panelForSlash(command) {
  return PANELS.find((p) => (p.slash || []).includes(command)) || null;
}
