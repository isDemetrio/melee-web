import { describe, expect, it } from 'vitest';
import { COLUMN, coreSplitOf, createFlight, CsvTail, FLIGHT_CALL, FLIGHT_DRAWS, FLIGHT_FRAME, FLIGHT_HIDDEN,
  FLIGHT_MATCH, FLIGHT_PHASE, FRAME_COLUMNS, FrameMeter, instrumentGpu, matchFrameOf, meterDiscReads, METHODS,
  PHASES, SLOW_FRAME_MS, type FrameColumn, type FrameRecord, type TailFs } from '../../src/play/frame-meter';

/** A WebGPU stand-in whose calls take as long as the test says, on the test's clock. */
function fakeGpu(costs: Partial<Record<string, number>> = {}) {
  let clock = 0;
  const flight = createFlight();
  const seen: { phase: number; call: number }[] = [];
  const spend = (name: string) => {
    seen.push({ phase: flight[FLIGHT_PHASE]!, call: flight[FLIGHT_CALL]! });
    clock += costs[name] ?? 0;
  };
  // Fresh objects per call, like WebGPU's: each is instrumented once, when it is returned.
  const pass = () => ({
    marker: 'pass',
    setPipeline() { spend('setPipeline'); },
    setBindGroup() { spend('setBindGroup'); },
    setViewport() { spend('setViewport'); },
    setScissorRect() { spend('setScissorRect'); },
    setVertexBuffer() { spend('setVertexBuffer'); },
    setIndexBuffer() { spend('setIndexBuffer'); },
    drawIndexed(this: { marker: string }, count: number) { spend('drawIndexed'); return `${this.marker}:${count}`; },
    draw() { spend('draw'); },
    end() { spend('end'); },
  });
  const encoder = () => ({
    beginRenderPass() { spend('beginRenderPass'); return pass(); },
    copyTextureToTexture() { spend('copyTextureToTexture'); },
    copyTextureToBuffer() { spend('copyTextureToBuffer'); },
    finish() { spend('finish'); return 'commands'; },
  });
  const queue = {
    writeBuffer() { spend('writeBuffer'); throw new Error('buffer destroyed'); },
    writeTexture() { spend('writeTexture'); },
    submit() { spend('submit'); },
  };
  const device = {
    queue,
    createCommandEncoder() { spend('createCommandEncoder'); return encoder(); },
    createTexture() { spend('createTexture'); return { createView() { return 'view'; }, destroy() { /* fake */ } }; },
    createBindGroup() { spend('createBindGroup'); return {}; },
    createSampler() { spend('createSampler'); return {}; },
    createRenderPipeline() { spend('createRenderPipeline'); return {}; },
    createShaderModule() { spend('createShaderModule'); return {}; },
    createBuffer() { spend('createBuffer'); return { destroy() { /* fake */ } }; },
    createBindGroupLayout() { return {}; },
    createPipelineLayout() { return {}; },
  };
  const context = { getCurrentTexture() { spend('getCurrentTexture'); return {}; } };
  const meter = new FrameMeter(flight, () => clock);
  instrumentGpu({ device, context }, meter);
  return { device, context, meter, flight, seen, advance: (ms: number) => { clock += ms; } };
}

const cell = (record: FrameRecord, column: FrameColumn) => record.row[COLUMN[column]];

/** One frame: `simMs` of guest work, a pass with one draw, a pipeline, a submit; then presentation. */
function frame(gpu: ReturnType<typeof fakeGpu>, retrace: number, matchFrame: number | null, simMs = 3) {
  gpu.advance(simMs);
  const encoder = gpu.device.createCommandEncoder();
  const pass = encoder.beginRenderPass();
  gpu.meter.draw();
  pass.drawIndexed(3);
  gpu.device.createRenderPipeline();
  pass.end();
  gpu.device.queue.submit([encoder.finish()]);
  gpu.meter.coreEnd(retrace, matchFrame, null);
  gpu.advance(1);
  gpu.meter.bitmapDone();
  gpu.advance(2);
  gpu.meter.ackDone();
  gpu.advance(4);
  return gpu.meter.cycleEnd();
}

