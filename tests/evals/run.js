// Live eval driver: `npm run eval -- [--live] [--only=<id substring>] [--no-guide]`
//
// Without --live it only explains what to do (the offline eval already runs in
// `npm test`). With --live it needs ANTHROPIC_API_KEY or OPENAI_API_KEY, spends
// real tokens (about 13 short requests), and prints a pass rate. Use --no-guide
// to measure what the skill guide adds over a bare model.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

if (!process.argv.includes('--live')) {
  console.log('Offline evals run as part of `npm test` (tests/evals.test.js).');
  console.log('Score a real model with:  ANTHROPIC_API_KEY=... npm run eval -- --live [--only=client] [--no-guide]');
  process.exit(0);
}

const root = path.join(__dirname, '..', '..');
const out = path.join(root, '.test-dist', 'live-eval.cjs');
fs.mkdirSync(path.dirname(out), { recursive: true });

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'live.js')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'warning',
    loader: { '.js': 'jsx' },
  })
  .then(() => require(out).main(process.argv.slice(2), process.env))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
