import type { ResourceCounts } from '../../src/spike/gpu-resources.js';
import { expect, test, type Page } from '@playwright/test';

/**
 * The WebGPU backend, step 1 (`wasm/render/gx_webgpu.cpp`): the clear colour of a frame reaches the
 * XFB target, read back off the GPU.
 *
 * No CI runner has the disc (`docs/AGENT_RULES.md` rule 1), so the game never issues a GX command
 * here: every run in spike.spec.ts stops at the DOL. These tests drive the real FIFO decoder of the
 * real web core instead, through `gx_webgpu_selftest`, with the BP writes a frame ends with -- a
 * 640x480 source rectangle, a clear colour, then clearing XFB copies -- and read pixel (0, 0) of the
 * XFB target back with `copyTextureToBuffer` and `mapAsync`. The worker paints the target with a
 * sentinel first, so a pixel that is not the sentinel was written by the backend.
 *
 * GX copies the EFB to the XFB and only then clears it, so a clear colour is on screen from the next
 * XFB copy on. Two copies must show the colour; one copy must show the EFB before any clear, which
 * WebGPU guarantees is zero.
 *
 * THE GAP: the canvas pixel is not read back in CI. In CI's headless Chromium the device does not
 * survive the end of the first task that takes a canvas texture -- the task whose end commits the
 * canvas frame. Run 36898914442's timeline: buffer round trips pass across several task boundaries
 * while the canvas is configured but untouched; ~0.7 ms after the task that first calls
 * getCurrentTexture yields, the device is lost ("Device was destroyed.") and the pending map aborts
 * ("A valid external Instance reference no longer exists."). Nothing in this repository destroys a
 * device; the self-test calls no callMain, so no runtime exit is involved. So in CI the first two
 * tests render into an offscreen texture (`target=texture`): the same backend, EFB, clear and copy,
 * minus only the canvas commit. The canvas tests below prove in CI what does not need a readback,
 * and the canvas pixel test runs only where SPIKE_CANVAS_READBACK=1 says the GPU survives
 * presenting -- or by hand: a `?canvas` run of the spike page reports the same pixel as
 * `render.readback` in its result JSON.
 *
 * The launch flags were in force in every run that got a device here (36892349174, 36896537472,
 * 36898914442), so they stay.
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
    textureUploads: number;
    lastClearArgb: number | null;
    target: 'canvas' | 'texture' | null;
    readback: number[] | null;
    failure: string | null;
    errors: string[];
    resources: ResourceCounts;
    deviceLoss: { reason: string; message: string } | null;
    diagnostic: { backendUsedThisDevice: boolean; backendCopies: number } | null;
  } | null;
}

/** ARGB, as EfbCopy::clear_color packs it: A=FF R=20 G=80 B=C0. Not black, so not a default. */
const COLOUR = 0xff2080c0;
const COLOUR_RGBA = [0x20, 0x80, 0xc0, 0xff];
const QUERY = `gx-selftest=${COLOUR.toString(16)}`;

/** Open the self-test page and wait for the JSON the worker answers with. */
async function selftest(page: Page, query: string): Promise<SelftestResult> {
  await page.goto(`/spike.html?${query}`);
  // Empty, then "running", then the answer: only the answer is JSON.
  const output = page.locator('#render');
  await expect(output).toHaveText(/^\{/);
  return JSON.parse(await output.innerText()) as SelftestResult;
}

/** The backend attached to a device and replayed `copies` XFB copies of COLOUR with it. */
function expectReplayed(result: SelftestResult, copies: number, target: 'canvas' | 'texture'): void {
  expect(result.error).toBeUndefined();
  expect(result.render?.attached, JSON.stringify(result.render)).toBe(true);
  expect(result.render?.target).toBe(target);
  expect(result.render?.failure).toBeNull();
  expect(result.presented).toBe(copies);
  expect(result.render?.lastClearArgb).toBe(COLOUR);
  expect(result.render?.diagnostic?.backendUsedThisDevice).toBe(true);
  expect(result.render?.diagnostic?.backendCopies).toBe(copies);
}

test('the WebGPU backend copies the clear colour to the XFB target', async ({ page }) => {
  const result = await selftest(page, `${QUERY}&copies=2&target=texture`);
  expectReplayed(result, 2, 'texture');
  // `errors` before the pixel: a failed readback leaves a null pixel and its reason here, and the
  // message carries the worker's timeline and probes (gpu.ts, `Diagnostic`) into the CI log.
  expect(result.render?.errors, JSON.stringify(result.render?.diagnostic, null, 1)).toEqual([]);
  expect(result.render?.readback).not.toEqual(result.sentinel);
  expect(result.render?.readback).toEqual(COLOUR_RGBA);
});

test('one XFB copy shows the EFB as it was before its clear', async ({ page }) => {
  const result = await selftest(page, `${QUERY}&copies=1&target=texture`);
  expectReplayed(result, 1, 'texture');
  expect(result.render?.errors, JSON.stringify(result.render?.diagnostic, null, 1)).toEqual([]);
  // The copy overwrote the sentinel with the EFB's raw bytes: zero, alpha included.
  expect(result.render?.readback).toEqual([0, 0, 0, 0]);
});

test('with a canvas, the backend attaches and replays the copies into it', async ({ page }) => {
  // Everything about the canvas path that needs no readback (see THE GAP above).
  const result = await selftest(page, `${QUERY}&copies=2`);
  console.log('canvas device observation', JSON.stringify(result.render));
  expectReplayed(result, 2, 'canvas');
});

test('the canvas pixel is the clear colour, on a GPU that survives presenting', async ({ page }) => {
  test.skip(process.env.SPIKE_CANVAS_READBACK !== '1',
    'CI Chromium loses the device when the first canvas frame is committed (run 36898914442); see THE GAP');
  const result = await selftest(page, `${QUERY}&copies=2`);
  expectReplayed(result, 2, 'canvas');
  expect(result.render?.errors, JSON.stringify(result.render?.diagnostic, null, 1)).toEqual([]);
  expect(result.render?.readback).not.toEqual(result.sentinel);
  expect(result.render?.readback).toEqual(COLOUR_RGBA);
});

test('without a GPU the decoder runs the same commands and nothing is rendered', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const result = await selftest(page, `${QUERY}&copies=2&nocanvas`);
  expect(result.error).toBeUndefined();
  expect(result.render).toBeNull();
  expect(result.presented).toBe(0);
  expect(errors).toEqual([]);
});

