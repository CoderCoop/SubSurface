/*
 * Browser harness for the Subsurface simulation.
 *
 * Rendering, input and HUD only — every rule lives in sim.js, which knows
 * nothing about the DOM. This is a development harness for feeling out the
 * simulation, not the shipping game: no audio, no haptics, no level select.
 */
(function () {
  'use strict';

  var S = window.Subsurface;
  var B = window.SubsurfaceBodies;
  var MAT = S.MAT,
    COLORS = S.COLORS;

  var GRID_W = 120,
    GRID_H = 200;
  var STEPS_PER_FRAME = 4;
  var STALL_FRAMES = 240; // ~4s of no change before calling a level over
  var DIG_RADIUS = 4; // constant, per spec §2.1
  var WIN_PCT = 85;

  var display = document.getElementById('view');
  var ctx = display.getContext('2d');

  // Cells are drawn at 1px into an offscreen buffer, then blitted up whole.
  // Far cheaper than filling thousands of rects, and keeps the pixels crisp.
  var buf = document.createElement('canvas');
  buf.width = GRID_W;
  buf.height = GRID_H;
  var bctx = buf.getContext('2d');
  var img = bctx.createImageData(GRID_W, GRID_H);

  var sim, bodies, seed = 1, outcome = null, digging = false, last = null;
  var stall = 0, prev = '';

  var el = {
    depth: document.getElementById('depth'),
    pressure: document.getElementById('pressure'),
    collected: document.getElementById('collected'),
    bar: document.getElementById('bar'),
    held: document.getElementById('held'),
    lost: document.getElementById('lost'),
    inplay: document.getElementById('inplay'),
    banner: document.getElementById('banner'),
    chunks: document.getElementById('chunks'),
    seed: document.getElementById('seedlabel')
  };

  function reset(newSeed) {
    seed = newSeed === undefined ? seed : newSeed;
    sim = S.buildLevel({ w: GRID_W, h: GRID_H, seed: seed });
    bodies = new B.Bodies(sim);
    outcome = null;
    stall = 0;
    prev = '';
    el.banner.className = 'banner';
    el.banner.textContent = '';
    el.seed.textContent = 'seed ' + seed;
  }

  function draw() {
    var d = img.data,
      cells = sim.cells,
      tint = sim.tint,
      head = sim.head;
    for (var i = 0; i < cells.length; i++) {
      var m = cells[i];
      var c = COLORS[m];
      var t = tint[i];
      var r = c[0],
        g = c[1],
        b = c[2];
      if (m === MAT.WATER) {
        // Pressurised fluid reads brighter, so you can see where it is
        // working hardest without opening a debug view.
        var lift = head[i] > 24 ? 24 : head[i];
        r += lift * 0.5;
        g += lift * 0.9;
        b += lift * 0.8;
      } else if (m !== MAT.EMPTY && m !== MAT.BEDROCK) {
        r += t;
        g += t;
        b += t;
      } else if (m === MAT.BEDROCK) {
        r += t * 0.4;
        g += t * 0.4;
        b += t * 0.4;
      }
      var o = i * 4;
      d[o] = r < 0 ? 0 : r > 255 ? 255 : r;
      d[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      d[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      d[o + 3] = 255;
    }
    bctx.putImageData(img, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, display.width, display.height);
    ctx.drawImage(buf, 0, 0, display.width, display.height);

    // Rigid chunks are drawn as real polygons rather than through the cell
    // buffer, so their rotation reads clearly as they tumble.
    var sx = display.width / GRID_W,
      sy = display.height / GRID_H;
    var outs = bodies.outlines();
    for (var k = 0; k < outs.length; k++) {
      var pts = outs[k];
      ctx.beginPath();
      ctx.moveTo(pts[0][0] * sx, pts[0][1] * sy);
      for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0] * sx, pts[j][1] * sy);
      ctx.closePath();
      ctx.fillStyle = '#5a6b78';
      ctx.fill();
      ctx.strokeStyle = '#7b8d9a';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function updateHud(s) {
    el.depth.textContent = s.depth.toFixed(0) + ' m';
    el.pressure.textContent = s.pressure.toFixed(0);
    el.collected.textContent = s.collectionPct.toFixed(0) + '%';
    el.bar.style.width = Math.min(100, s.collectionPct) + '%';
    el.held.textContent = s.heldBySand;
    el.lost.textContent = s.lost;
    el.inplay.textContent = s.inPlay;
    el.chunks.textContent = bodies.count();
  }

  function checkOutcome(s) {
    if (outcome) return;

    if (s.collectionPct >= WIN_PCT) {
      outcome = 'win';
      el.banner.className = 'banner win';
      el.banner.textContent =
        'CLEAR — ' + s.collectionPct.toFixed(0) + '% collected';
      return;
    }

    // A level rarely reaches literally zero fluid in motion — a few units
    // cling in corners forever. So call it over when nothing has changed for
    // a while, not when everything has drained.
    var sig = s.collected + '/' + s.inPlay + '/' + s.heldBySand + '/' + s.lost;
    stall = sig === prev ? stall + 1 : 0;
    prev = sig;
    if (stall < STALL_FRAMES || digging) return;

    outcome = 'fail';
    el.banner.className = 'banner fail';
    el.banner.textContent =
      'FAILED — ' +
      s.collectionPct.toFixed(0) +
      '% collected' +
      (s.lost ? ', ' + s.lost + ' drained away' : '') +
      (s.heldBySand ? ', ' + s.heldBySand + ' held by sand' : '');
  }

  function frame() {
    for (var i = 0; i < STEPS_PER_FRAME; i++) {
      bodies.step(1 / 60);
      sim.step();
    }
    var s = sim.stats();
    draw();
    updateHud(s);
    checkOutcome(s);
    requestAnimationFrame(frame);
  }

  // --- input ---------------------------------------------------------------

  function toGrid(ev) {
    var r = display.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * GRID_W,
      y: ((ev.clientY - r.top) / r.height) * GRID_H
    };
  }

  display.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    display.setPointerCapture(ev.pointerId);
    digging = true;
    last = toGrid(ev);
    shatter(sim.dig(last.x, last.y, DIG_RADIUS));
  });

  // Cutting into fractured rock hands whole chunks to the physics world.
  function shatter(r) {
    if (r.shattered.length) bodies.shatterAll(r.shattered);
    if (r.removed || r.shattered.length) bodies.markTerrainDirty();
  }

  display.addEventListener('pointermove', function (ev) {
    if (!digging) return;
    ev.preventDefault();
    var p = toGrid(ev);
    // Interpolate, so a fast swipe cuts a continuous tunnel.
    shatter(sim.digLine(last.x, last.y, p.x, p.y, DIG_RADIUS));
    last = p;
  });

  function endDig(ev) {
    if (!digging) return;
    digging = false;
    last = null;
    if (ev.pointerId !== undefined && display.hasPointerCapture(ev.pointerId))
      display.releasePointerCapture(ev.pointerId);
  }
  display.addEventListener('pointerup', endDig);
  display.addEventListener('pointercancel', endDig);

  document.getElementById('reset').addEventListener('click', function () {
    reset();
  });
  document.getElementById('next').addEventListener('click', function () {
    reset(seed + 1);
  });
  document.getElementById('solve').addEventListener('click', function () {
    var g = sim.geometry;
    var r = sim.digLine(
      g.routeX,
      g.sealTop - 1,
      g.routeX,
      g.floorY - 1,
      Math.max(2, Math.round(sim.w * 0.03))
    );
    shatter(r);
  });

  reset(1);
  requestAnimationFrame(frame);
})();
