/**
 * How the play worker hands a frame to the page, and the experiments that take that cost apart.
 *
 * The phone's `bitmap_ms` (frame-meter.ts) is one synchronous `OffscreenCanvas.transferToImageBitmap`.
 * In WebKit (main, read 2026-10-05; docs/PRESENTATION.md quotes the code) it is two synchronous
 * messages to the GPU process, and the second can only answer once the GPU has finished the frame:
 *
 * 1. `PrepareForDisplay`: the GPU process first works through every WebGPU message the frame sent
 *    before it (the stream is ordered), then presents, and answers once every command buffer
 *    submitted so far has been *scheduled* by Metal (`Queue::onSubmittedWorkScheduled`).
 * 2. `PaintCompositedResultsToCanvas`: `waitForCommandBufferCompletion()` on the canvas texture --
 *    the GPU has *finished* the command buffer that wrote it -- then, for a canvas that is not
 *    BGRA8 or RGBA16F, `[MTLTexture getBytes:]` of the whole canvas into malloc'd memory and a
 *    CGImage drawn into a new accelerated ImageBuffer. A BGRA8 canvas skips that copy: its IOSurface
 *    is the image. The play canvas is `rgba8unorm`.
 *
 * So `bitmap_ms` holds the GPU process's tail of the frame, the GPU's execution of the frame, and
 * the transfer proper; nothing in the page tells them apart. Two experiments do, and a third
 * measures the transfer alone. None of them is on by default, and none changes the default path:
 *
 * - `probe` (TransferProbe): after every second frame, clear a separate canvas and transfer it. The
 *   GPU has nothing else queued (the frame's own transfer has just waited for it), so this is the
 *   transfer with no frame behind it. Six canvases take turns -- 320x240, 640x480 and 1280x960, each
 *   in rgba8unorm and bgra8unorm -- so one session gives the cost against pixels and against format.
 * - `alternate` (Presenter): blocks of ALTERNATE_BLOCK frames, alternately presented as today and
 *   one frame late. Late means the renderer draws the XFB into one of two offscreen textures, and the
 *   canvas receives the PREVIOUS frame's texture in a command buffer submitted just before the
 *   current frame's: the transfer then waits for a frame the GPU has had a whole cycle to finish,
 *   not for the one just submitted. The difference between the blocks is the GPU work of the frame
 *   that the direct transfer waits for. It costs one frame of latency, and a frame shown twice or
 *   skipped at each block boundary.
 * - `bgra`: the whole renderer in bgra8unorm (EFB, pipelines, EFB copies, canvas; an XFB copy stays a
 *   plain texture copy). The pixels are the same; WebKit takes the IOSurface path instead of the
 *   CPU copy.
 */
import type { CanvasFormat } from '../spike/gpu.js';
import type { ProbeTiming } from './frame-meter.js';

export type PresentSchedule = 'direct' | 'probe' | 'alternate';
export interface PresentationMode { name: string; format: CanvasFormat; schedule: PresentSchedule }

/** The modes the Game screen offers. `direct` is the path every session used before. */
export const PRESENTATION_MODES: readonly PresentationMode[] = [
  { name: 'direct', format: 'rgba8unorm', schedule: 'direct' },
  { name: 'probe', format: 'rgba8unorm', schedule: 'probe' },
  { name: 'alternate', format: 'rgba8unorm', schedule: 'alternate' },
  { name: 'bgra', format: 'bgra8unorm', schedule: 'direct' },
  { name: 'bgra-probe', format: 'bgra8unorm', schedule: 'probe' },
  { name: 'bgra-alternate', format: 'bgra8unorm', schedule: 'alternate' },
];
export function presentationMode(name: string | undefined): PresentationMode {
  return PRESENTATION_MODES.find((mode) => mode.name === name) ?? PRESENTATION_MODES[0]!;
}

