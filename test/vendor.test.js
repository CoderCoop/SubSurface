'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

/*
 * The game ships as static files, so the physics engine is committed under
 * docs/play/vendor/ rather than resolved from node_modules at runtime. That
 * means two copies exist, and nothing but this test stops them drifting: bump
 * the dependency, forget `npm run vendor`, and the tests keep passing against
 * the new version while players keep getting the old one.
 */
test('the vendored physics engine matches the installed one', () => {
  const installed = path.join(root, 'node_modules', 'planck', 'dist', 'planck.min.js');
  const vendored = path.join(root, 'docs', 'play', 'vendor', 'planck.min.js');

  assert.ok(fs.existsSync(vendored), 'docs/play/vendor/planck.min.js is missing');
  assert.ok(fs.existsSync(installed), 'planck is not installed — run npm install');

  assert.strictEqual(
    fs.readFileSync(vendored, 'utf8'),
    fs.readFileSync(installed, 'utf8'),
    'vendored planck differs from the installed one — run `npm run vendor`'
  );
});

test('every file the service worker precaches actually exists', () => {
  const play = path.join(root, 'docs', 'play');
  const sw = fs.readFileSync(path.join(play, 'sw.js'), 'utf8');

  const block = sw.match(/var SHELL = \[([\s\S]*?)\];/);
  assert.ok(block, 'could not find the SHELL list in sw.js');

  const entries = block[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  assert.ok(entries.length > 5, `expected a populated shell list, got ${entries.length}`);

  for (const entry of entries) {
    // './' is the directory itself, served as index.html.
    const rel = entry === './' ? './index.html' : entry;
    const file = path.join(play, rel);
    assert.ok(
      fs.existsSync(file),
      `sw.js precaches ${entry}, which does not exist — install would fail`
    );
  }
});

test('the manifest icons exist and are declared consistently', () => {
  const play = path.join(root, 'docs', 'play');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(play, 'manifest.webmanifest'), 'utf8')
  );

  assert.ok(manifest.icons.length >= 2, 'need at least a 192 and a 512');
  for (const icon of manifest.icons) {
    assert.ok(
      fs.existsSync(path.join(play, icon.src)),
      `manifest references ${icon.src}, which does not exist`
    );
  }

  // An installable PWA needs a 192 and a 512, and Android wants a maskable.
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'), 'missing a 192x192 icon');
  assert.ok(sizes.includes('512x512'), 'missing a 512x512 icon');
  assert.ok(
    manifest.icons.some((i) => (i.purpose || '').includes('maskable')),
    'missing a maskable icon'
  );

  assert.strictEqual(manifest.display, 'standalone');
  assert.strictEqual(manifest.start_url, '.', 'start_url must be relative — the app is served from a subdirectory');
  assert.strictEqual(manifest.scope, '.', 'scope must be relative — the app is served from a subdirectory');
});
