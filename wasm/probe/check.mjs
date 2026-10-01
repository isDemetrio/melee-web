// The CI half of the WebGPU probe. Serves wasm/probe over HTTP (module scripts do not load from
// file://), opens webgpu_probe.html in headless Chromium, reads window.__probe and fails on
// anything that is not an answer.
//
// THE LAUNCH FLAGS. Four runs answered "null (no adapter, hardware or fallback)": 36876533202 with
// `--enable-unsafe-swiftshader` alone, 36883720514 (the same commit, dispatched by hand), 36895365217
// with the flag still there, and 36897513498 with no launch flags at all. The harness that works is
// the one this repository already runs: `web/tests/spike/render.spec.ts` asks headless Chromium in CI
// for a device and gets one, with
//
//   launchOptions: { args: ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu'] }
//
// Two flags, and `--enable-unsafe-webgpu` is the one both failing configurations lacked. Run
// 36909581289 confirms it: with both flags this workflow gets `google swiftshader` as the adapter and
// a device, in both launch configurations below.
//
// THE REALM. With the flags fixed, runs 36909581289, 36910340139 and 36911030437 all lost the device
// on the page's main thread at the first task boundary after GPU work -- a texture the page had just
// cleared read back [0,0,0,0], `device.lost` said "destroyed: Device was destroyed." and the canvas
// configure threw "A valid external Instance reference no longer exists."; run 36911030437's timeline
// puts the death at 62 ms, 47 ms into the first await, with the objects rooted and the page painting
// four frames. The browser half therefore runs in a worker (webgpu_probe_worker.js), which is where
// this repository's own CI readback gets its colour back (runs 36892349174, 36896537472, 36898914442,
// 36901465493). The probe answers in the realm the renderer runs in, or it answers nothing.
//
// THE ZEROS WERE THE HARNESS (run 36912403273). In the worker the readback still read [0,0,0,0], and
// the cause was this probe's own copy, not the GPU: the whole 4x4 texture copied with
// `bytesPerRow: 256` into a 256-byte buffer is a copy WebGPU rejects (four rows need 256 * 3 + 16 =
// 784 bytes), and it rejects it with a validation error, which neither throws nor stops the run. The
// buffer stayed zero and the probe read a plausible [0,0,0,0] off it. The copy is now the one
// `gpu.ts`'s `readPixel` makes and CI returns the colour from, the probe reports uncaptured GPU
// errors instead of reading them as answers, and it round-trips a buffer first, so "the device is
// dead" and "the copy is wrong" cannot be confused again.
//
// WHAT IS REQUIRED, AND WHAT IS ONLY MEASURED. Required: the C++ half reports the toolchain ok, a
// device exists, the texture readback is the colour the probe cleared to, the canvas configures and
// clears, and no uncaptured error was raised. Measured but not required: whether the device survives
// the canvas frame's commit. CI's Chromium does not survive it -- run 36912403273 lost it 1.2 ms
// after the task that committed the frame, the same failure `render.spec.ts` records as "THE GAP" and
// routes around with an offscreen texture target -- and the canvas pixel is therefore left to a real
// device, exactly as the renderer's own tests leave it.
//
// The two configurations are the remaining variable: Playwright launches the `chromium-headless-shell`
// build for `headless: true` unless a channel is named (microsoft/playwright#33566), while
// `channel: 'chromium'` selects the new headless mode on the full Chromium build. The check passes if
// any configuration answers everything, and it prints every configuration's answer either way, so a
// failure is a measurement rather than a shrug.
//
// Run from anywhere: the served directory is derived from this file's own URL, so the workflow can
// run it with the working directory set to wherever Playwright was installed.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = fileURLToPath(new URL('.', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

