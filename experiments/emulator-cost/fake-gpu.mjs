// Fake WebGPU fixture only: no GPU work and no claim of graphics equivalence.
// Kept identical across all variants. CPU/RAM equivalence is checked by the trace.
export function fakeGPU() {
  const fail = message => { throw new Error(message); };
  const texture = ({size: [width, height]}) => ({width, height, destroyed: false,
    createView() { return {texture: this}; }, destroy() { this.destroyed = true; }});
  const buffer = ({size}) => ({size, destroyed: false, destroy() { this.destroyed = true; }});
  const noop = () => {};
  function encoder() {
    const e = {finished: false, copyTextureToTexture: noop,
      beginRenderPass() {
        let ended = false;
        return {setPipeline: noop, setBindGroup: noop, setViewport: noop,
          setScissorRect: noop, setVertexBuffer: noop, setIndexBuffer: noop,
          drawIndexed() { if (ended) fail('draw on ended pass'); },
          end() { ended = true; }};
      },
      finish() { e.finished = true; return e; }};
    return e;
  }
  return {
    failure: undefined, xfb: texture({size: [640, 480]}), context: null, format: 'rgba8unorm',
    recordFailure(op, error) { this.firstFailure ??= `${op}: ${error}`; },
    device: {
      limits: {minUniformBufferOffsetAlignment: 256},
      createTexture: texture, createBuffer: buffer, createSampler: d => ({d}),
      createBindGroupLayout: d => ({entries: d.entries}), createPipelineLayout: d => ({d}),
      createShaderModule: () => ({}), createRenderPipeline: () => ({}),
      createBindGroup: d => ({entries: d.entries}), createCommandEncoder: encoder,
      queue: {
        writeTexture(dst) { if (dst.texture.destroyed) fail('write to destroyed texture'); },
        writeBuffer(b, off, data, dataOff = 0, size) {
          const bytes = size ?? data.byteLength - dataOff;
          if (b.destroyed || off + bytes > b.size) fail('invalid buffer write');
        },
        submit(list) { if (list.some(e => !e.finished)) fail('unfinished encoder submitted'); },
      },
    },
  };
}
