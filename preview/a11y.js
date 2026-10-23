// Accessibility check: runs axe-core over the extension's own UI in the preview harness (light and dark),
// then checks the keyboard paths axe cannot see (moving a window with the arrow keys, Esc, focus return).
// Fails on serious or critical violations.
//
//   npm run a11y          (builds first; needs the dev dependencies: npm i)
//   CHROME_PATH=... npm run a11y   if Chrome is not in the default Windows location
//
// The UI's shadow root is closed. The test forces it open (before the page script runs) so axe can look
// inside; nothing in src/ changes. axe checks the host element and, separately, the buttons the on-page
// tools place in the page itself (data-msb-inline).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.A11Y_PORT) || 4199;
const BASE = `http://127.0.0.1:${PORT}/preview.html`;
const FAIL_ON = new Set(['serious', 'critical']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let puppeteer;
let axeSource;
try {
  puppeteer = require('puppeteer-core');
  axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
} catch {
  console.error('Run: npm i   (axe-core and puppeteer-core are dev dependencies)');
  process.exit(2);
}

// name, query string, optional settle time, optional steps run after the page settles.
const SCENARIOS = [
  { name: 'sidebar (chat)', query: '' },
  { name: 'command palette', query: 'palette=open', settle: 700 },
  {
    name: 'command palette with results',
    query: 'palette=open',
    settle: 700,
    steps: async (page) => {
      await page.keyboard.type('incident');
      await sleep(500);
    },
  },
  { name: 'developer guide', query: 'guide=1' },
  { name: 'save trace: idle', query: 'open=savetrace', settle: 1800 },
  {
    name: 'save trace: timeline',
    query: 'open=savetrace',
    settle: 1800,
    steps: async (page) => {
      const click = (label) =>
        page.evaluate((text) => {
          const root = document.getElementById('mysnowbuddy-root').shadowRoot.querySelector('.msb-trace');
          [...root.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(text))?.click();
        }, label);
      await click('Trace the next save');
      await sleep(2500);
      await page.evaluate(() => window.__fake.addSaveTraceRows());
      await sleep(300);
      await click('Collect');
      await sleep(2500);
    },
  },
  { name: 'welcome card', query: 'welcome=1' },
  { name: "what's new card", query: 'whatsnew=1' },
  { name: 'on-page tools: form', query: 'inline=1', settle: 1800 },
  { name: 'on-page tools: list', query: 'inline=1&page=list', settle: 1800 },
  { name: 'on-page tools: field popover', query: 'inline=1', settle: 1800, trustedClick: '[data-msb-inline="btn"]' },
  {
    name: 'smart selection: JSON popover',
    query: 'inline=1',
    settle: 1800,
    steps: async (page) => {
      // A real, trusted drag over a JSON blob: the popover must name what it is and offer its actions.
      const box = await page.evaluate(() => {
        const p = document.createElement('div');
        p.id = 'smart-sample';
        p.textContent = '{"number":"INC0010042","state":2,"tags":["vpn","laptop"]}';
        p.style.cssText = 'display:table;font:13px monospace;margin:14px 0;padding:4px';
        document.querySelector('.fake').appendChild(p);
        p.scrollIntoView({ block: 'center' });
        const r = p.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      await page.mouse.move(box.x + 2, box.y + 6);
      await page.mouse.down();
      await page.mouse.move(box.x + box.w - 3, box.y + box.h - 6, { steps: 8 });
      await page.mouse.up();
      await sleep(900);
    },
  },
  { name: 'confirmation dialog (danger)', query: 'confirm=1', settle: 1200 },
  { name: 'confirmation dialog', query: 'confirm=safe', settle: 1200 },
  { name: 'floating window: health scan', query: 'open=health', settle: 900 },
  { name: 'floating window: X-ray', query: 'open=xray', settle: 900 },
  { name: 'floating window: change impact', query: 'open=impact', settle: 900 },
  { name: 'floating window: what changed lately', query: 'open=recent', settle: 1800 },
  { name: 'floating window: release notes', query: 'open=releasenotes', settle: 1200 },
  { name: 'floating window: REST builder', query: 'open=rest', settle: 900 },
  {
    name: 'floating window: what went wrong',
    query: 'open=failures',
    settle: 2200,
    steps: async (page) => {
      // Open the first problem so the raw message, the occurrence list and the actions are checked too.
      await page.evaluate(() => document.getElementById('mysnowbuddy-root').shadowRoot.querySelector('.msb-fail__group summary')?.click());
      await sleep(300);
    },
  },
  { name: 'floating window: why didn\'t my rule run', query: 'open=whyrule', settle: 1600 },
  {
    name: 'floating window: break this list down (by value, compare)',
    query: 'inline=1&page=list&open=insight',
    settle: 2200,
    steps: async (page) => {
      // Compare mode ticked and two bars picked, so the pressed state and the comparison text are checked too.
      await page.evaluate(() => {
        const root = document.getElementById('mysnowbuddy-root').shadowRoot.querySelector('.msb-insight');
        root.querySelector('input[type=checkbox]')?.click();
      });
      await sleep(200);
      await page.evaluate(() => {
        const bars = document.getElementById('mysnowbuddy-root').shadowRoot.querySelectorAll('.msb-insight__bar');
        bars[0]?.click();
        bars[1]?.click();
      });
      await sleep(300);
    },
  },
  {
    name: 'floating window: break this list down (over time)',
    query: 'inline=1&page=list&open=insight',
    settle: 2200,
    steps: async (page) => {
      const press = (text) =>
        page.evaluate((t) => {
          const root = document.getElementById('mysnowbuddy-root').shadowRoot.querySelector('.msb-insight');
          [...root.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(t))?.click();
        }, text);
      await press('Over time');
      await sleep(300);
      await press('Show');
      await sleep(2200);
    },
  },
  { name: 'floating window: what points at this record (user)', query: 'inline=1&open=refs&record=sys_user:abel.tuter', settle: 2800 },
];

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      http
        .get(`http://127.0.0.1:${PORT}/preview.html`, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => (Date.now() - started > 20000 ? reject(new Error('preview server did not start')) : setTimeout(tick, 250)));
    };
    tick();
  });
}

