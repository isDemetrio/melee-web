#!/usr/bin/env node
// The alpha test and blending of the WebGPU backend (gx_webgpu.cpp, gxw_draw), read back off a real
// WebGPU device: CI's headless Chromium, the same page, launch flags and readback as
// web/tests/spike/render.spec.ts. phase0-build.yml runs it after the spike page is built.
//
// Why it is not in render.spec.ts: it was written while web/ was being changed by another pull
// request (#90), and the probes need nothing from web/ but its built page, its static server and its
// installed Playwright. Moving these cases into render.spec.ts later is a copy, not a rewrite.
//
// What it proves. The probes (gx_webgpu_selftest geometry 40-44) draw a magenta RGB5A3 texture
// through the real backend; the alpha test, the blend state or the colour write mask must remove it:
//   - alpha 0 behind a test GREATER 0, or under SRC_ALPHA / INV_SRC_ALPHA blending, and opaque
//     magenta with colour update off, must leave the clear colour;
//   - alpha 146 must blend once with the clear colour (not vanish: the blend is not "discard all"),
//     and must fail a test GREATER 200 (the reference is read).
// A backend that ignores alpha -- the one before this check existed -- draws magenta in every probe;
// geometry 15 is that magenta texture opaque, with GXInit state, and must still draw it.
//
// usage: SPIKE_DIST=<built spike dist> node wasm/render/alpha_blend_check.mjs
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
    await page.goto(`http://127.0.0.1:${PORT}/spike.html?gx-selftest=ff2080c0&copies=2&target=texture&geometry=${probe.geometry}&sample-x=320`);
    // Empty, then "running", then the answer: only the answer is JSON.
    const text = await page.locator('#render').filter({ hasText: /^\{/ }).innerText({ timeout: 110_000 });
    const result = JSON.parse(text);
    const render = result.render ?? {};
    const pixel = render.readback;
    const problems = [];
    if (result.error !== undefined) problems.push(`error ${result.error}`);
    if (render.attached !== true) problems.push(`not attached (${render.reason})`);
    if (render.failure !== null) problems.push(`backend failure ${render.failure}`);
    if (!Array.isArray(render.errors) || render.errors.length) problems.push(`WebGPU errors ${JSON.stringify(render.errors)}`);
    if (result.presented !== 3) problems.push(`presented ${result.presented}, want 3`);
    const tolerance = probe.tolerance ?? 0;
    if (!Array.isArray(pixel) || pixel.length !== 4 || pixel.some((v, i) => Math.abs(v - probe.expected[i]) > tolerance)) {
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
  console.error(`${failures} of ${PROBES.length} alpha/blend probes failed`);
  process.exit(1);
}
console.log(`all ${PROBES.length} alpha/blend probes passed`);
