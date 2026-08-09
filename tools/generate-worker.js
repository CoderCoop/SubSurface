'use strict';

/*
 * One worker in the level-generation pool: search for a spec that makes a good
 * level of a given number, and report the best one found.
 *
 * ---------------------------------------------------------------------------
 * Why search rather than tune
 *
 * A level was a point on a curve — difficultyFor() turned the number into a
 * cross-section, and every dial moved together. That makes the whole set easy
 * to reason about and impossible to fix in one place: tightening the basin so
 * level 6 stops forgiving a wild miss tightens it on level 40 too, where it was
 * already right. The measured result was a set of levels that all scored the
 * same way — every plan, exact or wild, within a point of every other.
 *
 * So this samples instead. The curve becomes the CENTRE of a distribution
 * rather than the answer, the solver says whether a sample came out well, and
 * what survives gets banked. The curve still decides what a level of that
 * number is ABOUT — which materials have been introduced, roughly how tight it
 * ought to be — because that is progression and progression is authored. What
 * it no longer decides is whether the level works.
 * ---------------------------------------------------------------------------
 */

const S = require('../docs/play/sim.js');
const { profile, WIN, TWO } = require('./solve.js');
const { plainSpec } = require('./bank.js');

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/*
 * What a level of this number has to be, and where it may wander.
 *
 * The band flags are taken straight from the curve and never sampled: which
 * materials a level contains is the teaching order (spec §5), and a generator
 * that put fractured rock in level 6 because it scored well would be optimising
 * the wrong thing. Everything below them is shape, and shape is fair game.
 */
function ranges(n, base) {
  const early = n <= 3;
  return {
    // The lane. Narrow enough to be a lane, wide enough to dig down.
    corridor: [clamp(base.corridor - 0.08, 0.16, 0.5), clamp(base.corridor + 0.05, 0.18, 0.5)],
    /*
     * The crystal, as a share of the lane — and this is the dial the old curve
     * had most wrong. It started at 0.7 and crept down, so an early basin was
     * a third of the width of the level: every rough aim landed on the
     * collector, and no floor shape could make a near miss cost anything. A
     * basin has to be small enough to miss before missing it can mean anything.
     */
    basin: early ? [0.5, 0.72] : [0.2, 0.46 - 0.1 * Math.min(1, n / 60)],
    // The margin for a near miss, and the whole difficulty curve for aim.
    apron: early ? [0.08, 0.13] : [0.03, 0.09],
    // The crown. Nothing else turns a miss into a loss.
    floorSlope: early ? [0, 0.02] : [0.035, 0.085],
    // How far a shelf reaches across.
    baffleReach: [0.18, clamp(base.baffleReach + 0.16, 0.24, 0.5)],
    // Where the route is, and where the strata sit. Pure variety: these move a
    // level without making it harder or easier, which is the other half of the
    // complaint the generator exists to answer.
    wander: [0, 1],
    sealAt: [0.24, 0.33],
    sandAt: [0.45, 0.55],
    fracAt: [0.66, 0.73],
    cavernAt: [0.77, 0.85],
    ribAt: [0.58, 0.7],
    ribReach: [0.18, 0.42]
  };
}

/*
 * Sample one candidate. Everything comes off the caller's stream, so a run of
 * the generator with a given seed produces exactly the bank it produced before.
 */
function sample(n, rand) {
  const base = S.difficultyFor(n);
  const R = ranges(n, base);
  const pick = (k) => R[k][0] + (R[k][1] - R[k][0]) * rand();
  const spec = plainSpec(base);

  for (const k of Object.keys(R)) spec[k] = pick(k);
  spec.level = n;
  // The seed moves the rib side, the pockets and the shelf offsets as well as
  // the noise, so two specs with the same dials are still two places.
  spec.seed = 1 + Math.floor(rand() * 100000);
  /*
   * Gravel pockets from the stage they are worth having: the collapse is the
   * one constructive move in the game, and a level with nothing hanging in its
   * ceiling cannot offer it. Kept off the teaching levels, where the answer
   * should be the lane and nothing else.
   */
  spec.gravel = n < 8 ? 0 : rand() < 0.55 ? 1 : 2;
  /*
   * Heat vents from the band that teaches them, and never before it — like
   * sand and fractured rock, this is progression rather than shape. How MANY
   * is shape, so that is sampled: one hot shelf tip is a tax on the last
   * corner, two taxes the whole descent.
   */
  spec.vents = base.vents > 0 ? (rand() < 0.6 ? 1 : 2) : 0;
  return spec;
}

/*
 * How good an accepted level is, so a search can keep the best of several
 * rather than the first that squeaked through.
 *
 * The shape being asked for: an exact answer that stands out, a couple of
 * rougher ones that get home, and misses that genuinely miss. A level where
 * everything aces has no top tier worth reaching; a level where nothing but the
 * exact line passes has no bottom rung to stand on.
 */
