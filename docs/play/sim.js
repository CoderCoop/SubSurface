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
    FRACTURED = 8,
    GRAVEL = 9;

  var MAT = {
    EMPTY: EMPTY,
    BEDROCK: BEDROCK,
    CLAY: CLAY,
    SAND: SAND,
    WETSAND: WETSAND,
    WATER: WATER,
    COLLECTOR: COLLECTOR,
    DRAIN: DRAIN,
    FRACTURED: FRACTURED,
    GRAVEL: GRAVEL
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
  NAMES[GRAVEL] = 'gravel';

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
  COLORS[GRAVEL] = [122, 116, 102];

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
    this.flowReach = 10;
    this.flowReachMax = 20;
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

    /*
     * A drop-off either side beats a slide either side. Taking the first
     * direction that offered anything meant a droplet three cells from the
     * edge would happily slide six cells inland instead, because the slide was
     * found first — which is most of why the last of a pool wandered.
     */
    var nx = this.scanSide(x, y, d, reach, true);
    if (nx === -1) nx = this.scanSide(x, y, -d, reach, true);
    if (nx === -1) nx = this.scanSide(x, y, d, reach, false);
    if (nx === -1) nx = this.scanSide(x, y, -d, reach, false);
    if (nx !== -1) {
      this.flow(x, y, nx, y);
      return;
    }

    /*
     * Draining from inside the body, not just off its lip.
     *
     * The scan above stops at the first cell that is not empty, so a cell
     * surrounded by other fluid can never move: only the one cell at the pool's
     * lip is ever eligible. That caps the drain rate at one cell per step no
     * matter how much fluid is stacked behind it, which is why a pool on a
     * ledge dribbled away instead of pouring — and why the tail was the worst
     * part, with a wide film losing one cell at a time from its far end.
     *
     * Fluid transmits pressure through itself. So look along the row THROUGH
     * the body for a column that has somewhere to descend, and go there. The
     * gap it leaves behind is filled from above on the next step, which is what
     * a draining pool looks like: the whole surface drops, rather than the far
     * end being nibbled.
     */
    var tx = this.scanThrough(x, y, d, reach);
    if (tx === -1) tx = this.scanThrough(x, y, -d, reach);
    if (tx !== -1) {
      this.flow(x, y, tx, y + 1);
      return;
    }

    /*
     * Spreading a film that has run out of edges to be at.
     *
     * The last of a pool is a sheet one cell deep, and a contiguous sheet has
     * no internal mobility at all: every cell but the two at its ends has
     * fluid to both sides, so every scan above stops on the first neighbour
     * and returns nothing. The sheet then creeps toward the drop at one cell
     * per step from its far end — which is the dribbling tail that made a
     * cleared level take longer to finish draining than it took to solve.
     *
     * So a cell that is walled in by its own fluid looks past the body for
     * open floor and goes there. The sheet thins and reaches out in both
     * directions at once instead of being nibbled from one end.
     */
    var px = this.scanPast(x, y, d, reach);
    if (px === -1) px = this.scanPast(x, y, -d, reach);
    if (px !== -1) this.flow(x, y, px, y);
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
  Sim.prototype.scanSide = function (x, y, d, reach, dropsOnly) {
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
    return dropsOnly ? -1 : furthest;
  };

  /*
   * Look along the row through the fluid body itself, and return the column
   * where it has somewhere to descend — or -1 if there is none within reach.
   *
   * Only fluid is passed through. Pressure travels through fluid; it does not
   * travel through clay, so this must never find a hole on the far side of a
   * wall. Saturated sand is excluded too: it conducts pressure for the head
   * calculation, but a cell cannot swim through a sandbank to reach a gap.
   */
  Sim.prototype.scanThrough = function (x, y, d, reach) {
    for (var k = 1; k <= reach; k++) {
      var nx = x + d * k;
      if (this.get(nx, y) !== WATER) return -1;
      var below = this.get(nx, y + 1);
      if (below === EMPTY || below === COLLECTOR || below === DRAIN) return nx;
    }
    return -1;
  };

  /*
   * Look past the fluid body for the first open cell on this row, and return
   * it — or -1 if the body runs further than reach, or ends in a wall.
   *
   * Same rule as scanThrough about what may be crossed: fluid only. The scan
   * refuses to report anything before it has crossed at least one fluid cell,
   * because the case of an open cell immediately alongside is scanSide's, and
   * scanSide judges it better — it prefers a drop-off over a slide, which
   * this cannot see.
   */
  Sim.prototype.scanPast = function (x, y, d, reach) {
    var crossed = false;
    for (var k = 1; k <= reach; k++) {
      var nx = x + d * k;
      var at = this.get(nx, y);
      if (at === WATER) {
        crossed = true;
        continue;
      }
      if (!crossed) return -1;
      if (at === COLLECTOR || at === DRAIN) return nx;
      return at === EMPTY ? nx : -1;
    }
    return -1;
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

    /*
     * Angle of repose: a grain only slides diagonally when it loses its
     * cohesion roll. Wet sand sticks together far more (spec §2.3), so a
     * soaked band slumps into a steeper, more stable pile than a dry one.
     *
     * Gravel is slower to relax than dry sand and — the point of it — does
     * not drink. Sand can be dropped into a channel to block it, but a sand
     * dam is also a sponge: it takes a cut of the payload it is holding back.
     * Gravel holds the line for free, which is what makes collapsing a pocket
     * into the floor a strategy rather than a trade.
     *
     * Note what cohesion is and is not. It is the chance a grain declines to
     * slide on a given step, so it governs how fast a heap relaxes, not the
     * angle it relaxes to — given long enough, dry sand and gravel settle to
     * the same shape. Only wet sand differs in the end state, because 0.78 is
     * high enough to freeze a slope for the length of a level. A real angle of
     * repose would need a rule about height difference rather than a die roll,
     * and this is not one.
     */
    var stick = mat === WETSAND ? 0.78 : mat === GRAVEL ? 0.62 : 0.28;
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
        else if (m === GRAVEL) this.updateSand(x, y, GRAVEL);
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
        if (m === CLAY || m === SAND || m === GRAVEL) {
          this.cells[i] = EMPTY;
          removed++;
          if (m !== CLAY) grit++;
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
      corridor: 0.42 - 0.08 * within(1, 10) - 0.12 * within(11, 20) - 0.05 * late,
      // Sand deepens through its band and keeps creeping afterwards.
      sandDepth: 0.13 + 0.04 * within(11, 12) + 0.03 * late,
      // Fractured slab thickens once it appears.
      fracDepth: 0.08 + 0.05 * within(21, 12) + 0.03 * late,
      // Basin width as a share of the corridor, so it always fits inside it
      // and tightens twice over: a smaller share of a narrower corridor.
      basin: 0.7 - 0.18 * within(1, 30) - 0.06 * late,
      // Bedrock apron flanking the basin — the margin for a near miss. Land
      // on it and the fluid still slides home; miss it and the floor is drain.
      apron: 0.12 - 0.05 * within(1, 30) - 0.02 * late,

      // --- different ------------------------------------------------------
      // How far in from the right wall the corridor may sit. Level 1 is
      // pinned right so the first level is the plainest statement of the
      // rule; every level after that puts the route somewhere else.
      wander: within(2, 4) * pick(1),
      // The strata themselves move, so the cross-section reads as a new place
      // and not as the same diagram with one lane shifted.
      sealAt: 0.27 + 0.05 * pick(2),
      sandAt: 0.48 + 0.05 * pick(3),
      fracAt: 0.68 + 0.04 * pick(4),
      cavernAt: 0.79 + 0.05 * pick(5),
      // Which side the bedrock rib blocks, and how far across it reaches.
      ribAt: 0.6 + 0.08 * pick(6),
      ribReach: 0.22 + 0.16 * pick(7),
      /*
       * Rock tone. A per-level shift applied to every solid material, so one
       * level is an ochre cutting and the next is a cold grey one. Small
       * numbers on purpose — this is meant to read as different ground, not
       * as a different game.
       */
      tone: [
        Math.round((pick(8) - 0.5) * 26),
        Math.round((pick(9) - 0.5) * 18),
        Math.round((pick(11) - 0.5) * 22)
      ],

      /*
       * Baffles: bedrock shelves reaching in from alternating walls, each
       * leaving one gap to get through. They are what turns a level from
       * "find the lane and drop" into a route with corners in it, and they
       * are the main thing that keeps the late game interesting once the
       * materials have all been introduced.
       *
       * One appears at stage 4, and they accumulate slowly; each reaches
       * further across as the levels climb, so there are more of them and
       * less room to get past each one.
       *
       * They jut from a wall rather than spanning the level with a hole in
       * them. A shelf with a hole is a gate, and a gate made of uncuttable
       * bedrock can be plugged — sand slumps into it and the level is simply
       * over, which is not difficulty, it is a dead end. A shelf that reaches
       * part way is an obstacle: there is always a way round, and finding it
       * is the puzzle.
       */
      baffles: n < 4 ? 0 : n < 14 ? 1 : 2,
      baffleReach: 0.2 + 0.16 * within(4, 40) + 0.04 * late,

      /*
       * The cavern floor can tilt. A column that lands off the crystal then
       * runs downhill instead of sitting where it fell, which turns a near
       * miss from "most of it survives" into "all of it is going somewhere",
       * and makes what you put in its way matter.
       */
      floorSlope: 0,
      /*
       * How far the lane tucks in under the last shelf before dropping.
       *
       * This is the dial that decides whether a level is a puzzle. With the
       * lane leaving a shelf and going straight down, a shaft dropped on the
       * basin never meets the shelf and the answer is "drag down here" — the
       * solver confirmed it, clearing level after level with one naive drop.
       * Tuck the lane back under the shelf and a straight drop onto the basin
       * hits uncuttable bedrock, while a straight drop through the open side
       * lands wide of the crystal. The route has to come down past the shelf
       * and then back under it, and there is no version of that which is one
       * straight line.
       */
      tuck: 0,
      /*
       * Par for the level: how much ground may be moved, and how long there
       * is. Zero means unlimited, which is what every level derived from a
       * number gets — these are for banked levels, where the generator has
       * measured what its own solution costs and can set a budget that leaves
       * room to think but not room to excavate the whole cross-section.
       */
      digBudget: 0,
      seconds: 0,
      /*
       * Gravel pockets hanging in the clay above the cavern. Cut the clay out
       * from under one and it drops, piles up on the floor, and dams it —
       * which is the most interesting thing in the game to do on purpose, and
       * impossible to do by accident.
       */
      gravel: 0,
      // A bedrock column standing on the cavern floor, splitting what lands.
      pillar: 0
    };
  }

  /*
   * Fill in whatever a spec does not say. The generator only writes the dials
   * it wants to vary, so everything else has to have an answer — and a spec
   * that omits a field must build the same level tomorrow, which is why the
   * pick stream is rebuilt from the seed rather than left undefined.
   */
  function withDefaults(spec) {
    var base = difficultyFor(spec.level || 1);
    var out = {};
    for (var k in base) if (base.hasOwnProperty(k)) out[k] = base[k];
    for (var j in spec) if (spec.hasOwnProperty(j)) out[j] = spec[j];
    if (typeof out.pick !== 'function') {
      var salt = (spec.seed === undefined ? spec.level || 1 : spec.seed) | 0;
      out.pick = function (n) {
        return mulberry32(Math.imul(salt, 92837111) + Math.imul(n, 689287499))();
      };
    }
    return out;
  }

  function buildLevel(opts) {
    opts = opts || {};
    var w = opts.w || 120,
      h = opts.h || 200;
    var level = opts.level === undefined ? opts.seed : opts.level;
    /*
     * A level is a spec. difficultyFor() derives one from a level number,
     * which is how the game got its levels before there was a bank; the
     * generator hands one in directly. Same builder either way, so a banked
     * level and a derived one cannot diverge in how they are interpreted.
     */
    var D = opts.spec || difficultyFor(level === undefined ? 1 : level);
    if (!D.pick) D = withDefaults(D);
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

    /*
     * Mineral veins.
     *
     * The bedding alone gives horizontal structure and nothing else, so a face
     * reads as ruled paper. Real rock is cut across by seams — quartz,
     * ironstone, whatever — that run at an angle to the bedding and are the
     * thing your eye actually latches onto in a cross-section.
     *
     * Each vein is a wandering line with a soft falloff either side, drawn
     * into the tint at build so it costs nothing per frame. They read as part
     * of the rock rather than as decals because they share its shading.
     */
    var veinCount = 3 + Math.floor(R() * 3);
    var vein = new Float32Array(w * h);
    for (var v = 0; v < veinCount; v++) {
      var vx = R() * w;
      var slope = (R() - 0.5) * 1.6;
      var wander = 0;
      var strength = 9 + R() * 11;
      var width = 0.7 + R() * 1.6;
      for (y = 0; y < h; y++) {
        wander += (R() - 0.5) * 0.5;
        if (wander > 2.5) wander = 2.5;
        if (wander < -2.5) wander = -2.5;
        var cx = vx + slope * y + wander * 3;
        var lo = Math.max(0, Math.floor(cx - width * 2)),
          hi = Math.min(w - 1, Math.ceil(cx + width * 2));
        for (x = lo; x <= hi; x++) {
          var dx = (x - cx) / width;
          var fall = Math.exp(-dx * dx);
          vein[y * w + x] += fall * strength;
        }
      }
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
          -30,
          Math.min(30, Math.round(bedding + grain + wobble + vein[y * w + x]))
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
    var halfW = Math.max(4, Math.round((D.corridor * w) / 2));

    /*
     * Baffles: bedrock shelves reaching in from alternating walls.
     *
     * They jut from a wall rather than spanning the level with a hole in
     * them. A shelf with a hole is a gate, and a gate made of uncuttable
     * bedrock can be plugged — sand slumps into it and the level is simply
     * over, which is not difficulty, it is a dead end. A shelf that reaches
     * part way is an obstacle: there is always a way round.
     */
    /*
     * Where a shelf may go: the clay above the sand band, and the clay below
     * it. Never inside the band.
     *
     * That restriction is not tidiness, it is the difference between the late
     * levels being winnable and not. A shelf inside the band bends the lane
     * inside it, which gives the sand a sloped inner face — and sand on a
     * slope slumps into the channel, chokes it, and sends the payload out
     * sideways to the drains. Measured: every level past 30 collected under
     * 20% with a bend in the band, and 100% without one.
     *
     * The band also stops short of the cavern. Below the last shelf the lane
     * has to get back over the basin, and a lane that crosses the level in
     * the last few rows is a diagonal so steep that fluid falls straight out
     * of it and lands beside the crystal.
     */
    var baffleY = [],
      baffleGapL = [],
      baffleGapR = [];
    var baffleThick = Math.max(2, Math.round(0.012 * h));
    var baffleShelf = [];
    var bandTop = sandTop,
      bandBot = sandTop + Math.round(D.sandDepth * h);
    /*
     * Shelves live above the sand band, never below it.
     *
     * Anything that leaves the band falls down the channel. Into a vertical
     * shaft that is fine — it piles up on the cavern floor and gets in the
     * way, which is the point of sand. Into a diagonal it is fatal: the grains
     * come to rest against the lower wall and seal the traverse completely,
     * and the payload sits above the plug until the level times out. That is
     * what every unwinnable late level turned out to be.
     *
     * So the lane crosses the level above the sand, then runs straight down
     * through the band and on to the basin without another corner in it.
     */
    /*
     * Shelves stop well above the sand band, so there is clay to do the
     * tucking in. The traverse under a shelf has to happen somewhere, and it
     * cannot happen in the band — sand slumps into a diagonal and seals it.
     */
    var zones = [[sealTop + Math.round(0.02 * h), bandTop - Math.round(0.1 * h)]];
    if (D.baffles > 0) {
      var reachW = Math.max(6, Math.round(D.baffleReach * w));
      var firstLeft = D.pick(50) < 0.5;
      // One shelf per slice of the zone, so two shelves cannot land on top of
      // each other and turn the lane into a scribble.
      var zone = zones[0];
      var sliceH = (zone[1] - zone[0]) / D.baffles;
      for (var bI = 0; bI < D.baffles; bI++) {
        if (sliceH < baffleThick + 5) break; // no room for another
        var sTop = zone[0] + sliceH * bI;
        var by = Math.round(sTop + sliceH * (0.25 + 0.4 * D.pick(60 + bI)));
        var fromLeft = firstLeft === (bI % 2 === 0);
        var shelfL = fromLeft ? WALL : w - WALL - reachW,
          shelfR = fromLeft ? WALL + reachW : w - WALL;
        var openL = fromLeft ? shelfR : WALL,
          openR = fromLeft ? w - WALL : shelfL;
        baffleY.push(by);
        baffleGapL.push(openL);
        baffleGapR.push(openR);
        baffleShelf.push([shelfL, shelfR]);
      }
    }

    /*
     * The corridor follows the route, rather than the route having to leave
     * the corridor to get round a shelf.
     *
     * This is the whole reason the two are one thing. A straight lane of clay
     * with a weaving path through it means the intended route spends most of
     * its length in the sand band, which swallows the payload — every level
     * past stage 11 became unwinnable the moment shelves were added. So the
     * clay lane bends: it is a band of safe ground centred on the path, and
     * the sand closes in either side of wherever that path has gone.
     */
    var lane = [{ y: 0, x: Math.round(corridorC * w) }];
    var bandLane = null;
    for (var q = 0; q < baffleY.length; q++) {
      var wpx = Math.round((baffleGapL[q] + baffleGapR[q]) / 2);
      bandLane = wpx;
      /*
       * A waypoint above and below each shelf at the same x, so the lane
       * passes it vertically. Steering across the shelf's own rows means the
       * connecting line crosses bedrock — which cannot be dug, so the channel
       * is simply interrupted and the payload never leaves the reservoir. A
       * shelf is something to be beside, not something to pass through.
       */
      lane.push({ y: baffleY[q] - 2, x: wpx });
      lane.push({ y: baffleY[q] + baffleThick + 2, x: wpx });
    }
    /*
     * Where the lane crosses the sand band, and therefore where the basin is.
     * With tuck it slides back under the last shelf, so the only way down to
     * the crystal is around the shelf and back in beneath it.
     */
    if (bandLane === null) bandLane = Math.round(corridorC * w);
    else if (D.tuck > 0 && baffleShelf.length) {
      var lastShelf = baffleShelf[baffleShelf.length - 1];
      // A point inside the shelf's own span, never right at its lip.
      var deep = lastShelf[0] < bandLane
        ? lastShelf[1] - 3 - Math.round((lastShelf[1] - lastShelf[0] - 6) * D.tuck)
        : lastShelf[0] + 3 + Math.round((lastShelf[1] - lastShelf[0] - 6) * D.tuck);
      var loX = WALL + halfW,
        hiX = w - WALL - halfW - 1;
      bandLane = Math.max(loX, Math.min(hiX, deep));
    }
    lane.push({ y: bandTop, x: bandLane });
    lane.push({ y: h, x: bandLane });
    lane.sort(function (u, v) {
      return u.y - v.y;
    });

    // Piecewise-linear through the waypoints, clamped inside the walls.
    var laneX = new Int16Array(h);
    var seg = 0;
    for (y = 0; y < h; y++) {
      while (seg < lane.length - 2 && y > lane[seg + 1].y) seg++;
      var a = lane[seg],
        bb = lane[seg + 1];
      var t = bb.y === a.y ? 0 : (y - a.y) / (bb.y - a.y);
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      var cx = Math.round(a.x + (bb.x - a.x) * t);
      var lo = WALL + halfW,
        hi = w - WALL - halfW - 1;
      laneX[y] = cx < lo ? lo : cx > hi ? hi : cx;
    }
    var corridorL = laneX[h - 3] - halfW,
      corridorR = laneX[h - 3] + halfW;

    // The shelves themselves, laid before sand and rock so neither can be
    // spread over one and breach it; both skip bedrock in turn.
    for (var bJ = 0; bJ < baffleShelf.length; bJ++)
      for (y = baffleY[bJ]; y < baffleY[bJ] + baffleThick; y++)
        for (x = baffleShelf[bJ][0]; x < baffleShelf[bJ][1]; x++)
          sim.set(x, y, BEDROCK);

    var hasSand = opts.sand !== false && D.sand;
    if (hasSand) {
      sandBot = sandTop + Math.round(D.sandDepth * h);
      for (y = sandTop; y < sandBot; y++)
        for (x = WALL; x < w - WALL; x++)
          if (
            (x < laneX[y] - halfW || x >= laneX[y] + halfW) &&
            sim.get(x, y) !== BEDROCK
          )
            sim.set(x, y, SAND);
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
    var ribLane = laneX[Math.min(h - 1, band(D.ribAt))];
    var ribLeft = ribLane > w / 2; // reach in from whichever side is roomier
    var ribFrom = ribLeft
      ? WALL
      : Math.max(ribLane + halfW + 2, w - WALL - col(D.ribReach));
    var ribTo = ribLeft
      ? Math.min(col(D.ribReach), ribLane - halfW - 2)
      : w - WALL;
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
      fracL = Math.max(WALL, laneX[fracTop] - halfW - col(0.05)),
      fracR = Math.min(w - WALL, laneX[fracTop] + halfW + col(0.05));
    if (opts.fractured !== false && D.fractured) {
      var CH = Math.max(3, Math.round(0.035 * w)); // chunk edge, in cells
      for (y = fracTop; y < fracBot; y++)
        for (x = fracL; x < fracR; x++) {
          if (sim.get(x, y) === BEDROCK) continue; // never breach a shelf
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
      var laneHere = laneX[Math.max(0, Math.min(h - 1, py))];
      if (px + pr >= laneHere - halfW && px - pr < laneHere + halfW) continue;
      for (y = py - pr; y <= py + pr; y++)
        for (x = px - pr; x <= px + pr; x++) {
          if (x < WALL || x >= w - WALL || y < 0 || y >= h) continue;
          var ddx = x - px,
            ddy = y - py;
          if (ddx * ddx + ddy * ddy > pr * pr) continue;
          if (sim.get(x, y) === CLAY) sim.set(x, y, SAND);
        }
    }

    /*
     * Gravel pockets, hung in the clay just above the cavern roof.
     *
     * These are the levels' one constructive move. Cut the clay out from
     * under a pocket and the gravel drops into the cavern, piles up on the
     * floor and dams it — so a drain can be walled off, or a tilted floor
     * given a lip to hold the payload against. Gravel is used rather than
     * sand because a sand dam is also a sponge: it takes a cut of whatever it
     * holds back, and a move whose reward is eaten by its own cost is not a
     * move anyone makes twice.
     *
     * They sit clear of the lane, because a pocket that collapses into the
     * route on its own is a hazard, and the point of these is that nothing
     * happens until you decide it should.
     */
    var gravelAt = [];
    for (var gI = 0; gI < (D.gravel | 0); gI++) {
      var gy = cavernTop - Math.round((0.03 + 0.04 * D.pick(80 + gI)) * h);
      var gr = Math.round((0.045 + 0.03 * D.pick(90 + gI)) * w);
      var gLane = laneX[Math.max(0, Math.min(h - 1, gy))];
      /*
       * Placed in the room that exists rather than sampled and rejected. The
       * lane is wide, so picking an x at random and dropping the pocket when
       * it clashed meant most levels quietly got no pockets at all — the
       * feature looked implemented and did nothing.
       */
      var leftRoom = gLane - halfW - 2 - (WALL + gr),
        rightRoom = w - WALL - gr - (gLane + halfW + 2);
      var goLeft =
        leftRoom > rightRoom ? true : rightRoom > leftRoom ? false : D.pick(70 + gI) < 0.5;
      if (goLeft && leftRoom < gr) goLeft = false;
      if (!goLeft && rightRoom < gr) goLeft = true;
      var lo = goLeft ? WALL + gr : gLane + halfW + 2 + gr,
        hi = goLeft ? gLane - halfW - 2 - gr : w - WALL - gr;
      if (hi <= lo) continue; // genuinely nowhere for it to hang
      var gx = Math.round(lo + (hi - lo) * (0.25 + 0.5 * D.pick(70 + gI)));
      gravelAt.push([gx, gy, gr]);
      for (y = gy - gr; y <= gy + gr; y++)
        for (x = gx - gr; x <= gx + gr; x++) {
          if (x < WALL || x >= w - WALL || y < 0 || y >= h) continue;
          var gdx = x - gx,
            gdy = y - gy;
          if (gdx * gdx + gdy * gdy > gr * gr) continue;
          // Decorative sand pockets are scenery and may be overwritten; a
          // shelf or a scored slab may not, or the pocket punches a hole in
          // something the level is relying on.
          var was = sim.get(x, y);
          if (was === CLAY || was === SAND) sim.set(x, y, GRAVEL);
        }
    }

    // Open cavern beneath the clay.
    for (y = cavernTop; y < floorY; y++)
      for (x = WALL; x < w - WALL; x++) sim.set(x, y, EMPTY);

    /*
     * The basin sits under the corridor, so the route always ends somewhere.
     * Flanking it is an apron of bedrock: land the column on the apron and the
     * fluid still runs home, so a near miss costs time rather than the level.
     * Everything beyond the apron is drain.
     */
    var basinHalf = Math.max(4, Math.round((D.basin * D.corridor * w) / 2));
    var basinC = laneX[Math.min(h - 1, floorY)];
    var basinL = Math.max(WALL + 1, basinC - basinHalf),
      basinR = Math.min(w - WALL - 2, basinC + basinHalf),
      basinBot = Math.min(h - 3, floorY + Math.round(0.05 * h));
    var apron = Math.max(4, Math.round(D.apron * w));

    /*
     * The cavern floor. Bedrock, except the basin and the drains either side.
     *
     * It can be crowned: highest at the crystal and falling away to each side,
     * so a column landing beside the basin runs downhill and away rather than
     * sitting where it fell and trickling home.
     *
     * This is now the dial that decides whether aim matters, and it exists
     * because of a change to the fluid rules. Teaching a pooled sheet to find
     * an edge — which it badly needed — also made it very good at finding the
     * crystal from a long way off, and the solver duly reported a straight
     * drop clearing almost every level from almost anywhere. A flat floor
     * forgives everything now. A crowned one does not, and it is also what
     * makes a gravel dam worth building: a pile in the right place gives the
     * payload a lip to catch against.
     */
    var slope = D.floorSlope | 0;
    var floorAt = function (px) {
      if (!slope) return floorY;
      var off = px < basinL ? basinL - px : px > basinR ? px - basinR : 0;
      return floorY + Math.round(slope * Math.min(1, off / Math.max(1, apron)));
    };
    for (x = WALL; x < w - WALL; x++)
      for (y = floorAt(x); y < h - 2; y++) sim.set(x, y, BEDROCK);

    for (x = basinL; x <= basinR; x++)
      for (y = floorAt(x); y <= basinBot; y++) sim.set(x, y, COLLECTOR);

    /*
     * The drains are whatever floor is left. Cut into mouths of bounded width
     * with bedrock ribs between them, because one continuous chasm half the
     * level wide reads as a background, not as a hazard — and the ribs change
     * nothing: fluid landing on one still runs into a drain either way.
     */
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
      for (x = drains[dI][0]; x <= drains[dI][1]; x++)
        for (y = floorAt(x); y < h - 2; y++) sim.set(x, y, DRAIN);

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
      gravelAt: gravelAt,
      floorSlope: slope,
      centreX: Math.round(w / 2),
      // Down the clay corridor and into the basin, wherever it has drifted to.
      routeX: Math.round((basinL + basinR) / 2),
      baffleY: baffleY,
      baffleGapL: baffleGapL,
      baffleGapR: baffleGapR,
      /*
       * The intended path: the x to be at, at each depth that matters. With no
       * shelves this is a straight drop; with them it is a line that has to
       * arrive at each gap in turn and still finish over the basin.
       */
      laneX: laneX,
      laneHalf: halfW,
      route: (function () {
        var pts = [];
        for (var q = 1; q < lane.length - 1; q++)
          pts.push({ y: lane[q].y, x: lane[q].x });
        pts.push({ y: floorY - 1, x: Math.round((basinL + basinR) / 2) });
        return pts;
      })(),
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
  /*
   * Dig the level's intended route, and report what it freed.
   *
   * Follows the waypoints rather than dropping straight: with bedrock shelves
   * in the way a straight line is no longer a solution, and anything that digs
   * "the route" — the reference cut in the game, the reference cut in the
   * tests — has to go through the same one function or they drift apart.
   */
  Sim.prototype.digRoute = function (radius) {
    var g = this.geometry;
    var r = radius || Math.max(2, Math.round(this.w * 0.03));
    var total = { removed: 0, grit: 0, freed: 0, shattered: [] };
    var px = g.route[0].x,
      py = g.sealTop - 1;
    for (var q = 0; q < g.route.length; q++) {
      var one = this.digLine(px, py, g.route[q].x, g.route[q].y, r);
      total.removed += one.removed;
      total.grit += one.grit;
      total.freed += one.freed;
      for (var k = 0; k < one.shattered.length; k++)
        if (total.shattered.indexOf(one.shattered[k]) === -1)
          total.shattered.push(one.shattered[k]);
      px = g.route[q].x;
      py = g.route[q].y;
    }
    return total;
  };

  function carveIdealChannel(sim, radius) {
    sim.digRoute(radius);
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
