const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function tokens(block) {
  const map = {};
  [...block.matchAll(/--(msb-[a-z-]+):\s*([^;]+);/g)].forEach((m) => (map[m[1]] = m[2].trim()));
  return map;
}

// The light palette is the first :host block, the dark palette the [data-theme='dark'] block.
const css = read('src/content/theme.css');
const light = tokens(css.slice(css.indexOf(':host {'), css.indexOf('@media (prefers-color-scheme: dark)')));
const dark = tokens(css.slice(css.indexOf(":host([data-theme='dark']) {"), css.indexOf('/* --- Base')));

const hex = (value, palette) => {
  const v = String(value || '').trim();
  const ref = /^var\(--(msb-[a-z-]+)\)$/.exec(v);
  if (ref) return hex(palette[ref[1]], palette);
  return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
};
const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground token, background token, minimum ratio]
const PAIRS = [
  ['msb-fg', 'msb-bg', 7], ['msb-fg-soft', 'msb-bg', 4.5], ['msb-fg-muted', 'msb-bg', 4.5], ['msb-fg-faint', 'msb-bg', 4.5],
  ['msb-fg', 'msb-bg-subtle', 7], ['msb-fg-muted', 'msb-bg-subtle', 4.5], ['msb-fg-muted', 'msb-bg-sunken', 4.5],
  ['msb-fg', 'msb-bg-raised', 7], ['msb-fg-muted', 'msb-bg-raised', 4.5],
  ['msb-accent', 'msb-bg', 4.5], ['msb-accent', 'msb-accent-soft', 4.5], ['msb-active-fg', 'msb-active-bg', 4.5],
  ['msb-accent-fg', 'msb-accent', 4.5], ['msb-on-gradient', 'msb-gradient', 4.5], ['msb-on-gradient', 'msb-aurora', 4.5],
  ['msb-on-danger', 'msb-danger-solid', 4.5], ['msb-danger', 'msb-danger-soft', 4.5], ['msb-danger', 'msb-bg', 4.5],
  ['msb-cat-record', 'msb-cat-record-bg', 3], ['msb-cat-table', 'msb-cat-table-bg', 3], ['msb-cat-analyze', 'msb-cat-analyze-bg', 3],
  ['msb-cat-navigate', 'msb-cat-navigate-bg', 3], ['msb-cat-tools', 'msb-cat-tools-bg', 3],
  ['msb-warn', 'msb-warn-soft', 4.5], ['msb-ok', 'msb-ok-soft', 4.5], ['msb-ok', 'msb-bg', 4.5], ['msb-warn', 'msb-bg', 4.5],
];

for (const [name, palette] of [['light', light], ['dark', dark]]) {
  test(`${name} palette: every text and background pair meets WCAG AA`, () => {
    PAIRS.forEach(([fg, bg, min]) => {
      const f = hex(palette[fg], palette);
      const b = hex(palette[bg], palette);
      assert.ok(f && b, `${name}: ${fg} or ${bg} is not a plain colour`);
      assert.ok(ratio(f, b) >= min, `${name}: ${fg} on ${bg} is ${ratio(f, b).toFixed(2)}:1, needs ${min}`);
    });
  });
}

test('the focus ring is a solid indicator in both palettes, not a faint halo alone', () => {
  assert.match(light['msb-ring'], /0 0 0 2px rgba\([^)]*0\.9\d?\)/);
  assert.match(dark['msb-ring'], /0 0 0 2px rgba\([^)]*0\.9\d?\)/);
});

test('surfaces are flat: no gradients or glows in the tokens', () => {
  [light, dark].forEach((palette) => Object.entries(palette).forEach(([name, value]) => assert.ok(!/gradient\(/.test(value), `${name} is a gradient`)));
});

test('the options page uses the same accent and neutrals as the on-page UI', () => {
  const options = read('src/options/options.css');
  const opt = tokens(options.slice(options.indexOf(':root {'), options.indexOf('@media (prefers-color-scheme: dark)')));
  ['msb-bg', 'msb-fg', 'msb-fg-muted', 'msb-border', 'msb-accent', 'msb-accent-soft', 'msb-accent-line'].forEach((token) => assert.equal(opt[token], light[token], `options ${token}`));
  const optDark = tokens(options.slice(options.indexOf(":root[data-theme='dark'] {")));
  ['msb-bg', 'msb-fg', 'msb-accent', 'msb-accent-soft'].forEach((token) => assert.equal(optDark[token], dark[token], `options dark ${token}`));
});

test('no stylesheet layers a plain colour token before another background (the browser drops the whole declaration, leaving the surface transparent)', () => {
  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir).forEach((name) => {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.css')) files.push(full);
    });
  })(path.join(__dirname, '..', 'src'));
  files.forEach((file) => {
    const bad = fs.readFileSync(file, 'utf8').match(/background:s*var(--msb-[a-z-]+)s*,/g);
    assert.equal(bad, null, `${path.basename(file)}: ${bad}`);
  });
});
