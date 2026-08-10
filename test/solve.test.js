'use strict';

/*
 * The judge's own tests.
 *
 * Everything about level quality is measured through solve.js, so a solver
 * that measures the wrong thing is worse than no solver: it reports a number,
 * the number looks fine, and the levels are bad anyway. That is not
 * hypothetical — both bugs pinned below shipped, and between them they made
 * the level report say "3/6 need a real route" about a set of levels where
 * every plan, right or wrong, scored within a point of every other.
 *
 * These are the cheap structural claims. The expensive behavioural one — that
 * the levels themselves come out well — lives in levels.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');

const S = require('../docs/play/sim.js');
const {
  build,
  bandOf,
  verdict,
  roughPlans,
  naivePlans,
  decoyPlans,
  routeStrokes,
  play,
  routePlan,
  WIN,
  TWO,
  THREE
} = require('../tools/solve.js');

const specFor = (n) => Object.assign(S.difficultyFor(n), { level: n, seed: n });

test('scores map to the star tiers the game actually shows', () => {
  assert.strictEqual(bandOf(THREE), 3);
  assert.strictEqual(bandOf(THREE - 0.1), 2);
  assert.strictEqual(bandOf(TWO), 2);
  assert.strictEqual(bandOf(TWO - 0.1), 1);
  assert.strictEqual(bandOf(WIN), 1);
  assert.strictEqual(bandOf(WIN - 0.1), 0);
  assert.strictEqual(bandOf(0), 0);
});

test('a rough aim actually leaves the crystal it is aiming at', () => {
  /*
   * The regression this exists for: the rough family was first scaled to half
   * the basin and to the basin, and an early level's basin is a third of the
   * width — so the WORST aim in the set still landed on the collector, every
   * rough plan scored what the exact one did, and the distribution was flat
   * for reasons that had nothing to do with the terrain.
   *
   * Asked of the geometry rather than of a fraction of the width, because the
   * generator moves the basin and a hard-coded column would quietly start
   * testing something else.
   */
  for (const n of [4, 20, 45]) {
    const sim = build(specFor(n));
    const g = sim.geometry;
    const forgiveness = (g.basinR - g.basinL) / 2 + g.apron;
    const aims = roughPlans(sim).map((p) => {
      const last = p.cuts[0].strokes[p.cuts[0].strokes.length - 1];
      return Math.abs(last.x1 - Math.round((g.basinL + g.basinR) / 2));
    });
    assert.ok(
      Math.max(...aims) > forgiveness,
      `level ${n}: worst rough aim was ${Math.max(...aims)} cells off, but the ` +
        `crystal and its apron forgive ${forgiveness} — the probe never left the target`
    );
    /*
     * And the gentlest one has to keep some of the cut over the crystal.
     * Delivery is by overlap — the pool drains wholesale through any gap its
     * mouth reaches — so the gradient lives at the edges of overlap, and a
     * family whose gentlest aim already misses entirely measures only misses.
     * (There is no dead-centre aim: within the dig radius that is the same
     * cut as the route, and it aced in lockstep with it on every probe.)
     */
    assert.ok(
      Math.min(...aims) < (g.basinR - g.basinL) / 2 + 4,
      `level ${n}: even the gentlest rough aim has no overlap with the basin`
    );
  }
});

test('an aim error pivots below the band and moves only the landing', () => {
  const sim = build(specFor(12));
  const g = sim.geometry;
  const exact = routeStrokes(sim);
  const off = routeStrokes(sim, 0, 9);
  // One extra stroke: the vertical thread through the crossing down to the
  // pivot at the band's underside. Aiming through the band buries the cut.
  assert.strictEqual(off.length, exact.length + 1);
  for (let i = 0; i < exact.length - 1; i++)
    assert.strictEqual(off[i].x0, exact[i].x0, `stroke ${i} start moved`);
  const pivot = off[off.length - 2];
  assert.strictEqual(pivot.x0, pivot.x1, 'the thread through the band is vertical');
  assert.ok(pivot.y1 >= g.sandBot, 'and the pivot sits below the sand');
  assert.strictEqual(
    off[off.length - 1].x1 - exact[exact.length - 1].x1,
    9,
    'the landing column should carry the whole error'
  );
});

test('naive drops are spread across the level and start at the seal', () => {
  const sim = build(specFor(9));
  const g = sim.geometry;
  const xs = naivePlans(sim).map((p) => p.x);
  assert.ok(xs.length >= 8, 'too few naive drops to call a level obvious or not');
  assert.ok(Math.min(...xs) <= g.wall + 4, 'nothing tried near the left wall');
  assert.ok(Math.max(...xs) >= sim.w - g.wall - 5, 'nothing tried near the right wall');
  for (const p of naivePlans(sim))
    assert.strictEqual(p.cuts[0].strokes[0].y0, g.sealTop - 1);
});

