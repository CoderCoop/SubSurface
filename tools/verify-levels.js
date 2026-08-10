'use strict';

/*
 * The CI gate on level quality.
 *
 * Three claims, checked by playing the levels rather than by inspecting them:
 *
 *   winnable     the level's own route clears the target, so the game always
 *                has an answer it can show you — asked of every level
 *   accounted    fluid is conserved end to end, at the play resolution
 *   the criterion  a BANKED level still meets the standard it was banked
 *                against: an exact answer that aces, a rough one that scrapes
 *                a pass, and no straight drop that gets home
 *
 * The third used to be printed rather than enforced, on the grounds that it was
 * not yet 100% and a gate nobody can pass is a gate everybody disables. The
 * generator can hold the line now, so it is a gate — but only over the levels
 * the generator produced. A derived level has never claimed to meet the
 * criterion, and gating on one would be gating on the difficulty curve
 * happening to be lucky at that number; those are still reported only.
 *
 * Run across a process per core: the work is pure CPU with nothing to overlap,
 * so a pool is the only thing that makes this cheap enough to sit inside the
 * ordinary test run rather than in a job of its own.
 *
 *   node tools/verify-levels.js [firstLevel] [lastLevel]
 */

const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const { WIN } = require('./solve.js');

const from = Number(process.argv[2] || 1);
const to = Number(process.argv[3] || 20);

/*
 * Which levels get the expensive question.
 *
 * The distribution costs twenty-odd simulations against one for winnability —
 * around four minutes a level on a CI runner — so it goes to a spread rather
 * than to everything. Enough to catch the bank drifting away from the rules,
 * which is not a thing that happens to one level in isolation: a change to the
 * simulation that invalidates level 12 will have invalidated most of its
 * neighbours too, and any one of them failing is the signal.
 *
 * The spread starts at level 4. Levels 1–3 teach the basic move and are meant
 * to fall to a straight drop, so the criterion does not apply to them and the
 * gate skips them — profiling one costs the same four minutes to produce a
 * verdict nobody acts on.
 */
// Four in the in-suite gate: with the full 1-31 winnable sweep alongside, six
// samples brushed the unit job's ten-minute timeout. The CI matrix's --full
// shards are where every banked level gets gated; this is the fallback.
const INTEREST_SAMPLES = 4;
const TEACHING = 3;
/*
 * --full gates EVERY level in range on its criterion instead of a spread.
 * Too expensive for one job, exactly right for a CI matrix: four shards of
 * eight levels each gate the whole game in parallel on separate runners, in
 * about the time one job used to spend sampling six.
 */
const fullGate = process.argv.includes('--full');
const interest = [];
{
  const first = Math.max(from, TEACHING + 1);
  if (fullGate) {
    for (let n = first; n <= to; n++) interest.push(n);
  } else {
    const step = Math.max(1, Math.floor((to - first) / (INTEREST_SAMPLES - 1)));
    for (let n = first; n <= to && interest.length < INTEREST_SAMPLES; n += step) interest.push(n);
  }
}

/*
 * Deal the expensive levels first, one per worker, then the rest round-robin.
 *
 * Dealing everything round-robin looks fair and is not. The sampled levels are
 * evenly spaced by construction, so their spacing lines up with the number of
 * workers whenever one divides the other — and with four samples across
 * sixteen levels on a four-core runner, every single sample landed on the same
 * worker. The other three finished in seconds and sat idle while one of them
 * ran four four-minute profiles back to back, which took the wall clock past
 * the CI job's timeout for a suite whose total work had just been REDUCED.
 *
 * Spreading the known-expensive work first and filling in around it makes the
 * schedule independent of that coincidence.
 */
const levels = [];
for (let n = from; n <= to; n++) levels.push(n);
const workerCount = Math.max(1, Math.min(os.cpus().length, levels.length));
const slices = Array.from({ length: workerCount }, () => []);
interest.forEach((n, i) => slices[i % workerCount].push(n));
levels
  .filter((n) => interest.indexOf(n) === -1)
  .forEach((n, i) => slices[i % workerCount].push(n));

