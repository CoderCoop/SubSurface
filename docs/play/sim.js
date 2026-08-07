/*
 * Subsurface — cellular-automata simulation core.
 *
 * Implements the primary system from docs/design-spec.md §4.1: a dense 2D grid
 * where each cell is a material particle. Deliberately DOM-free so it can be
 * driven headlessly from Node tests as well as from the browser harness.
 *
 * NOT implemented here, by design: the rigid-body layer for fractured rock
 * (spec §4.1 secondary system), chunk sleeping, multithreading/compute
 * shaders, multi-fluid and heat hazards.
 *
 * ---------------------------------------------------------------------------
 * Volume accounting
 *
 * Fluid is strictly conserved. Every unit released at level build time is, at
 * every instant, in exactly one of four places:
 *
 *     released = inPlay + collected + lost + heldBySand
 *
 * Sand absorbs fluid into wet sand, which HOLDS that unit rather than
 * destroying it — one wet-sand cell holds exactly one unit — and gives it back
 * when enough pressure builds against it. So a saturated band is a delay and a
 * reservoir, not a leak: soak it on the way down, then build head to squeeze
 * the fluid back out. Only the collector and the drains remove fluid from
 * play, and both are counted.
 *
 * The invariant above is asserted by the test suite after every step.
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Subsurface = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EMPTY = 0,
    BEDROCK = 1,
    CLAY = 2,
    SAND = 3,
    WETSAND = 4,
    WATER = 5,
    COLLECTOR = 6,
    DRAIN = 7,
    FRACTURED = 8;

  var MAT = {
    EMPTY: EMPTY,
    BEDROCK: BEDROCK,
    CLAY: CLAY,
    SAND: SAND,
    WETSAND: WETSAND,
    WATER: WATER,
    COLLECTOR: COLLECTOR,
    DRAIN: DRAIN,
    FRACTURED: FRACTURED
  };

  var NAMES = {};
  NAMES[EMPTY] = 'empty';
  NAMES[BEDROCK] = 'bedrock';
  NAMES[CLAY] = 'clay';
  NAMES[SAND] = 'sand';
  NAMES[WETSAND] = 'wet sand';
  NAMES[WATER] = 'fluid';
  NAMES[COLLECTOR] = 'collector';
  NAMES[DRAIN] = 'drain';
  NAMES[FRACTURED] = 'fractured rock';

  // Earthy, muted terrain against a vibrant teal payload (spec §3.1).
  var COLORS = {};
  COLORS[EMPTY] = [26, 22, 20];
  COLORS[BEDROCK] = [58, 58, 66];
  COLORS[CLAY] = [140, 74, 50];
  COLORS[SAND] = [201, 162, 107];
  COLORS[WETSAND] = [124, 94, 60];
  COLORS[WATER] = [47, 212, 196];
  COLORS[COLLECTOR] = [246, 232, 160];
  COLORS[DRAIN] = [12, 10, 8];
  COLORS[FRACTURED] = [90, 107, 120];

  // Deterministic PRNG: same seed means the same run, which is what makes the
  // integration tests meaningful and lets a level be replayed exactly.
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function Sim(w, h, seed) {
    this.w = w;
    this.h = h;
    this.cells = new Uint8Array(w * h);
    this.moved = new Uint8Array(w * h);
    this.head = new Uint16Array(w * h); // contiguous fluid depth, drives pressure
    this.tint = new Int8Array(w * h); // per-cell colour jitter, cosmetic only

    /*
     * Rigid-body coupling (spec §4.1, interaction layer). The bodies layer
     * stamps occupied cells into `mask` each frame, and `get` reports those
     * cells as bedrock — so every cellular rule treats a rock chunk as solid
     * without knowing rigid bodies exist. This is the "rigid bodies act as
     * collision masks masking out grid cells" half of the contract; the
     * buoyancy half lives in bodies.js.
     */
    this.mask = new Uint8Array(w * h);

    // Fractured rock is pre-scored into chunks: -1 for everything else, else
    // the id of the chunk a cell belongs to. Cutting any part of a chunk
    // detaches the whole thing, which is what makes it shatter into pieces
    // rather than crumble cell by cell.
    this.chunkId = new Int16Array(w * h).fill(-1);
    this.chunks = [];
    this.chunkIndex = {}; // scoring grid key -> chunk id, build time only
    this.rand = mulberry32(seed === undefined ? 1 : seed);
    this.frame = 0;

    this.released = 0;
    this.collected = 0;
    this.lost = 0;

    // Tunables.
    this.seep = 0.06; // chance fluid soaks into an adjacent dry sand cell
    // Baseline lateral flow chance at zero pressure. Low enough that the
    // fluid reads as viscous and pools with a visible slope while draining;
    // high enough that a wide reservoir empties in well under a minute.
    this.viscosity = 0.3;
    this.pressureGain = 0.045; // how fast head raises that chance
    // How far along a surface a resting cell will look for somewhere to fall.
    this.flowReach = 6;
    this.flowReachMax = 16;
    this.releaseHead = 5; // head needed to squeeze fluid back out of wet sand
    this.releaseChance = 0.35; // per-frame chance a pressured cell lets go

    this.waterSurface = 0;
    this.geometry = null;
  }

  Sim.prototype.idx = function (x, y) {
    return y * this.w + x;
  };

  // Out of bounds reads as bedrock: a level is sealed unless a drain says
  // otherwise, so fluid can never quietly fall off the edge of the grid
  // without being counted.
  Sim.prototype.get = function (x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return BEDROCK;
    var i = y * this.w + x;
    // A cell occupied by a rigid body is solid to everything cellular.
    if (this.mask[i]) return BEDROCK;
    return this.cells[i];
  };

  // The material actually stored in a cell, ignoring any body sitting on it.
  // Digging and bookkeeping use this; the cellular rules use `get`.
  Sim.prototype.raw = function (x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return BEDROCK;
    return this.cells[y * this.w + x];
  };

  Sim.prototype.set = function (x, y, m) {
    this.cells[y * this.w + x] = m;
  };

  Sim.prototype.swap = function (sx, sy, tx, ty) {
    var a = this.idx(sx, sy),
      b = this.idx(tx, ty);
    var m = this.cells[a];
    this.cells[a] = this.cells[b];
    this.cells[b] = m;
    var t = this.tint[a];
    this.tint[a] = this.tint[b];
    this.tint[b] = t;
    this.moved[b] = 1;
  };

  /*
   * Pressure (spec §2.2). A cheap stand-in for a real pressure solve: one
   * top-down pass records how deep each fluid cell sits within a contiguous
   * column, and that depth raises the cell's lateral flow probability and
   * drives release from saturated sand. The emergent behaviour is the one the
   * spec asks for — deep columns push fluid hard through narrow gaps at the
   * bottom, and shallow puddles sit still.
   */
  Sim.prototype.computeHead = function () {
    var w = this.w,
      h = this.h;
    for (var x = 0; x < w; x++) {
      var run = 0;
      for (var y = 0; y < h; y++) {
        var i = y * w + x;
        var m = this.cells[i];
        if (m === WATER) {
          run++;
          this.head[i] = run;
        } else if (m === WETSAND) {
          // Saturated sand CONDUCTS pressure without adding to it. Without
          // this a plug is opaque: only its topmost layer ever feels the
          // column above, and the saturation front can never advance.
          this.head[i] = run;
        } else {
          run = 0;
          this.head[i] = 0;
        }
      }
    }
  };

  // Move one fluid cell into a target, resolving the absorbing materials.
  // Returns true if the fluid cell left its origin.
  Sim.prototype.flow = function (sx, sy, tx, ty) {
    var t = this.get(tx, ty);
    if (t === EMPTY) {
      this.swap(sx, sy, tx, ty);
      return true;
    }
    if (t === COLLECTOR) {
      this.set(sx, sy, EMPTY);
      this.collected++;
      return true;
    }
    if (t === DRAIN) {
      this.set(sx, sy, EMPTY);
      this.lost++;
      return true;
    }
    return false;
  };

  // Absorb this fluid cell into an adjacent dry sand cell, which becomes wet
  // sand holding the unit. Conserved: inPlay drops, heldBySand rises.
  Sim.prototype.absorbInto = function (sx, sy, tx, ty) {
    this.set(tx, ty, WETSAND);
    this.set(sx, sy, EMPTY);
    this.moved[this.idx(tx, ty)] = 1;
  };

  Sim.prototype.updateWater = function (x, y) {
    if (this.flow(x, y, x, y + 1)) return;

    var d = this.rand() < 0.5 ? 1 : -1;
    if (this.flow(x, y, x + d, y + 1)) return;
    if (this.flow(x, y, x - d, y + 1)) return;

    // Permeability (spec §2.3). Downward seepage dominates; sideways is
    // slower, so a channel wets a halo rather than draining into the band.
    if (this.get(x, y + 1) === SAND && this.rand() < this.seep) {
      this.absorbInto(x, y, x, y + 1);
      return;
    }
    if (this.get(x + d, y) === SAND && this.rand() < this.seep * 0.35) {
      this.absorbInto(x, y, x + d, y);
      return;
    }

    var p = this.viscosity + this.head[this.idx(x, y)] * this.pressureGain;
    if (p > 0.92) p = 0.92;
    if (this.rand() >= p) return;

    /*
     * Finding the edge.
     *
     * Moving one cell sideways per step makes spreading a random walk, so the
     * time for a pool to reach an edge grows with the SQUARE of the distance:
     * a puddle sitting on a wide ledge takes an age to find the drop two
     * hand-widths away, which is not how water behaves and not how it reads.
     *
     * Real fluid on a flat surface is driven by the pressure gradient, and the
     * gradient points at the hole. So a cell that cannot fall looks along the
     * surface for the nearest place it COULD fall and goes there directly.
     * Spreading stays viscous — the probability above still gates every move —
     * but a pool now drains at the edge rather than diffusing toward it.
     *
     * Reach grows with the column above, which is the pressure driving it.
     */
    var reach = this.flowReach + (this.head[this.idx(x, y)] >> 1);
    if (reach > this.flowReachMax) reach = this.flowReachMax;

    var nx = this.scanSide(x, y, d, reach);
    if (nx === -1) nx = this.scanSide(x, y, -d, reach);
    if (nx !== -1) this.flow(x, y, nx, y);
  };

  /*
   * Look along the surface in direction d and return the best cell to move to,
   * or -1 if there is none. Two outcomes matter, in order of preference:
   *
   *   a drop-off  somewhere the cell could fall from — the pressure gradient
   *               points at the hole, so go straight to it
   *   a slide     otherwise the furthest clear cell within reach
   *
   * The slide is what makes spreading travel at a speed instead of diffusing.
   * Without it a cell only ever steps one column per turn, so the time for a
   * pool to cross a ledge grows with the square of its width and a puddle
   * hunts for an edge it should have found at once.
   *
   * The scan stops at the first obstruction either way, so fluid never tunnels
   * through a wall to reach open space beyond it.
   */
  Sim.prototype.scanSide = function (x, y, d, reach) {
    var furthest = -1;
    for (var k = 1; k <= reach; k++) {
      var nx = x + d * k;
      var at = this.get(nx, y);
      if (at === COLLECTOR || at === DRAIN) return nx; // arriving is falling
      if (at !== EMPTY) break;
      var below = this.get(nx, y + 1);
      if (below === EMPTY || below === COLLECTOR || below === DRAIN) return nx;
      furthest = nx;
    }
    return furthest;
  };

  /*
   * Release from saturated sand — the other half of the absorption rule.
   *
   * A wet-sand cell under enough pressure gives its held unit back as a fluid
   * cell and reverts to dry sand, ready to absorb again. Repeated across a
   * band this is percolation: fluid works its way through saturated sand
   * rather than being consumed by it, but only while the head above is
   * maintained. Let the pressure fall and the band keeps what it holds.
   *
   * Outflow prefers downward, then sideways. Never upward — fluid does not
   * climb back out of the sand it soaked into.
   */
  Sim.prototype.tryRelease = function (x, y) {
    // Pressure conducted down the saturated column to this cell.
    if (this.head[this.idx(x, y)] < this.releaseHead) return false;
    if (this.rand() > this.releaseChance) return false;

    var d = this.rand() < 0.5 ? 1 : -1;
    var outs = [
      [x, y + 1],
      [x + d, y + 1],
      [x - d, y + 1],
      [x + d, y],
      [x - d, y]
    ];

    // First choice: give the unit back as free fluid, or straight into a
    // collector or drain if one is adjacent.
    for (var k = 0; k < outs.length; k++) {
      var ox = outs[k][0],
        oy = outs[k][1];
      var t = this.get(ox, oy);
      if (t === EMPTY) {
        this.set(ox, oy, WATER);
        this.set(x, y, SAND);
        this.moved[this.idx(ox, oy)] = 1;
        return true;
      }
      if (t === COLLECTOR) {
        this.set(x, y, SAND);
        this.collected++;
        return true;
      }
      if (t === DRAIN) {
        this.set(x, y, SAND);
        this.lost++;
        return true;
      }
    }

    // Otherwise pass the unit to a dry grain below and dry out. Deep inside a
    // packed band there is nowhere for free fluid to go, so this is how the
    // saturation front creeps downward until it reaches an opening.
    if (this.get(x, y + 1) === SAND) {
      this.set(x, y + 1, WETSAND);
      this.set(x, y, SAND);
      this.moved[this.idx(x, y + 1)] = 1;
      return true;
    }
    return false;
  };

  Sim.prototype.updateSand = function (x, y, mat) {
    var below = this.get(x, y + 1);
    if (below === EMPTY || below === WATER) {
      this.swap(x, y, x, y + 1); // grains sink through fluid
      return;
    }

    // Angle of repose: a grain only slides diagonally when it loses its
    // cohesion roll. Wet sand sticks together far more (spec §2.3), so a
    // soaked band slumps into a steeper, more stable pile than a dry one.
    var stick = mat === WETSAND ? 0.78 : 0.28;
    if (this.rand() < stick) return;

    var d = this.rand() < 0.5 ? 1 : -1;
    for (var k = 0; k < 2; k++) {
      var dx = k === 0 ? d : -d;
      var diag = this.get(x + dx, y + 1);
      var side = this.get(x + dx, y);
      // The side check stops a grain squeezing diagonally through a wall.
      if (
        (diag === EMPTY || diag === WATER) &&
        (side === EMPTY || side === WATER)
      ) {
        this.swap(x, y, x + dx, y + 1);
        return;
      }
    }
  };

  Sim.prototype.step = function () {
    this.frame++;
    this.moved.fill(0);
    this.computeHead();

    var w = this.w,
      leftFirst = this.frame % 2 === 0;

    // Bottom-up, so a cell that falls is not re-processed the same frame.
    // The horizontal scan direction alternates to cancel out drift bias.
    for (var y = this.h - 1; y >= 0; y--) {
      for (var n = 0; n < w; n++) {
        var x = leftFirst ? n : w - 1 - n;
        var i = y * w + x;
        if (this.moved[i]) continue;
        var m = this.cells[i];
        if (m === WATER) this.updateWater(x, y);
        else if (m === WETSAND) {
          if (!this.tryRelease(x, y)) this.updateSand(x, y, WETSAND);
        } else if (m === SAND) this.updateSand(x, y, SAND);
      }
    }
  };

  /*
   * Digging (spec §2.1). Destructive and irreversible: it clears soft material
   * only, never bedrock, and nothing in the simulation ever puts material back.
   * Wet sand that is dug out releases its held unit as fluid so the volume
   * accounting stays true — carving out a saturated band gives you back what
   * it was holding.
   */
  Sim.prototype.dig = function (cx, cy, r) {
    cx = Math.round(cx);
    cy = Math.round(cy);
    var r2 = r * r,
      removed = 0,
      grit = 0,
      freed = 0,
      shattered = [];
    var y0 = Math.max(0, cy - r),
      y1 = Math.min(this.h - 1, cy + r);
    var x0 = Math.max(0, cx - r),
      x1 = Math.min(this.w - 1, cx + r);
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x - cx,
          dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        var i = y * this.w + x;
        var m = this.cells[i];
        if (m === CLAY || m === SAND) {
          this.cells[i] = EMPTY;
          removed++;
          if (m === SAND) grit++;
        } else if (m === WETSAND) {
          // Hand the held unit back rather than destroying it.
          this.cells[i] = WATER;
          removed++;
          grit++;
          freed++;
        } else if (m === FRACTURED) {
          // Do not erode it — record the chunk so the bodies layer can
          // detach the whole piece. The cells stay put until it does.
          var id = this.chunkId[i];
          if (id >= 0 && shattered.indexOf(id) === -1) shattered.push(id);
        }
      }
    }
    // grit drives the gravel-crunch layer of the audio mix (spec §3.2).
    return {
      removed: removed,
      grit: grit,
      freed: freed,
      shattered: shattered
    };
  };

  // Swipes arrive as sampled points; interpolate so a fast drag leaves a
  // continuous tunnel rather than a dotted line of craters.
  Sim.prototype.digLine = function (x0, y0, x1, y1, r) {
    var dx = x1 - x0,
      dy = y1 - y0;
    var steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy)));
    var total = { removed: 0, grit: 0, freed: 0, shattered: [] };
    for (var s = 0; s <= steps; s++) {
      var t = s / steps;
      var one = this.dig(x0 + dx * t, y0 + dy * t, r);
      total.removed += one.removed;
      total.grit += one.grit;
      total.freed += one.freed;
      for (var k = 0; k < one.shattered.length; k++)
        if (total.shattered.indexOf(one.shattered[k]) === -1)
          total.shattered.push(one.shattered[k]);
    }
    return total;
  };

  // Lift a scored chunk out of the grid, returning the cells it occupied so
  // the bodies layer can build a rigid body from them.
  Sim.prototype.detachChunk = function (id) {
    var c = this.chunks[id];
    if (!c || c.detached) return null;
    c.detached = true;
    var cells = [];
    for (var y = c.y0; y <= c.y1; y++)
      for (var x = c.x0; x <= c.x1; x++) {
        var i = y * this.w + x;
        if (this.chunkId[i] === id && this.cells[i] === FRACTURED) {
          this.cells[i] = EMPTY;
          cells.push([x, y]);
        }
      }
    return cells.length ? { id: id, cells: cells, box: c } : null;
  };

  Sim.prototype.stats = function () {
    var inPlay = 0,
      held = 0,
      deepest = -1,
      maxHead = 0;
    for (var y = 0; y < this.h; y++) {
      for (var x = 0; x < this.w; x++) {
        var i = y * this.w + x;
        var m = this.cells[i];
        if (m === WATER) {
          inPlay++;
          deepest = y;
          if (this.head[i] > maxHead) maxHead = this.head[i];
        } else if (m === WETSAND) held++;
      }
    }
    return {
      released: this.released,
      collected: this.collected,
      lost: this.lost,
      inPlay: inPlay,
      heldBySand: held,
      // Depth reads from the fluid surface, the way an instrument on the rig
      // would report it, rather than from the top of the grid.
      depth: deepest < 0 ? 0 : Math.max(0, deepest - this.waterSurface),
      pressure: maxHead,
      collectionPct: this.released ? (this.collected / this.released) * 100 : 0,
      balanced:
        inPlay + this.collected + this.lost + held === this.released
    };
  };

  // Nothing left that could still reach the collector.
  Sim.prototype.isSettled = function (s) {
    s = s || this.stats();
    return s.inPlay === 0 && s.heldBySand === 0;
  };

  /*
   * Level geometry. Bands are fractions of the grid, so the same layout builds
   * at any resolution. This stands in for the PNG loader described in spec
   * §4.3, which is not written yet — the band list is the same authored data,
   * expressed in code instead of pixels.
   */
  /*
   * Difficulty.
   *
   * Every level used to be the same cross-section with different noise, so
   * level 40 played exactly like level 1. This turns the level number into a
   * curve following the stage bands in spec §5: clay, then sand, then fractured
   * rock, then all of it together.
   *
   * Two axes, and they are not the same axis:
   *
   *   harder     materials arrive one band at a time (spec §5) so each is
   *              learned alone; the corridor narrows; the apron of safe
   *              bedrock around the collector shrinks
   *   different  where the corridor is, how deep the seal and the cavern sit,
   *              which side the rib is on, where the pockets are
   *
   * Keeping those apart matters. A first pass tied every dial to the stage
   * bands, which meant nothing at all moved inside band one — levels 1 to 10
   * built the identical cross-section and differed only in tint noise. Being
   * early in the game is a reason to be easy, never a reason to be the same
   * level again. So the "different" dials run from level 2, driven by a hash
   * of the level number, and only the "harder" dials follow the bands.
   *
   * Everything is a fraction and clamped, so the far end of the curve is hard
   * but still has a corridor wide enough to cut and a basin wide enough to
   * hit. A level that cannot be solved is not difficulty.
   */
  function difficultyFor(level) {
    var n = Math.max(1, level | 0);
    // 0 at the start of a band, approaching 1 by its end.
    var within = function (from, span) {
      return Math.max(0, Math.min(1, (n - from) / span));
    };
    var late = within(31, 30); // the open-ended band beyond stage 30

    /*
     * Independent 0..1 streams keyed to the level number. Same level, same
     * layout, forever — which is what makes a level something you can learn,
     * lose, and come back to.
     *
     * Through the level generator's own PRNG rather than a sin-fract hash:
     * fract(sin(n)) correlates badly for small consecutive integers, and
     * consecutive integers are exactly what this is fed. It put levels 7, 8
     * and 9 within a cell of each other.
     */
    var pick = function (salt) {
      return mulberry32(Math.imul(n, 92837111) + Math.imul(salt, 689287499))();
    };

    return {
      level: n,
      sand: n >= 11,
      fractured: n >= 21,
      pick: pick,

      // --- harder ---------------------------------------------------------
      // The clay corridor: from generous down to a genuinely tight lane. It
      // starts narrowing immediately, so level 9 is not level 1 with a
      // different speckle.
      corridor: 0.42 - 0.09 * within(1, 10) - 0.13 * within(11, 20) - 0.07 * late,
      // Sand deepens through its band and keeps creeping afterwards.
      sandDepth: 0.14 + 0.06 * within(11, 12) + 0.05 * late,
      // Fractured slab thickens once it appears.
      fracDepth: 0.08 + 0.05 * within(21, 12) + 0.03 * late,
      // Basin width as a share of the corridor, so it always fits inside it
      // and tightens twice over: a smaller share of a narrower corridor.
      basin: 0.68 - 0.22 * within(1, 30) - 0.06 * late,
      // Bedrock apron flanking the basin — the margin for a near miss. Land
      // on it and the fluid still slides home; miss it and the floor is drain.
      apron: 0.13 - 0.08 * within(1, 30) - 0.03 * late,

      // --- different ------------------------------------------------------
      // How far in from the right wall the corridor may sit. Level 1 is
      // pinned right so the first level is the plainest statement of the
      // rule; every level after that puts the route somewhere else.
      wander: within(2, 4) * pick(1),
      // The strata themselves move, so the cross-section reads as a new place
      // and not as the same diagram with one lane shifted.
      sealAt: 0.27 + 0.05 * pick(2),
      sandAt: 0.43 + 0.05 * pick(3),
      fracAt: 0.68 + 0.04 * pick(4),
      cavernAt: 0.79 + 0.05 * pick(5),
      // Which side the bedrock rib blocks, and how far across it reaches.
      ribAt: 0.6 + 0.08 * pick(6),
      ribReach: 0.22 + 0.16 * pick(7)
    };
  }

  function buildLevel(opts) {
    opts = opts || {};
    var w = opts.w || 120,
      h = opts.h || 200;
    var level = opts.level === undefined ? opts.seed : opts.level;
    var D = difficultyFor(level === undefined ? 1 : level);
    var sim = new Sim(w, h, opts.seed === undefined ? 1 : opts.seed);
    sim.difficulty = D;
    var R = mulberry32((opts.seed === undefined ? 1 : opts.seed) * 31 + 7);
    var WALL = 3;
    var band = function (f) {
      return Math.round(f * h);
    };
    var col = function (f) {
      return Math.round(f * w);
    };

    var x, y, i;
    /*
     * Per-cell shading noise, computed once at build so it costs nothing per
     * frame. White noise made every material look like the same TV static, so
     * this layers two things that read as geology instead:
     *
     *   fine grain   per-cell speckle, the granular texture of a cut face
     *   bedding      slow horizontal banding, the sedimentary lines you see in
     *                a real cross-section, jittered per row so they wander
     *
     * The banding is the part that sells it: strata should look deposited, and
     * horizontal streaks at varying spacing is what deposition looks like.
     */
    var rowShade = new Float32Array(h);
    var drift = 0;
    for (y = 0; y < h; y++) {
      drift += (R() - 0.5) * 0.55;
      if (drift > 1) drift = 1;
      if (drift < -1) drift = -1;
      rowShade[y] = Math.sin(y * 0.42 + drift * 2.2) * 3.4 + drift * 2.6;
    }
    for (y = 0; y < h; y++) {
      // Not named `band` — that is the level-geometry helper declared below,
      // and shadowing it here silently turns every band(0.3) into a number.
      var bedding = rowShade[y];
      for (x = 0; x < w; x++) {
        var grain = R() * 9 - 4.5;
        // A slow horizontal wobble keeps the bedding from looking ruled.
        var wobble = Math.sin(x * 0.09 + y * 0.03) * 2.2;
        sim.tint[y * w + x] = Math.max(
          -24,
          Math.min(24, Math.round(bedding + grain + wobble))
        );
      }
    }

    // Sealed bedrock shell.
    for (y = 0; y < h; y++)
      for (x = 0; x < w; x++)
        if (x < WALL || x >= w - WALL || y < 2 || y >= h - 2)
          sim.set(x, y, BEDROCK);

    /*
     * The strata. Depths come off the difficulty curve rather than being
     * constants, so two levels are two places rather than two paint jobs on
     * one diagram — a thin seal over a deep cavern plays quite differently
     * from a deep seal over a shallow one, and it reads differently too.
     */
    var sealTop = band(D.sealAt),
      sandTop = band(D.sandAt),
      sandBot = band(D.sandAt + 0.14),
      cavernTop = band(D.cavernAt),
      floorY = band(0.94);

    // Clay from the reservoir seal down to the cavern roof; the sand band and
    // pockets are carved back out of it below.
    for (y = sealTop; y < cavernTop; y++)
      for (x = WALL; x < w - WALL; x++) sim.set(x, y, CLAY);

    /*
     * The corridor: a lane of clay running the full depth of the level, with
     * the sand band filling the rock either side of it. That asymmetry is the
     * puzzle — a shaft cut through sand does not stay a shaft. The band slumps
     * into it and drains away like an hourglass, burying whatever is beneath.
     * The corridor is the route; the sand is the trap that looks like a
     * shortcut.
     *
     * Level 1 hugs the right wall — the plainest statement of the rule. From
     * level 2 the lane is somewhere else each time, and once the sand band
     * arrives it closes in on both sides of wherever the lane has gone.
     */
    var wallF = WALL / w + 0.01;
    var rightmost = 1 - wallF - D.corridor / 2;
    // The lane may sit anywhere between the walls. It used to be pinned out
    // of the left third to leave the bedrock rib somewhere to live, which
    // cost half the available variety; the rib now picks its own side.
    var leftmost = wallF + D.corridor / 2 + 0.05;
    var corridorC = rightmost - D.wander * Math.max(0, rightmost - leftmost);
    var corridorL = col(corridorC - D.corridor / 2),
      corridorR = col(corridorC + D.corridor / 2);

    var hasSand = opts.sand !== false && D.sand;
    if (hasSand) {
      sandBot = sandTop + Math.round(D.sandDepth * h);
      for (y = sandTop; y < sandBot; y++)
        for (x = WALL; x < w - WALL; x++)
          if (x < corridorL || x >= corridorR) sim.set(x, y, SAND);
    }
    // Kept for callers that predate the corridor moving; it is the near edge
    // of the sand, which is what they actually wanted.
    var sandRight = corridorL;

    /*
     * A bedrock rib reaching in from the wall the corridor is furthest from,
     * so the long way round is not a free ride. Which side and how far it
     * reaches are level-specific; it never crosses the corridor, because a
     * rib over the route would be a wall, not an obstacle.
     */
    var ribY = band(D.ribAt),
      ribH = Math.max(2, Math.round(0.03 * h));
    var ribLeft = corridorC > 0.5; // reach in from whichever side is roomier
    var ribFrom = ribLeft ? WALL : Math.max(corridorR + 2, w - WALL - col(D.ribReach));
    var ribTo = ribLeft ? Math.min(col(D.ribReach), corridorL - 2) : w - WALL;
    for (y = ribY; y < ribY + ribH; y++)
      for (x = ribFrom; x < ribTo; x++) sim.set(x, y, BEDROCK);

    /*
     * A fractured slab across the clay corridor, pre-scored into chunks. It
     * sits on the easy route on purpose: the corridor is the way down, and
     * this is the toll. Cut it and you get loose rock tumbling into the shaft
     * you just made, where it can wedge and throttle the flow — or, cut
     * carefully, act as a valve.
     */
    var fracTop = band(D.fracAt),
      fracBot = fracTop + Math.round(D.fracDepth * h),
      // A margin either side, so the slab cannot be sidestepped by hugging
      // the corridor wall — it spans the route and then some.
      fracL = Math.max(WALL, corridorL - col(0.05)),
      fracR = Math.min(w - WALL, corridorR + col(0.05));
    if (opts.fractured !== false && D.fractured) {
      var CH = Math.max(3, Math.round(0.035 * w)); // chunk edge, in cells
      for (y = fracTop; y < fracBot; y++)
        for (x = fracL; x < fracR; x++) {
          sim.set(x, y, FRACTURED);
          var gx = Math.floor((x - fracL) / CH),
            gy = Math.floor((y - fracTop) / CH);
          var key = gy * 1000 + gx;
          var id = sim.chunkIndex[key];
          if (id === undefined) {
            id = sim.chunks.length;
            sim.chunkIndex[key] = id;
            sim.chunks.push({ x0: x, y0: y, x1: x, y1: y, detached: false });
          }
          var c = sim.chunks[id];
          if (x < c.x0) c.x0 = x;
          if (x > c.x1) c.x1 = x;
          if (y < c.y0) c.y0 = y;
          if (y > c.y1) c.y1 = y;
          sim.chunkId[y * w + x] = id;
        }
    }

    /*
     * Dry sand pockets suspended in the lower clay. Placed per level rather
     * than at two fixed spots: they are the readable landmarks of a level,
     * and landmarks in the same place every time are wallpaper.
     */
    var pockets = [];
    for (var pk = 0; pk < 3; pk++) {
      pockets.push([
        col(0.12 + 0.72 * D.pick(10 + pk)),
        band(0.66 + 0.12 * D.pick(20 + pk)),
        Math.round((0.045 + 0.035 * D.pick(30 + pk)) * w)
      ]);
    }
    for (var p = 0; p < pockets.length; p++) {
      var px = pockets[p][0],
        py = pockets[p][1],
        pr = pockets[p][2];
      // A pocket sitting in the corridor would put sand on the safe route
      // before the sand band has been taught. Drop it instead of moving it —
      // the pockets are scenery, and the corridor is the promise.
      if (px + pr >= corridorL && px - pr < corridorR) continue;
      for (y = py - pr; y <= py + pr; y++)
        for (x = px - pr; x <= px + pr; x++) {
          if (x < WALL || x >= w - WALL || y < 0 || y >= h) continue;
          var ddx = x - px,
            ddy = y - py;
          if (ddx * ddx + ddy * ddy > pr * pr) continue;
          if (sim.get(x, y) === CLAY) sim.set(x, y, SAND);
        }
    }

    // Open cavern beneath the clay.
    for (y = cavernTop; y < floorY; y++)
      for (x = WALL; x < w - WALL; x++) sim.set(x, y, EMPTY);

    // Cavern floor: bedrock, except the collector basin at centre and a drain
    // at each far edge. Land the column off-centre and the payload runs to the
    // drains instead of the crystal.
    for (y = floorY; y < h - 2; y++)
      for (x = WALL; x < w - WALL; x++) sim.set(x, y, BEDROCK);

    /*
     * The basin sits under the corridor, so the route always ends somewhere.
     * Flanking it is an apron of bedrock: land the column on the apron and the
     * fluid still runs home, so a near miss costs time rather than the level.
     * Everything beyond the apron is drain.
     *
     * The apron is the difficulty dial that matters most. Early levels give a
     * wide one and forgive a sloppy aim; late levels shave it to a few cells,
     * and a column that lands off the crystal is simply gone.
     */
    var basinHalf = Math.max(3, Math.round((D.basin * D.corridor * w) / 2));
    var basinC = Math.round(corridorC * w);
    var basinL = Math.max(WALL + 1, basinC - basinHalf),
      basinR = Math.min(w - WALL - 2, basinC + basinHalf),
      basinBot = Math.min(h - 3, floorY + Math.round(0.05 * h));
    for (y = floorY; y <= basinBot; y++)
      for (x = basinL; x <= basinR; x++) sim.set(x, y, COLLECTOR);

    /*
     * The drains are whatever floor is left. Cut into mouths of bounded width
     * with bedrock ribs between them, because one continuous chasm half the
     * level wide reads as a background, not as a hazard — and the ribs change
     * nothing: fluid landing on one still runs into a drain either way.
     */
    var apron = Math.max(2, Math.round(D.apron * w));
    var mouth = Math.max(4, Math.round(0.12 * w)),
      rib = Math.max(2, Math.round(0.02 * w));
    var drains = [];
    var cut = function (from, to) {
      for (var a = from; a <= to; a += mouth + rib) {
        var b = Math.min(to, a + mouth - 1);
        if (b - a < 2) break; // too narrow to read as a mouth
        drains.push([a, b]);
      }
    };
    cut(WALL, basinL - apron - 1);
    cut(basinR + apron + 1, w - WALL - 1);
    for (var dI = 0; dI < drains.length; dI++)
      for (y = floorY; y < h - 2; y++)
        for (x = drains[dI][0]; x <= drains[dI][1]; x++) sim.set(x, y, DRAIN);

    // Reservoir: fluid resting on the clay seal, with headroom above it.
    var waterTop = band(0.12);
    sim.waterSurface = waterTop;
    for (y = waterTop; y < sealTop; y++)
      for (x = WALL; x < w - WALL; x++)
        if (sim.get(x, y) === EMPTY) {
          sim.set(x, y, WATER);
          sim.released++;
        }

    sim.geometry = {
      wall: WALL,
      sealTop: sealTop,
      sandTop: sandTop,
      sandBot: sandBot,
      sandRight: sandRight,
      corridorL: corridorL,
      corridorR: corridorR,
      ribY: ribY,
      ribFrom: ribFrom,
      ribTo: ribTo,
      apron: apron,
      cavernTop: cavernTop,
      floorY: floorY,
      basinL: basinL,
      basinR: basinR,
      basinBot: basinBot,
      drains: drains,
      centreX: Math.round(w / 2),
      // Down the clay corridor and into the basin, wherever it has drifted to.
      routeX: Math.round((basinL + basinR) / 2),
      level: D.level,
      difficulty: D,
      fracTop: fracTop,
      fracBot: fracBot,
      fracL: fracL
    };
    return sim;
  }

  // The reference solution: one straight channel down the clay corridor,
  // clear of the sand band, landing inside the collector basin.
  function carveIdealChannel(sim, radius) {
    var g = sim.geometry;
    var r = radius || Math.max(2, Math.round(sim.w * 0.03));
    sim.digLine(g.routeX, g.sealTop - 1, g.routeX, g.floorY - 1, r);
    return sim;
  }

  return {
    Sim: Sim,
    MAT: MAT,
    NAMES: NAMES,
    COLORS: COLORS,
    buildLevel: buildLevel,
    difficultyFor: difficultyFor,
    carveIdealChannel: carveIdealChannel,
    mulberry32: mulberry32
  };
});
