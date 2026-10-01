import { expect, test, type Page } from '@playwright/test';

/**
 * The WebGPU backend, step 1 (`wasm/render/gx_webgpu.cpp`): the clear colour of a frame reaches the
 * canvas, read back off the GPU.
 *
 * No CI runner has the disc (`docs/AGENT_RULES.md` rule 1), so the game never issues a GX command
 * here: every run in spike.spec.ts stops at the DOL. These tests drive the real FIFO decoder of the
 * real web core instead, through `gx_webgpu_selftest`, with the BP writes a frame ends with -- a
 * 640x480 source rectangle, a clear colour, then clearing XFB copies -- and read pixel (0, 0) of the
 * canvas's current texture back with `copyTextureToBuffer`. The worker paints that texture with a
 * sentinel first, so a pixel that is not the sentinel was written by the backend.
 *
 * GX copies the EFB to the XFB and only then clears it, so a clear colour is on screen from the next
 * XFB copy on. Two copies must show the colour; one copy must show the EFB before any clear, which
 * WebGPU guarantees is zero.
 *
 * The flags below were in force when CI first got a device here (run 36892349174, commit 54800cd:
 * `render.attached` was true, the failure was a readback, not an adapter). The probe of PR #47
 * reports no adapter with the same two flags in its own launch, so the difference lies in how that
 * probe launches Chromium, not in these flags; they stay until a run without them says otherwise.
 *
 * `errors` is asserted before any pixel: a readback that fails returns a null pixel, and the reason
 * is in `errors`, not in the pixel (run 36892349174's second test reported only `Received: null`).
 */
test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu'] } });

interface SelftestResult {
  error?: string;
  presented: number | null;
  sentinel: number[];
  render: {
    attached: boolean;
    reason: string;
    presented: number;
    lastClearArgb: number | null;
    pixel: number[] | null;
    failure: string | null;
    errors: string[];
  } | null;
}

/** Open the self-test page and wait for the JSON the worker answers with. */
async function selftest(page: Page, query: string): Promise<SelftestResult> {
  await page.goto(`/spike.html?${query}`);
  // Empty, then "running", then the answer: only the answer is JSON.
  const output = page.locator('#render');
  await expect(output).toHaveText(/^\{/);
  return JSON.parse(await output.innerText()) as SelftestResult;
}

/** ARGB, as EfbCopy::clear_color packs it: A=FF R=20 G=80 B=C0. Not black, so not a default. */
const COLOUR = 0xff2080c0;
const COLOUR_RGBA = [0x20, 0x80, 0xc0, 0xff];

test('the WebGPU backend presents the clear colour on the canvas', async ({ page }) => {
  const result = await selftest(page, `gx-selftest=${COLOUR.toString(16)}&copies=2`);
  expect(result.error).toBeUndefined();
  expect(result.render?.attached, JSON.stringify(result.render)).toBe(true);
  expect(result.render?.errors).toEqual([]);
  expect(result.render?.failure).toBeNull();
  expect(result.presented).toBe(2);
  expect(result.render?.lastClearArgb).toBe(COLOUR);
  expect(result.render?.pixel).not.toEqual(result.sentinel);
  expect(result.render?.pixel).toEqual(COLOUR_RGBA);
});

test('one XFB copy presents the EFB as it was before its clear', async ({ page }) => {
  const result = await selftest(page, `gx-selftest=${COLOUR.toString(16)}&copies=1`);
  expect(result.error).toBeUndefined();
  expect(result.render?.attached, JSON.stringify(result.render)).toBe(true);
  expect(result.render?.errors).toEqual([]);
  expect(result.render?.failure).toBeNull();
  expect(result.presented).toBe(1);
  // The copy overwrote the sentinel with the EFB's raw bytes: zero, alpha included. alphaMode
  // 'opaque' governs how the canvas is composited, not what its texture holds.
  expect(result.render?.pixel).toEqual([0, 0, 0, 0]);
});

test('without a canvas the decoder runs the same commands and nothing is rendered', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const result = await selftest(page, `gx-selftest=${COLOUR.toString(16)}&copies=2&nocanvas`);
  expect(result.error).toBeUndefined();
  expect(result.render).toBeNull();
  expect(result.presented).toBe(0);
  expect(errors).toEqual([]);
});
