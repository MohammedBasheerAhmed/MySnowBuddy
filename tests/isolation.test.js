// Isolation from the ServiceNow page: scripts on the page (UI scripts, widgets) must not be able
// to operate the extension's own UI or reach the service worker's privileged handlers.
//   - the sender check (frame origin, not tab URL; escaped look-alike-proof regex)
//   - trusted() (synthetic events never confirm, approve, run or write)
//   - the sub-frame hotkey relay (trusted keydowns only, via the service worker)
//   - the closed shadow root
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SERVICE_NOW_ORIGIN_RE,
  checkSender,
  isAllowedSender,
  isServiceNowOrigin,
  isServiceNowUrl,
  senderOrigin,
} = require('../src/lib/senderCheck.js');
const { trusted, trustedDom, isTrustedEvent } = require('../src/sidebar/trusted.js');
const { frameHotkeyRelay, sanitizeFrameHotkey } = require('../src/lib/hotkeyRelay.js');
const { attachUiRoot, getUiRoot, UI_HOST_ID } = require('../src/content/uiRoot.js');

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const SN = 'https://dev1.service-now.com';
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const pageSender = (over = {}) => ({ id: EXT, origin: SN, url: `${SN}/incident.do`, frameId: 0, tab: { id: 7, url: `${SN}/now/nav/ui/classic` }, ...over });
const optionsSender = () => ({ id: EXT, origin: `chrome-extension://${EXT}`, url: `chrome-extension://${EXT}/options.html`, frameId: 0, tab: { id: 9, url: `chrome-extension://${EXT}/options.html` } });

// ---- sender check -------------------------------------------------------------------------------

test('sender check: ServiceNow origins only, with every dot escaped', () => {
  for (const good of [SN, 'https://acme.service-now.com', 'https://acme-dev.service-now.com', 'https://a.b.service-now.com', 'https://DEV1.SERVICE-NOW.COM']) {
    assert.ok(isServiceNowOrigin(good), good);
  }
  for (const bad of [
    'https://evil-service-now.com',
    'https://service-now.com.evil.com',
    'https://dev1.service-now.com.evil.com',
    'https://dev1xservice-now.com',
    'https://dev1.service-nowxcom',
    'https://service-now.com',
    'http://dev1.service-now.com',
    'https://dev1.service-now.com:8443',
    'https://dev1.service-now.com/',
    'https://user@dev1.service-now.com',
    'null',
    '',
    undefined,
  ]) {
    assert.equal(isServiceNowOrigin(bad), false, String(bad));
  }
  assert.ok(SERVICE_NOW_ORIGIN_RE.test(SN));
  assert.ok(isServiceNowUrl(`${SN}/incident.do?sys_id=1`));
  assert.equal(isServiceNowUrl('https://evil.com/#.service-now.com/'), false);
  assert.equal(isServiceNowUrl('https://evil.com/?x=.service-now.com/'), false);
  assert.equal(isServiceNowUrl('https://dev1.service-now.com.evil.com/'), false);
  assert.equal(isServiceNowUrl('not a url'), false);
});

test('sender check: the sending frame decides, not the tab URL', () => {
  assert.equal(checkSender(pageSender(), EXT, 'page'), 'page');
  // A third-party frame inside a ServiceNow tab: the tab URL passes a naive check, the frame must not.
  const evilFrame = pageSender({ origin: 'https://evil-service-now.com', url: 'https://evil-service-now.com/x', frameId: 4 });
  assert.throws(() => checkSender(evilFrame, EXT, 'frame'), /ServiceNow page/);
  assert.throws(() => checkSender({ ...evilFrame, frameId: 0 }, EXT, 'page'), /ServiceNow page/);
  assert.throws(() => checkSender(pageSender({ origin: 'https://service-now.com.evil.com' }), EXT, 'page'), /ServiceNow page/);
  assert.throws(() => checkSender(pageSender({ origin: 'http://dev1.service-now.com' }), EXT, 'page'), /ServiceNow page/);
  // An opaque (sandboxed) frame on a ServiceNow URL is unknown, not trusted.
  assert.throws(() => checkSender(pageSender({ origin: 'null', frameId: 2 }), EXT, 'frame'), /ServiceNow page/);
});

