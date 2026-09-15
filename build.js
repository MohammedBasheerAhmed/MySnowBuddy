const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');
const rootDir = __dirname;
const outdir = path.join(rootDir, 'dist');

if (!fs.existsSync(outdir)) {
  fs.mkdirSync(outdir, { recursive: true });
}

const commonOptions = {
  bundle: true,
  minify: false,
  sourcemap: true,
  logLevel: 'info',
  loader: { '.js': 'jsx', '.jsx': 'jsx' },
  jsx: 'automatic',
  target: ['chrome110', 'edge110'],
};

const builds = [
  {
    entryPoints: [path.join(rootDir, 'src/content/index.js')],
    outfile: path.join(outdir, 'content.bundle.js'),
    format: 'iife',
  },
  {
    entryPoints: [path.join(rootDir, 'src/background/service-worker.js')],
    outfile: path.join(outdir, 'background.bundle.js'),
    format: 'iife',
  },
  {
    entryPoints: [path.join(rootDir, 'src/options/index.jsx')],
    outfile: path.join(outdir, 'options.bundle.js'),
    format: 'iife',
  },
  {
    // Runs in the ServiceNow page's own JS world (injected as a script tag),
    // so it must be a self-contained IIFE with no module wrapper.
    entryPoints: [path.join(rootDir, 'src/page/bridge.js')],
    outfile: path.join(outdir, 'pagebridge.js'),
    format: 'iife',
  },
];

function copyStatic() {
  fs.copyFileSync(path.join(rootDir, 'manifest.json'), path.join(outdir, 'manifest.json'));
  fs.copyFileSync(path.join(rootDir, 'src/options/options.html'), path.join(outdir, 'options.html'));
  fs.copyFileSync(path.join(rootDir, 'src/options/options.css'), path.join(outdir, 'options.css'));

  const combinedCss = [
    fs.readFileSync(path.join(rootDir, 'src/content/theme.css'), 'utf8'),
    fs.readFileSync(path.join(rootDir, 'src/content/toolbar.css'), 'utf8'),
    fs.readFileSync(path.join(rootDir, 'src/sidebar/sidebar.css'), 'utf8'),
  ].join('\n');
  fs.writeFileSync(path.join(outdir, 'content.css'), combinedCss);
}

async function run() {
  if (isWatch) {
    const contexts = await Promise.all(builds.map((b) => esbuild.context({ ...commonOptions, ...b })));
    copyStatic();
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('Watching for changes... (static files are copied once at startup; re-run "npm run build" if you edit manifest.json/options.html/css)');
  } else {
    await Promise.all(builds.map((b) => esbuild.build({ ...commonOptions, ...b })));
    copyStatic();
    console.log('Build complete. Load the "dist" folder as an unpacked extension in Chrome/Edge.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
