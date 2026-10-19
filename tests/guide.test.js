const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GUIDE_JOBS, JOB_FOR_PAGE, guideShortcuts } = require('../src/lib/guideContent.js');
const { INTENTS, wordsScore, intentText } = require('../src/lib/paletteIntents.js');
const { orderedJobs } = require('../src/content/guide.js');

const src = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function knownCommandIds() {
  const ids = new Set([...src('src/content/commands.js').matchAll(/id: '([a-z][A-Za-z0-9_.]*)'/g)].map((m) => m[1]));
  ['src/sidebar/panelRegistry.js', 'src/sidebar/MyWorkPanel.jsx'].forEach((file) => {
    [...src(file).matchAll(/^\s+name: '([a-z]+)',/gm)].forEach((m) => ids.add(`panel.${m[1]}`));
  });
  return ids;
}

const items = GUIDE_JOBS.flatMap((job) => job.items);

test('every guide line leads to a command that exists, and its phrase is that command\'s best match', () => {
  const ids = knownCommandIds();
  items.filter((item) => item.target).forEach((item) => {
    assert.ok(ids.has(item.target), `${item.say}: unknown command ${item.target}`);
    const score = (id) => wordsScore(item.say, '', intentText(id));
    const best = Math.max(...Object.keys(INTENTS).map(score));
    assert.ok(score(item.target) > 0, `"${item.say}" does not match ${item.target}`);
    assert.equal(score(item.target), best, `"${item.say}" matches another command better than ${item.target}`);
  });
});

test('every line has a phrase, a plain explanation and no duplicate phrases', () => {
  const said = new Set();
  items.forEach((item) => {
    assert.ok(item.say.trim() && item.what.trim().length > 15, item.say);
    assert.ok(!said.has(item.say), `duplicate phrase ${item.say}`);
    said.add(item.say);
  });
});

test('the page decides which job comes first, and every job still appears once', () => {
  Object.entries(JOB_FOR_PAGE).forEach(([kind, title]) => {
    assert.ok(GUIDE_JOBS.some((job) => job.title === title), `${kind} points at a job that does not exist`);
    const ordered = orderedJobs(kind);
    assert.equal(ordered[0].title, title);
    assert.equal(ordered.length, GUIDE_JOBS.length);
  });
});

test('the key list starts with the palette key the caller gives', () => {
  assert.deepEqual(guideShortcuts('Ctrl+Shift+Space')[0], ['Ctrl+Shift+Space', 'Open the palette']);
});
