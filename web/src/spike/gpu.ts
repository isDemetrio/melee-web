/**
 * The spike worker's WebGPU half: acquire a device, give it an XFB target -- a transferred
 * `OffscreenCanvas`, or a plain offscreen texture -- hand both to the core's backend
 * (`wasm/render/gx_webgpu.cpp` reads them as `Module.gxWebgpu`), and read a pixel of what the
 * backend wrote there back off the GPU.
 *
 * Why the texture target exists. In CI's headless Chromium the device does not survive the end of
 * the first task that takes a canvas texture -- the task whose end commits the canvas frame. Run
 * 36898914442's timeline: buffer round trips pass across several task boundaries while the canvas is
 * configured but untouched; the task that first calls getCurrentTexture ends at about 167 ms, and at
 * 167.7 ms the device is lost ("Device was destroyed.") and every pending map aborts ("A valid
 * external Instance reference no longer exists."). Nothing in this repository destroys a device.
 * The texture target is the same backend path with only the canvas commit removed, so CI can read
 * the backend's output back; the canvas readback stays for devices that survive presenting
 * (`?canvas` runs report it as `render.readback`).
 *
 * The device is acquired here, before the simulation starts, because the simulation is one
 * synchronous `callMain` and `requestAdapter` / `requestDevice` resolve only once the event loop
 * turns. Nothing here throws: a browser without WebGPU, a null adapter, a device that cannot be
 * created come back as `{ gpu: null, reason }`. Configuration failures keep the diagnostic
 * object, refuse attachment, and let the run proceed headless.
 *
 * The WebGPU declarations are the few this file uses, written out because the shell carries no
 * `@webgpu/types` (the same choice `platform/capabilities.ts` makes). The numeric flags are the
 * WebGPU specification's values for `GPUTextureUsage`, `GPUBufferUsage` and `GPUMapMode`.
 */

import { countResources, snapshotResources, type ResourceCounts } from './gpu-resources.js';
import type { RenderProgress } from './heartbeat.js';

const TEXTURE_COPY_SRC = 0x01;
const TEXTURE_COPY_DST = 0x02;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const MAP_READ = 0x0001;

interface GpuTexture { readonly width: number; readonly height: number; createView(): unknown }
interface GpuBuffer { mapAsync(mode: number): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void; destroy(): void }
interface GpuRenderPass { end(): void }
interface GpuCommandEncoder {
  beginRenderPass(descriptor: unknown): GpuRenderPass;
  copyTextureToBuffer(source: unknown, destination: unknown, size: number[]): void;
  finish(): unknown;
}
interface GpuDevice {
  createTexture(descriptor: { size: number[]; format: string; usage: number }): GpuTexture;
  createBuffer(descriptor: { size: number; usage: number }): GpuBuffer;
  createCommandEncoder(): GpuCommandEncoder;
  queue: { submit(buffers: unknown[]): void; writeBuffer(buffer: GpuBuffer, offset: number, data: Uint8Array): void };
  lost: Promise<{ message: string; reason?: string }>;
  addEventListener(type: 'uncapturederror', listener: (event: { error: { message: string; constructor?: { name?: string } } }) => void): void;
}
interface GpuAdapter { requestDevice(): Promise<GpuDevice> }
interface Gpu { requestAdapter(options?: { forceFallbackAdapter?: boolean }): Promise<GpuAdapter | null> }
interface GpuCanvasContext {
  configure(configuration: { device: GpuDevice; format: string; alphaMode: string; usage: number }): void;
  getCurrentTexture(): GpuTexture;
}

/** What `gx_webgpu.cpp` reads as `Module.gxWebgpu`, and what it writes back into it. */
export interface SpikeGpu {
  /** Held only so they stay reachable; see `live` below. */
  gpu: Gpu;
  adapter: GpuAdapter;
  canvas: OffscreenCanvas | null;
  device: GpuDevice;
  /** The XFB target is exactly one of these: the canvas's current texture, or `xfb`. */
  context: GpuCanvasContext | null;
  xfb: GpuTexture | null;
  /** The EFB's and the target's format: one format, so an XFB copy is a plain texture copy. */
  format: 'rgba8unorm';
  /** Written by the backend: the last clear colour (ARGB), and why it stopped if it did. */
  lastClearArgb?: number;
  failure?: string;
  /** Written here: validation errors and device loss, which WebGPU reports without throwing. */
  errors: string[];
  resources: ResourceCounts;
  firstFailure: GpuFailure | null;
  deviceLoss: (GpuFailure & { reason: string }) | null;
  validationErrors: (GpuFailure & { type: string })[];
  recordFailure(operation: string, error: unknown): void;
  /** Where the readback dies, for the CI log: see `Diagnostic`. */
  diagnostic: Diagnostic;
  /**
   * Read by gx_webgpu.cpp when it attaches: each draw state's own generated shader instead of the one
   * shader (`?shaders=specialized`, for wasm/render/pixel_pipeline_check.mjs, which compares the two).
   */
  specializedShaders?: boolean;
  /** Written by gx_webgpu.cpp's gxw_open/gxw_copy: the device object it rendered with, and how often. */
  backendDevice?: GpuDevice | null;
  backendCopies?: number;
  /** Written by gx_webgpu.cpp: draws recorded (submitted per batch), its texture pool and its bind group cache (heartbeat.ts reads them). */
  drawSerial?: number;
  textureUploads?: number;
  texturePool?: { readonly size: number };
  bindGroups?: { readonly size: number };
}

