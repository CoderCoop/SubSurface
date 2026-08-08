'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Sim, MAT, buildLevel, carveIdealChannel } = require('../docs/play/sim.js');

/*
 * This suite covers the cellular layer on its own, so its levels are built
 * without the fractured slab. Fractured rock is inert to the grid — only the
 * rigid-body layer can detach it — so leaving it in would block the corridor
 * and make every level here unsolvable for reasons that have nothing to do
 * with the rules under test. bodies.test.js covers it with that layer active.
 */
const build = (opts) => buildLevel(Object.assign({ fractured: false }, opts));

/*
 * A stage in the sand band. Levels 1–10 are clay only by design, so any test
 * whose subject is the sand band has to ask for a level that has one.
 */
const SANDY = 15;

// A bare grid with a bedrock shell and nothing inside, for unit-level rules.
function blank(w, h, seed) {
  const s = new Sim(w, h, seed === undefined ? 42 : seed);
  for (let x = 0; x < w; x++) {
    s.set(x, 0, MAT.BEDROCK);
    s.set(x, h - 1, MAT.BEDROCK);
  }
  for (let y = 0; y < h; y++) {
    s.set(0, y, MAT.BEDROCK);
    s.set(w - 1, y, MAT.BEDROCK);
  }
  return s;
}

function put(sim, x, y, m) {
  sim.set(x, y, m);
  if (m === MAT.WATER) sim.released++;
}

function count(sim, m) {
  let n = 0;
  for (let i = 0; i < sim.cells.length; i++) if (sim.cells[i] === m) n++;
  return n;
}

function run(sim, steps) {
  for (let i = 0; i < steps; i++) sim.step();
  return sim.stats();
}

// ---------------------------------------------------------------------------
// Volume conservation — the invariant the whole absorption design rests on.
// ---------------------------------------------------------------------------

test('conservation holds every step in a level with sand and a channel', () => {
  const sim = carveIdealChannel(build({ w: 90, h: 150, seed: 7 }));
  assert.ok(sim.released > 0, 'level should release some fluid');

  for (let i = 0; i < 900; i++) {
    sim.step();
    const s = sim.stats();
    assert.ok(
      s.balanced,
      `step ${i}: ${s.inPlay} in play + ${s.collected} collected + ` +
        `${s.lost} lost + ${s.heldBySand} held != ${s.released} released`
    );
  }
});

test('conservation holds with no digging at all', () => {
  const sim = build({ w: 60, h: 100, seed: 3 });
  const s = run(sim, 300);
  assert.ok(s.balanced);
  assert.strictEqual(s.collected, 0, 'sealed level collects nothing');
  assert.strictEqual(s.lost, 0, 'sealed level loses nothing');
  assert.strictEqual(s.inPlay, s.released, 'all fluid still in the chamber');
});

test('digging wet sand returns the held unit rather than destroying it', () => {
  const sim = blank(20, 20);
  put(sim, 10, 10, MAT.WETSAND);
  sim.released = 1; // the unit that wet sand is holding

  assert.strictEqual(sim.stats().heldBySand, 1);
  const r = sim.dig(10, 10, 2);
  assert.strictEqual(r.freed, 1);

  const s = sim.stats();
  assert.strictEqual(s.heldBySand, 0);
  assert.strictEqual(s.inPlay, 1);
  assert.ok(s.balanced);
});

// ---------------------------------------------------------------------------
// Fluid
// ---------------------------------------------------------------------------

test('fluid falls and pools flat on clay', () => {
  const sim = blank(21, 20);
  for (let x = 1; x < 20; x++) put(sim, x, 15, MAT.CLAY);
  for (let y = 2; y < 6; y++) put(sim, 10, y, MAT.WATER);

  run(sim, 200);
  assert.strictEqual(count(sim, MAT.WATER), 4, 'clay is watertight');

  // All of it should have settled onto the clay, not stayed in a column.
  let top = 99;
  for (let y = 0; y < 20; y++)
    for (let x = 0; x < 21; x++)
      if (sim.get(x, y) === MAT.WATER && y < top) top = y;
  assert.ok(top >= 13, `fluid should be resting on the clay, topmost at ${top}`);
});

