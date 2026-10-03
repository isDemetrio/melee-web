import { clockCostNs, timerResolutionMs } from '../spike/clock.js';
import { openGpu, renderProgress } from '../spike/gpu.js';
import { heartbeatSender } from '../spike/heartbeat.js';
import { openCachedDisc, readDiscThrough, type OpfsDirectory, type SyncReadHandle } from './disc-reader.js';
import { coreSplitOf, CsvTail, FrameMeter, instrumentGpu, matchFrameOf, meterDiscReads, type FrameRecord,
  type TailFs, verifyQueueHooks } from './frame-meter.js';
import { PRESENTED, readPad } from './shared-pad.js';

interface Core {
  FS: TailFs & {
    mkdir(path: string): void;
    mount(type: unknown, options: { files: File[] }, path: string): void;
    filesystems: Record<string, unknown>;
  };
  callMain(args: string[]): number;
  _gx_webgpu_selftest?(argb: number, copies: number, geometry: number): number;
  _gx_webgpu_attach?(): number;
  _melee_live_input_version?(): number;
  _melee_decoder_cost?(mode: number): number;
}
/**
 * The page's request: a disc, the input mailbox, the flight recorder, and whether to split the core.
 * `discIdentity` names the OPFS cache the disc came from; a picked disc has none.
 */