const describeNode = (n) => `${n.target.join(' > ')}`.slice(0, 140);

async function runAxe(page) {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const include = [['#mysnowbuddy-root']];
    if (document.querySelector('[data-msb-inline]')) include.push(['[data-msb-inline]']);
    const res = await axe.run({ include }, { resultTypes: ['violations'] });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })) }));
  });
}

let failures = 0;
const record = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

// Runs in the page before any script: lets axe look inside the otherwise closed shadow root.
function forceOpenShadow() {
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attach(init) {
    return original.call(this, { ...init, mode: 'open' });
  };
}

async function keyboardChecks(browser, theme) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(forceOpenShadow);
  await page.goto(`${BASE}?theme=${theme}&open=health`, { waitUntil: 'load' });
  await sleep(1200);
  const state = () =>
    page.evaluate(() => {
      const shadow = document.getElementById('mysnowbuddy-root').shadowRoot;
      const win = shadow.querySelector('.msb-win');
      if (!win) return null;
      const r = win.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), active: shadow.activeElement?.className || '', activeIsWin: shadow.activeElement === win };
    });
  const tag = `[${theme}] window keyboard:`;
  const first = await state();
  record(Boolean(first), `${tag} a window opened`);
  if (!first) {
    await page.close();
    return;
  }
  record(first.activeIsWin, `${tag} focus moves into the window when it opens`);

  await page.keyboard.press('Tab');
  const onBar = await state();
  record(String(onBar.active).includes('msb-win__bar'), `${tag} Tab reaches the title bar`, onBar.active);
  await page.keyboard.press('ArrowLeft');
  const left = await state();
  record(left.x === first.x - 16 && left.y === first.y, `${tag} ArrowLeft moves it 16px`, `${first.x} -> ${left.x}`);
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.up('Shift');
  const down = await state();
  record(down.y === left.y + 64, `${tag} Shift+ArrowDown moves it 64px`, `${left.y} -> ${down.y}`);
  await page.keyboard.down('Alt');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Alt');
  const wide = await state();
  record(wide.w === down.w + 16 && wide.x === down.x, `${tag} Alt+ArrowRight widens it by 16px`, `${down.w} -> ${wide.w}`);
  for (let i = 0; i < 40; i += 1) await page.keyboard.press('ArrowUp');
  const top = await state();
  record(top.y >= 0, `${tag} it cannot be moved off the top`, `y=${top.y}`);
  await page.keyboard.press('Escape');
  await sleep(300);
  record((await state()) === null, `${tag} Escape on the title bar closes it`);
  await page.close();
}

async function openPage(browser, query) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(forceOpenShadow);
  await page.goto(`${BASE}?${query}`, { waitUntil: 'load' });
  await sleep(1500);
  return page;
}