describe('frame meter', () => {
  it('cuts a frame into core, bitmap, ack and idle, which add up to the cycle', () => {
    const gpu = fakeGpu({ drawIndexed: 2, createRenderPipeline: 30, submit: 5 });
    gpu.meter.start();
    const record = frame(gpu, 1, 0);
    expect(record.row).toHaveLength(FRAME_COLUMNS.length);
    expect(cell(record, 'retrace')).toBe(1);
    expect(cell(record, 'core_ms')).toBe(40);
    expect(cell(record, 'webgpu_ms')).toBe(37);
    expect(cell(record, 'encode_ms')).toBe(2);
    expect(cell(record, 'resources_ms')).toBe(30);
    expect(cell(record, 'queue_ms')).toBe(5);
    // createCommandEncoder, beginRenderPass, drawIndexed, createRenderPipeline, end, finish, submit.
    expect(cell(record, 'webgpu_calls')).toBe(7);
    expect(cell(record, 'draws')).toBe(1);
    expect(cell(record, 'created')).toBe(1);
    expect(cell(record, 'pipelines_created')).toBe(1);
    expect([cell(record, 'bitmap_ms'), cell(record, 'ack_ms'), cell(record, 'idle_ms')]).toEqual([1, 2, 4]);
    const parts = (['core_ms', 'bitmap_ms', 'ack_ms', 'idle_ms'] as const).reduce((sum, c) => sum + (cell(record, c) ?? 0), 0);
    expect(parts).toBeCloseTo(cell(record, 'cycle_ms')!, 6);
    expect(cell(record, 'decode_ms')).toBeNull();
    expect(record.top).toBeUndefined();
  });

  it('names the slowest WebGPU methods of a slow frame', () => {
    const gpu = fakeGpu({ createRenderPipeline: SLOW_FRAME_MS, submit: 1 });
    gpu.meter.start();
    const record = frame(gpu, 1, 0);
    expect(record.top?.[0]).toEqual(['device.createRenderPipeline', 1, SLOW_FRAME_MS]);
    expect(record.top?.[1]).toEqual(['queue.submit', 1, 1]);
  });

  it('starts each frame from zero and counts the match apart', () => {
    const gpu = fakeGpu({ drawIndexed: 2 });
    gpu.meter.start();
    frame(gpu, 1, 0);
    const second = frame(gpu, 2, 7);
    expect(cell(second, 'webgpu_calls')).toBe(7);
    expect(cell(second, 'match_frame')).toBe(7);
    const totals = gpu.meter.totals();
    expect(totals.all['pass.drawIndexed']).toEqual({ calls: 2, ms: 4 });
    expect(totals.in_match['pass.drawIndexed']).toEqual({ calls: 1, ms: 2 });
    expect(totals.longest['pass.drawIndexed']).toEqual({ ms: 2, retrace: 1 });
  });

  it('forwards this, arguments and results, and drops calls made before the first frame', () => {
    const gpu = fakeGpu({ drawIndexed: 1 });
    gpu.device.createRenderPipeline();
    gpu.meter.start();
    const pass = gpu.device.createCommandEncoder().beginRenderPass();
    expect(pass.drawIndexed(9)).toBe('pass:9');
    gpu.meter.coreEnd(1, null, null);
    gpu.meter.bitmapDone();
    gpu.meter.ackDone();
    expect(cell(gpu.meter.cycleEnd(), 'pipelines_created')).toBe(0);
  });

  it('shows the call in progress in the flight recorder, and puts the phase back after it, even when it throws', () => {
    const gpu = fakeGpu();
    gpu.meter.start();
    expect(PHASES[gpu.flight[FLIGHT_PHASE]!]).toBe('core');
    gpu.device.createRenderPipeline();
    expect(PHASES[gpu.seen[0]!.phase]).toBe('webgpu');
    expect(METHODS[gpu.seen[0]!.call]).toBe('device.createRenderPipeline');
    expect(() => gpu.device.queue.writeBuffer()).toThrow('buffer destroyed');
    expect(PHASES[gpu.flight[FLIGHT_PHASE]!]).toBe('core');
    gpu.meter.draw();
    gpu.meter.draw();
    expect(gpu.flight[FLIGHT_DRAWS]).toBe(2);
    gpu.meter.coreEnd(4, 12, null);
    expect([gpu.flight[FLIGHT_FRAME], gpu.flight[FLIGHT_MATCH], PHASES[gpu.flight[FLIGHT_PHASE]!]]).toEqual([4, 1, 'bitmap']);
    gpu.meter.bitmapDone();
    expect(PHASES[gpu.flight[FLIGHT_PHASE]!]).toBe('ack');
    gpu.flight[FLIGHT_HIDDEN] = 1;
    gpu.meter.ackDone();
    expect(PHASES[gpu.flight[FLIGHT_PHASE]!]).toBe('idle');
    const record = gpu.meter.cycleEnd();
    expect(cell(record, 'hidden')).toBe(1);
    expect(gpu.flight[FLIGHT_DRAWS]).toBe(0);
    expect(PHASES[gpu.flight[FLIGHT_PHASE]!]).toBe('core');
  });

  it('times the canvas texture as presentation', () => {
    const gpu = fakeGpu({ getCurrentTexture: 3 });
    gpu.meter.start();
    gpu.context.getCurrentTexture();
    gpu.meter.coreEnd(1, null, null);
    gpu.meter.bitmapDone();
    gpu.meter.ackDone();
    expect(cell(gpu.meter.cycleEnd(), 'present_ms')).toBe(3);
  });

  it('carries the core split when the profiler gave one', () => {
    const gpu = fakeGpu();
    gpu.meter.start();
    gpu.meter.coreEnd(1, 0, { decodeMs: 2.5, nonDecodeMs: 1.25 });
    gpu.meter.bitmapDone();
    gpu.meter.ackDone();
    const record = gpu.meter.cycleEnd();
    expect([cell(record, 'decode_ms'), cell(record, 'non_decode_ms')]).toEqual([2.5, 1.25]);
  });
});

