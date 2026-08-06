'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Sim, MAT, buildLevel, carveIdealChannel } = require('../src/sim.js');

/*
 * This suite covers the cellular layer on its own, so its levels are built
 * without the fractured slab. Fractured rock is inert to the grid — only the
 * rigid-body layer can detach it — so leaving it in would block the corridor
 * and make every level here unsolvable for reasons that have nothing to do
 * with the rules under test. bodies.test.js covers it with that layer active.
 */
const level = (opts) => buildLevel(Object.assign({ fractured: false }, opts));

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
  const sim = carveIdealChannel(level({ w: 90, h: 150, seed: 7 }));
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
  const sim = level({ w: 60, h: 100, seed: 3 });
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
  const sim = level({ w: 60, h: 100, seed: 5 });
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
  const sim = carveIdealChannel(level({ w: 90, h: 150, seed: 7 }));
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
  const sim = level({ w: 90, h: 150, seed: 7 });
  const g = sim.geometry;
  // Straight down the middle, through the sand rather than around it.
  sim.digLine(g.centreX, g.sealTop - 1, g.centreX, g.floorY - 1, 3);

  const s = run(sim, 4000);
  assert.ok(s.balanced);
  assert.ok(
    s.collectionPct < 85,
    `cutting through sand should fail, but collected ${s.collectionPct.toFixed(1)}%`
  );
  // The band slumps into the shaft and the payload never arrives intact.
  assert.ok(
    s.heldBySand > 0 || s.lost > 0,
    'the sand should have taken some of it, or the drains should have'
  );
});

test('the sand band collapses into a shaft cut through it', () => {
  const sim = level({ w: 90, h: 150, seed: 7 });
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
  const a = run(carveIdealChannel(level({ w: 60, h: 100, seed: 11 })), 500);
  const b = run(carveIdealChannel(level({ w: 60, h: 100, seed: 11 })), 500);
  assert.deepStrictEqual(a, b);
});