/**
 * The modes the Game screen lists. The probe's two (`probe`, `bgra-probe`) only with `?probe` in the
 * page's address: on the iPhone (Safari, iOS 18.7) bgra-probe closed the page soon after the match
 * began, with no report, and nothing CI can run reproduces it (docs/PRESENTATION_COST.md, "The
 * bgra-probe crash"). The probe is bgra-probe's only difference from bgra, and the same six canvases
 * in `probe`. A tool that closes the page is worse than none, so it is not one tap away; whoever
 * opens it on purpose gets the record of the session that died (report.ts, `stored`).
 */
export function offeredModes(search: string): readonly PresentationMode[] {
  if (new URLSearchParams(search).has('probe')) return PRESENTATION_MODES;
  return PRESENTATION_MODES.filter((mode) => mode.schedule !== 'probe');
}

/** Frames per block of `alternate`: about 6 s at 40 fps, so a 3-minute match is ~15 pairs. */
export const ALTERNATE_BLOCK = 240;
/** `present_mode`: as today, one frame late, and the first frame of a late block (shown at once). */
export const PRESENT_DIRECT = 0, PRESENT_LATE = 1, PRESENT_LATE_FIRST = 2;

/** `probe` runs after every PROBE_EVERY-th frame, so the frames between show what it costs. */
export const PROBE_EVERY = 2;
export const PROBE_SIZES: readonly (readonly [number, number])[] = [[320, 240], [640, 480], [1280, 960]];
export const PROBE_FORMATS: readonly CanvasFormat[] = ['rgba8unorm', 'bgra8unorm'];

const TEXTURE_COPY_SRC = 0x01, TEXTURE_COPY_DST = 0x02, TEXTURE_RENDER_ATTACHMENT = 0x10;

interface Texture { readonly width: number; readonly height: number; createView(): unknown }
interface Encoder {
  copyTextureToTexture(source: unknown, destination: unknown, size: number[]): void;
  beginRenderPass(descriptor: unknown): { end(): void };
  finish(): unknown;
}
interface Device {
  createTexture(descriptor: { size: number[]; format: string; usage: number }): Texture;
  createCommandEncoder(): Encoder;
  queue: { submit(buffers: unknown[]): void };
}
interface Context {
  configure(configuration: { device: unknown; format: string; alphaMode: string; usage: number }): void;
  getCurrentTexture(): Texture;
}
/** The part of `Module.gxWebgpu` the presenter touches; gx_webgpu.cpp's gxw_open adds `flush`. */
export interface PresentGpu {
  device: Device;
  context: Context | null;
  xfb: Texture | null;
  format: CanvasFormat;
  flush?: () => void;
}
interface Canvas { transferToImageBitmap(): ImageBitmap }

/**
 * Hands the canvas over at each retrace: as today (`direct`, `probe`), or alternating with the
 * one-frame-late presentation described above (`alternate`).
 *
 * Late presentation needs no change to the renderer. gxw_copy reads `gpu.xfb` only on an XFB copy and
 * copies there instead of to the canvas when it is set, then calls `gpu.flush()`, which submits the
 * frame's batch. Here `xfb` is an accessor: in a late block it returns this frame's texture and notes
 * the read, and the wrapped `flush` submits the previous frame's copy to the canvas just before it.
 */
export class Presenter {
  private late = false;
  private readonly textures: Texture[] = [];
  private current = 0;
  /** The texture of the last XFB copy, and the one written in this retrace, if any. */
  private last: Texture | null = null;
  private written: Texture | null = null;
  private xfbRead = false;
  private canvasWritten = false;
  private frames = 0;

  /** `block`: frames per block of `alternate`; only a test asks for fewer than ALTERNATE_BLOCK. */
  constructor(private readonly gpu: PresentGpu, private readonly canvas: Canvas,
    private readonly schedule: PresentSchedule, private readonly block = ALTERNATE_BLOCK) {}

