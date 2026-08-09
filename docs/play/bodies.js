/*
 * Subsurface — rigid-body layer for fractured rock (spec §4.1, secondary
 * system) and the interaction layer that couples it to the cellular grid.
 *
 * Physics is Box2D, via planck (Erin Catto's engine ported to JS, MIT). We do
 * not implement collision response, friction, restitution, islands or solvers
 * — the library does. What is written here is only the part no library can
 * provide: the two-way contract between a particle grid and a rigid-body
 * world, which the spec states as
 *
 *   - grid particles exert buoyancy/pressure forces on the rigid bodies
 *   - rigid bodies act as collision masks masking out grid cells
 *
 * Both directions are implemented below. Everything else is delegated.
 */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('planck') : root.planck
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SubsurfaceBodies = api;
})(typeof self !== 'undefined' ? self : this, function (pl) {
  'use strict';

  // Grid cells are small; Box2D is happiest with objects roughly 0.1–10 units,
  // so shrink cell space into physics space rather than simulating 5-metre
  // boulders. Grid y grows downward and physics y grows upward, hence the flip.
  var SCALE = 0.25;

  function Bodies(sim, opts) {
    opts = opts || {};
    this.sim = sim;
    this.world = new pl.World({ gravity: new pl.Vec2(0, -10) });
    this.chunks = []; // { body, cells: [[dx,dy]...], w, h }
    this.terrain = null; // static body rebuilt from the grid as it changes
    this.terrainDirty = true;
    this.density = opts.density === undefined ? 2.4 : opts.density; // rock
    this.fluidDensity = opts.fluidDensity === undefined ? 1.0 : opts.fluidDensity;
    this.drag = opts.drag === undefined ? 1.6 : opts.drag;

    /*
     * Shattered rock does not tile the hole it came from. Without clearance
     * the pieces sit perfectly flush against the walls and each other, and
     * friction arch-locks the lot into a solid plug that never falls — real
     * jamming behaviour, but it turns a shaft into a wall. Insetting each
     * piece gives the rubble room to tumble and leaves gaps for fluid to
     * trickle through, so a cut slab throttles the flow instead of stopping it.
     */
    this.inset = opts.inset === undefined ? 0.14 : opts.inset;
    this.rebuildAfter = 3; // cells a chunk may drift before terrain is rebuilt
  }

  Bodies.prototype.toPhysX = function (gx) {
    return gx * SCALE;
  };
  Bodies.prototype.toPhysY = function (gy) {
    return (this.sim.h - gy) * SCALE;
  };
  Bodies.prototype.toGridX = function (px) {
    return px / SCALE;
  };
  Bodies.prototype.toGridY = function (py) {
    return this.sim.h - py / SCALE;
  };

  /*
   * Terrain collision. Box2D needs geometry, and the grid is pixels, so the
   * solid cells are merged into horizontal runs and handed over as boxes. Run
   * merging matters: without it a modest level is tens of thousands of
   * fixtures and the broadphase drowns.
   *
   * Rebuilt only when the grid actually changes under the bodies, since
   * digging and slumping sand both invalidate it.
   */
  Bodies.prototype.rebuildTerrain = function () {
    if (this.terrain) this.world.destroyBody(this.terrain);
    this.terrain = this.world.createBody();

    var sim = this.sim,
      w = sim.w,
      h = sim.h;
    // Only the neighbourhood around live chunks needs collision geometry.
    var regions = this.chunkRegions();
    var seen = {};

    for (var r = 0; r < regions.length; r++) {
      var reg = regions[r];
      for (var y = reg.y0; y <= reg.y1; y++) {
        var runStart = -1;
        for (var x = reg.x0; x <= reg.x1 + 1; x++) {
          var solid =
            x <= reg.x1 && x >= 0 && y >= 0 && x < w && y < h && isSolid(sim, x, y);
          if (solid && runStart < 0) runStart = x;
          if (!solid && runStart >= 0) {
            var key = y * 100000 + runStart * 100 + (x - runStart);
            if (!seen[key]) {
              seen[key] = 1;
              this.addRun(runStart, x - 1, y);
            }
            runStart = -1;
          }
        }
      }
    }
    // Remember where each chunk was when this geometry was built.
    for (var i = 0; i < this.chunks.length; i++) {
      var c = this.chunks[i];
      var p = c.body.getPosition();
      c.lastX = this.toGridX(p.x);
      c.lastY = this.toGridY(p.y);
    }
    this.terrainDirty = false;
  };

  function isSolid(sim, x, y) {
    var m = sim.raw(x, y);
    return (
      m === 1 /* BEDROCK */ ||
      m === 2 /* CLAY */ ||
      m === 3 /* SAND */ ||
      m === 4 /* WETSAND */ ||
      m === 8 /* FRACTURED */ ||
      m === 10 /* VENT */ ||
      m === 11 /* MEMBRANE */
    );
  }

  Bodies.prototype.addRun = function (x0, x1, y) {
    var n = x1 - x0 + 1;
    var cx = this.toPhysX(x0 + n / 2);
    var cy = this.toPhysY(y + 0.5);
    this.terrain.createFixture(
      new pl.Box((n * SCALE) / 2, SCALE / 2, new pl.Vec2(cx, cy)),
      { friction: 0.6 }
    );
  };

  // Cell-space boxes around each live chunk, padded so a falling body always
  // has ground built ahead of it.
  Bodies.prototype.chunkRegions = function () {
    var out = [],
      pad = 14;
    for (var i = 0; i < this.chunks.length; i++) {
      var c = this.chunks[i];
      var p = c.body.getPosition();
      var gx = this.toGridX(p.x),
        gy = this.toGridY(p.y);
      out.push({
        x0: Math.max(0, Math.floor(gx - c.w / 2 - pad)),
        x1: Math.min(this.sim.w - 1, Math.ceil(gx + c.w / 2 + pad)),
        y0: Math.max(0, Math.floor(gy - c.h / 2 - pad)),
        y1: Math.min(this.sim.h - 1, Math.ceil(gy + c.h / 2 + pad))
      });
    }
    return out;
  };

  /*
   * Detach a scored chunk from the grid and hand it to the physics world as a
   * dynamic body. The shape is the chunk's bounding box: chunks are scored
   * small and roughly square, so a box is a fair approximation and keeps the
   * fixture convex, which is what Box2D wants.
   */
  Bodies.prototype.shatter = function (id) {
    var piece = this.sim.detachChunk(id);
    if (!piece) return null;

    var b = piece.box;
    var cw = (b.x1 - b.x0 + 1) * (1 - this.inset),
      ch = (b.y1 - b.y0 + 1) * (1 - this.inset);
    var cx = b.x0 + (b.x1 - b.x0 + 1) / 2,
      cy = b.y0 + (b.y1 - b.y0 + 1) / 2;

    var body = this.world.createDynamicBody({
      position: new pl.Vec2(this.toPhysX(cx), this.toPhysY(cy)),
      angularDamping: 0.4,
      linearDamping: 0.05
    });
    body.createFixture(new pl.Box((cw * SCALE) / 2, (ch * SCALE) / 2), {
      density: this.density,
      // Low enough that rubble slides and rolls clear rather than arching
      // across a shaft and hanging there.
      friction: 0.35,
      restitution: 0.05
    });

    var rec = { body: body, w: cw, h: ch, id: id, lastX: cx, lastY: cy };
    this.chunks.push(rec);
    this.terrainDirty = true;
    return rec;
  };

  Bodies.prototype.shatterAll = function (ids) {
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var r = this.shatter(ids[i]);
      if (r) out.push(r);
    }
    return out;
  };

  /*
   * Grid -> bodies. Buoyancy and drag from the fluid the chunk is sitting in.
   *
   * Sampling the cells a body covers gives the submerged fraction directly,
   * which is all Archimedes needs: displaced fluid weight pushes up, and the
   * fluid resists motion through it. Rock is denser than the fluid, so this
   * does not float rock — it slows a chunk falling through a flooded shaft and
   * lets a fast current shove one sideways, which is the behaviour the spec
   * asks for.
   */
  Bodies.prototype.applyFluidForces = function () {
    var sim = this.sim,
      WATER = 5;
    for (var i = 0; i < this.chunks.length; i++) {
      var c = this.chunks[i];
      var p = c.body.getPosition();
      var gx = this.toGridX(p.x),
        gy = this.toGridY(p.y);

      var x0 = Math.floor(gx - c.w / 2),
        x1 = Math.ceil(gx + c.w / 2);
      var y0 = Math.floor(gy - c.h / 2),
        y1 = Math.ceil(gy + c.h / 2);

      var wet = 0,
        total = 0,
        flowX = 0;
      for (var y = y0; y <= y1; y++)
        for (var x = x0; x <= x1; x++) {
          total++;
          if (sim.raw(x, y) === WATER) {
            wet++;
            // Pressure gradient across the body: more fluid on one side than
            // the other pushes it toward the emptier side.
            flowX += x < gx ? 1 : -1;
          }
        }
      if (!total || !wet) continue;

      var submerged = wet / total;
      var mass = c.body.getMass();

      // Archimedes, expressed against the body's own weight so the ratio of
      // densities is what decides whether it rises or sinks.
      var lift = (this.fluidDensity / this.density) * submerged * 10 * mass;
      c.body.applyForceToCenter(new pl.Vec2(0, lift), true);

      // Drag, and a shove from the pressure imbalance.
      var v = c.body.getLinearVelocity();
      c.body.applyForceToCenter(
        new pl.Vec2(
          -v.x * this.drag * submerged * mass + flowX * 0.04 * mass,
          -v.y * this.drag * submerged * mass
        ),
        true
      );
    }
  };

  /*
   * Bodies -> grid. Stamp every cell a chunk covers into sim.mask, which makes
   * sim.get report it as bedrock. Fluid pools on top of a chunk, sand piles
   * against it, and nothing flows through it — without a single cellular rule
   * knowing that rigid bodies exist.
   */
  Bodies.prototype.stampMask = function () {
    var sim = this.sim;
    sim.mask.fill(0);
    for (var i = 0; i < this.chunks.length; i++) {
      var c = this.chunks[i];
      var p = c.body.getPosition();
      var a = c.body.getAngle();
      var cos = Math.cos(-a),
        sin = Math.sin(-a);
      var gx = this.toGridX(p.x),
        gy = this.toGridY(p.y);
      var reach = Math.ceil(Math.sqrt(c.w * c.w + c.h * c.h) / 2) + 1;

      for (var dy = -reach; dy <= reach; dy++)
        for (var dx = -reach; dx <= reach; dx++) {
          var x = Math.round(gx + dx),
            y = Math.round(gy + dy);
          if (x < 0 || y < 0 || x >= sim.w || y >= sim.h) continue;
          // Rotate the sample back into the chunk's own frame. Grid y is
          // flipped relative to physics y, so the angle is negated above.
          var rx = dx * cos - dy * sin,
            ry = dx * sin + dy * cos;
          if (Math.abs(rx) <= c.w / 2 && Math.abs(ry) <= c.h / 2)
            sim.mask[y * sim.w + x] = 1;
        }
    }
  };

  // Has any chunk drifted far enough that it needs collision geometry built
  // somewhere the last rebuild did not cover?
  Bodies.prototype.needsTerrain = function () {
    for (var i = 0; i < this.chunks.length; i++) {
      var c = this.chunks[i];
      var p = c.body.getPosition();
      var gx = this.toGridX(p.x),
        gy = this.toGridY(p.y);
      if (
        Math.abs(gx - c.lastX) > this.rebuildAfter ||
        Math.abs(gy - c.lastY) > this.rebuildAfter
      ) {
        return true;
      }
    }
    return false;
  };

  Bodies.prototype.markTerrainDirty = function () {
    this.terrainDirty = true;
  };

  // One frame: fluid pushes the bodies, Box2D solves, bodies re-mask the grid.
  Bodies.prototype.step = function (dt) {
    if (!this.chunks.length) {
      this.sim.mask.fill(0);
      return;
    }
    // Rebuilding destroys and recreates the static body, which throws away
    // every contact with it — do it only when the grid changed or a chunk has
    // moved out of the region we built, not every frame.
    if (this.terrainDirty || this.needsTerrain()) this.rebuildTerrain();
    this.applyFluidForces();
    this.world.step(dt === undefined ? 1 / 60 : dt, 8, 3);
    this.stampMask();
  };

  // Cell-space corners of each chunk, for rendering.
  Bodies.prototype.outlines = function () {
    var out = [];
    for (var i = 0; i < this.chunks.length; i++) {
      var c = this.chunks[i];
      var p = c.body.getPosition(),
        a = c.body.getAngle();
      var cos = Math.cos(a),
        sin = Math.sin(a);
      var gx = this.toGridX(p.x),
        gy = this.toGridY(p.y);
      var hw = c.w / 2,
        hh = c.h / 2;
      var pts = [];
      var corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
      for (var k = 0; k < 4; k++) {
        var lx = corners[k][0],
          ly = corners[k][1];
        pts.push([gx + lx * cos + ly * sin, gy - lx * sin + ly * cos]);
      }
      out.push(pts);
    }
    return out;
  };

  Bodies.prototype.count = function () {
    return this.chunks.length;
  };

  return { Bodies: Bodies, SCALE: SCALE };
});