test('giving up is separate from stopping, so a losing plan still gets a number', () => {
  /*
   * The two thresholds used to be one argument. With one, asking a plan what
   * it actually scores meant setting the bar at 100% — which fired the
   * give-up test on the first drop lost to a drain and reported whatever had
   * been banked a few hundred steps in. Any plan that leaked at all read as a
   * near-zero, so the 85–92 band could not be observed even when it was there.
   */
  const spec = specFor(6);
  const sim = build(spec);
  const g = sim.geometry;
  /*
   * The level's own route, aimed at a drain instead of the crystal — so the
   * fluid is certain to arrive in the cavern and certain to leak once it does.
   * Aiming a bare shaft into open ground instead would not do: it may be
   * stopped by a shelf on the way down and never lose a drop, which makes the
   * test pass for the wrong reason.
   */
  const basin = Math.round((g.basinL + g.basinR) / 2);
  const drain = g.drains.reduce((a, d) =>
    Math.abs((d[0] + d[1]) / 2 - basin) > Math.abs((a[0] + a[1]) / 2 - basin) ? d : a
  );
  const plan = {
    name: 'into the drain',
    cuts: [{ strokes: routeStrokes(sim, 0, Math.round((drain[0] + drain[1]) / 2) - basin) }]
  };

  const conflated = play(spec, plan, { stopAt: 100, giveUpBelow: 100 });
  const separated = play(spec, plan, { stopAt: THREE, giveUpBelow: 0 });
  assert.ok(separated.pct >= conflated.pct, 'measuring should never see less than bailing did');
  assert.ok(conflated.bailed, 'a leaking plan cannot reach 100% and should say so');
  assert.ok(!separated.bailed, 'with nothing to give up on, the run should settle');
});

test('the route reported for a level is what it scores, not the first sample over the bar', () => {
  const spec = specFor(8);
  const atBar = play(spec, routePlan(build(spec)), { stopAt: WIN, giveUpBelow: WIN });
  const measured = play(spec, routePlan(build(spec)), { stopAt: THREE, giveUpBelow: WIN });
  assert.ok(atBar.pct >= WIN);
  assert.ok(
    measured.pct >= atBar.pct,
    `stopping at the bar reported ${atBar.pct.toFixed(1)}%, measuring ${measured.pct.toFixed(1)}%`
  );
});

// ---------------------------------------------------------------------------
// The criterion itself, on made-up distributions — the decision rule is worth
// testing without paying for twenty simulations to produce one.
// ---------------------------------------------------------------------------

const rows = (spec) =>
  spec.map(([kind, pct], i) => ({ name: kind + i, kind, pct, band: bandOf(pct) }));

test('a level is fun only when it aces, forgives, and defeats every straight drop', () => {
  const good = verdict(
    rows([
      ['route', 98],
      ['rough', 97.5],
      ['rough', 88],
      ['rough', 40],
      ['naive', 60],
      ['naive', 0]
    ]),
    1
  );
  assert.ok(good.fun, good.reasons.join('; '));
  assert.ok(good.ace && good.forgiving && good.hard);

  // A lock: the exact answer and nothing else. Passes winnable and
  // interesting, and is not a puzzle.
  const lock = verdict(
    rows([
      ['route', 98],
      ['rough', 20],
      ['rough', 0],
      ['naive', 0]
    ]),
    1
  );
  assert.ok(!lock.fun && lock.ace && !lock.forgiving && lock.hard);

  // A slope: everything gets home, so no tier means anything.
  const slope = verdict(
    rows([
      ['route', 98],
      ['rough', 97.6],
      ['rough', 97.4],
      ['naive', 97.2]
    ]),
    1
  );
  assert.ok(!slope.fun && !slope.hard);
  assert.strictEqual(slope.naiveWins, 1);

  // Adequate everywhere and excellent nowhere: the top tier is unreachable.
  const flat = verdict(
    rows([
      ['route', 90],
      ['rough', 86],
      ['naive', 10]
    ]),
    1
  );
  assert.ok(!flat.fun && !flat.ace && flat.forgiving && flat.hard);
  assert.ok(flat.winnable && flat.interesting);
});

test('the distribution is reported as a histogram over the tiers', () => {
  const v = verdict(
    rows([
      ['route', 99],
      ['rough', 97.2],
      ['rough', 94],
      ['rough', 86],
      ['rough', 10],
      ['naive', 50]
    ]),
    1
  );
  assert.deepStrictEqual(v.bands, [1, 1, 1, 2]); // failed / 1★ / 2★ / 3★
  // Two rows land in the top band but only ONE answer aces: the acing rough
  // is the route with a sloppier hand, not a second answer. The histogram
  // keeps both; the ace count does not.
  assert.strictEqual(v.aces, 1);
  assert.strictEqual(v.rough, 1);
  assert.deepStrictEqual(v.naiveBands, [1, 0, 0, 0]);
});

// ---------------------------------------------------------------------------
// The second criterion: bounding the top of the distribution
// ---------------------------------------------------------------------------

