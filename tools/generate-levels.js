'use strict';

/*
 * The level generator.
 *
 *   node tools/generate-levels.js [first] [last] [--seed N] [--tries N]
 *                                 [--keep N] [--out FILE] [--fresh]
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
// Merge over whatever is already banked outside the range being regenerated, so
// a run can fix one stretch of the game without discarding the rest.
const merge = argv.indexOf('--fresh') === -1;

const levels = [];
for (let n = from; n <= to; n++) levels.push(n);

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
  const previous = merge ? load() : null;
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
     * Par for the level, measured rather than guessed: every plan that got home
     * has to fit inside it, with enough headroom that a player who takes a
     * wider line than the solver did is not failed for tidiness. Nothing sets a
     * time limit yet — see the heat-vent work, which is what would make one
     * bite.
     */
    spec.digBudget = Math.round(r.best.report.maxDug * 1.4);
    spec.seconds = 0;
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