test('a pool on a ledge finds the edge instead of diffusing toward it', () => {
  /*
   * Spreading one column per step makes crossing a ledge a random walk, so the
   * time to reach an edge grows with the SQUARE of the distance and a puddle
   * sits there hunting for a drop it should have found at once. Fluid now
   * looks along the surface and moves to the furthest useful cell, so this is
   * bounded by distance rather than distance squared.
   *
   * Measured: 2128 steps before this rule, 263 after. The budget below is set
   * between the two, so it fails if that regresses without pinning the exact
   * number the tuning happens to produce.
   */
  const sim = blank(60, 40);
  for (let x = 1; x < 45; x++) put(sim, x, 20, MAT.CLAY); // ledge, edge at x=44
  for (let y = 17; y < 20; y++)
    for (let x = 3; x < 20; x++) put(sim, x, y, MAT.WATER);

  let steps = null;
  for (let i = 1; i <= 4000 && steps === null; i++) {
    sim.step();
    let below = 0;
    for (let y = 21; y < 39; y++)
      for (let x = 1; x < 59; x++) if (sim.raw(x, y) === MAT.WATER) below++;
    if (below > 30) steps = i;
  }

  assert.ok(steps !== null, 'the pool never reached the edge at all');
  assert.ok(
    steps < 800,
    `pool took ${steps} steps to start draining; it should find the edge, not wander to it`
  );
  assert.ok(sim.stats().balanced);
});

test('fluid does not tunnel sideways through a wall to reach open space', () => {
  // The sideways scan has to stop at the first obstruction, or a pool would
  // teleport through clay into whatever cavity happens to lie beyond it.
  const sim = blank(40, 24);
  for (let x = 1; x < 39; x++) put(sim, x, 18, MAT.CLAY); // floor
  for (let y = 12; y < 18; y++) put(sim, 20, y, MAT.CLAY); // dividing wall
  for (let x = 2; x < 18; x++) put(sim, x, 17, MAT.WATER); // pool on the left

  run(sim, 600);

  let right = 0;
  for (let y = 0; y < 24; y++)
    for (let x = 21; x < 39; x++) if (sim.raw(x, y) === MAT.WATER) right++;
  assert.strictEqual(right, 0, `${right} units got through the wall`);
  assert.ok(sim.stats().balanced);
});

test('deep columns raise pressure, shallow puddles do not', () => {
  const deep = blank(9, 40);
  for (let y = 2; y < 32; y++) put(deep, 4, y, MAT.WATER);
  deep.computeHead();
  assert.ok(deep.stats().pressure > 20, 'a 30-cell column should read high');

  const shallow = blank(9, 40);
  for (let x = 2; x < 7; x++) put(shallow, x, 37, MAT.WATER);
  shallow.computeHead();
  assert.ok(shallow.stats().pressure <= 2, 'a puddle should read near zero');
});

test('fluid reaching a drain is counted as lost, not vanished', () => {
  const sim = blank(11, 20);
  for (let x = 1; x < 10; x++) put(sim, x, 17, MAT.DRAIN);
  for (let y = 2; y < 5; y++) put(sim, 5, y, MAT.WATER);

  const s = run(sim, 200);
  assert.strictEqual(s.lost, 3);
  assert.strictEqual(s.inPlay, 0);
  assert.ok(s.balanced);
});

// ---------------------------------------------------------------------------
// Sand
// ---------------------------------------------------------------------------

test('a sand column collapses into a pile with sloped flanks', () => {
  const sim = blank(41, 30);
  for (let y = 4; y < 27; y++) put(sim, 20, y, MAT.SAND);
  const before = count(sim, MAT.SAND);

  run(sim, 400);
  assert.strictEqual(count(sim, MAT.SAND), before, 'grains are conserved');

  // Measure the pile: it should be wider at the base than at the top.
  const widthAt = (y) => {
    let n = 0;
    for (let x = 0; x < 41; x++) if (sim.get(x, y) === MAT.SAND) n++;
    return n;
  };
  assert.ok(
    widthAt(28) > widthAt(24),
    `base ${widthAt(28)} should be wider than upper ${widthAt(24)}`
  );
});