const server = createServer(async (request, response) => {
  const requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const relative = normalize(requested).replace(/^[/\\]+/, '') || 'webgpu_probe.html';
  const path = join(root, relative);
  if (!path.startsWith(root)) {
    response.writeHead(403).end('outside the probe directory');
    return;
  }
  try {
    const body = await readFile(path);
    response.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

/** The colour the worker clears a texture to, and the one it reads back off the GPU. */
const RED = [255, 0, 0, 255];

const CONFIGURATIONS = [
  {
    name: 'Playwright default (chromium-headless-shell) + --enable-unsafe-swiftshader --enable-unsafe-webgpu',
    launch: { args: ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu'] },
  },
  {
    name: 'channel chromium (new headless, full build) + --enable-unsafe-swiftshader --enable-unsafe-webgpu',
    launch: { channel: 'chromium', args: ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu'] },
  },
];

/** Open the probe page in one launch configuration and return everything it answered. */
async function probeWith(configuration) {
  let browser;
  try {
    browser = await chromium.launch(configuration.launch);
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/webgpu_probe.html`);
    await page.waitForFunction(() => window.__probe !== undefined, null, { timeout: 60000 });
    const probe = await page.evaluate(() => window.__probe);
    const environment = await page.evaluate(() => ({
      navigator_gpu: typeof navigator.gpu !== 'undefined',
      user_agent: navigator.userAgent,
    }));
    return { name: configuration.name, browser_version: browser.version(), ...environment, ...probe, pageErrors };
  } catch (error) {
    return { name: configuration.name, failed_to_open: String(error), pageErrors: [] };
  } finally {
    if (browser) await browser.close();
  }
}

/** What one configuration did not answer. Empty means it answered everything. */
function shortfalls(result) {
  if (result.failed_to_open) return [`could not open the page: ${result.failed_to_open}`];
  const missing = [];
  if (result.cxx !== true) {
    missing.push(`cxx: the Emscripten WebGPU unit did not report the toolchain ok (${JSON.stringify(result.cxx_lines)})`);
  }
  if (result.navigator_gpu !== true) missing.push('navigator.gpu is undefined in this browser');
  if (!result.device) missing.push(`no usable device (adapter: ${JSON.stringify(result.adapter)})`);
  if (result.round_trip !== 'ok') {
    missing.push(`a buffer round trip that touches no texture came back ${JSON.stringify(result.round_trip)}`);
  }
  if (JSON.stringify(result.readback) !== JSON.stringify(RED)) {
    missing.push(`the red clear came back as ${JSON.stringify(result.readback)}, expected ${JSON.stringify(RED)}`);
  }
  if (result.canvas !== 'configured and cleared') missing.push(`canvas: ${JSON.stringify(result.canvas)}`);
  // A rejected command is a validation error, and a validation error is not an answer.
  if (result.errors?.length > 0) missing.push(`uncaptured GPU errors: ${JSON.stringify(result.errors)}`);
  if (result.pageErrors.length > 0) missing.push(`page errors: ${JSON.stringify(result.pageErrors)}`);
  return missing;
}

/** Everything the run measured, printed whether it passed or not. */
function diagnostics(result) {
  if (result.failed_to_open) return [];
  return [
    `realm: ${JSON.stringify(result.realm)}`,
    `timeline: ${JSON.stringify(result.timeline)}`,
    `adapter: ${JSON.stringify(result.adapter)}; device: ${JSON.stringify(result.device)}`,
    `buffer round trip: ${JSON.stringify(result.round_trip)}`,
    `readback: ${JSON.stringify(result.readback)}`,
    `canvas: ${JSON.stringify(result.canvas)}; commit: ${JSON.stringify(result.canvas_commit)}`,
    `uncaptured errors: ${JSON.stringify(result.errors)}`,
    `device lost: ${JSON.stringify(result.device_lost)}`,
    `error: ${JSON.stringify(result.error)}`,
  ];
}

const results = [];
for (const configuration of CONFIGURATIONS) {
  console.log(`--- ${configuration.name}`);
  const result = await probeWith(configuration);
  results.push(result);
  console.log(JSON.stringify(result, null, 2));
}
server.close();

console.log('--- WebGPU probe: one block per launch configuration ---');
for (const result of results) {
  const missing = shortfalls(result);
  console.log(`${missing.length === 0 ? 'OK  ' : 'FAIL'} ${result.name}`);
  for (const reason of missing) console.log(`       - ${reason}`);
  for (const line of diagnostics(result)) console.log(`       . ${line}`);
}

const winner = results.find((result) => shortfalls(result).length === 0);
if (!winner) {
  console.error('PROBE FAILED: no launch configuration answered every question');
  process.exit(1);
}

console.log('PROBE OK');
console.log(`  configuration: ${winner.name}`);
console.log(`  browser: ${winner.browser_version} (${winner.user_agent})`);
console.log(`  realm: ${winner.realm}; adapter: ${winner.adapter}; readback: ${JSON.stringify(winner.readback)}; canvas: ${winner.canvas}`);
console.log(`  canvas commit: ${winner.canvas_commit}`);