interface PlayRequest {
  iso: File; discIdentity?: string | null; pad: SharedArrayBuffer; flight: SharedArrayBuffer; split?: boolean;
  selftest?: boolean;
}
/** How often the frame records are posted to the page; a slow frame is posted at once. */
const FLUSH_MS = 250;
const SIM_TIMES = '/work/sim_times.csv';
const DECODER_COST = '/work/decoder_cost.csv';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let running = false;
scope.onmessage = async (event: MessageEvent<PlayRequest>) => {
  if (running) return;
  running = true;
  try {
    const shared = new Int32Array(event.data.pad);
    const canvas = new OffscreenCanvas(640, 480);
    const opening = await openGpu(canvas);
    const gpu = opening.gpu;
    if (!gpu || gpu.failure) throw new Error(gpu?.failure ?? opening.reason);
    // Every WebGPU call the backend makes is timed from here on (frame-meter.ts says what that
    // can and cannot see). The calls themselves are forwarded unchanged.
    const meter = new FrameMeter(new Int32Array(event.data.flight), () => performance.now());
    instrumentGpu(gpu, meter);
    const queueProbe = await verifyQueueHooks(gpu.device, meter);
    const url = '/spike-core/melee_core_web.js';
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok || !head.headers.get('content-type')?.includes('javascript')) {
      throw new Error('Playable core unavailable: deploy the CI core built with live input support.');
    }
    // Which core this is, for the report. Not needed to play, so a missing file is a note, not a stop.
    const notes: string[] = [];
    let commit: string | null = null, opt: string | null = null;
    try {
      const response = await fetch('/spike-core/core.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const meta = (await response.json()) as { commit?: string; opt?: string };
      commit = meta.commit ?? null;
      opt = meta.opt ?? null;
    } catch (error) {
      notes.push(`core.json unreadable (${error}): the report names no core commit`);
    }
    const factory = (await import(/* @vite-ignore */ url)).default as (options: unknown) => Promise<Core>;
    let deadline = performance.now();
    let serial = 0;
    let pending: FrameRecord[] = [];
    let sim: string[] = [];
    let decoder: string[] = [];
    let flushedAt = performance.now();
    let simTail: CsvTail | null = null;
    let decoderTail: CsvTail | null = null;
    const flush = (): void => {
      scope.postMessage({ type: 'perf', rows: pending, sim, decoder, totals: meter.totals(), notes: meter.notes });
      pending = [];
      sim = [];
      decoder = [];
      flushedAt = performance.now();
    };
    /** New rows of a core CSV; a tail that fails is dropped with a note, and the game goes on. */
    const tail = (reader: CsvTail | null, into: string[]): string[] => {
      if (!reader) return [];
      const lines = reader.lines();
      for (const line of lines) into.push(line);
      return lines;
    };
    const tailFailed = (reader: CsvTail, error: unknown): void => {
      const note = `${reader.path} unreadable (${error}): its columns stop here`;
      meter.notes.push(note);
      scope.postMessage({ type: 'log', line: note });
    };
    // The spike's heartbeat (heartbeat.ts): where the run is, every 500 ms at most.
    const beat = heartbeatSender((b) => scope.postMessage({ type: 'beat', beat: b }), () => performance.now(),
      () => renderProgress(gpu));
    const options = {
      print: (line: string) => scope.postMessage({ type: 'log', line }),
      printErr: (line: string) => scope.postMessage({ type: 'log', line }),
      gxWebgpu: gpu,
      livePad: () => readPad(shared),
      heartbeatReturned: (retraces: number) => meter.heartbeatReturned(retraces),
      heartbeat: (retraces: number, timingRetrace?: number, simMs?: number, csvMs?: number) => {
        const entered = retraces >= 0 ? performance.now() : 0;
        if (gpu.failure) throw new Error(gpu.failure);
        beat(retraces);
        // The renderer also beats, with -1, before every draw (gx_webgpu.cpp: the spike's stall
        // report). Only a completed retrace presents: presenting on a draw beat would transfer the
        // canvas between two XFB copies and wait out a 60 Hz period, ~900 times per match frame.
        if (retraces < 0) { meter.draw(); return; }
        let simLines: string[] = [], decoderLines: string[] = [];
        try { simLines = tail(simTail, sim); } catch (error) { tailFailed(simTail!, error); simTail = null; }
        try { decoderLines = tail(decoderTail, decoder); } catch (error) { tailFailed(decoderTail!, error); decoderTail = null; }
        const readDone = performance.now();
        const coreTiming = timingRetrace === retraces && Number.isFinite(simMs) && Number.isFinite(csvMs)
          ? { retrace: timingRetrace, simMs: simMs!, csvMs: csvMs! } : null;
        meter.coreEnd(retraces, matchFrameOf(simLines, retraces), coreSplitOf(decoderLines, retraces),
          { entered, readDone, core: coreTiming });
        // callMain never yields. Explicit bitmap presentation releases the WebGPU canvas
        // image every retrace, instead of waiting for the worker's task to return.
        const bitmap = canvas.transferToImageBitmap();
        meter.bitmapDone();
        scope.postMessage({ type: 'frame', bitmap, serial: ++serial, retraces }, [bitmap]);
        // Backpressure also stops background tabs from accumulating images or running ahead.
        while (Atomics.load(shared, PRESENTED) !== serial) {
          Atomics.wait(shared, PRESENTED, Atomics.load(shared, PRESENTED), 100);
        }
        meter.ackDone();
        deadline = Math.max(deadline + 1000 / 60, performance.now());
        const delay = deadline - performance.now();
        if (delay > 0) Atomics.wait(shared, PRESENTED, serial, delay);
        const record = meter.cycleEnd();
        pending.push(record);
        if (record.top || performance.now() - flushedAt >= FLUSH_MS) flush();
      },
    };
    const core = await factory(options);
    if (core._melee_live_input_version?.() !== 1) throw new Error('This deployed core predates live input; rebuild it in CI.');
    if (core._gx_webgpu_attach?.() !== 1) throw new Error(`Renderer attach failed: ${gpu.failure ?? opening.reason}`);
    // The disc's reads go through an OPFS sync access handle when there is one (disc-reader.ts says
    // why), installed before the meter so the meter wraps the read the core really uses.
    const disc = event.data.selftest ? null : await routeDiscReads(core.FS.filesystems, event.data, notes);
    const discNote = meterDiscReads(core.FS.filesystems, meter);
    if (discNote) notes.push(discNote);
    // The clock, measured: every number in the report is quantised to the first, and the meter
    // itself costs about two of the second per WebGPU call.
    const resolution = timerResolutionMs();
    const clockNs = clockCostNs();
    let split = false;
    if (event.data.selftest) {
      if (event.data.split) notes.push('core split not available in the selftest: it runs no simulation');
    } else {
      core.FS.mkdir('/work');
      if (event.data.split) {
        // The core's own profiler (patch 0008): decode against non-decode for every retrace. It must
        // be switched on before callMain, and its clock reads cost time, so it is opt-in.
        if (!core._melee_decoder_cost) notes.push('core split unavailable: this core has no decoder-cost instrumentation');
        else if (core._melee_decoder_cost(1) !== 1) notes.push('core split unavailable: the core refused decoder-cost setup');
        else split = true;
      }
    }
    scope.postMessage({ type: 'perf-meta', commit, opt, queueProbe, timerResolutionMs: resolution, clockCostNs: clockNs, split, notes,
      crossOriginIsolated: scope.crossOriginIsolated });
    if (event.data.selftest) {
      if (!core._gx_webgpu_selftest) throw new Error('Core has no renderer selftest');
      meter.start();
      for (let frame = 1; frame <= 3; frame++) {
        // Geometry 1 draws three triangles, so the renderer's per-draw beats run here too.
        core._gx_webgpu_selftest(0xff2080c0, 2, 1);
        options.heartbeat(frame);
        options.heartbeatReturned(frame);
      }
      flush();
      scope.postMessage({ type: 'ended', exitCode: 0 });
      return;
    }
    core.FS.mkdir('/disc');
    core.FS.mount(core.FS.filesystems['WORKERFS'], { files: [event.data.iso] }, '/disc');
    core.FS.mkdir('/card');
    scope.postMessage({ type: 'ready' });
    // Live play starts at the game's menus. No script and no trace hashing. --sim-times appends one
    // short row per retrace (retrace, sim_ms, match_frame): it is how the report tells the match
    // from the menus, the way the spike does. It reads the scene, it writes no guest state.
    simTail = new CsvTail(core.FS, SIM_TIMES);
    if (split) decoderTail = new CsvTail(core.FS, DECODER_COST);
    meter.start();
    const exitCode = core.callMain(['--iso', `/disc/${event.data.iso.name}`, '--headless', '--fast',
      '--frames', '4294967295', '--time-base', '1', '--volume', '0', '--card-dir', '/card',
      '--sim-times', SIM_TIMES]);
    disc?.close();
    flush();
    scope.postMessage({ type: 'ended', exitCode });
  } catch (error) {
    scope.postMessage({ type: 'error', message: String(error) });
  }
};

const FALLBACK_NOTE = 'disc read with FileReaderSync';
const STALL_RISK = 'on Safari, a read after more than a second without one can block the game for a second';

/** Open the cached disc for sync reads and route WORKERFS to it; null, with a note, when it cannot. */
async function routeDiscReads(filesystems: Record<string, unknown>, request: PlayRequest,
  notes: string[]): Promise<SyncReadHandle | null> {
  if (!request.discIdentity) {
    notes.push(`${FALLBACK_NOTE}: a picked disc has no OPFS handle; ${STALL_RISK}`);
    return null;
  }
  let handle: SyncReadHandle;
  try {
    handle = await openCachedDisc(() => navigator.storage.getDirectory() as unknown as Promise<OpfsDirectory>,
      request.discIdentity);
  } catch (error) {
    notes.push(`${FALLBACK_NOTE}: the cached disc could not be opened for sync reads (${error}); ${STALL_RISK}`);
    return null;
  }
  try {
    readDiscThrough(filesystems, request.iso, handle);
  } catch (error) {
    handle.close();
    notes.push(`${FALLBACK_NOTE}: ${error}; ${STALL_RISK}`);
    return null;
  }
  notes.push('disc read through an OPFS sync access handle');
  return handle;
}
