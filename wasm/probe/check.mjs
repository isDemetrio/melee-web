// The CI half of the WebGPU probe. Serves wasm/probe over HTTP (module scripts do not load from
// file://), opens webgpu_probe.html in headless Chromium, reads window.__probe and fails on
// anything that is not an answer.
//
// WHY THERE IS MORE THAN ONE LAUNCH CONFIGURATION. Four runs of this workflow answered "null (no
// adapter, hardware or fallback)": 36876533202 with `--enable-unsafe-swiftshader` alone, 36883720514
// (the same commit, dispatched by hand), 36895365217 with the flag still there, and 36897513498
// with no launch flags at all. The harness that works is the one this repository already runs:
// `web/tests/spike/render.spec.ts` asks headless Chromium in CI for a device and gets one, and it
// reads pixels back off the GPU (runs 36892349174, 36896537472, 36898914442, and 36901465493 — the
// last on merged `main`), with
//
//   launchOptions: { args: ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu'] }
//
// Two flags, and `--enable-unsafe-webgpu` is the one both failing configurations lacked. Run
// 36909581289 confirms it: with both flags, this workflow gets `google swiftshader` as the adapter
// and a device, in both launch configurations below. That run also left the second question open —
// see webgpu_probe.html, "THE ORDER IS THE MEASUREMENT".
//
// The two configurations are the one variable the two harnesses still differ by: Playwright
// launches the `chromium-headless-shell` build for `headless: true` unless a channel is named
// (microsoft/playwright#33566), while `channel: 'chromium'` selects the new headless mode on the
// full Chromium build. The check passes if any configuration answers everything, and it prints
// every configuration's answer either way, so a failure is a measurement rather than a shrug.
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

/** The colour the page clears a texture to before the C++ module runs, and the one it reads back. */
const RED = [255, 0, 0, 255];
/** The colour of the readback taken after the module has run and exited. */
const BLUE = [0, 0, 255, 255];

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
  if (JSON.stringify(result.readback_before_module) !== JSON.stringify(RED)) {
    missing.push(`the red clear came back as ${JSON.stringify(result.readback_before_module)}, expected ${JSON.stringify(RED)}`);
  }
  if (result.canvas !== 'configured and cleared') missing.push(`canvas: ${JSON.stringify(result.canvas)}`);
  if (result.pageErrors.length > 0) missing.push(`page errors: ${JSON.stringify(result.pageErrors)}`);
  return missing;
}

/**
 * What one configuration answered about the module's effect on the device — the measurement
 * webgpu_probe.html was reordered for, printed rather than asserted: the expected value is what is
 * being measured, and a difference is a finding about this harness, not a failed probe.
 */
function diagnostics(result) {
  if (result.failed_to_open) return [];
  return [
    `order: ${JSON.stringify(result.order)}`,
    `adapter: ${JSON.stringify(result.adapter)}; device: ${JSON.stringify(result.device)}`,
    `readback before the module: ${JSON.stringify(result.readback_before_module)}`,
    `readback after the module: ${JSON.stringify(result.readback_after_module)} (expected ${JSON.stringify(BLUE)})`,
    `canvas: ${JSON.stringify(result.canvas)}`,
    `device lost: ${JSON.stringify(result.device_lost)}`,
    `error: ${JSON.stringify(result.error)}`,
  ];
}

const results = [];
for (const configuration of CONFIGURATIONS) {
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
console.log(`  adapter: ${winner.adapter}; readback: ${JSON.stringify(winner.readback_before_module)}; canvas: ${winner.canvas}`);
