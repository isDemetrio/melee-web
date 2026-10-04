#!/usr/bin/env node
// The pixel pipeline of the WebGPU backend -- the TEV, fog and alpha test gx_wgsl.cpp generates, and
// the blend state gx_webgpu.cpp sets -- read back off a real WebGPU device: CI's headless Chromium,
// the same page, launch flags and readback as web/tests/spike/render.spec.ts. phase0-build.yml runs
// it after the spike page is built. (It was alpha_blend_check.mjs, with probes 15 and 40-44 only.)
//
// Why it is not in render.spec.ts: it was written while web/ was being changed by another pull
// request (#90), and the probes need nothing from web/ but its built page, its static server and its
// installed Playwright. Moving these cases into render.spec.ts later is a copy, not a rewrite.
//
// What the alpha probes prove. Geometry 40-44 draw a magenta RGB5A3 texture
// through the real backend; the alpha test, the blend state or the colour write mask must remove it:
//   - alpha 0 behind a test GREATER 0, or under SRC_ALPHA / INV_SRC_ALPHA blending, and opaque
//     magenta with colour update off, must leave the clear colour;
//   - alpha 146 must blend once with the clear colour (not vanish: the blend is not "discard all"),
//     and must fail a test GREATER 200 (the reference is read).
// A backend that ignores alpha -- the one before this check existed -- draws magenta in every probe;
// geometry 15 is that magenta texture opaque, with GXInit state, and must still draw it.
//
// What the TEV probes prove (geometry 45-48; gx_webgpu_selftest says what each draws). Each is a
// state the backend drew as vertex colour x texture 0 before the TEV was generated, and each
// expected pixel is something else: the in-match name tag's plate (KONST colour, alpha from a TEV
// register, blended) and its glyphs (KONST x an I8 texture), two stages through an unclamped
// register with a swap table, a scale, a subtraction and per-component compares, and fog. The values
// are GX's integer arithmetic (gx_wgsl.cpp's transcription of upstream's), computed by hand and by a
// separate CPU model of the same code.
//
// Geometry 50 is the source those stages read when the game renders to a texture (its fighters'
// shadows): an EFB copy kept on the GPU and sampled at its guest address.
//
// Geometry 51 is the depth tolerance that keeps the game's shadow backdrop quad: a triangle a float
// beyond the near plane must still be drawn.
//
// Geometry 56 is a lit colour channel: the in-game draws whose TEV adds a lit channel (Yoshi's
// Island's blocks, the Classic map's markers) drew white while a lit channel was given its material.
//
// Geometry 49 is not a value: it draws 48 pseudo-random register states per call (192 here), and
// passes when none of the shaders they generate is rejected. A WGSL generator that emits invalid code
// for some combination of stages, inputs, compares, swaps, texgens, fog or lit channels fails it.
//
// usage: SPIKE_DIST=<built spike dist> node wasm/render/pixel_pipeline_check.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dist = process.env.SPIKE_DIST;
if (!dist) throw new Error('SPIKE_DIST must point at a page built by phase0-build.yml');
const web = fileURLToPath(new URL('../../web/', import.meta.url));
// Playwright is installed in web/ (npm ci in phase0-build.yml); resolve it from there.
const { chromium } = createRequire(`${web}package.json`)('@playwright/test');