const shadowActive = (page) =>
  page.evaluate(() => {
    const shadow = document.getElementById('mysnowbuddy-root').shadowRoot;
    const a = shadow.activeElement;
    return a ? `${a.tagName.toLowerCase()}.${a.className}` : document.activeElement?.tagName.toLowerCase();
  });

async function paletteChecks(browser, theme) {
  const tag = `[${theme}] palette keyboard:`;
  const page = await openPage(browser, `theme=${theme}&palette=1`);
  await page.evaluate(() => {
    document.querySelector('.fake input:not([type=hidden])').focus();
    window.__msb.palette.open();
  });
  await sleep(700);
  const hidden = () => page.evaluate(() => window.__msb.palette.element.hidden);
  record(!(await hidden()) && (await shadowActive(page)).includes('msb-palette__input'), `${tag} opens with focus in the search box`);
  await page.keyboard.press('ArrowDown');
  const active = await page.evaluate(() => {
    const input = window.__msb.palette.element.querySelector('input');
    const option = window.__msb.palette.element.querySelector(`#${input.getAttribute('aria-activedescendant')}`);
    return option?.getAttribute('aria-selected');
  });
  record(active === 'true', `${tag} ArrowDown moves the announced option (aria-activedescendant)`);
  await page.keyboard.press('Escape');
  await sleep(200);
  const back = await page.evaluate(() => document.activeElement === document.querySelector('.fake input:not([type=hidden])'));
  record((await hidden()) && back, `${tag} Escape closes it and returns focus to the page field`);
  await page.close();
}

async function popoverChecks(browser, theme) {
  const tag = `[${theme}] popover keyboard:`;
  const page = await openPage(browser, `theme=${theme}&inline=1`);
  await sleep(1000);
  const box = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-msb-inline="btn"]')].find((b) => b.getBoundingClientRect().width > 0);
    const r = btn?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (box) await page.mouse.click(box.x, box.y);
  await sleep(900);
  const open = () => page.evaluate(() => !document.getElementById('mysnowbuddy-root').shadowRoot.querySelector('.msb-pop').hidden);
  record(await open(), `${tag} a field menu opens`);
  const first = await shadowActive(page);
  await page.keyboard.press('ArrowDown');
  const second = await shadowActive(page);
  record(first !== second || (await page.evaluate(() => document.getElementById('mysnowbuddy-root').shadowRoot.querySelectorAll('.msb-pop button').length)) < 3, `${tag} arrow keys move between its buttons`, `${first} -> ${second}`);
  await page.keyboard.press('Escape');
  await sleep(200);
  record(!(await open()), `${tag} Escape closes it`);
  await page.close();
}

async function confirmChecks(browser, theme) {
  const tag = `[${theme}] confirm dialog:`;
  const page = await openPage(browser, `theme=${theme}&confirm=1`);
  await sleep(600);
  const info = () =>
    page.evaluate(() => {
      const shadow = document.getElementById('mysnowbuddy-root').shadowRoot;
      const card = shadow.querySelector('.msb-confirm:not([hidden]) .msb-confirm__card');
      return { open: Boolean(card), active: shadow.activeElement?.textContent || '', result: window.__confirmResult, modal: card?.getAttribute('aria-modal') };
    });
  const first = await info();
  record(first.open && first.modal === 'true', `${tag} opens as a modal alert dialog`);
  record(first.active === 'Cancel', `${tag} a dangerous action focuses Cancel`, first.active);
  await page.keyboard.press('Tab');
  const second = await info();
  record(/Save to production/.test(second.active), `${tag} Tab reaches the action button`, second.active);
  await page.keyboard.press('Tab');
  const wrapped = await info();
  record(wrapped.active === 'Cancel', `${tag} Tab wraps inside the dialog`, wrapped.active);
  // A script-made click on the action button must not confirm it.
  await page.evaluate(() => {
    const shadow = document.getElementById('mysnowbuddy-root').shadowRoot;
    [...shadow.querySelectorAll('.msb-confirm button')].find((b) => /Save to production/.test(b.textContent)).click();
  });
  await sleep(200);
  record((await info()).open && (await info()).result === 'pending', `${tag} a page script's click does not confirm`);
  await page.keyboard.press('Escape');
  await sleep(300);
  const done = await info();
  record(!done.open && done.result === 'no', `${tag} Escape cancels`, done.result);
  await page.close();
}

