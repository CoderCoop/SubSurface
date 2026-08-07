'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { serve, launch, watch, digDown, text, until, PHONE } = require('./helpers');

let ctxServer, browser, base;

test.before(async () => {
  const s = await serve();
  ctxServer = s.server;
  base = `http://127.0.0.1:${s.port}/play/`;
  browser = await launch();
});

test.after(async () => {
  if (browser) await browser.close();
  if (ctxServer) ctxServer.close();
});

async function open(opts = PHONE) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  watch(page, errors);
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}

// ---------------------------------------------------------------------------
// The title screen
// ---------------------------------------------------------------------------

test('the intro is shown on load and Start digging dismisses it', async () => {
  const { ctx, page, errors } = await open();
  assert.ok(await page.locator('#intro').isVisible(), 'intro should be up on load');

  await page.locator('#start').tap();
  await page.waitForTimeout(300);

  assert.ok(await page.locator('#intro').isHidden(), 'Start digging must dismiss the intro');
  assert.deepStrictEqual(errors, []);
  await ctx.close();
});

test('Start digging works with a mouse as well as a tap', async () => {
  const { ctx, page } = await open({ viewport: { width: 900, height: 950 } });
  await page.locator('#start').click();
  await page.waitForTimeout(300);
  assert.ok(await page.locator('#intro').isHidden());
  await ctx.close();
});

test('dragging behind the intro does not dig, dragging after it does', async () => {
  // The overlay has to actually swallow input. If it only looked like a
  // barrier, a drag started on the title screen would silently carve a channel
  // before the player had read anything.
  const { ctx, page } = await open();
  await digDown(page, 0.78);
  await page.locator('#start').tap();
  await page.waitForTimeout(2500);
  assert.strictEqual(
    await text(page, '#collected'),
    '0%',
    'a drag made while the intro was up should not have cut anything'
  );

  await digDown(page, 0.78);
  const flowing = await until(page, async () =>
    parseInt(await text(page, '#collected'), 10) > 0
  );
  assert.ok(flowing, 'the same drag after dismissing should cut a channel');
  await ctx.close();
});

test('How to play reopens the intro', async () => {
  const { ctx, page } = await open();
  await page.locator('#start').tap();
  await page.waitForTimeout(200);
  await page.locator('#help').tap();
  await page.waitForTimeout(200);
  assert.ok(await page.locator('#intro').isVisible());
  await ctx.close();
});

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

test('digging the clay corridor clears the level and earns a grade', async () => {
  const { ctx, page, errors } = await open();
  await page.locator('#start').tap();
  await page.waitForTimeout(200);

  await digDown(page, 0.78);
  const won = await until(page, async () =>
    (await text(page, '#banner')).includes('CLEAR')
  );
  assert.ok(won, `expected a clear, banner was: ${await text(page, '#banner')}`);

  const banner = await text(page, '#banner');
  assert.match(banner, /★/, 'a clear should show a star grade');
  assert.match(banner, /next: \d★ at \d+%/, 'and should name the next tier to aim for');

  const pct = parseInt(await text(page, '#collected'), 10);
  assert.ok(pct >= 85, `collected ${pct}%, expected at least 85`);
  assert.deepStrictEqual(errors, []);
  await ctx.close();
});

test('a shaft through the sand fails, and offers a way out', async () => {
  /*
   * Deliberately not asserting WHICH failure. A cut through the sand can end
   * either way — UNWINNABLE once the drains have taken enough that the ceiling
   * drops under the pass mark, or STUCK when the band swallows and holds the
   * payload instead — and which one you get depends on how the collapse falls
   * out. CI proved that by reaching 71% where this machine reaches 41%.
   *
   * The contract that always holds, and the one a player cares about, is that
   * the level does not clear and the game tells you so with a way to restart.
   */
  const { ctx, page } = await open();
  await page.locator('#start').tap();
  await page.waitForTimeout(200);

  await digDown(page, 0.45);
  const ended = await until(page, async () => {
    const b = await text(page, '#banner');
    return b.includes('UNWINNABLE') || b.includes('STUCK');
  });
  const banner = await text(page, '#banner');
  assert.ok(ended, `expected a failure, banner was: ${banner}`);
  assert.ok(!banner.includes('CLEAR'), 'cutting through sand should not clear');

  const pct = parseInt(await text(page, '#collected'), 10);
  assert.ok(pct < 85, `failed run collected ${pct}%, which should be under 85`);

  // When it is the unwinnable path, the cap it reports has to justify itself.
  if (banner.includes('UNWINNABLE')) {
    const cap = parseInt(banner.match(/at (\d+)%/)[1], 10);
    assert.ok(cap < 85, `reported cap ${cap}% should be under the 85% pass mark`);
  }

  // Either way the offered restart has to actually restart.
  await page.locator('#again').tap();
  await page.waitForTimeout(500);
  assert.strictEqual(await text(page, '#banner'), '');
  assert.strictEqual(await text(page, '#collected'), '0%');
  await ctx.close();
});

test('Restart level resets the level in place', async () => {
  const { ctx, page } = await open();
  await page.locator('#start').tap();
  await page.waitForTimeout(200);
  await digDown(page, 0.78, 0.3, 0.6);
  await page.waitForTimeout(1500);

  const level = await text(page, '#seedlabel');
  await page.locator('#reset').tap();
  await page.waitForTimeout(400);

  assert.strictEqual(await text(page, '#collected'), '0%');
  assert.strictEqual(await text(page, '#seedlabel'), level, 'restart keeps the same level');
  await ctx.close();
});

test('Next level moves on', async () => {
  const { ctx, page } = await open();
  await page.locator('#start').tap();
  await page.waitForTimeout(200);
  assert.strictEqual(await text(page, '#seedlabel'), 'level 1');
  await page.locator('#next').tap();
  await page.waitForTimeout(400);
  assert.strictEqual(await text(page, '#seedlabel'), 'level 2');
  await ctx.close();
});

// ---------------------------------------------------------------------------
// Experimental mode
// ---------------------------------------------------------------------------

test('experimental mode is hidden until asked for, then jumps to any level', async () => {
  const { ctx, page } = await open();
  await page.locator('#start').tap();
  await page.waitForTimeout(200);

  assert.ok(await page.locator('#lab').isHidden(), 'the panel should start closed');
  await page.locator('#labtoggle').tap();
  await page.waitForTimeout(200);
  assert.ok(await page.locator('#lab').isVisible());

  await page.fill('#levelnum', '42');
  await page.locator('#go').tap();
  await page.waitForTimeout(500);
  assert.strictEqual(await text(page, '#seedlabel'), 'level 42');

  // No level is gated, so a far one has to build too.
  await page.fill('#levelnum', '500');
  await page.locator('#go').tap();
  await page.waitForTimeout(500);
  assert.strictEqual(await text(page, '#seedlabel'), 'level 500');
  await ctx.close();
});

test('the reference cut solves the level it is offered for', async () => {
  const { ctx, page } = await open();
  await page.locator('#start').tap();
  await page.waitForTimeout(200);
  await page.locator('#labtoggle').tap();
  await page.locator('#solve').tap();

  const won = await until(page, async () =>
    (await text(page, '#banner')).includes('CLEAR')
  );
  assert.ok(won, `reference cut should clear, banner: ${await text(page, '#banner')}`);
  await ctx.close();
});
