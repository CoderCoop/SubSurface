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

const { profile, build, routePlan, play, WIN, THREE } = require('./solve.js');
const { specFor, load } = require('./bank.js');

/*
 * A banked level is held to the full criterion; a derived one is only reported
 * on. That asymmetry is the point of the bank: the generator searched until it
 * found terrain that met the criterion and wrote down what it measured, so a
 * banked level failing it now means something has drifted — the rules changed
 * under the bank, or the bank was edited by hand. A derived level has never
 * claimed to meet it, and gating on one would be gating on the difficulty curve
 * being lucky.
 */
const BANK = load();

process.on('message', (msg) => {
  const out = [];
  for (const n of msg.levels) {
    // Banked where the bank has an entry, derived where it does not — one
    // answer to "what is level 7", whichever side of the bank it comes from.
    const spec = specFor(n);
    /*
     * The cheap question, asked of every level: does the level's own route get
     * home? Run to the top tier rather than to the pass mark, so the number in
     * the report is what the route actually scores instead of the first sample
     * above 85 — which is all it used to be, and why every level in the report
     * read as a suspiciously tidy 85-to-94.
     */
    const r = play(spec, routePlan(build(spec)), { stopAt: THREE, giveUpBelow: WIN });

    const banked = !!(BANK && BANK.levels[n]);
    const row = {
      level: n,
      banked,
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
        row.crisp = !!v.crisp;
        row.aces = v.aces;
        // Levels 1-3 teach the basic move and are meant to fall to a straight
        // drop, so the criterion they were banked against is a different one.
        // From 4 up a banked level is held to the full shape: an answer that
        // aces, few enough aces that finding it means something, a ladder
        // underneath, and no naive drop that gets home.
        if (banked && n >= 4 && !(v.fun && v.crisp && v.graded)) row.ok = false;
      }
    }
    out.push(row);
    process.send({ progress: row });
  }
  process.send({ done: out });
});