// All expected geometry colors differ from both the clear and the sentinel. Removing draw
// submission fails the green probe; disabling depth makes the last (blue) triangle win.
for (const [name, geometry, x, expected] of [
  ['transformed triangle with reversed depth', 1, 320, [0, 255, 0, 255]],
  ['unsupported points are skipped', 5, 320, COLOUR_RGBA],
  ['outside the triangle', 1, 600, COLOUR_RGBA],
  ['scissor excludes the triangle probe', 2, 320, COLOUR_RGBA],
  ['front culling excludes the clockwise triangle', 3, 320, COLOUR_RGBA],
  // The green layer is 72,003 vertices: the batch is submitted mid-frame and the vertex and index
  // arenas are replaced (the old ones destroyed) after the draw that used them was submitted.
  // Writes landing in the wrong draw, or at the wrong offset, lose the green.
  ['buffers grown between submitted draws', 6, 320, [0, 255, 0, 255]],
] as const) {
  test(`geometry: ${name}`, async ({ page }) => {
    const result = await selftest(page, `${QUERY}&copies=2&target=texture&geometry=${geometry}&sample-x=${x}`);
    expectReplayed(result, 3, 'texture');
    expect(result.render?.errors, JSON.stringify(result.render?.diagnostic, null, 1)).toEqual([]);
    expect(result.render?.readback).toEqual(expected);
  });
}

test('geometry also submits through the canvas path without readback assertions', async ({ page }) => {
  expectReplayed(await selftest(page, `${QUERY}&copies=2&geometry=1`), 3, 'canvas');
});

// These probes cannot pass with the white fallback or a vertex-only fragment shader.
// Bytes are real GX tiles/TLUTs, decoded by the linked upstream CPU decoder.
for (const [name, geometry, expected] of [
  ['I4', 10, [136, 136, 136, 136]],
  ['I8', 11, [128, 128, 128, 128]],
  ['IA4', 12, [136, 136, 136, 170]],
  ['IA8', 13, [128, 128, 128, 192]],
  ['RGB565', 14, [0, 255, 0, 255]],
  ['RGB5A3', 15, [255, 0, 255, 255]],
  ['RGBA8 AR/GB repack', 16, [128, 64, 32, 192]],
  ['C4 with RGB565 TLUT', 17, [0, 255, 0, 255]],
  ['C8 with RGB565 TLUT', 18, [0, 255, 0, 255]],
  ['C14X2 with RGB565 TLUT', 19, [0, 255, 0, 255]],
  ['CMPR interpolated endpoint', 20, [170, 0, 85, 255]],
  // GX's integer MODULATE (gx_wgsl.cpp): a colour of 128 scales by 129/256 and the colour lerp
  // rounds with +128, so red is (128 * 129 + 128) >> 8 = 65 where a float product gives 64; alpha
  // has no lerp bias, (192 * 129) >> 8 = 96.
  ['RGBA8 MODULATE including alpha', 30, [65, 32, 16, 96]],
  ['new image snapshot at the same address/hash', 31, [32, 64, 32, 192]],
  ['new TLUT snapshot at the same address/hash', 32, [255, 0, 0, 255]],
  ['RGBA8 mip 1 with LOD clamps', 33, [128, 192, 32, 192]],
  ['clamp to edge', 34, [32, 64, 32, 192]],
  ['repeat', 35, [128, 64, 32, 192]],
  ['mirror repeat', 36, [32, 64, 32, 192]],
  ['linear magnification across a tile boundary', 37, [80, 64, 32, 192]],
] as const) {
  test(`texture: ${name}`, async ({ page }) => {
    const result = await selftest(page, `${QUERY}&copies=2&target=texture&geometry=${geometry}&sample-x=320`);
    expectReplayed(result, 3, 'texture');
    expect(result.render?.errors, JSON.stringify(result.render?.diagnostic, null, 1)).toEqual([]);
    expect(result.render?.readback).toEqual(expected);
  });
}

