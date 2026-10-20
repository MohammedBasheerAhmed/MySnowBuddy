// Builds the preview harness and serves it on http://localhost:4173/preview.html
// Dev-only: `npm run preview`. Needs `npm run build` first (it reuses dist/content.css).
const esbuild = require('esbuild');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, '.out');
fs.mkdirSync(out, { recursive: true });

async function build() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'preview.jsx')],
    outfile: path.join(out, 'preview.bundle.js'),
    bundle: true,
    format: 'iife',
    sourcemap: true,
    logLevel: 'warning',
    loader: { '.js': 'jsx', '.jsx': 'jsx' },
    jsx: 'automatic',
    target: ['chrome110'],
  });
  const css = path.join(root, 'dist', 'content.css');
  if (!fs.existsSync(css)) throw new Error('dist/content.css is missing. Run `npm run build` first.');
  fs.copyFileSync(css, path.join(out, 'content.css'));
  fs.writeFileSync(
    path.join(out, 'preview.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>NowBuddy preview</title>
<style>body{margin:0;font-family:Segoe UI,system-ui,sans-serif;background:#f3f4f6;color:#222}
.fake{padding:28px 36px;max-width:56vw}.fake h1{font-size:20px;margin:0 0 6px}.fake .bar{height:44px;background:#293e40;margin:-0px 0 18px;margin-left:-36px;margin-right:-36px;margin-top:-28px;color:#fff;display:flex;align-items:center;padding:0 36px;font-weight:600}
.fake .row{display:grid;grid-template-columns:170px 1fr;gap:10px;margin:8px 0;align-items:center}.fake .row label{color:#555}.fake .row .req::after{content:"*";color:#c8232c;margin-left:3px}
.fake .row input{background:#fff;border:1px solid #cfd3d8;border-radius:4px;padding:6px 8px;font:inherit}.fake .row input[readonly]{background:#eef0f2}
.fake table{border-collapse:collapse;width:100%;background:#fff}.fake th,.fake td{border-bottom:1px solid #dde1e5;padding:6px 8px;text-align:left;font-size:13px}</style></head>
<body><div class="fake"></div>
<script src="preview.bundle.js"></script></body></html>`
  );
}

build()
  .then(() => {
    const port = Number(process.env.PORT) || 4173;
    http
      .createServer((req, res) => {
        const file = path.join(out, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'preview.html');
        if (!file.startsWith(out) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.writeHead(404).end('not found');
          return;
        }
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }[path.extname(file)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(fs.readFileSync(file));
      })
      .listen(port, '127.0.0.1', () => console.log(`Preview: http://localhost:${port}/preview.html  (?theme=dark&scenario=server&env=prod&open=api|bench&autonomy=auto-runs)`));
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