test('sender check: frames, other extensions, missing tab, url fallback', () => {
  const sub = pageSender({ frameId: 3 });
  assert.equal(checkSender(sub, EXT, 'frame'), 'page', 'a ServiceNow sub-frame may relay hotkeys');
  assert.throws(() => checkSender(sub, EXT, 'page'), /ServiceNow page/, 'the UI and agent live in the top frame only');
  assert.throws(() => checkSender(pageSender({ id: 'someotherextension' }), EXT, 'page'));
  assert.throws(() => checkSender(pageSender(), '', 'page'), 'no runtime id, no pass');
  assert.throws(() => checkSender(null, EXT, 'any'));
  assert.throws(() => checkSender(pageSender({ tab: undefined }), EXT, 'page'), /ServiceNow page/);
  // Older Chrome without sender.origin: the frame URL (never tab.url) is used.
  const noOrigin = { id: EXT, url: `${SN}/incident.do`, frameId: 0, tab: { id: 1, url: 'https://evil.com/' } };
  assert.equal(senderOrigin(noOrigin), SN);
  assert.equal(checkSender(noOrigin, EXT, 'page'), 'page');
  assert.equal(senderOrigin({ id: EXT, tab: { id: 1, url: `${SN}/` } }), '', 'tab.url is never the sender origin');
  assert.equal(isAllowedSender({ id: EXT, frameId: 0, tab: { id: 1, url: `${SN}/` } }, EXT, 'page'), false);
});

