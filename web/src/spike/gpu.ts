/**
 * The spike worker's WebGPU half: acquire a device for a transferred `OffscreenCanvas`, hand it to
 * the core's backend (`wasm/render/gx_webgpu.cpp` reads it as `Module.gxWebgpu`), and read a pixel
 * of what the backend presented back off the GPU.
 *
 * The device is acquired here, before the simulation starts, because the simulation is one
 * synchronous `callMain` and `requestAdapter` / `requestDevice` resolve only once the event loop
 * turns. Nothing here throws: a browser without WebGPU, a null adapter, a device that cannot be
 * created or a canvas that will not configure all come back as `{ gpu: null, reason }`, and the
 * run goes on headless exactly as it does without a canvas.
 *
 * The WebGPU declarations are the few this file uses, written out because the shell carries no
 * `@webgpu/types` (the same choice `platform/capabilities.ts` makes). The numeric flags are the
 * WebGPU specification's values for `GPUTextureUsage`, `GPUBufferUsage` and `GPUMapMode`.
 */

const TEXTURE_COPY_SRC = 0x01;
const TEXTURE_COPY_DST = 0x02;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const MAP_READ = 0x0001;

interface GpuTexture { readonly width: number; readonly height: number; createView(): unknown }
interface GpuBuffer { mapAsync(mode: number): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void }
interface GpuRenderPass { end(): void }
interface GpuCommandEncoder {
  beginRenderPass(descriptor: unknown): GpuRenderPass;
  copyTextureToBuffer(source: unknown, destination: unknown, size: number[]): void;
  finish(): unknown;
}
interface GpuDevice {
  createBuffer(descriptor: { size: number; usage: number }): GpuBuffer;
  createCommandEncoder(): GpuCommandEncoder;
  queue: { submit(buffers: unknown[]): void };
  lost: Promise<{ message: string }>;
  addEventListener(type: 'uncapturederror', listener: (event: { error: { message: string } }) => void): void;
}
interface GpuAdapter { requestDevice(): Promise<GpuDevice> }
interface Gpu { requestAdapter(options?: { forceFallbackAdapter?: boolean }): Promise<GpuAdapter | null> }
interface GpuCanvasContext {
  configure(configuration: { device: GpuDevice; format: string; alphaMode: string; usage: number }): void;
  getCurrentTexture(): GpuTexture;
}

/** What `gx_webgpu.cpp` reads as `Module.gxWebgpu`, and what it writes back into it. */
export interface SpikeGpu {
  device: GpuDevice;
  context: GpuCanvasContext;
  /** The EFB's and the canvas's format: one format, so an XFB copy is a plain texture copy. */
  format: 'rgba8unorm';
  /** Written by the backend: the last clear colour (ARGB), and why it stopped if it did. */
  lastClearArgb?: number;
  failure?: string;
  /** Written here: validation errors and device loss, which WebGPU reports without throwing. */
  errors: string[];
}

export interface GpuOpening { gpu: SpikeGpu | null; reason: string }

/**
 * A device configured on `canvas`, or the reason there is none. The fallback adapter is asked for
 * when there is no hardware one, because the CI runner renders in software
 * (`wasm/probe/webgpu_probe.html` makes the same two requests).
 */
export async function openGpu(canvas: OffscreenCanvas): Promise<GpuOpening> {
  try {
    const gpu = (navigator as unknown as { gpu?: Gpu }).gpu;
    if (!gpu) return { gpu: null, reason: 'no navigator.gpu in this worker' };
    const adapter = (await gpu.requestAdapter()) ?? (await gpu.requestAdapter({ forceFallbackAdapter: true }));
    if (!adapter) return { gpu: null, reason: 'requestAdapter returned null, hardware and fallback' };
    const device = await adapter.requestDevice();
    const context = (canvas as unknown as { getContext(id: 'webgpu'): GpuCanvasContext | null })
      .getContext('webgpu');
    if (!context) return { gpu: null, reason: 'the canvas has no webgpu context' };
    // COPY_DST for the XFB copy into it, COPY_SRC for readPixel.
    context.configure({
      device, format: 'rgba8unorm', alphaMode: 'opaque',
      usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SRC | TEXTURE_COPY_DST,
    });
    const opened: SpikeGpu = { device, context, format: 'rgba8unorm', errors: [] };
    device.addEventListener('uncapturederror', (event) => { opened.errors.push(event.error.message); });
    void device.lost.then((info) => { opened.errors.push(`device lost: ${info.message}`); });
    return { gpu: opened, reason: 'device ready' };
  } catch (error) {
    return { gpu: null, reason: `WebGPU unavailable: ${error}` };
  }
}

/**
 * Clear the canvas's current texture to `rgba` (0-255 each). The test paints a sentinel first, so a
 * readback that is not the sentinel proves the backend wrote the canvas.
 */
export function fillCanvas(gpu: SpikeGpu, rgba: readonly number[]): void {
  const [r = 0, g = 0, b = 0, a = 255] = rgba;
  const encoder = gpu.device.createCommandEncoder();
  encoder.beginRenderPass({ colorAttachments: [{
    view: gpu.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store',
    clearValue: { r: r / 255, g: g / 255, b: b / 255, a: a / 255 },
  }] }).end();
  gpu.device.queue.submit([encoder.finish()]);
}

/**
 * The RGBA bytes of the canvas pixel at (x, y), copied off the GPU.
 *
 * Call it in the same task as the work it checks -- straight after `callMain` returns, before any
 * `await` -- because a canvas's current texture is replaced once the worker's task ends and the
 * frame is committed. The copy is encoded synchronously, so only the mapping waits.
 */
export async function readPixel(gpu: SpikeGpu, x = 0, y = 0): Promise<number[] | null> {
  try {
    const buffer = gpu.device.createBuffer({ size: 256, usage: BUFFER_COPY_DST | BUFFER_MAP_READ });
    const encoder = gpu.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: gpu.context.getCurrentTexture(), origin: [x, y] },
      { buffer, bytesPerRow: 256 }, [1, 1]);
    gpu.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(MAP_READ);
    const pixel = Array.from(new Uint8Array(buffer.getMappedRange().slice(0, 4)));
    buffer.unmap();
    return pixel;
  } catch (error) {
    gpu.errors.push(`readback: ${error}`);
    return null;
  }
}
