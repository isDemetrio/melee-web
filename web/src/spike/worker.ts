// P0-10 spike worker: loads the offline core once, runs one simulation synchronously, and
// posts back the checkpoint trace and per-retrace simulation times. One run per Worker.
//
// A run may also be handed an OffscreenCanvas (spike.html?canvas). The worker then acquires a
// WebGPU device for it before the simulation starts and attaches the core's WebGPU backend
// (wasm/render/gx_webgpu.cpp). Without a canvas, or when any of that fails, the run is exactly the
// headless run it always was; the reason is reported, never thrown.
import { decoderCostReport, type DecoderCostMode } from './decoder-cost.js';
import { fillTarget, mark, observeGpuEvents, openGpu, probe, readPixel, type Diagnostic, type SpikeGpu } from './gpu.js';

interface CoreFS {
  mkdir(path: string): void;
  writeFile(path: string, data: string): void;
  readFile(path: string, options: { encoding: 'utf8' }): string;
  mount(type: unknown, options: { files: File[] }, mountpoint: string): void;
  filesystems: Record<string, unknown>;
}
interface MeleeCore {
  FS: CoreFS;
  callMain(args: string[]): number;
  _melee_decoder_cost?(mode: number): number;
  // Absent from a core built before the WebGPU backend existed, which then simply runs headless.
  _gx_webgpu_attach?(): number;
  _gx_webgpu_presented?(): number;
  _gx_webgpu_selftest?(argb: number, copies: number, geometry: number): number;
}
interface CoreOptions {
  print(line: string): void;
  printErr(line: string): void;
  /** Becomes `Module.gxWebgpu`, which is where gx_webgpu.cpp looks for its device. */
  gxWebgpu?: SpikeGpu;
}
type CoreFactory = (options: CoreOptions) => Promise<MeleeCore>;

const CORE = '/spike-core/';
const scope = self as unknown as DedicatedWorkerGlobalScope;
const lines: string[] = [];
const log = (line: string): void => { lines.push(line); scope.postMessage({ type: 'log', line }); };
/**
 * When this worker started. `core_load_ms` is measured from here to the `core` message, so it
 * covers the whole wait the operator actually has: the four fetches, the module's own download
 * and compile, the runtime's initialisation, and the timer-resolution probe. It is not a
 * simulation number and nothing about the run depends on it.
 */
const startedMs = performance.now();

/** Smallest observable step of performance.now(): the resolution every sim_ms is quantised to. */
function timerResolutionMs(): number {
  let best = Number.POSITIVE_INFINITY;
  let last = performance.now();
  for (let i = 0; i < 200_000; i++) {
    const now = performance.now();
    if (now > last) { best = Math.min(best, now - last); last = now; }
  }
  return best;
}

/** The run's message: a disc to simulate, or the renderer self-test; a canvas for either, or none. */
interface RunRequest {
  iso?: File;
  frames?: number;
  decoderCost?: DecoderCostMode;
  canvas?: OffscreenCanvas;
  /**
   * The render test (web/tests/spike/render.spec.ts): feed the decoder `copies` clearing XFB copies.
   * `target: 'texture'` renders into an offscreen texture instead of a canvas (gpu.ts says why).
   */
  selftest?: { argb: number; copies: number; repeats: number; geometry: number; sampleX: number; target?: 'canvas' | 'texture' };
}

/** What the renderer did, reported in the result; `null` when no canvas was handed in. */
interface RenderReport {
  attached: boolean;
  reason: string;
  presented: number;
  lastClearArgb: number | null;
  /** What the backend copied into: the canvas, or an offscreen texture. */
  target: 'canvas' | 'texture' | null;
  /** RGBA of the target's pixel (0, 0), read back off the GPU after the run; null if it failed. */
  readback: number[] | null;
  failure: string | null;
  errors: string[];
  resources: SpikeGpu['resources'] | null;
  firstFailure: SpikeGpu['firstFailure'];
  deviceLoss: SpikeGpu['deviceLoss'];
  validationErrors: SpikeGpu['validationErrors'];
  /** Where a failing readback died (gpu.ts, `Diagnostic`), plus who held which object. */
  diagnostic: (Diagnostic & {
    /** `Module.gxWebgpu` is the object this worker opened: the backend saw this worker's device. */
    moduleSawThisGpu: boolean;
    /** The device gx_webgpu.cpp copied with is the device the readback uses, and how many copies. */
    backendUsedThisDevice: boolean;
    backendCopies: number;
  }) | null;
}

