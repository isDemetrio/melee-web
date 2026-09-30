import { expect, test } from '@playwright/test';

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
