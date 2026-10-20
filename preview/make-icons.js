// Renders assets/logo.svg (the round mark from the page toolbar) to the extension icon sizes in assets/icons/.
//   node preview/make-icons.js     (needs puppeteer-core and Chrome, like preview/a11y.js)
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'assets/logo.svg'), 'utf8');
const SIZES = [16, 32, 48, 128];

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  for (const size of SIZES) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: path.join(root, `assets/icons/icon-${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
  await browser.close();
  console.log(`Wrote ${SIZES.length} icons to assets/icons/`);
})();
