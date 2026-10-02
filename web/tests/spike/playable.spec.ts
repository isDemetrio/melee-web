import { expect, test } from '@playwright/test';

test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu'] } });

test('main page presents consecutive real core frames while worker stays synchronous', async ({ page }) => {
  // Ask the real play worker for the core's synthetic GX selftest: no disc data in CI.
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    // DIAGNOSTIC (temporary): keep the shared words and each frame's first pixel, read from the
    // ImageBitmap itself before the page's handler transfers it into the canvas.
    const probe = window as unknown as { padWords?: Int32Array; frames?: unknown[] };
    probe.frames = [];
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as { type?: string; serial?: number; bitmap?: ImageBitmap };
          if (data.type !== 'frame' || !data.bitmap) return;
          const copy = new OffscreenCanvas(data.bitmap.width, data.bitmap.height);
          const context = copy.getContext('2d')!;
          context.drawImage(data.bitmap, 0, 0);
          probe.frames!.push({ serial: data.serial, width: data.bitmap.width, height: data.bitmap.height,
            pixel: [...context.getImageData(0, 0, 1, 1).data] });
        });
      }
      override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
        const request = message as { pad?: SharedArrayBuffer; selftest?: boolean };
        if (request.pad) request.selftest = true;
        if (request.pad) probe.padWords = new Int32Array(request.pad);
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
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
  console.log('DIAGNOSTIC presentation', JSON.stringify(await page.evaluate(() => {
    const probe = window as unknown as { padWords?: Int32Array; frames?: unknown[] };
    return { presented: probe.padWords ? Atomics.load(probe.padWords, 13) : null, frames: probe.frames };
  })), 'canvas readback', JSON.stringify(pixel));
  expect(pixel).toEqual([0x20, 0x80, 0xc0, 0xff]);
});
