'use strict';

/*
 * The level generator.
 *
 *   node tools/generate-levels.js [first] [last] [--seed N] [--tries N]
 *                                 [--keep N] [--out FILE] [--missing]
 *
 * `tries` bounds a level that is going badly; `keep` bounds one that is going
 * well — see search() for why those need separate budgets.
 *
 * Samples level specs, plays each one through the solver, and banks the best
 * that meets the criterion for its number. The bank it writes is what the game
 * loads; anything it fails to fill falls back to the difficulty curve, so a
 * short bank is a smaller game rather than a broken one.
 *
 * This does NOT run in CI. It is minutes per level by design — the judge plays
 * the level rather than reasoning about it, which is the whole reason to trust
 * what it says. CI checks the bank that came out; see verify-levels.js.
 *
 * A run is deterministic: same first/last/seed, same bank, byte for byte. That
 * is what makes a regenerated bank reviewable as a diff rather than as a new
 * file every time.
 */

const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const { load, save, plainSpec } = require('./bank.js');
const { GRID_W, GRID_H } = require('./solve.js');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? dflt : argv[i + 1];
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

const from = Number(positional[0] || 1);
const to = Number(positional[1] || 20);
const seed = Number(flag('seed', 1));
const tries = Number(flag('tries', 40));
const keep = Number(flag('keep', 4));
const out = flag('out', undefined);
/*
 * A run ALWAYS merges over whatever is already banked. There used to be a
 * --fresh flag that skipped the merge, on the theory that a scratch --out
 * file should hold only the range searched — and one run with the flag and
 * WITHOUT --out replaced the whole shipping bank with a single level. The
 * only thing --fresh ever did beyond that was psychological (a range is
 * re-searched whether or not it is banked unless --missing says otherwise),
 * so the flag is gone: fixing one stretch of the game must never be able to
 * discard the rest, whatever flags the run was started with.
 */
if (argv.indexOf('--fresh') !== -1)
  process.stdout.write('--fresh is gone: runs always merge over the existing bank\n');
// Only search levels the bank does not already have. This is what makes a
// multi-seed top-up affordable: each pass hunts the holdouts instead of
// re-deriving the levels a previous seed already landed.
const onlyMissing = argv.indexOf('--missing') !== -1;

const levels = [];
{
  const have = onlyMissing ? (load() || { levels: {} }).levels : {};
  for (let n = from; n <= to; n++) if (!have[n]) levels.push(n);
}
if (!levels.length) {
  process.stdout.write('nothing to do: every level in range is already banked\n');
  process.exit(0);
}

const workerCount = Math.max(1, Math.min(os.cpus().length, levels.length));
const slices = Array.from({ length: workerCount }, () => []);
// Round-robin, as in verify-levels: the cost of a level varies several-fold
// and contiguous blocks leave one worker holding all the slow ones.
levels.forEach((n, i) => slices[i % workerCount].push(n));

process.stdout.write(
  `searching levels ${from}–${to}: up to ${tries} samples or ${keep} keepers each, ` +
    `seed ${seed}, on ${workerCount} workers\n`
);

const started = Date.now();
const found = [];
let live = workerCount;

for (const slice of slices) {
  const child = fork(path.join(__dirname, 'generate-worker.js'), { stdio: 'inherit' });
  child.on('message', (m) => {
    if (m.progress) {
      const p = m.progress;
      process.stdout.write(
        `level ${String(p.level).padStart(3)}  ${String(p.looked).padStart(3)} sampled, ` +
          `${String(p.skipped).padStart(3)} implausible, ${String(p.accepted).padStart(3)} accepted  ` +
          (p.found ? `kept (quality ${p.q.toFixed(1)})` : 'NOTHING FOUND') +
          '\n'
      );
      return;
    }
    if (m.done) {
      found.push(...m.done);
      child.disconnect();
      if (--live === 0) finish();
    }
  });
  child.on('error', (e) => {
    process.stderr.write('worker failed: ' + e.message + '\n');
    process.exit(1);
  });
  child.send({ levels: slice, seed, tries, keep });
}

function finish() {
  found.sort((a, b) => a.level - b.level);
  const previous = load();
  const bank = {
    version: 1,
    seed,
    from,
    to,
    grid: { w: GRID_W, h: GRID_H },
    levels: {}
  };
  if (previous) for (const k of Object.keys(previous.levels)) bank.levels[k] = previous.levels[k];

  const empty = [];
  for (const r of found) {
    if (!r.best) {
      empty.push(r.level);
      // Leave any previous entry alone rather than replacing a good level with
      // nothing: a failed search is a failure to improve, not a reason to
      // regress.
      continue;
    }
    const spec = plainSpec(r.best.spec);
    /*
     * Par for the level, measured rather than guessed — and TIGHT, which the
     * first budget was not. At 1.4x a player could carve a wrong lane and
     * still afford the right one, so committing to a reading of the level
     * cost nothing and the decoys would be a quiz with unlimited retries. At
     * 1.15x every measured answer still fits with slop for an unsteady hand,
     * but a full wrong descent does not: choose the lane, then live with it.
     *
     * The countdown comes from the slowest passing plan's flow time (240 sim
     * steps to the wall-clock second), doubled, plus 75 seconds of thinking
     * and digging. Enough to read the level and cut once; not enough to
     * excavate it experimentally.
     */
    spec.digBudget = Math.round(r.best.report.maxDug * 1.15);
    spec.seconds =
      r.level <= 3
        ? 0
        : 75 + Math.ceil(((r.best.report.maxSteps || 0) / 240) * 2);
    spec.report = r.best.report;
    bank.levels[r.level] = spec;
  }

  save(bank, out);
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  const banked = found.filter((r) => r.best).length;
  process.stdout.write(
    `\n${banked}/${found.length} levels banked into ${out || 'docs/play/levels.js'} (${secs}s)\n`
  );
  if (empty.length) {
    process.stdout.write(
      `no acceptable spec found for: ${empty.join(', ')} — ` +
        'these fall back to the difficulty curve. Raise --tries or widen the ranges.\n'
    );
  }
}
