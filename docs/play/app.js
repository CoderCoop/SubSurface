/*
 * Browser harness for the Subsurface simulation.
 *
 * Rendering, input and HUD only — every rule lives in sim.js and bodies.js,
 * neither of which knows the DOM exists.
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
  var STALL_FRAMES = 240; // ~4s of no change before calling a settled level over
  var DIG_RADIUS = 4; // constant, per spec §2.1

  /*
   * Grades. Passing is 85% (spec §5), deliberately short of everything — some
   * loss to sand and to the drains is expected, and demanding a perfect run
   * would make the materials feel like punishment rather than tactics. The
   * tiers above it are what reward a clean cut, so there is a reason to
   * replay a level you have already beaten.
   */
  var WIN_PCT = 85;
  var TIERS = [
    { at: 97, stars: 3 },
    { at: 92, stars: 2 },
    { at: WIN_PCT, stars: 1 }
  ];

  function tierFor(pct) {
    for (var i = 0; i < TIERS.length; i++) if (pct >= TIERS[i].at) return TIERS[i];
    return null;
  }
  function nextTier(pct) {
    for (var i = TIERS.length - 1; i >= 0; i--) if (pct < TIERS[i].at) return TIERS[i];
    return null;
  }
  function stars(n) {
    return (
      '<span class="stars">' +
      '★★★'.slice(0, n) +
      '<span class="dim">' + '☆☆☆'.slice(0, 3 - n) + '</span>' +
      '</span>'
    );
  }

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
  var stall = 0, prev = '', tick = 0, cursor = null, passed = false;

  var el = {
    depth: document.getElementById('depth'),
    pressure: document.getElementById('pressure'),
    collected: document.getElementById('collected'),
    bar: document.getElementById('bar'),
    ceiling: document.getElementById('ceiling'),
    held: document.getElementById('held'),
    lost: document.getElementById('lost'),
    inplay: document.getElementById('inplay'),
    banner: document.getElementById('banner'),
    chunks: document.getElementById('chunks'),
    seed: document.getElementById('seedlabel'),
    intro: document.getElementById('intro')
  };

  // Materials that light from above like ground rather than like fluid.
  var SOLID = {};
  SOLID[MAT.CLAY] = SOLID[MAT.SAND] = SOLID[MAT.WETSAND] = 1;
  SOLID[MAT.BEDROCK] = SOLID[MAT.FRACTURED] = 1;

  function reset(newSeed) {
    seed = newSeed === undefined ? seed : newSeed;
    sim = S.buildLevel({ w: GRID_W, h: GRID_H, seed: seed });
    bodies = new B.Bodies(sim);
    outcome = null;
    passed = false;
    stall = 0;
    prev = '';
    el.banner.className = 'banner';
    el.banner.innerHTML = '';
    el.seed.textContent = 'level ' + seed;
    var f = document.getElementById('levelnum');
    if (f) f.value = seed;
  }

  /* ---------------------------------------------------------------------
   * Rendering
   *
   * One pass over the grid writing straight into an ImageData buffer. The
   * lighting is all single-neighbour lookups — enough to give the cross
   * section depth without costing a second pass over 24,000 cells.
   * ------------------------------------------------------------------- */
  function draw() {
    var d = img.data,
      cells = sim.cells,
      tint = sim.tint,
      head = sim.head,
      w = GRID_W;

    // One shimmer value per frame rather than per cell.
    var shimmer = 10 + Math.sin(tick * 0.05) * 10;

    for (var i = 0; i < cells.length; i++) {
      var m = cells[i];
      var c = COLORS[m];
      var r = c[0],
        g = c[1],
        b = c[2];
      var above = i >= w ? cells[i - w] : MAT.BEDROCK;
      var openAbove = above === MAT.EMPTY || above === MAT.WATER;

      if (m === MAT.WATER) {
        // Deeper fluid reads darker and richer, so a tall column looks like
        // it weighs something; the top row catches a bright surface line.
        var h = head[i] > 30 ? 30 : head[i];
        r -= h * 0.55;
        g -= h * 0.25;
        b -= h * 0.2;
        if (above === MAT.EMPTY) {
          r += 55;
          g += 40;
          b += 36;
        }
      } else if (m === MAT.COLLECTOR) {
        r += shimmer;
        g += shimmer;
        b += shimmer * 0.5;
      } else if (SOLID[m]) {
        r += tint[i];
        g += tint[i];
        b += tint[i];
        // Rim light on any surface facing open space, plus a softer second
        // row, which is what turns flat bands into layers with a top face.
        if (openAbove) {
          r += 26;
          g += 24;
          b += 20;
        } else if (i >= 2 * w) {
          var a2 = cells[i - 2 * w];
          if (a2 === MAT.EMPTY || a2 === MAT.WATER) {
            r += 10;
            g += 9;
            b += 8;
          }
        }
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

    var sx = display.width / GRID_W,
      sy = display.height / GRID_H;

    drawTargets(sx, sy);
    drawChunks(sx, sy);
    drawCursor(sx, sy);
  }

  // The goal and the hazards, marked on the terrain itself — the single most
  // useful thing to make legible, since the whole puzzle is "which hole does
  // the payload fall into".
  function drawTargets(sx, sy) {
    var g = sim.geometry;
    if (!g) return;
    var pulse = 0.55 + Math.sin(tick * 0.06) * 0.45;

    // Collector: warm glow, bracket, and a label.
    var cx = ((g.basinL + g.basinR) / 2) * sx;
    var top = g.floorY * sy;
    var halfW = ((g.basinR - g.basinL) / 2) * sx;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var grad = ctx.createRadialGradient(cx, top, 0, cx, top, halfW * 2.6);
    grad.addColorStop(0, 'rgba(246,232,160,' + (0.3 + pulse * 0.22) + ')');
    grad.addColorStop(1, 'rgba(246,232,160,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - halfW * 2.6, top - halfW * 2.6, halfW * 5.2, halfW * 5.2);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(246,232,160,' + (0.5 + pulse * 0.5) + ')';
    ctx.lineWidth = 2;
    var bt = top - 6;
    ctx.beginPath();
    ctx.moveTo(cx - halfW, bt + 7);
    ctx.lineTo(cx - halfW, bt);
    ctx.lineTo(cx + halfW, bt);
    ctx.lineTo(cx + halfW, bt + 7);
    ctx.stroke();

    // A chevron bobbing above the basin, pointing down into it.
    var chevY = bt - 16 - pulse * 4;
    ctx.beginPath();
    ctx.moveTo(cx - 7, chevY);
    ctx.lineTo(cx, chevY + 7);
    ctx.lineTo(cx + 7, chevY);
    ctx.stroke();

    ctx.fillStyle = 'rgba(246,232,160,0.92)';
    ctx.font = '600 10px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('COLLECTOR', cx, chevY - 7);
    ctx.restore();

    // Drains: the failure mouths, marked so losing the payload never feels
    // arbitrary.
    if (!g.drains) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(217,139,106,0.75)';
    ctx.fillStyle = 'rgba(217,139,106,0.75)';
    ctx.lineWidth = 2;
    ctx.font = '600 8px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    for (var k = 0; k < g.drains.length; k++) {
      var dl = g.drains[k][0] * sx,
        dr = (g.drains[k][1] + 1) * sx;
      var dcx = (dl + dr) / 2;
      ctx.beginPath();
      ctx.moveTo(dl, top - 1);
      ctx.lineTo(dr, top - 1);
      ctx.stroke();
      ctx.fillText('DRAIN', dcx, top - 6);
    }
    ctx.restore();
  }

  function drawChunks(sx, sy) {
    var outs = bodies.outlines();
    for (var k = 0; k < outs.length; k++) {
      var pts = outs[k];
      ctx.beginPath();
      ctx.moveTo(pts[0][0] * sx, pts[0][1] * sy);
      for (var j = 1; j < pts.length; j++)
        ctx.lineTo(pts[j][0] * sx, pts[j][1] * sy);
      ctx.closePath();
      ctx.fillStyle = '#55646f';
      ctx.fill();
      // Lit top-left edge so tumbling reads as rotation, not sliding.
      ctx.strokeStyle = '#8296a3';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Show the tool's reach while digging, so the cut lands where you meant it.
  function drawCursor(sx, sy) {
    if (!cursor) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cursor.x * sx, cursor.y * sy, DIG_RADIUS * sx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /* ------------------------------------------------------------------- */

  function updateHud(s, ceiling) {
    el.depth.textContent = s.depth.toFixed(0) + ' m';
    el.pressure.textContent = s.pressure.toFixed(0);
    el.collected.textContent = s.collectionPct.toFixed(0) + '%';
    el.bar.style.width = Math.min(100, s.collectionPct) + '%';
    el.ceiling.style.width = Math.min(100, ceiling) + '%';
    el.held.textContent = s.heldBySand;
    el.lost.textContent = s.lost;
    el.inplay.textContent = s.inPlay;
    el.chunks.textContent = bodies.count();
  }

  function setBanner(kind, html) {
    el.banner.className = 'banner ' + kind;
    el.banner.innerHTML = html;
    var again = document.getElementById('again');
    if (again) again.addEventListener('click', function () { reset(); });
  }

  function restartBtn() {
    return ' <button id="again" class="again">Restart level</button>';
  }

  function checkOutcome(s, ceiling) {
    if (outcome === 'final') return;

    var pct = s.collectionPct;
    var tier = tierFor(pct);

    /*
     * Passing does not end the run. Once 85% is banked the level is won, but
     * fluid is still arriving and the grade can still climb — so the banner
     * shows the tier live and names the next one, which is the whole reason
     * to replay a level you have already cleared.
     */
    if (tier) {
      passed = true;
      var next = nextTier(pct);
      setBanner(
        'win',
        'CLEAR ' + stars(tier.stars) + ' — ' + pct.toFixed(0) + '% collected' +
          (next
            ? '<span class="hint">next: ' + next.stars + '★ at ' + next.at + '%</span>'
            : '')
      );
    } else if (ceiling < WIN_PCT) {
      /*
       * The honest "you are stuck" test. Fluid that has run out of a drain is
       * gone for good, so the best score still reachable is everything not yet
       * lost. Once that ceiling drops below passing the level cannot be won,
       * whatever happens next — say so now rather than making someone watch a
       * doomed level finish draining.
       */
      outcome = 'final';
      setBanner(
        'fail',
        // Floor, not round: a ceiling of 84.6 must not print as "85%" when
        // 85% is exactly the bar it just failed to clear.
        'UNWINNABLE — ' + s.lost + ' units lost to the drains, capping this run at ' +
          Math.floor(ceiling) + '%.' + restartBtn()
      );
      return;
    }

    // A level is otherwise over when nothing has changed for a while; a few
    // units cling in corners forever, so waiting for zero never fires.
    var sig = s.collected + '/' + s.inPlay + '/' + s.heldBySand + '/' + s.lost;
    stall = sig === prev ? stall + 1 : 0;
    prev = sig;
    if (stall < STALL_FRAMES || digging) return;

    outcome = 'final';
    if (passed) {
      var t = tierFor(pct);
      setBanner(
        'win',
        'FINAL ' + stars(t.stars) + ' — ' + pct.toFixed(0) + '% collected' + restartBtn()
      );
    } else {
      setBanner(
        'fail',
        'STUCK — ' + pct.toFixed(0) + '% collected, nothing still moving.' + restartBtn()
      );
    }
  }

  function frame() {
    tick++;
    if (!introOpen()) {
      for (var i = 0; i < STEPS_PER_FRAME; i++) {
        bodies.step(1 / 60);
        sim.step();
      }
    }
    var s = sim.stats();
    // Best score still reachable: everything the drains have not taken.
    var ceiling = s.released
      ? ((s.collected + s.inPlay + s.heldBySand) / s.released) * 100
      : 100;
    draw();
    updateHud(s, ceiling);
    if (!introOpen()) checkOutcome(s, ceiling);
    requestAnimationFrame(frame);
  }

  /* --- intro ----------------------------------------------------------- */

  function introOpen() {
    return !el.intro.hidden;
  }
  function showIntro() {
    el.intro.hidden = false;
  }
  function hideIntro() {
    el.intro.hidden = true;
  }

  document.getElementById('start').addEventListener('click', hideIntro);
  document.getElementById('help').addEventListener('click', showIntro);

  /* --- input ----------------------------------------------------------- */

  function toGrid(ev) {
    var r = display.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * GRID_W,
      y: ((ev.clientY - r.top) / r.height) * GRID_H
    };
  }

  // Cutting into fractured rock hands whole chunks to the physics world.
  function shatter(r) {
    if (r.shattered.length) bodies.shatterAll(r.shattered);
    if (r.removed || r.shattered.length) bodies.markTerrainDirty();
  }

  display.addEventListener('pointerdown', function (ev) {
    if (introOpen()) return;
    ev.preventDefault();
    display.setPointerCapture(ev.pointerId);
    digging = true;
    last = cursor = toGrid(ev);
    shatter(sim.dig(last.x, last.y, DIG_RADIUS));
  });

  display.addEventListener('pointermove', function (ev) {
    if (introOpen()) return;
    var p = toGrid(ev);
    cursor = p;
    if (!digging) return;
    ev.preventDefault();
    // Interpolate, so a fast swipe cuts a continuous tunnel.
    shatter(sim.digLine(last.x, last.y, p.x, p.y, DIG_RADIUS));
    last = p;
  });

  function endDig(ev) {
    if (!digging) return;
    digging = false;
    last = null;
    // Touch has no hover, so a ring left at the last touch point just sits
    // there looking like part of the level. Mouse re-shows it on the next move.
    cursor = null;
    if (ev.pointerId !== undefined && display.hasPointerCapture(ev.pointerId))
      display.releasePointerCapture(ev.pointerId);
  }
  display.addEventListener('pointerup', endDig);
  display.addEventListener('pointercancel', endDig);
  display.addEventListener('pointerleave', function () {
    if (!digging) cursor = null;
  });

  document.getElementById('reset').addEventListener('click', function () {
    reset();
  });
  document.getElementById('next').addEventListener('click', function () {
    reset(seed + 1);
  });
  document.getElementById('solve').addEventListener('click', function () {
    var g = sim.geometry;
    shatter(
      sim.digLine(
        g.routeX,
        g.sealTop - 1,
        g.routeX,
        g.floorY - 1,
        Math.max(2, Math.round(sim.w * 0.03))
      )
    );
  });

  /*
   * Experimental mode. Levels are generated from a seed rather than authored,
   * so "go to level N" is just "build with seed N" — every level exists
   * already and none of them are gated. Kept behind a toggle because jumping
   * around and auto-solving are debugging tools, not the game.
   */
  var lab = document.getElementById('lab');
  document.getElementById('labtoggle').addEventListener('click', function () {
    lab.hidden = !lab.hidden;
    this.setAttribute('aria-expanded', String(!lab.hidden));
  });

  function goToLevel() {
    var n = parseInt(document.getElementById('levelnum').value, 10);
    if (!isFinite(n) || n < 1) n = 1;
    reset(n);
  }
  document.getElementById('go').addEventListener('click', goToLevel);
  document.getElementById('levelnum').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') goToLevel();
  });

  reset(1);
  requestAnimationFrame(frame);
})();
