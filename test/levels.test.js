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

/*
 * Two claims, and the second one only applies to banked levels.
 *
 * Every level, banked or derived, has to be winnable by its own route — the
 * game always has an answer it can show you. A BANKED level additionally has to
 * still meet the criterion it was banked against: the generator searched until
 * it found terrain that did, and wrote down what it measured, so a banked level
 * failing now means the bank has drifted from the rules. Regenerate rather than
 * lowering the bar.
 *
 * Derived levels are reported on but not gated. They have never claimed to meet
 * the criterion, and gating on one would be gating on the difficulty curve
 * happening to be lucky at that number.
 */
test('every level can be won by its own route', { timeout: 600000 }, () => {
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'tools', 'verify-levels.js'), '1', '31'],
    { encoding: 'utf8' }
  );
  // Printed whatever happens: the distribution is the number worth watching
  // even on a pass, and a silent green tells you nothing about the curve.
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) process.stderr.write(r.stderr || '');
  assert.strictEqual(
    r.status,
    0,
    'a level shipped that cannot be won by its own route, or a banked level ' +
      'no longer meets the criterion it was banked against'
  );
});
