'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Sim, MAT, buildLevel } = require('../docs/play/sim.js');
const { Bodies } = require('../docs/play/bodies.js');

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

// Score a rectangle of fractured rock as a single chunk, the way buildLevel
// does, so a unit test can detach a known piece.
function scoreChunk(sim, x0, y0, x1, y1) {
  const id = sim.chunks.length;
  sim.chunks.push({ x0, y0, x1, y1, detached: false });
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      sim.set(x, y, MAT.FRACTURED);
      sim.chunkId[y * sim.w + x] = id;
    }
  return id;
}

function count(sim, m) {
  let n = 0;
  for (let i = 0; i < sim.cells.length; i++) if (sim.cells[i] === m) n++;
  return n;
}

const gridY = (bod, c) => bod.toGridY(c.body.getPosition().y);

// ---------------------------------------------------------------------------
// Shattering
// ---------------------------------------------------------------------------

test('digging fractured rock detaches whole chunks, it does not erode them', () => {
  const sim = blank(40, 40);
  const id = scoreChunk(sim, 10, 10, 15, 15); // 6x6
  const before = count(sim, MAT.FRACTURED);
  assert.strictEqual(before, 36);

  // Clip one corner only.
  const r = sim.dig(10, 10, 1);
  assert.deepStrictEqual(r.shattered, [id]);
  // Nothing is removed until the bodies layer takes it.
  assert.strictEqual(count(sim, MAT.FRACTURED), before);

  const bod = new Bodies(sim);
  const made = bod.shatterAll(r.shattered);
  assert.strictEqual(made.length, 1);
  assert.strictEqual(count(sim, MAT.FRACTURED), 0, 'the whole chunk left the grid');
  assert.strictEqual(bod.count(), 1);
});

test('a chunk is only ever detached once', () => {
  const sim = blank(40, 40);
  const id = scoreChunk(sim, 10, 10, 14, 14);
  const bod = new Bodies(sim);
  assert.ok(bod.shatter(id));
  assert.strictEqual(bod.shatter(id), null, 'second detach is a no-op');
  assert.strictEqual(bod.count(), 1);
});

test('digging never shatters bedrock or clay into bodies', () => {
  const sim = blank(40, 40);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) sim.set(x, y, MAT.CLAY);
  const r = sim.dig(15, 15, 5);
  assert.deepStrictEqual(r.shattered, []);
  assert.ok(r.removed > 0, 'clay is still removed normally');
});

// ---------------------------------------------------------------------------
// Bodies -> grid (the collision-mask half of the interaction layer)
// ---------------------------------------------------------------------------

test('a chunk masks the grid cells it covers', () => {
  const sim = blank(40, 60);
  const id = scoreChunk(sim, 18, 20, 22, 24);
  const bod = new Bodies(sim);
  bod.shatter(id);
  bod.stampMask();

  const masked = sim.mask.reduce((a, b) => a + b, 0);
  assert.ok(masked >= 20, `expected the chunk footprint to be masked, got ${masked}`);

  // The cells are empty in storage but solid to the cellular rules.
  assert.strictEqual(sim.raw(20, 22), MAT.EMPTY);
  assert.strictEqual(sim.get(20, 22), MAT.BEDROCK);
});

