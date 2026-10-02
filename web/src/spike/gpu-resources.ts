/** Counts API calls, not driver allocations or garbage collection. No GPU objects are retained. */
export type ResourceKind = 'sampler' | 'texture' | 'buffer' | 'bindGroup' | 'pipeline';
export interface ResourceCount {
  attempted: number;
  created: number;
  failed: number;
  /** null means WebGPU has no destroy API for this type. */
  destroyed: number | null;
  outstanding: number | null;
  peakOutstanding: number | null;
}
export type ResourceCounts = Record<ResourceKind, ResourceCount>;

export function countResources(device: object, failed: (operation: string, error: unknown) => void): ResourceCounts {
  const counts = {} as ResourceCounts;
  const methods: Record<ResourceKind, string> = {
    sampler: 'createSampler', texture: 'createTexture', buffer: 'createBuffer',
    bindGroup: 'createBindGroup', pipeline: 'createRenderPipeline',
  };
  const api = device as Record<string, (...args: unknown[]) => object>;
  for (const kind of Object.keys(methods) as ResourceKind[]) {
    const destroyable = kind === 'texture' || kind === 'buffer';
    const count = counts[kind] = {
      attempted: 0, created: 0, failed: 0, destroyed: destroyable ? 0 : null,
      outstanding: destroyable ? 0 : null, peakOutstanding: destroyable ? 0 : null,
    };
    const method = methods[kind];
    const create = api[method];
    if (!create) throw new Error(`WebGPU device missing ${method}`);
    api[method] = function (...args: unknown[]): object {
      count.attempted++;
      let resource: object;
      try { resource = create.apply(device, args); }
      catch (error) {
        count.failed++;
        failed(method, error);
        throw error;
      }
      // WebGPU may return an invalid object and report validation asynchronously. 'created'
      // means returned, not validated. uncapturederror is reported separately.
      count.created++;
      if (destroyable) {
        count.outstanding!++;
        count.peakOutstanding = Math.max(count.peakOutstanding!, count.outstanding!);
        const owned = resource as { destroy(): void };
        const destroy = owned.destroy;
        let destroyed = false;
        owned.destroy = () => {
          destroy.call(owned);
          if (!destroyed) {
            destroyed = true;
            count.destroyed!++;
            count.outstanding!--;
          }
        };
      }
      return resource;
    };
  }
  return counts;
}

export function snapshotResources(counts: ResourceCounts): ResourceCounts {
  return structuredClone(counts);
}
