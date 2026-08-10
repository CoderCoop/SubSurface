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
 * Three questions per level, and they are different questions:
 *
 *   winnable     does at least one plan clear the target
 *   interesting  do the OBVIOUS plans fail
 *   fun          is the SHAPE of the outcomes right
 *
 * A level nobody can beat is broken. A level a straight drop beats is boring.
 * A level where every approximate answer scores the same as the exact one has
 * no skill in it even though it passes both of the first two tests — which is
 * why the third question exists, and why the answer to it is a distribution
 * rather than a number. See `profile` below.
 */

const S = require('../docs/play/sim.js');
const B = require('../docs/play/bodies.js');

const GRID_W = 120;
const GRID_H = 200; // the grid the game actually plays on; see note below
const DIG_R = 4; // matches DIG_RADIUS in app.js

/*
 * The star tiers, mirrored from TIERS in app.js. The whole criterion below is
 * expressed in them, because "is this level fun" is not a separate scale from
 * "what does the player see when they clear it" — a level is fun when the
 * tiers it hands out actually discriminate. If they move there, move them here.
 */
const WIN = 85; // 1★ — you found a line
const TWO = 92; // 2★
const THREE = 97; // 3★ — you found THE line

/*
 * How many plans may ace before the line stops being special. One is the
 * exact answer; the second is grace for an offset so small the dig radius
 * makes it the same cut. Three aces means any of a hand-width of positions
 * gets the top grade, which is the "levels are too easy" complaint in one
 * number — the first bank passed the old criterion with a MEDIAN of five.
 */
const CRISP_ACES = 2;

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
 *
 * Two thresholds, and conflating them was the bug that made a distribution
 * impossible to measure:
 *
 *   stopAt        stop as soon as this much is banked. Nothing later can
 *                 un-collect it, so the run is over and the number is exact.
 *   giveUpBelow   stop once the level can no longer reach this much, however
 *                 long it runs. The number reported is then a LOWER BOUND, and
 *                 the row is flagged `bailed` to say so.
 *
 * They used to be one argument, which is fine for a yes/no question and wrong
 * for a measurement: asking "what exactly does this plan score" by passing
 * target = 100 made the give-up test fire on the first drop lost to a drain,
 * so a plan that would have settled at 91% was reported at whatever it had
 * banked in its first few hundred steps. Judging keeps them equal; profiling
 * sets stopAt to the top tier and gives up only below the pass mark, so every
 * number that lands in the band the criterion cares about is exact.
 */
function play(spec, plan, target, opts) {
  if (typeof target === 'object' && target !== null) {
    opts = target;
    target = undefined;
  }
  opts = opts || {};
  const stopAt = opts.stopAt === undefined ? target : opts.stopAt;
  const giveUpBelow = opts.giveUpBelow === undefined ? stopAt : opts.giveUpBelow;
  const sim = build(spec);
  const bodies = new B.Bodies(sim);
  const phases = typeof plan.cuts === 'function' ? plan.cuts(sim) : plan.cuts;

  let steps = 0;
  let best = 0;
  let stall = 0;
  let last = '';
  let dug = 0;
  let bailed = false;

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
    if (best >= stopAt) break; // done; nothing later can un-collect it

    // The ceiling: everything not yet lost to a drain. Once that is under the
    // threshold the level cannot reach it however long it runs.
    const ceiling = ((st.released - st.lost) / st.released) * 100;
    if (ceiling < giveUpBelow) {
      bailed = true;
      break;
    }

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
  return { pct: best, dug, steps, balanced: st.balanced, bailed };
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
      kind: 'naive',
      naive: true,
      x,
      cuts: [{ strokes: [{ x0: x, y0: g.sealTop - 1, x1: x, y1: g.floorY - 1 }] }]
    });
  }
  /*
   * Nearest the crystal first. Judging asks "does any obvious plan win", and
   * stops at the first that does — so trying the likeliest winner first turns
   * detecting a boring level from five simulations on average into one. Proving
   * a level is NOT boring still costs the full set; that is the price of a
   * negative, and it is the case that gets rarer as the levels get better.
   */
  const basin = (g.basinL + g.basinR) / 2;
  out.sort((a, b) => Math.abs(a.x - basin) - Math.abs(b.x - basin));
  return out;
}

