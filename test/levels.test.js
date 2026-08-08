'use strict';

/*
 * Level quality, as part of the ordinary test run.
 *
 * This lives in the test suite rather than in a CI job of its own for two
 * reasons: it is the same kind of claim as everything else here — a rule the
 * game has to obey — and node's runner gives files a process each, so it runs
 * alongside the other suites instead of after them.
 *
 * The check itself forks a pool; see tools/verify-levels.js for why.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('every level can be won by its own route', { timeout: 600000 }, () => {
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'tools', 'verify-levels.js'), '1', '16'],
    { encoding: 'utf8' }
  );
  // Printed whatever happens: the interest figure is the number worth watching
  // even on a pass, and a silent green tells you nothing about the curve.
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) process.stderr.write(r.stderr || '');
  assert.strictEqual(r.status, 0, 'a level with no winning route shipped');
});
