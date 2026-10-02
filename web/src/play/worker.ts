import { openGpu } from '../spike/gpu.js';
import { PRESENTED, readPad } from './shared-pad.js';

interface Core {
  FS: {
    mkdir(path: string): void;
    mount(type: unknown, options: { files: File[] }, path: string): void;
    filesystems: Record<string, unknown>;
  };
  callMain(args: string[]): number;
  _gx_webgpu_selftest?(argb: number, copies: number, geometry: number): number;
  _gx_webgpu_attach?(): number;
  _melee_live_input_version?(): number;
}
const scope = self as unknown as DedicatedWorkerGlobalScope;
let running = false;
scope.onmessage = async (event: MessageEvent<{ iso: File; pad: SharedArrayBuffer; selftest?: boolean }>) => {
  if (running) return;
  running = true;
  try {
    const shared = new Int32Array(event.data.pad);
    const canvas = new OffscreenCanvas(640, 480);
    const opening = await openGpu(canvas);
    const gpu = opening.gpu;
    if (!gpu || gpu.failure) throw new Error(gpu?.failure ?? opening.reason);
    const url = '/spike-core/melee_core_web.js';
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok || !head.headers.get('content-type')?.includes('javascript')) {
      throw new Error('Playable core unavailable: deploy the CI core built with live input support.');
    }
    const factory = (await import(/* @vite-ignore */ url)).default as (options: unknown) => Promise<Core>;
    let deadline = performance.now();
    let serial = 0;
    const options = {
      print: (line: string) => scope.postMessage({ type: 'log', line }),
      printErr: (line: string) => scope.postMessage({ type: 'log', line }),
      gxWebgpu: gpu,
      livePad: () => readPad(shared),
      heartbeat: (retraces: number) => {
        if (gpu.failure) throw new Error(gpu.failure);
        // callMain never yields. Explicit bitmap presentation releases the WebGPU canvas
        // image every retrace, instead of waiting for the worker's task to return.
        const bitmap = canvas.transferToImageBitmap();
        scope.postMessage({ type: 'frame', bitmap, serial: ++serial, retraces }, [bitmap]);
        // Backpressure also stops background tabs from accumulating images or running ahead.
        while (Atomics.load(shared, PRESENTED) !== serial) {
          Atomics.wait(shared, PRESENTED, Atomics.load(shared, PRESENTED), 100);
        }
        deadline = Math.max(deadline + 1000 / 60, performance.now());
        const delay = deadline - performance.now();
        if (delay > 0) Atomics.wait(shared, PRESENTED, serial, delay);
      },
    };
    const core = await factory(options);
    if (core._melee_live_input_version?.() !== 1) throw new Error('This deployed core predates live input; rebuild it in CI.');
    if (core._gx_webgpu_attach?.() !== 1) throw new Error(`Renderer attach failed: ${gpu.failure ?? opening.reason}`);
    if (event.data.selftest) {
      if (!core._gx_webgpu_selftest) throw new Error('Core has no renderer selftest');
      for (let frame = 1; frame <= 3; frame++) {
        core._gx_webgpu_selftest(0xff2080c0, 2, 0);
        options.heartbeat(frame);
      }
      scope.postMessage({ type: 'ended', exitCode: 0 });
      return;
    }
    core.FS.mkdir('/disc');
    core.FS.mount(core.FS.filesystems['WORKERFS'], { files: [event.data.iso] }, '/disc');
    core.FS.mkdir('/card');
    scope.postMessage({ type: 'ready' });
    // Live play starts at the game's menus. No script, trace hashing or growing timing CSV.
    const exitCode = core.callMain(['--iso', `/disc/${event.data.iso.name}`, '--headless', '--fast',
      '--frames', '4294967295', '--time-base', '1', '--volume', '0', '--card-dir', '/card']);
    scope.postMessage({ type: 'ended', exitCode });
  } catch (error) {
    scope.postMessage({ type: 'error', message: String(error) });
  }
};
