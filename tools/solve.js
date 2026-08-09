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
function routeStrokes(sim, shift, aim) {
  const g = sim.geometry;
  const lo = g.wall + 1,
    hi = sim.w - g.wall - 2;
  const clamp = (x) => (x < lo ? lo : x > hi ? hi : x);
  const strokes = [];
  let px = clamp(g.route[0].x + (shift || 0)),
    py = g.sealTop - 1;
  for (let i = 0; i < g.route.length; i++) {
    const last = i === g.route.length - 1;
    const x = clamp(g.route[i].x + (shift || 0) + (last ? aim || 0 : 0));
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
 */
function roughPlans(sim) {
  const g = sim.geometry;
  const basin = Math.max(3, Math.round((g.basinR - g.basinL) / 2));
  const apron = Math.max(2, g.apron);
  const out = [];
  /*
   * Ordered by where the score is likeliest to land rather than by how big the
   * error is, because the search stops as soon as it has seen a rough pass. Out
   * on the apron is where a level puts its 1★ if it puts one anywhere; dead
   * centre almost always aces and past the apron almost always fails, so
   * asking those first costs a simulation to learn nothing.
   */
  const steps = [
    ['apron', basin + Math.round(apron / 2)],
    ['lip', basin],
    ['past', basin + apron + 2],
    ['in', Math.max(2, Math.round(basin / 2))]
  ];
  for (const [label, mag] of steps)
    for (const sign of [-1, 1])
      out.push({
        name: 'aim' + label + (sign > 0 ? '+' : '-') + mag,
        kind: 'rough',
        cuts: [{ strokes: routeStrokes(sim, 0, sign * mag) }]
      });
  /*
   * And the same error made higher up: the player who took the whole line
   * across a shelf slightly wrong rather than fumbling only the last drop.
   */
  for (const sign of [-1, 1]) {
    const d = sign * (basin + Math.round(apron / 2));
    out.push({
      name: 'shift' + (d > 0 ? '+' : '') + d,
      kind: 'rough',
      cuts: [{ strokes: routeStrokes(sim, d, 0) }]
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
  const probe = build(spec);
  const rows = [];
  const settings = { stopAt: THREE, giveUpBelow: WIN };

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
    return row;
  };

  // 1. Is there an answer at all?
  const route = run(routePlan(probe));
  if (broke) return { error: 'conservation broke on ' + broke, rows };
  if (!full && route.pct < THREE) return verdict(rows, minRough, 'no ace: route ' + route.pct.toFixed(1));

  // 2. Does a near miss still get home? The rare question, and the cheap one.
  let roughs = 0;
  for (const p of roughPlans(probe)) {
    const r = run(p);
    if (broke) return { error: 'conservation broke on ' + broke, rows };
    if (r.band === 1) roughs++;
  }
  if (!full && roughs < minRough) return verdict(rows, minRough, 'nothing passes roughly');

  // 3. Is it obvious?
  for (const p of naivePlans(probe)) {
    const r = run(p);
    if (broke) return { error: 'conservation broke on ' + broke, rows };
    if (!full && r.band > 0) return verdict(rows, minRough, 'naive ' + p.name + ' clears it');
  }

  /*
   * 4. And the constructive move. Last because it is the most expensive plan in
   * the set — it settles a gravel pile before it cuts anything — and because a
   * collapse can only ADD a passing score, so it could never rescue a spec the
   * clauses above have already rejected. Only a spec that has survived them all
   * pays for it.
   */
  for (const p of collapsePlans(probe)) {
    run(p);
    if (broke) return { error: 'conservation broke on ' + broke, rows };
  }
  return verdict(rows, minRough);
}

function verdict(rows, minRough, bailedBecause) {
  const naive = rows.filter((r) => r.kind === 'naive');
  const solved = rows.filter((r) => r.kind !== 'naive');
  const top = (rs) => rs.reduce((a, b) => (b.pct > a.pct ? b : a), { pct: 0, name: null, dug: 0 });

  const best = top(solved);
  const naiveBest = top(naive);
  const naiveWins = naive.filter((r) => r.band > 0).length;
  const rough = solved.filter((r) => r.band === 1).length;
  const aces = solved.filter((r) => r.band === 3).length;

  // A histogram over the tiers, which is the whole point of the exercise: the
  // shape of it says more than any single number pulled out of it.
  const bands = [0, 0, 0, 0];
  for (const r of solved) bands[r.band]++;
  const naiveBands = [0, 0, 0, 0];
  for (const r of naive) naiveBands[r.band]++;

  const ace = aces >= 1;
  const forgiving = rough >= minRough;
  const hard = naiveWins === 0;
  const reasons = [];
  if (!ace) reasons.push('no plan reaches ' + THREE + '%');
  if (!forgiving) reasons.push('nothing passes roughly (' + rough + ' in ' + WIN + '–' + TWO + ')');
  if (!hard) reasons.push(naiveWins + ' naive drop(s) clear it');
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
    rough,
    aces,
    bands,
    naiveBands,
    margin: best.pct - naiveBest.pct,
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
  routePlan,
  roughPlans,
  collapsePlans,
  routeStrokes,
  bandOf,
  GRID_W,
  GRID_H,
  WIN,
  TWO,
  THREE
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