test('sender check: extension pages by origin', () => {
  assert.equal(checkSender(optionsSender(), EXT, 'any'), 'extension');
  assert.equal(checkSender(optionsSender(), EXT, 'extension'), 'extension');
  assert.throws(() => checkSender(optionsSender(), EXT, 'page'), /ServiceNow page/, 'SANDBOX_RUN / AGENT_STEP refuse the options page');
  assert.throws(() => checkSender(pageSender(), EXT, 'extension'), /extension's own pages/);
  // Another extension's page is not ours.
  assert.throws(() => checkSender({ ...optionsSender(), origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }, EXT, 'any'));
  // url fallback for extension pages too.
  assert.equal(checkSender({ id: EXT, url: `chrome-extension://${EXT}/options.html`, frameId: 0 }, EXT, 'any'), 'extension');
});

// ---- service worker dispatcher ------------------------------------------------------------------

let worker = null;
function loadWorker() {
  if (worker) return worker; // the module registers its listeners once, on first load
  const listeners = [];
  const tabMessages = [];
  const session = {};
  globalThis.chrome = {
    runtime: {
      id: EXT,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getManifest: () => ({ version: '0.0.0' }),
      openOptionsPage: async () => {},
      sendMessage: async () => ({}),
    },
    action: { onClicked: { addListener() {} }, setBadgeText() {}, setTitle() {} },
    commands: { onCommand: { addListener() {} } },
    tabs: {
      onRemoved: { addListener() {} },
      query: async () => [],
      sendMessage: async (tabId, message, options) => {
        tabMessages.push({ tabId, message, options });
        return { ok: true };
      },
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: { get: async (k) => ({ [k]: session[k] }), set: async (o) => Object.assign(session, o), remove: async (k) => delete session[k] },
      onChanged: { addListener() {} },
    },
  };
  require('../src/background/service-worker.js');
  const send = (message, sender) =>
    new Promise((resolve) => {
      let answered = false;
      const reply = (r) => {
        answered = true;
        resolve(r);
      };
      const async = listeners.map((fn) => fn(message, sender, reply)).some((r) => r === true);
      if (!async && !answered) resolve(undefined);
    });
  worker = { send, tabMessages };
  return worker;
}

test('service worker: privileged handlers refuse senders outside a ServiceNow top frame', async () => {
  const { send } = loadWorker();
  const evilFrame = pageSender({ origin: 'https://evil-service-now.com', frameId: 2 });
  const lookAlikeTop = pageSender({ origin: 'https://dev1.service-now.com.evil.com', tab: { id: 7, url: 'https://dev1.service-now.com.evil.com/' } });
  const sub = pageSender({ frameId: 3 });
  const types = ['CHAT_COMPLETION', 'AGENT_STEP', 'SUMMARIZE_DIFF', 'COMPARE_INSTANCES', 'FETCH_REMOTE_RECORD', 'PUSH_PREVIEW', 'PUSH_ARTIFACT', 'SANDBOX_RUN', 'AUTOMATION_SAVE', 'AUTOMATION_LOAD', 'AUTOMATION_HANDOFF'];
  for (const type of types) {
    for (const [label, sender] of [['evil frame', evilFrame], ['look-alike', lookAlikeTop], ['sub-frame', sub], ['options page', optionsSender()], ['other extension', pageSender({ id: 'other' })]]) {
      const r = await send({ type, payload: { messages: [{ role: 'user', content: 'hi' }] } }, sender);
      assert.equal(r?.ok, false, `${type} from ${label}`);
      assert.match(r.error, /ServiceNow (page|tab)/, `${type} from ${label}: ${r.error}`);
    }
  }
  // The options page keeps what it legitimately uses; the page does not get the options-only handlers.
  assert.equal((await send({ type: 'GET_PROVIDER_INFO' }, optionsSender())).ok, true);
  assert.equal((await send({ type: 'GET_PROVIDER_INFO' }, pageSender())).ok, true);
  assert.equal((await send({ type: 'MCP_BRIDGE_STATUS' }, optionsSender())).ok, true);
  assert.equal((await send({ type: 'MCP_BRIDGE_STATUS' }, pageSender())).ok, false);
  assert.equal((await send({ type: 'VALIDATE_API_KEY', payload: { apiKey: 'x' } }, pageSender())).ok, false);
  // A good page sender passes the check (automation state is per tab).
  assert.deepEqual(await send({ type: 'AUTOMATION_LOAD' }, pageSender()), { ok: true, run: null });
});

test('service worker: the hotkey relay goes to frame 0 of the sending tab, rebuilt from known fields', async () => {
  const { send, tabMessages } = loadWorker();
  const sub = pageSender({ frameId: 3, url: `${SN}/incident.do` });

  assert.deepEqual(await send({ type: 'FRAME_HOTKEY', payload: { action: 'palette', extra: 'x' } }, sub), { ok: true });
  assert.deepEqual(tabMessages.at(-1), { tabId: 7, message: { type: 'FRAME_HOTKEY', action: 'palette' }, options: { frameId: 0 } });

  await send({ type: 'FRAME_HOTKEY', payload: { action: 'key', key: { key: 'Enter', ctrlKey: 1, shiftKey: true, metaKey: false, isTrusted: true } } }, sub);
  assert.deepEqual(tabMessages.at(-1).message, { type: 'FRAME_HOTKEY', action: 'key', key: { key: 'Enter', ctrlKey: false, shiftKey: true, metaKey: false } });

  const before = tabMessages.length;
  assert.equal((await send({ type: 'FRAME_HOTKEY', payload: { action: 'eval' } }, sub)).ok, false);
  assert.equal((await send({ type: 'FRAME_HOTKEY', payload: { action: 'key', key: { key: 'a' } } }, sub)).ok, false, 'only palette navigation keys');
  assert.equal((await send({ type: 'FRAME_HOTKEY', payload: { action: 'chat' } }, pageSender({ origin: 'https://evil-service-now.com', frameId: 2 }))).ok, false);
  assert.equal((await send({ type: 'FRAME_HOTKEY', payload: { action: 'chat' } }, pageSender({ origin: 'https://other.service-now.com', frameId: 2 }))).ok, false, 'same origin as the top frame only');
  assert.equal(tabMessages.length, before, 'nothing refused reached the tab');

  // Palette state: only the top frame may announce it; it is broadcast to the tab's frames.
  assert.deepEqual(await send({ type: 'PALETTE_STATE', payload: { open: 'yes' } }, pageSender()), { ok: true });
  assert.deepEqual(tabMessages.at(-1), { tabId: 7, message: { type: 'PALETTE_STATE', open: false }, options: undefined });
  assert.equal((await send({ type: 'PALETTE_STATE', payload: { open: true } }, sub)).ok, false);
});

// ---- trusted() ----------------------------------------------------------------------------------

test('trusted(): only real user input reaches the handler', () => {
  const calls = [];
  const handler = trusted(function (event, extra) {
    calls.push([this, event, extra]);
    return 'ran';
  });
  assert.equal(handler({ isTrusted: false }), undefined);
  assert.equal(handler({ nativeEvent: { isTrusted: false }, isTrusted: true }), undefined, 'React: the native event decides');
  assert.equal(handler(undefined), undefined, 'a programmatic call with no event is not user input');
  assert.equal(handler({}), undefined);
  assert.equal(handler({ isTrusted: 'true' }), undefined);
  assert.equal(calls.length, 0);

  const ctx = { name: 'ctx' };
  const dom = { isTrusted: true };
  assert.equal(handler.call(ctx, dom, 1), 'ran');
  const react = { nativeEvent: { isTrusted: true } };
  assert.equal(handler(react), 'ran');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [ctx, dom, 1], 'this and extra arguments pass through');
  assert.equal(calls[1][1], react);

  assert.equal(trustedDom, trusted);
  assert.equal(isTrustedEvent({ isTrusted: true }), true);
  assert.equal(isTrustedEvent({ nativeEvent: { isTrusted: true } }), true);
  assert.equal(isTrustedEvent(null), false);
});

