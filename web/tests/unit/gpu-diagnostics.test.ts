import { afterEach, expect, it, vi } from 'vitest';
import { observeGpuEvents, openGpu, readPixel } from '../../src/spike/gpu.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('keeps the failure-time counters and observes loss/errors delivered on a later task', async () => {
  vi.useFakeTimers();
  let lost!: (info: { reason: string; message: string }) => void;
  let uncaptured!: (event: { error: Error }) => void;
  let failBuffer = false;
  let listeningDuringProbe = false;
  const device = {
    lost: new Promise<{ reason: string; message: string }>((resolve) => { lost = resolve; }),
    addEventListener: (_type: string, listener: typeof uncaptured) => { uncaptured = listener; },
    createTexture: () => ({ width: 640, height: 480, createView: () => ({}), destroy() {} }),
    createBuffer: () => {
      listeningDuringProbe = !!uncaptured;
      if (failBuffer) throw new Error('Unable to create buffer');
      return { mapAsync: async () => {}, getMappedRange: () => new Uint8Array([1, 2, 3, 4]).buffer,
        unmap() {}, destroy() {} };
    },
    createSampler: () => ({}), createBindGroup: () => ({}), createRenderPipeline: () => ({}),
    queue: { writeBuffer() {} },
  };
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }) } });
  const { gpu } = await openGpu(null);
  expect(gpu).not.toBeNull();
  expect(listeningDuringProbe).toBe(true);
  gpu!.backendCopies = 81;
  failBuffer = true;
  expect(await readPixel(gpu!)).toBeNull();
  const first = gpu!.firstFailure;
  expect(first?.operation).toBe('createBuffer');
  expect(first?.backendCopies).toBe(81);
  expect(first?.resources.buffer.failed).toBe(1);
  failBuffer = false;
  device.createBuffer();
  expect(first?.resources.buffer.created).toBe(1); // snapshot, not a reference to live counts
  setTimeout(() => {
    uncaptured({ error: new Error('validation before loss') });
    lost({ reason: 'unknown', message: 'test device reset' });
  }, 0);
  const observed = observeGpuEvents(gpu!);
  await vi.runAllTimersAsync();
  await observed;
  expect(gpu!.deviceLoss).toMatchObject({ reason: 'unknown', message: 'test device reset', backendCopies: 81 });
  expect(gpu!.validationErrors[0]).toMatchObject({ type: 'Error', message: 'validation before loss' });
  expect(gpu!.firstFailure).toBe(first);
  expect(gpu!.errors).toEqual([
    'readback: Error: Unable to create buffer', 'Error: validation before loss', 'device lost: test device reset',
  ]);
});
