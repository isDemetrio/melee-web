// Run only in Actions. The only exported artifacts are aggregate measurements.
import {createServer} from 'node:http';
import {createReadStream, openSync, readSync, statSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require = createRequire(resolve('web/package.json'));
const {chromium} = require('@playwright/test');
const [coreDir, disc, out] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(out, {recursive: true});
const fd = openSync(disc, 'r'), size = statSync(disc).size;
if (size !== 1459978240) throw new Error('wrong disc size');
const hash = createHash('sha1');
for await (const chunk of createReadStream(disc)) hash.update(chunk);
if (hash.digest('hex') !== 'd4e70c064cc714ba8400a849cf299dbd1aa326fc') throw new Error('wrong disc revision');
const files = new Map([
  ['/page.mjs', [resolve(here, 'page.mjs'), 'text/javascript']],
  ['/worker.mjs', [resolve(here, 'worker.mjs'), 'text/javascript']],
  ['/fake-gpu.mjs', [resolve(here, 'fake-gpu.mjs'), 'text/javascript']],
  ['/core/melee_core_web.js', [resolve(coreDir, 'melee_core_web.js'), 'text/javascript']],
  ['/core/melee_core_web.wasm', [resolve(coreDir, 'melee_core_web.wasm'), 'application/wasm']],
  ['/script', [resolve('upstream/melee-unlocked/port/scripts/parity_vs_onett.txt'), 'text/plain']],
]);
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<script type="module" src="/page.mjs"></script>');
  } else if (url.pathname === '/disc') {
    const start = Number(url.searchParams.get('start')), end = Number(url.searchParams.get('end'));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size || end - start > 32 * 1024 * 1024) {
      res.writeHead(400); res.end(); return;
    }
    const buf = Buffer.alloc(end - start);
    if (readSync(fd, buf, 0, buf.length, start) !== buf.length) throw new Error('short disc read');
    res.end(buf);
  } else if (files.has(url.pathname)) {
    const [file, mime] = files.get(url.pathname);
    res.setHeader('Content-Type', mime); createReadStream(file).pipe(res);
  } else { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({headless: true});
const results = {browser: browser.version(), renderer: 'fake WebGPU; GPU/API costs excluded', runs: []};
try {
  for (const mode of ['trace', 'attached', 'headless']) {
    const page = await browser.newPage();
    page.setDefaultTimeout(300000);
    const cdp = await page.context().newCDPSession(page);
    let started = 0, finished = 0, profile, workerError;
    let commandId = 0;
    const pending = new Map();
    const workerCommand = (sessionId, method, params = {}) => new Promise((resolve, reject) => {
      const id = ++commandId;
      pending.set(id, {resolve, reject});
      cdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})})
        .catch(reject);
    });
    cdp.on('Target.receivedMessageFromTarget', ({message}) => {
      const event = JSON.parse(message);
      if (event.id && pending.has(event.id)) {
        const p = pending.get(event.id); pending.delete(event.id);
        if (event.error) p.reject(new Error(JSON.stringify(event.error))); else p.resolve(event.result);
      }
      if (event.method === 'Profiler.consoleProfileStarted' && event.params.title === 'inmatch') started++;
      if (event.method === 'Profiler.consoleProfileFinished' && event.params.title === 'inmatch') {
        finished++; profile = event.params.profile;
      }
    });
    cdp.on('Target.attachedToTarget', async ({sessionId, targetInfo}) => {
      try {
        if (targetInfo.type === 'worker' && mode !== 'trace') {
          await workerCommand(sessionId, 'Profiler.enable');
          await workerCommand(sessionId, 'Profiler.setSamplingInterval', {interval: 100});
        }
        await workerCommand(sessionId, 'Runtime.runIfWaitingForDebugger');
      } catch (error) { workerError = error; }
    });
    await cdp.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true, flatten: false});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => typeof globalThis.run === 'function');
    const result = await page.evaluate(opts => globalThis.run(opts), {
      size, trace: mode === 'trace', attached: mode !== 'headless', profile: mode !== 'trace',
    });
    if (workerError) throw workerError;
    const digest = result.trace ? createHash('sha1').update(result.trace).digest('hex') : null;
    if (mode === 'trace' && (digest !== 'c79c53b9cdf81426fa0277e7497a69e55bc5f571' || result.trace.trim().split('\n').length !== 2401))
      throw new Error(`2400 checkpoint oracle failed: ${digest}`);
    if (mode !== 'trace' && (started !== 1 || finished !== 1 || !profile?.samples?.length)) throw new Error('profiler measured no samples');
    if (profile) writeFileSync(resolve(out, `${mode}.cpuprofile`), JSON.stringify(profile));
    const times = result.times.trim().split('\n').slice(1).map(l => l.split(',').map(Number))
      .filter(([r]) => r >= 1639 && r <= 2400).map(([,ms]) => ms);
    if (times.length !== 762 || times.some(t => !Number.isFinite(t) || t <= 0)) throw new Error('invalid timing window');
    results.runs.push({mode, digest, frames: times.length, sim_ms: times.reduce((a,b) => a+b,0)/times.length,
      samples: profile?.samples.length ?? null});
    writeFileSync(resolve(out, 'browser.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results.runs.at(-1)));
    await page.close();
  }
} finally { await browser.close(); server.close(); }