test('a chunk lodged above a narrow passage blocks it', () => {
  // Spec §2.3: chunks can block narrow passages. A piece too wide to fit
  // through the neck wedges on the shoulders and shuts the route.
  function drain(withChunk) {
    const sim = blank(11, 60);
    const bod = new Bodies(sim);
    // Shoulders narrowing the shaft to a three-cell neck.
    for (let y = 30; y < 32; y++) {
      for (let x = 1; x < 4; x++) sim.set(x, y, MAT.BEDROCK);
      for (let x = 7; x < 10; x++) sim.set(x, y, MAT.BEDROCK);
    }
    if (withChunk) bod.shatter(scoreChunk(sim, 2, 24, 8, 28));
    for (let y = 6; y < 12; y++)
      for (let x = 1; x < 10; x++) {
        sim.set(x, y, MAT.WATER);
        sim.released++;
      }
    for (let i = 0; i < 900; i++) {
      bod.step(1 / 60);
      sim.step();
    }
    assert.ok(sim.stats().balanced, 'conservation holds with bodies present');
    let below = 0;
    for (let y = 33; y < 59; y++)
      for (let x = 0; x < 11; x++) if (sim.raw(x, y) === MAT.WATER) below++;
    return below;
  }

  const open = drain(false);
  const plugged = drain(true);
  assert.ok(open > 0, 'the neck drains when nothing is wedged in it');
  assert.ok(
    plugged < open * 0.25,
    `the chunk should shut the passage: ${plugged} through vs ${open} open`
  );
});

test('fluid never occupies a cell a chunk is sitting in', () => {
  const sim = blank(11, 60);
  const bod = new Bodies(sim);
  bod.shatter(scoreChunk(sim, 2, 30, 8, 34));
  for (let y = 6; y < 12; y++)
    for (let x = 1; x < 10; x++) {
      sim.set(x, y, MAT.WATER);
      sim.released++;
    }

  for (let i = 0; i < 600; i++) {
    bod.step(1 / 60);
    sim.step();
  }

  // The mask must be opaque to the flow rules: whatever a chunk covers reads
  // as solid, so no rule can route fluid into it.
  const solidUnderMask = [];
  for (let y = 0; y < sim.h; y++)
    for (let x = 0; x < sim.w; x++)
      if (sim.mask[y * sim.w + x] && sim.get(x, y) !== MAT.BEDROCK)
        solidUnderMask.push([x, y]);
  assert.strictEqual(
    solidUnderMask.length,
    0,
    'every masked cell must read as solid to the cellular rules'
  );
  assert.ok(sim.stats().balanced);
});

// ---------------------------------------------------------------------------
// Physics — delegated to Box2D, verified at the seams
// ---------------------------------------------------------------------------

test('a detached chunk falls and comes to rest on the terrain', () => {
  const sim = blank(40, 80);
  for (let x = 1; x < 39; x++) for (let y = 60; y < 79; y++) sim.set(x, y, MAT.CLAY);
  const id = scoreChunk(sim, 18, 10, 22, 14);
  const bod = new Bodies(sim);
  const c = bod.shatter(id);

  const startY = gridY(bod, c);
  for (let i = 0; i < 240; i++) bod.step(1 / 60);
  const endY = gridY(bod, c);

  assert.ok(endY > startY + 20, `chunk should have fallen, ${startY} -> ${endY}`);
  assert.ok(endY < 62, `chunk should rest on the clay, not sink into it (${endY})`);

  // And it should be asleep or near-still once settled.
  const v = c.body.getLinearVelocity();
  assert.ok(Math.abs(v.y) < 0.5, `chunk should have settled, vy=${v.y}`);
});

test('chunks stack rather than overlapping', () => {
  const sim = blank(40, 80);
  for (let x = 1; x < 39; x++) for (let y = 60; y < 79; y++) sim.set(x, y, MAT.CLAY);
  const a = scoreChunk(sim, 18, 10, 22, 14);
  const b = scoreChunk(sim, 18, 20, 22, 24);
  const bod = new Bodies(sim);
  const ca = bod.shatter(a);
  const cb = bod.shatter(b);

  for (let i = 0; i < 400; i++) bod.step(1 / 60);

  const ya = gridY(bod, ca), yb = gridY(bod, cb);
  assert.ok(
    Math.abs(ya - yb) > 3,
    `two 5-cell chunks should not occupy the same place (${ya} vs ${yb})`
  );
});

// ---------------------------------------------------------------------------
// Grid -> bodies (the buoyancy/pressure half of the interaction layer)
// ---------------------------------------------------------------------------

