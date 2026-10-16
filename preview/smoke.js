// Loads the BUILT extension (dist/) in a real Chrome and exercises what can be
// exercised without a ServiceNow login: service worker start-up, the offscreen +
// sandbox simulator round trip, sender checks, and the Options page.
//
//   npm i --no-save puppeteer-core && npm run build && node preview/smoke.js
//   (set CHROME_PATH if Chrome is not in the default Windows location)
const path = require('path');

let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch {
  console.error('Run: npm i --no-save puppeteer-core');
  process.exit(2);
}

const DIST = path.join(__dirname, '..', 'dist');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', pipe: true, enableExtensions: [DIST], args: ['--no-sandbox'] });
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.bundle.js'), { timeout: 15000 });
  check('service worker starts', true);
  const sw = await swTarget.worker();

  const r = await sw.evaluate(async () => {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['IFRAME_SCRIPTING'], justification: 'smoke test' });
    const send = (payload) => chrome.runtime.sendMessage({ target: 'offscreen', payload });
    return {
      good: await send({ action: 'syntax', code: 'function a() { return 1; }' }),
      bad: await send({ action: 'syntax', code: 'function a( { return 1; }' }),
      run: await send({ action: 'runClient', clientType: 'onChange', code: "function onChange(c,o,n,l){ if(l||n==='')return; g_form.setMandatory('x', n==='1'); }", scenario: { fields: { x: '' }, newValue: '1' } }),
      dom: await send({ action: 'runClient', clientType: 'onLoad', code: "function onLoad(){ document.getElementById('x'); }", scenario: {} }),
    };
  });
  check('sandbox accepts valid syntax', r.good.ok && r.good.error === null);
  check('sandbox rejects invalid syntax', r.bad.ok && Boolean(r.bad.error));
  check('simulator runs a client script', r.run.run?.ok && r.run.run.finalFields.x.mandatory === true);
  check('simulator blocks DOM access', r.dom.run?.ok === false && /DOM access/.test(r.dom.run.error.message));

  const extId = new URL(swTarget.url()).host;
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${extId}/options.html`);
  await new Promise((res) => setTimeout(res, 600));
  const send = (message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message);
  check('provider info answers', (await send({ type: 'GET_PROVIDER_INFO' })).ok === true);
  check('sandbox refuses a non-ServiceNow sender', (await send({ type: 'SANDBOX_RUN', payload: { action: 'syntax', code: '1' } })).ok === false);
  check('agent step refuses a non-ServiceNow sender', (await send({ type: 'AGENT_STEP', payload: { messages: [{ role: 'user', content: 'hi' }] } })).ok === false);
  check('options page has no script errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
