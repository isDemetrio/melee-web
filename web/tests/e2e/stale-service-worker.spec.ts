import { expect, test } from '@playwright/test';

/**
 * A service worker left behind by an earlier visit must not keep serving the shell.
 *
 * This is the defect that made every measurement taken on the page suspect: the worker serves the
 * shell cache-first, so a deployment never reaches the browser and the operator reads yesterday's
 * code believing it is today's. The published site does not ship `sw.js` at all, so a registration
 * that still controls the page is a leftover with no reason to exist.
 *
 * The test build does serve `sw.js` (vite copies `public/`), so the path is reproducible here: load
 * once so the app registers it and it takes control of the page, then reload. On that second load
 * the page is controlled from the first byte — the operator's situation — and must drop the
 * registration and the shell cache and reload itself once.
 *
 * The guard is the evidence that the cleanup ran: it is written nowhere else, and only in the
 * cleanup, immediately before that reload.
 */
test.describe('a service worker from an earlier visit', () => {
  test('is dropped instead of serving a stale shell', async ({ page }) => {
    await page.goto('/');

    // The app registers /sw.js during boot; skipWaiting + clients.claim make it control this page.
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 });
    expect(
      await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((all) => all.length)),
    ).toBeGreaterThan(0);

    // Reload: a worker now controls the page from the start, which is what the operator meets.
    await page.reload();

    // The cleanup asks for a reload of its own, so the execution context can be destroyed under
    // this read: that is a navigation in flight, not a failure, and it is retried.
    const readGuard = async (): Promise<string | null> => {
      try {
        return await page.evaluate(() => sessionStorage.getItem('melee-sw-stale-dropped'));
      } catch {
        return null;
      }
    };

    // The cleanup ran and asked for a reload. Nothing else writes this key.
    await expect.poll(readGuard, { timeout: 20_000 }).toBe('1');

    // And dropping the worker must not leave a blank screen.
    await expect(page.locator('#screen-boot')).toBeVisible();
  });
});