const PORT = 4176;
const CLEAR = [0x20, 0x80, 0xc0, 0xff]; // ARGB ff2080c0, as render.spec.ts
const PROBES = [
  { geometry: 15, name: 'opaque magenta, GXInit state: drawn', expected: [255, 0, 255, 255] },
  { geometry: 40, name: 'alpha 0, test GREATER 0: discarded', expected: CLEAR },
  { geometry: 41, name: 'alpha 0, blend SRC_ALPHA/INV_SRC_ALPHA: invisible', expected: CLEAR },
  // (255,0,255) a=146/255 over (32,128,192,255): 159.7, 54.7, 228.1, alpha 146^2/255+109 = 192.6.
  { geometry: 42, name: 'alpha 146, same blend: one blend over the clear', expected: [160, 55, 228, 193], tolerance: 1 },
  { geometry: 43, name: 'alpha 146, test GREATER 200: discarded', expected: CLEAR },
  { geometry: 44, name: 'opaque magenta, colour update off: not written', expected: CLEAR },
  // K0 (242,89,89) at alpha 128/255 over (32,128,192,255): 137.4, 108.4, 140.3, alpha 191.3.
  { geometry: 45, name: 'name tag plate: KONST colour, C0 alpha, blended once', expected: [137, 108, 140, 191], tolerance: 1 },
  // (242 * 129 + 128) >> 8 = 122, (89 * 129 + 128) >> 8 = 45, alpha (255 * 129) >> 8 = 128.
  { geometry: 46, name: 'name tag glyphs: KONST x I8 texture, A0 x TEXA', expected: [122, 45, 45, 128] },
  { geometry: 47, name: 'two stages: unclamped C1, swap, scale, subtract, compares', expected: [23, 0, 0, 223] },
  // MODULATE (128,64,32,192), then (c * 128 + fog * 128) >> 8 with fog colour (40,240,80).
  { geometry: 48, name: 'linear fog of density 0.5, C sign at bit 19', expected: [84, 152, 56, 192] },
  { geometry: 49, name: '192 pseudo-random pixel pipeline states compile', repeats: 4, expected: null },
  // The copied 4x4 of the green triangle, not the RGBA8 snapshot (128,64,32,192) at that address.
  { geometry: 50, name: 'EFB copy to a texture, sampled by a later draw at its address', expected: [0, 255, 0, 255] },
  { geometry: 51, name: 'a triangle 2^-23 beyond the near plane is drawn (Dolphin 1 - 1e-7)', expected: [0, 255, 0, 255] },
  // Ambient 50 + light 100 facing the normal = 150; material 200 * (150 + 1) >> 8 = 117. Unlit: 200.
  { geometry: 56, name: 'a lit colour channel: ambient plus a light facing the normal, times the material', expected: [117, 117, 117, 255] },
];

const server = spawn(process.execPath, [`${web}scripts/serve.mjs`, '--dir', dist, '--port', String(PORT)],
  { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.once('exit', (code) => reject(new Error(`static server exited with ${code}`)));
  server.stdout.on('data', (chunk) => { if (String(chunk).includes('serving')) resolve(); });
});

let failures = 0;
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu'] });
try {
  const page = await browser.newPage();
  for (const probe of PROBES) {
    const repeats = probe.repeats ?? 1;
    await page.goto(`http://127.0.0.1:${PORT}/spike.html?gx-selftest=ff2080c0&copies=2&target=texture&geometry=${probe.geometry}&sample-x=320&repeats=${repeats}`);
    // Empty, then "running", then the answer: only the answer is JSON.
    // The sweep compiles a shader per state on SwiftShader, so it may take minutes, not seconds.
    const text = await page.locator('#render').filter({ hasText: /^\{/ }).innerText({ timeout: probe.expected ? 110_000 : 420_000 });
    const result = JSON.parse(text);
    const render = result.render ?? {};
    const pixel = render.readback;
    const problems = [];
    if (result.error !== undefined) problems.push(`error ${result.error}`);
    if (render.attached !== true) problems.push(`not attached (${render.reason})`);
    if (render.failure !== null) problems.push(`backend failure ${render.failure}`);
    if (!Array.isArray(render.errors) || render.errors.length) problems.push(`WebGPU errors ${JSON.stringify(render.errors)}`);
    if (result.presented !== 3 * repeats) problems.push(`presented ${result.presented}, want ${3 * repeats}`);
    const tolerance = probe.tolerance ?? 0;
    if (probe.expected && (!Array.isArray(pixel) || pixel.length !== 4 || pixel.some((v, i) => Math.abs(v - probe.expected[i]) > tolerance))) {
      problems.push(`pixel ${JSON.stringify(pixel)}, want ${JSON.stringify(probe.expected)}${tolerance ? ` +-${tolerance}` : ''}`);
    }
    console.log(`${problems.length ? 'FAIL' : 'ok  '} geometry ${probe.geometry} ${probe.name}: ${JSON.stringify(pixel)}`);
    for (const problem of problems) console.log(`       ${problem}`);
    failures += problems.length ? 1 : 0;
  }
} finally {
  await browser.close();
  server.kill();
}
if (failures) {
  console.error(`${failures} of ${PROBES.length} pixel pipeline probes failed`);
  process.exit(1);
}
console.log(`all ${PROBES.length} pixel pipeline probes passed`);
