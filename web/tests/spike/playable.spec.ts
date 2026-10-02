import { expect, test, type Page } from '@playwright/test';

test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu'] } });

/** The selftest clears to ARGB 0xff2080c0; read back as RGBA. */
const COLOUR_RGBA = [0x20, 0x80, 0xc0, 0xff];

interface Presentation {
  /** Word PRESENTED of the shared pad: the page stores a serial only after presenting it. */
  presented: number | null;
  /** Every frame message, read from its ImageBitmap before the page's handler presents it. */
  frames: { serial: number; width: number; height: number; pixel: number[] }[];
}

/**
 * Plays the core's synthetic GX selftest through the main page's real worker and presenter: no
 * disc data in CI.
 *
 * The canvas is not read back. It is a `bitmaprenderer` canvas, and each frame is checked at the
 * ImageBitmap the presenter is handed instead. In CI that bitmap is already transparent black
 * (run 37059095321: all three frames [0, 0, 0, 0], with PRESENTED = 3), which is the canvas commit
 * of render.spec.ts's THE GAP -- so CI asserts the presentation, and the pixel test below runs
 * only where SPIKE_CANVAS_READBACK=1 says the GPU survives presenting.
 */
async function playSelftest(page: Page): Promise<Presentation> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const probe = window as unknown as { padWords?: Int32Array; frames?: unknown[] };
    probe.frames = [];
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        // Registered before the page sets `onmessage`, so it runs first, while the bitmap is
        // still the page's to read and not yet transferred into the canvas.
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
        if (request.pad) {
          request.selftest = true;
          probe.padWords = new Int32Array(request.pad);
        }
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
  return page.evaluate(() => {
    const probe = window as unknown as { padWords?: Int32Array; frames: Presentation['frames'] };
    // 13 is PRESENTED (web/src/play/shared-pad.ts).
    return { presented: probe.padWords ? Atomics.load(probe.padWords, 13) : null, frames: probe.frames };
  });
}

test('main page presents consecutive real core frames while worker stays synchronous', async ({ page }) => {
  const { presented, frames } = await playSelftest(page);
  // Three heartbeats, each a 640x480 bitmap, in order. The worker blocks after each until the
  // page acknowledges that serial, so reaching "ended" at all needs every acknowledgement. Each
  // selftest frame also draws three triangles, whose -1 beats must not present (worker.ts).
  expect(frames.map(({ serial, width, height }) => ({ serial, width, height }))).toEqual(
    [1, 2, 3].map((serial) => ({ serial, width: 640, height: 480 })));
  // The acknowledgement follows a transferFromImageBitmap that did not throw (session.ts).
  expect(presented).toBe(3);
});

test('the presented frames carry the selftest colour, on a GPU that survives presenting', async ({ page }) => {
  test.skip(process.env.SPIKE_CANVAS_READBACK !== '1',
    'CI Chromium hands the page transparent frames (run 37059095321); see render.spec.ts, THE GAP');
  const { frames } = await playSelftest(page);
  expect(frames.map((frame) => frame.pixel)).toEqual([COLOUR_RGBA, COLOUR_RGBA, COLOUR_RGBA]);
});
