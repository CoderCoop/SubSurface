'use strict';

/*
 * One worker in the level-verification pool.
 *
 * Judging a level means simulating it, repeatedly, at play resolution — the
 * work is pure CPU with no I/O to overlap, so async concurrency buys nothing
 * and only real parallelism helps. Hence a process per core, each handed a
 * slice of the levels and reporting back over the channel.
 *
 * Levels are independent by construction: each is built from its own number
 * and nothing is shared, so slicing them needs no coordination beyond handing
 * out the numbers.
 */

const S = require('../docs/play/sim.js');
const { judge, build, routePlan, play } = require('./solve.js');

const TARGET = 85;

process.on('message', (msg) => {
  const out = [];
  for (const n of msg.levels) {
    const spec = Object.assign(S.difficultyFor(n), { level: n, seed: n });
    const sim = build(spec);
    const r = play(spec, routePlan(sim), TARGET);

    const row = { level: n, route: r.pct, balanced: r.balanced, ok: r.pct >= TARGET && r.balanced };
    // The interest question costs an order of magnitude more than the
    // winnability one, so it is only asked of the levels the driver marked.
    if (msg.interest.includes(n)) {
      const v = judge(spec);
      row.interesting = !!v.interesting;
      row.naiveWins = v.naiveWins || 0;
    }
    out.push(row);
    process.send({ progress: row });
  }
  process.send({ done: out });
});
