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

  /*
   * Bloom source. Written in the same pass as the cell buffer, but carrying
   * only the things that emit — fluid and crystal — with everything else left
   * transparent. Blooming the composed frame instead would haze the clay and
   * wash the whole cross-section out; this way only light blooms.
   *
   * The blur is the browser's own smoothing when a grid-sized buffer is
   * scaled up to the canvas, which costs one drawImage rather than a kernel.
   */
  var glowBuf = document.createElement('canvas');
  glowBuf.width = GRID_W;
  glowBuf.height = GRID_H;
  var gctx = glowBuf.getContext('2d');
  var glowImg = gctx.createImageData(GRID_W, GRID_H);
  var vignette = null;

  var sim, bodies, seed = 1, outcome = null, digging = false, last = null;
  var stall = 0, prev = '', tick = 0, cursor = null, passed = false;
  // Elapsed play time for the level: accrues only while the level is live,
  // so it never counts the title screen or a finished run.
  var elapsed = 0, lastFrame = 0, clearTime = null;

  var el = {
    time: document.getElementById('time'),
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

  /* ---------------------------------------------------------------------
   * Particles
   *
   * A fixed pool in typed arrays, alive entries packed at the front and
   * removed by swapping the last one down. Nothing is allocated while playing,
   * so the effects never hand the collector a reason to stutter mid-drag.
   *
   * Positions are in grid space, not pixels, so they line up with the
   * simulation at any canvas size.
   * ------------------------------------------------------------------- */
  var P_MAX = 260;
  var pX = new Float32Array(P_MAX),
    pY = new Float32Array(P_MAX),
    pVX = new Float32Array(P_MAX),
    pVY = new Float32Array(P_MAX),
    pLife = new Float32Array(P_MAX),
    pFull = new Float32Array(P_MAX),
    pSize = new Float32Array(P_MAX),
    pGrav = new Float32Array(P_MAX),
    pR = new Uint8Array(P_MAX),
    pG = new Uint8Array(P_MAX),
    pB = new Uint8Array(P_MAX);
  var pCount = 0;
  var lastCollected = 0;

  function emit(x, y, n, o) {
    for (var k = 0; k < n && pCount < P_MAX; k++) {
      var i = pCount++;
      var a = Math.random() * Math.PI * 2;
      var sp = o.speed * (0.35 + Math.random() * 0.65);
      pX[i] = x + (Math.random() - 0.5) * (o.spread || 1);
      pY[i] = y + (Math.random() - 0.5) * (o.spread || 1);
      pVX[i] = Math.cos(a) * sp;
      pVY[i] = Math.sin(a) * sp - (o.lift || 0);
      pFull[i] = pLife[i] = o.life * (0.6 + Math.random() * 0.7);
      pSize[i] = o.size * (0.6 + Math.random() * 0.8);
      pGrav[i] = o.grav === undefined ? 26 : o.grav;
      var c = o.color;
      var j = (Math.random() - 0.5) * 26;
      pR[i] = Math.max(0, Math.min(255, c[0] + j));
      pG[i] = Math.max(0, Math.min(255, c[1] + j));
      pB[i] = Math.max(0, Math.min(255, c[2] + j));
    }
  }

  function stepParticles(dt) {
    for (var i = 0; i < pCount; i++) {
      pLife[i] -= dt;
      if (pLife[i] <= 0) {
        // Swap the last live particle down and re-test this slot.
        var l = --pCount;
        pX[i] = pX[l]; pY[i] = pY[l]; pVX[i] = pVX[l]; pVY[i] = pVY[l];
        pLife[i] = pLife[l]; pFull[i] = pFull[l]; pSize[i] = pSize[l];
        pGrav[i] = pGrav[l]; pR[i] = pR[l]; pG[i] = pG[l]; pB[i] = pB[l];
        i--;
        continue;
      }
      pVY[i] += pGrav[i] * dt;
      pVX[i] *= 0.985;
      pX[i] += pVX[i] * dt;
      pY[i] += pVY[i] * dt;
    }
  }

  function drawParticles(sx, sy) {
    for (var i = 0; i < pCount; i++) {
      var t = pLife[i] / pFull[i];
      ctx.fillStyle =
        'rgba(' + pR[i] + ',' + pG[i] + ',' + pB[i] + ',' + (t * 0.85).toFixed(3) + ')';
      var s = pSize[i] * sx * (0.4 + t * 0.6);
      ctx.fillRect(pX[i] * sx - s / 2, pY[i] * sy - s / 2, s, s);
    }
  }

  var DUST = {};
  DUST[MAT.CLAY] = [150, 92, 66];
  DUST[MAT.SAND] = [211, 176, 124];
  DUST[MAT.WETSAND] = [130, 100, 66];
  DUST[MAT.FRACTURED] = [120, 138, 152];

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
    elapsed = 0;
    clearTime = null;
    lastFrame = 0;
    lastCollected = 0;
    pCount = 0;
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
  function draw(s) {
    var d = img.data,
      gd = glowImg.data,
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
        /*
         * Lighting the ground. A single top-facing rim light made the bands
         * look like flat stripes with a highlight; what gives a cross-section
         * depth is knowing which cells are exposed and which are buried.
         *
         * Key light from above, a weaker bounce from the sides, and occlusion
         * for anything with material on all four sides. Every term is one
         * array read, in the pass that already exists.
         */
        if (openAbove) {
          r += 30;
          g += 28;
          b += 23;
        } else {
          if (i >= 2 * w) {
            var a2 = cells[i - 2 * w];
            if (a2 === MAT.EMPTY || a2 === MAT.WATER) {
              r += 12;
              g += 11;
              b += 9;
            }
          }
          var lx = i % w === 0 ? m : cells[i - 1];
          var rx = (i + 1) % w === 0 ? m : cells[i + 1];
          var openSide =
            lx === MAT.EMPTY || lx === MAT.WATER || rx === MAT.EMPTY || rx === MAT.WATER;
          if (openSide) {
            // Grazing bounce on a wall face — enough to catch the eye without
            // competing with the key light overhead.
            r += 9;
            g += 8;
            b += 7;
          } else {
            var bl = i + w < cells.length ? cells[i + w] : m;
            if (bl !== MAT.EMPTY && bl !== MAT.WATER) {
              // Fully enclosed: sink it back so open faces read as surfaces.
              r -= 11;
              g -= 10;
              b -= 8;
            }
          }
        }
      }

      var o = i * 4;
      var rr = r < 0 ? 0 : r > 255 ? 255 : r;
      var gg = g < 0 ? 0 : g > 255 ? 255 : g;
      var bb = b < 0 ? 0 : b > 255 ? 255 : b;
      d[o] = rr;
      d[o + 1] = gg;
      d[o + 2] = bb;
      d[o + 3] = 255;

      // Only emitters go into the bloom buffer.
      var lit = m === MAT.WATER || m === MAT.COLLECTOR;
      gd[o] = lit ? rr : 0;
      gd[o + 1] = lit ? gg : 0;
      gd[o + 2] = lit ? bb : 0;
      gd[o + 3] = lit ? 255 : 0;
    }
    bctx.putImageData(img, 0, 0);
    gctx.putImageData(glowImg, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, display.width, display.height);
    ctx.drawImage(buf, 0, 0, display.width, display.height);

    var sx = display.width / GRID_W,
      sy = display.height / GRID_H;

    drawTargets(sx, sy, s);
    drawChunks(sx, sy);
    drawParticles(sx, sy);
    drawBloom();
    drawVignette();
    // The cursor sits above the grade, so the tool stays readable over glow.
    drawCursor(sx, sy);
  }

  // Two additive passes at different scales: a tight one for the core and a
  // wide soft one for the halo, which reads far better than a single blur.
  function drawBloom() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.34;
    ctx.drawImage(glowBuf, 0, 0, display.width, display.height);
    ctx.globalAlpha = 0.2;
    var o = display.width * 0.035;
    ctx.drawImage(
      glowBuf,
      -o,
      -o,
      display.width + o * 2,
      display.height + o * 2
    );
    ctx.restore();
  }

  // Built once and reused; a gradient object per frame is pure waste.
  function drawVignette() {
    if (!vignette) {
      var cx = display.width / 2,
        cy = display.height / 2;
      vignette = ctx.createRadialGradient(
        cx, cy, Math.min(cx, cy) * 0.55,
        cx, cy, Math.max(cx, cy) * 1.12
      );
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
    }
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, display.width, display.height);
  }

  /*
   * The goal and the hazards.
   *
   * These used to be labelled COLLECTOR and DRAIN in text, which is a caption
   * over the world rather than the world reading clearly. They are now told
   * apart by three things at once, none of which need reading:
   *
   *   shape   the collector is spikes pointing UP, receiving; a drain is teeth
   *           pointing DOWN, swallowing
   *   light   the collector emits — a warm glow that brightens as it fills;
   *           a drain emits nothing and fades to black
   *   motion  motes drift UP out of the crystal; streaks fall DOWN the drain
   *
   * Up/warm/lit against down/cold/dark is legible at a glance and in
   * peripheral vision, which a word never is.
   */
  function drawTargets(sx, sy, s) {
    var g = sim.geometry;
    if (!g) return;
    var top = g.floorY * sy;
    var bot = Math.min(sim.h, g.basinBot + 1) * sy;
    var fill = Math.min(1, (s.collectionPct || 0) / 100);

    drawCollector(sx, sy, top, bot, fill);
    drawDrains(sx, sy, top, bot);
  }

  function drawCollector(sx, sy, top, bot, fill) {
    var g = sim.geometry;
    var l = g.basinL * sx,
      r = (g.basinR + 1) * sx;
    var cx = (l + r) / 2,
      w = r - l,
      h = bot - top;
    var breathe = 0.6 + Math.sin(tick * 0.04) * 0.4;

    // Light spilling upward out of the mouth. Brightens as it fills, so a
    // level nearing its target is visible from across the screen.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var reach = w * (1.3 + fill * 1.2);
    var glow = ctx.createRadialGradient(cx, top, 0, cx, top, reach);
    var a = 0.16 + fill * 0.34 + breathe * 0.08;
    glow.addColorStop(0, 'rgba(246,232,160,' + a.toFixed(3) + ')');
    glow.addColorStop(0.5, 'rgba(246,220,130,' + (a * 0.35).toFixed(3) + ')');
    glow.addColorStop(1, 'rgba(246,232,160,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(cx - reach, top - reach, reach * 2, reach * 2);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(l, top, w, h);
    ctx.clip();

    // Collected fluid pooling in the trough, rising with the score.
    if (fill > 0) {
      var level = bot - h * fill;
      ctx.fillStyle = 'rgba(47,212,196,0.5)';
      ctx.fillRect(l, level, w, bot - level);
      ctx.fillStyle = 'rgba(157,246,236,0.9)';
      ctx.fillRect(l, level, w, 1.5);
    }

    // Crystal spikes, pointing up. Uneven on purpose — a regular comb reads as
    // machinery, and this is meant to be something grown.
    var n = 5;
    for (var i = 0; i < n; i++) {
      var x0 = l + (w * i) / n,
        x1 = l + (w * (i + 1)) / n;
      var peak = top - h * (0.34 + 0.3 * Math.abs(Math.sin(i * 2.1)));
      var grad = ctx.createLinearGradient(0, peak, 0, bot);
      grad.addColorStop(0, 'rgba(255,247,207,0.95)');
      grad.addColorStop(1, 'rgba(214,190,110,0.75)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x0, bot);
      ctx.lineTo((x0 + x1) / 2, peak);
      ctx.lineTo(x1, bot);
      ctx.closePath();
      ctx.fill();
      // A lit facet down one side gives each spike a direction.
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.beginPath();
      ctx.moveTo((x0 + x1) / 2, peak);
      ctx.lineTo(x1, bot);
      ctx.lineTo((x0 + x1) / 2 + (x1 - x0) * 0.16, bot);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Motes rising out of the mouth — the clearest "this is where it goes"
    // signal, and it costs six moving dots.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var m = 0; m < 6; m++) {
      var seed = m * 97.3;
      var t = ((tick * 0.006 + m / 6) % 1);
      var my = top - t * h * 2.2;
      var mx = cx + Math.sin(seed + t * 3.4) * w * 0.36;
      var fade = (1 - t) * (0.35 + fill * 0.5);
      ctx.fillStyle = 'rgba(255,244,190,' + fade.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(mx, my, 1.6 - t, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawDrains(sx, sy, top, bot) {
    var g = sim.geometry;
    if (!g.drains) return;
    var h = bot - top;

    for (var k = 0; k < g.drains.length; k++) {
      var l = g.drains[k][0] * sx,
        r = (g.drains[k][1] + 1) * sx;
      var w = r - l;

      ctx.save();
      ctx.beginPath();
      ctx.rect(l, top, w, h);
      ctx.clip();

      // A throat that goes properly black. No glow anywhere — this is the one
      // thing on screen that gives nothing back.
      var v = ctx.createLinearGradient(0, top, 0, bot);
      v.addColorStop(0, 'rgba(24,18,14,0.9)');
      v.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = v;
      ctx.fillRect(l, top, w, h);

      // Streaks falling away down the shaft: motion pointing the opposite way
      // to the collector's motes.
      for (var s = 0; s < 4; s++) {
        var t = ((tick * 0.02 + s / 4) % 1);
        var sy2 = top + t * h;
        ctx.fillStyle = 'rgba(217,139,106,' + (0.3 * (1 - t)).toFixed(3) + ')';
        ctx.fillRect(l + w * (0.18 + 0.2 * s), sy2, 1.5, h * 0.22);
      }

      // Teeth along the lip, pointing down.
      var teeth = 4;
      ctx.fillStyle = 'rgba(150,88,66,0.95)';
      for (var i = 0; i < teeth; i++) {
        var x0 = l + (w * i) / teeth,
          x1 = l + (w * (i + 1)) / teeth;
        ctx.beginPath();
        ctx.moveTo(x0, top);
        ctx.lineTo(x1, top);
        ctx.lineTo((x0 + x1) / 2, top + h * 0.3);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      // A thin warm rim so the mouth still reads on a dark background.
      ctx.strokeStyle = 'rgba(196,110,80,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(l, top);
      ctx.lineTo(r, top);
      ctx.stroke();
    }
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
    el.time.textContent = clock(clearTime === null ? elapsed : clearTime);
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

  var lastBanner = '';

  function setBanner(kind, html) {
    // The clear banner updates every frame as the grade climbs; rewriting the
    // DOM each time would blow away a button mid-tap.
    if (html === lastBanner) return;
    lastBanner = html;
    el.banner.className = 'banner ' + kind;
    el.banner.innerHTML = html;

    var again = document.getElementById('again');
    if (again) again.addEventListener('click', function () { reset(); });
    var onward = document.getElementById('onward');
    if (onward) onward.addEventListener('click', function () { reset(seed + 1); });
  }

  function restartBtn() {
    return ' <button id="again" class="again">Restart level</button>';
  }

  // Offered the moment the level is passed, so clearing it is also the cue to
  // move on — without ending a run that could still climb to a better grade.
  function onwardBtn() {
    return ' <button id="onward" class="again onward">Next level →</button>';
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
      if (!passed) {
        passed = true;
        clearTime = elapsed; // the time that counts is time to clear
      }
      var next = nextTier(pct);
      setBanner(
        'win',
        'CLEAR ' + stars(tier.stars) + ' — ' + pct.toFixed(0) + '% in ' +
          clock(clearTime) + onwardBtn() +
          (next
            ? '<span class="hint">still filling — ' + next.stars + '★ at ' + next.at + '%</span>'
            : '<span class="hint">perfect run</span>')
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
        'FINAL ' + stars(t.stars) + ' — ' + pct.toFixed(0) + '% in ' +
          clock(clearTime) + onwardBtn() + restartBtn()
      );
    } else {
      setBanner(
        'fail',
        'STUCK — ' + pct.toFixed(0) + '% collected, nothing still moving.' + restartBtn()
      );
    }
  }

  function clock(sec) {
    var m = Math.floor(sec / 60);
    var r = Math.floor(sec % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function frame(now) {
    tick++;
    var dt = lastFrame ? (now - lastFrame) / 1000 : 0;
    lastFrame = now;
    // Cap the delta so a backgrounded tab does not bank minutes at once.
    if (dt > 0.25) dt = 0.25;
    if (!introOpen() && outcome !== 'final') elapsed += dt;

    if (!introOpen()) {
      for (var i = 0; i < STEPS_PER_FRAME; i++) {
        bodies.step(1 / 60);
        sim.step();
      }
    }
    stepParticles(dt);
    var s = sim.stats();
    // Best score still reachable: everything the drains have not taken.
    var ceiling = s.released
      ? ((s.collected + s.inPlay + s.heldBySand) / s.released) * 100
      : 100;
    // Splash on arrival: the moment fluid is banked is the moment worth
    // marking, and the counter moving is exactly that moment.
    var gained = s.collected - lastCollected;
    lastCollected = s.collected;
    if (gained > 0 && sim.geometry) {
      var gm = sim.geometry;
      emit(
        (gm.basinL + gm.basinR) / 2,
        gm.floorY,
        Math.min(4, 1 + (gained >> 3)),
        { color: [140, 244, 232], speed: 9, life: 0.55, size: 0.9,
          spread: gm.basinR - gm.basinL, lift: 13, grav: 30 }
      );
    }

    draw(s);
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

  /* --- install offer -------------------------------------------------- */

  var installBtn = document.getElementById('install');
  var iosHint = document.getElementById('ioshint');
  var deferredPrompt = null;

  function isInstalled() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  // Chromium-family browsers offer this event; taking it lets us put the
  // install where someone is already looking rather than in a menu.
  window.addEventListener('beforeinstallprompt', function (ev) {
    ev.preventDefault();
    deferredPrompt = ev;
    if (!isInstalled()) installBtn.hidden = false;
  });

  installBtn.addEventListener('click', function () {
    if (!deferredPrompt) return;
    var p = deferredPrompt;
    deferredPrompt = null;
    installBtn.hidden = true;
    p.prompt();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    installBtn.hidden = true;
    iosHint.hidden = true;
  });

  // iOS has no install event and no install API, so the only honest thing is
  // to say where the button lives. Shown only on iOS, and only when the app
  // is not already running installed.
  (function () {
    var ua = navigator.userAgent;
    var iOS = /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (iOS && !isInstalled()) iosHint.hidden = false;
  })();

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

  // Spray from the cut, tinted by whatever the shovel actually took, so
  // digging clay feels different from digging gravel without any sound yet.
  function digDust(x, y, r) {
    if (!r.removed && !r.shattered.length) return;
    var mat = r.grit ? MAT.SAND : MAT.CLAY;
    if (r.shattered.length) mat = MAT.FRACTURED;
    emit(x, y, r.shattered.length ? 7 : 3, {
      color: DUST[mat],
      speed: r.shattered.length ? 20 : 11,
      life: 0.5,
      size: 1.1,
      spread: DIG_RADIUS,
      lift: 4
    });
  }

  display.addEventListener('pointerdown', function (ev) {
    if (introOpen()) return;
    ev.preventDefault();
    display.setPointerCapture(ev.pointerId);
    digging = true;
    last = cursor = toGrid(ev);
    var r0 = sim.dig(last.x, last.y, DIG_RADIUS);
    shatter(r0);
    digDust(last.x, last.y, r0);
  });

  display.addEventListener('pointermove', function (ev) {
    if (introOpen()) return;
    var p = toGrid(ev);
    cursor = p;
    if (!digging) return;
    ev.preventDefault();
    // Interpolate, so a fast swipe cuts a continuous tunnel.
    var r1 = sim.digLine(last.x, last.y, p.x, p.y, DIG_RADIUS);
    shatter(r1);
    digDust(p.x, p.y, r1);
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