/** Attach the core's WebGPU backend to an opened device. Never throws: false and a reason instead. */
function attach(core: MeleeCore, gpu: SpikeGpu | null, reason: string): { attached: boolean; reason: string } {
  if (!gpu || gpu.failure) return { attached: false, reason };
  if (!core._gx_webgpu_attach) return { attached: false, reason: 'this core has no WebGPU backend' };
  try {
    return core._gx_webgpu_attach() === 1
      ? { attached: true, reason }
      : { attached: false, reason: `the backend refused the device: ${gpu.failure ?? 'no reason given'}` };
  } catch (error) {
    return { attached: false, reason: `attaching the backend threw: ${error}` };
  }
}

async function report(core: MeleeCore, gpu: SpikeGpu | null, attached: { attached: boolean; reason: string },
  pixel: Promise<number[] | null> | null): Promise<RenderReport> {
  const readback = pixel ? await pixel : null;
  if (gpu) await observeGpuEvents(gpu);
  return {
    ...attached,
    presented: attached.attached && core._gx_webgpu_presented ? core._gx_webgpu_presented() : 0,
    lastClearArgb: gpu?.lastClearArgb ?? null,
    target: gpu ? (gpu.xfb ? 'texture' : 'canvas') : null,
    readback,
    resources: gpu?.resources ?? null,
    firstFailure: gpu?.firstFailure ?? null,
    deviceLoss: gpu?.deviceLoss ?? null,
    validationErrors: gpu?.validationErrors ?? [],
    failure: gpu?.failure ?? null,
    errors: gpu?.errors ?? [],
    diagnostic: gpu ? {
      ...gpu.diagnostic,
      moduleSawThisGpu: (core as unknown as { gxWebgpu?: unknown }).gxWebgpu === gpu,
      backendUsedThisDevice: gpu.backendDevice === gpu.device,
      backendCopies: gpu.backendCopies ?? 0,
    } : null,
  };
}

/** What the render test paints the canvas with first: a pixel that is not this was written by the backend. */
const SENTINEL = [255, 0, 255, 255];

