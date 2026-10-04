// run.mjs for Safari, through safaridriver (W3C WebDriver): Playwright's WebKit has no WebGPU
// adapter on macOS runners (run 37208142680). One WebDriver session per mode.
// usage: node safari.mjs <states.json> <uber-loop.json> <uber-unrolled.json> <out.json>   (safaridriver on :4444)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [statesPath, loopPath, unrolledPath, outPath] = process.argv.slice(2);
const states = JSON.parse(fs.readFileSync(statesPath, 'utf8'));
const uber = { loop: JSON.parse(fs.readFileSync(loopPath, 'utf8')), unrolled: JSON.parse(fs.readFileSync(unrolledPath, 'utf8')) };
const dir = path.dirname(new URL(import.meta.url).pathname);
http.createServer((req, res) => {
  const f = path.join(dir, path.basename(new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(f));
}).listen(4177, '127.0.0.1');

const wd = async (method, url, body) => {
  const r = await fetch(`http://127.0.0.1:4444${url}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${url}: ${JSON.stringify(j).slice(0, 500)}`);
  return j.value;
};
const TIMEOUT = 60_000;
const uberStates = states.filter((s) => s.name === 'modulate' || s.name === 'lit' || /^random[0-4]$/.test(s.name));
const runs = [
  { mode: 'spec', states, steadyDraws: 384, quads: 16, timeoutMs: TIMEOUT },
  { mode: 'loop', states: uberStates, uber: uber.loop, steadyDraws: 384, quads: 16, timeoutMs: TIMEOUT },
  { mode: 'unrolled', states: uberStates, uber: uber.unrolled, steadyDraws: 384, quads: 16, timeoutMs: TIMEOUT },
];
const results = [];
for (const r of runs) {
  const t0 = Date.now();
  let res;
  let id = null;
  try {
    id = (await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } })).sessionId;
    await wd('POST', `/session/${id}/timeouts`, { script: 8 * 60_000 });
    await wd('POST', `/session/${id}/url`, { url: 'http://127.0.0.1:4177/bench.html' });
    res = await wd('POST', `/session/${id}/execute/async`, {
      script: 'const done = arguments[arguments.length - 1]; window.runBench(arguments[0]).then(done, (e) => done({ fatal: String(e) }));',
      args: [r] });
  } catch (error) {
    res = { mode: r.mode, fatal: String(error).slice(0, 600) };
  }
  if (id) await wd('DELETE', `/session/${id}`).catch(() => {});
  res.wallMs = Date.now() - t0;
  results.push(res);
  console.log(JSON.stringify({ ...res, results: undefined, n: res.results?.length }));
}
fs.writeFileSync(outPath, JSON.stringify({ engine: 'safari', results }, null, 1));
process.exit(0);