test('sand sinks through fluid rather than floating on it', () => {
  const sim = blank(11, 20);
  for (let y = 10; y < 18; y++) for (let x = 1; x < 10; x++) put(sim, x, y, MAT.WATER);
  put(sim, 5, 3, MAT.SAND);

  run(sim, 300);
  // A submerged grain soaks up a unit on the way down, so look for either
  // state — what matters is that it ended at the bottom, not floating.
  let sandY = -1;
  for (let y = 0; y < 20; y++)
    for (let x = 0; x < 11; x++) {
      const m = sim.get(x, y);
      if (m === MAT.SAND || m === MAT.WETSAND) sandY = y;
    }
  assert.ok(sandY >= 16, `grain should have sunk to the bottom, ended at ${sandY}`);
  assert.ok(sim.stats().balanced);
});

// ---------------------------------------------------------------------------
// Absorption and pressure release — the rule chosen for this build
// ---------------------------------------------------------------------------

test('sand soaks fluid up into wet sand', () => {
  const sim = blank(15, 24);
  for (let y = 14; y < 22; y++) for (let x = 1; x < 14; x++) put(sim, x, y, MAT.SAND);
  for (let y = 8; y < 13; y++) put(sim, 7, y, MAT.WATER);

  const s = run(sim, 400);
  assert.ok(s.heldBySand > 0, 'some fluid should be held as wet sand');
  assert.ok(s.balanced, 'and it must still be accounted for');
});

test('a shallow puddle on sand is held, not passed through', () => {
  const sim = blank(15, 24);
  for (let y = 12; y < 22; y++) for (let x = 1; x < 14; x++) put(sim, x, y, MAT.SAND);
  for (let x = 6; x < 9; x++) put(sim, x, 11, MAT.WATER); // head of 1

  const s = run(sim, 600);
  assert.strictEqual(s.lost, 0);
  assert.strictEqual(s.collected, 0);
  assert.ok(
    s.heldBySand > 0 || s.inPlay > 0,
    'without pressure the band keeps what it takes'
  );
  assert.ok(s.balanced);
});

// A narrow shaft holding a tall column, bearing on a sand plug that rests
// directly on a collector. The shaft matters: a column that is free to spread
// sideways becomes a shallow puddle and never builds any head.
function plugRig(plugRows) {
  const sim = blank(9, 60);
  const plugTop = 57 - plugRows;
  for (let y = 4; y < plugTop; y++)
    for (const x of [1, 2, 3, 5, 6, 7]) put(sim, x, y, MAT.BEDROCK);
  for (let y = 4; y < plugTop; y++) put(sim, 4, y, MAT.WATER);
  for (let y = plugTop; y < 57; y++)
    for (let x = 1; x < 8; x++) put(sim, x, y, MAT.SAND);
  for (let x = 1; x < 8; x++) put(sim, x, 57, MAT.COLLECTOR);
  return sim;
}

test('enough head squeezes fluid back out and through a saturated band', () => {
  const sim = plugRig(5);
  const s = run(sim, 20000);
  assert.ok(
    s.collected > 0,
    `pressure should drive fluid through the band, collected ${s.collected}`
  );
  assert.ok(
    s.collected > s.released * 0.5,
    `most of it should get through, collected ${s.collected}/${s.released}`
  );
  assert.ok(s.balanced);
});

test('a thicker band keeps more of the payload', () => {
  const thin = run(plugRig(3), 20000);
  const thick = run(plugRig(8), 20000);
  assert.ok(
    thick.heldBySand > thin.heldBySand,
    `thicker band should retain more: ${thick.heldBySand} vs ${thin.heldBySand}`
  );
  assert.ok(
    thick.collected < thin.collected,
    `and deliver less: ${thick.collected} vs ${thin.collected}`
  );
  assert.ok(thin.balanced && thick.balanced);
});

// ---------------------------------------------------------------------------
// Digging
// ---------------------------------------------------------------------------

test('digging never removes bedrock or the collector', () => {
  const sim = blank(20, 20);
  put(sim, 10, 10, MAT.COLLECTOR);
  const bedrockBefore = count(sim, MAT.BEDROCK);

  sim.dig(0, 0, 8);
  sim.dig(10, 10, 4);
  sim.digLine(0, 19, 19, 0, 6);

  assert.strictEqual(count(sim, MAT.BEDROCK), bedrockBefore);
  assert.strictEqual(count(sim, MAT.COLLECTOR), 1);
});

test('a swipe leaves a continuous tunnel, not a dotted line', () => {
  const sim = blank(60, 30);
  for (let y = 1; y < 29; y++) for (let x = 1; x < 59; x++) put(sim, x, y, MAT.CLAY);

  sim.digLine(5, 15, 54, 15, 2);
  for (let x = 6; x <= 53; x++)
    assert.strictEqual(
      sim.get(x, 15),
      MAT.EMPTY,
      `gap in the tunnel at x=${x}`
    );
});

