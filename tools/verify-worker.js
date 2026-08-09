'use strict';

/*
 * One worker in the level-verification pool.
 *
 * Judging a level means simulating it, repeatedly, at play resolution — the
 * work is pure CPU with no I/O to overlap, so async concurrency buys nothing
 * and only real parallelism helps. Hence a process per core, each handed a
 * slice of the levels and reporting back over the channel.
 *
 * Levels are independent by construction: each is built from its own number or
 * from a banked spec and nothing is shared, so slicing them needs no
 * coordination beyond handing out the numbers.
 */

const S = require('../docs/play/sim.js');
const { profile, build, routePlan, play, WIN, THREE } = require('./solve.js');

process.on('message', (msg) => {
  const out = [];
  const bank = msg.bank || null;
  for (const n of msg.levels) {
    const spec = bank && bank[n] ? bank[n] : Object.assign(S.difficultyFor(n), { level: n, seed: n });
    /*
     * The cheap question, asked of every level: does the level's own route get
     * home? Run to the top tier rather than to the pass mark, so the number in
     * the report is what the route actually scores instead of the first sample
     * above 85 — which is all it used to be, and why every level in the report
     * read as a suspiciously tidy 85-to-94.
     */
    const r = play(spec, routePlan(build(spec)), { stopAt: THREE, giveUpBelow: WIN });

    const row = {
      level: n,
      route: r.pct,
      balanced: r.balanced,
      ok: r.pct >= WIN && r.balanced
    };
    // The expensive question costs an order of magnitude more than the cheap
    // one, so it is only asked of the levels the driver marked.
    if (msg.interest.includes(n)) {
      const v = profile(spec, { full: true });
      if (v.error) {
        row.ok = false;
        row.error = v.error;
      } else {
        row.interesting = !!v.interesting;
        row.fun = !!v.fun;
        row.naiveWins = v.naiveWins || 0;
        row.naiveBest = v.naiveBest;
        row.best = v.best;
        row.plan = v.plan;
        row.bands = v.bands;
        row.reasons = v.reasons;
      }
    }
    out.push(row);
    process.send({ progress: row });
  }
  process.send({ done: out });
});
