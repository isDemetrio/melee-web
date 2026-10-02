import { expect, it } from 'vitest';
import { countResources, snapshotResources } from '../../src/spike/gpu-resources.js';

it('counts successful, failed and repeated destroy calls without swallowing errors', () => {
  const failure = new Error('Unable to create sampler');
  const failures: unknown[] = [];
  const device = {
    createTexture: () => ({ destroy() {} }), createBuffer: () => ({ destroy() {} }),
    createSampler: () => { throw failure; }, createBindGroup: () => ({}), createRenderPipeline: () => ({}),
  };
  const counts = countResources(device, (operation, error) => failures.push([operation, error]));
  const texture = device.createTexture();
  const before = snapshotResources(counts);
  texture.destroy();
  texture.destroy();
  expect(counts.texture).toEqual({ attempted: 1, created: 1, failed: 0, destroyed: 1, outstanding: 0, peakOutstanding: 1 });
  expect(before.texture.outstanding).toBe(1);
  expect(() => device.createSampler()).toThrow(failure);
  expect(counts.sampler).toEqual({ attempted: 1, created: 0, failed: 1, destroyed: null, outstanding: null, peakOutstanding: null });
  expect(failures).toEqual([['createSampler', failure]]);
});