test('digging is irreversible — nothing ever refills', () => {
  const sim = build({ w: 60, h: 100, seed: 5 });
  const g = sim.geometry;
  sim.digLine(g.centreX, g.sealTop, g.centreX, g.cavernTop, 3);

  const dugCells = [];
  for (let y = g.sealTop; y < g.cavernTop; y++)
    if (sim.get(g.centreX, y) === MAT.EMPTY) dugCells.push(y);

  run(sim, 200);
  // Sand may slump back in, but clay and bedrock must never reappear.
  for (const y of dugCells) {
    const m = sim.get(g.centreX, y);
    assert.notStrictEqual(m, MAT.CLAY, `clay reappeared at y=${y}`);
    assert.notStrictEqual(m, MAT.BEDROCK, `bedrock reappeared at y=${y}`);
  }
});

// ---------------------------------------------------------------------------
// Integration — the level has to actually be solvable
// ---------------------------------------------------------------------------

test('the reference channel clears the 85% win threshold', () => {
  const sim = carveIdealChannel(build({ w: 90, h: 150, seed: 7 }));
  // A wide reservoir draining through a narrow shaft takes a while — the
  // fluid is viscous by design, so give it time to finish rather than
  // reading a percentage off a level that is still emptying.
  const s = run(sim, 20000);
  assert.ok(s.balanced, 'accounting stays true across a full run');
  assert.ok(
    s.collectionPct >= 85,
    `reference solution collected ${s.collectionPct.toFixed(1)}%, ` +
      `need 85% (held ${s.heldBySand}, lost ${s.lost}, in play ${s.inPlay})`
  );
});

test('a shaft cut through the sand band fails', () => {
  const sim = build({ w: 90, h: 150, seed: 7, level: SANDY });
  const g = sim.geometry;
  /*
   * Squarely inside the sand, measured from where the lane actually is at the
   * depth of the band. This used to cut at centreX, which was reliably sand
   * back when the corridor was pinned to the right wall; the lane now moves
   * per level and weaves, so a fixed x — or even the lane's position at the
   * floor — is sometimes the safe route, and the test was quietly asserting
   * that the intended path fails.
   */
  const laneHere = g.laneX[g.sandTop + 2];
  const inSand =
    laneHere > sim.w / 2
      ? Math.round((g.wall + (laneHere - g.laneHalf)) / 2)
      : Math.round((laneHere + g.laneHalf + (sim.w - g.wall)) / 2);
  sim.digLine(inSand, g.sealTop - 1, inSand, g.floorY - 1, 3);

  const s = run(sim, 4000);
  assert.ok(s.balanced);
  assert.ok(
    s.collectionPct < 85,
    `cutting through sand should fail, but collected ${s.collectionPct.toFixed(1)}%`
  );
  /*
   * And it fails *because of the sand*, not incidentally. Three ways that
   * shows up and all of them count: the band drinks the payload, the band
   * diverts it to a drain, or — the one this assertion used to miss — the
   * band slumps in and seals the shaft before a single unit gets down it,
   * which is the most emphatic version of the same lesson.
   */
  let refilled = 0;
  for (let y = g.sandTop; y < g.sandBot; y++)
    for (let x = inSand - 3; x <= inSand + 3; x++) {
      const m = sim.get(x, y);
      if (m === MAT.SAND || m === MAT.WETSAND) refilled++;
    }
  assert.ok(
    s.heldBySand > 0 || s.lost > 0 || refilled > 0,
    'the sand should have taken the payload, diverted it, or buried the shaft'
  );
});

test('the sand band collapses into a shaft cut through it', () => {
  const sim = build({ w: 90, h: 150, seed: 7, level: SANDY });
  const g = sim.geometry;
  sim.digLine(g.centreX, g.sandTop - 4, g.centreX, g.sandBot + 4, 3);
  // Count after the cut: digging destroys grains, so the conservation claim
  // below is about what survived the shovel, not what the level started with.
  const sandBefore = count(sim, MAT.SAND);
  run(sim, 800);

  // Grains are conserved, but they should no longer be sitting in the band —
  // a good chunk has run down out of it.
  assert.strictEqual(
    count(sim, MAT.SAND) + count(sim, MAT.WETSAND),
    sandBefore,
    'grains are conserved even as the band drains'
  );
  let stillInBand = 0;
  for (let y = g.sandTop; y < g.sandBot; y++)
    for (let x = g.wall; x < g.sandRight; x++) {
      const m = sim.get(x, y);
      if (m === MAT.SAND || m === MAT.WETSAND) stillInBand++;
    }
  assert.ok(
    stillInBand < sandBefore,
    'sand should have drained out of the band into the shaft'
  );
});

