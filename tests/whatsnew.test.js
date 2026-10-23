const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const W = require('../src/lib/whatsNew.js');
const { INTENTS, wordsScore, intentText } = require('../src/lib/paletteIntents.js');
const { parseGoTo } = require('../src/lib/goTo.js');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const items = W.GROUPS.flatMap((group) => group.items);

// Panels in the registry: name -> slash commands, read from the source (the registry imports every React panel).
function registryPanels() {
  const out = new Map();
  const source = read('src/sidebar/panelRegistry.js');
  source.split('PANELS.push({').slice(1).forEach((block) => {
    const name = /^\s*name: '([a-z]+)'/m.exec(block)?.[1];
    const slash = /^\s*slash: \[([^\]]*)\]/m.exec(block)?.[1] || '';
    if (name) out.set(name, [...slash.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  });
  return out;
}

// ---- who sees the card ------------------------------------------------------------------------------------------------

test('versions are compared as numbers, not text', () => {
  assert.deepEqual(W.parseVersion('0.9.0'), [0, 9, 0]);
  assert.deepEqual(W.parseVersion(' 1.12.3 '), [1, 12, 3]);
  ['', '0.9', '0.9.0.1', 'v0.9.0', '0.9.x', null, undefined, '1.0.0-beta'].forEach((bad) => assert.equal(W.parseVersion(bad), null, String(bad)));
  assert.equal(W.compareVersions('0.9.0', '0.9.0'), 0);
  assert.equal(W.compareVersions('0.10.0', '0.9.0'), 1, '0.10 is newer than 0.9');
  assert.equal(W.compareVersions('0.8.9', '0.9.0'), -1);
  assert.equal(W.compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(W.compareVersions('nope', '0.9.0'), null);
  assert.equal(W.compareVersions(undefined, '0.9.0'), null);
  assert.equal(W.isAtLeast('0.9.0', '0.9.0'), true);
  assert.equal(W.isAtLeast('0.9.1', '0.9.0'), true);
  assert.equal(W.isAtLeast('0.8.9', '0.9.0'), false);
  assert.equal(W.isAtLeast(undefined, '0.9.0'), false, 'nothing stored is not "seen"');
  assert.equal(W.isAtLeast('junk', '0.9.0'), false);
});

test('someone who dismissed the welcome card and has not seen these notes gets the card', () => {
  assert.deepEqual(W.decideWhatsNew({ welcomed: true, seenVersion: undefined, currentVersion: '0.9.0' }).action, 'show');
  assert.equal(W.decideWhatsNew({ welcomed: true, seenVersion: '0.8.0', currentVersion: '0.9.0' }).action, 'show');
  assert.equal(W.decideWhatsNew({ welcomed: true, seenVersion: 'garbage', currentVersion: '0.9.0' }).action, 'show', 'an unreadable stored value counts as not seen');
});

test('a new person gets the welcome card, never both: the notes are marked seen without being shown', () => {
  const decision = W.decideWhatsNew({ welcomed: false, seenVersion: undefined, currentVersion: '0.9.0' });
  assert.equal(decision.action, 'mark');
  assert.equal(W.decideWhatsNew({ welcomed: false, seenVersion: '0.9.0', currentVersion: '0.9.0' }).action, 'mark', 'still new: welcome card first');
});

test('once seen, never again for this version; a patch release without notes shows nothing', () => {
  assert.equal(W.decideWhatsNew({ welcomed: true, seenVersion: '0.9.0', currentVersion: '0.9.0' }).action, 'skip');
  assert.equal(W.decideWhatsNew({ welcomed: true, seenVersion: '0.9.0', currentVersion: '0.9.1' }).action, 'skip');
  assert.equal(W.decideWhatsNew({ welcomed: true, seenVersion: '0.9.0', currentVersion: '0.9.1', notesVersion: '0.9.0' }).action, 'skip');
  // The next notes (1.0.0) show again to someone who saw 0.9.0.
  assert.equal(W.decideWhatsNew({ welcomed: true, seenVersion: '0.9.0', currentVersion: '1.0.0', notesVersion: '1.0.0' }).action, 'show');
  // ...but not to someone who installed 1.0.0 fresh.
  assert.equal(W.decideWhatsNew({ welcomed: false, currentVersion: '1.0.0', notesVersion: '1.0.0' }).action, 'mark');
});

test('a build older than the notes, or an unreadable version, shows nothing', () => {
  assert.equal(W.decideWhatsNew({ welcomed: true, currentVersion: '0.8.0' }).action, 'skip');
  assert.equal(W.decideWhatsNew({ welcomed: true, currentVersion: '' }).action, 'skip');
  assert.equal(W.decideWhatsNew({ welcomed: true, currentVersion: 'dev' }).action, 'skip');
  assert.equal(W.decideWhatsNew({ welcomed: false, currentVersion: '0.8.0' }).action, 'skip');
});

test('the card waits for the palette, another card, a hidden tab and typing, and says which', () => {
  assert.deepEqual(W.canShowNow({}), { ok: true, busy: '' });
  assert.deepEqual(W.canShowNow(), { ok: true, busy: '' });
  assert.equal(W.canShowNow({ paletteOpen: true }).ok, false);
  assert.equal(W.canShowNow({ paletteOpen: true }).busy, 'palette open');
  assert.equal(W.canShowNow({ hidden: true }).busy, 'tab hidden');
  assert.equal(W.canShowNow({ cardOpen: true }).busy, 'another card open');
  assert.equal(W.canShowNow({ typing: true }).busy, 'typing');
  assert.equal(W.canShowNow({ typing: true, paletteOpen: true }).ok, false);
});

test('typing is only a field that takes text', () => {
  assert.equal(W.isTypingIn(null), false);
  assert.equal(W.isTypingIn({ tagName: 'BODY' }), false);
  assert.equal(W.isTypingIn({ tagName: 'TEXTAREA' }), true);
  assert.equal(W.isTypingIn({ tagName: 'SELECT' }), true);
  assert.equal(W.isTypingIn({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(W.isTypingIn({ tagName: 'INPUT' }), true);
  assert.equal(W.isTypingIn({ tagName: 'input', type: 'search' }), true);
  assert.equal(W.isTypingIn({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(W.isTypingIn({ tagName: 'INPUT', type: 'button' }), false);
  assert.equal(W.isTypingIn({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(W.isTypingIn({ tagName: 'DIV', isContentEditable: false }), false);
});

// ---- what the card says -------------------------------------------------------------------------------------------------

test('the groups are the four jobs, in order, each with something in it', () => {
  assert.deepEqual(W.GROUPS.map((g) => g.title), ['Debug', 'Code', 'Explore', 'Ship']);
  W.GROUPS.forEach((group) => assert.ok(group.items.length > 0, group.title));
  assert.equal(W.TOOL_COUNT, 10, 'nine lines plus the self-check');
  assert.equal(W.subtitle('0.9.0'), 'Version 0.9.0: ten new tools. Click one to open it.');
});

test('every line opens exactly one thing, and a panel line points at a panel that exists with that slash command', () => {
  const panels = registryPanels();
  assert.ok(panels.size > 20 && panels.has('clienttrace') && panels.has('doctor'), 'the scan found the registry');
  items.forEach((item) => {
    const kinds = ['panel', 'palette', 'editor'].filter((key) => key in item.open);
    assert.equal(kinds.length, 1, `${item.name}: opens one thing`);
    if (item.open.panel) {
      assert.ok(panels.has(item.open.panel), `${item.name}: unknown panel ${item.open.panel}`);
      assert.ok(panels.get(item.open.panel).includes(item.slash), `${item.name}: ${item.slash} is not a slash command of ${item.open.panel} (${panels.get(item.open.panel)})`);
    }
  });
  assert.ok(panels.has(W.SELF_CHECK.panel));
  assert.ok(panels.get(W.SELF_CHECK.panel).includes(W.SELF_CHECK.slash));
});

test('a panel is listed once, and the self-check is not also a line', () => {
  const panelNames = items.filter((i) => i.open.panel).map((i) => i.open.panel);
  assert.equal(new Set(panelNames).size, panelNames.length);
  assert.ok(!panelNames.includes(W.SELF_CHECK.panel));
  const names = items.map((i) => i.name);
  assert.equal(new Set(names).size, names.length);
});

test('the go-to line types a prefix that the palette really reads as a kind', () => {
  const line = items.find((i) => i.name === 'Go to anything');
  assert.ok(line && typeof line.open.palette === 'string');
  const parsed = parseGoTo(line.open.palette);
  assert.equal(parsed.mode, 'kind');
  assert.deepEqual(parsed.kinds, ['br']);
});

test('the wording is plain: short, no emoji, none of the words this project avoids', () => {
  const everything = [...items.flatMap((i) => [i.name, i.slash, i.what]), W.SELF_CHECK.label, W.SELF_CHECK.note];
  everything.forEach((text) => {
    assert.ok(text.trim() === text && text.length > 1, text);
    assert.ok(!/\p{Extended_Pictographic}/u.test(text), `emoji in: ${text}`);
    assert.ok(!/\b(leverage|seamless|payload|supercharge|powerful|revolutionary|blazing|robust)\b/i.test(text), `buzzword in: ${text}`);
  });
  items.forEach((item) => {
    assert.ok(item.name.length <= 48, item.name);
    assert.ok(item.what.length >= 30 && item.what.length <= 90, `${item.name}: ${item.what.length} characters (one line at the card's width)`);
    assert.ok(/[.?]$/.test(item.what), `${item.name}: ends like a sentence`);
  });
});

test('the card does not claim a tool is proven on the reader’s instance', () => {
  const text = items.map((i) => i.what).join(' ') + W.SELF_CHECK.note;
  assert.ok(!/\b(verified|guaranteed|always works|tested on)\b/i.test(text));
});

// ---- the palette command ------------------------------------------------------------------------------------------------

test('"What\'s new" is a palette command with a problem phrase, and typing it finds it first', () => {
  const commands = read('src/content/commands.js');
  assert.ok(/id: 'tools\.whatsNew'/.test(commands), 'the command exists');
  assert.ok(/if \(deps\.showWhatsNew\)/.test(commands), 'it only appears where the card exists');
  assert.ok('tools.whatsNew' in INTENTS);
  ['whats new', "what's new", 'new features', 'what did the update add'].forEach((phrase) => {
    const score = (id) => wordsScore(phrase, '', intentText(id));
    const best = Math.max(...Object.keys(INTENTS).map(score));
    assert.ok(score('tools.whatsNew') > 0, phrase);
    assert.equal(score('tools.whatsNew'), best, `"${phrase}" matches another command at least as well`);
  });
});

// ---- wiring and release numbers -----------------------------------------------------------------------------------------

test('the card is created next to the welcome card, its styles are bundled, and the shipping version shows these notes', () => {
  const index = read('src/content/index.js');
  assert.ok(/createWhatsNew\(\{/.test(index) && /whatsNew\.maybeShow\(\)/.test(index));
  assert.ok(index.indexOf('welcome.maybeShow()') < index.indexOf('whatsNew.maybeShow()'));
  assert.ok(/showWhatsNew: \(\) => whatsNew\?\.show\(\)/.test(index));
  assert.ok(read('build.js').includes("src/content/whatsNew.css"));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src/content/whatsNew.css')));

  const manifest = JSON.parse(read('manifest.json')).version;
  const pkg = JSON.parse(read('package.json')).version;
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg, manifest, 'package.json and manifest.json agree');
  assert.equal(lock.version, manifest);
  assert.equal(lock.packages[''].version, manifest);
  assert.ok(W.isAtLeast(manifest, W.NOTES_VERSION), `manifest ${manifest} is older than the notes ${W.NOTES_VERSION}: the card would never show`);
});

// ---- the card itself, against a small fake page -------------------------------------------------------------------------

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.attrs = {};
    this.listeners = {};
    this.parent = null;
    this.type = '';
    this.isConnected = false;
  }
  get classes() {
    return this.className.split(/\s+/).filter(Boolean);
  }
  setAttribute(name, value) {
    this.attrs[name] = value;
  }
  append(...nodes) {
    nodes.forEach((node) => this.appendChild(node));
  }
  appendChild(node) {
    node.parent = this;
    this.children.push(node);
    const connect = (n, value) => {
      n.isConnected = value;
      n.children.forEach((c) => connect(c, value));
    };
    connect(node, this.isConnected);
    return node;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
    const disconnect = (n) => {
      n.isConnected = false;
      n.children.forEach(disconnect);
    };
    disconnect(this);
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelector(selector) {
    const wanted = selector.split(',').map((s) => s.trim().replace(/^\./, ''));
    return this.all().find((n) => wanted.some((w) => n.classes.includes(w))) || null;
  }
  querySelectorAll(selector) {
    const wanted = selector.split(',').map((s) => s.trim().replace(/^\./, ''));
    return this.all().filter((n) => wanted.some((w) => n.classes.includes(w)));
  }
  fire(type, event = {}) {
    (this.listeners[type] || []).forEach((fn) => fn({ isTrusted: true, ...event }));
  }
  textOf() {
    return [this.textContent, ...this.children.map((c) => c.textOf())].join(' ');
  }
}

function fakePage({ store = {}, hidden = false, paletteOpen = false, active = null } = {}) {
  const doc = {
    hidden,
    activeElement: active,
    listeners: {},
    createElement: (tag) => {
      const node = new FakeEl(tag);
      node.ownerDocument = doc;
      return node;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
  };
  const shadow = new FakeEl('shadow');
  shadow.ownerDocument = doc;
  shadow.isConnected = true;
  const writes = [];
  const chromeFake = {
    storage: {
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
        },
        set: async (obj) => {
          Object.assign(store, obj);
          writes.push(obj);
        },
      },
    },
  };
  const calls = [];
  const state = { paletteOpen };
  return { doc, shadow, chromeFake, store, writes, calls, state };
}

async function withPage(options, body) {
  const page = fakePage(options);
  const saved = { document: global.document, chrome: global.chrome };
  global.document = page.doc;
  global.chrome = page.chromeFake;
  const { mock } = require('node:test');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { createWhatsNew } = require('../src/content/whatsNew.js');
    const card = createWhatsNew({
      shadow: page.shadow,
      openPalette: (text) => page.calls.push(['palette', text]),
      openPanel: (name) => page.calls.push(['panel', name]),
      openEditor: () => page.calls.push(['editor']),
      isPaletteOpen: () => page.state.paletteOpen,
      getVersion: () => options.version || '0.9.0',
      delayMs: 4000,
    });
    await body({ ...page, card });
  } finally {
    mock.timers.reset();
    global.document = saved.document;
    global.chrome = saved.chrome;
  }
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};
const cardOf = (shadow) => shadow.querySelector('.msb-whatsnew');

test('card: an existing user sees it once, a few seconds after load, and it is remembered as soon as it shows', async () => {
  await withPage({ store: { mysnowbuddy_welcomed: true } }, async ({ card, shadow, store, writes }) => {
    const { mock } = require('node:test');
    await card.maybeShow();
    assert.equal(cardOf(shadow), null, 'not at once');
    mock.timers.tick(3999);
    await settle();
    assert.equal(cardOf(shadow), null, 'not before the delay');
    mock.timers.tick(1);
    await settle();
    const root = cardOf(shadow);
    assert.ok(root, 'shown after the delay');
    assert.equal(root.attrs.role, 'dialog');
    assert.ok(root.attrs['aria-label']);
    assert.equal(store.mysnowbuddy_whatsnew_seen, '0.9.0');
    assert.equal(writes.length, 1);
    assert.equal(root.querySelectorAll('.msb-whatsnew__item').length, 9);
    assert.deepEqual(root.querySelectorAll('.msb-whatsnew__groupTitle').map((n) => n.textContent), ['Debug', 'Code', 'Explore', 'Ship']);
    assert.ok(root.textOf().includes('Version 0.9.0'));
  });
});

test('card: a new person gets nothing, and the notes are marked seen so the welcome card is not followed by this one', async () => {
  await withPage({ store: {} }, async ({ card, shadow, store }) => {
    const { mock } = require('node:test');
    await card.maybeShow();
    mock.timers.tick(60000);
    await settle();
    assert.equal(cardOf(shadow), null);
    assert.equal(store.mysnowbuddy_whatsnew_seen, '0.9.0');
  });
});

test('card: already seen, or an older build, shows nothing', async () => {
  await withPage({ store: { mysnowbuddy_welcomed: true, mysnowbuddy_whatsnew_seen: '0.9.0' } }, async ({ card, shadow }) => {
    const { mock } = require('node:test');
    await card.maybeShow();
    mock.timers.tick(60000);
    await settle();
    assert.equal(cardOf(shadow), null);
  });
  await withPage({ store: { mysnowbuddy_welcomed: true }, version: '0.8.0' }, async ({ card, shadow }) => {
    const { mock } = require('node:test');
    await card.maybeShow();
    mock.timers.tick(60000);
    await settle();
    assert.equal(cardOf(shadow), null);
  });
});

test('card: it waits while the palette is open and while someone is typing, then shows', async () => {
  await withPage({ store: { mysnowbuddy_welcomed: true }, paletteOpen: true, active: { tagName: 'INPUT', type: 'text' } }, async ({ card, shadow, state, doc }) => {
    const { mock } = require('node:test');
    await card.maybeShow();
    mock.timers.tick(4000);
    await settle();
    assert.equal(cardOf(shadow), null, 'palette open');
    state.paletteOpen = false;
    mock.timers.tick(5000);
    await settle();
    assert.equal(cardOf(shadow), null, 'still typing in a field');
    doc.activeElement = { tagName: 'BODY' };
    mock.timers.tick(5000);
    await settle();
    assert.ok(cardOf(shadow), 'shown once the way is clear');
  });
});

test('card: typing in a classic form (inside the content frame) or a workspace field (inside shadow roots) counts as typing', async () => {
  // Classic UI: the form is in gsft_main, so the top document only knows the iframe has the focus.
  const field = { tagName: 'INPUT', type: 'text', isConnected: true };
  const frameDoc = { activeElement: field, body: { tagName: 'BODY' } };
  const iframe = { tagName: 'IFRAME', contentDocument: frameDoc };
  // Next Experience: that iframe sits inside a shadow root of the shell, so the top document only knows the host.
  const host = { tagName: 'MACROPONENT-F51912F4C700201072B211D4D8C26010', shadowRoot: { activeElement: { tagName: 'SN-CANVAS', shadowRoot: { activeElement: iframe } } } };
  await withPage({ store: { mysnowbuddy_welcomed: true }, active: host }, async ({ card, shadow, doc }) => {
    const { mock } = require('node:test');
    const { deepActiveElement } = require('../src/content/whatsNew.js');
    assert.equal(deepActiveElement(doc), field, 'the focus is found through shadow roots and the frame');
    await card.maybeShow();
    mock.timers.tick(4000);
    await settle();
    assert.equal(cardOf(shadow), null, 'someone is typing in the form: the card waits');
    frameDoc.activeElement = frameDoc.body;
    mock.timers.tick(5000);
    await settle();
    assert.ok(cardOf(shadow), 'shown once nobody is typing');
  });
  // A frame the page cannot read into (another origin) stops the walk there, and is not typing.
  const foreign = { tagName: 'IFRAME' };
  Object.defineProperty(foreign, 'contentDocument', { get: () => { throw new Error('cross-origin'); } });
  await withPage({ store: {}, active: foreign }, async ({ doc }) => {
    const { deepActiveElement } = require('../src/content/whatsNew.js');
    assert.equal(deepActiveElement(doc), foreign);
  });
});

test('card: focus goes back into the form field it came from when the card closes', async () => {
  const field = { tagName: 'INPUT', type: 'checkbox', isConnected: true, focused: 0, focus() { this.focused += 1; } };
  const frameDoc = { activeElement: field, body: { tagName: 'BODY' } };
  await withPage({ store: { mysnowbuddy_welcomed: true }, active: { tagName: 'IFRAME', contentDocument: frameDoc } }, async ({ card, shadow }) => {
    card.show();
    assert.ok(cardOf(shadow));
    card.hide();
    assert.equal(field.focused, 1, 'the field inside the frame gets the focus back, not the frame element');
  });
});

test('card: it gives up after a few tries (the next page load tries again) and does not mark the notes seen', async () => {
  await withPage({ store: { mysnowbuddy_welcomed: true }, paletteOpen: true }, async ({ card, shadow, store }) => {
    const { mock } = require('node:test');
    await card.maybeShow();
    for (let i = 0; i < 20; i += 1) {
      mock.timers.tick(5000);
      await settle();
    }
    assert.equal(cardOf(shadow), null);
    assert.equal(store.mysnowbuddy_whatsnew_seen, undefined);
  });
});

test('card: it does not appear over the welcome card, the guide, a confirmation or the editor', async () => {
  await withPage({ store: { mysnowbuddy_welcomed: true } }, async ({ card, shadow, doc }) => {
    const { mock } = require('node:test');
    const other = doc.createElement('section');
    other.className = 'msb-guide';
    shadow.appendChild(other);
    await card.maybeShow();
    mock.timers.tick(4000);
    await settle();
    assert.equal(cardOf(shadow), null);
    other.remove();
    mock.timers.tick(5000);
    await settle();
    assert.ok(cardOf(shadow));
  });
});

test('card: another tab that showed it first stops this one', async () => {
  await withPage({ store: { mysnowbuddy_welcomed: true } }, async ({ card, shadow, store }) => {
    const { mock } = require('node:test');
    await card.maybeShow();
    store.mysnowbuddy_whatsnew_seen = '0.9.0'; // the other tab, during the wait
    mock.timers.tick(4000);
    await settle();
    assert.equal(cardOf(shadow), null);
  });
});

test('card: a hidden tab waits until it is shown', async () => {
  await withPage({ store: { mysnowbuddy_welcomed: true }, hidden: true }, async ({ card, shadow, doc }) => {
    const { mock } = require('node:test');
    await card.maybeShow();
    mock.timers.tick(4000);
    await settle();
    assert.equal(cardOf(shadow), null);
    assert.equal(doc.listeners.visibilitychange?.length, 1);
    doc.hidden = false;
    doc.listeners.visibilitychange.forEach((fn) => fn());
    mock.timers.tick(4000);
    await settle();
    assert.ok(cardOf(shadow));
  });
});

test('card: every line opens its tool and closes the card; the self-check button opens the self-check', async () => {
  await withPage({ store: { mysnowbuddy_welcomed: true } }, async ({ card, shadow, calls }) => {
    card.show();
    let root = cardOf(shadow);
    const rows = root.querySelectorAll('.msb-whatsnew__item');
    rows[0].fire('click');
    assert.equal(cardOf(shadow), null, 'the card closes');
    assert.deepEqual(calls.pop(), ['panel', 'clienttrace']);

    card.show();
    root = cardOf(shadow);
    const byName = (name) => root.querySelectorAll('.msb-whatsnew__item').find((r) => r.textOf().includes(name));
    byName('Script editor').fire('click');
    assert.deepEqual(calls.pop(), ['editor']);

    card.show();
    root = cardOf(shadow);
    byName('Go to anything').fire('click');
    assert.deepEqual(calls.pop(), ['palette', 'br: ']);

    card.show();
    root = cardOf(shadow);
    root.querySelectorAll('.msb-btn').find((b) => b.textContent === W.SELF_CHECK.label).fire('click');
    assert.deepEqual(calls.pop(), ['panel', 'doctor']);
    assert.equal(cardOf(shadow), null);
  });
});

test('card: a click the page scripted does nothing; Escape from a real key closes it, a scripted one does not', async () => {
  await withPage({ store: { mysnowbuddy_welcomed: true } }, async ({ card, shadow, calls }) => {
    card.show();
    const root = cardOf(shadow);
    root.querySelectorAll('.msb-whatsnew__item')[0].fire('click', { isTrusted: false });
    assert.ok(cardOf(shadow), 'a synthetic click is ignored');
    assert.equal(calls.length, 0);
    root.fire('keydown', { key: 'Escape', isTrusted: false });
    assert.ok(cardOf(shadow));
    root.fire('keydown', { key: 'Escape' });
    assert.equal(cardOf(shadow), null);
  });
});

test('card: "What\'s new" in the palette shows it again, once, and focus goes to Got it then back where it was', async () => {
  await withPage({ store: { mysnowbuddy_welcomed: true, mysnowbuddy_whatsnew_seen: '0.9.0' } }, async ({ card, shadow, doc }) => {
    const before = doc.createElement('button');
    before.isConnected = true;
    doc.activeElement = before;
    card.show();
    card.show(); // asking twice does not stack a second card
    assert.equal(shadow.querySelectorAll('.msb-whatsnew').length, 1);
    assert.equal(doc.activeElement.textContent, 'Got it');
    card.hide();
    assert.equal(cardOf(shadow), null);
    assert.equal(doc.activeElement, before, 'focus returns to the opener');
  });
});
