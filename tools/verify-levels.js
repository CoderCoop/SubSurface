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
 * beats. That number is the honest measure of whether the levels are puzzles,
 * and it is printed rather than enforced because it is currently bad and a
 * gate nobody can pass is a gate everybody disables. Lower it as the
 * generator improves, then turn it into a threshold.
 *
 *   node tools/verify-levels.js [firstLevel] [lastLevel]
 */

const S = require('../docs/play/sim.js');
const { judge, build, routePlan, play } = require('./solve.js');

const from = Number(process.argv[2] || 1);
const to = Number(process.argv[3] || 20);
const TARGET = 85;

let failed = 0;
let boring = 0;
const rows = [];

for (let n = from; n <= to; n++) {
  const spec = Object.assign(S.difficultyFor(n), { level: n, seed: n });
  const sim = build(spec);
  const r = play(spec, routePlan(sim), TARGET);

  const ok = r.pct >= TARGET && r.balanced;
  if (!ok) failed++;
  rows.push({
    level: n,
    route: r.pct,
    balanced: r.balanced,
    ok
  });
  process.stdout.write(
    `level ${String(n).padStart(3)}  route ${r.pct.toFixed(1).padStart(5)}%  ` +
      `${r.balanced ? 'accounted' : 'ACCOUNTING BROKEN'}  ${ok ? 'ok' : 'FAIL'}\n`
  );
}

/*
 * The interest sample. Judging every level is far too slow for a pull request
 * — a full judge is ten-odd simulations at play resolution — so this takes a
 * spread and reports it.
 */
const sample = [];
for (let n = from; n <= to; n += Math.max(1, Math.floor((to - from) / 4))) sample.push(n);
process.stdout.write('\ninterest sample (does a straight drop beat it?)\n');
for (const n of sample) {
  const spec = Object.assign(S.difficultyFor(n), { level: n, seed: n });
  const v = judge(spec);
  if (!v.interesting) boring++;
  process.stdout.write(
    `  level ${String(n).padStart(3)}  ` +
      (v.interesting
        ? 'needs a real route'
        : `beaten by ${v.naiveWins} naive drop(s)`) + '\n'
  );
}

process.stdout.write(
  `\n${rows.length - failed}/${rows.length} winnable, ` +
    `${sample.length - boring}/${sample.length} of the sample need a real route\n`
);

if (failed) {
  process.stderr.write(`\n${failed} level(s) cannot be won by their own route.\n`);
  process.exit(1);
}
