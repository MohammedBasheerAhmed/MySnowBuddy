const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildCatalog,
  resolveCatalog,
  matchCommands,
  slashToken,
  completion,
  helpText,
  usage,
  opensTool,
  GROUP_ORDER,
} = require('../src/lib/slashCatalog.js');

// The real registry: every panel that has a slash command.
const { PANELS } = require('../src/sidebar/panelRegistry.js');
const catalog = buildCatalog(PANELS);
const verbs = (list) => list.map((c) => c.verb);

test('every registered panel with a slash command is in the catalog under its first command', () => {
  PANELS.filter((p) => p.slash?.length).forEach((p) => {
    const cmd = catalog.find((c) => c.verb === p.slash[0]);
    assert.ok(cmd, `${p.name}: ${p.slash[0]} is missing from the suggestions (another command claims it?)`);
    assert.equal(cmd.panel, p.name);
  });
});

test('no verb or alias is listed twice, and every verb starts with a slash', () => {
  const all = catalog.flatMap((c) => [c.verb, ...c.aliases]);
  assert.equal(new Set(all).size, all.length, 'a verb is offered by two commands');
  all.forEach((v) => assert.match(v, /^\/[a-z][a-z0-9_-]*$/, `${v} is not a plain slash verb`));
});

test('every command has a description and a known group', () => {
  catalog.forEach((c) => {
    assert.ok(c.desc && c.desc.length > 5, `${c.verb} has no description`);
    assert.ok(GROUP_ORDER.includes(c.group), `${c.verb}: unknown group ${c.group}`);
  });
  // The groups come out in menu order.
  const order = catalog.map((c) => GROUP_ORDER.indexOf(c.group));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('a clash is won by the command Sidebar.handleSend tries first, and the loser is left out', () => {
  const panels = [{ name: 'mine', slash: ['/mine', '/lint', '/tail'], help: 'my panel', group: 'analyze' }];
  const { entries, shadowed } = resolveCatalog(panels);
  // /tail opens a built-in panel before registered panels are tried, so the registered panel loses it; /lint is answered
  // after the registered panels, so there the panel wins and the sidebar's own /lint is the one left out.
  assert.deepEqual(entries.find((c) => c.verb === '/mine').aliases, ['/lint']);
  assert.deepEqual(shadowed.sort(), ['/lint', '/tail']);
  assert.equal(entries.filter((c) => c.verb === '/lint').length, 0, 'no second /lint entry');
  assert.equal(entries.filter((c) => c.verb === '/tail').length, 1);
});

test('a command that can never run is not advertised', () => {
  // Found while building the list: the save trace panel claims /trace and the field history panel claims /changes, so the
  // older "/trace <stack trace>" and the agent's "/changes" are never reached. Each verb is offered once, by the one that runs.
  const by = (v) => catalog.find((c) => c.verb === v);
  assert.ok(by('/savetrace').aliases.includes('/trace'));
  assert.ok(by('/history').aliases.includes('/changes'));
  assert.equal(by('/trace'), undefined, 'no separate stack-trace entry');
  assert.equal(by('/changes'), undefined, 'no separate agent-changes entry');
  // (The test kit's /tests alias also loses to the ATF panel's /tests, which was already the documented meaning.)
  assert.deepEqual(resolveCatalog(PANELS).shadowed.sort(), ['/changes', '/tests', '/trace']);
});

test('slashToken: only a bare /word is a command being typed', () => {
  assert.equal(slashToken('/'), '');
  assert.equal(slashToken('/Lin'), 'lin');
  assert.equal(slashToken('  /lint'), 'lint');
  assert.equal(slashToken('/lint '), null, 'after a space the user is typing arguments');
  assert.equal(slashToken('/tn incident'), null);
  assert.equal(slashToken('hello /lint'), null);
  assert.equal(slashToken(''), null);
  assert.equal(slashToken(undefined), null);
});

test('a lone "/" lists every command, grouped', () => {
  // No cap: a lone "/" must reach the last command (/clear, /help), however many tools are registered.
  const all = matchCommands(catalog, '/');
  assert.equal(all.length, catalog.length);
  assert.deepEqual(verbs(all), verbs(catalog));
  assert.ok(all.length >= 40, 'the whole set of tools is offered');
});

test('typing narrows the list: exact, then starts with, then contains, then a word of the description', () => {
  const hits = (text) => verbs(matchCommands(catalog, text));
  assert.equal(hits('/prop')[0], '/prop', 'an exact verb is first');
  assert.ok(hits('/pro').includes('/prop') && hits('/pro').includes('/prompts'));
  assert.deepEqual(hits('/zzzz'), []);
  assert.equal(hits('/lint ').length, 0, 'no list once arguments start');
  assert.equal(hits('lint').length, 0, 'text without a slash is not a command');
  // A verb that starts with the text comes before one that only contains it.
  const found = matchCommands(catalog, '/pr');
  const starts = (c) => [c.verb, ...c.aliases].some((v) => v.startsWith('/pr'));
  const firstOther = found.findIndex((c) => !starts(c));
  assert.ok(starts(found[0]));
  assert.ok(firstOther === -1 || found.slice(firstOther).every((c) => !starts(c)), 'starts-with rows are not mixed in after the others');
  // A word of the description finds a command whose verb does not contain it, from three letters on.
  assert.ok(hits('/email').includes('/notify'), '/email finds the email tracer through its description');
  assert.ok(!hits('/pr').includes('/ship'), '"pr" is not the start of "pre-commit" for this purpose');
  assert.ok(hits('/slow').includes('/hotspots'), 'an alias finds its command');
});

test('an alias that matched is reported, and nothing is reported for a verb match', () => {
  const via = (text) => matchCommands(catalog, text)[0];
  assert.equal(via('/why').verb, '/access');
  assert.equal(via('/why').via, '/why');
  assert.equal(via('/access').via, '');
  assert.equal(via('/bench').verb, '/testclient');
});

test('picking a command leaves the text ready for its arguments', () => {
  const deps = catalog.find((c) => c.verb === '/deps');
  assert.equal(completion(deps), '/deps ');
  assert.equal(usage(deps), '/deps <ScriptInclude>');
  assert.equal(usage(catalog.find((c) => c.verb === '/lint')), '/lint');
});

test('opensTool: panels open at once, the AI and chat commands do not', () => {
  const by = (v) => catalog.find((c) => c.verb === v);
  assert.equal(opensTool(by('/prop')), true);
  assert.equal(opensTool(by('/tail')), true);
  assert.equal(opensTool(by('/review')), false);
  assert.equal(opensTool(by('/clear')), false);
});

test('/help prints every command, section by section, in the layout the help card parses', () => {
  const text = helpText(catalog);
  catalog.forEach((c) => assert.ok(text.includes(`  ${usage(c)}`), `/help leaves out ${c.verb}`));
  GROUP_ORDER.forEach((g) => assert.ok(text.split('\n').includes(g), `/help has no "${g}" section`));
  // HelpBody splits a row at two or more spaces; a command column that ran into its description would break that.
  text.split('\n').filter((l) => /^ {2}\//.test(l)).forEach((line) => assert.match(line, /^ {2}\S.*?\s{2,}\S/, `row has no gap: ${line}`));
  assert.ok(!/undefined/.test(text));
});

test('Sidebar.jsx handles every command the catalog advertises that it answers itself', () => {
  const sidebar = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebar', 'Sidebar.jsx'), 'utf8');
  const registered = new Set(PANELS.flatMap((p) => p.slash || []));
  catalog
    .filter((c) => !c.panel && !registered.has(c.verb))
    .forEach((c) => {
      const name = c.verb.slice(1);
      // Either a PANEL_COMMANDS key, or a startsWith / regex / equality test on the typed text.
      const handled = new RegExp(`'/${name}'|"/${name}"|startsWith\\('/${name}'\\)|\\^\\\\/${name}|=== '/${name}'`).test(sidebar);
      assert.ok(handled, `${c.verb} is advertised but Sidebar.jsx has no handler for it`);
    });
});
