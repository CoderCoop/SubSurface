'use strict';

/*
 * The solver.
 *
 * A level generator is only as good as the thing that tells it "no". Anything
 * can emit terrain; the hard part is knowing whether what came out can be
 * beaten, and whether beating it was worth doing. This is that judge.
 *
 * It plays a level the way a player would — by cutting channels and watching
 * what the fluid does — rather than by reasoning about the terrain. That is
 * slow and it is the point: the simulation is the rules, and any model of the
 * rules good enough to reason with would be a second implementation to keep
 * in step with the first.
 *
 * Two questions per level, and they are different questions:
 *
 *   winnable     does at least one plan clear the target
 *   interesting  do the OBVIOUS plans fail
 *
 * A level nobody can beat is broken. A level a straight drop beats is boring.
 * The generator wants both answers and neither alone.
 */

const S = require('../docs/play/sim.js');
const B = require('../docs/play/bodies.js');

const GRID_W = 120;
const GRID_H = 200; // the grid the game actually plays on; see note below
const DIG_R = 4; // matches DIG_RADIUS in app.js

/*
 * Verification runs at the play resolution on purpose. Levels are authored in
 * fractions so they build at any size, but the simulation does not behave
 * identically across them — a channel four cells wide is a different channel
 * when the level is 90 cells across instead of 120. Verifying at a cheaper
 * size would be verifying a different game.
 */

/*
 * How long to let a plan run. Long enough for a wide reservoir to drain
 * through a narrow shaft, with three early exits so the common cases do not
 * pay for the worst one: the target being reached, the level being unable to
 * reach it whatever happens next, and nothing having changed for a while.
 */
const MAX_STEPS = 26000;
const STALL_STEPS = 900;

function build(spec) {
  return S.buildLevel({
    w: GRID_W,
    h: GRID_H,
    seed: spec.seed === undefined ? spec.level || 1 : spec.seed,
    spec
  });
}

// Cut one stroke, detaching any rock it frees into the rigid-body layer.
function stroke(sim, bodies, s) {
  const r = sim.digLine(s.x0, s.y0, s.x1, s.y1, s.r === undefined ? DIG_R : s.r);
  if (r.shattered.length) bodies.shatterAll(r.shattered);
  return r;
}

/*
 * Run one plan to a verdict.
 *
 * `plan.cuts` may be a function, because a plan like "collapse the pocket,
 * see where the pile lands, then route around it" cannot know its later
 * strokes until the earlier ones have played out. The function is handed the
 * sim between phases.
 */
