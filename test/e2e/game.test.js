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
  // Matched loosely on purpose: the claim is that the next tier is named, not
  // the wording it is named in.
  assert.match(banner, /\d★ at \d+%/, 'and should name the next tier to aim for');
  assert.match(banner, /\d+:\d\d/, 'and the time it took');

  const pct = parseInt(await text(page, '#collected'), 10);
  assert.ok(pct >= 85, `collected ${pct}%, expected at least 85`);
  assert.deepStrictEqual(errors, []);
  await ctx.close();
});

test('missing the collector fails the level, and offers a way out', async () => {
  /*
   * Deliberately not asserting WHICH failure. A miss can end either way —
   * UNWINNABLE once the drains have taken enough that the ceiling drops under
   * the pass mark, or STUCK when the ground swallows and holds the payload
   * instead — and which one you get depends on how the collapse falls out. CI
   * proved that by reaching 71% where this machine reaches 41%.
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

test('the sand band shows up in its own stage band, and swallows a shaft', async () => {
  // Levels 1–10 are clay: there is no sand to cut through until stage 11. The
  // levels genuinely differ, so this has to go and look at one that has sand.
  const { ctx, page } = await open();
  await page.locator('#start').tap();
  await page.locator('#labtoggle').tap();
  await page.fill('#levelnum', '15');
  await page.locator('#go').tap();
  await page.waitForTimeout(400);
  assert.strictEqual(await text(page, '#seedlabel'), 'level 15');
  await page.locator('#labtoggle').tap(); // out of the way of the drag

  // Well left of the corridor, straight down through the band.
  await digDown(page, 0.3);
  const ended = await until(page, async () => {
    const b = await text(page, '#banner');
    return b.includes('UNWINNABLE') || b.includes('STUCK');
  });
  assert.ok(ended, `expected a failure, banner was: ${await text(page, '#banner')}`);
  // Sand holding fluid is the signature of this failure rather than a drain.
  assert.ok(
    parseInt(await text(page, '#held'), 10) > 0,
    'the sand band should have taken some of the payload'
  );
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

test('the level clock runs while playing and stops at the clear time', async () => {
  const { ctx, page } = await open();
  assert.strictEqual(await text(page, '#time'), '0:00', 'the clock waits for the intro');
  await page.waitForTimeout(1500);
  assert.strictEqual(await text(page, '#time'), '0:00', 'and does not run behind it');

  await page.locator('#start').tap();
  await page.waitForTimeout(2500);
  assert.notStrictEqual(await text(page, '#time'), '0:00', 'it should run once playing');

  await page.locator('#labtoggle').tap();
  await page.locator('#solve').tap();
  const won = await until(page, async () =>
    (await text(page, '#banner')).includes('CLEAR')
  );
  assert.ok(won);

  // Once cleared, the clock reports time-to-clear and stops moving, even
  // though fluid is still arriving and the grade can still climb.
  const at = await text(page, '#time');
  assert.match(at, /^\d+:\d\d$/);
  await page.waitForTimeout(2500);
  assert.strictEqual(await text(page, '#time'), at, 'the clear time should be fixed');
  assert.ok((await text(page, '#banner')).includes(at), 'and be reported in the banner');
  await ctx.close();
});

test('clearing a level offers a way onward', async () => {
  const { ctx, page } = await open();
  await page.locator('#start').tap();
  await page.locator('#labtoggle').tap();
  await page.locator('#solve').tap();
  assert.ok(
    await until(page, async () => (await text(page, '#banner')).includes('CLEAR'))
  );

  const onward = page.locator('#onward');
  assert.ok(await onward.isVisible(), 'a cleared level should offer the next one');
  // Teal-on-teal would be invisible; the label has to contrast with the fill.
  const colours = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById('onward'));
    return { fg: s.color, bg: s.backgroundColor };
  });
  assert.notStrictEqual(colours.fg, colours.bg, 'the button label must be readable');

  await onward.tap();
  await page.waitForTimeout(500);
  assert.strictEqual(await text(page, '#seedlabel'), 'level 2');
  assert.strictEqual(await text(page, '#time'), '0:00', 'the new level starts a new clock');
  assert.strictEqual(await text(page, '#banner'), '');
  await ctx.close();
});

test('Next level is locked until the level is cleared, then it moves on', async () => {
  const { ctx, page } = await open();
  await page.locator('#start').tap();
  await page.waitForTimeout(200);
  assert.strictEqual(await text(page, '#seedlabel'), 'level 1');

  const next = page.locator('#next');
  assert.ok(await next.isDisabled(), 'level 2 should be locked before level 1 is cleared');

  await page.locator('#labtoggle').tap();
  await page.locator('#solve').tap();
  assert.ok(
    await until(page, async () => (await text(page, '#banner')).includes('CLEAR'))
  );

  assert.ok(await next.isEnabled(), 'clearing the level should unlock the next one');
  await next.tap();
  await page.waitForTimeout(400);
  assert.strictEqual(await text(page, '#seedlabel'), 'level 2');
  // And level 3 is locked again, one at a time.
  assert.ok(await next.isDisabled(), 'the gate should close again on the new level');
  await ctx.close();
});

test('unlocked progress survives a reload', async () => {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'load' });
  await page.locator('#start').tap();
  await page.locator('#labtoggle').tap();
  await page.locator('#solve').tap();
  assert.ok(
    await until(page, async () => (await text(page, '#banner')).includes('CLEAR'))
  );

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);
  assert.strictEqual(await text(page, '#seedlabel'), 'level 1');
  assert.ok(
    await page.locator('#next').isEnabled(),
    'a level cleared before the reload should still be cleared after it'
  );
  await ctx.close();
});

test('experimental mode goes past the gate', async () => {
  // The unlock gate is for players finding their way through the game. The
  // debug panel is not, and has to keep working from a standing start.
  const { ctx, page } = await open();
  await page.locator('#start').tap();
  await page.locator('#labtoggle').tap();
  await page.fill('#levelnum', '30');
  await page.locator('#go').tap();
  await page.waitForTimeout(500);
  assert.strictEqual(await text(page, '#seedlabel'), 'level 30');
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

// ---------------------------------------------------------------------------
// Layout — the board should fill the window, without pushing controls off it
// ---------------------------------------------------------------------------

const SCREENS = [
  ['phone', PHONE],
  ['tablet', { viewport: { width: 820, height: 1180 } }],
  ['desktop', { viewport: { width: 1440, height: 900 } }],
  ['short laptop', { viewport: { width: 1280, height: 620 } }]
];

for (const [name, opts] of SCREENS) {
  test(`on a ${name} the board fills the window and the controls stay on it`, async () => {
    const { ctx, page } = await open(opts);
    // click, not tap: the desktop contexts here have no touch support.
    await page.locator('#start').click();
    await page.waitForTimeout(200);

    const vp = page.viewportSize();
    const board = await page.locator('#view').boundingBox();

    // The board is 3:5 and keeps that shape, so "full screen" means it fills
    // the axis that runs out first. Height is that axis on every screen here.
    assert.ok(
      board.height > vp.height * 0.72,
      `board is ${Math.round(board.height)}px tall in a ${vp.height}px window`
    );
    assert.ok(
      Math.abs(board.width / board.height - 120 / 200) < 0.02,
      'the board must keep its aspect ratio rather than stretch'
    );

    // Nothing may hang off the window: the page does not scroll, so anything
    // past the edge is unreachable. This is how the Restart button went
    // missing before, so it is checked on every size.
    assert.strictEqual(
      await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 1),
      false,
      'the page should never need scrolling'
    );
    for (const id of ['#reset', '#next', '#help']) {
      const b = await page.locator(id).boundingBox();
      assert.ok(b, `${id} should be laid out`);
      assert.ok(
        b.y >= 0 && b.y + b.height <= vp.height + 1 && b.x >= 0 && b.x + b.width <= vp.width + 1,
        `${id} is off screen at ${JSON.stringify(b)} in ${vp.width}x${vp.height}`
      );
    }
    await ctx.close();
  });
}
