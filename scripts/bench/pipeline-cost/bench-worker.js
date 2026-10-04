// What a draw state costs the GPU process: the generated (specialized) shader of each state against
// the one shader that reads the state from uniforms (#101's loop version and #104's unrolled one).
// Runs in a dedicated worker, the realm the renderer runs in (wasm/probe/check.mjs says why CI's
// Chromium needs it). The layout, vertex format and uniform rows are gx_webgpu.cpp's (gxw_open,
// gxw_draw); rows 106+ come from gen.cpp, the lit-channels generator, so both shaders draw the same
// state from the same rows.
//
// Every shader text gets a unique trailing comment: a browser caches modules and pipelines by
// content, and a cache hit is not a compilation.
const MAX_ROWS = 205, ROW_TEV = 106, W = 640, H = 528, STRIDE = 108;
let nonce = 0;
const now = () => performance.now();

function timeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${ms} ms: ${what}`)), ms); })])
    .finally(() => clearTimeout(t));
}

async function bench({ mode, states, uber, steadyDraws, quads, timeoutMs }) {
  const out = { mode, ua: navigator.userAgent, results: [], errors: [] };
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { ...out, fatal: 'no adapter' };
  const i = adapter.info ?? {};
  out.adapter = { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description };
  const device = await adapter.requestDevice();
  device.lost.then((l) => { out.lost = l.message; });
  device.onuncapturederror = (e) => { if (out.errors.length < 20) out.errors.push(String(e.error.message).slice(0, 400)); };
  const U = GPUBufferUsage, T = GPUTextureUsage;

  const entries = [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } }];
  for (let k = 0; k < 8; k++) {
    entries.push({ binding: 1 + 2 * k, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } });
    entries.push({ binding: 2 + 2 * k, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } });
  }
  const bgl = device.createBindGroupLayout({ entries });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const attributes = [
    { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'unorm8x4' }, { shaderLocation: 3, offset: 28, format: 'unorm8x4' }];
  for (let k = 0; k < 8; k++) attributes.push({ shaderLocation: 4 + k, offset: 32 + 8 * k, format: 'float32x2' });
  for (let k = 0; k < 3; k++) attributes.push({ shaderLocation: 12 + k, offset: 96 + 4 * k, format: 'uint8x4' });
  const desc = (module) => ({
    layout, vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: STRIDE, attributes }] },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm', writeMask: 15 }] },
    primitive: { topology: 'triangle-list', frontFace: 'cw', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' },
  });
  const moduleOf = (code) => device.createShaderModule({ code: `${code}\n// nonce ${++nonce} ${Math.random()}\n` });

  const target = device.createTexture({ size: [W, H], format: 'rgba8unorm', usage: T.RENDER_ATTACHMENT | T.COPY_SRC });
  const depth = device.createTexture({ size: [W, H], format: 'depth32float', usage: T.RENDER_ATTACHMENT });
  const tex = device.createTexture({ size: [64, 64], format: 'rgba8unorm', usage: T.TEXTURE_BINDING | T.COPY_DST });
  const texels = new Uint8Array(64 * 64 * 4);
  for (let p = 0; p < 64 * 64; p++) { const on = ((p & 63) >> 3 ^ (p >> 9)) & 1; texels.set(on ? [230, 180, 40, 255] : [40, 90, 200, 160], 4 * p); }
  device.queue.writeTexture({ texture: tex }, texels, { bytesPerRow: 256 }, [64, 64]);
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });

  // A triangle (selftest geometry 49's) and a quad covering the target; posmtx and texmtx row 0.
  const verts = [[-0.9, -0.6], [-0.5, 0.6], [-0.1, -0.6], [-1, -1], [-1, 1], [1, 1], [1, -1]];
  const vb = new ArrayBuffer(verts.length * STRIDE), f = new Float32Array(vb), b = new Uint8Array(vb);
  verts.forEach(([x, y], v) => {
    const o = v * STRIDE / 4;
    f.set([x, y, -0.3, 0, 0, 1], o);
    b.set([200, 120, 60, 220, 90, 200, 140, 255], v * STRIDE + 24);
    for (let k = 0; k < 8; k++) f.set([(x + 1) * 2, (1 - y) * 2], o + 8 + 2 * k);
  });
  const vertexBuffer = device.createBuffer({ size: vb.byteLength, usage: U.VERTEX | U.COPY_DST });
  device.queue.writeBuffer(vertexBuffer, 0, vb);
  const indexBuffer = device.createBuffer({ size: 9 * 4, usage: U.INDEX | U.COPY_DST });
  device.queue.writeBuffer(indexBuffer, 0, new Uint32Array([0, 1, 2, 3, 4, 5, 3, 5, 6]));

  const SLOT = Math.ceil(MAX_ROWS * 16 / 256) * 256, slots = Math.max(steadyDraws, quads);
  const uniforms = device.createBuffer({ size: SLOT * slots, usage: U.UNIFORM | U.COPY_DST });
  const group = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: uniforms, size: MAX_ROWS * 16 } },
    ...Array.from({ length: 8 }, (_, k) => [{ binding: 1 + 2 * k, resource: tex.createView() }, { binding: 2 + 2 * k, resource: sampler }]).flat()] });
  // Rows 0-105: identity projection, position / texture matrix and normal matrix at row 0, the
  // viewport and clip-space rows that leave clip xy as they are.
  const rowsOf = (state) => {
    const r = new Float32Array(MAX_ROWS * 4);
    r.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
    r.set([0, 0, -1e-6, 1e-6], 16); r.set([1e4, 1e4, 1e-4, 1e-4], 20);
    r.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], 24);
    r.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], 280);
    r.set([1, 1, 0, 0], 408);
    new Uint32Array(r.buffer).set(state.rows, ROW_TEV * 4);
    return r;
  };
  const load = (state) => { const r = rowsOf(state); for (let s = 0; s < slots; s++) device.queue.writeBuffer(uniforms, s * SLOT, r); };
  const readback = device.createBuffer({ size: 256, usage: U.COPY_DST | U.MAP_READ });

  // One submit of `n` draws (the triangle, or the full quad), then the queue drained. Returns ms.
  async function draw(pipeline, n, quad, read) {
    const t0 = now();
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'store' } });
    pass.setPipeline(pipeline); pass.setVertexBuffer(0, vertexBuffer); pass.setIndexBuffer(indexBuffer, 'uint32');
    for (let k = 0; k < n; k++) { pass.setBindGroup(0, group, [k * SLOT]); quad ? pass.drawIndexed(6, 1, 3) : pass.drawIndexed(3); }
    pass.end();
    if (read) enc.copyTextureToBuffer({ texture: target, origin: [160, 316] }, { buffer: readback, bytesPerRow: 256 }, [1, 1]);
    device.queue.submit([enc.finish()]);
    await timeout(device.queue.onSubmittedWorkDone(), timeoutMs, `${n} draw(s)`);
    const ms = now() - t0;
    if (!read) return { ms };
    await timeout(readback.mapAsync(GPUMapMode.READ), timeoutMs, 'readback');
    const px = [...new Uint8Array(readback.getMappedRange(0, 4))];
    readback.unmap();
    return { ms, px };
  }
  async function compileAsync(code) {
    const t0 = now();
    const m = moduleOf(code);
    const p = await timeout(device.createRenderPipelineAsync(desc(m)), timeoutMs, 'createRenderPipelineAsync');
    const info = await m.getCompilationInfo();
    const errs = info.messages.filter((x) => x.type === 'error').map((x) => x.message);
    return { ms: now() - t0, pipeline: p, errs };
  }
  // What main does inside a frame: module, pipeline and first draw, synchronously, then the queue.
  async function syncFirstDraw(code) {
    const t0 = now();
    const p = device.createRenderPipeline(desc(moduleOf(code)));
    const call = now() - t0;
    const d = await draw(p, 1, false, false);
    return { call, ms: now() - t0, drawMs: d.ms };
  }
  const r2 = (x) => Math.round(x * 100) / 100;

  try {
    if (mode === 'spec') {
      // Load-time warm-up: every state's pipeline requested at once, as a page would before callMain.
      let t0 = now();
      await timeout(Promise.all(states.map((s) => device.createRenderPipelineAsync(desc(moduleOf(s.wgsl))))), timeoutMs * 4, 'parallel warm-up');
      out.parallelWarmupMs = r2(now() - t0); out.parallelWarmupCount = states.length;
      for (const s of states) {
        load(s);
        const a = await compileAsync(s.wgsl);
        const sf = await syncFirstDraw(s.wgsl);
        const steady = await draw(a.pipeline, steadyDraws, false, true);
        const full = await draw(a.pipeline, quads, true, false);
        out.results.push({ state: s.name, stages: s.stages, bytes: s.wgsl.length, asyncCompileMs: r2(a.ms), syncCallMs: r2(sf.call),
          syncFirstDrawMs: r2(sf.ms), steadyMs: r2(steady.ms), px: steady.px, quadsMs: r2(full.ms), compileErrors: a.errs.slice(0, 2) });
      }
    } else {
      load(states[0]);
      const a = await compileAsync(uber);
      out.asyncCompileMs = r2(a.ms); out.bytes = uber.length; out.compileErrors = a.errs.slice(0, 2);
      const sf = await syncFirstDraw(uber);
      out.syncCallMs = r2(sf.call); out.syncFirstDrawMs = r2(sf.ms);
      for (const s of states) {
        load(s);
        const first = await draw(a.pipeline, 1, false, false);
        const steady = await draw(a.pipeline, steadyDraws, false, true);
        const full = await draw(a.pipeline, quads, true, false);
        out.results.push({ state: s.name, stages: s.stages, firstDrawMs: r2(first.ms), steadyMs: r2(steady.ms), px: steady.px, quadsMs: r2(full.ms) });
      }
    }
  } catch (e) {
    out.fatal = String(e.message ?? e);
  }
  return out;
}

self.onmessage = async (e) => {
  let r;
  try { r = await bench(e.data); } catch (err) { r = { fatal: String(err?.stack ?? err) }; }
  self.postMessage(r);
};