test('runs are deterministic for a given seed', () => {
  const a = run(carveIdealChannel(build({ w: 60, h: 100, seed: 11 })), 500);
  const b = run(carveIdealChannel(build({ w: 60, h: 100, seed: 11 })), 500);
  assert.deepStrictEqual(a, b);
});

// ---------------------------------------------------------------------------
// Progression — later levels have to be different levels, and still solvable
// ---------------------------------------------------------------------------

const { difficultyFor } = require('../docs/play/sim.js');

test('materials are introduced one band at a time', () => {
  // Spec §5: clay 1–10, sand 11–20, fractured rock 21–30, everything after.
  assert.ok(!difficultyFor(1).sand, 'the first levels are clay only');
  assert.ok(!difficultyFor(10).sand);
  assert.ok(difficultyFor(11).sand, 'sand arrives at 11');
  assert.ok(!difficultyFor(20).fractured, 'and has the band to itself');
  assert.ok(difficultyFor(21).fractured, 'fractured rock arrives at 21');
  assert.ok(difficultyFor(40).sand && difficultyFor(40).fractured);
});

test('the level gets tighter as the number goes up, and never degenerate', () => {
  let prevCorridor = Infinity,
    prevApron = Infinity;
  for (const n of [1, 10, 20, 30, 45, 60, 100, 500]) {
    const D = difficultyFor(n);
    assert.ok(D.corridor <= prevCorridor + 1e-9, `corridor widened at ${n}`);
    assert.ok(D.apron <= prevApron + 1e-9, `apron widened at ${n}`);
    prevCorridor = D.corridor;
    prevApron = D.apron;
    // The far end has to stay playable: a lane you can cut and a target you
    // can hit. Difficulty that removes the solution is not difficulty.
    assert.ok(D.corridor > 0.1, `corridor collapsed to ${D.corridor} at ${n}`);
    assert.ok(D.basin > 0.3, `basin collapsed to ${D.basin} at ${n}`);
    assert.ok(D.apron > 0, `apron collapsed at ${n}`);
  }
});

const shape = (n) => {
  const g = build({ w: 90, h: 150, seed: n, level: n }).geometry;
  return [
    g.corridorL, g.corridorR, g.basinL, g.basinR, g.apron,
    g.sealTop, g.cavernTop, g.ribY, g.ribFrom, g.ribTo
  ].join(',');
};

test('levels are actually different from one another', () => {
  const seen = new Set([1, 15, 25, 35, 50, 80].map(shape));
  assert.ok(seen.size >= 5, `expected distinct layouts, got ${seen.size}`);
  // But the same level twice has to build the same, or nothing is learnable.
  assert.strictEqual(shape(37), shape(37));
});

test('the teaching levels are different levels, not one level ten times', () => {
  /*
   * The regression this exists for: a first pass tied every dial to the stage
   * bands from spec §5, so nothing moved at all inside band one and levels 1
   * to 10 built the identical cross-section. They are the only levels a new
   * player sees, and the unlock gate serves them one at a time.
   */
  const early = [];
  for (let n = 1; n <= 10; n++) early.push(shape(n));
  assert.strictEqual(
    new Set(early).size,
    10,
    'each of the first ten levels should have its own layout'
  );

  // Not just different numbers — the route has to actually move, or the
  // answer is "drag down the right-hand side" ten times running.
  const routes = [];
  for (let n = 1; n <= 10; n++)
    routes.push(build({ w: 90, h: 150, seed: n, level: n }).geometry.routeX);
  assert.ok(
    Math.max(...routes) - Math.min(...routes) > 90 * 0.25,
    `the route only moved between x=${Math.min(...routes)} and ` +
      `x=${Math.max(...routes)} across the first ten levels`
  );
});