async function sidebarChecks(browser, theme) {
  const tag = `[${theme}] sidebar keyboard:`;
  const page = await openPage(browser, `theme=${theme}`);
  const resizer = () =>
    page.evaluate(() => {
      const el = document.getElementById('mysnowbuddy-root').shadowRoot.querySelector('.msb-sidebar__resizer');
      return Number(el.getAttribute('aria-valuenow'));
    });
  const before = await resizer();
  await page.evaluate(() => document.getElementById('mysnowbuddy-root').shadowRoot.querySelector('.msb-sidebar__resizer').focus());
  await page.keyboard.press('ArrowLeft');
  const after = await resizer();
  record(after === before + 16, `${tag} the resize separator is focusable and ArrowLeft widens by 16px`, `${before} -> ${after}`);
  await page.evaluate(() => document.getElementById('mysnowbuddy-root').shadowRoot.querySelector('button[aria-label="Theme"]').focus());
  await page.keyboard.press('Enter');
  await sleep(200);
  const inMenu = (await shadowActive(page)).includes('msb-sidebar__menu-item');
  record(inMenu, `${tag} the theme menu takes focus when opened`);
  await page.keyboard.press('Escape');
  await sleep(200);
  const onButton = await page.evaluate(() => document.getElementById('mysnowbuddy-root').shadowRoot.activeElement?.getAttribute('aria-label') === 'Theme');
  record(onButton, `${tag} Escape closes the theme menu and returns focus to its button`);
  await page.close();
}

// The options page needs the chrome.* APIs, so it is loaded from the built extension (as preview/smoke.js does).
async function optionsChecks() {
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', pipe: true, enableExtensions: [path.join(root, 'dist')], args: ['--no-sandbox'] });
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.bundle.js'), { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage();
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await page.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'load' });
      await sleep(900);
      await page.evaluate(axeSource);
      const violations = await page.evaluate(async () => (await axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target })) })));
      const blocking = violations.filter((v) => FAIL_ON.has(v.impact));
      record(blocking.length === 0, `[${scheme}] options page`, violations.length ? `${violations.length} finding(s), ${blocking.length} serious/critical` : '');
      violations.forEach((v) => {
        console.log(`        ${FAIL_ON.has(v.impact) ? 'x' : '-'} ${v.impact} ${v.id}: ${v.help} (${v.nodes.length})`);
        v.nodes.slice(0, 3).forEach((n) => console.log(`            ${describeNode(n)}`));
      });
      await page.close();
    }
  } catch (err) {
    console.log(`SKIP  options page (could not load the extension in this Chrome: ${err.message})`);
  } finally {
    await browser?.close();
  }
}

(async () => {
  const build = spawnSync(process.execPath, [path.join(root, 'build.js')], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) {
    console.error(`${build.stdout.slice(-1500)}\n${build.stderr.slice(-1500)}`);
    process.exit(1);
  }
  const server = spawn(process.execPath, [path.join(__dirname, 'serve.js')], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  let browser;
  try {
    await waitForServer();
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
    for (const theme of ['light', 'dark']) {
      for (const scenario of SCENARIOS) {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.evaluateOnNewDocument(forceOpenShadow);
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${BASE}?theme=${theme}${scenario.query ? `&${scenario.query}` : ''}`, { waitUntil: 'load' });
        await sleep(scenario.settle || 800);
        if (scenario.trustedClick) {
          // A real mouse click: the on-page buttons ignore script-made clicks.
          const box = await page.evaluate((sel) => {
            const found = [...document.querySelectorAll(sel)].find((n) => n.getBoundingClientRect().width > 0);
            const r = found?.getBoundingClientRect();
            return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
          }, scenario.trustedClick);
          if (box) await page.mouse.click(box.x, box.y);
          await sleep(900);
        } else if (scenario.steps) {
          await scenario.steps(page);
        }
        const violations = await runAxe(page);
        const blocking = violations.filter((v) => FAIL_ON.has(v.impact));
        const label = `[${theme}] ${scenario.name}`;
        record(blocking.length === 0 && errors.length === 0, label, violations.length ? `${violations.length} finding(s), ${blocking.length} serious/critical` : '');
        violations.forEach((v) => {
          console.log(`        ${FAIL_ON.has(v.impact) ? 'x' : '-'} ${v.impact} ${v.id}: ${v.help} (${v.nodes.length})`);
          v.nodes.slice(0, 3).forEach((n) => console.log(`            ${describeNode(n)}`));
        });
        errors.forEach((e) => console.log(`        page error: ${e}`));
        await page.close();
      }
      await keyboardChecks(browser, theme);
      await paletteChecks(browser, theme);
      await popoverChecks(browser, theme);
      await sidebarChecks(browser, theme);
      await confirmChecks(browser, theme);
    }
  } finally {
    await browser?.close();
    server.kill();
  }
  await optionsChecks();
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll accessibility checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