test('trusted(): every confirm / approve / write / run handler is wrapped', () => {
  const expect = {
    'src/content/approvalDialog.js': [/allow\.addEventListener\('click', trustedDom\(/, /confirmInput\?\.addEventListener\('input', trustedDom\(/],
    'src/sidebar/AgentRun.jsx': [/onClick=\{trusted\(\(\) => onDecision\(step\.id, true\)\)\}/, /onChange=\{trusted\(\(e\) => setTyped/],
    'src/sidebar/PushArtifact.jsx': [/onClick=\{trusted\(handlePush\)\}/, /onChange=\{trusted\(\(e\) => setTyped/],
    'src/sidebar/MoveEntries.jsx': [/onClick=\{trusted\(handleMove\)\}/, /onChange=\{trusted\(\(e\) => setTyped/],
    'src/sidebar/ComparePanel.jsx': [/onClick=\{trusted\(handleCompare\)\}/, /onClick=\{trusted\(\(\) => setPushing/],
    'src/sidebar/ApplyPanel.jsx': [/onClick=\{trusted\(handleApply\)\}/, /onClick=\{trusted\(handleUndo\)\}/],
    'src/sidebar/Sidebar.jsx': [/onClick=\{trusted\(handleRunBackgroundScript\)\}/, /onChange=\{trusted\(\(e\) => setBgDryRun/, /if \(isTrustedEvent\(e\)\) handleSend\(\)/],
    'src/sidebar/RestPanel.jsx': [/onClick=\{trusted\(handleSend\)\}/],
    'src/sidebar/AtfPanel.jsx': [/onClick=\{trusted\(\(\) => handleRun\(s\)\)\}/],
    'src/sidebar/AutomationPanel.jsx': [/onClick=\{trusted\(handleRun\)\}/],
    'src/sidebar/MyWorkPanel.jsx': [/trusted\(\(\) => doSwitch\('set'/, /trusted\(\(\) => doSwitch\(switcher/],
    'src/content/scriptEditor.js': [/button\('Apply & save', 'msb-ed__btn', trustedDom\(/, /button\('Run', 'msb-ed__btn', trustedDom\(/, /event\.isTrusted && apply\(\{ save: event\.shiftKey \}\)/],
    'src/content/commandPalette.js': [/!event\.isTrusted\) return;/, /item\.addEventListener\('click', trustedDom\(/],
  };
  for (const [file, patterns] of Object.entries(expect)) {
    const src = read(file);
    for (const re of patterns) assert.match(src, re, `${file} ${re}`);
  }
});

// ---- hotkey relay -------------------------------------------------------------------------------

test('hotkey relay: synthetic keydowns never relay', () => {
  const palette = { ctrlKey: true, shiftKey: true, altKey: false, code: 'Space', key: ' ' };
  assert.equal(frameHotkeyRelay({ ...palette, isTrusted: false }), null);
  assert.equal(frameHotkeyRelay(palette), null, 'no isTrusted at all');
  assert.deepEqual(frameHotkeyRelay({ ...palette, isTrusted: true }), { action: 'palette' });
  assert.deepEqual(frameHotkeyRelay({ altKey: true, shiftKey: true, ctrlKey: false, code: 'KeyC', isTrusted: true }), { action: 'chat' });
  assert.deepEqual(frameHotkeyRelay({ altKey: true, shiftKey: true, ctrlKey: false, code: 'KeyE', isTrusted: true }), { action: 'editor' });
  assert.equal(frameHotkeyRelay({ key: 'a', code: 'KeyA', isTrusted: true }), null);

  // Navigation keys relay only while the palette is open, and only when real.
  const enter = { key: 'Enter', ctrlKey: false, shiftKey: false, metaKey: false };
  assert.equal(frameHotkeyRelay({ ...enter, isTrusted: true }), null);
  assert.equal(frameHotkeyRelay({ ...enter, isTrusted: false }, { paletteOpen: true }), null);
  assert.deepEqual(frameHotkeyRelay({ ...enter, isTrusted: true }, { paletteOpen: true }), { action: 'key', key: { key: 'Enter', ctrlKey: false, shiftKey: false, metaKey: false } });
  assert.equal(frameHotkeyRelay({ key: 'n', ctrlKey: true, isTrusted: true }, { paletteOpen: true }).action, 'key');

  assert.equal(sanitizeFrameHotkey({ action: 'key', key: { key: 'Delete' } }), null);
  assert.equal(sanitizeFrameHotkey(null), null);
  assert.deepEqual(sanitizeFrameHotkey({ action: 'xray', key: { key: 'Enter' } }), { type: 'FRAME_HOTKEY', action: 'xray' });
});

test('hotkey relay: no window.postMessage path left for page scripts to forge', () => {
  for (const file of ['src/content/index.js', 'src/content/xray.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /addEventListener\(\s*'message'/, `${file} must not act on window messages`);
    assert.doesNotMatch(src, /\.postMessage\(/, `${file} must not relay through postMessage`);
    assert.doesNotMatch(src, /msb-frame-hotkey|msb-palette-state/, file);
  }
  assert.match(read('src/content/index.js'), /frameHotkeyRelay\(event, \{ paletteOpen \}\)/);
  assert.match(read('src/content/xray.js'), /!event\.isTrusted \|\| !isXrayHotkey\(event\)/);
  assert.match(read('src/background/service-worker.js'), /chrome\.tabs\.sendMessage\(sender\.tab\.id, message, \{ frameId: 0 \}\)/);
});

// ---- closed shadow root -------------------------------------------------------------------------

test('the extension UI is mounted in a closed shadow root kept by uiRoot.js', () => {
  let options = null;
  const root = { kind: 'shadow' };
  assert.equal(getUiRoot(), null);
  assert.equal(attachUiRoot({ attachShadow: (o) => ((options = o), root) }), root);
  assert.deepEqual(options, { mode: 'closed' });
  assert.equal(getUiRoot(), root);

  const index = read('src/content/index.js');
  assert.doesNotMatch(index, /mode:\s*'open'/);
  assert.doesNotMatch(index, /\.attachShadow\(/, 'index.js attaches through uiRoot.js');
  assert.match(index, /attachUiRoot\(host\)/);
  assert.doesNotMatch(read('preview/preview.jsx'), /mode:\s*'open'/);
  // Nothing reads the host's shadowRoot to reach our UI.
  for (const file of ['src/content/index.js', 'src/content/toast.js', 'src/content/a11y.js', 'src/content/scriptEditor.js', 'src/content/commandPalette.js', 'src/content/fieldTools.js']) {
    assert.doesNotMatch(read(file), /\.shadowRoot\b/, file);
  }
  // Page-side DOM walks skip the extension host by id.
  assert.equal(UI_HOST_ID, 'mysnowbuddy-root');
  for (const file of ['src/content/controlPage.js', 'src/content/automation.js']) {
    const src = read(file);
    assert.match(src, /const HOST_ID = 'mysnowbuddy-root';/, file);
    assert.match(src, /if \(el\.id === HOST_ID\) continue;/, file);
  }
});