function play(spec, plan, target) {
  const sim = build(spec);
  const bodies = new B.Bodies(sim);
  const phases = typeof plan.cuts === 'function' ? plan.cuts(sim) : plan.cuts;

  let steps = 0;
  let best = 0;
  let stall = 0;
  let last = '';
  let dug = 0;

  for (const phase of phases) {
    for (const s of phase.strokes || []) dug += stroke(sim, bodies, s).removed;
    const settle = phase.settle || 0;
    for (let i = 0; i < settle && steps < MAX_STEPS; i++, steps++) {
      bodies.step(1 / 60);
      sim.step();
    }
  }

  for (; steps < MAX_STEPS; steps++) {
    bodies.step(1 / 60);
    sim.step();
    if ((steps & 63) !== 0) continue;

    const st = sim.stats();
    if (st.collectionPct > best) best = st.collectionPct;
    if (best >= target) break; // done; nothing later can un-collect it

    // The ceiling: everything not yet lost to a drain. Once that is under the
    // target the level cannot be won however long it runs.
    const ceiling = ((st.released - st.lost) / st.released) * 100;
    if (ceiling < target) break;

    /*
     * The signature has to be able to see movement. Counting only what has
     * arrived somewhere — collected, held, lost — is constant for the whole
     * descent, so a first attempt called every level settled after 960 steps
     * and reported that nothing is winnable. Depth and pressure change while
     * the column is still falling, and stop changing when it has stopped.
     */
    const sig =
      st.collected + '/' + st.inPlay + '/' + st.heldBySand + '/' + st.lost +
      '/' + st.depth + '/' + st.pressure;
    stall = sig === last ? stall + 64 : 0;
    last = sig;
    if (stall >= STALL_STEPS) break;
  }

  const st = sim.stats();
  if (st.collectionPct > best) best = st.collectionPct;
  return { pct: best, dug, steps, balanced: st.balanced };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/*
 * The obvious ones: a straight shaft, at every position across the level a
 * player might reasonably try. If any of these clears the target then the
 * level's answer is "drag downwards somewhere", and there is no puzzle in it.
 */
function naivePlans(sim) {
  const g = sim.geometry;
  const out = [];
  for (let i = 0; i <= 9; i++) {
    const x = Math.round(g.wall + 2 + ((GRID_W - 2 * g.wall - 4) * i) / 9);
    out.push({
      name: 'drop@' + x,
      naive: true,
      cuts: [{ strokes: [{ x0: x, y0: g.sealTop - 1, x1: x, y1: g.floorY - 1 }] }]
    });
  }
  return out;
}

/*
 * The intended one: the lane, corner by corner. This is what carveIdealChannel
 * cuts and what the game offers as the reference cut, so if this fails the
 * level has no answer the game itself knows about.
 */
function routePlan(sim) {
  const g = sim.geometry;
  const strokes = [];
  let px = g.route[0].x,
    py = g.sealTop - 1;
  for (const p of g.route) {
    strokes.push({ x0: px, y0: py, x1: p.x, y1: p.y });
    px = p.x;
    py = p.y;
  }
  return { name: 'route', cuts: [{ strokes }] };
}

/*
 * The interesting ones: drop a gravel pocket first, let it pile up on the
 * cavern floor, and only then cut the route.
 *
 * This is the move the terrain is built to reward — a dam you make on purpose
 * out of material that was hanging in the ceiling. The undercut is a wide flat
 * stroke just beneath the pocket, which is what a player would drag, and the
 * settle is long enough for the pile to come to rest before anything is
 * routed past it.
 */
function collapsePlans(sim) {
  const g = sim.geometry;
  if (!g.gravelAt || !g.gravelAt.length) return [];
  const out = [];
  const undercuts = g.gravelAt.map((p) => ({
    x0: p[0] - p[2] - 2,
    y0: p[1] + p[2] + 2,
    x1: p[0] + p[2] + 2,
    y1: p[1] + p[2] + 2
  }));

  const routeStrokes = () => {
    const strokes = [];
    let px = g.route[0].x,
      py = g.sealTop - 1;
    for (const p of g.route) {
      strokes.push({ x0: px, y0: py, x1: p.x, y1: p.y });
      px = p.x;
      py = p.y;
    }
    return strokes;
  };

  for (let i = 0; i < undercuts.length; i++) {
    out.push({
      name: 'collapse' + i + '+route',
      cuts: [
        { strokes: [undercuts[i]], settle: 1400 },
        { strokes: routeStrokes() }
      ]
    });
  }
  if (undercuts.length > 1) {
    out.push({
      name: 'collapse*+route',
      cuts: [{ strokes: undercuts, settle: 1600 }, { strokes: routeStrokes() }]
    });
  }
  return out;
}

/*
 * Judge a spec.
 *
 * Naive plans run first and stop early: the moment one of them clears the
 * target the level is boring, and nothing the clever plans do can rescue it.
 * That ordering is most of why the generator is affordable — boring levels are
 * the common case and they are rejected after one or two simulations.
 */
function judge(spec, opts = {}) {
  const target = opts.target || 85;
  const probe = build(spec);

  let naiveBest = 0;
  let naiveWins = 0;
  const naive = naivePlans(probe);
  for (const p of naive) {
    const r = play(spec, p, target);
    if (!r.balanced) return { error: 'conservation broke on ' + p.name };
    if (r.pct > naiveBest) naiveBest = r.pct;
    if (r.pct >= target) {
      naiveWins++;
      if (!opts.full) return { winnable: true, interesting: false, naiveBest, naiveWins };
    }
  }

  let best = { pct: 0, name: null, dug: 0 };
  for (const p of [routePlan(probe), ...collapsePlans(probe)]) {
    const r = play(spec, p, target);
    if (!r.balanced) return { error: 'conservation broke on ' + p.name };
    if (r.pct > best.pct) best = { pct: r.pct, name: p.name, dug: r.dug };
    if (r.pct >= target && !opts.full) break;
  }

  return {
    winnable: best.pct >= target,
    interesting: best.pct >= target && naiveWins === 0,
    best: best.pct,
    plan: best.name,
    dug: best.dug,
    naiveBest,
    naiveWins,
    // How much of the level's answer is *not* obvious: the margin between the
    // best plan and the best thing a straight drop manages.
    margin: best.pct - naiveBest
  };
}

module.exports = { judge, play, build, naivePlans, routePlan, collapsePlans, GRID_W, GRID_H };