test('too many ANSWERS fails crisp even when everything else passes', () => {
  /*
   * The regression this exists for: the first bank satisfied ace + forgiving +
   * hard on every level and still played easy, because a median of five plans
   * aced — 3★ meant "you found the area". The criterion has to bound the top
   * of the distribution as well as the bottom.
   *
   * What counts as "too many" changed when the bank went woven: an ace is a
   * distinct ANSWER (route or collapse), because every rough plan follows
   * the route's corners by construction — an acing graze is the same answer
   * with a sloppier hand (measured at level 8: route, two lips and two
   * grazes ace together while every shift and naive dies on a shelf). So a
   * route flanked by acing roughs is crisp, and a level where the route AND
   * several collapses all ace is not — three independent ways to the top
   * tier is a slope with a scoreboard again.
   */
  const slope = verdict(
    rows([
      ['route', 98],
      ['collapse', 97.8],
      ['collapse', 97.5],
      ['rough', 88],
      ['rough', 90],
      ['naive', 10]
    ]),
    1
  );
  assert.ok(slope.fun, 'the old clauses all pass');
  assert.ok(!slope.crisp, 'three acing answers should fail crisp');

  const crisp = verdict(
    rows([
      ['route', 98],
      ['rough', 97.8],
      ['rough', 97.5],
      ['rough', 97.2],
      ['rough', 93],
      ['rough', 88],
      ['rough', 40],
      ['naive', 10]
    ]),
    1
  );
  assert.ok(
    crisp.fun && crisp.crisp && crisp.graded,
    'route-derived aces are one answer: ' + crisp.reasons.join('; ')
  );
});

test('a cliff under the ace fails graded', () => {
  // One exact answer and nothing between it and failure is a lock with a
  // scoreboard. The ladder is what makes partial credit real.
  const lock = verdict(
    rows([
      ['route', 98],
      ['rough', 88],
      ['rough', 30],
      ['rough', 5],
      ['naive', 0]
    ]),
    1
  );
  assert.ok(!lock.graded, 'one rung is not a ladder');
  assert.ok(lock.crisp && lock.forgiving);
});

test('a level whose answer is the dam is recognised as mechanic-required', () => {
  const dam = verdict(
    rows([
      ['route', 61],
      ['collapse', 97.5],
      ['rough', 93],
      ['rough', 88],
      ['rough', 20],
      ['naive', 15]
    ]),
    1
  );
  assert.ok(dam.mechanicRequired, 'route at 61 with a collapse ace is a dam level');
  assert.ok(dam.fun && dam.crisp && dam.graded, dam.reasons.join('; '));
  assert.strictEqual(dam.routePct, 61);

  // A lane level with a redundant dam is NOT mechanic-required: the lane aces
  // on its own, so the collapse is a flourish.
  const lane = verdict(
    rows([
      ['route', 97.5],
      ['collapse', 97.8],
      ['rough', 88],
      ['rough', 90],
      ['naive', 10]
    ]),
    1
  );
  assert.ok(!lane.mechanicRequired);
});

test('the rough family can be built on a collapse answer', () => {
  const sim = build(specFor(12));
  const pre = [{ strokes: [{ x0: 10, y0: 50, x1: 30, y1: 50 }], settle: 1400 }];
  const plans = roughPlans(sim, pre);
  for (const p of plans) {
    assert.strictEqual(p.cuts.length, 2, p.name + ' should carry the pre-phase');
    assert.strictEqual(p.cuts[0], pre[0], p.name + ' should start with the undercut');
    assert.ok(p.name.startsWith('c+'), 'collapse-based rough plans are labelled');
  }
  // And without a pre-phase the family is what it always was.
  for (const p of roughPlans(sim)) assert.strictEqual(p.cuts.length, 1);
});

test('a decoy that works is counted against the level, not for it', () => {
  const trap = verdict(
    rows([
      ['route', 98],
      ['rough', 90],
      ['rough', 88],
      ['decoy', 20],
      ['decoy', 5],
      ['naive', 10]
    ]),
    1
  );
  assert.ok(trap.hard, 'failing decoys are what decoys are for');

  const leak = verdict(
    rows([
      ['route', 98],
      ['rough', 90],
      ['rough', 88],
      ['decoy', 97.5],
      ['naive', 10]
    ]),
    1
  );
  assert.ok(!leak.hard, 'a working decoy is a free win in disguise');
  assert.strictEqual(leak.decoyWins, 1);
  // And its score is neither an ace nor a rung: wrong answers do not shape
  // the ladder.
  assert.strictEqual(leak.aces, 1);
  assert.deepStrictEqual(leak.bands, [0, 2, 0, 1]);
});

test('decoy plans follow the real line to the shelves, then commit to the wrong crossing', () => {
  const sim = build(specFor(12));
  const g = sim.geometry;
  const plans = decoyPlans(sim);
  assert.strictEqual(plans.length, g.decoyAt.length);
  assert.ok(plans.length >= 2, 'a sand level should offer at least two decoys');
  for (let i = 0; i < plans.length; i++) {
    const strokes = plans[i].cuts[0].strokes;
    const last = strokes[strokes.length - 1];
    assert.strictEqual(plans[i].kind, 'decoy');
    assert.strictEqual(last.x1, g.decoyAt[i], 'the descent is through the decoy');
    assert.ok(last.y1 >= g.floorY - 1, 'and it goes all the way down');
  }
});
