// Temporary controlled experiment, never a replacement for the unchanged pixel assertions.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const { chromium } = createRequire(`${process.cwd()}/web/package.json`)('@playwright/test');
const dist = process.env.SPIKE_DIST;
const files = readdirSync(`${dist}/assets`).filter(f => /^worker-.*\.js$/.test(f));
const originals = files.map(f => [f, readFileSync(`${dist}/assets/${f}`, 'utf8')]);
function instrument(variant) {
  const log = (...a) => console.log('[probe]', Math.round(performance.now()), ...a);
  const shader = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(d) {
    if (d.label === 'gx shader 0') {
      let code = d.code;
      if (variant === 'constant-fragment') {
        code = code.slice(0, code.indexOf('@fragment fn fs(')) + '@fragment fn fs(i: Out) -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }';
      }
      if (variant === 'no-continue') {
        code = code.replace('colors[j] = mtl / 255.0; continue; }', 'colors[j] = mtl / 255.0; } else {');
        code = code.replace('    o.colors_0 = colors[0];', '    }\n    o.colors_0 = colors[0];');
      }
      if (variant === 'constant-stages') code = code.replace('let stages = uid(24u);', 'let stages = 1u;');
      log('shader', d.label, code.length, variant);
      d = { ...d, code };
    }
    const result = shader.call(this, d);
    result.getCompilationInfo().then(info => log('compilation', d.label, JSON.stringify(info.messages.map(m => ({type:m.type, message:m.message})))));
    return result;
  };
  const pipeline = GPUDevice.prototype.createRenderPipeline;
  GPUDevice.prototype.createRenderPipeline = function(d) {
    log('pipeline begin', d.label);
    const result = pipeline.call(this, d);
    log('pipeline returned', d.label);
    return result;
  };
  const submit = GPUQueue.prototype.submit;
  let serial = 0;
  GPUQueue.prototype.submit = function(...args) {
    const n = ++serial;
    const result = submit.apply(this, args);
    log('submit returned', n);
    this.onSubmittedWorkDone().then(() => log('submit completed', n), e => log('submit failed', n, String(e)));
    return result;
  };
  const map = GPUBuffer.prototype.mapAsync;
  GPUBuffer.prototype.mapAsync = function(...args) {
    log('map begin', this.size);
    return map.apply(this, args).then(x => { log('map completed', this.size); return x; }, e => { log('map failed', String(e)); throw e; });
  };
  setInterval(() => log('worker event loop alive'), 5000);
}
const server = spawn(process.execPath, ['web/scripts/serve.mjs', '--dir', dist, '--port', '4176'], {stdio:['ignore','pipe','inherit']});
await new Promise(resolve => server.stdout.on('data', x => { if (String(x).includes('serving')) resolve(); }));
try {
  for (const variant of ['baseline', 'specialized', 'constant-fragment', 'constant-stages', 'no-continue']) {
    for (const [f, source] of originals) writeFileSync(`${dist}/assets/${f}`, `(${instrument.toString()})(${JSON.stringify(variant)});\n${source}`);
    const browser = await chromium.launch({headless:true, args:['--enable-unsafe-swiftshader','--enable-unsafe-webgpu']});
    try {
      const page = await browser.newPage();
      page.on('console', m => console.log(variant, m.text()));
      page.on('pageerror', e => console.log(variant, 'pageerror', String(e)));
      console.log('BEGIN', variant);
      await page.goto('http://127.0.0.1:4176/spike.html?gx-selftest=ff2080c0&copies=2&target=texture&geometry=1&sample-x=320' + (variant === 'specialized' ? '&shaders=specialized' : ''));
      try {
        console.log('RESULT', variant, await page.locator('#render').filter({hasText:/^\{/}).innerText({timeout:30000}));
      } catch(e) {
        console.log('TIMEOUT', variant, String(e));
        console.log(execFileSync('ps', ['-eo', 'pid,ppid,pcpu,pmem,etime,comm'], {encoding:'utf8'}));
      }
    } finally { await browser.close(); console.log('CLOSED', variant); }
  }
} finally {
  server.kill();
  for (const [f, source] of originals) writeFileSync(`${dist}/assets/${f}`, source);
}