/*
 * The intended one: the lane, corner by corner. This is what carveIdealChannel
 * cuts and what the game offers as the reference cut, so if this fails the
 * level has no answer the game itself knows about.
 */
function routePlan(sim) {
  return { name: 'route', kind: 'route', cuts: [{ strokes: routeStrokes(sim) }] };
}

/*
 * The strokes of the intended lane, optionally aimed wrong.
 *
 * `shift` slides every waypoint sideways — the player who read the level as a
 * whole slightly off. `aim` slides only the last one, the drop onto the basin —
 * the player who found the right way down and then missed the crystal. Both are
 * clamped inside the walls, so a large error becomes a plan that hugs the wall
 * rather than a plan that digs outside the level.
 */
function routeStrokes(sim, shift, aim, opts) {
  const g = sim.geometry;
  const through = !!(opts && opts.through); // aim as one diagonal through the band
  const correct = !!(opts && opts.correct); // shifted line, but the landing corrected
  const lo = g.wall + 1,
    hi = sim.w - g.wall - 2;
  const clamp = (x) => (x < lo ? lo : x > hi ? hi : x);
  const strokes = [];
  let px = clamp(g.route[0].x + (shift || 0)),
    py = g.sealTop - 1;
  for (let i = 0; i < g.route.length; i++) {
    const last = i === g.route.length - 1;
    if (last && aim && !through) {
      /*
       * An aim error happens BELOW the sand band, not through it.
       *
       * The aimed final leg used to be one diagonal from the top of the band
       * to the offset landing. Through the old corridor-width crossing that
       * diagonal stayed in clay; through the stroke-width crossing it exits
       * into the sand a few rows down, the sand slumps into the cut, and the
       * plan measures burial rather than aim — the probe showed whole rough
       * families scoring [9 failed, 2 aces] with nothing between, which is a
       * lock, not a ladder. No player aims like that: you thread the crossing
       * vertically, then steer in the open clay underneath. So the aimed leg
       * pivots at the band's underside and carries the whole error from
       * there.
       */
      const pivotY = Math.min(g.sandBot + 2, g.route[i].y - 1);
      strokes.push({ x0: px, y0: py, x1: px, y1: pivotY });
      py = pivotY;
    }
    const x = clamp(
      g.route[i].x + (last && correct ? 0 : shift || 0) + (last ? aim || 0 : 0)
    );
    strokes.push({ x0: px, y0: py, x1: x, y1: g.route[i].y });
    px = x;
    py = g.route[i].y;
  }
  return strokes;
}

/*
 * The rough ones: the intended route, cut by somebody who had the idea but not
 * the precision.
 *
 * This family is what makes the criterion measurable at all. Winnable and
 * interesting are both satisfied by a level with exactly one answer and a cliff
 * either side of it — dig the line and collect everything, miss it by a cell
 * and collect nothing — which is not a puzzle, it is a lock. What the game
 * wants is a gradient: the exact line aces, a near miss still passes, a wild
 * miss does not. You cannot see a gradient by sampling one point, so these are
 * the other points.
 *
 * Errors are scaled to the level's own landing zone rather than fixed in cells,
 * and the scale that matters is the crystal PLUS its apron, not the crystal
 * alone. A first attempt sized them to half the basin and to the basin, which
 * measured nothing at all: the basin on an early level is thirty cells across,
 * so the largest error still landed on the collector and every rough plan
 * scored within a point of the exact one whatever the terrain did. The
 * distribution was flat because the probe never left the target.
 *
 * So the four steps go: comfortably inside, on the lip, out on the apron, and
 * past it. That is the run from "found the line" to "missed", and where a level
 * puts the tiers along it is exactly what the criterion is asking about.
 *
 * `pre` is an optional list of phases to cut before every rough attempt — the
 * collapse undercut, on a level whose answer is the dam rather than the lane.
 * The rough family has to be built on the plan that actually aces, because
 * "does a near miss still get home" is a question about the answer, and asking
 * it of a route that never worked measures nothing.
 */
