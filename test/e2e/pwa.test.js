'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { serve, launch, watch, digDown, text, until, PHONE } = require('./helpers');

let ctxServer, browser, base, overrides;

test.before(async () => {
  const s = await serve();
  ctxServer = s.server;
  overrides = s.overrides;
  base = `http://127.0.0.1:${s.port}/play/`;
  browser = await launch();
});

test.after(async () => {
  if (browser) await browser.close();
  if (ctxServer) ctxServer.close();
});

function ctxOpts(extra) {
  return Object.assign({ serviceWorkers: 'allow' }, PHONE, extra);
}

async function openReady(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  watch(page, errors);
  await page.goto(base, { waitUntil: 'load' });
  await until(page, () =>
    page.evaluate(() => !!navigator.serviceWorker.controller)
  );
  return { page, errors };
}

test('the service worker takes control and precaches the whole shell', async () => {
  const ctx = await browser.newContext(ctxOpts());
  const { page, errors } = await openReady(ctx);

  const state = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const names = await caches.keys();
    const cache = await caches.open(names[0]);
    const keys = await cache.keys();
    return {
      controlled: !!navigator.serviceWorker.controller,
      scope: reg && reg.scope,
      names,
      cached: keys.map((r) => new URL(r.url).pathname.replace(/^.*\/play\//, '')).sort()
    };
  });

  assert.ok(state.controlled, 'the worker should be controlling the page');
  assert.match(state.scope, /\/play\/$/, 'scope must be the app directory');
  for (const need of ['app.js', 'sim.js', 'bodies.js', 'index.html', 'vendor/planck.min.js']) {
    assert.ok(state.cached.includes(need), `${need} should be precached, got ${state.cached}`);
  }
  assert.deepStrictEqual(errors, []);
  await ctx.close();
});

test('the app loads and plays with the network cut', async () => {
  const ctx = await browser.newContext(ctxOpts());
  const { page } = await openReady(ctx);
  await page.waitForTimeout(600);

  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);

  assert.strictEqual(await page.evaluate(() => navigator.onLine), false);
  const loaded = await page.evaluate(() => ({
    planck: typeof window.planck,
    sim: typeof window.Subsurface,
    bodies: typeof window.SubsurfaceBodies
  }));
  assert.deepStrictEqual(loaded, { planck: 'object', sim: 'object', bodies: 'object' });

  // Offline is only meaningful if it is actually playable offline.
  await page.locator('#start').tap();
  await page.waitForTimeout(200);
  await digDown(page, 0.78);
  const progressed = await until(page, async () =>
    parseInt(await text(page, '#collected'), 10) > 0
  );
  assert.ok(progressed, 'the fluid should be collecting while offline');
  await ctx.close();
});

/*
 * The regression that shipped.
 *
 * Navigations were network-first while subresources were cache-first, so a new
 * index.html could be paired with a stale app.js from a previous cache. The
 * markup had a Start button the old code never bound, and the game loaded with
 * a dead button. This plants exactly that trap — a poisoned cache entry for
 * app.js under the current cache name — and asserts the worker serves the real
 * script anyway.
 */
test('a stale cached script never wins over the deployed one', async () => {
  const ctx = await browser.newContext(ctxOpts());
  const { page } = await openReady(ctx);

  const poisoned = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names[0]);
    const url = new URL('app.js', location.href).href;
    await cache.put(
      url,
      new Response('window.__STALE__ = true;', {
        status: 200,
        headers: { 'Content-Type': 'text/javascript' }
      })
    );
    const check = await cache.match(url);
    return (await check.text()).includes('__STALE__');
  });
  assert.ok(poisoned, 'the test needs the cache actually poisoned to be meaningful');

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);

  const stale = await page.evaluate(() => window.__STALE__ === true);
  assert.strictEqual(stale, false, 'the stale script was served instead of the deployed one');

  // And the button that the real bug killed still works.
  assert.ok(await page.locator('#intro').isVisible());
  await page.locator('#start').tap();
  await page.waitForTimeout(300);
  assert.ok(
    await page.locator('#intro').isHidden(),
    'Start digging must work after a cache poisoning attempt'
  );
  await ctx.close();
});

test('an updated build reaches a returning player', async () => {
  // Same shape as a redeploy: the worker is already installed and holding a
  // cached app.js, then the server starts serving different bytes. The next
  // load has to show the new ones — this is the failure that shipped.
  const ctx = await browser.newContext(ctxOpts());
  const { page } = await openReady(ctx);
  await page.waitForTimeout(400);

  overrides.set('/play/app.js', 'window.__NEWBUILD__ = true;');
  try {
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(800);
    assert.strictEqual(
      await page.evaluate(() => window.__NEWBUILD__ === true),
      true,
      'a returning player should get the newly deployed script, not the cached one'
    );
  } finally {
    overrides.delete('/play/app.js');
  }
  await ctx.close();
});

test('the manifest is installable — relative scope, required icons', async () => {
  const ctx = await browser.newContext(ctxOpts());
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'load' });

  const m = await page.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]').href;
    return (await fetch(href)).json();
  });

  assert.strictEqual(m.display, 'standalone');
  assert.strictEqual(m.start_url, '.', 'must be relative — served from a subdirectory');
  assert.strictEqual(m.scope, '.');
  assert.strictEqual(m.orientation, 'portrait');
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(m.icons.some((i) => (i.purpose || '').includes('maskable')));

  // Every icon the manifest promises has to actually be servable.
  for (const icon of m.icons) {
    const ok = await page.evaluate(
      (src) => fetch(new URL(src, location.href)).then((r) => r.ok),
      icon.src
    );
    assert.ok(ok, `icon ${icon.src} is referenced but not served`);
  }
  await ctx.close();
});

test('the title screen offers an install path', async () => {
  const ctx = await browser.newContext(ctxOpts());
  const page = await ctx.newPage();
  const errors = [];
  watch(page, errors);
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(300);

  // Headless Chromium does not fire beforeinstallprompt, so drive the path the
  // event would: the button must appear and be wired, not merely exist.
  const shown = await page.evaluate(() => {
    const ev = new Event('beforeinstallprompt');
    let prevented = false;
    ev.preventDefault = () => { prevented = true; };
    ev.prompt = () => { window.__PROMPTED__ = true; };
    window.dispatchEvent(ev);
    return { prevented, visible: !document.getElementById('install').hidden };
  });
  assert.ok(shown.prevented, 'the default mini-infobar should be suppressed');
  assert.ok(shown.visible, 'the install button should appear on the title screen');

  await page.locator('#install').tap();
  await page.waitForTimeout(200);
  assert.strictEqual(
    await page.evaluate(() => window.__PROMPTED__ === true),
    true,
    'tapping install should trigger the browser prompt'
  );
  assert.ok(
    await page.locator('#install').isHidden(),
    'the offer should retract once taken'
  );
  assert.deepStrictEqual(errors, []);
  await ctx.close();
});

test('the install offer stays hidden when already installed', async () => {
  // display-mode: standalone is how an installed launch identifies itself.
  const ctx = await browser.newContext(ctxOpts());
  const page = await ctx.newPage();
  await page.emulateMedia({ media: 'screen', reducedMotion: null, forcedColors: null });
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) =>
      q.includes('display-mode: standalone')
        ? { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }
        : real(q);
  });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    const ev = new Event('beforeinstallprompt');
    ev.preventDefault = () => {};
    window.dispatchEvent(ev);
  });
  assert.ok(
    await page.locator('#install').isHidden(),
    'an already-installed app should not offer to install itself'
  );
  await ctx.close();
});