/**
 * Evidence about the readback failure of runs 36892349174 and 36896537472, where `device lost:
 * Device was destroyed.` came first and `mapAsync` then aborted with `A valid external Instance
 * reference no longer exists.` WebGPU calls on a lost device fail silently, so `attached` and
 * `presented` do not show when the device died; these fields do.
 *
 * - `timeline`: milliseconds since this module loaded in the worker, one entry per stage, including
 *   when `device.lost` resolved and with which reason.
 * - `probes`: buffer round trips (writeBuffer, then mapAsync) that touch neither the canvas nor the
 *   core, taken at fixed stages. The stage at which they start failing brackets the cause.
 * - `realm`: the global scope's constructor at open and at readback (a worker reports
 *   `DedicatedWorkerGlobalScope`, a page `Window`).
 */
export interface GpuFailure {
  atMs: number;
  operation: string;
  message: string;
  backendCopies: number;
  resources: ResourceCounts;
}

export interface Diagnostic {
  timeline: { atMs: number; event: string }[];
  probes: { stage: string; result: string }[];
  realm: { open: string; readback: string | null };
}

const loadedMs = performance.now();
const realmName = (): string => (globalThis as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';

/** Record a stage on the timeline. */
export function mark(gpu: SpikeGpu, event: string): void {
  gpu.diagnostic.timeline.push({ atMs: Math.round((performance.now() - loadedMs) * 10) / 10, event });
}

/**
 * Round-trip four known bytes through a buffer: writeBuffer, then mapAsync. 'ok' when they come
 * back, otherwise what went wrong. Touches neither the canvas nor the core.
 */
export async function probe(gpu: SpikeGpu, stage: string): Promise<void> {
  const result = await roundTrip(gpu.device);
  gpu.diagnostic.probes.push({ stage, result });
  mark(gpu, `probe ${stage}: ${result}`);
}

async function roundTrip(device: GpuDevice): Promise<string> {
  const expected = [1, 2, 3, 4];
  try {
    const buffer = device.createBuffer({ size: 4, usage: BUFFER_COPY_DST | BUFFER_MAP_READ });
    live.mapping.add(buffer);
    try {
      device.queue.writeBuffer(buffer, 0, new Uint8Array(expected));
      await buffer.mapAsync(MAP_READ);
      const bytes = Array.from(new Uint8Array(buffer.getMappedRange().slice(0, 4)));
      buffer.unmap();
      return JSON.stringify(bytes) === JSON.stringify(expected) ? 'ok' : `wrong bytes ${JSON.stringify(bytes)}`;
    } finally {
      live.mapping.delete(buffer);
      buffer.destroy();
    }
  } catch (error) {
    return String(error);
  }
}

export interface GpuOpening { gpu: SpikeGpu | null; reason: string }

/**
 * Every GPU object this worker opened, and every buffer with a mapping in flight, reachable from the
 * worker's global scope until the worker ends, so a renderer that outlives one synchronous stretch
 * never depends on what happens to stay referenced from suspended async frames.
 *
 * This was first added as the fix for the readback failure of run 36892349174. It was not: run
 * 36896537472 failed identically with it in place, so collection is not the cause. It stays because
 * it is right for a long-lived renderer; the cause is what `Diagnostic` is for.
 */
const live = { opened: new Set<SpikeGpu>(), mapping: new Set<GpuBuffer>() };

/** The size of the texture target: the 640x480 the spike's canvas has. */
const XFB_WIDTH = 640;
const XFB_HEIGHT = 480;

/**
 * A device with an XFB target -- `canvas` configured for WebGPU, or, with `null`, an offscreen
 * 640x480 texture -- or the reason there is none. The fallback adapter is asked for when there is no
 * hardware one, because the CI runner renders in software.
 */
export async function openGpu(canvas: OffscreenCanvas | null): Promise<GpuOpening> {
  try {
    const gpu = (navigator as unknown as { gpu?: Gpu }).gpu;
    if (!gpu) return { gpu: null, reason: 'no navigator.gpu in this worker' };
    const adapter = (await gpu.requestAdapter()) ?? (await gpu.requestAdapter({ forceFallbackAdapter: true }));
    if (!adapter) return { gpu: null, reason: 'requestAdapter returned null, hardware and fallback' };
    const device = await adapter.requestDevice();
    const deviceMs = performance.now() - loadedMs;
    // Install observers before the first probe/configuration, not after those can fail.
    const opened: SpikeGpu = {
      gpu, adapter, canvas, device, context: null, xfb: null, format: 'rgba8unorm', errors: [],
      resources: {} as ResourceCounts, firstFailure: null, deviceLoss: null, validationErrors: [],
      recordFailure(operation, error) {
        if (!opened.firstFailure) opened.firstFailure = failureSnapshot(opened, operation, String(error));
      },
      diagnostic: {
        timeline: [{ atMs: Math.round(deviceMs * 10) / 10, event: 'device created' }],
        probes: [], realm: { open: realmName(), readback: null },
      },
    };
    opened.resources = countResources(device, (operation, error) => opened.recordFailure(operation, error));
    device.addEventListener('uncapturederror', (event) => {
      const type = event.error.constructor?.name ?? 'GPUError';
      const detail = failureSnapshot(opened, 'uncapturederror', event.error.message);
      opened.validationErrors.push({ ...detail, type });
      opened.recordFailure('uncapturederror', `${type}: ${event.error.message}`);
      opened.errors.push(`${type}: ${event.error.message}`);
      mark(opened, `uncapturederror ${type}: ${event.error.message}`);
    });
    void device.lost.then((info) => {
      opened.deviceLoss = { ...failureSnapshot(opened, 'device.lost', info.message), reason: info.reason ?? 'unknown' };
      opened.recordFailure('device.lost', info.message);
      opened.errors.push(`device lost: ${info.message}`);
      mark(opened, `device lost (reason ${info.reason ?? 'none'}): ${info.message}`);
    });
    live.opened.add(opened);
    await probe(opened, 'after device, before canvas');
    const usage = TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SRC | TEXTURE_COPY_DST;
    try {
      if (canvas) {
        opened.context = (canvas as unknown as { getContext(id: 'webgpu'): GpuCanvasContext | null }).getContext('webgpu');
        if (!opened.context) throw new Error('the canvas has no webgpu context');
        opened.context.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque', usage });
      } else {
        opened.xfb = device.createTexture({ size: [XFB_WIDTH, XFB_HEIGHT], format: 'rgba8unorm', usage });
      }
    } catch (error) {
      opened.failure = `configure: ${error}`;
      opened.recordFailure('configure', error);
      return { gpu: opened, reason: opened.failure };
    }
    mark(opened, 'device configured');
    return { gpu: opened, reason: 'device ready' };
  } catch (error) {
    return { gpu: null, reason: `WebGPU unavailable: ${error}` };
  }
}

function failureSnapshot(gpu: SpikeGpu, operation: string, message: string): GpuFailure {
  return { atMs: Math.round((performance.now() - loadedMs) * 10) / 10, operation, message,
    backendCopies: gpu.backendCopies ?? 0, resources: snapshotResources(gpu.resources) };
}

/** The core blocks this worker's task. Let queued GPU events run before serializing/terminating.
 * This is a bounded observation window, not proof that a device cannot be lost later. */
export async function observeGpuEvents(gpu: SpikeGpu): Promise<void> {
  mark(gpu, 'GPU event observation started (50ms minimum)');
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  mark(gpu, 'GPU event observation ended');
}

/** The XFB target the backend copies into: the offscreen texture, or the canvas's current texture. */
function target(gpu: SpikeGpu): GpuTexture {
  if (gpu.xfb) return gpu.xfb;
  if (!gpu.context) throw new Error('no XFB target');
  return gpu.context.getCurrentTexture();
}

/**
 * Clear the XFB target to `rgba` (0-255 each). The test paints a sentinel first, so a readback that
 * is not the sentinel proves the backend wrote the target.
 */
export function fillTarget(gpu: SpikeGpu, rgba: readonly number[]): void {
  const [r = 0, g = 0, b = 0, a = 255] = rgba;
  const encoder = gpu.device.createCommandEncoder();
  encoder.beginRenderPass({ colorAttachments: [{
    view: target(gpu).createView(), loadOp: 'clear', storeOp: 'store',
    clearValue: { r: r / 255, g: g / 255, b: b / 255, a: a / 255 },
  }] }).end();
  gpu.device.queue.submit([encoder.finish()]);
}

/**
 * The RGBA bytes of the XFB target's pixel at (x, y), copied off the GPU.
 *
 * Call it in the same task as the work it checks -- straight after `callMain` returns, before any
 * `await` -- because a canvas's current texture is replaced once the worker's task ends and the
 * frame is committed. The copy is encoded synchronously, so only the mapping waits. With a canvas
 * target the mapping must also outlive that commit, which CI's Chromium does not allow (above).
 */
export async function readPixel(gpu: SpikeGpu, x = 0, y = 0): Promise<number[] | null> {
  let buffer: GpuBuffer | null = null;
  gpu.diagnostic.realm.readback = realmName();
  try {
    buffer = gpu.device.createBuffer({ size: 256, usage: BUFFER_COPY_DST | BUFFER_MAP_READ });
    live.mapping.add(buffer);
    const encoder = gpu.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target(gpu), origin: [x, y] },
      { buffer, bytesPerRow: 256 }, [1, 1]);
    gpu.device.queue.submit([encoder.finish()]);
    mark(gpu, 'readback submitted');
    await buffer.mapAsync(MAP_READ);
    mark(gpu, 'readback mapped');
    const pixel = Array.from(new Uint8Array(buffer.getMappedRange().slice(0, 4)));
    buffer.unmap();
    return pixel;
  } catch (error) {
    gpu.recordFailure('readback', error);
    gpu.errors.push(`readback: ${error}`);
    mark(gpu, `readback failed: ${error}`);
    return null;
  } finally {
    if (buffer) { live.mapping.delete(buffer); buffer.destroy(); }
  }
}

