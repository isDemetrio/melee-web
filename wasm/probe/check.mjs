// The CI half of the WebGPU probe. Serves wasm/probe over HTTP (module scripts do not load from
// file://), opens webgpu_probe.html in headless Chromium with the software adapter allowed, reads
// window.__probe and fails on anything that is not an answer.
//
// `--enable-unsafe-swiftshader` is what makes a headless runner without a GPU able to answer at
// all: Chrome otherwise refuses to hand out an adapter. The page asks for the fallback adapter
// explicitly for the same reason.
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

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

await page.goto(`http://127.0.0.1:${port}/webgpu_probe.html`);
await page.waitForFunction(() => window.__probe !== undefined, null, { timeout: 60000 });
const probe = await page.evaluate(() => window.__probe);
await browser.close();
server.close();

console.log(JSON.stringify(probe, null, 2));
if (pageErrors.length > 0) {
  console.error('page errors:', pageErrors);
  process.exit(1);
}

const failures = [];
if (probe.cxx !== true) {
  failures.push(`cxx: the Emscripten WebGPU unit did not report the toolchain ok (${JSON.stringify(probe.cxx_lines)})`);
}
if (!probe.device) {
  failures.push(`device: no usable device (adapter: ${JSON.stringify(probe.adapter)})`);
}
if (JSON.stringify(probe.readback) !== JSON.stringify([255, 0, 0, 255])) {
  failures.push(`readback: a red clear came back as ${JSON.stringify(probe.readback)}, expected [255,0,0,255]`);
}
if (probe.canvas !== 'configured and cleared') {
  failures.push(`canvas: ${JSON.stringify(probe.canvas)}`);
}

if (failures.length > 0) {
  console.error('PROBE FAILED');
  for (const failure of failures) console.error(' -', failure);
  process.exit(1);
}
console.log('PROBE OK');
