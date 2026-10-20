const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prodGuardAsk, automationClickAsk, syntaxAsk, prodApplySaveAsk, runScriptAsk, runWritesAsk, discardAsk, clearHistoryAsk, atfRunAsk, deletePromptAsk } = require('../src/lib/confirmCopy.js');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('every confirmation names its action on the button and never says OK', () => {
  const asks = [
    prodGuardAsk('save', 'sys_script'),
    prodGuardAsk('delete', 'sys_script'),
    automationClickAsk('Delete'),
    syntaxAsk('apply', { line: 3, message: 'Unexpected token' }),
    syntaxAsk('run', { line: 3, message: 'Unexpected token' }),
    prodApplySaveAsk(),
    runScriptAsk({ hostname: 'dev1.service-now.com' }),
    runWritesAsk(2),
    discardAsk('close'),
    discardAsk('switch'),
    clearHistoryAsk(),
    atfRunAsk('Smoke', 'dev1.service-now.com'),
    deletePromptAsk('My prompt'),
  ];
  asks.forEach((ask) => {
    assert.ok(ask.title.length > 5, ask.title);
    assert.ok(ask.message.length > 15, ask.title);
    assert.ok(ask.confirmLabel && !/^(ok|yes|continue)$/i.test(ask.confirmLabel), `${ask.title}: ${ask.confirmLabel}`);
  });
});

test('wording says what happens to what, and production is dangerous', () => {
  assert.match(prodGuardAsk('delete', 'sys_ui_policy').title, /Delete sys_ui_policy configuration on production/);
  assert.equal(prodGuardAsk('save', 'x').confirmLabel, 'Save to production');
  assert.equal(prodGuardAsk('save', 'x').danger, true);
  assert.match(syntaxAsk('run', { line: 7, message: 'bad' }).title, /line 7/);
  assert.equal(syntaxAsk('run', { line: 7, message: 'bad' }).confirmLabel, 'Run anyway');
  assert.equal(syntaxAsk('apply', { line: 7, message: 'bad' }).confirmLabel, 'Apply anyway');
  assert.match(runWritesAsk(1).message, /1 write operation and/);
  assert.match(runWritesAsk(3).message, /3 write operations/);
  assert.equal(discardAsk('close').cancelLabel, 'Keep editing');
});

test('a live script run is dangerous on production or when it writes, and lists the writes', () => {
  assert.equal(runScriptAsk({ hostname: 'dev.service-now.com' }).danger, false);
  assert.equal(runScriptAsk({ prod: true }).danger, true);
  assert.match(runScriptAsk({ prod: true, part: true }).title, /PRODUCTION/);
  const writes = runScriptAsk({ hostname: 'dev.service-now.com', riskSummary: 'gr.update() on incident' });
  assert.equal(writes.danger, true);
  assert.equal(writes.details, 'gr.update() on incident');
});

test('long names are clipped in titles', () => {
  const title = deletePromptAsk('x'.repeat(300)).title;
  assert.ok(title.length < 100, title.length);
  assert.ok(atfRunAsk('y'.repeat(300), 'h').title.length < 120);
});

test('no native browser dialogs are left in the extension (they freeze the page and the browser tool)', () => {
  const walk = (dir) => fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  const offenders = walk('src')
    .filter((f) => /\.(js|jsx)$/.test(f) && !f.startsWith('src/lib/apiCatalog') && !f.startsWith('src/lib/skills') && f !== 'src/content/confirmDialog.js')
    .filter((f) => /(^|[^.\w])(window\.)?(confirm|prompt|alert)\(/.test(read(f).replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''")));
  assert.deepEqual(offenders, []);
});

test('the dialog only counts real input and keeps its text out of innerHTML', () => {
  const src = read('src/content/confirmDialog.js');
  assert.match(src, /cancel\.addEventListener\('click', trustedDom\(/);
  assert.match(src, /ok\.addEventListener\('click', trustedDom\(/);
  assert.match(src, /event\.isTrusted !== true\) return;/);
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML/);
  assert.match(src, /role', 'alertdialog'/);
  assert.match(src, /aria-modal', 'true'/);
});

test('the production guard holds the click, asks, and replays it once instead of asking synchronously', () => {
  const src = read('src/content/guards.js');
  assert.match(src, /event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);/);
  assert.match(src, /askConfirm\(prodGuardAsk\(/);
  assert.match(src, /replaying = button;\s*button\.click\(\)/);
  assert.match(src, /button\.isConnected/);
});
