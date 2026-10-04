// Drives bench-worker.js in one browser: each mode in its own browser process, so a wedged GPU
// process (the one shader's first textured draw, #104) cannot hold the next mode's numbers hostage.
// usage: node run.mjs <chromium|webkit> <states.json> <uber-loop.json> <uber-unrolled.json> <out.json>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(path.join(process.cwd(), 'x.js'));
const pw = require('playwright');

const [engine, statesPath, loopPath, unrolledPath, outPath] = process.argv.slice(2);
const states = JSON.parse(fs.readFileSync(statesPath, 'utf8'));
const uber = { loop: JSON.parse(fs.readFileSync(loopPath, 'utf8')), unrolled: JSON.parse(fs.readFileSync(unrolledPath, 'utf8')) };
const dir = path.dirname(new URL(import.meta.url).pathname);
const server = http.createServer((req, res) => {
  const f = path.join(dir, path.basename(new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(f));
}).listen(4177, '127.0.0.1');

const TIMEOUT = 60_000;
// The states the one shader is measured on: the two game-like ones and five random ones.
const uberStates = states.filter((s) => s.name === 'modulate' || s.name === 'lit' || /^random[0-4]$/.test(s.name));
const runs = [
  { mode: 'spec', states, steadyDraws: 384, quads: 16, timeoutMs: TIMEOUT },
  { mode: 'loop', states: uberStates, uber: uber.loop, steadyDraws: 384, quads: 16, timeoutMs: TIMEOUT },
  { mode: 'unrolled', states: uberStates, uber: uber.unrolled, steadyDraws: 384, quads: 16, timeoutMs: TIMEOUT },
];
const results = [];
for (const r of runs) {
  const launch = engine === 'chromium' ? { args: ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu'] } : {};
  const browser = await pw[engine].launch({ headless: true, ...launch });
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`[${r.mode}] ${m.text()}`));
  await page.goto('http://127.0.0.1:4177/bench.html');
  const t0 = Date.now();
  const res = await Promise.race([
    page.evaluate((d) => window.runBench(d), r),
    new Promise((ok) => setTimeout(() => ok({ mode: r.mode, fatal: 'driver cap 8 min' }), 8 * 60_000)),
  ]);
  res.wallMs = Date.now() - t0;
  results.push(res);
  console.log(JSON.stringify({ ...res, results: undefined, n: res.results?.length }));
  await browser.close().catch(() => {});
}
server.close();
fs.writeFileSync(outPath, JSON.stringify({ engine, results }, null, 1));
