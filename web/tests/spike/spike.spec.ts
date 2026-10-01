import { test, expect, type Page } from '@playwright/test';

/**
 * The result JSON the page offers, read the way the page itself reads it: the anchor points at
 * a blob URL of this origin, so the page can fetch its own blob.
 */
async function result(page: Page): Promise<Record<string, unknown>> {
  const text = await page.evaluate(async () => {
    const link = document.getElementById('download') as HTMLAnchorElement;
    return await (await fetch(link.href)).text();
  });
  return JSON.parse(text) as Record<string, unknown>;
}

test('web core reads a WORKERFS File and rejects a synthetic disc', async ({ page }) => {
  await page.goto('/spike.html?nosizecheck&frames=1');
  const buffer = Buffer.alloc(0x440);
  buffer.write('GALE01');
  await page.locator('#iso').setInputFiles({ name: 'synthetic.iso', mimeType: 'application/octet-stream', buffer });
  await page.locator('#run').click();
  await expect(page.locator('#core')).toContainText('core loaded');
  await expect(page.locator('#status')).toHaveText('exit 1');
  await expect(page.locator('#log')).toContainText('FATAL: cannot read full Melee DOL');
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  await expect(page.locator('#download')).toBeVisible();
});

test('a page with no cached disc and no chosen file asks for one instead of failing', async ({ page }) => {
  // `/phase0/disc-chunks` is served by a Cloudflare Function, so on this static server the cache
  // cannot answer at all -- which is the state of every local preview. The page must still be
  // usable from the selector, and asking for a file is what that looks like.
  await page.goto('/spike.html?nosizecheck&frames=1');
  await page.locator('#run').click();
  await expect(page.locator('#status')).toHaveText('select a disc image');
  await expect(page.locator('#download')).toBeHidden();
});

test('the result JSON names the disc source, the storage state and the core load time', async ({ page }) => {
  await page.goto('/spike.html?nosizecheck&frames=1');
  const buffer = Buffer.alloc(0x440);
  buffer.write('GALE01');
  await page.locator('#iso').setInputFiles({ name: 'synthetic.iso', mimeType: 'application/octet-stream', buffer });
  await page.locator('#run').click();
  await expect(page.locator('#download')).toBeVisible();
  const json = await result(page);
  expect(json.schema).toBe('melee-spike-result/1');
  // No cache entry and no manifest on this server: the disc came from the selector, and the
  // result says so rather than leaving the reader to guess which disc was measured.
  expect(json.disc_source).toBe('picker');
  expect(json.iso_bytes).toBe(0x440);
  expect(typeof json.storage_persisted).toBe('boolean');
  // From the worker's start to the core being callable, so it is a number and it is positive.
  expect(typeof json.core_load_ms).toBe('number');
  expect(json.core_load_ms as number).toBeGreaterThan(0);
});