/**
 * One FNV-1a hash (8 hex digits) per 80x80 cell of the 640x480 XFB target, row by row, and how many
 * cells hold a pixel that is not `clear` (RGBA). The same constraints as `readPixel`. This is how
 * wasm/render/pixel_pipeline_check.mjs compares every pixel of two renderings of the same states.
 */
export async function readCells(gpu: SpikeGpu, clear: readonly number[]): Promise<{ cells: string[]; drawn: number } | null> {
  const WIDTH = 640, HEIGHT = 480, CELL = 80, ROW_BYTES = WIDTH * 4;
  let buffer: GpuBuffer | null = null;
  try {
    buffer = gpu.device.createBuffer({ size: ROW_BYTES * HEIGHT, usage: BUFFER_COPY_DST | BUFFER_MAP_READ });
    live.mapping.add(buffer);
    const encoder = gpu.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target(gpu), origin: [0, 0] },
      { buffer, bytesPerRow: ROW_BYTES }, [WIDTH, HEIGHT]);
    gpu.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(MAP_READ);
    const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    const cells: string[] = [];
    let drawn = 0;
    for (let cy = 0; cy < HEIGHT; cy += CELL) {
      for (let cx = 0; cx < WIDTH; cx += CELL) {
        let hash = 0x811c9dc5, other = false;
        for (let y = cy; y < cy + CELL; y++) {
          for (let x = cx; x < cx + CELL; x++) {
            for (let c = 0; c < 4; c++) {
              const v = bytes[y * ROW_BYTES + x * 4 + c]!;
              hash = Math.imul(hash ^ v, 0x01000193) >>> 0;
              if (v !== clear[c]) other = true;
            }
          }
        }
        cells.push(hash.toString(16).padStart(8, '0'));
        if (other) drawn++;
      }
    }
    return { cells, drawn };
  } catch (error) {
    gpu.recordFailure('readback', error);
    gpu.errors.push(`readback: ${error}`);
    return null;
  } finally {
    if (buffer) { live.mapping.delete(buffer); buffer.destroy(); }
  }
}

/** The renderer's counts for a heartbeat (heartbeat.ts), read off the object gx_webgpu.cpp writes. */
export function renderProgress(gpu: SpikeGpu): RenderProgress {
  return {
    draws: gpu.drawSerial ?? 0, copies: gpu.backendCopies ?? 0,
    texturePool: gpu.texturePool?.size ?? null, bindGroupCache: gpu.bindGroups?.size ?? null,
    texturesCreated: gpu.resources.texture.created, bindGroupsCreated: gpu.resources.bindGroup.created,
    failure: gpu.failure ?? null,
  };
}