const started = Date.now();
const results = [];
let live = workerCount;

for (const slice of slices) {
  const child = fork(path.join(__dirname, 'verify-worker.js'), { stdio: 'inherit' });
  child.on('message', (m) => {
    if (m.progress) {
      const r = m.progress;
      process.stdout.write(
        `level ${String(r.level).padStart(3)}  route ${r.route.toFixed(1).padStart(5)}%  ` +
          `${r.balanced ? 'accounted' : 'ACCOUNTING BROKEN'}  ${r.ok ? 'ok' : 'FAIL'}\n`
      );
      return;
    }
    if (m.done) {
      results.push(...m.done);
      child.disconnect();
      if (--live === 0) report();
    }
  });
  child.on('error', (e) => {
    process.stderr.write('worker failed: ' + e.message + '\n');
    process.exit(1);
  });
  child.send({ levels: slice, interest });
}

function report() {
  results.sort((a, b) => a.level - b.level);
  const failed = results.filter((r) => !r.ok);
  const judged = results.filter((r) => r.interesting !== undefined);
  const puzzles = judged.filter((r) => r.interesting);

  /*
   * The distribution, not just the verdict.
   *
   * "Winnable" and "needs a real route" are both satisfied by a level with one
   * answer and a cliff either side of it, which is a lock rather than a puzzle.
   * What says whether a level is worth playing is the SHAPE of the scores its
   * plans get — how many ace, how many scrape a pass, how many fail — so that
   * is what gets printed. See `profile` in solve.js for the criterion.
   */
  const fun = judged.filter((r) => r.meets);
  process.stdout.write(
    '\nsample distribution (plans by tier: ★★★ / ★★ / ★ / failed)\n'
  );
  for (const r of judged) {
    const b = r.bands || [0, 0, 0, 0];
    process.stdout.write(
      `  level ${String(r.level).padStart(3)}  ` +
        (r.banked ? 'banked  ' : 'derived ') +
        `${b[3]}/${b[2]}/${b[1]}/${b[0]}  ` +
        `best ${(r.best || 0).toFixed(1).padStart(5)}%  ` +
        `naive ${(r.naiveBest || 0).toFixed(1).padStart(5)}%  ` +
        (r.meets ? 'meets its criterion' : (r.reasons || []).join('; ')) +
        '\n'
    );
  }

  const banked = results.filter((r) => r.banked).length;
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} winnable, ` +
      `${banked}/${results.length} banked, ` +
      `${puzzles.length}/${judged.length} of the sample need a real route, ` +
      `${fun.length}/${judged.length} meet their criterion ` +
      `(${secs}s on ${workerCount} workers)\n`
  );

  if (failed.length) {
    /*
     * Two ways to fail, and they mean different things. A level whose own route
     * cannot win is broken outright. A BANKED level that no longer meets the
     * criterion means the bank has drifted from the rules — the generator
     * measured that terrain and signed it off, so if it does not hold now,
     * either the simulation changed under it or the file was edited by hand.
     * Regenerate rather than lowering the bar.
     */
    const unwinnable = failed.filter((r) => r.route < WIN || !r.balanced);
    const drifted = failed.filter((r) => unwinnable.indexOf(r) === -1);
    if (unwinnable.length)
      process.stderr.write(
        `\n${unwinnable.length} level(s) cannot be won by their own route: ` +
          unwinnable.map((r) => r.level).join(', ') + '\n'
      );
    if (drifted.length)
      process.stderr.write(
        `\n${drifted.length} banked level(s) no longer meet the criterion they were ` +
          'banked against: ' +
          drifted.map((r) => `${r.level} (${(r.reasons || []).join('; ')})`).join(', ') +
          '\nRegenerate them: node tools/generate-levels.js <first> <last>\n'
      );
    process.exit(1);
  }
}