test('fluid slows a chunk falling through it', () => {
  function drop(flooded) {
    const sim = blank(30, 80);
    for (let x = 1; x < 29; x++) for (let y = 70; y < 79; y++) sim.set(x, y, MAT.CLAY);
    if (flooded)
      for (let y = 20; y < 70; y++)
        for (let x = 1; x < 29; x++) {
          sim.set(x, y, MAT.WATER);
          sim.released++;
        }
    const id = scoreChunk(sim, 13, 8, 17, 12);
    const bod = new Bodies(sim);
    const c = bod.shatter(id);
    const y0 = gridY(bod, c);
    // Physics only — a static column of fluid, so the comparison isolates
    // buoyancy and drag rather than mixing in the fluid draining away.
    for (let i = 0; i < 90; i++) bod.step(1 / 60);
    return gridY(bod, c) - y0;
  }

  const inAir = drop(false);
  const inFluid = drop(true);
  assert.ok(inAir > 0 && inFluid > 0, 'the chunk falls either way — rock sinks');
  assert.ok(
    inFluid < inAir * 0.9,
    `fluid should retard the fall: ${inFluid.toFixed(1)} vs ${inAir.toFixed(1)} cells`
  );
});

// ---------------------------------------------------------------------------
// Integration with the level
// ---------------------------------------------------------------------------

test('the level scores a fractured band into chunks', () => {
  const sim = buildLevel({ w: 90, h: 150, seed: 7 });
  assert.ok(sim.chunks.length > 10, `expected a scored band, got ${sim.chunks.length}`);
  const g = sim.geometry;
  assert.strictEqual(sim.raw(g.routeX, (g.fracTop + g.fracBot) >> 1), MAT.FRACTURED);
});

test('cutting the corridor shatters rock into the shaft', () => {
  const sim = buildLevel({ w: 90, h: 150, seed: 7 });
  const g = sim.geometry;
  const bod = new Bodies(sim);

  const r = sim.digLine(g.routeX, g.sealTop - 1, g.routeX, g.floorY - 1, 3);
  assert.ok(r.shattered.length > 0, 'the corridor route runs through the slab');
  const made = bod.shatterAll(r.shattered);
  assert.ok(made.length > 0);

  for (let i = 0; i < 600; i++) {
    bod.step(1 / 60);
    sim.step();
  }
  assert.ok(sim.stats().balanced, 'conservation survives the rigid-body layer');
  assert.strictEqual(bod.count(), made.length, 'no chunk is lost or duplicated');
});

test('the corridor route still clears 85% with rock tumbling into the shaft', () => {
  const sim = buildLevel({ w: 90, h: 150, seed: 7 });
  const g = sim.geometry;
  const bod = new Bodies(sim);

  const r = sim.digLine(g.routeX, g.sealTop - 1, g.routeX, g.floorY - 1, 3);
  bod.shatterAll(r.shattered);
  assert.ok(bod.count() > 0, 'the slab is on the route and must break');

  for (let i = 0; i < 20000; i++) {
    bod.step(1 / 60);
    sim.step();
  }

  const s = sim.stats();
  assert.ok(s.balanced, 'conservation holds across a full run with bodies');
  assert.ok(
    s.collectionPct >= 85,
    `loose rock should throttle the flow, not defeat it — collected ` +
      `${s.collectionPct.toFixed(1)}% (held ${s.heldBySand}, lost ${s.lost}, ` +
      `in play ${s.inPlay}, chunks ${bod.count()})`
  );
});

test('a level with no fractured rock creates no bodies', () => {
  const sim = buildLevel({ w: 90, h: 150, seed: 7, fractured: false });
  assert.strictEqual(sim.chunks.length, 0);
  const bod = new Bodies(sim);
  const g = sim.geometry;
  const r = sim.digLine(g.routeX, g.sealTop - 1, g.routeX, g.floorY - 1, 3);
  assert.deepStrictEqual(r.shattered, []);
  bod.step(1 / 60);
  assert.strictEqual(bod.count(), 0);
});
