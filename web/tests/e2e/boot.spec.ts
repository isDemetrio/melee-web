import { expect, test } from '@playwright/test';

/**
 * Shell smoke tests.
 *
 * What these prove: the page boots with the isolation headers the deployment sets, the
 * capability probe runs and renders, the audio unlock happens on a real user gesture, and
 * the shell survives with those headers missing (with the right, clear message).
 */
test.describe('boot', () => {
  test('boots clean, is cross-origin isolated, and reports capabilities', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    await page.goto('/');

    await expect(page.locator('#app')).toHaveAttribute('data-screen', 'boot');
    await expect(page.locator('#screen-boot')).toBeVisible();

    // The headers are the whole reason the app can use SharedArrayBuffer.
    expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(() => typeof SharedArrayBuffer === 'function')).toBe(true);

    // The capability report must render one row per probe, not an empty list.
    const rows = page.locator('#capability-list li');
    await expect(rows).toHaveCount(9);
    await expect(page.locator('#capability-list li', { hasText: 'SharedArrayBuffer' })).toContainText('✓');

    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('unlocks audio on the click, then goes to the lobby', async ({ page }) => {
    await page.goto('/');
    await page.click('#play-button');

    // The gesture must be what resumes the context: launching Chromium with
    // --autoplay-policy=no-user-gesture-required would make this assertion meaningless,
    // which is why no such flag is set anywhere in this project.
    await expect(page.locator('#audio-status')).toContainText('audio: running');

    await expect(page.locator('#app')).toHaveAttribute('data-screen', 'lobby');
    await expect(page.locator('#screen-lobby')).toBeVisible();
  });

  test('the lobby says so plainly when signalling is not configured', async ({ page }) => {
    await page.goto('/');
    await page.click('#play-button');
    // No VITE_SUPABASE_URL is set in the test build, so the lobby must explain itself
    // rather than showing controls that cannot work.
    await expect(page.locator('#screen-lobby')).toContainText('Lobby unavailable');
  });

  test('the game screen offers disc loading and live play', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("Game")');
    await expect(page.locator('#game-canvas')).toBeVisible();
    await expect(page.locator('#screen-game')).toContainText('Play loads the operator disc');
  });
});

test.describe('without isolation headers', () => {
  test.use({ baseURL: 'http://127.0.0.1:4174' });

  test('reports the missing requirement instead of pretending to work', async ({ page }) => {
    await page.goto('/');

    expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(false);
    await expect(page.locator('#capability-list li', { hasText: 'Cross-origin isolation' })).toContainText('✗');
    await expect(page.locator('#screen-boot')).toContainText('no WebGL2 fallback');
  });
});
