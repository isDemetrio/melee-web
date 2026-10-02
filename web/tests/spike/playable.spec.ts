import { expect, test } from '@playwright/test';

test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu'] } });

test('main page presents consecutive real core frames while worker stays synchronous', async ({ page }) => {
  // Ask the real play worker for the core's synthetic GX selftest: no disc data in CI.
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      override postMessage(message: unknown, transfer?: Transferable[]): void {
        const request = message as { pad?: SharedArrayBuffer; selftest?: boolean };
        if (request.pad) request.selftest = true;
        super.postMessage(message, transfer ?? []);
      }
    };
  });
  await page.goto('/');
  await page.click('button:has-text("Game")');
  await page.setInputFiles('#game-disc', { name: 'synthetic.iso', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) });
  await page.click('#game-play');
  await expect(page.locator('#performance')).toHaveText('Game ended (code 0).');
  const pixel = await page.locator('#game-canvas').evaluate((node) => {
    const copy = document.createElement('canvas');
    copy.width = 640; copy.height = 480;
    const context = copy.getContext('2d')!;
    context.drawImage(node as HTMLCanvasElement, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data];
  });
  expect(pixel).toEqual([0x20, 0x80, 0xc0, 0xff]);
});
