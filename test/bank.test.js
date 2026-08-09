'use strict';

/*
 * The level bank, and the one property that matters about it: a banked level
 * has to be the level that was measured.
 *
 * Everything the generator does is worthless if the spec it judged and the spec
 * the game builds differ in any way at all — the bank would then be a record of
 * levels nobody has ever played, carrying quality figures for terrain that does
 * not exist. So these tests are about the round trip, not about the levels.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildLevel, difficultyFor } = require('../docs/play/sim.js');
const { plainSpec, format, DIALS } = require('../tools/bank.js');

const cellsOf = (sim) => Buffer.from(sim.cells).toString('base64');

test('a spec restating the curve builds the curve\'s level, cell for cell', () => {
  /*
   * The bank writes every dial rather than only the ones the generator varied,
   * so a banked level cannot change meaning when difficultyFor() is edited.
   * That only holds if a full restatement is equivalent to the curve itself,
   * which is what this pins — including the pick stream, which is rebuilt from
   * the seed on the spec path and taken from the level number on the curve
   * path. Those two agree only because the seed equals the level here.
   */
  for (const n of [3, 12, 25]) {
    const derived = buildLevel({ w: 120, h: 200, seed: n, level: n });
    const spec = plainSpec(Object.assign(difficultyFor(n), { level: n, seed: n }));
    assert.ok(spec.pick === undefined, 'a banked spec must not carry a function');
    const banked = buildLevel({ w: 120, h: 200, seed: n, spec });
    assert.deepStrictEqual(banked.geometry.route, derived.geometry.route);
    assert.strictEqual(cellsOf(banked), cellsOf(derived), `level ${n} differs`);
  }
});

test('the seed moves the level, not only the speckle', () => {
  /*
   * The pick stream places the rib, the pockets, the gravel and the offsets of
   * every shelf within its slice. It used to be rebuilt from the seed only when
   * the merged spec had no pick at all — which never happened, because the curve
   * copied in above always brings one — so a spec asking for a different seed
   * got the same placements as the level of that number, and the seed reached
   * nothing but the cosmetic noise. That is most of the variety the generator
   * has to work with, and it was silently unavailable.
   */
  const shapes = new Set(
    [1, 2, 3, 4, 5, 6].map((seed) =>
      JSON.stringify(
        buildLevel({ w: 120, h: 200, seed, spec: { level: 12, seed, gravel: 2 } }).geometry.gravelAt
      )
    )
  );
  assert.ok(
    shapes.size > 1,
    'six seeds produced the same pocket placement; the seed is not reaching the picks'
  );
});

test('the written bank builds the same levels it was written from', () => {
  const levels = {};
  for (const n of [5, 18]) {
    const s = plainSpec(Object.assign(difficultyFor(n), { level: n, seed: 1000 + n }));
    s.report = { best: 98, plan: 'route', naiveBest: 3, bands: [4, 2, 1, 4], maxDug: 900 };
    levels[n] = s;
  }
  const bank = { version: 1, seed: 7, from: 5, to: 18, grid: { w: 120, h: 200 }, levels };

  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'subsurface-bank-')),
    'levels.js'
  );
  fs.writeFileSync(file, format(bank));
  const reloaded = require(file);

  assert.strictEqual(reloaded.grid.w, 120);
  for (const n of [5, 18]) {
    const before = buildLevel({ w: 120, h: 200, seed: levels[n].seed, spec: levels[n] });
    const spec = reloaded.levels[n];
    const after = buildLevel({ w: 120, h: 200, seed: spec.seed, spec });
    assert.strictEqual(cellsOf(after), cellsOf(before), `level ${n} did not survive the round trip`);
  }

  // Rounding for readability must not quietly drop a dial.
  for (const k of DIALS)
    if (levels[5][k] !== undefined)
      assert.ok(reloaded.levels[5][k] !== undefined, `dial ${k} was lost on the way out`);
});

test('the shipped bank is loadable and internally consistent', () => {
  const p = path.join(__dirname, '..', 'docs', 'play', 'levels.js');
  if (!fs.existsSync(p)) return; // a missing bank is a smaller game, not a broken one
  const bank = require(p);
  assert.ok(bank.levels && Object.keys(bank.levels).length, 'bank has no levels');
  for (const key of Object.keys(bank.levels)) {
    const spec = bank.levels[key];
    assert.strictEqual(spec.level, Number(key), `entry ${key} claims to be level ${spec.level}`);
    assert.ok(spec.seed > 0, `level ${key} has no seed`);
    const sim = buildLevel({ w: bank.grid.w, h: bank.grid.h, seed: spec.seed, spec });
    const g = sim.geometry;
    assert.ok(sim.released > 0, `level ${key} releases no fluid`);
    assert.ok(g.basinR > g.basinL, `level ${key} has no basin`);
    assert.ok(g.drains.length > 0, `level ${key} has no drains`);
    // Par has to fit the solution the generator measured, or the level is
    // banked as unwinnable by its own answer.
    if (spec.digBudget)
      assert.ok(
        spec.digBudget >= spec.report.maxDug,
        `level ${key}: budget ${spec.digBudget} is under the ${spec.report.maxDug} its own ` +
          'passing plans cost'
      );
  }
});
