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
  {
    // Sandboxed page (manifest "sandbox"): the only place script text is evaluated.
    entryPoints: [path.join(rootDir, 'src/sandbox/sandbox.js')],
    outfile: path.join(outdir, 'sandbox.bundle.js'),
    format: 'iife',
  },
  {
    // Offscreen document that hosts the sandbox iframe for the service worker.
    entryPoints: [path.join(rootDir, 'src/offscreen/offscreen.js')],
    outfile: path.join(outdir, 'offscreen.bundle.js'),
    format: 'iife',
  },
];

function copyStatic() {
  fs.copyFileSync(path.join(rootDir, 'manifest.json'), path.join(outdir, 'manifest.json'));
  fs.mkdirSync(path.join(outdir, 'icons'), { recursive: true });
  fs.readdirSync(path.join(rootDir, 'assets/icons')).forEach((file) => fs.copyFileSync(path.join(rootDir, 'assets/icons', file), path.join(outdir, 'icons', file)));
  fs.copyFileSync(path.join(rootDir, 'src/options/options.html'), path.join(outdir, 'options.html'));
  fs.copyFileSync(path.join(rootDir, 'src/options/options.css'), path.join(outdir, 'options.css'));
  fs.copyFileSync(path.join(rootDir, 'src/sandbox/sandbox.html'), path.join(outdir, 'sandbox.html'));
  fs.copyFileSync(path.join(rootDir, 'src/offscreen/offscreen.html'), path.join(outdir, 'offscreen.html'));

  const combinedCss = [
    fs.readFileSync(path.join(rootDir, 'src/content/theme.css'), 'utf8'),
    fs.readFileSync(path.join(rootDir, 'src/content/toolbar.css'), 'utf8'),
    fs.readFileSync(path.join(rootDir, 'src/content/popover.css'), 'utf8'),
    fs.readFileSync(path.join(rootDir, 'src/content/inline.css'), 'utf8'),
    fs.readFileSync(path.join(rootDir, 'src/content/welcome.css'), 'utf8'),
    fs.readFileSync(path.join(rootDir, 'src/content/guide.css'), 'utf8'),
    fs.readFileSync(path.join(rootDir, 'src/content/editor.css'), 'utf8'),
    fs.readFileSync(path.join(rootDir, 'src/content/confirm.css'), 'utf8'),
    fs.readFileSync(path.join(rootDir, 'src/sidebar/sidebar.css'), 'utf8'),
    fs.readFileSync(path.join(rootDir, 'src/sidebar/agent.css'), 'utf8'),
    // Feature panels (src/sidebar/panelRegistry.js) keep their styles in their own file next to the panel.
    ...fs
      .readdirSync(path.join(rootDir, 'src/sidebar'))
      .filter((f) => f.endsWith('.css') && f !== 'sidebar.css' && f !== 'agent.css')
      .sort()
      .map((f) => fs.readFileSync(path.join(rootDir, 'src/sidebar', f), 'utf8')),
  ].join('\n');
  fs.writeFileSync(path.join(outdir, 'content.css'), combinedCss);
}

// The MCP server (mcp/snowbuddy-mcp.js) reads these so tools/list and the skill
// resources work before the extension has connected. Generated, not committed.
async function writeMcpSnapshots() {
  // Per process, so two builds running at once do not delete each other's snapshot.
  const tmpDir = path.join(rootDir, `.build-tmp-${process.pid}`);
  const tmpFile = path.join(tmpDir, 'snapshot.cjs');
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/lib/agent/snapshot.js')],
    outfile: tmpFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    loader: { '.js': 'jsx' },
  });
  delete require.cache[require.resolve(tmpFile)];
  const { TOOL_SCHEMAS, skillResources } = require(tmpFile);
  const outDir = path.join(rootDir, 'mcp', 'generated');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'tools.json'),
    JSON.stringify(TOOL_SCHEMAS.map(({ name, description, inputSchema, tier }) => ({ name, description, inputSchema, tier })), null, 2)
  );
  fs.writeFileSync(path.join(outDir, 'skills.json'), JSON.stringify(skillResources(), null, 2));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function run() {
  if (isWatch) {
    const contexts = await Promise.all(builds.map((b) => esbuild.context({ ...commonOptions, ...b })));
    copyStatic();
    await writeMcpSnapshots();
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('Watching for changes... (static files are copied once at startup; re-run "npm run build" if you edit manifest.json/options.html/css)');
  } else {
    await Promise.all(builds.map((b) => esbuild.build({ ...commonOptions, ...b })));
    copyStatic();
    await writeMcpSnapshots();
    console.log('Build complete. Load the "dist" folder as an unpacked extension in Chrome/Edge.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