test('every band still has a reference solution', () => {
  // One straight cut down the corridor into the basin has to clear the bar at
  // any level, or the curve has generated a level nobody can beat. Fractured
  // rock is left out for the reason at the top of this file.
  // The early band is swept level by level: those are the ones served one at
  // a time by the unlock gate, so an unsolvable one is a dead end, not a
  // level you can skip.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 24, 33, 48, 90]) {
    const sim = carveIdealChannel(build({ w: 90, h: 150, seed: n, level: n }));
    const s = run(sim, 20000);
    assert.ok(s.balanced, `accounting broke on level ${n}`);
    assert.ok(
      s.collectionPct >= 85,
      `level ${n} reference cut collected ${s.collectionPct.toFixed(1)}%`
    );
  }
});

test('missing the basin is punished harder as levels go up', () => {
  // The apron is the whole difficulty curve for aim: land beside the crystal
  // and early levels forgive it, late levels do not.
  const missBy = (n, cells) => {
    const sim = build({ w: 90, h: 150, seed: n, level: n, fractured: false });
    const g = sim.geometry;
    const x = g.routeX + cells;
    sim.digLine(x, g.sealTop - 1, x, g.floorY - 1, 3);
    return run(sim, 12000).collectionPct;
  };
  // Far enough off that level 1's generous apron is the only thing saving it.
  const early = missBy(1, 12);
  const late = missBy(60, 12);
  assert.ok(
    early > late,
    `a 12-cell miss scored ${early.toFixed(1)}% on level 1 and ` +
      `${late.toFixed(1)}% on level 60 — the later level should hurt more`
  );
});

// ---------------------------------------------------------------------------
// Pooling — a pool on a ledge has to actually leave it
// ---------------------------------------------------------------------------

// A slab of floor with one open edge, and a pool sitting on it well back from
// the drop. This is the shape the complaint was about: fluid that has stopped
// falling and now has to find its way off a flat surface.
function ledge({ poolW = 40, depth = 5, poolL = 8, ledgeR = 60 } = {}) {
  const sim = blank(90, 60);
  const floorY = 30;
  for (let x = 1; x <= ledgeR; x++) put(sim, x, floorY, MAT.BEDROCK);
  for (let y = floorY - depth; y < floorY; y++)
    for (let x = poolL; x < poolL + poolW; x++) put(sim, x, y, MAT.WATER);
  return { sim, floorY, total: poolW * depth };
}

function stillUp({ sim, floorY }) {
  let n = 0;
  for (let y = 0; y < floorY; y++)
    for (let x = 1; x < sim.w - 1; x++) if (sim.get(x, y) === MAT.WATER) n++;
  return n;
}

test('a pool finds the edge of its ledge rather than dribbling off it', () => {
  const L = ledge();
  let half = null,
    most = null;
  for (let i = 0; i < 4000 && most === null; i++) {
    L.sim.step();
    const left = stillUp(L);
    if (half === null && left <= L.total * 0.5) half = i;
    if (left <= L.total * 0.1) most = i;
  }
  /*
   * Budgets, not exact figures — the claim is about the order of magnitude a
   * player waits, not a golden number. Before through-fluid pressure and film
   * spreading these were 329 and 1203 steps, which at four steps a frame is
   * five seconds of watching a puddle think about it.
   */
  assert.ok(half !== null && half < 200, `half the pool took ${half} steps to leave`);
  assert.ok(most !== null && most < 800, `nine tenths took ${most} steps`);
});

test('fluid never crosses a wall to find a hole on the other side', () => {
  // The scans that made the above fast are allowed to pass through fluid, and
  // through nothing else. A pool walled off from a drop must stay put.
  const sim = blank(60, 40);
  const floorY = 25;
  for (let x = 1; x < 59; x++) put(sim, x, floorY, MAT.BEDROCK);
  for (let y = floorY - 8; y < floorY; y++) put(sim, 30, y, MAT.BEDROCK); // the wall
  for (let y = floorY - 4; y < floorY; y++)
    for (let x = 20; x < 30; x++) put(sim, x, y, MAT.WATER);
  // A hole in the floor on the far side of the wall.
  for (let x = 40; x < 46; x++) sim.set(x, floorY, MAT.EMPTY);

  run(sim, 600);
  for (let y = 0; y < 40; y++)
    for (let x = 31; x < 60; x++)
      assert.notStrictEqual(
        sim.get(x, y),
        MAT.WATER,
        `fluid reached x=${x}, y=${y} through a solid wall`
      );
});

