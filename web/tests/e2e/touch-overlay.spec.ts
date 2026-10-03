import { expect, test, type Page } from '@playwright/test';

/**
 * The id of the element the browser hit-tests at a viewport point. A box is not a control: a zone
 * scrolled out of the viewport, or covered by something else, still has one, and a pointer
 * event aimed at it reaches nothing.
 */
async function hitAt(page: Page, point: { x: number; y: number }): Promise<string | null> {
  return page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[id]')?.id ?? null, point);
}

/**
 * The touch overlay, driven by real pointer events in a real browser.
 *
 * The unit tests drive the overlay through a fake pointer surface, which proves the claim logic
 * but not the platform: not the rect measurement, not the pointer capture, not that a real
 * `PointerEvent` carries the fields the adapter reads. This test uses the mouse as the pointer —
 * Chromium reports a mouse drag as pointer events with pointerId 1 — so the code path is the one
 * a finger takes.
 *
 * It reads the `PADStatus` bytes the overlay prints on the game screen rather than a test hook:
 * the hook would be state nothing else in the page uses, and the bytes are what the guest would
 * actually be handed.
 */
test.describe('touch overlay', () => {
  test('writes a PAD state from pointer events, and keeps steering outside the zone', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("Game")');

    // Off by default, and an overlay that is off reads as an unplugged port: err = -1 is what
    // tells the guest there is nothing on this port.
    await expect(page.locator('#touch-overlay')).toHaveAttribute('data-enabled', 'false');
    await expect(page.locator('#pad-readout')).toContainText('err=-1');

    await page.check('#touch-overlay-toggle');
    await expect(page.locator('#touch-overlay')).toHaveAttribute('data-enabled', 'true');
    await expect(page.locator('#pad-readout')).toContainText('err=0');
    await expect(page.locator('#pad-readout')).toContainText('00 00 00 00 00 00');

    const zone = await page.locator('#stick-zone').boundingBox();
    if (!zone) throw new Error('the stick zone has no layout: the overlay is not displayed');
    const centre = { x: zone.x + zone.width / 2, y: zone.y + zone.height / 2 };
    // Full deflection is half the zone's smaller side (touch.ts, zoneRadius).
    const radius = Math.min(zone.width, zone.height) / 2;
    expect(await hitAt(page, centre)).toBe('stick-zone');

    // The stick starts where the finger lands, so the state is neutral at the press.
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await expect(page.locator('#pad-readout')).toContainText('00 00 00 00 00 00');

    // A full-deflection drag to the right: stick_x is 0x7f.
    await page.mouse.move(centre.x + radius, centre.y);
    await expect(page.locator('#pad-readout')).toContainText('00 00 7f 00 00 00');

    // Now straight up and *out* of the zone. Only a captured pointer is still delivered to the
    // element the gesture started on, so stick_y reaching 0x7f with stick_x back to 0 is what
    // proves the capture: without it this move lands on the page and the stick never moves.
    await page.mouse.move(centre.x, centre.y - zone.height);
    await expect(page.locator('#pad-readout')).toContainText('00 00 00 7f 00 00');

    // And the release outside the zone still reaches it, for the same reason.
    await page.mouse.up();
    await expect(page.locator('#pad-readout')).toContainText('00 00 00 00 00 00');
  });

  test('holds a button while the finger moves, and releases it on pointerup', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("Game")');
    await page.check('#touch-overlay-toggle');

    const button = await page.locator('#touch-a').boundingBox();
    if (!button) throw new Error('the A button has no layout: the overlay is not displayed');
    const centre = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
    expect(await hitAt(page, centre)).toBe('touch-a');

    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    // A is bit 0x0100, and the button field is big-endian in guest memory (pad.ts).
    await expect(page.locator('#pad-readout')).toContainText('01 00 00 00');

    // A button does not follow the finger: it stays held until it is released.
    await page.mouse.move(centre.x + 120, centre.y + 40);
    await expect(page.locator('#pad-readout')).toContainText('01 00 00 00');

    await page.mouse.up();
    await expect(page.locator('#pad-readout')).toContainText('00 00 00 00 00 00');
  });
});

