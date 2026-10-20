// Search the command palette by the problem you have, not by the name of the tool.
//
// Developers type "who changed this" or "why can't they see it", not "Record versions" or "Access debugger".
// INTENTS maps a command id to the plain phrases a developer would use for the job; the palette adds them to
// the text a query is matched against. Word matching (wordsScore) lets a few of those words in any order find it.

export const INTENTS = {
  // Understand a record or a form
  'record.similar': 'find similar tickets related incidents has this happened before duplicates of this record same problem other tickets like this',
  'record.versionDiff': 'who changed this what changed previous version revert undo a change history of changes compare versions before and after',
  'record.history': 'who changed this field audit trail when was it changed history log of changes',
  'record.info': 'who created this when was it last updated how many updates owner',
  'record.updateEntry': 'is this in my update set was it captured why is it not in the update set deployment xml of the change',
  'record.remote': 'difference between dev and prod same record on another instance compare environments does test match',
  'record.copySysId': 'get the id guid identifier of this record',
  'record.xml': 'view every field value raw record data export payload',
  'table.fields': 'what fields does this table have column names choice values table schema data dictionary table structure types references',
  'tools.technicalNames': 'show database field names backend column name what is the field called api name',
  'tools.fieldNameTip': 'get the name of a field copy column name for a script',
  // Find and check code
  'analyze.search': 'where is this text or word used find text in scripts search all scripts grep find a string find a table name in code',
  'panel.failures': 'what went wrong recently errors failures failed email was not sent email did not send flow failed flow errored integration error rest call failed outbound call failed mid server ecc queue error import failed import set rows error job did not run scheduled job stuck overdue event stuck in error',
  'panel.hotspots': 'what is slow or noisy slow page slow query slow request slow transaction slow job too many logs noisy log noisy job log spam busiest users most changed records performance hot spots why is the instance slow',
  'panel.recent': 'what changed lately who broke it what did others change what did my colleagues change recent changes by anyone since yesterday who touched this who changed the configuration in the last hour what changed today on the instance',
  'panel.releasenotes': 'release notes change summary what is in this update set generate release notes for the ticket changelog testing notes backout plan write up this update set',
  'panel.savetrace': 'what happened when i saved what did my save do what ran when i clicked save trace the save debug on save timeline of the save business rules that fired what was logged why did saving fail',
  'savetrace.arm': 'trace the next save arm the save trace before i save record watch what happens when i press update submit',
  'panel.testdata': 'create test data sample data dummy data fake users sample records make ten incidents generate test records populate my dev instance seed data bulk create test incidents test users test groups test cis',
  'testdata.cleanup': 'clean up test data remove my test records delete the sample data i created undo test data remove dummy records fake users cleanup',
  'panel.refs': 'can i delete this record is it safe to delete what points at this record who references this record what uses this user what uses this group what is linked to this record orphan records cascade delete cmdb relationships',
  'panel.insight': 'break this list down how many per state count by priority group by assignment group distribution of tickets over time per day per week trend chart histogram pivot statistics',
  'panel.impact':'where is this used what breaks if i change this where is this script include used who calls this find usages references callers dependencies blast radius',
  'analyze.lint': 'is my script correct check for errors find bugs before saving code quality static analysis',
  'tools.verify': 'is my script correct check for errors made up methods hallucinated api syntax check before saving',
  'ai.review': 'review my code is this secure best practices second opinion',
  'tools.newUpdateSet': 'start a new update set create an update set for my story my changes are going to default stop using default name an update set for this ticket',
  'record.versions': 'see older versions of this script restore an old version go back to previous script version list of versions',
  'record.copyRest': 'call this record from postman curl rest api endpoint url for an integration get this record over rest table api',
  'record.copyGlide': 'load this record in a script gliderecord code for this record get it by sys id start a background script',
  'record.copyJson': 'copy all the field values json dump this record data for a bug report or test data payload',
  'record.copyUrl': 'share a link to this record send the url to a colleague link for a ticket',
  'record.copyMarkdown': 'paste a link in a pull request or chat markdown link for documentation',
  'form.hidden': 'a field is missing from the form where did the field go hidden fields what is hiding this field the field disappeared a ui policy hid it unhide reveal every field',
  'form.highlight': 'which fields are mandatory required read only fields which ones can i not edit outline the fields on the form',
  'form.copyValues': 'copy all the field values as json from the form test data for a bug report',
  'form.copyMarkdown': 'put the record field values in a table for a ticket or chat markdown table of the fields',
  'form.copyScript': 'make a script from this record create a record from a script setvalue gliderecord insert with these values test data script',
  'form.duplicate': 'duplicate this record clone it copy it into a new record create a similar record start from this one',
  'record.openJson': 'see the record as json rest api response table api output in the browser',
  'analyze.formdiff': 'what did i modify on the form before saving unsaved changes dirty fields modified values',
  'ai.atf': 'write a test for this automated test plan test steps for this change create atf test',
  'tools.atf': 'did my automated tests pass run test suite atf results regression tests',
  'tools.bookmark': 'save this page for later favourite this record keep a shortcut to this page',
  'tools.automate': 'repeat browser steps record clicks automate a manual task script the browser',
  'analyze.xrayToggle': 'show what controls each field on this form ui policy client script acl overlay annotate fields',
  'instance.xmlstats': 'how big is the database row counts table sizes xml statistics',
  'tools.api': 'how do i use gliderecord method signature what does this method do g_form methods api reference documentation',
  'tools.editor': 'edit the script in a bigger editor full screen find and replace in a script edit code',
  'tools.fileSync': 'edit in vs code use my own editor external editor sync to a file',
  'ai.document': 'write docs explain what this script does comment this document the script',
  // Run and debug
  'tools.background': 'run a script test glide code run a query now execute server script quick test try gs log',
  'tools.testbench': 'test my client script try an onchange simulate the form try g_form without saving',
  'analyze.logTail': 'watch the logs see errors live debug a server script gs log output tail the log what is failing',
  'ai.logs': 'why are there errors explain this error what is failing triage the log',
  'tools.rest': 'call an api test rest request table api curl postman try an endpoint http',
  'analyze.listTools': 'explain this filter what does this query mean copy the encoded query count records export csv glide record code for this list',
  // Access and users
  'panel.access': "why can't a user see this record permission denied cannot edit acl blocking role missing 403 hidden record why is it read only for them",
  'tools.impersonate': 'test as another user log in as someone see what they see impersonate',
  'tools.endImpersonation': 'stop impersonating go back to my user log out of impersonation',
  'panel.xray': 'why is this field read only why is it mandatory why hidden what changes this field which script sets the value ui policy client script business rule on this form',
  // Ship it
  'panel.shipcheck': 'is my update set safe to move before deploying ready to ship check my update set release checklist missing dependencies',
  'panel.push': 'move my changes to another instance deploy to test promote to prod send an update set push my change',
  'panel.mywork': 'what did i change my update sets my changes today current update set uncommitted work what am i working on',
  'analyze.updateset': 'review the update set check for collisions what is in my update set before committing',
  'tools.switchUpdateSet': 'change update set pick the current update set wrong update set switch to another update set',
  'tools.scopeExport': 'export the app to git download all scripts code review offline zip of a scope',
  'analyze.compare': 'difference between dev and prod compare two instances does test match prod',
  'analyze.conflict': 'will this clash with another change duplicate rules order conflict',
  // The instance
  'panel.health': 'is my instance healthy upgrade ready find bad scripts code quality anti patterns technical debt before an upgrade',
  'instance.switch': 'open this page on another instance go to prod go to test go to dev switch environment change instance same page on prod',
  'instance.cache': 'my change is not showing clear the cache stale refresh the instance flush',
  'instance.threads': 'the instance is slow performance stuck hung transaction what is running',
  'instance.stats': 'the instance is slow performance memory node health build version',
  'instance.nodeInfo': 'which node am i on build version release patch',
  // Helpers
  'help.guide': 'what can this do show me everything list of features cheat sheet shortcuts keys what should i try recipes learn the tools',
  'help.tour': 'how do i use this what can this do getting started tutorial help show me around new here',
  'ai.chat': 'ask a question help assistant talk to the ai',
  'ai.snippets': 'example code how do i write a gliderecord query date example rest snippet template',
  'ai.prompts': 'saved prompts templates for the ai',
  'analyze.audit': 'security check public access risky acl who can read',
  'tools.theme.toggle': 'dark mode light mode night theme colors',
  'tools.fieldNames.toggle': 'show the technical names of the fields database names column names what is the field called label vs name',
  'tools.list.tsv': 'paste these rows into excel a spreadsheet google sheets copy the list as a table for a spreadsheet',
  'tools.list.markdown': 'put these rows in a ticket a wiki a pull request as a markdown table',
  'tools.list.json': 'give me these rows as json test data array of objects',
  'tools.list.sysids': 'i need the sys ids of these records for a script comma separated list in clause',
  'tools.list.openSelected': 'open all the ticked records at once review several records in tabs',
  'tools.list.link': 'send someone this exact filtered list share a link to this list and filter',
  'tools.smartSelect': 'decode what i selected pretty print the selected json base64 jwt token timestamp epoch what is this text',
  'tools.list.dynamic': 'make the filter dynamic relative dates last 7 days instead of fixed dates use today me current user keep the filter correct tomorrow static to dynamic',
  'tools.list.dynamicCopy': 'copy the filter as a dynamic query for a report or script relative dates current user',
  'tools.new': 'start a new business rule script include client script ui action scheduled job fix script rest resource from a template boilerplate scaffold starter code create',
  'panel.whyrule': "why didnt my rule run why did my business rule not fire not trigger didnt fire didnt execute why did my client script ui policy data policy not apply acl condition not met inactive wrong table wrong operation insert update which rules run on this record what stops my rule",
  'panel.testkit': 'test my change how do i test this testing tools qa verify regression what should i test checklist of things to test run unit atf snapshot access in one place',
  'test.run': 'run this against a record try this business rule on a real record dry run the script with current and previous test my rule against an incident pretend the state changed see what it would write what would this script do to this record',
  'test.unit': 'write a unit test for this script include generate tests assert the methods test every method of a script include unit tests with assertions',
  'test.atf': 'which atf tests cover this table or script include find automated tests that exercise it last atf results run the test suite for it atf coverage',
  'test.access': 'who can access this who can read write delete this record compare users side by side acl matrix which users can see this field role check for several users',
  'test.snapshot': 'snapshot this before i test save the state of the record or list baseline take a snapshot before a change',
  'test.compare': 'compare with the snapshot what changed since the snapshot what did my test change what did that script do difference before and after',
  'tools.inline.toggle': 'hide the buttons on the page turn off the toolbar page tools too much clutter',
};

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'to', 'of', 'my', 'this', 'that', 'it', 'in', 'on', 'for', 'and', 'or', 'i', 'do', 'how', 'what', 'why',
  'can', 'cant', 'cannot', 'does', 'with', 'me', 'we', 'you', 'they', 'them', 'there', 'not', 'be', 'as', 'at', 'by', 'from', 'if', 'so',
]);

/** The words of a query that carry meaning: lower case, no filler like "the", "is" or "why". */
export function queryWords(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/'/g, '')
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/**
 * Score for a multi-word query against a command's text: every meaningful word must appear (in any order).
 * Words in the title count extra. 0 when any word is missing, or when the query has fewer than two words
 * (a single word is handled by the ordinary substring and fuzzy match).
 */
export function wordsScore(query, title, rest = '') {
  const words = queryWords(query);
  if (words.length < 2) return 0;
  const head = String(title || '').toLowerCase();
  const tail = `${head} ${String(rest || '').toLowerCase()}`;
  if (!words.every((word) => tail.includes(word))) return 0;
  const inTitle = words.filter((word) => head.includes(word)).length;
  return 300 + inTitle * 40;
}

/** The extra search text for a command id ('' when none). */
export const intentText = (id) => INTENTS[id] || '';
