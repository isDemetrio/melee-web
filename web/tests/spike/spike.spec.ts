import { test, expect } from '@playwright/test';
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
