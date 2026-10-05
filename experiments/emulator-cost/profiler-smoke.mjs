// Integration check for worker/CDP console profiling, without any game input.
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {attachProfiler} from './profiler.mjs';
const {chromium} = createRequire(resolve('web/package.json'))('@playwright/test');
const server = createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<script>
      const worker = new Worker('/worker.js');
      globalThis.run = () => new Promise(resolve => {
        worker.onmessage = () => resolve(); worker.postMessage('go');
      });
    </script>`);
  } else {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(`onmessage = () => {
      console.profile('inmatch');
      const end = performance.now() + 250;
      let n = 0; while (performance.now() < end) n++;
      console.profileEnd('inmatch'); postMessage(n);
    };`);
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({headless: true});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const profiler = await attachProfiler(page, true);
  await page.evaluate(() => globalThis.run());
  const profile = await profiler.result();
  console.log(`worker profiler: ${profile.samples.length} samples`);
} finally { await browser.close(); server.close(); }