function roughPlans(sim, pre) {
  const g = sim.geometry;
  const basin = Math.max(3, Math.round((g.basinR - g.basinL) / 2));
  const apron = Math.max(2, g.apron);
  const banded = !!(g.difficulty && g.difficulty.sand);
  const out = [];
  const tag = pre ? 'c+' : '';
  const wrap = (strokes) => (pre || []).concat([{ strokes }]);
  /*
   * Ordered by where the score is likeliest to land rather than by how big the
   * error is, because the search stops as soon as it has seen a rough pass. Out
   * on the apron is where a level puts its 1★ if it puts one anywhere; dead
   * centre almost always aces and past the apron almost always fails, so
   * asking those first costs a simulation to learn nothing.
   */
  /*
   * The offsets are chosen around how delivery actually works, which is by
   * OVERLAP: the pool at the bottom of a shaft drains wholesale through any
   * gap it can reach, so a cut whose mouth overlaps the basin at all tends to
   * deliver everything, and one that misses entirely delivers whatever the
   * crown's coin flip returns. The informative offsets are therefore at the
   * edges of overlap, not spread evenly across the level:
   *
   *   lip     about half the cut over the basin — the coin-flip zone
   *   graze   a sliver of overlap: one or two columns' worth
   *   flank   no overlap, landing on the crown's slope
   *   past    beyond the apron entirely
   *
   * There is deliberately no dead-centre step any more. An offset smaller
   * than the dig radius is the same cut as the route — it aced in lockstep
   * with it on every probed level, consumed the crisp budget twice over, and
   * measured nothing the route had not already measured.
   */
  /*
   * On a banded level there is no 'lip' step. Delivery is wholesale through
   * any overlap, so an offset within the tool's own width of the basin is the
   * same cut as the route — it aced in lockstep with it on every probe, and
   * counting it as a separate answer made `crisp` unreachable on exactly the
   * basins wide enough to ace at all. The gradient starts where overlap gets
   * marginal.
   */
  const steps = banded
    ? [
        ['graze', basin + DIG_R - 1],
        ['flank', basin + DIG_R + Math.max(1, Math.ceil(apron / 2))],
        ['past', basin + DIG_R + apron + 2]
      ]
    : [
        ['lip', basin],
        ['graze', basin + DIG_R - 1],
        ['flank', basin + DIG_R + Math.max(1, Math.ceil(apron / 2))],
        ['past', basin + DIG_R + apron + 2]
      ];
  for (const [label, mag] of steps)
    for (const sign of [-1, 1])
      out.push({
        name: tag + 'aim' + label + (sign > 0 ? '+' : '-') + mag,
        kind: 'rough',
        cuts: wrap(routeStrokes(sim, 0, sign * mag))
      });

  /*
   * The impatient player: one diagonal from the band's top straight to the
   * landing, rather than threading the crossing vertically first. The cut
   * exits the crossing partway down the band and the sand takes a share —
   * measured on one candidate the family ran 97, 62, 57, 16 by offset, which
   * is the partial-credit gradient nothing else in a banded level produces.
   */
  if (banded && g.gapHalf) {
    /*
     * Four angles, not two. The burial gradient is steep and ASYMMETRIC —
     * measured on one candidate, +7 died at 16% while -7 survived at 62%,
     * because which wall the lane bends past decides which side the slumping
     * sand seals first. Two probes straddle the window; four give each side a
     * mild and a bold line, and the mild ones are where the 85–92 scores
     * live when they live anywhere.
     */
    for (const mag of [Math.max(3, g.gapHalf - 1), g.gapHalf + 3])
      for (const sign of [-1, 1]) {
        const d = sign * mag;
        out.push({
          name: tag + 'angle' + (d > 0 ? '+' : '') + d,
          kind: 'angle',
          cuts: wrap(routeStrokes(sim, 0, d, { through: true }))
        });
      }
  }
  /*
   * And the same error made higher up: the player who took the whole line
   * across a shelf slightly wrong rather than fumbling only the last drop.
   */
  /*
   * Shifts are capped to what still threads the band crossing. With the gap
   * sized to the dig stroke, a whole-line misread larger than the gap buries
   * itself in sand with certainty — that outcome is real, but it is what the
   * decoy plans already measure. The shift probes the sloppy-but-sane player,
   * and sane stops at the crossing wall.
   */
  const maxShift = banded && g.gapHalf ? Math.max(2, g.gapHalf - 2) : basin + Math.round(apron / 2);
  for (const sign of [-1, 1]) {
    const d = sign * Math.min(maxShift, basin + Math.round(apron / 2));
    out.push({
      name: tag + 'shift' + (d > 0 ? '+' : '') + d,
      kind: 'rough',
      // On a banded level the shifted player still aims the last leg at the
      // crystal — the misread costs the sand the off-centre thread nicks, not
      // a landing error nobody would actually make.
      cuts: wrap(routeStrokes(sim, d, 0, { correct: banded }))
    });
  }
  return out;
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
// The undercut strokes that drop each gravel pocket, shared between the
// collapse plans and the rough family built on a collapse answer.
function collapseUndercuts(sim) {
  const g = sim.geometry;
  if (!g.gravelAt || !g.gravelAt.length) return [];
  return g.gravelAt.map((p) => ({
    x0: p[0] - p[2] - 2,
    y0: p[1] + p[2] + 2,
    x1: p[0] + p[2] + 2,
    y1: p[1] + p[2] + 2
  }));
}

function collapsePlans(sim) {
  const undercuts = collapseUndercuts(sim);
  if (!undercuts.length) return [];
  const out = [];

  for (let i = 0; i < undercuts.length; i++) {
    out.push({
      name: 'collapse' + i + '+route',
      kind: 'collapse',
      cuts: [
        { strokes: [undercuts[i]], settle: 1400 },
        { strokes: routeStrokes(sim) }
      ]
    });
  }
  if (undercuts.length > 1) {
    out.push({
      name: 'collapse*+route',
      kind: 'collapse',
      cuts: [
        { strokes: undercuts, settle: 1600 },
        { strokes: routeStrokes(sim) }
      ]
    });
  }
  return out;
}

/*
 * The tempting wrong answers: for each decoy lane, the plan a player who fell
 * for it would cut — the real route's line as far as the last shelf, then
 * across to the decoy crossing and straight down through it.
 *
 * These exist because the levels grew decoy crossings, and a decoy that
 * quietly works is not a decoy: it is a second answer wearing a disguise, and
 * the level teaches the player that reading the terrain does not matter. So
 * every decoy is played, and the criterion counts a passing decoy the same
 * way it counts a passing naive drop — as proof the level is not hard.
 */
function decoyPlans(sim) {
  const g = sim.geometry;
  if (!g.decoyAt || !g.decoyAt.length) return [];
  const upper = g.route.filter((p) => p.y < g.sandTop - 2);
  return g.decoyAt.map((dx) => {
    const strokes = [];
    let px = g.route[0].x,
      py = g.sealTop - 1;
    for (const p of upper) {
      strokes.push({ x0: px, y0: py, x1: p.x, y1: p.y });
      px = p.x;
      py = p.y;
    }
    strokes.push({ x0: px, y0: py, x1: dx, y1: g.sandTop - 2 });
    strokes.push({ x0: dx, y0: g.sandTop - 2, x1: dx, y1: g.floorY - 1 });
    return { name: 'decoy@' + dx, kind: 'decoy', cuts: [{ strokes }] };
  });
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

// ---------------------------------------------------------------------------
// The distribution
// ---------------------------------------------------------------------------

/*
 * Which star tier a score lands in. `0` is a failure — under the pass mark.
 */
function bandOf(pct) {
  return pct >= THREE ? 3 : pct >= TWO ? 2 : pct >= WIN ? 1 : 0;
}

/*
 * Profile a spec: run every plan, keep every score, and say whether the shape
 * of them is the shape a good level has.
 *
 * The criterion, in the owner's words: "there should be a challenge in finding
 * the right path, but it must be doable" — one exact answer scoring near 100%,
 * a few rougher answers passing in the 85–92 band, and every naive straight
 * drop under 85%. Written out as three clauses that a spec either meets or does
 * not:
 *
 *   ace         some plan reaches 3★. There IS a line, and finding it is worth
 *               something. Without this the level tops out at "adequate" and
 *               the top tier is unreachable, which is a scoreboard with a dead
 *               row in it.
 *   forgiving   some plan lands in [85, 92) — 1★. A near miss still gets home.
 *               Without this the level is a lock rather than a puzzle: the only
 *               scores available are ace and nothing, and there is no partial
 *               credit for having half the idea.
 *   hard        every naive drop is under 85. Nothing about the level can be
 *               had by dragging downwards and hoping.
 *
 * All three, or it is not a level worth banking.
 *
 * Ordering exists so the common rejections are cheap — the generator runs this
 * on thousands of specs and almost all of them are bad. Two things decide it,
 * and they are not the same thing:
 *
 *   which question is rarest    reject on that first, so most specs never
 *                               reach the later stages at all
 *   what each question costs    in simulated steps, which varies more than
 *                               tenfold between plan families
 *
 * The rough family answers the rare question AND is the cheap one, so it goes
 * first after the route. Its plans get down to the cavern and settle in a
 * thousand steps or so; the naive drops are the expensive ones, because a shaft
 * that meets the roof leaves the payload working its way along a shelf looking
 * for the open end, which takes several thousand steps to resolve into a
 * verdict of nought per cent. Measured on one level-4 candidate: the whole
 * rough family, six seconds; the naive family, fifty.
 *
 * This has moved once already. Naive drops used to go first, on the reasoning
 * that a boring level is the common case and dies after one or two simulations.
 * That stopped being true the moment the roof over the crystal was actually
 * built — a straight drop essentially never clears a level now, so those ten
 * expensive simulations ran in full and told us nothing.
 *
 * Note what is NOT short-circuited: the rough family always runs to the end,
 * even once it has seen enough to accept. Truncating it saved three seconds and
 * left the histogram partial, which meant every accepted spec had to be
 * profiled a second time from scratch to be ranked or recorded — fifty seconds
 * to save three. A spec that survives every stage here leaves with a complete
 * distribution and needs no second pass.
 *
 * `opts.full` runs everything even after a rejection, which is what the report
 * and the CLI want: when a level is wrong you want the whole table, not the
 * first thing that was wrong with it.
 */
function profile(spec, opts = {}) {
  const full = !!opts.full;
  const minRough = opts.minRough === undefined ? 1 : opts.minRough;
  /*
   * The ace budget, for callers that will reject on crisp anyway. Too many
   * aces is the most common rejection after a dead route, and without this it
   * was also the most expensive: crisp was only computed at the end, so a
   * five-ace slope still paid for the whole naive family — the costliest
   * plans in the set — before being thrown away. Callers that want the full
   * distribution (the report, the CLI, the teaching levels whose criterion
   * does not include crisp) leave it unset.
   */
  const maxAces = opts.maxAces === undefined ? Infinity : opts.maxAces;
  const probe = build(spec);
  const rows = [];
  const settings = { stopAt: THREE, giveUpBelow: WIN };

  let aces = 0;
  let broke = null;
  const run = (p) => {
    const r = play(spec, p, settings);
    if (!r.balanced) broke = broke || p.name;
    const row = {
      name: p.name,
      kind: p.kind || 'route',
      pct: r.pct,
      band: bandOf(r.pct),
      dug: r.dug,
      steps: r.steps,
      // The score is exact unless the run was abandoned as hopeless, in which
      // case it is a lower bound — and known to be under the pass mark, which
      // is the only thing anyone asks of a failing plan.
      exact: !r.bailed
    };
    rows.push(row);
    // Mirrors the verdict's ace counting — see there for why only these two
    // kinds are answers. The budget has to count the same way, or a level
    // with three same-answer variants acing gets bailed before the verdict
    // that would have accepted it is ever computed.
    if ((row.kind === 'route' || row.kind === 'collapse') && row.band === 3) aces++;
    return row;
  };
  const acesBlown = () => !full && aces > maxAces;

  // 1. Is there an answer at all?
  const route = run(routePlan(probe));
  if (broke) return { error: 'conservation broke on ' + broke, rows };

  /*
   * 2. If the lane is not the answer, is the DAM the answer?
   *
   * This used to reject outright the moment the route failed to ace, and that
   * rejection was quietly deciding what kind of game this is. A level whose
   * best line is "collapse the pocket, then route" has a failing route by
   * definition — the dam is what makes the route worth cutting — so the
   * short-circuit made mechanic-required levels unfindable, and every level
   * the generator could possibly bank was a variation on "dig the lane". The
   * constructive move stayed decoration because the judge refused to look at
   * levels where it was load-bearing.
   *
   * So a failed route is now a fork, not a verdict: try the collapses, and if
   * one of them aces, the level's answer is the dam and the rest of the
   * profile measures THAT answer. Only when nothing aces is the spec dead.
   *
   * The route has to be badly beaten, not merely edged out. A route at 96.9%
   * with a collapse at 97.1% is a lane level with a redundant flourish, and
   * banking it as "the dam is the answer" would teach the player a move the
   * level does not actually need. TWO is the line: the lane alone must not
   * even reach 2★ for the dam to count as required.
   */
  let pre = null;
  let baseName = 'route';
  if (route.band < 3) {
    /*
     * Bounded at two attempts: the single-pocket collapses. Each collapse
     * simulation is the most expensive plan in the set (a 1400-step settle
     * before anything is cut), a failed route is the single most common
     * rejection, and the all-pockets variant almost never aces where neither
     * single pocket does — so an unbounded rescue would spend most of the
     * search's whole budget confirming rejections.
     */
    for (const p of collapsePlans(probe).slice(0, 2)) {
      const r = run(p);
      if (broke) return { error: 'conservation broke on ' + broke, rows };
      if (r.band === 3 && route.pct < TWO && !pre) {
        pre = p.cuts.slice(0, -1); // the undercut phases, without the route cut
        baseName = p.name;
      }
    }
    if (!full && !pre) return verdict(rows, minRough, 'no ace: route ' + route.pct.toFixed(1));
  }

  // 3. Does a near miss still get home? Asked of the answer that aces — the
  // lane, or the dam-then-lane — because forgiveness of a plan that never
  // worked measures nothing.
  let roughs = 0;
  for (const p of roughPlans(probe, pre)) {
    const r = run(p);
    if (broke) return { error: 'conservation broke on ' + broke, rows };
    if (r.band === 1) roughs++;
    if (acesBlown()) return verdict(rows, minRough, aces + ' aces already');
  }
  if (!full && roughs < minRough) return verdict(rows, minRough, 'nothing passes roughly');

  // 4. Do the tempting wrong answers actually fail? A decoy is cheaper to
  // play than a naive drop — the crown throws its payload to the drains and
  // the run bails — and a passing one is the strongest possible rejection:
  // the level's whole premise is that the lanes have to be read.
  for (const p of decoyPlans(probe)) {
    const r = run(p);
    if (broke) return { error: 'conservation broke on ' + broke, rows };
    if (!full && r.band > 0) return verdict(rows, minRough, p.name + ' works — not a decoy');
  }

  // 5. Is it obvious?
  for (const p of naivePlans(probe)) {
    const r = run(p);
    if (broke) return { error: 'conservation broke on ' + broke, rows };
    if (!full && r.band > 0) return verdict(rows, minRough, 'naive ' + p.name + ' clears it');
  }

  /*
   * 6. Any collapse plans not already run in step 2 — on a lane level they are
   * still worth recording, because a dam that ALSO works is part of the
   * level's true distribution. Most expensive family, so it goes last and only
   * a spec that survived everything else pays for it.
   */
  const seen = new Set(rows.map((r) => r.name));
  for (const p of collapsePlans(probe)) {
    if (seen.has(p.name)) continue;
    run(p);
    if (broke) return { error: 'conservation broke on ' + broke, rows };
    if (acesBlown()) return verdict(rows, minRough, aces + ' aces already');
  }
  return verdict(rows, minRough, undefined, baseName);
}

function verdict(rows, minRough, bailedBecause, baseName) {
  const naive = rows.filter((r) => r.kind === 'naive');
  const decoys = rows.filter((r) => r.kind === 'decoy');
  // Decoys are wrong answers by construction: their scores are neither rungs
  // on the ladder nor aces, whatever they are. They only ever count against.
  const solved = rows.filter((r) => r.kind !== 'naive' && r.kind !== 'decoy');
  const top = (rs) => rs.reduce((a, b) => (b.pct > a.pct ? b : a), { pct: 0, name: null, dug: 0 });

  const best = top(solved);
  const naiveBest = top(naive);
  const naiveWins = naive.filter((r) => r.band > 0).length;
  const decoyWins = decoys.filter((r) => r.band > 0).length;
  const rough = solved.filter((r) => r.band === 1).length;
  /*
   * An ace is a distinct ANSWER, not a distinct plan. Only two kinds
   * qualify: the route (the intended line) and a collapse (the constructive
   * move). Everything else acing is either fatal or the same answer again:
   *
   *   naive/decoy  counted by `hard`, and one of them passing kills the
   *                level anyway
   *   angle        the route with a wobble — burial is a threshold, so it
   *                either IS the same cut or it seals and dies
   *   rough        the route cut by somebody with the idea but not the
   *                precision. Every rough plan follows the route's corners
   *                by construction, so on woven terrain — which is now the
   *                whole bank — an acing lip or graze means the LAST LEG
   *                forgives a hand-width, after the weave has been read and
   *                cut in full. Measured at level 8: route, two lips, two
   *                grazes ace together while every shift and naive dies on
   *                a shelf. Five aces, one answer. Counting them as five
   *                made every woven clay level uncrisp by construction.
   *
   * Rough scores still land in the histogram and the ladder; they just
   * cannot dilute what finding the answer is worth.
   */
  const aces = solved.filter(
    (r) => r.band === 3 && (r.kind === 'route' || r.kind === 'collapse')
  ).length;
  // By kind rather than by name: routePlan is the only plan of kind 'route',
  // and callers that synthesise rows (the tests) name them freely.
  const routeRow = rows.find((r) => r.kind === 'route');
  const routePct = routeRow ? routeRow.pct : 0;

  // A histogram over the tiers, which is the whole point of the exercise: the
  // shape of it says more than any single number pulled out of it.
  const bands = [0, 0, 0, 0];
  for (const r of solved) bands[r.band]++;
  const naiveBands = [0, 0, 0, 0];
  for (const r of naive) naiveBands[r.band]++;

  const ace = aces >= 1;
  const forgiving = rough >= minRough;
  const hard = naiveWins === 0 && decoyWins === 0;
  /*
   * The clauses the first criterion missed, and the reason a bank could pass
   * it and still play easy. The owner's words were "ONE exact answer scoring
   * ~100%, a few rougher answers passing in the 85–92 band" — and `ace` only
   * ever checked that an exact answer exists. A level where every offset of
   * the route aces too satisfies that clause perfectly and is a slope with a
   * scoreboard: the measured bank had a median of five aces per level, so 3★
   * meant "you found the area", not "you found the line".
   *
   *   crisp   finding the line is worth something because ALMOST NOTHING
   *           else aces — at most CRISP_ACES plans reach 3★
   *   graded  there is a real ladder under the top rung: at least two plans
   *           land in the passing-but-not-acing range, so the space between
   *           "found the line" and "missed" has scores in it
   */
  const crisp = ace && aces <= CRISP_ACES;
  const graded = bands[1] + bands[2] >= 2;
  // The level whose answer is a move, not a lane: the route alone cannot even
  // reach 2★, and something aces anyway.
  const mechanicRequired = ace && routePct < TWO;
  const reasons = [];
  if (!ace) reasons.push('no plan reaches ' + THREE + '%');
  if (ace && !crisp) reasons.push(aces + ' plans ace — the line is not special');
  if (!graded) reasons.push('no ladder: ' + (bands[1] + bands[2]) + ' plans between ' + WIN + ' and ' + THREE);
  if (!forgiving) reasons.push('nothing passes roughly (' + rough + ' in ' + WIN + '–' + TWO + ')');
  if (naiveWins) reasons.push(naiveWins + ' naive drop(s) clear it');
  if (decoyWins) reasons.push(decoyWins + ' decoy lane(s) actually work');
  if (bailedBecause) reasons.push('short-circuited: ' + bailedBecause);

  return {
    rows,
    // The old three-value verdict, unchanged in meaning, so callers that only
    // want a yes/no keep working.
    winnable: best.pct >= WIN,
    interesting: best.pct >= WIN && naiveWins === 0,
    // The new one.
    fun: ace && forgiving && hard,
    ace,
    forgiving,
    hard,
    best: best.pct,
    plan: best.name,
    dug: best.dug,
    naiveBest: naiveBest.pct,
    naiveWins,
    decoyWins,
    rough,
    aces,
    bands,
    naiveBands,
    margin: best.pct - naiveBest.pct,
    crisp,
    graded,
    routePct,
    mechanicRequired,
    // Which answer the rough family was built on: 'route', or the collapse
    // plan that aced when the route could not.
    base: baseName || 'route',
    // A spec rejected early has not run every plan, so its distribution is
    // partial. Say so rather than letting a caller read a zero as a measurement.
    partial: !!bailedBecause,
    reasons
  };
}

/*
 * One line summarising a profile, for the verification report and the CLI.
 */
function summarise(p) {
  if (p.error) return p.error;
  const b = p.bands;
  return (
    (p.fun ? 'FUN ' : p.interesting ? 'ok  ' : p.winnable ? 'dull' : 'BAD ') +
    (p.mechanicRequired ? ' DAM-REQUIRED' : '') +
    '  best ' + p.best.toFixed(1).padStart(5) + '% (' + (p.plan || '—') + ')' +
    '  naive ' + p.naiveBest.toFixed(1).padStart(5) + '%' +
    '  tiers ' + b[3] + '★★★/' + b[2] + '★★/' + b[1] + '★/' + b[0] + '✗' +
    (p.partial ? '  [partial]' : '') +
    (p.fun ? '' : '  — ' + p.reasons.join('; '))
  );
}

module.exports = {
  judge,
  profile,
  verdict,
  summarise,
  play,
  build,
  naivePlans,
  decoyPlans,
  routePlan,
  roughPlans,
  collapsePlans,
  routeStrokes,
  collapseUndercuts,
  bandOf,
  GRID_W,
  GRID_H,
  WIN,
  TWO,
  THREE,
  CRISP_ACES
};

/*
 * `node tools/solve.js 4 [13 …]` — profile levels and print the table. This is
 * the thing you actually reach for when a level is wrong: the distribution says
 * which way it is wrong, which the pass/fail from the test suite cannot.
 */
if (require.main === module) {
  // Through the bank, so the CLI profiles the level the game would build and
  // not the one the difficulty curve would have built instead.
  const { specFor } = require('./bank.js');
  const args = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
  for (const n of args.length ? args : [1]) {
    const spec = specFor(n);
    const p = profile(spec, { full: true });
    process.stdout.write('\nlevel ' + n + '  ' + summarise(p) + '\n');
    if (p.rows)
      for (const r of p.rows.slice().sort((a, b) => b.pct - a.pct))
        process.stdout.write(
          '  ' + r.kind.padEnd(9) + r.name.padEnd(16) +
            r.pct.toFixed(1).padStart(6) + '%  ' +
            (r.band ? '★'.repeat(r.band) : '—').padEnd(4) +
            (r.exact ? '' : ' (at least)') + '\n'
        );
  }
}
