// Calibration driver: opens a visible Chrome window with the BUILT extension loaded, points it at a
// ServiceNow instance, and then runs command files you drop into a folder against that live session.
// You log in yourself in the window; this script never sees or types a password.
//
//   npm i --no-save puppeteer-core && npm run build
//   node preview/driver.js https://devNNNNN.service-now.com <work-dir>
//
// Commands: write <work-dir>/cmds/NAME.js containing the body of an async function; it receives
// { browser, page, fs, path, sleep, log } and may `return` JSON. Output goes to <work-dir>/out/NAME.json.
// Create <work-dir>/stop to close the browser. Local use only: it runs whatever is in cmds/.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const [, , instanceUrl, workDir = path.join(__dirname, '.driver')] = process.argv;
if (!/^https:\/\/[a-z0-9-]+\.service-now\.com\/?$/i.test(instanceUrl || '')) {
  console.error('Usage: node preview/driver.js https://devNNNNN.service-now.com [work-dir]');
  process.exit(2);
}
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DIST = path.join(__dirname, '..', 'dist');
const cmdDir = path.join(workDir, 'cmds');
const outDir = path.join(workDir, 'out');
fs.mkdirSync(cmdDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    pipe: true,
    enableExtensions: [DIST],
    userDataDir: path.join(workDir, 'profile'),
    defaultViewport: null,
    args: ['--no-sandbox', '--window-size=1400,900'],
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  await page.goto(instanceUrl, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto:', e.message));
  log('Browser open. Log in to the instance in that window; commands run once you are in.');

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const ctx = { browser, page, fs, path, sleep, log };
  const seen = new Set();
  let closing = false;
  browser.on('disconnected', () => {
    closing = true;
    log('Browser closed.');
    process.exit(0);
  });
  while (!closing) {
    if (fs.existsSync(path.join(workDir, 'stop'))) {
      await browser.close();
      break;
    }
    for (const file of fs.readdirSync(cmdDir).filter((f) => f.endsWith('.js') && !seen.has(f))) {
      seen.add(file);
      const name = file.replace(/\.js$/, '');
      log('running', name);
      let result;
      try {
        result = { ok: true, result: await new AsyncFunction('ctx', `const { browser, page, fs, path, sleep, log } = ctx;\n${fs.readFileSync(path.join(cmdDir, file), 'utf8')}`)(ctx) };
      } catch (err) {
        result = { ok: false, error: String(err && err.stack ? err.stack : err) };
      }
      fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(result, null, 2));
      log('done', name, result.ok ? 'ok' : 'ERROR');
    }
    await sleep(400);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