/** An element's box, or a failure naming it: a control with no box is a control nobody can see. */
async function boxOf(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no layout: it is not displayed`);
  return box;
}

function centreOf(box: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The twelve PADStatus bytes the game screen prints, as numbers. */
async function padBytes(page: Page): Promise<number[]> {
  const text = (await page.locator('#pad-readout').textContent()) ?? '';
  const match = /PADStatus: ((?:[0-9a-f]{2} ?){12})/.exec(text);
  if (!match) throw new Error(`no PADStatus in the readout: ${text}`);
  return match[1].trim().split(' ').map((byte) => parseInt(byte, 16));
}

/** The product of the element's opacity and every ancestor's: what actually reaches the screen. */
async function shownOpacity(page: Page, selector: string): Promise<number> {
  return page.evaluate((target) => {
    let opacity = 1;
    for (let node = document.querySelector(target); node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible') return 0;
      opacity *= Number(style.opacity);
    }
    return opacity;
  }, selector);
}

/**
 * Whether an element puts pixels on the screen: the container is captured with the element shown
 * and again with it hidden, and the two captures must differ. An element that is in the DOM but
 * transparent, empty, zero-sized or drawn in the colour of what is behind it gives two equal
 * captures.
 */
async function paints(page: Page, container: string, element: string): Promise<boolean> {
  const shown = await page.locator(container).screenshot();
  await page.locator(element).evaluate((node) => { (node as HTMLElement).style.visibility = 'hidden'; });
  const hidden = await page.locator(container).screenshot();
  await page.locator(element).evaluate((node) => { (node as HTMLElement).style.visibility = ''; });
  return !shown.equals(hidden);
}

test.describe('a stick a player can find', () => {
  test('both sticks and the buttons are drawn, on a black frame and on a white one', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.click('button:has-text("Game")');
    await page.check('#touch-overlay-toggle');

    const viewport = { width: 390, height: 844 };
    for (const [base, zone] of [['#stick-base', '#stick-zone'], ['#c-stick-base', '#c-stick-zone']] as const) {
      await expect(page.locator(base)).toBeVisible();
      const box = await boxOf(page, base);
      const area = await boxOf(page, zone);
      // A thumb-sized circle, resting inside its own zone and inside the viewport.
      expect(box.width).toBeGreaterThanOrEqual(48);
      expect(Math.abs(box.width - box.height)).toBeLessThan(1);
      const centre = centreOf(box);
      expect(centre.x).toBeGreaterThan(area.x);
      expect(centre.x).toBeLessThan(area.x + area.width);
      expect(centre.y).toBeGreaterThan(area.y);
      expect(centre.y).toBeLessThan(area.y + area.height);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      // At the default overlay opacity (0.5) it is still half there, not a ghost.
      expect(await shownOpacity(page, base)).toBeGreaterThanOrEqual(0.3);
      // The drawing does not take the finger: the zone does.
      expect(await hitAt(page, centre)).toBe(zone.slice(1));
    }
    expect((await boxOf(page, '#stick-knob')).width).toBeGreaterThanOrEqual(24);

    // The canvas is black until a game runs; the character select is mostly white, and that is
    // where the old buttons (white on translucent white) disappeared. Both must show on both.
    for (const frame of ['#000', '#fff']) {
      await page.locator('#game-canvas').evaluate((canvas, colour) => {
        (canvas as HTMLElement).style.background = colour;
      }, frame);
      expect(await paints(page, '#stick-zone', '#stick-base'), `stick on ${frame}`).toBe(true);
      expect(await paints(page, '#c-stick-zone', '#c-stick-base'), `C-stick on ${frame}`).toBe(true);
      expect(await paints(page, '#button-zone', '#touch-a'), `A on ${frame}`).toBe(true);
    }
  });

  test('the knob follows the finger, the bytes are the zone’s, and both return on release', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.click('button:has-text("Game")');
    await page.check('#touch-overlay-toggle');

    const rest = centreOf(await boxOf(page, '#stick-base'));
    const zone = await boxOf(page, '#stick-zone');
    // The base's radius is the full-deflection travel (touch.ts, zoneRadius).
    const radius = Math.min(zone.width, zone.height) / 2;
    expect((await boxOf(page, '#stick-base')).width / 2).toBeCloseTo(radius, 0);

    // Land away from the resting base: the stick's neutral is where the finger lands, and the
    // base goes there.
    const landing = { x: zone.x + zone.width * 0.3, y: rest.y + 20 };
    /** How far, in CSS pixels, an element's centre is from a point. */
    const offBy = async (selector: string, point: { x: number; y: number }): Promise<number> => {
      const centre = centreOf(await boxOf(page, selector));
      return Math.max(Math.abs(centre.x - point.x), Math.abs(centre.y - point.y));
    };

    await page.mouse.move(landing.x, landing.y);
    await page.mouse.down();
    await expect(page.locator('#stick-base')).toHaveAttribute('data-active', 'true');
    await expect.poll(() => offBy('#stick-base', landing)).toBeLessThan(2);
    await expect.poll(() => offBy('#stick-knob', landing)).toBeLessThan(2);
    expect((await padBytes(page)).slice(2, 4)).toEqual([0, 0]);

    // Half travel to the right: the knob is under the finger, and stick_x is about half (63).
    const halfway = { x: landing.x + radius / 2, y: landing.y };
    await page.mouse.move(halfway.x, halfway.y);
    await expect.poll(() => offBy('#stick-knob', halfway)).toBeLessThan(2);
    await expect.poll(async () => (await padBytes(page))[2]).toBeGreaterThanOrEqual(60);
    expect((await padBytes(page))[2]).toBeLessThanOrEqual(66);
    expect((await padBytes(page))[3]).toBe(0);

    // Past the rim: the knob stops on it and the stick reads full.
    await page.mouse.move(landing.x + radius * 2, landing.y);
    await expect(page.locator('#pad-readout')).toContainText('00 00 7f 00 00 00');
    await expect.poll(() => offBy('#stick-knob', { x: landing.x + radius, y: landing.y })).toBeLessThan(2);

    // Release: neutral bytes, the base back at rest, the knob centred on it.
    await page.mouse.up();
    await expect(page.locator('#pad-readout')).toContainText('00 00 00 00 00 00');
    await expect(page.locator('#stick-base')).toHaveAttribute('data-active', 'false');
    await expect.poll(() => offBy('#stick-base', rest)).toBeLessThan(1);
    await expect.poll(() => offBy('#stick-knob', rest)).toBeLessThan(1);
  });

  test('a held button is drawn pressed', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.click('button:has-text("Game")');
    await page.check('#touch-overlay-toggle');

    const a = centreOf(await boxOf(page, '#touch-a'));
    await expect(page.locator('#touch-a')).toHaveAttribute('data-pressed', 'false');
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await expect(page.locator('#touch-a')).toHaveAttribute('data-pressed', 'true');
    await expect(page.locator('#touch-b')).toHaveAttribute('data-pressed', 'false');
    await page.mouse.up();
    await expect(page.locator('#touch-a')).toHaveAttribute('data-pressed', 'false');
  });
});

for (const viewport of [{ width: 390, height: 640 }, { width: 844, height: 390 }]) {
  test(`the controls stay on screen while the page scrolls (${viewport.width}×${viewport.height})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.click('button:has-text("Game")');
    await page.check('#touch-overlay-toggle');

    // Nothing on the page is wider than the phone: a page that pans sideways moves the controls
    // under the player's thumb.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

    // To the bottom of the page, where the Input panel is. The page must really have scrolled,
    // or the rest of this test proves nothing.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);

    const controls = [
      ['#stick-base', 'stick-zone'],
      ['#c-stick-base', 'c-stick-zone'],
      ['#touch-a', 'touch-a'],
      ['#touch-start', 'touch-start'],
    ] as const;
    for (const [selector, hit] of controls) {
      const box = await boxOf(page, selector);
      expect(box.y, `${selector} top`).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, `${selector} bottom`).toBeLessThanOrEqual(viewport.height);
      expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual(viewport.width);
      // In view and not covered by the panels scrolling under the stage.
      expect(await hitAt(page, centreOf(box)), `${selector} hit`).toBe(hit);
    }

    // And it still steers from there.
    const zone = await boxOf(page, '#stick-zone');
    const radius = Math.min(zone.width, zone.height) / 2;
    const centre = centreOf(await boxOf(page, '#stick-base'));
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + radius, centre.y);
    await expect(page.locator('#pad-readout')).toContainText('00 00 7f 00 00 00');
    await page.mouse.up();
    await expect(page.locator('#pad-readout')).toContainText('00 00 00 00 00 00');
  });
}

test('overlay stays inside the game stage and navigation removes it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.click('button:has-text("Game")');
  await page.check('#touch-overlay-toggle');
  const stage = await page.locator('#game-stage').boundingBox();
  const overlay = await page.locator('#touch-overlay').boundingBox();
  expect(stage).not.toBeNull();
  expect(overlay).not.toBeNull();
  expect(overlay!.y).toBeGreaterThanOrEqual(stage!.y);
  expect(overlay!.y + overlay!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);
  await page.uncheck('#touch-overlay-toggle');
  await expect(page.locator('#touch-overlay')).toBeHidden();
  await page.check('#touch-overlay-toggle');
  await page.click('button:has-text("Settings")');
  await expect(page.locator('#touch-overlay')).toHaveCount(0);
  await page.click('button:has-text("Game")');
  await expect(page.locator('#touch-overlay')).toHaveCount(1);
  await expect(page.locator('#touch-overlay')).toBeHidden();
});