scope.onmessage = async (event: MessageEvent<RunRequest>) => {
  const { iso, frames, canvas, selftest, decoderCost = 'off' } = event.data;
  try {
    const head = await fetch(`${CORE}melee_core_web.js`, { method: 'HEAD' });
    const type = head.headers.get('content-type') ?? '';
    if (!head.ok || !type.includes('javascript')) {
      throw new Error(`no core at ${CORE} (HTTP ${head.status}, ${type}); it is built only by phase0-build.yml`);
    }
    const meta = (await (await fetch(`${CORE}core.json`)).json()) as { commit: string; opt: string };
    const script = await (await fetch(`${CORE}parity_vs_onett.txt`)).text();
    const factory = ((await import(/* @vite-ignore */ `${CORE}melee_core_web.js`)) as { default: CoreFactory }).default;
    const resolution = timerResolutionMs();
    // The device is acquired before the core exists, so it can be handed in as a factory option:
    // the options object is the module's `Module`, where the backend looks for it.
    const opening = canvas ? await openGpu(canvas) : selftest?.target === 'texture' ? await openGpu(null) : null;
    const gpu = opening?.gpu ?? null;
    // Diagnostic probes (gpu.ts, `Diagnostic`): before the module exists, and once it does.
    if (gpu) await probe(gpu, 'after device, before core');
    const core = await factory(gpu ? { print: log, printErr: log, gxWebgpu: gpu } : { print: log, printErr: log });
    const coreLoadMs = performance.now() - startedMs;
    scope.postMessage({ type: 'core', commit: meta.commit, opt: meta.opt, coreLoadMs });
    if (gpu) { mark(gpu, 'core instantiated'); await probe(gpu, 'after core, before attach'); }
    const attached = opening ? attach(core, gpu, opening.reason) : null;
    if (gpu) mark(gpu, `attach returned ${attached?.attached}`);
    if (selftest) {
      // Sentinel, decoder, readback: one synchronous stretch, so all three see the same canvas texture.
      if (gpu && attached?.attached) fillTarget(gpu, SENTINEL);
      if (!Number.isInteger(selftest.repeats) || selftest.repeats < 1 || selftest.repeats > 2400) {
        throw new Error('selftest repeats must be an integer in [1, 2400]');
      }
      let presented: number | null = null;
      // Deliberately one synchronous task, like callMain: retirement callbacks cannot run here.
      for (let i = 0; i < selftest.repeats; i++) {
        presented = core._gx_webgpu_selftest ? core._gx_webgpu_selftest(selftest.argb >>> 0, selftest.copies, selftest.geometry) : null;
        if (gpu?.failure) break;
      }
      if (gpu) mark(gpu, `selftest returned ${presented}`);
      const pixel = gpu && attached?.attached ? readPixel(gpu, selftest.geometry ? selftest.sampleX : 0, selftest.geometry ? 240 : 0) : null;
      // Started in the same task as the readback, on a buffer that never touches the canvas.
      const sameTask = gpu ? probe(gpu, 'same task as the readback') : null;
      if (sameTask) await sameTask;
      const render = attached ? await report(core, gpu, attached, pixel) : null;
      scope.postMessage({ type: 'selftest', presented, sentinel: SENTINEL, render });
      return;
    }
    if (!iso || !frames) throw new Error('a run needs a disc and a frame count');
    const fs = core.FS;
    fs.mkdir('/disc');
    fs.mount(fs.filesystems['WORKERFS'], { files: [iso] }, '/disc');
    fs.mkdir('/work');
    fs.mkdir('/work/card');
    fs.writeFile('/work/script.txt', script);
    // The same arguments as scripts/phase0/run_checkpoints.sh, so traces compare one to one.
    const args = ['--iso', `/disc/${iso.name}`, '--headless', '--fast', '--frames', String(frames),
      '--time-base', '1', '--volume', '0', '--script', '/work/script.txt', '--card-dir', '/work/card',
      '--state-trace', '/work/trace.csv', '--sim-times', '/work/sim_times.csv'];
    const costAvailable = typeof core._melee_decoder_cost === 'function';
    if (decoderCost !== 'off' && !costAvailable) throw new Error('this core has no decoder-cost instrumentation');
    if (costAvailable && core._melee_decoder_cost!(decoderCost === 'profile' ? 1 : decoderCost === 'legacy' ? 2 : 0) !== 1) {
      throw new Error('decoder-cost setup failed');
    }
    const started = performance.now();
    const exitCode = core.callMain(args);
    const wallMs = performance.now() - started;
    // Before any await: the canvas texture the run drew into is replaced once this task ends.
    const pixel = gpu && attached?.attached ? readPixel(gpu) : null;
    const read = (path: string): string => { try { return fs.readFile(path, { encoding: 'utf8' }); } catch { return ''; } };
    const render = attached ? await report(core, gpu, attached, pixel) : null;
    scope.postMessage({
      type: 'done', exitCode, wallMs, coreCommit: meta.commit, coreOpt: meta.opt, coreLoadMs,
      timerResolutionMs: resolution, crossOriginIsolated: scope.crossOriginIsolated,
      finalScene: lines.find((line) => line.startsWith('final scene:')) ?? null,
      decoderCost: decoderCostReport(decoderCost, costAvailable, decoderCost === 'profile' ? read('/work/decoder_cost.csv') : ''),
      trace: read('/work/trace.csv'), simTimes: read('/work/sim_times.csv'), render,
    });
  } catch (error) {
    scope.postMessage({ type: 'error', message: String(error) });
  }
};