function quality(p) {
  const [failed, one, two, three] = p.bands;
  let q = 0;
  q -= Math.abs(three - 2) * 2.5; // an ace should be rare, not the default
  q += Math.min(one, 3) * 3; // rough passes are the point
  q += Math.min(two, 2) * 1.5; // and a middle rung is worth something
  q += Math.min(failed, 3) * 1.5; // a miss has to be able to miss
  q -= p.naiveBest / 20; // the further a straight drop is from passing, the better
  return q;
}

/*
 * What this level number is for.
 *
 * Levels 1–3 teach the basic move, so they are SUPPOSED to fall to a straight
 * drop — judging them by the same criterion as level 30 would reject exactly
 * the levels that do their job. They still have to be winnable and still have
 * to reward a clean cut with the top tier.
 */
function accepts(n, p) {
  if (p.error) return false;
  if (n <= 3) return p.winnable && p.ace && p.naiveWins > 0;
  return p.fun;
}

/*
 * The free rejection: is this terrain even worth simulating?
 *
 * Some samples are wrong in ways the geometry already knows about, and a
 * simulation costs seconds where a look at the built level costs a millisecond.
 * Nothing subtle belongs here — this is not a model of the rules, it is the
 * handful of ways a spec can be structurally pointless.
 */
function plausible(n, sim, digR) {
  const g = sim.geometry;
  // A crystal narrower than the tool cannot be aimed at, only stumbled into.
  if (g.basinR - g.basinL < 2 * digR) return 'basin narrower than the dig';
  // The roof has to exist and has to be over the crystal, or the level is a
  // straight drop whatever else is true of it.
  if (g.difficulty.tuck > 0 && !g.baffleY.length) return 'no shelf to tuck under';
  // Somewhere for the fluid to be lost, or nothing can go wrong at all.
  if (!g.drains.length) return 'no drains';
  // A gravel pocket that could not be placed makes the collapse plan a no-op,
  // so the level is not the level the spec asked for.
  if ((g.difficulty.gravel | 0) > 0 && !g.gravelAt.length) return 'gravel had nowhere to hang';
  return null;
}

/*
 * Search level `n` for the best spec it can find.
 *
 * Two budgets, because they bound different failure modes. `tries` caps how
 * long a level that is going badly may run; `keep` caps how long one that is
 * going WELL may run — measured, around six in ten plausible candidates are
 * accepted, and each acceptance costs the full plan set at forty seconds or so
 * while a rejection costs seven. Without the second cap the search spends most
 * of its time picking between candidates that are already good enough, which is
 * the least valuable work available to it.
 */
function search(n, seed, tries, digR, keep) {
  const rand = S.mulberry32(Math.imul(seed, 2654435761) ^ Math.imul(n, 40503));
  const enough = keep || 4;
  let best = null;
  let looked = 0;
  let skipped = 0;
  let accepted = 0;

  for (let i = 0; i < tries && accepted < enough; i++) {
    const spec = sample(n, rand);
    looked++;
    if (plausible(n, S.buildLevel({ w: 120, h: 200, seed: spec.seed, spec }), digR || 4)) {
      skipped++;
      continue;
    }
    /*
     * One profile per candidate, and it is complete for anything it accepts —
     * the short-circuits only skip stages a rejection has made irrelevant. So
     * the histogram this is ranked on and the numbers written into the bank are
     * the same measurement, not a second one taken afterwards.
     *
     * `minRough: 0` for the teaching levels, and it is not a detail. The
     * profile short-circuits on "nothing passes roughly", which for levels 1–3
     * is not a fault — they are meant to fall to a straight drop, and a level
     * whose every plan aces is exactly what a first level looks like. Left at
     * the default, the search bailed before it ever ran a naive drop, so
     * `naiveWins` came back zero, so `accepts` rejected every teaching level
     * that was doing its job and kept only the ones that happened to be
     * forgiving as well. Level 3 spent all fourteen samples finding two.
     */
    const p = profile(spec, { full: false, minRough: n <= 3 ? 0 : 1 });
    if (!accepts(n, p)) continue;
    accepted++;
    const q = quality(p);
    if (!best || q > best.q) best = { spec, q, report: report(p) };
  }
  return { level: n, looked, skipped, accepted, best };
}

function report(p) {
  const passing = p.rows.filter((r) => r.kind !== 'naive' && r.band > 0);
  return {
    best: p.best,
    plan: p.plan,
    naiveBest: p.naiveBest,
    bands: p.bands,
    // Every passing plan's cost, so the level can be given a budget that fits
    // all of them and not just the tidiest.
    maxDug: passing.reduce((a, r) => Math.max(a, r.dug), 0)
  };
}

process.on('message', (msg) => {
  const out = [];
  for (const n of msg.levels) {
    const r = search(n, msg.seed, msg.tries, msg.digR, msg.keep);
    out.push(r);
    process.send({
      progress: {
        level: n,
        looked: r.looked,
        skipped: r.skipped,
        accepted: r.accepted,
        found: !!r.best,
        q: r.best ? r.best.q : null
      }
    });
  }
  process.send({ done: out });
});

module.exports = { sample, ranges, quality, accepts, plausible, search, WIN, TWO };
