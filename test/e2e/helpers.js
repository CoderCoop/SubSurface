'use strict';

/*
 * Shared rig for the browser tests.
 *
 * These run against a real Chromium over a real HTTP server, because the two
 * things that have actually broken in this game — a service worker serving a
 * stale script, and a button with no handler — are both invisible to a unit
 * test. Neither the simulation nor the DOM is mocked.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..', 'docs');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8'
};

// A service worker only registers over http(s), so file:// will not do.
//
// `overrides` lets a test change what a path serves without touching the repo.
// It has to happen server-side: requests a service worker makes on the page's
// behalf never pass through Playwright's page routing, so intercepting in the
// browser would silently test nothing.
function serve() {
  const overrides = new Map();
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';

      if (overrides.has(p)) {
        res.writeHead(200, {
          'Content-Type': TYPES[path.extname(p)] || 'text/plain',
          'Cache-Control': 'no-store'
        });
        res.end(overrides.get(p));
        return;
      }

      const file = path.join(ROOT, p);
      // Keep the server inside docs/ even if a test asks for something odd.
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port, overrides })
    );
  });
}

function launch() {
  // Honour an explicit browser path so the suite runs in sandboxes that ship
  // Chromium separately from the npm package.
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  return chromium.launch(executablePath ? { executablePath } : {});
}

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

// Collect anything the page complains about; a silent console is part of what
// these tests assert.
function watch(page, errors) {
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
}

/*
 * Drag a straight line down the canvas, in fractions of its box.
 *
 * The whole stroke goes through a single interpolated move rather than a loop
 * with waits between steps. That matters for repeatability: the simulation
 * keeps running while a drag is in progress, so any real time spent mid-stroke
 * lets sand slump and fluid move before the rest of the cut lands. A loop with
 * 8ms waits carved a measurably different channel on a slow CI runner than on
 * a laptop, and the level then played out differently. One move keeps the cut
 * close to instantaneous, so the same drag means the same channel.
 */
async function digDown(page, xFrac, fromY = 0.3, toY = 0.93) {
  const box = await page.locator('#view').boundingBox();
  const x = box.x + box.width * xFrac;
  const y = (f) => box.y + box.height * f;
  await page.mouse.move(x, y(fromY));
  await page.mouse.down();
  await page.mouse.move(x, y(toY), { steps: 30 });
  await page.mouse.up();
}

const text = (page, sel) => page.locator(sel).textContent();

// Poll until the predicate holds, so tests wait on the simulation reaching a
// state rather than on a fixed sleep that is either flaky or slow.
//
// The budget is generous on purpose. These wait on a real-time simulation
// draining a reservoir, and a CI runner is markedly slower than a laptop — 45s
// was enough locally and not enough on a runner, which is the classic way an
// end-to-end suite becomes flaky. Waiting longer costs nothing when the
// predicate holds, since it returns as soon as it does.
async function until(page, fn, { timeout = 120000, interval = 400 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeout) return false;
    await page.waitForTimeout(interval);
  }
}

module.exports = { serve, launch, watch, digDown, text, until, PHONE, ROOT };