describe('disc reads', () => {
  it('times WORKERFS reads and counts their bytes, with the read unchanged', () => {
    let clock = 0;
    const meter = new FrameMeter(createFlight(), () => clock);
    const ops = { read(this: unknown, _stream: unknown, _buffer: Uint8Array, _offset: number, length: number) {
      clock += 6;
      return this === ops ? length : -1;
    } };
    expect(meterDiscReads({ WORKERFS: { stream_ops: ops } }, meter)).toBeNull();
    meter.start();
    expect(ops.read(null, new Uint8Array(0), 0, 100)).toBe(100);
    meter.coreEnd(1, null, null);
    meter.bitmapDone();
    meter.ackDone();
    const record = meter.cycleEnd();
    expect([cell(record, 'disc_ms'), cell(record, 'disc_bytes')]).toEqual([6, 100]);
  });

  it('says so when there is nothing to patch', () => {
    expect(meterDiscReads({}, new FrameMeter(createFlight(), () => 0))).toMatch(/not metered/);
  });
});

describe('core CSV tail', () => {
  function fakeFs(): { fs: TailFs; append(text: string): void } {
    let content = '';
    const fs: TailFs = {
      stat: () => ({ size: content.length }),
      open: () => ({}),
      read: (_stream, buffer, offset, length, position) => {
        const bytes = new TextEncoder().encode(content.slice(position, position + length));
        buffer.set(bytes, offset);
        return bytes.length;
      },
    };
    return { fs, append: (text) => { content += text; } };
  }

  it('returns the complete rows written since the last read, without the header', () => {
    const { fs, append } = fakeFs();
    const tail = new CsvTail(fs, '/work/sim_times.csv');
    expect(tail.lines()).toEqual([]);
    append('retrace,sim_ms,match_frame\n1,2.5,0\n2,3');
    expect(tail.lines()).toEqual(['1,2.5,0']);
    append('.0,0\n3,4.0,1\n');
    expect(tail.lines()).toEqual(['2,3.0,0', '3,4.0,1']);
    expect(tail.lines()).toEqual([]);
  });

  it('finds a retrace in new rows', () => {
    expect(matchFrameOf(['1,2.5,0', '2,3.0,17'], 2)).toBe(17);
    expect(matchFrameOf(['1,2.5,0'], 2)).toBeNull();
    const row = ['5', '9', '1', '0', '0', '0', '0', '6.5', '0', '2.5'].join(',');
    expect(coreSplitOf([row], 5)).toEqual({ decodeMs: 6.5, nonDecodeMs: 2.5 });
    expect(coreSplitOf([row], 6)).toBeNull();
  });
});