// ---------------------------------------------------------------------------
// Gravel — the material you can build with
// ---------------------------------------------------------------------------

test('gravel settles into a heap and stays put once it has', () => {
  const sim = blank(48, 40);
  for (let x = 1; x < 47; x++) put(sim, x, 34, MAT.BEDROCK);
  for (let y = 6; y < 16; y++) for (let x = 19; x < 29; x++) put(sim, x, y, MAT.GRAVEL);
  const grains = count(sim, MAT.GRAVEL);

  run(sim, 1600);
  const settled = [];
  for (let x = 1; x < 47; x++) {
    let top = 34;
    for (let y = 0; y < 34; y++) if (sim.get(x, y) === MAT.GRAVEL) { top = y; break; }
    settled.push(top);
  }
  assert.strictEqual(count(sim, MAT.GRAVEL), grains, 'grains are conserved');
  assert.ok(settled.some((t) => t < 34), 'and end up somewhere, as a heap');

  // Once at rest it has to stay at rest, or a dam is not a dam.
  run(sim, 800);
  for (let x = 1; x < 47; x++) {
    let top = 34;
    for (let y = 0; y < 34; y++) if (sim.get(x, y) === MAT.GRAVEL) { top = y; break; }
    assert.strictEqual(top, settled[x - 1], `the heap shifted at x=${x}`);
  }
});

test('a gravel dam holds fluid back without taking a cut of it', () => {
  const sim = blank(50, 34);
  for (let x = 1; x < 49; x++) put(sim, x, 28, MAT.BEDROCK);
  for (let y = 22; y < 28; y++) for (let x = 24; x < 30; x++) put(sim, x, y, MAT.GRAVEL);
  for (let y = 20; y < 26; y++) for (let x = 6; x < 20; x++) put(sim, x, y, MAT.WATER);

  const before = count(sim, MAT.WATER);
  const s = run(sim, 1200);
  assert.ok(s.balanced);
  // Sand would have soaked some of this up and reported it as held. Gravel is
  // an obstruction and nothing else, which is the whole reason it exists.
  assert.strictEqual(s.heldBySand, 0, 'gravel must not absorb');
  assert.strictEqual(count(sim, MAT.WATER), before, 'and must not destroy any');
});

test('gravel can be dug, so a pocket can be dropped on purpose', () => {
  const sim = blank(30, 30);
  for (let y = 10; y < 16; y++) for (let x = 10; x < 16; x++) put(sim, x, y, MAT.GRAVEL);
  const r = sim.dig(13, 13, 3);
  assert.ok(r.removed > 0, 'the shovel has to bite');
  assert.strictEqual(sim.get(13, 13), MAT.EMPTY);
});

test('a spec builds a level directly, without going through a level number', () => {
  // The generator hands specs in; the game derives them from a number. Both
  // have to reach the same builder or a banked level means something
  // different from the level that was verified.
  const a = buildLevel({ w: 90, h: 150, seed: 4, spec: { level: 4, seed: 4 } });
  const b = buildLevel({ w: 90, h: 150, seed: 4, level: 4 });
  assert.deepStrictEqual(a.geometry.route, b.geometry.route);

  // And a spec may override any single dial without restating the rest.
  const crowned = buildLevel({ w: 90, h: 150, seed: 4, spec: { level: 4, seed: 4, floorSlope: 6 } });
  assert.strictEqual(crowned.geometry.floorSlope, 6);
  assert.strictEqual(a.geometry.floorSlope, 0);
});

test('a crowned floor actually falls away from the crystal', () => {
  const sim = buildLevel({ w: 120, h: 200, seed: 8, spec: { level: 8, seed: 8, floorSlope: 6 } });
  const g = sim.geometry;
  const depthAt = (x) => {
    for (let y = g.floorY - 8; y < sim.h - 2; y++)
      if (sim.get(x, y) !== MAT.EMPTY) return y;
    return sim.h;
  };
  const atBasin = depthAt(Math.round((g.basinL + g.basinR) / 2));
  const outside = depthAt(Math.max(g.wall + 1, g.basinL - g.apron - 2));
  assert.ok(
    outside > atBasin,
    `floor beside the basin (${outside}) should sit lower than at it (${atBasin})`
  );
});
