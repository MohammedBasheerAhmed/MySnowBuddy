// Bundles each tests/*.test.js with esbuild (so tests import src/ ES modules as-is)
// and runs them with the built-in Node test runner.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const outdir = path.join(root, '.test-dist');
fs.rmSync(outdir, { recursive: true, force: true });

const entries = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join(__dirname, f));

esbuild
  .build({
    entryPoints: entries,
    outdir,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'warning',
    loader: { '.js': 'jsx' },
  })
  .then(() => {
    const files = entries.map((f) => path.join(outdir, path.basename(f)));
    const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  })
  .catch(() => process.exit(1));
