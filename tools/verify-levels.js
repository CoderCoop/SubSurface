'use strict';

/*
 * The CI gate on level quality.
 *
 * Two claims, checked by playing the levels rather than by inspecting them:
 *
 *   winnable     the level's own route clears the target, so the game always
 *                has an answer it can show you
 *   accounted    fluid is conserved end to end, at the play resolution
 *
 * It also REPORTS, without failing, how many levels a naive straight drop
 * beats. That number is the honest measure of whether the levels are puzzles.
 * It is printed rather than enforced because it is not yet 100%, and a gate
 * nobody can pass is a gate everybody disables. Turn it into a threshold once
 * the generator can hold the line.
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

const from = Number(process.argv[2] || 1);
const to = Number(process.argv[3] || 20);

/*
 * Which levels get the expensive question. Judging interest is ten-odd
 * simulations against one for winnability, so it goes to a spread rather than
 * to everything — enough to catch the curve going flat, not so much that the
 * check stops being affordable.
 */
const INTEREST_SAMPLES = 6;
const interest = [];
{
  const step = Math.max(1, Math.floor((to - from) / (INTEREST_SAMPLES - 1)));
  for (let n = from; n <= to && interest.length < INTEREST_SAMPLES; n += step) interest.push(n);
}

/*
 * Deal levels round-robin rather than in blocks. The cost of a level varies
 * several-fold — an unwinnable one runs to the step cap while a clean one
 * exits early — so contiguous blocks leave one worker holding all the slow
 * ones while the rest sit idle.
 */
const levels = [];
for (let n = from; n <= to; n++) levels.push(n);
const workerCount = Math.max(1, Math.min(os.cpus().length, levels.length));
const slices = Array.from({ length: workerCount }, () => []);
levels.forEach((n, i) => slices[i % workerCount].push(n));

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

  process.stdout.write('\ninterest sample (does a straight drop beat it?)\n');
  for (const r of judged)
    process.stdout.write(
      `  level ${String(r.level).padStart(3)}  ` +
        (r.interesting ? 'needs a real route' : `beaten by ${r.naiveWins} naive drop(s)`) +
        '\n'
    );

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} winnable, ` +
      `${puzzles.length}/${judged.length} of the sample need a real route ` +
      `(${secs}s on ${workerCount} workers)\n`
  );

  if (failed.length) {
    process.stderr.write(
      `\n${failed.length} level(s) cannot be won by their own route: ` +
        failed.map((r) => r.level).join(', ') + '\n'
    );
    process.exit(1);
  }
}