  /** After the backend's attach, which defines `gpu.flush`. Nothing to install unless alternating. */
  install(): void {
    if (this.schedule !== 'alternate') return;
    const gpu = this.gpu;
    const flush = gpu.flush;
    if (typeof flush !== 'function') throw new Error('alternate presentation: the renderer has no flush');
    if (!gpu.context) throw new Error('alternate presentation: no canvas context');
    for (let i = 0; i < 2; i++) {
      this.textures.push(gpu.device.createTexture({ size: [640, 480], format: gpu.format,
        usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST | TEXTURE_RENDER_ATTACHMENT }));
    }
    Object.defineProperty(gpu, 'xfb', {
      configurable: true, enumerable: true,
      get: () => {
        if (!this.late) return null;
        this.xfbRead = true;
        return this.textures[this.current]!;
      },
      set: () => { throw new Error('alternate presentation owns gpu.xfb'); },
    });
    gpu.flush = () => {
      const xfb = this.xfbRead;
      this.xfbRead = false;
      if (xfb && this.last) { this.toCanvas(this.last); this.canvasWritten = true; }
      flush.call(gpu);
      if (xfb) {
        this.written = this.last = this.textures[this.current]!;
        this.current ^= 1;
      }
    };
  }

  /** The retrace's bitmap, and how the canvas got its picture (PRESENT_*). */
  present(): { bitmap: ImageBitmap; mode: number } {
    let mode = PRESENT_DIRECT;
    if (this.late) {
      mode = PRESENT_LATE;
      // The first XFB copy of a late block has no previous texture: it is shown at once.
      if (!this.canvasWritten && this.written) { this.toCanvas(this.written); mode = PRESENT_LATE_FIRST; }
    }
    const bitmap = this.canvas.transferToImageBitmap();
    this.canvasWritten = false;
    this.written = null;
    if (this.schedule === 'alternate' && ++this.frames % this.block === 0) {
      this.late = !this.late;
      this.last = null;
    }
    return { bitmap, mode };
  }

  private toCanvas(source: Texture): void {
    const target = this.gpu.context!.getCurrentTexture();
    const encoder = this.gpu.device.createCommandEncoder();
    encoder.copyTextureToTexture({ texture: source }, { texture: target },
      [Math.min(source.width, target.width), Math.min(source.height, target.height)]);
    this.gpu.device.queue.submit([encoder.finish()]);
  }
}

interface ProbeTarget { canvas: Canvas; context: Context; px: number; bgra: boolean }

/**
 * The transfer with no frame behind it, on canvases of its own (see the top of this file). Its
 * WebGPU calls go through the functions captured before the meter wrapped them, so they are in no
 * frame's webgpu_calls; its time is the frame's `probe_ms`.
 */
export class TransferProbe {
  private readonly targets: ProbeTarget[] = [];
  private frames = 0;
  private turn = 0;

  constructor(private readonly createEncoder: () => Encoder, private readonly submit: (buffers: unknown[]) => void,
    device: unknown, makeCanvas: (width: number, height: number) => Canvas & { getContext(id: 'webgpu'): unknown },
    private readonly now: () => number) {
    for (const [width, height] of PROBE_SIZES) {
      for (const format of PROBE_FORMATS) {
        const canvas = makeCanvas(width, height);
        const context = canvas.getContext('webgpu') as Context | null;
        if (!context) throw new Error('transfer probe: no webgpu context');
        context.configure({ device, format, alphaMode: 'opaque', usage: TEXTURE_RENDER_ATTACHMENT });
        this.targets.push({ canvas, context, px: width * height, bgra: format === 'bgra8unorm' });
      }
    }
  }

  /**
   * After the frame's own presentation: one probe every PROBE_EVERY frames, null otherwise. The
   * meter times the whole of it (clear, submit, transfer) as the frame's probe_ms.
   */
  run(): ProbeTiming | null {
    if (++this.frames % PROBE_EVERY !== 0) return null;
    const target = this.targets[this.turn++ % this.targets.length]!;
    const encoder = this.createEncoder();
    encoder.beginRenderPass({ colorAttachments: [{ view: target.context.getCurrentTexture().createView(),
      loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] }).end();
    this.submit([encoder.finish()]);
    const submitted = this.now();
    target.canvas.transferToImageBitmap().close();
    const done = this.now();
    return { transferMs: done - submitted, px: target.px, bgra: target.bgra };
  }
}
