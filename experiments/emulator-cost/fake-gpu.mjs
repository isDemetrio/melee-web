// Fixed fake WebGPU fixture, derived from the previous corecost profiler.
// No GPU execution or real browser WebGPU API costs are measured.
export function fakeGPU() {
const VALIDATE = false;
const acc = {write_texture_bytes: 0, write_buffer_bytes: 0};
const mocked = (_name, fn) => fn;
const fail = message => { throw new Error(message); };
const seenContent = new Set();
let reuploads = 0, levelZeroUploads = 0;
const hash = () => 0; // Content diagnostics are disabled in a timing run.
// --- mock device ------------------------------------------------------------------------------
let liveTextures = 0, peakLiveTextures = 0, liveTextureBytes = 0, peakLiveTextureBytes = 0;
function texture(desc) {
  const [w, h] = desc.size; const levels = desc.mipLevelCount ?? 1;
  let bytes = 0; for (let l = 0; l < levels; l++) bytes += Math.max(1, w >> l) * Math.max(1, h >> l) * 4;
  liveTextures++; peakLiveTextures = Math.max(peakLiveTextures, liveTextures);
  liveTextureBytes += bytes; peakLiveTextureBytes = Math.max(peakLiveTextureBytes, liveTextureBytes);
  const t = { kind: 'texture', width: w, height: h, levels, bytes, destroyed: false,
    createView() { return { texture: t }; },
    destroy() { if (!t.destroyed) { t.destroyed = true; liveTextures--; liveTextureBytes -= bytes; } } };
  return t;
}
let liveBufferBytes = 0, peakLiveBufferBytes = 0;
function buffer(d) {
  liveBufferBytes += d.size; peakLiveBufferBytes = Math.max(peakLiveBufferBytes, liveBufferBytes);
  const b = { kind: 'buffer', size: d.size, usage: d.usage, destroyed: false, bytes: VALIDATE ? new Uint8Array(d.size) : null,
    destroy() { if (!b.destroyed) { b.destroyed = true; liveBufferBytes -= d.size; } } };
  return b;
}
function encoder() {
  const e = { commands: [], finished: false };
  e.copyTextureToTexture = mocked('copyTextureToTexture', (src, dst) => { if (VALIDATE) e.commands.push({ uses: [src.texture, dst.texture] }); });
  e.beginRenderPass = mocked('beginRenderPass', (d) => {
    if (VALIDATE) e.commands.push({ uses: [d.colorAttachments[0].view.texture, d.depthStencilAttachment?.view.texture].filter(Boolean) });
    let group = null, offsets = [], vb = null, vbOffset = 0, ib = null, ibOffset = 0, ended = false;
    return {
      setPipeline: mocked('setPipeline', () => {}),
      setBindGroup: mocked('setBindGroup', (i, g, dyn) => { group = g; offsets = dyn ? [...dyn] : []; }),
      setViewport: mocked('setViewport', () => {}), setScissorRect: mocked('setScissorRect', () => {}),
      setVertexBuffer: mocked('setVertexBuffer', (slot, b, off = 0) => { vb = b; vbOffset = off; }),
      setIndexBuffer: mocked('setIndexBuffer', (b, fmt, off = 0) => { ib = b; ibOffset = off; }),
      drawIndexed: mocked('drawIndexed', (count, instances = 1, firstIndex = 0, baseVertex = 0) => {
        if (ended) fail('drawIndexed on an ended pass');
        if (!VALIDATE) return;
        if (!group || !vb || !ib) { fail('drawIndexed without bind group / buffers'); return; }
        e.commands.push({ draw: { group, offsets, vb, vbOffset, ib, ibOffset, count, firstIndex, baseVertex },
          uses: [vb, ib, ...group.resources] });
      }),
      end: mocked('end', () => { ended = true; }),
    };
  });
  e.finish = mocked('finish', () => { e.finished = true; return e; });
  return e;
}
function execute(cmd) {
  const d = cmd.draw;
  const want = expected[expectedHead]; expected[expectedHead++] = undefined;
  executedDraws++;
  if (!want) { fail('a draw executed that gxw_draw never recorded'); return; }
  // Uniforms: binding 0, at its dynamic offset.
  const u = d.group.uniform;
  const uOff = (u.offset ?? 0) + (d.offsets[0] ?? 0), uSize = u.size ?? 105 * 16;
  if (uOff + uSize > u.buffer.size) { fail(`uniform range ${uOff}+${uSize} > ${u.buffer.size}`); return; }
  if (hash(u.buffer.bytes, uOff, uOff + uSize) !== want.constants) fail(`draw ${executedDraws}: uniforms differ from the draw's constants`);
  const iStart = d.ibOffset + d.firstIndex * 4, iEnd = iStart + d.count * 4;
  if (d.count !== want.count) fail(`draw ${executedDraws}: ${d.count} indices, gxw_draw had ${want.count}`);
  if (iEnd > d.ib.size) { fail(`index range ${iEnd} > ${d.ib.size}`); return; }
  if (hash(d.ib.bytes, iStart, iEnd) !== want.indices) fail(`draw ${executedDraws}: indices differ`);
  const vStart = d.vbOffset + d.baseVertex * 108, vEnd = vStart + want.vertexBytes;
  if (vEnd > d.vb.size) { fail(`vertex range ${vEnd} > ${d.vb.size}`); return; }
  if (hash(d.vb.bytes, vStart, vEnd) !== want.vertices) fail(`draw ${executedDraws}: vertices differ`);
  const idx = new Uint32Array(d.ib.bytes.buffer, iStart, d.count);
  for (const i of idx) if (i >= want.vertexBytes / 108) { fail(`draw ${executedDraws}: index ${i} past its ${want.vertexBytes / 108} vertices`); break; }
  checkedDraws++;
}
const gpu = {
  failure: undefined, errors: [], xfb: null, context: null, format: 'rgba8unorm',
  recordFailure(op, error) { console.error(`recordFailure ${op}: ${error}`); gpu.firstFailure ??= `${op}: ${error}`; },
};
const device = {
  limits: { minUniformBufferOffsetAlignment: 256 },
  createTexture: mocked('createTexture', texture),
  createBuffer: mocked('createBuffer', buffer),
  createSampler: mocked('createSampler', (d) => ({ d })),
  createBindGroupLayout: (d) => ({ entries: d.entries }),
  createPipelineLayout: (d) => ({ d }),
  createShaderModule: () => ({}),
  createRenderPipeline: mocked('createRenderPipeline', () => ({})),
  createBindGroup: mocked('createBindGroup', (d) => {
    const resources = []; let uniform = null;
    for (const x of d.entries) {
      if (x.resource && x.resource.buffer) { uniform = x.resource; resources.push(x.resource.buffer); }
      else if (x.resource && x.resource.texture) resources.push(x.resource.texture);
    }
    return { uniform, resources };
  }),
  createCommandEncoder: mocked('createCommandEncoder', encoder),
  queue: {
    writeTexture: mocked('writeTexture', (dst, data) => {
      acc.write_texture_bytes += data.length;
      // Level 0's pixels and the texture's shape: an upload of content the run has uploaded before.
      if ((dst.mipLevel ?? 0) === 0) {
        const fp = `${dst.texture.width}x${dst.texture.height}x${dst.texture.levels}:${hash(data, 0, data.length)}`;
        if (seenContent.has(fp)) reuploads++; else seenContent.add(fp);
        levelZeroUploads++;
      }
      if (dst.texture.destroyed) fail('writeTexture into a destroyed texture');
    }),
    writeBuffer: mocked('writeBuffer', (b, off, data, dataOff = 0, size) => {
      const n = size ?? (data.length - dataOff);
      acc.write_buffer_bytes += n;
      if (b.destroyed) fail('writeBuffer into a destroyed buffer');
      if (off + n > b.size) fail(`writeBuffer ${off}+${n} past ${b.size}`);
      if (VALIDATE) b.bytes.set(new Uint8Array(data.buffer, data.byteOffset + dataOff * (data.BYTES_PER_ELEMENT ?? 1), n), off);
    }),
    submit: mocked('submit', (list) => {
      for (const e of list) {
        if (!e.finished) fail('submit of an unfinished encoder');
        if (!VALIDATE) continue;
        for (const c of e.commands) {
          for (const r of c.uses) if (r.destroyed) { fail(`submit names a destroyed ${r.kind}`); break; }
          if (c.draw) execute(c);
        }
      }
    }),
  },
};
gpu.device = device;
gpu.xfb = texture({ size: [640, 480], format: 'rgba8unorm' });


return gpu;
}