// Samplers and bind groups are cached by mode (gx_webgpu.cpp, gxw_texture and gxw_draw). Layers 0
// and 2 clamp, the visible layer 1 repeats, in one task: a key that ignored the wrap bits would
// hand layer 1 the clamp sampler, or a bind group holding it, and read back the clamp pixel
// [32, 64, 32, 192] instead.
test('texture: a cached sampler is not reused for another wrap mode', async ({ page }) => {
  const result = await selftest(page, `${QUERY}&copies=2&target=texture&geometry=38&sample-x=320`);
  expectReplayed(result, 3, 'texture');
  expect(result.render?.errors, JSON.stringify(result.render?.diagnostic, null, 1)).toEqual([]);
  expect(result.render?.readback).toEqual([128, 64, 32, 192]);
  expect(result.render?.resources.sampler.created).toBe(2);
  expect(result.render?.resources.bindGroup.created).toBe(2); // layers 0 and 2 share one
});

// Real backend, one synchronous task, no disc. 800 repetitions yield 2400 XFB copies.
// This tests submitted work and its pixel, not 2400 browser presentation tasks or the game.
for (const repeats of [128, 800]) {
  test(`resources stay bounded through ${repeats * 3} synchronous textured draws`, async ({ page }) => {
    const copies = repeats * 3;
    const result = await selftest(page, `${QUERY}&copies=2&target=texture&geometry=16&repeats=${repeats}`);
    console.log('synchronous resource result', JSON.stringify(result.render));
    expectReplayed(result, copies, 'texture');
    expect(result.render?.errors).toEqual([]);
    expect(result.render?.deviceLoss).toBeNull();
    expect(result.render?.readback).toEqual([128, 64, 32, 192]);
    const resources = result.render!.resources;
    // Nothing scales with the draw count. Every draw binds one snapshot in all eight slots
    // (mode0=mode1=0), so after the first draw everything is a pool or cache hit, and the texture
    // is decoded and written once: the per-draw rewrite was 117 MB per in-match frame (9b08acf).
    expect(resources.sampler.created).toBe(1);
    expect(resources.bindGroup.created).toBe(1);
    // This draw state's pipeline, and the one gxw_prepare makes when the backend attaches (the one
    // shader's most drawn state, gx_webgpu.cpp): neither depends on the draw count.
    expect(resources.pipeline.created).toBe(2);
    expect(result.render?.textureUploads).toBe(1);
    expect(resources.texture.created).toBe(1 + 4); // the one content; XFB, EFB, depth, white
    expect(resources.texture.destroyed).toBe(0);
    expect(resources.texture.outstanding).toBe(5);
    expect(resources.texture.peakOutstanding).toBe(5);
    expect(resources.buffer.created).toBe(3 + 5); // uniform, vertex, index; four probes + readback
    expect(resources.buffer.destroyed).toBe(5);
    expect(resources.buffer.outstanding).toBe(3);
    expect(resources.buffer.peakOutstanding).toBe(5); // the readback and last probe overlap
    for (const count of Object.values(resources)) expect(count.failed).toBe(0);
  });
}

// Geometry 39 is geometry 16 with a new snapshot for every layer of every repetition, so 1200
// draws ask for 1200 contents: past the pool's 1024 the least recently used are evicted and
// destroyed while draws that used them are already submitted. Evicting a texture the current draw
// still binds, or forgetting the snapshot of one still pooled, shows up as a validation error or
// a wrong pixel here.
test('texture pool evicts past its limit without breaking submitted draws', async ({ page }) => {
  const result = await selftest(page, `${QUERY}&copies=2&target=texture&geometry=39&repeats=400`);
  expectReplayed(result, 1200, 'texture');
  expect(result.render?.errors, JSON.stringify(result.render?.diagnostic, null, 1)).toEqual([]);
  expect(result.render?.deviceLoss).toBeNull();
  expect(result.render?.readback).toEqual([128, 64, 32, 192]);
  const resources = result.render!.resources;
  expect(result.render?.textureUploads).toBe(1200); // a new snapshot is a new content
  expect(resources.texture.created).toBe(1200 + 4);
  expect(resources.texture.destroyed).toBe(1200 - 1024); // TEXTURE_POOL_LIMIT in gx_webgpu.cpp
  for (const count of Object.values(resources)) expect(count.failed).toBe(0);
});
